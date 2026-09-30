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
//     vercel.json                            headers (CORS on latest.json, no-cache, noindex)
//
// The key is written by build-extension.mjs into the OUTPUT copy only; it never touches the source tree. Anyone who
// holds the zip can read the key: the owner accepted that for this release (the same free keys the web app ships).
//
// Usage: node scripts/package-extension.mjs [--builtin-key-file <path>] [--chrome <path>] [--released YYYY-MM-DD]
// stdout gets PACKAGE_* lines; stderr gets one code on failure. Neither ever carries a key.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { access, constants, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { OUTPUT_MARKER, buildExtension } from './build-extension.mjs';
import { LANGS, OSES, SITE, manualFile } from '../extension-site/content.js';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION_FOLDER = 'LiveInterpreter';
export const README_NAME = 'README.txt';
export const SITE_SOURCE_FILES = Object.freeze(['index.html', 'site.css', 'site.js', 'content.js']);
export const SITE_ICONS = Object.freeze(['icon-32.png', 'icon-48.png', 'icon-128.png']);
export const DEFAULT_KEY_FILE = join(homedir(), '.config', 'interp-app', 'builtin-key');
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

/** The update manifest the extension reads. Exactly these four fields, in this order. */
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

const VALUE_FLAGS = Object.freeze({ '--builtin-key-file': 'builtinKeyFile', '--chrome': 'chrome', '--released': 'released' });

/** Each flag at most once, each takes one value. */
export function parseArguments(args) {
  if (!Array.isArray(args)) throw fail('PACKAGE_ARGUMENT_INVALID');
  const options = { builtinKeyFile: DEFAULT_KEY_FILE, chrome: null, released: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!Object.hasOwn(VALUE_FLAGS, flag) || seen.has(flag)) throw fail('PACKAGE_ARGUMENT_INVALID');
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw fail('PACKAGE_ARGUMENT_INVALID');
    seen.add(flag);
    options[VALUE_FLAGS[flag]] = value;
  }
  if (options.released !== null && !/^\d{4}-\d{2}-\d{2}$/.test(options.released)) throw fail('PACKAGE_ARGUMENT_INVALID');
  return Object.freeze(options);
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

export async function packageExtension({ root = projectRoot, builtinKeyFile = DEFAULT_KEY_FILE, chrome = null, released = null, log = () => {} } = {}) {
  const rootPath = resolve(root);
  try { await access(builtinKeyFile, constants.R_OK); } catch { throw fail('PACKAGE_KEY_FILE_MISSING'); }

  const distPath = join(rootPath, 'dist');
  await mkdir(distPath, { recursive: true });
  if ((await lstat(distPath)).isSymbolicLink()) throw fail('PACKAGE_OUT_INVALID');
  const packageDir = await freshDirectory(distPath, 'extension-package');
  const siteDir = await freshDirectory(distPath, 'extension-site');

  // 1. The keyed build. build-extension.mjs refuses a keyed output outside dist/ on its own.
  const extensionOut = join(packageDir, EXTENSION_FOLDER);
  const build = await buildExtension({ root: rootPath, out: extensionOut, clean: true, builtinKeyFile });
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

  // 3. The six manuals, printed from the page itself.
  const chromePath = await findChrome(chrome);
  await mkdir(join(siteDir, 'manuals'), { recursive: true });
  const server = await serveDirectory(siteDir);
  const profile = await mkdtemp(join(tmpdir(), 'live-interpreter-pdf-'));
  try {
    for (const manual of MANUALS) {
      const out = join(siteDir, 'manuals', manual.name);
      const bytes = await renderPdf({ chrome: chromePath, url: printUrl(server.origin, { ...manual, version: build.version, released: date }), out, profile });
      log(`PACKAGE_PDF name=${manual.name} bytes=${bytes}`);
    }
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }

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

  return Object.freeze({ version: build.version, keys: build.builtinKeys, zip: zipPath, entries: entries.length, pdfs: MANUALS.length, site: siteDir, released: date });
}

export async function runCli(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(args);
    const log = (line) => stdout.write(`${line}\n`);
    const result = await packageExtension({ ...options, log });
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
