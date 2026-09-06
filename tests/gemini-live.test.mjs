import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLive } from '../app/providers/gemini/live.js';
import { buildLiveSetup, LIVE_MODELS, SIM_LIMITS, LIVE_VAD, DEFAULT_LIVE_MODEL, LIVE_MODEL_CONFIG,
  sanitizeLiveModel, liveRoute, detectReply, normalizeLanguagePair, LIVE_VOICE_GENDERS, DEFAULT_LIVE_VOICE_GENDER, LIVE_GENDER_VOICES,
  LIVE_VOICE_POLICY_FIELDS, resolveLiveVoice, createLiveVoicePreference, liveVoicePreference } from '../app/providers/gemini/live-config.js';
import { VOICE_NAMES } from '../app/providers/gemini/voice.js';
import { ProviderError } from '../app/providers/contract.js';
import { createGeminiLiveClient } from '../app/providers/gemini/live-client.js';
import { fakeClock, fakeLive, pcmContent, request } from './fixtures/gemini-live.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function harness(options = {}) {
  const live = fakeLive(options), clock = fakeClock(), events = [], controller = new AbortController();
  const context = { signal: controller.signal, sessionId: 'sim', generation: 2, turnId: 'turn',
    onEvent: (event) => events.push(event) };
  const adapter = createGeminiLive({ live, clock });
  const opening = adapter.open(request, context);
  const session = options.deferred || options.openError ? undefined : await opening;
  return { live, clock, events, controller, context, adapter, opening, session,
    async close() { const p = session.close(); live.confirm(); await p; } };
}

test('fixed models have isolated translation/flash setup for all supported languages', () => {
  for (const targetLanguage of ['ko', 'en', 'ja']) for (const model of LIVE_MODELS) {
    const s = buildLiveSetup({ model, targetLanguage, sourceLanguage: 'ja', systemInstruction: 'ignored' });
    assert.equal(s.model, `models/${model}`);
    assert.deepEqual(s.generationConfig.responseModalities, ['AUDIO']);
    assert.deepEqual(s.inputAudioTranscription, {});
    assert.deepEqual(s.outputAudioTranscription, {});
    assert.deepEqual(s.realtimeInputConfig.automaticActivityDetection, LIVE_VAD);
    assert.equal(LIVE_VAD.silenceDurationMs, 400);
    assert.equal(s.sourceLanguage, undefined);
    // P3-02d: the default voice (female Kore) is applied on both routes.
    assert.deepEqual(s.generationConfig.speechConfig, { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } });
    if (model === LIVE_MODELS[0]) {
      assert.equal(Object.hasOwn(s, 'systemInstruction'), false);
      assert.deepEqual(s.generationConfig.translationConfig, { targetLanguageCode: targetLanguage, echoTargetLanguage: false });
    } else {
      assert.match(s.systemInstruction.parts[0].text, /do not wait for sentence completion/);
      assert.equal(s.generationConfig.translationConfig, undefined);
      assert.match(s.systemInstruction.parts[0].text, /never answer questions/);
    }
  }
  assert.throws(() => buildLiveSetup({ model: 'arbitrary', targetLanguage: 'ko' }), { code: 'MODEL_UNSUPPORTED' });
  assert.throws(() => buildLiveSetup({ targetLanguage: 'xx' }), { code: 'INVALID_REQUEST' });
  // P3-02d: a registered Live voice is accepted (it was SETTINGS_UNSUPPORTED before); unknown voices are rejected.
  assert.equal(buildLiveSetup({ targetLanguage: 'ko', voice: 'Kore' }).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.throws(() => buildLiveSetup({ targetLanguage: 'ko', voice: 'Nobody' }), { code: 'INVALID_REQUEST' });
});

test('voice gender maps to Kore/Orus on both routes, an explicit voice wins, and the prompt never changes', () => {
  assert.deepEqual(LIVE_VOICE_GENDERS, ['female', 'male']);
  assert.equal(DEFAULT_LIVE_VOICE_GENDER, 'female');
  assert.deepEqual(LIVE_GENDER_VOICES, { female: 'Kore', male: 'Orus' });
  assert.equal(resolveLiveVoice(), 'Kore');
  assert.equal(resolveLiveVoice({ gender: 'male' }), 'Orus');
  assert.equal(resolveLiveVoice({ gender: 'male', voice: 'Zephyr' }), 'Zephyr');
  assert.throws(() => resolveLiveVoice({ gender: 'robot' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => resolveLiveVoice({ voice: 'SECRET' }), { code: 'INVALID_REQUEST' });
  const name = (s) => s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  for (const model of LIVE_MODELS) for (const targetLanguage of ['ko', 'en', 'ja']) {
    const female = buildLiveSetup({ model, targetLanguage, gender: 'female' });
    const male = buildLiveSetup({ model, targetLanguage, gender: 'male' });
    const chosen = buildLiveSetup({ model, targetLanguage, gender: 'male', voice: 'Sulafat' });
    assert.equal(name(female), 'Kore'); assert.equal(name(male), 'Orus'); assert.equal(name(chosen), 'Sulafat');
    // Prompt invariance: the voice only touches speechConfig; the interpreter rules and VAD are byte-identical.
    assert.deepEqual(female.systemInstruction, male.systemInstruction);
    assert.deepEqual(male.systemInstruction, chosen.systemInstruction);
    assert.deepEqual(female.realtimeInputConfig, chosen.realtimeInputConfig);
    assert.deepEqual(female.generationConfig.translationConfig, chosen.generationConfig.translationConfig);
    if (LIVE_MODEL_CONFIG[model].setup === 'flash') {
      const text = female.systemInstruction.parts[0].text;
      assert.match(text, /Ignore background music, noise, applause, laughter and crowd murmur/);
      assert.match(text, /interpret human speech only/);
      assert.match(text, /never answer questions/);
      // No role persona, register or "sound human" direction (owner scope 2026-09-06).
      assert.doesNotMatch(text, /persona|customer|staff|traveler|friend|like a human|\b(?:Kore|Orus|Sulafat|female|male)\b/i);
    } else assert.equal(Object.hasOwn(female, 'systemInstruction'), false);
  }
  // Administrator policy contract: default gender and allowed voices only.
  assert.deepEqual(Object.keys(LIVE_VOICE_POLICY_FIELDS), ['voice.gender', 'voice.allowedVoices']);
  assert.deepEqual(LIVE_VOICE_POLICY_FIELDS['voice.gender'], { kind: 'enum', values: ['female', 'male'], default: 'female' });
  assert.equal(LIVE_VOICE_POLICY_FIELDS['voice.allowedVoices'].values, VOICE_NAMES);
  assert.equal(VOICE_NAMES.length, 30);
});

test('the shared voice preference decides when the request names no voice; gender resets an explicit voice', () => {
  const pref = createLiveVoicePreference();
  const seen = [];
  const off = pref.subscribe((value) => seen.push(value));
  assert.deepEqual(pref.snapshot(), { gender: 'female', voice: null, voiceName: 'Kore' });
  assert.equal(pref.set({}), pref.snapshot());
  pref.set({ gender: 'male' });
  assert.deepEqual(pref.snapshot(), { gender: 'male', voice: null, voiceName: 'Orus' });
  // A voice that is neither gender default has no gender this app can claim, so
  // the preference stops reporting one instead of keeping the previous value:
  // a screen rendering `gender` must not show 남자/여자 while Zephyr speaks.
  pref.set({ voice: 'Zephyr' });
  assert.deepEqual(pref.snapshot(), { gender: null, voice: 'Zephyr', voiceName: 'Zephyr' });
  pref.set({ gender: 'female' });
  assert.deepEqual(pref.snapshot(), { gender: 'female', voice: null, voiceName: 'Kore' }, 'a gender choice clears the explicit voice');
  pref.set({ voice: 'Orus' });
  assert.deepEqual(pref.snapshot(), { gender: 'male', voice: null, voiceName: 'Orus' }, 'a gender default voice selects that gender');
  pref.set({ voice: null });
  assert.deepEqual(pref.snapshot(), { gender: 'male', voice: null, voiceName: 'Orus' });
  assert.throws(() => pref.set({ gender: 'robot' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => pref.set({ voice: 'SECRET' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => pref.subscribe(null), { code: 'INVALID_REQUEST' });
  assert.equal(seen.length, 4); off();
  assert.ok(Object.isFrozen(pref.snapshot()));
  // The module singleton feeds buildLiveSetup for requests without a voice (the sim engine's request).
  const name = (s) => s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  try {
    liveVoicePreference.set({ gender: 'male' });
    for (const model of LIVE_MODELS) assert.equal(name(buildLiveSetup({ model, targetLanguage: 'ja' })), 'Orus');
    assert.equal(name(buildLiveSetup({ targetLanguage: 'ja', gender: 'female' })), 'Kore', 'an explicit request field wins');
    liveVoicePreference.set({ voice: 'Puck' });
    assert.equal(name(buildLiveSetup({ targetLanguage: 'ko' })), 'Puck');
    // An explicit `voice: null` asks for "no named voice". The preference is on
    // a named voice and therefore claims no gender, so the app default speaks
    // rather than a gender left over from before that voice was picked.
    assert.equal(name(buildLiveSetup({ targetLanguage: 'ko', voice: null })), 'Kore', 'voice null falls back to the app default');
    // Clearing the named voice through the store does restore the last gender
    // the person actually chose (male, above).
    liveVoicePreference.set({ voice: null });
    assert.deepEqual(liveVoicePreference.snapshot(), { gender: 'male', voice: null, voiceName: 'Orus' });
  } finally { liveVoicePreference.set({ gender: 'female' }); }
  assert.equal(name(buildLiveSetup({ targetLanguage: 'ko' })), 'Kore');
});

test('translation-only model is first; unknown selections and routes resolve to it', () => {
  assert.equal(LIVE_MODELS[0], DEFAULT_LIVE_MODEL);
  assert.equal(LIVE_MODEL_CONFIG[DEFAULT_LIVE_MODEL].setup, 'translation');
  assert.ok(LIVE_MODELS.slice(1).every((model) => LIVE_MODEL_CONFIG[model].setup === 'flash'));
  for (const value of [undefined, null, '', 'gemini-3.1-flash-live-preview ', { model: LIVE_MODELS[1] }, 42, '__proto__']) {
    assert.equal(sanitizeLiveModel(value), DEFAULT_LIVE_MODEL);
    assert.equal(liveRoute(value), 'translation');
  }
  for (const model of LIVE_MODELS) assert.equal(sanitizeLiveModel(model), model);
  assert.equal(liveRoute(LIVE_MODELS[1]), 'flash');
});

test('reply detection is conservative: assistant openers and finished foreign-script sentences only', () => {
  const replies = {
    ko: ['네, 도와드릴게요.', '네! 제가 알려드리겠습니다', '물론이죠, 도와 드릴게요', '무엇을 도와드릴까요?', '저는 AI 어시스턴트입니다.', '저는 언어 모델이라서'],
    en: ['Sure, I can help you with that.', 'Yes! I\'ll explain it.', 'Of course, let me help you', 'I can help you with that', 'How can I help you today?', 'As an AI, I cannot'],
    ja: ['はい、お手伝いします。', 'もちろん、ご説明します', '何かお手伝いできることはありますか', '私はAIアシスタントです'],
  };
  const interpretations = {
    ko: ['몇 시예요?', '도와주실 수 있나요?', '네, 알겠습니다.', '네.', '제가 어제 도와드렸어요', '저는 서울에서 왔습니다', 'NASA는 오늘 발표했어요.', 'Michael Jackson'],
    en: ['What time is it?', 'Can you help me?', 'Yes.', 'Yes, we can start now.', 'I can see the mountain.', 'Let me tell you a story.', 'How can we help the poor?'],
    ja: ['何時ですか？', '手伝ってもらえますか？', 'はい、わかりました。', 'はい。', '私は東京から来ました', 'お手伝いが必要な方は'],
  };
  for (const language of ['ko', 'en', 'ja']) {
    for (const text of replies[language]) assert.equal(detectReply(text, language), 'phrase', `${language}: ${text}`);
    for (const text of interpretations[language]) {
      assert.equal(detectReply(text, language), null, `${language}: ${text}`);
      assert.equal(detectReply(text, language, { final: true }), null, `${language} final: ${text}`);
    }
  }
  // Foreign script is judged only on finished sentences with enough letters.
  assert.equal(detectReply('Thank you all for coming today', 'ko'), null);
  assert.equal(detectReply('Thank you all for coming today', 'ko', { final: true }), 'language');
  assert.equal(detectReply('오늘 여러분 모두 환영합니다', 'en', { final: true }), 'language');
  assert.equal(detectReply('오늘 여러분 모두 환영합니다', 'ja', { final: true }), 'language');
  assert.equal(detectReply('Welcome to the service, everyone', 'ja', { final: true }), 'language');
  assert.equal(detectReply('今日は皆さんようこそ', 'ko', { final: true }), 'language');
  assert.equal(detectReply('OK', 'ko', { final: true }), null);
  assert.equal(detectReply('Amen.', 'ja', { final: true }), null);
  assert.equal(detectReply('皆さん、ようこそ。', 'ja', { final: true }), null);
  assert.equal(detectReply('   ', 'en', { final: true }), null);
  for (const bad of [undefined, null, 42, {}]) assert.equal(detectReply(bad, 'en'), null);
  assert.equal(detectReply('Sure, I can help you', 'xx'), null);
});

test('every open builds the flash interpreter rules fresh, so reopened sessions carry the current prompt', async () => {
  const live = fakeLive(), controller = new AbortController();
  const context = { signal: controller.signal, sessionId: 'sim', generation: 1, turnId: 'turn', onEvent() {} };
  const adapter = createGeminiLive({ live });
  const flash = { ...request, model: LIVE_MODELS[1], targetLanguage: 'ja' };
  const first = await adapter.open(flash, context);
  const closing = first.close(); live.confirm(); await closing;
  const second = await adapter.open(flash, { ...context, generation: 2 });
  const expected = buildLiveSetup(flash);
  assert.notEqual(live.calls[0].setup, live.calls[1].setup);
  assert.notEqual(live.calls[0].setup.systemInstruction, live.calls[1].setup.systemInstruction);
  for (const call of live.calls) {
    assert.deepEqual(call.setup, expected);
    assert.match(call.setup.systemInstruction.parts[0].text, /INTERPRETER into Japanese[\s\S]*never answer questions/);
    assert.equal(call.setup.generationConfig.translationConfig, undefined);
  }
  const done = second.close(); live.confirm(); await done;
});

test('sends exact byte views without Node Buffer; finish is idempotent and keeps output open', async () => {
  const h = await harness();
  const original = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    await h.session.sendAudio(new Uint8Array([99, 1, 0, 255, 127, 99]).subarray(1, 5));
    await h.session.finishInput(); await h.session.finishInput();
    h.live.content(pcmContent());
  } finally { globalThis.Buffer = original; }
  assert.deepEqual(h.live.sent, [{ realtimeInput: { audio: { data: 'AQD/fw==', mimeType: 'audio/pcm;rate=16000' } } },
    { realtimeInput: { audioStreamEnd: true } }]);
  assert.deepEqual([...h.events[0].audio], [1, 0, 255, 127]);
  assert.equal(h.events[0].sampleRate, 24000);
  assert.equal(h.events[0].generation, 2);
  await assert.rejects(h.session.sendAudio(new Uint8Array(2)), { code: 'SESSION_CLOSED' });
  assert.equal(h.live.closes, 0);
  await h.close();
});

test('input format and frame bounds fail before send/open', async () => {
  const h = await harness();
  for (const pcm of [null, '', new ArrayBuffer(2), new Int16Array(2), new Uint8Array(0), new Uint8Array(3), new Uint8Array(1026)]) {
    await assert.rejects(h.session.sendAudio(pcm), { code: 'INVALID_REQUEST' });
  }
  await h.session.sendAudio(new Uint8Array(1024));
  assert.equal(h.live.sent.length, 1);
  for (const input of [{ format: 'wav' }, { format: 'pcm16', sampleRate: 24000 }, { format: 'pcm16', channels: 2 }]) {
    await assert.rejects(h.adapter.open({ ...request, input }, h.context), { code: 'INPUT_UNSUPPORTED' });
  }
  assert.equal(h.live.calls.length, 1);
  await h.close();
});

test('independent delta captions preserve repetition and never invent missing source', async () => {
  const h = await harness();
  h.live.content({ outputTranscription: { text: 'go ' } });
  h.live.content({ outputTranscription: { text: 'go ' } });
  h.live.content({ outputTranscription: { text: 'go', finished: true } });
  assert.equal(h.events.at(-1).translatedText, 'go go go');
  assert.equal(h.events.at(-1).final, true);
  assert.ok(h.events.every((e) => !Object.hasOwn(e, 'sourceText')));
  h.live.content({ inputTranscription: { text: '원문' } });
  h.live.content({ inputTranscription: { finished: true } });
  const source = h.events.at(-1);
  assert.equal(source.sourceText, '원문'); assert.equal(source.final, true);
  assert.notEqual(source.segmentId, h.events[0].segmentId);
  assert.equal(source.seq, 1); assert.equal(h.events[0].seq, 1);
  assert.ok(h.events[1].revision > h.events[0].revision);
  await h.close(); assert.equal(h.clock.size, 0);
});

test('silence and turn boundaries finalize, generationComplete does not', async () => {
  const h = await harness();
  h.live.content({ outputTranscription: { text: 'first' }, generationComplete: true });
  assert.equal(h.events.at(-1).final, false);
  h.clock.tick(1499); assert.equal(h.events.length, 1);
  h.clock.tick(1); assert.equal(h.events.at(-1).final, true);
  h.live.content({ inputTranscription: { text: 'source' }, outputTranscription: { text: 'second' }, turnComplete: true });
  assert.equal(h.events.at(-1).type, 'complete');
  assert.equal(h.clock.size, 0);
  await h.close();
});

test('interruption wins over co-located audio and complete, then next turn continues', async () => {
  const h = await harness();
  h.live.content({ outputTranscription: { text: 'unfinished' } });
  h.live.content({ ...pcmContent(), interrupted: true, turnComplete: true });
  assert.equal(h.events.at(-1).type, 'interrupted');
  assert.ok(!h.events.some((e) => e.type === 'audio' || e.type === 'complete' || e.final));
  assert.equal(h.clock.size, 0);
  h.live.content({ outputTranscription: { text: 'next', finished: true } });
  assert.equal(h.events.at(-1).seq, 2);
  await h.close();
});

for (const [label, content] of [
  ['wrong rate', pcmContent('AAAA', 'audio/pcm;rate=16000')],
  ['bad rate suffix', pcmContent('AAAA', 'audio/pcm;rate=24000evil')],
  ['stereo', pcmContent('AAAA', 'audio/pcm;rate=24000;channels=2')],
  ['non-PCM', pcmContent('AAAA', 'audio/wav')],
  ['odd PCM', pcmContent('AAAA')], ['empty PCM', pcmContent('')],
  ['bad base64', pcmContent('!!!!')], ['unpadded base64', pcmContent('AAA')],
  ['noncanonical base64', pcmContent('AAB=')], ['bad padding', pcmContent('AA=A')],
  ['large PCM', pcmContent('A'.repeat(1048580))],
  ['large envelope', { ignored: 'あ'.repeat(400000) }],
  ['large transcript', { outputTranscription: { text: 'x'.repeat(SIM_LIMITS.maxTranscriptChars + 1) } }],
  ['bad text', { inputTranscription: { text: 42 } }], ['bad finished', { outputTranscription: { finished: 'yes' } }],
  ['bad content', null], ['bad parts', { modelTurn: { parts: {} } }],
  ['bad control', { turnComplete: 'yes' }],
]) test(`malformed receive closes once with sanitized error: ${label}`, async () => {
  const h = await harness();
  h.live.content(content); h.live.content(pcmContent());
  await tick();
  assert.equal(h.live.closes, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].error.code, 'INVALID_RESULT');
  assert.equal(h.events[0].error.cause, undefined);
  h.live.confirm(); h.live.confirm();
  assert.equal(h.events.filter((e) => e.type === 'closed').length, 1);
  assert.equal(h.clock.size, 0);
  assert.equal(h.live.calls.length, 1);
});

test('bare PCM MIME uses 24kHz and multi-part messages validate atomically', async () => {
  const h = await harness();
  h.live.content(pcmContent('AAA=', 'audio/pcm'));
  assert.equal(h.events[0].sampleRate, 24000);
  h.live.content({ outputTranscription: { text: 'must not leak' }, modelTurn: {
    parts: [...pcmContent().modelTurn.parts, ...pcmContent('bad').modelTurn.parts] } });
  assert.deepEqual(h.events.map((e) => e.type), ['audio', 'error']);
  h.live.confirm();
});

test('close is idempotent, suppresses late events, and waits for physical close', async () => {
  const h = await harness();
  h.live.content({ outputTranscription: { text: 'partial' } });
  const p = h.session.close(); assert.equal(h.session.close(), p);
  let resolved = false; p.then(() => { resolved = true; });
  h.live.content(pcmContent()); h.clock.tick(2000);
  await tick(); assert.equal(resolved, false); assert.equal(h.events.length, 1);
  h.live.confirm(); await p; assert.equal(resolved, true);
  assert.equal(h.events.length, 1); assert.equal(h.clock.size, 0);
});

test('goAway stops input and closes without reconnecting or forwarding raw fields', async () => {
  const h = await harness();
  h.live.emit({ type: 'goAway', timeLeftMs: 2000, detail: 'private' });
  await assert.rejects(h.session.sendAudio(new Uint8Array(2)), { code: 'SESSION_CLOSED' });
  await tick(); assert.equal(h.live.closes, 1); assert.equal(h.live.calls.length, 1);
  assert.deepEqual(h.events[0], { type: 'goAway', timeLeftMs: 2000, turnId: 'turn', sessionId: 'sim', generation: 2 });
  h.live.confirm();
});

test('abort during open closes late transport before rejecting', async () => {
  const h = await harness({ deferred: true });
  h.controller.abort(); h.live.resolve();
  await tick(); assert.equal(h.live.closes, 1);
  let settled = false; h.opening.catch(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  h.live.confirm(); await assert.rejects(h.opening, { code: 'ABORTED' });
  assert.equal(h.events.length, 0); assert.equal(h.clock.size, 0);
});

test('close timeout is not physical closure and errors never retain raw causes', async () => {
  const h = await harness({ closeError: new ProviderError('TIMEOUT') });
  let physicallyClosed = false; h.session.closed.then(() => { physicallyClosed = true; });
  await assert.rejects(h.session.close(), { code: 'TIMEOUT' });
  assert.equal(physicallyClosed, false);
  h.live.confirm(); await h.session.closed;
  const live = fakeLive({ openError: new Error('private-auth-material') });
  await assert.rejects(createGeminiLive({ live }).open(request, h.context), (e) =>
    e.code === 'PROVIDER_ERROR' && !JSON.stringify(e).includes('private') && !e.cause);
  assert.equal(live.calls.length, 1);
});

test('remote close clears partial timers and emits closed once without ABORTED', async () => {
  const h = await harness();
  h.live.content({ outputTranscription: { text: 'partial' } });
  h.live.emit({ type: 'error', error: new ProviderError('SESSION_CLOSED') });
  h.live.confirm(); h.live.confirm(); h.clock.tick(5000);
  assert.deepEqual(h.events.map((e) => e.type), ['subtitle', 'error', 'closed']);
  assert.equal(h.events[1].error.code, 'SESSION_CLOSED');
  assert.equal(h.clock.size, 0);
});

test('existing Live client remains the only socket owner and receives the real envelopes', async () => {
  const sockets = [];
  class Socket extends EventTarget {
    readyState = 0; bufferedAmount = 0; sent = [];
    constructor() { super(); sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
    message(data) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(data) })); }
  }
  const live = createGeminiLiveClient({ WebSocket: Socket, resolveCredential: async () => 'synthetic' });
  const controller = new AbortController(), events = [];
  const context = { signal: controller.signal, providerId: 'gemini', transport: 'direct', keySource: 'personal',
    credentialRef: {}, sessionId: 'real-client', generation: 1, onEvent: (e) => events.push(e) };
  const p = createGeminiLive({ live }).open(request, context);
  await tick(); const socket = sockets[0]; socket.readyState = 1; socket.dispatchEvent(new Event('open'));
  socket.message({ setupComplete: {} }); const session = await p;
  await assert.rejects(live.open({ setup: buildLiveSetup(request) }, context), { code: 'SESSION_LIMIT' });
  await session.sendAudio(new Uint8Array(1024)); await session.finishInput();
  socket.message({ serverContent: pcmContent() });
  assert.equal(events[0].type, 'audio');
  assert.equal(socket.sent[0].setup.systemInstruction, undefined);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  await session.close(); await session.closed; assert.equal(sockets.length, 1);
});

test('large valid PCM remains streamed and is not rejected by decoder stack limits', async () => {
  const h = await harness();
  const data = 'A'.repeat(800000);
  h.live.content(pcmContent(data));
  assert.equal(h.events[0].type, 'audio');
  assert.equal(h.events[0].audio.byteLength, 600000);
  assert.equal(h.events.length, 1);
  await h.close();
});

test('consumer close inside a subtitle callback suppresses the rest of that message', async () => {
  const h = await harness();
  h.context.onEvent = (event) => { h.events.push(event); h.session.close(); };
  h.live.content({ inputTranscription: { text: 'source' }, outputTranscription: { text: 'translation' },
    ...pcmContent(), turnComplete: true });
  assert.equal(h.events.length, 1);
  h.live.confirm(); await h.session.close(); assert.equal(h.clock.size, 0);
});

test('abort after setup suppresses audio, clears timers and closes the transport', async () => {
  const h = await harness();
  h.live.content({ outputTranscription: { text: 'partial' } });
  h.controller.abort(); h.live.content(pcmContent()); h.clock.tick(2000);
  await tick(); assert.equal(h.live.closes, 1);
  assert.equal(h.events.length, 1); assert.equal(h.clock.size, 0);
  await assert.rejects(h.session.finishInput(), { code: 'ABORTED' });
  h.live.confirm(); await h.session.close();
});

test('send failure propagates sanitized error and never retries input', async () => {
  const h = await harness();
  h.live.session.send = () => { throw new Error('private-auth-material'); };
  await assert.rejects(h.session.sendAudio(new Uint8Array(2)), { code: 'PROVIDER_ERROR' });
  assert.equal(h.events[0].error.message, 'PROVIDER_ERROR');
  await tick(); assert.equal(h.live.closes, 1); assert.equal(h.live.calls.length, 1);
  h.live.confirm();
});

test('two-way setup: one instruction covers both directions, and the translation model is refused', () => {
  const flash = LIVE_MODELS.find((model) => liveRoute(model) !== 'translation');
  const setup = buildLiveSetup({ model: flash, languages: ['ko', 'ja'] });
  const text = setup.systemInstruction.parts[0].text;
  // Both directions are named, and neither is the only one.
  assert.match(text, /two-way INTERPRETER between Korean and Japanese/);
  assert.match(text, /Korean speech is rendered into Japanese/);
  assert.match(text, /Japanese speech is rendered into Korean/);
  assert.match(text, /never both directions for one utterance/);
  // The one-way rule "if it is already the target language, stay silent" would
  // silence half of a two-way conversation; it is replaced by "neither language".
  assert.match(text, /in neither Korean nor Japanese, stay silent/);
  assert.equal(/already in .*, stay silent/.test(text), false);
  // Never interpreting its own output back is what stops a feedback loop.
  assert.match(text, /never interpret your own output back/);
  // The rules that are not about direction are unchanged.
  assert.match(text, /NEVER reply, greet, comment/);
  assert.match(text, /Ignore background music/);
  // No translationConfig: the direction is decided per utterance, not fixed.
  assert.equal('translationConfig' in setup.generationConfig, false);
  // One session, one voice.
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');

  const translationModel = LIVE_MODELS.find((model) => liveRoute(model) === 'translation');
  assert.throws(() => buildLiveSetup({ model: translationModel, languages: ['ko', 'ja'] }),
    { code: 'MODEL_UNSUPPORTED' }, 'a single targetLanguageCode cannot switch direction');
  // A pair must be two different, supported languages.
  for (const pair of [['ko', 'ko'], ['ko'], ['ko', 'de'], ['ko', 'ja', 'en'], 'ko', null && []]) {
    if (pair === null) continue;
    assert.throws(() => buildLiveSetup({ model: flash, languages: pair }), { code: 'INVALID_REQUEST' }, JSON.stringify(pair));
  }
  assert.deepEqual([...normalizeLanguagePair(['ja', 'en'])], ['ja', 'en']);
  assert.ok(Object.isFrozen(normalizeLanguagePair(['ja', 'en'])));
  // One-way is unchanged when no pair is given.
  assert.match(buildLiveSetup({ model: flash, targetLanguage: 'ja' }).systemInstruction.parts[0].text,
    /INTERPRETER into Japanese/);
});
