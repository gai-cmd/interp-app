import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCapture } from '../app/audio/capture.js';
import { createPlatform } from '../app/platform.js';
import { validateWav } from '../app/audio/wav.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ rate = 48000, media, module, resume, failure } = {}) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false,
    stops: 0, stop() { this.stops++; this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { connect() { if (failure === 'connect') throw Error('secret'); }, disconnect() {} };
  const node = { connect() {}, disconnect() {}, port: { close() {} } };
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
    getUserMedia: () => { calls++; return media?.promise ?? Promise.resolve(stream); },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: key => timers.delete(key),
  };
  return { platform, context, node, track, stream, timers, calls: () => calls,
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

test('worklet copies PCM and never writes audible output', async () => {
  let Processor; const messages = [];
  const sandbox = { AudioWorkletProcessor: class { port = { postMessage: (data, transfer) => messages.push({ data, transfer }) }; },
    registerProcessor(name, value) { assert.equal(name, 'interp-capture'); Processor = value; } };
  vm.runInNewContext(await readFile(new URL('../app/audio/capture-worklet.js', import.meta.url), 'utf8'), sandbox);
  const p = new Processor(); const samples = new Float32Array([0.2, 0.4]);
  assert.equal(p.process([[samples]]), true); samples[0] = 1;
  assert.ok(messages[0].data[0] < 0.3);
  assert.equal(messages[0].transfer[0], messages[0].data.buffer);
  p.process([]); assert.equal(messages.length, 1);
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
