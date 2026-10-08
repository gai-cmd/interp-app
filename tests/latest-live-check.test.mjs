import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS } from '../app/providers/gemini/live-config.js';
import {
  GENERAL_LIVE_ID, LIVE_METHOD, compareGeneralLive, listLiveModelIds, newestGeneralLive, verdictOf, versionOfGeneralLive,
} from '../tools/check-latest-live.mjs';

// The account of 2026-10-08 (models.list): nine Live models, only one of them a general Live id.
const ACCOUNT_LIVE = Object.freeze([
  'gemini-3.5-transcribe-live', 'gemini-2.5-flash-native-audio-latest', 'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-2.5-flash-native-audio-preview-12-2025', 'gemini-3.1-flash-live-preview', 'gemini-3.8-live',
  'gemini-3.8-live-extended-thinking', 'gemini-robotics-er-2-streaming-preview', 'gemini-3.5-live-translate-preview',
]);

test('the general Live id rule: gemini-<major>.<minor>-live and nothing else', () => {
  for (const id of ['gemini-3.8-live', 'gemini-3.10-live', 'gemini-4.0-live', 'gemini-12.34-live']) assert.ok(GENERAL_LIVE_ID.test(id), id);
  for (const id of ACCOUNT_LIVE.filter((candidate) => candidate !== 'gemini-3.8-live')) assert.equal(versionOfGeneralLive(id), null, id);
  for (const id of ['gemini-3.8-live-preview', 'gemini-3.8-live ', ' gemini-3.8-live', 'gemini-3-live', 'gemini-3.8.1-live', 'GEMINI-3.8-LIVE',
    'models/gemini-3.8-live', 'gemini-300.8-live', 'gemini-3.800-live', '', null, undefined, 5, {}]) assert.equal(versionOfGeneralLive(id), null, String(id));
  assert.deepEqual(versionOfGeneralLive('gemini-3.8-live'), [3, 8]);
});

test('versions compare as numbers: 3.10 is newer than 3.8, 4.0 than 3.99', () => {
  assert.equal(compareGeneralLive('gemini-3.10-live', 'gemini-3.8-live'), 1);
  assert.equal(compareGeneralLive('gemini-3.8-live', 'gemini-3.10-live'), -1);
  assert.equal(compareGeneralLive('gemini-4.0-live', 'gemini-3.99-live'), 1);
  assert.equal(compareGeneralLive('gemini-3.8-live', 'gemini-3.8-live'), 0);
  assert.equal(compareGeneralLive('gemini-3.8-live', 'gemini-3.5-live-translate-preview'), null, 'a non-general id has no order');
});

test('newestGeneralLive ignores every model that is not a general Live id, with or without the models/ prefix', () => {
  assert.equal(newestGeneralLive(ACCOUNT_LIVE), 'gemini-3.8-live');
  assert.equal(newestGeneralLive([...ACCOUNT_LIVE, 'gemini-9.0-live-preview', 'gemini-9.0-live-extended-thinking']), 'gemini-3.8-live');
  assert.equal(newestGeneralLive(['models/gemini-3.8-live', 'models/gemini-3.10-live', 'gemini-3.9-live']), 'gemini-3.10-live');
  assert.equal(newestGeneralLive([]), null);
  assert.equal(newestGeneralLive(['gemini-3.5-live-translate-preview']), null);
  for (const garbage of [undefined, null, 'gemini-3.8-live', 5, {}]) assert.equal(newestGeneralLive(garbage), null);
});

test('the default of the repository is the newest general Live model of the account of 2026-10-08', () => {
  assert.equal(DEFAULT_LIVE_MODEL, 'gemini-3.8-live');
  assert.equal(LIVE_MODELS[0], DEFAULT_LIVE_MODEL);
  assert.deepEqual(verdictOf({ liveIds: ACCOUNT_LIVE }), { status: 'up-to-date', newest: 'gemini-3.8-live', current: DEFAULT_LIVE_MODEL });
});

test('verdictOf: a newer general model is "newer", a preview or a variant never is, a default that is no longer listed is urgent', () => {
  assert.equal(verdictOf({ liveIds: [...ACCOUNT_LIVE, 'gemini-3.9-live'] }).status, 'newer');
  assert.equal(verdictOf({ liveIds: [...ACCOUNT_LIVE, 'gemini-3.9-live'] }).newest, 'gemini-3.9-live');
  assert.equal(verdictOf({ liveIds: [...ACCOUNT_LIVE, 'gemini-3.10-live'] }).newest, 'gemini-3.10-live', 'numeric, not alphabetical');
  for (const extra of ['gemini-4.0-live-preview', 'gemini-4.0-live-extended-thinking', 'gemini-4.0-live-translate-preview', 'gemini-4.0-transcribe-live']) {
    assert.equal(verdictOf({ liveIds: [...ACCOUNT_LIVE, extra] }).status, 'up-to-date', extra);
  }
  const retired = verdictOf({ liveIds: ACCOUNT_LIVE.filter((id) => id !== 'gemini-3.8-live') });
  assert.equal(retired.status, 'default-not-listed');
  assert.equal(verdictOf({ liveIds: [] }).status, 'default-not-listed');
  assert.equal(verdictOf({ liveIds: ['models/gemini-3.8-live'] }).status, 'up-to-date', 'the models/ prefix is stripped');
  assert.equal(verdictOf({ current: 'gemini-3.5-live-translate-preview', liveIds: ACCOUNT_LIVE }).status, 'up-to-date', 'a non-general current has no newer general model by this rule');
});

const KEY = 'synthetic-key-for-tests-0123456789abcdef';
function pagedFetch(pages, log = []) {
  return async (url, init) => {
    const u = new URL(url);
    log.push({ href: u.href, headers: { ...init.headers }, method: init.method });
    const index = u.searchParams.get('pageToken') ? Number(u.searchParams.get('pageToken')) : 0;
    const page = pages[index];
    return { ok: true, status: 200, json: async () => page };
  };
}

test('listLiveModelIds follows nextPageToken, keeps only bidiGenerateContent models, sends the key in a header only', async () => {
  const log = [];
  const fetch = pagedFetch([
    { models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.1-flash-live-preview', supportedGenerationMethods: [LIVE_METHOD] }], nextPageToken: '1' },
    { models: [{ name: 'models/gemini-3.8-live', supportedGenerationMethods: ['countTokens', LIVE_METHOD] }, { name: 'models/gemini-3.8-live', supportedGenerationMethods: [LIVE_METHOD] }], nextPageToken: '2' },
    { models: [{ name: 'models/gemini-3.9-live', supportedGenerationMethods: [LIVE_METHOD] }] },
  ], log);
  const ids = await listLiveModelIds({ fetch, key: KEY });
  assert.deepEqual([...ids], ['gemini-3.1-flash-live-preview', 'gemini-3.8-live', 'gemini-3.9-live'], 'the Live models of ALL pages, each once');
  assert.equal(log.length, 3);
  for (const call of log) {
    assert.equal(call.method, 'GET');
    assert.equal(new URL(call.href).searchParams.get('pageSize'), '1000');
    assert.equal(call.headers['x-goog-api-key'], KEY, 'the key is a header');
    assert.equal(call.href.includes(KEY), false, 'and never part of the URL');
  }
  assert.equal(JSON.stringify(ids).includes(KEY), false);
});

test('the first page alone is not enough: a Live model on page 2 is found (the 2026-10-08 failure of model-discovery.js)', async () => {
  const fetch = pagedFetch([
    { models: Array.from({ length: 50 }, (_, index) => ({ name: `models/gemini-x${index}`, supportedGenerationMethods: ['generateContent'] })), nextPageToken: '1' },
    { models: [{ name: 'models/gemini-3.8-live', supportedGenerationMethods: [LIVE_METHOD] }] },
  ]);
  assert.deepEqual([...await listLiveModelIds({ fetch, key: KEY })], ['gemini-3.8-live']);
});

test('listLiveModelIds fails with codes only: bad key, quota, network, a reply that is not a model list, and a page loop', async () => {
  const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const code = async (options) => { try { await listLiveModelIds({ key: KEY, ...options }); return null; } catch (error) { return error.code; } };
  assert.equal(await code({ fetch: reply(401, {}) }), 'INVALID_KEY');
  assert.equal(await code({ fetch: reply(403, {}) }), 'INVALID_KEY');
  assert.equal(await code({ fetch: reply(429, {}) }), 'RATE_LIMITED');
  assert.equal(await code({ fetch: reply(500, {}) }), 'NETWORK_ERROR');
  assert.equal(await code({ fetch: async () => { throw new Error('offline'); } }), 'NETWORK_ERROR');
  assert.equal(await code({ fetch: reply(200, { nope: true }) }), 'INVALID_RESULT');
  assert.equal(await code({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) }), 'INVALID_RESULT');
  assert.equal(await code({ fetch: reply(200, { models: [], nextPageToken: 'again' }) }), 'INVALID_RESULT', 'a list that never ends is refused after maxPages');
  assert.equal(await code({ key: '' , fetch: reply(200, { models: [] }) }), 'INVALID_KEY');
  // the error never carries the key
  try { await listLiveModelIds({ key: KEY, fetch: reply(401, {}) }); } catch (error) { assert.equal(String(error.stack).includes(KEY), false); }
});

test('ids that are not plain model ids are dropped, so a hostile reply cannot put a path or markup into the result', async () => {
  const fetch = pagedFetch([{ models: [
    { name: 'models/../etc/passwd', supportedGenerationMethods: [LIVE_METHOD] },
    { name: 'models/<script>', supportedGenerationMethods: [LIVE_METHOD] },
    { name: 'models/gemini-3.8-live', supportedGenerationMethods: [LIVE_METHOD] },
    { name: 5, supportedGenerationMethods: [LIVE_METHOD] },
    { name: 'models/gemini-3.9-live', supportedGenerationMethods: LIVE_METHOD },
  ] }]);
  assert.deepEqual([...await listLiveModelIds({ fetch, key: KEY })], ['gemini-3.8-live']);
});
