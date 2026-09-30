/**
 * Composition adapted from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart/Stop.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: existing capture, router, recovery, caption store and PCM player;
 * serial physical closure, generation guards, no IPC, extra voice or raw errors.
 */
import { isPolicyError, PolicyError, POLICY_ERROR_CODES } from '../policy/errors.js';
import { ProviderError, QUOTA_ERROR_CODES, assertActive, invalidResult, isInvalidResultReason, isResumeHandle,
  normalizeError } from '../providers/contract.js';
import { createListenMetrics } from './listen-metrics.js';
import { LIVE_MODELS, DEFAULT_LIVE_MODEL, sanitizeLiveModel, liveRoute, detectReply,
  normalizeLanguagePair } from '../providers/gemini/live-config.js';
import { liveSetupFor, mergeLiveModels, newestLiveModel } from '../providers/gemini/model-discovery.js';
import { createSessionManager } from './session-manager.js';
import { createLiveRecovery } from './live-recovery.js';
import { createListenState } from './listen-state.js';
import { createCaptionStore } from './caption-store.js';
import { createStreamCapture } from '../audio/stream-capture.js';
import { createUplinkQueue, UPLINK_LIMITS } from '../audio/uplink-queue.js';
import { createStreamPlayer } from '../audio/stream-player.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const attempt = fn => { try { return fn(); } catch { /* Observer-owned failure. */ } };
const normalizeFailure = error => isPolicyError(error) ? new PolicyError(error.code) : normalizeError(error);
const captureCodes = new Set(['MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE', 'TIMEOUT']);
// The fixed reason an INVALID_RESULT carries (contract.js), or null.
const reasonOf = error => error?.code === 'INVALID_RESULT' && isInvalidResultReason(error.reason) ? error.reason : null;
// P3-02e: a session is replaced automatically (live-recovery: at most three
// reopenings, 1/2/4 s) only for transport failures. Every 429 family code and
// every key/permission rejection ends the operation at once with its own code:
// an automatic reopen would only spend the remaining quota faster.
export const NO_REPLACEMENT_CODES = Object.freeze(['RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429',
  'INVALID_KEY', 'PERMISSION_DENIED', 'IP_DENIED', 'CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'CREDENTIAL_FORBIDDEN',
  'SAFETY_BLOCKED']);
const noReplacement = new Set([...NO_REPLACEMENT_CODES, ...POLICY_ERROR_CODES]);
// 2026-09-30 (owner: "무료키가 교체될때 타임러그를 최대한 줄여서 자연스럽게"):
// the one exception to the rule above. When an injected swapCredential(error)
// says a spare site key took over from one whose quota was spent, the SAME
// operation reconnects at once — same request and model, same capture, player
// and caption store, no backoff and no replacement budget. The key pool bounds
// this (the hook answers false once it is spent, which ends the operation as
// before); MAX_KEY_SWAPS is only a guard against a hook that never says no.
const quotaCodes = new Set(QUOTA_ERROR_CODES);
export const MAX_KEY_SWAPS = 8;
// 2026-09-30 (owner approval, "진행해"): the ~10-minute goAway uses the same
// seamless machinery as a key swap. The retiring connection keeps working —
// input still goes to it, its audio and captions still play — until the
// first of: a turn boundary on it, QUIET_MS without audio or captions from
// it, or HANDOVER_MARGIN_MS before its advertised end. Then it is closed and
// the next one opens at once, free of backoff and of the replacement budget.
// MIN_HANDOVER_AGE_MS is the runaway guard: a connection told to go away
// within its first minute takes the ordinary budgeted path instead, so a
// server that keeps saying goAway cannot make the engine reconnect forever.
export const QUIET_MS = 1500;
export const HANDOVER_MARGIN_MS = 2000;
export const MIN_HANDOVER_AGE_MS = 60000;
// Speech that started just before the boundary went to a connection that
// will never answer it, so the last ~1 s already sent there (31 frames of
// 32 ms) is sent again first on the next one. The cost is at most ~1 s of
// audio the model may hear twice.
export const PREROLL_FRAMES = 31;
// The provider marks a session not resumable while the model generates, so
// the handle held at a turn boundary may predate that turn; a fresh one can
// follow the turnComplete as its own message (review, 2026-09-30; when the
// server sends it is not documented). Only when an update said "not
// resumable" since the last good handle, the boundary handover waits for the
// fresh handle, at most HANDLE_GRACE_MS, while input still reaches the old
// socket. Otherwise the next connection would resume from before the last
// utterance and might interpret it again.
export const HANDLE_GRACE_MS = 500;
const MAX_SKIPPED = 100;
// 24 kHz PCM16 mono: 48 bytes per millisecond.
const audioMs = audio => Math.round((audio?.byteLength ?? 0) / 48);

/** start(request, {sessionId, turnId?, providerId, keySource, signal?}) must be
 * called from a gesture, after the app has stopped its previous activity.
 * Returns {ready, done}; both resolve with machine data, never raw exceptions.
 * ready reports the first setup or terminal failure; done waits for cleanup.
 * getAudioContext is caller-owned. resolveFallback is the registered LIVE
 * resolver (config.resolveFallback(providerId, 'live')), not the REST resolver.
 * Capture has no ready event: its first complete frame proves preparation and
 * is discarded. The adapter already assembles subtitles; do not assemble twice.
 * snapshot/subscribe expose memory-only captions and separate output state.
 * The translation-only model is always first; a flash model is used only by
 * explicit selection or by the registered fallback after the translation model
 * failed (snapshot.fallback). On the flash route, a translation segment that
 * looks like a reply discards the rest of that turn's audio and captions
 * (snapshot.skippedSegments, metrics.repliesSkipped).
 * swapCredential(error) -> Promise<boolean> is optional (2026-09-30): after a
 * connection closed with a 429-family code it is asked, once per close,
 * whether another credential for the same route took over. Only the app's
 * built-in key pool answers true. While it decides and the next session sets
 * up, the player keeps playing what already arrived, microphone input is held
 * (at most UPLINK_LIMITS.backlogFrames) and sent first on the new session, and
 * snapshot.reconnectReason is 'key'; metrics.keySwaps counts the swaps.
 * canSwapCredential(error) -> boolean (optional, synchronous) is asked at the
 * close itself: only when it says a swap is possible does the engine enter
 * that calm state; otherwise the close is handled exactly as without a hook
 * (review, 2026-09-30: a person's own key must never read as a key swap).
 * Without it, every quota close is treated as possibly swappable.
 * goAway (2026-09-30) on a connection open for MIN_HANDOVER_AGE_MS or more is
 * a handover, not a failure: see QUIET_MS above. While it runs the player
 * keeps playing, input is held (the pre-roll plus what was not yet sent) and
 * snapshot.reconnectReason is 'handover'; metrics.handovers counts them and
 * metrics.reconnects does not. A close or error of a retiring connection is a
 * handover too, unless its code is one that never gets a replacement.
 * Session resumption: the newest resumable handle of the current connection
 * is kept in memory only (never in a snapshot, metric or error) and offered
 * to the next open of the same operation on the same credential and model.
 * A key swap, a model change and a failed resumed setup discard it; a resumed
 * setup refused before ready is retried once, at once and free, on the same
 * model without a handle (never a model fallback). A turn boundary waits up
 * to HANDLE_GRACE_MS for a handle newer than a "not resumable" update.
 * metrics also records usageMetadata reports (numbers only).
 * INVALID_RESULT (2026-09-30): a connection that ends with it is replaced like
 * a dropped one — the ordinary, visible reconnect (reconnectReason null, gaps
 * marked, live-recovery's backoff and budget) and never a model fallback. When
 * the budget is spent the operation fails with INVALID_RESULT, and
 * snapshot.errorReason (also on the result) is the fixed reason of that last
 * failure, from contract.js INVALID_RESULT_REASONS; it is null for every other
 * outcome and again after the next start. The adapter's anomaly events (a part
 * it skipped or repaired) end nothing: they are counted with the fatal ones in
 * metrics.invalidResults, by reason, and mark an audio gap when sound was lost.
 * context.restart === true marks an app-initiated restart of an operation the
 * person started earlier: capture then accepts sticky user activation.
 */
export function createSimEngine({ router, sessionManager = createSessionManager(),
  getAudioContext, platform, resolveFallback, onLevel, swapCredential = null, canSwapCredential = null,
  now = () => performance.now(), setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout, random = Math.random } = {}) {
  if (typeof router?.call !== 'function' || typeof getAudioContext !== 'function'
    || (swapCredential !== null && typeof swapCredential !== 'function')
    || (canSwapCredential !== null && typeof canSwapCredential !== 'function')) {
    throw new ProviderError('INVALID_REQUEST');
  }
  const state = createListenState(), listeners = new Set();
  const timing = { now, setTimeout, clearTimeout, random };
  // Wrapped: the uplink queue calls clock.setTimeout(...) as a method, which a
  // browser's native timer refuses ("Illegal invocation") when it is stored bare.
  const clock = { now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  let selectedModel = DEFAULT_LIVE_MODEL, metrics;
  // Models the provider reported for this account beyond the repository list
  // (owner, 2026-09-06). They widen what setModel accepts and what the picker
  // offers; the reviewed default keeps its place at the head of the list.
  let discovered = Object.freeze([]);
  const models = () => mergeLiveModels(LIVE_MODELS, discovered);
  const knownModel = (model) => models().includes(model);
  const routeOf = (model) => (LIVE_MODELS.includes(model) ? liveRoute(model) : liveSetupFor(model));
  let active, store, errorCode = null, errorReason = null, disposed = false, lastResult, skipped = [];
  const snapshot = () => {
    const model = active?.model ?? lastResult?.model ?? selectedModel;
    return Object.freeze({ ...state.snapshot(), errorCode, errorReason,
      messageKey: errorCode ? `error.${errorCode}` : null,
      metrics: metrics?.snapshot() ?? null, model, route: routeOf(model),
      fallback: active?.fallback ?? lastResult?.fallback ?? false, defaultModel: DEFAULT_LIVE_MODEL,
      skippedSegments: Object.freeze([...skipped]),
      captions: store?.snapshot() ?? null, busy: Boolean(active),
      retries: active?.recovery.retries ?? lastResult?.retries ?? 0,
      reconnectReason: active?.reconnectReason ?? null });
  };
  const notify = () => { const value = snapshot(); for (const fn of [...listeners]) attempt(() => fn(value)); };
  state.subscribe(notify);
  const alive = op => active === op && !op.controller.signal.aborted;
  // keepPlayer: a key swap or a handover lets already-received audio finish
  // and keeps the held input for the next session; every other path drops both.
  function silence(op, { keepPlayer = false } = {}) {
    if (op.connection) { op.connection.enabled = false; unwatch(op.connection); }
    op.uplink?.cancel();
    if (!keepPlayer) { op.player?.cancel(); op.held = null; }
    store?.interrupt();
  }
  function hold(op, pcm) {
    // Oldest out first: the bridge keeps the most recent 4 s of speech.
    if (op.held.length >= UPLINK_LIMITS.backlogFrames) { op.held.shift(); store.markGap('input'); }
    op.held.push(pcm.slice());
  }
  // stop() never waits on the injected hook (review, 2026-09-30): the answer
  // races the operation's abort, which counts as "no swap".
  async function swapKey(op, error) {
    const signal = op.controller.signal;
    if (signal.aborted) return false;
    let onAbort;
    const aborted = new Promise(resolve => { onAbort = () => resolve(false); signal.addEventListener('abort', onAbort, { once: true }); });
    try { return (await Promise.race([swapCredential(error), aborted])) === true && alive(op); }
    catch { return false; }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  function swappable(op, failure, goAway) {
    if (goAway || swapCredential === null || !quotaCodes.has(failure.code) || op.keySwaps >= MAX_KEY_SWAPS) return false;
    if (canSwapCredential === null) return true;
    try { return canSwapCredential(failure) === true; } catch { return false; }
  }
  function cancel(op, code = null) {
    if (!alive(op)) return;
    op.failure = code;
    state.transition('stopping');
    silence(op);
    op.controller.abort();
    op.capture?.cancel();
    op.prepared.resolve(); op.connection?.fault.resolve({ error: new ProviderError('ABORTED') });
  }
  function makePlayer(op) {
    if (!op.audioContext) {
      state.setOutput(op.muted ? 'muted' : 'unavailable'); return;
    }
    const player = createStreamPlayer({ ...timing, context: op.audioContext, muted: op.muted,
      onState(value) { if (alive(op)) state.setOutput(value.state, op.generation); },
      // Audio discarded for a detected reply is not a playback gap, and neither is audio the person chose not to
      // hear: with the voice muted every chunk is "dropped", which used to show "queued speech was skipped" for the
      // whole of a captions-only session (2026-09-30; the extension starts muted by default).
      onDrop(value) {
        if (alive(op) && value.durationMs > 0 && value.reason !== 'muted' && !op.connection?.skipping) store.markGap('audio');
      } });
    op.player = player;
  }
  // Every INVALID_RESULT that ends a connection is counted by its reason,
  // whether the operation then reconnects or fails. fault() and handover()
  // each run once per connection, so each is counted once.
  function tally(failure) {
    const reason = reasonOf(failure);
    if (reason !== null) metrics.invalidResult(reason);
  }
  function fault(op, c, error, goAway = false) {
    if (!alive(op) || op.connection !== c || !c.enabled) return;
    c.enabled = false; unwatch(c);
    const failure = normalizeFailure(error);
    tally(failure);
    // A quota close may be answered by a key swap: keep the player and start
    // holding input now, before the swap is decided, so nothing is lost while
    // the old socket closes. goAway and transport faults keep design-p2 §9.
    const keySwap = swappable(op, failure, goAway);
    metrics.resetInput(); metrics.observe('reconnects');
    // A setup that carried a resumption handle and was refused before ready
    // (review, 2026-09-30): the handle is the likely cause (expired, or not
    // taken by this model), yet its close reads as a transport failure, which
    // would reach the model fallback. The same model is asked once more at
    // once, without a handle. What the step before kept (a handover's player
    // and held input) stays, and nothing was open on this connection to mark.
    if (!keySwap && !goAway && c.resumed && c.readyAt === null && !noReplacement.has(failure.code)) {
      state.transition('reconnecting', op.generation);
      c.fault.resolve({ error: failure, fresh: true });
      return;
    }
    // Input this session never sent — the rest of a backlog still catching up
    // from an earlier swap, or ordinary frames — is held too, ahead of what
    // arrives next (review, 2026-09-30: consecutive swaps lost it).
    if (keySwap) op.held = [...(op.held ?? []), ...(op.uplink?.takeUnsent() ?? [])];
    op.uplink?.cancel();
    if (keySwap) {
      const over = op.held.length - UPLINK_LIMITS.backlogFrames;
      if (over > 0) { op.held.splice(0, over); store.markGap('input'); }
      op.reconnectReason = 'key';
    } else { op.player?.cancel(); op.held = null; op.reconnectReason = null; }
    // Nothing can be missing from an interpretation that never ran: a first setup that fails and is retried is a
    // slow start, not a reception gap (the same rule as the input gap in start()).
    store.interrupt(); if (op.ran) store.markGap('reception');
    state.transition('reconnecting', op.generation);
    c.fault.resolve({ error: failure, goAway });
  }
  function unwatch(c) {
    clearTimeout(c.quietTimer); clearTimeout(c.deadlineTimer); clearTimeout(c.graceTimer);
    c.quietTimer = c.deadlineTimer = c.graceTimer = undefined;
  }
  // goAway: retire a connection that ran long enough, or take today's path.
  function retire(op, c, timeLeftMs) {
    if (c.retiring) return;
    if (c.readyAt === null || now() - c.readyAt < MIN_HANDOVER_AGE_MS) {
      fault(op, c, new ProviderError('SESSION_CLOSED'), true); return;
    }
    c.retiring = true;
    quiet(op, c);
    const left = Number.isFinite(timeLeftMs) ? timeLeftMs : 0;
    c.deadlineTimer = setTimeout(() => handover(op, c), Math.min(2147483647, Math.max(0, left - HANDOVER_MARGIN_MS)));
  }
  // Counted from max(goAway, the last audio or caption of the connection).
  function quiet(op, c) {
    clearTimeout(c.quietTimer);
    c.quietTimer = setTimeout(() => handover(op, c), QUIET_MS);
  }
  // Audio or a caption from c: a model turn is open until complete/interrupted.
  function heard(op, c) {
    c.turnOpen = true;
    if (c.retiring) {
      // A new turn began while a boundary waited for a handle: its own
      // boundary (or the quiet interval, or the deadline) decides now.
      clearTimeout(c.graceTimer); c.graceTimer = undefined;
      quiet(op, c);
    }
  }
  // A turn boundary on a retiring connection: hand over, or first wait
  // HANDLE_GRACE_MS at most for the handle that follows this turn.
  function boundary(op, c) {
    if (!c.handleStale) { handover(op, c); return; }
    if (c.graceTimer === undefined) c.graceTimer = setTimeout(() => handover(op, c), HANDLE_GRACE_MS);
  }
  // The key swap's bridge, for a planned handover: the old connection is done,
  // the player keeps what it has, and input is held for the next connection,
  // starting with the pre-roll already sent to this one.
  function handover(op, c, error = null) {
    if (!alive(op) || op.connection !== c || !c.enabled) return;
    c.enabled = false; unwatch(c);
    if (error) tally(error);
    metrics.resetInput();
    op.held = [...c.sent, ...(op.uplink?.takeUnsent() ?? [])];
    op.uplink?.cancel();
    const over = op.held.length - UPLINK_LIMITS.backlogFrames;
    if (over > 0) { op.held.splice(0, over); store.markGap('input'); }
    op.reconnectReason = 'handover';
    // Only a model turn left open (the deadline, or the socket dropping) loses
    // anything; at a clean boundary every caption is already final.
    op.cleanHandover = !c.turnOpen;
    if (c.turnOpen) { store.interrupt(); store.markGap('reception'); }
    state.transition('reconnecting', op.generation);
    c.fault.resolve({ error: error ?? new ProviderError('SESSION_CLOSED'), handover: true });
  }
  // A retiring connection that closes or fails is handed over, unless the code
  // is one that never gets a replacement (quota, key, policy, safety): those
  // keep their own path, which for a quota close may still be a key swap.
  function lost(op, c, error) {
    const failure = normalizeFailure(error);
    if (c.retiring && !noReplacement.has(failure.code)) handover(op, c, failure);
    else fault(op, c, failure);
  }
  // Only instruction-driven connections ask for handles. null means "not
  // resumable right now": it keeps the last good handle but marks it stale.
  function remember(op, c, handle) {
    if (!c.flash) return;
    if (!isResumeHandle(handle)) { c.handleStale = true; return; }
    op.resume = { handle, model: c.model };
    c.handleStale = false;
    // The fresh handle a turn boundary was waiting for.
    if (c.graceTimer !== undefined) handover(op, c);
  }
  function usage(ev) {
    metrics.observe('usageReports');
    if (ev.promptTokens !== undefined) {
      metrics.observe('promptTokensLast', ev.promptTokens); metrics.observe('promptTokensMax', ev.promptTokens);
    }
    if (ev.totalTokens !== undefined) metrics.observe('totalTokensSum', ev.totalTokens);
  }
  // A part the adapter skipped or repaired. Validated here as at any boundary:
  // only a listed reason is counted. Sound that was discarded is a playback
  // gap, except inside a turn whose audio is being discarded as a reply anyway.
  function anomaly(op, c, ev) {
    if (!isInvalidResultReason(ev.reason) || typeof ev.dropped !== 'boolean') return;
    metrics.invalidResult(ev.reason);
    // Like the player's own drops (makePlayer): not a gap when the voice is muted, since nothing would have played.
    if (ev.dropped && !c.skipping && !op.muted) store.markGap('audio');
  }
  function event(op, c, ev) {
    if (!alive(op) || op.connection !== c || ev.generation !== c.generation) return;
    // Metadata still counts while this connection is being closed: the usage
    // report may ride on the very turnComplete that started a handover. The
    // next connection has not opened yet, so a handle here is still the newest.
    if (ev.type === 'usage') { usage(ev); return; }
    if (ev.type === 'resumption') { remember(op, c, ev.handle); return; }
    if (!c.enabled) return;
    try {
      if (ev.type === 'goAway') { retire(op, c, ev.timeLeftMs); return; }
      if (ev.type === 'error' || ev.type === 'closed') { lost(op, c, ev.error ?? new ProviderError('SESSION_CLOSED')); return; }
      if (ev.type === 'anomaly') { anomaly(op, c, ev); return; }
      if (ev.type === 'audio') {
        heard(op, c);
        op.recovery.activity(); metrics.mark('firstAudioReceivedMs'); metrics.audioReceived();
        if (c.skipping) { metrics.observe('droppedAudioMs', audioMs(ev.audio)); return; }
        if (op.player?.enqueue(ev.audio)) metrics.mark('firstAudioScheduledMs');
        if (op.player) metrics.queue(op.player.snapshot().queuedSeconds * 1000);
        notify();
      } else if (ev.type === 'subtitle') {
        heard(op, c);
        op.recovery.activity();
        const at = now();
        const translation = ev.role === 'translation';
        // The rest of a rejected turn never reaches captions or the player.
        if (translation && c.skipping) return;
        // Two-way output may legitimately be in either language, so the
        // foreign-script half of the heuristic cannot apply; only the explicit
        // reply phrases still mark the model answering instead of interpreting.
        const reply = translation && c.flash
          ? (op.languages === null
            ? detectReply(ev.translatedText, op.targetLanguage, { final: ev.final })
            : op.languages.map((lang) => detectReply(ev.translatedText, lang, { final: false })).find(Boolean) ?? null)
          : null;
        if (reply) {
          c.skipping = true;
          op.player?.interrupt();
          metrics.observe('repliesSkipped');
          if (skipped.length >= MAX_SKIPPED) skipped.shift();
          skipped.push(ev.segmentId);
        }
        metrics.mark(ev.final ? 'firstFinalMs' : 'firstPartialMs');
        store.upsertDirect({ id: ev.segmentId, sessionId: op.sessionId, generation: c.generation,
          role: ev.role, sequence: ev.seq, revision: ev.revision,
          sourceText: ev.sourceText, translatedText: ev.translatedText,
          status: reply ? 'interrupted' : ev.final ? 'final' : 'partial', receivedAt: at,
          finalizedAt: reply || ev.final ? at : null,
          gapBefore: c.gapRoles.has(ev.role) });
        c.gapRoles.delete(ev.role);
        if (reply) notify();
      } else if (ev.type === 'complete') {
        c.skipping = false; c.turnOpen = false; op.player?.turnComplete();
        if (c.retiring) boundary(op, c);
      } else if (ev.type === 'interrupted') {
        c.skipping = false; c.turnOpen = false; store.interrupt(); op.player?.interrupt();
        if (c.retiring) boundary(op, c);
      }
    } catch {
      // Nothing above validates provider data (the adapter did): whatever is
      // thrown here is this engine's own fault, and the reason says so.
      lost(op, c, invalidResult('event-handler'));
    }
  }
  async function run(op, request, route) {
    let failure, reason = null;
    try {
      await op.prepared.promise;
      assertActive(op.controller.signal);
      state.transition('connecting', op.generation);
      for (;;) {
        const c = { enabled: true, fault: deferred(), skipping: false, model: request.model,
          flash: liveRoute(request.model) === 'flash',
          // A clean handover left nothing open, so the next captions follow on without a gap mark.
          gapRoles: new Set(op.recovery.budget.used && !op.cleanHandover ? ['source', 'translation'] : []),
          retiring: false, readyAt: null, turnOpen: false, sent: [], handleStale: false,
          quietTimer: undefined, deadlineTimer: undefined, graceTimer: undefined };
        op.cleanHandover = false;
        op.connection = c;
        if (!op.player) makePlayer(op);
        // Resume the same conversation only on the same credential and model.
        const resumeHandle = c.flash && op.resume?.model === request.model ? op.resume.handle : null;
        c.resumed = resumeHandle !== null;
        const call = c.resumed ? { ...request, resumeHandle } : request;
        let outcome;
        try {
          op.lease = await sessionManager.replace(ctx => {
            op.ownsSession = true;
            c.generation = ctx.generation;
            store.setGeneration(ctx.generation);
            return router.call('live', call, { ...ctx, ...route, transport: 'direct', budget: op.recovery.budget });
          }, { signal: op.controller.signal, sessionId: op.sessionId, turnId: op.turnId,
            onEvent: ev => event(op, c, ev) });
          assertActive(op.controller.signal);
          if (c.enabled) {
            op.recovery.opened(); op.model = sanitizeLiveModel(request.model); metrics.mark('setupMs');
            c.readyAt = now();
            // Input held across a key swap or a handover goes out first (uplink-queue backlog).
            op.uplink = createUplinkQueue({ clock, backlog: op.held ?? undefined,
              // The transport's buffered byte count paces the held input.
              sendAudio: async pcm => {
                // The last PREROLL_FRAMES frames handed to this connection, for a handover.
                c.sent.push(pcm); if (c.sent.length > PREROLL_FRAMES) c.sent.shift();
                const buffered = await op.lease.sendAudio(pcm); metrics.observe('sentFrames'); return buffered;
              },
              onDrop: () => { if (alive(op)) store.markGap('input'); },
              onError: err => lost(op, c, err) });
            op.held = null;
            op.uplink.setReady(true);
            op.reconnectReason = null;
            op.ran = true;
            state.transition('running', op.generation);
            op.ready.resolve(Object.freeze({ status: 'running', sessionId: op.sessionId }));
          }
          outcome = await c.fault.promise;
        } catch (raw) {
          outcome = { error: normalizeFailure(raw) };
          // An event carries the original remote error, before cleanup aborts.
          // A rejection that came first faults here; either way the fault's
          // own outcome is read, since it may mark a refused resumed setup.
          if (c.enabled) fault(op, c, outcome.error);
          if (!c.enabled) outcome = await c.fault.promise;
        }
        const swapping = op.reconnectReason === 'key';
        const handingOver = outcome.handover === true;
        const fresh = outcome.fresh === true;
        // A resumed setup that failed before ready: the next attempt starts fresh.
        if (c.resumed && c.readyAt === null) op.resume = null;
        silence(op, { keepPlayer: swapping || handingOver || fresh });
        if (!swapping && !handingOver && !fresh) op.player = null;
        // finishInput only ends input. Only close certifies lease shutdown.
        if (op.ownsSession) { await (op.lease ? op.lease.close() : sessionManager.close()); op.ownsSession = false; }
        op.lease = null;
        assertActive(op.controller.signal);
        // Credential/routing rejection can precede the router's first charge.
        if (!op.recovery.budget.used) throw outcome.error;
        if (fresh) {
          // Same request and model, at once and free of the budget. Bounded:
          // op.resume is gone, so this attempt carries no handle and never
          // comes back here; a handle only comes from a connection that was ready.
          op.recovery.reopenFree();
          // The next connection marks the gaps the refused one would have.
          op.cleanHandover = c.gapRoles.size === 0;
          notify();
          continue;
        }
        if (handingOver) {
          // Same request, model, capture, player and caption store; no backoff
          // and no replacement budget (the connection's age bounds these).
          op.recovery.handedOver();
          metrics.observe('handovers');
          // New audio queues behind whatever the old connection left playing.
          op.player?.turnComplete();
          notify();
          continue;
        }
        if (swapping) {
          // Another key may belong to another Google project, which cannot
          // resume this one's session.
          op.resume = null;
          if (await swapKey(op, outcome.error)) {
            assertActive(op.controller.signal);
            op.recovery.keySwapped();
            op.keySwaps += 1; metrics.observe('keySwaps');
            // The spent key's turn never completes; the next session's audio
            // starts a new turn behind whatever is still playing.
            op.player?.turnComplete();
            notify();
            continue;
          }
          // No spare key: the operation ends exactly as it did before swaps.
          op.reconnectReason = null; op.held = null;
          op.player?.cancel(); op.player = null;
        }
        // Quota and key rejections are final for this operation; only the
        // user's explicit reopen starts a new session with a fresh budget.
        if (!outcome.goAway && noReplacement.has(outcome.error.code)) throw outcome.error;
        request = await op.recovery.wait(outcome.error, { signal: op.controller.signal,
          closed: true, goAway: outcome.goAway, request, resolveFallback });
        // Registered fallback only: the translation-only model stays first and a
        // flash model replaces it solely after it failed. Surface the switch.
        op.model = sanitizeLiveModel(request.model);
        // A handle belongs to the model that issued it.
        if (op.resume && op.resume.model !== request.model) op.resume = null;
        if (op.model !== op.requestedModel) op.fallback = true;
        notify();
      }
    } catch (raw) {
      const error = normalizeFailure(raw);
      failure = op.failure ?? (op.controller.signal.aborted ? null : error.code);
      // Only for the INVALID_RESULT that is this operation's outcome.
      if (failure === error.code) reason = reasonOf(error);
    } finally {
      silence(op); op.controller.abort(); op.capture?.cancel();
      try {
        if (op.ownsSession) await (op.lease ? op.lease.close() : sessionManager.close());
      } catch (raw) { const error = normalizeFailure(raw); failure = error.code; reason = reasonOf(error); }
      await op.capture?.done;
      op.detach();
      errorCode = failure; errorReason = reason;
      if (failure) state.transition('failed');
      else {
        if (state.snapshot().status !== 'stopping') state.transition('stopping');
        state.transition('stopped');
      }
      lastResult = Object.freeze({ status: failure ? 'failed' : 'stopped', errorCode: failure, errorReason: reason,
        messageKey: failure ? `error.${failure}` : null, retries: op.recovery.retries,
        model: op.model, fallback: op.fallback });
      metrics.stop(); active = null; notify(); op.ready.resolve(lastResult); op.done.resolve(lastResult);
    }
  }
  function start(request = {}, context = {}) {
    if (disposed || active || sessionManager.occupied) throw new ProviderError('SESSION_LIMIT');
    // Two-way: one microphone serves both sides, and the direction is decided
    // per utterance by the language heard. `languages` replaces the single
    // target; the pair is validated by the provider config.
    const pair = request.languages === undefined || request.languages === null
      ? null : normalizeLanguagePair(request.languages);
    if ((pair === null && !['ko', 'en', 'ja'].includes(request.targetLanguage))
      || typeof context.sessionId !== 'string' || !context.sessionId || context.sessionId.length > 256
      || (context.transport !== undefined && context.transport !== 'direct')) throw new ProviderError('INVALID_REQUEST');
    assertActive(context.signal);
    const op = { controller: new AbortController(), prepared: deferred(), ready: deferred(), done: deferred(),
      sessionId: context.sessionId, turnId: context.turnId ?? context.sessionId,
      muted: request.muted === true, recovery: createLiveRecovery(timing), detach: () => {},
      targetLanguage: request.targetLanguage, sourceLanguage: request.sourceLanguage ?? null,
      languages: pair, fallback: false, keySwaps: 0, reconnectReason: null, held: null,
      // Memory only: the newest resumable handle and the model that issued it.
      resume: null, cleanHandover: false,
      // True once a connection of this operation was ready: from then on unsendable input is an input gap.
      ran: false };
    metrics = createListenMetrics({ now });
    // A corrupted stored selection never reaches the router: fall back to the
    // translation-only default rather than failing or steering to flash.
    op.model = request.model === undefined ? selectedModel
      : knownModel(request.model) ? request.model : sanitizeLiveModel(request.model);
    // The translation setup carries one target language and cannot change
    // direction, so a two-way session uses the instruction-driven model.
    if (pair !== null && routeOf(op.model) === 'translation') {
      op.model = models().find((model) => routeOf(model) !== 'translation') ?? op.model;
    }
    if (!LIVE_MODELS.includes(op.model)) throw new ProviderError('MODEL_UNSUPPORTED');
    op.requestedModel = op.model; skipped = [];
    store?.close(); store = createCaptionStore({ sessionId: op.sessionId, now }); store.subscribe(notify);
    errorCode = null; errorReason = null; active = op;
    state.transition('preparing'); op.generation = state.snapshot().generation;
    const abort = () => cancel(op);
    context.signal?.addEventListener('abort', abort, { once: true });
    op.detach = () => context.signal?.removeEventListener('abort', abort);
    try {
      // Both browser gesture-sensitive calls occur before any await.
      op.audioContext = attempt(() => getAudioContext()) ?? null;
      makePlayer(op); void op.player?.resume();
      op.capture = createStreamCapture({ platform, onLevel: value => {
        if (alive(op)) {
          if (op.uplink && op.connection?.enabled) metrics.inputLevel(value.rms);
          attempt(() => onLevel?.(value));
        }
      }, onFrame: pcm => {
        if (!alive(op)) return;
        op.prepared.resolve();
        // op.held exists only between a quota close and the next session's
        // uplink; every other reconnect keeps not accumulating input.
        if (op.held) hold(op, pcm);
        else if (op.connection?.enabled && op.uplink) op.uplink.enqueue(pcm);
        // Input that cannot be sent is a gap only in an interpretation that was already running (a reconnect).
        // While the FIRST connection is still being set up nothing has been interpreted yet, and the capture always
        // delivers frames before that setup completes, so every session used to show "some audio was not sent" from
        // its first second until it ended (the flag is sticky; owner report, 2026-09-30).
        else if (op.ran) store.markGap('input');
      } }).start({ signal: op.controller.signal, sessionId: op.sessionId,
        turnId: op.turnId, generation: op.generation,
        activation: context.restart === true ? 'sticky' : 'transient' });
      op.capture.done.then(result => {
        if (alive(op)) cancel(op, captureCodes.has(result.code) ? result.code
          : result.status === 'error' ? 'MICROPHONE_UNAVAILABLE' : null);
      });
    } catch { cancel(op, 'MICROPHONE_UNAVAILABLE'); }
    const input = { input: { format: 'pcm16' }, targetLanguage: request.targetLanguage,
      // 'auto' stays out of the request: the provider layer treats an absent
      // source as "decide from what you hear", which is the old behaviour.
      ...(request.sourceLanguage && request.sourceLanguage !== 'auto'
        ? { sourceLanguage: request.sourceLanguage } : {}),
      ...(pair === null ? {} : { languages: pair }), model: op.model };
    void run(op, input, { providerId: context.providerId, keySource: context.keySource });
    return Object.freeze({ ready: op.ready.promise, done: op.done.promise });
  }
  function stop() { if (active) { const op = active; cancel(op); return op.done.promise; } return Promise.resolve(lastResult); }
  return Object.freeze({ start, stop, cancel: stop, snapshot,
    get model() { return selectedModel; },
    get defaultModel() { return DEFAULT_LIVE_MODEL; },
    /** The repository list plus whatever discovery added, in that order. */
    get models() { return models(); },
    get discoveredModels() { return discovered; },
    async setModel(model) {
      if (!knownModel(model)) throw new ProviderError('MODEL_UNSUPPORTED');
      if (model === selectedModel) return;
      await stop(); selectedModel = model; notify();
    },
    /**
     * Report what the provider says this account can reach (owner, 2026-09-06).
     * `adopt` switches to the newest model that was not in the repository list;
     * a session in progress is never interrupted for it — the caller decides
     * when to offer this, and a refused or empty discovery changes nothing.
     * Returns the adopted model id, or null.
     */
    async setDiscoveredModels(list, { adopt = false } = {}) {
      const merged = mergeLiveModels(LIVE_MODELS, list);
      const added = merged.filter((model) => !LIVE_MODELS.includes(model));
      const changed = added.length !== discovered.length || added.some((model, index) => model !== discovered[index]);
      discovered = Object.freeze(added);
      const newest = adopt ? newestLiveModel(LIVE_MODELS, added) : null;
      if (newest !== null && newest !== selectedModel && !active && !sessionManager.occupied) {
        selectedModel = newest;
        notify();
        return newest;
      }
      if (changed) notify();
      return null;
    },
    // Restores a persisted selection; anything unrecognised becomes the default.
    async restoreModel(model) {
      const next = knownModel(model) ? model : sanitizeLiveModel(model);
      if (next !== selectedModel) { await stop(); selectedModel = next; notify(); }
      return next;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
    setMuted(value) {
      if (!active || !alive(active)) return;
      active.muted = Boolean(value); active.player?.setMuted(active.muted);
      // Hard mute (owner report: "소리 끄기" left a faint sound): besides dropping every
      // queued source, suspend the playback context so nothing can reach the speaker;
      // resume on unmute. The capture context is separate, so listening continues.
      const ctx = active.audioContext;
      if (ctx && typeof ctx.suspend === 'function') {
        if (active.muted) attempt(() => ctx.suspend());
        else attempt(() => ctx.resume());
      }
      if (!active.player) state.setOutput(active.muted ? 'muted' : 'unavailable', active.generation);
    },
    resumeAudio() { return active && alive(active) ? active.player?.resume() ?? Promise.resolve(false) : Promise.resolve(false); },
    async close() { disposed = true; await stop(); store?.close(); state.close(); listeners.clear(); },
  });
}
