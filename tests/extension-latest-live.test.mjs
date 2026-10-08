import test from 'node:test';
import assert from 'node:assert/strict';
import { REST_ENDPOINT } from '../app/providers/gemini/config.js';
import { DEFAULT_LIVE_MODEL, TRANSLATE_LIVE_MODEL } from '../app/providers/gemini/live-config.js';
import { createLaneEngine, laneSocket } from '../extension/engine/lane-engine.js';
import { createMicLane } from '../extension/engine/mic-lane.js';
import { GENERAL_LIVE_ID, LATEST_REFRESH } from '../extension/lib/constants.js';
import {
  LATEST_LIVE, LIVE_METHOD, MODELS_ENDPOINT, afterFailure, afterRejected, afterSeen, compareGeneralLive, decide, isAdoptable,
  listLiveModelIds, newestGeneralLive, normalizeRecord, verdictOf, versionOfGeneralLive,
} from '../extension/lib/latest-live.js';
import { laneStateFromSnapshot } from '../extension/lib/ui-state.js';
import { createRig, fakeKey, tick } from './fixtures/extension-lanes.mjs';

// docs/extension.md §24 (0.5.2): "always the latest Google Live model". The pure half (which ids count, what the worker
// remembers, how a lane asks) and the lane engine's half (the wire substitution, the fall back, the look at the provider).

const LATEST = 'gemini-3.9-live';
const NOT_FOUND = `models/${LATEST} is not found for API version v1beta, or is not supported for bidiGenerateContent. Call ModelService.`;
const REFUSED = 'API key not valid. Please pass a valid API key.';
// The account of 2026-10-08 (models.list): nine Live models, one of them a general Live id.
const ACCOUNT_LIVE = Object.freeze([
  'gemini-3.5-transcribe-live', 'gemini-2.5-flash-native-audio-latest', 'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-2.5-flash-native-audio-preview-12-2025', 'gemini-3.1-flash-live-preview', 'gemini-3.8-live',
  'gemini-3.8-live-extended-thinking', 'gemini-robotics-er-2-streaming-preview', 'gemini-3.5-live-translate-preview',
]);

// ---------------------------------------------------------------------------------------------
// The pure half.

test('the model list address is the provider\'s REST_ENDPOINT, and the shared patterns are what the wire validates', () => {
  assert.equal(MODELS_ENDPOINT, REST_ENDPOINT);
  assert.equal(LIVE_METHOD, 'bidiGenerateContent');
  assert.ok(GENERAL_LIVE_ID instanceof RegExp);
  assert.deepEqual([...LATEST_REFRESH], ['none', 'background', 'blocking']);
  assert.ok(Object.isFrozen(LATEST_LIVE) && Object.isFrozen(LATEST_REFRESH));
});

test('the general Live id rule: gemini-<major>.<minor>-live and nothing else; versions compare as numbers', () => {
  for (const id of ['gemini-3.8-live', 'gemini-3.10-live', 'gemini-4.0-live', 'gemini-12.34-live']) assert.ok(GENERAL_LIVE_ID.test(id), id);
  for (const id of ACCOUNT_LIVE.filter((candidate) => candidate !== DEFAULT_LIVE_MODEL)) assert.equal(versionOfGeneralLive(id), null, id);
  for (const id of ['gemini-3.8-live-preview', 'gemini-3.8-live ', ' gemini-3.8-live', 'gemini-3-live', 'gemini-3.8.1-live', 'GEMINI-3.8-LIVE',
    'models/gemini-3.8-live', 'gemini-300.8-live', 'gemini-3.800-live', '', null, undefined, 5, {}]) assert.equal(versionOfGeneralLive(id), null, String(id));
  assert.equal(compareGeneralLive('gemini-3.10-live', 'gemini-3.8-live'), 1);
  assert.equal(compareGeneralLive('gemini-3.8-live', 'gemini-3.10-live'), -1);
  assert.equal(compareGeneralLive('gemini-4.0-live', 'gemini-3.99-live'), 1);
  assert.equal(compareGeneralLive('gemini-3.8-live', 'gemini-3.8-live'), 0);
  assert.equal(compareGeneralLive('gemini-3.8-live', TRANSLATE_LIVE_MODEL), null);
  assert.equal(isAdoptable(LATEST, DEFAULT_LIVE_MODEL), true);
  for (const id of [DEFAULT_LIVE_MODEL, 'gemini-3.7-live', TRANSLATE_LIVE_MODEL, 'gemini-4.0-live-preview', null, undefined, 'models/gemini-4.0-live']) {
    assert.equal(isAdoptable(id, DEFAULT_LIVE_MODEL), false, String(id));
  }
});

test('newestGeneralLive and verdictOf: only a general model counts, whatever its number; a default that is no longer listed is urgent', () => {
  assert.equal(newestGeneralLive(ACCOUNT_LIVE), DEFAULT_LIVE_MODEL);
  assert.equal(newestGeneralLive([...ACCOUNT_LIVE, 'gemini-9.0-live-preview', 'gemini-9.0-live-extended-thinking']), DEFAULT_LIVE_MODEL);
  assert.equal(newestGeneralLive(['models/gemini-3.8-live', 'models/gemini-3.10-live', 'gemini-3.9-live']), 'gemini-3.10-live');
  assert.equal(newestGeneralLive([]), null);
  for (const garbage of [undefined, null, 'gemini-3.8-live', 5, {}]) assert.equal(newestGeneralLive(garbage), null);
  const verdict = (liveIds) => verdictOf({ current: DEFAULT_LIVE_MODEL, liveIds });
  assert.deepEqual(verdict(ACCOUNT_LIVE), { status: 'up-to-date', newest: DEFAULT_LIVE_MODEL, current: DEFAULT_LIVE_MODEL });
  assert.equal(verdict([...ACCOUNT_LIVE, LATEST]).status, 'newer');
  assert.equal(verdict([...ACCOUNT_LIVE, 'gemini-3.10-live']).newest, 'gemini-3.10-live');
  assert.equal(verdict([...ACCOUNT_LIVE, 'gemini-4.0-live-preview']).status, 'up-to-date');
  assert.equal(verdict(ACCOUNT_LIVE.filter((id) => id !== DEFAULT_LIVE_MODEL)).status, 'default-not-listed');
  assert.equal(verdict([]).status, 'default-not-listed');
});

const KEY = 'synthetic-key-for-tests-0123456789abcdef';
const liveEntry = (id, methods = [LIVE_METHOD]) => ({ name: `models/${id}`, supportedGenerationMethods: methods });
function pagedFetch(pages, log = []) {
  return async (url, init) => {
    const u = new URL(url);
    log.push({ href: u.href, headers: { ...init.headers }, method: init.method, signal: init.signal });
    const index = u.searchParams.get('pageToken') ? Number(u.searchParams.get('pageToken')) : 0;
    return { ok: true, status: 200, json: async () => pages[index] };
  };
}

test('listLiveModelIds follows nextPageToken, keeps only bidiGenerateContent models, and sends the key in a header only', async () => {
  const log = [];
  const fetch = pagedFetch([
    { models: [liveEntry('gemini-3.5-flash', ['generateContent']), liveEntry('gemini-3.1-flash-live-preview')], nextPageToken: '1' },
    { models: [liveEntry(DEFAULT_LIVE_MODEL, ['countTokens', LIVE_METHOD]), liveEntry(DEFAULT_LIVE_MODEL)], nextPageToken: '2' },
    { models: [liveEntry(LATEST)] },
  ], log);
  const ids = await listLiveModelIds({ fetch, key: KEY });
  assert.deepEqual([...ids], ['gemini-3.1-flash-live-preview', DEFAULT_LIVE_MODEL, LATEST], 'the Live models of ALL pages, each once');
  assert.equal(log.length, 3);
  for (const call of log) {
    assert.equal(call.method, 'GET');
    assert.equal(new URL(call.href).searchParams.get('pageSize'), '1000');
    assert.equal(call.headers['x-goog-api-key'], KEY, 'the key is a header');
    assert.equal(call.href.includes(KEY), false, 'and never part of the URL');
  }
  assert.equal(JSON.stringify(ids).includes(KEY), false);
  // the first page alone is not enough (the failure of app/providers/gemini/model-discovery.js on a 62-model account)
  const second = pagedFetch([{ models: Array.from({ length: 50 }, (_, index) => liveEntry(`gemini-x${index}`, ['generateContent'])), nextPageToken: '1' },
    { models: [liveEntry(DEFAULT_LIVE_MODEL)] }]);
  assert.deepEqual([...await listLiveModelIds({ fetch: second, key: KEY })], [DEFAULT_LIVE_MODEL]);
});

test('listLiveModelIds fails with codes only, passes the caller\'s signal on, and drops ids that are not plain model ids', async () => {
  const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const code = async (options) => { try { await listLiveModelIds({ key: KEY, ...options }); return null; } catch (error) { return error.code; } };
  assert.equal(await code({ fetch: reply(401, {}) }), 'INVALID_KEY');
  assert.equal(await code({ fetch: reply(403, {}) }), 'INVALID_KEY');
  const bad400 = (text) => async () => ({ ok: false, status: 400, text: async () => text, json: async () => JSON.parse(text) });
  assert.equal(await code({ fetch: bad400('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}') }), 'INVALID_KEY', 'the real answer to a dead key');
  assert.equal(await code({ fetch: bad400('{"error":{"code":400,"message":"Bad request"}}') }), 'NETWORK_ERROR');
  assert.equal(await code({ fetch: reply(400, {}) }), 'NETWORK_ERROR');
  assert.equal(await code({ fetch: reply(429, {}) }), 'RATE_LIMITED');
  assert.equal(await code({ fetch: reply(500, {}) }), 'NETWORK_ERROR');
  assert.equal(await code({ fetch: async () => { throw new Error('offline'); } }), 'NETWORK_ERROR');
  assert.equal(await code({ fetch: reply(200, { nope: true }) }), 'INVALID_RESULT');
  assert.equal(await code({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) }), 'INVALID_RESULT');
  assert.equal(await code({ fetch: reply(200, { models: [], nextPageToken: 'again' }) }), 'INVALID_RESULT', 'a list that never ends is refused after maxPages');
  assert.equal(await code({ key: '', fetch: reply(200, { models: [] }) }), 'INVALID_KEY');
  assert.equal(await code({ fetch: undefined }), 'INVALID_KEY');
  try { await listLiveModelIds({ key: KEY, fetch: reply(401, {}) }); } catch (error) { assert.equal(String(error.stack).includes(KEY), false); }
  const signal = new AbortController().signal;
  let seen;
  await listLiveModelIds({ key: KEY, signal, fetch: async (url, init) => { seen = init.signal; return { ok: true, status: 200, json: async () => ({ models: [] }) }; } });
  assert.equal(seen, signal);
  const hostile = pagedFetch([{ models: [{ name: 'models/../etc/passwd', supportedGenerationMethods: [LIVE_METHOD] },
    { name: 'models/<script>', supportedGenerationMethods: [LIVE_METHOD] }, liveEntry(DEFAULT_LIVE_MODEL), { name: 5, supportedGenerationMethods: [LIVE_METHOD] },
    { name: `models/${LATEST}`, supportedGenerationMethods: LIVE_METHOD }] }]);
  assert.deepEqual([...await listLiveModelIds({ fetch: hostile, key: KEY })], [DEFAULT_LIVE_MODEL]);
});

test('the record: exactly this version, ids that are general Live ids, integers; anything else is no record', () => {
  const good = { v: 1, newest: LATEST, checkedAt: 5, failedAt: null, rejected: null };
  assert.deepEqual(normalizeRecord(good), good);
  assert.deepEqual(normalizeRecord({ ...good, newest: null, failedAt: 3, rejected: { model: LATEST, at: 4 } }), { ...good, newest: null, failedAt: 3, rejected: { model: LATEST, at: 4 } });
  for (const bad of [undefined, null, 5, 'x', [], {}, { ...good, v: 2 }, { ...good, newest: 'gemini-9-live' }, { ...good, newest: TRANSLATE_LIVE_MODEL },
    { ...good, newest: undefined }, { ...good, checkedAt: -1 }, { ...good, checkedAt: 1.5 }, { ...good, checkedAt: '5' }, { ...good, failedAt: undefined },
    { ...good, failedAt: -2 }, { ...good, rejected: undefined }, { ...good, rejected: { model: 'x', at: 1 } }, { ...good, rejected: { model: LATEST } },
    { ...good, rejected: [] }, { v: 1 }]) {
    assert.equal(normalizeRecord(bad), null, JSON.stringify(bad));
  }
  assert.ok(Object.isFrozen(normalizeRecord(good)));
});

test('afterSeen, afterFailure and afterRejected: each changes only its own field, and a damaged record restarts from nothing', () => {
  const none = null;
  assert.deepEqual(afterSeen(none, LATEST, 100), { v: 1, newest: LATEST, checkedAt: 100, failedAt: null, rejected: null });
  assert.deepEqual(afterSeen(none, null, 100).newest, null);
  assert.equal(afterSeen(none, TRANSLATE_LIVE_MODEL, 100).newest, null, 'a model that is not a general Live id is never remembered as the newest');
  const seen = afterSeen(none, LATEST, 100);
  assert.deepEqual(afterFailure(seen, 150), { ...seen, failedAt: 150 });
  assert.equal(afterSeen(afterFailure(seen, 150), LATEST, 200).failedAt, null, 'a successful look ends the cool-down');
  assert.deepEqual(afterRejected(seen, LATEST, 160), { ...seen, rejected: { model: LATEST, at: 160 } });
  assert.deepEqual(afterRejected(seen, TRANSLATE_LIVE_MODEL, 160), seen, 'a model that is not a general Live id is not remembered as refused');
  assert.equal(afterSeen(seen, 'gemini-4.0-live', 300).rejected, null, 'an earlier refusal stays only when nothing replaced it');
  assert.deepEqual(afterRejected(afterSeen(seen, 'gemini-4.0-live', 300), LATEST, 310).newest, 'gemini-4.0-live');
  assert.deepEqual(afterFailure({ junk: true }, 7), { v: 1, newest: null, checkedAt: 0, failedAt: 7, rejected: null });
  // a look that SUCCEEDS keeps an earlier refusal (otherwise the next start would try the refused model again, for ever)
  const refused = afterRejected(seen, LATEST, 160);
  assert.deepEqual(afterSeen(refused, LATEST, 500).rejected, { model: LATEST, at: 160 });
  assert.deepEqual(afterFailure(refused, 600).rejected, { model: LATEST, at: 160 });
});

test('decide: the model to run and whether to look, from the age of the record', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * 24 * HOUR;
  const record = (extra = {}) => ({ v: 1, newest: LATEST, checkedAt: now - 5 * 60 * 1000, failedAt: null, rejected: null, ...extra });
  const of = (rec, at = now) => decide({ record: rec, now: at, current: DEFAULT_LIVE_MODEL });
  assert.deepEqual(of(undefined), { model: null, refresh: 'blocking' }, 'no record: ask first');
  assert.deepEqual(of({ junk: true }), { model: null, refresh: 'blocking' }, 'a damaged record is no record');
  assert.deepEqual(of(record()), { model: LATEST, refresh: 'none' }, 'fresh: used as it is');
  assert.deepEqual(of(record({ checkedAt: now - 2 * HOUR })), { model: LATEST, refresh: 'background' }, 'stale: used, and asked again in the background');
  assert.deepEqual(of(record({ checkedAt: now - 30 * HOUR })), { model: LATEST, refresh: 'background' }, 'a person who starts once a day never waits for the provider');
  assert.deepEqual(of(record({ checkedAt: now - 6 * 24 * HOUR })), { model: LATEST, refresh: 'background' });
  assert.deepEqual(of(record({ checkedAt: now - 8 * 24 * HOUR })), { model: LATEST, refresh: 'blocking' }, 'expired (a week): ask first (the record still names a candidate)');
  assert.equal(of(record({ newest: DEFAULT_LIVE_MODEL })).model, null, 'the newest is the default itself: nothing to adopt');
  assert.equal(of(record({ newest: 'gemini-3.7-live' })).model, null, 'older than the default: nothing to adopt');
  assert.equal(of(record({ newest: null })).model, null);
  // a failed look is not repeated at once, whatever the age
  assert.equal(of(record({ checkedAt: 0, failedAt: now - 60 * 1000 })).refresh, 'none');
  assert.equal(of(record({ checkedAt: 0, failedAt: now - 11 * 60 * 1000 })).refresh, 'blocking');
  // a refused model is left alone for six hours, and only THAT model
  assert.equal(of(record({ rejected: { model: LATEST, at: now - HOUR } })).model, null);
  // asking FIRST cannot change what a start runs when the record's own candidate was refused: the look is for the next start
  assert.deepEqual(of(record({ checkedAt: now - 8 * 24 * HOUR, rejected: { model: LATEST, at: now - HOUR } })), { model: null, refresh: 'background' });
  assert.equal(of(record({ checkedAt: now - 8 * 24 * HOUR, newest: 'gemini-4.0-live', rejected: { model: LATEST, at: now - HOUR } })).refresh, 'blocking', 'another model than the refused one: ask first as usual');
  assert.equal(of(record({ rejected: { model: LATEST, at: now - 7 * HOUR } })).model, LATEST);
  assert.equal(of(record({ newest: 'gemini-4.0-live', rejected: { model: LATEST, at: now - HOUR } })).model, 'gemini-4.0-live');
  // a clock that went back makes the record stale, never fresh for ever
  assert.equal(of(record({ checkedAt: 0, failedAt: now + 5 * HOUR })).refresh, 'blocking', 'a failed look from the future is no cool-down');
  assert.equal(of(record({ checkedAt: now + 5 * HOUR })).refresh, 'blocking');
  assert.equal(of(record({ rejected: { model: LATEST, at: now + HOUR } })).model, LATEST, 'a refusal from the future is no refusal');
  assert.equal(decide({ record: record(), now, current: 'not-a-model' }).model, null);
  assert.ok(Object.isFrozen(of(record())));
});

// ---------------------------------------------------------------------------------------------
// The lane engine over the real engine and fake sockets.

const POOL = Object.freeze([fakeKey('latest-a'), fakeKey('latest-b'), fakeKey('latest-c')]);
const keyOf = (url) => decodeURIComponent(new URL(url).searchParams.get('key'));
const stateOf = (lane) => laneStateFromSnapshot({ lane: 'mic', snapshot: lane.snapshot(), facts: lane.facts(), level: lane.level() });
async function until(check, what, limit = 300) {
  for (let step = 0; step < limit; step += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
const modelsReply = (ids) => ({ ok: true, status: 200, json: async () => ({ models: ids.map((id) => liveEntry(id)) }) });
function newMic(rig, { fetch, events = [], onChange = () => {} } = {}) {
  const env = fetch === undefined ? rig.env : { ...rig.env, fetch };
  return createMicLane({ env, timers: rig.clock, onChange, onLatest: (event) => events.push(event) });
}
async function params(rig, { latest, pool = false, model = DEFAULT_LIVE_MODEL, ...options } = {}) {
  const { key, ...rest } = await rig.laneParams('mic', { model, ...options });
  return { ...rest, ...(pool ? { keys: [...POOL] } : { key }), ...(latest === undefined ? {} : { latest }) };
}
async function nextSocket(rig, index) {
  await until(() => rig.audio.worklets.length > 0, 'a capture worklet');
  for (let round = 0; round < 50 && rig.sockets.sockets.length <= index; round += 1) {
    rig.audio.worklets.at(-1).emitFrames(0.25);
    await tick();
  }
  assert.ok(rig.sockets.sockets.length > index, `socket ${index} opened`);
  return rig.sockets.sockets[index];
}
// The virtual clock, with the microphone still delivering frames (a capture that hears nothing for seconds is a lost capture).
async function advanceWithFrames(rig, ms, step = 250) {
  for (let spent = 0; spent < ms; spent += step) {
    rig.audio.worklets.at(-1)?.emitFrames(0.25);
    await rig.clock.advance(Math.min(step, ms - spent));
    await tick();
  }
}
const modelOf = (socket) => { if (socket.sent.length === 0) socket.open(); return socket.sent[0].setup.model; };
const ready = (socket) => { socket.open(); socket.json({ setupComplete: {} }); };

test('an adopted model: only the first frame of a socket is rewritten, and the lane says which model really runs', async (t) => {
  const rig = createRig();
  const events = [];
  const lane = newMic(rig, { events });
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { latest: { model: LATEST, refresh: 'none' } }));
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${LATEST}`, 'the setup names the latest model');
  assert.equal(socket.sent[0].setup.generationConfig !== undefined, true, 'the rest of the setup is the default model\'s');
  socket.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'running');
  assert.equal(lane.snapshot().model, LATEST, 'the lane reports the model that runs');
  assert.equal(stateOf(lane).model, LATEST);
  assert.equal(lane.snapshot().fallback, false);
  for (const frame of socket.sent.slice(1)) assert.equal(JSON.stringify(frame).includes('models/gemini'), false, 'later frames are not touched');
  assert.deepEqual(events, [], 'refresh none: nothing asked, nothing reported');
  assert.equal(keyOf(rig.urls[0]).startsWith('synthetic-'), true);
});

test('a model the person chose, or an id that is no newer general Live model, is never replaced or adopted', async (t) => {
  for (const [model, latest] of [[TRANSLATE_LIVE_MODEL, LATEST], [DEFAULT_LIVE_MODEL, TRANSLATE_LIVE_MODEL], [DEFAULT_LIVE_MODEL, 'gemini-3.7-live'],
    [DEFAULT_LIVE_MODEL, DEFAULT_LIVE_MODEL], [DEFAULT_LIVE_MODEL, 'gemini-4.0-live-preview'], [DEFAULT_LIVE_MODEL, null]]) {
    const rig = createRig();
    const fetch = async () => { throw new Error('nothing may be asked'); };
    const lane = newMic(rig, { fetch });
    t.after(() => lane.dispose());
    await lane.start(await params(rig, { model, latest: { model: latest, refresh: 'none' } }));
    const socket = await nextSocket(rig, 0);
    socket.open();
    assert.equal(modelOf(socket), `models/${model}`, `${model} with ${latest}`);
    await lane.dispose();
  }
  // refresh 'blocking' on a lane that runs a model the person chose: not even a look
  const rig = createRig();
  let asked = 0;
  const lane = newMic(rig, { fetch: async () => { asked += 1; return modelsReply([LATEST]); } });
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { model: TRANSLATE_LIVE_MODEL, latest: { model: null, refresh: 'blocking' } }));
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${TRANSLATE_LIVE_MODEL}`);
  assert.equal(asked, 0);
});

test('the provider refuses the adopted model (the real close): back to the default at once, the key stays, the refusal is reported once', async (t) => {
  for (const pool of [false, true]) {
    const rig = createRig();
    const events = [];
    const phases = [];
    const lane = newMic(rig, { events, onChange: () => phases.push(stateOf(lane)) });
    t.after(() => lane.dispose());
    await lane.start(await params(rig, { pool, latest: { model: LATEST, refresh: 'none' } }));
    const first = await nextSocket(rig, 0);
    first.open();
    assert.equal(modelOf(first), `models/${LATEST}`);
    first.finishClose(1008, NOT_FOUND);
    const second = await nextSocket(rig, 1);
    assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`, `pool=${pool}: the default model, no fake time passed`);
    second.open();
    second.json({ setupComplete: {} });
    await until(() => lane.phase() === 'running', 'running on the default model');
    assert.equal(rig.sockets.sockets.length, 2, 'asked once, not three more times with backoff');
    assert.equal(keyOf(rig.urls[1]), keyOf(rig.urls[0]), 'the same key: a refused MODEL says nothing about the key (the pool was not burned)');
    assert.equal(lane.snapshot().model, DEFAULT_LIVE_MODEL);
    assert.equal(lane.snapshot().fallback, false, 'and it is not a "backup model"');
    assert.deepEqual(events, [{ kind: 'rejected', model: LATEST }]);
    assert.equal(phases.some((state) => state.phase === 'error' || state.errorCode !== null), false, 'never read as a failure');
    assert.equal(phases.some((state) => state.phase === 'off'), false, 'nor as a stop');
    await rig.clock.advance(60_000);
    await tick();
    assert.equal(rig.sockets.sockets.length, 2, 'nothing more happens');
    await lane.dispose();
  }
});

test('a transient failure of the adopted model (a lost connection, an outage, a hang) also goes back to the default, and is NOT reported as a refusal', async (t) => {
  for (const [code, reason] of [[1006, ''], [1011, 'UNAVAILABLE: the service is overloaded'], [1013, ''], [1008, 'UNAVAILABLE']]) {
    const rig = createRig();
    const events = [];
    const lane = newMic(rig, { events });
    t.after(() => lane.dispose());
    await lane.start(await params(rig, { latest: { model: LATEST, refresh: 'none' } }));
    const first = await nextSocket(rig, 0);
    first.open();
    first.finishClose(code, reason);
    const second = await nextSocket(rig, 1);
    assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`, `${code} ${reason}`);
    assert.deepEqual(events, [], `${code} ${reason}: nothing is remembered about the model`);
    await lane.dispose();
  }
  // a hang: the Live client gives up on the setup after its own timeout (real time) and closes the socket itself with 1000
  const rig = createRig();
  const lane = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { latest: { model: LATEST, refresh: 'none' } }));
  const first = await nextSocket(rig, 0);
  first.open();
  first.finishClose(1000, '');
  const second = await nextSocket(rig, 1);
  assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`, 'a setup that never completes is the model\'s failure too');
});

test('a model the provider does not take can never burn the key pool: an unknown 1007/1008 on the adopted socket is the MODEL\'s', async (t) => {
  for (const [code, reason] of [[1007, 'Unsupported field in setup: generationConfig.something'], [1008, 'Operation is not implemented, or supported, or enabled.'], [1007, ''], [1008, '']]) {
    const rig = createRig();
    const events = [];
    const lane = newMic(rig, { events });
    t.after(() => lane.dispose());
    await lane.start(await params(rig, { pool: true, latest: { model: LATEST, refresh: 'none' } }));
    const first = await nextSocket(rig, 0);
    first.open();
    first.finishClose(code, reason);
    const second = await nextSocket(rig, 1);
    assert.equal(keyOf(rig.urls[1]), POOL[0], `${code} "${reason}": the SAME key (without the adopted model this close reads as a refused key)`);
    assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`);
    assert.deepEqual(events, [{ kind: 'rejected', model: LATEST }]);
    await lane.dispose();
  }
  // the contrast: the same close on a socket that runs the default model is a refused key and moves the pool on (§20)
  const rig = createRig();
  const lane = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { pool: true, latest: { model: null, refresh: 'none' } }));
  const first = await nextSocket(rig, 0);
  first.open();
  first.finishClose(1008, 'Operation is not implemented, or supported, or enabled.');
  await nextSocket(rig, 1);
  assert.equal(keyOf(rig.urls[1]), POOL[1]);
});

test('a key the REASON names as refused is the key\'s fault, not the model\'s: the pool moves on and the adopted model stays', async (t) => {
  const rig = createRig();
  const events = [];
  const lane = newMic(rig, { events });
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { pool: true, latest: { model: LATEST, refresh: 'none' } }));
  const first = await nextSocket(rig, 0);
  first.open();
  first.finishClose(1007, REFUSED);
  const second = await nextSocket(rig, 1);
  assert.equal(keyOf(rig.urls[1]), POOL[1], 'the next key');
  assert.equal(modelOf(second), `models/${LATEST}`, 'still the latest model');
  assert.deepEqual(events, []);
  ready(second);
  await until(() => lane.phase() === 'running', 'running');
  assert.equal(lane.snapshot().model, LATEST);
});

test('a QUOTA or a permission wording on the adopted socket before its setup gets the default model its one attempt FIRST, with the same key; after the setup a quota is the key swap\'s', async (t) => {
  for (const [code, reason] of [[1011, 'RESOURCE_EXHAUSTED: quota'], [1008, 'The caller does not have permission'], [1008, 'Requests to this API generativelanguage.googleapis.com method are blocked.'],
    [1008, 'Model gemini-3.9-live is disabled for this project']]) {
    const rig = createRig();
    const events = [];
    const lane = newMic(rig, { events });
    t.after(() => lane.dispose());
    await lane.start(await params(rig, { pool: true, latest: { model: LATEST, refresh: 'none' } }));
    const first = await nextSocket(rig, 0);
    first.open();
    first.finishClose(code, reason);
    const second = await nextSocket(rig, 1);
    assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`, `${code} ${reason}: the default model first`);
    assert.equal(keyOf(rig.urls[1]), POOL[0], 'the same key: the pool is not cycled with a model that may be the one at fault');
    assert.deepEqual(events, [{ kind: 'rejected', model: LATEST }], 'and the worker leaves that model alone for a while');
    await lane.dispose();
  }
  // AFTER the setup a quota is the key swap's: the pool moves on and the latest model stays
  const quota = createRig();
  const events = [];
  const lane = newMic(quota, { events });
  t.after(() => lane.dispose());
  await lane.start(await params(quota, { pool: true, latest: { model: LATEST, refresh: 'none' } }));
  const first = await nextSocket(quota, 0);
  ready(first);
  await until(() => lane.phase() === 'running', 'running');
  first.finishClose(1011, 'RESOURCE_EXHAUSTED: quota');
  const second = await nextSocket(quota, 1);
  assert.equal(modelOf(second), `models/${LATEST}`, 'the swap goes on with the latest model');
  assert.equal(keyOf(quota.urls[1]), POOL[1]);
  assert.deepEqual(events, []);
});

test('a close WE asked for (a Stop, a key switch, the engine ending its own run) is nobody\'s fault, and a stalled setup is the model\'s after LATEST_LIVE.setupWatchdogMs', async (t) => {
  const stopped = createRig();
  const stoppedEvents = [];
  const other = newMic(stopped, { events: stoppedEvents });
  t.after(() => other.dispose());
  await other.start(await params(stopped, { latest: { model: LATEST, refresh: 'none' } }));
  const pending = await nextSocket(stopped, 0);
  pending.open();
  await other.stop();
  await advanceWithFrames(stopped, 5000);
  assert.equal(stopped.sockets.sockets.length, 1, 'a Stop starts nothing');
  assert.deepEqual(stoppedEvents, []);

  const stall = createRig();
  const events = [];
  const lane = newMic(stall, { events });
  t.after(() => lane.dispose());
  await lane.start(await params(stall, { latest: { model: LATEST, refresh: 'none' } }));
  const first = await nextSocket(stall, 0);
  first.open();
  await advanceWithFrames(stall, LATEST_LIVE.setupWatchdogMs - 500);
  assert.equal(stall.sockets.sockets.length, 1, 'a setup that is merely slow is waited for');
  await advanceWithFrames(stall, 1000);
  const second = await nextSocket(stall, 1);
  assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`, 'the model never answered: back to the default, long before the client\'s own 10 s');
  assert.deepEqual(events, [{ kind: 'rejected', model: LATEST }]);
  ready(second);
  await until(() => lane.phase() === 'running', 'running on the default');
});

// A setup that RESUMES a session carries a handle the provider may refuse on its own account: that is the engine's own retry
// (same model, without the handle), not the model's failure. Unit level: the socket class over a scripted base class.
test('laneSocket: a refused RESUMED setup, a close we called for, and an explicit key refusal never blame the adopted model; the same close of a fresh setup does', () => {
  const clockCalls = [];
  const cleared = [];
  const sent = [];
  class Base {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    send(data) { sent.push(data); }
    close() { this.closedByUs = true; }
    emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  }
  const setup = (extra = {}) => JSON.stringify({ setup: { model: `models/${DEFAULT_LIVE_MODEL}`, generationConfig: { responseModalities: ['AUDIO'] }, ...extra } });
  const make = () => {
    const failures = [], refusals = [];
    const adoption = { model: LATEST, revoked: false, applied: false };
    const Socket = laneSocket(Base, { adoption, onRefusal: (code) => refusals.push(code), onAdoptionFailed: (kind) => failures.push(kind),
      onApplied() {}, now: () => 0, setTimeout: (fn, ms) => { clockCalls.push(ms); return clockCalls.length; }, clearTimeout: (handle) => cleared.push(handle) });
    return { Socket, failures, refusals, adoption };
  };
  const NOT_FOUND_CLOSE = { code: 1008, reason: `models/${LATEST} is not found for API version v1beta, or is not supported for bidiGenerateContent.` };
  // a fresh setup refused: the model's
  let m = make();
  let socket = new m.Socket();
  socket.send(setup());
  assert.equal(JSON.parse(sent.at(-1)).setup.model, `models/${LATEST}`, 'the first frame is rewritten');
  socket.emit('close', NOT_FOUND_CLOSE);
  assert.deepEqual([m.failures, m.refusals], [['rejected'], []]);
  // the same refusal of a RESUMING setup: not the model's (the engine retries without the handle)
  m = make();
  socket = new m.Socket();
  socket.send(setup({ sessionResumption: { handle: 'h-1' } }));
  assert.equal(JSON.parse(sent.at(-1)).setup.model, `models/${LATEST}`);
  socket.emit('close', NOT_FOUND_CLOSE);
  assert.deepEqual([m.failures, m.refusals], [[], []]);
  // a close somebody on our side called for
  m = make();
  socket = new m.Socket();
  socket.send(setup());
  socket.close();
  socket.emit('close', { code: 1000, reason: '' });
  assert.deepEqual([m.failures, m.refusals], [[], []]);
  // a key the reason names as refused: the key's fault, whatever was sent
  for (const sentSetup of [setup(), setup({ sessionResumption: { handle: 'h-1' } })]) {
    m = make();
    socket = new m.Socket();
    socket.send(sentSetup);
    socket.emit('close', { code: 1007, reason: 'API key not valid. Please pass a valid API key.' });
    assert.deepEqual([m.failures, m.refusals], [[], ['INVALID_KEY']]);
  }
  // only the FIRST frame is a setup; a socket that sent anything else first, or a setup of another model, is left alone
  m = make();
  socket = new m.Socket();
  socket.send('{"realtimeInput":{}}');
  socket.send(setup());
  assert.equal(JSON.parse(sent.at(-1)).setup.model, `models/${DEFAULT_LIVE_MODEL}`);
  socket.emit('close', { code: 1008, reason: 'Operation is not implemented, or supported, or enabled.' });
  assert.deepEqual([m.failures, m.refusals], [[], ['PERMISSION_DENIED']], 'not aliased: the pool\'s old rule (a 1008 before the setup is a refused key)');
  assert.equal(m.adoption.applied, false);
  // the watchdog is armed once per aliased socket with the constant, and a setupComplete disarms it
  assert.ok(clockCalls.every((ms) => ms === LATEST_LIVE.setupWatchdogMs));
  m = make();
  socket = new m.Socket();
  const armed = clockCalls.length;
  socket.send(setup());
  assert.equal(clockCalls.length, armed + 1);
  const before = cleared.length;
  socket.emit('message', { data: '{"setupComplete":{}}' });
  assert.equal(cleared.length, before + 1, 'the setup answered: the watchdog is cleared');
  // a class without send/close is returned as it is
  class Plain { addEventListener() {} }
  const Odd = laneSocket(Plain, { adoption: { model: LATEST, revoked: false, applied: false }, setTimeout() {}, clearTimeout() {}, now: () => 0 });
  assert.equal(typeof Odd, 'function');
  assert.equal(laneSocket('not a class', {}), 'not a class');
});

test('a socket of the adopted model that dies right after its setup goes back to the default; a long-running one does not', async (t) => {
  const early = createRig();
  const lane = newMic(early);
  t.after(() => lane.dispose());
  await lane.start(await params(early, { latest: { model: LATEST, refresh: 'none' } }));
  const first = await nextSocket(early, 0);
  ready(first);
  await until(() => lane.phase() === 'running', 'running');
  await advanceWithFrames(early, 1000);
  first.finishClose(1011, '');
  const second = await nextSocket(early, 1);
  assert.equal(modelOf(second), `models/${DEFAULT_LIVE_MODEL}`, 'dead within three seconds of its setup');

  const late = createRig();
  const longLane = newMic(late);
  t.after(() => longLane.dispose());
  await longLane.start(await params(late, { latest: { model: LATEST, refresh: 'none' } }));
  const long = await nextSocket(late, 0);
  ready(long);
  await until(() => longLane.phase() === 'running', 'running');
  await advanceWithFrames(late, LATEST_LIVE.earlyCloseMs + 1000);
  long.finishClose(1011, '');
  await advanceWithFrames(late, 3000);   // the engine's own reconnect waits (backoff) before it opens the next socket
  const next = await nextSocket(late, 1);
  // After that it is the engine's own recovery, exactly as for the default model (an outage moves to its backup model): the
  // lane did NOT take it for the adopted model's failure, so it did not go back to the default on its own.
  assert.equal(modelOf(next), `models/${TRANSLATE_LIVE_MODEL}`);
  assert.equal(late.sockets.sockets.length, 2);
});

test('a two-way pair on the adopted model keeps its instruction setup: only the model name changes', async (t) => {
  const rig = createRig();
  const lane = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { latest: { model: LATEST, refresh: 'none' }, languages: ['ko', 'ja'], targetLanguage: 'ko' }));
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${LATEST}`);
  assert.match(JSON.stringify(socket.sent[0].setup.systemInstruction), /two-way INTERPRETER/);
  assert.equal(socket.sent[0].setup.generationConfig?.translationConfig, undefined);
});

test('refresh blocking: the lane asks the provider first with its own key, runs what it learned, and reports what it saw (ids only)', async (t) => {
  const rig = createRig();
  const events = [];
  const calls = [];
  const lane = newMic(rig, { events, fetch: async (url, init) => { calls.push({ url, headers: init.headers }); return modelsReply([DEFAULT_LIVE_MODEL, LATEST, TRANSLATE_LIVE_MODEL]); } });
  t.after(() => lane.dispose());
  const given = await params(rig, { pool: true, latest: { model: null, refresh: 'blocking' } });
  await lane.start(given);
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${LATEST}`, 'learned before the first setup');
  assert.deepEqual(events, [{ kind: 'seen', newest: LATEST }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-goog-api-key'], POOL[0], 'the first key of the pool');
  assert.equal(String(calls[0].url).includes('synthetic-'), false, 'never in the URL');
  assert.equal(JSON.stringify(events).includes('synthetic-'), false);
  ready(socket);
  await until(() => lane.phase() === 'running', 'running');
  assert.equal(lane.snapshot().model, LATEST);
});

test('refresh blocking waits at most LATEST_LIVE.blockMs, then runs the record\'s model; the look goes on and reports later', async (t) => {
  const rig = createRig();
  const events = [];
  let release;
  const lane = newMic(rig, { events, fetch: () => new Promise((resolve) => { release = () => resolve(modelsReply([LATEST])); }) });
  t.after(() => lane.dispose());
  const started = lane.start(await params(rig, { latest: { model: null, refresh: 'blocking' } }));
  await tick();
  assert.equal(rig.sockets.sockets.length, 0, 'still waiting for the provider');
  await rig.clock.advance(LATEST_LIVE.blockMs - 1);
  await tick();
  assert.equal(rig.sockets.sockets.length, 0, 'not before blockMs');
  await rig.clock.advance(2);
  await started;
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${DEFAULT_LIVE_MODEL}`, 'the record had no model: the default');
  assert.deepEqual(events, [{ kind: 'failed' }], 'the worker is told at once that the look did not answer in time (the other lane, the next start: no second wait)');
  release();
  await tick();
  await tick();
  assert.deepEqual(events, [{ kind: 'failed' }, { kind: 'seen', newest: LATEST }], 'the answer that came late replaces that report, and is kept for the next start');
  assert.equal(lane.snapshot().model, DEFAULT_LIVE_MODEL, 'but this run stays on the default');
});

test('a look that SAW the list is trusted: a model the record names but the account no longer lists is not tried; a look that failed falls back on the record', async (t) => {
  const rig = createRig();
  const events = [];
  const lane = newMic(rig, { events, fetch: async () => modelsReply([DEFAULT_LIVE_MODEL, TRANSLATE_LIVE_MODEL]) });
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { latest: { model: LATEST, refresh: 'blocking' } }));
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${DEFAULT_LIVE_MODEL}`, 'withdrawn: no failed setup is paid for it');
  assert.deepEqual(events, [{ kind: 'seen', newest: DEFAULT_LIVE_MODEL }]);
  const down = createRig();
  const downEvents = [];
  const other = newMic(down, { events: downEvents, fetch: async () => { throw new Error('offline'); } });
  t.after(() => other.dispose());
  await other.start(await params(down, { latest: { model: LATEST, refresh: 'blocking' } }));
  const fallback = await nextSocket(down, 0);
  fallback.open();
  assert.equal(modelOf(fallback), `models/${LATEST}`, 'the provider could not be asked: the record\'s model');
  assert.deepEqual(downEvents, [{ kind: 'failed' }]);
});

test('refresh background: the lane starts at once on the record\'s model and looks for the next start', async (t) => {
  const rig = createRig();
  const events = [];
  const calls = [];
  const lane = newMic(rig, { events, fetch: async (url, init) => { calls.push(init.headers['x-goog-api-key']); return modelsReply([DEFAULT_LIVE_MODEL, 'gemini-4.0-live']); } });
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { latest: { model: LATEST, refresh: 'background' } }));
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${LATEST}`, 'the record\'s model, not what the look found');
  await until(() => events.length > 0, 'the look finished');
  assert.deepEqual(events, [{ kind: 'seen', newest: 'gemini-4.0-live' }]);
  assert.equal(calls.length, 1);
  assert.equal(lane.snapshot().model === DEFAULT_LIVE_MODEL || lane.snapshot().model === LATEST, true);
});

test('a failed look is reported as failed after the keys were tried (at most LATEST_LIVE.maxKeyTries); the start goes on', async (t) => {
  const rig = createRig();
  const events = [];
  const tried = [];
  const lane = newMic(rig, { events, fetch: async (url, init) => { tried.push(init.headers['x-goog-api-key']); return { ok: false, status: 401, json: async () => ({}) }; } });
  t.after(() => lane.dispose());
  await lane.start(await params(rig, { pool: true, latest: { model: null, refresh: 'blocking' } }));
  const socket = await nextSocket(rig, 0);
  socket.open();
  assert.equal(modelOf(socket), `models/${DEFAULT_LIVE_MODEL}`);
  assert.deepEqual(events, [{ kind: 'failed' }]);
  assert.deepEqual(tried, POOL.slice(0, LATEST_LIVE.maxKeyTries), 'each key at most once, in order');
  // a second key answers: the first refusal is not the end
  const rig2 = createRig();
  const events2 = [];
  const lane2 = newMic(rig2, { events: events2, fetch: async (url, init) => (init.headers['x-goog-api-key'] === POOL[0] ? { ok: false, status: 429, json: async () => ({}) } : modelsReply([LATEST])) });
  t.after(() => lane2.dispose());
  await lane2.start(await params(rig2, { pool: true, latest: { model: null, refresh: 'blocking' } }));
  const socket2 = await nextSocket(rig2, 0);
  socket2.open();
  assert.equal(modelOf(socket2), `models/${LATEST}`);
  assert.deepEqual(events2, [{ kind: 'seen', newest: LATEST }]);
});

test('a look that hangs is aborted after LATEST_LIVE.backgroundMs and reported as failed; a Stop while it is waited for ends the start', async (t) => {
  const rig = createRig();
  const events = [];
  const lane = newMic(rig, { events, fetch: (url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  t.after(() => lane.dispose());
  const hanging = lane.start(await params(rig, { latest: { model: null, refresh: 'blocking' } }));
  await tick();
  await rig.clock.advance(LATEST_LIVE.blockMs + 1);
  await hanging;
  await nextSocket(rig, 0);
  await rig.clock.advance(LATEST_LIVE.backgroundMs);
  await until(() => events.length > 1, 'the abort');
  assert.deepEqual(events, [{ kind: 'failed' }, { kind: 'failed' }], 'at the end of the wait, and again when the look itself gave up');

  const other = createRig();
  const waiting = newMic(other, { fetch: () => new Promise(() => {}) });
  t.after(() => waiting.dispose());
  const started = waiting.start(await params(other, { latest: { model: null, refresh: 'blocking' } }));
  await tick();
  await tick();
  await waiting.stop();
  await assert.rejects(started, (error) => error.code === 'START_CANCELLED');
  assert.equal(other.sockets.sockets.length, 0, 'a stopped start opens nothing');
});

test('the lane engine itself ignores a latestModel that is not a newer general Live model, or that rides on a model the person chose', () => {
  const seen = [];
  const deps = {
    createAppConfig(options) { seen.push(options); return { keyStore: { setPersonal() {}, setBuiltin() {}, select() {} }, router: {}, sessionManager: {}, resolveFallback: () => null, dispose: async () => {} }; },
    createSimEngine() { return { subscribe: () => () => {}, start: () => ({ ready: Promise.resolve(), done: new Promise(() => {}) }), stop: async () => ({}), close: async () => {}, snapshot: () => ({ status: 'running', model: DEFAULT_LIVE_MODEL }) }; },
    liveVoicePreference: { set() {} },
  };
  class Socket { send() {} addEventListener() {} }
  const env = { AudioContext: class {}, WebSocket: Socket, fetch: 'f', now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, random: () => 0 };
  const run = (request, latestModel) => {
    const engine = createLaneEngine({ lane: 'mic', deps, env, platform: {}, onChange() {} });
    engine.start({ key: fakeKey('engine'), request, latestModel, voiceGender: 'female', muted: false, sessionId: 'mic-1' });
    return engine;
  };
  run({ targetLanguage: 'en', model: DEFAULT_LIVE_MODEL }, TRANSLATE_LIVE_MODEL);
  run({ targetLanguage: 'en', model: DEFAULT_LIVE_MODEL }, 'gemini-3.7-live');
  run({ targetLanguage: 'en', model: DEFAULT_LIVE_MODEL }, null);
  run({ targetLanguage: 'en', model: TRANSLATE_LIVE_MODEL }, LATEST);
  assert.equal(seen.every((options) => options.WebSocket === Socket), true, 'no adoption: the socket class is the environment\'s own, exactly as before');
  const engine = run({ targetLanguage: 'en', model: DEFAULT_LIVE_MODEL }, LATEST);
  assert.notEqual(seen.at(-1).WebSocket, Socket, 'an adopted model gets the lane socket');
  assert.equal(engine.snapshot().model, DEFAULT_LIVE_MODEL, 'before any socket sent the setup the lane still says the default');
});
