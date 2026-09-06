// P3-31: the plan, usage and rate section (design-p3 §1.13). The sentence this
// screen must never imply is that choosing Paid switches Google billing on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLANS, createBillingView, estimateKey, minutesOf } from '../app/ui/billing-view.js';
import { createUsage } from '../app/engine/usage.js';
import { createI18n } from '../app/i18n/index.js';
import { FakeElement, all, byClass } from './fixtures/scenarios.mjs';
import { MINUTES, createClock, pricing, rate } from './fixtures/usage.mjs';

const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async (lang) =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));
const ko = dictionaries.ko;
const live = { id: 's1', capability: 'live', model: 'gemini-3.1-flash-live-preview' };

function policyDouble(table = pricing()) {
  const listeners = new Set();
  let value = { policy: { pricing: table } };
  return {
    snapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = { policy: { pricing: next } }; for (const fn of [...listeners]) fn(value); },
  };
}
function fixture({ table = pricing(), plan = 'free', preferences = null } = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeElement(doc, tag) };
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: table, plan });
  const i18n = createI18n({ dictionaries, language: 'ko' });
  const policy = policyDouble(table);
  const view = createBillingView({ usage, i18n, document: doc, policy, preferences, providerId: 'gemini' });
  return { doc, clock, usage, i18n, policy, view, el: (name) => byClass(view.element, name) };
}
const spend = (f, ms, span = live) => { f.usage.begin(span); f.clock.advance(ms); f.usage.end(span.id); };

test('Free shows time and no cost section at all', () => {
  const f = fixture();
  spend(f, 2 * MINUTES);
  assert.deepEqual([...PLANS], ['free', 'paid']);
  assert.equal(f.view.elements.planSelect.value, 'free');
  assert.equal(f.el('billing-cost').hidden, true, 'Free shows no cost, not even a computed one');
  assert.ok(f.el('billing-usage').textContent.includes(ko['billing.usageTime']));
  assert.ok(f.el('billing-usage').textContent.includes('2'));
  f.view.destroy();
});

test('choosing Paid is stated as a display setting, never as enabling Google billing', () => {
  const f = fixture();
  // The disclaimer sits next to the control, not buried at the bottom.
  assert.equal(f.el('billing-display-only').textContent, ko['billing.displayOnly']);
  const text = all(f.view.element, () => true).map((node) => node.textContent).join(' ');
  for (const key of ['billing.mayDiffer', 'billing.perProvider']) assert.ok(text.includes(ko[key]), key);
  f.view.destroy();
});

test('Paid shows the estimate, its scope, the rate source and the verified date', () => {
  const f = fixture({ plan: 'paid' });
  spend(f, 90000);
  assert.equal(f.el('billing-cost').hidden, false);
  assert.equal(f.el('billing-estimate').textContent, `${ko['billing.estimate.complete']}: USD 0.9`);
  assert.ok(f.el('billing-rate-source').textContent.includes(ko['billing.rateSource.policy']));
  assert.ok(f.el('billing-rate-source').textContent.includes('3'), 'the price list revision is named');
  assert.equal(f.el('billing-rate-verified').textContent, ko['billing.verifiedAt'].replace('{date}', '2026-09-01'));
  assert.equal(f.el('billing-rate-missing').hidden, true);
  // The estimate is always labelled as one.
  const text = all(f.el('billing-cost'), () => true).map((node) => node.textContent).join(' ');
  for (const key of ['billing.estimateAlways', 'billing.formula', 'billing.notZero', 'billing.rateFixed',
    'billing.noDoubleCount', 'billing.hubExcluded', 'billing.sharedExcluded', 'billing.tokenNotIncluded']) {
    assert.ok(text.includes(ko[key]), key);
  }
  f.view.destroy();
});

test('an unpriced model is "cannot estimate" with no number, and a partial run says so', () => {
  const f = fixture({ plan: 'paid' });
  spend(f, MINUTES, { id: 'a', capability: 'translate', model: 'gemini-3.5-flash' });
  assert.equal(f.el('billing-estimate').textContent, ko['billing.estimate.unavailable']);
  assert.equal(/\d/.test(f.el('billing-estimate').textContent), false, 'no number at all, and never a zero');
  assert.equal(f.el('billing-rate-missing').hidden, false);

  spend(f, MINUTES);
  assert.ok(f.el('billing-estimate').textContent.startsWith(ko['billing.estimate.partial']),
    'a partial price list is labelled as the estimable part, not a total');
  assert.equal(f.el('billing-rate-missing').hidden, false);
  assert.equal(estimateKey('estimated'), 'billing.estimate.complete');
  assert.equal(estimateKey('free'), null);
  f.view.destroy();
});

test('a personal rate is offered only where the policy allows it', () => {
  const f = fixture({ table: pricing({ allowLocalOverride: false }) });
  assert.equal(f.el('billing-local-rate').hidden, true);
  assert.equal(f.view.elements.localInput.disabled, true);
  f.policy.set(pricing({ allowLocalOverride: true }));
  assert.equal(f.el('billing-local-rate').hidden, false);
  assert.equal(f.view.elements.localInput.disabled, false);
  f.view.destroy();
});

test('the plan is stored per provider and a key change asks for it to be confirmed', () => {
  const map = new Map();
  const preferences = { get: (name) => map.get(name) ?? null, set: (name, value) => { map.set(name, value); return { ok: true }; } };
  const f = fixture({ preferences });
  f.view.elements.planSelect.value = 'paid';
  f.view.elements.planSelect.dispatch('change');
  assert.equal(map.get('billing.plan'), 'paid');
  assert.equal(f.usage.plan, 'paid');

  // A restored provider brings its own stored choice back.
  f.usage.setPlan('free');
  f.view.setProvider('gemini');
  assert.equal(f.usage.plan, 'paid');

  // A key change is a reason to re-check the display, not to change it.
  assert.equal(f.el('billing-key-changed').hidden, true);
  f.view.noteKeyChange(1);
  assert.equal(f.el('billing-key-changed').hidden, true, 'the first generation is the baseline');
  f.view.noteKeyChange(2);
  assert.equal(f.el('billing-key-changed').hidden, false);
  assert.equal(f.el('billing-key-changed').textContent, ko['billing.keyChanged']);
  assert.equal(f.usage.plan, 'paid', 'a key change never changes the plan by itself');
  f.view.destroy();
});

test('minutes are rounded for display without turning a short call into nothing', () => {
  assert.equal(minutesOf(0), 0);
  assert.equal(minutesOf(-5), 0);
  assert.equal(minutesOf(1000), 0.1, 'a one-second call is not shown as zero minutes');
  assert.equal(minutesOf(90000), 1.5);
  assert.equal(minutesOf(Number.NaN), 0);
});

test('the section is mounted by main.js and torn down with it', async () => {
  const source = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(source, /billingView = createBillingView\(\{ usage, i18n, document: doc, preferences/);
  assert.match(source, /settingsView\.elements\.billingControls\.append\(billingView\.element\)/);
  assert.match(source, /billingView\?\.destroy\(\)/);
  assert.match(source, /billingView\.noteKeyChange/);
  assert.throws(() => createBillingView({}), { message: 'INVALID_REQUEST' });
});
