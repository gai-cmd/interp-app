// New implementation of docs/extension.md §5.6.1 and §19; no legacy code is ported.
// The tab lane: acquire the captured tab's audio, play it back through the passthrough graph, feed the engine a
// synthetic copy. The start/stop state machine (cancel token per run, teardown order) is the shared controller of
// lane-engine.js; this file supplies the tab-specific steps 3-6 and the graph teardown.
// The audio arrives one of three ways: from a stream id the service worker minted for a tab the toolbar icon armed (the
// instant path); from Chrome's own share picker asked HERE (§19: a click inside the side panel cannot grant tab
// capture, so the user chooses the tab in Chrome's dialog instead); or, on a Chrome that shows that dialog over the side
// panel (§22, M153+), relayed from the panel, which asked for the dialog itself and holds the captured track.
import { DISPLAY_MEDIA_CONSTRAINTS, PICKER_REFUSED_AT_ONCE_MS } from '../lib/display-media.js';
import { createRelaySource, relayEndCode } from '../lib/audio-relay.js';
import { isMachineCode, tabIdOfCaptureLabel } from '../lib/constants.js';
import { createTabAudioGraph } from './audio-graph.js';
import { createLaneController } from './lane-engine.js';
import { createLanePlatform } from './platform-shim.js';

// Defined in lib/display-media.js since §22 (the panel asks for the same dialog); exported here as before.
export { DISPLAY_MEDIA_CONSTRAINTS, PICKER_REFUSED_AT_ONCE_MS };

/**
 * Fallback shape for a Chrome that refuses an audio-only tab capture: also passes the same `mandatory` object under
 * `video` (the documentation example does) and stops every video track at once. Flip it only if the manual check
 * fails (assumption A6).
 */
export const TAB_CAPTURE_INCLUDE_VIDEO = false;

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const codeOf = (error, fallback) => (isMachineCode(attempt(() => error?.code)) ? error.code : fallback);
const stopTracks = (stream) => { for (const track of attempt(() => stream.getTracks()) ?? []) attempt(() => track.stop()); };

export function createTabLane({ env, deps = {}, timers, onChange, onLatest = null, includeVideo = TAB_CAPTURE_INCLUDE_VIDEO, cooldowns = null } = {}) {
  let controller = null;
  // The one share picker this document has open, if any: { promise, owner }. The dialog cannot be closed from here,
  // so a start that was cancelled while it is open leaves it behind; the next start takes it over instead of stacking
  // a second dialog behind it, and a stream nobody waits for any more is released the moment it arrives. The service
  // worker closes the whole document when a Stop cancels a dialog start and no other lane lives in it (sw-core.js,
  // closeLeftOverDialog: a left-over dialog blocks the stream-id start of its document), which takes the dialog with
  // it; this take-over is what remains while the microphone keeps the document open.
  let picker = null;

  function openPicker(run) {
    if (picker) { picker.owner = run; return picker; }
    const entry = { owner: run, promise: null, startedAt: attempt(() => env.now()) };
    entry.promise = Promise.resolve()
      .then(() => env.navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS))
      .finally(() => { if (picker === entry) picker = null; });
    picker = entry;
    return entry;
  }

  // The instant path: the stream id the service worker minted for an armed tab.
  async function captureById({ run, streamId }) {
    const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
    let raw;
    try {
      raw = await env.navigator.mediaDevices.getUserMedia({ audio: { mandatory },
        ...(includeVideo ? { video: { mandatory } } : {}) });
    } catch {
      throw codedError(run.cancelled ? 'START_CANCELLED' : 'TAB_CAPTURE_FAILED');
    }
    // Same synchronous turn: a stream that arrives after a stop must not survive (no track, no capture indicator).
    if (run.cancelled) { stopTracks(raw); throw codedError('START_CANCELLED'); }
    if (includeVideo) for (const track of attempt(() => raw.getVideoTracks()) ?? []) attempt(() => track.stop());
    return { raw, passthrough: true };
  }

  // §19: Chrome's share picker. Resolves { raw, passthrough, tabId } or throws Error{code}.
  async function captureByPicker({ run, nonce }) {
    const entry = openPicker(run);
    const outcome = await Promise.race([
      entry.promise.then((stream) => ({ stream }), (error) => ({ error })),
      run.cancelSignal.then(() => ({ cancelled: true })),
    ]);
    if (outcome.cancelled) {
      // Stop does not wait for the dialog. Whatever it still delivers is released at once, unless a later start has
      // taken the dialog over by then (that start receives the stream through its own wait).
      entry.promise.then((stream) => { if (entry.owner === run) stopTracks(stream); }, () => {});
      throw codedError('START_CANCELLED');
    }
    if (outcome.error) {
      // The user closed the dialog (NotAllowedError): nothing failed, the lane simply does not start. START_CANCELLED
      // is the code that settles a lane in `off` without a notice. A refusal that came at once was not the user.
      const dismissed = attempt(() => outcome.error.name) === 'NotAllowedError';
      const refusedAtOnce = dismissed && attempt(() => env.now() - entry.startedAt) < PICKER_REFUSED_AT_ONCE_MS;
      // `run.cancelled ||` is defensive: lane-engine's begin() maps a cancelled run to START_CANCELLED whatever this throws.
      throw codedError(run.cancelled || (dismissed && !refusedAtOnce) ? 'START_CANCELLED' : 'TAB_CAPTURE_FAILED');
    }
    const raw = outcome.stream;
    if (run.cancelled) { stopTracks(raw); throw codedError('START_CANCELLED'); }
    const audio = attempt(() => raw.getAudioTracks()) ?? [];
    // Which tab: the label the service worker put on every page before asking, read from the video track BEFORE it
    // is stopped (a stopped track has no capture handle). No label = a page without the content script.
    let tabId = null;
    for (const track of attempt(() => raw.getVideoTracks()) ?? []) {
      tabId ??= tabIdOfCaptureLabel(attempt(() => track.getCaptureHandle()?.handle), nonce);
      attempt(() => track.stop());
      attempt(() => raw.removeTrack(track));
    }
    // A window, or a tab shared with "Also share tab audio" switched off: there is nothing to interpret.
    if (audio.length === 0) { stopTracks(raw); throw codedError('TAB_SHARE_NO_AUDIO'); }
    // Play the tab back only if Chrome really silenced it; otherwise the user would hear it twice.
    const passthrough = attempt(() => audio[0].getSettings().suppressLocalAudioPlayback) === true;
    return { raw, passthrough, tabId };
  }

  // §22: the side panel captured the tab and relays its audio over the channel `relay` names. Resolves
  // { raw, passthrough, tabId, source } once the first audio arrived, or throws Error{code}. The source is on `run`
  // from the moment it exists, so every way out of the start releases it.
  async function captureByRelay({ run, tab }) {
    let source;
    try {
      source = createRelaySource({ relayId: tab.relay, env: { BroadcastChannel: env.BroadcastChannel,
        MediaStreamTrackGenerator: env.MediaStreamTrackGenerator, AudioData: env.AudioData, MediaStream: env.MediaStream,
        setTimeout: (fn, ms) => timers.setTimeout(fn, ms), clearTimeout: (id) => timers.clearTimeout(id) } });
    } catch {
      throw codedError('TAB_CAPTURE_FAILED');   // e.g. a realm without MediaStreamTrackGenerator
    }
    run.relay = source;
    const outcome = await Promise.race([
      source.firstFrame.then(() => ({}), (error) => ({ error })),
      run.cancelSignal.then(() => ({ cancelled: true })),
    ]);
    if (outcome.cancelled || run.cancelled) { source.stop(); throw codedError('START_CANCELLED'); }
    if (outcome.error) { source.stop(); throw codedError(codeOf(outcome.error, 'TAB_CAPTURE_FAILED')); }
    return { raw: source.stream, passthrough: tab.passthrough === true, tabId: tab.tabId ?? null, source };
  }

  // §22: the relay ended while the lane runs (or is starting after the first audio). The tab went away (closed, "Stop
  // sharing"): TAB_ENDED, like any captured tab. The panel's own stop (Stop, Cancel, the icon, the panel closing): a
  // plain stop, which settles in off without a notice; its host/lane-stop may arrive after the relay's end message.
  function relayEnded(run, reason) {
    if (run.cancelled || controller.currentRun() !== run) return;
    const code = relayEndCode(reason, { started: true });
    void (code === null ? controller.stop() : controller.stop({ error: code }));
  }

  // Steps 3-6 of 5.6.1, in this exact order. `run.cancelled` is re-checked after every await.
  async function acquire({ run, params }) {
    const { streamId, pick, relay, originalVolume } = params.tab;   // locals: never stored, logged or re-used
    let captured;
    if (relay !== undefined) captured = await captureByRelay({ run, tab: params.tab });
    else if (pick === undefined) captured = await captureById({ run, streamId });
    else captured = await captureByPicker({ run, nonce: pick });
    const { raw } = captured;

    // Still the same turn: the tab is already silent for the user, so the passthrough must start at once.
    // onEnded is registered BEFORE attach, so a track that ends during the resume wait is noticed. A relayed track
    // never ends by itself: the relay's own end stands for it, registered just as early. Its `ended` is NOT the tab's:
    // Chrome ends a generator WITH an `ended` event when its writer is closed (Chrome for Testing 149, 2026-10-08:
    // synchronously inside writer.close(), so inside the relay's own stop() at every release), which would turn every
    // own Stop and every engine failure into TAB_ENDED. So the graph's onEnded counts only for a captured track.
    const graph = createTabAudioGraph({ env, timers });
    run.graph = graph;
    if (captured.source) captured.source.onEnd((reason) => relayEnded(run, reason));
    else graph.onEnded(() => { void controller.stop({ error: 'TAB_ENDED' }); });
    await graph.attach(raw, { originalVolume, passthrough: captured.passthrough, keepAlive: relay !== undefined });
    if (run.cancelled) throw codedError('START_CANCELLED');
    // A volume edit that arrived while the resume wait was pending had no gain node to act on yet.
    if (run.volume !== undefined) graph.setOriginalVolume(run.volume);
    if (graph.rawEnded()) throw codedError('TAB_ENDED');
    return { platform: createLanePlatform({ env, createPlatform: deps.createPlatform,
      getUserMedia: async () => graph.createEngineStream() }),
    ...(pick === undefined && relay === undefined ? {} : { tabId: captured.tabId }) };
  }

  controller = createLaneController({ lane: 'tab', env, deps, timers, onChange, onLatest, acquire, cooldowns,
    // 5.7 step 3: the relay closed (§22), then raw tracks stopped (the tab's own audio returns, the capture indicator
    // goes), nodes, context.
    release: (run) => { attempt(() => run.relay?.stop()); return run.graph?.stop(); } });

  return Object.freeze({
    ...controller,
    setOriginalVolume(percent) {
      const run = controller.currentRun();
      if (!run) return;
      run.volume = percent;
      run.graph?.setOriginalVolume(percent);
    },
  });
}
