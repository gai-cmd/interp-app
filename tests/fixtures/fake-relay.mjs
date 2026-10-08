// New implementation of docs/extension.md §11.3 for §22 (2026-10-08); no legacy code is ported.
//
// Silent doubles for the tab-audio relay (extension/lib/audio-relay.js): a BroadcastChannel bus, a
// MediaStreamTrackProcessor that yields AudioData from a fake track, a MediaStreamTrackGenerator that records what it is
// written, and AudioData itself. Nothing here reads a device or makes a sound: every sample is a number a test chose.
//
// What the doubles model, from the real browser (Chrome for Testing 149, the 2026-10-08 relay spike, and the specs):
//   * BroadcastChannel: a message goes to every OTHER open channel of the same name that exists when it is posted, as a
//     structured clone, asynchronously and in order; a closed channel neither sends (InvalidStateError) nor receives.
//     One bus per world: the side panel and the offscreen document of one fake browser share it.
//   * MediaStreamTrackProcessor: refuses an ended track (TypeError); its reader yields one AudioData per chunk the test
//     feeds into the track and is done once the track ends (`ended`) or is stopped, or the reader is cancelled. Each
//     processor gets its own AudioData (every reader closes what it read).
//   * MediaStreamTrackGenerator: a live audio track (it can go into a MediaStream and an audio graph) that NEVER ends by
//     itself; its writer records each AudioData (copied, then closed, like the real sink) and can be made to fail.
//   * AudioData: f32-planar or f32 (interleaved) data, copyTo per plane with conversion between the two, close().
// Looser than the real thing: no other sample formats, no backpressure (desiredSize stays 1), no transfer lists.
import { FakeTrack } from './fake-chrome.mjs';

const domError = (name, message) => new DOMException(message, name);
const FORMATS = Object.freeze(['f32-planar', 'f32']);

export class FakeAudioData {
  constructor(init = {}) {
    const { format, sampleRate, numberOfFrames, numberOfChannels, timestamp, data } = init;
    if (!FORMATS.includes(format)) throw new TypeError(`fake AudioData: unsupported format ${format}`);
    if (!(Number.isFinite(sampleRate) && sampleRate > 0)) throw new TypeError('fake AudioData: invalid sampleRate');
    if (!(Number.isSafeInteger(numberOfFrames) && numberOfFrames > 0)) throw new TypeError('fake AudioData: invalid numberOfFrames');
    if (!(Number.isSafeInteger(numberOfChannels) && numberOfChannels > 0)) throw new TypeError('fake AudioData: invalid numberOfChannels');
    if (!Number.isFinite(timestamp)) throw new TypeError('fake AudioData: invalid timestamp');
    const view = ArrayBuffer.isView(data) ? new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4)) : null;
    if (!view || view.length < numberOfFrames * numberOfChannels) throw new TypeError('fake AudioData: data is too small');
    // The constructor copies: the sender may reuse its buffer at once.
    this._samples = new Float32Array(view.subarray(0, numberOfFrames * numberOfChannels));
    this._init = { format, sampleRate, numberOfFrames, numberOfChannels, timestamp };
    this.closed = false;
  }
  get format() { return this.closed ? null : this._init.format; }
  get sampleRate() { return this.closed ? 0 : this._init.sampleRate; }
  get numberOfFrames() { return this.closed ? 0 : this._init.numberOfFrames; }
  get numberOfChannels() { return this.closed ? 0 : this._init.numberOfChannels; }
  get timestamp() { return this._init.timestamp; }
  get duration() { return this.closed ? 0 : Math.round((this._init.numberOfFrames / this._init.sampleRate) * 1e6); }

  /** One sample, whatever the stored layout. */
  _sample(channel, frame) {
    const { format, numberOfFrames, numberOfChannels } = this._init;
    return format === 'f32-planar' ? this._samples[channel * numberOfFrames + frame] : this._samples[frame * numberOfChannels + channel];
  }

  allocationSize({ planeIndex = 0, format = this._init.format } = {}) {
    if (this.closed) throw domError('InvalidStateError', 'AudioData is closed.');
    const { numberOfFrames, numberOfChannels } = this._init;
    if (format === 'f32-planar') return numberOfFrames * 4;
    if (planeIndex !== 0) throw new RangeError('interleaved data has one plane');
    return numberOfFrames * numberOfChannels * 4;
  }

  copyTo(destination, { planeIndex, format = this._init.format, frameOffset = 0 } = {}) {
    if (this.closed) throw domError('InvalidStateError', 'AudioData is closed.');
    if (!FORMATS.includes(format)) throw new TypeError(`fake AudioData: cannot convert to ${format}`);
    if (!(destination instanceof Float32Array)) throw new TypeError('fake AudioData: copy into a Float32Array');
    const { numberOfFrames, numberOfChannels } = this._init;
    const frames = numberOfFrames - frameOffset;
    if (format === 'f32-planar') {
      if (!(Number.isSafeInteger(planeIndex) && planeIndex >= 0 && planeIndex < numberOfChannels)) throw new RangeError('planeIndex out of range');
      if (destination.length < frames) throw new RangeError('destination is not large enough');
      for (let frame = 0; frame < frames; frame += 1) destination[frame] = this._sample(planeIndex, frame + frameOffset);
      return;
    }
    if (planeIndex !== 0) throw new RangeError('interleaved data has one plane');
    if (destination.length < frames * numberOfChannels) throw new RangeError('destination is not large enough');
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < numberOfChannels; channel += 1) {
        destination[frame * numberOfChannels + channel] = this._sample(channel, frame + frameOffset);
      }
    }
  }

  clone() {
    if (this.closed) throw domError('InvalidStateError', 'AudioData is closed.');
    return new FakeAudioData({ ...this._init, data: this._samples });
  }

  close() { this.closed = true; }
}

/** The AudioData a test feeds into a track: `channels` planes of `frames` samples, `fill(channel, frame)` each. */
function chunkInit({ frames = 480, sampleRate = 48000, channels = 2, timestamp, fill = () => 0, format = 'f32-planar' }) {
  const data = new Float32Array(frames * channels);
  for (let channel = 0; channel < channels; channel += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      const value = fill(channel, frame);
      if (format === 'f32-planar') data[channel * frames + frame] = value; else data[frame * channels + channel] = value;
    }
  }
  return { format, sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp, data };
}

/**
 * One relay world: the constructors of both documents and what a test reads back. `channels` = every BroadcastChannel
 * ever made (`received` = what each was delivered), `posted` = every message posted ({ name, data }, a copy),
 * `processors` = { track, reads, cancelled (the first reason), cancels (how many), done, fail(error) } per processor, `generators` = every generator.
 * feed(track, { frames, sampleRate, channels, timestamp, fill, format }) gives every live processor of `track` one
 * AudioData and returns how many took it; timestamps count on by themselves per track when not given.
 */
export function createRelayWorld() {
  const channels = [], posted = [], processors = [], generators = [];
  const nextTimestamp = new WeakMap();

  class BroadcastChannel extends EventTarget {
    constructor(name) {
      super();
      if (arguments.length === 0) throw new TypeError('BroadcastChannel needs a name');
      this.name = String(name);
      this.closed = false;
      this.onmessage = null;
      this.received = [];
      channels.push(this);
    }
    postMessage(message) {
      if (this.closed) throw domError('InvalidStateError', 'Channel is closed');
      const copy = structuredClone(message);   // a DataCloneError for what cannot be cloned, like the real one
      posted.push({ name: this.name, data: copy });
      for (const target of channels) {
        if (target === this || target.closed || target.name !== this.name) continue;
        const data = structuredClone(message);
        queueMicrotask(() => target._deliver(data));
      }
    }
    _deliver(data) {
      if (this.closed) return;
      this.received.push(data);
      const event = new MessageEvent('message', { data });
      try { this.onmessage?.(event); } finally { this.dispatchEvent(event); }
    }
    close() { this.closed = true; }
  }

  class MediaStreamTrackProcessor {
    constructor({ track } = {}) {
      if (!(track instanceof FakeTrack)) throw new TypeError('MediaStreamTrackProcessor needs a track');
      if (track.readyState === 'ended') throw new TypeError('Input track cannot be ended');
      const queue = [];
      let waiting = null, failure = null;
      const record = { track, reads: 0, cancelled: undefined, cancels: 0, done: false, queued: () => queue.length,
        fail(error = domError('AbortError', 'fake read failure')) { failure = error; wake(); },
        push(init) {
          if (record.done) return false;
          queue.push(new FakeAudioData(init));
          wake();
          return true;
        } };
      function wake() { const resolve = waiting; waiting = null; resolve?.(); }
      function finish() {
        if (record.done) return;
        record.done = true;
        for (const data of queue.splice(0)) data.close();
        track.removeEventListener('ended', finish);
        track.stopWatchers?.delete(finish);
        wake();
      }
      track.addEventListener('ended', finish);
      track.stopWatchers?.add(finish);   // a stopped track closes the stream too (no `ended` event fires for a stop)
      processors.push(record);
      let locked = false;
      const reader = Object.freeze({
        async read() {
          for (;;) {
            if (failure) { const error = failure; failure = null; finish(); throw error; }
            if (queue.length > 0) { record.reads += 1; return { value: queue.shift(), done: false }; }
            if (record.done) return { value: undefined, done: true };
            await new Promise((resolve) => { waiting = resolve; });
          }
        },
        async cancel(reason) { record.cancels += 1; if (record.cancelled === undefined) record.cancelled = reason ?? null; finish(); },
        releaseLock() { locked = false; },
      });
      this.readable = Object.freeze({
        get locked() { return locked; },
        getReader() {
          if (locked) throw new TypeError('ReadableStream is locked');
          locked = true;
          return reader;
        },
      });
    }
  }

  class MediaStreamTrackGenerator extends FakeTrack {
    constructor({ kind } = {}) {
      if (kind !== 'audio' && kind !== 'video') throw new TypeError('kind must be audio or video');
      super({ kind, label: 'fake-generator', deviceId: 'fake-generator' });
      this.written = [];        // { sampleRate, numberOfFrames, numberOfChannels, timestamp, samples (plane 0) }
      this.writeError = null;   // failWrites(): every later write rejects with it
      this.writerClosed = false;
      const generator = this;
      // How Chrome for Testing 149 ends a generator (probed 2026-10-08, scratchpad panel-dialog-smoke, scenario `probe`):
      // closing the writer of a generator that has been written to ends the track WITH an `ended` event, dispatched
      // synchronously inside close() (the extension's own relay stop showed the same); a close before any write does
      // not; abort() ends it with an `ended` event a moment later; stop() first ends it with no event, and a close or a
      // write after that fires nothing (the write rejects with InvalidStateError).
      const writer = Object.freeze({
        get desiredSize() { return 1; },
        ready: Promise.resolve(),
        write(chunk) {
          if (generator.writeError) return Promise.reject(generator.writeError);
          if (generator.readyState === 'ended') return Promise.reject(domError('InvalidStateError', 'The track is ended.'));
          if (generator.writerClosed) return Promise.reject(new TypeError('The stream is closed.'));
          if (!(chunk instanceof FakeAudioData) || chunk.closed) return Promise.reject(new TypeError('not an open AudioData'));
          const samples = new Float32Array(chunk.numberOfFrames);
          chunk.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
          generator.written.push({ sampleRate: chunk.sampleRate, numberOfFrames: chunk.numberOfFrames,
            numberOfChannels: chunk.numberOfChannels, timestamp: chunk.timestamp, samples });
          chunk.close();   // the sink takes the AudioData and closes it
          return Promise.resolve();
        },
        close() {
          generator.writerClosed = true;
          if (generator.written.length > 0) generator.end();   // `ended` fires before close() returns
          return Promise.resolve();
        },
        abort() {
          generator.writerClosed = true;
          queueMicrotask(() => generator.end());
          return Promise.resolve();
        },
        releaseLock() {},
      });
      let locked = false;
      this.writable = Object.freeze({
        get locked() { return locked; },
        getWriter() {
          if (locked) throw new TypeError('WritableStream is locked');
          locked = true;
          return writer;
        },
      });
      generators.push(this);
    }
    /** Every later write rejects (InvalidStateError by default). */
    failWrites(error = domError('InvalidStateError', 'fake writer failure')) { this.writeError = error; }
    /** All samples written so far, one Float32Array. */
    samples() {
      const out = new Float32Array(this.written.reduce((sum, entry) => sum + entry.samples.length, 0));
      let at = 0;
      for (const entry of this.written) { out.set(entry.samples, at); at += entry.samples.length; }
      return out;
    }
  }

  function feed(track, spec = {}) {
    const frames = spec.frames ?? 480;
    const sampleRate = spec.sampleRate ?? 48000;
    const timestamp = spec.timestamp ?? nextTimestamp.get(track) ?? 0;
    nextTimestamp.set(track, timestamp + Math.round((frames / sampleRate) * 1e6));
    let taken = 0;
    for (const record of processors) {
      if (record.track === track && !record.done && record.push(chunkInit({ ...spec, frames, sampleRate, timestamp }))) taken += 1;
    }
    return taken;
  }

  return Object.freeze({ BroadcastChannel, MediaStreamTrackProcessor, MediaStreamTrackGenerator, AudioData: FakeAudioData,
    channels, posted, processors, generators, feed,
    /** The open channels of `name` (what is listening on it now). */
    listening: (name) => channels.filter((channel) => !channel.closed && channel.name === name) });
}
