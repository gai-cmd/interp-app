// New implementation of docs/extension.md §5.6.1; no legacy code is ported.
// The tab lane: acquire the captured tab's audio, play it back through the passthrough graph, feed the engine a
// synthetic copy. The start/stop state machine (cancel token per run, teardown order) is the shared controller of
// lane-engine.js; this file supplies the tab-specific steps 3-6 and the graph teardown.
import { createTabAudioGraph } from './audio-graph.js';
import { createLaneController } from './lane-engine.js';
import { createLanePlatform } from './platform-shim.js';

/**
 * Fallback shape for a Chrome that refuses an audio-only tab capture: also passes the same `mandatory` object under
 * `video` (the documentation example does) and stops every video track at once. Flip it only if the manual check
 * fails (assumption A6).
 */
export const TAB_CAPTURE_INCLUDE_VIDEO = false;

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const stopTracks = (stream) => { for (const track of attempt(() => stream.getTracks()) ?? []) attempt(() => track.stop()); };

export function createTabLane({ env, deps = {}, timers, onChange, includeVideo = TAB_CAPTURE_INCLUDE_VIDEO } = {}) {
  let controller = null;

  // Steps 3-6 of 5.6.1, in this exact order. `run.cancelled` is re-checked after every await.
  async function acquire({ run, params }) {
    const { streamId, originalVolume } = params.tab;   // locals: never stored, logged or re-used
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

    // Still the same turn: the tab is already silent for the user, so the passthrough must start at once.
    // onEnded is registered BEFORE attach, so a track that ends during the resume wait is noticed.
    const graph = createTabAudioGraph({ env, timers });
    run.graph = graph;
    graph.onEnded(() => { void controller.stop({ error: 'TAB_ENDED' }); });
    await graph.attach(raw, { originalVolume });
    if (run.cancelled) throw codedError('START_CANCELLED');
    // A volume edit that arrived while the resume wait was pending had no gain node to act on yet.
    if (run.volume !== undefined) graph.setOriginalVolume(run.volume);
    if (graph.rawEnded()) throw codedError('TAB_ENDED');
    return { platform: createLanePlatform({ env, createPlatform: deps.createPlatform,
      getUserMedia: async () => graph.createEngineStream() }) };
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
