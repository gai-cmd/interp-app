// Packages the Chrome extension for members (docs/extension-install.md): a KEYED build of the extension, six PDF
// manuals (Windows/Mac x ko/ja/en, printed from the guide page) and the static download site, all under the
// gitignored dist/:
//
//   dist/extension-package/LiveInterpreter   the keyed build (the folder members load; it contains manifest.json)
//   dist/extension-site/                     the deploy root of https://kc-live-interpreter.vercel.app
//     index.html site.css site.js content.js icons/   the guide page (extension-site/ sources + the build's icons)
//     latest.json                            what the extension's update check reads
//     live-interpreter.zip                   LiveInterpreter/ + the six manuals + README.txt, no wrapper folder
//     manuals/Manual-<Windows|Mac>-<KO|JA|EN>.pdf
//     update/<version>/                      the signed update tree the extension's self-update reads (§21):
//       manifest.json manifest.sig files/**    every file of the keyed build, listed with size and sha256, signed
//     vercel.json                            headers (CORS on latest.json and update/, no-cache, noindex)
//
// The key is written by build-extension.mjs into the OUTPUT copy only; it never touches the source tree. Anyone who
// holds the zip can read the key: the owner accepted that for this release (the same free keys the web app ships).
//
// The update tree is signed with the private key in --update-key-file (default ~/.config/interp-app/update-signing-primary.pem,
// never in the repository); a missing, unreadable or unknown key stops the run before dist/ is touched, because a tree the
// installed copies cannot verify is worse than none. --no-update-tree skips the tree on purpose.
//
// Usage: node scripts/package-extension.mjs [--builtin-key-file <path>] [--chrome <path>] [--released YYYY-MM-DD]
//                                           [--update-key-file <path> | --no-update-tree]
// stdout gets PACKAGE_* lines; stderr gets one code on failure. Neither ever carries a key.
import { execFile } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { access, constants, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { OUTPUT_MARKER, buildExtension } from './build-extension.mjs';
import { DEFAULT_UPDATE_KEY_FILE, publicKeyOf, signUpdateManifest } from './update-signing.mjs';
import { UPDATE_PUBLIC_KEYS } from '../extension/lib/update-keys.js';
import { SELF_UPDATE_LIMITS, UPDATE_FORMAT, isSafeUpdatePath, verifyUpdateManifest } from '../extension/lib/self-update.js';
import { LANGS, OSES, SITE, manualFile } from '../extension-site/content.js';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION_FOLDER = 'LiveInterpreter';
export const README_NAME = 'README.txt';
export const SITE_SOURCE_FILES = Object.freeze(['index.html', 'site.css', 'site.js', 'content.js']);
export const SITE_ICONS = Object.freeze(['icon-32.png', 'icon-48.png', 'icon-128.png']);
export const DEFAULT_KEY_FILE = join(homedir(), '.config', 'interp-app', 'builtin-key');
export { DEFAULT_UPDATE_KEY_FILE };
export const UPDATE_DIRECTORY = 'update';
export const UPDATE_MANIFEST_FILE = 'manifest.json';
export const UPDATE_SIGNATURE_FILE = 'manifest.sig';
export const UPDATE_FILES_DIRECTORY = 'files';
export const MANUALS = Object.freeze(OSES.flatMap((os) => LANGS.map((lang) => Object.freeze({ os, lang, name: manualFile(os, lang) }))));
const MANUAL_NAMES = new Set(MANUALS.map((manual) => manual.name));

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

// --- pure helpers (tests/extension-package.test.mjs) -------------------------------------------------------------

/** The update manifest the extension reads. Exactly these four fields, in this order: the update tree's address is derived from the version. */
export function latestJson({ version, released } = {}) {
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(version)) throw fail('PACKAGE_VERSION_INVALID');
  if (typeof released !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(released)) throw fail('PACKAGE_DATE_INVALID');
  return { version, released, download: `${SITE.origin}/${SITE.zip}`, page: `${SITE.origin}/` };
}

/**
 * vercel.json of the download site. Vercel merges every matching rule, so the first one applies to all paths. The CSP
 * goes on the page only: on a PDF response it would also govern Chrome's built-in PDF viewer (object-src 'none').
 */
export function vercelConfig() {
  const header = (key, value) => ({ key, value });
  return {
    headers: [
      {
        source: '/(.*)',
        headers: [header('X-Content-Type-Options', 'nosniff'), header('Referrer-Policy', 'no-referrer'),
          header('X-Robots-Tag', 'noindex, nofollow')],
      },
      { source: '/', headers: [header('Content-Security-Policy', CONTENT_SECURITY_POLICY)] },
      { source: '/index.html', headers: [header('Content-Security-Policy', CONTENT_SECURITY_POLICY)] },
      { source: `/${SITE.latest}`, headers: [header('Access-Control-Allow-Origin', '*'), header('Cache-Control', 'no-cache')] },
      // The extension fetches the update tree from its own origin (no host permission), so it needs CORS; no-cache keeps a
      // republished version from being served half old, half new.
      { source: `/${UPDATE_DIRECTORY}/(.*)`, headers: [header('Access-Control-Allow-Origin', '*'), header('Cache-Control', 'no-cache')] },
      { source: `/${SITE.zip}`, headers: [header('Cache-Control', 'no-cache')] },
      { source: '/manuals/(.*)', headers: [header('Cache-Control', 'no-cache')] },
    ],
  };
}

/** README.txt of the zip: a trilingual pointer to the right manual and folder. UTF-8 with BOM and CRLF for Notepad. */
export function readmeText({ version } = {}) {
  const lines = [
    `Live Interpreter ${version ?? ''}`.trim(),
    `${SITE.origin}/`,
    '',
    '[한국어]',
    `1. 컴퓨터에 맞는 설명서를 여세요. Windows: ${manualFile('win', 'ko')} / Mac: ${manualFile('mac', 'ko')}`,
    `2. Chrome에서 불러올 폴더는 ${EXTENSION_FOLDER} 폴더예요. 그 안의 extension 폴더가 아니에요.`,
    '3. 새 버전과 설명서는 위 주소에 있어요.',
    '',
    '[日本語]',
    `1. お使いのパソコンに合ったマニュアルを開いてください。Windows: ${manualFile('win', 'ja')} / Mac: ${manualFile('mac', 'ja')}`,
    `2. Chrome で読み込むのは ${EXTENSION_FOLDER} フォルダです。その中の extension フォルダではありません。`,
    '3. 新しいバージョンとマニュアルは上のアドレスにあります。',
    '',
    '[English]',
    `1. Open the manual for your computer. Windows: ${manualFile('win', 'en')} / Mac: ${manualFile('mac', 'en')}`,
    `2. In Chrome, load the ${EXTENSION_FOLDER} folder, not the extension folder inside it.`,
    '3. New versions and manuals are at the address above.',
    '',
  ];
  return `﻿${lines.join('\r\n')}`;
}

/**
 * Problems with a zip's entry list (as `unzip -Z1` prints it); [] when the layout is right: the extension folder with
 * its manifest, the six manuals and the README at the top level, nothing else, ASCII names, no junk.
 */
export function checkZipEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry === 'string' && entry !== '');
  const problems = [];
  if (!list.includes(`${EXTENSION_FOLDER}/manifest.json`)) problems.push('MANIFEST_MISSING');
  for (const name of MANUAL_NAMES) if (!list.includes(name)) problems.push(`MANUAL_MISSING ${name}`);
  if (!list.includes(README_NAME)) problems.push('README_MISSING');
  for (const entry of list) {
    const parts = entry.split('/');
    if (!(parts[0] === EXTENSION_FOLDER && parts.length > 1) && entry !== README_NAME && !MANUAL_NAMES.has(entry)) problems.push(`UNEXPECTED ${entry}`);
    if (!/^[\x20-\x7e]+$/.test(entry)) problems.push(`NON_ASCII ${entry}`);
    if (parts.some((part) => part === '.DS_Store' || part === '__MACOSX' || part === OUTPUT_MARKER)) problems.push(`JUNK ${entry}`);
  }
  return problems;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The print URL of one manual on a local server origin. */
export function printUrl(origin, { os, lang, version, released }) {
  const query = new URLSearchParams({ lang, os, print: '1', version, released });
  return `${origin}/?${query}`;
}

const VALUE_FLAGS = Object.freeze({
  '--builtin-key-file': 'builtinKeyFile', '--chrome': 'chrome', '--released': 'released', '--update-key-file': 'updateKeyFile',
});
const NO_UPDATE_TREE = '--no-update-tree';

/** Each flag at most once; every flag takes one value except --no-update-tree, which also excludes --update-key-file. */
export function parseArguments(args) {
  if (!Array.isArray(args)) throw fail('PACKAGE_ARGUMENT_INVALID');
  const options = { builtinKeyFile: DEFAULT_KEY_FILE, chrome: null, released: null, updateKeyFile: DEFAULT_UPDATE_KEY_FILE, updateTree: true };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag) || !(flag === NO_UPDATE_TREE || Object.hasOwn(VALUE_FLAGS, flag))) throw fail('PACKAGE_ARGUMENT_INVALID');
    seen.add(flag);
    if (flag === NO_UPDATE_TREE) { options.updateTree = false; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw fail('PACKAGE_ARGUMENT_INVALID');
    options[VALUE_FLAGS[flag]] = value;
    index += 1;
  }
  // Skipping the tree and naming the key that would sign it contradict each other: refuse rather than guess which was meant.
  if (seen.has(NO_UPDATE_TREE) && seen.has('--update-key-file')) throw fail('PACKAGE_ARGUMENT_INVALID');
  if (options.released !== null && !/^\d{4}-\d{2}-\d{2}$/.test(options.released)) throw fail('PACKAGE_ARGUMENT_INVALID');
  return Object.freeze(options);
}

// --- the signed update tree (docs/extension.md §21) ----------------------------------------------------------------

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
/** A path or code as it may appear on stderr: printable ASCII only, so a hostile file name cannot drive the terminal. */
const printable = (value) => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

/** The files of the zip's extension folder and of the update tree must be the same set: problems for each path in only one, [] when equal. */
export function diffPaths(treePaths, zipPaths) {
  const tree = new Set(treePaths);
  const zip = new Set(zipPaths);
  return [
    ...[...zip].filter((path) => !tree.has(path)).sort().map((path) => `ZIP_ONLY ${printable(path)}`),
    ...[...tree].filter((path) => !zip.has(path)).sort().map((path) => `TREE_ONLY ${printable(path)}`),
  ];
}

/**
 * The signed manifest's exact bytes (2-space JSON, trailing newline, files sorted by path, each with size and sha256).
 * The signature covers these bytes, so the file is written from this string and never re-serialized.
 */
export function updateManifestText({ version, released, files }) {
  const list = [...files].sort(byPath).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  return `${JSON.stringify({ format: UPDATE_FORMAT, version, released, files: list }, null, 2)}\n`;
}

/**
 * Reads the update signing key and returns a signer: { publicKey (SPKI base64), sign(bytes) -> base64 r||s }. The PEM
 * lives only in the signer's closure, so nothing that prints or serializes the signer can show it. Refuses a missing
 * file, an unusable key (not P-256, a public key, encrypted) and a key whose public half the extension does not trust.
 */
export async function createUpdateSigner({ keyFile = DEFAULT_UPDATE_KEY_FILE, publicKeys = UPDATE_PUBLIC_KEYS } = {}) {
  let pem;
  try { pem = await readFile(keyFile, 'utf8'); } catch { throw fail('PACKAGE_UPDATE_KEY_MISSING'); }
  let publicKey;
  try { publicKey = publicKeyOf(pem); } catch { throw fail('PACKAGE_UPDATE_KEY_INVALID'); }
  if (!Array.isArray(publicKeys) || !publicKeys.includes(publicKey)) throw fail('PACKAGE_UPDATE_KEY_UNKNOWN');
  return Object.freeze({ publicKey, sign: (bytes) => signUpdateManifest(bytes, pem) });
}

/**
 * The paths among `paths` that the extension would refuse or that collide: unsafe by the extension's own rule
 * (isSafeUpdatePath), or equal to another path when case is ignored (one file on Windows and macOS), or a file whose parent
 * folder name is also a file. [] when all are fine.
 */
export function unsafeUpdatePaths(paths) {
  const lowered = paths.map((path) => String(path).toLowerCase());
  const counts = new Map();
  for (const path of lowered) counts.set(path, (counts.get(path) ?? 0) + 1);
  const hasFileAsFolder = (path) => {
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length += 1) if (counts.has(parts.slice(0, length).join('/'))) return true;
    return false;
  };
  return paths.filter((path, index) => !isSafeUpdatePath(path) || counts.get(lowered[index]) > 1 || hasFileAsFolder(lowered[index]));
}

/**
 * Every file of the keyed folder as { path, bytes }, sorted by path: what goes into the zip, minus anything starting
 * with a dot (.interp-extension-build, .DS_Store). Only plain files with safe paths (the extension's own rule) and
 * the extension's limits are accepted; a symbolic link or an odd name stops the run instead of being shipped.
 */
export async function collectUpdateFiles(folder) {
  const found = [];
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (entry.isFile()) found.push({ path, absolute: join(directory, entry.name) });
      else throw fail('PACKAGE_UPDATE_PATH_UNSAFE', { name: printable(path) });
    }
  }
  await walk(folder, '');
  const unsafe = unsafeUpdatePaths(found.map((file) => file.path));
  if (unsafe.length) throw fail('PACKAGE_UPDATE_PATH_UNSAFE', { name: printable(unsafe[0]) });
  if (found.length > SELF_UPDATE_LIMITS.maxFiles) throw fail('PACKAGE_UPDATE_TOO_LARGE', { name: 'files' });
  const files = [];
  let total = 0;
  for (const { path, absolute } of found.sort(byPath)) {
    const bytes = await readFile(absolute);
    total += bytes.length;
    if (bytes.length > SELF_UPDATE_LIMITS.maxFileBytes || total > SELF_UPDATE_LIMITS.maxTotalBytes) throw fail('PACKAGE_UPDATE_TOO_LARGE', { name: printable(path) });
    files.push({ path, bytes });
  }
  return files;
}

async function listFiles(root) {
  const paths = [];
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else paths.push(path);
    }
  }
  await walk(root, '');
  return paths;
}

/**
 * Checks a written tree the way an installed extension will: the EXTENSION's verifier (its code, Node's WebCrypto) on the
 * bytes on disk, then every listed file against its signed size and sha256, and no file on disk that is not listed.
 * Returns { files, bytes }; throws PACKAGE_UPDATE_TREE_INVALID with the problems (paths and codes only).
 */
export async function verifyUpdateTree(treeDir, { version, publicKeys = UPDATE_PUBLIC_KEYS, subtle = webcrypto.subtle } = {}) {
  const invalid = (problems) => fail('PACKAGE_UPDATE_TREE_INVALID', { problems: problems.map(printable) });
  let manifest;
  try {
    const manifestBytes = new Uint8Array(await readFile(join(treeDir, UPDATE_MANIFEST_FILE)));
    const signature = (await readFile(join(treeDir, UPDATE_SIGNATURE_FILE), 'utf8')).trim();
    manifest = await verifyUpdateManifest({ manifestBytes, signature, publicKeys, subtle });
  } catch (error) {
    throw invalid([`MANIFEST ${typeof error?.code === 'string' ? error.code : 'UNREADABLE'}`]);
  }
  if (manifest.version !== version) throw invalid(['VERSION_MISMATCH']);
  const problems = [];
  let bytes = 0;
  for (const { path, size, sha256 } of manifest.files) {
    let content;
    try { content = await readFile(join(treeDir, UPDATE_FILES_DIRECTORY, ...path.split('/'))); } catch { problems.push(`MISSING ${path}`); continue; }
    if (content.length !== size) problems.push(`SIZE ${path}`);
    else if (sha256Hex(content) !== sha256) problems.push(`HASH ${path}`);
    bytes += content.length;
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const path of await listFiles(join(treeDir, UPDATE_FILES_DIRECTORY)).catch(() => [])) if (!listed.has(path)) problems.push(`UNLISTED ${path}`);
  if (problems.length) throw invalid(problems);
  return Object.freeze({ files: manifest.files.length, bytes });
}

/**
 * Writes <siteDir>/update/<version>/{manifest.json, manifest.sig, files/**} from the keyed folder and proves the result:
 * the files are read once, listed and hashed in memory, signed, written, then read back and verified like an installed
 * extension would. Nothing is written when the signer is missing, a path is unsafe or a limit is exceeded; the version
 * folder is replaced as a whole so a leftover file of an earlier run can never be listed or shipped by accident.
 */
export async function buildUpdateTree({ extensionDir, siteDir, version, released, signer, publicKeys = UPDATE_PUBLIC_KEYS, subtle = webcrypto.subtle } = {}) {
  latestJson({ version, released });
  if (typeof signer?.sign !== 'function') throw fail('PACKAGE_UPDATE_KEY_MISSING');
  const sources = await collectUpdateFiles(extensionDir);
  const own = sources.find((file) => file.path === UPDATE_MANIFEST_FILE);
  let ownVersion = null;
  try { ownVersion = JSON.parse(own?.bytes.toString('utf8') ?? 'null')?.version ?? null; } catch { /* reported below */ }
  if (ownVersion !== version) throw fail('PACKAGE_UPDATE_TREE_INVALID', { problems: ['MANIFEST_VERSION_MISMATCH'] });

  const manifestText = updateManifestText({ version, released, files: sources.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256Hex(bytes) })) });
  const manifestBytes = Buffer.from(manifestText, 'utf8');
  if (manifestBytes.length > SELF_UPDATE_LIMITS.maxManifestBytes) throw fail('PACKAGE_UPDATE_TOO_LARGE', { name: UPDATE_MANIFEST_FILE });
  const signature = signer.sign(manifestBytes);

  const treeDir = join(siteDir, UPDATE_DIRECTORY, version);
  await rm(treeDir, { recursive: true, force: true });
  for (const { path, bytes } of sources) {
    const target = join(treeDir, UPDATE_FILES_DIRECTORY, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(treeDir, UPDATE_MANIFEST_FILE), manifestBytes);
  await writeFile(join(treeDir, UPDATE_SIGNATURE_FILE), signature);
  let checked;
  try {
    checked = await verifyUpdateTree(treeDir, { version, publicKeys, subtle });
  } catch (error) {
    // A tree that fails its own check must not sit in dist/ looking deployable.
    await rm(treeDir, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ version, files: checked.files, bytes: checked.bytes, dir: treeDir, paths: Object.freeze(sources.map((file) => file.path)) });
}

// --- effects -----------------------------------------------------------------------------------------------------

async function isExecutable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

/** A Chrome that can print to PDF: --chrome, $CHROME_PATH, the newest cached headless shell, then Google Chrome. */
async function findChrome(explicit) {
  const candidates = [explicit, process.env.CHROME_PATH].filter(Boolean);
  for (const cache of [join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')]) {
    const shells = (await readdir(cache).catch(() => []))
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    for (const shell of shells) {
      for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        candidates.push(join(cache, shell, arch, 'chrome-headless-shell'));
      }
    }
  }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate;
  throw fail('PACKAGE_CHROME_MISSING');
}

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf', '.zip': 'application/zip',
});

/** A static server on 127.0.0.1 for printing (module scripts do not load from file: URLs). */
function serveDirectory(directory) {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
      if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => resolveServer({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(() => done())),
    }));
  });
}

async function renderPdf({ chrome, url, out, profile }) {
  const shell = basename(chrome).includes('headless-shell');
  const args = [shell ? '--headless' : '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${profile}`,
    '--no-pdf-header-footer', '--print-to-pdf-no-header', '--virtual-time-budget=15000', `--print-to-pdf=${out}`, url];
  try {
    await execFileAsync(chrome, args, { timeout: 120000 });
  } catch {
    throw fail('PACKAGE_PDF_FAILED', { name: basename(out) });
  }
  const bytes = await readFile(out).catch(() => Buffer.alloc(0));
  if (bytes.length < 10000 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail('PACKAGE_PDF_FAILED', { name: basename(out) });
  return bytes.length;
}

/** Removes and recreates a directory that must sit directly inside <root>/dist. */
async function freshDirectory(distPath, name) {
  const path = join(distPath, name);
  if (dirname(path) !== distPath) throw fail('PACKAGE_OUT_INVALID');
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  return path;
}

/** Step 3 of packageExtension: the six manuals, printed from the page itself. Replaceable in tests (hooks.renderManuals). */
async function renderManuals({ chrome, siteDir, version, released, log }) {
  const chromePath = await findChrome(chrome);
  await mkdir(join(siteDir, 'manuals'), { recursive: true });
  const server = await serveDirectory(siteDir);
  const profile = await mkdtemp(join(tmpdir(), 'live-interpreter-pdf-'));
  try {
    for (const manual of MANUALS) {
      const out = join(siteDir, 'manuals', manual.name);
      const bytes = await renderPdf({ chrome: chromePath, url: printUrl(server.origin, { ...manual, version, released }), out, profile });
      log(`PACKAGE_PDF name=${manual.name} bytes=${bytes}`);
    }
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

/**
 * `hooks` lets a test replace the two steps that need a real build tree or a real Chrome (buildExtension, renderManuals);
 * the CLI never passes it. `updatePublicKeys` is the list the extension trusts: tests inject their throw-away key's.
 */
export async function packageExtension({
  root = projectRoot, builtinKeyFile = DEFAULT_KEY_FILE, chrome = null, released = null, log = () => {},
  updateKeyFile = DEFAULT_UPDATE_KEY_FILE, updateTree = true, updatePublicKeys = UPDATE_PUBLIC_KEYS, hooks = {},
} = {}) {
  const { buildExtension: buildKeyed = buildExtension, renderManuals: render = renderManuals } = hooks;
  const rootPath = resolve(root);
  try { await access(builtinKeyFile, constants.R_OK); } catch { throw fail('PACKAGE_KEY_FILE_MISSING'); }
  // Before dist/ is touched: a run that cannot sign must not leave a half-made site that looks finished.
  const signer = updateTree ? await createUpdateSigner({ keyFile: updateKeyFile, publicKeys: updatePublicKeys }) : null;

  const distPath = join(rootPath, 'dist');
  await mkdir(distPath, { recursive: true });
  if ((await lstat(distPath)).isSymbolicLink()) throw fail('PACKAGE_OUT_INVALID');
  const packageDir = await freshDirectory(distPath, 'extension-package');
  const siteDir = await freshDirectory(distPath, 'extension-site');

  // 1. The keyed build. build-extension.mjs refuses a keyed output outside dist/ on its own.
  const extensionOut = join(packageDir, EXTENSION_FOLDER);
  const build = await buildKeyed({ root: rootPath, out: extensionOut, clean: true, builtinKeyFile });
  if (!(build.builtinKeys > 0)) throw fail('PACKAGE_KEY_REQUIRED');
  log(`PACKAGE_BUILT version=${build.version} keys=${build.builtinKeys} files=${build.files.length}`);
  const date = released ?? localDate();
  const latest = latestJson({ version: build.version, released: date });

  // 2. The site: page sources, the build's icons, latest.json, vercel.json.
  for (const file of SITE_SOURCE_FILES) await copyFile(join(rootPath, 'extension-site', file), join(siteDir, file));
  await mkdir(join(siteDir, 'icons'), { recursive: true });
  for (const icon of SITE_ICONS) await copyFile(join(extensionOut, 'icons', icon), join(siteDir, 'icons', icon));
  await writeFile(join(siteDir, SITE.latest), `${JSON.stringify(latest, null, 2)}\n`);
  await writeFile(join(siteDir, 'vercel.json'), `${JSON.stringify(vercelConfig(), null, 2)}\n`);

  // 2b. The signed update tree, from the same keyed folder the zip is made from.
  let tree = null;
  if (signer) {
    tree = await buildUpdateTree({ extensionDir: extensionOut, siteDir, version: build.version, released: date, signer, publicKeys: updatePublicKeys });
    log(`PACKAGE_UPDATE_TREE version=${tree.version} files=${tree.files} bytes=${tree.bytes}`);
  } else {
    log('PACKAGE_UPDATE_TREE skipped=1');
  }

  // 3. The six manuals.
  await render({ chrome, siteDir, version: build.version, released: date, log });

  // 4. The zip: no wrapper folder, so Extract All / Archive Utility both give one folder named after the zip.
  for (const manual of MANUALS) await copyFile(join(siteDir, 'manuals', manual.name), join(packageDir, manual.name));
  await writeFile(join(packageDir, README_NAME), readmeText({ version: build.version }));
  const zipPath = join(siteDir, SITE.zip);
  try {
    await execFileAsync('zip', ['-q', '-r', '-X', zipPath, EXTENSION_FOLDER, README_NAME, ...MANUALS.map((manual) => manual.name),
      '-x', '*.DS_Store', `${EXTENSION_FOLDER}/${OUTPUT_MARKER}`], { cwd: packageDir });
  } catch {
    throw fail('PACKAGE_ZIP_FAILED');
  }
  const { stdout: listing } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 16 * 1024 * 1024 });
  const entries = listing.split('\n').map((line) => line.trim()).filter(Boolean);
  const problems = checkZipEntries(entries);
  if (problems.length) throw fail('PACKAGE_ZIP_INVALID', { problems });
  // The zipped key slot must be filled; the value itself is never read into a log.
  const { stdout: slot } = await execFileAsync('unzip', ['-p', zipPath, `${EXTENSION_FOLDER}/extension/lib/builtin-key.js`]);
  if (!/export const BUILTIN_KEYS = Object\.freeze\(\['/.test(slot)) throw fail('PACKAGE_KEY_REQUIRED');
  // The tree must list exactly the files the zip carries: otherwise a member who updates would end up with a different
  // folder than one who unzipped.
  if (tree) {
    const prefix = `${EXTENSION_FOLDER}/`;
    const zipped = entries.filter((entry) => entry.startsWith(prefix) && !entry.endsWith('/')).map((entry) => entry.slice(prefix.length));
    const mismatch = diffPaths(tree.paths, zipped);
    if (mismatch.length) throw fail('PACKAGE_UPDATE_TREE_INVALID', { problems: mismatch });
  }

  return Object.freeze({
    version: build.version, keys: build.builtinKeys, zip: zipPath, entries: entries.length, pdfs: MANUALS.length, site: siteDir, released: date,
    updateTree: tree === null ? null : Object.freeze({ version: tree.version, files: tree.files, bytes: tree.bytes, dir: tree.dir }),
  });
}

export async function runCli(args, { stdout = process.stdout, stderr = process.stderr, run = packageExtension } = {}) {
  try {
    const options = parseArguments(args);
    const log = (line) => stdout.write(`${line}\n`);
    const result = await run({ ...options, log });
    log(`PACKAGE_OK version=${result.version} keys=${result.keys} released=${result.released} zip=${result.zip} entries=${result.entries} pdfs=${result.pdfs} site=${result.site}`);
    return 0;
  } catch (error) {
    const code = typeof error?.message === 'string' && /^(?:PACKAGE|EXTENSION)_[A-Z_]+$/.test(error.message) ? error.message : 'PACKAGE_FAILED';
    const extra = error?.detail?.problems ? ` ${error.detail.problems.join(', ')}` : (error?.detail?.name ? ` ${error.detail.name}` : '');
    stderr.write(`${code}${extra}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
