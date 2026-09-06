// New implementation of design-p3 §1.5, §1.10 and architecture.md "개인 설정
// 저장소"; no legacy code is ported. This store holds the user's own choices
// only. Effective values (policy defaults, forced values) are computed by
// app/policy/resolve.js and are never written here, so lifting an
// administrator restriction restores the previous personal choice. Importing
// touches no browser globals; localStorage is injected. Storage rejection and
// corrupted values never throw out of this module: a corrupt value reads as
// "no choice" (null) and a rejected write is kept in memory for this run.
// Device IDs are local-only and must not enter policy, logs or diagnostics.
import { REGISTERED_SETTINGS } from './policy/schema.js';
import { SUPPORTED_LANGUAGES } from './i18n/index.js';
import { APP_DEFAULTS } from './config.js';

// Same key main.js has used since P1-19 for the UI language (§1.11 reuse).
export const UI_LANGUAGE_STORAGE_KEY = 'interp-app.ui.v1.language';
export const PREFERENCE_STORAGE_PREFIXES = Object.freeze({
  ui: 'interp-app.ui.v1.', pref: 'interp-app.pref.v1.', audio: 'interp-app.audio.v1.',
});
const DEVICE_ID_MAX_CHARS = 256;

function deepFreeze(value) {
  if (Array.isArray(value)) { for (const item of value) deepFreeze(item); return Object.freeze(value); }
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); return Object.freeze(value); }
  return value;
}

// Local-only names: never policy managed. ui.language is an access path and
// cannot be locked (§1.4); device IDs stay on the device (§1.14).
export const LOCAL_SETTINGS = deepFreeze({
  'ui.language': { kind: 'enum', values: [...SUPPORTED_LANGUAGES], default: null },
  'audio.inputDeviceId': { kind: 'deviceId', default: null },
  'audio.outputDeviceId': { kind: 'deviceId', default: null },
});

// Registered policy settings first (resolve.js iterates the same order), then local ones.
export const PREFERENCE_NAMES = Object.freeze([...Object.keys(REGISTERED_SETTINGS), ...Object.keys(LOCAL_SETTINGS)]);
// Stored per provider (§1.13): the key carries the provider ID of the instance.
export const PROVIDER_SCOPED_NAMES = Object.freeze(['billing.plan']);

// Storage key table from architecture.md (P3-01 decision).
const STORAGE_KEYS = Object.freeze({
  'ui.language': UI_LANGUAGE_STORAGE_KEY,
  'ui.mode': `${PREFERENCE_STORAGE_PREFIXES.ui}mode`,
  'ui.tone': `${PREFERENCE_STORAGE_PREFIXES.ui}tone`,
  'ui.text': `${PREFERENCE_STORAGE_PREFIXES.ui}text`,
  'captions.size': `${PREFERENCE_STORAGE_PREFIXES.ui}captionSize`,
  'interpretation.sourceLanguage': `${PREFERENCE_STORAGE_PREFIXES.pref}interpretation.sourceLanguage`,
  'interpretation.targetLanguage': `${PREFERENCE_STORAGE_PREFIXES.pref}interpretation.targetLanguage`,
  'voice.output': `${PREFERENCE_STORAGE_PREFIXES.pref}voice.output`,
  'billing.plan': `${PREFERENCE_STORAGE_PREFIXES.pref}billing.plan`,
  'audio.inputDeviceId': `${PREFERENCE_STORAGE_PREFIXES.audio}inputDeviceId`,
  'audio.outputDeviceId': `${PREFERENCE_STORAGE_PREFIXES.audio}outputDeviceId`,
});

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const invalid = () => { throw new TypeError('INVALID_REQUEST'); };

/** Spec of a registered or local-only name; unknown (incl. prototype) names throw. */
export function preferenceSpec(name) {
  if (typeof name !== 'string') invalid();
  if (Object.hasOwn(REGISTERED_SETTINGS, name)) return REGISTERED_SETTINGS[name];
  if (Object.hasOwn(LOCAL_SETTINGS, name)) return LOCAL_SETTINGS[name];
  throw new TypeError('PREFERENCE_UNKNOWN');
}

/** localStorage key for a name; provider-scoped names append the provider ID. */
export function storageKeyFor(name, providerId = APP_DEFAULTS.providerId) {
  preferenceSpec(name);
  if (!PROVIDER_SCOPED_NAMES.includes(name)) return STORAGE_KEYS[name];
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) invalid();
  return `${STORAGE_KEYS[name]}.${providerId}`;
}

const onGrid = (value, origin, step) => {
  const steps = (value - origin) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
};

/**
 * The one value interpretation shared by the store, the resolver (P3-05), the
 * appearance boot script and runtime (P3-13/14): returns the accepted value or
 * null. Accepts the stored string form as well as typed values; never throws
 * for values, only for unknown names.
 */
export function normalizePreference(name, value) {
  const spec = preferenceSpec(name);
  if (value === null || value === undefined) return null;
  if (spec.kind === 'enum') return typeof value === 'string' && spec.values.includes(value) ? value : null;
  if (spec.kind === 'number') {
    let number;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && NUMBER_TEXT.test(value.trim())) number = Number(value.trim());
    else return null;
    return Number.isFinite(number) && number >= spec.min && number <= spec.max && onGrid(number, spec.min, spec.step)
      ? number : null;
  }
  // deviceId: opaque browser identifier; an empty string means the system default.
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= DEVICE_ID_MAX_CHARS
    && !CONTROL_CHARS.test(value) ? value : null;
}

/** String form written to storage (numbers use the shortest round-trip text). */
export function serializePreference(name, value) {
  const accepted = normalizePreference(name, value);
  return accepted === null ? null : String(accepted);
}

function usable(storage) {
  return !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    && typeof storage.removeItem === 'function';
}

/**
 * Read one personal choice straight from storage without an instance (boot
 * paths). Storage exceptions and corrupt values yield null.
 */
export function readPreference(storage, name, { providerId = APP_DEFAULTS.providerId } = {}) {
  const key = storageKeyFor(name, providerId);
  if (!usable(storage)) return null;
  let raw;
  try { raw = storage.getItem(key); } catch { return null; }
  return normalizePreference(name, raw);
}

/**
 * createPreferences({ storage?, now?, providerId? }) returns a frozen store:
 * get(name), set(name, value) -> { ok, persisted }, remove(name) -> { ok, persisted },
 * snapshot() -> frozen { [name]: value | null }, subscribe(fn) -> unsubscribe,
 * persisted (storage usable and the last access succeeded), providerId.
 * Reads go through to storage on every call so another tab's change is seen
 * without a cache; values that could not be written are kept in memory for
 * this run only. Values are validated with normalizePreference before any
 * write; an invalid value is rejected ({ ok: false }) and storage is untouched.
 * The store never records effective values: policy defaults and forced values
 * live only in resolveEffective() results.
 */
export function createPreferences({ storage = null, now = Date.now, providerId = APP_DEFAULTS.providerId } = {}) {
  if (typeof now !== 'function') invalid();
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) invalid();
  const backing = usable(storage) ? storage : null;
  const memory = new Map();
  const listeners = new Set();
  let healthy = backing !== null;
  const keyOf = (name) => storageKeyFor(name, providerId);

  function access(fn) {
    if (!backing) return { ok: false, value: undefined };
    try {
      const value = fn(backing);
      healthy = true;
      return { ok: true, value };
    } catch {
      // Quota, SecurityError, disabled storage: never rethrown, never logged.
      healthy = false;
      return { ok: false, value: undefined };
    }
  }
  function read(name) {
    const key = keyOf(name);
    const result = access((store) => store.getItem(key));
    if (result.ok) {
      const stored = normalizePreference(name, result.value);
      if (stored !== null || !memory.has(name)) return stored;
    }
    return memory.has(name) ? memory.get(name) : null;
  }
  function notify(type, name, value, persisted) {
    const event = Object.freeze({ type, name, value, persisted, at: now() });
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Consumer-owned failure. */ }
    }
  }

  const api = {
    providerId,
    get persisted() { return healthy; },
    get(name) { return read(name); },
    set(name, value) {
      const accepted = normalizePreference(name, value);
      if (accepted === null) return Object.freeze({ ok: false, persisted: healthy });
      const key = keyOf(name);
      const text = String(accepted);
      const written = access((store) => { store.setItem(key, text); }).ok;
      if (written) memory.delete(name);
      else memory.set(name, accepted);
      notify('set', name, accepted, written);
      return Object.freeze({ ok: true, persisted: written });
    },
    remove(name) {
      const key = keyOf(name);
      const removed = access((store) => { store.removeItem(key); }).ok;
      memory.delete(name);
      notify('remove', name, null, removed);
      return Object.freeze({ ok: true, persisted: removed });
    },
    snapshot() {
      return Object.freeze(Object.fromEntries(PREFERENCE_NAMES.map((name) => [name, read(name)])));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') invalid();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return Object.freeze(api);
}
