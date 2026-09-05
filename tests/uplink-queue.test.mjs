import test from 'node:test';
import assert from 'node:assert/strict';
import { createUplinkQueue } from '../app/audio/uplink-queue.js';
import { ProviderError } from '../app/providers/contract.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(send) {
  let time = 0, id = 0;
  const timers = new Map(), calls = [], drops = [], errors = [];
  const clock = { now: () => time,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout: id => timers.delete(id) };
  const abort = new AbortController();
  const q = createUplinkQueue({ clock, signal: abort.signal,
    sendAudio(pcm) { calls.push({ time, value: pcm[0] }); return send?.(pcm); },
    onDrop: value => drops.push(value), onError: value => errors.push(value) });
  return { q, calls, drops, errors, timers, abort,
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) {
        timers.delete(id); timer.fn();
      }
      await tick();
    },
  };
}
const frame = n => new Uint8Array(1024).fill(n);

test('before setup and during reconnection input is discarded; ready never replays it', async () => {
  const f = fixture();
  assert.equal(f.q.enqueue(frame(1)), false); assert.equal(f.timers.size, 0);
  f.q.setReady(true); await f.advance(100); assert.equal(f.calls.length, 0);
  f.q.enqueue(frame(2)); f.q.setReady(false);
  f.q.enqueue(frame(3)); f.q.setReady(true); await f.advance(100);
  assert.equal(f.calls.length, 0); assert.equal(f.q.getStats().droppedMs, 96);
  f.q.enqueue(frame(4)); await f.advance(0); assert.equal(f.calls[0].value, 4);
  f.q.cancel();
});

test('eight-frame bound includes pending send, oldest waiting frame is dropped and PCM is copied', async () => {
  const pending = deferred(), f = fixture(() => pending.promise); f.q.setReady(true);
  const original = frame(1); f.q.enqueue(original); original.fill(99);
  await f.advance(0); assert.equal(f.calls[0].value, 1);
  for (let i = 2; i <= 10; i++) f.q.enqueue(frame(i));
  const stats = f.q.getStats();
  assert.equal(stats.inFlight, 1); assert.equal(stats.queuedFrames, 7);
  assert.equal(stats.maxFrames, 8); assert.equal(stats.droppedFrames, 2);
  assert.ok(f.drops.every(v => v.reason === 'overflow'));
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  pending.resolve(); await tick(); await f.advance(32);
  assert.equal(f.calls[1].value, 4);
  f.q.cancel();
});

test('single pump spaces sends by actual time and never catches up after timer delay', async () => {
  const f = fixture(); f.q.setReady(true);
  for (let i = 1; i <= 8; i++) f.q.enqueue(frame(i));
  assert.equal(f.timers.size, 1);
  await f.advance(100); assert.equal(f.calls.length, 1);
  await f.advance(0); assert.equal(f.calls.length, 1);
  await f.advance(31); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  await f.advance(80); assert.equal(f.calls.length, 3);
  await f.advance(0); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(c => c.time), [100, 132, 212]);
  f.q.cancel();
});

test('stale frames expire at 256ms and a delayed send does not create parallel promises', async () => {
  const pending = deferred(), f = fixture(() => pending.promise); f.q.setReady(true);
  f.q.enqueue(frame(1)); await f.advance(0);
  for (let i = 0; i < 1000; i++) f.q.enqueue(frame(2));
  await f.advance(1000); assert.equal(f.calls.length, 1);
  assert.equal(f.q.getStats().maxFrames, 8);
  pending.resolve(); await tick(); await f.advance(0);
  assert.equal(f.calls.length, 1); assert.equal(f.q.getStats().queuedFrames, 0);
  assert.equal(f.q.getStats().droppedFrames, 1000);
  assert.equal(f.drops.at(-1).reason, 'stale'); f.q.cancel();
  const g = fixture(); g.q.setReady(true); g.q.enqueue(frame(1));
  await g.advance(256); assert.equal(g.calls.length, 0);
  assert.equal(g.q.getStats().droppedMs, 32); g.q.cancel();
});

for (const rejects of [false, true]) test(`abort discards queue and ignores late send ${rejects ? 'rejection' : 'resolution'}`, async () => {
  const pending = deferred(), f = fixture(() => pending.promise); f.q.setReady(true);
  f.q.enqueue(frame(1)); await f.advance(0); f.q.enqueue(frame(2));
  f.abort.abort('secret'); f.q.cancel(); f.q.setReady(true);
  assert.equal(f.q.enqueue(frame(3)), false);
  if (rejects) pending.reject(Error('secret')); else pending.resolve();
  await tick(); await f.advance(1000);
  assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 0);
  assert.equal(f.q.getStats().queuedFrames, 0); assert.equal(f.timers.size, 0);
});

for (const sync of [false, true]) test(`send ${sync ? 'throw' : 'rejection'} stops pump and reports only normalized error`, async () => {
  const error = Object.assign(new ProviderError('UNAVAILABLE'), { cause: Error('secret'), detail: 'secret' });
  const f = fixture(() => { if (sync) throw error; return Promise.reject(error); });
  f.q.setReady(true); f.q.enqueue(frame(1)); f.q.enqueue(frame(2)); await f.advance(0);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].code, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(f.errors).includes('secret'));
  await f.advance(100); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
});

test('invalid frames and pre-abort never reach sender; observer exceptions cannot break cancellation', () => {
  assert.throws(() => createUplinkQueue(), /INVALID_REQUEST/);
  const f = fixture();
  for (const pcm of [new Uint8Array(0), new Uint8Array(1023), new Uint8Array(1026), new Int16Array(512)]) {
    assert.throws(() => f.q.enqueue(pcm), /INVALID_REQUEST/);
  }
  f.q.cancel();
  const abort = new AbortController(); abort.abort();
  const q = createUplinkQueue({ signal: abort.signal, sendAudio() { assert.fail(); } });
  q.setReady(true); assert.equal(q.enqueue(frame(1)), false);
  const g = createUplinkQueue({ sendAudio() {}, onDrop() { throw Error('secret'); } });
  assert.equal(g.enqueue(frame(1)), false); g.cancel();
});
