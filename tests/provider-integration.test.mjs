import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readFile } from 'node:fs/promises';
import { APP_DEFAULTS, ENDPOINT_ALLOWLIST, ENDPOINT_ORIGINS, PRODUCT_PROVIDER_IDS, createAppConfig } from '../app/config.js';
import { GEMINI_DEFINITION, GEMINI_ENDPOINTS, createGeminiAdapter, registerGemini, resolveGeminiFallback } from '../app/providers/gemini/index.js';
import { REST_ENDPOINT, MODELS, DEFAULT_MODEL, FALLBACK_MODEL } from '../app/providers/gemini/config.js';
import { LIVE_ENDPOINT } from '../app/providers/gemini/live-client.js';
import { VOICE_MODELS, VOICE_NAMES } from '../app/providers/gemini/voice.js';
import { CAPABILITIES, ProviderError } from '../app/providers/contract.js';
import { createRegistry } from '../app/providers/registry.js';
import { createBudget, createRetryExecutor } from '../app/engine/retry.js';
import { encodeWav } from '../app/audio/wav.js';
import { SecurityError } from '../app/security/redact.js';
import { envelope, output } from './fixtures/gemini.mjs';
import { createSocketFixture, tick } from './fixtures/live.mjs';

const PERSONAL = 'PERSONAL-SECRET-KEY';
const SHARED = 'SHARED-SECRET-KEY';
const leaks = (value) => /SECRET/.test(`${inspect(value, { depth: 8 })}${JSON.stringify(value)}`);
const code = (expected, Type = ProviderError) => (error) => {
  assert.ok(error instanceof Type, inspect(error));
  assert.equal(error.code, expected);
  assert.equal(leaks(error), false);
  assert.equal(leaks(error.stack), false);
  return true;
};
const wav = () => encodeWav(new Uint8Array(64));
const fragment = (payload) => `#shared=${encodeURIComponent(JSON.stringify({ version: 1, providerId: 'gemini', eventName: 'Sunday service', key: SHARED, ...payload }))}`;
const body = async (call) => JSON.parse(call.init.body);

function fakeFetch(responses = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? (() => new Response(JSON.stringify(envelope()), { status: 200 }));
    return typeof next === 'function' ? next() : next;
  };
  return { fetch, calls, responses };
}
function harness({ responses, key = PERSONAL, storage } = {}) {
  const net = fakeFetch(responses);
  const urls = [];
  const sockets = createSocketFixture({ inspectURL: (url) => urls.push(url) });
  const config = createAppConfig({ fetch: net.fetch, WebSocket: sockets.WebSocket, storage });
  if (key !== null) { config.keyStore.setPersonal('gemini', key); config.keyStore.select('gemini', 'personal'); }
  return { ...net, ...sockets, urls, config, ...config };
}
function context(overrides = {}) {
  return { providerId: 'gemini', keySource: 'personal', transport: 'direct', turnId: 'turn-1', sessionId: 'session-1',
    generation: 1, signal: new AbortController().signal, budget: createBudget(), ...overrides };
}
const textRequest = (changes = {}) => ({ input: { format: 'text', text: '사과 12개' }, sourceLanguage: 'ko', targetLanguage: 'en', ...changes });

test('Gemini registration declares translate/stt/voice ready, live planned, fixed endpoints and i18n keys', async () => {
  const registry = createRegistry();
  const descriptor = registerGemini(registry, { resolveCredential: async () => PERSONAL });
  assert.equal(descriptor.id, 'gemini');
  assert.equal(descriptor.browserDirect, true);
  assert.deepEqual(CAPABILITIES.map((name) => descriptor.capabilities[name].implementation), ['ready', 'ready', 'planned', 'ready']);
  for (const name of CAPABILITIES) assert.deepEqual(descriptor.capabilities[name].transports, ['direct']);
  assert.deepEqual(descriptor.capabilities.translate.inputFormats, ['text', 'wav']);
  assert.deepEqual(descriptor.capabilities.stt.inputFormats, ['wav']);
  assert.deepEqual(descriptor.capabilities.voice.inputFormats, ['text']);
  assert.deepEqual(descriptor.capabilities.voice.outputFormats, ['pcm16']);
  assert.deepEqual(descriptor.capabilities.translate.models, [...MODELS]);
  assert.deepEqual(descriptor.capabilities.voice.models, [...VOICE_MODELS]);
  assert.deepEqual(descriptor.capabilities.voice.voices, [...VOICE_NAMES]);
  assert.deepEqual(descriptor.capabilities.live.models, []);
  assert.deepEqual(descriptor.credentialPolicy, { directPersonal: true, directShared: true, hubManaged: false });
  assert.equal(descriptor.quotaPolicy.scope, 'project');
  assert.deepEqual(descriptor.endpoints, [REST_ENDPOINT, LIVE_ENDPOINT]);
  assert.deepEqual([...GEMINI_ENDPOINTS], [REST_ENDPOINT, LIVE_ENDPOINT]);
  assert.deepEqual(descriptor.fallbackPolicy.translate, [{ model: FALLBACK_MODEL, condition: 'default-model-failed',
    on: ['MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'UNAVAILABLE', 'NETWORK_ERROR', 'INVALID_RESULT'] }]);
  assert.deepEqual(descriptor.fallbackPolicy.stt, descriptor.fallbackPolicy.translate);
  assert.deepEqual(descriptor.fallbackPolicy.live, []);
  assert.deepEqual(descriptor.fallbackPolicy.voice, []);
  assert.deepEqual(descriptor.terms, { notice: 'providers.geminiTerms', status: 'unreviewed', reviewedAt: null });
  // Label and terms notice are dictionary keys in all three languages, never text.
  for (const language of ['ko', 'en', 'ja']) {
    const dictionary = JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'));
    assert.equal(typeof dictionary[descriptor.label], 'string');
    assert.equal(typeof dictionary[descriptor.terms.notice], 'string');
  }
  assert.ok(Object.isFrozen(GEMINI_DEFINITION) && Object.isFrozen(GEMINI_DEFINITION.endpoints) && Object.isFrozen(GEMINI_DEFINITION.capabilities.live));
  assert.throws(() => registerGemini(registry, { resolveCredential: async () => PERSONAL }), code('DUPLICATE_PROVIDER'));
  assert.throws(() => createGeminiAdapter({}), code('INVALID_REQUEST'));
  assert.equal(typeof resolveGeminiFallback, 'function');
});

test('app config composes exactly one product provider behind a fixed endpoint allowlist', async () => {
  const config = createAppConfig();
  assert.deepEqual(config.providers.map((p) => p.id), ['gemini']);
  assert.deepEqual([...PRODUCT_PROVIDER_IDS], ['gemini']);
  assert.deepEqual(config.endpoints, ENDPOINT_ALLOWLIST);
  assert.deepEqual([...ENDPOINT_ALLOWLIST], [...GEMINI_ENDPOINTS]);
  assert.deepEqual([...ENDPOINT_ORIGINS], ['https://generativelanguage.googleapis.com', 'wss://generativelanguage.googleapis.com']);
  assert.deepEqual(config.endpointOrigins, ENDPOINT_ORIGINS);
  for (const endpoint of config.endpoints) {
    const url = new URL(endpoint);
    assert.ok(['https:', 'wss:'].includes(url.protocol) && !url.search && !url.hash);
  }
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.endpoints) && Object.isFrozen(config.providers));
  assert.throws(() => { config.endpoints.push('https://attacker.invalid'); });
  assert.equal(config.defaults, APP_DEFAULTS);
  assert.equal(config.defaults.providerId, 'gemini');
  assert.equal(config.defaults.records.persist, false);
  assert.equal(config.resolveFallback('gemini'), resolveGeminiFallback);
  assert.equal(config.resolveFallback('other'), null);
  assert.equal(config.sessionManager.occupied, false);
  assert.equal(config.keyStore.getSelection(), null);
  // Runtime options are environment injection only; they never add destinations.
  const tampered = createAppConfig({ endpoints: ['https://attacker.invalid'], providers: [{ id: 'attacker' }], registry: null });
  assert.deepEqual(tampered.endpoints, ENDPOINT_ALLOWLIST);
  assert.deepEqual(tampered.providers.map((p) => p.id), ['gemini']);
  await config.dispose();
  await tampered.dispose();
  assert.throws(() => config.keyStore.getSelection(), code('STORE_CLOSED', SecurityError));
});

test('planned live capability is rejected before any credential, fetch or socket use', async () => {
  const h = harness();
  const lookups = [];
  h.keyStore.subscribe((event) => lookups.push(event));
  await assert.rejects(h.router.call('live', { input: { format: 'pcm16' }, sourceLanguage: 'ko', targetLanguage: 'ja' }, context()),
    code('CAPABILITY_UNIMPLEMENTED'));
  await assert.rejects(h.router.call('live', { input: { format: 'pcm16' } }, context({ transport: 'hub', keySource: 'hub' })),
    code('CAPABILITY_UNIMPLEMENTED'));
  assert.equal(h.calls.length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(lookups.length, 0);
  assert.equal(h.providers[0].capabilities.live.implementation, 'planned');
  await h.dispose();
});

test('text translation flows key store -> router -> Gemini REST with header authentication', async () => {
  const h = harness();
  const ctx = context();
  const result = await h.router.call('translate', textRequest(), ctx);
  assert.deepEqual(result, { ...output(), model: DEFAULT_MODEL });
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.url, `${REST_ENDPOINT}/${DEFAULT_MODEL}:generateContent`);
  assert.equal(call.init.headers['x-goog-api-key'], PERSONAL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.url.includes(PERSONAL), false);
  assert.equal(call.init.body.includes(PERSONAL), false);
  const payload = await body(call);
  assert.deepEqual(payload.contents[0].parts, [{ text: '사과 12개' }]);
  assert.match(payload.systemInstruction.parts[0].text, /Translate into en/);
  assert.equal(ctx.budget.used, 1);
  assert.equal(leaks(result), false);
  await h.dispose();
});

test('WAV input is one combined translate request; independent stt is a separate capability', async () => {
  const sttBody = { sourceText: '사과 12개', detectedLanguage: 'ko', status: 'ok' };
  const h = harness({ responses: [undefined, new Response(JSON.stringify(envelope(JSON.stringify(sttBody))), { status: 200 })] });
  const translated = await h.router.call('translate', textRequest({ input: { format: 'wav', audio: wav() } }), context());
  assert.deepEqual(translated, { ...output(), model: DEFAULT_MODEL });
  assert.equal(h.calls.length, 1);
  const combined = await body(h.calls[0]);
  assert.equal(combined.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.match(combined.systemInstruction.parts[0].text, /return the original transcription and its translation together/);
  const transcript = await h.router.call('stt', { input: { format: 'wav', audio: wav() }, language: 'ko' }, context({ turnId: 'turn-2' }));
  assert.deepEqual(transcript, { ...sttBody, model: DEFAULT_MODEL });
  assert.equal(h.calls.length, 2);
  assert.match((await body(h.calls[1])).systemInstruction.parts[0].text, /Transcribe only, without translating/);
  await assert.rejects(h.router.call('stt', textRequest(), context({ turnId: 'turn-3' })), code('INPUT_UNSUPPORTED'));
  assert.equal(h.calls.length, 2);
  await h.dispose();
});

test('shared QR key is chosen explicitly and cannot override endpoints, models or providers', async () => {
  const h = harness({ key: null });
  h.keyStore.receiveSharedFragment(fragment());
  assert.equal(h.keyStore.getSelection(), null);
  await assert.rejects(h.router.call('translate', textRequest(), context({ keySource: 'shared' })), code('CREDENTIAL_MISMATCH'));
  h.keyStore.select('gemini', 'shared');
  await assert.rejects(h.router.call('translate', textRequest(), context()), code('CREDENTIAL_MISMATCH'));
  const result = await h.router.call('translate', textRequest(), context({ keySource: 'shared' }));
  assert.equal(result.status, 'ok');
  assert.equal(h.calls[0].url, `${REST_ENDPOINT}/${DEFAULT_MODEL}:generateContent`);
  assert.equal(h.calls[0].init.headers['x-goog-api-key'], SHARED);
  for (const payload of [{ endpoint: 'https://attacker.invalid' }, { endpoints: ['https://attacker.invalid'] },
    { model: 'gemini-evil' }, { providerId: 'attacker' }, { fallbackPolicy: {} }, { hub: 'wss://attacker.invalid' }]) {
    assert.throws(() => h.keyStore.receiveSharedFragment(fragment(payload)), code('INVALID_SHARED_PAYLOAD', SecurityError));
  }
  assert.deepEqual(h.endpoints, ENDPOINT_ALLOWLIST);
  assert.deepEqual(h.registry.get('gemini').descriptor.endpoints, [REST_ENDPOINT, LIVE_ENDPOINT]);
  await assert.rejects(h.router.call('translate', textRequest({ model: 'gemini-evil' }), context({ keySource: 'shared' })), code('INVALID_REQUEST'));
  assert.equal(h.calls.length, 1);
  h.keyStore.endShared('gemini');
  await assert.rejects(h.router.call('translate', textRequest(), context({ keySource: 'shared' })), code('CREDENTIAL_REQUIRED'));
  assert.equal(h.calls.length, 1);
  await h.dispose();
});

test('turn executor applies only the registered Gemini model fallback inside the shared budget', async () => {
  const unavailable = () => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'SECRET detail' } }), { status: 503 });
  const h = harness({ responses: [unavailable, undefined] });
  const controller = new AbortController();
  // Collapse retry waits (a few seconds) while keeping request deadlines intact.
  const timing = { random: () => 0, clearTimeout: globalThis.clearTimeout,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms < 10000 ? 0 : ms) };
  const executor = createRetryExecutor({ call: h.router.call, ...timing,
    context: { providerId: 'gemini', keySource: 'personal', transport: 'direct', turnId: 'turn-1', sessionId: 'session-1', generation: 1, signal: controller.signal } });
  const result = await executor.run('translate', textRequest(), { resolveFallback: h.resolveFallback('gemini') });
  assert.equal(result.model, FALLBACK_MODEL);
  assert.deepEqual(h.calls.map((call) => call.url.split('/').at(-1)), [`${DEFAULT_MODEL}:generateContent`, `${FALLBACK_MODEL}:generateContent`]);
  assert.equal(executor.budget.used, 2);
  assert.equal((await body(h.calls[1])).generationConfig.thinkingConfig, undefined);
  // A failing fallback model stops at the budget without any provider or key change.
  const exhausted = harness({ responses: [unavailable, unavailable, unavailable, unavailable] });
  const again = createRetryExecutor({ call: exhausted.router.call, ...timing,
    context: { providerId: 'gemini', keySource: 'personal', transport: 'direct', turnId: 'turn-1', sessionId: 'session-1', generation: 1, signal: controller.signal } });
  await assert.rejects(again.run('translate', textRequest(), { resolveFallback: exhausted.resolveFallback('gemini') }), code('UNAVAILABLE'));
  assert.equal(again.budget.used, 3);
  assert.ok(exhausted.calls.every((call) => call.init.headers['x-goog-api-key'] === PERSONAL));
  await h.dispose();
  await exhausted.dispose();
});

test('Live voice opens through the router on the single live client and frees the slot on close', async () => {
  const h = harness();
  const events = [];
  const request = { language: 'ja', voice: 'Kore', input: { format: 'text' } };
  const open = (turnId = 'turn-1') => h.router.call('voice', request, context({ turnId, budget: createBudget({ limit: 1 }), onEvent: (event) => events.push(event) }));
  const opening = open();
  await tick(); await tick();
  assert.equal(h.sockets.length, 1);
  assert.ok(h.urls[0].startsWith(LIVE_ENDPOINT));
  const ws = h.sockets[0];
  ws.open(); ws.json({ setupComplete: {} });
  const session = await opening;
  assert.equal(ws.sent[0].setup.model, `models/${VOICE_MODELS[0]}`);
  assert.equal(ws.sent[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(JSON.stringify(ws.sent).includes(PERSONAL), false);
  // A second session while the first is open hits the app-wide single socket.
  await assert.rejects(open('turn-2'), code('SESSION_LIMIT'));
  assert.equal(h.sockets.length, 1);
  const speaking = session.speak({ text: 'こんにちは' });
  await tick();
  assert.deepEqual(ws.sent[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: 'こんにちは' }] }], turnComplete: true } });
  ws.json({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa(String.fromCharCode(1, 2, 3, 4)) } }] } } });
  ws.json({ serverContent: { turnComplete: true } });
  const spoken = await speaking;
  assert.equal(spoken.status, 'completed');
  assert.equal(spoken.bytes, 4);
  const audio = events.find((event) => event.type === 'audio');
  assert.deepEqual([...audio.audio], [1, 2, 3, 4]);
  assert.equal(audio.sampleRate, 24000);
  assert.deepEqual([audio.turnId, audio.sessionId, audio.generation], ['turn-1', 'session-1', 1]);
  assert.equal(leaks(events), false);
  await session.close();
  assert.equal(ws.closeCalls, 1);
  assert.equal(ws.readyState, 3);
  // A consumer-initiated close emits nothing afterwards (router contract).
  assert.equal(events.at(-1).type, 'complete');
  const reopening = open('turn-3');
  await tick(); await tick();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open(); h.sockets[1].json({ setupComplete: {} });
  const next = await reopening;
  await next.cancel();
  assert.equal(h.sockets[1].closeCalls, 1);
  assert.equal(h.calls.length, 0);
  await h.dispose();
});

test('provider failures and key deletion surface as codes without the key', async () => {
  const invalid = new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'SECRET echo',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }), { status: 400 });
  const h = harness({ responses: [invalid] });
  await assert.rejects(h.router.call('translate', textRequest(), context()), code('INVALID_KEY'));
  const events = [];
  h.keyStore.subscribe((event) => events.push(event));
  h.keyStore.deleteKey('gemini', 'personal');
  assert.deepEqual(events.map((event) => event.type), ['key-deleted']);
  assert.equal(leaks(events), false);
  await assert.rejects(h.router.call('translate', textRequest(), context()), code('CREDENTIAL_REQUIRED'));
  assert.equal(h.calls.length, 1);
  await h.dispose();
});
