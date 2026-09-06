import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BLOCK_CODES, EVENT_STATUSES, FEATURE_CAPABILITIES, REASON_KEYS, SETTING_SOURCES, resolveEffective,
} from '../app/policy/resolve.js';
import { REGISTERED_FEATURES, REGISTERED_SETTINGS, validatePolicy } from '../app/policy/schema.js';
import { createPreferences } from '../app/preferences.js';
import { APP_VERSION } from '../app/version.js';
import { CAPABILITIES } from '../app/providers/contract.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { REGISTERED_HUB_IDS, exampleEvent, examplePolicy, fullPolicy, policyWith } from './fixtures/policy.mjs';

// P3-05: resolveEffective is a pure function of (policy, personal choices,
// event, hub control, capabilities). It computes the allowed range, forced
// value, default, source and lock reason per setting and never writes back
// to the preference store.

const options = { registeredHubIds: REGISTERED_HUB_IDS };
const NOW = Date.parse('2026-09-06T01:00:00Z');
const NAMES = Object.keys(REGISTERED_SETTINGS);
const validated = (policy) => {
  const result = validatePolicy(policy, options);
  assert.deepEqual(result.ok ? [] : result.issues, []);
  return result.policy;
};
const example = validated(examplePolicy());
const resolve = (overrides = {}) => resolveEffective({ policy: example, now: NOW, ...overrides });
function assertDeepFrozen(value, path = 'result') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), path);
  for (const [key, item] of Object.entries(value)) assertDeepFrozen(item, `${path}.${key}`);
}
function spyStorage() {
  const map = new Map();
  const writes = [];
  return {
    map, writes,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { writes.push(['setItem', key]); map.set(key, String(value)); },
    removeItem: (key) => { writes.push(['removeItem', key]); map.delete(key); },
  };
}

test('example policy without personal choices: policy defaults, full ranges, no locks, all features on, nothing blocked', () => {
  const result = resolve();
  assert.deepEqual(Object.keys(result), ['blocked', 'settings', 'features', 'event']);
  assert.equal(result.blocked, null);
  assert.equal(result.event, null);
  assert.deepEqual(Object.keys(result.settings), NAMES, 'exactly the registered settings, in schema order');
  for (const name of NAMES) {
    const spec = REGISTERED_SETTINGS[name];
    const setting = result.settings[name];
    assert.deepEqual(Object.keys(setting), ['value', 'source', 'allowed', 'locked', 'reasonKey']);
    assert.equal(setting.value, spec.default, name);
    assert.equal(setting.source, 'policyDefault', name);
    assert.equal(setting.locked, false, name);
    assert.equal(setting.reasonKey, null, name);
    if (spec.kind === 'enum') assert.deepEqual(setting.allowed, [...spec.values], name);
    else assert.deepEqual(setting.allowed, { min: spec.min, max: spec.max, step: spec.step }, name);
    assert.ok(SETTING_SOURCES.includes(setting.source));
  }
  assert.deepEqual(Object.keys(result.features), [...REGISTERED_FEATURES]);
  // The example ships sharedKeys: false; every other toggle is on.
  for (const name of REGISTERED_FEATURES) {
    assert.deepEqual(result.features[name], name === 'sharedKeys'
      ? { enabled: false, reasonKey: 'policy.featureOff' } : { enabled: true, reasonKey: null }, name);
  }
  assertDeepFrozen(result);
  assert.deepEqual(resolve(), result, 'pure: same inputs, same output');
  assert.deepEqual(resolveEffective({ policy: example, now: () => NOW }), result, 'now may be a clock function');
  assert.deepEqual(resolveEffective({ policy: example, preferences: undefined, now: NOW }), result);
  assert.deepEqual(resolveEffective({ policy: example, preferences: null, now: NOW }), result);
});

test('personal choices inside the allowed range win with source personal, even when equal to the default', () => {
  const preferences = { 'ui.mode': 'dark', 'ui.tone': 'navy', 'ui.text': 'xl', 'captions.size': 1.125,
    'interpretation.sourceLanguage': 'auto', 'interpretation.targetLanguage': 'en', 'voice.output': 'off', 'billing.plan': 'paid' };
  const result = resolve({ preferences });
  for (const name of NAMES) {
    assert.equal(result.settings[name].value, preferences[name], name);
    assert.equal(result.settings[name].source, 'personal', name);
    assert.equal(result.settings[name].locked, false, name);
    assert.equal(result.settings[name].reasonKey, null, name);
  }
  // Stored string forms (as read from localStorage) are interpreted the same way.
  assert.equal(resolve({ preferences: { 'captions.size': '1.125' } }).settings['captions.size'].value, 1.125);
});

test('corrupt or foreign personal values are ignored and ui.language / audio.* never reach the result', () => {
  const preferences = { 'ui.mode': 'DARK', 'ui.tone': ['warm'], 'ui.text': 7, 'captions.size': 'NaN',
    'interpretation.sourceLanguage': 'zh', 'interpretation.targetLanguage': 'auto', 'voice.output': null,
    'billing.plan': { plan: 'paid' }, 'ui.language': 'ja', 'audio.inputDeviceId': 'mic-1', 'audio.outputDeviceId': 'spk-1',
    '__proto__': { 'ui.mode': 'dark' }, 'usage.rates': [], 'settings.ui.mode': 'dark' };
  const result = resolve({ preferences });
  assert.deepEqual(result.settings, resolve().settings, 'every corrupt choice falls back to the policy default');
  assert.equal(Object.hasOwn(result.settings, 'ui.language'), false);
  assert.equal(Object.hasOwn(result.settings, 'audio.inputDeviceId'), false);
  assert.equal(JSON.stringify(result).includes('mic-1'), false, 'device IDs never leave the device store');
  assert.equal(JSON.stringify(result).includes('spk-1'), false);
});

test('restricted ranges: a personal choice outside the range falls back to the policy default and the choice itself is untouched', () => {
  const policy = validated(policyWith((draft) => {
    draft.settings['ui.tone'] = { default: 'warm', allowed: ['warm', 'forest'], locked: false };
    draft.settings['ui.text'] = { default: 'l', allowed: ['m', 'l', 'xl'], locked: false };
    draft.settings['captions.size'] = { default: 1.75, min: 1.25, max: 2, step: 0.25, locked: false };
  }));
  const storage = spyStorage();
  const store = createPreferences({ storage });
  store.set('ui.tone', 'navy');
  store.set('ui.text', 'xl');
  store.set('captions.size', 1.5);
  storage.writes.length = 0;
  const result = resolveEffective({ policy, preferences: store, now: NOW });
  assert.deepEqual(result.settings['ui.tone'], { value: 'warm', source: 'policyDefault', allowed: ['warm', 'forest'], locked: false, reasonKey: 'policy.lock.restricted' });
  assert.deepEqual(result.settings['ui.text'], { value: 'xl', source: 'personal', allowed: ['m', 'l', 'xl'], locked: false, reasonKey: 'policy.lock.restricted' });
  assert.deepEqual(result.settings['captions.size'], { value: 1.5, source: 'personal', allowed: { min: 1.25, max: 2, step: 0.25 }, locked: false, reasonKey: 'policy.lock.restricted' });
  assert.deepEqual(storage.writes, [], 'the resolver never writes the effective value into the store');
  assert.equal(store.get('ui.tone'), 'navy', 'personal choice preserved for when the restriction is lifted');
  // Restriction lifted: the same store now yields the original choice again.
  assert.equal(resolveEffective({ policy: example, preferences: store, now: NOW }).settings['ui.tone'].value, 'navy');
  assert.equal(resolveEffective({ policy: example, preferences: store, now: NOW }).settings['ui.tone'].source, 'personal');
  // Numbers: below min, above max and off the policy grid all fall back; on-grid inside stays.
  for (const [size, expected] of [[1, 1.75], [1.125, 1.75], [1.375, 1.75], [1.75, 1.75], [2, 2]]) {
    const setting = resolveEffective({ policy, preferences: { 'captions.size': size }, now: NOW }).settings['captions.size'];
    assert.equal(setting.value, expected, String(size));
    assert.equal(setting.source, expected === size ? 'personal' : 'policyDefault', String(size));
  }
});

test('locked settings force the policy default with the forced source and lock reason, whatever the personal choice', () => {
  const policy = validated(fullPolicy()); // ui.tone: mono only, locked
  const locked = validated(policyWith((draft) => {
    draft.emergency = { stopped: false, reason: null };
    draft.settings['ui.mode'] = { default: 'light', allowed: ['system', 'light', 'dark'], locked: true };
    draft.settings['captions.size'] = { default: 1.5, min: 1, max: 2, step: 0.125, locked: true };
    draft.settings['billing.plan'] = { default: 'free', allowed: ['free', 'paid'], locked: true };
  }));
  const preferences = { 'ui.mode': 'dark', 'ui.tone': 'navy', 'captions.size': 2, 'billing.plan': 'paid' };
  const result = resolveEffective({ policy: locked, preferences, now: NOW });
  assert.deepEqual(result.settings['ui.mode'], { value: 'light', source: 'forced', allowed: ['system', 'light', 'dark'], locked: true, reasonKey: 'policy.lock.forced' });
  assert.deepEqual(result.settings['captions.size'], { value: 1.5, source: 'forced', allowed: { min: 1, max: 2, step: 0.125 }, locked: true, reasonKey: 'policy.lock.forced' });
  assert.deepEqual(result.settings['billing.plan'], { value: 'free', source: 'forced', allowed: ['free', 'paid'], locked: true, reasonKey: 'policy.lock.forced' });
  assert.equal(result.settings['ui.tone'].source, 'personal');
  // fullPolicy is emergency-stopped, so it is blocked, but settings still resolve for the UI.
  const stopped = resolveEffective({ policy, preferences, now: NOW, appVersion: '0.7.0' });
  assert.deepEqual(stopped.blocked, { code: 'POLICY_STOPPED', revision: 7 });
  assert.deepEqual(stopped.settings['ui.tone'], { value: 'mono', source: 'forced', allowed: ['mono'], locked: true, reasonKey: 'policy.lock.forced' });
  // 2 sits on the narrowed grid (1.25 + 3 × 0.25), so the personal choice stays.
  assert.deepEqual(stopped.settings['captions.size'], { value: 2, source: 'personal', allowed: { min: 1.25, max: 2, step: 0.25 }, locked: false, reasonKey: 'policy.lock.restricted' });
  assert.equal(resolveEffective({ policy, preferences: { 'captions.size': 1.125 }, now: NOW }).settings['captions.size'].value, 1.75);
});

test('a single allowed option (or min === max) is shown as locked with the singleOption reason', () => {
  const policy = validated(policyWith((draft) => {
    draft.settings['voice.output'] = { default: 'device', allowed: ['device'], locked: false };
    draft.settings['captions.size'] = { default: 1.5, min: 1.5, max: 1.5, step: 0.125, locked: false };
  }));
  const result = resolveEffective({ policy, preferences: { 'voice.output': 'device', 'captions.size': 1.5 }, now: NOW });
  assert.deepEqual(result.settings['voice.output'], { value: 'device', source: 'forced', allowed: ['device'], locked: true, reasonKey: 'policy.lock.singleOption' });
  assert.deepEqual(result.settings['captions.size'], { value: 1.5, source: 'forced', allowed: { min: 1.5, max: 1.5, step: 0.125 }, locked: true, reasonKey: 'policy.lock.singleOption' });
  const other = resolveEffective({ policy, preferences: { 'voice.output': 'provider' }, now: NOW });
  assert.equal(other.settings['voice.output'].value, 'device');
  assert.equal(other.settings['voice.output'].source, 'forced');
});

test('the language pair never resolves to the same language twice: the colliding personal choice drops to the default, target first', () => {
  const pair = (result) => [result.settings['interpretation.sourceLanguage'], result.settings['interpretation.targetLanguage']];
  // Both personal and equal: target falls back to the policy default (ja).
  let [source, target] = pair(resolve({ preferences: { 'interpretation.sourceLanguage': 'en', 'interpretation.targetLanguage': 'en' } }));
  assert.deepEqual([source.value, source.source, target.value, target.source], ['en', 'personal', 'ja', 'policyDefault']);
  // Personal source equals the policy target default: target keeps its personal value.
  [source, target] = pair(resolve({ preferences: { 'interpretation.sourceLanguage': 'ja', 'interpretation.targetLanguage': 'ko' } }));
  assert.deepEqual([source.value, target.value], ['ja', 'ko']);
  // Personal target equals the default source (ko), no personal source: source drops? No: only personal choices move.
  [source, target] = pair(resolve({ preferences: { 'interpretation.targetLanguage': 'ko' } }));
  assert.deepEqual([source.value, source.source, target.value, target.source], ['ko', 'policyDefault', 'ja', 'policyDefault']);
  // auto never collides.
  [source, target] = pair(resolve({ preferences: { 'interpretation.sourceLanguage': 'auto', 'interpretation.targetLanguage': 'ja' } }));
  assert.deepEqual([source.value, target.value], ['auto', 'ja']);
  // Forced source 'en' with personal target 'en': target falls back to the policy default, which validation keeps different.
  const forcedSource = validated(policyWith((draft) => {
    draft.settings['interpretation.sourceLanguage'] = { default: 'en', allowed: ['auto', 'ko', 'en', 'ja'], locked: true };
  }));
  [source, target] = pair(resolveEffective({ policy: forcedSource, preferences: { 'interpretation.targetLanguage': 'en' }, now: NOW }));
  assert.deepEqual([source.value, source.source, target.value, target.source], ['en', 'forced', 'ja', 'policyDefault']);
  // Forced target 'ko' with personal source 'ko': the source falls back instead.
  const forcedTarget = validated(policyWith((draft) => {
    draft.settings['interpretation.targetLanguage'] = { default: 'ko', allowed: ['ko'], locked: false };
    draft.settings['interpretation.sourceLanguage'] = { default: 'ja', allowed: ['auto', 'ko', 'en', 'ja'], locked: false };
  }));
  [source, target] = pair(resolveEffective({ policy: forcedTarget, preferences: { 'interpretation.sourceLanguage': 'ko' }, now: NOW }));
  assert.deepEqual([source.value, source.source, target.value, target.source], ['ja', 'policyDefault', 'ko', 'forced']);
  // Without a policy the app defaults (ko -> ja) settle the pair the same way.
  [source, target] = pair(resolveEffective({ policy: null, preferences: { 'interpretation.sourceLanguage': 'ja', 'interpretation.targetLanguage': 'ja' }, now: NOW }));
  assert.deepEqual([source.value, source.source, target.value, target.source], ['ko', 'appDefault', 'ja', 'appDefault']);
  for (const language of SUPPORTED_LANGUAGES) {
    for (const other of SUPPORTED_LANGUAGES) {
      const [s, t] = pair(resolve({ preferences: { 'interpretation.sourceLanguage': language, 'interpretation.targetLanguage': other } }));
      assert.notEqual(s.value, t.value, `${language}/${other}`);
    }
  }
});

test('no usable policy: blocked POLICY_UNAVAILABLE, app defaults or personal choices with full ranges, features off', () => {
  for (const policy of [null, undefined, {}, { schemaVersion: 2 }, 'policy', validatePolicy({}), { ok: true, policy: example }]) {
    const result = resolveEffective({ policy, preferences: { 'ui.mode': 'dark', 'captions.size': 1.25 }, now: NOW });
    assert.deepEqual(result.blocked, { code: 'POLICY_UNAVAILABLE', revision: null });
    assert.deepEqual(result.settings['ui.mode'], { value: 'dark', source: 'personal', allowed: ['system', 'light', 'dark'], locked: false, reasonKey: null });
    assert.deepEqual(result.settings['ui.tone'], { value: 'navy', source: 'appDefault', allowed: ['navy', 'warm', 'forest', 'mono'], locked: false, reasonKey: null });
    assert.deepEqual(result.settings['captions.size'], { value: 1.25, source: 'personal', allowed: { min: 1, max: 2, step: 0.125 }, locked: false, reasonKey: null });
    for (const name of REGISTERED_FEATURES) assert.deepEqual(result.features[name], { enabled: false, reasonKey: 'error.POLICY_UNAVAILABLE' });
    assert.equal(result.event, null);
    assertDeepFrozen(result);
  }
  assert.deepEqual(resolveEffective().blocked, { code: 'POLICY_UNAVAILABLE', revision: null }, 'no arguments at all');
});

test('block precedence and clocks: stopped > app version > expiry > hub stop > hub heartbeat', () => {
  const draft = policyWith((policy) => { policy.revision = 12; policy.validUntil = '2026-09-06T02:00:00Z'; policy.minAppVersion = '0.7.0'; });
  const policy = validated(draft);
  assert.equal(resolveEffective({ policy, now: NOW }).blocked, null);
  assert.deepEqual(resolveEffective({ policy, now: Date.parse('2026-09-06T02:00:00Z') }).blocked, { code: 'POLICY_EXPIRED', revision: 12 });
  assert.deepEqual(resolveEffective({ policy, now: Date.parse('2026-09-06T01:59:59.999Z') }).blocked, null);
  assert.equal(resolveEffective({ policy: example, now: Date.parse('2099-01-01T00:00:00Z') }).blocked, null, 'validUntil null never expires');
  assert.deepEqual(resolveEffective({ policy, now: NOW, appVersion: '0.6.9' }).blocked, { code: 'APP_VERSION_TOO_OLD', revision: 12 });
  assert.deepEqual(resolveEffective({ policy, now: NOW, appVersion: '0.10.0' }).blocked, null, 'numeric, not string, comparison');
  assert.equal(resolveEffective({ policy, now: NOW }).blocked, null, `running version ${APP_VERSION} satisfies 0.7.0`);
  const stopped = validated(policyWith((p) => { p.revision = 13; p.emergency = { stopped: true, reason: { ko: '점검', en: 'Maintenance', ja: '点検' } }; p.validUntil = '2026-09-06T00:30:00Z'; }));
  assert.deepEqual(resolveEffective({ policy: stopped, now: NOW, appVersion: '0.1.0', hubControl: { stopped: true } }).blocked, { code: 'POLICY_STOPPED', revision: 13 });
  assert.deepEqual(resolveEffective({ policy, now: NOW, appVersion: '0.1.0', hubControl: { stopped: true } }).blocked, { code: 'APP_VERSION_TOO_OLD', revision: 12 });
  assert.deepEqual(resolveEffective({ policy, now: NOW, hubControl: { stopped: true, heartbeatLost: true, revision: 99 } }).blocked, { code: 'HUB_CONTROL_STOPPED', revision: 12 });
  assert.deepEqual(resolveEffective({ policy, now: NOW, hubControl: { stopped: false, heartbeatLost: true } }).blocked, { code: 'HUB_CONTROL_LOST', revision: 12 });
  assert.equal(resolveEffective({ policy, now: NOW, hubControl: { supported: true, stopped: false, heartbeatLost: false } }).blocked, null);
  assert.equal(resolveEffective({ policy, now: NOW, hubControl: { stopped: 'true' } }).blocked, null, 'only boolean true stops');
  assert.throws(() => resolveEffective({ policy, now: NOW, appVersion: '1.0' }), { name: 'TypeError', message: 'VERSION_INVALID' });
  assert.deepEqual([...BLOCK_CODES], ['POLICY_UNAVAILABLE', 'POLICY_STOPPED', 'APP_VERSION_TOO_OLD', 'POLICY_EXPIRED', 'HUB_CONTROL_STOPPED', 'HUB_CONTROL_LOST']);
});

test('features: policy toggles, code capabilities and hub restrictions only ever remove; the hub cannot re-enable or touch settings', () => {
  const policy = validated(policyWith((draft) => { draft.features.diagnostics = false; draft.features.simultaneousDirect = true; }));
  const base = resolveEffective({ policy, now: NOW });
  assert.deepEqual(base.features.diagnostics, { enabled: false, reasonKey: 'policy.featureOff' });
  assert.deepEqual(base.features.simultaneousDirect, { enabled: true, reasonKey: null });
  // The code does not support Live: the policy toggle cannot grant it.
  const noLive = resolveEffective({ policy, now: NOW, capabilities: ['translate', 'stt', 'voice'] });
  assert.deepEqual(noLive.features.simultaneousDirect, { enabled: false, reasonKey: 'capability.unsupported' });
  assert.deepEqual(noLive.features.sequential, { enabled: true, reasonKey: null });
  assert.deepEqual(resolveEffective({ policy, now: NOW, capabilities: ['live'] }).features.sequential, { enabled: false, reasonKey: 'capability.unsupported' });
  assert.deepEqual(resolveEffective({ policy, now: NOW, capabilities: ['bogus', 'translate'] }).features.sequential, { enabled: true, reasonKey: null });
  assert.deepEqual(Object.keys(FEATURE_CAPABILITIES), [...REGISTERED_FEATURES]);
  for (const list of Object.values(FEATURE_CAPABILITIES)) for (const capability of list) assert.ok(CAPABILITIES.includes(capability));
  // Hub control restricts features and nothing else.
  const hubControl = { supported: true, stopped: false, heartbeatLost: false, disabledFeatures: ['simultaneousDirect', 'diagnostics', 'sequential'],
    settings: { 'ui.tone': { default: 'mono', allowed: ['mono'], locked: true } }, features: { diagnostics: true }, revision: 3 };
  const hub = resolveEffective({ policy, now: NOW, hubControl, preferences: { 'ui.tone': 'warm' } });
  assert.deepEqual(hub.features.simultaneousDirect, { enabled: false, reasonKey: 'hubControl.stopped' });
  assert.deepEqual(hub.features.sequential, { enabled: false, reasonKey: 'hubControl.stopped' });
  assert.deepEqual(hub.features.diagnostics, { enabled: false, reasonKey: 'policy.featureOff' }, 'site policy wins over the hub');
  assert.deepEqual(hub.features.hubListen, { enabled: true, reasonKey: null });
  assert.equal(hub.blocked, null);
  assert.deepEqual(hub.settings['ui.tone'], { value: 'warm', source: 'personal', allowed: ['navy', 'warm', 'forest', 'mono'], locked: false, reasonKey: null });
  assert.deepEqual(resolveEffective({ policy, now: NOW, hubControl: { disabledFeatures: 'simultaneousDirect' } }).features, base.features, 'malformed lists are ignored');
});

test('joined shared-key event: status against the policy list and clock, capabilities intersected and never live', () => {
  const policy = validated(policyWith((draft) => {
    draft.features.sharedKeys = true;
    draft.sharedEvents = [exampleEvent({ enabled: true }), exampleEvent({ id: 'service-off', eventName: 'off' }),
      exampleEvent({ id: 'service-later', eventName: 'later', enabled: true, startsAt: '2026-09-07T00:00:00Z', expiresAt: '2026-09-07T03:00:00Z' })];
  }));
  const active = resolveEffective({ policy, now: NOW, event: 'service-20260906' });
  assert.deepEqual(active.event, { id: 'service-20260906', status: 'active', providerId: 'gemini', expiresAt: '2026-09-06T03:00:00Z',
    allowedCapabilities: ['translate', 'stt', 'voice'], reasonKey: null });
  assert.equal(active.blocked, null);
  assert.deepEqual(resolveEffective({ policy, now: NOW, event: { id: 'service-20260906' } }).event, active.event);
  assert.deepEqual(resolveEffective({ policy, now: NOW, event: 'service-20260906', capabilities: ['translate', 'live'] }).event.allowedCapabilities, ['translate']);
  const expired = resolveEffective({ policy, now: Date.parse('2026-09-06T03:00:00Z'), event: 'service-20260906' }).event;
  assert.deepEqual(expired, { id: 'service-20260906', status: 'expired', providerId: 'gemini', expiresAt: '2026-09-06T03:00:00Z', allowedCapabilities: [], reasonKey: 'event.status.expired' });
  assert.equal(resolveEffective({ policy, now: Date.parse('2026-09-05T23:59:59Z'), event: 'service-20260906' }).event.status, 'upcoming');
  assert.equal(resolveEffective({ policy, now: NOW, event: 'service-later' }).event.status, 'upcoming');
  assert.equal(resolveEffective({ policy, now: NOW, event: 'service-later' }).event.reasonKey, 'event.status.upcoming');
  assert.equal(resolveEffective({ policy, now: NOW, event: 'service-off' }).event.status, 'disabled');
  const removed = resolveEffective({ policy, now: NOW, event: 'service-gone' }).event;
  assert.deepEqual(removed, { id: 'service-gone', status: 'removed', providerId: null, expiresAt: null, allowedCapabilities: [], reasonKey: 'event.status.removed' });
  // Feature switched off site-wide: every event reads as disabled.
  assert.equal(resolveEffective({ policy: example, now: NOW, event: 'service-20260906' }).event.status, 'removed', 'example lists no events');
  const sharedOff = validated(policyWith((draft) => { draft.sharedEvents = [exampleEvent()]; }));
  assert.equal(resolveEffective({ policy: sharedOff, now: NOW, event: 'service-20260906' }).event.status, 'disabled');
  assert.equal(resolveEffective({ policy: null, now: NOW, event: 'service-20260906' }).event.status, 'removed');
  // Not joined, or an ID that is not even well formed, yields null rather than echoing input.
  for (const event of [null, undefined, '', 'Service 1', 'x'.repeat(65), { id: 42 }, { eventId: 'service-20260906' }, 7, '__proto__']) {
    assert.equal(resolveEffective({ policy, now: NOW, event }).event, null, String(event));
  }
  assert.deepEqual([...EVENT_STATUSES], ['upcoming', 'active', 'expired', 'disabled', 'removed']);
});

test('inputs are never mutated and every reason key exists in all three dictionaries', async () => {
  const preferences = { 'ui.mode': 'dark', 'interpretation.sourceLanguage': 'en', 'interpretation.targetLanguage': 'en' };
  const hubControl = { stopped: false, disabledFeatures: ['diagnostics'] };
  const policy = validated(fullPolicy());
  const snapshotBefore = JSON.stringify({ preferences, hubControl, policy });
  const results = [
    resolveEffective({ policy, preferences, hubControl, event: 'service-20260906', now: NOW }),
    resolveEffective({ policy: example, preferences, hubControl, now: NOW, capabilities: ['voice'] }),
    resolveEffective({ policy: null, preferences, now: NOW }),
    resolveEffective({ policy: validated(policyWith((d) => { d.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: false }; d.settings['ui.text'] = { default: 'm', allowed: ['m', 'l'], locked: false }; })), now: NOW }),
  ];
  assert.equal(JSON.stringify({ preferences, hubControl, policy }), snapshotBefore);
  const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
    [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));
  const used = new Set(Object.values(REASON_KEYS));
  for (const result of results) {
    for (const setting of Object.values(result.settings)) if (setting.reasonKey) used.add(setting.reasonKey);
    for (const feature of Object.values(result.features)) if (feature.reasonKey) used.add(feature.reasonKey);
    if (result.event?.reasonKey) used.add(result.event.reasonKey);
    if (result.blocked) used.add(`error.${result.blocked.code}`);
  }
  for (const code of BLOCK_CODES) used.add(`error.${code}`);
  for (const status of EVENT_STATUSES) used.add(`event.status.${status}`);
  assert.ok(used.size >= 12);
  for (const key of used) {
    for (const language of SUPPORTED_LANGUAGES) assert.ok(dictionaries[language][key]?.trim(), `${language}: ${key}`);
  }
  const source = await readFile(new URL('../app/policy/resolve.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:window|document|navigator|localStorage|fetch)\b\s*[.(]/, 'no browser globals');
  assert.doesNotMatch(source, /console\.|\.setItem|\.removeItem/, 'no logging, no storage writes');
});
