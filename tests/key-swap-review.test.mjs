// 2026-09-30 review of the built-in key swap (owner: "무료키가 교체될때 타임러그를
// 최대한 줄여서 자연스럽게"). One test per finding; each fails on the first cut.
// Fake sockets, audio, storage and timers only; keys are assembled at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simFixture, content, audioContent, tick, deferred } from './fixtures/sim.mjs';
import { boot, live, rest } from './fixtures/scenarios.mjs';
import { TURN_PHASE, createState } from '../app/state.js';
import { LIVE_ENDPOINT } from '../app/providers/gemini/live-client.js';
import { createUplinkQueue } from '../app/audio/uplink-queue.js';
import { createSeqEngine } from '../app/engine/seq.js';
import { APP_DEFAULTS } from '../app/config.js';
import { ProviderError } from '../app/providers/contract.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { BUILTIN_COOLDOWN_STORAGE_KEY, createKeyStore } from '../app/security/key-store.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { keyFingerprint } from '../app/security/fingerprint.js';
import { provider, adapter } from './fixtures/providers.mjs';

const poolKeys = (count = 2) => Array.from({ length: count }, (_, i) => ['synthetic', 'review', 'pool', String(i + 1)].join('-'));
const ownKey = () => ['synthetic', 'review', 'own'].join('-');
const quota = (socket) => socket.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET quota text' } });
const isAudio = (message) => Boolean(message.realtimeInput?.audio);
const socketKey = (url) => decodeURIComponent(url.slice(`${LIVE_ENDPOINT}?key=`.length));
// The middle sample of each PCM frame a socket carried, as a float.
const sentLevels = (socket) => socket.sent.filter(isAudio).map((message) => {
  const bytes = Uint8Array.from(atob(message.realtimeInput.audio.data), (char) => char.charCodeAt(0));
  return new DataView(bytes.buffer).getInt16(512, true) / 32767;
});
async function until(condition, limit = 300) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}
function swapFixture({ keys = poolKeys(), hook, canSwap, ...options } = {}) {
  const asked = [], checked = [];
  let f;
  const swapCredential = async (error) => {
    asked.push(error.code);
    if (hook) return hook(error);
    return f.config.keyStore.rotateBuiltin('gemini', { code: error.code }) !== null;
  };
  const engine = { swapCredential,
    ...(canSwap ? { canSwapCredential: (error) => { checked.push(error.code); return canSwap(error); } } : {}) };
  f = simFixture({ builtin: keys, engine, ...options });
  return Object.assign(f, { asked, checked, keys });
}
// A socket whose send buffer drains at `bytesPerMs` of fake time, like an
// uplink of bytesPerMs * 8 kbit/s; peak is the most it ever held.
function throttle(f, socket, bytesPerMs) {
  const now = f.audio.options.now;
  let buffered = 0, last = now(), peak = 0;
  const drain = () => { buffered = Math.max(0, buffered - bytesPerMs * (now() - last)); last = now(); };
  Object.defineProperty(socket, 'bufferedAmount', { configurable: true, get() { drain(); return buffered; } });
  const send = socket.send.bind(socket);
  socket.send = (text) => {
    drain(); send(text);
    buffered += new TextEncoder().encode(text).byteLength; peak = Math.max(peak, buffered);
  };
  return { get peak() { return peak; } };
}
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); } };
}
function keyPage({ at, backing = memoryStorage() } = {}) {
  const registry = createRegistry();
  registry.register(provider(), adapter());
  let time = at;
  const store = createKeyStore({ registry, storage: backing, now: () => time });
  return { store, backing, advance(ms) { time += ms; }, meta: () => store.getMetadata('alpha', 'personal') };
}

// Finding 1 (major): the voice lease kept the spent key's socket.
test('sequential: after a silent swap the line is read on a Live session of the key that took over, never on the spent key\'s socket', async t => {
  const keys = poolKeys(2);
  const b = await boot({ builtinKey: () => keys });
  t.after(() => b.close());
  b.setVoiceOutput('provider');
  // Turn 1 on key 1, spoken; the Live voice session is kept for the next line.
  b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
  const first = b.submitText('사과 12개');
  await until(() => b.sockets.length === 1);
  const spent = b.sockets[0];
  assert.equal(socketKey(b.socketURLs[0]), keys[0]);
  live.ready(spent);
  await until(() => spent.sent.length === 2);
  spent.json(live.chunk()); spent.json(live.complete());
  assert.equal((await first.done).voice.engine, 'live');
  assert.equal(b.app.engine.snapshot().voice.sessionOpen, true);
  // Turn 2: key 1 answers 429, the turn goes again on key 2 — and so does its line.
  b.gemini.script.push(rest.unknown429(), rest.translation({ translatedText: 'りんご12個' }));
  const second = b.submitText('사과 12개');
  await until(() => b.sockets.length === 2);
  assert.equal(socketKey(b.socketURLs[1]), keys[1], 'the line opens a session with the key that took over');
  assert.equal(spent.sent.length, 2, 'nothing more went to the spent key\'s socket');
  assert.ok(spent.closeCalls >= 1, 'which is closed');
  const next = b.sockets[1];
  live.ready(next);
  await until(() => next.sent.length === 2);
  next.json(live.chunk()); next.json(live.complete());
  const two = await second.done;
  assert.deepEqual([two.phase, two.voice.engine, two.voice.status], [TURN_PHASE.COMPLETED, 'live', 'completed']);
  // Turn 3 reuses the key-2 session.
  b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
  const third = b.submitText('사과 12개');
  await until(() => next.sent.length === 3);
  next.json(live.chunk()); next.json(live.complete());
  assert.equal((await third.done).voice.engine, 'live');
  assert.equal(b.sockets.length, 2);
});

// Findings 2 and 10 (minor): a 4x burst tripped the transport's send-buffer guard.
test('held input on a 0.8 Mbit/s uplink follows the send buffer: all of it arrives in order, the guard never trips, no replacement', async t => {
  const f = swapFixture(); t.after(() => f.close());
  await f.running();
  quota(f.sockets[0]);
  // About 1.9 s of speech (60 frames) while the swap and the new setup run.
  for (let i = 0; i < 30; i++) { f.frame(0.1 + i * 0.01); f.audio.advance(64); }
  await until(() => f.sockets.length === 2);
  const link = throttle(f, f.sockets[1], 100);
  await f.open(f.sockets[1]);
  const seen = new Set();
  f.engine.subscribe((value) => seen.add(`${value.status}/${value.reconnectReason}`));
  for (let i = 0; i < 400 && f.sockets[1].sent.filter(isAudio).length < 60; i++) { f.audio.advance(8); await tick(); }
  const levels = sentLevels(f.sockets[1]);
  assert.equal(levels.length, 60, 'every held frame reached the new session');
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1] - 0.005, 'in speaking order');
  assert.ok(link.peak <= 12288, `the send buffer peaked at ${link.peak} bytes, within the 12288-byte guard`);
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.retries, f.sockets.length], ['running', 0, 2]);
  assert.equal([...seen].some((value) => value.startsWith('reconnecting')), false, 'the new session never dropped');
});

test('a full 4 s bridge on a 1.2 Mbit/s uplink arrives whole', async t => {
  const f = swapFixture(); t.after(() => f.close());
  await f.running();
  quota(f.sockets[0]);
  for (let i = 0; i < 70; i++) { f.frame(0.2); f.audio.advance(64); }
  await until(() => f.sockets.length === 2);
  throttle(f, f.sockets[1], 150);
  await f.open(f.sockets[1]);
  for (let i = 0; i < 400 && f.sockets[1].sent.filter(isAudio).length < 125; i++) { f.audio.advance(8); await tick(); }
  assert.equal(f.sockets[1].sent.filter(isAudio).length, 125);
  assert.deepEqual([f.engine.snapshot().retries, f.sockets.length], [0, 2]);
});

function uplinkFixture(backlog, answer) {
  let time = 0, id = 0, index = 0;
  const timers = new Map(), calls = [];
  const clock = { now: () => time, setTimeout(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout: (key) => timers.delete(key) };
  const q = createUplinkQueue({ clock, backlog, sendAudio(pcm) { calls.push({ time, value: pcm[0] }); return answer(index++); } });
  return { q, calls, async advance(ms) {
    // Microtasks run before time moves on, as in a browser (2026-09-30: the
    // queue now starts its pump from a microtask, not a zero-delay timer).
    await tick();
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

test('uplink backlog: while the transport holds more than half its guard, the next held frame waits a real-time interval', async () => {
  const replies = [100, 7000, 7000, undefined, 6144, 'much', 100];
  const f = uplinkFixture(Array.from({ length: 8 }, (_, i) => pcmFrame(i + 1)), (i) => replies[i]);
  f.q.setReady(true);
  await f.advance(400);
  assert.equal(f.calls.length, 8);
  const gaps = f.calls.slice(1).map((call, i) => call.time - f.calls[i].time);
  assert.deepEqual(gaps, [8, 32, 32, 8, 8, 8, 8]);
});

// Finding 3 and 9 (minor): with every other key cooling down, a per-minute
// 429 on the only usable key skipped the executor's server wait.
test('sequential: when the only spare key is still cooling down, a per-minute 429 is waited out on the key in use, as before', async t => {
  const keys = poolKeys(2);
  // Key 2 hit its per-minute limit on an earlier page; key 1 is fine.
  const storage = { [BUILTIN_COOLDOWN_STORAGE_KEY]: JSON.stringify({ [keyFingerprint(keys[1])]: Date.now() + 30000 }) };
  const b = await boot({ builtinKey: () => keys, storage });
  t.after(() => b.close());
  const meta = () => b.app.config.keyStore.getMetadata('gemini', 'personal');
  assert.deepEqual([meta().builtinIndex, meta().builtinExhausted], [0, false]);
  b.setVoiceOutput('off');
  b.gemini.script.push(rest.perMinute429(2), rest.translation());
  const pending = b.submitText('사과 12개').done;
  let turn = null;
  pending.then((value) => { turn = value; });
  // The server asked for 2 s: nothing is sent again before that.
  for (let i = 0; i < 7; i++) { await tick(); b.clock.advance(250); }
  assert.equal(b.gemini.calls.length, 1);
  for (let i = 0; i < 40 && !turn; i++) { await tick(); b.clock.advance(250); }
  assert.deepEqual([turn?.phase, turn?.errorCode ?? null], [TURN_PHASE.COMPLETED, null]);
  assert.deepEqual(b.gemini.calls.map((call) => call.headers['x-goog-api-key']), [keys[0], keys[0]]);
  assert.deepEqual([meta().builtinIndex, meta().builtinExhausted, meta().builtinSpare], [0, false, false]);
});

test('key store: builtinSpare counts cooldowns and turns true once a spare key has cooled down', () => {
  const keys = poolKeys(3);
  const at = Date.UTC(2026, 8, 30, 12);
  const page = keyPage({ at, backing: memoryStorage({ [BUILTIN_COOLDOWN_STORAGE_KEY]: JSON.stringify({
    [keyFingerprint(keys[1])]: at + 30000, [keyFingerprint(keys[2])]: at + 50000 }) }) });
  page.store.setBuiltin('alpha', keys);
  assert.deepEqual([page.meta().builtinIndex, page.meta().builtinSpare], [0, false]);
  page.advance(31000);
  assert.equal(page.meta().builtinSpare, true);
  page.store.dispose();
});

// Finding 4 (minor): rotation only looked forward.
test('key store: a key skipped at load, or left for a short limit, comes back once its cooldown ends; within it the pool never goes back', () => {
  const keys = poolKeys(2);
  const at = Date.UTC(2026, 8, 30, 12);
  const loaded = keyPage({ at, backing: memoryStorage({ [BUILTIN_COOLDOWN_STORAGE_KEY]: JSON.stringify({ [keyFingerprint(keys[0])]: at + 30000 }) }) });
  loaded.store.setBuiltin('alpha', keys);
  assert.equal(loaded.meta().builtinIndex, 1, 'key 1 is cooling at load');
  loaded.advance(10 * 60000);
  assert.deepEqual(loaded.store.rotateBuiltin('alpha', { code: 'DAILY_LIMIT' }), { index: 0, count: 2 }, 'key 1 has recovered');
  assert.equal(loaded.meta().builtinExhausted, false);
  loaded.store.dispose();
  // No storage at all: the page still remembers what it left, and for how long.
  const registry = createRegistry();
  registry.register(provider(), adapter());
  let time = at;
  const memory = createKeyStore({ registry, now: () => time });
  memory.setBuiltin('alpha', keys);
  assert.deepEqual(memory.rotateBuiltin('alpha', { code: 'RATE_LIMITED' }), { index: 1, count: 2 });
  time += 10000;
  assert.equal(memory.rotateBuiltin('alpha', { code: 'RATE_LIMITED' }), null, 'key 1 is still cooling: no ping-pong');
  assert.equal(memory.getMetadata('alpha', 'personal').builtinExhausted, true);
  time += 51000;
  assert.deepEqual(memory.rotateBuiltin('alpha', { code: 'RATE_LIMITED' }), { index: 0, count: 2 }, 'a minute on, key 1 is back');
  assert.equal(memory.getMetadata('alpha', 'personal').builtinExhausted, false);
  memory.dispose();
});

// Finding 5 (minor): a second swap threw away the held input still catching up.
test('a second quota close while held input is catching up keeps the unsent rest for the next key, in speaking order', async t => {
  const f = swapFixture({ keys: poolKeys(3) }); t.after(() => f.close());
  await f.running();
  quota(f.sockets[0]);
  // 40 frames (~1.3 s) held during the first swap.
  for (let i = 0; i < 20; i++) { f.frame(0.1 + i * 0.01); f.audio.advance(64); }
  await until(() => f.sockets.length === 2);
  await f.open(f.sockets[1]);
  for (let i = 0; i < 5; i++) { f.audio.advance(8); await tick(); }
  const early = sentLevels(f.sockets[1]);
  assert.ok(early.length > 0 && early.length < 40, `${early.length} frames reached key 2 first`);
  quota(f.sockets[1]);
  await until(() => f.sockets.length === 3);
  assert.equal(f.engine.snapshot().reconnectReason, 'key');
  await f.open(f.sockets[2]);
  for (let i = 0; i < 200 && early.length + sentLevels(f.sockets[2]).length < 40; i++) { f.audio.advance(8); await tick(); }
  const all = [...early, ...sentLevels(f.sockets[2])];
  assert.equal(all.length, 40, 'nothing held was lost across two swaps');
  for (let i = 1; i < all.length; i++) assert.ok(all[i] >= all[i - 1] - 0.005, 'in speaking order');
  assert.equal(f.engine.snapshot().metrics.keySwaps, 2);
});

// Finding 6 (minor): stop() waited for the injected hook.
test('stop() while the swap hook is still deciding settles at once, and a late "yes" opens nothing', async t => {
  const gate = deferred();
  const f = swapFixture({ hook: () => gate.promise });
  t.after(async () => { gate.resolve(false); await f.close(); });
  await f.running();
  quota(f.sockets[0]);
  await until(() => f.asked.length === 1);
  let settled = false;
  f.engine.stop().then(() => { settled = true; });
  for (let i = 0; i < 50 && !settled; i++) await tick();
  assert.equal(settled, true, 'stop settled without the hook');
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.busy, snap.errorCode, f.track.stops], ['stopped', false, null, 1]);
  gate.resolve(true);
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual([f.sockets.length, f.engine.snapshot().status], [1, 'stopped']);
});

test('sequential: a cancel while the swap hook is still deciding ends the turn at once', async t => {
  const registry = createRegistry();
  const translate = [];
  registry.register(provider('alpha'), { ...adapter(),
    async translate(request, context) { translate.push(context.keySource); throw new ProviderError('UNKNOWN_429'); } });
  const keyStore = createKeyStore({ registry });
  keyStore.setBuiltin('alpha', poolKeys(2));
  keyStore.select('alpha', 'personal');
  const router = createRouter({ registry, getCredentialRef: (address, options) => keyStore.getCredentialRef(address, options) });
  const sessionManager = createSessionManager({ isolated: true });
  const config = { router, keyStore, sessionManager, defaults: APP_DEFAULTS, resolveFallback: () => null };
  const voice = { async speak() { return { status: 'off' }; }, restart() {}, async close() {}, snapshot: () => ({ live: 'ready' }) };
  const capture = { start() { throw new ProviderError('INVALID_REQUEST'); }, cancel() {} };
  const gate = deferred(), asked = [];
  const engine = createSeqEngine({ config, capture, voiceEngine: voice, sessionId: 'review-seq',
    state: createState({ sessionId: 'review-seq', now: () => 1 }),
    swapCredential: (error) => { asked.push(error.code); return gate.promise; } });
  t.after(async () => { gate.resolve(false); await engine.close(); keyStore.dispose(); await sessionManager.close(); });
  const { turnId, done } = engine.submitText('사과 12개');
  let result = null;
  done.then((value) => { result = value; });
  await until(() => asked.length === 1);
  engine.cancel();
  for (let i = 0; i < 50 && !result; i++) await tick();
  assert.equal(result?.phase, TURN_PHASE.CANCELLED, 'the turn ended without the hook');
  assert.equal(engine.snapshot().busy, false);
  gate.resolve(true);
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual([translate.length, engine.state.snapshot().turns.find((turn) => turn.turnId === turnId).phase],
    [1, TURN_PHASE.CANCELLED], 'a late "yes" sends nothing again');
});

// Finding 7 (minor): a key that cannot be swapped read as a swap until the hook said no.
test('a quota close the app cannot swap is handled as before from its first moment: no key reason, the player stops, no hook', async t => {
  const f = swapFixture({ autoClose: false, canSwap: () => false }); t.after(() => f.close());
  const h = await f.running();
  content(f.sockets[0], audioContent); await tick();
  const reasons = new Set();
  f.engine.subscribe((value) => reasons.add(value.reconnectReason));
  quota(f.sockets[0]);
  await tick(); await tick();
  const closing = f.engine.snapshot();
  assert.deepEqual([closing.status, closing.reconnectReason], ['reconnecting', null]);
  assert.equal(f.audio.made[0].stopped, true, 'already-received audio stops, as without a hook');
  assert.deepEqual(f.checked, ['UNKNOWN_429']);
  f.sockets[0].finishClose();
  assert.equal((await h.done).errorCode, 'UNKNOWN_429');
  assert.deepEqual([f.asked, [...reasons].includes('key')], [[], false]);
});

test('app: a 429 on a key the person entered never shows the calm key-swap state', async t => {
  const b = await boot({ builtinKey: () => poolKeys(2) });
  t.after(() => b.close());
  b.enterPersonalKey({ key: ownKey() });
  b.el('sim-start').dispatch('click');
  await until(() => b.audio.nodes.at(-1)?.port.onmessage);
  b.microphone.feed(new Float32Array(4096).fill(0.1));
  await until(() => b.sockets.length === 1);
  assert.equal(socketKey(b.socketURLs[0]), ownKey());
  live.ready(b.sockets[0]);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'running');
  const reasons = new Set();
  const off = b.app.listenEngines.direct.subscribe((value) => reasons.add(value.reconnectReason)); t.after(off);
  quota(b.sockets[0]);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'failed');
  assert.equal([...reasons].includes('key'), false);
  assert.equal(b.app.listenEngines.direct.snapshot().errorCode, 'UNKNOWN_429');
});

// Finding 8 (major): UNKNOWN_429 (every Live 429 close) benched a key until the
// Pacific midnight, so a reload could find the whole pool spent for a day.
test('key store: after 429s that name no daily quota, a reload five minutes later has the whole pool back', () => {
  const keys = poolKeys(3);
  const at = Date.UTC(2026, 8, 30, 1);
  const first = keyPage({ at });
  first.store.setBuiltin('alpha', keys);
  assert.deepEqual(first.store.rotateBuiltin('alpha', { code: 'UNKNOWN_429' }), { index: 1, count: 3 });
  assert.deepEqual(first.store.rotateBuiltin('alpha', { code: 'TOKEN_LIMIT' }), { index: 2, count: 3 });
  assert.equal(first.store.rotateBuiltin('alpha', { code: 'UNKNOWN_429' }), null);
  const ends = Object.values(JSON.parse(first.backing.data.get(BUILTIN_COOLDOWN_STORAGE_KEY)));
  assert.deepEqual(ends, [at + 60000, at + 60000, at + 60000]);
  first.store.dispose();
  const reload = keyPage({ at: at + 5 * 60000, backing: first.backing });
  reload.store.setBuiltin('alpha', keys);
  assert.deepEqual([reload.meta().builtinIndex, reload.meta().builtinExhausted, reload.meta().builtinSpare], [0, false, true]);
  assert.deepEqual(reload.store.rotateBuiltin('alpha', { code: 'UNKNOWN_429' }), { index: 1, count: 3 });
  reload.store.dispose();
});
