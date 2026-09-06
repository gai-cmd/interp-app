import test from 'node:test';
import assert from 'node:assert/strict';
import { simFixture, content, audioContent, deferred, tick } from './fixtures/sim.mjs';
import { DelayedBlob } from './fixtures/live.mjs';
import { buildLiveSetup, DEFAULT_LIVE_MODEL, LIVE_MODELS } from '../app/providers/gemini/live-config.js';
const FLASH = 'gemini-3.1-flash-live-preview';

async function advanceInput(f, ms) {
  while (ms > 0) { f.frame(); const step = Math.min(ms, 500); f.audio.advance(step); await tick(); ms -= step; }
}

test('gesture capture → manager → router setup → bounded PCM uplink, captions and generated audio', async t => {
  const f = simFixture(); t.after(() => f.close());
  assert.equal(f.micCalls(), 0); assert.equal(f.sockets.length, 0);
  const h = f.start(); assert.equal(f.micCalls(), 1);
  assert.equal(f.engine.snapshot().status, 'preparing');
  await tick(); f.frame(); await tick();
  assert.equal(f.engine.snapshot().status, 'connecting');
  f.frame(); await tick();
  const s = await f.open(); await h.ready;
  assert.equal(f.engine.snapshot().status, 'running');
  assert.equal(s.sent.length, 1);
  f.frame(); f.audio.advance(0); await tick();
  assert.equal(s.sent[1].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(atob(s.sent[1].realtimeInput.audio.data).length, 1024);
  content(s, { inputTranscription: { text: 'source' }, outputTranscription: { text: '번역' }, ...audioContent });
  await tick();
  assert.equal(f.engine.snapshot().captions.captions.length, 2);
  assert.equal(f.audio.made.length, 1);
  assert.ok(f.audio.made[0].at >= f.audio.context.currentTime);
  assert.ok(f.engine.snapshot().captions.captions.every(r => r.status === 'partial'));
  assert.equal(s.sent.some(v => v.realtimeInput?.audioStreamEnd || v.realtimeInput?.activityEnd), false);
  assert.equal(f.engine.snapshot().metrics.firstAudioReceivedMs !== null, true);
  assert.equal(f.engine.snapshot().metrics.firstAudioScheduledMs !== null, true);
  content(s, { turnComplete: true }); await tick();
  assert.ok(f.engine.snapshot().captions.captions.every(r => r.status === 'final'));
  assert.deepEqual(f.calls, ['live']);
  assert.equal((await f.engine.stop()).status, 'stopped');
  assert.equal(f.manager.occupied, false); assert.equal(f.track.stops, 1);
  assert.ok(f.audio.made.every(s => s.stopped));
  assert.equal((await h.done).status, 'stopped');
});

test('goAway waits for physical close, discards reconnect input and rejects old generation audio', async t => {
  const f = simFixture({ autoClose: false }); t.after(() => f.close()); await f.running();
  const old = f.sockets[0];
  content(old, { outputTranscription: { text: 'unfinished' }, ...audioContent }); await tick();
  old.json({ goAway: { timeLeft: '10s' } }); await tick();
  assert.equal(f.engine.snapshot().status, 'reconnecting');
  assert.equal(f.engine.snapshot().captions.captions[0].status, 'interrupted');
  f.frame(); f.audio.advance(1125); await tick();
  assert.equal(f.sockets.length, 1); assert.equal(f.manager.occupied, true);
  old.finishClose(); await tick();
  f.frame(); f.audio.advance(1125); await tick();
  assert.equal(f.sockets.length, 2);
  await f.open();
  const s = f.sockets[1]; assert.equal(s.sent.length, 1);
  content(old, audioContent); content(s, { outputTranscription: { text: 'new', finished: true }, ...audioContent }); await tick();
  assert.equal(f.audio.made.length, 2);
  assert.equal(f.engine.snapshot().captions.captions.at(-1).translatedText, 'new');
  assert.equal(f.engine.snapshot().retries, 1);
  const stopping = f.engine.stop(); await tick();
  assert.equal(f.engine.snapshot().status, 'stopping'); assert.equal(f.manager.occupied, true);
  s.finishClose(); await stopping;
  assert.equal(f.manager.occupied, false);
});

test('permission cancelled while pending cleans the late stream and never opens Live', async t => {
  const permission = deferred(), f = simFixture({ permission }); t.after(() => f.close());
  const h = f.start(); await f.engine.stop();
  permission.resolve(f.stream); await tick();
  assert.equal(f.track.stops, 1); assert.equal(f.sockets.length, 0);
  assert.equal((await h.ready).status, 'stopped');
  assert.equal(f.audio.timers.size, 0);
});

test('permission denial is a safe microphone failure without credentials or connection', async t => {
  const permission = deferred(), f = simFixture({ permission }); t.after(() => f.close());
  const h = f.start(); permission.reject(Object.assign(Error('SECRET'), { name: 'NotAllowedError' }));
  const result = await h.done;
  assert.equal(result.errorCode, 'MICROPHONE_DENIED'); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('fatal quota ends capture and PCM without fallback or voice calls', async t => {
  const f = simFixture(); t.after(() => f.close()); const h = await f.running();
  content(f.sockets[0], { outputTranscription: { text: 'tail' }, ...audioContent }); await tick();
  f.sockets[0].json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET unknown quota' } });
  const result = await h.done;
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'UNKNOWN_429');
  assert.deepEqual(f.calls, ['live']); assert.equal(f.track.stops, 1);
  assert.equal(f.engine.snapshot().captions.captions[0].status, 'interrupted');
  assert.doesNotMatch(JSON.stringify(f.engine.snapshot()), /SECRET/);
});

test('blocked output and mute do not interrupt captions or reopen Live', async t => {
  const f = simFixture({ blocked: true }); t.after(() => f.close()); await f.running();
  assert.equal(f.engine.snapshot().output, 'blocked');
  content(f.sockets[0], { outputTranscription: { text: 'caption', finished: true }, ...audioContent }); await tick();
  assert.equal(f.engine.snapshot().status, 'running'); assert.equal(f.audio.made.length, 0);
  f.engine.setMuted(true); assert.equal(f.engine.snapshot().output, 'muted');
  f.audio.context.setState('running'); f.engine.setMuted(false);
  assert.equal(f.audio.made.length, 0); assert.equal(f.calls.length, 1);
  content(f.sockets[0], audioContent); await tick(); assert.equal(f.audio.made.length, 1);
});

for (const reason of ['pagehide', 'hidden', 'ended']) test(`${reason} stops and requires manual restart`, async t => {
  const f = simFixture(); t.after(() => f.close()); const h = await f.running();
  if (reason === 'pagehide') f.platform.page.dispatchEvent(new Event('pagehide'));
  if (reason === 'hidden') { f.platform.document.hidden = true; f.platform.document.dispatchEvent(new Event('visibilitychange')); }
  if (reason === 'ended') f.track.dispatchEvent(new Event('ended'));
  assert.equal((await h.done).status, 'stopped');
  f.audio.advance(5000); await tick(); assert.equal(f.calls.length, 1);
});

test('stop during setup is idempotent and ignores late setup/audio', async t => {
  const f = simFixture({ autoClose: false }); t.after(() => f.close());
  const h = f.start(); await tick(); f.frame(); await tick();
  const s = f.sockets[0]; s.open();
  const a = f.engine.stop(), b = f.engine.stop(); assert.equal(a, b);
  s.json({ setupComplete: {} }); content(s, audioContent); s.finishClose();
  assert.equal((await h.done).status, 'stopped'); assert.equal(f.audio.made.length, 0);
});

test('unconfirmed closure fails UI but retains manager occupancy; finishInput cannot release it', async t => {
  const f = simFixture({ autoClose: false }); t.after(() => f.close()); await f.running();
  const result = await f.engine.stop();
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'TIMEOUT');
  assert.equal(f.manager.occupied, true);
  assert.throws(() => f.start(), { code: 'SESSION_LIMIT' });
  assert.equal(f.sockets[0].sent.some(v => v.realtimeInput?.audioStreamEnd), false);
  f.sockets[0].finishClose(); await tick(); assert.equal(f.manager.occupied, false);
});

test('missing credentials preserve routing failure before any budget charge', async t => {
  const f = simFixture(); t.after(() => f.close());
  f.config.keyStore.deleteKey('gemini', 'personal');
  const h = f.start(); await tick(); f.frame();
  assert.equal((await h.done).errorCode, 'CREDENTIAL_REQUIRED');
  assert.equal(f.sockets.length, 0); assert.equal(f.track.stops, 1);
});

test('registered model fallback and goAway share three additional connections', async t => {
  const f = simFixture(); t.after(() => f.close());
  const h = f.start(); await tick(); f.frame(); await tick();
  assert.deepEqual([f.engine.snapshot().route, f.engine.snapshot().fallback], ['translation', false]);
  f.sockets[0].open();
  assert.equal(f.sockets[0].sent[0].setup.model, `models/${DEFAULT_LIVE_MODEL}`);
  f.sockets[0].json({ error: { code: 404, details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_NOT_SUPPORTED' },
  ] } }); await tick();
  await advanceInput(f, 1125);
  assert.equal(f.sockets.length, 2);
  await f.open(); await h.ready;
  assert.match(f.sockets[1].sent[0].setup.model, /gemini-3.1-flash-live-preview/);
  // The switch to the auxiliary model is visible, never silent.
  assert.deepEqual([f.engine.snapshot().model, f.engine.snapshot().route, f.engine.snapshot().fallback], [FLASH, 'flash', true]);
  for (const delay of [2250, 4500]) {
    f.sockets.at(-1).json({ goAway: { timeLeft: '10s' } }); await tick();
    await advanceInput(f, delay); await f.open();
  }
  assert.equal(f.sockets.length, 4);
  // Every reopened flash session carries the current interpreter-only rules, built fresh each time.
  const rules = buildLiveSetup({ model: FLASH, targetLanguage: 'ko' }).systemInstruction;
  for (const socket of f.sockets.slice(1)) {
    assert.deepEqual(socket.sent[0].setup.systemInstruction, rules);
    assert.match(socket.sent[0].setup.systemInstruction.parts[0].text, /NOT an assistant[\s\S]*never answer questions/);
    assert.equal(socket.sent[0].setup.generationConfig.translationConfig, undefined);
  }
  assert.equal(f.sockets[0].sent[0].setup.systemInstruction, undefined);
  f.sockets.at(-1).json({ goAway: { timeLeft: '10s' } });
  assert.equal((await h.done).errorCode, 'BUDGET_EXHAUSTED');
  assert.equal(f.sockets.length, 4); assert.deepEqual(f.calls, ['live', 'live', 'live', 'live']);
  assert.deepEqual([f.engine.snapshot().model, f.engine.snapshot().fallback], [FLASH, true]);
});

test('translation-only model is the default and corrupted selections recover to it', async t => {
  const f = simFixture(); t.after(() => f.close());
  assert.equal(LIVE_MODELS[0], DEFAULT_LIVE_MODEL);
  assert.equal(buildLiveSetup({ targetLanguage: 'ja' }).generationConfig.translationConfig.targetLanguageCode, 'ja');
  assert.deepEqual([f.engine.model, f.engine.defaultModel, f.engine.snapshot().defaultModel], [DEFAULT_LIVE_MODEL, DEFAULT_LIVE_MODEL, DEFAULT_LIVE_MODEL]);
  await assert.rejects(f.engine.setModel('gemini-3.1-flash-live-preview-corrupted'), { code: 'MODEL_UNSUPPORTED' });
  assert.equal(await f.engine.restoreModel({ model: 'SECRET' }), DEFAULT_LIVE_MODEL);
  assert.equal(await f.engine.restoreModel(FLASH), FLASH); assert.equal(f.engine.model, FLASH);
  assert.equal(await f.engine.restoreModel(null), DEFAULT_LIVE_MODEL); assert.equal(f.engine.model, DEFAULT_LIVE_MODEL);
  await f.running({ model: 'models/evil; DROP' });
  assert.equal(f.sockets[0].sent[0].setup.model, `models/${DEFAULT_LIVE_MODEL}`);
  assert.deepEqual([f.engine.snapshot().model, f.engine.snapshot().route, f.engine.snapshot().fallback], [DEFAULT_LIVE_MODEL, 'translation', false]);
  assert.doesNotMatch(JSON.stringify(f.engine.snapshot()), /evil|SECRET/);
  await f.engine.stop();
  // Explicit selection of a flash model is a route, not a fallback.
  f.track.readyState = 'live'; f.platform.createAudioContext().state = 'running';
  await f.engine.setModel(FLASH); await f.running();
  assert.deepEqual([f.engine.snapshot().model, f.engine.snapshot().route, f.engine.snapshot().fallback], [FLASH, 'flash', false]);
});

test('flash route discards the rest of a turn once a reply is detected; translation route never filters', async t => {
  const f = simFixture(); t.after(() => f.close());
  await f.running({ model: FLASH, targetLanguage: 'en' });
  const s = f.sockets[0];
  content(s, { inputTranscription: { text: '도와줄 수 있어' }, ...audioContent }); await tick();
  assert.equal(f.audio.made.length, 1);
  content(s, { outputTranscription: { text: 'Sure, I can help you with that' } }); await tick();
  const snap = f.engine.snapshot();
  assert.equal(snap.metrics.repliesSkipped, 1);
  assert.equal(snap.skippedSegments.length, 1);
  assert.ok(f.audio.made[0].stopped);
  const row = snap.captions.captions.find(c => c.role === 'translation');
  assert.equal(row.status, 'interrupted'); assert.equal(row.segmentId, snap.skippedSegments[0]);
  assert.equal(snap.captions.gaps.audio, false);
  assert.equal(snap.captions.captions.find(c => c.role === 'source').status, 'partial');
  // Later audio and captions of the same turn are dropped; source captions continue.
  const hundredMs = { modelTurn: { parts: [{ inlineData: { data: btoa('\0'.repeat(4800)), mimeType: 'audio/pcm;rate=24000' } }] } };
  content(s, { ...hundredMs, outputTranscription: { text: ' What would you like to know?', finished: true },
    inputTranscription: { text: ' 응', finished: true } }); await tick();
  assert.equal(f.audio.made.length, 1);
  assert.equal(f.engine.snapshot().metrics.droppedAudioMs, 100);
  assert.equal(f.engine.snapshot().captions.captions.filter(c => c.role === 'translation').length, 1);
  assert.equal(f.engine.snapshot().captions.captions.find(c => c.role === 'source').status, 'final');
  content(s, { turnComplete: true }); await tick();
  content(s, { outputTranscription: { text: 'Good morning, everyone.', finished: true }, ...audioContent }); await tick();
  assert.equal(f.audio.made.length, 2);
  const next = f.engine.snapshot().captions.captions.at(-1);
  assert.deepEqual([next.translatedText, next.status], ['Good morning, everyone.', 'final']);
  assert.equal(f.engine.snapshot().skippedSegments.length, 1);
  // A speaker's question stays a question; a foreign-script fragment is only judged when finished.
  content(s, { outputTranscription: { text: 'Can you help me?', finished: true }, turnComplete: true }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).status, 'final');
  content(s, { outputTranscription: { text: '오늘 여러분 모두 환영합니다' } }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).status, 'partial');
  content(s, { outputTranscription: { finished: true } }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).status, 'interrupted');
  assert.equal(f.engine.snapshot().metrics.repliesSkipped, 2);
  content(s, { turnComplete: true }); await tick();
  await f.engine.stop();
  assert.equal(f.engine.snapshot().skippedSegments.length, 2);
  // Translation-only route: translationConfig prevents replies structurally, so nothing is filtered.
  f.track.readyState = 'live'; f.platform.createAudioContext().state = 'running';
  await f.running({ targetLanguage: 'en' });
  assert.equal(f.engine.snapshot().skippedSegments.length, 0);
  content(f.sockets[1], { outputTranscription: { text: 'Sure, I can help you with that', finished: true }, ...audioContent }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).status, 'final');
  assert.equal(f.engine.snapshot().metrics.repliesSkipped, 0);
  assert.equal(f.audio.made.at(-1).stopped, false);
});

test('remote close recovers; stop during retry wait cancels every future open', async t => {
  const f = simFixture(); t.after(() => f.close()); await f.running();
  f.sockets[0].finishClose(1006); await tick();
  assert.equal(f.engine.snapshot().status, 'reconnecting');
  await advanceInput(f, 1125); await f.open();
  assert.equal(f.engine.snapshot().status, 'running');
  f.sockets[1].finishClose(1006); await tick();
  await f.engine.stop(); f.audio.advance(10000); await tick();
  assert.equal(f.sockets.length, 2); assert.equal(f.audio.timers.size, 0);
});

test('late Blob decoding after stop never schedules PCM or publishes captions', async t => {
  const f = simFixture(); t.after(() => f.close()); await f.running();
  const gate = deferred();
  f.sockets[0].message(new DelayedBlob(JSON.stringify({ serverContent: {
    ...audioContent, outputTranscription: { text: 'late', finished: true } } }), gate));
  await tick(); await f.engine.stop(); gate.resolve(); await tick();
  assert.equal(f.audio.made.length, 0); assert.equal(f.engine.snapshot().captions.captions.length, 0);
});

test('audio catch-up uses provider completion, not subtitle finals, and interruption cuts tails', async t => {
  const f = simFixture(); t.after(() => f.close()); await f.running();
  const s = f.sockets[0];
  const data = btoa('\0'.repeat(4 * 48000));
  const long = { modelTurn: { parts: [{ inlineData: { data, mimeType: 'audio/pcm;rate=24000' } }] } };
  content(s, long); await tick(); assert.equal(f.engine.snapshot().output, 'delayed');
  content(s, long); await tick(); assert.equal(f.engine.snapshot().output, 'catching-up');
  content(s, { outputTranscription: { text: 'final caption', finished: true } }); await tick();
  assert.equal(f.engine.snapshot().output, 'catching-up');
  assert.equal(f.engine.snapshot().captions.gaps.audio, true);
  assert.equal(f.engine.snapshot().captions.gaps.reception, false);
  content(s, { turnComplete: true }); await tick(); assert.equal(f.engine.snapshot().output, 'ready');
  content(s, { ...audioContent, outputTranscription: { text: 'tail' } }); await tick();
  content(s, { interrupted: true, turnComplete: true }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).status, 'interrupted');
  assert.ok(f.audio.made.every(s => s.stopped));
});

test('external abort and explicit restart use fresh generations and recovery budget', async t => {
  const f = simFixture(); t.after(() => f.close());
  const controller = new AbortController();
  const h = f.start({}, { signal: controller.signal }); await tick(); f.frame(); await tick(); await f.open(); await h.ready;
  const generation = f.engine.snapshot().generation;
  controller.abort('SECRET'); assert.equal((await h.done).status, 'stopped');
  f.track.readyState = 'live'; f.platform.createAudioContext().state = 'running';
  const next = await f.running({ muted: true });
  assert.ok(f.engine.snapshot().generation > generation);
  assert.equal(f.engine.snapshot().retries, 0); assert.equal(f.engine.snapshot().output, 'muted');
  content(f.sockets.at(-1), audioContent); await tick(); assert.equal(f.audio.made.length, 0);
  await f.engine.stop(); assert.equal((await next.done).status, 'stopped');
});


test('model selection closes current Live and only explicit restart opens the selected model', async t => {
  const f = simFixture(); t.after(() => f.close()); await f.running();
  await f.engine.setModel('gemini-3.1-flash-live-preview');
  assert.equal(f.engine.snapshot().busy, false); assert.equal(f.sockets.length, 1);
  f.track.readyState = 'live'; f.platform.createAudioContext().state = 'running';
  await f.running();
  assert.equal(f.sockets[1].sent[0].setup.model, 'models/gemini-3.1-flash-live-preview');
  f.frame(0); f.audio.advance(500); await tick(); f.frame(0); await tick();
  assert.equal(f.sockets[1].sent.some(v => v.realtimeInput?.audioStreamEnd || v.realtimeInput?.activityEnd), false);
});
