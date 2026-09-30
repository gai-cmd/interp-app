import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppConfig } from '../app/config.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { createSimEngine } from '../app/engine/sim.js';
import { createSocketFixture, deferred, tick } from './fixtures/live.mjs';
import { context } from './fixtures/providers.mjs';
import { streamAudio } from './fixtures/stream-audio.mjs';
import { audioContent, content } from './fixtures/sim.mjs';

// docs/extension.md §11.1 (group A, M0). The extension runs the tab lane and the
// microphone lane at the same time in one realm, so each lane needs a private Live
// slot and its own config (its own Live client). The `isolated` option is opt-in:
// the tests below pin both halves, the private slots and the unchanged shared one.
// Everything is fake (sockets, audio context, capture stream); nothing here can make
// a sound or open a device.

const code = (value) => (error) => error.code === value;
const session = (close = async () => {}) => ({ close, async speak() {}, async cancel() {} });
// Built at runtime and printable ASCII: valid for the key store, never a key-shaped literal.
const fakeKey = () => `synthetic-${'x'.repeat(24)}`;
const REST_REFUSED = async () => { throw new Error('unexpected REST'); };
const address = { providerId: 'gemini', keySource: 'personal', transport: 'direct' };

function configEnv() {
  const sockets = createSocketFixture();
  return { WebSocket: sockets.WebSocket, fetch: REST_REFUSED, sockets };
}

/**
 * One interpretation lane over the real sim engine: its own audio clock, fake
 * capture chain and (unless given) its own isolated config with its own fake
 * socket. `config` and `manager` can be shared on purpose to reproduce the
 * situations the design forbids.
 */
function lane({ config, manager, sockets } = {}) {
  const audio = streamAudio();
  const own = sockets ?? createSocketFixture();
  const cfg = config ?? createAppConfig({ isolated: true, WebSocket: own.WebSocket, fetch: REST_REFUSED });
  if (!config) { cfg.keyStore.setPersonal('gemini', fakeKey()); cfg.keyStore.select('gemini', 'personal'); }
  const mgr = manager ?? cfg.sessionManager;
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false,
    stops: 0, stop() { this.stops++; this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = { connect() {}, disconnect() {}, port: { close() {} } };
  const micContext = Object.assign(new EventTarget(), { sampleRate: 16000, state: 'running', destination: {},
    resume: async () => {}, close: async () => { micContext.state = 'closed'; },
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }) });
  let micCalls = 0;
  const platform = { document: Object.assign(new EventTarget(), { hidden: false }), page: new EventTarget(),
    isSecureContext: true, isUserActive: () => true, createAudioContext: () => micContext,
    createWorkletNode: () => node, getUserMedia() { micCalls++; return Promise.resolve(stream); },
    setTimeout: audio.options.setTimeout, clearTimeout: audio.options.clearTimeout };
  const engine = createSimEngine({ router: cfg.router, sessionManager: mgr, platform,
    getAudioContext: () => audio.context, resolveFallback: cfg.resolveFallback('gemini', 'live'),
    ...audio.options, random: () => 0.5 });
  const sockList = () => own.sockets;
  const frame = (value = 0.25) => node.port.onmessage?.({ data: new Float32Array(1024).fill(value) });
  const start = (request = {}) => engine.start({ targetLanguage: 'ko', ...request },
    { providerId: 'gemini', keySource: 'personal', sessionId: `lane-${Math.random().toString(16).slice(2)}` });
  async function open(socket = sockList().at(-1)) {
    socket.open(); socket.json({ setupComplete: {} }); await tick();
    return socket;
  }
  async function running() {
    const handle = start(); await tick(); frame(); await tick(); await open(); await handle.ready; return handle;
  }
  return { engine, config: cfg, manager: mgr, audio, track, frame, start, open, running,
    sockets: sockList(), micCalls: () => micCalls,
    async close() {
      const closing = engine.close();
      for (const socket of sockList()) socket.finishClose();
      await closing; await mgr.close(); await cfg.dispose();
    } };
}

test('isolated managers hold leases at once and never block, retire or close each other', async () => {
  const closes = { a: 0, b: 0 }, events = { a: 0, b: 0 };
  const a = createSessionManager({ isolated: true });
  const b = createSessionManager({ isolated: true });
  let contextA, contextB;
  const leaseA = await a.replace((value) => { contextA = value; return session(async () => { closes.a++; }); },
    context({ onEvent() { events.a++; } }));
  // B opens while A is live: with the shared slot this would retire A first.
  const leaseB = await b.replace((value) => { contextB = value; return session(async () => { closes.b++; }); },
    context({ onEvent() { events.b++; } }));
  assert.deepEqual([a.occupied, b.occupied], [true, true]);
  assert.deepEqual([contextA.signal.aborted, contextB.signal.aborted], [false, false]);
  assert.deepEqual([a.isCurrent(leaseA.generation), b.isCurrent(leaseB.generation)], [true, true]);
  assert.deepEqual([closes.a, closes.b], [0, 0]);
  contextA.onEvent({ type: 'audio' }); contextB.onEvent({ type: 'audio' });
  assert.deepEqual(events, { a: 1, b: 1 });
  await leaseA.speak('a'); await leaseB.speak('b');

  // Replacing inside A retires only A's previous lease.
  const nextA = await a.replace(() => session(async () => { closes.a++; }), context());
  assert.deepEqual([closes.a, closes.b], [1, 0]);
  await assert.rejects(leaseA.speak('old'), code('SESSION_CLOSED'));
  assert.equal(contextA.signal.aborted, true);
  assert.equal(contextB.signal.aborted, false);
  assert.equal(b.isCurrent(leaseB.generation), true);
  // Generation counters are per slot: A spent two, B one.
  assert.deepEqual([a.generation, b.generation], [2, 1]);

  // Closing A never touches B.
  await a.close();
  assert.deepEqual([closes.a, closes.b], [2, 0]);
  assert.deepEqual([a.occupied, b.occupied], [false, true]);
  await leaseB.speak('still usable');
  await assert.rejects(nextA.speak('closed'), code('SESSION_CLOSED'));
  await b.close();
  assert.deepEqual([closes.a, closes.b, b.occupied], [2, 1, false]);
});

test('an isolated slot is invisible to the shared slot and to every other isolated slot', async () => {
  const seen = { a: [], b: [], shared: [] };
  const a = createSessionManager({ isolated: true });
  const b = createSessionManager({ isolated: true });
  const shared = createSessionManager();
  a.subscribe((state) => seen.a.push(state));
  b.subscribe((state) => seen.b.push(state));
  shared.subscribe((state) => seen.shared.push(state));
  const leaseA = await a.replace(() => session(), context());
  assert.ok(seen.a.length > 0, 'the owner of the slot is notified');
  assert.deepEqual([seen.b.length, seen.shared.length], [0, 0], 'nobody else is');
  assert.deepEqual([a.occupied, b.occupied, shared.occupied, createSessionManager().occupied], [true, false, false, false],
    'an isolated lease leaves the default slot free for other managers too');
  assert.deepEqual([a.generation, b.generation], [1, 0], 'generation counters are per slot');

  const sharedLease = await shared.replace(() => session(), context());
  assert.ok(seen.shared.length > 0);
  const notifiedA = seen.a.length;
  assert.deepEqual([shared.occupied, a.occupied, b.occupied], [true, true, false]);
  assert.equal(seen.b.length, 0);
  assert.equal(a.isCurrent(leaseA.generation), true, 'a shared open does not retire an isolated lease');
  await sharedLease.close();
  assert.equal(seen.a.length, notifiedA, 'closing the shared lease does not notify an isolated slot');
  assert.deepEqual([shared.occupied, a.occupied], [false, true]);
  await leaseA.close();
  assert.equal(a.occupied, false);
});

test('a failed close poisons only its own isolated slot, never another one or the shared slot', async () => {
  const a = createSessionManager({ isolated: true });
  const b = createSessionManager({ isolated: true });
  const shared = createSessionManager();
  const leaseA = await a.replace(async () => session(async () => { throw new Error('SECRET'); }), context());
  await assert.rejects(leaseA.close(),
    (error) => error.code === 'PROVIDER_ERROR' && !JSON.stringify(error).includes('SECRET'));
  assert.equal(a.occupied, true, 'a slot whose close failed stays occupied (never fail open)');
  await assert.rejects(a.replace(() => { assert.fail('the poisoned slot must not open'); }, context()), code('PROVIDER_ERROR'));

  // The other slots still open and close normally.
  const leaseB = await b.replace(async () => session(), context());
  assert.equal(b.occupied, true);
  await leaseB.close();
  assert.equal(b.occupied, false);
  const leaseShared = await shared.replace(async () => session(), context());
  assert.equal(shared.occupied, true);
  await leaseShared.close();
  assert.equal(shared.occupied, false);
  assert.equal(a.occupied, true, 'and the poisoned slot is still poisoned');
});

test('default managers still share one slot, and only a literal true isolates (regression of existing behavior)', async () => {
  const first = createSessionManager();
  const second = createSessionManager();
  // Truthy but not `true` must not opt in: the flag is deliberately strict.
  const truthy = createSessionManager({ isolated: 1 });
  const text = createSessionManager({ isolated: 'true' });
  const closed = deferred();
  const lease = await first.replace(() => session(() => closed.promise), context());
  assert.deepEqual([second.occupied, truthy.occupied, text.occupied], [true, true, true]);
  assert.equal(second.isCurrent(lease.generation), true);
  assert.equal(second.generation, first.generation);

  let opened = false;
  const pending = second.replace(() => { opened = true; return session(); }, context({ providerId: 'beta' }));
  await tick();
  assert.equal(opened, false, 'a second manager waits for the first lease to be confirmed closed');
  closed.resolve();
  const next = await pending;
  assert.equal(opened, true);
  assert.equal(first.isCurrent(lease.generation), false);
  await assert.rejects(lease.speak('old'), code('SESSION_CLOSED'));
  await next.close();
  assert.deepEqual([first.occupied, second.occupied, truthy.occupied, text.occupied], [false, false, false, false]);
});

test('createAppConfig({ isolated: true }) owns a private Live slot; dispose() closes only its own slot and key store', async () => {
  const closes = { a: 0, b: 0, shared: 0 };
  const a = createAppConfig({ isolated: true, ...configEnv() });
  const b = createAppConfig({ isolated: true, ...configEnv() });
  const shared = createAppConfig({ ...configEnv() });
  const alsoShared = createAppConfig({ ...configEnv() });
  const notStrict = createAppConfig({ isolated: 'yes', ...configEnv() });
  for (const config of [a, b, shared]) { config.keyStore.setPersonal('gemini', fakeKey()); config.keyStore.select('gemini', 'personal'); }
  const occupied = () => [a, b, shared, alsoShared, notStrict].map((config) => config.sessionManager.occupied);
  assert.equal(new Set([a.sessionManager, b.sessionManager, shared.sessionManager]).size, 3);
  assert.deepEqual(occupied(), [false, false, false, false, false]);

  await a.sessionManager.replace(() => session(async () => { closes.a++; }), context());
  assert.deepEqual(occupied(), [true, false, false, false, false]);
  await b.sessionManager.replace(() => session(async () => { closes.b++; }), context());
  assert.deepEqual(occupied(), [true, true, false, false, false], 'a second isolated config does not retire the first');
  await shared.sessionManager.replace(() => session(async () => { closes.shared++; }), context());
  assert.deepEqual(occupied(), [true, true, true, true, true], 'configs without the flag (or with a non-true flag) share the default slot');
  assert.deepEqual(closes, { a: 0, b: 0, shared: 0 });

  await a.dispose();
  assert.deepEqual(closes, { a: 1, b: 0, shared: 0 });
  assert.deepEqual(occupied(), [false, true, true, true, true]);
  assert.throws(() => a.keyStore.getCredentialRef(address), (error) => typeof error.code === 'string',
    'a disposed config no longer hands out credentials');
  assert.equal(typeof b.keyStore.getCredentialRef(address).reference, 'object', 'the other lane still can');

  await shared.dispose();
  assert.deepEqual(closes, { a: 1, b: 0, shared: 1 });
  assert.deepEqual(occupied(), [false, true, false, false, false]);
  await b.dispose();
  assert.deepEqual(closes, { a: 1, b: 1, shared: 1 });
  assert.deepEqual(occupied(), [false, false, false, false, false]);
});

test('two-lane sim: two isolated configs both run, stay separate, and stopping A leaves B running', async (t) => {
  const a = lane(), b = lane();
  t.after(() => a.close());
  t.after(() => b.close());
  assert.notEqual(a.config.sessionManager, b.config.sessionManager);
  const handleA = await a.running();
  const handleB = await b.running();
  assert.deepEqual([a.engine.snapshot().status, b.engine.snapshot().status], ['running', 'running']);
  assert.deepEqual([a.engine.snapshot().retries, b.engine.snapshot().retries], [0, 0]);
  assert.deepEqual([a.sockets.length, b.sockets.length], [1, 1], 'one Live socket per lane');
  assert.deepEqual([a.micCalls(), b.micCalls()], [1, 1]);
  assert.deepEqual([a.config.sessionManager.occupied, b.config.sessionManager.occupied], [true, true]);
  assert.equal(createSessionManager().occupied, false, 'the default slot stays free while both lanes run');

  // Captions never cross lanes.
  const [socketA] = a.sockets, [socketB] = b.sockets;
  content(socketA, { inputTranscription: { text: 'from-a' }, outputTranscription: { text: 'to-a' } });
  content(socketB, { inputTranscription: { text: 'from-b' }, outputTranscription: { text: 'to-b' } });
  await tick();
  const texts = (lane_) => lane_.engine.snapshot().captions.captions.flatMap((row) => [row.sourceText, row.translatedText].filter(Boolean));
  assert.deepEqual(texts(a).sort(), ['from-a', 'to-a']);
  assert.deepEqual(texts(b).sort(), ['from-b', 'to-b']);

  const stopped = await a.engine.stop();
  assert.equal(stopped.status, 'stopped');
  assert.equal((await handleA.done).status, 'stopped');
  assert.equal(a.config.sessionManager.occupied, false);
  assert.equal(a.track.stops, 1);
  // B never noticed.
  assert.equal(b.engine.snapshot().status, 'running');
  assert.equal(b.config.sessionManager.occupied, true);
  assert.deepEqual([socketB.closeCalls, b.track.stops], [0, 0]);
  const sentBefore = socketB.sent.length;
  b.frame(); b.audio.advance(0); await tick();
  // One fake 64 ms chunk is two 32 ms frames; both go out at once (2026-09-30:
  // the uplink no longer spaces frames 32 ms apart on its own).
  assert.equal(socketB.sent.length, sentBefore + 2, 'B keeps uploading audio');
  content(socketB, { outputTranscription: { text: 'still-b' }, ...audioContent });
  await tick();
  assert.ok(texts(b).some((text) => text.includes('still-b')), 'B keeps receiving captions');

  assert.equal((await b.engine.stop()).status, 'stopped');
  assert.equal((await handleB.done).status, 'stopped');
  assert.deepEqual([a.config.sessionManager.occupied, b.config.sessionManager.occupied], [false, false]);
});

test('one config for both lanes reproduces SESSION_LIMIT then BUDGET_EXHAUSTED for the second lane while the first keeps running', async (t) => {
  // Documents "one config per lane": the Live client inside a config allows one socket, so a
  // second lane over the same config is refused with SESSION_LIMIT. The engine treats that as
  // retryable (three replacements at 1/2/4 s), so it surfaces as BUDGET_EXHAUSTED.
  const a = lane();
  const b = lane({ config: a.config, manager: createSessionManager({ isolated: true, timeoutMs: 50 }) });
  t.after(() => b.close());
  t.after(() => a.close());
  const handleA = await a.running();
  const handleB = b.start(); await tick(); b.frame(); await tick();
  assert.equal(b.engine.snapshot().status, 'reconnecting', 'the refusal starts the automatic replacement');

  let result;
  const settled = handleB.done.then((value) => { result = value; });
  // Frames keep flowing while the backoff clock advances (the capture stalls without them).
  for (let elapsed = 0; !result && elapsed < 30000; elapsed += 250) { b.frame(); b.audio.advance(250); await tick(); }
  await settled;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'BUDGET_EXHAUSTED');
  assert.equal(result.retries, 3);
  assert.equal(b.engine.snapshot().status, 'failed');
  assert.equal(a.sockets.length, 1, 'the refused lane never got a socket');

  // The first lane was never disturbed.
  assert.equal(a.engine.snapshot().status, 'running');
  assert.equal(a.engine.snapshot().retries, 0);
  assert.equal(a.sockets[0].closeCalls, 0);
  assert.equal(a.track.stops, 0);
  assert.equal((await a.engine.stop()).status, 'stopped');
  assert.equal((await handleA.done).status, 'stopped');
});

test('one Live slot for both lanes: the second start is refused at once with SESSION_LIMIT and touches no device', async (t) => {
  const a = lane();
  const b = lane({ config: a.config, manager: a.config.sessionManager });
  t.after(() => b.close());
  t.after(() => a.close());
  await a.running();
  assert.throws(() => b.start(), { code: 'SESSION_LIMIT' });
  assert.equal(b.micCalls(), 0, 'the refusal comes before any capture is requested');
  assert.equal(b.engine.snapshot().status, 'idle');
  assert.equal(a.engine.snapshot().status, 'running');
});
