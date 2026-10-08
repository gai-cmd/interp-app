// New implementation of docs/extension.md §21 (owner, 2026-10-08); no legacy code is ported.
// The pure part of the extension's self-update: the extension replaces the files of its own (unpacked) folder, so this
// module is a remote-code channel and is written to refuse everything it cannot prove. It trusts ONE thing: a manifest
// whose ECDSA P-256 / SHA-256 signature (raw 64-byte r||s) verifies, over its exact bytes, with one of the built-in public
// keys. The manifest lists every file with its size and sha256; every download is checked against that BEFORE the first byte
// is written, and a path that could leave the folder, collide on a case-insensitive disk or hit a Windows device name never
// gets that far. Every platform object (SubtleCrypto, the directory handle, the downloader) is INJECTED: this module names
// no platform global, touches nothing at import time and never throws anything but Error{code} with a code of
// UPDATE_ERROR_CODES (the optional .cause keeps the platform's own error for a debugger; it is never shown).
import { compareVersions, parseVersion, updateTreeUrls } from './update-check.js';

export const UPDATE_FORMAT = 1;
export const SELF_UPDATE_LIMITS = Object.freeze({
  maxFiles: 400, maxFileBytes: 2097152, maxTotalBytes: 16777216, maxManifestBytes: 262144, maxPathChars: 255,
});
export const UPDATE_ERROR_CODES = Object.freeze([
  'UPDATE_DISABLED', 'UPDATE_NO_FOLDER', 'UPDATE_NEEDS_PERMISSION', 'UPDATE_PERMISSION_DENIED', 'UPDATE_WRONG_FOLDER',
  'UPDATE_NOT_NEWER', 'UPDATE_FETCH_FAILED', 'UPDATE_BAD_SIGNATURE', 'UPDATE_BAD_MANIFEST', 'UPDATE_UNSAFE_PATH',
  'UPDATE_TOO_LARGE', 'UPDATE_BAD_HASH', 'UPDATE_WRITE_FAILED', 'UPDATE_PICK_CANCELLED', 'UPDATE_BUSY',
]);

const MANIFEST_FILE = 'manifest.json';
const SIGNATURE_BYTES = 64;                  // ECDSA P-256 in WebCrypto's raw form: r (32) || s (32)
const DOWNLOAD_PARALLEL = 6;
const MANIFEST_KEYS = Object.freeze(['format', 'version', 'released', 'files']);
const ENTRY_KEYS = Object.freeze(['path', 'size', 'sha256']);

/** Error carrying only a machine code (never bytes, paths or provider text); `cause` keeps the platform error. */
function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

/** The bytes of an ArrayBuffer or a typed array / DataView as a Uint8Array view (any realm), or null. */
function bytesOf(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
  return null;
}
function sameBytes(left, right) {
  const a = bytesOf(left);
  const b = bytesOf(right);
  if (a === null || b === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
/** Bytes -> string, one char per byte (no decoder object needed; the callers read ASCII fields only). */
function latin1(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 8192) out += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return out;
}
const toHex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Strict, canonical standard base64 (padding required, no whitespace, unused trailing bits zero) -> Uint8Array, or null. */
function decodeBase64(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let index = 0; index < text.length; index += 4) {
    const sextets = [0, 1, 2, 3].map((offset) => (text[index + offset] === '=' ? 0 : BASE64.indexOf(text[index + offset])));
    const triple = (sextets[0] << 18) | (sextets[1] << 12) | (sextets[2] << 6) | sextets[3];
    for (const byte of [(triple >> 16) & 255, (triple >> 8) & 255, triple & 255]) if (written < out.length) { out[written] = byte; written += 1; }
    // Canonical form: the bits of the last character that carry no data must be zero ("AB==" is not the encoding of one byte).
    if (index + 4 === text.length && ((padding === 2 && (sextets[1] & 15) !== 0) || (padding === 1 && (sextets[2] & 3) !== 0))) return null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paths. The manifest is signed, but a signed path is still written into the person's folder, so the rules do not rely on
// the signer being right: a mistake in a release must fail on every PC instead of overwriting something.
const SEGMENT_CHARS = /^[A-Za-z0-9._ -]+$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function safeSegment(segment, { isRoot, hasChildren }) {
  if (segment === '' || segment === '.' || segment === '..' || !SEGMENT_CHARS.test(segment)) return false;
  const lower = segment.toLowerCase();
  if (lower.startsWith('_metadata')) return false;
  // Chrome refuses to load a folder with another name starting with "_" in its root (they are reserved for the system).
  if (isRoot && segment.startsWith('_') && !(segment === '_locales' && hasChildren)) return false;
  // Windows drops a trailing dot or space ("a." IS "a") and a leading space is never intended: both alias another file.
  if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) return false;
  // Device names (CON, NUL, COM1 ...) are reserved on Windows with any extension.
  return !WINDOWS_DEVICE.test(lower.split('.')[0].trimEnd());
}

/**
 * True for a relative, "/"-separated path that is safe to write below the extension folder: at most maxPathChars, no empty,
 * "." or ".." segment, no leading "/", no "\", no ":", no control character (only [A-Za-z0-9._ -] per segment), no segment
 * starting with "_metadata" (any case), nothing starting with "_" in the root except the "_locales" folder, no segment that
 * Windows would rewrite (trailing dot or space) or reserve (device names).
 */
export function isSafeUpdatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > SELF_UPDATE_LIMITS.maxPathChars) return false;
  const segments = path.split('/');
  return segments.every((segment, index) => safeSegment(segment, { isRoot: index === 0, hasChildren: segments.length > 1 }));
}

// ---------------------------------------------------------------------------------------------
// Manifest validation. `value` is the parsed JSON (or a caller's object); the result is a fresh, deep-frozen snapshot, so
// nothing a caller keeps a reference to can change between this check and the writes.
function validateManifest(value) {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) throw fail('UPDATE_BAD_MANIFEST');
  if (value.format !== UPDATE_FORMAT || parseVersion(value.version) === null) throw fail('UPDATE_BAD_MANIFEST');
  if (typeof value.released !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(value.released)) throw fail('UPDATE_BAD_MANIFEST');
  if (!Array.isArray(value.files) || value.files.length === 0) throw fail('UPDATE_BAD_MANIFEST');
  if (value.files.length > SELF_UPDATE_LIMITS.maxFiles) throw fail('UPDATE_TOO_LARGE');
  const files = [];
  const seen = new Set();
  let total = 0;
  for (const entry of value.files) {
    if (!isRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) throw fail('UPDATE_BAD_MANIFEST');
    const { path, size, sha256 } = entry;
    if (!isSafeUpdatePath(path)) throw fail('UPDATE_UNSAFE_PATH');
    if (!Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw fail('UPDATE_BAD_MANIFEST');
    if (size > SELF_UPDATE_LIMITS.maxFileBytes) throw fail('UPDATE_TOO_LARGE');
    // A path twice, or twice differing only by case, is one file on Windows and macOS: the second write would replace the first.
    if (seen.has(path.toLowerCase())) throw fail('UPDATE_UNSAFE_PATH');
    seen.add(path.toLowerCase());
    total += size;
    files.push(Object.freeze({ path, size, sha256 }));
  }
  if (total > SELF_UPDATE_LIMITS.maxTotalBytes) throw fail('UPDATE_TOO_LARGE');
  // A file and a folder of the same name cannot both exist: it would fail half-way through the writes, so it fails here.
  for (const { path } of files) {
    const parts = path.toLowerCase().split('/');
    for (let length = 1; length < parts.length; length += 1) if (seen.has(parts.slice(0, length).join('/'))) throw fail('UPDATE_UNSAFE_PATH');
  }
  if (!files.some(({ path }) => path === MANIFEST_FILE)) throw fail('UPDATE_BAD_MANIFEST');
  return Object.freeze({ format: UPDATE_FORMAT, version: value.version, released: value.released, files: Object.freeze(files) });
}

/**
 * Checks the signature over the EXACT manifest bytes, then reads and validates the manifest.
 * `signature` is the text of manifest.sig (base64 of the raw 64-byte r||s); `publicKeys` are SPKI DER, base64 (the primary and
 * the offline backup are both tried, a key that is not an ECDSA P-256 key or cannot be read is skipped); `subtle` is a
 * SubtleCrypto. Returns the frozen manifest { format, version, released, files: [{ path, size, sha256 }] }. Throws
 * UPDATE_BAD_SIGNATURE (no key verifies, the signature is not 64 canonical bytes, no usable key or crypto), UPDATE_TOO_LARGE
 * (manifest bytes over maxManifestBytes, or any limit of the list), UPDATE_BAD_MANIFEST or UPDATE_UNSAFE_PATH. The manifest
 * is read only after the signature holds, and it must be plain ASCII (every field is: versions, dates, safe paths, hex).
 */
export async function verifyUpdateManifest({ manifestBytes, signature, publicKeys, subtle } = {}) {
  const bytes = bytesOf(manifestBytes);
  if (bytes === null || bytes.length === 0) throw fail('UPDATE_BAD_MANIFEST');
  if (bytes.length > SELF_UPDATE_LIMITS.maxManifestBytes) throw fail('UPDATE_TOO_LARGE');
  const raw = decodeBase64(typeof signature === 'string' ? signature.trim() : signature);
  if (raw === null || raw.length !== SIGNATURE_BYTES) throw fail('UPDATE_BAD_SIGNATURE');
  if (!Array.isArray(publicKeys) || typeof subtle?.importKey !== 'function' || typeof subtle?.verify !== 'function') throw fail('UPDATE_BAD_SIGNATURE');
  let verified = false;
  for (const encoded of publicKeys) {
    try {
      const der = decodeBase64(encoded);
      if (der === null) continue;
      const key = await subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, bytes) === true) { verified = true; break; }
    } catch { /* a key of another algorithm or curve, or a broken one: it cannot vouch for anything, try the next */ }
  }
  if (!verified) throw fail('UPDATE_BAD_SIGNATURE');
  if (bytes.some((byte) => byte > 0x7f)) throw fail('UPDATE_BAD_MANIFEST');
  let parsed;
  try { parsed = JSON.parse(latin1(bytes)); } catch (error) { throw fail('UPDATE_BAD_MANIFEST', error); }
  return validateManifest(parsed);
}

/**
 * planUpdate({ manifest, runningVersion }) -> { ok: true } | { ok: false, code }. The signed version must be STRICTLY
 * greater than the running one: the same version is not an update, a lower one is a rollback, and a version nobody can read
 * proves nothing. An unreadable manifest version is UPDATE_BAD_MANIFEST, everything else UPDATE_NOT_NEWER.
 */
export function planUpdate({ manifest, runningVersion } = {}) {
  if (parseVersion(manifest?.version) === null) return Object.freeze({ ok: false, code: 'UPDATE_BAD_MANIFEST' });
  return compareVersions(manifest.version, runningVersion) === 1 ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, code: 'UPDATE_NOT_NEWER' });
}

const reporter = (onProgress) => (info) => {
  if (typeof onProgress !== 'function') return;
  try { onProgress(info); } catch { /* a progress callback is the UI's: it must never break an update */ }
};

/**
 * Downloads every file of the manifest into memory and checks each against its signed size and sha256; nothing is written
 * anywhere. `fetchBytes(url, { maxBytes })` -> Promise<Uint8Array> (throws on a non-OK answer, or Error{code:
 * 'UPDATE_TOO_LARGE'} when the body outgrows maxBytes; the second argument may be ignored by a simple fetcher). Throws
 * UPDATE_FETCH_FAILED, UPDATE_TOO_LARGE or UPDATE_BAD_HASH (a different size counts as a different file), and
 * UPDATE_BAD_MANIFEST when the version inside the downloaded manifest.json is not the signed version. Resolves a Map
 * path -> Uint8Array in manifest order (private copies). `onProgress({ done, total })` runs after each file.
 */
export async function downloadUpdate({ manifest: given, fetchBytes, subtle, onProgress } = {}) {
  const manifest = validateManifest(given);
  if (typeof fetchBytes !== 'function') throw fail('UPDATE_FETCH_FAILED');
  if (typeof subtle?.digest !== 'function') throw fail('UPDATE_BAD_HASH');
  const urls = updateTreeUrls(manifest.version);
  const report = reporter(onProgress);
  const total = manifest.files.length;
  const results = new Map();
  let failure = null;
  let next = 0;
  let done = 0;
  async function one({ path, size, sha256 }) {
    let received;
    try { received = await fetchBytes(urls.file(path), { maxBytes: size }); } catch (error) {
      throw fail(error?.code === 'UPDATE_TOO_LARGE' ? 'UPDATE_TOO_LARGE' : 'UPDATE_FETCH_FAILED', error);
    }
    const view = bytesOf(received);
    if (view === null) throw fail('UPDATE_FETCH_FAILED');
    if (view.length !== size) throw fail('UPDATE_BAD_HASH');
    const copy = new Uint8Array(view);              // private: what is hashed is what is written, whoever keeps the original
    let digest;
    try { digest = toHex(await subtle.digest('SHA-256', copy)); } catch (error) { throw fail('UPDATE_BAD_HASH', error); }
    if (digest !== sha256) throw fail('UPDATE_BAD_HASH');
    results.set(path, copy);
  }
  async function worker() {
    while (failure === null && next < total) {
      const entry = manifest.files[next];
      next += 1;
      try { await one(entry); } catch (error) { failure ??= error; return; }
      done += 1;
      report({ done, total });
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_PARALLEL, total) }, worker));
  if (failure !== null) throw failure;
  let version;
  try { version = JSON.parse(latin1(results.get(MANIFEST_FILE))).version; } catch (error) { throw fail('UPDATE_BAD_MANIFEST', error); }
  if (version !== manifest.version) throw fail('UPDATE_BAD_MANIFEST');
  return new Map(manifest.files.map(({ path }) => [path, results.get(path)]));
}

/**
 * Which folder `dir` is, judged by its manifest.json bytes: 'running' (they equal the running extension's: this is the loaded
 * folder), 'target' (they equal the update's manifest.json: an earlier apply wrote everything and only the reload is left) or
 * 'other' (anything else, an unreadable or missing file included). Reads one file, writes nothing.
 */
export async function folderRelation({ dir, runningManifestBytes, targetManifestBytes } = {}) {
  try {
    const file = await (await dir.getFileHandle(MANIFEST_FILE)).getFile();
    if (typeof file.size === 'number' && file.size > SELF_UPDATE_LIMITS.maxFileBytes) return 'other';
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sameBytes(bytes, runningManifestBytes)) return 'running';
    if (sameBytes(bytes, targetManifestBytes)) return 'target';
  } catch { /* no manifest.json, or it cannot be read: not a folder this extension can be sure about */ }
  return 'other';
}

/**
 * Writes the verified files into `dir`. Everything is checked first (manifest, one buffer of exactly the signed size per
 * path and no other, the previous paths), so a refusal leaves the folder untouched. Order: every file except manifest.json
 * (createWritable -> write -> close: Chrome commits each file atomically on close), then the obsolete files, then
 * manifest.json LAST. Chrome loads nothing new until the reload, and a folder whose manifest.json is the old one is plainly
 * "not applied yet", so an interrupted apply is simply run again (it is idempotent). Sub-folders are created.
 * Obsolete = a path of `previousPaths` (the tree applied last time; empty the first time, so nothing is deleted) that is
 * safe, absent from the new manifest (compared without regard to case) and not manifest.json; a file that is already gone
 * or cannot be deleted is left alone (an unused leftover is harmless, a failed update is not). Throws UPDATE_WRITE_FAILED
 * (the platform error in .cause) when a write fails; the validation codes above otherwise.
 * Resolves { written, removed } (paths, in the order done). `onProgress({ done, total, path })` runs after each written file.
 */
export async function applyUpdate({ dir, manifest: given, files, previousPaths = [], onProgress } = {}) {
  const manifest = validateManifest(given);
  if (!(files instanceof Map) || files.size !== manifest.files.length) throw fail('UPDATE_BAD_MANIFEST');
  for (const { path, size } of manifest.files) {
    const bytes = files.get(path);
    if (bytesOf(bytes) === null) throw fail('UPDATE_BAD_MANIFEST');
    if (bytesOf(bytes).length !== size) throw fail('UPDATE_BAD_HASH');
  }
  if (typeof dir?.getDirectoryHandle !== 'function' || typeof dir?.getFileHandle !== 'function') throw fail('UPDATE_WRITE_FAILED');
  const obsoleteCandidates = Array.isArray(previousPaths) ? previousPaths.slice(0, SELF_UPDATE_LIMITS.maxFiles) : [];
  const report = reporter(onProgress);
  const keep = new Set(manifest.files.map(({ path }) => path.toLowerCase()));
  const folders = new Map();
  async function parentOf(path, create) {
    const parts = path.split('/');
    const name = parts.pop();
    let directory = dir;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      if (!folders.has(prefix)) folders.set(prefix, await directory.getDirectoryHandle(part, { create }));
      directory = folders.get(prefix);
    }
    return { directory, name };
  }
  async function write(path) {
    const { directory, name } = await parentOf(path, true);
    const handle = await directory.getFileHandle(name, { create: true });
    let writable;
    try {
      writable = await handle.createWritable();
      await writable.write(files.get(path));
      await writable.close();
    } catch (error) {
      try { await writable?.abort?.(); } catch { /* the swap file is the platform's to clean up */ }
      throw error;
    }
  }
  const written = [];
  const removed = [];
  const order = [...manifest.files.map(({ path }) => path).filter((path) => path !== MANIFEST_FILE), MANIFEST_FILE];
  const total = order.length;
  const writeOne = async (path) => {
    try { await write(path); } catch (error) { throw fail('UPDATE_WRITE_FAILED', error); }
    written.push(path);
    report({ done: written.length, total, path });
  };
  for (const path of order.slice(0, -1)) await writeOne(path);
  for (const path of obsoleteCandidates) {
    if (!isSafeUpdatePath(path) || keep.has(path.toLowerCase()) || removed.includes(path)) continue;
    try {
      const { directory, name } = await parentOf(path, false);
      await directory.removeEntry(name);
      removed.push(path);
    } catch { /* already gone, a folder, or locked */ }
  }
  await writeOne(MANIFEST_FILE);
  return Object.freeze({ written: Object.freeze(written), removed: Object.freeze(removed) });
}
