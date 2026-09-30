/**
 * Ported from: ~/jarvis2/interp-web/lib/live.js (LiveLane._open/_dispatch)
 * SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Also: ~/jarvis2/jp-patch/inject/main-handlers.js (voiceOpen)
 * SHA-256: b00a8d33e6d2eea4c072c948b921b5b42f7ad0ad2a445e0f4b3eff074147e78b
 * Ported on: 2026-09-05
 * Changes: Browser events, ordered bounded decoding, abort/deadlines, confirmed
 * shutdown, safe errors; no ws/Buffer, logging, overlap, or hidden retries.
 */
import { ProviderError, assertActive, isResumeHandle, normalizeError } from '../contract.js';
import { normalizeGeminiError, normalizeGeminiLiveClose } from './errors.js';

// Local transport contract until P1-12/13 supply capability setup/registration.
export const LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const LIVE_LIMITS = Object.freeze({ setupTimeoutMs: 10000, closeTimeoutMs: 5000,
  decodeTimeoutMs: 10000, maxMessageBytes: 1048576, maxQueueBytes: 2097152,
  maxQueueMessages: 128, maxSendBytes: 1048576, maxAudioBufferedBytes: 12288 });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
// usageMetadata field -> event field. Per-report semantics (one turn or the
// running total) are not documented; the numbers are passed on as reported.
const USAGE_FIELDS = Object.freeze([['promptTokenCount', 'promptTokens'], ['responseTokenCount', 'responseTokens'],
  ['totalTokenCount', 'totalTokens'], ['cachedContentTokenCount', 'cachedTokens']]);

/**
 * open({setup}, context) -> {send(message), close(), closed}.
 * Trusted capability adapters own setup/models, text turns and PCM conversion.
 * send accepts one clientContent or realtimeInput envelope, only after setup.
 * Events: ready, content {content: serverContent}, goAway {timeLeftMs},
 * resumption {handle: string | null}, usage {promptTokens?, responseTokens?,
 * totalTokens?, cachedTokens?}, error {error: ProviderError}, closed.
 * Context IDs are attached to all events.
 * goAway (2026-09-30) is advisory: sends and output keep working until the
 * consumer closes, and only the advertised deadline (timeLeft) stops the
 * socket, with UNAVAILABLE. Malformed resumption/usage metadata is ignored.
 * No raw socket, authentication URL, close reason or provider error is exposed.
 * Route opens through createSessionManager; this is one transport attempt.
 * close() has a deadline; closed resolves ONLY on confirmed physical closure.
 * Failed open rejects ONLY after cleanup, as required by session-manager. If a
 * browser never confirms closure, the manager's deadline rejects the operation
 * while keeping its occupied slot. Never fake shutdown to release that slot.
 */
export function createGeminiLiveClient({ WebSocket: Socket = globalThis.WebSocket,
  Blob: BlobType = globalThis.Blob, resolveCredential,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  setupTimeoutMs = LIVE_LIMITS.setupTimeoutMs, closeTimeoutMs = LIVE_LIMITS.closeTimeoutMs,
  decodeTimeoutMs = LIVE_LIMITS.decodeTimeoutMs } = {}) {
  if (typeof Socket !== 'function' || typeof resolveCredential !== 'function'
    || typeof setTimeout !== 'function' || typeof clearTimeout !== 'function'
    || [setupTimeoutMs, closeTimeoutMs, decodeTimeoutMs].some((n) => !Number.isFinite(n) || n <= 0 || n > 60000)) {
    throw new ProviderError('INVALID_REQUEST');
  }
  let occupied = false;
  return Object.freeze({
    open(request, context = {}) {
      try {
        assertActive(context.signal);
        if (context.providerId !== 'gemini' || context.transport !== 'direct'
          || !['personal', 'shared'].includes(context.keySource)) throw new ProviderError('CREDENTIAL_MISMATCH');
        if (!context.signal || context.credentialRef == null) throw new ProviderError('CREDENTIAL_REQUIRED');
        if (occupied) throw new ProviderError('SESSION_LIMIT');
        if (!object(request?.setup) || !/^models\/[a-z0-9][a-z0-9.-]{0,127}$/.test(request.setup.model)) {
          throw new ProviderError('INVALID_REQUEST');
        }
        const setup = encode({ setup: request.setup });
        occupied = true;
        return connect(setup, context);
      } catch (error) { return Promise.reject(normalizeError(error)); }
    },
  });

  function encode(message) {
    try {
      const text = JSON.stringify(message);
      if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > LIVE_LIMITS.maxSendBytes) {
        throw new ProviderError('INVALID_REQUEST');
      }
      return text;
    } catch { throw new ProviderError('INVALID_REQUEST'); }
  }

  function connect(setup, context) {
    let ws, ready = false, stopped = false, physicallyClosed = false, retiring = false;
    let failure, closePromise, setupTimer, closeTimer, decodeTimer, goAwayTimer;
    // Eight 32ms PCM frames including base64/JSON overhead, rounded to 12KiB.
    // This is a transport policy, not a measured latency or provider limit.
    // P2-03 sends realtimeInput.audio; P1 voice sends clientContent. Latch the
    // audio policy so finishInput/control sends cannot bypass backpressure.
    let audioInput = false;
    let queue = [], queuedBytes = 0, processing = false;
    let resolveOpen, rejectOpen, resolveClosed;
    const opening = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const credentialController = new AbortController();
    const ids = { turnId: context.turnId, sessionId: context.sessionId, generation: context.generation };
    const emit = (event) => {
      try { context.onEvent?.({ ...event, ...ids }); } catch { /* Consumer-owned failure. */ }
    };
    const active = () => !stopped && !context.signal.aborted;
    function cleanupMessages() {
      queue = []; queuedBytes = 0;
      clearTimeout(setupTimer); clearTimeout(decodeTimer); clearTimeout(goAwayTimer);
      context.signal.removeEventListener('abort', abort);
      if (ws) for (const type of ['open', 'message', 'error']) ws.removeEventListener(type, listeners[type]);
    }
    function confirmed() {
      if (physicallyClosed) return;
      physicallyClosed = true;
      stopped = true;
      credentialController.abort();
      cleanupMessages(); clearTimeout(closeTimer);
      ws?.removeEventListener('close', listeners.close);
      occupied = false;
      resolveClosed();
      if (!ready) rejectOpen(failure ?? new ProviderError('SESSION_CLOSED'));
      emit({ type: 'closed' });
    }
    function stop(error) {
      if (stopped) return;
      stopped = true;
      failure = error && normalizeError(error);
      credentialController.abort(); cleanupMessages();
      if (failure) emit({ type: 'error', error: failure });
      if (!ws || ws.readyState === 3) { confirmed(); return; }
      try { ws.close(1000); } catch { /* Retain ownership until a close event. */ }
    }
    function abort() { stop(new ProviderError('ABORTED')); }
    const session = Object.freeze({ closed,
      send(message) {
        // A retiring socket still takes input (2026-09-30): the engine keeps
        // speaking to it until a turn boundary, then hands over.
        if (!active() || !ready) throw new ProviderError('SESSION_CLOSED');
        if (!object(message) || Object.keys(message).length !== 1
          || !['clientContent', 'realtimeInput'].some((key) => object(message[key]))) throw new ProviderError('INVALID_REQUEST');
        const text = encode(message);
        audioInput ||= Object.hasOwn(message.realtimeInput ?? {}, 'audio');
        const limit = audioInput ? LIVE_LIMITS.maxAudioBufferedBytes : LIVE_LIMITS.maxSendBytes;
        if (ws.bufferedAmount + new TextEncoder().encode(text).byteLength > limit) {
          stop(new ProviderError('UNAVAILABLE')); throw new ProviderError('UNAVAILABLE');
        }
        try { ws.send(text); }
        catch { stop(new ProviderError('NETWORK_ERROR')); throw new ProviderError('NETWORK_ERROR'); }
        // 2026-09-30: the bytes still waiting to leave, a count and nothing
        // else, so a caller sending held audio can keep clear of the guard.
        return Number.isFinite(ws.bufferedAmount) ? ws.bufferedAmount : undefined;
      },
      close() {
        if (physicallyClosed) return closed;
        if (!closePromise) {
          closePromise = new Promise((resolve, reject) => {
            closeTimer = setTimeout(() => reject(new ProviderError('TIMEOUT')), closeTimeoutMs);
            closed.then(() => { clearTimeout(closeTimer); resolve(); });
          });
          closePromise.catch(() => {});
          stop();
        }
        return closePromise;
      },
    });
    function dispatch(message) {
      if (!object(message)) throw new ProviderError('INVALID_RESULT');
      if (message.error) { stop(normalizeGeminiError(message)); return; }
      if (Object.hasOwn(message, 'setupComplete')) {
        if (!object(message.setupComplete) || !setupSent) throw new ProviderError('INVALID_RESULT');
        if (!ready) { ready = true; clearTimeout(setupTimer); resolveOpen(session); emit({ type: 'ready' }); }
      } else if (message.goAway) {
        if (!ready) { stop(new ProviderError('UNAVAILABLE')); return; }
        if (!retiring) {
          retiring = true;
          const duration = message.goAway.timeLeft;
          const ms = typeof duration === 'string' && /^\d+(\.\d{1,9})?s$/.test(duration)
            ? Number(duration.slice(0, -1)) * 1000 : setupTimeoutMs;
          const timeLeftMs = Math.min(Number.isFinite(ms) ? ms : setupTimeoutMs, 2147483647);
          // Backstop only: the provider ends the connection as ABORTED at this
          // point anyway, so a consumer that has not handed over by then sees
          // UNAVAILABLE rather than a socket that silently stops answering.
          goAwayTimer = setTimeout(() => stop(new ProviderError('UNAVAILABLE')), timeLeftMs);
          emit({ type: 'goAway', timeLeftMs });
        }
      } else if (message.serverContent) {
        if (!ready || !object(message.serverContent)) throw new ProviderError('INVALID_RESULT');
        emit({ type: 'content', content: message.serverContent });
      } else if (Object.hasOwn(message, 'sessionResumptionUpdate') && ready && active()) {
        resumption(message.sessionResumptionUpdate);
      }
      // usageMetadata may ride on any server message, after that message's own
      // content. Unknown future control fields are ignored.
      if (Object.hasOwn(message, 'usageMetadata') && ready && active()) usage(message.usageMetadata);
    }
    // A malformed update is ignored, never fatal: resumption is an optimisation.
    // The handle is kept only while the provider says it is resumable.
    function resumption(update) {
      if (!object(update) || (update.resumable !== undefined && typeof update.resumable !== 'boolean')
        || (update.newHandle !== undefined && typeof update.newHandle !== 'string')) return;
      emit({ type: 'resumption',
        handle: update.resumable === true && isResumeHandle(update.newHandle) ? update.newHandle : null });
    }
    function usage(metadata) {
      if (!object(metadata)) return;
      const report = {};
      for (const [from, to] of USAGE_FIELDS) {
        if (metadata[from] === undefined) continue;
        if (!count(metadata[from])) return;
        report[to] = metadata[from];
      }
      if (Object.keys(report).length) emit({ type: 'usage', ...report });
    }
    async function drain() {
      if (processing) return;
      processing = true;
      while (queue.length && active()) {
        const { data, bytes } = queue[0];
        decodeTimer = setTimeout(() => stop(new ProviderError('TIMEOUT')), decodeTimeoutMs);
        try {
          const text = typeof data === 'string' ? data
            : new TextDecoder('utf-8', { fatal: true }).decode(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
          if (!active()) break;
          dispatch(JSON.parse(text));
        } catch (error) {
          if (active()) stop(error instanceof ProviderError ? error : new ProviderError('INVALID_RESULT'));
        } finally { clearTimeout(decodeTimer); }
        if (!active()) break;
        queue.shift(); queuedBytes -= bytes;
      }
      processing = false;
    }
    let setupSent = false;
    const listeners = {
      open() {
        if (!active() || setupSent) return;
        try { setupSent = true; ws.send(setup); }
        catch { stop(new ProviderError('NETWORK_ERROR')); }
      },
      message(event) {
        if (!active()) return;
        const data = event.data;
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength
          : data instanceof ArrayBuffer ? data.byteLength
            : typeof BlobType === 'function' && data instanceof BlobType ? data.size : -1;
        if (bytes < 0 || bytes > LIVE_LIMITS.maxMessageBytes || queuedBytes + bytes > LIVE_LIMITS.maxQueueBytes
          || queue.length >= LIVE_LIMITS.maxQueueMessages) { stop(new ProviderError('INVALID_RESULT')); return; }
        queue.push({ data, bytes }); queuedBytes += bytes;
        void drain();
      },
      error() { if (active()) stop(new ProviderError('NETWORK_ERROR')); },
      close(event) {
        if (!stopped) {
          failure = normalizeGeminiLiveClose(event);
          stopped = true;
          emit({ type: 'error', error: failure });
        }
        confirmed();
      },
    };
    context.signal.addEventListener('abort', abort, { once: true });
    setupTimer = setTimeout(() => stop(new ProviderError('TIMEOUT')), setupTimeoutMs);
    Promise.resolve().then(async () => {
      if (!active()) return;
      let key;
      try {
        key = await resolveCredential(context.credentialRef,
          { providerId: 'gemini', keySource: context.keySource, transport: 'direct' },
          { signal: credentialController.signal });
      } catch (error) { if (active()) stop(normalizeError(error)); return; }
      if (!active()) return;
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(key)) { stop(new ProviderError('CREDENTIAL_REQUIRED')); return; }
      try {
        // Browser WebSocket has no custom headers. Authentication URL is used
        // only here, per design §8.1; never store or export it for diagnostics.
        ws = new Socket(`${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`);
        key = undefined;
        ws.binaryType = 'arraybuffer';
        for (const [type, listener] of Object.entries(listeners)) ws.addEventListener(type, listener);
      } catch { stop(new ProviderError('NETWORK_ERROR')); }
    }).catch(() => stop(new ProviderError('PROVIDER_ERROR')));
    return opening;
  }
}
