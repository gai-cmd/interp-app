// New implementation of design-p2 §9; no legacy runtime code is ported.
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';
import { withDeadline } from './retry.js';

// App work and provider Live sockets are separate, module-wide ownership domains.
let current = null, generation = 0, pending = 0, epoch = 0;
let queue = Promise.resolve();
const listeners = new Set();
const kinds = new Set(['seq', 'sim', 'hub', 'diagnostics', 'preview']);
const snapshot = () => Object.freeze({ generation, occupied: Boolean(current) || pending > 0,
  active: Boolean(current && !current.controller.signal.aborted), kind: current?.kind ?? null });
function notify() {
  for (const listener of [...listeners]) {
    try { listener(snapshot()); } catch { /* Consumer-owned failure. */ }
  }
}
function invalidate(entry) {
  if (!entry || entry.controller.signal.aborted) return;
  // Invalidate before abort listeners or cancellation hooks can emit results.
  generation++;
  entry.controller.abort();
  entry.detach();
  notify();
}
function validate(kind, hooks) {
  if (!kinds.has(kind) || typeof hooks?.cancel !== 'function' || typeof hooks?.close !== 'function') {
    throw new ProviderError('INVALID_REQUEST');
  }
  assertActive(hooks.signal);
}

/** Acquire before any permission, credential lookup, capture, or playback.
 * cancel() stops all producers synchronously; close() confirms all cleanup,
 * including late resources and physical socket closure. Neither may swallow
 * cleanup failures. Hooks can close over a handle assigned after acquisition.
 */
export function createActivity({ timeoutMs = 10000, ...timing } = {}) {
  function shutdown(entry) {
    if (!entry) return Promise.resolve();
    invalidate(entry);
    if (!entry.closing) {
      // Install the promise before invoking reentrant consumer hooks.
      entry.closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([entry.cancelled, Promise.resolve().then(() => entry.close())]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw normalizeError(failure.reason);
        if (current === entry) { current = null; notify(); }
      });
      try { entry.cancelled = Promise.resolve(entry.cancel()); }
      catch (raw) { entry.cancelled = Promise.reject(normalizeError(raw)); }
      entry.cancelled.catch(() => {});
      entry.closing.catch(() => {});
    }
    return withDeadline(() => entry.closing, { ...timing, timeoutMs });
  }
  function acquire(kind, hooks, queued = false) {
    validate(kind, hooks);
    if (current || (!queued && pending)) throw new ProviderError('SESSION_LIMIT');
    const entry = { kind, generation: ++generation, controller: new AbortController(),
      cancel: hooks.cancel, close: hooks.close, detach: () => {} };
    current = entry;
    const abort = () => { shutdown(entry).catch(() => {}); };
    hooks.signal?.addEventListener('abort', abort, { once: true });
    entry.detach = () => hooks.signal?.removeEventListener('abort', abort);
    const lease = Object.freeze({ generation: entry.generation, signal: entry.controller.signal,
      isCurrent: () => current === entry && !entry.controller.signal.aborted,
      close: () => shutdown(entry) });
    notify();
    return lease;
  }
  return Object.freeze({ snapshot, subscribe(listener) {
    if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
    listeners.add(listener); return () => listeners.delete(listener);
  },
  get occupied() { return snapshot().occupied; },
  get generation() { return generation; },
  isCurrent(value) { return current?.generation === value && !current.controller.signal.aborted; },
  acquire(kind, hooks) { return acquire(kind, hooks); },
  replace(kind, hooks) {
    try {
      validate(kind, hooks);
      // Auxiliary work must never silently steal an interpretation session.
      if (kind === 'diagnostics' || kind === 'preview') return Promise.resolve(acquire(kind, hooks));
    } catch (raw) { return Promise.reject(normalizeError(raw)); }
    const requestedEpoch = epoch;
    pending++;
    const closing = shutdown(current); closing.catch(() => {});
    notify();
    const result = queue.then(async () => {
      assertActive(hooks.signal);
      if (requestedEpoch !== epoch) throw new ProviderError('ABORTED');
      await closing;
      await shutdown(current);
      assertActive(hooks.signal);
      if (requestedEpoch !== epoch) throw new ProviderError('ABORTED');
      return acquire(kind, hooks, true);
    }).finally(() => { pending--; notify(); });
    queue = result.catch(() => {});
    return result;
  },
  close() {
    epoch++;
    const closing = shutdown(current);
    return Promise.all([closing, queue]).then(() => {});
  } });
}
