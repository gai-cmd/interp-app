// 2026-09-30 (owner approval, "진행해"): the ~10-minute goAway uses the key
// swap's seamless bridge, plus session resumption, low-trigger context window
// compression and usageMetadata. Fake sockets, fake audio and fake timers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { simFixture, content, audioContent, tick } from './fixtures/sim.mjs';
import { createSocketFixture, createClock } from './fixtures/live.mjs';
import { provider, adapter, context, credentialRef } from './fixtures/providers.mjs';
import { createGeminiLiveClient } from '../app/providers/gemini/live-client.js';
import { buildLiveSetup, LIVE_MODELS, TRANSLATE_LIVE_MODEL, LIVE_COMPRESSION_TRIGGER_TOKENS,
  LIVE_COMPRESSION_TARGET_TOKENS } from '../app/providers/gemini/live-config.js';
import { QUIET_MS, HANDOVER_MARGIN_MS, MIN_HANDOVER_AGE_MS, PREROLL_FRAMES, HANDLE_GRACE_MS } from '../app/engine/sim.js';
import { UPLINK_LIMITS } from '../app/audio/uplink-queue.js';
import { createListenMetrics } from '../app/engine/listen-metrics.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { ProviderError } from '../app/providers/contract.js';

const NATIVE = LIVE_MODELS[2];
const isAudio = (message) => Boolean(message.realtimeInput?.audio);
// The middle sample of each PCM frame a socket carried, as a float.
const sentLevels = (socket) => socket.sent.filter(isAudio).map((message) => {
  const bytes = Uint8Array.from(atob(message.realtimeInput.audio.data), (char) => char.charCodeAt(0));
  return new DataView(bytes.buffer).getInt16(512, true) / 32767;
});
// The setup a socket sent (sockets send it on open, before setupComplete).
const setupOf = (socket) => { if (socket.readyState === 0) socket.open(); return socket.sent[0].setup; };
const resumable = (socket, handle) => socket.json({ sessionResumptionUpdate: { newHandle: handle, resumable: true } });
const poolKeys = (count = 2) => Array.from({ length: count }, (_, index) => ['synthetic', 'handover', String(index + 1)].join('-'));
async function until(condition, limit = 300) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}
// Fake time with speech: the capture watchdog (2 s) needs frames to keep going,
// and each chunk's two 32 ms frames are paced out before time jumps ahead (a
// frame left waiting across a long jump would go stale and count as a gap).
async function speak(f, ms, step = 1500) {
  while (ms > 0) {
    const next = Math.min(ms, step);
    f.frame();
    for (let spent = 0; spent < next;) {
      const hop = spent < 80 ? Math.min(40, next - spent) : next - spent;
      f.audio.advance(hop); await tick(); spent += hop;
    }
    ms -= next;
  }
}
// One chunk (two 32 ms frames) spoken at `level`, paced over 64 ms of fake time.
async function chunk(f, level) {
  f.frame(level);
  for (let i = 0; i < 8; i++) { f.audio.advance(8); await tick(); }
}
// The sim fixture with a router that also records each request and the
// operation's shared replacement budget.
function handoverFixture({ engine = {}, ...options } = {}) {
  const seen = [];
  let f;
  const router = { call(capability, request, ctx) {
    seen.push({ request, budget: ctx.budget });
    return f.config.router.call(capability, request, ctx);
  } };
  f = simFixture({ ...options, engine: { router, ...engine } });
  return Object.assign(f, { seen, budget: () => seen.at(-1).budget });
}
// A running session whose first connection is old enough for a free handover.
async function aged(options) {
  const f = handoverFixture(options);
  const handle = await f.running();
  await speak(f, MIN_HANDOVER_AGE_MS + 1000);
  return Object.assign(f, { handle });
}

test('goAway then a turn boundary: the old socket closes only at the boundary, the next opens with no backoff and no budget, the player plays on', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  content(s0, { outputTranscription: { text: 'before' }, ...audioContent }); await tick();
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  const retiring = f.engine.snapshot();
  assert.deepEqual([retiring.status, retiring.reconnectReason], ['running', null], 'nothing visible changes while retiring');
  content(s0, { outputTranscription: { text: ' after' }, ...audioContent }); await tick();
  assert.equal(f.audio.made.length, 2, 'audio sent after goAway reaches the player');
  assert.equal(f.engine.snapshot().captions.captions.at(-1).translatedText, 'before after', 'and its caption');
  assert.equal(s0.closeCalls, 0, 'the retiring socket is kept until the boundary');
  assert.equal(f.sockets.length, 1);
  // The boundary; its usage report still counts although the handover starts on it.
  s0.json({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 7000, totalTokenCount: 7100 } });
  // No fake time passes: a backoff timer could never fire, so a new socket proves there is none.
  await until(() => f.sockets.length === 2);
  assert.equal(s0.closeCalls, 1, 'closed at the boundary');
  const handingOver = f.engine.snapshot();
  assert.deepEqual([handingOver.status, handingOver.reconnectReason, handingOver.busy], ['reconnecting', 'handover', true]);
  await f.open();
  const running = f.engine.snapshot();
  assert.deepEqual([running.status, running.reconnectReason, running.retries], ['running', null, 0]);
  assert.deepEqual([running.metrics.handovers, running.metrics.reconnects], [1, 0], 'a handover is not a reconnect');
  assert.deepEqual([running.metrics.usageReports, running.metrics.promptTokensLast], [1, 7000]);
  assert.deepEqual([f.budget().used, f.budget().remaining], [1, 3], 'the replacement budget is untouched');
  assert.equal(f.budget(), f.seen[0].budget, 'one budget per operation');
  assert.ok(f.audio.made.every((source) => !source.stopped), 'the player was never cancelled');
  // A clean boundary: every caption final, no reception gap, no gap mark on what follows.
  const captions = running.captions;
  assert.ok(captions.captions.every((row) => row.status === 'final'));
  assert.equal(captions.gaps.reception, false);
  content(f.sockets[1], { outputTranscription: { text: 'next', finished: true }, ...audioContent }); await tick();
  const next = f.engine.snapshot().captions.captions.at(-1);
  assert.deepEqual([next.translatedText, next.gapBefore], ['next', false]);
  assert.equal(f.audio.made.length, 3, 'the same player takes the new connection audio');
  assert.equal(setupOf(f.sockets[1]).model, setupOf(s0).model, 'same request and model');
  assert.equal(f.track.stops, 0); assert.equal(f.micCalls(), 1);
});

test('goAway then quiet: the handover comes QUIET_MS after the last audio or caption', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  // Microphone input keeps flowing; only the model's audio and captions count.
  await speak(f, 1000);
  content(s0, { inputTranscription: { text: 'still talking' } }); await tick();
  await speak(f, QUIET_MS - 1);
  assert.equal(f.sockets.length, 1, 'the quiet interval restarts at each caption');
  await speak(f, 1); await until(() => f.sockets.length === 2);
  assert.equal(f.engine.snapshot().reconnectReason, 'handover');
  await f.open();
  assert.deepEqual([f.engine.snapshot().metrics.handovers, f.engine.snapshot().retries, f.budget().used], [1, 0, 1]);
});

test('continuous output without a boundary hands over HANDOVER_MARGIN_MS before the advertised end, marking the open turn', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  s0.json({ goAway: { timeLeft: '10s' } }); await tick();
  const deadline = 10000 - HANDOVER_MARGIN_MS;
  for (let at = 0; at < deadline - 1000; at += 1000) {
    content(s0, { outputTranscription: { text: `part ${at} ` }, ...audioContent }); await tick();
    await speak(f, 1000);
  }
  content(s0, { outputTranscription: { text: 'tail' }, ...audioContent }); await tick();
  await speak(f, 999);
  assert.equal(f.sockets.length, 1, 'never before the deadline');
  await speak(f, 1); await until(() => f.sockets.length === 2);
  const snap = f.engine.snapshot();
  assert.equal(snap.reconnectReason, 'handover');
  assert.equal(snap.captions.gaps.reception, true, 'a turn was open: a possible gap');
  assert.equal(snap.captions.captions.at(-1).status, 'interrupted');
  await f.open();
  content(f.sockets[1], { outputTranscription: { text: 'resumed', finished: true } }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).gapBefore, true);
  assert.deepEqual([f.engine.snapshot().metrics.handovers, f.budget().used, f.engine.snapshot().retries], [1, 1, 0]);
});

test('input keeps flowing to the retiring socket; then the pre-roll and the held frames go first on the next, in order', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  const before = s0.sent.filter(isAudio).length;
  for (let i = 0; i < 20; i++) await chunk(f, 0.3 + i * 0.005);
  assert.equal(s0.sent.filter(isAudio).length - before, 40, 'every frame spoken after goAway reached the old socket');
  content(s0, { turnComplete: true });
  // Speech while the next connection sets up is held (ten 64 ms chunks).
  for (let i = 0; i < 10; i++) { f.frame(0.5 + i * 0.01); f.audio.advance(64); }
  await until(() => f.sockets.length === 2);
  const s1 = f.sockets[1];
  await f.open(s1);
  for (let i = 0; i < 80 && s1.sent.filter(isAudio).length < PREROLL_FRAMES + 20; i++) { f.audio.advance(8); await tick(); }
  const old = sentLevels(s0), next = sentLevels(s1);
  assert.equal(next.length, PREROLL_FRAMES + 20);
  assert.deepEqual(next.slice(0, PREROLL_FRAMES), old.slice(-PREROLL_FRAMES), 'the last ~1 s sent to the old socket goes first');
  assert.ok(Math.abs(next[PREROLL_FRAMES] - 0.5) < 0.005, `then the held speech (${next[PREROLL_FRAMES]})`);
  for (let i = PREROLL_FRAMES + 1; i < next.length; i++) assert.ok(next[i] >= next[i - 1] - 0.005, 'in speaking order');
});

test('the held input is bounded to the uplink backlog: the oldest (pre-roll first) is dropped', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  content(s0, { turnComplete: true });
  // 110 frames held on top of the 31-frame pre-roll: 16 over the bound.
  // (The input gap flag itself is already set at the start of every session by
  // the discarded preparation frame, so what arrives is the evidence here.)
  for (let i = 0; i < 55; i++) { f.frame(0.4 + i * 0.001); f.audio.advance(64); }
  await until(() => f.sockets.length === 2);
  await f.open();
  for (let i = 0; i < 300 && f.sockets[1].sent.filter(isAudio).length < UPLINK_LIMITS.backlogFrames; i++) { f.audio.advance(8); await tick(); }
  f.audio.advance(200); await tick();
  const next = sentLevels(f.sockets[1]);
  assert.equal(next.length, UPLINK_LIMITS.backlogFrames);
  assert.deepEqual(next.slice(0, PREROLL_FRAMES - 16), sentLevels(s0).slice(-(PREROLL_FRAMES - 16)));
});

test('the transport backstop (UNAVAILABLE at timeLeft) and a dropped socket on a retiring connection are free handovers', async t => {
  const f = await aged(); t.after(() => f.close());
  // The live client's backstop runs on the app's real timers here; the
  // engine's own deadline is on fake time, which does not move.
  f.sockets[0].json({ goAway: { timeLeft: '0.001s' } }); await tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await until(() => f.sockets.length === 2);
  assert.equal(f.engine.snapshot().reconnectReason, 'handover');
  await f.open();
  await speak(f, MIN_HANDOVER_AGE_MS + 1000);
  f.sockets[1].json({ goAway: { timeLeft: '50s' } }); await tick();
  f.sockets[1].finishClose(1006);
  await until(() => f.sockets.length === 3);
  await f.open();
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.retries, snap.metrics.handovers, snap.metrics.reconnects, f.budget().used],
    ['running', 0, 2, 0, 1]);
});

test('a quota close on a retiring connection is not a handover: it ends the operation as before', async t => {
  const f = await aged(); t.after(() => f.close());
  f.sockets[0].json({ goAway: { timeLeft: '50s' } }); await tick();
  f.sockets[0].json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET quota' } });
  const result = await f.handle.done;
  assert.deepEqual([result.status, result.errorCode, f.sockets.length], ['failed', 'UNKNOWN_429', 1]);
  assert.equal(f.engine.snapshot().metrics.handovers, 0);
});

test('runaway guard: goAway on a connection younger than a minute takes the budgeted path, carrying the resumption handle', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running();
  await speak(f, 30000);
  resumable(f.sockets[0], 'young-handle'); await tick();
  f.sockets[0].json({ goAway: { timeLeft: '50s' } }); await tick();
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.reconnectReason], ['reconnecting', null]);
  await speak(f, 1000, 500);
  assert.equal(f.sockets.length, 1, 'the backoff applies');
  await speak(f, 125, 125);
  assert.equal(f.sockets.length, 2);
  await f.open();
  const after = f.engine.snapshot();
  assert.deepEqual([after.retries, after.metrics.reconnects, after.metrics.handovers, f.budget().used], [1, 1, 0, 2]);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, { handle: 'young-handle' });
});

test('seven goAways over 70 fake minutes never end the operation and never consume the replacement budget', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  const h = await f.running();
  for (let i = 0; i < 7; i++) {
    await speak(f, 10 * 60000);
    const s = f.sockets.at(-1);
    resumable(s, `handle-${i}`);
    s.json({ goAway: { timeLeft: '50s' } }); await tick();
    content(s, { outputTranscription: { text: `turn ${i}`, finished: true }, ...audioContent, turnComplete: true });
    await until(() => f.sockets.length === i + 2);
    await f.open();
    assert.deepEqual(setupOf(f.sockets.at(-1)).sessionResumption, { handle: `handle-${i}` });
  }
  await speak(f, 3000);
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.busy, snap.retries, snap.errorCode], ['running', true, 0, null]);
  assert.deepEqual([snap.metrics.handovers, snap.metrics.reconnects, f.budget().used], [7, 0, 1]);
  assert.equal(f.sockets.length, 8);
  assert.equal((await f.engine.stop()).status, 'stopped');
  assert.equal((await h.done).status, 'stopped');
});

test('fake-time gap from the turn boundary to the first uplink frame on the new socket is under 100 ms when setup answers at once', async t => {
  const f = await aged(); t.after(() => f.close());
  const now = f.audio.options.now;
  f.sockets[0].json({ goAway: { timeLeft: '50s' } }); await tick();
  const boundaryAt = now();
  content(f.sockets[0], { turnComplete: true });
  let firstAt = null;
  for (let step = 0; step < 250 && firstAt === null; step++) {
    const next = f.sockets[1];
    if (next && next.readyState === 0) { next.open(); next.json({ setupComplete: {} }); }
    if (step % 8 === 0) f.frame(0.2);
    await tick();
    if (next?.sent.some(isAudio)) firstAt = now();
    else f.audio.advance(8);
  }
  assert.notEqual(firstAt, null, 'speech reached the new connection');
  t.diagnostic(`turn boundary -> first uplink frame on the new socket: ${firstAt - boundaryAt} ms of fake time`);
  assert.ok(firstAt - boundaryAt < 100, `gap ${firstAt - boundaryAt} ms of fake time`);
});

test('setups: the instruction-driven routes carry low-trigger compression and sessionResumption; the translate route carries neither', () => {
  assert.deepEqual([LIVE_COMPRESSION_TRIGGER_TOKENS, LIVE_COMPRESSION_TARGET_TOKENS], [12000, 6000]);
  const compression = { triggerTokens: 12000, slidingWindow: { targetTokens: 6000 } };
  for (const model of ['gemini-3.8-live', NATIVE]) {
    for (const request of [{ targetLanguage: 'ko' }, { targetLanguage: 'ja', languages: ['ko', 'ja'] }]) {
      const fresh = buildLiveSetup({ model, ...request });
      assert.deepEqual(fresh.contextWindowCompression, compression);
      assert.deepEqual(fresh.sessionResumption, {});
      assert.deepEqual(buildLiveSetup({ model, ...request, resumeHandle: 'abc-123' }).sessionResumption, { handle: 'abc-123' });
      assert.throws(() => buildLiveSetup({ model, ...request, resumeHandle: 'bad\nhandle' }), { code: 'INVALID_REQUEST' });
    }
  }
  const translate = buildLiveSetup({ model: TRANSLATE_LIVE_MODEL, targetLanguage: 'ko', resumeHandle: 'abc-123' });
  assert.equal(Object.hasOwn(translate, 'contextWindowCompression'), false);
  assert.equal(Object.hasOwn(translate, 'sessionResumption'), false);
  assert.equal(JSON.stringify(translate).includes('abc-123'), false, 'the translate route ignores a handle');
});

test('the handover setup carries the latest resumable handle; resumable:false and malformed updates keep the last good one', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  assert.deepEqual(setupOf(s0).sessionResumption, {});
  assert.deepEqual(setupOf(s0).contextWindowCompression, { triggerTokens: 12000, slidingWindow: { targetTokens: 6000 } });
  resumable(s0, 'handle-1'); resumable(s0, 'handle-2');
  s0.json({ sessionResumptionUpdate: { newHandle: '', resumable: false } });
  s0.json({ sessionResumptionUpdate: {} });
  s0.json({ sessionResumptionUpdate: { newHandle: 'not-yet', resumable: false } });
  for (const bad of ['text', null, { resumable: 'yes' }, { newHandle: 7, resumable: true }, { newHandle: 'x'.repeat(4097), resumable: true },
    { newHandle: 'tab\there', resumable: true }]) s0.json({ sessionResumptionUpdate: bad });
  await tick();
  assert.deepEqual([f.engine.snapshot().status, s0.closeCalls], ['running', 0], 'malformed updates never close the session');
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  content(s0, { turnComplete: true });
  // The last update said "not resumable", so the boundary first waits for a
  // fresh handle; none comes, and the grace ends with the last good one.
  await speak(f, HANDLE_GRACE_MS - 1, HANDLE_GRACE_MS - 1);
  assert.equal(f.sockets.length, 1, 'the boundary waits for a newer handle');
  await speak(f, 1, 1);
  await until(() => f.sockets.length === 2);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, { handle: 'handle-2' });
});

test('a key swap never carries the handle to the next key', async t => {
  let f;
  f = handoverFixture({ builtin: poolKeys(2),
    engine: { swapCredential: async (error) => f.config.keyStore.rotateBuiltin('gemini', { code: error.code }) !== null } });
  t.after(() => f.close());
  await f.running();
  resumable(f.sockets[0], 'key-one-handle'); await tick();
  f.sockets[0].json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET quota' } });
  await until(() => f.sockets.length === 2);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, {}, 'another project cannot resume it');
  assert.equal(f.seen.at(-1).request.resumeHandle, undefined);
});

test('a model fallback never carries the handle to another model', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running({ targetLanguage: 'ja', sourceLanguage: 'ko', languages: ['ko', 'ja'] });
  resumable(f.sockets[0], 'model-one-handle'); await tick();
  f.sockets[0].json({ error: { code: 503 } }); await tick();
  await speak(f, 1125, 500);
  assert.equal(f.sockets.length, 2);
  assert.equal(setupOf(f.sockets[1]).model, `models/${NATIVE}`);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, {});
});

test('the budgeted reopen after a transport close carries the handle; a resumed setup that fails before ready leaves the next attempt without one', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running();
  resumable(f.sockets[0], 'resume-me'); await tick();
  f.sockets[0].finishClose(1000); await tick();
  await speak(f, 1125, 500);
  assert.equal(f.sockets.length, 2);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, { handle: 'resume-me' });
  // The resumed setup is refused before setupComplete.
  f.sockets[1].finishClose(1000); await tick();
  await speak(f, 2250, 500);
  assert.equal(f.sockets.length, 3);
  assert.deepEqual(setupOf(f.sockets[2]).sessionResumption, {}, 'the next attempt starts fresh');
  assert.equal(setupOf(f.sockets[2]).model, setupOf(f.sockets[0]).model);
});

test('usageMetadata on any message becomes metrics; malformed usage is ignored and never closes the session', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running();
  const s = f.sockets[0];
  content(s, { outputTranscription: { text: 'with usage' } });
  s.json({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 5000, responseTokenCount: 120, totalTokenCount: 5120,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 5000 }] } });
  s.json({ usageMetadata: { promptTokenCount: 3000, totalTokenCount: 3100, cachedContentTokenCount: 0 } });
  for (const bad of ['many', null, [], { promptTokenCount: -1 }, { promptTokenCount: 1.5 }, { totalTokenCount: '9' },
    { promptTokenCount: Number.MAX_SAFE_INTEGER + 2 }, {}]) s.json({ usageMetadata: bad });
  await tick();
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, s.closeCalls], ['running', 0]);
  assert.equal(snap.captions.captions.at(-1).status, 'final', 'the content riding with usage still arrived');
  const m = snap.metrics;
  assert.deepEqual([m.usageReports, m.promptTokensLast, m.promptTokensMax, m.totalTokensSum], [2, 3000, 5000, 8220]);
});

test('listen metrics: usage gauges keep numbers only, the maximum is a maximum, and handovers are their own counter', () => {
  const m = createListenMetrics({ now: () => 0 });
  assert.equal(m.observe('promptTokensMax', 900), true);
  m.observe('promptTokensMax', 300); m.observe('promptTokensLast', 900); m.observe('promptTokensLast', 300);
  m.observe('totalTokensSum', 10); m.observe('totalTokensSum', 5); m.observe('handovers'); m.observe('usageReports');
  assert.equal(m.observe('promptTokensLast', 'SECRET'), false);
  const s = m.snapshot();
  assert.deepEqual([s.promptTokensMax, s.promptTokensLast, s.totalTokensSum, s.handovers, s.usageReports, s.reconnects], [900, 300, 15, 1, 1, 0]);
});

// Transport level: the socket after goAway, and the two new events.
function client() {
  const fixture = createSocketFixture(), clock = createClock(), events = [];
  const controller = new AbortController();
  const ctx = { providerId: 'gemini', transport: 'direct', keySource: 'personal', credentialRef: {},
    signal: controller.signal, generation: 1, turnId: 'turn-1', sessionId: 'session-1', onEvent: (event) => events.push(event) };
  const live = createGeminiLiveClient({ ...fixture, ...clock, resolveCredential: async () => ['synthetic', 'client', 'key'].join('-') });
  return { ...fixture, clock, events, ctx, async ready() {
    const opening = live.open({ setup: { model: 'models/gemini-3.8-live' } }, ctx);
    await tick();
    const ws = fixture.sockets.at(-1); ws.open(); ws.json({ setupComplete: {} });
    return { ws, session: await opening };
  } };
}

test('live client: sends work after goAway until the backstop, which stops with UNAVAILABLE', async () => {
  const h = client(); const { ws, session } = await h.ready();
  ws.json({ goAway: { timeLeft: '30s' } });
  for (let i = 0; i < 3; i++) { h.clock.advance(9000); session.send({ realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } }); }
  assert.equal(ws.sent.filter(isAudio).length, 3);
  h.clock.advance(2999); assert.equal(ws.closeCalls, 0);
  h.clock.advance(1); await session.closed;
  assert.equal(h.events.find((event) => event.type === 'error').error.code, 'UNAVAILABLE');
  assert.throws(() => session.send({ realtimeInput: { audioStreamEnd: true } }), { code: 'SESSION_CLOSED' });
});

test('live client: sessionResumptionUpdate and usageMetadata become bounded events after the message content', async () => {
  const h = client(); const { ws, session } = await h.ready();
  ws.json({ sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
  ws.json({ sessionResumptionUpdate: { resumable: false, newHandle: '' } });
  ws.json({ sessionResumptionUpdate: { resumable: true, newHandle: 'é' } });
  ws.json({ sessionResumptionUpdate: { resumable: 1 } });
  ws.json({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 10, responseTokenCount: 2,
    totalTokenCount: 12, cachedContentTokenCount: 0, thoughtsTokenCount: 0, secret: 'SECRET' } });
  ws.json({ usageMetadata: { promptTokenCount: -1, totalTokenCount: 3 } });
  ws.json({ usageMetadata: {} });
  await tick();
  const seen = h.events.filter((event) => event.type !== 'ready').map(({ turnId, sessionId, generation, ...rest }) => rest);
  assert.deepEqual(seen, [
    { type: 'resumption', handle: 'h-1' }, { type: 'resumption', handle: null }, { type: 'resumption', handle: null },
    { type: 'content', content: { turnComplete: true } },
    { type: 'usage', promptTokens: 10, responseTokens: 2, totalTokens: 12, cachedTokens: 0 },
  ]);
  assert.equal(inspect(h.events).includes('SECRET'), false);
  assert.equal(ws.closeCalls, 0);
  await session.close();
});

test('router: resumption and usage are forwarded with their whitelisted fields only; resumeHandle reaches live and no other capability', async () => {
  const definition = provider();
  definition.capabilities.live.implementation = 'ready';
  const calls = [], implementation = adapter(calls);
  let incoming;
  implementation.live.open = async (request, ctx) => { calls.push({ name: 'live', request }); incoming = ctx; return { async sendAudio() {}, async finishInput() {}, async close() {} }; };
  const registry = createRegistry();
  registry.register(definition, implementation);
  const router = createRouter({ registry, getCredentialRef: credentialRef });
  const events = [];
  const session = await router.call('live', { input: { format: 'pcm16' }, resumeHandle: 'handle-A' }, context({ onEvent: (event) => events.push(event) }));
  assert.equal(calls.at(-1).request.resumeHandle, 'handle-A');
  assert.ok(Object.isFrozen(calls.at(-1).request));
  incoming.onEvent({ type: 'resumption', handle: 'handle-B', raw: 'TEST_SECRET' });
  incoming.onEvent({ type: 'resumption', handle: null });
  incoming.onEvent({ type: 'usage', promptTokens: 1, responseTokens: 2, totalTokens: 3, cachedTokens: 0, detail: 'TEST_SECRET' });
  const ids = { turnId: 'turn-1', sessionId: 'session-1', generation: 1 };
  assert.deepEqual(events, [{ type: 'resumption', handle: 'handle-B', ...ids }, { type: 'resumption', handle: null, ...ids },
    { type: 'usage', promptTokens: 1, responseTokens: 2, totalTokens: 3, cachedTokens: 0, ...ids }]);
  assert.equal(inspect(events).includes('TEST_SECRET'), false);
  await session.close();
  await assert.rejects(router.call('live', { input: { format: 'pcm16' }, resumeHandle: 'bad\u0000' }, context()), { code: 'INVALID_REQUEST' });
  await assert.rejects(router.call('live', { input: { format: 'pcm16' }, resumeHandle: 42 }, context()), { code: 'INVALID_REQUEST' });
  await router.call('live', { input: { format: 'pcm16' }, resumeHandle: null }, context());
  assert.equal(Object.hasOwn(calls.at(-1).request, 'resumeHandle'), false, 'null means none');
  await router.call('voice', { input: { format: 'text' }, resumeHandle: 'handle-A' }, context());
  assert.equal(calls.at(-1).name, 'voice');
  assert.equal(Object.hasOwn(calls.at(-1).request, 'resumeHandle'), false, 'voice never sees it');
});

// Review fixes (2026-09-30). Each of these failed on the first implementation.

// Speaks (fake time) until socket number `count` exists, then answers its setup.
async function nextSocket(f, count, limitMs = 8000) {
  for (let spent = 0; spent < limitMs && f.sockets.length < count; spent += 250) await speak(f, 250, 250);
  assert.equal(f.sockets.length, count, 'the next connection opened');
  await f.open();
}

test('review: a handover renews the budget and the retry count after a stable minute, as the goAway through wait() did', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running();
  // Three transport closes in the first seconds spend the whole replacement budget.
  for (let i = 1; i <= 3; i++) {
    f.sockets.at(-1).finishClose(1000); await tick();
    await nextSocket(f, i + 1);
  }
  assert.deepEqual([f.budget().used, f.engine.snapshot().retries], [4, 3]);
  // Eleven stable minutes with output, then the goAway and a clean boundary.
  for (let minute = 0; minute < 11; minute++) {
    content(f.sockets.at(-1), { outputTranscription: { text: `m${minute}`, finished: true }, ...audioContent, turnComplete: true }); await tick();
    await speak(f, 60000);
  }
  const s = f.sockets.at(-1);
  s.json({ goAway: { timeLeft: '50s' } }); await tick();
  content(s, { turnComplete: true });
  await until(() => f.sockets.length === 5);
  await f.open();
  assert.deepEqual([f.budget().used, f.engine.snapshot().retries, f.engine.snapshot().metrics.handovers], [1, 0, 1],
    'the stable connection opened a renewed window, and the handover itself is free');
  // One ordinary drop ten seconds into the new connection is survived.
  content(f.sockets.at(-1), { outputTranscription: { text: 'new', finished: true }, ...audioContent }); await tick();
  await speak(f, 10000);
  f.sockets.at(-1).finishClose(1000); await tick();
  await nextSocket(f, 6);
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.errorCode, snap.retries, f.budget().used], ['running', null, 1, 2]);
});

test('review: a resumed handover setup refused before ready is asked again at once on the same model, without a handle, keeping the player and the held input', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  content(s0, { outputTranscription: { text: 'kept' }, ...audioContent }); await tick();
  resumable(s0, 'handle-1'); await tick();
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  for (let i = 0; i < 5; i++) await chunk(f, 0.3 + i * 0.01);
  content(s0, { turnComplete: true });
  await until(() => f.sockets.length === 2);
  const s1 = f.sockets[1];
  assert.deepEqual(setupOf(s1).sessionResumption, { handle: 'handle-1' });
  // Speech while the next connection sets up is held (four 64 ms chunks).
  for (let i = 0; i < 4; i++) { f.frame(0.6 + i * 0.01); f.audio.advance(64); }
  // Refused before setupComplete (1007 reads as a transport close).
  s1.finishClose(1007);
  await until(() => f.sockets.length === 3);
  const mid = f.engine.snapshot();
  assert.deepEqual([mid.status, mid.reconnectReason, mid.fallback], ['reconnecting', 'handover', false], 'still the calm handover');
  const s2 = f.sockets[2];
  assert.equal(setupOf(s2).model, setupOf(s0).model, 'never the model fallback');
  assert.deepEqual(setupOf(s2).sessionResumption, {}, 'a fresh session');
  await f.open(s2);
  for (let i = 0; i < 80 && s2.sent.filter(isAudio).length < PREROLL_FRAMES + 8; i++) { f.audio.advance(8); await tick(); }
  const next = sentLevels(s2);
  assert.deepEqual(next.slice(0, PREROLL_FRAMES), sentLevels(s0).slice(-PREROLL_FRAMES), 'the pre-roll still goes first');
  assert.ok(Math.abs(next[PREROLL_FRAMES] - 0.6) < 0.005, `then the held speech (${next[PREROLL_FRAMES]})`);
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.model, snap.fallback, snap.retries, f.budget().used, snap.metrics.handovers],
    ['running', setupOf(s0).model.slice('models/'.length), false, 0, 1, 1]);
  assert.ok(f.audio.made.length > 0 && f.audio.made.every((source) => !source.stopped), 'the player was never cancelled');
  content(s2, { outputTranscription: { text: 'after', finished: true } }); await tick();
  assert.equal(f.engine.snapshot().captions.captions.at(-1).gapBefore, false, 'a clean boundary stays clean');
});

test('review: two-way, a refused resumed setup stays on the instruction-driven model it asked for', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running({ targetLanguage: 'ja', sourceLanguage: 'ko', languages: ['ko', 'ja'] });
  await speak(f, MIN_HANDOVER_AGE_MS + 1000);
  const s0 = f.sockets[0];
  resumable(s0, 'handle-2w'); await tick();
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  content(s0, { turnComplete: true });
  await until(() => f.sockets.length === 2);
  setupOf(f.sockets[1]); f.sockets[1].finishClose(1007);
  await until(() => f.sockets.length === 3);
  await f.open();
  const snap = f.engine.snapshot();
  assert.equal(setupOf(f.sockets[2]).model, setupOf(s0).model);
  assert.deepEqual(setupOf(f.sockets[2]).sessionResumption, {});
  assert.deepEqual([snap.status, snap.fallback, snap.retries, f.budget().used], ['running', false, 0, 1]);
});

test('review: after a transport drop, a refused resumed setup is retried at once without a handle; a second refusal is an ordinary failure', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running();
  resumable(f.sockets[0], 'resume-me'); await tick();
  f.sockets[0].finishClose(1000); await tick();
  await speak(f, 1125, 500);
  assert.equal(f.sockets.length, 2);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, { handle: 'resume-me' });
  f.sockets[1].finishClose(1007);
  await until(() => f.sockets.length === 3);
  assert.equal(setupOf(f.sockets[2]).model, setupOf(f.sockets[0]).model);
  assert.deepEqual(setupOf(f.sockets[2]).sessionResumption, {});
  assert.deepEqual([f.engine.snapshot().fallback, f.engine.snapshot().retries, f.budget().used], [false, 1, 2], 'the retry was free');
  // Only one free retry per handle: the next refusal waits, is charged and may take the registered fallback.
  f.sockets[2].finishClose(1007); await tick(); await tick();
  assert.equal(f.sockets.length, 3, 'no second free retry');
  await speak(f, 2250, 500);
  assert.equal(f.sockets.length, 4);
  assert.deepEqual([f.engine.snapshot().retries, f.budget().used], [2, 3]);
});

test('review: six goAways whose resumed setup is refused every time keep the model, the budget and the operation', async t => {
  const f = handoverFixture(); t.after(() => f.close());
  await f.running();
  for (let i = 0; i < 6; i++) {
    const s = f.sockets.at(-1);
    content(s, { outputTranscription: { text: `m${i}`, finished: true }, ...audioContent, turnComplete: true }); await tick();
    await speak(f, 10 * 60000);
    resumable(s, `handle-${i}`); await tick();
    s.json({ goAway: { timeLeft: '50s' } }); await tick();
    content(s, { turnComplete: true });
    await until(() => f.sockets.length === 2 * i + 2);
    const refused = f.sockets.at(-1);
    assert.deepEqual(setupOf(refused).sessionResumption, { handle: `handle-${i}` });
    refused.finishClose(1007);
    await until(() => f.sockets.length === 2 * i + 3);
    await f.open();
  }
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.errorCode, snap.fallback, snap.retries, f.budget().used], ['running', null, false, 0, 1]);
  assert.deepEqual([snap.metrics.handovers, snap.metrics.reconnects], [6, 6], 'each refused setup is a reconnect, each goAway a handover');
  assert.ok(f.sockets.every((socket) => setupOf(socket).model === setupOf(f.sockets[0]).model), 'one model throughout');
});

test('review: a boundary after a "not resumable" update waits for the handle that follows the turn, and hands over as soon as it arrives', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  resumable(s0, 'h-before-turn'); await tick();
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  content(s0, { outputTranscription: { text: 'x' }, ...audioContent }); await tick();
  s0.json({ sessionResumptionUpdate: { newHandle: '', resumable: false } }); await tick();   // generating
  content(s0, { turnComplete: true });
  await tick();   // a browser delivers each WebSocket message as its own task
  assert.deepEqual([f.sockets.length, s0.closeCalls], [1, 0], 'waiting for the fresh handle');
  resumable(s0, 'h-after-turn');
  // No fake time passes: the handle itself ends the wait.
  await until(() => f.sockets.length === 2);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, { handle: 'h-after-turn' });
  await f.open();
  assert.deepEqual([f.engine.snapshot().metrics.handovers, f.engine.snapshot().captions.gaps.reception], [1, false]);
});

test('review: while a boundary waits for a handle, input still reaches the old socket, and a new turn defers the handover to its own boundary', async t => {
  const f = await aged(); t.after(() => f.close());
  const s0 = f.sockets[0];
  resumable(s0, 'h-1'); await tick();
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  s0.json({ sessionResumptionUpdate: { resumable: false } }); await tick();
  content(s0, { turnComplete: true });
  const before = s0.sent.filter(isAudio).length;
  for (let i = 0; i < 3; i++) await chunk(f, 0.3);
  assert.equal(s0.sent.filter(isAudio).length - before, 6, 'input goes on to the old socket during the wait');
  content(s0, { outputTranscription: { text: 'a new turn' }, ...audioContent }); await tick();
  await speak(f, HANDLE_GRACE_MS, 100);
  assert.equal(f.sockets.length, 1, 'the new turn cancelled the wait');
  resumable(s0, 'h-2'); await tick();
  assert.equal(f.sockets.length, 1, 'a handle mid-turn is not a boundary');
  content(s0, { turnComplete: true });
  await until(() => f.sockets.length === 2);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, { handle: 'h-2' });
});

test('review: a refused resumed setup is retried fresh on the same model even when the refusal is thrown before any event', async t => {
  let refuse = false, f;
  // Like the router: charge the attempt, then fail the open without a socket event.
  const router = { call(capability, request, ctx) {
    if (refuse && request.resumeHandle) {
      refuse = false;
      ctx.budget.consume({ providerId: ctx.providerId, keySource: ctx.keySource, signal: ctx.signal });
      return Promise.reject(new ProviderError('NETWORK_ERROR'));
    }
    return f.config.router.call(capability, request, ctx);
  } };
  f = simFixture({ engine: { router } }); t.after(() => f.close());
  await f.running();
  await speak(f, MIN_HANDOVER_AGE_MS + 1000);
  const s0 = f.sockets[0];
  resumable(s0, 'handle-thrown'); await tick();
  s0.json({ goAway: { timeLeft: '50s' } }); await tick();
  refuse = true;
  content(s0, { turnComplete: true });
  await until(() => f.sockets.length === 2);
  assert.equal(refuse, false, 'the resumed attempt was refused');
  assert.equal(setupOf(f.sockets[1]).model, setupOf(s0).model);
  assert.deepEqual(setupOf(f.sockets[1]).sessionResumption, {});
  await f.open();
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.fallback, snap.retries], ['running', false, 0]);
});
