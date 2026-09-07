import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_ORIGINS } from '../app/config.js';
import { REGISTERED_HUBS, HUB_ENDPOINTS, HUB_ORIGINS, hubEndpoints, hubOrigins } from '../app/hub/config.js';
import { REGISTERED_HUBS as PROTOCOL_HUBS, createHubProtocol } from '../app/hub/protocol.js';
import { boot, visible } from './fixtures/scenarios.mjs';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import {
  ICON_FILES, MANIFEST_FILES, ROOT_FILES, UNCACHED_ROOT_FILES, applyRelease, collectVersionedFiles,
  pointRelease, readRelease,
  rewriteEntry, shellFor, stageRelease,
} from '../scripts/stage-release.mjs';
import { checkCsp, checkRelease, classifyPath, entryReferences, parseHeaders } from '../scripts/check-release.mjs';

// P1-18 release packaging: only the allowlist is copied into a versioned
// directory, the entry files point at exactly one release, the worker shell
// is complete, secrets and unexpected files are rejected and the CSP matches
// the registered endpoints. Fixture secrets are assembled at runtime so no
// key-shaped literal is committed.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const fakeKey = () => `AIza${'TEST_SECRET_ONLY_'.padEnd(35, 'x')}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ORIGINS = ['https://generativelanguage.googleapis.com', 'wss://generativelanguage.googleapis.com'];

async function listTree(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  await walk(root);
  return files.sort();
}

async function write(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'interp-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const FIXTURE_APP = {
  'app/main.js': "import './ui/shell.js';\nimport './config.js';\n",
  'app/config.js': `export const ENDPOINT_ORIGINS = Object.freeze(${JSON.stringify(ORIGINS)});\n`,
  'app/ui/shell.js': 'export function mount() {}\n',
  // P3-13: the synchronous appearance boot the entry loads before the stylesheet.
  'app/ui/appearance-boot.js': '(function () { "use strict"; })();\n',
  'app/i18n/index.js': 'export const SUPPORTED_LANGUAGES = ["ko", "en", "ja"];\n',
  'app/i18n/ko.json': '{"app.name":"통역"}\n',
  'app/i18n/en.json': '{"app.name":"Interpreter"}\n',
  'app/i18n/ja.json': '{"app.name":"通訳"}\n',
};

// A minimal project tree with the real entry, worker and headers templates
// plus files that must never reach a release.
async function fixtureSource(directory) {
  const root = join(directory, 'src');
  for (const file of ['index.html', 'sw.js', '_headers', 'styles.css', 'policy.json', 'admin/index.html',
    ...ICON_FILES]) {
    await write(root, file, await readFile(join(repoRoot, file)));
  }
  for (const language of SUPPORTED_LANGUAGES) {
    await write(root, `manifest.${language}.webmanifest`, JSON.stringify({ id: '/', scope: './', start_url: './', lang: language }));
  }
  for (const [path, content] of Object.entries(FIXTURE_APP)) await write(root, path, content);
  const excluded = {
    '.env': `GEMINI_API_KEY=${fakeKey()}\n`,
    '.gitignore': 'release/\n',
    'package.json': '{"name":"fixture"}',
    'README.md': '# fixture',
    'docs/design.md': '# design',
    'docs/build/P1-18.last.md': 'report',
    'tests/x.test.mjs': 'export {};',
    'tests/fixtures/gemini.mjs': `export const key = '${fakeKey()}';`,
    'scripts/serve.mjs': 'export {};',
    'tools/run.sh': '#!/bin/sh',
    '.git/config': '[core]',
    '.moai/config.json': '{}',
    'node_modules/pkg/index.js': 'module.exports = {};',
    'release/index.html': '<!doctype html>',
    'app/notes.md': 'notes',
    'app/.hidden.js': 'export {};',
    'app/i18n/extra.txt': 'not a dictionary',
    'app/ui/shell.test.mjs': 'export {};',
    'app/data/sample.json': '{"json":"outside i18n"}',
    'app/audio/sample.wav': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  };
  for (const [path, content] of Object.entries(excluded)) await write(root, path, content);
  await symlink(join(root, '.env'), join(root, 'app', 'linked.js'));
  await symlink(join(root, 'docs'), join(root, 'app', 'linked-docs'));
  return root;
}

const versionedOf = (files, id) => files.filter((file) => file.startsWith(`releases/${id}/`) && !file.endsWith('release.json'))
  .map((file) => file.slice(`releases/${id}/`.length));

test('stages only the allowlist into a versioned directory and rewrites the entry files', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  const staged = await stageRelease({ id: 'r1', out, root, now: () => new Date('2026-09-05T00:00:00Z') });
  const files = await listTree(out);
  const versioned = ['styles.css', ...Object.keys(FIXTURE_APP)].sort();
  const expected = [...ROOT_FILES, ...versioned.map((file) => `releases/r1/${file}`), 'releases/r1/release.json'].sort();
  assert.deepEqual(files, expected);
  assert.deepEqual([...staged.files].sort(), expected);
  assert.equal(staged.id, 'r1');
  for (const file of files) assert.ok(classifyPath(file), `${file} is allowlisted`);
  for (const forbidden of ['docs/', 'tests/', 'scripts/', 'tools/', '.git', '.moai', 'node_modules', '.env', 'package.json', 'README', 'notes.md', 'hidden', 'linked', '.wav', 'sample.json', 'extra.txt', '.test.mjs', 'release/index']) {
    assert.ok(!files.some((file) => file.includes(forbidden)), forbidden);
  }

  const entry = await readFile(join(out, 'index.html'), 'utf8');
  assert.match(entry, /<link rel="stylesheet" href="\.\/releases\/r1\/styles\.css">/);
  assert.match(entry, /<script type="module" src="\.\/releases\/r1\/app\/main\.js"><\/script>/);
  // P3-13: the boot keeps its place before the stylesheet and moves to the versioned path.
  assert.match(entry, /<script src="\.\/releases\/r1\/app\/ui\/appearance-boot\.js"><\/script>\s*<link rel="stylesheet"/);
  assert.deepEqual(entryReferences(entry).boot, './releases/r1/app/ui/appearance-boot.js');
  assert.deepEqual(entryReferences(entry).modules, ['./releases/r1/app/main.js']);
  assert.match(entry, /href="\.\/manifest\.ko\.webmanifest"/);
  assert.match(entry, /href="\.\/icons\/icon-192\.png"/);
  assert.doesNotMatch(entry, /(?:href|src)="\.\/(?:app\/|styles\.css)/);

  const worker = await readFile(join(out, 'sw.js'), 'utf8');
  const release = readRelease(worker);
  assert.equal(release.id, 'r1');
  assert.deepEqual([...release.shell].sort(), shellFor('r1', versioned).sort());
  assert.ok(release.shell.includes('./') && release.shell.includes('./releases/r1/app/main.js'));
  assert.ok(release.shell.every((path) => path.startsWith('./') && !path.includes('..')));
  assert.equal(worker.replace(/^const RELEASE = .*$/m, ''), (await readFile(join(repoRoot, 'sw.js'), 'utf8')).replace(/^const RELEASE = .*$/m, ''), 'only the RELEASE line differs');

  const manifest = JSON.parse(await readFile(join(out, 'releases/r1/release.json'), 'utf8'));
  assert.equal(manifest.id, 'r1');
  assert.equal(manifest.createdAt, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(Object.keys(manifest.files).sort(), versioned);
  for (const file of versioned) {
    assert.equal(manifest.files[file], sha256(await readFile(join(out, 'releases/r1', file))), file);
    assert.ok((await readFile(join(out, 'releases/r1', file))).equals(await readFile(join(root, file))), `${file} copied verbatim`);
  }
  for (const file of ['_headers', ...MANIFEST_FILES, ...ICON_FILES]) {
    assert.ok((await readFile(join(out, file))).equals(await readFile(join(root, file))), `${file} copied verbatim`);
  }
  const result = await checkRelease({ dir: out });
  assert.deepEqual(result, { ok: true, issues: [], notices: [], releases: ['r1'], current: 'r1', files: files.length });
});

test('never overwrites a release and rejects bad ids and output locations', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  await stageRelease({ id: 'r1', out, root });
  const before = await listTree(out);
  await assert.rejects(stageRelease({ id: 'r1', out, root }), { message: 'RELEASE_EXISTS' });
  assert.deepEqual(await listTree(out), before);
  for (const id of ['', ' ', 'a b', '../x', '-x', '.x', 'x/y', 'x'.repeat(41), 'TEST SECRET', 42, undefined]) {
    await assert.rejects(stageRelease({ id, out, root }), { message: 'RELEASE_ID_INVALID' });
  }
  await assert.rejects(stageRelease({ id: 'r2', out: root, root }), { message: 'RELEASE_OUT_INVALID' });
  await assert.rejects(stageRelease({ id: 'r2', out: directory, root }), { message: 'RELEASE_OUT_INVALID' });
  await assert.rejects(stageRelease({ id: 'r2', out: '', root }), { message: 'RELEASE_OUT_INVALID' });
  const nested = await stageRelease({ id: 'r2', out: join(root, 'release'), root });
  assert.equal(nested.id, 'r2');
  assert.ok(!(await listTree(join(root, 'release'))).some((file) => file.includes('release/index.html')), 'a release dir inside the project is not re-copied');
  await rm(join(root, 'styles.css'));
  await assert.rejects(stageRelease({ id: 'r3', out, root }), { message: 'RELEASE_SOURCE_MISSING' });
});

test('helpers rewrite entries, guard the worker marker and parse headers', async () => {
  const html = '<link href="./styles.css"><link href=\'./manifest.ko.webmanifest\'><script type="module" src="./app/main.js?x=1"></script><img src="./icons/icon-192.png"><a href="./app/i18n/ko.json#f">';
  assert.equal(rewriteEntry(html, 'v9'), '<link href="./releases/v9/styles.css"><link href=\'./manifest.ko.webmanifest\'><script type="module" src="./releases/v9/app/main.js?x=1"></script><img src="./icons/icon-192.png"><a href="./releases/v9/app/i18n/ko.json#f">');
  assert.throws(() => rewriteEntry(html, 'bad id'), { message: 'RELEASE_ID_INVALID' });
  const source = await readFile(join(repoRoot, 'sw.js'), 'utf8');
  assert.throws(() => applyRelease(source.replace('// @release', ''), { id: 'v1', shell: [] }), { message: 'RELEASE_SW_MARKER_MISSING' });
  assert.throws(() => applyRelease(`${source}\n${source.match(/^const RELEASE = .*$/m)[0]}`, { id: 'v1', shell: [] }), { message: 'RELEASE_SW_MARKER_MISSING' });
  assert.throws(() => applyRelease(source, { id: 'v1', shell: 'x' }), { message: 'RELEASE_ID_INVALID' });
  assert.deepEqual(readRelease(applyRelease(source, { id: 'v1', shell: ['./'] })), { id: 'v1', shell: ['./'] });
  assert.equal(readRelease('nothing here'), null);
  assert.deepEqual(classifyPath('index.html'), { kind: 'root' });
  assert.deepEqual(classifyPath('releases/v1/app/ui/shell.js'), { kind: 'versioned', id: 'v1', file: 'app/ui/shell.js' });
  assert.deepEqual(classifyPath('releases/v1/release.json'), { kind: 'manifest', id: 'v1' });
  for (const path of ['sw.js.map', 'releases/v1/app/x.md', 'releases/v1/index.html', 'releases/bad id/app/main.js', 'releases/v1/app/data/x.json', 'app/main.js', 'docs/x.md', 'releases/v1/sw.js']) {
    assert.equal(classifyPath(path), null, path);
  }
  const rules = parseHeaders(await readFile(join(repoRoot, '_headers'), 'utf8'));
  // P3-35 added the policy (never cached) and the administrator entry.
  assert.deepEqual(rules.map((rule) => rule.path),
    ['/*', '/', '/index.html', '/sw.js', '/policy.json', '/admin/', '/admin/index.html', '/releases/*']);
  const policyRule = rules.find((rule) => rule.path === '/policy.json');
  assert.match(policyRule.headers.get('cache-control'), /no-store/, 'the policy is read fresh on every start');
  for (const path of ['/admin/', '/admin/index.html']) {
    assert.match(rules.find((rule) => rule.path === path).headers.get('cache-control'), /no-cache/, path);
  }
  assert.equal(parseHeaders('  Orphan: value'), null);
  // P3-13 contract: exactly one synchronous classic boot script before the
  // stylesheet, then exactly one module script. Everything else is rejected.
  const BOOT = '<script src="./b.js"></script>';
  const MODULE = '<script type="module" src="./a.js"></script>';
  const STYLE = '<link rel="stylesheet" href="./s.css">';
  assert.deepEqual(entryReferences(`<!-- <script>x</script> -->${BOOT}${STYLE}${MODULE}`),
    { references: ['./b.js', './s.css', './a.js'], modules: ['./a.js'], boot: './b.js' });
  assert.deepEqual(entryReferences(`${BOOT}<link href="./s.css">${MODULE}`), { references: ['./b.js', './s.css', './a.js'], modules: ['./a.js'], boot: './b.js' });
  assert.deepEqual(entryReferences(`<script  src='./b.js'></script>${STYLE}<script type='module'  src='./a.js'></script>`),
    { references: ['./b.js', './s.css', './a.js'], modules: ['./a.js'], boot: './b.js' });
  const rejected = [
    `<script>alert(1)</script>${BOOT}${STYLE}${MODULE}`,
    `<div onclick="x()"></div>${BOOT}${STYLE}${MODULE}`,
    `<base href="/">${BOOT}${STYLE}${MODULE}`,
    `<div style="color:red"></div>${BOOT}${STYLE}${MODULE}`,
    `<style>body{}</style>${BOOT}${STYLE}${MODULE}`,
    MODULE,                                                       // module only (pre-P3-13 shape)
    BOOT,                                                         // boot only
    `${BOOT}${STYLE}`,                                            // no module
    `${STYLE}${BOOT}${MODULE}`,                                   // boot after the stylesheet
    `${MODULE}${STYLE}${BOOT}`,                                   // module before the boot
    `${BOOT}${STYLE}${MODULE}${MODULE}`,                          // extra module
    `${BOOT}${BOOT}${STYLE}${MODULE}`,                            // extra classic script
    `${BOOT}${STYLE}${MODULE}<script src="./c.js"></script>`,     // trailing classic script
    `<script async src="./b.js"></script>${STYLE}${MODULE}`,      // async boot
    `<script defer src="./b.js"></script>${STYLE}${MODULE}`,      // deferred boot
    `<script src="./b.js" defer></script>${STYLE}${MODULE}`,      // deferred boot, attribute last
    `<script type="text/javascript" src="./b.js"></script>${STYLE}${MODULE}`, // typed boot
    `<script type="module" src="./b.js"></script>${STYLE}${MODULE}`, // two modules
    `<script nomodule src="./b.js"></script>${STYLE}${MODULE}`,   // nomodule boot
    `<script></script>${STYLE}${MODULE}`,                         // boot without src
    `<script src="./b.js">x = 1</script>${STYLE}${MODULE}`,       // boot with inline body
    `${BOOT}${STYLE}<script type="module"></script>`,             // module without src
    `${BOOT}${STYLE}<script src="./a.js"></script>`,              // second script not a module
  ];
  for (const html of rejected) assert.equal(entryReferences(html), null, html);
});

test('checkCsp requires the exact directive set and only registered endpoint origins', () => {
  const good = "default-src 'self'; script-src 'self'; connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com; img-src 'self' data:; media-src 'self' blob:; worker-src 'self'; object-src 'none'; frame-ancestors 'none'";
  assert.deepEqual(checkCsp(good, ORIGINS), []);
  const bad = [
    good.replace(' wss://generativelanguage.googleapis.com', ''),
    good.replace("connect-src 'self'", "connect-src 'self' https://example.com"),
    good.replace("connect-src 'self' ", 'connect-src '),
    good.replace("default-src 'self'", "default-src 'self' https://cdn.example.com"),
    good.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    good.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    good.replace("script-src 'self'", "script-src 'self' https://generativelanguage.googleapis.com"),
    good.replace("img-src 'self' data:", "img-src 'self' data: https:"),
    good.replace("media-src 'self' blob:", "media-src 'self'"),
    good.replace("; worker-src 'self'", ''),
    good.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
    good.replace("; frame-ancestors 'none'", ''),
    good.replace("default-src 'self'", "default-src *"),
  ];
  for (const csp of bad) assert.deepEqual(checkCsp(csp, ORIGINS), ['RELEASE_CSP_MISMATCH'], csp);
  assert.deepEqual(checkCsp(good, ['https://generativelanguage.googleapis.com']), ['RELEASE_CSP_MISMATCH']);
});

// Each case copies the good tree, applies one change and expects the codes.
test('checkRelease rejects unexpected files, secrets, header drift, incomplete releases and version mixing', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const good = join(directory, 'good');
  await stageRelease({ id: 'r1', out: good, root });
  const headers = await readFile(join(good, '_headers'), 'utf8');
  const worker = await readFile(join(good, 'sw.js'), 'utf8');
  const entry = await readFile(join(good, 'index.html'), 'utf8');
  const release = readRelease(worker);
  const BOOT_TAG = '<script src="./releases/r1/app/ui/appearance-boot.js"></script>';
  assert.ok(entry.includes(BOOT_TAG));
  const cases = [
    ['docs copied', async (out) => write(out, 'docs/design.md', '# x'), [['RELEASE_UNEXPECTED_FILE', 'docs/design.md']]],
    ['tests copied', async (out) => write(out, 'tests/x.test.mjs', ''), [['RELEASE_UNEXPECTED_FILE', 'tests/x.test.mjs']]],
    ['dotfile', async (out) => write(out, '.DS_Store', ''), [['RELEASE_UNEXPECTED_FILE', '.DS_Store']]],
    ['git metadata', async (out) => write(out, '.git/HEAD', 'ref'), [['RELEASE_UNEXPECTED_FILE', '.git/HEAD']]],
    ['source map inside release', async (out) => write(out, 'releases/r1/app/main.js.map', '{}'), [['RELEASE_UNEXPECTED_FILE', 'releases/r1/app/main.js.map']]],
    ['stray html inside release', async (out) => write(out, 'releases/r1/index.html', ''), [['RELEASE_UNEXPECTED_FILE', 'releases/r1/index.html']]],
    ['json outside i18n', async (out) => write(out, 'releases/r1/app/data.json', '{}'), [['RELEASE_UNEXPECTED_FILE', 'releases/r1/app/data.json']]],
    ['bad release id directory', async (out) => write(out, 'releases/bad id/app/main.js', ''), [['RELEASE_UNEXPECTED_FILE', 'releases/bad id/app/main.js']]],
    ['symlink', async (out) => symlink(join(out, 'index.html'), join(out, 'link.html')), [['RELEASE_SYMLINK', 'link.html']]],
    ['google key in module', async (out) => write(out, 'releases/r1/app/ui/shell.js', `export const k = '${fakeKey()}';`),
      [['RELEASE_SECRET_PATTERN', 'releases/r1/app/ui/shell.js'], ['RELEASE_HASH_MISMATCH', 'releases/r1/app/ui/shell.js']]],
    ['key in headers comment', async (out) => write(out, '_headers', `# ${fakeKey()}\n${headers}`), [['RELEASE_SECRET_PATTERN', '_headers']]],
    ['shared-key payload in entry', async (out) => write(out, 'index.html', entry.replace('<title></title>', `<title></title><!-- #shared=${encodeURIComponent('{"k":1}')} -->`)),
      [['RELEASE_SECRET_PATTERN', 'index.html']]],
    ['private key in stylesheet', async (out) => write(out, 'releases/r1/styles.css', '/* -----BEGIN RSA PRIVATE KEY----- */'),
      [['RELEASE_SECRET_PATTERN', 'releases/r1/styles.css'], ['RELEASE_HASH_MISMATCH', 'releases/r1/styles.css']]],
    ['generic api key assignment', async (out) => write(out, 'releases/r1/app/main.js', `const apiKey = "${'TEST_SECRET_ONLY_'.padEnd(24, 'y')}";`),
      [['RELEASE_SECRET_PATTERN', 'releases/r1/app/main.js'], ['RELEASE_HASH_MISMATCH', 'releases/r1/app/main.js']]],
    ['csp missing wss origin', async (out) => write(out, '_headers', headers.replace(' wss://generativelanguage.googleapis.com', '')), [['RELEASE_CSP_MISMATCH', '_headers']]],
    ['csp extra origin', async (out) => write(out, '_headers', headers.replace("connect-src 'self'", "connect-src 'self' https://example.com")), [['RELEASE_CSP_MISMATCH', '_headers']]],
    ['csp unsafe-inline', async (out) => write(out, '_headers', headers.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")), [['RELEASE_CSP_MISMATCH', '_headers']]],
    ['csp missing', async (out) => write(out, '_headers', headers.replace(/^\s+Content-Security-Policy:.*\n/m, '')), [['RELEASE_HEADERS_INVALID', '_headers']]],
    ['permissions policy without microphone', async (out) => write(out, '_headers', headers.replace('microphone=(self)', 'microphone=()')), [['RELEASE_HEADERS_INVALID', '_headers']]],
    ['worker cached', async (out) => write(out, '_headers', headers.replace('/sw.js\n  Cache-Control: no-cache', '/sw.js\n  Cache-Control: public, max-age=86400')), [['RELEASE_HEADERS_INVALID', '_headers']]],
    ['no global rule', async (out) => write(out, '_headers', headers.replace('/*', '/index.html')), [['RELEASE_HEADERS_INVALID', '_headers']]],
    ['missing manifest', async (out) => rm(join(out, 'manifest.en.webmanifest')), [['RELEASE_MISSING_FILE', 'manifest.en.webmanifest']]],
    ['missing headers', async (out) => rm(join(out, '_headers')), [['RELEASE_MISSING_FILE', '_headers']]],
    ['missing icon', async (out) => rm(join(out, 'icons/icon-512.png')), [['RELEASE_MISSING_FILE', 'icons/icon-512.png']]],
    ['worker points elsewhere', async (out) => write(out, 'sw.js', applyRelease(worker, { id: 'r0', shell: release.shell })), [['RELEASE_SW_INVALID', 'sw.js']]],
    ['worker shell incomplete', async (out) => write(out, 'sw.js', applyRelease(worker, { id: 'r1', shell: release.shell.filter((path) => !path.endsWith('main.js')) })), [['RELEASE_SW_INVALID', 'sw.js']]],
    ['worker shell caches an API', async (out) => write(out, 'sw.js', applyRelease(worker, { id: 'r1', shell: [...release.shell, 'https://generativelanguage.googleapis.com/v1beta/models'] })), [['RELEASE_SW_INVALID', 'sw.js']]],
    ['worker without marker', async (out) => write(out, 'sw.js', worker.replace('// @release', '')), [['RELEASE_SW_INVALID', 'sw.js']]],
    ['dev worker shipped', async (out) => write(out, 'sw.js', await readFile(join(repoRoot, 'sw.js'))), [['RELEASE_SW_INVALID', 'sw.js']]],
    ['entry inline script', async (out) => write(out, 'index.html', entry.replace('</body>', '<script>window.x = 1</script></body>')), [['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    // P3-13: the boot script is the only classic script, at a fixed path, before the stylesheet.
    ['entry without boot script', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, '')), [['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['entry boot after stylesheet', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, '').replace('</head>', `${BOOT_TAG}</head>`)), [['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['entry boot deferred', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, BOOT_TAG.replace('<script ', '<script defer '))), [['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['entry boot as module', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, BOOT_TAG.replace('<script ', '<script type="module" '))), [['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['entry extra classic script', async (out) => write(out, 'index.html', entry.replace('</body>', '<script src="./releases/r1/app/ui/shell.js"></script></body>')), [['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['entry boot at another versioned path', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, '<script src="./releases/r1/app/ui/shell.js"></script>')), [['RELEASE_ENTRY_INVALID', 'index.html']]],
    ['entry boot from the root', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, '<script src="./app/ui/appearance-boot.js"></script>')), [['RELEASE_ENTRY_INVALID', 'index.html']]],
    ['entry boot from another release', async (out) => write(out, 'index.html', entry.replace(BOOT_TAG, BOOT_TAG.replace('releases/r1/', 'releases/r0/'))), [['RELEASE_MISSING_FILE', 'releases/r0/app/ui/appearance-boot.js'], ['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['boot file removed from release', async (out) => rm(join(out, 'releases/r1/app/ui/appearance-boot.js')), [['RELEASE_MISSING_FILE', 'releases/r1/app/ui/appearance-boot.js'], ['RELEASE_MANIFEST_INVALID', 'releases/r1/release.json'], ['RELEASE_SW_INVALID', 'sw.js']]],
    ['boot file altered', async (out) => write(out, 'releases/r1/app/ui/appearance-boot.js', 'window.x = 1;'), [['RELEASE_HASH_MISMATCH', 'releases/r1/app/ui/appearance-boot.js']]],
    ['entry external stylesheet', async (out) => write(out, 'index.html', entry.replace('./releases/r1/styles.css', 'https://cdn.example.com/styles.css')), [['RELEASE_ENTRY_INVALID', 'index.html']]],
    ['entry absolute path', async (out) => write(out, 'index.html', entry.replace('./releases/r1/styles.css', '/releases/r1/styles.css')), [['RELEASE_ENTRY_INVALID', 'index.html']]],
    ['entry references missing module', async (out) => write(out, 'index.html', entry.replace('</body>', '<link rel="modulepreload" href="./releases/r1/app/missing.js"></body>')), [['RELEASE_MISSING_FILE', 'releases/r1/app/missing.js']]],
    ['entry references release.json', async (out) => write(out, 'index.html', entry.replace('</body>', '<link rel="prefetch" href="./releases/r1/release.json"></body>')), [['RELEASE_ENTRY_INVALID', 'index.html']]],
    ['entry points at unknown release', async (out) => write(out, 'index.html', entry.replaceAll('releases/r1/', 'releases/r7/')),
      [['RELEASE_MISSING_FILE', 'releases/r7/styles.css'], ['RELEASE_MISSING_FILE', 'releases/r7/app/ui/appearance-boot.js'], ['RELEASE_MISSING_FILE', 'releases/r7/app/main.js'], ['RELEASE_ENTRY_INVALID', 'index.html'], ['RELEASE_SW_INVALID', 'sw.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
    ['release manifest missing', async (out) => rm(join(out, 'releases/r1/release.json')), [['RELEASE_MANIFEST_INVALID', 'releases/r1/release.json']]],
    ['release manifest for another id', async (out) => write(out, 'releases/r1/release.json', JSON.stringify({ id: 'r2', files: {} })), [['RELEASE_MANIFEST_INVALID', 'releases/r1/release.json']]],
    ['versioned file removed', async (out) => rm(join(out, 'releases/r1/app/ui/shell.js')), [['RELEASE_MANIFEST_INVALID', 'releases/r1/release.json'], ['RELEASE_SW_INVALID', 'sw.js']]],
    ['versioned file altered', async (out) => write(out, 'releases/r1/app/i18n/ko.json', '{"app.name":"x"}'), [['RELEASE_HASH_MISMATCH', 'releases/r1/app/i18n/ko.json']]],
    ['config without origins', async (out) => write(out, 'releases/r1/app/config.js', 'export const ENDPOINT_ORIGINS = [];'),
      [['RELEASE_HASH_MISMATCH', 'releases/r1/app/config.js'], ['RELEASE_CONFIG_INVALID', 'releases/r1/app/config.js'], ['RELEASE_CSP_MISMATCH', '_headers']]],
  ];
  for (const [name, mutate, expected] of cases) {
    const out = join(directory, `case-${cases.findIndex((entry) => entry[0] === name)}`);
    await cp(good, out, { recursive: true });
    await mutate(out);
    const result = await checkRelease({ dir: out });
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.issues.map((issue) => [issue.code, issue.path]).sort(), [...expected].sort(), name);
    assert.ok(!JSON.stringify(result).includes('TEST_SECRET'), `${name} never echoes contents`);
  }
  assert.deepEqual(await checkRelease({ dir: join(directory, 'nope') }), { ok: false, issues: [{ code: 'RELEASE_DIR_INVALID' }], releases: [], current: null });
  assert.equal((await checkRelease({ dir: good })).ok, true, 'the good tree stays valid after the copies');
  const injected = await checkRelease({ dir: good, endpointOrigins: ['https://example.com'] });
  assert.deepEqual(injected.issues, [{ code: 'RELEASE_CSP_MISMATCH', path: '_headers' }]);
});

test('multiple releases coexist; --point moves the entry files back without deleting anything', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  await stageRelease({ id: 'r1', out, root });
  await write(root, 'app/ui/shell.js', 'export function mount() { return 2; }\n');
  await stageRelease({ id: 'r2', out, root });
  let result = await checkRelease({ dir: out });
  assert.deepEqual([result.ok, result.releases, result.current], [true, ['r1', 'r2'], 'r2']);
  assert.match(await readFile(join(out, 'index.html'), 'utf8'), /releases\/r2\/app\/main\.js/);
  assert.equal(readRelease(await readFile(join(out, 'sw.js'), 'utf8')).id, 'r2');
  const before = await listTree(out);

  const pointed = await pointRelease({ id: 'r1', out, root });
  // P3-35: a rollback writes every root file except the policy, which belongs
  // to the deployment and is not restored from an older build.
  assert.deepEqual([...pointed.files].sort(),
    ROOT_FILES.filter((file) => file !== 'policy.json').sort());
  assert.deepEqual(await listTree(out), before, 'no release file was added or removed');
  result = await checkRelease({ dir: out });
  assert.deepEqual([result.ok, result.releases, result.current], [true, ['r1', 'r2'], 'r1']);
  const entry = await readFile(join(out, 'index.html'), 'utf8');
  assert.match(entry, /releases\/r1\/app\/main\.js/);
  assert.doesNotMatch(entry, /releases\/r2\//);
  const release = readRelease(await readFile(join(out, 'sw.js'), 'utf8'));
  assert.equal(release.id, 'r1');
  assert.ok(release.shell.every((path) => !path.includes('/r2/')));
  await assert.rejects(pointRelease({ id: 'r9', out, root }), { message: 'RELEASE_NOT_FOUND' });
  await assert.rejects(pointRelease({ id: 'bad id', out, root }), { message: 'RELEASE_ID_INVALID' });
  await write(out, 'releases/r1/release.json', JSON.stringify({ id: 'r1', files: { '../escape.js': 'x' } }));
  await assert.rejects(pointRelease({ id: 'r1', out, root }), { message: 'RELEASE_MANIFEST_INVALID' });
});

// P3-13: the root entry is rewritten from the current template, so a release
// staged before the appearance boot existed cannot be pointed at again; the
// root would reference a file that release does not carry. Staging likewise
// refuses a template that loads a file missing from the source tree.
test('staging and --point refuse an entry that references files the release does not carry', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  await stageRelease({ id: 'old', out, root });
  await stageRelease({ id: 'new', out, root });
  // Turn "old" into a pre-P3-13 release: no boot file, manifest without it.
  await rm(join(out, 'releases/old/app/ui/appearance-boot.js'));
  const manifest = JSON.parse(await readFile(join(out, 'releases/old/release.json'), 'utf8'));
  delete manifest.files['app/ui/appearance-boot.js'];
  await write(out, 'releases/old/release.json', JSON.stringify(manifest));
  const before = await listTree(out);
  const rootEntry = await readFile(join(out, 'index.html'), 'utf8');
  await assert.rejects(pointRelease({ id: 'old', out, root }), { message: 'RELEASE_ENTRY_INVALID' });
  assert.deepEqual(await listTree(out), before, 'nothing was written');
  assert.equal(await readFile(join(out, 'index.html'), 'utf8'), rootEntry, 'the root entry still points at "new"');
  assert.equal((await checkRelease({ dir: out })).ok, true);
  await pointRelease({ id: 'new', out, root });
  assert.equal((await checkRelease({ dir: out })).ok, true);

  await rm(join(root, 'app/ui/appearance-boot.js'));
  await assert.rejects(stageRelease({ id: 'no-boot', out, root }), { message: 'RELEASE_ENTRY_INVALID' });
  const source = await readFile(join(repoRoot, 'index.html'), 'utf8');
  await write(root, 'app/ui/appearance-boot.js', FIXTURE_APP['app/ui/appearance-boot.js']);
  await write(root, 'index.html', source.replace('./app/main.js', './app/missing.js'));
  await assert.rejects(stageRelease({ id: 'no-main', out, root }), { message: 'RELEASE_ENTRY_INVALID' });
});

test('the repository stages without docs, tests, scripts, tools, git metadata or secrets', async (t) => {
  const directory = await temp(t);
  const out = join(directory, 'out');
  const staged = await stageRelease({ id: 'repo-check', out });
  const files = await listTree(out);
  assert.deepEqual([...staged.files].sort(), files);
  for (const file of files) assert.ok(classifyPath(file), `${file} is allowlisted`);
  const versioned = await collectVersionedFiles(repoRoot);
  assert.deepEqual(versionedOf(files, 'repo-check'), [...versioned].sort());
  assert.ok(versioned.includes('app/config.js') && versioned.includes('app/i18n/ko.json') && versioned.includes('app/audio/capture-worklet.js'));
  assert.ok(!files.some((file) => /^(docs|tests|scripts|tools|node_modules|\.git|\.moai)\//.test(file) || file.includes('package.json') || /\/\./.test(`/${file}`)));
  const result = await checkRelease({ dir: out });
  // app/main.js is created by P1-19; until then the entry legitimately
  // references a module that does not exist yet. Nothing else may fail.
  const remaining = result.issues.filter((issue) => !(issue.code === 'RELEASE_MISSING_FILE' && issue.path === 'releases/repo-check/app/main.js'));
  assert.deepEqual(remaining, []);
  assert.equal(result.current, 'repo-check');
});

// The real shell, headers and app/config.js (imported from the release) pass
// the full check once the P1-19 entry module exists.
async function repoLikeSource(directory) {
  const root = join(directory, 'repo');
  const versioned = await collectVersionedFiles(repoRoot);
  for (const file of [...ROOT_FILES, ...versioned]) await write(root, file, await readFile(join(repoRoot, file)));
  if (!versioned.includes('app/main.js')) await write(root, 'app/main.js', "import './ui/shell.js';\n");
  return root;
}

test('the real shell, headers and endpoint origins pass the full check', async (t) => {
  const directory = await temp(t);
  const root = await repoLikeSource(directory);
  const out = join(directory, 'out');
  await stageRelease({ id: 'p1-review', out, root });
  const result = await checkRelease({ dir: out });
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.current, 'p1-review');
  const headers = parseHeaders(await readFile(join(out, '_headers'), 'utf8'));
  const csp = headers.find((rule) => rule.path === '/*').headers.get('content-security-policy');
  const connect = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src')).split(/\s+/).slice(1);
  assert.deepEqual(connect.sort(), ["'self'", ...ENDPOINT_ORIGINS].sort());
  assert.ok(ENDPOINT_ORIGINS.includes('https://generativelanguage.googleapis.com') && ENDPOINT_ORIGINS.includes('wss://generativelanguage.googleapis.com'));
  const shell = readRelease(await readFile(join(out, 'sw.js'), 'utf8')).shell;
  assert.ok(shell.includes('./releases/p1-review/app/i18n/ja.json') && shell.includes('./icons/icon-512.png') && shell.includes('./manifest.ja.webmanifest'));
  assert.ok(shell.every((path) => !/^[a-z]+:/.test(path)));
});

// Owner (2026-09-07): the built-in key is never in git. stage-release writes it
// into the staged copy from a local file, and check-release announces it.
test('--builtin-key-file writes the key into the staged copy only, check-release announces it, and bad input is refused by code', async (t) => {
  const directory = await temp(t);
  const root = await repoLikeSource(directory);
  const run = (script, args) => spawnSync(process.execPath, [join('scripts', script), ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.doesNotMatch(await readFile(join(root, 'app/security/builtin-key.js'), 'utf8'), /BUILTIN_KEY = '[^']+'/, 'the repository slot is empty');
  // Any printable key shape, not only AIza…: the slot is the signal.
  const key = 'AQ.TEST_ONLY_' + 'k'.repeat(40);
  await write(directory, 'key.txt', `${key}\n`);
  const out = join(directory, 'out');
  await stageRelease({ id: 'keyed', out, root, builtinKeyFile: join(directory, 'key.txt') });
  const staged = await readFile(join(out, 'releases/keyed/app/security/builtin-key.js'), 'utf8');
  assert.ok(staged.includes(`export const BUILTIN_KEY = '${key}';`), 'the staged file carries the key');
  assert.doesNotMatch(await readFile(join(root, 'app/security/builtin-key.js'), 'utf8'), new RegExp(key), 'the source is untouched');
  const manifest = JSON.parse(await readFile(join(out, 'releases/keyed/release.json'), 'utf8'));
  assert.equal(manifest.files['app/security/builtin-key.js'], sha256(Buffer.from(staged)), 'the digest is of the staged bytes');
  const result = await checkRelease({ dir: out });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.notices, [{ code: 'RELEASE_BUILTIN_KEY', path: 'releases/keyed/app/security/builtin-key.js' }]);
  // Without the option nothing is written and nothing is announced.
  await stageRelease({ id: 'plain', out, root });
  assert.doesNotMatch(await readFile(join(out, 'releases/plain/app/security/builtin-key.js'), 'utf8'), /BUILTIN_KEY = '[^']+'/);
  // The root is cumulative, so the keyed release is still announced and the plain one is not.
  assert.deepEqual((await checkRelease({ dir: out })).notices.map((notice) => notice.path), ['releases/keyed/app/security/builtin-key.js']);
  // Refusals are codes only.
  await write(directory, 'bad.txt', 'has a space');
  await assert.rejects(stageRelease({ id: 'bad', out, root, builtinKeyFile: join(directory, 'bad.txt') }), { message: 'RELEASE_KEY_INVALID' });
  await write(directory, 'quote.txt', "it's");
  await assert.rejects(stageRelease({ id: 'bad2', out, root, builtinKeyFile: join(directory, 'quote.txt') }), { message: 'RELEASE_KEY_INVALID' });
  await assert.rejects(stageRelease({ id: 'bad3', out, root, builtinKeyFile: join(directory, 'missing.txt') }), { message: 'RELEASE_KEY_FILE_MISSING' });
  const pointed = run('stage-release.mjs', ['--point', 'keyed', '--out', out, '--builtin-key-file', join(directory, 'key.txt')]);
  assert.equal(pointed.status, 1);
  assert.equal(pointed.stderr.trim(), 'RELEASE_ARGUMENT_INVALID');
  assert.ok(!pointed.stdout.includes(key) && !pointed.stderr.includes(key));
  const staged2 = run('stage-release.mjs', ['--id', 'cli-keyed', '--out', out, '--builtin-key-file', join(directory, 'key.txt')]);
  assert.equal(staged2.status, 0, staged2.stderr);
  assert.ok(!staged2.stdout.includes(key), 'the key is never echoed');
  const checked = run('check-release.mjs', [out]);
  assert.match(checked.stdout, /^RELEASE_BUILTIN_KEY releases\/cli-keyed\/app\/security\/builtin-key\.js\nRELEASE_BUILTIN_KEY releases\/keyed\/app\/security\/builtin-key\.js\nRELEASE_OK current=cli-keyed releases=3 files=\d+\n$/);
  assert.ok(!checked.stdout.includes(key));
});

test('CLI stages and checks with fixed codes and never echoes argument contents', async (t) => {
  const directory = await temp(t);
  const run = (script, args) => spawnSync(process.execPath, [join('scripts', script), ...args], { cwd: repoRoot, encoding: 'utf8' });
  for (const args of [[], ['--id'], ['--id', 'x'], ['--id', 'x', '--id', 'y', '--out', directory], ['--key', 'TEST_SECRET'],
    ['--id', 'TEST SECRET', '--out', directory], ['--id', 'x', '--point', 'y', '--out', directory], ['--id', 'x', '--out', '--point']]) {
    const child = run('stage-release.mjs', args);
    assert.equal(child.status, 1, args.join(' '));
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /^RELEASE_[A-Z_]+\n$/);
    assert.ok(!child.stderr.includes('TEST'));
  }
  const rootAsOut = run('stage-release.mjs', ['--id', 'x', '--out', '.']);
  assert.equal(rootAsOut.status, 1);
  assert.equal(rootAsOut.stderr, 'RELEASE_OUT_INVALID\n');

  const staged = run('stage-release.mjs', ['--id', 'cli-1', '--out', join(directory, 'out')]);
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.stdout, /^RELEASE_STAGED id=cli-1 files=\d+\n$/);
  assert.equal(run('stage-release.mjs', ['--id', 'cli-1', '--out', join(directory, 'out')]).stderr, 'RELEASE_EXISTS\n');
  const pointed = run('stage-release.mjs', ['--point', 'cli-1', '--out', join(directory, 'out')]);
  assert.equal(pointed.status, 0, pointed.stderr);
  // One fewer than ROOT_FILES: a rollback never rewrites the deployed policy.
  assert.equal(pointed.stdout, `RELEASE_POINTED id=cli-1 files=${ROOT_FILES.length - 1}\n`);

  for (const args of [[], ['--help'], ['a', 'b']]) {
    const child = run('check-release.mjs', args);
    assert.equal(child.status, 1);
    assert.equal(child.stderr, 'RELEASE_ARGUMENT_INVALID\n');
  }
  const missing = run('check-release.mjs', [join(directory, 'missing')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, 'RELEASE_DIR_INVALID\n');

  const root = await repoLikeSource(directory);
  await stageRelease({ id: 'cli-2', out: join(directory, 'good'), root });
  const ok = run('check-release.mjs', [join(directory, 'good')]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^RELEASE_OK current=cli-2 releases=1 files=\d+\n$/);
  await write(join(directory, 'good'), 'docs/notes.md', fakeKey());
  const bad = run('check-release.mjs', [join(directory, 'good')]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.deepEqual(bad.stderr.trim().split('\n').sort(), ['RELEASE_SECRET_PATTERN docs/notes.md', 'RELEASE_UNEXPECTED_FILE docs/notes.md']);
});

// P2-20 exercises reviewed code registries only; no real venue or key is used.
test('empty product hub registry stays shared, frozen and invisible at boot', async (t) => {
  assert.equal(REGISTERED_HUBS, PROTOCOL_HUBS);
  assert.ok(Object.isFrozen(REGISTERED_HUBS));
  assert.deepEqual(REGISTERED_HUBS, []);
  assert.deepEqual(HUB_ENDPOINTS, []);
  assert.deepEqual(HUB_ORIGINS, []);
  const b = await boot();
  t.after(() => b.app.close());
  assert.deepEqual(b.el('sim-mode').children.map(option => option.getAttribute('value')), ['direct']);
  assert.equal(visible(b.el('sim-room')), false);
  assert.equal(b.socketURLs.length, 0);
});

test('reviewed hub endpoints reject unsafe registration without exposing input', () => {
  const hub = { id: 'venue', labelKey: 'hub.venue', url: 'wss://venue.example.test:8443/ws' };
  assert.deepEqual(hubEndpoints([hub, { ...hub, id: 'second' }]), [hub.url]);
  assert.deepEqual(hubOrigins([hub]), ['wss://venue.example.test:8443']);
  assert.equal(createHubProtocol({ hubs: [hub] }).buildUrl('venue', 'abc123'), `${hub.url}?room=abc123`);
  for (const hubs of [null, {}, [null], [hub, hub], [{ ...hub, labelKey: 'SECRET label' }],
    ...['ws://venue.example.test/ws', 'https://venue.example.test/ws',
      'wss://SECRET@venue.example.test/ws', 'wss://venue.example.test/ws?room=SECRET',
      'wss://venue.example.test/ws#SECRET', 'wss://venue.example.test/other']
      .map(url => [{ ...hub, url }])]) {
    assert.throws(() => hubEndpoints(hubs), error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.doesNotMatch(JSON.stringify(error), /SECRET/);
      return true;
    });
  }
});

test('registered venue CSP follows the immutable release through rollback', async (t) => {
  const directory = await temp(t), root = await repoLikeSource(directory), out = join(directory, 'out');
  await stageRelease({ id: 'empty', root, out });
  const protocol = await readFile(join(root, 'app/hub/protocol.js'), 'utf8');
  const hubs = [{ id: 'venue', labelKey: 'hub.venue', url: 'wss://venue.example.test:8443/ws' }];
  // The existing P2-10 registry is the shared declaration, including in fixtures.
  await write(root, 'app/hub/protocol.js', protocol.replace('REGISTERED_HUBS = Object.freeze([])',
    `REGISTERED_HUBS = Object.freeze(${JSON.stringify(hubs)})`));
  for (const language of SUPPORTED_LANGUAGES) {
    const dictionary = JSON.parse(await readFile(join(root, `app/i18n/${language}.json`), 'utf8'));
    assert.equal(typeof dictionary[hubs[0].labelKey], 'string');
  }
  await stageRelease({ id: 'venue', root, out });
  const csp = async () => parseHeaders(await readFile(join(out, '_headers'), 'utf8'))
    .find(rule => rule.path === '/*').headers.get('content-security-policy');
  assert.deepEqual(checkCsp(await csp(), [...ENDPOINT_ORIGINS, 'wss://venue.example.test:8443']), []);
  assert.deepEqual((await checkRelease({ dir: out })).issues,
    [{ code: 'RELEASE_CSP_MISMATCH', path: 'releases/empty/app/config.js' }]);
  const venueOnly = join(directory, 'venue-only');
  await stageRelease({ id: 'venue', root, out: venueOnly });
  assert.equal((await checkRelease({ dir: venueOnly })).ok, true);
  await pointRelease({ id: 'empty', root, out });
  assert.deepEqual(checkCsp(await csp(), ENDPOINT_ORIGINS), []);
  assert.deepEqual((await checkRelease({ dir: out })).issues,
    [{ code: 'RELEASE_CSP_MISMATCH', path: 'releases/venue/app/config.js' }]);
});

test('P2 JS graph and stream worklet resolve inside the versioned SW shell', async (t) => {
  const directory = await temp(t), out = join(directory, 'out'), id = 'p2-graph';
  await stageRelease({ id, out });
  const files = await collectVersionedFiles(repoRoot);
  const shell = readRelease(await readFile(join(out, 'sw.js'), 'utf8')).shell;
  const base = new URL(`https://app.example.test/interp-app/releases/${id}/`);
  const cached = new Set(shell.map(path => new URL(path, 'https://app.example.test/interp-app/').href));
  for (const file of files.filter(file => file.endsWith('.js'))) {
    const url = new URL(file, base);
    assert.ok(cached.has(url.href), file);
    const source = await readFile(join(out, `releases/${id}`, file), 'utf8');
    const references = [...source.matchAll(/^[ \t]*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"]([^'"]+)['"]/gm),
      ...source.matchAll(/new URL\(['"]([^'"]+)['"],\s*import\.meta\.url\)/g)];
    for (const [, specifier] of references) {
      assert.ok(specifier.startsWith('.'), specifier);
      const target = new URL(specifier, url);
      assert.ok(target.href.startsWith(base.href), target.href);
      assert.ok(cached.has(target.href), target.href);
    }
  }
  const capture = await readFile(join(out, `releases/${id}/app/audio/stream-capture.js`), 'utf8');
  assert.match(capture, /addModule\(new URL\('\.\/capture-worklet\.js', import\.meta\.url\)\)/);
  for (const file of ['app/hub/config.js', 'app/audio/stream-capture.js', 'app/audio/stream-player.js', 'app/i18n/boot-fallback.js', 'app/ui/appearance-boot.js']) {
    assert.ok(cached.has(new URL(file, base).href), file);
  }
  await rm(join(out, `releases/${id}/app/audio/capture-worklet.js`));
  assert.equal((await checkRelease({ dir: out })).ok, false);
});

test('staging rejects endpoint and origin declaration drift', async (t) => {
  const directory = await temp(t), root = await fixtureSource(directory);
  await write(root, 'app/config.js', `${FIXTURE_APP['app/config.js']}\nexport const ENDPOINT_ALLOWLIST = ['wss://venue.example.test/ws'];\n`);
  await assert.rejects(stageRelease({ id: 'drift', out: join(directory, 'out'), root }), { message: 'RELEASE_CONFIG_INVALID' });
});

test('P3-35 the policy and the console ship with a release but are never precached', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  const staged = await stageRelease({ id: 'p35', out, root, now: () => new Date('2026-09-06T00:00:00Z') });

  // Both are deployed at the root.
  assert.ok(staged.files.includes('policy.json'));
  assert.ok(staged.files.includes('admin/index.html'));
  assert.deepEqual([...UNCACHED_ROOT_FILES], ['policy.json', 'admin/index.html']);

  // Neither is in the service worker's shell: the policy is read fresh on every
  // start, and a cached console would show a policy that is no longer deployed.
  const worker = await readFile(join(out, 'sw.js'), 'utf8');
  const release = JSON.parse(worker.match(/const RELEASE = (\{[\s\S]*?\}); \/\/ @release/)[1]);
  assert.equal(release.shell.some((path) => path.includes('policy.json')), false, 'the policy is never precached');
  assert.equal(release.shell.some((path) => path.includes('admin/')), false, 'the console entry is never precached');
  assert.deepEqual(shellFor('p35', []).filter((path) => /policy|admin/.test(path)), []);

  // The console entry points at its own release, not at the repository paths.
  const adminEntry = await readFile(join(out, 'admin/index.html'), 'utf8');
  assert.match(adminEntry, /\.\.\/releases\/p35\/app\/admin\/boot\.js/);
  assert.match(adminEntry, /\.\.\/releases\/p35\/styles\.css/);
  assert.equal(/\.\.\/app\//.test(adminEntry), false, 'no unversioned app reference survives');
});

test('P3-35 a rollback moves the entry files and leaves the deployed policy alone', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  await stageRelease({ id: 'old', out, root, now: () => new Date('2026-09-05T00:00:00Z') });
  await stageRelease({ id: 'new', out, root, now: () => new Date('2026-09-06T00:00:00Z') });

  // The administrator publishes a newer policy to the deployment root.
  const published = `${JSON.stringify({ published: true }, null, 2)}\n`;
  await writeFile(join(out, 'policy.json'), published);

  // Rolling back re-points the entry files at the older release. It must not
  // restore the policy that shipped with that build: the policy in force is
  // the one the administrator published, and re-deploying an old one would
  // silently undo an emergency stop or a feature change.
  const pointed = await pointRelease({ id: 'old', out, root });
  assert.equal(pointed.files.includes('policy.json'), false, 'a rollback does not write the policy');
  assert.equal(await readFile(join(out, 'policy.json'), 'utf8'), published, 'the published policy survives');
  // The console entry does follow the rollback, so it matches the app.
  assert.ok(pointed.files.includes('admin/index.html'));
  assert.match(await readFile(join(out, 'admin/index.html'), 'utf8'), /releases\/old\//);
  assert.match(await readFile(join(out, 'index.html'), 'utf8'), /releases\/old\//);
});

test('P3-36 a release may not ship a policy the app would reject', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  await stageRelease({ id: 'p36', out, root, now: () => new Date('2026-09-06T00:00:00Z') });
  const good = await readFile(join(out, 'policy.json'), 'utf8');
  const codesFor = async () => (await checkRelease({ dir: out })).issues.map((issue) => issue.code);

  assert.deepEqual(await codesFor(), [], 'the repository policy passes');

  // Unparsable, missing, and schema-invalid all block the deploy.
  await writeFile(join(out, 'policy.json'), '{not json');
  assert.ok((await codesFor()).includes('RELEASE_POLICY_INVALID'));
  await rm(join(out, 'policy.json'));
  assert.ok((await codesFor()).includes('RELEASE_POLICY_MISSING'));
  await writeFile(join(out, 'policy.json'), JSON.stringify({ schemaVersion: 99 }));
  assert.ok((await codesFor()).includes('RELEASE_POLICY_INVALID'), 'the app\'s own validator decides');

  // A credential in the public policy file is refused, not merely reported as
  // an unknown field.
  const withKey = { ...JSON.parse(good), sharedEvents: [{ id: 'e', key: 'SHOULD-NOT-SHIP' }] };
  await writeFile(join(out, 'policy.json'), JSON.stringify(withKey));
  assert.ok((await codesFor()).includes('RELEASE_POLICY_SECRET'));

  // A policy demanding a newer app than the one being deployed would lock the
  // release out of its own site.
  const future = { ...JSON.parse(good), minAppVersion: '99.0.0' };
  await writeFile(join(out, 'policy.json'), JSON.stringify(future));
  assert.ok((await codesFor()).includes('RELEASE_POLICY_VERSION'));

  await writeFile(join(out, 'policy.json'), good);
  assert.deepEqual(await codesFor(), []);
});

test('P3-36 both HTML entries are checked, and _headers passing is not a deployment fact', async (t) => {
  const directory = await temp(t);
  const root = await fixtureSource(directory);
  const out = join(directory, 'out');
  const staged = await stageRelease({ id: 'p36b', out, root, now: () => new Date('2026-09-06T00:00:00Z') });
  // Two entry points ship, and both point at this release.
  for (const entry of ['index.html', 'admin/index.html']) {
    assert.ok(staged.files.includes(entry), entry);
    assert.match(await readFile(join(out, entry), 'utf8'), /releases\/p36b\//, entry);
  }
  // The header file itself is only a file: the checklist says so, because
  // GitHub Pages does not apply it.
  const headers = await readFile(join(out, '_headers'), 'utf8');
  assert.match(headers, /GitHub Pages does not apply this file/);
  const checklist = await readFile(join(repoRoot, 'docs/release-checklist.md'), 'utf8');
  assert.match(checklist, /_headers/, 'the checklist records the unverified header state');
});
