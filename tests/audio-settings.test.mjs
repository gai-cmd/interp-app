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
