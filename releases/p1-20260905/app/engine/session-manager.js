// New implementation of design-v0.6 §§8–9; no legacy socket code is ported.
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';
import { withDeadline } from './retry.js';

// Shared by all managers in this app module instance, across providers/modes.
// This is not a cross-tab, cross-device, or quota security boundary.
let current = null;
let generation = 0;
let queue = Promise.resolve();
const listeners = new Set();
function notify() {
  const state = Object.freeze({ generation, occupied: current !== null,
    active: current !== null && !current.controller.signal.aborted });
  for (const listener of [...listeners]) {
    try { listener(state); } catch { /* Consumer-owned failure. */ }
  }
}
function sessionError(entry, raw) {
  const error = normalizeError(raw);
  // Shutdown uses abort internally, but a peer close is not user cancellation.
  return entry.remoteClosed && error.code === 'ABORTED' ? new ProviderError('SESSION_CLOSED') : error;
}
const serialize = (work) => {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
};

/** open(context) must reject only after cleanup; a resolved session's close()
 * must resolve only after socket shutdown (P1-02). Never pass a raw socket here.
 * Instantiate once at app composition; extra instances share the same slot.
 * Route voice, simultaneous interpretation, and preview through replace().
 */
export function createSessionManager({ timeoutMs = 10000, ...timing } = {}) {
  const deadline = (work) => withDeadline(work, { ...timing, timeoutMs });
  async function shutdown(entry) {
    if (!entry) return;
    entry.controller.abort();
    entry.detach();
    notify();
    if (!entry.closing) {
      entry.closing = entry.opening.then(async (session) => {
        if (typeof session?.close !== 'function') throw new ProviderError('INVALID_RESULT');
        try { await session.close(); }
        catch (error) { throw normalizeError(error); }
      }, () => {
        // Rejection means adapter cleanup has completed, per the open contract.
      }).then(() => { if (current === entry) { current = null; notify(); } });
      entry.closing.catch(() => {});
    }
    // Preserve the occupied slot on timeout or failed close. Never fail open.
    await deadline(() => entry.closing);
  }
  return Object.freeze({
    subscribe(listener) {
      if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get generation() { return generation; },
    get occupied() { return current !== null; },
    isCurrent(value) { return current?.generation === value && !current.controller.signal.aborted; },
    replace(open, context = {}) {
      if (typeof open !== 'function' || !context.signal) return Promise.reject(new ProviderError('INVALID_REQUEST'));
      return serialize(async () => {
        assertActive(context.signal);
        await shutdown(current);
        assertActive(context.signal);
        const controller = new AbortController();
        const entry = { controller, generation: ++generation, detach: () => {} };
        current = entry;
        notify();
        const abort = () => { shutdown(entry).catch(() => {}); };
        context.signal.addEventListener('abort', abort, { once: true });
        entry.detach = () => context.signal.removeEventListener('abort', abort);
        const onEvent = (event) => {
          if (current !== entry || controller.signal.aborted) return;
          if (event?.type === 'closed') { entry.remoteClosed = true; shutdown(entry).catch(() => {}); }
          try { context.onEvent?.({ ...event, generation: entry.generation }); } catch { /* Consumer-owned failure. */ }
        };
        entry.opening = Promise.resolve().then(() => {
          assertActive(controller.signal);
          return open({ ...context, signal: controller.signal, generation: entry.generation, onEvent });
        }).catch((error) => { throw sessionError(entry, error); });
        try {
          const session = await withDeadline(() => entry.opening, { ...timing, timeoutMs, signal: controller.signal });
          if (typeof session?.close !== 'function') throw new ProviderError('INVALID_RESULT');
          assertActive(controller.signal);
          const lease = { generation: entry.generation, close: () => shutdown(entry) };
          for (const method of ['speak', 'cancel', 'sendAudio', 'finishInput']) {
            if (typeof session[method] !== 'function') continue;
            lease[method] = (...args) => {
              if (current !== entry || controller.signal.aborted) return Promise.reject(new ProviderError('SESSION_CLOSED'));
              // One invocation only: text is never automatically resent.
              if (method === 'cancel') return shutdown(entry);
              return withDeadline(() => session[method](...args), { ...timing, timeoutMs, signal: controller.signal })
                .catch((error) => { shutdown(entry).catch(() => {}); throw sessionError(entry, error); });
            };
          }
          return Object.freeze(lease);
        } catch (error) {
          shutdown(entry).catch(() => {});
          throw sessionError(entry, error);
        }
      });
    },
    close() {
      // Abort immediately, including an opening connection, before queueing.
      if (current) { current.controller.abort(); current.detach(); notify(); }
      return serialize(() => shutdown(current));
    },
  });
}
