// New module (owner decision 2026-09-30, docs/extension.md §16): the update check.
// The extension is handed out as a folder (Load unpacked), which Chrome never updates on Windows or macOS, so the panel
// compares its own version with the one the download site publishes and offers the download and a reload. The request is
// a plain GET of a public JSON file: no key, no identifier, no cookie, no body. Every failure is silent (no network, a
// non-OK answer, a malformed file, an unreadable version) and simply means "no banner"; nothing here throws.
// These two literals are the ONLY place the site is written (the R11 scan pins them to this file).
export const UPDATE_SITE_URL = 'https://kc-live-interpreter.vercel.app/';
export const UPDATE_MANIFEST_URL = 'https://kc-live-interpreter.vercel.app/latest.json';

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
