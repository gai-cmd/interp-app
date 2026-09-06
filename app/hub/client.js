// New implementation of design-p2 §§8–10 and 17. Audience envelopes are
// reused through protocol.js (source: ~/jarvis2/interp-web/server.js).
// The provider reconnect loop in ~/jarvis2/interp-web/lib/live.js is not ported.
//
// P3-11 (design-p3 §1.8): the same receive-only audience connection can carry
// the live-control negotiation. When a join is given a `control`, the client
// sends the §1.8 hello once the socket opens; the hub's hello then reports
// whether the extension is supported (event.control) and `policy.control`
// snapshots arrive as 'control' events in arrival order. Nothing else is sent,
// and a connection without `control` behaves exactly as before (the legacy hub
// ignores audience text anyway). Whether a connection is control-only or a
// listening socket is the consumer's business: the client never touches keys,
// the microphone or speech either way.
//
// createHubControl below is the state P3-10 (`app/hub/control.js`) was to own.
// That task has not landed, so this file defines the minimal interface from
// architecture.md "허브 통제" here; P3-10 should move it into control.js unchanged.
import { createHubProtocol, HUB_LIMITS } from './protocol.js';
import { createLiveRecovery } from '../engine/live-recovery.js';
import { withDeadline } from '../engine/retry.js';
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';

export const HUB_CLIENT_LIMITS = Object.freeze({ messageBytes: HUB_LIMITS.messageBytes,
  queueMessages: 128, queueBytes: 2 * 1048576, helloMs: 10000, closeMs: 5000, decodeMs: 10000 });
// The epoch hint of a first negotiation: the app has no broadcast epoch until the
// hub's hello names one (§1.8 "새 epoch는 새 hello 이후에만 수락"); the server
// answers with the epoch it accepted regardless of this hint.
export const HUB_CONTROL_INITIAL_EPOCH = 'initial';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One client per app. join returns a receive-only operation synchronously.
 * ready resolves on the first valid hello; done resolves with a safe outcome.
 * closed resolves ONLY after physical shutdown, even when done already failed.
 * close rejects on a close deadline; callers must retain ownership until closed.
 * onEvent is synchronous, ordered and carries all languages, without replay or
 * broadcast inference. P2-13 owns captions, TTS, language selection and epochs.
 * Registry injection is trusted composition only, as in createHubProtocol.
 *
 * `control` (P3-11) is optional: `{ eventId, epoch?, revision? }` or a function
 * returning that (or null) at every connection attempt, so a reconnect can
 * carry the last accepted epoch and revision. The values come from the joined
 * event and the control state, never from the hub, a QR code or settings.
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

  function join({ hubId, roomCode } = {}, { signal, onEvent = () => {}, control = null } = {}) {
    assertActive(signal);
    if (active) throw new ProviderError('SESSION_LIMIT');
    let url = protocol.buildUrl(hubId, roomCode);
    if (typeof Socket !== 'function' || typeof onEvent !== 'function') throw new ProviderError('INVALID_REQUEST');
    if (control !== null && control !== undefined && typeof control !== 'function' && !isObject(control)) throw new ProviderError('INVALID_REQUEST');
    // The negotiation text for one attempt; null when nothing is to be sent.
    const helloText = () => {
      const value = typeof control === 'function' ? control() : control;
      if (value === null || value === undefined) return null;
      if (!isObject(value)) throw new ProviderError('INVALID_REQUEST');
      return protocol.buildHello(undefined, { eventId: value.eventId, epoch: value.epoch ?? HUB_CONTROL_INITIAL_EPOCH,
        revision: value.revision ?? 0 });
    };
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
        socket?.removeEventListener('open', open);
        socket?.removeEventListener('message', message);
        socket?.removeEventListener('error', error);
        socket?.removeEventListener('close', close);
      };
      // P3-11: the negotiation hello is the only text this client ever sends,
      // and only when the consumer joined an event. A refused send is a
      // connection failure; malformed control input is the caller's error.
      function open() {
        if (ended) return;
        let text;
        try { text = helloText(); } catch (raw) { end({ error: normalizeError(raw), terminal: true }); return; }
        if (text === null) return;
        try { socket.send(text); } catch { end({ error: new ProviderError('NETWORK_ERROR') }); }
      }
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
        socket?.removeEventListener('open', open);
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
        socket.addEventListener('open', open);
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

/**
 * Live-control state of one joined event (design-p3 §1.8; the P3-10 interface
 * of architecture.md "허브 통제", defined here until control.js exists).
 *
 * createHubControl({ now, setTimeout, clearTimeout }) returns frozen
 * { negotiate(control), receive(snapshot), disconnected(), reset(), snapshot(), subscribe(fn), close() }.
 * - negotiate(hello.control | null): the hub's answer. null marks a hub without
 *   the extension (supported: false); a control object marks success and, when
 *   its epoch or event differs from the current one, opens a new epoch whose
 *   first snapshot is accepted at any revision.
 * - receive(control event): a full snapshot. Rejected (returns false) unless
 *   negotiated, same event and epoch, and a higher revision. A repeat of the
 *   current revision is the heartbeat: it re-arms the TTL and clears
 *   heartbeatLost without changing state. Lower revisions are ignored.
 * - The TTL runs on the app's monotonic timer from reception; expiry and
 *   disconnected() only set heartbeatLost. The stop latch, disabled features
 *   and notice are cleared by nothing but a newer accepted snapshot or reset().
 * - snapshot() -> frozen { supported: null | boolean, eventId, epoch, revision,
 *   stopped, disabledFeatures, notice, heartbeatLost, expiresAt }.
 *   supported is null before any hello. expiresAt is a `now()` value or null.
 */
export function createHubControl({ now = () => performance.now(), setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: clear = globalThis.clearTimeout } = {}) {
  if (typeof now !== 'function' || typeof schedule !== 'function' || typeof clear !== 'function') throw new ProviderError('INVALID_REQUEST');
  const initial = () => ({ supported: null, eventId: null, epoch: null, revision: null, stopped: false,
    disabledFeatures: Object.freeze([]), notice: null, heartbeatLost: false, expiresAt: null });
  const listeners = new Set();
  let state = initial(), timer = null, closed = false, cached = null;
  const snapshot = () => { cached ??= Object.freeze({ ...state }); return cached; };
  function notify() {
    cached = null;
    const value = snapshot();
    for (const listener of [...listeners]) { try { listener(value); } catch { /* Consumer-owned failure. */ } }
  }
  function disarm() { if (timer !== null) { clear(timer); timer = null; } }
  // Heartbeat deadline: a missing snapshot within ttlSeconds means the venue
  // control cannot be confirmed. It never releases a stop.
  function arm(seconds) {
    disarm();
    state.expiresAt = now() + seconds * 1000;
    timer = schedule(() => { timer = null; if (!closed && state.supported === true) { state.heartbeatLost = true; notify(); } }, seconds * 1000);
  }
  return Object.freeze({
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    negotiate(control) {
      if (closed) return snapshot();
      if (control === null || control === undefined) {
        disarm();
        state.supported = false; state.eventId = null; state.epoch = null; state.revision = null;
        state.heartbeatLost = false; state.expiresAt = null;
        notify(); return snapshot();
      }
      if (!isObject(control) || typeof control.eventId !== 'string' || typeof control.epoch !== 'string') throw new ProviderError('INVALID_REQUEST');
      if (control.eventId !== state.eventId || control.epoch !== state.epoch) state.revision = null;
      state.supported = true; state.eventId = control.eventId; state.epoch = control.epoch; state.heartbeatLost = false;
      // The first full snapshot follows the hello; give it the longest TTL.
      arm(HUB_LIMITS.ttlMaxSeconds);
      notify(); return snapshot();
    },
    receive(value) {
      if (closed || state.supported !== true || !isObject(value) || value.type !== 'control') return false;
      if (value.eventId !== state.eventId || value.epoch !== state.epoch || !Number.isSafeInteger(value.revision)) return false;
      if (state.revision !== null && value.revision < state.revision) return false;
      if (value.revision === state.revision) {
        state.heartbeatLost = false; arm(value.ttlSeconds); notify(); return false;
      }
      state.revision = value.revision; state.stopped = value.stopped === true;
      state.disabledFeatures = Object.freeze([...value.disabledFeatures]); state.notice = value.notice ?? null;
      state.heartbeatLost = false;
      arm(value.ttlSeconds);
      notify(); return true;
    },
    disconnected() {
      if (closed) return snapshot();
      disarm();
      state.expiresAt = null;
      if (state.supported === true) state.heartbeatLost = true;
      notify(); return snapshot();
    },
    reset() {
      if (closed) return snapshot();
      disarm(); state = initial(); notify(); return snapshot();
    },
    close() { closed = true; disarm(); listeners.clear(); },
  });
}
