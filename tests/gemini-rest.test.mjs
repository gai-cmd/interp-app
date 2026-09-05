import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createGeminiRest } from '../app/providers/gemini/rest.js';
import { DEFAULT_MODEL, FALLBACK_MODEL, REST_ENDPOINT, REST_LIMITS, generationConfig } from '../app/providers/gemini/config.js';
import { validateOutput, numericTokens, MAX_OUTPUT_LENGTH } from '../app/engine/output-validator.js';
import { createKeyStore } from '../app/security/key-store.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createBudget } from '../app/engine/retry.js';
import { provider } from './fixtures/providers.mjs';
import { key, model, output, request, context, envelope, response, chunkedResponse, clock } from './fixtures/gemini.mjs';

const setup = (options = {}) => createGeminiRest({ resolveCredential: () => key, fetch: async () => response(), ...options });
const errorCode = (code) => (error) => {
  assert.equal(error.code, code);
  assert.ok(!inspect(error, { showHidden: true, depth: 10 }).includes(key));
  assert.equal(error.cause, undefined);
  return true;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('header-only authentication, fixed endpoint, separated instructions, no retries', async () => {
  let calls = 0;
  const ctx = context();
  const client = setup({ resolveCredential(ref, address, { signal }) {
    assert.equal(ref, ctx.credentialRef);
    assert.deepEqual(address, { providerId: 'gemini', keySource: 'personal', transport: 'direct' });
    assert.equal(signal.aborted, false);
    return key;
  }, async fetch(url, options) {
    calls++;
    assert.equal(url, `${REST_ENDPOINT}/${DEFAULT_MODEL}:generateContent`);
    assert.ok(!url.includes(key));
    assert.equal(options.headers['x-goog-api-key'], key);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.contents, [{ role: 'user', parts: request().parts }]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: request().instruction }] });
    assert.ok(!options.body.includes(key));
    return response();
  } });
  const result = await client.generateContent(request({ endpoint: 'https://invalid.example/', key }), ctx);
  assert.deepEqual(result, { text: JSON.stringify(output()), model });
  assert.equal(calls, 1);
});

test('model-specific fields and independent config objects; aliases never called', async () => {
  const first = generationConfig(DEFAULT_MODEL);
  assert.deepEqual(first.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.equal(generationConfig(FALLBACK_MODEL).thinkingConfig, undefined);
  first.thinkingConfig.thinkingLevel = 'high';
  assert.equal(generationConfig().thinkingConfig.thinkingLevel, 'minimal');
  let calls = 0;
  const client = setup({ fetch: async (url, options) => {
    calls++;
    assert.ok(url.includes(FALLBACK_MODEL));
    assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig, undefined);
    return response();
  } });
  await client.generateContent(request({ model: FALLBACK_MODEL }), context());
  for (const bad of ['gemini-flash-latest', 'toString', '../other?key=' + key]) {
    await assert.rejects(client.generateContent(request({ model: bad }), context()), errorCode('MODEL_UNSUPPORTED'));
  }
  assert.equal(calls, 1);
});

test('invalid credentials/routes and pre-abort never fetch or disclose secrets', async () => {
  let calls = 0;
  const client = setup({ fetch: () => { calls++; } });
  for (const changes of [{ providerId: 'other' }, { keySource: 'hub' }, { transport: 'hub' }]) {
    await assert.rejects(client.generateContent(request(), context(changes)), errorCode('CREDENTIAL_MISMATCH'));
  }
  await assert.rejects(client.generateContent(request(), context({ credentialRef: null })), errorCode('CREDENTIAL_REQUIRED'));
  const controller = new AbortController();
  controller.abort(new Error(key));
  await assert.rejects(client.generateContent(request(), context({ signal: controller.signal })), errorCode('ABORTED'));
  for (const bad of ['', 'a\r\nb', 'x'.repeat(513), null]) {
    await assert.rejects(setup({ resolveCredential: () => bad }).generateContent(request(), context()), errorCode('CREDENTIAL_REQUIRED'));
  }
  await assert.rejects(setup({ resolveCredential() { throw new Error(key); } }).generateContent(request(), context()), errorCode('PROVIDER_ERROR'));
  assert.equal(calls, 0);
});

test('HTTP normalization preserves scheduling, drops bodies and performs one attempt', async () => {
  for (const [status, code] of [[401, 'INVALID_KEY'], [403, 'PERMISSION_DENIED'], [429, 'UNKNOWN_429'], [503, 'UNAVAILABLE'], [400, 'PROVIDER_ERROR']]) {
    let calls = 0;
    const client = setup({ fetch: async () => { calls++; return response({ error: { message: key } },
      { status, headers: { 'retry-after': '7' } }); } });
    await assert.rejects(client.generateContent(request(), context()), (error) => {
      errorCode(code)(error); assert.equal(error.retryAfterMs, 7000); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(setup({ fetch: async () => new Response(key, { status: 503 }) }).generateContent(request(), context()), errorCode('UNAVAILABLE'));
  await assert.rejects(setup({ fetch: async () => { throw new Error(key); } }).generateContent(request(), context()), errorCode('NETWORK_ERROR'));
});

test('UTF-8 streaming and byte boundary, declared and actual sizes, error bodies bounded too', async () => {
  const body = JSON.stringify(envelope());
  const size = new TextEncoder().encode(body).length;
  const client = setup({ maxResponseBytes: size, fetch: async () => chunkedResponse(body, { chunkSize: 1 }) });
  assert.equal((await client.generateContent(request(), context())).text, JSON.stringify(output()));
  let cancelled = 0;
  for (const headers of [undefined, { 'content-length': String(size) }, { 'content-length': '1' }]) {
    await assert.rejects(setup({ maxResponseBytes: size - 10, fetch: async () => chunkedResponse(body,
      { chunkSize: 1, headers, onCancel: () => cancelled++ }) }).generateContent(request(), context()), errorCode('INVALID_RESULT'));
  }
  assert.equal(cancelled, 3);
  await assert.rejects(setup({ maxResponseBytes: 10, fetch: async () => response({ error: { message: key } }, { status: 503 }) })
    .generateContent(request(), context()), errorCode('INVALID_RESULT'));
  for (const body of ['{', 'null', '[]', key]) {
    await assert.rejects(setup({ fetch: async () => new Response(body) }).generateContent(request(), context()), errorCode('INVALID_RESULT'));
  }
});

test('candidate normalization excludes thoughts and metadata, refuses truncation and safety blocks', async () => {
  const client = setup({ fetch: async () => response(envelope('', { candidates: [{ finishReason: 'STOP',
    content: { parts: [{ thought: true, text: key }, { text: '{' }, { text: '}' }] } }], modelVersion: key })) });
  assert.deepEqual(await client.generateContent(request(), context()), { text: '{}', model });
  for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
    await assert.rejects(setup({ fetch: async () => response(envelope('', { candidates: [{ finishReason: reason }] })) })
      .generateContent(request(), context()), errorCode('SAFETY_BLOCKED'));
  }
  await assert.rejects(setup({ fetch: async () => response({ promptFeedback: { blockReason: 'SAFETY' } }) })
    .generateContent(request(), context()), errorCode('SAFETY_BLOCKED'));
  for (const candidate of [{ finishReason: 'MAX_TOKENS' }, {}, { finishReason: 'STOP', content: { parts: [{ thought: true, text: key }] } },
    { finishReason: 'STOP', content: { parts: [{ functionCall: {} }] } }]) {
    await assert.rejects(setup({ fetch: async () => response(envelope('', { candidates: [candidate] })) })
      .generateContent(request(), context()), errorCode('INVALID_RESULT'));
  }
});

test('timeout covers credential resolution, fetch and body; timer cleanup on each terminal path', async () => {
  for (const phase of ['credential', 'fetch', 'body']) {
    const timer = clock();
    let downstream;
    let cancelled = false;
    const never = new Promise(() => {});
    const client = setup({ ...timer,
      resolveCredential(ref, address, { signal }) { downstream = signal; return phase === 'credential' ? never : key; },
      fetch: async () => phase === 'fetch' ? never : new Response(new ReadableStream({ cancel() { cancelled = true; } })),
    });
    const pending = client.generateContent(request(), context());
    const rejected = assert.rejects(pending, errorCode('TIMEOUT'));
    await tick();
    timer.fire();
    await rejected;
    assert.equal(downstream.aborted, true);
    assert.equal(timer.timers.size, 0);
    if (phase === 'body') assert.equal(cancelled, true);
  }
  const timer = clock();
  await setup(timer).generateContent(request(), context());
  assert.equal(timer.timers.size, 0);
  await assert.rejects(setup({ ...timer, fetch: async () => response({}, { status: 503 }) }).generateContent(request(), context()));
  assert.equal(timer.timers.size, 0);
});

test('abort terminates an ignored fetch, discards late response and cancels its body', async () => {
  const controller = new AbortController();
  const timer = clock();
  let finish;
  let downstream;
  let cancelled = false;
  const client = setup({ ...timer, fetch(url, { signal }) {
    downstream = signal;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const pending = client.generateContent(request(), context({ signal: controller.signal }));
  const rejected = assert.rejects(pending, errorCode('ABORTED'));
  await tick();
  controller.abort(new Error(key));
  await rejected;
  assert.equal(downstream.aborted, true);
  assert.equal(timer.timers.size, 0);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await tick();
  assert.equal(cancelled, true);
});

test('abort during body consumption cancels the reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = setup({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) })
    .generateContent(request(), context({ signal: controller.signal }));
  const rejected = assert.rejects(pending, errorCode('ABORTED'));
  await tick();
  controller.abort(key);
  await rejected;
  assert.equal(cancelled, true);
});

test('request limits and WAV parts are checked before resolving credentials', async () => {
  let resolutions = 0;
  const client = setup({ resolveCredential() { resolutions++; return key; }, fetch: async (url, options) => {
    assert.equal(JSON.parse(options.body).contents[0].parts[0].inlineData.mimeType, 'audio/wav');
    return response();
  } });
  const audio = (data = 'AAAA') => ({ inlineData: { mimeType: 'audio/wav', data } });
  for (const parts of [[], [{ text: '' }], [{ text: 'x'.repeat(REST_LIMITS.maxTextLength + 1) }],
    [audio('!')], [audio('A')], [audio(), audio()], [audio('AAAA'.repeat(Math.ceil(REST_LIMITS.maxAudioBytes / 3) + 1))],
    [{ fileData: { fileUri: 'https://invalid.example/' } }]]) {
    await assert.rejects(client.generateContent(request({ parts }), context()), errorCode('INVALID_REQUEST'));
  }
  assert.equal(resolutions, 0);
  await client.generateContent(request({ parts: [audio()] }), context());
  assert.equal(resolutions, 1);
  await client.generateContent(request({ parts: [audio(Buffer.alloc(REST_LIMITS.maxAudioBytes).toString('base64'))] }), context());
  assert.equal(resolutions, 2);
});

test('output validation enforces JSON, exact fields, lengths, status and trusted source', () => {
  const validate = (raw) => validateOutput(raw, { model });
  assert.deepEqual(validate(JSON.stringify(output())), { ...output(), model });
  assert.deepEqual(validate('```json\n' + JSON.stringify(output()) + '\n```'), { ...output(), model });
  for (const raw of ['{', 'null', '[]', '"text"', 'prose ' + JSON.stringify(output()),
    output({ translatedText: '' }), output({ sourceText: 42 }), output({ detectedLanguage: '' }),
    output({ status: 'maybe' }), output({ model: key }), output({ translatedText: '\u0000' }),
    output({ translatedText: 'x'.repeat(MAX_OUTPUT_LENGTH + 1) })]) {
    assert.throws(() => validate(raw), errorCode('INVALID_RESULT'));
  }
  assert.throws(() => validateOutput(output(), { model, sourceText: 'different' }), errorCode('INVALID_RESULT'));
  for (const status of ['no-speech', 'unrecognized']) {
    assert.equal(validate(output({ sourceText: '', translatedText: '', detectedLanguage: 'und', status })).status, status);
    assert.throws(() => validate(output({ status })), errorCode('INVALID_RESULT'));
  }
  assert.deepEqual(validateOutput({ sourceText: 'Hello', detectedLanguage: 'en-US', status: 'ok' }, { capability: 'stt', model }),
    { sourceText: 'Hello', detectedLanguage: 'en-US', status: 'ok', model });
});

test('mixed languages, names, numeric-only and unchanged text pass without accuracy claims', () => {
  for (const [sourceText, translatedText] of [['田中さん과 API', '田中さん and API'], ['OpenAI', 'OpenAI'],
    ['123', '123'], ['Hello', 'Hello'], ['고양이', 'The moon is cheese'], ['「안녕」', '「Hello」']]) {
    const result = validateOutput(output({ sourceText, translatedText, detectedLanguage: 'mixed' }), { model });
    assert.equal(result.translatedText, translatedText);
    assert.equal(Object.hasOwn(result, 'accurate'), false);
  }
});

test('numeric validation preserves token boundaries, multiplicity, signs, precision and large integers', () => {
  for (const [sourceText, translatedText] of [['1,234.50원', '１２３４.５０ yen'], ['-12%', '−１２％'],
    ['9007199254740993', '9007199254740993'], ['3장 16절', 'chapter 3 verse 16']]) {
    assert.equal(validateOutput(output({ sourceText, translatedText }), { model }).status, 'ok');
  }
  for (const [sourceText, translatedText] of [['12', '112'], ['12', '1 2'], ['12 12', '12'], ['12', ''],
    ['12 apples', 'apples'], ['apples', '12 apples'], ['-12', '12'], ['12%', '12'], ['1.05', '1.5'],
    ['9007199254740993', '9007199254740992']]) {
    assert.throws(() => validateOutput(output({ sourceText, translatedText }), { model }), errorCode('INVALID_RESULT'));
  }
  assert.deepEqual(numericTokens('１２ 112'), ['112', '12']);
});

test('real router and key store integration resolves the selected reference and charges once', async () => {
  const registry = createRegistry();
  const store = createKeyStore({ registry });
  let calls = 0;
  const rest = createGeminiRest({ resolveCredential: store.resolveCredential,
    fetch: async () => { calls++; return response(); } });
  const definition = provider('gemini');
  definition.capabilities.translate.models = [model];
  registry.register(definition, { translate: async (input, ctx) => {
    const result = await rest.generateContent(request({ model: input.model, parts: [{ text: input.input.text }] }), ctx);
    return validateOutput(result.text, { model: result.model, sourceText: input.input.text });
  }, stt() {}, live: { open() {} }, voice: { open() {} } });
  store.setPersonal('gemini', key);
  const router = createRouter({ registry, getCredentialRef: store.getCredentialRef });
  const budget = createBudget();
  const result = await router.call('translate', { model, input: { format: 'text', text: output().sourceText } }, { ...context(), budget });
  assert.equal(result.status, 'ok');
  assert.equal(budget.used, 1);
  assert.equal(calls, 1);
  store.dispose();
});


test('broken response streams are network errors; malformed UTF-8 is an invalid result', async () => {
  await assert.rejects(setup({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(key)); },
  })) }).generateContent(request(), context()), errorCode('NETWORK_ERROR'));
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xe3, 0x81])]) {
    await assert.rejects(setup({ fetch: async () => new Response(bytes) })
      .generateContent(request(), context()), errorCode('INVALID_RESULT'));
  }
});
