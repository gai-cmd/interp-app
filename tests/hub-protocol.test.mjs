import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createHubProtocol, parseHubMessage, validateRoomCode, buildHello, REGISTERED_HUBS, HUB_LIMITS,
  HUB_CONTROL_VERSION, HUB_CONTROL_SCOPES } from '../app/hub/protocol.js';
import { NOTICE_SEVERITIES, POLICY_LIMITS, REGISTERED_FEATURES } from '../app/policy/schema.js';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { hub, hello, caption, status, replay, wire, control, controlHello, notice, noticeText, snapshot,
  releaseSnapshot, padded, EVENT_ID, EPOCH } from './fixtures/hub.mjs';
const parse = (v) => parseHubMessage(wire(v));
const invalid = (fn) => assert.throws(fn, { name: 'ProviderError', code: 'INVALID_RESULT' });
const rejected = (fn) => assert.throws(fn, { name: 'ProviderError', code: 'INVALID_REQUEST' });
const deepFrozen = (value) => value === null || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

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
  // P3-09: a hello without the control extension is a hub without live control (control: null).
  assert.deepEqual(event, { type: 'hello', sessionId: hello().sessionId,
    settings: { allowedLangs: ['ja', 'en', 'ko'], defaultLang: 'ja' }, control: null });
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

// ---------------------------------------------------------------------------
// P3-09: control extension (design-p3 §1.8, architecture.md "허브 통제")
// ---------------------------------------------------------------------------

test('hello negotiation: absent control marks an unsupported hub, a valid control is normalized, other versions are unsupported', () => {
  assert.equal(parse(hello()).control, null);
  assert.equal(parse({ ...hello(), control: null }).control, null);
  const event = parse(controlHello());
  assert.deepEqual(event, { type: 'hello', sessionId: hello().sessionId,
    settings: { allowedLangs: ['ja', 'en', 'ko'], defaultLang: 'ja' },
    control: { version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 12 } });
  assert.ok(deepFrozen(event));
  assert.equal(HUB_CONTROL_VERSION, 1);
  // A hub speaking another integer version negotiated nothing; listening may continue.
  for (const version of [0, 2, 99]) assert.equal(parse(controlHello({ version })).control, null);
  assert.equal(parse(controlHello({ version: 2, extra: 'ignored' })).control, null);
  // The legacy hello contract is unchanged: sessionId and settings are still required.
  invalid(() => parse({ ...controlHello(), sessionId: undefined }));
  invalid(() => parse({ ...controlHello(), settings: null }));
});

test('hello.control field limits: malformed version-1 control is an error, not silently unsupported', () => {
  for (const override of [{ version: '1' }, { version: 1.5 }, { version: null }, { version: undefined },
    { eventId: undefined }, { eventId: 'Service' }, { eventId: 'a'.repeat(65) }, { eventId: 'service 1' }, { eventId: 1 },
    { epoch: undefined }, { epoch: '' }, { epoch: 'a'.repeat(65) }, { epoch: 'ep och' }, { epoch: 'あ' },
    { revision: undefined }, { revision: -1 }, { revision: 1.5 }, { revision: '12' }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { stopped: true }, { disabledFeatures: [] }, { apiKey: 'x' }, { endpoint: 'wss://x' }, { constructor: {} }]) {
    invalid(() => parse(controlHello(override)));
  }
  for (const value of ['control', 1, true, [], [control()]]) invalid(() => parse({ ...hello(), control: value }));
  // A JSON "__proto__" member is an own key after JSON.parse and is rejected like any unknown key.
  invalid(() => parseHubMessage(wire(controlHello()).replace('"revision":12', '"revision":12,"__proto__":{"admin":true}')));
  assert.equal(parse(controlHello({ revision: 0 })).control.revision, 0);
  assert.equal(parse(controlHello({ revision: Number.MAX_SAFE_INTEGER })).control.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(parse(controlHello({ epoch: 'E.1:2_x-3' })).control.epoch, 'E.1:2_x-3');
});

test('buildHello emits the §1.8 negotiation envelope or a legacy hello, and rejects malformed control input', () => {
  const protocol = createHubProtocol({ hubs: [hub] });
  assert.equal(protocol.buildHello, buildHello);
  const text = buildHello('existing-session', { eventId: EVENT_ID, epoch: EPOCH, revision: 12 });
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), { type: 'hello', sessionId: 'existing-session', settings: {},
    control: { version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 12 } });
  // A supporting hub echoes the control block in its own hello, which normalizes to the same value.
  assert.deepEqual(parse({ ...JSON.parse(text), settings: hello().settings }).control, { version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 12 });
  assert.equal(JSON.parse(buildHello({ sessionId: 'existing-session' }, { eventId: EVENT_ID, epoch: EPOCH })).control.revision, 0);
  for (const session of [undefined, null, {}, { sessionId: null }]) {
    assert.deepEqual(JSON.parse(buildHello(session)), { type: 'hello', settings: {} });
    assert.ok(!('control' in JSON.parse(buildHello(session, null))));
  }
  for (const session of ['', 'a b', 'a'.repeat(257), 1, { sessionId: 1 }]) rejected(() => buildHello(session));
  for (const bad of ['x', 1, [], { eventId: EVENT_ID }, { epoch: EPOCH }, { eventId: 'Bad', epoch: EPOCH },
    { eventId: EVENT_ID, epoch: 'bad epoch' }, { eventId: EVENT_ID, epoch: EPOCH, revision: -1 },
    { eventId: EVENT_ID, epoch: EPOCH, revision: '1' }, { eventId: EVENT_ID, epoch: EPOCH, version: 1 },
    { eventId: EVENT_ID, epoch: EPOCH, apiKey: 'x' }, { eventId: EVENT_ID, epoch: EPOCH, stopped: false }]) {
    rejected(() => buildHello('s', bad));
  }
  assert.ok(new TextEncoder().encode(text).byteLength <= HUB_LIMITS.controlBytes);
});

test('policy.control snapshot normalizes the §1.8 example completely and deeply frozen', () => {
  const event = parse(snapshot());
  assert.deepEqual(event, { type: 'control', version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 13,
    issuedAt: '2026-09-06T01:00:00Z', ttlSeconds: 60, scope: 'event', stopped: true,
    disabledFeatures: ['simultaneousDirect'],
    notice: { id: 'pause-13', severity: 'warning', text: noticeText() } });
  assert.ok(deepFrozen(event));
  const release = parse(releaseSnapshot());
  assert.deepEqual([release.revision, release.stopped, release.disabledFeatures, release.notice], [14, false, [], null]);
  assert.deepEqual(HUB_CONTROL_SCOPES, ['event']);
  // All registered features may be disabled at once, in any order, and the input array is copied.
  const input = snapshot({ disabledFeatures: [...REGISTERED_FEATURES].reverse() });
  const all = parse(input);
  assert.deepEqual(all.disabledFeatures, [...REGISTERED_FEATURES].reverse());
  assert.notEqual(all.disabledFeatures, input.disabledFeatures);
  for (const severity of NOTICE_SEVERITIES) assert.equal(parse(snapshot({ notice: notice({ severity }) })).notice.severity, severity);
  // The parser keeps no state: the same wire text parses identically twice (ordering is P3-10's job).
  assert.deepEqual(parse(snapshot()), parse(snapshot()));
  assert.equal(parse(snapshot({ revision: 1 })).revision, 1);
});

test('policy.control is limited to 16KiB of UTF-8 while legacy envelopes keep the 1MiB limit', () => {
  assert.equal(HUB_LIMITS.controlBytes, 16384);
  assert.equal(parseHubMessage(padded(snapshot(), HUB_LIMITS.controlBytes)).revision, 13);
  invalid(() => parseHubMessage(padded(snapshot(), HUB_LIMITS.controlBytes + 1)));
  // Bytes, not characters: a notice body of 3-byte characters inflates the envelope.
  const wide = snapshot({ notice: notice({ text: noticeText({ ko: 'あ'.repeat(1000), en: 'あ'.repeat(1000), ja: 'あ'.repeat(1000) }) }) });
  assert.equal(parse(wide).notice.text.ja.length, 1000);
  const bytes = new TextEncoder().encode(wire(wide)).byteLength;
  assert.ok(bytes > 9000 && bytes <= HUB_LIMITS.controlBytes);
  assert.equal(parseHubMessage(padded(wide, HUB_LIMITS.controlBytes)).notice.text.ko.length, 1000);
  invalid(() => parseHubMessage(padded(wide, HUB_LIMITS.controlBytes + 1)));
  // A caption far beyond 16KiB still parses: the control limit is not applied to legacy envelopes.
  const big = caption({ text: 'あ'.repeat(HUB_LIMITS.textChars) });
  assert.ok(new TextEncoder().encode(wire(big)).byteLength > HUB_LIMITS.controlBytes);
  assert.equal(parse(big).text.length, HUB_LIMITS.textChars);
  assert.equal(parseHubMessage(padded(hello(), HUB_LIMITS.controlBytes + 1)).type, 'hello');
});

test('policy.control TTL is an integer within 10..120 seconds inclusive', () => {
  assert.deepEqual([HUB_LIMITS.ttlMinSeconds, HUB_LIMITS.ttlMaxSeconds], [10, 120]);
  for (const ttlSeconds of [10, 11, 60, 119, 120]) assert.equal(parse(snapshot({ ttlSeconds })).ttlSeconds, ttlSeconds);
  for (const ttlSeconds of [9, 121, 0, -60, 1e9, 60.5, '60', null, undefined, true, NaN, Infinity]) {
    invalid(() => parse(snapshot({ ttlSeconds })));
  }
  // The parser does no clock work: issuedAt is retained verbatim and never compared to now.
  for (const issuedAt of ['1999-01-01T00:00:00Z', '2099-12-31T23:59:59.999Z']) {
    assert.equal(parse(snapshot({ issuedAt })).issuedAt, issuedAt);
  }
});

test('policy.control field limits: identifiers, revision, issuedAt, scope, stopped, features, notice', () => {
  const bad = [
    { version: 2 }, { version: '1' }, { version: undefined },
    { eventId: undefined }, { eventId: 'Service' }, { eventId: 'a'.repeat(65) }, { eventId: '' }, { eventId: null },
    { epoch: undefined }, { epoch: '' }, { epoch: 'a'.repeat(65) }, { epoch: 'a b' }, { epoch: 7 },
    { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: '13' }, { revision: undefined }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { issuedAt: undefined }, { issuedAt: 1788609600000 }, { issuedAt: '2026-09-06T01:00:00+09:00' }, { issuedAt: '2026-09-06 01:00:00Z' },
    { issuedAt: '2026-09-06T25:00:00Z' }, { issuedAt: '2026-09-06T01:00:00.1234Z' },
    { scope: undefined }, { scope: 'site' }, { scope: 'room' }, { scope: 'global' }, { scope: null },
    { stopped: undefined }, { stopped: 'true' }, { stopped: 1 }, { stopped: null },
    { disabledFeatures: undefined }, { disabledFeatures: null }, { disabledFeatures: 'simultaneousDirect' },
    { disabledFeatures: ['simultaneousDirect', 'simultaneousDirect'] }, { disabledFeatures: ['live'] },
    { disabledFeatures: ['unknownFeature'] }, { disabledFeatures: [1] }, { disabledFeatures: [null] },
    { disabledFeatures: [...REGISTERED_FEATURES, 'extra'] },
    { notice: undefined }, { notice: 'text' }, { notice: [] }, { notice: {} },
    { notice: notice({ id: undefined }) }, { notice: notice({ id: 'Pause' }) }, { notice: notice({ id: 'a'.repeat(65) }) },
    { notice: notice({ severity: undefined }) }, { notice: notice({ severity: 'error' }) }, { notice: notice({ severity: 'fatal' }) },
    { notice: notice({ text: undefined }) }, { notice: notice({ text: 'plain' }) }, { notice: notice({ text: null }) },
    { notice: notice({ text: noticeText({ fr: 'bonjour' }) }) }, { notice: notice({ text: { ko: 'a', en: 'b' } }) },
    { notice: notice({ text: noticeText({ ja: '' }) }) }, { notice: notice({ text: noticeText({ en: '   ' }) }) },
    { notice: notice({ text: noticeText({ en: 1 }) }) }, { notice: notice({ text: noticeText({ ko: 'a'.repeat(POLICY_LIMITS.textChars + 1) }) }) },
    { notice: notice({ text: noticeText({ en: '<b>bold</b>' }) }) }, { notice: notice({ text: noticeText({ en: '<script>' }) }) },
    { notice: notice({ text: noticeText({ ko: 'a\u0001b' }) }) }, { notice: notice({ text: noticeText({ ja: 'a\u007fb' }) }) },
    { notice: notice({ showUntil: '2026-09-06T02:00:00Z' }) }, { notice: notice({ url: 'https://x' }) },
  ];
  for (const override of bad) invalid(() => parse(snapshot(override)));
  assert.equal(parse(snapshot({ notice: notice({ text: noticeText({ ko: 'a'.repeat(POLICY_LIMITS.textChars) }) }) })).notice.text.ko.length, POLICY_LIMITS.textChars);
  assert.equal(parse(snapshot({ notice: notice({ text: noticeText({ en: 'line one\nline two\ttab' }) }) })).notice.text.en, 'line one\nline two\ttab');
  assert.equal(parse(snapshot({ notice: notice({ text: noticeText({ en: '2 < 3 and a > b' }) }) })).notice.text.en, '2 < 3 and a > b');
  assert.equal(parse(snapshot({ issuedAt: '2026-09-06T01:00:00.250Z' })).issuedAt, '2026-09-06T01:00:00.250Z');
  for (const key of ['type', 'version', 'eventId', 'epoch', 'revision', 'issuedAt', 'ttlSeconds', 'scope', 'stopped', 'disabledFeatures', 'notice']) {
    const missing = snapshot();
    delete missing[key];
    invalid(() => parse(missing));
  }
});

test('a hub can only add restrictions: keys, endpoints, models, pricing, settings and unknown keys are rejected', () => {
  const secret = 'test-marker';
  for (const extra of [{ apiKey: secret }, { endpoint: 'wss://evil.invalid/ws' }, { model: 'other-model' },
    { pricing: { rates: [] } }, { settings: { 'ui.tone': 'mono' } }, { features: { simultaneousDirect: true } },
    { enabledFeatures: ['live'] }, { allowedLangs: ['ja'] }, { emergency: { stopped: false } }, { allowedHubIds: ['x'] },
    { minAppVersion: '9.9.9' }, { roomCode: 'Ab12' }, { padding: '' }, { constructor: {} }, { prototype: {} }]) {
    invalid(() => parse({ ...snapshot(), ...extra }));
  }
  invalid(() => parseHubMessage(wire(snapshot()).replace('"stopped":true', '"stopped":true,"__proto__":{"stopped":false}')));
  try { parse({ ...snapshot(), apiKey: secret, notice: notice({ text: noticeText({ en: secret }) }) }); }
  catch (error) { assert.ok(!inspect(error).includes(secret)); assert.equal(error.cause, undefined); }
  // A snapshot that only lifts restrictions is still a full snapshot: it grants nothing beyond registered features.
  const release = parse(releaseSnapshot());
  assert.deepEqual(Object.keys(release).sort(), ['disabledFeatures', 'epoch', 'eventId', 'issuedAt', 'notice', 'revision',
    'scope', 'stopped', 'ttlSeconds', 'type', 'version']);
});

test('the legacy settings envelope and hello.settings never carry control (no administrator grant)', () => {
  const control = { version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 99 };
  const grant = { stopped: false, disabledFeatures: [], control, admin: true, allowedFeatures: ['live'], scope: 'event' };
  const fromSettings = parse({ type: 'settings', settings: { allowedLangs: ['ja'], defaultLang: 'ja', ...grant }, ...grant });
  assert.deepEqual(fromSettings, { type: 'settings', settings: { allowedLangs: ['ja'], defaultLang: 'ja' } });
  const h = hello();
  Object.assign(h.settings, grant);
  assert.deepEqual(parse(h), { type: 'hello', sessionId: h.sessionId,
    settings: { allowedLangs: ['ja', 'en', 'ko'], defaultLang: 'ja' }, control: null });
  // Control fields on other legacy envelopes are dropped as before, never promoted.
  for (const legacy of [caption(), status(), { type: 'cast.stopped' }, { type: 'closed' }, { type: 'denied' }]) {
    const event = parse({ ...legacy, ...grant });
    assert.ok(!('control' in event) && !('stopped' in event) && !('disabledFeatures' in event) && !('scope' in event));
  }
  // Only the exact envelope type is control; look-alike types are unknown (null), not snapshots.
  for (const type of ['policy', 'control', 'policy.control.v2', 'Policy.Control', 'policy-control', 'cast.control']) {
    assert.equal(parse({ ...snapshot(), type }), null);
  }
  assert.ok(!JSON.stringify([fromSettings, parse(h)]).includes('99'));
});
