import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { ERROR_CODES } from '../app/providers/contract.js';
import { SECRET_PATTERNS } from '../scripts/check-release.mjs';
import { EXTENSION_PAGES, EXTRA_FILES, KEY_SLOT, OUTPUT_MARKER, buildExtension, lintManifest } from '../scripts/build-extension.mjs';
import { checkI18n } from '../scripts/check-i18n.mjs';

// New implementation of docs/extension.md §11.1 (group A, M3); no legacy code is ported.
//
// The REAL-TREE test: everything here reads the real extension/, app/ and _locales files and the real repository, so it
// can only pass once all four groups have landed. Six areas: (1) the real manifest lint and every path it references,
// (2) a real-repo build into a temp directory (the result contract of §10 and idempotence, never dist/), (3) the real
// i18n scan, (4) WIRE parity between overlay.js and protocol.js/constants.js, (5) dictionary/loader/HTML key coverage,
// (6) the ext.* to _locales mirror of §9.3 and the getMessage literals.
//
// Every check is a PURE FUNCTION OF A ROOT that returns a list of findings ([] = clean; each finding is `TAG:detail`).
// The real-tree tests run a check on the repository and demand []. The parity, coverage, mirror, manifest and
// build-output checks are also proved non-vacuous: each is run on a small MUTANT root built from strings at runtime
// (or on a copy of the real build output) and must report the tag of the mutation, and only tags the unmutated
// baseline did not already report count. Nothing here launches a browser, touches audio or writes dist/; the only
// child process is `node scripts/build-extension.mjs --out <temp dir>` (the CLI has no --root, so it sees the real
// repository, and the temp dir keeps the output outside it). Fake secrets are assembled at runtime.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const LANGS = SUPPORTED_LANGUAGES;
const execFileAsync = promisify(execFile);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const tagOf = (finding) => finding.split(':')[0];
const tagsOf = (findings) => new Set(findings.map(tagOf));
/** What a mutant reports that its unmutated baseline did not: only that proves the check reacts to the mutation. */
const newFindings = (baseline, findings) => findings.filter((finding) => !baseline.includes(finding));
const sorted = (list) => [...list].sort();

// ---------------------------------------------------------------------------------------------------
// temp directories and file access, all relative to a root
// ---------------------------------------------------------------------------------------------------

const cleanups = [];
after(async () => { await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true }))); });

async function tempDir(prefix = 'interp-exttree-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(directory);
  return directory;
}

/**
 * A root made of strings. The package.json marks every .js file below it as an ES module, so a check that imports a
 * module from a mutant root (or from the built output) behaves as it does in the real tree.
 */
async function makeRoot(files) {
  const root = await tempDir();
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const readText = (root, path) => readFile(join(root, path), 'utf8');
const readJson = async (root, path) => JSON.parse(await readText(root, path));
const isFileSync = (path) => attempt(() => statSync(path).isFile()) === true;
const importFromRoot = (root, path) => import(pathToFileURL(join(root, path)).href);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Sorted repo-relative POSIX paths of every regular file below `directory` (default: the whole root). */
async function listFiles(root, directory = '.') {
  const found = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  await walk(join(root, directory));
  return found.sort();
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  for (const path of await listFiles(root)) hash.update(`${path}\0${createHash('sha256').update(await readFile(join(root, path))).digest('hex')}\n`);
  return hash.digest('hex');
}

/** Replaces the one match of `pattern` (a string or a RegExp); the mutation anchor must exist exactly once, so a mutant can never be a no-op. */
function mutate(text, pattern, replacement) {
  const flags = pattern instanceof RegExp ? (pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`) : '';
  const count = pattern instanceof RegExp ? [...text.matchAll(new RegExp(pattern.source, flags))].length : text.split(pattern).length - 1;
  assert.equal(count, 1, `mutation anchor must match exactly once: ${String(pattern)}`);
  return text.replace(pattern, () => replacement);
}
const mutateAll = (text, pattern, replacement) => {
  assert.ok(text.includes(pattern), `mutation anchor missing: ${pattern}`);
  return text.split(pattern).join(replacement);
};

// ---------------------------------------------------------------------------------------------------
// source scanning helpers (comments stripped first, so a comment can neither satisfy nor break a check)
// ---------------------------------------------------------------------------------------------------

const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await|instanceof)$/;

/**
 * Removes // and block comments and keeps string, template and regexp literals verbatim. A two-regexp routine deletes real
 * code after a string such as 'http://x' or a regexp such as /a\/*$/; this scanner tracks the literals. Regexp-literal
 * detection is heuristic (a misjudged '/' can only leave comment text behind, never delete code).
 */
function stripComments(source) {
  const length = source.length;
  let index = 0;
  let output = '';

  function quoted(quote) {
    output += source[index];
    index += 1;
    while (index < length) {
      const char = source[index];
      output += char;
      index += 1;
      if (char === '\\' && index < length) { output += source[index]; index += 1; } else if (char === quote || char === '\n') return;
    }
  }
  function template() {
    output += '`';
    index += 1;
    while (index < length) {
      const char = source[index];
      if (char === '\\') { output += source.slice(index, index + 2); index += 2; } else if (char === '$' && source[index + 1] === '{') {
        output += '${';
        index += 2;
        code(true);
        if (source[index] === '}') { output += '}'; index += 1; }
      } else { output += char; index += 1; if (char === '`') return; }
    }
  }
  function regexp() {
    output += '/';
    index += 1;
    let inClass = false;
    while (index < length) {
      const char = source[index];
      if (char === '\n') return;
      output += char;
      index += 1;
      if (char === '\\' && index < length) { output += source[index]; index += 1; } else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) return;
    }
  }
  function code(insideExpression) {
    let depth = 0;
    let previous = '';
    while (index < length) {
      const char = source[index];
      const next = source[index + 1];
      if (char === '/' && next === '/') { while (index < length && source[index] !== '\n') index += 1; continue; }
      if (char === '/' && next === '*') { const end = source.indexOf('*/', index + 2); index = end < 0 ? length : end + 2; output += ' '; continue; }
      if (char === '"' || char === "'") { quoted(char); previous = char; continue; }
      if (char === '`') { template(); previous = '`'; continue; }
      if (char === '/' && (REGEX_PRECEDERS.has(previous) || (/[A-Za-z]/.test(previous) && REGEX_KEYWORDS.test(output.trimEnd())))) { regexp(); previous = '/'; continue; }
      if (insideExpression) {
        if (char === '{') depth += 1;
        else if (char === '}') { if (depth === 0) return; depth -= 1; }
      }
      output += char;
      index += 1;
      if (!/\s/.test(char)) previous = char;
    }
  }
  code(false);
  return output;
}

// The contract's own specifier patterns (§10.3), verbatim, plus the template-literal URL form (not followed by the build).
const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const URL_ASSET = /new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const TEMPLATE_URL = /new\s+URL\(\s*`([^`]*)`\s*,\s*import\.meta\.url\s*\)/g;

const specifiersOf = (code) => [STATIC_IMPORT, DYNAMIC_IMPORT, URL_ASSET].flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[2]));
const templateSitesOf = (code) => [...code.matchAll(TEMPLATE_URL)].map((match) => match[1]);

/** The `<script src>` and `<link href>` references of a page (comments removed). */
function htmlReferencesOf(html) {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...markup.matchAll(/<script\b[^>]*?\ssrc\s*=\s*(["'])(.*?)\1/gi), ...markup.matchAll(/<link\b[^>]*?\shref\s*=\s*(["'])(.*?)\1/gi)]
    .map((match) => match[2]);
}

/**
 * The repo-relative targets of one template-literal URL site. A literal with no hole is one target; one hole in the
 * last path segment expands over the three languages; anything else cannot be enumerated (null).
 */
function templateTargets(from, pattern) {
  const holes = pattern.match(/\$\{[^}]*\}/g) ?? [];
  const resolveOne = (spec) => posix.normalize(posix.join(posix.dirname(from), spec));
  if (holes.length === 0) return [resolveOne(pattern)];
  if (holes.length > 1 || pattern.slice(0, pattern.lastIndexOf('/') + 1).includes('${')) return null;
  return LANGS.map((language) => resolveOne(pattern.replace(/\$\{[^}]*\}/, language)));
}

/** Text between the first '{' at or after `from` and its matching '}' (strings are skipped, so braces inside them do not count). */
function braceBlock(code, from) {
  const start = code.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === '`') {
      for (index += 1; index < code.length && code[index] !== char; index += 1) if (code[index] === '\\') index += 1;
    } else if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (depth === 0) return code.slice(start + 1, index); }
  }
  return null;
}
const functionBody = (code, name) => { const at = code.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`)); return at < 0 ? null : braceBlock(code, at); };

/** `{ a: 1, b: 'x' }` with only string and number values, or null (the WIRE and default-style literals are flat on purpose). */
function parseFlatObject(body) {
  const result = {};
  for (const part of body.split(',')) {
    if (part.trim() === '') continue;
    const match = /^\s*([A-Za-z_]\w*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?))\s*$/.exec(part);
    if (!match) return null;
    result[match[1]] = match[4] !== undefined ? Number(match[4]) : (match[2] ?? match[3]);
  }
  return result;
}
function frozenObjectConst(code, name) {
  const match = new RegExp(`\\bconst\\s+${name}\\s*=\\s*Object\\.freeze\\(\\s*\\{([^{}]*)\\}\\s*\\)\\s*;`).exec(code);
  return match ? parseFlatObject(match[1]) : null;
}
function frozenListConst(code, name) {
  const match = new RegExp(`\\bconst\\s+${name}\\s*=\\s*Object\\.freeze\\(\\s*\\[([^\\]]*)\\]\\s*\\)`).exec(code);
  return match ? [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2]) : null;
}

/** JS files under extension/ (all of them, i18n data excluded because it holds no code), comment-stripped. */
async function extensionCode(root) {
  const paths = (await listFiles(root, 'extension')).filter((path) => path.endsWith('.js'));
  return Promise.all(paths.map(async (path) => ({ path, code: stripComments(await readText(root, path)) })));
}

// ---------------------------------------------------------------------------------------------------
// self-tests of the scanning helpers: the checks below are only as good as these
// ---------------------------------------------------------------------------------------------------

test('scanner helpers: comments go, literals stay, and imports, template sites and page references are found', () => {
  const tricky = [
    "const a = 'http://x/*'; // trailing comment with getMessage('ghost')",
    'const b = /a\\/*$/; /* block getMessage("ghost2") */ const c = 1;',
    'const d = `t ${ a /* inner */ + "//kept" } // still template text`;',
    'const e = 4 / 2; // division, not a regexp',
    'return /re/.test(x); // regexp after a keyword',
  ].join('\n');
  const stripped = stripComments(tricky);
  assert.ok(stripped.includes("'http://x/*'"), 'a string that looks like a comment survives');
  assert.ok(stripped.includes('/a\\/*$/'), 'a regexp that looks like a comment start survives');
  assert.ok(stripped.includes('const c = 1;'), 'code after that regexp and a later block comment is not deleted');
  assert.ok(stripped.includes('"//kept"') && stripped.includes('// still template text'), 'template text and strings inside ${} survive');
  assert.ok(stripped.includes('const e = 4 / 2;') && stripped.includes('/re/.test(x);'));
  assert.ok(!/ghost|trailing comment|division, not|inner \*\//.test(stripped), 'comment text is gone');

  const code = stripComments([
    "import a from './a.js'; import './side.js'; export * from './re.js'; export { x } from '../up.js';",
    "const m = await import('./dyn.js'); const w = new URL('./worker.js', import.meta.url);",
    'const t = new URL(`../i18n/${code}.json`, import.meta.url);',
    "// import './commented.js'",
    'export const keep = 1; export function f() {}',
  ].join('\n'));
  assert.deepEqual(sorted(specifiersOf(code)), ['../up.js', './a.js', './dyn.js', './re.js', './side.js', './worker.js']);
  assert.deepEqual(templateSitesOf(code), ['../i18n/${code}.json']);
  assert.deepEqual(templateTargets('extension/lib/i18n.js', '../i18n/${code}.json'), LANGS.map((language) => `extension/i18n/${language}.json`));
  assert.deepEqual(templateTargets('a/b.js', './plain.json'), ['a/plain.json']);
  assert.equal(templateTargets('a/b.js', './${x}/y.json'), null, 'a hole in a directory cannot be enumerated');
  assert.equal(templateTargets('a/b.js', './${x}-${y}.json'), null, 'two holes cannot be enumerated');
  assert.deepEqual(htmlReferencesOf('<!-- <script src="./no.js"></script> --><script type="module" src="./a.js"></script><link rel="stylesheet" href="../s.css">'),
    ['./a.js', '../s.css']);
  const literal = frozenObjectConst("const WIRE = Object.freeze({ port: 'p/1', v: 1, maxRows: 6 });", 'WIRE');
  assert.deepEqual(literal, { port: 'p/1', v: 1, maxRows: 6 });
  assert.equal(frozenObjectConst("const WIRE = { port: 'p/1' };", 'WIRE'), null, 'an unfrozen literal is not accepted');
  assert.equal(frozenObjectConst('const WIRE = Object.freeze({ port: compute() });', 'WIRE'), null, 'a computed value is not accepted');
  assert.deepEqual(frozenListConst("const L = Object.freeze(['a', \"b\"]);", 'L'), ['a', 'b']);
  assert.equal(braceBlock("function f() { const s = '}'; { nested } }", 0).trim(), "const s = '}'; { nested }");
});

// ---------------------------------------------------------------------------------------------------
// (1) the manifest: real lint, every referenced path, PATHS coherence
// ---------------------------------------------------------------------------------------------------

// §10.4: the four generated icons and the repo files they come from.
const ICON_SOURCES = Object.freeze({
  'icons/icon-16.png': 'icons/favicon-16.png', 'icons/icon-32.png': 'icons/favicon-32.png',
  'icons/icon-48.png': 'icons/icon-192.png', 'icons/icon-128.png': 'icons/icon-512.png',
});

/** Every file path the manifest names, found by walking the manifest itself (not by asking lintManifest). */
function referencedPaths(manifest) {
  const refs = [];
  const add = (where, value) => refs.push({ where, path: typeof value === 'string' ? value : null });
  add('background.service_worker', manifest?.background?.service_worker);
  add('side_panel.default_path', manifest?.side_panel?.default_path);
  add('options_ui.page', manifest?.options_ui?.page);
  for (const [index, script] of (Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : []).entries()) {
    for (const [position, file] of (Array.isArray(script?.js) ? script.js : []).entries()) add(`content_scripts[${index}].js[${position}]`, file);
  }
  for (const [size, file] of Object.entries(manifest?.icons ?? {})) add(`icons.${size}`, file);
  for (const [size, file] of Object.entries(manifest?.action?.default_icon ?? {})) add(`action.default_icon.${size}`, file);
  return refs;
}

async function manifestFindings(root) {
  const findings = [];
  let manifest;
  try { manifest = await readJson(root, 'extension/manifest.json'); } catch { return ['MANIFEST_UNREADABLE']; }
  const messages = {};
  for (const language of LANGS) {
    try { messages[language] = await readJson(root, `extension/_locales/${language}/messages.json`); } catch { findings.push(`LOCALE_UNREADABLE:${language}`); }
  }
  // Same seam the build uses: extension/... paths are sources, icons/icon-N.png exists when its repo source does.
  const fileExists = (path) => isFileSync(join(root, ICON_SOURCES[path] ?? path));
  for (const reason of lintManifest(manifest, { fileExists, messages })) findings.push(`LINT:${reason}`);
  for (const { where, path } of referencedPaths(manifest)) if (path === null || !fileExists(path)) findings.push(`PATH_MISSING:${where}`);
  const commands = Object.entries(manifest.commands ?? {}).map(([name, command]) => [`commands.${name}.description`, command?.description]);
  for (const [where, value] of [['name', manifest.name], ['description', manifest.description], ['action.default_title', manifest.action?.default_title], ...commands]) {
    const name = /^__MSG_([A-Za-z]\w*)__$/.exec(typeof value === 'string' ? value : '')?.[1];
    if (!name) { findings.push(`MESSAGE_REFERENCE:${where}`); continue; }
    for (const language of LANGS) if (typeof messages[language]?.[name]?.message !== 'string') findings.push(`MESSAGE_MISSING:${where}:${language}:${name}`);
  }
  for (const page of EXTENSION_PAGES) if (!isFileSync(join(root, page))) findings.push(`PAGE_MISSING:${page}`);
  return findings;
}

/** protocol.js PATHS must name the same files as the manifest and the two pages the manifest does not name (I10, §3.5). */
async function pathsFindings(root) {
  let PATHS;
  let manifest;
  try { ({ PATHS } = await importFromRoot(root, 'extension/lib/protocol.js')); } catch { return ['PATHS_UNLOADABLE']; }
  try { manifest = await readJson(root, 'extension/manifest.json'); } catch { return ['MANIFEST_UNREADABLE']; }
  const findings = [];
  if (JSON.stringify(sorted(Object.keys(PATHS))) !== JSON.stringify(['host', 'options', 'overlay', 'panel', 'permission', 'sw'])) findings.push('PATHS_KEYS');
  const expected = { sw: manifest.background?.service_worker, panel: manifest.side_panel?.default_path, options: manifest.options_ui?.page,
    overlay: manifest.content_scripts?.[0]?.js?.[0] };
  for (const [name, value] of Object.entries(expected)) if (PATHS[name] !== value) findings.push(`PATHS_MANIFEST:${name}`);
  for (const name of ['host', 'permission']) if (!EXTENSION_PAGES.includes(PATHS[name])) findings.push(`PATHS_PAGE:${name}`);
  for (const [name, path] of Object.entries(PATHS)) if (typeof path !== 'string' || !isFileSync(join(root, path))) findings.push(`PATHS_MISSING:${name}`);
  return findings;
}

test('the real manifest lints clean, every path it references exists, and its message references resolve in all three _locales', async () => {
  const findings = await manifestFindings(repoRoot);
  assert.deepEqual(findings, [], 'the real manifest and its referenced files');
  const manifest = await readJson(repoRoot, 'extension/manifest.json');
  const refs = referencedPaths(manifest);
  // Guard against a vacuous walk: the manifest of §10.4 names 3 pages/workers, 1 content script, 4 icons and 2 action icons.
  assert.equal(refs.length, 10, 'referenced path count');
  assert.ok(refs.every(({ path }) => typeof path === 'string'));
  // Through the __MSG_ indirection the manifest strings are the en _locales values, which mirror the ext dictionary (9.3).
  const en = await readJson(repoRoot, 'extension/_locales/en/messages.json');
  const ext = await readJson(repoRoot, 'extension/i18n/en.json');
  assert.equal(en[/^__MSG_(\w+)__$/.exec(manifest.name)[1]].message, ext['ext.name']);
  assert.equal(en[/^__MSG_(\w+)__$/.exec(manifest.description)[1]].message, ext['ext.description']);
  assert.equal(en[/^__MSG_(\w+)__$/.exec(manifest.action.default_title)[1]].message, ext['ext.action.title']);
  assert.equal(en[/^__MSG_(\w+)__$/.exec(manifest.commands._execute_action.description)[1]].message, ext['ext.command.open']);
});

test('PATHS of protocol.js name the files of the real manifest and the two pages the manifest does not name', async () => {
  assert.deepEqual(await pathsFindings(repoRoot), []);
});

test('the manifest checks are not vacuous: each mutant root reports the tag of its mutation', async () => {
  const manifestText = await readText(repoRoot, 'extension/manifest.json');
  const locales = Object.fromEntries(await Promise.all(LANGS.map(async (language) => [language, await readText(repoRoot, `extension/_locales/${language}/messages.json`)])));
  const referenced = referencedPaths(JSON.parse(manifestText)).map(({ path }) => ICON_SOURCES[path] ?? path);
  async function rootWith({ manifest = JSON.parse(manifestText), omit = [], locale = {} } = {}) {
    const files = { 'extension/manifest.json': json(manifest) };
    for (const language of LANGS) files[`extension/_locales/${language}/messages.json`] = locale[language] ?? locales[language];
    for (const page of EXTENSION_PAGES) files[page] = '';
    for (const path of referenced) files[path] = '';
    for (const path of omit) delete files[path];
    for (const language of Object.keys(locale)) if (locale[language] === null) delete files[`extension/_locales/${language}/messages.json`];
    return makeRoot(files);
  }
  const edit = (fn) => { const manifest = JSON.parse(manifestText); fn(manifest); return manifest; };
  const baseline = await manifestFindings(await rootWith());
  const mutants = [
    ['service worker path missing', await rootWith({ manifest: edit((m) => { m.background.service_worker = 'extension/background/gone.js'; }) }), 'PATH_MISSING'],
    ['side panel path missing', await rootWith({ manifest: edit((m) => { m.side_panel.default_path = 'extension/panel/gone.html'; }) }), 'PATH_MISSING'],
    ['content script path missing', await rootWith({ manifest: edit((m) => { m.content_scripts[0].js = ['extension/overlay/gone.js']; }) }), 'PATH_MISSING'],
    ['icon source missing (icon-192 for the 48 px icon)', await rootWith({ omit: ['icons/icon-192.png'] }), 'PATH_MISSING'],
    ['icon path outside the generated set', await rootWith({ manifest: edit((m) => { m.icons['48'] = 'icons/icon-49.png'; }) }), 'PATH_MISSING'],
    ['name is not a __MSG_ reference', await rootWith({ manifest: edit((m) => { m.name = 'Live Interpreter'; }) }), 'MESSAGE_REFERENCE'],
    ['a referenced message is missing from one language', await rootWith({ locale: { ja: json(Object.fromEntries(Object.entries(JSON.parse(locales.ja)).filter(([name]) => name !== 'actionTitle'))) } }), 'MESSAGE_MISSING'],
    ['a _locales file is absent', await rootWith({ locale: { ko: null } }), 'LOCALE_UNREADABLE'],
    ['an extra permission', await rootWith({ manifest: edit((m) => { m.permissions.push('history'); }) }), 'LINT'],
    ['a host page is missing', await rootWith({ omit: [EXTENSION_PAGES[0]] }), 'PAGE_MISSING'],
  ];
  assert.deepEqual(baseline, [], 'the unmutated string root is clean');
  for (const [label, root, expected] of mutants) {
    const fresh = newFindings(baseline, await manifestFindings(root));
    assert.ok(fresh.some((finding) => tagOf(finding) === expected), `${label}: expected ${expected}, saw ${fresh.map(tagOf).join(',') || 'nothing new'}`);
  }
  // PATHS parity mutant: protocol.js names a different panel page than the manifest.
  const protocolText = await readText(repoRoot, 'extension/lib/protocol.js');
  const pathsRoot = async (fn) => makeRoot({
    'extension/manifest.json': manifestText, 'extension/lib/constants.js': await readText(repoRoot, 'extension/lib/constants.js'),
    'extension/lib/protocol.js': fn(protocolText), ...Object.fromEntries([...referenced, ...EXTENSION_PAGES].map((path) => [path, ''])),
  });
  const pathsBaseline = await pathsFindings(await pathsRoot((text) => text));
  const drifted = newFindings(pathsBaseline, await pathsFindings(await pathsRoot((text) => mutate(text, /panel: 'extension\/panel\/panel\.html'/, "panel: 'extension/panel/other.html'"))));
  assert.ok(drifted.includes('PATHS_MANIFEST:panel'), 'PATHS parity fires when protocol.js drifts from the manifest');
});

// ---------------------------------------------------------------------------------------------------
// (2) the real-repo build into a temp directory
// ---------------------------------------------------------------------------------------------------

/**
 * Everything §10 and §11.1 say about a built folder, as findings. `sourceRoot` is the repository the folder was built
 * from; `outRoot` is the folder. The import-closure claim is proved on the OUTPUT: every relative reference of every
 * built .js/.html file must resolve to a file that is in the folder.
 */
async function outputFindings({ sourceRoot, outRoot }) {
  const findings = [];
  const files = await listFiles(outRoot);
  const present = new Set(files);
  const same = async (path, sourcePath = path) => {
    try { return (await readFile(join(outRoot, path))).equals(await readFile(join(sourceRoot, sourcePath))); } catch { return false; }
  };

  const TOP = new Set(['manifest.json', 'styles.css', '_locales', 'app', 'extension', 'icons']);
  // The build's ownership marker is the one allowed top-level dotfile: build metadata, never listed in result.files (10.2 step 4).
  for (const path of files.filter((name) => name !== OUTPUT_MARKER)) {
    const segments = path.split('/');
    if (!TOP.has(segments[0])) findings.push(`OUT_TOP_LEVEL:${path}`);
    if (segments.some((segment) => segment.startsWith('.'))) findings.push(`OUT_DOTFILE:${path}`);
    if (path === 'app/main.js' || path === 'app/security/builtin-key.js') findings.push(`OUT_FORBIDDEN:${path}`);
  }

  // manifest.json is re-serialized; every path it names must exist in the folder.
  let manifest = null;
  try { manifest = await readJson(sourceRoot, 'extension/manifest.json'); } catch { findings.push('OUT_SOURCE_MANIFEST_UNREADABLE'); }
  const builtManifest = await readText(outRoot, 'manifest.json').catch(() => null);
  if (manifest === null || builtManifest !== `${JSON.stringify(manifest, null, 2)}\n`) findings.push('OUT_MANIFEST');
  for (const { where, path } of referencedPaths(manifest)) if (path === null || !present.has(path)) findings.push(`OUT_MANIFEST_PATH:${where}`);
  for (const page of EXTENSION_PAGES) if (!present.has(page)) findings.push(`OUT_PAGE:${page}`);

  // _locales and icons
  const locales = files.filter((path) => path.startsWith('_locales/'));
  if (JSON.stringify(locales) !== JSON.stringify(sorted(LANGS.map((language) => `_locales/${language}/messages.json`)))) findings.push('OUT_LOCALES:set');
  for (const language of LANGS) if (!await same(`_locales/${language}/messages.json`, `extension/_locales/${language}/messages.json`)) findings.push(`OUT_LOCALES:${language}`);
  if (JSON.stringify(files.filter((path) => path.startsWith('icons/'))) !== JSON.stringify(sorted(Object.keys(ICON_SOURCES)))) findings.push('OUT_ICON:set');
  for (const [icon, size] of [['icons/icon-16.png', 16], ['icons/icon-32.png', 32]]) if (!await same(icon, ICON_SOURCES[icon])) findings.push(`OUT_ICON:${size}`);
  for (const [icon, size] of [['icons/icon-48.png', 48], ['icons/icon-128.png', 128]]) {
    const bytes = await readFile(join(outRoot, icon)).catch(() => Buffer.alloc(0));
    const valid = bytes.length > 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('latin1', 12, 16) === 'IHDR'
      && bytes.readUInt32BE(16) === size && bytes.readUInt32BE(20) === size && bytes[24] === 8 && bytes[25] === 2;
    if (!valid) findings.push(`OUT_ICON:${size}`);
  }

  // styles.css is a byte-identical copy; the fixed extras are all there; the worklet sits next to stream-capture.js.
  if (!await same('styles.css', 'styles.css')) findings.push('OUT_STYLES');
  for (const extra of EXTRA_FILES) if (!present.has(extra)) findings.push(`OUT_EXTRA_MISSING:${extra}`);
  if (!present.has('app/audio/stream-capture.js') || !present.has('app/audio/capture-worklet.js')) findings.push('OUT_WORKLET');
  if (!present.has('extension/engine/timer-worker.js')) findings.push('OUT_TIMER_WORKER');

  // extension/** is every source file except the manifest and _locales, byte for byte, and nothing else.
  const sourceExtension = (await listFiles(sourceRoot, 'extension')).filter((path) => path !== 'extension/manifest.json' && !path.startsWith('extension/_locales/')
    && !path.split('/').some((segment) => segment.startsWith('.')));
  for (const path of sourceExtension) if (!await same(path)) findings.push(`OUT_EXTENSION_FILE:${path}`);
  const expected = new Set(sourceExtension);
  for (const path of files.filter((name) => name.startsWith('extension/'))) if (!expected.has(path)) findings.push(`OUT_EXTENSION_EXTRA:${path}`);

  // The import graph of the folder: every relative reference resolves inside it (R7).
  const graph = new Map();
  for (const path of files.filter((name) => /\.(?:js|html)$/.test(name))) {
    const text = await readText(outRoot, path);
    const edges = [];
    for (const specifier of path.endsWith('.html') ? htmlReferencesOf(text) : specifiersOf(stripComments(text))) {
      if (!specifier.startsWith('.')) { findings.push(`OUT_IMPORT_NOT_RELATIVE:${path} -> ${specifier}`); continue; }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (present.has(target)) edges.push(target); else findings.push(`OUT_IMPORT_UNRESOLVED:${path} -> ${specifier}`);
    }
    graph.set(path, edges);
  }
  // app/ is the closure subset: byte-identical to the source, and everything in it is reachable from extension/ (or a fixed extra).
  const reached = new Set();
  const pending = files.filter((path) => path.startsWith('extension/'));
  while (pending.length > 0) {
    const path = pending.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    pending.push(...(graph.get(path) ?? []));
  }
  for (const path of files.filter((name) => name.startsWith('app/'))) {
    if (!await same(path)) findings.push(`OUT_APP_BYTES:${path}`);
    if (!reached.has(path) && !EXTRA_FILES.includes(path)) findings.push(`OUT_APP_UNREACHABLE:${path}`);
  }

  // Template-literal URLs are not followed by the build: every target must be under extension/ or a fixed extra (§10.3).
  for (const path of files.filter((name) => name.endsWith('.js'))) {
    for (const site of templateSitesOf(stripComments(await readText(outRoot, path)))) {
      const targets = templateTargets(path, site);
      if (targets === null) { findings.push(`OUT_TEMPLATE_URL_UNRESOLVABLE:${path}`); continue; }
      for (const target of targets) {
        if (!present.has(target)) findings.push(`OUT_TEMPLATE_URL_MISSING:${path} -> ${target}`);
        else if (!target.startsWith('extension/') && !EXTRA_FILES.includes(target)) findings.push(`OUT_TEMPLATE_URL_UNCOVERED:${path} -> ${target}`);
      }
    }
  }

  // No secret-shaped text anywhere in an unkeyed build, and the key slot is still empty.
  for (const path of files.filter((name) => /\.(?:js|html|css|json)$/.test(name))) {
    const text = await readText(outRoot, path);
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) findings.push(`OUT_SECRET:${path}`);
  }
  const slot = await readText(outRoot, 'extension/lib/builtin-key.js').catch(() => '');
  if (slot.split(KEY_SLOT).length - 1 !== 1) findings.push('OUT_KEY_SLOT');
  return findings;
}

// One real build of the repository, shared by the tests that need it. The out directory is a temp dir OUTSIDE the
// repo (never dist/); its sibling package.json lets the folder's modules load as ES modules for the loader test.
let realBuildPromise;
function realBuild() {
  realBuildPromise ??= (async () => {
    const parent = await tempDir('interp-exttree-build-');
    await writeFile(join(parent, 'package.json'), '{"type":"module"}\n');
    const out = join(parent, 'extension');
    const result = await buildExtension({ root: repoRoot, out });
    return { parent, out, result };
  })();
  return realBuildPromise;
}

test('the real repository builds into a temp directory and the result satisfies the contract of section 10', async () => {
  const { out, result } = await realBuild();
  const manifest = await readJson(repoRoot, 'extension/manifest.json');
  assert.ok(Object.isFrozen(result), 'the result is frozen');
  assert.deepEqual(Object.keys(result).sort(), ['builtinKeys', 'files', 'out', 'version', 'zip']);
  assert.equal(result.out, resolve(out), 'out is the absolute output directory');
  assert.ok(!(result.out + sep).startsWith(resolve(repoRoot) + sep), 'the test builds outside the repository, never into dist/');
  assert.equal(result.version, manifest.version);
  assert.equal(result.builtinKeys, 0, 'an unkeyed build');
  assert.equal(result.zip, null, 'no zip was requested');
  assert.ok(Array.isArray(result.files) && result.files.length > 0);
  assert.deepEqual(result.files, [...result.files].sort(), 'files are sorted');
  assert.equal(new Set(result.files).size, result.files.length, 'files are unique');
  assert.ok(result.files.every((path) => !path.startsWith('/') && !path.includes('\\') && !path.includes('..') && !path.startsWith('.')), 'files are relative POSIX paths');
  const onDisk = await listFiles(out);
  assert.ok(onDisk.includes(OUTPUT_MARKER), 'the build leaves its ownership marker');
  assert.deepEqual(result.files, onDisk.filter((path) => path !== OUTPUT_MARKER), 'result.files is exactly what is on disk, apart from the marker');
});

test('the built folder has the layout of section 3.2: manifest paths exist, imports resolve, no tests/docs/scripts/dotfiles/web-app entry, secrets absent', async () => {
  const { out } = await realBuild();
  const findings = await outputFindings({ sourceRoot: repoRoot, outRoot: out });
  assert.deepEqual(findings, []);
  const files = await listFiles(out);
  // Guards against a vacuous folder: the pieces the extension cannot run without.
  for (const required of ['manifest.json', 'styles.css', 'extension/background/service-worker.js', 'extension/panel/panel.html', 'extension/options/options.html',
    'extension/overlay/overlay.js', 'extension/engine/host.html', 'extension/engine/host.js', 'extension/lib/builtin-key.js', 'app/i18n/index.js', 'app/config.js']) {
    assert.ok(files.includes(required), `${required} is built`);
  }
  assert.ok(files.filter((path) => path.startsWith('app/')).length >= 40, 'the app/ closure subset is present');
  const key = await readText(out, 'extension/lib/builtin-key.js');
  assert.ok(key.includes(KEY_SLOT), 'the default build carries the empty key slot');
});

test('the build-output checks are not vacuous: each mutated copy of the real output reports the tag of its mutation', async () => {
  const { out } = await realBuild();
  const secret = `${['AI', 'za'].join('')}${'x'.repeat(30)}`;
  const append = (path, text) => async (root) => writeFile(join(root, path), `${await readText(root, path)}${text}`);
  const put = (path, text) => async (root) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  const remove = (path) => (root) => rm(join(root, path));
  const mutants = [
    ['a worklet is missing', remove('app/audio/capture-worklet.js'), 'OUT_EXTRA_MISSING'],
    ['the web app entry sneaks in', put('app/main.js', 'export {};\n'), 'OUT_FORBIDDEN'],
    ['the web app key slot sneaks in', put('app/security/builtin-key.js', 'export {};\n'), 'OUT_FORBIDDEN'],
    ['a dotfile sneaks in', put('extension/.hidden', 'x'), 'OUT_DOTFILE'],
    ['a tests/ directory sneaks in', put('tests/x.js', 'export {};\n'), 'OUT_TOP_LEVEL'],
    ['a docs/ directory sneaks in', put('docs/extension.md', 'x'), 'OUT_TOP_LEVEL'],
    ['a built module imports a file that is not built', append('extension/lib/i18n.js', "\nimport './not-built.js';\n"), 'OUT_IMPORT_UNRESOLVED'],
    ['a built module imports a bare specifier', append('extension/lib/links.js', "\nimport 'left-pad';\n"), 'OUT_IMPORT_NOT_RELATIVE'],
    ['a built page references a script that is not built', append('extension/panel/panel.html', '<script type="module" src="./gone.js"></script>\n'), 'OUT_IMPORT_UNRESOLVED'],
    ['styles.css differs', append('styles.css', '\n/* edited */\n'), 'OUT_STYLES'],
    ['a dead app module is present', put('app/dead-module.js', 'export {};\n'), 'OUT_APP_UNREACHABLE'],
    ['an app module differs from the source', append('app/config.js', '\n// edited\n'), 'OUT_APP_BYTES'],
    ['the timer worker is missing', remove('extension/engine/timer-worker.js'), 'OUT_TIMER_WORKER'],
    ['a manifest-referenced file is missing', remove('extension/overlay/overlay.js'), 'OUT_MANIFEST_PATH'],
    ['the manifest differs from its re-serialization', append('manifest.json', ' '), 'OUT_MANIFEST'],
    ['a _locales file differs', append('_locales/ko/messages.json', ' '), 'OUT_LOCALES'],
    ['a 48 px icon is a 16 px icon', async (root) => writeFile(join(root, 'icons/icon-48.png'), await readFile(join(root, 'icons/icon-16.png'))), 'OUT_ICON'],
    ['an extension file differs from the source', append('extension/lib/settings.js', '\n// edited\n'), 'OUT_EXTENSION_FILE'],
    ['an extra file appears under extension/', put('extension/lib/extra.js', 'export {};\n'), 'OUT_EXTENSION_EXTRA'],
    ['a secret-shaped string appears', append('extension/lib/links.js', `\nexport const leaked = '${secret}';\n`), 'OUT_SECRET'],
    ['the key slot is filled', async (root) => writeFile(join(root, 'extension/lib/builtin-key.js'),
      (await readText(root, 'extension/lib/builtin-key.js')).replace(KEY_SLOT, "export const BUILTIN_KEYS = Object.freeze(['k']);")), 'OUT_KEY_SLOT'],
    ['a template URL names an app file that is not a fixed extra', put('extension/lib/uncovered.js', 'export const u = new URL(`../../app/config.js`, import.meta.url);\n'), 'OUT_TEMPLATE_URL_UNCOVERED'],
    ['a template URL names a file that is not built', put('extension/lib/missing-url.js', 'export const u = new URL(`../../app/config/${language}.json`, import.meta.url);\n'), 'OUT_TEMPLATE_URL_MISSING'],
    ['a template URL with two holes', put('extension/lib/holes.js', 'export const u = new URL(`./${a}-${b}.json`, import.meta.url);\n'), 'OUT_TEMPLATE_URL_UNRESOLVABLE'],
  ];
  const baseline = await outputFindings({ sourceRoot: repoRoot, outRoot: out });
  for (const [label, mutation, expected] of mutants) {
    const copy = await tempDir('interp-exttree-mutant-');
    await cp(out, join(copy, 'extension'), { recursive: true });
    const root = join(copy, 'extension');
    await mutation(root);
    const fresh = newFindings(baseline, await outputFindings({ sourceRoot: repoRoot, outRoot: root }));
    assert.ok(fresh.some((finding) => finding.startsWith(expected)), `${label}: expected ${expected}, saw ${fresh.map(tagOf).join(',') || 'nothing new'}`);
  }
});

test('rebuilding into the same directory needs no --clean, and two builds are byte-identical', async () => {
  const { out, result } = await realBuild();
  const before = await treeDigest(out);
  const again = await buildExtension({ root: repoRoot, out });
  assert.deepEqual(again.files, result.files, 'the second build reports the same files');
  assert.equal(again.version, result.version);
  assert.equal(await treeDigest(out), before, 'the rebuilt folder is byte-identical');
  const fresh = await tempDir('interp-exttree-fresh-');
  const other = await buildExtension({ root: repoRoot, out: join(fresh, 'extension') });
  assert.deepEqual(other.files, result.files);
  assert.equal(await treeDigest(join(fresh, 'extension')), before, 'a build into a new directory is byte-identical too');
});

test('the CLI builds the real repository into a temp directory, prints one EXTENSION_BUILT line, and repeats without --clean', async () => {
  const { out: apiOut, result } = await realBuild();
  const parent = await tempDir('interp-exttree-cli-');
  const out = join(parent, 'extension');
  const script = join(repoRoot, 'scripts/build-extension.mjs');
  const run = async () => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--out', out], { cwd: repoRoot, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  const version = (await readJson(repoRoot, 'extension/manifest.json')).version;
  const digests = [];
  for (const attemptNumber of [1, 2]) {
    const outcome = await run();
    assert.deepEqual([outcome.code, outcome.stderr], [0, ''], `run ${attemptNumber} exits 0 with an empty stderr`);
    const match = /^EXTENSION_BUILT out=(.+) files=(\d+) version=(\S+)\n$/.exec(outcome.stdout);
    assert.ok(match, `run ${attemptNumber} prints exactly one EXTENSION_BUILT line: ${JSON.stringify(outcome.stdout)}`);
    assert.equal(resolve(match[1]), resolve(out), 'the printed out is the requested directory');
    assert.equal(Number(match[2]), result.files.length, 'the CLI reports the same file count as the API build');
    assert.equal(match[3], version);
    digests.push(await treeDigest(out));
  }
  assert.equal(digests[0], digests[1], 'the repeated CLI run leaves an identical folder');
  assert.equal(digests[0], await treeDigest(apiOut), 'the CLI folder equals the API folder');
  assert.ok(!(resolve(out) + sep).startsWith(resolve(repoRoot) + sep), 'the CLI was pointed outside the repository, so the real dist/ is never written');
});

test('template-literal URL sites are covered by the fixed extras, and the built loader reads the built dictionaries', async () => {
  const { out } = await realBuild();
  const sites = [];
  for (const path of (await listFiles(out)).filter((name) => name.endsWith('.js'))) {
    for (const site of templateSitesOf(stripComments(await readText(out, path)))) sites.push([path, site]);
  }
  const loaderSites = sites.filter(([path]) => path === 'extension/lib/i18n.js');
  assert.equal(loaderSites.length, 2, 'the extension loader names the app and the extension dictionary through template URLs');
  assert.ok(sites.some(([path]) => path === 'app/i18n/index.js'), 'the app loader has a template URL site too');
  for (const [path, site] of sites) {
    const targets = templateTargets(path, site);
    assert.ok(targets !== null, `${path}: ${site} can be enumerated`);
    for (const target of targets) {
      assert.ok(target.startsWith('extension/') || EXTRA_FILES.includes(target), `${target} (named by ${path}) is a fixed extra or under extension/`);
      assert.ok(isFileSync(join(out, target)), `${target} is in the built folder`);
    }
  }
  // End to end inside the built folder: the loader's URLs resolve to the built dictionaries and merge both.
  const { loadExtensionI18n } = await importFromRoot(out, 'extension/lib/i18n.js');
  const fetcher = async (url) => ({ ok: true, json: async () => JSON.parse(await readFile(fileURLToPath(url), 'utf8')) });
  const i18n = await loadExtensionI18n({ fetch: fetcher, language: 'en' });
  const ext = Object.fromEntries(await Promise.all(LANGS.map(async (language) => [language, await readJson(out, `extension/i18n/${language}.json`)])));
  assert.equal(i18n.has('ext.name') && i18n.has('common.start') && i18n.has('error.unknown'), true, 'app and extension keys are both loaded');
  for (const language of LANGS) {
    i18n.setLanguage(language);
    assert.equal(i18n.t('ext.name'), ext[language]['ext.name'], `${language} ext.name comes from the built dictionary`);
    assert.notEqual(i18n.t('common.start'), i18n.t('error.unknown'));
  }
});

// ---------------------------------------------------------------------------------------------------
// (3) the real-tree i18n scan
// ---------------------------------------------------------------------------------------------------

const issueCodes = (result) => result.issues.map((issue) => (typeof issue === 'string' ? issue : issue.code));

test('the i18n scan is clean on the real tree and its file count includes every extension source it should scan', async () => {
  const result = await checkI18n({ root: repoRoot });
  assert.deepEqual(result.issues, [], 'no issue on the real repository');
  assert.equal(result.ok, true);
  assert.ok(result.keys > 0);
  // The checker skips directories named i18n and only reads .js/.mjs/.html; count what it must have visited under extension/.
  const scanned = (await listFiles(repoRoot, 'extension')).filter((path) => /\.(?:js|mjs|html)$/.test(path) && !path.split('/').includes('i18n'));
  assert.ok(scanned.length >= 30, `the extension tree has scannable files (${scanned.length})`);
  assert.ok(result.files >= scanned.length, `the scan visited at least the ${scanned.length} extension files (files=${result.files})`);
});

test('the i18n scan reaches the real extension tree: literals, unknown keys and dictionary drift in a copy are all reported', async () => {
  async function copyRoot(edit) {
    const root = await tempDir('interp-exttree-i18n-');
    await mkdir(join(root, 'app'), { recursive: true });
    await cp(join(repoRoot, 'app/i18n'), join(root, 'app/i18n'), { recursive: true });
    await cp(join(repoRoot, 'extension'), join(root, 'extension'), { recursive: true });
    await edit(root);
    return root;
  }
  const baseline = await checkI18n({ root: await copyRoot(async () => {}) });
  assert.deepEqual(baseline.issues, [], 'the copy of the real extension tree is clean, so the mutants below are the only difference');
  const mutants = [
    ['an unknown key in a nested source', (root) => writeFile(join(root, 'extension/panel/zz-mutant.js'), "export const label = (i18n) => i18n.t('ext.no.such.key');\n"), 'I18N_UNKNOWN_UI_KEY'],
    ['a literal UI text', (root) => writeFile(join(root, 'extension/options/zz-mutant.js'), "export const paint = (el) => { el.textContent = 'Hello'; };\n"), 'I18N_LITERAL_UI_TEXT'],
    ['literal text in a page', (root) => writeFile(join(root, 'extension/permission/zz-mutant.html'), '<p>Hello</p>\n'), 'I18N_LITERAL_UI_TEXT'],
    ['a key missing from one extension dictionary', async (root) => {
      const dictionary = JSON.parse(await readFile(join(root, 'extension/i18n/ja.json'), 'utf8'));
      delete dictionary['ext.name'];
      await writeFile(join(root, 'extension/i18n/ja.json'), JSON.stringify(dictionary));
    }, 'I18N_KEY_MISMATCH'],
  ];
  for (const [label, edit, expected] of mutants) {
    const result = await checkI18n({ root: await copyRoot(edit) });
    assert.ok(issueCodes(result).includes(expected), `${label}: expected ${expected}, saw ${issueCodes(result).join(',') || 'nothing'}`);
    assert.equal(result.ok, false, label);
  }
});

// ---------------------------------------------------------------------------------------------------
// (4) WIRE parity: overlay.js (a classic script with no imports) against protocol.js and constants.js
// ---------------------------------------------------------------------------------------------------

// The literals of §3.5, written here so protocol.js is pinned against them too (this is where the two groups meet).
const WIRE_PINS = Object.freeze({ overlayPort: 'interp-overlay/1', panelPort: 'interp-panel/1', version: 1, maxRows: 6, maxRowChars: 400, maxFrameBytes: 8192 });
const STYLE_FRAME_FIELDS = Object.freeze(['autoHideSeconds', 'display', 'maxLines', 'position', 'size']);   // §4.5: no showSource

async function wireFindings(root) {
  const findings = [];
  let overlay;
  try { overlay = stripComments(await readText(root, 'extension/overlay/overlay.js')); } catch { return ['WIRE_OVERLAY_UNREADABLE']; }
  let protocol;
  let constants;
  let frames;
  try {
    protocol = await importFromRoot(root, 'extension/lib/protocol.js');
    constants = await importFromRoot(root, 'extension/lib/constants.js');
    frames = await importFromRoot(root, 'extension/lib/caption-frames.js');
  } catch { return ['WIRE_MODULE_UNLOADABLE']; }
  const { PORT_NAMES, PROTOCOL_VERSION, LIMITS, LANES, FRAME_TYPES, MESSAGE_CATALOG } = protocol;

  // protocol.js against the literals of §3.5
  if (PORT_NAMES?.overlay !== WIRE_PINS.overlayPort) findings.push('WIRE_PIN:PORT_NAMES.overlay');
  if (PORT_NAMES?.panel !== WIRE_PINS.panelPort) findings.push('WIRE_PIN:PORT_NAMES.panel');
  if (PROTOCOL_VERSION !== WIRE_PINS.version) findings.push('WIRE_PIN:PROTOCOL_VERSION');
  if (LIMITS?.maxRows !== WIRE_PINS.maxRows) findings.push('WIRE_PIN:LIMITS.maxRows');
  if (LIMITS?.maxRowChars !== WIRE_PINS.maxRowChars) findings.push('WIRE_PIN:LIMITS.maxRowChars');
  if (LIMITS?.maxFrameBytes !== WIRE_PINS.maxFrameBytes) findings.push('WIRE_PIN:LIMITS.maxFrameBytes');

  // the WIRE literal: ONE frozen flat object with exactly four fields, equal to protocol.js
  if ((overlay.match(/\bconst\s+WIRE\s*=/g) ?? []).length !== 1) findings.push('WIRE_SHAPE:declaration count');
  const wire = frozenObjectConst(overlay, 'WIRE');
  if (wire === null) findings.push('WIRE_SHAPE:not a frozen flat literal');
  else {
    if (JSON.stringify(sorted(Object.keys(wire))) !== JSON.stringify(['maxRowChars', 'maxRows', 'port', 'v'])) findings.push('WIRE_SHAPE:fields');
    if (wire.port !== PORT_NAMES?.overlay) findings.push('WIRE_PORT');
    if (wire.v !== PROTOCOL_VERSION) findings.push('WIRE_VERSION');
    if (wire.maxRows !== LIMITS?.maxRows) findings.push('WIRE_MAX_ROWS');
    if (wire.maxRowChars !== LIMITS?.maxRowChars) findings.push('WIRE_MAX_ROW_CHARS');
  }

  // frame names (§4.5): the overlay handles exactly what the host sends and sends only what the host accepts
  const switchAt = overlay.search(/switch\s*\(\s*frame\.type\s*\)/);
  const handled = switchAt < 0 ? null : [...(braceBlock(overlay, switchAt) ?? '').matchAll(/\bcase\s+(['"])([^'"]+)\1\s*:/g)].map((match) => match[2]);
  if (handled === null || JSON.stringify(sorted(handled)) !== JSON.stringify(sorted(FRAME_TYPES?.['host->overlay'] ?? []))) findings.push('WIRE_FRAMES_IN');
  const sent = [...overlay.matchAll(/\bpostMessage\(\s*\{[^}]*\btype\s*:\s*(['"])([^'"]+)\1/g)].map((match) => match[2]);
  if (JSON.stringify(sorted(new Set(sent))) !== JSON.stringify(sorted(FRAME_TYPES?.['overlay->host'] ?? [])) || sent.length === 0) findings.push('WIRE_FRAMES_OUT');

  // the style frame (§4.5, I8): five fields, no showSource; what the host builds is what the overlay reads
  const onStyle = functionBody(overlay, 'onStyle');
  const read = onStyle === null ? null : sorted(new Set([...onStyle.matchAll(/\bnext\.(\w+)/g)].map((match) => match[1])));
  if (read === null || JSON.stringify(read) !== JSON.stringify(STYLE_FRAME_FIELDS)) findings.push('WIRE_STYLE_FIELDS:overlay reads');
  let styleFrame = null;
  try { styleFrame = frames.buildStyleFrame(constants.DEFAULT_STYLE); } catch { findings.push('WIRE_STYLE_FIELDS:buildStyleFrame'); }
  if (styleFrame !== null) {
    if (JSON.stringify(sorted(Object.keys(styleFrame.style))) !== JSON.stringify(STYLE_FRAME_FIELDS)) findings.push('WIRE_STYLE_FIELDS:host builds');
    const checked = protocol.validateFrame('host->overlay', styleFrame);
    if (!checked.ok || JSON.stringify(sorted(Object.keys(checked.frame.style))) !== JSON.stringify(STYLE_FRAME_FIELDS)) findings.push('WIRE_STYLE_FIELDS:validator');
  }
  // ranges and enums the overlay repeats
  const limits = constants.STYLE_LIMITS;
  const ranges = new Map([...(onStyle ?? '').matchAll(/\bnext\.(\w+)\s*>=\s*(-?[\d.]+)\s*&&\s*next\.\1\s*<=\s*(-?[\d.]+)/g)].map((match) => [match[1], [Number(match[2]), Number(match[3])]]));
  for (const field of ['size', 'maxLines', 'autoHideSeconds']) {
    const range = ranges.get(field);
    if (!range || range[0] !== limits?.[field]?.min || range[1] !== limits?.[field]?.max) findings.push(`WIRE_STYLE_RANGE:${field}`);
  }
  const defaults = frozenObjectConst(overlay, 'DEFAULT_STYLE');
  for (const field of STYLE_FRAME_FIELDS) if (defaults?.[field] !== constants.DEFAULT_STYLE?.[field]) findings.push(`WIRE_DEFAULT_STYLE:${field}`);
  for (const [name, list] of [['LANES', LANES], ['LANGUAGES', constants.TARGET_LANGUAGES], ['ROW_STATUSES', constants.CAPTION_STATUSES], ['GAP_KINDS', constants.GAP_KINDS],
    ['PHASES', constants.STATUS_PHASES], ['POSITIONS', constants.CAPTION_POSITIONS], ['DISPLAYS', constants.CAPTION_DISPLAYS]]) {
    const own = frozenListConst(overlay, name);
    if (own === null || JSON.stringify(sorted(own)) !== JSON.stringify(sorted(list ?? []))) findings.push(`WIRE_ENUM:${name}`);
  }
  // the frame-size cap of §8.5.3 (16384 characters) must not reject a frame the host may legally send
  const cap = Number(/\bconst\s+MAX_FRAME_CHARS\s*=\s*(\d+)/.exec(overlay)?.[1]);
  if (cap !== 16384 || !(cap >= (LIMITS?.maxFrameBytes ?? Infinity))) findings.push('WIRE_FRAME_CAP');
  // the attach message: what the overlay trusts is what makeMessage builds
  const attachType = /\bmessage\.type\s*===\s*(['"])([^'"]+)\1/.exec(overlay)?.[2];
  const attachTarget = /\bmessage\.target\s*===\s*(['"])([^'"]+)\1/.exec(overlay)?.[2];
  const entry = MESSAGE_CATALOG?.[attachType];
  if (!attachType || !entry || entry.target !== attachTarget || !entry.roles.includes('sw')) findings.push('WIRE_ATTACH:catalog');
  else {
    const message = attempt(() => protocol.makeMessage(attachType, {}));
    if (!message || message.v !== wire?.v || message.target !== attachTarget || message.type !== attachType) findings.push('WIRE_ATTACH:makeMessage');
  }
  return findings;
}

test('WIRE parity on the real tree: overlay.js agrees with protocol.js and constants.js (port, version, limits, frames, style frame, enums)', async () => {
  assert.deepEqual(await wireFindings(repoRoot), []);
  // Guard against a vacuous extraction: the real overlay carries the literal of §3.5 and reads the five style fields.
  const overlay = stripComments(await readText(repoRoot, 'extension/overlay/overlay.js'));
  assert.deepEqual(frozenObjectConst(overlay, 'WIRE'), { port: WIRE_PINS.overlayPort, v: WIRE_PINS.version, maxRows: WIRE_PINS.maxRows, maxRowChars: WIRE_PINS.maxRowChars });
  const protocol = await importFromRoot(repoRoot, 'extension/lib/protocol.js');
  assert.deepEqual([protocol.PORT_NAMES.overlay, protocol.PROTOCOL_VERSION, protocol.LIMITS.maxRows, protocol.LIMITS.maxRowChars],
    [WIRE_PINS.overlayPort, WIRE_PINS.version, WIRE_PINS.maxRows, WIRE_PINS.maxRowChars]);
  assert.deepEqual(sorted(protocol.FRAME_TYPES['host->overlay']), ['bye', 'captions', 'clear', 'status', 'style']);
  assert.deepEqual(protocol.FRAME_TYPES['overlay->host'], ['hello']);
});

test('the WIRE parity check is not vacuous: every mutant root reports the tag of its mutation', async () => {
  const PATHS = ['extension/overlay/overlay.js', 'extension/lib/protocol.js', 'extension/lib/constants.js', 'extension/lib/caption-frames.js'];
  const originals = Object.fromEntries(await Promise.all(PATHS.map(async (path) => [path, await readText(repoRoot, path)])));
  const wireRoot = (edits = {}) => makeRoot(Object.fromEntries(PATHS.map((path) => [path, edits[path] ? edits[path](originals[path]) : originals[path]])));
  const [overlay, protocol, constants, captionFrames] = PATHS;
  const mutants = [
    ['overlay port differs', { [overlay]: (t) => mutate(t, "port: 'interp-overlay/1'", "port: 'interp-overlay/2'") }, ['WIRE_PORT']],
    ['overlay version differs', { [overlay]: (t) => mutate(t, "Object.freeze({ port: 'interp-overlay/1', v: 1,", "Object.freeze({ port: 'interp-overlay/1', v: 2,") }, ['WIRE_VERSION']],
    ['overlay maxRows differs', { [overlay]: (t) => mutate(t, 'maxRows: 6, maxRowChars', 'maxRows: 5, maxRowChars') }, ['WIRE_MAX_ROWS']],
    ['overlay maxRowChars differs', { [overlay]: (t) => mutate(t, 'maxRowChars: 400 })', 'maxRowChars: 399 })') }, ['WIRE_MAX_ROW_CHARS']],
    ['protocol overlay port differs', { [protocol]: (t) => mutate(t, "overlay: 'interp-overlay/1'", "overlay: 'interp-overlay/2'") }, ['WIRE_PIN', 'WIRE_PORT']],
    ['protocol LIMITS.maxRows differs', { [protocol]: (t) => mutate(t, /maxRows: 6,/, 'maxRows: 7,') }, ['WIRE_PIN', 'WIRE_MAX_ROWS']],
    ['protocol LIMITS.maxRowChars differs', { [protocol]: (t) => mutate(t, /maxRowChars: 400,/, 'maxRowChars: 420,') }, ['WIRE_PIN', 'WIRE_MAX_ROW_CHARS']],
    ['protocol version differs', { [protocol]: (t) => mutate(t, 'PROTOCOL_VERSION = 1;', 'PROTOCOL_VERSION = 2;') }, ['WIRE_PIN', 'WIRE_VERSION']],
    ['WIRE loses its freeze', { [overlay]: (t) => mutate(t, "const WIRE = Object.freeze({ port: 'interp-overlay/1', v: 1, maxRows: 6, maxRowChars: 400 });", "const WIRE = { port: 'interp-overlay/1', v: 1, maxRows: 6, maxRowChars: 400 };") }, ['WIRE_SHAPE']],
    ['WIRE gains a field', { [overlay]: (t) => mutate(t, 'maxRowChars: 400 })', 'maxRowChars: 400, extra: 1 })') }, ['WIRE_SHAPE']],
    ['overlay stops handling clear', { [overlay]: (t) => mutate(t, "case 'clear':", "case 'clean':") }, ['WIRE_FRAMES_IN']],
    ['protocol adds a frame the overlay does not know', { [protocol]: (t) => mutate(t, /'host->overlay': \['style', 'captions', 'clear', 'status', 'bye'\]/, "'host->overlay': ['style', 'captions', 'clear', 'status', 'bye', 'ping']") }, ['WIRE_FRAMES_IN']],
    ['overlay sends a frame the host does not accept', { [overlay]: (t) => mutate(t, "port.postMessage({ v: WIRE.v, type: 'hello' })", "port.postMessage({ v: WIRE.v, type: 'hi' })") }, ['WIRE_FRAMES_OUT']],
    ['overlay reads a style field the host never sends', { [overlay]: (t) => mutate(t, 'if (POSITIONS.includes(next.position))', 'if (next.showSource, POSITIONS.includes(next.position))') }, ['WIRE_STYLE_FIELDS']],
    ['overlay reads a renamed style field', { [overlay]: (t) => mutateAll(t, 'next.autoHideSeconds', 'next.autoHide') }, ['WIRE_STYLE_FIELDS']],
    ['host style frame carries showSource', { [captionFrames]: (t) => mutate(t, /return deepFreeze\(\{ v: PROTOCOL_VERSION, type: 'style', style: \{ size, position, display, maxLines, autoHideSeconds \} \}\);/,
      "return deepFreeze({ v: PROTOCOL_VERSION, type: 'style', style: { size, position, display, maxLines, autoHideSeconds, showSource: false } });") }, ['WIRE_STYLE_FIELDS']],
    ['overlay range differs from STYLE_LIMITS', { [overlay]: (t) => mutate(t, 'next.maxLines <= 6', 'next.maxLines <= 7') }, ['WIRE_STYLE_RANGE']],
    ['STYLE_LIMITS differs from the overlay range', { [constants]: (t) => mutate(t, /maxLines: Object\.freeze\(\{ min: 1, max: 6, initial: 3 \}\)/, 'maxLines: Object.freeze({ min: 1, max: 8, initial: 3 })') }, ['WIRE_STYLE_RANGE']],
    ['overlay default style differs', { [overlay]: (t) => mutate(t, 'maxLines: 3, autoHideSeconds: 8 });', 'maxLines: 4, autoHideSeconds: 8 });') }, ['WIRE_DEFAULT_STYLE']],
    ['constants gain a caption position', { [constants]: (t) => mutate(t, "CAPTION_POSITIONS = Object.freeze(['top', 'bottom'])", "CAPTION_POSITIONS = Object.freeze(['top', 'middle', 'bottom'])") }, ['WIRE_ENUM']],
    ['overlay display list differs', { [overlay]: (t) => mutate(t, "const DISPLAYS = Object.freeze(['dark', 'light', 'mono'])", "const DISPLAYS = Object.freeze(['dark', 'light'])") }, ['WIRE_ENUM']],
    ['overlay frame cap below the host frame limit', { [overlay]: (t) => mutate(t, 'MAX_FRAME_CHARS = 16384', 'MAX_FRAME_CHARS = 4096') }, ['WIRE_FRAME_CAP']],
    ['overlay trusts another attach type', { [overlay]: (t) => mutate(t, "message.type === 'content/overlay-attach'", "message.type === 'content/overlay-open'") }, ['WIRE_ATTACH']],
    ['overlay trusts another target', { [overlay]: (t) => mutate(t, "message.target === 'content'", "message.target === 'panel'") }, ['WIRE_ATTACH']],
  ];
  // The baseline is the unmutated copy of the real files: a mutant only counts for what it reports beyond it.
  const baseline = await wireFindings(await wireRoot());
  for (const [label, edits, expected] of mutants) {
    const fresh = newFindings(baseline, await wireFindings(await wireRoot(edits)));
    assert.ok(expected.some((tag) => fresh.some((finding) => tagOf(finding) === tag)),
      `${label}: expected one of ${expected.join(',')}, saw ${fresh.map(tagOf).join(',') || 'nothing new'}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// (5) dictionary / loader / HTML key coverage
// ---------------------------------------------------------------------------------------------------

const BINDERS = Object.freeze(['data-i18n', 'data-i18n-label', 'data-i18n-tip', 'data-i18n-hint']);   // §8.1
const APP_NAMESPACES = 'common|language|sim|display|captionOnly|settings|keyGuide|permission|seq|error';   // §9.4

/** Every key the extension pages and modules name: ext.* literals and data-i18n* values, plus app keys of the §9.4 namespaces. */
async function referencedKeys(root) {
  const refs = { ext: new Map(), app: new Map(), spellings: [], htmlFiles: 0, jsFiles: 0 };
  const note = (map, key, file) => { map.set(key, [...(map.get(key) ?? []), file]); };
  const extension = await listFiles(root, 'extension');
  for (const path of extension.filter((name) => name.endsWith('.html'))) {
    refs.htmlFiles += 1;
    const markup = (await readText(root, path)).replace(/<!--[\s\S]*?-->/g, '');
    for (const match of markup.matchAll(/\b(data-i18n(?:-[\w-]+)?)\s*=\s*(["'])(.*?)\2/g)) {
      if (!BINDERS.includes(match[1])) refs.spellings.push(`${path}:${match[1]}`);
      note(match[3].startsWith('ext.') ? refs.ext : refs.app, match[3], path);
    }
  }
  for (const { path, code } of await extensionCode(root)) {
    refs.jsFiles += 1;
    for (const match of code.matchAll(/(['"`])(ext\.[A-Za-z]\w*(?:\.\w+)*)\1/g)) note(refs.ext, match[2], path);
    for (const match of code.matchAll(/\bt\(\s*(['"])([a-z][^'"\r\n]*)\1/g)) if (!match[2].startsWith('ext.')) note(refs.app, match[2], path);
    for (const match of code.matchAll(new RegExp(`(['"])((?:${APP_NAMESPACES})\\.[A-Za-z]\\w*(?:\\.\\w+)*)\\1`, 'g'))) note(refs.app, match[2], path);
  }
  return refs;
}

async function keyCoverage(root, { allowedOrphans = new Set() } = {}) {
  const findings = [];
  const app = {};
  const ext = {};
  for (const language of LANGS) {
    try { app[language] = await readJson(root, `app/i18n/${language}.json`); ext[language] = await readJson(root, `extension/i18n/${language}.json`); } catch { return { findings: [`DICTIONARY_UNREADABLE:${language}`], stats: {} }; }
  }
  const keys = Object.keys(ext.en).sort();
  for (const language of LANGS) if (JSON.stringify(Object.keys(ext[language]).sort()) !== JSON.stringify(keys)) findings.push(`KEY_PARITY:${language}`);
  for (const key of keys) {
    if (!key.startsWith('ext.')) findings.push(`KEY_PREFIX:${key}`);
    if (LANGS.some((language) => Object.hasOwn(app[language], key))) findings.push(`KEY_COLLISION:${key}`);
  }
  const refs = await referencedKeys(root);
  for (const [key, files] of refs.ext) for (const language of LANGS) if (!Object.hasOwn(ext[language], key)) findings.push(`KEY_MISSING_EXT:${language}:${key} (${files[0]})`);
  for (const [key, files] of refs.app) for (const language of LANGS) if (!Object.hasOwn(app[language], key)) findings.push(`KEY_MISSING_APP:${language}:${key} (${files[0]})`);
  for (const key of keys) if (key.startsWith('ext.') && !refs.ext.has(key) && !allowedOrphans.has(key)) findings.push(`KEY_ORPHAN:${key}`);
  for (const spelling of refs.spellings) findings.push(`BINDER_SPELLING:${spelling}`);
  return { findings, stats: { extRefs: refs.ext.size, appRefs: refs.app.size, htmlFiles: refs.htmlFiles, jsFiles: refs.jsFiles, keys: keys.length } };
}

/**
 * The ext.* keys that may exist without a literal reference (§9.3, §9.6): the keys mirrored into _locales (consumed by
 * Chrome, not by extension code), the ext.error.<CODE> family the code builds with a template, and the two small
 * families named in 9.6. Everything else must be referenced by a page or a module.
 */
async function realAllowedOrphans(root) {
  const uiState = await importFromRoot(root, 'extension/lib/ui-state.js');
  return new Set([...MIRROR.map(([, key]) => key), ...[...uiState.EXTENSION_ERROR_CODES, ...uiState.OVERRIDDEN_ENGINE_CODES].map((code) => `ext.error.${code}`),
    'ext.lane.tab.title', 'ext.lane.mic.title', 'ext.options.position.top', 'ext.options.position.bottom']);
}

// §9.3: the twelve _locales messages and the ext.* keys they mirror.
const MIRROR = Object.freeze([
  ['extName', 'ext.name'], ['extDescription', 'ext.description'], ['actionTitle', 'ext.action.title'], ['commandOpen', 'ext.command.open'],
  ['menuOpen', 'ext.menu.open'], ['overlayRegion', 'ext.overlay.region'], ['overlayHide', 'ext.overlay.hide'], ['overlayLaneTab', 'ext.lane.tab.title'],
  ['overlayLaneMic', 'ext.lane.mic.title'], ['overlayGap', 'ext.overlay.gap'], ['overlayReconnecting', 'ext.overlay.reconnecting'], ['overlayStopped', 'ext.overlay.stopped'],
]);

test('every data-i18n* key of every page and every ext.* key of every module exists in all three dictionaries, and no ext.* key is an orphan', async () => {
  const { findings, stats } = await keyCoverage(repoRoot, { allowedOrphans: await realAllowedOrphans(repoRoot) });
  assert.deepEqual(findings, []);
  // Guard against a vacuous scan: today 110 distinct ext.* keys are named by pages and modules, out of 113 in the dictionary.
  assert.ok(stats.htmlFiles >= 4 && stats.jsFiles >= 30, `pages and modules are scanned (${stats.htmlFiles} pages, ${stats.jsFiles} modules)`);
  assert.ok(stats.extRefs >= 60, `ext.* references are found (${stats.extRefs})`);
  assert.ok(stats.appRefs >= 10, `app-key references are found (${stats.appRefs})`);
  assert.ok(stats.keys >= 100, `the dictionary is read (${stats.keys} keys)`);
});

test('the ext.error.* keys are exactly EXTENSION_ERROR_CODES plus OVERRIDDEN_ENGINE_CODES (§9.6), in every language', async () => {
  const { EXTENSION_ERROR_CODES, OVERRIDDEN_ENGINE_CODES } = await importFromRoot(repoRoot, 'extension/lib/ui-state.js');
  assert.equal(new Set([...EXTENSION_ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES]).size, EXTENSION_ERROR_CODES.length + OVERRIDDEN_ENGINE_CODES.length, 'the two code lists are disjoint');
  const expected = sorted([...EXTENSION_ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES].map((code) => `ext.error.${code}`));
  assert.equal(expected.length, 28);
  for (const language of LANGS) {
    const dictionary = await readJson(repoRoot, `extension/i18n/${language}.json`);
    assert.deepEqual(sorted(Object.keys(dictionary).filter((key) => key.startsWith('ext.error.'))), expected, `${language} ext.error.* set`);
  }
});

test('the key-coverage check is not vacuous: each mutant root reports the tag of its mutation', async () => {
  const app = { en: { 'common.start': 'Start', 'error.unknown': 'Unknown' }, ko: { 'common.start': '시작', 'error.unknown': '알 수 없음' }, ja: { 'common.start': '開始', 'error.unknown': '不明' } };
  const ext = { en: { 'ext.a.one': 'One', 'ext.a.two': 'Two', 'ext.dyn.x': 'X' }, ko: { 'ext.a.one': '하나', 'ext.a.two': '둘', 'ext.dyn.x': '엑스' }, ja: { 'ext.a.one': '一', 'ext.a.two': '二', 'ext.dyn.x': 'エックス' } };
  const allowed = new Set(['ext.dyn.x']);
  const base = {
    html: '<button data-i18n="ext.a.one"></button><input data-i18n-hint="common.start">',
    js: "// the key 'ext.a.nothing' is only named here, in a comment\nexport const label = (i18n) => i18n.t('ext.a.two');\n",
    app, ext,
  };
  const build = ({ html = base.html, js = base.js, appDict = base.app, extDict = base.ext, extraJs = {} } = {}) => makeRoot({
    ...Object.fromEntries(LANGS.map((language) => [`app/i18n/${language}.json`, JSON.stringify(appDict[language])])),
    ...Object.fromEntries(LANGS.map((language) => [`extension/i18n/${language}.json`, JSON.stringify(extDict[language])])),
    'extension/panel/panel.html': html, 'extension/panel/panel.js': js, ...extraJs,
  });
  const withKey = (dictionary, key, value, only = LANGS) => Object.fromEntries(LANGS.map((language) => [language, only.includes(language) ? { ...dictionary[language], [key]: value } : dictionary[language]]));
  const without = (dictionary, key, only) => Object.fromEntries(LANGS.map((language) => {
    const copy = { ...dictionary[language] };
    if (only.includes(language)) delete copy[key];
    return [language, copy];
  }));
  const baseline = await keyCoverage(await build(), { allowedOrphans: allowed });
  assert.deepEqual(baseline.findings, [], 'the unmutated string root is clean (comment-only references and an allowed orphan included)');
  assert.deepEqual([baseline.stats.extRefs, baseline.stats.appRefs], [2, 1]);
  const mutants = [
    ['a page names a missing ext key', { html: `${base.html}<span data-i18n="ext.a.missing"></span>` }, 'KEY_MISSING_EXT'],
    ['a module names a misspelled ext key', { js: `${base.js}export const typo = 'ext.a.typo';\n` }, 'KEY_MISSING_EXT'],
    ['a module names a key in a backtick literal', { js: `${base.js}export const q = \`ext.a.tmpl\`;\n` }, 'KEY_MISSING_EXT'],
    ['a key is missing from one language only', { extDict: without(base.ext, 'ext.a.two', ['ja']) }, 'KEY_MISSING_EXT'],
    ['a key is missing from another language (parity)', { extDict: without(base.ext, 'ext.a.two', ['ko']) }, 'KEY_PARITY'],
    ['an ext key nobody references', { extDict: withKey(base.ext, 'ext.a.orphan', 'Orphan') }, 'KEY_ORPHAN'],
    ['an ext key referenced only in a comment is still an orphan', { extDict: withKey(base.ext, 'ext.a.nothing', 'Nothing') }, 'KEY_ORPHAN'],
    ['a page uses a spelling the binder does not know', { html: `${base.html}<button data-i18n-title="ext.a.one"></button>` }, 'BINDER_SPELLING'],
    ['a page uses aria spelling', { html: `${base.html}<button data-i18n-aria-label="ext.a.one"></button>` }, 'BINDER_SPELLING'],
    ['an app key is missing from one language', { appDict: without(base.app, 'common.start', ['ja']) }, 'KEY_MISSING_APP'],
    ['a module names a missing app key', { js: `${base.js}export const s = (i18n) => i18n.t('sim.doesNotExist');\n` }, 'KEY_MISSING_APP'],
    ['a dictionary key without the ext. prefix', { extDict: withKey(base.ext, 'plain.key', 'Plain') }, 'KEY_PREFIX'],
    ['an ext key that collides with an app key', { appDict: withKey(base.app, 'ext.a.one', 'Clash'), extDict: base.ext }, 'KEY_COLLISION'],
  ];
  for (const [label, options, expected] of mutants) {
    const result = await keyCoverage(await build(options), { allowedOrphans: allowed });
    const fresh = newFindings(baseline.findings, result.findings);
    assert.ok(fresh.some((finding) => tagOf(finding) === expected), `${label}: expected ${expected}, saw ${fresh.map(tagOf).join(',') || 'nothing new'}`);
  }
  // A missing dictionary file is reported, not thrown.
  const noExt = await makeRoot(Object.fromEntries(LANGS.map((language) => [`app/i18n/${language}.json`, JSON.stringify(app[language])])));
  assert.ok(tagsOf((await keyCoverage(noExt)).findings).has('DICTIONARY_UNREADABLE'));
  // The allowance is real: without it the allowed orphan is reported (the policy is what makes the real-tree check strict, not lenient).
  assert.ok(tagsOf((await keyCoverage(await build())).findings).has('KEY_ORPHAN'), 'an unallowed orphan is reported');
});

test('errorKeyFor resolves every provider and extension error code to an existing key for both lanes in every language (§9.6)', async () => {
  const { EXTENSION_ERROR_CODES, OVERRIDDEN_ENGINE_CODES, TAB_CAPTURE_CODES, errorKeyFor } = await importFromRoot(repoRoot, 'extension/lib/ui-state.js');
  const codes = [...new Set([...ERROR_CODES, ...EXTENSION_ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES])];
  assert.ok(codes.length >= 40, `codes to resolve (${codes.length})`);
  const MICROPHONE_WORDS = /microphone|マイク|마이크/i;
  for (const language of LANGS) {
    const app = await readJson(repoRoot, `app/i18n/${language}.json`);
    const ext = await readJson(repoRoot, `extension/i18n/${language}.json`);
    const union = { ...app, ...ext };
    const has = (key) => Object.hasOwn(union, key);
    for (const lane of ['tab', 'mic']) {
      for (const code of codes) {
        const key = errorKeyFor(code, has, lane);
        assert.ok(has(key), `${language}/${lane}: ${code} -> ${key} exists`);
        assert.ok(!key.startsWith('sim.error.'), `${language}/${lane}: ${code} never resolves to a sim.error.* key`);
        if (lane === 'tab' && TAB_CAPTURE_CODES.includes(code)) assert.equal(key, 'ext.error.TAB_INPUT_LOST', `${language}: tab-lane ${code}`);
        // MICROPHONE_EXPIRED is a microphone-lane code by definition; every other code, on the tab lane, must not talk about a microphone.
        if (lane === 'tab' && code !== 'MICROPHONE_EXPIRED') assert.doesNotMatch(union[key], MICROPHONE_WORDS, `${language}/tab: ${code} -> ${key} does not mention a microphone`);
      }
    }
    assert.equal(errorKeyFor('NOT_A_CODE_' + 'X', has, 'tab'), 'error.unknown', 'an unregistered code falls back to error.unknown');
  }
});

test('every app key that the extension reuses verbatim (§9.4) exists in ko, en and ja', async () => {
  const groups = [['common', ['start', 'stop', 'cancel', 'close', 'save', 'delete', 'retry']], ['language', ['auto', 'ko', 'en', 'ja', 'target', 'ui']],
    ['sim.status', ['idle', 'preparing', 'connecting', 'running', 'stopping', 'stopped']], ['sim.output', ['delayed', 'catching_up', 'unavailable']],
    ['sim.route', ['translation', 'flash']], ['sim', ['headphonesStart', 'voice', 'voice.female', 'voice.male', 'voiceRestart', 'model0', 'model1', 'model2']],
    ['sim.captions', ['empty', 'latest', 'showSource', 'partial', 'final', 'interrupted', 'skipped']], ['sim.gap', ['audio', 'reception']],
    ['display.captions', ['size', 'value', 'range']], ['captionOnly', ['display', 'display.dark', 'display.light', 'display.mono']],
    ['settings', ['key', 'keyPlaceholder', 'keyStorageWarning', 'keyStored', 'noKey', 'keySavedBrowser', 'keyDeleted', 'deleteKey']],
    ['keyGuide', ['createLink', 'newTab']], ['permission', ['title', 'request', 'granted', 'denied', 'prompt', 'checking', 'noDevice', 'noDeviceHint', 'busy', 'busyHint']],
    ['seq', ['inputLevel']],
    ['error', ['unknown', 'INVALID_KEY', 'CREDENTIAL_MISMATCH', 'NETWORK_ERROR', 'UNAVAILABLE', 'TIMEOUT', 'SETTINGS_UNSUPPORTED', 'SAFETY_BLOCKED', 'INVALID_RESULT']]];
  const reused = groups.flatMap(([prefix, names]) => names.map((name) => `${prefix}.${name}`));
  assert.equal(reused.length, 78, 'the list of §9.4 expands to 78 keys');
  // §9.6: sim.model<i> for every model of LIVE_MODELS, and the two small ext.* families the code names one by one.
  const { LIVE_MODELS } = await import('../app/providers/gemini/live-config.js');
  assert.ok(LIVE_MODELS.length >= 1);
  const models = LIVE_MODELS.map((_, index) => `sim.model${index}`);
  const family = ['ext.lane.tab.title', 'ext.lane.mic.title', 'ext.options.position.top', 'ext.options.position.bottom'];
  for (const language of LANGS) {
    const app = await readJson(repoRoot, `app/i18n/${language}.json`);
    const ext = await readJson(repoRoot, `extension/i18n/${language}.json`);
    assert.deepEqual([...reused, ...models].filter((key) => !Object.hasOwn(app, key)), [], `${language}: reused app keys missing`);
    assert.deepEqual(family.filter((key) => !Object.hasOwn(ext, key)), [], `${language}: ext.* families of 9.6 missing`);
  }
});

test('the D12 free-tier footnote says it is an estimate, not a measurement, in every language', async () => {
  const markers = { ko: '측정', en: 'estimate', ja: '実測' };
  for (const language of LANGS) {
    const dictionary = await readJson(repoRoot, `extension/i18n/${language}.json`);
    assert.ok(typeof dictionary['ext.usage.twoSessions'] === 'string' && dictionary['ext.usage.twoSessions'].includes(markers[language]), `${language} ext.usage.twoSessions carries "${markers[language]}"`);
  }
});

// ---------------------------------------------------------------------------------------------------
// (6) the ext.* to _locales mirror of §9.3 and the getMessage literals
// ---------------------------------------------------------------------------------------------------

async function localeFindings(root, { mirror = MIRROR, expectedLiterals = [] } = {}) {
  const findings = [];
  const messages = {};
  const ext = {};
  for (const language of LANGS) {
    try {
      messages[language] = await readJson(root, `extension/_locales/${language}/messages.json`);
      ext[language] = await readJson(root, `extension/i18n/${language}.json`);
    } catch { return [`LOCALE_UNREADABLE:${language}`]; }
  }
  const names = sorted(mirror.map(([name]) => name));
  for (const language of LANGS) {
    if (JSON.stringify(sorted(Object.keys(messages[language]))) !== JSON.stringify(names)) findings.push(`LOCALE_NAMES:${language}`);
    for (const [name, key] of mirror) {
      const message = messages[language][name]?.message;
      if (typeof message !== 'string') findings.push(`LOCALE_MESSAGE_MISSING:${language}:${name}`);
      else if (message !== ext[language][key]) findings.push(`MIRROR_MISMATCH:${language}:${name} <- ${key}`);
    }
  }
  // every getMessage('literal') anywhere in extension/**/*.js exists in all three files
  const literals = new Map();
  for (const { path, code } of await extensionCode(root)) {
    for (const match of code.matchAll(/\bgetMessage\(\s*(['"])([^'"\r\n]+)\1/g)) literals.set(match[2], [...(literals.get(match[2]) ?? []), path]);
  }
  for (const [name, files] of literals) for (const language of LANGS) if (!Object.hasOwn(messages[language], name)) findings.push(`GETMESSAGE_UNKNOWN:${language}:${name} (${files[0]})`);
  for (const name of expectedLiterals) if (!literals.has(name)) findings.push(`GETMESSAGE_EXPECTED:${name}`);
  // every message has a consumer: a __MSG_ reference in the manifest or a getMessage literal
  const manifestText = await readText(root, 'extension/manifest.json').catch(() => '');
  const referenced = new Set([...manifestText.matchAll(/__MSG_([A-Za-z]\w*)__/g)].map((match) => match[1]));
  for (const name of names) if (!literals.has(name) && !referenced.has(name)) findings.push(`LOCALE_UNUSED:${name}`);
  return findings;
}

// §8.5.1 and §9.3: the seven names the overlay reads and the one the service worker reads.
const GETMESSAGE_LITERALS = Object.freeze(['menuOpen', 'overlayRegion', 'overlayHide', 'overlayLaneTab', 'overlayLaneMic', 'overlayGap', 'overlayReconnecting', 'overlayStopped']);

test('every _locales message equals its mirrored ext.* value in every language, and every getMessage literal exists in all three files', async () => {
  assert.equal(MIRROR.length, 12, 'the mirror table of §9.3 has twelve rows');
  assert.deepEqual(await localeFindings(repoRoot, { expectedLiterals: GETMESSAGE_LITERALS }), []);
  // Where the literals come from: the overlay names seven, the service worker one, and nothing else asks Chrome for text.
  const literals = new Map();
  for (const { path, code } of await extensionCode(repoRoot)) for (const match of code.matchAll(/\bgetMessage\(\s*(['"])([^'"\r\n]+)\1/g)) literals.set(match[2], path);
  assert.equal(literals.get('menuOpen'), 'extension/background/sw-core.js');
  assert.deepEqual(sorted([...literals.keys()]), sorted(GETMESSAGE_LITERALS), 'the getMessage literals of the real tree are exactly the eight expected names');
  for (const name of GETMESSAGE_LITERALS.filter((literal) => literal !== 'menuOpen')) assert.equal(literals.get(name), 'extension/overlay/overlay.js', name);
});

test('the _locales mirror check is not vacuous: each mutant root reports the tag of its mutation', async () => {
  const mirror = [['extName', 'ext.name'], ['menuOpen', 'ext.menu.open']];
  const messages = (values) => JSON.stringify({ extName: { message: values.extName, description: 'd' }, menuOpen: { message: values.menuOpen, description: 'd' } });
  const good = { en: { extName: 'Name', menuOpen: 'Open' }, ko: { extName: '이름', menuOpen: '열기' }, ja: { extName: '名前', menuOpen: '開く' } };
  const dictionaries = Object.fromEntries(LANGS.map((language) => [language, { 'ext.name': good[language].extName, 'ext.menu.open': good[language].menuOpen }]));
  const build = ({ locale = good, ext = dictionaries, js = "export const t = (i) => i.getMessage('menuOpen');\n", manifest = '{ "name": "__MSG_extName__" }' } = {}) => makeRoot({
    ...Object.fromEntries(LANGS.map((language) => [`extension/_locales/${language}/messages.json`, locale[language] === null ? null : messages(locale[language])]).filter(([, text]) => text !== null)),
    ...Object.fromEntries(LANGS.map((language) => [`extension/i18n/${language}.json`, JSON.stringify(ext[language])])),
    'extension/background/sw.js': js, 'extension/manifest.json': manifest,
  });
  const options = { mirror, expectedLiterals: ['menuOpen'] };
  const baseline = await localeFindings(await build(), options);
  assert.deepEqual(baseline, [], 'the unmutated string root is clean');
  const mutants = [
    ['a message differs from its mirrored ext value in one language', { locale: { ...good, ko: { ...good.ko, extName: '다른 이름' } } }, 'MIRROR_MISMATCH'],
    ['a message is missing from one language', { locale: { ...good, ja: { ...good.ja, menuOpen: undefined } } }, 'LOCALE_MESSAGE_MISSING'],
    ['a _locales file is absent', { locale: { ...good, ja: null } }, 'LOCALE_UNREADABLE'],
    ['a getMessage literal that no file defines', { js: "export const t = (i) => i.getMessage('menuOpen') + i.getMessage('ghost');\n" }, 'GETMESSAGE_UNKNOWN'],
    ['an expected getMessage literal is not used', { js: 'export const t = 1;\n' }, 'GETMESSAGE_EXPECTED'],
    ['a getMessage literal only in a comment does not count', { js: "// i.getMessage('menuOpen')\nexport const t = 1;\n" }, 'GETMESSAGE_EXPECTED'],
    ['a message nobody consumes', { js: 'export const t = 1;\n', manifest: '{}' }, 'LOCALE_UNUSED'],
    ['the mirrored ext key is absent (mirror compares undefined)', { ext: Object.fromEntries(LANGS.map((language) => [language, { 'ext.name': good[language].extName }])) }, 'MIRROR_MISMATCH'],
  ];
  for (const [label, override, expected] of mutants) {
    const fresh = newFindings(baseline, await localeFindings(await build(override), options));
    assert.ok(fresh.some((finding) => tagOf(finding) === expected), `${label}: expected ${expected}, saw ${fresh.map(tagOf).join(',') || 'nothing new'}`);
  }
  // an extra name in one _locales file is a name-set finding
  const extra = await makeRoot({
    ...Object.fromEntries(LANGS.map((language) => [`extension/_locales/${language}/messages.json`, JSON.stringify({
      extName: { message: good[language].extName, description: 'd' }, menuOpen: { message: good[language].menuOpen, description: 'd' },
      ...(language === 'en' ? { stray: { message: 's', description: 'd' } } : {}) })])),
    ...Object.fromEntries(LANGS.map((language) => [`extension/i18n/${language}.json`, JSON.stringify(dictionaries[language])])),
    'extension/background/sw.js': "export const t = (i) => i.getMessage('menuOpen');\n", 'extension/manifest.json': '{ "name": "__MSG_extName__" }',
  });
  assert.ok(tagsOf(await localeFindings(extra, options)).has('LOCALE_NAMES'));
});

// ---------------------------------------------------------------------------------------------------
// the links.js parity with app/config.js (§11.1, I6): the two documentation URLs the options page links to
// ---------------------------------------------------------------------------------------------------

function linkFindings({ links, config }) {
  const findings = [];
  const guide = /\bexport const KEY_GUIDE_URL\s*=\s*(['"])([^'"]+)\1/.exec(links)?.[2];
  const usage = /\bexport const KEY_USAGE_URL\s*=\s*(['"])([^'"]+)\1/.exec(links)?.[2];
  const create = /\bapiKeyCreate\s*:\s*(['"])([^'"]+)\1/.exec(config)?.[2];
  const apiUsage = /\bapiKeyUsage\s*:\s*(['"])([^'"]+)\1/.exec(config)?.[2];
  if (!guide || guide !== create) findings.push('LINKS_GUIDE');
  if (!usage || usage !== apiUsage) findings.push('LINKS_USAGE');
  return findings;
}

test('extension/lib/links.js carries the same two documentation URLs as app/config.js DOCUMENTATION_LINKS', async () => {
  const links = stripComments(await readText(repoRoot, 'extension/lib/links.js'));
  const config = stripComments(await readText(repoRoot, 'app/config.js'));
  assert.deepEqual(linkFindings({ links, config }), []);
  // The text extraction is checked against the imported values, so a reformatted file cannot silently empty the check.
  const { KEY_GUIDE_URL, KEY_USAGE_URL } = await importFromRoot(repoRoot, 'extension/lib/links.js');
  const { DOCUMENTATION_LINKS } = await importFromRoot(repoRoot, 'app/config.js');
  assert.equal(KEY_GUIDE_URL, DOCUMENTATION_LINKS.apiKeyCreate);
  assert.equal(KEY_USAGE_URL, DOCUMENTATION_LINKS.apiKeyUsage);
  assert.ok(links.includes(KEY_GUIDE_URL) && links.includes(KEY_USAGE_URL));
  // not vacuous
  assert.deepEqual(linkFindings({ links: mutate(links, KEY_GUIDE_URL, `${KEY_GUIDE_URL}x`), config }), ['LINKS_GUIDE']);
  assert.deepEqual(linkFindings({ links: mutate(links, KEY_USAGE_URL, `${KEY_USAGE_URL}x`), config }), ['LINKS_USAGE']);
  assert.deepEqual(linkFindings({ links: '', config }), ['LINKS_GUIDE', 'LINKS_USAGE']);
});

// ---------------------------------------------------------------------------------------------------
// the real tree is complete: the pieces the other checks rely on exist (a missing group shows up here first)
// ---------------------------------------------------------------------------------------------------

test('the real tree has the files of §3.1 that this file reads, so a missing group is named instead of failing obscurely', async () => {
  const wanted = ['extension/manifest.json', 'extension/_locales/en/messages.json', 'extension/_locales/ko/messages.json', 'extension/_locales/ja/messages.json',
    'extension/i18n/en.json', 'extension/i18n/ko.json', 'extension/i18n/ja.json', 'extension/lib/builtin-key.js', 'extension/lib/links.js', 'extension/lib/constants.js',
    'extension/lib/protocol.js', 'extension/lib/settings.js', 'extension/lib/ui-state.js', 'extension/lib/caption-frames.js', 'extension/lib/chrome-adapter.js',
    'extension/lib/i18n.js', 'extension/lib/dom-i18n.js', 'extension/background/service-worker.js', 'extension/background/sw-core.js', 'extension/background/arming.js',
    'extension/engine/host.html', 'extension/engine/host.js', 'extension/engine/lane-host.js', 'extension/engine/lane-engine.js', 'extension/engine/tab-lane.js',
    'extension/engine/mic-lane.js', 'extension/engine/audio-graph.js', 'extension/engine/platform-shim.js', 'extension/engine/overlay-hub.js', 'extension/engine/panel-hub.js',
    'extension/engine/worker-timers.js', 'extension/engine/timer-worker.js', 'extension/panel/panel.html', 'extension/panel/panel.css', 'extension/panel/panel.js',
    'extension/panel/controller.js', 'extension/panel/view-model.js', 'extension/panel/host-link.js', 'extension/options/options.html', 'extension/options/options.js',
    'extension/options/controller.js', 'extension/permission/mic-permission.html', 'extension/permission/mic-permission.js', 'extension/permission/controller.js',
    'extension/pages.css', 'extension/overlay/overlay.js'];
  const missing = [];
  for (const path of wanted) if (!isFileSync(join(repoRoot, path))) missing.push(path);
  assert.deepEqual(missing, []);
  assert.equal((await lstat(join(repoRoot, 'extension'))).isDirectory(), true);
});
