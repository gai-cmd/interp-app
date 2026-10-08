// New implementation of docs/extension.md §22 (2026-10-08); no legacy code is ported.
// The tab-audio relay. On a Chrome that shows the share dialog over a side panel (lib/display-media.js) the PANEL asks
// for it and holds the captured track; the offscreen document, which runs the engine, gets the tab's audio from here:
//   panel:     MediaStreamTrackProcessor -> AudioData -> mono Float32 PCM, batched -> BroadcastChannel
//   offscreen: BroadcastChannel -> AudioData -> MediaStreamTrackGenerator -> a MediaStream the tab audio graph plays
// Both documents are pages of this extension, so the channel (`interp-relay-<relayId>`, a fresh random id per start) is
// reachable by this extension's own pages only. The wire: { t:'audio', seq, sampleRate, ts, pcm } and { t:'end', reason }.
// No heartbeat and no silence watchdog: a minimised window throttles the panel's timers, and silence must never end a
// lane. Measured in headless Chrome for Testing 149 (2026-10-08 spike): 60 s without a lost message, one-way latency
// p50 0.2 ms, max 8-13 ms; the generator track never ends by itself, so the end of a relay is always an explicit message.
// Environment objects arrive by injection; importing this module touches no global.
import { RELAY_ID_PATTERN } from './constants.js';
import { LIMITS } from './protocol.js';

export const RELAY_CHANNEL_PREFIX = 'interp-relay-';
/** The panel sends at least this much audio per message (tab capture delivers 128 frames per AudioData: ~344 a second). */
export const RELAY_BATCH_MS = 20;
/**
 * The end reasons that mean the captured TAB went away (closed, Chrome's "Stop sharing", the capture failed). Any other
 * reason is the panel's own stop (Stop, Cancel, the icon taking over, the panel closing), which the host must never
 * report as TAB_ENDED: the lane is being stopped on purpose.
 */
export const RELAY_TAB_ENDED = Object.freeze(['ended', 'error']);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// Calls fn and swallows both a throw and a rejected promise it returns (a stream's cancel() or close()).
const quietly = (fn) => {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') result.then(undefined, () => {});
  } catch { /* nothing to do */ }
};
const codedError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const REASON_PATTERN = /^[a-z][a-z-]{0,31}$/;
const reasonOf = (value, fallback) => (typeof value === 'string' && REASON_PATTERN.test(value) ? value : fallback);
// AudioData's own range of sample rates.
const MIN_RATE = 3000;
const MAX_RATE = 768000;
const isRate = (value) => Number.isFinite(value) && value >= MIN_RATE && value <= MAX_RATE;
const isFloat32Array = (value) => Object.prototype.toString.call(value) === '[object Float32Array]';

/** True for a relay id: 32 lowercase hex characters. */
export const isRelayId = (value) => typeof value === 'string' && RELAY_ID_PATTERN.test(value);

/**
 * The lane code an end of the relay stands for, or null for the panel's own stop of a lane that runs. `started` = the
 * host had received audio already. Before the first audio an own stop is START_CANCELLED (the lane settles in off
 * without a notice) and a failure of the capture is TAB_CAPTURE_FAILED.
 */
export function relayEndCode(reason, { started = true } = {}) {
  if (reason === 'ended') return 'TAB_ENDED';
  if (reason === 'error') return started ? 'TAB_ENDED' : 'TAB_CAPTURE_FAILED';
  return started ? null : 'START_CANCELLED';
}

// The mono downmix of one AudioData: the average of its channels, read as f32-planar (Chrome converts any sample format
// on copyTo); an AudioData that cannot be read that way is read interleaved. null: unreadable (the chunk is skipped).
function monoOf(data, frames, channels) {
  const mono = new Float32Array(frames);
  try {
    if (channels === 1) {
      data.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
      return mono;
    }
    const plane = new Float32Array(frames);
    for (let channel = 0; channel < channels; channel += 1) {
      data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      for (let index = 0; index < frames; index += 1) mono[index] += plane[index];
    }
  } catch {
    try {
      const interleaved = new Float32Array(frames * channels);
      data.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
      mono.fill(0);
      for (let index = 0; index < frames; index += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) sum += interleaved[index * channels + channel];
        mono[index] = sum;
      }
    } catch { return null; }
  }
  if (channels > 1) for (let index = 0; index < frames; index += 1) mono[index] /= channels;
  return mono;
}

/**
 * The panel's side. Reads the captured audio `track` and posts it on the relay channel: mono Float32 PCM, at least
 * RELAY_BATCH_MS per message, `seq` counting up from 0 (a change of sample rate sends what was collected first). The
 * track's `ended` or the end of its stream posts { t:'end', reason:'ended' } once (a read failure: reason 'error');
 * stop(reason) posts { t:'end', reason } once (reason: a short lowercase word, 'stop' by default; never 'ended' or
 * 'error' for an own stop), then stops reading and closes the channel. Whatever was collected is sent before the end.
 * The track itself is never stopped here: it is the caller's (the panel stops it with the lane).
 * `env` = { MediaStreamTrackProcessor, BroadcastChannel } of the panel's realm. Throws Error{code:'INVALID_REQUEST'} for
 * a bad argument and Error{code:'TAB_CAPTURE_FAILED'} when the track cannot be read or the channel cannot be opened
 * (nothing is left open then).
 */
export function createRelaySender({ track, relayId, env } = {}) {
  if (!isRelayId(relayId) || track === null || typeof track !== 'object'
    || typeof attempt(() => env.MediaStreamTrackProcessor) !== 'function' || typeof attempt(() => env.BroadcastChannel) !== 'function') {
    throw codedError('INVALID_REQUEST');
  }
  let reader = null, channel = null;
  try {
    reader = new env.MediaStreamTrackProcessor({ track }).readable.getReader();
    channel = new env.BroadcastChannel(`${RELAY_CHANNEL_PREFIX}${relayId}`);
  } catch {
    if (reader) quietly(() => reader.cancel());
    if (channel) attempt(() => channel.close());
    throw codedError('TAB_CAPTURE_FAILED');
  }
  let seq = 0, ended = false;
  let batch = null;   // { sampleRate, ts, parts: Float32Array[], frames }
  const post = (message) => { attempt(() => channel.postMessage(message)); };

  function flush() {
    const current = batch;
    batch = null;
    if (!current || current.frames === 0) return;
    const pcm = new Float32Array(current.frames);
    let at = 0;
    for (const part of current.parts) { pcm.set(part, at); at += part.length; }
    post({ t: 'audio', seq, sampleRate: current.sampleRate, ts: current.ts, pcm });
    seq += 1;
  }

  function take(data) {
    try {
      const frames = attempt(() => data.numberOfFrames);
      const channels = attempt(() => data.numberOfChannels);
      const rate = attempt(() => data.sampleRate);
      if (!Number.isSafeInteger(frames) || frames <= 0 || !Number.isSafeInteger(channels) || channels <= 0 || !isRate(rate)) return;
      const mono = monoOf(data, frames, channels);
      if (mono === null) return;
      if (batch && batch.sampleRate !== rate) flush();
      const ts = attempt(() => data.timestamp);
      batch ??= { sampleRate: rate, ts: Number.isFinite(ts) ? ts : 0, parts: [], frames: 0 };
      batch.parts.push(mono);
      batch.frames += frames;
      if (batch.frames * 1000 >= RELAY_BATCH_MS * rate) flush();
    } finally {
      attempt(() => data.close());   // every AudioData read is closed at once, whatever happened to it
    }
  }

  function finish(reason) {
    if (ended) return;
    ended = true;
    flush();
    post({ t: 'end', reason });
    attempt(() => track.removeEventListener('ended', onTrackEnded));
    quietly(() => reader.cancel(reason));
    attempt(() => channel.close());
  }
  const onTrackEnded = () => finish('ended');
  attempt(() => track.addEventListener('ended', onTrackEnded));

  (async () => {
    for (;;) {
      let result;
      try { result = await reader.read(); } catch { finish('error'); return; }
      if (ended) { if (result && !result.done) attempt(() => result.value.close()); return; }
      if (!result || result.done) { finish('ended'); return; }
      take(result.value);
    }
  })();

  return Object.freeze({
    /** Posts the end (once), stops reading, closes the channel. Idempotent. The track stays the caller's. */
    stop(reason = 'stop') { finish(reasonOf(reason, 'stop')); },
  });
}

/**
 * The offscreen document's side. `stream` = a new MediaStream around a MediaStreamTrackGenerator that receives the
 * relayed audio as f32-planar mono AudioData, in `seq` order (an older or repeated seq is dropped; a gap is not waited
 * for). `firstFrame` resolves with the first audio message; it rejects Error{code:'TAB_CAPTURE_FAILED'} when none came
 * within `firstFrameMs`, and Error{code: relayEndCode(reason, { started: false }), reason} when the relay ended before
 * it. `onEnd(cb)` calls cb(reason) once: on the panel's { t:'end' }, on stop() (reason 'stop'), or when a write fails
 * (reason 'error'); a cb registered after the end is called at once. Returns the function that unregisters cb.
 * stop() closes the channel and the writer and stops the generator; idempotent. Nothing else ends the stream: the
 * generator track never ends by itself.
 * `env` = { BroadcastChannel, MediaStreamTrackGenerator, AudioData, MediaStream, setTimeout, clearTimeout } of the
 * offscreen realm. Throws Error{code:'INVALID_REQUEST'} for a bad id and Error{code:'TAB_CAPTURE_FAILED'} when the realm
 * has no generator (or anything else cannot be built; nothing is left open then).
 */
export function createRelaySource({ relayId, env, firstFrameMs = LIMITS.relayFirstFrameMs } = {}) {
  if (!isRelayId(relayId)) throw codedError('INVALID_REQUEST');
  const capability = (name) => attempt(() => env[name]);
  if (['BroadcastChannel', 'MediaStreamTrackGenerator', 'AudioData', 'MediaStream'].some((name) => typeof capability(name) !== 'function')
    || typeof capability('setTimeout') !== 'function' || typeof capability('clearTimeout') !== 'function') {
    throw codedError('TAB_CAPTURE_FAILED');
  }
  let generator = null, writer = null, stream = null, channel = null;
  try {
    generator = new env.MediaStreamTrackGenerator({ kind: 'audio' });
    writer = generator.writable.getWriter();
    stream = new env.MediaStream([generator]);
    channel = new env.BroadcastChannel(`${RELAY_CHANNEL_PREFIX}${relayId}`);
  } catch {
    if (writer) quietly(() => writer.close());
    if (generator) attempt(() => generator.stop());
    if (channel) attempt(() => channel.close());
    throw codedError('TAB_CAPTURE_FAILED');
  }

  const handlers = new Set();
  let lastSeq = -1, started = false, endReason = null, stopped = false, timer = null;
  let resolveFirst, rejectFirst;
  const firstFrame = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  firstFrame.catch(() => {});   // a rejection nobody waits for is not an unhandled one
  const clearTimer = () => { if (timer !== null) { attempt(() => env.clearTimeout(timer)); timer = null; } };

  function end(reason) {
    if (endReason !== null) return;
    endReason = reason;
    clearTimer();
    if (!started) rejectFirst(codedError(relayEndCode(reason, { started: false }), { reason }));
    attempt(() => channel.removeEventListener('message', onMessage));
    attempt(() => channel.close());
    for (const handler of [...handlers]) attempt(() => handler(reason));
    handlers.clear();
  }

  function write(message) {
    const { pcm } = message;
    let data;
    try {
      data = new env.AudioData({ format: 'f32-planar', sampleRate: message.sampleRate, numberOfFrames: pcm.length,
        numberOfChannels: 1, timestamp: Number.isFinite(message.ts) ? Math.round(message.ts) : 0, data: pcm });
    } catch { return false; }   // an unusable message is skipped, like an older seq
    let written;
    try { written = writer.write(data); } catch {
      attempt(() => data.close());
      end('error');
      return false;
    }
    Promise.resolve(written).then(undefined, () => { attempt(() => data.close()); end('error'); });
    return true;
  }

  function onMessage(event) {
    if (endReason !== null) return;
    const message = attempt(() => event.data);
    if (message === null || typeof message !== 'object') return;
    if (message.t === 'end') { end(reasonOf(message.reason, 'stop')); return; }
    if (message.t !== 'audio' || !Number.isSafeInteger(message.seq) || message.seq <= lastSeq) return;
    if (!isFloat32Array(message.pcm) || message.pcm.length === 0 || !isRate(message.sampleRate)) return;
    lastSeq = message.seq;
    if (!write(message) || started) return;
    started = true;
    clearTimer();
    resolveFirst();
  }

  channel.addEventListener('message', onMessage);
  timer = env.setTimeout(() => {
    timer = null;
    if (!started && endReason === null) rejectFirst(codedError('TAB_CAPTURE_FAILED'));
  }, firstFrameMs);

  return Object.freeze({
    stream,
    firstFrame,
    onEnd(fn) {
      if (typeof fn !== 'function') throw codedError('INVALID_REQUEST');
      if (endReason !== null) { attempt(() => fn(endReason)); return () => {}; }
      handlers.add(fn);
      return () => { handlers.delete(fn); };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      end('stop');
      quietly(() => writer.close());
      attempt(() => generator.stop());
    },
  });
}
