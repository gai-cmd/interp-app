// New implementation of docs/extension.md §5.5, §5.6 (concurrency rules) and §5.7; no legacy code is ported.
// createLaneEngine: one isolated app config + one sim engine per lane run (D1). createLaneController: the start/stop
// state machine both lanes share (cancellation token per run, teardown order of 5.7), so the rules of 5.6 exist once
// and tab-lane.js / mic-lane.js only supply what differs (how the input stream is acquired and released).
// This is the ONLY module in which the API key is named: it goes straight from the lane's start parameters into the
// key store (setPersonal for a person's own key, setBuiltin for the built-in pool, §20) and is neither stored, logged
// nor echoed. Environment objects arrive by injection.
import { createAppConfig as realCreateAppConfig } from '../../app/config.js';
import { createSimEngine as realCreateSimEngine } from '../../app/engine/sim.js';
import { DEFAULT_LIVE_MODEL, liveVoicePreference as realLiveVoicePreference } from '../../app/providers/gemini/live-config.js';
import { isMachineCode } from '../lib/constants.js';
import { LATEST_LIVE, isAdoptable, listLiveModelIds, newestGeneralLive } from '../lib/latest-live.js';
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
// A refusal the REASON itself names (the key is not valid, its IP or API restriction, a disabled API): independent of the
// moment and of any guess. A socket that runs an ADOPTED model (§24) is only blamed on its key by this much, never by the
// guess below, so a model the provider does not accept can never burn the whole pool.
export function explicitRefusalOfClose(event) {
  const code = attempt(() => event.code);
  if (!REFUSAL_CLOSE_CODES.includes(code)) return null;
  const reason = attempt(() => event.reason);
  const text = typeof reason === 'string' ? reason : '';
  if (INVALID_KEY_REASON.test(text)) return 'INVALID_KEY';
  if (IP_DENIED_REASON.test(text)) return 'IP_DENIED';
  if (DENIED_REASON.some((pattern) => pattern.test(text))) return 'PERMISSION_DENIED';
  return null;
}
/**
 * refusalOfClose({ code, reason }, setUp) -> 'INVALID_KEY' | 'IP_DENIED' | 'PERMISSION_DENIED' | null: whether a close
 * of a pool socket says that its key was refused. `setUp` = the socket had received its setupComplete.
 */
export function refusalOfClose(event, setUp) {
  const explicit = explicitRefusalOfClose(event);
  if (explicit !== null) return explicit;
  const code = attempt(() => event.code);
  if (!REFUSAL_CLOSE_CODES.includes(code)) return null;
  const reason = attempt(() => event.reason);
  const text = typeof reason === 'string' ? reason : '';
  if (setUp === true || NOT_A_KEY_REASON.some((pattern) => pattern.test(text))) return null;
  return code === 1007 ? 'INVALID_KEY' : 'PERMISSION_DENIED';
}
// The close of a quota (429 family): the key swap handles it, so it says nothing about a model.
const QUOTA_REASON = Object.freeze([/^(?:RESOURCE_EXHAUSTED|429)(?:\b|:)/i, /^exceeded your current quota\b/i]);
const UNAVAILABLE_REASON = /^(?:UNAVAILABLE|503)(?:\b|:)/i;
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
// §24 (0.5.2): the latest general Live model. The engine below is closed over the repository's model list (the router, the
// session, the fallback chain all know DEFAULT_LIVE_MODEL and nothing newer), so the lane runs the newer model by ONE
// substitution at the wire: the `model` field of the first frame (the setup) of a socket. Everything the engine decides
// stays on the default model (its setup, its route, its fallback chain); the lane reports the model that really runs. The
// substitution is revocable: a socket of the adopted model that fails before its setupComplete (or within
// LATEST_LIVE.earlyCloseMs after it) makes the lane restart on the default model at once, for the rest of this start.
const SETUP_MODEL = `models/${DEFAULT_LIVE_MODEL}`;
function aliasedSetup(frame, model) {
  if (typeof frame !== 'string' || frame.length > 262144) return null;
  const parsed = attempt(() => JSON.parse(frame));
  if (parsed === null || typeof parsed !== 'object' || parsed.setup === null || typeof parsed.setup !== 'object' || parsed.setup.model !== SETUP_MODEL) return null;
  parsed.setup.model = `models/${model}`;
  // A setup that RESUMES a session (a goAway handover, a reconnect) carries a handle the provider may refuse on its own account.
  return { frame: JSON.stringify(parsed), resumed: typeof parsed.setup.sessionResumption?.handle === 'string' };
}
// How a close of a socket that ran the adopted model reads: the provider REFUSED it (1007/1008: not found, a setup field it
// does not take, a permission it does not give) or answered with a QUOTA (a new model may have a lower limit than the default:
// the same key then fails the default model differently, or not at all), or something transient happened (no answer, a dropped
// connection, an outage). The first two are remembered by the worker (the model is left alone for a while), the last is not.
const failureKindOf = (event) => {
  const code = attempt(() => event.code);
  const reason = attempt(() => event.reason);
  if (typeof reason === 'string' && QUOTA_REASON.some((pattern) => pattern.test(reason))) return 'rejected';
  return (code === 1007 || code === 1008) && !(typeof reason === 'string' && UNAVAILABLE_REASON.test(reason)) ? 'rejected' : 'transient';
};
/**
 * The WebSocket class a lane's config is built with: the real one, plus a message and a close listener registered before
 * the Live client's own. `hooks`: onRefusal(code) for the pool's refused keys (§20), `adoption` ({ model, revoked, applied }),
 * onAdoptionFailed(kind), onApplied(), now(), setTimeout / clearTimeout (the engine clock). A class without a constructor of its
 * own (a test double that is not a function) is left alone. Exported for tests/extension-latest-live.test.mjs.
 *
 * What a socket that runs the ADOPTED model learns from its end (§24):
 *  - before its setupComplete: a key the REASON itself names as invalid, or restricted by IP, is the key's fault (the pool moves
 *    on, the adopted model stays). Everything else is the model's: the default model gets its one attempt FIRST (a refusal in
 *    any wording, a permission or API wording, a quota: the same key may serve the default model), except a close that
 *    WE asked for (a Stop, a key switch, the engine giving up on its own run: it called close()) and a setup that resumed a
 *    session (a refused handle is the handle's fault: the engine's own retry without it comes first);
 *  - no setupComplete within LATEST_LIVE.setupWatchdogMs: the model stalls, the lane goes back to the default;
 *  - after its setupComplete: a quota or a refused key stays the key handling's; a close we did not ask for within
 *    LATEST_LIVE.earlyCloseMs with a code other than 1000 is the model's.
 */
export function laneSocket(Base, hooks) {
  if (typeof Base !== 'function') return Base;
  const { adoption = null } = hooks;
  const firstFrames = new WeakMap();   // socket -> the function that may rewrite its FIRST frame (the setup)
  const closing = new WeakSet();       // sockets whose close() somebody on our side called
  const Laned = class extends Base {
    constructor(...args) {
      super(...args);
      let setUp = false, setUpAt = 0, aliased = false, resumed = false, sentFirst = false, watchdog = null;
      const disarm = () => { if (watchdog !== null) { attempt(() => hooks.clearTimeout(watchdog)); watchdog = null; } };
      firstFrames.set(this, (frame) => {
        if (sentFirst) return frame;
        sentFirst = true;
        if (adoption === null || adoption.model === null || adoption.revoked) return frame;
        const replaced = aliasedSetup(frame, adoption.model);
        if (replaced === null) return frame;
        aliased = true;
        resumed = replaced.resumed;
        if (!adoption.applied) { adoption.applied = true; hooks.onApplied?.(); }
        watchdog = attempt(() => hooks.setTimeout(() => { watchdog = null; if (!setUp && !closing.has(this)) hooks.onAdoptionFailed('rejected'); }, LATEST_LIVE.setupWatchdogMs)) ?? null;
        return replaced.frame;
      });
      attempt(() => this.addEventListener('message', (event) => {
        if (!setUp && attempt(() => isSetupComplete(event.data)) === true) { setUp = true; setUpAt = hooks.now(); disarm(); }
      }));
      attempt(() => this.addEventListener('close', (event) => {
        disarm();
        if (!aliased) {
          const code = refusalOfClose(event, setUp);
          if (code !== null) hooks.onRefusal?.(code);
          return;
        }
        const explicit = explicitRefusalOfClose(event);
        if (!setUp) {
          if (explicit === 'INVALID_KEY' || explicit === 'IP_DENIED') { hooks.onRefusal?.(explicit); return; }
          if (!closing.has(this) && !resumed) hooks.onAdoptionFailed(failureKindOf(event));
          return;
        }
        if (explicit !== null) { hooks.onRefusal?.(explicit); return; }
        const reason = attempt(() => event.reason);
        if (typeof reason === 'string' && QUOTA_REASON.some((pattern) => pattern.test(reason))) return;
        if (!closing.has(this) && attempt(() => event.code) !== 1000 && hooks.now() - setUpAt < LATEST_LIVE.earlyCloseMs) hooks.onAdoptionFailed(failureKindOf(event));
      }));
    }
  };
  // Only a socket class that has a send of its own can be rewritten; any other class runs the default model as it always did.
  const baseSend = Base.prototype?.send;
  if (typeof baseSend === 'function') {
    Object.defineProperty(Laned.prototype, 'send', { configurable: true, writable: true,
      value(data) { return baseSend.call(this, attempt(() => firstFrames.get(this)?.(data)) ?? data); } });
  }
  const baseClose = Base.prototype?.close;
  if (typeof baseClose === 'function') {
    Object.defineProperty(Laned.prototype, 'close', { configurable: true, writable: true,
      value(...args) { closing.add(this); return baseClose.apply(this, args); } });
  }
  return Laned;
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
export function createLaneEngine({ lane, deps = {}, env, platform, onChange, onLatest = null, cooldowns = null } = {}) {
  const { createAppConfig, createSimEngine, liveVoicePreference } = { ...REAL_DEPS, ...deps };
  let config = null, engine = null, playback = null, unsubscribe = null, closing = null;
  let level = 0, final = null;
  // §20, the built-in pool. `serial` names the engine run that is the lane's (a key switch starts another one on the
  // same engine, capture platform and config); `switching` covers the switch; `ran` = a run of this start reached
  // running; `refused` = the machine code of a refusal no spare key could answer (what the lane then reports).
  let pool = false, serial = 0, switching = false, ran = false, refused = null, ended = false;
  let outer = null, launchArgs = null, mutedNow = false;
  // §24: the latest general Live model of this start. `model` = the id to run instead of the default (null: none),
  // `applied` = a socket really sent it, `revoked` = the provider refused it (or it failed at once) and the lane went back.
  let adoption = { model: null, revoked: false, applied: false };

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
  const switchKey = (id, code) => restartRun(id, { rotate: true, code });
  // The shared body of a key switch and of the fall back from an adopted model (§24, `rotate: false`): the same request,
  // the same key, a fresh run on the default model, at once and with a fresh budget.
  async function restartRun(id, { rotate, code }) {
    if (id !== serial || switching || ended || !engine) return false;
    switching = true;
    serial += 1;   // the replaced run's end is not the lane's end
    changed();
    try {
      await attemptAsync(() => engine.stop());
      if (ended || !engine) return false;
      const next = !rotate ? true : keyMeta()?.builtin === true ? attempt(() => config.keyStore.rotateBuiltin('gemini')) ?? null : null;
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

  // The adopted model did not work (§24): back to the default model for the rest of this start. A refusal by the provider is
  // reported (the worker then leaves that model alone for a while); a transient failure only costs this start.
  function onAdoptionFailed(kind) {
    if (adoption.revoked || adoption.model === null || ended || switching || !engine) return;
    adoption.revoked = true;
    if (kind === 'rejected') attempt(() => onLatest?.({ kind: 'rejected', model: adoption.model }));
    const id = serial;
    void Promise.resolve().then(() => restartRun(id, { rotate: false }));
  }

  function onKeyRefused(code) {
    if (!pool || ended || switching || !engine) return;
    const id = serial;
    // After the Live client has handled the same close event: the switch then stops a run that already knows.
    void Promise.resolve().then(() => switchKey(id, code));
  }

  // What the lane shows (§20): a key switch reads as the start or the calm key reconnect it is, never as the failure or
  // the stop of the refused run; a refusal no spare could answer reads as that refusal, whatever the run ended with.
  function presented(raw) {
    if (raw === null || raw === undefined) return raw;
    // The engine knows only the default model; the lane says which model really runs (§24).
    const value = adoption.applied && !adoption.revoked && adoption.model !== null && raw.model === DEFAULT_LIVE_MODEL
      ? Object.freeze({ ...raw, model: adoption.model }) : raw;
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
    start({ key, keys, request, latestModel = null, voiceGender, muted, sessionId } = {}) {
      if (engine || closing) throw codedError('ALREADY_RUNNING');
      final = null; level = 0;
      pool = Array.isArray(keys); serial = 0; switching = false; ran = false; refused = null; ended = false;
      mutedNow = muted === true; launchArgs = { request, sessionId };
      // §24: only a lane on the default model, and only an id that is a general Live model strictly newer than it.
      adoption = { model: request?.model === DEFAULT_LIVE_MODEL && isAdoptable(latestModel, DEFAULT_LIVE_MODEL) ? latestModel : null,
        revoked: false, applied: false };
      try {
        // A person's key: exactly as before (no socket watch, no cooldown record, no fallback to the pool).
        config = createAppConfig({ isolated: true, fetch: env.fetch,
          // A person's own key and no adopted model: the socket class as it is (exactly as before).
          WebSocket: pool || adoption.model !== null
            ? laneSocket(env.WebSocket, { adoption, onRefusal: pool ? onKeyRefused : null, onAdoptionFailed,
              onApplied: changed, now: () => env.now(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (handle) => clock.clearTimeout(handle) })
            : env.WebSocket,
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
export function createLaneController({ lane, env, deps = {}, timers, onChange, onLatest = null, acquire, release = async () => {},
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

  // §24: one look at the provider's model list, with the lane's own key (or the first keys of the pool). It reports what it
  // saw to the worker (ids only) and never throws. `blocking` waits for it, for at most LATEST_LIVE.blockMs.
  async function lookAtProvider(params) {
    const keys = (Array.isArray(params.keys) ? params.keys : [params.key]).filter((key) => typeof key === 'string').slice(0, LATEST_LIVE.maxKeyTries);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = timers.setTimeout(() => attempt(() => controller?.abort()), LATEST_LIVE.backgroundMs);
    try {
      for (const key of keys) {
        try {
          const ids = await listLiveModelIds({ fetch: env.fetch, key, ...(controller ? { signal: controller.signal } : {}) });
          const newest = newestGeneralLive(ids);
          attempt(() => onLatest?.({ kind: 'seen', newest }));
          return { seen: true, newest };
        } catch { if (controller?.signal.aborted) break; }
      }
      attempt(() => onLatest?.({ kind: 'failed' }));
      return { seen: false, newest: null };
    } finally { timers.clearTimeout(timer); }
  }

  // The model a start with `params.latest` runs instead of the default (null: the default). A record that says `none` is
  // trusted as it is; `background` runs on the record and looks for the next start; `blocking` looks first.
  async function adoptedModelOf(current, params) {
    const { model, refresh } = params.latest;
    if (params.request.model !== DEFAULT_LIVE_MODEL) return null;   // a model the person chose is never replaced
    if (refresh === 'none' || typeof env.fetch !== 'function') return model;
    const look = lookAtProvider(params);
    if (refresh === 'background') { attempt(() => look.catch(() => {})); return model; }
    let answer = null;
    await settleWithin(Promise.race([look.then((value) => { answer = value; }, () => {}), current.cancelSignal]), LATEST_LIVE.blockMs);
    // A look that SAW the list is trusted, a model that is no longer listed included (the record's candidate is then dropped,
    // not tried). One that failed or ran out of time falls back on the record, and the worker is told at once so that the next
    // start (of this lane or the other one) does not wait for the same hang again; a late answer replaces that report.
    if (answer === null) attempt(() => onLatest?.({ kind: 'failed' }));
    if (answer?.seen === true) return isAdoptable(answer.newest, DEFAULT_LIVE_MODEL) ? answer.newest : null;
    return model;
  }

  async function begin(current, params) {
    try {
      const { platform, tabId } = await acquire({ run: current, params });
      if (current.cancelled) throw codedError('START_CANCELLED');
      const latestModel = params.latest === undefined ? null : await adoptedModelOf(current, params);
      if (current.cancelled) throw codedError('START_CANCELLED');
      // §19: a share-picker start learns here which tab the user chose (null: it could not be told).
      if (tabId !== undefined) { facts.tabId = tabId; current.identified = true; }
      const created = createLaneEngine({ lane, deps, env, platform, onChange: () => emit('data'), onLatest, cooldowns });
      engineLane = created;
      // The key travels inside `params` untouched: only the lane engine names it. `muted` is the newest value: a
      // mute toggled while this start was still acquiring its input has nothing to act on yet, so it is applied here.
      const handle = created.start({ ...params, latestModel, muted, sessionId: `${lane}-${current.epoch}` });
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
