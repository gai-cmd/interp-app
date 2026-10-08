// New implementation of docs/extension.md §8.2.4-§8.2.7; no legacy code is ported.
// The side panel's DOM binding and actions. All state is derived by the pure view model (view-model.js); this file
// owns the local pieces of the state machine (starts in flight; a tab lane whose start waits for the user's choice in
// Chrome's share dialog (§19, §20: Start on a tab the toolbar icon did not arm opens it at once; the icon is the instant
// start and takes the dialog over through the autostart record the worker writes); local errors; why the last run
// ended; how long a running lane has heard speech without one interpreted row), turns user events into one-field
// settings writes plus commands to the service
// worker, and renders the frozen view model with textContent and attributes only. The panel never holds an engine or
// a key, and it never sends host/lane-start or host/lane-stop: Stop goes through the worker, which alone knows about a
// start that has not reached the host yet (6.11).
// 2026-10-08 (Windows): from Chrome 153 on, Chrome's share dialog is opened by THIS page when it can be (`media`, see
// createPanelController): asked from the offscreen document it is an ownerless window that Windows puts behind the
// browser, asked from the side panel it is owned by the browser window. The panel then holds the chosen tab's audio track
// and relays it to the host (lib/audio-relay.js); everything else about the start still goes through the worker.
import { selectLanguage } from '../../app/i18n/index.js';
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { CAPTURE_NONCE_PATTERN, ORIGINAL_VOLUME, isMachineCode, tabIdOfCaptureLabel } from '../lib/constants.js';
import { DISPLAY_MEDIA_CONSTRAINTS, PICKER_REFUSED_AT_ONCE_MS } from '../lib/display-media.js';
import { applyI18n } from '../lib/dom-i18n.js';
import { createFallbackI18n } from '../lib/i18n.js';
import { LIMITS, PATHS, STORAGE_KEYS, makeMessage } from '../lib/protocol.js';
import {
  createDefaultSettings, hasKey, normalizeSettings, readSettings, setLaneTargetLanguage, updateSettings, writeSettings,
} from '../lib/settings.js';
import { UPDATE_SITE_URL, checkForUpdate } from '../lib/update-check.js';
import { createHostLink } from './host-link.js';
import { LANE_TITLE_KEY, buildUpdateBanner, buildViewModel } from './view-model.js';

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
  'ui-lang-ko', 'ui-lang-ja', 'ui-lang-en', 'update-note', 'update-text', 'btn-update-get', 'btn-update-reload',
  'btn-update-auto', 'update-progress',
  'lane-tabs', 'lane-tab-tab', 'lane-tab-mic', 'lane-tab-tab-state', 'lane-tab-mic-state', 'card-tab', 'card-mic',
  'tab-quiet-note', 'mic-quiet-note',
]);

const LANES = Object.freeze(['tab', 'mic']);
const ACTIVE = Object.freeze(['starting', 'running', 'reconnecting']);
// The partner select is rebuilt (its options are the languages other than the lane's first one), so its options are
// made here and take their binder key from this table (keys are literals, never built from the language code).
const LANGUAGE_KEY = Object.freeze({ ko: 'language.ko', en: 'language.en', ja: 'language.ja' });
// The display-language switch in the header (§16): one button per language, pressed = the language the panel shows.
const UI_LANGUAGE_BUTTONS = Object.freeze(['ko', 'ja', 'en']);
// §17: the lane tabs. The chip on each tab says, in words, what that lane is doing, so a lane whose card is not shown
// can still be seen running or needing attention. A lane that waits for the USER (a choice in
// Chrome's share dialog, §20) needs attention: "Getting ready" there read as "it starts by itself" (review UX-3).
function laneTabState(vm) {
  if (vm.phase === 'running' || vm.phase === 'reconnecting') return { state: 'running', key: 'ext.laneTab.running' };
  if (vm.phase === 'awaiting') return { state: 'attention', key: 'ext.laneTab.attention' };
  if (vm.phase === 'starting' || vm.phase === 'stopping') return { state: 'waiting', key: 'ext.laneTab.waiting' };
  if (vm.enabled && (vm.phase === 'error' || vm.notice !== null)) return { state: 'attention', key: 'ext.laneTab.attention' };
  return vm.enabled ? { state: 'on', key: 'ext.laneTab.on' } : { state: 'off', key: 'ext.laneTab.off' };
}
const CAPTURABLE_SCHEMES = Object.freeze(['http:', 'https:', 'file:']);
const PERMISSION_STATES = Object.freeze(['granted', 'denied', 'prompt']);
const FRESH_STOP_MS = 60_000;          // a lastStop record older than this is history, not news
const OWN_STOP_MS = 5_000;             // a port loss this soon after our own Stop is expected
const PICK_HINT_MS = 8_000;            // §20: the share dialog open this long -> "cannot see the Chrome window? look behind this one"
const FIRST_STATE_WAIT_MS = 1_500;     // §20: an icon click waits this long at most for the host's first state
// §20: a running lane that has heard speech (input level at least QUIET_LEVEL) for QUIET_AFTER_MS in total since its
// start, without one interpreted row, says why that can be. Counted in QUIET_TICK_MS steps of the panel's own clock.
const QUIET_LEVEL = 3;
const QUIET_AFTER_MS = 15_000;
const QUIET_TICK_MS = 1_000;
const freshQuiet = (epoch = null) => ({ epoch, heardMs: 0, output: false });
const VOLUME_THROTTLE_MS = 120;
// §21: after a silent update reported success the extension reloads and this page goes away. If the page is still here
// after this long, the reload did not happen: the banner stops saying "reloading" and offers its buttons again.
const RELOAD_WAIT_MS = 15_000;
const I18N_RETRY_MS = Object.freeze([2_000, 6_000, 18_000]);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const settle = async (task) => { try { return await task(); } catch { return undefined; } };
const isObject = (value) => value !== null && typeof value === 'object';
const stopTracks = (stream) => { for (const track of attempt(() => stream.getTracks()) ?? []) attempt(() => track.stop()); };
const RANDOM_BYTES = 16;   // a capture-label nonce and a relay id are both 32 lowercase hex characters
const schemeOf = (url) => attempt(() => new URL(url).protocol) ?? '';
const boundedTitle = (title) => (typeof title === 'string' && title !== ''
  ? [...title].slice(0, LIMITS.titleMaxChars).join('') : null);

const defaultSettingsApi = Object.freeze({ readSettings, updateSettings, writeSettings, hasKey });

/**
 * createPanelController({ document, adapter, i18n: { current }, loadI18n, settingsApi, createHostLink, timers,
 * navigator, fetch, builtinKeys }) -> Readonly<{ start(), dispose(), viewModel() }>. `i18n` is a mutable holder so the
 * language can be replaced (load finished, load retried) without rebuilding the controller. `fetch` is used only for
 * the update check (§16); without it the panel simply never shows the update banner. `builtinKeys` (the build's pool,
 * BUILTIN_KEYS by default) is read for its length only: the panel learns whether a key exists, never a key. `updater`
 * (§21, extension/lib/update-run.js createSelfUpdater) is the in-extension updater; without one, or when it is not
 * `enabled` (an unkeyed development folder), the banner is exactly the manual one of §16. The panel only ever calls
 * `updater.status()` and `updater.run({ allowPrompt: false })`: it has no user activation and, before Chrome 143, no
 * permission manager, so choosing a folder or asking for the permission is the options page's job.
 * `media` (2026-10-08) = { canOpenDialog(), openShareDialog(constraints), createRelaySender({ track, relayId }),
 * random(Uint8Array) }: the page's share dialog (getDisplayMedia, bound), the gate of lib/display-media.js
 * (canOpenDialogInPanel: Chrome 153 or later with the relay's APIs), lib/audio-relay.js createRelaySender with the page's
 * realm, and crypto.getRandomValues. Without it, or when the gate says no, a dialog start is the worker's `pick` start
 * exactly as before (the offscreen document asks).
 */
export function createPanelController({
  document, adapter, i18n, loadI18n, settingsApi = defaultSettingsApi, createHostLink: makeHostLink = createHostLink,
  timers = {}, navigator = {}, fetch: fetcher = null, builtinKeys = BUILTIN_KEYS, updater = null, media = null,
} = {}) {
  const hasBuiltinKey = Array.isArray(builtinKeys) && builtinKeys.length > 0;
  const updaterEnabled = isObject(updater) && updater.enabled === true;
  const setTimeout = timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimeout = timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const now = timers.now ?? (() => Date.now());
  const local = adapter.storage.local;
  const session = adapter.storage.session;
  const t = (key, params) => i18n.current.t(key, params);

  // ---------------------------------------------------------------------------------------------
  // State. `inFlight` = a sw/lane-start is under way ("pending" to the view model). `picking` = the tab lane's start in
  // flight is one that goes through Chrome's share dialog (Start on a tab the icon did not arm), which stays in flight
  // while the dialog is open (§19, §20).
  const S = {
    settings: createDefaultSettings('en'), keyPresent: hasBuiltinKey,
    host: null, hostUp: false, lastActive: false, previews: { tab: null, mic: null },
    windowId: null, targetTab: null, armed: false, armedRecord: undefined, armedTick: 0, shortcut: null,
    micPermission: 'unknown', micWasGranted: false,
    inFlight: { tab: false, mic: false }, localErrors: { tab: null, mic: null },
    // The two-way choice each running lane was started with (LaneState does not carry it); written by startOne.
    runWith: { tab: null, mic: null },
    stopReason: null, ownStopAt: -Infinity, startRun: 0, capturedTabId: null, capturedTitle: null,
    appliedLanguage: null,
    // §16: the running version (from the manifest) and a newer published one, or null when there is none to offer.
    currentVersion: null, update: null,
    // §21: the self-updater's folder state (null until read), the step of a silent update in progress, the error code of
    // one that failed, and whether this panel open already used its one try.
    updateStatus: null, updateStep: null, updateError: null, silentRan: false,
    // §17: the lane whose card is shown (null until the first render picks one) and the error notice each lane had last
    // time, so a NEW failure on the hidden lane brings its card forward. awaitingMic = a Start waiting for the permission tab.
    selectedLane: null, lastNotice: { tab: null, mic: null }, awaitingMic: false,
    // §20: the share dialog the panel opened (and whether it has been open a while), the icon click already acted
    // on, the tab-lane start in flight (its promise, and the tab it names: null for a dialog start, whose tab only the
    // host can name), the newest icon click (`iconSerial`), and per lane the run whose speech is being counted for the
    // quiet note. `tabWaiting` = the tab lane read as waiting for the dialog at the last render (to bring the tab card
    // forward once, when it ENTERS the wait).
    picking: false, pickSlow: false, booted: false, lastAutostart: null, tabStart: null,
    tabStartTabId: null, iconSerial: 0, tabWaiting: false,
    quiet: { tab: freshQuiet(), mic: freshQuiet() },
    // 2026-10-08: the tab start in flight is past the panel's own dialog (the tab was chosen, its relay start is sent).
    relaying: false,
  };
  let disposed = false;
  let latest = null;
  const els = new Map();
  const removers = [];
  const previewSignature = { tab: '', mic: '' };
  const partnerSignature = { tab: '', mic: '' };
  const volume = { timer: null, value: null, writtenAt: -Infinity };
  let retryTimer = null;
  let reloadTimer = null;
  let pickTimer = null;
  let quietTimer = null;
  let refreshSerial = 0;
  let permissionStatus = null;
  let permissionListener = null;
  // §20: icon clicks are handled one after the other (never two startFromIcon at once), and the callbacks of
  // whoever waits for the host's first state frame.
  let iconQueue = Promise.resolve();
  const stateWaiters = new Set();
  // 2026-10-08, the panel's own share dialog: `dialogWait` = the start that waits for it now (cancelled by Stop, Cancel,
  // the tab lane switched off, the icon and dispose); `shareDialog` = the one getDisplayMedia call this page has pending
  // (it cannot be closed from here: a later start takes it over); `relay` = the chosen tab's audio this page relays to the
  // host ({ sender, stream, track, live, epoch, baseEpoch, ended }).
  let dialogWait = null;
  let shareDialog = null;
  let relay = null;

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
  const pendingOf = () => ({ tab: S.inFlight.tab, mic: S.inFlight.mic || S.awaitingMic });
  const quietOf = (lane) => S.quiet[lane].heardMs >= QUIET_AFTER_MS && !S.quiet[lane].output;
  function computeViewModel() {
    return buildViewModel({
      settings: S.settings, keyPresent: S.keyPresent, host: S.host, armed: S.armed, targetTab: S.targetTab,
      shortcut: S.shortcut, micPermission: S.micPermission, micWasGranted: S.micWasGranted, pending: pendingOf(),
      localErrors: S.localErrors, stopReason: S.stopReason, previews: S.previews, capturedTitle: S.capturedTitle,
      runWith: S.runWith, language: i18n.current.language, has: (key) => i18n.current.has(key),
      picking: S.picking, pickSlow: S.pickSlow, quiet: { tab: quietOf('tab'), mic: quietOf('mic') },
      relaying: S.relaying && S.inFlight.tab,
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
    // The optional detail is a machine identifier (view-model.js), shown after the sentence in parentheses.
    const noticeText = vm.notice ? t(vm.notice.key, vm.notice.params) : '';
    setText(`${lane}-notice`, vm.notice?.detail ? `${noticeText} (${vm.notice.detail})` : noticeText);
    setHidden(`${lane}-level`, !vm.levelVisible);
    setValue(`${lane}-level`, vm.level);
    setText(`${lane}-quiet-note`, vm.quietNote ? t(vm.quietNote.key, { language: t(vm.quietNote.languageKey) }) : '');
    renderPreview(lane, vm.preview);
  }

  // §17: one lane card at a time. The first render shows the first lane that is on (the tab lane when both or neither
  // are); after that the choice is the user's, except that a NEW notice on the hidden lane brings that lane forward.
  function renderLaneTabs(vm) {
    // Only a lane that FAILED pulls its card forward (a new error notice); an advisory note on an idle lane (the
    // microphone permission, say, which arrives after the panel opens) is left to the tab chip ("check this").
    const first = S.selectedLane === null;
    if (first) S.selectedLane = !vm.lanes.tab.enabled && vm.lanes.mic.enabled ? 'mic' : 'tab';
    for (const lane of LANES) {
      const key = vm.lanes[lane].phase === 'error' ? vm.lanes[lane].notice?.key ?? null : null;
      if (!first && key !== null && key !== S.lastNotice[lane] && lane !== S.selectedLane) S.selectedLane = lane;
      S.lastNotice[lane] = key;
    }
    // §20: the dialog's instructions are in the tab card (#tab-arm-note), and Start does not switch cards by itself. When
    // the tab lane ENTERS the wait for the user's choice in Chrome's share dialog while the microphone card is shown, the
    // tab card comes forward, once: a later manual choice of the microphone card stands until the lane enters the wait again.
    const tabWaiting = vm.lanes.tab.phase === 'awaiting' && vm.lanes.tab.enabled;
    if (tabWaiting && !S.tabWaiting) S.selectedLane = 'tab';
    S.tabWaiting = tabWaiting;
    for (const lane of LANES) {
      const selected = lane === S.selectedLane;
      const chip = laneTabState(vm.lanes[lane]);
      setAttr(`lane-tab-${lane}`, 'aria-selected', String(selected));
      setAttr(`lane-tab-${lane}`, 'tabindex', selected ? '0' : '-1');
      setAttr(`lane-tab-${lane}`, 'data-state', chip.state);
      setText(`lane-tab-${lane}-state`, t(chip.key));
      setHidden(`card-${lane}`, !selected);
    }
  }
  function selectLane(lane, { focus = false } = {}) {
    if (!LANES.includes(lane)) return;
    S.selectedLane = lane;
    render();
    if (focus) attempt(() => els.get(`lane-tab-${lane}`)?.focus());
  }
  // The WAI-ARIA tabs keys: arrows move between the two tabs (wrapping), Home and End go to the first and last.
  function onLaneTabsKey(event) {
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
    const index = LANES.indexOf(S.selectedLane ?? 'tab');
    let next = null;
    if (Object.hasOwn(moves, event.key)) next = LANES[(index + moves[event.key] + LANES.length) % LANES.length];
    else if (event.key === 'Home') next = LANES[0];
    else if (event.key === 'End') next = LANES[LANES.length - 1];
    if (next === null) return;
    event.preventDefault?.();
    selectLane(next, { focus: true });
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
    const permissionText = permission.textKeys.map((key) => t(key));
    if (S.awaitingMic) permissionText.push(t('ext.mic.permissionWaiting'));
    setText('mic-permission-status', permissionText.join(' · '));
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

    renderLaneTabs(vm);

    const shown = i18n.current.language;
    for (const code of UI_LANGUAGE_BUTTONS) setAttr(`ui-lang-${code}`, 'aria-pressed', String(shown === code));
    // Not a live region (a plain row may be hidden, 8.2.1): a new version is news, not an alert. What happens DURING a
    // silent update (§21) is announced through #update-progress, which is persistent.
    const banner = buildUpdateBanner({
      update: S.update, currentVersion: S.currentVersion, updater: updaterEnabled ? { enabled: true, folder: S.updateStatus?.folder ?? 'none' } : null,
      lastActive: S.lastActive, laneBusy: updateBlocked(vm), step: S.updateStep, error: S.updateError,
    });
    setHidden('update-note', !banner.visible);
    setText('update-text', banner.parts.map((part) => t(part.key, translateNested(part))).join(' '));
    setText('update-progress', banner.progress === null ? '' : t(banner.progress.key));
    setHidden('btn-update-get', !banner.get);
    // Reloading the extension ends every running lane, so the button waits until nothing runs.
    setHidden('btn-update-reload', !banner.reload);
    setHidden('btn-update-auto', !banner.auto.visible);
    if (banner.auto.visible) setText('btn-update-auto', t(banner.auto.labelKey));
    // aria-disabled, never `disabled` (as Start): the reason is in #update-text, which the button is described by, and a
    // natively disabled button would be out of a keyboard user's reach. openUpdateOptions ignores the click.
    setAttr('btn-update-auto', 'aria-disabled', banner.auto.blocked ? 'true' : null);
  }

  // §21: a reload (the end of an update) cuts whatever runs or starts, so the update button and the silent update wait
  // for ALL of: a lane under way or being stopped, a start in flight, a start waiting for the microphone permission or
  // for Chrome's share dialog (every one of these makes the primary button "Stop" or "Cancel" in the view model), and a
  // host that is up but has not said yet what it runs.
  const hostUnknown = () => S.hostUp && S.host === null;
  const updateBlocked = (vm = computeViewModel()) => vm.primary.mode === 'stop' || hostUnknown();
  const translateNested = (part) => (part.nested === undefined ? part.params
    : { ...part.params, ...Object.fromEntries(Object.entries(part.nested).map(([name, key]) => [name, t(key)])) });

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
    render();
    // An icon click on a tab this panel had not caught up with yet (its record arrived first) is acted on now.
    if (S.booted) void considerAutostart(await readSession(STORAGE_KEYS.autostart));
  }

  function stopReasonOf(record) {
    if (!isObject(record) || record.v !== 1 || !Number.isFinite(record.at)) return null;
    if (now() - record.at > FRESH_STOP_MS) return null;
    return record.reason === 'panel-gone' || record.reason === 'host-lost' ? record.reason : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Starting and stopping (8.2.5). `pick` (§20): the start goes through Chrome's share dialog. Start sets it for every
  // tab lane start on a tab the panel does not read as armed (the same dialog on every OS); the worker's NEEDS_ARM for a
  // tab it found un-armed after all (a stale armed record) is answered by one more start with `pick`. Where the panel
  // may ask for the dialog itself (2026-10-08, panelDialogOn) it does, and the start it sends is a relay start; else the
  // worker's `pick` start asks for it in the offscreen document, as before.
  async function startOne(lane, run, { pick = false } = {}) {
    if (lane === 'mic') {
      if (S.micPermission === 'denied' || S.micPermission === 'prompt') {
        // §17: ask instead of failing. The permission tab opens by itself; a grant starts this lane (watchMicPermission).
        // A blocked microphone cannot be asked again, so it stays an error, and the same tab explains how to unblock it.
        if (S.micPermission === 'denied') S.localErrors.mic = 'MICROPHONE_DENIED';
        else S.awaitingMic = true;
        render();
        await sendToSw(makeMessage('sw/permission-open', {}));
        return;
      }
    } else {
      if (S.targetTab === null) { S.localErrors.tab = 'TAB_GONE'; render(); return; }
      // The arm note already says this page cannot be captured: an alert and a pill turned to "failed" would only
      // repeat it, so the press is a no-op for this lane (the microphone lane of the same Start still runs).
      if (S.targetTab.capturable === false) { render(); return; }   // render: the NEEDS_ARM retry arrives here with its flags already reset
      // §20: a tab the icon did not arm opens Chrome's share dialog at once (the tab is chosen there); an armed tab
      // starts through its stream id. The icon is still the instant start: its click on this tab, while the dialog is
      // open, takes it over (startFromIcon).
      if (!S.armed) pick = true;
    }
    S.inFlight[lane] = true;
    if (lane === 'tab') { S.picking = pick; if (pick) armPickHint(); }
    render();
    // The worker builds the request (language, model and the pair) from the stored settings; the panel only remembers
    // which two-way choice it started with, so a later change can say "applies from the next start".
    const started = { twoWay: S.settings.lanes[lane].twoWay === true, partnerLanguage: S.settings.lanes[lane].partnerLanguage ?? null };
    let res;
    const tabId = lane === 'tab' ? S.targetTab.id : null;
    // 2026-10-08: the dialog is this page's own where Chrome lets it be (panelDialogOn); otherwise the worker's `pick`.
    const viaPanel = lane === 'tab' && pick && panelDialogOn();
    let own = null;
    if (viaPanel) { cancelDialogWait(); own = newDialogWait(); dialogWait = own; }
    const sending = viaPanel ? startThroughPanel(tabId, own) : (async () => {
      try {
        return await sendToSw(makeMessage('sw/lane-start', lane === 'tab'
          ? { lane, tabId, ...(pick ? { pick: true } : {}) } : { lane }));
      } catch { return { ok: false, code: 'INVALID_REQUEST' }; }
    })();
    if (lane === 'tab') { S.tabStart = sending; S.tabStartTabId = pick ? null : tabId; }
    res = await sending;
    if (own !== null && dialogWait === own) dialogWait = null;
    // A start that was cancelled and replaced while it was still in flight must not switch the newer start's flags off.
    const newest = lane !== 'tab' || S.tabStart === sending;
    if (newest) S.inFlight[lane] = false;
    if (lane === 'tab' && newest) {
      S.tabStart = null;
      S.tabStartTabId = null;
      S.picking = false;
      S.relaying = false;
      clearPickHint();
    }
    if (res.ok) {
      S.runWith[lane] = started;
      link.connect();   // (c) a successful start: the host exists now
    } else if (res.code === 'NEEDS_ARM') {
      // §20: the worker found no grant for this tab (a record that outlived Chrome's grant). Not an error: the tab is
      // chosen in Chrome's share dialog, exactly as for a tab that was never armed. A start with `pick` is never
      // answered NEEDS_ARM, so this cannot loop; the retry waits for nothing, so the pill does not fall back to idle.
      // The retry is not awaited here: this start was awaited by startLanes as an armed one, and the microphone lane
      // must not wait behind the dialog it opens.
      if (lane === 'tab' && !pick && newest && !disposed && run === S.startRun && S.settings.lanes.tab.enabled
        && S.targetTab?.id === tabId) {
        void refreshArmed();
        startOne('tab', run, { pick: true }).catch(() => {});
        return;
      }
      await refreshArmed();
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
    let choosing = null;
    for (const lane of LANES) {   // sequential: the tab lane first, then the microphone
      if (!lanes.includes(lane)) continue;
      if (run !== S.startRun) break;   // a Stop pressed meanwhile also prevents the second lane from being sent
      if (!S.settings.lanes[lane].enabled) continue;   // so does unchecking that lane while the first one was starting
      // §19, §20: a tab that is not armed answers only after the user chose in Chrome's share dialog, which can take as
      // long as the user likes. The microphone does not wait for that. An armed tab answers at once, so it is awaited
      // (a microphone start running next to it would make the worker's orphaned-capture recovery refuse to close the host).
      if (lane === 'tab' && !S.armed) { choosing = startOne(lane, run); continue; }
      await startOne(lane, run);
    }
    await choosing;
  }

  async function stopLanes(lane) {
    S.ownStopAt = now();
    if (lane === undefined) {
      S.startRun += 1;
      S.iconSerial += 1;   // §20: an icon click still waiting for the host's first state is dropped too
      S.awaitingMic = false;
      S.inFlight = { tab: false, mic: false };
    } else {
      if (lane === 'mic') S.awaitingMic = false;
      S.inFlight[lane] = false;
    }
    let leaving = null;
    if (lane === undefined || lane === 'tab') {
      S.picking = false;
      S.relaying = false;
      // The tab start in flight is not this panel's any more (a Stop or a switched-off lane cancelled it): its late
      // answer is not "the newest", so a NEEDS_ARM in it opens no dialog the user has cancelled. startFromIcon read the
      // start it waits for (`leaving`) before it came here.
      S.tabStart = null;
      S.tabStartTabId = null;
      clearPickHint();
      // The panel's own dialog wait ends now (the dialog itself cannot be closed: what it delivers later is released at
      // once), and the relay of the lane is this stop's to end.
      cancelDialogWait();
      leaving = relay;
      relay = null;
    }
    render();
    await sendToSw(makeMessage('sw/lane-stop', lane === undefined ? {} : { lane }));
    // After the worker's answer: the host lane is taken down by this stop (which also cancels a relay start still in
    // flight), and the relay's own end (an own stop, never read as "the tab ended") then finds nothing waiting for it.
    endRelay(leaving, 'stop');
  }

  function armPickHint() {
    clearTimeout(pickTimer);
    S.pickSlow = false;
    pickTimer = setTimeout(() => { pickTimer = null; S.pickSlow = true; render(); }, PICK_HINT_MS);
  }
  function clearPickHint() {
    clearTimeout(pickTimer);
    pickTimer = null;
    S.pickSlow = false;
  }

  async function refreshArmed() {
    const seen = S.armedTick;
    const record = await readSession(STORAGE_KEYS.armed);
    if (disposed) return;
    if (seen === S.armedTick) S.armedRecord = record;
    S.armed = armedIn(S.armedRecord, S.targetTab?.id);
  }

  // ---------------------------------------------------------------------------------------------
  // 2026-10-08: Chrome's share dialog opened by THIS page (Chrome 153 and later). Asked from the offscreen document, the
  // dialog has no owner window: Windows centres it on the primary monitor and drops it behind the browser at the first
  // click, so the panel waited for a choice nobody could see (crbug 326508296). Asked from the side panel it is owned by
  // the browser window. The panel then reads which tab was chosen, keeps the audio track and relays it to the host over a
  // BroadcastChannel (lib/audio-relay.js); the worker starts the lane on that relay. The wait for the dialog reads like
  // the worker's (`picking`, Cancel, the hints), and the icon takes it over the same way.
  const panelDialogOn = () => isObject(media) && typeof media.openShareDialog === 'function'
    && typeof media.createRelaySender === 'function' && typeof media.random === 'function'
    && attempt(() => media.canOpenDialog?.()) === true;

  function randomHex() {
    const bytes = new Uint8Array(RANDOM_BYTES);
    media.random(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!CAPTURE_NONCE_PATTERN.test(hex)) throw new Error('RANDOM_UNAVAILABLE');
    return hex;
  }

  function newDialogWait() {
    const wait = { cancelled: false, signal: null, cancelSignal: null };
    wait.cancelSignal = new Promise((resolve) => { wait.signal = resolve; });
    return wait;
  }
  function cancelDialogWait() {
    const wait = dialogWait;
    dialogWait = null;
    if (wait === null) return;
    wait.cancelled = true;
    wait.signal();
  }

  // Resolves when `promise` settles, after `ms` of the panel's clock, or when `cancelSignal` fires; never rejects.
  const waitAtMost = (promise, ms, cancelSignal) => new Promise((resolve) => {
    let timer = null;
    const done = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(done, ms);
    promise.then(done, done);
    cancelSignal.then(done);
  });

  // The one dialog this page has pending. A start that finds one takes it over instead of opening a second one; what a
  // dialog delivers after its owner gave up (Stop, Cancel, the icon, a closed panel) is released the moment it arrives.
  function openShareDialog(owner, nonce) {
    if (shareDialog !== null) {
      shareDialog.owner = owner;
      shareDialog.nonces.push(nonce);
      return shareDialog;
    }
    let asked;
    try { asked = Promise.resolve(media.openShareDialog(DISPLAY_MEDIA_CONSTRAINTS)); } catch (error) { asked = Promise.reject(error); }
    const entry = { owner, nonces: [nonce], startedAt: now(), promise: asked };
    shareDialog = entry;
    asked.then((stream) => { if (entry.owner.cancelled) stopTracks(stream); }, () => {})
      .finally(() => { if (shareDialog === entry) shareDialog = null; });
    return entry;
  }

  // Ends a relay once: the sender posts its end, and the captured audio (and anything left of the stream) is stopped, so
  // the tab plays for the user again and Chrome's sharing indicator goes away. `which` may already be detached.
  function endRelay(which, reason) {
    if (!isObject(which) || which.ended) return;
    which.ended = true;
    if (relay === which) relay = null;
    attempt(() => which.sender.stop(reason));
    stopTracks(which.stream);
    attempt(() => which.track.stop());
  }

  // The host's word on the relayed lane: once the lane was seen under way (its epoch noted), a state where it is not, or
  // a different run, ends the relay; a relay whose start was answered before any such state ends on the first state of
  // ANOTHER run that is not under way (a state from before the start, still in transit, does not end it).
  function followRelay(state) {
    const mine = relay;
    if (mine === null) return;
    const tabState = state.lanes.tab;
    if (ACTIVE.includes(tabState.phase)) {
      if (mine.epoch === null) mine.epoch = tabState.epoch;
      else if (tabState.epoch !== mine.epoch) endRelay(mine, 'lane-over');
      return;
    }
    if (mine.epoch !== null || (mine.live && tabState.epoch !== mine.baseEpoch)) endRelay(mine, 'lane-over');
  }

  // The contract's steps 2-7. Resolves like sendToSw: { ok: true } or { ok: false, code }. `own` is this start's wait:
  // cancelling it ends the label wait and the dialog wait at once.
  async function startThroughPanel(tabId, own) {
    const cancelled = { ok: false, code: 'START_CANCELLED' };
    const failed = { ok: false, code: 'TAB_CAPTURE_FAILED' };
    let nonce;
    try { nonce = randomHex(); } catch { return failed; }
    // 2. The capture label on the panel's tab first (the stream says which tab was chosen only through it). Bounded: a
    //    worker that does not answer delays the dialog by LIMITS.labelWaitMs at most, never stops it.
    let labelling;
    try { labelling = sendToSw(makeMessage('sw/tab-label', { tabId, nonce })); } catch { labelling = Promise.resolve(); }
    await waitAtMost(labelling, LIMITS.labelWaitMs, own.cancelSignal);
    if (own.cancelled || disposed) return cancelled;
    // 3./4. The dialog (or the one still pending, taken over).
    const dialog = openShareDialog(own, nonce);
    const outcome = await Promise.race([
      dialog.promise.then((stream) => ({ stream }), (error) => ({ error })),
      own.cancelSignal.then(() => ({ cancelled: true })),
    ]);
    if (outcome.cancelled || own.cancelled || disposed) { if (outcome.stream) stopTracks(outcome.stream); return cancelled; }
    if (outcome.error) {
      // Closed by the user: nothing failed, the lane simply does not start. A refusal that came at once was not the user
      // (a policy, a browser that refused to show it): it says so instead of looking like a dead Start.
      const dismissed = attempt(() => outcome.error.name) === 'NotAllowedError';
      const refusedAtOnce = dismissed && now() - dialog.startedAt < PICKER_REFUSED_AT_ONCE_MS;
      return dismissed && !refusedAtOnce ? cancelled : failed;
    }
    const stream = outcome.stream;
    // The lane switched off meanwhile (in the options page, say): the choice is not acted on.
    if (!S.settings.lanes.tab.enabled) { stopTracks(stream); return cancelled; }
    // 5. Which tab: the label, read from the video track BEFORE it is stopped (a stopped track has no capture handle).
    //    Any nonce this page gave the same dialog counts. The video is not needed: stopped and removed at once.
    let chosenTab = null;
    for (const track of attempt(() => stream.getVideoTracks()) ?? []) {
      const label = attempt(() => track.getCaptureHandle()?.handle);
      for (const issued of dialog.nonces) chosenTab ??= tabIdOfCaptureLabel(label, issued);
      attempt(() => track.stop());
      attempt(() => stream.removeTrack(track));
    }
    const audio = (attempt(() => stream.getAudioTracks()) ?? [])[0] ?? null;
    // A window, or a tab shared with its audio switched off: there is nothing to interpret.
    if (audio === null) { stopTracks(stream); return { ok: false, code: 'TAB_SHARE_NO_AUDIO' }; }
    // Play the tab back only if Chrome really silenced it; otherwise the user would hear it twice.
    const passthrough = attempt(() => audio.getSettings().suppressLocalAudioPlayback) === true;
    // 6. The relay, under a fresh id.
    let relayId;
    let sender;
    try {
      relayId = randomHex();
      sender = media.createRelaySender({ track: audio, relayId });
      if (!isObject(sender) || typeof sender.stop !== 'function') throw new Error('NO_SENDER');
    } catch {
      stopTracks(stream);
      attempt(() => audio.stop());
      return failed;
    }
    endRelay(relay, 'replaced');
    const mine = { sender, stream, track: audio, live: false, epoch: null, baseEpoch: S.host?.lanes.tab.epoch ?? null, ended: false };
    relay = mine;
    // The choice is made: from here on the lane reads as any other start.
    S.picking = false;
    S.relaying = true;
    S.tabStartTabId = chosenTab;
    clearPickHint();
    render();
    // 7. The worker starts the host lane on the relay (no arming, no stream id, no label).
    let res;
    try {
      res = await sendToSw(makeMessage('sw/lane-start', { lane: 'tab', tabId, relay: relayId, passthrough, chosenTab }));
    } catch { res = { ok: false, code: 'INVALID_REQUEST' }; }
    if (res.ok) mine.live = true;
    else if (relay === mine) endRelay(mine, 'failed');   // a stop that took it over ends it itself, after the worker's answer
    return res;
  }

  // ---------------------------------------------------------------------------------------------
  // §20: the toolbar icon (its shortcut, the context menu) = start on this tab. The worker writes, after the arming, a
  // record naming the tab and its window; the panel of THAT window acts on it once, if it is fresh and names the tab
  // this panel targets. Exactly what Start would do, on that tab:
  //  * the tab lane already under way on that tab (per the host, and per this panel's own start in flight): nothing;
  //  * the tab lane on ANOTHER tab (or one it could not name), this panel's own start in flight for another tab, or
  //    Chrome's share dialog open: that is stopped first (the worker answers the stop only when the host lane is off,
  //    and a start in flight is awaited until it has unwound, so the start that follows is never ALREADY_RUNNING), and
  //    the tab lane starts on this tab through the instant path;
  //  * the tab lane idle: it starts;
  //  * the tab lane switched off: only the lanes that are on start (no surprise enabling).
  // "No host state yet" is not "idle": a panel that the click itself opened, or that the host has not answered yet,
  // first waits (at most FIRST_STATE_WAIT_MS) for the host's first state. Clicks are handled one after the other, and a
  // click that a newer one overtook while it waited is dropped: the newest click wins.
  // A panel in another window, or on another tab, leaves the record alone.
  const autostartOf = (record) => (isObject(record) && record.v === 1 && Number.isInteger(record.tabId)
    && Number.isInteger(record.windowId) && Number.isFinite(record.at) ? record : null);
  async function considerAutostart(value) {
    const record = autostartOf(value);
    if (!S.booted || disposed || record === null) return;
    if (now() - record.at > LIMITS.autostartMaxAgeMs || now() - record.at < -LIMITS.autostartMaxAgeMs) return;
    if (record.windowId !== S.windowId || record.tabId !== S.targetTab?.id) return;
    const marker = `${record.tabId}:${record.at}`;
    if (S.lastAutostart === marker) return;   // consumed once, whichever event brought it first
    S.lastAutostart = marker;
    const serial = ++S.iconSerial;
    const current = () => !disposed && serial === S.iconSerial;
    await settle(() => session.remove(STORAGE_KEYS.autostart));
    await refreshArmed();   // the arming was written before the record: Start now takes the instant path
    if (!current() || !S.keyPresent) return;
    // The queue is held until the starts are SENT, not until they are answered: a newer click then finds this start
    // in flight and takes over at once.
    const turn = iconQueue.then(() => (current() ? startFromIcon(record.tabId, current) : null));
    iconQueue = turn.then(() => {}, () => {});
    await (await turn)?.sent;
  }

  // §20 review (F1): resolves at the host's first state frame, at once when there is one or no host to wait for, and
  // after FIRST_STATE_WAIT_MS at the latest (a host that does not answer is treated as before: no state, idle).
  function firstHostState() {
    if (S.host !== null || !(S.hostUp || link.connected())) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); stateWaiters.delete(done); resolve(); };
      timer = setTimeout(done, FIRST_STATE_WAIT_MS);
      stateWaiters.add(done);
    });
  }
  const releaseStateWaiters = () => { for (const done of [...stateWaiters]) done(); };

  const isUnderWay = (laneState) => laneState !== null && ['starting', 'running', 'reconnecting'].includes(laneState.phase);
  // Returns { sent } (the starts, sent and now being answered) or null when nothing was started.
  async function startFromIcon(tabId, current) {
    await firstHostState();
    if (!current()) return null;
    const tabState = S.host?.lanes.tab ?? null;
    const lanes = [];
    if (S.settings.lanes.tab.enabled) {
      const choosing = S.picking || (tabState?.phase === 'starting' && tabState.engineStatus === null && tabState.tabId === null);
      // This panel's own armed start in flight names its tab; the host's state names the tab of the lane under way.
      // Either one on another tab (or on a tab nobody could name) means a move, not "here".
      const ownStart = S.inFlight.tab && !S.picking;
      const underWay = isUnderWay(tabState);
      const here = !choosing && (ownStart || underWay)
        && (!ownStart || S.tabStartTabId === tabId) && (!underWay || tabState.tabId === tabId);
      if (!here) {
        if (choosing || ownStart || underWay || tabState?.phase === 'stopping') {
          const leaving = S.tabStart;
          await stopLanes('tab');
          await leaving;   // a start in flight (the dialog's or an armed one) unwinds before the next one is sent
          if (!current()) return null;
        }
        lanes.push('tab');
      }
    }
    // The microphone starts only if nothing of it is under way: per the host, a start in flight or waiting for the
    // permission, or a start that succeeded before the host's first state arrived (runWith is cleared when it ends).
    const micState = S.host?.lanes.mic ?? null;
    const micBusy = isUnderWay(micState) || micState?.phase === 'stopping' || S.inFlight.mic || S.awaitingMic || S.runWith.mic !== null;
    if (S.settings.lanes.mic.enabled && !micBusy) lanes.push('mic');
    return lanes.length > 0 ? { sent: startLanes(lanes) } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // §20: "nothing was interpreted yet". Per lane run (its epoch): the time with speech heard, and whether one
  // interpreted row arrived. The tick runs only while a lane runs.
  function trackQuiet(state) {
    for (const lane of LANES) {
      const laneState = state.lanes[lane];
      if (isUnderWay(laneState) && S.quiet[lane].epoch !== laneState.epoch) S.quiet[lane] = freshQuiet(laneState.epoch);
    }
    if (quietTimer === null && LANES.some((lane) => state.lanes[lane].phase === 'running')) {
      quietTimer = setTimeout(quietTick, QUIET_TICK_MS);
    }
  }
  function quietTick() {
    quietTimer = null;
    if (disposed || S.host === null) return;
    let changed = false;
    for (const lane of LANES) {
      const laneState = S.host.lanes[lane];
      const counter = S.quiet[lane];
      if (laneState.phase !== 'running' || laneState.epoch !== counter.epoch || counter.output) continue;
      if (laneState.level < QUIET_LEVEL) continue;
      const before = quietOf(lane);
      counter.heardMs += QUIET_TICK_MS;
      changed ||= quietOf(lane) !== before;
    }
    if (changed) render();
    if (LANES.some((lane) => S.host.lanes[lane].phase === 'running')) quietTimer = setTimeout(quietTick, QUIET_TICK_MS);
  }

  const onPrimary = async () => {
    const { primary } = computeViewModel();
    if (primary.disabled) return;   // aria-disabled keeps the button focusable; it does not stop the click
    if (primary.mode === 'stop') { await stopLanes(undefined); return; }
    await startLanes(LANES.filter((lane) => S.settings.lanes[lane].enabled), { all: true });
  };

  async function onLaneToggled(lane, enabled) {
    if (!enabled) S.localErrors[lane] = null;   // §17: a lane switched off takes its old error with it
    await writeField((settings) => { settings.lanes[lane].enabled = enabled; });
    // §17: switching the microphone on asks for it right away, so the first Start does not stop at a permission step.
    if (lane === 'mic' && enabled && S.micPermission === 'prompt' && computeViewModel().primary.mode !== 'stop') {
      await sendToSw(makeMessage('sw/permission-open', {}));
      return;
    }
    if (computeViewModel().primary.mode !== 'stop') return;
    if (enabled) await startLanes([lane]);
    else await stopLanes(lane);
  }

  // ---------------------------------------------------------------------------------------------
  // Volume: at most one write per 120 ms while dragging, and the final value on `change`.
  const readVolume = () => {
    const number = Math.round(Number(els.get('tab-volume')?.value));
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : ORIGINAL_VOLUME.initial;
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
    followRelay(state);
    trackQuiet(state);
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
    releaseStateWaiters();   // an icon click that waited for the host's word has it now
  }
  function onCaptions(frame) {
    S.previews[frame.lane] = frame;
    // §20: the first interpreted row of the run ends its quiet count for good.
    const counter = S.quiet[frame.lane];
    if (frame.epoch === counter.epoch && frame.rows.some((row) => row.role === 'translation')) counter.output = true;
    render();
  }
  async function onConnection(connected, info) {
    if (connected) return;
    const wasActive = S.lastActive;
    S.host = null;
    S.lastActive = false;
    S.previews = { tab: null, mic: null };
    S.runWith = { tab: null, mic: null };
    S.quiet = { tab: freshQuiet(), mic: freshQuiet() };   // a new host numbers its runs from 1 again
    S.capturedTabId = null;
    S.capturedTitle = null;
    render();
    releaseStateWaiters();   // no host to wait for any more
    // 2026-10-08: a relay this page feeds into a host lane that was started counts as a lane under way (its first state
    // may not have arrived yet); a host that said goodbye has no lane left to feed.
    const relayed = relay !== null && relay.live;
    if (info?.bye && relayed) endRelay(relay, 'host-gone');
    // UNEXPECTED loss: the last state had a lane under way, the host did not say goodbye and we did not press Stop.
    if (info?.bye || !(wasActive || relayed) || now() - S.ownStopAt <= OWN_STOP_MS) return;
    if (S.stopReason !== 'panel-gone') S.stopReason = 'host-lost';
    render();
    const res = await sendToSw(makeMessage('sw/host-probe', {}));
    if (disposed) return;
    if (res.ok && res.up === true) {   // the document is alive after all: reconnect instead of claiming a loss
      if (S.stopReason === 'host-lost') S.stopReason = null;
      link.connect();
    } else {
      S.hostUp = false;
      if (relay?.live) endRelay(relay, 'host-gone');
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
      if (relay?.live) endRelay(relay, 'host-gone');   // nothing receives the relay any more
      link.disconnect();
      S.host = null;
      S.lastActive = false;
      S.previews = { tab: null, mic: null };
      S.quiet = { tab: freshQuiet(), mic: freshQuiet() };
      releaseStateWaiters();
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
      // §21: the options page chose or forgot the folder, or switched automatic updates: the banner's label follows.
      if (typeof STORAGE_KEYS.update === 'string' && changes[STORAGE_KEYS.update] && S.update !== null && S.updateStep === null) {
        void refreshUpdaterStatus().then(() => { if (!disposed) render(); });
      }
    } else if (areaName === 'session') {
      if (changes[STORAGE_KEYS.armed]) {
        S.armedTick += 1;
        S.armedRecord = changes[STORAGE_KEYS.armed].newValue;
        S.armed = armedIn(S.armedRecord, S.targetTab?.id);
      }
      if (changes[STORAGE_KEYS.host]) onHostRecord(changes[STORAGE_KEYS.host].newValue);
      if (changes[STORAGE_KEYS.autostart]) void considerAutostart(changes[STORAGE_KEYS.autostart].newValue);
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
    S.keyPresent = present === true || hasBuiltinKey;
    render();
  }

  async function watchMicPermission() {
    const status = await settle(() => navigator.permissions?.query({ name: 'microphone' }));
    if (!status || disposed) return;
    permissionStatus = status;
    permissionListener = () => {
      S.micPermission = PERMISSION_STATES.includes(status.state) ? status.state : 'unknown';
      if (S.micPermission === 'granted' && S.awaitingMic) {
        // §17: the Start that opened the permission tab goes on by itself, unless the lane was switched off meanwhile.
        S.awaitingMic = false;
        if (S.settings.lanes.mic.enabled) void startOne('mic', S.startRun);
      } else if (S.micPermission === 'denied' && S.awaitingMic) {
        S.awaitingMic = false;
        S.localErrors.mic = 'MICROPHONE_DENIED';
      }
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
  // The update check (§16): once per panel open, silent on any failure.
  async function refreshUpdate() {
    const version = attempt(() => adapter.runtime.getManifest?.().version);
    S.currentVersion = typeof version === 'string' ? version : null;
    if (S.currentVersion === null || typeof fetcher !== 'function') return;
    const result = await checkForUpdate({ fetch: fetcher, currentVersion: S.currentVersion });
    if (disposed) return;
    S.update = result.available ? Object.freeze({ version: result.version }) : null;
    // §21: the banner's button says "Update now" or "Turn on", which depends on the folder, so the folder is read BEFORE
    // the banner first shows (no flash of the wrong label).
    if (S.update !== null && updaterEnabled) await refreshUpdaterStatus();
    if (disposed) return;
    render();
    if (S.update !== null) await considerSilentUpdate();
  }

  async function refreshUpdaterStatus() {
    if (!updaterEnabled) return;
    const status = await settle(() => updater.status());
    if (disposed) return;
    if (isObject(status)) S.updateStatus = status;
  }

  // §21, the SILENT PATH. Once per panel open, when ALL of these hold: a newer version is published, the updater is on,
  // the stored folder is writable right now (its permission is 'granted': no prompt is needed), the person did not turn
  // automatic updates off, nothing runs or starts (the update ends with a reload), and the panel was not opened by an
  // icon click that is about to start interpreting. It runs the updater WITHOUT permission to prompt: the panel has no
  // user activation, and before Chrome 143 no permission manager. Any failure leaves the banner with its buttons and the
  // reason; success is the reload, which takes this page with it.
  async function considerSilentUpdate() {
    if (S.silentRan || disposed || !updaterEnabled || S.update === null) return;
    const status = S.updateStatus;
    if (!isObject(status) || status.folder !== 'granted' || status.autoApply !== true) return;
    if (updateBlocked() || S.lastAutostart !== null) return;
    // An icon click on this window whose start request is not consumed yet (it may arrive a moment after the panel opened).
    const pendingClick = autostartOf(await readSession(STORAGE_KEYS.autostart));
    if (disposed || S.silentRan) return;
    if (pendingClick !== null && pendingClick.windowId === S.windowId && Math.abs(now() - pendingClick.at) <= LIMITS.autostartMaxAgeMs) return;
    if (updateBlocked() || S.lastAutostart !== null) return;   // the awaits above may have let a start begin
    S.silentRan = true;
    S.updateError = null;
    S.updateStep = 'checking';
    render();
    let result;
    try { result = await updater.run({ onStep: onUpdateStep, allowPrompt: false }); } catch { result = null; }
    if (disposed) return;
    if (isObject(result) && result.ok === true) {
      // The updater called reload(): this page is about to go. If it does not (the reload did not happen), the buttons come back.
      S.updateStep = 'reloading';
      reloadTimer = setTimeout(() => { reloadTimer = null; S.updateStep = null; render(); }, RELOAD_WAIT_MS);
    } else {
      S.updateStep = null;
      S.updateError = isObject(result) && typeof result.code === 'string' ? result.code : 'UNKNOWN';
      await refreshUpdaterStatus();   // the folder may not be writable any more: the label follows
    }
    if (!disposed) render();
  }
  function onUpdateStep(name) {
    if (disposed || S.updateStep === null) return;
    S.updateStep = typeof name === 'string' ? name : S.updateStep;
    render();
  }

  // The banner's button. It opens the options page at #update in a tab (an extension page, so the folder picker and the
  // permission prompt are available there): the page runs the check and does what the folder state allows.
  function openUpdateOptions() {
    if (!updaterEnabled || updateBlocked() || S.updateStep !== null) return undefined;   // aria-disabled keeps it focusable; it does not stop the click
    return adapter.tabs.create({ url: `${adapter.runtime.getURL(PATHS.options)}#update` });
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
    S.keyPresent = present === true || hasBuiltinKey;
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
    for (const code of UI_LANGUAGE_BUTTONS) {
      bind(`ui-lang-${code}`, 'click', () => writeField((settings) => { settings.uiLanguage = code; }));
    }
    for (const lane of LANES) bind(`lane-tab-${lane}`, 'click', () => selectLane(lane));
    bind('lane-tabs', 'keydown', onLaneTabsKey);
    bind('btn-update-get', 'click', () => adapter.tabs.create({ url: UPDATE_SITE_URL }));
    bind('btn-update-reload', 'click', () => { if (!S.lastActive) adapter.runtime.reload(); });
    bind('btn-update-auto', 'click', openUpdateOptions);

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
    void refreshUpdate();
    // §20: the icon click that opened this panel wrote its start request already, or writes it in a moment (a change
    // event then brings it): either way it is acted on once the panel knows its window and tab. Not awaited: the start
    // may first wait for the host's first state, and the panel is up either way.
    S.booted = true;
    void considerAutostart(await readSession(STORAGE_KEYS.autostart));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(volume.timer);
    clearTimeout(retryTimer);
    clearTimeout(reloadTimer);
    clearTimeout(pickTimer);
    clearTimeout(quietTimer);
    releaseStateWaiters();
    // 2026-10-08: the page goes away (pagehide): its dialog wait ends (a stream the dialog still delivers is released at
    // once) and so does the relay it feeds; the host's lane then ends like a tab that ended.
    cancelDialogWait();
    endRelay(relay, 'pagehide');
    link.disconnect();
    for (const remove of removers.splice(0)) remove();
    if (permissionStatus && permissionListener) {
      attempt(() => permissionStatus.removeEventListener?.('change', permissionListener));
      if (permissionStatus.onchange === permissionListener) permissionStatus.onchange = null;
    }
  }

  return Object.freeze({ start, dispose, viewModel: () => latest ?? computeViewModel() });
}
