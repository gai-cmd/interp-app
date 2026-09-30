// New implementation of docs/extension.md §5.6.1 and §19; no legacy code is ported.
// The tab lane: acquire the captured tab's audio, play it back through the passthrough graph, feed the engine a
// synthetic copy. The start/stop state machine (cancel token per run, teardown order) is the shared controller of
// lane-engine.js; this file supplies the tab-specific steps 3-6 and the graph teardown.
// The audio arrives one of two ways: from a stream id the service worker minted for a tab the toolbar icon armed (the
// instant path), or, for any other tab, from Chrome's own share picker (§19: a click inside the side panel cannot
// grant tab capture, so the user chooses the tab in Chrome's dialog instead).
import { tabIdOfCaptureLabel } from '../lib/constants.js';
import { createTabAudioGraph } from './audio-graph.js';
import { createLaneController } from './lane-engine.js';
import { createLanePlatform } from './platform-shim.js';

/**
 * Fallback shape for a Chrome that refuses an audio-only tab capture: also passes the same `mandatory` object under
 * `video` (the documentation example does) and stops every video track at once. Flip it only if the manual check
 * fails (assumption A6).
 */
export const TAB_CAPTURE_INCLUDE_VIDEO = false;

/**
 * What the share picker is asked for (§19). Video is mandatory for getDisplayMedia and is stopped as soon as it
 * arrives; `displaySurface: 'browser'` opens the dialog on its tab list. The audio is the tab's own signal, unprocessed,
 * and `suppressLocalAudioPlayback` silences the tab for the user exactly like the stream-id capture does, so the
 * passthrough graph and the "original volume" setting behave the same on both paths. The three `exclude` hints take
 * the whole-screen choice, the system-audio checkbox and the "share this tab instead" button out of the dialog (a
 * capture that moves to another tab would leave the overlay on the wrong page). A Chrome that does not know a hint
 * ignores it.
 */
export const DISPLAY_MEDIA_CONSTRAINTS = Object.freeze({
  video: Object.freeze({ displaySurface: 'browser' }),
  audio: Object.freeze({ suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false,
    autoGainControl: false }),
  surfaceSwitching: 'exclude',
  systemAudio: 'exclude',
  monitorTypeSurfaces: 'exclude',
});

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const stopTracks = (stream) => { for (const track of attempt(() => stream.getTracks()) ?? []) attempt(() => track.stop()); };

export function createTabLane({ env, deps = {}, timers, onChange, includeVideo = TAB_CAPTURE_INCLUDE_VIDEO } = {}) {
  let controller = null;
  // The one share picker this document has open, if any: { promise, owner }. The dialog cannot be closed from here,
  // so a start that was cancelled while it is open leaves it behind; the next start takes it over instead of stacking
  // a second dialog behind it, and a stream nobody waits for any more is released the moment it arrives.
  let picker = null;

  function openPicker(run) {
    if (picker) { picker.owner = run; return picker; }
    const entry = { owner: run, promise: null };
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
      // is the code that settles a lane in `off` without a notice.
      const dismissed = attempt(() => outcome.error.name) === 'NotAllowedError';
      throw codedError(run.cancelled || dismissed ? 'START_CANCELLED' : 'TAB_CAPTURE_FAILED');
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

  // Steps 3-6 of 5.6.1, in this exact order. `run.cancelled` is re-checked after every await.
  async function acquire({ run, params }) {
    const { streamId, pick, originalVolume } = params.tab;   // locals: never stored, logged or re-used
    const captured = pick === undefined ? await captureById({ run, streamId }) : await captureByPicker({ run, nonce: pick });
    const { raw } = captured;

    // Still the same turn: the tab is already silent for the user, so the passthrough must start at once.
    // onEnded is registered BEFORE attach, so a track that ends during the resume wait is noticed.
    const graph = createTabAudioGraph({ env, timers });
    run.graph = graph;
    graph.onEnded(() => { void controller.stop({ error: 'TAB_ENDED' }); });
    await graph.attach(raw, { originalVolume, passthrough: captured.passthrough });
    if (run.cancelled) throw codedError('START_CANCELLED');
    // A volume edit that arrived while the resume wait was pending had no gain node to act on yet.
    if (run.volume !== undefined) graph.setOriginalVolume(run.volume);
    if (graph.rawEnded()) throw codedError('TAB_ENDED');
    return { platform: createLanePlatform({ env, createPlatform: deps.createPlatform,
      getUserMedia: async () => graph.createEngineStream() }),
    ...(pick === undefined ? {} : { tabId: captured.tabId }) };
  }

  controller = createLaneController({ lane: 'tab', env, deps, timers, onChange, acquire,
    // 5.7 step 3: raw tracks stopped (the tab's own audio returns, the capture indicator goes), nodes, context.
    release: (run) => run.graph?.stop() });

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
