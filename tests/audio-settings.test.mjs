// P3-24: the microphone permission section (design-p3 §1.14) and the stream
// handover. The point of the suite is what must NOT happen: no request without
// a gesture, none at all from the header or hub listening, no second prompt
// when a start follows, no retry loop after a denial, and no API check on a key
// save (the P1 contract this task is warned not to break).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAudioSettings, PERMISSION_HELP_KEYS } from '../app/ui/audio-settings.js';
import { createMicrophonePermission } from '../app/audio/permissions.js';
import { createPlatform } from '../app/platform.js';
import { createI18n } from '../app/i18n/index.js';
import { FakeElement, all, boot, byClass, secrets, tick, until } from './fixtures/scenarios.mjs';

const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async (lang) =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));
const ko = dictionaries.ko;

function track(readyState = 'live') {
  return { readyState, stop() { this.readyState = 'ended'; }, addEventListener() {}, removeEventListener() {} };
}
const streamOf = (...tracks) => ({ getAudioTracks: () => tracks, getTracks: () => tracks });

function navigatorDouble({ state = 'prompt', supported = true, media = null } = {}) {
  const requests = [];
  const listeners = new Set();
  const status = { state, addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) };
  return {
    requests, status,
    set(next) { status.state = next; for (const fn of [...listeners]) fn({ target: status }); },
    ...(supported ? { permissions: { query: async () => status } } : {}),
    mediaDevices: { getUserMedia: async (constraints) => {
      requests.push(constraints);
      if (media instanceof Error) throw media;
      return media ?? streamOf(track());
    } },
  };
}
function fixture(options = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeElement(doc, tag) };
  const nav = navigatorDouble(options);
  const permission = createMicrophonePermission({ navigator: nav, now: () => 1 });
  const i18n = createI18n({ dictionaries, language: 'ko' });
  const view = createAudioSettings({ permission, i18n, document: doc });
  return { doc, nav, permission, i18n, view, el: (name) => byClass(view.element, name) };
}

test('mounting asks for nothing: the request begins only when someone presses the button', async () => {
  const f = fixture();
  assert.deepEqual(f.nav.requests, [], 'no request on mount');
  await f.permission.query();
  f.view.render();
  assert.deepEqual(f.nav.requests, [], 'querying the status is not requesting the microphone');
  assert.equal(f.el('audio-permission-status').textContent, ko['permission.prompt']);
  assert.equal(f.el('audio-permission-status').getAttribute('data-permission'), 'prompt');

  f.el('audio-permission-request').dispatch('click');
  await tick(); await tick();
  assert.equal(f.nav.requests.length, 1, 'the gesture is what asks');
  f.view.destroy();
});

test('a settings request is a probe: permission is kept, every temporary track is stopped', async () => {
  const live = track();
  const f = fixture({ media: streamOf(live) });
  f.el('audio-permission-request').dispatch('click');
  await tick(); await tick(); await tick();
  assert.equal(live.readyState, 'ended', 'no recording indicator is left burning after a save');
  assert.equal(f.permission.snapshot().status, 'granted');
  assert.equal(f.el('audio-permission-status').textContent, ko['permission.granted']);
  f.view.destroy();
});

test('a denial explains the platform routes and never becomes a retry loop', async () => {
  const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' });
  const f = fixture({ media: denied });
  assert.equal(f.el('audio-permission-help').hidden, true, 'help nobody needs is not shown');

  f.el('audio-permission-request').dispatch('click');
  await tick(); await tick(); await tick();
  assert.equal(f.permission.snapshot().status, 'denied');
  assert.equal(f.el('audio-permission-status').textContent, ko['permission.denied']);
  assert.equal(f.el('audio-permission-help').hidden, false);
  const help = all(f.el('audio-permission-help'), (node) => node.classes.has('settings-note')).map((node) => node.textContent);
  for (const key of PERMISSION_HELP_KEYS) assert.ok(help.includes(ko[key]), key);
  // The app never presses the button again on anyone's behalf.
  const asked = f.nav.requests.length;
  f.view.render();
  await tick(); await tick();
  assert.equal(f.nav.requests.length, asked, 'a denial is not retried automatically');
  assert.ok(all(f.view.element, (node) => node.textContent === ko['permission.noAutoRetry']).length > 0);
  f.view.destroy();
});

test('a device in use is not a denial', async () => {
  const busy = Object.assign(new Error('busy'), { name: 'NotReadableError' });
  const f = fixture({ media: busy });
  f.el('audio-permission-request').dispatch('click');
  await tick(); await tick(); await tick();
  assert.equal(f.el('audio-permission-status').textContent, ko['permission.busy']);
  assert.notEqual(f.el('audio-permission-status').textContent, ko['permission.denied']);
  assert.equal(f.el('audio-permission-hint').textContent, ko['permission.busyHint']);
  assert.equal(f.el('audio-permission-help').hidden, true, 'NotReadableError shows no denial help');
  f.view.destroy();
});

test('a browser without the Permissions API is not reported as denied', async () => {
  const f = fixture({ supported: false });
  await f.permission.query();
  f.view.render();
  assert.equal(f.el('audio-permission-status').textContent, ko['permission.unsupported']);
  assert.equal(f.el('audio-permission-hint').textContent, ko['permission.unsupportedHint']);
  assert.equal(f.el('audio-permission-help').hidden, true);
  f.view.destroy();
});

test('the platform hands one acquired stream to the next getUserMedia, and only once', async () => {
  const asked = [];
  const browserStream = streamOf(track());
  const platform = createPlatform({ isSecureContext: true, navigator: {
    mediaDevices: { getUserMedia: async (c) => { asked.push(c); return browserStream; } } } });

  const handed = streamOf(track());
  platform.provideStream(handed);
  assert.equal(await platform.getUserMedia({ audio: true }), handed, 'the offered stream satisfies the request');
  assert.deepEqual(asked, [], 'the browser was not asked a second time');
  // Single use: the next call goes to the browser.
  assert.equal(await platform.getUserMedia({ audio: true }), browserStream);
  assert.equal(asked.length, 1);

  // A promise is accepted, because the offer is made before it settles.
  platform.provideStream(Promise.resolve(handed));
  assert.equal(await platform.getUserMedia({ audio: true }), handed);
  // A refused or ended offer falls through instead of failing the capture.
  platform.provideStream(Promise.resolve(null));
  assert.equal(await platform.getUserMedia({ audio: true }), browserStream);
  platform.provideStream(Promise.reject(new Error('denied')));
  assert.equal(await platform.getUserMedia({ audio: true }), browserStream);
  platform.provideStream(streamOf(track('ended')));
  assert.equal(await platform.getUserMedia({ audio: true }), browserStream);
  assert.equal(asked.length, 4);
});

// --- the running app ---

test('the header buttons and hub listening reach zero microphone requests', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  const before = b.microphone.streams.length;
  // Language, display and share are not interpretation.
  for (const name of ['shell-language', 'shell-display-button', 'share-button']) {
    const node = byClass(b.root, name);
    node?.dispatch('click');
    await tick();
  }
  b.app.shell.closeShare();
  b.app.shell.closeDisplay();
  assert.equal(b.microphone.streams.length, before, 'the header never asks for the microphone');

  // Hub listening receives a finished broadcast: no microphone at all.
  b.app.shell.selectTab('simultaneous');
  await tick();
  const modeSelect = byClass(b.root, 'sim-mode');
  if (modeSelect) { modeSelect.value = 'hub'; modeSelect.dispatch('change'); await tick(); }
  assert.equal(b.microphone.streams.length, before, 'hub listening never asks for the microphone');
});

test('saving a key runs no API check and asks for no microphone (the P1 contract)', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  const streams = b.microphone.streams.length;
  b.enterPersonalKey({ key: secrets.personal, remember: true });
  await tick(); await tick();
  assert.equal(b.gemini.calls.length, 0, 'saving a key starts no provider check');
  assert.equal(b.microphone.streams.length, streams, 'saving a key asks for no microphone');
});

test('main.js offers the start stream synchronously and shares one platform', async () => {
  const source = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  // One platform, or the handover is held by an instance nobody reads.
  assert.equal((source.match(/createPlatform\(win\)/g) ?? []).length, 1, 'one platform instance');
  assert.match(source, /platform = createPlatform\(win\)/);
  // The offer is made in the gesture, before the request settles.
  assert.match(source, /platform\.provideStream\(granted\.then/);
  assert.match(source, /micPermission\.request\(\{ purpose: 'start'/);
  // The settings section asks with the probe purpose, which stops its tracks.
  assert.match(source, /onRequest: \(\{ purpose \}\) => micPermission\.request\(\{ purpose \}\)/);
  assert.match(source, /micPermission\?\.destroy\(\)/);
});

// --- P3-26: the selected microphone reaches both capture paths ---

test('the chosen device is merged into the constraints without losing any of them', async () => {
  const asked = [];
  const platform = createPlatform({ navigator: { mediaDevices: {
    getUserMedia: async (c) => { asked.push(c); return streamOf(track()); } } } });

  // The sequential path's constraints (capture.js) and the direct path's
  // (stream-capture.js) are both merged here, so neither can lose mono, echo
  // cancellation or noise suppression while gaining a device.
  const sequential = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
    autoGainControl: true, voiceIsolation: { ideal: true } }, video: false };
  const direct = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
    autoGainControl: true }, video: false };

  await platform.getUserMedia(sequential);
  assert.deepEqual(asked.at(-1), sequential, 'the system default adds nothing');

  assert.equal(platform.setInputDevice('mic-2'), 'mic-2');
  for (const constraints of [sequential, direct]) {
    await platform.getUserMedia(constraints);
    const sent = asked.at(-1);
    // Everything the caller asked for survives...
    for (const [name, value] of Object.entries(constraints.audio)) {
      assert.deepEqual(sent.audio[name], value, `${name} survives the merge`);
    }
    assert.equal(sent.video, false);
    // ...and the device is ideal, never exact: a device that has gone away must
    // fall back to the system default rather than failing the request.
    assert.deepEqual(sent.audio.deviceId, { ideal: 'mic-2' });
  }
  // The caller's object is not mutated.
  assert.equal('deviceId' in sequential.audio, false);

  // Back to the system default.
  assert.equal(platform.setInputDevice(null), null);
  await platform.getUserMedia(direct);
  assert.equal('deviceId' in asked.at(-1).audio, false);
  assert.equal(platform.setInputDevice(''), null, 'an empty id is the system default');
});

test('a pre-acquired stream follows the same choice, and a device change drops it', async () => {
  const browserStream = streamOf(track());
  const platform = createPlatform({ navigator: { mediaDevices: {
    getUserMedia: async () => browserStream } } });
  const from = (deviceId) => ({ getAudioTracks: () => [{ ...track(), getSettings: () => ({ deviceId }) }] });

  platform.setInputDevice('mic-2');
  platform.provideStream(from('mic-2'));
  const same = await platform.getUserMedia({ audio: true });
  assert.notEqual(same, browserStream, 'a stream from the selected device is used');

  // A stream captured from another microphone is not reused.
  platform.provideStream(from('mic-1'));
  assert.equal(await platform.getUserMedia({ audio: true }), browserStream, 'the wrong device is asked again');

  // Changing the device drops an offer made for the old one.
  platform.provideStream(from('mic-2'));
  platform.setInputDevice('mic-3');
  assert.equal(platform.offeredStream, null, 'the stale offer is dropped');
  assert.equal(await platform.getUserMedia({ audio: true }), browserStream);

  // A browser that reports no device id is trusted rather than asked twice.
  platform.provideStream(streamOf(track()));
  assert.notEqual(await platform.getUserMedia({ audio: true }), browserStream);
});

test('main.js applies the choice in one place and ends the capture on a change', async () => {
  const source = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(source, /platform\.setInputDevice\(chosen\)/);
  assert.equal((source.match(/setInputDevice\(/g) ?? []).length, 1, 'one place applies the device');
  // A new microphone ends the current capture; nothing restarts on its own.
  assert.match(source, /if \(changed && busy\(\)\) stopWork\(\)/);
  assert.equal(/setInputDevice[\s\S]{0,400}\.start\(/.test(source), false, 'no automatic restart after a change');
});

// --- P3-28: the device section shows what actually happened ---

function outputDouble(initial = {}) {
  const listeners = new Set();
  let state = { state: 'system', deviceId: null, applied: null, supported: true, error: null, messageKey: null, ...initial };
  return {
    snapshot: () => Object.freeze({ ...state }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { state = { ...state, ...next }; for (const fn of [...listeners]) fn(Object.freeze({ ...state })); },
  };
}
function devicesDouble(entries = {}) {
  const listeners = new Set();
  let snapshot = { selected: { audioinput: { deviceId: '' }, audiooutput: { deviceId: '' } },
    labelsAvailable: true, incomplete: false, messageKey: null };
  const lists = { audioinput: [], audiooutput: [], ...entries };
  return {
    snapshot: () => Object.freeze(snapshot),
    list: (kind) => lists[kind] ?? [],
    select() {}, refresh() {},
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { snapshot = { ...snapshot, ...next }; for (const fn of [...listeners]) fn(Object.freeze(snapshot)); },
  };
}
function deviceFixture({ devices = devicesDouble(), output = outputDouble() } = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeElement(doc, tag) };
  const nav = navigatorDouble();
  const permission = createMicrophonePermission({ navigator: nav, now: () => 1 });
  const i18n = createI18n({ dictionaries, language: 'ko' });
  const view = createAudioSettings({ permission, i18n, document: doc, devices, output });
  return { doc, view, devices, output, i18n, el: (name) => byClass(view.element, name) };
}

test('P3-28 the system default is always offered, and labels appear only after permission', () => {
  const devices = devicesDouble({
    audioinput: [{ kind: 'audioinput', deviceId: '', labelKey: 'device.systemDefault', isDefault: true },
      { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset' }],
  });
  const f = deviceFixture({ devices });
  const input = f.view.elements.inputSelect;
  assert.deepEqual(input.childNodes.map((n) => n.getAttribute('value')), ['', 'mic-2']);
  assert.equal(input.childNodes[0].textContent, ko['device.systemDefault'], 'the system default is always there');
  assert.equal(input.childNodes[1].textContent, 'Headset', 'a real label is device data, not a dictionary string');

  // Before permission the app says why the names are missing; it never guesses.
  devices.set({ labelsAvailable: false });
  assert.equal(f.el('audio-device-message').hidden, false);
  assert.equal(f.el('audio-device-message').textContent, ko['device.labelsAfterPermission']);
  devices.set({ labelsAvailable: true, incomplete: true });
  assert.equal(f.el('audio-device-message').textContent, ko['device.listIncomplete']);
  devices.set({ incomplete: false, messageKey: 'device.disappeared' });
  assert.equal(f.el('audio-device-message').textContent, ko['device.disappeared']);
  f.view.destroy();
});

test('P3-28 the output row appears only where the context can be routed', () => {
  const devices = devicesDouble({ audiooutput: [{ kind: 'audiooutput', deviceId: '', labelKey: 'device.systemDefault' }] });
  const f = deviceFixture({ devices });
  assert.equal(f.view.elements.outputSelect.parentNode.hidden, false);
  assert.equal(f.view.elements.speechNote.hidden, false, 'device speech is stated where output can be chosen');
  assert.equal(f.view.elements.speechNote.textContent, ko['device.deviceSpeechSystemOutput']);

  // A browser that cannot route an AudioContext gets the explanation instead.
  f.output.set({ supported: false, state: 'unsupported' });
  assert.equal(f.view.elements.outputSelect.parentNode.hidden, true);
  assert.equal(f.view.elements.speechNote.hidden, true);
  assert.equal(f.el('audio-output-status').textContent, ko['device.outputUnsupported']);
  f.view.destroy();
});

test('P3-28 an output change is never reported as done before it is', () => {
  const devices = devicesDouble({ audiooutput: [{ kind: 'audiooutput', deviceId: '', labelKey: 'device.systemDefault' }] });
  const f = deviceFixture({ devices });
  f.output.set({ state: 'applying', deviceId: 'speaker-2' });
  assert.equal(f.el('audio-output-status').textContent, ko['device.outputApplying']);
  assert.notEqual(f.el('audio-output-status').textContent, ko['device.outputApplied']);

  f.output.set({ state: 'applied', applied: 'speaker-2' });
  assert.equal(f.el('audio-output-status').textContent, ko['device.outputApplied']);

  // A refusal says why, and does not read as success.
  f.output.set({ state: 'failed', applied: null, error: 'denied', messageKey: 'device.outputPermission' });
  assert.equal(f.el('audio-output-status').textContent, ko['device.outputPermission']);
  assert.notEqual(f.el('audio-output-status').textContent, ko['device.outputApplied']);
  f.view.destroy();
});
