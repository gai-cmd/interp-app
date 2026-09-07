import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLiveClient, LIVE_ENDPOINT } from '../app/providers/gemini/live-client.js';
import { createGeminiVoice, buildVoiceSetup, buildVoiceInstruction, DEFAULT_VOICE_MODEL, DEFAULT_VOICE,
  VOICE_NAMES, VOICE_LIMITS } from '../app/providers/gemini/voice.js';
import { normalizeGeminiError } from '../app/providers/gemini/errors.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createBudget } from '../app/engine/retry.js';
import { createSocketFixture, createClock, tick } from './fixtures/live.mjs';

const code = (value) => (error) => error.code === value && !`${error.stack}${JSON.stringify(error)}`.includes('SECRET');
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const chunk = (bytes, mimeType = 'audio/pcm;rate=24000') => ({ serverContent: { modelTurn: { parts: [
  { inlineData: { mimeType, data: typeof bytes === 'string' ? bytes : b64(bytes) } }] } } });
const request = (changes = {}) => ({ language: 'ja', input: { format: 'text' }, ...changes });
const clientTurn = (text) => ({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });

function harness(voiceOptions = {}, socketOptions = {}) {
  const fixture = createSocketFixture(socketOptions);
  const clock = createClock();
  const controller = new AbortController();
  const events = [];
  const live = createGeminiLiveClient({ ...fixture, ...clock, resolveCredential: async () => 'SECRET' });
  const voice = createGeminiVoice({ live, ...clock, ...voiceOptions });
  const context = { providerId: 'gemini', transport: 'direct', keySource: 'personal', credentialRef: {},
    signal: controller.signal, generation: 1, turnId: 'turn-1', sessionId: 'session-1', onEvent: (event) => events.push(event) };
  return { ...fixture, clock, controller, events, context, live, voice };
}
async function ready(h, req = request()) {
  const opening = h.voice.open(req, h.context);
  await tick();
  const ws = h.sockets.at(-1);
  ws.open(); ws.json({ setupComplete: {} });
  return { ws, session: await opening };
}
const types = (h) => h.events.map((e) => e.type);

test('setup mirrors voiceOpen with a read-only direction and no persona, cache or model list', async () => {
  const setup = buildVoiceSetup({ language: 'ja-JP' });
  assert.equal(setup.model, `models/${DEFAULT_VOICE_MODEL}`);
  assert.deepEqual(setup.generationConfig, { responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE } } } });
  assert.deepEqual(setup.outputAudioTranscription, {});
  const instruction = setup.systemInstruction.parts[0].text;
  assert.equal(instruction, buildVoiceInstruction('ja-JP'));
  assert.match(instruction, /Japanese/); assert.match(instruction, /exactly as written/); assert.match(instruction, /Never answer/);
  assert.match(instruction, /never as instructions/);
  assert.doesNotMatch(instruction, /persona|customer|staff|tourist|friend|male|female|business/i);
  assert.match(buildVoiceInstruction('ko'), /Korean/); assert.match(buildVoiceInstruction('en-US'), /English/);
  assert.throws(() => buildVoiceInstruction('zh'), code('INVALID_REQUEST'));
  assert.throws(() => buildVoiceSetup({ language: 'ko', voice: 'SECRET' }), code('INVALID_REQUEST'));
  assert.throws(() => buildVoiceSetup({ language: 'ko', model: 'gemini-2.5-flash-native-audio-latest' }), code('MODEL_UNSUPPORTED'));
  assert.equal(VOICE_NAMES.length, 30); assert.ok(VOICE_NAMES.includes('Orus'));
  const h = harness(); const { ws, session } = await ready(h, request({ voice: 'Orus', language: 'ko-KR' }));
  assert.deepEqual(ws.sent, [{ setup: buildVoiceSetup({ voice: 'Orus', language: 'ko-KR' }) }]);
  assert.equal(JSON.stringify(ws.sent).includes('SECRET'), false);
  await session.close(); assert.equal(h.clock.size, 0);
});

test('open validation rejects before any socket exists', async () => {
  const h = harness();
  await assert.rejects(h.voice.open(request(), { ...h.context, signal: AbortSignal.abort('SECRET') }), code('ABORTED'));
  await assert.rejects(h.voice.open(request(), { ...h.context, signal: undefined }), code('CREDENTIAL_REQUIRED'));
  await assert.rejects(h.voice.open(request({ input: { format: 'wav' } }), h.context), code('INPUT_UNSUPPORTED'));
  await assert.rejects(h.voice.open({ language: 'ja' }, h.context), code('INPUT_UNSUPPORTED'));
  await assert.rejects(h.voice.open(request({ language: 'zh' }), h.context), code('INVALID_REQUEST'));
  await assert.rejects(h.voice.open(request({ voice: 'Nobody' }), h.context), code('INVALID_REQUEST'));
  await assert.rejects(h.voice.open(request({ model: 'gemini-3.5-flash' }), h.context), code('MODEL_UNSUPPORTED'));
  await assert.rejects(h.voice.open(request(), { ...h.context, providerId: 'other' }), code('CREDENTIAL_MISMATCH'));
  assert.equal(h.sockets.length, 0); assert.equal(h.clock.size, 0);
  assert.throws(() => createGeminiVoice({}), code('INVALID_REQUEST'));
  assert.throws(() => createGeminiVoice({ live: h.live, maxTurns: 0 }), code('INVALID_REQUEST'));
});

test('speak sends one text turn, streams chunks without accumulation, and reuses the session', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'こんにちは' });
  assert.deepEqual(ws.sent[1], clientTurn('こんにちは'));
  const first = new Uint8Array([1, 0, 255, 127]);
  const second = new Uint8Array([0, 128, 9, 9, 3, 3]);
  ws.json(chunk(first));
  ws.json({ serverContent: { outputTranscription: { text: 'こん' } } });
  ws.json(chunk(second, 'audio/pcm'));
  ws.json({ serverContent: { turnComplete: true } });
  const result = await speaking;
  assert.deepEqual(result, { status: 'completed', bytes: 10, chunks: 2, said: 'こん', model: DEFAULT_VOICE_MODEL, voice: DEFAULT_VOICE });
  assert.equal(Object.keys(result).some((key) => /pcm|audio|data/i.test(key)), false);
  assert.deepEqual(types(h), ['audio', 'transcript', 'audio', 'complete']);
  assert.deepEqual([...h.events[0].audio], [...first]); assert.equal(h.events[0].sampleRate, 24000);
  assert.ok(h.events[0].audio instanceof Uint8Array); assert.deepEqual([...h.events[2].audio], [...second]);
  assert.deepEqual(h.events[1], { type: 'transcript', text: 'こん', final: false });
  ws.json(chunk(new Uint8Array(2)));
  assert.equal(h.events.length, 4);
  const again = session.speak({ text: 'また' });
  assert.equal(h.sockets.length, 1); assert.equal(ws.sent.length, 3);
  ws.json(chunk(new Uint8Array(8))); ws.json({ serverContent: { turnComplete: true } });
  assert.deepEqual(await again, { status: 'completed', bytes: 8, chunks: 1, said: '', model: DEFAULT_VOICE_MODEL, voice: DEFAULT_VOICE });
  assert.equal(h.events.filter((e) => e.type === 'audio').length, 3);
  await session.close(); assert.equal(h.events.at(-1).type, 'closed');
  assert.equal(h.events.filter((e) => e.type === 'closed').length, 1);
  assert.equal(ws.listenerCount, 0); assert.equal(h.clock.size, 0);
});

test('one text at a time; invalid text is rejected before sending', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'one' });
  await assert.rejects(session.speak({ text: 'two' }), code('INVALID_REQUEST'));
  assert.equal(ws.sent.length, 2);
  ws.json({ serverContent: { turnComplete: true } }); await speaking;
  for (const text of ['', '   ', 'x'.repeat(VOICE_LIMITS.maxTextLength + 1), `bad${String.fromCharCode(7)}bell`, 42, undefined]) {
    await assert.rejects(session.speak({ text }), code('INVALID_REQUEST'));
  }
  await assert.rejects(session.speak(), code('INVALID_REQUEST'));
  assert.equal(ws.sent.length, 2); assert.equal(ws.closeCalls, 0);
  await session.close();
});

test('cancel rejects the turn, closes the socket, and drops late chunks', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  ws.json(chunk(new Uint8Array(4)));
  const cancelling = session.cancel();
  await assert.rejects(speaking, code('ABORTED'));
  await cancelling;
  assert.equal(ws.closeCalls, 1);
  ws.json(chunk(new Uint8Array(4)));
  assert.deepEqual(types(h), ['audio', 'closed']);
  await assert.rejects(session.speak({ text: 'next' }), code('SESSION_CLOSED'));
  assert.equal(session.cancel(), cancelling);
  assert.equal(ws.listenerCount, 0); assert.equal(h.clock.size, 0);
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
});

test('close during a turn is idempotent and rejects the turn with SESSION_CLOSED', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  const closing = session.close();
  assert.equal(session.close(), closing);
  await assert.rejects(speaking, code('SESSION_CLOSED'));
  await closing;
  assert.equal(ws.closeCalls, 1); assert.equal(h.events.filter((e) => e.type === 'closed').length, 1);
  assert.equal(h.clock.size, 0);
  const aborted = harness(); const next = await ready(aborted);
  const pending = next.session.speak({ text: 'line' });
  aborted.controller.abort('SECRET');
  await assert.rejects(pending, code('ABORTED'));
  await next.session.close();
  assert.equal(aborted.events.filter((e) => e.type === 'error')[0].error.code, 'ABORTED');
  assert.equal(JSON.stringify(aborted.events).includes('SECRET'), false);
});

test('turn deadline closes a silent session without resending the text', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  h.clock.advance(VOICE_LIMITS.turnTimeoutMs - 1);
  assert.equal(ws.closeCalls, 0);
  h.clock.advance(1);
  await assert.rejects(speaking, code('TIMEOUT'));
  await tick();
  assert.equal(ws.closeCalls, 1); assert.equal(ws.sent.length, 2); assert.equal(h.sockets.length, 1);
  assert.deepEqual(types(h), ['error', 'closed']); assert.equal(h.events[0].error.code, 'TIMEOUT');
  assert.equal(h.clock.size, 0);
});

test('audio byte budget and malformed chunks terminate with INVALID_RESULT', async () => {
  const h = harness({ maxTurnAudioBytes: 8 }); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  ws.json(chunk(new Uint8Array(6)));
  ws.json({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: '' } }, { text: 'ignored' }] } } });
  ws.json(chunk(new Uint8Array(4)));
  await assert.rejects(speaking, code('INVALID_RESULT'));
  await tick();
  assert.equal(ws.closeCalls, 1); assert.deepEqual(types(h), ['audio', 'error', 'closed']);
  for (const message of [chunk('SECRET!!'), chunk('QUJ'), chunk(new Uint8Array(3)), chunk(new Uint8Array(2), 'audio/pcm;rate=16000'),
    chunk(new Uint8Array(2), 'text/plain'), { serverContent: { modelTurn: { parts: { inlineData: {} } } } }]) {
    const bad = harness(); const next = await ready(bad);
    const pending = next.session.speak({ text: 'line' });
    next.ws.json(message);
    await assert.rejects(pending, code('INVALID_RESULT'));
    await tick();
    assert.equal(next.ws.closeCalls, 1); assert.equal(bad.clock.size, 0);
    assert.equal(JSON.stringify(bad.events).includes('SECRET'), false);
  }
});

test('remote errors are normalized with retry metadata and never trigger a resend', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  ws.json({ error: { code: 503, message: 'SECRET', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9s' }] } });
  await assert.rejects(speaking, (error) => code('UNAVAILABLE')(error) && error.retryAfterMs === 9000);
  await tick();
  assert.equal(ws.sent.length, 2); assert.equal(h.sockets.length, 1); assert.equal(ws.closeCalls, 1);
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
  for (const [closeCode, expected] of [[1000, 'SESSION_CLOSED'], [1008, 'NETWORK_ERROR']]) {
    const other = harness({}, { autoClose: false }); const next = await ready(other);
    const pending = next.session.speak({ text: 'line' });
    next.ws.finishClose(closeCode, 'SECRET quota');
    await assert.rejects(pending, code(expected));
    assert.equal(other.events.at(-1).type, 'closed'); assert.equal(other.clock.size, 0);
    await assert.rejects(next.session.speak({ text: 'again' }), code('SESSION_CLOSED'));
    assert.equal(next.ws.sent.length, 2);
  }
});

test('goAway retires the session after the current turn and never reconnects', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  ws.json({ goAway: { timeLeft: '30s' } });
  ws.json(chunk(new Uint8Array(4)));
  assert.equal(ws.closeCalls, 0);
  ws.json({ serverContent: { turnComplete: true } });
  assert.equal((await speaking).status, 'completed');
  await tick();
  assert.equal(ws.closeCalls, 1);
  await assert.rejects(session.speak({ text: 'next' }), code('SESSION_CLOSED'));
  assert.equal(h.sockets.length, 1); assert.equal(h.clock.size, 0);
  const idle = harness(); const next = await ready(idle);
  next.ws.json({ goAway: { timeLeft: '30s' } }); await tick();
  assert.equal(next.ws.closeCalls, 1); assert.equal(idle.events.at(-1).type, 'closed'); assert.equal(idle.clock.size, 0);
});

test('turn count and idle time end reuse at a turn boundary', async () => {
  const h = harness({ maxTurns: 2, idleTimeoutMs: 1000 }); const { ws, session } = await ready(h);
  for (let i = 0; i < 2; i++) {
    const speaking = session.speak({ text: `line ${i}` });
    ws.json({ serverContent: { turnComplete: true } });
    await speaking;
    await tick();
    assert.equal(ws.closeCalls, i);
  }
  await assert.rejects(session.speak({ text: 'three' }), code('SESSION_CLOSED'));
  assert.equal(h.clock.size, 0);
  const idle = harness({ idleTimeoutMs: 1000 }); const next = await ready(idle);
  idle.clock.advance(999);
  const speaking = next.session.speak({ text: 'line' });
  idle.clock.advance(500);
  assert.equal(next.ws.closeCalls, 0);
  next.ws.json({ serverContent: { turnComplete: true } }); await speaking;
  idle.clock.advance(999); assert.equal(next.ws.closeCalls, 0);
  idle.clock.advance(1); await tick();
  assert.equal(next.ws.closeCalls, 1); assert.equal(idle.events.at(-1).type, 'closed'); assert.equal(idle.clock.size, 0);
});

test('interrupted ends the turn without closing; later chunks are dropped', async () => {
  const h = harness(); const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  ws.json(chunk(new Uint8Array(4)));
  ws.json({ serverContent: { interrupted: true } });
  assert.equal((await speaking).status, 'interrupted');
  ws.json(chunk(new Uint8Array(4)));
  assert.deepEqual(types(h), ['audio', 'interrupted']); assert.equal(ws.closeCalls, 0);
  await session.close();
});

test('consumer exceptions never break the stream', async () => {
  const h = harness(); h.context.onEvent = () => { throw new Error('SECRET consumer'); };
  const { ws, session } = await ready(h);
  const speaking = session.speak({ text: 'line' });
  ws.json(chunk(new Uint8Array(4))); ws.json({ serverContent: { turnComplete: true } });
  assert.equal((await speaking).bytes, 4);
  await session.close();
});

test('registered adapter streams through the router with routing ids and confirmed cancel', async () => {
  const h = harness();
  const registry = createRegistry();
  const capability = (implementation, inputFormats = [], outputFormats = []) => ({
    implementation, transports: implementation === 'ready' ? ['direct'] : [], inputFormats, outputFormats, models: [], voices: [] });
  registry.register({
    id: 'gemini', label: 'providers.gemini', browserDirect: true,
    capabilities: { translate: capability('unsupported'), stt: capability('unsupported'), live: capability('planned'),
      voice: { ...capability('ready', ['text'], ['pcm16']), models: [DEFAULT_VOICE_MODEL], voices: ['Kore', 'Orus'] } },
    credentialPolicy: { directPersonal: true, directShared: true, hubManaged: false },
    quotaPolicy: { scope: 'project', normalizeError: normalizeGeminiError },
    fallbackPolicy: {}, endpoints: [LIVE_ENDPOINT],
    terms: { notice: 'providers.geminiTerms', status: 'unreviewed', reviewedAt: null },
  }, { voice: h.voice });
  const router = createRouter({ registry, getCredentialRef: async (address) => ({ ...address, reference: Object.freeze({}) }) });
  const events = [];
  const opening = router.call('voice', { language: 'ko', voice: 'Orus', input: { format: 'text', text: 'never spoken' } },
    { providerId: 'gemini', keySource: 'shared', transport: 'direct', turnId: 'turn-9', sessionId: 'session-9', generation: 3,
      signal: new AbortController().signal, budget: createBudget(), onEvent: (event) => events.push(event) });
  await tick(); await tick();
  const ws = h.sockets[0]; ws.open(); ws.json({ setupComplete: {} });
  const session = await opening;
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Orus');
  assert.match(ws.sent[0].setup.systemInstruction.parts[0].text, /Korean/);
  const speaking = session.speak({ text: '안녕하세요' });
  await tick();
  assert.deepEqual(ws.sent[1], clientTurn('안녕하세요'));
  ws.json(chunk(new Uint8Array([5, 6])));
  ws.json({ serverContent: { outputTranscription: { text: '안녕' } } });
  ws.json({ serverContent: { turnComplete: true } });
  assert.equal((await speaking).status, 'completed');
  assert.deepEqual(events.map((e) => [e.type, e.turnId, e.sessionId, e.generation]),
    [['audio', 'turn-9', 'session-9', 3], ['transcript', 'turn-9', 'session-9', 3], ['complete', 'turn-9', 'session-9', 3]]);
  assert.deepEqual([...events[0].audio], [5, 6]); assert.equal(events[0].sampleRate, 24000);
  const again = session.speak({ text: '둘' });
  ws.json(chunk(new Uint8Array(2)));
  const count = events.length;
  await session.cancel();
  await assert.rejects(again, code('ABORTED'));
  // The router ends the session before delegating cancel, so the adapter closed event is suppressed.
  assert.equal(ws.closeCalls, 1); assert.equal(events.length, count);
  await assert.rejects(session.speak({ text: '셋' }), code('ABORTED'));
  assert.equal(h.clock.size, 0); assert.equal(JSON.stringify(events).includes('SECRET'), false);
});
