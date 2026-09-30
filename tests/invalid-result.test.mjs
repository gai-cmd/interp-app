// 2026-09-30: the owner's runs ended with INVALID_RESULT and nothing said why,
// and one refused server message ended the whole interpretation. Three things
// are pinned here, with fake sockets, fake audio and fake timers only:
// (a) every Live INVALID_RESULT names a fixed reason that reaches the snapshot
//     and the metrics as an identifier,
// (b) a harmless per-part audio anomaly is skipped or repaired, not fatal,
// (c) an INVALID_RESULT that ends a connection is replaced within the existing
//     budget before it may end the operation.
// The contract module is read through its namespace so that each test fails on
// its own assertions where these exports do not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../app/providers/contract.js';
import { createGeminiLive } from '../app/providers/gemini/live.js';
import { createGeminiLiveClient, LIVE_LIMITS } from '../app/providers/gemini/live-client.js';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS } from '../app/providers/gemini/live-config.js';
import { createLiveRecovery } from '../app/engine/live-recovery.js';
import { createListenMetrics } from '../app/engine/listen-metrics.js';
import { fakeClock, fakeLive, pcmContent, request } from './fixtures/gemini-live.mjs';
import { createSocketFixture, createClock, DelayedBlob, deferred, tick } from './fixtures/live.mjs';
import { simFixture, content, audioContent } from './fixtures/sim.mjs';

const { ProviderError, normalizeError } = contract;
const b64 = (...bytes) => btoa(String.fromCharCode(...bytes));
// part(data) is playable PCM; part(data, undefined) has no mimeType at all.
const part = (data, ...mime) => ({ inlineData: { data,
  ...(mime.length === 0 ? { mimeType: 'audio/pcm;rate=24000' } : mime[0] === undefined ? {} : { mimeType: mime[0] }) } });
const parts = (...list) => ({ modelTurn: { parts: list } });
const leaks = (value) => JSON.stringify(value).includes('SECRET');

// ---------------------------------------------------------------- (a) contract

test('(a) the reasons are a closed, frozen list of short identifiers', () => {
  const reasons = contract.INVALID_RESULT_REASONS;
  assert.ok(Array.isArray(reasons) && Object.isFrozen(reasons));
  assert.equal(new Set(reasons).size, reasons.length);
  for (const reason of reasons) assert.match(reason, /^[a-z][a-z-]{1,31}$/);
  assert.deepEqual([...reasons], [
    'message-type', 'message-size', 'queue-overflow', 'message-parse', 'message-shape',
    'setup-shape', 'content-shape', 'content-size', 'flag-shape', 'transcript-shape', 'transcript-size',
    'parts-shape', 'audio-encoding', 'audio-size', 'audio-mime', 'audio-empty', 'audio-odd-bytes',
    'goaway-shape', 'client-handler', 'adapter-handler', 'event-handler']);
  for (const reason of reasons) assert.equal(contract.isInvalidResultReason(reason), true);
  for (const value of ['SECRET text', 'Audio-Mime', '', undefined, null, 42, {}, ['audio-mime'], 'toString', '__proto__']) {
    assert.equal(contract.isInvalidResultReason(value), false);
  }
  // The event the adapter uses for a skipped or repaired part is a listed stream event.
  assert.deepEqual([...contract.STREAM_EVENT_FIELDS.anomaly], ['reason', 'dropped']);
});

test('(a) only a listed reason rides on an INVALID_RESULT, and it survives normalization', () => {
  const error = contract.invalidResult('audio-encoding');
  assert.ok(error instanceof ProviderError);
  assert.deepEqual([error.code, error.reason, error.message], ['INVALID_RESULT', 'audio-encoding', 'INVALID_RESULT']);
  assert.equal(Object.hasOwn(contract.invalidResult('SECRET free text'), 'reason'), false);
  assert.equal(Object.hasOwn(contract.invalidResult(), 'reason'), false);
  // Twice through normalizeError, as between the transport, the adapter, the router and the engine.
  const twice = normalizeError(normalizeError(error));
  assert.notEqual(twice, error);
  assert.deepEqual([twice.code, twice.reason], ['INVALID_RESULT', 'audio-encoding']);
  // Free text, a reason on another code, and a provider normalizer's invention are all dropped.
  const dirty = Object.assign(new ProviderError('INVALID_RESULT'), { reason: 'SECRET provider text' });
  assert.equal(Object.hasOwn(normalizeError(dirty), 'reason'), false);
  const other = Object.assign(new ProviderError('NETWORK_ERROR'), { reason: 'audio-encoding' });
  assert.equal(Object.hasOwn(normalizeError(other), 'reason'), false);
  const invented = normalizeError(new Error('raw'), () => ({ code: 'INVALID_RESULT', reason: 'SECRET' }));
  assert.deepEqual([invented.code, Object.hasOwn(invented, 'reason')], ['INVALID_RESULT', false]);
  const listed = normalizeError(new Error('raw'), () => ({ code: 'INVALID_RESULT', reason: 'message-parse' }));
  assert.equal(listed.reason, 'message-parse');
  assert.equal(leaks([normalizeError(dirty), invented]), false);
});

// --------------------------------------------------------------- (a) transport

const setup = { setup: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } } };
function clientHarness(clientOptions = {}) {
  const fixture = createSocketFixture();
  const clock = createClock(), controller = new AbortController(), events = [];
  const context = { providerId: 'gemini', transport: 'direct', keySource: 'personal', credentialRef: {},
    signal: controller.signal, generation: 1, turnId: 'turn-1', sessionId: 'session-1', onEvent: (event) => events.push(event) };
  const client = createGeminiLiveClient({ ...fixture, ...clock, resolveCredential: async () => 'SECRET', ...clientOptions });
  return { ...fixture, clock, events, context, client };
}
async function clientReady(h) {
  const opening = h.client.open(setup, h.context);
  await tick();
  const ws = h.sockets.at(-1);
  ws.open(); ws.json({ setupComplete: {} });
  return { ws, session: await opening };
}
const clientError = (h) => h.events.find((event) => event.type === 'error')?.error;

for (const [label, send, reason] of [
  ['a frame that is neither text nor binary', (ws) => ws.message(4), 'message-type'],
  ['one oversized frame', (ws) => ws.message('x'.repeat(LIVE_LIMITS.maxMessageBytes + 1)), 'message-size'],
  ['broken JSON', (ws) => ws.message('{SECRET'), 'message-parse'],
  ['bytes that are not UTF-8', (ws) => ws.message(new Uint8Array([255]).buffer), 'message-parse'],
  ['a Blob that cannot be read', (ws) => { const gate = deferred(); ws.message(new DelayedBlob('{}', gate)); gate.reject(new Error('SECRET decode')); }, 'message-parse'],
  ['JSON null', (ws) => ws.message('null'), 'message-shape'],
  ['a JSON array', (ws) => ws.message('[]'), 'message-shape'],
  ['serverContent that is not an object', (ws) => ws.json({ serverContent: 'SECRET' }), 'content-shape'],
  ['too many queued frames', (ws) => { ws.message(new DelayedBlob('{}', deferred())); for (let i = 0; i < LIVE_LIMITS.maxQueueMessages; i++) ws.json({}); }, 'queue-overflow'],
  ['too many queued bytes', (ws) => { ws.message(new DelayedBlob('{}', deferred())); for (let i = 0; i < 3; i++) ws.message(' '.repeat(LIVE_LIMITS.maxMessageBytes)); }, 'queue-overflow'],
]) test(`(a) transport: ${label} ends the connection as INVALID_RESULT · ${reason}`, async () => {
  const h = clientHarness(); const { ws, session } = await clientReady(h);
  send(ws); await session.closed;
  const error = clientError(h);
  assert.deepEqual([error.code, error.reason], ['INVALID_RESULT', reason]);
  assert.equal(leaks(h.events), false);
  assert.equal(h.clock.size, 0);
});

test('(a) transport: a malformed or early setup acknowledgement, and content before setup, name their reason', async () => {
  for (const [send, reason] of [
    [(ws) => { ws.open(); ws.json({ setupComplete: null }); }, 'setup-shape'],
    [(ws) => { ws.json({ setupComplete: {} }); }, 'setup-shape'],
    [(ws) => { ws.open(); ws.json({ serverContent: {} }); }, 'content-shape'],
  ]) {
    const h = clientHarness();
    const opening = h.client.open(setup, h.context);
    const rejected = assert.rejects(opening, (error) => error.code === 'INVALID_RESULT' && error.reason === reason);
    await tick(); send(h.sockets[0]); await rejected;
    assert.equal(clientError(h).reason, reason);
  }
});

test('(a) transport: an exception inside its own message handling is client-handler, not a server fault in disguise', async () => {
  // The browser refuses a native timer called as a method; here the timer of the goAway backstop throws.
  const h = clientHarness();
  const schedule = h.clock.setTimeout;
  const client = createGeminiLiveClient({ WebSocket: h.WebSocket, resolveCredential: async () => 'SECRET',
    clearTimeout: h.clock.clearTimeout,
    setTimeout: (fn, ms) => { if (ms === 7777) throw new TypeError('Illegal invocation SECRET'); return schedule(fn, ms); } });
  const opening = client.open(setup, h.context);
  await tick();
  const ws = h.sockets.at(-1); ws.open(); ws.json({ setupComplete: {} });
  const session = await opening;
  ws.json({ goAway: { timeLeft: '7.777s' } }); await session.closed;
  const error = clientError(h);
  assert.deepEqual([error.code, error.reason], ['INVALID_RESULT', 'client-handler']);
  assert.equal(leaks(h.events), false);
});

// ----------------------------------------------------------------- (a) adapter

async function adapterHarness({ clock = fakeClock() } = {}) {
  const live = fakeLive(), events = [], controller = new AbortController();
  const context = { signal: controller.signal, sessionId: 'sim', generation: 2, turnId: 'turn',
    onEvent: (event) => events.push(event) };
  const session = await createGeminiLive({ live, clock }).open(request, context);
  return { live, clock, events, session,
    types: () => events.map((event) => event.type),
    audio: () => events.filter((event) => event.type === 'audio').map((event) => [...event.audio]),
    anomalies: () => events.filter((event) => event.type === 'anomaly').map((event) => [event.reason, event.dropped]),
    async close() { const closing = session.close(); live.confirm(); await closing; } };
}

for (const [label, value, reason] of [
  ['a part that is not an object', parts('SECRET'), 'parts-shape'],
  ['inlineData that is not an object', parts({ inlineData: 'SECRET' }), 'parts-shape'],
  ['a modelTurn that is not an object', { modelTurn: 'SECRET' }, 'parts-shape'],
  ['PCM data that is not a string', parts(part(42)), 'audio-encoding'],
  ['a transcription that is not an object', { outputTranscription: 'SECRET' }, 'transcript-shape'],
  ['interrupted that is not a boolean', { interrupted: 'SECRET' }, 'flag-shape'],
  ['generationComplete that is not a boolean', { generationComplete: 1 }, 'flag-shape'],
]) test(`(a) adapter: ${label} stays fatal and says ${reason}`, async () => {
  const h = await adapterHarness();
  h.live.content(value); h.live.content(pcmContent());
  await tick();
  assert.equal(h.live.closes, 1);
  assert.equal(h.events.length, 1);
  assert.deepEqual([h.events[0].type, h.events[0].error.code, h.events[0].error.reason], ['error', 'INVALID_RESULT', reason]);
  assert.equal(leaks(h.events), false);
  h.live.confirm();
});

test('(a) adapter: a goAway without a usable time is goaway-shape; a transport reason passes through untouched', async () => {
  const h = await adapterHarness();
  h.live.emit({ type: 'goAway', timeLeftMs: -1 });
  assert.deepEqual([h.events[0].error.code, h.events[0].error.reason], ['INVALID_RESULT', 'goaway-shape']);
  h.live.confirm();
  const g = await adapterHarness();
  g.live.emit({ type: 'error', error: contract.invalidResult('message-parse') });
  assert.deepEqual([g.events[0].error.code, g.events[0].error.reason], ['INVALID_RESULT', 'message-parse']);
  g.live.confirm();
});

test('(a) adapter: an exception inside its own event handling is adapter-handler (the 2026-09-30 "Illegal invocation")', async () => {
  // What the browser did that day: the caption assembler's timer threw, and it read as a malformed server message.
  const clock = { now: () => 0, clearTimeout() {}, setTimeout() { throw new TypeError('Illegal invocation SECRET'); } };
  const h = await adapterHarness({ clock });
  h.live.content({ outputTranscription: { text: 'partial' } });
  const error = h.events.at(-1).error;
  assert.deepEqual([h.events.at(-1).type, error.code, error.reason], ['error', 'INVALID_RESULT', 'adapter-handler']);
  assert.equal(leaks(h.events.at(-1)), false);
  h.live.confirm();
});

// ------------------------------------------------- (b) adapter: skip or repair

for (const mimeType of ['audio/pcm', 'audio/pcm;rate=24000', 'audio/pcm;rate=24000;channels=1', 'AUDIO/PCM; Rate=24000',
  'audio/pcm ; channels=1 ; rate=24000', 'audio/pcm;rate=24000;', 'audio/pcm; codec=s16le; rate=24000',
  'audio/pcm;rate="24000"']) {
  test(`(b) PCM at the Live rate is played whatever harmless parameters ride along: ${mimeType}`, async () => {
    const h = await adapterHarness();
    h.live.content(pcmContent('AQD/fw==', mimeType));
    assert.deepEqual(h.types(), ['audio']);
    assert.deepEqual(h.audio(), [[1, 0, 255, 127]]);
    assert.equal(h.events[0].sampleRate, 24000);
    assert.equal(h.live.closes, 0);
    await h.close();
  });
}

for (const [mimeType, dropped] of [['audio/pcm;rate=16000', true], ['audio/pcm;rate=24000evil', true],
  ['audio/pcm;rate=24000;channels=2', true], ['audio/pcm;rate=24000;rate=16000', true], ['audio/pcm;rate', true],
  ['audio/pcm;rate="48000"', true],
  ['audio/wav', true], ['audio/L16;rate=24000', true], ['image/png', false], [undefined, false], [42, false]]) {
  test(`(b) a part that is not playable is skipped and the session goes on: ${String(mimeType)}`, async () => {
    const h = await adapterHarness();
    h.live.content(parts(part('AQD/fw==', mimeType)));
    h.live.content(pcmContent());
    await tick();
    assert.deepEqual(h.types(), ['anomaly', 'audio']);
    assert.deepEqual(h.events[0], { type: 'anomaly', reason: 'audio-mime', dropped, turnId: 'turn', sessionId: 'sim', generation: 2 });
    assert.deepEqual(h.audio(), [[1, 0, 255, 127]], 'nothing of the unplayable part reaches the player');
    assert.equal(h.live.closes, 0);
    await h.close();
  });
}

test('(b) an audio part without data is skipped; nothing playable was lost with it', async () => {
  const h = await adapterHarness();
  h.live.content(pcmContent(''));
  h.live.content(pcmContent());
  assert.deepEqual(h.types(), ['anomaly', 'audio']);
  assert.deepEqual(h.anomalies(), [['audio-empty', false]]);
  assert.equal(h.live.closes, 0);
  await h.close();
});

test('(b) an odd byte count is carried into the next chunk of the turn, as a streaming PCM16 decoder does', async () => {
  const h = await adapterHarness();
  h.live.content(pcmContent(b64(1, 2, 3)));
  assert.deepEqual(h.audio(), [[1, 2]], 'the whole samples play now');
  h.live.content(pcmContent(b64(4, 5, 6)));
  assert.deepEqual(h.audio(), [[1, 2], [3, 4, 5, 6]], 'the dangling byte opens the next chunk: no sample is shifted or lost');
  h.live.content(pcmContent(b64(7)));
  assert.equal(h.audio().length, 2, 'half a sample alone is nothing to play yet');
  // An even chunk behind a dangling byte stays aligned too: it leaves its own last byte waiting.
  h.live.content(pcmContent(b64(8, 9)));
  h.live.content(pcmContent(b64(10)));
  assert.deepEqual(h.audio().slice(2), [[7, 8], [9, 10]]);
  assert.deepEqual(h.anomalies(), [['audio-odd-bytes', false], ['audio-odd-bytes', false], ['audio-odd-bytes', false],
    ['audio-odd-bytes', false]], 'each odd part is counted, the even one is not');
  for (const event of h.events.filter((item) => item.type === 'audio')) {
    assert.equal(event.audio.byteLength % 2, 0);
    assert.equal(event.audio.buffer.byteLength, event.audio.byteLength, 'an exact buffer, no stray byte behind the view');
  }
  assert.equal(h.live.closes, 0);
  await h.close();
});

test('(b) the carried byte never crosses a turn boundary, an interruption or a connection', async () => {
  const h = await adapterHarness();
  h.live.content({ ...pcmContent(b64(1, 2, 3)), turnComplete: true });
  h.live.content(pcmContent(b64(4, 5)));
  assert.deepEqual(h.audio(), [[1, 2], [4, 5]], 'dropped at turnComplete');
  h.live.content(pcmContent(b64(6, 7, 8)));
  h.live.content({ interrupted: true });
  h.live.content(pcmContent(b64(9, 10)));
  assert.deepEqual(h.audio().slice(2), [[6, 7], [9, 10]], 'dropped at interrupted');
  // generationComplete is not a boundary: the carry survives it.
  h.live.content({ ...pcmContent(b64(11, 12, 13)), generationComplete: true });
  h.live.content(pcmContent(b64(14)));
  assert.deepEqual(h.audio().slice(4), [[11, 12], [13, 14]]);
  h.live.content(pcmContent(b64(15)));
  await h.close();
  const next = await adapterHarness();
  next.live.content(pcmContent(b64(16, 17)));
  assert.deepEqual(next.audio(), [[16, 17]], 'a new connection starts clean');
  await next.close();
});

test('(b) a skipped part does not take its neighbours or the captions with it; a fatal part still takes the whole message', async () => {
  const h = await adapterHarness();
  h.live.content({ outputTranscription: { text: 'kept', finished: true },
    modelTurn: { parts: [part(b64(1, 2)), part('AQD/fw==', 'audio/pcm;rate=16000'), part(''), part(b64(3, 4))] } });
  assert.deepEqual(h.types(), ['anomaly', 'anomaly', 'subtitle', 'audio', 'audio']);
  assert.deepEqual(h.anomalies(), [['audio-mime', true], ['audio-empty', false]]);
  assert.deepEqual(h.audio(), [[1, 2], [3, 4]]);
  assert.equal(h.events[2].translatedText, 'kept');
  // Atomic as before: a message with a fatal part emits nothing of itself, not even its anomalies.
  const before = h.events.length;
  h.live.content({ outputTranscription: { text: 'must not leak' },
    modelTurn: { parts: [part('AQD/fw==', 'audio/wav'), part(b64(5, 6)), part('bad')] } });
  assert.deepEqual(h.types().slice(before), ['error']);
  assert.equal(h.events.at(-1).error.reason, 'audio-encoding');
  h.live.confirm();
});

test('(b) what an interruption cuts anyway is not reported as lost to the anomaly', async () => {
  const h = await adapterHarness();
  h.live.content({ interrupted: true, modelTurn: { parts: [part('AQD/fw==', 'audio/pcm;rate=16000')] } });
  assert.deepEqual(h.types(), ['anomaly', 'interrupted']);
  assert.deepEqual(h.anomalies(), [['audio-mime', false]]);
  await h.close();
});

// ---------------------------------------------------------------- (a) metrics

test('(a) metrics count INVALID_RESULT checks per fixed reason, and nothing but listed reasons', () => {
  const metrics = createListenMetrics({ now: () => 0 });
  assert.deepEqual(metrics.snapshot().invalidResults, {});
  let notified = 0; metrics.subscribe(() => notified++);
  assert.equal(metrics.invalidResult('audio-odd-bytes'), true);
  assert.equal(metrics.invalidResult('audio-odd-bytes'), true);
  assert.equal(metrics.invalidResult('flag-shape'), true);
  for (const value of ['SECRET text', '', undefined, null, 42, { reason: 'flag-shape' }, '__proto__', 'constructor']) {
    assert.equal(metrics.invalidResult(value), false);
  }
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.invalidResults, { 'audio-odd-bytes': 2, 'flag-shape': 1 });
  assert.ok(Object.isFrozen(snapshot.invalidResults));
  assert.equal(notified, 3);
  assert.equal(leaks(snapshot), false);
  metrics.stop();
  assert.equal(metrics.invalidResult('flag-shape'), false);
  assert.deepEqual(metrics.snapshot().invalidResults, { 'audio-odd-bytes': 2, 'flag-shape': 1 });
});

// --------------------------------------------------------------- (c) recovery

function recoveryHarness() {
  const clock = createClock(), controller = new AbortController();
  let time = 0;
  const recovery = createLiveRecovery({ ...clock, now: () => time, random: () => 0 });
  const advance = (ms) => { time += ms; clock.advance(ms); };
  const consume = () => recovery.budget.consume({ providerId: 'gemini', keySource: 'personal', signal: controller.signal });
  return { recovery, clock, controller, advance, consume };
}
const exhausted = (error) => error.code === 'BUDGET_EXHAUSTED';

test('(c) recovery: INVALID_RESULT backs off 1/2/4 s on the same request, never a fallback, then fails as itself with its reason', async () => {
  const h = recoveryHarness(); h.consume();
  const live = { input: { format: 'pcm16' }, targetLanguage: 'ko', model: LIVE_MODELS[0] };
  const options = { closed: true, signal: h.controller.signal, request: live,
    resolveFallback() { assert.fail('a refused message says nothing about the model'); } };
  for (const delay of [1000, 2000, 4000]) {
    const pending = h.recovery.wait(contract.invalidResult('flag-shape'), options);
    assert.throws(h.consume, exhausted, 'no open before the backoff elapsed');
    h.advance(delay - 1); assert.equal(h.clock.size, 1);
    h.advance(1);
    assert.equal(await pending, live, 'the same request and model');
    h.consume(); h.recovery.opened();
  }
  assert.deepEqual([h.recovery.retries, h.recovery.budget.used, h.recovery.budget.remaining], [3, 4, 0]);
  await assert.rejects(h.recovery.wait(contract.invalidResult('parts-shape'), options),
    (error) => error instanceof ProviderError && error.code === 'INVALID_RESULT' && error.reason === 'parts-shape');
  assert.equal(h.clock.size, 0);
  assert.throws(h.consume, exhausted, 'a spent budget authorizes nothing');
  // Every other code still reports the budget.
  await assert.rejects(h.recovery.wait(new ProviderError('NETWORK_ERROR'), { closed: true, signal: h.controller.signal }), exhausted);
});

test('(c) recovery: the INVALID_RESULT budget is the shared one — transport failures spend it, 60 stable seconds renew it', async () => {
  const h = recoveryHarness(); h.consume();
  const wait = async (error) => {
    const pending = h.recovery.wait(error, { closed: true, signal: h.controller.signal });
    h.advance(10000); await pending; h.consume(); h.recovery.opened();
  };
  await wait(new ProviderError('NETWORK_ERROR'));
  await wait(contract.invalidResult('message-parse'));
  await wait(new ProviderError('SESSION_CLOSED'));
  await assert.rejects(h.recovery.wait(contract.invalidResult('message-parse'), { closed: true, signal: h.controller.signal }),
    (error) => error.code === 'INVALID_RESULT' && error.reason === 'message-parse');
  h.recovery.activity(); h.advance(60000);
  await wait(contract.invalidResult('message-parse'));
  assert.deepEqual([h.recovery.retries, h.recovery.budget.used], [1, 2]);
  // An unconfirmed close still authorizes nothing, and waits for nothing.
  await assert.rejects(h.recovery.wait(contract.invalidResult('flag-shape'), { closed: false, signal: h.controller.signal }),
    (error) => error.code === 'INVALID_RESULT' && error.reason === 'flag-shape');
  assert.equal(h.clock.size, 0);
});

// ----------------------------------------------------------------- engine

async function advanceInput(f, ms) {
  while (ms > 0) { f.frame(); const step = Math.min(ms, 500); f.audio.advance(step); await tick(); ms -= step; }
}
const restartable = (f) => { f.track.readyState = 'live'; f.platform.createAudioContext().state = 'running'; };

test('(b) engine: skipped and repaired parts keep the session running, are counted by reason, and mark an audio gap only when sound was lost', async t => {
  const f = simFixture(); t.after(() => f.close()); await f.running();
  const s = f.sockets[0];
  const state = () => { const snap = f.engine.snapshot(); return [f.audio.made.length, snap.metrics.invalidResults, snap.captions.gaps.audio]; };
  content(s, parts(part(b64(1, 0, 255)))); await tick();
  assert.deepEqual(state(), [1, { 'audio-odd-bytes': 1 }, false], 'the whole sample plays, the dangling byte waits');
  content(s, parts(part(b64(127)))); await tick();
  assert.deepEqual(state(), [2, { 'audio-odd-bytes': 2 }, false], 'the next chunk completes the sample');
  content(s, parts(part(''))); await tick();
  assert.deepEqual(state(), [2, { 'audio-odd-bytes': 2, 'audio-empty': 1 }, false]);
  content(s, parts(part('AQD/fw==', 'audio/pcm;rate=24000;channels=1'))); await tick();
  assert.deepEqual(state(), [3, { 'audio-odd-bytes': 2, 'audio-empty': 1 }, false], 'a harmless parameter is no anomaly at all');
  content(s, parts(part('AQD/fw==', 'audio/pcm;rate=16000'))); await tick();
  assert.deepEqual(state(), [3, { 'audio-odd-bytes': 2, 'audio-empty': 1, 'audio-mime': 1 }, true], 'unplayable sound is a gap');
  content(s, { outputTranscription: { text: '계속 통역합니다', finished: true }, ...audioContent, turnComplete: true }); await tick();
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.errorCode, snap.errorReason, snap.retries, snap.metrics.reconnects, f.sockets.length],
    ['running', null, null, 0, 0, 1]);
  assert.equal(snap.captions.captions.at(-1).translatedText, '계속 통역합니다');
  assert.equal(f.audio.made.length, 4);
  assert.deepEqual(f.calls, ['live']);
});

test('(c) engine: an INVALID_RESULT connection is replaced three times within the budget (1/2/4 s, same model, visible reconnect), then the operation fails with the last reason', async t => {
  const f = simFixture(); t.after(() => f.close()); const h = await f.running();
  content(f.sockets[0], { outputTranscription: { text: 'unfinished' }, ...audioContent }); await tick();
  const breaks = [
    [(s) => s.message('{SECRET'), 'message-parse'],                               // refused by the transport
    [(s) => content(s, { turnComplete: 'SECRET' }), 'flag-shape'],                // refused by the adapter
    [(s) => content(s, { inputTranscription: { text: 42 } }), 'transcript-shape'],
  ];
  const counted = {};
  for (const [index, delay] of [1125, 2250, 4500].entries()) {
    const [send, reason] = breaks[index];
    send(f.sockets.at(-1)); await tick();
    counted[reason] = 1;
    const broken = f.engine.snapshot();
    assert.deepEqual([broken.status, broken.busy, broken.errorCode, broken.errorReason, broken.reconnectReason],
      ['reconnecting', true, null, null, null], `${reason}: an ordinary reconnect, not a failure and not a calm handover`);
    assert.equal(broken.captions.gaps.reception, true, 'the lost connection is marked like any other');
    assert.deepEqual(broken.metrics.invalidResults, counted);
    if (index === 0) assert.equal(broken.captions.captions[0].status, 'interrupted');
    await advanceInput(f, delay - 500);
    assert.equal(f.sockets.length, index + 1, 'no replacement before the backoff elapsed');
    await advanceInput(f, 500); await f.open();
    assert.equal(f.sockets.length, index + 2);
    const replaced = f.engine.snapshot();
    assert.deepEqual([replaced.status, replaced.retries, replaced.fallback, replaced.model], ['running', index + 1, false, DEFAULT_LIVE_MODEL]);
  }
  content(f.sockets.at(-1), { modelTurn: { parts: {} } });
  const result = await h.done;
  assert.deepEqual([result.status, result.errorCode, result.errorReason, result.messageKey, result.retries],
    ['failed', 'INVALID_RESULT', 'parts-shape', 'error.INVALID_RESULT', 3]);
  assert.ok(Object.isFrozen(result));
  const failed = f.engine.snapshot();
  assert.deepEqual([failed.status, failed.errorCode, failed.errorReason], ['failed', 'INVALID_RESULT', 'parts-shape']);
  assert.deepEqual(failed.metrics.invalidResults, { ...counted, 'parts-shape': 1 });
  assert.equal(f.sockets.length, 4); assert.deepEqual(f.calls, ['live', 'live', 'live', 'live']);
  for (const socket of f.sockets) assert.equal(socket.sent[0].setup.model, `models/${DEFAULT_LIVE_MODEL}`, 'never a model fallback');
  assert.equal(f.audio.timers.size, 0);
  assert.equal(leaks([result, failed]), false);
  // The next start is a new operation: no reason left over, and a fresh budget.
  restartable(f); await f.running();
  const again = f.engine.snapshot();
  assert.deepEqual([again.status, again.errorCode, again.errorReason, again.retries], ['running', null, null, 0]);
  assert.deepEqual(again.metrics.invalidResults, {});
  // A stop, or any other failure, leaves no reason behind either.
  const stopped = await f.engine.stop();
  assert.deepEqual([stopped.status, stopped.errorCode, stopped.errorReason], ['stopped', null, null]);
  restartable(f); const other = await f.running();
  f.sockets.at(-1).json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET unknown quota' } });
  const quota = await other.done;
  assert.deepEqual([quota.errorCode, quota.errorReason, f.engine.snapshot().errorReason], ['UNKNOWN_429', null, null]);
});

test('(a) engine: an exception inside its own event handling is named event-handler and replaced, not mistaken for a server fault', async t => {
  let boom = false, f;
  // One read of the engine clock throws, as a browser timer did on 2026-09-30.
  const now = () => { if (boom) { boom = false; throw new Error('SECRET Illegal invocation'); } return f.audio.options.now(); };
  f = simFixture({ engine: { now } }); t.after(() => f.close());
  await f.running();
  boom = true;
  content(f.sockets[0], { outputTranscription: { text: 'partial' } });
  assert.equal(boom, false, 'the clock was read inside the event handler');
  await tick();
  const snap = f.engine.snapshot();
  assert.deepEqual([snap.status, snap.errorCode, snap.reconnectReason], ['reconnecting', null, null]);
  assert.deepEqual(snap.metrics.invalidResults, { 'event-handler': 1 });
  assert.equal(leaks(snap), false);
  await advanceInput(f, 1125); await f.open();
  assert.deepEqual([f.engine.snapshot().status, f.engine.snapshot().retries, f.sockets.length], ['running', 1, 2]);
});
