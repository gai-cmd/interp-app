import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { EVENT_REASON_KEYS, EVENT_STATUSES, resolveEffective } from '../app/policy/resolve.js';
import { EVENT_CAPABILITIES, validatePolicy } from '../app/policy/schema.js';
import { createPolicyRuntime, PolicyError } from '../app/policy/runtime.js';
import { createKeyStore } from '../app/security/key-store.js';
import { parseSharedFragment } from '../app/security/shared-key.js';
import { createRegistry } from '../app/providers/registry.js';
import { CAPABILITIES } from '../app/providers/contract.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { provider, adapter } from './fixtures/providers.mjs';
import { REGISTERED_HUB_IDS, exampleEvent, policyWith } from './fixtures/policy.mjs';

// P3-08 (design-p3 §1.7 "공용 키 payload", architecture.md "공용 키 payload v2"):
// the shared key is tied to the active event list. A v2 payload names the
// event and must also match its provider, name and expiry; a v1 payload has
// no ID and is usable only when exactly one active listed event matches. The
// event ID is a lookup key, never a signature; Live is never granted to a
// shared key; the policy comparison happens in resolveEffective, not the parser.

const NOW = Date.parse('2026-09-06T01:00:00Z');
const EXPIRES = Date.parse('2026-09-06T03:00:00Z');
const EVENT_ID = 'service-20260906';
const sharedKey = 'synthetic-shared-secret';
const personalKey = 'synthetic-personal-secret';
const options = { registeredHubIds: REGISTERED_HUB_IDS, registeredProviderIds: ['gemini', 'beta'] };

function validated(policy) {
  const result = validatePolicy(policy, options);
  assert.deepEqual(result.ok ? [] : result.issues, []);
  return result.policy;
}
/** Policy with sharedKeys on and the given events (default: the §1.4 example event, enabled). */
function withEvents(events = [exampleEvent({ enabled: true })], mutate = () => {}) {
  return validated(policyWith((draft) => { draft.features.sharedKeys = true; draft.sharedEvents = events; mutate(draft); }));
}
/** Key-store style shared metadata for a payload; v1 has eventId null. */
function descriptor(changes = {}) {
  return { providerId: 'gemini', keySource: 'shared', version: 2, eventId: EVENT_ID, eventName: '2026-09-06', usageEndsAt: EXPIRES,
    administratorVerified: false, networkRestrictionVerified: false, ...changes };
}
const v1 = (changes = {}) => descriptor({ version: 1, eventId: null, ...changes });
const fragment = (payload) => `#shared=${encodeURIComponent(JSON.stringify(payload))}`;
const v2Payload = (changes = {}) => ({ version: 2, providerId: 'gemini', eventId: EVENT_ID, eventName: '2026-09-06', key: sharedKey, expiresAt: EXPIRES, ...changes });
const v1Payload = (changes = {}) => ({ version: 1, providerId: 'gemini', eventName: '2026-09-06', key: sharedKey, expiresAt: EXPIRES, ...changes });
const active = { id: EVENT_ID, status: 'active', providerId: 'gemini', expiresAt: '2026-09-06T03:00:00Z',
  allowedCapabilities: ['translate', 'stt', 'voice'], reasonKey: null };
const ended = (id, status, entry = null) => ({ id, status, providerId: entry?.providerId ?? null, expiresAt: entry?.expiresAt ?? null,
  allowedCapabilities: [], reasonKey: EVENT_REASON_KEYS[status] });
const resolveEvent = (policy, event, now = NOW, extra = {}) => resolveEffective({ policy, now, event, ...extra }).event;
function registry() {
  const reg = createRegistry();
  reg.register(provider('gemini'), adapter());
  reg.register(provider('beta'), adapter());
  return reg;
}
function noSecret(value) {
  const text = inspect(value, { depth: 20, showHidden: true });
  for (const secret of [sharedKey, personalKey, encodeURIComponent(sharedKey)]) assert.ok(!text.includes(secret));
}
function assertDeepFrozen(value, path = 'result') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), path);
  for (const [key, item] of Object.entries(value)) assertDeepFrozen(item, `${path}.${key}`);
}

test('v2: the listed event must match ID, provider, name and expiry; the ID alone proves nothing', () => {
  const policy = withEvents();
  assert.deepEqual(resolveEvent(policy, descriptor()), active);
  assert.deepEqual(resolveEvent(policy, { eventId: EVENT_ID, providerId: 'gemini', eventName: '2026-09-06', expiresAt: EXPIRES }), active,
    'the parser entry shape (expiresAt) is accepted like the key-store shape (usageEndsAt)');
  // Same ID, different payload: mismatch, never active. Nothing of the listed event is confirmed.
  for (const change of [{ eventName: '2026-09-07' }, { eventName: '2026-09-06 ' }, { providerId: 'beta' },
    { usageEndsAt: EXPIRES + 1 }, { usageEndsAt: EXPIRES - 1 }, { usageEndsAt: null }, { usageEndsAt: String(EXPIRES) },
    { usageEndsAt: undefined, expiresAt: undefined }, { eventName: undefined }, { providerId: undefined }]) {
    assert.deepEqual(resolveEvent(policy, descriptor(change)), ended(EVENT_ID, 'mismatch'), inspect(change));
  }
  // The mismatch verdict is independent of the event's own state: a wrong
  // payload for a disabled or expired event is still a mismatch.
  assert.equal(resolveEvent(withEvents([exampleEvent()]), descriptor({ eventName: 'other' })).status, 'mismatch');
  assert.equal(resolveEvent(policy, descriptor({ eventName: 'other' }), EXPIRES).status, 'mismatch');
  // An ID that is not listed is removed, whatever the other fields say.
  assert.deepEqual(resolveEvent(policy, descriptor({ eventId: 'service-gone' })), ended('service-gone', 'removed'));
  assert.deepEqual(resolveEvent(null, descriptor()), ended(EVENT_ID, 'removed'), 'no policy: nothing is listed');
  // A bare ID (runtime.setEvent today) keeps the P3-05 behaviour: ID lookup only.
  assert.deepEqual(resolveEvent(policy, EVENT_ID), active);
  assert.deepEqual(resolveEvent(policy, { id: EVENT_ID }), active);
});

test('v2: expiry, disabling, site-wide switch-off and list removal apply to the joined payload', () => {
  const policy = withEvents();
  assert.deepEqual(resolveEvent(policy, descriptor(), EXPIRES), ended(EVENT_ID, 'expired', { providerId: 'gemini', expiresAt: '2026-09-06T03:00:00Z' }));
  assert.equal(resolveEvent(policy, descriptor(), EXPIRES - 1).status, 'active');
  assert.equal(resolveEvent(policy, descriptor(), Date.parse('2026-09-05T23:59:59.999Z')).status, 'upcoming');
  assert.equal(resolveEvent(policy, descriptor(), Date.parse('2026-09-06T00:00:00Z')).status, 'active');
  assert.equal(resolveEvent(withEvents([exampleEvent()]), descriptor()).status, 'disabled', 'operator declaration withdrawn');
  const sharedOff = validated(policyWith((draft) => { draft.sharedEvents = [exampleEvent()]; }));
  assert.equal(resolveEvent(sharedOff, descriptor()).status, 'disabled', 'sharedKeys false disables every event');
  assert.equal(resolveEvent(withEvents([]), descriptor()).status, 'removed');
  // The same store metadata resolves differently as the policy revision changes: no re-scan needed.
  const revisions = [withEvents(), withEvents([exampleEvent()]), withEvents([]), withEvents()];
  assert.deepEqual(revisions.map((revision) => resolveEvent(revision, descriptor()).status), ['active', 'disabled', 'removed', 'active']);
});

test('v1: usable only through a unique active match on provider, name and expiry', () => {
  const later = exampleEvent({ id: 'service-later', eventName: 'later', enabled: true, startsAt: '2026-09-06T04:00:00Z', expiresAt: '2026-09-06T06:00:00Z' });
  const policy = withEvents([exampleEvent({ enabled: true }), later]);
  assert.deepEqual(resolveEvent(policy, v1()), active, 'the unique active match supplies the event ID');
  assert.deepEqual(resolveEvent(policy, { eventId: null, providerId: 'gemini', eventName: '2026-09-06', expiresAt: EXPIRES }), active);
  // No match at all: mismatch without an ID (the input is never echoed).
  for (const change of [{ eventName: 'later' }, { providerId: 'beta' }, { usageEndsAt: EXPIRES + 1000 }, { usageEndsAt: null }, { usageEndsAt: undefined }]) {
    assert.deepEqual(resolveEvent(policy, v1(change)), ended(null, 'mismatch'), inspect(change));
  }
  assert.deepEqual(resolveEvent(null, v1()), ended(null, 'mismatch'), 'no policy: no listed event can match');
  assert.deepEqual(resolveEvent(withEvents([]), v1()), ended(null, 'mismatch'));
  // A single match that is not active reports that event's state under its ID.
  assert.deepEqual(resolveEvent(policy, v1(), EXPIRES), ended(EVENT_ID, 'expired', { providerId: 'gemini', expiresAt: '2026-09-06T03:00:00Z' }));
  assert.equal(resolveEvent(policy, v1(), Date.parse('2026-09-05T20:00:00Z')).status, 'upcoming');
  assert.deepEqual(resolveEvent(withEvents([exampleEvent()]), v1()), ended(EVENT_ID, 'disabled', { providerId: 'gemini', expiresAt: '2026-09-06T03:00:00Z' }));
  // Two active events with the same provider, name and expiry: not unique, so unusable.
  const twin = exampleEvent({ id: 'service-twin', enabled: true, startsAt: '2026-09-06T00:30:00Z' });
  assert.deepEqual(resolveEvent(withEvents([exampleEvent({ enabled: true }), twin]), v1()), ended(null, 'mismatch'));
  // A disabled twin does not spoil the unique active match; two inactive twins are ambiguous.
  assert.deepEqual(resolveEvent(withEvents([exampleEvent({ enabled: true }), exampleEvent({ id: 'service-twin' })]), v1()), active);
  assert.deepEqual(resolveEvent(withEvents([exampleEvent(), exampleEvent({ id: 'service-twin' })]), v1()), ended(null, 'mismatch'));
  // v1 metadata without any comparable field is not a joined event.
  assert.equal(resolveEvent(policy, { eventId: null }), null);
  assert.equal(resolveEvent(policy, { eventId: null, keySource: 'shared', version: 1 }), null);
});

test('capabilities: the event list restricts, the code support intersects, and Live is never granted to a shared key', () => {
  const restricted = withEvents([exampleEvent({ enabled: true, allowedCapabilities: ['translate'] })]);
  assert.deepEqual(resolveEvent(restricted, descriptor()).allowedCapabilities, ['translate']);
  assert.deepEqual(resolveEvent(restricted, v1()).allowedCapabilities, ['translate']);
  assert.deepEqual(resolveEvent(withEvents(), descriptor(), NOW, { capabilities: ['stt', 'live'] }).allowedCapabilities, ['stt']);
  assert.deepEqual(resolveEvent(withEvents(), descriptor(), NOW, { capabilities: ['live'] }).allowedCapabilities, []);
  assert.deepEqual(resolveEvent(withEvents(), descriptor(), NOW, { capabilities: CAPABILITIES }).allowedCapabilities, ['translate', 'stt', 'voice']);
  assert.equal(EVENT_CAPABILITIES.includes('live'), false, 'the schema never lists live for an event');
  const live = validatePolicy(policyWith((draft) => { draft.features.sharedKeys = true; draft.sharedEvents = [exampleEvent({ enabled: true, allowedCapabilities: ['live'] })]; }), options);
  assert.equal(live.ok, false);
  assert.ok(live.issues.some((issue) => issue.code === 'POLICY_REFERENCE'));
  // Only the listed statuses are produced; every reason key exists in the dictionaries.
  assert.deepEqual([...EVENT_STATUSES], ['upcoming', 'active', 'expired', 'disabled', 'removed', 'mismatch']);
  assert.deepEqual(Object.keys(EVENT_REASON_KEYS), [...EVENT_STATUSES]);
  assert.equal(EVENT_REASON_KEYS.mismatch, 'event.payloadMismatch');
});

test('key store to resolver: the parsed v2/v1 payload reaches the policy as secret-free metadata; personal keys stay first; nothing persists', () => {
  const writes = [];
  const storage = { getItem: () => null, setItem: (key, value) => { writes.push([key, value]); }, removeItem: () => {} };
  const reg = registry();
  const store = createKeyStore({ registry: reg, storage, now: () => NOW });
  store.setPersonal('gemini', personalKey);
  store.receiveSharedFragment(fragment(v2Payload()));
  assert.deepEqual(store.getSelection(), { providerId: 'gemini', keySource: 'personal' }, 'a QR never switches the source (§5.4)');
  const metadata = store.getMetadata('gemini', 'shared');
  noSecret(metadata);
  assert.deepEqual(metadata, { providerId: 'gemini', keySource: 'shared', version: 2, eventId: EVENT_ID, eventName: '2026-09-06',
    usageEndsAt: EXPIRES, administratorVerified: false, networkRestrictionVerified: false });
  const policy = withEvents();
  const result = resolveEffective({ policy, now: NOW, event: metadata });
  assert.deepEqual(result.event, active);
  assertDeepFrozen(result);
  noSecret(result);
  assert.equal(JSON.stringify(result).includes('2026-09-06"'), false, 'the event name is compared, never echoed');
  // The parser entry itself is an accepted descriptor too (admin tool round trip, P3-34).
  const entry = parseSharedFragment(fragment(v2Payload()), { registry: reg, now: () => NOW });
  assert.deepEqual(resolveEffective({ policy, now: NOW, event: entry }).event, active);
  // A wrong-name v2 payload parses (the parser is policy-blind) but never resolves active.
  store.receiveSharedFragment(fragment(v2Payload({ eventName: 'Sunday service' })));
  assert.equal(resolveEffective({ policy, now: NOW, event: store.getMetadata('gemini', 'shared') }).event.status, 'mismatch');
  // v1 metadata (eventId null) is matched by the other fields.
  store.receiveSharedFragment(fragment(v1Payload()));
  const legacy = store.getMetadata('gemini', 'shared');
  assert.equal(legacy.version, 1);
  assert.equal(legacy.eventId, null);
  assert.deepEqual(resolveEffective({ policy, now: NOW, event: legacy }).event, active);
  assert.equal(resolveEffective({ policy: withEvents([exampleEvent({ enabled: true, eventName: 'renamed' })]), now: NOW, event: legacy }).event.status, 'mismatch');
  // Ending shared use leaves no event to resolve; the personal key is untouched and nothing was written.
  store.endShared('gemini');
  assert.equal(store.getMetadata('gemini', 'shared'), null);
  assert.equal(resolveEffective({ policy, now: NOW, event: store.getMetadata('gemini', 'shared') }).event, null);
  assert.deepEqual(store.getSelection(), { providerId: 'gemini', keySource: 'personal' });
  assert.deepEqual(writes, [], 'shared keys and their metadata are memory only');
  store.dispose();
});

// Minimal policy-client double: the runtime only reads snapshot()/subscribe()/refresh().
function clientDouble(policy) {
  const listeners = new Set();
  let state = Object.freeze({ status: 'ready', revision: policy.revision, fetchedAt: NOW, error: null, policy });
  return Object.freeze({
    snapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: async () => state,
    serve(next) {
      state = Object.freeze({ status: 'ready', revision: next.revision, fetchedAt: NOW, error: null, policy: next });
      for (const fn of [...listeners]) fn(state);
    },
  });
}
const activityDouble = () => Object.freeze({ occupied: false, snapshot: () => ({ occupied: false, kind: null }), close: async () => {} });
const sessionDouble = () => Object.freeze({ occupied: false, close: async () => {} });
const policyError = (code) => (error) => error instanceof PolicyError && error.code === code;

test('runtime gate: a v2 event ID admits only the listed capabilities; expiry, disabling and removal end the shared route', () => {
  let time = NOW;
  const client = clientDouble(withEvents([exampleEvent({ enabled: true, allowedCapabilities: ['translate', 'voice'] })], (draft) => { draft.revision = 2; }));
  const runtime = createPolicyRuntime({ client, activity: activityDouble(), sessionManager: sessionDouble(), now: () => time });
  const route = (overrides = {}) => ({ providerId: 'gemini', capability: 'translate', keySource: 'shared', transport: 'direct', ...overrides });
  const store = createKeyStore({ registry: registry(), now: () => time });
  store.receiveSharedFragment(fragment(v2Payload()));
  // The composition root forwards the shared metadata's eventId (main.js, P3-07 wiring).
  assert.equal(runtime.setEvent(store.getMetadata('gemini', 'shared').eventId).event.status, 'active');
  runtime.assertRoute(route());
  runtime.assertRoute(route({ capability: 'voice' }));
  assert.throws(() => runtime.assertRoute(route({ capability: 'stt' })), policyError('POLICY_FEATURE_DISABLED'), 'capability outside the event list');
  assert.throws(() => runtime.assertRoute(route({ capability: 'live' })), policyError('POLICY_FEATURE_DISABLED'), 'shared Live is never new-ly allowed');
  assert.throws(() => runtime.assertRoute(route({ providerId: 'beta' })), policyError('POLICY_FEATURE_DISABLED'));
  runtime.assertRoute(route({ keySource: 'personal', capability: 'stt' }));
  // Expiry by the clock, then withdrawal, then removal: each ends the shared route while personal routes continue.
  time = EXPIRES;
  assert.equal(runtime.snapshot().event.status, 'expired');
  assert.throws(() => runtime.assertRoute(route()), policyError('EVENT_ENDED'));
  assert.throws(() => runtime.assertAction('event.join'), policyError('EVENT_ENDED'));
  time = NOW;
  runtime.assertRoute(route());
  client.serve(withEvents([exampleEvent()], (draft) => { draft.revision = 3; }));
  assert.equal(runtime.snapshot().event.status, 'disabled');
  assert.throws(() => runtime.assertRoute(route()), policyError('EVENT_ENDED'));
  client.serve(withEvents([], (draft) => { draft.revision = 4; }));
  assert.equal(runtime.snapshot().event.status, 'removed');
  assert.throws(() => runtime.assertRoute(route()), policyError('EVENT_ENDED'));
  runtime.assertRoute(route({ keySource: 'personal' }));
  client.serve(withEvents([exampleEvent({ enabled: true })], (draft) => { draft.revision = 5; }));
  assert.equal(runtime.snapshot().event.status, 'active', 'a wider policy reopens the gate; nothing restarts');
  runtime.assertRoute(route());
  runtime.close();
  store.dispose();
});

test('runtime gate: only an active verdict admits the shared route; a mismatching descriptor never resolves active', () => {
  const client = clientDouble(withEvents());
  const runtime = createPolicyRuntime({ client, activity: activityDouble(), sessionManager: sessionDouble(), now: () => NOW });
  const route = { providerId: 'gemini', capability: 'translate', keySource: 'shared', transport: 'direct' };
  // runtime.setEvent takes IDs only (P3-07): with the ID the route passes ...
  runtime.setEvent(EVENT_ID);
  runtime.assertRoute(route);
  // ... while the same policy snapshot judges a forged-name payload for that ID
  // a mismatch. Forwarding the whole descriptor to the runtime is the
  // composition root's wiring (main.js / runtime.setEvent, outside P3-08).
  const verdict = (event) => resolveEffective({ policy: client.snapshot().policy, now: NOW, event }).event;
  assert.equal(verdict(descriptor({ eventName: 'forged' })).status, 'mismatch');
  assert.equal(verdict(v1({ eventName: 'forged' })).status, 'mismatch');
  assert.equal(verdict(descriptor()).status, 'active');
  // Every non-active status is EVENT_ENDED for the gate: shown here for the listed IDs.
  client.serve(withEvents([exampleEvent()], (draft) => { draft.revision = 9; }));
  assert.equal(runtime.snapshot().event.status, 'disabled');
  assert.throws(() => runtime.assertRoute(route), policyError('EVENT_ENDED'));
  runtime.close();
});

test('every event reason key exists in all three dictionaries; the resolver stays browser-free and never echoes payload text', async () => {
  const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
    [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));
  for (const key of Object.values(EVENT_REASON_KEYS)) {
    for (const language of SUPPORTED_LANGUAGES) assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
  }
  const policy = withEvents();
  const hostile = descriptor({ eventName: '<script>alert(1)</script>', providerId: 'gemini' });
  const before = JSON.stringify(hostile);
  const result = resolveEffective({ policy, now: NOW, event: hostile });
  assert.equal(JSON.stringify(hostile), before, 'input untouched');
  assert.equal(result.event.status, 'mismatch');
  assert.equal(JSON.stringify(result).includes('script'), false);
  for (const source of ['app/policy/resolve.js', 'app/security/shared-key.js', 'app/security/key-store.js']) {
    const text = await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\b(?:window|document|navigator|localStorage|fetch)\b\s*[.(]/, `${source}: no browser globals`);
    assert.doesNotMatch(text, /console\./, `${source}: no logging`);
  }
});
