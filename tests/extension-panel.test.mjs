// New implementation of docs/extension.md §11.1 (extension-panel); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeMediaStream, FakeTrack, createFakeAudioEnv } from './fixtures/fake-audio.mjs';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';
import { FakeEvent, parseHtml } from './fixtures/extension-dom.mjs';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../extension/lib/i18n.js';
import { LIMITS, PATHS, PORT_NAMES, STORAGE_KEYS, makeFrame, validateFrame } from '../extension/lib/protocol.js';
import { createDefaultSettings, normalizeSettings } from '../extension/lib/settings.js';
import { buildUiState, createIdleLaneState } from '../extension/lib/ui-state.js';
import { PANEL_ELEMENT_IDS, createPanelController } from '../extension/panel/controller.js';
import { UPDATE_MANIFEST_URL, UPDATE_SITE_URL } from '../extension/lib/update-check.js';
import { createHostLink } from '../extension/panel/host-link.js';
import { PAIR_MODEL, TRANSLATION_ONLY_MODEL, UPDATE_ERROR_KEY, UPDATE_STEPS, buildUpdateBanner, buildViewModel } from '../extension/panel/view-model.js';
import { UPDATE_ERROR_CODES } from '../extension/lib/self-update.js';
import { DISPLAY_MEDIA_CONSTRAINTS, PICKER_REFUSED_AT_ONCE_MS } from '../extension/lib/display-media.js';
import { RELAY_TAB_ENDED, createRelaySender, createRelaySource, relayEndCode } from '../extension/lib/audio-relay.js';
import { createRelayWorld } from './fixtures/fake-relay.mjs';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS, TRANSLATE_LIVE_MODEL, liveRoute } from '../app/providers/gemini/live-config.js';

// Section 11.1 `extension-panel`: the pure view model (8.2.3 rules 1-17, table driven) and the controller run against
// the PARSED real panel.html, the real dictionaries, the fake browser and a stub service worker. Everything is
// silent: no browser, no audio device, time is the fake clock's.

const readText = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const PANEL_HTML = await readText('extension/panel/panel.html');
const PANEL_SOURCE = await readText('extension/panel/controller.js');
const FAKE_KEY = ['synthetic', 'x'.repeat(24)].join('-');
const KEYS = STORAGE_KEYS;

// The dictionaries are read from disk once, so a later load settles through microtasks only and the fake clock stays
// the single source of timing (a real file read would finish on its own schedule).
const DICTIONARY_TEXT = new Map();
for (const language of ['en', 'ko', 'ja']) {
  for (const path of [`app/i18n/${language}.json`, `extension/i18n/${language}.json`]) {
    DICTIONARY_TEXT.set(new URL(`../${path}`, import.meta.url).href, await readText(path));
  }
}
const fileFetch = async (url) => {
  const text = DICTIONARY_TEXT.get(String(url));
  return text === undefined ? { ok: false } : { ok: true, json: async () => JSON.parse(text) };
};
const defaultLoad = (options) => loadExtensionI18n({ fetch: fileFetch, ...options });
const REF = {};
for (const language of ['en', 'ko', 'ja']) REF[language] = await defaultLoad({ language });
const T = (key, params) => REF.en.t(key, params);
const has = (key) => REF.en.has(key);

const isDeepFrozen = (value) => value === null || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));

// ---------------------------------------------------------------------------------------------
// Builders shared by the view-model and controller tests.
function settingsWith(mutate = () => {}) {
  const draft = JSON.parse(JSON.stringify(createDefaultSettings('en')));
  mutate(draft);
  return normalizeSettings(draft);
}
const bothLanes = (draft) => { draft.lanes.tab.enabled = true; draft.lanes.mic.enabled = true; };

const laneOf = (lane, overrides) => (overrides ? { ...createIdleLaneState(lane), ...overrides, lane } : undefined);
let hostSeq = 0;
const hostUi = ({ tab, mic, speechMuted = true } = {}) => buildUiState({
  hostId: 'h-test', seq: ++hostSeq, speechMuted, lanes: { tab: laneOf('tab', tab), mic: laneOf('mic', mic) },
});
const RUN = { phase: 'running', engineStatus: 'running', model: 'gemini-3.8-live', route: 'flash', targetLanguage: 'ko', epoch: 1 };
const running = (lane, extra = {}) => ({ ...RUN, ...(lane === 'tab' ? { tabId: 7 } : {}), ...extra });
const failed = (errorCode, extra = {}) => ({ phase: 'error', engineStatus: 'failed', errorCode, epoch: 1, ...extra });

function vmOf(overrides = {}) {
  return buildViewModel({
    settings: createDefaultSettings('en'), keyPresent: true, host: null, armed: false,
    targetTab: { id: 7, title: 'Example', capturable: true }, shortcut: null, micPermission: 'granted', micWasGranted: false,
    pending: { tab: false, mic: false }, localErrors: { tab: null, mic: null }, stopReason: null,
    previews: { tab: null, mic: null }, capturedTitle: null, language: 'en', has, ...overrides,
  });
}

// =============================================================================================
// Part 1: buildViewModel
// =============================================================================================

test('rule 1: lane phase comes from the host, pending overrides an idle host, awaiting needs the tab lane and a start through the share dialog', () => {
  assert.equal(vmOf().lanes.tab.phase, 'off');
  assert.equal(vmOf({ host: hostUi({ tab: running('tab') }) }).lanes.tab.phase, 'running');
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'stopping' } }) }).lanes.tab.phase, 'stopping');
  // §20: the tab lane waits for the user in ONE way: Chrome's share dialog is open (Start on a tab the icon did not arm).
  // A start in flight that is not the dialog is an ordinary start, and an idle un-armed tab waits for nothing.
  assert.equal(vmOf({ pending: { tab: true, mic: false }, picking: true }).lanes.tab.phase, 'awaiting');
  assert.equal(vmOf({ pending: { tab: true, mic: false }, picking: true, armed: true }).lanes.tab.phase, 'awaiting', 'the dialog, whatever the armed record says now');
  assert.equal(vmOf({ pending: { tab: true, mic: false } }).lanes.tab.phase, 'starting');
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true }).lanes.tab.phase, 'starting');
  assert.equal(vmOf({ armed: false }).lanes.tab.phase, 'off', 'an un-armed idle tab waits for nothing');
  assert.equal(vmOf({ picking: true }).lanes.tab.phase, 'off', '`picking` alone, with no start in flight, is not a wait');
  assert.equal(vmOf({ pending: { tab: true, mic: false }, picking: true, host: hostUi({ tab: running('tab') }) }).lanes.tab.phase, 'running',
    'the host wins over a local wait');
  assert.equal(vmOf({ pending: { tab: false, mic: true } }).lanes.mic.phase, 'starting');
  // the microphone lane never waits for the share dialog
  assert.equal(vmOf({ pending: { tab: false, mic: true }, armed: false, picking: true }).lanes.mic.phase, 'starting');
  assert.equal(vmOf({ pending: { tab: true, mic: false }, picking: true }).lanes.mic.phase, 'off');
  // pending on a host-idle-error lane is a retry
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true, host: hostUi({ tab: failed('TAB_CAPTURE_BUSY') }) }).lanes.tab.phase, 'starting');
  // a lane the host already runs keeps its host phase (a late pending flag must not regress it to "starting")
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true, host: hostUi({ tab: running('tab') }) }).lanes.tab.phase, 'running');
  // a failed sw/lane-start makes the lane an error lane with that code
  const local = vmOf({ localErrors: { tab: 'TAB_CAPTURE_BUSY', mic: null } });
  assert.equal(local.lanes.tab.phase, 'error');
  assert.equal(local.lanes.tab.notice.key, 'ext.error.TAB_CAPTURE_BUSY');
});

test('2026-10-08 rule 1: the host starting a lane without an engine or a tab is a dialog, unless this panel sent that start as a relay start (its own dialog is over)', () => {
  const hostStarting = hostUi({ tab: { phase: 'starting', engineStatus: null } });
  const dialog = vmOf({ pending: { tab: true, mic: false }, host: hostStarting });
  assert.equal(dialog.lanes.tab.phase, 'awaiting', 'the worker\'s dialog, held open by the host');
  assert.equal(dialog.primary.key, 'common.cancel');
  const relayed = vmOf({ pending: { tab: true, mic: false }, relaying: true, host: hostStarting });
  assert.equal(relayed.lanes.tab.phase, 'starting', 'the tab was chosen in the panel: the host is setting the lane up');
  assert.deepEqual(relayed.pill, { state: 'starting', key: 'sim.status.preparing', params: {} });
  assert.deepEqual(relayed.lanes.tab.status, { key: 'sim.status.preparing', params: {} });
  assert.equal(relayed.primary.key, 'common.stop');
  assert.equal(relayed.lanes.tab.armNote, null, 'no dialog note');
  // only `true` counts, and the relay start never hides a host that runs or names its tab
  assert.equal(vmOf({ pending: { tab: true, mic: false }, relaying: 'yes', host: hostStarting }).lanes.tab.phase, 'awaiting');
  assert.equal(vmOf({ relaying: true, host: hostUi({ tab: running('tab') }) }).lanes.tab.phase, 'running');
});

test('2026-09-30: a key swap or the planned handover reads as a plain "reconnecting" with no count, in the lane and in the pill', () => {
  for (const reason of ['key', 'handover']) {
    const vm = vmOf({ host: hostUi({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', retries: 2, reconnectReason: reason } }) });
    assert.deepEqual(vm.lanes.tab.status, { key: 'sim.status.reconnecting', params: {} }, reason);
    assert.deepEqual(vm.pill, { state: 'running', key: 'sim.status.reconnecting', params: {} }, reason);
  }
  // A lost connection in the other lane still sets the pill, with its count.
  const mixed = vmOf({ settings: settingsWith(bothLanes), host: hostUi({
    tab: { phase: 'reconnecting', engineStatus: 'reconnecting', reconnectReason: 'handover' },
    mic: { phase: 'reconnecting', engineStatus: 'reconnecting', retries: 1 } }) });
  assert.deepEqual(mixed.pill, { state: 'warning', key: 'ext.status.reconnecting', params: { count: 1 } });
  assert.deepEqual(mixed.lanes.mic.status, { key: 'ext.status.reconnecting', params: { count: 1 } });
  assert.deepEqual(mixed.lanes.tab.status, { key: 'sim.status.reconnecting', params: {} });
  for (const language of ['en', 'ko', 'ja']) assert.equal(REF[language].has('sim.status.reconnecting'), true, language);
});

test('rule 2: primary button mode, key and disabled state', () => {
  const idle = vmOf();
  assert.deepEqual(idle.primary, { mode: 'start', key: 'common.start', disabled: false });
  assert.equal(idle.noLane, false);
  assert.equal(vmOf({ keyPresent: false }).primary.disabled, true);
  const none = vmOf({ settings: settingsWith((s) => { s.lanes.tab.enabled = false; }) });
  assert.equal(none.noLane, true);
  assert.equal(none.primary.disabled, true);
  const stop = vmOf({ host: hostUi({ tab: running('tab') }), keyPresent: false });
  assert.deepEqual(stop.primary, { mode: 'stop', key: 'common.stop', disabled: false }, 'Stop is never disabled');
  assert.equal(stop.noLane, false);
  // (tabId: a stream-id start names its tab from the first state; a `starting` lane WITHOUT a tab and an engine is
  // the share dialog of §19, which reads Cancel, see rule 9)
  for (const phase of ['starting', 'reconnecting', 'stopping']) {
    assert.equal(vmOf({ host: hostUi({ tab: { phase, tabId: 7 } }) }).primary.key, 'common.stop', phase);
  }
  // only a wait (the share dialog is open, per this panel's own start or per the host that holds it): Cancel
  assert.deepEqual(vmOf({ pending: { tab: true, mic: false }, picking: true }).primary, { mode: 'stop', key: 'common.cancel', disabled: false });
  assert.deepEqual(vmOf({ host: hostUi({ tab: { phase: 'starting', engineStatus: null } }) }).primary, { mode: 'stop', key: 'common.cancel', disabled: false });
  // an un-armed idle tab is not a wait: Start
  assert.deepEqual(vmOf({ armed: false }).primary, { mode: 'start', key: 'common.start', disabled: false });
  // a lane in local error next to the waiting one is not "off": the button says Stop
  const mixed = vmOf({ settings: settingsWith(bothLanes), pending: { tab: true, mic: false }, picking: true,
    localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } });
  assert.equal(mixed.primary.key, 'common.stop');
  // the microphone starting next to the open dialog is not "only a wait" either
  assert.equal(vmOf({ settings: settingsWith(bothLanes), pending: { tab: true, mic: true }, picking: true }).primary.key, 'common.stop');
  // R6: a lane the user switched OFF that still carries an old host error is out of the picture, like in the pill: the
  // dialog is the only thing under way, so the button says Cancel. An enabled lane with that error still reads Stop.
  const micOff = settingsWith((s) => { s.lanes.tab.enabled = true; s.lanes.mic.enabled = false; });
  const dialog = { pending: { tab: true, mic: false }, picking: true };
  assert.equal(vmOf({ settings: micOff, ...dialog, host: hostUi({ mic: failed('MICROPHONE_UNAVAILABLE') }) }).primary.key, 'common.cancel',
    'a switched-off lane with a host error does not turn Cancel into Stop');
  assert.equal(vmOf({ settings: settingsWith(bothLanes), ...dialog, host: hostUi({ mic: failed('MICROPHONE_UNAVAILABLE') }) }).primary.key, 'common.stop',
    'the same error on a lane that is on counts');
  // ... but a switched-off lane the host still has busy (it is being stopped) is something Cancel would not undo alone.
  assert.equal(vmOf({ settings: micOff, ...dialog, host: hostUi({ mic: { phase: 'stopping' } }) }).primary.key, 'common.stop');
  assert.equal(vmOf({ settings: micOff, ...dialog, host: hostUi({ mic: running('mic') }) }).primary.key, 'common.stop');
});

test('rule 3: keyMissing follows keyPresent', () => {
  assert.equal(vmOf({ keyPresent: false }).keyMissing, true);
  assert.equal(vmOf({ keyPresent: true }).keyMissing, false);
});

test('rule 4: overall pill precedence', () => {
  const both = settingsWith(bothLanes);
  const cases = [
    ['idle', {}, 'idle', 'sim.status.idle', {}],
    ['error alone', { host: hostUi({ tab: failed('INVALID_KEY', { keyFailure: true }) }) }, 'error', 'ext.status.failed', {}],
    ['TAB_ENDED alone is not an alarm', { host: hostUi({ tab: failed('TAB_ENDED') }) }, 'warning', 'sim.status.stopped', {}],
    ['TAB_GONE alone is not an alarm', { host: hostUi({ tab: failed('TAB_GONE') }) }, 'warning', 'sim.status.stopped', {}],
    ['two soft errors', { settings: both, host: hostUi({ tab: failed('TAB_ENDED'), mic: failed('TAB_GONE') }) }, 'warning', 'sim.status.stopped', {}],
    ['a hard error among soft ones', { settings: both, host: hostUi({ tab: failed('TAB_ENDED'), mic: failed('INVALID_KEY') }) }, 'error', 'ext.status.failed', {}],
    ['one fails while the other runs', { settings: both, host: hostUi({ tab: failed('INVALID_KEY'), mic: running('mic') }) }, 'warning', 'ext.status.partial', {}],
    ['a soft error while the other runs is still partial', { settings: both, host: hostUi({ tab: failed('TAB_ENDED'), mic: running('mic') }) }, 'warning', 'ext.status.partial', {}],
    ['reconnecting shows the count', { host: hostUi({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', retries: 2 } }) }, 'warning', 'ext.status.reconnecting', { count: 2 }],
    ['reconnecting outranks stopping', { settings: both, host: hostUi({ tab: { phase: 'stopping' }, mic: { phase: 'reconnecting', engineStatus: 'reconnecting', retries: 1 } }) }, 'warning', 'ext.status.reconnecting', { count: 1 }],
    ['stopping', { host: hostUi({ tab: { phase: 'stopping' } }) }, 'warning', 'sim.status.stopping', {}],
    ['§20 the share dialog Start opened on an un-armed tab', { pending: { tab: true, mic: false }, picking: true }, 'warning', 'ext.status.choosingTab', {}],
    ['§20 the dialog is open while the microphone already runs: the pill still asks for the choice', { settings: both, pending: { tab: true, mic: false }, picking: true, host: hostUi({ mic: running('mic') }) }, 'warning', 'ext.status.choosingTab', {}],
    ['awaiting while the microphone starts: starting wins', { settings: both, pending: { tab: true, mic: true }, picking: true }, 'starting', 'sim.status.preparing', {}],
    ['starting, connecting', { host: hostUi({ tab: { phase: 'starting', engineStatus: 'connecting' } }) }, 'starting', 'sim.status.connecting', {}],
    ['starting, preparing', { host: hostUi({ tab: { phase: 'starting', engineStatus: 'preparing' } }) }, 'starting', 'sim.status.preparing', {}],
    ['starting, host-level step (no engine yet)', { host: hostUi({ tab: { phase: 'starting', engineStatus: null, tabId: 7 } }) }, 'starting', 'sim.status.preparing', {}],
    ['§19 the share dialog is open (starting, no engine, no tab yet)', { host: hostUi({ tab: { phase: 'starting', engineStatus: null } }) }, 'warning', 'ext.status.choosingTab', {}],
    ['§19 the microphone lane has no dialog: starting without an engine is just starting', { settings: both, host: hostUi({ mic: { phase: 'starting', engineStatus: null } }) }, 'starting', 'sim.status.preparing', {}],
    ['one lane preparing keeps the earlier stage', { settings: both, host: hostUi({ tab: { phase: 'starting', engineStatus: 'connecting' }, mic: { phase: 'starting', engineStatus: 'preparing' } }) }, 'starting', 'sim.status.preparing', {}],
    ['running', { host: hostUi({ tab: running('tab') }) }, 'running', 'sim.status.running', {}],
    ['starting outranks running', { settings: both, host: hostUi({ tab: running('tab'), mic: { phase: 'starting', engineStatus: 'connecting' } }) }, 'starting', 'sim.status.connecting', {}],
  ];
  for (const [name, input, state, key, params] of cases) {
    const { pill } = vmOf(input);
    assert.deepEqual({ state: pill.state, key: pill.key, params: pill.params }, { state, key, params }, name);
  }
});

test('rule 5: the lane status key for every phase', () => {
  const status = (host, extra = {}) => vmOf({ host: host ? hostUi(host) : null, ...extra }).lanes.tab.status;
  assert.deepEqual(status(null), { key: 'sim.status.idle', params: {} });
  assert.deepEqual(vmOf({ pending: { tab: true, mic: false }, picking: true }).lanes.tab.status, { key: 'ext.status.choosingTab', params: {} });
  assert.deepEqual(vmOf({ pending: { tab: true, mic: false } }).lanes.tab.status, { key: 'sim.status.preparing', params: {} }, 'a start that is not the dialog is just starting');
  assert.equal(status({ tab: { phase: 'starting', engineStatus: 'connecting' } }).key, 'sim.status.connecting');
  assert.equal(status({ tab: { phase: 'starting', engineStatus: 'preparing' } }).key, 'sim.status.preparing');
  assert.equal(status({ tab: { phase: 'starting', engineStatus: null, tabId: 7 } }).key, 'sim.status.preparing');
  assert.equal(status({ tab: { phase: 'starting', engineStatus: null } }).key, 'ext.status.choosingTab', '§19: no engine and no tab yet = the share dialog');
  assert.equal(status({ tab: running('tab') }).key, 'sim.status.running');
  assert.deepEqual(status({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', retries: 3 } }), { key: 'ext.status.reconnecting', params: { count: 3 } });
  assert.equal(status({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', retries: 0 } }).params.count, 1, 'count is 1..3');
  assert.equal(status({ tab: { phase: 'stopping' } }).key, 'sim.status.stopping');
  assert.equal(status({ tab: failed('TAB_ENDED') }).key, 'sim.status.stopped');
  assert.equal(status({ tab: failed('TAB_GONE') }).key, 'sim.status.stopped');
  assert.equal(status({ tab: failed('RATE_LIMITED', { quota: true }) }).key, 'ext.status.failed');
});

test('rule 5b: a lane the user switched off says Off, not "Ready to start"; a lane that is on and idle keeps "Ready to start"', () => {
  // The default settings have the tab lane on and the microphone lane off.
  const fresh = vmOf();
  assert.deepEqual(fresh.lanes.tab.status, { key: 'sim.status.idle', params: {} });
  assert.deepEqual(fresh.lanes.mic.status, { key: 'ext.status.off', params: {} });
  const swapped = vmOf({ settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; }) });
  assert.deepEqual(swapped.lanes.tab.status, { key: 'ext.status.off', params: {} });
  assert.deepEqual(swapped.lanes.mic.status, { key: 'sim.status.idle', params: {} });
  // Off only replaces the idle line: a switched-off lane that is stopping, failed or waiting keeps saying so.
  const off = settingsWith((s) => { s.lanes.tab.enabled = false; });
  assert.equal(vmOf({ settings: off, host: hostUi({ tab: { phase: 'stopping' } }) }).lanes.tab.status.key, 'sim.status.stopping');
  assert.equal(vmOf({ settings: off, host: hostUi({ tab: failed('INVALID_KEY') }) }).lanes.tab.status.key, 'ext.status.failed');
  // The pill is the overall state and does not change with it.
  assert.equal(fresh.pill.key, 'sim.status.idle');
});

test('rule 6: the route line exists only while running and names the fallback', () => {
  const route = (extra) => vmOf({ host: hostUi({ tab: running('tab', extra) }) }).lanes.tab.route;
  assert.deepEqual(route({ route: 'translation', model: 'gemini-3.5-live-translate-preview' }),
    { textKey: 'sim.route.translation', model: 'gemini-3.5-live-translate-preview' });
  assert.deepEqual(route({ route: 'flash' }), { textKey: 'sim.route.flash', model: 'gemini-3.8-live' });
  assert.equal(route({ route: 'translation', fallback: true }).textKey, 'ext.route.fallback');
  assert.equal(route({ route: 'translation', fallback: true, model: 'gemini-3.8-live' }).model, 'gemini-3.8-live', 'the model id stays on the route line');
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', route: 'flash' } }) }).lanes.tab.route, null);
  assert.equal(vmOf().lanes.tab.route, null);
});

test('rule 6b: the warning of a backup model is a route NOTE (its own live region), only while running with a fallback, per lane', () => {
  const note = (lane, extra, settings = createDefaultSettings('en')) => vmOf({ settings, host: hostUi({ [lane]: running(lane, extra) }) }).lanes[lane].routeNote;
  assert.equal(note('tab', { route: 'translation', fallback: true }), 'ext.route.fallbackNote');
  assert.equal(note('mic', { route: 'flash', fallback: true }, settingsWith(bothLanes)), 'ext.route.fallbackNote', 'the microphone card gets the same neutral text');
  assert.equal(note('tab', { route: 'translation' }), null, 'no fallback, no note');
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', fallback: true } }) }).lanes.tab.routeNote, null, 'only while running');
  assert.equal(vmOf().lanes.tab.routeNote, null);
  assert.equal(vmOf().lanes.mic.routeNote, null);
  // Both lanes on a backup model: each card says it about ITS lane.
  const both = vmOf({ settings: settingsWith(bothLanes), host: hostUi({ tab: running('tab', { fallback: true }), mic: running('mic', { fallback: true }) }) });
  assert.deepEqual([both.lanes.tab.routeNote, both.lanes.mic.routeNote], ['ext.route.fallbackNote', 'ext.route.fallbackNote']);
});

test('rule 7: output and gap keys, only while the lane is live', () => {
  const output = (state) => vmOf({ host: hostUi({ tab: running('tab', { output: state }) }) }).lanes.tab.output;
  assert.equal(output('blocked'), 'ext.output.blocked');
  assert.equal(output('delayed'), 'sim.output.delayed');
  assert.equal(output('catching-up'), 'sim.output.catching_up');
  assert.equal(output('unavailable'), 'sim.output.unavailable');
  assert.equal(output('muted'), null);
  assert.equal(output('ready'), null);
  assert.equal(output(null), null);
  const reconnecting = vmOf({ host: hostUi({ tab: { phase: 'reconnecting', engineStatus: 'reconnecting', output: 'blocked', gap: 'audio' } }) });
  assert.equal(reconnecting.lanes.tab.output, null, 'output only while running');
  assert.equal(reconnecting.lanes.tab.gap, 'sim.gap.audio', 'gap while reconnecting');
  const gap = (kind) => vmOf({ host: hostUi({ tab: running('tab', { gap: kind }) }) }).lanes.tab.gap;
  assert.equal(gap('input'), 'ext.gap.input');
  assert.equal(gap('audio'), 'sim.gap.audio');
  assert.equal(gap('reception'), 'sim.gap.reception');
  assert.equal(gap(null), null);
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'starting', engineStatus: 'connecting', gap: 'input' } }) }).lanes.tab.gap, null);
});

test('rule 8: notice priority, keys and attention', () => {
  const both = settingsWith(bothLanes);
  const notice = (input, lane = 'tab') => vmOf(input).lanes[lane].notice;
  // a failed sw/lane-start beats the host's own error code
  assert.equal(notice({ localErrors: { tab: 'TAB_CAPTURE_BUSY', mic: null }, host: hostUi({ tab: failed('INVALID_KEY') }) }).key, 'ext.error.TAB_CAPTURE_BUSY');
  assert.deepEqual(notice({ host: hostUi({ tab: failed('CREDENTIAL_REQUIRED', { keyFailure: true }) }) }),
    { key: 'ext.error.CREDENTIAL_REQUIRED', params: {}, attention: 'options' });
  assert.equal(notice({ host: hostUi({ tab: failed('CREDENTIAL_MISMATCH', { keyFailure: true }) }) }).key, 'error.CREDENTIAL_MISMATCH');
  assert.equal(notice({ host: hostUi({ tab: failed('CREDENTIAL_MISMATCH', { keyFailure: true }) }) }).attention, 'options');
  assert.equal(notice({ host: hostUi({ tab: failed('NETWORK_ERROR') }) }).key, 'error.NETWORK_ERROR');
  assert.equal(notice({ host: hostUi({ tab: failed('WHATEVER_X') }) }).key, 'error.unknown');
  assert.equal(notice({ host: hostUi({ tab: failed('TAB_ENDED') }) }).attention, null);
  // LANE_STOPPING is a notice
  assert.equal(notice({ localErrors: { tab: 'LANE_STOPPING', mic: null } }).key, 'ext.error.LANE_STOPPING');
  // silent codes never become notices and never make the lane an error lane (NEEDS_ARM is the worker's "this tab was not
  // armed after all", which the controller answers with one more start through the share dialog; START_CANCELLED is also
  // what a closed share dialog comes back as)
  for (const code of ['ALREADY_RUNNING', 'START_CANCELLED', 'NEEDS_ARM']) {
    const vm = vmOf({ localErrors: { tab: code, mic: null } });
    assert.equal(vm.lanes.tab.notice, null, code);
    assert.equal(vm.lanes.tab.phase, 'off', code);
  }
  // the tab lane never says "microphone"
  for (const code of ['MICROPHONE_UNAVAILABLE', 'BROWSER_INTERRUPTED', 'MICROPHONE_DENIED']) {
    assert.equal(notice({ host: hostUi({ tab: failed(code) }) }).key, 'ext.error.TAB_INPUT_LOST', code);
  }
  assert.equal(notice({ settings: both, host: hostUi({ mic: failed('MICROPHONE_UNAVAILABLE') }) }, 'mic').key, 'ext.error.MICROPHONE_UNAVAILABLE');
  // one key problem is announced once, in the tab card
  const shared = vmOf({ settings: both, host: hostUi({ tab: failed('CREDENTIAL_REQUIRED'), mic: failed('CREDENTIAL_REQUIRED') }) });
  assert.equal(shared.lanes.tab.notice.key, 'ext.error.CREDENTIAL_REQUIRED');
  assert.equal(shared.lanes.mic.notice, null);
  const different = vmOf({ settings: both, host: hostUi({ tab: failed('INVALID_KEY'), mic: failed('PERMISSION_DENIED') }) });
  assert.equal(different.lanes.tab.notice.key, 'ext.error.INVALID_KEY');
  assert.equal(different.lanes.mic.notice.key, 'ext.error.PERMISSION_DENIED');
  // the microphone permission itself
  assert.deepEqual(notice({ settings: both, micPermission: 'denied' }, 'mic'),
    { key: 'ext.error.MICROPHONE_DENIED', params: {}, attention: 'permission' });
  assert.equal(notice({ settings: both, micPermission: 'denied', localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } }, 'mic').key, 'ext.error.MICROPHONE_DENIED');
  assert.equal(notice({ micPermission: 'denied' }, 'mic'), null, 'the lane is off: no permission notice');
  assert.equal(notice({ settings: both, micPermission: 'prompt' }, 'mic'), null, 'prompt alone is not an error');
  assert.equal(notice({ settings: both, micPermission: 'prompt', localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } }, 'mic').key,
    'ext.error.MICROPHONE_DENIED');
  const expired = notice({ settings: both, micPermission: 'prompt', micWasGranted: true, localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } }, 'mic');
  assert.deepEqual(expired, { key: 'ext.error.MICROPHONE_EXPIRED', params: {}, attention: 'permission' });
  assert.equal(notice({ settings: both, micPermission: 'denied', micWasGranted: true, localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } }, 'mic').key,
    'ext.error.MICROPHONE_DENIED', 'expired only for a one-time grant that fell back to prompt');
  // overlay unavailable: both lanes, only while running with captions on
  const captionsOn = settingsWith((s) => { bothLanes(s); s.lanes.mic.captions = true; });
  const overlay = (lane, extra) => notice({ settings: captionsOn, host: hostUi({ [lane]: running(lane, { captions: true, overlay: 'unavailable', ...extra }) }) }, lane);
  assert.equal(overlay('tab').key, 'ext.error.OVERLAY_UNAVAILABLE');
  assert.equal(overlay('mic').key, 'ext.error.OVERLAY_UNAVAILABLE');
  const noCaptions = vmOf({ settings: settingsWith((s) => { s.lanes.tab.captions = false; }), host: hostUi({ tab: running('tab', { overlay: 'unavailable' }) }) });
  assert.equal(noCaptions.lanes.tab.notice, null);
  assert.equal(notice({ host: hostUi({ tab: running('tab', { overlay: 'attached' }) }) }), null);
});

// 2026-09-30: the reason of an INVALID_RESULT, shown after the notice. Fails on v0.3.1 (no such field, no detail).
test('rule 8: the INVALID_RESULT notice carries the engine\'s reason as a detail; no other notice has one', () => {
  const notice = (input, lane = 'tab') => vmOf(input).lanes[lane].notice;
  assert.deepEqual(notice({ host: hostUi({ tab: failed('INVALID_RESULT', { errorReason: 'audio-encoding' }) }) }),
    { key: 'error.INVALID_RESULT', params: {}, attention: null, detail: 'INVALID_RESULT · audio-encoding' });
  // without a reason the notice is exactly what it was
  assert.deepEqual(notice({ host: hostUi({ tab: failed('INVALID_RESULT') }) }), { key: 'error.INVALID_RESULT', params: {}, attention: null });
  for (const code of ['NETWORK_ERROR', 'INVALID_KEY', 'TAB_ENDED']) assert.equal(Object.hasOwn(notice({ host: hostUi({ tab: failed(code) }) }), 'detail'), false, code);
  // a failed sw/lane-start outranks the host's error: its notice is not decorated with the host's reason
  const local = notice({ localErrors: { tab: 'TAB_CAPTURE_BUSY', mic: null }, host: hostUi({ tab: failed('INVALID_RESULT', { errorReason: 'audio-encoding' }) }) });
  assert.deepEqual(local, { key: 'ext.error.TAB_CAPTURE_BUSY', params: {}, attention: null });
  // per lane
  const both = vmOf({ settings: settingsWith(bothLanes), host: hostUi({ tab: failed('INVALID_RESULT', { errorReason: 'flag-shape' }), mic: failed('INVALID_RESULT') }) });
  assert.equal(both.lanes.tab.notice.detail, 'INVALID_RESULT · flag-shape');
  assert.equal(Object.hasOwn(both.lanes.mic.notice, 'detail'), false);
});

test('rule 8 without a dictionary: the default key test knows the extension and generic codes only', () => {
  const vm = buildViewModel({
    settings: createDefaultSettings('en'), keyPresent: true, host: hostUi({ tab: failed('INVALID_KEY') }), armed: false,
    targetTab: null, shortcut: null, micPermission: 'granted', micWasGranted: false, pending: { tab: false, mic: false },
    localErrors: { tab: null, mic: null }, stopReason: null, previews: { tab: null, mic: null },
  });
  assert.equal(vm.lanes.tab.notice.key, 'ext.error.INVALID_KEY');
  const unknown = buildViewModel({
    settings: createDefaultSettings('en'), keyPresent: true, host: hostUi({ tab: failed('FROM_THE_FUTURE') }), armed: false,
    targetTab: null, shortcut: null, micPermission: 'granted', micWasGranted: false, pending: { tab: false, mic: false },
    localErrors: { tab: null, mic: null }, stopReason: null, previews: { tab: null, mic: null },
  });
  assert.equal(unknown.lanes.tab.notice.key, 'error.unknown');
});

test('rule 9: the arm note splits needed (idle) / picking (the share dialog is open) / ready and carries hints only where they help', () => {
  const arm = (input) => vmOf(input).lanes.tab.armNote;
  // §20: idle and not armed: Start opens a Chrome window to choose the tab, and the toolbar icon starts this tab at once
  // (pin hint, and the shortcut when one is set).
  assert.deepEqual(arm({}), { key: 'ext.arm.needed', attention: false, hintKeys: ['ext.arm.pinHint'], shortcut: null });
  assert.equal(arm({ shortcut: 'Alt+Shift+Y' }).shortcut, 'Alt+Shift+Y');
  assert.equal(arm({ shortcut: '' }).shortcut, null, 'an empty shortcut is unassigned');
  assert.deepEqual(arm({ armed: true, shortcut: 'Alt+Shift+Y' }), { key: 'ext.arm.ready', attention: false, hintKeys: [], shortcut: null });
  // Start pressed on an un-armed tab opens Chrome's share dialog at once. The note says what to do in it and, from the
  // first second, that the toolbar icon on the tab starts it without the dialog (with the shortcut when one is set).
  // Once the dialog has been open ~8 s (the controller sets `pickSlow`) it adds where to look when the window is not in sight.
  const picking = { pending: { tab: true, mic: false }, picking: true };
  assert.deepEqual(arm({ ...picking, shortcut: 'Alt+Shift+Y' }),
    { key: 'ext.arm.picking', attention: true, hintKeys: ['ext.arm.pickSlow'], shortcut: 'Alt+Shift+Y' });
  assert.deepEqual(arm(picking), { key: 'ext.arm.picking', attention: true, hintKeys: ['ext.arm.pickSlow'], shortcut: null }, 'no shortcut set: none claimed');
  assert.equal(arm({ ...picking, shortcut: '' }).shortcut, null);
  // ... and where the icon is (the puzzle menu): the note names the icon "at the top right", which is hidden for a user who
  // has not pinned it, and the idle note's pin hint is not on screen any more while the dialog is open.
  assert.deepEqual(arm({ ...picking, pickSlow: true, shortcut: 'Alt+Shift+Y' }),
    { key: 'ext.arm.picking', attention: true, hintKeys: ['ext.arm.pickSlow', 'ext.arm.pickLost', 'ext.arm.pinHint'], shortcut: 'Alt+Shift+Y' });
  assert.deepEqual(arm({ ...picking, pickSlow: false }).hintKeys, ['ext.arm.pickSlow'], 'only `true` adds the lost-window and pin lines');
  // `pickSlow` alone says nothing: the hints belong to the open dialog only
  assert.equal(arm({ pickSlow: true }).key, 'ext.arm.needed');
  assert.deepEqual(arm({ pickSlow: true }).hintKeys, ['ext.arm.pinHint']);
  // The host holds the dialog open as `starting` without an engine: the panel says "choose the tab".
  const choosing = { pending: { tab: true, mic: false }, picking: true, host: hostUi({ tab: { phase: 'starting', engineStatus: null } }) };
  assert.equal(arm(choosing).key, 'ext.arm.picking');
  assert.equal(vmOf(choosing).lanes.tab.phase, 'awaiting');
  assert.deepEqual(vmOf(choosing).lanes.tab.status, { key: 'ext.status.choosingTab', params: {} });
  assert.deepEqual(vmOf(choosing).pill, { state: 'warning', key: 'ext.status.choosingTab', params: {} });
  assert.deepEqual(vmOf(choosing).primary, { mode: 'stop', key: 'common.cancel', disabled: false });
  // Once the engine exists the choice was made: an ordinary start.
  for (const engineStatus of ['preparing', 'connecting']) {
    const chosen = vmOf({ ...picking, host: hostUi({ tab: { phase: 'starting', engineStatus, tabId: 9 } }) });
    assert.equal(chosen.lanes.tab.phase, 'starting', engineStatus);
    assert.equal(chosen.lanes.tab.armNote, null, engineStatus);
    assert.equal(chosen.primary.key, 'common.stop', engineStatus);
  }
  // The HOST decides once it reports, so every panel reads the same, whatever tab is active or armed NOW (the user may
  // switch tabs while the dialog is open, and a second or reopened panel has no start of its own in flight).
  for (const input of [{ ...choosing, armed: true }, { host: choosing.host }, { host: choosing.host, armed: true }]) {
    assert.equal(vmOf(input).lanes.tab.phase, 'awaiting');
    assert.deepEqual(arm(input), { key: 'ext.arm.picking', attention: true, hintKeys: ['ext.arm.pickSlow'], shortcut: null });
  }
  // A stream-id start (an armed tab) names its tab from the first state: never "choosing".
  const minted = hostUi({ tab: { phase: 'starting', engineStatus: null, tabId: 7 } });
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true, host: minted }).lanes.tab.phase, 'starting');
  assert.equal(vmOf({ host: minted }).lanes.tab.phase, 'starting');
  // §20: a start in flight that is not the dialog (an armed tab; the worker may still answer NEEDS_ARM, which the
  // controller answers with a start through the dialog) is a start, with no note.
  assert.equal(vmOf({ pending: { tab: true, mic: false } }).lanes.tab.phase, 'starting');
  assert.equal(arm({ pending: { tab: true, mic: false } }), null);
  // The share came without audio: the notice says what to do, the arm note stays out of its way.
  const noAudio = vmOf({ localErrors: { tab: 'TAB_SHARE_NO_AUDIO', mic: null } });
  assert.equal(noAudio.lanes.tab.notice.key, 'ext.error.TAB_SHARE_NO_AUDIO');
  assert.equal(noAudio.lanes.tab.armNote, null);
  // NEEDS_ARM is never a notice (the controller retries once through the share dialog, silently)
  assert.equal(vmOf({ localErrors: { tab: 'NEEDS_ARM', mic: null } }).lanes.tab.notice, null);
  assert.equal(arm({ targetTab: { id: 7, title: 'x', capturable: false }, armed: true }).key, 'ext.error.TAB_UNSUPPORTED');
  assert.equal(arm({ targetTab: { id: 7, title: 'x', capturable: false } }).attention, false);
  // R3: the open dialog is named first: while it is open the pill and Cancel say "waiting", and the panel's active tab may
  // become a chrome:// page meanwhile; the note must not flip to "cannot be captured" next to them. Idle, the page is named.
  const cannot = { id: 7, title: 'x', capturable: false };
  assert.equal(arm({ targetTab: cannot, ...picking }).key, 'ext.arm.picking', 'the open dialog is named before the page check');
  assert.deepEqual(arm({ targetTab: cannot, ...picking, pickSlow: true }).hintKeys, ['ext.arm.pickSlow', 'ext.arm.pickLost', 'ext.arm.pinHint']);
  assert.equal(arm({ targetTab: cannot, host: choosing.host, pending: { tab: false, mic: false } }).key, 'ext.arm.picking', 'the host holds the dialog: same');
  assert.equal(arm({ targetTab: cannot }).key, 'ext.error.TAB_UNSUPPORTED', 'no dialog: the page that cannot be captured is named');
  assert.equal(arm({ targetTab: null }).key, 'ext.arm.needed', 'no target tab known');
  // null while the lane is under way
  for (const phase of ['starting', 'running', 'reconnecting']) assert.equal(arm({ armed: true, host: hostUi({ tab: { phase, tabId: 7 } }) }), null, phase);
  assert.equal(arm({ pending: { tab: true, mic: false }, armed: true }), null, 'starting in flight');
  // a lane the user turned off has nothing to arm
  assert.equal(arm({ settings: settingsWith((s) => { s.lanes.tab.enabled = false; }) }), null);
  // An error that asks for a fresh start has ITS OWN notice, which says so. The arm note is then null: it used to repeat
  // the instruction (and the pin hint) or, when the record survived, say "ready" next to it.
  const ended = vmOf({ armed: true, host: hostUi({ tab: failed('TAB_ENDED') }) });
  assert.equal(ended.lanes.tab.armNote, null);
  assert.equal(ended.lanes.tab.phase, 'error');
  assert.equal(ended.lanes.tab.notice.key, 'ext.error.TAB_ENDED');
  for (const code of ['MICROPHONE_UNAVAILABLE', 'BROWSER_INTERRUPTED', 'MICROPHONE_DENIED', 'TAB_INPUT_LOST', 'TAB_ENDED', 'TAB_GONE', 'TAB_UNSUPPORTED']) {
    for (const armed of [true, false]) {
      const vm = vmOf({ armed, host: hostUi({ tab: failed(code) }) });
      assert.equal(vm.lanes.tab.armNote, null, `${code} armed=${armed}: the notice speaks, the arm note does not`);
      assert.notEqual(vm.lanes.tab.notice, null, `${code}: the notice is there`);
    }
  }
  // Errors that do not ask for a click keep the arm note: the tab really is ready (or not) whatever else went wrong.
  assert.equal(vmOf({ armed: true, host: hostUi({ tab: failed('INVALID_KEY') }) }).lanes.tab.armNote.key, 'ext.arm.ready');
  assert.equal(vmOf({ host: hostUi({ tab: failed('TAB_CAPTURE_BUSY') }) }).lanes.tab.armNote.key, 'ext.arm.needed');
  // After the user presses Start again on an un-armed tab the dialog is open: that is not an error any more, the
  // picking note is there and the old notice is gone.
  const retry = vmOf({ ...picking, host: hostUi({ tab: failed('TAB_INPUT_LOST') }) });
  assert.equal(retry.lanes.tab.phase, 'awaiting');
  assert.equal(retry.lanes.tab.armNote.key, 'ext.arm.picking');
  assert.equal(retry.lanes.tab.notice, null);
});

test('rule 9b: an unsupported page is said ONCE (the arm note); a stale local TAB_UNSUPPORTED never repeats it as an alert', () => {
  const unsupported = { id: 7, title: 'Extensions', capturable: false };
  const vm = vmOf({ targetTab: unsupported, localErrors: { tab: 'TAB_UNSUPPORTED', mic: null } });
  assert.equal(vm.lanes.tab.armNote.key, 'ext.error.TAB_UNSUPPORTED');
  assert.equal(vm.lanes.tab.notice, null, 'the same sentence is not also an alert');
  assert.equal(vm.lanes.tab.phase, 'off', 'the recorded refusal does not turn the lane, the status line or the pill into a failure');
  assert.equal(vm.pill.state, 'idle');
  assert.equal(vm.lanes.tab.status.key, 'sim.status.idle');
  // The same code from a page the panel believes is capturable (the worker refused it, e.g. a store page) is an alert
  // and, because the alert already says it, no arm note repeats or contradicts it.
  const refused = vmOf({ armed: true, localErrors: { tab: 'TAB_UNSUPPORTED', mic: null } });
  assert.equal(refused.lanes.tab.notice.key, 'ext.error.TAB_UNSUPPORTED');
  assert.equal(refused.lanes.tab.armNote, null);
});

test('rule 10: the tab line shows the captured tab title while the tab lane is under way', () => {
  const line = (input) => vmOf(input).lanes.tab.tabline;
  assert.deepEqual(line({ host: hostUi({ tab: running('tab') }), capturedTitle: 'Standup notes' }), { title: 'Standup notes' });
  assert.equal(line({ host: hostUi({ tab: running('tab') }), capturedTitle: null }), null);
  assert.equal(line({ capturedTitle: 'Standup notes' }), null, 'lane off');
  assert.equal(line({ host: hostUi({ tab: running('tab') }), capturedTitle: 'あ'.repeat(90) }).title.length, 60, 'bounded to 60 characters');
  assert.equal(vmOf().lanes.mic.tabline, undefined, 'tab lane only');
});

test('rules 11 and 12: mute labels, echo note and the two-sessions note', () => {
  // §20: the voice plays by default, so a fresh panel shows the "turn it off" button and no mute note.
  assert.deepEqual(vmOf().mute, { muted: false, labelKey: 'ext.sound.off', noteVisible: false });
  const muted = vmOf({ settings: settingsWith((s) => { s.speechMuted = true; }) });
  assert.deepEqual(muted.mute, { muted: true, labelKey: 'ext.sound.on', noteVisible: true });
  assert.equal(muted.echoNote, false);
  const none = vmOf({ settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.speechMuted = true; }) });
  assert.equal(none.mute.noteVisible, false, 'no lane enabled: no mute note');
  const speaking = vmOf({ settings: settingsWith((s) => { s.speechMuted = false; s.lanes.mic.enabled = true; }) });
  assert.deepEqual(speaking.mute, { muted: false, labelKey: 'ext.sound.off', noteVisible: false });
  assert.equal(speaking.echoNote, true);
  assert.equal(vmOf({ settings: settingsWith((s) => { s.speechMuted = false; }) }).echoNote, false, 'microphone lane off');
  assert.equal(vmOf({ settings: settingsWith((s) => { s.speechMuted = true; s.lanes.mic.enabled = true; }) }).echoNote, false);

  const both = settingsWith(bothLanes);
  assert.deepEqual(vmOf().usageNote, { visible: false, emphasis: false });
  assert.deepEqual(vmOf({ settings: both }).usageNote, { visible: true, emphasis: false });
  for (const code of ['RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429', 'SESSION_LIMIT', 'BUDGET_EXHAUSTED']) {
    assert.equal(vmOf({ settings: both, host: hostUi({ mic: failed(code) }) }).usageNote.emphasis, true, code);
  }
  assert.equal(vmOf({ settings: both, host: hostUi({ mic: failed('INVALID_KEY') }) }).usageNote.emphasis, false);
  const single = vmOf({ host: hostUi({ tab: failed('RATE_LIMITED') }) });
  assert.deepEqual(single.usageNote, { visible: false, emphasis: false }, 'one lane on: the note is not about two sessions');
});

test('rule 13: applyNext is per lane and needs a known difference', () => {
  const both = settingsWith((s) => { bothLanes(s); s.lanes.tab.targetLanguage = 'en'; s.lanes.mic.targetLanguage = 'ko'; });
  const vm = vmOf({ settings: both, host: hostUi({
    tab: running('tab', { targetLanguage: 'ko' }), mic: running('mic', { targetLanguage: 'ko', model: both.lanes.mic.model }),
  }) });
  assert.equal(vm.lanes.tab.applyNext, true);
  assert.equal(vm.lanes.mic.applyNext, false);
  // model differs and no fallback: apply next; with a fallback the difference is expected
  const model = vmOf({ host: hostUi({ tab: running('tab', { targetLanguage: 'en', model: TRANSLATE_LIVE_MODEL }) }) });
  assert.equal(model.lanes.tab.applyNext, true, 'the settings model is the latest Live model (the default), the run uses another one');
  const fallback = vmOf({ host: hostUi({ tab: running('tab', { targetLanguage: 'en', model: TRANSLATE_LIVE_MODEL, fallback: true }) }) });
  assert.equal(fallback.lanes.tab.applyNext, false);
  // unknown host values and idle lanes never claim a pending change
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'starting', engineStatus: null, targetLanguage: null, model: null } }) }).lanes.tab.applyNext, false);
  assert.equal(vmOf({ settings: both, host: hostUi({ tab: { phase: 'off', targetLanguage: 'ja' } }) }).lanes.tab.applyNext, false);
  assert.equal(vmOf({ settings: both }).lanes.tab.applyNext, false);
});

// Two-way mode (the panel side). The host reports the model it REALLY runs (a pair moves a translation-only model to the
// first instruction-driven one) and only the first language, so the panel remembers what it started the lane with.
const twoWaySettings = (mutate = () => {}) => settingsWith((s) => {
  bothLanes(s);
  // 0.5.1: the tab lane's DEFAULT is the latest Live model (no model note); the note is about the translation-only
  // model, which a user can still choose, so the fixture chooses it.
  s.lanes.tab.model = TRANSLATE_LIVE_MODEL;
  s.lanes.tab.targetLanguage = 'en'; s.lanes.tab.twoWay = true; s.lanes.tab.partnerLanguage = 'ja';
  s.lanes.mic.targetLanguage = 'ko'; s.lanes.mic.twoWay = true; s.lanes.mic.partnerLanguage = 'en';
  mutate(s);
});

test('two-way: the lane view model carries the choice, the partner options without the first language, the label key and the model note', () => {
  const off = vmOf({ settings: settingsWith(bothLanes) });
  for (const lane of ['tab', 'mic']) {
    assert.equal(off.lanes[lane].twoWay, false, `${lane} starts one-way`);
    assert.equal(off.lanes[lane].targetLabelKey, 'language.target');
    assert.equal(off.lanes[lane].modelNote, false);
  }
  assert.deepEqual(off.lanes.tab.partnerOptions, ['ko', 'ja'], 'every language but the target (en)');

  const on = vmOf({ settings: twoWaySettings() });
  assert.equal(on.lanes.tab.twoWay, true);
  assert.equal(on.lanes.tab.partnerLanguage, 'ja');
  assert.deepEqual(on.lanes.tab.partnerOptions, ['ko', 'ja']);
  assert.equal(on.lanes.tab.targetLabelKey, 'ext.twoWay.targetLabel', 'the first select is "First language" while two-way is on');
  assert.equal(on.lanes.mic.partnerLanguage, 'en');
  assert.deepEqual(on.lanes.mic.partnerOptions, ['en', 'ja'], 'the mic target is ko');
  assert.ok(has(on.lanes.tab.targetLabelKey) && has('ext.twoWay.targetLabel'), 'the label key exists in the dictionary');

  // The model note: two-way AND the translation-only model (twoWaySettings puts the tab lane on it; the microphone lane is not).
  assert.equal(on.lanes.tab.modelNote, true);
  assert.equal(on.lanes.mic.modelNote, false, 'the microphone lane already uses the instruction-driven model');
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.model = DEFAULT_LIVE_MODEL; }) }).lanes.tab.modelNote, false);
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.mic.model = TRANSLATE_LIVE_MODEL; }) }).lanes.mic.modelNote, true);
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.twoWay = false; }) }).lanes.tab.modelNote, false, 'one-way on the translation model: no note');
  assert.ok(isDeepFrozen(on.lanes.tab.partnerOptions));
});

test('two-way model note: hidden while the lane runs or reconnects on a backup model, so it never contradicts the route line', () => {
  const settings = twoWaySettings();   // the tab lane is two-way on the translation-only model: the note is due
  const backup = 'gemini-2.5-flash-native-audio-latest';
  const onBackup = running('tab', { targetLanguage: 'en', model: backup, route: 'flash', fallback: true });
  const vm = vmOf({ settings, host: hostUi({ tab: onBackup }) });
  assert.deepEqual([vm.lanes.tab.route.textKey, vm.lanes.tab.route.model], ['ext.route.fallback', backup]);
  assert.equal(vm.lanes.tab.modelNote, false, 'the route line names the backup model; the note would name Gemini 3.8 Live');
  const reconnecting = { phase: 'reconnecting', engineStatus: 'reconnecting', targetLanguage: 'en', model: backup, route: 'flash', fallback: true };
  assert.equal(vmOf({ settings, host: hostUi({ tab: reconnecting }) }).lanes.tab.modelNote, false);
  // On the pair model itself (no fallback) the note is true; so it is for a lane that is not running (the next start
  // uses Gemini 3.8 Live again), and for the other lane, which does not run on this lane's backup model.
  assert.equal(vmOf({ settings, host: hostUi({ tab: running('tab', { targetLanguage: 'en', model: PAIR_MODEL }) }) }).lanes.tab.modelNote, true);
  assert.equal(vmOf({ settings, host: hostUi({ tab: { ...reconnecting, fallback: false, model: PAIR_MODEL } }) }).lanes.tab.modelNote, true);
  assert.equal(vmOf({ settings, host: hostUi({ tab: failed('BUDGET_EXHAUSTED', { model: backup, fallback: true }) }) }).lanes.tab.modelNote, true);
  assert.equal(vmOf({ settings, host: hostUi({ tab: { phase: 'off', model: backup, fallback: true } }) }).lanes.tab.modelNote, true);
  const both = twoWaySettings((s) => { s.lanes.mic.model = TRANSLATE_LIVE_MODEL; });
  assert.equal(vmOf({ settings: both, host: hostUi({ tab: onBackup }) }).lanes.mic.modelNote, true);
});

// §24 (0.5.2): the default model follows the latest general Live model, so a lane that runs a NEWER general Live model than the
// default is running what the setting says.
test('rule 13 and the latest model: a lane on the default setting that runs a newer general Live model has no pending change; every other difference still has', () => {
  const NEWER = 'gemini-3.9-live';
  const applyNext = (settingModel, runningModel, extra = {}) => vmOf({ settings: settingsWith((s) => { s.lanes.tab.model = settingModel; s.lanes.tab.targetLanguage = 'en'; }),
    host: hostUi({ tab: running('tab', { targetLanguage: 'en', model: runningModel, ...extra }) }) }).lanes.tab.applyNext;
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, DEFAULT_LIVE_MODEL), false, 'the default itself');
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, NEWER), false, 'the default setting runs the newer model it follows');
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, 'gemini-4.0-live'), false);
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, 'gemini-3.7-live'), true, 'an OLDER model is not what the default follows');
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, TRANSLATE_LIVE_MODEL), true, 'a model the setting does not say');
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, 'gemini-3.9-live-preview'), true, 'a preview is not a general Live model');
  assert.equal(applyNext(TRANSLATE_LIVE_MODEL, NEWER), true, 'a setting that is not the default is never "following"');
  assert.equal(applyNext(TRANSLATE_LIVE_MODEL, TRANSLATE_LIVE_MODEL), false);
  assert.equal(applyNext(DEFAULT_LIVE_MODEL, TRANSLATE_LIVE_MODEL, { fallback: true }), false, 'a backup model is expected (unchanged)');
});

test('two-way: the two model ids the panel pins (it may not import live-config) are the ones the engine uses for a pair', async () => {
  assert.equal(TRANSLATION_ONLY_MODEL, TRANSLATE_LIVE_MODEL);
  // The rule of app/engine/sim.js: a pair on a translation-route model moves to the first model that is not one.
  assert.equal(PAIR_MODEL, LIVE_MODELS.find((model) => liveRoute(model) !== 'translation'));
  assert.equal(PAIR_MODEL, DEFAULT_LIVE_MODEL);
  assert.deepEqual(LIVE_MODELS.filter((model) => liveRoute(model) === 'translation'), [TRANSLATION_ONLY_MODEL],
    'a second translation-only model would need the panel note and the applies-next rule to know about it');
  // No file of the panel names an app module but the i18n index (build-extension.mjs AREA_APP.panel).
  const imports = [];
  for (const file of ['controller', 'view-model', 'host-link', 'panel']) {
    const source = await readText(`extension/panel/${file}.js`);
    imports.push(...[...source.matchAll(/from '(\.\.\/\.\.\/app\/[^']+)'/g)].map((match) => match[1]));
  }
  assert.deepEqual(imports, ['../../app/i18n/index.js']);
});

test('two-way rule 13: a two-way run reports the swapped model without a false "applies next", and a changed pair or mode is one', () => {
  const started = { twoWay: true, partnerLanguage: 'ja' };
  // Settings say translation-only + two-way; the host reports the model the engine really used.
  const swapped = running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' });
  const state = (extra = {}) => ({ host: hostUi({ tab: swapped }), runWith: { tab: started, mic: null }, ...extra });
  assert.equal(vmOf({ settings: twoWaySettings(), ...state() }).lanes.tab.applyNext, false, 'the swap is not a pending change');
  // Without the fix the raw setting (translation model) would differ from the reported one for the whole run.
  assert.notEqual(twoWaySettings().lanes.tab.model, DEFAULT_LIVE_MODEL);

  // The partner changed while running.
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.partnerLanguage = 'ko'; }), ...state() }).lanes.tab.applyNext, true);
  // Two-way switched off while a two-way lane runs: settings model is the translation one, the run's is not.
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.twoWay = false; }), ...state() }).lanes.tab.applyNext, true);
  // Two-way switched on while a one-way lane runs (the model differs as well, but the mode alone is enough).
  const oneWay = running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' });
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.model = DEFAULT_LIVE_MODEL; }),
    host: hostUi({ tab: oneWay }), runWith: { tab: { twoWay: false, partnerLanguage: 'ko' }, mic: null } }).lanes.tab.applyNext, true);
  // The partner is irrelevant while both the run and the settings are one-way.
  assert.equal(vmOf({ settings: settingsWith((s) => { s.lanes.tab.model = DEFAULT_LIVE_MODEL; s.lanes.tab.partnerLanguage = 'ja'; }),
    host: hostUi({ tab: oneWay }), runWith: { tab: { twoWay: false, partnerLanguage: 'ko' }, mic: null } }).lanes.tab.applyNext, false);
  // Nothing is known about how the lane was started: no claim (like an unknown host value).
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.partnerLanguage = 'ko'; }), host: hostUi({ tab: swapped }) }).lanes.tab.applyNext, false);
  // A backup model is expected to differ, and an idle lane never claims a change.
  assert.equal(vmOf({ settings: twoWaySettings(), host: hostUi({ tab: { ...swapped, fallback: true } }), runWith: { tab: started, mic: null } }).lanes.tab.applyNext, false);
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.tab.partnerLanguage = 'ko'; }), runWith: { tab: started, mic: null } }).lanes.tab.applyNext, false);
  // The record belongs to its lane: the microphone lane's is not read for the tab lane.
  assert.equal(vmOf({ settings: twoWaySettings(), host: hostUi({ tab: swapped }), runWith: { tab: null, mic: { twoWay: false, partnerLanguage: 'en' } } }).lanes.tab.applyNext, false);
  // A two-way microphone lane on the instruction-driven model needs no swap either.
  const micRun = running('mic', { targetLanguage: 'ko', model: DEFAULT_LIVE_MODEL, route: 'flash' });
  assert.equal(vmOf({ settings: twoWaySettings(), host: hostUi({ mic: micRun }), runWith: { tab: null, mic: { twoWay: true, partnerLanguage: 'en' } } }).lanes.mic.applyNext, false);
  assert.equal(vmOf({ settings: twoWaySettings((s) => { s.lanes.mic.partnerLanguage = 'ja'; }), host: hostUi({ mic: micRun }),
    runWith: { tab: null, mic: { twoWay: true, partnerLanguage: 'en' } } }).lanes.mic.applyNext, true);
});

test('rule 14: the microphone permission line, its buttons and the attention flag', () => {
  const both = settingsWith(bothLanes);
  const permission = (input) => vmOf(input).micPermission;
  assert.deepEqual(permission({ micPermission: 'granted' }),
    { state: 'granted', textKeys: ['permission.title', 'permission.granted'], attention: false, allowButton: false });
  assert.deepEqual(permission({ micPermission: 'denied' }).textKeys, ['permission.title', 'permission.denied']);
  assert.deepEqual(permission({ micPermission: 'prompt' }).textKeys, ['permission.title', 'permission.prompt']);
  assert.deepEqual(permission({ micPermission: 'unknown' }).textKeys, ['permission.checking']);
  assert.deepEqual(permission({ micPermission: 'surprise' }).textKeys, ['permission.checking']);
  assert.equal(permission({ micPermission: 'unknown' }).allowButton, true);
  assert.equal(permission({ micPermission: 'denied' }).attention, false, 'idle: nothing asked for it');
  assert.equal(permission({ micPermission: 'denied', settings: both, pending: { tab: false, mic: true } }).attention, true);
  assert.equal(permission({ micPermission: 'prompt', settings: both, localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } }).attention, true);
  assert.equal(permission({ micPermission: 'denied', pending: { tab: false, mic: true } }).attention, false, 'lane off');
  assert.equal(permission({ micPermission: 'granted', settings: both, host: hostUi({ mic: failed('MICROPHONE_DENIED') }) }).attention, true,
    'the host reported the denial itself');
  assert.equal(permission({ micPermission: 'granted', settings: both, pending: { tab: false, mic: true } }).attention, false);
});

test('rule 15: the level meter is shown for running and reconnecting lanes only', () => {
  const level = (phase, extra = {}) => { const { lanes } = vmOf({ host: hostUi({ tab: { phase, engineStatus: phase, level: 42, ...extra } }) }); return [lanes.tab.levelVisible, lanes.tab.level]; };
  assert.deepEqual(level('running'), [true, 42]);
  assert.deepEqual(level('reconnecting'), [true, 42]);
  assert.deepEqual(level('starting', { engineStatus: 'connecting' }), [false, 0]);
  assert.deepEqual(level('stopping'), [false, 0]);
  assert.deepEqual([vmOf().lanes.tab.levelVisible, vmOf().lanes.tab.level], [false, 0]);
});

test('rule 16: the preview keeps the last four rows and only the documented fields', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `t${index}`, role: 'translation', status: index === 5 ? 'partial' : 'final', text: `row ${index}`, skipped: index === 2, extra: 'dropped',
  }));
  const frame = { v: 1, type: 'captions', epoch: 1, seq: 1, lane: 'tab', lang: 'ko', rows, gaps: { input: false, audio: false, reception: false }, live: true };
  const { preview } = vmOf({ host: hostUi({ tab: running('tab') }), previews: { tab: frame, mic: null } }).lanes.tab;
  assert.deepEqual(preview.map((row) => row.id), ['t2', 't3', 't4', 't5']);
  assert.deepEqual(Object.keys(preview[0]), ['id', 'role', 'status', 'text', 'skipped']);
  assert.equal(preview[0].skipped, true, 'skipped rows stay in the panel');
  assert.deepEqual(vmOf({ previews: { tab: frame, mic: null } }).lanes.tab.preview, [], 'lane off without an error: empty');
  assert.equal(vmOf({ host: hostUi({ tab: failed('TAB_CAPTURE_BUSY') }), previews: { tab: frame, mic: null } }).lanes.tab.preview.length, 4, 'an error lane keeps its rows');
  assert.deepEqual(vmOf({ host: hostUi({ tab: running('tab') }) }).lanes.tab.preview, []);
});

test('rule 17: stop note keys, close note and the frozen, language-tagged result', () => {
  assert.equal(vmOf({ stopReason: 'panel-gone' }).stopNote, 'ext.notice.panelGone');
  assert.equal(vmOf({ stopReason: 'host-lost' }).stopNote, 'ext.notice.hostLost');
  assert.equal(vmOf({ stopReason: 'initial-grace' }).stopNote, null);
  assert.equal(vmOf({ stopReason: null }).stopNote, null);
  assert.equal(vmOf().closeNote, false);
  for (const phase of ['starting', 'running', 'reconnecting', 'stopping']) assert.equal(vmOf({ host: hostUi({ tab: { phase, tabId: 7 } }) }).closeNote, true, phase);
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'starting', engineStatus: null } }) }).closeNote, false, '§19: nothing is interpreted while the tab is being chosen');
  assert.equal(vmOf({ host: hostUi({ tab: failed('INVALID_KEY') }) }).closeNote, false);
  const vm = vmOf({ language: 'ja', host: hostUi({ tab: running('tab') }), settings: settingsWith(bothLanes) });
  assert.equal(vm.language, 'ja');
  assert.ok(isDeepFrozen(vm), 'the view model is deeply frozen');
});

// =============================================================================================
// Part 2: the controller against the parsed real panel.html
// =============================================================================================

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const armedRecord = (ids = [7], at = 0) => ({ v: 1, tabs: Object.fromEntries(ids.map((id) => [String(id), { windowId: 1, origin: 'https://example.com', at }])) });
const hostRecord = (up = true) => ({ v: 1, up, hostId: up ? 'h-test' : null, at: 0 });
// #tab-status and #mic-status are not here: they are plain text now (the pill and the notices announce the change).
const LIVE_REGIONS = ['status-pill', 'key-missing', 'stop-note', 'tab-apply-next', 'tab-arm-note', 'tab-route-note', 'tab-output', 'tab-gap',
  'tab-notice', 'mic-apply-next', 'mic-permission-status', 'mic-route-note', 'mic-output', 'mic-gap', 'mic-notice', 'no-lane-note',
  'mute-note', 'echo-note', 'usage-note'];

function changedPaths(before, after, prefix = '') {
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}

/**
 * One panel, wired to the fake browser. The stub service worker records every request and answers through `handler`;
 * the fake host context accepts panel ports and lets the test play the host's side of them.
 */
async function harness(t, options = {}) {
  const {
    settings, key = true, micPermission = 'granted', permissionsMode = null, languages = ['en-US'], hostUp = false, armed = false,
    lastStop = null, shortcut = 'Alt+Shift+Y', loadI18n = defaultLoad, tabUrl = 'https://example.com/a', begin = true,
    fetch = null, manifestVersion = null, updater = null, media = null,
  } = options;
  let handler = options.handler ?? (() => ({ ok: true }));
  const browser = createFakeBrowser({ shortcut });
  browser.addTab({ id: 7, url: tabUrl, windowId: 1, active: true, title: 'Example page' });
  const stub = browser.createContext('permission');
  const hostContext = browser.createContext('offscreen');
  const panel = browser.createContext('panel', { windowId: 1 });
  const document = parseHtml(PANEL_HTML);
  const audio = createFakeAudioEnv({ browser, micPermission });
  if (permissionsMode) audio.setPermissionsMode(permissionsMode);
  const navigator = audio.env.navigator;
  navigator.languages = languages;

  const requests = [];
  stub.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    requests.push(message);
    Promise.resolve(handler(message)).then((response) => sendResponse(response));
    return true;
  });
  const ports = [];
  hostContext.chrome.runtime.onConnect.addListener((port) => {
    const record = { port, name: port.name, received: [], disconnected: false };
    port.onMessage.addListener((message) => record.received.push(message));
    port.onDisconnect.addListener(() => { record.disconnected = true; });
    ports.push(record);
  });
  const localSets = [];
  const rawSet = panel.chrome.storage.local.set;
  const fail = { writes: false };
  panel.chrome.storage.local.set = async (items) => {
    if (fail.writes) throw new Error('storage is full');
    localSets.push({ at: browser.clock.now(), items: JSON.parse(JSON.stringify(items)) });
    return rawSet(items);
  };

  const seed = { [KEYS.settings]: settings, [KEYS.key]: key ? { v: 1, value: FAKE_KEY } : undefined };
  for (const [name, value] of Object.entries(seed)) if (value !== undefined) await stub.chrome.storage.local.set({ [name]: value });
  if (armed) await stub.chrome.storage.session.set({ [KEYS.armed]: armedRecord() });
  if (hostUp) await stub.chrome.storage.session.set({ [KEYS.host]: hostRecord(true) });
  if (lastStop) await stub.chrome.storage.session.set({ [KEYS.lastStop]: lastStop });

  // §16: the fake runtime has no manifest or reload of its own; a test that needs them passes a version.
  const reloads = [];
  const opened = [];
  if (manifestVersion !== null) panel.chrome.runtime.getManifest = () => ({ version: manifestVersion });
  panel.chrome.runtime.reload = () => { reloads.push(browser.clock.now()); };
  const rawCreate = panel.chrome.tabs.create;
  panel.chrome.tabs.create = async (properties) => { opened.push(properties?.url); return rawCreate(properties); };

  const i18n = { current: createFallbackI18n() };
  const controller = createPanelController({
    document, adapter: createChromeAdapter(panel.chrome), i18n, loadI18n,
    timers: { setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout, now: browser.clock.now },
    navigator, fetch, updater, ...(media === null ? {} : { media }),
  });
  t.after(() => controller.dispose());

  const h = {
    browser, document, controller, requests, ports, localSets, audio, i18n, stub, panel, reloads, opened,
    setHandler(next) { handler = next; },
    failWrites(value) { fail.writes = value; },
    el: (id) => document.getElementById(id),
    text: (id) => document.getElementById(id).textContent,
    attr: (id, name) => document.getElementById(id).getAttribute(name),
    async flush(rounds = 6) { for (let index = 0; index < rounds; index += 1) await browser.settle(); },
    async advance(ms) { await browser.clock.advance(ms); await h.flush(); },
    async fire(id, type = 'change') { h.el(id).dispatchEvent(new FakeEvent(type, { bubbles: true })); await h.flush(); },
    async click(id) { h.el(id).click(); await h.flush(); },
    async choose(id, value) { h.el(id).value = value; await h.fire(id, 'change'); },
    async setSession(name, value) { await stub.chrome.storage.session.set({ [name]: value }); await h.flush(); },
    async removeSession(name) { await stub.chrome.storage.session.remove(name); await h.flush(); },
    async patchSettings(mutate) {
      const stored = (await stub.chrome.storage.local.get(KEYS.settings))[KEYS.settings];
      const next = JSON.parse(JSON.stringify(normalizeSettings(stored)));
      mutate(next);
      await stub.chrome.storage.local.set({ [KEYS.settings]: next });
      await h.flush();
    },
    stored: () => browser.storageData('local')[KEYS.settings],
    types: () => requests.map((request) => request.type),
    host: () => ports.at(-1),
    async post(frame) { h.host().port.postMessage(frame); await h.flush(); },
    async postState(lanes, speechMuted = true) { await h.post(stateFrame(lanes, speechMuted)); },
    async start() { await controller.start(); await h.flush(); },
  };
  if (begin) await h.start();
  return h;
}

// The state frame as a host would send it: {v, type:'state', state}.
const stateFrame = (lanes, speechMuted = true) => makeFrame('state', { state: hostUi({ ...lanes, speechMuted }) });
const captionsFrame = (lane, rows, epoch = 1) => makeFrame('captions', {
  epoch, seq: 1, lane, lang: 'ko', rows, gaps: { input: false, audio: false, reception: false }, live: true,
});
const captionRow = (id, text, extra = {}) => ({ id, role: 'translation', status: 'final', text, skipped: false, ...extra });

test('every id the controller touches and every id of section 1.5 exists in the parsed panel.html', async (t) => {
  const document = parseHtml(PANEL_HTML);
  const ids = new Set();
  const walk = (node) => { for (const child of node.children) { if (child.id) ids.add(child.id); walk(child); } };
  walk(document);
  for (const id of PANEL_ELEMENT_IDS) assert.ok(ids.has(id), `controller id #${id} exists in panel.html`);
  assert.equal(new Set(PANEL_ELEMENT_IDS).size, PANEL_ELEMENT_IDS.length, 'no duplicate in the id list');
  const section15 = ['panel-title', 'status-pill', 'card-tab', 'tab-enabled', 'tab-title', 'tab-target', 'tab-source-note', 'tab-volume',
    'tab-volume-value', 'tab-captions', 'card-mic', 'mic-enabled', 'mic-title', 'mic-mode', 'mic-target', 'mic-source-note', 'mic-captions',
    'mic-captions-hint', 'mute-note', 'howto', 'howto-steps', 'btn-start', 'btn-mic-permission', 'mic-permission-status', 'btn-mic-allow',
    'btn-mute', 'btn-options', 'usage-note', 'key-missing', 'btn-key-options', 'no-lane-note', 'tab-arm-note', 'tab-tabline', 'tab-status',
    'mic-status', 'tab-route', 'mic-route', 'tab-route-note', 'mic-route-note', 'tab-output', 'mic-output', 'tab-gap', 'mic-gap', 'tab-level', 'mic-level', 'tab-notice',
    'mic-notice', 'tab-preview', 'mic-preview', 'tab-apply-next', 'mic-apply-next', 'stop-note', 'close-note', 'echo-note'];
  for (const id of section15) assert.ok(ids.has(id), `#${id} exists`);
  // and no literal id in the controller source that the page lacks
  const literals = [...PANEL_SOURCE.matchAll(/'((?:tab|mic|btn|status|key|stop|no|mute|echo|close|usage)-[a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(literals.length > 10, 'the scan found the controller ids');
  for (const literal of literals) assert.ok(ids.has(literal), `source literal '${literal}' is a page id`);
  await t.test('html has no inline text the controller would have to replace', () => {
    assert.equal(document.strayText.length, 0);
  });
});

test('first run with an empty store seeds the settings from the browser language and does not touch a stored record', async (t) => {
  const ko = await harness(t, { languages: ['ko-KR', 'en'] });
  const seeded = createDefaultSettings('ko');
  assert.deepEqual(ko.stored(), JSON.parse(JSON.stringify(seeded)));
  assert.equal(ko.el('tab-target').value, 'ko');
  assert.equal(ko.el('mic-target').value, 'en');
  assert.equal(ko.el('tab-enabled').checked, true);
  assert.equal(ko.el('mic-enabled').checked, false);
  assert.equal(ko.el('tab-captions').checked, true);
  assert.equal(ko.el('mic-captions').checked, false);
  assert.equal(ko.el('tab-volume').value, '45', '§20: the owner\'s starting original volume');
  assert.equal(ko.text('tab-volume-value'), T('ext.volume.value', { percent: 45 }));
  assert.equal(ko.attr('btn-mute', 'data-muted'), 'false', '§20: the interpreted voice plays from the first start');

  const ja = await harness(t, { languages: ['ja-JP'] });
  assert.equal(ja.stored().lanes.tab.targetLanguage, 'ja');
  assert.equal(ja.stored().lanes.mic.targetLanguage, 'en');

  const stored = settingsWith((s) => { s.lanes.tab.targetLanguage = 'ja'; s.lanes.mic.targetLanguage = 'ko'; });
  const kept = await harness(t, { settings: stored, languages: ['ko-KR'] });
  assert.equal(kept.localSets.filter((entry) => KEYS.settings in entry.items).length, 0, 'a stored record is never rewritten by a reader');
  assert.equal(kept.el('tab-target').value, 'ja');
  assert.equal(kept.el('mic-target').value, 'ko');
});

test('idle render: pill, lane status lines, start button and the collapsed live regions', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  assert.equal(h.text('status-pill'), T('sim.status.idle'));
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('sim.status.idle') }));
  // The default settings leave the microphone lane switched off: its line says Off, not "Ready to start".
  assert.equal(h.text('mic-status'), T('ext.lane.statusLine', { lane: T('ext.lane.mic.title'), status: T('ext.status.off') }));
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.equal(h.attr('btn-start', 'aria-disabled'), null, 'a startable Start is not aria-disabled');
  assert.equal(h.el('btn-start').disabled, false);
  assert.equal(h.text('key-missing-text'), '');
  assert.equal(h.el('btn-key-options').hidden, true);
  assert.equal(h.text('mute-note'), '', '§20: the voice is on by default, so there is no muted note');
  for (const id of ['stop-note', 'no-lane-note', 'echo-note', 'usage-note', 'tab-notice', 'mic-notice', 'tab-apply-next', 'mic-apply-next', 'tab-output', 'tab-gap',
    'tab-quiet-note', 'mic-quiet-note']) {
    assert.equal(h.text(id), '', `#${id} is empty when it does not apply`);
  }
  assert.equal(h.el('close-note').hidden, true);
  assert.equal(h.el('tab-tabline').hidden, true);
  assert.equal(h.el('tab-route').hidden, true);
  assert.equal(h.el('tab-level').hidden, true);
  assert.equal(h.el('tab-preview').hidden, true);
  assert.equal(h.document.documentElement.getAttribute('lang'), 'en');
  assert.equal(h.document.title, T('ext.name'));
  assert.equal(h.text('panel-title'), T('ext.name'));
});

test('start button: key missing or no lane makes it aria-disabled (still focusable) and explains why; its click is ignored; Stop is never disabled', async (t) => {
  const h = await harness(t, { settings: settingsWith(), key: false, armed: true });
  assert.equal(h.attr('btn-start', 'aria-disabled'), 'true');
  assert.equal(h.el('btn-start').disabled, false, 'never natively disabled: Tab must be able to land on it to read the reason');
  assert.equal(h.text('key-missing-text'), T('ext.key.missing'));
  assert.equal(h.el('btn-key-options').hidden, false);
  assert.match(h.attr('btn-start', 'aria-describedby'), /key-missing/);
  assert.match(h.attr('btn-start', 'aria-describedby'), /no-lane-note/);
  // The click is ignored: no message, no notice, no pill change, no local error.
  await h.click('btn-start');
  assert.deepEqual(h.requests, [], 'a dimmed Start sends nothing');
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('status-pill'), T('sim.status.idle'));
  assert.equal(h.text('btn-start'), T('common.start'));
  await h.click('btn-key-options');
  assert.equal(h.browser.optionsOpens, 1);
  // the key arrives (options page): the note goes away and Start works
  await h.stub.chrome.storage.local.set({ [KEYS.key]: { v: 1, value: FAKE_KEY } });
  await h.flush();
  assert.equal(h.attr('btn-start', 'aria-disabled'), null);
  assert.equal(h.text('key-missing-text'), '');
  assert.equal(h.el('btn-key-options').hidden, true);
  await h.click('btn-start');
  assert.deepEqual(h.types(), ['sw/lane-start'], 'the same button now starts');

  const none = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; }) });
  assert.equal(none.attr('btn-start', 'aria-disabled'), 'true');
  assert.equal(none.el('btn-start').disabled, false);
  assert.equal(none.text('no-lane-note'), T('ext.status.noLane'));
  assert.equal(none.text('mute-note'), '', 'no lane enabled: no mute note');
  await none.click('btn-start');
  assert.deepEqual(none.requests, [], 'no lane: the click does nothing');
  assert.equal(none.text('mic-notice'), '');
  await none.click('tab-enabled');
  assert.equal(none.attr('btn-start', 'aria-disabled'), null);
  assert.equal(none.text('no-lane-note'), '');

  const noKeyRunning = await harness(t, { settings: settingsWith(), key: false, hostUp: true });
  await noKeyRunning.postState({ tab: running('tab') });
  assert.equal(noKeyRunning.text('btn-start'), T('common.stop'));
  assert.equal(noKeyRunning.attr('btn-start', 'aria-disabled'), null, 'Stop is never disabled');
  await noKeyRunning.click('btn-start');
  assert.deepEqual(noKeyRunning.types(), ['sw/lane-stop'], 'and it works with no key');
});

test('the arm note follows the armed record and shows the actual shortcut, or none when it is unassigned', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.needed'), T('ext.arm.pinHint'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  assert.equal(h.attr('tab-arm-note', 'data-attention'), null);
  await h.setSession(KEYS.armed, armedRecord());
  assert.equal(h.text('tab-arm-note'), T('ext.arm.ready'));
  await h.removeSession(KEYS.armed);
  assert.match(h.text('tab-arm-note'), new RegExp(T('ext.arm.needed').slice(0, 20)));

  const unassigned = await harness(t, { settings: settingsWith(), shortcut: null });
  assert.equal(unassigned.text('tab-arm-note'), [T('ext.arm.needed'), T('ext.arm.pinHint')].join(' '));
});

test('the target tab follows the active tab and an unsupported page is named before any message is sent', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true });
  assert.equal(h.text('tab-arm-note'), T('ext.arm.ready'));
  h.browser.addTab({ id: 8, url: 'https://other.example.org/', windowId: 1, active: true, title: 'Other' });
  await h.browser.activateTab(8);
  await h.flush();
  assert.match(h.text('tab-arm-note'), new RegExp(T('ext.arm.needed').slice(0, 20)), 'tab 8 is not armed');
  h.browser.addTab({ id: 9, url: 'chrome://extensions/', windowId: 1, active: true, title: 'Extensions' });
  await h.browser.activateTab(9);
  await h.flush();
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  await h.click('btn-start');
  assert.deepEqual(h.types(), [], 'no message for an unsupported page');
  // The arm note already says it. Start used to repeat the same sentence as an alert and turn the pill to "failed".
  assert.equal(h.text('tab-notice'), '', 'the sentence is not repeated as an alert');
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('sim.status.idle') }));
  assert.equal(h.text('btn-start'), T('common.start'), 'nothing is under way, so it does not turn into Stop or Cancel');
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  // back to tab 7: the record is still there
  await h.browser.activateTab(7);
  await h.flush();
  assert.equal(h.text('tab-arm-note'), T('ext.arm.ready'));
});

test('Start on an armed tab sends sw/lane-start for the tab lane, shows Stop while in flight and opens the panel port after the answer', async (t) => {
  const answer = deferred();
  const h = await harness(t, { settings: settingsWith(), armed: true });
  h.setHandler(() => answer.promise);
  await h.click('btn-start');
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 }]);
  assert.equal(h.text('btn-start'), T('common.stop'), 'Stop is available at once');
  assert.equal(h.attr('status-pill', 'data-state'), 'starting');
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('sim.status.preparing') }));
  assert.equal(h.ports.length, 0, 'no host yet');
  answer.resolve({ ok: true });
  await h.flush();
  assert.equal(h.ports.length, 1, 'a successful sw/lane-start connects the panel port');
  assert.equal(h.host().name, PORT_NAMES.panel);
  assert.deepEqual(h.host().received, [{ v: 1, type: 'hello' }]);
  // the host now drives the view
  await h.postState({ tab: running('tab', { level: 33, route: 'translation', model: 'gemini-3.5-live-translate-preview' }) });
  assert.equal(h.attr('status-pill', 'data-state'), 'running');
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('sim.status.running') }));
  assert.equal(h.text('tab-route'), `${T('sim.route.translation')} · gemini-3.5-live-translate-preview`);
  assert.equal(h.el('tab-route').hidden, false);
  assert.equal(h.el('tab-level').hidden, false);
  assert.equal(h.el('tab-level').value, 33);
  assert.equal(h.el('close-note').hidden, false);
  assert.equal(h.text('btn-start'), T('common.stop'));
  assert.equal(h.text('tab-arm-note'), '');
});

test('both lanes start one after the other, the tab lane first, and a key failure is shown once', async (t) => {
  const first = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes), armed: true });
  let calls = 0;
  h.setHandler(() => { calls += 1; return calls === 1 ? first.promise : { ok: false, code: 'CREDENTIAL_REQUIRED' }; });
  await h.click('btn-start');
  assert.deepEqual(h.requests.map((request) => request.lane), ['tab'], 'the second lane waits for the first answer');
  first.resolve({ ok: false, code: 'CREDENTIAL_REQUIRED' });
  await h.flush();
  assert.deepEqual(h.requests.map((request) => request.lane), ['tab', 'mic']);
  assert.deepEqual(h.requests[1], { v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' });
  assert.equal(h.text('tab-notice'), T('ext.error.CREDENTIAL_REQUIRED'));
  assert.equal(h.text('mic-notice'), '', 'one key problem is announced once');
  assert.equal(h.attr('btn-options', 'data-attention'), 'true');
  assert.equal(h.attr('status-pill', 'data-state'), 'error');
  assert.equal(h.text('status-pill'), T('ext.status.failed'));
  assert.equal(h.text('btn-start'), T('common.start'), 'both failed: back to Start');
});

test('Stop pressed while the first lane starts also prevents the second lane from being sent', async (t) => {
  const first = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes), armed: true });
  h.setHandler((message) => (message.type === 'sw/lane-start' ? first.promise : { ok: true }));
  await h.click('btn-start');
  assert.equal(h.text('btn-start'), T('common.stop'));
  await h.click('btn-start');
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop']);
  assert.deepEqual(h.requests[1], { v: 1, target: 'sw', type: 'sw/lane-stop' });
  first.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop'], 'the microphone lane was never sent');
  assert.equal(h.text('tab-notice'), '', 'START_CANCELLED is silent');
  assert.equal(h.text('btn-start'), T('common.start'));
});

// §20 (2026-10-08): Start on a tab the toolbar icon did not arm opens Chrome's share dialog at once, on every OS (the
// same dialog the owner saw on the Mac); Start alone is enough, nothing else is offered. The icon stays the instant
// start: its click writes the autostart record the panel acts on, and while the dialog is open it takes the dialog over.
// An ARMED tab still starts by stream id, without `pick`.
const autostartRecord = (h, { tabId = 7, windowId = 1, at = h.browser.clock.now() } = {}) => ({ v: 1, tabId, windowId, at });
// What the worker writes on an icon click on a capturable tab: the arming first, then the start request (§20).
async function clickIcon(h, options = {}) {
  await h.setSession(KEYS.armed, armedRecord([options.tabId ?? 7]));
  await h.setSession(KEYS.autostart, autostartRecord(h, options));
}
const laneStarts = (h) => h.requests.filter((request) => request.type === 'sw/lane-start');
const PICK_START = Object.freeze({ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7, pick: true });
const ARMED_START = Object.freeze({ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 });
const MIC_START = Object.freeze({ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' });
// How each dictionary names the toolbar icon, and what Chrome's own share dialog shows (its labels are Chrome's, not ours, so
// the dictionaries quote them): the classic generation (toggle "Also share tab audio", button "Share") and the one with
// kGetDisplayMediaAudioSelection on (toggle "Share with tab audio"; once it is on, the button "Share with Audio").
const ICON_NAMED = Object.freeze({ en: 'Live Interpreter icon', ko: '‘Live Interpreter’ 아이콘', ja: '「Live Interpreter」アイコン' });
const CHROME_DIALOG = Object.freeze({
  en: { tab: 'Chrome Tab', toggle: ['Also share tab audio', 'Share with tab audio'], button: ['Share', 'Share with Audio'] },
  ko: { tab: 'Chrome 탭', toggle: ['탭 오디오도 공유', '탭 오디오와 함께 공유'], button: ['공유', '오디오와 함께 공유'] },
  ja: { tab: 'Chrome タブ', toggle: ['タブの音声も共有する', 'タブの音声を含めて共有する'], button: ['共有', '音声付きで共有'] },
});
// The match of `label` written inside quotes of any style ("..." ‘...’ 「...」), or null: a bare "Share" inside "Share with
// Audio" does not count as the quoted button.
const quotedAt = (text, label) => new RegExp(`["“”‘’'「『«]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["“”‘’'」』»]`).exec(text);
// Every text written to an element from now on: a test then sees the states a render passed through, not only the last one.
function recordText(h, id) {
  const el = h.el(id);
  let owner = Object.getPrototypeOf(el);
  while (owner !== null && !Object.hasOwn(owner, 'textContent')) owner = Object.getPrototypeOf(owner);
  const original = Object.getOwnPropertyDescriptor(owner, 'textContent');
  const writes = [];
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get() { return original.get.call(this); },
    set(value) { writes.push(String(value)); original.set.call(this, value); },
  });
  return writes;
}

test('§20 Start on an un-armed tab opens Chrome\'s share dialog at once: ONE sw/lane-start with pick:true, Cancel, the single picker wait, and the icon hint from the first second', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith() });
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.needed'), T('ext.arm.pinHint'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '),
    'idle: Start opens a Chrome window to choose the tab, the icon starts this tab at once');
  h.setHandler((message) => (message.type === 'sw/lane-start' ? pick.promise : { ok: true }));
  await h.click('btn-start');
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7, pick: true }],
    'exactly one message, sent at once, and it asks for the dialog');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.attr('status-pill', 'data-state'), 'warning');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('ext.status.choosingTab') }));
  // review UX-3: the lane tab's chip says the user has something to do; "Getting ready" read as "it starts by itself"
  assert.equal(h.text('lane-tab-tab-state'), T('ext.laneTab.attention'));
  assert.equal(h.attr('lane-tab-tab', 'data-state'), 'attention');
  assert.equal(h.text('tab-notice'), '', 'choosing is not an error');
  // The note: what to do in the dialog, the icon as the faster way from the first second, and the shortcut when one is set.
  const shortcut = T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' });
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), shortcut].join(' '));
  await h.advance(7_999);
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), shortcut].join(' '));
  assert.ok(!h.text('tab-arm-note').includes(T('ext.arm.pickLost')), 'at 7_999 ms the lost-window line is not there yet');
  await h.advance(1);
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.pickLost'), T('ext.arm.pinHint'), shortcut].join(' '),
    'at 8_000 ms: where to look when the Chrome window is not in sight, and where the icon is');
  assert.equal(h.requests.length, 1, 'waiting sends nothing more');
  // An arm event while the dialog is open (the tab got armed some other way, e.g. a second click elsewhere) is not a start
  // request: the dialog stays, nothing is sent, and the panel still asks for the choice.
  await h.setSession(KEYS.armed, armedRecord());
  assert.equal(h.requests.length, 1, 'an arm event alone sends nothing');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.ok(h.text('tab-arm-note').startsWith(T('ext.arm.picking')), 'the picking note stays');
  // Start itself opens the dialog: the page has no separate button for it.
  assert.equal(h.el('btn-pick-tab'), null, 'no dialog button in the page');
  assert.equal(PANEL_ELEMENT_IDS.includes('btn-pick-tab'), false);
  pick.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();

  // No keyboard shortcut set: the note claims none. The host holds the dialog open, then the user chooses.
  const other = deferred();
  const free = await harness(t, { settings: settingsWith(), hostUp: true, shortcut: null });
  free.setHandler((message) => (message.type === 'sw/lane-start' ? other.promise : { ok: true }));
  await free.click('btn-start');
  assert.deepEqual(laneStarts(free), [PICK_START]);
  assert.equal(free.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow')].join(' '));
  await free.advance(8_000);
  assert.equal(free.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.pickLost'), T('ext.arm.pinHint')].join(' '));
  await free.postState({ tab: { phase: 'starting', engineStatus: null, epoch: 1 } });   // the host holds the dialog open
  assert.equal(free.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(free.text('btn-start'), T('common.cancel'));
  // The user chose: the engine is being set up, and the panel reads like any other start.
  await free.postState({ tab: { phase: 'starting', engineStatus: 'connecting', targetLanguage: 'en', tabId: 9, epoch: 1 } });
  assert.equal(free.text('status-pill'), T('sim.status.connecting'));
  assert.equal(free.text('tab-arm-note'), '');
  assert.equal(free.text('btn-start'), T('common.stop'));
  other.resolve({ ok: true });
  await free.postState({ tab: running('tab', { tabId: 9 }) });
  assert.equal(free.text('status-pill'), T('sim.status.running'));
  assert.equal(free.text('tab-arm-note'), '');
});

test('§20 the wait for the toolbar icon is gone from the view model and the dictionaries, and the dialog texts exist in every language', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  assert.equal(Object.hasOwn(h.controller.viewModel().lanes.tab, 'pickButton'), false);
  for (const language of ['en', 'ko', 'ja']) {
    for (const key of ['ext.status.awaitingArm', 'ext.arm.waiting', 'ext.arm.pickButton']) assert.equal(REF[language].has(key), false, `${language}: ${key}`);
    for (const key of ['ext.status.choosingTab', 'ext.arm.needed', 'ext.arm.picking', 'ext.arm.pickSlow', 'ext.arm.pickLost']) {
      assert.equal(REF[language].has(key), true, `${language}: ${key}`);
    }
  }
});

// R8, R9: the texts of the dialog, every language, pinned by STRUCTURE (what the user must be able to find on screen), not
// by sentence: Chrome's labels of BOTH generations, the steps in the order the user takes them, the icon named where the
// dialog cannot be used, and a lost-window line that claims nothing about an operating system.
test('§20 the dialog texts in every language quote Chrome\'s labels of both generations in the order of the steps, name the icon, and claim no taskbar', () => {
  for (const language of ['en', 'ko', 'ja']) {
    const d = CHROME_DIALOG[language];
    const picking = REF[language].t('ext.arm.picking');
    const at = (text, label, key) => {
      const found = quotedAt(text, label);
      assert.notEqual(found, null, `${language}: ${key} quotes ${label}`);
      return found.index;
    };
    const toggleAt = d.toggle.map((label) => at(picking, label, 'ext.arm.picking'));
    const buttonAt = d.button.map((label) => at(picking, label, 'ext.arm.picking'));
    assert.ok(Math.max(...toggleAt) < Math.min(...buttonAt),
      `${language}: leave the audio option on (both generations of its label), THEN press the button (both generations)`);
    // a share without audio: the tab, the toggle in both generations (the notice does not tell which Chrome this is)
    const noAudio = REF[language].t('ext.error.TAB_SHARE_NO_AUDIO');
    for (const label of [d.tab, ...d.toggle]) at(noAudio, label, 'ext.error.TAB_SHARE_NO_AUDIO');
    // the icon is the way on: after the 8 s, and where the dialog itself cannot help (a policy that blocks it)
    assert.ok(REF[language].t('ext.arm.pickSlow').includes(ICON_NAMED[language]), `${language}: pickSlow names the icon`);
    assert.ok(REF[language].t('ext.error.TAB_CAPTURE_FAILED').includes(ICON_NAMED[language]), `${language}: TAB_CAPTURE_FAILED names the icon`);
    assert.ok(REF[language].t('ext.arm.pinHint').length > 10, `${language}: the pin hint is a sentence`);
    // the lost-window line: a sentence of its own, with no claim about the taskbar or Dock (nothing was verified)
    const lost = REF[language].t('ext.arm.pickLost');
    assert.ok(lost.trim().length >= 20, `${language}: pickLost is a sentence`);
    assert.notEqual(lost, REF[language].t('ext.arm.pickSlow'), `${language}: not a copy of pickSlow`);
    assert.doesNotMatch(lost, { en: /taskbar|dock/i, ko: /작업 ?표시줄|도크|dock/i, ja: /タスクバー|ドック|dock/i }[language],
      `${language}: no operating-system claim`);
  }
  assert.doesNotMatch(REF.ko.t('ext.arm.pinHint'), /’을/, 'ko: ’를 after a vowel-final quote');
});

// The note the panel writes in each language is those keys in that order, including the pin hint once the dialog has been
// open a while (the dictionary of the language, not the English one).
test('§20 the dialog note is built from the dictionary of the display language, pin hint included after 8 s', async (t) => {
  for (const [language, languages] of [['ko', ['ko-KR']], ['ja', ['ja-JP']]]) {
    const pick = deferred();
    const h = await harness(t, { settings: settingsWith(), languages, shortcut: null });
    h.setHandler((message) => (message.type === 'sw/lane-start' ? pick.promise : { ok: true }));
    await h.click('btn-start');
    const dict = REF[language];
    assert.equal(h.text('tab-arm-note'), [dict.t('ext.arm.picking'), dict.t('ext.arm.pickSlow')].join(' '), language);
    await h.advance(8_000);
    assert.equal(h.text('tab-arm-note'),
      [dict.t('ext.arm.picking'), dict.t('ext.arm.pickSlow'), dict.t('ext.arm.pickLost'), dict.t('ext.arm.pinHint')].join(' '), language);
    pick.resolve({ ok: false, code: 'START_CANCELLED' });
    await h.flush();
  }
});

test('§20 both lanes on: the dialog of an un-armed tab is not awaited (tab, then microphone at once); an ARMED tab is (tab answered first, then microphone)', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes) });
  h.setHandler((message) => (message.type === 'sw/lane-start' && message.lane === 'tab' ? pick.promise : { ok: true }));
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h).map((request) => request.lane), ['tab', 'mic'], 'the microphone is never held behind the dialog');
  assert.deepEqual(laneStarts(h), [PICK_START, MIC_START]);
  // the tab start is still pending (the dialog is open): the panel asks for the choice while the microphone is going
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  assert.equal(h.ports.length, 1, 'the microphone start was answered and the panel connected to the host');
  await h.postState({ mic: running('mic') });
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'), 'the microphone interprets while the dialog is still open');
  assert.equal(h.text('mic-status'), T('ext.lane.statusLine', { lane: T('ext.lane.mic.title'), status: T('sim.status.running') }));
  assert.equal(h.text('lane-tab-mic-state'), T('ext.laneTab.running'));
  assert.equal(h.text('lane-tab-tab-state'), T('ext.laneTab.attention'));
  pick.resolve({ ok: true });
  await h.postState({ tab: running('tab', { tabId: 9 }), mic: running('mic') });
  assert.equal(h.text('status-pill'), T('sim.status.running'));
  assert.deepEqual(laneStarts(h), [PICK_START, MIC_START], 'nothing was sent twice');

  // An ARMED tab answers at once, so it is awaited: the microphone is sent only after the tab start answered (a microphone
  // start running next to it would make the worker's orphaned-capture recovery refuse to close the host).
  const gate = deferred();
  const armed = await harness(t, { settings: settingsWith(bothLanes), armed: true });
  armed.setHandler((message) => (message.type === 'sw/lane-start' && message.lane === 'tab' ? gate.promise : { ok: true }));
  await armed.click('btn-start');
  assert.deepEqual(armed.requests, [ARMED_START], 'the armed tab start is not deferred: no pick, and the microphone waits for its answer');
  gate.resolve({ ok: true });
  await armed.flush();
  assert.deepEqual(armed.requests, [ARMED_START, MIC_START]);
});

test('§20 a stale armed record: NEEDS_ARM to the start WITHOUT pick makes the panel retry once WITH pick:true, and nothing in between shows the Start button or an idle pill', async (t) => {
  const answer = deferred();
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith(), armed: true });
  const pill = recordText(h, 'status-pill');
  const button = recordText(h, 'btn-start');
  // The worker: NEEDS_ARM to a start without pick (it dropped the record when the mint said the grant is gone), the dialog
  // for the start with pick.
  h.setHandler((message) => {
    if (message.type !== 'sw/lane-start') return { ok: true };
    return message.pick ? pick.promise : answer.promise;
  });
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [ARMED_START], 'the armed path is tried first, without pick');
  assert.equal(h.text('btn-start'), T('common.stop'));
  assert.equal(h.text('status-pill'), T('sim.status.preparing'));
  assert.equal(h.text('tab-arm-note'), '');
  await h.removeSession(KEYS.armed);
  answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await h.flush();
  assert.equal(laneStarts(h).length, 2, 'exactly two starts follow');
  assert.equal(Object.hasOwn(laneStarts(h)[0], 'pick'), false);
  assert.deepEqual(laneStarts(h)[1], PICK_START);
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-notice'), '', 'NEEDS_ARM is never an alarming error');
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
  // No render between the two starts: the pill went from "preparing" straight to "choosing", the button from Stop to Cancel.
  assert.deepEqual(pill, [T('sim.status.preparing'), T('ext.status.choosingTab')]);
  assert.deepEqual(button, [T('common.stop'), T('common.cancel')]);
  assert.ok(!pill.includes(T('sim.status.idle')) && !button.includes(T('common.start')), 'the panel never fell back to idle');
  // The hint timer belongs to the retry: the lost-window line comes 8 s after it.
  await h.advance(8_000);
  assert.ok(h.text('tab-arm-note').includes(T('ext.arm.pickLost')));
  pick.resolve({ ok: true });
  await h.flush();
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  assert.equal(laneStarts(h).length, 2, 'one retry, never a third start');
  assert.equal(h.text('status-pill'), T('sim.status.running'));

  // A start WITH pick is never answered NEEDS_ARM by the worker; if it were, the panel must not loop on it.
  const loop = await harness(t, { settings: settingsWith(), armed: true });
  loop.setHandler((message) => (message.type === 'sw/lane-start' ? { ok: false, code: 'NEEDS_ARM' } : { ok: true }));
  await loop.click('btn-start');
  assert.deepEqual(laneStarts(loop).map((request) => request.pick === true), [false, true], 'one retry, then it stops');
  assert.equal(loop.text('tab-notice'), '');

  // A Stop pressed while the armed start is in flight also cancels the retry: no dialog opens after Cancel.
  const late = deferred();
  const stopped = await harness(t, { settings: settingsWith(), armed: true });
  stopped.setHandler((message) => (message.type === 'sw/lane-start' ? late.promise : { ok: true }));
  await stopped.click('btn-start');
  assert.equal(stopped.text('btn-start'), T('common.stop'));
  await stopped.click('btn-start');
  late.resolve({ ok: false, code: 'NEEDS_ARM' });
  await stopped.flush();
  assert.deepEqual(laneStarts(stopped), [ARMED_START], 'the cancelled start is not retried');
  assert.equal(stopped.text('btn-start'), T('common.start'));
  assert.equal(stopped.text('tab-notice'), '');
});

test('§20 a stale armed record with BOTH lanes on: the retry opens the dialog and the microphone is not held behind it', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes), armed: true });
  h.setHandler((message) => {
    if (message.type !== 'sw/lane-start') return { ok: true };
    if (message.lane === 'mic') return { ok: true };
    return message.pick ? pick.promise : { ok: false, code: 'NEEDS_ARM' };
  });
  await h.click('btn-start');
  // The armed start was answered NEEDS_ARM, its retry (the dialog) is still open, and the microphone start was sent anyway.
  assert.deepEqual(laneStarts(h), [ARMED_START, PICK_START, MIC_START], 'the microphone does not wait for the dialog the retry opened');
  assert.equal(h.text('tab-notice'), '');
  pick.resolve({ ok: true });
  await h.flush();
  assert.equal(laneStarts(h).length, 3, 'nothing was asked again');
});

// The NEEDS_ARM retry is gated (the same run, the lane still on, the same tab, the panel alive): each guard in a case of
// its own, so that dropping any one of them opens a dialog the user did not ask for.
test('§20 the NEEDS_ARM retry opens no dialog when the lane was switched off, the target tab changed, or the panel was disposed meanwhile', async (t) => {
  const armedStart = async (options = {}) => {
    const answer = deferred();
    const h = await harness(t, { settings: settingsWith(), armed: true, ...options });
    h.setHandler((message) => (message.type === 'sw/lane-start' ? answer.promise : { ok: true }));
    await h.click('btn-start');
    assert.deepEqual(laneStarts(h), [ARMED_START]);
    return { h, answer };
  };
  const settled = (h, label) => {
    assert.deepEqual(laneStarts(h), [ARMED_START], `${label}: no second start, so no dialog`);
    assert.equal(h.text('tab-notice'), '', `${label}: NEEDS_ARM is never an alert`);
    assert.equal(h.text('btn-start'), T('common.start'), `${label}: the panel is back to idle`);
    assert.equal(h.attr('status-pill', 'data-state'), 'idle', label);
  };

  // (1) the tab lane was switched off in the options page (a storage change: stopLanes is not involved) before the answer
  const off = await armedStart();
  await off.h.patchSettings((next) => { next.lanes.tab.enabled = false; });
  off.answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await off.h.flush();
  settled(off.h, 'lane switched off');

  // (1b) the same through this panel's own checkbox (it also stops the lane: either guard alone is enough here)
  const unchecked = await armedStart();
  await unchecked.h.click('tab-enabled');
  assert.equal(unchecked.h.el('tab-enabled').checked, false);
  unchecked.answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await unchecked.h.flush();
  settled(unchecked.h, 'lane unchecked in the panel');

  // (2) another tab became the panel's target before the answer: the dialog would be for a tab nobody asked for
  const moved = await armedStart();
  moved.h.browser.addTab({ id: 9, url: 'https://other.example.org/', windowId: 1, active: false, title: 'Other' });
  await moved.h.browser.activateTab(9);
  await moved.h.flush();
  moved.answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await moved.h.flush();
  settled(moved.h, 'another target tab');

  // (3) R4: the panel was closed (disposed) before the answer: no second dialog, no new hint timer
  const gone = await armedStart();
  gone.h.controller.dispose();
  gone.answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await gone.h.flush();
  assert.deepEqual(laneStarts(gone.h), [ARMED_START], 'a late NEEDS_ARM after dispose() opens no dialog');
  await gone.h.advance(20_000);
  assert.deepEqual(laneStarts(gone.h), [ARMED_START]);
});

// R5: switching the tab lane off and on again is a cancel. The start that was in flight is not the newest any more, so its
// late NEEDS_ARM does not open the dialog the user walked away from.
test('§20 switching the tab lane off and on again while an armed start is in flight cancels the later NEEDS_ARM retry', async (t) => {
  const answer = deferred();
  const h = await harness(t, { settings: settingsWith(), armed: true });
  h.setHandler((message) => (message.type === 'sw/lane-start' ? answer.promise : { ok: true }));
  await h.click('btn-start');
  assert.equal(h.text('btn-start'), T('common.stop'));
  await h.click('tab-enabled');   // off: the worker is asked to stop the tab lane
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop']);
  assert.deepEqual(h.requests[1], { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'tab' });
  await h.click('tab-enabled');   // on again: switching a lane on starts nothing while nothing runs
  assert.equal(h.el('tab-enabled').checked, true);
  answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await h.flush();
  assert.deepEqual(laneStarts(h), [ARMED_START], 'the dialog the user cancelled does not open');
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.text('tab-notice'), '');
  await h.advance(10_000);
  assert.deepEqual(laneStarts(h), [ARMED_START]);
});

// R2: the retry's startOne can end at its first guard (the page became one Chrome cannot capture while the armed start
// was in flight). Nothing renders after it by itself: the panel must not keep showing "starting" and Stop.
test('§20 the NEEDS_ARM retry that finds the page no longer capturable leaves the panel idle, not on Stop', async (t) => {
  const answer = deferred();
  const h = await harness(t, { settings: settingsWith(), armed: true });
  h.setHandler((message) => (message.type === 'sw/lane-start' ? answer.promise : { ok: true }));
  await h.click('btn-start');
  assert.equal(h.text('btn-start'), T('common.stop'));
  await h.browser.navigate(7, 'chrome://extensions/');   // the same tab (id 7), now a page that cannot be captured
  await h.flush();
  assert.equal(h.text('btn-start'), T('common.stop'), 'still starting until the worker answers');
  answer.resolve({ ok: false, code: 'NEEDS_ARM' });
  await h.flush();
  assert.deepEqual(laneStarts(h), [ARMED_START], 'no dialog for a page Chrome would refuse');
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('sim.status.idle') }));
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  assert.equal(h.text('tab-notice'), '');
});

// R3 in the controller: the dialog is open and the panel's active tab becomes a chrome:// page. The pill and Cancel say
// "waiting", so the note keeps saying what to do in the dialog (it used to flip to "cannot be captured").
test('§20 the dialog is open and the active tab becomes a page that cannot be captured: the note, the pill and Cancel agree', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith() });
  h.setHandler((message) => (message.type === 'sw/lane-start' ? pick.promise : { ok: true }));
  await h.click('btn-start');
  h.browser.addTab({ id: 9, url: 'chrome://extensions/', windowId: 1, active: false, title: 'Extensions' });
  await h.browser.activateTab(9);
  await h.flush();
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  pick.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'), 'once the dialog is over the page is named again');
});

// startOne's tail: the dialog start ended (ok), so the panel's own "picking" flag and the 8 s hint timer end with it. A
// stale flag made the icon on the tab being interpreted restart the lane (startFromIcon reads it as "the dialog is open");
// a stale timer put the "lost window" line on the NEXT dialog at once.
test('§20 after a dialog start succeeded, the picking flag and the hint timer are over: the icon on the interpreted tab restarts nothing', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith() });
  h.setHandler((message) => (message.type === 'sw/lane-start' ? pick.promise : { ok: true }));
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [PICK_START]);
  pick.resolve({ ok: true });
  await h.flush();
  await h.postState({ tab: running('tab', { tabId: 7 }) });
  assert.equal(h.text('btn-start'), T('common.stop'));
  assert.equal(h.text('tab-arm-note'), '');
  await clickIcon(h);   // the toolbar icon on the tab the lane interprets: nothing to do
  assert.deepEqual(h.types(), ['sw/lane-start'], 'no stop, no second start');
  assert.equal(h.text('btn-start'), T('common.stop'));

  // The 8 s window passes after the success: the lane stops, and a LATER dialog (the host holds one open) starts its own
  // hint clock: the lost-window line is not there at once.
  await h.advance(8_000);
  await h.postState({});
  await h.postState({ tab: { phase: 'starting', engineStatus: null, epoch: 2 } });
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.ok(!h.text('tab-arm-note').includes(T('ext.arm.pickLost')), 'a stale hint timer would have fired already');
  assert.ok(!h.text('tab-arm-note').includes(T('ext.arm.pinHint')));
  await h.postState({});
  assert.ok(!h.text('tab-arm-note').includes(T('ext.arm.picking')), 'after the success the note is not left in the dialog state');
  assert.equal(h.text('tab-arm-note'), T('ext.arm.ready'), 'the icon click armed the tab: the idle note says so');
});

// stopLanes('mic') alone (the microphone switched off) must leave the tab lane's dialog alone.
test('§20 switching the microphone off while the tab dialog is open keeps the dialog: choosing pill, Cancel, the picking note', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes) });
  h.setHandler((message) => (message.type === 'sw/lane-start' && message.lane === 'tab' ? pick.promise : { ok: true }));
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [PICK_START, MIC_START]);
  await h.click('mic-enabled');   // off
  assert.equal(h.el('mic-enabled').checked, false);
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'mic' }, 'only the microphone is stopped');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  assert.equal(h.attr('lane-tab-tab', 'data-state'), 'attention');
  // the hint clock of the dialog goes on
  await h.advance(8_000);
  assert.ok(h.text('tab-arm-note').includes(T('ext.arm.pickLost')));
  // and the dialog is still the tab lane's: its answer ends it normally
  pick.resolve({ ok: true });
  await h.flush();
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  assert.equal(h.text('status-pill'), T('sim.status.running'));
});

// The dialog's instructions are in the tab card; Start does not switch cards. The tab card comes forward when the lane
// ENTERS the wait, once, and the user's later choice stands.
test('§20 Start with the microphone card shown brings the tab card forward when the dialog opens, once; a later manual choice stands', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes) });
  const shown = () => ['tab', 'mic'].filter((lane) => !h.el(`card-${lane}`).hidden);
  h.setHandler((message) => (message.type === 'sw/lane-start' && message.lane === 'tab' ? pick.promise : { ok: true }));
  await h.click('lane-tab-mic');
  assert.deepEqual(shown(), ['mic']);
  await h.click('btn-start');
  assert.deepEqual(shown(), ['tab'], 'the note that tells what to do in the dialog is on screen');
  assert.equal(h.attr('lane-tab-tab', 'aria-selected'), 'true');
  assert.equal(h.attr('lane-tab-tab', 'tabindex'), '0');
  assert.equal(h.attr('lane-tab-mic', 'aria-selected'), 'false');
  assert.equal(h.el('tab-arm-note').hidden, false);
  assert.ok(h.text('tab-arm-note').startsWith(T('ext.arm.picking')));
  // one-shot: the user looks at the microphone card meanwhile and it stays, through renders, the 8 s hint and host states
  await h.click('lane-tab-mic');
  assert.deepEqual(shown(), ['mic']);
  await h.advance(8_000);
  await h.postState({ mic: running('mic') });
  assert.deepEqual(shown(), ['mic'], 'no fighting a manual choice');
  assert.equal(h.text('lane-tab-tab-state'), T('ext.laneTab.attention'), 'the tab chip still says the user has something to do');
  // the dialog ends; the next dialog brings the tab card forward again
  pick.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
  assert.deepEqual(shown(), ['mic']);
  const again = deferred();
  h.setHandler((message) => (message.type === 'sw/lane-start' && message.lane === 'tab' ? again.promise : { ok: true }));
  await h.postState({});
  await h.click('btn-start');
  assert.deepEqual(shown(), ['tab'], 'a new dialog is a new entry');
  again.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();

  // The tab card already shown stays; the tab lane switched off has no dialog to show
  const tabCard = await harness(t, { settings: settingsWith(bothLanes) });
  tabCard.setHandler((message) => (message.type === 'sw/lane-start' && message.lane === 'tab' ? new Promise(() => {}) : { ok: true }));
  await tabCard.click('btn-start');
  assert.deepEqual(['tab', 'mic'].filter((lane) => !tabCard.el(`card-${lane}`).hidden), ['tab']);
  const micOnly = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; }) });
  await micOnly.click('btn-start');
  assert.deepEqual(['tab', 'mic'].filter((lane) => !micOnly.el(`card-${lane}`).hidden), ['mic'], 'no tab lane, no dialog: the card does not move');
  // A dialog that the HOST reports (another panel opened it) for a tab lane this panel has switched off has no note here
  // (a lane that is off has nothing to arm): the card stays where the user put it.
  const hosted = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; }), hostUp: true });
  await hosted.postState({ tab: { phase: 'starting', engineStatus: null, epoch: 1 } });
  assert.equal(hosted.text('tab-arm-note'), '');
  assert.deepEqual(['tab', 'mic'].filter((lane) => !hosted.el(`card-${lane}`).hidden), ['mic'], 'no note to show in the tab card: no move');
});

// The dialog start through the icon's NEEDS_ARM retry enters the wait too (the armed start was in flight on the mic card).
test('§20 the NEEDS_ARM retry opens the dialog while the microphone card is shown: the tab card comes forward', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes), armed: true });
  h.setHandler((message) => {
    if (message.type !== 'sw/lane-start' || message.lane === 'mic') return { ok: true };
    return message.pick ? pick.promise : { ok: false, code: 'NEEDS_ARM' };
  });
  await h.click('lane-tab-mic');
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [ARMED_START, PICK_START, MIC_START]);
  assert.equal(h.el('card-tab').hidden, false);
  assert.equal(h.el('card-mic').hidden, true);
  pick.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
});

// An icon click that does not change anything must not be taken for a second click: the same autostart record seen again
// (a re-read, another storage event) is consumed once whichever event brought it first. Here the host is idle, so
// without the guard the second sighting would start the lane again.
test('§20 the same icon click seen again after the lane ran and was stopped does not start a second time', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  await h.postState({});
  const record = autostartRecord(h);
  await h.setSession(KEYS.armed, armedRecord());
  await h.setSession(KEYS.autostart, record);
  assert.equal(laneStarts(h).length, 1);
  await h.postState({ tab: running('tab', { tabId: 7 }) });
  await h.click('btn-start');   // Stop
  assert.equal(h.types().at(-1), 'sw/lane-stop');
  await h.postState({});
  await h.setSession(KEYS.autostart, record);   // the same record again, host idle
  assert.equal(laneStarts(h).length, 1, 'consumed once');
  await h.browser.activateTab(7);
  await h.flush();
  assert.equal(laneStarts(h).length, 1);
  // a NEW click (a later `at`) is a new start
  await h.setSession(KEYS.autostart, autostartRecord(h, { at: h.browser.clock.now() + 1 }));
  assert.equal(laneStarts(h).length, 2);
});

test('§20 Cancel then Start again before the first start\'s answer: the late START_CANCELLED of the cancelled start does not switch the newer start off', async (t) => {
  const first = deferred();
  const second = deferred();
  const h = await harness(t, { settings: settingsWith() });
  let starts = 0;
  h.setHandler((message) => {
    if (message.type !== 'sw/lane-start') return { ok: true };
    starts += 1;
    return starts === 1 ? first.promise : second.promise;
  });
  await h.click('btn-start');
  await h.click('btn-start');   // Cancel: the worker is asked to close the dialog, but has not answered the start yet
  assert.equal(h.text('btn-start'), T('common.start'));
  await h.click('btn-start');   // Start again
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop', 'sw/lane-start']);
  assert.deepEqual(laneStarts(h), [PICK_START, PICK_START]);
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  // The first start's answer arrives late: it was cancelled, silently.
  first.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
  assert.equal(h.text('btn-start'), T('common.cancel'), 'the newer start is still in flight: Cancel stays');
  assert.equal(h.attr('status-pill', 'data-state'), 'warning');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('ext.status.choosingTab') }));
  assert.equal(h.attr('lane-tab-tab', 'data-state'), 'attention');
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  // and the newer start keeps its own hint timer
  await h.advance(8_000);
  assert.ok(h.text('tab-arm-note').includes(T('ext.arm.pickLost')), 'the newer dialog still gets its 8 s hint');
  // Cancel still reaches the worker for the newer start
  await h.click('btn-start');
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop', 'sw/lane-start', 'sw/lane-stop']);
  second.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');

  // The newer start's own answer ends it normally.
  const a = deferred();
  const b = deferred();
  const again = await harness(t, { settings: settingsWith() });
  let count = 0;
  again.setHandler((message) => {
    if (message.type !== 'sw/lane-start') return { ok: true };
    count += 1;
    return count === 1 ? a.promise : b.promise;
  });
  await again.click('btn-start');
  await again.click('btn-start');
  await again.click('btn-start');
  a.resolve({ ok: false, code: 'START_CANCELLED' });
  await again.flush();
  b.resolve({ ok: true });
  await again.flush();
  assert.equal(again.ports.length, 1, 'the newer start succeeded and the panel connected');
  await again.postState({ tab: running('tab', { tabId: 9 }) });
  assert.equal(again.text('btn-start'), T('common.stop'));
  assert.equal(again.text('status-pill'), T('sim.status.running'));
});

test('§20 Start on a page that cannot be captured stays a silent no-op for the tab lane: no tab lane-start, the arm note names the page, the microphone of the same Start still runs', async (t) => {
  const h = await harness(t, { settings: settingsWith(), tabUrl: 'chrome://extensions/' });
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  await h.click('btn-start');
  assert.deepEqual(h.requests, [], 'no message at all: no dialog for a page Chrome would refuse');
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  assert.equal(h.text('tab-notice'), '', 'the arm note already says it: no alert repeats it');
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.text('btn-start'), T('common.start'), 'nothing is under way, so Start does not turn into Cancel');
  await h.advance(8_000);
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'), 'no dialog hint follows');

  // An armed record for that tab makes no difference.
  const armed = await harness(t, { settings: settingsWith(), tabUrl: 'chrome://extensions/', armed: true });
  await armed.click('btn-start');
  assert.deepEqual(armed.requests, []);
  assert.equal(armed.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));

  // Both lanes: only the microphone starts.
  const both = await harness(t, { settings: settingsWith(bothLanes), tabUrl: 'chrome://extensions/' });
  await both.click('btn-start');
  assert.deepEqual(laneStarts(both), [MIC_START], 'the tab lane is skipped, the microphone is not held back');
  assert.equal(both.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  assert.equal(both.text('tab-notice'), '');
});

test('§20 an arm event without the start request only makes the tab ready; Cancel ends the dialog through the worker, and a cancelled dialog does not start on an arm event', async (t) => {
  const idle = await harness(t, { settings: settingsWith() });
  await idle.setSession(KEYS.armed, armedRecord());
  assert.deepEqual(idle.types(), []);
  assert.equal(idle.text('tab-arm-note'), T('ext.arm.ready'));

  const pick = deferred();
  const h = await harness(t, { settings: settingsWith() });
  h.setHandler((message) => (message.type === 'sw/lane-start' ? pick.promise : { ok: true }));
  await h.click('btn-start');
  await h.click('btn-start');   // Cancel
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop'], 'Cancel goes through the worker');
  assert.deepEqual(h.requests[1], { v: 1, target: 'sw', type: 'sw/lane-stop' });
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.match(h.text('tab-arm-note'), new RegExp(T('ext.arm.needed').slice(0, 20)));
  pick.resolve({ ok: false, code: 'START_CANCELLED' });   // also what a closed dialog comes back as
  await h.flush();
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  await h.setSession(KEYS.armed, armedRecord());
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop'], 'a cancelled dialog does not start on an arm event');
});

test('§20 a share without audio (the dialog Start opened) is explained by the notice alone; the next Start opens the dialog again', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  h.setHandler(() => ({ ok: false, code: 'TAB_SHARE_NO_AUDIO' }));
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [PICK_START]);
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_SHARE_NO_AUDIO'));
  assert.equal(h.attr('tab-notice', 'role'), 'alert');
  // review UX-1: the notice points to what 0.5.0 does, in every language: the icon first (it starts at once), then Start
  // (which opens Chrome's window), with Chrome's own labels kept. 0.4.0 said "press Start again and choose in the Chrome
  // window".
  const iconNamed = ICON_NAMED;
  const chromeLabels = { en: ['"Chrome Tab"', '"Also share tab audio"'], ko: ['‘Chrome 탭’', '‘탭 오디오도 공유’'], ja: ['「Chrome タブ」', '「タブの音声も共有する」'] };
  for (const language of ['en', 'ko', 'ja']) {
    const text = REF[language].t('ext.error.TAB_SHARE_NO_AUDIO');
    const startWord = REF[language].t('common.start');
    assert.ok(text.includes(iconNamed[language]), `${language}: names the icon`);
    assert.ok(text.includes(startWord), `${language}: names Start (${startWord})`);
    assert.ok(text.indexOf(iconNamed[language]) < text.lastIndexOf(startWord), `${language}: the icon first, then Start`);
    for (const label of chromeLabels[language]) assert.ok(text.includes(label), `${language}: keeps Chrome's label ${label}`);
  }
  assert.doesNotMatch(T('ext.error.TAB_SHARE_NO_AUDIO'), /Start again/);
  assert.equal(h.text('tab-arm-note'), '');
  assert.equal(h.text('btn-start'), T('common.start'));
  // The next Start opens the dialog again at once and clears the old notice.
  const pick = deferred();
  h.setHandler(() => pick.promise);
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [PICK_START, PICK_START]);
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  pick.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
});

test('after TAB_ENDED the alert speaks alone: an arm event neither starts anything nor adds a "ready" line that would contradict it', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  await h.postState({ tab: failed('TAB_ENDED') });
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_ENDED'));
  assert.equal(h.attr('status-pill', 'data-state'), 'warning');
  assert.equal(h.text('status-pill'), T('sim.status.stopped'));
  assert.equal(h.text('tab-arm-note'), '', 'the alert already says "click the toolbar icon, then press Start"');
  await h.setSession(KEYS.armed, armedRecord());
  assert.deepEqual(h.types(), [], 'an arm event alone never starts a lane');
  // Was: "This tab is ready. Press Start." next to an alert that says "click the icon" (a record that survives the end of
  // the stream cannot be told from a fresh click), so both were shown. Now only the notice is.
  assert.equal(h.text('tab-arm-note'), '');
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_ENDED'));
  // Start is the way on: with the record present it simply starts, and the host's next state replaces the alert.
  await h.click('btn-start');
  assert.deepEqual(h.types(), ['sw/lane-start']);
  await h.postState({ tab: running('tab') });
  assert.equal(h.text('tab-notice'), '');
});

test('a capture that stopped arriving is explained by ONE line, the alert, even when the record is still there; Start then opens the share dialog with the picking note only', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true, armed: true });
  await h.postState({ tab: failed('BROWSER_INTERRUPTED') });
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_INPUT_LOST'));
  assert.equal(h.text('tab-arm-note'), '', 'the arm note used to repeat the same click-the-icon instruction, plus the pin hint and the shortcut');
  assert.equal(h.attr('tab-arm-note', 'data-attention'), null);
  // The native TAB_INPUT_LOST code says the same thing.
  await h.postState({ tab: failed('TAB_INPUT_LOST') });
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_INPUT_LOST'));
  assert.equal(h.text('tab-arm-note'), '');
  // The record is spent. The worker drops it when the mint says the grant is gone and answers NEEDS_ARM (§20): the panel
  // retries once through the share dialog, and the picking note is the only text, because the dialog is not an error.
  const pick = deferred();
  h.setHandler(async (message) => {
    if (message.type !== 'sw/lane-start') return { ok: true };
    if (message.pick) return pick.promise;
    await h.stub.chrome.storage.session.remove(KEYS.armed);
    return { ok: false, code: 'NEEDS_ARM' };
  });
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [ARMED_START, PICK_START], 'the armed path was tried once, then the dialog');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
  pick.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
});

test('a tab that is gone: the alert says what to do, and no arm note repeats it', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  await h.postState({ tab: failed('TAB_GONE') });
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_GONE'));
  assert.equal(h.text('tab-arm-note'), '');
  await h.postState({});
  assert.match(h.text('tab-arm-note'), new RegExp(T('ext.arm.needed').slice(0, 20)), 'the note is back once the error is gone');
  assert.equal(h.text('tab-notice'), '');
});

// ---------------------------------------------------------------------------------------------
// §20: the icon click = start on this tab. The worker writes interp.autostart.v1 after the arming; the panel of that
// window acts on it once, if it is fresh and names the tab the panel targets.
test('§20 the icon\'s start request is acted on once, and only when it is fresh, for this window and for the tab this panel targets', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  await h.setSession(KEYS.armed, armedRecord());
  for (const [label, record] of [['another window', autostartRecord(h, { windowId: 2 })], ['another tab', autostartRecord(h, { tabId: 8 })],
    ['too old', autostartRecord(h, { at: h.browser.clock.now() - LIMITS.autostartMaxAgeMs - 1 })],
    ['malformed', { v: 2, tabId: 7, windowId: 1, at: h.browser.clock.now() }], ['no tab', { v: 1, windowId: 1, at: h.browser.clock.now() }]]) {
    await h.setSession(KEYS.autostart, record);
    assert.deepEqual(h.types(), [], label);
    assert.notEqual(h.browser.storageData('session')[KEYS.autostart], undefined, `${label}: left for the panel it belongs to`);
  }
  const record = autostartRecord(h);
  await h.setSession(KEYS.autostart, record);
  assert.deepEqual(laneStarts(h), [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 }]);
  assert.equal(h.browser.storageData('session')[KEYS.autostart], undefined, 'consumed');
  // The same click seen again (another event, a re-read) does not start a second time.
  await h.setSession(KEYS.autostart, record);
  assert.equal(laneStarts(h).length, 1);
  await h.browser.activateTab(7);
  await h.flush();
  assert.equal(laneStarts(h).length, 1);
});

test('§20 the icon that OPENED the panel: a request already written when the panel boots is acted on at boot', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true, begin: false });
  await h.stub.chrome.storage.session.set({ [KEYS.autostart]: autostartRecord(h) });
  await h.start();
  assert.deepEqual(laneStarts(h), [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 }]);
  // Without a key there is nothing to start (Start would be aria-disabled too).
  const keyless = await harness(t, { settings: settingsWith(), armed: true, key: false, begin: false });
  await keyless.stub.chrome.storage.session.set({ [KEYS.autostart]: autostartRecord(keyless) });
  await keyless.start();
  assert.deepEqual(keyless.types(), []);
});

test('§20 the icon on the tab the lane already interprets changes nothing; on ANOTHER tab it stops the lane there and starts it here', async (t) => {
  const same = await harness(t, { settings: settingsWith(), hostUp: true });
  await same.postState({ tab: running('tab', { tabId: 7 }) });
  await clickIcon(same);
  assert.deepEqual(same.types(), [], 'already interpreting this tab');

  const order = [];
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  h.setHandler(async (message) => { order.push([message.type, message.lane ?? null]); return { ok: true }; });
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  await clickIcon(h);
  assert.deepEqual(order, [['sw/lane-stop', 'tab'], ['sw/lane-start', 'tab']], 'the stop is answered before the start is sent');
  assert.deepEqual(laneStarts(h)[0], { v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 });
  assert.equal(h.text('stop-note'), '', 'the switch is not reported as a lost connection');

  // A lane the host could not name a tab for (a dialog start of an unlabelled page) is switched too.
  const unnamed = await harness(t, { settings: settingsWith(), hostUp: true });
  await unnamed.postState({ tab: running('tab', { tabId: null }) });
  await clickIcon(unnamed);
  assert.deepEqual(unnamed.types(), ['sw/lane-stop', 'sw/lane-start']);
});

test('§20 the icon while the share dialog is open: Start alone sent the pick start, the icon click stops it, and the armed start is sent once it has unwound', async (t) => {
  const pick = deferred();
  const h = await harness(t, { settings: settingsWith() });
  h.setHandler((message) => (message.type === 'sw/lane-start' && message.pick ? pick.promise : { ok: true }));
  await h.click('btn-start');
  assert.deepEqual(h.requests, [PICK_START], 'Start alone opens the dialog; there is no button to press first');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  await clickIcon(h);
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop'], 'the dialog start is cancelled first');
  assert.deepEqual(h.requests[1], { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'tab' });
  assert.equal(laneStarts(h).length, 1, 'the armed start waits until the cancelled dialog start has unwound');
  pick.resolve({ ok: false, code: 'START_CANCELLED' });   // the worker answers it once the host let go of the lane
  await h.flush();
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop', 'sw/lane-start']);
  assert.deepEqual(h.requests[2], ARMED_START, 'the instant path through the icon\'s grant: no pick');
  assert.equal(Object.hasOwn(h.requests[2], 'pick'), false);
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.ports.length, 1, 'the armed start succeeded and the panel connected');
  await h.postState({ tab: running('tab') });
  assert.equal(h.text('btn-start'), T('common.stop'));
  assert.equal(h.text('tab-arm-note'), '');
});

// §20 review (F2/UX-2): an icon start still in flight was taken as "here" whatever tab it was for, so the icon on
// another tab in that second was used up and the lane stayed on the first tab.
test('§20 the icon on ANOTHER tab while this panel\'s own icon start is still in flight: that start is stopped and the clicked tab starts', async (t) => {
  const first = deferred();
  const h = await harness(t, { settings: settingsWith() });
  h.browser.addTab({ id: 9, url: 'https://other.example.org/', windowId: 1, active: false, title: 'Other' });
  h.setHandler((message) => (message.type === 'sw/lane-start' && message.tabId === 7 ? first.promise : { ok: true }));
  await clickIcon(h);
  assert.deepEqual(h.types(), ['sw/lane-start']);
  // the same tab again while its start is in flight: nothing
  await clickIcon(h, { at: h.browser.clock.now() + 1 });
  assert.deepEqual(h.types(), ['sw/lane-start'], 'already starting on this tab');
  await h.browser.activateTab(9);
  await h.flush();
  await clickIcon(h, { tabId: 9 });
  assert.deepEqual(h.types(), ['sw/lane-start', 'sw/lane-stop'], 'the start on tab 7 is stopped first');
  assert.deepEqual(h.requests[1], { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'tab' });
  first.resolve({ ok: false, code: 'START_CANCELLED' });   // the worker answers it once the host let go of the lane
  await h.flush();
  assert.deepEqual(laneStarts(h).map((request) => request.tabId), [7, 9], 'then the clicked tab, through the instant path');
  assert.equal('pick' in laneStarts(h)[1], false);
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.ports.length, 1, 'the start on tab 9 succeeded and the panel connected');
});

// §20 review (F1): a panel the click itself opened had no host state yet and read that as "idle": it sent a start next
// to a lane that ran on another tab (refused as ALREADY_RUNNING without a word) and the click was lost.
test('§20 the icon in a panel that has no host state yet waits for the host\'s first state (at most 1.5 s) before it decides', async (t) => {
  const order = [];
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  h.setHandler(async (message) => { order.push([message.type, message.tabId ?? null]); return { ok: true }; });
  assert.equal(h.ports.length, 1, 'the host is up: the panel connected and waits for its state');
  await clickIcon(h);
  assert.deepEqual(order, [], 'nothing is decided without the host\'s word');
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  assert.deepEqual(order, [['sw/lane-stop', null], ['sw/lane-start', 7]], 'the lane ran on another tab: it moves here');

  const same = await harness(t, { settings: settingsWith(), hostUp: true });
  await clickIcon(same);
  await same.postState({ tab: running('tab', { tabId: 7 }) });
  assert.deepEqual(same.types(), [], 'it already interprets this tab');

  const idle = await harness(t, { settings: settingsWith(), hostUp: true });
  await clickIcon(idle);
  await idle.postState({});
  assert.deepEqual(laneStarts(idle).map((request) => request.tabId), [7], 'an idle host: the tab starts');

  // A host that does not answer: after 1.5 s the click is acted on as before (no state = idle).
  const silent = await harness(t, { settings: settingsWith(), hostUp: true });
  await clickIcon(silent);
  await silent.advance(1_499);
  assert.deepEqual(silent.types(), []);
  await silent.advance(1);
  assert.deepEqual(laneStarts(silent).map((request) => request.tabId), [7]);

  // No host at all: nothing to wait for.
  const none = await harness(t, { settings: settingsWith() });
  await clickIcon(none);
  assert.deepEqual(laneStarts(none).map((request) => request.tabId), [7]);
});

test('§20 icon clicks are handled one after the other, and the newest wins: a click overtaken while it waited is dropped', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  h.browser.addTab({ id: 9, url: 'https://other.example.org/', windowId: 1, active: false, title: 'Other' });
  await clickIcon(h);   // waits for the host's first state
  await h.browser.activateTab(9);
  await h.flush();
  await clickIcon(h, { tabId: 9 });
  assert.deepEqual(h.types(), []);
  assert.equal(h.browser.storageData('session')[KEYS.autostart], undefined, 'both clicks were consumed');
  await h.postState({});
  assert.deepEqual(h.types(), ['sw/lane-start'], 'one start, never two at once');
  assert.equal(laneStarts(h)[0].tabId, 9, 'the newest click');

  // Stop pressed while a click waits for the host's word drops the click too.
  const gate = deferred();
  const stopped = await harness(t, { settings: settingsWith(bothLanes), hostUp: true });
  stopped.setHandler((message) => (message.type === 'sw/lane-start' ? gate.promise : { ok: true }));
  await stopped.click('btn-start');   // the share dialog opens for the tab, the microphone starts next to it
  assert.deepEqual(laneStarts(stopped).map((request) => request.lane), ['tab', 'mic']);
  await clickIcon(stopped);
  await stopped.click('btn-start');   // Stop
  await stopped.postState({});
  gate.resolve({ ok: false, code: 'START_CANCELLED' });
  await stopped.flush();
  assert.deepEqual(laneStarts(stopped).map((request) => request.lane), ['tab', 'mic'], 'the click is not acted on after the Stop');
});

test('§20 the icon with the tab lane switched off starts only the lanes that are on (no surprise enabling)', async (t) => {
  const h = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; }) });
  await clickIcon(h);
  assert.deepEqual(laneStarts(h).map((request) => request.lane), ['mic']);
  assert.equal(h.stored().lanes.tab.enabled, false);
  const none = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; }) });
  await clickIcon(none);
  assert.deepEqual(none.types(), []);
  // the microphone permission is handled exactly as by Start: prompt opens the permission tab and waits
  const asking = await harness(t, { settings: settingsWith(bothLanes), micPermission: 'prompt' });
  await clickIcon(asking);
  assert.deepEqual(asking.types(), ['sw/lane-start', 'sw/permission-open']);
});

// ---------------------------------------------------------------------------------------------
// §20: "connected" with nothing coming out. A lane that hears speech for ~15 s in total since its start without one
// interpreted row says why that can be (the speech may already be in the target language).
test('§20 the quiet note: shown after ~15 s of heard speech with no interpreted row, once per run, cleared at the first output', async (t) => {
  const h = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.targetLanguage = 'ja'; }), hostUp: true });
  const heard = (extra = {}) => running('tab', { targetLanguage: 'ja', level: 20, epoch: 1, ...extra });
  await h.postState({ tab: heard() });
  await h.advance(14_000);
  assert.equal(h.text('tab-quiet-note'), '', 'not yet');
  await h.advance(1_000);
  assert.equal(h.text('tab-quiet-note'), T('ext.quiet.check', { language: T('language.ja') }));
  assert.equal(h.attr('tab-quiet-note', 'role'), 'status', 'a calm live note, not an alert');
  assert.equal(h.text('tab-notice'), '');
  // the first interpreted row clears it, and it does not come back in this run
  await h.post(captionsFrame('tab', [captionRow('r1', 'こんにちは')]));
  assert.equal(h.text('tab-quiet-note'), '');
  await h.advance(30_000);
  assert.equal(h.text('tab-quiet-note'), '');
  // a new run (epoch) counts from zero again
  await h.postState({ tab: heard({ epoch: 2 }) });
  await h.advance(15_000);
  assert.equal(h.text('tab-quiet-note'), T('ext.quiet.check', { language: T('language.ja') }));
  // and it goes when the lane stops
  await h.postState({});
  assert.equal(h.text('tab-quiet-note'), '');
});

test('§20 the quiet note: not while the input is (near) silent, not when output arrived early, never for a two-way lane, per lane', async (t) => {
  const silent = await harness(t, { settings: settingsWith(), hostUp: true });
  await silent.postState({ tab: running('tab', { level: 1, epoch: 1 }) });
  await silent.advance(60_000);
  assert.equal(silent.text('tab-quiet-note'), '', 'nothing heard: nothing to explain');
  // speech heard only in part: the time with speech is what counts (5 s heard, then silence)
  await silent.postState({ tab: running('tab', { level: 30, epoch: 1 }) });
  await silent.advance(5_000);
  await silent.postState({ tab: running('tab', { level: 0, epoch: 1 }) });
  await silent.advance(30_000);
  assert.equal(silent.text('tab-quiet-note'), '');

  const early = await harness(t, { settings: settingsWith(), hostUp: true });
  await early.postState({ tab: running('tab', { level: 30, epoch: 1 }) });
  await early.post(captionsFrame('tab', [captionRow('r1', 'hello')]));
  await early.advance(60_000);
  assert.equal(early.text('tab-quiet-note'), '', 'output arrived');

  // a source row (when shown) is not an interpreted row
  const source = await harness(t, { settings: settingsWith(), hostUp: true });
  await source.postState({ tab: running('tab', { level: 30, epoch: 1 }) });
  await source.post(captionsFrame('tab', [captionRow('s1', 'heard', { role: 'source' })]));
  await source.advance(15_000);
  assert.notEqual(source.text('tab-quiet-note'), '');

  const twoWay = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.twoWay = true; }), hostUp: true });
  await twoWay.postState({ tab: running('tab', { level: 30, epoch: 1 }) });
  await twoWay.advance(60_000);
  assert.equal(twoWay.text('tab-quiet-note'), '', 'a two-way lane interprets either language');

  const both = await harness(t, { settings: settingsWith(bothLanes), hostUp: true });
  await both.postState({ tab: running('tab', { level: 30, epoch: 1 }), mic: running('mic', { level: 30, epoch: 1, targetLanguage: 'en' }) });
  await both.post(captionsFrame('tab', [captionRow('r1', 'hello')]));
  await both.advance(15_000);
  assert.equal(both.text('tab-quiet-note'), '');
  assert.equal(both.text('mic-quiet-note'), T('ext.quiet.check', { language: T('language.en') }), 'each lane counts its own run');
});

test('2026-09-30: the panel shows the reason of an INVALID_RESULT after the notice, in parentheses, in the alert itself', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true, armed: true });
  await h.postState({ tab: failed('INVALID_RESULT', { errorReason: 'audio-encoding' }) });
  assert.equal(h.text('tab-notice'), `${T('error.INVALID_RESULT')} (INVALID_RESULT · audio-encoding)`);
  assert.equal(h.attr('tab-notice', 'role'), 'alert');
  await h.postState({ tab: failed('INVALID_RESULT') });
  assert.equal(h.text('tab-notice'), T('error.INVALID_RESULT'), 'no reason: the sentence alone');
  await h.postState({ tab: failed('NETWORK_ERROR') });
  assert.equal(h.text('tab-notice'), T('error.NETWORK_ERROR'));
});

test('ALREADY_RUNNING and START_CANCELLED are ignored, LANE_STOPPING and other codes are shown', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true });
  for (const code of ['ALREADY_RUNNING', 'START_CANCELLED']) {
    h.setHandler(() => ({ ok: false, code }));
    await h.click('btn-start');
    assert.equal(h.text('tab-notice'), '', code);
    assert.equal(h.attr('status-pill', 'data-state'), 'idle', code);
    assert.equal(h.text('btn-start'), T('common.start'), code);
  }
  h.setHandler(() => ({ ok: false, code: 'LANE_STOPPING' }));
  await h.click('btn-start');
  assert.equal(h.text('tab-notice'), T('ext.error.LANE_STOPPING'));
  assert.equal(h.attr('tab-notice', 'role'), 'alert');
  h.setHandler(() => ({ ok: false, code: 'TAB_CAPTURE_BUSY' }));
  await h.click('btn-start');
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_CAPTURE_BUSY'));
  // the next Start clears the old error first
  h.setHandler(() => ({ ok: true }));
  await h.click('btn-start');
  assert.equal(h.text('tab-notice'), '');
  // a rejected or unanswered message reads as an unavailable engine
  const silent = await harness(t, { settings: settingsWith(), armed: true });
  silent.setHandler(() => undefined);
  await silent.click('btn-start');
  assert.equal(silent.text('tab-notice'), T('ext.error.HOST_UNAVAILABLE'));
});

test('an answer without ok === true is a failure, whatever else it says', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true });
  h.setHandler(() => ({ ok: 'yes', code: 'lowercase' }));
  await h.click('btn-start');
  assert.equal(h.text('tab-notice'), T('ext.error.HOST_UNAVAILABLE'));
  h.setHandler(() => 'fine');
  await h.click('btn-start');
  assert.equal(h.text('tab-notice'), T('ext.error.HOST_UNAVAILABLE'));
});

test('the microphone gate (§17): prompt opens the permission tab and waits, denied opens it and says so; granted and unknown proceed', async (t) => {
  const mic = settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; });
  const blocked = await harness(t, { settings: mic, micPermission: 'denied' });
  assert.equal(blocked.text('mic-permission-status'), `${T('permission.title')} · ${T('permission.denied')}`);
  assert.equal(blocked.el('btn-mic-allow').hidden, false);
  await blocked.click('btn-start');
  assert.deepEqual(blocked.types(), ['sw/permission-open'], 'no lane-start: the host would only fail the same way');
  assert.equal(blocked.text('mic-notice'), T('ext.error.MICROPHONE_DENIED'));
  assert.equal(blocked.attr('btn-mic-permission', 'data-attention'), 'true');
  assert.equal(blocked.attr('btn-mic-allow', 'data-attention'), 'true');
  assert.equal(blocked.attr('mic-notice', 'role'), 'alert');

  const asked = await harness(t, { settings: mic, micPermission: 'prompt' });
  await asked.click('btn-start');
  assert.deepEqual(asked.types(), ['sw/permission-open'], 'the permission tab opens by itself');
  assert.equal(asked.text('mic-notice'), '', 'waiting for an answer is not an error');
  assert.equal(asked.text('mic-permission-status'),
    `${T('permission.title')} · ${T('permission.prompt')} · ${T('ext.mic.permissionWaiting')}`);
  assert.equal(asked.text('btn-start'), T('common.stop'), 'the wait can be cancelled');
  asked.audio.setMicPermission('granted');
  await asked.flush();
  assert.deepEqual(asked.types(), ['sw/permission-open', 'sw/lane-start'], 'the grant starts the lane without a second press');
  assert.equal(asked.text('mic-permission-status'), `${T('permission.title')} · ${T('permission.granted')}`);
  const granted = await harness(t, { settings: mic, micPermission: 'granted' });
  assert.equal(granted.text('mic-permission-status'), `${T('permission.title')} · ${T('permission.granted')}`);
  assert.equal(granted.el('btn-mic-allow').hidden, true);
  await granted.click('btn-start');
  assert.deepEqual(granted.requests, [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' }]);

  for (const permissionsMode of ['missing', 'throws']) {
    const unknown = await harness(t, { settings: mic, permissionsMode });
    assert.equal(unknown.text('mic-permission-status'), T('permission.checking'), permissionsMode);
    await unknown.click('btn-start');
    assert.deepEqual(unknown.types(), ['sw/lane-start'], `${permissionsMode}: the host preflight decides`);
  }
});

test('the microphone permission is watched live and an expired one-time grant is asked for again (§17)', async (t) => {
  const mic = settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; });
  const h = await harness(t, { settings: mic, micPermission: 'denied' });
  assert.equal(h.el('btn-mic-allow').hidden, false);
  h.audio.setMicPermission('granted');
  await h.flush();
  assert.equal(h.text('mic-permission-status'), `${T('permission.title')} · ${T('permission.granted')}`);
  assert.equal(h.el('btn-mic-allow').hidden, true);
  assert.equal(h.text('mic-notice'), '');
  h.audio.setMicPermission('prompt');
  await h.flush();
  assert.equal(h.text('mic-notice'), '', 'prompt alone is not an error');
  await h.click('btn-start');
  assert.deepEqual(h.types(), ['sw/permission-open'], '§17: the expired grant is asked for again');
  assert.equal(h.text('mic-notice'), '');
  h.audio.setMicPermission('denied');
  await h.flush();
  // Refused this time: a refusal, not an expiry (the expiry wording is for a prompt state, which now opens the tab instead).
  assert.equal(h.text('mic-notice'), T('ext.error.MICROPHONE_DENIED'));
  assert.equal(h.attr('btn-mic-permission', 'data-attention'), 'true');
  assert.deepEqual(h.types(), ['sw/permission-open'], 'a refusal starts nothing');
});

test('a refusal recorded while the microphone permission was missing is gone the moment it is granted (notice, failed pill, attention)', async (t) => {
  const mic = settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; });
  const h = await harness(t, { settings: mic, micPermission: 'denied' });
  await h.click('btn-start');
  assert.deepEqual(h.types(), ['sw/permission-open'], 'the gate refused: only the permission tab (§17) is asked for');
  assert.equal(h.text('mic-notice'), T('ext.error.MICROPHONE_DENIED'));
  assert.equal(h.text('status-pill'), T('ext.status.failed'));
  assert.equal(h.attr('status-pill', 'data-state'), 'error');
  assert.equal(h.attr('btn-mic-allow', 'data-attention'), 'true');
  assert.equal(h.el('btn-mic-allow').hidden, false);
  // The permission tab grants it: the panel hears about it through PermissionStatus.onchange.
  h.audio.setMicPermission('granted');
  await h.flush();
  assert.equal(h.text('mic-permission-status'), `${T('permission.title')} · ${T('permission.granted')}`);
  assert.equal(h.el('btn-mic-allow').hidden, true);
  // Before the fix the notice kept sending the user to the (now hidden) Allow button, the pill stayed "failed" and the
  // two microphone buttons kept their attention outline, all next to a line that said "Allowed".
  assert.equal(h.text('mic-notice'), '');
  assert.equal(h.text('status-pill'), T('sim.status.idle'));
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.attr('btn-mic-permission', 'data-attention'), null);
  assert.equal(h.attr('btn-mic-allow', 'data-attention'), null);
  assert.equal(h.text('mic-status'), T('ext.lane.statusLine', { lane: T('ext.lane.mic.title'), status: T('sim.status.idle') }));
  // And the next Start is an ordinary start (a blocked microphone never starts by itself: the user presses Start again).
  await h.click('btn-start');
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' });
});

test('granting the permission clears only the panel\'s own refusal: an error the host reported, or another local error, stays', async (t) => {
  const mic = settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; });
  const host = await harness(t, { settings: mic, micPermission: 'denied', hostUp: true });
  await host.postState({ mic: failed('MICROPHONE_UNAVAILABLE') });
  assert.equal(host.text('mic-notice'), T('ext.error.MICROPHONE_UNAVAILABLE'));
  host.audio.setMicPermission('granted');
  await host.flush();
  assert.equal(host.text('mic-notice'), T('ext.error.MICROPHONE_UNAVAILABLE'), 'the host still says the microphone could not be opened');

  const other = await harness(t, { settings: mic, micPermission: 'granted' });
  other.setHandler(() => ({ ok: false, code: 'HOST_UNAVAILABLE' }));
  await other.click('btn-start');
  assert.equal(other.text('mic-notice'), T('ext.error.HOST_UNAVAILABLE'));
  other.audio.setMicPermission('prompt');
  await other.flush();
  other.audio.setMicPermission('granted');
  await other.flush();
  assert.equal(other.text('mic-notice'), T('ext.error.HOST_UNAVAILABLE'), 'a granted event does not erase an unrelated failure');

  // denied at load, then granted (the case that always worked) still clears
  const denied = await harness(t, { settings: mic, micPermission: 'denied' });
  assert.equal(denied.text('mic-notice'), T('ext.error.MICROPHONE_DENIED'));
  denied.audio.setMicPermission('granted');
  await denied.flush();
  assert.equal(denied.text('mic-notice'), '');
});

test('the permission buttons ask the worker to open the permission tab; the options buttons open the options page', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  h.setHandler(() => ({ ok: true, tabId: 12 }));
  await h.click('btn-mic-permission');
  await h.click('btn-mic-allow');
  assert.deepEqual(h.requests, [
    { v: 1, target: 'sw', type: 'sw/permission-open' },
    { v: 1, target: 'sw', type: 'sw/permission-open' },
  ]);
  await h.click('btn-options');
  assert.equal(h.browser.optionsOpens, 1);
});

test('Stop, Cancel and unchecking a lane send sw/lane-stop and never a host message', async (t) => {
  const h = await harness(t, { settings: settingsWith(bothLanes), hostUp: true, armed: true });
  await h.postState({ tab: running('tab'), mic: running('mic') });
  assert.equal(h.text('btn-start'), T('common.stop'));
  await h.click('btn-start');
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-stop' }, 'no lane field: both');
  // unchecking one lane while the host runs: persist first, then stop that lane only
  await h.click('tab-enabled');
  assert.equal(h.stored().lanes.tab.enabled, false);
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'tab' });
  // checking a lane while the host runs: persist first, then start that lane
  await h.click('tab-enabled');
  assert.equal(h.stored().lanes.tab.enabled, true);
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 });
  const sent = h.browser.deliveries.filter((entry) => entry.from === 'panel' && entry.kind === 'message').map((entry) => JSON.parse(entry.json).type);
  assert.deepEqual(sent, ['sw/lane-stop', 'sw/lane-stop', 'sw/lane-start']);
  for (const type of sent) assert.match(type, /^sw\//, 'the panel only talks to the service worker');
});

test('toggling a lane while idle only persists the choice', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true });
  await h.click('mic-enabled');
  await h.click('tab-enabled');
  await h.click('tab-enabled');
  assert.equal(h.stored().lanes.mic.enabled, true);
  assert.equal(h.stored().lanes.tab.enabled, true);
  assert.deepEqual(h.types(), []);
  assert.equal(h.text('usage-note'), T('ext.usage.twoSessions'));
});

test('every control writes exactly one field', async (t) => {
  const cases = [
    ['tab-target', async (h) => h.choose('tab-target', 'ja'), 'lanes.tab.targetLanguage'],
    ['mic-target', async (h) => h.choose('mic-target', 'ko'), 'lanes.mic.targetLanguage'],
    ['tab-captions', async (h) => h.click('tab-captions'), 'lanes.tab.captions'],
    ['mic-captions', async (h) => h.click('mic-captions'), 'lanes.mic.captions'],
    ['tab-two-way', async (h) => h.click('tab-two-way'), 'lanes.tab.twoWay'],
    ['mic-two-way', async (h) => h.click('mic-two-way'), 'lanes.mic.twoWay'],
    ['tab-partner', async (h) => h.choose('tab-partner', 'ja'), 'lanes.tab.partnerLanguage'],
    ['mic-partner', async (h) => h.choose('mic-partner', 'ko'), 'lanes.mic.partnerLanguage'],
    ['tab-enabled', async (h) => h.click('tab-enabled'), 'lanes.tab.enabled'],
    ['mic-enabled', async (h) => h.click('mic-enabled'), 'lanes.mic.enabled'],
    ['btn-mute', async (h) => h.click('btn-mute'), 'speechMuted'],
  ];
  for (const [name, act, path] of cases) {
    const h = await harness(t, { settings: settingsWith() });
    const before = JSON.parse(JSON.stringify(h.stored()));
    const writes = h.localSets.filter((entry) => KEYS.settings in entry.items).length;
    await act(h);
    assert.deepEqual(changedPaths(before, h.stored()), [path], name);
    assert.equal(h.localSets.filter((entry) => KEYS.settings in entry.items).length - writes, 1, `${name}: exactly one storage write`);
  }
  // a value the schema rejects is normalized, never stored raw
  const h = await harness(t, { settings: settingsWith() });
  await h.choose('tab-target', 'xx');
  assert.ok(['ko', 'en', 'ja'].includes(h.stored().lanes.tab.targetLanguage), 'the stored value is always a valid language');
});

// ---------------------------------------------------------------------------------------------
// Two-way mode in the controller (twoWaySettings: tab en <-> ja, microphone ko <-> en)
// ---------------------------------------------------------------------------------------------

const optionValuesOf = (h, id) => h.el(id).options.map((option) => option.value);
const TWO_WAY_ELEMENTS = ['tab-two-way', 'tab-partner-row', 'tab-partner', 'tab-two-way-hint', 'tab-two-way-note', 'tab-target-label',
  'mic-two-way', 'mic-partner-row', 'mic-partner', 'mic-two-way-hint', 'mic-two-way-note', 'mic-target-label'];
// 8.2.1: nothing that goes hidden -> visible may be live, so these elements never get a role or aria-live from a render.
const assertNotLive = (h, label) => {
  for (const id of TWO_WAY_ELEMENTS) {
    assert.equal(h.attr(id, 'role'), null, `${label}: #${id} has no role`);
    assert.equal(h.attr(id, 'aria-live'), null, `${label}: #${id} is not aria-live`);
  }
};

test('two-way: the panel renders the stored choice (checkbox, partner row, options without the first language, label, model note)', async (t) => {
  const idle = await harness(t, { settings: settingsWith() });
  for (const lane of ['tab', 'mic']) {
    assert.equal(idle.el(`${lane}-two-way`).checked, false, `${lane}: one-way by default`);
    assert.equal(idle.el(`${lane}-partner-row`).hidden, true, `${lane}: the partner row is hidden while two-way is off`);
    assert.equal(idle.el(`${lane}-two-way-note`).hidden, true);
    assert.equal(idle.text(`${lane}-target-label`), T('language.target'));
    assert.equal(idle.attr(`${lane}-target-label`, 'data-i18n'), 'language.target');
    assert.equal(idle.text(`${lane}-two-way-hint`), T('ext.twoWay.hint'), 'the hint is always there');
    assert.equal(idle.el(`${lane}-two-way-hint`).hidden, false);
  }
  // Defaults for 'en': the tab lane targets en (partner ko), the microphone lane targets ja (partner en).
  assert.deepEqual(optionValuesOf(idle, 'tab-partner'), ['ko', 'ja']);
  assert.equal(idle.el('tab-partner').value, 'ko');
  assert.deepEqual(optionValuesOf(idle, 'mic-partner'), ['ko', 'en']);
  assert.equal(idle.el('mic-partner').value, 'en');
  assert.deepEqual(idle.el('tab-partner').options.map((option) => option.textContent), [T('language.ko'), T('language.ja')]);
  assertNotLive(idle, 'idle');

  const on = await harness(t, { settings: twoWaySettings() });
  assert.equal(on.el('tab-two-way').checked, true);
  assert.equal(on.el('mic-two-way').checked, true);
  for (const lane of ['tab', 'mic']) {
    assert.equal(on.el(`${lane}-partner-row`).hidden, false, `${lane}: the partner row shows while two-way is on`);
    assert.equal(on.text(`${lane}-target-label`), T('ext.twoWay.targetLabel'), `${lane}: the first select is "First language"`);
    assert.equal(on.attr(`${lane}-target-label`, 'data-i18n'), 'ext.twoWay.targetLabel', 'the binder key follows, so a language change keeps it');
  }
  assert.deepEqual(optionValuesOf(on, 'tab-partner'), ['ko', 'ja'], 'the tab target is en');
  assert.equal(on.el('tab-partner').value, 'ja');
  assert.deepEqual(optionValuesOf(on, 'mic-partner'), ['en', 'ja'], 'the microphone target is ko');
  assert.equal(on.el('mic-partner').value, 'en');
  // The note only where the lane's model is the translation-only one: the tab lane in this fixture, not the microphone lane.
  assert.equal(on.el('tab-two-way-note').hidden, false);
  assert.equal(on.text('tab-two-way-note'), T('ext.twoWay.modelNote'));
  assert.equal(on.el('mic-two-way-note').hidden, true);
  assertNotLive(on, 'on');
  // Every language option of a partner select comes from the dictionary (never the bare code).
  for (const option of on.el('mic-partner').options) assert.equal(option.textContent, T(`language.${option.value}`));
});

test('two-way: the note follows the lane model, not only the checkbox (the microphone lane on the translation-only model)', async (t) => {
  const h = await harness(t, { settings: twoWaySettings((s) => { s.lanes.mic.model = TRANSLATE_LIVE_MODEL; s.lanes.tab.model = DEFAULT_LIVE_MODEL; }) });
  assert.equal(h.el('tab-two-way-note').hidden, true, 'the tab lane already uses the instruction-driven model');
  assert.equal(h.el('mic-two-way-note').hidden, false);
  await h.click('mic-two-way');
  assert.equal(h.el('mic-two-way-note').hidden, true, 'one-way: the translation model is fine');
  await h.click('mic-two-way');
  assert.equal(h.el('mic-two-way-note').hidden, false);
  await h.patchSettings((s) => { s.lanes.mic.model = DEFAULT_LIVE_MODEL; });
  assert.equal(h.el('mic-two-way-note').hidden, true, 'the model changed on the options page: the panel follows');
  assertNotLive(h, 'model changes');
});

test('two-way: the model note goes away while the lane runs on a backup model and comes back when it stops', async (t) => {
  const h = await harness(t, { settings: twoWaySettings(), hostUp: true, armed: true });
  const backup = 'gemini-2.5-flash-native-audio-latest';
  await h.postState({ tab: running('tab', { targetLanguage: 'en', model: PAIR_MODEL, route: 'flash' }) });
  assert.equal(h.el('tab-two-way-note').hidden, false, 'running on the pair model: the note is true');
  await h.postState({ tab: running('tab', { targetLanguage: 'en', model: backup, route: 'flash', fallback: true }) });
  assert.equal(h.text('tab-route'), `${T('ext.route.fallback')} · ${backup}`);
  assert.equal(h.el('tab-two-way-note').hidden, true, 'the route line names the backup model, the note must not say otherwise');
  await h.postState({});
  assert.equal(h.el('tab-two-way-note').hidden, false, 'stopped: the next start uses the pair model again');
});

test('two-way: toggling saves the setting, shows or hides the partner row and the label wording, and touches nothing else', async (t) => {
  const h = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.model = TRANSLATE_LIVE_MODEL; }), armed: true });
  const writes = () => h.localSets.filter((entry) => KEYS.settings in entry.items).length;
  const before = JSON.parse(JSON.stringify(h.stored()));
  const written = writes();
  await h.click('tab-two-way');
  assert.equal(h.stored().lanes.tab.twoWay, true, 'saved');
  assert.equal(writes() - written, 1, 'exactly one write');
  assert.deepEqual(changedPaths(before, h.stored()), ['lanes.tab.twoWay']);
  assert.equal(h.el('tab-partner-row').hidden, false);
  assert.equal(h.text('tab-target-label'), T('ext.twoWay.targetLabel'));
  assert.equal(h.el('tab-two-way-note').hidden, false, 'the tab lane is on the translation-only model (a choice since 0.5.1)');
  assert.equal(h.el('mic-partner-row').hidden, true, 'the other lane is untouched');
  assert.equal(h.text('mic-target-label'), T('language.target'));
  assert.deepEqual(h.types(), [], 'a setting is not a command: nothing is sent while idle');
  assertNotLive(h, 'toggled on');
  await h.click('tab-two-way');
  assert.equal(h.stored().lanes.tab.twoWay, false);
  assert.equal(h.el('tab-partner-row').hidden, true);
  assert.equal(h.text('tab-target-label'), T('language.target'));
  assert.equal(h.el('tab-two-way-note').hidden, true);
  assertNotLive(h, 'toggled off');
  // the partner chosen while on is kept for the next time
  await h.click('tab-two-way');
  await h.choose('tab-partner', 'ja');
  await h.click('tab-two-way');
  await h.click('tab-two-way');
  assert.equal(h.stored().lanes.tab.partnerLanguage, 'ja');
  assert.equal(h.el('tab-partner').value, 'ja');
});

test('two-way: the partner select saves its choice on its own lane only', async (t) => {
  const h = await harness(t, { settings: twoWaySettings() });
  const before = JSON.parse(JSON.stringify(h.stored()));
  await h.choose('tab-partner', 'ko');
  assert.equal(h.stored().lanes.tab.partnerLanguage, 'ko');
  assert.deepEqual(changedPaths(before, h.stored()), ['lanes.tab.partnerLanguage']);
  assert.equal(h.el('tab-partner').value, 'ko');
  assert.equal(h.stored().lanes.mic.partnerLanguage, 'en');
  // a value the select does not offer (the first language itself) never ends up stored as the partner
  await h.choose('tab-partner', 'en');
  assert.notEqual(h.stored().lanes.tab.partnerLanguage, h.stored().lanes.tab.targetLanguage, 'the pair stays two different languages');
  assert.equal(h.stored().lanes.tab.targetLanguage, 'en');
});

test('two-way: choosing the partner as the first language moves the partner to the language just left, and the pair is saved with it', async (t) => {
  // ko <-> ja. The default partner of ja would be en, so a swap (ko) is told apart from the settings' own repair.
  const h = await harness(t, { settings: twoWaySettings((s) => { s.lanes.tab.targetLanguage = 'ko'; s.lanes.tab.partnerLanguage = 'ja'; }) });
  const writes = () => h.localSets.filter((entry) => KEYS.settings in entry.items).length;
  const written = writes();
  const before = JSON.parse(JSON.stringify(h.stored()));
  await h.choose('tab-target', 'ja');
  assert.equal(h.stored().lanes.tab.targetLanguage, 'ja');
  assert.equal(h.stored().lanes.tab.partnerLanguage, 'ko', 'the language just left takes the partner place');
  assert.deepEqual(changedPaths(before, h.stored()).sort(), ['lanes.tab.partnerLanguage', 'lanes.tab.targetLanguage']);
  assert.equal(writes() - written, 1, 'one write carries both fields');
  assert.deepEqual(optionValuesOf(h, 'tab-partner'), ['ko', 'en'], 'the partner select no longer offers the first language');
  assert.equal(h.el('tab-partner').value, 'ko');
  assert.equal(h.el('tab-target').value, 'ja');
  // a first language that is not the partner leaves the partner alone
  await h.choose('tab-target', 'en');
  assert.equal(h.stored().lanes.tab.partnerLanguage, 'ko');
  assert.deepEqual(optionValuesOf(h, 'tab-partner'), ['ko', 'ja']);
  assert.equal(h.el('tab-partner').value, 'ko');
  // the same holds while two-way is off (the row is hidden but the pair must stay valid for the next time)
  const off = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.targetLanguage = 'ko'; s.lanes.tab.partnerLanguage = 'ja'; }) });
  await off.choose('tab-target', 'ja');
  assert.deepEqual([off.stored().lanes.tab.targetLanguage, off.stored().lanes.tab.partnerLanguage], ['ja', 'ko']);
  assert.equal(off.stored().lanes.tab.twoWay, false);
  // the microphone lane's pair is its own
  assert.deepEqual([h.stored().lanes.mic.targetLanguage, h.stored().lanes.mic.partnerLanguage], ['ko', 'en']);
});

test('two-way: a stored pair that is not two languages, or a record from before two-way, is repaired on load', async (t) => {
  const raw = JSON.parse(JSON.stringify(twoWaySettings()));
  raw.lanes.tab.partnerLanguage = raw.lanes.tab.targetLanguage;   // hand-edited: partner == target
  const broken = await harness(t, { settings: raw });
  assert.notEqual(broken.el('tab-partner').value, broken.el('tab-target').value);
  assert.ok(!optionValuesOf(broken, 'tab-partner').includes(broken.el('tab-target').value), 'the first language is never a partner choice');
  assert.equal(broken.el('tab-partner').value, 'ko', 'the default partner of en');

  const legacy = JSON.parse(JSON.stringify(settingsWith()));
  for (const lane of ['tab', 'mic']) { delete legacy.lanes[lane].twoWay; delete legacy.lanes[lane].partnerLanguage; }
  const old = await harness(t, { settings: legacy });
  assert.equal(old.el('tab-two-way').checked, false);
  assert.equal(old.el('tab-partner-row').hidden, true);
  assert.equal(old.el('tab-partner').value, 'ko');
  assert.equal(old.localSets.filter((entry) => KEYS.settings in entry.items).length, 0, 'reading a stored record never rewrites it');
});

test('two-way: a storage failure snaps the controls back and the partner row stays as stored', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  h.failWrites(true);
  await h.click('tab-two-way');
  assert.equal(h.el('tab-two-way').checked, false);
  assert.equal(h.el('tab-partner-row').hidden, true);
  assert.equal(h.stored().lanes.tab.twoWay, false);
  h.failWrites(false);
  await h.click('tab-two-way');
  assert.equal(h.el('tab-two-way').checked, true);
  assert.equal(h.el('tab-partner-row').hidden, false);
});

test('two-way: another window or the options page changing the setting is followed by the panel', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  await h.patchSettings((s) => { s.lanes.mic.twoWay = true; s.lanes.mic.targetLanguage = 'ko'; s.lanes.mic.partnerLanguage = 'ja'; });
  assert.equal(h.el('mic-two-way').checked, true);
  assert.equal(h.el('mic-partner-row').hidden, false);
  assert.deepEqual(optionValuesOf(h, 'mic-partner'), ['en', 'ja']);
  assert.equal(h.el('mic-partner').value, 'ja');
  assert.equal(h.text('mic-target-label'), T('ext.twoWay.targetLabel'));
});

test('two-way: the labels, the partner options, the hint and the note follow the UI language', async (t) => {
  const h = await harness(t, { settings: twoWaySettings((s) => { s.uiLanguage = 'ko'; }) });
  const texts = (language) => ({
    label: REF[language].t('ext.twoWay.targetLabel'), hint: REF[language].t('ext.twoWay.hint'), note: REF[language].t('ext.twoWay.modelNote'),
    partner: REF[language].t('ext.twoWay.partner'), options: ['ko', 'ja'].map((code) => REF[language].t(`language.${code}`)),
  });
  const read = () => ({ label: h.text('tab-target-label'), hint: h.text('tab-two-way-hint'), note: h.text('tab-two-way-note'),
    partner: h.el('tab-partner').closest('label').querySelector('span').textContent, options: h.el('tab-partner').options.map((option) => option.textContent) });
  assert.deepEqual(read(), texts('ko'));
  assert.match(texts('ko').hint, /요\.$/);
  await h.patchSettings((s) => { s.uiLanguage = 'ja'; });
  assert.deepEqual(read(), texts('ja'));
  assert.equal(h.text('tab-target-label'), REF.ja.t('ext.twoWay.targetLabel'), 'the two-way wording survives the language change');
  await h.patchSettings((s) => { s.uiLanguage = 'en'; });
  assert.deepEqual(read(), texts('en'));
  // ...and turning it off puts the one-way label back in the current language
  await h.click('tab-two-way');
  assert.equal(h.text('tab-target-label'), REF.en.t('language.target'));
  await h.patchSettings((s) => { s.uiLanguage = 'ko'; });
  assert.equal(h.text('tab-target-label'), REF.ko.t('language.target'));
});

test('two-way: switching it while a lane runs changes nothing at once and shows the applies-next hint; the swapped model is no false alarm', async (t) => {
  const h = await harness(t, { settings: twoWaySettings((s) => { s.lanes.mic.enabled = false; }), hostUp: true, armed: true });
  await h.click('btn-start');   // the tab lane starts with two-way on (translation-only model in the settings)
  assert.deepEqual(h.types(), ['sw/lane-start']);
  // The engine runs the pair on the instruction-driven model and reports THAT model.
  await h.postState({ tab: running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' }) });
  assert.equal(h.text('tab-apply-next'), '', 'the model swap of a pair is not a pending change');
  await h.choose('tab-partner', 'ko');
  assert.equal(h.text('tab-apply-next'), T('ext.applyNext'), 'a changed partner applies from the next start');
  await h.choose('tab-partner', 'ja');
  assert.equal(h.text('tab-apply-next'), '', 'back to what runs: the hint goes away');
  await h.click('tab-two-way');
  assert.equal(h.text('tab-apply-next'), T('ext.applyNext'), 'switching two-way off is a change for the next start too');
  assert.equal(h.el('tab-partner-row').hidden, true);
  await h.click('tab-two-way');
  assert.equal(h.text('tab-apply-next'), '');
  assert.equal(h.text('mic-apply-next'), '', 'the other lane is not running');
  assert.deepEqual(h.types(), ['sw/lane-start'], 'nothing was restarted: the change applies from the next start');
  assert.equal(h.el('tab-apply-next').hidden, false, 'the live region is never hidden');
  assert.equal(h.attr('tab-apply-next', 'role'), 'status');

  // A one-way run, then two-way switched on.
  const oneWay = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.targetLanguage = 'en'; s.lanes.tab.model = DEFAULT_LIVE_MODEL; }), hostUp: true, armed: true });
  await oneWay.click('btn-start');
  await oneWay.postState({ tab: running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' }) });
  assert.equal(oneWay.text('tab-apply-next'), '');
  await oneWay.click('tab-two-way');
  assert.equal(oneWay.text('tab-apply-next'), T('ext.applyNext'));
  // The run ends and a new one starts with two-way: the record is the new start's, so nothing is pending.
  await oneWay.postState({});
  assert.equal(oneWay.text('tab-apply-next'), '');
  await oneWay.click('btn-start');
  await oneWay.postState({ tab: running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash', epoch: 2 }) });
  assert.equal(oneWay.text('tab-apply-next'), '', 'the second run started with two-way on');
  await oneWay.click('tab-two-way');
  assert.equal(oneWay.text('tab-apply-next'), T('ext.applyNext'), 'and switching it off now is the pending change');

  // A lane this panel did not start says nothing about two-way (it does not know how it was started).
  const unknown = await harness(t, { settings: twoWaySettings((s) => { s.lanes.mic.enabled = false; }), hostUp: true });
  await unknown.postState({ tab: running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' }) });
  await unknown.choose('tab-partner', 'ko');
  assert.equal(unknown.text('tab-apply-next'), '');
});

test('two-way: a start that fails leaves no record behind, so a later change is not called pending', async (t) => {
  const h = await harness(t, { settings: twoWaySettings((s) => { s.lanes.mic.enabled = false; }), hostUp: true, armed: true });
  h.setHandler(() => ({ ok: false, code: 'TAB_CAPTURE_FAILED' }));
  await h.click('btn-start');
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_CAPTURE_FAILED'));
  h.setHandler(() => ({ ok: true }));
  await h.postState({ tab: running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' }) });
  await h.choose('tab-partner', 'ko');
  assert.equal(h.text('tab-apply-next'), '', 'no accepted start, no record: nothing is claimed');
});

test('two-way: after a lost connection the panel no longer claims to know how the run was started', async (t) => {
  const h = await harness(t, { settings: twoWaySettings((s) => { s.lanes.mic.enabled = false; }), hostUp: true, armed: true });
  h.setHandler((message) => (message.type === 'sw/host-probe' ? { ok: true, up: true } : { ok: true }));
  await h.click('btn-start');
  const swapped = running('tab', { targetLanguage: 'en', model: DEFAULT_LIVE_MODEL, route: 'flash' });
  await h.postState({ tab: swapped });
  await h.choose('tab-partner', 'ko');
  assert.equal(h.text('tab-apply-next'), T('ext.applyNext'), 'known start: the changed partner is pending');
  h.host().port.disconnect();
  await h.advance(6000);
  assert.equal(h.ports.length, 2, 'the probe found the host alive and the panel reconnected');
  await h.postState({ tab: swapped });
  assert.equal(h.text('tab-apply-next'), '', 'the record went with the connection: no claim until the next start');
});

test('two-way: the request the panel sends carries no key and no language pair of its own (the worker builds it from the stored settings)', async (t) => {
  const h = await harness(t, { settings: twoWaySettings(), armed: true, hostUp: true });
  await h.click('btn-start');
  assert.deepEqual(h.requests, [
    { v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 },
    { v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' },
  ], 'the same two messages as a one-way start');
  const wire = h.browser.deliveries.filter((entry) => entry.from === 'panel').map((entry) => entry.json).join('\n');
  assert.doesNotMatch(wire, /languages|partner|twoWay|targetLanguage|request|streamId/, 'no pair, no language, no request body');
  assert.ok(!wire.includes(FAKE_KEY), 'no key');
  for (const frame of h.ports.flatMap((port) => port.received)) assert.deepEqual(frame, { v: 1, type: 'hello' });
  // stored settings hold the pair: that is the worker's input
  assert.deepEqual([h.stored().lanes.tab.twoWay, h.stored().lanes.tab.targetLanguage, h.stored().lanes.tab.partnerLanguage], [true, 'en', 'ja']);
});

test('two-way: every rendered two-way string is an i18n result in the three languages', async (t) => {
  for (const language of ['en', 'ko', 'ja']) {
    const h = await harness(t, { settings: twoWaySettings((s) => { s.uiLanguage = language; }) });
    const ref = REF[language];
    assert.equal(h.text('tab-target-label'), ref.t('ext.twoWay.targetLabel'), language);
    assert.equal(h.text('tab-two-way-hint'), ref.t('ext.twoWay.hint'), language);
    assert.equal(h.text('tab-two-way-note'), ref.t('ext.twoWay.modelNote'), language);
    assert.equal(h.el('tab-two-way').closest('label').querySelector('span').textContent, ref.t('ext.twoWay.label'), language);
    assert.equal(h.el('mic-partner').closest('label').querySelector('span').textContent, ref.t('ext.twoWay.partner'), language);
    for (const id of ['tab-partner', 'mic-partner']) {
      for (const option of h.el(id).options) assert.equal(option.textContent, ref.t(`language.${option.value}`), `${language} ${id}`);
    }
  }
});

const mutedSettings = () => settingsWith((s) => { s.speechMuted = true; });   // a user who muted the voice (it plays by default, §20)

test('a storage failure leaves the controls on the stored state and never throws into the page', async (t) => {
  const h = await harness(t, { settings: mutedSettings() });
  h.failWrites(true);
  await h.click('mic-enabled');
  assert.equal(h.el('mic-enabled').checked, false, 'the checkbox snaps back to what is stored');
  assert.equal(h.stored().lanes.mic.enabled, false);
  await h.click('btn-mute');
  assert.equal(h.attr('btn-mute', 'data-muted'), 'true');
  assert.equal(h.text('status-pill'), T('sim.status.idle'));
  h.failWrites(false);
  await h.click('mic-enabled');
  assert.equal(h.el('mic-enabled').checked, true);
  assert.equal(h.stored().lanes.mic.enabled, true);
});

test('the volume slider writes at most once per 120 ms while dragging and the final value on change', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true });
  const writes = () => h.localSets.filter((entry) => KEYS.settings in entry.items);
  const before = writes().length;
  const slider = h.el('tab-volume');
  for (const value of ['70', '71', '72', '73']) {
    slider.value = value;
    await h.fire('tab-volume', 'input');
  }
  assert.equal(h.text('tab-volume-value'), T('ext.volume.value', { percent: 73 }), 'the readout follows the thumb at once');
  assert.equal(h.attr('tab-volume', 'aria-valuetext'), T('ext.volume.value', { percent: 73 }));
  assert.equal(writes().length - before, 1, 'the leading edge writes once');
  assert.equal(writes().at(-1).items[KEYS.settings].lanes.tab.originalVolume, 70);
  await h.advance(119);
  assert.equal(writes().length - before, 1, 'still inside the window');
  await h.advance(1);
  assert.equal(writes().length - before, 2, 'the trailing write carries the last value');
  assert.equal(writes().at(-1).items[KEYS.settings].lanes.tab.originalVolume, 73);
  const [first, second] = writes().slice(before).map((entry) => entry.at);
  assert.ok(second - first >= 120, 'writes are at least 120 ms apart');
  // the final value on change is written at once, even inside a window
  slider.value = '40';
  await h.fire('tab-volume', 'input');
  slider.value = '35';
  await h.fire('tab-volume', 'change');
  assert.equal(h.stored().lanes.tab.originalVolume, 35);
  assert.equal(h.browser.clock.pending(), 0, 'no timer is left behind after the final flush');
  // and the slider is not fought over by a render while the drag is unsaved
  slider.value = '20';
  await h.fire('tab-volume', 'input');
  assert.equal(slider.value, '20');
});

test('mute toggle: the label names the interpreted speech, on aria-label and title, and the notes follow', async (t) => {
  const h = await harness(t, { settings: mutedSettings() });
  assert.equal(h.attr('btn-mute', 'data-muted'), 'true');
  assert.equal(h.attr('btn-mute', 'aria-label'), T('ext.sound.on'));
  assert.equal(h.attr('btn-mute', 'title'), T('ext.sound.on'));
  assert.equal(h.text('mute-note'), T('ext.mic.mutedHint'));
  assert.equal(h.attr('btn-mute', 'aria-pressed'), null, 'an action label, so no aria-pressed');
  await h.click('btn-mute');
  assert.equal(h.stored().speechMuted, false);
  assert.equal(h.attr('btn-mute', 'data-muted'), 'false');
  assert.equal(h.attr('btn-mute', 'aria-label'), T('ext.sound.off'));
  assert.equal(h.attr('btn-mute', 'title'), T('ext.sound.off'));
  assert.equal(h.text('mute-note'), '');
  assert.equal(h.text('echo-note'), '', 'microphone lane off');
  await h.click('mic-enabled');
  assert.equal(h.text('echo-note'), T('ext.sound.echoWarning'));
  await h.click('btn-mute');
  assert.equal(h.text('echo-note'), '');
  assert.equal(h.attr('btn-mute', 'aria-label'), T('ext.sound.on'));
});

test('host frames drive the panel: state, captions, quota emphasis, apply-next and the tab line', async (t) => {
  const h = await harness(t, { settings: settingsWith(bothLanes), hostUp: true, armed: true });
  assert.equal(h.ports.length, 1, 'the host flag was up at start');
  assert.equal(h.text('usage-note'), T('ext.usage.twoSessions'));
  assert.equal(h.attr('usage-note', 'data-emphasis'), null);
  await h.postState({ tab: running('tab', { level: 20 }), mic: running('mic', { targetLanguage: 'ja', model: 'gemini-3.8-live' }) });
  assert.equal(h.text('tab-tabline'), T('ext.tab.target', { title: 'Example page' }));
  assert.equal(h.el('tab-tabline').hidden, false);
  assert.equal(h.text('mic-apply-next'), '');
  assert.equal(h.text('tab-apply-next'), T('ext.applyNext'), 'settings say en, the running tab lane translates into ko');
  await h.post(captionsFrame('tab', [captionRow('a', 'hello one'), captionRow('b', 'hello two', { status: 'partial' })]));
  const rows = h.el('tab-preview').children;
  assert.deepEqual(rows.map((row) => row.textContent), ['hello one', 'hello two']);
  assert.deepEqual(rows.map((row) => row.getAttribute('data-status')), ['final', 'partial']);
  assert.equal(h.el('tab-preview').hidden, false);
  assert.equal(h.el('mic-preview').hidden, true);
  // a quota error on one lane while both are on
  await h.postState({ tab: running('tab'), mic: failed('RATE_LIMITED', { quota: true, targetLanguage: 'ja' }) });
  assert.equal(h.attr('usage-note', 'data-emphasis'), 'true');
  assert.equal(h.text('usage-note'), `${T('ext.usage.twoSessions')} ${T('ext.usage.quotaHint')}`);
  assert.equal(h.text('mic-notice'), T('ext.error.RATE_LIMITED'));
  assert.equal(h.text('status-pill'), T('ext.status.partial'));
  assert.equal(h.text('tab-status').length > 0, true);
  // a lane that restarts drops the preview of the previous epoch
  await h.postState({ tab: running('tab', { epoch: 2 }) });
  assert.equal(h.el('tab-preview').hidden, true);
  // the host ends the run: idle again, the tab line goes away
  await h.postState({});
  assert.equal(h.el('tab-tabline').hidden, true);
  assert.equal(h.text('status-pill'), T('sim.status.idle'));
});

test('a backup model: the warning is a live note, the route line keeps the label and the model id, and each lane says it once', async (t) => {
  const h = await harness(t, { settings: settingsWith(bothLanes), hostUp: true, armed: true });
  for (const id of ['tab-route-note', 'mic-route-note']) {
    assert.equal(h.attr(id, 'role'), 'status', `#${id} is a live region`);
    assert.equal(h.el(id).hidden, false, `#${id} is never hidden`);
    assert.equal(h.text(id), '');
  }
  await h.postState({ tab: running('tab', { route: 'translation', model: 'gemini-3.8-live', fallback: true }), mic: running('mic', { route: 'flash', model: 'gemini-3.8-live', fallback: true }) });
  for (const lane of ['tab', 'mic']) {
    assert.equal(h.text(`${lane}-route-note`), T('ext.route.fallbackNote'), `${lane}: the warning is in the live note`);
    assert.equal(h.text(`${lane}-route`), `${T('ext.route.fallback')} · gemini-3.8-live`, `${lane}: the route line is a label plus the model id`);
    assert.equal(h.el(`${lane}-route`).hidden, false);
    assert.equal(h.attr(`${lane}-route`, 'role'), null, 'the route line itself is not live: the note is');
    assert.doesNotMatch(h.text(`${lane}-route`), /instead of translating/, 'the sentence is not repeated on the route line');
  }
  // One lane back on the selected model: its note goes away, the other keeps its own.
  await h.postState({ tab: running('tab', { route: 'translation', model: 'gemini-3.5-live-translate-preview' }), mic: running('mic', { route: 'flash', model: 'gemini-3.8-live', fallback: true }) });
  assert.equal(h.text('tab-route-note'), '');
  assert.equal(h.text('tab-route'), `${T('sim.route.translation')} · gemini-3.5-live-translate-preview`);
  assert.equal(h.text('mic-route-note'), T('ext.route.fallbackNote'));
  // The lane stops: note and route line both go, the note region stays in the tree.
  await h.postState({});
  assert.equal(h.text('mic-route-note'), '');
  assert.equal(h.el('mic-route').hidden, true);
  assert.equal(h.el('mic-route-note').hidden, false);
});

test('the fallback note and the Off status read in the chosen language (ko is neutral about what the model hears)', async (t) => {
  for (const language of ['ko', 'ja']) {
    const h = await harness(t, { settings: settingsWith((s) => { s.uiLanguage = language; }), hostUp: true, armed: true });
    const ref = REF[language];
    assert.equal(h.text('mic-status'), ref.t('ext.lane.statusLine', { lane: ref.t('ext.lane.mic.title'), status: ref.t('ext.status.off') }), `${language}: the microphone lane is off`);
    await h.postState({ tab: running('tab', { route: 'translation', model: 'gemini-3.8-live', fallback: true }) });
    assert.equal(h.text('tab-route-note'), ref.t('ext.route.fallbackNote'), language);
    assert.equal(h.text('tab-route'), `${ref.t('ext.route.fallback')} · gemini-3.8-live`, language);
  }
  assert.doesNotMatch(REF.ko.t('ext.route.fallbackNote'), /영상/, 'no "video": the same text is shown for the microphone lane');
});

test('Start with an unsupported page and the microphone on: the tab lane is skipped without an alert, the microphone still starts', async (t) => {
  const h = await harness(t, { settings: settingsWith((s) => { bothLanes(s); }), tabUrl: 'chrome://extensions/', micPermission: 'granted' });
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
  await h.click('btn-start');
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' }], 'only the microphone lane was sent');
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('tab-arm-note'), T('ext.error.TAB_UNSUPPORTED'));
});

test('the preview renders caption text as text and labels skipped and interrupted rows', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  await h.postState({ tab: running('tab') });
  const markup = '<img src=x onerror="alert(1)"> & <b>bold</b>';
  await h.post(captionsFrame('tab', [
    captionRow('a', markup),
    captionRow('b', 'a reply', { skipped: true }),
    captionRow('c', 'cut off', { status: 'interrupted' }),
  ]));
  const rows = h.el('tab-preview').children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].textContent, markup);
  assert.equal(rows[0].children.length, 0, 'no element was created from caption text');
  assert.equal(rows[1].getAttribute('data-skipped'), 'true');
  assert.match(rows[1].textContent, new RegExp(T('sim.captions.skipped')));
  assert.match(rows[2].textContent, new RegExp(T('sim.captions.interrupted')));
  assert.equal(rows[2].getAttribute('data-status'), 'interrupted');
  assert.throws(() => h.el('tab-preview').innerHTML, /INNER_HTML_USED/, 'the fake element throws on innerHTML, so this render never used it');
});

test('invalid, oversize and wrongly addressed frames are dropped without a trace', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  await h.postState({ tab: running('tab') });
  const pill = h.text('status-pill');
  const before = JSON.stringify(h.controller.viewModel());
  const bogus = [
    { v: 1, type: 'state', state: {} },
    { v: 2, type: 'state', state: hostUi({ tab: failed('INVALID_KEY') }) },
    { v: 1, type: 'hello' },
    { v: 1, type: 'style', style: { size: 1.5, position: 'bottom', display: 'dark', maxLines: 3, autoHideSeconds: 8 } },
    { v: 1, type: 'captions', epoch: 1, seq: 1, lane: 'tab', lang: 'xx', rows: [], gaps: { input: false, audio: false, reception: false }, live: true },
    { v: 1, type: 'captions', epoch: 1, seq: 1, lane: 'tab', lang: 'ko', rows: [captionRow('a', 'x'.repeat(9000))], gaps: { input: false, audio: false, reception: false }, live: true },
    { v: 1, type: 'captions', epoch: 1, seq: 1, lane: 'both', lang: 'ko', rows: [], gaps: { input: false, audio: false, reception: false }, live: true },
    'state', null, 42, [],
  ];
  for (const frame of bogus) await h.post(frame);
  assert.equal(h.text('status-pill'), pill);
  assert.equal(JSON.stringify(h.controller.viewModel()), before);
  assert.equal(h.el('tab-preview').hidden, true);
  assert.equal(validateFrame('host->panel', bogus[0]).ok, false, 'the validator is the reason');
  // a valid frame after the garbage still works
  await h.post(captionsFrame('tab', [captionRow('a', 'still alive')]));
  assert.equal(h.el('tab-preview').children[0].textContent, 'still alive');
});

test('host link: connect at start when the flag is up, on the flag turning up, once only, and disconnect when it goes down', async (t) => {
  const down = await harness(t, { settings: settingsWith() });
  assert.equal(down.ports.length, 0, 'flag down: no port');
  await down.setSession(KEYS.host, hostRecord(true));
  assert.equal(down.ports.length, 1);
  assert.deepEqual(down.host().received, [{ v: 1, type: 'hello' }]);
  await down.setSession(KEYS.host, { ...hostRecord(true), at: 5 });
  assert.equal(down.ports.length, 1, 'connect is idempotent while a port is open');
  await down.postState({ tab: running('tab') });
  assert.equal(down.attr('status-pill', 'data-state'), 'running');
  await down.setSession(KEYS.host, hostRecord(false));
  assert.equal(down.host().disconnected, true, 'the panel drops its own port');
  assert.equal(down.attr('status-pill', 'data-state'), 'idle', 'no host: the idle state');
  assert.equal(down.text('stop-note'), '', 'a flag going down is not an unexpected loss');
  assert.deepEqual(down.types(), []);

  const up = await harness(t, { settings: settingsWith(), hostUp: true });
  assert.equal(up.ports.length, 1);
  assert.equal(up.host().name, PORT_NAMES.panel);
});

test('an unexpected port loss shows the host-lost note and asks the worker to reconcile', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  h.setHandler((message) => (message.type === 'sw/host-probe' ? { ok: true, up: false } : { ok: true }));
  await h.postState({ tab: running('tab') });
  h.host().port.disconnect();
  await h.flush();
  assert.equal(h.text('stop-note'), T('ext.notice.hostLost'));
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/host-probe' }]);
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
  assert.equal(h.ports.length, 1, 'it does not reconnect against a document the probe says is gone');
  // the next Start clears the note
  await h.setSession(KEYS.armed, armedRecord());
  await h.click('btn-start');
  assert.equal(h.text('stop-note'), '');
});

test('a probe that finds the host alive reconnects and clears the note', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true });
  h.setHandler((message) => (message.type === 'sw/host-probe' ? { ok: true, up: true } : { ok: true }));
  await h.postState({ tab: running('tab') });
  h.host().port.disconnect();
  await h.flush();
  assert.equal(h.text('stop-note'), '');
  assert.equal(h.ports.length, 2, 'reconnected once');
  assert.deepEqual(h.host().received, [{ v: 1, type: 'hello' }]);
});

test('a port loss that is expected shows nothing: bye, an idle host, or the panel\'s own Stop', async (t) => {
  // the host said goodbye first
  const bye = await harness(t, { settings: settingsWith(), hostUp: true });
  await bye.postState({ tab: running('tab') });
  await bye.post(makeFrame('bye'));
  bye.host().port.disconnect();
  await bye.flush();
  assert.equal(bye.text('stop-note'), '');
  assert.deepEqual(bye.types(), []);
  // nothing was running
  const idle = await harness(t, { settings: settingsWith(), hostUp: true });
  await idle.postState({});
  idle.host().port.disconnect();
  await idle.flush();
  assert.equal(idle.text('stop-note'), '');
  assert.deepEqual(idle.types(), []);
  // the user pressed Stop a moment ago
  const own = await harness(t, { settings: settingsWith(), hostUp: true });
  await own.postState({ tab: running('tab') });
  await own.click('btn-start');
  await own.advance(1000);
  own.host().port.disconnect();
  await own.flush();
  assert.equal(own.text('stop-note'), '');
  assert.deepEqual(own.types(), ['sw/lane-stop'], 'no probe');
  // ... but the same loss long after the Stop is news again
  const late = await harness(t, { settings: settingsWith(), hostUp: true });
  await late.postState({ tab: running('tab') });
  await late.click('btn-start');
  await late.advance(6000);
  late.host().port.disconnect();
  await late.flush();
  assert.equal(late.text('stop-note'), T('ext.notice.hostLost'));
  assert.deepEqual(late.types(), ['sw/lane-stop', 'sw/host-probe']);
});

test('lastStop: a fresh panel-gone record is explained, old or unknown ones are not, and the worker\'s word wins', async (t) => {
  const fresh = await harness(t, { settings: settingsWith(), lastStop: { v: 1, reason: 'panel-gone', at: 0 } });
  assert.equal(fresh.text('stop-note'), T('ext.notice.panelGone'));
  const lost = await harness(t, { settings: settingsWith(), lastStop: { v: 1, reason: 'host-lost', at: 0 } });
  assert.equal(lost.text('stop-note'), T('ext.notice.hostLost'));
  const initial = await harness(t, { settings: settingsWith(), lastStop: { v: 1, reason: 'initial-grace', at: 0 } });
  assert.equal(initial.text('stop-note'), '');

  const old = await harness(t, { settings: settingsWith(), begin: false, lastStop: { v: 1, reason: 'panel-gone', at: 0 } });
  await old.browser.clock.advance(61_000);
  await old.start();
  assert.equal(old.text('stop-note'), '', 'older than 60 s is history');

  // a record that arrives while the panel is open
  const live = await harness(t, { settings: settingsWith() });
  await live.setSession(KEYS.lastStop, { v: 1, reason: 'panel-gone', at: live.browser.clock.now() });
  assert.equal(live.text('stop-note'), T('ext.notice.panelGone'));

  // cleared by the next Start
  await live.setSession(KEYS.armed, armedRecord());
  await live.click('btn-start');
  assert.equal(live.text('stop-note'), '');

  // the panel's own host-lost guess is overridden by the worker's panel-gone
  const both = await harness(t, { settings: settingsWith(), hostUp: true });
  both.setHandler(() => ({ ok: true, up: false }));
  await both.postState({ tab: running('tab') });
  both.host().port.disconnect();
  await both.flush();
  assert.equal(both.text('stop-note'), T('ext.notice.hostLost'));
  await both.setSession(KEYS.lastStop, { v: 1, reason: 'panel-gone', at: both.browser.clock.now() });
  assert.equal(both.text('stop-note'), T('ext.notice.panelGone'));

  // a run that is under way clears an old note
  const running_ = await harness(t, { settings: settingsWith(), hostUp: true, lastStop: { v: 1, reason: 'panel-gone', at: 0 } });
  assert.equal(running_.text('stop-note'), T('ext.notice.panelGone'));
  await running_.postState({ tab: running('tab') });
  assert.equal(running_.text('stop-note'), '');
});

test('createHostLink: hello first, validated frames, an idempotent connect and a loss report that says whether the host said goodbye', async () => {
  const browser = createFakeBrowser();
  const hostContext = browser.createContext('offscreen');
  const panel = browser.createContext('panel', { windowId: 1 });
  const ports = [];
  hostContext.chrome.runtime.onConnect.addListener((port) => { ports.push(port); });
  const seen = { states: [], captions: [], connections: [] };
  const link = createHostLink({
    adapter: createChromeAdapter(panel.chrome),
    onState: (state) => seen.states.push(state),
    onCaptions: (frame) => seen.captions.push(frame),
    onConnection: (connected, info) => seen.connections.push([connected, info]),
  });
  assert.equal(link.connected(), false);
  link.connect();
  link.connect();
  assert.equal(link.connected(), true);
  await browser.settle();
  assert.equal(ports.length, 1, 'connect is idempotent');
  assert.equal(ports[0].name, PORT_NAMES.panel);
  ports[0].postMessage(stateFrame({ tab: running('tab') }));
  ports[0].postMessage(captionsFrame('tab', [captionRow('a', 'hi')]));
  ports[0].postMessage({ v: 1, type: 'state', state: { nope: true } });
  ports[0].postMessage({ v: 1, type: 'hello' });
  await browser.settle();
  assert.equal(seen.states.length, 1);
  assert.equal(seen.states[0].lanes.tab.phase, 'running');
  assert.equal(seen.captions.length, 1);
  assert.equal(seen.captions[0].rows[0].text, 'hi');
  ports[0].postMessage(makeFrame('bye'));
  await browser.settle();
  ports[0].disconnect();
  await browser.settle();
  assert.deepEqual(seen.connections, [[false, { bye: true }]]);
  assert.equal(link.connected(), false, 'it does not reconnect by itself');
  await browser.settle();
  assert.equal(ports.length, 1);
  // a panel-initiated disconnect is not a loss
  link.connect();
  await browser.settle();
  assert.equal(ports.length, 2);
  link.disconnect();
  await browser.settle();
  assert.equal(link.connected(), false);
  assert.equal(seen.connections.length, 1, 'no callback for the panel\'s own disconnect');
  // no receiver at all: the port dies at once and the link reports it without a goodbye
  const alone = createFakeBrowser();
  const lonely = alone.createContext('panel', { windowId: 1 });
  const lost = [];
  const orphan = createHostLink({ adapter: createChromeAdapter(lonely.chrome), onConnection: (connected, info) => lost.push([connected, info]) });
  orphan.connect();
  await alone.settle();
  assert.deepEqual(lost, [[false, { bye: false }]]);
  assert.equal(orphan.connected(), false);
});

// Unchecking a lane while an earlier lane of the same Start is still in flight sends sw/lane-stop {lane}; the
// sequential loop must not start that lane afterwards.
test('unchecking the second lane while the first one starts keeps it from starting afterwards', async (t) => {
  const first = deferred();
  const h = await harness(t, { settings: settingsWith(bothLanes), armed: true });
  h.setHandler((message) => (message.lane === 'tab' && message.type === 'sw/lane-start' ? first.promise : { ok: true }));
  await h.click('btn-start');
  await h.click('mic-enabled');
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'mic' });
  first.resolve({ ok: true });
  await h.flush();
  assert.equal(h.requests.filter((request) => request.type === 'sw/lane-start' && request.lane === 'mic').length, 0);
});

test('the panel never sends a host message and only the four documented worker messages', async (t) => {
  const h = await harness(t, { settings: settingsWith(bothLanes), armed: true, hostUp: true });
  h.setHandler((message) => (message.type === 'sw/host-probe' ? { ok: true, up: false } : { ok: true, tabId: 3 }));
  await h.click('btn-start');
  await h.postState({ tab: running('tab'), mic: running('mic') });
  await h.click('btn-mic-permission');
  await h.click('mic-enabled');
  await h.click('mic-enabled');
  await h.click('btn-start');
  h.host().port.disconnect();
  await h.advance(6000);
  const sent = h.browser.deliveries.filter((entry) => entry.from === 'panel' && entry.kind === 'message').map((entry) => JSON.parse(entry.json));
  assert.ok(sent.length >= 5);
  for (const message of sent) {
    assert.equal(message.target, 'sw');
    assert.ok(['sw/lane-start', 'sw/lane-stop', 'sw/permission-open', 'sw/host-probe'].includes(message.type), message.type);
    assert.ok(!('key' in message) && !('streamId' in message), 'no secret material in anything the panel sends');
  }
  for (const frame of h.ports.flatMap((port) => port.received)) assert.deepEqual(frame, { v: 1, type: 'hello' }, 'the port carries hello only');
  assert.ok(!JSON.stringify(sent).includes(FAKE_KEY));
});

test('live regions are persistent: never hidden, empty when they do not apply, and the lane notices are alerts', async (t) => {
  const h = await harness(t, { settings: settingsWith(bothLanes), hostUp: true, armed: true, key: false });
  const check = (label) => {
    for (const id of LIVE_REGIONS) {
      assert.equal(h.el(id).hidden, false, `${label}: #${id} is never hidden`);
      assert.equal(typeof h.el(id).textContent, 'string');
    }
  };
  check('idle');
  assert.equal(h.attr('tab-notice', 'role'), 'alert');
  assert.equal(h.attr('mic-notice', 'role'), 'alert');
  for (const id of LIVE_REGIONS.filter((region) => region !== 'tab-notice' && region !== 'mic-notice')) {
    const role = h.attr(id, 'role');
    assert.ok(role === 'status' || id === 'key-missing', `#${id} is a status region (${role})`);
  }
  await h.postState({ tab: failed('INVALID_KEY'), mic: running('mic') });
  check('error');
  assert.notEqual(h.text('tab-notice'), '');
  await h.postState({ tab: running('tab'), mic: running('mic') });
  check('running');
  assert.equal(h.text('tab-notice'), '', 'the notice text is cleared, the region stays');
  assert.equal(h.text('tab-arm-note'), '');
  await h.postState({});
  check('idle again');
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.el('tab-notice').hidden, false);
});

test('a state change is announced once: the pill and the notices are live, the per-lane status lines are plain text that still follow every phase', async (t) => {
  const h = await harness(t, { settings: settingsWith(bothLanes), hostUp: true, armed: true });
  for (const id of ['tab-status', 'mic-status']) {
    assert.equal(h.attr(id, 'role'), null, `#${id} has no role`);
    assert.equal(h.attr(id, 'aria-live'), null);
    assert.equal(h.el(id).hidden, false);
  }
  // The controller never adds a role later either, whatever the phases go through.
  await h.postState({ tab: running('tab'), mic: { phase: 'starting', engineStatus: 'connecting' } });
  await h.postState({ tab: { phase: 'stopping' }, mic: running('mic') });
  await h.postState({});
  for (const id of ['tab-status', 'mic-status']) assert.equal(h.attr(id, 'role'), null, `#${id} still has no role`);
  // ...and their text is still right for every phase (the sighted user reads it).
  await h.postState({ tab: running('tab') });
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('sim.status.running') }));
  assert.equal(h.attr('status-pill', 'role'), 'status');
  assert.equal(h.attr('status-pill', 'aria-live'), 'polite');
});

test('the language follows settings.uiLanguage: text, html lang and dynamic notes are re-rendered', async (t) => {
  const h = await harness(t, { settings: mutedSettings(), languages: ['en-US'] });
  assert.equal(h.text('panel-title'), REF.en.t('ext.name'));
  await h.patchSettings((s) => { s.uiLanguage = 'ko'; });
  assert.equal(h.document.documentElement.getAttribute('lang'), 'ko');
  assert.equal(h.text('panel-title'), REF.ko.t('ext.name'));
  assert.equal(h.text('status-pill'), REF.ko.t('sim.status.idle'));
  assert.equal(h.text('btn-start'), REF.ko.t('common.start'));
  assert.equal(h.text('mute-note'), REF.ko.t('ext.mic.mutedHint'));
  assert.equal(h.attr('btn-mute', 'aria-label'), REF.ko.t('ext.sound.on'));
  assert.equal(h.attr('btn-mic-permission', 'aria-label'), REF.ko.t('permission.request'));
  assert.equal(h.document.title, REF.ko.t('ext.name'));
  await h.patchSettings((s) => { s.uiLanguage = 'ja'; });
  assert.equal(h.document.documentElement.getAttribute('lang'), 'ja');
  assert.equal(h.text('status-pill'), REF.ja.t('sim.status.idle'));
  await h.patchSettings((s) => { s.uiLanguage = 'auto'; });
  assert.equal(h.document.documentElement.getAttribute('lang'), 'en', 'auto follows navigator.languages');
  assert.equal(h.text('status-pill'), REF.en.t('sim.status.idle'));

  const stored = await harness(t, { settings: settingsWith((s) => { s.uiLanguage = 'ja'; }) });
  assert.equal(stored.document.documentElement.getAttribute('lang'), 'ja');
  assert.equal(stored.text('status-pill'), REF.ja.t('sim.status.idle'));
});

test('a failing dictionary load renders the boot dictionary and recovers on a later attempt', async (t) => {
  let calls = 0;
  const loadI18n = async (options) => {
    calls += 1;
    if (calls <= 2) throw new Error('I18N_LOAD_FAILED');
    return defaultLoad(options);
  };
  const h = await harness(t, { settings: settingsWith(), loadI18n });
  const boot = createFallbackI18n();
  assert.equal(calls, 1);
  assert.equal(h.text('status-pill'), boot.t('error.unknown'), 'the boot dictionary renders error.unknown-style text, never a blank page');
  assert.equal(h.document.documentElement.getAttribute('lang'), 'en');
  await h.advance(2000);
  assert.equal(calls, 2, 'first retry after 2 s');
  assert.equal(h.text('status-pill'), boot.t('error.unknown'));
  await h.advance(5999);
  assert.equal(calls, 2);
  await h.advance(1);
  assert.equal(calls, 3, 'second retry after 6 s more');
  assert.equal(h.text('status-pill'), T('sim.status.idle'));
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.equal(h.text('panel-title'), T('ext.name'));
  await h.advance(60_000);
  assert.equal(calls, 3, 'no further attempts once it worked');

  // never recovering stops after three retries
  let attempts = 0;
  const hopeless = await harness(t, { settings: settingsWith(), loadI18n: async () => { attempts += 1; throw new Error('I18N_LOAD_FAILED'); } });
  await hopeless.advance(60_000);
  assert.equal(attempts, 4, 'the first try plus three retries');
  assert.equal(hopeless.text('status-pill'), boot.t('error.unknown'));
});

test('dispose drops the port, the timers and every listener', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true, armed: true });
  assert.equal(h.ports.length, 1);
  const slider = h.el('tab-volume');
  slider.value = '50';
  await h.fire('tab-volume', 'input');
  slider.value = '51';
  await h.fire('tab-volume', 'input');
  assert.ok(h.browser.clock.pending() > 0, 'a throttle timer is pending');
  const listeners = ['btn-start', 'tab-enabled', 'mic-enabled', 'tab-target', 'tab-volume', 'btn-mute'].map((id) => h.el(id).listenerCount);
  assert.ok(listeners.every((count) => count > 0));
  h.controller.dispose();
  await h.flush();
  assert.equal(h.host().disconnected, true, 'the panel port is closed');
  assert.equal(h.browser.clock.pending(), 0, 'no timer survives');
  for (const id of ['btn-start', 'tab-enabled', 'mic-enabled', 'tab-target', 'tab-volume', 'btn-mute']) {
    assert.equal(h.el(id).listenerCount, 0, `#${id} has no listener left`);
  }
  for (const name of ['storage.onChanged', 'tabs.onActivated', 'tabs.onUpdated']) {
    assert.equal(h.panel.listeners.get(name)?.length ?? 0, 0, `${name} listener removed`);
  }
  const pill = h.text('status-pill');
  await h.stub.chrome.storage.local.set({ [KEYS.settings]: settingsWith((s) => { s.uiLanguage = 'ko'; }) });
  await h.flush();
  assert.equal(h.text('status-pill'), pill, 'a disposed panel no longer renders');
  h.controller.dispose();
});

test('every rendered string is an i18n result: no literal English leaks into any element in any of the three languages', async (t) => {
  for (const language of ['ko', 'ja']) {
    const h = await harness(t, { settings: settingsWith((s) => { bothLanes(s); s.uiLanguage = language; }), hostUp: true, armed: true });
    await h.postState({ tab: running('tab', { gap: 'input', output: 'blocked' }), mic: failed('SESSION_LIMIT') });
    const ref = REF[language];
    assert.equal(h.text('status-pill'), ref.t('ext.status.partial'), language);
    assert.equal(h.text('tab-gap'), ref.t('ext.gap.input'), language);
    assert.equal(h.text('tab-output'), ref.t('ext.output.blocked'), language);
    assert.equal(h.text('mic-notice'), ref.t('ext.error.SESSION_LIMIT'), language);
    assert.equal(h.attr('usage-note', 'data-emphasis'), 'true');
    assert.equal(h.text('usage-note'), `${ref.t('ext.usage.twoSessions')} ${ref.t('ext.usage.quotaHint')}`, language);
  }
});

// ---------------------------------------------------------------------------------------------
// §16 (owner, 2026-09-30): the display-language switch in the header and the update banner.

test('display-language switch: the pressed button follows the shown language, a click stores it and re-translates the panel', async (t) => {
  const h = await harness(t, { languages: ['en-US'] });
  const pressed = () => ['ko', 'ja', 'en'].filter((code) => h.attr(`ui-lang-${code}`, 'aria-pressed') === 'true');
  assert.deepEqual(pressed(), ['en']);
  assert.deepEqual(['ko', 'ja', 'en'].map((code) => h.text(`ui-lang-${code}`)), ['한국어', '日本語', 'English'], 'each language named in itself');
  assert.equal(h.text('panel-title'), 'Live Interpreter');
  assert.equal(h.stored().uiLanguage, 'auto');

  await h.click('ui-lang-ja');
  assert.equal(h.stored().uiLanguage, 'ja');
  assert.deepEqual(pressed(), ['ja']);
  assert.equal(h.document.documentElement.getAttribute('lang'), 'ja');
  assert.equal(h.text('btn-options'), REF.ja.t('ext.options.title'));
  assert.equal(h.text('panel-title'), 'Live Interpreter', 'the product name stays English');

  await h.click('ui-lang-ko');
  assert.equal(h.stored().uiLanguage, 'ko');
  assert.deepEqual(pressed(), ['ko']);
  assert.equal(h.text('btn-options'), REF.ko.t('ext.options.title'));
  assert.equal(h.attr('ui-lang', 'aria-label'), REF.ko.t('ext.uiLanguage.label'));
});

const jsonFetch = (body, { ok = true } = {}) => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: String(url), init }); return { ok, json: async () => body }; };
  return { fetcher, calls };
};

test('update banner: a newer published version shows it with both versions; Get opens the site; Reload reloads the extension', async (t) => {
  const { fetcher, calls } = jsonFetch({ version: '0.3.0' });
  const h = await harness(t, { fetch: fetcher, manifestVersion: '0.2.0' });
  assert.deepEqual(calls.map((call) => call.url), [UPDATE_MANIFEST_URL], 'one request per panel open, to the site file only');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(h.el('update-note').hidden, false);
  assert.equal(h.text('update-text'), T('ext.update.available', { version: '0.3.0', current: '0.2.0' }));
  assert.equal(h.el('btn-update-reload').hidden, false);

  await h.click('btn-update-get');
  assert.deepEqual(h.opened, [UPDATE_SITE_URL]);
  await h.click('btn-update-reload');
  assert.equal(h.reloads.length, 1);
});

test('update banner: same, older or unreadable versions, a failed request and a missing fetch all show nothing', async (t) => {
  const cases = [
    ['same version', jsonFetch({ version: '0.2.0' }).fetcher],
    ['older version', jsonFetch({ version: '0.1.9' }).fetcher],
    ['not a version', jsonFetch({ version: 'latest' }).fetcher],
    ['not an object', jsonFetch(['0.3.0']).fetcher],
    ['HTTP error', jsonFetch({ version: '9.0.0' }, { ok: false }).fetcher],
    ['network error', async () => { throw new TypeError('Failed to fetch'); }],
    ['no fetch', null],
  ];
  for (const [name, fetcher] of cases) {
    const h = await harness(t, { fetch: fetcher, manifestVersion: '0.2.0' });
    assert.equal(h.el('update-note').hidden, true, name);
    assert.equal(h.text('update-text'), '', name);
  }
  const noManifest = jsonFetch({ version: '0.3.0' });
  const h = await harness(t, { fetch: noManifest.fetcher });
  assert.equal(noManifest.calls.length, 0, 'without its own version the panel does not ask');
  assert.equal(h.el('update-note').hidden, true);
});

test('update banner: Reload waits while a lane runs (a reload would end it) and comes back when nothing runs', async (t) => {
  const { fetcher } = jsonFetch({ version: '0.3.0' });
  const h = await harness(t, { fetch: fetcher, manifestVersion: '0.2.0', hostUp: true });
  await h.postState({ tab: running('tab') });
  assert.equal(h.el('update-note').hidden, false, 'the news stays visible');
  assert.equal(h.el('btn-update-reload').hidden, true);
  await h.postState({});
  assert.equal(h.el('btn-update-reload').hidden, false);
});

// ---------------------------------------------------------------------------------------------
// §17 (owner, 2026-09-30): lane tabs, the microphone asked for instead of refused, and a switched-off lane out of the pill.

test('§17 lane tabs: one card at a time, the first lane that is on is shown first, clicks and arrow keys switch, chips say the state', async (t) => {
  const h = await harness(t);
  const shown = () => ['tab', 'mic'].filter((lane) => !h.el(`card-${lane}`).hidden);
  assert.deepEqual(shown(), ['tab']);
  assert.equal(h.attr('lane-tab-tab', 'aria-selected'), 'true');
  assert.equal(h.attr('lane-tab-mic', 'aria-selected'), 'false');
  assert.equal(h.attr('lane-tab-tab', 'tabindex'), '0');
  assert.equal(h.attr('lane-tab-mic', 'tabindex'), '-1');
  assert.equal(h.text('lane-tab-tab-state'), T('ext.laneTab.on'));
  assert.equal(h.text('lane-tab-mic-state'), T('ext.laneTab.off'));

  await h.click('lane-tab-mic');
  assert.deepEqual(shown(), ['mic']);
  assert.equal(h.attr('lane-tab-mic', 'aria-selected'), 'true');
  assert.equal(h.attr('lane-tab-tab', 'tabindex'), '-1');
  assert.equal(h.stored().lanes.mic.enabled, false, 'choosing a tab only shows its settings: it switches nothing on');

  for (const [key, lane] of [['ArrowRight', 'tab'], ['ArrowLeft', 'mic'], ['Home', 'tab'], ['End', 'mic'], ['ArrowDown', 'tab']]) {
    h.el('lane-tab-mic').dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key }));
    await h.flush();
    assert.deepEqual(shown(), [lane], key);
  }

  const micOnly = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; }) });
  assert.deepEqual(['tab', 'mic'].filter((lane) => !micOnly.el(`card-${lane}`).hidden), ['mic'], 'only the microphone is on');
});

test('§17 lane tabs: a running lane says so on its tab, and a NEW notice on the hidden lane brings its card forward once', async (t) => {
  const both = settingsWith((s) => { s.lanes.tab.enabled = true; s.lanes.mic.enabled = true; });
  const h = await harness(t, { settings: both, hostUp: true, armed: true });
  await h.postState({ tab: running('tab') });
  assert.equal(h.text('lane-tab-tab-state'), T('ext.laneTab.running'));
  assert.equal(h.attr('lane-tab-tab', 'data-state'), 'running');
  assert.equal(h.el('card-tab').hidden, false);

  await h.postState({ tab: running('tab'), mic: failed('MICROPHONE_UNAVAILABLE') });
  assert.equal(h.el('card-mic').hidden, false, 'the error is on the hidden lane: its card comes forward');
  assert.equal(h.text('lane-tab-mic-state'), T('ext.laneTab.attention'));
  assert.equal(h.attr('lane-tab-mic', 'data-state'), 'attention');

  await h.click('lane-tab-tab');
  await h.postState({ tab: running('tab'), mic: failed('MICROPHONE_UNAVAILABLE') });
  assert.equal(h.el('card-tab').hidden, false, 'the same notice again does not pull the user away a second time');
});

test('§17 the pill ignores a switched-off lane: its old refusal is dropped with it', async (t) => {
  const both = settingsWith((s) => { s.lanes.tab.enabled = true; s.lanes.mic.enabled = true; });
  // The tab is armed here, so its start goes by stream id and is answered at once: the lane that is "on and under way" is
  // a tab lane the host reports as running; the microphone is refused (blocked).
  const h = await harness(t, { settings: both, micPermission: 'denied', hostUp: true, armed: true });
  await h.click('btn-start');   // tab: started; mic: refused (blocked)
  await h.postState({ tab: running('tab') });
  assert.equal(h.text('status-pill'), T('ext.status.partial'));
  h.el('mic-enabled').checked = false;
  await h.fire('mic-enabled');
  assert.equal(h.stored().lanes.mic.enabled, false);
  assert.equal(h.text('status-pill'), T('sim.status.running'), 'only the lane that is on speaks');
  assert.equal(h.text('mic-notice'), '');
});

test('§17 switching the microphone on asks for it at once; a Stop cancels a Start that waits for the permission', async (t) => {
  const h = await harness(t, { micPermission: 'prompt' });
  h.el('mic-enabled').checked = true;
  await h.fire('mic-enabled');
  assert.deepEqual(h.types(), ['sw/permission-open'], 'the permission tab opens when the lane is switched on');

  const waiting = await harness(t, { settings: settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; }), micPermission: 'prompt' });
  await waiting.click('btn-start');
  assert.equal(waiting.text('btn-start'), T('common.stop'));
  assert.equal(waiting.text('lane-tab-mic-state'), T('ext.laneTab.waiting'));
  await waiting.click('btn-start');   // Stop
  waiting.audio.setMicPermission('granted');
  await waiting.flush();
  assert.equal(waiting.types().includes('sw/lane-start'), false, 'a cancelled wait never starts later');
  assert.equal(waiting.text('mic-permission-status'), `${T('permission.title')} · ${T('permission.granted')}`);
});

test('§17 lane tabs: a notice that is already there when the panel opens does not pull its lane forward', async (t) => {
  const both = settingsWith((s) => { s.lanes.tab.enabled = true; s.lanes.mic.enabled = true; });
  const h = await harness(t, { settings: both, micPermission: 'denied' });
  assert.equal(h.el('card-tab').hidden, false, 'the panel opens on the first lane that is on');
  assert.equal(h.text('lane-tab-mic-state'), T('ext.laneTab.attention'), 'the hidden lane still says it needs a look');
});

// =============================================================================================
// §21 (owner, 2026-10-08): the automatic update. The panel's banner gets a third button and a SILENT PATH. Everything below
// runs against a STUB updater: no network, no file system, no folder picker, no permission prompt.
// =============================================================================================

test('§21 view model: the banner without a self-updater is the manual one of §16, with Reload following the running lanes', () => {
  const hidden = buildUpdateBanner({ update: null, currentVersion: '0.5.0', updater: { enabled: true, folder: 'granted' } });
  assert.deepEqual(hidden, { visible: false, parts: [], progress: null, get: false, reload: false, auto: { visible: false, labelKey: null, blocked: false } });
  for (const updater of [null, { enabled: false, folder: 'granted' }, undefined]) {
    const banner = buildUpdateBanner({ update: { version: '0.6.0' }, currentVersion: '0.5.0', updater });
    assert.deepEqual(banner.parts, [{ key: 'ext.update.available', params: { version: '0.6.0', current: '0.5.0' } }]);
    assert.deepEqual([banner.visible, banner.get, banner.reload, banner.auto.visible, banner.progress], [true, true, true, false, null]);
    assert.equal(buildUpdateBanner({ update: { version: '0.6.0' }, currentVersion: '0.5.0', updater, lastActive: true }).reload, false);
  }
});

test('§21 view model: with the updater on, the sentence and the third button follow the folder and whether a lane is under way', () => {
  const params = { version: '0.6.0', current: '0.5.0' };
  const table = [
    // [folder, laneBusy, hint key, label key, blocked]
    ['granted', false, 'ext.updater.banner.hintUpdate', 'ext.updater.button.update', false],
    ['needs-click', false, 'ext.updater.banner.hintUpdate', 'ext.updater.button.update', false],
    ['none', false, 'ext.updater.banner.hintEnable', 'ext.updater.button.enable', false],
    ['gone', false, 'ext.updater.banner.hintEnable', 'ext.updater.button.enable', false],
    ['granted', true, 'ext.updater.banner.blocked', 'ext.updater.button.update', true],
    ['none', true, 'ext.updater.banner.blocked', 'ext.updater.button.enable', true],
  ];
  for (const [folder, laneBusy, hint, label, blocked] of table) {
    const banner = buildUpdateBanner({ update: { version: '0.6.0' }, currentVersion: '0.5.0', updater: { enabled: true, folder }, laneBusy });
    assert.deepEqual(banner.parts, [{ key: 'ext.updater.available', params }, { key: hint, params: {} }], `${folder} busy=${laneBusy}`);
    assert.deepEqual(banner.auto, { visible: true, labelKey: label, blocked }, `${folder} busy=${laneBusy}`);
    assert.deepEqual([banner.get, banner.reload, banner.progress], [true, true, null]);
  }
  // Reload keeps its §16 rule (a lane under way per the host), the wider "busy" rule is the update button's.
  assert.equal(buildUpdateBanner({ update: { version: '0.6.0' }, currentVersion: '0.5.0', updater: { enabled: true, folder: 'granted' }, laneBusy: true }).reload, true);
  assert.equal(buildUpdateBanner({ update: { version: '0.6.0' }, currentVersion: '0.5.0', updater: { enabled: true, folder: 'granted' }, lastActive: true }).reload, false);
});

test('§21 view model: a silent update in progress shows its step and nothing to press; a failure keeps the buttons and names the reason', () => {
  const base = { update: { version: '0.6.0' }, currentVersion: '0.5.0', updater: { enabled: true, folder: 'granted' } };
  for (const step of UPDATE_STEPS) {
    const banner = buildUpdateBanner({ ...base, step });
    assert.deepEqual(banner.parts, [{ key: `ext.updater.step.${step}`, params: {} }], step);
    assert.deepEqual(banner.progress, { key: `ext.updater.step.${step}` });
    assert.deepEqual([banner.visible, banner.get, banner.reload, banner.auto.visible], [true, false, false, false], `${step}: nothing to press mid-update`);
  }
  assert.deepEqual(UPDATE_STEPS, ['checking', 'downloading', 'verifying', 'writing', 'reloading'], 'the five steps of the updater, in order');
  assert.deepEqual(buildUpdateBanner({ ...base, step: 'sideways' }).progress, { key: 'ext.updater.step.checking' }, 'an unknown step reads as the first one, never as a raw name');
  const failed = buildUpdateBanner({ ...base, error: 'UPDATE_BAD_SIGNATURE' });
  assert.deepEqual(failed.parts, [
    { key: 'ext.updater.available', params: { version: '0.6.0', current: '0.5.0' } },
    { key: 'ext.updater.lastError', params: {}, nested: { error: 'ext.updater.error.UPDATE_BAD_SIGNATURE' } },
    { key: 'ext.updater.banner.hintUpdate', params: {} },
  ]);
  assert.deepEqual(failed.progress, { key: 'ext.updater.error.UPDATE_BAD_SIGNATURE' });
  assert.deepEqual([failed.get, failed.reload, failed.auto.visible, failed.auto.blocked], [true, true, true, false]);
  for (const error of ['UNKNOWN', 'UPDATE_NOT_A_CODE', 42, '']) {
    assert.deepEqual(buildUpdateBanner({ ...base, error }).progress, { key: 'ext.updater.error.UNKNOWN' }, String(error));
  }
  assert.ok(isDeepFrozen(failed) && isDeepFrozen(buildUpdateBanner({ ...base, step: 'writing' })), 'the banner is deeply frozen');
});

test('§21 view model: one literal key per updater error code, all of them in every dictionary, none left over', () => {
  assert.deepEqual(Object.keys(UPDATE_ERROR_KEY).sort(), [...UPDATE_ERROR_CODES].sort(), 'the table covers exactly the codes of extension/lib/self-update.js');
  for (const code of UPDATE_ERROR_CODES) {
    assert.equal(UPDATE_ERROR_KEY[code], `ext.updater.error.${code}`);
    for (const language of ['en', 'ko', 'ja']) assert.equal(REF[language].has(UPDATE_ERROR_KEY[code]), true, `${language} ${code}`);
    const banner = buildUpdateBanner({ update: { version: '0.6.0' }, currentVersion: '0.5.0', updater: { enabled: true, folder: 'granted' }, error: code });
    assert.equal(banner.parts[1].nested.error, `ext.updater.error.${code}`);
  }
  for (const language of ['en', 'ko', 'ja']) {
    assert.equal(REF[language].has('ext.updater.error.UNKNOWN'), true);
    for (const step of UPDATE_STEPS) assert.equal(REF[language].has(`ext.updater.step.${step}`), true, `${language} ${step}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The controller. `stubUpdater` is the whole surface the panel may touch; every call is recorded.
function stubUpdater({ enabled = true, folder = 'granted', autoApply = true, run = async () => ({ ok: true, version: '0.6.0' }) } = {}) {
  const calls = { status: 0, run: [], chooseFolder: 0, check: 0, forgetFolder: 0, setAutoApply: [] };
  const state = { folder, autoApply };
  return {
    enabled, calls, state,
    status: async () => { calls.status += 1; return { enabled, folder: state.folder, autoApply: state.autoApply, appliedVersion: null, pending: null, lastError: null }; },
    run: async (options) => { calls.run.push(options); return run(options, state); },
    chooseFolder: async () => { calls.chooseFolder += 1; return { ok: true }; },
    check: async () => { calls.check += 1; return { available: true, version: '0.6.0' }; },
    forgetFolder: async () => { calls.forgetFolder += 1; },
    setAutoApply: async (on) => { calls.setAutoApply.push(on); },
  };
}
const NEWER_VERSION = () => jsonFetch({ version: '0.6.0' }).fetcher;
const withUpdater = (t, updater, extra = {}) => harness(t, { fetch: NEWER_VERSION(), manifestVersion: '0.5.0', updater, ...extra });
const optionsUrl = (h) => `${h.panel.chrome.runtime.getURL(PATHS.options)}#update`;
const AVAILABLE = { version: '0.6.0', current: '0.5.0' };
const bannerText = (language, ...parts) => parts.map(([key, params]) => REF[language].t(key, params)).join(' ');

test('§21 banner: the third button says "Update now" for a stored folder and "Turn on automatic updates" otherwise, with the sentence that fits', async (t) => {
  for (const [folder, label, hint] of [
    ['granted', 'ext.updater.button.update', 'ext.updater.banner.hintUpdate'],
    ['needs-click', 'ext.updater.button.update', 'ext.updater.banner.hintUpdate'],
    ['none', 'ext.updater.button.enable', 'ext.updater.banner.hintEnable'],
    ['gone', 'ext.updater.button.enable', 'ext.updater.banner.hintEnable'],
  ]) {
    const updater = stubUpdater({ folder, autoApply: false });   // autoApply off: the silent path stays out of this test
    const h = await withUpdater(t, updater);
    assert.equal(h.el('update-note').hidden, false, folder);
    assert.equal(h.el('btn-update-auto').hidden, false, folder);
    assert.equal(h.text('btn-update-auto'), T(label), folder);
    assert.equal(h.text('update-text'), bannerText('en', ['ext.updater.available', AVAILABLE], [hint, {}]), folder);
    assert.equal(h.attr('btn-update-auto', 'aria-disabled'), null, `${folder}: not blocked while nothing runs`);
    assert.equal(h.attr('btn-update-auto', 'aria-describedby'), 'update-text', 'the reason it can be blocked is the banner text');
    assert.equal(h.el('btn-update-get').hidden, false, `${folder}: the manual download stays`);
    assert.equal(h.el('btn-update-reload').hidden, false, `${folder}: so does the manual Reload`);
    assert.equal(h.text('update-progress'), '', 'nothing is announced while nothing happens');
    assert.equal(updater.calls.status >= 1, true);
    assert.deepEqual([updater.calls.run.length, updater.calls.chooseFolder, updater.calls.check], [0, 0, 0], `${folder}: the panel runs nothing, picks nothing and asks no second time`);
  }
});

test('§21 banner: without an updater, with a disabled one (a development folder), or with no news, the banner is the manual one', async (t) => {
  for (const [name, updater] of [['none', null], ['disabled', stubUpdater({ enabled: false })]]) {
    const h = await withUpdater(t, updater);
    assert.equal(h.el('btn-update-auto').hidden, true, name);
    assert.equal(h.text('update-text'), T('ext.update.available', AVAILABLE), `${name}: the §16 sentence, unchanged`);
    assert.equal(h.el('btn-update-get').hidden, false);
    assert.equal(h.el('btn-update-reload').hidden, false);
    if (updater) assert.deepEqual([updater.calls.status, updater.calls.run.length], [0, 0], `${name}: a disabled updater is not even asked`);
  }
  const quiet = stubUpdater();
  const none = await harness(t, { fetch: jsonFetch({ version: '0.5.0' }).fetcher, manifestVersion: '0.5.0', updater: quiet });
  assert.equal(none.el('update-note').hidden, true);
  assert.equal(none.el('btn-update-auto').hidden, true);
  assert.deepEqual([quiet.calls.status, quiet.calls.run.length], [0, 0], 'no newer version: the updater is not asked');
});

test('§21 banner: the button opens the options page at #update in a tab, for every folder state, and runs nothing itself', async (t) => {
  for (const folder of ['granted', 'needs-click', 'none', 'gone']) {
    const updater = stubUpdater({ folder, autoApply: false });
    const h = await withUpdater(t, updater);
    await h.click('btn-update-auto');
    assert.deepEqual(h.opened, [optionsUrl(h)], folder);
    assert.match(h.opened[0], /^chrome-extension:\/\/[^/]+\/extension\/options\/options\.html#update$/);
    assert.deepEqual([updater.calls.run.length, updater.calls.chooseFolder], [0, 0], `${folder}: choosing a folder and the permission are the options page's job`);
    assert.equal(h.requests.length, 0, 'no message to the worker either');
  }
});

test('§21 banner: while a lane runs the button is aria-disabled and the sentence says why; it works again when nothing runs', async (t) => {
  const updater = stubUpdater({ autoApply: false });
  const h = await withUpdater(t, updater, { hostUp: true, armed: true });
  await h.postState({});   // the host has spoken: idle
  assert.equal(h.attr('btn-update-auto', 'aria-disabled'), null);
  await h.postState({ tab: running('tab') });
  assert.equal(h.attr('btn-update-auto', 'aria-disabled'), 'true');
  assert.equal(h.el('btn-update-auto').hasAttribute('disabled'), false, 'never natively disabled: the keyboard still reaches it and its description');
  assert.equal(h.el('btn-update-auto').hidden, false);
  assert.equal(h.text('update-text'), bannerText('en', ['ext.updater.available', AVAILABLE], ['ext.updater.banner.blocked', {}]));
  await h.click('btn-update-auto');
  assert.deepEqual(h.opened, [], 'a click on the blocked button asks for nothing');
  await h.postState({ tab: { phase: 'stopping', tabId: 7 } });
  assert.equal(h.attr('btn-update-auto', 'aria-disabled'), 'true', 'a lane that is still stopping is not "nothing runs" yet');
  await h.postState({});
  assert.equal(h.attr('btn-update-auto', 'aria-disabled'), null);
  assert.equal(h.text('update-text'), bannerText('en', ['ext.updater.available', AVAILABLE], ['ext.updater.banner.hintUpdate', {}]));
  await h.click('btn-update-auto');
  assert.deepEqual(h.opened, [optionsUrl(h)]);
});

test('§21 banner: a start in flight blocks the button too, and so does a host that is up but has not said what it runs', async (t) => {
  const updater = stubUpdater({ autoApply: false });
  const h = await withUpdater(t, updater, { armed: true });
  const gate = deferred();
  h.setHandler((message) => (message.type === 'sw/lane-start' ? gate.promise : { ok: true }));
  await h.click('btn-start');
  assert.equal(h.attr('btn-update-auto', 'aria-disabled'), 'true', 'the Start is under way: a reload would cut it');
  await h.click('btn-update-auto');
  assert.deepEqual(h.opened, []);
  gate.resolve({ ok: true });
  await h.flush();

  const unknown = await withUpdater(t, stubUpdater({ autoApply: false }), { hostUp: true });
  assert.equal(unknown.attr('btn-update-auto', 'aria-disabled'), 'true', 'the host is up and silent: lanes may be running');
  await unknown.postState({});
  assert.equal(unknown.attr('btn-update-auto', 'aria-disabled'), null, 'until it says it is idle');
});

test('§21 banner: the label follows the update record in storage (the options page chose or forgot the folder)', async (t) => {
  const updater = stubUpdater({ folder: 'none', autoApply: false });
  const h = await withUpdater(t, updater);
  assert.equal(h.text('btn-update-auto'), T('ext.updater.button.enable'));
  updater.state.folder = 'granted';
  await h.stub.chrome.storage.local.set({ [KEYS.update]: { v: 1, folder: true } });
  await h.flush();
  assert.equal(h.text('btn-update-auto'), T('ext.updater.button.update'));
  assert.equal(h.text('update-text'), bannerText('en', ['ext.updater.available', AVAILABLE], ['ext.updater.banner.hintUpdate', {}]));
  updater.state.folder = 'gone';
  await h.stub.chrome.storage.local.set({ [KEYS.update]: { v: 1, folder: true, lastError: null } });
  await h.flush();
  assert.equal(h.text('btn-update-auto'), T('ext.updater.button.enable'));
  assert.equal(updater.calls.run.length, 0);
});

test('§21 banner: it speaks the chosen language, button and sentence', async (t) => {
  const updater = stubUpdater({ folder: 'none', autoApply: false });
  const h = await withUpdater(t, updater, { settings: settingsWith((s) => { s.uiLanguage = 'ko'; }) });
  assert.equal(h.text('btn-update-auto'), REF.ko.t('ext.updater.button.enable'));
  assert.equal(h.text('update-text'), bannerText('ko', ['ext.updater.available', AVAILABLE], ['ext.updater.banner.hintEnable', {}]));
  await h.patchSettings((s) => { s.uiLanguage = 'ja'; });
  assert.equal(h.text('btn-update-auto'), REF.ja.t('ext.updater.button.enable'));
  assert.equal(h.text('update-text'), bannerText('ja', ['ext.updater.available', AVAILABLE], ['ext.updater.banner.hintEnable', {}]));
});

// ---------------------------------------------------------------------------------------------
// The silent path: once per panel open, only when every condition holds, never with permission to prompt.

test('§21 silent path: all conditions met runs the updater exactly once, without permission to prompt, and picks no folder', async (t) => {
  const updater = stubUpdater();
  const h = await withUpdater(t, updater);
  assert.equal(updater.calls.run.length, 1, 'exactly one run');
  assert.equal(updater.calls.run[0].allowPrompt, false, 'a permission request needs a click: the panel has none');
  assert.equal(typeof updater.calls.run[0].onStep, 'function');
  assert.deepEqual([updater.calls.chooseFolder, updater.calls.check, updater.calls.forgetFolder, updater.calls.setAutoApply], [0, 0, 0, []]);
  await h.advance(60_000 - 1);   // nothing later starts a second run
  await h.setSession(KEYS.host, hostRecord(true));
  await h.postState({});
  assert.equal(updater.calls.run.length, 1);
});

test('§21 silent path: each missing condition means no run at all, and the banner keeps its buttons', async (t) => {
  const never = async (label, updater, options = {}, { before = async () => {} } = {}) => {
    const gate = deferred();
    const slow = async (url, init) => { await gate.promise; return jsonFetch({ version: '0.6.0' }).fetcher(url, init); };
    const h = await harness(t, { fetch: options.fetch ?? slow, manifestVersion: '0.5.0', updater, ...options.harness });
    await before(h);
    gate.resolve();
    await h.flush();
    assert.equal(updater.calls.run.length, 0, label);
    return h;
  };
  // no update: not even the updater is asked
  const same = stubUpdater();
  await harness(t, { fetch: jsonFetch({ version: '0.5.0' }).fetcher, manifestVersion: '0.5.0', updater: same });
  assert.deepEqual([same.calls.status, same.calls.run.length], [0, 0]);
  // the updater is off (a development folder)
  const off = stubUpdater({ enabled: false });
  await harness(t, { fetch: NEWER_VERSION(), manifestVersion: '0.5.0', updater: off });
  assert.equal(off.calls.run.length, 0, 'not enabled');
  // the folder cannot be written without a prompt
  for (const folder of ['needs-click', 'none', 'gone']) {
    const updater = stubUpdater({ folder });
    const h = await harness(t, { fetch: NEWER_VERSION(), manifestVersion: '0.5.0', updater });
    assert.equal(updater.calls.run.length, 0, `folder ${folder}`);
    assert.equal(h.el('btn-update-auto').hidden, false, `folder ${folder}: the banner offers the button instead`);
  }
  // the person turned it off
  const manual = stubUpdater({ autoApply: false });
  await harness(t, { fetch: NEWER_VERSION(), manifestVersion: '0.5.0', updater: manual });
  assert.equal(manual.calls.run.length, 0, 'autoApply off');
  // a lane runs when the news arrives
  const lane = stubUpdater();
  await never('a lane is running', lane, { harness: { hostUp: true, armed: true } }, { before: (h) => h.postState({ tab: running('tab') }) });
  // a lane is being stopped
  const stopping = stubUpdater();
  await never('a lane is stopping', stopping, { harness: { hostUp: true, armed: true } }, { before: (h) => h.postState({ tab: { phase: 'stopping', tabId: 7 } }) });
  // a Start is in flight
  const starting = stubUpdater();
  const start = deferred();
  await never('a start is in flight', starting, { harness: { armed: true } }, {
    before: async (h) => { h.setHandler((message) => (message.type === 'sw/lane-start' ? start.promise : { ok: true })); await h.click('btn-start'); },
  });
  start.resolve({ ok: true });
  // the host is up but has not said what it runs
  const unknown = stubUpdater();
  await never('the host has not spoken', unknown, { harness: { hostUp: true } });
  // the panel was opened by an icon click for this window whose start is not consumed yet
  const clicked = stubUpdater();
  await never('an icon click for this window is pending', clicked, {}, {
    before: (h) => h.setSession(KEYS.autostart, { v: 1, tabId: 99, windowId: 1, at: h.browser.clock.now() }),
  });
});

test('§21 silent path: an icon click that this panel acted on keeps the update for the banner; a click for another window does not matter', async (t) => {
  // The panel opened by the toolbar icon starts interpreting at once: its lane is running (or being started) when the news
  // arrives, so the update waits for the person.
  const gate = deferred();
  const slow = async (url, init) => { await gate.promise; return jsonFetch({ version: '0.6.0' }).fetcher(url, init); };
  const updater = stubUpdater();
  const h = await harness(t, { fetch: slow, manifestVersion: '0.5.0', updater, armed: true, begin: false });
  await h.stub.chrome.storage.session.set({ [KEYS.autostart]: { v: 1, tabId: 7, windowId: 1, at: h.browser.clock.now() } });
  await h.start();
  await h.flush();
  assert.equal(h.types().includes('sw/lane-start'), true, 'the icon click started the tab lane');
  gate.resolve();
  await h.flush();
  assert.equal(updater.calls.run.length, 0, 'a start the icon asked for is not cut by an update');
  assert.equal(h.el('btn-update-auto').hidden, false, 'the banner offers the button instead');

  const elsewhere = stubUpdater();
  await harness(t, { fetch: NEWER_VERSION(), manifestVersion: '0.5.0', updater: elsewhere, begin: false }).then(async (other) => {
    await other.stub.chrome.storage.session.set({ [KEYS.autostart]: { v: 1, tabId: 99, windowId: 2, at: other.browser.clock.now() } });
    await other.start();
    assert.equal(elsewhere.calls.run.length, 1, 'a record for another window is not this panel\'s business');
  });
});

test('§21 silent path: the banner shows each step as the updater reports it, announces it, and offers nothing to press meanwhile', async (t) => {
  const gates = { checking: deferred(), downloading: deferred(), verifying: deferred(), writing: deferred(), reloading: deferred() };
  const updater = stubUpdater({
    run: async ({ onStep }) => {
      for (const step of ['checking', 'downloading', 'verifying', 'writing', 'reloading']) {
        onStep(step);
        await gates[step].promise;
      }
      return { ok: true, version: '0.6.0' };
    },
  });
  const h = await withUpdater(t, updater);
  for (const step of ['checking', 'downloading', 'verifying', 'writing', 'reloading']) {
    assert.equal(h.text('update-text'), T(`ext.updater.step.${step}`), step);
    assert.equal(h.text('update-progress'), T(`ext.updater.step.${step}`), `${step}: the live region says the same`);
    assert.equal(h.el('update-note').hidden, false);
    for (const id of ['btn-update-auto', 'btn-update-get', 'btn-update-reload']) assert.equal(h.el(id).hidden, true, `${step}: #${id} is not offered mid-update`);
    gates[step].resolve();
    await h.flush();
  }
  // Success: the updater reloaded the extension, so this page is about to go. No further request of any kind.
  assert.equal(updater.calls.run.length, 1);
  assert.deepEqual([updater.calls.chooseFolder, updater.calls.check, updater.calls.status], [0, 0, 1], 'one status read at the start, nothing after the success');
  assert.equal(h.text('update-text'), T('ext.updater.step.reloading'));
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.reloads, [], 'the panel does not reload the extension itself; the updater does');
});

test('§21 silent path: if the page is still here long after a successful run, the reload did not happen and the buttons come back', async (t) => {
  const updater = stubUpdater({ run: async () => ({ ok: true, version: '0.6.0' }) });
  const h = await withUpdater(t, updater);
  assert.equal(h.text('update-text'), T('ext.updater.step.reloading'));
  await h.advance(14_999);
  assert.equal(h.text('update-text'), T('ext.updater.step.reloading'));
  await h.advance(1);
  assert.equal(h.el('btn-update-reload').hidden, false, 'Reload is the way out');
  assert.equal(h.el('btn-update-auto').hidden, false);
  assert.equal(updater.calls.run.length, 1, 'and nothing runs again by itself');
  // dispose clears the timer
  const second = await withUpdater(t, stubUpdater());
  assert.ok(second.browser.clock.pending() > 0);
  second.controller.dispose();
  await second.flush();
  assert.equal(second.browser.clock.pending(), 0, 'no timer survives the panel');
});

test('§21 silent path: a failure falls back to the buttons with the reason; the folder state is read again; nothing runs a second time', async (t) => {
  for (const code of UPDATE_ERROR_CODES) {
    const updater = stubUpdater({ run: async () => ({ ok: false, code }) });
    const h = await withUpdater(t, updater);
    const hint = h.el('btn-update-auto').getAttribute('aria-disabled') === 'true' ? 'ext.updater.banner.blocked' : 'ext.updater.banner.hintUpdate';
    assert.equal(h.text('update-text'), bannerText('en', ['ext.updater.available', AVAILABLE],
      ['ext.updater.lastError', { error: T(`ext.updater.error.${code}`) }], [hint, {}]), code);
    assert.equal(h.text('update-progress'), T(`ext.updater.error.${code}`), `${code}: announced`);
    assert.equal(h.el('btn-update-auto').hidden, false, `${code}: the button is back`);
    assert.equal(h.el('btn-update-get').hidden, false);
    assert.equal(h.el('btn-update-reload').hidden, false);
    assert.equal(updater.calls.run.length, 1, code);
    assert.equal(updater.calls.status, 2, `${code}: the folder state is read again after a failure`);
  }
  // A permission that went away between the status and the run: the label turns into the click that can renew it.
  const lost = stubUpdater({ run: async (_options, state) => { state.folder = 'needs-click'; return { ok: false, code: 'UPDATE_NEEDS_PERMISSION' }; } });
  const h = await withUpdater(t, lost);
  assert.equal(h.text('btn-update-auto'), T('ext.updater.button.update'));
  await h.click('btn-update-auto');
  assert.deepEqual(h.opened, [optionsUrl(h)], 'the options page is where the click can be answered');
  assert.equal(lost.calls.run.length, 1);
  // A run that throws, or answers nonsense, reads as the generic sentence and never as a raw code.
  for (const run of [async () => { throw new Error('boom'); }, async () => ({ ok: false, code: 'SOMETHING_ELSE' }), async () => undefined, async () => ({ ok: false })]) {
    const odd = await withUpdater(t, stubUpdater({ run }));
    assert.equal(odd.text('update-progress'), T('ext.updater.error.UNKNOWN'));
    assert.ok(!odd.text('update-text').includes('SOMETHING_ELSE') && !odd.text('update-text').includes('boom'));
  }
});

test('§21 silent path: after a failure nothing runs again on its own (idle lanes, storage changes, a later status read)', async (t) => {
  const updater = stubUpdater({ run: async () => ({ ok: false, code: 'UPDATE_FETCH_FAILED' }) });
  const h = await withUpdater(t, updater, { armed: true });
  assert.equal(updater.calls.run.length, 1);
  await h.setSession(KEYS.host, hostRecord(true));
  await h.postState({ tab: running('tab') });
  await h.postState({});
  await h.stub.chrome.storage.local.set({ [KEYS.update]: { v: 1, folder: true } });
  await h.advance(120_000);
  assert.equal(updater.calls.run.length, 1, 'once per panel open');
});

test('§21 the panel never reaches the picker, the permission request or the file system', async () => {
  const code = PANEL_SOURCE.split('\n').filter((line) => !/^\s*\/\//.test(line)).map((line) => line.replace(/\s\/\/.*$/, '')).join('\n');
  for (const word of ['chooseFolder', 'pickDirectory', 'showDirectoryPicker', 'requestPermission', 'queryPermission', 'forgetFolder', 'setAutoApply',
    'FileSystem', 'getDirectoryHandle', 'createWritable']) {
    assert.equal(code.includes(word), false, `controller.js does not name ${word}`);
  }
  assert.match(code, /allowPrompt: false/);
  assert.doesNotMatch(code, /allowPrompt: true/);
  const entry = await readText('extension/panel/panel.js');
  const lines = entry.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(lines, /showDirectoryPicker|requestPermission/, 'panel.js hands the updater no picker');
  assert.match(lines, /pickDirectory: \(\) => Promise\.reject\(/, 'the panel\'s pickDirectory refuses by construction');
});

// =============================================================================================
// 2026-10-08 (Windows): Chrome's share dialog asked from the panel itself (Chrome 153 and later, the gate of
// lib/display-media.js), and the chosen tab's audio relayed to the host (lib/audio-relay.js). The page's dialog, the relay
// sender and the random source are injected stubs: nothing here opens a dialog, captures a tab or makes a sound.
// =============================================================================================
const HEX32 = /^[0-9a-f]{32}$/;
/**
 * The `media` a panel gets in panel.js, as stubs. Every dialog call stays pending until the test answers it (the oldest
 * first): choose() delivers a stream with an audio track (unless `audio: false`) whose settings say whether Chrome silenced
 * the tab, and a video track carrying the capture `label` of the chosen page (null: a page without the label); dismiss()
 * closes it the way a user does (NotAllowedError by default). `stream.all` keeps every track it was delivered with.
 */
function createPanelMedia({ gate = true } = {}) {
  const dialogs = [];
  const calls = [];
  const senders = [];
  const gateCalls = [];
  let serial = 0;
  const media = {
    canOpenDialog: () => { gateCalls.push(true); return typeof gate === 'function' ? gate() : gate; },
    openShareDialog(constraints) {
      calls.push(constraints);
      return new Promise((resolve, reject) => { dialogs.push({ resolve, reject }); });
    },
    createRelaySender({ track, relayId }) {
      const sender = { track, relayId, stops: [], stop(reason = 'stop') { sender.stops.push(reason); } };
      senders.push(sender);
      return sender;
    },
    random(bytes) {
      serial += 1;
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (serial * 37 + index * 11) % 256;
      return bytes;
    },
  };
  return {
    media, calls, senders, gateCalls,
    pending: () => dialogs.length,
    choose({ label = null, audio = true, suppressed = true } = {}) {
      const entry = dialogs.shift();
      if (!entry) throw new Error('no dialog is open');
      const tracks = [];
      if (audio) tracks.push(new FakeTrack({ kind: 'audio', label: 'Tab audio', settings: { suppressLocalAudioPlayback: suppressed } }));
      tracks.push(new FakeTrack({ kind: 'video', label: 'Tab video', settings: { displaySurface: 'browser' },
        captureHandle: label === null ? null : { handle: label } }));
      const stream = new FakeMediaStream(tracks);
      stream.all = [...tracks];
      entry.resolve(stream);
      return stream;
    },
    dismiss(name = 'NotAllowedError') {
      const entry = dialogs.shift();
      if (!entry) throw new Error('no dialog is open');
      entry.reject(new DOMException('fake dialog closed', name));
    },
  };
}
// The stub worker for these starts: the label is answered at once (labelled), every start and stop succeeds, unless a test
// passes its own answer.
const relayWorker = ({ label = () => ({ ok: true, labelled: true }), start = () => ({ ok: true }), stop = () => ({ ok: true }) } = {}) => (message) => {
  if (message.type === 'sw/tab-label') return label(message);
  if (message.type === 'sw/lane-start') return start(message);
  if (message.type === 'sw/lane-stop') return stop(message);
  return { ok: true };
};
const tabLabels = (h) => h.requests.filter((request) => request.type === 'sw/tab-label');
const relayStarts = (h) => laneStarts(h).filter((request) => 'relay' in request);
// The capture label the worker would have put on `tabId` for the label request number `which` of this panel.
const labelFor = (h, tabId, which = -1) => `${tabLabels(h).at(which).nonce}.${tabId}`;
const relayStart = (relayId, { chosenTab = 9, passthrough = true, tabId = 7 } = {}) => ({
  v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId, relay: relayId, passthrough, chosenTab,
});
const allEnded = (stream) => stream.all.every((track) => track.readyState === 'ended' && track.stops >= 1);
const statusLine = (key) => T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T(key) });
const SHORTCUT_LINE = () => T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' });
// Start pressed, the dialog open (the label answered at once), and the tab chosen; the relay start answered by `start`.
async function relayRunning(t, { start = () => ({ ok: true }), stop, label = 9, ...options } = {}) {
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media, ...options });
  h.setHandler(relayWorker({ start, ...(stop ? { stop } : {}) }));
  await h.click('btn-start');
  assert.equal(m.calls.length, 1);
  const stream = m.choose({ label: label === null ? null : labelFor(h, label) });
  await h.flush();
  return { h, m, stream, audio: stream.all[0], sender: m.senders[0] };
}

test('2026-10-08 gate on: Start on an un-armed tab labels the tab, opens Chrome\'s dialog from the panel ONCE, waits exactly like the worker\'s dialog, and starts the lane on the relay of the chosen tab', async (t) => {
  const m = createPanelMedia();
  const lane = deferred();
  const h = await harness(t, { settings: settingsWith(), media: m.media });
  h.setHandler(relayWorker({ start: () => lane.promise }));
  await h.click('btn-start');
  // The label first (the stream can only say which tab was chosen through it), then the dialog, with the one shared
  // constraints object. The worker is not asked to open a dialog.
  assert.equal(h.requests[0].type, 'sw/tab-label', 'the label is asked for before anything else');
  assert.deepEqual(tabLabels(h), [{ v: 1, target: 'sw', type: 'sw/tab-label', tabId: 7, nonce: tabLabels(h)[0].nonce }]);
  assert.match(tabLabels(h)[0].nonce, HEX32);
  assert.equal(m.calls.length, 1, 'one dialog');
  assert.equal(m.calls[0], DISPLAY_MEDIA_CONSTRAINTS, 'the same constraints object the host used to ask with');
  assert.deepEqual(laneStarts(h), [], 'no pick start: nothing else is sent while the user chooses');
  // The wait reads like the worker's dialog: the pill, Cancel, the lane line, the attention chip, the note and its hints.
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.attr('status-pill', 'data-state'), 'warning');
  assert.equal(h.text('tab-status'), statusLine('ext.status.choosingTab'));
  assert.equal(h.attr('lane-tab-tab', 'data-state'), 'attention');
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), SHORTCUT_LINE()].join(' '));
  await h.advance(7_999);
  assert.ok(!h.text('tab-arm-note').includes(T('ext.arm.pickLost')));
  await h.advance(1);
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.picking'), T('ext.arm.pickSlow'), T('ext.arm.pickLost'), T('ext.arm.pinHint'), SHORTCUT_LINE()].join(' '),
    'after 8 s: where to look, and where the icon is');
  assert.equal(m.calls.length, 1, 'waiting asks nothing again');

  // The user chose tab 9 (it carries this start's label).
  const stream = m.choose({ label: labelFor(h, 9) });
  await h.flush();
  const [audio, video] = stream.all;
  assert.equal(video.readyState, 'ended', 'the video is stopped');
  assert.deepEqual(stream.getVideoTracks(), [], 'and removed from the stream');
  assert.equal(audio.readyState, 'live', 'the audio is kept');
  assert.equal(m.senders.length, 1, 'one relay');
  assert.equal(m.senders[0].track, audio, 'the relay reads the chosen tab\'s audio track');
  assert.match(m.senders[0].relayId, HEX32);
  assert.notEqual(m.senders[0].relayId, tabLabels(h)[0].nonce, 'a fresh id, not the label nonce');
  assert.deepEqual(laneStarts(h), [relayStart(m.senders[0].relayId)], 'ONE start: the relay, the panel\'s tab, the chosen tab, passthrough');
  // The choice is made: the lane reads like any other start (no dialog note, no hint timer, Stop).
  assert.equal(h.text('status-pill'), T('sim.status.preparing'));
  assert.equal(h.attr('status-pill', 'data-state'), 'starting');
  assert.equal(h.text('tab-status'), statusLine('sim.status.preparing'));
  assert.equal(h.text('btn-start'), T('common.stop'));
  assert.equal(h.text('tab-arm-note'), '');
  assert.equal(h.attr('lane-tab-tab', 'data-state'), 'waiting');
  lane.resolve({ ok: true });
  await h.flush();
  assert.equal(h.ports.length, 1, 'a successful start connects the panel to the host');
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  assert.equal(h.text('status-pill'), T('sim.status.running'));
  assert.deepEqual(m.senders[0].stops, [], 'a running lane keeps its relay');
  assert.equal(audio.readyState, 'live');
  assert.equal(m.calls.length, 1);
  assert.ok(h.requests.every((request) => !('pick' in request)), 'the worker\'s dialog is never asked for');
  assert.ok(m.gateCalls.length >= 1, 'the gate was asked');
});

test('2026-10-08 gate on: Chrome left the tab audible (no suppression) -> passthrough false; a label of another start or none -> chosenTab null', async (t) => {
  const loud = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: loud.media });
  h.setHandler(relayWorker());
  await h.click('btn-start');
  loud.choose({ label: labelFor(h, 9), suppressed: false });
  await h.flush();
  assert.deepEqual(laneStarts(h), [relayStart(loud.senders[0].relayId, { passthrough: false })]);

  const foreign = createPanelMedia();
  const f = await harness(t, { settings: settingsWith(), media: foreign.media });
  f.setHandler(relayWorker());
  await f.click('btn-start');
  foreign.choose({ label: `${'0'.repeat(32)}.9` });
  await f.flush();
  assert.deepEqual(laneStarts(f), [relayStart(foreign.senders[0].relayId, { chosenTab: null })], 'another start\'s nonce names no tab');

  const none = createPanelMedia();
  const answer = deferred();
  const n = await harness(t, { settings: settingsWith(), media: none.media, hostUp: true });
  n.setHandler(relayWorker({ start: () => answer.promise }));
  await n.click('btn-start');
  none.choose({ label: null });
  await n.flush();
  assert.deepEqual(laneStarts(n), [relayStart(none.senders[0].relayId, { chosenTab: null })], 'a page without the label names no tab');
  // While that start is in flight the host sets the lane up without an engine and without a tab: that is not a dialog
  // (the panel's own is over), so the panel reads it as starting.
  await n.postState({ tab: { phase: 'starting', engineStatus: null, epoch: 1 } });
  assert.equal(n.text('status-pill'), T('sim.status.preparing'));
  assert.equal(n.text('tab-status'), statusLine('sim.status.preparing'));
  assert.equal(n.text('btn-start'), T('common.stop'));
  assert.equal(n.text('tab-arm-note'), '');
  assert.equal(n.attr('lane-tab-tab', 'data-state'), 'waiting');
  answer.resolve({ ok: true });
  await n.postState({ tab: running('tab', { tabId: null }) });
  assert.equal(n.text('status-pill'), T('sim.status.running'));
  assert.deepEqual(none.senders[0].stops, []);
});

test('2026-10-08 gate on: the label wait is capped at LIMITS.labelWaitMs (1.5 s): a worker that never answers delays the dialog, never stops it; a refused label does not wait at all', async (t) => {
  assert.equal(LIMITS.labelWaitMs, 1_500);
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media });
  h.setHandler(relayWorker({ label: () => new Promise(() => {}) }));
  await h.click('btn-start');
  assert.equal(tabLabels(h).length, 1);
  assert.equal(m.calls.length, 0, 'the dialog waits for the label');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'), 'the wait shows from the click');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  await h.advance(LIMITS.labelWaitMs - 1);
  assert.equal(m.calls.length, 0);
  await h.advance(1);
  assert.equal(m.calls.length, 1, 'at 1.5 s the dialog opens anyway');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));

  const refused = createPanelMedia();
  const r = await harness(t, { settings: settingsWith(), media: refused.media });
  r.setHandler(relayWorker({ label: () => ({ ok: false, code: 'INTERNAL' }) }));
  await r.click('btn-start');
  assert.equal(refused.calls.length, 1, 'a label that could not be put opens the dialog at once');
  assert.equal(r.text('tab-notice'), '');

  // Cancel during the label wait: the dialog never opens.
  const early = createPanelMedia();
  const e = await harness(t, { settings: settingsWith(), media: early.media });
  e.setHandler(relayWorker({ label: () => new Promise(() => {}) }));
  await e.click('btn-start');
  await e.click('btn-start');
  assert.deepEqual(e.types(), ['sw/tab-label', 'sw/lane-stop']);
  await e.advance(10_000);
  assert.equal(early.calls.length, 0, 'no dialog after Cancel');
  assert.equal(e.text('btn-start'), T('common.start'));
  assert.equal(e.attr('status-pill', 'data-state'), 'idle');
  assert.equal(e.browser.clock.pending(), 0, 'no timer is left behind');

  // The panel closed during the label wait: no timer of it survives, and no dialog opens later.
  const closed = createPanelMedia();
  const c = await harness(t, { settings: settingsWith(), media: closed.media });
  c.setHandler(relayWorker({ label: () => new Promise(() => {}) }));
  await c.click('btn-start');
  c.controller.dispose();
  await c.flush();
  assert.equal(c.browser.clock.pending(), 0, 'the label wait and the hint timer are gone with the page');
  await c.advance(10_000);
  assert.equal(closed.calls.length, 0);
});

test('2026-10-08 gate on: a dialog closed 400 ms or more after the FIRST call is a silent idle; sooner, or any other failure, is TAB_CAPTURE_FAILED', async (t) => {
  assert.equal(PICKER_REFUSED_AT_ONCE_MS, 400);
  const closedAfter = async (ms, name) => {
    const m = createPanelMedia();
    const h = await harness(t, { settings: settingsWith(), media: m.media });
    h.setHandler(relayWorker());
    await h.click('btn-start');
    assert.equal(m.calls.length, 1);
    await h.advance(ms);
    m.dismiss(name);
    await h.flush();
    assert.deepEqual(laneStarts(h), [], `${name} after ${ms} ms: nothing is started`);
    assert.equal(m.senders.length, 0);
    assert.equal(h.text('btn-start'), T('common.start'));
    return h;
  };
  const user = await closedAfter(PICKER_REFUSED_AT_ONCE_MS, 'NotAllowedError');
  assert.equal(user.text('tab-notice'), '', 'the user closed it: no alert');
  assert.equal(user.attr('status-pill', 'data-state'), 'idle');
  assert.match(user.text('tab-arm-note'), new RegExp(T('ext.arm.needed').slice(0, 20)), 'back to the idle note');
  for (const [ms, name] of [[PICKER_REFUSED_AT_ONCE_MS - 1, 'NotAllowedError'], [0, 'NotAllowedError'], [5_000, 'AbortError'], [5_000, 'NotFoundError']]) {
    const h = await closedAfter(ms, name);
    assert.equal(h.text('tab-notice'), T('ext.error.TAB_CAPTURE_FAILED'), `${name} after ${ms} ms says so`);
    assert.equal(h.attr('status-pill', 'data-state'), 'error');
  }

  // Measured from the FIRST call: Start, Cancel 300 ms later, Start again (the pending dialog is taken over, not asked
  // again), closed 150 ms after that = 450 ms after the call: the user.
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media });
  h.setHandler(relayWorker());
  await h.click('btn-start');
  await h.advance(300);
  await h.click('btn-start');   // Cancel
  await h.click('btn-start');   // Start again
  assert.equal(tabLabels(h).length, 2);
  assert.equal(m.calls.length, 1, 'taken over');
  await h.advance(150);
  m.dismiss();
  await h.flush();
  assert.equal(h.text('tab-notice'), '', '450 ms after the first call: the user closed it');
  assert.equal(h.attr('status-pill', 'data-state'), 'idle');
});

test('2026-10-08 gate on: a share without audio is TAB_SHARE_NO_AUDIO: every track stopped, no relay, no start', async (t) => {
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media });
  h.setHandler(relayWorker());
  await h.click('btn-start');
  const stream = m.choose({ label: labelFor(h, 9), audio: false });
  await h.flush();
  assert.ok(allEnded(stream), 'nothing of the share stays live');
  assert.equal(m.senders.length, 0);
  assert.deepEqual(laneStarts(h), []);
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_SHARE_NO_AUDIO'));
  assert.equal(h.text('btn-start'), T('common.start'));
  assert.equal(h.text('tab-arm-note'), '', 'the notice speaks alone');
});

test('2026-10-08 gate on: a second Start while the panel\'s dialog is still pending takes it over (no second dialog), with the label of either start', async (t) => {
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media });
  h.setHandler(relayWorker());
  await h.click('btn-start');
  await h.click('btn-start');   // Cancel: the dialog cannot be closed from here, it stays open
  assert.equal(h.text('btn-start'), T('common.start'));
  await h.click('btn-start');   // Start again
  assert.equal(m.calls.length, 1, 'the pending dialog is taken over, never a second one');
  assert.equal(tabLabels(h).length, 2, 'the new start labels its tab again');
  assert.notEqual(tabLabels(h)[0].nonce, tabLabels(h)[1].nonce, 'with a fresh nonce');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  // The page still carries the FIRST start's label: it names the tab all the same.
  const stream = m.choose({ label: labelFor(h, 9, 0) });
  await h.flush();
  assert.equal(stream.all[0].readyState, 'live', 'the newer start owns the stream: it is not released');
  assert.equal(m.senders.length, 1);
  assert.deepEqual(laneStarts(h), [relayStart(m.senders[0].relayId)]);
  // A dialog that came back is not pending any more: the next start opens a new one.
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  await h.click('btn-start');   // Stop
  await h.postState({});
  await h.click('btn-start');
  assert.equal(m.calls.length, 2, 'a new dialog for a new start');
});

test('2026-10-08 gate on: Cancel, the tab lane switched off, the icon and a closed panel each end the dialog wait: the late stream is stopped, nothing is relayed or started', async (t) => {
  const cases = [
    ['Cancel', (h) => h.click('btn-start'), ['sw/tab-label', 'sw/lane-stop']],
    ['the tab lane switched off in the panel', (h) => h.click('tab-enabled'), ['sw/tab-label', 'sw/lane-stop']],
    ['the tab lane switched off in the options page', (h) => h.patchSettings((next) => { next.lanes.tab.enabled = false; }), ['sw/tab-label']],
    ['the panel closed (dispose)', async (h) => { h.controller.dispose(); await h.flush(); }, ['sw/tab-label']],
  ];
  for (const [name, cancel, types] of cases) {
    const m = createPanelMedia();
    const h = await harness(t, { settings: settingsWith(), media: m.media });
    h.setHandler(relayWorker());
    await h.click('btn-start');
    assert.equal(m.calls.length, 1, name);
    await cancel(h);
    const stream = m.choose({ label: labelFor(h, 9) });
    await h.flush();
    assert.ok(allEnded(stream), `${name}: every track of the late stream is stopped at once`);
    assert.equal(m.senders.length, 0, `${name}: no relay`);
    assert.deepEqual(h.types(), types, `${name}: no start`);
    await h.advance(10_000);
    assert.deepEqual(h.types(), types, name);
  }
});

test('2026-10-08 gate on: the icon while the panel\'s dialog is pending stops the wait at once (it does not wait for the dialog), starts the armed tab, and releases the late stream', async (t) => {
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media });
  h.setHandler(relayWorker());
  await h.click('btn-start');
  assert.equal(m.calls.length, 1);
  await clickIcon(h);
  assert.deepEqual(h.types(), ['sw/tab-label', 'sw/lane-stop', 'sw/lane-start'], 'stopped, then the instant path, with the dialog still open');
  assert.deepEqual(laneStarts(h), [ARMED_START]);
  assert.equal(m.pending(), 1, 'the dialog itself could not be closed');
  const stream = m.choose({ label: labelFor(h, 9) });
  await h.flush();
  assert.ok(allEnded(stream), 'what it delivers later is released');
  assert.equal(m.senders.length, 0);
  assert.deepEqual(laneStarts(h), [ARMED_START]);
  assert.equal(h.text('tab-notice'), '');
});

test('2026-10-08 gate on: Stop while the relayed lane runs: the worker stops the lane first, then the relay ends (an own stop, once) and the tab audio is released', async (t) => {
  const stopAnswer = deferred();
  const { h, audio, sender, stream } = await relayRunning(t, { stop: () => stopAnswer.promise });
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  await h.click('btn-start');   // Stop
  assert.deepEqual(h.types().slice(-1), ['sw/lane-stop']);
  assert.deepEqual(sender.stops, [], 'not before the worker answered');
  assert.equal(audio.readyState, 'live');
  stopAnswer.resolve({ ok: true });
  await h.flush();
  assert.deepEqual(sender.stops, ['stop'], 'the relay ends once');
  assert.ok(allEnded(stream), 'the tab audio is released');
  await h.postState({});
  assert.deepEqual(sender.stops, ['stop'], 'and only once');
});

test('2026-10-08 gate on: Stop while the relay start is still in flight ends the relay after the worker\'s answer; the start\'s late START_CANCELLED changes nothing more', async (t) => {
  const lane = deferred();
  const { h, sender, stream } = await relayRunning(t, { start: () => lane.promise });
  assert.equal(h.text('btn-start'), T('common.stop'));
  assert.equal(h.browser.clock.pending(), 0, 'the choice is made: the dialog\'s hint timer and the label wait are over');
  await h.click('btn-start');
  await h.flush();
  assert.deepEqual(sender.stops, ['stop']);
  assert.ok(allEnded(stream));
  lane.resolve({ ok: false, code: 'START_CANCELLED' });
  await h.flush();
  assert.deepEqual(sender.stops, ['stop']);
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('btn-start'), T('common.start'));
});

test('2026-10-08 gate on: the tab lane switched off and the icon on another tab end the relayed lane (relay and track), like Stop', async (t) => {
  const off = await relayRunning(t);
  await off.h.postState({ tab: running('tab', { tabId: 9 }) });
  await off.h.click('tab-enabled');
  assert.deepEqual(off.h.types().slice(-1), ['sw/lane-stop']);
  assert.deepEqual(off.sender.stops, ['stop']);
  assert.ok(allEnded(off.stream));

  const icon = await relayRunning(t);
  await icon.h.postState({ tab: running('tab', { tabId: 9 }) });
  await clickIcon(icon.h);   // tab 7, not the interpreted tab 9: the lane moves here
  assert.deepEqual(icon.h.types().slice(-2), ['sw/lane-stop', 'sw/lane-start']);
  assert.deepEqual(laneStarts(icon.h).at(-1), ARMED_START);
  assert.deepEqual(icon.sender.stops, ['stop']);
  assert.ok(allEnded(icon.stream));

  // The icon on the tab the relay interprets changes nothing.
  const same = await relayRunning(t, { label: 7 });
  await same.h.postState({ tab: running('tab', { tabId: 7 }) });
  const before = same.h.types().length;
  await clickIcon(same.h);
  assert.equal(same.h.types().length, before, 'no stop, no start');
  assert.deepEqual(same.sender.stops, []);
});

test('2026-10-08 gate on: the icon while the relay start is in flight: on the chosen tab nothing happens; on another tab that start is stopped and the clicked tab starts', async (t) => {
  const lane = deferred();
  const same = await relayRunning(t, { start: () => lane.promise, label: 7 });
  assert.deepEqual(same.h.types(), ['sw/tab-label', 'sw/lane-start']);
  await clickIcon(same.h);   // tab 7: the tab chosen in the dialog
  assert.deepEqual(same.h.types(), ['sw/tab-label', 'sw/lane-start'], 'already starting on this tab');
  assert.deepEqual(same.sender.stops, []);
  lane.resolve({ ok: true });
  await same.h.flush();
  assert.deepEqual(same.sender.stops, []);

  const other = deferred();
  const moved = await relayRunning(t, { start: (message) => ('relay' in message ? other.promise : { ok: true }), label: 9 });
  await clickIcon(moved.h);   // tab 7, while the relay start is for tab 9
  assert.deepEqual(moved.h.types(), ['sw/tab-label', 'sw/lane-start', 'sw/lane-stop'], 'the relay start is stopped first');
  assert.deepEqual(moved.sender.stops, ['stop']);
  assert.ok(allEnded(moved.stream));
  other.resolve({ ok: false, code: 'START_CANCELLED' });   // the worker answers it once the host let go of the lane
  await moved.h.flush();
  assert.deepEqual(laneStarts(moved.h).at(-1), ARMED_START, 'then the clicked tab, through the instant path');
  assert.equal(laneStarts(moved.h).length, 2);
  assert.equal(moved.h.text('tab-notice'), '');
});

test('2026-10-08 gate on: a host that said goodbye, or that a probe finds gone, ends the relay; a probe that finds it alive keeps it', async (t) => {
  const probing = (up) => (message) => (message.type === 'sw/host-probe' ? { ok: true, up } : relayWorker()(message));
  const bye = await relayRunning(t, { hostUp: true });
  await bye.h.postState({ tab: running('tab', { tabId: 9 }) });
  await bye.h.post(makeFrame('bye'));
  bye.h.host().port.disconnect();
  await bye.h.flush();
  assert.deepEqual(bye.sender.stops, ['host-gone']);
  assert.ok(allEnded(bye.stream));

  const gone = await relayRunning(t, { hostUp: true });
  gone.h.setHandler(probing(false));
  await gone.h.postState({ tab: running('tab', { tabId: 9 }) });
  gone.h.host().port.disconnect();
  await gone.h.flush();
  assert.deepEqual(gone.h.types().slice(-1), ['sw/host-probe']);
  assert.deepEqual(gone.sender.stops, ['host-gone']);
  assert.ok(allEnded(gone.stream));

  // Lost before the host's first state reached the panel: the relay alone says a lane was started, so the loss is probed.
  const early = await relayRunning(t, { hostUp: true });
  early.h.setHandler(probing(false));
  early.h.host().port.disconnect();
  await early.h.flush();
  assert.deepEqual(early.h.types().slice(-1), ['sw/host-probe']);
  assert.deepEqual(early.sender.stops, ['host-gone']);

  const alive = await relayRunning(t, { hostUp: true });
  alive.h.setHandler(probing(true));
  await alive.h.postState({ tab: running('tab', { tabId: 9 }) });
  const ports = alive.h.ports.length;
  alive.h.host().port.disconnect();
  await alive.h.flush();
  assert.deepEqual(alive.h.types().slice(-1), ['sw/host-probe']);
  assert.equal(alive.h.ports.length, ports + 1, 'it reconnects');
  assert.deepEqual(alive.sender.stops, [], 'the lane goes on: so does its relay');
  assert.equal(alive.stream.all[0].readyState, 'live');
});

test('2026-10-08 gate on: a closed panel (pagehide -> dispose) ends the relay and releases the tab audio; no timer survives', async (t) => {
  const { h, sender, stream } = await relayRunning(t);
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  h.controller.dispose();
  await h.flush();
  assert.deepEqual(sender.stops, ['pagehide']);
  assert.ok(allEnded(stream));
  assert.equal(h.browser.clock.pending(), 0);
  // panel.js disposes the controller on pagehide.
  const entry = (await readText('extension/panel/panel.js')).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(entry.includes("globalThis.addEventListener('pagehide', () => controller.dispose(), { once: true });"));
});

test('2026-10-08 gate on: the host ending the relayed lane (its state, or the host going away) ends the relay; a state from before the start does not', async (t) => {
  const ended = await relayRunning(t, { hostUp: true });
  await ended.h.postState({ tab: running('tab', { tabId: 9, epoch: 1 }) });
  assert.deepEqual(ended.sender.stops, []);
  await ended.h.postState({ tab: failed('TAB_ENDED', { epoch: 1 }) });
  assert.deepEqual(ended.sender.stops, ['lane-over'], 'the lane ended by itself: the relay ends with it');
  assert.ok(allEnded(ended.stream));
  assert.equal(ended.h.text('tab-notice'), T('ext.error.TAB_ENDED'));

  // A state still in transit from before the start (the old run's error, epoch 1) arrives after the answer: the relay of
  // the new run stays. The new run's own states then decide.
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media, hostUp: true });
  h.setHandler(relayWorker());
  await h.postState({ tab: failed('TAB_ENDED', { epoch: 1 }) });
  await h.click('btn-start');
  const stream = m.choose({ label: labelFor(h, 9) });
  await h.flush();
  assert.equal(relayStarts(h).length, 1);
  await h.postState({ tab: failed('TAB_ENDED', { epoch: 1 }) });
  assert.deepEqual(m.senders[0].stops, [], 'the old run\'s state is not the new run\'s end');
  await h.postState({ tab: running('tab', { tabId: 9, epoch: 2 }) });
  assert.deepEqual(m.senders[0].stops, []);
  await h.postState({ tab: running('tab', { tabId: 9, epoch: 3 }) });
  assert.deepEqual(m.senders[0].stops, ['lane-over'], 'another run on the lane is not this relay\'s');
  assert.ok(allEnded(stream));

  // The host went away (its record says down): nothing receives the relay any more.
  const gone = await relayRunning(t, { hostUp: true });
  await gone.h.postState({ tab: running('tab', { tabId: 9 }) });
  await gone.h.setSession(KEYS.host, hostRecord(false));
  assert.deepEqual(gone.sender.stops, ['host-gone']);
  assert.ok(allEnded(gone.stream));

  // A run that ended before any of its states reached the panel: the first state of that run ends the relay.
  const quick = await relayRunning(t, { hostUp: true });
  await quick.h.postState({ tab: failed('TAB_CAPTURE_FAILED', { epoch: 4 }) });
  assert.deepEqual(quick.sender.stops, ['lane-over']);
});

test('2026-10-08 gate on: a relay start the worker refuses ends the relay at once and says why', async (t) => {
  const { h, sender, stream } = await relayRunning(t, { start: () => ({ ok: false, code: 'TAB_CAPTURE_FAILED' }) });
  assert.deepEqual(sender.stops, ['failed']);
  assert.ok(allEnded(stream));
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_CAPTURE_FAILED'));
  assert.equal(h.text('btn-start'), T('common.start'));
  const busy = await relayRunning(t, { start: () => ({ ok: false, code: 'ALREADY_RUNNING' }) });
  assert.deepEqual(busy.sender.stops, ['failed'], 'a lane that already runs elsewhere gets no second capture');
  assert.ok(allEnded(busy.stream));
  assert.equal(busy.h.text('tab-notice'), '');
});

test('2026-10-08 gate on: the NEEDS_ARM retry of a stale armed record goes through the panel\'s dialog', async (t) => {
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(), media: m.media, armed: true });
  h.setHandler(relayWorker({ start: (message) => ('relay' in message ? { ok: true } : { ok: false, code: 'NEEDS_ARM' }) }));
  await h.click('btn-start');
  assert.deepEqual(laneStarts(h), [ARMED_START], 'the armed path first; no pick start after NEEDS_ARM');
  assert.equal(tabLabels(h).length, 1, 'the retry labels the tab');
  assert.equal(m.calls.length, 1, 'and opens the panel\'s dialog');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-notice'), '');
  m.choose({ label: labelFor(h, 7) });
  await h.flush();
  assert.deepEqual(laneStarts(h), [ARMED_START, relayStart(m.senders[0].relayId, { chosenTab: 7 })]);
});

test('2026-10-08 gate on, both lanes: the microphone start is sent while the panel\'s dialog is pending', async (t) => {
  const m = createPanelMedia();
  const h = await harness(t, { settings: settingsWith(bothLanes), media: m.media });
  const shown = () => ['tab', 'mic'].filter((lane) => !h.el(`card-${lane}`).hidden);
  h.setHandler(relayWorker());
  await h.click('lane-tab-mic');
  assert.deepEqual(shown(), ['mic']);
  await h.click('btn-start');
  assert.equal(m.calls.length, 1);
  assert.deepEqual(laneStarts(h), [MIC_START], 'the microphone is never held behind the dialog');
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
  assert.deepEqual(shown(), ['tab'], 'the tab card, with what to do in the dialog, comes forward as for the worker\'s dialog');
  assert.equal(h.text('lane-tab-tab-state'), T('ext.laneTab.attention'));
  await h.postState({ mic: running('mic') });
  assert.equal(h.text('status-pill'), T('ext.status.choosingTab'), 'the microphone interprets while the tab is chosen');
  m.choose({ label: labelFor(h, 9) });
  await h.flush();
  assert.deepEqual(laneStarts(h), [MIC_START, relayStart(m.senders[0].relayId)]);
  // Switching the microphone off leaves the relayed tab lane alone.
  await h.postState({ tab: running('tab', { tabId: 9 }), mic: running('mic') });
  await h.click('mic-enabled');
  assert.deepEqual(h.types().slice(-1), ['sw/lane-stop']);
  assert.deepEqual(h.requests.at(-1), { v: 1, target: 'sw', type: 'sw/lane-stop', lane: 'mic' });
  assert.deepEqual(m.senders[0].stops, []);
});

test('2026-10-08 gate off (Chrome before 153, a missing API, a gate that throws): the worker\'s pick start, exactly as before', async (t) => {
  const variants = [
    ['gate false', () => createPanelMedia({ gate: false })],
    ['gate throws', () => createPanelMedia({ gate: () => { throw new Error('no userAgentData'); } })],
    ['no relay sender', () => { const m = createPanelMedia(); delete m.media.createRelaySender; return m; }],
    ['no random source', () => { const m = createPanelMedia(); delete m.media.random; return m; }],
    ['no dialog function', () => { const m = createPanelMedia(); delete m.media.openShareDialog; return m; }],
  ];
  for (const [name, make] of variants) {
    const m = make();
    const pick = deferred();
    const h = await harness(t, { settings: settingsWith(), media: m.media });
    h.setHandler((message) => (message.type === 'sw/lane-start' ? pick.promise : { ok: true }));
    await h.click('btn-start');
    assert.deepEqual(h.requests, [PICK_START], `${name}: the worker's dialog, nothing else`);
    assert.equal(m.calls.length, 0, `${name}: the panel opens no dialog`);
    assert.equal(h.text('status-pill'), T('ext.status.choosingTab'));
    pick.resolve({ ok: true });
    await h.flush();
    assert.equal(m.senders.length, 0, name);
  }
  // Without `media` at all (every other test of this file) the same.
  const plain = await harness(t, { settings: settingsWith() });
  await plain.click('btn-start');
  assert.deepEqual(plain.requests, [PICK_START]);
});

test('2026-10-08 gate on: the panel sends only worker messages of the documented kinds, and nothing secret', async (t) => {
  const { h } = await relayRunning(t, { hostUp: true });
  await h.postState({ tab: running('tab', { tabId: 9 }) });
  await h.click('btn-start');
  const sent = h.browser.deliveries.filter((entry) => entry.from === 'panel' && entry.kind === 'message').map((entry) => JSON.parse(entry.json));
  assert.deepEqual(sent.map((message) => message.type), ['sw/tab-label', 'sw/lane-start', 'sw/lane-stop']);
  for (const message of sent) {
    assert.equal(message.target, 'sw');
    assert.ok(!('key' in message) && !('streamId' in message) && !('pick' in message));
  }
  assert.ok(!JSON.stringify(sent).includes(FAKE_KEY));
});

test('2026-10-08 gate on, with the real relay (lib/audio-relay.js in the fake relay world): the id the panel sends the worker names the channel its audio arrives on; Stop ends it as an own stop, Chrome\'s "Stop sharing" as the tab\'s end', async (t) => {
  const run = async () => {
    const world = createRelayWorld();
    const m = createPanelMedia();
    m.media.createRelaySender = ({ track, relayId }) => createRelaySender({ track, relayId,
      env: { MediaStreamTrackProcessor: world.MediaStreamTrackProcessor, BroadcastChannel: world.BroadcastChannel } });
    const h = await harness(t, { settings: settingsWith(), media: m.media });
    h.setHandler(relayWorker());
    await h.click('btn-start');
    const stream = m.choose({ label: labelFor(h, 9) });
    await h.flush();
    const [start] = relayStarts(h);
    assert.match(start.relay, HEX32);
    // The host's side of that start, on the id the worker was given.
    const source = createRelaySource({ relayId: start.relay, env: { BroadcastChannel: world.BroadcastChannel,
      MediaStreamTrackGenerator: world.MediaStreamTrackGenerator, AudioData: world.AudioData, MediaStream: FakeMediaStream,
      setTimeout: h.browser.clock.setTimeout, clearTimeout: h.browser.clock.clearTimeout } });
    t.after(() => source.stop());
    let first = 'pending';
    source.firstFrame.then(() => { first = 'arrived'; }, () => { first = 'failed'; });
    const ends = [];
    source.onEnd((reason) => ends.push(reason));
    const audio = stream.all[0];
    assert.equal(world.feed(audio, { frames: 960, sampleRate: 48_000, fill: () => 0.25 }), 1, 'the panel reads the chosen tab\'s audio');
    await h.flush();
    assert.equal(first, 'arrived', 'and it arrives on the host\'s side');
    assert.ok(world.generators[0].samples().length >= 960);
    await h.postState({ tab: running('tab', { tabId: 9 }) });
    return { h, audio, ends };
  };

  const own = await run();
  await own.h.click('btn-start');   // Stop
  await own.h.flush();
  assert.deepEqual(own.ends, ['stop']);
  assert.equal(relayEndCode(own.ends[0]), null, 'the host settles the lane without "the tab ended"');
  assert.equal(own.audio.readyState, 'ended', 'the tab audio is released');

  const closed = await run();
  closed.h.controller.dispose();
  await closed.h.flush();
  assert.deepEqual(closed.ends, ['pagehide']);
  assert.equal(relayEndCode(closed.ends[0]), null);

  const shared = await run();
  shared.audio.end();   // Chrome's "Stop sharing", or the captured tab closed
  await shared.h.flush();
  assert.deepEqual(shared.ends, ['ended']);
  assert.equal(relayEndCode(shared.ends[0]), 'TAB_ENDED', 'the host reports that the tab ended');
});

test('2026-10-08 every end the panel gives a relay is its own (a short word the host never reads as "the tab ended")', () => {
  const code = PANEL_SOURCE.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const reasons = [...code.matchAll(new RegExp("endRelay\\([^,()]+, '([^']*)'\\)", 'g'))].map((match) => match[1]);
  assert.deepEqual([...new Set(reasons)].sort(), ['failed', 'host-gone', 'lane-over', 'pagehide', 'replaced', 'stop']);
  for (const reason of reasons) {
    assert.match(reason, /^[a-z][a-z-]{0,31}$/, reason);
    assert.equal(RELAY_TAB_ENDED.includes(reason), false, `${reason} is not a tab end`);
    assert.equal(relayEndCode(reason), null, `${reason}: a running lane stops without a notice`);
  }
  assert.equal((code.match(/endRelay\(/g) ?? []).length, reasons.length + 1, 'every call names its reason (plus the definition)');
});

test('2026-10-08 panel.js wires the page\'s own dialog, the gate, the relay sender and the random source into the controller', async () => {
  const entry = (await readText('extension/panel/panel.js')).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(entry.includes("import { createRelaySender } from '../lib/audio-relay.js';"));
  assert.ok(entry.includes("import { canOpenDialogInPanel } from '../lib/display-media.js';"));
  assert.match(entry, /canOpenDialog: \(\) => canOpenDialogInPanel\(\{ navigator: globalThis\.navigator, env: globalThis \}\)/);
  assert.match(entry, new RegExp(`openShareDialog: \\(constraints\\) => globalThis\\.navigator\\.mediaDevices\\.${['getDisplay', 'Media'].join('')}\\(constraints\\)`));
  assert.match(entry, /MediaStreamTrackProcessor: globalThis\.MediaStreamTrackProcessor, BroadcastChannel: globalThis\.BroadcastChannel/);
  assert.match(entry, /random: \(bytes\) => globalThis\.crypto\.getRandomValues\(bytes\)/);
  assert.match(entry, /\n {2}media,\n\}\);/);
});
