// Browsers throw "TypeError: Illegal invocation" when window.setTimeout / clearTimeout are called with a `this`
// that is not the window (for example as a method of a clock object). Node accepts such a call, which is why the
// whole suite stayed green while the extension ended every session with INVALID_RESULT at its first caption
// (2026-09-30, reproduced in Chrome for Testing). This file runs the engine under the browser's rule.
import test from 'node:test';
import assert from 'node:assert/strict';

const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
const strict = (native) => function strictTimer(...args) {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return native(...args);
};
globalThis.setTimeout = strict(nativeSet);
globalThis.clearTimeout = strict(nativeClear);

const { simFixture, tick, content } = await import('./fixtures/sim.mjs');
const { createUplinkQueue } = await import('../app/audio/uplink-queue.js');

test('the strict timers of this file really refuse a method call', () => {
  const clock = { setTimeout: globalThis.setTimeout };
  assert.throws(() => clock.setTimeout(() => {}, 0), /Illegal invocation/);
  assert.doesNotThrow(() => nativeClear(globalThis.setTimeout(() => {}, 0)));
});

// The sim fixture builds its config like the extension's lane engine: createAppConfig without injected timers.
for (const model of ['gemini-3.5-live-translate-preview', 'gemini-3.8-live']) {
  test(`a session survives its first captions when no timers are injected (${model})`, async (t) => {
    const f = simFixture(); t.after(() => f.close());
    const handle = await f.running({ model });
    const socket = f.sockets.at(-1);
    content(socket, { inputTranscription: { text: '안녕하세요' } });
    content(socket, { outputTranscription: { text: 'こんにちは' } });
    for (let i = 0; i < 6; i++) await tick();
    const ended = await Promise.race([handle.done, new Promise((resolve) => nativeSet(() => resolve(null), 100))]);
    assert.equal(ended, null, `the session ended: ${ended?.errorCode}`);
    const snapshot = f.engine.snapshot();
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.captions.captions.length, 2);
  });
}

test('the uplink queue\'s default clock can schedule and clear a timer', async () => {
  const errors = [];
  let sent = 0;
  // A full send buffer makes the queue wait one interval, which goes through clock.setTimeout.
  const queue = createUplinkQueue({ sendAudio: () => { sent++; return 7000; }, onError: (error) => errors.push(error.code) });
  queue.setReady(true);
  queue.enqueue(new Uint8Array(1024)); queue.enqueue(new Uint8Array(1024));
  await tick(); await tick();
  assert.equal(sent, 1);
  assert.deepEqual(errors, []);
  await new Promise((resolve) => nativeSet(resolve, 60));
  assert.equal(sent, 2, 'the second frame went out after the pause');
  assert.doesNotThrow(() => queue.cancel());
  assert.deepEqual(errors, []);
});
