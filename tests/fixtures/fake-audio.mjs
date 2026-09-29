// New implementation of docs/extension.md §11.3; no legacy code is ported.
//
// Silent audio doubles for the offscreen host and the lanes: an AudioContext
// with a state machine, media stream and track fakes, a worklet node that
// emits synthetic frames on demand, and a getUserMedia that understands both
// the microphone and the tab-capture constraint shapes. Nothing here can make
// a sound or open a device; every "stream" is plain data, every time value
// comes from the virtual clock.
//
// The fake is deliberately a little stricter than a bare stub where the real
// Web Audio API is strict (a closed context rejects resume/close, a source
// node needs an audio track) and looser where it cannot model reality (no
// rendering, statechange fires synchronously, no autoplay policy beyond the
// three modes below).
import { FakeMediaStream, FakeTrack, createFakeClock, createMediaSource } from './fake-chrome.mjs';

export { FakeMediaStream, FakeTrack };

const domError = (name, message) => new DOMException(message, name);

class FakeGainParam {
  constructor() { this.value = 1; this.calls = []; }
  /** Records the call and lands on the target at once: tests assert the target, not the curve. */
  setTargetAtTime(value, startTime, timeConstant) {
    this.calls.push({ value, startTime, timeConstant });
    this.value = value;
    return this;
  }
}

let nodeSerial = 0;
class FakeAudioNode {
  constructor(context, kind) {
    this.context = context; this.kind = kind; this.id = ++nodeSerial;
    this.connections = new Set(); this.disconnects = 0;
    context.nodes.push(this);
  }
  connect(target) { this.connections.add(target); return target; }
  disconnect(target) {
    this.disconnects++;
    if (target) this.connections.delete(target); else this.connections.clear();
  }
}

/** Autoplay modes: 'allowed' (resume runs), 'blocked' (resume resolves, stays suspended), 'held' (resume stays pending until releaseResume). */
export class FakeAudioContext extends EventTarget {
  constructor(options = {}, { clock = createFakeClock(), autoplay = 'allowed', register = () => {}, rejectSampleRate = () => false } = {}) {
    super();
    if (options?.sampleRate !== undefined && rejectSampleRate()) throw domError('NotSupportedError', 'The sample rate is not supported.');
    this.options = { ...options };
    this.clock = clock;
    this.autoplay = options?.autoplay ?? autoplay;
    this.state = 'suspended';
    this.sampleRate = options?.sampleRate ?? 48000;
    this.nodes = []; this.sources = []; this.destinations = []; this.modules = [];
    this.resumeCalls = 0; this.suspendCalls = 0; this.closeCalls = 0;
    this.heldResumes = [];
    this._elapsed = 0; this._runningSince = null;
    this.destination = new FakeAudioNode(this, 'destination');
    this.destination.maxChannelCount = 2;
    this.audioWorklet = { addModule: async (url) => {
      if (this.state === 'closed') throw domError('InvalidStateError', 'The context is closed.');
      if (this.failAddModule?.()) throw domError('AbortError', 'Unable to load a worklet module.');
      this.modules.push(String(url));
    } };
    register(this);
  }
  get currentTime() {
    return this._elapsed + (this.state === 'running' && this._runningSince !== null ? (this.clock.now() - this._runningSince) / 1000 : 0);
  }
  _setState(next) {
    if (this.state === next) return;
    if (this.state === 'running' && this._runningSince !== null) this._elapsed += (this.clock.now() - this._runningSince) / 1000;
    this._runningSince = next === 'running' ? this.clock.now() : null;
    this.state = next;
    this.dispatchEvent(new Event('statechange'));
  }
  async resume() {
    this.resumeCalls++;
    if (this.state === 'closed') throw domError('InvalidStateError', 'Cannot resume a closed AudioContext.');
    if (this.state === 'running') return;
    if (this.autoplay === 'blocked') return;
    if (this.autoplay === 'held') {
      await new Promise((resolve) => { this.heldResumes.push(resolve); });
      return;
    }
    this._setState('running');
  }
  /** Settles every held resume() and moves to `state` (default running). */
  releaseResume(state = 'running') {
    if (this.state !== 'closed') this._setState(state);
    for (const resolve of this.heldResumes.splice(0)) resolve();
  }
  async suspend() {
    this.suspendCalls++;
    if (this.state === 'closed') throw domError('InvalidStateError', 'Cannot suspend a closed AudioContext.');
    this._setState('suspended');
  }
  async close() {
    this.closeCalls++;
    if (this.state === 'closed') throw domError('InvalidStateError', 'Cannot close a closed AudioContext.');
    this._setState('closed');
    for (const resolve of this.heldResumes.splice(0)) resolve();
  }
  createMediaStreamSource(stream) {
    if (this.state === 'closed') throw domError('InvalidStateError', 'The context is closed.');
    if (!stream?.getAudioTracks || !stream.getAudioTracks().length) throw domError('InvalidStateError', 'MediaStream has no audio track.');
    const node = new FakeAudioNode(this, 'mediaStreamSource');
    node.mediaStream = stream;
    return node;
  }
  createGain() {
    const node = new FakeAudioNode(this, 'gain');
    node.gain = new FakeGainParam();
    return node;
  }
  createMediaStreamDestination() {
    const node = new FakeAudioNode(this, 'mediaStreamDestination');
    // A new live track per node; like the real one it never ends by itself.
    node.stream = new FakeMediaStream([new FakeTrack({ kind: 'audio', label: 'fake-destination', source: createMediaSource() })]);
    this.destinations.push(node);
    return node;
  }
  createBuffer(numberOfChannels, length, sampleRate) {
    const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    return { numberOfChannels, length, sampleRate, duration: length / sampleRate, getChannelData: (index) => channels[index] };
  }
  createBufferSource() {
    const source = new FakeAudioNode(this, 'bufferSource');
    Object.assign(source, { buffer: null, onended: null, started: false, stopped: false, startedAt: null,
      start(when) { this.started = true; this.startedAt = when; },
      stop() { this.stopped = true; },
      /** The scheduled audio finished playing: fires `onended` once. */
      end() { const handler = this.onended; this.onended = null; handler?.({ type: 'ended', target: this }); } });
    this.sources.push(source);
    return source;
  }
}

let workletSerial = 0;
export class FakeAudioWorkletNode extends FakeAudioNode {
  constructor(context, name, options = {}) {
    if (!(context instanceof FakeAudioContext)) throw new TypeError('context must be a FakeAudioContext');
    if (context.state === 'closed') throw domError('InvalidStateError', 'The context is closed.');
    super(context, 'audioWorklet');
    this.name = name; this.options = options; this.serial = ++workletSerial;
    this.onprocessorerror = null;
    this.port = { onmessage: null, posted: [], closed: false,
      postMessage(message) { this.posted.push(message); },
      close() { this.closed = true; } };
  }
  /** Posts a synthetic mono block like tests/fixtures/sim.mjs does. Returns whether a handler took it. */
  emitFrames(value = 0.25) {
    const handler = this.port.onmessage;
    handler?.({ data: new Float32Array(1024).fill(value) });
    return typeof handler === 'function';
  }
}

export function createFakeAudioEnv({ browser, clock, sockets, autoplay = 'allowed', micPermission = 'granted' } = {}) {
  const time = browser?.clock ?? clock ?? createFakeClock();
  const contexts = [], worklets = [], micStreams = [];
  const flags = { failAddModule: false, failSampleRates: false };
  const mic = { permission: micPermission, error: null };
  const permissions = { mode: 'normal', held: [], statuses: new Set() };
  const media = { mode: 'normal', held: [] };
  let currentAutoplay = autoplay;

  class AudioContext extends FakeAudioContext {
    constructor(options) {
      super(options, { clock: time, autoplay: currentAutoplay, rejectSampleRate: () => flags.failSampleRates,
        register: (context) => { context.failAddModule = () => flags.failAddModule; contexts.push(context); } });
    }
  }
  class AudioWorkletNode extends FakeAudioWorkletNode {
    constructor(context, name, options) { super(context, name, options); worklets.push(this); }
  }

  class PermissionStatus extends EventTarget {
    constructor(name, state) { super(); this.name = name; this.state = state; this.onchange = null; }
  }
  const makeStatus = () => { const status = new PermissionStatus('microphone', mic.permission); permissions.statuses.add(status); return status; };
  const permissionsApi = { query: async ({ name } = {}) => {
    if (name !== 'microphone') throw new TypeError(`unsupported permission ${name}`);
    if (permissions.mode === 'throws') throw domError('NotSupportedError', 'permissions.query failed');
    if (permissions.mode === 'held') return new Promise((resolve) => { permissions.held.push(() => resolve(makeStatus())); });
    return makeStatus();
  } };

  const deliverStream = (stream) => {
    if (media.mode !== 'held') return stream;
    return new Promise((resolve, reject) => { media.held.push({ resolve: () => resolve(stream), reject }); });
  };
  async function getUserMedia(constraints) {
    if (!constraints || (!constraints.audio && !constraints.video)) throw new TypeError('At least one of audio and video must be requested');
    const tabAudio = constraints.audio?.mandatory?.chromeMediaSource === 'tab' ? constraints.audio.mandatory : null;
    const tabVideo = constraints.video?.mandatory?.chromeMediaSource === 'tab' ? constraints.video.mandatory : null;
    if (tabAudio || tabVideo) {
      if (!browser) throw domError('NotSupportedError', 'tab capture needs a fake browser');
      const id = (tabAudio ?? tabVideo).chromeMediaSourceId;
      return deliverStream(browser.consumeStreamId(id, { video: Boolean(tabVideo) }));
    }
    if (mic.error) throw domError(mic.error, 'fake microphone error');
    if (mic.permission !== 'granted') {
      throw domError('NotAllowedError', mic.permission === 'denied' ? 'Permission denied' : 'Permission dismissed');
    }
    const stream = new FakeMediaStream([new FakeTrack({ kind: 'audio', label: 'Fake microphone', source: createMediaSource(), deviceId: 'fake-microphone' })]);
    micStreams.push(stream);
    return deliverStream(stream);
  }

  const navigator = { mediaDevices: { getUserMedia }, userActivation: { isActive: false } };
  Object.defineProperty(navigator, 'permissions', { enumerable: true, get: () => (permissions.mode === 'missing' ? undefined : permissionsApi) });

  const WebSocket = sockets?.WebSocket ?? sockets
    ?? class { constructor() { throw new Error('unexpected WebSocket'); } };
  const env = { AudioContext, AudioWorkletNode, MediaStream: FakeMediaStream, navigator, WebSocket,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, now: time.now,
    random: () => 0.5, isSecureContext: true,
    // The host passes env.fetch to createAppConfig: without this a test that
    // reached a REST path would try a real network call.
    fetch: async () => { throw new Error('unexpected fetch'); } };

  return Object.freeze({
    env, contexts, worklets, micStreams, clock: time,
    setMicPermission(next) {
      if (!['granted', 'denied', 'prompt'].includes(next)) throw new TypeError('state must be granted, denied or prompt');
      mic.permission = next;
      for (const status of permissions.statuses) {
        status.state = next;
        const event = new Event('change');
        status.dispatchEvent(event);
        status.onchange?.(event);
      }
    },
    /** A DOMException name every microphone getUserMedia fails with (null clears). */
    setMicError(name) { mic.error = name ?? null; },
    /** 'normal' | 'throws' | 'held' (query stays pending) | 'missing' (navigator.permissions undefined). */
    setPermissionsMode(mode) {
      if (!['normal', 'throws', 'held', 'missing'].includes(mode)) throw new TypeError('unknown permissions mode');
      permissions.mode = mode;
    },
    releasePermissionQueries() { for (const release of permissions.held.splice(0)) release(); },
    pendingPermissionQueries: () => permissions.held.length,
    /** 'normal' | 'held': held getUserMedia calls create their stream now but resolve on releaseGetUserMedia. */
    setGetUserMediaMode(mode) {
      if (!['normal', 'held'].includes(mode)) throw new TypeError('unknown getUserMedia mode');
      media.mode = mode;
    },
    releaseGetUserMedia({ error } = {}) {
      for (const entry of media.held.splice(0)) { if (error) entry.reject(domError(error, 'fake getUserMedia failure')); else entry.resolve(); }
    },
    pendingGetUserMedia: () => media.held.length,
    setAutoplay(mode) {
      if (!['allowed', 'blocked', 'held'].includes(mode)) throw new TypeError('unknown autoplay mode');
      currentAutoplay = mode;
    },
    failAddModule(value = true) { flags.failAddModule = Boolean(value); },
    failSampleRates(value = true) { flags.failSampleRates = Boolean(value); },
  });
}
