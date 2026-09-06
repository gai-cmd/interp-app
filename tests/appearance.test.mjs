import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  APPEARANCE_ATTRIBUTES, APPEARANCE_SETTINGS, DARK_SCHEME_QUERY, SET_FAILURES, SYSTEM_MODE,
  attributesFor, createAppearance, interpretAppearance, resolvedModeOf, systemModeOf,
} from '../app/ui/appearance.js';
import { REGISTERED_SETTINGS } from '../app/policy/schema.js';
import { DISPLAY_SETTINGS, createPolicyRuntime } from '../app/policy/runtime.js';
import { createPolicyClient } from '../app/policy/client.js';
import { REASON_KEYS } from '../app/policy/resolve.js';
import { PREFERENCE_NAMES, createPreferences, nameForStorageKey, storageKeyFor } from '../app/preferences.js';
import { UI_LANGUAGE_STORAGE_KEY } from '../app/main.js';
import { ENTRY_BOOT_FILE } from '../scripts/stage-release.mjs';
import { examplePolicy, policyWith, serialized } from './fixtures/policy.mjs';
import { createClock, policyResponse, scriptedFetch, settle } from './fixtures/policy-fetch.mjs';
import { boot, scenarioPolicy, tick, until } from './fixtures/scenarios.mjs';

// P3-14: one runtime path applies the effective display settings (personal
// choice ∩ policy) to <html> after the first paint and follows the system
// scheme, policy restrictions, save failures and another tab's changes; its
// value interpretation is the boot script's (P3-13).

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const bootSource = await read(ENTRY_BOOT_FILE);
const css = await read('styles.css');
const KEYS = Object.freeze(Object.fromEntries(APPEARANCE_SETTINGS.map((name) => [name, storageKeyFor(name)])));
const DEFAULT_ATTRIBUTES = Object.freeze({ 'data-mode': null, 'data-tone': 'navy', 'data-text': 'm' });
const MODES = REGISTERED_SETTINGS['ui.mode'].values, TONES = REGISTERED_SETTINGS['ui.tone'].values, TEXTS = REGISTERED_SETTINGS['ui.text'].values;
const CORRUPT = ['Dark', ' dark', 'dark ', '', 'auto', 'null', 'undefined', 'x', '1', '{"v":"dark"}', 'navy', 'm', 'xl', 'system', 'light',
  '__proto__', 'constructor', 'toString'];

// <html> double: records writes so "only when different" can be asserted.
function fakeRoot(initial = {}) {
  const attributes = new Map(Object.entries(initial));
  const writes = [];
  return {
    attributes, writes,
    setAttribute(name, value) { writes.push(['set', name, String(value)]); attributes.set(name, String(value)); },
    removeAttribute(name) { writes.push(['remove', name]); attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
}
const attributesOf = (root) => Object.freeze({
  'data-mode': root.getAttribute('data-mode'), 'data-tone': root.getAttribute('data-tone'), 'data-text': root.getAttribute('data-text') });
const documentWith = (root) => ({ documentElement: root });

function fakeStorage(initial = {}, { failing = new Set() } = {}) {
  const map = new Map(Object.entries(initial));
  const calls = [];
  const fail = (method) => { if (failing.has(method)) throw new Error('QuotaExceededError'); };
  return {
    map, calls, failing,
    getItem(key) { calls.push(['getItem', key]); fail('getItem'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { calls.push(['setItem', key, value]); fail('setItem'); map.set(key, String(value)); },
    removeItem(key) { calls.push(['removeItem', key]); fail('removeItem'); map.delete(key); },
  };
}

// matchMedia double: one query list per media string, changed by the test.
function fakeMatchMedia({ dark = false, legacy = false } = {}) {
  const lists = new Map();
  const matchMedia = (media) => {
    if (!lists.has(media)) {
      const listeners = new Set();
      const list = { media, matches: media === DARK_SCHEME_QUERY ? dark : false, listeners };
      if (legacy) {
        list.addListener = (fn) => listeners.add(fn);
        list.removeListener = (fn) => listeners.delete(fn);
      } else {
        list.addEventListener = (type, fn) => { assert.equal(type, 'change'); listeners.add(fn); };
        list.removeEventListener = (type, fn) => listeners.delete(fn);
      }
      lists.set(media, list);
    }
    return lists.get(media);
  };
  return {
    matchMedia, lists,
    get query() { return lists.get(DARK_SCHEME_QUERY); },
    setDark(value) {
      const list = matchMedia(DARK_SCHEME_QUERY);
      list.matches = value;
      for (const listener of [...list.listeners]) listener({ media: list.media, matches: value });
    },
  };
}

// Policy runtime over a scripted same-origin fetch (as tests/policy-runtime.test.mjs).
function activityDouble() {
  return Object.freeze({ occupied: false, snapshot: () => Object.freeze({ generation: 1, occupied: false, active: false, kind: null }),
    close: () => Promise.resolve() });
}
function harness({ policies = [examplePolicy()], storage = fakeStorage(), clock = createClock() } = {}) {
  const served = { docs: [...policies], base: 0 };
  const scripted = scriptedFetch((call, index) => {
    const doc = served.docs[Math.min(index - served.base, served.docs.length - 1)];
    return doc instanceof Error ? doc : policyResponse(serialized(doc));
  });
  const client = createPolicyClient({ fetch: scripted.fetch, location: 'https://gai-cmd.github.io/interp-app/', now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const preferences = createPreferences({ storage, now: clock.now });
  const runtime = createPolicyRuntime({ client, preferences, activity: activityDouble(), sessionManager: { occupied: false, close: () => Promise.resolve() },
    now: clock.now });
  const serve = (...docs) => { served.docs = docs; served.base = scripted.calls.length; };
  return { client, runtime, preferences, storage, clock, serve, calls: scripted.calls,
    async refresh() { await runtime.refresh({ reason: 'manual' }); await settle(); return runtime.snapshot(); },
    async start() { await client.start(); await settle(); return runtime.snapshot(); },
    stop() { runtime.close(); client.stop(); } };
}

function runBoot(storageValues, initial = {}) {
  const root = fakeRoot(initial);
  const storage = { getItem: (key) => (Object.hasOwn(storageValues, key) ? storageValues[key] : null) };
  const context = vm.createContext({ document: { documentElement: root }, localStorage: storage });
  new vm.Script(bootSource, { filename: ENTRY_BOOT_FILE }).runInContext(context);
  return attributesOf(root);
}

test('the module owns exactly the three <html>-attribute settings and shares the registered enums', () => {
  assert.deepEqual([...APPEARANCE_SETTINGS], ['ui.mode', 'ui.tone', 'ui.text']);
  assert.ok(APPEARANCE_SETTINGS.every((name) => DISPLAY_SETTINGS.includes(name) && REGISTERED_SETTINGS[name].kind === 'enum'));
  assert.deepEqual(APPEARANCE_ATTRIBUTES, { 'ui.mode': 'data-mode', 'ui.tone': 'data-tone', 'ui.text': 'data-text' });
  assert.equal(SYSTEM_MODE, 'system');
  assert.ok(MODES.includes(SYSTEM_MODE));
  assert.deepEqual([...SET_FAILURES], ['invalid', 'locked', 'restricted']);
  assert.equal(DARK_SCHEME_QUERY, '(prefers-color-scheme: dark)');
  assert.ok(Object.isFrozen(APPEARANCE_SETTINGS) && Object.isFrozen(APPEARANCE_ATTRIBUTES) && Object.isFrozen(SET_FAILURES));
  for (const name of ['captions.size', 'ui.language', 'voice.output', '__proto__', 'mode', undefined, null, 1]) {
    assert.throws(() => interpretAppearance(name, 'dark'), { name: 'TypeError', message: 'INVALID_REQUEST' }, String(name));
  }
});

test('value interpretation is the boot script’s: every stored value yields the same <html> attributes in both', () => {
  // Valid combinations, including a stale data-mode the boot must clear.
  for (const mode of MODES) {
    for (const tone of TONES) {
      for (const text of TEXTS) {
        const stored = { [KEYS['ui.mode']]: mode, [KEYS['ui.tone']]: tone, [KEYS['ui.text']]: text };
        const expected = attributesFor({ 'ui.mode': mode, 'ui.tone': tone, 'ui.text': text });
        assert.deepEqual(runBoot(stored, { 'data-mode': 'light' }), expected, `${mode}/${tone}/${text}`);
        assert.equal(interpretAppearance('ui.mode', mode), mode);
        assert.equal(expected['data-mode'], mode === 'system' ? null : mode);
      }
    }
  }
  // Corrupt and missing values fall back to the registered defaults in both.
  for (const value of CORRUPT) {
    for (const name of APPEARANCE_SETTINGS) {
      const others = APPEARANCE_SETTINGS.filter((other) => other !== name);
      const stored = { [KEYS[name]]: value, ...Object.fromEntries(others.map((other) => [KEYS[other], REGISTERED_SETTINGS[other].values.at(-1)])) };
      const runtimeValues = { [name]: value, ...Object.fromEntries(others.map((other) => [other, REGISTERED_SETTINGS[other].values.at(-1)])) };
      assert.deepEqual(runBoot(stored, { 'data-mode': 'dark' }), attributesFor(runtimeValues), `${name}=${JSON.stringify(value)}`);
      assert.equal(interpretAppearance(name, value), REGISTERED_SETTINGS[name].values.includes(value) ? value : REGISTERED_SETTINGS[name].default);
    }
  }
  assert.deepEqual(runBoot({}), DEFAULT_ATTRIBUTES);
  assert.deepEqual(attributesFor(), DEFAULT_ATTRIBUTES);
  assert.deepEqual(attributesFor(null), DEFAULT_ATTRIBUTES);
  assert.deepEqual(attributesFor({ 'ui.mode': null, 'ui.tone': undefined }), DEFAULT_ATTRIBUTES);
  // Resolver entries ({ value }) are accepted as well as plain values; non-string values are defaults.
  assert.deepEqual(attributesFor({ 'ui.mode': { value: 'dark', source: 'forced' }, 'ui.tone': { value: 'mono' }, 'ui.text': { value: 'xl' } }),
    { 'data-mode': 'dark', 'data-tone': 'mono', 'data-text': 'xl' });
  for (const value of [0, 1, true, {}, [], () => 'dark', ['dark'], { toString: () => 'dark' }]) {
    assert.equal(interpretAppearance('ui.mode', value), 'system', typeof value);
  }
  assert.ok(Object.isFrozen(attributesFor()));
  // The boot's fallbacks are the registered defaults this module uses.
  for (const name of APPEARANCE_SETTINGS) {
    const short = name.slice('ui.'.length);
    const declared = bootSource.match(new RegExp(`key: '${short}'[^\\n]*fallback: '([^']*)'`));
    assert.equal(declared[1], REGISTERED_SETTINGS[name].default, name);
  }
});

test('system and resolved mode helpers', () => {
  assert.equal(systemModeOf({ matches: true }), 'dark');
  assert.equal(systemModeOf({ matches: false }), 'light');
  for (const value of [null, undefined, {}, { matches: 'true' }, { matches: 1 }, 'dark']) assert.equal(systemModeOf(value), null);
  assert.equal(resolvedModeOf('system', 'dark'), 'dark');
  assert.equal(resolvedModeOf('system', 'light'), 'light');
  assert.equal(resolvedModeOf('system', null), 'light', 'unknown system scheme renders light (the stylesheet base)');
  assert.equal(resolvedModeOf('light', 'dark'), 'light', 'a forced light mode is not overridden by a dark system setting');
  assert.equal(resolvedModeOf('dark', 'light'), 'dark');
  assert.equal(resolvedModeOf('DARK', 'dark'), 'dark', 'corrupt mode reads as system');
});

test('the stylesheet lets a forced light mode win over the system dark rule and a forced dark win over a light system', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const media = stripped.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*([^{]+)\{/);
  assert.ok(media, 'the dark media block exists');
  assert.equal(media[1].trim(), ':root:not([data-mode="light"])', 'the system dark rule skips a forced light mode');
  assert.match(stripped, /^:root\[data-mode="dark"\]\s*\{/m, 'a forced dark rule applies outside the media query');
  assert.doesNotMatch(stripped, /:root\[data-mode="system"\]/, 'system is the absence of the attribute');
  // The runtime writes exactly those attribute values: light explicitly, system as removal.
  assert.deepEqual(attributesFor({ 'ui.mode': 'light' })['data-mode'], 'light');
  assert.deepEqual(attributesFor({ 'ui.mode': 'dark' })['data-mode'], 'dark');
  assert.deepEqual(attributesFor({ 'ui.mode': 'system' })['data-mode'], null);
});

test('construction applies the effective values to <html>, writing only attributes that differ', () => {
  const storage = fakeStorage({ [KEYS['ui.mode']]: 'light', [KEYS['ui.tone']]: 'forest', [KEYS['ui.text']]: 'l' });
  const preferences = createPreferences({ storage });
  // The boot already set forest/l; mode was still absent (e.g. a value written after the boot).
  const root = fakeRoot({ 'data-tone': 'forest', 'data-text': 'l', lang: 'ko' });
  const appearance = createAppearance({ document: documentWith(root), preferences });
  assert.ok(Object.isFrozen(appearance));
  assert.deepEqual(attributesOf(root), { 'data-mode': 'light', 'data-tone': 'forest', 'data-text': 'l' });
  assert.deepEqual(root.writes, [['set', 'data-mode', 'light']], 'unchanged attributes are not rewritten');
  assert.equal(root.getAttribute('lang'), 'ko', 'other attributes are untouched');
  const state = appearance.snapshot();
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.values) && Object.isFrozen(state.settings) && Object.isFrozen(state.choices));
  assert.deepEqual(state.values, { 'ui.mode': 'light', 'ui.tone': 'forest', 'ui.text': 'l' });
  assert.deepEqual(state.attributes, { 'data-mode': 'light', 'data-tone': 'forest', 'data-text': 'l' });
  assert.deepEqual(state.choices, { 'ui.mode': 'light', 'ui.tone': 'forest', 'ui.text': 'l' });
  assert.equal(state.system, null, 'no matchMedia: the system scheme is unknown');
  assert.equal(state.resolvedMode, 'light');
  assert.equal(state.persisted, true);
  assert.deepEqual(Object.keys(state.settings), [...APPEARANCE_SETTINGS]);
  assert.equal(state.settings['ui.tone'].source, 'personal');
  assert.equal(state.settings['ui.tone'].locked, false);
  appearance.destroy();

  // Nothing stored and a stale forced mode left on <html>: defaults, data-mode removed.
  const stale = fakeRoot({ 'data-mode': 'dark', 'data-tone': 'mono', 'data-text': 's' });
  const blank = createAppearance({ document: documentWith(stale), preferences: createPreferences({ storage: fakeStorage() }) });
  assert.deepEqual(attributesOf(stale), DEFAULT_ATTRIBUTES);
  assert.deepEqual(stale.writes, [['remove', 'data-mode'], ['set', 'data-tone', 'navy'], ['set', 'data-text', 'm']]);
  assert.equal(blank.snapshot().settings['ui.mode'].source, 'appDefault');
  blank.destroy();

  // Corrupt stored values read as defaults, exactly like the boot.
  const corrupt = fakeRoot();
  createAppearance({ document: documentWith(corrupt), preferences: createPreferences({ storage: fakeStorage({ [KEYS['ui.mode']]: 'DARK', [KEYS['ui.tone']]: 'blue', [KEYS['ui.text']]: '' }) }) }).destroy();
  assert.deepEqual(attributesOf(corrupt), DEFAULT_ATTRIBUTES);

  // Without a preference store the app defaults apply and set() cannot write.
  const bare = createAppearance({ document: documentWith(fakeRoot()) });
  assert.deepEqual(bare.snapshot().values, { 'ui.mode': 'system', 'ui.tone': 'navy', 'ui.text': 'm' });
  assert.equal(bare.snapshot().persisted, false);
  assert.equal(bare.set('ui.mode', 'dark').ok, false);
  assert.deepEqual(bare.reset('ui.mode'), { ok: false, persisted: false });
  bare.destroy();
});

test('invalid construction inputs are refused; a read-only or throwing root never breaks the app', () => {
  const preferences = createPreferences({ storage: fakeStorage() });
  for (const doc of [undefined, null, {}, { documentElement: null }, { documentElement: {} }, { documentElement: { setAttribute() {} } }]) {
    assert.throws(() => createAppearance({ document: doc, preferences }), { name: 'TypeError', message: 'INVALID_REQUEST' });
  }
  const throwing = {};
  Object.defineProperty(throwing, 'documentElement', { get() { throw new Error('boom'); } });
  assert.throws(() => createAppearance({ document: throwing, preferences }), { message: 'INVALID_REQUEST' });
  const root = fakeRoot();
  for (const bad of [{ preferences: 'store' }, { preferences: {} }, { runtime: {} }, { runtime: 'runtime' }, { now: 'later' }]) {
    assert.throws(() => createAppearance({ document: documentWith(root), preferences, ...bad }), { message: 'INVALID_REQUEST' });
  }
  const frozen = { getAttribute: () => null, setAttribute() { throw new Error('NoModificationAllowedError'); }, removeAttribute() { throw new Error('NoModificationAllowedError'); } };
  const appearance = createAppearance({ document: documentWith(frozen), preferences: createPreferences({ storage: fakeStorage({ [KEYS['ui.mode']]: 'dark' }) }) });
  assert.equal(appearance.snapshot().values['ui.mode'], 'dark', 'the state is kept even when the DOM refuses');
  assert.doesNotThrow(() => appearance.set('ui.tone', 'mono'));
  appearance.destroy();
  // A throwing matchMedia is tolerated: the system scheme stays unknown.
  const noMedia = createAppearance({ document: documentWith(fakeRoot()), preferences, matchMedia: () => { throw new Error('unsupported'); } });
  assert.equal(noMedia.snapshot().system, null);
  noMedia.destroy();
  assert.throws(() => noMedia.subscribe('fn'), { message: 'INVALID_REQUEST' });
  assert.throws(() => appearance.set('captions.size', 1.5), { message: 'INVALID_REQUEST' });
  assert.throws(() => appearance.reset('ui.language'), { message: 'INVALID_REQUEST' });
});

test('set/reset write the personal choice, apply it once and report persistence; invalid values are refused untouched', () => {
  const storage = fakeStorage();
  const preferences = createPreferences({ storage, now: () => 5 });
  const root = fakeRoot();
  const appearance = createAppearance({ document: documentWith(root), preferences });
  const seen = [];
  const unsubscribe = appearance.subscribe((state) => seen.push(state));
  assert.deepEqual(appearance.set('ui.mode', 'dark'), { ok: true, reason: null, reasonKey: null, persisted: true, value: 'dark' });
  assert.equal(root.getAttribute('data-mode'), 'dark');
  assert.equal(storage.map.get(KEYS['ui.mode']), 'dark');
  assert.equal(seen.length, 1, 'one notification per change');
  assert.equal(seen[0].values['ui.mode'], 'dark');
  assert.equal(seen[0].resolvedMode, 'dark');
  assert.deepEqual(appearance.set('ui.tone', 'warm'), { ok: true, reason: null, reasonKey: null, persisted: true, value: 'warm' });
  assert.deepEqual(appearance.set('ui.text', 'xl'), { ok: true, reason: null, reasonKey: null, persisted: true, value: 'xl' });
  assert.deepEqual(attributesOf(root), { 'data-mode': 'dark', 'data-tone': 'warm', 'data-text': 'xl' });
  const writesBefore = storage.calls.filter(([method]) => method !== 'getItem').length;
  for (const [name, value] of [['ui.mode', 'DARK'], ['ui.mode', 'auto'], ['ui.mode', ''], ['ui.tone', 'navy '], ['ui.text', 'xxl'], ['ui.text', null],
    ['ui.mode', 1], ['ui.mode', ['dark']], ['ui.mode', '__proto__']]) {
    const result = appearance.set(name, value);
    assert.deepEqual(result, { ok: false, reason: 'invalid', reasonKey: null, persisted: true }, `${name}=${String(value)}`);
  }
  assert.equal(storage.calls.filter(([method]) => method !== 'getItem').length, writesBefore, 'refused values never touch storage');
  assert.deepEqual(attributesOf(root), { 'data-mode': 'dark', 'data-tone': 'warm', 'data-text': 'xl' });
  assert.equal(seen.length, 3);
  // Same value again: written (idempotent), but <html> is not rewritten.
  const writes = root.writes.length;
  assert.equal(appearance.set('ui.mode', 'dark').ok, true);
  assert.equal(root.writes.length, writes);
  // Reset drops the choice; system mode removes the attribute.
  assert.deepEqual(appearance.reset('ui.mode'), { ok: true, persisted: true });
  assert.equal(storage.map.has(KEYS['ui.mode']), false);
  assert.equal(root.getAttribute('data-mode'), null);
  assert.equal(appearance.snapshot().choices['ui.mode'], null);
  assert.equal(appearance.snapshot().values['ui.mode'], 'system');
  unsubscribe();
  appearance.set('ui.text', 's');
  assert.equal(seen.length, 5, 'unsubscribed');
  appearance.destroy();
});

test('save failure: a rejected write still applies for this run and reports persisted=false; success later persists', () => {
  const storage = fakeStorage({}, { failing: new Set(['setItem']) });
  const preferences = createPreferences({ storage });
  const root = fakeRoot();
  const appearance = createAppearance({ document: documentWith(root), preferences });
  assert.deepEqual(appearance.set('ui.tone', 'mono'), { ok: true, reason: null, reasonKey: null, persisted: false, value: 'mono' });
  assert.equal(root.getAttribute('data-tone'), 'mono', 'the page follows the memory copy');
  assert.equal(storage.map.has(KEYS['ui.tone']), false);
  assert.equal(appearance.snapshot().persisted, false);
  assert.equal(appearance.snapshot().choices['ui.tone'], 'mono');
  assert.equal(appearance.snapshot().settings['ui.tone'].source, 'personal');
  storage.failing.delete('setItem');
  assert.equal(appearance.set('ui.tone', 'warm').persisted, true);
  assert.equal(storage.map.get(KEYS['ui.tone']), 'warm');
  assert.equal(appearance.snapshot().persisted, true);
  // A refused value on a failing store reports the store state, not a success.
  storage.failing.add('setItem');
  appearance.set('ui.text', 'l');
  assert.deepEqual(appearance.set('ui.text', 'huge'), { ok: false, reason: 'invalid', reasonKey: null, persisted: false });
  appearance.destroy();
  // A memory-only store (no storage at all) applies and reports persisted=false.
  const memory = createAppearance({ document: documentWith(fakeRoot()), preferences: createPreferences() });
  assert.equal(memory.set('ui.mode', 'dark').persisted, false);
  assert.equal(memory.snapshot().values['ui.mode'], 'dark');
  memory.destroy();
});

test('system scheme changes update the resolved mode and notify without touching <html>; forced modes ignore them', () => {
  const media = fakeMatchMedia({ dark: true });
  const preferences = createPreferences({ storage: fakeStorage() });
  const root = fakeRoot();
  const appearance = createAppearance({ document: documentWith(root), preferences, matchMedia: media.matchMedia });
  assert.equal(media.query.listeners.size, 1, 'the dark query is watched');
  assert.deepEqual([...media.lists.keys()], [DARK_SCHEME_QUERY], 'only the scheme query is created');
  const seen = [];
  appearance.subscribe((state) => seen.push([state.system, state.resolvedMode, state.attributes['data-mode']]));
  assert.equal(appearance.snapshot().system, 'dark');
  assert.equal(appearance.snapshot().resolvedMode, 'dark');
  assert.equal(root.getAttribute('data-mode'), null, 'system mode leaves the cascade to the media query');
  const writes = root.writes.length;
  media.setDark(false);
  assert.deepEqual(seen, [['light', 'light', null]]);
  media.setDark(false);
  assert.equal(seen.length, 1, 'no notification without a change');
  media.setDark(true);
  assert.deepEqual(seen.at(-1), ['dark', 'dark', null]);
  assert.equal(root.writes.length, writes, 'no attribute write for a system change');
  // Forced light stays light under a dark system (the pitfall); forced dark stays dark under light.
  appearance.set('ui.mode', 'light');
  assert.equal(root.getAttribute('data-mode'), 'light');
  assert.equal(appearance.snapshot().resolvedMode, 'light');
  media.setDark(false); media.setDark(true);
  assert.equal(appearance.snapshot().resolvedMode, 'light');
  assert.equal(root.getAttribute('data-mode'), 'light');
  appearance.set('ui.mode', 'dark');
  media.setDark(false);
  assert.equal(appearance.snapshot().resolvedMode, 'dark');
  assert.equal(root.getAttribute('data-mode'), 'dark');
  appearance.destroy();
  assert.equal(media.query.listeners.size, 0, 'destroy removes the media listener');
  media.setDark(true);
  assert.equal(appearance.snapshot().system, 'light', 'no updates after destroy');

  // Legacy addListener/removeListener (older WebKit) is supported the same way.
  const legacy = fakeMatchMedia({ dark: false, legacy: true });
  const old = createAppearance({ document: documentWith(fakeRoot()), preferences: createPreferences({ storage: fakeStorage() }), matchMedia: legacy.matchMedia });
  assert.equal(old.snapshot().system, 'light');
  legacy.setDark(true);
  assert.equal(old.snapshot().resolvedMode, 'dark');
  old.destroy();
  assert.equal(legacy.query.listeners.size, 0);
  // A query without `matches` (broken shim) reads as unknown.
  const broken = createAppearance({ document: documentWith(fakeRoot()), preferences: createPreferences({ storage: fakeStorage() }), matchMedia: () => ({}) });
  assert.equal(broken.snapshot().system, null);
  assert.equal(broken.snapshot().resolvedMode, 'light');
  broken.destroy();
});

test('policy: forced and single-option values win, restricted ranges refuse set(), and lifting restores the personal choice', async () => {
  const storage = fakeStorage({ [KEYS['ui.tone']]: 'warm', [KEYS['ui.text']]: 'xl' });
  const locked = policyWith((policy) => {
    policy.revision = 2;
    policy.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: true };
    policy.settings['ui.text'] = { default: 'm', allowed: ['m', 'l'], locked: false };
    policy.settings['ui.mode'] = { default: 'dark', allowed: ['system', 'light', 'dark'], locked: false };
  });
  const h = harness({ policies: [locked], storage });
  const root = fakeRoot({ 'data-tone': 'warm', 'data-text': 'xl' });
  const appearance = createAppearance({ document: documentWith(root), preferences: h.preferences, runtime: h.runtime });
  // Before the first reply the personal choices apply, exactly as the boot left them.
  assert.deepEqual(attributesOf(root), { 'data-mode': null, 'data-tone': 'warm', 'data-text': 'xl' });
  assert.deepEqual(root.writes, []);
  assert.equal(appearance.snapshot().settings['ui.tone'].source, 'personal');
  const seen = [];
  appearance.subscribe((state) => seen.push(state));
  await h.start();
  // Policy in: tone is forced, the text choice is outside the range so the policy default applies, mode takes the policy default.
  assert.deepEqual(attributesOf(root), { 'data-mode': 'dark', 'data-tone': 'mono', 'data-text': 'm' });
  const state = appearance.snapshot();
  assert.deepEqual(state.settings['ui.tone'], { value: 'mono', source: 'forced', allowed: ['mono'], locked: true, reasonKey: REASON_KEYS.forced });
  assert.deepEqual(state.settings['ui.text'], { value: 'm', source: 'policyDefault', allowed: ['m', 'l'], locked: false, reasonKey: REASON_KEYS.restricted });
  assert.deepEqual(state.settings['ui.mode'], { value: 'dark', source: 'policyDefault', allowed: ['system', 'light', 'dark'], locked: false, reasonKey: null });
  assert.deepEqual(state.choices, { 'ui.mode': null, 'ui.tone': 'warm', 'ui.text': 'xl' }, 'personal choices are kept, never overwritten');
  assert.ok(seen.length >= 1);
  // Refusals leave storage and <html> alone.
  const before = new Map(storage.map);
  assert.deepEqual(appearance.set('ui.tone', 'forest'), { ok: false, reason: 'locked', reasonKey: REASON_KEYS.forced, persisted: true });
  assert.deepEqual(appearance.set('ui.tone', 'mono'), { ok: false, reason: 'locked', reasonKey: REASON_KEYS.forced, persisted: true }, 'even the forced value is not written as a choice');
  assert.deepEqual(appearance.set('ui.text', 'xl'), { ok: false, reason: 'restricted', reasonKey: REASON_KEYS.restricted, persisted: true });
  assert.deepEqual(appearance.set('ui.text', 's'), { ok: false, reason: 'restricted', reasonKey: REASON_KEYS.restricted, persisted: true });
  assert.deepEqual(storage.map, before);
  assert.deepEqual(attributesOf(root), { 'data-mode': 'dark', 'data-tone': 'mono', 'data-text': 'm' });
  // An allowed value is accepted and applied through the runtime.
  assert.deepEqual(appearance.set('ui.text', 'l'), { ok: true, reason: null, reasonKey: null, persisted: true, value: 'l' });
  assert.equal(root.getAttribute('data-text'), 'l');
  assert.equal(appearance.snapshot().settings['ui.text'].source, 'personal');
  assert.equal(appearance.set('ui.mode', 'light').ok, true);
  assert.equal(root.getAttribute('data-mode'), 'light');
  // The administrator lifts the restrictions: the earlier personal choices come back (§1.5).
  h.serve(policyWith((policy) => { policy.revision = 3; }));
  await h.refresh();
  assert.deepEqual(attributesOf(root), { 'data-mode': 'light', 'data-tone': 'warm', 'data-text': 'l' });
  assert.equal(appearance.snapshot().settings['ui.tone'].source, 'personal');
  assert.equal(appearance.snapshot().settings['ui.tone'].locked, false);
  assert.deepEqual(storage.map.get(KEYS['ui.tone']), 'warm');
  // A single-option range counts as forced too.
  h.serve(policyWith((policy) => { policy.revision = 4; policy.settings['ui.text'] = { default: 's', allowed: ['s'], locked: false }; }));
  await h.refresh();
  assert.equal(root.getAttribute('data-text'), 's');
  assert.deepEqual(appearance.set('ui.text', 's'), { ok: false, reason: 'locked', reasonKey: REASON_KEYS.singleOption, persisted: true });
  // A policy that becomes unavailable keeps the last known values (the gate is the runtime's concern).
  appearance.destroy();
  h.stop();
});

test('another tab: preferences.sync() routes a storage event to the one name it changed and the page follows', () => {
  const storage = fakeStorage({ [KEYS['ui.mode']]: 'light' }, { failing: new Set() });
  const preferences = createPreferences({ storage });
  const events = [];
  preferences.subscribe((event) => events.push(event));
  const root = fakeRoot();
  const appearance = createAppearance({ document: documentWith(root), preferences });
  assert.equal(root.getAttribute('data-mode'), 'light');
  // Key routing.
  for (const name of PREFERENCE_NAMES) assert.equal(nameForStorageKey(storageKeyFor(name)), name, name);
  assert.equal(nameForStorageKey(UI_LANGUAGE_STORAGE_KEY), 'ui.language');
  assert.equal(nameForStorageKey('interp-app.pref.v1.billing.plan.other', 'other'), 'billing.plan');
  for (const key of ['interp-app.personal-key.v1.gemini', 'interp-app.ui.v1.install-hint', 'interp-app.ui.v1.tab', 'other', '', null, undefined, 1, {}]) {
    assert.equal(nameForStorageKey(key), null, String(key));
  }
  // The other tab wrote a new tone.
  storage.map.set(KEYS['ui.tone'], 'forest');
  assert.deepEqual(preferences.sync(KEYS['ui.tone']), ['ui.tone']);
  assert.equal(root.getAttribute('data-tone'), 'forest');
  assert.equal(events.at(-1).type, 'sync');
  assert.equal(events.at(-1).name, 'ui.tone');
  assert.equal(events.at(-1).value, 'forest');
  assert.ok(Object.isFrozen(events.at(-1)));
  // A key owned elsewhere changes nothing.
  storage.map.set('interp-app.personal-key.v1.gemini', 'SYNTHETIC');
  const count = events.length;
  assert.deepEqual(preferences.sync('interp-app.personal-key.v1.gemini'), []);
  assert.deepEqual(preferences.sync('unrelated'), []);
  assert.deepEqual(preferences.sync(undefined), []);
  assert.equal(events.length, count);
  assert.equal(root.getAttribute('data-tone'), 'forest');
  // The other tab removed the mode, and later wrote a corrupt text value.
  storage.map.delete(KEYS['ui.mode']);
  preferences.sync(KEYS['ui.mode']);
  assert.equal(root.getAttribute('data-mode'), null);
  storage.map.set(KEYS['ui.text'], 'gigantic');
  preferences.sync(KEYS['ui.text']);
  assert.equal(root.getAttribute('data-text'), 'm', 'corruption by another tab reads as no choice');
  // A memory copy (failed write here) yields to the other tab's write.
  storage.failing.add('setItem');
  assert.equal(appearance.set('ui.tone', 'mono').persisted, false);
  assert.equal(root.getAttribute('data-tone'), 'mono');
  storage.failing.delete('setItem');
  storage.map.set(KEYS['ui.tone'], 'warm');
  preferences.sync(KEYS['ui.tone']);
  assert.equal(root.getAttribute('data-tone'), 'warm');
  assert.equal(preferences.get('ui.tone'), 'warm');
  // clear() in the other tab: every name is re-read; the page falls back to the defaults.
  storage.map.clear();
  const names = preferences.sync(null);
  assert.deepEqual([...names], [...PREFERENCE_NAMES]);
  assert.ok(Object.isFrozen(names));
  assert.deepEqual(attributesOf(root), DEFAULT_ATTRIBUTES);
  assert.equal(storage.calls.filter(([method]) => method !== 'getItem').length, 1, 'sync never writes (the one write is the failed set)');
  appearance.destroy();
});

test('with a runtime, another tab’s change recomputes the effective values against the policy', async () => {
  const storage = fakeStorage();
  const h = harness({ policies: [policyWith((policy) => { policy.settings['ui.text'] = { default: 'm', allowed: ['m', 'l'], locked: false }; })], storage });
  const root = fakeRoot();
  const appearance = createAppearance({ document: documentWith(root), preferences: h.preferences, runtime: h.runtime });
  await h.start();
  storage.map.set(KEYS['ui.text'], 'l');
  h.preferences.sync(KEYS['ui.text']);
  assert.equal(root.getAttribute('data-text'), 'l');
  assert.equal(appearance.snapshot().settings['ui.text'].source, 'personal');
  storage.map.set(KEYS['ui.text'], 'xl');
  h.preferences.sync(KEYS['ui.text']);
  assert.equal(root.getAttribute('data-text'), 'm', 'a choice outside the policy range falls back to the policy default');
  assert.equal(appearance.snapshot().settings['ui.text'].source, 'policyDefault');
  assert.equal(appearance.snapshot().choices['ui.text'], 'xl', 'the choice is kept for when the range widens');
  appearance.destroy();
  h.stop();
});

test('apply() accepts resolver settings or plain values and destroy() stops every subscription', () => {
  const storage = fakeStorage();
  const preferences = createPreferences({ storage });
  const media = fakeMatchMedia();
  const root = fakeRoot();
  const appearance = createAppearance({ document: documentWith(root), preferences, matchMedia: media.matchMedia });
  const seen = [];
  appearance.subscribe((state) => seen.push(state.values));
  assert.deepEqual(appearance.apply({ 'ui.mode': { value: 'dark' }, 'ui.tone': { value: 'forest' }, 'ui.text': { value: 'l' } }),
    { 'ui.mode': 'dark', 'ui.tone': 'forest', 'ui.text': 'l' });
  assert.deepEqual(attributesOf(root), { 'data-mode': 'dark', 'data-tone': 'forest', 'data-text': 'l' });
  assert.deepEqual(appearance.apply({ 'ui.mode': 'system', 'ui.tone': 'bad' }), { 'ui.mode': 'system', 'ui.tone': 'navy', 'ui.text': 'm' });
  assert.deepEqual(attributesOf(root), DEFAULT_ATTRIBUTES);
  assert.equal(seen.length, 2);
  assert.equal(storage.map.size, 0, 'apply() never writes a choice (effective values are not personal choices)');
  // apply() with no argument re-reads the effective values.
  preferences.set('ui.tone', 'mono');
  assert.equal(root.getAttribute('data-tone'), 'mono', 'the store subscription applied it');
  appearance.apply({ 'ui.tone': 'warm' });
  assert.deepEqual(appearance.apply(), { 'ui.mode': 'system', 'ui.tone': 'mono', 'ui.text': 'm' });
  appearance.destroy();
  appearance.destroy();
  const writes = root.writes.length;
  preferences.set('ui.mode', 'dark');
  media.setDark(true);
  assert.equal(root.writes.length, writes, 'no writes after destroy');
  assert.equal(appearance.snapshot().values['ui.mode'], 'system');
  assert.deepEqual(appearance.apply({ 'ui.mode': 'light' }), appearance.snapshot().values, 'apply() is inert after destroy');
  assert.equal(root.getAttribute('data-mode'), null);
});

test('main.js: the appearance runtime is wired to the document, the policy runtime and the window storage event', async () => {
  const b = await boot({ storage: { [KEYS['ui.mode']]: 'light', [KEYS['ui.tone']]: 'forest' },
    policy: scenarioPolicy((policy) => { policy.settings['ui.text'] = { default: 'l', allowed: ['m', 'l', 'xl'], locked: false }; }) });
  const html = b.doc.documentElement;
  const { appearance } = b.app;
  assert.ok(appearance && Object.isFrozen(appearance));
  await until(() => b.app.policy.snapshot().status === 'ready');
  assert.equal(html.getAttribute('data-mode'), 'light');
  assert.equal(html.getAttribute('data-tone'), 'forest');
  assert.equal(html.getAttribute('data-text'), 'l', 'the policy default applies once the policy is in');
  assert.equal(html.getAttribute('lang'), 'ko', 'the shell still owns lang');
  assert.equal(appearance.snapshot().system, 'light', 'window.matchMedia is consulted');
  assert.equal(appearance.snapshot().persisted, true);
  // The user changes the mode: stored under the DESIGN.md key and applied.
  assert.equal(appearance.set('ui.mode', 'dark').ok, true);
  assert.equal(html.getAttribute('data-mode'), 'dark');
  assert.equal(b.storage.get(KEYS['ui.mode']), 'dark');
  // Another tab changes the tone: the window's storage event reaches the store and the page.
  b.storage.set(KEYS['ui.tone'], 'mono');
  b.win.dispatch('storage', { key: KEYS['ui.tone'], newValue: 'mono', storageArea: b.win.localStorage });
  assert.equal(html.getAttribute('data-tone'), 'mono');
  assert.equal(appearance.snapshot().choices['ui.tone'], 'mono');
  // A storage event for a key owned elsewhere (or a clear) never throws.
  assert.doesNotThrow(() => b.win.dispatch('storage', { key: 'interp-app.personal-key.v1.gemini', newValue: null }));
  assert.doesNotThrow(() => b.win.dispatch('storage', {}));
  assert.equal(html.getAttribute('data-tone'), 'mono');
  // Display-only policy changes keep the connection: the runtime reports type 'display' and the page follows.
  const changes = [];
  b.app.policy.subscribe((snapshot, change) => changes.push(change.type));
  b.policyCalls.length = 0;
  // Clear() elsewhere drops every choice: defaults (policy default for text) apply.
  b.storage.clear();
  b.win.dispatch('storage', { key: null, newValue: null });
  await tick();
  assert.deepEqual([html.getAttribute('data-mode'), html.getAttribute('data-tone'), html.getAttribute('data-text')], [null, 'navy', 'l']);
  assert.ok(changes.includes('preference'));
  const storageListeners = b.win.listeners.get('storage')?.size ?? 0;
  assert.equal(storageListeners, 1, 'one storage listener');
  await b.app.close();
  assert.equal(b.win.listeners.get('storage')?.size ?? 0, 0, 'close removes the storage listener');
  assert.equal(html.getAttribute('data-tone'), 'navy', 'close leaves <html> as it is');
});

test('the module reads no browser globals on import, logs nothing and spells no dictionary text', async () => {
  const source = await read('app/ui/appearance.js');
  assert.doesNotMatch(source, /\b(?:window|document|navigator|localStorage|matchMedia)\b\s*[.[]/, 'no browser globals');
  assert.doesNotMatch(source, /console\.|innerHTML|outerHTML|insertAdjacentHTML|innerText|\beval\(|document\.write/);
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket/, 'no network');
  assert.doesNotMatch(source, /\bt\(/, 'no dictionary lookups: the UI renders reasons');
  const main = await read('app/main.js');
  assert.ok(main.includes("import { createAppearance } from './ui/appearance.js';"));
  assert.ok(main.indexOf('createPolicyRuntime({') < main.indexOf('createAppearance({'), 'the runtime exists before the appearance');
  assert.ok(main.includes("listen(win, 'storage'"), 'the storage event is forwarded');
  assert.ok(main.indexOf('appearance?.destroy()') < main.indexOf('policyRuntime?.close()'), 'appearance is destroyed before the runtime closes');
});
