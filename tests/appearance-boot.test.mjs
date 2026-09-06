import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { REGISTERED_SETTINGS } from '../app/policy/schema.js';
import { storageKeyFor } from '../app/preferences.js';
import { ENTRY_BOOT_FILE, collectVersionedFiles, rewriteEntry, shellFor } from '../scripts/stage-release.mjs';
import { entryReferences } from '../scripts/check-release.mjs';

// P3-13: the appearance boot is a classic synchronous script that runs before
// the stylesheet. It is executed here inside a bare vm context with a fake
// <html> element and a scripted localStorage; there is no DOM library.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const BOOT_PATH = ENTRY_BOOT_FILE;
const source = await readFile(new URL(`../${BOOT_PATH}`, import.meta.url), 'utf8');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const code = stripComments(source);

const NAMES = Object.freeze({ mode: 'ui.mode', tone: 'ui.tone', text: 'ui.text' });
const KEYS = Object.freeze(Object.fromEntries(Object.entries(NAMES).map(([short, name]) => [short, storageKeyFor(name)])));
const DEFAULTS = Object.freeze({ 'data-tone': 'navy', 'data-text': 'm' });

function fakeRoot(initial = {}) {
  const attributes = new Map(Object.entries(initial));
  const calls = [];
  return {
    attributes,
    calls,
    setAttribute(name, value) { calls.push(['set', name, value]); attributes.set(name, String(value)); },
    removeAttribute(name) { calls.push(['remove', name]); attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
}

function fakeStorage(values, { throwOnGet = false } = {}) {
  const reads = [];
  return {
    reads,
    getItem(key) {
      reads.push(key);
      if (throwOnGet) throw new Error('SecurityError');
      return Object.hasOwn(values, key) ? values[key] : null;
    },
    setItem() { throw new Error('WRITE_NOT_EXPECTED'); },
    removeItem() { throw new Error('WRITE_NOT_EXPECTED'); },
    clear() { throw new Error('WRITE_NOT_EXPECTED'); },
  };
}

// Run the boot as a classic script (not a module) with only the globals given.
function boot(sandbox) {
  // The sandbox is used as-is so throwing accessors (defineProperty) survive.
  const before = Object.keys(sandbox).sort();
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: BOOT_PATH }).runInContext(context);
  assert.deepEqual(Object.keys(sandbox).sort(), before, 'the boot leaves no global behind');
  return sandbox;
}

function attributesOf(root) {
  return Object.fromEntries([...root.attributes.entries()].sort());
}

test('the accepted values and storage keys stay identical to the registered settings and the preference store', () => {
  for (const [short, name] of Object.entries(NAMES)) {
    const spec = REGISTERED_SETTINGS[name];
    assert.equal(spec.kind, 'enum', name);
    const declared = code.match(new RegExp(`key: '${short}'[^\\n]*values: \\[([^\\]]*)\\][^\\n]*fallback: '([^']*)'`));
    assert.ok(declared, `${short} is declared in the boot`);
    const values = declared[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(values, spec.values, `${short} values match REGISTERED_SETTINGS['${name}']`);
    assert.equal(declared[2], spec.default, `${short} fallback matches the registered default`);
    assert.equal(`${code.match(/STORAGE_PREFIX = '([^']+)'/)[1]}${short}`, KEYS[short], `${short} storage key matches storageKeyFor`);
  }
});

test('saved mode, tone and text reach <html> before any stylesheet and only the three keys are read', () => {
  const values = { [KEYS.mode]: 'dark', [KEYS.tone]: 'forest', [KEYS.text]: 'xl' };
  const storage = fakeStorage(values);
  const root = fakeRoot();
  boot({ document: { documentElement: root }, localStorage: storage });
  assert.deepEqual(attributesOf(root), { 'data-mode': 'dark', 'data-tone': 'forest', 'data-text': 'xl' });
  assert.deepEqual([...storage.reads].sort(), Object.values(KEYS).sort(), 'exactly the three display keys, each once');
  for (const mode of REGISTERED_SETTINGS['ui.mode'].values) {
    for (const tone of REGISTERED_SETTINGS['ui.tone'].values) {
      for (const text of REGISTERED_SETTINGS['ui.text'].values) {
        const element = fakeRoot({ 'data-mode': 'light' });
        boot({ document: { documentElement: element }, localStorage: fakeStorage({ [KEYS.mode]: mode, [KEYS.tone]: tone, [KEYS.text]: text }) });
        const expected = { 'data-tone': tone, 'data-text': text };
        if (mode !== 'system') expected['data-mode'] = mode;
        assert.deepEqual(attributesOf(element), expected, `${mode}/${tone}/${text}`);
      }
    }
  }
});

test('system mode removes a stale data-mode so prefers-color-scheme applies', () => {
  const root = fakeRoot({ 'data-mode': 'dark', 'data-tone': 'mono', 'data-text': 's' });
  boot({ document: { documentElement: root }, localStorage: fakeStorage({ [KEYS.mode]: 'system' }) });
  assert.deepEqual(attributesOf(root), DEFAULTS);
  assert.ok(root.calls.some((call) => call[0] === 'remove' && call[1] === 'data-mode'));
});

test('corrupt values fall back to system/navy/m without touching other attributes', () => {
  const corrupt = ['Dark', ' dark', 'dark ', 'DARK', '', 'auto', 'null', 'undefined', 'x', '1', '{"v":"dark"}', 'navy', 'm', 'xl'];
  for (const value of corrupt) {
    const root = fakeRoot({ lang: 'ko', 'data-mode': 'light' });
    boot({ document: { documentElement: root }, localStorage: fakeStorage({ [KEYS.mode]: value }) });
    assert.deepEqual(attributesOf(root), { lang: 'ko', ...DEFAULTS }, `mode=${JSON.stringify(value)}`);
  }
  for (const value of ['Navy', 'blue', '', 'dark', 'm']) {
    const root = fakeRoot();
    boot({ document: { documentElement: root }, localStorage: fakeStorage({ [KEYS.tone]: value, [KEYS.text]: value }) });
    assert.deepEqual(attributesOf(root), DEFAULTS, `tone/text=${JSON.stringify(value)}`);
  }
  // Non-string reads (a broken storage shim) are treated as absent.
  for (const value of [undefined, 0, 1, true, {}, [], () => 'dark']) {
    const root = fakeRoot();
    boot({ document: { documentElement: root }, localStorage: fakeStorage({ [KEYS.mode]: value, [KEYS.tone]: value, [KEYS.text]: value }) });
    assert.deepEqual(attributesOf(root), DEFAULTS, `read=${typeof value}`);
  }
});

test('storage failures never throw: blocked, missing, throwing and partial storages all boot with the defaults', () => {
  const cases = {
    'no localStorage global': {},
    'localStorage undefined': { localStorage: undefined },
    'localStorage null': { localStorage: null },
    'localStorage without getItem': { localStorage: {} },
    'getItem throws (private mode / cookies blocked)': { localStorage: fakeStorage({}, { throwOnGet: true }) },
  };
  for (const [name, globals] of Object.entries(cases)) {
    const root = fakeRoot({ 'data-mode': 'dark' });
    assert.doesNotThrow(() => boot({ document: { documentElement: root }, ...globals }), name);
    assert.deepEqual(attributesOf(root), DEFAULTS, name);
  }
  // Access to the localStorage property itself may throw (SecurityError).
  const root = fakeRoot();
  const sandbox = { document: { documentElement: root } };
  Object.defineProperty(sandbox, 'localStorage', { enumerable: true, get() { throw new Error('SecurityError'); } });
  assert.doesNotThrow(() => boot(sandbox));
  assert.deepEqual(attributesOf(root), DEFAULTS);
  // A getItem that throws for one key still lets the others through.
  const partial = fakeStorage({ [KEYS.tone]: 'warm', [KEYS.text]: 'l' });
  const getItem = partial.getItem.bind(partial);
  partial.getItem = (key) => { if (key === KEYS.mode) throw new Error('QuotaExceededError'); return getItem(key); };
  const element = fakeRoot();
  boot({ document: { documentElement: element }, localStorage: partial });
  assert.deepEqual(attributesOf(element), { 'data-tone': 'warm', 'data-text': 'l' });
});

test('a missing or read-only document root is tolerated', () => {
  assert.doesNotThrow(() => boot({ localStorage: fakeStorage({ [KEYS.mode]: 'dark' }) }));
  assert.doesNotThrow(() => boot({ document: {}, localStorage: fakeStorage({ [KEYS.mode]: 'dark' }) }));
  assert.doesNotThrow(() => boot({ document: { documentElement: null }, localStorage: fakeStorage({}) }));
  const frozen = { setAttribute() { throw new Error('NoModificationAllowedError'); }, removeAttribute() { throw new Error('NoModificationAllowedError'); } };
  assert.doesNotThrow(() => boot({ document: { documentElement: frozen }, localStorage: fakeStorage({ [KEYS.mode]: 'dark' }) }));
  const throwingDocument = {};
  Object.defineProperty(throwingDocument, 'documentElement', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => boot({ document: throwingDocument, localStorage: fakeStorage({}) }));
});

test('the boot is a strict classic script that only reads display keys: no network, key, policy, write or output paths', () => {
  assert.match(source, /^\/\/ First-paint appearance boot/, 'source header present');
  assert.match(code, /^\s*\(function \(\) \{\s*'use strict';/m);
  assert.match(code, /\}\)\(\);\s*$/);
  for (const forbidden of [/\bimport\b/, /\bexport\b/, /\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /\bnavigator\b/, /\bwindow\b/,
    /\bsessionStorage\b/, /\bindexedDB\b/, /\bcaches\b/, /\bsetItem\b/, /\bremoveItem\b/, /\bclear\(/, /\bconsole\b/, /\beval\b/,
    /new Function/, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\bsetTimeout\b|\bsetInterval\b|requestAnimationFrame/,
    /personal-key|shared|policy\.json|apiKey|api_key/i, /https?:\/\/|wss?:\/\//, /\bthrow\b/, /\bdebugger\b/]) {
    assert.doesNotMatch(code, forbidden, `boot must not contain ${forbidden}`);
  }
  const literals = [...code.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  const storageLiterals = literals.filter((literal) => literal.includes('interp-app'));
  assert.deepEqual(storageLiterals, ['interp-app.ui.v1.'], 'only the display key prefix is spelled out');
  assert.ok(literals.every((literal) => !/\.(?:v1|pref|audio)\./.test(literal) || literal === 'interp-app.ui.v1.'));
  // Parses as a classic script: a module-only construct would be a SyntaxError here.
  assert.doesNotThrow(() => new vm.Script(source, { filename: BOOT_PATH }));
});

test('index.html loads the boot as a synchronous classic script before the stylesheet, and staging keeps that order', async () => {
  const html = await readFile(`${repoRoot}index.html`, 'utf8');
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const parsed = entryReferences(html);
  assert.ok(parsed, 'the entry passes the release markup rules');
  assert.equal(parsed.boot, `./${BOOT_PATH}`);
  assert.deepEqual(parsed.modules, ['./app/main.js']);
  const bootTag = markup.match(/<script\b[^>]*>/)[0];
  assert.equal(bootTag, `<script src="./${BOOT_PATH}">`, 'no type/async/defer on the boot script');
  const head = markup.slice(0, markup.indexOf('</head>'));
  assert.ok(head.includes(bootTag), 'the boot sits inside <head>');
  assert.ok(head.indexOf(bootTag) < head.indexOf('<link rel="stylesheet"'), 'the boot precedes the stylesheet');
  assert.equal((markup.match(/<script\b/g) ?? []).length, 2, 'exactly the boot and the module');

  const staged = rewriteEntry(html, 'p3-13');
  const stagedTag = `<script src="./releases/p3-13/${BOOT_PATH}">`;
  assert.ok(staged.includes(stagedTag), 'the boot is loaded from the versioned path');
  assert.ok(staged.indexOf(stagedTag) < staged.indexOf('<link rel="stylesheet" href="./releases/p3-13/styles.css">'));
  const stagedParsed = entryReferences(staged);
  assert.equal(stagedParsed.boot, `./releases/p3-13/${BOOT_PATH}`);
  assert.deepEqual(stagedParsed.modules, ['./releases/p3-13/app/main.js']);

  const versioned = await collectVersionedFiles(repoRoot);
  assert.ok(versioned.includes(BOOT_PATH), 'the boot is a versioned release file');
  assert.ok(shellFor('p3-13', versioned).includes(`./releases/p3-13/${BOOT_PATH}`), 'the boot is precached with the shell');
});
