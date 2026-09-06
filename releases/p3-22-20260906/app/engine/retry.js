// New implementation of design-v0.6 §§8–9; legacy retry loops are not ported.
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';

const transient = new Set(['RATE_LIMITED', 'UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT']);
const fallback = new Set(['MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'INVALID_RESULT', 'UNAVAILABLE', 'NETWORK_ERROR']);

// The router is the sole consumer. Reuse this object across all stages and models.
export function createBudget({ limit = 3 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new ProviderError('INVALID_REQUEST');
  let used = 0;
  let provider;
  let source;
  return Object.freeze({
    get used() { return used; },
    get remaining() { return limit - used; },
    consume({ providerId, keySource, signal } = {}) {
      assertActive(signal);
      if (used >= limit) throw new ProviderError('BUDGET_EXHAUSTED');
      if (used && (provider !== providerId || source !== keySource)) throw new ProviderError('CREDENTIAL_MISMATCH');
      provider = providerId;
      source = keySource;
      used++;
    },
  });
}

export function retryDelay(attempt, error, random = Math.random) {
  const jitter = Math.max(0, Math.min(1, random()));
  return Math.max(1000 * 2 ** Math.min(2, Math.max(0, attempt - 1)) * (1 + jitter * 0.25),
    Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0);
}

// Split long server waits to avoid the platform's signed 32-bit timer overflow.
export async function waitForRetry(ms, { signal, setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: clear = globalThis.clearTimeout } = {}) {
  assertActive(signal);
  if (!Number.isFinite(ms) || ms < 0) throw new ProviderError('INVALID_REQUEST');
  while (ms > 0) {
    const chunk = Math.min(ms, 2147483647);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clear(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new ProviderError('ABORTED'));
      const timer = schedule(() => finish(), chunk);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    ms -= chunk;
  }
  assertActive(signal);
}

// Finite operations terminate even if an injected adapter ignores cancellation.
export function withDeadline(operation, { signal, timeoutMs = 30000,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
  assertActive(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new ProviderError('INVALID_REQUEST');
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clear(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { controller.abort(); reject(normalizeError(error)); }
      else resolve(value);
    };
    const abort = () => finish(new ProviderError('ABORTED'));
    const timer = schedule(() => finish(new ProviderError('TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve().then(() => {
      assertActive(controller.signal);
      return operation(controller.signal);
    }).then((value) => finish(null, value), (error) => finish(error));
  });
}

/** One executor per user turn. call is normally router.call bound to its router.
 * Models/settings change only through a caller-supplied, registered-policy resolver.
 * Resolver receives sanitized errors; it must return a request, or null to stop.
 * No voice text execution or automatic provider/key changes are accepted here.
 */
export function createRetryExecutor({ call, context, ...timing }) {
  if (typeof call !== 'function' || !context?.signal) throw new ProviderError('INVALID_REQUEST');
  const budget = createBudget();
  const base = { ...context, budget };
  const models = new Set();
  let busy = false;
  return Object.freeze({ budget,
    async run(capability, request, { resolveFallback } = {}) {
      if (!['stt', 'translate'].includes(capability) || busy) throw new ProviderError('INVALID_REQUEST');
      busy = true;
      try {
        let next = request;
        for (;;) {
          assertActive(base.signal);
          if (!budget.remaining) throw new ProviderError('BUDGET_EXHAUSTED');
          if (capability === 'translate') {
            if (!models.has(next.model) && models.size >= 2) throw new ProviderError('BUDGET_EXHAUSTED');
            models.add(next.model);
          }
          const before = budget.used;
          try {
            return await withDeadline((signal) => call(capability, next, { ...base, signal }), { ...timing, signal: base.signal });
          } catch (raw) {
            const error = normalizeError(raw);
            assertActive(base.signal);
            // A preflight failure must not spin without consuming an attempt.
            if (budget.used === before || !budget.remaining) throw error;
            const replacement = fallback.has(error.code) ? resolveFallback?.(error, next) : null;
            if (!replacement && !transient.has(error.code)) throw error;
            if (transient.has(error.code)) await waitForRetry(retryDelay(budget.used, error, timing.random), { ...timing, signal: base.signal });
            next = replacement || next;
          }
        }
      } catch (error) { throw normalizeError(error); }
      finally { busy = false; }
    },
  });
}

// Keep this policy for the lifetime of one user's Live operation, across opens.
export function createLiveRetryPolicy({ now = Date.now, ...timing } = {}) {
  let retries = 0;
  let stableSince = null;
  return Object.freeze({
    get retries() { return retries; },
    opened() { stableSince = null; },
    // Called on confirmed useful operation, not merely WebSocket open.
    activity() { if (stableSince === null) stableSince = now(); },
    restart() { retries = 0; stableSince = null; },
    async wait(error, { signal, closed = false } = {}) {
      assertActive(signal);
      error = normalizeError(error);
      if (!closed || (!transient.has(error.code) && error.code !== 'SESSION_LIMIT')) throw error;
      if (stableSince !== null && now() - stableSince >= 60000) retries = 0;
      stableSince = null;
      if (retries >= 3) throw new ProviderError('BUDGET_EXHAUSTED');
      retries++;
      await waitForRetry(retryDelay(retries, error, timing.random), { ...timing, signal });
    },
  });
}
