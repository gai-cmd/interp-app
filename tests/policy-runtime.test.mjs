import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACTIONS, ACTION_FEATURES, ACTION_KINDS, CAPABILITY_FEATURES, CHANGE_TYPES, CLEANUP_STATES, POLICY_ERROR_CODES,
  PolicyError, createPolicyRuntime, isPolicyError,
} from '../app/policy/runtime.js';
import { createPolicyClient } from '../app/policy/client.js';
import { BLOCK_CODES } from '../app/policy/resolve.js';
import { createPreferences } from '../app/preferences.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createAppConfig } from '../app/config.js';
import { CAPABILITIES, ProviderError } from '../app/providers/contract.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { APP_VERSION } from '../app/version.js';
import { examplePolicy, exampleEvent, policyWith, serialized, trilingual } from './fixtures/policy.mjs';
import { START, createClock, policyResponse, scriptedFetch, settle } from './fixtures/policy-fetch.mjs';
import { adapter, context as routeContext, credentialRef, provider, textRequest } from './fixtures/providers.mjs';

// P3-07: the policy runtime gates every execution path (sequential start /
// retry / replay, diagnostics, direct Live, hub join, event join) and the
// router boundary, and connects a restrictive policy change to the existing
// cleanup owners (activity slot, Live slot, composition-root stopWork). A
// wider policy only reopens the gate. No slot is ever released by force.

const MINUTE = 60000;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await read(`app/i18n/${language}.json`))])));
const policyError = (code) => (error) => error instanceof PolicyError && error.name === 'PolicyError' && error.code === code;
const providerError = (code) => (error) => error instanceof ProviderError && error.code === code;

// Activity / Live-slot doubles: occupancy is set by the test; close() records
// calls and may be scripted to reject (a cleanup failure must stay visible).
function activityDouble() {
  const closes = [];
  const state = { occupied: false, kind: null, failure: null };
  return Object.freeze({
    closes, state,
    get occupied() { return state.occupied; },
    snapshot: () => Object.freeze({ generation: 1, occupied: state.occupied, active: state.occupied, kind: state.kind }),
    close() {
      closes.push(state.kind);
      if (state.failure) return Promise.reject(state.failure);
      state.occupied = false; state.kind = null;
      return Promise.resolve();
    },
  });
}
function sessionManagerDouble() {
  const closes = [];
  const state = { occupied: false };
  return Object.freeze({ closes, state, get occupied() { return state.occupied; },
    close() { closes.push(1); state.occupied = false; return Promise.resolve(); } });
}
function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); } };
}

/**
 * harness({ policies, ... }) serves the given policy documents in order
 * (the last repeats) through a scripted same-origin fetch and a virtual clock.
 * `stopWork` is recorded; `events` collects (snapshot, change) pairs.
 */
function harness({ policies = [examplePolicy()], clock = createClock(), stopWork, preferences, appVersion, capabilities, activity = activityDouble(),
  sessionManager = sessionManagerDouble(), start = true } = {}) {
  // serve() restarts the script at the next request (the last step repeats).
  const served = { docs: [...policies], base: 0 };
  const scripted = scriptedFetch((call, index) => {
    const doc = served.docs[Math.min(index - served.base, served.docs.length - 1)];
    return doc instanceof Error ? doc : doc instanceof Response ? doc : policyResponse(serialized(doc));
  });
  const client = createPolicyClient({ fetch: scripted.fetch, location: 'https://gai-cmd.github.io/interp-app/', now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ...(appVersion ? { appVersion } : {}) });
  const stops = [];
  const runtime = createPolicyRuntime({ client, preferences: preferences ?? createPreferences({ storage: memoryStorage(), now: clock.now }),
    activity, sessionManager, now: clock.now, ...(appVersion ? { appVersion } : {}), ...(capabilities ? { capabilities } : {}),
    stopWork: stopWork === null ? null : async () => { stops.push(runtime.snapshot().blocked?.code ?? null); await stopWork?.(); } });
  const events = [];
  runtime.subscribe((snapshot, change) => events.push({ snapshot, change }));
  const serve = (...docs) => { served.docs = docs; served.base = scripted.calls.length; };
  return { client, runtime, clock, events, stops, activity, sessionManager, calls: scripted.calls, serve,
    started: start ? client.start() : null,
    async refresh(reason = 'manual') { await runtime.refresh({ reason }); await settle(); return runtime.snapshot(); },
    // The last policy-driven change; cleanup completion emits a separate 'status'.
    lastChange: () => events.filter((event) => event.change.type !== 'status').at(-1)?.change ?? null };
}

test('contract: PolicyError codes, action kinds, dictionaries and exports match architecture.md', () => {
  assert.deepEqual([...POLICY_ERROR_CODES], ['POLICY_LOADING', 'POLICY_UNAVAILABLE', 'POLICY_EXPIRED', 'POLICY_STOPPED',
    'POLICY_FEATURE_DISABLED', 'APP_VERSION_TOO_OLD', 'EVENT_ENDED', 'HUB_CONTROL_STOPPED', 'HUB_CONTROL_LOST']);
  for (const code of BLOCK_CODES) assert.ok(POLICY_ERROR_CODES.includes(code), code);
  for (const language of SUPPORTED_LANGUAGES) {
    for (const code of POLICY_ERROR_CODES) assert.equal(typeof dictionaries[language][`error.${code}`], 'string', `${language} error.${code}`);
    for (const key of ['policy.changed.stopped', 'policy.changed.reopened', 'policy.changed.display', 'policy.changed.pricing', 'policy.changed.updated']) {
      assert.equal(typeof dictionaries[language][key], 'string', `${language} ${key}`);
    }
  }
  assert.deepEqual([...ACTION_KINDS], ['seq.start', 'seq.retry', 'seq.replay', 'diagnostics', 'sim.direct', 'hub.join', 'event.join']);
  assert.deepEqual(Object.values(ACTIONS), [...ACTION_KINDS]);
  assert.deepEqual(Object.keys(ACTION_FEATURES).sort(), [...ACTION_KINDS].sort());
  assert.deepEqual(Object.keys(CAPABILITY_FEATURES).sort(), [...CAPABILITIES].sort());
  assert.deepEqual([...CLEANUP_STATES], ['idle', 'running', 'failed']);
  assert.ok(CHANGE_TYPES.includes('stopped') && CHANGE_TYPES.includes('reopened') && CHANGE_TYPES.includes('initial'));
  const error = new PolicyError('POLICY_STOPPED');
  assert.equal(error.name, 'PolicyError');
  assert.equal(error.code, 'POLICY_STOPPED');
  assert.equal(error.message, 'POLICY_STOPPED');
  assert.equal(new PolicyError('SECRET_UNKNOWN').code, 'POLICY_UNAVAILABLE', 'unknown codes never leak');
  assert.equal(new PolicyError('INVALID_KEY').code, 'POLICY_UNAVAILABLE', 'provider codes are not policy codes');
  assert.ok(isPolicyError(error));
  assert.ok(isPolicyError({ name: 'PolicyError', code: 'POLICY_EXPIRED' }), 'duck typing across module instances');
  assert.equal(isPolicyError({ name: 'PolicyError', code: 'INVALID_KEY' }), false);
  assert.equal(isPolicyError(new ProviderError('ABORTED')), false);
  assert.equal(isPolicyError(null), false);
  assert.equal(new ProviderError('POLICY_STOPPED').code, 'PROVIDER_ERROR', 'policy codes stay out of ERROR_CODES');
});

test('constructor validation and frozen surface', () => {
  const activity = activityDouble(), sessionManager = sessionManagerDouble();
  const clock = createClock();
  const client = createPolicyClient({ fetch: async () => policyResponse(), location: 'https://gai-cmd.github.io/interp-app/',
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  for (const bad of [{}, { client }, { client, activity }, { client, activity, sessionManager, now: 'x' },
    { client, activity, sessionManager, stopWork: 'x' }, { client: { snapshot() {} }, activity, sessionManager },
    { client, activity: { close() {} }, sessionManager }, { client, activity, sessionManager: {} }]) {
    assert.throws(() => createPolicyRuntime(bad), /POLICY_RUNTIME_INVALID/);
  }
  const runtime = createPolicyRuntime({ client, activity, sessionManager, now: clock.now });
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.snapshot()));
  assert.equal(runtime.appVersion, APP_VERSION);
  assert.throws(() => runtime.assertAction('start'), /POLICY_RUNTIME_INVALID/);
  assert.throws(() => runtime.assertAction('__proto__'), /POLICY_RUNTIME_INVALID/);
  assert.throws(() => runtime.subscribe(null), /POLICY_RUNTIME_INVALID/);
  assert.throws(() => runtime.refresh({ reason: 'start' }), /POLICY_RUNTIME_INVALID/);
  assert.throws(() => runtime.setEvent('Bad Id'), /POLICY_RUNTIME_INVALID/);
  runtime.close();
});

test('before the first reply every action is POLICY_LOADING; a valid policy opens the gate as an initial change, not a reopening', async () => {
  const h = harness();
  let snapshot = h.runtime.snapshot();
  assert.deepEqual(snapshot.blocked, { code: 'POLICY_LOADING', revision: null });
  assert.equal(snapshot.status, 'loading');
  assert.equal(snapshot.policy, null);
  for (const kind of ACTION_KINDS) assert.throws(() => h.runtime.assertAction(kind), policyError('POLICY_LOADING'));
  assert.throws(() => h.runtime.assertRoute({ providerId: 'gemini', capability: 'translate', keySource: 'personal', transport: 'direct' }),
    policyError('POLICY_LOADING'));
  assert.equal(h.calls.length, 1, 'the loading gate does not start extra requests');
  await h.started;
  snapshot = h.runtime.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.blocked, null);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.policy.revision, 1);
  for (const kind of ['seq.start', 'seq.retry', 'seq.replay', 'diagnostics', 'sim.direct', 'hub.join']) {
    assert.equal(h.runtime.assertAction(kind), snapshot, `${kind} passes and returns the snapshot`);
  }
  // sharedKeys is OFF in the §1.4 example: event join is the feature toggle, not an event state.
  assert.throws(() => h.runtime.assertAction('event.join'), policyError('POLICY_FEATURE_DISABLED'));
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].change.type, 'initial');
  assert.equal(h.events[0].change.stop, false);
  assert.equal(h.events[0].change.reopened, false);
  assert.deepEqual(h.stops, [], 'nothing to stop, nothing started');
  assert.equal(h.calls.length, 1);
  assert.equal(h.runtime.snapshot(), snapshot, 'same reference while nothing changed');
  h.runtime.close();
});

test('first fetch failure blocks with POLICY_UNAVAILABLE and kicks a preflight refresh; the next success opens the gate without auto-start', async () => {
  const h = harness({ policies: [new TypeError('network'), examplePolicy()] });
  await h.started;
  assert.equal(h.runtime.snapshot().status, 'failed');
  assert.deepEqual(h.runtime.snapshot().blocked, { code: 'POLICY_UNAVAILABLE', revision: null });
  assert.equal(h.calls.length, 1);
  assert.throws(() => h.runtime.assertAction('seq.start'), policyError('POLICY_UNAVAILABLE'));
  assert.equal(h.calls.length, 2, 'a blocked start retries the policy in the background (preflight)');
  assert.throws(() => h.runtime.assertAction('diagnostics'), policyError('POLICY_UNAVAILABLE'));
  assert.equal(h.calls.length, 2, 'the in-flight request is reused');
  await settle();
  assert.equal(h.runtime.snapshot().status, 'ready');
  assert.equal(h.runtime.snapshot().blocked, null);
  assert.equal(h.lastChange().type, 'initial', 'the first policy after a failure is initial, not a reopening');
  assert.equal(h.runtime.assertAction('seq.start').revision, 1);
  assert.equal(h.calls.length, 2, 'a ready policy does not refetch on every start');
  assert.deepEqual(h.stops.filter((code) => code !== 'POLICY_UNAVAILABLE'), []);
  h.runtime.close();
});

test('emergency stop: the gate closes before cleanup runs, activity, Live slot and stopWork are invoked once, late lifting only reopens', async () => {
  const order = [];
  const h = harness({ policies: [examplePolicy(), policyWith((p) => { p.revision = 2; p.emergency = { stopped: true, reason: trilingual('stop') }; })],
    stopWork: () => { order.push('stopWork'); } });
  await h.started;
  h.activity.state.occupied = true; h.activity.state.kind = 'sim';
  h.sessionManager.state.occupied = true;
  h.runtime.subscribe((snapshot, change) => { if (change.stop) order.push(`gate:${snapshot.blocked.code}`); });
  h.clock.advance(MINUTE);
  await settle();
  const snapshot = h.runtime.snapshot();
  assert.deepEqual(snapshot.blocked, { code: 'POLICY_STOPPED', revision: 2 });
  assert.equal(snapshot.policy.emergency.reason.ko, 'stop 한국어');
  assert.deepEqual(h.stops, ['POLICY_STOPPED'], 'stopWork saw the closed gate');
  assert.deepEqual(h.activity.closes, ['sim']);
  assert.equal(h.sessionManager.closes.length, 1);
  assert.deepEqual(order, ['stopWork', 'gate:POLICY_STOPPED']);
  const stopped = h.events.find((event) => event.change.type === 'stopped');
  assert.ok(stopped);
  assert.equal(stopped.change.stop, true);
  assert.equal(stopped.change.revisionChanged, true);
  assert.equal(h.runtime.snapshot().cleanup, 'idle');
  for (const kind of ACTION_KINDS) assert.throws(() => h.runtime.assertAction(kind), policyError('POLICY_STOPPED'));
  assert.throws(() => h.runtime.assertRoute({ providerId: 'gemini', capability: 'translate', keySource: 'personal', transport: 'direct' }),
    policyError('POLICY_STOPPED'));
  // Lifting: a new revision without the stop. Nothing is started, nothing is stopped again.
  h.serve(policyWith((p) => { p.revision = 3; }));
  await h.refresh();
  assert.equal(h.runtime.snapshot().blocked, null);
  assert.equal(h.lastChange().type, 'reopened');
  assert.equal(h.lastChange().reopened, true);
  assert.equal(h.lastChange().stop, false);
  assert.equal(h.stops.length, 1);
  assert.equal(h.activity.closes.length, 1);
  assert.equal(h.runtime.assertAction('sim.direct').revision, 3);
  h.runtime.close();
});

test('a cleanup that fails or hangs is recorded, never turned into success or a forced release', async () => {
  const h = harness({ policies: [examplePolicy(), policyWith((p) => { p.revision = 2; p.emergency.stopped = true; })], stopWork: null });
  await h.started;
  h.activity.state.occupied = true; h.activity.state.kind = 'hub';
  h.activity.state.failure = new ProviderError('SESSION_CLOSED');
  await h.refresh();
  assert.equal(h.runtime.snapshot().blocked.code, 'POLICY_STOPPED');
  assert.equal(h.runtime.snapshot().cleanup, 'failed');
  assert.equal(h.activity.occupied, true, 'the slot stays occupied: the runtime does not release it');
  assert.deepEqual(h.activity.closes, ['hub']);
  const statuses = h.events.map((event) => `${event.change.type}:${event.snapshot.cleanup}`);
  assert.ok(statuses.includes('stopped:running'), statuses.join());
  assert.ok(statuses.includes('status:failed'), statuses.join());
  // Lifting the stop does not clear the recorded failure either.
  h.serve(policyWith((p) => { p.revision = 3; }));
  await h.refresh();
  assert.equal(h.runtime.snapshot().cleanup, 'failed');
  assert.equal(h.runtime.snapshot().blocked, null);
  h.runtime.close();
});

test('minimum version, validUntil and the 5-minute validity each block with their own code and stop running work', async () => {
  const old = harness({ policies: [policyWith((p) => { p.minAppVersion = '9.0.0'; })] });
  await old.started;
  assert.deepEqual(old.runtime.snapshot().blocked, { code: 'APP_VERSION_TOO_OLD', revision: 1 });
  assert.throws(() => old.runtime.assertAction('seq.start'), policyError('APP_VERSION_TOO_OLD'));
  assert.equal(old.runtime.snapshot().features.sequential.enabled, true, 'features stay readable for the settings screen');
  old.runtime.close();

  // validUntil two minutes out: the client's expiry timer fires inside the
  // 5-minute validity window (beyond it, age wins: POLICY_UNAVAILABLE).
  const expiring = harness({ policies: [policyWith((p) => { p.validUntil = new Date(START + 2 * MINUTE).toISOString(); })] });
  await expiring.started;
  expiring.activity.state.occupied = true; expiring.activity.state.kind = 'sim';
  assert.equal(expiring.runtime.snapshot().blocked, null);
  expiring.clock.advance(2 * MINUTE);
  assert.deepEqual(expiring.runtime.snapshot().blocked, { code: 'POLICY_EXPIRED', revision: 1 });
  assert.equal(expiring.runtime.snapshot().status, 'expired');
  assert.deepEqual(expiring.stops, ['POLICY_EXPIRED'], 'the expiry timer ends running work at once');
  assert.deepEqual(expiring.activity.closes, ['sim']);
  await settle();
  assert.deepEqual(expiring.stops, ['POLICY_EXPIRED'], 'the pending 60 s tick with the same policy does not stop again');
  assert.throws(() => expiring.runtime.assertAction('sim.direct'), policyError('POLICY_EXPIRED'));
  expiring.runtime.close();

  const stale = harness({ policies: [examplePolicy(), new TypeError('network')] });
  await stale.started;
  stale.activity.state.occupied = true; stale.activity.state.kind = 'sim';
  stale.clock.advance(MINUTE);
  await settle();
  assert.equal(stale.runtime.snapshot().status, 'stale');
  assert.equal(stale.runtime.snapshot().blocked, null, 'the last policy stays authority within 5 minutes');
  const before = stale.calls.length;
  stale.runtime.assertAction('seq.start');
  assert.equal(stale.calls.length, before + 1, 'a stale policy triggers a preflight recheck');
  stale.clock.advance(5 * MINUTE);
  await settle();
  assert.deepEqual(stale.runtime.snapshot().blocked, { code: 'POLICY_UNAVAILABLE', revision: 1 });
  assert.equal(stale.runtime.snapshot().status, 'failed');
  assert.deepEqual(stale.stops, ['POLICY_UNAVAILABLE'], 'no revalidation for 5 minutes ends running work');
  assert.throws(() => stale.runtime.assertAction('hub.join'), policyError('POLICY_UNAVAILABLE'));
  stale.runtime.close();
});

test('feature toggles gate their actions and stop only the activity that depends on them', async () => {
  const off = (name, revision = 2) => policyWith((p) => { p.revision = revision; p.features[name] = false; });
  const h = harness({ policies: [examplePolicy(), off('sequential')] });
  await h.started;
  h.activity.state.occupied = true; h.activity.state.kind = 'hub';
  await h.refresh();
  assert.equal(h.runtime.snapshot().features.sequential.reasonKey, 'policy.featureOff');
  for (const kind of ['seq.start', 'seq.retry', 'seq.replay']) assert.throws(() => h.runtime.assertAction(kind), policyError('POLICY_FEATURE_DISABLED'));
  for (const kind of ['diagnostics', 'sim.direct', 'hub.join']) h.runtime.assertAction(kind);
  assert.equal(h.lastChange().type, 'updated', 'hub listening is unaffected by the sequential toggle');
  assert.deepEqual(h.stops, []);
  // A sequential turn holds no activity lease: kind null counts as sequential.
  h.activity.state.kind = null; h.activity.state.occupied = false;
  h.serve(off('sequential', 3), off('hubListen', 4));
  await h.refresh();
  assert.equal(h.lastChange().type, 'updated', 'already off: no new stop');
  h.serve(policyWith((p) => { p.revision = 5; }));
  await h.refresh();
  assert.equal(h.lastChange().type, 'reopened');
  h.serve(off('sequential', 6));
  await h.refresh();
  assert.equal(h.lastChange().type, 'stopped');
  assert.deepEqual(h.stops, [null], 'stopWork ran while the gate itself stays open for other features');
  h.serve(policyWith((p) => { p.revision = 7; }));
  await h.refresh();
  h.activity.state.occupied = true; h.activity.state.kind = 'hub';
  h.serve(off('hubListen', 8));
  await h.refresh();
  assert.equal(h.lastChange().type, 'stopped');
  assert.deepEqual(h.activity.closes, ['hub']);
  assert.throws(() => h.runtime.assertAction('hub.join'), policyError('POLICY_FEATURE_DISABLED'));
  h.serve(policyWith((p) => { p.revision = 9; p.features.diagnostics = false; p.features.simultaneousDirect = false; }));
  await h.refresh();
  assert.throws(() => h.runtime.assertAction('diagnostics'), policyError('POLICY_FEATURE_DISABLED'));
  assert.throws(() => h.runtime.assertAction('sim.direct'), policyError('POLICY_FEATURE_DISABLED'));
  assert.throws(() => h.runtime.assertRoute({ providerId: 'gemini', capability: 'live', keySource: 'personal', transport: 'direct' }),
    policyError('POLICY_FEATURE_DISABLED'), 'live has no enabled feature once direct Live and diagnostics are off');
  h.runtime.assertRoute({ providerId: 'gemini', capability: 'translate', keySource: 'personal', transport: 'direct' });
  h.runtime.close();
});

test('forced run settings end interpretation, display settings only redraw, pricing and plain revisions are announced, widening reopens', async () => {
  const h = harness();
  await h.started;
  h.activity.state.occupied = true; h.activity.state.kind = 'sim';
  h.serve(policyWith((p) => { p.revision = 2; p.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: true }; }));
  await h.refresh();
  assert.equal(h.lastChange().type, 'display');
  assert.equal(h.lastChange().display, true);
  assert.equal(h.lastChange().stop, false);
  assert.equal(h.runtime.snapshot().settings['ui.tone'].source, 'forced');
  assert.deepEqual(h.stops, []);
  h.serve(policyWith((p) => { p.revision = 3; p.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: true };
    p.settings['interpretation.targetLanguage'] = { default: 'en', allowed: ['en'], locked: true }; }));
  await h.refresh();
  assert.equal(h.lastChange().type, 'stopped');
  assert.deepEqual(h.stops, [null]);
  assert.equal(h.runtime.snapshot().settings['interpretation.targetLanguage'].value, 'en');
  assert.equal(h.runtime.snapshot().blocked, null, 'a forced value is not a block: a new start with the forced value is allowed');
  h.runtime.assertAction('sim.direct');
  // Hub listening does not use the interpretation pair: no stop for it.
  h.activity.state.kind = 'hub';
  const pair = (p) => {
    p.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: true };
    p.settings['interpretation.sourceLanguage'] = { default: 'en', allowed: ['auto', 'ko', 'en', 'ja'], locked: false };
    p.settings['interpretation.targetLanguage'] = { default: 'ko', allowed: ['ko'], locked: true };
  };
  h.serve(policyWith((p) => { p.revision = 4; pair(p); }));
  await h.refresh();
  assert.equal(h.runtime.snapshot().settings['interpretation.targetLanguage'].value, 'ko');
  assert.equal(h.lastChange().type, 'updated');
  assert.equal(h.stops.length, 1);
  h.serve(policyWith((p) => { p.revision = 5; pair(p); p.pricing.revision = 2; }));
  await h.refresh();
  assert.equal(h.lastChange().type, 'pricing');
  assert.equal(h.lastChange().pricing, true);
  h.serve(policyWith((p) => { p.revision = 6; pair(p); p.settings['interpretation.targetLanguage'] = { default: 'ko', allowed: ['ko', 'en'], locked: false }; p.pricing.revision = 2; }));
  await h.refresh();
  assert.equal(h.lastChange().type, 'reopened', 'lifting a lock and widening the allowed set reopen');
  assert.equal(h.stops.length, 1, 'nothing restarts');
  h.runtime.close();
});

test('personal choices recompute effective values without stopping anything; the store is never written by the runtime', async () => {
  const storage = memoryStorage();
  const preferences = createPreferences({ storage, now: () => START });
  const h = harness({ preferences });
  await h.started;
  h.activity.state.occupied = true; h.activity.state.kind = 'sim';
  assert.equal(h.runtime.snapshot().settings['voice.output'].source, 'policyDefault');
  preferences.set('voice.output', 'off');
  assert.equal(h.lastChange().type, 'preference');
  assert.equal(h.lastChange().stop, false);
  assert.deepEqual(h.stops, []);
  assert.equal(h.runtime.snapshot().settings['voice.output'].value, 'off');
  assert.equal(h.runtime.snapshot().settings['voice.output'].source, 'personal');
  assert.deepEqual(Object.keys(Object.fromEntries([...Object.entries(preferences.snapshot())].filter(([, value]) => value !== null))), ['voice.output']);
  h.runtime.close();
});

test('event join and shared routes follow the joined event: active passes, expired or removed is EVENT_ENDED and stops work', async () => {
  const active = exampleEvent({ enabled: true, startsAt: new Date(START - MINUTE).toISOString(), expiresAt: new Date(START + 2 * MINUTE).toISOString() });
  const withEvent = (revision, mutate = () => {}) => policyWith((p) => { p.revision = revision; p.features.sharedKeys = true; p.sharedEvents = [active]; mutate(p); });
  const h = harness({ policies: [withEvent(1)] });
  await h.started;
  const route = (overrides = {}) => ({ providerId: 'gemini', capability: 'translate', keySource: 'shared', transport: 'direct', ...overrides });
  assert.throws(() => h.runtime.assertAction('event.join'), policyError('EVENT_ENDED'), 'no event joined yet');
  h.runtime.assertRoute(route());
  assert.equal(h.runtime.setEvent('service-20260906').event.status, 'active');
  assert.equal(h.runtime.snapshot().eventId, 'service-20260906');
  assert.equal(h.lastChange().type, 'event');
  h.runtime.assertAction('event.join');
  h.runtime.assertRoute(route());
  assert.throws(() => h.runtime.assertRoute(route({ capability: 'live' })), policyError('POLICY_FEATURE_DISABLED'), 'live is never a shared capability');
  assert.throws(() => h.runtime.assertRoute(route({ providerId: 'other' })), policyError('POLICY_FEATURE_DISABLED'));
  h.runtime.assertRoute(route({ keySource: 'personal', capability: 'live' }));
  assert.equal(h.runtime.setEvent('service-20260906'), h.runtime.snapshot(), 'same event: no recomputation');
  // The event expires by the clock: the gate sees it at once (time is part of
  // the snapshot), the joined route ends on the next policy notification and
  // personal routes continue.
  h.activity.state.occupied = true; h.activity.state.kind = 'sim';
  h.clock.advance(2 * MINUTE);
  assert.equal(h.runtime.snapshot().event.status, 'expired');
  assert.throws(() => h.runtime.assertRoute(route()), policyError('EVENT_ENDED'));
  await settle();
  assert.equal(h.lastChange().type, 'stopped');
  assert.deepEqual(h.stops, [null]);
  assert.throws(() => h.runtime.assertAction('event.join'), policyError('EVENT_ENDED'));
  h.runtime.assertRoute(route({ keySource: 'personal' }));
  await settle(); // the preflight recheck the blocked calls kicked off lands
  // Removed from the list, then sharedKeys off: still EVENT_ENDED / feature disabled.
  h.serve(withEvent(3, (p) => { p.sharedEvents = []; }));
  await h.refresh();
  assert.equal(h.runtime.snapshot().event.status, 'removed');
  assert.throws(() => h.runtime.assertRoute(route()), policyError('EVENT_ENDED'));
  h.serve(policyWith((p) => { p.revision = 4; }));
  await h.refresh();
  assert.throws(() => h.runtime.assertRoute(route()), policyError('POLICY_FEATURE_DISABLED'));
  assert.equal(h.runtime.setEvent(null).eventId, null);
  assert.equal(h.runtime.snapshot().event, null);
  h.runtime.close();
});

test('hub control only restricts: stop latch and lost heartbeat block with their codes and end work; clearing reopens', async () => {
  const h = harness();
  await h.started;
  h.activity.state.occupied = true; h.activity.state.kind = 'hub';
  h.runtime.setHubControl({ supported: true, eventId: 'service-20260906', epoch: 1, revision: 2, stopped: true, heartbeatLost: false,
    disabledFeatures: ['sequential', 'bogus'], notice: 'SECRET', expiresAt: null });
  assert.deepEqual(h.runtime.snapshot().blocked, { code: 'HUB_CONTROL_STOPPED', revision: 1 });
  assert.equal(h.lastChange().type, 'stopped');
  assert.deepEqual(h.stops, ['HUB_CONTROL_STOPPED']);
  assert.deepEqual(h.runtime.snapshot().hubControl.disabledFeatures, ['sequential']);
  assert.equal(h.runtime.snapshot().hubControl.notice, undefined, 'only documented fields are kept');
  assert.throws(() => h.runtime.assertAction('hub.join'), policyError('HUB_CONTROL_STOPPED'));
  h.runtime.setHubControl({ supported: true, stopped: false, heartbeatLost: true, disabledFeatures: ['sequential'] });
  assert.equal(h.runtime.snapshot().blocked.code, 'HUB_CONTROL_LOST');
  assert.deepEqual(h.stops, ['HUB_CONTROL_STOPPED', 'HUB_CONTROL_LOST'], 'a different block reason runs the cleanup path again (idempotent for the owners)');
  assert.throws(() => h.runtime.assertAction('seq.start'), policyError('HUB_CONTROL_LOST'));
  h.runtime.setHubControl({ supported: true, stopped: false, heartbeatLost: false, disabledFeatures: ['sequential'] });
  assert.equal(h.runtime.snapshot().blocked, null);
  assert.equal(h.runtime.snapshot().features.sequential.reasonKey, 'hubControl.stopped');
  assert.throws(() => h.runtime.assertAction('seq.start'), policyError('POLICY_FEATURE_DISABLED'));
  h.runtime.assertAction('hub.join');
  h.runtime.setHubControl(null);
  assert.equal(h.runtime.snapshot().hubControl, null);
  assert.equal(h.lastChange().type, 'reopened');
  assert.equal(h.stops.length, 2, 'clearing never restarts or stops');
  h.runtime.close();
});

test('close() detaches from the client and the store; the gate answers POLICY_UNAVAILABLE afterwards and refresh still resolves', async () => {
  const h = harness();
  await h.started;
  const count = h.events.length;
  h.runtime.close();
  h.runtime.close();
  h.serve(policyWith((p) => { p.revision = 2; p.emergency.stopped = true; }));
  await h.client.refresh({ reason: 'manual' });
  await settle();
  assert.equal(h.client.snapshot().revision, 2, 'the client keeps working on its own');
  assert.equal(h.events.length, count, 'no events after close');
  assert.throws(() => h.runtime.assertAction('seq.start'), policyError('POLICY_UNAVAILABLE'));
  assert.equal(typeof (await h.runtime.refresh()).status, 'string');
  assert.deepEqual(h.stops, []);
});

test('router boundary: the policy guard runs before any credential lookup and its PolicyError is not normalized; without a guard nothing changes', async () => {
  const definition = provider();
  const calls = [], lookups = [];
  const registry = createRegistry();
  registry.register(definition, adapter(calls));
  const guardCalls = [];
  const policy = { assertRoute(route) {
    guardCalls.push(route);
    if (route.keySource === 'shared') throw new PolicyError('POLICY_FEATURE_DISABLED');
    if (route.capability === 'stt') throw new PolicyError('POLICY_STOPPED');
  } };
  const router = createRouter({ registry, policy, getCredentialRef(address) { lookups.push(address); return credentialRef(address); } });
  await router.call('translate', textRequest(), routeContext());
  assert.deepEqual(guardCalls, [{ providerId: 'alpha', keySource: 'personal', transport: 'direct', capability: 'translate' }]);
  assert.equal(calls.length, 1);
  await assert.rejects(router.call('translate', textRequest(), routeContext({ keySource: 'shared' })), policyError('POLICY_FEATURE_DISABLED'));
  await assert.rejects(router.call('stt', { input: { format: 'wav', audio: new Uint8Array() } }, routeContext()), policyError('POLICY_STOPPED'));
  assert.equal(lookups.length, 1, 'blocked routes never look a credential up');
  assert.equal(calls.length, 1, 'blocked routes never reach the adapter');
  // Provider errors still normalize; capability errors are checked before the guard.
  await assert.rejects(router.call('translate', { input: { format: 'wav' } }, routeContext()), providerError('INPUT_UNSUPPORTED'));
  assert.equal(guardCalls.length, 3);
  assert.throws(() => createRouter({ registry, getCredentialRef: credentialRef, policy: {} }), providerError('INVALID_REQUEST'));
  const plain = createRouter({ registry, getCredentialRef: credentialRef });
  await plain.call('translate', textRequest(), routeContext({ keySource: 'shared' }));
  assert.equal(calls.length, 2);
});

test('createAppConfig hands the policy guard to the router and exposes it; the P1 default has none', async () => {
  const guardCalls = [];
  const policy = { assertRoute(route) { guardCalls.push(route); throw new PolicyError('POLICY_LOADING'); } };
  const config = createAppConfig({ fetch: async () => { throw new Error('unexpected'); }, policy });
  assert.equal(config.policy, policy);
  config.keyStore.setPersonal('gemini', 'synthetic-config-credential');
  config.keyStore.select('gemini', 'personal');
  const controller = new AbortController();
  await assert.rejects(config.router.call('translate', { input: { format: 'text', text: 'hi' }, targetLanguage: 'ja' },
    { providerId: 'gemini', keySource: 'personal', transport: 'direct', signal: controller.signal, generation: 0, turnId: 't', sessionId: 's',
      budget: { consume() {} } }), policyError('POLICY_LOADING'));
  assert.deepEqual(guardCalls, [{ providerId: 'gemini', keySource: 'personal', transport: 'direct', capability: 'translate' }]);
  await config.dispose();
  const plain = createAppConfig({ fetch: async () => { throw new Error('unexpected'); } });
  assert.equal(plain.policy, null);
  await plain.dispose();
  assert.throws(() => createAppConfig({ policy: { assertRoute: 'no' } }), providerError('INVALID_REQUEST'));
});
