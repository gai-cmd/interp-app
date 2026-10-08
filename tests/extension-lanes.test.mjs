import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../app/engine/session-manager.js';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS, TRANSLATE_LIVE_MODEL, liveVoicePreference } from '../app/providers/gemini/live-config.js';
import { normalizeGeminiLiveClose } from '../app/providers/gemini/errors.js';
import { createKeyCooldownMemory, createLaneEngine, refusalOfClose } from '../extension/engine/lane-engine.js';
import { createMicLane } from '../extension/engine/mic-lane.js';
import { DISPLAY_MEDIA_CONSTRAINTS, PICKER_REFUSED_AT_ONCE_MS, TAB_CAPTURE_INCLUDE_VIDEO, createTabLane } from '../extension/engine/tab-lane.js';
import { KEEP_ALIVE_LEVEL } from '../extension/engine/audio-graph.js';
import { RELAY_CHANNEL_PREFIX, createRelaySender } from '../extension/lib/audio-relay.js';
import { LIMITS } from '../extension/lib/protocol.js';
import { createDefaultSettings, laneRequestOf } from '../extension/lib/settings.js';
import { laneStateFromSnapshot } from '../extension/lib/ui-state.js';
import { FakeTrack, createFakeAudioEnv } from './fixtures/fake-audio.mjs';
import { createMediaSource } from './fixtures/fake-chrome.mjs';
import { createRig, fakeKey, tick } from './fixtures/extension-lanes.mjs';
import { content } from './fixtures/sim.mjs';

// docs/extension.md §11.1 (group B): the lane engine (5.5), the tab and microphone lanes (5.6), the cancellation
// rules (F13), the stop order (5.7) and two lanes at once (5.9). Everything runs over the shared fakes: fake audio,
// fake Live sockets, the virtual clock. Nothing here can make a sound or open a device.

const code = (value) => (error) => error.code === value;
const stateOf = (lane, name) => laneStateFromSnapshot({ lane: name, snapshot: lane.snapshot(), facts: lane.facts(), level: lane.level() });
async function until(check, what, limit = 300) {
  for (let step = 0; step < limit; step += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
const texts = (lane) => (lane.snapshot()?.captions?.captions ?? []).flatMap((row) => [row.sourceText, row.translatedText].filter(Boolean));
const outcomeOf = (promise) => promise.then(() => 'started', (error) => error.code);

// ---------------------------------------------------------------------------------------------
// createLaneEngine with stubbed app modules: the exact calls of 5.5.

/**
 * Stub app modules that record every call in `log`. `onStep(name)` also sees the teardown steps, so a test can put them
 * in one sequence with other recorders. `failAt` makes that step throw AFTER recording it; `keyThrows` makes setPersonal
 * throw a coded error whose MESSAGE contains the key (the lane engine must not pass the message on).
 */
function stubbed({ failAt = null, startThrows = null, keyThrows = null, onStep = () => {} } = {}) {
  const log = [];
  const calls = [];
  const made = [];
  const record = (...entry) => { log.push(entry); onStep(entry[0]); };
  const boom = (step) => {
    if (failAt === step) throw Object.assign(new Error(`${step} failed`), { code: 'PROVIDER_ERROR' });
  };
  class AudioContext {
    constructor(options) {
      if (options?.sampleRate !== undefined && failAt === 'sampleRate') throw new Error('sample rate refused');
      this.options = options; made.push(this); record('AudioContext', options);
    }
    async close() { record('playback.close'); boom('playback.close'); }
  }
  let doneOf, finished = false;
  const deps = {
    createAppConfig(options) {
      record('createAppConfig', options);
      const config = { keyStore: {
        setPersonal: (...args) => {
          record('setPersonal', ...args);
          if (keyThrows) throw Object.assign(new Error(`rejected ${args[1]}`), { code: keyThrows });
        },
        select: (...args) => { record('select', ...args); } },
      router: { tag: 'router' }, sessionManager: { tag: 'manager' },
      resolveFallback: (...args) => { record('resolveFallback', ...args); return 'the-fallback'; },
      dispose: async () => { record('config.dispose'); boom('config.dispose'); } };
      calls.push(config);
      return config;
    },
    createSimEngine(options) {
      record('createSimEngine');
      calls.push(options);
      const listeners = [];
      const engine = {
        subscribe(fn) { listeners.push(fn); return () => { record('unsubscribe'); }; },
        start(request, context) {
          record('engine.start', request, context);
          if (startThrows) throw Object.assign(new Error('refused'), { code: startThrows });
          options.getAudioContext();
          return { ready: Promise.resolve({ status: 'running' }), done: new Promise((resolve) => { doneOf = resolve; }) };
        },
        stop: async () => { record('engine.stop'); finished = true; boom('engine.stop'); return { status: 'stopped' }; },
        close: async () => { record('engine.close'); boom('engine.close'); },
        snapshot: () => Object.freeze({ status: finished ? 'stopped' : 'running', captions: null }),
        setMuted: (value) => { record('setMuted', value); },
        resumeAudio: async () => { record('resumeAudio'); return true; },
        notify: () => listeners.forEach((fn) => fn()),
      };
      calls.push(engine);
      return engine;
    },
    liveVoicePreference: { set: (...args) => { record('voice.set', ...args); } },
  };
  const env = { AudioContext, WebSocket: 'the-websocket', fetch: 'the-fetch', now: () => 0, setTimeout: () => 0,
    clearTimeout: () => {}, random: () => 0.5 };
  return { deps, env, log, calls, made, finish: (value = { status: 'stopped' }) => doneOf(value) };
}
const startArgs = (extra = {}) => ({ key: fakeKey('stub'), request: { targetLanguage: 'ja', model: 'a-model' },
  voiceGender: 'male', muted: false, sessionId: 'tab-3', ...extra });
const names = (log) => log.map((entry) => entry[0]);

test('lane engine start: one fresh isolated config, key via setPersonal + select, voice, request shape of 5.5', () => {
  const { deps, env, log, calls } = stubbed();
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: { platform: true }, onChange() {} });
  const handle = engine.start(startArgs());
  assert.equal(typeof handle.ready.then, 'function');
  assert.equal(typeof handle.done.then, 'function');
  const args = startArgs();
  assert.deepEqual(names(log).slice(0, 6), ['createAppConfig', 'setPersonal', 'select', 'voice.set', 'resolveFallback', 'createSimEngine']);
  assert.deepEqual(log[0][1], { isolated: true, WebSocket: 'the-websocket', fetch: 'the-fetch' },
    'isolated:true; no storage, so nothing is persisted');
  assert.deepEqual(log[1].slice(1), ['gemini', args.key]);
  assert.deepEqual(log[2].slice(1), ['gemini', 'personal']);
  assert.deepEqual(log[3][1], { gender: 'male' });
  assert.deepEqual(log[4].slice(1), ['gemini', 'live']);
  const options = calls[1];
  assert.equal(options.router, calls[0].router);
  assert.equal(options.sessionManager, calls[0].sessionManager);
  assert.deepEqual(options.platform, { platform: true });
  assert.equal(options.resolveFallback, 'the-fallback');
  assert.equal(typeof options.getAudioContext, 'function');
  assert.equal(typeof options.onLevel, 'function');
  for (const name of ['now', 'setTimeout', 'clearTimeout', 'random']) assert.equal(typeof options[name], 'function', name);

  const start = log.find((entry) => entry[0] === 'engine.start');
  // `languages` is no longer forbidden (two-way mode); a one-way request still has none, see the two-way test below.
  assert.deepEqual(start[1], { targetLanguage: 'ja', model: 'a-model' }, 'NO sourceLanguage, no languages for a one-way request, and muted only when muted');
  assert.deepEqual(start[2], { providerId: 'gemini', keySource: 'personal', sessionId: 'tab-3' }, 'NO signal: the lane owns cancellation');
  for (const forbidden of ['sourceLanguage', 'languages', 'signal', 'muted']) {
    assert.equal(Object.hasOwn(start[1], forbidden) || Object.hasOwn(start[2], forbidden), false, forbidden);
  }
});

test('lane engine start: a two-way request hands its pair to the engine unchanged, next to targetLanguage and model; sourceLanguage stays out', () => {
  const pair = Object.freeze(['ja', 'ko']);
  const { deps, env, log } = stubbed();
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() {} });
  engine.start(startArgs({ request: { targetLanguage: 'ja', model: 'a-model', languages: pair, sourceLanguage: 'ko' } }));
  const start = log.find((entry) => entry[0] === 'engine.start');
  assert.deepEqual(start[1], { targetLanguage: 'ja', model: 'a-model', languages: ['ja', 'ko'] });
  assert.equal(start[1].languages, pair, 'unchanged: the same pair, not a rewritten one');
  assert.equal(Object.hasOwn(start[1], 'sourceLanguage'), false, 'the source language is still always auto');
  assert.deepEqual(start[2], { providerId: 'gemini', keySource: 'personal', sessionId: 'tab-3' });
  // with the muted flag as well, and the pair does not appear anywhere else
  const second = stubbed();
  createLaneEngine({ lane: 'mic', deps: second.deps, env: second.env, platform: {}, onChange() {} })
    .start(startArgs({ muted: true, request: { targetLanguage: 'en', model: 'gemini-3.8-live', languages: ['en', 'ko'] } }));
  assert.deepEqual(second.log.find((entry) => entry[0] === 'engine.start')[1], { targetLanguage: 'en', model: 'gemini-3.8-live', languages: ['en', 'ko'], muted: true });
  assert.equal(second.log.filter((entry) => JSON.stringify(entry).includes('"languages"')).length, 1, 'only the engine start names the pair');
});

test('lane engine start: muted:true only when muted; a new config for every start', async () => {
  const { deps, env, log } = stubbed();
  const engine = createLaneEngine({ lane: 'mic', deps, env, platform: {}, onChange() {} });
  engine.start(startArgs({ muted: true }));
  assert.deepEqual(log.find((entry) => entry[0] === 'engine.start')[1], { targetLanguage: 'ja', model: 'a-model', muted: true });
  assert.throws(() => engine.start(startArgs()), code('ALREADY_RUNNING'), 'one run at a time per lane engine');
  await engine.stop();
  engine.start(startArgs());
  assert.equal(names(log).filter((name) => name === 'createAppConfig').length, 2, 'a changed key applies at the next start');
});

test('lane engine: the API key appears in exactly one call, setPersonal, and nowhere else', async () => {
  const { deps, env, log } = stubbed();
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() {} });
  const key = fakeKey('only-once');
  engine.start(startArgs({ key }));
  await engine.stop();
  const holders = log.filter((entry) => JSON.stringify(entry).includes(key));
  assert.deepEqual(holders.map((entry) => entry[0]), ['setPersonal']);
  assert.equal(JSON.stringify(engine.snapshot()).includes(key), false);
});

test('lane engine: the playback context is the lane\'s own (24 kHz first, plain as a fallback) and is closed on stop', async () => {
  const { deps, env, log, made } = stubbed();
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() {} });
  engine.start(startArgs());
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].options, { sampleRate: 24000 });
  await engine.stop();
  assert.ok(names(log).includes('playback.close'));

  const refused = stubbed({ failAt: 'sampleRate' });
  createLaneEngine({ lane: 'mic', deps: refused.deps, env: refused.env, platform: {}, onChange() {} }).start(startArgs());
  assert.equal(refused.made.length, 1);
  assert.equal(refused.made[0].options, undefined, 'falls back to the default context when 24 kHz is refused');
});

test('lane engine stop/dispose order: engine.stop, engine.close, config.dispose, playback.close; each failure is swallowed', async () => {
  const expected = ['engine.stop', 'engine.close', 'config.dispose', 'playback.close'];
  for (const failAt of [null, ...expected]) {
    const { deps, env, log } = stubbed({ failAt });
    const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() {} });
    engine.start(startArgs());
    const result = await engine.stop();
    assert.deepEqual(names(log).filter((name) => expected.includes(name)), expected, `failAt ${failAt}`);
    if (failAt === null) assert.deepEqual(result, { status: 'stopped' }, 'stop resolves with the engine\'s last result');
    assert.equal(engine.snapshot()?.status, 'stopped', 'the last snapshot stays readable after stop');
    await engine.stop();   // idempotent
    assert.equal(names(log).filter((name) => name === 'engine.stop').length, 1);
  }
  const { deps, env, log } = stubbed();
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() {} });
  engine.start(startArgs());
  await engine.dispose();
  assert.deepEqual(names(log).filter((name) => expected.includes(name)), expected, 'dispose = stop + close + dispose + playback close');
});

test('lane engine: a synchronous refusal is rethrown as Error{code} after the config is disposed, and never carries the key', async () => {
  for (const [expected, options] of [['SESSION_LIMIT', { startThrows: 'SESSION_LIMIT' }],
    ['MODEL_UNSUPPORTED', { startThrows: 'MODEL_UNSUPPORTED' }], ['INVALID_KEY', { keyThrows: 'INVALID_KEY' }]]) {
    const { deps, env, log } = stubbed(options);
    const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() {} });
    const key = fakeKey('refused');
    let caught;
    try { engine.start(startArgs({ key })); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.code, expected);
    assert.equal(caught.message, expected, 'the original message (which held the key) is dropped');
    assert.equal(JSON.stringify({ message: caught.message, code: caught.code, stack: caught.stack }).includes(key), false);
    await tick();
    assert.ok(names(log).includes('config.dispose'), 'the config is disposed');
  }
});

test('lane engine: level() is rms / 0.25 as a clipped percent and only real changes notify', () => {
  const { deps, env, calls } = stubbed();
  let notified = 0;
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() { notified += 1; } });
  engine.start(startArgs());
  const onLevel = calls.find((entry) => typeof entry?.onLevel === 'function').onLevel;
  assert.equal(engine.level(), 0);
  onLevel({ rms: 0.125 }); assert.equal(engine.level(), 50);
  onLevel({ rms: 0.125 }); assert.equal(notified, 1, 'the same level does not notify again');
  onLevel({ rms: 0.5 }); assert.equal(engine.level(), 100, 'clipped');
  onLevel({ rms: Number.NaN }); assert.equal(engine.level(), 0);
  onLevel({}); assert.equal(engine.level(), 0);
  assert.equal(notified, 3);
});

test('lane engine: mute and resume go to the engine; engine notifications reach onChange', async () => {
  const { deps, env, log, calls } = stubbed();
  let notified = 0;
  const engine = createLaneEngine({ lane: 'tab', deps, env, platform: {}, onChange() { notified += 1; } });
  engine.setMuted(true);   // before start: nothing to act on
  assert.equal(await engine.resumeAudio(), false);
  engine.start(startArgs());
  engine.setMuted(true);
  assert.deepEqual(log.filter((entry) => entry[0] === 'setMuted'), [['setMuted', true]]);
  assert.equal(await engine.resumeAudio(), true);
  calls.find((entry) => typeof entry?.notify === 'function').notify();
  assert.equal(notified, 1);
});

// ---------------------------------------------------------------------------------------------
// The tab lane over the real engine and fake sockets.

const newTab = (rig, options = {}) => {
  const log = [];
  const lane = createTabLane({ env: rig.env, timers: rig.clock, onChange: (reason) => log.push(reason), ...options });
  return { lane, log };
};
const newMic = (rig, options = {}) => {
  const log = [];
  const lane = createMicLane({ env: rig.env, timers: rig.clock, onChange: (reason) => log.push(reason), ...options });
  return { lane, log };
};
const rawTrackOf = (rig, tabId = 5) => rig.browser.captures.get(tabId).stream.getAudioTracks()[0];
const tabParams = (rig, options) => rig.laneParams('tab', options);

test('tab lane start: getUserMedia, then the ended listener and the graph context in the same turn, then the engine', async (t) => {
  const rig = createRig();
  const log = [];
  const original = rig.browser.consumeStreamId;
  rig.browser.consumeStreamId = (id, options) => {
    const stream = original(id, options);
    for (const track of stream.getTracks()) {
      const listen = track.addEventListener.bind(track);
      track.addEventListener = (type, listener) => { log.push(`raw-track:${type}`); listen(type, listener); };
    }
    return stream;
  };
  const getUserMedia = rig.env.navigator.mediaDevices.getUserMedia;
  rig.env.navigator.mediaDevices.getUserMedia = (constraints) => { log.push(`getUserMedia:${JSON.stringify(constraints)}`); return getUserMedia(constraints); };
  const Base = rig.env.AudioContext;
  const env = { ...rig.env, AudioContext: class extends Base {
    constructor(options) { super(options); log.push(options?.sampleRate === 24000 ? 'context:playback' : 'context:new'); }
    async resume() { log.push('resume'); return super.resume(); } } };
  const lane = createTabLane({ env, timers: rig.clock, onChange() {} });
  t.after(() => lane.dispose());
  const params = await tabParams(rig);
  assert.deepEqual(await lane.start(params), { epoch: 1 });

  assert.match(log[0], /^getUserMedia:/);
  const constraints = JSON.parse(log[0].slice('getUserMedia:'.length));
  assert.deepEqual(Object.keys(constraints), ['audio'], 'audio only');
  assert.equal(constraints.audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(constraints.audio.mandatory.chromeMediaSourceId, params.tab.streamId);
  assert.deepEqual(log.slice(1, 4), ['raw-track:ended', 'context:new', 'resume'],
    'the ended listener and the graph context/resume follow getUserMedia without a gap');
  assert.equal(TAB_CAPTURE_INCLUDE_VIDEO, false);
  assert.equal(lane.phase(), 'starting');
  // `languages` (the two-way pair of the run, null when one-way) joined the facts with two-way mode.
  assert.deepEqual(lane.facts(), { tabId: 5, epoch: 1, targetLanguage: 'ko', languages: null, hostError: null, stopRequested: false,
    starting: false, stopping: false });
});

test('tab lane: passthrough plays at the chosen original volume, the engine gets its own synthetic stream, and the volume is live', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  await lane.start(await tabParams(rig, { originalVolume: 40 }));
  const graphContext = rig.audio.contexts[0];
  const gain = graphContext.nodes.find((node) => node.kind === 'gain');
  assert.equal(gain.gain.value, 0.4);
  lane.setOriginalVolume(80);
  assert.equal(gain.gain.value, 0.8);
  assert.equal(graphContext.destinations.length, 1, 'the engine\'s capture reads one synthetic destination stream');
  assert.equal(rig.audio.micStreams.length, 0, 'the tab lane never asks for a microphone');
});

test('tab lane: a rejected getUserMedia is TAB_CAPTURE_FAILED, the lane goes to error and can start again', async (t) => {
  const rig = createRig();
  const { lane, log } = newTab(rig);
  t.after(() => lane.dispose());
  await assert.rejects(lane.start(await tabParams(rig, { streamId: 'not-a-stream-id' })), code('TAB_CAPTURE_FAILED'));
  assert.equal(lane.phase(), 'error');
  assert.equal(lane.facts().hostError, 'TAB_CAPTURE_FAILED');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_CAPTURE_FAILED');
  assert.equal(rig.audio.contexts.length, 0, 'nothing was built');
  assert.ok(log.includes('phase'));
  // The failed lane is not stuck.
  assert.deepEqual(await lane.start(await tabParams(rig, { epoch: 2 })), { epoch: 2 });
  assert.equal(lane.facts().hostError, null);
});

test('tab lane: an engine that refuses to start stops the graph (the tab\'s audio returns) and reports the engine code', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig, { deps: { createSimEngine: () => { throw Object.assign(new Error('nope'), { code: 'MODEL_UNSUPPORTED' }); } } });
  t.after(() => lane.dispose());
  await assert.rejects(lane.start(await tabParams(rig)), code('MODEL_UNSUPPORTED'));
  assert.equal(lane.phase(), 'error');
  assert.equal(stateOf(lane, 'tab').errorCode, 'MODEL_UNSUPPORTED');
  assert.equal(rig.browser.captures.size, 0, 'every raw track was stopped: the capture is released');
  assert.equal(rig.audio.contexts[0].state, 'closed');
});

test('tab lane: a Live session that ends in an error tears the graph down and keeps the engine\'s code', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig));
  const { socket } = await rig.connect(before);
  assert.equal(lane.phase(), 'running');
  socket.json({ error: { code: 401 } });
  await until(() => lane.phase() === 'error', 'the lane to fail');
  await until(() => rig.browser.captures.size === 0, 'the graph teardown');
  const state = stateOf(lane, 'tab');
  assert.equal(state.errorCode, 'INVALID_KEY');
  assert.equal(state.keyFailure, true);
  assert.equal(lane.facts().stopRequested, false);
  assert.ok(rig.audio.contexts.every((context) => context.state === 'closed'), 'a dead lane must not keep capturing or playing');
  assert.equal(lane.level(), 0);
});

test('tab lane: a requested stop ends in off; an interruption nobody asked for is BROWSER_INTERRUPTED', async (t) => {
  const rig = createRig();
  const a = newTab(rig);
  t.after(() => a.lane.dispose());
  let before = rig.counts();
  await a.lane.start(await tabParams(rig, { tabId: 5 }));
  await rig.connect(before);
  await a.lane.stop();
  assert.equal(a.lane.phase(), 'off');
  assert.equal(stateOf(a.lane, 'tab').errorCode, null);
  assert.equal(a.lane.facts().stopRequested, true);

  // A second lane on the same rig: the engine's synthetic track is muted (a capture interruption).
  const b = newTab(rig);
  t.after(() => b.lane.dispose());
  before = rig.counts();
  await b.lane.start(await tabParams(rig, { tabId: 6 }));
  await rig.connect(before);
  assert.equal(b.lane.phase(), 'running');
  const graphContext = rig.audio.contexts.find((context) => context.destinations.length > 0 && context.state === 'running');
  graphContext.destinations.at(-1).stream.getAudioTracks()[0].mute();
  await until(() => b.lane.phase() === 'error', 'the interruption');
  assert.equal(stateOf(b.lane, 'tab').errorCode, 'BROWSER_INTERRUPTED');
  await until(() => rig.browser.captures.size === 0, 'teardown after the interruption');
});

test('tab lane: start while starting or running is ALREADY_RUNNING, while stopping LANE_STOPPING, and the lane is reusable', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  const [second, third, fourth, fifth] = [await tabParams(rig, { tabId: 6, epoch: 2 }), await tabParams(rig, { tabId: 7, epoch: 2 }),
    await tabParams(rig, { tabId: 8, epoch: 2 }), await tabParams(rig, { tabId: 9, epoch: 2 })];
  const first = lane.start(await tabParams(rig));
  await assert.rejects(lane.start(second), code('ALREADY_RUNNING'), 'starting');
  await first;
  await rig.connect(before);
  await assert.rejects(lane.start(third), code('ALREADY_RUNNING'), 'running');
  const stopping = lane.stop();
  await assert.rejects(lane.start(fourth), code('LANE_STOPPING'), 'a Stop followed at once by Start is not silently dropped');
  await stopping;
  assert.deepEqual(await lane.start(fifth), { epoch: 2 }, 'and afterwards it starts again');
});

test('TAB_CAPTURE_INCLUDE_VIDEO: both constraint shapes (the fallback passes the same mandatory object under video and stops the video track)', async (t) => {
  for (const includeVideo of [false, true]) {
    const rig = createRig();
    const seen = [];
    const original = rig.env.navigator.mediaDevices.getUserMedia;
    rig.env.navigator.mediaDevices.getUserMedia = (constraints) => { seen.push(constraints); return original(constraints); };
    const { lane } = newTab(rig, { includeVideo });
    t.after(() => lane.dispose());
    await lane.start(await tabParams(rig));
    assert.equal(Object.hasOwn(seen[0], 'video'), includeVideo);
    if (includeVideo) {
      assert.deepEqual(seen[0].video, seen[0].audio, 'the same mandatory object');
      const stream = rig.browser.captures.get(5).stream;
      assert.equal(stream.getVideoTracks()[0].readyState, 'ended', 'every video track is stopped immediately');
      assert.equal(stream.getAudioTracks()[0].readyState, 'live');
    }
    await lane.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// Cancellation (F13): a stop is honoured in every phase; every await is followed by a run.cancelled check.

test('CANCEL: stop during getUserMedia - the stream that arrives after the stop is stopped, nothing is built, phase off', async () => {
  const rig = createRig();
  const { lane } = newTab(rig);
  rig.audio.setGetUserMediaMode('held');
  const starting = outcomeOf(lane.start(await tabParams(rig)));
  await tick();
  assert.equal(rig.audio.pendingGetUserMedia(), 1);
  assert.equal(lane.phase(), 'starting');

  const stopping = lane.stop();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, 'stop waits for the in-flight start (bounded) so nothing created by it outlives the stop');
  rig.audio.releaseGetUserMedia();
  await stopping;
  assert.equal(await starting, 'START_CANCELLED');
  assert.equal(rig.browser.captures.size, 0, 'no raw track and no capture indicator survive a cancelled start');
  assert.equal(rig.audio.contexts.length, 0, 'no graph');
  assert.equal(rig.sockets.sockets.length, 0, 'no engine was created');
  assert.equal(lane.phase(), 'off');
  assert.equal(lane.facts().hostError, null, 'never error');
  assert.equal(stateOf(lane, 'tab').errorCode, null);
});

test('CANCEL: stop waits for the in-flight start at most LIMITS.startSettleMs; a stream that arrives later is still stopped', async () => {
  const rig = createRig();
  const { lane } = newTab(rig);
  rig.audio.setGetUserMediaMode('held');
  const starting = outcomeOf(lane.start(await tabParams(rig)));
  await tick();
  let stopped = false;
  const stopping = lane.stop().then(() => { stopped = true; });
  await rig.clock.advance(LIMITS.startSettleMs - 1);
  assert.equal(stopped, false);
  await rig.clock.advance(1);
  await stopping;
  assert.equal(stopped, true, 'the bounded wait ends');
  assert.equal(lane.phase(), 'off');

  rig.audio.releaseGetUserMedia();          // the pending getUserMedia finally answers
  assert.equal(await starting, 'START_CANCELLED');
  assert.equal(rig.browser.captures.size, 0, 'the late stream was stopped by the start\'s own cleanup');
  assert.equal(rig.audio.contexts.length, 0);
});

test('CANCEL: stop during the resume wait - attach rejects, raw tracks stopped, graph closed, no engine', async () => {
  const rig = createRig({ autoplay: 'held' });
  const idleTimers = rig.clock.pending();   // the fake browser keeps one service-worker idle timer of its own
  const { lane } = newTab(rig);
  const starting = outcomeOf(lane.start(await tabParams(rig)));
  await tick();
  assert.equal(rig.audio.contexts.length, 1);
  assert.equal(rig.audio.contexts[0].state, 'suspended', 'the resume wait is pending');
  assert.equal(rig.clock.pending(), idleTimers + 1, 'the bounded resume timer is armed');
  const track = rawTrackOf(rig);
  await lane.stop();
  assert.equal(await starting, 'START_CANCELLED');
  assert.equal(track.readyState, 'ended');
  assert.equal(rig.browser.captures.size, 0);
  assert.equal(rig.audio.contexts.length, 1, 'no context was added after the stop');
  assert.equal(rig.audio.contexts[0].state, 'closed');
  assert.equal(rig.sockets.sockets.length, 0);
  assert.equal(lane.phase(), 'off');
  assert.equal(rig.clock.pending(), idleTimers, 'no timer of the abandoned start is left');
});

test('CANCEL: a raw track that ends during the resume wait ends the run with TAB_ENDED', async () => {
  const rig = createRig({ autoplay: 'held' });
  const { lane } = newTab(rig);
  const starting = outcomeOf(lane.start(await tabParams(rig)));
  await tick();
  rawTrackOf(rig).end();                       // the tab was closed while the resume was pending
  rig.audio.contexts[0].releaseResume();
  assert.equal(await starting, 'TAB_ENDED');
  await until(() => lane.phase() === 'error', 'the settled error');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_ENDED');
  assert.equal(rig.sockets.sockets.length, 0, 'no engine for a tab that is already gone');
  assert.equal(rig.audio.contexts[0].state, 'closed');
});

test('CANCEL: a track that is already ended when attach runs is noticed because onEnded was registered BEFORE attach', async () => {
  const rig = createRig();
  const original = rig.browser.consumeStreamId;
  rig.browser.consumeStreamId = (id, options) => {
    const stream = original(id, options);
    stream.getAudioTracks()[0].end();
    return stream;
  };
  const { lane } = newTab(rig);
  await assert.rejects(lane.start(await tabParams(rig)), code('TAB_ENDED'));
  assert.equal(lane.phase(), 'error');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_ENDED');
  assert.equal(rig.sockets.sockets.length, 0);
});

test('CANCEL: a suspended graph context is TAB_AUDIO_BLOCKED; the tab\'s audio is restored', async () => {
  const rig = createRig({ autoplay: 'blocked' });
  const { lane } = newTab(rig);
  await assert.rejects(lane.start(await tabParams(rig)), code('TAB_AUDIO_BLOCKED'));
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_AUDIO_BLOCKED');
  assert.equal(rig.browser.captures.size, 0);
});

test('CANCEL: a tab that ends while the lane runs stops it with TAB_ENDED, through graph.onEnded', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig));
  const { socket } = await rig.connect(before);
  await rig.browser.closeTab(5);
  await until(() => lane.phase() === 'error', 'TAB_ENDED');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_ENDED');
  assert.ok(socket.closeCalls >= 1, 'the Live session was closed');
  assert.equal(rig.browser.captures.size, 0);
});

// ---------------------------------------------------------------------------------------------
// §19 (2026-09-30): the share-picker start. Every test here fails on v0.3.1, which knew the stream-id start only.
const NONCE = '0123456789abcdef'.repeat(2);
const pickParams = (rig, options = {}) => tabParams(rig, { pick: NONCE, ...options });

test('PICKER: the tab lane asks the share picker (never getUserMedia), learns the chosen tab from its label, drops the video track and runs', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  let userMediaCalls = 0;
  const getUserMedia = rig.env.navigator.mediaDevices.getUserMedia;
  rig.env.navigator.mediaDevices.getUserMedia = (constraints) => { userMediaCalls += 1; return getUserMedia(constraints); };
  const params = await pickParams(rig, { originalVolume: 40 });
  assert.deepEqual(params.tab, { pick: NONCE, originalVolume: 40 });
  const starting = lane.start(params);
  await tick();
  // The dialog is open: the lane is starting, it knows no tab yet, and nothing has been built.
  assert.equal(rig.audio.picker.pending(), 1);
  assert.deepEqual(rig.audio.picker.calls, [DISPLAY_MEDIA_CONSTRAINTS]);
  assert.deepEqual(DISPLAY_MEDIA_CONSTRAINTS, {
    video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    surfaceSwitching: 'exclude', systemAudio: 'exclude', monitorTypeSurfaces: 'exclude' });
  assert.ok(Object.isFrozen(DISPLAY_MEDIA_CONSTRAINTS) && Object.isFrozen(DISPLAY_MEDIA_CONSTRAINTS.audio) && Object.isFrozen(DISPLAY_MEDIA_CONSTRAINTS.video));
  assert.equal(lane.phase(), 'starting');
  assert.equal(lane.facts().tabId, null);
  assert.equal(stateOf(lane, 'tab').engineStatus, null, 'no engine while the user is choosing: the panel reads this as "choosing"');
  assert.equal(rig.audio.contexts.length, 0);

  const stream = rig.audio.picker.choose({ label: `${NONCE}.8` });
  const [video] = stream.getVideoTracks();
  assert.deepEqual(await starting, { epoch: 1, tabId: 8 }, 'the start reports the tab the user chose');
  assert.equal(lane.facts().tabId, 8);
  assert.equal(stateOf(lane, 'tab').tabId, 8);
  assert.equal(userMediaCalls, 0, 'the tab capture itself never went through getUserMedia');
  assert.equal(video.readyState, 'ended', 'the video track is stopped at once');
  assert.deepEqual(stream.getVideoTracks(), [], 'and leaves the stream');
  assert.equal(stream.getAudioTracks()[0].readyState, 'live');
  // The same passthrough as the stream-id path: the tab was silenced, so it is played back at the chosen volume.
  const gain = rig.audio.contexts[0].nodes.find((node) => node.kind === 'gain');
  assert.equal(gain.gain.value, 0.4);
  lane.setOriginalVolume(80);
  assert.equal(gain.gain.value, 0.8);
  assert.equal(rig.audio.micStreams.length, 0);
  // and the engine runs on it
  const up = await rig.connect({ worklet: 0, socket: 0 });
  assert.equal(lane.phase(), 'running');
  content(up.socket, { outputTranscription: { text: '안녕하세요' } });
  await until(() => texts(lane).includes('안녕하세요'), 'a caption from the picked tab');
});

test('PICKER: a page without a label, a label of another start and a malformed one all leave the tab unknown; the lane still runs', async (t) => {
  for (const label of [null, `${'f'.repeat(32)}.8`, 'interp:abc', `${NONCE}.x`]) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    const starting = lane.start(await pickParams(rig));
    await tick();
    rig.audio.picker.choose({ label });
    assert.deepEqual(await starting, { epoch: 1, tabId: null }, String(label));
    assert.equal(lane.facts().tabId, null);
    assert.equal(lane.phase(), 'starting', 'the engine is being set up');
  }
});

// What a rejected dialog means depends on how long it was open (§20): the lane reads env.now() from the moment the
// dialog was asked for (the rig's virtual clock, which only `rig.clock.advance` moves). A NotAllowedError sooner than
// PICKER_REFUSED_AT_ONCE_MS is the browser or a policy refusing to show the dialog (visible: TAB_CAPTURE_FAILED, so Start
// does not look dead); a later one is the user closing it (nothing failed: START_CANCELLED, back to off, no notice).
/** Starts a share-picker start, lets the dialog open and lets `openFor` ms of fake time pass. Returns { outcome }: the start's pending outcome (wrapped, so awaiting this function does not wait for the dialog). */
async function startAndWait(rig, lane, openFor, options = {}) {
  const outcome = outcomeOf(lane.start(await pickParams(rig, options)));
  await tick();
  assert.equal(rig.audio.picker.pending(), 1, 'the dialog is open');
  await rig.clock.advance(openFor);
  return { outcome };
}
const assertNoError = (lane) => {
  assert.equal(lane.phase(), 'off');
  assert.equal(lane.facts().hostError, null);
  assert.equal(stateOf(lane, 'tab').errorCode, null);
};

// The rule counts from the moment the dialog was asked for. A rig's clock starts at 0, where a rule on the absolute clock
// (`env.now() < 400`) or a start time that was never set (0) looks exactly like the right one; so every test below also
// runs with the clock moved far away from 0 BEFORE the call, which only the right rule survives.
const CLOCK_SHIFTS_MS = Object.freeze([0, 10_000]);

test('PICKER: the refusal boundary is the documented 400 ms of fake time', () => {
  assert.equal(PICKER_REFUSED_AT_ONCE_MS, 400);
});

test('PICKER: a NotAllowedError that arrives at once (< PICKER_REFUSED_AT_ONCE_MS after the call) is a refusal: TAB_CAPTURE_FAILED, not a silent return to idle, at any clock value', async (t) => {
  for (const [shift, openFor] of CLOCK_SHIFTS_MS.flatMap((moved) => [0, 1, PICKER_REFUSED_AT_ONCE_MS - 1].map((open) => [moved, open]))) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    await rig.clock.advance(shift);
    const { outcome: refused } = await startAndWait(rig, lane, openFor);
    rig.audio.picker.dismiss();
    assert.equal(await refused, 'TAB_CAPTURE_FAILED', `${openFor} ms after the call, the clock at ${shift} ms before it`);
    assert.equal(lane.phase(), 'error');
    assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_CAPTURE_FAILED', 'the panel can show it');
    assert.equal(rig.audio.contexts.length, 0);
    // and the lane is not stuck: the next start opens a dialog and runs
    const again = lane.start(await pickParams(rig, { epoch: 2 }));
    await tick();
    rig.audio.picker.choose({ label: `${NONCE}.5` });
    assert.deepEqual(await again, { epoch: 2, tabId: 5 });
  }
});

test('PICKER: closing the dialog (a NotAllowedError at or after PICKER_REFUSED_AT_ONCE_MS after the call) settles the lane in off without an error, at any clock value', async (t) => {
  for (const [shift, openFor] of CLOCK_SHIFTS_MS.flatMap((moved) => [PICKER_REFUSED_AT_ONCE_MS, PICKER_REFUSED_AT_ONCE_MS + 1, 5_000, 600_000].map((open) => [moved, open]))) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    await rig.clock.advance(shift);
    const { outcome: dismissed } = await startAndWait(rig, lane, openFor);
    rig.audio.picker.dismiss();
    assert.equal(await dismissed, 'START_CANCELLED', `${openFor} ms (clock at ${shift} before the call): the code that means "nothing failed, the lane did not start"`);
    assertNoError(lane);
    assert.equal(rig.audio.contexts.length, 0);
    // and the lane is not stuck: the next start opens a dialog and runs
    const again = lane.start(await pickParams(rig, { epoch: 2 }));
    await tick();
    rig.audio.picker.choose({ label: `${NONCE}.5` });
    assert.deepEqual(await again, { epoch: 2, tabId: 5 });
  }
});

test('PICKER: any failure that is not a NotAllowedError is TAB_CAPTURE_FAILED, at once or after a long time', async (t) => {
  for (const [name, openFor] of [['AbortError', 0], ['AbortError', 5_000], ['NotFoundError', 5_000], ['InvalidStateError', 600_000],
    ['NotReadableError', PICKER_REFUSED_AT_ONCE_MS]]) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    const { outcome: failed } = await startAndWait(rig, lane, openFor);
    rig.audio.picker.dismiss(name);
    assert.equal(await failed, 'TAB_CAPTURE_FAILED', `${name} after ${openFor} ms`);
    assert.equal(lane.phase(), 'error');
    assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_CAPTURE_FAILED');
  }
});

test('PICKER: something shared without audio (a window, or "share tab audio" off) is TAB_SHARE_NO_AUDIO and every track is released', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const starting = outcomeOf(lane.start(await pickParams(rig)));
  await tick();
  const stream = rig.audio.picker.choose({ label: `${NONCE}.8`, audio: false });
  assert.equal(await starting, 'TAB_SHARE_NO_AUDIO');
  assert.equal(lane.phase(), 'error');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_SHARE_NO_AUDIO');
  assert.equal(stream.source.released, true, 'the share indicator goes away');
  assert.equal(rig.audio.contexts.length, 0, 'no graph, no engine');
  assert.equal(rig.sockets.sockets.length, 0);
});

test('PICKER: a tab the browser did NOT silence is not played back a second time, whatever the volume setting says', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const starting = lane.start(await pickParams(rig, { originalVolume: 65 }));
  await tick();
  rig.audio.picker.choose({ label: `${NONCE}.8`, suppressed: false });
  await starting;
  const gain = rig.audio.contexts[0].nodes.find((node) => node.kind === 'gain');
  assert.equal(gain.gain.value, 0, 'the user already hears the tab itself');
  lane.setOriginalVolume(90);
  assert.equal(gain.gain.value, 0);
  assert.equal(rig.audio.contexts[0].destinations.length, 1, 'the engine still gets the audio');
});

test('PICKER CANCEL: Stop while the dialog is open does not wait for it; the stream it delivers later is released at once', async () => {
  const rig = createRig();
  const { lane } = newTab(rig);
  const starting = outcomeOf(lane.start(await pickParams(rig)));
  await tick();
  assert.equal(rig.audio.picker.pending(), 1);
  // No clock advance: unlike a hung getUserMedia, the start lets go as soon as the run is cancelled.
  await lane.stop();
  assert.equal(await starting, 'START_CANCELLED');
  assert.equal(lane.phase(), 'off');
  assert.equal(lane.facts().hostError, null);
  assert.equal(rig.audio.picker.pending(), 1, 'the dialog itself cannot be closed from the document');
  const late = rig.audio.picker.choose({ label: `${NONCE}.8` });
  await tick();
  assert.ok(late.getTracks().every((track) => track.readyState === 'ended'), 'nothing keeps capturing after the stop');
  assert.equal(late.source.released, true);
  assert.equal(rig.audio.contexts.length, 0);
  assert.equal(lane.phase(), 'off');
});

test('PICKER CANCEL: a new Start takes over the dialog a cancelled one left open instead of stacking a second one', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const first = outcomeOf(lane.start(await pickParams(rig)));
  await tick();
  await lane.stop();
  assert.equal(await first, 'START_CANCELLED');
  const OTHER = 'ab'.repeat(16);
  const second = lane.start(await pickParams(rig, { epoch: 2, pick: OTHER }));
  await tick();
  assert.equal(rig.audio.picker.calls.length, 1, 'one dialog, not two');
  assert.equal(rig.audio.picker.pending(), 1);
  // The pages were labelled again for the second start, so the label carries the second nonce.
  const stream = rig.audio.picker.choose({ label: `${OTHER}.9` });
  assert.deepEqual(await second, { epoch: 2, tabId: 9 });
  assert.equal(stream.getAudioTracks()[0].readyState, 'live', 'the cancelled start did not take the stream away');
  assert.equal(lane.phase(), 'starting');
  // Once it was answered, the next start opens a dialog of its own (and a user who closes it later is a dismissal).
  await lane.stop();
  const third = outcomeOf(lane.start(await pickParams(rig, { epoch: 3 })));
  await tick();
  assert.equal(rig.audio.picker.calls.length, 2);
  await rig.clock.advance(PICKER_REFUSED_AT_ONCE_MS);
  rig.audio.picker.dismiss();
  assert.equal(await third, 'START_CANCELLED');
});

test('PICKER CANCEL: a taken-over dialog keeps the time it was first asked for: a dismissal long after that is a dismissal, however soon after the takeover', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const { outcome: first } = await startAndWait(rig, lane, 5_000);   // the dialog has been open for five seconds
  await lane.stop();
  assert.equal(await first, 'START_CANCELLED');
  const second = outcomeOf(lane.start(await pickParams(rig, { epoch: 2 })));   // takes the same dialog over
  await tick();
  assert.equal(rig.audio.picker.calls.length, 1, 'the same dialog');
  await rig.clock.advance(50);   // 50 ms after the takeover: a clock restarted by the takeover would call this a refusal
  rig.audio.picker.dismiss();
  assert.equal(await second, 'START_CANCELLED');
  assertNoError(lane);
});

test('PICKER CANCEL: the refusal window of a taken-over dialog is counted from the first call, on both sides of the boundary, at any clock value', async (t) => {
  for (const [shift, [sinceFirstCall, expected]] of CLOCK_SHIFTS_MS.flatMap((moved) => [[PICKER_REFUSED_AT_ONCE_MS - 1, 'TAB_CAPTURE_FAILED'],
    [PICKER_REFUSED_AT_ONCE_MS, 'START_CANCELLED']].map((entry) => [moved, entry]))) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    await rig.clock.advance(shift);
    const { outcome: first } = await startAndWait(rig, lane, 100);
    await lane.stop();
    assert.equal(await first, 'START_CANCELLED');
    const second = outcomeOf(lane.start(await pickParams(rig, { epoch: 2 })));
    await tick();
    assert.equal(rig.audio.picker.calls.length, 1);
    await rig.clock.advance(sinceFirstCall - 100);   // the takeover itself happened at 100 ms
    rig.audio.picker.dismiss();
    assert.equal(await second, expected, `${sinceFirstCall} ms after the dialog was first asked for (clock at ${shift} before)`);
    if (expected === 'START_CANCELLED') assertNoError(lane);
    else assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_CAPTURE_FAILED');
  }
});

test('PICKER CANCEL: the late rejection of a dialog nobody waits for any more never turns into an error, whatever it is and however soon it comes', async (t) => {
  for (const [name, openFor] of [['NotAllowedError', 0], ['NotAllowedError', 5_000], ['AbortError', 0], ['AbortError', 5_000]]) {
    const rig = createRig();
    const { lane, log } = newTab(rig);
    t.after(() => lane.dispose());
    const { outcome: started } = await startAndWait(rig, lane, openFor);
    await lane.stop();
    assert.equal(await started, 'START_CANCELLED');
    log.length = 0;
    rig.audio.picker.dismiss(name);   // the user closes the dialog that was left behind (or Chrome fails it)
    await tick();
    await rig.clock.advance(1_000);
    assertNoError(lane);
    assert.equal(rig.audio.picker.pending(), 0);
    assert.equal(rig.audio.contexts.length, 0);
    assert.deepEqual(log, [], `${name} after ${openFor} ms: the lane reported nothing`);
    // and the lane is free for the next start
    const again = lane.start(await pickParams(rig, { epoch: 2 }));
    await tick();
    rig.audio.picker.choose({ label: `${NONCE}.5` });
    assert.deepEqual(await again, { epoch: 2, tabId: 5 });
  }
});

// This pins the LANE CONTROLLER's override (lane-engine.js begin(): a cancelled run ends START_CANCELLED whatever the
// acquisition threw); the `run.cancelled ||` guard inside tab-lane.js is defensive and is not what makes this pass.
test('PICKER CANCEL: the lane controller overrides the tab lane\'s code: a rejection and a Stop in the same turn end START_CANCELLED, not an error, even for an at-once refusal', async (t) => {
  for (const name of ['NotAllowedError', 'AbortError']) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    const { outcome: started } = await startAndWait(rig, lane, 0);
    rig.audio.picker.dismiss(name);
    const stopping = lane.stop();   // before any promise handler of the rejection has run
    assert.equal(await started, 'START_CANCELLED', name);
    await stopping;
    assertNoError(lane);
  }
});

// The model of the real-browser finding that the fakes carry (docs/extension.md §20, check 20.5; headless Chrome for Testing 149,
// headed Chrome and Windows UNVERIFIED): everything the worker's closeLeftOverDialog and the integration tests rely on.
const tabCaptureOf = (rig, id) => rig.env.navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } });
const stillPending = async (promise) => Promise.race([promise.then(() => false), tick().then(() => tick()).then(() => true)]);

test('FAKE: a share dialog nobody answered holds a tab-capture getUserMedia of the same document, not a microphone one; answering it lets the held call go on', async (t) => {
  for (const answer of ['choose', 'dismiss']) {
    const rig = createRig();
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    const starting = outcomeOf(lane.start(await pickParams(rig)));
    await tick();
    assert.equal(rig.audio.picker.pending(), 1);
    const id = await rig.tabStreamId(8);
    const held = tabCaptureOf(rig, id);
    assert.equal(await stillPending(held), true, 'the tab capture never completes while the dialog is open');
    assert.equal(rig.audio.blockedTabCaptures(), 1);
    assert.equal(rig.browser.captures.has(8), false, 'and the stream id is not used up while it waits');
    const mic = await rig.env.navigator.mediaDevices.getUserMedia({ audio: true });
    assert.equal(mic.getAudioTracks().length, 1, 'a microphone is not held');
    if (answer === 'choose') rig.audio.picker.choose({ label: `${NONCE}.8` }); else rig.audio.picker.dismiss();
    const stream = await held;
    assert.equal(stream.getAudioTracks().length, 1);
    assert.equal(rig.audio.blockedTabCaptures(), 0);
    assert.equal(rig.browser.captures.has(8), true);
    await starting;
    // with no dialog open, a tab capture is not held
    const idle = await rig.tabStreamId(9);
    assert.equal((await tabCaptureOf(rig, idle)).getAudioTracks().length, 1);
  }
});

test('FAKE: closing the offscreen document takes its open dialog with it and a call it was holding never completes; a tab capture in the NEW document is not held', async (t) => {
  const rig = createRig();
  const { browser } = rig;
  const chromeSw = rig.swChrome();
  const open = () => chromeSw.offscreen.createDocument({ url: 'extension/engine/host.html', reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'], justification: 'tests' });
  await open();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const starting = outcomeOf(lane.start(await pickParams(rig)));
  await tick();
  assert.equal(rig.audio.picker.pending(), 1);
  const held = tabCaptureOf(rig, await rig.tabStreamId(8));
  assert.equal(await stillPending(held), true);
  await chromeSw.offscreen.closeDocument();
  assert.equal(rig.audio.picker.pending(), 0, 'the dialog is gone with its document');
  assert.equal(rig.audio.picker.gone(), 1);
  assert.equal(rig.audio.blockedTabCaptures(), 0);
  assert.throws(() => rig.audio.picker.choose({ label: null }), /no share picker is open/);
  assert.equal(await stillPending(held), true, 'a call of a document that no longer exists never completes');
  assert.equal(rig.audio.picker.calls.length, 1, 'the log of calls is kept');
  // the new document has no dialog: its tab capture goes through at once
  await open();
  assert.equal(browser.offscreenDocument !== null, true);
  const fresh = await tabCaptureOf(rig, await rig.tabStreamId(9));
  assert.equal(fresh.getAudioTracks().length, 1);
  assert.equal(rig.audio.picker.pending(), 0);
  void starting;
});

test('FAKE: pickerBlocksTabCapture:false switches the block off (the fake as it was before the finding)', async (t) => {
  const rig = createRig();
  const unblocked = createFakeAudioEnv({ browser: rig.browser, sockets: rig.sockets, pickerBlocksTabCapture: false });
  const { lane } = newTab(rig, { env: unblocked.env });
  t.after(() => lane.dispose());
  void lane.start(await pickParams(rig)).catch(() => {});
  await tick();
  assert.equal(unblocked.picker.pending(), 1);
  const stream = await unblocked.env.navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: await rig.tabStreamId(8) } } });
  assert.equal(stream.getAudioTracks().length, 1);
});

test('PICKER: the shared tab closing, or "Stop sharing", ends the lane with TAB_ENDED like any captured tab', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const starting = lane.start(await pickParams(rig));
  await tick();
  const stream = rig.audio.picker.choose({ label: `${NONCE}.8` });
  await starting;
  await rig.connect({ worklet: 0, socket: 0 });
  assert.equal(lane.phase(), 'running');
  stream.getAudioTracks()[0].end();
  await until(() => lane.phase() === 'error', 'the lane to end');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_ENDED');
});

// ---------------------------------------------------------------------------------------------
// §22 (2026-10-08): the relay start. The side panel opened the share dialog itself and relays the tab's audio; the lane
// rebuilds it from the relay channel. Every test here fails on 0.5.0, which knew the stream id and the §19 dialog only.
const RELAY_ID = 'fedcba9876543210'.repeat(2);
const relayParams = (rig, options = {}) => tabParams(rig, { relay: RELAY_ID, chosenTab: 9, ...options });
/** The panel's side of a relay start over the rig's relay world: its captured track, its sender and a feeder. */
function panelSide(rig) {
  const world = rig.audio.relay;
  const track = new FakeTrack({ kind: 'audio', label: 'Tab audio', source: createMediaSource() });
  let sender = null;
  return {
    world, track,
    open() {
      sender = createRelaySender({ track, relayId: RELAY_ID, env: { MediaStreamTrackProcessor: world.MediaStreamTrackProcessor, BroadcastChannel: world.BroadcastChannel } });
      return sender;
    },
    get sender() { return sender; },
    feed(chunks = 2, value = 0.25) {
      for (let chunk = 0; chunk < chunks; chunk += 1) world.feed(track, { frames: 480, sampleRate: 48000, channels: 2, fill: () => value });
    },
  };
}
async function relayUp(rig, lane, options = {}) {
  const panel = panelSide(rig);
  const starting = lane.start(await relayParams(rig, options));
  panel.open();
  panel.feed();
  return { panel, started: await starting };
}

test('RELAY: the lane listens on the relay channel (no getUserMedia, no dialog), plays the relayed tab at the original volume with a keep-alive, and answers the chosen tab', async (t) => {
  const rig = createRig({ relay: true });
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  let userMediaCalls = 0;
  const getUserMedia = rig.env.navigator.mediaDevices.getUserMedia;
  rig.env.navigator.mediaDevices.getUserMedia = (constraints) => { userMediaCalls += 1; return getUserMedia(constraints); };
  const before = rig.counts();
  const { panel, started } = await relayUp(rig, lane, { originalVolume: 40, chosenTab: 9 });
  assert.deepEqual(started, { epoch: 1, tabId: 9 }, 'the answer names the tab the panel learned from the capture label');
  assert.equal(lane.facts().tabId, 9);
  assert.equal(userMediaCalls, 0, 'nothing is captured here: the panel holds the capture');
  assert.equal(rig.audio.picker.calls.length, 0, 'and no dialog is asked for here');
  const [generator] = panel.world.generators;
  assert.ok(generator.written.length >= 1, 'the relayed audio is written into the generator');
  assert.equal(generator.written[0].samples[0], 0.25);
  const graphContext = rig.audio.contexts[0];
  const [source] = graphContext.nodes.filter((node) => node.kind === 'mediaStreamSource');
  assert.deepEqual(source.mediaStream.getAudioTracks(), [generator], 'the graph plays the generator\'s stream');
  assert.equal(graphContext.nodes.find((node) => node.kind === 'gain').gain.value, 0.4);
  const keeper = graphContext.nodes.find((node) => node.kind === 'constantSource');
  assert.equal(keeper?.offset.value, KEEP_ALIVE_LEVEL, 'the relayed graph keeps itself out of Chrome\'s silent-sink slowdown');
  lane.setOriginalVolume(70);
  assert.equal(graphContext.nodes.find((node) => node.kind === 'gain').gain.value, 0.7, 'the volume stays live');
  await rig.connect(before);
  assert.equal(lane.phase(), 'running');
  // the chosen tab may be unknown: the lane still runs, and says so with a null tab
  const rig2 = createRig({ relay: true });
  const other = newTab(rig2);
  t.after(() => other.lane.dispose());
  assert.deepEqual((await relayUp(rig2, other.lane, { chosenTab: null })).started, { epoch: 1, tabId: null });
});

test('RELAY: a tab Chrome did not silence (passthrough false) is not played back a second time, whatever the volume says', async (t) => {
  const rig = createRig({ relay: true });
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  await relayUp(rig, lane, { passthrough: false, originalVolume: 80 });
  const gain = rig.audio.contexts[0].nodes.find((node) => node.kind === 'gain');
  assert.equal(gain.gain.value, 0);
  lane.setOriginalVolume(100);
  assert.equal(gain.gain.value, 0);
  assert.ok(rig.audio.contexts[0].nodes.some((node) => node.kind === 'constantSource' && node.started), 'the keep-alive still runs');
});

test('RELAY: no first audio within LIMITS.relayFirstFrameMs is TAB_CAPTURE_FAILED; the relay is closed and no graph was built', async () => {
  const rig = createRig({ relay: true });
  const { lane } = newTab(rig);
  const starting = outcomeOf(lane.start(await relayParams(rig)));
  await tick();
  const world = rig.audio.relay;
  assert.equal(world.listening(`${RELAY_CHANNEL_PREFIX}${RELAY_ID}`).length, 1, 'the lane listens');
  await rig.clock.advance(LIMITS.relayFirstFrameMs - 1);
  assert.equal(lane.phase(), 'starting');
  await rig.clock.advance(1);
  assert.equal(await starting, 'TAB_CAPTURE_FAILED');
  assert.equal(lane.phase(), 'error');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_CAPTURE_FAILED');
  assert.equal(world.listening(`${RELAY_CHANNEL_PREFIX}${RELAY_ID}`).length, 0, 'the channel is closed');
  assert.equal(world.generators[0].readyState, 'ended');
  assert.equal(rig.audio.contexts.length, 0, 'no graph');
  assert.equal(rig.sockets.sockets.length, 0, 'no engine');
});

test('RELAY CANCEL: Stop while the first audio is awaited ends START_CANCELLED at once and closes the relay; audio that comes later is dropped', async () => {
  const rig = createRig({ relay: true });
  const { lane } = newTab(rig);
  const starting = outcomeOf(lane.start(await relayParams(rig)));
  await tick();
  await lane.stop();
  assert.equal(await starting, 'START_CANCELLED');
  assert.equal(lane.phase(), 'off');
  assert.equal(stateOf(lane, 'tab').errorCode, null);
  const world = rig.audio.relay;
  assert.equal(world.listening(`${RELAY_CHANNEL_PREFIX}${RELAY_ID}`).length, 0);
  assert.equal(world.generators[0].readyState, 'ended');
  const panel = panelSide(rig);
  panel.open();
  panel.feed(4);
  await tick();
  assert.equal(world.generators[0].written.length, 0, 'nothing is written into a stopped relay');
  assert.equal(rig.audio.contexts.length, 0);
});

test('RELAY: the relay ending before the first audio: the tab gone is TAB_ENDED, the panel\'s own stop settles in off quietly', async () => {
  for (const [how, expected] of [['track', 'TAB_ENDED'], ['stop', 'START_CANCELLED']]) {
    const rig = createRig({ relay: true });
    const { lane } = newTab(rig);
    const starting = outcomeOf(lane.start(await relayParams(rig)));
    const panel = panelSide(rig);
    const sender = panel.open();
    if (how === 'track') panel.track.end(); else sender.stop();
    assert.equal(await starting, expected, how);
    await until(() => lane.phase() === (expected === 'TAB_ENDED' ? 'error' : 'off'), `${how}: settled`);
    assert.equal(stateOf(lane, 'tab').errorCode, expected === 'TAB_ENDED' ? 'TAB_ENDED' : null);
    assert.equal(rig.audio.contexts.length, 0);
  }
});

test('RELAY: the shared tab ending while the lane runs (the panel\'s track ends) is TAB_ENDED, through the relay\'s end message', async (t) => {
  const rig = createRig({ relay: true });
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  const { panel } = await relayUp(rig, lane);
  const { socket } = await rig.connect(before);
  assert.equal(lane.phase(), 'running');
  panel.track.end();   // the tab was closed, or Chrome's "Stop sharing"
  await until(() => lane.phase() === 'error', 'TAB_ENDED');
  assert.equal(stateOf(lane, 'tab').errorCode, 'TAB_ENDED');
  assert.equal(lane.facts().stopRequested, false);
  assert.ok(socket.closeCalls >= 1, 'the Live session was closed');
  assert.equal(panel.world.generators[0].readyState, 'ended');
  assert.ok(rig.audio.contexts.every((context) => context.state === 'closed'));
});

test('RELAY: the panel\'s own stop (Stop, Cancel, the icon, the panel closing) ends a running lane in off, never TAB_ENDED, even before its host/lane-stop', async (t) => {
  for (const reason of [undefined, 'pagehide']) {
    const rig = createRig({ relay: true });
    const { lane } = newTab(rig);
    t.after(() => lane.dispose());
    const before = rig.counts();
    const { panel } = await relayUp(rig, lane);
    await rig.connect(before);
    panel.sender.stop(reason);
    await until(() => lane.phase() === 'off', 'off');
    assert.equal(stateOf(lane, 'tab').errorCode, null, String(reason));
    assert.equal(lane.facts().hostError, null);
    assert.equal(lane.facts().stopRequested, true, 'reads as a requested stop: no "stopped" notice on the page');
    await lane.stop();   // the host/lane-stop that follows finds nothing to do
    assert.equal(lane.phase(), 'off');
  }
});

test('RELAY: Stop releases the relay (channel closed, generator stopped) and the graph with its keep-alive; the lane starts again', async (t) => {
  const rig = createRig({ relay: true });
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  const { panel } = await relayUp(rig, lane);
  await rig.connect(before);
  const keeper = rig.audio.contexts[0].nodes.find((node) => node.kind === 'constantSource');
  await lane.stop();
  assert.equal(lane.phase(), 'off');
  assert.equal(panel.world.channels[0].name, `${RELAY_CHANNEL_PREFIX}${RELAY_ID}`);
  assert.equal(panel.world.channels[0].closed, true, 'the lane\'s channel (the first one: it listened before the panel sent) is closed');
  assert.equal(panel.world.generators[0].readyState, 'ended');
  assert.equal(panel.world.generators[0].writerClosed, true);
  assert.equal(keeper.stopped, true);
  assert.equal(rig.audio.contexts[0].state, 'closed');
  assert.equal(panel.track.readyState, 'live', 'the panel\'s track is the panel\'s to stop');
  // a new relay start with a new id works on the same lane
  const panel2 = panelSide(rig);
  const params = await relayParams(rig, { relay: 'abcdef0123456789'.repeat(2), epoch: 2 });
  const starting = lane.start(params);
  const sender = createRelaySender({ track: panel2.track, relayId: params.tab.relay, env: { MediaStreamTrackProcessor: panel2.world.MediaStreamTrackProcessor, BroadcastChannel: panel2.world.BroadcastChannel } });
  panel2.feed();
  assert.deepEqual(await starting, { epoch: 2, tabId: 9 });
  sender.stop();
});

test('RELAY: a realm without MediaStreamTrackGenerator answers TAB_CAPTURE_FAILED at once; nothing listens and nothing is built', async () => {
  const rig = createRig();   // the plain offscreen env: no relay constructors
  assert.equal(rig.env.MediaStreamTrackGenerator, undefined);
  const { lane } = newTab(rig);
  await assert.rejects(lane.start(await relayParams(rig)), code('TAB_CAPTURE_FAILED'));
  assert.equal(lane.phase(), 'error');
  assert.equal(rig.audio.relay.channels.length, 0);
  assert.equal(rig.audio.contexts.length, 0);
  // only the generator missing
  const partial = createRig({ relay: true });
  const { lane: other } = newTab(partial, { env: { ...partial.env, MediaStreamTrackGenerator: undefined } });
  await assert.rejects(other.start(await relayParams(partial)), code('TAB_CAPTURE_FAILED'));
});

test('RELAY: the stream-id and the §19 dialog starts are untouched: no relay channel, no keep-alive, the same answers', async (t) => {
  const rig = createRig({ relay: true });
  const a = newTab(rig);
  t.after(() => a.lane.dispose());
  assert.deepEqual(await a.lane.start(await tabParams(rig)), { epoch: 1 });
  assert.equal(rig.audio.relay.channels.length, 0);
  assert.equal(rig.audio.contexts[0].nodes.some((node) => node.kind === 'constantSource'), false);
  await a.lane.stop();
  const b = newTab(rig);
  t.after(() => b.lane.dispose());
  const starting = b.lane.start(await pickParams(rig, { epoch: 2 }));
  await tick();
  rig.audio.picker.choose({ label: `${NONCE}.8` });
  assert.deepEqual(await starting, { epoch: 2, tabId: 8 });
  assert.equal(rig.audio.relay.channels.length, 0);
  assert.equal(rig.audio.contexts.at(-1).nodes.some((node) => node.kind === 'constantSource'), false);
});

test('CANCEL: stop during the mic permission query - nothing exists yet, the start rejects START_CANCELLED, phase off', async () => {
  const rig = createRig();
  const { lane } = newMic(rig);
  rig.audio.setPermissionsMode('held');
  const starting = outcomeOf(lane.start(await rig.laneParams('mic')));
  await tick();
  assert.equal(rig.audio.pendingPermissionQueries(), 1);
  assert.equal(lane.phase(), 'starting');
  const stopping = lane.stop();
  rig.audio.releasePermissionQueries();
  await stopping;
  assert.equal(await starting, 'START_CANCELLED');
  assert.equal(lane.phase(), 'off');
  assert.equal(lane.facts().hostError, null);
  assert.equal(rig.audio.contexts.length, 0);
  assert.equal(rig.audio.worklets.length, 0);
  assert.equal(rig.sockets.sockets.length, 0);
  assert.equal(rig.audio.micStreams.length, 0, 'the microphone was never asked for');
});

test('CANCEL: a stop that lands before any start is a no-op', async () => {
  const rig = createRig();
  for (const { lane, log } of [newTab(rig), newMic(rig)]) {
    await lane.stop();
    await lane.stop({ error: 'TAB_ENDED' });
    assert.equal(lane.phase(), 'off');
    assert.equal(lane.facts().hostError, null);
    assert.equal(lane.facts().stopRequested, false);
    assert.deepEqual(log, [], 'no state change was announced');
  }
});

// ---------------------------------------------------------------------------------------------
// Stop order (5.7) with a failure injected in each step: the later steps still run.

test('STOP ORDER: engine.stop, engine.close, config.dispose, playback.close, then the raw tracks, then the graph context; a failing step never blocks the next', async () => {
  const expected = ['engine.stop', 'engine.close', 'config.dispose', 'playback.close', 'raw-track-stop', 'graph.close'];
  for (const failAt of [null, ...expected]) {
    const rig = createRig();
    const sequence = [];
    const record = (step) => { if (expected.includes(step)) sequence.push(step); };
    // The engine side is stubbed (its steps are recorded by `stubbed`); the graph side is the real one, observed here.
    const stub = stubbed({ failAt: expected.slice(0, 4).includes(failAt) ? failAt : null, onStep: record });
    const originalConsume = rig.browser.consumeStreamId;
    rig.browser.consumeStreamId = (id, options) => {
      const stream = originalConsume(id, options);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { record('raw-track-stop'); stop(); if (failAt === 'raw-track-stop') throw new Error('boom'); };
      }
      return stream;
    };
    const Base = rig.env.AudioContext;
    const env = { ...rig.env, AudioContext: class extends Base {
      async close() {
        // The stub engine builds its playback context through the lane env too (getAudioContext): 24 kHz marks it.
        const playback = this.options?.sampleRate === 24000;
        record(playback ? 'playback.close' : 'graph.close');
        if (playback && failAt === 'playback.close') { await super.close(); throw new Error('boom'); }
        const closed = await super.close();
        if (!playback && failAt === 'graph.close') throw new Error('boom');
        return closed;
      } } };
    // The real playback close is recorded above, so the stub's own class is unused: silence its duplicate record.
    const deps = { ...stub.deps };
    const lane = createTabLane({ env, timers: rig.clock, onChange() {}, deps });
    await lane.start(await tabParams(rig));
    sequence.length = 0;
    await lane.stop();
    assert.deepEqual(sequence, expected, `failAt ${failAt}: every step ran, in the order of 5.7`);
    assert.equal(lane.phase(), 'off', `failAt ${failAt}`);
    assert.equal(rig.browser.captures.size, 0, `failAt ${failAt}: the capture is released`);
  }
});

// ---------------------------------------------------------------------------------------------
// The microphone lane.

test('mic lane preflight: prompt or denied is MICROPHONE_DENIED without starting the engine or touching a device', async () => {
  for (const permission of ['prompt', 'denied']) {
    const rig = createRig({ micPermission: permission });
    const { lane } = newMic(rig);
    await assert.rejects(lane.start(await rig.laneParams('mic')), code('MICROPHONE_DENIED'), permission);
    assert.equal(lane.phase(), 'error');
    assert.equal(stateOf(lane, 'mic').errorCode, 'MICROPHONE_DENIED');
    assert.equal(rig.audio.contexts.length, 0);
    assert.equal(rig.audio.worklets.length, 0);
    assert.equal(rig.sockets.sockets.length, 0);
    assert.equal(rig.audio.micStreams.length, 0, 'the host cannot show a prompt, so it does not ask');
  }
});

test('mic lane preflight: a missing or throwing permissions.query proceeds to the real capture', async (t) => {
  for (const mode of ['missing', 'throws']) {
    const rig = createRig();
    rig.audio.setPermissionsMode(mode);
    const { lane } = newMic(rig);
    t.after(() => lane.dispose());
    const before = rig.counts();
    await lane.start(await rig.laneParams('mic', { model: DEFAULT_LIVE_MODEL }));
    await rig.connect(before);
    assert.equal(lane.phase(), 'running', mode);
    assert.equal(rig.audio.micStreams.length, 1, 'the microphone platform uses navigator.mediaDevices.getUserMedia');
  }
});

test('mic lane: a capture failure after the preflight surfaces through the snapshot as MICROPHONE_DENIED', async (t) => {
  const rig = createRig();
  rig.audio.setMicError('NotAllowedError');
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await rig.laneParams('mic'));
  await until(() => lane.phase() === 'error', 'the capture failure');
  assert.equal(stateOf(lane, 'mic').errorCode, 'MICROPHONE_DENIED');
  assert.equal(rig.sockets.sockets.length, 0, 'no Live session for a microphone that never opened');
});

test('mic lane: input level reaches the lane; stop releases the microphone track and every context', async () => {
  const rig = createRig();
  const { lane } = newMic(rig);
  const before = rig.counts();
  await lane.start(await rig.laneParams('mic', { model: DEFAULT_LIVE_MODEL }));
  const { worklet } = await rig.connect(before);
  assert.equal(lane.phase(), 'running');
  worklet.emitFrames(0.25);
  assert.equal(lane.level(), 100, 'rms 0.25 is a full meter');
  assert.equal(stateOf(lane, 'mic').level, 100);
  await lane.stop();
  assert.equal(lane.phase(), 'off');
  assert.equal(lane.level(), 0);
  assert.equal(rig.audio.micStreams[0].getTracks()[0].readyState, 'ended', 'the microphone is released');
  assert.ok(rig.audio.contexts.every((context) => context.state === 'closed'));
});

// ---------------------------------------------------------------------------------------------
// Two lanes at once (5.9): isolated configs, one Live socket each.

async function bothRunning(t, rig, { tabOptions = {}, micOptions = {} } = {}) {
  const tab = newTab(rig, tabOptions.lane);
  const mic = newMic(rig, micOptions.lane);
  t.after(() => tab.lane.dispose());
  t.after(() => mic.lane.dispose());
  let before = rig.counts();
  await tab.lane.start(await tabParams(rig, { model: TRANSLATE_LIVE_MODEL, ...tabOptions.params }));
  const tabUp = await rig.connect(before);
  before = rig.counts();
  await mic.lane.start(await rig.laneParams('mic', { model: DEFAULT_LIVE_MODEL, ...micOptions.params }));
  const micUp = await rig.connect(before);
  return { tab: tab.lane, mic: mic.lane, tabUp, micUp };
}

test('TWO LANES: tab + mic run concurrently on isolated configs, both running with retries 0; captions and stops stay separate', async (t) => {
  const rig = createRig();
  const { tab, mic, tabUp, micUp } = await bothRunning(t, rig);
  const measured = { tab: [tab.phase(), tab.snapshot().status, tab.snapshot().retries],
    mic: [mic.phase(), mic.snapshot().status, mic.snapshot().retries],
    sockets: rig.sockets.sockets.length, contexts: rig.audio.contexts.length,
    playback: rig.audio.contexts.filter((context) => context.options.sampleRate === 24000).length,
    micStreams: rig.audio.micStreams.length };
  t.diagnostic(`concurrency: ${JSON.stringify(measured)}`);
  assert.deepEqual(measured.tab, ['running', 'running', 0]);
  assert.deepEqual(measured.mic, ['running', 'running', 0]);
  assert.equal(measured.sockets, 2, 'one Live socket per lane');
  assert.equal(measured.contexts, 5, 'graph + capture + playback for the tab, capture + playback for the mic (5.3)');
  assert.equal(measured.playback, 2, 'each lane has its OWN playback context');
  assert.equal(measured.micStreams, 1, 'only the mic lane asks for a microphone');
  assert.equal(createSessionManager().occupied, false, 'the default Live slot stays free while both lanes run');
  assert.equal(tab.snapshot().route, 'translation');
  assert.equal(mic.snapshot().route, 'flash');

  // Captions never cross lanes.
  content(tabUp.socket, { inputTranscription: { text: 'from-tab' }, outputTranscription: { text: 'to-tab' } });
  content(micUp.socket, { inputTranscription: { text: 'from-mic' }, outputTranscription: { text: 'to-mic' } });
  await tick();
  assert.deepEqual(texts(tab).sort(), ['from-tab', 'to-tab']);
  assert.deepEqual(texts(mic).sort(), ['from-mic', 'to-mic']);

  // Stopping the tab lane leaves the mic lane untouched and uploading.
  await tab.stop();
  assert.equal(tab.phase(), 'off');
  assert.equal(mic.phase(), 'running');
  assert.equal(micUp.socket.closeCalls, 0);
  assert.equal(rig.audio.micStreams[0].getTracks()[0].readyState, 'live');
  const sentBefore = micUp.socket.sent.length;
  micUp.worklet.emitFrames(0.25); micUp.worklet.emitFrames(0.25);
  await rig.clock.advance(100);
  assert.ok(micUp.socket.sent.length > sentBefore, 'the mic lane keeps uploading audio');
  content(micUp.socket, { outputTranscription: { text: 'still-mic' } });
  await tick();
  assert.ok(texts(mic).some((text) => text.includes('still-mic')), 'and keeps receiving captions');
  await mic.stop();
  assert.deepEqual([tab.phase(), mic.phase()], ['off', 'off']);
});

test('TWO LANES: one lane failing (INVALID_KEY on its socket) leaves the other running, untouched', async (t) => {
  const rig = createRig();
  const { tab, mic, tabUp, micUp } = await bothRunning(t, rig);
  micUp.socket.json({ error: { code: 401 } });
  await until(() => mic.phase() === 'error', 'the mic lane to fail');
  assert.equal(stateOf(mic, 'mic').errorCode, 'INVALID_KEY');
  assert.equal(tab.phase(), 'running');
  assert.equal(tab.snapshot().status, 'running');
  assert.equal(tab.snapshot().retries, 0);
  assert.equal(tabUp.socket.closeCalls, 0);
  assert.equal(rawTrackOf(rig).readyState, 'live', 'the tab capture and passthrough keep going');
  assert.equal(rig.audio.contexts.filter((context) => context.state === 'running').length, 3, 'the tab lane\'s three contexts');
  const sentBefore = tabUp.socket.sent.length;
  tabUp.worklet.emitFrames(0.25); tabUp.worklet.emitFrames(0.25);
  await rig.clock.advance(100);
  assert.ok(tabUp.socket.sent.length > sentBefore);
});

test('TWO LANES: SESSION_LIMIT - a refused engine start fails only its own lane; a session refusal from Google starts a replacement while the other lane runs', async (t) => {
  // Synchronous refusal of the second lane's engine.
  const rig = createRig();
  const tab = newTab(rig);
  t.after(() => tab.lane.dispose());
  const before = rig.counts();
  await tab.lane.start(await tabParams(rig));
  await rig.connect(before);
  const mic = newMic(rig, { deps: { createSimEngine: () => { throw Object.assign(new Error('x'), { code: 'SESSION_LIMIT' }); } } });
  await assert.rejects(mic.lane.start(await rig.laneParams('mic')), code('SESSION_LIMIT'));
  assert.equal(stateOf(mic.lane, 'mic').errorCode, 'SESSION_LIMIT');
  assert.equal(tab.lane.phase(), 'running');

  // Google refusing a second concurrent session on the shared key: the engine treats it as retryable (5.9).
  const second = createRig();
  const pair = await bothRunning(t, second);
  pair.micUp.socket.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'ConcurrentSessions' }] }] } });
  await until(() => pair.mic.phase() === 'reconnecting', 'the replacement');
  assert.equal(pair.tab.phase(), 'running');
  assert.equal(pair.tab.snapshot().retries, 0);
});

test('TWO LANES: both lanes default to the latest Live model (0.5.1), and each lane\'s own model reaches its engine', async (t) => {
  const defaults = createDefaultSettings('ko');
  assert.equal(laneRequestOf(defaults, 'tab').model, DEFAULT_LIVE_MODEL);
  assert.equal(laneRequestOf(defaults, 'mic').model, DEFAULT_LIVE_MODEL);
  const rig = createRig();
  // The tab lane is started on the translation-only preview on purpose (a user's choice): the two lanes then differ.
  const { tab, mic } = await bothRunning(t, rig, {
    tabOptions: { params: { model: TRANSLATE_LIVE_MODEL } },
    micOptions: { params: { model: laneRequestOf(defaults, 'mic').model } } });
  assert.equal(tab.snapshot().model, TRANSLATE_LIVE_MODEL);
  assert.equal(mic.snapshot().model, DEFAULT_LIVE_MODEL);
});

// 2026-09-30: the engine replaces a connection that ended with INVALID_RESULT (within its budget) and names the check
// that refused the result. Fails on v0.3.1: one refused message ended the lane at once, and no reason existed.
test('INVALID_RESULT: a refused server message is replaced like a dropped connection; when the budget is spent the lane says which check refused it', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig));
  let { socket, worklet } = await rig.connect(before);
  const refuse = (target) => target.json({ serverContent: { turnComplete: 'yes' } });   // a flag that is not a boolean
  let replaced = 0;
  for (;;) {
    const known = rig.sockets.sockets.length;
    refuse(socket);
    await until(() => lane.phase() !== 'running', 'the refused message to end the connection');
    // Either a replacement session opens after the backoff, or the budget is spent and the lane fails.
    for (let elapsed = 0; rig.sockets.sockets.length === known && lane.phase() !== 'error' && elapsed < 10000; elapsed += 250) {
      assert.equal(stateOf(lane, 'tab').reconnectReason, null, 'an ordinary, visible reconnect: not a key swap or a handover');
      assert.equal(stateOf(lane, 'tab').errorReason, null, 'no reason is claimed while the lane is still trying');
      worklet.emitFrames(0.25);
      await rig.clock.advance(250);
    }
    if (rig.sockets.sockets.length === known) break;
    socket = rig.sockets.sockets.at(-1);
    socket.open();
    assert.equal(setupOf(socket).model, setupOf(rig.sockets.sockets[0]).model, 'the same model: a refused message is no reason for a model fallback');
    socket.json({ setupComplete: {} });
    await until(() => lane.phase() === 'running', 'the replacement to run');
    replaced += 1;
    assert.ok(replaced <= 3, 'the budget bounds the replacements');
  }
  assert.equal(replaced, 3, 'three replacements, then the operation fails');
  await until(() => lane.phase() === 'error', 'the lane to fail');
  const state = stateOf(lane, 'tab');
  assert.deepEqual([state.phase, state.errorCode, state.errorReason], ['error', 'INVALID_RESULT', 'flag-shape']);
  // The reason survives the run (the lane keeps a slim copy of the finished engine's snapshot) and goes with the next start.
  assert.equal(lane.snapshot().errorReason, 'flag-shape');
  await lane.start(await tabParams(rig, { epoch: 2 }));
  assert.equal(stateOf(lane, 'tab').errorReason, null);
});

test('the voice gender is set on the module-level preference (one voice for both lanes, applied to later sessions)', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  t.after(() => { liveVoicePreference.set({ gender: 'female' }); });
  await lane.start(await rig.laneParams('mic', { voiceGender: 'male' }));
  assert.equal(liveVoicePreference.snapshot().gender, 'male');
});

test('the API key never shows up in a lane\'s facts, snapshot or state', async (t) => {
  const rig = createRig();
  const { tab, mic } = await bothRunning(t, rig, { tabOptions: { params: { key: fakeKey('tab-secret') } },
    micOptions: { params: { key: fakeKey('mic-secret') } } });
  for (const [lane, name, key] of [[tab, 'tab', fakeKey('tab-secret')], [mic, 'mic', fakeKey('mic-secret')]]) {
    const shown = JSON.stringify({ facts: lane.facts(), snapshot: lane.snapshot(), state: stateOf(lane, name) });
    assert.equal(shown.includes(key), false, name);
    assert.equal(shown.includes('synthetic-'), false, `${name}: no key-shaped text at all`);
  }
});

// ---------------------------------------------------------------------------------------------
// Two-way mode (the D10 "no two-way" non-goal was reversed): the pair travels from the start parameters to the Live setup.

const setupOf = (socket) => socket.sent[0].setup;
const NATIVE_AUDIO_MODEL = LIVE_MODELS[2];
const instructionOf = (socket) => setupOf(socket).systemInstruction?.parts[0].text ?? '';

test('TWO-WAY tab lane: a translation-only model with a pair still starts (on the instruction route) and the lane reports the model it really runs', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig, { model: TRANSLATE_LIVE_MODEL, languages: ['ko', 'en'] }));
  // truthful from the very first snapshot, before any socket exists
  assert.deepEqual([lane.snapshot().model, lane.snapshot().route], [DEFAULT_LIVE_MODEL, 'flash']);
  const { socket } = await rig.connect(before);
  assert.equal(lane.phase(), 'running', 'the translation-only default and a pair is not a refusal: the engine switches');
  assert.equal(setupOf(socket).model, `models/${DEFAULT_LIVE_MODEL}`, 'the Live setup names the instruction-driven model');
  assert.equal(setupOf(socket).generationConfig.translationConfig, undefined, 'and carries no single translation target');
  assert.match(instructionOf(socket), /two-way INTERPRETER between Korean and English/, 'the pair is one instruction');
  const snapshot = lane.snapshot();
  assert.deepEqual([snapshot.model, snapshot.route, snapshot.fallback], [DEFAULT_LIVE_MODEL, 'flash', false], 'a chosen switch is not a fallback');
  const state = stateOf(lane, 'tab');
  assert.deepEqual([state.model, state.route, state.fallback, state.targetLanguage], [DEFAULT_LIVE_MODEL, 'flash', false, 'ko']);
  assert.deepEqual(lane.facts().languages, ['ko', 'en']);
  await lane.stop();
  assert.equal(lane.phase(), 'off');
  assert.equal(lane.snapshot().model, DEFAULT_LIVE_MODEL, 'the finished run remembers the model it ran');
});

test('one-way control: the same translation-only model without a pair keeps the single-target translation setup', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig, { model: TRANSLATE_LIVE_MODEL }));
  const { socket } = await rig.connect(before);
  assert.equal(setupOf(socket).model, `models/${TRANSLATE_LIVE_MODEL}`);
  assert.deepEqual(setupOf(socket).generationConfig.translationConfig, { targetLanguageCode: 'ko', echoTargetLanguage: false });
  assert.equal(instructionOf(socket), '');
  assert.deepEqual([lane.snapshot().model, lane.snapshot().route], [TRANSLATE_LIVE_MODEL, 'translation']);
});

test('TWO-WAY mic lane: the pair reaches the setup on the instruction-driven default model, the order [target, partner] is kept', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await rig.laneParams('mic', { model: DEFAULT_LIVE_MODEL, targetLanguage: 'ja', languages: ['ja', 'en'] }));
  const { socket } = await rig.connect(before);
  assert.equal(lane.phase(), 'running');
  assert.equal(setupOf(socket).model, `models/${DEFAULT_LIVE_MODEL}`);
  assert.match(instructionOf(socket), /two-way INTERPRETER between Japanese and English/);
  assert.equal(stateOf(lane, 'mic').targetLanguage, 'ja', 'the lane\'s own language stays the first of the pair');
  assert.deepEqual(lane.facts().languages, ['ja', 'en']);
  assert.equal(rig.audio.micStreams.length, 1, 'a two-way mic lane opens the microphone like any other');
});

test('TWO-WAY: a replacement session after a failure is two-way as well, and the lane reports the model it moved to', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig, { model: TRANSLATE_LIVE_MODEL, languages: ['ko', 'ja'] }));
  const { socket, worklet } = await rig.connect(before);
  socket.json({ error: { code: 503 } });   // UNAVAILABLE: the engine replaces the session
  await until(() => lane.phase() === 'reconnecting', 'the failure');
  const sockets = rig.sockets.sockets.length;
  for (let elapsed = 0; rig.sockets.sockets.length === sockets && elapsed < 6000; elapsed += 250) {
    worklet.emitFrames(0.25);
    await rig.clock.advance(250);
  }
  const replacement = rig.sockets.sockets.at(-1);
  assert.notEqual(replacement, socket, 'a replacement session was opened');
  replacement.open(); replacement.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'the replacement to run');
  assert.match(instructionOf(replacement), /two-way INTERPRETER between Korean and Japanese/, 'the pair is part of every session, not only the first');
  assert.equal(setupOf(replacement).generationConfig.translationConfig, undefined);
  const state = stateOf(lane, 'tab');
  assert.equal(setupOf(replacement).model, `models/${state.model}`, 'the state names the model the replacement really uses');
  assert.equal(state.fallback, true, 'a switch the engine had to make IS reported as a fallback');
});

test('TWO-WAY: the replacement after a failure opens at the first backoff on the native-audio model, never via the translation-only one', async (t) => {
  const rig = createRig();
  const seen = [];
  let lane;
  // Every state the lane publishes while it recovers: a two-way lane must never claim the translation-only model.
  ({ lane } = newTab(rig, { onChange: () => { if (lane) seen.push(stateOf(lane, 'tab').model); } }));
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig, { model: DEFAULT_LIVE_MODEL, languages: ['ko', 'ja'] }));
  const { socket, worklet } = await rig.connect(before);
  const failedAt = rig.clock.now();
  socket.json({ error: { code: 503 } });   // UNAVAILABLE: the default model failed
  await until(() => lane.phase() === 'reconnecting', 'the failure');
  const sockets = rig.sockets.sockets.length;
  for (let elapsed = 0; rig.sockets.sockets.length === sockets && elapsed < 6000; elapsed += 250) {
    worklet.emitFrames(0.25);
    await rig.clock.advance(250);
  }
  // One backoff (1 s plus at most 25 % jitter), not two: no attempt was spent on a model that refuses a pair.
  assert.ok(rig.clock.now() - failedAt <= 1250, `replacement opened after ${rig.clock.now() - failedAt} ms`);
  const replacement = rig.sockets.sockets.at(-1);
  assert.notEqual(replacement, socket);
  replacement.open(); replacement.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'the replacement to run');
  assert.equal(setupOf(replacement).model, `models/${NATIVE_AUDIO_MODEL}`);
  assert.match(instructionOf(replacement), /two-way INTERPRETER between Korean and Japanese/);
  const state = stateOf(lane, 'tab');
  assert.deepEqual([state.model, state.route, state.fallback], [NATIVE_AUDIO_MODEL, 'flash', true]);
  assert.equal(lane.snapshot().retries, 1);
  assert.equal(seen.includes(TRANSLATE_LIVE_MODEL), false, `states seen: ${[...new Set(seen)].join(', ')}`);
});

test('TWO-WAY: a pair the engine refuses fails the lane with the engine\'s code, releases the capture and opens no session', async (t) => {
  const rig = createRig();
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  await assert.rejects(lane.start(await tabParams(rig, { languages: ['ko', 'ko'] })), code('INVALID_REQUEST'));
  assert.equal(lane.phase(), 'error');
  assert.equal(stateOf(lane, 'tab').errorCode, 'INVALID_REQUEST');
  assert.equal(rig.sockets.sockets.length, 0, 'no Live session for a pair that is no pair');
  assert.equal(rig.browser.captures.size, 0, 'the tab capture was released');
  // the lane is not stuck: a one-way start works afterwards, and the refused pair is not remembered
  const before = rig.counts();
  assert.deepEqual(await lane.start(await tabParams(rig, { epoch: 2 })), { epoch: 2 });
  await rig.connect(before);
  assert.equal(lane.phase(), 'running');
  assert.equal(lane.facts().languages, null);
});

test('TWO-WAY then one-way on the same lane: the second run is a plain one-way session and the pair is forgotten', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  let before = rig.counts();
  await lane.start(await rig.laneParams('mic', { model: DEFAULT_LIVE_MODEL, languages: ['ko', 'en'] }));
  const first = await rig.connect(before);
  assert.match(instructionOf(first.socket), /two-way/);
  await lane.stop();
  before = rig.counts();
  await lane.start(await rig.laneParams('mic', { epoch: 2, model: DEFAULT_LIVE_MODEL, targetLanguage: 'en' }));
  const second = await rig.connect(before);
  assert.doesNotMatch(instructionOf(second.socket), /two-way/);
  assert.match(instructionOf(second.socket), /simultaneous INTERPRETER into English/);
  assert.equal(lane.facts().languages, null);
  assert.equal(lane.facts().targetLanguage, 'en');
});

test('TWO LANES: one lane two-way and the other one-way run side by side, each with its own setup and captions', async (t) => {
  const rig = createRig();
  const { tab, mic, tabUp, micUp } = await bothRunning(t, rig, {
    tabOptions: { params: { model: TRANSLATE_LIVE_MODEL, languages: ['ko', 'ja'] } }, micOptions: { params: { targetLanguage: 'en' } } });
  assert.equal(rig.sockets.sockets.length, 2);
  assert.match(instructionOf(tabUp.socket), /two-way INTERPRETER between Korean and Japanese/);
  assert.match(instructionOf(micUp.socket), /simultaneous INTERPRETER into English/);
  assert.doesNotMatch(instructionOf(micUp.socket), /two-way/, 'the pair of one lane never leaks into the other');
  assert.deepEqual([tab.facts().languages, mic.facts().languages], [['ko', 'ja'], null]);
  assert.deepEqual([tab.snapshot().model, mic.snapshot().model], [DEFAULT_LIVE_MODEL, DEFAULT_LIVE_MODEL]);
  assert.deepEqual([tab.phase(), mic.phase()], ['running', 'running']);
  content(tabUp.socket, { outputTranscription: { text: 'to-tab' } });
  content(micUp.socket, { outputTranscription: { text: 'to-mic' } });
  await tick();
  assert.deepEqual(texts(tab), ['to-tab']);
  assert.deepEqual(texts(mic), ['to-mic']);
});

test('the API key never shows up in a two-way lane\'s facts, snapshot, state or Live setup', async (t) => {
  const rig = createRig();
  const key = fakeKey('twoway-secret');
  const { lane } = newTab(rig);
  t.after(() => lane.dispose());
  const before = rig.counts();
  await lane.start(await tabParams(rig, { key, model: TRANSLATE_LIVE_MODEL, languages: ['en', 'ja'], targetLanguage: 'en' }));
  const { socket } = await rig.connect(before);
  const shown = JSON.stringify({ facts: lane.facts(), snapshot: lane.snapshot(), state: stateOf(lane, 'tab'), sent: socket.sent });
  assert.equal(shown.includes(key), false);
  assert.equal(shown.includes('synthetic-'), false, 'no key-shaped text at all');
});

// ---------------------------------------------------------------------------------------------
// §20 (2026-10-02): the built-in key pool. Fails on 0.4.0, where the lane got BUILTIN_KEYS[0] only and installed it with
// setPersonal: a quota on it, or a refused key, ended the lane with no way to the other keys.

const POOL = Object.freeze([fakeKey('pool-a'), fakeKey('pool-b'), fakeKey('pool-c')]);
const keyOf = (url) => decodeURIComponent(new URL(url).searchParams.get('key'));
const poolParams = async (rig, lane, options = {}) => {
  const { key, ...params } = await rig.laneParams(lane, { model: DEFAULT_LIVE_MODEL, ...options });
  return { ...params, keys: [...(options.keys ?? POOL)] };
};
const REFUSED = 'API key not valid. Please pass a valid API key.';   // the close reason the real endpoint sent, 2026-10-02
// The next socket after `index`: one capture block on the lane's newest worklet (a key switch starts a new capture),
// then the socket appears.
async function nextSocket(rig, index) {
  await until(() => rig.audio.worklets.length > 0, 'a capture worklet');
  for (let round = 0; round < 50 && rig.sockets.sockets.length <= index; round += 1) {
    rig.audio.worklets.at(-1).emitFrames(0.25);
    await tick();
  }
  assert.ok(rig.sockets.sockets.length > index, `socket ${index} opened`);
  return rig.sockets.sockets[index];
}

test('§20 lane engine with a pool: setBuiltin + select, the swap hooks, a watched socket and the cooldown memory; a personal key gets none of them', () => {
  const memory = createKeyCooldownMemory();
  const seen = [];
  const deps = {
    createAppConfig(options) {
      seen.push(['config', options]);
      return { keyStore: { setBuiltin: (...args) => seen.push(['setBuiltin', ...args]), setPersonal: (...args) => seen.push(['setPersonal', ...args]),
        select: (...args) => seen.push(['select', ...args]) },
      router: {}, sessionManager: {}, resolveFallback: () => null, dispose: async () => {} };
    },
    createSimEngine(options) {
      seen.push(['engine', options]);
      return { subscribe: () => () => {}, start: () => ({ ready: Promise.resolve(), done: new Promise(() => {}) }), stop: async () => ({}),
        close: async () => {}, snapshot: () => ({ status: 'running' }) };
    },
    liveVoicePreference: { set() {} },
  };
  class Socket {}
  const env = { AudioContext: class {}, WebSocket: Socket, fetch: 'f', now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, random: () => 0 };
  createLaneEngine({ lane: 'mic', deps, env, platform: {}, onChange() {}, cooldowns: memory })
    .start({ keys: [...POOL], request: { targetLanguage: 'en', model: 'm' }, voiceGender: 'female', muted: false, sessionId: 'mic-1' });
  const [, options] = seen.find(([name]) => name === 'config');
  assert.equal(options.storage, memory, 'the document\'s cooldown memory, never localStorage');
  assert.notEqual(options.WebSocket, Socket, 'the pool\'s sockets are watched for a refused key');
  assert.ok(new options.WebSocket() instanceof Socket, 'a subclass of the real one');
  assert.deepEqual(seen.filter(([name]) => name === 'setBuiltin'), [['setBuiltin', 'gemini', [...POOL]]]);
  assert.equal(seen.some(([name]) => name === 'setPersonal'), false);
  assert.deepEqual(seen.find(([name]) => name === 'select'), ['select', 'gemini', 'personal']);
  const engineOptions = seen.find(([name]) => name === 'engine')[1];
  assert.equal(typeof engineOptions.swapCredential, 'function');
  assert.equal(typeof engineOptions.canSwapCredential, 'function');

  seen.length = 0;
  createLaneEngine({ lane: 'mic', deps, env, platform: {}, onChange() {}, cooldowns: memory })
    .start({ key: fakeKey('own'), request: { targetLanguage: 'en', model: 'm' }, voiceGender: 'female', muted: false, sessionId: 'mic-2' });
  const personal = seen.find(([name]) => name === 'config')[1];
  assert.deepEqual(Object.keys(personal).sort(), ['WebSocket', 'fetch', 'isolated'], 'a personal key: no storage');
  assert.equal(personal.WebSocket, Socket, 'and no watched socket');
  assert.equal(seen.some(([name]) => name === 'setBuiltin'), false);
  const plain = seen.find(([name]) => name === 'engine')[1];
  assert.equal(plain.swapCredential, undefined, 'no swap hooks for a person\'s key');
  assert.equal(plain.canSwapCredential, undefined);
});

test('§20 the cooldown memory keeps the cooldown record only, in memory, and reads anything else as absent', () => {
  const memory = createKeyCooldownMemory();
  assert.equal(memory.getItem('interp-app.builtin-cooldown.v1'), null);
  memory.setItem('interp-app.builtin-cooldown.v1', '{"0123abcd":5}');
  assert.equal(memory.getItem('interp-app.builtin-cooldown.v1'), '{"0123abcd":5}');
  memory.setItem('interp-app.personal-key.v1.gemini', fakeKey('never'));
  assert.equal(memory.getItem('interp-app.personal-key.v1.gemini'), null, 'a key is never kept');
  memory.setItem('interp-app.builtin-cooldown.v1', 7);
  assert.equal(memory.getItem('interp-app.builtin-cooldown.v1'), '{"0123abcd":5}', 'strings only');
  assert.ok(Object.isFrozen(memory));
});

test('§20 a REFUSED built-in key (close 1007 "API key not valid") moves the lane to the next key at once: same lane run, no failure shown', async (t) => {
  const rig = createRig();
  const phases = [];
  const { lane } = newMic(rig, { onChange: () => phases.push(stateOf(lane, 'mic')) });
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  const first = await nextSocket(rig, 0);
  assert.equal(keyOf(rig.urls[0]), POOL[0]);
  first.open();
  first.finishClose(1007, REFUSED);
  const second = await nextSocket(rig, 1);
  assert.equal(keyOf(rig.urls[1]), POOL[1], 'the next key of the pool, at once (no fake time passed)');
  second.open();
  second.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'running on the second key');
  assert.equal(rig.sockets.sockets.length, 2, 'the refused key was asked once, not three more times with backoff');
  assert.equal(phases.some((state) => state.phase === 'error' || state.errorCode !== null), false, 'never read as a failure');
  assert.equal(phases.some((state) => state.phase === 'off'), false, 'nor as a stop');
  assert.equal(lane.snapshot().model, DEFAULT_LIVE_MODEL, 'the same model: no backup model for a refused key');
  assert.equal(lane.snapshot().fallback, false);
  assert.equal(JSON.stringify({ snapshot: lane.snapshot(), facts: lane.facts() }).includes('synthetic-'), false, 'no key in what the lane shows');
});

test('§20 every key of the pool refused: each is tried ONCE, then the lane reports INVALID_KEY (not a lost network)', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  for (let index = 0; index < POOL.length; index += 1) {
    const socket = await nextSocket(rig, index);
    socket.open();
    socket.finishClose(1007, REFUSED);
  }
  await until(() => lane.phase() === 'error', 'the lane gave up');
  assert.deepEqual(rig.urls.map(keyOf), [...POOL], 'each key once, in order');
  assert.equal(stateOf(lane, 'mic').errorCode, 'INVALID_KEY');
  assert.equal(stateOf(lane, 'mic').keyFailure, true);
  await rig.clock.advance(30_000);
  await tick();
  assert.equal(rig.sockets.sockets.length, POOL.length, 'nothing is retried after that');
});

// The refusals Google sends for a restricted or disabled key are longer than a close reason may be (123 bytes), so they
// arrive cut short. These are the provider's texts (made-up project number and address), cut as the socket cuts them.
const cut = (text) => new TextDecoder().decode(new TextEncoder().encode(text).slice(0, 123));
const RESTRICTED = Object.freeze({
  api: cut('Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent are blocked.'),
  ip: cut('The provided API key has an IP address restriction. The originating IP address of the call (203.0.113.7) violates this restriction.'),
  disabled: cut('Generative Language API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=123456789012 then retry.'),
  referrer: cut('Requests from referer <empty> are blocked.'),
});

test('§20 (review K1) refusalOfClose: a 1007/1008 close before setupComplete is a refused key, cut-short texts included; after it only a refusal text counts', () => {
  assert.equal(RESTRICTED.api.endsWith('blocked.'), false, 'the API restriction really is cut before its "blocked"');
  for (const setUp of [false, true]) {
    for (const closeCode of [1007, 1008]) {
      assert.equal(refusalOfClose({ code: closeCode, reason: REFUSED }, setUp), 'INVALID_KEY', `${closeCode} ${setUp}`);
      assert.equal(refusalOfClose({ code: closeCode, reason: RESTRICTED.api }, setUp), 'PERMISSION_DENIED');
      assert.equal(refusalOfClose({ code: closeCode, reason: RESTRICTED.disabled }, setUp), 'PERMISSION_DENIED');
      assert.equal(refusalOfClose({ code: closeCode, reason: RESTRICTED.referrer }, setUp), 'PERMISSION_DENIED');
      assert.equal(refusalOfClose({ code: closeCode, reason: RESTRICTED.ip }, setUp), 'IP_DENIED');
    }
  }
  // The moment is the signal: any other 1007/1008 before setupComplete (a phrasing nobody has seen yet, an empty reason)
  for (const reason of ['', 'Some refusal phrased differently', undefined]) {
    assert.equal(refusalOfClose({ code: 1007, reason }, false), 'INVALID_KEY', String(reason));
    assert.equal(refusalOfClose({ code: 1008, reason }, false), 'PERMISSION_DENIED', String(reason));
    assert.equal(refusalOfClose({ code: 1008, reason }, true), null, `${String(reason)}: after setupComplete it is the network's`);
  }
  // Other close codes are never a refusal, whatever they say.
  for (const closeCode of [1000, 1006, 1011, 1013]) assert.equal(refusalOfClose({ code: closeCode, reason: REFUSED }, false), null);
  // What the provider gives a meaning of its own (a quota, an outage, a model it does not serve: the engine answers it
  // with a key swap, a retry or the backup model) and a malformed request are never a refused key. The copy of the
  // provider's rules agrees with normalizeGeminiLiveClose itself.
  const reasons = ['RESOURCE_EXHAUSTED: quota', '429 Too many', 'You exceeded your current quota', 'exceeded your current quota, please check',
    'UNAVAILABLE: try later', '503 Service Unavailable', 'MODEL_NOT_SUPPORTED: x', 'models/gemini-x is not found for API version v1beta',
    'model gemini-x is not supported for bidiGenerateContent'];
  for (const reason of reasons) {
    const own = normalizeGeminiLiveClose({ code: 1008, reason }).code;
    assert.equal(refusalOfClose({ code: 1008, reason }, false) === null, own !== 'NETWORK_ERROR', `${reason}: ${own}`);
  }
  assert.equal(normalizeGeminiLiveClose({ code: 1008, reason: 'You exceeded your current quota' }).code, 'NETWORK_ERROR', 'not a prefix: the provider does not mean it either');
  for (const reason of ['Request contains an invalid argument.', 'Invalid JSON payload received. Unknown name "x"', 'INVALID_ARGUMENT']) {
    assert.equal(refusalOfClose({ code: 1007, reason }, false), null, reason);
  }
  // A missing or hostile event is no refusal and never throws.
  assert.equal(refusalOfClose(null, false), null);
  assert.equal(refusalOfClose({ get code() { throw new Error('x'); } }, false), null);
});

test('§20 (review K1) a key restricted by API, by IP address or with the API disabled moves the lane to the next key: the cut-short 1008 before setupComplete', async (t) => {
  for (const [label, reason] of Object.entries(RESTRICTED)) {
    const rig = createRig();
    const { lane } = newMic(rig);
    t.after(() => lane.dispose());
    await lane.start(await poolParams(rig, 'mic'));
    const first = await nextSocket(rig, 0);
    first.open();
    first.finishClose(1008, reason);
    const second = await nextSocket(rig, 1);
    assert.equal(keyOf(rig.urls[1]), POOL[1], `${label}: the next key, at once`);
    second.open();
    second.json({ setupComplete: {} });
    await until(() => lane.phase() === 'running', `${label}: running on the second key`);
    assert.equal(stateOf(lane, 'mic').errorCode, null, label);
  }
  // Every key restricted: each once, then the refusal itself (not a lost network after three retries).
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  for (let index = 0; index < POOL.length; index += 1) {
    const socket = await nextSocket(rig, index);
    socket.open();
    socket.finishClose(1008, RESTRICTED.api);
  }
  await until(() => lane.phase() === 'error', 'the lane gave up');
  assert.deepEqual(rig.urls.map(keyOf), [...POOL]);
  assert.equal(stateOf(lane, 'mic').errorCode, 'PERMISSION_DENIED');
});

test('§20 (review K1) a 1008 AFTER setupComplete, or one that names a model, keeps the key: the engine\'s own reconnect, never a key switch', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  const first = await nextSocket(rig, 0);
  first.open();
  first.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'running on the first key');
  first.finishClose(1008, 'Policy violation');
  await until(() => rig.sockets.sockets.length === 2 || lane.phase() !== 'running', 'the engine reacted');
  await rig.clock.advance(5_000);
  await nextSocket(rig, 1);
  assert.equal(keyOf(rig.urls[1]), POOL[0], 'the same key: a close after the setup is not a refusal');

  const model = createRig();
  const other = newMic(model).lane;
  t.after(() => other.dispose());
  await other.start(await poolParams(model, 'mic'));
  const socket = await nextSocket(model, 0);
  socket.open();
  socket.finishClose(1008, 'models/gemini-x is not found for API version v1beta, or is not supported for bidiGenerateContent.');
  await model.clock.advance(5_000);
  await nextSocket(model, 1);
  assert.equal(keyOf(model.urls[1]), POOL[0], 'a model the provider does not serve is not the key\'s fault');
});

test('§20 a structured refusal (an error message with API_KEY_INVALID) also moves to the next key; a person\'s own key never does', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  const first = await nextSocket(rig, 0);
  first.open();
  first.json({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } });
  const second = await nextSocket(rig, 1);
  assert.equal(keyOf(rig.urls[1]), POOL[1]);
  second.open();
  second.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'running on the second key');

  const own = createRig();
  const mine = newMic(own).lane;
  t.after(() => mine.dispose());
  const key = fakeKey('own-key');
  await mine.start(await own.laneParams('mic', { key, model: DEFAULT_LIVE_MODEL }));
  const socket = await nextSocket(own, 0);
  socket.open();
  socket.json({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } });
  await until(() => mine.phase() === 'error', 'the person\'s key fails as before');
  assert.equal(stateOf(mine, 'mic').errorCode, 'INVALID_KEY');
  assert.deepEqual(own.urls.map(keyOf), [key], 'no other key was tried');
});

test('§20 a quota close on a built-in key swaps to the next key inside the run (calm "key" reconnect), and the next start remembers the cooldown', async (t) => {
  const rig = createRig();
  const memory = createKeyCooldownMemory();
  const { lane } = newMic(rig, { cooldowns: memory });
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  const first = await nextSocket(rig, 0);
  first.open();
  first.json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'running on the first key');
  first.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } });
  await until(() => rig.sockets.sockets.length === 2, 'the spare key');
  assert.equal(keyOf(rig.urls[1]), POOL[1]);
  assert.deepEqual([stateOf(lane, 'mic').phase, stateOf(lane, 'mic').reconnectReason], ['reconnecting', 'key']);
  rig.sockets.sockets[1].open();
  rig.sockets.sockets[1].json({ setupComplete: {} });
  await until(() => lane.phase() === 'running', 'running on the spare key');
  await lane.stop();
  assert.equal(lane.phase(), 'off');
  // The next start of this document (either lane) does not open a session on the key that just hit its quota.
  const again = newMic(rig, { cooldowns: memory }).lane;
  t.after(() => again.dispose());
  await again.start(await poolParams(rig, 'mic', { epoch: 2 }));
  await nextSocket(rig, 2);
  assert.equal(keyOf(rig.urls[2]), POOL[1], 'the cooling key is skipped');
  // Without the shared memory the same start would begin on the first key again.
  const fresh = createRig();
  const plain = newMic(fresh).lane;
  t.after(() => plain.dispose());
  await plain.start(await poolParams(fresh, 'mic'));
  await nextSocket(fresh, 0);
  assert.equal(keyOf(fresh.urls[0]), POOL[0]);
});

test('§20 a Stop during a key switch ends the lane off, with nothing reopened afterwards', async (t) => {
  const rig = createRig();
  const { lane } = newMic(rig);
  t.after(() => lane.dispose());
  await lane.start(await poolParams(rig, 'mic'));
  const first = await nextSocket(rig, 0);
  first.open();
  first.finishClose(1007, REFUSED);
  await tick();
  await lane.stop();
  await rig.clock.advance(10_000);
  for (let round = 0; round < 20; round += 1) await tick();
  assert.equal(lane.phase(), 'off');
  assert.ok(rig.sockets.sockets.length <= 2, 'at most the switch that was already under way');
  for (const socket of rig.sockets.sockets) assert.notEqual(socket.readyState, 1, 'no socket is left open');
});
