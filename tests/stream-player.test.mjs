import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamPlayer } from '../app/audio/stream-player.js';
import { pcm, streamAudio } from './fixtures/stream-audio.mjs';

function setup(options = {}) {
  const env = streamAudio(), states = [], drops = [];
  const player = createStreamPlayer({ ...env.options,
    onState: value => states.push(value), onDrop: value => drops.push(value), ...options });
  return { ...env, player, states, drops };
}
const clean = source => source.disconnected && source.buffer === null && source.onended === null;

test('offset PCM16 LE, mono 24kHz and contiguous audio-clock scheduling; onset stays unknown', () => {
  const { player, context, made, advance } = setup();
  advance(123, false); context.currentTime = 10;
  const bytes = Uint8Array.of(9, 0, 128, 255, 127, 9);
  assert.equal(player.enqueue(new DataView(bytes.buffer, 1, 4)), true);
  assert.equal(player.enqueue(pcm(1).buffer), true);
  assert.deepEqual([...made[0].buffer.data], [-1, 32767 / 32768]);
  assert.equal(made[0].buffer.channels, 1); assert.equal(made[0].buffer.rate, 24000);
  assert.equal(made[0].at, 10.06); assert.equal(made[1].at, 10.06 + 2 / 24000);
  bytes.fill(0);
  assert.equal(made[0].buffer.data[0], -1);
  assert.equal(player.snapshot().firstReceivedAt, 123);
  assert.equal(player.snapshot().firstScheduledAt, 10.06);
  advance(2000);
  assert.equal(player.snapshot().actualFirstSoundAt, null);
  assert.equal(player.snapshot().sourceCount, 0);
  player.cancel();
});

test('3-second delay notification clears as audio drains without new input', () => {
  const { player, states, advance } = setup();
  player.enqueue(pcm(3));
  assert.equal(player.snapshot().state, 'delayed');
  advance(100);
  assert.equal(states.at(-1).state, 'ready');
  player.cancel();
});

test('8-second bound rejects before allocating, stops old audio and waits for provider turn', () => {
  const { player, context, made, advance, drops, timers } = setup();
  assert.equal(player.enqueue(pcm(7.94)), true);
  assert.ok(player.snapshot().queuedSeconds <= 8);
  const allocations = context.allocations;
  assert.equal(player.enqueue(pcm(0.001)), false);
  assert.equal(context.allocations, allocations);
  assert.equal(player.snapshot().state, 'catching-up');
  assert.ok(made.every(s => clean(s) && s.stopped));
  assert.equal(player.snapshot().sourceCount, 0);
  for (let i = 0; i < 10; i++) assert.equal(player.enqueue(pcm(0.01)), false);
  advance(1999);
  assert.equal(player.snapshot().catchingUp, true);
  assert.equal(player.turnComplete(), true);
  assert.equal(player.turnComplete(), false);
  assert.equal(timers.size, 0);
  assert.equal(player.enqueue(pcm(0.1)), true);
  assert.ok(drops.some(d => d.reason === 'overflow' && d.durationMs > 7900));
  assert.equal(player.snapshot().forcedBoundaries, 0);
  player.cancel();
});

test('tiny chunks hit source cap; 2-second forced boundary reports truncation exactly once', () => {
  const { player, made, advance, drops } = setup();
  for (let i = 0; i < 256; i++) assert.equal(player.enqueue(pcm(1 / 24000)), true);
  assert.equal(player.snapshot().sourceCount, 256);
  assert.equal(player.enqueue(pcm(1 / 24000)), false);
  assert.equal(made.length, 256);
  advance(1999, false); assert.equal(player.snapshot().catchingUp, true);
  advance(1, false); assert.equal(player.snapshot().catchingUp, false);
  assert.equal(player.snapshot().forcedBoundaries, 1);
  assert.deepEqual(drops.filter(d => d.reason === 'forced-boundary'), [{ reason: 'forced-boundary', durationMs: 0 }]);
  assert.equal(player.enqueue(pcm(0.1)), true);
  player.cancel();
});

test('long continuous playback has bounded resources, including delayed ended callbacks', () => {
  const { player, made, advance, timers } = setup();
  for (let i = 0; i < 1000; i++) {
    assert.equal(player.enqueue(pcm(0.2)), true);
    const source = made.at(-1), late = source.onended;
    advance(300);
    assert.equal(player.snapshot().sourceCount, 0);
    assert.ok(clean(source)); late();
    assert.equal(timers.size, 0);
    made.length = 0;
  }
  assert.equal(player.snapshot().terminal, false);
  assert.equal(player.snapshot().droppedMs, 0);
  player.cancel();
});

test('ended handler releases sources immediately and interruption keeps stream reusable', () => {
  const { player, made, timers } = setup();
  player.enqueue(pcm(1)); const late = made[0].onended;
  player.interrupt();
  assert.ok(clean(made[0]) && made[0].stopped); late();
  assert.equal(timers.size, 0);
  assert.equal(player.enqueue(pcm(1)), true);
  made[1].onended(); assert.ok(clean(made[1]));
  assert.equal(player.snapshot().sourceCount, 0);
  assert.equal(timers.size, 0);
  player.cancel();
});

test('mute clears queued audio and recovery timers; unmute only accepts new audio', () => {
  const { player, made, timers, advance } = setup();
  player.enqueue(pcm(1)); player.setMuted(true);
  assert.ok(clean(made[0]) && made[0].stopped);
  for (let i = 0; i < 1000; i++) assert.equal(player.enqueue(pcm(0.01)), false);
  assert.equal(made.length, 1); assert.equal(player.snapshot().state, 'muted');
  player.setMuted(false); assert.equal(player.snapshot().sourceCount, 0);
  player.enqueue(pcm(9)); assert.equal(player.snapshot().catchingUp, true);
  player.setMuted(true); assert.equal(timers.size, 0);
  advance(3000); assert.equal(player.snapshot().forcedBoundaries, 0);
  player.setMuted(false); assert.equal(player.enqueue(pcm(1)), true);
  player.cancel();
});

test('suspended or interrupted context discards audio with no accumulating buffers or timers', async () => {
  const { player, context, made, timers, advance } = setup();
  player.enqueue(pcm(1));
  context.setState('suspended');
  assert.equal(player.snapshot().state, 'blocked');
  assert.ok(clean(made[0]) && made[0].stopped);
  for (let i = 0; i < 1000; i++) player.enqueue(pcm(0.01));
  advance(130000); assert.equal(made.length, 1); assert.equal(timers.size, 0);
  assert.equal(player.snapshot().firstScheduledAt, 0.06);
  assert.equal(await player.resume(), true);
  assert.equal(player.snapshot().sourceCount, 0);
  player.enqueue(pcm(1)); context.setState('interrupted');
  assert.equal(player.snapshot().sourceCount, 0);
  player.cancel();
});

test('resume rejection is recoverable and does not claim physical sound', async () => {
  const { player, context } = setup();
  context.setState('suspended'); context.resume = async () => { throw Error('SECRET'); };
  assert.equal(await player.resume(), false);
  assert.equal(player.snapshot().state, 'blocked');
  assert.equal(player.snapshot().terminal, false);
  assert.equal(player.enqueue(pcm(1)), false);
  context.resume = async () => context.setState('running');
  assert.equal(await player.resume(), true);
  assert.equal(player.snapshot().actualFirstSoundAt, null);
  player.cancel();
});

test('cancel during resume or recovery is terminal, idempotent, and blocks stale callbacks', async () => {
  for (const recovering of [false, true]) {
    const controller = new AbortController();
    const { player, context, made, timers, advance } = setup({ signal: controller.signal });
    player.enqueue(pcm(1)); const late = made[0].onended;
    if (recovering) player.enqueue(pcm(9));
    let resolve;
    context.resume = () => new Promise(r => { resolve = r; });
    const pending = player.resume();
    assert.equal(player.resume(), pending);
    controller.abort(Error('SECRET')); player.cancel(); resolve(); late(); advance(5000);
    assert.equal(await pending, false);
    assert.equal(player.enqueue(pcm(1)), false); assert.equal(player.turnComplete(), false);
    player.setMuted(false); player.interrupt();
    assert.equal((await player.done).status, 'cancelled');
    assert.equal(timers.size, 0); assert.ok(made.every(s => clean(s) && s.stopped));
    assert.ok(!JSON.stringify(await player.done).includes('SECRET'));
  }
});

test('pre-aborted signal and closed context never allocate audio', async () => {
  const signal = AbortSignal.abort(Error('SECRET'));
  const a = setup({ signal });
  assert.equal(a.player.enqueue(pcm(1)), false); assert.equal(a.made.length, 0);
  assert.equal((await a.player.done).status, 'cancelled');
  const b = setup(); b.context.setState('closed');
  assert.equal(b.player.enqueue(pcm(1)), false); assert.equal(await b.player.resume(), false);
  assert.equal((await b.player.done).messageKey, 'error.VOICE_FAILED');
});

test('malformed PCM and WebAudio failures are sanitized and release partially built nodes', async () => {
  for (const mode of ['empty', 'odd', 'type', 'buffer', 'source', 'connect', 'start']) {
    const { player, context, made, timers } = setup();
    if (mode === 'buffer') context.createBuffer = () => { throw Error('SECRET'); };
    if (mode === 'source') context.createBufferSource = () => { throw Error('SECRET'); };
    if (['connect', 'start'].includes(mode)) {
      const create = context.createBufferSource;
      context.createBufferSource = () => { const s = create(); s[mode] = () => { throw Error('SECRET'); }; return s; };
    }
    const input = mode === 'empty' ? new Uint8Array() : mode === 'odd' ? new Uint8Array(3)
      : mode === 'type' ? new Int16Array(2) : pcm(1);
    assert.equal(player.enqueue(input), false);
    const result = await player.done;
    assert.equal(result.status, 'failed'); assert.equal(result.messageKey, 'error.VOICE_FAILED');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.ok(made.every(clean)); assert.equal(timers.size, 0);
  }
});

test('policy overrides cannot exceed hard duration or source bounds', () => {
  for (const options of [{ maxSources: 257 }, { maxSources: 0 }, { maxSources: 1.5 },
    { maxQueueSeconds: 9 }, { maxQueueSeconds: 0 }, { maxQueueSeconds: NaN }]) {
    assert.throws(() => setup(options), /AUDIO_INVALID_OPTIONS/);
  }
});
