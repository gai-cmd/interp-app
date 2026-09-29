// New implementation of design-v0.6 §§8–9; no legacy socket code is ported.
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';
import { isPolicyError, PolicyError } from '../policy/errors.js';
import { withDeadline } from './retry.js';

// Shared by all managers in this app module instance, across providers/modes,
// unless a manager is created with { isolated: true } (own private slot).
// This is not a cross-tab, cross-device, or quota security boundary.
const createSlot = () => ({ current: null, generation: 0, queue: Promise.resolve(), listeners: new Set() });
const sharedSlot = createSlot();
function notify(slot) {
  const state = Object.freeze({ generation: slot.generation, occupied: slot.current !== null,
    active: slot.current !== null && !slot.current.controller.signal.aborted });
  for (const listener of [...slot.listeners]) {
    try { listener(state); } catch { /* Consumer-owned failure. */ }
  }
}
function sessionError(entry, raw) {
  const error = isPolicyError(raw) ? new PolicyError(raw.code) : normalizeError(raw);
  // Shutdown uses abort internally, but a peer close is not user cancellation.
  return entry.remoteClosed && error.code === 'ABORTED' ? new ProviderError('SESSION_CLOSED') : error;
}
const serialize = (slot, work) => {
  const result = slot.queue.then(work);
  slot.queue = result.catch(() => {});
  return result;
};

/** open(context) must reject only after cleanup; a resolved session's close()
 * must resolve only after socket shutdown (P1-02). Never pass a raw socket here.
 * Instantiate once at app composition; extra instances share the same slot,
 * unless created with { isolated: true }: a private slot for an independent
 * Live lane (each lane also needs its own Gemini live client, i.e. its own
 * createAppConfig). Isolation is opt-in; the default never changes.
 * Route voice, simultaneous interpretation, and preview through replace().
 */
export function createSessionManager({ timeoutMs = 10000, isolated = false, ...timing } = {}) {
  const slot = isolated === true ? createSlot() : sharedSlot;
  const deadline = (work) => withDeadline(work, { ...timing, timeoutMs });
  async function shutdown(entry) {
    if (!entry) return;
    entry.controller.abort();
    entry.detach();
    notify(slot);
    if (!entry.closing) {
      entry.closing = entry.opening.then(async (session) => {
        if (typeof session?.close !== 'function') throw new ProviderError('INVALID_RESULT');
        try { await session.close(); }
        catch (error) { throw normalizeError(error); }
      }, () => {
        // Rejection means adapter cleanup has completed, per the open contract.
      }).then(() => { if (slot.current === entry) { slot.current = null; notify(slot); } });
      entry.closing.catch(() => {});
    }
    // Preserve the occupied slot on timeout or failed close. Never fail open.
    await deadline(() => entry.closing);
  }
  return Object.freeze({
    subscribe(listener) {
      if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
      slot.listeners.add(listener);
      return () => slot.listeners.delete(listener);
    },
    get generation() { return slot.generation; },
    get occupied() { return slot.current !== null; },
    isCurrent(value) { return slot.current?.generation === value && !slot.current.controller.signal.aborted; },
    replace(open, context = {}) {
      if (typeof open !== 'function' || !context.signal) return Promise.reject(new ProviderError('INVALID_REQUEST'));
      // Retire events immediately, even while an earlier open is pending.
      if (!context.signal.aborted && slot.current) {
        slot.current.controller.abort(); slot.current.detach(); notify(slot);
      }
      return serialize(slot, async () => {
        assertActive(context.signal);
        await shutdown(slot.current);
        assertActive(context.signal);
        const controller = new AbortController();
        const entry = { controller, generation: ++slot.generation, detach: () => {} };
        slot.current = entry;
        const abort = () => { shutdown(entry).catch(() => {}); };
        context.signal.addEventListener('abort', abort, { once: true });
        entry.detach = () => context.signal.removeEventListener('abort', abort);
        const onEvent = (event) => {
          if (slot.current !== entry || controller.signal.aborted) return;
          if (event?.type === 'closed') { entry.remoteClosed = true; shutdown(entry).catch(() => {}); }
          try { context.onEvent?.({ ...event, generation: entry.generation }); } catch { /* Consumer-owned failure. */ }
        };
        entry.opening = Promise.resolve().then(() => {
          assertActive(controller.signal);
          return open({ ...context, signal: controller.signal, generation: entry.generation, onEvent });
        }).catch((error) => { throw sessionError(entry, error); });
        notify(slot);
        try {
          const session = await withDeadline(() => entry.opening, { ...timing, timeoutMs, signal: controller.signal });
          if (typeof session?.close !== 'function') throw new ProviderError('INVALID_RESULT');
          assertActive(controller.signal);
          const lease = { generation: entry.generation, close: () => shutdown(entry) };
          for (const method of ['speak', 'cancel', 'sendAudio', 'finishInput']) {
            if (typeof session[method] !== 'function') continue;
            lease[method] = (...args) => {
              if (slot.current !== entry || controller.signal.aborted) return Promise.reject(new ProviderError('SESSION_CLOSED'));
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
      if (slot.current) { slot.current.controller.abort(); slot.current.detach(); notify(slot); }
      return serialize(slot, () => shutdown(slot.current));
    },
  });
}
