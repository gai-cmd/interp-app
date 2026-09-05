import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveRecovery } from '../app/engine/live-recovery.js';
import { ProviderError } from '../app/providers/contract.js';
import { resolveGeminiLiveFallback } from '../app/providers/gemini/index.js';
import { LIVE_MODELS } from '../app/providers/gemini/live-config.js';
import { createClock } from './fixtures/live.mjs';

const error = (code) => new ProviderError(code);
const code = (expected) => (e) => e.code === expected && !JSON.stringify(e).includes('SECRET');
function harness() {
  const clock = createClock(), controller = new AbortController();
  let time = 0;
  const recovery = createLiveRecovery({ ...clock, now: () => time, random: () => 0 });
  const advance = (ms) => { time += ms; clock.advance(ms); };
  const consume = () => recovery.budget.consume({ providerId: 'gemini', keySource: 'personal', signal: controller.signal });
  const wait = async (value = error('NETWORK_ERROR'), options = {}, delay = 10000) => {
    const pending = recovery.wait(value, { signal: controller.signal, closed: true, ...options });
    advance(delay);
    return pending;
  };
  return { recovery, clock, controller, advance, consume, wait };
}

test('initial plus three connections share budget across fallback, goAway and disconnect', async () => {
  const h = harness(), budget = h.recovery.budget;
  let request = { input: { format: 'pcm16' }, targetLanguage: 'ko' };
  h.consume();
  request = await h.wait(error('MODEL_UNSUPPORTED'), { request, resolveFallback: resolveGeminiLiveFallback });
  assert.equal(request.model, LIVE_MODELS[1]); h.consume(); h.recovery.opened();
  const same = await h.wait(undefined, { request, goAway: true, resolveFallback() { assert.fail('goAway must retain model'); } });
  assert.equal(same, request); h.consume(); h.recovery.opened();
  request = await h.wait(error('UNAVAILABLE'), { request, resolveFallback: resolveGeminiLiveFallback });
  assert.equal(request.model, LIVE_MODELS[2]); h.consume();
  assert.equal(budget, h.recovery.budget);
  assert.equal(budget.used, 4);
  assert.equal(h.recovery.retries, 3);
  await assert.rejects(h.wait(error('NETWORK_ERROR')), code('BUDGET_EXHAUSTED'));
  assert.equal(h.clock.size, 0);
});

test('all reconnects wait 1/2/4 seconds and cannot open before wait completes', async () => {
  const h = harness(); h.consume();
  for (const delay of [1000, 2000, 4000]) {
    const pending = h.recovery.wait(error('SESSION_CLOSED'), { closed: true, signal: h.controller.signal });
    assert.throws(h.consume, code('BUDGET_EXHAUSTED'));
    h.advance(delay - 1);
    assert.equal(h.clock.size, 1);
    h.advance(1); await pending; h.consume(); h.recovery.opened();
  }
});

test('server wait takes priority and cancellation clears timer without exposing reason', async () => {
  const h = harness(); h.consume();
  const limited = error('RATE_LIMITED'); limited.retryAfterMs = 9000;
  const pending = h.recovery.wait(limited, { closed: true, signal: h.controller.signal });
  h.advance(8999);
  assert.equal(h.clock.size, 1);
  h.controller.abort('SECRET');
  await assert.rejects(pending, code('ABORTED'));
  assert.equal(h.clock.size, 0);
  assert.throws(h.consume, code('ABORTED'));
});

test('only sixty seconds of useful continuous operation resets the window', async () => {
  const h = harness(); h.consume();
  for (let i = 0; i < 3; i++) {
    await h.wait(); h.consume(); h.recovery.opened();
  }
  h.advance(60000);
  await assert.rejects(h.wait(), code('BUDGET_EXHAUSTED'));
  h.recovery.activity(); h.advance(59999);
  // Do not report a disconnect until the boundary: the stable interval is continuous.
  assert.equal(h.recovery.budget.remaining, 0);
  h.advance(1);
  await h.wait(); h.consume();
  assert.equal(h.recovery.budget.used, 2);
  assert.equal(h.recovery.retries, 1);
  await h.wait(); h.consume();
  await h.wait(); h.consume();
  await assert.rejects(h.wait(), code('BUDGET_EXHAUSTED'));
});

test('short setup success never resets, and explicit user restart permits a fresh initial open', async () => {
  const h = harness(); h.consume();
  for (let i = 0; i < 3; i++) {
    h.recovery.opened(); h.recovery.activity(); h.advance(59999);
    await h.wait(); h.consume();
  }
  h.recovery.opened(); h.recovery.activity(); h.advance(59999);
  await assert.rejects(h.wait(), code('BUDGET_EXHAUSTED'));
  h.recovery.restart(); h.consume();
  assert.equal(h.recovery.budget.used, 1);
  assert.equal(h.recovery.retries, 0);
});

test('fatal errors and unconfirmed close never authorize another connection', async () => {
  for (const value of ['INVALID_KEY', 'PERMISSION_DENIED', 'IP_DENIED', 'DAILY_LIMIT',
    'UNKNOWN_429', 'TOKEN_LIMIT', 'SAFETY_BLOCKED', 'PROVIDER_ERROR', 'ABORTED']) {
    const h = harness(); h.consume();
    await assert.rejects(h.wait(error(value), { resolveFallback() { assert.fail('fatal fallback'); } }), code(value));
    assert.equal(h.clock.size, 0);
    assert.equal(h.recovery.budget.used, 1);
    assert.throws(h.consume, code('BUDGET_EXHAUSTED'));
  }
  const h = harness(); h.consume();
  await assert.rejects(h.wait(error('SESSION_LIMIT'), { closed: false }), code('SESSION_LIMIT'));
  assert.equal(h.clock.size, 0);
  await h.wait(error('SESSION_LIMIT')); h.consume();
});

test('overlapping recovery and credential switching fail closed', async () => {
  const h = harness(); h.consume();
  const pending = h.recovery.wait(error('NETWORK_ERROR'), { closed: true, signal: h.controller.signal });
  await assert.rejects(h.recovery.wait(error('NETWORK_ERROR'), { closed: true }), code('INVALID_REQUEST'));
  assert.throws(() => h.recovery.restart(), code('INVALID_REQUEST'));
  h.advance(1000); await pending;
  assert.throws(() => h.recovery.budget.consume({ providerId: 'gemini', keySource: 'shared' }), code('CREDENTIAL_MISMATCH'));
  h.consume();
});

test('shared jitter tool applies to planned goAway replacement too', async () => {
  const clock = createClock();
  const recovery = createLiveRecovery({ ...clock, random: () => 1 });
  recovery.budget.consume({ providerId: 'gemini', keySource: 'personal' });
  const pending = recovery.wait(undefined, { closed: true, goAway: true });
  clock.advance(1249); assert.equal(clock.size, 1);
  clock.advance(1); await pending;
  assert.equal(clock.size, 0);
});
