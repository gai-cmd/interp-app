// Runtime appearance sync (design-p3 §1.5 "톤·글자 크기 변경 → 화면만 갱신",
// §1.10, DESIGN.md §10, architecture.md "표시 설정", P3-14). New implementation;
// nothing is ported from interp-web or jp-patch.
//
// One path applies the display settings after the first paint:
//
//   personal choice (app/preferences.js) + site policy (app/policy/runtime.js)
//     -> resolveEffective (P3-05) -> apply() -> <html data-mode|data-tone|data-text>
//
// The boot script (app/ui/appearance-boot.js, P3-13) restored the personal
// choice before the stylesheet loaded; this module re-applies the effective
// values once the policy is known and keeps them in step with policy changes,
// the user's own changes, save failures (the store keeps the value in memory
// for this run, so the page still follows it) and another tab's changes (the
// composition root forwards `storage` events to preferences.sync()). The
// value interpretation is shared with the boot script: a stored or given value
// that is not an accepted enum member reads as the registered default.
//
// System mode: `system` removes data-mode so the prefers-color-scheme rule in
// styles.css applies, `light` and `dark` set the attribute explicitly; the
// dark media rule excludes [data-mode="light"], so a forced light mode is not
// overridden by a dark system setting. The media query is watched only to
// report the resolved mode (the display preview) — the cascade itself needs
// no script when the system scheme changes.
//
// Importing touches no browser globals; document and matchMedia are injected.
// Nothing is logged and no dictionary text is produced here: reasons are codes
// (SET_FAILURES) and the resolver's reasonKey.
import { REGISTERED_SETTINGS } from '../policy/schema.js';
import { normalizePreference } from '../preferences.js';
import { resolveEffective } from '../policy/resolve.js';

// The three display settings this module owns (captions.size is the caption
// board's own control, P3-18) and the <html> attribute each one drives.
export const APPEARANCE_SETTINGS = Object.freeze(['ui.mode', 'ui.tone', 'ui.text']);
export const APPEARANCE_ATTRIBUTES = Object.freeze({ 'ui.mode': 'data-mode', 'ui.tone': 'data-tone', 'ui.text': 'data-text' });
export const SYSTEM_MODE = 'system';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
// set() failure reasons: not an accepted value (or no store to write to),
// locked by policy, outside the policy's allowed range. A name this module
// does not own throws INVALID_REQUEST instead.
export const SET_FAILURES = Object.freeze(['invalid', 'locked', 'restricted']);

const invalid = () => { throw new TypeError('INVALID_REQUEST'); };
const isObject = (value) => value !== null && typeof value === 'object';
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

function assertName(name) {
  if (!APPEARANCE_SETTINGS.includes(name)) invalid();
  return name;
}

/**
 * The one value interpretation the boot script and this runtime share: an
 * accepted enum member is kept, anything else (null, corrupt text, a value
 * from another enum) reads as the registered default. Never throws for values.
 */
export function interpretAppearance(name, value) {
  assertName(name);
  return normalizePreference(name, value) ?? REGISTERED_SETTINGS[name].default;
}

/**
 * <html> attributes for a set of values keyed by setting name. Entries may be
 * plain values or resolver entries ({ value, ... }); missing or invalid ones
 * fall back to the defaults. data-mode is null for `system` (attribute removed).
 */
export function attributesFor(values = {}) {
  const attributes = {};
  for (const name of APPEARANCE_SETTINGS) {
    const entry = isObject(values) && Object.hasOwn(values, name) ? values[name] : null;
    const value = interpretAppearance(name, isObject(entry) && Object.hasOwn(entry, 'value') ? entry.value : entry);
    attributes[APPEARANCE_ATTRIBUTES[name]] = name === 'ui.mode' && value === SYSTEM_MODE ? null : value;
  }
  return Object.freeze(attributes);
}

/** 'dark' | 'light' from a media query list (or a change event), null when unknown. */
export function systemModeOf(query) {
  if (!isObject(query) || typeof query.matches !== 'boolean') return null;
  return query.matches ? 'dark' : 'light';
}

/** The mode the page actually renders in: a forced mode, else the system one (light when unknown). */
export function resolvedModeOf(mode, system) {
  const value = interpretAppearance('ui.mode', mode);
  if (value !== SYSTEM_MODE) return value;
  return system === 'dark' ? 'dark' : 'light';
}

/**
 * createAppearance({ document, matchMedia?, preferences?, runtime?, now? })
 * returns frozen { snapshot(), subscribe(fn), apply(effectiveSettings?),
 * set(name, value), reset(name), destroy() }.
 *
 * - `document` must expose documentElement; only its data-mode/data-tone/
 *   data-text attributes are written, and only when they differ.
 * - `runtime` is createPolicyRuntime()'s result: its snapshot().settings are
 *   the effective values and every emission re-applies them. Without a
 *   runtime (the administrator page) the effective values are resolved from
 *   the personal choices alone and the store is followed directly.
 * - `preferences` is createPreferences()'s store; set()/reset() write the
 *   personal choice there and never an effective value. set() refuses a value
 *   the policy locks or excludes ({ ok: false, reason, reasonKey }) without
 *   touching storage; a rejected write still applies (memory copy) and reports
 *   persisted: false.
 * - `matchMedia` (bound) is watched for the dark scheme; a change updates
 *   snapshot().system / resolvedMode and notifies subscribers.
 * - snapshot() -> frozen { values, attributes, settings, choices, system,
 *   resolvedMode, persisted }; subscribe(fn) receives the snapshot after each
 *   change. destroy() releases every subscription and leaves <html> as it is.
 */
export function createAppearance({ document: doc, matchMedia = null, preferences = null, runtime = null, now = Date.now } = {}) {
  const root = attempt(() => doc?.documentElement) ?? null;
  if (!root || typeof root.setAttribute !== 'function' || typeof root.removeAttribute !== 'function'
    || typeof root.getAttribute !== 'function') invalid();
  if (preferences !== null && (!isObject(preferences) || typeof preferences.get !== 'function' || typeof preferences.set !== 'function')) invalid();
  if (runtime !== null && (!isObject(runtime) || typeof runtime.snapshot !== 'function' || typeof runtime.subscribe !== 'function')) invalid();
  if (typeof now !== 'function') invalid();

  const listeners = new Set();
  const removers = [];
  let destroyed = false;
  let values = null;
  let system = null;
  // The store's `persisted` flag recovers on the next successful read; the UI
  // needs to know whether the last write of this run actually reached storage.
  let writeFailed = false;
  const persisted = () => preferences !== null && preferences.persisted === true && !writeFailed;

  // Effective entries for the three names: the runtime's resolution, or the
  // resolver over the personal choices alone when no runtime is given.
  function effective() {
    const settings = runtime ? runtime.snapshot().settings : resolveEffective({ policy: null, preferences, now }).settings;
    const picked = {};
    for (const name of APPEARANCE_SETTINGS) picked[name] = settings[name];
    return picked;
  }

  function write(attributes) {
    let changed = false;
    for (const [attribute, value] of Object.entries(attributes)) {
      const current = attempt(() => root.getAttribute(attribute)) ?? null;
      if (current === value) continue;
      changed = true;
      // A read-only or detached root must not break the app; the next apply retries.
      attempt(() => { if (value === null) root.removeAttribute(attribute); else root.setAttribute(attribute, value); });
    }
    return changed;
  }

  function snapshot() {
    const choices = {};
    for (const name of APPEARANCE_SETTINGS) choices[name] = preferences ? attempt(() => preferences.get(name)) ?? null : null;
    return Object.freeze({
      values,
      attributes: attributesFor(values),
      settings: Object.freeze(effective()),
      choices: Object.freeze(choices),
      system,
      resolvedMode: resolvedModeOf(values['ui.mode'], system),
      persisted: persisted(),
    });
  }

  function emit() {
    if (destroyed) return;
    const state = snapshot();
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* Consumer-owned failure. */ }
    }
  }

  // Apply effective settings (default: the current ones) to <html>. Returns
  // the applied values. Attributes are written only when they differ, so the
  // boot script's first paint is not rewritten needlessly.
  function apply(settings) {
    const source = settings === undefined ? effective() : settings;
    const attributes = attributesFor(source);
    const next = {};
    for (const name of APPEARANCE_SETTINGS) {
      const entry = isObject(source) && Object.hasOwn(source, name) ? source[name] : null;
      next[name] = interpretAppearance(name, isObject(entry) && Object.hasOwn(entry, 'value') ? entry.value : entry);
    }
    write(attributes);
    values = Object.freeze(next);
    return values;
  }

  // Every upstream change re-applies and notifies: the lock state may change
  // even when the values do not, and the UI shows both.
  let generation = 0;
  function follow() {
    if (destroyed) return;
    generation += 1;
    apply();
    emit();
  }
  // A write normally reaches follow() through the runtime's (or the store's)
  // synchronous subscription; when it did not, apply once here so the result
  // is deterministic without notifying twice.
  function afterWrite(before) {
    if (generation === before) follow();
  }

  function set(name, value) {
    assertName(name);
    const accepted = normalizePreference(name, value);
    const entry = effective()[name];
    const refuse = (reason) => Object.freeze({ ok: false, reason, reasonKey: entry?.reasonKey ?? null, persisted: persisted() });
    if (accepted === null) return refuse('invalid');
    if (entry?.locked === true) return refuse('locked');
    if (Array.isArray(entry?.allowed) && !entry.allowed.includes(accepted)) return refuse('restricted');
    if (!preferences) return refuse('invalid');
    const before = generation;
    const result = preferences.set(name, accepted);
    if (!result.ok) return refuse('invalid');
    afterWrite(before);
    return Object.freeze({ ok: true, reason: null, reasonKey: null, persisted: result.persisted === true, value: accepted });
  }

  function reset(name) {
    assertName(name);
    if (!preferences) return Object.freeze({ ok: false, persisted: false });
    const before = generation;
    const result = preferences.remove(name);
    afterWrite(before);
    return Object.freeze({ ok: true, persisted: result.persisted === true });
  }

  // First application before any subscription can fire.
  apply();

  // System scheme: the query object is the source of truth, the change event
  // only says when to look again.
  const query = typeof matchMedia === 'function' ? attempt(() => matchMedia(DARK_SCHEME_QUERY)) ?? null : null;
  system = systemModeOf(query);
  if (query) {
    const onChange = (event) => {
      if (destroyed) return;
      const next = systemModeOf(event) ?? systemModeOf(query);
      if (next === system) return;
      system = next;
      emit();
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      removers.push(() => attempt(() => query.removeEventListener('change', onChange)));
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      removers.push(() => attempt(() => query.removeListener?.(onChange)));
    }
  }

  // With a runtime the store's changes arrive through the runtime's own
  // subscription (it recomputes on every store event); the store is still
  // watched here for the write outcome.
  if (runtime) removers.push(runtime.subscribe(follow));
  if (preferences && typeof preferences.subscribe === 'function') {
    removers.push(preferences.subscribe((event) => {
      if (destroyed) return;
      if (event.type !== 'sync') writeFailed = event.persisted !== true;
      if (!runtime) follow();
    }));
  }

  return Object.freeze({
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') invalid();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply(settings) {
      if (destroyed) return values;
      const applied = apply(settings);
      emit();
      return applied;
    },
    set,
    reset,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removers.splice(0)) attempt(remove);
      listeners.clear();
    },
  });
}
