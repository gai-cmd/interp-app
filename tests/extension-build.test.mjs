import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, constants, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { SECRET_PATTERNS } from '../scripts/check-release.mjs';
import * as build from '../scripts/build-extension.mjs';

// docs/extension.md §10 and §11.1 (group A, M2): the build script, tested against FIXTURE roots created in
// temp directories. Nothing here builds the real repository, writes dist/, launches a browser or makes a
// sound. The only child process is `node scripts/build-extension.mjs` with ARGUMENT errors (the CLI has no
// --root flag, so any child run would otherwise see the real tree). Every fake key is assembled at runtime.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const { buildExtension, computeImportClosure, lintManifest, decodePng, encodePng, downscale4, parseArguments, runCli, isOwnOutput, OUTPUT_MARKER } = build;

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LANGUAGES = ['en', 'ko', 'ja'];

async function tempDir(t, prefix = 'interp-extbuild-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Every file under root; the build's own ownership marker at the top is build metadata, not extension content, so it is left out. */
async function listTree(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === OUTPUT_MARKER) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  await walk(root);
  return files.sort();
}

/** One hash for a whole tree: names and bytes, so byte-identical trees have equal digests and nothing else does. */
async function treeDigest(root, { except = () => false } = {}) {
  const hash = createHash('sha256');
  for (const path of (await listTree(root)).filter((name) => !except(name))) hash.update(`${path}\0${sha256(await readFile(join(root, path)))}\n`);
  return hash.digest('hex');
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function rejectsWith(promise, code, label = '') {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, code, label);
    assert.equal(error.code, code, label);
    return true;
  });
}

// --- a test-local PNG reader and writer, written independently of the build's codec ---

function readPng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, body });
    offset += 12 + length;
  }
  assert.equal(offset, bytes.length, 'no bytes after the last chunk');
  assert.deepEqual([chunks[0].type, chunks.at(-1).type], ['IHDR', 'IEND']);
  const header = chunks[0].body;
  const image = { width: header.readUInt32BE(0), height: header.readUInt32BE(4), depth: header[8], color: header[9], interlace: header[12], types: chunks.map((chunk) => chunk.type) };
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.body)));
  const row = image.width * 3;
  assert.equal(raw.length, image.height * (row + 1), 'inflated size matches the header');
  const rows = [];
  for (let y = 0; y < image.height; y += 1) {
    const type = raw[y * (row + 1)];
    const line = [...raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1))];
    const above = y === 0 ? new Array(row).fill(0) : rows[y - 1];
    for (let x = 0; x < row; x += 1) {
      const a = x < 3 ? 0 : line[x - 3];
      const b = above[x];
      const c = x < 3 ? 0 : above[x - 3];
      let predictor = 0;
      if (type === 1) predictor = a;
      else if (type === 2) predictor = b;
      else if (type === 3) predictor = Math.floor((a + b) / 2);
      else if (type === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(type, 0, 'known filter type');
      line[x] = (line[x] + predictor) & 255;
    }
    rows.push(line);
  }
  return { ...image, rgb: Uint8Array.from(rows.flat()) };
}

function chunkOf(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Writes a PNG with a chosen filter type per scanline, so the decoder is checked against all five. */
function writePng({ width, height, rgb, filters, color = 2, interlace = 0, depth = 8 }) {
  const row = width * 3;
  const lines = [];
  for (let y = 0; y < height; y += 1) {
    const type = filters[y % filters.length];
    const line = Buffer.alloc(row + 1);
    line[0] = type;
    for (let x = 0; x < row; x += 1) {
      const current = rgb[y * row + x];
      const a = x < 3 ? 0 : rgb[y * row + x - 3];
      const b = y === 0 ? 0 : rgb[(y - 1) * row + x];
      const c = x < 3 || y === 0 ? 0 : rgb[(y - 1) * row + x - 3];
      let predictor = 0;
      if (type === 1) predictor = a;
      else if (type === 2) predictor = b;
      else if (type === 3) predictor = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x + 1] = (current - predictor) & 255;
    }
    lines.push(line);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  header[12] = interlace;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunkOf('IHDR', header),
    chunkOf('IDAT', deflateSync(Buffer.concat(lines))), chunkOf('IEND', Buffer.alloc(0))]);
}

/** Deterministic, non-uniform pixels: every 4x4 block has a distinct mean, so a wrong downscale cannot hide. */
const pixel = (x, y, channel) => ((x * 7 + y * 13 + channel * 61 + ((x * y) % 17) * 3) & 255);
function patternImage(size) {
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) for (let channel = 0; channel < 3; channel += 1) rgb[(y * size + x) * 3 + channel] = pixel(x, y, channel);
  return { width: size, height: size, rgb };
}
/** The expected 4x4-box mean computed straight from the pattern function (never through the build's own code). */
function expectedBlockMean(x, y, channel) {
  let sum = 0;
  for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 4; dx += 1) sum += pixel(x * 4 + dx, y * 4 + dy, channel);
  return Math.round(sum / 16);
}

const ICONS = Object.fromEntries([16, 32, 192, 512].map((size) => [size, encodePng(patternImage(size))]));

// --- the fixture tree ---

const MANIFEST = {
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  version: '0.1.0',
  default_locale: 'en',
  minimum_chrome_version: '116',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_title: '__MSG_actionTitle__', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
  background: { service_worker: 'extension/background/service-worker.js', type: 'module' },
  side_panel: { default_path: 'extension/panel/panel.html' },
  options_ui: { page: 'extension/options/options.html', open_in_tab: true },
  permissions: [...build.ALLOWED_PERMISSIONS],
  content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['extension/overlay/overlay.js'], run_at: 'document_idle', all_frames: false }],
  commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+Y' }, description: '__MSG_commandOpen__' } },
};
const messageTable = (language) => Object.fromEntries(['extName', 'extDescription', 'actionTitle', 'commandOpen']
  .map((name) => [name, { message: `${name} ${language}`, description: `Fixture ${name}.` }]));
const KEY_SOURCE = '// Fixture key slot; the build replaces the line below.\nexport const BUILTIN_KEYS = Object.freeze([]);\n';
const page = (title, ...tags) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${tags.join('\n')}\n</head>\n<body></body>\n</html>\n`;

function baseFiles() {
  const files = {
    'extension/manifest.json': `${JSON.stringify(MANIFEST, null, 4)}\n`,
    'extension/lib/builtin-key.js': KEY_SOURCE,
    'extension/lib/chrome-adapter.js': 'export const adapter = Object.freeze({});\n',
    'extension/lib/i18n.js': "import { load } from '../../app/i18n/index.js';\nexport const language = load;\n",
    'extension/lib/settings.js': "import { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';\nimport '../../app/engine/listen-state.js';\nimport './builtin-key.js';\nexport const models = LIVE_MODELS;\n",
    'extension/background/service-worker.js': "import './sw-core.js';\n",
    'extension/background/sw-core.js': "import { models } from '../lib/settings.js';\nimport '../lib/chrome-adapter.js';\nexport const core = models;\n",
    'extension/engine/host.html': page('', '<script type="module" src="./host.js"></script>'),
    'extension/engine/host.js': "import '../../app/platform.js';\nimport '../../app/engine/sim.js';\nimport '../../app/config.js';\nimport './worker-timers.js';\nimport '../lib/i18n.js';\n",
    'extension/engine/worker-timers.js': "export const worker = new URL('./timer-worker.js', import.meta.url);\n",
    'extension/engine/timer-worker.js': 'self.onmessage = () => {};\n',
    'extension/panel/panel.html': page('', '<link rel="stylesheet" href="../../styles.css">', '<link rel="stylesheet" href="./panel.css">', '<script type="module" src="./panel.js"></script>'),
    'extension/panel/panel.css': '.panel { color: #fff; }\n',
    'extension/panel/panel.js': "import '../lib/i18n.js';\nimport '../../app/i18n/index.js';\n",
    'extension/options/options.html': page('', '<link rel="stylesheet" href="../../styles.css">', '<link rel="stylesheet" href="../pages.css">', '<script type="module" src="./options.js"></script>'),
    'extension/options/options.js': "import { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';\nimport { validateKey } from '../../app/security/shared-key.js';\nexport const options = [LIVE_MODELS, validateKey];\n",
    'extension/permission/mic-permission.html': page('', '<link rel="stylesheet" href="../pages.css">', '<script type="module" src="./mic-permission.js"></script>'),
    'extension/permission/mic-permission.js': "import '../lib/i18n.js';\n",
    'extension/pages.css': '.page { color: #000; }\n',
    'extension/overlay/overlay.js': "(function () {\n  'use strict';\n  var wire = { port: 'interp-overlay/1' };\n  return wire;\n})();\n",
    'app/config.js': "export const ENDPOINT_ORIGINS = Object.freeze(['https://example.test']);\n",
    'app/platform.js': "import './audio/stream-capture.js';\nexport const createPlatform = () => ({});\n",
    'app/audio/stream-capture.js': "export const worklet = new URL('./capture-worklet.js', import.meta.url);\n",
    'app/audio/capture-worklet.js': "registerProcessor('fixture-capture', class {});\n",
    'app/engine/sim.js': "import './listen-state.js';\nexport const createSimEngine = () => ({});\n",
    'app/engine/listen-state.js': 'export const LISTEN = 1;\n',
    'app/providers/gemini/live-config.js': 'export const LIVE_MODELS = Object.freeze([]);\n',
    'app/security/shared-key.js': 'export const validateKey = () => true;\n',
    'app/i18n/index.js': "import './boot-fallback.js';\nexport const load = (language) => new URL(`./${language}.json`, import.meta.url);\n",
    'app/i18n/boot-fallback.js': 'export const FALLBACK = {};\n',
    'app/main.js': "import './ui/never.js';\n",
    'app/ui/never.js': 'export const never = 1;\n',
    'app/security/builtin-key.js': KEY_SOURCE,
    'app/unused.js': 'export const unused = 1;\n',
    'styles.css': ':root { --fixture: 1; }\n',
    'icons/favicon-16.png': ICONS[16],
    'icons/favicon-32.png': ICONS[32],
    'icons/icon-192.png': ICONS[192],
    'icons/icon-512.png': ICONS[512],
  };
  for (const language of LANGUAGES) {
    files[`extension/_locales/${language}/messages.json`] = `${JSON.stringify(messageTable(language), null, 2)}\n`;
    files[`extension/i18n/${language}.json`] = `${JSON.stringify({ 'ext.name': language })}\n`;
    files[`app/i18n/${language}.json`] = `${JSON.stringify({ 'app.name': language })}\n`;
  }
  return files;
}

/** The files a build of baseFiles() must produce, written down independently of the build's own closure code. */
const EXPECTED_APP = Object.freeze(['app/audio/capture-worklet.js', 'app/audio/stream-capture.js', 'app/config.js', 'app/engine/listen-state.js',
  'app/engine/sim.js', 'app/i18n/boot-fallback.js', 'app/i18n/en.json', 'app/i18n/index.js', 'app/i18n/ja.json', 'app/i18n/ko.json', 'app/platform.js',
  'app/providers/gemini/live-config.js', 'app/security/shared-key.js']);

/** mutate(files) may add, replace or delete (`delete files[path]`) entries; extra async work goes in `after(root)`. */
async function makeRoot(t, mutate = () => {}, after = async () => {}) {
  const root = await tempDir(t);
  const files = baseFiles();
  mutate(files);
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  await after(root);
  return root;
}

const outOf = (root) => join(root, 'dist', 'extension');
const run = (root, options = {}) => buildExtension({ root, out: outOf(root), ...options });
const expectedFiles = (files) => [...Object.keys(files).filter((path) => path.startsWith('extension/') && path !== 'extension/manifest.json' && !path.startsWith('extension/_locales/')
  && !path.split('/').some((segment) => segment.startsWith('.'))),
  ...LANGUAGES.map((language) => `_locales/${language}/messages.json`), 'manifest.json', 'styles.css',
  ...['16', '32', '48', '128'].map((size) => `icons/icon-${size}.png`), ...EXPECTED_APP].sort();

/** A key-shaped string is never spelled out in this file (tests/privacy.test.mjs scans it): pieces are joined at runtime. */
const fakeGoogleKey = () => ['AI', 'za', 'B'.repeat(30)].join('');
const fakeSkKey = () => ['s', 'k-', 'a'.repeat(24)].join('');
const fakeTokenKey = () => ['gh', 'p_', 'C'.repeat(36)].join('');
const fakePemKey = () => ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join('');
const fakePersonalKey = (suffix = '') => `synthetic-${'x'.repeat(24)}${suffix}`;

async function keyFile(t, ...lines) {
  const directory = await tempDir(t, 'interp-extkey-');
  const path = join(directory, 'keys.txt');
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

// ---------------------------------------------------------------------------------------------------
// exports and vocabulary
// ---------------------------------------------------------------------------------------------------

test('exports: the frozen sorted permission list, the fixed constants and every code of section 10.7', () => {
  assert.equal(Object.isFrozen(build.ALLOWED_PERMISSIONS), true);
  assert.equal(build.ALLOWED_PERMISSIONS.length, 8);
  assert.deepEqual([...build.ALLOWED_PERMISSIONS], [...build.ALLOWED_PERMISSIONS].sort());
  assert.deepEqual([...build.EXTENSION_PAGES], ['extension/engine/host.html', 'extension/permission/mic-permission.html']);
  assert.equal(Object.isFrozen(build.EXTENSION_PAGES), true);
  assert.equal(build.KEY_SLOT, 'export const BUILTIN_KEYS = Object.freeze([]);');
  assert.equal(build.KEY_FILE, 'extension/lib/builtin-key.js');
  assert.deepEqual([...build.EXTRA_FILES], ['styles.css', 'app/audio/capture-worklet.js', 'app/i18n/ko.json', 'app/i18n/en.json', 'app/i18n/ja.json']);
  const contract = ['EXTENSION_ARGUMENT_INVALID', 'EXTENSION_OUT_INVALID', 'EXTENSION_OUT_EXISTS', 'EXTENSION_SOURCE_MISSING', 'EXTENSION_SOURCE_INVALID',
    'EXTENSION_SOURCE_NAME_INVALID', 'EXTENSION_MANIFEST_INVALID', 'EXTENSION_IMPORT_UNRESOLVED', 'EXTENSION_IMPORT_FORBIDDEN', 'EXTENSION_ICON_INVALID',
    'EXTENSION_KEY_FILE_MISSING', 'EXTENSION_KEY_INVALID', 'EXTENSION_KEY_SLOT_INVALID', 'EXTENSION_SECRET_FOUND', 'EXTENSION_ZIP_UNAVAILABLE', 'EXTENSION_BUILD_FAILED'];
  assert.deepEqual([...build.EXTENSION_CODES].sort(), [...contract].sort());
  assert.equal(Object.isFrozen(build.EXTENSION_CODES), true);
  assert.ok(build.EXTENSION_CODES.every((code) => /^EXTENSION_[A-Z_]+$/.test(code)));
  for (const name of ['buildExtension', 'computeImportClosure', 'lintManifest', 'decodePng', 'encodePng', 'downscale4', 'parseArguments', 'runCli', 'isOwnOutput']) {
    assert.equal(typeof build[name], 'function', name);
  }
});

test('the script is dependency-free, silent and starts with the design-reference header', async () => {
  const source = await readFile(new URL('../scripts/build-extension.mjs', import.meta.url), 'utf8');
  assert.equal(source.split('\n')[0], '// New implementation of docs/extension.md §10; no legacy code is ported.');
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';$/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 5);
  assert.ok(specifiers.every((specifier) => specifier.startsWith('node:') || specifier.startsWith('./')), `no npm dependency: ${specifiers.join(' ')}`);
  assert.doesNotMatch(source, /\bconsole\./);
  // zip is spawned with an argument array through execFile, never through a shell.
  assert.match(source, /execFileAsync\('zip', \['-q', '-r', '-X', zipPath, '\.', '-x', OUTPUT_MARKER\], \{ cwd \}\)/);
  assert.doesNotMatch(source, /\bshell\s*:/);
  assert.doesNotMatch(source, /(?<![.\w])(?:exec|execSync|spawn|spawnSync)\(/);
  assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(source)), false, 'no key-shaped literal');
});

// ---------------------------------------------------------------------------------------------------
// a successful fixture build: layout, bytes, result
// ---------------------------------------------------------------------------------------------------

test('layout: a fixture root builds to the section 3.2 tree, verbatim bytes, and never copies the web app entry or its key slot', async (t) => {
  const files = baseFiles();
  const root = await makeRoot(t, (f) => {
    f['extension/.DS_Store'] = 'junk';
    f['extension/lib/.hidden.js'] = 'export const hidden = 1;\n';
    f['extension/.cache/x.js'] = 'export const cached = 1;\n';
  });
  const result = await run(root);
  const out = outOf(root);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.out, out);
  assert.equal(result.version, '0.1.0');
  assert.equal(result.builtinKeys, 0);
  assert.equal(result.zip, null);
  assert.deepEqual(result.files, await listTree(out), 'the result lists exactly what was written');
  assert.deepEqual(result.files, [...result.files].sort(), 'sorted');
  assert.deepEqual(result.files, expectedFiles(files));
  for (const banned of ['app/main.js', 'app/security/builtin-key.js', 'app/unused.js', 'app/ui/never.js', 'extension/manifest.json', 'extension/_locales', 'extension/.DS_Store', 'extension/lib/.hidden.js']) {
    assert.equal(result.files.some((path) => path === banned || path.startsWith(`${banned}/`)), false, banned);
  }
  assert.equal(result.files.some((path) => path.split('/').some((segment) => segment.startsWith('.'))), false, 'no dotfile is copied');
  // Copy, never transform: every extension, app and root file is byte-identical to its source.
  for (const path of result.files.filter((name) => name.startsWith('extension/') || name.startsWith('app/') || name === 'styles.css')) {
    if (path === 'extension/lib/builtin-key.js') continue;
    assert.deepEqual(await readFile(join(out, path)), await readFile(join(root, path)), path);
  }
  for (const language of LANGUAGES) {
    assert.deepEqual(await readFile(join(out, `_locales/${language}/messages.json`)), await readFile(join(root, `extension/_locales/${language}/messages.json`)));
  }
  // The manifest is re-serialized with two-space indentation and one trailing newline, key order preserved.
  const source = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
  assert.equal(await readFile(join(out, 'manifest.json'), 'utf8'), `${JSON.stringify(source, null, 2)}\n`);
  // The worklet named by `new URL(..., import.meta.url)` sits next to stream-capture.js; the worker script next to worker-timers.js.
  assert.ok(await exists(join(out, 'app/audio/capture-worklet.js')));
  assert.ok(await exists(join(out, 'extension/engine/timer-worker.js')));
  // The three dictionaries come through the fixed extras: their loader uses a template-literal URL the walk cannot follow.
  for (const language of LANGUAGES) assert.ok(await exists(join(out, `app/i18n/${language}.json`)), language);
});

test('layout: the source tree is never modified by a build', async (t) => {
  const root = await makeRoot(t);
  const before = await treeDigest(root);
  await run(root);
  const sourceOnly = { except: (path) => path.startsWith('dist/') };
  assert.deepEqual((await listTree(root)).filter((path) => !path.startsWith('dist/')), Object.keys(baseFiles()).sort());
  assert.equal(await treeDigest(root, sourceOnly), before);
});

test('layout: a default build carries BUILTIN_KEYS = Object.freeze([]) once and no secret-shaped text anywhere', async (t) => {
  const root = await makeRoot(t);
  const result = await run(root);
  const out = outOf(root);
  const keyText = await readFile(join(out, 'extension/lib/builtin-key.js'), 'utf8');
  assert.equal(keyText.split(build.KEY_SLOT).length - 1, 1);
  assert.equal(keyText, KEY_SOURCE);
  for (const path of result.files.filter((name) => /\.(?:js|html|css|json)$/.test(name))) {
    const text = await readFile(join(out, path), 'utf8');
    assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(text)), false, path);
  }
});

test('layout: the default out is <root>/dist/extension', async (t) => {
  const root = await makeRoot(t);
  const result = await buildExtension({ root });
  assert.equal(result.out, join(root, 'dist', 'extension'));
  assert.ok(await exists(join(root, 'dist', 'extension', 'manifest.json')));
});

// ---------------------------------------------------------------------------------------------------
// rebuild semantics and determinism (10.1, 10.2 step 4)
// ---------------------------------------------------------------------------------------------------

test('rebuild: a second build into the same out succeeds without clean and is byte-identical', async (t) => {
  const root = await makeRoot(t);
  const first = await run(root);
  const digest = await treeDigest(outOf(root));
  const second = await run(root);
  assert.deepEqual(second.files, first.files);
  assert.equal(await treeDigest(outOf(root)), digest);
  const third = await run(root, { clean: false });
  assert.equal(third.files.length, first.files.length);
  assert.equal(await treeDigest(outOf(root)), digest);
});

test('rebuild: two builds of one tree into two different outs are byte-identical (determinism)', async (t) => {
  const root = await makeRoot(t);
  const other = await tempDir(t);
  await run(root);
  await buildExtension({ root, out: join(other, 'somewhere') });
  assert.equal(await treeDigest(join(other, 'somewhere')), await treeDigest(outOf(root)));
});

test('rebuild: a stray file in the build\'s own previous output is removed, and a changed source is picked up', async (t) => {
  const root = await makeRoot(t);
  await run(root);
  await put(outOf(root), 'stray.txt', 'left over');
  await put(outOf(root), 'extension/lib/deleted-since.js', 'export const gone = 1;\n');
  await put(root, 'extension/lib/chrome-adapter.js', 'export const adapter = Object.freeze({ changed: true });\n');
  const result = await run(root);
  assert.equal(await exists(join(outOf(root), 'stray.txt')), false);
  assert.equal(result.files.includes('extension/lib/deleted-since.js'), false);
  assert.match(await readFile(join(outOf(root), 'extension/lib/chrome-adapter.js'), 'utf8'), /changed: true/);
});

test('rebuild: an empty existing out directory is simply used', async (t) => {
  const root = await makeRoot(t);
  await mkdir(outOf(root), { recursive: true });
  const result = await run(root);
  assert.ok(result.files.length > 20);
});

test('rebuild: a foreign non-empty directory is refused with EXTENSION_OUT_EXISTS and left untouched, with or without clean', async (t) => {
  const root = await makeRoot(t);
  const foreign = await tempDir(t);
  await put(foreign, 'notes.txt', 'mine');
  await put(foreign, 'nested/keep.bin', 'also mine');
  const digest = await treeDigest(foreign);
  await rejectsWith(buildExtension({ root, out: foreign }), 'EXTENSION_OUT_EXISTS');
  await rejectsWith(buildExtension({ root, out: foreign, clean: true }), 'EXTENSION_OUT_EXISTS');
  assert.equal(await treeDigest(foreign), digest);
});

test('rebuild: a manifest.json that is not the build\'s own does not make a directory replaceable', async (t) => {
  const root = await makeRoot(t);
  for (const manifest of [{ name: 'Some other extension', default_locale: 'en' }, { name: '__MSG_extName__', default_locale: 'ko' }, '{ not json']) {
    const foreign = await tempDir(t);
    await put(foreign, 'manifest.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    await rejectsWith(buildExtension({ root, out: foreign }), 'EXTENSION_OUT_EXISTS');
    assert.equal(await exists(join(foreign, 'manifest.json')), true);
  }
});

test('rebuild: a half-written directory inside dist/ is replaced only with clean', async (t) => {
  const root = await makeRoot(t);
  await put(outOf(root), 'half-written/x.js', 'partial');
  await rejectsWith(run(root), 'EXTENSION_OUT_EXISTS');
  assert.equal(await exists(join(outOf(root), 'half-written/x.js')), true, 'untouched by the refusal');
  const result = await run(root, { clean: true });
  assert.equal(await exists(join(outOf(root), 'half-written')), false);
  assert.ok(result.files.includes('manifest.json'));
});

test('rebuild: isOwnOutput recognizes exactly a previous build and nothing else', async (t) => {
  const root = await makeRoot(t);
  assert.equal(await isOwnOutput(outOf(root)), false, 'absent');
  await run(root);
  assert.equal(await isOwnOutput(outOf(root)), true);
  assert.equal(await isOwnOutput(root), false, 'the source root has no manifest.json at its top');
  const link = await tempDir(t);
  await symlink(join(outOf(root), 'manifest.json'), join(link, 'manifest.json'));
  assert.equal(await isOwnOutput(link), false, 'a symlinked manifest is not trusted');
});

test('rebuild: a refused build leaves the previous own output byte-identical (nothing is deleted before everything is read)', async (t) => {
  const root = await makeRoot(t);
  await run(root);
  const digest = await treeDigest(outOf(root));
  await put(root, 'icons/icon-512.png', Buffer.from('not a png'));
  await rejectsWith(run(root), 'EXTENSION_ICON_INVALID');
  assert.equal(await treeDigest(outOf(root)), digest);
  await put(root, 'icons/icon-512.png', ICONS[512]);
  await put(root, 'extension/lib/chrome-adapter.js', `export const leaked = '${fakeGoogleKey()}';\n`);
  await rejectsWith(run(root), 'EXTENSION_SECRET_FOUND');
  assert.equal(await treeDigest(outOf(root)), digest);
});

// ---------------------------------------------------------------------------------------------------
// refusals: out
// ---------------------------------------------------------------------------------------------------

test('EXTENSION_OUT_INVALID: the repo root, its ancestors, its source folders and dist itself are never valid outs', async (t) => {
  const root = await makeRoot(t);
  const before = await treeDigest(root);
  const invalid = [root, dirname(root), join(root, 'app', 'build'), join(root, 'extension', 'out'), join(root, 'out'), join(root, 'dist'), join(root, 'app'), '', null, 42, false];
  for (const out of invalid) await rejectsWith(buildExtension({ root, out }), 'EXTENSION_OUT_INVALID');
  assert.equal(await treeDigest(root), before, 'nothing was written or removed');
  assert.equal(await exists(join(root, 'dist')), false);
});

test('EXTENSION_OUT_INVALID: out is a symlink, a file, or reaches dist/ through a link', async (t) => {
  const root = await makeRoot(t);
  const elsewhere = await tempDir(t);
  await mkdir(join(elsewhere, 'real'), { recursive: true });
  await symlink(join(elsewhere, 'real'), join(elsewhere, 'link'));
  await rejectsWith(buildExtension({ root, out: join(elsewhere, 'link') }), 'EXTENSION_OUT_INVALID');
  await put(elsewhere, 'a-file', 'x');
  await rejectsWith(buildExtension({ root, out: join(elsewhere, 'a-file') }), 'EXTENSION_OUT_INVALID');
  // out inside dist/ that is a link, a file, or below a linked dist/
  await mkdir(join(root, 'dist'), { recursive: true });
  await symlink(join(elsewhere, 'real'), join(root, 'dist', 'extension'));
  await rejectsWith(run(root), 'EXTENSION_OUT_INVALID');
  await rm(join(root, 'dist', 'extension'));
  await put(root, 'dist/extension', 'a file where the folder should be');
  await rejectsWith(run(root), 'EXTENSION_OUT_INVALID');
  await rm(join(root, 'dist'), { recursive: true });
  await symlink(join(elsewhere, 'real'), join(root, 'dist'));
  await rejectsWith(run(root), 'EXTENSION_OUT_INVALID');
  assert.deepEqual(await listTree(join(elsewhere, 'real')), [], 'nothing was written through a link');
});

test('EXTENSION_OUT_INVALID: a keyed build may only write inside <root>/dist/, and that is checked before the key file is read', async (t) => {
  const root = await makeRoot(t);
  const elsewhere = await tempDir(t);
  const path = await keyFile(t, fakePersonalKey());
  await rejectsWith(buildExtension({ root, out: join(elsewhere, 'keyed'), builtinKeyFile: path }), 'EXTENSION_OUT_INVALID');
  await rejectsWith(buildExtension({ root, out: join(elsewhere, 'keyed'), builtinKeyFile: join(elsewhere, 'no-such-file') }), 'EXTENSION_OUT_INVALID');
  await rejectsWith(buildExtension({ root, out: join(root, 'app', 'keyed'), builtinKeyFile: path }), 'EXTENSION_OUT_INVALID');
  assert.equal(await exists(join(elsewhere, 'keyed')), false);
});

test('an unkeyed build may write outside the repository (a temp folder), which is how the real-repo build is tested', async (t) => {
  const root = await makeRoot(t);
  const elsewhere = await tempDir(t);
  const result = await buildExtension({ root, out: join(elsewhere, 'nested', 'ext') });
  assert.equal(result.out, join(elsewhere, 'nested', 'ext'));
  assert.ok(await exists(join(elsewhere, 'nested', 'ext', 'manifest.json')));
});

// ---------------------------------------------------------------------------------------------------
// refusals: sources
// ---------------------------------------------------------------------------------------------------

test('EXTENSION_SOURCE_MISSING: each required source', async (t) => {
  const required = ['extension/manifest.json', 'styles.css', 'icons/favicon-16.png', 'icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png',
    'extension/_locales/en/messages.json', 'extension/_locales/ja/messages.json', 'app/i18n/ko.json',
    'extension/engine/host.html', 'extension/permission/mic-permission.html'];
  for (const path of required) {
    const root = await makeRoot(t, (files) => { delete files[path]; });
    await rejectsWith(run(root), 'EXTENSION_SOURCE_MISSING', path);
    assert.equal(await exists(join(root, 'dist')), false, `${path}: nothing written`);
  }
  // The worklet is a fixed extra and stream-capture.js also names it through new URL(): either way its absence
  // is a missing required source, whether or not the reference is there.
  const referenced = await makeRoot(t, (files) => { delete files['app/audio/capture-worklet.js']; });
  await rejectsWith(run(referenced), 'EXTENSION_SOURCE_MISSING');
  const unreferenced = await makeRoot(t, (files) => { delete files['app/audio/capture-worklet.js']; files['app/audio/stream-capture.js'] = 'export const none = 1;\n'; });
  await rejectsWith(run(unreferenced), 'EXTENSION_SOURCE_MISSING');
  const noExtension = await makeRoot(t, (files) => { for (const key of Object.keys(files)) if (key.startsWith('extension/')) delete files[key]; });
  await rejectsWith(run(noExtension), 'EXTENSION_SOURCE_MISSING');
});

test('EXTENSION_SOURCE_INVALID: links, odd file types and linked required sources', async (t) => {
  const cases = {
    'a symlinked module under extension/': async (root) => symlink('./chrome-adapter.js', join(root, 'extension/lib/linked.js')),
    'a symlinked directory under extension/': async (root) => symlink('../lib', join(root, 'extension/linked-dir')),
    'a markdown file under extension/': async (root) => put(root, 'extension/NOTES.md', '# notes'),
    'a png under extension/': async (root) => put(root, 'extension/lib/logo.png', ICONS[16]),
    'an upper-case extension': async (root) => put(root, 'extension/lib/Upper.JS', 'export const x = 1;\n'),
    'a symlinked styles.css': async (root) => { await rm(join(root, 'styles.css')); await symlink('./app/config.js', join(root, 'styles.css')); },
    'a symlinked icon source': async (root) => { await rm(join(root, 'icons/favicon-16.png')); await symlink('./favicon-32.png', join(root, 'icons/favicon-16.png')); },
    'a symlinked manifest': async (root) => { await rm(join(root, 'extension/manifest.json')); await symlink('./pages.css', join(root, 'extension/manifest.json')); },
    'a directory where an icon source should be': async (root) => { await rm(join(root, 'icons/icon-192.png')); await mkdir(join(root, 'icons/icon-192.png')); },
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const root = await makeRoot(t, () => {}, prepare);
    await rejectsWith(run(root), 'EXTENSION_SOURCE_INVALID');
    assert.equal(await exists(join(root, 'dist')), false, `${label}: nothing written`);
  }
  const linkedRoot = await makeRoot(t, () => {}, async (root) => { await rm(join(root, 'extension'), { recursive: true }); await symlink('../', join(root, 'extension')); });
  await rejectsWith(run(linkedRoot), 'EXTENSION_SOURCE_INVALID');
});

test('EXTENSION_SOURCE_NAME_INVALID: a path segment outside [A-Za-z0-9._-]+, dotfiles excepted (they are never copied)', async (t) => {
  for (const path of ['extension/lib/bad name.js', 'extension/lib/bad$name.js', 'extension/bad dir/x.js', 'extension/lib/naïve.js', 'extension/lib/a(b).js']) {
    const root = await makeRoot(t, (files) => { files[path] = 'export const x = 1;\n'; });
    await rejectsWith(run(root), 'EXTENSION_SOURCE_NAME_INVALID');
    assert.equal(await exists(join(root, 'dist')), false, path);
  }
  const root = await makeRoot(t, (files) => { files['extension/lib/.bad name.js'] = 'x'; files['extension/.bad dir/y.js'] = 'y'; });
  const result = await run(root);
  assert.equal(result.files.some((path) => path.includes('bad')), false, 'dotfiles and dot directories are skipped before any name rule');
});

// ---------------------------------------------------------------------------------------------------
// the manifest through the build
// ---------------------------------------------------------------------------------------------------

test('EXTENSION_MANIFEST_INVALID: the lint reasons are attached for programmatic callers and the build writes nothing', async (t) => {
  const mutations = {
    'an extra permission': [(m) => { m.permissions.push('history'); }, 'EXTENSION_MANIFEST_PERMISSIONS'],
    'a popup': [(m) => { m.action.default_popup = 'extension/panel/panel.html'; }, 'EXTENSION_MANIFEST_FORBIDDEN_KEY'],
    'wider content-script matches': [(m) => { m.content_scripts[0].matches = ['<all_urls>']; }, 'EXTENSION_MANIFEST_CONTENT_SCRIPTS'],
    'a missing options page': [(m) => { m.options_ui.page = 'extension/options/gone.html'; }, 'EXTENSION_MANIFEST_PATH_MISSING'],
    'an icon the build does not generate': [(m) => { m.icons[64] = 'icons/icon-64.png'; }, 'EXTENSION_MANIFEST_PATH_MISSING'],
    'a literal name': [(m) => { m.name = 'Literal name'; }, 'EXTENSION_MANIFEST_MESSAGE_REFERENCE'],
    'a version with a leading zero': [(m) => { m.version = '0.01.0'; }, 'EXTENSION_MANIFEST_VERSION'],
    'minimum_chrome_version 115': [(m) => { m.minimum_chrome_version = '115'; }, 'EXTENSION_MANIFEST_MINIMUM_CHROME_VERSION'],
    'a classic service worker': [(m) => { delete m.background.type; }, 'EXTENSION_MANIFEST_BACKGROUND'],
  };
  for (const [label, [mutate, reason]] of Object.entries(mutations)) {
    const root = await makeRoot(t, (files) => { const manifest = JSON.parse(files['extension/manifest.json']); mutate(manifest); files['extension/manifest.json'] = JSON.stringify(manifest); });
    await assert.rejects(run(root), (error) => {
      assert.equal(error.message, 'EXTENSION_MANIFEST_INVALID', label);
      assert.ok(Array.isArray(error.detail.reasons) && error.detail.reasons.includes(reason), `${label}: ${JSON.stringify(error.detail)}`);
      return true;
    });
    assert.equal(await exists(join(root, 'dist')), false, label);
  }
  for (const garbage of ['{ not json', 'null', '[]', '"text"']) {
    const root = await makeRoot(t, (files) => { files['extension/manifest.json'] = garbage; });
    await rejectsWith(run(root), 'EXTENSION_MANIFEST_INVALID');
  }
});

test('EXTENSION_MANIFEST_INVALID: a _locales table the manifest points into but that lacks the name, or is not an object', async (t) => {
  const missingName = await makeRoot(t, (files) => { const table = messageTable('ko'); delete table.commandOpen; files['extension/_locales/ko/messages.json'] = JSON.stringify(table); });
  await rejectsWith(run(missingName), 'EXTENSION_MANIFEST_INVALID');
  const notObject = await makeRoot(t, (files) => { files['extension/_locales/ja/messages.json'] = '[1, 2]'; });
  await rejectsWith(run(notObject), 'EXTENSION_MANIFEST_INVALID');
  const tooLong = await makeRoot(t, (files) => { const table = messageTable('en'); table.extDescription.message = 'a'.repeat(133); files['extension/_locales/en/messages.json'] = JSON.stringify(table); });
  await rejectsWith(run(tooLong), 'EXTENSION_MANIFEST_INVALID');
});

test('lintManifest: each broken rule reports its own stable reason and the valid fixture reports none', () => {
  const messages = Object.fromEntries(LANGUAGES.map((language) => [language, messageTable(language)]));
  const known = new Set(['extension/background/service-worker.js', 'extension/panel/panel.html', 'extension/options/options.html', 'extension/overlay/overlay.js',
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png', ...LANGUAGES.map((language) => `extension/_locales/${language}/messages.json`)]);
  const lint = (mutate = () => {}) => {
    const manifest = structuredClone(MANIFEST);
    mutate(manifest);
    return lintManifest(manifest, { fileExists: (path) => known.has(path), messages });
  };
  assert.deepEqual(lint(), []);
  assert.deepEqual(lint((m) => { m.manifest_version = 2; }), ['EXTENSION_MANIFEST_MANIFEST_VERSION']);
  assert.deepEqual(lint((m) => { m.version = '0.0.0'; }), ['EXTENSION_MANIFEST_VERSION']);
  assert.deepEqual(lint((m) => { m.version = '65536.0.0'; }), ['EXTENSION_MANIFEST_VERSION']);
  assert.deepEqual(lint((m) => { m.minimum_chrome_version = 116; }), ['EXTENSION_MANIFEST_MINIMUM_CHROME_VERSION']);
  assert.deepEqual(lint((m) => { m.default_locale = 'ko'; }), ['EXTENSION_MANIFEST_DEFAULT_LOCALE']);
  assert.deepEqual(lint((m) => { m.permissions = [...m.permissions, 'tabs']; }), ['EXTENSION_MANIFEST_PERMISSIONS']);
  assert.deepEqual(lint((m) => { m.host_permissions = []; }), ['EXTENSION_MANIFEST_FORBIDDEN_KEY']);
  assert.deepEqual(lint((m) => { m.content_scripts[0].run_at = 'document_start'; }), ['EXTENSION_MANIFEST_CONTENT_SCRIPTS']);
  assert.deepEqual(lint((m) => { m.commands._execute_action.suggested_key.global = 'Ctrl+Shift+Y'; }), ['EXTENSION_MANIFEST_COMMAND']);
  known.delete('extension/_locales/ja/messages.json');
  assert.ok(lint().includes('EXTENSION_MANIFEST_LOCALE_FILE'));
  known.add('extension/_locales/ja/messages.json');
  assert.deepEqual(lintManifest(null), ['EXTENSION_MANIFEST_NOT_OBJECT']);
  assert.deepEqual(lintManifest([]), ['EXTENSION_MANIFEST_NOT_OBJECT']);
  assert.ok(lintManifest({}).length > 5, 'every rule of an empty manifest fails');
  // a throwing fileExists is a "no", never an exception
  assert.ok(lintManifest(structuredClone(MANIFEST), { fileExists: () => { throw new Error('boom'); }, messages }).includes('EXTENSION_MANIFEST_BACKGROUND'));
  // the result is a plain array of unique codes
  const many = lintManifest({});
  assert.equal(new Set(many).size, many.length);
});

// ---------------------------------------------------------------------------------------------------
// import closure (10.3, 3.3 R1-R7)
// ---------------------------------------------------------------------------------------------------

async function closureOf(t, files, entries, extra = {}) {
  const root = await tempDir(t);
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  return computeImportClosure({ root, entries, ...extra });
}

test('closure: every static, dynamic and asset form is followed, comments are not, and the result is a sorted app/ subset with the whole graph', async (t) => {
  const result = await closureOf(t, {
    'extension/lib/entry.js': [
      "import def from './b.js';",
      "import { x } from './c.js';",
      "import * as ns from './d.js';",
      "import './e.js';",
      "export * from './f.js';",
      "export { g } from './g.js';",
      'import {',
      '  h,',
      '  i,',
      "} from './h.js';",
      "const late = await import('./i.js');",
      "const asset = new URL('./j.js', import.meta.url);",
      "import data from './data.json' with { type: 'json' };",
      "import { load } from '../../app/i18n/index.js';",
      "// import './commented-line.js';",
      "/* import './commented-block.js'; */",
      "const note = 'not an import: from x';",
    ].join('\n'),
    ...Object.fromEntries('bcdefghij'.split('').map((name) => [`extension/lib/${name}.js`, `export const ${name} = 1;\n`])),
    'extension/lib/data.json': '{}\n',
    'app/i18n/index.js': "import './boot-fallback.js';\nexport const load = 1;\n",
    'app/i18n/boot-fallback.js': 'export const b = 1;\n',
  }, ['extension/lib/entry.js']);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result.files, ['app/i18n/boot-fallback.js', 'app/i18n/index.js']);
  assert.deepEqual(result.graph.get('extension/lib/entry.js'), [
    'app/i18n/index.js', ...'bcdefghij'.split('').map((name) => `extension/lib/${name}.js`), 'extension/lib/data.json'].sort());
  assert.deepEqual(result.graph.get('app/i18n/index.js'), ['app/i18n/boot-fallback.js']);
  assert.deepEqual(result.graph.get('extension/lib/data.json'), []);
  assert.equal(result.graph.has('extension/lib/commented-line.js'), false);
  assert.deepEqual([...result.graph.keys()], [...result.graph.keys()].sort(), 'the graph is sorted');
});

test('closure: a string such as http://*/* followed by a later comment does not hide an import (comments are stripped with a scanner, not two regexps)', async (t) => {
  const result = await closureOf(t, {
    'extension/lib/entry.js': "const pattern = 'http://*/*'; import './real.js'; /* a later block comment */\nconst other = `//${'x'}/*`; // trailing\n",
    'extension/lib/real.js': 'export const real = 1;\n',
  }, ['extension/lib/entry.js']);
  assert.deepEqual(result.graph.get('extension/lib/entry.js'), ['extension/lib/real.js']);
});

test('closure: regular-expression literals and divisions do not confuse the comment scanner', async (t) => {
  const result = await closureOf(t, {
    'extension/lib/entry.js': [
      "export const trim = (text) => text.replace(/\\/*$/, ''); import './after-regex.js'; /* a later block comment */",
      "export const quotes = (text) => text.match(/['\"`]/g); import './after-quotes.js'; // trailing",
      "export const url = (text) => /https?:\\/\\//.test(text); import './after-url.js'; /* another */",
      'const half = total / 2; const ratio = a / b; import "./after-division.js"; /* closing */',
      "const klass = /[/*]/.test(x); import './after-class.js'; /* last */",
      "function f() { return /\\/*/.test(s); } import './after-return.js'; /* end */",
      // an escaped quote does not end the string, so the // inside it is not a comment
      "const escaped = 'it\\'s // still a string'; import './after-escape.js'; /* end */",
      'const doubled = "say \\"//\\" twice"; import "./after-double.js"; /* end */',
      // braces inside a template expression are counted, so a comment inside it is stripped (and never read as an import)
      "const inner = `${ { a: 1 }.a /* import './ghost.js'; */ }//`; import './after-template.js'; /* end */",
      "const nested = `${ `${ { b: 2 }.b }` } // ${ 3 }`; import './after-nested.js'; /* end */",
    ].join('\n'),
    ...Object.fromEntries(['after-regex', 'after-quotes', 'after-url', 'after-division', 'after-class', 'after-return', 'after-escape', 'after-double', 'after-template', 'after-nested']
      .map((name) => [`extension/lib/${name}.js`, 'export const x = 1;\n'])),
  }, ['extension/lib/entry.js']);
  assert.deepEqual(result.graph.get('extension/lib/entry.js'), ['after-class', 'after-division', 'after-double', 'after-escape', 'after-nested', 'after-quotes', 'after-regex',
    'after-return', 'after-template', 'after-url'].map((name) => `extension/lib/${name}.js`));
});

test('closure: a template-literal URL is not followed (its targets are the fixed extras), a literal worker URL is', async (t) => {
  const result = await closureOf(t, {
    'app/i18n/index.js': "export const load = (language) => new URL(`./${language}.json`, import.meta.url);\nexport const worker = new URL('./worker.js', import.meta.url);\n",
    'app/i18n/worker.js': 'self.onmessage = () => {};\n',
    'app/i18n/en.json': '{}\n',
    'extension/lib/i18n.js': "import '../../app/i18n/index.js';\n",
  }, ['extension/lib/i18n.js']);
  assert.deepEqual(result.files, ['app/i18n/index.js', 'app/i18n/worker.js']);
});

test('closure: cycles terminate, entries order does not matter, and the result is deterministic', async (t) => {
  const files = { 'extension/lib/a.js': "import './b.js';\n", 'extension/lib/b.js': "import './a.js';\nimport '../../app/i18n/index.js';\n", 'app/i18n/index.js': 'export const x = 1;\n',
    'extension/lib/c.js': "import './a.js';\n" };
  const one = await closureOf(t, files, ['extension/lib/a.js', 'extension/lib/c.js']);
  const two = await closureOf(t, files, ['extension/lib/c.js', 'extension/lib/a.js', 'extension/lib/a.js']);
  assert.deepEqual([...one.graph], [...two.graph]);
  assert.deepEqual(one.files, ['app/i18n/index.js']);
  assert.deepEqual(one.graph.get('extension/lib/a.js'), ['extension/lib/b.js']);
  assert.deepEqual(one.graph.get('extension/lib/b.js'), ['app/i18n/index.js', 'extension/lib/a.js']);
});

test('closure: HTML roots contribute script and stylesheet references (relative only); comments, inline scripts and other links are ignored', async (t) => {
  const result = await closureOf(t, {
    'extension/panel/panel.html': [
      '<!doctype html><html><head>',
      '<!-- <script type="module" src="./commented.js"></script> -->',
      '<link rel="icon" href="./favicon.png">',
      '<link rel="stylesheet" href="../../styles.css">',
      "<link href='./panel.css' rel='stylesheet'>",
      '<script>const inline = 1;</script>',
      '<script type="module" src="./panel.js"></script>',
      '</head><body></body></html>',
    ].join('\n'),
    'extension/panel/panel.js': "import '../../app/i18n/index.js';\n",
    'extension/panel/panel.css': 'x {}\n',
    'styles.css': 'y {}\n',
    'app/i18n/index.js': 'export const x = 1;\n',
  }, ['extension/panel/panel.html']);
  assert.deepEqual(result.graph.get('extension/panel/panel.html'), ['extension/panel/panel.css', 'extension/panel/panel.js', 'styles.css']);
  assert.deepEqual(result.files, ['app/i18n/index.js']);
});

test('closure: a content script (and everything under extension/overlay/) is a classic script with no module syntax at all', async (t) => {
  const ok = await closureOf(t, { 'extension/overlay/overlay.js': "(function () { 'use strict'; return 1; })();\n" }, ['extension/overlay/overlay.js']);
  assert.deepEqual(ok.graph.get('extension/overlay/overlay.js'), []);
  const bad = {
    'a static import': "import './x.js';\n",
    'an export': 'export const value = 1;\n',
    'a dynamic import': "function f() { return import('./x.js'); }\n",
    'a non-literal dynamic import': 'function f(name) { return import(name); }\n',
    'import.meta': 'const here = import.meta.url;\n',
    'a syntax error': 'function (\n',
  };
  for (const [label, source] of Object.entries(bad)) {
    await rejectsWith(closureOf(t, { 'extension/overlay/overlay.js': source, 'extension/overlay/x.js': 'export const x = 1;\n' }, ['extension/overlay/overlay.js']), 'EXTENSION_IMPORT_FORBIDDEN', label);
  }
  // a content script that lives elsewhere is named through classicScripts
  await rejectsWith(closureOf(t, { 'extension/lib/injected.js': 'export const x = 1;\n' }, ['extension/lib/injected.js'], { classicScripts: ['extension/lib/injected.js'] }), 'EXTENSION_IMPORT_FORBIDDEN');
  const plain = await closureOf(t, { 'extension/lib/injected.js': 'export const x = 1;\n' }, ['extension/lib/injected.js']);
  assert.deepEqual(plain.graph.get('extension/lib/injected.js'), []);
});

test('EXTENSION_IMPORT_UNRESOLVED: bare names, URLs, absolute paths, escapes, missing and non-copyable targets', async (t) => {
  const cases = {
    'a bare specifier': { source: "import 'lodash';\n" },
    'a scoped bare specifier': { source: "import '@scope/pkg/x.js';\n" },
    'a chrome-extension URL': { source: "import 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js';\n" },
    'an http URL': { source: "import 'https://example.test/x.js';\n" },
    'an absolute path': { source: "import '/x.js';\n" },
    'a missing file': { source: "import './nope.js';\n" },
    'a missing dynamic import': { source: "const x = await import('./nope.js');\n" },
    'a missing asset URL': { source: "export const u = new URL('./nope.js', import.meta.url);\n" },
    'a path that escapes the repository': { source: "import '../../../x.js';\n" },
    'a target of the wrong type': { source: "import './notes.txt';\n", extra: { 'extension/lib/notes.txt': 'x' } },
    'an html target': { source: "import './page.html';\n", extra: { 'extension/lib/page.html': '<p>' } },
    'a directory': { source: "import './dir';\n", extra: { 'extension/lib/dir/index.js': 'export const x = 1;\n' } },
    'a directory with a trailing slash': { source: "import './dir/';\n", extra: { 'extension/lib/dir/index.js': 'export const x = 1;\n' } },
    'a dotfile': { source: "import './.hidden.js';\n", extra: { 'extension/lib/.hidden.js': 'export const x = 1;\n' } },
    'a query string': { source: "import './x.js?v=1';\n", extra: { 'extension/lib/x.js': 'export const x = 1;\n' } },
    'the manifest': { source: "import '../manifest.json';\n" },
    'a _locales file': { source: "import '../_locales/en/messages.json';\n", extra: { 'extension/_locales/en/messages.json': '{}' } },
    'a file outside app/ and extension/': { source: "import '../../scripts/tool.js';\n", extra: { 'scripts/tool.js': 'export const x = 1;\n' } },
    'a name outside the safe alphabet': { source: "import './a b.js';\n", extra: { 'extension/lib/a b.js': 'export const x = 1;\n' } },
  };
  for (const [label, { source, extra = {} }] of Object.entries(cases)) {
    await rejectsWith(closureOf(t, { 'extension/lib/entry.js': source, 'extension/manifest.json': '{}', ...extra }, ['extension/lib/entry.js']), 'EXTENSION_IMPORT_UNRESOLVED', label);
  }
  await rejectsWith(closureOf(t, {}, ['extension/lib/missing-entry.js']), 'EXTENSION_IMPORT_UNRESOLVED');
  await rejectsWith(closureOf(t, { 'extension/lib/data.json': '{}' }, ['extension/lib/data.json']), 'EXTENSION_IMPORT_UNRESOLVED', 'a JSON entry is not a root');
  const html = {
    'a remote script': '<script type="module" src="https://example.test/x.js"></script>',
    'a remote stylesheet': '<link rel="stylesheet" href="https://example.test/x.css">',
    'a root-relative script': '<script type="module" src="/x.js"></script>',
    'a missing script': '<script type="module" src="./gone.js"></script>',
    'a missing stylesheet': '<link rel="stylesheet" href="./gone.css">',
    'a script that is really css': '<script type="module" src="./x.css"></script>',
    'a stylesheet that is really js': '<link rel="stylesheet" href="./x.js">',
  };
  for (const [label, tag] of Object.entries(html)) {
    await rejectsWith(closureOf(t, { 'extension/panel/panel.html': page('', tag), 'extension/panel/x.css': 'x {}', 'extension/panel/x.js': 'export const x = 1;\n' }, ['extension/panel/panel.html']), 'EXTENSION_IMPORT_UNRESOLVED', label);
  }
});

test('EXTENSION_IMPORT_UNRESOLVED: a linked target, or a target behind a linked directory, is not a copyable regular file', async (t) => {
  const root = await tempDir(t);
  await put(root, 'extension/lib/entry.js', "import '../../app/i18n/index.js';\n");
  await put(root, 'real/index.js', 'export const x = 1;\n');
  await mkdir(join(root, 'app/i18n'), { recursive: true });
  await symlink('../../real/index.js', join(root, 'app/i18n/index.js'));
  await rejectsWith(computeImportClosure({ root, entries: ['extension/lib/entry.js'] }), 'EXTENSION_IMPORT_UNRESOLVED');
  const linkedDirectory = await tempDir(t);
  await put(linkedDirectory, 'extension/lib/entry.js', "import '../../app/i18n/index.js';\n");
  await put(linkedDirectory, 'real/i18n/index.js', 'export const x = 1;\n');
  await symlink('real', join(linkedDirectory, 'app'));
  await rejectsWith(computeImportClosure({ root: linkedDirectory, entries: ['extension/lib/entry.js'] }), 'EXTENSION_IMPORT_UNRESOLVED');
});

test('EXTENSION_IMPORT_FORBIDDEN: rules R1-R7 of section 3.3 on every edge', async (t) => {
  const app = { 'app/i18n/index.js': 'export const x = 1;\n', 'app/config.js': 'export const x = 1;\n', 'app/engine/sim.js': 'export const x = 1;\n',
    'app/platform.js': 'export const x = 1;\n', 'app/providers/gemini/live-config.js': 'export const x = 1;\n', 'app/engine/listen-state.js': 'export const x = 1;\n',
    'app/security/shared-key.js': 'export const x = 1;\n', 'app/main.js': 'export const x = 1;\n', 'app/security/builtin-key.js': 'export const x = 1;\n',
    'app/i18n/boot-fallback.js': 'export const x = 1;\n', 'extension/lib/x.js': 'export const x = 1;\n', 'extension/panel/x.js': 'export const x = 1;\n',
    'extension/options/x.js': 'export const x = 1;\n', 'extension/engine/x.js': 'export const x = 1;\n', 'extension/background/x.js': 'export const x = 1;\n' };
  const forbidden = {
    'R1 app imports extension': ['app/i18n/index.js', "import '../../extension/lib/x.js';\n"],
    'R1 app imports the web app entry': ['app/i18n/index.js', "import '../main.js';\n"],
    'R1 app imports the web app key slot': ['app/i18n/index.js', "import '../security/builtin-key.js';\n"],
    'R2 background imports app directly': ['extension/background/sw.js', "import '../../app/i18n/index.js';\n"],
    'R2 background imports engine': ['extension/background/sw.js', "import '../engine/x.js';\n"],
    'R4 lib imports an app module outside its list': ['extension/lib/y.js', "import '../../app/config.js';\n"],
    'R4 lib imports the web app entry': ['extension/lib/y.js', "import '../../app/main.js';\n"],
    'R4 lib imports the web app key slot': ['extension/lib/y.js', "import '../../app/security/builtin-key.js';\n"],
    'R4 lib imports a page module': ['extension/lib/y.js', "import '../panel/x.js';\n"],
    'R5 engine imports an app module outside its list': ['extension/engine/y.js', "import '../../app/i18n/index.js';\n"],
    'R5 engine imports the panel': ['extension/engine/y.js', "import '../panel/x.js';\n"],
    'R6 panel imports live-config (options only)': ['extension/panel/y.js', "import '../../app/providers/gemini/live-config.js';\n"],
    'R6 panel imports shared-key (options only)': ['extension/panel/y.js', "import '../../app/security/shared-key.js';\n"],
    'R6 permission imports live-config': ['extension/permission/y.js', "import '../../app/providers/gemini/live-config.js';\n"],
    'R6 panel imports another page directory': ['extension/panel/y.js', "import '../options/x.js';\n"],
    'R6 options imports app modules outside its list': ['extension/options/y.js', "import '../../app/config.js';\n"],
    'an asset URL obeys the same rules': ['extension/background/sw.js', "export const u = new URL('../../app/config.js', import.meta.url);\n"],
    'a dynamic import obeys the same rules': ['extension/background/sw.js', "export const m = () => import('../../app/config.js');\n"],
    'an html page may not load a module outside its rules': ['extension/panel/page.html', page('', '<script type="module" src="../../app/config.js"></script>')],
    'a stylesheet link may not point at app/': ['extension/panel/page.html', page('', '<link rel="stylesheet" href="../../app/i18n/style.css">')],
  };
  for (const [label, [path, source]] of Object.entries(forbidden)) {
    await rejectsWith(closureOf(t, { ...app, 'app/i18n/style.css': 'x {}', [path]: source }, [path]), 'EXTENSION_IMPORT_FORBIDDEN', label);
  }
  const allowed = {
    'lib to app allowlist': ['extension/lib/y.js', ['i18n/index.js', 'i18n/boot-fallback.js', 'providers/gemini/live-config.js', 'engine/listen-state.js', 'security/shared-key.js'].map((name) => `import '../../app/${name}';`).join('\n')],
    'engine to app allowlist': ['extension/engine/y.js', ['config.js', 'engine/sim.js', 'platform.js', 'providers/gemini/live-config.js'].map((name) => `import '../../app/${name}';`).join('\n')],
    'options to its three app modules and lib': ['extension/options/y.js', "import '../../app/i18n/index.js';\nimport '../../app/providers/gemini/live-config.js';\nimport '../../app/security/shared-key.js';\nimport '../lib/x.js';\nimport './x.js';\n"],
    'panel to i18n, lib and its own directory': ['extension/panel/y.js', "import '../../app/i18n/index.js';\nimport '../lib/x.js';\nimport './x.js';\n"],
    'background to lib and its own directory': ['extension/background/y.js', "import '../lib/x.js';\nimport './x.js';\n"],
  };
  for (const [label, [path, source]] of Object.entries(allowed)) {
    const result = await closureOf(t, { ...app, [path]: source }, [path]);
    assert.ok(result.graph.get(path).length >= 2, label);
  }
});

test('EXTENSION_IMPORT_*: reached through the build, an offending module in the fixture tree refuses the build before anything is written', async (t) => {
  const cases = [
    ['extension/lib/settings.js', "import 'lodash';\n", 'EXTENSION_IMPORT_UNRESOLVED'],
    ['extension/lib/settings.js', "import '../../app/config.js';\n", 'EXTENSION_IMPORT_FORBIDDEN'],
    ['extension/overlay/overlay.js', "import '../lib/settings.js';\n", 'EXTENSION_IMPORT_FORBIDDEN'],
    ['app/i18n/index.js', "import '../main.js';\n", 'EXTENSION_IMPORT_FORBIDDEN'],
    ['extension/panel/panel.html', page('', '<script type="module" src="https://example.test/x.js"></script>'), 'EXTENSION_IMPORT_UNRESOLVED'],
  ];
  for (const [path, source, code] of cases) {
    const root = await makeRoot(t, (files) => { files[path] = source; });
    await rejectsWith(run(root), code);
    assert.equal(await exists(join(root, 'dist')), false, path);
  }
  // A content script that lives outside extension/overlay/ is named by the manifest, and is still a classic script.
  const relocate = (source) => (files) => {
    const manifest = JSON.parse(files['extension/manifest.json']);
    manifest.content_scripts[0].js = ['extension/lib/injected.js'];
    files['extension/manifest.json'] = JSON.stringify(manifest);
    files['extension/lib/injected.js'] = source;
  };
  await rejectsWith(run(await makeRoot(t, relocate('export const notClassic = 1;\n'))), 'EXTENSION_IMPORT_FORBIDDEN');
  assert.ok((await run(await makeRoot(t, relocate('(function () { return 1; })();\n')))).files.includes('extension/lib/injected.js'));
  // A module that no entry reaches is still copied, so its imports are still checked (the built tree must be import-closed).
  const orphan = await makeRoot(t, (files) => { files['extension/lib/orphan.js'] = "import '../../app/unused.js';\n"; });
  await rejectsWith(run(orphan), 'EXTENSION_IMPORT_FORBIDDEN');
  const withoutOrphan = await makeRoot(t, (files) => {
    files['extension/options/options.js'] = "import { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';\nexport const options = [LIVE_MODELS];\n";
  });
  assert.equal((await run(withoutOrphan)).files.includes('app/security/shared-key.js'), false, 'nothing else reaches shared-key.js in this tree');
  const reachedOnlyFromAnOrphan = await makeRoot(t, (files) => {
    files['extension/options/options.js'] = "import { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';\nexport const options = [LIVE_MODELS];\n";
    files['extension/lib/orphan.js'] = "import '../../app/security/shared-key.js';\n";
  });
  assert.ok((await run(reachedOnlyFromAnOrphan)).files.includes('app/security/shared-key.js'), 'a module no entry reaches still gets its app imports copied');
});

// ---------------------------------------------------------------------------------------------------
// icons (10.4)
// ---------------------------------------------------------------------------------------------------

test('icons: the four outputs decode with node:zlib, have the right size, valid chunk CRCs, and the 16/32 are byte copies of the favicons', async (t) => {
  const root = await makeRoot(t);
  await run(root);
  const out = outOf(root);
  for (const [name, size] of [['icon-16', 16], ['icon-32', 32], ['icon-48', 48], ['icon-128', 128]]) {
    const bytes = await readFile(join(out, `icons/${name}.png`));
    const image = readPng(bytes);
    assert.equal(image.width, size, name);
    assert.equal(image.height, size, name);
    assert.equal(image.depth, 8);
    assert.equal(image.color, 2);
    assert.equal(image.interlace, 0);
    assert.deepEqual(image.types.filter((type) => type !== 'IDAT'), ['IHDR', 'IEND']);
    assert.ok(image.types.includes('IDAT'));
  }
  assert.deepEqual(await readFile(join(out, 'icons/icon-16.png')), ICONS[16]);
  assert.deepEqual(await readFile(join(out, 'icons/icon-32.png')), ICONS[32]);
});

test('icons: 48 and 128 are the exact rounded 4x4-box means of icon-192 and icon-512 (pixel by pixel, from the pattern, not from the build)', async (t) => {
  const root = await makeRoot(t);
  await run(root);
  for (const [size, source] of [[48, 192], [128, 512]]) {
    const image = readPng(await readFile(join(outOf(root), `icons/icon-${size}.png`)));
    assert.equal(image.rgb.length, size * size * 3);
    let mismatches = 0;
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) for (let channel = 0; channel < 3; channel += 1) {
      if (image.rgb[(y * size + x) * 3 + channel] !== expectedBlockMean(x, y, channel)) mismatches += 1;
    }
    assert.equal(mismatches, 0, `${size}px icon from the ${source}px source`);
  }
  const corner = readPng(await readFile(join(outOf(root), 'icons/icon-48.png')));
  assert.notDeepEqual([...corner.rgb.subarray(0, 12)], new Array(12).fill(corner.rgb[0]), 'not a flat fill: the pattern survived');
});

test('icons: the repository\'s own icons decode, and the build\'s decoder agrees with an independent reader on every pixel', async () => {
  for (const name of ['favicon-16', 'favicon-32', 'icon-192', 'icon-512']) {
    const bytes = await readFile(join(repoRoot, 'icons', `${name}.png`));
    const mine = await decodePng(bytes);
    const reference = readPng(bytes);
    assert.equal(mine.width, reference.width, name);
    assert.equal(mine.height, reference.height, name);
    assert.deepEqual(mine.rgb, reference.rgb, name);
  }
  const big = await decodePng(await readFile(join(repoRoot, 'icons', 'icon-512.png')));
  const small = downscale4(big);
  assert.deepEqual([small.width, small.height], [128, 128]);
  for (const [x, y, channel] of [[0, 0, 0], [5, 9, 1], [64, 64, 2], [127, 127, 0], [31, 100, 1]]) {
    let sum = 0;
    for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 4; dx += 1) sum += big.rgb[((y * 4 + dy) * 512 + x * 4 + dx) * 3 + channel];
    assert.equal(small.rgb[(y * 128 + x) * 3 + channel], Math.round(sum / 16));
  }
});

test('icons: encodePng and decodePng round-trip, the encoder writes filter 0 and a single IHDR-IDAT-IEND chunk sequence', async () => {
  for (const [width, height] of [[1, 1], [3, 5], [16, 16], [37, 11]]) {
    const rgb = new Uint8Array(width * height * 3).map((_, index) => (index * 31 + 7) & 255);
    const bytes = encodePng({ width, height, rgb });
    const decoded = await decodePng(bytes);
    assert.deepEqual([decoded.width, decoded.height], [width, height]);
    assert.deepEqual(decoded.rgb, rgb);
    const reference = readPng(bytes);
    assert.deepEqual(reference.rgb, rgb);
    assert.deepEqual(reference.types, ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual(encodePng({ width, height, rgb }), bytes, 'deterministic');
  }
});

test('icons: decodePng unfilters all five scanline filter types', async () => {
  const image = patternImage(12);
  for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4], [4, 3, 2, 1, 0, 4]]) {
    const decoded = await decodePng(writePng({ ...image, filters }));
    assert.deepEqual(decoded.rgb, image.rgb, `filters ${filters}`);
  }
  // and the test-local writer agrees with the test-local reader, so the check above is not circular
  assert.deepEqual(readPng(writePng({ ...image, filters: [0, 1, 2, 3, 4] })).rgb, image.rgb);
});

test('icons: downscale4 is a rounded mean (half rounds up), checks divisibility by 4 and never invents pixels', () => {
  // sixteen samples per block: eight 255 and eight 0 gives 127.5, which rounds up to 128
  const rgb = new Uint8Array(4 * 4 * 3);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) rgb.fill(y < 2 ? 255 : 0, (y * 4 + x) * 3, (y * 4 + x) * 3 + 3);
  assert.deepEqual([...downscale4({ width: 4, height: 4, rgb }).rgb], [128, 128, 128]);
  const low = new Uint8Array(4 * 4 * 3);
  low.fill(1, 0, 3 * 7); // seven pixels at 1, the other nine at 0: 7/16 rounds to 0
  assert.deepEqual([...downscale4({ width: 4, height: 4, rgb: low }).rgb], [0, 0, 0]);
  const flat = new Uint8Array(8 * 4 * 3).fill(200);
  assert.deepEqual([...downscale4({ width: 8, height: 4, rgb: flat }).rgb], [200, 200, 200, 200, 200, 200]);
  for (const bad of [{ width: 5, height: 4 }, { width: 4, height: 6 }, { width: 2, height: 2 }, { width: 0, height: 0 }, { width: 4.5, height: 4 }]) {
    assert.throws(() => downscale4({ ...bad, rgb: new Uint8Array(Math.max(0, bad.width * bad.height * 3) || 0) }), { message: 'EXTENSION_ICON_INVALID' });
  }
  assert.throws(() => downscale4({ width: 4, height: 4, rgb: new Uint8Array(5) }), { message: 'EXTENSION_ICON_INVALID' });
  assert.throws(() => downscale4({ width: 4, height: 4, rgb: [1, 2, 3] }), { message: 'EXTENSION_ICON_INVALID' });
  assert.throws(() => encodePng({ width: 2, height: 2, rgb: new Uint8Array(3) }), { message: 'EXTENSION_ICON_INVALID' });
  assert.throws(() => encodePng({ width: 0, height: 1, rgb: new Uint8Array(0) }), { message: 'EXTENSION_ICON_INVALID' });
});

test('EXTENSION_ICON_INVALID: decodePng refuses anything but a well-formed 8-bit RGB non-interlaced PNG', async () => {
  const good = encodePng(patternImage(8));
  const ihdrAt = 8 + 8; // signature + chunk length and type
  const withHeader = (edit) => {
    const bytes = Buffer.from(good);
    edit(bytes);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 8 + 8 + 13)), 8 + 8 + 13); // recompute the IHDR CRC so only the field is wrong
    return bytes;
  };
  const idatFlip = Buffer.from(good);
  idatFlip[8 + 25 + 8 + 4] ^= 0xff;
  // CRC field only, data intact: nothing but the CRC check can notice these
  const crcOf = (start) => { const bytes = Buffer.from(good); bytes[start] ^= 0x01; return bytes; };
  const idatLength = good.readUInt32BE(33);
  const idatCrc = 33 + 8 + idatLength;
  const bad = {
    'not a png': Buffer.from('this is not a png at all, just text'),
    'empty': Buffer.alloc(0),
    'a broken signature': Buffer.concat([Buffer.from([0]), good.subarray(1)]),
    'a truncated file': good.subarray(0, good.length - 7),
    'a truncated chunk': good.subarray(0, 40),
    'a flipped IDAT byte (bad CRC)': idatFlip,
    'a wrong IHDR CRC with intact data': crcOf(8 + 8 + 13),
    'a wrong IDAT CRC with intact data': crcOf(idatCrc),
    'a wrong IEND CRC with intact data': crcOf(good.length - 1),
    'trailing bytes after IEND': Buffer.concat([good, Buffer.from([0])]),
    'a missing IEND': good.subarray(0, good.length - 12),
    'RGBA': withHeader((bytes) => { bytes[ihdrAt + 9] = 6; }),
    'grayscale': withHeader((bytes) => { bytes[ihdrAt + 9] = 0; }),
    '16-bit depth': withHeader((bytes) => { bytes[ihdrAt + 8] = 16; }),
    'interlaced': withHeader((bytes) => { bytes[ihdrAt + 12] = 1; }),
    'a filter method other than 0': withHeader((bytes) => { bytes[ihdrAt + 11] = 1; }),
    'a compression method other than 0': withHeader((bytes) => { bytes[ihdrAt + 10] = 1; }),
    'zero width': withHeader((bytes) => bytes.writeUInt32BE(0, ihdrAt)),
    'a height that disagrees with the data': withHeader((bytes) => bytes.writeUInt32BE(9, ihdrAt + 4)),
    'a huge width': withHeader((bytes) => bytes.writeUInt32BE(1 << 20, ihdrAt)),
    'wider than the supported maximum': writePng({ width: 8193, height: 1, rgb: new Uint8Array(8193 * 3), filters: [0] }),
    'taller than the supported maximum': writePng({ width: 1, height: 8193, rgb: new Uint8Array(8193 * 3), filters: [0] }),
    'an IHDR chunk with 14 bytes': Buffer.concat([good.subarray(0, 8), chunkOf('IHDR', Buffer.concat([good.subarray(16, 29), Buffer.from([0])])), good.subarray(33)]),
    'an IHDR chunk with 12 bytes': Buffer.concat([good.subarray(0, 8), chunkOf('IHDR', good.subarray(16, 28)), good.subarray(33)]),
    'a first chunk that is not an IHDR': Buffer.concat([good.subarray(0, 8), chunkOf('tEXt', good.subarray(16, 29)), good.subarray(33)]),
    'an IEND chunk that carries data': Buffer.concat([good.subarray(0, good.length - 12), chunkOf('IEND', Buffer.from([1]))]),
    'a scanline filter type 9': writePng({ ...patternImage(4), filters: [9] }),
    'IDAT that is not zlib': Buffer.concat([good.subarray(0, 8), good.subarray(8, 33), chunkOf('IDAT', Buffer.from('not zlib data')), chunkOf('IEND', Buffer.alloc(0))]),
    'no IDAT': Buffer.concat([good.subarray(0, 33), chunkOf('IEND', Buffer.alloc(0))]),
    'IEND before the data': Buffer.concat([good.subarray(0, 33), chunkOf('IEND', Buffer.alloc(0)), good.subarray(33)]),
    'a second IHDR': Buffer.concat([good.subarray(0, 33), good.subarray(8, 33), good.subarray(33)]),
  };
  for (const [label, bytes] of Object.entries(bad)) {
    await assert.rejects(decodePng(bytes), { message: 'EXTENSION_ICON_INVALID' }, label);
  }
  for (const value of [null, undefined, 'string', 42, {}, []]) await assert.rejects(decodePng(value), { message: 'EXTENSION_ICON_INVALID' });
  assert.deepEqual((await decodePng(new Uint8Array(good))).width, 8, 'a plain Uint8Array is accepted too');
});

test('EXTENSION_ICON_INVALID: the build refuses a source that is not a PNG, the wrong size, not RGB, or corrupt', async (t) => {
  const corrupt = Buffer.from(ICONS[192]);
  corrupt[corrupt.length - 20] ^= 0x55;
  const rgba = Buffer.from(ICONS[192]);
  rgba[8 + 8 + 9] = 6;
  rgba.writeUInt32BE(crc32(rgba.subarray(12, 8 + 8 + 13)), 8 + 8 + 13);
  const cases = {
    'favicon-16 is not a png': ['icons/favicon-16.png', Buffer.from('nope')],
    'favicon-16 is 32 pixels wide': ['icons/favicon-16.png', ICONS[32]],
    'favicon-32 is 16 pixels wide': ['icons/favicon-32.png', ICONS[16]],
    'icon-192 is 512 pixels wide': ['icons/icon-192.png', ICONS[512]],
    'icon-512 is 192 pixels wide': ['icons/icon-512.png', ICONS[192]],
    'icon-192 is not square': ['icons/icon-192.png', encodePng({ width: 192, height: 96, rgb: new Uint8Array(192 * 96 * 3) })],
    'icon-192 has a bad CRC': ['icons/icon-192.png', corrupt],
    'icon-192 is RGBA': ['icons/icon-192.png', rgba],
    'icon-512 is empty': ['icons/icon-512.png', Buffer.alloc(0)],
  };
  for (const [label, [path, bytes]] of Object.entries(cases)) {
    const root = await makeRoot(t, (files) => { files[path] = bytes; });
    await rejectsWith(run(root), 'EXTENSION_ICON_INVALID');
    assert.equal(await exists(join(root, 'dist')), false, label);
  }
});

// ---------------------------------------------------------------------------------------------------
// built-in key (10.6)
// ---------------------------------------------------------------------------------------------------

test('keyed build: the key lands only in the OUTPUT copy of builtin-key.js, verbatim, and nowhere else', async (t) => {
  const root = await makeRoot(t);
  const before = await treeDigest(root);
  // the second key contains regexp replacement patterns on purpose ($& and $1 must survive untouched)
  const first = fakePersonalKey('-one');
  const second = `synthetic-$&-$1-${'y'.repeat(20)}`;
  const path = await keyFile(t, '# personal keys, one per line', '', first, second, `  ${first}  `, '# trailing comment');
  const result = await run(root, { builtinKeyFile: path });
  assert.equal(result.builtinKeys, 2, 'duplicates collapse');
  const out = outOf(root);
  const built = await readFile(join(out, 'extension/lib/builtin-key.js'), 'utf8');
  assert.equal(built, KEY_SOURCE.replace(build.KEY_SLOT, () => `export const BUILTIN_KEYS = Object.freeze(['${first}', '${second}']);`));
  assert.equal(built.includes(build.KEY_SLOT), false);
  // the source file and the whole source tree are untouched
  assert.equal(await readFile(join(root, 'extension/lib/builtin-key.js'), 'utf8'), KEY_SOURCE);
  assert.equal(await treeDigest(root, { except: (name) => name.startsWith('dist/') }), before);
  // no other built file carries either key, in any spelling of its bytes
  for (const name of result.files.filter((file) => file !== 'extension/lib/builtin-key.js')) {
    const bytes = await readFile(join(out, name));
    assert.equal(bytes.includes(first) || bytes.includes(second), false, name);
  }
  // everything else is identical to an unkeyed build
  const plain = await tempDir(t);
  await buildExtension({ root, out: join(plain, 'ext') });
  for (const name of result.files.filter((file) => file !== 'extension/lib/builtin-key.js')) {
    assert.deepEqual(await readFile(join(out, name)), await readFile(join(plain, 'ext', name)), name);
  }
});

test('keyed build: a rebuild without the key file returns to the empty list (the folder is replaced, never patched)', async (t) => {
  const root = await makeRoot(t);
  const path = await keyFile(t, fakePersonalKey());
  await run(root, { builtinKeyFile: path });
  assert.match(await readFile(join(outOf(root), 'extension/lib/builtin-key.js'), 'utf8'), /Object\.freeze\(\['synthetic-/);
  const result = await run(root);
  assert.equal(result.builtinKeys, 0);
  assert.equal(await readFile(join(outOf(root), 'extension/lib/builtin-key.js'), 'utf8'), KEY_SOURCE);
});

test('keyed build: the key file is exempt from the secret scan, and only that file', async (t) => {
  const google = fakeGoogleKey();
  assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(google)), true, 'the fake really is key-shaped');
  const root = await makeRoot(t);
  const path = await keyFile(t, google);
  const result = await run(root, { builtinKeyFile: path });
  assert.equal(result.builtinKeys, 1);
  assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(readFileSync(join(outOf(root), 'extension/lib/builtin-key.js'), 'utf8'))), true, 'the exemption was needed');
  // the same key-shaped text anywhere else still fails the build, keyed or not
  const leaky = await makeRoot(t, (files) => { files['app/config.js'] = `export const leak = '${google}';\n`; });
  await rejectsWith(run(leaky, { builtinKeyFile: path }), 'EXTENSION_SECRET_FOUND');
});

test('keyed build: the zip name gains -keyed, and a keyed build inside dist/ works', async (t) => {
  const root = await makeRoot(t);
  const path = await keyFile(t, fakePersonalKey());
  const calls = [];
  const zipFn = async (call) => { calls.push(call); await writeFile(call.zipPath, 'zip'); };
  const result = await run(root, { builtinKeyFile: path, zip: true, zipFn });
  assert.equal(result.zip, join(root, 'dist', 'interp-extension-0.1.0-keyed.zip'));
  assert.deepEqual(calls, [{ cwd: outOf(root), zipPath: result.zip }]);
});

test('EXTENSION_KEY_FILE_MISSING and EXTENSION_KEY_INVALID: the key file rules of stage-release, under EXTENSION_ codes', async (t) => {
  const root = await makeRoot(t);
  await rejectsWith(run(root, { builtinKeyFile: join(root, 'no-such-key-file.txt') }), 'EXTENSION_KEY_FILE_MISSING');
  const invalid = {
    'only comments and blanks': ['# nothing', '', '   '],
    'a key with a single quote': [`synthetic-'-${'x'.repeat(20)}`],
    'a key with a backslash': [`synthetic-\\-${'x'.repeat(20)}`],
    'a key with a space inside': ['synthetic key with spaces'],
    'a key with a control character': [`synthetic-\u0001-${'x'.repeat(20)}`],
    'a non-ASCII key': [`synthetic-é-${'x'.repeat(20)}`],
    'a 513-character key': ['k'.repeat(513)],
    'one valid and one invalid key': [fakePersonalKey(), `bad'quote-${'x'.repeat(20)}`],
  };
  for (const [label, lines] of Object.entries(invalid)) {
    await rejectsWith(run(root, { builtinKeyFile: await keyFile(t, ...lines) }), 'EXTENSION_KEY_INVALID');
    assert.equal(await exists(join(root, 'dist')), false, label);
  }
  const boundary = await run(root, { builtinKeyFile: await keyFile(t, 'k'.repeat(512)) });
  assert.equal(boundary.builtinKeys, 1, 'a 512-character key is valid');
});

test('EXTENSION_KEY_SLOT_INVALID: the slot must appear exactly once, in keyed and unkeyed builds alike', async (t) => {
  const twice = `${KEY_SOURCE}// again: ${build.KEY_SLOT}\n`;
  const filled = "export const BUILTIN_KEYS = Object.freeze(['a-key-someone-committed']);\n";
  const cases = {
    'the slot appears twice': (files) => { files['extension/lib/builtin-key.js'] = twice; },
    'the slot is missing': (files) => { files['extension/lib/builtin-key.js'] = 'export const BUILTIN_KEYS = [];\n'; },
    'someone filled the list in the source': (files) => { files['extension/lib/builtin-key.js'] = filled; },
    'the slot is reformatted over two lines': (files) => { files['extension/lib/builtin-key.js'] = 'export const BUILTIN_KEYS = Object.freeze(\n  [],\n);\n'; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const root = await makeRoot(t, mutate);
    await rejectsWith(run(root), 'EXTENSION_KEY_SLOT_INVALID');
    await rejectsWith(run(root, { builtinKeyFile: await keyFile(t, fakePersonalKey()) }), 'EXTENSION_KEY_SLOT_INVALID');
    assert.equal(await exists(join(root, 'dist')), false, label);
  }
  // a keyed build needs the file to exist; an unkeyed build of a tree that has no such file is not this build's business
  const noFile = await makeRoot(t, (files) => { delete files['extension/lib/builtin-key.js']; files['extension/lib/settings.js'] = "export const models = 1;\n"; });
  await rejectsWith(run(noFile, { builtinKeyFile: await keyFile(t, fakePersonalKey()) }), 'EXTENSION_KEY_SLOT_INVALID');
  assert.ok((await run(noFile)).files.length > 20);
});

// ---------------------------------------------------------------------------------------------------
// secret scan (10.2 step 7)
// ---------------------------------------------------------------------------------------------------

test('EXTENSION_SECRET_FOUND: key-shaped text in any built text file fails an unkeyed build and writes nothing', async (t) => {
  const shapes = { google: fakeGoogleKey(), sk: fakeSkKey(), token: fakeTokenKey(), pem: fakePemKey() };
  for (const [label, secret] of Object.entries(shapes)) {
    assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(secret)), true, `${label} is key-shaped`);
    const places = {
      'an extension module': (files) => { files['extension/lib/chrome-adapter.js'] = `export const leak = '${secret}';\n`; },
      'a page': (files) => { files['extension/options/options.html'] = page('', `<!-- ${secret} -->`, '<script type="module" src="./options.js"></script>'); },
      'a locale file': (files) => { const table = messageTable('ko'); table.extName.description = secret; files['extension/_locales/ko/messages.json'] = JSON.stringify(table); },
      'a dictionary': (files) => { files['extension/i18n/en.json'] = JSON.stringify({ 'ext.name': secret }); },
      'a copied app module': (files) => { files['app/platform.js'] = `import './audio/stream-capture.js';\nexport const leak = '${secret}';\n`; },
      'styles.css': (files) => { files['styles.css'] = `/* ${secret} */\n`; },
    };
    for (const [where, mutate] of Object.entries(places)) {
      const root = await makeRoot(t, mutate);
      await assert.rejects(run(root), (error) => {
        assert.equal(error.message, 'EXTENSION_SECRET_FOUND', `${label} in ${where}`);
        assert.equal(JSON.stringify(error).includes(secret), false, 'the secret is not echoed');
        assert.equal(String(error.stack).includes(secret), false);
        return true;
      });
      assert.equal(await exists(join(root, 'dist')), false, `${label} in ${where}: nothing was written`);
    }
  }
});

test('EXTENSION_SECRET_FOUND: an unkeyed build exempts nothing, not even the key file (a comment there is still scanned)', async (t) => {
  const commented = await makeRoot(t, (files) => { files['extension/lib/builtin-key.js'] = `// ${fakeGoogleKey()}\n${KEY_SOURCE}`; });
  await rejectsWith(run(commented), 'EXTENSION_SECRET_FOUND');
  assert.equal(await exists(join(commented, 'dist')), false);
});

test('the secret scan reads what is copied, not what merely sits in the repository (an app file outside the closure is not scanned, and neither are images)', async (t) => {
  const root = await makeRoot(t, (files) => { files['app/unused.js'] = `export const leak = '${fakeGoogleKey()}';\n`; });
  const result = await run(root);
  assert.equal(result.files.includes('app/unused.js'), false);
});

// ---------------------------------------------------------------------------------------------------
// zip (10.8): fake zipFn everywhere except one guarded real-zip test
// ---------------------------------------------------------------------------------------------------

test('zip: an injected zipFn receives { cwd: out, zipPath } and the result reports the zip; without the flag it is never called', async (t) => {
  const root = await makeRoot(t);
  const calls = [];
  const zipFn = async (call) => { calls.push({ ...call }); await writeFile(call.zipPath, 'fake zip'); };
  const off = await run(root, { zipFn });
  assert.equal(off.zip, null);
  assert.deepEqual(calls, []);
  const on = await run(root, { zip: true, zipFn });
  assert.equal(on.zip, join(root, 'dist', 'interp-extension-0.1.0.zip'));
  assert.deepEqual(calls, [{ cwd: outOf(root), zipPath: on.zip }]);
  assert.equal(await readFile(on.zip, 'utf8'), 'fake zip');
  assert.equal(await exists(join(outOf(root), 'interp-extension-0.1.0.zip')), false, 'the zip is a sibling of the folder, never inside it');
  assert.equal(on.files.some((name) => name.endsWith('.zip')), false);
});

test('zip: an existing file at exactly the generated name is a build product and is replaced, never appended to', async (t) => {
  const root = await makeRoot(t);
  const zipPath = join(root, 'dist', 'interp-extension-0.1.0.zip');
  await put(root, 'dist/interp-extension-0.1.0.zip', 'stale bytes from an earlier build');
  await put(root, 'dist/other-file.txt', 'a neighbor of the zip');
  const seen = [];
  const zipFn = async ({ zipPath: target }) => { seen.push(await exists(target)); await writeFile(target, 'fresh bytes'); };
  await run(root, { zip: true, zipFn });
  assert.deepEqual(seen, [false], 'the stale file is gone before zip runs (zip would otherwise update it in place)');
  assert.equal(await readFile(zipPath, 'utf8'), 'fresh bytes');
  assert.equal(await readFile(join(root, 'dist', 'other-file.txt'), 'utf8'), 'a neighbor of the zip', 'only the generated name is touched');
  // without --zip an existing zip is left alone
  await run(root);
  assert.equal(await readFile(zipPath, 'utf8'), 'fresh bytes');
});

test('zip: ENOENT (no zip binary) is reported as zip: null and the build still succeeds; any other zip failure is EXTENSION_BUILD_FAILED with the message discarded and no partial zip left', async (t) => {
  const root = await makeRoot(t);
  const missing = Object.assign(new Error('spawn zip ENOENT'), { code: 'ENOENT' });
  const result = await run(root, { zip: true, zipFn: async () => { throw missing; } });
  assert.equal(result.zip, null);
  assert.ok(await exists(join(outOf(root), 'manifest.json')));
  const failing = await makeRoot(t);
  const zipPath = join(failing, 'dist', 'interp-extension-0.1.0.zip');
  await assert.rejects(run(failing, { zip: true, zipFn: async ({ zipPath: target }) => { await writeFile(target, 'partial'); throw new Error('secret path /somewhere/private'); } }), (error) => {
    assert.equal(error.message, 'EXTENSION_BUILD_FAILED');
    assert.equal(String(error.stack).includes('/somewhere/private'), false, 'the original message is discarded');
    return true;
  });
  assert.equal(await exists(zipPath), false, 'a partial zip is removed');
});

test('zip: a directory or a link at the generated zip name refuses the build before anything is written', async (t) => {
  const directory = await makeRoot(t, () => {}, (root) => mkdir(join(root, 'dist', 'interp-extension-0.1.0.zip'), { recursive: true }));
  await rejectsWith(run(directory, { zip: true, zipFn: async () => {} }), 'EXTENSION_OUT_INVALID');
  assert.equal(await exists(outOf(directory)), false);
  const linked = await makeRoot(t, () => {}, async (root) => { await mkdir(join(root, 'dist'), { recursive: true }); await symlink('/nonexistent-target', join(root, 'dist', 'interp-extension-0.1.0.zip')); });
  await rejectsWith(run(linked, { zip: true, zipFn: async () => {} }), 'EXTENSION_OUT_INVALID');
  assert.equal(await exists(outOf(linked)), false);
});

/** PATH scan with fs only, so this file never has to spawn anything but `node scripts/build-extension.mjs`. */
async function zipOnPath() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { await access(join(directory, 'zip'), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}
const zipMissing = (await zipOnPath()) ? false : 'the system zip binary is not on PATH; only the real-zip test is skipped, every zip test with an injected zipFn still ran';

/** Names of the entries of a zip file, read from its central directory (no unzip binary needed). */
function zipEntries(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'end of central directory record');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    names.push(bytes.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return names;
}

test('zip: the real zip binary produces an archive of exactly the built files, and a rebuild does not keep entries of files that are gone', { skip: zipMissing }, async (t) => {
  const root = await makeRoot(t, (files) => { files['extension/lib/soon-gone.js'] = 'export const gone = 1;\n'; });
  const first = await run(root, { zip: true });
  assert.equal(first.zip, join(root, 'dist', 'interp-extension-0.1.0.zip'));
  const before = zipEntries(await readFile(first.zip));
  assert.deepEqual(before.filter((name) => !name.endsWith('/')).sort(), first.files);
  assert.ok(before.includes('extension/lib/soon-gone.js'));
  await rm(join(root, 'extension/lib/soon-gone.js'));
  const second = await run(root, { zip: true });
  const after = zipEntries(await readFile(second.zip));
  assert.equal(after.includes('extension/lib/soon-gone.js'), false, 'no stale entry survives');
  assert.deepEqual(after.filter((name) => !name.endsWith('/')).sort(), second.files);
});

// ---------------------------------------------------------------------------------------------------
// unexpected failures
// ---------------------------------------------------------------------------------------------------

test('EXTENSION_BUILD_FAILED: anything unexpected becomes the one code, with the original message discarded', async (t) => {
  await rejectsWith(buildExtension({ root: { not: 'a path' } }), 'EXTENSION_BUILD_FAILED');
  await rejectsWith(buildExtension(null), 'EXTENSION_BUILD_FAILED');
  await rejectsWith(computeImportClosure({}), 'EXTENSION_BUILD_FAILED');
  const root = await makeRoot(t);
  await assert.rejects(run(root, { zip: true, zipFn: async () => { throw new TypeError('/very/private/path leaked?'); } }), (error) => {
    assert.equal(error.message, 'EXTENSION_BUILD_FAILED');
    assert.equal(error.detail, undefined);
    return true;
  });
  // a thrown lookalike is not trusted either
  await assert.rejects(run(root, { zip: true, zipFn: async () => { throw new Error('EXTENSION_NOT_A_REAL_CODE'); } }), { message: 'EXTENSION_BUILD_FAILED' });
});

// ---------------------------------------------------------------------------------------------------
// CLI: argument parsing, output lines, exit codes
// ---------------------------------------------------------------------------------------------------

test('parseArguments: each flag once; --out and --builtin-key-file take a value; --clean and --zip take none', () => {
  assert.deepEqual({ ...parseArguments([]) }, { out: undefined, clean: false, zip: false, builtinKeyFile: null });
  assert.deepEqual({ ...parseArguments(['--out', 'x', '--clean', '--zip', '--builtin-key-file', 'k.txt']) }, { out: 'x', clean: true, zip: true, builtinKeyFile: 'k.txt' });
  assert.deepEqual({ ...parseArguments(['--zip', '--clean']) }, { out: undefined, clean: true, zip: true, builtinKeyFile: null });
  assert.equal(Object.isFrozen(parseArguments([])), true);
  const invalid = {
    'an unknown flag': ['--bogus'],
    'a positional argument': ['dist'],
    'an unknown flag after valid ones': ['--out', 'x', '--verbose'],
    'a duplicate --out': ['--out', 'a', '--out', 'b'],
    'a duplicate --clean': ['--clean', '--clean'],
    'a duplicate --zip': ['--zip', '--zip'],
    'a duplicate --builtin-key-file': ['--builtin-key-file', 'a', '--builtin-key-file', 'b'],
    '--out without a value': ['--out'],
    '--builtin-key-file without a value': ['--builtin-key-file'],
    '--out followed by another flag': ['--out', '--clean'],
    '--builtin-key-file followed by another flag': ['--builtin-key-file', '--zip'],
    'an empty value': ['--out', ''],
    'a boolean flag with a value': ['--clean', 'yes'],
    'a boolean flag with an equals value': ['--zip=1'],
    'an equals value for a value flag': ['--out=dist'],
    'a short flag': ['-o', 'x'],
    'a help flag': ['--help'],
    'a non-array': 'text',
  };
  for (const [label, args] of Object.entries(invalid)) {
    assert.throws(() => parseArguments(args), (error) => error.message === 'EXTENSION_ARGUMENT_INVALID', label);
  }
  assert.throws(() => parseArguments(undefined), { message: 'EXTENSION_ARGUMENT_INVALID' });
});

function capture() {
  const out = { text: '', write(chunk) { this.text += chunk; return true; } };
  const err = { text: '', write(chunk) { this.text += chunk; return true; } };
  return { out, err };
}

test('runCli: the success lines are exactly EXTENSION_BUILT, then EXTENSION_BUILTIN_KEY, then EXTENSION_ZIP, and the exit code is 0', async () => {
  const seen = [];
  const fake = (result) => async (options) => { seen.push({ ...options }); return Object.freeze({ files: ['a', 'b', 'c'], version: '0.1.0', out: '/abs/out', builtinKeys: 0, zip: null, ...result }); };
  let io = capture();
  assert.equal(await runCli([], { stdout: io.out, stderr: io.err, build: fake({}) }), 0);
  assert.equal(io.out.text, 'EXTENSION_BUILT out=/abs/out files=3 version=0.1.0\n');
  assert.equal(io.err.text, '');
  io = capture();
  assert.equal(await runCli(['--zip', '--builtin-key-file', 'k.txt', '--out', 'somewhere', '--clean'], {
    stdout: io.out, stderr: io.err, build: fake({ builtinKeys: 2, zip: '/abs/dist/interp-extension-0.1.0-keyed.zip' }),
  }), 0);
  assert.equal(io.out.text, 'EXTENSION_BUILT out=/abs/out files=3 version=0.1.0\nEXTENSION_BUILTIN_KEY keys=2\nEXTENSION_ZIP name=interp-extension-0.1.0-keyed.zip\n');
  assert.deepEqual(seen.at(-1), { out: 'somewhere', clean: true, zip: true, builtinKeyFile: 'k.txt' });
  io = capture();
  assert.equal(await runCli(['--zip'], { stdout: io.out, stderr: io.err, build: fake({ zip: null }) }), 0);
  assert.equal(io.out.text, 'EXTENSION_BUILT out=/abs/out files=3 version=0.1.0\nEXTENSION_ZIP_UNAVAILABLE\n', 'a skipped zip is reported and is still exit 0');
  io = capture();
  await runCli([], { stdout: io.out, stderr: io.err, build: fake({ zip: null }) });
  assert.doesNotMatch(io.out.text, /ZIP/, 'no zip line without the flag');
});

test('runCli: a failure prints exactly one EXTENSION_ code on stderr, nothing on stdout, exit code 1; unknown errors become EXTENSION_BUILD_FAILED', async () => {
  const cases = [
    [new Error('EXTENSION_OUT_EXISTS'), 'EXTENSION_OUT_EXISTS'],
    [Object.assign(new Error('EXTENSION_MANIFEST_INVALID'), { detail: { reasons: ['EXTENSION_MANIFEST_PERMISSIONS'] } }), 'EXTENSION_MANIFEST_INVALID'],
    [new Error('ENOENT: no such file /secret/path'), 'EXTENSION_BUILD_FAILED'],
    [new Error('extension_out_exists'), 'EXTENSION_BUILD_FAILED'],
    [{ message: 42 }, 'EXTENSION_BUILD_FAILED'],
    [null, 'EXTENSION_BUILD_FAILED'],
  ];
  for (const [error, code] of cases) {
    const io = capture();
    assert.equal(await runCli([], { stdout: io.out, stderr: io.err, build: async () => { throw error; } }), 1);
    assert.equal(io.out.text, '');
    assert.equal(io.err.text, `${code}\n`);
  }
  let called = false;
  const io = capture();
  assert.equal(await runCli(['--bogus'], { stdout: io.out, stderr: io.err, build: async () => { called = true; } }), 1);
  assert.equal(called, false, 'argument errors stop before any build');
  assert.equal(io.err.text, 'EXTENSION_ARGUMENT_INVALID\n');
  assert.equal(io.out.text, '');
});

test('runCli over a fixture root: a real build prints the counts, a keyed build announces itself and no output stream ever carries a key', async (t) => {
  const root = await makeRoot(t);
  const first = fakePersonalKey('-cli-one');
  const second = fakePersonalKey('-cli-two');
  const path = await keyFile(t, first, second);
  const over = (extra = {}) => async (options) => buildExtension({ ...options, root, ...extra });
  let io = capture();
  assert.equal(await runCli([], { stdout: io.out, stderr: io.err, build: over() }), 0);
  const files = (await listTree(outOf(root))).length;
  assert.equal(io.out.text, `EXTENSION_BUILT out=${outOf(root)} files=${files} version=0.1.0\n`);
  io = capture();
  const zipFn = async ({ zipPath }) => { await writeFile(zipPath, 'zip'); };
  assert.equal(await runCli(['--builtin-key-file', path, '--zip', '--clean'], { stdout: io.out, stderr: io.err, build: over({ zipFn }) }), 0);
  assert.equal(io.out.text, `EXTENSION_BUILT out=${outOf(root)} files=${files} version=0.1.0\nEXTENSION_BUILTIN_KEY keys=2\nEXTENSION_ZIP name=interp-extension-0.1.0-keyed.zip\n`);
  for (const text of [io.out.text, io.err.text]) assert.equal(text.includes(first) || text.includes(second) || text.includes('synthetic-'), false, 'no key on any stream');
  // and a refusal of a keyed build prints only its code
  io = capture();
  assert.equal(await runCli(['--builtin-key-file', path, '--out', join(root, 'app', 'x')], { stdout: io.out, stderr: io.err, build: over() }), 1);
  assert.equal(io.err.text, 'EXTENSION_OUT_INVALID\n');
  assert.equal(io.out.text, '');
});

test('the CLI as a child process: argument errors print one code on stderr, exit 1, and build nothing (the only child run this file makes)', async (t) => {
  const elsewhere = await tempDir(t);
  const target = join(elsewhere, 'must-not-exist');
  const invalid = [
    ['--bogus'],
    ['--out', target, '--bogus'],
    ['--out', target, '--out', target],
    ['--out', target, '--clean', '--clean'],
    ['--out', target, '--clean', 'yes'],
    ['--out', target, '--zip=1'],
    ['--out', target, '--builtin-key-file'],
    ['--out'],
    ['--out', '--zip'],
    ['positional', '--out', target],
  ];
  for (const args of invalid) {
    const child = spawnSync(process.execPath, [join('scripts', 'build-extension.mjs'), ...args], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(child.status, 1, args.join(' '));
    assert.equal(child.stderr, 'EXTENSION_ARGUMENT_INVALID\n', args.join(' '));
    assert.equal(child.stdout, '', args.join(' '));
    assert.equal(await exists(target), false, `${args.join(' ')} built nothing`);
  }
});

// ---------------------------------------------------------------------------------------------------
// ownership marker and resolved-path checks (verification round, 2026-09-29)
// ---------------------------------------------------------------------------------------------------

test('ownership: another extension project with the same i18n manifest fingerprint is never wiped', async (t) => {
  const root = await makeRoot(t);
  const project = await tempDir(t, 'interp-extbuild-other-');
  await put(project, 'manifest.json', JSON.stringify({ manifest_version: 3, name: '__MSG_extName__', default_locale: 'en', version: '2.3.0' }));
  await put(project, '.git/HEAD', 'ref: refs/heads/main\n');
  await put(project, 'README.md', '# someone else\n');
  await put(project, 'src/background.js', 'export const mine = 1;\n');
  await put(project, '_locales/en/messages.json', '{"extName":{"message":"Other"}}');
  const digest = await treeDigest(project);
  await rejectsWith(buildExtension({ root, out: project }), 'EXTENSION_OUT_EXISTS');
  await rejectsWith(buildExtension({ root, out: project, clean: true }), 'EXTENSION_OUT_EXISTS');
  assert.equal(await treeDigest(project), digest, 'every file of the other project is still there, byte for byte');
  assert.equal(await isOwnOutput(project), false);
  assert.equal(await isOwnOutput(project, { legacy: true }), true, 'the legacy fingerprint matches, which is exactly why it is honoured only inside dist/');
});

test('ownership: every build writes the marker, a build outside dist/ can be rebuilt, and a marker with other text is not trusted', async (t) => {
  const root = await makeRoot(t);
  const result = await run(root);
  assert.equal(await readFile(join(outOf(root), OUTPUT_MARKER), 'utf8'), 'interp-extension-build/1\n');
  assert.equal(result.files.includes(OUTPUT_MARKER), false, 'metadata, not extension content');
  const elsewhere = join(await tempDir(t), 'out');
  const first = await buildExtension({ root, out: elsewhere });
  await put(elsewhere, 'stray.txt', 'left over');
  const second = await buildExtension({ root, out: elsewhere });
  assert.deepEqual(second.files, first.files);
  assert.equal(await exists(join(elsewhere, 'stray.txt')), false, 'its own previous output is replaced');
  const forged = await tempDir(t);
  await put(forged, OUTPUT_MARKER, 'something else\n');
  await put(forged, 'keep.txt', 'mine');
  await rejectsWith(buildExtension({ root, out: forged }), 'EXTENSION_OUT_EXISTS');
  assert.equal(await exists(join(forged, 'keep.txt')), true);
});

test('ownership: a build made before the marker existed is replaced once inside dist/, never elsewhere', async (t) => {
  const root = await makeRoot(t);
  const legacyManifest = JSON.stringify({ manifest_version: 3, name: '__MSG_extName__', default_locale: 'en', version: '0.1.0' });
  await put(outOf(root), 'manifest.json', legacyManifest);
  await put(outOf(root), 'extension/lib/old.js', 'export const old = 1;\n');
  const result = await run(root);
  assert.equal(await exists(join(outOf(root), 'extension/lib/old.js')), false);
  assert.equal(await exists(join(outOf(root), OUTPUT_MARKER)), true, 'from now on the marker proves ownership');
  assert.ok(result.files.includes('manifest.json'));
  const outside = await tempDir(t);
  await put(outside, 'manifest.json', legacyManifest);
  await rejectsWith(buildExtension({ root, out: outside }), 'EXTENSION_OUT_EXISTS');
});

test('EXTENSION_OUT_INVALID: a symlinked ancestor or the resolved spelling of the root cannot reach app/, scripts/ or tests/', async (t) => {
  const root = await makeRoot(t);
  const before = await treeDigest(root, { except: (path) => path.startsWith('dist/') });
  const links = await tempDir(t);
  await symlink(root, join(links, 'alias'));
  for (const out of [join(links, 'alias', 'app', 'evil'), join(links, 'alias', 'scripts', 'evil'), join(links, 'alias', 'tests', 'evil')]) {
    await rejectsWith(buildExtension({ root, out }), 'EXTENSION_OUT_INVALID', out);
  }
  // The root through its resolved spelling (macOS: /var -> /private/var) is the same folder.
  const { realpath } = await import('node:fs/promises');
  const realRoot = await realpath(root);
  if (realRoot !== root) await rejectsWith(buildExtension({ root, out: join(realRoot, 'app', 'evil') }), 'EXTENSION_OUT_INVALID', 'resolved spelling');
  // A case-insensitive disk (APFS default) reaches the same folder with other letter case.
  const upper = join(dirname(root), basename(root).toUpperCase());
  if (upper !== root && await exists(upper)) await rejectsWith(buildExtension({ root, out: join(upper, 'app', 'evil') }), 'EXTENSION_OUT_INVALID', 'letter case');
  assert.equal(await treeDigest(root, { except: (path) => path.startsWith('dist/') }), before, 'nothing was written into the source tree');
  // The legitimate out inside dist/ still works through the alias.
  const ok = await buildExtension({ root, out: join(links, 'alias', 'dist', 'extension') });
  assert.ok(ok.files.includes('manifest.json'));
});
