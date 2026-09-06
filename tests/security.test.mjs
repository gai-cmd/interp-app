import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { provider, adapter, context, textRequest } from './fixtures/providers.mjs';
import { bootstrapSharedKey } from '../app/security/bootstrap.js';
import { createKeyStore } from '../app/security/key-store.js';
import { parseSharedFragment, EVENT_ID_PATTERN, MAX_FRAGMENT_LENGTH, SHARED_PAYLOAD_VERSIONS } from '../app/security/shared-key.js';
import { redact, SecurityError } from '../app/security/redact.js';

const personalKey = 'synthetic-personal-secret';
const sharedKey = 'synthetic-shared-secret';
const payload = (changes = {}) => ({ version: 1, providerId: 'alpha', eventName: '행사 / Event / 集会', key: sharedKey, ...changes });
const fragment = (changes) => `#shared=${encodeURIComponent(JSON.stringify(payload(changes)))}`;
// P3-08 payload v2: the event ID of the policy list plus a mandatory usage deadline.
const EVENT_ID = 'service-20260906';
const payloadV2 = (changes = {}) => payload({ version: 2, eventId: EVENT_ID, expiresAt: 4102444800000, ...changes });
const fragmentV2 = (changes) => `#shared=${encodeURIComponent(JSON.stringify(payloadV2(changes)))}`;
const address = (providerId = 'alpha', keySource = 'personal') => ({ providerId, keySource, transport: 'direct' });
function setup(options = {}) {
  const registry = createRegistry();
  registry.register(provider(), adapter());
  registry.register(provider('beta'), adapter());
  registry.register(provider('hub', { browserDirect: false }), adapter());
  registry.register(provider('private', { credentialPolicy: { directPersonal: true, directShared: false, hubManaged: false } }), adapter());
  return { registry, store: createKeyStore({ registry, ...options }) };
}
function memoryStorage() {
  const data = new Map();
  const writes = [];
  return { data, writes,
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}
function noSecret(value) {
  const text = inspect(value, { depth: 20, showHidden: true });
  for (const secret of [personalKey, sharedKey, encodeURIComponent(sharedKey)]) assert.ok(!text.includes(secret));
}

test('bootstrap removes fragment and query before validation or storage access', () => {
  const { store } = setup();
  let cleaned = false;
  const location = { hash: fragment(), pathname: '/app/', search: '?key=synthetic-shared-secret' };
  const result = bootstrapSharedKey({ location,
    history: { replaceState(state, title, path) {
      assert.equal(state, null); assert.equal(title, ''); assert.equal(path, '/app/');
      location.hash = ''; cleaned = true;
    } },
    keyStore: { receiveSharedFragment(value) { assert.ok(cleaned); store.receiveSharedFragment(value); } },
  });
  assert.deepEqual(result, { received: true });
  assert.equal(location.hash, '');
  noSecret(result);
  store.dispose();
});

test('invalid fragments are cleared too; cleanup failure prevents consumption', () => {
  const { store } = setup();
  let calls = 0;
  for (const hash of ['#shared=%zz', '#unknown', '#shared=' + 'x'.repeat(MAX_FRAGMENT_LENGTH)]) {
    assert.throws(() => bootstrapSharedKey({ location: { hash, pathname: '/' },
      history: { replaceState() { calls++; } }, keyStore: store }), { code: 'INVALID_SHARED_PAYLOAD' });
  }
  assert.equal(calls, 3);
  assert.throws(() => bootstrapSharedKey({ location: { hash: fragment(), pathname: '/' },
    history: { replaceState() { throw new Error(sharedKey); } },
    keyStore: { receiveSharedFragment() { assert.fail('must not consume'); } },
  }), (error) => { noSecret(error); return error.code === 'URL_CLEANUP_FAILED'; });
  assert.deepEqual(bootstrapSharedKey({ location: { hash: '' } }), { received: false });
});

test('payload validation rejects unsupported versions, fields, providers and malformed values', () => {
  const { registry } = setup();
  const invalid = [
    { version: 2 }, { providerId: 'unknown' }, { providerId: 'hub' }, { providerId: 'private' },
    { eventName: '' }, { eventName: 'x'.repeat(121) }, { eventName: 'a\nb' },
    { key: '' }, { key: 'with space' }, { key: 'x'.repeat(513) }, { key: 42 },
    { expiresAt: '2027-01-01' }, { expiresAt: null }, { expiresAt: -1 }, { expiresAt: 1.5 },
    ...['endpoint', 'model', 'fallbackPolicy', 'hub', 'administratorVerified', '__proto__'].map((key) => ({ [key]: 'forbidden' })),
  ];
  for (const change of invalid) {
    assert.throws(() => parseSharedFragment(fragment(change), { registry, now: () => 0 }),
      (error) => { noSecret(error); return error.code === 'INVALID_SHARED_PAYLOAD'; });
  }
  for (const raw of ['null', '[]', '1', '{', JSON.stringify(sharedKey)]) {
    assert.throws(() => parseSharedFragment('#shared=' + encodeURIComponent(raw), { registry }), { code: 'INVALID_SHARED_PAYLOAD' });
  }
  assert.throws(() => parseSharedFragment(fragment({ expiresAt: 100 }), { registry, now: () => 100 }), { code: 'SHARED_USE_ENDED' });
});

test('payload v2 carries the event ID and a deadline; v1 stays accepted without either; the ID is validated, not trusted', () => {
  const { registry } = setup();
  assert.deepEqual([...SHARED_PAYLOAD_VERSIONS], [1, 2]);
  const v2 = parseSharedFragment(fragmentV2(), { registry, now: () => 0 });
  assert.deepEqual(v2, { version: 2, providerId: 'alpha', eventId: EVENT_ID, key: sharedKey, eventName: '행사 / Event / 集会', expiresAt: 4102444800000 });
  assert.ok(Object.isFrozen(v2));
  const v1 = parseSharedFragment(fragment(), { registry, now: () => 0 });
  assert.deepEqual(v1, { version: 1, providerId: 'alpha', eventId: null, key: sharedKey, eventName: '행사 / Event / 集会', expiresAt: null });
  assert.equal(parseSharedFragment(fragment({ expiresAt: 5 }), { registry, now: () => 0 }).expiresAt, 5);
  // Well-formed IDs only: the same shape as policy sharedEvents[].id.
  for (const eventId of ['a', 'service-20260906', '0'.repeat(64)]) {
    assert.ok(EVENT_ID_PATTERN.test(eventId));
    assert.equal(parseSharedFragment(fragmentV2({ eventId }), { registry, now: () => 0 }).eventId, eventId);
  }
  const invalid = [
    { eventId: undefined }, { eventId: null }, { eventId: '' }, { eventId: 'Service-1' }, { eventId: 'service_1' }, { eventId: 'service 1' },
    { eventId: 'x'.repeat(65) }, { eventId: 42 }, { eventId: ['service-1'] }, { eventId: '__proto__' }, { eventId: 'a\n' },
    { expiresAt: undefined }, { expiresAt: null }, { expiresAt: '4102444800000' }, { expiresAt: -1 }, { expiresAt: 1.5 },
    { providerId: 'hub' }, { providerId: 'private' }, { key: 'with space' }, { eventName: 'a\tb' },
    ...['endpoint', 'model', 'label', 'allowedCapabilities', 'enabled', 'signature', 'administratorVerified'].map((key) => ({ [key]: 'forbidden' })),
  ];
  for (const change of invalid) {
    assert.throws(() => parseSharedFragment(fragmentV2(change), { registry, now: () => 0 }),
      (error) => { noSecret(error); return error.code === 'INVALID_SHARED_PAYLOAD'; }, inspect(change));
  }
  // eventId is a v2 field: a v1 payload carrying it is rejected, as are other versions.
  assert.throws(() => parseSharedFragment(fragment({ eventId: EVENT_ID }), { registry }), { code: 'INVALID_SHARED_PAYLOAD' });
  for (const version of [0, 3, '2', 2.5, null, undefined]) {
    assert.throws(() => parseSharedFragment(fragmentV2({ version }), { registry }), { code: 'INVALID_SHARED_PAYLOAD' }, String(version));
  }
  // The deadline still ends use at parse time; the event ID does not extend it.
  assert.throws(() => parseSharedFragment(fragmentV2({ expiresAt: 100 }), { registry, now: () => 100 }), { code: 'SHARED_USE_ENDED' });
  assert.equal(parseSharedFragment(fragmentV2({ expiresAt: 101 }), { registry, now: () => 100 }).expiresAt, 101);
});

test('shared metadata exposes version and event ID for policy matching, never the key; a new payload replaces the old one', () => {
  const { store } = setup();
  store.setPersonal('alpha', personalKey);
  store.receiveSharedFragment(fragmentV2());
  assert.deepEqual(store.getSelection(), { providerId: 'alpha', keySource: 'personal' }, 'personal key first: a v2 QR does not switch modes');
  const v2 = store.getMetadata('alpha', 'shared');
  noSecret(v2);
  assert.deepEqual(v2, { providerId: 'alpha', keySource: 'shared', version: 2, eventId: EVENT_ID, eventName: '행사 / Event / 集会',
    usageEndsAt: 4102444800000, administratorVerified: false, networkRestrictionVerified: false });
  assert.ok(Object.isFrozen(v2));
  store.select('alpha', 'shared');
  const ref = store.getCredentialRef(address('alpha', 'shared')).reference;
  // A later v1 payload for the same provider replaces the entry and invalidates old references.
  store.receiveSharedFragment(fragment());
  const v1 = store.getMetadata('alpha', 'shared');
  assert.equal(v1.version, 1);
  assert.equal(v1.eventId, null);
  assert.equal(v1.usageEndsAt, null);
  assert.throws(() => store.resolveCredential(ref, address('alpha', 'shared')), { code: 'CREDENTIAL_MISMATCH' });
  assert.equal(store.resolveCredential(store.getCredentialRef(address('alpha', 'shared')).reference, address('alpha', 'shared')), sharedKey);
  // Providers are isolated: beta's shared metadata is independent of alpha's.
  store.receiveSharedFragment(fragmentV2({ providerId: 'beta', eventId: 'beta-event' }));
  assert.equal(store.getMetadata('beta', 'shared').eventId, 'beta-event');
  assert.equal(store.getMetadata('alpha', 'shared').eventId, null);
  assert.deepEqual(store.getSelection(), { providerId: 'alpha', keySource: 'shared' });
  store.dispose();
});

test('personal selection survives QR; switching source and provider is explicit', () => {
  const { store } = setup();
  store.setPersonal('alpha', personalKey);
  store.receiveSharedFragment(fragment());
  assert.deepEqual(store.getSelection(), { providerId: 'alpha', keySource: 'personal' });
  const credential = store.getCredentialRef(address());
  noSecret(credential);
  assert.equal(store.resolveCredential(credential.reference, address()), personalKey);
  assert.throws(() => store.getCredentialRef(address('alpha', 'shared')), { code: 'CREDENTIAL_MISMATCH' });
  store.select('alpha', 'shared');
  assert.throws(() => store.resolveCredential(credential.reference, address()), { code: 'CREDENTIAL_MISMATCH' });
  const shared = store.getCredentialRef(address('alpha', 'shared'));
  assert.equal(store.resolveCredential(shared.reference, address('alpha', 'shared')), sharedKey);
  assert.throws(() => store.resolveCredential(shared.reference, address('beta', 'shared')), { code: 'CREDENTIAL_MISMATCH' });
  store.endShared('alpha');
  assert.equal(store.getSelection().keySource, 'shared');
  assert.throws(() => store.getCredentialRef(address('alpha', 'shared')), { code: 'CREDENTIAL_REQUIRED' });
  store.dispose();
});

test('only opted-in personal keys persist, isolated by provider; shared keys never persist', () => {
  const storage = memoryStorage();
  const { store, registry } = setup({ storage });
  store.setPersonal('alpha', personalKey);
  assert.equal(storage.data.size, 0);
  store.setPersonal('alpha', personalKey, { remember: true });
  store.setPersonal('beta', 'synthetic-beta', { remember: true });
  store.receiveSharedFragment(fragment());
  store.select('alpha', 'shared');
  store.dispose();
  assert.equal(storage.data.size, 2);
  assert.ok(!JSON.stringify(storage.writes).includes(sharedKey));
  const fresh = createKeyStore({ registry, storage });
  assert.equal(fresh.getMetadata('alpha', 'shared'), null);
  assert.equal(fresh.loadPersonal('alpha'), true);
  assert.equal(fresh.getSelection().keySource, 'personal');
  fresh.setPersonal('alpha', personalKey);
  assert.equal(storage.data.size, 1);
  fresh.deleteKey('beta', 'personal');
  assert.equal(storage.data.size, 0);
  fresh.dispose();
});

test('deletion revokes references and notifies all listeners despite storage and listener failures', () => {
  const storage = memoryStorage();
  const { store } = setup({ storage });
  store.setPersonal('alpha', personalKey, { remember: true });
  const ref = store.getCredentialRef(address()).reference;
  const events = [];
  store.subscribe(() => { throw new Error(sharedKey); });
  const unsubscribe = store.subscribe((event) => events.push(event));
  storage.removeItem = () => { throw new Error(personalKey); };
  assert.throws(() => store.deleteKey('alpha', 'personal'), (error) => {
    noSecret(error); return error.code === 'STORAGE_FAILED';
  });
  assert.equal(store.getMetadata('alpha', 'personal'), null);
  assert.throws(() => store.resolveCredential(ref, address()), { code: 'CREDENTIAL_MISMATCH' });
  assert.equal(events.at(-1).type, 'key-deleted');
  noSecret(events);
  unsubscribe();
  store.dispose();
  assert.equal(events.length, 1);
});

test('failed persistence never claims success or exposes storage errors; shared receive needs no storage', () => {
  const fail = () => { throw new Error(personalKey, { cause: payload() }); };
  const { store } = setup({ storage: { getItem: fail, setItem: fail, removeItem: fail } });
  for (const action of [() => store.loadPersonal('alpha'),
    () => store.setPersonal('alpha', personalKey, { remember: true }),
    () => store.setPersonal('alpha', personalKey)]) {
    assert.throws(action, (error) => { noSecret(error); return error.code === 'STORAGE_FAILED'; });
    assert.equal(store.getMetadata('alpha', 'personal'), null);
  }
  store.receiveSharedFragment(fragment());
  assert.equal(store.getSelection(), null);
  store.select('alpha', 'shared');
  store.deleteKey('alpha', 'shared');
  store.dispose();
});

test('key replacement invalidates old refs; lifecycle subscribers can abort active work', () => {
  const { store } = setup();
  store.setPersonal('alpha', personalKey);
  const old = store.getCredentialRef(address()).reference;
  const work = new AbortController();
  store.subscribe(() => work.abort());
  store.setPersonal('alpha', 'synthetic-replacement');
  assert.equal(work.signal.aborted, true);
  assert.throws(() => store.resolveCredential(old, address()), { code: 'CREDENTIAL_MISMATCH' });
  assert.equal(store.resolveCredential(store.getCredentialRef(address()).reference, address()), 'synthetic-replacement');
  store.dispose();
});

test('app usage deadline removes shared keys, invalidates refs, and reports no key-expiry or admin assurance', () => {
  let time = 100;
  let tick;
  const { store } = setup({ now: () => time, setTimeout: (fn) => { tick = fn; return 1; }, clearTimeout() {} });
  store.receiveSharedFragment(fragment({ expiresAt: 200 }));
  const metadata = store.getMetadata('alpha', 'shared');
  assert.equal(metadata.usageEndsAt, 200);
  assert.equal(metadata.administratorVerified, false);
  assert.equal(metadata.networkRestrictionVerified, false);
  assert.equal(metadata.expiresAt, undefined);
  noSecret(metadata);
  store.select('alpha', 'shared');
  const ref = store.getCredentialRef(address('alpha', 'shared')).reference;
  const events = [];
  store.subscribe((event) => events.push(event));
  time = 200;
  tick();
  assert.equal(events.at(-1).type, 'shared-use-ended');
  assert.equal(store.getMetadata('alpha', 'shared'), null);
  assert.throws(() => store.resolveCredential(ref, address('alpha', 'shared')), { code: 'CREDENTIAL_MISMATCH' });
  store.dispose();
});

test('lazy expiry enforces deadline even when background timers are suspended', () => {
  let time = 0;
  const { store } = setup({ now: () => time, setTimeout() {}, clearTimeout() {} });
  store.receiveSharedFragment(fragment({ expiresAt: 10 }));
  store.select('alpha', 'shared');
  time = 11;
  assert.throws(() => store.getCredentialRef(address('alpha', 'shared')), { code: 'CREDENTIAL_REQUIRED' });
  store.dispose();
});

test('policy, abort, forged refs and disposed stores fail without secret-bearing causes', () => {
  const { store } = setup();
  assert.throws(() => store.setPersonal('hub', personalKey), { code: 'CREDENTIAL_FORBIDDEN' });
  store.setPersonal('alpha', personalKey);
  assert.throws(() => store.getCredentialRef({ ...address(), transport: 'hub' }), { code: 'CREDENTIAL_FORBIDDEN' });
  assert.throws(() => store.resolveCredential({}, address()), { code: 'CREDENTIAL_MISMATCH' });
  const controller = new AbortController();
  controller.abort(new Error(personalKey));
  assert.throws(() => store.getCredentialRef(address(), { signal: controller.signal }), (error) => {
    noSecret(error); return error.code === 'ABORTED';
  });
  store.dispose();
  assert.throws(() => store.getCredentialRef(address()), { code: 'STORE_CLOSED' });
});

test('redaction discards raw errors, secret property names, URLs, nested payloads and getters', () => {
  const error = new Error(`https://example.invalid/?key=${personalKey}`, { cause: { key: sharedKey } });
  error.code = 'NETWORK_ERROR';
  error[sharedKey] = personalKey;
  error.payload = payload();
  error.self = error;
  assert.deepEqual(redact(error), { code: 'NETWORK_ERROR' });
  noSecret(redact(error));
  assert.ok(error.message.includes(personalKey));
  const dangerous = { get code() { assert.fail('getter must not run'); } };
  assert.deepEqual(redact(dangerous), { code: 'SECURITY_ERROR' });
  for (const raw of [personalKey, payload(), null, undefined, { code: sharedKey }, new SecurityError(sharedKey)]) noSecret(redact(raw));
});

test('real P1-02 router passes only opaque refs and adapter resolves the selected credential', async () => {
  const registry = createRegistry();
  let store;
  registry.register(provider(), { ...adapter(), async translate(request, ctx) {
    noSecret(ctx);
    assert.equal(store.resolveCredential(ctx.credentialRef, ctx, ctx), personalKey);
    return { status: 'ok', translatedText: '안녕' };
  } });
  store = createKeyStore({ registry });
  store.setPersonal('alpha', personalKey);
  const router = createRouter({ registry, getCredentialRef: store.getCredentialRef });
  assert.equal((await router.call('translate', textRequest(), context())).status, 'ok');
  store.dispose();
});
