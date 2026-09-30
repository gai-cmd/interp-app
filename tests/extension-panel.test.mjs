// New implementation of docs/extension.md §11.1 (extension-panel); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeAudioEnv } from './fixtures/fake-audio.mjs';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';
import { FakeEvent, parseHtml } from './fixtures/extension-dom.mjs';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../extension/lib/i18n.js';
import { PORT_NAMES, STORAGE_KEYS, makeFrame, validateFrame } from '../extension/lib/protocol.js';
import { createDefaultSettings, normalizeSettings } from '../extension/lib/settings.js';
import { buildUiState, createIdleLaneState } from '../extension/lib/ui-state.js';
import { PANEL_ELEMENT_IDS, createPanelController } from '../extension/panel/controller.js';
import { UPDATE_MANIFEST_URL, UPDATE_SITE_URL } from '../extension/lib/update-check.js';
import { createHostLink } from '../extension/panel/host-link.js';
import { PAIR_MODEL, TRANSLATION_ONLY_MODEL, buildViewModel } from '../extension/panel/view-model.js';
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

test('rule 1: lane phase comes from the host, pending overrides an idle host, awaiting needs the tab lane and no arm', () => {
  assert.equal(vmOf().lanes.tab.phase, 'off');
  assert.equal(vmOf({ host: hostUi({ tab: running('tab') }) }).lanes.tab.phase, 'running');
  assert.equal(vmOf({ host: hostUi({ tab: { phase: 'stopping' } }) }).lanes.tab.phase, 'stopping');
  assert.equal(vmOf({ pending: { tab: true, mic: false } }).lanes.tab.phase, 'awaiting');
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true }).lanes.tab.phase, 'starting');
  assert.equal(vmOf({ pending: { tab: false, mic: true } }).lanes.mic.phase, 'starting');
  // the microphone lane never waits for the toolbar icon
  assert.equal(vmOf({ pending: { tab: false, mic: true }, armed: false }).lanes.mic.phase, 'starting');
  // pending on a host-idle-error lane is a retry
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true, host: hostUi({ tab: failed('TAB_CAPTURE_BUSY') }) }).lanes.tab.phase, 'starting');
  // a lane the host already runs keeps its host phase (a late pending flag must not regress it to "starting")
  assert.equal(vmOf({ pending: { tab: true, mic: false }, armed: true, host: hostUi({ tab: running('tab') }) }).lanes.tab.phase, 'running');
  // a failed sw/lane-start makes the lane an error lane with that code
  const local = vmOf({ localErrors: { tab: 'TAB_CAPTURE_BUSY', mic: null } });
  assert.equal(local.lanes.tab.phase, 'error');
  assert.equal(local.lanes.tab.notice.key, 'ext.error.TAB_CAPTURE_BUSY');
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
  for (const phase of ['starting', 'reconnecting', 'stopping']) {
    assert.equal(vmOf({ host: hostUi({ tab: { phase } }) }).primary.key, 'common.stop', phase);
  }
  // only the wait for the toolbar-icon click: Cancel
  const awaiting = vmOf({ pending: { tab: true, mic: false } });
  assert.deepEqual(awaiting.primary, { mode: 'stop', key: 'common.cancel', disabled: false });
  // a lane in local error next to the waiting one is not "off": the button says Stop
  const mixed = vmOf({ settings: settingsWith(bothLanes), pending: { tab: true, mic: false }, localErrors: { tab: null, mic: 'MICROPHONE_DENIED' } });
  assert.equal(mixed.primary.key, 'common.stop');
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
    ['awaiting the toolbar click', { pending: { tab: true, mic: false } }, 'warning', 'ext.status.awaitingArm', {}],
    ['awaiting while the microphone starts: starting wins', { settings: both, pending: { tab: true, mic: true } }, 'starting', 'sim.status.preparing', {}],
    ['starting, connecting', { host: hostUi({ tab: { phase: 'starting', engineStatus: 'connecting' } }) }, 'starting', 'sim.status.connecting', {}],
    ['starting, preparing', { host: hostUi({ tab: { phase: 'starting', engineStatus: 'preparing' } }) }, 'starting', 'sim.status.preparing', {}],
    ['starting, host-level step (no engine yet)', { host: hostUi({ tab: { phase: 'starting', engineStatus: null } }) }, 'starting', 'sim.status.preparing', {}],
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
  assert.deepEqual(vmOf({ pending: { tab: true, mic: false } }).lanes.tab.status, { key: 'ext.status.awaitingArm', params: {} });
  assert.equal(status({ tab: { phase: 'starting', engineStatus: 'connecting' } }).key, 'sim.status.connecting');
  assert.equal(status({ tab: { phase: 'starting', engineStatus: 'preparing' } }).key, 'sim.status.preparing');
  assert.equal(status({ tab: { phase: 'starting', engineStatus: null } }).key, 'sim.status.preparing');
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
  // silent codes never become notices and never make the lane an error lane
  for (const code of ['NEEDS_ARM', 'ALREADY_RUNNING', 'START_CANCELLED']) {
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

test('rule 9: the arm note splits needed / waiting / ready and carries hints only where they help', () => {
  const arm = (input) => vmOf(input).lanes.tab.armNote;
  assert.deepEqual(arm({}), { key: 'ext.arm.needed', attention: false, hintKeys: ['ext.arm.pinHint'], shortcut: null });
  assert.equal(arm({ shortcut: 'Alt+Shift+Y' }).shortcut, 'Alt+Shift+Y');
  assert.equal(arm({ shortcut: '' }).shortcut, null, 'an empty shortcut is unassigned');
  assert.deepEqual(arm({ armed: true, shortcut: 'Alt+Shift+Y' }), { key: 'ext.arm.ready', attention: false, hintKeys: [], shortcut: null });
  assert.deepEqual(arm({ pending: { tab: true, mic: false }, shortcut: 'Alt+Shift+Y' }),
    { key: 'ext.arm.waiting', attention: true, hintKeys: ['ext.arm.pinHint'], shortcut: 'Alt+Shift+Y' });
  assert.equal(arm({ targetTab: { id: 7, title: 'x', capturable: false }, armed: true }).key, 'ext.error.TAB_UNSUPPORTED');
  assert.equal(arm({ targetTab: { id: 7, title: 'x', capturable: false } }).attention, false);
  assert.equal(arm({ targetTab: null }).key, 'ext.arm.needed', 'no target tab known');
  // null while the lane is under way
  for (const phase of ['starting', 'running', 'reconnecting']) assert.equal(arm({ armed: true, host: hostUi({ tab: { phase } }) }), null, phase);
  assert.equal(arm({ pending: { tab: true, mic: false }, armed: true }), null, 'starting in flight');
  // a lane the user turned off has nothing to arm
  assert.equal(arm({ settings: settingsWith((s) => { s.lanes.tab.enabled = false; }) }), null);
  // An error that asks for a fresh toolbar click has ITS OWN notice, which says so. The arm note is then null: it used to
  // repeat the instruction (and the pin hint) or, when the record survived, say "ready" next to "click the icon".
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
  // After the user presses Start again the wait is not an error any more: the note is back, the notice is gone.
  const retry = vmOf({ pending: { tab: true, mic: false }, host: hostUi({ tab: failed('TAB_INPUT_LOST') }) });
  assert.equal(retry.lanes.tab.armNote.key, 'ext.arm.waiting');
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
  const muted = vmOf();
  assert.deepEqual(muted.mute, { muted: true, labelKey: 'ext.sound.on', noteVisible: true });
  assert.equal(muted.echoNote, false);
  const none = vmOf({ settings: settingsWith((s) => { s.lanes.tab.enabled = false; }) });
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
  const model = vmOf({ host: hostUi({ tab: running('tab', { targetLanguage: 'en', model: 'gemini-3.8-live' }) }) });
  assert.equal(model.lanes.tab.applyNext, true, 'the settings model is the translation model');
  const fallback = vmOf({ host: hostUi({ tab: running('tab', { targetLanguage: 'en', model: 'gemini-3.8-live', fallback: true }) }) });
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

  // The model note: two-way AND the translation-only model. The tab lane defaults to it, the microphone lane does not.
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
  for (const phase of ['starting', 'running', 'reconnecting', 'stopping']) assert.equal(vmOf({ host: hostUi({ tab: { phase } }) }).closeNote, true, phase);
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
    fetch = null, manifestVersion = null,
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
    navigator, fetch,
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
  assert.equal(ko.el('tab-volume').value, '65');
  assert.equal(ko.text('tab-volume-value'), T('ext.volume.value', { percent: 65 }));

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
  assert.equal(h.text('mute-note'), T('ext.mic.mutedHint'));
  for (const id of ['stop-note', 'no-lane-note', 'echo-note', 'usage-note', 'tab-notice', 'mic-notice', 'tab-apply-next', 'mic-apply-next', 'tab-output', 'tab-gap']) {
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

test('Start on an un-armed tab waits (Cancel), starts by itself when the armed record appears and only then', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
  await h.click('btn-start');
  assert.deepEqual(h.types(), [], 'nothing can be minted before the toolbar click');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.attr('status-pill', 'data-state'), 'warning');
  assert.equal(h.text('status-pill'), T('ext.status.awaitingArm'));
  assert.equal(h.text('tab-status'), T('ext.lane.statusLine', { lane: T('ext.lane.tab.title'), status: T('ext.status.awaitingArm') }));
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
  assert.match(h.text('tab-arm-note'), new RegExp(T('ext.arm.waiting').slice(0, 20)));
  await h.setSession(KEYS.armed, armedRecord());
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'tab', tabId: 7 }], 'the icon click started it');
  await h.setSession(KEYS.armed, armedRecord([7], 5));
  assert.equal(h.requests.length, 1, 'a later arm event does not start it again');
});

test('an arm event without a pending Start only makes the tab ready; Cancel drops the wait', async (t) => {
  const idle = await harness(t, { settings: settingsWith() });
  await idle.setSession(KEYS.armed, armedRecord());
  assert.deepEqual(idle.types(), []);
  assert.equal(idle.text('tab-arm-note'), T('ext.arm.ready'));

  const h = await harness(t, { settings: settingsWith() });
  await h.click('btn-start');
  await h.click('btn-start');
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/lane-stop' }], 'Cancel goes through the worker');
  assert.equal(h.text('btn-start'), T('common.start'));
  await h.setSession(KEYS.armed, armedRecord());
  assert.deepEqual(h.types(), ['sw/lane-stop'], 'the cancelled wait is gone');
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

test('a capture that stopped arriving is explained by ONE line, the alert, even when the record is still there; Start then waits with the arm note only', async (t) => {
  const h = await harness(t, { settings: settingsWith(), hostUp: true, armed: true });
  await h.postState({ tab: failed('BROWSER_INTERRUPTED') });
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_INPUT_LOST'));
  assert.equal(h.text('tab-arm-note'), '', 'the arm note used to repeat the same click-the-icon instruction, plus the pin hint and the shortcut');
  assert.equal(h.attr('tab-arm-note', 'data-attention'), null);
  // The native TAB_INPUT_LOST code says the same thing.
  await h.postState({ tab: failed('TAB_INPUT_LOST') });
  assert.equal(h.text('tab-notice'), T('ext.error.TAB_INPUT_LOST'));
  assert.equal(h.text('tab-arm-note'), '');
  // The record is spent (the worker will say NEEDS_ARM): Start turns into a wait, and then the arm note (with the hints)
  // is the only text, because the wait is not an error any more.
  h.setHandler(() => ({ ok: false, code: 'NEEDS_ARM' }));
  await h.click('btn-start');
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('tab-notice'), '');
  assert.equal(h.text('tab-arm-note'), [T('ext.arm.waiting'), T('ext.arm.pinHint'), T('ext.arm.shortcut', { shortcut: 'Alt+Shift+Y' })].join(' '));
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
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

test('a NEEDS_ARM answer turns the start into a wait for the toolbar click', async (t) => {
  const h = await harness(t, { settings: settingsWith(), armed: true });
  h.setHandler(() => ({ ok: false, code: 'NEEDS_ARM' }));
  await h.click('btn-start');
  assert.equal(h.requests.length, 1);
  assert.equal(h.text('btn-start'), T('common.cancel'));
  assert.equal(h.text('status-pill'), T('ext.status.awaitingArm'));
  assert.equal(h.text('tab-notice'), '', 'NEEDS_ARM is never a notice');
  assert.equal(h.attr('tab-arm-note', 'data-attention'), 'true');
  h.setHandler(() => ({ ok: true }));
  await h.setSession(KEYS.armed, armedRecord([7], 9));
  assert.equal(h.requests.length, 2, 'the fresh arm starts it');
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

test('the microphone gate: denied and prompt block the start without a message; granted and unknown proceed', async (t) => {
  const mic = settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; });
  for (const state of ['denied', 'prompt']) {
    const h = await harness(t, { settings: mic, micPermission: state });
    assert.equal(h.text('mic-permission-status'), `${T('permission.title')} · ${T(`permission.${state}`)}`);
    assert.equal(h.el('btn-mic-allow').hidden, false);
    await h.click('btn-start');
    assert.deepEqual(h.types(), [], state);
    assert.equal(h.text('mic-notice'), T('ext.error.MICROPHONE_DENIED'), state);
    assert.equal(h.attr('btn-mic-permission', 'data-attention'), 'true', state);
    assert.equal(h.attr('btn-mic-allow', 'data-attention'), 'true', state);
    assert.equal(h.attr('mic-notice', 'role'), 'alert');
  }
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

test('the microphone permission is watched live and an expired one-time grant reads as expired', async (t) => {
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
  assert.deepEqual(h.types(), []);
  assert.equal(h.text('mic-notice'), T('ext.error.MICROPHONE_EXPIRED'), 'it was granted earlier in this panel\'s life');
  assert.equal(h.attr('btn-mic-permission', 'data-attention'), 'true');
});

test('a refusal recorded while the microphone permission was missing is gone the moment it is granted (notice, failed pill, attention)', async (t) => {
  const mic = settingsWith((s) => { s.lanes.tab.enabled = false; s.lanes.mic.enabled = true; });
  const h = await harness(t, { settings: mic, micPermission: 'prompt' });
  await h.click('btn-start');
  assert.deepEqual(h.types(), [], 'the gate refused without a message');
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
  // And the next Start is an ordinary start.
  await h.click('btn-start');
  assert.deepEqual(h.requests, [{ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'mic' }]);
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
  // The note only where the lane's model is the translation-only one: the tab lane by default, not the microphone lane.
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
  const h = await harness(t, { settings: settingsWith(), armed: true });
  const writes = () => h.localSets.filter((entry) => KEYS.settings in entry.items).length;
  const before = JSON.parse(JSON.stringify(h.stored()));
  const written = writes();
  await h.click('tab-two-way');
  assert.equal(h.stored().lanes.tab.twoWay, true, 'saved');
  assert.equal(writes() - written, 1, 'exactly one write');
  assert.deepEqual(changedPaths(before, h.stored()), ['lanes.tab.twoWay']);
  assert.equal(h.el('tab-partner-row').hidden, false);
  assert.equal(h.text('tab-target-label'), T('ext.twoWay.targetLabel'));
  assert.equal(h.el('tab-two-way-note').hidden, false, 'the tab lane defaults to the translation-only model');
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

test('a storage failure leaves the controls on the stored state and never throws into the page', async (t) => {
  const h = await harness(t, { settings: settingsWith() });
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
  const h = await harness(t, { settings: settingsWith() });
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
  const h = await harness(t, { settings: settingsWith(), languages: ['en-US'] });
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
