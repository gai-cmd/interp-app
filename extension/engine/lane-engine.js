// New implementation of docs/extension.md §5.5, §5.6 (concurrency rules) and §5.7; no legacy code is ported.
// createLaneEngine: one isolated app config + one sim engine per lane run (D1). createLaneController: the start/stop
// state machine both lanes share (cancellation token per run, teardown order of 5.7), so the rules of 5.6 exist once
// and tab-lane.js / mic-lane.js only supply what differs (how the input stream is acquired and released).
// This is the ONLY module in which the API key is named: it goes straight from the lane's start parameters into
// keyStore.setPersonal and is neither stored, logged nor echoed. Environment objects arrive by injection.
import { createAppConfig as realCreateAppConfig } from '../../app/config.js';
import { createSimEngine as realCreateSimEngine } from '../../app/engine/sim.js';
import { liveVoicePreference as realLiveVoicePreference } from '../../app/providers/gemini/live-config.js';
import { isMachineCode } from '../lib/constants.js';
import { LIMITS } from '../lib/protocol.js';
import { laneStateFromSnapshot } from '../lib/ui-state.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// Awaits fn() and swallows its failure: every teardown step of 5.7 is independent of the one before it.
const attemptAsync = async (fn) => { try { return await fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
// Machine codes only: an exception's own message (which could hold provider text) never leaves this module.
const codeOf = (error) => (isMachineCode(attempt(() => error?.code)) ? error.code : 'INTERNAL');

const REAL_DEPS = Object.freeze({
  createAppConfig: realCreateAppConfig,
  createSimEngine: realCreateSimEngine,
  liveVoicePreference: realLiveVoicePreference,
});
// LEVEL_FULL_SCALE_RMS of the web app: an rms of 0.25 reads as a full meter.
const LEVEL_FULL_SCALE_RMS = 0.25;
const PLAYBACK_SAMPLE_RATE = 24000;

/**
 * `platform` is the lane's own capture platform (platform-shim.js); `onChange()` is called on every engine
 * notification and whenever the input level changes. `env` is the host env (AudioContext, WebSocket, fetch and the
 * ENGINE clock). start() is synchronous like the engine's own and throws Error{code} after cleaning up.
 */
export function createLaneEngine({ lane, deps = {}, env, platform, onChange } = {}) {
  const { createAppConfig, createSimEngine, liveVoicePreference } = { ...REAL_DEPS, ...deps };
  let config = null, engine = null, playback = null, unsubscribe = null, closing = null;
  let level = 0, final = null;

  const changed = () => attempt(() => onChange?.());
  // The engine clock. Arrow wrappers, so a native timer function is never called with a foreign `this`.
  const clock = {
    now: () => env.now(),
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    clearTimeout: (id) => env.clearTimeout(id),
    random: () => env.random(),
  };

  // The lane's OWN playback context, never shared with the other lane or with the passthrough graph:
  // engine.setMuted(true) suspends whatever this returns (hard mute) and would silence anything else on it.
  function getAudioContext() {
    let created;
    try { created = new env.AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE }); } catch { created = new env.AudioContext(); }
    playback = created;
    return created;
  }

  function onLevel(value) {
    const rms = value?.rms;
    const next = Number.isFinite(rms) ? Math.min(100, Math.round(rms / LEVEL_FULL_SCALE_RMS * 100)) : 0;
    if (next === level) return;
    level = next;
    changed();
  }

  async function shutdown() {
    const running = { engine, config, playback, unsubscribe };
    let result;
    // 1. The engine: capture cancelled, uplink and player stopped, the Live session physically closed.
    result = await attemptAsync(() => running.engine?.stop());
    final = attempt(() => running.engine?.snapshot()) ?? final;
    attempt(() => running.unsubscribe?.());
    // 2. Then the engine, the config (key store, session manager) and the playback context, in that order.
    await attemptAsync(() => running.engine?.close());
    await attemptAsync(() => running.config?.dispose());
    await attemptAsync(() => running.playback?.close());
    engine = null; config = null; playback = null; unsubscribe = null; level = 0;
    return result;
  }

  /** Resolves with the engine's last result (or undefined). Capture, session, engine, config and playback are released. */
  function stop() {
    if (closing) return closing;
    if (!engine) return Promise.resolve(undefined);
    closing = shutdown().finally(() => { closing = null; });
    return closing;
  }

  return Object.freeze({
    /**
     * `key` is the only reference to the API key in the whole host. Returns the engine's { ready, done }.
     * NO sourceLanguage (always auto) and NO signal (the lane owns cancellation). `request.languages` (a two-way pair)
     * goes to the engine unchanged and only when the request has one; the engine then runs the lane on an
     * instruction-driven model (it moves a translation-only `request.model` there itself, and reports the model it
     * really uses in its snapshot, which is what the lane's state shows).
     */
    start({ key, request, voiceGender, muted, sessionId } = {}) {
      if (engine || closing) throw codedError('ALREADY_RUNNING');
      final = null; level = 0;
      try {
        config = createAppConfig({ isolated: true, WebSocket: env.WebSocket, fetch: env.fetch });
        config.keyStore.setPersonal('gemini', key);
        config.keyStore.select('gemini', 'personal');
        // A module-level singleton shared by both lanes of this realm (D1): a change only affects later sessions.
        liveVoicePreference.set({ gender: voiceGender });
        engine = createSimEngine({ router: config.router, sessionManager: config.sessionManager, platform,
          getAudioContext, resolveFallback: config.resolveFallback('gemini', 'live'), onLevel, ...clock });
        unsubscribe = engine.subscribe(changed);
        const handle = engine.start({ targetLanguage: request.targetLanguage, model: request.model,
          ...(request.languages === undefined ? {} : { languages: request.languages }),
          ...(muted ? { muted: true } : {}) }, { providerId: 'gemini', keySource: 'personal', sessionId });
        return Object.freeze({ ready: handle.ready, done: handle.done });
      } catch (error) {
        const code = codeOf(error);
        closing = shutdown().finally(() => { closing = null; });   // config.dispose() is issued now; the caller only needs the code
        throw codedError(code);
      }
    },

    stop,
    setMuted(muted) { attempt(() => engine?.setMuted(Boolean(muted))); },
    resumeAudio() {
      return Promise.resolve(attempt(() => engine?.resumeAudio()) ?? false).then((value) => value === true, () => false);
    },
    /** The live engine snapshot, or the frozen last one after stop(); null before the first start. */
    snapshot() { return engine ? engine.snapshot() : final; },
    level: () => level,
    dispose: stop,
    get lane() { return lane; },
  });
}

// ---------------------------------------------------------------------------------------------
// The state machine both lanes share (5.6, 5.7).

const ACTIVE_PHASES = Object.freeze(['starting', 'running', 'reconnecting']);

const TERMINAL_STATUSES = Object.freeze(['idle', 'stopped', 'failed']);

// What stays of an engine snapshot once its run is over: enough for LaneState (status, error and its reason, model), no captions.
// A run that is over is never `running` any more, whatever a snapshot taken from a wedged engine still says.
function slimSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  const status = TERMINAL_STATUSES.includes(snapshot.status) ? snapshot.status : 'stopped';
  return Object.freeze({ status, errorCode: snapshot.errorCode ?? null, errorReason: snapshot.errorReason ?? null,
    retries: snapshot.retries ?? 0,
    model: snapshot.model ?? null, route: snapshot.route ?? null, fallback: snapshot.fallback === true,
    output: null, captions: null, skippedSegments: Object.freeze([]) });
}

/**
 * `acquire({ run, params })` performs the lane-specific steps before the engine exists and returns { platform };
 * it must check `run.cancelled` after every await and may keep its own resources on `run` (e.g. `run.graph`).
 * A step that can wait on the user for a long time (Chrome's share picker, §19) races `run.cancelSignal`, a promise
 * that resolves when the run is cancelled, so a Stop never has to wait for the dialog. `acquire` may also return
 * `tabId` (an integer or null): the tab the lane really captures, when only the acquisition can know it.
 * `release(run)` is the lane-specific teardown step (5.7 step 3). Both may throw Error{code}.
 * `params` is the validated host/lane-start message plus the host-assigned `epoch`.
 */
export function createLaneController({ lane, env, deps = {}, timers, onChange, acquire, release = async () => {} } = {}) {
  // `languages` = the two-way pair of the current run (null for a one-way run): it decides how caption rows are labelled.
  const facts = { tabId: null, epoch: 0, targetLanguage: null, languages: null, hostError: null, stopRequested: false,
    starting: false, stopping: false };
  let run = null, engineLane = null, cached = null, muted = true;

  const emit = (reason = 'data') => attempt(() => onChange?.(reason));
  const snapshot = () => (engineLane ? engineLane.snapshot() : cached);
  const level = () => (engineLane ? engineLane.level() : 0);
  const phase = () => laneStateFromSnapshot({ lane, snapshot: snapshot(), facts, level: level() }).phase;

  // Resolves when the promise settles OR after ms of the injected clock, whichever is first; never rejects.
  const settleWithin = (promise, ms) => new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, ms);
    promise.then(() => { timers.clearTimeout(timer); resolve(); }, () => { timers.clearTimeout(timer); resolve(); });
  });

  // The one place a run is marked cancelled: the flag every await re-checks, and the signal a long wait races.
  function cancelRun(current) {
    current.cancelled = true;
    current.signalCancel();
  }

  // 5.7 steps 1-3. `quiet` = the lane ended by itself (engine failed): the state keeps showing the engine's own
  // verdict instead of a transient `stopping`.
  function releaseResources(current, { quiet = false } = {}) {
    current.resources ??= (async () => {
      if (!quiet) { facts.stopping = true; facts.starting = false; emit('phase'); }
      await attemptAsync(() => engineLane?.stop());
      await attemptAsync(() => release(current));
    })();
    return current.resources;
  }

  // 5.7 step 5's second half: the lane settles. Memoized, so a start's own cleanup and a public stop() may both call it.
  function finalize(current) {
    current.finalized ??= (async () => {
      await current.resources;
      facts.stopping = false; facts.starting = false;
      if (current.error) facts.hostError = current.error;
      if (run === current) {
        cached = slimSnapshot(engineLane?.snapshot());
        engineLane = null;
        run = null;
      }
      emit('phase');
    })();
    return current.finalized;
  }

  // The internal teardown of a start that cannot go on: 5.7 steps 1-4 and 6, NOT the wait for the start itself
  // (the start calls it from inside its own promise; waiting would deadlock).
  function abandon(current, { error } = {}) {
    cancelRun(current);
    if (error !== undefined) current.error ??= error;
    return releaseResources(current).then(() => finalize(current));
  }

  async function begin(current, params) {
    try {
      const { platform, tabId } = await acquire({ run: current, params });
      if (current.cancelled) throw codedError('START_CANCELLED');
      // §19: a share-picker start learns here which tab the user chose (null: it could not be told).
      if (tabId !== undefined) { facts.tabId = tabId; current.identified = true; }
      const created = createLaneEngine({ lane, deps, env, platform, onChange: () => emit('data') });
      engineLane = created;
      // The key travels inside `params` untouched: only the lane engine names it. `muted` is the newest value: a
      // mute toggled while this start was still acquiring its input has nothing to act on yet, so it is applied here.
      const handle = created.start({ ...params, muted, sessionId: `${lane}-${current.epoch}` });
      facts.starting = false;
      attempt(() => handle.ready.catch(() => {}));
      handle.done.then(() => onEngineDone(current), () => onEngineDone(current));
      emit('phase');
      return Object.freeze({ epoch: current.epoch, ...(current.identified ? { tabId: facts.tabId } : {}) });
    } catch (error) {
      const code = current.error ?? (current.cancelled ? 'START_CANCELLED' : codeOf(error));
      await abandon(current, code === 'START_CANCELLED' ? {} : { error: code });
      throw codedError(code);
    } finally {
      current.startPending = false;
    }
  }

  // The engine ended without a stop() (failed, or stopped by a capture interruption): release everything, keep the
  // engine's verdict as the lane state (error code, or BROWSER_INTERRUPTED because `stopRequested` is false).
  function onEngineDone(current) {
    if (run !== current || current.cancelled) return;
    cancelRun(current);
    releaseResources(current, { quiet: true }).then(() => finalize(current));
  }

  function start(params) {
    if (run) return Promise.reject(codedError(run.cancelled ? 'LANE_STOPPING' : 'ALREADY_RUNNING'));
    const current = { epoch: params.epoch, cancelled: false, error: null, resources: null, finalized: null,
      startPending: true, startPromise: null, identified: false, cancelSignal: null, signalCancel: null };
    current.cancelSignal = new Promise((resolve) => { current.signalCancel = resolve; });
    run = current; cached = null; engineLane = null; muted = params.muted === true;
    Object.assign(facts, { tabId: params.tab?.tabId ?? null, epoch: params.epoch,
      targetLanguage: params.request.targetLanguage, languages: params.request.languages ?? null, hostError: null,
      stopRequested: false, starting: true, stopping: false });
    emit('phase');
    current.startPromise = begin(current, params);
    return current.startPromise;
  }

  /**
   * Valid in EVERY phase. Sets the run's cancel flag first, then tears down whatever exists (5.7), then waits (bounded
   * by LIMITS.startSettleMs) for an in-flight start to notice the flag and clean up what it created after the stop.
   * `error` = the lane ended for a reason of its own (TAB_ENDED): the lane settles in `error`, not `off`, and a start
   * that this stop overtakes rejects with that code instead of START_CANCELLED.
   */
  async function stop({ error } = {}) {
    const current = run;
    if (!current) return;
    cancelRun(current);
    if (error !== undefined) current.error ??= error; else facts.stopRequested = true;
    await releaseResources(current);
    if (current.startPending) await settleWithin(current.startPromise, LIMITS.startSettleMs);
    await finalize(current);
  }

  return Object.freeze({
    lane,
    start,
    stop,
    setMuted(value) {
      muted = value === true;
      engineLane?.setMuted(muted);
      if (!muted) engineLane?.resumeAudio();
    },
    setOriginalVolume() {},
    /** The code a start would be refused with right now (the lane is occupied), or null. Consumes nothing. */
    refusal: () => (run ? (run.cancelled ? 'LANE_STOPPING' : 'ALREADY_RUNNING') : null),
    phase,
    facts: () => Object.freeze({ ...facts }),
    snapshot,
    level,
    async dispose() { await stop(); },
    /** Internal seam for tab-lane.js (the run that owns the lane, holding its graph). */
    currentRun: () => run,
    isActive: () => ACTIVE_PHASES.includes(phase()),
  });
}
