import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// docs/extension.md §10.4-10.5 and §11.1 (group A, M0): the manifest rules, tested against an
// EMBEDDED copy of the §10.4 manifest and group A's own _locales files. No real-tree
// assertion is made here (the real manifest is linted in tests/extension-tree.test.mjs, M3).
//
// Two layers, so the file means something before the build script exists:
//  1. "spec" tests always run. RULES below states each §10.5 rule as a one-line predicate plus
//     the mutations that must break it; the tests prove the fixture satisfies every rule and
//     that each mutation breaks exactly its own rule (so a mutation can never pass vacuously).
//  2. "lintManifest" tests run the same table through the real linter, which §10.1 puts in
//     scripts/build-extension.mjs (group A, M2). Until that file exists they are reported as
//     skipped, with the reason; once it exists they run with no edit to this file.
//
// Interface assumed for layer 2 (§10.1 gives only `{ fileExists }`, which cannot express the
// _locales checks of §10.5, so this file fixes the simplest reading; it is a recorded decision):
//   lintManifest(manifest, { fileExists, messages }) -> string[]
//   - fileExists(path): repo-relative POSIX path, `extension/...` for source files (including
//     `extension/_locales/<lang>/messages.json`) and `icons/icon-<n>.png` for the generated icons;
//   - messages: { en, ko, ja }, the parsed messages.json objects;
//   - returns [] when valid, else strings that match /^EXTENSION_MANIFEST_[A-Z0-9_]+$/.
// The R3 rule (no import/export in a content script) needs file contents, so it stays in
// tests/extension-static.test.mjs (M3, real tree).

const LANGUAGES = Object.freeze(['en', 'ko', 'ja']);
const ALLOWED_PERMISSIONS = Object.freeze(['activeTab', 'contextMenus', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabCapture', 'tabs']);

// The manifest of §10.4, verbatim.
const FIXTURE = {
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  version: '0.1.0',
  default_locale: 'en',
  minimum_chrome_version: '116',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: '__MSG_actionTitle__',
    default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  },
  background: { service_worker: 'extension/background/service-worker.js', type: 'module' },
  side_panel: { default_path: 'extension/panel/panel.html' },
  options_ui: { page: 'extension/options/options.html', open_in_tab: true },
  permissions: ['activeTab', 'contextMenus', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabCapture', 'tabs'],
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['extension/overlay/overlay.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  commands: {
    _execute_action: {
      suggested_key: { default: 'Alt+Shift+Y' },
      description: '__MSG_commandOpen__',
    },
  },
};

// Group A's own _locales files: the only files of the real tree this test reads.
const REAL_MESSAGES = Object.fromEntries(await Promise.all(LANGUAGES.map(async (language) =>
  [language, JSON.parse(await readFile(new URL(`../extension/_locales/${language}/messages.json`, import.meta.url), 'utf8'))])));

const SOURCE_FILES = Object.freeze([
  'extension/background/service-worker.js', 'extension/panel/panel.html', 'extension/options/options.html',
  'extension/overlay/overlay.js', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  ...LANGUAGES.map((language) => `extension/_locales/${language}/messages.json`),
]);

/** A fresh manifest copy and a fresh stub context (file set, fileExists, messages) per case. */
function makeCase(mutate = () => {}) {
  const files = new Set(SOURCE_FILES);
  const context = { files, fileExists: (path) => files.has(path), messages: structuredClone(REAL_MESSAGES) };
  const manifest = structuredClone(FIXTURE);
  mutate(manifest, context);
  return { manifest, context };
}

const REFERENCE = /^__MSG_([A-Za-z][A-Za-z0-9_]*)__$/;
const referenceHolds = (value, { messages }) => {
  const match = REFERENCE.exec(typeof value === 'string' ? value : '');
  return match !== null && LANGUAGES.every((language) => Object.hasOwn(messages[language] ?? {}, match[1]));
};
const characters = (value) => [...String(value)].length;
const MATCHES = ['http://*/*', 'https://*/*'];

// Each rule of §10.5 as a predicate on (manifest, context), and the mutations that must break it.
const RULES = Object.freeze([
  { id: 'manifest_version', holds: (m) => m.manifest_version === 3, mutations: {
    'version 2': (m) => { m.manifest_version = 2; },
    'a string': (m) => { m.manifest_version = '3'; } } },
  { id: 'version', holds: (m) => {
    const version = m.version;
    if (typeof version !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version)) return false;
    const parts = version.split('.').map(Number);
    return parts.every((part) => part <= 65535) && parts.some((part) => part > 0);
  }, mutations: {
    'leading zero': (m) => { m.version = '1.02'; },
    'all zero': (m) => { m.version = '0.0.0'; },
    'part above 65535': (m) => { m.version = '65536.0.1'; },
    'five parts': (m) => { m.version = '1.2.3.4.5'; },
    'not numeric': (m) => { m.version = 'v1'; },
    'absent': (m) => { delete m.version; } } },
  { id: 'minimum_chrome_version', holds: (m) => typeof m.minimum_chrome_version === 'string'
    && /^\d+$/.test(m.minimum_chrome_version) && Number(m.minimum_chrome_version) >= 116, mutations: {
    '115': (m) => { m.minimum_chrome_version = '115'; },
    'a number': (m) => { m.minimum_chrome_version = 116; },
    'absent': (m) => { delete m.minimum_chrome_version; } } },
  { id: 'default_locale', holds: (m) => m.default_locale === 'en', mutations: {
    'ko': (m) => { m.default_locale = 'ko'; },
    'absent': (m) => { delete m.default_locale; } } },
  { id: 'locale_files', holds: (m, c) => LANGUAGES.every((language) => c.fileExists(`extension/_locales/${language}/messages.json`)), mutations: {
    'ja file missing': (m, c) => { c.files.delete('extension/_locales/ja/messages.json'); },
    'en file missing': (m, c) => { c.files.delete('extension/_locales/en/messages.json'); } } },
  { id: 'message_references', holds: (m, c) => referenceHolds(m.name, c) && referenceHolds(m.description, c)
    && referenceHolds(m.action?.default_title, c)
    && Object.values(m.commands ?? {}).every((command) => referenceHolds(command?.description, c)), mutations: {
    'a literal name': (m) => { m.name = 'Live Interpreter'; },
    'a name that no locale defines': (m) => { m.name = '__MSG_extNameMissing__'; },
    'a description that one locale lacks': (m, c) => { delete c.messages.ko.extDescription; },
    'an action title that is not a reference': (m) => { m.action.default_title = 'Open'; },
    'a command description that no locale defines': (m) => { m.commands._execute_action.description = '__MSG_missing__'; } } },
  { id: 'permissions', holds: (m) => Array.isArray(m.permissions)
    && JSON.stringify([...m.permissions].sort()) === JSON.stringify([...ALLOWED_PERMISSIONS].sort())
    && new Set(m.permissions).size === m.permissions.length, mutations: {
    'a permission is added': (m) => { m.permissions.push('history'); },
    'a broad permission is added': (m) => { m.permissions.push('<all_urls>'); },
    'a permission is removed': (m) => { m.permissions = m.permissions.filter((name) => name !== 'tabs'); },
    'a permission is duplicated': (m) => { m.permissions.push('tabs'); } } },
  { id: 'forbidden_keys', holds: (m) => ['host_permissions', 'optional_permissions', 'optional_host_permissions',
    'web_accessible_resources', 'externally_connectable', 'content_security_policy', 'incognito']
    .every((key) => !Object.hasOwn(m, key)) && !Object.hasOwn(m.action ?? {}, 'default_popup'), mutations: {
    'action.default_popup': (m) => { m.action.default_popup = 'extension/panel/panel.html'; },
    'host_permissions': (m) => { m.host_permissions = ['https://*/*']; },
    'optional_permissions': (m) => { m.optional_permissions = ['history']; },
    'optional_host_permissions': (m) => { m.optional_host_permissions = ['https://*/*']; },
    'web_accessible_resources': (m) => { m.web_accessible_resources = [{ resources: ['extension/overlay/overlay.js'], matches: ['https://*/*'] }]; },
    'externally_connectable': (m) => { m.externally_connectable = { matches: ['https://*/*'] }; },
    'content_security_policy': (m) => { m.content_security_policy = { extension_pages: "script-src 'self'; object-src 'self'" }; },
    'incognito': (m) => { m.incognito = 'split'; } } },
  { id: 'background', holds: (m, c) => m.background?.type === 'module' && c.fileExists(m.background.service_worker), mutations: {
    'a classic worker': (m) => { delete m.background.type; },
    'type other than module': (m) => { m.background.type = 'classic'; },
    'the worker file is missing': (m, c) => { c.files.delete('extension/background/service-worker.js'); } } },
  { id: 'paths_exist', holds: (m, c) => [m.side_panel?.default_path, m.options_ui?.page,
    ...(m.content_scripts ?? []).flatMap((script) => script.js ?? []),
    ...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {})].every((path) => typeof path === 'string' && c.fileExists(path)), mutations: {
    'the side panel page is missing': (m, c) => { c.files.delete('extension/panel/panel.html'); },
    'the options page is missing': (m, c) => { c.files.delete('extension/options/options.html'); },
    'the content script is missing': (m, c) => { c.files.delete('extension/overlay/overlay.js'); },
    'an icon is missing': (m, c) => { c.files.delete('icons/icon-48.png'); },
    'a toolbar icon path points nowhere': (m) => { m.action.default_icon[16] = 'icons/nowhere.png'; } } },
  { id: 'content_scripts', holds: (m) => Array.isArray(m.content_scripts) && m.content_scripts.length > 0
    && m.content_scripts.every((script) => JSON.stringify([...(script.matches ?? [])].sort()) === JSON.stringify(MATCHES)
      && script.all_frames === false && script.run_at === 'document_idle'), mutations: {
    'all_frames true': (m) => { m.content_scripts[0].all_frames = true; },
    'all_frames absent': (m) => { delete m.content_scripts[0].all_frames; },
    'an <all_urls> match': (m) => { m.content_scripts[0].matches = ['<all_urls>']; },
    'a match is added': (m) => { m.content_scripts[0].matches.push('file:///*'); },
    'only https is matched': (m) => { m.content_scripts[0].matches = ['https://*/*']; },
    'run_at document_start': (m) => { m.content_scripts[0].run_at = 'document_start'; } } },
  { id: 'execute_action_command', holds: (m) => {
    const key = m.commands?._execute_action?.suggested_key;
    return Boolean(key) && typeof key.default === 'string' && key.default !== '' && !Object.hasOwn(key, 'global');
  }, mutations: {
    'the command is absent': (m) => { delete m.commands._execute_action; },
    'the suggested key is absent': (m) => { delete m.commands._execute_action.suggested_key; },
    'a global shortcut': (m) => { m.commands._execute_action.suggested_key.global = 'Ctrl+Shift+Y'; } } },
  { id: 'message_limits', holds: (m, c) => LANGUAGES.every((language) => characters(c.messages[language]?.extDescription?.message ?? '') <= 132
    && characters(c.messages[language]?.extName?.message ?? '') <= 45), mutations: {
    'an extDescription of 133 characters': (m, c) => { c.messages.ko.extDescription.message = 'a'.repeat(133); },
    'an extName of 46 characters': (m, c) => { c.messages.en.extName.message = 'a'.repeat(46); } } },
]);

test('spec: the embedded fixture satisfies every rule of §10.5, with the real _locales and a stub file set', () => {
  const { manifest, context } = makeCase();
  for (const rule of RULES) assert.equal(rule.holds(manifest, context), true, rule.id);
  assert.deepEqual([...manifest.permissions].sort(), [...ALLOWED_PERMISSIONS].sort());
  assert.equal(Object.keys(REAL_MESSAGES.en).length, 12, 'the fixture is checked against the twelve messages of §9.3');
  assert.equal(new Set(RULES.map((rule) => rule.id)).size, RULES.length, 'rule ids are unique');
});

for (const rule of RULES) {
  test(`spec: every mutation of rule ${rule.id} breaks that rule and no other`, () => {
    assert.ok(Object.keys(rule.mutations).length > 0);
    for (const [label, mutate] of Object.entries(rule.mutations)) {
      const before = makeCase();
      const { manifest, context } = makeCase(mutate);
      assert.notDeepEqual([manifest, [...context.files].sort(), context.messages], [before.manifest, [...before.context.files].sort(), before.context.messages],
        `${rule.id}: "${label}" changes something`);
      const broken = RULES.filter((other) => !other.holds(manifest, context)).map((other) => other.id);
      assert.deepEqual(broken, [rule.id], `${rule.id}: "${label}" breaks exactly its own rule`);
    }
  });
}

// --- layer 2: the real linter (scripts/build-extension.mjs, group A, M2) ---

async function loadBuild() {
  try {
    return await import('../scripts/build-extension.mjs');
  } catch (error) {
    // Only "that file does not exist yet" is tolerated; a syntax error or any other failure stays loud.
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('build-extension.mjs')) return null;
    throw error;
  }
}
const build = await loadBuild();
const skip = build ? false : 'scripts/build-extension.mjs (group A, M2) does not exist yet; these tests run as soon as it does';
const lint = (manifest, context) => build.lintManifest(manifest, { fileExists: context.fileExists, messages: context.messages });
const reasonShape = /^EXTENSION_MANIFEST_[A-Z0-9_]+$/;

test('lintManifest accepts the §10.4 manifest and exports the permission list it enforces', { skip }, () => {
  const { manifest, context } = makeCase();
  assert.deepEqual(lint(manifest, context), []);
  assert.deepEqual([...build.ALLOWED_PERMISSIONS], [...ALLOWED_PERMISSIONS]);
  assert.equal(Object.isFrozen(build.ALLOWED_PERMISSIONS), true);
  assert.deepEqual([...build.ALLOWED_PERMISSIONS], [...build.ALLOWED_PERMISSIONS].sort(), 'the list is sorted');
});

for (const rule of RULES) {
  test(`lintManifest reports every mutation of rule ${rule.id}`, { skip }, () => {
    for (const [label, mutate] of Object.entries(rule.mutations)) {
      const { manifest, context } = makeCase(mutate);
      const reasons = lint(manifest, context);
      assert.ok(Array.isArray(reasons) && reasons.length > 0, `${rule.id}: "${label}" is refused`);
      assert.ok(reasons.every((reason) => reasonShape.test(reason)), `${rule.id}: "${label}" reports machine codes only`);
    }
  });
}

test('lintManifest never throws on garbage and reports it as a refusal', { skip }, () => {
  const { context } = makeCase();
  for (const garbage of [null, undefined, [], 7, 'text', {}, { manifest_version: 3 }, { manifest_version: 3, permissions: 'tabs', content_scripts: 'x', commands: [], icons: null }]) {
    const reasons = lint(garbage, context);
    assert.ok(Array.isArray(reasons) && reasons.length > 0 && reasons.every((reason) => reasonShape.test(reason)));
  }
});
