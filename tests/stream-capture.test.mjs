import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamCapture } from '../app/audio/stream-capture.js';
import { tone, chunks, join } from './fixtures/audio.mjs';
import { pcm16ToFloat32 } from '../app/audio/wav.js';

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

for (const rate of [16000, 44100, 48000]) test(`actual ${rate} Hz: exact frames and preserved tone across irregular blocks`, async () => {
  const f = fixture({ rate }); const frames = [], levels = [];
  const capture = createStreamCapture({ platform: f.platform,
    onFrame: (pcm, meta) => frames.push({ pcm, meta }), onLevel: v => levels.push(v) });
  assert.equal(f.calls(), 0);
  const s = capture.start({ sessionId: 'session', generation: 3 }); await tick();
  for (const block of chunks(tone(rate, 1000))) f.frame(block);
  const result = await s.stop();
  assert.equal(result.inputSampleRate, rate);
  assert.equal(result.durationMs, 1000);
  assert.equal(frames.length, 31);
  assert.ok(frames.every((f, i) => f.pcm.byteLength === 1024 && f.meta.sequence === i + 1
    && f.meta.sampleRate === 16000 && f.meta.generation === 3));
  const pcm = pcm16ToFloat32(join(frames.map(f => f.pcm), Uint8Array));
  const reference = tone(16000, 1000, pcm.length);
  let error = 0;
  for (let i = 128; i < pcm.length; i++) error += (pcm[i] - reference[i]) ** 2;
  assert.ok(Math.sqrt(error / (pcm.length - 128)) < 0.002);
  assert.ok(levels.some(v => v.rms > 0.3 && v.peak > 0.45));
  assert.equal(result.emittedFrames, 31);
  assert.ok(result.discardedTailSamples < 512);
  assert.equal(result.wav, undefined); assert.equal(result.pcm, undefined);
  assert.equal(f.track.stops, 1); assert.equal(f.context.closed, 1);
  assert.equal(f.timers.size, 0);
});

test('silence streams beyond thirty seconds, with no WAV or final padded frame', async () => {
  const f = fixture({ rate: 16000 }); let count = 0;
  const s = createStreamCapture({ platform: f.platform, onFrame: pcm => {
    count++; assert.ok(pcm.every(v => v === 0));
  } }).start(); await tick();
  for (let i = 0; i < 1001; i++) f.frame(new Float32Array(512));
  f.frame(new Float32Array(7)); f.fire(30000);
  assert.equal(f.track.stops, 0);
  const result = await s.stop();
  assert.equal(count, 1001); assert.ok(result.durationMs > 30000);
  assert.equal(result.discardedTailSamples, 7);
  assert.equal(await s.stop(), result);
});

test('cancelled permission cannot leak tracks or stop a new capture', async () => {
  const media = deferred(), old = fixture({ media }), fresh = fixture();
  const platform = { ...old.platform };
  const c = createStreamCapture({ platform }); const first = c.start();
  await first.cancel(); Object.assign(platform, fresh.platform);
  const next = c.start(); await tick(); media.resolve(old.stream); await tick();
  assert.equal(old.track.stops, 1); assert.equal(fresh.track.stops, 0);
  await next.stop(); assert.equal(fresh.track.stops, 1);
});

for (const phase of ['module', 'resume']) test(`late ${phase} resolution and rejection after cancellation`, async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), f = fixture({ [phase]: pending });
    const s = createStreamCapture({ platform: f.platform }).start(); await tick();
    await s.cancel();
    if (reject) pending.reject(Error('secret')); else pending.resolve();
    await tick(); assert.equal(f.track.stops, 1); assert.equal(f.context.closed, 1);
    assert.equal(f.node.port.onmessage, undefined); assert.equal(f.timers.size, 0);
  }
});

for (const cause of ['ended', 'mute', 'hidden', 'pagehide', 'suspended', 'processor', 'connect', 'nan']) {
  test(`${cause} cleans graph and ignores late PCM`, async () => {
    const f = fixture({ failure: cause }); let count = 0;
    const s = createStreamCapture({ platform: f.platform, onFrame: () => count++ }).start(); await tick();
    const late = f.node.port.onmessage;
    if (cause === 'ended' || cause === 'mute') f.track.dispatchEvent(new Event(cause));
    if (cause === 'hidden') { f.platform.document.hidden = true; f.platform.document.dispatchEvent(new Event('visibilitychange')); }
    if (cause === 'pagehide') f.platform.page.dispatchEvent(new Event('pagehide'));
    if (cause === 'suspended') { f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange')); }
    if (cause === 'processor') f.node.onprocessorerror();
    if (cause === 'nan') f.frame(new Float32Array([NaN]));
    const result = await s.done;
    assert.ok(['error', 'interrupted'].includes(result.status));
    late?.({ data: new Float32Array(1024) }); assert.equal(count, 0);
    assert.equal(f.track.stops, 1); assert.equal(f.timers.size, 0);
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
}

test('missing input, stalled silence, setup timeout and permission errors are distinct', async () => {
  for (const input of [false, true]) {
    const f = fixture(), s = createStreamCapture({ platform: f.platform }).start(); await tick();
    if (input) f.frame(new Float32Array(128));
    f.fire(2000); assert.equal((await s.done).code, input ? 'BROWSER_INTERRUPTED' : 'MICROPHONE_UNAVAILABLE');
  }
  const media = deferred(), f = fixture({ media });
  const s = createStreamCapture({ platform: f.platform }).start(); f.fire(30000);
  assert.equal((await s.done).code, 'TIMEOUT'); media.resolve(f.stream); await tick();
  assert.equal(f.track.stops, 1);
  const denied = deferred(), g = fixture({ media: denied });
  const t = createStreamCapture({ platform: g.platform }).start();
  denied.reject(Object.assign(Error('secret'), { name: 'NotAllowedError' }));
  assert.equal((await t.done).code, 'MICROPHONE_DENIED');
});

test('abort gates, user activation, reentrant stop and callback failures', async () => {
  for (const override of [{ isSecureContext: false }, { isUserActive: () => false }]) {
    const f = fixture(); Object.assign(f.platform, override);
    const s = createStreamCapture({ platform: f.platform }).start();
    assert.equal((await s.done).code, 'MICROPHONE_UNAVAILABLE'); assert.equal(f.calls(), 0);
  }
  const f = fixture(), abort = new AbortController(); abort.abort('secret');
  const c = createStreamCapture({ platform: f.platform });
  assert.equal((await c.start({ signal: abort.signal }).done).code, 'ABORTED');
  assert.equal(f.calls(), 0);
  let count = 0, s;
  const g = fixture({ rate: 16000 });
  const capture = createStreamCapture({ platform: g.platform, onFrame: () => { count++; s.cancel(); } });
  s = capture.start(); assert.throws(() => capture.start(), /INVALID_REQUEST/); await tick();
  g.frame(new Float32Array(2048)); assert.equal(count, 1);
  assert.equal((await s.done).code, 'ABORTED');
  const h = fixture({ rate: 16000 });
  const t = createStreamCapture({ platform: h.platform, onFrame: () => { throw Error('secret'); } }).start();
  await tick(); h.frame(new Float32Array(512));
  assert.equal((await t.done).code, 'MICROPHONE_UNAVAILABLE'); assert.equal(h.track.stops, 1);
});
