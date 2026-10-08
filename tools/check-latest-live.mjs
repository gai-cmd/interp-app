// Is DEFAULT_LIVE_MODEL still the newest GENERAL Google Live model? (owner, 2026-10-08: "항상 최신이 될수 있도록")
//
//   node tools/check-latest-live.mjs [--key-file <path>]
//
// One free GET of the provider's model list (paged, pageSize=1000) with the first key of the key file (default
// ~/.config/interp-app/builtin-key; the key travels in a header and is never printed). Exit code: 0 = the default is the newest
// general Live model, 1 = a newer one exists (change DEFAULT_LIVE_MODEL, see docs/extension.md §23), 2 = it could not be checked.
//
// "General Live model" is a strict id rule on purpose: `gemini-<major>.<minor>-live` and nothing else. Previews, the extended-thinking
// variant, translation, transcription, native-audio and robotics models also report bidiGenerateContent, but none of them is a
// drop-in replacement for the default, so none of them may ever make this check say "newer". Versions compare as NUMBERS (3.10 > 3.8).
// The pure functions are exported for tests/latest-live-check.test.mjs; they touch no network, file or global.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LIVE_MODEL } from '../app/providers/gemini/live-config.js';
import { REST_ENDPOINT } from '../app/providers/gemini/config.js';

/** The one id shape of a general Live model. */
export const GENERAL_LIVE_ID = /^gemini-(\d{1,2})\.(\d{1,2})-live$/;
/** What a Live (bidirectional streaming) model reports among its generation methods. */
export const LIVE_METHOD = 'bidiGenerateContent';
export const LIMITS = Object.freeze({ pageSize: 1000, maxPages: 10, timeoutMs: 15000 });

const bare = (name) => (typeof name === 'string' && name.startsWith('models/') ? name.slice('models/'.length) : name);

/** [major, minor] of a general Live id, or null for any other id. */
export function versionOfGeneralLive(id) {
  const match = typeof id === 'string' ? GENERAL_LIVE_ID.exec(id) : null;
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** 1 when a is a newer general Live id than b, -1 when older, 0 when equal; null when either is not a general Live id. */
export function compareGeneralLive(a, b) {
  const x = versionOfGeneralLive(a);
  const y = versionOfGeneralLive(b);
  if (x === null || y === null) return null;
  if (x[0] !== y[0]) return x[0] > y[0] ? 1 : -1;
  if (x[1] !== y[1]) return x[1] > y[1] ? 1 : -1;
  return 0;
}

/** The newest general Live id of a list of model ids (with or without the "models/" prefix), or null. */
export function newestGeneralLive(ids) {
  let best = null;
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = bare(raw);
    if (versionOfGeneralLive(id) === null) continue;
    if (best === null || compareGeneralLive(id, best) === 1) best = id;
  }
  return best;
}

/**
 * The verdict of the check: { status: 'up-to-date' | 'newer' | 'default-not-listed', newest, current }.
 * 'default-not-listed' = the account no longer lists the default at all (retired?): as urgent as 'newer'.
 */
export function verdictOf({ current = DEFAULT_LIVE_MODEL, liveIds = [] } = {}) {
  const ids = (Array.isArray(liveIds) ? liveIds : []).map(bare);
  const newest = newestGeneralLive(ids);
  if (!ids.includes(current)) return Object.freeze({ status: 'default-not-listed', newest, current });
  return Object.freeze({ status: newest !== null && compareGeneralLive(newest, current) === 1 ? 'newer' : 'up-to-date', newest, current });
}

/**
 * Every model id of the account that reports bidiGenerateContent, following nextPageToken. The key goes in a header, never in
 * the URL; nothing but ids is returned. Throws an Error whose .code is NETWORK_ERROR, INVALID_KEY, RATE_LIMITED or INVALID_RESULT.
 */
export async function listLiveModelIds({ fetch: fetchImpl = globalThis.fetch, key, endpoint = REST_ENDPOINT, limits = LIMITS } = {}) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (typeof fetchImpl !== 'function' || typeof key !== 'string' || key === '') throw fail('INVALID_KEY');
  const ids = [];
  let token = '';
  for (let page = 0; page < limits.maxPages; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('pageSize', String(limits.pageSize));
    if (token) url.searchParams.set('pageToken', token);
    let response;
    try { response = await fetchImpl(url, { method: 'GET', headers: { 'x-goog-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(limits.timeoutMs) }); }
    catch { throw fail('NETWORK_ERROR'); }
    if (response.status === 401 || response.status === 403) throw fail('INVALID_KEY');
    if (response.status === 429) throw fail('RATE_LIMITED');
    if (!response.ok) throw fail('NETWORK_ERROR');
    let body;
    try { body = await response.json(); } catch { throw fail('INVALID_RESULT'); }
    if (!Array.isArray(body?.models)) throw fail('INVALID_RESULT');
    for (const entry of body.models) {
      const id = bare(entry?.name);
      if (typeof id === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(id) && Array.isArray(entry?.supportedGenerationMethods)
        && entry.supportedGenerationMethods.includes(LIVE_METHOD) && !ids.includes(id)) ids.push(id);
    }
    token = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (!token) return Object.freeze(ids);
  }
  throw fail('INVALID_RESULT');   // more pages than any account has: do not guess
}

async function main(argv) {
  const at = argv.indexOf('--key-file');
  const keyFile = at >= 0 ? argv[at + 1] : `${homedir()}/.config/interp-app/builtin-key`;
  let key;
  try {
    const lines = (await readFile(keyFile, 'utf8')).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
    key = lines[0];
  } catch { console.log('LATEST_LIVE_UNCHECKED KEY_FILE_UNREADABLE'); return 2; }
  let liveIds;
  try { liveIds = await listLiveModelIds({ key }); } catch (error) { console.log(`LATEST_LIVE_UNCHECKED ${error.code ?? 'ERROR'}`); return 2; }
  const verdict = verdictOf({ liveIds });
  const general = liveIds.filter((id) => versionOfGeneralLive(id) !== null);
  console.log(`LATEST_LIVE ${verdict.status} default=${verdict.current} newest=${verdict.newest ?? 'none'} liveModels=${liveIds.length} generalLiveModels=${general.join(',') || 'none'}`);
  if (verdict.status === 'newer') console.log(`NEXT: set DEFAULT_LIVE_MODEL to ${verdict.newest} in app/providers/gemini/live-config.js (LIVE_MODELS, docs, tests), run the suite, package, boot-test, deploy.`);
  if (verdict.status === 'default-not-listed') console.log('NEXT: the account no longer lists the default model: check the provider\'s deprecation notice and move the default now.');
  return verdict.status === 'up-to-date' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
