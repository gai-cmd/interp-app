// New implementation of docs/extension.md §4.6.1, §4.6.2, §5.11 and §9.6; no legacy code is ported.
// Pure builders for the compact state the offscreen host sends to the panel: the snapshot -> LaneState
// mapping, the UiState envelope and the error-code -> i18n-key chain. The engine snapshot never crosses
// (4.6.4): everything the panel may see is copied field by field with a bound, so no session id, generation,
// metric, raw caption, discovered model, tab URL or key can appear in a state. No global is touched.
import {
  ENGINE_STATUSES, GAP_KINDS, HOST_ID_PATTERN, LANE_PHASES, MODEL_MAX_CHARS, OUTPUT_STATES, OVERLAY_STATES,
  RECONNECT_REASONS, ROUTES, TARGET_LANGUAGES, deepFreeze, isErrorReason, isMachineCode,
} from './constants.js';
import { LANES, PROTOCOL_VERSION, validateLaneState } from './protocol.js';

export { LANE_PHASES };
// The phases in which a lane occupies a Live session: `UiState.concurrent` counts them (the 2x free-tier note).
export const ACTIVE_PHASES = Object.freeze(['starting', 'running', 'reconnecting']);
export const QUOTA_CODES = Object.freeze(['RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429']);
export const KEY_FAILURE_CODES = Object.freeze(['CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'INVALID_KEY', 'PERMISSION_DENIED']);
export const EXTENSION_ERROR_CODES = Object.freeze(['TAB_CAPTURE_FAILED', 'TAB_UNSUPPORTED', 'TAB_GONE',
  'TAB_CAPTURE_BUSY', 'TAB_ENDED', 'TAB_AUDIO_BLOCKED', 'TAB_SHARE_NO_AUDIO', 'TAB_INPUT_LOST', 'HOST_UNAVAILABLE', 'OVERLAY_UNAVAILABLE',
  'LANE_STOPPING', 'MICROPHONE_EXPIRED', 'STORAGE_FAILED']);
export const OVERRIDDEN_ENGINE_CODES = Object.freeze(['CREDENTIAL_REQUIRED', 'INVALID_KEY', 'PERMISSION_DENIED',
  'CREDENTIAL_FORBIDDEN', 'IP_DENIED', 'MODEL_UNSUPPORTED', 'RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429',
  'SESSION_LIMIT', 'BUDGET_EXHAUSTED', 'INPUT_UNSUPPORTED', 'MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE', 'BROWSER_INTERRUPTED']);
// The sim engine's capture path is shared: it reports a tab-audio failure as a microphone code (4.6.2).
export const TAB_CAPTURE_CODES = Object.freeze(['MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE', 'BROWSER_INTERRUPTED']);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });

/**
 * i18n key for an error code, in TWO levels only (`ext.error.<CODE>` then `error.<CODE>`, never `sim.error.*`, whose
 * texts mention phones, Safari and HTTPS), else `error.unknown`. `has` is the dictionary's key test. On the TAB
 * lane the three microphone codes of TAB_CAPTURE_CODES read `ext.error.TAB_INPUT_LOST` instead: showing "microphone"
 * text would send the owner debugging the wrong thing. TIMEOUT is not remapped (the engine raises it for both a
 * 30 s capture setup and a provider response timeout). A value that is not a machine code never reaches `has`.
 */
export function errorKeyFor(code, has, lane = null) {
  if (!isMachineCode(code)) return 'error.unknown';
  if (lane === 'tab' && TAB_CAPTURE_CODES.includes(code)) return 'ext.error.TAB_INPUT_LOST';
  const known = (key) => typeof has === 'function' && attempt(() => has(key)) === true;
  if (known(`ext.error.${code}`)) return `ext.error.${code}`;
  if (known(`error.${code}`)) return `error.${code}`;
  return 'error.unknown';
}

const LIVE_PHASES = ['starting', 'running', 'reconnecting', 'stopping'];   // a session exists
const clampInt = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min);

/**
 * The 4.6.2 mapping, pure. `snapshot` is the frozen engine snapshot or null (no engine yet). `facts` are the lane's
 * own bookkeeping: { tabId, captions, overlay, epoch, targetLanguage, stopRequested, hostError, starting, stopping }.
 * `starting` is the host-level step before the engine exists (acquiring the tab stream); `stopping` covers the whole
 * teardown, including the part the engine does not know about (the tab graph); `hostError` is a code the host
 * itself decided on (TAB_ENDED, TAB_AUDIO_BLOCKED, ...) and outranks the engine. `level` is the last input level
 * percent. Precedence: stopping, hostError, then the engine status of the table. A stop the engine reports without a
 * request (`stopped` while `stopRequested === false`) is BROWSER_INTERRUPTED. Never throws for data; an unknown lane
 * is a programming error and throws Error{code:'INVALID_REQUEST'}.
 */
export function laneStateFromSnapshot({ lane, snapshot = null, facts = {}, level = 0 } = {}) {
  if (!LANES.includes(lane)) throw codedError('INVALID_REQUEST');
  const snap = snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
  const f = facts !== null && typeof facts === 'object' ? facts : {};
  const status = ENGINE_STATUSES.includes(snap?.status) ? snap.status : null;

  let phase = 'off';
  let errorCode = null;
  if (f.stopping === true) phase = 'stopping';
  else if (isMachineCode(f.hostError)) { phase = 'error'; errorCode = f.hostError; }
  else if (status === null) phase = f.starting === true ? 'starting' : 'off';
  else if (status === 'preparing' || status === 'connecting') phase = 'starting';
  else if (status === 'running' || status === 'reconnecting' || status === 'stopping') phase = status;
  else if (status === 'failed') { phase = 'error'; errorCode = isMachineCode(snap.errorCode) ? snap.errorCode : 'INTERNAL'; }
  else if (status === 'stopped' && f.stopRequested === false) { phase = 'error'; errorCode = 'BROWSER_INTERRUPTED'; }
  // idle, and stopped after a requested stop: off

  const live = LIVE_PHASES.includes(phase);
  const session = snap !== null && phase !== 'off';
  return deepFreeze({
    lane,
    phase,
    engineStatus: status,
    retries: session ? clampInt(snap.retries, 0, 3) : 0,
    // 2026-09-30: a key swap or the planned connection handover, while reconnecting only; null is a lost connection.
    reconnectReason: phase === 'reconnecting' && RECONNECT_REASONS.includes(snap?.reconnectReason) ? snap.reconnectReason : null,
    output: live && OUTPUT_STATES.includes(snap?.output) ? snap.output : null,
    model: session && typeof snap.model === 'string' && snap.model !== '' ? snap.model.slice(0, MODEL_MAX_CHARS) : null,
    route: session && ROUTES.includes(snap.route) ? snap.route : null,
    fallback: session && snap.fallback === true,
    targetLanguage: phase !== 'off' && TARGET_LANGUAGES.includes(f.targetLanguage) ? f.targetLanguage : null,
    errorCode,
    // 2026-09-30: which check refused the result, for the one code that has reasons and only when the engine itself
    // failed with it (a host-level error such as TAB_ENDED outranks the engine and has no reason).
    errorReason: errorCode === 'INVALID_RESULT' && status === 'failed' && isErrorReason(snap?.errorReason) ? snap.errorReason : null,
    quota: QUOTA_CODES.includes(errorCode),
    keyFailure: KEY_FAILURE_CODES.includes(errorCode),
    level: phase === 'running' || phase === 'reconnecting' ? clampInt(level, 0, 100) : 0,
    tabId: lane === 'tab' && Number.isSafeInteger(f.tabId) && f.tabId >= 0 ? f.tabId : null,
    captions: f.captions === true,
    overlay: OVERLAY_STATES.includes(f.overlay) ? f.overlay : 'unknown',
    // The first sticky gap flag of the live session, in the order input, audio, reception.
    gap: (live ? GAP_KINDS.find((kind) => snap?.captions?.gaps?.[kind] === true) : undefined) ?? null,
    epoch: Number.isSafeInteger(f.epoch) && f.epoch >= 0 ? f.epoch : 0,
  });
}

/** A lane that never ran. */
export const createIdleLaneState = (lane) => laneStateFromSnapshot({ lane });

/**
 * UiState (4.6.1). `lanes` = { tab, mic } LaneStates (an invalid or missing one becomes an idle lane, so the result
 * always validates); `concurrent` is derived from them; `seq` is the host's counter (>= 1). Every string in it is
 * bounded, so the whole object stays far below the 2 KB the contract allows.
 */
export function buildUiState({ hostId, seq, speechMuted = true, lanes = {} } = {}) {
  const tab = validateLaneState(lanes?.tab, 'tab') ?? createIdleLaneState('tab');
  const mic = validateLaneState(lanes?.mic, 'mic') ?? createIdleLaneState('mic');
  return deepFreeze({
    v: PROTOCOL_VERSION,
    seq: Number.isSafeInteger(seq) && seq >= 1 ? seq : 1,
    hostId: typeof hostId === 'string' && HOST_ID_PATTERN.test(hostId) ? hostId : 'h-unknown',
    speechMuted: speechMuted !== false,
    concurrent: [tab, mic].filter((state) => ACTIVE_PHASES.includes(state.phase)).length,
    lanes: { tab, mic },
  });
}
