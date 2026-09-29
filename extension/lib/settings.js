// New implementation of docs/extension.md §7.1, §7.2 and §7.4; no legacy code is ported.
// Settings schema, defaults, normalization and the key record helpers. The storage area is INJECTED
// (the panel, options page and service worker pass `adapter.storage.local`), so this module names no
// platform API and touches nothing at import time. The personal key lives ONLY in `interp.key.v1`; it is
// never returned by a settings function, never part of an error, and never logged.
import {
  DEFAULT_LIVE_MODEL, DEFAULT_LIVE_VOICE_GENDER, LIVE_MODELS, LIVE_VOICE_GENDERS, TRANSLATE_LIVE_MODEL,
} from '../../app/providers/gemini/live-config.js';
import { validateKey } from '../../app/security/shared-key.js';
import {
  CAPTION_SIZE, DEFAULT_STYLE, KEY_PATTERN, ORIGINAL_VOLUME, TARGET_LANGUAGES, UI_LANGUAGES, deepFreeze,
  defaultPartnerLanguage, isPlainObject, normalizeStyle,
} from './constants.js';
import { LANES, STORAGE_KEYS } from './protocol.js';

export { CAPTION_SIZE };

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const keyShaped = (value) => typeof value === 'string' && KEY_PATTERN.test(value);
const MIC_TARGET_ORDER = Object.freeze(['en', 'ja', 'ko']);

/**
 * The 7.1 defaults. The two target languages are seeded from the UI language (tab = that language, mic = the first
 * of en/ja/ko that differs from it); anything else seeds as 'en'. `uiLanguage` itself stays 'auto'. Frozen.
 * Model rationale: 5.12 (an assumption, not a measurement: A8).
 */
export function createDefaultSettings(uiLanguage = 'en') {
  const language = pick(uiLanguage, TARGET_LANGUAGES, 'en');
  const micTarget = MIC_TARGET_ORDER.find((code) => code !== language);
  return deepFreeze({
    v: 1,
    uiLanguage: 'auto',
    voiceGender: DEFAULT_LIVE_VOICE_GENDER,
    speechMuted: true,     // captions only until the user unmutes
    lanes: {
      tab: { enabled: true, targetLanguage: language, twoWay: false, partnerLanguage: defaultPartnerLanguage(language),
        model: TRANSLATE_LIVE_MODEL, originalVolume: ORIGINAL_VOLUME.initial, captions: true },
      // OFF by default: your own translated speech is drawn into a web page only after an explicit opt-in (F14).
      mic: { enabled: false, targetLanguage: micTarget, twoWay: false, partnerLanguage: defaultPartnerLanguage(micTarget),
        model: DEFAULT_LIVE_MODEL, captions: false },
    },
    captions: { size: DEFAULT_STYLE.size, position: DEFAULT_STYLE.position, display: DEFAULT_STYLE.display,
      showSource: DEFAULT_STYLE.showSource, maxLines: DEFAULT_STYLE.maxLines,
      autoHideSeconds: DEFAULT_STYLE.autoHideSeconds },
  });
}
// The 7.1 listing: seeded from 'ko'. A field that is missing or invalid takes the value here.
export const DEFAULT_SETTINGS = createDefaultSettings('ko');

function volumeOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ORIGINAL_VOLUME.initial;
  return Math.min(ORIGINAL_VOLUME.max, Math.max(ORIGINAL_VOLUME.min, Math.round(value)));
}

function laneOf(raw, lane) {
  const source = isPlainObject(raw) ? raw : {};
  const fallback = DEFAULT_SETTINGS.lanes[lane];
  const targetLanguage = pick(source.targetLanguage, TARGET_LANGUAGES, fallback.targetLanguage);
  // A partner equal to the target (or unreadable, or missing in a record from before two-way existed) is repaired
  // to the default partner OF THE TARGET, never to the lane's static default: the pair must always be two languages.
  const partner = TARGET_LANGUAGES.includes(source.partnerLanguage) && source.partnerLanguage !== targetLanguage
    ? source.partnerLanguage : defaultPartnerLanguage(targetLanguage);
  const out = {
    enabled: bool(source.enabled, fallback.enabled),
    targetLanguage,
    twoWay: bool(source.twoWay, fallback.twoWay),
    partnerLanguage: partner,
    model: pick(source.model, LIVE_MODELS, fallback.model),
  };
  if (lane === 'tab') out.originalVolume = volumeOf(source.originalVolume);
  out.captions = bool(source.captions, fallback.captions);
  return out;
}

/**
 * Total: never throws (garbage in any shape gives defaults), unknown top-level and lane fields are dropped, `v` is
 * always 1, the result is deep-frozen. A non-object gives createDefaultSettings('en').
 */
export function normalizeSettings(raw) {
  const result = attempt(() => {
    if (!isPlainObject(raw)) return undefined;
    const lanes = isPlainObject(raw.lanes) ? raw.lanes : {};
    return deepFreeze({
      v: 1,
      uiLanguage: pick(raw.uiLanguage, UI_LANGUAGES, DEFAULT_SETTINGS.uiLanguage),
      voiceGender: pick(raw.voiceGender, LIVE_VOICE_GENDERS, DEFAULT_SETTINGS.voiceGender),
      speechMuted: bool(raw.speechMuted, DEFAULT_SETTINGS.speechMuted),
      lanes: { tab: laneOf(lanes.tab, 'tab'), mic: laneOf(lanes.mic, 'mic') },
      captions: normalizeStyle(raw.captions),
    });
  });
  return result ?? createDefaultSettings('en');
}

// The hook for a future v2: MIGRATIONS[n](record) returns the record at a HIGHER version (the table is a parameter
// of migrateSettings so the loop can be tested; production always uses this empty one).
export const MIGRATIONS = Object.freeze({});

/**
 * Stored value of any shape -> normalized v1. Nullish or a non-object gives the defaults. There is no older schema; a
 * `v` above 1 (a future writer) is read as v1 with unknown fields dropped. Reading never writes, so a newer record is
 * only replaced when the user changes something.
 */
export function migrateSettings(raw, migrations = MIGRATIONS) {
  let current = raw;
  attempt(() => {
    for (let step = 0; step < 16 && isPlainObject(current) && Object.hasOwn(migrations, current.v); step += 1) {
      const next = migrations[current.v](current);
      if (!isPlainObject(next) || !Number.isSafeInteger(next.v) || next.v <= current.v) break;
      current = next;
    }
  });
  return normalizeSettings(current);
}

/** HostSettings (4.2.2): what a running host applies live. Never a key, a language or a model. */
export function hostSettingsOf(settings) {
  const s = normalizeSettings(settings);
  return deepFreeze({
    speechMuted: s.speechMuted,
    tabOriginalVolume: s.lanes.tab.originalVolume,
    captions: { tab: s.lanes.tab.captions, mic: s.lanes.mic.captions },
    style: { size: s.captions.size, position: s.captions.position, display: s.captions.display,
      showSource: s.captions.showSource, maxLines: s.captions.maxLines, autoHideSeconds: s.captions.autoHideSeconds },
  });
}

/**
 * The per-lane part of a `host/lane-start` request (applies from the next start). A two-way lane adds
 * `languages: [target, partner]` and keeps `targetLanguage` (the lane's own language, shown in its state); the model
 * stays what the user chose, because the engine itself moves a translation-only model to an instruction-driven one
 * for a pair (the lane then reports the model it really runs, not this one).
 */
export function laneRequestOf(settings, lane) {
  if (!LANES.includes(lane)) throw codedError('INVALID_REQUEST');
  const { targetLanguage, partnerLanguage, twoWay, model } = normalizeSettings(settings).lanes[lane];
  return Object.freeze({ targetLanguage, model,
    ...(twoWay && partnerLanguage !== targetLanguage ? { languages: Object.freeze([targetLanguage, partnerLanguage]) } : {}) });
}

/**
 * Sets a lane's first language on a MUTABLE settings draft (the copy an updateSettings mutator gets). The pair is two
 * DIFFERENT languages: choosing the current partner as the first language sends the language just left to the
 * partner's place (the swap a user expects). Left to normalization, the pair would be repaired to the default partner
 * OF THE NEW TARGET instead, which can be a language the user never chose (ja<->en set to en became en<->ko). The panel
 * and the options page both change the target through this one helper, so the same choice gives the same pair on
 * either page. Returns nothing: the caller's draft is the result.
 */
export function setLaneTargetLanguage(settings, lane, value) {
  if (!LANES.includes(lane)) throw codedError('INVALID_REQUEST');
  const laneSettings = settings.lanes[lane];
  const previous = laneSettings.targetLanguage;
  laneSettings.targetLanguage = value;
  if (laneSettings.partnerLanguage === value) laneSettings.partnerLanguage = previous;
}

// ---------------------------------------------------------------------------------------------
// Storage. `area` = adapter.storage.local. Rejections propagate: the caller decides how to show them
// (`ext.error.STORAGE_FAILED`). Writers to the same area run one after another, so two overlapping read-modify-write
// calls in one realm cannot lose each other's field.
const queues = new WeakMap();
function serialized(area, task) {
  if (Object(area) !== area) return Promise.resolve().then(task);
  const next = (queues.get(area) ?? Promise.resolve()).then(task, task);   // start after the previous one settled, whatever its outcome
  queues.set(area, next.then(() => undefined, () => undefined));
  return next;
}
const recordOf = async (area, key) => {
  const stored = await area.get(key);
  return isPlainObject(stored) ? stored[key] : undefined;
};

export async function readSettings(area) {
  return migrateSettings(await recordOf(area, STORAGE_KEYS.settings));
}

async function writeNow(area, settings) {
  const value = normalizeSettings(settings);
  await area.set({ [STORAGE_KEYS.settings]: value });
  return value;
}
/** Normalizes, stores and returns the settings. */
export function writeSettings(area, settings) {
  return serialized(area, () => writeNow(area, settings));
}

/**
 * read -> mutate -> write, returns the new settings. `mutate` gets a fresh mutable copy: change it in place, or
 * return a replacement. Change only your own fields (the writers are user-driven, last writer wins per field).
 */
export function updateSettings(area, mutate) {
  if (typeof mutate !== 'function') return Promise.reject(codedError('INVALID_REQUEST'));
  return serialized(area, async () => {
    const draft = JSON.parse(JSON.stringify(await readSettings(area)));
    const replacement = await mutate(draft);
    return writeNow(area, replacement === undefined ? draft : replacement);
  });
}

/** The stored key, or null when absent or when the record is corrupt (wrong version or shape). */
export async function readKey(area) {
  const record = await recordOf(area, STORAGE_KEYS.key);
  return isPlainObject(record) && record.v === 1 && keyShaped(record.value) ? record.value : null;
}
/** Trims and validates (validateKey), then stores. Throws Error{code:'INVALID_KEY'} without the value in it. */
export async function writeKey(area, value) {
  let key;
  try { key = validateKey(typeof value === 'string' ? value.trim() : value); } catch { throw codedError('INVALID_KEY'); }
  await area.set({ [STORAGE_KEYS.key]: { v: 1, value: key } });
}
export async function deleteKey(area) {
  await area.remove(STORAGE_KEYS.key);
}
/** The panel only ever needs a boolean: the value is read and discarded. */
export async function hasKey(area) {
  return (await readKey(area)) !== null;
}
/** personal (a valid string) wins; else builtin[0] when it has the key shape; else null. No rotation (7.4). */
export function resolveKey({ personal, builtin } = {}) {
  if (keyShaped(personal)) return personal;
  const first = Array.isArray(builtin) ? builtin[0] : undefined;
  return keyShaped(first) ? first : null;
}
