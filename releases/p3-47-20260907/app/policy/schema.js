// New implementation of design-p3 §1.3-§1.4 and architecture.md "정책 모듈";
// no legacy code is ported. One pure validator shared by the browser policy
// client (P3-06), the admin console (P3-32) and check-release (P3-36).
// Importing touches no browser globals, network or storage. Validation never
// merges the input into anything (no Object.assign / deep merge): every
// accepted field is copied into a fresh, deeply frozen object and everything
// else is rejected. Issues carry a code and a dotted path only, never values.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { CAPABILITIES } from '../providers/contract.js';
import { GEMINI_PROVIDER_ID } from '../providers/gemini/index.js';
import { REGISTERED_HUBS } from '../hub/protocol.js';
import { APP_VERSION_PATTERN, parseVersion } from '../version.js';

export const POLICY_SCHEMA_VERSION = 1;

// Upper bounds (design-p3 §1.3 rule 4, §1.4 field contract). Counts are list
// lengths; *Chars are Unicode code points per language.
export const POLICY_LIMITS = Object.freeze({
  bodyBytes: 65536, notices: 10, events: 100, rates: 64, allowedHubIds: 32,
  textChars: 1000, reasonChars: 300, idChars: 64, eventNameChars: 120, maxAmount: 1000,
});

export const POLICY_LANGUAGES = SUPPORTED_LANGUAGES;

export const POLICY_ISSUE_CODES = Object.freeze(['POLICY_SCHEMA', 'POLICY_FIELD', 'POLICY_RANGE', 'POLICY_TEXT',
  'POLICY_REFERENCE', 'POLICY_CONFLICT', 'POLICY_UNKNOWN_KEY', 'POLICY_TOO_LARGE']);

// Known feature toggles (§1.4). A policy can only switch these off or on; it
// never grants a capability the code does not implement.
export const REGISTERED_FEATURES = Object.freeze(['sequential', 'simultaneousDirect', 'hubListen',
  'diagnostics', 'sharedKeys', 'rememberPersonalKey']);

function deepFreeze(value) {
  if (Array.isArray(value)) { for (const item of value) deepFreeze(item); return Object.freeze(value); }
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); return Object.freeze(value); }
  return value;
}

// The eight policy-managed settings (§1.4). ui.language is deliberately absent:
// the UI language is an access path and cannot be locked by an administrator.
export const REGISTERED_SETTINGS = deepFreeze({
  'ui.mode': { kind: 'enum', values: ['system', 'light', 'dark'], default: 'system' },
  'ui.tone': { kind: 'enum', values: ['navy', 'warm', 'forest', 'mono'], default: 'navy' },
  'ui.text': { kind: 'enum', values: ['s', 'm', 'l', 'xl'], default: 'm' },
  'captions.size': { kind: 'number', min: 1, max: 2, step: 0.125, default: 1.5 },
  'interpretation.sourceLanguage': { kind: 'enum', values: ['auto', ...SUPPORTED_LANGUAGES], default: 'ko' },
  'interpretation.targetLanguage': { kind: 'enum', values: [...SUPPORTED_LANGUAGES], default: 'ja' },
  'voice.output': { kind: 'enum', values: ['provider', 'device', 'off'], default: 'provider' },
  'billing.plan': { kind: 'enum', values: ['free', 'paid'], default: 'free' },
});

export const NOTICE_SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
// Shared-key events never enable Live: direct simultaneous interpretation stays
// personal-key only (§1.4 "行事政策だけで公用Liveを有効化しない").
export const EVENT_CAPABILITIES = Object.freeze(CAPABILITIES.filter((capability) => capability !== 'live'));
export const RATE_UNITS = Object.freeze(['minute']);
export const RATE_BASES = Object.freeze(['activeMinuteEstimate']);
export const RATE_CONFIDENCES = Object.freeze(['low', 'medium', 'high']);
// Provider IDs a policy may reference; reviewed code only (§1.1).
export const REGISTERED_PROVIDER_IDS = Object.freeze([GEMINI_PROVIDER_ID]);

const ROOT_KEYS = Object.freeze(['schemaVersion', 'revision', 'publishedAt', 'validUntil', 'minAppVersion',
  'emergency', 'features', 'settings', 'notices', 'sharedEvents', 'hubControl', 'pricing']);
const EMERGENCY_KEYS = Object.freeze(['stopped', 'reason']);
const ENUM_SETTING_KEYS = Object.freeze(['default', 'allowed', 'locked']);
const NUMBER_SETTING_KEYS = Object.freeze(['default', 'min', 'max', 'step', 'locked']);
const NOTICE_KEYS = Object.freeze(['id', 'severity', 'showFrom', 'showUntil', 'text']);
const EVENT_KEYS = Object.freeze(['id', 'providerId', 'eventName', 'label', 'startsAt', 'expiresAt', 'enabled', 'allowedCapabilities']);
const HUB_CONTROL_KEYS = Object.freeze(['enabled', 'allowedHubIds', 'allowDirectSubscription']);
const PRICING_KEYS = Object.freeze(['revision', 'updatedAt', 'currency', 'allowLocalOverride', 'rates']);
const RATE_KEYS = Object.freeze(['model', 'capability', 'unit', 'amount', 'basis', 'confidence', 'verifiedAt']);

// Same shapes the shared-key parser and hub protocol accept (architecture.md).
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// UTC only ("タイムゾーン付きUTC日時"): offsets other than Z are rejected.
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MARKUP = /<\/?[a-zA-Z!?]/;

/** Numeric major.minor.patch comparison (-1, 0, 1); malformed input throws. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new TypeError('VERSION_INVALID');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const unique = (items) => new Set(items).size === items.length;
const onGrid = (value, origin, step) => {
  const steps = (value - origin) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
};
const join = (path, key) => (path ? `${path}.${key}` : String(key));

// Epoch milliseconds for a strict UTC timestamp, or null. Round-tripping
// through Date rejects impossible dates such as February 30.
function parseDateTime(value) {
  if (typeof value !== 'string' || !DATETIME_PATTERN.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}

function byteLength(text) { return new TextEncoder().encode(text).byteLength; }

class Validation {
  constructor() { this.issues = []; }

  issue(code, path) { this.issues.push({ code, path }); return undefined; }

  // Own enumerable keys only; anything outside `allowed` (including __proto__,
  // constructor and prototype, which are never allowed) is an unknown key.
  // Unknown key names are echoed in the path only when they are plain identifiers.
  keys(value, allowed, required, path) {
    let ok = true;
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      ok = false;
      this.issue('POLICY_UNKNOWN_KEY', SAFE_KEY.test(key) ? join(path, key) : path);
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) { ok = false; this.issue('POLICY_FIELD', join(path, key)); }
    }
    return ok;
  }

  object(value, allowed, required, path) {
    if (!isObject(value)) return this.issue('POLICY_FIELD', path) ?? false;
    return this.keys(value, allowed, required, path);
  }

  boolean(value, path) { return typeof value === 'boolean' ? value : this.issue('POLICY_FIELD', path); }

  positiveInteger(value, path) { return positiveInteger(value) ? value : this.issue('POLICY_FIELD', path); }

  dateTime(value, path, { nullable = false } = {}) {
    if (value === null && nullable) return null;
    return parseDateTime(value) === null ? this.issue('POLICY_FIELD', path) : value;
  }

  identifier(value, path, pattern = ID_PATTERN) {
    return typeof value === 'string' && pattern.test(value) ? value : this.issue('POLICY_FIELD', path);
  }

  oneOf(value, values, path, code = 'POLICY_FIELD') {
    return typeof value === 'string' && values.includes(value) ? value : this.issue(code, path);
  }

  // { ko, en, ja }: every supported language present, non-blank, bounded and
  // plain text (no control characters, no tag-like markup). Extra keys are
  // unknown keys; missing, blank or oversized entries are text issues.
  text(value, path, limit) {
    if (!isObject(value)) return this.issue('POLICY_TEXT', path);
    let ok = this.keys(value, POLICY_LANGUAGES, [], path);
    const copy = {};
    for (const language of POLICY_LANGUAGES) {
      const entry = value[language];
      const languagePath = join(path, language);
      if (typeof entry !== 'string' || !entry.trim() || Array.from(entry).length > limit
          || CONTROL_CHARS.test(entry) || MARKUP.test(entry)) {
        ok = false;
        this.issue('POLICY_TEXT', languagePath);
        continue;
      }
      copy[language] = entry;
    }
    return ok ? copy : undefined;
  }

  list(value, limit, path) {
    if (!Array.isArray(value)) return this.issue('POLICY_FIELD', path) ?? null;
    if (value.length > limit) return this.issue('POLICY_RANGE', path) ?? null;
    return value;
  }
}

function validateEnumSetting(v, spec, value, path) {
  if (!v.object(value, ENUM_SETTING_KEYS, ENUM_SETTING_KEYS, path)) return undefined;
  const locked = v.boolean(value.locked, join(path, 'locked'));
  const defaultValue = v.oneOf(value.default, spec.values, join(path, 'default'), 'POLICY_RANGE');
  const allowedPath = join(path, 'allowed');
  let allowed;
  if (!Array.isArray(value.allowed)) v.issue('POLICY_FIELD', allowedPath);
  else if (value.allowed.length === 0 || value.allowed.length > spec.values.length) v.issue('POLICY_RANGE', allowedPath);
  else if (!unique(value.allowed)) v.issue('POLICY_FIELD', allowedPath);
  else {
    allowed = [];
    value.allowed.forEach((item, index) => {
      const accepted = v.oneOf(item, spec.values, join(allowedPath, index), 'POLICY_RANGE');
      if (accepted !== undefined) allowed.push(accepted);
    });
    if (allowed.length !== value.allowed.length) allowed = undefined;
  }
  if (locked === undefined || defaultValue === undefined || allowed === undefined) return undefined;
  if (!allowed.includes(defaultValue)) return v.issue('POLICY_CONFLICT', join(path, 'default'));
  return { default: defaultValue, allowed, locked };
}

function validateNumberSetting(v, spec, value, path) {
  if (!v.object(value, NUMBER_SETTING_KEYS, NUMBER_SETTING_KEYS, path)) return undefined;
  const locked = v.boolean(value.locked, join(path, 'locked'));
  const numbers = {};
  for (const key of ['default', 'min', 'max', 'step']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) numbers[key] = value[key];
    else v.issue('POLICY_FIELD', join(path, key));
  }
  if (locked === undefined || Object.keys(numbers).length !== 4) return undefined;
  const { min, max, step } = numbers;
  let ok = true;
  const range = (condition, key) => { if (!condition) { ok = false; v.issue('POLICY_RANGE', join(path, key)); } };
  range(min >= spec.min && min <= spec.max && onGrid(min, spec.min, spec.step), 'min');
  range(max >= spec.min && max <= spec.max && onGrid(max, spec.min, spec.step), 'max');
  range(step > 0 && step <= spec.max - spec.min && onGrid(step, 0, spec.step), 'step');
  if (!ok) return undefined;
  if (min > max) return v.issue('POLICY_CONFLICT', join(path, 'min'));
  if (!onGrid(max, min, step)) return v.issue('POLICY_RANGE', join(path, 'max'));
  if (numbers.default < min || numbers.default > max) return v.issue('POLICY_CONFLICT', join(path, 'default'));
  if (!onGrid(numbers.default, min, step)) return v.issue('POLICY_RANGE', join(path, 'default'));
  return { default: numbers.default, min, max, step, locked };
}

function validateSettings(v, value, path) {
  const names = Object.keys(REGISTERED_SETTINGS);
  if (!v.object(value, names, names, path)) return undefined;
  const settings = {};
  let ok = true;
  for (const name of names) {
    if (!Object.hasOwn(value, name)) continue;
    const spec = REGISTERED_SETTINGS[name];
    const entry = spec.kind === 'enum'
      ? validateEnumSetting(v, spec, value[name], join(path, name))
      : validateNumberSetting(v, spec, value[name], join(path, name));
    if (entry === undefined) ok = false;
    else settings[name] = entry;
  }
  if (!ok) return undefined;
  // Cross condition (§1.4): the default (and therefore any forced) source/target
  // pair must differ unless the source auto-detects. Because each default sits
  // inside its allowed list, this also guarantees at least one usable pair;
  // keeping a personal choice from selecting the same language twice is the
  // resolver's job (P3-05), not a schema failure.
  const source = settings['interpretation.sourceLanguage'];
  const target = settings['interpretation.targetLanguage'];
  if (source.default !== 'auto' && source.default === target.default) {
    return v.issue('POLICY_CONFLICT', join(path, 'interpretation.targetLanguage.default'));
  }
  return settings;
}

function validateFeatures(v, value, path) {
  if (!v.object(value, REGISTERED_FEATURES, REGISTERED_FEATURES, path)) return undefined;
  const features = {};
  for (const name of REGISTERED_FEATURES) {
    if (Object.hasOwn(value, name)) features[name] = v.boolean(value[name], join(path, name));
  }
  return REGISTERED_FEATURES.every((name) => typeof features[name] === 'boolean') ? features : undefined;
}

function validateEmergency(v, value, path) {
  if (!v.object(value, EMERGENCY_KEYS, EMERGENCY_KEYS, path)) return undefined;
  const stopped = v.boolean(value.stopped, join(path, 'stopped'));
  const reason = value.reason === null ? null : v.text(value.reason, join(path, 'reason'), POLICY_LIMITS.reasonChars);
  return stopped === undefined || reason === undefined ? undefined : { stopped, reason };
}

function validateNotices(v, value, path) {
  const items = v.list(value, POLICY_LIMITS.notices, path);
  if (!items) return undefined;
  const notices = [];
  const ids = new Set();
  items.forEach((item, index) => {
    const itemPath = join(path, index);
    if (!v.object(item, NOTICE_KEYS, NOTICE_KEYS, itemPath)) return;
    const id = v.identifier(item.id, join(itemPath, 'id'));
    if (id !== undefined && ids.has(id)) v.issue('POLICY_CONFLICT', join(itemPath, 'id'));
    if (id !== undefined) ids.add(id);
    const severity = v.oneOf(item.severity, NOTICE_SEVERITIES, join(itemPath, 'severity'));
    const showFrom = v.dateTime(item.showFrom, join(itemPath, 'showFrom'), { nullable: true });
    const showUntil = v.dateTime(item.showUntil, join(itemPath, 'showUntil'), { nullable: true });
    if (showFrom && showUntil && parseDateTime(showFrom) >= parseDateTime(showUntil)) {
      v.issue('POLICY_CONFLICT', join(itemPath, 'showUntil'));
    }
    const text = v.text(item.text, join(itemPath, 'text'), POLICY_LIMITS.textChars);
    notices.push({ id, severity, showFrom, showUntil, text });
  });
  return notices;
}

function validateEvents(v, value, path, { registeredProviderIds }) {
  const items = v.list(value, POLICY_LIMITS.events, path);
  if (!items) return undefined;
  const events = [];
  const ids = new Set();
  items.forEach((item, index) => {
    const itemPath = join(path, index);
    if (!v.object(item, EVENT_KEYS, EVENT_KEYS, itemPath)) return;
    const id = v.identifier(item.id, join(itemPath, 'id'));
    if (id !== undefined && ids.has(id)) v.issue('POLICY_CONFLICT', join(itemPath, 'id'));
    if (id !== undefined) ids.add(id);
    let providerId = v.identifier(item.providerId, join(itemPath, 'providerId'), PROVIDER_ID_PATTERN);
    if (providerId !== undefined && !registeredProviderIds.includes(providerId)) {
      providerId = v.issue('POLICY_REFERENCE', join(itemPath, 'providerId'));
    }
    const namePath = join(itemPath, 'eventName');
    const eventName = typeof item.eventName === 'string' && item.eventName.trim()
      && Array.from(item.eventName).length <= POLICY_LIMITS.eventNameChars
      && !CONTROL_CHARS.test(item.eventName) && !/[\n\r\t]/.test(item.eventName) && !MARKUP.test(item.eventName)
      ? item.eventName : v.issue('POLICY_FIELD', namePath);
    const label = v.text(item.label, join(itemPath, 'label'), POLICY_LIMITS.textChars);
    const startsAt = v.dateTime(item.startsAt, join(itemPath, 'startsAt'));
    const expiresAt = v.dateTime(item.expiresAt, join(itemPath, 'expiresAt'));
    if (startsAt && expiresAt && parseDateTime(startsAt) >= parseDateTime(expiresAt)) {
      v.issue('POLICY_CONFLICT', join(itemPath, 'expiresAt'));
    }
    const enabled = v.boolean(item.enabled, join(itemPath, 'enabled'));
    const capabilitiesPath = join(itemPath, 'allowedCapabilities');
    let allowedCapabilities;
    if (!Array.isArray(item.allowedCapabilities)) v.issue('POLICY_FIELD', capabilitiesPath);
    else if (item.allowedCapabilities.length === 0 || item.allowedCapabilities.length > EVENT_CAPABILITIES.length) v.issue('POLICY_RANGE', capabilitiesPath);
    else if (!unique(item.allowedCapabilities)) v.issue('POLICY_FIELD', capabilitiesPath);
    else {
      allowedCapabilities = item.allowedCapabilities.map((capability, position) =>
        v.oneOf(capability, EVENT_CAPABILITIES, join(capabilitiesPath, position), 'POLICY_REFERENCE'));
    }
    events.push({ id, providerId, eventName, label, startsAt, expiresAt, enabled, allowedCapabilities });
  });
  return events;
}

function validateHubControl(v, value, path, { registeredHubIds }) {
  if (!v.object(value, HUB_CONTROL_KEYS, HUB_CONTROL_KEYS, path)) return undefined;
  const enabled = v.boolean(value.enabled, join(path, 'enabled'));
  const allowDirectSubscription = v.boolean(value.allowDirectSubscription, join(path, 'allowDirectSubscription'));
  const idsPath = join(path, 'allowedHubIds');
  const items = v.list(value.allowedHubIds, POLICY_LIMITS.allowedHubIds, idsPath);
  let allowedHubIds;
  if (items && !unique(items)) v.issue('POLICY_FIELD', idsPath);
  else if (items) {
    allowedHubIds = items.map((id, index) => {
      const accepted = v.identifier(id, join(idsPath, index));
      return accepted !== undefined && !registeredHubIds.includes(accepted)
        ? v.issue('POLICY_REFERENCE', join(idsPath, index)) : accepted;
    });
  }
  if (enabled && allowedHubIds && allowedHubIds.length === 0) v.issue('POLICY_CONFLICT', idsPath);
  if (allowDirectSubscription && enabled === false) v.issue('POLICY_CONFLICT', join(path, 'allowDirectSubscription'));
  return { enabled, allowedHubIds, allowDirectSubscription };
}

function validatePricing(v, value, path) {
  if (!v.object(value, PRICING_KEYS, PRICING_KEYS, path)) return undefined;
  const revision = v.positiveInteger(value.revision, join(path, 'revision'));
  const updatedAt = v.dateTime(value.updatedAt, join(path, 'updatedAt'));
  const currency = v.identifier(value.currency, join(path, 'currency'), CURRENCY_PATTERN);
  const allowLocalOverride = v.boolean(value.allowLocalOverride, join(path, 'allowLocalOverride'));
  const ratesPath = join(path, 'rates');
  const items = v.list(value.rates, POLICY_LIMITS.rates, ratesPath);
  let rates;
  if (items) {
    rates = [];
    const seen = new Set();
    items.forEach((item, index) => {
      const itemPath = join(ratesPath, index);
      if (!v.object(item, RATE_KEYS, RATE_KEYS, itemPath)) return;
      const model = v.identifier(item.model, join(itemPath, 'model'), MODEL_PATTERN);
      const capability = v.oneOf(item.capability, CAPABILITIES, join(itemPath, 'capability'), 'POLICY_REFERENCE');
      if (model !== undefined && capability !== undefined) {
        const key = `${model}/${capability}`;
        if (seen.has(key)) v.issue('POLICY_CONFLICT', join(itemPath, 'model'));
        seen.add(key);
      }
      const unit = v.oneOf(item.unit, RATE_UNITS, join(itemPath, 'unit'));
      const amountPath = join(itemPath, 'amount');
      let amount;
      if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) v.issue('POLICY_FIELD', amountPath);
      else if (item.amount < 0 || item.amount > POLICY_LIMITS.maxAmount) v.issue('POLICY_RANGE', amountPath);
      else amount = item.amount + 0;
      const basis = v.oneOf(item.basis, RATE_BASES, join(itemPath, 'basis'));
      const confidence = v.oneOf(item.confidence, RATE_CONFIDENCES, join(itemPath, 'confidence'));
      const verifiedAt = v.dateTime(item.verifiedAt, join(itemPath, 'verifiedAt'));
      rates.push({ model, capability, unit, amount, basis, confidence, verifiedAt });
    });
  }
  return { revision, updatedAt, currency, allowLocalOverride, rates };
}

// Accept the JSON text (client, admin import) or an already parsed object
// (admin editor). Both are bounded by POLICY_LIMITS.bodyBytes.
function parseInput(v, input) {
  if (typeof input === 'string') {
    if (byteLength(input) > POLICY_LIMITS.bodyBytes) return v.issue('POLICY_TOO_LARGE', '');
    let parsed;
    try { parsed = JSON.parse(input); } catch { return v.issue('POLICY_SCHEMA', ''); }
    return isObject(parsed) ? parsed : v.issue('POLICY_SCHEMA', '');
  }
  if (!isObject(input)) return v.issue('POLICY_SCHEMA', '');
  let serialized;
  try { serialized = JSON.stringify(input); } catch { return v.issue('POLICY_SCHEMA', ''); }
  if (typeof serialized !== 'string') return v.issue('POLICY_SCHEMA', '');
  if (byteLength(serialized) > POLICY_LIMITS.bodyBytes) return v.issue('POLICY_TOO_LARGE', '');
  return input;
}

/**
 * validatePolicy(input, { registeredHubIds?, registeredProviderIds?, now? })
 * returns { ok: true, policy } or { ok: false, issues }. `policy` is a fresh,
 * deeply frozen copy holding only validated fields in canonical key order
 * (JSON.stringify of two equivalent policies is identical, which P3-06 may use
 * as the content identity for same-revision conflicts). `issues` is a frozen
 * list of { code, path }; codes are POLICY_ISSUE_CODES, paths are dotted such
 * as `settings.ui.tone.default`, and neither carries values from the input.
 * Validation is time independent: `now` is accepted for the documented
 * signature, but expiry of validUntil, notices and events is a runtime state
 * (P3-06/07), not a schema failure. The input is never mutated.
 */
export function validatePolicy(input, { registeredHubIds = REGISTERED_HUBS.map((hub) => hub.id),
  registeredProviderIds = REGISTERED_PROVIDER_IDS, now } = {}) {
  void now;
  const v = new Validation();
  const raw = parseInput(v, input);
  const finish = (policy) => (v.issues.length === 0 && policy
    ? Object.freeze({ ok: true, policy: deepFreeze(policy) })
    : Object.freeze({ ok: false, issues: Object.freeze(v.issues.map((issue) => Object.freeze(issue))) }));
  if (raw === undefined) return finish(null);
  if (raw.schemaVersion !== POLICY_SCHEMA_VERSION) {
    v.issue('POLICY_SCHEMA', 'schemaVersion');
    return finish(null);
  }
  if (!v.keys(raw, ROOT_KEYS, ROOT_KEYS, '')) return finish(null);
  const options = {
    registeredHubIds: Array.isArray(registeredHubIds) ? registeredHubIds : [],
    registeredProviderIds: Array.isArray(registeredProviderIds) ? registeredProviderIds : [],
  };

  const revision = v.positiveInteger(raw.revision, 'revision');
  const publishedAt = v.dateTime(raw.publishedAt, 'publishedAt');
  const validUntil = v.dateTime(raw.validUntil, 'validUntil', { nullable: true });
  if (publishedAt && validUntil && parseDateTime(validUntil) <= parseDateTime(publishedAt)) v.issue('POLICY_CONFLICT', 'validUntil');
  const minAppVersion = v.identifier(raw.minAppVersion, 'minAppVersion', APP_VERSION_PATTERN);
  const emergency = validateEmergency(v, raw.emergency, 'emergency');
  const features = validateFeatures(v, raw.features, 'features');
  const settings = validateSettings(v, raw.settings, 'settings');
  const notices = validateNotices(v, raw.notices, 'notices');
  const sharedEvents = validateEvents(v, raw.sharedEvents, 'sharedEvents', options);
  const hubControl = validateHubControl(v, raw.hubControl, 'hubControl', options);
  const pricing = validatePricing(v, raw.pricing, 'pricing');

  // Feature toggles must agree with what the rest of the policy enables (§1.4).
  if (features && sharedEvents && features.sharedKeys === false) {
    sharedEvents.forEach((event, index) => {
      if (event.enabled === true) v.issue('POLICY_CONFLICT', join(join('sharedEvents', index), 'enabled'));
    });
  }
  if (features && hubControl && hubControl.enabled === true && features.hubListen === false) {
    v.issue('POLICY_CONFLICT', 'hubControl.enabled');
  }

  return finish({
    schemaVersion: POLICY_SCHEMA_VERSION, revision, publishedAt, validUntil, minAppVersion,
    emergency, features, settings, notices, sharedEvents, hubControl, pricing,
  });
}
