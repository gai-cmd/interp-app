// New implementation of docs/extension.md §3.5, §4.2.1, §4.6.1 and §7.2; no legacy code is ported.
// The enum lists and range rules that protocol.js validates wire data with and settings.js
// normalizes stored data with. They live in ONE module that imports nothing, so the service
// worker can validate a message without loading any app module and a message the SW built from
// normalized settings can never be refused by the host's validator (the rules exist once).
// Parity tests pin VOICE_GENDERS and CAPTION_SIZE against the app's own values
// (LIVE_VOICE_GENDERS, app/preferences.js). Importing touches no global.

export const VOICE_GENDERS = Object.freeze(['female', 'male']);
export const TARGET_LANGUAGES = Object.freeze(['ko', 'en', 'ja']);
export const UI_LANGUAGES = Object.freeze(['auto', ...TARGET_LANGUAGES]);

// Two-way mode (a lane interprets in both directions between its target language and a partner language). The
// pair is [target, partner]: two DISTINCT interpretation languages. The rules live here, with the other enums, so
// the message validator, the settings normalizer and the caption row guess agree on what a pair is.
/** The partner a lane starts with: English, unless the target already is English (then Korean). */
export const defaultPartnerLanguage = (target) => (target === 'en' ? 'ko' : 'en');
/** True only for an array of exactly two distinct interpretation languages. */
export const isLanguagePair = (value) => Array.isArray(value) && value.length === 2   // indexed, not every(): a hole is no language
  && TARGET_LANGUAGES.includes(value[0]) && TARGET_LANGUAGES.includes(value[1]) && value[0] !== value[1];

// Same numbers as app/preferences.js CAPTION_SIZE (registered `captions.size` policy spec).
export const CAPTION_SIZE = Object.freeze({ min: 1, max: 2, step: 0.125, initial: 1.5 });
/** Nearest valid caption size; anything unreadable falls back to the default (same semantics as the app). */
export function clampCaptionSize(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(number)) return CAPTION_SIZE.initial;
  const steps = Math.round((number - CAPTION_SIZE.min) / CAPTION_SIZE.step);
  const size = CAPTION_SIZE.min + steps * CAPTION_SIZE.step;
  return Number(Math.min(CAPTION_SIZE.max, Math.max(CAPTION_SIZE.min, size)).toFixed(3));
}

export const CAPTION_POSITIONS = Object.freeze(['top', 'bottom']);
export const CAPTION_DISPLAYS = Object.freeze(['dark', 'light', 'mono']);
// §20 (2026-10-02): the starting original volume is 45, the owner's own choice (it was 65).
export const ORIGINAL_VOLUME = Object.freeze({ min: 0, max: 100, initial: 45 });
export const STYLE_LIMITS = Object.freeze({
  size: CAPTION_SIZE,
  maxLines: Object.freeze({ min: 1, max: 6, initial: 3 }),
  autoHideSeconds: Object.freeze({ min: 0, max: 60, initial: 8 }),
  positions: CAPTION_POSITIONS,
  displays: CAPTION_DISPLAYS,
});
export const DEFAULT_STYLE = Object.freeze({ size: CAPTION_SIZE.initial, position: 'bottom', display: 'dark',
  showSource: false, maxLines: STYLE_LIMITS.maxLines.initial, autoHideSeconds: STYLE_LIMITS.autoHideSeconds.initial });

// Machine codes cross the protocol, never text (4.1). A key is 1..512 printable ASCII (7.2, 7.4);
// a host id is bounded printable ASCII (4.6.1).
export const MACHINE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}$/;
export const KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;
export const HOST_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;
// §19 (2026-09-30): a tab lane started through the browser's share picker does not know which tab the user chose. Before
// asking, the service worker tags every page with a label `<nonce>.<tabId>` (a capture handle only this extension's
// origin may read, set by the overlay content script); the captured track then carries the label of the chosen tab.
// The nonce is random per start, so a page cannot claim to be another tab.
export const CAPTURE_NONCE_PATTERN = /^[a-f0-9]{32}$/;
export const CAPTURE_LABEL_PATTERN = /^[a-f0-9]{32}\.\d{1,15}$/;
/** The tab id a capture label names, or null when the label is missing, malformed or carries another start's nonce. */
export function tabIdOfCaptureLabel(label, nonce) {
  if (typeof label !== 'string' || typeof nonce !== 'string' || !CAPTURE_NONCE_PATTERN.test(nonce)
    || !CAPTURE_LABEL_PATTERN.test(label) || !label.startsWith(`${nonce}.`)) return null;
  const tabId = Number(label.slice(nonce.length + 1));
  return Number.isSafeInteger(tabId) ? tabId : null;
}
// §22 (2026-10-08): a tab lane whose share dialog the SIDE PANEL opened gets the chosen tab's audio from the panel over a
// BroadcastChannel named after this id (random per start, 32 lowercase hex like the capture nonce). The message
// validator and the relay module (lib/audio-relay.js) read the same rule from here.
export const RELAY_ID_PATTERN = /^[a-f0-9]{32}$/;
export const isMachineCode = (value) => typeof value === 'string' && MACHINE_CODE_PATTERN.test(value);
// 2026-09-30: WHY an INVALID_RESULT was raised (the engine's snapshot.errorReason, one of the app's
// INVALID_RESULT_REASONS, e.g. `audio-encoding`). It crosses as an identifier of this shape and nothing else, next to
// its code: the panel shows it after the failure notice so the next failure can be diagnosed from a screenshot.
export const ERROR_REASON_PATTERN = /^[a-z][a-z-]{1,31}$/;
export const isErrorReason = (value) => typeof value === 'string' && ERROR_REASON_PATTERN.test(value);
// `request.model` on the wire and `LaneState.model` are both bounded to this many characters (4.2.1, 4.6.1).
export const MODEL_MAX_CHARS = 64;
// §24 (0.5.2): the ONE id shape of a general Google Live model, `gemini-<major>.<minor>-live`. Previews, `-extended-thinking`,
// translation, transcription, native-audio and robotics models never match, so none of them is ever adopted as "the latest".
export const GENERAL_LIVE_ID = /^gemini-(\d{1,2})\.(\d{1,2})-live$/;
/** What the worker tells a starting lane about the latest model: use the record as it is, ask in the background, or ask first. */
export const LATEST_REFRESH = Object.freeze(['none', 'background', 'blocking']);
/** What a lane reports back to the worker (sw/latest-live): the newest general Live model the account lists, a failed look, a refused model. */
export const LATEST_REPORT_KINDS = Object.freeze(['seen', 'failed', 'rejected']);

// Vocabulary of LaneState (4.6.1) and of the caption frame (4.6.3), shared by the builders and the frame validator.
export const LANE_PHASES = Object.freeze(['off', 'starting', 'running', 'reconnecting', 'stopping', 'error']);
export const ENGINE_STATUSES = Object.freeze(['idle', 'preparing', 'connecting', 'running', 'reconnecting',
  'stopping', 'stopped', 'failed']);
export const OUTPUT_STATES = Object.freeze(['muted', 'ready', 'blocked', 'delayed', 'catching-up', 'unavailable']);
export const ROUTES = Object.freeze(['translation', 'flash']);
export const GAP_KINDS = Object.freeze(['input', 'audio', 'reception']);
export const OVERLAY_STATES = Object.freeze(['unknown', 'attached', 'unavailable']);
export const STATUS_PHASES = Object.freeze(['reconnecting', 'stopped', 'running']);
// 2026-09-30: why a lane is reconnecting when interpreting goes on (the engine's snapshot.reconnectReason): a spare
// site key took over, or the planned ~10-minute connection handover. Neither is a lost connection.
export const RECONNECT_REASONS = Object.freeze(['key', 'handover']);
export const CAPTION_ROLES = Object.freeze(['translation', 'source']);
export const CAPTION_STATUSES = Object.freeze(['partial', 'final', 'interrupted']);

/** Plain data object of ANY realm (a message or stored record: prototype is null or a realm's Object.prototype). */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** Recursively freezes plain data and returns it. */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const integerIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * Total: never throws, always returns a valid frozen style. Unknown fields are dropped, a missing or
 * invalid field takes its default. `size` snaps to the nearest step (clampCaptionSize); the two integer
 * fields fall back to the default when out of range (they are not clamped, 7.2).
 */
export function normalizeStyle(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const { maxLines, autoHideSeconds } = STYLE_LIMITS;
  return Object.freeze({
    size: clampCaptionSize(source.size),
    position: CAPTION_POSITIONS.includes(source.position) ? source.position : DEFAULT_STYLE.position,
    display: CAPTION_DISPLAYS.includes(source.display) ? source.display : DEFAULT_STYLE.display,
    showSource: typeof source.showSource === 'boolean' ? source.showSource : DEFAULT_STYLE.showSource,
    maxLines: integerIn(source.maxLines, maxLines.min, maxLines.max) ? source.maxLines : maxLines.initial,
    autoHideSeconds: integerIn(source.autoHideSeconds, autoHideSeconds.min, autoHideSeconds.max)
      ? source.autoHideSeconds : autoHideSeconds.initial,
  });
}

/**
 * Strict check (no normalization): true only for a style the host will accept, i.e. an on-grid size, both
 * enums, integer `maxLines` 1..6 and `autoHideSeconds` 0..60. `showSource` is host-side only, so the overlay's
 * `style` frame (which has no such field) is checked with { showSource: false }.
 */
export function isValidStyle(style, { showSource = true } = {}) {
  if (!isPlainObject(style)) return false;
  const { maxLines, autoHideSeconds } = STYLE_LIMITS;
  return typeof style.size === 'number' && clampCaptionSize(style.size) === style.size
    && CAPTION_POSITIONS.includes(style.position) && CAPTION_DISPLAYS.includes(style.display)
    && (!showSource || typeof style.showSource === 'boolean')
    && integerIn(style.maxLines, maxLines.min, maxLines.max)
    && integerIn(style.autoHideSeconds, autoHideSeconds.min, autoHideSeconds.max);
}
