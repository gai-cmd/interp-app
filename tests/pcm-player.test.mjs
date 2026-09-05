import test from 'node:test';
import assert from 'node:assert/strict';
import { createPCMPlayer } from '../app/audio/pcm-player.js';

function setup(options = {}) {
  const timers = new Map(); let id = 0;
  const made = [];
  const context = { currentTime: 10, destination: {}, resume: async () => {},
    createBuffer(channels, size, rate) {
      assert.equal(channels, 1); assert.equal(rate, 24000);
      const data = new Float32Array(size);
      return { data, getChannelData: () => data };
    },
    createBufferSource() {
      const source = { connect() {}, start(at) { this.at = at; },
        stop() { this.stopped = true; }, disconnect() { this.disconnected = true; } };
      made.push(source); return source;
    } };
  const player = createPCMPlayer({ context, now: () => 123,
    setTimeout: (fn) => { timers.set(++id, fn); return id; },
    clearTimeout: (key) => timers.delete(key), ...options });
  return { player, context, made, timers };
}
const pcm = (seconds) => new Uint8Array(seconds * 48000);

test('24kHz LE offset decoding and consecutive AudioContext scheduling', async () => {
  const { player, made, timers } = setup();
  assert.equal(await player.resume(), true);
  const bytes = new Uint8Array([9, 0, 128, 255, 127, 9]);
  player.enqueue(new DataView(bytes.buffer, 1, 4));
  player.enqueue(pcm(1));
  assert.deepEqual([...made[0].buffer.data], [-1, 32767 / 32768]);
  assert.equal(made[0].at, 10.06);
  assert.equal(made[1].at, 10.06 + 2 / 24000);
  assert.equal(player.snapshot().firstReceivedAt, 123);
  assert.equal(player.snapshot().actualFirstSoundAt, null);
  const done = player.finish();
  for (const source of made) { source.onended(); assert.equal(source.buffer, null); }
  assert.equal((await done).status, 'completed');
  assert.equal(player.snapshot().sourceCount, 0); assert.equal(timers.size, 0);
});

test('cancel stops and disconnects scheduled sources and ignores late work', async () => {
  const controller = new AbortController();
  const { player, made, timers } = setup({ signal: controller.signal });
  player.enqueue(pcm(1)); player.enqueue(pcm(1));
  const late = made[0].onended;
  controller.abort(new Error('SECRET'));
  late();
  assert.equal(player.enqueue(pcm(1)), false);
  assert.equal(await player.resume(), false);
  assert.equal((await player.done).status, 'cancelled');
  assert.ok(made.every((s) => s.stopped && s.disconnected && s.buffer === null));
  assert.equal(timers.size, 0);
});

test('duration and source-count bounds stop overflow and mark missing audio', async () => {
  const { player, made } = setup();
  player.enqueue(pcm(3)); assert.equal(player.snapshot().delayed, true);
  assert.equal(player.enqueue(pcm(6)), false);
  assert.equal((await player.done).gap, true); assert.equal(made[0].stopped, true);
  const other = setup({ maxSources: 2 });
  other.player.enqueue(new Uint8Array(2)); other.player.enqueue(new Uint8Array(2));
  other.player.enqueue(new Uint8Array(2));
  assert.equal((await other.player.done).status, 'overflow');
});

test('ended sources do not accumulate over a long turn', async () => {
  const { player, context, made } = setup({ maxSources: 1 });
  for (let i = 0; i < 500; i++) {
    assert.equal(player.enqueue(pcm(0.01)), true);
    const source = made.at(-1); context.currentTime = source.at + 0.01; source.onended();
    assert.equal(player.snapshot().sourceCount, 0);
  }
  assert.equal((await player.finish()).status, 'completed');
});

test('suspended clock does not imply completion; timeout cleans sources', async () => {
  const { player, made, timers } = setup();
  player.enqueue(pcm(1)); player.finish();
  assert.equal(player.snapshot().terminal, false);
  [...timers.values()][0]();
  assert.equal((await player.done).status, 'timeout'); assert.equal(made[0].stopped, true);
  assert.equal(timers.size, 0);
});

test('invalid PCM, start failure, and resume rejection produce sanitized failure', async () => {
  for (const scenario of ['invalid', 'start', 'resume']) {
    const { player, context, timers } = setup();
    if (scenario === 'invalid') player.enqueue(new Uint8Array(3));
    if (scenario === 'start') { context.createBufferSource = () => { throw Error('SECRET'); }; player.enqueue(pcm(1)); }
    if (scenario === 'resume') { context.resume = async () => { throw Error('SECRET'); }; await player.resume(); }
    const result = await player.done;
    assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.equal(timers.size, 0);
  }
});

test('abort while resume is pending prevents subsequent scheduling', async () => {
  const { player, context, made, timers } = setup();
  let resumed;
  context.resume = () => new Promise((resolve) => { resumed = resolve; });
  const pending = player.resume(); player.cancel(); resumed();
  assert.equal(await pending, false);
  assert.equal(player.enqueue(pcm(1)), false);
  assert.equal(made.length, 0); assert.equal(timers.size, 0);
});
