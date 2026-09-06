// P3-29: the usage and cost-estimate model (design-p3 §1.13). Its job is to be
// honest about what is not known, so most of this suite is about the refusals:
// no cost shown as zero, no whole-run total from a partial price list, no
// double counting on a reconnect, and no rate rewritten by a later price list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ESTIMATE_STATES, MINUTE_MS, USAGE_SCOPES, createUsage, findRate } from '../app/engine/usage.js';
import { MINUTES, createClock, pricing, rate } from './fixtures/usage.mjs';

const live = { id: 's1', capability: 'live', model: 'gemini-3.1-flash-live-preview' };

test('Free shows time and no cost at all', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing() });
  usage.begin(live);
  clock.advance(2 * MINUTES);
  usage.end('s1');
  const state = usage.snapshot();
  assert.equal(state.activeMs, 2 * MINUTES);
  assert.equal(state.byCapability.live, 2 * MINUTES);
  assert.equal(state.estimate.state, 'free');
  assert.equal(state.estimate.amount, null, 'Free never shows a cost, not even a computed one');
  assert.deepEqual([...ESTIMATE_STATES], ['free', 'estimated', 'partial', 'unavailable']);
  assert.equal(MINUTE_MS, 60000);
  usage.close();
});

test('Paid estimates from active minutes, and says which revision it used', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing(), plan: 'paid' });
  usage.begin(live);
  clock.advance(90000); // 1.5 minutes
  usage.end('s1');
  const estimate = usage.snapshot().estimate;
  assert.equal(estimate.state, 'estimated');
  assert.equal(estimate.amount, 0.9, '1.5 active minutes at 0.6 per minute');
  assert.equal(estimate.currency, 'USD');
  assert.equal(estimate.revision, 3, 'the price list revision is reported with the number');
  assert.equal(estimate.unestimableMs, 0);
  usage.close();
});

test('an unpriced model is "cannot estimate", never zero, and a partial list is not a total', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing(), plan: 'paid' });
  // Only the live model is priced; the sequential one is not.
  usage.begin({ id: 'a', capability: 'translate', model: 'gemini-3.5-flash' });
  clock.advance(MINUTES);
  usage.end('a');
  let estimate = usage.snapshot().estimate;
  assert.equal(estimate.state, 'unavailable', 'nothing priced means nothing to show');
  assert.equal(estimate.amount, null, 'an unknown cost is never zero');
  assert.equal(estimate.unestimableMs, MINUTES);
  assert.deepEqual(estimate.models, { 'gemini-3.5-flash': 'unrated' });

  usage.begin(live);
  clock.advance(MINUTES);
  usage.end('s1');
  estimate = usage.snapshot().estimate;
  assert.equal(estimate.state, 'partial', 'a partial price list yields the estimable part, not a whole-run total');
  assert.equal(estimate.amount, 0.6);
  assert.equal(estimate.estimableMs, MINUTES);
  assert.equal(estimate.unestimableMs, MINUTES);
  assert.deepEqual(estimate.models, { 'gemini-3.5-flash': 'unrated', 'gemini-3.1-flash-live-preview': 'rated' });
  usage.close();
});

test('a rate this build does not understand is no rate', () => {
  const table = pricing({ rates: [rate({ unit: 'token' }), rate({ model: 'other-model', basis: 'perRequest' })] });
  assert.equal(findRate(table, live), null, 'an unknown unit is not assumed to be per-minute');
  assert.equal(findRate(table, { model: 'other-model', capability: 'live' }), null, 'an unknown basis is not assumed');
  assert.equal(findRate(pricing({ rates: [rate({ amount: Number.NaN })] }), live), null);
  assert.equal(findRate(null, live), null);
  assert.equal(findRate(pricing(), { model: 'nope', capability: 'live' }), null);
  const found = findRate(pricing(), live);
  assert.equal(found.amount, 0.6);
  assert.equal(found.basis, 'activeMinuteEstimate');
});

test('a price list published later never rewrites usage that already happened', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing(), plan: 'paid' });
  usage.begin(live);
  clock.advance(MINUTES);
  usage.end('s1');
  assert.equal(usage.snapshot().estimate.amount, 0.6);

  // The operator doubles the estimate; the finished span keeps its own rate.
  usage.setPricing(pricing({ revision: 4, rates: [rate({ amount: 1.2 })] }));
  assert.equal(usage.snapshot().estimate.amount, 0.6, 'the ended span keeps the rate it ended on');

  usage.begin({ ...live, id: 's2' });
  clock.advance(MINUTES);
  usage.end('s2');
  assert.equal(usage.snapshot().estimate.amount, 1.8, 'the new span uses the new rate');
  usage.close();
});

test('a reconnect, a repeated end and a post-stop callback never add time twice', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing(), plan: 'paid' });
  usage.begin(live);
  clock.advance(MINUTES);
  // A reconnect calls begin again with the same id: the span keeps running.
  usage.begin(live);
  clock.advance(MINUTES);
  assert.equal(usage.snapshot().spans, 0, 'nothing is counted until the span ends');

  usage.end('s1');
  assert.equal(usage.snapshot().activeMs, 2 * MINUTES);
  // A duplicate end, an unknown id and an end after close change nothing.
  assert.equal(usage.end('s1'), null);
  assert.equal(usage.end('never-started'), null);
  assert.equal(usage.snapshot().activeMs, 2 * MINUTES);
  usage.close();
  assert.equal(usage.end('s1'), null);
});

test('hub listening is measured but never priced, and scopes are not summed', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing({ rates: [rate({ capability: 'live' }),
    rate({ capability: 'hubListen', amount: 5 })] }), plan: 'paid' });
  usage.begin({ id: 'hub', capability: 'hubListen', model: 'gemini-3.1-flash-live-preview', billable: false });
  clock.advance(10 * MINUTES);
  usage.end('hub');
  let state = usage.snapshot();
  assert.equal(state.activeMs, 10 * MINUTES, 'the time is still measured');
  assert.equal(state.estimate.amount, null, 'an audience is not charged for a broadcast');
  assert.equal(state.estimate.estimableMs, 0);
  assert.equal(state.estimate.unestimableMs, 0, 'unbillable time is not "cannot estimate" either');

  // A personal key and a shared event key are reported apart.
  usage.begin({ ...live, id: 'p', scope: 'personal' });
  clock.advance(MINUTES);
  usage.end('p');
  usage.begin({ ...live, id: 'e', scope: 'shared' });
  clock.advance(MINUTES);
  usage.end('e');
  assert.deepEqual([...USAGE_SCOPES], ['personal', 'shared']);
  assert.equal(usage.spansOf('personal').length, 2, 'the hub span is personal scope by default');
  assert.equal(usage.spansOf('shared').length, 1);
  assert.equal(usage.spansOf('shared')[0].id, 'e');
  usage.close();
});

test('spans carry an id, a capability and a model — never a key, a transcript or audio', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing() });
  usage.begin({ ...live, text: 'SECRET transcript', key: 'SECRET-KEY', audio: new Uint8Array(4) });
  clock.advance(1000);
  const span = usage.end('s1');
  assert.deepEqual(Object.keys(span).sort(),
    ['billable', 'capability', 'durationMs', 'endedAt', 'failed', 'id', 'model', 'rate', 'scope', 'startedAt']);
  assert.equal(JSON.stringify(usage.snapshot()).includes('SECRET'), false);
  // A malformed span is refused rather than recorded under a made-up name.
  assert.equal(usage.begin({ id: 'x y', capability: 'live', model: 'm' }), null);
  assert.equal(usage.begin({ id: 'ok', capability: 'live' }), null);
  assert.equal(usage.begin({}), null);
  usage.close();
});

test('a failed call is still time spent, and the plan switch only changes what is shown', () => {
  const clock = createClock();
  const usage = createUsage({ now: clock.now, pricing: pricing() });
  usage.begin(live);
  clock.advance(MINUTES);
  const span = usage.end('s1', { failed: true });
  assert.equal(span.failed, true);
  assert.equal(usage.snapshot().activeMs, MINUTES, 'a failed call still used the provider');
  assert.equal(usage.snapshot().estimate.state, 'free');

  usage.setPlan('paid');
  assert.equal(usage.snapshot().estimate.state, 'estimated', 'the same spans, now priced');
  assert.equal(usage.snapshot().estimate.amount, 0.6);
  usage.setPlan('free');
  assert.equal(usage.snapshot().estimate.amount, null);
  usage.reset();
  assert.equal(usage.snapshot().activeMs, 0);
  usage.close();
});
