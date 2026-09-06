// P3-31: the plan, usage and rate section of the settings screen
// (design-p3 §1.13), over P3-29's model and P3-30's observed spans.
//
// The sentence this section must never imply: choosing Paid does not enable
// Google billing, change API permission, quota or the retry budget. It is a
// display setting, stored per provider, and every number it shows is an
// estimate the operator published — never Google's own price restated.
//
// Free shows time only. Paid shows time plus an estimate, its scope, the rate
// source and the date it was verified. An unknown cost is never shown as zero,
// and a partially priced run says so instead of presenting a whole-run total.
import { createBinder } from './seq-view.js';
import { MINUTE_MS } from '../engine/usage.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
export const PLANS = Object.freeze(['free', 'paid']);
/** Minutes to one decimal; a span shorter than 6 seconds still shows as 0.1. */
export function minutesOf(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0.1, Math.round((ms / MINUTE_MS) * 10) / 10);
}
/** The estimate line key for a state; 'free' shows no cost line at all. */
export function estimateKey(state) {
  return state === 'estimated' ? 'billing.estimate.complete'
    : state === 'partial' ? 'billing.estimate.partial'
    : state === 'unavailable' ? 'billing.estimate.unavailable' : null;
}

/**
 * createBillingView({ usage, i18n, document, preferences?, policy?, providerId })
 * Returns frozen { element, render, refresh, setProvider, destroy }.
 */
export function createBillingView({ usage, i18n, document: doc, preferences = null,
  policy = null, providerId = null } = {}) {
  if (!doc || typeof i18n?.t !== 'function' || typeof usage?.snapshot !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  const removers = [];
  let destroyed = false, provider = providerId, lastKeyGeneration = null;

  const root = element(doc, 'div', { className: 'billing-view' });
  const title = element(doc, 'h4', { className: 'settings-block-title' });
  bind.text(title, 'billing.title');
  root.append(title);

  // The plan. Its label says what it does — and, just as importantly, what it
  // does not do, right next to the control rather than buried in a hint.
  const planRow = element(doc, 'div', { className: 'settings-field billing-plan' });
  const planLabel = element(doc, 'label', { className: 'settings-label', attributes: { for: 'billing-plan' } });
  bind.text(planLabel, 'billing.planLabel');
  const planSelect = element(doc, 'select', { className: 'settings-select', attributes: { id: 'billing-plan' } });
  for (const value of PLANS) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `billing.plan.${value}`);
    planSelect.append(option);
  }
  planRow.append(planLabel, planSelect);
  root.append(planRow);
  const displayOnly = element(doc, 'p', { className: 'settings-note billing-display-only' });
  bind.text(displayOnly, 'billing.displayOnly');
  root.append(displayOnly);
  for (const key of ['billing.mayDiffer', 'billing.perProvider']) {
    const note = element(doc, 'p', { className: 'settings-note' });
    bind.text(note, key);
    root.append(note);
  }
  const keyChanged = element(doc, 'p', { className: 'settings-note billing-key-changed', attributes: { role: 'status' } });
  bind.text(keyChanged, 'billing.keyChanged');
  keyChanged.hidden = true;
  root.append(keyChanged);

  const change = () => {
    const next = PLANS.includes(planSelect.value) ? planSelect.value : 'free';
    attempt(() => usage.setPlan(next));
    // Stored per provider (§1.13): the store scopes the key by its own
    // providerId, so nothing here needs to build the key.
    if (preferences) attempt(() => preferences.set('billing.plan', next));
    render();
  };
  planSelect.addEventListener('change', change);
  removers.push(() => planSelect.removeEventListener('change', change));

  // Usage: always shown, in both plans.
  const usageRow = element(doc, 'p', { className: 'billing-usage', attributes: { role: 'status' } });
  root.append(usageRow);
  const usageHint = element(doc, 'p', { className: 'settings-note' });
  bind.text(usageHint, 'billing.usageHint');
  root.append(usageHint);
  const breakdown = element(doc, 'ul', { className: 'billing-breakdown' });
  const breakdownTitle = element(doc, 'p', { className: 'settings-label billing-breakdown-title' });
  bind.text(breakdownTitle, 'billing.byCapability');
  root.append(breakdownTitle, breakdown);

  // Cost: hidden entirely on Free.
  const cost = element(doc, 'div', { className: 'billing-cost' });
  const costLine = element(doc, 'p', { className: 'billing-estimate', attributes: { role: 'status' } });
  cost.append(costLine);
  for (const key of ['billing.estimateAlways', 'billing.formula', 'billing.notZero', 'billing.rateFixed',
    'billing.noDoubleCount', 'billing.hubExcluded', 'billing.sharedExcluded', 'billing.tokenNotIncluded']) {
    const note = element(doc, 'p', { className: 'settings-note' });
    bind.text(note, key);
    cost.append(note);
  }
  const rateSource = element(doc, 'p', { className: 'billing-rate-source' });
  cost.append(rateSource);
  const rateVerified = element(doc, 'p', { className: 'settings-note billing-rate-verified' });
  cost.append(rateVerified);
  const rateMissing = element(doc, 'p', { className: 'settings-note billing-rate-missing' });
  bind.text(rateMissing, 'billing.rateMissingHint');
  rateMissing.hidden = true;
  cost.append(rateMissing);
  cost.hidden = true;
  root.append(cost);

  // P3-41: personal pricing is deferred until model, capability and currency
  // can be selected together. Never offer an input that cannot be applied.
  const localRow = element(doc, 'div', { className: 'settings-field billing-local-rate' });
  const localHint = element(doc, 'p', { className: 'settings-note' });
  bind.text(localHint, 'billing.localRateHint');
  localRow.append(localHint);
  localRow.hidden = true;
  root.append(localRow);

  function pricing() { return attempt(() => policy?.snapshot().policy?.pricing) ?? null; }

  function render() {
    if (destroyed) return;
    const state = attempt(() => usage.snapshot()) ?? null;
    if (!state) return;
    planSelect.value = state.plan;

    usageRow.textContent = `${i18n.t('billing.usageTime')}: ${i18n.t('billing.usageMinutes', { minutes: String(minutesOf(state.activeMs)) })}`;
    for (const item of Array.from(breakdown.childNodes)) item.remove();
    for (const [capability, ms] of Object.entries(state.byCapability)) {
      const item = element(doc, 'li', { className: 'billing-breakdown-item' });
      // The capability name is registered data, the minutes are formatted text.
      item.textContent = `${capability}: ${i18n.t('billing.usageMinutes', { minutes: String(minutesOf(ms)) })}`;
      breakdown.append(item);
    }

    const paid = state.plan === 'paid';
    cost.hidden = !paid;
    if (paid) {
      const estimate = state.estimate;
      const key = estimateKey(estimate.state);
      const amount = estimate.amount === null ? null
        : `${estimate.currency ? `${estimate.currency} ` : ''}${estimate.amount}`;
      // "추정 불가" carries no number; a partial run is labelled as partial.
      costLine.textContent = amount === null ? i18n.t(key ?? 'billing.estimate.unavailable')
        : `${i18n.t(key)}: ${amount}`;
      rateMissing.hidden = estimate.unestimableMs === 0;
      const table = pricing();
      const source = table ? 'policy' : null;
      rateSource.hidden = source === null;
      if (source) {
        rateSource.textContent = `${i18n.t('billing.rateSource')}: ${i18n.t(`billing.rateSource.${source}`)}`
          + (table.revision === undefined || table.revision === null ? ''
            : ` · ${i18n.t('billing.ratesRevision', { revision: String(table.revision) })}`);
      }
      const verified = (table?.rates ?? []).map((rate) => rate?.verifiedAt).filter(Boolean).sort().at(-1) ?? null;
      rateVerified.hidden = verified === null;
      if (verified) rateVerified.textContent = i18n.t('billing.verifiedAt', { date: String(verified).slice(0, 10) });
    }
    // Explain the deferred feature when the policy permits personal rates.
    const allowed = pricing()?.allowLocalOverride === true;
    localRow.hidden = !allowed;
  }

  removers.push(usage.subscribe(() => render()));
  if (policy && typeof policy.subscribe === 'function') removers.push(policy.subscribe(() => render()));
  render();

  return Object.freeze({
    element: root,
    elements: Object.freeze({ planSelect, usageRow, breakdown, cost, costLine, rateSource, rateVerified,
      rateMissing, localRow, keyChanged, displayOnly }),
    render,
    /** A key change asks the user to confirm the plan display again (§1.13). */
    noteKeyChange(generation) {
      if (destroyed) return;
      if (lastKeyGeneration !== null && generation !== lastKeyGeneration) keyChanged.hidden = false;
      lastKeyGeneration = generation;
    },
    setProvider(next) {
      provider = next;
      if (preferences) {
        const stored = attempt(() => preferences.get('billing.plan'));
        if (PLANS.includes(stored)) attempt(() => usage.setPlan(stored));
      }
      render();
    },
    refresh() { if (!destroyed) { bind.refresh(); render(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of removers) attempt(() => off());
      bind.clear();
      root.remove();
    },
  });
}
