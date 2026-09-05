import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { ProviderError, normalizeError } from '../app/providers/contract.js';
import { provider, adapter, context, textRequest, credentialRef, deferred } from './fixtures/providers.mjs';

function setup(definition = provider(), implementation = adapter(), options = {}) {
  const registry = createRegistry();
  registry.register(definition, implementation);
  const router = createRouter({ registry, getCredentialRef: credentialRef, ...options });
  return { registry, router };
}
const code = (expected) => (error) => {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, expected);
  return true;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('registry starts empty, snapshots policy, rejects duplicate or incomplete registrations', () => {
  assert.deepEqual(createRegistry().list(), []);
  const definition = provider();
  const { registry } = setup(definition);
  definition.capabilities.translate.transports.push('hub');
  definition.credentialPolicy.directShared = false;
  assert.deepEqual(registry.get('alpha').descriptor.capabilities.translate.transports, ['direct']);
  assert.equal(registry.list()[0].credentialPolicy.directShared, true);
  assert.ok(Object.isFrozen(registry.list()[0].capabilities.translate));
  assert.equal(registry.list()[0].connectionStatus, undefined);
  assert.throws(() => registry.register(provider(), adapter()), code('DUPLICATE_PROVIDER'));
  assert.throws(() => registry.get('absent'), code('UNKNOWN_PROVIDER'));
  for (const modify of [
    (p) => { delete p.capabilities.stt; },
    (p) => { p.capabilities.translate.inputFormats = ['wav']; },
    (p) => { p.capabilities.translate.implementation = 'available'; },
    (p) => { p.capabilities.translate.transports = ['anything']; },
    (p) => { p.endpoints = ['http://example.invalid']; },
    (p) => { p.endpoints = ['https://example.invalid?key=TEST_SECRET']; },
    (p) => { p.label = 'Hardcoded label'; },
    (p) => { p.fallbackPolicy.translate = [{ providerId: 'beta' }]; },
    (p) => { p.fallbackPolicy.translate = [{ model: 'test-model', on: ['SAFETY_BLOCKED'], condition: 'automatic' }]; },
  ]) {
    const invalid = provider(); modify(invalid);
    assert.throws(() => createRegistry().register(invalid, adapter()), code('INVALID_PROVIDER'));
  }
  assert.throws(() => createRegistry().register(provider(), {}), code('INVALID_PROVIDER'));
});

test('browserDirect true does not grant planned, unsupported or undeclared input capabilities', async () => {
  const calls = [], lookups = [];
  const definition = provider();
  definition.capabilities.stt.implementation = 'unsupported';
  const { router } = setup(definition, adapter(calls), { getCredentialRef(address) { lookups.push(address); return credentialRef(address); } });
  for (const [name, expected] of [['live', 'CAPABILITY_UNIMPLEMENTED'], ['stt', 'CAPABILITY_UNSUPPORTED'], ['unknown', 'CAPABILITY_UNSUPPORTED']]) {
    await assert.rejects(router.call(name, textRequest(), context()), code(expected));
  }
  await assert.rejects(router.call('translate', { input: { format: 'wav' } }, context()), code('INPUT_UNSUPPORTED'));
  assert.equal(calls.length, 0);
  assert.equal(lookups.length, 0);
});

test('provider-wide and per-capability hub restrictions make zero direct calls or key lookups', async () => {
  for (const providerWide of [true, false]) {
    const definition = provider();
    if (providerWide) definition.browserDirect = false;
    else definition.capabilities.translate.transports = ['hub'];
    const calls = [], lookups = [];
    const { router } = setup(definition, adapter(calls), { getCredentialRef(address) { lookups.push(address); return credentialRef(address); } });
    await assert.rejects(router.call('translate', textRequest(), context()), code('HUB_REQUIRED'));
    if (!providerWide) await assert.rejects(router.call('translate', textRequest(), context({ transport: 'hub', keySource: 'hub' })), code('HUB_REQUIRED'));
    assert.equal(calls.length, 0);
    assert.equal(lookups.length, 0);
  }
});

test('explicit verified hub injection uses only hub reference and never a direct adapter', async () => {
  const definition = provider();
  definition.browserDirect = false;
  definition.capabilities.translate.transports = ['hub'];
  definition.credentialPolicy.hubManaged = true;
  const direct = [], hubCalls = [], lookups = [];
  const { router } = setup(definition, adapter(direct), {
    getCredentialRef(address) { lookups.push(address); return { ...address, reference: 'TEST_HUB_REFERENCE' }; },
    hub: { async call(...args) { hubCalls.push(args); return { status: 'ok' }; } },
  });
  await router.call('translate', textRequest(), context({ transport: 'hub', keySource: 'hub' }));
  assert.deepEqual(lookups, [{ providerId: 'alpha', keySource: 'hub', transport: 'hub' }]);
  assert.equal(hubCalls[0][2].credentialRef, 'TEST_HUB_REFERENCE');
  assert.equal(direct.length, 0);
  await assert.rejects(router.call('translate', textRequest(), context({ transport: 'hub' })), code('CREDENTIAL_FORBIDDEN'));
  await assert.rejects(router.call('translate', textRequest(), context()), code('HUB_REQUIRED'));
  assert.equal(hubCalls.length, 1);
});

test('credentials are isolated by provider, source and transport; caller overrides are ignored', async () => {
  const calls = [], lookups = [];
  const { registry, router } = setup(provider(), adapter(calls), {
    getCredentialRef(address) {
      lookups.push(address);
      return { ...address, reference: `${address.providerId}:${address.keySource}` };
    },
  });
  registry.register(provider('beta'), adapter(calls));
  for (const providerId of ['alpha', 'beta']) for (const keySource of ['personal', 'shared']) {
    await router.call('translate', { ...textRequest(), endpoint: 'TEST_SECRET', credential: 'TEST_SECRET' },
      context({ providerId, keySource, credentialRef: 'TEST_WRONG_REFERENCE' }));
    const last = calls.at(-1);
    assert.equal(last.context.credentialRef, `${providerId}:${keySource}`);
    assert.equal(last.request.endpoint, undefined);
    assert.equal(last.request.credential, undefined);
  }
  assert.equal(lookups.length, 4);
  for (const mismatch of [{ providerId: 'beta' }, { keySource: 'shared' }, { transport: 'hub' }]) {
    const { router: invalid } = setup(provider(), adapter(), { getCredentialRef: (address) => ({ ...credentialRef(address), ...mismatch }) });
    await assert.rejects(invalid.call('translate', textRequest(), context()), code('CREDENTIAL_MISMATCH'));
  }
});

test('missing/forbidden credentials do not fall back to another source or provider', async () => {
  const calls = [];
  const definition = provider(); definition.credentialPolicy.directShared = false;
  const { router } = setup(definition, adapter(calls), { getCredentialRef: () => null });
  await assert.rejects(router.call('translate', textRequest(), context()), code('CREDENTIAL_REQUIRED'));
  await assert.rejects(router.call('translate', textRequest(), context({ keySource: 'shared' })), code('CREDENTIAL_FORBIDDEN'));
  await assert.rejects(router.call('translate', textRequest(), context({ keySource: 'hub' })), code('CREDENTIAL_FORBIDDEN'));
  assert.equal(calls.length, 0);
});

test('STT and translation charge the same budget; no retry or fallback is hidden in router', async () => {
  let remaining = 2;
  const budget = { consume() { if (!remaining) throw new ProviderError('BUDGET_EXHAUSTED'); remaining--; } };
  const calls = [];
  const { router } = setup(provider(), adapter(calls));
  await router.call('stt', { input: { format: 'wav', audio: new Uint8Array() } }, context({ budget }));
  await router.call('translate', textRequest(), context({ budget }));
  await assert.rejects(router.call('translate', textRequest(), context({ budget })), code('BUDGET_EXHAUSTED'));
  await assert.rejects(router.call('translate', textRequest(), context({ budget: null })), code('BUDGET_REQUIRED'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.budget, budget);
  assert.equal(calls[1].context.budget, budget);
});

test('abort before call or during reference lookup prevents invocation and budget consumption', async () => {
  for (const preAborted of [true, false]) {
    const abort = new AbortController(), pending = deferred(), started = deferred();
    const calls = []; let charges = 0, lookupSignal;
    const { router } = setup(provider(), adapter(calls), {
      getCredentialRef(address, { signal }) { lookupSignal = signal; started.resolve(); return pending.promise.then(() => credentialRef(address)); },
    });
    if (preAborted) abort.abort('TEST_SECRET');
    const operation = router.call('translate', textRequest(), context({ signal: abort.signal, budget: { consume() { charges++; } } }));
    const rejection = assert.rejects(operation, code('ABORTED'));
    if (!preAborted) { await started.promise; abort.abort('TEST_SECRET'); }
    await rejection;
    pending.resolve(); await tick();
    if (!preAborted) assert.equal(lookupSignal.aborted, true);
    assert.equal(calls.length, 0); assert.equal(charges, 0);
  }
});

test('abort propagates to finite adapter and discards its late result or error', async () => {
  for (const failure of [false, true]) {
    const abort = new AbortController(), pending = deferred(), started = deferred();
    let adapterContext;
    const implementation = adapter();
    implementation.translate = (_request, ctx) => { adapterContext = ctx; started.resolve(); return pending.promise; };
    const { router } = setup(provider(), implementation);
    const operation = router.call('translate', textRequest(), context({ signal: abort.signal }));
    const rejection = assert.rejects(operation, code('ABORTED'));
    await started.promise; abort.abort(new Error('TEST_SECRET'));
    await rejection;
    assert.equal(adapterContext.signal.aborted, true);
    assert.equal(adapterContext.signal.reason.message.includes('TEST_SECRET'), false);
    failure ? pending.reject(new Error('TEST_SECRET')) : pending.resolve({ translatedText: 'late' });
    await tick();
  }
});

test('late voice open after abort is closed exactly once', async () => {
  const abort = new AbortController(), pending = deferred(), started = deferred();
  let closes = 0;
  const implementation = adapter();
  implementation.voice.open = () => { started.resolve(); return pending.promise; };
  const { router } = setup(provider(), implementation);
  const operation = router.call('voice', textRequest(), context({ signal: abort.signal }));
  const rejection = assert.rejects(operation, code('ABORTED'));
  await started.promise; abort.abort(); await rejection;
  pending.resolve({ close() { closes++; } });
  await tick(); assert.equal(closes, 1);
});

test('live/voice sessions forward IDs, filter events after abort, and close idempotently', async () => {
  for (const capability of ['live', 'voice']) {
    const definition = provider(); definition.capabilities.live.implementation = 'ready';
    const abort = new AbortController(); const events = []; let emit, closes = 0, ctx;
    const implementation = adapter();
    implementation[capability].open = async (_request, incoming) => {
      ctx = incoming; emit = incoming.onEvent;
      return { async speak() {}, async cancel() {}, async sendAudio() {}, async finishInput() {}, async close() { closes++; } };
    };
    const { router } = setup(definition, implementation);
    const session = await router.call(capability, { input: { format: capability === 'live' ? 'pcm16' : 'text' } },
      context({ signal: abort.signal, onEvent: (event) => events.push(event) }));
    emit({ type: 'audio', audio: new Uint8Array([1]), generation: 999, key: 'TEST_SECRET' });
    assert.equal(events[0].generation, 1);
    assert.equal(events[0].turnId, 'turn-1');
    assert.equal(events[0].sessionId, 'session-1');
    assert.equal(events[0].key, undefined);
    await (capability === 'live' ? session.sendAudio(new Uint8Array()) : session.speak({ text: 'hello' }));
    abort.abort();
    emit({ type: 'audio', audio: new Uint8Array([2]) });
    assert.equal(events.length, 1); assert.equal(ctx.signal.aborted, true);
    await Promise.all([session.close(), session.close()]); assert.equal(closes, 1);
    await assert.rejects(capability === 'live' ? session.finishInput() : session.speak({}), code('ABORTED'));
  }
});

test('closed event is emitted once; malformed sessions and close errors are safe', async () => {
  let emit;
  const implementation = adapter();
  implementation.voice.open = async (_request, ctx) => {
    emit = ctx.onEvent;
    return { speak() {}, cancel() {}, close() { throw new Error('TEST_SECRET'); } };
  };
  const events = [];
  const { router } = setup(provider(), implementation);
  const session = await router.call('voice', textRequest(), context({ onEvent: (event) => events.push(event) }));
  emit({ type: 'closed' }); emit({ type: 'closed' }); emit({ type: 'audio' });
  assert.equal(events.length, 1);
  await assert.rejects(session.speak({}), code('SESSION_CLOSED'));
  await assert.rejects(session.close(), code('PROVIDER_ERROR'));
  const broken = adapter(); broken.voice.open = async () => ({});
  await assert.rejects(setup(provider(), broken).router.call('voice', textRequest(), context()), code('INVALID_RESULT'));
});

test('raw errors, normalizer output and thrown normalizer errors never retain secrets', async () => {
  for (const normalize of [
    () => ({ code: 'RATE_LIMITED', retryAfterMs: 1200, message: 'TEST_SECRET', cause: 'TEST_SECRET' }),
    () => ({ code: 'TEST_SECRET', retryAfterMs: 'TEST_SECRET' }),
    () => { throw new Error('TEST_SECRET'); },
  ]) {
    const definition = provider(); definition.quotaPolicy.normalizeError = normalize;
    let attempts = 0;
    const implementation = adapter(); implementation.translate = () => { attempts++; throw Object.assign(new Error('TEST_SECRET'), { url: 'https://example.invalid?key=TEST_SECRET' }); };
    const { router } = setup(definition, implementation);
    await assert.rejects(router.call('translate', textRequest(), context()), (error) => {
      assert.equal(inspect(error).includes('TEST_SECRET'), false);
      assert.equal(JSON.stringify(error).includes('TEST_SECRET'), false);
      assert.equal(error.cause, undefined);
      if (error.code === 'RATE_LIMITED') assert.equal(error.retryAfterMs, 1200);
      return true;
    });
    assert.equal(attempts, 1);
  }
  const dirty = Object.assign(new ProviderError('TIMEOUT'), { secret: 'TEST_SECRET' });
  assert.equal(inspect(normalizeError(dirty)).includes('TEST_SECRET'), false);
});

test('voice cancel drops synchronous and late audio and confirms shutdown', async () => {
  const events = []; let emit, cancels = 0, closes = 0;
  const implementation = adapter();
  implementation.voice.open = async (_request, ctx) => {
    emit = ctx.onEvent;
    return {
      speak() {},
      cancel() { cancels++; emit({ type: 'audio', audio: new Uint8Array([1]) }); },
      close() { closes++; },
    };
  };
  const { router } = setup(provider(), implementation);
  const session = await router.call('voice', textRequest(), context({ onEvent: (event) => events.push(event) }));
  await session.cancel();
  emit({ type: 'audio', audio: new Uint8Array([2]) });
  await session.close();
  assert.equal(cancels, 1); assert.equal(closes, 1); assert.deepEqual(events, []);
});

test('failed open suppresses late events and no-listener closed sessions reject reuse', async () => {
  let emit, signal;
  const events = [];
  const implementation = adapter();
  implementation.voice.open = async (_request, ctx) => {
    emit = ctx.onEvent; signal = ctx.signal;
    throw new Error('TEST_SECRET');
  };
  const { router } = setup(provider(), implementation);
  await assert.rejects(router.call('voice', textRequest(), context({ onEvent: (event) => events.push(event) })), code('PROVIDER_ERROR'));
  emit({ type: 'audio', audio: new Uint8Array([1]) });
  assert.equal(signal.aborted, true); assert.deepEqual(events, []);
  implementation.voice.open = async (_request, ctx) => {
    emit = ctx.onEvent;
    return { speak() {}, cancel() {}, close() {} };
  };
  const session = await setup(provider(), implementation).router.call('voice', textRequest(), context());
  emit({ type: 'closed' });
  await assert.rejects(session.speak({}), code('SESSION_CLOSED'));
  await session.close();
});

test('product modules contain only relative imports and no fixture or browser side effects', async () => {
  for (const file of ['contract', 'registry', 'router']) {
    const source = await readFile(new URL(`../app/providers/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"](?!\.\.?\/)/);
    assert.doesNotMatch(source, /tests\/fixtures|console\.|process\.|\bwindow\b|\bnavigator\b|new WebSocket/);
  }
});
