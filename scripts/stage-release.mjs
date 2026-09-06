// Release packaging (design-v0.6 §13.1-13.2): copy the explicit allowlist of
// static files into <out>/releases/<id>/ and (re)write the root entry files.
// This is a copy step, not a build: no code is transformed beyond rewriting
// the versioned paths in index.html, the RELEASE line and CSP connect-src.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Matches the version accepted by the settings view (app.version, P1-16).
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const RELEASES_DIRECTORY = 'releases';
export const RELEASE_MANIFEST = 'release.json';
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// Root-level files: the entry (rewritten), the worker (rewritten), headers,
// and the install assets that must sit next to index.html (P1-17 scope).
export const ENTRY_FILE = 'index.html';
export const WORKER_FILE = 'sw.js';
export const HEADERS_FILE = '_headers';
export const MANIFEST_FILES = Object.freeze(SUPPORTED_LANGUAGES.map((language) => `manifest.${language}.webmanifest`));
export const ICON_FILES = Object.freeze(['icons/icon-192.png', 'icons/icon-512.png', 'icons/qr-site.png']);
export const ROOT_COPIED_FILES = Object.freeze([HEADERS_FILE, ...MANIFEST_FILES, ...ICON_FILES]);
export const ROOT_FILES = Object.freeze([ENTRY_FILE, WORKER_FILE, ...ROOT_COPIED_FILES]);

// Versioned files live under releases/<id>/: the stylesheet and the app
// modules plus the i18n dictionaries loaded by app/i18n/index.js.
export const STYLES_FILE = 'styles.css';
export const APP_DIRECTORY = 'app';
export const I18N_DIRECTORY = 'app/i18n';
export function isVersionedPath(path) {
  if (path === STYLES_FILE) return true;
  if (!path.startsWith(`${APP_DIRECTORY}/`)) return false;
  if (path.endsWith('.js')) return true;
  return path.endsWith('.json') && posix.dirname(path) === I18N_DIRECTORY;
}

const RELEASE_LINE = /^const RELEASE = (\{.*\}); \/\/ @release$/m;

function fail(code) { return new Error(code); }

async function assertRegularFile(path) {
  let stat;
  try { stat = await lstat(path); } catch { throw fail('RELEASE_SOURCE_MISSING'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail('RELEASE_SOURCE_INVALID');
}

// Enumerate versioned sources under app/ (sorted, dotfiles and symlinks skipped).
async function collectAppFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && isVersionedPath(path)) {
        if (!SAFE_PATH.test(path)) throw fail('RELEASE_SOURCE_NAME_INVALID');
        files.push(path);
      }
    }
  }
  await walk(join(root, APP_DIRECTORY));
  return files.sort();
}

/** Versioned source paths (relative, POSIX) for a project root. */
export async function collectVersionedFiles(root = projectRoot) {
  await assertRegularFile(join(root, STYLES_FILE));
  return [STYLES_FILE, ...await collectAppFiles(root)];
}

/** Rewrite the RELEASE line of sw.js; the marker must appear exactly once. */
export function applyRelease(source, { id, shell }) {
  if (typeof id !== 'string' || !RELEASE_ID_PATTERN.test(id) || !Array.isArray(shell)) throw fail('RELEASE_ID_INVALID');
  const matches = source.match(new RegExp(RELEASE_LINE.source, 'gm')) ?? [];
  if (matches.length !== 1) throw fail('RELEASE_SW_MARKER_MISSING');
  const line = `const RELEASE = ${JSON.stringify({ id, shell: [...shell] })}; // @release`;
  return source.replace(RELEASE_LINE, () => line);
}

/** Parse the RELEASE line back out of a (staged or repository) sw.js. */
export function readRelease(source) {
  const match = source.match(RELEASE_LINE);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

/** Point every versioned href/src of the entry HTML at releases/<id>/. */
export function rewriteEntry(html, id) {
  if (typeof id !== 'string' || !RELEASE_ID_PATTERN.test(id)) throw fail('RELEASE_ID_INVALID');
  return html.replace(/\b(href|src)=(["'])\.\/([^"'?#]+)([^"']*)\2/g, (whole, attribute, quote, path, suffix) => (
    isVersionedPath(path) ? `${attribute}=${quote}./${RELEASES_DIRECTORY}/${id}/${path}${suffix}${quote}` : whole
  ));
}

/** Shell URLs (relative to the worker) precached for a release. */
export function shellFor(id, versionedFiles) {
  return ['./', ...MANIFEST_FILES.map((file) => `./${file}`), ...ICON_FILES.map((file) => `./${file}`),
    ...versionedFiles.map((file) => `./${RELEASES_DIRECTORY}/${id}/${file}`)];
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Use the immutable selected release, including when rolling back. */
async function releaseHeaders(template, releaseDir) {
  let origins;
  try {
    const config = await import(pathToFileURL(join(releaseDir, 'app/config.js')).href);
    origins = config.ENDPOINT_ORIGINS;
    if (!Array.isArray(origins) || !origins.length || origins.some((origin) => {
      const url = new URL(origin);
      return !['https:', 'wss:'].includes(url.protocol) || url.origin !== origin
        || url.username || url.password || /[\s;*]/.test(origin);
    })) throw 0;
    // Preserve old minimal releases while checking the product declaration.
    if (config.ENDPOINT_ALLOWLIST !== undefined) {
      if (!Array.isArray(config.ENDPOINT_ALLOWLIST)) throw 0;
      const derived = [...new Set(config.ENDPOINT_ALLOWLIST.map(endpoint => new URL(endpoint).origin))];
      if (derived.length !== new Set(origins).size || derived.some(origin => !origins.includes(origin))) throw 0;
    }
  } catch { throw fail('RELEASE_CONFIG_INVALID'); }
  const policies = template.match(/^\s+Content-Security-Policy:.*$/gm) ?? [];
  if (policies.length !== 1 || (policies[0].match(/\bconnect-src\b/g) ?? []).length !== 1) {
    throw fail('RELEASE_HEADERS_INVALID');
  }
  return template.replace(policies[0], () => policies[0].replace(/\bconnect-src\s+[^;\r\n]*/,
    () => `connect-src 'self' ${[...new Set(origins)].join(' ')}`));
}

async function writeRootFiles({ root, out, id, versionedFiles }) {
  const headers = await releaseHeaders(await readFile(join(root, HEADERS_FILE), 'utf8'),
    join(out, RELEASES_DIRECTORY, id));
  const written = [];
  const entry = rewriteEntry(await readFile(join(root, ENTRY_FILE), 'utf8'), id);
  if (/\b(?:href|src)=(["'])\.\/(?:app\/|styles\.css)/.test(entry)) throw fail('RELEASE_ENTRY_INVALID');
  await writeFile(join(out, ENTRY_FILE), entry);
  written.push(ENTRY_FILE);
  const worker = applyRelease(await readFile(join(root, WORKER_FILE), 'utf8'), { id, shell: shellFor(id, versionedFiles) });
  await writeFile(join(out, WORKER_FILE), worker);
  written.push(WORKER_FILE);
  for (const file of ROOT_COPIED_FILES) {
    const source = join(root, file);
    await assertRegularFile(source);
    await mkdir(dirname(join(out, file)), { recursive: true });
    await writeFile(join(out, file), file === HEADERS_FILE ? headers : await readFile(source));
    written.push(file);
  }
  return written;
}

// True when `out` is the project root or an ancestor of it.
function containsRoot(outPath, rootPath) {
  const between = relative(outPath, rootPath);
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

function validateTargets({ id, root, out }) {
  if (typeof id !== 'string' || !RELEASE_ID_PATTERN.test(id)) throw fail('RELEASE_ID_INVALID');
  if (typeof out !== 'string' || !out) throw fail('RELEASE_OUT_INVALID');
  const rootPath = resolve(root);
  const outPath = resolve(out);
  // The output must not be the project itself nor contain it; the entry
  // files would otherwise overwrite their own templates.
  if (containsRoot(outPath, rootPath)) throw fail('RELEASE_OUT_INVALID');
  return { rootPath, outPath };
}

/**
 * stageRelease({ id, out, root? }) copies the allowlisted files of `root`
 * into `out/releases/<id>/`, writes `release.json` with SHA-256 digests and
 * then rewrites the root entry files so they point at that release. Existing
 * release directories are never overwritten or removed (§13.2): staging the
 * same id twice fails with RELEASE_EXISTS.
 */
export async function stageRelease({ id, out, root = projectRoot, now = () => new Date() } = {}) {
  const { rootPath, outPath } = validateTargets({ id, root, out });
  for (const file of [ENTRY_FILE, WORKER_FILE, ...ROOT_COPIED_FILES]) await assertRegularFile(join(rootPath, file));
  const releaseDir = join(outPath, RELEASES_DIRECTORY, id);
  let exists = true;
  try { await lstat(releaseDir); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) throw fail('RELEASE_EXISTS');
  const versionedFiles = await collectVersionedFiles(rootPath);
  const digests = {};
  for (const file of versionedFiles) {
    const source = join(rootPath, file);
    await assertRegularFile(source);
    const bytes = await readFile(source);
    await mkdir(dirname(join(releaseDir, file)), { recursive: true });
    await writeFile(join(releaseDir, file), bytes);
    digests[file] = sha256(bytes);
  }
  const manifest = { id, createdAt: now().toISOString(), files: digests };
  await writeFile(join(releaseDir, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  const rootFiles = await writeRootFiles({ root: rootPath, out: outPath, id, versionedFiles });
  return Object.freeze({
    id, out: outPath,
    files: [...versionedFiles.map((file) => `${RELEASES_DIRECTORY}/${id}/${file}`), `${RELEASES_DIRECTORY}/${id}/${RELEASE_MANIFEST}`, ...rootFiles],
  });
}

/**
 * pointRelease({ id, out, root? }) rewrites only the root entry files so they
 * reference an already staged release (rollback, §13.2 "이전 릴리스를 가리키는
 * 진입 파일로 복구"). Release directories are untouched.
 */
export async function pointRelease({ id, out, root = projectRoot } = {}) {
  const { rootPath, outPath } = validateTargets({ id, root, out });
  const manifestPath = join(outPath, RELEASES_DIRECTORY, id, RELEASE_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw fail('RELEASE_NOT_FOUND'); }
  if (manifest?.id !== id || !manifest.files || typeof manifest.files !== 'object') throw fail('RELEASE_MANIFEST_INVALID');
  const versionedFiles = Object.keys(manifest.files).sort();
  for (const file of versionedFiles) {
    if (!SAFE_PATH.test(file) || !isVersionedPath(file)) throw fail('RELEASE_MANIFEST_INVALID');
    await assertRegularFile(join(outPath, RELEASES_DIRECTORY, id, file));
  }
  const rootFiles = await writeRootFiles({ root: rootPath, out: outPath, id, versionedFiles });
  return Object.freeze({ id, out: outPath, files: rootFiles });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--id', '--out', '--point'].includes(flag) || typeof value !== 'string' || value.startsWith('--')
        || Object.hasOwn(options, flag)) {
      throw fail('RELEASE_ARGUMENT_INVALID');
    }
    options[flag] = value;
  }
  const id = options['--id'];
  const point = options['--point'];
  const out = options['--out'];
  if ((id === undefined) === (point === undefined) || out === undefined) throw fail('RELEASE_ARGUMENT_INVALID');
  return { id: id ?? point, out, point: point !== undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { id, out, point } = parseArguments(process.argv.slice(2));
    const result = point ? await pointRelease({ id, out }) : await stageRelease({ id, out });
    // Fixed codes plus the validated id and counts; never file contents.
    process.stdout.write(`${point ? 'RELEASE_POINTED' : 'RELEASE_STAGED'} id=${result.id} files=${result.files.length}\n`);
  } catch (error) {
    const code = typeof error?.message === 'string' && /^RELEASE_[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_STAGE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
