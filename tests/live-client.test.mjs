import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLiveClient, LIVE_ENDPOINT, LIVE_LIMITS } from '../app/providers/gemini/live-client.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { createSocketFixture, createClock, DelayedBlob, deferred, tick } from './fixtures/live.mjs';

const code = (value) => (error) => error.code === value && !`${error.stack}${JSON.stringify(error)}`.includes('SECRET');
const request = { setup: { model: 'models/gemini-3.1-flash-live-preview', generationConfig: { responseModalities: ['AUDIO'] } } };
function harness(socketOptions = {}, clientOptions = {}) {
  const fixture = createSocketFixture(socketOptions);
  const clock = createClock();
  const controller = new AbortController();
  const events = [];
  const context = { providerId: 'gemini', transport: 'direct', keySource: 'personal', credentialRef: {},
    signal: controller.signal, generation: 1, turnId: 'turn-1', sessionId: 'session-1', onEvent: (event) => events.push(event) };
  const client = createGeminiLiveClient({ ...fixture, ...clock, resolveCredential: async () => 'SECRET', ...clientOptions });
  return { ...fixture, clock, controller, events, context, client };
}
async function begin(h) {
  const opening = h.client.open(request, h.context);
  await tick();
  const ws = h.sockets.at(-1);
  ws.open();
  return { opening, ws };
}
async function ready(h) {
  const { opening, ws } = await begin(h);
  ws.json({ setupComplete: {} });
  return { ws, session: await opening };
}

test('waits for setupComplete, authenticates only at fixed endpoint, and sends setup once', async () => {
  const h = harness({ inspectURL(url) {
    const parsed = new URL(url);
    assert.equal(url.split('?')[0], LIVE_ENDPOINT);
    assert.equal(parsed.searchParams.get('key'), 'SECRET');
  } });
  const { opening, ws } = await begin(h);
  let settled = false; opening.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  assert.deepEqual(ws.sent, [request]);
  ws.emit('open'); assert.equal(ws.sent.length, 1);
  ws.json({ setupComplete: {} });
  const session = await opening;
  session.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'hello' }] }], turnComplete: true } });
  session.send({ realtimeInput: { audioStreamEnd: true } });
  assert.equal(ws.sent.length, 3);
  assert.equal(h.events[0].type, 'ready');
  assert.equal(h.events[0].generation, 1);
  assert.equal(h.events[0].turnId, 'turn-1');
  assert.equal('ws' in session, false);
  await session.close(); await session.closed;
  assert.equal(ws.listenerCount, 0); assert.equal(h.clock.size, 0);
});

for (const format of ['string', 'Blob', 'ArrayBuffer']) test(`decodes ${format} browser message data`, async () => {
  const h = harness(); const { session, ws } = await ready(h);
  const text = JSON.stringify({ serverContent: { outputTranscription: { text: '日本語 한국어' }, turnComplete: true } });
  ws.message(format === 'string' ? text : format === 'Blob' ? new Blob([text]) : new TextEncoder().encode(text).buffer);
  await tick();
  assert.equal(h.events[1].content.outputTranscription.text, '日本語 한국어');
  await session.close();
});

test('slow Blob preserves setup/content ordering against faster string and ArrayBuffer', async () => {
  const h = harness(); const { opening, ws } = await begin(h); const gate = deferred();
  ws.message(new DelayedBlob(JSON.stringify({ setupComplete: {} }), gate));
  ws.json({ serverContent: { outputTranscription: { text: 'first' } } });
  ws.message(new TextEncoder().encode(JSON.stringify({ serverContent: { turnComplete: true } })).buffer);
  assert.equal(h.events.length, 0);
  gate.resolve(); const session = await opening; await tick();
  assert.deepEqual(h.events.map((e) => e.type), ['ready', 'content', 'content']);
  assert.equal(h.events[1].content.outputTranscription.text, 'first');
  assert.equal(h.events[2].content.turnComplete, true);
  await session.close();
});

for (const phase of ['before-open', 'setup', 'ready']) test(`opaque error at ${phase} is NETWORK_ERROR, never IP_DENIED`, async () => {
  const h = harness();
  const opening = h.client.open(request, h.context);
  const rejection = phase === 'ready' ? null : assert.rejects(opening, code('NETWORK_ERROR'));
  await tick(); const ws = h.sockets[0];
  if (phase !== 'before-open') ws.open();
  if (phase === 'ready') { ws.json({ setupComplete: {} }); await opening; }
  ws.emit('error', { message: 'SECRET IP blocked', error: new Error('SECRET') });
  await rejection; await tick();
  assert.deepEqual(h.events.filter((e) => e.type === 'error').map((e) => e.error.code), ['NETWORK_ERROR']);
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
  assert.equal(ws.closeCalls, 1); assert.equal(ws.listenerCount, 0); assert.equal(h.clock.size, 0);
});

test('structured provider errors use existing normalization and retry metadata', async () => {
  const h = harness(); const { opening, ws } = await begin(h);
  const rejected = assert.rejects(opening, (error) => code('UNAVAILABLE')(error) && error.retryAfterMs === 9000);
  ws.json({ error: { code: 503, message: 'SECRET', details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9s' },
  ] } });
  await rejected;
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
});

for (const phase of ['credential', 'connect', 'setup']) test(`setup deadline covers ${phase} and discards late work`, async () => {
  const gate = deferred(); const h = harness({}, phase === 'credential' ? { resolveCredential: () => gate.promise } : {});
  const opening = h.client.open(request, h.context); const rejected = assert.rejects(opening, code('TIMEOUT'));
  await tick(); if (phase === 'setup') h.sockets[0].open();
  h.clock.advance(LIVE_LIMITS.setupTimeoutMs); await rejected;
  gate.resolve('SECRET'); await tick();
  assert.equal(h.sockets.length, phase === 'credential' ? 0 : 1);
  assert.equal(h.clock.size, 0);
});

test('close is idempotent, awaits confirmation, and drops in-flight Blob and captured listeners', async () => {
  const h = harness({ autoClose: false }); const { session, ws } = await ready(h); const gate = deferred();
  const late = [...ws.listeners.get('message')][0];
  ws.message(new DelayedBlob(JSON.stringify({ serverContent: { turnComplete: true } }), gate));
  let done = false; const closing = session.close(); closing.then(() => { done = true; });
  assert.equal(session.close(), closing); await tick(); assert.equal(done, false);
  gate.resolve(); late({ data: JSON.stringify({ serverContent: { interrupted: true } }) }); await tick();
  assert.equal(h.events.filter((e) => e.type === 'content').length, 0);
  ws.finishClose(); await closing;
  ws.finishClose(); assert.equal(h.events.filter((e) => e.type === 'closed').length, 1);
  assert.throws(() => session.send({ realtimeInput: {} }), code('SESSION_CLOSED'));
  assert.equal(h.clock.size, 0);
});

test('close timeout and throwing close retain ownership until physical closure', async () => {
  for (const throwClose of [false, true]) {
    const h = harness({ autoClose: false, throwClose }); const { session, ws } = await ready(h);
    const closing = session.close(); const rejected = assert.rejects(closing, code('TIMEOUT'));
    h.clock.advance(LIVE_LIMITS.closeTimeoutMs); await rejected;
    await assert.rejects(h.client.open(request, h.context), code('SESSION_LIMIT'));
    ws.finishClose(); await session.closed;
    assert.equal(ws.listenerCount, 0);
    const next = await ready(h); next.ws.finishClose(); await next.session.closed;
  }
});

test('remote close before setup rejects, abnormal ready close terminates without parsing reason', async () => {
  const h = harness(); const { opening, ws } = await begin(h);
  const rejected = assert.rejects(opening, code('SESSION_CLOSED')); ws.finishClose(); await rejected;
  const next = await ready(h); next.ws.finishClose(1008, 'SECRET IP blocked quota 429'); await next.session.closed;
  assert.equal(h.events.filter((e) => e.type === 'error').at(-1).error.code, 'NETWORK_ERROR');
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
});

test('goAway retires sends, keeps current output, and closes at the advertised deadline without reconnecting', async () => {
  const h = harness(); const { session, ws } = await ready(h);
  ws.json({ goAway: { timeLeft: '2.5s', secret: 'SECRET' } });
  ws.json({ goAway: { timeLeft: '50s' } });
  assert.throws(() => session.send({ clientContent: {} }), code('SESSION_CLOSED'));
  ws.json({ serverContent: { turnComplete: true } });
  assert.equal(h.events.at(-1).type, 'content');
  h.clock.advance(2499); assert.equal(ws.closeCalls, 0);
  h.clock.advance(1); await session.closed;
  assert.equal(h.events.filter((e) => e.type === 'goAway').length, 1);
  assert.equal(h.events.find((e) => e.type === 'goAway').timeLeftMs, 2500);
  assert.equal(h.sockets.length, 1); assert.equal(h.clock.size, 0);
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
});

test('goAway before setup fails; malformed duration has a bounded fallback', async () => {
  const h = harness(); const { opening, ws } = await begin(h);
  const rejected = assert.rejects(opening, code('UNAVAILABLE')); ws.json({ goAway: {} }); await rejected;
  const next = await ready(h); next.ws.json({ goAway: { timeLeft: 'SECRET' } });
  h.clock.advance(LIVE_LIMITS.setupTimeoutMs); await next.session.closed;
});

for (const data of ['{SECRET', 'null', '[]', new Uint8Array([255]).buffer, 4,
  'x'.repeat(LIVE_LIMITS.maxMessageBytes + 1)]) test(`invalid or oversized frame terminates safely (${typeof data}, ${data?.byteLength ?? data?.length ?? 0})`, async () => {
  const h = harness(); const { session, ws } = await ready(h);
  ws.message(data); await session.closed;
  assert.equal(h.events.find((e) => e.type === 'error').error.code, 'INVALID_RESULT');
  assert.equal(JSON.stringify(h.events).includes('SECRET'), false);
});

test('decode failure and timeout terminate; queued messages have count and byte bounds', async () => {
  for (const kind of ['reject', 'timeout', 'count', 'bytes']) {
    const h = harness(); const { session, ws } = await ready(h); const gate = deferred();
    ws.message(new DelayedBlob('{}', gate));
    if (kind === 'reject') gate.reject(new Error('SECRET decode'));
    if (kind === 'timeout') h.clock.advance(LIVE_LIMITS.decodeTimeoutMs);
    if (kind === 'count') for (let i = 0; i < LIVE_LIMITS.maxQueueMessages; i++) ws.json({});
    if (kind === 'bytes') for (let i = 0; i < 3; i++) ws.message(' '.repeat(LIVE_LIMITS.maxMessageBytes));
    await session.closed; gate.resolve(); await tick();
    assert.equal(h.events.find((e) => e.type === 'error').error.code, kind === 'timeout' ? 'TIMEOUT' : 'INVALID_RESULT');
    assert.equal(h.clock.size, 0);
  }
});

test('abort during decoding isolates subsequent generations and removes timers/listeners', async () => {
  const h = harness(); const { session, ws } = await ready(h); const gate = deferred();
  ws.message(new DelayedBlob(JSON.stringify({ serverContent: { outputTranscription: { text: 'old' } } }), gate));
  h.controller.abort('SECRET'); await session.closed;
  h.context = { ...h.context, signal: new AbortController().signal, generation: 2 };
  const next = await ready(h); next.ws.json({ serverContent: { outputTranscription: { text: 'new' } } });
  gate.resolve(); await tick();
  assert.deepEqual(h.events.filter((e) => e.type === 'content').map((e) => [e.generation, e.content.outputTranscription.text]), [[2, 'new']]);
  assert.equal(ws.listenerCount, 0); await next.session.close(); assert.equal(h.clock.size, 0);
});

test('preflight, resolver, constructor and send failures never retain raw exceptions', async () => {
  const h = harness();
  await assert.rejects(h.client.open(request, { ...h.context, signal: AbortSignal.abort('SECRET') }), code('ABORTED'));
  await assert.rejects(h.client.open(request, { ...h.context, providerId: 'other' }), code('CREDENTIAL_MISMATCH'));
  await assert.rejects(h.client.open(request, { ...h.context, credentialRef: null }), code('CREDENTIAL_REQUIRED'));
  await assert.rejects(h.client.open({ setup: { model: 'https://SECRET' } }, h.context), code('INVALID_REQUEST'));
  assert.equal(h.sockets.length, 0);
  for (const [resolveCredential, expected] of [
    [async () => { throw new Error('SECRET'); }, 'PROVIDER_ERROR'],
    [async () => '', 'CREDENTIAL_REQUIRED'],
  ]) {
    const bad = harness({}, { resolveCredential });
    await assert.rejects(bad.client.open(request, bad.context), code(expected));
    assert.equal(bad.clock.size, 0);
  }
  const bad = harness({ throwConstruct: true }); await assert.rejects(bad.client.open(request, bad.context), code('NETWORK_ERROR'));
  const sending = harness({ throwSend: true }); const pending = sending.client.open(request, sending.context);
  const rejected = assert.rejects(pending, code('NETWORK_ERROR')); await tick(); sending.sockets[0].open(); await rejected;
});

test('outbound validation, backpressure and consumer exceptions are bounded', async () => {
  const h = harness(); h.context.onEvent = () => { throw new Error('SECRET consumer'); };
  const { session, ws } = await ready(h);
  for (const message of [{ setup: {} }, { clientContent: {}, realtimeInput: {} }, { clientContent: { text: 'x'.repeat(LIVE_LIMITS.maxSendBytes) } }]) {
    assert.throws(() => session.send(message), code('INVALID_REQUEST'));
  }
  ws.bufferedAmount = LIVE_LIMITS.maxSendBytes;
  assert.throws(() => session.send({ realtimeInput: {} }), code('UNAVAILABLE')); await session.closed;
  assert.equal(ws.sent.length, 1); assert.equal(h.clock.size, 0);
});

test('manager replacement waits for closure of failed setup and drops old generations', async () => {
  const h = harness({ autoClose: false }); const manager = createSessionManager({ timeoutMs: 20 });
  const opening = manager.replace((ctx) => h.client.open(request, ctx), h.context);
  const rejected = assert.rejects(opening, code('TIMEOUT'));
  await tick(); const first = h.sockets[0]; first.open();
  h.clock.advance(LIVE_LIMITS.setupTimeoutMs); await rejected;
  assert.equal(manager.occupied, true);
  await assert.rejects(manager.replace((ctx) => h.client.open(request, ctx), h.context), code('TIMEOUT'));
  assert.equal(h.sockets.length, 1);
  first.finishClose(); await manager.close(); assert.equal(manager.occupied, false);
  const next = manager.replace((ctx) => h.client.open(request, ctx), h.context);
  await tick(); const second = h.sockets[1]; second.open(); second.json({ setupComplete: {} });
  const lease = await next; const closing = lease.close(); await tick(); second.finishClose(); await closing;
  assert.equal(h.clock.size, 0);
});

for (const phase of ['credential', 'connecting', 'setup']) test(`abort at ${phase} prevents late setup and socket creation`, async () => {
  const gate = deferred(); const h = harness({}, phase === 'credential' ? { resolveCredential: () => gate.promise } : {});
  const opening = h.client.open(request, h.context); const rejected = assert.rejects(opening, code('ABORTED'));
  await tick(); const ws = h.sockets[0];
  if (phase === 'setup') ws.open();
  h.controller.abort('SECRET'); await rejected;
  gate.resolve('SECRET'); ws?.open(); ws?.json({ setupComplete: {} }); await tick();
  assert.equal(h.events.some((e) => e.type === 'ready'), false);
  assert.equal(h.sockets.length, phase === 'credential' ? 0 : 1);
  assert.equal(h.clock.size, 0); assert.equal(ws?.listenerCount ?? 0, 0);
});

test('send failure after setup closes once without automatic resend', async () => {
  const h = harness(); const { session, ws } = await ready(h);
  let calls = 0;
  ws.send = () => { calls++; throw new Error('SECRET'); };
  assert.throws(() => session.send({ clientContent: { turnComplete: true } }), code('NETWORK_ERROR'));
  await session.closed;
  assert.equal(calls, 1); assert.equal(ws.closeCalls, 1);
});

test('setup acknowledgement must be an object and cannot precede socket open', async () => {
  for (const setupComplete of [null, true, {}]) {
    const h = harness(); const opening = h.client.open(request, h.context);
    const rejected = assert.rejects(opening, code('INVALID_RESULT')); await tick();
    if (setupComplete !== null && setupComplete !== true) {
      h.sockets[0].json({ setupComplete });
    } else {
      h.sockets[0].open(); h.sockets[0].json({ setupComplete });
    }
    await rejected;
  }
});
