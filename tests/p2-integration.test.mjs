import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scenario, holdClose, live, until, tick, caption } from './fixtures/p2-scenarios.mjs';
import { fakeWorker } from './fixtures/scenarios.mjs';

const ko = JSON.parse(await readFile(new URL('../app/i18n/ko.json', import.meta.url), 'utf8'));

// Exercise main.js ownership callbacks with real P1/P2 engines and adapters.
test('sequential voice → direct → hub TTS → sequential confirms every socket close and cancels old playback', async t => {
  const b = await scenario(t);
  const turn = b.app.engine.submitText('사과 12개');
  await until(() => b.sockets.length === 1);
  const voice = b.sockets[0]; live.ready(voice);
  await until(() => voice.sent.length === 2);
  voice.json(live.chunk()); await until(() => b.audio.scheduled === 1);
  const { ws: direct } = await b.direct();
  await turn.done;
  assert.equal(voice.readyState, 3);
  assert.ok(b.sources[0].stopped);
  direct.json(live.chunk()); await until(() => b.audio.scheduled === 2);
  const { ws: hub } = await b.hub();
  assert.equal(direct.readyState, 3);
  assert.ok(b.sources.every(source => source.stopped));
  assert.ok(b.microphone.streams.every(stream => stream.stopped));
  b.synth.mode = 'hold';
  hub.json(caption({ final: true })); await tick();
  assert.equal(b.speech.utterances.length, 0, 'recent captions remain silent');
  b.app.listenEngines.hub.setMuted(false);
  hub.json(caption({ segmentId: 'new', seq: 2, final: true }));
  await until(() => b.speech.utterances.length === 1);
  hub.json(caption({ segmentId: 'new', seq: 3, revision: 2, final: true, text: '修正。' }));
  hub.json(caption({ segmentId: 'queued', seq: 4, final: true }));
  await tick();
  const oldSpeech = b.synth.pending;
  await b.app.shell.switchTab('sequential');
  const scheduled = b.audio.scheduled, spoken = b.speech.utterances.length;
  oldSpeech.onend?.(); direct.json(live.chunk()); hub.json(caption({ segmentId: 'late', seq: 5, final: true }));
  await tick();
  assert.equal(b.audio.scheduled - scheduled, 0);
  assert.equal(b.speech.utterances.length - spoken, 0);
  assert.equal(spoken, 1, 'no automatic revision or queued replay');
  b.app.engine.setVoice({ output: 'off' });
  assert.equal((await b.app.engine.submitText('사과 12개').done).phase, 'completed');
  assert.equal(b.socketPeak, 1);
  assert.equal(b.app.config.sessionManager.occupied, false);
});

for (const [name, event] of [
  ['goAway', ws => ws.json({ goAway: { timeLeft: '10s' } })],
  ['503', ws => ws.json(live.error(503))],
  ['disconnect', ws => ws.finishClose(1006)],
]) test(`${name}: recovery waits for physical close, keeps busy, and sends only new microphone input`, async t => {
  const waiting = fakeWorker('p2-next');
  const b = await scenario(t, { controller: fakeWorker('p2-old'), waiting });
  const { ws } = await b.direct();
  ws.json(live.transcript('unfinished'));
  await until(() => b.app.listenEngines.direct.snapshot().captions.captions.length === 1);
  if (name !== 'disconnect') holdClose(ws); event(ws);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'reconnecting');
  assert.throws(() => b.app.diagnostics.run('voice'), { code: 'INVALID_REQUEST' });
  assert.throws(() => b.app.engine.submitText('busy'), { code: 'INVALID_REQUEST' });
  await b.app.pwa.applyUpdate(); assert.equal(waiting.calls.skipWaiting, 0);
  if (name !== 'disconnect') {
    await until(() => ws.closeCalls > 0);
    assert.equal(b.sockets.length, 1);
    ws.finishClose();
  }
  await until(() => b.clock.pending.some(ms => ms >= 1000 && ms <= 1250));
  // Small increments keep the real capture watchdog alive during backoff.
  for (let i = 0; i < 15 && b.sockets.length === 1; i++) {
    b.microphone.feed(new Float32Array(4096).fill(0.1));
    b.clock.advance(100); await tick();
  }
  await until(() => b.sockets.length === 2);
  const next = b.sockets[1]; live.ready(next);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'running');
  assert.equal(next.sent.length, 1, 'only setup, no replay of buffered input');
  b.microphone.feed(new Float32Array(4096).fill(0.2)); b.clock.advance(0);
  await until(() => next.sent.length > 1);
  assert.ok(next.sent.slice(1).every(frame => frame.realtimeInput?.audio));
  assert.equal(b.app.listenEngines.direct.snapshot().captions.captions[0].status, 'interrupted');
  assert.equal(b.socketPeak, 1);
  await b.app.stopWork();
});

test('unclassified 429 terminates without model cycling or automatic REST fallback', async t => {
  const b = await scenario(t); const { handle, ws } = await b.direct();
  ws.json(live.error(429, 'RESOURCE_EXHAUSTED'));
  assert.equal((await handle.done).errorCode, 'UNKNOWN_429');
  await until(() => !b.app.activity.occupied);
  b.clock.advance(30000); await tick();
  assert.equal(b.sockets.length, 1); assert.equal(b.gemini.calls.length, 0);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'failed');
});

test('PCM overflow skips audio until a provider turn boundary; subtitles survive and cancellation schedules nothing', async t => {
  const b = await scenario(t); const { ws } = await b.direct();
  ws.json(live.chunk(192000)); await until(() => b.audio.scheduled === 1);
  ws.json(live.chunk(240000));
  await until(() => b.app.listenEngines.direct.snapshot().output === 'catching-up');
  assert.ok(b.sources.every(source => source.stopped));
  ws.json({ serverContent: { outputTranscription: { text: '字幕。', finished: true } } });
  await until(() => b.app.listenEngines.direct.snapshot().captions.captions.length > 0);
  ws.json(live.chunk()); await tick(); assert.equal(b.audio.scheduled, 1);
  ws.json(live.complete()); ws.json(live.chunk());
  await until(() => b.audio.scheduled === 2);
  await b.app.stopWork(); ws.json(live.chunk()); await tick();
  assert.equal(b.audio.scheduled, 2);
  assert.ok(b.sources.every(source => source.stopped));
});

test('key deletion racing an update keeps cleanup busy until physical closure and rejects late audio', async t => {
  const waiting = fakeWorker('p2-next');
  const b = await scenario(t, { controller: fakeWorker('p2-old'), waiting });
  const { ws, handle } = await b.direct(); holdClose(ws);
  b.app.config.keyStore.deleteKey('gemini', 'personal');
  await until(() => ws.closeCalls > 0);
  await b.app.pwa.applyUpdate(); b.container.dispatch('controllerchange');
  assert.equal(waiting.calls.skipWaiting, 0); assert.equal(b.win.location.reloads, 0);
  assert.throws(() => b.app.listenEngines.hub.join({}), { code: 'SESSION_LIMIT' });
  ws.json(live.chunk()); await tick(); assert.equal(b.audio.scheduled, 0);
  ws.finishClose(); await handle.done;
  await until(() => !b.app.activity.occupied && b.win.location.reloads === 1);
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal'), null);
  assert.equal(b.sockets.length, 1);
});

// P3-02e: a per-minute 429 no longer schedules a server-delay reconnect. The
// operation ends with its own code and text; only the user reopens the session.
test('classified minute quota ends the session with RATE_LIMITED: no automatic reopen, no pending reconnect timer', async t => {
  const b = await scenario(t); const { handle, ws } = await b.direct();
  ws.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9s' },
  ] } });
  const result = await handle.done;
  assert.equal(result.errorCode, 'RATE_LIMITED');
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'failed');
  assert.equal(b.clock.pending.includes(9000), false, 'the server delay is not turned into a reconnect');
  assert.ok(b.microphone.streams.every(stream => stream.stopped), 'capture ended with the session');
  b.clock.advance(30000); await tick();
  assert.equal(b.sockets.length, 1, 'quota errors never reopen automatically');
  await until(() => !b.app.activity.occupied);
  assert.equal(b.audio.scheduled, 0);
  assert.equal(b.el('sim-notice').textContent, ko['sim.error.RATE_LIMITED']);
  assert.equal(b.el('sim-start').textContent, ko['sim.reopen'], 'the primary action offers a manual reopen');
});

test('hub reconnect restores captions silently and never rereads an already spoken revision', async t => {
  const b = await scenario(t, { personal: false }); const { ws } = await b.hub();
  b.app.listenEngines.hub.setMuted(false);
  ws.json(caption({ final: true })); await until(() => b.speech.utterances.length === 1);
  ws.finishClose(1006);
  await until(() => b.app.listenEngines.hub.snapshot().status === 'reconnecting');
  assert.equal(b.app.listenEngines.hub.snapshot().output, 'muted');
  await until(() => b.clock.pending.length > 0);
  b.clock.advance(1500); await until(() => b.sockets.length === 2);
  const next = b.sockets[1]; next.open();
  next.json({ type: 'hello', sessionId: 'reconnected', settings: { allowedLangs: ['ja'] } });
  await until(() => b.app.listenEngines.hub.snapshot().status === 'running');
  next.json(caption({ final: true })); await tick();
  assert.equal(b.speech.utterances.length, 1);
  b.app.listenEngines.hub.setMuted(false);
  next.json(caption({ seq: 2, revision: 2, final: true, text: '修正。' }));
  next.json(caption({ segmentId: 'fresh', seq: 3, final: true }));
  await until(() => b.speech.utterances.length === 2);
  await tick(); assert.equal(b.speech.utterances.length, 2);
  next.json({ type: 'cast.stopped' });
  await until(() => !b.app.activity.occupied);
  b.clock.advance(30000); await tick();
  assert.equal(b.sockets.length, 2); assert.equal(b.socketPeak, 1);
  assert.equal(b.microphone.streams.length + b.gemini.calls.length, 0);
});

// Keep the fail-closed global-slot case last; process isolation releases the poisoned owner.
test('unconfirmed close timeout retains the global lease and blocks updates and replacement', async t => {
  const waiting = fakeWorker('p2-next');
  const b = await scenario(t, { controller: fakeWorker('p2-old'), waiting });
  const { ws, handle } = await b.direct(); holdClose(ws);
  const stopped = b.app.stopWork().catch(error => error);
  await until(() => ws.closeCalls > 0);
  b.clock.advance(10000); await tick();
  await stopped; assert.equal((await handle.done).status, 'failed');
  assert.equal(b.app.config.sessionManager.occupied, true);
  await b.app.pwa.applyUpdate(); assert.equal(waiting.calls.skipWaiting, 0);
  assert.throws(() => b.app.listenEngines.direct.start({ targetLanguage: 'ja' }), { code: 'SESSION_LIMIT' });
  assert.equal(b.sockets.length, 1);
  ws.finishClose();
});

