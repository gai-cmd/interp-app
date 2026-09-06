// New implementation of design-p2 §§8.4 and 9; no legacy reconnect loop is ported.
import { ProviderError, assertActive, normalizeError } from '../providers/contract.js';
import { createBudget, createLiveRetryPolicy } from './retry.js';

const retryable = new Set(['RATE_LIMITED', 'UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT',
  'SESSION_LIMIT', 'SESSION_CLOSED']);
const fallbackable = new Set(['MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'UNAVAILABLE', 'NETWORK_ERROR']);

/**
 * One policy per user operation, shared across every model and connection.
 * Router alone consumes budget. After physical close, wait() authorizes one open.
 * opened() means setup/hello completed; activity() starts the stable interval.
 * Use the operation signal, never the old lease's aborted cleanup signal.
 */
export function createLiveRecovery({ now = () => performance.now(), ...timing } = {}) {
  const policy = createLiveRetryPolicy({ now, ...timing });
  let attempts = createBudget({ limit: 4 });
  let stableSince = null, address, permitted = true, busy = false;
  const budget = Object.freeze({
    get used() { return attempts.used; },
    get remaining() { return attempts.remaining; },
    consume(context = {}) {
      assertActive(context.signal);
      if (busy || !permitted) throw new ProviderError('BUDGET_EXHAUSTED');
      attempts.consume(context);
      address = { providerId: context.providerId, keySource: context.keySource };
      permitted = false;
      stableSince = null;
    },
  });
  return Object.freeze({
    budget,
    get retries() { return policy.retries; },
    opened() { stableSince = null; policy.opened(); },
    activity() {
      if (!attempts.used || permitted || busy) return;
      if (stableSince === null) stableSince = now();
      policy.activity();
    },
    // Only explicit user restart, after the previous operation has been stopped.
    restart() {
      if (busy) throw new ProviderError('INVALID_REQUEST');
      attempts = createBudget({ limit: 4 });
      address = undefined; permitted = true; stableSince = null; policy.restart();
    },
    async wait(raw, { signal, closed = false, goAway = false, request, resolveFallback } = {}) {
      assertActive(signal);
      if (busy || permitted || !attempts.used) throw new ProviderError('INVALID_REQUEST');
      const error = normalizeError(raw);
      // closed must certify actual shutdown, not finishInput or a close deadline.
      if (closed !== true) throw error;
      busy = true;
      try {
        const replacement = !goAway && fallbackable.has(error.code)
          ? resolveFallback?.(error, request) : null;
        if (!goAway && !replacement && !retryable.has(error.code)) throw error;
        if (stableSince !== null && now() - stableSince >= 60000) {
          attempts = createBudget({ limit: 4 });
          // The stable connection is the initial connection of the renewed window.
          attempts.consume(address);
        }
        stableSince = null;
        if (!attempts.remaining) throw new ProviderError('BUDGET_EXHAUSTED');
        // Reuse existing jitter, server wait, cancellation and retry counter.
        const scheduling = new ProviderError(goAway || replacement || error.code === 'SESSION_CLOSED'
          ? 'UNAVAILABLE' : error.code);
        if (error.retryAfterMs !== undefined) scheduling.retryAfterMs = error.retryAfterMs;
        await policy.wait(scheduling, { signal, closed: true });
        permitted = true;
        return replacement || request;
      } catch (error) { throw normalizeError(error); }
      finally { busy = false; }
    },
  });
}
