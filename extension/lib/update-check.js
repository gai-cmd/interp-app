// New module (owner decision 2026-09-30, docs/extension.md §16): the update check.
// The extension is handed out as a folder (Load unpacked), which Chrome never updates on Windows or macOS, so the panel
// compares its own version with the one the download site publishes and offers the download and a reload. The request is
// a plain GET of a public JSON file: no key, no identifier, no cookie, no body. Every failure is silent (no network, a
// non-OK answer, a malformed file, an unreadable version) and simply means "no banner"; nothing here throws.
// These two literals are the ONLY place the site is written (the R11 scan pins them to this file).
export const UPDATE_SITE_URL = 'https://kc-live-interpreter.vercel.app/';
export const UPDATE_MANIFEST_URL = 'https://kc-live-interpreter.vercel.app/latest.json';
// §21 (owner, 2026-10-08): the signed update tree lives under this base, one folder per version. The URL of every file is
// derived from the version latest.json publishes (updateTreeUrls below), so latest.json itself stays four fields.
export const UPDATE_TREE_URL = 'https://kc-live-interpreter.vercel.app/update/';

const VERSION = /^\d{1,5}(?:\.\d{1,5}){0,3}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A Chrome manifest version ("1", "0.2", "1.2.3.4") as numbers, or null when it is not one. */
export function parseVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return null;
  return value.split('.').map(Number);
}

/** -1, 0 or 1 like a comparator (missing parts count as 0: "1.2" equals "1.2.0"); null when either side is unreadable. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

const NONE = Object.freeze({ available: false, version: null });

/**
 * checkForUpdate({ fetch, currentVersion }) -> Promise<Readonly<{ available, version }>>. `available` is true only when
 * the published version is strictly newer than `currentVersion`; `version` is the published one (null when unreadable).
 * `fetch` is injected (the panel passes the page's own), so this module touches no global.
 */
export async function checkForUpdate({ fetch: fetcher, currentVersion } = {}) {
  if (typeof fetcher !== 'function' || parseVersion(currentVersion) === null) return NONE;
  try {
    const response = await fetcher(UPDATE_MANIFEST_URL, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response?.ok) return NONE;
    const body = await response.json();
    const version = isObject(body) ? body.version : undefined;
    if (parseVersion(version) === null) return NONE;
    return Object.freeze({ available: compareVersions(version, currentVersion) === 1, version });
  } catch {
    return NONE;
  }
}

const treeError = (code) => Object.assign(new Error(code), { code });

/**
 * updateTreeUrls(version) -> { manifest, signature, file(path) }: the three kinds of URL of one version's update tree
 * (§21): `<base><version>/manifest.json` (the signed manifest), `<base><version>/manifest.sig` and
 * `<base><version>/files/<path>` with every path segment percent-encoded. Pure string work, no request. A version that is
 * not a Chrome manifest version throws Error{code:'UPDATE_BAD_MANIFEST'} (it becomes part of a URL, so it is checked
 * here and nowhere else); a path that is not a string, or has an empty, "." or ".." segment, throws UPDATE_UNSAFE_PATH
 * (encodeURIComponent leaves ".." alone, and ".." in a URL is a way out of the version's folder).
 */
export function updateTreeUrls(version) {
  if (parseVersion(version) === null) throw treeError('UPDATE_BAD_MANIFEST');
  const base = `${UPDATE_TREE_URL}${version}/`;
  return Object.freeze({
    manifest: `${base}manifest.json`,
    signature: `${base}manifest.sig`,
    file(path) {
      const segments = typeof path === 'string' ? path.split('/') : [];
      if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw treeError('UPDATE_UNSAFE_PATH');
      return `${base}files/${segments.map(encodeURIComponent).join('/')}`;
    },
  });
}
