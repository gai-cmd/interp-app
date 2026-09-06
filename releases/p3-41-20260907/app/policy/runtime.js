// New implementation of design-p3 §1.5-§1.6 and architecture.md "정책 모듈"
// (runtime.js, P3-07); no legacy code is ported. The runtime is the central
// policy service the composition root consults before every execution path,
// inside and outside the UI:
//
//   client snapshot (P3-06) + personal choices (P3-05) + joined event + hub control
//     -> resolveEffective (P3-05) -> { blocked, features, settings, event }
//     -> assertAction(kind) / assertRoute(route) throw PolicyError when blocked
//     -> a restrictive policy change closes the app activity slot, the Live
//        slot and the composition root's stopWork() path; a wider policy only
//        reopens the gate and never starts anything.
//
// Importing touches no browser globals, network or storage. Snapshots are
// frozen, carry validated policy data and codes only, and never a key, a QR
// payload or a response body. Cleanup failures are recorded, never hidden:
// the runtime never releases a Live or activity slot on its own.
import { resolveEffective } from './resolve.js';
import { REGISTERED_FEATURES, REGISTERED_SETTINGS } from './schema.js';
import { CAPABILITIES } from '../providers/contract.js';
import { APP_VERSION } from '../version.js';

// PolicyError codes (architecture.md P3-01 table). Not part of ERROR_CODES:
// views render error.<CODE> through errorCodeKey(), never through redact().
import { PolicyError } from './errors.js';
export { PolicyError, POLICY_ERROR_CODES, isPolicyError } from './errors.js';
// Action kinds (architecture.md P3-01): seq.start | seq.retry | seq.replay |
// diagnostics | sim.direct | hub.join | event.join. They are composed rather
// than written as dotted literals because the i18n regression scans app
// sources for 'seq.*' / 'sim.*' / 'hub.*' literals as dictionary keys.
const kind = (scope, action) => (action === null ? scope : `${scope}.${action}`);
export const ACTIONS = Object.freeze({ seqStart: kind('seq', 'start'), seqRetry: kind('seq', 'retry'), seqReplay: kind('seq', 'replay'),
  diagnostics: kind('diagnostics', null), simDirect: kind('sim', 'direct'), hubJoin: kind('hub', 'join'), eventJoin: kind('event', 'join') });
export const ACTION_KINDS = Object.freeze(Object.values(ACTIONS));
// The policy feature each action needs (§1.4 features).
export const ACTION_FEATURES = Object.freeze({
  [ACTIONS.seqStart]: 'sequential', [ACTIONS.seqRetry]: 'sequential', [ACTIONS.seqReplay]: 'sequential',
  [ACTIONS.diagnostics]: 'diagnostics', [ACTIONS.simDirect]: 'simultaneousDirect', [ACTIONS.hubJoin]: 'hubListen',
  [ACTIONS.eventJoin]: 'sharedKeys',
});
// Features that may legitimately call a capability through the router (§1.6
// "제공자 router 경계"); a capability with no enabled feature is refused.
export const CAPABILITY_FEATURES = Object.freeze({
  translate: Object.freeze(['sequential', 'diagnostics']), stt: Object.freeze(['sequential', 'diagnostics']),
  voice: Object.freeze(['sequential', 'diagnostics']), live: Object.freeze(['simultaneousDirect', 'diagnostics']),
});
// Effective settings whose forced change ends an interpretation in progress
// (§1.5 "기능·언어·키 허용 범위 축소"); display settings only redraw.
export const RUN_SETTINGS = Object.freeze(['interpretation.sourceLanguage', 'interpretation.targetLanguage', 'voice.output']);
export const DISPLAY_SETTINGS = Object.freeze(['ui.mode', 'ui.tone', 'ui.text', 'captions.size']);
// Which features the current app activity (createActivity kinds) depends on.
// null is a sequential turn or idle: sequential turns hold no activity lease.
export const ACTIVITY_FEATURES = Object.freeze({
  seq: Object.freeze(['sequential']), sim: Object.freeze(['simultaneousDirect']), hub: Object.freeze(['hubListen']),
  diagnostics: Object.freeze(['diagnostics']), preview: Object.freeze(['sequential']),
});
const RUN_SETTING_KINDS = Object.freeze([null, 'seq', 'sim', 'preview']);
export const CHANGE_TYPES = Object.freeze(['initial', 'stopped', 'reopened', 'display', 'pricing', 'updated', 'status',
  'preference', 'event', 'hubControl']);
export const CLEANUP_STATES = Object.freeze(['idle', 'running', 'failed']);
export const REFRESH_REASONS = Object.freeze(['foreground', 'preflight', 'manual']);

const invalid = () => { throw new TypeError('POLICY_RUNTIME_INVALID'); };
const isFunction = (value) => typeof value === 'function';
const isObject = (value) => value !== null && typeof value === 'object';
const EVENT_ID = /^[a-z0-9-]{1,64}$/;

function deepFreeze(value) {
  if (Array.isArray(value)) { for (const item of value) deepFreeze(item); return Object.freeze(value); }
  if (isObject(value) && !Object.isFrozen(value)) { for (const item of Object.values(value)) deepFreeze(item); return Object.freeze(value); }
  return value;
}
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item) => b.includes(item));
// Widening is a strict superset of the previous range: swapping one set for
// another of the same size is a plain revision (design-p3 §정책 적용 "확대"),
// and any narrowing on one side cancels a widening on the other.
function widened(spec, before, after) {
  if (spec.kind === 'enum') {
    return before.allowed.every((value) => after.allowed.includes(value))
      && after.allowed.some((value) => !before.allowed.includes(value));
  }
  const narrowed = after.allowed.min > before.allowed.min || after.allowed.max < before.allowed.max || after.allowed.step > before.allowed.step;
  return !narrowed && (after.allowed.min < before.allowed.min || after.allowed.max > before.allowed.max || after.allowed.step < before.allowed.step);
}
// Only a hub-control snapshot's documented fields are kept (P3-10 shape).
function hubControlOf(value) {
  if (!isObject(value)) return null;
  return deepFreeze({ supported: value.supported === true, eventId: typeof value.eventId === 'string' ? value.eventId : null,
    epoch: Number.isSafeInteger(value.epoch) ? value.epoch : null, revision: Number.isSafeInteger(value.revision) ? value.revision : null,
    stopped: value.stopped === true, heartbeatLost: value.heartbeatLost === true,
    disabledFeatures: Array.isArray(value.disabledFeatures) ? value.disabledFeatures.filter((name) => REGISTERED_FEATURES.includes(name)) : [],
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null });
}

/**
 * createPolicyRuntime({ client, preferences, activity, sessionManager, now, stopWork?, appVersion?, capabilities? })
 * returns frozen { snapshot(), subscribe(fn), assertAction(kind), assertRoute(route),
 * refresh({ reason }), setEvent(id), setHubControl(snapshot), close(), appVersion }.
 *
 * - `client` is createPolicyClient()'s result; `preferences` createPreferences()'s
 *   (or a plain choices map); `activity` createActivity()'s; `sessionManager`
 *   createSessionManager()'s; `now` returns epoch milliseconds.
 * - `stopWork` (optional) is the composition root's existing cleanup path; the
 *   runtime calls it, plus activity.close() and sessionManager.close() while
 *   they are occupied, on every restrictive change. It never forces a slot free:
 *   a rejected cleanup leaves snapshot().cleanup === 'failed'.
 * - snapshot() -> frozen { status, revision, fetchedAt, error, policy, blocked,
 *   settings, features, event, eventId, hubControl, cleanup, appVersion }.
 *   `blocked` is null or { code, revision } with code in POLICY_ERROR_CODES
 *   (POLICY_LOADING before the first reply); settings/features/event are the
 *   resolveEffective() results.
 * - assertAction(kind) (ACTION_KINDS) and assertRoute({ providerId, capability,
 *   keySource, transport }) throw PolicyError synchronously, so callers can
 *   check inside the user gesture. A stale, failed or expired policy also kicks
 *   off a background refresh({ reason: 'preflight' }) (§1.5 "시작 직전").
 * - subscribe(fn) receives (snapshot, change) after each recomputation; change
 *   is frozen { type, stop, reopened, display, pricing, revisionChanged } with
 *   type in CHANGE_TYPES. A wider policy only sets reopened: nothing restarts.
 * - setEvent(id | null) records the joined shared-key event (P3-08 binds the
 *   key store to it); setHubControl(snapshot | null) feeds the P3-10 control
 *   state. Both recompute and may stop work like a policy change.
 */
export function createPolicyRuntime({ client, preferences = null, activity, sessionManager, now = () => Date.now(),
  stopWork = null, appVersion = APP_VERSION, capabilities = CAPABILITIES } = {}) {
  if (!isObject(client) || !isFunction(client.snapshot) || !isFunction(client.subscribe) || !isFunction(client.refresh)) invalid();
  if (preferences !== null && !isObject(preferences)) invalid();
  if (!isObject(activity) || !isFunction(activity.close) || !isFunction(activity.snapshot)) invalid();
  if (!isObject(sessionManager) || !isFunction(sessionManager.close)) invalid();
  if (!isFunction(now) || (stopWork !== null && !isFunction(stopWork))) invalid();
  const listeners = new Set();
  let eventId = null, hubControl = null, cleanup = 'idle', closed = false;
  let cached = null, cachedClient = null, cachedTime = null, version = 0, cachedVersion = -1;
  let last = null;

  function compute() {
    const state = client.snapshot();
    const effective = resolveEffective({ policy: state.policy, preferences, event: eventId, hubControl, capabilities, appVersion, now });
    let blocked = effective.blocked;
    // No authority yet: the first reply is pending (loading) or failed / too old.
    if (state.policy === null || blocked?.code === 'POLICY_UNAVAILABLE') {
      blocked = { code: state.status === 'loading' ? 'POLICY_LOADING' : 'POLICY_UNAVAILABLE', revision: state.revision };
    }
    return deepFreeze({ status: state.status, revision: state.revision, fetchedAt: state.fetchedAt, error: state.error,
      policy: state.policy, blocked, settings: effective.settings, features: effective.features, event: effective.event,
      eventId, hubControl, cleanup, appVersion });
  }
  // Same reference while nothing changed (client snapshots keep identity too);
  // time is part of the key because event and expiry states are clock derived.
  function current() {
    const state = client.snapshot();
    const time = now();
    if (cached && cachedClient === state && cachedVersion === version && cachedTime === time) return cached;
    cached = compute();
    cachedClient = state;
    cachedVersion = version;
    cachedTime = time;
    return cached;
  }

  function diff(prev, next, activeKind) {
    const change = { type: 'status', stop: false, reopened: false, display: false, pricing: false, revisionChanged: false };
    if (prev.revision === null && next.revision !== null) { change.type = 'initial'; return change; }
    change.revisionChanged = prev.revision !== next.revision;
    const affected = new Set(Object.hasOwn(ACTIVITY_FEATURES, activeKind) ? ACTIVITY_FEATURES[activeKind] : ['sequential']);
    if (next.blocked !== null && next.blocked.code !== prev.blocked?.code) change.stop = true;
    if (prev.blocked !== null && next.blocked === null) change.reopened = true;
    for (const name of REGISTERED_FEATURES) {
      const was = prev.features[name].enabled, is = next.features[name].enabled;
      if (was && !is && affected.has(name)) change.stop = true;
      if (!was && is) change.reopened = true;
    }
    for (const name of Object.keys(REGISTERED_SETTINGS)) {
      const before = prev.settings[name], after = next.settings[name];
      const changed = before.value !== after.value;
      if (RUN_SETTINGS.includes(name) && changed && RUN_SETTING_KINDS.includes(activeKind ?? null)) change.stop = true;
      if (DISPLAY_SETTINGS.includes(name) && changed) change.display = true;
      if ((before.locked && !after.locked) || widened(REGISTERED_SETTINGS[name], before, after)) change.reopened = true;
    }
    if (prev.event?.status === 'active' && next.event?.status !== 'active' && next.eventId !== null) change.stop = true;
    if (prev.policy && next.policy && prev.policy.pricing.revision !== next.policy.pricing.revision) change.pricing = true;
    if (change.stop) change.type = 'stopped';
    else if (change.reopened) change.type = 'reopened';
    else if (change.display) change.type = 'display';
    else if (change.pricing) change.type = 'pricing';
    else if (change.revisionChanged) change.type = 'updated';
    return change;
  }

  // Close the gate first (the snapshot already says blocked), then cancel
  // active work synchronously through the owners' own cleanup paths so late
  // results are invalidated at once; never force a slot free.
  const begin = (fn) => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
  function stopAll() {
    const tasks = [];
    if (activity.occupied === true || activity.snapshot().occupied === true) tasks.push(begin(() => activity.close()));
    if (sessionManager.occupied === true) tasks.push(begin(() => sessionManager.close()));
    if (stopWork) tasks.push(begin(stopWork));
    if (tasks.length === 0) return Promise.resolve();
    cleanup = 'running';
    version++;
    return Promise.allSettled(tasks).then((results) => {
      cleanup = results.some((result) => result.status === 'rejected') ? 'failed' : 'idle';
      version++;
      emit({ type: 'status', stop: false, reopened: false, display: false, pricing: false, revisionChanged: false });
    });
  }

  function emit(change) {
    if (closed) return;
    const snapshot = current();
    last = snapshot;
    const frozen = Object.freeze({ ...change });
    for (const listener of [...listeners]) {
      try { listener(snapshot, frozen); } catch { /* Consumer-owned failure. */ }
    }
  }
  function recompute(source) {
    if (closed) return;
    const prev = last ?? current();
    version++;
    const next = current();
    if (source === 'preference') { emit({ type: 'preference', stop: false, reopened: false, display: false, pricing: false, revisionChanged: false }); return; }
    const change = diff(prev, next, activity.snapshot().kind ?? null);
    if (change.type === 'status' && source !== 'client') change.type = source;
    if (change.stop) stopAll().catch(() => {});
    emit(change);
  }

  last = current();
  const unsubscribeClient = client.subscribe(() => recompute('client'));
  const unsubscribePreferences = isFunction(preferences?.subscribe) ? preferences.subscribe(() => recompute('preference')) : () => {};

  function fail(code) { throw new PolicyError(code); }
  function base(snapshot) {
    if (closed) fail('POLICY_UNAVAILABLE');
    if (snapshot.status !== 'ready' && snapshot.status !== 'loading') {
      // Fire and forget: the gate answers now from the current snapshot.
      try { Promise.resolve(client.refresh({ reason: 'preflight' })).catch(() => {}); } catch { /* Client owns its errors. */ }
    }
    if (snapshot.blocked !== null) fail(snapshot.blocked.code);
  }

  return Object.freeze({
    appVersion,
    snapshot: () => current(),
    subscribe(listener) {
      if (!isFunction(listener)) invalid();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    assertAction(kind) {
      if (!ACTION_KINDS.includes(kind)) invalid();
      const snapshot = current();
      base(snapshot);
      if (!snapshot.features[ACTION_FEATURES[kind]].enabled) fail('POLICY_FEATURE_DISABLED');
      if (kind === ACTIONS.eventJoin && (snapshot.event === null || snapshot.event.status !== 'active')) fail('EVENT_ENDED');
      return snapshot;
    },
    // Router boundary (§1.6): capability and key source against the policy.
    assertRoute({ providerId, capability, keySource } = {}) {
      const snapshot = current();
      base(snapshot);
      if (!Object.hasOwn(CAPABILITY_FEATURES, capability)) fail('POLICY_FEATURE_DISABLED');
      if (!CAPABILITY_FEATURES[capability].some((name) => snapshot.features[name].enabled)) fail('POLICY_FEATURE_DISABLED');
      if (keySource === 'shared') {
        if (!snapshot.features.sharedKeys.enabled) fail('POLICY_FEATURE_DISABLED');
        if (snapshot.eventId !== null) {
          if (snapshot.event === null || snapshot.event.status !== 'active') fail('EVENT_ENDED');
          if (snapshot.event.providerId !== providerId || !snapshot.event.allowedCapabilities.includes(capability)) fail('POLICY_FEATURE_DISABLED');
        }
      }
      return snapshot;
    },
    refresh({ reason = 'manual' } = {}) {
      if (!REFRESH_REASONS.includes(reason)) invalid();
      if (closed) return Promise.resolve(current());
      return Promise.resolve(client.refresh({ reason })).then(() => current(), () => current());
    },
    setEvent(id) {
      const next = id === null || id === undefined ? null : typeof id === 'string' && EVENT_ID.test(id) ? id : invalid();
      if (next === eventId) return current();
      eventId = next;
      recompute('event');
      return current();
    },
    setHubControl(snapshot) {
      hubControl = hubControlOf(snapshot);
      recompute('hubControl');
      return current();
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribeClient();
      unsubscribePreferences();
      listeners.clear();
    },
  });
}
