// New implementation of docs/extension.md §24 (0.5.2); no legacy code is ported.
// "Always the latest Google Live model" (owner, 2026-10-08), the pure half: which model ids count, which one is newest, what
// the worker remembers about it, and how a lane asks the provider. Nothing here touches a global, a storage area or the
// clock: the fetch, the key, the signal and `now` arrive as arguments, so the worker, the offscreen host and
// tools/check-latest-live.mjs share ONE definition of "newer" and of "what may be adopted".
//
// What is adopted: only an id of the shape `gemini-<major>.<minor>-live` (GENERAL_LIVE_ID) that is strictly newer than the
// repository's default model. A preview, an extended-thinking variant, a translation, transcription, native-audio or robotics
// model never is, however new its number: they also report bidiGenerateContent but are no drop-in replacement for the default.
// Versions compare as NUMBERS (3.10 is newer than 3.8). The record the worker keeps is a hint, never trusted: it is
// re-validated here at every read, and a lane that cannot run the adopted model goes back to the default by itself (the
// engine's lane-engine.js), so a wrong or hostile record can cost one reconnect, not a session.
import { GENERAL_LIVE_ID, LATEST_REFRESH } from './constants.js';

export { GENERAL_LIVE_ID, LATEST_REFRESH };

/** What a Live (bidirectional streaming) model reports among its generation methods. */
export const LIVE_METHOD = 'bidiGenerateContent';
// The provider's model list. The same address as app/providers/gemini/config.js REST_ENDPOINT, copied because lib may import
// only a short list of app modules (tests/extension-latest-live.test.mjs compares the two).
export const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * The timing of the record. A start that finds the record `fresh` asks nothing; a `stale` one (older than freshMs) is used
 * as it is and asked again in the background; an `expired` one (older than hardMs, a week) or none at all makes the start ask FIRST,
 * for at most blockMs (a person who starts every day never waits; one who comes back after a week waits a round trip). A failed look is not repeated for failureCooldownMs, and a model the provider refused is not tried
 * again for rejectedMs.
 */
export const LATEST_LIVE = Object.freeze({
  freshMs: 60 * 60 * 1000,
  hardMs: 7 * 24 * 60 * 60 * 1000,
  failureCooldownMs: 10 * 60 * 1000,
  rejectedMs: 6 * 60 * 60 * 1000,
  blockMs: 2000,
  backgroundMs: 10000,
  maxKeyTries: 3,
  earlyCloseMs: 3000,
  setupWatchdogMs: 4000,
  pageSize: 1000,
  maxPages: 10,
});

const int = (value) => Number.isSafeInteger(value) && value >= 0;
const bare = (name) => (typeof name === 'string' && name.startsWith('models/') ? name.slice('models/'.length) : name);

/** [major, minor] of a general Live id, or null for any other id (a non-string included). */
export function versionOfGeneralLive(id) {
  const match = typeof id === 'string' ? GENERAL_LIVE_ID.exec(id) : null;
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** 1 when `a` is a newer general Live id than `b`, -1 when older, 0 when equal; null when either is not a general Live id. */
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

/** True only for a general Live id that is STRICTLY newer than `current` (itself a general Live id). */
export const isAdoptable = (id, current) => compareGeneralLive(id, current) === 1;

/**
 * The verdict of tools/check-latest-live.mjs: { status: 'up-to-date' | 'newer' | 'default-not-listed', newest, current }.
 * 'default-not-listed' = the account no longer lists the default at all (retired?): as urgent as 'newer'.
 */
export function verdictOf({ current, liveIds = [] } = {}) {
  const ids = (Array.isArray(liveIds) ? liveIds : []).map(bare);
  const newest = newestGeneralLive(ids);
  if (!ids.includes(current)) return Object.freeze({ status: 'default-not-listed', newest, current });
  return Object.freeze({ status: newest !== null && compareGeneralLive(newest, current) === 1 ? 'newer' : 'up-to-date', newest, current });
}

/**
 * Every model id of the account that reports bidiGenerateContent, following nextPageToken. The key goes in a header, never in
 * the URL; nothing but ids is returned. Throws an Error whose .code is NETWORK_ERROR, INVALID_KEY, RATE_LIMITED or
 * INVALID_RESULT. `signal` (optional) cancels the request: the caller owns the timer, so a fake clock can drive it.
 */
export async function listLiveModelIds({ fetch: fetchImpl, key, signal, endpoint = MODELS_ENDPOINT, limits = LATEST_LIVE } = {}) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (typeof fetchImpl !== 'function' || typeof key !== 'string' || key === '') throw fail('INVALID_KEY');
  const ids = [];
  let token = '';
  for (let page = 0; page < limits.maxPages; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('pageSize', String(limits.pageSize));
    if (token) url.searchParams.set('pageToken', token);
    let response;
    try {
      response = await fetchImpl(url.href, { method: 'GET', headers: { 'x-goog-api-key': key, accept: 'application/json' },
        cache: 'no-store', ...(signal ? { signal } : {}) });
    } catch { throw fail('NETWORK_ERROR'); }
    if (response?.status === 401 || response?.status === 403) throw fail('INVALID_KEY');
    if (response?.status === 429) throw fail('RATE_LIMITED');
    // The provider answers an invalid key with HTTP 400 and API_KEY_INVALID (observed 2026-10-08), not 401/403.
    if (response?.status === 400) {
      const text = await Promise.resolve(response.text?.()).catch(() => '');
      throw fail(typeof text === 'string' && /API_KEY_INVALID|API key not valid/i.test(text) ? 'INVALID_KEY' : 'NETWORK_ERROR');
    }
    if (!response?.ok) throw fail('NETWORK_ERROR');
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

// ---------------------------------------------------------------------------------------------
// The record (chrome.storage.local, interp.latest-live.v1). Written only by the worker, from what a lane reports, with the
// worker's own clock; read back through normalizeRecord at every use.

/** The record, or null when `raw` is not exactly a record of this version (a damaged or foreign value is no record). */
export function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
  const { newest, checkedAt, failedAt, rejected } = raw;
  if (!(newest === null || (typeof newest === 'string' && versionOfGeneralLive(newest) !== null)) || !int(checkedAt)) return null;
  if (!(failedAt === null || int(failedAt))) return null;
  if (!(rejected === null || (rejected !== undefined && typeof rejected === 'object' && !Array.isArray(rejected)
    && typeof rejected.model === 'string' && versionOfGeneralLive(rejected.model) !== null && int(rejected.at)))) return null;
  return Object.freeze({ v: 1, newest, checkedAt, failedAt, rejected: rejected === null ? null : Object.freeze({ model: rejected.model, at: rejected.at }) });
}

const EMPTY = Object.freeze({ v: 1, newest: null, checkedAt: 0, failedAt: null, rejected: null });
const base = (record) => normalizeRecord(record) ?? EMPTY;

/** The look succeeded: the newest general Live model the account lists (null: it lists none). */
export const afterSeen = (record, newest, now) => normalizeRecord({ ...base(record), newest: versionOfGeneralLive(newest) === null ? null : newest, checkedAt: now, failedAt: null });
/** The look failed (offline, a refused key, a quota): the old answer stays, and the look is not repeated at once. */
export const afterFailure = (record, now) => normalizeRecord({ ...base(record), failedAt: now });
/** The provider refused `model` at setup: it is not tried again for LATEST_LIVE.rejectedMs. */
export const afterRejected = (record, model, now) => (versionOfGeneralLive(model) === null ? base(record) : normalizeRecord({ ...base(record), rejected: { model, at: now } }));

/**
 * What a starting lane is told: { model, refresh }. `model` = the id to run instead of `current` (null: run `current`);
 * `refresh` = 'none' | 'background' | 'blocking' (LATEST_REFRESH). A clock that moved backwards makes the record stale, not fresh.
 */
export function decide({ record, now, current } = {}) {
  const rec = normalizeRecord(record);
  const refused = rec !== null && rec.rejected !== null && now - rec.rejected.at >= 0 && now - rec.rejected.at < LATEST_LIVE.rejectedMs;
  const candidate = rec !== null && rec.newest !== null && isAdoptable(rec.newest, current)
    && !(refused && rec.rejected.model === rec.newest) ? rec.newest : null;
  const age = rec === null ? Infinity : now - rec.checkedAt;
  const coolingDown = rec !== null && rec.failedAt !== null && now - rec.failedAt >= 0 && now - rec.failedAt < LATEST_LIVE.failureCooldownMs;
  let refresh = 'blocking';
  if (coolingDown || (age >= 0 && age < LATEST_LIVE.freshMs)) refresh = 'none';
  else if (age >= 0 && age < LATEST_LIVE.hardMs) refresh = 'background';
  // The record's own candidate was refused a moment ago: asking FIRST cannot change what this start runs (the look would find the
  // same model again), so the look is only for the next start.
  if (refresh === 'blocking' && refused && rec.newest !== null && rec.rejected.model === rec.newest) refresh = 'background';
  return Object.freeze({ model: candidate, refresh });
}

export const isRefresh = (value) => LATEST_REFRESH.includes(value);
