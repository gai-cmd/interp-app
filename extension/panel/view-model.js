// New implementation of docs/extension.md §8.2.3 and §5.11; no legacy code is ported.
// The pure state -> view-model function of the side panel. It reads no global and touches no DOM: the controller
// passes everything in and renders the frozen result, so each derivation rule of 8.2.3 is a table-driven test.
// The i18n keys named here are literals on purpose (the checker only sees literals); dynamic key families are
// resolved through the small tables below.
import {
  EXTENSION_ERROR_CODES, OVERRIDDEN_ENGINE_CODES, QUOTA_CODES, TAB_CAPTURE_CODES, errorKeyFor,
} from '../lib/ui-state.js';
import { LIMITS } from '../lib/protocol.js';
import { TARGET_LANGUAGES, deepFreeze } from '../lib/constants.js';

const LANES = ['tab', 'mic'];
const ACTIVE = ['starting', 'running', 'reconnecting'];
const BUSY = [...ACTIVE, 'stopping'];
// NEEDS_ARM (§20) is the worker's "this tab was not armed after all": the controller answers it with a start through
// Chrome's share dialog, never a notice.
const SILENT_CODES = ['ALREADY_RUNNING', 'START_CANCELLED', 'NEEDS_ARM'];
const NOT_AN_ALARM = ['TAB_ENDED', 'TAB_GONE'];
// Tab-lane notices that already say what to do next (press Start again, share the tab's audio, or "this page cannot
// be captured"). The arm note would repeat them or, with an armed record that survived, contradict them: only the
// notice is shown.
const SELF_EXPLAINING_TAB_CODES = [...TAB_CAPTURE_CODES, 'TAB_INPUT_LOST', 'TAB_ENDED', 'TAB_GONE', 'TAB_UNSUPPORTED',
  'TAB_SHARE_NO_AUDIO'];
const KEY_FAILURES = ['CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'INVALID_KEY', 'PERMISSION_DENIED',
  'CREDENTIAL_FORBIDDEN', 'IP_DENIED'];
const CONCURRENT_SESSION_CODES = ['SESSION_LIMIT', 'BUDGET_EXHAUSTED'];
const LANE_TITLE_KEY = Object.freeze({ tab: 'ext.lane.tab.title', mic: 'ext.lane.mic.title' });
const OUTPUT_KEY = Object.freeze({ blocked: 'ext.output.blocked', delayed: 'sim.output.delayed',
  'catching-up': 'sim.output.catching_up', unavailable: 'sim.output.unavailable' });
const GAP_KEY = Object.freeze({ input: 'ext.gap.input', audio: 'sim.gap.audio', reception: 'sim.gap.reception' });
const PERMISSION_TEXT = Object.freeze({
  granted: Object.freeze(['permission.title', 'permission.granted']),
  denied: Object.freeze(['permission.title', 'permission.denied']),
  prompt: Object.freeze(['permission.title', 'permission.prompt']),
});
const STOP_NOTE_KEY = Object.freeze({ 'panel-gone': 'ext.notice.panelGone', 'host-lost': 'ext.notice.hostLost' });
// §20: the tab lane waits for the user's choice in Chrome's share dialog; the pill and the lane say so.
const CHOOSING_STATUS_KEY = 'ext.status.choosingTab';
const LANGUAGE_NAME_KEY = Object.freeze({ ko: 'language.ko', en: 'language.en', ja: 'language.ja' });
const CHECKING = Object.freeze(['permission.checking']);
const MAX_PREVIEW_ROWS = 4;

// The keys errorKeyFor may resolve when the caller does not pass the dictionary's own `has` (tests, previews).
const GENERIC_ERROR_CODES = ['CREDENTIAL_MISMATCH', 'NETWORK_ERROR', 'UNAVAILABLE', 'TIMEOUT', 'SETTINGS_UNSUPPORTED',
  'SAFETY_BLOCKED', 'INVALID_RESULT'];
const KNOWN_KEYS = new Set([
  ...[...EXTENSION_ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES].map((code) => `ext.error.${code}`),
  ...GENERIC_ERROR_CODES.map((code) => `error.${code}`),
]);

const isActive = (phase) => ACTIVE.includes(phase);
// 2026-09-30: a spare key taking over, or the planned ~10-minute connection handover, reconnects while interpreting goes
// on. It reads as a plain "reconnecting", like the web app: no count (it spends none of the 3) and never "connection
// lost". hostLane.reconnectReason is null for every other reconnect.
const calm = (draft) => draft.phase === 'reconnecting' && typeof draft.hostLane?.reconnectReason === 'string';
// A translation-only model cannot interpret in two directions, so the engine runs a two-way lane on the first
// instruction-driven model instead (app/engine/sim.js). The host reports the model it really runs, so what a start would
// use now is this one; comparing the raw setting would show "applies next" for the whole run. The panel may import only
// extension/lib and app/i18n (the build refuses anything else), so it cannot ask app/providers/gemini/live-config.js for
// these two ids: they are pinned here and tests/extension-panel.test.mjs compares them with live-config.js.
export const TRANSLATION_ONLY_MODEL = 'gemini-3.5-live-translate-preview';
export const PAIR_MODEL = 'gemini-3.8-live';
const swappedForPair = (laneSettings) => laneSettings.twoWay === true && laneSettings.model === TRANSLATION_ONLY_MODEL;
const effectiveModelOf = (laneSettings) => (swappedForPair(laneSettings) ? PAIR_MODEL : laneSettings.model);
// What the running lane was started with is not part of LaneState (the host reports only the first language), so the
// controller remembers the two-way choice of the start it sent; without a record nothing is claimed (rule 13).
const pairChanged = (started, laneSettings) => started !== null && typeof started === 'object'
  && (started.twoWay !== (laneSettings.twoWay === true)
    || (laneSettings.twoWay === true && started.partnerLanguage !== laneSettings.partnerLanguage));
const bounded = (title) => (typeof title === 'string' && title !== '' ? [...title].slice(0, LIMITS.titleMaxChars).join('') : null);

function laneDraft(lane, input) {
  const { settings, host, pending, localErrors } = input;
  const hostLane = host?.lanes?.[lane] ?? null;
  const hostPhase = hostLane?.phase ?? 'off';
  // A page that is known to be unsupported is named by the arm note; a local TAB_UNSUPPORTED recorded earlier (from
  // another page) would repeat the same sentence in the alert.
  const superseded = lane === 'tab' && input.targetTab?.capturable === false && localErrors?.tab === 'TAB_UNSUPPORTED';
  const localCode = superseded ? null : (localErrors?.[lane] ?? null);
  let phase = hostPhase;
  let errorCode = hostPhase === 'error' ? hostLane.errorCode : null;
  // `awaiting` = the tab lane waits for the user: Chrome's share dialog is open (`picking`: Start was pressed on a tab
  //  the toolbar icon did not arm) (§19, §20). The host is already `starting` then (it holds the dialog open) but has no
  //  engine yet; once the engine exists the choice was made and the lane reads as any other start. The HOST says so once
  //  it reports: starting, no engine and no tab yet (a stream-id start names its tab from the first state; a picker
  //  start cannot), so every panel reads the same, whatever tab is active now.
  //  2026-10-08: `relaying` = this panel opened the dialog itself, the tab is chosen and the start it sent is the relay
  //  start; a host starting that one without an engine yet (and without a tab, when the choice could not be named) is
  //  not holding a dialog.
  const hostChoosing = input.relaying !== true
    && hostPhase === 'starting' && (hostLane?.engineStatus ?? null) === null && (hostLane?.tabId ?? null) === null;
  const choosing = lane === 'tab'
    && (hostChoosing || (pending?.tab === true && input.picking === true && !BUSY.includes(hostPhase)));
  if (choosing) {
    phase = 'awaiting';
    errorCode = null;
  } else if (pending?.[lane] && !BUSY.includes(hostPhase)) {
    phase = 'starting';
    errorCode = null;
  } else if (localCode && !BUSY.includes(hostPhase) && !SILENT_CODES.includes(localCode)) {
    phase = 'error';   // a failed sw/lane-start: the lane shows its notice, the host knows nothing about it
    errorCode = localCode;
  }
  return { lane, settings: settings.lanes[lane], hostLane, phase, errorCode, localCode };
}

function statusOf(draft) {
  const { phase, errorCode, hostLane } = draft;
  switch (phase) {
    case 'awaiting': return { key: CHOOSING_STATUS_KEY, params: {} };
    case 'starting': return { key: hostLane?.engineStatus === 'connecting' ? 'sim.status.connecting' : 'sim.status.preparing', params: {} };
    case 'running': return { key: 'sim.status.running', params: {} };
    case 'reconnecting': return calm(draft) ? { key: 'sim.status.reconnecting', params: {} }
      : { key: 'ext.status.reconnecting', params: { count: Math.max(1, hostLane?.retries ?? 1) } };
    case 'stopping': return { key: 'sim.status.stopping', params: {} };
    case 'error': return NOT_AN_ALARM.includes(errorCode)
      ? { key: 'sim.status.stopped', params: {} } : { key: 'ext.status.failed', params: {} };
    // A lane the user switched off is not "ready to start": Start will not start it.
    default: return draft.settings.enabled ? { key: 'sim.status.idle', params: {} } : { key: 'ext.status.off', params: {} };
  }
}

function pillOf(drafts) {
  // §17: a lane the user switched off is out of the picture; its old error must not turn the pill into "partial".
  const errors = drafts.filter((draft) => draft.phase === 'error' && draft.settings.enabled);
  const running = drafts.filter((draft) => ['starting', 'awaiting', 'running', 'reconnecting'].includes(draft.phase));
  if (errors.length > 0 && running.length === 0) {
    return errors.every((draft) => NOT_AN_ALARM.includes(draft.errorCode))
      ? { state: 'warning', key: 'sim.status.stopped', params: {} }
      : { state: 'error', key: 'ext.status.failed', params: {} };
  }
  // One interpretation fails while the other runs: the pill must not contradict the running lane.
  if (errors.length > 0) return { state: 'warning', key: 'ext.status.partial', params: {} };
  const reconnecting = drafts.filter((draft) => draft.phase === 'reconnecting' && !calm(draft));
  if (reconnecting.length > 0) {
    const count = Math.max(1, ...reconnecting.map((draft) => draft.hostLane?.retries ?? 1));
    return { state: 'warning', key: 'ext.status.reconnecting', params: { count } };
  }
  if (drafts.some((draft) => draft.phase === 'stopping')) return { state: 'warning', key: 'sim.status.stopping', params: {} };
  const starting = drafts.filter((draft) => draft.phase === 'starting');
  const waiting = drafts.find((draft) => draft.phase === 'awaiting');
  if (waiting && starting.length === 0) {
    return { state: 'warning', key: CHOOSING_STATUS_KEY, params: {} };
  }
  if (starting.length > 0) {
    const early = starting.some((draft) => !draft.hostLane?.engineStatus || draft.hostLane.engineStatus === 'preparing');
    return { state: 'starting', key: early ? 'sim.status.preparing' : 'sim.status.connecting', params: {} };
  }
  // A calm reconnect keeps the running pill: interpreting goes on.
  if (drafts.some(calm)) return { state: 'running', key: 'sim.status.reconnecting', params: {} };
  if (drafts.some((draft) => draft.phase === 'running')) return { state: 'running', key: 'sim.status.running', params: {} };
  return { state: 'idle', key: 'sim.status.idle', params: {} };
}

function noticeOf(draft, input, has) {
  const { micPermission, micWasGranted, settings, localErrors } = input;
  const { lane } = draft;
  // laneDraft already resolved the priority of 8.2.3 rule 8 (a failed sw/lane-start beats the host's own error code).
  let code = draft.phase === 'error' && !SILENT_CODES.includes(draft.errorCode) ? draft.errorCode : null;
  // The permission itself: denied with the lane on, or prompt after a refused start.
  if (code === null && lane === 'mic' && !isActive(draft.phase) && draft.phase !== 'stopping') {
    if ((micPermission === 'denied' && settings.lanes.mic.enabled)
      || (micPermission === 'prompt' && localErrors?.mic === 'MICROPHONE_DENIED')) code = 'MICROPHONE_DENIED';
  }
  let key = null;
  if (code !== null) {
    key = code === 'MICROPHONE_DENIED' && lane === 'mic' && micPermission === 'prompt' && micWasGranted
      ? 'ext.error.MICROPHONE_EXPIRED' : errorKeyFor(code, has, lane);
    let attention = null;
    if (KEY_FAILURES.includes(code)) attention = 'options';
    else if (lane === 'mic' && code === 'MICROPHONE_DENIED') attention = 'permission';
    // 2026-09-30: "the result could not be checked" says nothing about which check refused it, so the engine's fixed
    // reason follows the sentence as the identifier it is (e.g. `INVALID_RESULT · audio-encoding`): nothing to
    // translate, and enough to diagnose the failure from a screenshot. Only for the host's own error, never a local one.
    const reason = code === 'INVALID_RESULT' && draft.localCode === null ? draft.hostLane?.errorReason ?? null : null;
    return { key, params: {}, attention, code, ...(reason === null ? {} : { detail: `${code} · ${reason}` }) };
  }
  if (draft.phase === 'running' && draft.settings.captions && draft.hostLane?.overlay === 'unavailable') {
    return { key: 'ext.error.OVERLAY_UNAVAILABLE', params: {}, attention: null, code: null };
  }
  return null;
}

function armNoteOf(draft, input) {
  const { armed, targetTab, shortcut } = input;
  if (isActive(draft.phase)) return null;
  if (!draft.settings.enabled) return null;   // a lane the user turned off has nothing to arm
  const keyboard = typeof shortcut === 'string' && shortcut !== '' ? shortcut : null;
  // §20. In Chrome's share dialog (Start on a tab the icon did not arm) the note says what to do there and, at once,
  // that the toolbar icon on the tab starts it without the dialog (with the shortcut when one is set); once the dialog
  // has been open ~8 s the controller sets `pickSlow` and the note adds where to look when the window is not in sight,
  // and where the icon is (the puzzle menu: it names the icon "at the top right", which is not always visible). The open
  // dialog comes BEFORE the page check: the dialog is a fact of the host, and the panel's active tab may become a
  // chrome:// page while it is open; the pill and Cancel still say "waiting", so the note must too.
  if (draft.phase === 'awaiting') {
    return { key: 'ext.arm.picking', attention: true,
      hintKeys: input.pickSlow === true ? ['ext.arm.pickSlow', 'ext.arm.pickLost', 'ext.arm.pinHint'] : ['ext.arm.pickSlow'],
      shortcut: keyboard };
  }
  if (targetTab && targetTab.capturable === false) return { key: 'ext.error.TAB_UNSUPPORTED', attention: false, hintKeys: [], shortcut: null };
  // The capture stopped arriving (5.11) or the tab went away: the grant is probably spent, and the notice below
  // already asks for a fresh click. Showing "click the icon" twice, or "ready" next to it, only adds noise.
  if (draft.phase === 'error' && SELF_EXPLAINING_TAB_CODES.includes(draft.errorCode)) return null;
  if (armed) return { key: 'ext.arm.ready', attention: false, hintKeys: [], shortcut: null };
  return { key: 'ext.arm.needed', attention: false, hintKeys: ['ext.arm.pinHint'], shortcut: keyboard };
}

// §20: a lane that runs and hears speech (the controller counts ~15 s of input above a small level since the start)
// but has not produced one interpreted row gets a calm note: if the speech is already in the target language there is
// nothing to interpret. A two-way lane interprets either language, so the note would be wrong there.
function quietNoteOf(draft, input) {
  if (input.quiet?.[draft.lane] !== true || !['running', 'reconnecting'].includes(draft.phase)) return null;
  if (draft.settings.twoWay === true || input.runWith?.[draft.lane]?.twoWay === true) return null;
  const language = draft.hostLane?.targetLanguage ?? draft.settings.targetLanguage;
  return LANGUAGE_NAME_KEY[language] ? { key: 'ext.quiet.check', languageKey: LANGUAGE_NAME_KEY[language] } : null;
}

function previewOf(draft, frame) {
  if (!frame || !Array.isArray(frame.rows) || (draft.phase === 'off' && draft.errorCode === null)) return [];
  return frame.rows.slice(-MAX_PREVIEW_ROWS)
    .map((row) => ({ id: row.id, role: row.role, status: row.status, text: row.text, skipped: row.skipped === true }));
}

/** See the header of 8.2.3 for the input and output shapes. `has` is the i18n dictionary's key test. */
export function buildViewModel(input) {
  const {
    settings, keyPresent = false, host = null, micPermission = 'unknown',
    pending = { tab: false, mic: false }, stopReason = null, previews = { tab: null, mic: null },
    capturedTitle = null, language = 'en', runWith = { tab: null, mic: null },
  } = input;
  const has = typeof input.has === 'function' ? input.has : (key) => KNOWN_KEYS.has(key);
  const drafts = LANES.map((lane) => laneDraft(lane, input));
  const [tab, mic] = drafts;

  // Rule 2: the primary button.
  const mode = drafts.some((draft) => [...BUSY, 'awaiting'].includes(draft.phase)) ? 'stop' : 'start';
  // A lane the user switched off that only carries an old host error is out of the picture (like pillOf); one that is
  // still busy (the host has not finished stopping it) counts.
  const nonIdle = drafts.filter((draft) => draft.phase !== 'off' && (draft.settings.enabled || draft.phase !== 'error'));
  const cancelOnly = nonIdle.length > 0 && nonIdle.every((draft) => draft.phase === 'awaiting');
  const noLane = mode === 'start' && !settings.lanes.tab.enabled && !settings.lanes.mic.enabled;
  const primary = { mode, key: mode === 'start' ? 'common.start' : cancelOnly ? 'common.cancel' : 'common.stop',
    disabled: mode === 'start' && (!keyPresent || noLane) };

  // Rule 8 with the once-per-problem rule for a shared key failure.
  const notices = Object.fromEntries(drafts.map((draft) => [draft.lane, noticeOf(draft, input, has)]));
  if (notices.tab?.attention === 'options' && notices.mic?.attention === 'options' && notices.tab.key === notices.mic.key) {
    notices.mic = null;
  }

  const laneVms = Object.fromEntries(drafts.map((draft) => {
    const { lane, hostLane, settings: laneSettings } = draft;
    const running = draft.phase === 'running';
    const live = running || draft.phase === 'reconnecting';
    const notice = notices[lane];
    const vm = {
      enabled: laneSettings.enabled,
      targetLanguage: laneSettings.targetLanguage,
      captions: laneSettings.captions,
      phase: draft.phase,
      status: statusOf(draft),
      route: running ? {
        textKey: hostLane?.fallback ? 'ext.route.fallback' : hostLane?.route === 'translation' ? 'sim.route.translation' : 'sim.route.flash',
        model: hostLane?.model ?? null,
      } : null,
      // The warning of a backup model goes into its own live region: the route line is not live and keeps the model id.
      routeNote: running && hostLane?.fallback ? 'ext.route.fallbackNote' : null,
      output: running && hostLane?.output ? (OUTPUT_KEY[hostLane.output] ?? null) : null,
      gap: live && hostLane?.gap ? (GAP_KEY[hostLane.gap] ?? null) : null,
      notice: notice ? { key: notice.key, params: notice.params, attention: notice.attention,
        ...(notice.detail === undefined ? {} : { detail: notice.detail }) } : null,
      // Two-way: the second language, and the choices the panel offers for it (every language but the first).
      twoWay: laneSettings.twoWay === true,
      partnerLanguage: laneSettings.partnerLanguage ?? null,
      partnerOptions: TARGET_LANGUAGES.filter((code) => code !== laneSettings.targetLanguage),
      // While two-way is on the first select is "First language": the lane no longer interprets INTO one language.
      targetLabelKey: laneSettings.twoWay === true ? 'ext.twoWay.targetLabel' : 'language.target',
      // The note is for a lane whose chosen model is swapped for the pair, i.e. two-way on the translation-only model.
      // It names the model a start uses, so it is hidden while the lane runs on a backup model: the route line then
      // names the model really in use, and the two lines would contradict each other.
      modelNote: swappedForPair(laneSettings) && !(isActive(draft.phase) && hostLane?.fallback === true),
      // Rule 13: a running lane whose language, model or two-way choice differs from the settings applies the change at
      // the next start.
      applyNext: isActive(draft.phase) && hostLane !== null
        && ((hostLane.targetLanguage !== null && laneSettings.targetLanguage !== hostLane.targetLanguage)
          || (hostLane.model !== null && effectiveModelOf(laneSettings) !== hostLane.model && !hostLane.fallback)
          || pairChanged(runWith?.[lane] ?? null, laneSettings)),
      level: live ? (hostLane?.level ?? 0) : 0,
      levelVisible: live,
      quietNote: quietNoteOf(draft, input),
      preview: previewOf(draft, previews?.[lane] ?? null),
    };
    if (lane === 'tab') {
      vm.volume = laneSettings.originalVolume;
      vm.armNote = armNoteOf(draft, input);
      const title = bounded(capturedTitle);
      vm.tabline = isActive(draft.phase) && title ? { title } : null;
    }
    return [lane, vm];
  }));

  // Rule 14: the microphone permission line and the two buttons.
  const micDenied = mic.errorCode === 'MICROPHONE_DENIED' && mic.phase === 'error';
  const micPermissionVm = {
    state: micPermission,
    textKeys: PERMISSION_TEXT[micPermission] ?? CHECKING,
    attention: (micPermission !== 'granted' && settings.lanes.mic.enabled
      && (pending?.mic === true || input.localErrors?.mic === 'MICROPHONE_DENIED')) || micDenied,
    allowButton: micPermission !== 'granted',
  };

  // Rules 11 and 12.
  const muted = settings.speechMuted === true;
  const bothEnabled = settings.lanes.tab.enabled && settings.lanes.mic.enabled;
  const quotaSuspect = drafts.some((draft) => draft.errorCode !== null
    && (QUOTA_CODES.includes(draft.errorCode) || CONCURRENT_SESSION_CODES.includes(draft.errorCode)));

  return deepFreeze({
    language,
    pill: pillOf(drafts),
    keyMissing: !keyPresent,
    noLane,
    stopNote: STOP_NOTE_KEY[stopReason] ?? null,
    closeNote: drafts.some((draft) => BUSY.includes(draft.phase)),
    primary,
    lanes: laneVms,
    micPermission: micPermissionVm,
    mute: { muted, labelKey: muted ? 'ext.sound.on' : 'ext.sound.off',
      noteVisible: muted && (settings.lanes.tab.enabled || settings.lanes.mic.enabled) },
    echoNote: !muted && settings.lanes.mic.enabled,
    usageNote: { visible: bothEnabled, emphasis: bothEnabled && quotaSuspect },
  });
}

// ---------------------------------------------------------------------------------------------
// §21: the update banner. Pure like the rest of this file: the controller passes what it knows (the newer published
// version, the self-updater's folder state, whether a lane is under way, the step of a silent update in progress, the
// error code of one that failed) and renders the frozen result. The i18n keys are literals on purpose, one table each:
// a step or an error code the table does not know gets the generic sentence, never a raw code in front of a person.
const UPDATE_STEP_KEY = Object.freeze({
  checking: 'ext.updater.step.checking', downloading: 'ext.updater.step.downloading', verifying: 'ext.updater.step.verifying',
  writing: 'ext.updater.step.writing', reloading: 'ext.updater.step.reloading',
});
export const UPDATE_ERROR_KEY = Object.freeze({
  UPDATE_DISABLED: 'ext.updater.error.UPDATE_DISABLED', UPDATE_NO_FOLDER: 'ext.updater.error.UPDATE_NO_FOLDER',
  UPDATE_NEEDS_PERMISSION: 'ext.updater.error.UPDATE_NEEDS_PERMISSION', UPDATE_PERMISSION_DENIED: 'ext.updater.error.UPDATE_PERMISSION_DENIED',
  UPDATE_WRONG_FOLDER: 'ext.updater.error.UPDATE_WRONG_FOLDER', UPDATE_NOT_NEWER: 'ext.updater.error.UPDATE_NOT_NEWER',
  UPDATE_FETCH_FAILED: 'ext.updater.error.UPDATE_FETCH_FAILED', UPDATE_BAD_SIGNATURE: 'ext.updater.error.UPDATE_BAD_SIGNATURE',
  UPDATE_BAD_MANIFEST: 'ext.updater.error.UPDATE_BAD_MANIFEST', UPDATE_UNSAFE_PATH: 'ext.updater.error.UPDATE_UNSAFE_PATH',
  UPDATE_TOO_LARGE: 'ext.updater.error.UPDATE_TOO_LARGE', UPDATE_BAD_HASH: 'ext.updater.error.UPDATE_BAD_HASH',
  UPDATE_WRITE_FAILED: 'ext.updater.error.UPDATE_WRITE_FAILED', UPDATE_PICK_CANCELLED: 'ext.updater.error.UPDATE_PICK_CANCELLED',
  UPDATE_BUSY: 'ext.updater.error.UPDATE_BUSY',
});
const UPDATE_UNKNOWN_ERROR_KEY = 'ext.updater.error.UNKNOWN';
export const UPDATE_STEPS = Object.freeze(Object.keys(UPDATE_STEP_KEY));
const stepKeyOf = (step) => (Object.hasOwn(UPDATE_STEP_KEY, step) ? UPDATE_STEP_KEY[step] : UPDATE_STEP_KEY.checking);
const errorKeyOf = (code) => (typeof code === 'string' && Object.hasOwn(UPDATE_ERROR_KEY, code) ? UPDATE_ERROR_KEY[code] : UPDATE_UNKNOWN_ERROR_KEY);
// A stored folder (its permission may still be asked again with a click) reads "Update now"; no usable folder reads "Turn on".
const FOLDER_SET = Object.freeze(['granted', 'needs-click']);
const NO_AUTO = Object.freeze({ visible: false, labelKey: null, blocked: false });

/**
 * buildUpdateBanner({ update, currentVersion, updater, lastActive, laneBusy, step, error }) -> deeply frozen
 * { visible, parts: [{ key, params, nested? }], progress: { key } | null, get, reload, auto: { visible, labelKey, blocked } }.
 * `update` = { version } or null (no newer version published); `updater` = { enabled, folder } or null (no self-updater);
 * `lastActive` = a lane is under way per the host (a manual Reload would end it); `laneBusy` = that, or a start in flight,
 * or anything else a reload would cut; `step` = the step name while a silent update runs; `error` = its error code.
 * `parts` are joined with a space; a part's `nested` maps a parameter name to a KEY the controller translates first.
 * `progress` is the same news for the persistent live region (the banner itself is not live).
 */
export function buildUpdateBanner({
  update = null, currentVersion = null, updater = null, lastActive = false, laneBusy = false, step = null, error = null,
} = {}) {
  if (update === null) return deepFreeze({ visible: false, parts: [], progress: null, get: false, reload: false, auto: NO_AUTO });
  const params = { version: update.version, current: currentVersion };
  const reload = !lastActive;   // as before §21: a manual Reload would end a running lane
  if (updater?.enabled !== true) {
    return deepFreeze({ visible: true, parts: [{ key: 'ext.update.available', params }], progress: null, get: true, reload, auto: NO_AUTO });
  }
  // A silent update is under way: the banner says which step, and offers nothing to press (a Reload in the middle of
  // the writing would be the worst moment).
  if (step !== null) {
    const progress = { key: stepKeyOf(step) };
    return deepFreeze({ visible: true, parts: [{ key: progress.key, params: {} }], progress, get: false, reload: false, auto: NO_AUTO });
  }
  const hasFolder = FOLDER_SET.includes(updater.folder);
  const parts = [{ key: 'ext.updater.available', params }];
  let progress = null;
  if (error !== null) {
    progress = { key: errorKeyOf(error) };
    parts.push({ key: 'ext.updater.lastError', params: {}, nested: { error: progress.key } });
  }
  // Updating or turning it on opens the options page, and an update ends with a reload that would cut a lane: while one
  // is under way the button stays (focusable) but asks for nothing, and the sentence says why.
  if (laneBusy) parts.push({ key: 'ext.updater.banner.blocked', params: {} });
  else parts.push({ key: hasFolder ? 'ext.updater.banner.hintUpdate' : 'ext.updater.banner.hintEnable', params: {} });
  return deepFreeze({
    visible: true, parts, progress, get: true, reload,
    auto: { visible: true, labelKey: hasFolder ? 'ext.updater.button.update' : 'ext.updater.button.enable', blocked: laneBusy },
  });
}

export { LANE_TITLE_KEY };
