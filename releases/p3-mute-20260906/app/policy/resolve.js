// New implementation of design-p3 §1.5-§1.6 and architecture.md "정책 모듈"
// (resolve.js, P3-05; P3-08 extends the event part); no legacy code is ported.
// One pure function turns a validated site policy, the user's own choices, the
// joined shared-key event and the hub live-control snapshot into effective
// values with their source and lock reason:
//
//   code support ∩ site policy ∩ event ∩ hub control
//     -> forced value -> allowed personal choice -> policy default -> app default
//
// It never writes to the preference store: personal choices are read only, so
// a later, wider policy restores them. Importing touches no browser globals,
// network or storage. Dictionary keys returned here are fixed literals or
// values from closed enumerations; nothing from the input is echoed.
import { POLICY_SCHEMA_VERSION, REGISTERED_FEATURES, REGISTERED_SETTINGS, compareVersions } from './schema.js';
import { CAPABILITIES } from '../providers/contract.js';
import { APP_VERSION } from '../version.js';
import { normalizePreference } from '../preferences.js';

export const SETTING_SOURCES = Object.freeze(['personal', 'policyDefault', 'forced', 'appDefault']);
// Whole-run block codes this resolver emits, in precedence order. They are the
// PolicyError codes of runtime.js (P3-07); the runtime adds POLICY_LOADING and
// EVENT_ENDED from its own state.
export const BLOCK_CODES = Object.freeze(['POLICY_UNAVAILABLE', 'POLICY_STOPPED', 'APP_VERSION_TOO_OLD',
  'POLICY_EXPIRED', 'HUB_CONTROL_STOPPED', 'HUB_CONTROL_LOST']);
// event.status.* dictionary keys (P3-02 enumeration).
export const EVENT_STATUSES = Object.freeze(['upcoming', 'active', 'expired', 'disabled', 'removed']);
// Code support a feature needs; a policy toggle cannot grant more (§1.4).
export const FEATURE_CAPABILITIES = Object.freeze({
  sequential: Object.freeze(['translate']), simultaneousDirect: Object.freeze(['live']),
  hubListen: Object.freeze([]), diagnostics: Object.freeze([]), sharedKeys: Object.freeze([]),
  rememberPersonalKey: Object.freeze([]),
});
// Every reasonKey this module can return (tests assert they exist in all languages).
export const REASON_KEYS = Object.freeze({
  forced: 'policy.lock.forced',
  restricted: 'policy.lock.restricted',
  singleOption: 'policy.lock.singleOption',
  featureOff: 'policy.featureOff',
  hubDisabled: 'hubControl.stopped',
  capabilityUnsupported: 'capability.unsupported',
  policyUnavailable: 'error.POLICY_UNAVAILABLE',
});

const EVENT_ID = /^[a-z0-9-]{1,64}$/;
const LANGUAGE_PAIR = Object.freeze(['interpretation.sourceLanguage', 'interpretation.targetLanguage']);

function deepFreeze(value) {
  if (Array.isArray(value)) { for (const item of value) deepFreeze(item); return Object.freeze(value); }
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); return Object.freeze(value); }
  return value;
}
const onGrid = (value, origin, step) => {
  const steps = (value - origin) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function timeOf(now) {
  const value = typeof now === 'function' ? now() : now;
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

// A validated policy is the frozen output of validatePolicy; anything else
// (null, a loading placeholder, an unknown schema) counts as unavailable.
function usablePolicy(policy) {
  return isObject(policy) && policy.schemaVersion === POLICY_SCHEMA_VERSION && isObject(policy.settings)
    && isObject(policy.features) && isObject(policy.emergency) ? policy : null;
}

function personalChoices(preferences) {
  if (preferences && typeof preferences.snapshot === 'function') return preferences.snapshot();
  return isObject(preferences) ? preferences : {};
}

function capabilitySet(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities : CAPABILITIES;
  return new Set(list.filter((capability) => CAPABILITIES.includes(capability)));
}

function rangeOf(spec, entry) {
  if (spec.kind === 'enum') return Object.freeze([...(entry ? entry.allowed : spec.values)]);
  return Object.freeze(entry ? { min: entry.min, max: entry.max, step: entry.step }
    : { min: spec.min, max: spec.max, step: spec.step });
}
function within(spec, entry, value) {
  if (spec.kind === 'enum') return entry.allowed.includes(value);
  return value >= entry.min && value <= entry.max && onGrid(value, entry.min, entry.step);
}
function narrower(spec, entry) {
  if (spec.kind === 'enum') return entry.allowed.length < spec.values.length;
  return entry.min > spec.min || entry.max < spec.max || entry.step > spec.step;
}
function singleOption(spec, entry) {
  return spec.kind === 'enum' ? entry.allowed.length === 1 : entry.min === entry.max;
}

// One setting: forced (locked or single option) > allowed personal choice >
// policy default > app default. The personal choice is read, never rewritten.
function resolveSetting(name, entry, choices) {
  const spec = REGISTERED_SETTINGS[name];
  const personal = Object.hasOwn(choices, name) ? normalizePreference(name, choices[name]) : null;
  const allowed = rangeOf(spec, entry);
  if (!entry) {
    return personal !== null
      ? { value: personal, source: 'personal', allowed, locked: false, reasonKey: null }
      : { value: spec.default, source: 'appDefault', allowed, locked: false, reasonKey: null };
  }
  if (entry.locked) return { value: entry.default, source: 'forced', allowed, locked: true, reasonKey: REASON_KEYS.forced };
  if (singleOption(spec, entry)) {
    return { value: entry.default, source: 'forced', allowed, locked: true, reasonKey: REASON_KEYS.singleOption };
  }
  const reasonKey = narrower(spec, entry) ? REASON_KEYS.restricted : null;
  if (personal !== null && within(spec, entry, personal)) {
    return { value: personal, source: 'personal', allowed, locked: false, reasonKey };
  }
  return { value: entry.default, source: 'policyDefault', allowed, locked: false, reasonKey };
}

// The pair may not name the same language twice unless the source auto-detects
// (schema.js leaves this personal-choice case to the resolver). A personal
// choice that collides drops back to the default, target first; defaults of a
// valid policy (and the app defaults) never collide, so this always settles.
function settleLanguagePair(settings, policy) {
  const [sourceName, targetName] = LANGUAGE_PAIR;
  const fallback = (name) => {
    const entry = policy?.settings[name];
    return entry
      ? { ...settings[name], value: entry.default, source: 'policyDefault' }
      : { ...settings[name], value: REGISTERED_SETTINGS[name].default, source: 'appDefault' };
  };
  const collides = () => settings[sourceName].value !== 'auto' && settings[sourceName].value === settings[targetName].value;
  if (collides() && settings[targetName].source === 'personal') settings[targetName] = fallback(targetName);
  if (collides() && settings[sourceName].source === 'personal') settings[sourceName] = fallback(sourceName);
}

function resolveFeatures(policy, hubControl, capabilities) {
  const disabledByHub = new Set(Array.isArray(hubControl?.disabledFeatures) ? hubControl.disabledFeatures : []);
  const features = {};
  for (const name of REGISTERED_FEATURES) {
    let reasonKey = null;
    if (!policy) reasonKey = REASON_KEYS.policyUnavailable;
    else if (!FEATURE_CAPABILITIES[name].every((capability) => capabilities.has(capability))) reasonKey = REASON_KEYS.capabilityUnsupported;
    else if (policy.features[name] !== true) reasonKey = REASON_KEYS.featureOff;
    else if (disabledByHub.has(name)) reasonKey = REASON_KEYS.hubDisabled;
    features[name] = { enabled: reasonKey === null, reasonKey };
  }
  return features;
}

// Joined shared-key event against the policy list (§1.4 shared events, §1.5
// "행사 목록 변경·만료·중지"). Live is never among the capabilities.
function resolveEvent(policy, event, capabilities, now) {
  if (event === null || event === undefined) return null;
  const id = typeof event === 'string' ? event : isObject(event) ? event.id : undefined;
  if (typeof id !== 'string' || !EVENT_ID.test(id)) return null;
  const entry = policy ? policy.sharedEvents.find((item) => item.id === id) : undefined;
  const ended = (status) => ({ id, status, providerId: entry?.providerId ?? null, expiresAt: entry?.expiresAt ?? null,
    allowedCapabilities: [], reasonKey: `event.status.${status}` });
  if (!entry) return ended('removed');
  if (policy.features.sharedKeys !== true || entry.enabled !== true) return ended('disabled');
  if (now < Date.parse(entry.startsAt)) return ended('upcoming');
  if (now >= Date.parse(entry.expiresAt)) return ended('expired');
  return { id, status: 'active', providerId: entry.providerId, expiresAt: entry.expiresAt,
    allowedCapabilities: entry.allowedCapabilities.filter((capability) => capability !== 'live' && capabilities.has(capability)),
    reasonKey: null };
}

function resolveBlocked(policy, hubControl, appVersion, now) {
  if (!policy) return { code: 'POLICY_UNAVAILABLE', revision: null };
  const revision = policy.revision;
  if (policy.emergency.stopped === true) return { code: 'POLICY_STOPPED', revision };
  if (compareVersions(appVersion, policy.minAppVersion) < 0) return { code: 'APP_VERSION_TOO_OLD', revision };
  if (typeof policy.validUntil === 'string' && now >= Date.parse(policy.validUntil)) return { code: 'POLICY_EXPIRED', revision };
  // Hub control only adds restrictions; a lost heartbeat or stop latch blocks
  // event execution and is never cleared here (§1.8).
  if (hubControl?.stopped === true) return { code: 'HUB_CONTROL_STOPPED', revision };
  if (hubControl?.heartbeatLost === true) return { code: 'HUB_CONTROL_LOST', revision };
  return null;
}

/**
 * resolveEffective({ policy, preferences, event, hubControl, capabilities, appVersion, now })
 * -> deeply frozen {
 *   blocked: null | { code, revision },
 *   settings: { [registered name]: { value, source, allowed, locked, reasonKey } },
 *   features: { [feature]: { enabled, reasonKey } },
 *   event: null | { id, status, providerId, expiresAt, allowedCapabilities, reasonKey },
 * }
 * `policy` is a validatePolicy() result (null while unavailable), `preferences`
 * a createPreferences() store or a plain { [name]: value } map of personal
 * choices, `event` the joined event ID (or { id }), `hubControl` the hub
 * control snapshot ({ stopped, heartbeatLost, disabledFeatures }),
 * `capabilities` the capabilities the code supports (default: all),
 * `appVersion` the running version and `now` epoch milliseconds or a clock.
 * `source` is personal | policyDefault | forced | appDefault; `allowed` is the
 * enum list or { min, max, step }; `reasonKey` is a dictionary key or null.
 * ui.language and audio.* are not policy settings and never appear here.
 * Inputs are never mutated and the preference store is never written.
 */
export function resolveEffective({ policy: input, preferences, event = null, hubControl = null,
  capabilities, appVersion = APP_VERSION, now } = {}) {
  const policy = usablePolicy(input);
  const time = timeOf(now);
  const choices = personalChoices(preferences);
  const supported = capabilitySet(capabilities);
  const settings = {};
  for (const name of Object.keys(REGISTERED_SETTINGS)) {
    settings[name] = resolveSetting(name, policy ? policy.settings[name] : undefined, choices);
  }
  settleLanguagePair(settings, policy);
  return deepFreeze({
    blocked: resolveBlocked(policy, hubControl, appVersion, time),
    settings,
    features: resolveFeatures(policy, hubControl, supported),
    event: resolveEvent(policy, event, supported, time),
  });
}
