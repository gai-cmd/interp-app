// New composition of design-p2 §§7–10 and 17; no legacy code is ported.
// Legacy reference: ~/jarvis2/interp-web/lib/live.js discards model audio.
// Audience protocol and device speech are reused through P2-11 and P2-12.
import { createListenState } from './listen-state.js';
import { createCaptionStore } from './caption-store.js';
import { createCaptionSpeaker } from '../audio/caption-speaker.js';
import { ProviderError, normalizeError } from '../providers/contract.js';

/** Inject the app-owned client and device TTS after acquiring activity ownership.
 * join returns {ready, done, closed}; leave waits for physical closure.
 * No replay boundary is inferred. Every join/reconnect starts muted.
 */
export function createHubListenEngine({ client, deviceTTS, now = () => performance.now(),
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  if (typeof client?.join !== 'function' || typeof deviceTTS?.speak !== 'function'
    || typeof deviceTTS?.cancel !== 'function') throw new ProviderError('INVALID_REQUEST');
  const state = createListenState({ mode: 'hub' }), listeners = new Set();
  let active, store, epoch = 0, language = 'ja', allowedLangs = Object.freeze([]);
  let errorCode = null, reason = null, disposed = false, lastSeq = null;
  const snapshot = () => {
    const captions = store?.snapshot() ?? null;
    return Object.freeze({ ...state.snapshot(), busy: Boolean(active), language, allowedLangs,
      errorCode, reason, recentPossible: true, lastSeq, captions,
      translations: Object.freeze(captions?.captions.filter(c => c.lang === language) ?? []),
      sources: Object.freeze(captions?.captions.filter(c => c.role === 'source') ?? []),
      audio: active?.speaker.snapshot() ?? null });
  };
  function notify() {
    const value = snapshot();
    for (const fn of [...listeners]) { try { fn(value); } catch { /* Observer-owned failure. */ } }
  }
  state.subscribe(notify);
  const alive = op => active === op && !op.stopping;
  function silence(op) { op.speaker.setMuted(true); state.setOutput('muted'); }
  function finish(op, failure) {
    if (active !== op) return;
    op.stopping = true;
    op.speaker.cancel(); store.interrupt();
    if (!['stopping', 'failed', 'stopped'].includes(state.snapshot().status)) state.transition('stopping');
    if (failure) errorCode = failure;
    if (state.snapshot().status === 'stopping') state.transition(errorCode ? 'failed' : 'stopped');
    notify();
  }
  function stop(op, why = null, failure = null) {
    if (op.stopPromise) return op.stopPromise;
    op.stopping = true; reason = why; errorCode = failure;
    state.transition('stopping'); silence(op); op.speaker.cancel(); store.interrupt();
    op.stopPromise = Promise.resolve().then(() => op.handle.close()).then(
      () => { finish(op); },
      () => { finish(op, 'TIMEOUT'); });
    return op.stopPromise;
  }
  function event(op, ev) {
    if (!alive(op) || ev.generation < op.connection) return;
    op.connection = ev.generation;
    if (ev.type === 'connection') {
      if (ev.state === 'reconnecting') {
        silence(op); store.interrupt(); store.markGap('reception');
        state.setBroadcast('unknown'); state.transition('reconnecting');
      }
      return;
    }
    if (ev.type === 'hello' || ev.type === 'settings') {
      allowedLangs = Object.freeze([...ev.settings.allowedLangs]);
      if (!allowedLangs.includes(language)) { void stop(op, 'language-removed'); return; }
      if (ev.type === 'hello') {
        silence(op); state.setBroadcast('unknown'); state.transition('running');
      }
      notify(); return;
    }
    if (ev.type === 'gap') { store.markGap('reception'); return; }
    if (ev.type === 'caption') {
      // Process every language in arrival order; seq is neither a gap count nor
      // a broadcast identity. Preserve epoch/deduplication across reconnects.
      lastSeq = ev.seq;
      const update = store.upsertHub({ ...ev, epoch });
      op.speaker.enqueue(update);
      if (ev.lang === language && update.applied) state.setBroadcast('receiving');
      notify(); return;
    }
    if (ev.type === 'status' && [language, '*'].includes(ev.lang)) {
      if (ev.state === 'fatal') { void stop(op, 'broadcast-error', 'UNAVAILABLE'); return; }
      if (ev.state !== 'connected' || state.snapshot().broadcast !== 'receiving') {
        state.setBroadcast(ev.state === 'connected' ? 'waiting' : 'unknown');
      }
    }
    if (['stopped', 'closed', 'denied'].includes(ev.type)) {
      state.setBroadcast('ended');
      void stop(op, ev.reason, ev.type === 'denied' ? 'PERMISSION_DENIED' : null);
    }
  }
  function join({ hubId, roomCode, language: target = language } = {}, { signal } = {}) {
    if (disposed) throw new ProviderError('SESSION_CLOSED');
    if (active) throw new ProviderError('SESSION_LIMIT');
    if (!['ko', 'en', 'ja'].includes(target)) throw new ProviderError('INVALID_REQUEST');
    if (signal?.aborted) throw new ProviderError('ABORTED');
    language = target; errorCode = reason = lastSeq = null; allowedLangs = Object.freeze([]);
    store?.close();
    store = createCaptionStore({ sessionId: `hub-${++epoch}`, epoch, now });
    store.subscribe(notify);
    state.transition('preparing');
    const op = { connection: 0, stopping: false };
    op.speaker = createCaptionSpeaker({ deviceTTS, epoch, language, now, setTimeout, clearTimeout,
      onState(value) { if (alive(op)) state.setOutput(value.state); },
      onDrop() { if (active === op) store.markGap('audio'); } });
    active = op;
    state.transition('connecting');
    try { op.handle = client.join({ hubId, roomCode }, { onEvent: ev => event(op, ev) }); }
    catch (raw) {
      finish(op, normalizeError(raw).code); active = null; notify();
      throw new ProviderError(errorCode);
    }
    const abort = () => { void stop(op); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const closed = op.handle.closed.then(() => {
      signal?.removeEventListener('abort', abort);
      if (active === op) { finish(op); active = null; notify(); }
    });
    const done = op.handle.done.then(async outcome => {
      if (op.stopPromise) await op.stopPromise;
      if (active === op && !op.stopping) finish(op,
        outcome.error && outcome.error.code !== 'ABORTED' ? normalizeError(outcome.error).code : null);
      return snapshot();
    });
    const ready = op.handle.ready.then(() => Object.freeze({ ready: alive(op), errorCode }),
      () => Object.freeze({ ready: false, errorCode: errorCode ?? 'SESSION_CLOSED' }));
    return Object.freeze({ ready, done, closed });
  }
  return Object.freeze({ snapshot, join,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
    setMuted(value) {
      if (!active || active.stopping || state.snapshot().status !== 'running') return false;
      active.speaker.setMuted(Boolean(value)); return true;
    },
    leave() { return active ? stop(active) : Promise.resolve(); },
    async setLanguage(value) {
      if (!['ko', 'en', 'ja'].includes(value)) throw new ProviderError('INVALID_REQUEST');
      if (value === language) return;
      if (active) await stop(active, 'language-changed');
      language = value; notify();
    },
    async close() {
      disposed = true;
      if (active) await stop(active);
      if (active) void active.handle.closed.then(() => store?.close());
      else store?.close();
      listeners.clear();
    },
  });
}
