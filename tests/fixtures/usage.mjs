// P3-29 fixtures: price lists and a controllable clock. The rates are synthetic
// operator estimates, not Google prices, and carry the basis the design fixes
// (activeMinuteEstimate) so the module's refusal of anything else can be shown.
export function createClock(start = 0) {
  let time = start;
  return { now: () => time, advance(ms) { time += ms; return time; }, set(value) { time = value; } };
}
/** One rate entry as the policy schema validates it. */
export const rate = (overrides = {}) => ({ model: 'gemini-3.1-flash-live-preview', capability: 'live',
  unit: 'minute', amount: 0.6, basis: 'activeMinuteEstimate', confidence: 'medium',
  verifiedAt: '2026-09-01T00:00:00Z', ...overrides });
/** A price list; `rates` replaces the default single entry. */
export const pricing = (overrides = {}) => ({ revision: 3, updatedAt: '2026-09-01T00:00:00Z',
  currency: 'USD', allowLocalOverride: false, rates: [rate()], ...overrides });
export const MINUTES = 60000;
