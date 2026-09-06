import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import {
  EVENT_CAPABILITIES, NOTICE_SEVERITIES, POLICY_ISSUE_CODES, POLICY_LANGUAGES, POLICY_LIMITS, POLICY_SCHEMA_VERSION,
  RATE_BASES, RATE_CONFIDENCES, RATE_UNITS, REGISTERED_FEATURES, REGISTERED_PROVIDER_IDS, REGISTERED_SETTINGS,
  compareVersions, validatePolicy,
} from '../app/policy/schema.js';
import { APP_VERSION, APP_VERSION_PATTERN, parseVersion } from '../app/version.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { CAPABILITIES } from '../app/providers/contract.js';
import { REGISTERED_HUBS } from '../app/hub/protocol.js';
import { PRODUCT_PROVIDER_IDS } from '../app/config.js';
import {
  REGISTERED_HUB_IDS, exampleEvent, exampleNotice, examplePolicy, exampleRate, fullPolicy, policyWith, serialized, trilingual,
} from './fixtures/policy.mjs';

// P3-04: one validator for the browser client, the admin console and
// check-release. Issues carry codes and dotted paths only; accepted policies are
// fresh deep-frozen copies (no merge into anything), and the app version is a
// numeric triplet compared numerically, never as a string.

const MARKER = 'SYNTHETIC_PRIVATE_VALUE';
const options = { registeredHubIds: REGISTERED_HUB_IDS };
const issuesOf = (result) => result.issues.map((issue) => [issue.code, issue.path]).sort();
const expectIssues = (input, expected, extra = options) => {
  const result = validatePolicy(input, extra);
  assert.equal(result.ok, false, inspect(expected));
  assert.deepEqual(issuesOf(result), [...expected].sort());
  return result;
};
const expectOk = (input, extra = options) => {
  const result = validatePolicy(input, extra);
  assert.deepEqual(result.ok ? [] : result.issues, []);
  return result.policy;
};
function assertDeepFrozen(value, path = 'policy') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), path);
  for (const [key, item] of Object.entries(value)) assertDeepFrozen(item, `${path}.${key}`);
}

test('the deployed policy.json is the §1.4 example, validates as text and as an object, and is copied not merged', async () => {
  const text = await readFile(new URL('../policy.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(text), examplePolicy(), 'root policy.json equals the design example');
  const fromText = validatePolicy(text);
  const fromObject = validatePolicy(examplePolicy());
  assert.equal(fromText.ok, true);
  assert.deepEqual(Object.keys(fromText), ['ok', 'policy']);
  assert.deepEqual(fromText.policy, examplePolicy());
  assert.deepEqual(fromObject.policy, fromText.policy);
  assertDeepFrozen(fromText.policy);
  assert.ok(Object.isFrozen(fromText));
  assert.equal(fromText.policy.schemaVersion, POLICY_SCHEMA_VERSION);
  assert.equal(Object.getPrototypeOf(fromText.policy), Object.prototype);
  // Fresh copy: the input keeps its identity and later input mutation does not reach the result.
  const input = examplePolicy();
  const before = structuredClone(input);
  const result = validatePolicy(input);
  assert.notEqual(result.policy, input);
  assert.notEqual(result.policy.settings, input.settings);
  assert.notEqual(result.policy.settings['ui.mode'].allowed, input.settings['ui.mode'].allowed);
  input.features.sequential = false;
  input.settings['ui.mode'].allowed.push('dark');
  assert.equal(result.policy.features.sequential, true);
  assert.deepEqual(result.policy.settings['ui.mode'].allowed, ['system', 'light', 'dark']);
  assert.deepEqual(validatePolicy(before).policy, result.policy);
  assert.deepEqual(before, examplePolicy(), 'validation never mutates its input');
});

test('canonical output: key order is fixed regardless of input order, so equivalent policies stringify identically', () => {
  const reordered = JSON.parse(JSON.stringify(policyWith((policy) => {
    const { pricing, hubControl, settings, features, ...rest } = policy;
    for (const key of Object.keys(policy)) delete policy[key];
    Object.assign(policy, { pricing, hubControl, settings: Object.fromEntries(Object.entries(settings).reverse()), features }, rest);
  })));
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(examplePolicy()));
  assert.equal(JSON.stringify(validatePolicy(reordered).policy), JSON.stringify(validatePolicy(examplePolicy()).policy));
  assert.deepEqual(Object.keys(validatePolicy(reordered).policy), ['schemaVersion', 'revision', 'publishedAt', 'validUntil',
    'minAppVersion', 'emergency', 'features', 'settings', 'notices', 'sharedEvents', 'hubControl', 'pricing']);
  assert.deepEqual(Object.keys(validatePolicy(reordered).policy.settings), Object.keys(REGISTERED_SETTINGS));
});

test('app version: package.json matches the code constant and the deployed minAppVersion is satisfied numerically', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(APP_VERSION, '0.7.0');
  assert.ok(APP_VERSION_PATTERN.test(APP_VERSION));
  assert.deepEqual(parseVersion(APP_VERSION), [0, 7, 0]);
  assert.ok(Object.isFrozen(parseVersion(APP_VERSION)));
  const deployed = JSON.parse(await readFile(new URL('../policy.json', import.meta.url), 'utf8'));
  assert.ok(compareVersions(deployed.minAppVersion, APP_VERSION) <= 0, 'the shipped policy must not lock out the shipped app');
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'numeric, not lexicographic');
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1);
  assert.equal(compareVersions('10.0.0', '9.0.0'), 1);
  assert.ok('0.10.0' < '0.9.0', 'string comparison would get this wrong');
  for (const bad of ['v0.7.0', '0.7', '0.7.0.1', '01.7.0', '0.7.0-beta', '0.7.0 ', ' 0.7.0', '0.7.x', '', '1.2.3\n', 7, null, undefined, ['0', '7', '0'], {}]) {
    assert.throws(() => compareVersions(bad, '0.7.0'), { message: 'VERSION_INVALID' }, inspect(bad));
    assert.throws(() => compareVersions('0.7.0', bad), { message: 'VERSION_INVALID' }, inspect(bad));
    assert.equal(parseVersion(bad), null, inspect(bad));
  }
  assert.throws(() => compareVersions('1.0.0', '1.0.0.0'), { message: 'VERSION_INVALID' });
});

test('registries are frozen, match the design and the reviewed code registries', () => {
  assert.equal(POLICY_SCHEMA_VERSION, 1);
  assert.deepEqual(POLICY_LIMITS, { bodyBytes: 65536, notices: 10, events: 100, rates: 64, allowedHubIds: 32,
    textChars: 1000, reasonChars: 300, idChars: 64, eventNameChars: 120, maxAmount: 1000 });
  assert.deepEqual(REGISTERED_FEATURES, ['sequential', 'simultaneousDirect', 'hubListen', 'diagnostics', 'sharedKeys', 'rememberPersonalKey']);
  assert.deepEqual(Object.keys(REGISTERED_SETTINGS), ['ui.mode', 'ui.tone', 'ui.text', 'captions.size',
    'interpretation.sourceLanguage', 'interpretation.targetLanguage', 'voice.output', 'billing.plan']);
  assert.ok(!Object.hasOwn(REGISTERED_SETTINGS, 'ui.language'), 'the UI language is never policy managed');
  const example = examplePolicy();
  for (const [name, spec] of Object.entries(REGISTERED_SETTINGS)) {
    const entry = example.settings[name];
    assert.equal(spec.default, entry.default, name);
    if (spec.kind === 'enum') assert.deepEqual(spec.values, entry.allowed, name);
    else assert.deepEqual([spec.min, spec.max, spec.step], [entry.min, entry.max, entry.step], name);
  }
  assert.equal(POLICY_LANGUAGES, SUPPORTED_LANGUAGES);
  assert.deepEqual(REGISTERED_SETTINGS['interpretation.targetLanguage'].values, [...SUPPORTED_LANGUAGES]);
  assert.deepEqual(NOTICE_SEVERITIES, ['info', 'warning', 'critical']);
  assert.deepEqual(EVENT_CAPABILITIES, CAPABILITIES.filter((capability) => capability !== 'live'));
  assert.ok(!EVENT_CAPABILITIES.includes('live'), 'events never enable shared Live');
  assert.deepEqual(RATE_UNITS, ['minute']);
  assert.deepEqual(RATE_BASES, ['activeMinuteEstimate']);
  assert.deepEqual(RATE_CONFIDENCES, ['low', 'medium', 'high']);
  assert.deepEqual(REGISTERED_PROVIDER_IDS, [...PRODUCT_PROVIDER_IDS]);
  assert.deepEqual(POLICY_ISSUE_CODES, ['POLICY_SCHEMA', 'POLICY_FIELD', 'POLICY_RANGE', 'POLICY_TEXT',
    'POLICY_REFERENCE', 'POLICY_CONFLICT', 'POLICY_UNKNOWN_KEY', 'POLICY_TOO_LARGE']);
  for (const value of [POLICY_LIMITS, REGISTERED_FEATURES, REGISTERED_SETTINGS, NOTICE_SEVERITIES, EVENT_CAPABILITIES,
    RATE_UNITS, RATE_BASES, RATE_CONFIDENCES, REGISTERED_PROVIDER_IDS, POLICY_ISSUE_CODES]) assertDeepFrozen(value, 'registry');
  // With the product hub registry (currently empty) any hub reference fails; injected registries pass.
  assert.deepEqual(REGISTERED_HUBS, []);
  const withHub = policyWith((policy) => { policy.hubControl = { enabled: true, allowedHubIds: ['venue-main'], allowDirectSubscription: false }; });
  expectIssues(withHub, [['POLICY_REFERENCE', 'hubControl.allowedHubIds.0']], {});
  expectOk(withHub, { registeredHubIds: ['venue-main'] });
});

test('the full policy (notices, events, hub control, rates, locked and narrowed settings) validates and round-trips', () => {
  const policy = expectOk(fullPolicy());
  assert.equal(policy.revision, 7);
  assert.equal(policy.validUntil, '2026-12-31T23:59:59Z');
  assert.deepEqual(policy.emergency, { stopped: true, reason: trilingual('reason') });
  assert.equal(policy.notices.length, 2);
  assert.deepEqual(policy.notices[1], exampleNotice({ id: 'notice-2', severity: 'critical', showFrom: null, showUntil: null }));
  assert.deepEqual(policy.sharedEvents[0], exampleEvent({ enabled: true }));
  assert.deepEqual(policy.hubControl, { enabled: true, allowedHubIds: ['venue-main'], allowDirectSubscription: true });
  assert.deepEqual(policy.pricing.rates[0], exampleRate());
  assert.deepEqual(policy.settings['ui.tone'], { default: 'mono', allowed: ['mono'], locked: true });
  assert.deepEqual(policy.settings['captions.size'], { default: 1.75, min: 1.25, max: 2, step: 0.25, locked: false });
  assertDeepFrozen(policy);
  assert.deepEqual(validatePolicy(serialized(fullPolicy()), options).policy, policy);
  assert.deepEqual(validatePolicy(JSON.parse(JSON.stringify(policy)), options).policy, policy, 'a validated policy re-validates unchanged');
  expectIssues(fullPolicy(), [['POLICY_REFERENCE', 'hubControl.allowedHubIds.0']], {});
  // The §1.4 event example alone (disabled) is fine with sharedKeys=false.
  expectOk(policyWith((p) => { p.sharedEvents = [exampleEvent()]; }));
});

test('size limit: 64 KiB is measured on bytes of the text or the serialized object, not on Content-Length', () => {
  const limit = POLICY_LIMITS.bodyBytes;
  assert.equal(limit, 65536);
  assert.equal(validatePolicy(serialized(examplePolicy(), { bytes: limit })).ok, true, 'exactly at the limit passes');
  expectIssues(serialized(examplePolicy(), { bytes: limit + 1 }), [['POLICY_TOO_LARGE', '']]);
  // Multi-byte text counts bytes: 32,768 three-byte characters overflow even though the length is far below.
  const big = policyWith((policy) => { policy.notices = [exampleNotice({ text: { ...trilingual('n'), ko: '가'.repeat(700) } })]; });
  const wide = policyWith((policy) => {
    policy.notices = Array.from({ length: 10 }, (_, index) => exampleNotice({ id: `n-${index}`, text: { ko: '가'.repeat(1000), en: 'e'.repeat(1000), ja: 'あ'.repeat(1000) } }));
  });
  assert.ok(JSON.stringify(wide).length < limit && new TextEncoder().encode(JSON.stringify(wide)).byteLength > limit);
  expectIssues(wide, [['POLICY_TOO_LARGE', '']]);
  expectIssues(serialized(wide), [['POLICY_TOO_LARGE', '']]);
  expectOk(big);
  for (const input of ['', 'null', '[]', '"x"', '{', '{"schemaVersion": 1,}', 42, null, undefined, [], [examplePolicy()], new Map(), () => {}]) {
    expectIssues(input, [['POLICY_SCHEMA', '']]);
  }
  const cyclic = examplePolicy();
  cyclic.notices.push(cyclic);
  expectIssues(cyclic, [['POLICY_SCHEMA', '']]);
  expectIssues(policyWith((policy) => { policy.pricing.rates = [exampleRate({ amount: 1n })]; }), [['POLICY_SCHEMA', '']]);
});

test('unknown schema versions are rejected whole; nothing else is reported for them', () => {
  for (const version of [0, 2, '1', 1.5, null, undefined, true]) {
    expectIssues(policyWith((policy) => { policy.schemaVersion = version; policy.revision = -1; }), [['POLICY_SCHEMA', 'schemaVersion']]);
  }
  expectIssues(serialized({ ...examplePolicy(), schemaVersion: 2 }), [['POLICY_SCHEMA', 'schemaVersion']]);
});

test('unknown keys anywhere are rejected, including secrets, URLs, room codes and prototype keys; nothing is merged', () => {
  const cases = [
    [(policy) => { policy.apiKey = MARKER; }, 'apiKey'],
    [(policy) => { policy.endpoint = 'https://evil.example/api'; }, 'endpoint'],
    [(policy) => { policy.emergency.html = '<b>x</b>'; }, 'emergency.html'],
    [(policy) => { policy.features.liveShared = true; }, 'features.liveShared'],
    [(policy) => { policy.settings['ui.language'] = { default: 'ko', allowed: ['ko'], locked: true }; }, 'settings.ui.language'],
    [(policy) => { policy.settings['ui.mode'].forced = 'dark'; }, 'settings.ui.mode.forced'],
    [(policy) => { policy.settings['captions.size'].allowed = [1, 2]; }, 'settings.captions.size.allowed'],
    [(policy) => { policy.notices = [exampleNotice({ url: 'https://example.com' })]; }, 'notices.0.url'],
    [(policy) => { policy.notices = [exampleNotice({ text: { ...trilingual('t'), fr: 'texte' } })]; }, 'notices.0.text.fr'],
    [(policy) => { policy.sharedEvents = [exampleEvent({ key: MARKER })]; }, 'sharedEvents.0.key'],
    [(policy) => { policy.sharedEvents = [exampleEvent({ roomCode: 'abc123' })]; }, 'sharedEvents.0.roomCode'],
    [(policy) => { policy.sharedEvents = [exampleEvent({ hubUrl: 'wss://evil.example/ws' })]; }, 'sharedEvents.0.hubUrl'],
    [(policy) => { policy.sharedEvents = [exampleEvent({ payload: '#shared=x' })]; }, 'sharedEvents.0.payload'],
    [(policy) => { policy.hubControl.hubs = ['wss://evil.example/ws']; }, 'hubControl.hubs'],
    [(policy) => { policy.pricing.rates = [exampleRate({ token: MARKER })]; }, 'pricing.rates.0.token'],
    [(policy) => { policy.pricing.source = 'https://example.com/prices'; }, 'pricing.source'],
  ];
  for (const [mutate, path] of cases) expectIssues(policyWith(mutate), [['POLICY_UNKNOWN_KEY', path]]);
  // JSON text can carry own __proto__/constructor/prototype keys; they are unknown keys and never pollute.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const text = serialized(examplePolicy()).replace('"notices"', `"${key}": {"polluted": true}, "notices"`);
    expectIssues(text, [['POLICY_UNKNOWN_KEY', key]]);
    const nested = serialized(examplePolicy()).replace('"locked":false', `"locked":false, "${key}": {"polluted": true}`);
    expectIssues(nested, [['POLICY_UNKNOWN_KEY', `settings.ui.mode.${key}`]]);
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const proto = Object.create({ inherited: true });
  Object.assign(proto, examplePolicy());
  expectIssues(proto, [['POLICY_SCHEMA', '']], {});
  // Unsafe key names are not echoed in the path.
  const odd = serialized(examplePolicy()).replace('"notices"', `"${MARKER} <script>": 1, "notices"`);
  const result = expectIssues(odd, [['POLICY_UNKNOWN_KEY', '']]);
  assert.ok(!JSON.stringify(result).includes(MARKER));
  // Missing required keys are field issues at the missing path.
  expectIssues(policyWith((policy) => { delete policy.pricing; }), [['POLICY_FIELD', 'pricing']]);
  expectIssues(policyWith((policy) => { delete policy.features.diagnostics; }), [['POLICY_FIELD', 'features.diagnostics']]);
  expectIssues(policyWith((policy) => { delete policy.settings['billing.plan']; }), [['POLICY_FIELD', 'settings.billing.plan']]);
  expectIssues(policyWith((policy) => { delete policy.settings['captions.size'].step; }), [['POLICY_FIELD', 'settings.captions.size.step']]);
});

test('top-level fields: revision, UTC timestamps, validUntil ordering, minAppVersion and emergency reason', () => {
  for (const revision of [0, -1, 1.5, '1', null, 2 ** 53, true]) {
    expectIssues(policyWith((policy) => { policy.revision = revision; }), [['POLICY_FIELD', 'revision']]);
  }
  expectOk(policyWith((policy) => { policy.revision = Number.MAX_SAFE_INTEGER; }));
  for (const stamp of ['2026-09-06', '2026-09-06T00:00:00', '2026-09-06T00:00:00+09:00', '2026-09-06 00:00:00Z',
    '2026-02-30T00:00:00Z', '2026-09-06T24:00:00Z', '2026-09-06T00:60:00Z', 1757116800000, null, '', 'now', 'Sat, 06 Sep 2026 00:00:00 GMT']) {
    expectIssues(policyWith((policy) => { policy.publishedAt = stamp; }), [['POLICY_FIELD', 'publishedAt']], options);
  }
  expectOk(policyWith((policy) => { policy.publishedAt = '2026-09-06T00:00:00.250Z'; }));
  expectOk(policyWith((policy) => { policy.validUntil = '2026-09-06T00:00:01Z'; }));
  expectIssues(policyWith((policy) => { policy.validUntil = '2026-09-06T00:00:00Z'; }), [['POLICY_CONFLICT', 'validUntil']]);
  expectIssues(policyWith((policy) => { policy.validUntil = '2026-09-05T23:59:59Z'; }), [['POLICY_CONFLICT', 'validUntil']]);
  expectIssues(policyWith((policy) => { policy.validUntil = '2026-09-07'; }), [['POLICY_FIELD', 'validUntil']]);
  expectIssues(policyWith((policy) => { policy.validUntil = undefined; }), [['POLICY_FIELD', 'validUntil']]);
  // A policy whose validUntil already passed is still a valid document; expiry is a runtime gate.
  expectOk(policyWith((policy) => { policy.validUntil = '2026-09-06T01:00:00Z'; }), { ...options, now: () => Date.parse('2027-01-01T00:00:00Z') });
  for (const version of ['v0.7.0', '0.7', '01.7.0', '0.7.0-beta', 7, null]) {
    expectIssues(policyWith((policy) => { policy.minAppVersion = version; }), [['POLICY_FIELD', 'minAppVersion']]);
  }
  // Requiring a newer app than the one shipped is a valid policy (the old app must still read it to show the banner).
  expectOk(policyWith((policy) => { policy.minAppVersion = '99.0.0'; }));
  expectIssues(policyWith((policy) => { policy.emergency.stopped = 'yes'; }), [['POLICY_FIELD', 'emergency.stopped']]);
  expectOk(policyWith((policy) => { policy.emergency = { stopped: true, reason: null }; }));
  expectOk(policyWith((policy) => { policy.emergency = { stopped: true, reason: { ko: '가'.repeat(300), en: 'e'.repeat(300), ja: 'あ'.repeat(300) } }; }));
  expectIssues(policyWith((policy) => { policy.emergency.reason = { ko: '가'.repeat(301), en: 'e'.repeat(300), ja: 'あ'.repeat(300) }; }), [['POLICY_TEXT', 'emergency.reason.ko']]);
  expectIssues(policyWith((policy) => { policy.emergency.reason = 'stop'; }), [['POLICY_TEXT', 'emergency.reason']]);
  expectIssues(policyWith((policy) => { policy.emergency = null; }), [['POLICY_FIELD', 'emergency']]);
  expectIssues(policyWith((policy) => { policy.features = []; }), [['POLICY_FIELD', 'features']]);
  expectIssues(policyWith((policy) => { policy.features.sharedKeys = 'false'; }), [['POLICY_FIELD', 'features.sharedKeys']]);
  expectIssues(policyWith((policy) => { policy.features.sharedKeys = 1; }), [['POLICY_FIELD', 'features.sharedKeys']]);
});

test('three-language texts: every language present, non-blank, bounded by code points, plain text only', () => {
  const at = (text) => policyWith((policy) => { policy.notices = [exampleNotice({ text })]; });
  expectOk(at({ ko: '가'.repeat(1000), en: 'e'.repeat(1000), ja: 'あ'.repeat(1000) }));
  expectOk(at({ ko: '줄1\n줄2\t탭', en: 'line1\r\nline2', ja: '行1\n行2' }));
  expectOk(at({ ko: '1 < 2 & 3 > 2', en: 'a < b', ja: '<3' }), options);
  expectOk(at({ ko: '🙂'.repeat(1000), en: 'e', ja: 'あ' }), 'code points, not UTF-16 units');
  for (const [text, paths] of [
    [{ ko: '가', en: 'e' }, ['notices.0.text.ja']],
    [{ ko: '가', en: '', ja: 'あ' }, ['notices.0.text.en']],
    [{ ko: '   ', en: 'e', ja: 'あ' }, ['notices.0.text.ko']],
    [{ ko: '가', en: 'e', ja: null }, ['notices.0.text.ja']],
    [{ ko: '가', en: ['e'], ja: 'あ' }, ['notices.0.text.en']],
    [{ ko: '가'.repeat(1001), en: 'e', ja: 'あ' }, ['notices.0.text.ko']],
    [{ ko: '가', en: 'a<b', ja: 'あ' }, ['notices.0.text.en']],
    [{ ko: '가', en: 'e\u0000', ja: 'あ' }, ['notices.0.text.en']],
    [{ ko: '가', en: 'e', ja: '<script>x</script>' }, ['notices.0.text.ja']],
    [{ ko: '<b>굵게</b>', en: 'e', ja: 'あ' }, ['notices.0.text.ko']],
    [{ ko: '가', en: '</div>', ja: 'あ' }, ['notices.0.text.en']],
    [{ ko: '가', en: 'e', ja: '<!-- c -->' }, ['notices.0.text.ja']],
    [{}, ['notices.0.text.ko', 'notices.0.text.en', 'notices.0.text.ja']],
    ['plain', ['notices.0.text']],
    [null, ['notices.0.text']],
    [['가', 'e', 'あ'], ['notices.0.text']],
  ]) expectIssues(at(text), paths.map((path) => ['POLICY_TEXT', path]));
  expectIssues(at({ ko: '가', en: 'e', ja: 'あ', 'en-US': 'e' }), [['POLICY_UNKNOWN_KEY', 'notices.0.text.en-US']]);
  expectIssues(policyWith((policy) => { policy.sharedEvents = [exampleEvent({ label: { ko: '', en: 'e', ja: 'あ' } })]; }), [['POLICY_TEXT', 'sharedEvents.0.label.ko']]);
});

test('settings: registered names only, defaults inside allowed values, numeric ranges and steps, locks', () => {
  const setting = (name, value) => policyWith((policy) => { policy.settings[name] = value; });
  // Enum settings.
  expectOk(setting('ui.tone', { default: 'warm', allowed: ['warm', 'navy'], locked: true }));
  expectOk(setting('ui.mode', { default: 'dark', allowed: ['dark'], locked: false }), 'a single option is an implicit lock');
  expectIssues(setting('ui.tone', { default: 'mono', allowed: ['navy', 'warm'], locked: false }), [['POLICY_CONFLICT', 'settings.ui.tone.default']]);
  expectIssues(setting('ui.tone', { default: 'sepia', allowed: ['navy', 'sepia'], locked: false }), [['POLICY_RANGE', 'settings.ui.tone.default'], ['POLICY_RANGE', 'settings.ui.tone.allowed.1']]);
  expectIssues(setting('ui.tone', { default: 'navy', allowed: [], locked: false }), [['POLICY_RANGE', 'settings.ui.tone.allowed']]);
  expectIssues(setting('ui.tone', { default: 'navy', allowed: ['navy', 'navy'], locked: false }), [['POLICY_FIELD', 'settings.ui.tone.allowed']]);
  expectIssues(setting('ui.tone', { default: 'navy', allowed: ['navy', 'warm', 'forest', 'mono', 'navy'], locked: false }), [['POLICY_RANGE', 'settings.ui.tone.allowed']]);
  expectIssues(setting('ui.tone', { default: 'navy', allowed: 'navy', locked: false }), [['POLICY_FIELD', 'settings.ui.tone.allowed']]);
  expectIssues(setting('ui.tone', { default: 'navy', allowed: ['navy'], locked: 'yes' }), [['POLICY_FIELD', 'settings.ui.tone.locked']]);
  expectIssues(setting('ui.tone', { default: 'navy', allowed: ['navy'] }), [['POLICY_FIELD', 'settings.ui.tone.locked']]);
  expectIssues(setting('ui.tone', { default: 1, allowed: [1], locked: false }), [['POLICY_RANGE', 'settings.ui.tone.default'], ['POLICY_RANGE', 'settings.ui.tone.allowed.0']]);
  expectIssues(setting('ui.tone', 'navy'), [['POLICY_FIELD', 'settings.ui.tone']]);
  expectIssues(setting('ui.text', { default: 'xl', allowed: ['xl', 'xxl'], locked: false }), [['POLICY_RANGE', 'settings.ui.text.allowed.1']]);
  expectIssues(setting('voice.output', { default: 'device', allowed: ['provider'], locked: true }), [['POLICY_CONFLICT', 'settings.voice.output.default']]);
  expectIssues(setting('billing.plan', { default: 'paid', allowed: ['free', 'paid', 'enterprise'], locked: false }), [['POLICY_RANGE', 'settings.billing.plan.allowed']], options);
  expectIssues(setting('billing.plan', { default: 'paid', allowed: ['paid', 'enterprise'], locked: false }), [['POLICY_RANGE', 'settings.billing.plan.allowed.1']]);
  // Numeric setting (captions.size, 1-2 rem in 0.125 steps).
  expectOk(setting('captions.size', { default: 1, min: 1, max: 1, step: 0.125, locked: true }));
  expectOk(setting('captions.size', { default: 2, min: 1.5, max: 2, step: 0.5, locked: false }));
  expectOk(setting('captions.size', { default: 1.375, min: 1.125, max: 1.875, step: 0.25, locked: false }));
  for (const [value, expected] of [
    [{ default: 1.5, min: 0.5, max: 2, step: 0.125, locked: false }, [['POLICY_RANGE', 'settings.captions.size.min']]],
    [{ default: 1.5, min: 1, max: 2.5, step: 0.125, locked: false }, [['POLICY_RANGE', 'settings.captions.size.max']]],
    [{ default: 1.5, min: 1, max: 2, step: 0.1, locked: false }, [['POLICY_RANGE', 'settings.captions.size.step']]],
    [{ default: 1.5, min: 1, max: 2, step: 0, locked: false }, [['POLICY_RANGE', 'settings.captions.size.step']]],
    [{ default: 1.5, min: 1, max: 2, step: -0.125, locked: false }, [['POLICY_RANGE', 'settings.captions.size.step']]],
    [{ default: 1.5, min: 1, max: 2, step: 1.125, locked: false }, [['POLICY_RANGE', 'settings.captions.size.step']]],
    [{ default: 1.5, min: 1.1, max: 2, step: 0.125, locked: false }, [['POLICY_RANGE', 'settings.captions.size.min']]],
    [{ default: 1.5, min: 1.5, max: 1.25, step: 0.125, locked: false }, [['POLICY_CONFLICT', 'settings.captions.size.min']]],
    [{ default: 1.5, min: 1, max: 1.875, step: 0.25, locked: false }, [['POLICY_RANGE', 'settings.captions.size.max']]],
    [{ default: 1.9, min: 1, max: 2, step: 0.125, locked: false }, [['POLICY_RANGE', 'settings.captions.size.default']]],
    [{ default: 1.25, min: 1.5, max: 2, step: 0.125, locked: false }, [['POLICY_CONFLICT', 'settings.captions.size.default']]],
    [{ default: 1.5, min: 1.25, max: 1.75, step: 0.5, locked: false }, [['POLICY_RANGE', 'settings.captions.size.default']]],
    [{ default: '1.5', min: 1, max: 2, step: 0.125, locked: false }, [['POLICY_FIELD', 'settings.captions.size.default']]],
    [{ default: Infinity, min: 1, max: 2, step: 0.125, locked: false }, [['POLICY_FIELD', 'settings.captions.size.default']]],
    [{ default: 1.5, min: null, max: 2, step: 0.125, locked: false }, [['POLICY_FIELD', 'settings.captions.size.min']]],
    [{ default: 1.5, min: 1, max: 2, step: 0.125, locked: null }, [['POLICY_FIELD', 'settings.captions.size.locked']]],
    [{ default: 1.5, allowed: [1.5], locked: false }, [['POLICY_UNKNOWN_KEY', 'settings.captions.size.allowed'], ['POLICY_FIELD', 'settings.captions.size.min'], ['POLICY_FIELD', 'settings.captions.size.max'], ['POLICY_FIELD', 'settings.captions.size.step']]],
  ]) expectIssues(setting('captions.size', value), expected);
  expectIssues(policyWith((policy) => { policy.settings = null; }), [['POLICY_FIELD', 'settings']]);
});

test('cross conditions: source and target languages must leave a usable pair; features must agree with events and hub control', () => {
  const languages = (source, target) => policyWith((policy) => {
    policy.settings['interpretation.sourceLanguage'] = source;
    policy.settings['interpretation.targetLanguage'] = target;
  });
  const targetPath = 'settings.interpretation.targetLanguage';
  expectOk(languages({ default: 'auto', allowed: ['auto'], locked: true }, { default: 'ja', allowed: ['ja'], locked: true }));
  expectOk(languages({ default: 'en', allowed: ['en', 'ko'], locked: false }, { default: 'ko', allowed: ['ko', 'en'], locked: false }));
  expectOk(languages({ default: 'auto', allowed: ['auto', 'ko'], locked: false }, { default: 'ko', allowed: ['ko'], locked: true }));
  // Forced pairs: locked or single-option settings force their default.
  expectIssues(languages({ default: 'ko', allowed: ['ko'], locked: true }, { default: 'ko', allowed: ['ko'], locked: true }), [['POLICY_CONFLICT', `${targetPath}.default`]]);
  expectIssues(languages({ default: 'ko', allowed: ['ko'], locked: false }, { default: 'ko', allowed: ['ja', 'ko'], locked: true }), [['POLICY_CONFLICT', `${targetPath}.default`]]);
  // Equal defaults are rejected even when other pairs remain selectable.
  expectIssues(languages({ default: 'ja', allowed: ['auto', 'ko', 'ja'], locked: false }, { default: 'ja', allowed: ['ko', 'en', 'ja'], locked: false }), [['POLICY_CONFLICT', `${targetPath}.default`]]);
  expectOk(languages({ default: 'en', allowed: ['en', 'ko'], locked: true }, { default: 'ko', allowed: ['en', 'ko'], locked: false }));
  expectIssues(languages({ default: 'auto', allowed: ['auto', 'ko'], locked: false }, { default: 'ko', allowed: [], locked: false }), [['POLICY_RANGE', `${targetPath}.allowed`]]);
  expectIssues(languages({ default: 'ko', allowed: ['ko', 'ja'], locked: false }, { default: 'ko', allowed: ['ja'], locked: false }), [['POLICY_CONFLICT', `${targetPath}.default`]]);
  // Feature toggles cannot contradict enabled events or hub control.
  expectIssues(policyWith((policy) => { policy.sharedEvents = [exampleEvent({ enabled: true })]; }), [['POLICY_CONFLICT', 'sharedEvents.0.enabled']]);
  expectOk(policyWith((policy) => { policy.features.sharedKeys = true; policy.sharedEvents = [exampleEvent({ enabled: true })]; }));
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: true, allowedHubIds: ['venue-main'], allowDirectSubscription: false }; policy.features.hubListen = false; }),
    [['POLICY_CONFLICT', 'hubControl.enabled']]);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: true, allowedHubIds: [], allowDirectSubscription: false }; }), [['POLICY_CONFLICT', 'hubControl.allowedHubIds']]);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: false, allowedHubIds: [], allowDirectSubscription: true }; }), [['POLICY_CONFLICT', 'hubControl.allowDirectSubscription']]);
  expectOk(policyWith((policy) => { policy.hubControl = { enabled: false, allowedHubIds: ['venue-hall'], allowDirectSubscription: false }; }), options);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: false, allowedHubIds: ['venue-main', 'venue-main'], allowDirectSubscription: false }; }), [['POLICY_FIELD', 'hubControl.allowedHubIds']]);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: false, allowedHubIds: ['Venue Main'], allowDirectSubscription: false }; }), [['POLICY_FIELD', 'hubControl.allowedHubIds.0']]);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: false, allowedHubIds: ['unknown-hub'], allowDirectSubscription: false }; }), [['POLICY_REFERENCE', 'hubControl.allowedHubIds.0']]);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: false, allowedHubIds: Array.from({ length: 33 }, (_, i) => `hub-${i}`), allowDirectSubscription: false }; }), [['POLICY_RANGE', 'hubControl.allowedHubIds']]);
  expectIssues(policyWith((policy) => { policy.hubControl = { enabled: 'on', allowedHubIds: 'venue-main', allowDirectSubscription: false }; }), [['POLICY_FIELD', 'hubControl.enabled'], ['POLICY_FIELD', 'hubControl.allowedHubIds']]);
});

test('notices: at most ten, unique ids, severity enum, posting period order', () => {
  const notices = (list) => policyWith((policy) => { policy.notices = list; });
  expectOk(notices(Array.from({ length: 10 }, (_, index) => exampleNotice({ id: `notice-${index}` }))));
  expectIssues(notices(Array.from({ length: 11 }, (_, index) => exampleNotice({ id: `notice-${index}` }))), [['POLICY_RANGE', 'notices']]);
  expectIssues(notices([exampleNotice(), exampleNotice()]), [['POLICY_CONFLICT', 'notices.1.id']]);
  for (const id of ['Notice 1', 'n'.repeat(65), '', 'notice_1', 'ノート', 1, null]) {
    expectIssues(notices([exampleNotice({ id })]), [['POLICY_FIELD', 'notices.0.id']]);
  }
  for (const severity of ['urgent', 'INFO', '', null, 2]) {
    expectIssues(notices([exampleNotice({ severity })]), [['POLICY_FIELD', 'notices.0.severity']]);
  }
  expectOk(notices([exampleNotice({ showFrom: null }), exampleNotice({ id: 'notice-2', showUntil: null })]));
  expectIssues(notices([exampleNotice({ showFrom: '2026-09-07T00:00:00Z', showUntil: '2026-09-07T00:00:00Z' })]), [['POLICY_CONFLICT', 'notices.0.showUntil']]);
  expectIssues(notices([exampleNotice({ showFrom: '2026-09-08T00:00:00Z' })]), [['POLICY_CONFLICT', 'notices.0.showUntil']]);
  expectIssues(notices([exampleNotice({ showFrom: '2026-09-06' })]), [['POLICY_FIELD', 'notices.0.showFrom']]);
  expectIssues(notices([exampleNotice({ showUntil: undefined })]), [['POLICY_FIELD', 'notices.0.showUntil']]);
  expectIssues(notices([null]), [['POLICY_FIELD', 'notices.0']]);
  expectIssues(notices({}), [['POLICY_FIELD', 'notices']]);
  // Expired posting periods are still valid documents.
  expectOk(notices([exampleNotice({ showFrom: '2020-01-01T00:00:00Z', showUntil: '2020-01-02T00:00:00Z' })]), { ...options, now: () => Date.now() });
});

test('shared events: bounded list, ids, registered provider, event name, period, capabilities without live', () => {
  const events = (list, features = {}) => policyWith((policy) => { Object.assign(policy.features, features); policy.sharedEvents = list; });
  expectOk(events(Array.from({ length: 100 }, (_, index) => exampleEvent({ id: `event-${index}` }))));
  expectIssues(events(Array.from({ length: 101 }, (_, index) => exampleEvent({ id: `event-${index}` }))), [['POLICY_RANGE', 'sharedEvents']]);
  expectIssues(events([exampleEvent(), exampleEvent({ eventName: 'other' })]), [['POLICY_CONFLICT', 'sharedEvents.1.id']]);
  for (const id of ['Service 2026', 'service_1', '', 's'.repeat(65), 7]) expectIssues(events([exampleEvent({ id })]), [['POLICY_FIELD', 'sharedEvents.0.id']]);
  expectIssues(events([exampleEvent({ providerId: 'openai' })]), [['POLICY_REFERENCE', 'sharedEvents.0.providerId']]);
  expectOk(events([exampleEvent({ providerId: 'other' })]), { ...options, registeredProviderIds: ['gemini', 'other'] });
  for (const providerId of ['Gemini', '1gemini', 'gem ini', '', null]) expectIssues(events([exampleEvent({ providerId })]), [['POLICY_FIELD', 'sharedEvents.0.providerId']]);
  expectOk(events([exampleEvent({ eventName: 'n'.repeat(120) })]));
  for (const eventName of ['', '   ', 'n'.repeat(121), 'line\nbreak', 'ctrl\u0007', '<b>x</b>', 42, null]) {
    expectIssues(events([exampleEvent({ eventName })]), [['POLICY_FIELD', 'sharedEvents.0.eventName']]);
  }
  expectIssues(events([exampleEvent({ startsAt: '2026-09-06T03:00:00Z' })]), [['POLICY_CONFLICT', 'sharedEvents.0.expiresAt']]);
  expectIssues(events([exampleEvent({ expiresAt: '2026-09-05T23:00:00Z' })]), [['POLICY_CONFLICT', 'sharedEvents.0.expiresAt']]);
  expectIssues(events([exampleEvent({ startsAt: null })]), [['POLICY_FIELD', 'sharedEvents.0.startsAt']]);
  expectIssues(events([exampleEvent({ expiresAt: 1757127600000 })]), [['POLICY_FIELD', 'sharedEvents.0.expiresAt']]);
  expectIssues(events([exampleEvent({ enabled: 'true' })]), [['POLICY_FIELD', 'sharedEvents.0.enabled']]);
  expectIssues(events([exampleEvent({ allowedCapabilities: ['translate', 'live'] })]), [['POLICY_REFERENCE', 'sharedEvents.0.allowedCapabilities.1']]);
  expectIssues(events([exampleEvent({ allowedCapabilities: ['live'] })]), [['POLICY_REFERENCE', 'sharedEvents.0.allowedCapabilities.0']]);
  expectIssues(events([exampleEvent({ allowedCapabilities: ['translate', 'translate'] })]), [['POLICY_FIELD', 'sharedEvents.0.allowedCapabilities']]);
  expectIssues(events([exampleEvent({ allowedCapabilities: [] })]), [['POLICY_RANGE', 'sharedEvents.0.allowedCapabilities']]);
  expectIssues(events([exampleEvent({ allowedCapabilities: 'translate' })]), [['POLICY_FIELD', 'sharedEvents.0.allowedCapabilities']]);
  expectOk(events([exampleEvent({ allowedCapabilities: ['voice'] })]));
  // An event that already ended is a valid document; the runtime reports EVENT_ENDED.
  expectOk(events([exampleEvent({ enabled: true })], { sharedKeys: true }), { ...options, now: () => Date.parse('2027-01-01T00:00:00Z') });
});

test('pricing: revision, verified date, ISO currency, override flag, bounded rate list with unique model/capability', () => {
  const pricing = (mutate) => policyWith((policy) => { mutate(policy.pricing); });
  expectOk(pricing((p) => { p.rates = Array.from({ length: 64 }, (_, index) => exampleRate({ model: `model-${index}` })); }));
  expectIssues(pricing((p) => { p.rates = Array.from({ length: 65 }, (_, index) => exampleRate({ model: `model-${index}` })); }), [['POLICY_RANGE', 'pricing.rates']]);
  expectOk(pricing((p) => { p.rates = [exampleRate(), exampleRate({ capability: 'stt' }), exampleRate({ model: 'gemini-3.5-flash' })]; }));
  expectIssues(pricing((p) => { p.rates = [exampleRate(), exampleRate({ amount: 0.5 })]; }), [['POLICY_CONFLICT', 'pricing.rates.1.model']]);
  for (const revision of [0, -3, 1.1, '1', null]) expectIssues(pricing((p) => { p.revision = revision; }), [['POLICY_FIELD', 'pricing.revision']]);
  for (const currency of ['usd', 'US', 'USDT', '$', 840, null]) expectIssues(pricing((p) => { p.currency = currency; }), [['POLICY_FIELD', 'pricing.currency']]);
  expectOk(pricing((p) => { p.currency = 'JPY'; }));
  expectIssues(pricing((p) => { p.updatedAt = '2026-09-06T09:00:00+09:00'; }), [['POLICY_FIELD', 'pricing.updatedAt']]);
  expectIssues(pricing((p) => { p.allowLocalOverride = 'yes'; }), [['POLICY_FIELD', 'pricing.allowLocalOverride']]);
  expectIssues(pricing((p) => { p.rates = null; }), [['POLICY_FIELD', 'pricing.rates']]);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ capability: 'chat' })]; }), [['POLICY_REFERENCE', 'pricing.rates.0.capability']]);
  expectOk(pricing((p) => { p.rates = [exampleRate({ capability: 'live' })]; }), options, 'rates may price live (personal-key use)');
  for (const model of ['Gemini', 'gemini/pro', '', 'm'.repeat(65), '-model', 3, null]) {
    expectIssues(pricing((p) => { p.rates = [exampleRate({ model })]; }), [['POLICY_FIELD', 'pricing.rates.0.model']]);
  }
  expectIssues(pricing((p) => { p.rates = [exampleRate({ unit: 'token' })]; }), [['POLICY_FIELD', 'pricing.rates.0.unit']]);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ basis: 'tokenPrice' })]; }), [['POLICY_FIELD', 'pricing.rates.0.basis']]);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ confidence: 'certain' })]; }), [['POLICY_FIELD', 'pricing.rates.0.confidence']]);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ verifiedAt: null })]; }), [['POLICY_FIELD', 'pricing.rates.0.verifiedAt']]);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ amount: -0.01 })]; }), [['POLICY_RANGE', 'pricing.rates.0.amount']]);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ amount: 1000.5 })]; }), [['POLICY_RANGE', 'pricing.rates.0.amount']]);
  for (const amount of ['0.02', NaN, Infinity, null, true]) {
    expectIssues(pricing((p) => { p.rates = [exampleRate({ amount })]; }), [['POLICY_FIELD', 'pricing.rates.0.amount']]);
  }
  expectOk(pricing((p) => { p.rates = [exampleRate({ amount: 0 })]; }));
  assert.equal(Object.is(validatePolicy(pricing((p) => { p.rates = [exampleRate({ amount: -0 })]; })).policy.pricing.rates[0].amount, 0), true);
  expectIssues(pricing((p) => { p.rates = [exampleRate({ amount: 1000 }), 'rate']; }), [['POLICY_FIELD', 'pricing.rates.1']]);
});

test('issues are collected together, carry code and path only, and never echo values or unsafe key names', () => {
  const broken = policyWith((policy) => {
    policy.revision = MARKER;
    policy.publishedAt = MARKER;
    policy.emergency.reason = { ko: `<${MARKER}>`, en: '', ja: `<b>${MARKER}</b>` };
    policy.features.hubListen = MARKER;
    policy.settings['ui.tone'].default = MARKER;
    policy.settings['captions.size'].step = MARKER;
    policy.notices = [exampleNotice({ id: MARKER, severity: MARKER })];
    policy.sharedEvents = [exampleEvent({ providerId: MARKER.toLowerCase(), allowedCapabilities: [MARKER] }), exampleEvent({ id: 'other', key: MARKER })];
    policy.hubControl.allowedHubIds = [MARKER.toLowerCase().replaceAll('_', '-')];
    policy.pricing.rates = [exampleRate({ model: MARKER, amount: MARKER })];
  });
  const result = expectIssues(broken, [
    ['POLICY_FIELD', 'revision'], ['POLICY_FIELD', 'publishedAt'],
    ['POLICY_TEXT', 'emergency.reason.ko'], ['POLICY_TEXT', 'emergency.reason.en'], ['POLICY_TEXT', 'emergency.reason.ja'],
    ['POLICY_FIELD', 'features.hubListen'],
    ['POLICY_RANGE', 'settings.ui.tone.default'], ['POLICY_FIELD', 'settings.captions.size.step'],
    ['POLICY_FIELD', 'notices.0.id'], ['POLICY_FIELD', 'notices.0.severity'],
    ['POLICY_REFERENCE', 'sharedEvents.0.providerId'], ['POLICY_UNKNOWN_KEY', 'sharedEvents.1.key'], ['POLICY_REFERENCE', 'sharedEvents.0.allowedCapabilities.0'],
    ['POLICY_REFERENCE', 'hubControl.allowedHubIds.0'],
    ['POLICY_FIELD', 'pricing.rates.0.model'], ['POLICY_FIELD', 'pricing.rates.0.amount'],
  ]);
  // Unknown root keys stop validation early: the document is not a policy.
  expectIssues(policyWith((policy) => { policy.revision = 0; policy[`${MARKER} key`] = MARKER; }), [['POLICY_UNKNOWN_KEY', '']]);
  assert.deepEqual(Object.keys(result), ['ok', 'issues']);
  assert.ok(Object.isFrozen(result.issues) && result.issues.every((issue) => Object.isFrozen(issue) && Object.keys(issue).join() === 'code,path'));
  assert.ok(result.issues.every((issue) => POLICY_ISSUE_CODES.includes(issue.code)));
  assert.ok(!inspect(result, { depth: 8 }).includes(MARKER) && !inspect(result, { depth: 8 }).toLowerCase().includes(MARKER.toLowerCase()));
  assert.ok(!('policy' in result));
  // Registries given as garbage behave as empty registries rather than throwing.
  expectIssues(policyWith((policy) => { policy.sharedEvents = [exampleEvent()]; }), [['POLICY_REFERENCE', 'sharedEvents.0.providerId']], { registeredProviderIds: 'gemini' });
});
