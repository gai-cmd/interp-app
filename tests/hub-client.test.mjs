import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubClient, createHubControl, HUB_CLIENT_LIMITS, HUB_CONTROL_INITIAL_EPOCH } from '../app/hub/client.js';
import { HUB_LIMITS } from '../app/hub/protocol.js';
import { createSocketFixture, createClock, deferred, DelayedBlob, tick,
  hub, hello, caption, status, wire } from './fixtures/hub-socket.mjs';
import { EPOCH, EVENT_ID, controlHello, releaseSnapshot, snapshot } from './fixtures/hub.mjs';

function fixture(options = {}) {
  const clock = createClock(), transport = createSocketFixture(options);
  const events = [];
  const client = createHubClient({ hubs: [hub], ...transport, ...clock, limits: options.limits });
  const join = (context = {}) => client.join({ hubId: hub.id, roomCode: 'Test123' },
    { onEvent: (event) => events.push(event), ...context });
  return { clock, ...transport, events, client, join };
}
async function connected(f) {
  const operation = f.join(); await tick();
  f.sockets.at(-1).open(); f.sockets.at(-1).json(hello());
  await operation.ready;
  return operation;
}

test('registered audience URL only; hello is join success, silence needs no heartbeat', async () => {
  const urls = [], f = fixture({ inspectURL: (url) => urls.push(url) });
  assert.equal(f.sockets.length, 0);
  const op = await connected(f);
  assert.deepEqual(urls, [`${hub.url}?room=Test123`]);
  assert.equal(op.snapshot().state, 'running');
  assert.equal(f.events.some((e) => e.state === 'receiving' || e.state === 'connected'), false);
  f.clock.advance(3600000); await tick();
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.sockets[0].sent, []);
  assert.equal('send' in op, false);
  await op.close(); assert.equal(f.clock.size, 0);
  assert.equal(f.sockets[0].listenerCount, 0);
});

test('unregistered endpoints, URL-shaped room codes and pre-aborted joins never open', () => {
  const f = fixture();
  assert.throws(() => f.client.join({ hubId: 'https://evil.invalid', roomCode: 'a' }), { code: 'HUB_REQUIRED' });
  assert.throws(() => f.client.join({ hubId: hub.id, roomCode: 'a&role=source' }), { code: 'INVALID_REQUEST' });
  const c = new AbortController(); c.abort();
  assert.throws(() => f.join({ signal: c.signal }), { code: 'ABORTED' });
  assert.equal(f.sockets.length, 0);
});

test('hello deadline covers CONNECTING and retries exactly three times at 1/2/4 seconds', async () => {
  const f = fixture(), op = f.join(); await tick();
  for (const wait of [1000, 2000, 4000]) {
    f.clock.advance(10000); await tick();
    const count = f.sockets.length;
    f.clock.advance(wait - 1); await tick(); assert.equal(f.sockets.length, count);
    f.clock.advance(1); await tick(); assert.equal(f.sockets.length, count + 1);
  }
  f.clock.advance(10000); await tick();
  assert.equal((await op.done).error.code, 'BUDGET_EXHAUSTED');
  await op.closed; assert.equal(f.clock.size, 0);
});

test('Blob, ArrayBuffer and text preserve arrival order across languages and status', async () => {
  const f = fixture(), op = await connected(f), gate = deferred(), socket = f.sockets[0];
  socket.message(new DelayedBlob(wire(caption({ seq: 1 })), gate));
  socket.message(new TextEncoder().encode(wire(caption({ lang: 'en', seq: 2 }))).buffer);
  socket.json(caption({ lang: 'src', seq: 3 })); socket.json(status());
  await tick(); assert.equal(f.events.filter((e) => e.type === 'caption').length, 0);
  gate.resolve(); await tick();
  assert.deepEqual(f.events.filter((e) => e.type === 'caption').map((e) => e.seq), [1, 2, 3]);
  assert.equal(f.events.at(-1).type, 'status');
  assert.equal(op.snapshot().pendingBytes, 0);
  await op.close();
});

for (const type of ['cast.stopped', 'closed', 'outside', 'denied']) {
  test(`${type} is terminal even when delayed Blob is followed by socket close`, async () => {
    const f = fixture(), op = await connected(f), gate = deferred();
    f.sockets[0].message(new DelayedBlob(wire({ type, reason: 'SECRET' }), gate));
    f.sockets[0].finishClose(); await tick(); gate.resolve(); await tick();
    const result = await op.done;
    assert.equal(result.state, ['outside', 'denied'].includes(type) ? 'failed' : 'stopped');
    f.clock.advance(60000); await tick(); assert.equal(f.sockets.length, 1);
    assert.equal(JSON.stringify([result, f.events]).includes('SECRET'), false);
    await op.closed;
  });
}

for (const kind of ['message', 'count', 'bytes']) {
  test(`${kind} receive bound includes in-flight Blob and recovers after confirmed close`, async () => {
    const f = fixture(), op = await connected(f), socket = f.sockets[0], gate = deferred();
    if (kind === 'message') socket.message('x'.repeat(HUB_CLIENT_LIMITS.messageBytes + 1));
    else {
      const raw = kind === 'bytes' ? ' '.repeat(1048576) : wire(caption());
      socket.message(new DelayedBlob(raw, gate));
      const count = kind === 'bytes' ? 2 : 128;
      for (let i = 0; i < count; i++) socket.message(raw);
    }
    await tick();
    assert.equal(socket.closeCalls, 1);
    assert.equal(op.snapshot().pendingMessages, 0);
    assert.ok(op.snapshot().maxMessages <= 128);
    assert.ok(op.snapshot().maxBytes <= 2097152);
    f.clock.advance(1000); await tick(); assert.equal(f.sockets.length, 2);
    gate.resolve(); await tick();
    assert.equal(f.events.filter((e) => e.type === 'caption').length, 0);
    await op.close();
  });
}

test('close deadline fails UI but retains ownership until late physical close', async () => {
  const f = fixture({ autoClose: false }), op = await connected(f);
  f.sockets[0].emit('error', { error: new Error('SECRET') }); await tick();
  let closed = false; op.closed.then(() => { closed = true; });
  f.clock.advance(5000); await tick();
  assert.equal((await op.done).error.code, 'TIMEOUT'); assert.equal(closed, false);
  assert.throws(() => f.join(), { code: 'SESSION_LIMIT' });
  f.clock.advance(60000); await tick(); assert.equal(f.sockets.length, 1);
  f.sockets[0].finishClose(); await op.closed;
  const next = f.join(); await tick();
  const stopping = next.close(); f.sockets[1].finishClose(); await stopping;
});

test('error recovery waits for physical close before starting the retry delay', async () => {
  const f = fixture({ autoClose: false }), op = await connected(f);
  f.sockets[0].emit('error'); await tick();
  f.clock.advance(2000); await tick(); assert.equal(f.sockets.length, 1);
  f.sockets[0].finishClose(); await tick();
  f.clock.advance(999); await tick(); assert.equal(f.sockets.length, 1);
  f.clock.advance(1); await tick(); assert.equal(f.sockets.length, 2);
  const stopping = op.close(); f.sockets[1].finishClose(); await stopping;
});

test('brief hellos do not reset budget; 60 seconds of stable joined silence does', async () => {
  const f = fixture(), op = await connected(f);
  for (const wait of [1000, 2000, 4000]) {
    f.sockets.at(-1).finishClose(1006); await tick(); f.clock.advance(wait); await tick();
    f.sockets.at(-1).json(hello()); await tick();
  }
  f.clock.advance(60000);
  f.sockets.at(-1).finishClose(1006); await tick();
  f.clock.advance(1000); await tick(); assert.equal(f.sockets.length, 5);
  await op.close();
});

test('short successful joins exhaust budget and manual join resets it', async () => {
  const f = fixture(), op = await connected(f);
  for (const wait of [1000, 2000, 4000]) {
    f.sockets.at(-1).finishClose(1006); await tick(); f.clock.advance(wait); await tick();
    f.sockets.at(-1).json(hello()); await tick();
  }
  f.sockets.at(-1).finishClose(1006); await tick();
  assert.equal((await op.done).error.code, 'BUDGET_EXHAUSTED'); await op.closed;
  const next = await connected(f); await next.close();
});

for (const phase of ['before-open', 'hello', 'blob', 'retry']) {
  test(`cancellation during ${phase} suppresses late work and releases timers`, async () => {
    const f = fixture(), c = new AbortController(), op = f.join({ signal: c.signal }), gate = deferred();
    if (phase !== 'before-open') {
      await tick();
      if (phase === 'blob') f.sockets[0].message(new DelayedBlob(wire(hello()), gate));
      if (phase === 'retry') { f.sockets[0].finishClose(1006); await tick(); }
    }
    c.abort(); await op.closed;
    const count = f.events.length;
    gate.resolve(); f.clock.advance(100000); await tick();
    assert.equal((await op.done).error.code, 'ABORTED');
    assert.equal(f.events.length, count); assert.equal(f.clock.size, 0);
    assert.ok(f.sockets.every((s) => s.listenerCount === 0));
  });
}

test('malformed frames and raw fatal details never escape as errors or trigger quota retries', async () => {
  const f = fixture(), op = await connected(f);
  f.sockets[0].json(status('fatal'));
  assert.equal(f.events.at(-1).state, 'fatal');
  assert.equal('detail' in f.events.at(-1), false);
  f.sockets[0].message('{SECRET'); await tick();
  assert.equal((await op.done).error.code, 'INVALID_RESULT');
  assert.equal(JSON.stringify(f.events).includes('SECRET'), false);
  await op.closed;
});

test('constructor failures are sanitized and retry cancellation performs no external work', async () => {
  const f = fixture({ throwConstruct: true }), op = f.join(); await tick();
  await op.close(); assert.equal((await op.done).error.code, 'ABORTED');
  assert.equal(f.clock.size, 0);
});

test('stalled Blob decode terminates without an unbounded drain', async () => {
  const f = fixture(), op = await connected(f), gate = deferred();
  f.sockets[0].message(new DelayedBlob(wire(caption()), gate)); await tick();
  f.clock.advance(10000); await tick();
  assert.equal((await op.done).error.code, 'TIMEOUT');
  await op.closed; gate.resolve(); await tick();
  assert.equal(f.events.filter((e) => e.type === 'caption').length, 0);
});

test('audience join and recovery never access credentials, microphone, fetch or storage', async () => {
  const names = ['navigator', 'fetch', 'localStorage', 'sessionStorage'];
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let accesses = 0;
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true,
      get() { accesses++; throw new Error('SECRET'); } });
    const f = fixture(), op = await connected(f);
    f.sockets[0].finishClose(1006); await tick(); f.clock.advance(1000); await tick();
    f.sockets[1].json(hello()); f.sockets[1].json(caption({ final: true }));
    await op.close();
    assert.equal(accesses, 0);
    assert.ok(f.sockets.every((socket) => socket.sent.length === 0));
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('throwing close does not certify shutdown and idempotent close waits for evidence', async () => {
  const f = fixture({ throwClose: true }), op = await connected(f);
  const first = op.close(), second = op.close();
  const failures = Promise.all([assert.rejects(first, { code: 'TIMEOUT' }),
    assert.rejects(second, { code: 'TIMEOUT' })]);
  await tick(); f.clock.advance(5000); await failures;
  assert.equal((await op.done).error.code, 'TIMEOUT');
  assert.equal(f.sockets[0].closeCalls, 1);
  assert.throws(() => f.join(), { code: 'SESSION_LIMIT' });
  f.sockets[0].finishClose(); await op.closed;
  assert.equal(f.sockets[0].listenerCount, 0);
});

test('invalid UTF-8, duplicate hello and pre-hello captions fail safely', async () => {
  for (const input of [new Uint8Array([0xff]).buffer, wire(hello()), wire(caption())]) {
    const f = fixture(), op = f.join(); await tick();
    if (input === wire(hello())) f.sockets[0].json(hello());
    f.sockets[0].message(input); await tick();
    assert.equal((await op.done).error.code, 'INVALID_RESULT');
    await op.closed; assert.equal(f.sockets.length, 1);
  }
});

// --- P3-11: live-control negotiation on the audience socket (design-p3 §1.8) ---
const negotiation = (epoch, revision) => ({ type: 'hello', settings: {}, control: { version: 1, eventId: EVENT_ID, epoch, revision } });

test('a joined event sends the §1.8 hello once the socket opens; hello.control and snapshots arrive in order and nothing else is sent', async () => {
  const f = fixture(), op = f.join({ control: { eventId: EVENT_ID } }); await tick();
  const socket = f.sockets[0];
  assert.deepEqual(socket.sent, [], 'nothing before open');
  socket.open();
  assert.deepEqual(socket.sent, [negotiation(HUB_CONTROL_INITIAL_EPOCH, 0)]);
  socket.json(controlHello()); await op.ready;
  assert.deepEqual(f.events.find((e) => e.type === 'hello').control, { version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 12 });
  socket.json(snapshot()); socket.json(caption()); await tick();
  const types = f.events.filter((e) => e.type === 'control' || e.type === 'caption').map((e) => e.type);
  assert.deepEqual(types, ['control', 'caption']);
  const control = f.events.find((e) => e.type === 'control');
  assert.equal(control.revision, 13); assert.equal(control.stopped, true);
  assert.deepEqual([...control.disabledFeatures], ['simultaneousDirect']);
  assert.equal(control.notice.text.ko, '잠시 통역을 중지합니다.');
  assert.equal(socket.sent.length, 1, 'the hello is the only text ever sent');
  await op.close();
  assert.equal(socket.listenerCount, 0, 'the open listener is removed with the others');
  // A legacy hub answers without control: the consumer sees control null and listening continues.
  const g = fixture(), legacy = g.join({ control: { eventId: EVENT_ID, epoch: EPOCH, revision: 12 } }); await tick();
  g.sockets[0].open(); assert.deepEqual(g.sockets[0].sent, [negotiation(EPOCH, 12)]);
  g.sockets[0].json(hello()); await legacy.ready;
  assert.equal(g.events.find((e) => e.type === 'hello').control, null);
  assert.equal(legacy.snapshot().state, 'running');
  await legacy.close();
});

test('a control function is re-evaluated per attempt; null means a legacy hello-less attempt; a pre-hello snapshot is invalid', async () => {
  let current = { eventId: EVENT_ID };
  const f = fixture(), op = f.join({ control: () => current }); await tick();
  f.sockets[0].open(); f.sockets[0].json(controlHello()); await op.ready;
  current = { eventId: EVENT_ID, epoch: EPOCH, revision: 13 };
  f.sockets[0].finishClose(1006); await tick(); f.clock.advance(1000); await tick();
  f.sockets[1].open();
  assert.deepEqual(f.sockets[1].sent, [negotiation(EPOCH, 13)]);
  f.sockets[1].json(controlHello()); await tick();
  current = null;
  f.sockets[1].finishClose(1006); await tick(); f.clock.advance(2000); await tick();
  f.sockets[2].open();
  assert.deepEqual(f.sockets[2].sent, [], 'no event joined any more: nothing is sent');
  f.sockets[2].json(snapshot()); await tick();
  assert.equal((await op.done).error.code, 'INVALID_RESULT', 'a snapshot before hello is a malformed server');
  await op.closed;
});

test('a refused hello send is a connection failure with retries; malformed control input is the caller\'s error and leaks nothing', async () => {
  const f = fixture({ throwSend: true }), op = f.join({ control: { eventId: EVENT_ID } }); await tick();
  f.sockets[0].open(); await tick();
  assert.equal(f.sockets[0].closeCalls, 1);
  f.clock.advance(1000); await tick();
  assert.equal(f.sockets.length, 2, 'a failed send is retried like any connection failure');
  for (const wait of [2000, 4000, 10000]) { f.sockets.at(-1).open(); await tick(); f.clock.advance(wait); await tick(); }
  const result = await op.done;
  assert.equal(result.error.code, 'BUDGET_EXHAUSTED');
  assert.equal(JSON.stringify([result, f.events]).includes('SECRET'), false);
  await op.closed;
  assert.ok(f.sockets.every((socket) => socket.listenerCount === 0));
  assert.throws(() => f.join({ control: 'service' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => f.join({ control: ['service'] }), { code: 'INVALID_REQUEST' });
  assert.equal(f.sockets.length, 4);
  const g = fixture(), bad = g.join({ control: () => ({ eventId: 'https://evil.invalid/SECRET' }) }); await tick();
  g.sockets[0].open(); await tick();
  assert.equal((await bad.done).error.code, 'INVALID_REQUEST');
  assert.deepEqual(g.sockets[0].sent, []);
  assert.equal(JSON.stringify(g.events).includes('SECRET'), false);
  await bad.closed;
  assert.equal(g.clock.size, 0);
});

// --- createHubControl: the P3-10 state, defined in client.js until control.js exists ---
function controlFixture() {
  const clock = createClock(), changes = [];
  const control = createHubControl(clock);
  control.subscribe((value) => changes.push(value));
  return { clock, changes, control, parse: (message) => ({ ...message, type: 'control', disabledFeatures: [...message.disabledFeatures] }) };
}
const initialState = { supported: null, eventId: null, epoch: null, revision: null, stopped: false,
  disabledFeatures: [], notice: null, heartbeatLost: false, expiresAt: null };

test('control state: initial, negotiation, ordering, duplicates as heartbeat, other epoch or event ignored', () => {
  const { control, parse, clock, changes } = controlFixture();
  assert.deepEqual(control.snapshot(), initialState);
  assert.ok(Object.isFrozen(control.snapshot()));
  assert.equal(control.receive(parse(snapshot())), false, 'nothing is accepted before a negotiation');
  control.negotiate({ version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 12 });
  assert.equal(control.snapshot().supported, true);
  assert.equal(control.snapshot().revision, null, 'the hello revision is a hint; the first snapshot is accepted at any revision');
  assert.equal(control.snapshot().expiresAt, HUB_LIMITS.ttlMaxSeconds * 1000);
  assert.equal(control.receive(parse(snapshot({ epoch: 'other-epoch' }))), false);
  assert.equal(control.receive(parse(snapshot({ eventId: 'other-event' }))), false);
  assert.equal(control.receive({ ...parse(snapshot()), type: 'hello' }), false);
  assert.equal(control.receive(parse(snapshot())), true);
  const applied = control.snapshot();
  assert.equal(applied.revision, 13); assert.equal(applied.stopped, true);
  assert.deepEqual([...applied.disabledFeatures], ['simultaneousDirect']);
  assert.equal(applied.notice.id, 'pause-13'); assert.equal(applied.expiresAt, 60000);
  assert.ok(Object.isFrozen(applied.disabledFeatures));
  clock.advance(1000);
  const before = changes.length;
  assert.equal(control.receive(parse(snapshot())), false, 'a repeat is the heartbeat');
  assert.equal(control.snapshot().expiresAt, 61000, 'the heartbeat re-arms the TTL');
  assert.equal(changes.length, before + 1);
  assert.equal(control.receive(parse(releaseSnapshot({ revision: 12 }))), false, 'a lower revision never releases');
  assert.equal(control.snapshot().stopped, true);
  assert.equal(control.receive(parse(releaseSnapshot())), true);
  assert.deepEqual({ ...control.snapshot(), expiresAt: null }, { ...initialState, supported: true, eventId: EVENT_ID, epoch: EPOCH, revision: 14 });
  assert.throws(() => control.negotiate({ version: 1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => control.subscribe(null), { code: 'INVALID_REQUEST' });
  control.close();
});

test('control state: TTL expiry and disconnection only set heartbeatLost; the stop latch survives until a newer snapshot or reset', () => {
  const { control, parse, clock } = controlFixture();
  control.negotiate({ version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 0 });
  control.receive(parse(snapshot({ ttlSeconds: 10 })));
  clock.advance(9999); assert.equal(control.snapshot().heartbeatLost, false);
  clock.advance(1); assert.equal(control.snapshot().heartbeatLost, true);
  assert.equal(control.snapshot().stopped, true, 'expiry does not release');
  assert.equal(control.receive(parse(snapshot({ ttlSeconds: 10 }))), false);
  assert.equal(control.snapshot().heartbeatLost, false, 'the heartbeat clears the loss');
  control.disconnected();
  assert.equal(control.snapshot().heartbeatLost, true);
  assert.equal(control.snapshot().expiresAt, null);
  assert.equal(control.snapshot().stopped, true, 'disconnection does not release');
  assert.equal(clock.size, 0, 'no timer while disconnected');
  // Same epoch again: revision ordering continues and the latch stays.
  control.negotiate({ version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 13 });
  assert.equal(control.snapshot().heartbeatLost, false);
  assert.equal(control.snapshot().revision, 13); assert.equal(control.snapshot().stopped, true);
  assert.equal(control.receive(parse(releaseSnapshot({ revision: 13 }))), false);
  assert.equal(control.snapshot().stopped, true);
  // A new epoch (broadcast restart) accepts its first snapshot at any revision.
  control.negotiate({ version: 1, eventId: EVENT_ID, epoch: 'next-epoch', revision: 0 });
  assert.equal(control.snapshot().revision, null); assert.equal(control.snapshot().stopped, true);
  assert.equal(control.receive(parse(releaseSnapshot({ epoch: 'next-epoch', revision: 1 }))), true);
  assert.equal(control.snapshot().stopped, false);
  // A hub without the extension after a stop: unsupported, nothing released.
  control.receive(parse(snapshot({ epoch: 'next-epoch', revision: 2 })));
  control.negotiate(null);
  assert.equal(control.snapshot().supported, false);
  assert.equal(control.snapshot().stopped, true);
  assert.equal(control.receive(parse(snapshot({ epoch: 'next-epoch', revision: 3 }))), false);
  clock.advance(120000);
  assert.equal(control.snapshot().heartbeatLost, false, 'an unsupported hub has no heartbeat to lose');
  control.reset();
  assert.deepEqual(control.snapshot(), initialState);
  assert.equal(clock.size, 0);
  control.close();
  control.negotiate({ version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 0 });
  assert.deepEqual(control.snapshot(), initialState, 'closed state changes nothing');
  assert.throws(() => createHubControl({ now: 'later' }), { code: 'INVALID_REQUEST' });
});
