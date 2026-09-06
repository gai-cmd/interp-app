/**
 * Composition adapted from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart/Stop.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: existing capture, router, recovery, caption store and PCM player;
 * serial physical closure, generation guards, no IPC, extra voice or raw errors.
 */
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';
import { createListenMetrics } from './listen-metrics.js';
import { LIVE_MODELS, DEFAULT_LIVE_MODEL, sanitizeLiveModel, liveRoute, detectReply,
  normalizeLanguagePair } from '../providers/gemini/live-config.js';
import { liveSetupFor, mergeLiveModels, newestLiveModel } from '../providers/gemini/model-discovery.js';
import { createSessionManager } from './session-manager.js';
import { createLiveRecovery } from './live-recovery.js';
import { createListenState } from './listen-state.js';
import { createCaptionStore } from './caption-store.js';
import { createStreamCapture } from '../audio/stream-capture.js';
import { createUplinkQueue } from '../audio/uplink-queue.js';
import { createStreamPlayer } from '../audio/stream-player.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const attempt = fn => { try { return fn(); } catch { /* Observer-owned failure. */ } };
const captureCodes = new Set(['MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE', 'TIMEOUT']);
// P3-02e: a session is replaced automatically (live-recovery: at most three
// reopenings, 1/2/4 s) only for transport failures. Every 429 family code and
// every key/permission rejection ends the operation at once with its own code:
// an automatic reopen would only spend the remaining quota faster.
export const NO_REPLACEMENT_CODES = Object.freeze(['RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429',
  'INVALID_KEY', 'PERMISSION_DENIED', 'IP_DENIED', 'CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'CREDENTIAL_FORBIDDEN',
  'SAFETY_BLOCKED']);
const noReplacement = new Set(NO_REPLACEMENT_CODES);
const MAX_SKIPPED = 100;
// 24 kHz PCM16 mono: 48 bytes per millisecond.
const audioMs = audio => Math.round((audio?.byteLength ?? 0) / 48);

/** start(request, {sessionId, turnId?, providerId, keySource, signal?}) must be
 * called from a gesture, after the app has stopped its previous activity.
 * Returns {ready, done}; both resolve with machine data, never raw exceptions.
 * ready reports the first setup or terminal failure; done waits for cleanup.
 * getAudioContext is caller-owned. resolveFallback is the registered LIVE
 * resolver (config.resolveFallback(providerId, 'live')), not the REST resolver.
 * Capture has no ready event: its first complete frame proves preparation and
 * is discarded. The adapter already assembles subtitles; do not assemble twice.
 * snapshot/subscribe expose memory-only captions and separate output state.
 * The translation-only model is always first; a flash model is used only by
 * explicit selection or by the registered fallback after the translation model
 * failed (snapshot.fallback). On the flash route, a translation segment that
 * looks like a reply discards the rest of that turn's audio and captions
 * (snapshot.skippedSegments, metrics.repliesSkipped).
 */
export function createSimEngine({ router, sessionManager = createSessionManager(),
  getAudioContext, platform, resolveFallback, onLevel,
  now = () => performance.now(), setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout, random = Math.random } = {}) {
  if (typeof router?.call !== 'function' || typeof getAudioContext !== 'function') {
    throw new ProviderError('INVALID_REQUEST');
  }
  const state = createListenState(), listeners = new Set();
  const timing = { now, setTimeout, clearTimeout, random };
  const clock = { now, setTimeout, clearTimeout };
  let selectedModel = DEFAULT_LIVE_MODEL, metrics;
  // Models the provider reported for this account beyond the repository list
  // (owner, 2026-09-06). They widen what setModel accepts and what the picker
  // offers; the reviewed default keeps its place at the head of the list.
  let discovered = Object.freeze([]);
  const models = () => mergeLiveModels(LIVE_MODELS, discovered);
  const knownModel = (model) => models().includes(model);
  const routeOf = (model) => (LIVE_MODELS.includes(model) ? liveRoute(model) : liveSetupFor(model));
  let active, store, errorCode = null, disposed = false, lastResult, skipped = [];
  const snapshot = () => {
    const model = active?.model ?? lastResult?.model ?? selectedModel;
    return Object.freeze({ ...state.snapshot(), errorCode,
      messageKey: errorCode ? `error.${errorCode}` : null,
      metrics: metrics?.snapshot() ?? null, model, route: liveRoute(model),
      fallback: active?.fallback ?? lastResult?.fallback ?? false, defaultModel: DEFAULT_LIVE_MODEL,
      skippedSegments: Object.freeze([...skipped]),
      captions: store?.snapshot() ?? null, busy: Boolean(active),
      retries: active?.recovery.retries ?? lastResult?.retries ?? 0 });
  };
  const notify = () => { const value = snapshot(); for (const fn of [...listeners]) attempt(() => fn(value)); };
  state.subscribe(notify);
  const alive = op => active === op && !op.controller.signal.aborted;
  function silence(op) {
    if (op.connection) op.connection.enabled = false;
    op.uplink?.cancel(); op.player?.cancel();
    store?.interrupt();
  }
  function cancel(op, code = null) {
    if (!alive(op)) return;
    op.failure = code;
    state.transition('stopping');
    silence(op);
    op.controller.abort();
    op.capture?.cancel();
    op.prepared.resolve(); op.connection?.fault.resolve({ error: new ProviderError('ABORTED') });
  }
  function makePlayer(op) {
    if (!op.audioContext) {
      state.setOutput(op.muted ? 'muted' : 'unavailable'); return;
    }
    const player = createStreamPlayer({ ...timing, context: op.audioContext, muted: op.muted,
      onState(value) { if (alive(op)) state.setOutput(value.state, op.generation); },
      // Audio discarded for a detected reply is not a playback gap.
      onDrop(value) { if (alive(op) && value.durationMs > 0 && !op.connection?.skipping) store.markGap('audio'); } });
    op.player = player;
  }
  function fault(op, c, error, goAway = false) {
    if (!alive(op) || op.connection !== c || !c.enabled) return;
    c.enabled = false;
    metrics.resetInput(); metrics.observe('reconnects');
    op.uplink?.cancel(); op.player?.cancel(); store.interrupt(); store.markGap('reception');
    state.transition('reconnecting', op.generation);
    c.fault.resolve({ error: normalizeError(error), goAway });
  }
  function event(op, c, ev) {
    if (!alive(op) || op.connection !== c || !c.enabled || ev.generation !== c.generation) return;
    try {
      if (ev.type === 'error' || ev.type === 'closed' || ev.type === 'goAway') {
        fault(op, c, ev.error ?? new ProviderError('SESSION_CLOSED'), ev.type === 'goAway'); return;
      }
      if (ev.type === 'audio') {
        op.recovery.activity(); metrics.mark('firstAudioReceivedMs'); metrics.audioReceived();
        if (c.skipping) { metrics.observe('droppedAudioMs', audioMs(ev.audio)); return; }
        if (op.player?.enqueue(ev.audio)) metrics.mark('firstAudioScheduledMs');
        if (op.player) metrics.queue(op.player.snapshot().queuedSeconds * 1000);
        notify();
      } else if (ev.type === 'subtitle') {
        op.recovery.activity();
        const at = now();
        const translation = ev.role === 'translation';
        // The rest of a rejected turn never reaches captions or the player.
        if (translation && c.skipping) return;
        // Two-way output may legitimately be in either language, so the
        // foreign-script half of the heuristic cannot apply; only the explicit
        // reply phrases still mark the model answering instead of interpreting.
        const reply = translation && c.flash
          ? (op.languages === null
            ? detectReply(ev.translatedText, op.targetLanguage, { final: ev.final })
            : op.languages.map((lang) => detectReply(ev.translatedText, lang, { final: false })).find(Boolean) ?? null)
          : null;
        if (reply) {
          c.skipping = true;
          op.player?.interrupt();
          metrics.observe('repliesSkipped');
          if (skipped.length >= MAX_SKIPPED) skipped.shift();
          skipped.push(ev.segmentId);
        }
        metrics.mark(ev.final ? 'firstFinalMs' : 'firstPartialMs');
        store.upsertDirect({ id: ev.segmentId, sessionId: op.sessionId, generation: c.generation,
          role: ev.role, sequence: ev.seq, revision: ev.revision,
          sourceText: ev.sourceText, translatedText: ev.translatedText,
          status: reply ? 'interrupted' : ev.final ? 'final' : 'partial', receivedAt: at,
          finalizedAt: reply || ev.final ? at : null,
          gapBefore: c.gapRoles.has(ev.role) });
        c.gapRoles.delete(ev.role);
        if (reply) notify();
      } else if (ev.type === 'complete') { c.skipping = false; op.player?.turnComplete(); }
      else if (ev.type === 'interrupted') { c.skipping = false; store.interrupt(); op.player?.interrupt(); }
    } catch { fault(op, c, new ProviderError('INVALID_RESULT')); }
  }
  async function run(op, request, route) {
    let failure;
    try {
      await op.prepared.promise;
      assertActive(op.controller.signal);
      state.transition('connecting', op.generation);
      for (;;) {
        const c = { enabled: true, fault: deferred(), skipping: false,
          flash: liveRoute(request.model) === 'flash',
          gapRoles: new Set(op.recovery.budget.used ? ['source', 'translation'] : []) };
        op.connection = c;
        if (!op.player) makePlayer(op);
        let outcome;
        try {
          op.lease = await sessionManager.replace(ctx => {
            op.ownsSession = true;
            c.generation = ctx.generation;
            store.setGeneration(ctx.generation);
            return router.call('live', request, { ...ctx, ...route, transport: 'direct', budget: op.recovery.budget });
          }, { signal: op.controller.signal, sessionId: op.sessionId, turnId: op.turnId,
            onEvent: ev => event(op, c, ev) });
          assertActive(op.controller.signal);
          if (c.enabled) {
            op.recovery.opened(); op.model = sanitizeLiveModel(request.model); metrics.mark('setupMs');
            op.uplink = createUplinkQueue({ clock, sendAudio: async pcm => { await op.lease.sendAudio(pcm); metrics.observe('sentFrames'); },
              onDrop: () => { if (alive(op)) store.markGap('input'); },
              onError: err => fault(op, c, err) });
            op.uplink.setReady(true);
            state.transition('running', op.generation);
            op.ready.resolve(Object.freeze({ status: 'running', sessionId: op.sessionId }));
          }
          outcome = await c.fault.promise;
        } catch (raw) {
          outcome = { error: normalizeError(raw) };
          // An event carries the original remote error, before cleanup aborts.
          if (!c.enabled) outcome = await c.fault.promise;
          else fault(op, c, outcome.error);
        }
        silence(op); op.player = null;
        // finishInput only ends input. Only close certifies lease shutdown.
        if (op.ownsSession) { await (op.lease ? op.lease.close() : sessionManager.close()); op.ownsSession = false; }
        op.lease = null;
        assertActive(op.controller.signal);
        // Credential/routing rejection can precede the router's first charge.
        if (!op.recovery.budget.used) throw outcome.error;
        // Quota and key rejections are final for this operation; only the
        // user's explicit reopen starts a new session with a fresh budget.
        if (!outcome.goAway && noReplacement.has(outcome.error.code)) throw outcome.error;
        request = await op.recovery.wait(outcome.error, { signal: op.controller.signal,
          closed: true, goAway: outcome.goAway, request, resolveFallback });
        // Registered fallback only: the translation-only model stays first and a
        // flash model replaces it solely after it failed. Surface the switch.
        op.model = sanitizeLiveModel(request.model);
        if (op.model !== op.requestedModel) op.fallback = true;
        notify();
      }
    } catch (raw) {
      failure = op.failure ?? (op.controller.signal.aborted ? null : normalizeError(raw).code);
    } finally {
      silence(op); op.controller.abort(); op.capture?.cancel();
      try {
        if (op.ownsSession) await (op.lease ? op.lease.close() : sessionManager.close());
      } catch (raw) { failure = normalizeError(raw).code; }
      await op.capture?.done;
      op.detach();
      errorCode = failure;
      if (failure) state.transition('failed');
      else {
        if (state.snapshot().status !== 'stopping') state.transition('stopping');
        state.transition('stopped');
      }
      lastResult = Object.freeze({ status: failure ? 'failed' : 'stopped', errorCode: failure,
        messageKey: failure ? `error.${failure}` : null, retries: op.recovery.retries,
        model: op.model, fallback: op.fallback });
      metrics.stop(); active = null; notify(); op.ready.resolve(lastResult); op.done.resolve(lastResult);
    }
  }
  function start(request = {}, context = {}) {
    if (disposed || active || sessionManager.occupied) throw new ProviderError('SESSION_LIMIT');
    // Two-way: one microphone serves both sides, and the direction is decided
    // per utterance by the language heard. `languages` replaces the single
    // target; the pair is validated by the provider config.
    const pair = request.languages === undefined || request.languages === null
      ? null : normalizeLanguagePair(request.languages);
    if ((pair === null && !['ko', 'en', 'ja'].includes(request.targetLanguage))
      || typeof context.sessionId !== 'string' || !context.sessionId || context.sessionId.length > 256
      || (context.transport !== undefined && context.transport !== 'direct')) throw new ProviderError('INVALID_REQUEST');
    assertActive(context.signal);
    const op = { controller: new AbortController(), prepared: deferred(), ready: deferred(), done: deferred(),
      sessionId: context.sessionId, turnId: context.turnId ?? context.sessionId,
      muted: request.muted === true, recovery: createLiveRecovery(timing), detach: () => {},
      targetLanguage: request.targetLanguage, languages: pair, fallback: false };
    metrics = createListenMetrics({ now });
    // A corrupted stored selection never reaches the router: fall back to the
    // translation-only default rather than failing or steering to flash.
    op.model = request.model === undefined ? selectedModel
      : knownModel(request.model) ? request.model : sanitizeLiveModel(request.model);
    // The translation setup carries one target language and cannot change
    // direction, so a two-way session uses the instruction-driven model.
    if (pair !== null && routeOf(op.model) === 'translation') {
      op.model = models().find((model) => routeOf(model) !== 'translation') ?? op.model;
    }
    op.requestedModel = op.model; skipped = [];
    store?.close(); store = createCaptionStore({ sessionId: op.sessionId, now }); store.subscribe(notify);
    errorCode = null; active = op;
    state.transition('preparing'); op.generation = state.snapshot().generation;
    const abort = () => cancel(op);
    context.signal?.addEventListener('abort', abort, { once: true });
    op.detach = () => context.signal?.removeEventListener('abort', abort);
    try {
      // Both browser gesture-sensitive calls occur before any await.
      op.audioContext = attempt(() => getAudioContext()) ?? null;
      makePlayer(op); void op.player?.resume();
      op.capture = createStreamCapture({ platform, onLevel: value => {
        if (alive(op)) {
          if (op.uplink && op.connection?.enabled) metrics.inputLevel(value.rms);
          attempt(() => onLevel?.(value));
        }
      }, onFrame: pcm => {
        if (!alive(op)) return;
        op.prepared.resolve();
        if (op.connection?.enabled && op.uplink) op.uplink.enqueue(pcm);
        else store.markGap('input');
      } }).start({ signal: op.controller.signal, sessionId: op.sessionId,
        turnId: op.turnId, generation: op.generation });
      op.capture.done.then(result => {
        if (alive(op)) cancel(op, captureCodes.has(result.code) ? result.code
          : result.status === 'error' ? 'MICROPHONE_UNAVAILABLE' : null);
      });
    } catch { cancel(op, 'MICROPHONE_UNAVAILABLE'); }
    const input = { input: { format: 'pcm16' }, targetLanguage: request.targetLanguage,
      ...(pair === null ? {} : { languages: pair }), model: op.model };
    void run(op, input, { providerId: context.providerId, keySource: context.keySource });
    return Object.freeze({ ready: op.ready.promise, done: op.done.promise });
  }
  function stop() { if (active) { const op = active; cancel(op); return op.done.promise; } return Promise.resolve(lastResult); }
  return Object.freeze({ start, stop, cancel: stop, snapshot,
    get model() { return selectedModel; },
    get defaultModel() { return DEFAULT_LIVE_MODEL; },
    /** The repository list plus whatever discovery added, in that order. */
    get models() { return models(); },
    get discoveredModels() { return discovered; },
    async setModel(model) {
      if (!knownModel(model)) throw new ProviderError('MODEL_UNSUPPORTED');
      if (model === selectedModel) return;
      await stop(); selectedModel = model; notify();
    },
    /**
     * Report what the provider says this account can reach (owner, 2026-09-06).
     * `adopt` switches to the newest model that was not in the repository list;
     * a session in progress is never interrupted for it — the caller decides
     * when to offer this, and a refused or empty discovery changes nothing.
     * Returns the adopted model id, or null.
     */
    async setDiscoveredModels(list, { adopt = false } = {}) {
      const merged = mergeLiveModels(LIVE_MODELS, list);
      const added = merged.filter((model) => !LIVE_MODELS.includes(model));
      const changed = added.length !== discovered.length || added.some((model, index) => model !== discovered[index]);
      discovered = Object.freeze(added);
      const newest = adopt ? newestLiveModel(LIVE_MODELS, added) : null;
      if (newest !== null && newest !== selectedModel && !active && !sessionManager.occupied) {
        selectedModel = newest;
        notify();
        return newest;
      }
      if (changed) notify();
      return null;
    },
    // Restores a persisted selection; anything unrecognised becomes the default.
    async restoreModel(model) {
      const next = knownModel(model) ? model : sanitizeLiveModel(model);
      if (next !== selectedModel) { await stop(); selectedModel = next; notify(); }
      return next;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
    setMuted(value) {
      if (!active || !alive(active)) return;
      active.muted = Boolean(value); active.player?.setMuted(active.muted);
      // Hard mute (owner report: "소리 끄기" left a faint sound): besides dropping every
      // queued source, suspend the playback context so nothing can reach the speaker;
      // resume on unmute. The capture context is separate, so listening continues.
      const ctx = active.audioContext;
      if (ctx && typeof ctx.suspend === 'function') {
        if (active.muted) attempt(() => ctx.suspend());
        else attempt(() => ctx.resume());
      }
      if (!active.player) state.setOutput(active.muted ? 'muted' : 'unavailable', active.generation);
    },
    resumeAudio() { return active && alive(active) ? active.player?.resume() ?? Promise.resolve(false) : Promise.resolve(false); },
    async close() { disposed = true; await stop(); store?.close(); state.close(); listeners.clear(); },
  });
}
