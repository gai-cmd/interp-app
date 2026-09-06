// Live model discovery (owner, 2026-09-06 "자동으로 업데이트 감지"): the app asks
// the provider which Live models the account can reach, so a newly published
// one is adopted without a code change. The suite's job is the boundary: no new
// endpoint, no key leak, and a hostile or broken reply changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCOVERY_LIMITS, LIVE_METHOD, discoverLiveModels, liveSetupFor, mergeLiveModels,
  modelIdOf, newestLiveModel } from '../app/providers/gemini/model-discovery.js';
import { REST_ENDPOINT } from '../app/providers/gemini/config.js';
import { ENDPOINT_ORIGINS } from '../app/config.js';
import { LIVE_MODELS, DEFAULT_LIVE_MODEL, liveRoute } from '../app/providers/gemini/live-config.js';
import { all, boot, byClass, leaks, secrets, tick, until } from './fixtures/scenarios.mjs';

const KEY = 'DISCOVERY-SECRET-KEY';
const model = (name, methods = [LIVE_METHOD]) => ({ name, supportedGenerationMethods: methods });
function fetchDouble(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(calls.length) : reply; };
  return { calls, fetch: fetchImpl };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('discovery calls the endpoint the app already uses, with the key in a header and never in the URL', async () => {
  const f = fetchDouble(json({ models: [model('models/gemini-9.0-live-preview')] }));
  const result = await discoverLiveModels({ fetch: f.fetch, key: KEY });
  assert.deepEqual([...result.models], ['gemini-9.0-live-preview']);
  assert.equal(result.code, null);

  const [call] = f.calls;
  assert.equal(call.url, REST_ENDPOINT, 'no new endpoint is introduced');
  assert.ok(ENDPOINT_ORIGINS.includes(new URL(REST_ENDPOINT).origin), 'the origin is already registered, so the CSP is unchanged');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers['x-goog-api-key'], KEY);
  assert.equal(String(call.url).includes(KEY), false, 'the key is never in the URL');
  assert.equal(JSON.stringify(result).includes(KEY), false, 'the key is never in the result');
});

test('only bidiGenerateContent models are Live models', async () => {
  const f = fetchDouble(json({ models: [
    model('models/gemini-text-only', ['generateContent']),
    model('models/gemini-9.0-live-preview'),
    model('models/gemini-embedding', ['embedContent']),
    model('models/gemini-9.1-live-preview', ['generateContent', LIVE_METHOD]),
    model('models/gemini-no-methods', null),
  ] }));
  const result = await discoverLiveModels({ fetch: f.fetch, key: KEY });
  assert.deepEqual([...result.models], ['gemini-9.0-live-preview', 'gemini-9.1-live-preview']);
  assert.equal(LIVE_METHOD, 'bidiGenerateContent');
});

test('a hostile or broken listing cannot become a path, a flood or a crash', async () => {
  // Names that are not plain model ids are dropped, not sanitised into one.
  const hostile = ['models/../../etc/passwd', 'https://evil.example/models/x', 'models/UPPER',
    'models/', 'models/with space', `models/${'a'.repeat(200)}`, 'models/a?b', 'models/a/b', 42, null, {}];
  const f = fetchDouble(json({ models: [...hostile.map((name) => model(name)), model('models/gemini-ok-live')] }));
  const result = await discoverLiveModels({ fetch: f.fetch, key: KEY });
  assert.deepEqual([...result.models], ['gemini-ok-live']);
  for (const name of hostile) assert.equal(modelIdOf(name), null, `${String(name)} is not a model id`);

  // A huge listing is capped rather than walked entirely.
  const many = Array.from({ length: DISCOVERY_LIMITS.maxModels + 50 },
    (_, index) => model(`models/gemini-${index}-live`));
  const big = fetchDouble(json({ models: many }));
  const capped = await discoverLiveModels({ fetch: big.fetch, key: KEY });
  assert.equal(capped.models.length, DISCOVERY_LIMITS.maxModels);
  assert.ok(Object.isFrozen(capped.models));
  // Duplicates collapse.
  const dup = fetchDouble(json({ models: [model('models/gemini-x-live'), model('gemini-x-live')] }));
  assert.deepEqual([...(await discoverLiveModels({ fetch: dup.fetch, key: KEY })).models], ['gemini-x-live']);
});

test('every failure is a code and never blocks the app', async () => {
  const cases = [
    [json({}, 401), 'INVALID_KEY'],
    [json({}, 403), 'INVALID_KEY'],
    [json({}, 429), 'RATE_LIMITED'],
    [json({}, 500), 'NETWORK_ERROR'],
    [json(null), 'INVALID_RESULT'],
    [json({ models: 'nope' }), 'INVALID_RESULT'],
    [{ ok: true, status: 200, json: async () => { throw new Error('SECRET body'); } }, 'INVALID_RESULT'],
  ];
  for (const [reply, code] of cases) {
    const f = fetchDouble(reply);
    const result = await discoverLiveModels({ fetch: f.fetch, key: KEY });
    assert.deepEqual({ models: [...result.models], code }, { models: [], code }, JSON.stringify(code));
  }
  // A thrown fetch, a missing key and a missing fetch are codes too.
  const thrown = await discoverLiveModels({ fetch: async () => { throw new Error('SECRET network'); }, key: KEY });
  assert.deepEqual({ ...thrown, models: [...thrown.models] }, { models: [], code: 'NETWORK_ERROR' });
  assert.equal((await discoverLiveModels({ fetch: async () => json({}), key: '' })).code, 'CREDENTIAL_REQUIRED');
  assert.equal((await discoverLiveModels({ fetch: null, key: KEY })).code, 'CREDENTIAL_REQUIRED');
  // No provider text ever reaches the caller.
  for (const value of [thrown, await discoverLiveModels({ fetch: fetchDouble(json({}, 500)).fetch, key: KEY })]) {
    assert.equal(JSON.stringify(value).includes('SECRET'), false);
  }
});

test('merging keeps the reviewed list first and adds only what is new', () => {
  const merged = mergeLiveModels(LIVE_MODELS, ['gemini-9.0-live-preview', DEFAULT_LIVE_MODEL, 'bad name']);
  assert.deepEqual([...merged].slice(0, LIVE_MODELS.length), [...LIVE_MODELS], 'the reviewed default keeps its place');
  assert.deepEqual([...merged].slice(LIVE_MODELS.length), ['gemini-9.0-live-preview']);
  assert.ok(Object.isFrozen(merged));
  assert.deepEqual([...mergeLiveModels(LIVE_MODELS, [])], [...LIVE_MODELS]);
  assert.deepEqual([...mergeLiveModels(null, null)], []);

  assert.equal(newestLiveModel(LIVE_MODELS, ['gemini-9.0-live-preview']), 'gemini-9.0-live-preview');
  assert.equal(newestLiveModel(LIVE_MODELS, [DEFAULT_LIVE_MODEL]), null, 'a model already known is not new');
  assert.equal(newestLiveModel(LIVE_MODELS, []), null);
});

test('a discovered model gets a setup route by the same rule the repository uses', () => {
  // The repository entries and the rule must not disagree.
  for (const known of LIVE_MODELS) assert.equal(liveSetupFor(known), liveRoute(known), known);
  // Anything unrecognised takes the instruction route, which runs on any Live model.
  assert.equal(liveSetupFor('gemini-9.0-live-preview'), 'flash');
  assert.equal(liveSetupFor('gemini-4.0-live-translate-preview'), 'translation');
  assert.equal(liveSetupFor(undefined), 'flash');
});

// --- the running app adopts a newly published model ---

test('the app asks once per key, adopts the newest Live model and says so', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  const sim = b.app.listenEngines.direct;

  // Nothing is asked without a personal key: there is nothing to ask with.
  assert.deepEqual(b.gemini.discoveryCalls, []);
  assert.equal(sim.model, DEFAULT_LIVE_MODEL);

  b.gemini.discoveryScript.push(new Response(JSON.stringify({ models: [
    { name: 'models/gemini-9.0-live-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/gemini-text', supportedGenerationMethods: ['generateContent'] },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  b.enterPersonalKey({ key: secrets.personal, remember: false });
  await until(() => sim.model !== DEFAULT_LIVE_MODEL);

  assert.equal(b.gemini.discoveryCalls.length, 1);
  assert.equal(b.gemini.discoveryCalls[0].method, 'GET');
  assert.equal(b.gemini.discoveryCalls[0].headers['x-goog-api-key'], secrets.personal);
  assert.equal(leaks(b.gemini.discoveryCalls[0].url), false, 'the key is never in the URL');
  assert.equal(sim.model, 'gemini-9.0-live-preview', 'the newest model is adopted');
  assert.deepEqual([...sim.discoveredModels], ['gemini-9.0-live-preview']);
  // The reviewed models keep their place at the head of the list.
  assert.deepEqual([...sim.models].slice(0, LIVE_MODELS.length), [...LIVE_MODELS]);
  // The screen says the model in use was found rather than reviewed.
  const note = byClass(b.root, 'settings-model-discovered');
  assert.equal(note.hidden, false);
  assert.ok(note.textContent.includes('gemini-9.0-live-preview'));
  // The picker offers it, labelled by its identifier.
  const option = all(b.root, (node) => node.getAttribute('data-discovered') === 'true')[0];
  assert.equal(option.getAttribute('value'), 'gemini-9.0-live-preview');
  // The same key is not asked about again.
  b.app.engine.state.setNotice(null);
  await tick();
  assert.equal(b.gemini.discoveryCalls.length, 1, 'once per key');
  assert.equal(leaks(b.text()), false);
});

test('a refused or empty discovery changes nothing and never blocks interpretation', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  const sim = b.app.listenEngines.direct;
  b.gemini.discoveryScript.push(new Response('{}', { status: 403 }));
  b.enterPersonalKey({ key: secrets.personal, remember: false });
  await until(() => b.gemini.discoveryCalls.length >= 1);
  for (let i = 0; i < 20; i++) await tick();

  assert.equal(sim.model, DEFAULT_LIVE_MODEL, 'a refusal leaves the reviewed default in place');
  assert.deepEqual([...sim.discoveredModels], []);
  assert.deepEqual([...sim.models], [...LIVE_MODELS]);
  assert.equal(byClass(b.root, 'settings-model-discovered').hidden, true);
  // A failed discovery is not interpretation traffic and leaves no notice.
  assert.equal(b.gemini.calls.length, 0);
  assert.equal(leaks(b.text()), false);
  // The app is still usable: nothing was blocked or torn down.
  assert.equal(b.app.engine.snapshot().closed, false);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'idle');
});
