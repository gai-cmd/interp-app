import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// New implementation of docs/extension.md §3.3 (R1-R13), §11.1, §11.4 (D1, D13, D14) and §15.3; no legacy code is ported.
//
// REAL-TREE test (group A, M3): it reads the actual extension/ and app/ trees and the actual tests/extension-*.test.mjs
// files, so it is only expected to be fully green once all four groups have landed.
//
// Every scan below is a pure function of a ROOT DIRECTORY (default: the repository). That is what lets this file prove
// its scans are not vacuous: for each ban the mutant tests build a small tree from strings in a temp directory, assert
// the clean baseline yields nothing, then assert the mutated tree is reported under exactly the expected rule id. A scan
// that silently matches nothing (a broken regexp, a lexer that swallows the rest of a line) fails those tests first.
//
// Two proofs sit on top of the synthetic mutants: a copy of the real tree gets one violation injected into a real file per rule
// (so the regexps and the lexer are shown to work on the code this project really has), and the lexer is checked to keep every
// existing source file of app/, scripts/ and tests/ bracket-balanced (so a mis-lexed file cannot silently blind a scan).
//
// Decisions recorded where the contract is open (also listed in the report):
//  - Comments are stripped by a small JavaScript lexer instead of privacy.test.mjs's two regexps. The regexps leave
//    everything after a "//" inside a string unexamined; the lexer keeps strings, template literals and regexp literals,
//    and offers a second view with those blanked for the identifier scans (R8 states that strings are stripped).
//  - The D13 tokens are searched in code with comments removed (a comment cannot make a sound). Strings stay, because a
//    string handed to a launcher is exactly what the scan is for. Every forbidden token is assembled at runtime below, so
//    this file passes its own scan; a test proves that.
//  - "Against a real object" (D13) cannot be decided syntactically for every alias. The scan flags what is decidable:
//    a global-rooted access (globalThis.navigator..., window.chrome.tabCapture) and a bare navigator/chrome/AudioContext
//    that the file never declares itself. Members of an injected fake (fake.env.AudioContext, worker.chrome.tabCapture)
//    are not flagged.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// --- the expected file list (docs/extension.md §3.1) --------------------------------------------------------------
// [owner group, path]. A missing or empty file is reported with its group, so an unfinished group can never make this
// file vacuously green.
const EXPECTED_FILES = Object.freeze([
  ['A', 'extension/manifest.json'],
  ['A', 'extension/_locales/en/messages.json'], ['A', 'extension/_locales/ko/messages.json'], ['A', 'extension/_locales/ja/messages.json'],
  ['D', 'extension/i18n/en.json'], ['D', 'extension/i18n/ko.json'], ['D', 'extension/i18n/ja.json'],
  ['A', 'extension/lib/builtin-key.js'], ['C', 'extension/lib/links.js'], ['B', 'extension/lib/constants.js'],
  ['B', 'extension/lib/protocol.js'], ['B', 'extension/lib/settings.js'], ['B', 'extension/lib/ui-state.js'],
  ['B', 'extension/lib/caption-frames.js'], ['C', 'extension/lib/chrome-adapter.js'], ['C', 'extension/lib/i18n.js'],
  ['C', 'extension/lib/dom-i18n.js'], ['C', 'extension/lib/update-check.js'],
  ['C', 'extension/background/service-worker.js'], ['C', 'extension/background/sw-core.js'], ['C', 'extension/background/arming.js'],
  ['B', 'extension/engine/host.html'], ['B', 'extension/engine/host.js'], ['B', 'extension/engine/lane-host.js'],
  ['B', 'extension/engine/lane-engine.js'], ['B', 'extension/engine/tab-lane.js'], ['B', 'extension/engine/mic-lane.js'],
  ['B', 'extension/engine/audio-graph.js'], ['B', 'extension/engine/platform-shim.js'], ['B', 'extension/engine/worker-timers.js'],
  ['B', 'extension/engine/timer-worker.js'], ['B', 'extension/engine/overlay-hub.js'], ['B', 'extension/engine/panel-hub.js'],
  ['D', 'extension/panel/panel.html'], ['D', 'extension/panel/panel.css'], ['C', 'extension/panel/panel.js'],
  ['C', 'extension/panel/controller.js'], ['C', 'extension/panel/view-model.js'], ['C', 'extension/panel/host-link.js'],
  ['D', 'extension/options/options.html'], ['C', 'extension/options/options.js'], ['C', 'extension/options/controller.js'],
  ['D', 'extension/permission/mic-permission.html'], ['C', 'extension/permission/mic-permission.js'],
  ['C', 'extension/permission/controller.js'],
  ['D', 'extension/pages.css'], ['D', 'extension/overlay/overlay.js'],
].map((row) => Object.freeze(row)));
// The test files and fixtures of §11.1 (their existence keeps the D13 scan from being vacuous for a group that never wrote tests).
const EXPECTED_TESTS = Object.freeze([
  ['A', 'tests/session-isolated.test.mjs'], ['A', 'tests/extension-i18n.test.mjs'], ['A', 'tests/extension-manifest.test.mjs'],
  ['A', 'tests/extension-build.test.mjs'], ['A', 'tests/extension-static.test.mjs'], ['A', 'tests/extension-tree.test.mjs'],
  ['B', 'tests/extension-protocol.test.mjs'], ['B', 'tests/extension-settings.test.mjs'], ['B', 'tests/extension-ui-state.test.mjs'],
  ['B', 'tests/extension-audio-graph.test.mjs'], ['B', 'tests/extension-timers.test.mjs'], ['B', 'tests/extension-lanes.test.mjs'],
  ['B', 'tests/extension-host.test.mjs'],
  ['C', 'tests/extension-chrome-adapter.test.mjs'], ['C', 'tests/extension-i18n-loader.test.mjs'], ['C', 'tests/extension-arming.test.mjs'],
  ['C', 'tests/extension-sw.test.mjs'], ['C', 'tests/extension-panel.test.mjs'], ['C', 'tests/extension-options.test.mjs'],
  ['C', 'tests/extension-permission.test.mjs'], ['C', 'tests/extension-integration.test.mjs'],
  ['D', 'tests/extension-fixtures.test.mjs'], ['D', 'tests/extension-overlay.test.mjs'], ['D', 'tests/extension-html.test.mjs'],
  ['D', 'tests/fixtures/fake-chrome.mjs'], ['D', 'tests/fixtures/fake-audio.mjs'], ['D', 'tests/fixtures/extension-dom.mjs'],
].map((row) => Object.freeze(row)));
const OWNERS = new Map([...EXPECTED_FILES, ...EXPECTED_TESTS].map(([group, path]) => [path, group]));
const ownerOf = (path) => OWNERS.get(path) ?? '?';

// §3.3 R10: the only modules allowed to have import-time effects.
const ENTRY_FILES = Object.freeze([
  'extension/background/service-worker.js', 'extension/engine/host.js', 'extension/engine/timer-worker.js', 'extension/panel/panel.js',
  'extension/options/options.js', 'extension/permission/mic-permission.js', 'extension/overlay/overlay.js',
]);
const OVERLAY = 'extension/overlay/overlay.js';
const CHROME_ADAPTER = 'extension/lib/chrome-adapter.js';
const LINKS = 'extension/lib/links.js';
const UPDATE_CHECK = 'extension/lib/update-check.js';
const BUILTIN_KEY = 'extension/lib/builtin-key.js';
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const TEXT_FILE = /\.(?:js|mjs|html|css|json)$/;

// --- findings -----------------------------------------------------------------------------------------------------
const finding = (rule, file, detail, at) => Object.freeze({ rule, file, line: at ? lineOf(at.text, at.index) : 0, detail });
const render = (findings) => findings.map((item) => `${item.rule} ${item.file}${item.line ? `:${item.line}` : ''} [group ${item.group ?? ownerOf(item.file)}] ${item.detail}`);
const rulesOf = (findings) => [...new Set(findings.map((item) => item.rule))].sort();

// --- a small JavaScript lexer ---------------------------------------------------------------------------------------
// lexJs(source) returns two views with the SAME length and the same line breaks as the source:
//   code  - comments blanked; strings, template literals and regexp literals kept (what privacy.test.mjs's helper yields,
//           minus its blind spots);
//   ident - comments, strings, template text and regexp literals blanked; the code inside ${...} stays. Used where a rule
//           is about identifiers (R8, the classic-script and D13 checks).
// A slash starts a regexp when the previous significant token cannot end an expression.
const PUNCT_BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const WORD_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

export function lexJs(source) {
  const size = source.length;
  const codeView = source.split('');
  const identView = source.split('');
  const blank = (view, from, to) => { for (let k = from; k < to; k += 1) if (view[k] !== '\n' && view[k] !== '\r') view[k] = ' '; };
  let prev = '';
  let prevWord = '';

  const readString = (start) => {
    const quote = source[start];
    let k = start + 1;
    while (k < size) {
      const ch = source[k];
      if (ch === '\\') k += 2;
      else if (ch === quote) return k + 1;
      else if (ch === '\n') return k;
      else k += 1;
    }
    return size;
  };
  const readRegex = (start) => {
    let k = start + 1;
    let inClass = false;
    while (k < size) {
      const ch = source[k];
      if (ch === '\n') return -1;
      if (ch === '\\') { k += 2; continue; }
      if (inClass) { if (ch === ']') inClass = false; } else if (ch === '[') inClass = true;
      else if (ch === '/') { k += 1; while (k < size && /[A-Za-z]/.test(source[k])) k += 1; return k; }
      k += 1;
    }
    return -1;
  };
  const readTemplate = (start) => {
    let k = start + 1;
    let quasiFrom = start;
    while (k < size) {
      const ch = source[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '`') { blank(identView, quasiFrom, k + 1); return k + 1; }
      if (ch === '$' && source[k + 1] === '{') {
        blank(identView, quasiFrom, k + 2);
        prev = '{'; prevWord = '';
        k = scan(k + 2, true);
        quasiFrom = k - 1;
        continue;
      }
      k += 1;
    }
    blank(identView, quasiFrom, size);
    return size;
  };
  function scan(start, inTemplate) {
    let k = start;
    let depth = 0;
    while (k < size) {
      const ch = source[k];
      const next = source[k + 1];
      if (ch === '/' && next === '/') {
        const end = source.indexOf('\n', k);
        const stop = end < 0 ? size : end;
        blank(codeView, k, stop); blank(identView, k, stop); k = stop; continue;
      }
      if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', k + 2);
        const stop = end < 0 ? size : end + 2;
        blank(codeView, k, stop); blank(identView, k, stop); k = stop; continue;
      }
      if (ch === '"' || ch === "'") {
        const stop = readString(k);
        blank(identView, k, stop); prev = ch; prevWord = ''; k = stop; continue;
      }
      if (ch === '`') { k = readTemplate(k); prev = '`'; prevWord = ''; continue; }
      if (ch === '/') {
        const allowed = prev === '' || PUNCT_BEFORE_REGEX.has(prev) || prev === '}' || (prev === 'w' && WORD_BEFORE_REGEX.has(prevWord));
        const stop = allowed ? readRegex(k) : -1;
        if (stop > 0) { blank(identView, k, stop); prev = ']'; prevWord = ''; k = stop; continue; }
        prev = '/'; prevWord = ''; k += 1; continue;
      }
      if (/\s/.test(ch)) { k += 1; continue; }
      if (isWordChar(ch)) {
        let end = k;
        while (isWordChar(source[end])) end += 1;
        prevWord = source.slice(k, end); prev = 'w'; k = end; continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        if (inTemplate && depth === 0) return k + 1;
        depth -= 1;
      }
      prev = ch; prevWord = ''; k += 1;
    }
    return size;
  }
  if (source.startsWith('#!')) {
    const end = source.indexOf('\n');
    const stop = end < 0 ? size : end;
    blank(codeView, 0, stop); blank(identView, 0, stop);
    scan(stop, false);
  } else scan(0, false);
  return { code: codeView.join(''), ident: identView.join('') };
}

/** Index of the first unbalanced closing bracket in a lexed ident view, or -1 when every bracket pairs up. */
function unbalancedAt(ident) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (let index = 0; index < ident.length; index += 1) {
    const ch = ident[index];
    if ('([{'.includes(ch)) stack.push(ch);
    else if (pairs[ch] !== undefined && stack.pop() !== pairs[ch]) return index;
  }
  return stack.length === 0 ? -1 : ident.length;
}
/** Index of the parenthesis that closes the one at `open` (paren-only count over a view whose strings are blanked), or -1. */
function closingParen(ident, open) {
  let depth = 0;
  for (let index = open; index < ident.length; index += 1) {
    if (ident[index] === '(') depth += 1;
    else if (ident[index] === ')') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

// --- reading a root directory -----------------------------------------------------------------------------------------
async function listFiles(root, directory) {
  const found = [];
  async function walk(relative) {
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // Mirrors the build (§10.7): dotfiles are never copied, so they are never scanned or reported.
      if (entry.name.startsWith('.')) continue;
      const path = posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) found.push({ path, symlink: true });
      else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push({ path, symlink: false });
    }
  }
  await walk(directory);
  return found;
}
/** The extension/ and app/ trees (plus the root styles.css that the pages link) as text, keyed by repo-relative POSIX path. */
async function loadTree(root = repoRoot) {
  const files = new Map();
  const symlinks = [];
  for (const top of ['extension', 'app']) {
    for (const entry of await listFiles(root, top)) {
      if (entry.symlink) symlinks.push(entry.path);
      else files.set(entry.path, TEXT_FILE.test(entry.path) ? await readFile(join(root, entry.path), 'utf8') : null);
    }
  }
  const styles = await lstat(join(root, 'styles.css')).catch(() => null);
  if (styles?.isFile()) files.set('styles.css', await readFile(join(root, 'styles.css'), 'utf8'));
  return Object.freeze({ root, files, symlinks });
}
const VIEWS = new WeakMap();
function viewsOf(tree, path) {
  let cache = VIEWS.get(tree);
  if (!cache) { cache = new Map(); VIEWS.set(tree, cache); }
  if (!cache.has(path)) cache.set(path, Object.freeze(lexJs(tree.files.get(path))));
  return cache.get(path);
}
const jsFiles = (tree, prefix) => [...tree.files.keys()].filter((path) => path.startsWith(prefix) && path.endsWith('.js')).sort();
async function nonEmptyFile(root, path) {
  const info = await lstat(join(root, path)).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
}

// --- layout: §3.1 list, stray files, file types, R13 ------------------------------------------------------------------
async function scanMissing(root, expected) {
  const findings = [];
  for (const [group, path] of expected) {
    if (!(await nonEmptyFile(root, path))) findings.push(Object.freeze({ rule: 'MISSING', file: path, line: 0, group, detail: 'does not exist or is empty' }));
  }
  return findings;
}
function scanLayout(tree, { expectedPaths = null } = {}) {
  const findings = [];
  for (const path of tree.files.keys()) {
    if (path === 'styles.css') continue;
    if (!path.split('/').every((segment) => SAFE_SEGMENT.test(segment))) findings.push(finding('R13', path, 'a path segment fails [A-Za-z0-9._-]+'));
    if (path.startsWith('extension/')) {
      if (!/\.(?:js|html|css|json)$/.test(path)) findings.push(finding('S3.1-type', path, 'only .js, .html, .css and .json files may live under extension/ (§10.2)'));
      if (expectedPaths && !expectedPaths.has(path)) findings.push(finding('S3.1-stray', path, 'is not in the §3.1 file list (no file outside it may be created, D14)'));
    }
  }
  for (const path of tree.symlinks) findings.push(finding('R13', path, 'a symlink under extension/ or app/ (the build refuses symlinks, §10.7)'));
  return findings;
}
/** §10.6: the source slot is the empty list, exactly once; no key ever lives in git. */
function scanBuiltinKeySlot(tree) {
  const text = tree.files.get(BUILTIN_KEY);
  if (text === undefined) return [];
  const { code } = viewsOf(tree, BUILTIN_KEY);
  const findings = [];
  const slots = code.match(/export const BUILTIN_KEYS = Object\.freeze\(\[\]\);/g) ?? [];
  if (slots.length !== 1) findings.push(finding('R11-key', BUILTIN_KEY, `the empty slot line must appear exactly once in source, found ${slots.length}`));
  if ((code.match(/\bBUILTIN_KEYS\b/g) ?? []).length !== 1) findings.push(finding('R11-key', BUILTIN_KEY, 'BUILTIN_KEYS may be written exactly once, in the slot line'));
  return findings;
}

// --- R11 bans, keys, URLs, shadow roots, iframes ------------------------------------------------------------------------
const BANS = Object.freeze([
  ['console', /\bconsole\s*[.[]/g], ['eval', /\beval\s*\(/g], ['new-function', /\bnew\s+Function\s*\(/g],
  ['inner-outer-html', /\b(?:inner|outer)HTML\b/g], ['insert-adjacent-html', /insertAdjacentHTML/g],
  ['document-write', /\bdocument\s*\.\s*write/g], ['import-scripts', /\bimportScripts\s*\(/g],
  ['local-storage', /\blocalStorage\b/g], ['session-storage', /\bsessionStorage\b/g], ['indexed-db', /\bindexedDB\b/g],
  ['debugger', /\bdebugger\b/g], ['iframe-markup', /<\s*iframe\b/gi],
  ['iframe-element', /createElement(?:NS)?\s*\([^)]*['"`]iframe['"`]/gi],
]);
function scanBans(tree) {
  const findings = [];
  for (const path of jsFiles(tree, 'extension/')) {
    const { code, ident } = viewsOf(tree, path);
    for (const [rule, pattern] of BANS) {
      const label = rule.startsWith('iframe') ? 'D1' : `R11-${rule}`;
      for (const match of code.matchAll(pattern)) findings.push(finding(label, path, `${match[0].trim()} is banned`, { text: code, index: match.index }));
    }
    for (const match of ident.matchAll(/\brequire\s*\(/g)) findings.push(finding('R11-require', path, 'require( is banned (no CommonJS in an extension)', { text: code, index: match.index }));
    for (const match of ident.matchAll(/\battachShadow\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      const close = closingParen(ident, open);
      const args = close < 0 ? '' : code.slice(open + 1, close);
      if (path !== OVERLAY) findings.push(finding('R11-shadow', path, 'attachShadow appears only in overlay.js', { text: code, index: match.index }));
      else if (!/\bmode\s*:\s*(['"])closed\1/.test(args)) findings.push(finding('R11-shadow', path, "attachShadow must be called with mode: 'closed' (D6)", { text: code, index: match.index }));
    }
  }
  return findings;
}
function scanSecrets(tree, ctx) {
  const findings = [];
  for (const [path, text] of tree.files) {
    if (!path.startsWith('extension/') || text === null) continue;
    const isJs = path.endsWith('.js');
    const code = isJs ? viewsOf(tree, path).code : text;
    for (const pattern of ctx.secretPatterns) if (pattern.test(code)) findings.push(finding('R11-key', path, `matches the key-shaped pattern ${pattern.source.slice(0, 24)}`));
    if (isJs && code.includes(ctx.secretMark)) findings.push(finding('R11-key', path, 'carries the test secret marker'));
  }
  return findings;
}
function scanUrls(tree, ctx) {
  const findings = [];
  for (const path of jsFiles(tree, 'extension/')) {
    const { code } = viewsOf(tree, path);
    for (const match of code.matchAll(/\b(?:https?|wss?):\/\/[^\s'"`)]+/g)) {
      const at = { text: code, index: match.index };
      const url = attempt(() => new URL(match[0]));
      if (!url) findings.push(finding('R11-url', path, `unparsable URL literal ${match[0].slice(0, 40)}`, at));
      else if (!ctx.allowedOrigins.has(url.origin)) findings.push(finding('R11-url', path, `${url.origin} is neither an endpoint nor a documentation origin`, at));
      else if (ctx.documentationUrls.has(match[0]) && !ctx.documentationFiles.has(path)) findings.push(finding('R11-url', path, `the documentation link ${match[0]} may only be written in ${[...ctx.documentationFiles].join(', ')}`, at));
    }
  }
  return findings;
}

// --- R8: the chrome / browser identifier ---------------------------------------------------------------------------------
const CHROME_IDENT = /(?<![\w$])(chrome|browser)(?![\w$])/g;
const CHROME_PARAM_DEFAULT = /[(,]\s*[\w$]+\s*=\s*(?:globalThis\s*\.\s*)?chrome(?![\w$])(?=\s*[,)])/g;
function scanChromeIdentifier(tree) {
  const findings = [];
  for (const path of jsFiles(tree, 'extension/')) {
    if (path === OVERLAY) continue;
    const { code, ident } = viewsOf(tree, path);
    // Identifiers only: string literals, template text, regexp literals and comments are already blanked in `ident`.
    const allowedHere = path === CHROME_ADAPTER ? new Set([...ident.matchAll(CHROME_PARAM_DEFAULT)].map((m) => m.index + m[0].lastIndexOf('chrome'))) : new Set();
    for (const match of ident.matchAll(CHROME_IDENT)) {
      if (allowedHere.has(match.index)) continue;
      const why = path === CHROME_ADAPTER && match[1] === 'chrome' ? 'chrome may appear here only as the default of a parameter' : 'only chrome-adapter.js and overlay.js may name it (inject an adapter instead)';
      findings.push(finding('R8', path, `the identifier ${match[1]}: ${why}`, { text: code, index: match.index }));
    }
  }
  return findings;
}

// --- R1-R7, R13 and the closure: the import graph ---------------------------------------------------------------------------
const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?(['"])([^'"\n]+)\1/g;
const ASSET_URL = /new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
function edgesOf({ code, ident }) {
  const edges = [];
  const problems = [];
  for (const match of code.matchAll(STATIC_IMPORT)) {
    if (/^(?:import|export)$/.test(ident.slice(match.index, match.index + 6))) edges.push({ spec: match[2], kind: 'static', index: match.index });
  }
  for (const match of ident.matchAll(/\bimport\s*\(/g)) {
    const literal = /^\s*(['"])([^'"\n]+)\1\s*\)/.exec(code.slice(match.index + match[0].length, match.index + match[0].length + 400));
    if (literal) edges.push({ spec: literal[2], kind: 'dynamic', index: match.index });
    else problems.push({ index: match.index, detail: 'dynamic import() needs a string literal specifier (the build cannot follow anything else)' });
  }
  for (const match of code.matchAll(ASSET_URL)) {
    if (ident.slice(match.index, match.index + 3) === 'new') edges.push({ spec: match[2], kind: 'asset', index: match.index });
  }
  return { edges, problems };
}
const resolveTarget = (from, spec) => (spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), spec)) : null);

const APP_FOR_LIB = Object.freeze(['app/i18n/index.js', 'app/i18n/boot-fallback.js', 'app/providers/gemini/live-config.js', 'app/engine/listen-state.js', 'app/security/shared-key.js']);
const APP_FOR_ENGINE = Object.freeze(['app/config.js', 'app/engine/sim.js', 'app/platform.js', 'app/providers/gemini/live-config.js']);
const IMPORTS_NOTHING = Object.freeze(['chrome-adapter.js', 'links.js', 'builtin-key.js', 'constants.js']);
/** §3.3 R2-R6: what a file may import, by the directory it sits in. */
function policyFor(path) {
  const lib = 'extension/lib/';
  if (path.startsWith('extension/background/')) return { rule: 'R2', ext: [lib, 'extension/background/'], app: [] };
  if (path.startsWith(lib)) {
    const name = path.slice(lib.length);
    if (IMPORTS_NOTHING.includes(name)) return { rule: 'R4', ext: [], app: [] };
    if (name === 'protocol.js') return { rule: 'R4', ext: [`${lib}constants.js`], app: [] };
    return { rule: 'R4', ext: [lib], app: APP_FOR_LIB };
  }
  if (path.startsWith('extension/engine/')) return { rule: 'R5', ext: [lib, 'extension/engine/'], app: APP_FOR_ENGINE };
  if (path.startsWith('extension/panel/')) return { rule: 'R6', ext: [lib, 'extension/panel/'], app: ['app/i18n/index.js'] };
  if (path.startsWith('extension/options/')) return { rule: 'R6', ext: [lib, 'extension/options/'], app: ['app/i18n/index.js', 'app/providers/gemini/live-config.js', 'app/security/shared-key.js'] };
  if (path.startsWith('extension/permission/')) return { rule: 'R6', ext: [lib, 'extension/permission/'], app: ['app/i18n/index.js'] };
  if (path.startsWith('extension/overlay/')) return { rule: 'R3', ext: [], app: [] };
  return null;
}
const permits = (policy, target) => policy.ext.some((prefix) => (prefix.endsWith('/') ? target.startsWith(prefix) : target === prefix)) || policy.app.includes(target);

function scanImports(tree) {
  const findings = [];
  for (const path of [...jsFiles(tree, 'extension/'), ...jsFiles(tree, 'app/')]) {
    const views = viewsOf(tree, path);
    const { edges, problems } = edgesOf(views);
    const isExtension = path.startsWith('extension/');
    if (isExtension) for (const problem of problems) findings.push(finding('R7', path, problem.detail, { text: views.code, index: problem.index }));
    const policy = isExtension ? policyFor(path) : null;
    for (const edge of edges) {
      const at = { text: views.code, index: edge.index };
      const target = resolveTarget(path, edge.spec);
      if (!isExtension) {
        if (target !== null && target.startsWith('extension/')) findings.push(finding('R1', path, `app code imports ${edge.spec}: the direction is extension -> app only`, at));
        continue;
      }
      if (target === null) { findings.push(finding('R7', path, `${edge.kind} specifier "${edge.spec}" is not relative`, at)); continue; }
      if (!/\.(?:js|json)$/.test(edge.spec)) findings.push(finding('R7', path, `specifier "${edge.spec}" must end in .js or .json`, at));
      if (!(target.startsWith('extension/') || target.startsWith('app/'))) { findings.push(finding('R7', path, `"${edge.spec}" resolves to ${target}, outside extension/ and app/`, at)); continue; }
      if (!tree.files.has(target)) { findings.push(finding('R7', path, `"${edge.spec}" does not resolve to a file (${target})`, at)); continue; }
      if (target === 'extension/manifest.json' || target.startsWith('extension/_locales/')) { findings.push(finding('R7', path, `${target} goes to the output root; it is not importable`, at)); continue; }
      if (policy === null) findings.push(finding('R7', path, `no import rule covers this location (${edge.spec})`, at));
      else if (!permits(policy, target)) findings.push(finding(policy.rule, path, `${edge.kind} ${edge.spec} -> ${target} is not allowed here`, at));
    }
  }
  return findings;
}
const NEVER_IN_CLOSURE = Object.freeze(['app/main.js', 'app/security/builtin-key.js']);
/** §10.3: from every extension module the transitive closure over app/ never reaches the web app's entry or its key slot. */
function scanClosure(tree) {
  const findings = [];
  const reported = new Set();
  for (const start of jsFiles(tree, 'extension/')) {
    const seen = new Set([start]);
    const queue = [[start, [start]]];
    while (queue.length > 0) {
      const [path, chain] = queue.shift();
      if (NEVER_IN_CLOSURE.includes(path) && !reported.has(path)) {
        reported.add(path);
        findings.push(finding('R1-closure', start, `reaches ${path} through ${chain.join(' -> ')}`));
      }
      if (!path.endsWith('.js') || !tree.files.has(path)) continue;
      for (const edge of edgesOf(viewsOf(tree, path)).edges) {
        const target = resolveTarget(path, edge.spec);
        if (target !== null && !seen.has(target) && tree.files.has(target)) { seen.add(target); queue.push([target, [...chain, target]]); }
      }
    }
  }
  return findings;
}
/** R1 and D14: app/ never names extension/, and no ext.-shaped key literal lives in app/. */
function scanAppBoundary(tree) {
  const findings = [];
  for (const path of jsFiles(tree, 'app/')) {
    const { code } = viewsOf(tree, path);
    for (const match of code.matchAll(/(?<![\w-])extension\//g)) findings.push(finding('R1', path, 'app code names extension/', { text: code, index: match.index }));
    for (const match of code.matchAll(/(['"`])ext\.[A-Za-z0-9_.-]+\1/g)) findings.push(finding('R1', path, `${match[0]} is an extension i18n key literal; ext.* keys never appear in app/`, { text: code, index: match.index }));
  }
  return findings;
}

// --- R3: classic scripts ---------------------------------------------------------------------------------------------------
/** Depth-0 skeleton of a lexed source: every bracket group collapses to its two brackets. */
function skeletonOf(ident) {
  let depth = 0;
  let out = '';
  let firstGroup = null;
  let groupStart = 0;
  for (let index = 0; index < ident.length; index += 1) {
    const ch = ident[index];
    if ('([{'.includes(ch)) { if (depth === 0) { out += ch; groupStart = index; } depth += 1; }
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) { out += ch; if (firstGroup === null) firstGroup = ident.slice(groupStart + 1, index); }
    } else if (depth === 0 && !/\s/.test(ch)) out += ch;
  }
  return { skeleton: out, firstGroup };
}
function scanClassicScripts(tree) {
  const findings = [];
  const targets = new Set([OVERLAY]);
  const manifestText = tree.files.get('extension/manifest.json');
  if (manifestText !== undefined) {
    const manifest = attempt(() => JSON.parse(manifestText));
    if (!manifest) findings.push(finding('R3', 'extension/manifest.json', 'the manifest is not readable JSON, so its content scripts cannot be identified'));
    else for (const entry of manifest.content_scripts ?? []) for (const js of entry.js ?? []) targets.add(posix.normalize(js));
  }
  for (const path of [...targets].sort()) {
    const text = tree.files.get(path);
    if (text === undefined || text === null) continue;
    const { code, ident } = viewsOf(tree, path);
    try { new vm.Script(text, { filename: path }); } catch (error) {
      findings.push(finding('R3', path, `does not parse as a classic script: ${String(error?.message).split('\n')[0]}`));
      continue;
    }
    for (const match of ident.matchAll(/\b(?:import|export|require)\b/g)) findings.push(finding('R3', path, `${match[0]} in a classic script`, { text: code, index: match.index }));
    const { skeleton, firstGroup } = skeletonOf(ident);
    const single = /^;?\(\)(?:\(\))?;?$/.test(skeleton) && /\bfunction\b|=>/.test(firstGroup ?? '');
    if (!single) findings.push(finding('R3', path, `a content script is exactly one IIFE at the top level; its top level reads "${skeleton.slice(0, 40)}"`));
  }
  return findings;
}

// --- R12: HTML files --------------------------------------------------------------------------------------------------------
function parseHtml(text) {
  const tags = [];
  const texts = [];
  const length = text.length;
  let index = 0;
  while (index < length) {
    if (text.startsWith('<!--', index)) { const end = text.indexOf('-->', index + 4); index = end < 0 ? length : end + 3; continue; }
    if (text[index] === '<' && /[!?]/.test(text[index + 1] ?? '')) { const end = text.indexOf('>', index); index = end < 0 ? length : end + 1; continue; }
    if (text[index] === '<' && /[A-Za-z/]/.test(text[index + 1] ?? '')) {
      const start = index;
      const closing = text[index + 1] === '/';
      let cursor = index + (closing ? 2 : 1);
      const name = /^[A-Za-z][A-Za-z0-9:-]*/.exec(text.slice(cursor))?.[0] ?? '';
      cursor += name.length;
      const attrs = [];
      while (cursor < length && text[cursor] !== '>') {
        if (/[\s/]/.test(text[cursor])) { cursor += 1; continue; }
        const nameMatch = /^[^\s=/>]+/.exec(text.slice(cursor));
        if (!nameMatch) { cursor += 1; continue; }
        const attrName = nameMatch[0];
        cursor += attrName.length;
        while (/\s/.test(text[cursor] ?? '')) cursor += 1;
        let value = null;
        if (text[cursor] === '=') {
          cursor += 1;
          while (/\s/.test(text[cursor] ?? '')) cursor += 1;
          if (text[cursor] === '"' || text[cursor] === "'") {
            const end = text.indexOf(text[cursor], cursor + 1);
            value = text.slice(cursor + 1, end < 0 ? length : end);
            cursor = end < 0 ? length : end + 1;
          } else { value = /^[^\s>]*/.exec(text.slice(cursor))[0]; cursor += value.length; }
        }
        attrs.push([attrName.toLowerCase(), value]);
      }
      index = cursor + 1;
      const tag = { name: name.toLowerCase(), closing, attrs, index: start, raw: '' };
      if (!closing && (tag.name === 'script' || tag.name === 'style')) {
        const end = text.toLowerCase().indexOf(`</${tag.name}`, index);
        tag.raw = text.slice(index, end < 0 ? length : end);
        index = end < 0 ? length : end;
      }
      tags.push(tag);
      continue;
    }
    const next = text.indexOf('<', index + 1);
    const stop = next < 0 ? length : next;
    if (text.slice(index, stop).trim() !== '') texts.push({ index, text: text.slice(index, stop).trim() });
    index = stop;
  }
  return { tags, texts };
}
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'manifest', 'ping', 'xlink:href']);
function scanHtml(tree) {
  const findings = [];
  for (const [path, text] of tree.files) {
    if (!path.startsWith('extension/') || !path.endsWith('.html')) continue;
    const { tags, texts } = parseHtml(text);
    const at = (index) => ({ text, index });
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
    for (const match of withoutComments.matchAll(/\b(?:https?|wss?|ftp):\/\/|chrome-extension:/g)) findings.push(finding('R12', path, `remote URL ${match[0]}`, at(match.index)));
    for (const item of texts) findings.push(finding('R12', path, `literal text between tags: "${item.text.slice(0, 30)}" (text comes from data-i18n attributes)`, at(item.index)));
    for (const tag of tags) {
      if (tag.closing) continue;
      if (tag.name === 'iframe') findings.push(finding('D1', path, '<iframe> is not used anywhere in the extension', at(tag.index)));
      for (const [name, value] of tag.attrs) {
        if (/^on[a-z]/.test(name)) findings.push(finding('R12', path, `inline event handler attribute ${name}`, at(tag.index)));
        if (!URL_ATTRIBUTES.has(name) || value === null || value.trim() === '' || value.trim().startsWith('#')) continue;
        const url = value.trim();
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith('//')) { findings.push(finding('R12', path, `${name}="${url}" is not relative`, at(tag.index))); continue; }
        if (url.startsWith('/')) { findings.push(finding('R12', path, `${name}="${url}" is root-relative; use a relative path`, at(tag.index))); continue; }
        const target = posix.normalize(posix.join(posix.dirname(path), url.split(/[?#]/)[0]));
        if (target.startsWith('../') || !tree.files.has(target)) findings.push(finding('R12', path, `${name}="${url}" does not resolve to a file (${target})`, at(tag.index)));
        else if (!(target.startsWith('extension/') || target === 'styles.css')) findings.push(finding('R12', path, `${name}="${url}" points at ${target}, which the build does not copy`, at(tag.index)));
      }
      if (tag.name === 'script') {
        const attrs = new Map(tag.attrs);
        const src = attrs.get('src');
        if ((attrs.get('type') ?? '').toLowerCase() !== 'module') findings.push(finding('R12', path, '<script> needs type="module"', at(tag.index)));
        if (src === undefined || src === null || src.trim() === '') findings.push(finding('R12', path, '<script> needs a src', at(tag.index)));
        else {
          if (tag.raw.trim() !== '') findings.push(finding('R12', path, 'inline script text', at(tag.index)));
          // The URL rule above already reports a scheme, a root-relative path or a missing file; R10 speaks only about a page that loads a real, non-entry module.
          const target = posix.normalize(posix.join(posix.dirname(path), src.split(/[?#]/)[0]));
          if (!/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/)/.test(src.trim()) && tree.files.has(target) && !ENTRY_FILES.includes(target)) {
            findings.push(finding('R10', path, `<script src="${src}"> loads ${target}, which is not an R10 entry file`, at(tag.index)));
          }
        }
        if (src === undefined && tag.raw.trim() !== '') findings.push(finding('R12', path, 'inline script text', at(tag.index)));
      }
    }
  }
  return findings;
}

// --- R9 / R10: import purity ------------------------------------------------------------------------------------------------
// R9 names chrome, document, window, navigator, storage, AudioContext, fetch and timers. Importing a non-entry module with
// throwing getters for all of them proves it touches none of them at import time.
const TRAPPED_GLOBALS = Object.freeze(['chrome', 'browser', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'indexedDB',
  'AudioContext', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']);
/** After a probe every trapped name reads normally again (its own or Node's descriptor is back, or the name is gone). */
function assertTrapsRemoved() {
  for (const name of TRAPPED_GLOBALS) {
    let touched = false;
    try { void globalThis[name]; } catch { touched = true; }
    assert.equal(touched, false, `${name} is readable again after the probe`);
  }
}
const nonEntryModules = (tree) => jsFiles(tree, 'extension/').filter((path) => !ENTRY_FILES.includes(path));
async function probeImportPurity(root, paths) {
  const findings = [];
  const seen = new Set();
  const saved = new Map(TRAPPED_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of TRAPPED_GLOBALS) {
    Object.defineProperty(globalThis, name, {
      configurable: true, enumerable: false,
      get() { throw Object.assign(new Error(`R9 touched ${name}`), { touched: name }); },
      set() { throw Object.assign(new Error(`R9 assigned ${name}`), { touched: name }); },
    });
  }
  try {
    for (const path of paths) {
      try { await import(pathToFileURL(join(root, path)).href); } catch (error) {
        const frame = /file:\/\/[^\s)]*?\/((?:extension|app)\/[^\s):]+\.js):(\d+)/.exec(String(error?.stack ?? ''));
        const file = frame ? frame[1] : path;
        const detail = error?.touched ? `import touches the global ${error.touched}` : `import fails: ${error?.code ?? error?.name}: ${String(error?.message).split('\n')[0].slice(0, 120)}`;
        const key = `${file}:${frame?.[2]}:${detail}`;
        if (!seen.has(key)) { seen.add(key); findings.push(Object.freeze({ rule: 'R9', file, line: frame ? Number(frame[2]) : 0, detail })); }
      }
    }
  } finally {
    for (const name of TRAPPED_GLOBALS) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
  return findings;
}

// --- D13: the no-sound scan --------------------------------------------------------------------------------------------------
const joinParts = (...parts) => parts.join('');
// Every forbidden token is assembled here, at runtime, so no line of this file spells one.
const TOKEN = Object.freeze({
  player: joinParts('af', 'play'), screenShare: joinParts('getDisplay', 'Media'), fakeDeviceFlag: joinParts('--use-fake-device-for-', 'media-stream'),
  fakeUiFlag: joinParts('--use-fake-ui-for-', 'media-stream'), driverA: joinParts('pupp', 'eteer'), driverB: joinParts('play', 'wright'),
  launcherPkg: joinParts('chrome', '-launcher'), appleScript: joinParts('osa', 'script'), driverC: joinParts('chrome', 'driver'),
  debugFlag: joinParts('--remote-debugging-', 'port'), headlessFlag: joinParts('--head', 'less'), chromeBin: joinParts('google', '-chrome'),
  chromeBundle: joinParts('Google Chrome', '.app'), chromiumBundle: joinParts('Chromium', '.app'), chromiumBin: joinParts('chromium', '-browser'),
  chromeWin: joinParts('chrome', '.exe'), spawnModule: joinParts('child', '_process'), speech: joinParts('sa', 'y'),
});
const D13_TOKENS = Object.freeze(Object.entries(TOKEN).filter(([name]) => !['spawnModule', 'speech'].includes(name)));
const SPAWN_ALLOWED = Object.freeze(['tests/extension-build.test.mjs', 'tests/extension-tree.test.mjs']);
const GLOBAL_ROOTS = '(?:globalThis|window|self|global)';
const SPAWN_CALL = /(?<![\w$.])(?:(?:cp|childProcess)\s*\.\s*)?(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(/g;
function declaresName(ident, name) {
  const n = escapeRegExp(name);
  return new RegExp(`\\b(?:class|function|const|let|var)\\s+${n}\\b|\\b(?:const|let|var)\\s*[{\\[][^}\\]]*\\b${n}\\b|\\bimport\\b[^;]*?\\b${n}\\b[^;]*?\\bfrom\\b|\\b${n}\\s*=>|\\([^()]*\\b${n}\\b[^()]*\\)\\s*=>|\\bfunction\\b[^(]*\\([^)]*\\b${n}\\b`).test(ident);
}
function d13FindingsFor(path, text) {
  const { code, ident } = lexJs(text);
  const findings = [];
  const add = (detail, index) => findings.push(finding('D13', path, detail, { text: code, index }));
  for (const [name, token] of D13_TOKENS) {
    let from = code.indexOf(token);
    while (from >= 0) { add(`names the forbidden token (${name})`, from); from = code.indexOf(token, from + token.length); }
  }
  const sayLiteral = new RegExp(`(['"\`])(?:[^'"\`\\n]*/)?${TOKEN.speech}\\1`, 'g');
  for (const match of code.matchAll(sayLiteral)) add('a string literal that names the speech command', match.index);
  const constructors = new RegExp(`\\bnew\\s+(?:(${GLOBAL_ROOTS})\\s*\\.\\s*)?((?:webkit)?(?:Offline)?AudioContext)\\s*\\(`, 'g');
  for (const match of ident.matchAll(constructors)) {
    if (match[1] || !declaresName(ident, match[2])) add(`constructs ${match[2]} on the real global; use the injected fake`, match.index);
  }
  const bareNavigator = /(?<![\w$.])navigator\s*\.\s*(?:mediaDevices|getUserMedia|webkitGetUserMedia|mozGetUserMedia)\b/g;
  for (const match of ident.matchAll(bareNavigator)) if (!declaresName(ident, 'navigator')) add('reaches getUserMedia through the real navigator', match.index);
  const rootedNavigator = new RegExp(`\\b${GLOBAL_ROOTS}\\s*\\.\\s*navigator\\s*\\.\\s*(?:mediaDevices|getUserMedia|webkitGetUserMedia|mozGetUserMedia)\\b`, 'g');
  for (const match of ident.matchAll(rootedNavigator)) add('reaches getUserMedia through the global navigator', match.index);
  const bareCapture = /(?<![\w$.])chrome\s*\.\s*tabCapture\b/g;
  for (const match of ident.matchAll(bareCapture)) if (!declaresName(ident, 'chrome')) add('reaches tabCapture through the real chrome global', match.index);
  const rootedCapture = new RegExp(`\\b${GLOBAL_ROOTS}\\s*\\.\\s*chrome\\s*\\.\\s*tabCapture\\b`, 'g');
  for (const match of ident.matchAll(rootedCapture)) add('reaches tabCapture through the global chrome', match.index);
  if (new RegExp(`\\b${TOKEN.spawnModule}\\b`).test(code)) {
    if (!SPAWN_ALLOWED.includes(path)) add('imports the process-spawning module; only extension-build and extension-tree may, and only for node scripts/build-extension.mjs', code.search(new RegExp(`\\b${TOKEN.spawnModule}\\b`)));
    else {
      if (!code.includes('build-extension.mjs')) add('spawns something, but never names scripts/build-extension.mjs', 0);
      for (const match of ident.matchAll(SPAWN_CALL)) {
        const open = match.index + match[0].length - 1;
        const close = closingParen(ident, open);
        const first = code.slice(open + 1, close < 0 ? open + 200 : close).split(',')[0].trim();
        if (match[1] === 'exec' || match[1] === 'execSync') add(`${match[1]}( runs a shell; spawn node directly`, match.index);
        else if (!(first === 'process.execPath' || /^(['"])(?:.*\/)?node\1$/.test(first) || /^[A-Za-z_$][\w$]*$/.test(first))) add(`${match[1]}( starts ${first.slice(0, 40)}, not node`, match.index);
      }
    }
  }
  return findings;
}
async function scanNoSound(root = repoRoot, { self = 'extension-static.test.mjs' } = {}) {
  const names = async (directory) => (await readdir(join(root, directory)).catch(() => [])).sort();
  const paths = [
    ...(await names('tests')).filter((name) => (/^extension-.+\.test\.mjs$/.test(name) && name !== self) || name === 'session-isolated.test.mjs').map((name) => `tests/${name}`),
    ...(await names('tests/fixtures')).filter((name) => /^extension-.+\.mjs$/.test(name) || name === 'fake-chrome.mjs' || name === 'fake-audio.mjs').map((name) => `tests/fixtures/${name}`),
  ];
  const findings = [];
  for (const path of paths) findings.push(...d13FindingsFor(path, await readFile(join(root, path), 'utf8')));
  return Object.freeze({ scanned: Object.freeze(paths), findings: Object.freeze(findings) });
}

// --- everything static, for the mutant baseline ---------------------------------------------------------------------------------
async function scanStatic(root, ctx, { expectedPaths = null } = {}) {
  const tree = await loadTree(root);
  return [
    ...scanLayout(tree, { expectedPaths }), ...scanBuiltinKeySlot(tree), ...scanBans(tree), ...scanSecrets(tree, ctx), ...scanUrls(tree, ctx),
    ...scanChromeIdentifier(tree), ...scanImports(tree), ...scanClosure(tree), ...scanAppBoundary(tree), ...scanClassicScripts(tree), ...scanHtml(tree),
  ];
}

// --- mutant sandboxes --------------------------------------------------------------------------------------------------------------
async function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
/** A temp directory holding a baseline tree; `within` applies changes, runs a scan on the directory, and puts the baseline back. */
async function createSandbox(t, baseline) {
  const root = await mkdtemp(join(tmpdir(), 'interp-ext-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFiles(root, baseline);
  const within = async (changes, run) => {
    const touched = Object.keys(changes);
    try {
      for (const path of touched) {
        const absolute = join(root, path);
        await rm(absolute, { recursive: true, force: true });
        const value = changes[path];
        if (value === null) continue;
        await mkdir(dirname(absolute), { recursive: true });
        if (typeof value === 'object') await symlink(value.symlink, absolute); else await writeFile(absolute, value);
      }
      return await run(root);
    } finally {
      for (const path of touched) {
        await rm(join(root, path), { recursive: true, force: true });
        if (Object.hasOwn(baseline, path)) await writeFile(join(root, path), baseline[path]);
      }
    }
  };
  return Object.freeze({ root, within });
}

const HTML_PAGE = (script) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title data-i18n="ext.name"></title>
  <link rel="stylesheet" href="../../styles.css">
</head>
<body>
  <!-- prose in a comment is ignored: https://example.test/ and onclick="x" -->
  <main id="app"><button id="go" type="button" data-i18n="ext.go" hidden></button></main>
  <script type="module" src="${script}"></script>
</body>
</html>
`;
/** A minimal tree that satisfies every static rule; each mutant changes it in one way. */
const BASELINE = Object.freeze({
  'styles.css': ':root { --x: 1; }\n',
  'extension/manifest.json': JSON.stringify({ manifest_version: 3, content_scripts: [{ matches: ['https://*/*'], js: ['extension/overlay/overlay.js'] }] }),
  'extension/lib/constants.js': '// The words console.log, innerHTML and localStorage in a comment are prose.\nexport const LIMIT = 4;\n',
  'extension/lib/protocol.js': "import { LIMIT } from './constants.js';\nexport const MAX = LIMIT;\n",
  'extension/lib/chrome-adapter.js': 'export function createChromeAdapter(chromeApi = globalThis.chrome) { return { runtime: chromeApi?.runtime }; }\n',
  'extension/lib/links.js': "export const GUIDE_URL = 'https://docs.example.test/guide';\nexport const API = 'wss://api.example.test/v1';\n",
  'extension/lib/builtin-key.js': '// The slot below is the only place a key could ever be written.\nexport const BUILTIN_KEYS = Object.freeze([]);\n',
  'extension/lib/i18n.js': "import { SUPPORTED } from '../../app/i18n/index.js';\nconst label = 'the chrome and browser words in a string, and //not a comment';\nconst note = `browser ${SUPPORTED.length} chrome`;\nexport const load = () => [SUPPORTED, label, note, /chrome|browser/];\n",
  'extension/background/service-worker.js': "import { createServiceWorker } from './sw-core.js';\nimport { createChromeAdapter } from '../lib/chrome-adapter.js';\ncreateServiceWorker(createChromeAdapter()).register();\n",
  'extension/background/sw-core.js': "import { MAX } from '../lib/protocol.js';\nexport const createServiceWorker = (adapter) => ({ register() { return [adapter, MAX]; } });\n",
  'extension/engine/host.html': HTML_PAGE('./host.js'),
  'extension/engine/host.js': "import { createLaneHost } from './lane-host.js';\ncreateLaneHost().start();\n",
  'extension/engine/lane-host.js': "import { MAX } from '../lib/protocol.js';\nimport { APP_CONFIG } from '../../app/config.js';\nexport const createLaneHost = () => ({ start() { return [MAX, APP_CONFIG]; } });\n",
  'extension/engine/worker-timers.js': "export const createWorker = (Worker) => new Worker(new URL('./timer-worker.js', import.meta.url));\n",
  'extension/engine/timer-worker.js': 'globalThis.onmessage = () => {};\n',
  'extension/panel/panel.html': HTML_PAGE('./panel.js'),
  'extension/panel/panel.js': "import { start } from './controller.js';\nstart();\n",
  'extension/panel/controller.js': "import { MAX } from '../lib/protocol.js';\nimport { SUPPORTED } from '../../app/i18n/index.js';\nexport const start = () => [MAX, SUPPORTED];\n",
  'extension/options/options.html': HTML_PAGE('./options.js'),
  'extension/options/options.js': "import { start } from './controller.js';\nstart();\n",
  'extension/options/controller.js': "import { validateKey } from '../../app/security/shared-key.js';\nimport { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';\nexport const start = () => [validateKey, LIVE_MODELS];\n",
  'extension/permission/mic-permission.html': HTML_PAGE('./mic-permission.js'),
  'extension/permission/mic-permission.js': "import { start } from './controller.js';\nstart();\n",
  'extension/permission/controller.js': "import { MAX } from '../lib/protocol.js';\nexport const start = () => MAX;\n",
  'extension/overlay/overlay.js': "(() => {\n  'use strict';\n  const port = chrome.runtime.connect({ name: 'x' });\n  const root = document.createElement('div').attachShadow({ mode: 'closed' });\n  return [port, root];\n})();\n",
  'app/config.js': 'export const APP_CONFIG = {};\n',
  'app/main.js': "import './config.js';\n",
  'app/i18n/index.js': 'export const SUPPORTED = Object.freeze([]);\n',
  'app/i18n/boot-fallback.js': 'export const BOOT = {};\n',
  'app/providers/gemini/live-config.js': 'export const LIVE_MODELS = [];\n',
  'app/engine/listen-state.js': 'export const LISTEN = {};\n',
  'app/engine/sim.js': 'export const createSimEngine = () => ({});\n',
  'app/platform.js': 'export const createPlatform = () => ({});\n',
  'app/security/shared-key.js': 'export const validateKey = () => true;\n',
  'app/security/builtin-key.js': 'export const BUILTIN_KEYS = Object.freeze([]);\n',
});
const FIXTURE_ORIGINS = Object.freeze({
  allowedOrigins: new Set(['https://api.example.test', 'wss://api.example.test', 'https://docs.example.test']),
  documentationUrls: new Set(['https://docs.example.test/guide']),
  documentationFiles: new Set([LINKS]),
  secretMark: 'SECRET',
});

// The registry values and secret patterns come from the app, loaded lazily: importing app/config.js at the top of this file
// would put the app's modules in the module cache before the import-purity probe runs, and a cached module cannot be probed.
let registryPromise;
const loadRegistry = () => {
  registryPromise ??= (async () => {
    const config = await import('../app/config.js');
    const release = await import('../scripts/check-release.mjs');
    // The marker lives in the scenarios fixture (privacy.test.mjs imports it from there); reading the text avoids loading that
    // fixture's whole app import graph, and a renamed constant fails loudly instead of silently scanning for the wrong word.
    const scenarios = await readFile(join(repoRoot, 'tests/fixtures/scenarios.mjs'), 'utf8');
    const secretMark = /export const SECRET_MARK = '([^']+)'/.exec(scenarios)?.[1];
    if (!secretMark) throw new Error('SECRET_MARK is not declared in tests/fixtures/scenarios.mjs');
    // §16: the download site the update check reads. Its two URLs are read from the module's TEXT (importing it here would
    // put it in the module cache before the purity probe) and, like the documentation links, may be written only there.
    const updateText = await readFile(join(repoRoot, UPDATE_CHECK), 'utf8');
    const updateUrls = [...updateText.matchAll(/export const UPDATE_[A-Z]+_URL = '(https:\/\/[^']+)';/g)].map((match) => match[1]);
    if (updateUrls.length !== 2) throw new Error(`${UPDATE_CHECK} must declare UPDATE_SITE_URL and UPDATE_MANIFEST_URL`);
    return Object.freeze({
      allowedOrigins: new Set([...config.ENDPOINT_ORIGINS, ...config.DOCUMENTATION_ORIGINS, ...updateUrls.map((url) => new URL(url).origin)]),
      documentationUrls: new Set([...Object.values(config.DOCUMENTATION_LINKS), ...updateUrls]),
      documentationFiles: new Set([LINKS, UPDATE_CHECK]),
      secretPatterns: release.SECRET_PATTERNS,
      secretMark,
    });
  })();
  return registryPromise;
};

// ===================================================================================================================================
// Real-tree tests. The purity probe comes first: it imports the real modules and must see them before anything else does.
// ===================================================================================================================================

test('real tree R9/R10: every non-entry extension module imports without touching chrome, document, window, navigator, storage, AudioContext, fetch or timers', async () => {
  const tree = await loadTree(repoRoot);
  const modules = nonEntryModules(tree);
  // A probe over an empty or partial directory would be green for nothing: name the modules it must cover, with their owners.
  const mustProbe = ['extension/lib/constants.js', 'extension/lib/protocol.js', 'extension/lib/settings.js', 'extension/lib/i18n.js',
    'extension/background/sw-core.js', 'extension/engine/lane-host.js', 'extension/engine/lane-engine.js', 'extension/panel/controller.js',
    'extension/options/controller.js', 'extension/permission/controller.js'];
  assert.deepEqual(mustProbe.filter((path) => !modules.includes(path)).map((path) => `${path} (group ${ownerOf(path)})`), [], 'modules that must be probed');
  const findings = await probeImportPurity(repoRoot, modules);
  assert.deepEqual(render(findings), [], 'import purity');
  assertTrapsRemoved();
});

for (const group of ['A', 'B', 'C', 'D']) {
  test(`real tree §3.1: every extension/ file owned by group ${group} exists and is not empty`, async () => {
    const findings = await scanMissing(repoRoot, EXPECTED_FILES.filter(([owner]) => owner === group));
    assert.deepEqual(render(findings), []);
  });
  test(`real tree §11.1: every test file and fixture owned by group ${group} exists and is not empty`, async () => {
    const findings = await scanMissing(repoRoot, EXPECTED_TESTS.filter(([owner]) => owner === group));
    assert.deepEqual(render(findings), []);
  });
}

test('real tree §3.1/§10.2/R13: no stray file, no unlisted file type, safe path segments, no symlink', async () => {
  const tree = await loadTree(repoRoot);
  assert.ok(jsFiles(tree, 'extension/').length > 0 && jsFiles(tree, 'app/').length > 0);
  assert.deepEqual(render(scanLayout(tree, { expectedPaths: new Set(EXPECTED_FILES.map(([, path]) => path)) })), []);
});

test('real tree R11: no console, eval, new Function, markup sinks, importScripts, web storage, debugger, require, iframe; attachShadow only closed and only in overlay.js', async () => {
  const tree = await loadTree(repoRoot);
  assert.deepEqual(render(scanBans(tree)), []);
});

test('real tree R11/D8: no key-shaped string anywhere under extension/, the built-in key slot is empty in source, URL literals stay inside the registered origins', async () => {
  const ctx = await loadRegistry();
  const tree = await loadTree(repoRoot);
  assert.ok(ctx.secretPatterns.length >= 8 && ctx.allowedOrigins.has('wss://generativelanguage.googleapis.com'), 'the registry the scans use is the real one');
  assert.deepEqual(render(scanSecrets(tree, ctx)), []);
  assert.deepEqual(render(scanBuiltinKeySlot(tree)), []);
  assert.deepEqual(render(scanUrls(tree, ctx)), []);
});

test('real tree R8: the identifier chrome or browser appears only in chrome-adapter.js (as a parameter default) and overlay.js', async () => {
  const tree = await loadTree(repoRoot);
  assert.deepEqual(render(scanChromeIdentifier(tree)), []);
});

test('real tree R1-R7: import direction, ownership allowlists, relative resolvable specifiers, and a closure that never reaches app/main.js or the app key slot', async () => {
  const tree = await loadTree(repoRoot);
  assert.deepEqual(render(scanImports(tree)), []);
  assert.deepEqual(render(scanClosure(tree)), []);
});

test('real tree R1/D14: app/ never names extension/ and holds no ext.* key literal', async () => {
  const tree = await loadTree(repoRoot);
  assert.ok(jsFiles(tree, 'app/').length > 50, 'the app tree was read');
  assert.deepEqual(render(scanAppBoundary(tree)), []);
});

test('real tree R3/D6: overlay.js and every manifest content script parse as classic scripts, are one IIFE and hold no import, export or require', async () => {
  const tree = await loadTree(repoRoot);
  assert.deepEqual(render(scanClassicScripts(tree)), []);
});

test('real tree R12/D1: every extension HTML file has module scripts with a src, no inline handler, no remote URL, relative resolvable links, no literal text and no iframe', async () => {
  const tree = await loadTree(repoRoot);
  assert.ok([...tree.files.keys()].some((path) => path.endsWith('.html')), 'HTML files exist');
  assert.deepEqual(render(scanHtml(tree)), []);
});

test('real tree D13: no extension test or fixture launches a browser, makes sound, or reaches a real audio or capture object', async () => {
  const result = await scanNoSound(repoRoot);
  for (const path of ['tests/fixtures/fake-chrome.mjs', 'tests/fixtures/fake-audio.mjs', 'tests/fixtures/extension-dom.mjs', 'tests/session-isolated.test.mjs']) {
    assert.ok(result.scanned.includes(path), `${path} is covered by the scan`);
  }
  assert.ok(result.scanned.filter((path) => /^tests\/extension-.+\.test\.mjs$/.test(path)).length >= 5, 'the extension test files are covered');
  assert.equal(result.scanned.includes('tests/extension-static.test.mjs'), false, 'this file is excluded, as §11.1 says');
  assert.deepEqual(render(result.findings), []);
});

test('the lexer keeps every existing repository source balanced (guards all real-tree scans against a mis-lexed file)', async () => {
  const paths = [];
  for (const directory of ['app', 'scripts', 'tests']) {
    for (const entry of await listFiles(repoRoot, directory)) {
      if (/\.(?:js|mjs)$/.test(entry.path) && !entry.symlink && !/extension-/.test(entry.path)) paths.push(entry.path);
    }
  }
  assert.ok(paths.length > 100, `${paths.length} files lexed`);
  const bad = [];
  for (const path of paths) {
    const source = await readFile(join(repoRoot, path), 'utf8');
    const { code, ident } = lexJs(source);
    assert.equal(code.length, source.length);
    assert.equal(ident.length, source.length);
    const at = unbalancedAt(ident);
    if (at >= 0) bad.push(`${path}:${lineOf(source, Math.min(at, source.length - 1))}`);
  }
  assert.deepEqual(bad, []);
});

// ===================================================================================================================================
// Scanner proofs: the clean baseline is quiet, and every rule fires on a mutant built from strings.
// ===================================================================================================================================

test('lexer: comments go, strings and regexps stay where they must, and a slash inside a string never eats the line', () => {
  const at = (source) => lexJs(source);
  let views = at("const a = 'x // not a comment'; // real comment console.log\nconst b = 2;");
  assert.ok(views.code.includes('x // not a comment') && !views.code.includes('real comment') && views.code.includes('const b = 2;'));
  assert.ok(!views.ident.includes('not a comment') && views.ident.includes('const b = 2;'));
  views = at('/* console.log(1) */ const c = 1;');
  assert.equal(views.code.includes('console'), false);
  views = at('const s = "/* nope */ console.log(1)";');
  assert.ok(views.code.includes('console.log(1)') && !views.ident.includes('console'));
  views = at("const r = /['\"]\\/\\//g; console.log(1); // tail");
  assert.ok(views.code.includes('console.log(1)') && !views.code.includes('tail'), 'a regexp with quotes and slashes is one token');
  assert.equal(views.ident.includes('console.log(1)'), true);
  assert.equal(views.ident.includes("'"), false, 'the regexp body is blanked in the identifier view');
  views = at('const q = a / b; const w = c / d; // tail\nconst z = 1;');
  assert.ok(!views.code.includes('tail') && views.code.includes('const z = 1;'), 'division is not a regexp');
  views = at("const e = 'it\\'s // fine'; const f = 1; // gone");
  assert.ok(views.code.includes("it\\'s // fine") && !views.code.includes('gone') && views.ident.includes('const f = 1;'));
  views = at("// don't\nconst g = 1;");
  assert.ok(views.code.includes('const g = 1;') && views.ident.includes('const g = 1;'));
  views = at("const bad = 'unterminated\nconst h = 1;");
  assert.ok(views.ident.includes('const h = 1;'), 'an unterminated string ends at the line break');
  views = at('#!/usr/bin/env node\nconst i = 1;');
  assert.ok(views.code.includes('const i = 1;') && !views.code.includes('usr'));
  views = at('function f() { return /a\\/b/.test(x) ? 1 : y / 2; } // end');
  assert.ok(!views.code.includes('end') && views.ident.includes('? 1 : y / 2;'));
});

test('lexer: template literals keep their expressions, blank their text, and nest', () => {
  const tick = String.fromCharCode(96);
  const open = '$' + '{';
  const source = ['const t = ', tick, 'text ', open, ' f(', tick, 'inner ', open, 'c}', tick, ') } tail', tick, '; const after = 1; // gone\nconst n = 2;'].join('');
  const { code, ident } = lexJs(source);
  assert.ok(code.includes('text ') && code.includes('inner ') && !code.includes('gone') && code.includes('const n = 2;'));
  assert.equal(ident.replace(/\s+/g, ' '), 'const t = f( c ) ; const after = 1; const n = 2;');
  const brace = ['const u = ', tick, open, '{ a: 1 }.a', '}', tick, '; const v = /x/.test(u); // gone'].join('');
  const braced = lexJs(brace);
  assert.ok(braced.ident.includes('{ a: 1 }.a') && braced.ident.includes('.test(u);') && !braced.code.includes('gone'));
});

test('lexer: brackets in strings, regexps and templates never unbalance the identifier view', () => {
  const tick = String.fromCharCode(96);
  const source = ['const a = "(((" + \'{{\' + /[({]/.source + ', tick, '}}}', tick, ';\nfunction f() { return [1]; }\n'].join('');
  assert.equal(unbalancedAt(lexJs(source).ident), -1);
  assert.notEqual(unbalancedAt('function f() { (] }'), -1);
  assert.equal(closingParen('f(a(b)c)d', 1), 7);
});

test('scanner baseline: the clean mini tree yields no finding under any static rule, and the scans do see it', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const tree = await loadTree(sandbox.root);
  assert.ok(jsFiles(tree, 'extension/').length >= 15 && jsFiles(tree, 'app/').length >= 8 && tree.files.has('styles.css'), 'the loader read the baseline');
  assert.deepEqual(render(await scanStatic(sandbox.root, ctx)), []);
  assert.deepEqual(nonEntryModules(tree).includes('extension/lib/i18n.js'), true);
  assert.equal(nonEntryModules(tree).some((path) => ENTRY_FILES.includes(path)), false);
});

const secretSamples = () => {
  const filler = 'x'.repeat(32);
  return [
    joinParts('AI', 'za', filler), joinParts('s', 'k-', filler), joinParts('gh', 'p_', filler.repeat(2)), joinParts('xo', 'xb-', filler),
    joinParts('-----BEGIN ', 'PRIVATE KEY-----'), joinParts('e', 'yJ', filler, '.', 'e', 'yJ', filler, '.', filler), joinParts('#sha', 'red=%7B'),
    `${joinParts('api', '_key')} = '${filler}'`,
  ];
};

const BAN_CASES = Object.freeze([
  ['console', "export const f = () => console.log(1);\n", 'R11-console'],
  ['console after a slash inside a string', "const u = 'a//b'; console.warn(u);\n", 'R11-console'],
  ['console after a block-comment marker inside a string', "const u = '/* x */'; console.error(u);\n", 'R11-console'],
  ['console after a regexp literal holding slashes', "const r = /\\/\\//; console.info(r);\n", 'R11-console'],
  ['console inside a template expression', 'export const f = () => `x ${console.log(1)} y`;\n', 'R11-console'],
  ['eval', 'export const f = (s) => eval(s);\n', 'R11-eval'],
  ['new Function', "export const f = () => new Function('return 1');\n", 'R11-new-function'],
  ['innerHTML', "export const f = (el) => { el.innerHTML = 'x'; };\n", 'R11-inner-outer-html'],
  ['outerHTML', 'export const f = (el) => el.outerHTML;\n', 'R11-inner-outer-html'],
  ['innerHTML by bracket key', "export const f = (el) => el['innerHTML'];\n", 'R11-inner-outer-html'],
  ['insertAdjacentHTML', "export const f = (el) => el.insertAdjacentHTML('beforeend', 'x');\n", 'R11-insert-adjacent-html'],
  ['document.write', "export const f = () => document.write('x');\n", 'R11-document-write'],
  ['importScripts', "export const f = () => importScripts('x.js');\n", 'R11-import-scripts'],
  ['localStorage', "export const f = () => localStorage.getItem('k');\n", 'R11-local-storage'],
  ['sessionStorage', "export const f = () => sessionStorage.getItem('k');\n", 'R11-session-storage'],
  ['indexedDB', "export const f = () => indexedDB.open('k');\n", 'R11-indexed-db'],
  ['debugger', 'export const f = () => { debugger; };\n', 'R11-debugger'],
  ['require', "export const f = () => require('x');\n", 'R11-require'],
  ['an iframe element', "export const f = () => document.createElement('iframe');\n", 'D1'],
  ['an iframe in markup text', "export const f = () => '<iframe src=x>';\n", 'D1'],
]);

test('scanner R11: every ban fires on a mutant, wherever the code sits in the file, and prose in comments does not', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  for (const [name, source, rule] of BAN_CASES) {
    const findings = await sandbox.within({ 'extension/lib/extra.js': source }, (root) => scanStatic(root, ctx));
    assert.deepEqual(rulesOf(findings), [rule], name);
    assert.ok(render(findings)[0].includes('extension/lib/extra.js:'), `${name}: reported with file and line`);
  }
  // Prose that merely mentions a banned token in a comment is not a violation.
  const prose = "// console.log eval( innerHTML localStorage debugger importScripts( document.write\n/* new Function( sessionStorage indexedDB <iframe */\nexport const ok = 1;\n";
  assert.deepEqual(rulesOf(await sandbox.within({ 'extension/lib/extra.js': prose }, (root) => scanStatic(root, ctx))), []);
  // The same ban fires in every extension directory, not just lib/.
  for (const path of ['extension/background/x.js', 'extension/engine/x.js', 'extension/panel/x.js', 'extension/options/x.js', 'extension/permission/x.js']) {
    const findings = await sandbox.within({ [path]: 'export const f = () => console.log(1);\n' }, (root) => scanStatic(root, ctx));
    assert.deepEqual(rulesOf(findings), ['R11-console'], path);
  }
  // Only extension/ is scanned by this rule: the app may keep what it has (privacy.test.mjs owns app/).
  assert.deepEqual(rulesOf(await sandbox.within({ 'app/x.js': 'export const f = () => console.log(1);\n' }, (root) => scanStatic(root, ctx))), []);
});

test('scanner R11: attachShadow is only ever called in overlay.js and only closed', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const overlay = (call) => `(() => {\n  'use strict';\n  const root = document.createElement('div').${call};\n  return root;\n})();\n`;
  const cases = [
    ['open mode', { [OVERLAY]: overlay("attachShadow({ mode: 'open' })") }],
    ['no mode', { [OVERLAY]: overlay('attachShadow({})') }],
    ['a computed argument', { [OVERLAY]: overlay('attachShadow(options)') }],
    ['closed but outside overlay.js', { 'extension/lib/extra.js': "export const f = (el) => el.attachShadow({ mode: 'closed' });\n" }],
  ];
  for (const [name, changes] of cases) assert.deepEqual(rulesOf(await sandbox.within(changes, (root) => scanStatic(root, ctx))), ['R11-shadow'], name);
  assert.deepEqual(rulesOf(await sandbox.within({ [OVERLAY]: overlay('attachShadow({ mode: "closed" })') }, (root) => scanStatic(root, ctx))), [], 'double quotes, closed');
});

test('scanner R11: key-shaped strings and the secret marker are found in JavaScript, HTML, CSS and JSON under extension/', async (t) => {
  const registry = await loadRegistry();
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: registry.secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const samples = secretSamples();
  for (const pattern of registry.secretPatterns) assert.ok(samples.some((sample) => pattern.test(sample)), `a sample exists for ${pattern.source.slice(0, 30)}`);
  for (const [index, sample] of samples.entries()) {
    const asJs = await sandbox.within({ 'extension/lib/extra.js': `export const k = '${sample}';\n` }, (root) => scanStatic(root, ctx));
    assert.deepEqual(rulesOf(asJs), ['R11-key'], `js sample ${index}`);
    const asJson = await sandbox.within({ 'extension/i18n/en.json': JSON.stringify({ 'ext.a': sample }) }, (root) => scanStatic(root, ctx));
    assert.deepEqual(rulesOf(asJson), ['R11-key'], `json sample ${index}`);
  }
  const inAttribute = await sandbox.within({ 'extension/panel/panel.html': HTML_PAGE('./panel.js').replace('</main>', `<p data-x="${samples[0]}"></p></main>`) }, (root) => scanStatic(root, ctx));
  assert.deepEqual(rulesOf(inAttribute), ['R11-key'], 'a key in an HTML attribute');
  const inText = await sandbox.within({ 'extension/panel/panel.html': HTML_PAGE('./panel.js').replace('</main>', `<p>${samples[0]}</p></main>`) }, (root) => scanStatic(root, ctx));
  assert.deepEqual(rulesOf(inText), ['R11-key', 'R12'], 'a key in HTML text is reported, and it is literal text too');
  const css = await sandbox.within({ 'extension/pages.css': `/* ${samples[1]} */ body { color: red; }\n` }, (root) => scanStatic(root, ctx));
  assert.deepEqual(rulesOf(css), ['R11-key']);
  const marker = await sandbox.within({ 'extension/lib/extra.js': `export const k = 'has ${FIXTURE_ORIGINS.secretMark} inside';\n` }, (root) => scanStatic(root, ctx));
  assert.deepEqual(rulesOf(marker), ['R11-key']);
  const inComment = await sandbox.within({ 'extension/lib/extra.js': `// ${samples[0]} ${FIXTURE_ORIGINS.secretMark}\nexport const k = 1;\n` }, (root) => scanStatic(root, ctx));
  assert.deepEqual(rulesOf(inComment), [], 'JavaScript is scanned with comments removed, like privacy.test.mjs');
  // The built-in key slot: source stays the empty list, written exactly once.
  const filled = "export const BUILTIN_KEYS = Object.freeze(['a']);\n";
  assert.deepEqual(rulesOf(await sandbox.within({ [BUILTIN_KEY]: filled }, (root) => scanStatic(root, ctx))), ['R11-key']);
  const twice = `${BASELINE[BUILTIN_KEY]}export const BUILTIN_KEYS = Object.freeze([]);\n`;
  assert.deepEqual(rulesOf(await sandbox.within({ [BUILTIN_KEY]: twice }, (root) => scanStatic(root, ctx))), ['R11-key']);
});

test('scanner R11: URL literals are limited to the registered origins, and a documentation link lives only in links.js', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const url = (source, file = 'extension/lib/extra.js') => sandbox.within({ [file]: source }, (root) => scanStatic(root, ctx));
  assert.deepEqual(rulesOf(await url("export const u = 'https://evil.example.test/x';\n")), ['R11-url']);
  assert.deepEqual(rulesOf(await url("export const u = 'wss://evil.example.test/x';\n")), ['R11-url']);
  assert.deepEqual(rulesOf(await url("export const u = 'http://api.example.test/x';\n")), ['R11-url'], 'the scheme is part of the origin');
  assert.deepEqual(rulesOf(await url("export const u = 'https://[bad';\n")), ['R11-url'], 'an unparsable URL literal is reported, never thrown');
  assert.deepEqual(rulesOf(await url('export const u = `https://evil.example.test/${1}`;\n')), ['R11-url']);
  assert.deepEqual(rulesOf(await url("export const u = 'https://api.example.test/v1?a=1';\n")), []);
  assert.deepEqual(rulesOf(await url("export const u = 'wss://api.example.test/live';\n")), []);
  assert.deepEqual(rulesOf(await url("export const u = 'https://docs.example.test/guide';\n")), ['R11-url'], 'the exact documentation URL outside links.js');
  assert.deepEqual(rulesOf(await url("export const u = 'https://docs.example.test/other';\n")), [], 'another URL on a documentation origin is fine');
  assert.deepEqual(rulesOf(await url("// https://evil.example.test/x\nexport const u = 1;\n")), [], 'a URL in a comment is prose');
});

test('scanner R8: chrome and browser are identifiers only in chrome-adapter.js (parameter default) and overlay.js; strings and comments never count', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const rules = async (changes) => rulesOf(await sandbox.within(changes, (root) => scanStatic(root, ctx)));
  assert.deepEqual(await rules({ 'extension/lib/extra.js': 'export const f = () => chrome.runtime.id;\n' }), ['R8']);
  assert.deepEqual(await rules({ 'extension/lib/extra.js': 'export const f = () => globalThis.chrome;\n' }), ['R8']);
  assert.deepEqual(await rules({ 'extension/lib/extra.js': 'export const f = (browser) => browser;\n' }), ['R8']);
  assert.deepEqual(await rules({ 'extension/background/x.js': 'export const f = () => typeof chrome;\n' }), ['R8']);
  assert.deepEqual(await rules({ 'extension/engine/x.js': 'export const f = (api) => api.chrome;\n' }), ['R8'], 'a property named chrome is still the identifier');
  assert.deepEqual(await rules({ 'extension/panel/x.js': 'export const f = `${browser}`;\n' }), ['R8'], 'code inside a template expression is code');
  assert.deepEqual(await rules({ [CHROME_ADAPTER]: 'export function createChromeAdapter(chromeApi = globalThis.chrome) { const c = chrome; return [chromeApi, c]; }\n' }), ['R8'], 'a second use inside the adapter');
  assert.deepEqual(await rules({ [CHROME_ADAPTER]: 'export function createChromeAdapter(chromeApi = chrome) { return chromeApi; }\n' }), [], 'a bare default is also a parameter default');
  assert.deepEqual(await rules({ [CHROME_ADAPTER]: 'export function createChromeAdapter(a, chromeApi = globalThis.chrome, b = 1) { return [a, chromeApi, b]; }\n' }), []);
  assert.deepEqual(await rules({ [CHROME_ADAPTER]: 'export function createChromeAdapter(chromeApi = globalThis.chrome) { return browser; }\n' }), ['R8']);
  assert.deepEqual(await rules({ 'extension/lib/extra.js': "// chrome browser\nexport const a = 'chrome browser';\nexport const b = `chrome ${1} browser`;\nexport const c = /chrome|browser/;\nexport const chromeApi = 1;\nexport const browserish = 2;\n" }), []);
  assert.deepEqual(await rules({ [OVERLAY]: "(() => {\n  'use strict';\n  const a = chrome.runtime.id;\n  const b = typeof browser;\n  return [a, b, chrome.i18n.getMessage('x')];\n})();\n" }), [], 'overlay.js may name both freely');
});

const IMPORT_CASES = Object.freeze([
  // [name, changes, expected rules]
  ['R1: app imports extension', { 'app/x.js': "import { LIMIT } from '../extension/lib/constants.js';\nexport const y = LIMIT;\n" }, ['R1']],
  ['R1: app re-exports extension', { 'app/x.js': "export { LIMIT } from '../extension/lib/constants.js';\n" }, ['R1']],
  ['R1: app names extension/ in a string', { 'app/x.js': "export const p = 'extension/lib/constants.js';\n" }, ['R1']],
  ['R1/D14: app holds an ext. key literal', { 'app/x.js': "export const k = 'ext.status.partial';\n" }, ['R1']],
  ['R1/D14: an ext. literal in a template', { 'app/x.js': 'export const k = `ext.status.partial`;\n' }, ['R1']],
  ['R1: a closure that reaches app/main.js through an allowed module', { 'app/i18n/index.js': "import '../main.js';\nexport const SUPPORTED = Object.freeze([]);\n" }, ['R1-closure']],
  ['R1: a closure that reaches the app key slot', { 'app/security/shared-key.js': "import './builtin-key.js';\nexport const validateKey = () => true;\n" }, ['R1-closure']],
  ['R2: background imports an app module directly', { 'extension/background/sw-core.js': "import { SUPPORTED } from '../../app/i18n/index.js';\nexport const createServiceWorker = () => SUPPORTED;\n" }, ['R2']],
  ['R2: background imports the engine', { 'extension/background/sw-core.js': "import { createLaneHost } from '../engine/lane-host.js';\nexport const createServiceWorker = () => createLaneHost;\n" }, ['R2']],
  ['R2: background imports a page directory', { 'extension/background/sw-core.js': "import { start } from '../panel/controller.js';\nexport const createServiceWorker = () => start;\n" }, ['R2']],
  ['R4: lib imports an app module that is not on the list', { 'extension/lib/extra.js': "import { APP_CONFIG } from '../../app/config.js';\nexport const y = APP_CONFIG;\n" }, ['R4']],
  ['R4: lib imports the engine directory', { 'extension/lib/extra.js': "import { createLaneHost } from '../engine/lane-host.js';\nexport const y = createLaneHost;\n" }, ['R4']],
  ['R4: lib imports a background module', { 'extension/lib/extra.js': "import { createServiceWorker } from '../background/sw-core.js';\nexport const y = createServiceWorker;\n" }, ['R4']],
  ['R4: constants.js imports something', { 'extension/lib/constants.js': "import { API } from './links.js';\nexport const LIMIT = API;\n" }, ['R4']],
  ['R4: links.js imports something', { [LINKS]: "import { LIMIT } from './constants.js';\nexport const GUIDE_URL = LIMIT;\n" }, ['R4']],
  ['R4: chrome-adapter.js imports something', { [CHROME_ADAPTER]: "import { LIMIT } from './constants.js';\nexport const createChromeAdapter = (chromeApi = globalThis.chrome) => [chromeApi, LIMIT];\n" }, ['R4']],
  ['R4: builtin-key.js imports something', { [BUILTIN_KEY]: "import { LIMIT } from './constants.js';\nexport const BUILTIN_KEYS = Object.freeze([]);\n" }, ['R4']],
  ['R4: protocol.js imports settings', { 'extension/lib/protocol.js': "import { LIMIT } from './constants.js';\nimport { S } from './settings.js';\nexport const MAX = [LIMIT, S];\n", 'extension/lib/settings.js': 'export const S = 1;\n' }, ['R4']],
  ['R4: protocol.js imports an app module', { 'extension/lib/protocol.js': "import { LISTEN } from '../../app/engine/listen-state.js';\nexport const MAX = LISTEN;\n" }, ['R4']],
  ['R5: engine imports a page directory', { 'extension/engine/lane-host.js': "import { start } from '../panel/controller.js';\nexport const createLaneHost = () => start;\n" }, ['R5']],
  ['R5: engine imports the web app entry', { 'extension/engine/lane-host.js': "import { x } from '../../app/main.js';\nexport const createLaneHost = () => x;\n" }, ['R1-closure', 'R5']],
  ['R5: engine imports an app module that is not on the list', { 'extension/engine/lane-host.js': "import { validateKey } from '../../app/security/shared-key.js';\nexport const createLaneHost = () => validateKey;\n" }, ['R5']],
  ['R5: engine imports the background', { 'extension/engine/lane-host.js': "import { createServiceWorker } from '../background/sw-core.js';\nexport const createLaneHost = () => createServiceWorker;\n" }, ['R5']],
  ['R6: panel imports options', { 'extension/panel/controller.js': "import { start } from '../options/controller.js';\nexport { start };\n" }, ['R6']],
  ['R6: panel imports live-config (options only)', { 'extension/panel/controller.js': "import { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';\nexport const start = () => LIVE_MODELS;\n" }, ['R6']],
  ['R6: panel imports shared-key (options only)', { 'extension/panel/controller.js': "import { validateKey } from '../../app/security/shared-key.js';\nexport const start = () => validateKey;\n" }, ['R6']],
  ['R6: permission imports shared-key (options only)', { 'extension/permission/controller.js': "import { validateKey } from '../../app/security/shared-key.js';\nexport const start = () => validateKey;\n" }, ['R6']],
  ['R6: permission imports the engine', { 'extension/permission/controller.js': "import { createLaneHost } from '../engine/lane-host.js';\nexport const start = () => createLaneHost;\n" }, ['R6']],
  ['R6: options imports the sim engine', { 'extension/options/controller.js': "import { createSimEngine } from '../../app/engine/sim.js';\nexport const start = () => createSimEngine;\n" }, ['R6']],
  ['R3/R6: overlay imports something', { [OVERLAY]: "import { LIMIT } from '../lib/constants.js';\n(() => { 'use strict'; return LIMIT; })();\n" }, ['R3']],
  ['R7: a bare specifier', { 'extension/lib/extra.js': "import x from 'left-pad';\nexport const y = x;\n" }, ['R7']],
  ['R7: an absolute path', { 'extension/lib/extra.js': "import x from '/app/config.js';\nexport const y = x;\n" }, ['R7']],
  ['R7: a URL', { 'extension/lib/extra.js': "import x from 'https://cdn.example.test/x.js';\nexport const y = x;\n" }, ['R11-url', 'R7']],
  ['R7: the extension scheme', { 'extension/lib/extra.js': "import x from 'chrome-extension://abc/x.js';\nexport const y = x;\n" }, ['R7']],
  ['R7: a specifier that does not resolve', { 'extension/lib/extra.js': "import x from './missing.js';\nexport const y = x;\n" }, ['R7']],
  ['R7: a specifier without an extension', { 'extension/lib/extra.js': "import x from './constants';\nexport const y = x;\n" }, ['R7']],
  ['R7: a css import', { 'extension/lib/extra.js': "import x from './x.css';\nexport const y = x;\n", 'extension/lib/x.css': 'a {}\n' }, ['R7']],
  ['R7: a target outside extension/ and app/', { 'extension/lib/extra.js': "import x from '../../scripts/x.js';\nexport const y = x;\n" }, ['R7']],
  ['R7: the manifest as an import target', { 'extension/lib/extra.js': "import x from '../manifest.json';\nexport const y = x;\n" }, ['R7']],
  ['R7: a dynamic import with a variable', { 'extension/lib/extra.js': 'export const f = (name) => import(name);\n' }, ['R7']],
  ['R7: a dynamic import with a template', { 'extension/lib/extra.js': 'export const f = (name) => import(`./${name}.js`);\n' }, ['R7']],
  ['R7: a dynamic import of a URL', { 'extension/lib/extra.js': "export const f = () => import('https://cdn.example.test/x.js');\n" }, ['R11-url', 'R7']],
  ['R4: a dynamic import of a forbidden module', { 'extension/lib/extra.js': "export const f = () => import('../engine/lane-host.js');\n" }, ['R4']],
  ['R4: a re-export from a forbidden module', { 'extension/lib/extra.js': "export * from '../engine/lane-host.js';\n" }, ['R4']],
  ['R4: a side-effect import of a forbidden module', { 'extension/lib/extra.js': "import '../engine/lane-host.js';\nexport const y = 1;\n" }, ['R4']],
  ['R5: a worker URL that leaves the directory', { 'extension/engine/worker-timers.js': "export const w = (Worker) => new Worker(new URL('../panel/controller.js', import.meta.url));\n" }, ['R5']],
  ['R7: a worker URL that does not resolve', { 'extension/engine/worker-timers.js': "export const w = (Worker) => new Worker(new URL('./nope.js', import.meta.url));\n" }, ['R7']],
  ['R7: a file outside every known directory imports something', { 'extension/x/extra.js': "import { LIMIT } from '../lib/constants.js';\nexport const y = LIMIT;\n" }, ['R7']],
  ['R10: a page loads a module that is not an entry', { 'extension/panel/panel.html': HTML_PAGE('./controller.js') }, ['R10']],
]);
const GOOD_IMPORT_CASES = Object.freeze([
  ['R4: lib imports each listed app module', { 'extension/lib/extra.js': ['i18n/index.js', 'i18n/boot-fallback.js', 'providers/gemini/live-config.js', 'engine/listen-state.js', 'security/shared-key.js'].map((file, index) => `import * as m${index} from '../../app/${file}';`).join('\n').concat('\nexport const y = [m0, m1, m2, m3, m4];\n') }],
  ['R5: engine imports each listed app module', { 'extension/engine/extra.js': ['config.js', 'engine/sim.js', 'platform.js', 'providers/gemini/live-config.js'].map((file, index) => `import * as m${index} from '../../app/${file}';`).join('\n').concat('\nexport const y = [m0, m1, m2, m3];\n') }],
  ['R6: options imports its three listed app modules', { 'extension/options/extra.js': ['i18n/index.js', 'providers/gemini/live-config.js', 'security/shared-key.js'].map((file, index) => `import * as m${index} from '../../app/${file}';`).join('\n').concat('\nexport const y = [m0, m1, m2];\n') }],
  ['R6: a page imports lib and its own directory', { 'extension/panel/extra.js': "import { MAX } from '../lib/protocol.js';\nimport { start } from './controller.js';\nexport const y = [MAX, start];\n" }],
  ['R2: background imports lib and background', { 'extension/background/extra.js': "import { MAX } from '../lib/protocol.js';\nimport { createServiceWorker } from './sw-core.js';\nexport const y = [MAX, createServiceWorker];\n" }],
  ['R7: a JSON import inside lib', { 'extension/lib/extra.js': "import data from './data.json';\nexport const y = data;\n", 'extension/lib/data.json': '{}\n' }],
  ['an import statement written inside a comment or a string is not an edge', { 'extension/lib/extra.js': "// import x from 'left-pad';\nexport const s = \"import y from 'left-pad'\";\n" }],
]);

test('scanner R1-R7 and the closure: every direction, ownership, resolution and specifier rule fires on a mutant; the allowed edges stay quiet', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  for (const [name, changes, expected] of IMPORT_CASES) {
    const findings = await sandbox.within(changes, (root) => scanStatic(root, ctx));
    assert.deepEqual(rulesOf(findings), expected, `${name}: ${JSON.stringify(render(findings))}`);
  }
  for (const [name, changes] of GOOD_IMPORT_CASES) {
    const findings = await sandbox.within(changes, (root) => scanStatic(root, ctx));
    assert.deepEqual(render(findings), [], name);
  }
});

test('scanner R13 and layout: unsafe names, symlinks, foreign file types, stray files and missing files are reported, each with its owner group', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const expectedPaths = new Set(Object.keys(BASELINE).filter((path) => path.startsWith('extension/')));
  const run = (changes) => sandbox.within(changes, (root) => scanStatic(root, ctx, { expectedPaths }));
  assert.deepEqual(render(await run({})), [], 'the baseline is exactly its own expected list');
  assert.deepEqual(rulesOf(await run({ 'extension/lib/my file.js': 'export const a = 1;\n' })), ['R13', 'S3.1-stray']);
  assert.deepEqual(rulesOf(await run({ 'extension/lib/a+b.js': 'export const a = 1;\n' })), ['R13', 'S3.1-stray']);
  assert.deepEqual(rulesOf(await run({ 'app/odd name.js': 'export const a = 1;\n' })), ['R13'], 'R13 covers app/ too');
  assert.deepEqual(rulesOf(await run({ 'extension/lib/notes.md': 'text\n' })), ['S3.1-stray', 'S3.1-type']);
  assert.deepEqual(rulesOf(await run({ 'extension/lib/logo.png': 'not text\n' })), ['S3.1-stray', 'S3.1-type']);
  assert.deepEqual(rulesOf(await run({ 'extension/lib/extra.js': 'export const a = 1;\n' })), ['S3.1-stray']);
  assert.deepEqual(rulesOf(await run({ 'extension/lib/.DS_Store': 'junk' })), [], 'dotfiles are skipped, as the build skips them');
  assert.deepEqual(rulesOf(await run({ 'extension/lib/link.js': { symlink: 'constants.js' } })), ['R13'], 'a symlink is refused');
  // Missing and empty files carry the owner group.
  const list = [['B', 'extension/lib/constants.js'], ['C', 'extension/lib/missing-one.js'], ['D', 'extension/lib/empty-one.js']];
  const missing = await sandbox.within({ 'extension/lib/empty-one.js': '' }, (root) => scanMissing(root, list));
  assert.deepEqual(render(missing), [
    'MISSING extension/lib/missing-one.js [group C] does not exist or is empty',
    'MISSING extension/lib/empty-one.js [group D] does not exist or is empty',
  ]);
  const real = await scanMissing(sandbox.root, [['A', 'extension/lib/builtin-key.js']]);
  assert.deepEqual(real, []);
  const named = await scanMissing(sandbox.root, [['B', 'extension/engine/lane-host.js'], ['C', 'extension/panel/view-model.js']]);
  assert.deepEqual(render(named), ['MISSING extension/panel/view-model.js [group C] does not exist or is empty']);
  // The section 3.1 table itself: every path is unique, sits under extension/, and names a known group.
  assert.equal(new Set(EXPECTED_FILES.map(([, path]) => path)).size, EXPECTED_FILES.length);
  assert.ok(EXPECTED_FILES.every(([group, path]) => 'ABCD'.includes(group) && path.startsWith('extension/')));
  assert.ok(ENTRY_FILES.every((path) => EXPECTED_FILES.some(([, expected]) => expected === path)), 'every R10 entry is on the §3.1 list');
  assert.equal(EXPECTED_FILES.length, 47, '46 + lib/update-check.js (§16)');
});

test('scanner R3: a classic script is one parseable IIFE without import, export or require, for overlay.js and for every manifest content script', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const rules = async (changes) => rulesOf(await sandbox.within(changes, (root) => scanStatic(root, ctx)));
  const iife = (body) => `(() => {\n  'use strict';\n  ${body}\n})();\n`;
  assert.deepEqual(await rules({}), []);
  assert.deepEqual(await rules({ [OVERLAY]: "(function () {\n  'use strict';\n  var n = 1;\n  return n;\n}());\n" }), [], 'the function-expression IIFE form');
  assert.deepEqual(await rules({ [OVERLAY]: "export const x = 1;\n(() => { 'use strict'; })();\n" }), ['R3'], 'module syntax does not parse as a script');
  assert.deepEqual(await rules({ [OVERLAY]: iife("const m = import('./x.js');") }), ['R3', 'R7'], 'a dynamic import inside the IIFE (an unresolvable one here)');
  assert.deepEqual(await rules({ [OVERLAY]: iife("const m = require('x');") }), ['R11-require', 'R3']);
  assert.deepEqual(await rules({ [OVERLAY]: "const leaked = 1;\n(() => { 'use strict'; return leaked; })();\n" }), ['R3'], 'a top-level declaration outside the IIFE');
  assert.deepEqual(await rules({ [OVERLAY]: "(() => { 'use strict'; })();\n(() => { 'use strict'; })();\n" }), ['R3'], 'two IIFEs');
  assert.deepEqual(await rules({ [OVERLAY]: "(1 + 2);\n" }), ['R3'], 'a parenthesized expression is not an IIFE');
  assert.deepEqual(await rules({ [OVERLAY]: "{ ( \n" }), ['R3'], 'a syntax error');
  assert.deepEqual(await rules({ [OVERLAY]: "// only a comment\n" }), ['R3'], 'an empty script is not the overlay');
  assert.deepEqual(await rules({ [OVERLAY]: iife("const s = 'export import require';") }), [], 'the words inside a string are not module syntax');
  // Any other manifest content script gets the same treatment.
  const manifest = JSON.stringify({ manifest_version: 3, content_scripts: [{ matches: ['https://*/*'], js: ['extension/overlay/overlay.js', 'extension/overlay/second.js'] }] });
  assert.deepEqual(await rules({ 'extension/manifest.json': manifest, 'extension/overlay/second.js': "export const b = 1;\n" }), ['R3']);
  assert.deepEqual(await rules({ 'extension/manifest.json': manifest, 'extension/overlay/second.js': iife('return 1;') }), []);
  assert.deepEqual(await rules({ 'extension/manifest.json': '{ not json' }), ['R3'], 'an unreadable manifest is reported');
});

test('scanner R12 and D1: every HTML rule fires on a mutant; comments, boolean attributes and single quotes do not confuse it', async (t) => {
  const ctx = { ...FIXTURE_ORIGINS, secretPatterns: (await loadRegistry()).secretPatterns };
  const sandbox = await createSandbox(t, BASELINE);
  const page = (mutate) => ({ 'extension/panel/panel.html': mutate(HTML_PAGE('./panel.js')) });
  const rules = async (changes) => rulesOf(await sandbox.within(changes, (root) => scanStatic(root, ctx)));
  const at = (from, to) => page((html) => html.replace(from, to));
  assert.deepEqual(await rules({}), []);
  assert.deepEqual(await rules(at('<script type="module" src="./panel.js"></script>', '<script type="module">start();</script>')), ['R12'], 'inline script');
  assert.deepEqual(await rules(at('<script type="module" src="./panel.js"></script>', '<script type="module" src="./panel.js">start();</script>')), ['R12'], 'inline text next to a src');
  assert.deepEqual(await rules(at('<script type="module" src="./panel.js">', '<script src="./panel.js">')), ['R12'], 'no type=module');
  assert.deepEqual(await rules(at('type="module"', 'type="text/javascript"')), ['R12']);
  assert.deepEqual(await rules(at('<script type="module" src="./panel.js"></script>', "<SCRIPT TYPE='MODULE' SRC='./panel.js'></SCRIPT>")), [], 'case and single quotes');
  assert.deepEqual(await rules(at('<button id="go"', '<button id="go" onclick="go()"')), ['R12'], 'an inline handler');
  assert.deepEqual(await rules(at('<button id="go"', '<button id="go" ONMOUSEOVER="x"')), ['R12'], 'an uppercase handler name');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="https://cdn.example.test/x.css"')), ['R12'], 'a remote stylesheet (also a remote URL in the text)');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="//cdn.example.test/x.css"')), ['R12'], 'a protocol-relative link');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="/styles.css"')), ['R12'], 'a root-relative link');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="./missing.css"')), ['R12'], 'an unresolvable link');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="../../../outside.css"')), ['R12'], 'a link that leaves the repository');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="../../app/main.js"')), ['R12'], 'a link to a file the build does not ship as a page asset');
  assert.deepEqual(await rules(at('href="../../styles.css"', 'href="../../styles.css?v=1#x"')), [], 'query and fragment do not break resolution');
  assert.deepEqual(await rules(at('src="./panel.js"', 'src="data:text/javascript,1"')), ['R12'], 'a data: script');
  assert.deepEqual(await rules(at('<meta charset="utf-8">', '<meta charset="utf-8"><link rel="icon" href="chrome-extension://x/i.png">')), ['R12'], 'the extension scheme');
  assert.deepEqual(await rules(at('<main id="app">', '<main id="app">Hello')), ['R12'], 'literal text');
  assert.deepEqual(await rules(at('<title data-i18n="ext.name"></title>', '<title>Panel</title>')), ['R12'], 'a title with text');
  assert.deepEqual(await rules(at('<main id="app">', '<main id="app"><iframe></iframe>')), ['D1'], 'an iframe element');
  assert.deepEqual(await rules(at('<main id="app">', '<main id="app"><p>a &amp; b</p>')), ['R12'], 'an entity is still text');
  assert.deepEqual(await rules(at('<body>', '<body><style>.a { color: red; }</style>')), [], 'a style element body is not text');
  assert.deepEqual(await rules(at('<body>', '<body><a href="#top"></a>')), [], 'a fragment link');
  assert.deepEqual(await rules(at('<body>', '<body><a =x href="#top"></a>')), [], 'a stray equals sign inside a tag does not stall the parser');
  assert.deepEqual(await rules({ 'extension/engine/host.html': HTML_PAGE('./host.js').replace('<main id="app"></main>', '') }), []);
  assert.deepEqual(await rules({ 'extension/lib/page.html': HTML_PAGE('../panel/panel.js') }), [], 'any extension HTML file is scanned, wherever it lives');
  assert.deepEqual(await rules({ 'extension/lib/page.html': HTML_PAGE('../panel/panel.js').replace('type="module" ', '') }), ['R12']);
});

test('scanner R9/R10: a module that touches a global at import time is caught, an entry file is exempt, and the traps are always removed', async (t) => {
  const files = {
    'package.json': '{ "type": "module" }\n',
    'extension/lib/clean.js': 'export const value = 1;\n',
    'extension/lib/late.js': "export const read = () => (typeof document === 'undefined' ? 0 : document.title);\n",
    'extension/lib/param.js': 'export const make = (env = globalThis.chrome) => env;\n',
  };
  const sandbox = await createSandbox(t, files);
  const paths = ['extension/lib/clean.js', 'extension/lib/late.js', 'extension/lib/param.js'];
  const probe = (changes, only = paths) => sandbox.within(changes, (root) => probeImportPurity(root, only));
  assert.deepEqual(render(await probe({})), [], 'guarded use inside a function and a parameter default are not import-time touches');
  const mutants = [
    ['document', 'export const title = document.title;\n'], ['window', 'export const w = window.location;\n'], ['chrome', 'export const c = chrome.runtime;\n'],
    ['browser', 'export const b = browser.runtime;\n'], ['navigator', 'export const n = navigator.userAgent;\n'],
    ['localStorage', "export const s = localStorage.getItem('k');\n"], ['sessionStorage', "export const s = sessionStorage.length;\n"],
    ['indexedDB', "export const s = indexedDB.open('k');\n"], ['AudioContext', 'export const a = AudioContext;\n'],
    ['fetch', "export const f = fetch('https://api.example.test');\n"], ['setTimeout', 'export const t = setTimeout(() => {}, 1);\n'],
    ['setInterval', 'export const t = setInterval(() => {}, 1);\n'],
    ['clearTimeout', 'export const t = clearTimeout(0);\n'], ['clearInterval', 'export const t = clearInterval(0);\n'], ['typeof chrome', "export const c = typeof chrome === 'undefined';\n"],
    ['globalThis.chrome', 'export const c = globalThis.chrome;\n'], ['an assignment', "globalThis.document = {};\nexport const d = 1;\n"],
  ];
  // Each mutant gets its own file name: an ES module is cached by URL, so reusing one path would replay the first result forever.
  for (const [index, [name, source]] of mutants.entries()) {
    const path = `extension/lib/mutant-${index}.js`;
    const found = await probe({ [path]: source }, [...paths, path]);
    assert.equal(found.length, 1, `${name}: ${JSON.stringify(render(found))}`);
    assert.equal(found[0].rule, 'R9');
    assert.equal(found[0].file, path, `${name}: blamed on the module that touches the global`);
    assert.equal(found[0].line, 1, `${name}: reported with the line of the touch`);
    assert.match(found[0].detail, /^import touches the global /, name);
  }
  // Each trapped global is exercised by at least one mutant, so a name that stops being trapped is noticed.
  for (const name of TRAPPED_GLOBALS) {
    assert.ok(mutants.some(([, source]) => new RegExp(`\\b${name}\\b`).test(source)), `a mutant touches ${name}`);
  }
  // The blame goes to the touching module even when a clean-looking importer reaches it first.
  const chained = await probe({
    'extension/lib/chain-mutant.js': 'export const w = window.name;\n',
    'extension/lib/chain-importer.js': "import { w } from './chain-mutant.js';\nexport const y = w;\n",
  }, ['extension/lib/chain-importer.js', 'extension/lib/chain-mutant.js']);
  assert.deepEqual(chained.map((item) => item.file), ['extension/lib/chain-mutant.js'], JSON.stringify(chained));
  // An import that fails for another reason is a finding too (it cannot be proven pure).
  const broken = await probe({ 'extension/lib/broken.js': "import './does-not-exist.js';\nexport const y = 1;\n" }, ['extension/lib/broken.js']);
  assert.equal(broken.length, 1);
  assert.match(broken[0].detail, /^import fails/);
  // An entry file may do anything at import time: it is not probed, by the R10 list and not by accident.
  const entry = 'extension/background/service-worker.js';
  const tree = await sandbox.within({ [entry]: 'document.title = "x";\nexport const y = 1;\n' }, (root) => loadTree(root));
  assert.equal(nonEntryModules(tree).includes(entry), false);
  assert.equal(nonEntryModules(tree).includes('extension/lib/clean.js'), true);
  assert.deepEqual(ENTRY_FILES.filter((path) => nonEntryModules({ files: new Map([[path, '']]) }).includes(path)), [], 'each R10 entry is excluded from the probe');
  assertTrapsRemoved();
});

test('scanner proof on a copy of the real tree: a violation injected into a real file is found under its own rule, and nothing else changes', async (t) => {
  const ctx = await loadRegistry();
  const root = await mkdtemp(join(tmpdir(), 'interp-ext-static-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await cp(join(repoRoot, 'extension'), join(root, 'extension'), { recursive: true });
  await cp(join(repoRoot, 'app'), join(root, 'app'), { recursive: true });
  await copyFile(join(repoRoot, 'styles.css'), join(root, 'styles.css'));
  const expectedPaths = new Set(EXPECTED_FILES.map(([, path]) => path));
  const before = render(await scanStatic(root, ctx, { expectedPaths }));
  const cases = [
    ['extension/lib/constants.js', (text) => `${text}\nexport const leak = () => console.log(1);\n`, 'R11-console'],
    ['extension/lib/constants.js', (text) => `${text}\nexport const leak = (el) => { el.innerHTML = 'x'; };\n`, 'R11-inner-outer-html'],
    ['extension/lib/constants.js', (text) => `${text}\nexport const leak = () => chrome.runtime.id;\n`, 'R8'],
    ['extension/lib/constants.js', (text) => `${text}\nexport const leak = 'https://evil.example.test/x';\n`, 'R11-url'],
    ['extension/lib/constants.js', (text) => `${text}\nimport '../../app/config.js';\n`, 'R4'],
    ['extension/lib/protocol.js', (text) => `${text}\nimport './settings.js';\n`, 'R4'],
    ['app/version.js', (text) => `${text}\nimport '../extension/lib/constants.js';\n`, 'R1'],
    ['extension/overlay/overlay.js', (text) => `${text}\nexport {};\n`, 'R3'],
    ['extension/panel/panel.html', (text) => text.replace('</body>', '<script>start();</script></body>'), 'R12'],
  ];
  for (const [path, mutate, rule] of cases) {
    const original = await readFile(join(root, path), 'utf8');
    const changed = mutate(original);
    assert.notEqual(changed, original, `${path}: the mutation changed the file`);
    await writeFile(join(root, path), changed);
    try {
      const added = render(await scanStatic(root, ctx, { expectedPaths })).filter((line) => !before.includes(line));
      assert.ok(added.length >= 1 && added.every((line) => line.startsWith(`${rule} `) || line.startsWith('R1-closure ') || line.startsWith('R7 ')), `${path} -> ${rule}: ${JSON.stringify(added)}`);
      assert.ok(added.some((line) => line.startsWith(`${rule} `)), `${path}: reported under ${rule}`);
    } finally { await writeFile(join(root, path), original); }
  }
  // The import-purity probe also catches a real module that starts touching a global, through the real dependency chain.
  // The copy has its own URLs, so nothing was cached by the real-tree probe; the injection happens before its first probe.
  const tree = await loadTree(root);
  const target = 'extension/lib/caption-frames.js';
  const original = await readFile(join(root, target), 'utf8');
  await writeFile(join(root, target), `${original}\nexport const leak = document.title;\n`);
  const injected = await probeImportPurity(root, nonEntryModules(tree));
  const blamed = injected.filter((item) => item.file === target);
  assert.equal(blamed.length, 1, JSON.stringify(render(injected)));
  assert.match(blamed[0].detail, /touches the global document/);
});

const sources = {
  // Shapes that a real extension test legitimately uses: injected fakes, a locally declared fake constructor, a comment naming a token.
  cleanTest: [
    "import test from 'node:test';",
    "import { createFakeAudioEnv } from './fixtures/fake-audio.mjs';",
    "// Never the speech command, never a browser: prose in a comment is fine.",
    "test('x', async () => {",
    '  const fake = createFakeAudioEnv();',
    '  const context = new fake.env.AudioContext();',
    '  const stream = await fake.env.navigator.mediaDevices.getUserMedia({ audio: true });',
    '  const worker = { chrome: {} };',
    '  const id = await worker.chrome.tabCapture.getMediaStreamId({});',
    '  return [context, stream, id];',
    '});',
    "const say = (store, row) => store.push(row);",
    '',
  ].join('\n'),
  localFake: ['class FakeAudioContext {}', 'export function make() {', '  class AudioContext extends FakeAudioContext {}', '  const navigator = { mediaDevices: { getUserMedia() {} } };', '  return [new AudioContext(), navigator.mediaDevices.getUserMedia()];', '}', ''].join('\n'),
  destructured: ['export function make(worker) {', '  const { chrome } = worker;', '  return chrome.tabCapture.getMediaStreamId({});', '}', ''].join('\n'),
  spawnNode: [`import { execFileSync } from 'node:${TOKEN.spawnModule}';`, "const script = 'scripts/build-extension.mjs';", 'export const run = (args) => execFileSync(process.execPath, [script, ...args]);', ''].join('\n'),
  spawnNodeLiteral: [`import { spawnSync } from 'node:${TOKEN.spawnModule}';`, "export const run = () => spawnSync('node', ['scripts/build-extension.mjs', '--x']);", ''].join('\n'),
};
const d13Baseline = () => ({
  'tests/extension-a.test.mjs': sources.cleanTest,
  'tests/extension-build.test.mjs': sources.spawnNode,
  'tests/extension-tree.test.mjs': sources.spawnNodeLiteral,
  'tests/extension-static.test.mjs': 'placeholder for the excluded file\n',
  'tests/session-isolated.test.mjs': sources.cleanTest,
  'tests/fixtures/fake-chrome.mjs': sources.destructured,
  'tests/fixtures/fake-audio.mjs': sources.localFake,
  'tests/fixtures/extension-dom.mjs': 'export const parse = () => ({});\n',
  'tests/fixtures/live.mjs': `// Not part of the scan: ${TOKEN.player}\nexport const x = 1;\n`,
  'tests/other.test.mjs': `// Not part of the scan: ${TOKEN.player}\nexport const y = 1;\n`,
});

test('scanner D13: every no-sound rule fires on a mutant; fakes, comments and helper names do not', async (t) => {
  const sandbox = await createSandbox(t, d13Baseline());
  const scan = (changes) => sandbox.within(changes, (root) => scanNoSound(root));
  const clean = await scan({});
  assert.deepEqual(render(clean.findings), []);
  assert.deepEqual([...clean.scanned], [
    'tests/extension-a.test.mjs', 'tests/extension-build.test.mjs', 'tests/extension-tree.test.mjs', 'tests/session-isolated.test.mjs',
    'tests/fixtures/extension-dom.mjs', 'tests/fixtures/fake-audio.mjs', 'tests/fixtures/fake-chrome.mjs',
  ], 'the scan covers extension tests, session-isolated and the three fakes, excludes itself and unrelated files');
  const dirty = (source, path = 'tests/extension-a.test.mjs') => scan({ [path]: source }).then((result) => result.findings);
  // Every contract token, one per mutant, in code (a string) and nowhere else.
  for (const [name, token] of D13_TOKENS) {
    const found = await dirty(`export const s = ['${token}', 'x'];\n`);
    assert.deepEqual(found.map((item) => item.rule), ['D13'], name);
    assert.match(found[0].detail, new RegExp(name), `${name}: the finding names the token`);
    assert.equal((await dirty(`// ${token} in a comment only\nexport const s = 1;\n`)).length, 0, `${name}: not in comments`);
  }
  assert.equal((await dirty(`export const s = '${TOKEN.driverA}';\n`, 'tests/fixtures/fake-chrome.mjs')).length, 1, 'fixtures are scanned too');
  assert.equal((await dirty(`export const s = '${TOKEN.driverA}';\n`, 'tests/session-isolated.test.mjs')).length, 1);
  assert.equal((await dirty(`export const s = '${TOKEN.driverA}';\n`, 'tests/extension-static.test.mjs')).length, 0, 'the scan excludes its own file');
  // Speech command as a string literal, alone or as a path; the helper called say() is not one.
  assert.equal((await dirty(`export const c = ['${TOKEN.speech}', 'hello'];\n`)).length, 1);
  assert.equal((await dirty(`export const c = ["/usr/bin/${TOKEN.speech}"];\n`)).length, 1);
  assert.equal((await dirty(`export const c = 'we ${TOKEN.speech} hello';\n`)).length, 0, 'a sentence is not the command');
  assert.equal((await dirty(`function ${TOKEN.speech}(x) { return x; }\nexport const c = ${TOKEN.speech}(1);\n`)).length, 0);
  // AudioContext: real globals are flagged, injected members and locally declared fakes are not.
  const ctorCases = [
    ['a bare constructor', 'export const a = new AudioContext();\n', 1],
    ['a webkit constructor', 'export const a = new webkitAudioContext();\n', 1],
    ['an offline constructor', 'export const a = new OfflineAudioContext(1, 1, 8000);\n', 1],
    ['through globalThis', 'export const a = new globalThis.AudioContext();\n', 1],
    ['through window', 'export const a = new window.AudioContext();\n', 1],
    ['through self', 'export const a = new self.webkitAudioContext();\n', 1],
    ['an injected member', 'export const a = (env) => new env.AudioContext();\n', 0],
    ['a fake class', 'export const a = () => new FakeAudioContext();\n', 0],
    ['a declared local class', 'class AudioContext {}\nexport const a = new AudioContext();\n', 0],
    ['a destructured injected constructor', 'export const a = (env) => { const { AudioContext } = env; return new AudioContext(); };\n', 0],
    ['a constructor named in a string', "export const a = 'new AudioContext()';\n", 0],
  ];
  for (const [name, source, count] of ctorCases) assert.equal((await dirty(source)).length, count, name);
  // getUserMedia and tabCapture against a real object.
  const captureCases = [
    ['the real navigator', 'export const m = () => navigator.mediaDevices.getUserMedia({ audio: true });\n', 1],
    ['the real navigator, legacy call', 'export const m = () => navigator.webkitGetUserMedia({ audio: true });\n', 1],
    ['a global-rooted navigator', 'export const m = () => globalThis.navigator.mediaDevices.getUserMedia({});\n', 1],
    ['a window-rooted navigator', 'export const m = () => window.navigator.mediaDevices;\n', 1],
    ['the real chrome tabCapture', 'export const m = () => chrome.tabCapture.getMediaStreamId({});\n', 1],
    ['a global-rooted chrome tabCapture', 'export const m = () => globalThis.chrome.tabCapture.getCapturedTabs();\n', 1],
    ['a fake navigator declared in the file', 'const navigator = { mediaDevices: {} };\nexport const m = () => navigator.mediaDevices;\n', 0],
    ['a fake chrome declared in the file', 'const chrome = { tabCapture: {} };\nexport const m = () => chrome.tabCapture;\n', 0],
    ['a fake navigator that is a parameter', 'export const m = (navigator) => navigator.mediaDevices;\n', 0],
    ['a fake chrome that is one of several parameters', 'export const m = (a, chrome) => chrome.tabCapture.getCapturedTabs(a);\n', 0],
    ['a fake navigator that is a destructured parameter', 'export const m = ({ navigator }) => navigator.mediaDevices;\n', 0],
    ['a fake chrome that is a function parameter', 'export async function m(worker, chrome) { return chrome.tabCapture.getCapturedTabs(worker); }\n', 0],
    ['an injected env member', 'export const m = (fake) => fake.env.navigator.mediaDevices.getUserMedia({});\n', 0],
    ['a fake chrome member', 'export const m = (b) => b.chrome.tabCapture.getMediaStreamId({});\n', 0],
    ['a plain mention of getUserMedia', "export const m = (mediaDevices) => mediaDevices.getUserMedia({}); // fake\n", 0],
  ];
  for (const [name, source, count] of captureCases) assert.equal((await dirty(source)).length, count, name);
  // Spawning: only the two build tests, only node, never a shell.
  const spawnSource = (call, imports = `import { execFileSync, spawnSync, execSync, exec } from 'node:${TOKEN.spawnModule}';`) => `${imports}\nconst s = 'scripts/build-extension.mjs';\n${call}\n`;
  assert.equal((await dirty(spawnSource('export const r = spawnSync(process.execPath, [s]);'), 'tests/extension-a.test.mjs')).length >= 1, true, 'a non-build test may not import the spawning module');
  assert.equal((await dirty(spawnSource('export const r = 1;'), 'tests/fixtures/fake-chrome.mjs')).length >= 1, true);
  const allowed = 'tests/extension-build.test.mjs';
  assert.deepEqual((await dirty(spawnSource('export const r = spawnSync(process.execPath, [s]);'), allowed)).length, 0);
  assert.deepEqual((await dirty(spawnSource("export const r = spawnSync('/usr/local/bin/node', [s]);"), allowed)).length, 0);
  assert.deepEqual((await dirty(spawnSource('export const r = spawnSync(nodeBinary, [s]);'), allowed)).length, 0, 'an identifier cannot be judged and passes');
  assert.equal((await dirty(spawnSource("export const r = spawnSync('open', ['-a', 'x']);"), allowed)).length, 1, 'another program');
  assert.equal((await dirty(spawnSource(`export const r = execFileSync('${TOKEN.chromeBin}', ['x']);`), allowed)).length >= 1, true, 'a browser');
  assert.equal((await dirty(spawnSource("export const r = execSync('node scripts/build-extension.mjs');"), allowed)).length, 1, 'a shell command');
  assert.equal((await dirty(spawnSource("export const r = exec('node scripts/build-extension.mjs');"), allowed)).length, 1);
  assert.equal((await dirty(spawnSource('export const r = /a/.exec("a");'), allowed)).length, 0, 'RegExp.exec is not a process');
  assert.equal((await dirty(`import { spawnSync } from 'node:${TOKEN.spawnModule}';\nexport const r = spawnSync(process.execPath, ['x.mjs']);\n`, allowed)).length, 1, 'spawning something other than the build script');
  assert.equal((await dirty(`import cp from 'node:${TOKEN.spawnModule}';\nexport const r = cp.spawnSync('open', ['x']); const b = 'build-extension.mjs';\n`, allowed)).length, 1, 'a namespace call');
  assert.equal((await dirty(`const cp = require('${TOKEN.spawnModule}');\nexport const x = cp;\n`)).length >= 1, true, 'require of the spawning module');
  assert.equal((await dirty(`export const l = () => import('node:${TOKEN.spawnModule}');\n`)).length >= 1, true, 'a dynamic import of the spawning module');
});

test('scanner D13: this very file passes its own scan, because every forbidden token is assembled at runtime', async (t) => {
  const own = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const sandbox = await createSandbox(t, { 'tests/extension-copy.test.mjs': own });
  const result = await scanNoSound(sandbox.root);
  assert.deepEqual(result.scanned, ['tests/extension-copy.test.mjs']);
  assert.deepEqual(render(result.findings), [], 'a copy of this file, scanned under another name, is clean');
  assert.equal(new Set(Object.values(TOKEN)).size, Object.keys(TOKEN).length, 'the token table has no duplicates');
  // The scan above is the real proof; this belt-and-braces check covers every long token even inside comments (short ones such as the speech command are ordinary words).
  for (const [name, value] of Object.entries(TOKEN)) if (value.length >= 8) assert.equal(own.includes(value), false, `the source of this file spells the token ${name}`);
});
