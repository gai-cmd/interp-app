import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVoiceEngine, VOICE_POLICY, VOICE_MESSAGE_KEYS } from '../app/engine/voice.js';
import { ProviderError } from '../app/providers/contract.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createGeminiLiveClient, LIVE_ENDPOINT } from '../app/providers/gemini/live-client.js';
import { createGeminiVoice, DEFAULT_VOICE_MODEL } from '../app/providers/gemini/voice.js';
import { normalizeGeminiError } from '../app/providers/gemini/errors.js';
import { createSocketFixture, createClock, tick } from './fixtures/live.mjs';

const observed = new Set();
function check(result) {
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  if (result.messageKey !== undefined) { observed.add(result.messageKey); assert.ok(VOICE_MESSAGE_KEYS.includes(result.messageKey), result.messageKey); }
  if (result.status === 'completed' && !result.fallback) assert.equal(result.messageKey, undefined);
  assert.equal(result.actualFirstSoundAt, null);
  return result;
}
async function until(condition, limit = 50) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}

function fakeAudioContext({ autoEnd = true } = {}) {
  const sources = [];
  return { currentTime: 0, destination: {}, resumed: 0, sources, resumeError: null,
    async resume() { if (this.resumeError) throw this.resumeError; this.resumed++; },
    createBuffer(channels, size, rate) {
      assert.equal(channels, 1); assert.equal(rate, 24000);
      const data = new Float32Array(size); return { data, duration: size / rate, getChannelData: () => data };
    },
    createBufferSource() {
      const source = { at: null, stopped: false, connect() {}, disconnect() {}, stop() { this.stopped = true; },
        start(at) { this.at = at; if (autoEnd) setImmediate(() => this.onended?.()); } };
      sources.push(source); return source;
    } };
}
function fakeDevice(status = 'completed') {
  const device = { calls: [], cancels: 0, status,
    speak(request, context = {}) {
      device.calls.push({ request, context });
      const result = { featureId: 'device-tts', turnId: context.turnId, generation: context.generation,
        privacyMessageKey: 'voice.devicePrivacy', offlineGuaranteed: false, localService: true, secret: 'SECRET' };
      if (context.signal?.aborted) return Promise.resolve({ ...result, status: 'cancelled', messageKey: 'error.ABORTED' });
      return Promise.resolve({ ...result, status: device.status,
        messageKey: device.status === 'completed' ? undefined : device.status === 'unavailable' ? 'voice.deviceUnavailable' : 'error.VOICE_FAILED' });
    },
    cancel() { device.cancels++; } };
  return device;
}
function fakeRouter() {
  const router = { calls: [], sessions: [], openError: null,
    async call(capability, request, context) {
      router.calls.push({ capability, request, context });
      context.budget.consume({ providerId: context.providerId, keySource: context.keySource, signal: context.signal });
      if (router.openError) throw typeof router.openError === 'function' ? router.openError() : router.openError;
      const session = { request, context, speaks: [], closes: 0, pending: null,
        emit: (event) => context.onEvent(event),
        speak(req) { session.speaks.push(req); return new Promise((resolve, reject) => { session.pending = { resolve, reject }; }); },
        async cancel() {}, async close() { session.closes++; },
        audio(bytes = 4800) { session.emit({ type: 'audio', audio: new Uint8Array(bytes), sampleRate: 24000 }); },
        complete(fields = {}) { session.pending.resolve({ status: 'completed', bytes: 4800, chunks: 1, said: '', model: DEFAULT_VOICE_MODEL, voice: 'Kore', ...fields }); },
        fail(error) { session.pending.reject(error instanceof Error ? error : new ProviderError(error)); },
      };
      router.sessions.push(session);
      return session;
    } };
  return router;
}
function setup({ device = 'completed', router = fakeRouter(), audio = fakeAudioContext(), clock = createClock(), ...options } = {}) {
  const tts = device === null ? null : fakeDevice(device);
  const engine = createVoiceEngine({ router, deviceTTS: tts, getAudioContext: () => audio,
    ...clock, random: () => 0, now: () => 0, ...options });
  return { clock, audio, tts, router, engine };
}
// The next session that receives a line: sessions opened but never spoken to do not count.
const session = async (h, index = h.router.sessions.filter((s) => s.speaks.length).length) => {
  await until(() => h.router.sessions[index]?.speaks.length > 0);
  return h.router.sessions[index];
};
const context = (changes = {}) => ({ turnId: 'turn-1', sessionId: 'session-1', providerId: 'gemini', keySource: 'personal', ...changes });
const line = (changes = {}) => ({ text: '안녕하세요', language: 'ko', ...changes });

test('rejects invalid composition', () => {
  const router = fakeRouter();
  assert.throws(() => createVoiceEngine({ router }), (e) => e.code === 'INVALID_REQUEST');
  assert.throws(() => createVoiceEngine({ router, getAudioContext: () => null, deviceTTS: {} }), (e) => e.code === 'INVALID_REQUEST');
  assert.throws(() => createVoiceEngine({ router, getAudioContext: () => null, firstAudioTimeoutMs: 0 }), (e) => e.code === 'INVALID_REQUEST');
});

test('completed Live turn plays every chunk once, resolves after playback, and reuses the session', async () => {
  const h = setup();
  const done = h.engine.speak(line(), context());
  const s = await session(h);
  assert.deepEqual(s.speaks, [{ text: '안녕하세요' }]);
  assert.deepEqual(s.request, { language: 'ko', input: { format: 'text' } });
  assert.equal(s.context.providerId, 'gemini'); assert.equal(s.context.keySource, 'personal');
  assert.equal(s.context.transport, 'direct'); assert.equal(s.context.budget.remaining, 0);
  assert.equal(h.engine.snapshot().active, true);
  s.audio(4800); s.emit({ type: 'transcript', text: '안녕', final: false }); s.audio(2400);
  assert.equal(h.engine.snapshot().firstAudio, true);
  s.complete({ bytes: 7200, chunks: 2 });
  const result = check(await done);
  assert.equal(result.status, 'completed'); assert.equal(result.engine, 'live');
  assert.equal(result.firstAudio, true); assert.equal(result.fallback, false);
  assert.equal(result.said, '안녕'); assert.equal(result.bytes, 7200); assert.equal(result.voice, 'Kore');
  assert.equal(result.generation, s.context.generation); assert.equal(result.turnId, 'turn-1');
  assert.equal(result.deviceFallbackAvailable, false); assert.equal(result.firstReceivedAt, 0);
  assert.equal(h.audio.sources.length, 2); assert.equal(h.audio.sources[1].at, h.audio.sources[0].at + 0.1);
  assert.equal(h.tts.calls.length, 0); assert.equal(h.clock.size, 0);
  s.audio(4800); assert.equal(h.audio.sources.length, 2);
  const again = h.engine.speak(line({ text: '두 번째' }), context({ turnId: 'turn-2' }));
  await until(() => s.speaks.length === 2);
  assert.equal(h.router.calls.length, 1); assert.equal(h.engine.snapshot().sessionOpen, true);
  s.audio(); s.complete();
  const second = check(await again);
  assert.equal(second.status, 'completed'); assert.equal(second.turnId, 'turn-2');
  assert.equal(second.generation, result.generation);
  await h.engine.close();
  assert.equal(s.closes, 1); assert.equal(h.engine.snapshot().sessionOpen, false); assert.equal(h.clock.size, 0);
  assert.equal(h.tts.cancels, 1);
});

test('open failure before audio falls back to device speech once, then cools down and finally suspends', async () => {
  const h = setup();
  h.router.openError = () => Object.assign(new ProviderError('UNAVAILABLE'), { retryAfterMs: 3000 });
  const first = check(await h.engine.speak(line(), context()));
  assert.equal(first.engine, 'device'); assert.equal(first.status, 'completed'); assert.equal(first.fallback, true);
  assert.equal(first.messageKey, 'voice.fallback'); assert.equal(first.liveErrorCode, 'UNAVAILABLE');
  assert.equal(first.privacyMessageKey, 'voice.devicePrivacy'); assert.equal(first.localService, true);
  assert.deepEqual(h.tts.calls[0].request, { text: '안녕하세요', language: 'ko', voiceURI: undefined });
  assert.equal(h.router.calls.length, 1); assert.equal(h.engine.snapshot().live, 'cooling');
  const second = check(await h.engine.speak(line(), context({ turnId: 'turn-2' })));
  assert.equal(second.engine, 'device'); assert.equal(second.liveErrorCode, 'UNAVAILABLE');
  assert.equal(h.router.calls.length, 1);
  h.clock.advance(2999); await tick(); assert.equal(h.engine.snapshot().live, 'cooling');
  h.clock.advance(1); await tick(); assert.equal(h.engine.snapshot().live, 'ready');
  h.router.openError = new ProviderError('NETWORK_ERROR');
  for (const [attempts, wait] of [[2, 2000], [3, 4000]]) {
    check(await h.engine.speak(line(), context()));
    assert.equal(h.router.calls.length, attempts); assert.equal(h.engine.snapshot().live, 'cooling');
    h.clock.advance(wait); await tick(); assert.equal(h.engine.snapshot().live, 'ready');
  }
  check(await h.engine.speak(line(), context()));
  await tick();
  assert.equal(h.router.calls.length, 4);
  assert.deepEqual([h.engine.snapshot().live, h.engine.snapshot().suspendedCode], ['suspended', 'BUDGET_EXHAUSTED']);
  const suspended = check(await h.engine.speak(line(), context()));
  assert.equal(suspended.engine, 'device'); assert.equal(suspended.liveErrorCode, 'BUDGET_EXHAUSTED');
  assert.equal(h.router.calls.length, 4); assert.equal(h.clock.size, 0);
  h.engine.restart();
  assert.equal(h.engine.snapshot().live, 'ready'); assert.equal(h.engine.snapshot().retries, 0);
  h.router.openError = null;
  const done = h.engine.speak(line(), context());
  const s = await session(h); s.audio(); s.complete();
  assert.equal(check(await done).engine, 'live');
  await h.engine.close();
});

test('fatal errors suspend Live immediately; turn-local errors do not change health', async () => {
  const h = setup();
  h.router.openError = new ProviderError('INVALID_KEY');
  const result = check(await h.engine.speak(line({ allowDeviceFallback: false }), context()));
  assert.equal(result.status, 'failed'); assert.equal(result.messageKey, 'error.VOICE_FAILED');
  assert.equal(result.errorCode, 'INVALID_KEY'); assert.equal(result.deviceFallbackAvailable, true);
  assert.equal(h.tts.calls.length, 0);
  assert.deepEqual([h.engine.snapshot().live, h.engine.snapshot().suspendedCode], ['suspended', 'INVALID_KEY']);
  assert.equal(h.clock.size, 0);
  h.engine.restart(); h.router.openError = new ProviderError('SAFETY_BLOCKED');
  check(await h.engine.speak(line(), context()));
  assert.equal(h.engine.snapshot().live, 'ready'); assert.equal(h.engine.snapshot().lastLiveError, 'SAFETY_BLOCKED');
  await h.engine.close();
});

test('failure after the first chunk is partial: no device fallback, no resend, socket closed', async () => {
  const h = setup();
  const done = h.engine.speak(line(), context());
  const s = await session(h);
  s.audio(4800);
  s.fail('NETWORK_ERROR');
  const result = check(await done);
  assert.equal(result.status, 'partial'); assert.equal(result.messageKey, 'voice.partialFailure');
  assert.equal(result.errorCode, 'NETWORK_ERROR'); assert.equal(result.firstAudio, true); assert.equal(result.gap, true);
  assert.equal(result.deviceFallbackAvailable, true); assert.equal(result.engine, 'live');
  assert.equal(h.tts.calls.length, 0); assert.equal(s.speaks.length, 1); assert.equal(s.closes, 1);
  assert.equal(h.router.calls.length, 1); assert.equal(h.engine.snapshot().live, 'cooling');
  assert.equal(h.engine.snapshot().sessionOpen, false);
  const chosen = check(await h.engine.speak(line({ output: 'device' }), context({ turnId: 'turn-2' })));
  assert.equal(chosen.engine, 'device'); assert.equal(chosen.fallback, false); assert.equal(chosen.messageKey, undefined);
  assert.equal(h.router.calls.length, 1); assert.equal(h.tts.calls.length, 1);
  await h.engine.close();
});

test('no audio within the first-audio deadline cancels the turn and falls back to device speech', async () => {
  const h = setup();
  const done = h.engine.speak(line(), context());
  const s = await session(h);
  h.clock.advance(VOICE_POLICY.firstAudioTimeoutMs - 1);
  assert.equal(h.tts.calls.length, 0);
  h.clock.advance(1);
  const result = check(await done);
  assert.equal(result.engine, 'device'); assert.equal(result.fallback, true); assert.equal(result.liveErrorCode, 'TIMEOUT');
  assert.equal(s.speaks.length, 1); assert.equal(s.closes, 1); assert.equal(h.router.calls.length, 1);
  s.audio(); assert.equal(h.audio.sources.length, 0);
  assert.equal(h.engine.snapshot().live, 'cooling');
  await h.engine.close(); assert.equal(h.clock.size, 0);
});

test('server turn without any audio is a pre-audio failure', async () => {
  const h = setup();
  const done = h.engine.speak(line(), context());
  const s = await session(h); s.complete({ bytes: 0, chunks: 0 });
  const result = check(await done);
  assert.equal(result.engine, 'device'); assert.equal(result.liveErrorCode, 'INVALID_RESULT');
  assert.equal(s.closes, 1); assert.equal(h.engine.snapshot().live, 'ready');
  await h.engine.close();
});

test('cancellation stops playback, closes the session, and never falls back', async () => {
  const h = setup({ audio: fakeAudioContext({ autoEnd: false }) });
  const controller = new AbortController();
  const done = h.engine.speak(line(), context({ signal: controller.signal }));
  const s = await session(h);
  s.audio(48000);
  controller.abort('SECRET');
  const result = check(await done);
  assert.equal(result.status, 'cancelled'); assert.equal(result.messageKey, 'error.ABORTED');
  assert.equal(h.audio.sources[0].stopped, true); assert.equal(s.closes, 1); assert.equal(h.tts.calls.length, 0);
  assert.equal(h.engine.snapshot().live, 'ready'); assert.equal(h.clock.size, 0);
  const second = h.engine.speak(line(), context({ turnId: 'turn-2' }));
  const next = await session(h);
  assert.equal(h.router.calls.length, 2);
  next.audio(4800);
  await h.engine.cancel();
  assert.equal(check(await second).status, 'cancelled');
  assert.equal(next.closes, 1); assert.equal(h.audio.sources[1].stopped, true);
  await h.engine.close();
});

test('a new line cancels the active one, and abort during open closes the opening session', async () => {
  const h = setup();
  const first = h.engine.speak(line(), context());
  const s = await session(h);
  s.audio(4800);
  const second = h.engine.speak(line({ text: '둘' }), context({ turnId: 'turn-2' }));
  assert.equal(check(await first).status, 'cancelled');
  const next = await session(h);
  assert.equal(next.speaks[0].text, '둘'); assert.equal(s.closes, 1);
  next.audio(); next.complete();
  assert.equal(check(await second).status, 'completed');
  const gate = { resolve: null };
  h.router.openError = null;
  const original = h.router.call;
  h.router.call = (...args) => new Promise((resolve) => { gate.resolve = () => resolve(original(...args)); });
  const controller = new AbortController();
  const third = h.engine.speak(line({ language: 'ja' }), context({ turnId: 'turn-3', signal: controller.signal }));
  await until(() => gate.resolve !== null);
  controller.abort('SECRET');
  assert.equal(check(await third).status, 'cancelled');
  gate.resolve(); await tick(); await tick();
  assert.equal(h.router.sessions.at(-1).closes, 1);
  await h.engine.close();
});

test('device output is explicit, and a missing device voice leaves captions only', async () => {
  const h = setup();
  const result = check(await h.engine.speak(line({ output: 'device' }), context()));
  assert.equal(result.engine, 'device'); assert.equal(result.fallback, false); assert.equal(result.status, 'completed');
  assert.equal(result.privacyMessageKey, 'voice.devicePrivacy'); assert.equal(result.offlineGuaranteed, false);
  assert.equal(h.router.calls.length, 0);
  const none = setup({ device: null });
  const missing = check(await none.engine.speak(line({ output: 'device' }), context()));
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.messageKey, 'voice.deviceUnavailable');
  none.router.openError = new ProviderError('UNAVAILABLE');
  const failed = check(await none.engine.speak(line(), context()));
  assert.equal(failed.status, 'failed'); assert.equal(failed.messageKey, 'error.VOICE_FAILED');
  assert.equal(failed.deviceFallbackAvailable, false); assert.equal(failed.errorCode, 'UNAVAILABLE');
  const unavailable = setup({ device: 'unavailable' }); unavailable.router.openError = new ProviderError('UNAVAILABLE');
  const captions = check(await unavailable.engine.speak(line(), context()));
  assert.equal(captions.status, 'unavailable'); assert.equal(captions.messageKey, 'voice.deviceUnavailable');
  assert.equal(captions.fallback, true); assert.equal(captions.liveErrorCode, 'UNAVAILABLE');
  await h.engine.close(); await none.engine.close(); await unavailable.engine.close();
});

test('the session is replaced at a turn boundary when route, language or voice changes', async () => {
  const h = setup();
  const first = h.engine.speak(line(), context());
  const a = await session(h); a.audio(); a.complete(); check(await first);
  const second = h.engine.speak(line({ language: 'ja', voice: 'Orus' }), context({ turnId: 'turn-2' }));
  const b = await session(h);
  assert.equal(h.router.calls.length, 2); assert.equal(a.closes, 1);
  assert.deepEqual(b.request, { language: 'ja', voice: 'Orus', input: { format: 'text' } });
  b.audio(); b.complete(); check(await second);
  const third = h.engine.speak(line({ language: 'ja', voice: 'Orus' }), context({ turnId: 'turn-3', keySource: 'shared' }));
  const c = await session(h);
  assert.equal(h.router.calls.length, 3); assert.equal(c.context.keySource, 'shared'); assert.equal(b.closes, 1);
  c.audio(); c.complete(); check(await third);
  await h.engine.close(); assert.equal(c.closes, 1);
});

test('playback overflow after audio is partial with a gap; blocked playback falls back before audio', async () => {
  const h = setup({ audio: fakeAudioContext({ autoEnd: false }) });
  const done = h.engine.speak(line(), context());
  const s = await session(h);
  s.audio(48000 * 4); s.audio(48000 * 5);
  const result = check(await done);
  assert.equal(result.status, 'partial'); assert.equal(result.gap, true); assert.equal(result.messageKey, 'voice.partialFailure');
  assert.equal(result.errorCode, null); assert.equal(s.closes, 1); assert.equal(h.tts.calls.length, 0);
  assert.equal(h.engine.snapshot().live, 'ready');
  await h.engine.close();
  const blocked = setup({ audio: Object.assign(fakeAudioContext(), { resumeError: new Error('SECRET') }) });
  const fallback = check(await blocked.engine.speak(line(), context()));
  assert.equal(fallback.engine, 'device'); assert.equal(fallback.liveErrorCode, 'PLAYBACK_BLOCKED');
  assert.equal(blocked.router.calls.length, 0); assert.equal(blocked.engine.snapshot().live, 'ready');
  await blocked.engine.close();
  const missing = setup({ device: null, getAudioContext: () => null });
  const failed = check(await missing.engine.speak(line(), context()));
  assert.equal(failed.status, 'failed'); assert.equal(failed.messageKey, 'error.PLAYBACK_BLOCKED');
  await missing.engine.close();
});

test('invalid requests fail without any call; closed engines cancel', async () => {
  const h = setup();
  for (const [request, ctx] of [[line({ text: '' }), context()], [line({ language: 'zh' }), context()],
    [line({ output: 'other' }), context()], [line(), context({ providerId: undefined })], [line(), { turnId: 't' }],
    [line({ text: 'x'.repeat(VOICE_POLICY.maxTextLength + 1) }), context()], [null, context()]]) {
    const result = check(await h.engine.speak(request, ctx));
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'INVALID_REQUEST');
  }
  assert.equal(h.router.calls.length, 0); assert.equal(h.tts.calls.length, 0);
  const aborted = check(await h.engine.speak(line(), context({ signal: AbortSignal.abort('SECRET') })));
  assert.equal(aborted.status, 'cancelled');
  await h.engine.close();
  assert.equal(check(await h.engine.speak(line(), context())).status, 'cancelled');
  assert.equal(h.router.calls.length, 0);
});

test('real stack: router, adapter, live client and player complete and cancel one line each', async () => {
  const fixture = createSocketFixture();
  const clock = createClock();
  const live = createGeminiLiveClient({ ...fixture, ...clock, resolveCredential: async () => 'SECRET' });
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
  }, { voice: createGeminiVoice({ live, ...clock }) });
  const router = createRouter({ registry, getCredentialRef: async (address) => ({ ...address, reference: Object.freeze({}) }) });
  const h = setup({ router, clock });
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const chunk = (bytes) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: b64(bytes) } }] } } });
  const done = h.engine.speak(line({ language: 'ja', voice: 'Orus', text: 'こんにちは' }), context());
  await until(() => fixture.sockets.length === 1);
  const ws = fixture.sockets[0]; ws.open(); ws.json({ setupComplete: {} });
  await until(() => ws.sent.length === 2);
  assert.deepEqual(ws.sent[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: 'こんにちは' }] }], turnComplete: true } });
  ws.json(chunk(new Uint8Array(4800)));
  ws.json({ serverContent: { outputTranscription: { text: 'こんにちは' } } });
  ws.json({ serverContent: { turnComplete: true } });
  const result = check(await done);
  assert.equal(result.status, 'completed'); assert.equal(result.engine, 'live'); assert.equal(result.bytes, 4800);
  assert.equal(result.said, 'こんにちは'); assert.equal(result.model, DEFAULT_VOICE_MODEL); assert.equal(result.voice, 'Orus');
  assert.equal(h.audio.sources.length, 1); assert.equal(h.tts.calls.length, 0);
  const second = h.engine.speak(line({ language: 'ja', voice: 'Orus', text: '次' }), context({ turnId: 'turn-2' }));
  await until(() => ws.sent.length === 3);
  assert.equal(fixture.sockets.length, 1);
  ws.json(chunk(new Uint8Array(2400)));
  await h.engine.cancel();
  assert.equal(check(await second).status, 'cancelled');
  assert.equal(ws.closeCalls, 1); assert.equal(ws.readyState, 3);
  ws.json(chunk(new Uint8Array(2400)));
  assert.equal(h.audio.sources.length, 2);
  await h.engine.close();
  assert.equal(clock.size, 0); assert.equal(ws.listenerCount, 0);
});

test('every message key the engine can produce exists in all three dictionaries', async () => {
  const dictionaries = {};
  for (const language of ['ko', 'en', 'ja']) {
    dictionaries[language] = JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'));
  }
  for (const key of [...VOICE_MESSAGE_KEYS, 'voice.devicePrivacy']) {
    for (const language of ['ko', 'en', 'ja']) assert.equal(typeof dictionaries[language][key], 'string', `${language}:${key}`);
  }
  for (const key of observed) assert.ok(VOICE_MESSAGE_KEYS.includes(key), key);
  assert.ok(observed.has('voice.fallback') && observed.has('voice.partialFailure') && observed.has('error.ABORTED'));
});
