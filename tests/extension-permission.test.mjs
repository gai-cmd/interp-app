// New implementation of docs/extension.md §11.1 (extension-permission); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFallbackI18n, loadExtensionI18n } from '../extension/lib/i18n.js';
import { PERMISSION_ELEMENT_IDS, createPermissionController } from '../extension/permission/controller.js';
import { FakeEvent, parseHtml } from './fixtures/extension-dom.mjs';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';
import { createFakeAudioEnv } from './fixtures/fake-audio.mjs';

// Section 11.1 `extension-permission`: the microphone-permission page controller against the PARSED real
// mic-permission.html, the fake audio environment (fake streams and tracks: no device, no sound) and the real
// dictionaries. Time is the fake browser's clock. The one thing this page must never do is leave a microphone
// stream live: every test that obtains a stream checks its tracks.
const permissionHtml = readFileSync(fileURLToPath(new URL('../extension/permission/mic-permission.html', import.meta.url)), 'utf8');

// Synchronous reads inside an async function: the whole load settles in microtasks.
async function fileFetch(url) {
  try {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  } catch { return { ok: false, json: async () => { throw new Error('missing'); } }; }
}
const i18nFor = (language) => loadExtensionI18n({ fetch: fileFetch, language });
const dictionaries = { en: await i18nFor('en'), ko: await i18nFor('ko') };

// A page over a fake browser. `permission` is the state the fake microphone starts in. The default navigator IS the
// fake audio environment's; `wrapNavigator` may replace it (see `allowOnPrompt`).
async function openPage(t, {
  permission = 'prompt', micError = null, permissionsMode = 'normal', getUserMediaMode = 'normal', language = 'en',
  wrapNavigator = (audio) => audio.env.navigator, run = true,
} = {}) {
  const browser = createFakeBrowser();
  const audio = createFakeAudioEnv({ browser, micPermission: permission });
  if (micError) audio.setMicError(micError);
  audio.setPermissionsMode(permissionsMode);
  audio.setGetUserMediaMode(getUserMediaMode);
  const document = parseHtml(permissionHtml);
  const closes = [];
  const window = { close: () => { closes.push(browser.clock.now()); } };
  const i18n = dictionaries[language] ?? await i18nFor(language);
  const controller = createPermissionController({
    document, navigator: wrapNavigator(audio), window, i18n,
    timers: { setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout },
  });
  t.after(() => controller.dispose());
  const $ = (id) => document.getElementById(id);
  const click = async (id) => { $(id).dispatchEvent(new FakeEvent('click', { bubbles: true })); await browser.settle(); };
  const started = run ? controller.start() : null;
  if (started) await Promise.race([started, browser.settle()]);
  const text = (...keys) => keys.map((key) => i18n.t(key)).join(' ');
  return { browser, audio, document, closes, i18n, controller, started, $, click, text };
}

// The permission prompt: the user allows the moment getUserMedia is called (the fake ties the query and the call to
// one state, so the wrapper flips it to granted at that moment and then delegates).
const allowOnPrompt = (audio) => ({
  permissions: { query: (descriptor) => audio.env.navigator.permissions.query(descriptor) },
  mediaDevices: { getUserMedia: (constraints) => { audio.setMicPermission('granted'); return audio.env.navigator.mediaDevices.getUserMedia(constraints); } },
});

// #perm-help is a persistent live region: it is never hidden or unhidden, its TEXT appears after a denial and is cleared otherwise.
const HELP = dictionaries.en.t('ext.permission.blockedHelp');
const assertHelp = (page, shown, message) => {
  assert.equal(page.$('perm-help').textContent, shown ? HELP : '', message ?? (shown ? 'the blocked help is written' : 'the blocked help is empty'));
  assert.equal(page.$('perm-help').hidden, false, 'the region itself is never hidden');
};

const assertNoLiveTrack = (audio, expectedStreams) => {
  if (expectedStreams !== undefined) assert.equal(audio.micStreams.length, expectedStreams);
  for (const stream of audio.micStreams) {
    for (const track of stream.getTracks()) {
      assert.equal(track.readyState, 'ended', 'the microphone track is stopped');
      assert.ok(track.stops >= 1, 'stop() was called on the track');
    }
  }
};

// ---------------------------------------------------------------------------------------------
test('every id the controller uses exists in the page, and #perm-status is a persistent live region', async (t) => {
  const page = await openPage(t);
  for (const id of PERMISSION_ELEMENT_IDS) assert.ok(page.$(id), `#${id} exists`);
  for (const id of ['perm-title', 'perm-lead', 'perm-always', 'perm-request', 'perm-status', 'perm-help', 'perm-close']) assert.ok(page.$(id), `#${id} exists (8.4)`);
  assert.equal(page.$('perm-status').getAttribute('role'), 'status');
  assert.equal(page.$('perm-status').hidden, false);
  assert.equal(page.$('perm-help').getAttribute('role'), 'status', '#perm-help is live too: help that appears silently is never heard');
  assert.equal(page.$('perm-help').hidden, false);
  assert.equal(page.$('perm-request').listenerCount, 1);
  assert.equal(page.$('perm-close').listenerCount, 1);
});

test('applyI18n sets the document title, html lang and the static texts', async (t) => {
  const page = await openPage(t, { permission: 'granted' });
  assert.equal(page.document.documentElement.getAttribute('lang'), 'en');
  assert.equal(page.document.title, dictionaries.en.t('ext.permission.title'));
  assert.equal(page.$('perm-title').textContent, dictionaries.en.t('ext.permission.title'));
  assert.equal(page.$('perm-always').textContent, dictionaries.en.t('ext.permission.chooseAlways'));
  // One name for the action: the button reads like the panel's Allow microphone button and the notices that point at it.
  assert.equal(page.$('perm-request').textContent, dictionaries.en.t('ext.permission.allowButton'));
  assert.equal(page.$('perm-request').textContent, page.$('perm-title').textContent, 'and like the title of this page');
  assert.equal(page.$('perm-close').textContent, dictionaries.en.t('common.close'));
  const ko = await openPage(t, { permission: 'granted', language: 'ko' });
  assert.equal(ko.document.documentElement.getAttribute('lang'), 'ko');
  assert.equal(ko.document.title, dictionaries.ko.t('ext.permission.title'));
  assert.notEqual(ko.document.title, page.document.title);
});

test('the status reads permission.checking while the permission query is pending, then moves on', async (t) => {
  const page = await openPage(t, { permission: 'granted', permissionsMode: 'held' });
  assert.equal(page.audio.pendingPermissionQueries(), 1);
  assert.equal(page.$('perm-status').textContent, page.text('permission.checking'));
  page.audio.releasePermissionQueries();
  await page.started;
  assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
  assert.equal(page.$('perm-status').hidden, false);
});

// ---------------------------------------------------------------------------------------------
test('prompt: getUserMedia runs on load, EVERY track is stopped at once, granted + done are shown, the tab closes after exactly 2000 ms', async (t) => {
  const page = await openPage(t, { wrapNavigator: allowOnPrompt });
  assert.equal(page.audio.micStreams.length, 1, 'one getUserMedia call on load');
  assertNoLiveTrack(page.audio, 1);
  assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
  assertHelp(page, false);
  assert.equal(page.closes.length, 0, 'the tab stays open so the line can be read');
  await page.browser.clock.advance(1999);
  assert.equal(page.closes.length, 0, 'not closed before 2000 ms');
  await page.browser.clock.advance(1);
  assert.equal(page.closes.length, 1, 'closed at 2000 ms');
  assert.equal(page.closes[0], 2000);
  await page.browser.clock.advance(10000);
  assert.equal(page.closes.length, 1, 'closed once');
  assertNoLiveTrack(page.audio, 1);
});

test('#perm-close closes at once and cancels the timer of a grant', async (t) => {
  const page = await openPage(t, { wrapNavigator: allowOnPrompt });
  assert.equal(page.closes.length, 0);
  await page.click('perm-close');
  assert.equal(page.closes.length, 1);
  await page.browser.clock.advance(5000);
  assert.equal(page.closes.length, 1, 'the pending 2000 ms close was cancelled');
});

test('#perm-close works before any grant too', async (t) => {
  const page = await openPage(t, { micError: 'NotAllowedError' });
  await page.click('perm-close');
  assert.equal(page.closes.length, 1);
});

test('already granted: getUserMedia is skipped, no stream exists, the same granted line and the same close', async (t) => {
  const page = await openPage(t, { permission: 'granted' });
  assert.equal(page.audio.micStreams.length, 0, 'the microphone was never opened');
  assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
  assertHelp(page, false);
  await page.browser.clock.advance(1999);
  assert.equal(page.closes.length, 0);
  await page.browser.clock.advance(1);
  assert.equal(page.closes.length, 1);
});

// The denial branches: the page tells the user what happened and shows the help.
for (const name of ['NotAllowedError', 'SecurityError', 'AbortError', 'SomethingOdd']) {
  test(`${name} reads as a denial: permission.denied, the blocked help WRITTEN into the live #perm-help, no stream, no close`, async (t) => {
    const page = await openPage(t, { micError: name });
    assert.equal(page.$('perm-status').textContent, page.text('permission.denied'));
    assertHelp(page, true);
    assert.equal(page.$('perm-help').getAttribute('role'), 'status');
    assert.equal(page.audio.micStreams.length, 0);
    await page.browser.clock.advance(10000);
    assert.equal(page.closes.length, 0, 'a denial never closes the tab');
    assert.equal(page.$('perm-status').hidden, false);
  });
}

test('NotFoundError: no device, hint shown, help empty', async (t) => {
  const page = await openPage(t, { micError: 'NotFoundError' });
  assert.equal(page.$('perm-status').textContent, page.text('permission.noDevice', 'permission.noDeviceHint'));
  assertHelp(page, false);
  assert.equal(page.audio.micStreams.length, 0);
});

test('NotReadableError: busy, hint shown, help empty (it is not a denial)', async (t) => {
  const page = await openPage(t, { micError: 'NotReadableError' });
  assert.equal(page.$('perm-status').textContent, page.text('permission.busy', 'permission.busyHint'));
  assertHelp(page, false);
  assert.notEqual(page.$('perm-status').textContent, page.text('permission.denied'));
});

test('#perm-request repeats the request: a denial followed by an allowed retry ends granted with every track stopped', async (t) => {
  const page = await openPage(t, { micError: 'NotAllowedError' });
  assertHelp(page, true);
  page.audio.setMicError(null);
  page.audio.setMicPermission('granted');
  await page.click('perm-request');
  assert.equal(page.audio.micStreams.length, 1);
  assertNoLiveTrack(page.audio, 1);
  assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
  assertHelp(page, false, 'the help text is cleared once the microphone is allowed (the region stays)');
  await page.browser.clock.advance(2000);
  assert.equal(page.closes.length, 1);
});

test('#perm-request after a failure of another kind replaces the status', async (t) => {
  const page = await openPage(t, { micError: 'NotFoundError' });
  assert.equal(page.$('perm-status').textContent, page.text('permission.noDevice', 'permission.noDeviceHint'));
  page.audio.setMicError('NotReadableError');
  await page.click('perm-request');
  assert.equal(page.$('perm-status').textContent, page.text('permission.busy', 'permission.busyHint'));
  page.audio.setMicError('NotAllowedError');
  await page.click('perm-request');
  assert.equal(page.$('perm-status').textContent, page.text('permission.denied'));
  assertHelp(page, true);
});

test('a re-entrant #perm-request while a request is pending is ignored (one getUserMedia call)', async (t) => {
  const page = await openPage(t, { wrapNavigator: allowOnPrompt, getUserMediaMode: 'held', run: true });
  assert.equal(page.audio.pendingGetUserMedia(), 1, 'the prompt is showing');
  assert.equal(page.$('perm-status').textContent, page.text('permission.prompt'));
  await page.click('perm-request');
  await page.click('perm-request');
  assert.equal(page.audio.pendingGetUserMedia(), 1, 'no second request was started');
  assert.equal(page.audio.micStreams.length, 1);
  page.audio.releaseGetUserMedia();
  await page.started;
  await page.browser.settle();
  assertNoLiveTrack(page.audio, 1);
  assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
  // Once the request is over, a new one is allowed again.
  page.audio.setGetUserMediaMode('normal');
  await page.click('perm-request');
  assert.equal(page.audio.micStreams.length, 2);
  assertNoLiveTrack(page.audio, 2);
});

test('permissions API missing or throwing: the page still requests the microphone', async (t) => {
  for (const mode of ['missing', 'throws']) {
    const page = await openPage(t, { permission: 'granted', permissionsMode: mode });
    assert.equal(page.audio.micStreams.length, 1, `${mode}: getUserMedia was called`);
    assertNoLiveTrack(page.audio, 1);
    assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
  }
  const denied = await openPage(t, { micError: 'NotAllowedError', permissionsMode: 'missing' });
  assert.equal(denied.$('perm-status').textContent, denied.text('permission.denied'));
});

test('a stream that resolves after dispose is stopped and changes nothing on the page', async (t) => {
  const page = await openPage(t, { wrapNavigator: allowOnPrompt, getUserMediaMode: 'held' });
  assert.equal(page.audio.pendingGetUserMedia(), 1);
  assert.equal(page.audio.micStreams[0].getTracks()[0].readyState, 'live', 'the stream is held, not yet delivered');
  const before = page.$('perm-status').textContent;
  page.controller.dispose();
  page.audio.releaseGetUserMedia();
  await page.started;
  await page.browser.settle();
  assertNoLiveTrack(page.audio, 1);
  assert.equal(page.$('perm-status').textContent, before, 'a disposed page shows no result');
  await page.browser.clock.advance(10000);
  assert.equal(page.closes.length, 0, 'and closes nothing');
  assert.equal(page.$('perm-request').listenerCount, 0, 'dispose removed the button listeners');
  assert.equal(page.$('perm-close').listenerCount, 0);
});

test('a failure that arrives after dispose is not rendered', async (t) => {
  const page = await openPage(t, { wrapNavigator: allowOnPrompt, getUserMediaMode: 'held' });
  const before = page.$('perm-status').textContent;
  page.controller.dispose();
  page.audio.releaseGetUserMedia({ error: 'NotAllowedError' });
  await page.started;
  await page.browser.settle();
  assert.equal(page.$('perm-status').textContent, before);
  assertHelp(page, false);
});

test('the help text follows the language of the page and a retry that fails again writes it again', async (t) => {
  const ko = await openPage(t, { micError: 'NotAllowedError', language: 'ko' });
  assert.equal(ko.$('perm-help').textContent, dictionaries.ko.t('ext.permission.blockedHelp'));
  assert.notEqual(ko.$('perm-help').textContent, HELP);
  // Denied, then something else, then denied again: the region is cleared in between and refilled, never toggled hidden.
  const page = await openPage(t, { micError: 'NotAllowedError' });
  assertHelp(page, true);
  page.audio.setMicError('NotFoundError');
  await page.click('perm-request');
  assertHelp(page, false);
  page.audio.setMicError('NotAllowedError');
  await page.click('perm-request');
  assertHelp(page, true);
  // While a request is pending the old help is gone (the prompt is what matters), so it cannot be read next to "prompt".
  const held = await openPage(t, { micError: 'NotAllowedError' });
  held.audio.setMicError(null);
  held.audio.setMicPermission('granted');
  held.audio.setGetUserMediaMode('held');
  await held.click('perm-request');
  assert.equal(held.$('perm-status').textContent, held.text('permission.prompt'));
  assertHelp(held, false);
});

test('dispose cancels a pending close', async (t) => {
  const page = await openPage(t, { permission: 'granted' });
  page.controller.dispose();
  await page.browser.clock.advance(5000);
  assert.equal(page.closes.length, 0);
  page.controller.dispose();   // idempotent
});

test('a track whose stop() throws does not stop the others or break the grant', async (t) => {
  const page = await openPage(t, {
    wrapNavigator: (audio) => ({
      permissions: { query: (descriptor) => audio.env.navigator.permissions.query(descriptor) },
      mediaDevices: {
        getUserMedia: async (constraints) => {
          audio.setMicPermission('granted');
          const stream = await audio.env.navigator.mediaDevices.getUserMedia(constraints);
          const extra = stream.getTracks()[0].clone();
          stream.addTrack(extra);
          stream.getTracks()[0].stop = () => { throw new Error('stop failed'); };
          return stream;
        },
      },
    }),
  });
  const [broken, extra] = page.audio.micStreams[0].getTracks();
  assert.equal(extra.readyState, 'ended', 'the second track was still stopped');
  assert.equal(broken.readyState, 'live', 'the fake track that refused to stop is the only one left');
  assert.equal(page.$('perm-status').textContent, page.text('permission.granted', 'ext.permission.done'));
});

test('the one name of the allow action is the same on this page, in the notices and in the panel button, in every language', async (t) => {
  for (const language of ['en', 'ko']) {
    const page = await openPage(t, { permission: 'granted', language });
    const label = dictionaries[language].t('ext.permission.allowButton');
    assert.equal(page.$('perm-request').textContent, label, `${language}: button`);
    assert.equal(page.$('perm-title').textContent, label, `${language}: title`);
    assert.equal(page.document.title, label, `${language}: document title`);
    assert.ok(dictionaries[language].t('ext.error.MICROPHONE_DENIED').includes(label), `${language}: the notice tells the user to press exactly this`);
  }
});

test('the boot dictionary keeps the page working when the dictionaries did not load', async (t) => {
  const browser = createFakeBrowser();
  const audio = createFakeAudioEnv({ browser, micPermission: 'granted' });
  const document = parseHtml(permissionHtml);
  const closes = [];
  const controller = createPermissionController({
    document, navigator: audio.env.navigator, window: { close: () => closes.push(1) }, i18n: createFallbackI18n(),
    timers: { setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout },
  });
  t.after(() => controller.dispose());
  await controller.start();
  const boot = createFallbackI18n();
  assert.equal(document.getElementById('perm-status').textContent, `${boot.t('error.unknown')} ${boot.t('error.unknown')}`, 'unknown keys never echo their names');
  await browser.clock.advance(2000);
  assert.equal(closes.length, 1);
});
