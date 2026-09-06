// New implementation of design-p2 §§8–10 and 17. Audience envelopes are
// reused through protocol.js (source: ~/jarvis2/interp-web/server.js).
// The provider reconnect loop in ~/jarvis2/interp-web/lib/live.js is not ported.
import { createHubProtocol, HUB_LIMITS } from './protocol.js';
import { createLiveRecovery } from '../engine/live-recovery.js';
import { withDeadline } from '../engine/retry.js';
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';

export const HUB_CLIENT_LIMITS = Object.freeze({ messageBytes: HUB_LIMITS.messageBytes,
  queueMessages: 128, queueBytes: 2 * 1048576, helloMs: 10000, closeMs: 5000, decodeMs: 10000 });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

/** One client per app. join returns a receive-only operation synchronously.
 * ready resolves on the first valid hello; done resolves with a safe outcome.
 * closed resolves ONLY after physical shutdown, even when done already failed.
 * close rejects on a close deadline; callers must retain ownership until closed.
 * onEvent is synchronous, ordered and carries all languages, without replay or
 * broadcast inference. P2-13 owns captions, TTS, language selection and epochs.
 * Registry injection is trusted composition only, as in createHubProtocol.
 */
export function createHubClient({ hubs, WebSocket: Socket = globalThis.WebSocket,
  now = () => performance.now(), random = Math.random,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
  limits: overrides = {} } = {}) {
  const protocol = createHubProtocol({ hubs });
  const limits = { ...HUB_CLIENT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in HUB_CLIENT_LIMITS) || !Number.isSafeInteger(value) || value <= 0
      || value > HUB_CLIENT_LIMITS[key]) throw new ProviderError('INVALID_REQUEST');
  }
  const timing = { now, random, setTimeout: schedule, clearTimeout: clear };
  let active = null;

  function join({ hubId, roomCode } = {}, { signal, onEvent = () => {} } = {}) {
    assertActive(signal);
    if (active) throw new ProviderError('SESSION_LIMIT');
    let url = protocol.buildUrl(hubId, roomCode);
    if (typeof Socket !== 'function' || typeof onEvent !== 'function') throw new ProviderError('INVALID_REQUEST');
    const controller = new AbortController();
    const ready = deferred(), done = deferred(), closed = deferred();
    ready.promise.catch(() => {});
    const recovery = createLiveRecovery(timing);
    let current = null, finished = false, generation = 0, state = 'connecting';
    let maxMessages = 0, maxBytes = 0;
    const emit = (event) => {
      if (controller.signal.aborted) return;
      try { onEvent(Object.freeze({ ...event, generation, receivedAt: now() })); }
      catch { /* Consumer errors cannot leak raw exceptions or break cleanup. */ }
    };
    const setState = (value, error) => { state = value; emit({ type: 'connection', state, ...(error ? { error } : {}) }); };
    const release = () => {
      if (!finished || (current && !current.physical)) return;
      url = null;
      signal?.removeEventListener('abort', stop);
      if (active === handle) active = null;
      closed.resolve();
    };
    function stop() {
      if (finished) return;
      state = 'stopping';
      controller.abort();
      current?.end({ error: new ProviderError('ABORTED'), terminal: true });
    }
    const handle = Object.freeze({
      ready: ready.promise, done: done.promise, closed: closed.promise,
      close() {
        stop();
        return withDeadline(() => closed.promise, { ...timing, timeoutMs: limits.closeMs });
      },
      snapshot() { return Object.freeze({ state, generation, retries: recovery.retries,
        pendingMessages: current?.count ?? 0, pendingBytes: current?.bytes ?? 0,
        maxMessages, maxBytes, closeConfirmed: !current || current.physical }); },
    });
    active = handle;
    signal?.addEventListener('abort', stop, { once: true });

    function attempt() {
      const result = deferred(), physical = deferred(), decoding = new AbortController();
      let socket, ended = false, hello = false, pumping = false, remoteClosed = false;
      let queue = [], helloTimer;
      const connection = { physical: false, count: 0, bytes: 0, closed: physical.promise, end };
      current = connection;
      const remove = () => {
        socket?.removeEventListener('message', message);
        socket?.removeEventListener('error', error);
        socket?.removeEventListener('close', close);
      };
      function confirm() {
        if (connection.physical) return;
        connection.physical = true;
        physical.resolve();
        if (ended) remove();
        release();
      }
      function end(outcome) {
        if (ended) return;
        ended = true;
        clear(helloTimer);
        decoding.abort();
        queue = [];
        connection.count = connection.bytes = 0;
        socket?.removeEventListener('message', message);
        socket?.removeEventListener('error', error);
        if (!socket || socket.readyState === 3) confirm();
        else if (!remoteClosed) {
          try { socket.close(); } catch { /* Only close evidence releases ownership. */ }
          if (socket.readyState === 3) confirm();
        }
        if (connection.physical) remove();
        result.resolve(outcome);
      }
      function error() { end({ error: new ProviderError('NETWORK_ERROR') }); }
      function close() {
        remoteClosed = true;
        confirm();
        // Drain already received messages first: a Blob may contain cast.stopped.
        if (!ended && !pumping && !queue.length) end({ error: new ProviderError('SESSION_CLOSED') });
      }
      function message({ data }) {
        if (ended || remoteClosed) return;
        let size;
        if (typeof data === 'string') {
          size = data.length > limits.messageBytes ? data.length : new TextEncoder().encode(data).byteLength;
        } else if (data instanceof ArrayBuffer) size = data.byteLength;
        else if (typeof Blob !== 'undefined' && data instanceof Blob) size = data.size;
        else { end({ error: new ProviderError('INVALID_RESULT'), terminal: true }); return; }
        if (size > limits.messageBytes || connection.count >= limits.queueMessages
          || connection.bytes + size > limits.queueBytes) {
          emit({ type: 'gap', reason: 'receive-overflow' });
          end({ error: new ProviderError('NETWORK_ERROR') });
          return;
        }
        queue.push({ data, size });
        connection.count++;
        connection.bytes += size;
        maxMessages = Math.max(maxMessages, connection.count);
        maxBytes = Math.max(maxBytes, connection.bytes);
        void pump();
      }
      async function pump() {
        if (pumping || ended) return;
        pumping = true;
        try {
          while (queue.length && !ended) {
            const { data, size } = queue.shift();
            let raw = data;
            if (typeof raw !== 'string') {
              const buffer = raw instanceof ArrayBuffer ? raw : await withDeadline(() => raw.arrayBuffer(),
                { ...timing, signal: decoding.signal, timeoutMs: limits.decodeMs });
              if (ended) return;
              if (buffer.byteLength > limits.messageBytes) throw new ProviderError('INVALID_RESULT');
              raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            }
            if (ended) return;
            const event = protocol.parse(raw);
            connection.count--;
            connection.bytes -= size;
            if (!event) continue;
            if (event.type === 'hello') {
              if (hello) throw new ProviderError('INVALID_RESULT');
              hello = true;
              clear(helloTimer);
              recovery.opened();
              // A validated audience join starts connection stability, not broadcast success.
              recovery.activity();
              setState('running');
              if (ended) return;
              ready.resolve(event);
            } else if (!hello && !['closed', 'denied', 'stopped'].includes(event.type)) {
              throw new ProviderError('INVALID_RESULT');
            }
            emit(event);
            if (['closed', 'denied', 'stopped'].includes(event.type)) {
              end({ terminal: true, reason: event.reason,
                ...(event.type === 'denied' ? { error: new ProviderError('PERMISSION_DENIED') } : {}) });
            }
          }
        } catch (raw) {
          if (!ended) end({ error: raw instanceof ProviderError ? normalizeError(raw) : new ProviderError('INVALID_RESULT'), terminal: true });
        } finally {
          pumping = false;
          if (remoteClosed && !ended) end({ error: new ProviderError('SESSION_CLOSED') });
        }
      }
      try {
        socket = new Socket(url);
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('message', message);
        socket.addEventListener('error', error);
        socket.addEventListener('close', close);
        helloTimer = schedule(() => end({ error: new ProviderError('TIMEOUT') }), limits.helloMs);
      } catch { end({ error: new ProviderError('NETWORK_ERROR') }); }
      return result.promise;
    }

    async function run() {
      let outcome;
      try {
        for (;;) {
          assertActive(controller.signal);
          // Audience transport has no provider router; it alone consumes this budget.
          recovery.budget.consume({ signal: controller.signal });
          generation++;
          setState(generation === 1 ? 'connecting' : 'reconnecting');
          assertActive(controller.signal);
          outcome = await attempt();
          await withDeadline(() => current.closed, { ...timing, timeoutMs: limits.closeMs });
          if (outcome.terminal) break;
          assertActive(controller.signal);
          setState('reconnecting');
          emit({ type: 'gap', reason: 'connection-lost' });
          await recovery.wait(outcome.error, { signal: controller.signal, closed: true });
        }
      } catch (error) { outcome = { error: normalizeError(error) }; }
      finished = true;
      state = outcome?.error && outcome.error.code !== 'ABORTED' ? 'failed' : 'stopped';
      ready.reject(outcome?.error ?? new ProviderError('SESSION_CLOSED'));
      setState(state, outcome?.error);
      done.resolve(Object.freeze({ state, ...(outcome?.error ? { error: outcome.error } : {}),
        ...(outcome?.reason ? { reason: outcome.reason } : {}) }));
      url = null;
      signal?.removeEventListener('abort', stop);
      release();
    }
    // Return the handle before any consumer callback can request its shutdown.
    queueMicrotask(() => { void run(); });
    return handle;
  }
  return Object.freeze({ join });
}
