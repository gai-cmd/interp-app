import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabAudioGraph, RESUME_TIMEOUT_MS } from '../extension/engine/audio-graph.js';
import { createLanePlatform } from '../extension/engine/platform-shim.js';
import { createMediaSource } from './fixtures/fake-chrome.mjs';
import { FakeMediaStream, FakeTrack, createFakeAudioEnv } from './fixtures/fake-audio.mjs';

// docs/extension.md §11.1 (group B): the tab audio graph (5.3) and the platform shim (5.4). Everything is fake
// (audio contexts, streams, the virtual clock); nothing here can make a sound or open a device.

const code = (value) => (error) => error.code === value;
const rawStream = (tracks = 1) => new FakeMediaStream(Array.from({ length: tracks },
  () => new FakeTrack({ kind: 'audio', label: 'raw tab', source: createMediaSource() })));

function setup(options = {}) {
  const audio = createFakeAudioEnv(options);
  const graph = createTabAudioGraph({ env: audio.env, timers: audio.clock });
  return { audio, graph, clock: audio.clock };
}
const nodeOf = (context, kind) => context.nodes.filter((node) => node.kind === kind);

test('attach wires raw -> source -> gain -> destination and reports a running graph', async () => {
  const { audio, graph } = setup();
  const raw = rawStream();
  await graph.attach(raw, { originalVolume: 65 });
  assert.equal(audio.contexts.length, 1, 'exactly one graph context; it is never handed to the engine');
  const [context] = audio.contexts;
  const [source] = nodeOf(context, 'mediaStreamSource');
  const [gain] = nodeOf(context, 'gain');
  assert.equal(source.mediaStream, raw);
  assert.ok(source.connections.has(gain), 'source feeds the gain');
  assert.ok(gain.connections.has(context.destination), 'gain feeds what the user hears');
  assert.equal(gain.gain.value, 0.65, 'gain is percent / 100 (linear)');
  assert.deepEqual(graph.snapshot(), { attached: true, contextState: 'running', volume: 65, passthrough: true });
  assert.equal(graph.rawEnded(), false);
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.snapshot()), true);
});

test('setOriginalVolume clamps to integers 0..100, ignores non-numbers and uses setTargetAtTime when present', async () => {
  const { audio, graph } = setup();
  await graph.attach(rawStream(), { originalVolume: 65 });
  const [gain] = nodeOf(audio.contexts[0], 'gain');
  for (const [input, expected] of [[150, 100], [-5, 0], [33.4, 33], [33.5, 34], [0, 0], [100, 100]]) {
    graph.setOriginalVolume(input);
    assert.equal(graph.snapshot().volume, expected, `input ${input}`);
    assert.equal(gain.gain.value, expected / 100);
  }
  const before = graph.snapshot().volume;
  for (const junk of [Number.NaN, Infinity, 'loud', null, undefined]) graph.setOriginalVolume(junk);
  assert.equal(graph.snapshot().volume, before, 'a non-number changes nothing');
  assert.deepEqual(gain.gain.calls.at(-1), { value: before / 100, startTime: audio.contexts[0].currentTime, timeConstant: 0.02 },
    'the smoothing time constant of 5.3');

  // Without setTargetAtTime the value is assigned.
  gain.gain.setTargetAtTime = undefined;
  graph.setOriginalVolume(50);
  assert.equal(gain.gain.value, 0.5);
});

test('attach clamps the initial volume too', async () => {
  const { audio, graph } = setup();
  await graph.attach(rawStream(), { originalVolume: 400 });
  assert.equal(nodeOf(audio.contexts[0], 'gain')[0].gain.value, 1);
  assert.equal(graph.snapshot().volume, 100);
});

test('createEngineStream makes a NEW destination per call; releaseEngineStream disconnects only that one', async () => {
  const { audio, graph } = setup();
  await graph.attach(rawStream(), { originalVolume: 65 });
  const [context] = audio.contexts;
  const [source] = nodeOf(context, 'mediaStreamSource');
  const first = graph.createEngineStream();
  const second = graph.createEngineStream();
  assert.notEqual(first, second);
  const destinations = nodeOf(context, 'mediaStreamDestination');
  assert.equal(destinations.length, 2);
  assert.ok(destinations.every((node) => source.connections.has(node)), 'the raw source feeds each engine destination');
  assert.equal(first.getAudioTracks()[0].readyState, 'live');
  assert.notEqual(first.getAudioTracks()[0], second.getAudioTracks()[0], 'one track per engine start: the engine stops the track it gets');

  graph.releaseEngineStream(first);
  assert.equal(source.connections.has(destinations[0]), false);
  assert.equal(source.connections.has(destinations[1]), true, 'the other engine stream is untouched');
  graph.releaseEngineStream(first);                       // second release: no throw
  graph.releaseEngineStream(new FakeMediaStream());       // a stream that is not ours: no throw
  assert.equal(source.connections.has(destinations[1]), true);
});

test('createEngineStream throws before attach and after stop', async () => {
  const { graph } = setup();
  assert.throws(() => graph.createEngineStream(), code('INVALID_REQUEST'));
  await graph.attach(rawStream());
  assert.ok(graph.createEngineStream());
  await graph.stop();
  assert.throws(() => graph.createEngineStream(), code('INVALID_REQUEST'));
});

test('onEnded fires once when a raw track ends and returns an unsubscribe', async () => {
  const { graph } = setup();
  const raw = rawStream();
  let fired = 0;
  graph.onEnded(() => { fired += 1; });
  let removedFired = 0;
  const off = graph.onEnded(() => { removedFired += 1; });
  off();
  await graph.attach(raw);
  assert.equal(fired, 0);
  raw.getAudioTracks()[0].end();
  raw.getAudioTracks()[0].end();
  assert.equal(fired, 1, 'once, however often the track reports it');
  assert.equal(removedFired, 0);
  assert.equal(graph.rawEnded(), true);
  assert.throws(() => graph.onEnded('not a function'), code('INVALID_REQUEST'));
});

test('a handler registered BEFORE attach still fires when a track ends DURING the resume wait', async () => {
  const { audio, graph } = setup({ autoplay: 'held' });
  const raw = rawStream();
  let fired = 0;
  graph.onEnded(() => { fired += 1; });
  const attaching = graph.attach(raw);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.contexts[0].state, 'suspended', 'the wait is pending');
  raw.getAudioTracks()[0].end();
  assert.equal(fired, 1, 'noticed at once, not after the wait');
  audio.contexts[0].releaseResume();
  await attaching;
  assert.equal(graph.rawEnded(), true, 'the lane re-checks the raw tracks after the wait');
});

test('when every raw track is ALREADY ended, the handlers fire inside the synchronous part of attach', async () => {
  const { graph } = setup();
  const raw = rawStream();
  raw.getAudioTracks()[0].end();
  let fired = 0;
  graph.onEnded(() => { fired += 1; });
  const attaching = graph.attach(raw);
  assert.equal(fired, 1, 'fired before attach yielded');
  await attaching;
  // A handler added after the event is not lost either.
  let late = 0;
  graph.onEnded(() => { late += 1; });
  assert.equal(late, 1);
});

test('attach makes no await between the caller and its first calls: listeners, context and resume() happen synchronously', () => {
  const { audio, graph } = setup();
  const raw = rawStream();
  const log = [];
  const [track] = raw.getAudioTracks();
  const addListener = track.addEventListener.bind(track);
  track.addEventListener = (type, listener) => { log.push(`listen:${type}`); addListener(type, listener); };
  const attaching = graph.attach(raw);   // deliberately not awaited
  assert.deepEqual(log, ['listen:ended']);
  assert.equal(audio.contexts.length, 1, 'the context exists already');
  assert.equal(audio.contexts[0].resumeCalls, 1, 'resume() was called in the same task as getUserMedia resolved');
  assert.equal(nodeOf(audio.contexts[0], 'gain').length, 1);
  return attaching;
});

test('attach twice is refused', async () => {
  const { graph } = setup();
  await graph.attach(rawStream());
  await assert.rejects(graph.attach(rawStream()), code('INVALID_REQUEST'));
});

test('stop() DURING the resume wait makes attach reject START_CANCELLED and creates nothing afterwards', async () => {
  const { audio, graph, clock } = setup({ autoplay: 'held' });
  const raw = rawStream();
  const attaching = graph.attach(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const nodesBefore = audio.contexts[0].nodes.length;
  await graph.stop();
  await assert.rejects(attaching, code('START_CANCELLED'));
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended', 'the stop already stopped the raw tracks');
  assert.equal(audio.contexts[0].state, 'closed');
  assert.equal(audio.contexts.length, 1);
  assert.equal(audio.contexts[0].nodes.length, nodesBefore, 'no node was created after the stop');
  assert.equal(clock.pending(), 0, 'the resume timer was cleared');
  assert.equal(graph.snapshot().attached, false);
});

test('stop() before attach is safe; a later attach stops the raw tracks it is given and rejects START_CANCELLED', async () => {
  const { audio, graph } = setup();
  await graph.stop();
  await graph.stop();
  const raw = rawStream();
  await assert.rejects(graph.attach(raw), code('START_CANCELLED'));
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended', 'no capture indicator survives');
  assert.equal(audio.contexts.length, 0, 'nothing was created');
});

test('a suspended context after resume rejects TAB_AUDIO_BLOCKED AND stops the raw tracks (tab audio restored)', async () => {
  const { audio, graph } = setup({ autoplay: 'blocked' });
  const raw = rawStream();
  await assert.rejects(graph.attach(raw), code('TAB_AUDIO_BLOCKED'));
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended');
  assert.equal(audio.contexts[0].state, 'closed');
  assert.equal(graph.snapshot().attached, false);
});

test('a resume that never settles is bounded by RESUME_TIMEOUT_MS on the injected clock', async () => {
  const { audio, graph, clock } = setup({ autoplay: 'held' });
  const raw = rawStream();
  let outcome = 'pending';
  const attaching = graph.attach(raw).then(() => { outcome = 'ok'; }, (error) => { outcome = error.code; });
  await clock.advance(RESUME_TIMEOUT_MS - 1);
  assert.equal(outcome, 'pending');
  await clock.advance(1);
  await attaching;
  assert.equal(outcome, 'TAB_AUDIO_BLOCKED');
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended');
  assert.equal(audio.contexts[0].state, 'closed');
});

test('a resume() that rejects also ends in TAB_AUDIO_BLOCKED', async () => {
  const { audio, graph } = setup();
  const raw = rawStream();
  const original = audio.env.AudioContext;
  audio.env.AudioContext = class extends original {
    async resume() { throw new DOMException('no', 'NotAllowedError'); }
  };
  await assert.rejects(graph.attach(raw), code('TAB_AUDIO_BLOCKED'));
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended');
});

test('a raw stream with no audio track cannot be played: TAB_AUDIO_BLOCKED, nothing left behind', async () => {
  const { audio, graph } = setup();
  await assert.rejects(graph.attach(new FakeMediaStream()), code('TAB_AUDIO_BLOCKED'));
  assert.equal(graph.rawEnded(), true, 'no track counts as ended');
  assert.equal(audio.contexts[0].state, 'closed');
});

test('stop order: raw tracks first, then the nodes, then context.close', async () => {
  const { audio, graph } = setup();
  const raw = rawStream();
  await graph.attach(raw);
  const engineStream = graph.createEngineStream();
  const [context] = audio.contexts;
  const [source] = nodeOf(context, 'mediaStreamSource');
  const [gain] = nodeOf(context, 'gain');
  const [destination] = nodeOf(context, 'mediaStreamDestination');
  const log = [];
  const wrap = (object, name, label) => {
    const original = object[name].bind(object);
    object[name] = (...args) => { log.push(label); return original(...args); };
  };
  wrap(raw.getAudioTracks()[0], 'stop', 'raw-track-stop');
  wrap(source, 'disconnect', 'source-disconnect');
  wrap(gain, 'disconnect', 'gain-disconnect');
  wrap(destination, 'disconnect', 'destination-disconnect');
  wrap(context, 'close', 'context-close');
  await graph.stop();
  assert.equal(log[0], 'raw-track-stop');
  assert.equal(log.at(-1), 'context-close');
  assert.deepEqual([...log].sort(), ['context-close', 'destination-disconnect', 'gain-disconnect', 'raw-track-stop', 'source-disconnect']);
  assert.ok(log.indexOf('context-close') > Math.max(log.indexOf('source-disconnect'), log.indexOf('gain-disconnect'),
    log.indexOf('destination-disconnect')), 'all nodes are disconnected before the context closes');
  assert.equal(engineStream.getAudioTracks().length, 1);
});

test('every stop step swallows its own failure: later steps still run', async () => {
  for (const failing of ['track', 'source', 'gain', 'context']) {
    const { audio, graph } = setup();
    const raw = rawStream(2);
    await graph.attach(raw);
    const [context] = audio.contexts;
    const [source] = nodeOf(context, 'mediaStreamSource');
    const [gain] = nodeOf(context, 'gain');
    if (failing === 'track') raw.getAudioTracks()[0].stop = () => { throw new Error('boom'); };
    if (failing === 'source') source.disconnect = () => { throw new Error('boom'); };
    if (failing === 'gain') gain.disconnect = () => { throw new Error('boom'); };
    if (failing === 'context') context.close = async () => { throw new Error('boom'); };
    await graph.stop();
    assert.equal(raw.getAudioTracks()[1].readyState, 'ended', `${failing}: the next raw track was still stopped`);
    if (failing !== 'context') assert.equal(context.state, 'closed', `${failing}: the context was still closed`);
    assert.equal(graph.snapshot().attached, false);
  }
});

test('stop is idempotent and stops listening: no onEnded after a stop', async () => {
  const { audio, graph } = setup();
  const raw = rawStream();
  let fired = 0;
  graph.onEnded(() => { fired += 1; });
  await graph.attach(raw);
  const first = graph.stop();
  const second = graph.stop();
  await Promise.all([first, second]);
  assert.equal(audio.contexts[0].closeCalls, 1);
  raw.getAudioTracks()[0].end();
  assert.equal(fired, 0, 'the tab going away after our own stop is not a TAB_ENDED');
});

// ---------------------------------------------------------------------------------------------
// createLanePlatform (5.4)

function spyEnv(overrides = {}) {
  const audio = createFakeAudioEnv();
  const calls = { mediaDevices: 0, setTimeout: [], clearTimeout: [] };
  const mediaDevices = { getUserMedia: async (constraints) => { calls.mediaDevices += 1; calls.constraints = constraints; return rawStream(); } };
  const env = { ...audio.env,
    navigator: { mediaDevices, userActivation: { isActive: false } },
    isSecureContext: false,
    setTimeout: (fn, ms) => { calls.setTimeout.push(ms); return 77; },
    clearTimeout: (id) => { calls.clearTimeout.push(id); },
    ...overrides };
  return { audio, env, calls };
}

test('the shim answers the capture chain like a visible page: active, not hidden, secure, page events are no-ops', () => {
  const { env } = spyEnv();
  const platform = createLanePlatform({ env });
  assert.equal(platform.isUserActive(), true, 'even though the offscreen document reports no user activation');
  assert.equal(platform.isSecureContext, true, 'even though the environment did not say so');
  assert.equal(platform.document.hidden, false);
  assert.equal(Object.isFrozen(platform), true);
  assert.equal(Object.isFrozen(platform.document), true);
  for (const target of [platform.page, platform.document]) {
    let ran = 0;
    target.addEventListener('pagehide', () => { ran += 1; });
    target.removeEventListener('pagehide', () => {});
    assert.equal(ran, 0, 'pagehide can never interrupt a lane');
  }
});

test('the shim timers are the injected ENGINE clock', () => {
  const { env, calls } = spyEnv();
  const platform = createLanePlatform({ env });
  assert.equal(platform.setTimeout(() => {}, 2000), 77);
  platform.clearTimeout(77);
  assert.deepEqual(calls.setTimeout, [2000]);
  assert.deepEqual(calls.clearTimeout, [77]);
});

test('the shim keeps the real audio classes', () => {
  const { audio, env } = spyEnv();
  const platform = createLanePlatform({ env });
  const context = platform.createAudioContext();
  assert.ok(context instanceof audio.env.AudioContext);
  const node = platform.createWorkletNode(context);
  assert.ok(node instanceof audio.env.AudioWorkletNode);
  assert.equal(node.name, 'interp-capture');
});

test('the tab override of getUserMedia never touches navigator.mediaDevices', async () => {
  const { env, calls } = spyEnv();
  const synthetic = rawStream();
  const platform = createLanePlatform({ env, getUserMedia: async () => synthetic });
  assert.equal(await platform.getUserMedia({ audio: true }), synthetic);
  assert.equal(calls.mediaDevices, 0, 'the tab lane must never fall through to a microphone request');
});

test('the microphone platform uses navigator.mediaDevices.getUserMedia', async () => {
  const { env, calls } = spyEnv();
  const platform = createLanePlatform({ env });
  const stream = await platform.getUserMedia({ audio: { channelCount: 1 }, video: false });
  assert.equal(calls.mediaDevices, 1);
  assert.equal(calls.constraints.audio.channelCount, 1);
  assert.ok(stream.getAudioTracks().length > 0);
});

test('createPlatform is injectable and receives the shimmed environment', () => {
  const { env } = spyEnv();
  let received;
  const platform = createLanePlatform({ env, createPlatform: (shimEnv) => { received = shimEnv; return { marker: 1 }; },
    getUserMedia: async () => null });
  assert.equal(platform.marker, 1);
  assert.equal(received.isSecureContext, true);
  assert.equal(received.navigator.userActivation.isActive, true);
  assert.equal(received.navigator.mediaDevices, env.navigator.mediaDevices);
  assert.equal(received.document.hidden, false);
  assert.equal(received.AudioContext, env.AudioContext);
});
