// 2026-09-30 (owner: "무료키가 교체될때 타임러그를 최대한 줄여서 자연스럽게"):
// a spare site key takes over inside the running simultaneous session. Fake
// sockets, fake audio and fake timers only; keys are assembled at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simFixture, content, audioContent, tick } from './fixtures/sim.mjs';
import { createUplinkQueue } from '../app/audio/uplink-queue.js';
import { createLiveRecovery } from '../app/engine/live-recovery.js';
import { createStreamCapture } from '../app/audio/stream-capture.js';

const poolKeys = (count = 2) => Array.from({ length: count }, (_, index) => ['synthetic', 'pool', String(index + 1)].join('-'));
const quota = (socket) => socket.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET quota text' } });
const isAudio = (message) => Boolean(message.realtimeInput?.audio);
// The middle sample of each PCM frame a socket carried, as a float.
const sentLevels = (socket) => socket.sent.filter(isAudio).map((message) => {
  const bytes = Uint8Array.from(atob(message.realtimeInput.audio.data), (char) => char.charCodeAt(0));
  return new DataView(bytes.buffer).getInt16(512, true) / 32767;
});
async function until(condition, limit = 200) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}
async function advanceInput(f, ms) {
  while (ms > 0) { f.frame(); const step = Math.min(ms, 500); f.audio.advance(step); await tick(); ms -= step; }
}
// The app's hook in miniature: rotate the built-in pool, true when a spare took over.
function swapFixture({ keys = poolKeys(), hook, ...options } = {}) {
  const asked = [];
  let f;
  const swapCredential = async (error) => {
    asked.push(error.code);
    if (hook) return hook(error);
    return f.config.keyStore.rotateBuiltin('gemini', { code: error.code }) !== null;
  };
  f = simFixture({ builtin: keys, engine: { swapCredential }, ...options });
  return Object.assign(f, { asked, keys });
}
const urlFor = (key) => `key=${encodeURIComponent(key)}`;

test('a quota close mid-session opens the next key at once: no backoff, same capture and player, no replacement budget spent', async t => {
  const f = swapFixture(); t.after(() => f.close());
  const h = await f.running();
  content(f.sockets[0], audioContent); await tick();
  assert.equal(f.audio.made.length, 1);
  assert.ok(f.urls[0].endsWith(urlFor(f.keys[0])));
  quota(f.sockets[0]);
  // No fake time passes: a backoff timer could never fire, so a new socket proves there is none.
  await until(() => f.sockets.length === 2);
  assert.ok(f.urls[1].endsWith(urlFor(f.keys[1])), 'the spare key');
  assert.deepEqual(f.asked, ['UNKNOWN_429']);
  const swapping = f.engine.snapshot();
  assert.deepEqual([swapping.status, swapping.reconnectReason, swapping.busy], ['reconnecting', 'key', true]);
  assert.equal(f.track.stops, 0, 'the microphone track was never stopped');
  assert.equal(f.micCalls(), 1, 'and never asked for again');
  assert.equal(f.audio.made[0].stopped, false, 'audio that already arrived keeps playing');
  await f.open();
  const running = f.engine.snapshot();
  assert.deepEqual([running.status, running.reconnectReason, running.retries], ['running', null, 0]);
  assert.equal(running.metrics.keySwaps, 1);
  content(f.sockets[1], audioContent); await tick();
  assert.equal(f.audio.made.length, 2, 'the same player takes the new session audio');
  assert.equal(f.sockets[1].sent[0].setup.model, f.sockets[0].sent[0].setup.model, 'same request and model');
  // The replacement budget is untouched: three transport replacements remain.
  for (const delay of [1125, 2250, 4500]) {
    f.sockets.at(-1).finishClose(1006); await tick();
    await advanceInput(f, delay); await f.open();
  }
  assert.equal(f.sockets.length, 5);
  assert.equal(f.engine.snapshot().retries, 3);
  f.sockets.at(-1).finishClose(1006);
  assert.equal((await h.done).errorCode, 'BUDGET_EXHAUSTED');
});

test('a quota refusal at setup swaps the same way, repeatedly, and the first ready arrives from the spare key', async t => {
  const f = swapFixture({ keys: poolKeys(3) }); t.after(() => f.close());
  const h = f.start(); await tick(); f.frame(); await tick();
  assert.equal(f.sockets.length, 1);
  f.sockets[0].open(); quota(f.sockets[0]);
  await until(() => f.sockets.length === 2);
  assert.ok(f.urls[1].endsWith(urlFor(f.keys[1])));
  assert.equal(f.engine.snapshot().reconnectReason, 'key');
  f.sockets[1].open(); quota(f.sockets[1]);
  await until(() => f.sockets.length === 3);
  assert.ok(f.urls[2].endsWith(urlFor(f.keys[2])));
  await f.open();
  assert.deepEqual(await h.ready, { status: 'running', sessionId: 'sim-test' });
  assert.equal(f.engine.snapshot().metrics.keySwaps, 2);
  assert.deepEqual([f.track.stops, f.micCalls(), f.engine.snapshot().retries], [0, 1, 0]);
});

test('a spent pool ends the operation exactly as before: the hook is asked once, then failure with the quota code', async t => {
  const f = swapFixture({ keys: poolKeys(1) }); t.after(() => f.close());
  const h = await f.running();
  content(f.sockets[0], audioContent); await tick();
  quota(f.sockets[0]);
  const result = await h.done;
  assert.deepEqual([result.status, result.errorCode], ['failed', 'UNKNOWN_429']);
  assert.deepEqual(f.asked, ['UNKNOWN_429']);
  assert.equal(f.sockets.length, 1); assert.equal(f.track.stops, 1);
  assert.ok(f.audio.made.every((source) => source.stopped));
  assert.equal(f.audio.timers.size, 0, 'no reconnect timer');
  assert.equal(f.engine.snapshot().reconnectReason, null);
  assert.equal(f.engine.snapshot().metrics.keySwaps, 0);
  assert.equal(f.config.keyStore.getMetadata('gemini', 'personal').builtinExhausted, true);
});

test('speech during the swap reaches the new session first, in order, faster than real time but no more than 4x', async t => {
  const f = swapFixture(); t.after(() => f.close());
  await f.running();
  quota(f.sockets[0]);
  // Ten 64 ms chunks (twenty 32 ms frames) spoken while no session is ready.
  for (let i = 0; i < 10; i++) { f.frame(0.1 + i * 0.01); f.audio.advance(64); }
  await until(() => f.sockets.length === 2);
  const s = f.sockets[1];
  const times = [];
  const send = s.send.bind(s);
  s.send = (text) => { if (text.includes('realtimeInput')) times.push(f.audio.options.now()); send(text); };
  await f.open(s);
  for (let i = 0; i < 40 && s.sent.filter(isAudio).length < 20; i++) { f.audio.advance(8); await tick(); }
  const levels = sentLevels(s);
  assert.equal(levels.length, 20, 'every held frame was sent');
  assert.ok(Math.abs(levels[0] - 0.1) < 0.005, `the first held frame goes first (${levels[0]})`);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1] - 0.005, 'in speaking order');
  const gaps = times.slice(1).map((at, i) => at - times[i]);
  assert.ok(gaps.every((gap) => gap >= 8), `never faster than 4x real time: ${gaps}`);
  assert.ok(gaps.every((gap) => gap < 32), `faster than real time: ${gaps}`);
  // New speech after the backlog queues behind it and the ordinary pace returns.
  f.frame(0.5); for (let i = 0; i < 12; i++) { f.audio.advance(8); await tick(); }
  assert.ok(sentLevels(s).slice(20).every((level) => Math.abs(level - 0.5) < 0.05));
});

test('the bridge is bounded to 4 s: older held speech is dropped and marked as an input gap', async t => {
  const f = swapFixture(); t.after(() => f.close());
  await f.running();
  quota(f.sockets[0]);
  // 100 chunks = 200 frames = 6.4 s; the newest 125 frames (4 s) survive.
  for (let i = 0; i < 100; i++) { f.frame(0.001 * (i + 1)); f.audio.advance(64); }
  assert.equal(f.engine.snapshot().captions.gaps.input, true);
  await until(() => f.sockets.length === 2);
  await f.open();
  for (let i = 0; i < 400 && f.sockets[1].sent.filter(isAudio).length < 125; i++) { f.audio.advance(8); await tick(); }
  f.audio.advance(200); await tick();
  const levels = sentLevels(f.sockets[1]);
  assert.equal(levels.length, 125);
  assert.ok(Math.abs(levels[0] - 0.038) < 0.002, `the oldest surviving frame is from chunk 38 (${levels[0]})`);
  assert.ok(Math.abs(levels.at(-1) - 0.1) < 0.002);
});

test('goAway and transport closes keep today\'s path: backoff, no held input, no hook, no key reason', async t => {
  const f = swapFixture(); t.after(() => f.close());
  await f.running();
  f.sockets[0].finishClose(1006); await tick();
  assert.deepEqual([f.engine.snapshot().status, f.engine.snapshot().reconnectReason], ['reconnecting', null]);
  f.frame(0.9); f.audio.advance(500); await tick();
  assert.equal(f.sockets.length, 1, 'the backoff still applies');
  await advanceInput(f, 625);
  assert.equal(f.sockets.length, 2);
  await f.open();
  f.audio.advance(40); await tick();
  assert.equal(f.sockets[1].sent.filter(isAudio).length, 0, 'nothing spoken during the reconnect is replayed');
  f.sockets[1].json({ goAway: { timeLeft: '10s' } }); await tick();
  assert.equal(f.engine.snapshot().reconnectReason, null);
  await advanceInput(f, 2250); await f.open();
  assert.deepEqual(f.asked, [], 'the hook is only for quota codes');
  assert.equal(f.engine.snapshot().metrics.keySwaps, 0);
  assert.equal(f.engine.snapshot().retries, 2);
  assert.ok(f.urls.every((url) => url.endsWith(urlFor(f.keys[0]))), 'the key never changed');
  // A key rejection is not a quota: terminal, and the hook is not asked.
  f.sockets.at(-1).json({ error: { code: 400, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } });
  await until(() => f.engine.snapshot().status === 'failed');
  assert.deepEqual([f.engine.snapshot().errorCode, f.asked.length], ['INVALID_KEY', 0]);
});

test('fake-time gap from the quota close to the first uplink frame on the new socket is under 100 ms when setup answers at once', async t => {
  const f = swapFixture(); t.after(() => f.close());
  await f.running();
  const now = f.audio.options.now;
  const closedAt = now();
  quota(f.sockets[0]);
  let firstAt = null;
  for (let step = 0; step < 250 && firstAt === null; step++) {
    const next = f.sockets[1];
    if (next && next.readyState === 0) { next.open(); next.json({ setupComplete: {} }); }
    if (step % 8 === 0) f.frame(0.2);
    await tick();
    if (next?.sent.some(isAudio)) firstAt = now();
    else f.audio.advance(8);
  }
  assert.notEqual(firstAt, null, 'speech reached the new session');
  t.diagnostic(`quota close -> first uplink frame on the new socket: ${firstAt - closedAt} ms of fake time`);
  assert.ok(firstAt - closedAt < 100, `gap ${firstAt - closedAt} ms of fake time`);
});

test('a hook that never says no is still bounded per operation', async t => {
  const f = swapFixture({ hook: async () => true }); t.after(() => f.close());
  const h = await f.running();
  for (let i = 0; i < 8; i++) {
    quota(f.sockets.at(-1));
    await until(() => f.sockets.length === i + 2);
    await f.open();
  }
  quota(f.sockets.at(-1));
  assert.equal((await h.done).errorCode, 'UNKNOWN_429');
  assert.equal(f.asked.length, 8);
  assert.equal(f.sockets.length, 9);
});

// The uplink backlog on its own: exempt from staleness, paced at 8 ms, ordered, bounded.
function uplinkFixture(backlog) {
  let time = 0, id = 0;
  const timers = new Map(), calls = [], drops = [];
  const clock = { now: () => time, setTimeout(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout: (key) => timers.delete(key) };
  const q = createUplinkQueue({ clock, backlog, sendAudio(pcm) { calls.push({ time, value: pcm[0] }); },
    onDrop: (value) => drops.push(value) });
  return { q, calls, drops, async advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); time = next[1].at; next[1].fn(); await tick();
    }
    time = end; await tick();
  } };
}
const pcmFrame = (n) => new Uint8Array(1024).fill(n);

test('uplink backlog: held frames go first at 8 ms spacing, never stale, and live input waits behind them', async () => {
  const f = uplinkFixture(Array.from({ length: 20 }, (_, i) => pcmFrame(i + 1)));
  assert.equal(f.q.getStats().backlogFrames, 20);
  f.q.setReady(true);
  await f.advance(40);
  f.q.enqueue(pcmFrame(99));
  await f.advance(400);
  assert.deepEqual(f.calls.map((call) => call.value), [...Array.from({ length: 20 }, (_, i) => i + 1), 99]);
  const spacing = f.calls.slice(1, 20).map((call, i) => call.time - f.calls[i].time);
  assert.ok(spacing.every((gap) => gap === 8), `${spacing}`);
  assert.deepEqual(f.drops, [], 'held frames older than 256 ms were not dropped as stale');
  // Back to the ordinary 32 ms pace once caught up.
  f.q.enqueue(pcmFrame(100)); f.q.enqueue(pcmFrame(101)); await f.advance(100);
  assert.equal(f.calls.at(-1).time - f.calls.at(-2).time, 32);
});

test('uplink backlog: bounded to 125 frames, oldest dropped as overflow; invalid frames are refused', async () => {
  const f = uplinkFixture(Array.from({ length: 130 }, (_, i) => pcmFrame(i % 250)));
  assert.equal(f.q.getStats().backlogFrames, 125);
  f.q.setReady(true);
  for (let i = 0; i < 3; i++) f.q.enqueue(pcmFrame(200));
  assert.equal(f.q.getStats().backlogFrames, 125);
  assert.deepEqual(f.drops.map((drop) => drop.reason), ['overflow', 'overflow', 'overflow']);
  await f.advance(2000);
  assert.equal(f.calls.length, 125);
  assert.equal(f.calls[0].value, 8);
  assert.throws(() => createUplinkQueue({ sendAudio() {}, backlog: [new Uint8Array(10)] }), { code: 'INVALID_REQUEST' });
});

test('live recovery: a key swap authorizes one immediate open that the replacement budget does not charge', async () => {
  const recovery = createLiveRecovery({ now: () => 0, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {} });
  const address = { providerId: 'gemini', keySource: 'personal' };
  recovery.budget.consume(address);
  assert.equal(recovery.budget.used, 1);
  assert.throws(() => recovery.budget.consume(address), { code: 'BUDGET_EXHAUSTED' }, 'nothing open is authorized yet');
  recovery.keySwapped();
  recovery.budget.consume(address);
  assert.deepEqual([recovery.budget.used, recovery.budget.remaining, recovery.retries], [1, 3, 0]);
  recovery.keySwapped();
  assert.throws(() => recovery.keySwapped(), { code: 'INVALID_REQUEST' }, 'one open per swap');
  const fresh = createLiveRecovery({ now: () => 0 });
  assert.throws(() => fresh.keySwapped(), { code: 'INVALID_REQUEST' }, 'nothing to swap before the first open');
});

// Sticky activation for an app-initiated restart only.
function captureFixture({ isActive, hasBeenActive }) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false, stop() { this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = { connect() {}, disconnect() {}, port: { close() {} } };
  const context = Object.assign(new EventTarget(), { state: 'running', sampleRate: 16000, destination: {},
    resume: async () => {}, close: async () => {}, audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }) });
  let calls = 0;
  const platform = { isSecureContext: true, isUserActive: () => isActive, hasBeenActive: () => hasBeenActive,
    document: Object.assign(new EventTarget(), { hidden: false }), page: new EventTarget(),
    createAudioContext: () => context, createWorkletNode: () => node,
    getUserMedia: async () => { calls++; return stream; }, setTimeout: () => 0, clearTimeout() {} };
  return { platform, node, calls: () => calls };
}

test('stream capture: an app restart accepts sticky activation; the first start still needs a fresh gesture', async () => {
  const frames = [];
  const restart = captureFixture({ isActive: false, hasBeenActive: true });
  const sticky = createStreamCapture({ platform: restart.platform, onFrame: (pcm) => frames.push(pcm) }).start({ activation: 'sticky' });
  await tick(); await tick();
  restart.node.port.onmessage?.({ data: new Float32Array(1024).fill(0.1) });
  assert.equal(frames.length, 2, 'a restart more than 5 s after the last gesture captures');
  assert.equal(restart.calls(), 1);
  sticky.cancel();
  const never = captureFixture({ isActive: false, hasBeenActive: false });
  const refused = await createStreamCapture({ platform: never.platform }).start({ activation: 'sticky' }).done;
  assert.equal(refused.code, 'MICROPHONE_UNAVAILABLE', 'no gesture ever: no microphone');
  const first = captureFixture({ isActive: false, hasBeenActive: true });
  assert.equal((await createStreamCapture({ platform: first.platform }).start().done).code, 'MICROPHONE_UNAVAILABLE',
    'a first start keeps the strict transient check');
  assert.equal(first.calls(), 0);
});
