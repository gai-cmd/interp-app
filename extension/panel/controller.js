// New implementation of docs/extension.md §8.2.4-§8.2.7; no legacy code is ported.
// The side panel's DOM binding and actions. All state is derived by the pure view model (view-model.js); this file
// owns the local pieces of the state machine (a Start waiting for the toolbar-icon click, starts in flight, local
// errors, why the last run ended), turns user events into one-field settings writes plus commands to the service
// worker, and renders the frozen view model with textContent and attributes only. The panel never holds an engine,
// a key or a stream, and it never sends host/lane-start or host/lane-stop: Stop goes through the worker, which alone
// knows about a start that has not reached the host yet (6.11).
import { selectLanguage } from '../../app/i18n/index.js';
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { isMachineCode } from '../lib/constants.js';
import { applyI18n } from '../lib/dom-i18n.js';
import { createFallbackI18n } from '../lib/i18n.js';
import { LIMITS, STORAGE_KEYS, makeMessage } from '../lib/protocol.js';
import {
  createDefaultSettings, hasKey, normalizeSettings, readSettings, setLaneTargetLanguage, updateSettings, writeSettings,
} from '../lib/settings.js';
import { createHostLink } from './host-link.js';
import { LANE_TITLE_KEY, buildViewModel } from './view-model.js';

// Every element id the controller touches; a test parses panel.html and checks each one exists (8.1).
export const PANEL_ELEMENT_IDS = Object.freeze([
  'status-pill', 'key-missing-text', 'btn-key-options', 'stop-note', 'no-lane-note', 'mute-note', 'echo-note', 'close-note',
  'usage-note', 'btn-start', 'btn-mic-permission', 'btn-mute', 'btn-options', 'btn-mic-allow', 'mic-permission-status',
  'tab-enabled', 'tab-target', 'tab-apply-next', 'tab-volume', 'tab-volume-value', 'tab-captions', 'tab-tabline',
  'tab-arm-note', 'tab-status', 'tab-route', 'tab-route-note', 'tab-output', 'tab-gap', 'tab-level', 'tab-notice',
  'tab-preview', 'mic-enabled', 'mic-target', 'mic-apply-next', 'mic-captions', 'mic-status', 'mic-route',
  'mic-route-note', 'mic-output', 'mic-gap', 'mic-level', 'mic-notice', 'mic-preview',
  'tab-target-label', 'tab-two-way', 'tab-partner-row', 'tab-partner', 'tab-two-way-note',
  'mic-target-label', 'mic-two-way', 'mic-partner-row', 'mic-partner', 'mic-two-way-note',
]);

const LANES = Object.freeze(['tab', 'mic']);
const ACTIVE = Object.freeze(['starting', 'running', 'reconnecting']);
// The partner select is rebuilt (its options are the languages other than the lane's first one), so its options are
// made here and take their binder key from this table (keys are literals, never built from the language code).
const LANGUAGE_KEY = Object.freeze({ ko: 'language.ko', en: 'language.en', ja: 'language.ja' });
const CAPTURABLE_SCHEMES = Object.freeze(['http:', 'https:', 'file:']);
const PERMISSION_STATES = Object.freeze(['granted', 'denied', 'prompt']);
const FRESH_STOP_MS = 60_000;          // a lastStop record older than this is history, not news
const OWN_STOP_MS = 5_000;             // a port loss this soon after our own Stop is expected
const VOLUME_THROTTLE_MS = 120;
const I18N_RETRY_MS = Object.freeze([2_000, 6_000, 18_000]);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const settle = async (task) => { try { return await task(); } catch { return undefined; } };
const isObject = (value) => value !== null && typeof value === 'object';
const schemeOf = (url) => attempt(() => new URL(url).protocol) ?? '';
const boundedTitle = (title) => (typeof title === 'string' && title !== ''
  ? [...title].slice(0, LIMITS.titleMaxChars).join('') : null);

const defaultSettingsApi = Object.freeze({ readSettings, updateSettings, writeSettings, hasKey });

/**
 * createPanelController({ document, adapter, i18n: { current }, loadI18n, settingsApi, createHostLink, timers,
 * navigator }) -> Readonly<{ start(), dispose(), viewModel() }>. `i18n` is a mutable holder so the language can be
 * replaced (load finished, load retried) without rebuilding the controller.
 */
export function createPanelController({
  document, adapter, i18n, loadI18n, settingsApi = defaultSettingsApi, createHostLink: makeHostLink = createHostLink,
  timers = {}, navigator = {},
} = {}) {
  const setTimeout = timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimeout = timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const now = timers.now ?? (() => Date.now());
  const local = adapter.storage.local;
  const session = adapter.storage.session;
  const t = (key, params) => i18n.current.t(key, params);

  // ---------------------------------------------------------------------------------------------
  // State. `awaiting` = Start pressed on an un-armed tab (the toolbar click will start it); `inFlight` = a
  // sw/lane-start is under way. Both are "pending" to the view model, which tells them apart by the armed flag.
  const S = {
    settings: createDefaultSettings('en'), keyPresent: BUILTIN_KEYS.length > 0,
    host: null, hostUp: false, lastActive: false, previews: { tab: null, mic: null },
    windowId: null, targetTab: null, armed: false, armedRecord: undefined, armedTick: 0, shortcut: null,
    micPermission: 'unknown', micWasGranted: false,
    awaiting: false, inFlight: { tab: false, mic: false }, localErrors: { tab: null, mic: null },
    // The two-way choice each running lane was started with (LaneState does not carry it); written by startOne.
    runWith: { tab: null, mic: null },
    stopReason: null, ownStopAt: -Infinity, startRun: 0, capturedTabId: null, capturedTitle: null,
    appliedLanguage: null,
  };
  let disposed = false;
  let latest = null;
  const els = new Map();
  const removers = [];
  const previewSignature = { tab: '', mic: '' };
  const partnerSignature = { tab: '', mic: '' };
  const volume = { timer: null, value: null, writtenAt: -Infinity };
  let retryTimer = null;
  let refreshSerial = 0;
  let permissionStatus = null;
  let permissionListener = null;

  // ---------------------------------------------------------------------------------------------
  // Commands to the service worker: identical normalization to the worker's sendToHost (6.3). A rejection means the
  // worker could not be reached; success REQUIRES res?.ok === true.
  async function sendToSw(message) {
    let res;
    try { res = await adapter.runtime.sendMessage(message); } catch { return { ok: false, code: 'HOST_UNAVAILABLE' }; }
    if (isObject(res) && res.ok === true) return res;
    return { ok: false, code: isObject(res) && isMachineCode(res.code) ? res.code : 'HOST_UNAVAILABLE' };
  }

  // ---------------------------------------------------------------------------------------------
  // The view model and its rendering.
  const pendingOf = () => ({ tab: S.awaiting || S.inFlight.tab, mic: S.inFlight.mic });
  function computeViewModel() {
    return buildViewModel({
      settings: S.settings, keyPresent: S.keyPresent, host: S.host, armed: S.armed, targetTab: S.targetTab,
      shortcut: S.shortcut, micPermission: S.micPermission, micWasGranted: S.micWasGranted, pending: pendingOf(),
      localErrors: S.localErrors, stopReason: S.stopReason, previews: S.previews, capturedTitle: S.capturedTitle,
      runWith: S.runWith, language: i18n.current.language, has: (key) => i18n.current.has(key),
    });
  }

  const setText = (id, text) => { const el = els.get(id); if (el && el.textContent !== text) el.textContent = text; };
  const setHidden = (id, hidden) => { const el = els.get(id); if (el && el.hidden !== hidden) el.hidden = hidden; };
  const setChecked = (id, checked) => { const el = els.get(id); if (el && el.checked !== checked) el.checked = checked; };
  function setValue(id, value) {
    const el = els.get(id);
    if (el && String(el.value) !== String(value)) el.value = String(value);
  }
  function setAttr(id, name, value) {
    const el = els.get(id);
    if (!el) return;
    if (value === null) { if (el.getAttribute(name) !== null) el.removeAttribute(name); } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function showVolume(percent) {
    const text = t('ext.volume.value', { percent });
    setText('tab-volume-value', text);
    setAttr('tab-volume', 'aria-valuetext', text);
  }

  function makePreviewRow(row) {
    const p = document.createElement('p');
    p.className = 'caption-row';
    p.setAttribute('data-status', row.status);
    p.setAttribute('data-role', row.role);
    // Skipped and interrupted rows carry a text label as well: state is never colour alone.
    const flagKey = row.skipped ? 'sim.captions.skipped' : row.status === 'interrupted' ? 'sim.captions.interrupted' : null;
    if (flagKey) {
      const flag = document.createElement('span');
      flag.className = 'caption-flag';
      flag.textContent = t(flagKey);
      p.append(flag, ' ', row.text);   // append takes strings: no createTextNode of a literal
    } else {
      p.textContent = row.text;
    }
    if (row.skipped) p.setAttribute('data-skipped', 'true');
    return p;
  }

  function renderPreview(lane, rows) {
    const el = els.get(`${lane}-preview`);
    if (!el) return;
    const signature = JSON.stringify([rows, i18n.current.language]);
    if (previewSignature[lane] !== signature) {
      previewSignature[lane] = signature;
      el.replaceChildren(...rows.map(makePreviewRow));
    }
    if (el.hidden !== (rows.length === 0)) el.hidden = rows.length === 0;
  }

  // The partner select offers every language but the lane's first one. Rebuilt only when the choices change (a rebuild
  // closes an open dropdown; a language change needs none, the binder re-translates the options through their data-i18n);
  // the selection is set again afterwards because a new option list resets it.
  function renderPartner(lane, vm) {
    const select = els.get(`${lane}-partner`);
    if (!select) return;
    const signature = vm.partnerOptions.join(',');
    if (partnerSignature[lane] !== signature) {
      partnerSignature[lane] = signature;
      select.replaceChildren(...vm.partnerOptions.map((code) => {
        const option = document.createElement('option');
        option.setAttribute('value', code);
        option.setAttribute('data-i18n', LANGUAGE_KEY[code]);   // the binder keeps it in step with a later language change
        option.textContent = t(LANGUAGE_KEY[code]);
        return option;
      }));
    }
    setValue(`${lane}-partner`, vm.partnerLanguage ?? vm.partnerOptions[0]);
  }

  function renderLane(lane, vm) {
    setChecked(`${lane}-enabled`, vm.enabled);
    setValue(`${lane}-target`, vm.targetLanguage);
    setAttr(`${lane}-target-label`, 'data-i18n', vm.targetLabelKey);
    setText(`${lane}-target-label`, t(vm.targetLabelKey));
    setChecked(`${lane}-two-way`, vm.twoWay);
    // A plain non-live row: hidden is fine here (8.2.1 forbids it only on live regions).
    setHidden(`${lane}-partner-row`, !vm.twoWay);
    renderPartner(lane, vm);
    setHidden(`${lane}-two-way-note`, !vm.modelNote);
    setChecked(`${lane}-captions`, vm.captions);
    setText(`${lane}-apply-next`, vm.applyNext ? t('ext.applyNext') : '');
    setText(`${lane}-status`, t('ext.lane.statusLine', {
      lane: t(LANE_TITLE_KEY[lane]), status: t(vm.status.key, vm.status.params),
    }));
    if (vm.route) {
      const text = vm.route.model ? `${t(vm.route.textKey)} · ${vm.route.model}` : t(vm.route.textKey);
      setText(`${lane}-route`, text);
    } else {
      setText(`${lane}-route`, '');
    }
    setHidden(`${lane}-route`, vm.route === null);
    setText(`${lane}-route-note`, vm.routeNote ? t(vm.routeNote) : '');
    setText(`${lane}-output`, vm.output ? t(vm.output) : '');
    setText(`${lane}-gap`, vm.gap ? t(vm.gap) : '');
    setText(`${lane}-notice`, vm.notice ? t(vm.notice.key, vm.notice.params) : '');
    setHidden(`${lane}-level`, !vm.levelVisible);
    setValue(`${lane}-level`, vm.level);
    renderPreview(lane, vm.preview);
  }

  function render() {
    if (disposed || !i18n.current) return;
    const vm = computeViewModel();
    latest = vm;
    setText('status-pill', t(vm.pill.key, vm.pill.params));
    setAttr('status-pill', 'data-state', vm.pill.state);
    setText('key-missing-text', vm.keyMissing ? t('ext.key.missing') : '');
    setHidden('btn-key-options', !vm.keyMissing);
    setText('stop-note', vm.stopNote ? t(vm.stopNote) : '');
    setText('no-lane-note', vm.noLane ? t('ext.status.noLane') : '');
    setText('mute-note', vm.mute.noteVisible ? t('ext.mic.mutedHint') : '');
    setText('echo-note', vm.echoNote ? t('ext.sound.echoWarning') : '');
    setHidden('close-note', !vm.closeNote);
    const usage = vm.usageNote.visible
      ? `${t('ext.usage.twoSessions')}${vm.usageNote.emphasis ? ` ${t('ext.usage.quotaHint')}` : ''}` : '';
    setText('usage-note', usage);
    setAttr('usage-note', 'data-emphasis', vm.usageNote.emphasis ? 'true' : null);

    for (const lane of LANES) renderLane(lane, vm.lanes[lane]);
    if (volume.value === null) setValue('tab-volume', vm.lanes.tab.volume);
    showVolume(volume.value ?? vm.lanes.tab.volume);

    const tabline = vm.lanes.tab.tabline;
    setText('tab-tabline', tabline ? t('ext.tab.target', { title: tabline.title }) : '');
    setHidden('tab-tabline', tabline === null);
    const arm = vm.lanes.tab.armNote;
    const armText = arm ? [t(arm.key), ...arm.hintKeys.map((key) => t(key)),
      arm.shortcut ? t('ext.arm.shortcut', { shortcut: arm.shortcut }) : ''].filter(Boolean).join(' ') : '';
    setText('tab-arm-note', armText);
    setAttr('tab-arm-note', 'data-attention', arm?.attention ? 'true' : null);

    const permission = vm.micPermission;
    setText('mic-permission-status', permission.textKeys.map((key) => t(key)).join(' · '));
    setHidden('btn-mic-allow', !permission.allowButton);
    const attention = permission.attention ? 'true' : null;
    setAttr('btn-mic-permission', 'data-attention', attention);
    setAttr('btn-mic-allow', 'data-attention', attention);
    const optionsAttention = LANES.some((lane) => vm.lanes[lane].notice?.attention === 'options') ? 'true' : null;
    setAttr('btn-options', 'data-attention', optionsAttention);

    setText('btn-start', t(vm.primary.key));
    // aria-disabled, never `disabled`: a natively disabled button is skipped by Tab, so its aria-describedby (the reason
    // it cannot start) would be out of a keyboard user's reach. onPrimary ignores the click; styles.css draws it dimmed.
    setAttr('btn-start', 'aria-disabled', vm.primary.disabled ? 'true' : null);
    setAttr('btn-mute', 'data-muted', String(vm.mute.muted));
    setAttr('btn-mute', 'aria-label', t(vm.mute.labelKey));
    setAttr('btn-mute', 'title', t(vm.mute.labelKey));
  }

  // ---------------------------------------------------------------------------------------------
  // Settings: every user event writes ONE field first, then performs its command (8.2.4).
  async function writeField(mutator) {
    try { S.settings = await settingsApi.updateSettings(local, mutator); } catch { /* the controls snap back to what is stored */ }
    applyLanguageIfChanged();
    render();
  }

  function resolvedLanguage() {
    const chosen = S.settings.uiLanguage;
    return chosen === 'auto' ? selectLanguage(navigator.languages ?? []) : chosen;
  }
  function applyLanguageIfChanged() {
    const language = resolvedLanguage();
    if (S.appliedLanguage === language) return;
    S.appliedLanguage = language;
    i18n.current.setLanguage(language);
    applyI18n(document, i18n.current);
    previewSignature.tab = ''; previewSignature.mic = '';
  }

  // ---------------------------------------------------------------------------------------------
  // Target tab, arming, shortcut, last stop.
  function tabViewOf(tab) {
    if (!isObject(tab) || !Number.isInteger(tab.id)) return null;
    const capturable = typeof tab.url === 'string' ? CAPTURABLE_SCHEMES.includes(schemeOf(tab.url)) : true;
    return { id: tab.id, title: boundedTitle(tab.title), capturable };
  }
  const armedIn = (record, tabId) => isObject(record) && record.v === 1 && isObject(record.tabs)
    && Number.isInteger(tabId) && Object.hasOwn(record.tabs, String(tabId));
  async function readSession(key) {
    const stored = await settle(() => session.get(key));
    return isObject(stored) ? stored[key] : undefined;
  }

  async function refreshTarget() {
    const serial = ++refreshSerial;
    const query = S.windowId === null ? { active: true, currentWindow: true } : { active: true, windowId: S.windowId };
    const found = await settle(() => adapter.tabs.query(query));
    const seen = S.armedTick;
    const record = await readSession(STORAGE_KEYS.armed);
    if (disposed || serial !== refreshSerial) return;
    // A storage event that arrived while this read was in flight is newer than the read: it wins.
    if (seen === S.armedTick) S.armedRecord = record;
    S.targetTab = tabViewOf(Array.isArray(found) ? found[0] : null);
    S.armed = armedIn(S.armedRecord, S.targetTab?.id);
    maybeAutoStart();
    render();
  }

  function stopReasonOf(record) {
    if (!isObject(record) || record.v !== 1 || !Number.isFinite(record.at)) return null;
    if (now() - record.at > FRESH_STOP_MS) return null;
    return record.reason === 'panel-gone' || record.reason === 'host-lost' ? record.reason : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Starting and stopping (8.2.5).
  async function startOne(lane, run) {
    if (lane === 'mic') {
      if (S.micPermission === 'denied' || S.micPermission === 'prompt') {
        S.localErrors.mic = 'MICROPHONE_DENIED';   // no message sent: the host would only fail the same way
        render();
        return;
      }
    } else {
      if (S.targetTab === null) { S.localErrors.tab = 'TAB_GONE'; render(); return; }
      // The arm note already says this page cannot be captured: an alert and a pill turned to "failed" would only
      // repeat it, so the press is a no-op for this lane (the microphone lane of the same Start still runs).
      if (S.targetTab.capturable === false) return;
      if (!S.armed) { S.awaiting = true; render(); return; }   // the toolbar-icon click will start it
    }
    S.inFlight[lane] = true;
    render();
    // The worker builds the request (language, model and the pair) from the stored settings; the panel only remembers
    // which two-way choice it started with, so a later change can say "applies from the next start".
    const started = { twoWay: S.settings.lanes[lane].twoWay === true, partnerLanguage: S.settings.lanes[lane].partnerLanguage ?? null };
    let res;
    try {
      res = await sendToSw(makeMessage('sw/lane-start', lane === 'tab' ? { lane, tabId: S.targetTab.id } : { lane }));
    } catch { res = { ok: false, code: 'INVALID_REQUEST' }; }
    S.inFlight[lane] = false;
    if (res.ok) {
      S.runWith[lane] = started;
      link.connect();   // (c) a successful start: the host exists now
    } else if (res.code === 'NEEDS_ARM') {
      if (run === S.startRun && lane === 'tab') { S.awaiting = true; S.armed = false; }
    } else if (res.code !== 'ALREADY_RUNNING' && res.code !== 'START_CANCELLED' && run === S.startRun) {
      S.localErrors[lane] = res.code;
    }
    render();
  }

  async function startLanes(lanes, { all = false } = {}) {
    S.stopReason = null;
    for (const lane of all ? LANES : lanes) S.localErrors[lane] = null;
    const run = ++S.startRun;
    render();
    for (const lane of LANES) {   // sequential: the tab lane first, then the microphone
      if (!lanes.includes(lane)) continue;
      if (run !== S.startRun) return;   // a Stop pressed meanwhile also prevents the second lane from being sent
      if (!S.settings.lanes[lane].enabled) continue;   // so does unchecking that lane while the first one was starting
      await startOne(lane, run);
    }
  }

  function maybeAutoStart() {
    if (!S.awaiting || !S.armed || S.inFlight.tab || S.targetTab === null) return;
    S.awaiting = false;
    S.localErrors.tab = null;
    void startOne('tab', S.startRun);
  }

  async function stopLanes(lane) {
    S.ownStopAt = now();
    if (lane === undefined) {
      S.startRun += 1;
      S.awaiting = false;
      S.inFlight = { tab: false, mic: false };
    } else {
      if (lane === 'tab') S.awaiting = false;
      S.inFlight[lane] = false;
    }
    render();
    await sendToSw(makeMessage('sw/lane-stop', lane === undefined ? {} : { lane }));
  }

  const onPrimary = async () => {
    const { primary } = computeViewModel();
    if (primary.disabled) return;   // aria-disabled keeps the button focusable; it does not stop the click
    if (primary.mode === 'stop') { await stopLanes(undefined); return; }
    await startLanes(LANES.filter((lane) => S.settings.lanes[lane].enabled), { all: true });
  };

  async function onLaneToggled(lane, enabled) {
    await writeField((settings) => { settings.lanes[lane].enabled = enabled; });
    if (computeViewModel().primary.mode !== 'stop') return;
    if (enabled) await startLanes([lane]);
    else await stopLanes(lane);
  }

  // ---------------------------------------------------------------------------------------------
  // Volume: at most one write per 120 ms while dragging, and the final value on `change`.
  const readVolume = () => {
    const number = Math.round(Number(els.get('tab-volume')?.value));
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 65;
  };
  function flushVolume() {
    clearTimeout(volume.timer);
    volume.timer = null;
    if (volume.value === null) return Promise.resolve();
    const percent = volume.value;
    volume.value = null;
    volume.writtenAt = now();
    return writeField((settings) => { settings.lanes.tab.originalVolume = percent; });
  }
  function onVolumeInput() {
    volume.value = readVolume();
    showVolume(volume.value);
    const wait = VOLUME_THROTTLE_MS - (now() - volume.writtenAt);
    if (wait <= 0) { void flushVolume(); return; }
    if (volume.timer === null) volume.timer = setTimeout(() => { volume.timer = null; void flushVolume(); }, wait);
  }
  const onVolumeChange = () => { volume.value = readVolume(); return flushVolume(); };

  // ---------------------------------------------------------------------------------------------
  // The host connection (8.2.7).
  function resolveCapturedTitle(state) {
    const tabState = state.lanes.tab;
    const id = ACTIVE.includes(tabState.phase) ? tabState.tabId : null;
    if (id === S.capturedTabId) return;
    S.capturedTabId = id;
    S.capturedTitle = null;
    if (id === null) return;
    void settle(async () => {
      const tab = await adapter.tabs.get(id);
      if (!disposed && S.capturedTabId === id) { S.capturedTitle = boundedTitle(tab?.title); render(); }
    });
  }

  function onState(state) {
    S.host = state;
    S.lastActive = LANES.some((lane) => ACTIVE.includes(state.lanes[lane].phase));
    if (S.lastActive) S.stopReason = null;
    for (const lane of LANES) {
      const laneState = state.lanes[lane];
      if (laneState.phase !== 'off' && laneState.phase !== 'error') S.localErrors[lane] = null;   // it is running now
      else S.runWith[lane] = null;   // the run is over: the next start records its own choice
      if (S.previews[lane] && S.previews[lane].epoch !== laneState.epoch) S.previews[lane] = null;
    }
    resolveCapturedTitle(state);
    render();
  }
  function onCaptions(frame) {
    S.previews[frame.lane] = frame;
    render();
  }
  async function onConnection(connected, info) {
    if (connected) return;
    const wasActive = S.lastActive;
    S.host = null;
    S.lastActive = false;
    S.previews = { tab: null, mic: null };
    S.runWith = { tab: null, mic: null };
    S.capturedTabId = null;
    S.capturedTitle = null;
    render();
    // UNEXPECTED loss: the last state had a lane under way, the host did not say goodbye and we did not press Stop.
    if (info?.bye || !wasActive || now() - S.ownStopAt <= OWN_STOP_MS) return;
    if (S.stopReason !== 'panel-gone') S.stopReason = 'host-lost';
    render();
    const res = await sendToSw(makeMessage('sw/host-probe', {}));
    if (disposed) return;
    if (res.ok && res.up === true) {   // the document is alive after all: reconnect instead of claiming a loss
      if (S.stopReason === 'host-lost') S.stopReason = null;
      link.connect();
    } else {
      S.hostUp = false;
    }
    render();
  }
  const link = makeHostLink({ adapter, onState, onCaptions, onConnection });

  function onHostRecord(record) {
    const up = isObject(record) && record.up === true;
    if (up) {
      S.hostUp = true;
      link.connect();
    } else if (S.hostUp) {
      S.hostUp = false;
      link.disconnect();
      S.host = null;
      S.lastActive = false;
      S.previews = { tab: null, mic: null };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Adapter events.
  function onStorageChanged(changes, areaName) {
    if (disposed || !isObject(changes)) return;
    if (areaName === 'local') {
      if (changes[STORAGE_KEYS.settings]) {
        S.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
        applyLanguageIfChanged();
      }
      if (changes[STORAGE_KEYS.key]) void refreshKey();
    } else if (areaName === 'session') {
      if (changes[STORAGE_KEYS.armed]) {
        S.armedTick += 1;
        S.armedRecord = changes[STORAGE_KEYS.armed].newValue;
        S.armed = armedIn(S.armedRecord, S.targetTab?.id);
        maybeAutoStart();
      }
      if (changes[STORAGE_KEYS.host]) onHostRecord(changes[STORAGE_KEYS.host].newValue);
      if (changes[STORAGE_KEYS.lastStop]) {
        const reason = stopReasonOf(changes[STORAGE_KEYS.lastStop].newValue);
        if (reason !== null && !S.lastActive) S.stopReason = reason;
      }
    }
    render();
  }
  function onTabActivated(info) {
    if (S.windowId === null || info?.windowId === S.windowId) void refreshTarget();
  }
  function onTabUpdated(tabId, changeInfo) {
    if (S.targetTab?.id === tabId && isObject(changeInfo) && ('url' in changeInfo || 'title' in changeInfo)) void refreshTarget();
  }

  async function refreshKey() {
    const present = await settle(() => settingsApi.hasKey(local));
    if (disposed) return;
    S.keyPresent = present === true || BUILTIN_KEYS.length > 0;
    render();
  }

  async function watchMicPermission() {
    const status = await settle(() => navigator.permissions?.query({ name: 'microphone' }));
    if (!status || disposed) return;
    permissionStatus = status;
    permissionListener = () => {
      S.micPermission = PERMISSION_STATES.includes(status.state) ? status.state : 'unknown';
      if (S.micPermission === 'granted') {
        S.micWasGranted = true;
        // A refusal that was recorded while the permission was missing is spent: its notice would send the user to an
        // Allow button that is gone, and the pill would keep saying "failed". The next Start writes a fresh result.
        if (S.localErrors.mic === 'MICROPHONE_DENIED') S.localErrors.mic = null;
      }
      render();
    };
    if (typeof status.addEventListener === 'function') status.addEventListener('change', permissionListener);
    else status.onchange = permissionListener;
    permissionListener();
  }

  // ---------------------------------------------------------------------------------------------
  // i18n: a failed load renders the three-key boot dictionary and retries a few times (there is no Retry button in the
  // markup, so the retry is automatic).
  async function loadDictionaries() {
    const language = S.settings.uiLanguage === 'auto' ? undefined : S.settings.uiLanguage;
    return loadI18n({ language, languages: navigator.languages ?? [] });
  }
  function scheduleI18nRetry(round) {
    if (disposed || round >= I18N_RETRY_MS.length) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      try {
        i18n.current = await loadDictionaries();
        S.appliedLanguage = null;
        applyLanguageIfChanged();
        render();
      } catch { scheduleI18nRetry(round + 1); }
    }, I18N_RETRY_MS[round]);
  }

  // ---------------------------------------------------------------------------------------------
  function bind(id, type, handler) {
    const el = els.get(id);
    if (!el) return;
    const wrapped = (event) => { void Promise.resolve().then(() => handler(event)).catch(() => {}); };
    el.addEventListener(type, wrapped);
    removers.push(() => el.removeEventListener(type, wrapped));
  }
  function subscribe(event, listener) {
    if (typeof event?.addListener !== 'function') return;
    event.addListener(listener);
    removers.push(() => attempt(() => event.removeListener(listener)));
  }

  async function loadSettingsAndKey() {
    const stored = await settle(() => local.get(STORAGE_KEYS.settings));
    if (isObject(stored) && stored[STORAGE_KEYS.settings] === undefined) {
      // First run: seed the two target languages from the browser language instead of the bare defaults.
      S.settings = createDefaultSettings(selectLanguage(navigator.languages ?? []));
      await settle(() => settingsApi.writeSettings(local, S.settings));
    } else {
      S.settings = (await settle(() => settingsApi.readSettings(local))) ?? S.settings;
    }
    const present = await settle(() => settingsApi.hasKey(local));
    S.keyPresent = present === true || BUILTIN_KEYS.length > 0;
  }

  async function start() {
    for (const id of PANEL_ELEMENT_IDS) {
      const el = document.getElementById(id);
      if (el) els.set(id, el);
    }
    await loadSettingsAndKey();
    try { i18n.current = await loadDictionaries(); } catch {
      i18n.current = createFallbackI18n({ language: S.settings.uiLanguage === 'auto' ? undefined : S.settings.uiLanguage });
      scheduleI18nRetry(0);
    }
    S.appliedLanguage = null;
    applyLanguageIfChanged();
    render();

    bind('btn-start', 'click', onPrimary);
    for (const lane of LANES) {
      bind(`${lane}-enabled`, 'change', () => onLaneToggled(lane, els.get(`${lane}-enabled`).checked));
      bind(`${lane}-target`, 'change', () => {
        const value = els.get(`${lane}-target`).value;
        // Choosing the current partner as the first language swaps the pair; the repaired pair is saved with the change
        // (the same helper as the options page, so both pages give the same pair).
        return writeField((settings) => { setLaneTargetLanguage(settings, lane, value); });
      });
      bind(`${lane}-two-way`, 'change', () => {
        const checked = els.get(`${lane}-two-way`).checked;
        return writeField((settings) => { settings.lanes[lane].twoWay = checked; });
      });
      bind(`${lane}-partner`, 'change', () => {
        const value = els.get(`${lane}-partner`).value;
        return writeField((settings) => { settings.lanes[lane].partnerLanguage = value; });
      });
      bind(`${lane}-captions`, 'change', () => {
        const checked = els.get(`${lane}-captions`).checked;
        return writeField((settings) => { settings.lanes[lane].captions = checked; });
      });
    }
    bind('tab-volume', 'input', onVolumeInput);
    bind('tab-volume', 'change', onVolumeChange);
    bind('btn-mute', 'click', () => writeField((settings) => { settings.speechMuted = !settings.speechMuted; }));
    const openPermission = () => sendToSw(makeMessage('sw/permission-open', {}));
    bind('btn-mic-permission', 'click', openPermission);
    bind('btn-mic-allow', 'click', openPermission);
    const openOptions = () => adapter.runtime.openOptionsPage();
    bind('btn-options', 'click', openOptions);
    bind('btn-key-options', 'click', openOptions);

    subscribe(adapter.storage.onChanged, onStorageChanged);
    subscribe(adapter.tabs?.onActivated, onTabActivated);
    subscribe(adapter.tabs?.onUpdated, onTabUpdated);

    S.windowId = (await settle(() => adapter.windows.getCurrent()))?.id ?? null;
    if (!Number.isInteger(S.windowId)) S.windowId = null;
    const commands = await settle(() => adapter.commands?.getAll());
    const shortcut = Array.isArray(commands) ? commands.find((command) => command?.name === '_execute_action')?.shortcut : '';
    S.shortcut = typeof shortcut === 'string' && shortcut !== '' ? shortcut : null;
    const hostRecord = await readSession(STORAGE_KEYS.host);
    S.stopReason = stopReasonOf(await readSession(STORAGE_KEYS.lastStop));   // cleared as soon as a lane runs
    await refreshTarget();
    void watchMicPermission();
    onHostRecord(hostRecord);
    render();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(volume.timer);
    clearTimeout(retryTimer);
    link.disconnect();
    for (const remove of removers.splice(0)) remove();
    if (permissionStatus && permissionListener) {
      attempt(() => permissionStatus.removeEventListener?.('change', permissionListener));
      if (permissionStatus.onchange === permissionListener) permissionStatus.onchange = null;
    }
  }

  return Object.freeze({ start, dispose, viewModel: () => latest ?? computeViewModel() });
}
