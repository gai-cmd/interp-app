import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TIMER_MODE, createEngineClock, createWorkerTimers } from '../extension/engine/worker-timers.js';
import { createFakeClock } from './fixtures/fake-chrome.mjs';

// docs/extension.md §5.13 / §11.1 (group B): the worker-timer seam. No real Worker is ever spawned: a fake
// Worker class records its messages and lets the test play the worker's side.

const WORKER_SOURCE = readFileSync(new URL('../extension/engine/timer-worker.js', import.meta.url), 'utf8');
const WORKER_TIMERS_SOURCE = readFileSync(new URL('../extension/engine/worker-timers.js', import.meta.url), 'utf8');

class FakeWorker extends EventTarget {
  static instances = [];
  static failConstructor = false;
  constructor(url, options) {
    super();
    if (FakeWorker.failConstructor) throw new Error('no workers here');
    this.url = url; this.options = options; this.posted = []; this.terminated = false; this.failPost = false;
    FakeWorker.instances.push(this);
  }
  postMessage(message) {
    if (this.failPost) throw new Error('worker is gone');
    this.posted.push(message);
  }
  terminate() { this.terminated = true; }
  /** The worker's side: a message event. */
  say(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
  fail() { this.dispatchEvent(new Event('error')); }
}
const fresh = () => {
  FakeWorker.instances = [];
  FakeWorker.failConstructor = false;
  const realm = createFakeClock();
  const timers = createWorkerTimers({ Worker: FakeWorker, url: 'worker-url', realm });
  return { realm, timers, worker: FakeWorker.instances[0] };
};

test('TIMER_MODE is realm in v1, and realm mode makes the engine clock the realm\'s own object', () => {
  assert.equal(TIMER_MODE, 'realm');
  const realm = createFakeClock();
  assert.equal(createEngineClock({ mode: TIMER_MODE, realm, Worker: FakeWorker }), realm);
  assert.equal(FakeWorker.instances.length, 0, 'no worker is created in realm mode');
  FakeWorker.instances = [];
  const clock = createEngineClock({ mode: 'worker', realm, Worker: FakeWorker });
  assert.notEqual(clock, realm);
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(typeof clock.setTimeout, 'function');
});

test('the worker is created as a module worker from the timer-worker.js script (the literal the build closure follows)', () => {
  FakeWorker.instances = [];
  createWorkerTimers({ Worker: FakeWorker, realm: createFakeClock() });
  const [worker] = FakeWorker.instances;
  assert.deepEqual(worker.options, { type: 'module' });
  assert.ok(String(worker.url).endsWith('/extension/engine/timer-worker.js'), String(worker.url));
  assert.match(WORKER_TIMERS_SOURCE, /new URL\('\.\/timer-worker\.js', import\.meta\.url\)/);
});

test('setTimeout posts {t:"set"} and runs the callback on the worker\'s fire message, once', () => {
  const { realm, timers, worker } = fresh();
  const calls = [];
  const id = timers.setTimeout(() => calls.push('a'), 250);
  assert.deepEqual(worker.posted, [{ t: 'set', id, ms: 250 }]);
  assert.equal(realm.pending(), 0, 'the realm clock is not used while the worker is healthy');
  assert.deepEqual(calls, []);
  worker.say({ t: 'fire', id });
  assert.deepEqual(calls, ['a']);
  worker.say({ t: 'fire', id });
  assert.deepEqual(calls, ['a'], 'a fire message is a one-shot');
});

test('ids are distinct and delays are normalised (negative, NaN, strings)', () => {
  const { timers, worker } = fresh();
  const ids = [timers.setTimeout(() => {}, -5), timers.setTimeout(() => {}, Number.NaN), timers.setTimeout(() => {}, '30')];
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(worker.posted.map((message) => message.ms), [0, 0, 30]);
});

test('clearTimeout posts {t:"clear"} and forgets the callback', () => {
  const { timers, worker } = fresh();
  let ran = 0;
  const id = timers.setTimeout(() => { ran += 1; }, 100);
  timers.clearTimeout(id);
  assert.deepEqual(worker.posted.at(-1), { t: 'clear', id });
  worker.say({ t: 'fire', id });
  assert.equal(ran, 0);
  const before = worker.posted.length;
  timers.clearTimeout(id);
  timers.clearTimeout(9999);
  assert.equal(worker.posted.length, before, 'clearing an unknown or already cleared id posts nothing');
});

test('junk messages from the worker are ignored', () => {
  const { timers, worker } = fresh();
  let ran = 0;
  const id = timers.setTimeout(() => { ran += 1; }, 10);
  for (const junk of [null, 'fire', 42, {}, { t: 'fire' }, { t: 'fire', id: 'x' }, { t: 'other', id }]) worker.say(junk);
  assert.equal(ran, 0);
  worker.say({ t: 'fire', id });
  assert.equal(ran, 1);
});

test('now is the realm\'s', () => {
  const { realm, timers } = fresh();
  assert.equal(timers.now(), realm.now());
});

test('an error event falls back to the realm timers and re-arms the pending ones there', async () => {
  const { realm, timers, worker } = fresh();
  const calls = [];
  const first = timers.setTimeout(() => calls.push('first'), 300);
  const cleared = timers.setTimeout(() => calls.push('cleared'), 300);
  await realm.advance(100);
  worker.fail();
  assert.equal(worker.terminated, true);
  assert.equal(realm.pending(), 2, 'both pending timers were re-armed on the realm');
  timers.clearTimeout(cleared);
  assert.equal(realm.pending(), 1, 'an id handed out before the fallback still cancels');
  await realm.advance(199);
  assert.deepEqual(calls, [], 'the remaining time (300 - 100) is honoured, not restarted');
  await realm.advance(1);
  assert.deepEqual(calls, ['first']);

  // Every later call goes to the realm, and the dead worker is not asked again.
  const posted = worker.posted.length;
  timers.setTimeout(() => calls.push('later'), 50);
  await realm.advance(50);
  assert.deepEqual(calls, ['first', 'later']);
  assert.equal(worker.posted.length, posted);
  worker.say({ t: 'fire', id: first });
  assert.deepEqual(calls, ['first', 'later'], 'a message from the dead worker cannot fire twice');
});

test('a constructor failure or a missing Worker uses the realm from the start', async () => {
  for (const options of [{ failConstructor: true }, { missing: true }]) {
    FakeWorker.instances = [];
    FakeWorker.failConstructor = options.failConstructor === true;
    const realm = createFakeClock();
    const timers = createWorkerTimers({ Worker: options.missing ? undefined : FakeWorker, realm });
    let ran = 0;
    timers.setTimeout(() => { ran += 1; }, 20);
    assert.equal(realm.pending(), 1);
    await realm.advance(20);
    assert.equal(ran, 1);
    assert.equal(FakeWorker.instances.length, 0);
  }
  FakeWorker.failConstructor = false;
});

test('a failing postMessage falls back without losing or doubling the timer', async () => {
  const { realm, timers, worker } = fresh();
  const calls = [];
  timers.setTimeout(() => calls.push('one'), 40);
  worker.failPost = true;
  timers.setTimeout(() => calls.push('two'), 60);
  assert.equal(worker.terminated, true);
  await realm.advance(60);
  assert.deepEqual(calls, ['one', 'two']);
});

test('dispose terminates the worker, drops pending timers and later timers never fire', async () => {
  const { realm, timers, worker } = fresh();
  const calls = [];
  const id = timers.setTimeout(() => calls.push('pending'), 10);
  timers.dispose();
  assert.equal(worker.terminated, true);
  worker.say({ t: 'fire', id });
  timers.setTimeout(() => calls.push('after'), 10);
  await realm.advance(1000);
  assert.deepEqual(calls, []);
  timers.dispose();
});

test('timer-worker.js (run in a sandbox with a fake clock): set fires after the delay, clear cancels, re-setting an id replaces it', async () => {
  const clock = createFakeClock();
  // Objects made inside the sandbox have another realm's prototypes: keep plain JSON copies for deepStrictEqual.
  const posted = [];
  const sandbox = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))) };
  vm.runInNewContext(WORKER_SOURCE, sandbox);
  assert.equal(typeof sandbox.onmessage, 'function', 'the script installs its onmessage handler');

  sandbox.onmessage({ data: { t: 'set', id: 3, ms: 50 } });
  await clock.advance(49);
  assert.deepEqual(posted, []);
  await clock.advance(1);
  assert.deepEqual(posted, [{ t: 'fire', id: 3 }]);
  await clock.advance(500);
  assert.equal(posted.length, 1, 'a timer fires once');

  sandbox.onmessage({ data: { t: 'set', id: 4, ms: 10 } });
  sandbox.onmessage({ data: { t: 'clear', id: 4 } });
  await clock.advance(100);
  assert.equal(posted.length, 1, 'a cleared timer never fires');

  sandbox.onmessage({ data: { t: 'set', id: 5, ms: 10 } });
  sandbox.onmessage({ data: { t: 'set', id: 5, ms: 100 } });
  await clock.advance(10);
  assert.equal(posted.length, 1, 'the earlier timer of the same id was replaced');
  await clock.advance(90);
  assert.deepEqual(posted.at(-1), { t: 'fire', id: 5 });

  for (const junk of [null, undefined, 'set', { t: 'set' }, { t: 'set', id: 'x', ms: 1 }, { t: 'boom', id: 1 }, { id: 1 }]) {
    sandbox.onmessage({ data: junk });
  }
  sandbox.onmessage({ data: { t: 'set', id: 6, ms: -20 } });
  await clock.advance(0);
  assert.deepEqual(posted.at(-1), { t: 'fire', id: 6 }, 'a negative delay is a zero delay');
  assert.equal(clock.pending(), 0);
});

test('timer-worker.js is plain script syntax (no import/export) so it runs as a module worker and under vm', () => {
  assert.doesNotMatch(WORKER_SOURCE.replace(/^\s*\/\/.*$/gm, ''), /\b(import|export)\b/);
});
