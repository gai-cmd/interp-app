import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAudioDevices, buildDeviceLists, systemDefaultEntry, deviceMessageKey,
  DEVICE_KINDS, DEVICE_STATUSES, REFRESH_REASONS, DEVICE_LABEL_MAX_CHARS } from '../app/audio/devices.js';
import { createPreferences, AUDIO_DEVICE_PREFERENCES, SYSTEM_DEFAULT_DEVICE_IDS, isSystemDefaultDeviceId,
  normalizePreference, storageKeyFor } from '../app/preferences.js';
import { createMicrophonePermission } from '../app/audio/permissions.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { navigator as permissionNavigator, deferred, settle, clock } from './fixtures/permissions.mjs';

// P3-25: labels only after permission, input/output lists with the system
// default first, devicechange/foreground/permission refreshes, duplicate and
// pseudo-ID removal, a lost stored ID reverting to the default, and storage
// failure. Device IDs are never assumed permanent.

const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async language =>
  [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));

const INPUT_KEY = storageKeyFor('audio.inputDeviceId');
const OUTPUT_KEY = storageKeyFor('audio.outputDeviceId');
const MARKER = 'SYNTHETIC ENUMERATE FAILURE';

/** localStorage double with per-method failure injection (same shape as tests/preferences.test.mjs). */
function fakeStorage(initial = {}, { failing = new Set() } = {}) {
  const map = new Map(Object.entries(initial));
  const fail = method => { if (failing.has(method)) throw new Error('QuotaExceededError'); };
  return {
    map,
    getItem(key) { fail('getItem'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { fail('setItem'); map.set(key, String(value)); },
    removeItem(key) { fail('removeItem'); map.delete(key); },
  };
}

/** MediaDeviceInfo-shaped record. */
const info = (kind, deviceId, label = '', groupId = 'group') => ({ kind, deviceId, label, groupId, toJSON: () => ({ kind, deviceId, label, groupId }) });
const mic = (id, label = '') => info('audioinput', id, label);
const speaker = (id, label = '') => info('audiooutput', id, label);

/**
 * navigator.mediaDevices double. `devices` is the value enumerateDevices()
 * resolves: an array, a Promise, an Error (rejects) or a function(index)
 * returning any of those. change() fires `devicechange`; pass { legacy: true }
 * for an object that only supports ondevicechange.
 */
function mediaDevices(devices = [], { legacy = false, missing = false } = {}) {
  const target = new EventTarget();
  const calls = [];
  const md = {
    calls, listeners: 0, current: devices, ondevicechange: null,
    set(next) { md.current = next; },
    change() {
      const event = new Event('devicechange');
      if (!legacy) target.dispatchEvent(event);
      md.ondevicechange?.(event);
    },
  };
  if (!missing) {
    md.enumerateDevices = function enumerateDevices() {
      assert.equal(this, md, 'called on mediaDevices');
      const index = calls.length;
      calls.push(index);
      let produced;
      try { produced = typeof md.current === 'function' ? md.current(index) : md.current; }
      catch (error) { return Promise.reject(error); }
      return Promise.resolve(produced).then(value => (value instanceof Error ? Promise.reject(value) : value));
    };
  }
  if (!legacy) {
    md.addEventListener = (type, fn) => { md.listeners += 1; target.addEventListener(type, fn); };
    md.removeEventListener = (type, fn) => { md.listeners -= 1; target.removeEventListener(type, fn); };
  }
  return md;
}

/** document double for visibilitychange. */
function fakeDocument(visibilityState = 'visible') {
  const target = new EventTarget();
  const doc = {
    visibilityState, listeners: 0,
    addEventListener(type, fn) { doc.listeners += 1; target.addEventListener(type, fn); },
    removeEventListener(type, fn) { doc.listeners -= 1; target.removeEventListener(type, fn); },
    show() { doc.visibilityState = 'visible'; target.dispatchEvent(new Event('visibilitychange')); },
    hide() { doc.visibilityState = 'hidden'; target.dispatchEvent(new Event('visibilitychange')); },
  };
  return doc;
}

function setup({ devices = [], stored = {}, failing, permissions = null, legacy = false, missing = false, document = null } = {}) {
  const md = mediaDevices(devices, { legacy, missing });
  const env = permissionNavigator({ permissions: permissions ?? 'unsupported' });
  env.navigator.mediaDevices = md;
  const storage = fakeStorage(stored, failing ? { failing } : {});
  const time = clock();
  const preferences = createPreferences({ storage, now: time.now });
  const permission = permissions ? createMicrophonePermission({ navigator: env.navigator, now: time.now }) : null;
  const events = [];
  const service = createAudioDevices({ navigator: env.navigator, preferences, permission, document, now: time.now });
  service.subscribe(snapshot => events.push(snapshot));
  return { service, md, env, storage, preferences, permission, events, time };
}

const ids = entries => entries.map(entry => entry.deviceId);

test('import and construction touch enumerateDevices never; the list starts with the system default per kind', () => {
  const { service, md, events } = setup({ devices: [mic('m1', 'USB mic')] });
  const snapshot = service.snapshot();
  assert.equal(md.calls.length, 0);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.supported, null);
  assert.equal(snapshot.labelsAvailable, false);
  assert.equal(snapshot.incomplete, true, 'nothing enumerated yet is not a complete list');
  assert.deepEqual(snapshot.devices.audioinput, [systemDefaultEntry('audioinput')]);
  assert.deepEqual(snapshot.devices.audiooutput, [systemDefaultEntry('audiooutput')]);
  assert.deepEqual(service.list('audioinput'), [systemDefaultEntry('audioinput')]);
  assert.deepEqual(service.list(), [systemDefaultEntry('audioinput'), systemDefaultEntry('audiooutput')]);
  assert.deepEqual(snapshot.selected, { audioinput: { deviceId: null, present: true }, audiooutput: { deviceId: null, present: true } });
  assert.deepEqual(snapshot.recovered, []);
  assert.equal(snapshot.messageKey, null);
  assert.equal(snapshot.persisted, true);
  assert.equal(snapshot.refreshedAt, null);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.devices) && Object.isFrozen(snapshot.devices.audioinput)
    && Object.isFrozen(snapshot.selected) && Object.isFrozen(service));
  assert.equal(events.length, 0, 'construction notifies nobody');
  assert.equal(md.listeners, 1, 'devicechange is watched from construction');
  assert.deepEqual([...DEVICE_KINDS], ['audioinput', 'audiooutput']);
  assert.deepEqual([...DEVICE_STATUSES], ['idle', 'refreshing', 'ready', 'unsupported', 'failed']);
  assert.deepEqual([...REFRESH_REASONS], ['manual', 'devicechange', 'foreground', 'permission']);
  assert.deepEqual(AUDIO_DEVICE_PREFERENCES, { audioinput: 'audio.inputDeviceId', audiooutput: 'audio.outputDeviceId' });
  assert.deepEqual([...SYSTEM_DEFAULT_DEVICE_IDS], ['', 'default', 'communications']);
  assert.equal(systemDefaultEntry('audiooutput').deviceId, '');
  assert.equal(systemDefaultEntry('audiooutput').labelKey, 'device.systemDefault');
  assert.equal(deviceMessageKey('audioinput'), 'device.inputAppliesNextStart');
  assert.equal(deviceMessageKey('audiooutput'), 'device.outputPcmOnly');
  assert.equal(deviceMessageKey('videoinput'), null);
  assert.throws(() => systemDefaultEntry('videoinput'), /INVALID_REQUEST/);
  assert.throws(() => service.list('videoinput'), /INVALID_REQUEST/);
  assert.throws(() => service.select('videoinput', 'cam'), /INVALID_REQUEST/);
  assert.throws(() => service.subscribe('nope'), /INVALID_REQUEST/);
  assert.throws(() => createAudioDevices({ navigator: {}, preferences: null }), /INVALID_REQUEST/);
  assert.throws(() => createAudioDevices({ navigator: {}, preferences: { get() {} } }), /INVALID_REQUEST/);
  assert.throws(() => createAudioDevices({ navigator: {}, preferences: createPreferences(), now: 'later' }), /INVALID_REQUEST/);
});

test('every dictionary key the service emits exists in all three languages', () => {
  const keys = ['device.systemDefault', 'device.unlabeled', 'device.disappeared', 'device.inputAppliesNextStart',
    'device.outputPcmOnly', 'error.INVALID_REQUEST'];
  for (const language of SUPPORTED_LANGUAGES) for (const key of keys) assert.ok(Object.hasOwn(dictionaries[language], key), `${language}: ${key}`);
});

test('preferences: pseudo IDs for the system default are never stored, other IDs are kept as before', () => {
  for (const value of SYSTEM_DEFAULT_DEVICE_IDS) {
    assert.equal(isSystemDefaultDeviceId(value), true, value);
    assert.equal(normalizePreference('audio.inputDeviceId', value), null, value);
    assert.equal(normalizePreference('audio.outputDeviceId', value), null, value);
  }
  assert.equal(isSystemDefaultDeviceId(null), true);
  assert.equal(isSystemDefaultDeviceId(undefined), true);
  assert.equal(isSystemDefaultDeviceId('Default'), false);
  assert.equal(isSystemDefaultDeviceId(0), false);
  assert.equal(normalizePreference('audio.inputDeviceId', 'Default'), 'Default');
  assert.equal(normalizePreference('audio.inputDeviceId', 'a'.repeat(64)), 'a'.repeat(64));
  const store = createPreferences({ storage: fakeStorage() });
  assert.deepEqual(store.set('audio.inputDeviceId', 'default'), { ok: false, persisted: true });
  assert.deepEqual(store.set('audio.outputDeviceId', 'communications'), { ok: false, persisted: true });
});

test('buildDeviceLists: before permission nothing is guessed, pseudo IDs and duplicates collapse, video is ignored', () => {
  const raw = [
    mic('', ''), speaker('', ''),
    mic('default', 'Default - Headset'), mic('communications', 'Communications - Headset'),
    mic('m1', ''), mic('m1', ''), mic('m2', ''),
    speaker('s1', ''), speaker('default', ''),
    info('videoinput', 'cam1', 'Camera'),
    null, undefined, 42, { kind: 'audioinput' }, { kind: 'audioinput', deviceId: 7 },
    mic('x'.repeat(257), 'too long an ID'), mic('bad\u0000id', 'control char'),
  ];
  // The labelled pseudo entries are evidence of permission for inputs, so the unlabeled real inputs are
  // listed (with the unlabeled key, never a guessed name); outputs carry no label at all and stay hidden.
  const mixed = buildDeviceLists(raw);
  assert.deepEqual(ids(mixed.audioinput.entries), ['', 'm1', 'm2']);
  assert.equal(mixed.audioinput.authoritative, true);
  assert.equal(mixed.audioinput.labelled, true);
  assert.equal(mixed.audioinput.hidden, 0);
  assert.deepEqual(mixed.audioinput.entries.slice(1).map(e => e.labelKey), ['device.unlabeled', 'device.unlabeled']);
  assert.deepEqual(ids(mixed.audiooutput.entries), ['']);
  assert.equal(mixed.audiooutput.authoritative, false);
  assert.equal(mixed.audiooutput.hidden, 1);
  // Every audio label removed (a labelled entry of any ID, pseudo or unstorable, is evidence of permission).
  const withoutPseudoLabels = raw.map(item => (item && typeof item === 'object' && item.kind !== 'videoinput' ? { ...item, label: '' } : item));
  const before = buildDeviceLists(withoutPseudoLabels);
  assert.deepEqual(ids(before.audioinput.entries), ['']);
  assert.equal(before.audioinput.hidden, 2);
  assert.equal(before.audioinput.incomplete, true);
  assert.equal(before.audioinput.authoritative, false);
  assert.equal(before.audiooutput.hidden, 1);
  // Permission granted: the same raw list is authoritative and unlabeled devices are listed without a guessed name.
  const granted = buildDeviceLists(withoutPseudoLabels, { granted: true });
  assert.deepEqual(ids(granted.audioinput.entries), ['', 'm1', 'm2']);
  assert.deepEqual(ids(granted.audiooutput.entries), ['', 's1']);
  assert.equal(granted.audioinput.hidden, 0);
  assert.equal(granted.audioinput.incomplete, false);
  assert.equal(granted.audioinput.authoritative, true);
  assert.equal(granted.audioinput.labelled, false);
  assert.deepEqual(granted.audioinput.entries[1], { kind: 'audioinput', deviceId: 'm1', label: '', labelKey: 'device.unlabeled', isDefault: false });
  assert.ok(granted.audioinput.entries.every(Object.isFrozen));
  // Labels present: listed with the label and no key; iterables and garbage are tolerated.
  const labelled = buildDeviceLists(new Set([mic('m1', '  USB\u0007 mic  '), mic('m2', 'L'.repeat(300)), speaker('s1', 'Speakers')]));
  assert.deepEqual(labelled.audioinput.entries[1], { kind: 'audioinput', deviceId: 'm1', label: 'USB mic', labelKey: null, isDefault: false });
  assert.equal(labelled.audioinput.entries[2].label.length, DEVICE_LABEL_MAX_CHARS);
  assert.equal(labelled.audioinput.authoritative, true);
  assert.equal(labelled.audiooutput.entries[1].label, 'Speakers');
  for (const garbage of [null, undefined, 'devices', 42, {}, { length: 'x' }]) {
    assert.deepEqual(ids(buildDeviceLists(garbage).audioinput.entries), [''], String(garbage));
  }
});

test('labels appear only after permission: a grant reported by the permission service refreshes the list', async () => {
  const devices = [mic('m1', ''), mic('m2', ''), speaker('s1', '')];
  const { service, md, env, permission, events, time } = setup({ devices, permissions: 'prompt' });
  await permission.query();
  assert.equal(md.calls.length, 0, 'a permission query never enumerates');
  const before = await service.refresh();
  assert.equal(before.status, 'ready');
  assert.equal(before.supported, true);
  assert.equal(before.labelsAvailable, false);
  assert.equal(before.incomplete, true);
  assert.deepEqual(ids(before.devices.audioinput), [''], 'no guessed labels before permission');
  assert.equal(before.refreshedAt, time.now());
  assert.deepEqual(events.map(e => e.status), ['refreshing', 'ready']);
  // The browser grants; devices now carry labels.
  md.set([mic('m1', 'Built-in'), mic('m2', 'USB mic'), speaker('s1', 'Speakers')]);
  time.advance(500);
  env.last().set('granted');
  await settle();
  assert.equal(md.calls.length, 2, 'granted refreshes once');
  const after = service.snapshot();
  assert.equal(after.labelsAvailable, true);
  assert.equal(after.incomplete, false);
  assert.deepEqual(after.devices.audioinput.map(e => [e.deviceId, e.label, e.labelKey]),
    [['', '', 'device.systemDefault'], ['m1', 'Built-in', null], ['m2', 'USB mic', null]]);
  assert.deepEqual(ids(after.devices.audiooutput), ['', 's1']);
  assert.equal(after.refreshedAt, time.now());
  // Repeated granted notifications (other fields changing) do not enumerate again.
  env.last().set('granted');
  await settle();
  assert.equal(md.calls.length, 2);
  // Denied later: no refresh, list kept as last seen.
  env.last().set('denied');
  await settle();
  assert.equal(md.calls.length, 2);
  assert.deepEqual(ids(service.snapshot().devices.audioinput), ['', 'm1', 'm2']);
});

test('devicechange refreshes; an unplugged selected device reverts the stored choice to the system default', async () => {
  const { service, md, storage, preferences, events } = setup({
    devices: [mic('m1', 'Built-in'), mic('m2', 'USB mic'), speaker('s1', 'Speakers'), speaker('s2', 'Headset')],
    stored: { [INPUT_KEY]: 'm2', [OUTPUT_KEY]: 's2' },
  });
  const first = await service.refresh();
  assert.deepEqual(first.selected, { audioinput: { deviceId: 'm2', present: true }, audiooutput: { deviceId: 's2', present: true } });
  assert.deepEqual(first.recovered, []);
  // The headset goes away: both its microphone and its speaker.
  md.set([mic('m1', 'Built-in'), speaker('s1', 'Speakers')]);
  md.change();
  await settle();
  assert.equal(md.calls.length, 2);
  const after = service.snapshot();
  assert.deepEqual(after.recovered, ['audioinput', 'audiooutput']);
  assert.equal(after.messageKey, 'device.disappeared');
  assert.deepEqual(after.selected, { audioinput: { deviceId: null, present: true }, audiooutput: { deviceId: null, present: true } });
  assert.equal(storage.map.has(INPUT_KEY), false, 'the lost ID is removed from storage');
  assert.equal(storage.map.has(OUTPUT_KEY), false);
  assert.equal(preferences.get('audio.inputDeviceId'), null);
  assert.equal(events.filter(e => e.status === 'ready' && e.messageKey === 'device.disappeared').length, 1, 'one result carries the reversion');
  // The next refresh with nothing lost clears the notice.
  await service.refresh();
  assert.deepEqual(service.snapshot().recovered, []);
  assert.equal(service.snapshot().messageKey, null);
  // Plugging the headset back in does not restore the old choice: IDs are not permanent, the user chooses again.
  md.set([mic('m1', 'Built-in'), mic('m2', 'USB mic'), speaker('s1', 'Speakers'), speaker('s2', 'Headset')]);
  md.change();
  await settle();
  assert.equal(service.snapshot().selected.audioinput.deviceId, null);
  assert.deepEqual(ids(service.snapshot().devices.audioinput), ['', 'm1', 'm2']);
});

test('a stored ID is kept, and reported as not present, while the list is hidden or empty for its kind', async () => {
  // Before permission the browser hides IDs and labels: the stored ID cannot be judged.
  const hidden = setup({ devices: [mic('', ''), speaker('', '')], stored: { [INPUT_KEY]: 'm2', [OUTPUT_KEY]: 's2' } });
  const before = await hidden.service.refresh();
  assert.deepEqual(before.selected, { audioinput: { deviceId: 'm2', present: false }, audiooutput: { deviceId: 's2', present: false } });
  assert.deepEqual(before.recovered, []);
  assert.equal(hidden.storage.map.get(INPUT_KEY), 'm2');
  assert.equal(hidden.storage.map.get(OUTPUT_KEY), 's2');
  // Unlabeled but hashed IDs (older Chromium before permission): still not authoritative.
  hidden.md.set([mic('m1', ''), mic('m3', ''), speaker('s1', '')]);
  await hidden.service.refresh();
  assert.equal(hidden.storage.map.get(INPUT_KEY), 'm2');
  assert.equal(hidden.service.snapshot().selected.audioinput.present, false);
  // Microphone granted but outputs hidden behind their own permission (Firefox): the output choice survives.
  const partial = setup({ devices: [mic('m1', 'Built-in')], stored: { [INPUT_KEY]: 'm1', [OUTPUT_KEY]: 's2' }, permissions: 'granted' });
  await partial.permission.query();
  await settle();
  const snapshot = partial.service.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.selected, { audioinput: { deviceId: 'm1', present: true }, audiooutput: { deviceId: 's2', present: false } });
  assert.deepEqual(snapshot.recovered, []);
  assert.equal(partial.storage.map.get(OUTPUT_KEY), 's2');
  // Granted and the kind is listed without the stored ID: that is a real loss.
  partial.md.set([mic('m1', 'Built-in'), speaker('s1', 'Speakers')]);
  await partial.service.refresh();
  assert.deepEqual(partial.service.snapshot().recovered, ['audiooutput']);
  assert.equal(partial.storage.map.has(OUTPUT_KEY), false);
  // A stored ID that the list does show before permission (labels visible without the service) is present.
  const visible = setup({ devices: [mic('m1', 'Built-in'), mic('m2', 'USB')], stored: { [INPUT_KEY]: 'm2' } });
  await visible.service.refresh();
  assert.deepEqual(visible.service.snapshot().selected.audioinput, { deviceId: 'm2', present: true });
});

test('select stores the choice, clears it for the default or a pseudo ID, and reports the follow-up message', async () => {
  const { service, storage, preferences, events } = setup({ devices: [mic('m1', 'Built-in'), speaker('s1', 'Speakers')] });
  await service.refresh();
  const seen = events.length;
  assert.deepEqual(service.select('audioinput', 'm1'),
    { ok: true, persisted: true, kind: 'audioinput', deviceId: 'm1', messageKey: 'device.inputAppliesNextStart' });
  assert.equal(storage.map.get(INPUT_KEY), 'm1');
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: 'm1', present: true });
  assert.equal(events.length, seen + 1, 'one notification per change');
  assert.deepEqual(service.select('audiooutput', 's1'),
    { ok: true, persisted: true, kind: 'audiooutput', deviceId: 's1', messageKey: 'device.outputPcmOnly' });
  // Selecting the same device again changes nothing and notifies nobody.
  const again = events.length;
  service.select('audiooutput', 's1');
  assert.equal(events.length, again);
  // A device the list does not show is stored (the list may be incomplete) and reported as not present.
  assert.equal(service.select('audioinput', 'm9').ok, true);
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: 'm9', present: false });
  for (const value of ['', 'default', 'communications', null, undefined]) {
    service.select('audioinput', 'm1');
    assert.deepEqual(service.select('audioinput', value),
      { ok: true, persisted: true, kind: 'audioinput', deviceId: null, messageKey: 'device.inputAppliesNextStart' }, String(value));
    assert.equal(storage.map.has(INPUT_KEY), false, String(value));
    assert.equal(preferences.get('audio.inputDeviceId'), null);
  }
  for (const value of [42, {}, ['m1'], 'x'.repeat(257), 'a\u0000b']) {
    const result = service.select('audiooutput', value);
    assert.deepEqual(result, { ok: false, persisted: true, kind: 'audiooutput', deviceId: null, code: 'INVALID_REQUEST',
      messageKey: 'error.INVALID_REQUEST' }, String(value));
    assert.equal(storage.map.get(OUTPUT_KEY), 's1', 'a rejected value leaves the stored choice alone');
  }
  assert.ok(Object.isFrozen(service.select('audioinput', 'm1')));
});

test('storage failure: the choice stays effective for this run, persisted reports false, and a lost ID is still reverted', async () => {
  const failing = new Set(['setItem']);
  const { service, storage, preferences, md } = setup({ devices: [mic('m1', 'Built-in'), mic('m2', 'USB')], failing });
  await service.refresh();
  assert.deepEqual(service.select('audioinput', 'm2'),
    { ok: true, persisted: false, kind: 'audioinput', deviceId: 'm2', messageKey: 'device.inputAppliesNextStart' });
  assert.equal(storage.map.has(INPUT_KEY), false);
  assert.equal(service.snapshot().persisted, false);
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: 'm2', present: true }, 'memory copy is the choice');
  assert.equal(preferences.get('audio.inputDeviceId'), 'm2');
  // Writes recover: the next select persists.
  failing.delete('setItem');
  assert.equal(service.select('audioinput', 'm1').persisted, true);
  assert.equal(storage.map.get(INPUT_KEY), 'm1');
  assert.equal(service.snapshot().persisted, true);
  // Removal fails while the selected device disappears: the loss is reported and persisted turns false, but the
  // stale ID stays readable in storage (P3-05 semantics), so the selection honestly shows it as not present.
  failing.add('removeItem');
  md.set([mic('m2', 'USB')]);
  md.change();
  await settle();
  assert.deepEqual(service.snapshot().recovered, ['audioinput']);
  assert.equal(service.snapshot().messageKey, 'device.disappeared');
  assert.equal(service.snapshot().persisted, false);
  assert.equal(storage.map.get(INPUT_KEY), 'm1', 'the stale key could not be removed');
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: 'm1', present: false });
  // Once removal works again the next refresh finishes the reversion.
  failing.delete('removeItem');
  await service.refresh();
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: null, present: true });
  assert.equal(storage.map.has(INPUT_KEY), false);
  // Unreadable storage reads as no choice and never throws out of the service.
  service.select('audioinput', 'm2');
  failing.add('getItem');
  await service.refresh();
  assert.equal(service.snapshot().status, 'ready');
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: null, present: true });
  assert.equal(service.snapshot().persisted, false);
  // A preference store that throws on every call is contained too.
  const broken = createAudioDevices({ navigator: { mediaDevices: mediaDevices([mic('m1', 'Built-in')]) },
    preferences: { get() { throw new Error('broken'); }, set() { throw new Error('broken'); }, remove() { throw new Error('broken'); } } });
  await broken.refresh();
  assert.equal(broken.snapshot().status, 'ready');
  assert.equal(broken.snapshot().persisted, false);
  assert.equal(broken.select('audioinput', 'm1').ok, false);
});

test('missing enumerateDevices is unsupported; a throwing or rejecting one is failed and keeps the last list and choices', async () => {
  const none = setup({ missing: true, stored: { [INPUT_KEY]: 'm2' } });
  const unsupported = await none.service.refresh();
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.incomplete, true);
  assert.deepEqual(ids(unsupported.devices.audioinput), ['']);
  assert.deepEqual(unsupported.selected.audioinput, { deviceId: 'm2', present: false });
  assert.equal(none.storage.map.get(INPUT_KEY), 'm2', 'never reverted on an unknown list');
  const bare = createAudioDevices({ preferences: createPreferences() });
  assert.equal((await bare.refresh()).status, 'unsupported');

  const { service, md, storage, events } = setup({ devices: [mic('m1', 'Built-in'), mic('m2', 'USB')], stored: { [INPUT_KEY]: 'm2' } });
  await service.refresh();
  assert.deepEqual(ids(service.snapshot().devices.audioinput), ['', 'm1', 'm2']);
  md.set(new Error(MARKER));
  const rejected = await service.refresh();
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.supported, true);
  assert.equal(rejected.incomplete, true);
  assert.deepEqual(ids(rejected.devices.audioinput), ['', 'm1', 'm2'], 'previous entries kept');
  assert.deepEqual(rejected.selected.audioinput, { deviceId: 'm2', present: true });
  assert.deepEqual(rejected.recovered, []);
  assert.equal(storage.map.get(INPUT_KEY), 'm2');
  md.set(() => { throw new Error(MARKER); });
  assert.equal((await service.refresh()).status, 'failed');
  md.set('garbage');
  const garbage = await service.refresh();
  assert.equal(garbage.status, 'ready');
  assert.deepEqual(ids(garbage.devices.audioinput), [''], 'an unusable result is an empty list');
  assert.equal(storage.map.get(INPUT_KEY), 'm2', 'an empty list never reverts');
  assert.equal(JSON.stringify(events).includes(MARKER), false, 'no browser error text leaks');
  assert.equal(JSON.stringify(service.snapshot()).includes(MARKER), false);
});

test('concurrent refreshes share one enumeration; a devicechange during it schedules exactly one more', async () => {
  const gate = deferred();
  const later = deferred();
  const { service, md } = setup({ devices: index => (index === 0 ? gate.promise : later.promise) });
  const a = service.refresh();
  const b = service.refresh({ reason: 'foreground' });
  assert.equal(a, b);
  await settle();
  assert.equal(md.calls.length, 1);
  assert.equal(service.snapshot().status, 'refreshing');
  md.change();
  md.change();
  await settle();
  assert.equal(md.calls.length, 1, 'changes during an enumeration wait for it');
  gate.resolve([mic('m1', 'Built-in')]);
  assert.equal((await a).status, 'ready');
  await settle();
  assert.equal(md.calls.length, 2, 'exactly one follow-up enumeration');
  later.resolve([mic('m1', 'Built-in'), mic('m2', 'USB')]);
  await settle();
  assert.deepEqual(ids(service.snapshot().devices.audioinput), ['', 'm1', 'm2']);
  assert.equal(md.calls.length, 2);
  await assert.rejects(service.refresh({ reason: 'poll' }), /INVALID_REQUEST/);
  assert.equal(md.calls.length, 2);
});

test('foreground return refreshes only a list that was requested before; hidden never refreshes', async () => {
  const document = fakeDocument('hidden');
  const { service, md } = setup({ devices: [mic('m1', 'Built-in')], document });
  assert.equal(document.listeners, 1);
  document.show();
  await settle();
  assert.equal(md.calls.length, 0, 'nobody asked for the list yet');
  await service.refresh();
  document.hide();
  await settle();
  assert.equal(md.calls.length, 1);
  md.set([mic('m1', 'Built-in'), mic('m2', 'USB')]);
  document.show();
  await settle();
  assert.equal(md.calls.length, 2);
  assert.deepEqual(ids(service.snapshot().devices.audioinput), ['', 'm1', 'm2']);
  service.destroy();
  assert.equal(document.listeners, 0);
});

test('legacy ondevicechange-only mediaDevices is watched and released', async () => {
  const { service, md } = setup({ devices: [mic('m1', 'Built-in')], legacy: true });
  assert.equal(typeof md.ondevicechange, 'function');
  md.change();
  await settle();
  assert.equal(md.calls.length, 1);
  service.destroy();
  assert.equal(md.ondevicechange, null);
  md.change();
  await settle();
  assert.equal(md.calls.length, 1);
});

test('another tab changing the stored choice updates the selection through the preference store', async () => {
  const { service, storage, preferences, events } = setup({ devices: [mic('m1', 'Built-in'), mic('m2', 'USB')] });
  await service.refresh();
  const seen = events.length;
  storage.map.set(INPUT_KEY, 'm2');
  preferences.sync(INPUT_KEY);
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: 'm2', present: true });
  assert.equal(events.length, seen + 1);
  storage.map.delete(INPUT_KEY);
  preferences.sync(null);
  assert.deepEqual(service.snapshot().selected.audioinput, { deviceId: null, present: true });
  // Unrelated names do not notify.
  const before = events.length;
  preferences.set('ui.mode', 'dark');
  assert.equal(events.length, before);
});

test('subscribers get frozen snapshots on change only, can unsubscribe, and a throwing listener is contained', async () => {
  const { service, md } = setup({ devices: [mic('m1', 'Built-in')] });
  const seen = [];
  const off = service.subscribe(snapshot => { seen.push(snapshot); throw new Error('listener'); });
  await service.refresh();
  assert.deepEqual(seen.map(s => s.status), ['refreshing', 'ready']);
  assert.ok(seen.every(Object.isFrozen));
  off();
  md.change();
  await settle();
  assert.equal(seen.length, 2);
  assert.equal(md.calls.length, 2);
});

test('destroy detaches from the browser, the permission service and the store, drops a late result and stays quiet', async () => {
  const gate = deferred();
  const { service, md, env, permission, preferences, events } = setup({ devices: () => gate.promise, permissions: 'prompt' });
  await permission.query();
  const status = env.last();
  const promise = service.refresh();
  await settle();
  assert.equal(service.snapshot().status, 'refreshing');
  service.destroy();
  assert.equal(md.listeners, 0);
  const seen = events.length;
  gate.resolve([mic('m1', 'Built-in')]);
  const result = await promise;
  assert.equal(result.status, 'idle', 'a late result never lands');
  assert.deepEqual(ids(service.snapshot().devices.audioinput), ['']);
  status.set('granted');
  md.change();
  preferences.set('audio.inputDeviceId', 'm1');
  await settle();
  assert.equal(md.calls.length, 1);
  assert.equal(events.length, seen, 'no notifications after destroy');
  assert.equal(await service.refresh(), service.snapshot());
  assert.equal(typeof service.subscribe(() => {}), 'function');
  service.destroy();
});

test('a broken clock leaves refreshedAt null; the module reads no browser globals and never logs', async () => {
  const md = mediaDevices([mic('m1', 'Built-in')]);
  const service = createAudioDevices({ navigator: { mediaDevices: md }, preferences: createPreferences(), now: () => { throw new Error('clock'); } });
  const snapshot = await service.refresh();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.refreshedAt, null);
  // navigator and document are injected parameters; the module reaches for no global of its own.
  const source = await readFile(new URL('../app/audio/devices.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:window|globalThis|self|localStorage|sessionStorage)\b/, 'no browser globals');
  assert.match(source, /createAudioDevices\(\{ navigator, preferences, permission = null, document = null/);
  assert.doesNotMatch(source, /console\./, 'no logging');
  assert.doesNotMatch(source, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, 'no raw control bytes in source');
});
