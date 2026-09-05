import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createHubProtocol, parseHubMessage, validateRoomCode, REGISTERED_HUBS, HUB_LIMITS } from '../app/hub/protocol.js';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { hub, hello, caption, status, replay, wire } from './fixtures/hub.mjs';
const parse = (v) => parseHubMessage(wire(v));
const invalid = (fn) => assert.throws(fn, { name: 'ProviderError', code: 'INVALID_RESULT' });

test('registered WSS audience URL only; registry is captured and default is empty', () => {
  assert.deepEqual(REGISTERED_HUBS, []);
  assert.throws(() => createHubProtocol().buildUrl('fixture', 'Ab12'), { code: 'HUB_REQUIRED' });
  const entry = { ...hub };
  const p = createHubProtocol({ hubs: [entry] });
  entry.url = 'wss://evil.invalid/ws';
  assert.equal(p.buildUrl('fixture', 'Ab12'), 'wss://hub.example.invalid/ws?room=Ab12');
  assert.equal(p.parse, parseHubMessage);
  assert.throws(() => p.buildUrl(hub.url, 'Ab12'), { code: 'HUB_REQUIRED' });
  for (const url of ['ws://hub.example.invalid/ws', 'https://hub.example.invalid/ws',
    'wss://user:secret@hub.example.invalid/ws', 'wss://hub.example.invalid/ws?role=source',
    'wss://hub.example.invalid/ws#x', 'wss://hub.example.invalid/other',
    ' wss://hub.example.invalid/ws', 'wss://hub.example.invalid/a/../ws']) {
    assert.throws(() => createHubProtocol({ hubs: [{ ...hub, url }] }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => createHubProtocol({ hubs: [hub, hub] }), { code: 'INVALID_REQUEST' });
});

test('room code preserves case and rejects URL/query injection without coercion', () => {
  for (const code of ['A', 'aB123456']) assert.equal(validateRoomCode(code), code);
  for (const code of ['', '123456789', ' ab12', 'ab12\n', 'a&role=source', '../ab', 'あ', 1234, null]) {
    assert.throws(() => validateRoomCode(code), { code: 'INVALID_REQUEST' });
  }
});

test('hello/settings retain only supported languages; hello does not imply broadcasting', () => {
  const event = parse(hello());
  assert.deepEqual(event, { type: 'hello', sessionId: hello().sessionId,
    settings: { allowedLangs: ['ja', 'en', 'ko'], defaultLang: 'ja' } });
  assert.ok(Object.isFrozen(event.settings.allowedLangs));
  assert.deepEqual(parse({ type: 'settings', settings: { allowedLangs: ['fr', 'en', 'en'], defaultLang: 'fr' } }),
    { type: 'settings', settings: { allowedLangs: ['en'], defaultLang: 'en' } });
  assert.deepEqual(parse({ type: 'settings', settings: { allowedLangs: ['fr'] } }).settings,
    { allowedLangs: [], defaultLang: null });
  invalid(() => parse({ ...hello(), sessionId: undefined }));
  for (const settings of [null, [], {}, { allowedLangs: 'ja' }, { allowedLangs: [1] },
    { allowedLangs: ['src'] }, { allowedLangs: Array(65).fill('ja') }]) {
    // src is a caption role and never a target language.
    if (settings?.allowedLangs?.[0] === 'src') assert.deepEqual(parse({ type: 'settings', settings }).settings.allowedLangs, []);
    else invalid(() => parse({ type: 'settings', settings }));
  }
});

test('both status spellings normalize only known lane states; raw diagnostics disappear', () => {
  for (const state of ['connecting', 'connected', 'rotating', 'reconnecting', 'error', 'fatal']) {
    for (const lang of ['ja', 'en', 'ko', '*']) {
      const expected = { type: 'status', lang, state };
      assert.deepEqual(parse(status(state, lang)), expected);
      assert.deepEqual(parse({ ...status(state, lang), type: 'cast.status' }), expected);
    }
  }
  for (const v of [{ type: 'status' }, status('ready'), status('connected', 'src')]) assert.equal(parse(v), null);
  invalid(() => parse({ type: 'cast.status', lang: 'fr', state: 'connected' }));
  assert.deepEqual(parse({ type: 'cast.status', lang: '*', state: 'fatal', detail: 'RESOURCE_EXHAUSTED daily secret' }),
    { type: 'status', lang: '*', state: 'fatal' });
});

test('stopped and access rejection map to bounded meanings', () => {
  for (const [reason, expected] of [[undefined, 'stopped'], ['stopped', 'stopped'],
    ['all lanes fatal', 'broadcast-error'], ['start failed', 'broadcast-error'],
    ['auto-stop 150분', 'time-limit'], ['secret', 'stopped'], [{ secret: true }, 'stopped']]) {
    assert.deepEqual(parse({ type: 'cast.stopped', reason }), { type: 'stopped', reason: expected });
  }
  assert.deepEqual(parse({ type: 'closed', detail: 'secret' }), { type: 'closed', reason: 'room-closed' });
  for (const type of ['outside', 'denied']) assert.deepEqual(parse({ type }), { type: 'denied', reason: type });
});

test('captions are complete snapshots with bounded safe integers, language and fields', () => {
  for (const lang of ['src', 'ja', 'en', 'ko']) {
    const event = parse(caption({ lang, text: '', seq: 0, revision: 0 }));
    assert.equal(event.text, ''); assert.equal(event.lang, lang); assert.ok(Object.isFrozen(event));
  }
  for (const field of ['seq', 'revision', 'ts']) {
    for (const value of [-1, 1.2, '1', null, Number.MAX_SAFE_INTEGER + 1]) invalid(() => parse(caption({ [field]: value })));
    assert.equal(parse(caption({ [field]: Number.MAX_SAFE_INTEGER }))[field], Number.MAX_SAFE_INTEGER);
  }
  for (const override of [{ lang: 'fr' }, { lang: '*' }, { final: 1 }, { final: undefined },
    { text: null }, { text: 'a'.repeat(16001) }, { segmentId: '' }, { segmentId: 'a'.repeat(257) },
    { seq: undefined }, { revision: undefined }]) invalid(() => parse(caption(override)));
  assert.equal(parse(caption({ text: 'a'.repeat(16000) })).text.length, 16000);
  assert.ok(!('ts' in parse(caption({ ts: undefined }))));
});

test('all language seq and sparse replay survive parsing; P2-08 owns revision suppression', () => {
  const store = createCaptionStore({ sessionId: 'local', epoch: 1 });
  const events = [caption(), caption({ lang: 'en', seq: 2 }), caption({ lang: 'src', seq: 3 }),
    caption({ seq: 4, final: true, revision: 2, text: '修正。' })].map(parse);
  assert.deepEqual(events.map((v) => v.seq), [1, 2, 3, 4]);
  for (const event of events) store.upsertHub({ ...event, epoch: 1 });
  assert.equal(store.upsertHub({ ...events[3], epoch: 1 }).newFinal, false);
  store.upsertHub({ ...events[3], revision: 3, seq: 5, text: '再修正。', epoch: 1 });
  assert.equal(store.snapshot().captions.find((v) => v.lang === 'ja').translatedText, '再修正。');
  assert.deepEqual(replay().map(parse).map((v) => v.seq), [12, 19, 25]);
  assert.equal(store.snapshot().gaps.reception, false);
  store.close();
});

test('malformed and oversized envelopes produce only safe errors, including unknown types', () => {
  for (const raw of ['', '{secret', 'null', '[]', '1', '{}', '{"type":1}', new ArrayBuffer(8), {}]) invalid(() => parseHubMessage(raw));
  const prefix = '{"type":"unknown","padding":"';
  const suffix = '"}';
  const exact = prefix + 'x'.repeat(HUB_LIMITS.messageBytes - prefix.length - suffix.length) + suffix;
  assert.equal(parseHubMessage(exact), null);
  invalid(() => parseHubMessage(exact + ' '));
  invalid(() => parse({ type: 'unknown', padding: 'あ'.repeat(350000) }));
  try { parseHubMessage('{synthetic-private-detail'); } catch (error) {
    assert.ok(!inspect(error).includes('synthetic-private-detail')); assert.equal(error.cause, undefined);
  }
});

test('unexpected settings and raw fields never escape; nonexistent protocols are ignored', () => {
  const secret = 'test-marker';
  const h = hello();
  Object.assign(h.settings, { apiKey: secret, endpoint: secret, access: { token: secret }, quota: secret });
  const outputs = [parse(h), parse({ ...caption(), detail: secret, processing: { key: secret } }), parse(status()),
    parse({ type: 'denied', detail: secret })];
  assert.ok(!JSON.stringify(outputs).includes(secret));
  for (const type of ['cast.audio', 'cast.start', 'cast.stop', 'subscribe', 'replay-end', 'translation', 'quota']) {
    assert.equal(parse({ type, detail: secret }), null);
  }
});
