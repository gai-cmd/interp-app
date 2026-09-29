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
export const ORIGINAL_VOLUME = Object.freeze({ min: 0, max: 100, initial: 65 });
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
export const isMachineCode = (value) => typeof value === 'string' && MACHINE_CODE_PATTERN.test(value);
// `request.model` on the wire and `LaneState.model` are both bounded to this many characters (4.2.1, 4.6.1).
export const MODEL_MAX_CHARS = 64;

// Vocabulary of LaneState (4.6.1) and of the caption frame (4.6.3), shared by the builders and the frame validator.
export const LANE_PHASES = Object.freeze(['off', 'starting', 'running', 'reconnecting', 'stopping', 'error']);
export const ENGINE_STATUSES = Object.freeze(['idle', 'preparing', 'connecting', 'running', 'reconnecting',
  'stopping', 'stopped', 'failed']);
export const OUTPUT_STATES = Object.freeze(['muted', 'ready', 'blocked', 'delayed', 'catching-up', 'unavailable']);
export const ROUTES = Object.freeze(['translation', 'flash']);
export const GAP_KINDS = Object.freeze(['input', 'audio', 'reception']);
export const OVERLAY_STATES = Object.freeze(['unknown', 'attached', 'unavailable']);
export const STATUS_PHASES = Object.freeze(['reconnecting', 'stopped', 'running']);
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
