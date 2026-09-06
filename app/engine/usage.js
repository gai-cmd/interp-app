// P3-29: observed usage and the cost estimate built from it (design-p3 §1.13).
//
// Free/Paid is a display setting the user picks. It changes nothing about API
// permission, real billing, quota or the retry budget, and this module cannot
// change any of those either: it only measures spans and multiplies them by a
// rate someone else published.
//
// What the numbers mean, and what they must never claim:
//   - a span is ACTIVE USE — the time a provider call was actually running —
//     never the time the page was open;
//   - a rate is an operator's estimate per active minute (basis
//     'activeMinuteEstimate'), not Google's token price restated per minute;
//   - a model with no confirmed rate is "cannot estimate", never zero, and a
//     partial set of rates yields "the estimable part", never a whole-run total;
//   - the rate in force when a span ENDED is the rate that span keeps, so a new
//     price list never rewrites what was already used;
//   - hub listening is an audience receiving a finished broadcast, so it is not
//     charged as the listener's own provider call;
//   - a personal key and a shared event key are not added together.
//
// Nothing here touches storage, the network or the DOM, and a span carries an
// id and a model only — never a key, a transcript or audio.
import { RATE_BASES, RATE_UNITS } from '../policy/schema.js';

/** Sources of usage that are counted separately and never summed together. */
export const USAGE_SCOPES = Object.freeze(['personal', 'shared']);
/** Why a cost could not be estimated. */
export const ESTIMATE_STATES = Object.freeze(['free', 'estimated', 'partial', 'unavailable']);
export const MINUTE_MS = 60000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/i.test(value);
/** Rounded to whole milliseconds; a negative or unusable span is zero. */
const spanMs = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && to > from ? Math.round(to - from) : 0);

/** The rate for one model+capability, or null when nothing confirms it. */
export function findRate(pricing, { model, capability } = {}) {
  const rates = Array.isArray(pricing?.rates) ? pricing.rates : [];
  const match = rates.find((rate) => rate?.model === model && rate?.capability === capability);
  if (!match || typeof match.amount !== 'number' || !Number.isFinite(match.amount)) return null;
  // A unit or basis this build does not understand is not silently treated as
  // per-minute: an unknown rate is no rate.
  if (!RATE_UNITS.includes(match.unit) || !RATE_BASES.includes(match.basis)) return null;
  return Object.freeze({ ...match, revision: pricing?.revision ?? null, currency: pricing?.currency ?? null });
}

/**
 * createUsage({ now, pricing? }) collects spans and reports totals.
 *
 *   begin({ id, capability, model, scope? })  → the span id
 *   end(id, { failed? })                      → frozen span or null
 *   setPricing(pricing)                       → the price list in force from now
 *   snapshot()                                → frozen totals (below)
 *   subscribe(fn) / reset() / close()
 *
 * A repeated end(), an end() for an unknown id and an end() after close() all
 * do nothing: a reconnect or a stop-then-callback must not add time twice.
 *
 * snapshot() -> { activeMs, byCapability, byModel, spans, estimate }
 * where estimate is { state, amount, currency, revision, estimableMs,
 * unestimableMs, models: { model: 'rated' | 'unrated' } }.
 */
export function createUsage({ now = Date.now, pricing = null, plan = 'free' } = {}) {
  if (typeof now !== 'function') throw new Error('INVALID_REQUEST');
  const listeners = new Set();
  const open = new Map();
  let finished = [];
  let table = pricing ?? null;
  let current = plan === 'paid' ? 'paid' : 'free';
  let closed = false, cached = null;

  function notify() {
    cached = null;
    const value = snapshot();
    for (const fn of [...listeners]) { try { fn(value); } catch { /* Consumer-owned failure. */ } }
  }

  function totals() {
    const byCapability = {}, byModel = {}, models = {};
    let activeMs = 0, estimableMs = 0, unestimableMs = 0, amount = 0, currency = null, revision = null;
    for (const span of finished) {
      // Hub listening is an audience receiving a broadcast someone else paid
      // for: it is measured but never priced (§1.13).
      activeMs += span.durationMs;
      byCapability[span.capability] = (byCapability[span.capability] ?? 0) + span.durationMs;
      byModel[span.model] = (byModel[span.model] ?? 0) + span.durationMs;
      if (span.billable === false) continue;
      if (span.rate === null) {
        unestimableMs += span.durationMs;
        models[span.model] ??= 'unrated';
        continue;
      }
      estimableMs += span.durationMs;
      models[span.model] = 'rated';
      amount += (span.durationMs / MINUTE_MS) * span.rate.amount;
      currency ??= span.rate.currency ?? null;
      revision ??= span.rate.revision ?? null;
    }
    return { activeMs, byCapability, byModel, models, estimableMs, unestimableMs, amount, currency, revision };
  }

  function snapshot() {
    if (cached) return cached;
    const t = totals();
    // Free shows time only: a cost nobody asked for is not shown, and an
    // unknown cost is never shown as zero.
    const state = current !== 'paid' ? 'free'
      : t.estimableMs === 0 && t.unestimableMs === 0 ? 'unavailable'
      : t.unestimableMs === 0 ? 'estimated'
      : t.estimableMs === 0 ? 'unavailable' : 'partial';
    cached = Object.freeze({
      plan: current,
      activeMs: t.activeMs,
      openSpans: open.size,
      spans: finished.length,
      byCapability: Object.freeze({ ...t.byCapability }),
      byModel: Object.freeze({ ...t.byModel }),
      estimate: Object.freeze({
        state,
        // No amount at all unless something could actually be priced.
        amount: state === 'estimated' || state === 'partial' ? Number(t.amount.toFixed(6)) : null,
        currency: state === 'estimated' || state === 'partial' ? t.currency : null,
        revision: t.revision,
        estimableMs: t.estimableMs,
        unestimableMs: t.unestimableMs,
        models: Object.freeze({ ...t.models }),
      }),
    });
    return cached;
  }

  return Object.freeze({
    snapshot,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
    get plan() { return current; },
    setPlan(plan) {
      const next = plan === 'paid' ? 'paid' : 'free';
      if (next === current || closed) return current;
      current = next; notify(); return current;
    },
    /** The price list in force from now on; spans already ended keep theirs. */
    setPricing(next) {
      if (closed) return table;
      table = isObject(next) ? next : null;
      notify();
      return table;
    },
    /**
     * Start measuring one provider call. `billable: false` marks usage that is
     * measured but never priced (hub listening). An id already open is not
     * restarted, so a reconnect cannot double count.
     */
    begin({ id, capability, model, scope = 'personal', billable = true } = {}) {
      if (closed || !identifier(id) || !identifier(capability) || !identifier(model)) return null;
      if (open.has(id)) return id;
      open.set(id, { id, capability, model,
        scope: USAGE_SCOPES.includes(scope) ? scope : 'personal',
        billable: billable !== false, startedAt: now() });
      notify();
      return id;
    },
    /** Close a span. Unknown, repeated and post-close calls do nothing. */
    end(id, { failed = false } = {}) {
      if (closed) return null;
      const entry = open.get(id);
      if (!entry) return null;
      open.delete(id);
      const endedAt = now();
      // The rate in force when the span ENDED is the one it keeps, so a later
      // price list never rewrites usage that already happened.
      const span = Object.freeze({ ...entry, endedAt, failed: failed === true,
        durationMs: spanMs(entry.startedAt, endedAt),
        rate: findRate(table, entry) });
      finished = [...finished, span];
      notify();
      return span;
    },
    /** Spans for one scope; a personal and a shared key are never summed. */
    spansOf(scope) { return Object.freeze(finished.filter((span) => span.scope === scope)); },
    reset() {
      if (closed) return;
      open.clear(); finished = []; notify();
    },
    close() { closed = true; open.clear(); listeners.clear(); },
  });
}
