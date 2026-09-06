import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCapture, createAudioPreferences, audioPreferences, microphoneConstraints, normalizeSettings,
  AUDIO_SENSITIVITIES, AUDIO_PREFERENCE_DEFAULTS, APPLIED_SETTING_NAMES } from '../app/audio/capture.js';
import { createPlatform } from '../app/platform.js';
import { validateWav } from '../app/audio/wav.js';
import { tone } from './fixtures/audio.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ rate = 48000, media, module, resume, failure, settings, supported } = {}) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false,
    stops: 0, stop() { this.stops++; this.readyState = 'ended'; },
    ...(settings === undefined ? {} : { getSettings: () => settings }) });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { connect() { if (failure === 'connect') throw Error('secret'); }, disconnect() {} };
  const posted = [];
  const node = { connect() {}, disconnect() {}, port: { close() {}, postMessage: message => posted.push(message) } };
  const constraints = [];
  const context = Object.assign(new EventTarget(), {
    state: 'running', sampleRate: rate, destination: {}, closed: 0,
    resume: () => resume?.promise ?? Promise.resolve(),
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); },
    audioWorklet: { addModule: () => module?.promise ?? Promise.resolve() },
    createMediaStreamSource: () => source,
  });
  const timers = new Map();
  let id = 0, calls = 0;
  const platform = {
    isSecureContext: true, isUserActive: () => true,
    document: Object.assign(new EventTarget(), { hidden: false }), page: new EventTarget(),
    createAudioContext: () => context, createWorkletNode: () => node,
    getUserMedia: c => { calls++; constraints.push(c); return media?.promise ?? Promise.resolve(stream); },
    ...(supported === undefined ? {} : { getSupportedConstraints: () => supported }),
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: key => timers.delete(key),
  };
  return { platform, context, node, track, stream, timers, calls: () => calls, constraints, posted,
    frame: samples => node.port.onmessage?.({ data: samples }),
    fire(ms) { for (const [key, value] of [...timers]) if (value.ms === ms) {
      timers.delete(key); value.fn();
    } },
  };
}

test('imports and platform construction never acquire microphone', () => {
  const p = createPlatform({ isSecureContext: true });
  assert.equal(p.isSecureContext, true);
  assert.equal(p.isUserActive(), true);
});
for (const rate of [44100, 48000]) test(`actual ${rate} Hz input becomes mono 16 kHz WAV`, async () => {
  const f = fixture({ rate }); const levels = [];
  const capture = createCapture({ platform: f.platform, onLevel: level => levels.push(level) });
  const session = capture.start({ turnId: 'turn', generation: 2 });
  await tick();
  f.frame(new Float32Array(rate / 10).fill(0.1));
  const result = await session.stop();
  assert.equal(result.status, 'success');
  assert.equal(result.inputSampleRate, rate);
  assert.equal(result.pcm.length, 3200);
  assert.equal(result.durationMs, 100);
  validateWav(result.wav, { sampleRate: 16000 });
  assert.ok(levels[0].rms > 0.09);
  assert.equal(levels[0].turnId, 'turn');
  assert.equal(f.track.stops, 1);
  assert.equal(f.context.closed, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(await session.stop(), result);
});

test('permission errors are safe and distinct from silence and missing input', async () => {
  const media = deferred(); const f = fixture({ media });
  const s = createCapture({ platform: f.platform }).start();
  media.reject(Object.assign(Error('secret-key'), { name: 'NotAllowedError' }));
  const result = await s.done;
  assert.equal(result.code, 'MICROPHONE_DENIED');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(f.context.closed, 1);
  for (const send of [true, false]) {
    const f = fixture(); const s = createCapture({ platform: f.platform }).start();
    await tick();
    if (send) f.frame(new Float32Array(128));
    const result = await s.stop();
    assert.equal(result.status, send ? 'silence' : 'error');
    assert.equal(result.wav, undefined);
    assert.equal(f.track.stops, 1);
  }
});

test('late permission streams are stopped without affecting a restarted session', async () => {
  const media = deferred(); const old = fixture({ media }); const fresh = fixture();
  const platform = { ...old.platform };
  const capture = createCapture({ platform });
  const first = capture.start();
  assert.equal((await first.cancel()).status, 'cancelled');
  Object.assign(platform, fresh.platform);
  const second = capture.start(); await tick();
  media.resolve(old.stream); await tick();
  assert.equal(old.track.stops, 1);
  assert.equal(fresh.track.stops, 0);
  fresh.frame(new Float32Array(128).fill(0.1));
  assert.equal((await second.stop()).status, 'success');
  assert.equal(fresh.track.stops, 1);
});

for (const phase of ['module', 'resume']) test(`cancel during ${phase} cleans up and ignores late resolution`, async () => {
  const pending = deferred(); const f = fixture({ [phase]: pending });
  const s = createCapture({ platform: f.platform }).start();
  await tick(); s.cancel(); pending.resolve(); await tick();
  assert.equal((await s.done).status, 'cancelled');
  assert.equal(f.track.stops, 1);
  assert.equal(f.node.port.onmessage, undefined);
});

for (const cause of ['ended', 'mute', 'hidden', 'pagehide', 'suspended', 'processor', 'connect', 'nan']) {
  test(`${cause} terminates tracks, graph and timers`, async () => {
    const f = fixture({ failure: cause });
    const s = createCapture({ platform: f.platform }).start(); await tick();
    if (cause === 'ended' || cause === 'mute') f.track.dispatchEvent(new Event(cause));
    if (cause === 'hidden') { f.platform.document.hidden = true; f.platform.document.dispatchEvent(new Event('visibilitychange')); }
    if (cause === 'pagehide') f.platform.page.dispatchEvent(new Event('pagehide'));
    if (cause === 'suspended') { f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange')); }
    if (cause === 'processor') f.node.onprocessorerror();
    if (cause === 'nan') f.frame(new Float32Array([NaN]));
    assert.ok(['error', 'interrupted'].includes((await s.done).status));
    assert.equal(f.track.stops, 1); assert.equal(f.timers.size, 0);
  });
}

test('missing and stalled PCM trigger watchdog; abort is separate', async () => {
  for (const frames of [false, true]) {
    const f = fixture(); const s = createCapture({ platform: f.platform }).start(); await tick();
    if (frames) f.frame(new Float32Array(128).fill(0.2));
    f.fire(2000);
    assert.equal((await s.done).status, frames ? 'interrupted' : 'error');
    assert.equal(f.track.stops, 1);
  }
  const f = fixture(); const abort = new AbortController(); abort.abort('secret');
  const s = createCapture({ platform: f.platform }).start({ signal: abort.signal });
  assert.equal((await s.done).code, 'ABORTED'); assert.equal(f.calls(), 0);
});

test('30-second wall clock and sample caps, warning, and late events', async () => {
  for (const bySamples of [true, false]) {
    const f = fixture({ rate: 16000 }); const warnings = [];
    const s = createCapture({ platform: f.platform, onWarning: v => warnings.push(v) }).start();
    await tick();
    const late = f.node.port.onmessage;
    f.fire(25000); assert.equal(warnings[0].messageKey, 'seq.recordingEnding');
    f.frame(new Float32Array(bySamples ? 16000 * 31 : 128).fill(0.2));
    if (!bySamples) f.fire(30000);
    const result = await s.done;
    assert.equal(result.reason, 'limit'); assert.ok(result.durationMs <= 30000);
    if (bySamples) assert.equal(result.pcm.length, 960000);
    late({ data: new Float32Array([1]) });
    assert.equal(f.track.stops, 1); assert.equal(f.timers.size, 0);
  }
});

test('setup timeout releases late stream and callback failure cannot leak', async () => {
  const media = deferred(); const f = fixture({ media });
  const s = createCapture({ platform: f.platform }).start(); f.fire(30000);
  assert.equal((await s.done).code, 'TIMEOUT'); media.resolve(f.stream); await tick();
  assert.equal(f.track.stops, 1);
  const g = fixture(); const c = createCapture({ platform: g.platform, onLevel() { throw Error('secret'); } });
  const t = c.start(); await tick(); g.frame(new Float32Array(128).fill(0.1));
  assert.equal((await t.stop()).status, 'success'); assert.equal(g.track.stops, 1);
});

async function worklet({ sampleRate = 48000 } = {}) {
  let Processor; const messages = [];
  const sandbox = { AudioWorkletProcessor: class { port = { postMessage: (data, transfer) => messages.push({ data, transfer }) }; },
    registerProcessor(name, value) { assert.equal(name, 'interp-capture'); Processor = value; }, sampleRate };
  vm.runInNewContext(await readFile(new URL('../app/audio/capture-worklet.js', import.meta.url), 'utf8'), sandbox);
  const processor = new Processor();
  const frames = () => messages.filter(m => m.data instanceof Float32Array);
  const gates = () => messages.filter(m => m.data?.type === 'gate');
  const rms = data => Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
  return { processor, messages, frames, gates, rms, configure: config => processor.port.onmessage({ data: { type: 'configure', ...config } }) };
}
// 128-sample blocks as the audio thread delivers them.
const blocks = (samples, size = 128) => Array.from({ length: Math.ceil(samples.length / size) }, (_, i) => samples.subarray(i * size, (i + 1) * size));

test('worklet copies PCM and never writes audible output', async () => {
  const w = await worklet(); const samples = new Float32Array([0.2, 0.4]);
  assert.equal(w.processor.process([[samples]]), true); samples[0] = 1;
  // P3-02d: the gate state precedes the first PCM block; the block is a filtered copy of the input.
  assert.deepEqual({ ...w.messages[0].data }, { type: 'gate', open: true, rms: w.messages[0].data.rms });
  const frame = w.frames()[0];
  assert.ok(frame.data[0] < 0.3 && frame.data[0] > 0.1);
  assert.equal(frame.transfer[0], frame.data.buffer);
  w.processor.process([]); assert.equal(w.messages.length, 2);
});

test('worklet voice-band filter removes DC and high tones, keeps speech tones, and keeps state across blocks', async () => {
  const w = await worklet();
  // DC (below 80 Hz) decays towards zero and the decay continues across block boundaries: no per-block reset.
  for (const block of blocks(new Float32Array(48000).fill(0.5))) w.processor.process([[block]]);
  const frames = w.frames();
  assert.ok(Math.abs(frames.at(-1).data.at(-1)) < 1e-3, 'DC is removed');
  assert.ok(Math.abs(frames[1].data[0]) < Math.abs(frames[0].data.at(-1)) && Math.abs(frames[1].data[0]) < 0.45, 'block two continues block one');
  const level = async (hz) => { const v = await worklet(); for (const block of blocks(tone(48000, hz, 48000, 0.3))) v.processor.process([[block]]);
    return v.rms(v.frames().at(-1).data); };
  const speech = await level(300), high = await level(16000), low = await level(30);
  assert.ok(speech > 0.19 && speech < 0.22, `speech band passes (${speech})`);
  assert.ok(high < speech * 0.5, `16 kHz is attenuated (${high})`);
  assert.ok(low < speech * 0.5, `30 Hz is attenuated (${low})`);
  // Filter off: the copy is bit-exact.
  const raw = await worklet(); raw.configure({ filter: false });
  const input = tone(48000, 300, 256, 0.3); raw.processor.process([[input.subarray(0, 128)]]);
  assert.deepEqual([...raw.frames()[0].data], [...input.subarray(0, 128)]);
});

test('worklet energy gate replaces quiet blocks with silence, holds through pauses, and follows sensitivity', async () => {
  const w = await worklet();
  const quiet = tone(48000, 300, 128 * 4, 0.003), loud = tone(48000, 300, 128 * 4, 0.1);
  for (const block of blocks(quiet)) w.processor.process([[block]]);
  assert.ok(w.frames().every(m => m.data.every(v => v === 0)), 'quiet input becomes digital silence');
  assert.deepEqual(w.gates().map(g => g.data.open), [false]);
  for (const block of blocks(loud)) w.processor.process([[block]]);
  assert.deepEqual(w.gates().map(g => g.data.open), [false, true]);
  assert.ok(w.frames().at(-1).data.some(v => v !== 0));
  // 400 ms hold: quiet blocks right after speech still pass, then the gate closes and reports once.
  let closed = null;
  for (let i = 0; i < 400; i++) { w.processor.process([[quiet.subarray(0, 128)]]); if (closed === null && w.frames().at(-1).data.every(v => v === 0)) closed = i; }
  assert.ok(closed >= 140 && closed <= 160, `held ${closed} blocks`);
  assert.deepEqual(w.gates().map(g => g.data.open), [false, true, false]);
  // Sensitivity: 'high' hears the quiet speaker, 'low' ignores louder noise; unknown values are ignored.
  const high = await worklet(); high.configure({ sensitivity: 'high' });
  for (const block of blocks(quiet)) high.processor.process([[block]]);
  assert.ok(high.frames().at(-1).data.some(v => v !== 0));
  const low = await worklet(); low.configure({ sensitivity: 'low' });
  for (const block of blocks(tone(48000, 300, 128 * 4, 0.012))) low.processor.process([[block]]);
  assert.ok(low.frames().every(m => m.data.every(v => v === 0)));
  low.configure({ sensitivity: 'SECRET', filter: 'yes' });
  assert.deepEqual({ ...low.processor.config }, { filter: true, sensitivity: 'low' });
  low.processor.port.onmessage({ data: null }); low.processor.port.onmessage({ data: new Float32Array(2) });
  // Without a sampleRate global (test sandbox) the processor still constructs.
  const bare = await worklet({ sampleRate: undefined }); assert.equal(bare.processor.rate, 48000);
});

test('speech-only defaults: constraints, applied track settings, worklet configuration and gate state', async () => {
  assert.deepEqual(AUDIO_PREFERENCE_DEFAULTS, { noiseSuppression: true, voiceFilter: true, sensitivity: 'normal' });
  assert.deepEqual(AUDIO_SENSITIVITIES, ['low', 'normal', 'high']);
  assert.deepEqual(microphoneConstraints(), { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
    autoGainControl: true, voiceIsolation: { ideal: true } }, video: false });
  assert.equal(microphoneConstraints({ noiseSuppression: false }).audio.noiseSuppression, false);
  assert.equal(microphoneConstraints({}, { voiceIsolation: false }).audio.voiceIsolation, undefined, 'feature-detected off');
  assert.equal(microphoneConstraints({}, { echoCancellation: true }).audio.voiceIsolation, undefined, 'unlisted means unsupported');
  assert.deepEqual(microphoneConstraints({}, { voiceIsolation: true }).audio.voiceIsolation, { ideal: true });
  assert.deepEqual(normalizeSettings({ echoCancellation: true, noiseSuppression: 'yes', voiceIsolation: false, deviceId: 'SECRET' }),
    { echoCancellation: true, noiseSuppression: null, autoGainControl: null, voiceIsolation: false });
  assert.deepEqual(APPLIED_SETTING_NAMES, ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation']);
  // Default preferences (shared singleton): every constraint on, applied settings recorded, worklet configured.
  const applied = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false, deviceId: 'SECRET-DEVICE' };
  const prefs = createAudioPreferences(); const seen = []; prefs.subscribe(s => seen.push(s));
  const f = fixture({ settings: applied, supported: { voiceIsolation: true } }); const levels = [];
  const capture = createCapture({ platform: f.platform, preferences: prefs, onLevel: level => levels.push(level) });
  const s = capture.start(); await tick();
  assert.deepEqual(f.constraints[0].audio, { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: { ideal: true } });
  assert.deepEqual(f.posted, [{ type: 'configure', filter: true, sensitivity: 'normal' }]);
  const expected = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false };
  assert.deepEqual(prefs.snapshot().applied, expected);
  f.frame(new Float32Array(128).fill(0.1));
  assert.equal(levels[0].gate, 'open'); assert.deepEqual(levels[0].settings, expected);
  f.node.port.onmessage({ data: { type: 'gate', open: false, rms: 0.001 } });
  f.frame(new Float32Array(128));
  assert.equal(levels[1].gate, 'closed');
  const result = await s.stop();
  assert.equal(result.status, 'success'); assert.deepEqual(result.settings, expected);
  assert.ok(!JSON.stringify([result, levels, prefs.snapshot()]).includes('SECRET'));
  // Changed preferences apply to the next start; unsupported voiceIsolation is not requested; no getSettings means null.
  prefs.set({ noiseSuppression: false, voiceFilter: false, sensitivity: 'low' });
  const g = fixture({ supported: { voiceIsolation: false } });
  const t = createCapture({ platform: g.platform, preferences: prefs }).start(); await tick();
  assert.deepEqual(g.constraints[0].audio, { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true });
  assert.deepEqual(g.posted, [{ type: 'configure', filter: false, sensitivity: 'low' }]);
  assert.equal(prefs.snapshot().applied, null);
  g.frame(new Float32Array(128).fill(0.1)); assert.equal((await t.stop()).settings, null);
  // Store contract: validation, no-op sets, subscription.
  assert.throws(() => prefs.set({ sensitivity: 'max' }), /INVALID_REQUEST/);
  assert.throws(() => prefs.set({ noiseSuppression: 'no' }), /INVALID_REQUEST/);
  assert.throws(() => prefs.subscribe(1), /INVALID_REQUEST/);
  const before = seen.length; prefs.set({ sensitivity: 'low' }); assert.equal(seen.length, before);
  assert.ok(Object.isFrozen(prefs.snapshot()));
  assert.deepEqual(audioPreferences.snapshot(), { ...AUDIO_PREFERENCE_DEFAULTS, applied: null }, 'the app-wide store is untouched');
  // A worklet port without postMessage (older doubles) is not a failure.
  const h = fixture(); delete h.node.port.postMessage;
  const u = createCapture({ platform: h.platform, preferences: prefs }).start(); await tick();
  h.frame(new Float32Array(128).fill(0.1)); assert.equal((await u.stop()).status, 'success');
});

for (const phase of ['module', 'resume']) test(`${phase} rejection stops acquired or late tracks`, async () => {
  const pending = deferred(); const f = fixture({ [phase]: pending });
  const s = createCapture({ platform: f.platform }).start(); await tick();
  pending.reject(Error('secret-native-error'));
  const result = await s.done; await tick();
  assert.equal(result.code, 'MICROPHONE_UNAVAILABLE');
  assert.equal(f.track.stops, 1); assert.equal(f.context.closed, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('active abort discards audio and gesture/security gates prevent acquisition', async () => {
  const f = fixture(); const controller = new AbortController();
  const capture = createCapture({ platform: f.platform });
  const s = capture.start({ signal: controller.signal }); await tick();
  assert.throws(() => capture.start(), /INVALID_REQUEST/);
  f.frame(new Float32Array(128).fill(0.1)); controller.abort('secret');
  const result = await s.done;
  assert.equal(result.status, 'cancelled'); assert.equal(result.pcm, undefined);
  assert.equal(f.track.stops, 1);
  for (const override of [{ isSecureContext: false }, { isUserActive: () => false }]) {
    const f = fixture(); Object.assign(f.platform, override);
    const s = createCapture({ platform: f.platform }).start();
    assert.equal((await s.done).code, 'MICROPHONE_UNAVAILABLE');
    assert.equal(f.calls(), 0);
  }
});
