// New implementation of docs/extension.md §5.5, §5.6 (concurrency rules) and §5.7; no legacy code is ported.
// createLaneEngine: one isolated app config + one sim engine per lane run (D1). createLaneController: the start/stop
// state machine both lanes share (cancellation token per run, teardown order of 5.7), so the rules of 5.6 exist once
// and tab-lane.js / mic-lane.js only supply what differs (how the input stream is acquired and released).
// This is the ONLY module in which the API key is named: it goes straight from the lane's start parameters into the
// key store (setPersonal for a person's own key, setBuiltin for the built-in pool, §20) and is neither stored, logged
// nor echoed. Environment objects arrive by injection.
import { createAppConfig as realCreateAppConfig } from '../../app/config.js';
import { createSimEngine as realCreateSimEngine } from '../../app/engine/sim.js';
import { liveVoicePreference as realLiveVoicePreference } from '../../app/providers/gemini/live-config.js';
import { isMachineCode } from '../lib/constants.js';
import { LIMITS } from '../lib/protocol.js';
import { QUOTA_CODES, laneStateFromSnapshot } from '../lib/ui-state.js';

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

// §20: a built-in key that is REFUSED (not valid any more, revoked, restricted) says nothing about the other keys of
// the pool, so the lane moves on to the next one by itself, once per key, before it reports a failure. Two ways a
// refusal shows:
//  * the engine fails with one of these codes (a structured error the provider maps: INVALID_KEY for API_KEY_INVALID or
//    a 401, IP_DENIED, PERMISSION_DENIED for a 403);
//  * the Live socket closes with code 1007 or 1008 (observed 2026-10-02 with a made-up key against the real endpoint:
//    1007 "API key not valid. Please pass a valid API key."). The provider maps such a close to NETWORK_ERROR, which
//    the engine replaces three times with backoff and a backup model before it gives up with BUDGET_EXHAUSTED, the
//    same as a lost network. Only the socket's own close tells them apart, so the pool's sockets are watched.
// A close reason is at most 123 bytes, so the provider's longer refusals arrive cut short (an API restriction names
// the whole method before its "are blocked", an IP restriction the address, a disabled API the project and a link):
// the text alone cannot be relied on. The signal is the MOMENT: a 1007 or 1008 close before the socket's
// setupComplete is a refused key, unless its reason is one the provider gives a meaning of its own (a quota, an
// outage, a model it does not serve: normalizeGeminiLiveClose, which the engine answers with a key swap, a retry or
// the backup model) or one that blames the request, not the key. The reason patterns are the second signal and count
// at any time; each is a prefix or a phrase that fits in 123 bytes. The reason text is matched in the listener and
// dropped there; only a machine code leaves it. Phrasings other than the observed 1007 are assumptions (A31).
const KEY_REFUSAL_CODES = Object.freeze(['INVALID_KEY', 'PERMISSION_DENIED', 'IP_DENIED']);
const REFUSAL_CLOSE_CODES = Object.freeze([1007, 1008]);
const INVALID_KEY_REASON = /^(?:API key not valid|API key expired|API_KEY_INVALID)\b/i;
const IP_DENIED_REASON = /^API_KEY_IP_ADDRESS_BLOCKED\b|\bIP address restriction\b/i;
// A permission refusal, an API or referrer restriction ("Requests to this API … are blocked"), a disabled API ("…
// has not been used in project … or it is disabled").
const DENIED_REASON = Object.freeze([/^(?:PERMISSION_DENIED|Permission denied|The caller does not have permission)\b/i,
  /^Requests (?:from|to)\b/i, /^API_KEY_(?:SERVICE|HTTP_REFERRER|ANDROID_APP|IOS_APP)_BLOCKED\b/i,
  /\bhas not been used in project\b/i, /\bis disabled\b/i]);
// Never a refused key: the meanings normalizeGeminiLiveClose (app/providers/gemini/errors.js) gives a reason, copied
// because the engine directory may not import that module (tests/extension-lanes.test.mjs compares the two), and the
// provider's words for a malformed request.
const NOT_A_KEY_REASON = Object.freeze([/^(?:RESOURCE_EXHAUSTED|429)(?:\b|:)/i, /^exceeded your current quota\b/i,
  /^(?:UNAVAILABLE|503)(?:\b|:)/i, /^MODEL_NOT_SUPPORTED(?:\b|:)/,
  /^models?\b[^\r\n]{0,90}\b(?:not found|not supported|deprecated|retired)\b/i,
  /^(?:INVALID_ARGUMENT\b|Invalid JSON payload\b|Request contains an invalid argument\b|Invalid argument\b)/i]);
/**
 * refusalOfClose({ code, reason }, setUp) -> 'INVALID_KEY' | 'IP_DENIED' | 'PERMISSION_DENIED' | null: whether a close
 * of a pool socket says that its key was refused. `setUp` = the socket had received its setupComplete.
 */
export function refusalOfClose(event, setUp) {
  const code = attempt(() => event.code);
  if (!REFUSAL_CLOSE_CODES.includes(code)) return null;
  const reason = attempt(() => event.reason);
  const text = typeof reason === 'string' ? reason : '';
  if (INVALID_KEY_REASON.test(text)) return 'INVALID_KEY';
  if (IP_DENIED_REASON.test(text)) return 'IP_DENIED';
  if (DENIED_REASON.some((pattern) => pattern.test(text))) return 'PERMISSION_DENIED';
  if (setUp === true || NOT_A_KEY_REASON.some((pattern) => pattern.test(text))) return null;
  return code === 1007 ? 'INVALID_KEY' : 'PERMISSION_DENIED';
}
// Whether a server message is the setupComplete. Only messages before it are read, and it is a few bytes long, so a
// larger message (or a Blob, which cannot be read here at once) is not it.
const SETUP_COMPLETE = /"setupComplete"\s*:/;
const SETUP_SCAN_BYTES = 4096;
function isSetupComplete(data) {
  if (typeof data === 'string') return data.length <= SETUP_SCAN_BYTES && SETUP_COMPLETE.test(data);
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  return bytes !== null && bytes.byteLength <= SETUP_SCAN_BYTES && SETUP_COMPLETE.test(new TextDecoder().decode(bytes));
}
// The WebSocket class the pool's config is built with: the real one, plus a message and a close listener registered
// before the Live client's own. A class without a constructor of its own (a test double that is not a function) is
// left alone.
function watchedSocket(Base, onRefusal) {
  if (typeof Base !== 'function') return Base;
  return class extends Base {
    constructor(...args) {
      super(...args);
      let setUp = false;
      attempt(() => this.addEventListener('message', (event) => {
        if (!setUp) setUp = attempt(() => isSetupComplete(event.data)) === true;
      }));
      attempt(() => this.addEventListener('close', (event) => {
        const code = refusalOfClose(event, setUp);
        if (code !== null) onRefusal(code);
      }));
    }
  };
}

// The key store remembers which built-in keys hit a quota (fingerprints and times, never a key) through a
// localStorage-shaped object, so a later start does not open a session on a key that was just refused. Extension code
// never uses localStorage (R11), and the store had none here: a quota cooldown was forgotten with its run. This
// in-memory stand-in, ONE per offscreen document and shared by both lanes and every run, keeps that record while the
// document lives (§20). It holds the cooldown record only: any other name reads as absent and is never written.
const COOLDOWN_RECORD = /^interp-app\.builtin-cooldown\.v\d+$/;
export function createKeyCooldownMemory() {
  const records = new Map();
  return Object.freeze({
    getItem: (name) => (COOLDOWN_RECORD.test(String(name)) && records.has(name) ? records.get(name) : null),
    setItem: (name, value) => { if (COOLDOWN_RECORD.test(String(name)) && typeof value === 'string') records.set(name, value); },
    removeItem: (name) => { records.delete(name); },
  });
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/**
 * `platform` is the lane's own capture platform (platform-shim.js); `onChange()` is called on every engine
 * notification and whenever the input level changes. `env` is the host env (AudioContext, WebSocket, fetch and the
 * ENGINE clock). `cooldowns` is the document's createKeyCooldownMemory() (optional). start() is synchronous like the
 * engine's own and throws Error{code} after cleaning up.
 */
export function createLaneEngine({ lane, deps = {}, env, platform, onChange, cooldowns = null } = {}) {
  const { createAppConfig, createSimEngine, liveVoicePreference } = { ...REAL_DEPS, ...deps };
  let config = null, engine = null, playback = null, unsubscribe = null, closing = null;
  let level = 0, final = null;
  // §20, the built-in pool. `serial` names the engine run that is the lane's (a key switch starts another one on the
  // same engine, capture platform and config); `switching` covers the switch; `ran` = a run of this start reached
  // running; `refused` = the machine code of a refusal no spare key could answer (what the lane then reports).
  let pool = false, serial = 0, switching = false, ran = false, refused = null, ended = false;
  let outer = null, launchArgs = null, mutedNow = false;

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

  // ---------------------------------------------------------------------------------------------
  // §20, the built-in pool (modelled on app/main.js swapBuiltinKey / canSwapBuiltinKey). A quota failure (429 family)
  // moves the pool to its next key and the engine reconnects on it at once, without a stop: the calm "reconnecting".
  const keyMeta = () => attempt(() => config.keyStore.getMetadata('gemini', 'personal')) ?? null;
  async function swapBuiltinKey(error) {
    if (ended || !QUOTA_CODES.includes(error?.code) || keyMeta()?.builtin !== true) return false;
    return (attempt(() => config.keyStore.rotateBuiltin('gemini', { code: error.code })) ?? null) !== null;
  }
  // Asked at the close itself: only a spare that is not cooling down may show the calm reconnect of a swap.
  function canSwapBuiltinKey(error) {
    if (ended || !QUOTA_CODES.includes(error?.code)) return false;
    const meta = keyMeta();
    return meta?.builtin === true && meta.builtinSpare === true;
  }

  // One engine run of this start. Its end is the lane's end unless a key switch replaced it (the serial moved on).
  function launch({ restart = false } = {}) {
    const id = ++serial;
    const { request, sessionId } = launchArgs;
    const handle = engine.start({ targetLanguage: request.targetLanguage, model: request.model,
      ...(request.languages === undefined ? {} : { languages: request.languages }),
      ...(mutedNow ? { muted: true } : {}) },
    { providerId: 'gemini', keySource: 'personal', sessionId, ...(restart ? { restart: true } : {}) });
    handle.done.then((result) => settleRun(id, result), () => settleRun(id, undefined));
    return handle;
  }

  async function settleRun(id, result) {
    if (id !== serial) return;   // a run that a key switch replaced
    if (pool && !ended && result?.status === 'failed' && KEY_REFUSAL_CODES.includes(result.errorCode)
      && (await switchKey(id, result.errorCode))) return;
    outer?.resolve(result);
  }

  // A refused built-in key: end this run and start the same request again on the next key of the pool, at once and
  // with a fresh budget. rotateBuiltin without a quota code benches the refused key for the rest of this start, so each
  // key is tried at most once. No spare left: the run ends and the lane reports the refusal itself.
  async function switchKey(id, code) {
    if (id !== serial || switching || ended || !engine) return false;
    switching = true;
    serial += 1;   // the refused run's end is not the lane's end
    changed();
    try {
      await attemptAsync(() => engine.stop());
      if (ended || !engine) return false;
      const next = keyMeta()?.builtin === true ? attempt(() => config.keyStore.rotateBuiltin('gemini')) ?? null : null;
      if (next === null) {
        refused = code;
        outer?.resolve(attempt(() => engine.snapshot()));
        return true;
      }
      await attemptAsync(() => playback?.close());   // the next run creates its own playback context
      playback = null;
      if (ended || !engine) return false;
      try { launch({ restart: true }); } catch (error) {
        refused = codeOf(error);
        outer?.resolve(attempt(() => engine.snapshot()));
      }
      return true;
    } finally {
      switching = false;
      changed();
    }
  }

  function onKeyRefused(code) {
    if (!pool || ended || switching || !engine) return;
    const id = serial;
    // After the Live client has handled the same close event: the switch then stops a run that already knows.
    void Promise.resolve().then(() => switchKey(id, code));
  }

  // What the lane shows (§20): a key switch reads as the start or the calm key reconnect it is, never as the failure or
  // the stop of the refused run; a refusal no spare could answer reads as that refusal, whatever the run ended with.
  function presented(value) {
    if (value === null || value === undefined) return value;
    if (switching) {
      return Object.freeze({ ...value, status: ran ? 'reconnecting' : 'connecting', reconnectReason: ran ? 'key' : null,
        errorCode: null, errorReason: null });
    }
    if (refused !== null && ['failed', 'stopped', 'idle'].includes(value.status)) {
      return Object.freeze({ ...value, status: 'failed', errorCode: refused, errorReason: null });
    }
    return value;
  }

  async function shutdown() {
    const running = { engine, config, playback, unsubscribe };
    let result;
    // 1. The engine: capture cancelled, uplink and player stopped, the Live session physically closed.
    result = await attemptAsync(() => running.engine?.stop());
    final = attempt(() => running.engine?.snapshot()) ?? final;
    attempt(() => running.unsubscribe?.());
    outer?.resolve(result);   // a key switch may have been between two runs: the lane's end is now
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
    ended = true;
    closing = shutdown().finally(() => { closing = null; });
    return closing;
  }

  return Object.freeze({
    /**
     * `key` (a person's own) or `keys` (§20: the built-in pool) are the only references to an API key in the whole
     * host. Returns { ready, done }: `done` settles when the lane's run ends, not when a key switch replaces one run
     * with the next. NO sourceLanguage (always auto) and NO signal (the lane owns cancellation). `request.languages`
     * (a two-way pair) goes to the engine unchanged and only when the request has one; the engine then runs the lane
     * on an instruction-driven model (it moves a translation-only `request.model` there itself, and reports the model
     * it really uses in its snapshot, which is what the lane's state shows).
     */
    start({ key, keys, request, voiceGender, muted, sessionId } = {}) {
      if (engine || closing) throw codedError('ALREADY_RUNNING');
      final = null; level = 0;
      pool = Array.isArray(keys); serial = 0; switching = false; ran = false; refused = null; ended = false;
      mutedNow = muted === true; launchArgs = { request, sessionId };
      try {
        // A person's key: exactly as before (no socket watch, no cooldown record, no fallback to the pool).
        config = createAppConfig({ isolated: true, fetch: env.fetch,
          WebSocket: pool ? watchedSocket(env.WebSocket, onKeyRefused) : env.WebSocket,
          ...(pool && cooldowns ? { storage: cooldowns } : {}) });
        if (pool) config.keyStore.setBuiltin('gemini', keys); else config.keyStore.setPersonal('gemini', key);
        config.keyStore.select('gemini', 'personal');
        // A module-level singleton shared by both lanes of this realm (D1): a change only affects later sessions.
        liveVoicePreference.set({ gender: voiceGender });
        engine = createSimEngine({ router: config.router, sessionManager: config.sessionManager, platform,
          getAudioContext, resolveFallback: config.resolveFallback('gemini', 'live'), onLevel, ...clock,
          ...(pool ? { swapCredential: swapBuiltinKey, canSwapCredential: canSwapBuiltinKey } : {}) });
        unsubscribe = engine.subscribe((value) => { if (value?.status === 'running') ran = true; changed(); });
        outer = deferred();
        const handle = launch();
        return Object.freeze({ ready: handle.ready, done: outer.promise });
      } catch (error) {
        const code = codeOf(error);
        ended = true;
        closing = shutdown().finally(() => { closing = null; });   // config.dispose() is issued now; the caller only needs the code
        throw codedError(code);
      }
    },

    stop,
    setMuted(muted) { mutedNow = Boolean(muted); attempt(() => engine?.setMuted(mutedNow)); },
    resumeAudio() {
      return Promise.resolve(attempt(() => engine?.resumeAudio()) ?? false).then((value) => value === true, () => false);
    },
    /** The live engine snapshot, or the frozen last one after stop(); null before the first start. */
    snapshot() { return presented(engine ? engine.snapshot() : final); },
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
 * `params` is the validated host/lane-start message plus the host-assigned `epoch`. `cooldowns` is the document's
 * shared createKeyCooldownMemory() (§20), handed to every lane engine this controller creates.
 */
export function createLaneController({ lane, env, deps = {}, timers, onChange, acquire, release = async () => {},
  cooldowns = null } = {}) {
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
      const created = createLaneEngine({ lane, deps, env, platform, onChange: () => emit('data'), cooldowns });
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
