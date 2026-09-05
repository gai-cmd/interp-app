import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, createRetryExecutor, createLiveRetryPolicy, waitForRetry, withDeadline } from '../app/engine/retry.js';
import { normalizeGeminiError } from '../app/providers/gemini/errors.js';
import { ProviderError } from '../app/providers/contract.js';
import { createRouter } from '../app/providers/router.js';
import { createRegistry } from '../app/providers/registry.js';
import { provider, adapter, context, credentialRef, textRequest } from './fixtures/providers.mjs';

const error = (code) => new ProviderError(code);
const instant = { random: () => 0, setTimeout(fn) { return setTimeout(fn, 0); }, clearTimeout };
const code = (value) => (e) => e.code === value && !JSON.stringify(e).includes('SECRET');

test('router shares three calls across STT, translation and model/settings fallback', async () => {
  const calls = [];
  const methods = adapter(calls);
  methods.translate = async (...args) => { calls.push(args); throw error('SETTINGS_UNSUPPORTED'); };
  const registry = createRegistry();
  registry.register(provider(), methods);
  const router = createRouter({ registry, getCredentialRef: credentialRef });
  const executor = createRetryExecutor({ call: router.call, context: context(), ...instant });
  await executor.run('stt', { input: { format: 'wav', audio: new Uint8Array() } });
  await assert.rejects(executor.run('translate', textRequest(), { resolveFallback: (_, request) => ({ ...request, model: 'test-model' }) }), code('SETTINGS_UNSUPPORTED'));
  assert.equal(calls.length, 3);
  assert.equal(executor.budget.used, 3);
  await assert.rejects(executor.run('translate', textRequest()), code('BUDGET_EXHAUSTED'));
});

test('translation model cascade stops at two models and voice cannot be replayed', async () => {
  let count = 0;
  const executor = createRetryExecutor({ context: context(), ...instant,
    call: async (_, req, ctx) => { ctx.budget.consume(ctx); count++; throw error('INVALID_RESULT'); } });
  await assert.rejects(executor.run('translate', { model: 'one' }, { resolveFallback: () => ({ model: `model-${count}` }) }), code('BUDGET_EXHAUSTED'));
  assert.equal(count, 2);
  await assert.rejects(executor.run('voice', {}), code('INVALID_REQUEST'));
});

test('terminal errors never retry or invoke fallback, including unknown 429', async () => {
  for (const value of ['UNKNOWN_429', 'DAILY_LIMIT', 'INVALID_KEY', 'PERMISSION_DENIED', 'IP_DENIED', 'SAFETY_BLOCKED', 'TOKEN_LIMIT', 'SESSION_LIMIT']) {
    let calls = 0;
    const executor = createRetryExecutor({ context: context(), ...instant, call: async (_, req, ctx) => {
      ctx.budget.consume(ctx); calls++; throw error(value);
    } });
    await assert.rejects(executor.run('translate', {}, { resolveFallback() { assert.fail(); } }), code(value));
    assert.equal(calls, 1);
  }
});

test('budget rejects provider/key-source switches and does not charge cancellation', () => {
  const budget = createBudget();
  budget.consume({ providerId: 'alpha', keySource: 'personal' });
  assert.throws(() => budget.consume({ providerId: 'beta', keySource: 'personal' }), code('CREDENTIAL_MISMATCH'));
  assert.throws(() => budget.consume({ providerId: 'alpha', keySource: 'shared' }), code('CREDENTIAL_MISMATCH'));
  assert.throws(() => budget.consume({ signal: AbortSignal.abort('SECRET') }), code('ABORTED'));
  assert.equal(budget.used, 1);
});

test('server delay wins; cancellation clears retry timers and secrets', async () => {
  const timers = new Map();
  const controller = new AbortController();
  const policy = createLiveRetryPolicy({ random: () => 0, setTimeout(fn, ms) { timers.set(1, { fn, ms }); return 1; }, clearTimeout(id) { timers.delete(id); } });
  const pending = policy.wait(Object.assign(error('RATE_LIMITED'), { retryAfterMs: 9000 }), { closed: true, signal: controller.signal });
  assert.equal(timers.get(1).ms, 9000);
  controller.abort('SECRET');
  await assert.rejects(pending, code('ABORTED'));
  assert.equal(timers.size, 0);
  await assert.rejects(waitForRetry(1, { signal: controller.signal }), code('ABORTED'));
});

test('Live permits three reconnects; socket open and key changes do not reset them', async () => {
  let now = 0;
  const policy = createLiveRetryPolicy({ ...instant, now: () => now });
  const options = { closed: true };
  for (let i = 0; i < 3; i++) { policy.opened(); await policy.wait(error('UNAVAILABLE'), options); }
  await assert.rejects(policy.wait(error('UNAVAILABLE'), options), code('BUDGET_EXHAUSTED'));
  policy.opened(); policy.activity(); now = 60000;
  await policy.wait(error('UNAVAILABLE'), options);
  assert.equal(policy.retries, 1);
  policy.restart(); assert.equal(policy.retries, 0);
  await assert.rejects(policy.wait(error('SESSION_LIMIT'), { closed: false }), code('SESSION_LIMIT'));
});

test('deadline aborts ignored work and cleans timers', async () => {
  let signal;
  await assert.rejects(withDeadline((s) => { signal = s; return new Promise(() => {}); }, { timeoutMs: 5 }), code('TIMEOUT'));
  assert.equal(signal.aborted, true);
});

test('Gemini structured normalization is conservative and secret-free', () => {
  const detail = (type, fields) => ({ '@type': `type.googleapis.com/google.rpc.${type}`, ...fields });
  assert.equal(normalizeGeminiError({ status: 429, error: { message: 'daily SECRET' } }).code, 'UNKNOWN_429');
  for (const [quotaId, expected] of [['RequestsPerDay', 'DAILY_LIMIT'], ['RequestsPerMinute', 'RATE_LIMITED'], ['ConcurrentSessions', 'SESSION_LIMIT'], ['InputTokens', 'TOKEN_LIMIT']]) {
    assert.equal(normalizeGeminiError({ status: 429, error: { details: [detail('QuotaFailure', { violations: [{ quotaId }] })] } }).code, expected);
  }
  const result = normalizeGeminiError({ status: 503, headers: { 'retry-after': '7' }, error: { message: 'SECRET', details: [detail('RetryInfo', { retryDelay: '9.5s' })] } });
  assert.equal(result.retryAfterMs, 9500);
  assert.equal(result.code, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(normalizeGeminiError({ status: 403, error: { message: 'IP SECRET' } }).code, 'PERMISSION_DENIED');
  assert.equal(normalizeGeminiError({ status: 400, error: { details: [detail('ErrorInfo', { reason: 'API_KEY_INVALID' })] } }).code, 'INVALID_KEY');
  assert.equal(normalizeGeminiError({ status: 503, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:10 GMT' } }, { now: () => 0 }).retryAfterMs, 10000);
});

test('executor cancellation during backoff prevents all later calls and clears timers', async () => {
  const controller = new AbortController();
  const timers = new Map();
  let id = 0, calls = 0;
  const executor = createRetryExecutor({ context: context({ signal: controller.signal }), random: () => 0,
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    async call(_, request, ctx) { ctx.budget.consume(ctx); calls++; throw error('UNAVAILABLE'); } });
  const pending = executor.run('translate', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 1000);
  controller.abort('SECRET');
  await assert.rejects(pending, code('ABORTED'));
  assert.equal(timers.size, 0);
  assert.equal(calls, 1);
});

test('Live delays are 1, 2, 4 seconds with positive jitter; unknown 429 does not wait', async () => {
  const waits = [];
  const policy = createLiveRetryPolicy({ random: () => 1,
    setTimeout(fn, ms) { waits.push(ms); return setTimeout(fn, 0); }, clearTimeout });
  for (let i = 0; i < 3; i++) await policy.wait(error('UNAVAILABLE'), { closed: true });
  assert.deepEqual(waits, [1250, 2500, 5000]);
  policy.restart();
  await assert.rejects(policy.wait(error('UNKNOWN_429'), { closed: true }), code('UNKNOWN_429'));
  assert.equal(waits.length, 3);
});

test('long server waits are chunked without shortening the requested interval', async () => {
  const waits = [];
  await waitForRetry(2147483647 + 5000, {
    setTimeout(fn, ms) { waits.push(ms); return setTimeout(fn, 0); }, clearTimeout,
  });
  assert.deepEqual(waits, [2147483647, 5000]);
});
