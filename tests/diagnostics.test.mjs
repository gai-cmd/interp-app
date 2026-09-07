import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createDiagnostics, CAPABILITY_STATES, DIAGNOSTIC_KINDS, DIAGNOSTIC_MESSAGE_KEYS, DIAGNOSTICS_POLICY,
  KIND_CAPABILITY, SAMPLE_TEXT, tonePCM } from '../app/engine/diagnostics.js';
import { APP_DEFAULTS } from '../app/config.js';
import { ProviderError } from '../app/providers/contract.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createKeyStore } from '../app/security/key-store.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { provider } from './fixtures/providers.mjs';
import { goldenWav } from './fixtures/audio.mjs';
import { createClock, deferred, tick } from './fixtures/live.mjs';

const KEY = 'PERSONAL-SECRET-KEY';
const leaks = (value) => /SECRET/.test(`${inspect(value, { depth: 8 })}${JSON.stringify(value)}`);
const code = (expected) => (error) => error instanceof ProviderError && error.code === expected;
async function until(condition, limit = 100) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}
const fragment = (providerId, eventName = 'Sunday <b>service</b>') => `#shared=${encodeURIComponent(JSON.stringify(
  { version: 1, providerId, eventName, key: 'SHARED-SECRET-KEY' }))}`;
const capability = (implementation, transports, inputFormats, outputFormats, extra = {}) => ({
  implementation, transports, inputFormats, outputFormats, models: ['test-model'], voices: [], ...extra });

// Adapter whose answers are scripted per capability (value, Error or function).
function scriptedAdapter(log) {
  const a = { calls: [], sessions: [], lives: [], script: { translate: [], stt: [], voice: [], live: [] } };
  const step = (name, request, context) => {
    a.calls.push({ name, request, context });
    log.push(name);
    const next = a.script[name].shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request, context) : next;
  };
  a.translate = async (request, context) => step('translate', request, context)
    ?? { sourceText: request.input.text, translatedText: 'こんにちは', detectedLanguage: 'ko', status: 'ok', model: 'test-model' };
  a.stt = async (request, context) => step('stt', request, context)
    ?? { sourceText: 'hello', detectedLanguage: 'en', status: 'ok', model: 'test-model' };
  a.voice = { async open(request, context) {
    step('voice', request, context);
    const session = { request, context, speaks: [], closes: 0, pending: null, open: true,
      emit: (event) => context.onEvent(event),
      speak(req) { session.speaks.push(req); return new Promise((resolve, reject) => { session.pending = { resolve, reject }; }); },
      async cancel() { session.open = false; }, async close() { session.closes++; session.open = false; },
      audio(bytes = 4800) { session.emit({ type: 'audio', audio: new Uint8Array(bytes), sampleRate: 24000 }); },
      complete(fields = {}) { session.pending.resolve({ status: 'completed', bytes: 4800, chunks: 1, said: '', model: 'test-model', voice: 'Kore', ...fields }); },
      fail(error) { session.pending.reject(error instanceof Error ? error : new ProviderError(error)); } };
    a.sessions.push(session);
    return session;
  } };
  a.live = { async open(request, context) {
    step('live', request, context);
    const session = { request, context, closes: 0, async sendAudio() {}, async finishInput() {}, async close() { session.closes++; } };
    a.lives.push(session);
    return session;
  } };
  return a;
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
function fakeAudioContext() {
  const sources = [];
  return { currentTime: 0, destination: {}, resumed: 0, sources, resumeError: null,
    async resume() { if (this.resumeError) throw this.resumeError; this.resumed++; },
    createBuffer(channels, size, rate) { const data = new Float32Array(size); return { data, duration: size / rate, getChannelData: () => data }; },
    createBufferSource() {
      const source = { at: null, stopped: false, connect() {}, disconnect() {}, stop() { this.stopped = true; },
        start(at) { this.at = at; setImmediate(() => this.onended?.()); } };
      sources.push(source); return source;
    } };
}

function harness({ key = KEY, select = true, capture: withCapture = true, audio = fakeAudioContext(), voiceEngine, liveModels = ['test-model'] } = {}) {
  const log = [];
  const registry = createRegistry();
  const adapter = scriptedAdapter(log);
  // alpha: everything direct and ready, including simultaneous live (ownership test).
  const alpha = provider('alpha');
  alpha.capabilities.live = capability('ready', ['direct'], ['pcm16'], ['pcm16', 'subtitle'], { models: liveModels });
  alpha.capabilities.voice.voices = ['Kore'];
  registry.register(alpha, adapter);
  // beta: planned live, unsupported voice.
  const beta = provider('beta');
  beta.capabilities.voice = capability('unsupported', [], [], []);
  registry.register(beta, adapter);
  // hubonly: no browser calls at all.
  registry.register(provider('hubonly', { browserDirect: false,
    credentialPolicy: { directPersonal: false, directShared: false, hubManaged: true },
    capabilities: { translate: capability('ready', ['hub'], ['text'], ['translation']), stt: capability('ready', ['hub'], ['wav'], ['transcript']),
      live: capability('planned', ['hub'], ['pcm16'], ['pcm16']), voice: capability('ready', ['hub'], ['text'], ['pcm16']) } }), {});
  const keyStore = createKeyStore({ registry });
  const router = createRouter({ registry, getCredentialRef: (address, options) => keyStore.getCredentialRef(address, options) });
  const clock = createClock();
  const sessionManager = createSessionManager({ timeoutMs: 60000, ...clock });
  const config = { registry, keyStore, router, sessionManager, defaults: APP_DEFAULTS, providers: registry.list(), resolveFallback: () => null };
  if (key !== null) { keyStore.setPersonal('alpha', key); if (select) keyStore.select('alpha', 'personal'); }
  const capture = withCapture ? fakeCapture(log) : null;
  const events = [];
  const diagnostics = createDiagnostics({ config, capture, voiceEngine, getAudioContext: () => audio, ...clock, random: () => 0, now: () => 1000 });
  diagnostics.subscribe((snapshot) => events.push(snapshot));
  const calls = (name) => adapter.calls.filter((call) => call.name === name);
  const table = (route = { providerId: 'alpha', keySource: 'personal' }) => Object.fromEntries(
    diagnostics.capabilities(route).map((entry) => [entry.capability, entry.state]));
  return { log, adapter, keyStore, router, sessionManager, config, capture, clock, audio, diagnostics, events, calls, table };
}

test('rejects invalid composition and exposes kinds, capability mapping and a clean test tone', () => {
  const h = harness();
  assert.throws(() => createDiagnostics({}), code('INVALID_REQUEST'));
  assert.throws(() => createDiagnostics({ config: h.config, capture: {} }), code('INVALID_REQUEST'));
  assert.throws(() => createDiagnostics({ config: h.config, voiceEngine: {} }), code('INVALID_REQUEST'));
  assert.throws(() => createDiagnostics({ config: { ...h.config, sessionManager: null } }), code('INVALID_REQUEST'));
  assert.deepEqual([...DIAGNOSTIC_KINDS], ['text', 'ptt', 'voice', 'live', 'microphone', 'playback']);
  assert.deepEqual(KIND_CAPABILITY, { text: 'translate', ptt: 'stt', voice: 'voice', live: 'live', microphone: null, playback: null });
  assert.deepEqual([...h.diagnostics.kinds], [...DIAGNOSTIC_KINDS]);
  assert.ok(CAPABILITY_STATES.includes('untested') && CAPABILITY_STATES.includes('hubRequired'));
  const tone = tonePCM();
  assert.equal(tone.byteLength, 24000 * DIAGNOSTICS_POLICY.toneMs / 1000 * 2);
  assert.equal(tone.byteLength % 2, 0);
  assert.equal(new Int16Array(tone.buffer, tone.byteOffset, tone.byteLength / 2)[0], 0);
  assert.ok(new Int16Array(tone.buffer, tone.byteOffset, tone.byteLength / 2).some((sample) => Math.abs(sample) > 1000));
  assert.throws(() => h.diagnostics.run('bogus'), code('INVALID_REQUEST'));
  assert.throws(() => h.diagnostics.run('text', null), code('INVALID_REQUEST'));
  assert.throws(() => h.diagnostics.subscribe(null), code('INVALID_REQUEST'));
});

test('the capability table reflects registration and routing only; nothing is available before its own check', () => {
  const h = harness();
  const alpha = h.diagnostics.capabilities({ providerId: 'alpha', keySource: 'personal' });
  assert.deepEqual(alpha.map((entry) => [entry.capability, entry.state, entry.route, entry.implementation]),
    [['translate', 'untested', 'direct', 'ready'], ['stt', 'untested', 'direct', 'ready'], ['live', 'untested', 'direct', 'ready'], ['voice', 'untested', 'direct', 'ready']]);
  assert.ok(Object.isFrozen(alpha) && Object.isFrozen(alpha[0]) && alpha.every((entry) => entry.result === null));
  assert.deepEqual(h.table({ providerId: 'beta', keySource: 'personal' }), { translate: 'untested', stt: 'untested', live: 'planned', voice: 'unsupported' });
  assert.equal(h.diagnostics.capabilities({ providerId: 'beta', keySource: 'personal' })[3].route, null);
  const hub = h.diagnostics.capabilities({ providerId: 'hubonly', keySource: 'personal' });
  assert.deepEqual(hub.map((entry) => [entry.state, entry.route]), [['hubRequired', 'hub'], ['hubRequired', 'hub'], ['planned', 'hub'], ['hubRequired', 'hub']]);
  assert.deepEqual(h.table(null), { translate: 'untested', stt: 'untested', live: 'untested', voice: 'untested' });
  assert.deepEqual(h.table({ providerId: 'nope', keySource: 'personal' }), { translate: 'untested', stt: 'untested', live: 'untested', voice: 'untested' });
  // Default route is the key-store selection.
  assert.deepEqual(h.diagnostics.capabilities().map((entry) => entry.state), ['untested', 'untested', 'untested', 'untested']);
  assert.equal(JSON.stringify(h.diagnostics.snapshot()), JSON.stringify({ running: null, results: [], generation: 0, closed: false }));
  assert.equal(h.adapter.calls.length, 0);
});

test('a text check makes exactly one translate attempt and marks only translate available', async () => {
  const h = harness();
  const handle = h.diagnostics.run('text');
  assert.equal(handle.kind, 'text');
  assert.equal(h.diagnostics.snapshot().running.kind, 'text');
  assert.equal(h.table().translate, 'running');
  const result = await handle.done;
  assert.ok(Object.isFrozen(result));
  assert.equal(result.state, 'available');
  assert.equal(result.capability, 'translate');
  assert.equal(result.providerId, 'alpha'); assert.equal(result.keySource, 'personal');
  assert.equal(result.model, 'test-model'); assert.equal(result.errorCode, null); assert.equal(result.messageKey, undefined);
  assert.equal(result.at, 1000);
  assert.equal(h.adapter.calls.length, 1);
  const call = h.adapter.calls[0];
  assert.equal(call.name, 'translate');
  assert.deepEqual(call.request, { input: { format: 'text', text: SAMPLE_TEXT.ko }, sourceLanguage: 'ko', targetLanguage: 'ja' });
  assert.equal(call.context.providerId, 'alpha'); assert.equal(call.context.keySource, 'personal');
  assert.equal(call.context.budget.remaining, 0, 'one attempt, no fallback');
  assert.equal(call.context.turnId, 'check-1');
  assert.deepEqual(h.table(), { translate: 'available', stt: 'untested', live: 'untested', voice: 'untested' });
  assert.equal(h.diagnostics.snapshot().running, null);
  assert.equal(h.diagnostics.snapshot().results.length, 1);
  assert.equal(leaks(h.diagnostics.snapshot()), false);
  assert.equal(leaks(h.events), false);

  h.adapter.script.translate.push(new ProviderError('INVALID_KEY'));
  const failed = await h.diagnostics.run('text', { sourceLanguage: 'en', targetLanguage: 'ko' }).done;
  assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'INVALID_KEY'); assert.equal(failed.messageKey, 'error.INVALID_KEY');
  assert.deepEqual(h.adapter.calls[1].request, { input: { format: 'text', text: SAMPLE_TEXT.en }, sourceLanguage: 'en', targetLanguage: 'ko' });
  assert.equal(h.table().translate, 'failed');
  assert.equal(h.diagnostics.snapshot().results.length, 1, 'one result per provider, key source and check');

  // A reply without a usable translation is not success, even though the call went through.
  h.adapter.script.translate.push({ sourceText: 'x', translatedText: '', detectedLanguage: 'ko', status: 'ok', model: 'test-model' });
  const empty = await h.diagnostics.run('text').done;
  assert.equal(empty.state, 'failed'); assert.equal(empty.errorCode, 'INVALID_RESULT');
  h.adapter.script.translate.push({ sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'unrecognized', model: 'test-model' });
  assert.equal((await h.diagnostics.run('text').done).state, 'failed');
  h.adapter.script.translate.push(new Error('SECRET detail'));
  const raw = await h.diagnostics.run('text').done;
  assert.equal(raw.state, 'failed'); assert.equal(raw.errorCode, 'PROVIDER_ERROR');
  assert.equal(leaks(raw), false);
  // Same language on both sides falls back to a distinct sample language.
  await h.diagnostics.run('text', { sourceLanguage: 'ja', targetLanguage: 'ja' }).done;
  assert.equal(h.adapter.calls.at(-1).request.sourceLanguage, 'ko');
  await h.diagnostics.close();
  assert.equal(h.clock.size, 0);
});

test('results are kept per provider and key source, cleared by key events, and never started by saving a key', async () => {
  const h = harness();
  assert.equal((await h.diagnostics.run('text').done).state, 'available');
  h.keyStore.receiveSharedFragment(fragment('alpha'));
  assert.equal(h.adapter.calls.length, 1, 'receiving a shared key runs no check');
  assert.equal(h.table({ providerId: 'alpha', keySource: 'personal' }).translate, 'available');
  assert.equal(h.table({ providerId: 'alpha', keySource: 'shared' }).translate, 'untested');
  const before = h.diagnostics.snapshot().generation;
  h.keyStore.select('alpha', 'shared');
  assert.equal(h.diagnostics.snapshot().generation, before + 1);
  assert.equal(h.table({ providerId: 'alpha', keySource: 'personal' }).translate, 'untested', 'P2 selection changes invalidate connection results');
  assert.equal(h.adapter.calls.length, 1);
  const shared = await h.diagnostics.run('text').done;
  assert.equal(shared.state, 'available'); assert.equal(shared.keySource, 'shared');
  assert.equal(h.adapter.calls.at(-1).context.keySource, 'shared');
  assert.equal(h.diagnostics.snapshot().results.length, 1);
  // The personal result is for the old personal key only.
  h.keyStore.setPersonal('alpha', 'NEW-SECRET-KEY');
  assert.equal(h.adapter.calls.length, 2, 'saving a key runs no check');
  assert.equal(h.table({ providerId: 'alpha', keySource: 'personal' }).translate, 'untested');
  assert.equal(h.table({ providerId: 'alpha', keySource: 'shared' }).translate, 'available');
  h.keyStore.endShared('alpha');
  assert.equal(h.table({ providerId: 'alpha', keySource: 'shared' }).translate, 'untested');
  assert.equal(h.diagnostics.snapshot().results.length, 0);
  assert.equal(h.adapter.calls.length, 2);
  // A running check is cancelled by a key event and its late result is dropped.
  h.keyStore.select('alpha', 'personal');
  const gate = deferred();
  h.adapter.script.translate.push(() => gate.promise);
  const pending = h.diagnostics.run('text');
  await until(() => h.adapter.calls.length === 3);
  h.keyStore.deleteKey('alpha', 'personal');
  gate.resolve({ sourceText: 'x', translatedText: 'y', detectedLanguage: 'ko', status: 'ok', model: 'test-model' });
  const late = await pending.done;
  assert.equal(late.state, 'cancelled');
  assert.equal(h.diagnostics.snapshot().results.length, 0);
  assert.equal(leaks(h.diagnostics.snapshot()), false);
  await h.diagnostics.close();
});

test('checks without a usable route or path end without any credential, network or microphone use', async () => {
  const h = harness({ key: null });
  const none = await h.diagnostics.run('text').done;
  assert.equal(none.state, 'failed'); assert.equal(none.errorCode, 'CREDENTIAL_REQUIRED'); assert.equal(none.providerId, null);
  const missing = await h.diagnostics.run('text', { providerId: 'alpha', keySource: 'shared' }).done;
  assert.equal(missing.state, 'failed'); assert.equal(missing.errorCode, 'CREDENTIAL_REQUIRED'); assert.equal(missing.keySource, 'shared');
  const planned = await h.diagnostics.run('live', { providerId: 'beta', keySource: 'personal' }).done;
  assert.equal(planned.state, 'planned'); assert.equal(planned.messageKey, 'capability.planned');
  const unsupported = await h.diagnostics.run('voice', { providerId: 'beta', keySource: 'personal' }).done;
  assert.equal(unsupported.state, 'unsupported'); assert.equal(unsupported.messageKey, 'capability.unsupported');
  const hub = await h.diagnostics.run('text', { providerId: 'hubonly', keySource: 'personal' }).done;
  assert.equal(hub.state, 'hubRequired'); assert.equal(hub.messageKey, 'capability.hubRequired');
  const unknown = await h.diagnostics.run('ptt', { providerId: 'nope', keySource: 'personal' }).done;
  assert.equal(unknown.state, 'failed'); assert.equal(unknown.errorCode, 'UNKNOWN_PROVIDER');
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(h.capture.sessions.length, 0);
  assert.equal(h.sessionManager.occupied, false);
  assert.deepEqual(h.table({ providerId: 'beta', keySource: 'personal' }), { translate: 'untested', stt: 'untested', live: 'planned', voice: 'unsupported' });
  // Non-key results are stored (planned/hub) but never as 'available'.
  assert.ok(h.diagnostics.snapshot().results.every((result) => result.state !== 'available'));
  await h.diagnostics.close();
});

test('a voice check goes through the shared session slot and passes only after audio was heard', async () => {
  const h = harness();
  const first = h.diagnostics.run('voice');
  await until(() => h.adapter.sessions[0]?.speaks.length === 1);
  const s = h.adapter.sessions[0];
  assert.equal(h.sessionManager.occupied, true);
  assert.equal(s.context.generation, h.sessionManager.generation, 'opened through the session manager');
  assert.deepEqual(s.request, { language: 'ja', input: { format: 'text' } });
  assert.deepEqual(s.speaks, [{ text: SAMPLE_TEXT.ja }]);
  assert.equal(h.table().voice, 'running');
  assert.equal(h.diagnostics.snapshot().running.kind, 'voice');
  s.audio(); s.complete();
  const result = await first.done;
  assert.equal(result.state, 'available'); assert.equal(result.capability, 'voice'); assert.equal(result.model, 'test-model');
  assert.deepEqual(h.table(), { translate: 'untested', stt: 'untested', live: 'untested', voice: 'available' });
  assert.equal(h.audio.sources.length, 1, 'the sample was played');
  // The server ending a turn without audio is a failure, not a pass.
  const second = h.diagnostics.run('voice', { voice: 'Kore' });
  await until(() => h.adapter.sessions.length === 2 && h.adapter.sessions[1].speaks.length === 1);
  assert.deepEqual(h.adapter.sessions[1].request, { language: 'ja', voice: 'Kore', input: { format: 'text' } });
  assert.equal(h.adapter.sessions[0].open, false, 'a different voice replaces the session at the turn boundary');
  h.adapter.sessions.at(-1).complete({ bytes: 0, chunks: 0 });
  const silent = await second.done;
  assert.equal(silent.state, 'failed'); assert.equal(silent.errorCode, 'INVALID_RESULT');
  assert.equal(h.table().voice, 'failed');
  // Live failures suspend voice; a user-started check restarts and tries again.
  h.adapter.script.voice.push(new ProviderError('INVALID_KEY'));
  const invalid = await h.diagnostics.run('voice').done;
  assert.equal(invalid.state, 'failed'); assert.equal(invalid.errorCode, 'INVALID_KEY');
  const again = h.diagnostics.run('voice');
  await until(() => h.adapter.sessions.length === 3 && h.adapter.sessions[2].speaks.length === 1);
  h.adapter.sessions[2].audio(); h.adapter.sessions[2].complete();
  assert.equal((await again.done).state, 'available');
  assert.equal(h.adapter.sessions.filter((session) => session.open).length, 1, 'never more than one Live session');
  assert.equal(leaks(h.diagnostics.snapshot()), false);
  await h.diagnostics.close();
  assert.equal(h.sessionManager.occupied, false);
  assert.equal(h.adapter.sessions.filter((session) => session.open).length, 0);
  assert.equal(h.clock.size, 0);
});

test('a live check replaces any open Live session, closes its own, and a new check cancels the running one', async () => {
  const h = harness();
  const voiceCheck = h.diagnostics.run('voice');
  await until(() => h.adapter.sessions[0]?.speaks.length === 1);
  const voiceSession = h.adapter.sessions[0];
  const liveCheck = h.diagnostics.run('live', { sourceLanguage: 'en', targetLanguage: 'ko' });
  assert.equal((await voiceCheck.done).state, 'cancelled');
  const live = await liveCheck.done;
  assert.equal(live.state, 'available'); assert.equal(live.capability, 'live');
  assert.equal(voiceSession.open, false, 'the voice session was closed before the live one opened');
  assert.equal(h.adapter.lives.length, 1);
  assert.equal(h.adapter.lives[0].closes, 1, 'the check leaves no session open');
  assert.deepEqual(h.adapter.lives[0].request, { input: { format: 'pcm16' }, sourceLanguage: 'en', targetLanguage: 'ko' });
  assert.equal(h.adapter.lives[0].context.generation > voiceSession.context.generation, true);
  assert.equal(h.sessionManager.occupied, false);
  assert.deepEqual(h.table(), { translate: 'untested', stt: 'untested', live: 'available', voice: 'cancelled' });
  assert.equal(h.diagnostics.snapshot().results.find((result) => result.kind === 'voice').state, 'cancelled');
  h.adapter.script.live.push(new ProviderError('SESSION_LIMIT'));
  const limited = await h.diagnostics.run('live').done;
  assert.equal(limited.state, 'failed'); assert.equal(limited.errorCode, 'SESSION_LIMIT');
  assert.equal(h.sessionManager.occupied, false);
  await h.diagnostics.close();
  assert.equal(h.clock.size, 0);
});

test('PTT and microphone checks capture inside the gesture; PTT transcribes what was captured', async () => {
  const h = harness();
  const ptt = h.diagnostics.run('ptt', { sourceLanguage: 'ko' });
  assert.equal(h.capture.sessions.length, 1, 'capture starts synchronously');
  assert.equal(h.diagnostics.snapshot().running.capturing, true);
  assert.equal(h.table().stt, 'running');
  ptt.stop();
  const result = await ptt.done;
  assert.equal(result.state, 'available'); assert.equal(result.capability, 'stt');
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.adapter.calls[0].name, 'stt');
  assert.deepEqual(h.adapter.calls[0].request, { input: { format: 'wav', audio: goldenWav }, language: 'ko' });
  assert.equal(h.adapter.calls[0].context.budget.remaining, 0);
  assert.deepEqual(h.table(), { translate: 'untested', stt: 'available', live: 'untested', voice: 'untested' });
  assert.equal(h.diagnostics.snapshot().running, null);

  const silent = h.diagnostics.run('ptt');
  h.capture.sessions[1].finish({ status: 'silence', messageKey: 'seq.silence' });
  const silence = await silent.done;
  assert.equal(silence.state, 'failed'); assert.equal(silence.messageKey, 'seq.silence'); assert.equal(silence.errorCode, null);
  assert.equal(h.adapter.calls.length, 1, 'silence is not sent');
  const denied = h.diagnostics.run('ptt');
  h.capture.sessions[2].finish({ status: 'error', code: 'MICROPHONE_DENIED', messageKey: 'error.MICROPHONE_DENIED' });
  const deniedResult = await denied.done;
  assert.equal(deniedResult.state, 'failed'); assert.equal(deniedResult.errorCode, 'MICROPHONE_DENIED');
  h.adapter.script.stt.push({ sourceText: '', detectedLanguage: 'und', status: 'no-speech', model: 'test-model' });
  const noSpeech = h.diagnostics.run('ptt'); noSpeech.stop();
  assert.equal((await noSpeech.done).messageKey, 'seq.silence');
  h.adapter.script.stt.push({ sourceText: '', detectedLanguage: 'und', status: 'unrecognized', model: 'test-model' });
  const unrecognized = h.diagnostics.run('ptt'); unrecognized.stop();
  assert.equal((await unrecognized.done).messageKey, 'seq.unrecognized');
  const cancelled = h.diagnostics.run('ptt');
  const cancelledResult = await cancelled.cancel();
  assert.equal(cancelledResult.state, 'cancelled'); assert.equal(cancelledResult.messageKey, 'seq.cancelled');
  assert.equal(h.capture.sessions.at(-1).ended, true);
  assert.equal(h.table().stt, 'cancelled');

  const microphone = h.diagnostics.run('microphone');
  assert.equal(h.capture.active, h.capture.sessions.at(-1));
  microphone.stop();
  const mic = await microphone.done;
  assert.equal(mic.state, 'available'); assert.equal(mic.capability, null); assert.equal(mic.providerId, null);
  assert.equal(h.adapter.calls.length, 3, 'a microphone check never calls the provider');
  const external = new AbortController();
  const aborted = h.diagnostics.run('microphone', { signal: external.signal });
  external.abort('SECRET');
  assert.equal((await aborted.done).state, 'cancelled');
  assert.equal(leaks(h.diagnostics.snapshot()), false);
  await h.diagnostics.close();
  const none = harness({ capture: false });
  const unavailable = await none.diagnostics.run('microphone').done;
  assert.equal(unavailable.state, 'failed'); assert.equal(unavailable.errorCode, 'MICROPHONE_UNAVAILABLE');
  await none.diagnostics.close();
});

test('the playback check plays a short tone through the audio context and reports blocked output', async () => {
  const h = harness();
  const result = await h.diagnostics.run('playback').done;
  assert.equal(result.state, 'available'); assert.equal(result.providerId, null);
  assert.equal(h.audio.resumed, 1); assert.equal(h.audio.sources.length, 1);
  assert.equal(h.adapter.calls.length, 0);
  assert.equal(h.diagnostics.snapshot().results.find((item) => item.kind === 'playback').state, 'available');
  await h.diagnostics.close();
  const blocked = harness({ audio: Object.assign(fakeAudioContext(), { resumeError: new Error('SECRET') }) });
  const blockedResult = await blocked.diagnostics.run('playback').done;
  assert.equal(blockedResult.state, 'failed'); assert.equal(blockedResult.errorCode, 'PLAYBACK_BLOCKED');
  assert.equal(leaks(blockedResult), false);
  await blocked.diagnostics.close();
  const missing = harness({ audio: null });
  assert.equal((await missing.diagnostics.run('playback').done).errorCode, 'PLAYBACK_BLOCKED');
  await missing.diagnostics.close();
});

test('an injected voice engine is shared, not closed; close cancels the running check and detaches', async () => {
  const calls = [];
  let pending = null;
  const voiceEngine = { restarts: 0, closes: 0,
    speak(request, context) {
      calls.push({ request, context });
      return new Promise((resolve) => {
        const finish = (status) => resolve({ turnId: context.turnId, sessionId: context.sessionId, generation: 1, engine: 'live', status,
          messageKey: status === 'cancelled' ? 'error.ABORTED' : undefined, errorCode: status === 'cancelled' ? 'ABORTED' : null,
          fallback: false, liveErrorCode: null, deviceFallbackAvailable: false, firstAudio: status === 'completed', bytes: 4800,
          said: '', model: 'test-model', voice: 'Kore', gap: false, secret: 'SECRET' });
        context.signal.addEventListener('abort', () => finish('cancelled'), { once: true });
        pending = finish;
      });
    },
    restart() { this.restarts++; }, async close() { this.closes++; } };
  const h = harness({ voiceEngine });
  const first = h.diagnostics.run('voice');
  await until(() => calls.length === 1);
  assert.equal(voiceEngine.restarts, 1);
  assert.deepEqual(calls[0].request, { text: SAMPLE_TEXT.ja, language: 'ja', output: 'provider', allowDeviceFallback: false });
  assert.equal(calls[0].context.providerId, 'alpha'); assert.equal(calls[0].context.keySource, 'personal');
  pending('completed');
  assert.equal((await first.done).state, 'available');
  const second = h.diagnostics.run('voice');
  await until(() => calls.length === 2);
  await h.diagnostics.close();
  assert.equal((await second.done).state, 'cancelled');
  assert.equal(voiceEngine.closes, 0, 'the owner closes an injected engine');
  assert.throws(() => h.diagnostics.run('text'), code('SESSION_CLOSED'));
  assert.equal(h.diagnostics.snapshot().closed, true);
  assert.deepEqual([...h.diagnostics.snapshot().results], []);
  h.keyStore.setPersonal('alpha', 'AFTER-SECRET');
  assert.equal(h.diagnostics.snapshot().generation, 0, 'no listener runs after close');
  assert.equal(leaks(h.events), false);
});

test('every message key a result can carry exists in all three dictionaries', async () => {
  const dictionaries = {};
  for (const language of ['ko', 'en', 'ja']) {
    dictionaries[language] = JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'));
  }
  const keys = [...DIAGNOSTIC_MESSAGE_KEYS, ...CAPABILITY_STATES.filter((state) => state !== 'running' && state !== 'cancelled').map((state) => `capability.${state}`),
    ...DIAGNOSTIC_KINDS.map((kind) => `diagnostics.${kind}`), 'diagnostics.running', 'diagnostics.scope', 'diagnostics.userStart',
    'error.CREDENTIAL_REQUIRED', 'error.INVALID_RESULT', 'error.MICROPHONE_UNAVAILABLE', 'error.UNKNOWN_PROVIDER'];
  for (const key of keys) {
    for (const language of ['ko', 'en', 'ja']) assert.equal(typeof dictionaries[language][key], 'string', `${language}:${key}`);
  }
});

test('P2 checks share activity ownership and never steal active hub or direct work', async () => {
  const { createActivity } = await import('../app/engine/activity.js');
  const activity = createActivity();
  const h = harness();
  for (const kind of ['hub', 'sim', 'seq']) {
    const lease = activity.acquire(kind, { cancel() {}, async close() {} });
    assert.throws(() => h.diagnostics.run('live'), code('SESSION_LIMIT'));
    assert.throws(() => h.diagnostics.run('microphone'), code('SESSION_LIMIT'));
    assert.equal(h.adapter.calls.length, 0); assert.equal(h.capture.sessions.length, 0);
    await lease.close();
  }
  const check = h.diagnostics.run('microphone');
  assert.equal(activity.snapshot().kind, 'diagnostics');
  assert.throws(() => activity.acquire('hub', { cancel() {}, async close() {} }), code('SESSION_LIMIT'));
  await activity.close();
  assert.equal((await check.done).state, 'cancelled');
  assert.equal(activity.occupied, false);
  await h.diagnostics.close();
});

test('P2 live checks report only the requested registered model, with no microphone or voice invocation', async () => {
  const h = harness();
  const result = await h.diagnostics.run('live', { model: 'test-model' }).done;
  assert.equal(result.state, 'available'); assert.equal(result.model, 'test-model');
  assert.equal(result.requestedModel, 'test-model'); assert.equal(result.setupMs, 0);
  assert.equal(h.adapter.lives[0].request.model, 'test-model');
  assert.equal(h.capture.sessions.length, 0); assert.equal(h.adapter.sessions.length, 0);
  assert.equal(h.table().voice, 'untested');
  assert.equal(h.diagnostics.capabilities(undefined, { model: 'other-model' }).find(c => c.capability === 'live').state, 'untested');
  assert.throws(() => h.diagnostics.run('live', { model: 'SECRET' }), code('MODEL_UNSUPPORTED'));
  h.adapter.script.translate.push({ status: 'ok', translatedText: 'ok', model: 'SECRET' });
  assert.equal((await h.diagnostics.run('text').done).model, null);
  assert.equal(leaks(h.diagnostics.snapshot()), false);
  await h.diagnostics.close();
});

test('P2 settings first load survives empty, malformed and throwing voice lists', async () => {
  const { createBrowser } = await import('./fixtures/scenarios.mjs');
  const { startApp } = await import('../app/main.js');
  for (const getVoices of [() => [], () => null, () => ({}), () => { throw new Error('SECRET'); },
    () => [{ get voiceURI() { throw new Error('SECRET'); } }]]) {
    const b = createBrowser(); b.win.speechSynthesis.getVoices = getVoices;
    const app = await startApp({ builtinKey: () => null, window: b.win, setTimeout: b.clock.setTimeout, clearTimeout: b.clock.clearTimeout });
    assert.ok(app); assert.ok(app.settingsView);
    assert.equal(b.root.textContent.includes('SECRET'), false);
    await app.close();
  }
});

test('P2 operational metrics and venue state render separately and never attest Live', async () => {
  const { createBrowser, domText } = await import('./fixtures/scenarios.mjs');
  const { createDiagnosticsView } = await import('../app/ui/diagnostics-view.js');
  const { createListenMetrics } = await import('../app/engine/listen-metrics.js');
  const b = createBrowser(); const h = harness(); const metrics = createListenMetrics();
  const dict = JSON.parse(await readFile(new URL('../app/i18n/en.json', import.meta.url), 'utf8'));
  let listener; let detached = false;
  const hub = { snapshot: () => ({ broadcast: 'receiving', detail: 'SECRET', room: 'SECRET' }),
    subscribe(fn) { listener = fn; return () => { detached = true; }; } };
  const view = createDiagnosticsView({ root: b.root, diagnostics: h.diagnostics, metrics, hub,
    i18n: { t: key => dict[key] ?? key } });
  metrics.observe('reconnects', 3); listener();
  const text = domText(b.root);
  assert.ok(text.includes(dict['hub.broadcast.receiving']));
  assert.ok(text.includes(dict['diagnostics.timingBoundary']));
  assert.ok(text.includes(dict['diagnostics.unsupported']));
  assert.equal(text.includes('SECRET'), false);
  assert.equal(h.table().live, 'untested'); assert.equal(h.adapter.calls.length, 0);
  view.destroy(); assert.equal(detached, true); await h.diagnostics.close();
});

test('P2 result storage has a fixed cap and Live timeout waits for late socket cleanup', async () => {
  const h = harness();
  for (let i = 0; i < 80; i++) await h.diagnostics.run('live', { providerId: `unknown${i}`, keySource: 'personal' }).done;
  assert.equal(h.diagnostics.snapshot().results.length, DIAGNOSTICS_POLICY.maxResults);
  const gate = deferred(); let closed = 0;
  const oldRouter = h.config.router;
  h.config.router = { call: () => gate.promise };
  const handle = h.diagnostics.run('live');
  await until(() => h.sessionManager.occupied);
  h.clock.advance(DIAGNOSTICS_POLICY.requestTimeoutMs); await tick();
  gate.resolve({ async close() { closed++; } });
  const result = await handle.done;
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'TIMEOUT');
  assert.equal(closed, 1); assert.equal(h.sessionManager.occupied, false);
  assert.equal(h.clock.size, 0);
  h.config.router = oldRouter; await h.diagnostics.close();
});


test('P2 multiple registered Live models keep isolated results and key changes invalidate all models', async () => {
  const h = harness({ liveModels: ['test-model', 'second-model'] });
  await h.diagnostics.run('live', { model: 'test-model' }).done;
  assert.equal(h.diagnostics.capabilities(undefined, { model: 'second-model' }).find(c => c.capability === 'live').state, 'untested');
  await h.diagnostics.run('live', { model: 'second-model' }).done;
  assert.deepEqual(h.diagnostics.snapshot().results.map(r => r.model), ['test-model', 'second-model']);
  assert.equal(h.diagnostics.capabilities(undefined, { model: 'second-model' }).find(c => c.capability === 'live').state, 'available');
  h.keyStore.setPersonal('alpha', 'NEW-SECRET-KEY');
  assert.equal(h.diagnostics.snapshot().results.length, 0);
  await h.diagnostics.close();
});
