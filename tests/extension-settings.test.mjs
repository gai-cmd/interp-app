import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { CAPTION_SIZE as APP_CAPTION_SIZE, clampCaptionSize as appClampCaptionSize } from '../app/preferences.js';
import { LIVE_MODELS, LIVE_VOICE_GENDERS } from '../app/providers/gemini/live-config.js';
import {
  CAPTION_SIZE as CONSTANT_CAPTION_SIZE, TARGET_LANGUAGES, UI_LANGUAGES, VOICE_GENDERS, clampCaptionSize, defaultPartnerLanguage,
  isLanguagePair,
} from '../extension/lib/constants.js';
import { STORAGE_KEYS, validateMessage } from '../extension/lib/protocol.js';
import {
  CAPTION_SIZE, DEFAULT_SETTINGS, MIGRATIONS, createDefaultSettings, deleteKey, hasKey, hostSettingsOf, laneRequestOf,
  migrateSettings, normalizeSettings, readKey, readSettings, resolveKey, updateSettings, writeKey, writeSettings,
} from '../extension/lib/settings.js';

// A Map-backed storage area with the promise shape of the platform's (get(key) resolves { [key]: value }), JSON
// copies both ways, and a call log so a test can assert that only the documented keys are touched.
const FAKE_KEY = ['synthetic', 'x'.repeat(24)].join('-');
const OTHER_KEY = ['synthetic', 'y'.repeat(24)].join('-');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fakeArea(initial = {}, { slowGet = false } = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const log = [];
  return {
    log, data,
    async get(key) {
      log.push(['get', key]);
      if (slowGet) await tick();
      return data.has(key) ? { [key]: JSON.parse(data.get(key)) } : {};
    },
    async set(items) { log.push(['set', Object.keys(items)]); for (const [key, value] of Object.entries(items)) data.set(key, JSON.stringify(value)); },
    async remove(key) { log.push(['remove', key]); data.delete(key); },
    read: (key) => (data.has(key) ? JSON.parse(data.get(key)) : undefined),
    writes: () => log.filter(([kind]) => kind !== 'get'),
  };
}
function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}
const SETTINGS_KEYS = ['v', 'uiLanguage', 'voiceGender', 'speechMuted', 'lanes', 'captions'];
// A strict shape check every normalized value must pass, whatever went in.
function assertNormalized(settings, label = '', { frozen = true } = {}) {
  assert.deepEqual(Object.keys(settings), SETTINGS_KEYS, label);
  assert.equal(settings.v, 1);
  assert.ok(UI_LANGUAGES.includes(settings.uiLanguage), label);
  assert.ok(LIVE_VOICE_GENDERS.includes(settings.voiceGender), label);
  assert.equal(typeof settings.speechMuted, 'boolean');
  assert.deepEqual(Object.keys(settings.lanes), ['tab', 'mic']);
  // Two-way (twoWay, partnerLanguage) joined the lane fields: the D10 "no two-way" non-goal was reversed.
  assert.deepEqual(Object.keys(settings.lanes.tab), ['enabled', 'targetLanguage', 'twoWay', 'partnerLanguage', 'model', 'originalVolume', 'captions'], label);
  assert.deepEqual(Object.keys(settings.lanes.mic), ['enabled', 'targetLanguage', 'twoWay', 'partnerLanguage', 'model', 'captions'], label);
  for (const lane of Object.values(settings.lanes)) {
    assert.equal(typeof lane.enabled, 'boolean');
    assert.ok(TARGET_LANGUAGES.includes(lane.targetLanguage));
    assert.equal(typeof lane.twoWay, 'boolean', label);
    assert.ok(isLanguagePair([lane.targetLanguage, lane.partnerLanguage]), `${label}: the partner is a language other than the target`);
    assert.ok(LIVE_MODELS.includes(lane.model));
    assert.equal(typeof lane.captions, 'boolean');
  }
  assert.ok(Number.isInteger(settings.lanes.tab.originalVolume) && settings.lanes.tab.originalVolume >= 0 && settings.lanes.tab.originalVolume <= 100);
  assert.deepEqual(Object.keys(settings.captions), ['size', 'position', 'display', 'showSource', 'maxLines', 'autoHideSeconds']);
  assert.equal(clampCaptionSize(settings.captions.size), settings.captions.size);
  assert.ok(['top', 'bottom'].includes(settings.captions.position));
  assert.ok(['dark', 'light', 'mono'].includes(settings.captions.display));
  assert.equal(typeof settings.captions.showSource, 'boolean');
  assert.ok(Number.isInteger(settings.captions.maxLines) && settings.captions.maxLines >= 1 && settings.captions.maxLines <= 6);
  assert.ok(Number.isInteger(settings.captions.autoHideSeconds) && settings.captions.autoHideSeconds >= 0 && settings.captions.autoHideSeconds <= 60);
  if (frozen) assert.ok(isDeepFrozen(settings), 'deep-frozen');
}

test('DEFAULT_SETTINGS is frozen and equals the 7.1 listing (microphone captions default to off)', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { v: 1, uiLanguage: 'auto', voiceGender: 'female', speechMuted: true,
    lanes: {
      tab: { enabled: true, targetLanguage: 'ko', twoWay: false, partnerLanguage: 'en', model: 'gemini-3.5-live-translate-preview', originalVolume: 65, captions: true },
      mic: { enabled: false, targetLanguage: 'en', twoWay: false, partnerLanguage: 'ko', model: 'gemini-3.8-live', captions: false },
    },
    captions: { size: 1.5, position: 'bottom', display: 'dark', showSource: false, maxLines: 3, autoHideSeconds: 8 } });
  assert.ok(isDeepFrozen(DEFAULT_SETTINGS));
  assert.equal(DEFAULT_SETTINGS.lanes.mic.captions, false);
  assert.equal(DEFAULT_SETTINGS.lanes.mic.enabled, false);
  assert.equal(DEFAULT_SETTINGS.speechMuted, true);
  assertNormalized(DEFAULT_SETTINGS);
  assert.deepEqual(createDefaultSettings('ko'), DEFAULT_SETTINGS);
  assert.ok(Object.isFrozen(MIGRATIONS) && Object.keys(MIGRATIONS).length === 0);
});

test('createDefaultSettings seeds both target languages from the UI language', () => {
  const seeded = (language) => { const s = createDefaultSettings(language); return [s.lanes.tab.targetLanguage, s.lanes.mic.targetLanguage]; };
  assert.deepEqual(seeded('ko'), ['ko', 'en']);
  assert.deepEqual(seeded('en'), ['en', 'ja']);
  assert.deepEqual(seeded('ja'), ['ja', 'en']);
  for (const language of [undefined, 'auto', 'fr', '', null, 5, {}]) assert.deepEqual(seeded(language), ['en', 'ja'], String(language));
  for (const language of TARGET_LANGUAGES) {
    const [tab, mic] = seeded(language);
    assert.notEqual(tab, mic, 'the two lanes never start with the same language');
    assert.equal(createDefaultSettings(language).uiLanguage, 'auto', 'seeding does not fix the UI language');
    assertNormalized(createDefaultSettings(language));
  }
  assert.notEqual(createDefaultSettings('en'), createDefaultSettings('en'), 'each call builds a fresh object');
});

test('normalizeSettings never throws on garbage and always returns a valid frozen v1', () => {
  const cyclic = { lanes: {} }; cyclic.lanes.tab = cyclic; cyclic.self = cyclic; cyclic.captions = cyclic;
  const throwing = { get lanes() { throw new Error('boom'); }, uiLanguage: 'ko' };
  const hostile = new Proxy({}, { get() { throw new Error('proxy'); }, getPrototypeOf() { throw new Error('proxy'); } });
  const garbage = [undefined, null, 0, 5, NaN, -1, 'settings', '', true, false, [], [1, 2], [{ v: 1 }], () => ({}), Symbol('x'), 10n,
    new Date(0), new Map(), {}, { v: 'x' }, { lanes: 5 }, { lanes: [] }, { lanes: { tab: [], mic: 'x' } }, { lanes: { tab: { originalVolume: {} } } },
    { captions: [] }, { captions: 'big' }, { captions: { size: {}, maxLines: [], position: 5 } }, { lanes: { tab: null, mic: null }, captions: null },
    JSON.parse('{"__proto__":{"polluted":true},"lanes":{"__proto__":{"x":1}}}'), cyclic, throwing, hostile];
  for (const value of garbage) {
    let result;
    assert.doesNotThrow(() => { result = normalizeSettings(value); }, String(typeof value));
    assertNormalized(result);
    assert.equal({}.polluted, undefined);
  }
});

test('normalizeSettings: a non-object gives the English seed, a partial object takes field defaults', () => {
  for (const value of [undefined, null, 4, 'x', [], true]) assert.deepEqual(normalizeSettings(value), createDefaultSettings('en'));
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS, 'missing fields take the default of that field');
  assert.deepEqual(normalizeSettings({ lanes: { tab: { targetLanguage: 'ja' } } }).lanes,
    { tab: { ...DEFAULT_SETTINGS.lanes.tab, targetLanguage: 'ja' }, mic: DEFAULT_SETTINGS.lanes.mic });
  assert.deepEqual(normalizeSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
});

test('normalizeSettings: top-level enums and booleans', () => {
  const norm = (patch) => normalizeSettings({ ...DEFAULT_SETTINGS, ...patch });
  for (const uiLanguage of UI_LANGUAGES) assert.equal(norm({ uiLanguage }).uiLanguage, uiLanguage);
  for (const uiLanguage of ['fr', '', null, 3, 'KO', ['ko']]) assert.equal(norm({ uiLanguage }).uiLanguage, 'auto');
  for (const voiceGender of LIVE_VOICE_GENDERS) assert.equal(norm({ voiceGender }).voiceGender, voiceGender);
  for (const voiceGender of ['robot', '', null, 1, 'Female']) assert.equal(norm({ voiceGender }).voiceGender, 'female');
  assert.equal(norm({ speechMuted: false }).speechMuted, false);
  assert.equal(norm({ speechMuted: true }).speechMuted, true);
  for (const speechMuted of ['false', 0, null, undefined, 'yes']) assert.equal(norm({ speechMuted }).speechMuted, true, 'a non-boolean keeps the muted default');
});

test('normalizeSettings: per-lane rules', () => {
  const tab = (patch) => normalizeSettings({ lanes: { tab: patch } }).lanes.tab;
  const mic = (patch) => normalizeSettings({ lanes: { mic: patch } }).lanes.mic;
  assert.equal(tab({ enabled: false }).enabled, false);
  assert.equal(mic({ enabled: true }).enabled, true);
  for (const enabled of ['true', 1, null]) { assert.equal(tab({ enabled }).enabled, true); assert.equal(mic({ enabled }).enabled, false); }
  for (const targetLanguage of TARGET_LANGUAGES) assert.equal(tab({ targetLanguage }).targetLanguage, targetLanguage);
  for (const targetLanguage of ['fr', 'auto', '', null, 'KO']) {
    assert.equal(tab({ targetLanguage }).targetLanguage, 'ko');
    assert.equal(mic({ targetLanguage }).targetLanguage, 'en');
  }
  for (const model of LIVE_MODELS) { assert.equal(tab({ model }).model, model); assert.equal(mic({ model }).model, model); }
  for (const model of ['gemini-9', '', null, 5, 'gemini-3.8-live ']) {
    assert.equal(tab({ model }).model, 'gemini-3.5-live-translate-preview', 'an unknown model becomes that lane\'s default');
    assert.equal(mic({ model }).model, 'gemini-3.8-live');
  }
  for (const [input, expected] of [[0, 0], [100, 100], [65, 65], [33.6, 34], [33.4, 33], [150, 100], [-5, 0], [-0.4, 0], [100.4, 100], [Number.MAX_VALUE, 100], [-Infinity, 65],
    [Infinity, 65], [NaN, 65], ['70', 65], [null, 65], [undefined, 65], [true, 65], [{}, 65], [[70], 65]]) {
    assert.equal(tab({ originalVolume: input }).originalVolume, expected, String(input));
  }
  assert.ok(Object.is(tab({ originalVolume: -0.4 }).originalVolume, 0), 'no negative zero');
  for (const captions of [true, false]) { assert.equal(tab({ captions }).captions, captions); assert.equal(mic({ captions }).captions, captions); }
  for (const captions of ['true', 1, null]) { assert.equal(tab({ captions }).captions, true); assert.equal(mic({ captions }).captions, false, 'microphone captions stay off unless explicitly on'); }
  assert.equal('originalVolume' in mic({ originalVolume: 10 }), false, 'the microphone lane has no original volume');
});

test('normalizeSettings: caption style rules (nearest step, enums, integer ranges fall back to the default)', () => {
  const style = (patch) => normalizeSettings({ captions: patch }).captions;
  for (const [input, expected] of [[1, 1], [2, 2], [1.5, 1.5], [1.1875, 1.25], [1.6, 1.625], [3, 2], [0.2, 1], [-4, 1], ['1.3', 1.25], ['abc', 1.5], [NaN, 1.5],
    [Infinity, 1.5], [null, 1.5], [undefined, 1.5], [{}, 1.5], [true, 1.5], [1.0625, 1.125], [1.0624, 1], [1.0626, 1.125]]) {
    assert.equal(style({ size: input }).size, expected, String(input));
  }
  for (const position of ['top', 'bottom']) assert.equal(style({ position }).position, position);
  for (const position of ['left', '', null, 1]) assert.equal(style({ position }).position, 'bottom');
  for (const display of ['dark', 'light', 'mono']) assert.equal(style({ display }).display, display);
  for (const display of ['blue', '', null, 0]) assert.equal(style({ display }).display, 'dark');
  assert.equal(style({ showSource: true }).showSource, true);
  for (const showSource of ['true', 1, null]) assert.equal(style({ showSource }).showSource, false);
  for (const maxLines of [1, 2, 3, 4, 5, 6]) assert.equal(style({ maxLines }).maxLines, maxLines);
  for (const maxLines of [0, 7, -1, 2.5, '4', null, NaN, 100]) assert.equal(style({ maxLines }).maxLines, 3, `maxLines ${String(maxLines)}`);
  for (const autoHideSeconds of [0, 1, 8, 59, 60]) assert.equal(style({ autoHideSeconds }).autoHideSeconds, autoHideSeconds);
  for (const autoHideSeconds of [-1, 61, 1.5, '8', null, NaN, 1e9]) assert.equal(style({ autoHideSeconds }).autoHideSeconds, 8, `autoHideSeconds ${String(autoHideSeconds)}`);
});

test('normalizeSettings: unknown fields are dropped, v is always 1, the result is idempotent and key material never survives', () => {
  const noisy = { v: 9, uiLanguage: 'ja', extra: { a: 1 }, key: FAKE_KEY, apiKey: FAKE_KEY,
    lanes: { tab: { enabled: true, key: FAKE_KEY, sessionId: 's', targetLanguage: 'en' }, mic: { streamId: 'x' }, third: {} },
    captions: { size: 1.25, color: 'red', token: FAKE_KEY } };
  const result = normalizeSettings(noisy);
  assertNormalized(result);
  assert.equal(result.v, 1);
  assert.equal(result.uiLanguage, 'ja');
  assert.equal(result.lanes.tab.targetLanguage, 'en');
  assert.equal(result.captions.size, 1.25);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  assert.equal(JSON.stringify(result).includes('sessionId'), false);
  assert.deepEqual(normalizeSettings(result), result);
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(result))), result);
  assert.equal(noisy.v, 9, 'the input is not modified');
  assert.equal(Object.isFrozen(noisy), false);
});

test('migrateSettings: nullish and non-objects give defaults, v1 is read as is, a future version is read as v1', () => {
  for (const value of [undefined, null, 'x', 3, []]) assert.deepEqual(migrateSettings(value), createDefaultSettings('en'));
  assert.deepEqual(migrateSettings({ ...DEFAULT_SETTINGS, speechMuted: false }), { ...DEFAULT_SETTINGS, speechMuted: false });
  const future = migrateSettings({ v: 9, uiLanguage: 'en', voiceGender: 'male', added: { later: true }, lanes: { tab: { targetLanguage: 'ja', newField: 1 } } });
  assertNormalized(future);
  assert.equal(future.v, 1);
  assert.equal(future.voiceGender, 'male');
  assert.equal(future.lanes.tab.targetLanguage, 'ja');
  assert.equal('added' in future, false);
  assert.equal('newField' in future.lanes.tab, false);
});

test('migrateSettings applies the MIGRATIONS steps in order before normalizing, and stops on a step that does not advance', () => {
  const seen = [];
  const table = { 1: (record) => { seen.push(1); return { ...record, v: 2, uiLanguage: 'ja' }; },
    2: (record) => { seen.push(2); return { ...record, v: 3, voiceGender: 'male' }; } };
  const result = migrateSettings({ v: 1 }, table);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.uiLanguage, 'ja');
  assert.equal(result.voiceGender, 'male');
  assert.equal(result.v, 1, 'the output is always v1 of this schema');
  assert.deepEqual(migrateSettings({ v: 3, uiLanguage: 'en' }, table).uiLanguage, 'en', 'no step for a version means no change');
  assert.equal(migrateSettings({ v: 1, uiLanguage: 'en' }, { 1: (record) => ({ ...record, v: 1, uiLanguage: 'ja' }) }).uiLanguage, 'en', 'a step must raise the version');
  assert.equal(migrateSettings({ v: 1, uiLanguage: 'en' }, { 1: () => { throw new Error('bad step'); } }).uiLanguage, 'en', 'a throwing step keeps the last good record');
  assert.equal(migrateSettings({ v: 1, uiLanguage: 'en' }, { 1: () => 'nope' }).uiLanguage, 'en');
  assert.doesNotThrow(() => migrateSettings({ v: 1 }, { 1: (record) => ({ ...record, v: 1 + 1 }), 2: (record) => ({ ...record, v: record.v + 1 }), 3: (record) => ({ ...record, v: 4 }) }));
  // a table that never stops cannot loop forever
  assert.doesNotThrow(() => migrateSettings({ v: 1 }, new Proxy({}, { has: () => true, get: () => (record) => ({ ...record, v: record.v + 1 }), getOwnPropertyDescriptor: () => ({ value: (r) => ({ ...r, v: r.v + 1 }), enumerable: true, configurable: true }) })));
});

test('hostSettingsOf carries only what a running host applies live and passes the wire validator', () => {
  const settings = normalizeSettings({ speechMuted: false, lanes: { tab: { originalVolume: 30, captions: false, targetLanguage: 'ja', model: 'gemini-3.8-live' },
    mic: { captions: true } }, captions: { size: 1.75, position: 'top', display: 'mono', showSource: true, maxLines: 5, autoHideSeconds: 0 } });
  const host = hostSettingsOf(settings);
  assert.deepEqual(host, { speechMuted: false, tabOriginalVolume: 30, captions: { tab: false, mic: true },
    style: { size: 1.75, position: 'top', display: 'mono', showSource: true, maxLines: 5, autoHideSeconds: 0 } });
  assert.ok(isDeepFrozen(host));
  const text = JSON.stringify(host);
  for (const forbidden of ['key', 'targetLanguage', 'model', 'gemini', 'uiLanguage', 'voice']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(hostSettingsOf(DEFAULT_SETTINGS), { speechMuted: true, tabOriginalVolume: 65, captions: { tab: true, mic: false },
    style: { size: 1.5, position: 'bottom', display: 'dark', showSource: false, maxLines: 3, autoHideSeconds: 8 } });
  const wire = validateMessage({ v: 1, target: 'offscreen', type: 'host/settings', settings: host });
  assert.equal(wire.ok, true, 'the SW can never send settings the host rejects');
  assert.deepEqual(wire.message.settings, host);
  for (const garbage of [undefined, null, 'x', [], { captions: { size: 'huge' } }]) {
    assert.equal(validateMessage({ v: 1, target: 'offscreen', type: 'host/settings', settings: hostSettingsOf(garbage) }).ok, true);
  }
});

test('laneRequestOf returns the per-lane language and model, and refuses an unknown lane', () => {
  const settings = normalizeSettings({ lanes: { tab: { targetLanguage: 'en', model: 'gemini-3.8-live' }, mic: { targetLanguage: 'ko', model: 'gemini-3.5-live-translate-preview' } } });
  assert.deepEqual(laneRequestOf(settings, 'tab'), { targetLanguage: 'en', model: 'gemini-3.8-live' });
  assert.deepEqual(laneRequestOf(settings, 'mic'), { targetLanguage: 'ko', model: 'gemini-3.5-live-translate-preview' });
  assert.deepEqual(laneRequestOf(DEFAULT_SETTINGS, 'tab'), { targetLanguage: 'ko', model: 'gemini-3.5-live-translate-preview' });
  assert.deepEqual(laneRequestOf(undefined, 'mic'), { targetLanguage: 'ja', model: 'gemini-3.8-live' }, 'garbage settings fall back to the English seed');
  assert.ok(Object.isFrozen(laneRequestOf(settings, 'tab')));
  assert.deepEqual(Object.keys(laneRequestOf(settings, 'tab')), ['targetLanguage', 'model']);
  for (const lane of ['both', undefined, '', 'TAB', 0]) assert.throws(() => laneRequestOf(settings, lane), (error) => error.code === 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------------------------
// Two-way mode: per-lane `twoWay` and `partnerLanguage` (the D10 "no two-way" non-goal is reversed).

test('two-way defaults: off, and the partner is English unless the lane\'s language is English (then Korean)', () => {
  assert.equal(defaultPartnerLanguage('ko'), 'en');
  assert.equal(defaultPartnerLanguage('ja'), 'en');
  assert.equal(defaultPartnerLanguage('en'), 'ko');
  for (const language of [undefined, 'auto', 'fr', null]) assert.equal(defaultPartnerLanguage(language), 'en', String(language));
  for (const ui of [undefined, 'ko', 'en', 'ja', 'fr']) {
    const defaults = createDefaultSettings(ui);
    for (const lane of Object.values(defaults.lanes)) {
      assert.equal(lane.twoWay, false, `${ui}: two-way is opt-in`);
      assert.equal(lane.partnerLanguage, defaultPartnerLanguage(lane.targetLanguage), ui);
      assert.notEqual(lane.partnerLanguage, lane.targetLanguage, ui);
    }
    assertNormalized(defaults);
  }
  assert.deepEqual([DEFAULT_SETTINGS.lanes.tab.partnerLanguage, DEFAULT_SETTINGS.lanes.mic.partnerLanguage], ['en', 'ko']);
  assert.deepEqual(createDefaultSettings('en').lanes.tab, { ...DEFAULT_SETTINGS.lanes.tab, targetLanguage: 'en', partnerLanguage: 'ko' });
});

test('isLanguagePair accepts exactly two distinct interpretation languages', () => {
  for (const first of TARGET_LANGUAGES) {
    for (const second of TARGET_LANGUAGES) assert.equal(isLanguagePair([first, second]), first !== second, `${first} ${second}`);
  }
  const sparse = new Array(2); sparse[0] = 'ko';
  for (const bad of [undefined, null, 'ko,en', {}, [], ['ko'], ['ko', 'en', 'ja'], ['ko', 'fr'], ['fr', 'de'], ['ko', null], ['ko', undefined], [1, 2], sparse,
    { 0: 'ko', 1: 'en', length: 2 }, new Set(['ko', 'en'])]) assert.equal(isLanguagePair(bad), false, JSON.stringify(bad));
});

test('normalizeSettings: a record from before two-way existed reads as one-way with the default partner, everything else kept', () => {
  const old = { v: 1, uiLanguage: 'ja', voiceGender: 'male', speechMuted: false,
    lanes: { tab: { enabled: false, targetLanguage: 'en', model: 'gemini-3.8-live', originalVolume: 30, captions: false },
      mic: { enabled: true, targetLanguage: 'ja', model: 'gemini-3.5-live-translate-preview', captions: true } },
    captions: { size: 1.25, position: 'top', display: 'mono', showSource: true, maxLines: 5, autoHideSeconds: 0 } };
  const read = migrateSettings(old);
  assertNormalized(read);
  assert.deepEqual(read.lanes.tab, { enabled: false, targetLanguage: 'en', twoWay: false, partnerLanguage: 'ko', model: 'gemini-3.8-live', originalVolume: 30, captions: false });
  assert.deepEqual(read.lanes.mic, { enabled: true, targetLanguage: 'ja', twoWay: false, partnerLanguage: 'en', model: 'gemini-3.5-live-translate-preview', captions: true });
  assert.equal(read.v, 1, 'no storage version bump: the missing fields are defaults');
  assert.equal(read.voiceGender, 'male');
  assert.deepEqual(normalizeSettings(read), read, 'idempotent');
  assert.equal(laneRequestOf(read, 'tab').languages, undefined, 'a migrated lane stays one-way');
});

test('normalizeSettings: twoWay is a strict boolean (default false), partnerLanguage one of ko/en/ja', () => {
  const lane = (patch, which = 'tab') => normalizeSettings({ lanes: { [which]: patch } }).lanes[which];
  assert.equal(lane({ twoWay: true }).twoWay, true);
  assert.equal(lane({ twoWay: false }).twoWay, false);
  for (const twoWay of ['true', 1, 'yes', null, undefined, {}, [true]]) assert.equal(lane({ twoWay }).twoWay, false, String(twoWay));
  // every valid (target, partner) pair is kept as it is, for both lanes
  for (const targetLanguage of TARGET_LANGUAGES) {
    for (const partnerLanguage of TARGET_LANGUAGES.filter((code) => code !== targetLanguage)) {
      for (const which of ['tab', 'mic']) {
        const kept = lane({ targetLanguage, partnerLanguage, twoWay: true }, which);
        assert.deepEqual([kept.targetLanguage, kept.partnerLanguage, kept.twoWay], [targetLanguage, partnerLanguage, true], `${which} ${targetLanguage}/${partnerLanguage}`);
      }
    }
  }
  // a partner that is unknown, mistyped or missing becomes the default partner of the lane's language
  for (const partnerLanguage of ['fr', 'auto', '', null, 5, 'KO', ['ko'], {}, undefined]) {
    assert.equal(lane({ targetLanguage: 'ja', partnerLanguage }).partnerLanguage, 'en', String(partnerLanguage));
    assert.equal(lane({ targetLanguage: 'en', partnerLanguage }).partnerLanguage, 'ko', String(partnerLanguage));
  }
  assert.equal(lane({}).partnerLanguage, 'en', 'tab default: target ko, partner en');
  assert.equal(lane({}, 'mic').partnerLanguage, 'ko', 'mic default: target en, partner ko');
});

test('normalizeSettings: a partner equal to the target is repaired to the default partner of that target, never left equal', () => {
  const lane = (patch, which = 'tab') => normalizeSettings({ lanes: { [which]: patch } }).lanes[which];
  for (const which of ['tab', 'mic']) {
    for (const language of TARGET_LANGUAGES) {
      const repaired = lane({ targetLanguage: language, partnerLanguage: language, twoWay: true }, which);
      assert.equal(repaired.partnerLanguage, defaultPartnerLanguage(language), `${which} ${language}`);
      assert.notEqual(repaired.partnerLanguage, repaired.targetLanguage);
    }
  }
  // the repair follows the NORMALIZED target: an unreadable target falls back to the lane default first
  assert.deepEqual(lane({ targetLanguage: 'fr', partnerLanguage: 'ko' }), { ...DEFAULT_SETTINGS.lanes.tab, partnerLanguage: 'en' }, 'tab: target falls back to ko, so ko as partner is repaired to en');
  assert.equal(lane({ targetLanguage: 'fr', partnerLanguage: 'ko' }, 'mic').partnerLanguage, 'ko', 'mic: target falls back to en, so ko is a valid partner');
  assert.equal(lane({ targetLanguage: 'fr', partnerLanguage: 'en' }, 'mic').partnerLanguage, 'ko', 'mic: en equals the fallback target en');
});

test('settings storage: an old record is read without a write; a changed target that equals the partner is repaired in the saved record', async () => {
  const old = { v: 1, uiLanguage: 'auto', voiceGender: 'female', speechMuted: true,
    lanes: { tab: { enabled: true, targetLanguage: 'ko', model: 'gemini-3.5-live-translate-preview', originalVolume: 65, captions: true },
      mic: { enabled: false, targetLanguage: 'en', model: 'gemini-3.8-live', captions: false } },
    captions: { size: 1.5, position: 'bottom', display: 'dark', showSource: false, maxLines: 3, autoHideSeconds: 8 } };
  const area = fakeArea({ [STORAGE_KEYS.settings]: old });
  assert.deepEqual(await readSettings(area), DEFAULT_SETTINGS, 'the old record reads as the defaults it had');
  assert.deepEqual(area.writes(), [], 'reading never upgrades the stored record');

  const chosen = await updateSettings(area, (draft) => { draft.lanes.tab.twoWay = true; draft.lanes.tab.partnerLanguage = 'ja'; });
  assert.deepEqual([chosen.lanes.tab.twoWay, chosen.lanes.tab.partnerLanguage], [true, 'ja']);
  assert.deepEqual(area.read(STORAGE_KEYS.settings).lanes.tab.partnerLanguage, 'ja');
  // the user picks the partner's language as the first language: the saved pair is repaired, not left as ja/ja
  const moved = await updateSettings(area, (draft) => { draft.lanes.tab.targetLanguage = 'ja'; });
  assert.equal(moved.lanes.tab.partnerLanguage, 'en');
  assert.deepEqual(area.read(STORAGE_KEYS.settings).lanes.tab, { ...moved.lanes.tab });
  assert.deepEqual([moved.lanes.tab.targetLanguage, moved.lanes.tab.partnerLanguage, moved.lanes.tab.twoWay], ['ja', 'en', true]);
  assert.deepEqual(laneRequestOf(await readSettings(area), 'tab').languages, ['ja', 'en']);
});

test('laneRequestOf: a two-way lane adds languages [target, partner]; targetLanguage and model stay; one-way adds nothing', () => {
  const settings = normalizeSettings({ lanes: {
    tab: { targetLanguage: 'ko', twoWay: true, partnerLanguage: 'ja', model: 'gemini-3.8-live' },
    mic: { targetLanguage: 'en', twoWay: true, model: 'gemini-3.5-live-translate-preview' } } });
  const tab = laneRequestOf(settings, 'tab');
  assert.deepEqual(tab, { targetLanguage: 'ko', model: 'gemini-3.8-live', languages: ['ko', 'ja'] });
  assert.deepEqual(Object.keys(tab), ['targetLanguage', 'model', 'languages']);
  assert.ok(Object.isFrozen(tab) && Object.isFrozen(tab.languages), 'the request and its pair are frozen');
  // the pair is ordered [target, partner]; the default partner of English is Korean
  assert.deepEqual(laneRequestOf(settings, 'mic'), { targetLanguage: 'en', model: 'gemini-3.5-live-translate-preview', languages: ['en', 'ko'] },
    'the model is NOT changed here: the engine moves a translation-only model to an instruction-driven one itself');
  // off, or a partner left over from an earlier choice, gives the same request as before two-way existed
  const off = normalizeSettings({ lanes: { tab: { targetLanguage: 'ko', twoWay: false, partnerLanguage: 'ja' } } });
  assert.deepEqual(laneRequestOf(off, 'tab'), { targetLanguage: 'ko', model: 'gemini-3.5-live-translate-preview' });
  assert.equal(Object.hasOwn(laneRequestOf(off, 'tab'), 'languages'), false);
  assert.equal(Object.hasOwn(laneRequestOf(DEFAULT_SETTINGS, 'mic'), 'languages'), false);
  // a stored pair that is not a pair is repaired before it can reach a request
  for (const [targetLanguage, partnerLanguage, expected] of [['en', 'en', ['en', 'ko']], ['ja', 'ja', ['ja', 'en']], ['ko', 'ko', ['ko', 'en']], ['ko', 'fr', ['ko', 'en']]]) {
    const request = laneRequestOf({ lanes: { tab: { targetLanguage, partnerLanguage, twoWay: true } } }, 'tab');
    assert.deepEqual(request.languages, expected, `${targetLanguage}/${partnerLanguage}`);
    assert.ok(isLanguagePair(request.languages));
  }
  assert.deepEqual(laneRequestOf({ lanes: { tab: { twoWay: 'true' } } }, 'tab'), laneRequestOf(DEFAULT_SETTINGS, 'tab'), 'a non-boolean twoWay is off');
});

test('laneRequestOf output is accepted by the host/lane-start validator, the pair included', () => {
  const settings = normalizeSettings({ lanes: { tab: { targetLanguage: 'ja', twoWay: true, partnerLanguage: 'ko' } } });
  const message = { v: 1, target: 'offscreen', type: 'host/lane-start', lane: 'tab', key: FAKE_KEY, request: laneRequestOf(settings, 'tab'),
    voiceGender: 'female', muted: true, captions: true, style: hostSettingsOf(settings).style, tab: { tabId: 1, streamId: 's', originalVolume: 65 } };
  const checked = validateMessage(message);
  assert.equal(checked.ok, true, 'the SW can never build a start the host refuses');
  assert.deepEqual(checked.message.request.languages, ['ja', 'ko']);
  assert.equal(validateMessage({ ...message, request: laneRequestOf(DEFAULT_SETTINGS, 'tab') }).ok, true, 'and the one-way request still passes');
});

test('hostSettingsOf never carries two-way: it applies from the next start, like the language', () => {
  const settings = normalizeSettings({ lanes: { tab: { twoWay: true, partnerLanguage: 'ja' }, mic: { twoWay: true } } });
  const host = hostSettingsOf(settings);
  assert.deepEqual(host, hostSettingsOf(DEFAULT_SETTINGS), 'switching two-way changes nothing a running host applies live');
  for (const forbidden of ['twoWay', 'partner', 'languages']) assert.equal(JSON.stringify(host).includes(forbidden), false, forbidden);
});

test('parity with the app: voice genders, target languages, caption size and its clamp', () => {
  assert.deepEqual(VOICE_GENDERS, LIVE_VOICE_GENDERS);
  assert.deepEqual(TARGET_LANGUAGES, SUPPORTED_LANGUAGES);
  assert.deepEqual(CONSTANT_CAPTION_SIZE, APP_CAPTION_SIZE);
  assert.equal(CAPTION_SIZE, CONSTANT_CAPTION_SIZE, 'settings.js re-exports the one definition');
  const grid = [];
  for (let value = -2; value <= 5; value += 0.0625) grid.push(value);
  grid.push(...['1', '1.5', '1.26', ' 1.5', '2rem', 'abc', '', '   ', '1e0', '0x10', '-1', '99'], NaN, Infinity, -Infinity, null, undefined, {}, [], [1.5], true, false, 0, -0, 1.0625, 1.0626, 1.9375, 2.0625, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE);
  for (const value of grid) {
    assert.ok(Object.is(clampCaptionSize(value), appClampCaptionSize(value)), `clamp(${String(value)}) ${clampCaptionSize(value)} vs ${appClampCaptionSize(value)}`);
  }
  assert.equal(DEFAULT_SETTINGS.captions.size, APP_CAPTION_SIZE.initial);
  for (const lane of Object.values(DEFAULT_SETTINGS.lanes)) assert.ok(LIVE_MODELS.includes(lane.model));
});

test('readSettings reads exactly the settings key, normalizes what it finds and never writes', async () => {
  const empty = fakeArea();
  assert.deepEqual(await readSettings(empty), createDefaultSettings('en'));
  assert.deepEqual(empty.log, [['get', 'interp.settings.v1']]);
  const stored = fakeArea({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, speechMuted: false, lanes: { tab: { enabled: false } } } });
  const read = await readSettings(stored);
  assertNormalized(read);
  assert.equal(read.speechMuted, false);
  assert.equal(read.lanes.tab.enabled, false);
  assert.equal(read.lanes.mic.model, 'gemini-3.8-live');
  const future = fakeArea({ [STORAGE_KEYS.settings]: { v: 9, speechMuted: false, later: 1 } });
  const before = future.read(STORAGE_KEYS.settings);
  assert.equal((await readSettings(future)).speechMuted, false);
  assert.deepEqual(future.writes(), [], 'a newer record is never rewritten by a read');
  assert.deepEqual(future.read(STORAGE_KEYS.settings), before);
  for (const junk of ['x', 5, null, []]) assert.deepEqual(await readSettings(fakeArea({ [STORAGE_KEYS.settings]: junk })), createDefaultSettings('en'));
  assert.deepEqual(await readSettings(fakeArea({ [STORAGE_KEYS.settings]: { v: 'a' } })), DEFAULT_SETTINGS, 'an object with no usable field takes the field defaults');
  const failing = { get: async () => { throw new Error('storage down'); } };
  await assert.rejects(readSettings(failing), /storage down/, 'a storage failure propagates so the caller can show STORAGE_FAILED');
});

test('writeSettings normalizes, stores under the one key and returns the stored value', async () => {
  const area = fakeArea();
  const written = await writeSettings(area, { uiLanguage: 'ko', speechMuted: false, extra: 1, lanes: { tab: { originalVolume: 900 } } });
  assertNormalized(written);
  assert.equal(written.lanes.tab.originalVolume, 100);
  assert.deepEqual(area.writes(), [['set', ['interp.settings.v1']]]);
  assert.deepEqual(area.read(STORAGE_KEYS.settings), written);
  assert.equal('extra' in area.read(STORAGE_KEYS.settings), false);
  assert.deepEqual(await readSettings(area), written);
  assertNormalized(await writeSettings(area, 'garbage'));
  assert.deepEqual(area.read(STORAGE_KEYS.settings), createDefaultSettings('en'));
  await assert.rejects(writeSettings({ set: async () => { throw new Error('quota'); } }, DEFAULT_SETTINGS), /quota/);
});

test('updateSettings is read -> mutate -> write with a private mutable copy, and returns the new settings', async () => {
  const area = fakeArea({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, uiLanguage: 'ja' } });
  let handed;
  const result = await updateSettings(area, (draft) => { handed = draft; draft.lanes.tab.originalVolume = 20; draft.speechMuted = false; });
  assert.equal(Object.isFrozen(handed), false, 'the mutator gets a mutable copy');
  assert.equal(result.lanes.tab.originalVolume, 20);
  assert.equal(result.speechMuted, false);
  assert.equal(result.uiLanguage, 'ja', 'fields the mutator did not touch survive');
  assertNormalized(result);
  assert.deepEqual(area.read(STORAGE_KEYS.settings), result);
  assert.deepEqual(area.log.map(([kind]) => kind), ['get', 'set']);
  const replaced = await updateSettings(area, (draft) => ({ ...draft, voiceGender: 'male' }));
  assert.equal(replaced.voiceGender, 'male');
  assert.equal(replaced.lanes.tab.originalVolume, 20);
  const async = await updateSettings(area, async (draft) => { await tick(); draft.captions.size = 2; });
  assert.equal(async.captions.size, 2);
  assert.equal((await updateSettings(area, (draft) => { draft.lanes.tab.originalVolume = 9999; draft.captions.size = 1.1; })).lanes.tab.originalVolume, 100, 'the write is normalized');
  const empty = fakeArea();
  assert.equal((await updateSettings(empty, (draft) => { draft.speechMuted = false; })).speechMuted, false);
  assertNormalized(empty.read(STORAGE_KEYS.settings), 'stored', { frozen: false });
});

test('updateSettings serializes overlapping calls so each writer keeps its own field', async () => {
  const area = fakeArea({}, { slowGet: true });
  await Promise.all([
    writeSettings(area, { ...DEFAULT_SETTINGS, uiLanguage: 'en' }).then(() => updateSettings(area, (draft) => { draft.captions.maxLines = 5; })),
    updateSettings(area, (draft) => { draft.lanes.tab.originalVolume = 10; }),
    updateSettings(area, (draft) => { draft.speechMuted = false; }),
    updateSettings(area, async (draft) => { await tick(); draft.voiceGender = 'male'; }),
  ]);
  const final = area.read(STORAGE_KEYS.settings);
  assert.equal(final.lanes.tab.originalVolume, 10);
  assert.equal(final.speechMuted, false);
  assert.equal(final.voiceGender, 'male');
  assert.equal(final.captions.maxLines, 5);
  assert.equal(final.uiLanguage, 'en');
  assertNormalized(final, 'stored', { frozen: false });
});

test('updateSettings: a failing mutator or storage call writes nothing and does not block later writers', async () => {
  const area = fakeArea({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, uiLanguage: 'en' } });
  await assert.rejects(updateSettings(area, () => { throw new Error('mutator broke'); }), /mutator broke/);
  await assert.rejects(updateSettings(area, async () => { throw new Error('async mutator broke'); }), /async mutator broke/);
  assert.deepEqual(area.writes(), []);
  await assert.rejects(updateSettings(area, 'not a function'), (error) => error.code === 'INVALID_REQUEST');
  await assert.rejects(updateSettings(area), (error) => error.code === 'INVALID_REQUEST');
  const after = await updateSettings(area, (draft) => { draft.speechMuted = false; });
  assert.equal(after.speechMuted, false, 'the queue keeps going after failures');
  let fail = true;
  const flaky = { data: area.data, get: async (key) => { if (fail) { fail = false; throw new Error('storage down'); } return area.get(key); }, set: area.set, remove: area.remove };
  await assert.rejects(updateSettings(flaky, (draft) => { draft.uiLanguage = 'ja'; }), /storage down/);
  assert.equal((await updateSettings(flaky, (draft) => { draft.uiLanguage = 'ja'; })).uiLanguage, 'ja');
  // an area that is not an object still works (no queue), rejecting like any storage failure
  await assert.rejects(updateSettings(undefined, () => {}), TypeError);
});

test('readKey returns a string only for a valid v1 record; anything else is no key', async () => {
  assert.equal(await readKey(fakeArea()), null);
  assert.equal(await readKey(fakeArea({ [STORAGE_KEYS.key]: { v: 1, value: FAKE_KEY } })), FAKE_KEY);
  assert.equal(await readKey(fakeArea({ [STORAGE_KEYS.key]: { v: 1, value: 'x'.repeat(512) } })), 'x'.repeat(512));
  const corrupt = [{ v: 2, value: FAKE_KEY }, { v: '1', value: FAKE_KEY }, { value: FAKE_KEY }, { v: 1 }, { v: 1, value: 5 }, { v: 1, value: '' }, { v: 1, value: null },
    { v: 1, value: 'has space' }, { v: 1, value: `${FAKE_KEY}\n` }, { v: 1, value: 'x'.repeat(513) }, { v: 1, value: `café${'x'.repeat(24)}` },
    { v: 1, value: [FAKE_KEY] }, FAKE_KEY, 5, null, [], [{ v: 1, value: FAKE_KEY }], true];
  for (const record of corrupt) assert.equal(await readKey(fakeArea({ [STORAGE_KEYS.key]: record })), null, JSON.stringify(record));
  const area = fakeArea({ [STORAGE_KEYS.key]: { v: 1, value: FAKE_KEY } });
  await readKey(area);
  assert.deepEqual(area.log, [['get', 'interp.key.v1']], 'exactly the documented key is read');
});

test('writeKey trims, validates and stores {v:1,value}; a bad key throws INVALID_KEY without echoing it and writes nothing', async () => {
  const area = fakeArea();
  assert.equal(await writeKey(area, `  ${FAKE_KEY}\n`), undefined);
  assert.deepEqual(area.read(STORAGE_KEYS.key), { v: 1, value: FAKE_KEY });
  assert.deepEqual(area.writes(), [['set', ['interp.key.v1']]]);
  assert.equal(await readKey(area), FAKE_KEY);
  for (const bad of ['', '   ', 'has space inside', `${FAKE_KEY}\u0007`, 'x'.repeat(513), `café-${'x'.repeat(24)}`, undefined, null, 5, [FAKE_KEY], { key: FAKE_KEY }]) {
    const fresh = fakeArea();
    let caught;
    try { await writeKey(fresh, bad); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'INVALID_KEY', JSON.stringify(bad));
    assert.ok(caught instanceof Error);
    assert.equal(`${caught.message}${caught.code}${caught.stack}`.includes('synthetic'), false, 'the error never carries the value');
    assert.deepEqual(fresh.writes(), [], 'nothing is written');
  }
  const long = await writeKey(fakeArea(), 'x'.repeat(512));
  assert.equal(long, undefined);
  await assert.rejects(writeKey({ set: async () => { throw new Error('quota'); } }, FAKE_KEY), /quota/, 'a storage failure propagates');
});

test('deleteKey removes exactly the key record; hasKey answers a boolean and never the value', async () => {
  const area = fakeArea({ [STORAGE_KEYS.key]: { v: 1, value: FAKE_KEY }, [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  assert.equal(await hasKey(area), true);
  assert.equal(await hasKey(fakeArea()), false);
  assert.equal(await hasKey(fakeArea({ [STORAGE_KEYS.key]: { v: 1, value: '' } })), false, 'a corrupt record is no key');
  assert.equal(typeof (await hasKey(area)), 'boolean');
  assert.equal(await deleteKey(area), undefined);
  assert.deepEqual(area.log.filter(([kind]) => kind === 'remove'), [['remove', 'interp.key.v1']]);
  assert.equal(area.read(STORAGE_KEYS.key), undefined);
  assert.notEqual(area.read(STORAGE_KEYS.settings), undefined, 'settings are untouched');
  assert.equal(await hasKey(area), false);
  assert.equal(await readKey(area), null);
  assert.doesNotReject(deleteKey(area), 'deleting twice is fine');
});

test('the key and the settings never meet in storage or in any settings output', async () => {
  const area = fakeArea();
  await writeKey(area, FAKE_KEY);
  const settings = await writeSettings(area, { ...DEFAULT_SETTINGS, key: FAKE_KEY, lanes: { tab: { key: FAKE_KEY } } });
  await updateSettings(area, (draft) => { draft.uiLanguage = 'ko'; });
  assert.equal(JSON.stringify(area.read(STORAGE_KEYS.settings)).includes('synthetic'), false);
  for (const output of [settings, hostSettingsOf(settings), laneRequestOf(settings, 'tab'), await readSettings(area), normalizeSettings({ key: FAKE_KEY })]) {
    assert.equal(JSON.stringify(output).includes('synthetic'), false);
  }
  assert.deepEqual([...area.data.keys()].sort(), ['interp.key.v1', 'interp.settings.v1']);
});

test('resolveKey: a valid personal key wins, else only builtin[0] when it has the key shape, else null', () => {
  const personal = FAKE_KEY, builtin = Object.freeze([OTHER_KEY, 'second-key-that-is-never-used']);
  assert.equal(resolveKey({ personal, builtin }), personal);
  assert.equal(resolveKey({ personal: null, builtin }), OTHER_KEY);
  assert.equal(resolveKey({ builtin }), OTHER_KEY);
  for (const invalid of ['', 'has space', 5, {}, [personal], 'x'.repeat(513), ' ', `${personal}\n`, undefined]) {
    assert.equal(resolveKey({ personal: invalid, builtin }), OTHER_KEY, `invalid personal ${JSON.stringify(invalid)} falls through to the built-in key`);
    assert.equal(resolveKey({ personal: invalid, builtin: [] }), null);
  }
  assert.equal(resolveKey({ personal: null, builtin: ['bad key', OTHER_KEY] }), null, 'no rotation: only the first built-in key is ever used');
  for (const empty of [undefined, null, [], 'text', {}, 5]) assert.equal(resolveKey({ personal: null, builtin: empty }), null);
  assert.equal(resolveKey({ personal, builtin: undefined }), personal);
  assert.equal(resolveKey(), null);
  assert.equal(resolveKey({}), null);
  assert.equal(resolveKey({ personal: 'x'.repeat(512) }), 'x'.repeat(512));
});
