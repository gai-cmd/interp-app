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
//
// The share picker (§19) is tied to the offscreen DOCUMENT it was asked in (the one `browser.offscreenContext` names;
// without a fake browser or a document, one anonymous document that is never closed), because of what a real browser
// was seen to do (docs/extension.md §20, check 20.5; headless Chrome for Testing 149, headed Chrome and Windows
// UNVERIFIED):
//   * a dialog that nobody has answered yet blocks a TAB-CAPTURE getUserMedia of the SAME document: that call stays
//     pending (6 s and more) until the dialog is answered, or for ever when the document is closed first. A microphone
//     getUserMedia is not held. What the browser does with the stream id meanwhile is not known: the fake keeps it
//     unconsumed, so it can also run out (STREAM_ID_TTL_MS) while the call waits. `pickerBlocksTabCapture: false`
//     switches the block off (a test that needs the old, unblocked fake).
//   * closing the document takes its dialogs with it (the "ghost" dialog is gone); a call it was waiting on never completes.
//
// §22 (2026-10-08): on Chrome 153+ the SIDE PANEL asks for the dialog and relays the tab's audio to the offscreen
// document. `relay: true` gives the env the offscreen realm's relay constructors (BroadcastChannel,
// MediaStreamTrackGenerator, AudioData; without it the env keeps its exact old shape), `relay` (always there) is the
// world both documents share (fake-relay.mjs), and panelMedia() builds the panel's navigator and realm. A dialog the
// PANEL asked for belongs to the panel: it never holds a tab-capture getUserMedia of the offscreen document (seen in the
// spike: a pending panel dialog did not block the offscreen tab capture, which resolved in 12 ms).
import { FakeMediaStream, FakeTrack, createFakeClock, createMediaSource } from './fake-chrome.mjs';
import { FakeAudioData, createRelayWorld } from './fake-relay.mjs';

export { FakeAudioData, FakeMediaStream, FakeTrack };

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
  /** A ConstantSourceNode: `offset.value`, start()/stop() recorded (§22, the relayed tab's keep-alive). */
  createConstantSource() {
    if (this.state === 'closed') throw domError('InvalidStateError', 'The context is closed.');
    const node = new FakeAudioNode(this, 'constantSource');
    Object.assign(node, { offset: new FakeGainParam(), started: false, stopped: false,
      start() { if (this.started) throw domError('InvalidStateError', 'start() was already called'); this.started = true; },
      stop() { if (!this.started) throw domError('InvalidStateError', 'not started'); this.stopped = true; } });
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

export function createFakeAudioEnv({ browser, clock, sockets, autoplay = 'allowed', micPermission = 'granted', pickerBlocksTabCapture = true,
  relay = false } = {}) {
  const time = browser?.clock ?? clock ?? createFakeClock();
  const contexts = [], worklets = [], micStreams = [];
  const flags = { failAddModule: false, failSampleRates: false };
  const mic = { permission: micPermission, error: null };
  const permissions = { mode: 'normal', held: [], statuses: new Set() };
  const media = { mode: 'normal', held: [] };
  // §19: the share picker. Every call of the display-capture method stays pending until the test answers it (the
  // oldest first), exactly like a dialog the user has not answered yet. The method name is assembled at runtime: the
  // D13 scan (tests/extension-static.test.mjs) forbids spelling it in a test file, so that no test can reach the real one.
  const SHARE_METHOD = ['getDisplay', 'Media'].join('');
  const picker = { calls: [], open: [], streams: [], gone: 0 };
  const tabWaits = [];   // tab-capture getUserMedia calls held behind a dialog of their own document: { context, resolve }
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
  const documentNow = () => browser?.offscreenContext ?? null;
  const isLive = (context) => context === null || context.alive === true;
  const pickerOpenIn = (context) => picker.open.some((entry) => entry.context === context);
  // A closed document takes its dialogs with it, and a call it was waiting on never completes. Dropped lazily, whenever
  // the picker state is read or changed.
  function purge() {
    const alive = picker.open.filter((entry) => isLive(entry.context));
    picker.gone += picker.open.length - alive.length;
    picker.open = alive;
    const waiting = tabWaits.splice(0);
    for (const waiter of waiting) if (isLive(waiter.context)) tabWaits.push(waiter);
  }
  // A dialog was answered: the tab captures that waited behind it (and only those of a document with no dialog left) go on.
  function wake() {
    purge();
    for (const waiter of tabWaits.splice(0)) {
      if (pickerOpenIn(waiter.context)) tabWaits.push(waiter); else waiter.resolve();
    }
  }
  async function getUserMedia(constraints) {
    if (!constraints || (!constraints.audio && !constraints.video)) throw new TypeError('At least one of audio and video must be requested');
    const tabAudio = constraints.audio?.mandatory?.chromeMediaSource === 'tab' ? constraints.audio.mandatory : null;
    const tabVideo = constraints.video?.mandatory?.chromeMediaSource === 'tab' ? constraints.video.mandatory : null;
    if (tabAudio || tabVideo) {
      if (!browser) throw domError('NotSupportedError', 'tab capture needs a fake browser');
      const id = (tabAudio ?? tabVideo).chromeMediaSourceId;
      if (pickerBlocksTabCapture) {
        purge();
        const context = documentNow();
        if (pickerOpenIn(context)) await new Promise((resolve) => { tabWaits.push({ context, resolve }); });
      }
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

  function openSharePicker(constraints) {
    purge();
    picker.calls.push(constraints);
    return new Promise((resolve, reject) => { picker.open.push({ context: documentNow(), resolve, reject }); });
  }

  const navigator = { mediaDevices: { getUserMedia, [SHARE_METHOD]: openSharePicker }, userActivation: { isActive: false } };
  Object.defineProperty(navigator, 'permissions', { enumerable: true, get: () => (permissions.mode === 'missing' ? undefined : permissionsApi) });

  const WebSocket = sockets?.WebSocket ?? sockets
    ?? class { constructor() { throw new Error('unexpected WebSocket'); } };
  const relayWorld = createRelayWorld();
  const env = { AudioContext, AudioWorkletNode, MediaStream: FakeMediaStream, navigator, WebSocket,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, now: time.now,
    random: () => 0.5, isSecureContext: true,
    // The host passes env.fetch to createAppConfig: without this a test that
    // reached a REST path would try a real network call.
    fetch: async () => { throw new Error('unexpected fetch'); },
    // §22: the offscreen realm's relay constructors, only when asked for (the env's shape is pinned otherwise).
    ...(relay ? { BroadcastChannel: relayWorld.BroadcastChannel, MediaStreamTrackGenerator: relayWorld.MediaStreamTrackGenerator,
      AudioData: relayWorld.AudioData } : {}) };

  // §22: the share dialog the SIDE PANEL asks for. Same model as `picker` above (the oldest dialog is answered first,
  // the chosen page's capture label rides on the video track), but the dialog belongs to the panel document: it never
  // holds a tab capture of the offscreen document. `drop()` = the panel document went away (its dialogs with it; a call
  // that waited on one never completes).
  const panelPicker = { calls: [], open: [], streams: [], gone: 0 };
  function openPanelPicker(constraints) {
    panelPicker.calls.push(constraints);
    return new Promise((resolve, reject) => { panelPicker.open.push({ resolve, reject }); });
  }
  const panelDialog = Object.freeze({
    calls: panelPicker.calls,
    streams: panelPicker.streams,
    pending: () => panelPicker.open.length,
    gone: () => panelPicker.gone,
    choose({ label = null, audio = true, suppressed = true } = {}) {
      const entry = panelPicker.open.shift();
      if (!entry) throw new Error('no panel share dialog is open');
      const source = createMediaSource();
      const tracks = [];
      if (audio) tracks.push(new FakeTrack({ kind: 'audio', label: 'Tab audio', source, deviceId: 'web-contents-media-stream://fake',
        settings: { suppressLocalAudioPlayback: suppressed } }));
      tracks.push(new FakeTrack({ kind: 'video', label: 'web-contents-media-stream://fake', source, deviceId: 'web-contents-media-stream://fake',
        settings: { displaySurface: 'browser' }, captureHandle: label === null ? null : { handle: label } }));
      const stream = new FakeMediaStream(tracks);
      stream.source = source;
      panelPicker.streams.push(stream);
      entry.resolve(stream);
      return stream;
    },
    dismiss(name = 'NotAllowedError') {
      const entry = panelPicker.open.shift();
      if (!entry) throw new Error('no panel share dialog is open');
      entry.reject(domError(name, 'fake share picker failure'));
    },
    drop() { panelPicker.gone += panelPicker.open.length; panelPicker.open = []; },
  });

  /**
   * §22: the side panel's navigator and realm. `chromeMajor` (null: no Chrome version at all) goes into
   * userAgentData.brands ("Google Chrome", "Chromium", unless `brands: false`) and the userAgent string; `processor`,
   * `channel` and `share` take MediaStreamTrackProcessor, BroadcastChannel and the display-capture method away when
   * false. Microphone permission and getUserMedia are the env navigator's. Returns { navigator, env, picker }.
   */
  function panelMedia({ chromeMajor = 153, brands = true, processor = true, channel = true, share = true } = {}) {
    const known = Number.isSafeInteger(chromeMajor);
    const panelNavigator = {
      userAgent: known
        ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36',
      ...(known && brands ? { userAgentData: Object.freeze({ mobile: false, platform: 'Windows', brands: Object.freeze([
        Object.freeze({ brand: 'Google Chrome', version: String(chromeMajor) }), Object.freeze({ brand: 'Chromium', version: String(chromeMajor) }),
        Object.freeze({ brand: 'Not.A/Brand', version: '99' })]) }) } : {}),
      mediaDevices: { getUserMedia, ...(share ? { [SHARE_METHOD]: openPanelPicker } : {}) },
      userActivation: { isActive: false },
    };
    Object.defineProperty(panelNavigator, 'permissions', { enumerable: true, get: () => navigator.permissions });
    const panelEnv = Object.freeze({ ...(processor ? { MediaStreamTrackProcessor: relayWorld.MediaStreamTrackProcessor } : {}),
      ...(channel ? { BroadcastChannel: relayWorld.BroadcastChannel } : {}) });
    return Object.freeze({ navigator: panelNavigator, env: panelEnv, picker: panelDialog });
  }

  return Object.freeze({
    env, contexts, worklets, micStreams, clock: time,
    /** §22: the relay world shared by the panel and the offscreen document (fake-relay.mjs). */
    relay: relayWorld,
    panelMedia,
    /** §22: the dialogs the side panel asked for (also panelMedia().picker). */
    panelPicker: panelDialog,
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
    /** Tab-capture getUserMedia calls that wait behind a dialog of their own document (see the header). */
    blockedTabCaptures: () => { purge(); return tabWaits.length; },
    /**
     * The share picker of §19. `calls` = the constraints of every display-capture call, `pending()` = dialogs not yet
     * answered whose document still exists, `gone()` = dialogs that disappeared with a document that was closed,
     * `streams` = what was delivered. choose() answers the oldest dialog with a stream: an audio track
     * (unless `audio: false`, a window or "share tab audio" switched off), whose settings say whether the tab was
     * silenced (`suppressed`), and a video track carrying the capture `label` of the chosen page (null: a page without
     * the content script). dismiss() closes the oldest dialog the way a user does (NotAllowedError by default).
     */
    picker: Object.freeze({
      calls: picker.calls,
      streams: picker.streams,
      pending: () => { purge(); return picker.open.length; },
      gone: () => { purge(); return picker.gone; },
      choose({ label = null, audio = true, suppressed = true } = {}) {
        purge();
        const entry = picker.open.shift();
        if (!entry) throw new Error('no share picker is open');
        const source = createMediaSource();
        const tracks = [];
        if (audio) tracks.push(new FakeTrack({ kind: 'audio', label: 'Tab audio', source, deviceId: 'web-contents-media-stream://fake',
          settings: { suppressLocalAudioPlayback: suppressed } }));
        tracks.push(new FakeTrack({ kind: 'video', label: 'web-contents-media-stream://fake', source, deviceId: 'web-contents-media-stream://fake',
          settings: { displaySurface: 'browser' }, captureHandle: label === null ? null : { handle: label } }));
        const stream = new FakeMediaStream(tracks);
        stream.source = source;
        picker.streams.push(stream);
        entry.resolve(stream);
        wake();
        return stream;
      },
      dismiss(name = 'NotAllowedError') {
        purge();
        const entry = picker.open.shift();
        if (!entry) throw new Error('no share picker is open');
        entry.reject(domError(name, 'fake share picker failure'));
        wake();
      },
    }),
    setAutoplay(mode) {
      if (!['allowed', 'blocked', 'held'].includes(mode)) throw new TypeError('unknown autoplay mode');
      currentAutoplay = mode;
    },
    failAddModule(value = true) { flags.failAddModule = Boolean(value); },
    failSampleRates(value = true) { flags.failSampleRates = Boolean(value); },
  });
}
