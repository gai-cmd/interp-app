import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubClient, HUB_CLIENT_LIMITS } from '../app/hub/client.js';
import { createSocketFixture, createClock, deferred, DelayedBlob, tick,
  hub, hello, caption, status, wire } from './fixtures/hub-socket.mjs';

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
