// New implementation of design-p2 §§8.5, 8.6, 10 and 17; no legacy code ported.
// Reuses the injected app/audio/device-tts.js speak/cancel contract unchanged.
const attempt = fn => { try { return fn(); } catch { return undefined; } };
const languages = ['ko', 'en', 'ja'];

/** One instance per participant epoch, retained across reconnects. Feed ordered
 * createCaptionStore.upsertHub results, including muted/replayed finals. Never
 * feed snapshot rows as new arrivals. The caller owns the shared device TTS and
 * must prevent concurrent output owners. Language changes mute and clear output;
 * the hub engine must also stop its session. cancel/close are terminal.
 * Metrics contain no captions/IDs. Device TTS exposes no start event, so start
 * and acoustic timestamps remain null. No provider or hub transport is owned.
 */
export function createCaptionSpeaker({ deviceTTS, epoch = 0, language = 'ja',
  muted: initiallyMuted = true, signal, onState, onDrop,
  now = () => performance.now(), setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: clear = globalThis.clearTimeout } = {}) {
  if (!deviceTTS || typeof deviceTTS.speak !== 'function' || typeof deviceTTS.cancel !== 'function'
    || !Number.isSafeInteger(epoch) || epoch < 0 || !languages.includes(language)) {
    throw new Error('AUDIO_INVALID_OPTIONS');
  }
  const seen = new Set();
  let queue = [], active = null, timer, terminal = false, muted = Boolean(initiallyMuted);
  let unavailable = false, messageKey, highWater = -1, catchingUp = false;
  let firstRequestedAt = null, requested = 0, completed = 0, failures = 0;
  let skipped = 0, maxWaiting = 0, totalWaitMs = 0, maxWaitMs = 0;
  function snapshot() {
    const oldestWaitMs = queue.length ? Math.max(0, now() - queue[0].at) : 0;
    return Object.freeze({ state: terminal || unavailable ? 'unavailable' : muted ? 'muted'
      : catchingUp ? 'catching-up' : oldestWaitMs >= 3000 ? 'delayed' : 'ready',
    terminal, muted, waiting: queue.length, speaking: active !== null, oldestWaitMs,
    firstRequestedAt, firstStartAt: null, actualFirstSoundAt: null,
    requested, completed, failures, skipped, maxWaiting, totalWaitMs, maxWaitMs,
    messageKey, privacyMessageKey: 'voice.devicePrivacy', offlineGuaranteed: false });
  }
  function notify() { attempt(() => onState?.(snapshot())); }
  function drop(count, reason) {
    if (!count) return;
    skipped += count;
    attempt(() => onDrop?.(Object.freeze({ reason, sentences: count })));
  }
  function discard(reason) {
    clear(timer); timer = undefined;
    const count = queue.length + Number(active !== null);
    queue = [];
    const job = active; active = null;
    job?.controller.abort();
    if (job) attempt(() => deviceTTS.cancel());
    catchingUp = false;
    drop(count, reason);
  }
  function maintain() {
    clear(timer); timer = undefined;
    if (terminal) return;
    let expired = 0;
    while (queue.length && now() - queue[0].at > 8000) { queue.shift(); expired++; }
    if (expired) { catchingUp = true; drop(expired, 'expired'); }
    notify();
    if (queue.length) {
      const age = now() - queue[0].at;
      timer = schedule(maintain, Math.max(1, (age < 3000 ? 3000 : 8001) - age));
    }
    pump();
  }
  function finish(job, result) {
    if (active !== job || terminal) return;
    active = null;
    if (result?.status === 'completed') {
      completed++;
    } else {
      failures++;
      unavailable = true;
      messageKey = result?.status === 'unavailable' ? 'voice.deviceUnavailable'
        : result?.status === 'timeout' ? 'error.TIMEOUT' : 'error.VOICE_FAILED';
      attempt(() => deviceTTS.cancel());
      discard('failed');
    }
    maintain();
  }
  function pump() {
    if (active || terminal || muted || unavailable || !queue.length) return;
    const item = queue.shift();
    const job = { controller: new AbortController() }; active = job;
    const at = now(), wait = Math.max(0, at - item.at);
    firstRequestedAt ??= at; requested++; totalWaitMs += wait; maxWaitMs = Math.max(maxWaitMs, wait);
    catchingUp = false;
    try {
      Promise.resolve(deviceTTS.speak({ text: item.text, language }, { signal: job.controller.signal }))
        .then(result => finish(job, result), () => finish(job, { status: 'failed' }));
    } catch { finish(job, { status: 'failed' }); }
    clear(timer); timer = undefined;
    if (queue.length) timer = schedule(maintain, Math.max(1, 3000 - (now() - queue[0].at)));
    notify();
  }
  function cancel() {
    if (terminal) return;
    terminal = true; discard('cancelled'); seen.clear();
    signal?.removeEventListener('abort', cancel); notify();
  }
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return Object.freeze({
    snapshot,
    enqueue(update, { replay = false } = {}) {
      if (terminal || !update?.applied || !update.newFinal) return false;
      const c = update.caption;
      if (!c || c.epoch !== epoch || c.role !== 'translation' || c.status !== 'final'
        || c.lang !== language || typeof c.segmentId !== 'string' || c.segmentId.length > 256
        || !Number.isSafeInteger(c.order) || c.order <= highWater
        || typeof c.translatedText !== 'string' || c.translatedText.length > 16000) return false;
      // Store order is stable across revisions and monotonic for ordered arrivals.
      // Keep identity tombstones until close: evicted IDs can return with a new
      // seq/order on correction. No text or revision history is retained here.
      highWater = c.order;
      const identity = JSON.stringify([c.lang, c.segmentId]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      if (muted || unavailable || replay || !c.translatedText.trim()) return false;
      maintain();
      if (terminal || muted || unavailable || c.lang !== language) return false;
      queue.push({ text: c.translatedText, at: now() });
      if (queue.length > 20) { queue.shift(); catchingUp = true; drop(1, 'overflow'); }
      maxWaiting = Math.max(maxWaiting, queue.length);
      maintain(); return true;
    },
    setMuted(value) {
      if (terminal) return;
      muted = Boolean(value);
      if (muted) discard('muted');
      else { unavailable = false; messageKey = undefined; }
      notify();
    },
    setLanguage(value) {
      if (!languages.includes(value)) throw new Error('AUDIO_INVALID_OPTIONS');
      if (terminal || value === language) return;
      language = value; muted = true; unavailable = false; messageKey = undefined;
      discard('language-changed'); notify();
    },
    cancel, close: cancel,
  });
}
