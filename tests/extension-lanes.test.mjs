import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../app/engine/session-manager.js';
import { DEFAULT_LIVE_MODEL, TRANSLATE_LIVE_MODEL, liveVoicePreference } from '../app/providers/gemini/live-config.js';
import { createLaneEngine } from '../extension/engine/lane-engine.js';
import { createMicLane } from '../extension/engine/mic-lane.js';
import { TAB_CAPTURE_INCLUDE_VIDEO, createTabLane } from '../extension/engine/tab-lane.js';
import { LIMITS } from '../extension/lib/protocol.js';
import { createDefaultSettings, laneRequestOf } from '../extension/lib/settings.js';
import { laneStateFromSnapshot } from '../extension/lib/ui-state.js';
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

test('TWO LANES: the model defaults differ per lane and each reaches its engine', async (t) => {
  const defaults = createDefaultSettings('ko');
  assert.equal(laneRequestOf(defaults, 'tab').model, TRANSLATE_LIVE_MODEL);
  assert.equal(laneRequestOf(defaults, 'mic').model, DEFAULT_LIVE_MODEL);
  const rig = createRig();
  const { tab, mic } = await bothRunning(t, rig, {
    tabOptions: { params: { model: laneRequestOf(defaults, 'tab').model } },
    micOptions: { params: { model: laneRequestOf(defaults, 'mic').model } } });
  assert.equal(tab.snapshot().model, TRANSLATE_LIVE_MODEL);
  assert.equal(mic.snapshot().model, DEFAULT_LIVE_MODEL);
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
