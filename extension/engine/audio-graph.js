// New implementation of docs/extension.md §5.3; no legacy code is ported.
// The tab audio graph (D3). Capturing a tab silences the tab for the user, so the raw capture stream is played
// back through a GainNode at the chosen "original volume" and, in parallel, copied into one synthetic stream per
// engine start (the engine's capture stops the tracks it is given, so it must never receive the raw ones).
// Environment objects arrive by injection; importing this module touches no global.

/** How long attach() waits for the graph context to leave `suspended` before it reports TAB_AUDIO_BLOCKED. */
export const RESUME_TIMEOUT_MS = 1500;
/**
 * §22: the level of the keep-alive a relayed tab's graph adds to its output (about -120 dBFS, far below hearing). Chrome
 * renders a context whose output is all zeros slower than real time after a while (measured 2026-09-30 for the capture
 * worklet: half the audio lost; the 2026-10-08 relay spike needed a ±2^-20 output for the same reason), and the engine's
 * copy of the tab is then fed slowly too. A relayed tab's graph outputs only zeros whenever the tab is silent, or always
 * when it is not played back (passthrough off, or the original volume at 0), so it keeps a constant 2^-20 on its
 * destination. The stream-id and §19 paths are left as they were (not measured here).
 */
export const KEEP_ALIVE_LEVEL = 2 ** -20;

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const percentOf = (value) => (Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null);
const stopTracks = (stream) => { for (const track of attempt(() => stream.getTracks()) ?? []) attempt(() => track.stop()); };

export function createTabAudioGraph({ env, timers } = {}) {
  const handlers = new Set();
  const engineStreams = new Map();   // synthetic stream -> its destination node
  const listened = [];               // [track, listener] pairs installed by attach()
  let context = null, source = null, gain = null, keeper = null, rawTracks = [];
  let attachStarted = false, attached = false, stopped = false, endedFired = false, volume = 0, passthrough = true;
  let stopPromise = null, cancelAttach = null;

  function fireEnded() {
    if (endedFired || stopped) return;
    endedFired = true;
    for (const handler of [...handlers]) attempt(handler);
  }

  function applyVolume() {
    if (!gain) return;
    const target = volume / 100;
    const param = gain.gain;
    if (typeof param?.setTargetAtTime === 'function') {
      attempt(() => param.setTargetAtTime(target, context.currentTime, 0.02));
    } else attempt(() => { param.value = target; });
  }

  // Resolves 'running' | 'timeout' | 'cancelled' | 'failed'; never rejects and always clears its timer. resume() is
  // called synchronously (the executor runs at once), so it stays in the task that received the tab stream.
  function waitForRunning() {
    return new Promise((resolve) => {
      let timer;
      const finish = (verdict) => { timers.clearTimeout(timer); cancelAttach = null; resolve(verdict); };
      cancelAttach = () => finish('cancelled');
      timer = timers.setTimeout(() => finish('timeout'), RESUME_TIMEOUT_MS);
      let resumed;
      try { resumed = Promise.resolve(context.resume()); } catch { finish('failed'); return; }
      resumed.then(() => finish('running'), () => finish('failed'));
    });
  }

  async function stopNow() {
    stopped = true;
    cancelAttach?.();
    // 1. Raw tracks first: this removes the capture indicator and hands the tab's own audio back to the user.
    for (const track of rawTracks) attempt(() => track.stop());
    for (const [track, listener] of listened.splice(0)) attempt(() => track.removeEventListener('ended', listener));
    // 2. Then the nodes. Each disconnect is independent: one failing never blocks the next.
    for (const node of [...engineStreams.values()]) attempt(() => node.disconnect());
    engineStreams.clear();
    attempt(() => source?.disconnect());
    attempt(() => gain?.disconnect());
    attempt(() => keeper?.stop());
    attempt(() => keeper?.disconnect());
    // 3. Last the context. A rejected close (already closed) is swallowed.
    if (context) await Promise.resolve().then(() => context.close()).catch(() => {});
    attached = false;
    handlers.clear();
  }

  return Object.freeze({
    /** Fires once when a raw track ends (tab closed, capture revoked). Register it BEFORE attach(). */
    onEnded(fn) {
      if (typeof fn !== 'function') throw codedError('INVALID_REQUEST');
      if (endedFired) { attempt(fn); return () => {}; }
      handlers.add(fn);
      return () => { handlers.delete(fn); };
    },

    /**
     * Must be called in the same task in which getUserMedia resolved: the tab is already silent for the user, so
     * the passthrough has to start at once. Rejects Error{code:'TAB_AUDIO_BLOCKED'} when the graph context does not
     * reach `running` (the raw tracks are stopped first, restoring the tab's audio) and Error{code:'START_CANCELLED'}
     * when stop() ran before or during the wait (nothing is created after a stop).
     * `passthrough: false` (§19) is for a capture that did NOT silence the tab: the tab is still heard by itself, so
     * playing it back here would double it. The gain then stays at 0 whatever the volume setting says.
     * `keepAlive: true` (§22, the relayed tab) adds a KEEP_ALIVE_LEVEL constant to the destination, never to the
     * engine's copy; a context without ConstantSourceNode simply goes without it.
     */
    async attach(raw, { originalVolume = 100, passthrough: play = true, keepAlive = false } = {}) {
      if (attachStarted) throw codedError('INVALID_REQUEST');
      attachStarted = true;
      if (stopped) { stopTracks(raw); throw codedError('START_CANCELLED'); }
      // First act, synchronously: watch the raw tracks, so an `ended` during the resume wait is never missed.
      rawTracks = attempt(() => raw.getAudioTracks()) ?? [];
      for (const track of rawTracks) {
        const listener = () => { if (rawTracks.every((item) => item.readyState === 'ended')) fireEnded(); };
        attempt(() => track.addEventListener('ended', listener));
        listened.push([track, listener]);
      }
      if (rawTracks.every((track) => track.readyState === 'ended')) fireEnded();
      passthrough = play !== false;
      volume = passthrough ? percentOf(originalVolume) ?? 100 : 0;
      try {
        context = new env.AudioContext();
        source = context.createMediaStreamSource(raw);
        gain = context.createGain();
        gain.gain.value = volume / 100;
        source.connect(gain);
        gain.connect(context.destination);
        if (keepAlive === true) {
          keeper = attempt(() => context.createConstantSource()) ?? null;
          const running = keeper !== null && attempt(() => {
            keeper.offset.value = KEEP_ALIVE_LEVEL;
            keeper.connect(context.destination);
            keeper.start();
            return true;
          }) === true;
          if (!running) { attempt(() => keeper?.disconnect()); keeper = null; }
        }
      } catch {
        const cancelled = stopped;
        stopPromise ??= stopNow();
        await stopPromise;
        throw codedError(cancelled ? 'START_CANCELLED' : 'TAB_AUDIO_BLOCKED');
      }
      const verdict = await waitForRunning();
      if (stopped) throw codedError('START_CANCELLED');
      if (verdict !== 'running' || context.state !== 'running') {
        stopPromise ??= stopNow();
        await stopPromise;
        throw codedError('TAB_AUDIO_BLOCKED');
      }
      attached = true;
      return undefined;
    },

    /** A NEW MediaStreamAudioDestinationNode stream per call: the engine's capture stops the track it gets. */
    createEngineStream() {
      if (!attached || stopped) throw codedError('INVALID_REQUEST');
      const node = context.createMediaStreamDestination();
      source.connect(node);
      engineStreams.set(node.stream, node);
      return node.stream;
    },

    releaseEngineStream(stream) {
      const node = engineStreams.get(stream);
      if (!node) return;
      engineStreams.delete(stream);
      attempt(() => source.disconnect(node));
      attempt(() => node.disconnect());
    },

    setOriginalVolume(percent) {
      const next = percentOf(percent);
      if (next === null || !passthrough) return;
      volume = next;
      applyVolume();
    },

    /** True when every raw audio track is already 'ended' (or there is none). */
    rawEnded() { return rawTracks.every((track) => track.readyState === 'ended'); },

    /** Idempotent, safe before attach and DURING attach (which then rejects START_CANCELLED). */
    stop() {
      stopPromise ??= stopNow();
      return stopPromise;
    },

    snapshot() { return Object.freeze({ attached, contextState: context?.state ?? 'none', volume, passthrough }); },
  });
}
