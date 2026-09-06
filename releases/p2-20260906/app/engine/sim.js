/**
 * Composition adapted from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart/Stop.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: existing capture, router, recovery, caption store and PCM player;
 * serial physical closure, generation guards, no IPC, extra voice or raw errors.
 */
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';
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

/** start(request, {sessionId, turnId?, providerId, keySource, signal?}) must be
 * called from a gesture, after the app has stopped its previous activity.
 * Returns {ready, done}; both resolve with machine data, never raw exceptions.
 * ready reports the first setup or terminal failure; done waits for cleanup.
 * getAudioContext is caller-owned. resolveFallback is the registered LIVE
 * resolver (config.resolveFallback(providerId, 'live')), not the REST resolver.
 * Capture has no ready event: its first complete frame proves preparation and
 * is discarded. The adapter already assembles subtitles; do not assemble twice.
 * snapshot/subscribe expose memory-only captions and separate output state.
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
  let active, store, errorCode = null, disposed = false, lastResult;
  const snapshot = () => Object.freeze({ ...state.snapshot(), errorCode,
    messageKey: errorCode ? `error.${errorCode}` : null,
    captions: store?.snapshot() ?? null, busy: Boolean(active),
    retries: active?.recovery.retries ?? lastResult?.retries ?? 0 });
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
      onDrop(value) { if (alive(op) && value.durationMs > 0) store.markGap('audio'); } });
    op.player = player;
  }
  function fault(op, c, error, goAway = false) {
    if (!alive(op) || op.connection !== c || !c.enabled) return;
    c.enabled = false;
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
        op.recovery.activity(); op.player?.enqueue(ev.audio);
      } else if (ev.type === 'subtitle') {
        op.recovery.activity();
        const at = now();
        store.upsertDirect({ id: ev.segmentId, sessionId: op.sessionId, generation: c.generation,
          role: ev.role, sequence: ev.seq, revision: ev.revision,
          sourceText: ev.sourceText, translatedText: ev.translatedText,
          status: ev.final ? 'final' : 'partial', receivedAt: at, finalizedAt: ev.final ? at : null,
          gapBefore: c.gapRoles.has(ev.role) });
        c.gapRoles.delete(ev.role);
      } else if (ev.type === 'complete') op.player?.turnComplete();
      else if (ev.type === 'interrupted') { store.interrupt(); op.player?.interrupt(); }
    } catch { fault(op, c, new ProviderError('INVALID_RESULT')); }
  }
  async function run(op, request, route) {
    let failure;
    try {
      await op.prepared.promise;
      assertActive(op.controller.signal);
      state.transition('connecting', op.generation);
      for (;;) {
        const c = { enabled: true, fault: deferred(),
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
            op.recovery.opened();
            op.uplink = createUplinkQueue({ clock, sendAudio: pcm => op.lease.sendAudio(pcm),
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
        request = await op.recovery.wait(outcome.error, { signal: op.controller.signal,
          closed: true, goAway: outcome.goAway, request, resolveFallback });
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
        messageKey: failure ? `error.${failure}` : null, retries: op.recovery.retries });
      active = null; notify(); op.ready.resolve(lastResult); op.done.resolve(lastResult);
    }
  }
  function start(request = {}, context = {}) {
    if (disposed || active || sessionManager.occupied) throw new ProviderError('SESSION_LIMIT');
    if (!['ko', 'en', 'ja'].includes(request.targetLanguage)
      || typeof context.sessionId !== 'string' || !context.sessionId || context.sessionId.length > 256
      || (context.transport !== undefined && context.transport !== 'direct')) throw new ProviderError('INVALID_REQUEST');
    assertActive(context.signal);
    const op = { controller: new AbortController(), prepared: deferred(), ready: deferred(), done: deferred(),
      sessionId: context.sessionId, turnId: context.turnId ?? context.sessionId,
      muted: request.muted === true, recovery: createLiveRecovery(timing), detach: () => {} };
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
        if (alive(op)) attempt(() => onLevel?.(value));
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
      ...(request.model !== undefined ? { model: request.model } : {}) };
    void run(op, input, { providerId: context.providerId, keySource: context.keySource });
    return Object.freeze({ ready: op.ready.promise, done: op.done.promise });
  }
  function stop() { if (active) { const op = active; cancel(op); return op.done.promise; } return Promise.resolve(lastResult); }
  return Object.freeze({ start, stop, cancel: stop, snapshot,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
    setMuted(value) {
      if (!active || !alive(active)) return;
      active.muted = Boolean(value); active.player?.setMuted(active.muted);
      if (!active.player) state.setOutput(active.muted ? 'muted' : 'unavailable', active.generation);
    },
    resumeAudio() { return active && alive(active) ? active.player?.resume() ?? Promise.resolve(false) : Promise.resolve(false); },
    async close() { disposed = true; await stop(); store?.close(); state.close(); listeners.clear(); },
  });
}
