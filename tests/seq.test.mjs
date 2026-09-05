import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createSeqEngine, SEQ_MESSAGE_KEYS, SEQ_POLICY } from '../app/engine/seq.js';
import { SEQ_STATUS, TURN_PHASE, createState } from '../app/state.js';
import { APP_DEFAULTS } from '../app/config.js';
import { ProviderError } from '../app/providers/contract.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createKeyStore } from '../app/security/key-store.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { provider } from './fixtures/providers.mjs';
import { goldenWav } from './fixtures/audio.mjs';
import { tick, deferred } from './fixtures/live.mjs';

const KEY = 'PERSONAL-SECRET-KEY';
const leaks = (value) => /SECRET/.test(`${inspect(value, { depth: 8 })}${JSON.stringify(value)}`);
const code = (expected) => (error) => error instanceof ProviderError && error.code === expected;
async function until(condition, limit = 100) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}
const okResult = (request) => ({ sourceText: request.input.format === 'text' ? request.input.text : '사과 12개',
  translatedText: 'りんご12個', detectedLanguage: 'ko', status: 'ok', model: 'test-model' });

// A translate adapter whose answers are scripted per call (value, Error or function).
function scriptedAdapter(log) {
  const adapter = { translates: [], voices: [], script: [] };
  adapter.translate = async (request, context) => {
    adapter.translates.push({ request, context });
    log.push('translate');
    const step = adapter.script.shift();
    if (typeof step === 'function') return step(request, context);
    if (step instanceof Error) throw step;
    return step ?? okResult(request);
  };
  adapter.stt = async () => { throw new ProviderError('INVALID_REQUEST'); };
  adapter.voice = { async open(request, context) {
    adapter.voices.push({ request, context });
    return { async speak() {}, async cancel() {}, async close() {} };
  } };
  adapter.live = { async open() { return { async sendAudio() {}, async finishInput() {}, async close() {} }; } };
  return adapter;
}
function fakeCapture(log) {
  const capture = { sessions: [], active: null, cancels: 0 };
  capture.start = (context) => {
    if (capture.active) throw new ProviderError('INVALID_REQUEST');
    const gate = deferred();
    const session = { context, done: gate.promise, stops: 0, ended: false };
    const finish = (result) => {
      if (session.ended) return session.done;
      session.ended = true; capture.active = null;
      gate.resolve(Object.freeze({ turnId: context.turnId, sessionId: context.sessionId, generation: context.generation,
        sampleRate: 16000, durationMs: 1000, ...result }));
      return session.done;
    };
    session.finish = finish;
    session.stop = () => { session.stops++; return finish({ status: 'success', wav: goldenWav, pcm: new Int16Array(3) }); };
    session.cancel = () => finish({ status: 'cancelled', code: 'ABORTED', reason: 'cancel', messageKey: 'error.ABORTED' });
    context.signal?.addEventListener('abort', session.cancel, { once: true });
    log.push('capture-start');
    capture.sessions.push(session); capture.active = session;
    return session;
  };
  capture.stop = () => capture.active?.stop();
  capture.cancel = () => { capture.cancels++; capture.active?.cancel(); };
  return capture;
}
function fakeVoice(log) {
  const voice = { calls: [], pending: null, cancels: 0, closes: 0, restarts: 0, mode: 'manual', status: 'completed' };
  voice.speak = (request, context) => {
    voice.calls.push({ request, context });
    log.push('speak');
    return new Promise((resolve) => {
      let ended = false;
      const finish = (status, fields = {}) => {
        if (ended) return; ended = true;
        if (voice.pending?.finish === finish) voice.pending = null;
        resolve({ turnId: context.turnId, sessionId: context.sessionId, generation: 1, engine: 'live', status,
          messageKey: status === 'completed' ? undefined : status === 'partial' ? 'voice.partialFailure'
            : status === 'cancelled' ? 'error.ABORTED' : 'error.VOICE_FAILED',
          errorCode: status === 'cancelled' ? 'ABORTED' : status === 'failed' ? 'INVALID_RESULT' : null,
          fallback: false, deviceFallbackAvailable: status !== 'completed', firstAudio: status !== 'failed',
          bytes: 0, said: '', model: null, voice: null, gap: status === 'partial', secret: 'SECRET', ...fields });
      };
      if (context.signal?.aborted) { finish('cancelled'); return; }
      context.signal?.addEventListener('abort', () => { log.push('voice-abort'); finish('cancelled'); }, { once: true });
      voice.pending = { finish, request, context };
      if (voice.mode === 'auto') finish(voice.status);
    });
  };
  voice.cancel = () => { voice.cancels++; voice.pending?.finish('cancelled'); return Promise.resolve(); };
  voice.restart = () => { voice.restarts++; };
  voice.close = async () => { voice.closes++; voice.pending?.finish('cancelled'); };
  voice.snapshot = () => ({ live: 'ready' });
  return voice;
}
// Retry waits collapse to a tick; request deadlines keep their real length.
const timing = { random: () => 0, clearTimeout: globalThis.clearTimeout,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms < 10000 ? 0 : ms) };

function harness({ key = KEY, voiceMode = 'auto', voice: voiceOverride, realVoice = false, defaults } = {}) {
  const log = [];
  const registry = createRegistry();
  const definition = provider('alpha');
  definition.capabilities.translate.inputFormats = ['text', 'wav'];
  const adapter = scriptedAdapter(log);
  registry.register(definition, adapter);
  const keyStore = createKeyStore({ registry });
  const router = createRouter({ registry, getCredentialRef: (address, options) => keyStore.getCredentialRef(address, options) });
  const sessionManager = createSessionManager({ ...timing });
  const config = { router, keyStore, sessionManager, defaults: defaults ?? APP_DEFAULTS, resolveFallback: () => null,
    async dispose() { keyStore.dispose(); await sessionManager.close().catch(() => {}); } };
  if (key !== null) { keyStore.setPersonal('alpha', key); keyStore.select('alpha', 'personal'); }
  const capture = fakeCapture(log);
  const voice = realVoice ? undefined : (voiceOverride ?? fakeVoice(log));
  if (voice) voice.mode = voiceMode;
  const statuses = [];
  let clock = 0;
  const state = createState({ sessionId: 'session-1', now: () => ++clock });
  let last = state.snapshot().status;
  state.subscribe((snapshot) => { if (last !== snapshot.status) statuses.push(snapshot.status); last = snapshot.status; });
  const engine = createSeqEngine({ config, capture, voiceEngine: voice, state, sessionId: 'session-1', ...timing,
    now: () => ++clock, ...(realVoice ? { getAudioContext: () => fakeAudioContext(), deviceTTS: null } : {}) });
  const turn = (id) => engine.state.snapshot().turns.find((t) => t.turnId === id);
  return { log, adapter, keyStore, router, sessionManager, config, capture, voice, state, engine, statuses, turn };
}
function fakeAudioContext() {
  return { currentTime: 0, destination: {}, async resume() {},
    createBuffer(channels, size, rate) { const data = new Float32Array(size); return { data, duration: size / rate, getChannelData: () => data }; },
    createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start() { setImmediate(() => this.onended?.()); } }; } };
}

test('rejects invalid composition and exposes its dictionary keys', async () => {
  const h = harness();
  assert.throws(() => createSeqEngine({ capture: h.capture, voiceEngine: h.voice }), code('INVALID_REQUEST'));
  assert.throws(() => createSeqEngine({ config: h.config, voiceEngine: h.voice }), code('INVALID_REQUEST'));
  assert.throws(() => createSeqEngine({ config: h.config, capture: h.capture }), code('INVALID_REQUEST'));
  assert.throws(() => createSeqEngine({ config: h.config, capture: h.capture, voiceEngine: {} }), code('INVALID_REQUEST'));
  for (const language of ['ko', 'en', 'ja']) {
    const dictionary = JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'));
    for (const key of SEQ_MESSAGE_KEYS) assert.equal(typeof dictionary[key], 'string', `${language}:${key}`);
  }
  assert.equal(SEQ_POLICY.maxTextLength, 4000);
  assert.equal(h.engine.sessionId, 'session-1');
  assert.deepEqual(h.state.snapshot().keySelection, { providerId: 'alpha', keySource: 'personal' });
  await h.engine.close();
});

test('a text turn flows translating -> captions -> speaking -> idle with one combined request', async () => {
  const h = harness();
  const { turnId, done } = h.engine.submitText('  사과 12개  ');
  assert.equal(turnId, 'turn-1');
  assert.equal(h.state.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.equal(h.engine.snapshot().activeTurnId, 'turn-1');
  const final = await done;
  assert.deepEqual(h.statuses, ['translating', 'speaking', 'idle']);
  assert.equal(final.phase, TURN_PHASE.COMPLETED);
  assert.equal(final.sourceText, '사과 12개');
  assert.equal(final.translatedText, 'りんご12個');
  assert.equal(final.detectedLanguage, 'ko');
  assert.equal(final.voice.status, 'completed');
  assert.equal(final.voice.engine, 'live');
  assert.equal(h.adapter.translates.length, 1);
  const [{ request, context }] = h.adapter.translates;
  assert.deepEqual(request, { sourceLanguage: 'ko', targetLanguage: 'ja', input: { format: 'text', text: '사과 12개' } });
  assert.deepEqual([context.turnId, context.sessionId, context.generation, context.providerId, context.keySource, context.transport],
    ['turn-1', 'session-1', 0, 'alpha', 'personal', 'direct']);
  assert.equal(context.budget.used, 1);
  assert.equal(h.voice.calls.length, 1);
  assert.deepEqual(h.voice.calls[0].request, { text: 'りんご12個', language: 'ja', output: 'provider', allowDeviceFallback: true });
  const voiceContext = h.voice.calls[0].context;
  assert.deepEqual([voiceContext.turnId, voiceContext.sessionId, voiceContext.providerId, voiceContext.keySource, voiceContext.transport],
    ['turn-1', 'session-1', 'alpha', 'personal', 'direct']);
  assert.ok(voiceContext.signal instanceof AbortSignal);
  assert.deepEqual(h.log, ['translate', 'speak']);
  assert.equal(h.state.snapshot().activeTurnId, null);
  assert.equal(h.engine.snapshot().activeTurnId, null);
  assert.equal(leaks(h.state.snapshot()), false);
  assert.throws(() => h.engine.submitText('   '), code('INVALID_REQUEST'));
  assert.throws(() => h.engine.submitText('x'.repeat(SEQ_POLICY.maxTextLength + 1)), code('INVALID_REQUEST'));
  assert.throws(() => h.engine.submitText('bad\u0001text'), code('INVALID_REQUEST'));
  assert.equal(h.state.snapshot().turns.length, 1);
  await h.engine.close();
});

test('push-to-talk records, sends the WAV as one translate request, then speaks', async () => {
  const h = harness();
  const { turnId, done } = h.engine.startRecording();
  assert.equal(h.state.snapshot().status, SEQ_STATUS.RECORDING);
  assert.equal(h.engine.snapshot().recording, true);
  assert.equal(h.capture.sessions.length, 1);
  const { context } = h.capture.sessions[0];
  assert.deepEqual([context.turnId, context.sessionId, context.generation], ['turn-1', 'session-1', 0]);
  assert.ok(context.signal instanceof AbortSignal);
  assert.equal(h.adapter.translates.length, 0);
  const stopped = h.engine.stopRecording();
  assert.equal(stopped.turnId, turnId);
  assert.equal(h.capture.sessions[0].stops, 1);
  assert.equal(h.engine.stopRecording(), null);
  const final = await done;
  assert.deepEqual(h.statuses, ['recording', 'translating', 'speaking', 'idle']);
  assert.equal(final.input, 'voice');
  assert.equal(final.phase, TURN_PHASE.COMPLETED);
  assert.equal(final.sourceText, '사과 12개');
  assert.equal(final.translatedText, 'りんご12個');
  assert.equal(h.adapter.translates.length, 1);
  assert.deepEqual(h.adapter.translates[0].request, { sourceLanguage: 'ko', targetLanguage: 'ja', input: { format: 'wav', audio: goldenWav } });
  assert.deepEqual(h.log, ['capture-start', 'translate', 'speak']);
  // The stored record carries no audio.
  assert.equal(JSON.stringify(h.state.snapshot()).includes('wav'), false);
  assert.equal(h.engine.snapshot().recording, false);
  await h.engine.close();
});

test('silence, denied microphone and interruption end the turn without any provider call', async () => {
  const h = harness();
  let { done } = h.engine.startRecording();
  h.capture.sessions[0].finish({ status: 'silence', messageKey: 'seq.silence' });
  let final = await done;
  assert.deepEqual([final.phase, final.messageKey, final.errorCode, final.translatedText], [TURN_PHASE.SILENCE, 'seq.silence', null, '']);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  ({ done } = h.engine.startRecording());
  h.capture.sessions[1].finish({ status: 'error', code: 'MICROPHONE_DENIED', messageKey: 'error.MICROPHONE_DENIED' });
  final = await done;
  assert.deepEqual([final.phase, final.messageKey, final.errorCode], [TURN_PHASE.ERROR, 'error.MICROPHONE_DENIED', 'MICROPHONE_DENIED']);
  ({ done } = h.engine.startRecording());
  h.capture.sessions[2].finish({ status: 'interrupted', code: 'BROWSER_INTERRUPTED', messageKey: 'error.BROWSER_INTERRUPTED' });
  final = await done;
  assert.deepEqual([final.phase, final.errorCode], [TURN_PHASE.ERROR, 'BROWSER_INTERRUPTED']);
  assert.equal(h.adapter.translates.length, 0);
  assert.equal(h.voice.calls.length, 0);
  assert.equal(h.state.snapshot().turns.length, 3);
  assert.deepEqual(h.statuses, ['recording', 'idle', 'recording', 'idle', 'recording', 'idle']);
  await h.engine.close();
});

test('a provider result for silence or unrecognized speech is a normal terminal result', async () => {
  const h = harness();
  h.adapter.script.push({ sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'no-speech', model: 'test-model' },
    { sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'unrecognized', model: 'test-model' });
  let { done } = h.engine.startRecording();
  h.engine.stopRecording();
  let final = await done;
  assert.deepEqual([final.phase, final.messageKey, final.model], [TURN_PHASE.SILENCE, 'seq.silence', 'test-model']);
  ({ done } = h.engine.startRecording());
  h.engine.stopRecording();
  final = await done;
  assert.deepEqual([final.phase, final.messageKey], [TURN_PHASE.UNRECOGNIZED, 'seq.unrecognized']);
  assert.equal(h.voice.calls.length, 0);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  await h.engine.close();
});

test('cancel during translation discards the late REST result', async () => {
  const h = harness();
  const gate = deferred();
  h.adapter.script.push(() => gate.promise);
  const { done } = h.engine.submitText('안녕');
  await until(() => h.adapter.translates.length === 1);
  const cancelled = h.engine.cancel();
  // The store shows the cancellation synchronously.
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(h.turn('turn-1').phase, TURN_PHASE.CANCELLED);
  assert.equal(h.adapter.translates[0].context.signal.aborted, true);
  gate.resolve(okResult({ input: { format: 'text', text: '안녕' } }));
  const final = await done;
  await cancelled;
  assert.deepEqual([final.phase, final.errorCode, final.messageKey, final.translatedText], [TURN_PHASE.CANCELLED, 'ABORTED', 'seq.cancelled', '']);
  assert.equal(h.voice.calls.length, 0);
  assert.equal(h.state.snapshot().turns.length, 1);
  assert.equal(await h.engine.cancel(), undefined);
  // Cancel while recording ends the capture and the turn.
  const recording = h.engine.startRecording();
  await h.engine.cancel();
  assert.equal(h.capture.sessions[0].ended, true);
  assert.equal((await recording.done).phase, TURN_PHASE.CANCELLED);
  assert.equal(h.adapter.translates.length, 1);
  await h.engine.close();
});

test('a new utterance cancels the previous playback before the microphone opens', async () => {
  const h = harness({ voiceMode: 'manual' });
  const first = h.engine.submitText('첫 문장');
  await until(() => h.voice.calls.length === 1);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.SPEAKING);
  const second = h.engine.startRecording();
  assert.deepEqual(h.log, ['translate', 'speak', 'voice-abort', 'capture-start']);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.RECORDING);
  assert.equal(h.state.snapshot().activeTurnId, 'turn-2');
  const previous = await first.done;
  // The first translation survives; only its playback was cancelled.
  assert.equal(previous.phase, TURN_PHASE.COMPLETED);
  assert.equal(previous.translatedText, 'りんご12個');
  assert.equal(previous.voice.status, 'cancelled');
  assert.equal(previous.voice.errorCode, 'ABORTED');
  h.voice.mode = 'auto';
  h.engine.stopRecording();
  const latest = await second.done;
  assert.equal(latest.phase, TURN_PHASE.COMPLETED);
  assert.equal(latest.voice.status, 'completed');
  assert.deepEqual(h.state.snapshot().turns.map((t) => t.turnId), ['turn-1', 'turn-2']);
  // A new text line while another is still translating also cancels it.
  const gate = deferred();
  h.adapter.script.push(() => gate.promise);
  const third = h.engine.submitText('셋');
  await until(() => h.adapter.translates.length === 3);
  const fourth = h.engine.submitText('넷');
  assert.equal(h.turn('turn-3').phase, TURN_PHASE.CANCELLED);
  gate.resolve(okResult({ input: { format: 'text', text: '셋' } }));
  assert.equal((await third.done).translatedText, '');
  assert.equal((await fourth.done).phase, TURN_PHASE.COMPLETED);
  await h.engine.close();
});

test('voice failure keeps the translation and the user can re-read with device speech', async () => {
  const h = harness();
  h.voice.status = 'failed';
  const { turnId, done } = h.engine.submitText('안녕');
  let final = await done;
  assert.equal(final.phase, TURN_PHASE.COMPLETED);
  assert.equal(final.translatedText, 'りんご12個');
  assert.deepEqual([final.voice.status, final.voice.messageKey, final.voice.deviceFallbackAvailable], ['failed', 'error.VOICE_FAILED', true]);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  h.voice.status = 'partial';
  const again = h.engine.replay(turnId);
  assert.equal(again.turnId, turnId);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.SPEAKING);
  assert.equal(h.state.snapshot().activeTurnId, turnId);
  final = await again.done;
  assert.equal(h.voice.calls.length, 2);
  assert.equal(h.voice.calls[1].request.output, 'device');
  assert.equal(h.voice.calls[1].request.text, 'りんご12個');
  assert.deepEqual([final.voice.status, final.voice.messageKey, final.voice.gap], ['partial', 'voice.partialFailure', true]);
  assert.equal(final.translatedText, 'りんご12個');
  assert.equal(h.adapter.translates.length, 1);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  assert.throws(() => h.engine.replay('missing'), code('INVALID_REQUEST'));
  assert.throws(() => h.engine.replay(turnId, { output: 'off' }), code('INVALID_REQUEST'));
  // A speak that throws is still recorded as a failure, never as a lost translation.
  h.voice.speak = () => Promise.reject(new Error('SECRET'));
  final = await h.engine.replay(turnId, { output: 'provider' }).done;
  assert.deepEqual([final.voice.status, final.voice.errorCode, final.translatedText], ['failed', 'VOICE_FAILED', 'りんご12個']);
  assert.equal(leaks(h.state.snapshot()), false);
  await h.engine.close();
});

test('voice off shows captions only; voice settings apply from the next line', async () => {
  const h = harness();
  h.engine.setVoice({ output: 'off' });
  let final = await h.engine.submitText('안녕').done;
  assert.deepEqual([final.phase, final.voice.status, final.voice.messageKey], [TURN_PHASE.COMPLETED, 'off', 'seq.captionsOnly']);
  assert.equal(h.voice.calls.length, 0);
  assert.deepEqual(h.statuses, ['translating', 'idle']);
  h.engine.setVoice({ output: 'device', allowDeviceFallback: false, voice: 'Kore', deviceVoiceURI: 'com.apple.voice.ja' });
  final = await h.engine.submitText('다시').done;
  assert.deepEqual(h.voice.calls[0].request, { text: 'りんご12個', language: 'ja', output: 'device', allowDeviceFallback: false,
    voice: 'Kore', deviceVoiceURI: 'com.apple.voice.ja' });
  assert.throws(() => h.engine.setVoice({ output: 'loud' }), code('INVALID_REQUEST'));
  await h.engine.close();
});

test('translation errors end the turn with a code; retry reuses the record inside the shared budget', async () => {
  const h = harness();
  h.adapter.script.push(new ProviderError('INVALID_KEY'));
  const { turnId, done } = h.engine.submitText('안녕');
  let final = await done;
  assert.deepEqual([final.phase, final.errorCode, final.messageKey, final.attempts], [TURN_PHASE.ERROR, 'INVALID_KEY', 'error.INVALID_KEY', 1]);
  assert.equal(h.adapter.translates.length, 1);
  assert.equal(h.voice.calls.length, 0);
  // Two transient failures then success: three attempts, one record, one voice line.
  h.adapter.script.push(new ProviderError('UNAVAILABLE'), new ProviderError('UNAVAILABLE'));
  const retried = h.engine.retry(turnId);
  assert.equal(retried.turnId, turnId);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.TRANSLATING);
  final = await retried.done;
  assert.deepEqual([final.phase, final.translatedText, final.attempts, final.errorCode], [TURN_PHASE.COMPLETED, 'りんご12個', 2, null]);
  assert.equal(h.adapter.translates.length, 4);
  assert.equal(h.adapter.translates[3].context.budget.used, 3);
  assert.equal(h.state.snapshot().turns.length, 1);
  assert.equal(h.voice.calls.length, 1);
  // Budget exhaustion surfaces as its own code without extra calls.
  h.adapter.script.push(new ProviderError('UNAVAILABLE'), new ProviderError('UNAVAILABLE'), new ProviderError('UNAVAILABLE'), new ProviderError('UNAVAILABLE'));
  final = await h.engine.submitText('둘').done;
  assert.deepEqual([final.phase, final.errorCode], [TURN_PHASE.ERROR, 'UNAVAILABLE']);
  assert.equal(h.adapter.translates.length, 7);
  assert.throws(() => h.engine.retry('missing'), code('INVALID_REQUEST'));
  const silent = h.engine.startRecording();
  h.capture.sessions[0].finish({ status: 'silence', messageKey: 'seq.silence' });
  await silent.done;
  assert.throws(() => h.engine.retry(silent.turnId), code('INVALID_REQUEST'));
  assert.equal(leaks(h.state.snapshot()), false);
  await h.engine.close();
});

test('key deletion, selection changes and shared end abort work, close Live and clear shared conversations', async () => {
  const h = harness();
  await h.engine.submitText('하나').done;
  const gate = deferred();
  h.adapter.script.push(() => gate.promise);
  const { done } = h.engine.submitText('둘');
  await until(() => h.adapter.translates.length === 2);
  let closes = 0;
  const manager = h.sessionManager;
  h.config.sessionManager = { close: async () => { closes++; return manager.close(); } };
  h.keyStore.deleteKey('alpha', 'personal');
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(h.turn('turn-2').phase, TURN_PHASE.CANCELLED);
  assert.equal(h.state.snapshot().generation, 1);
  assert.equal(h.state.snapshot().notice.messageKey, 'mode.changed');
  // The store keeps the selected source; only the key is gone.
  assert.deepEqual(h.state.snapshot().keySelection, { providerId: 'alpha', keySource: 'personal' });
  assert.equal(closes, 1);
  gate.resolve(okResult({ input: { format: 'text', text: '둘' } }));
  assert.equal((await done).translatedText, '');
  // Personal deletion keeps the visible conversation; new work needs a key.
  assert.equal(h.state.snapshot().turns.length, 2);
  let final = await h.engine.submitText('셋').done;
  assert.deepEqual([final.phase, final.errorCode], [TURN_PHASE.ERROR, 'CREDENTIAL_REQUIRED']);
  assert.equal(h.adapter.translates.length, 2);
  final = await h.engine.startRecording().done;
  assert.equal(final.errorCode, 'CREDENTIAL_REQUIRED');
  assert.equal(h.capture.sessions.length, 0);
  // Device re-reading of an existing translation needs no provider key.
  final = await h.engine.replay('turn-1', { output: 'device' }).done;
  assert.deepEqual([final.voice.status, h.voice.calls.at(-1).request.output], ['completed', 'device']);
  final = await h.engine.replay('turn-1', { output: 'provider' }).done;
  assert.deepEqual([final.voice.status, final.voice.errorCode, final.translatedText], ['failed', 'CREDENTIAL_REQUIRED', 'りんご12個']);
  h.keyStore.setPersonal('alpha', KEY);
  assert.deepEqual(h.state.snapshot().keySelection, { providerId: 'alpha', keySource: 'personal' });
  assert.equal(h.voice.restarts, 1);
  assert.equal(h.state.snapshot().notice.messageKey, 'mode.changed');
  // Shared use: explicit selection, then ending it wipes the temporary conversation.
  h.keyStore.receiveSharedFragment(`#shared=${encodeURIComponent(JSON.stringify({ version: 1, providerId: 'alpha', eventName: 'Sunday', key: 'SHARED-SECRET' }))}`);
  h.keyStore.select('alpha', 'shared');
  assert.deepEqual(h.state.snapshot().keySelection, { providerId: 'alpha', keySource: 'shared' });
  final = await h.engine.submitText('공용').done;
  assert.equal(final.phase, TURN_PHASE.COMPLETED);
  assert.equal(h.adapter.translates.at(-1).context.keySource, 'shared');
  const generation = h.state.snapshot().generation;
  h.keyStore.endShared('alpha');
  assert.deepEqual(h.state.snapshot().turns, []);
  assert.equal(h.state.snapshot().notice.messageKey, 'records.sharedEnded');
  assert.equal(h.state.snapshot().generation, generation + 1);
  assert.deepEqual(h.state.snapshot().keySelection, { providerId: 'alpha', keySource: 'shared' });
  assert.equal(leaks(h.state.snapshot()), false);
  assert.equal(closes >= 4, true);
  await h.engine.close();
});

test('changing the interpretation pair ends the active turn and shapes the next request', async () => {
  const h = harness();
  const gate = deferred();
  h.adapter.script.push(() => gate.promise);
  const { done } = h.engine.submitText('안녕');
  await until(() => h.adapter.translates.length === 1);
  h.engine.setInterpretation({ sourceLanguage: 'auto', targetLanguage: 'en' });
  assert.equal(h.state.snapshot().generation, 1);
  assert.equal(h.state.snapshot().notice.messageKey, 'mode.changed');
  gate.resolve(okResult({ input: { format: 'text', text: '안녕' } }));
  assert.equal((await done).phase, TURN_PHASE.CANCELLED);
  assert.throws(() => h.engine.setInterpretation({ sourceLanguage: 'en', targetLanguage: 'en' }), code('INVALID_REQUEST'));
  h.adapter.script.push((request) => ({ ...okResult(request), translatedText: 'hello' }));
  const final = await h.engine.submitText('안녕').done;
  assert.deepEqual(h.adapter.translates[1].request, { targetLanguage: 'en', input: { format: 'text', text: '안녕' } });
  assert.equal(h.adapter.translates[1].context.generation, 1);
  assert.deepEqual([final.sourceLanguage, final.targetLanguage, final.translatedText], ['auto', 'en', 'hello']);
  assert.equal(h.voice.calls[0].request.language, 'en');
  // Changing languages while idle raises no notice.
  h.state.setNotice(null);
  h.engine.setInterpretation({ sourceLanguage: 'ja', targetLanguage: 'ko' });
  assert.equal(h.state.snapshot().notice, null);
  assert.equal(h.state.snapshot().generation, 2);
  await h.engine.close();
});

test('the real voice engine runs on the injected session manager and a voice failure keeps the captions', async () => {
  const h = harness({ realVoice: true });
  const { done } = h.engine.submitText('안녕');
  const final = await done;
  assert.equal(final.phase, TURN_PHASE.COMPLETED);
  assert.equal(final.translatedText, 'りんご12個');
  assert.equal(final.voice.engine, 'live');
  assert.equal(final.voice.status, 'failed');
  assert.equal(final.voice.messageKey, 'error.VOICE_FAILED');
  assert.equal(h.adapter.voices.length, 1);
  assert.deepEqual(h.adapter.voices[0].request, { language: 'ja', input: { format: 'text' } });
  assert.equal(h.adapter.voices[0].context.keySource, 'personal');
  assert.ok(h.sessionManager.generation >= 1);
  assert.equal(h.engine.snapshot().voice.live, 'ready');
  assert.equal(leaks(h.state.snapshot()), false);
  await h.engine.close();
  assert.equal(h.sessionManager.occupied, false);
});

test('close cancels everything, releases the microphone and voice, and rejects further use', async () => {
  const h = harness({ voiceMode: 'manual' });
  const first = h.engine.submitText('안녕');
  await until(() => h.voice.calls.length === 1);
  const closing = h.engine.close();
  assert.equal(h.engine.snapshot().closed, true);
  await closing;
  assert.equal((await first.done).voice.status, 'cancelled');
  assert.equal(h.capture.cancels, 1);
  assert.equal(h.voice.closes, 1);
  assert.equal(h.state.closed, true);
  assert.deepEqual(h.state.snapshot().turns, []);
  for (const call of [() => h.engine.submitText('x'), () => h.engine.startRecording(), () => h.engine.cancel(),
    () => h.engine.setInterpretation({ sourceLanguage: 'ko', targetLanguage: 'en' }), () => h.engine.setVoice({})]) {
    assert.throws(call, code('SESSION_CLOSED'));
  }
  await h.engine.close();
  // Key events after close are ignored.
  h.keyStore.deleteKey('alpha', 'personal');
  assert.equal(h.voice.closes, 1);
  await h.config.dispose();
});
