import test from 'node:test';
import assert from 'node:assert/strict';
import { simFixture, content, audioContent, deferred, tick } from './fixtures/sim.mjs';
import { DelayedBlob } from './fixtures/live.mjs';

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
  f.sockets[0].open();
  f.sockets[0].json({ error: { code: 404, details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_NOT_SUPPORTED' },
  ] } }); await tick();
  await advanceInput(f, 1125);
  assert.equal(f.sockets.length, 2);
  await f.open(); await h.ready;
  assert.match(f.sockets[1].sent[0].setup.model, /gemini-3.1-flash-live-preview/);
  for (const delay of [2250, 4500]) {
    f.sockets.at(-1).json({ goAway: { timeLeft: '10s' } }); await tick();
    await advanceInput(f, delay); await f.open();
  }
  assert.equal(f.sockets.length, 4);
  f.sockets.at(-1).json({ goAway: { timeLeft: '10s' } });
  assert.equal((await h.done).errorCode, 'BUDGET_EXHAUSTED');
  assert.equal(f.sockets.length, 4); assert.deepEqual(f.calls, ['live', 'live', 'live', 'live']);
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
