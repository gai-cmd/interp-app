// New implementation of docs/extension.md §10; no legacy code is ported.
//
// The extension build is a COPY step, not a bundler: it validates the manifest, works out which
// files of app/ the extension really imports, writes everything into <out> with the repository
// layout preserved (so one relative specifier resolves the same way in Node tests and in Chrome),
// generates the two icons Chrome needs beyond the repo's favicons, and optionally fills the
// built-in key slot of the OUTPUT copy. No code is transformed anywhere else. Like
// scripts/stage-release.mjs it is dependency-free, prints fixed codes and counts only (never file
// contents, never a key), and refuses anything unexpected instead of guessing.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { SECRET_PATTERNS } from './check-release.mjs';
import { readBuiltinKey } from './stage-release.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

// --- fixed vocabulary (§10.1, §10.5, §10.7) ---

/** The only permissions the manifest may request; adding one needs a contract and test change. */
export const ALLOWED_PERMISSIONS = Object.freeze(['activeTab', 'contextMenus', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabCapture', 'tabs']);
/** Pages that no manifest key names but the service worker opens by URL, so they are closure roots too. */
export const EXTENSION_PAGES = Object.freeze(['extension/engine/host.html', 'extension/permission/mic-permission.html']);
export const KEY_SLOT = 'export const BUILTIN_KEYS = Object.freeze([]);';
export const KEY_FILE = 'extension/lib/builtin-key.js';
/** Copied whatever the import walk finds: template-literal URLs (`./${language}.json`) and the worklet cannot be followed statically. */
export const EXTRA_FILES = Object.freeze(['styles.css', 'app/audio/capture-worklet.js', 'app/i18n/ko.json', 'app/i18n/en.json', 'app/i18n/ja.json']);
export const EXTENSION_CODES = Object.freeze([
  'EXTENSION_ARGUMENT_INVALID', 'EXTENSION_OUT_INVALID', 'EXTENSION_OUT_EXISTS', 'EXTENSION_SOURCE_MISSING', 'EXTENSION_SOURCE_INVALID',
  'EXTENSION_SOURCE_NAME_INVALID', 'EXTENSION_MANIFEST_INVALID', 'EXTENSION_IMPORT_UNRESOLVED', 'EXTENSION_IMPORT_FORBIDDEN',
  'EXTENSION_ICON_INVALID', 'EXTENSION_KEY_FILE_MISSING', 'EXTENSION_KEY_INVALID', 'EXTENSION_KEY_SLOT_INVALID', 'EXTENSION_SECRET_FOUND',
  'EXTENSION_ZIP_UNAVAILABLE', 'EXTENSION_BUILD_FAILED',
]);
const KNOWN_CODES = new Set(EXTENSION_CODES);

const LANGUAGES = Object.freeze(['en', 'ko', 'ja']);
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const SOURCE_TYPES = new Set(['.js', '.html', '.css', '.json']);
const TEXT_TYPES = SOURCE_TYPES;
const IMPORT_TYPES = new Set(['.js', '.json', '.css']);
// The two app files that must never reach an extension: main.js boots the web app and builtin-key.js
// is the web app's key slot (the extension has its own, §10.6).
const FORBIDDEN_APP_FILES = new Set(['app/main.js', 'app/security/builtin-key.js']);

// The generated icon set (§10.4): the favicons are copied byte for byte, the two large icons are
// exact 4x4-box downscales, so the build needs no image library and the result is deterministic.
const ICON_PLAN = Object.freeze([
  Object.freeze({ out: 'icons/icon-16.png', from: 'icons/favicon-16.png', size: 16, scaled: false }),
  Object.freeze({ out: 'icons/icon-32.png', from: 'icons/favicon-32.png', size: 32, scaled: false }),
  Object.freeze({ out: 'icons/icon-48.png', from: 'icons/icon-192.png', size: 192, scaled: true }),
  Object.freeze({ out: 'icons/icon-128.png', from: 'icons/icon-512.png', size: 512, scaled: true }),
]);
const ICON_NAMES = new Set(ICON_PLAN.map((icon) => icon.out));

/** Machine codes only: the message is the code, the optional detail (paths, lint reasons) stays on the object and is never printed. */
function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCode = (error) => typeof error?.message === 'string' && KNOWN_CODES.has(error.message);

// --- lintManifest (§10.5) ---

const MESSAGE_REFERENCE = /^__MSG_([A-Za-z][A-Za-z0-9_]*)__$/;
const VERSION_FORMAT = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;
const CONTENT_MATCHES = Object.freeze(['http://*/*', 'https://*/*']);
const FORBIDDEN_KEYS = Object.freeze(['host_permissions', 'optional_permissions', 'optional_host_permissions', 'web_accessible_resources',
  'externally_connectable', 'content_security_policy', 'incognito']);
const sameList = (left, right) => Array.isArray(left) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const characters = (value) => [...String(value)].length;

/**
 * Returns the EXTENSION_MANIFEST_* reasons the manifest breaks ([] = valid). Pure and total: garbage in gives
 * reasons out, never an exception. `fileExists` takes repo-relative POSIX paths (`extension/...` for sources,
 * `icons/icon-N.png` for the generated icons); `messages` is { en, ko, ja }, the parsed _locales files. Rule R3
 * (no import/export in a content script) needs file contents, so the build checks it while walking imports.
 */
export function lintManifest(manifest, { fileExists = () => false, messages = {} } = {}) {
  if (!isObject(manifest)) return ['EXTENSION_MANIFEST_NOT_OBJECT'];
  const reasons = new Set();
  const flag = (reason) => reasons.add(`EXTENSION_MANIFEST_${reason}`);
  const exists = (path) => typeof path === 'string' && attempt(() => Boolean(fileExists(path))) === true;
  const table = (language) => (isObject(messages?.[language]) ? messages[language] : {});
  const defined = (name) => LANGUAGES.every((language) => Object.hasOwn(table(language), name));

  if (manifest.manifest_version !== 3) flag('MANIFEST_VERSION');
  const version = manifest.version;
  const parts = typeof version === 'string' && VERSION_FORMAT.test(version) ? version.split('.').map(Number) : null;
  if (parts === null || parts.some((part) => part > 65535) || parts.every((part) => part === 0)) flag('VERSION');
  const minimum = manifest.minimum_chrome_version;
  if (typeof minimum !== 'string' || !/^\d+$/.test(minimum) || Number(minimum) < 116) flag('MINIMUM_CHROME_VERSION');
  if (manifest.default_locale !== 'en') flag('DEFAULT_LOCALE');
  if (!LANGUAGES.every((language) => exists(`extension/_locales/${language}/messages.json`))) flag('LOCALE_FILE');

  const commands = isObject(manifest.commands) ? manifest.commands : {};
  const references = [manifest.name, manifest.description, manifest.action?.default_title, ...Object.values(commands).map((command) => command?.description)];
  const referenced = (value) => { const match = MESSAGE_REFERENCE.exec(typeof value === 'string' ? value : ''); return match !== null && defined(match[1]); };
  if (!references.every(referenced)) flag('MESSAGE_REFERENCE');

  const permissions = manifest.permissions;
  // sameList compares lengths too, so a duplicated entry cannot pass for the exact list.
  if (!sameList(permissions, ALLOWED_PERMISSIONS)) flag('PERMISSIONS');
  if (FORBIDDEN_KEYS.some((key) => Object.hasOwn(manifest, key)) || (isObject(manifest.action) && Object.hasOwn(manifest.action, 'default_popup'))) flag('FORBIDDEN_KEY');

  if (!isObject(manifest.background) || manifest.background.type !== 'module' || !exists(manifest.background.service_worker)) flag('BACKGROUND');

  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const paths = [manifest.side_panel?.default_path, manifest.options_ui?.page,
    ...scripts.flatMap((script) => (Array.isArray(script?.js) ? script.js : [undefined])),
    ...Object.values(isObject(manifest.icons) ? manifest.icons : {}), ...Object.values(isObject(manifest.action?.default_icon) ? manifest.action.default_icon : {})];
  if (!paths.every(exists)) flag('PATH_MISSING');
  if (scripts.length === 0 || !scripts.every((script) => isObject(script) && sameList(script.matches, CONTENT_MATCHES)
    && script.all_frames === false && script.run_at === 'document_idle')) flag('CONTENT_SCRIPTS');

  const key = commands._execute_action?.suggested_key;
  if (!isObject(key) || typeof key.default !== 'string' || key.default === '' || Object.hasOwn(key, 'global')) flag('COMMAND');
  const withinLimits = LANGUAGES.every((language) => characters(table(language).extDescription?.message ?? '') <= 132
    && characters(table(language).extName?.message ?? '') <= 45);
  if (!withinLimits) flag('MESSAGE_LIMITS');
  return [...reasons];
}

// --- PNG codec for the icon pipeline (§10.4) ---

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_SIDE = 8192;
const invalidIcon = () => fail('EXTENSION_ICON_INVALID');

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/**
 * Decodes the one PNG shape the repo's own icon generator writes: 8-bit RGB, non-interlaced. The signature and
 * every chunk CRC are verified, and anything else (other bit depth or color type, interlacing, trailing bytes,
 * a missing IEND) is refused, because the build would otherwise copy an icon Chrome may reject.
 */
export async function decodePng(bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) throw invalidIcon();
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw invalidIcon();
    let offset = PNG_SIGNATURE.length;
    let header = null;
    let ended = false;
    const parts = [];
    while (offset < data.length) {
      if (ended || offset + 12 > data.length) throw invalidIcon();
      const length = data.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (length > 0x7fffffff || end > data.length) throw invalidIcon();
      if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) throw invalidIcon();
      const type = data.toString('latin1', offset + 4, offset + 8);
      const body = data.subarray(offset + 8, offset + 8 + length);
      if (header === null) {
        if (type !== 'IHDR' || length !== 13) throw invalidIcon();
        header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], compression: body[10], filter: body[11], interlace: body[12] };
      } else if (type === 'IHDR') throw invalidIcon();
      else if (type === 'IDAT') parts.push(body);
      else if (type === 'IEND') { if (length !== 0) throw invalidIcon(); ended = true; }
      offset = end;
    }
    if (header === null || !ended || parts.length === 0) throw invalidIcon();
    const { width, height } = header;
    if (header.depth !== 8 || header.color !== 2 || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0
      || width < 1 || height < 1 || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) throw invalidIcon();
    const stride = width * 3;
    const expected = height * (stride + 1);
    // maxOutputLength keeps a hostile IDAT from inflating past the size the header promised.
    const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
    if (raw.length !== expected) throw invalidIcon();
    const rgb = new Uint8Array(height * stride);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)];
      const source = y * (stride + 1) + 1;
      const target = y * stride;
      if (filter > 4) throw invalidIcon();
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 3 ? rgb[target + x - 3] : 0;
        const up = y > 0 ? rgb[target - stride + x] : 0;
        const upLeft = x >= 3 && y > 0 ? rgb[target - stride + x - 3] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = (left + up) >> 1;
        else if (filter === 4) predictor = paeth(left, up, upLeft);
        rgb[target + x] = (raw[source + x] + predictor) & 255;
      }
    }
    return Object.freeze({ width, height, rgb });
  } catch (error) {
    throw isCode(error) ? error : invalidIcon();
  }
}

/** Filter type 0 on every scanline, deflate level 9: deterministic for one Node build, and the simplest thing Chrome accepts. */
export function encodePng({ width, height, rgb }) {
  const sized = Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_PNG_SIDE && height <= MAX_PNG_SIDE;
  if (!sized || !(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) throw invalidIcon();
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Each output pixel is the mean of a 4x4 block per channel, rounded half up; both sides must divide by 4 so no edge pixel is invented. */
export function downscale4({ width, height, rgb }) {
  const sized = Number.isInteger(width) && Number.isInteger(height) && width >= 4 && height >= 4 && width % 4 === 0 && height % 4 === 0;
  if (!sized || !(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) throw invalidIcon();
  const outWidth = width / 4;
  const outHeight = height / 4;
  const out = new Uint8Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 4; dx += 1) sum += rgb[((y * 4 + dy) * width + x * 4 + dx) * 3 + channel];
        out[(y * outWidth + x) * 3 + channel] = (sum + 8) >> 4;
      }
    }
  }
  return Object.freeze({ width: outWidth, height: outHeight, rgb: out });
}

// --- source access: lstat everywhere, symlinks and non-regular files are never followed ---

async function lstatKind(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'link';
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/** Classifies a repo-relative path as missing | link | directory | file | other, checking EVERY component so a linked directory cannot smuggle a file in. */
async function inspectPath(root, path, cache) {
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const key = parts.slice(0, index + 1).join('/');
    let kind = cache.get(key);
    if (kind === undefined) {
      kind = await lstatKind(join(root, ...parts.slice(0, index + 1)));
      cache.set(key, kind);
    }
    if (kind === 'missing' || kind === 'link') return kind;
    if (index < parts.length - 1 && kind !== 'directory') return 'missing';
    if (index === parts.length - 1) return kind;
  }
  return 'missing';
}

async function readSource(root, path, cache) {
  const kind = await inspectPath(root, path, cache);
  if (kind === 'missing') throw fail('EXTENSION_SOURCE_MISSING', { path });
  if (kind !== 'file') throw fail('EXTENSION_SOURCE_INVALID', { path });
  return readFile(join(root, ...path.split('/')));
}

/** Every file under extension/ (sorted, POSIX, repo-relative). Dotfiles are skipped, links and odd types refused (§10.2 step 3a). */
async function collectExtensionFiles(root) {
  const base = join(root, 'extension');
  const kind = await lstatKind(base);
  if (kind === 'missing') throw fail('EXTENSION_SOURCE_MISSING', { path: 'extension' });
  if (kind !== 'directory') throw fail('EXTENSION_SOURCE_INVALID', { path: 'extension' });
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw fail('EXTENSION_SOURCE_INVALID', { path });
      if (!SEGMENT.test(entry.name)) throw fail('EXTENSION_SOURCE_NAME_INVALID', { path });
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (entry.isFile() && SOURCE_TYPES.has(posix.extname(entry.name))) files.push(path);
      else throw fail('EXTENSION_SOURCE_INVALID', { path });
    }
  }
  await walk(base, 'extension');
  return files.sort();
}

// --- import closure (§10.3) ---

// After these keywords a `/` opens a regular expression, not a division.
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|yield|await|else|do|new)$/;
function regexMayStart(output) {
  const before = output.slice(-256).trimEnd();
  if (before === '') return true;
  const last = before.at(-1);
  if (last === ')' || last === ']' || last === '}') return false;
  return /[\w$'"`]/.test(last) ? REGEX_KEYWORD.test(before) : true;
}

/**
 * Removes comments without touching string, template or regular-expression literals. The privacy test's
 * two-regexp routine is enough for checking bans, but here a string such as 'http://*\/*' or a regexp such as
 * /\/*$/ followed by a later block comment would make it delete real code, and a missed import silently ships an
 * incomplete extension. A misjudged `/` can only leave a comment in the text, never remove code.
 */
function stripComments(source) {
  let output = '';
  let index = 0;
  let inTemplate = false;
  const expressions = []; // unmatched `{` count of every open `${ ... }`, innermost last
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inTemplate) {
      if (char === '\\') { output += source.slice(index, index + 2); index += 2; continue; }
      if (char === '`') inTemplate = false;
      else if (char === '$' && next === '{') { expressions.push(0); inTemplate = false; output += '${'; index += 2; continue; }
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      output += ' ';
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      output += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && regexMayStart(output)) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n') {
        const current = source[end];
        if (current === '\\') { end += 2; continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        end += 1;
      }
      output += source.slice(index, end + 1);
      index = end + 1;
    } else {
      if (char === '`') inTemplate = true;
      else if (char === '{' && expressions.length) expressions[expressions.length - 1] += 1;
      else if (char === '}' && expressions.length) {
        if (expressions[expressions.length - 1] === 0) { expressions.pop(); inTemplate = true; } else expressions[expressions.length - 1] -= 1;
      }
      output += char;
      index += 1;
    }
  }
  return output;
}

const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const URL_ASSET = /new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;

function scriptReferences(source) {
  const code = stripComments(source);
  const found = [];
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT, URL_ASSET]) {
    for (const match of code.matchAll(pattern)) found.push({ specifier: match[2], kind: 'module' });
  }
  return found;
}

function htmlReferences(source) {
  const found = [];
  for (const tag of source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = new Map();
    for (const attribute of tag[2].matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    if (tag[1].toLowerCase() === 'script') {
      if (attributes.has('src')) found.push({ specifier: attributes.get('src'), kind: 'script' });
    } else if (/(?:^|\s)stylesheet(?:\s|$)/i.test(attributes.get('rel') ?? '') && attributes.has('href')) {
      found.push({ specifier: attributes.get('href'), kind: 'stylesheet' });
    }
  }
  return found;
}

// The app modules each extension area may import (§3.3 R2, R4-R6). Everything not listed is refused.
const LIB_APP = ['app/i18n/index.js', 'app/i18n/boot-fallback.js', 'app/providers/gemini/live-config.js', 'app/engine/listen-state.js', 'app/security/shared-key.js'];
const ENGINE_APP = ['app/config.js', 'app/engine/sim.js', 'app/platform.js', 'app/providers/gemini/live-config.js'];
const PAGE_APP = ['app/i18n/index.js'];
const OPTIONS_APP = ['app/i18n/index.js', 'app/providers/gemini/live-config.js', 'app/security/shared-key.js'];
const AREA_APP = Object.freeze({
  background: [], lib: LIB_APP, engine: ENGINE_APP, panel: PAGE_APP, options: OPTIONS_APP, permission: PAGE_APP,
});

/** True when the edge from -> to is allowed by the import rules; `kind` is module | script | stylesheet. */
function edgeAllowed(from, to, kind) {
  if (FORBIDDEN_APP_FILES.has(to)) return false;
  // R1: app/** never reaches out of app/.
  if (from.startsWith('app/')) return to.startsWith('app/');
  if (!from.startsWith('extension/')) return false;
  if (kind === 'stylesheet') return to === 'styles.css' || to.startsWith('extension/');
  if (to === 'styles.css') return false;
  const area = from.split('/')[1];
  // The extension dictionaries are data the loader reads, not modules, so every extension file may name them.
  if (to.startsWith('extension/')) return to.startsWith('extension/lib/') || to.startsWith('extension/i18n/') || to.startsWith(`extension/${area}/`);
  return Object.hasOwn(AREA_APP, area) && AREA_APP[area].includes(to);
}

function copyableTarget(target, kind) {
  const type = posix.extname(target);
  if (kind === 'script' && type !== '.js') return false;
  if (kind === 'stylesheet' && type !== '.css') return false;
  if (!IMPORT_TYPES.has(type)) return false;
  if (target === 'styles.css') return true;
  if (target.startsWith('app/')) return true;
  // manifest.json and _locales/ are copied to the output ROOT, so no source path may point at them.
  return target.startsWith('extension/') && target !== 'extension/manifest.json' && !target.startsWith('extension/_locales/');
}

function resolveSpecifier(from, specifier, kind) {
  const unresolved = () => fail('EXTENSION_IMPORT_UNRESOLVED', { path: from });
  // R7: bare names, absolute paths, http and chrome-extension: URLs all fail this one test.
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) throw unresolved();
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target) || !SAFE_PATH.test(target)
    || target.split('/').some((segment) => segment.startsWith('.')) || !copyableTarget(target, kind)) throw unresolved();
  return target;
}

/**
 * Walks the imports of `entries` (repo-relative .js/.html files) and returns the app/ subset the extension needs
 * plus the whole graph (path -> sorted dependencies). Comments are ignored; only string-literal specifiers are
 * followed. Classic scripts (content scripts and everything under extension/overlay/) may contain no module
 * syntax at all (R3): a script that fails to compile as a classic script is refused.
 */
export async function computeImportClosure(options = {}) {
  try {
    return await walkImports(options);
  } catch (error) {
    throw isCode(error) ? error : fail('EXTENSION_BUILD_FAILED');
  }
}

async function walkImports({ root, entries, classicScripts = [] }) {
  const rootPath = resolve(root);
  const cache = new Map();
  const classic = new Set(classicScripts);
  const graph = new Map();
  const pending = [...new Set(entries)].sort();
  for (const entry of pending) {
    if (typeof entry !== 'string' || !SAFE_PATH.test(entry) || !['.js', '.html'].includes(posix.extname(entry))) throw fail('EXTENSION_IMPORT_UNRESOLVED', { path: String(entry) });
  }
  while (pending.length) {
    const path = pending.shift();
    if (graph.has(path)) continue;
    if (await inspectPath(rootPath, path, cache) !== 'file') throw fail('EXTENSION_IMPORT_UNRESOLVED', { path });
    const type = posix.extname(path);
    const references = [];
    if (type === '.js' || type === '.html') {
      const source = (await readFile(join(rootPath, ...path.split('/')))).toString('utf8');
      if (type === '.js' && (classic.has(path) || path.startsWith('extension/overlay/'))) {
        if (attempt(() => new Script(source)) === undefined || /\bimport\s*\(/.test(stripComments(source))) throw fail('EXTENSION_IMPORT_FORBIDDEN', { path });
      }
      references.push(...(type === '.html' ? htmlReferences(source) : scriptReferences(source)));
    }
    const dependencies = new Set();
    for (const { specifier, kind } of references) {
      const target = resolveSpecifier(path, specifier, kind);
      if (!edgeAllowed(path, target, kind)) throw fail('EXTENSION_IMPORT_FORBIDDEN', { path });
      if (await inspectPath(rootPath, target, cache) !== 'file') throw fail('EXTENSION_IMPORT_UNRESOLVED', { path });
      dependencies.add(target);
      if (!graph.has(target) && !pending.includes(target)) pending.push(target);
    }
    graph.set(path, [...dependencies].sort());
  }
  const sorted = new Map([...graph].sort(([left], [right]) => (left < right ? -1 : 1)));
  return Object.freeze({ files: [...sorted.keys()].filter((path) => path.startsWith('app/')), graph: sorted });
}

// --- targets and rebuild semantics (§10.1, §10.2 step 4, §10.7) ---

function containsRoot(outPath, rootPath) {
  const between = relative(outPath, rootPath);
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}
/** True when `path` is strictly inside `base`. */
function isInside(base, path) {
  const between = relative(base, path);
  return between !== '' && between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between);
}

async function validateTargets({ rootPath, out, keyed }) {
  if (typeof out !== 'string' || out === '') throw fail('EXTENSION_OUT_INVALID');
  const outPath = resolve(out);
  const distPath = join(rootPath, 'dist');
  // The output must not be the project or an ancestor of it; the copy would overwrite its own inputs.
  if (containsRoot(outPath, rootPath)) throw fail('EXTENSION_OUT_INVALID');
  const insideDist = isInside(distPath, outPath);
  // Inside the repo only the gitignored dist/ may be written; a keyed build carries a secret, so it may go nowhere else.
  if ((isInside(rootPath, outPath) && !insideDist) || (keyed && !insideDist)) throw fail('EXTENSION_OUT_INVALID');
  // No link on the way down: a dist -> elsewhere link would make "inside dist" a lie.
  const chain = insideDist ? relative(rootPath, outPath).split(sep) : [];
  let current = rootPath;
  for (const segment of chain) {
    current = join(current, segment);
    const kind = await lstatKind(current);
    if (kind === 'missing') break;
    if (kind !== 'directory') throw fail('EXTENSION_OUT_INVALID');
  }
  if (!insideDist) {
    const kind = await lstatKind(outPath);
    if (kind === 'link' || (kind !== 'missing' && kind !== 'directory')) throw fail('EXTENSION_OUT_INVALID');
  }
  return { outPath, insideDist };
}

/** True when `out` holds a previous build of this script: the manifest's own two fingerprints (§10.2 step 4). */
export async function isOwnOutput(out) {
  try {
    const path = join(out, 'manifest.json');
    if (await lstatKind(path) !== 'file') return false;
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    return isObject(manifest) && manifest.name === '__MSG_extName__' && manifest.default_locale === 'en';
  } catch { return false; }
}

async function prepareOut({ outPath, clean, insideDist }) {
  let entries;
  try { entries = await readdir(outPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(outPath, { recursive: true });
    return;
  }
  if (entries.length === 0) return;
  // Only the directory the build itself recognizes (or, with --clean, a half-written one inside dist/) is replaced; a foreign folder never is.
  if (await isOwnOutput(outPath) || (clean === true && insideDist)) {
    await rm(outPath, { recursive: true, force: true });
    await mkdir(outPath, { recursive: true });
    return;
  }
  throw fail('EXTENSION_OUT_EXISTS');
}

// --- icons, key, zip ---

async function buildIcons(rootPath, cache) {
  const icons = new Map();
  for (const icon of ICON_PLAN) {
    const bytes = await readSource(rootPath, icon.from, cache);
    const image = await decodePng(bytes);
    if (image.width !== icon.size || image.height !== icon.size) throw invalidIcon();
    icons.set(icon.out, icon.scaled ? encodePng(downscale4(image)) : bytes);
  }
  return icons;
}

async function readKeys(path) {
  try { return await readBuiltinKey(path); } catch (error) {
    if (error?.message === 'RELEASE_KEY_FILE_MISSING') throw fail('EXTENSION_KEY_FILE_MISSING');
    if (error?.message === 'RELEASE_KEY_INVALID') throw fail('EXTENSION_KEY_INVALID');
    throw error;
  }
}

async function defaultZip({ cwd, zipPath }) {
  // An argument array, never a shell string: neither the path nor a file name can be interpreted by a shell.
  await execFileAsync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd });
}

async function makeZip({ outPath, zipPath, zipFn }) {
  // `zip` UPDATES an existing archive, which would keep entries of files that no longer exist; the generated name is a build product, so start clean.
  await unlink(zipPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  try {
    await zipFn({ cwd: outPath, zipPath });
  } catch (error) {
    await unlink(zipPath).catch(() => {});
    // A missing zip binary is reported, not fatal: Load unpacked only needs the folder.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return zipPath;
}

// --- buildExtension (§10.2) ---

async function runBuild({ root = projectRoot, out, clean = false, zip = false, builtinKeyFile = null, zipFn = defaultZip } = {}) {
  const rootPath = resolve(root);
  const keyed = builtinKeyFile !== null && builtinKeyFile !== undefined;
  const { outPath, insideDist } = await validateTargets({ rootPath, out: out === undefined ? join(rootPath, 'dist', 'extension') : out, keyed });
  const cache = new Map();

  // Step 2: the manifest and the message tables, then the source listing the lint's fileExists is bound to.
  const manifestBytes = await readSource(rootPath, 'extension/manifest.json', cache);
  const parsed = attempt(() => JSON.parse(manifestBytes.toString('utf8')));
  if (parsed === undefined) throw fail('EXTENSION_MANIFEST_INVALID', { reasons: ['EXTENSION_MANIFEST_JSON'] });
  const messages = {};
  for (const language of LANGUAGES) {
    const bytes = await readSource(rootPath, `extension/_locales/${language}/messages.json`, cache);
    const value = attempt(() => JSON.parse(bytes.toString('utf8')));
    messages[language] = isObject(value) ? value : null;
  }
  const extensionFiles = await collectExtensionFiles(rootPath);
  const known = new Set(extensionFiles);
  const reasons = lintManifest(parsed, { fileExists: (path) => known.has(path) || ICON_NAMES.has(path), messages });
  if (reasons.length) throw fail('EXTENSION_MANIFEST_INVALID', { reasons });
  for (const page of EXTENSION_PAGES) if (!known.has(page)) throw fail('EXTENSION_SOURCE_MISSING', { path: page });

  // Step 3: the copy set, all of it read into memory before the output is touched, so a refusal leaves the previous build alone.
  // The fixed extras and the icon sources are required sources, so they are read first: a missing styles.css is
  // EXTENSION_SOURCE_MISSING, not an unresolved <link> of some page.
  const extras = new Map();
  for (const path of EXTRA_FILES) extras.set(path, await readSource(rootPath, path, cache));
  const icons = await buildIcons(rootPath, cache);
  const contentScripts = parsed.content_scripts.flatMap((script) => script.js);
  // Every .js/.html under extension/ is a root, not only the manifest's entries: the tree is copied whole, so the
  // closure must also cover modules no entry reaches, or the built folder could import a file it does not contain.
  const entries = [...new Set([parsed.background.service_worker, parsed.side_panel.default_path, parsed.options_ui.page, ...contentScripts,
    ...EXTENSION_PAGES, ...extensionFiles.filter((path) => ['.js', '.html'].includes(posix.extname(path)))])].sort();
  const closure = await computeImportClosure({ root: rootPath, entries, classicScripts: contentScripts });
  const outputs = new Map();
  outputs.set('manifest.json', Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8'));
  for (const path of extensionFiles) {
    if (path === 'extension/manifest.json') continue;
    outputs.set(path.startsWith('extension/_locales/') ? path.slice('extension/'.length) : path, await readSource(rootPath, path, cache));
  }
  for (const path of closure.files) {
    if (!outputs.has(path)) outputs.set(path, await readSource(rootPath, path, cache));
  }
  for (const [path, bytes] of extras) outputs.set(path, bytes);
  for (const [path, bytes] of icons) outputs.set(path, bytes);
  const zipPath = join(dirname(outPath), `interp-extension-${parsed.version}${keyed ? '-keyed' : ''}.zip`);
  if (zip === true && !['missing', 'file'].includes(await lstatKind(zipPath))) throw fail('EXTENSION_OUT_INVALID');

  // Step 6: the slot must be present exactly once in EVERY build, so an unkeyed build can never ship a list that someone filled in the source.
  const keys = keyed ? await readKeys(builtinKeyFile) : [];
  const slotted = outputs.get(KEY_FILE);
  if (slotted === undefined ? keyed : slotted.toString('utf8').split(KEY_SLOT).length !== 2) throw fail('EXTENSION_KEY_SLOT_INVALID');
  if (keyed) {
    const list = keys.map((key) => `'${key}'`).join(', ');
    // A function replacement: a key may contain `$`, which a replacement string would interpret.
    outputs.set(KEY_FILE, Buffer.from(slotted.toString('utf8').replace(KEY_SLOT, () => `export const BUILTIN_KEYS = Object.freeze([${list}]);`), 'utf8'));
  }

  // Step 7: the secret scan, over the bytes about to be written, so a refused build writes nothing at all.
  for (const [path, bytes] of outputs) {
    if (!TEXT_TYPES.has(posix.extname(path)) || (keyed && path === KEY_FILE)) continue;
    const text = bytes.toString('utf8');
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw fail('EXTENSION_SECRET_FOUND', { path });
  }

  // Steps 4 and 5: prepare the output, then write in sorted order.
  await prepareOut({ outPath, clean, insideDist });
  const files = [...outputs.keys()].sort();
  for (const path of files) {
    const target = join(outPath, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, outputs.get(path));
  }

  // Step 8.
  const zipped = zip === true ? await makeZip({ outPath, zipPath, zipFn }) : null;
  return Object.freeze({ out: outPath, files, version: parsed.version, builtinKeys: keys.length, zip: zipped });
}

/**
 * buildExtension({ root, out, clean, zip, builtinKeyFile, zipFn }) copies the extension into `out` (default
 * <root>/dist/extension) and returns the frozen { out, files, version, builtinKeys, zip }. It throws an Error whose
 * message is one EXTENSION_* code; anything unexpected becomes EXTENSION_BUILD_FAILED with the message discarded.
 * The result reports a skipped zip as `zip: null`; the CLI turns that into EXTENSION_ZIP_UNAVAILABLE.
 */
export async function buildExtension(options = {}) {
  try {
    return await runBuild(options);
  } catch (error) {
    throw isCode(error) ? error : fail('EXTENSION_BUILD_FAILED');
  }
}

// --- CLI (same guard pattern as scripts/stage-release.mjs) ---

const VALUE_FLAGS = new Set(['--out', '--builtin-key-file']);
const BOOLEAN_FLAGS = new Set(['--clean', '--zip']);

/** Each flag at most once; `--out` and `--builtin-key-file` take one value, `--clean` and `--zip` take none. */
export function parseArguments(args) {
  if (!Array.isArray(args)) throw fail('EXTENSION_ARGUMENT_INVALID');
  const seen = new Set();
  const options = { out: undefined, clean: false, zip: false, builtinKeyFile: null };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!(VALUE_FLAGS.has(flag) || BOOLEAN_FLAGS.has(flag)) || seen.has(flag)) throw fail('EXTENSION_ARGUMENT_INVALID');
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) { options[flag.slice(2)] = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw fail('EXTENSION_ARGUMENT_INVALID');
    if (flag === '--out') options.out = value;
    else options.builtinKeyFile = value;
    index += 1;
  }
  return Object.freeze(options);
}

/**
 * Runs the CLI and returns the exit code. stdout gets the fixed success lines, stderr gets exactly one code on
 * failure; neither ever carries file contents or a key.
 */
export async function runCli(args, { stdout = process.stdout, stderr = process.stderr, build = buildExtension } = {}) {
  try {
    const options = parseArguments(args);
    const result = await build(options);
    const lines = [`EXTENSION_BUILT out=${result.out} files=${result.files.length} version=${result.version}`];
    if (result.builtinKeys > 0) lines.push(`EXTENSION_BUILTIN_KEY keys=${result.builtinKeys}`);
    if (typeof result.zip === 'string') lines.push(`EXTENSION_ZIP name=${basename(result.zip)}`);
    else if (options.zip) lines.push('EXTENSION_ZIP_UNAVAILABLE');
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    const code = typeof error?.message === 'string' && /^EXTENSION_[A-Z_]+$/.test(error.message) ? error.message : 'EXTENSION_BUILD_FAILED';
    stderr.write(`${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
