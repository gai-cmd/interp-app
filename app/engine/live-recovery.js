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
 * reopenFree() (2026-09-30) authorizes one open at once, after physical close:
 * no backoff and no charge. Its callers bound these opens, not this budget:
 * keySwapped() (a spare site key took over from one whose quota was spent;
 * the key pool bounds it) is the same permission under its caller's name, and
 * so is the engine's retry of a refused resumed setup (once per handle).
 * handedOver() (a planned goAway handover of a connection that ran for at
 * least a minute; its age bounds it) first settles the stable window exactly
 * as wait() does (review, 2026-09-30): a goAway used to pass through wait(),
 * which renewed the budget and the retry count after 60 s of stable
 * connection, and a failure soon after a handover must still find them renewed.
 */
export function createLiveRecovery({ now = () => performance.now(), ...timing } = {}) {
  const policy = createLiveRetryPolicy({ now, ...timing });
  let attempts = createBudget({ limit: 4 });
  let stableSince = null, address, permitted = true, busy = false, swapped = false;
  function reopenFree() {
    if (busy || permitted || !attempts.used) throw new ProviderError('INVALID_REQUEST');
    permitted = true; swapped = true; stableSince = null;
  }
  // The stable connection is the initial connection of the renewed window.
  function settle() {
    if (stableSince !== null && now() - stableSince >= 60000) {
      attempts = createBudget({ limit: 4 });
      attempts.consume(address);
    }
    stableSince = null;
  }
  const budget = Object.freeze({
    get used() { return attempts.used; },
    get remaining() { return attempts.remaining; },
    consume(context = {}) {
      assertActive(context.signal);
      if (busy || !permitted) throw new ProviderError('BUDGET_EXHAUSTED');
      if (swapped) swapped = false;
      else attempts.consume(context);
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
      address = undefined; permitted = true; swapped = false; stableSince = null; policy.restart();
    },
    reopenFree, keySwapped: reopenFree,
    handedOver() {
      if (busy || permitted || !attempts.used) throw new ProviderError('INVALID_REQUEST');
      settle(); policy.settle(); reopenFree();
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
        settle();
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
