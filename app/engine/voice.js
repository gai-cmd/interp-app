// New implementation of design-v0.6 §§8.3, 9.3, 9.4 and 20.4 (voice fallback
// ladder). Only policy lives here; no legacy voice or Electron code is ported.
import { ProviderError, normalizeError } from '../providers/contract.js';
import { createBudget, createLiveRetryPolicy } from './retry.js';
import { createSessionManager } from './session-manager.js';
import { createPCMPlayer } from '../audio/pcm-player.js';

// Design values pending device measurement, not provider facts.
export const VOICE_POLICY = Object.freeze({ firstAudioTimeoutMs: 8000, turnTimeoutMs: 60000,
  playbackTimeoutMs: 120000, maxTextLength: 4000, maxTranscriptChars: 8000 });
// Every messageKey a result can carry; check-i18n keeps error.* complete.
export const VOICE_MESSAGE_KEYS = Object.freeze(['voice.fallback', 'voice.partialFailure',
  'voice.deviceUnavailable', 'error.VOICE_FAILED', 'error.PLAYBACK_BLOCKED', 'error.ABORTED']);

// Live failures that concern one line only and leave session health unchanged.
const turnLocal = new Set(['ABORTED', 'SAFETY_BLOCKED', 'INVALID_REQUEST', 'INPUT_UNSUPPORTED', 'INVALID_RESULT']);
// Failures the Live policy cools down (1/2/4 s with jitter, server wait first,
// three in a row without 60 s of audio). Values map to codes the policy accepts.
const coolable = Object.freeze({ RATE_LIMITED: 'RATE_LIMITED', UNAVAILABLE: 'UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR', TIMEOUT: 'TIMEOUT', SESSION_LIMIT: 'SESSION_LIMIT',
  SESSION_CLOSED: 'UNAVAILABLE', TOKEN_LIMIT: 'RATE_LIMITED', PROVIDER_ERROR: 'UNAVAILABLE' });
// Everything else (key, permission, IP, daily quota, unknown 429, model/config,
// credential, routing) suspends Live voice until the user restarts it.
const validLanguage = (value) => typeof value === 'string' && value.length <= 35
  && /^(ko|en|ja)(?:-[A-Za-z0-9]{2,8})*$/.test(value);
const validText = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
class PlaybackFault { constructor(playback) { this.playback = playback; } }

/**
 * createVoiceEngine({ router, deviceTTS?, getAudioContext, sessionManager?, ... }).
 * speak({ text, language, voice?, model?, output: 'provider' | 'device',
 *   allowDeviceFallback?, deviceVoiceURI? }, { signal?, turnId, sessionId,
 *   providerId, keySource, transport? }) always resolves a VoiceResult:
 * { turnId, sessionId, generation, engine: 'live' | 'device' | null,
 *   status: 'completed' | 'partial' | 'cancelled' | 'failed' | 'timeout' | 'unavailable',
 *   messageKey?, errorCode?, fallback, liveErrorCode, deviceFallbackAvailable,
 *   firstAudio, bytes, said, model, voice, gap, privacyMessageKey?, localService?,
 *   offlineGuaranteed?, firstReceivedAt, firstScheduledAt, actualFirstSoundAt: null }.
 * It resolves when playback has ended, so callers can resume recording safely.
 * One line at a time: a new speak cancels the active one. Cancellation closes
 * the Live socket and the player queue. A Live failure before the first audio
 * chunk may fall back to device speech once; after audio was heard the line is
 * never re-read automatically (status 'partial'; the user may choose device
 * speech). The Live session is reused across completed turns with the same
 * route, language, voice and model and replaced at a turn boundary otherwise.
 * Event turnId/sessionId name the turn that opened the session; attribution
 * uses generation and the active turn. An injected sessionManager must allow
 * at least turnTimeoutMs per speak; the default one is created with that value.
 * getAudioContext returns a caller-owned AudioContext resumed from a gesture.
 */
export function createVoiceEngine({ router, deviceTTS = null, getAudioContext, sessionManager,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  now = () => Date.now(), random = Math.random,
  firstAudioTimeoutMs = VOICE_POLICY.firstAudioTimeoutMs, turnTimeoutMs = VOICE_POLICY.turnTimeoutMs,
  playbackTimeoutMs = VOICE_POLICY.playbackTimeoutMs } = {}) {
  if (typeof router?.call !== 'function' || typeof getAudioContext !== 'function'
    || (deviceTTS !== null && typeof deviceTTS?.speak !== 'function')
    || typeof setTimeout !== 'function' || typeof clearTimeout !== 'function'
    || [firstAudioTimeoutMs, turnTimeoutMs, playbackTimeoutMs].some((n) => !Number.isFinite(n) || n <= 0 || n > 2147483647)) {
    throw new ProviderError('INVALID_REQUEST');
  }
  const timing = { setTimeout, clearTimeout, random, now };
  const manager = sessionManager ?? createSessionManager({ timeoutMs: turnTimeoutMs, setTimeout, clearTimeout });
  const policy = createLiveRetryPolicy(timing);
  const lifetime = new AbortController();
  let lease = null, leaseSignature = null, active = null, queue = Promise.resolve(), serial = 0, closed = false;
  let cooling = null, cooldown = null, suspended = null, lastLiveError = null;

  function onEvent(event) {
    if (event.type === 'closed') { if (lease && event.generation === lease.generation) lease = null; return; }
    const turn = active;
    if (!turn || turn.settled || turn.generation !== event.generation) return;
    if (event.type === 'audio') {
      if (!turn.firstAudio) { turn.firstAudio = true; clearTimeout(turn.firstTimer); policy.activity(); }
      turn.player?.enqueue(event.audio);
    } else if (event.type === 'transcript' && typeof event.text === 'string') {
      turn.said += event.text.slice(0, Math.max(0, VOICE_POLICY.maxTranscriptChars - turn.said.length));
    }
  }

  function recordLiveFailure(error) {
    const code = error.code;
    lastLiveError = code;
    if (turnLocal.has(code)) return;
    if (!Object.hasOwn(coolable, code)) { suspended = code; return; }
    if (cooling) return;
    const wait = new ProviderError(coolable[code]);
    if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) wait.retryAfterMs = error.retryAfterMs;
    const controller = new AbortController();
    cooldown = controller;
    cooling = policy.wait(wait, { closed: true, signal: controller.signal }).then(() => {
      if (cooldown === controller) { cooling = null; cooldown = null; }
    }, (failure) => {
      if (cooldown !== controller) return;
      cooling = null; cooldown = null;
      if (failure.code === 'BUDGET_EXHAUSTED') suspended = 'BUDGET_EXHAUSTED';
    });
  }

  async function openSession(turn, route, request) {
    const signature = [route.providerId, route.keySource, route.transport, request.language,
      request.voice ?? '', request.model ?? ''].join('|');
    if (lease && leaseSignature === signature && manager.isCurrent(lease.generation)) return lease;
    lease = null;
    const voiceRequest = { language: request.language, input: { format: 'text' },
      ...(request.voice !== undefined ? { voice: request.voice } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}) };
    const open = (context) => router.call('voice', voiceRequest, { ...context, ...route, budget: createBudget({ limit: 1 }) });
    const opening = manager.replace(open, { signal: lifetime.signal, onEvent, turnId: turn.turnId, sessionId: turn.sessionId });
    const abort = () => { manager.close().catch(() => {}); };
    turn.signal.addEventListener('abort', abort, { once: true });
    try {
      const next = await opening;
      lease = next; leaseSignature = signature;
      policy.opened();
      return next;
    } finally { turn.signal.removeEventListener('abort', abort); }
  }

  async function liveTurn(turn, request, route) {
    if (turn.signal.aborted) return { cancelled: true };
    if (suspended || cooling) return { fallback: true, errorCode: suspended ?? lastLiveError ?? 'UNAVAILABLE' };
    let context = null;
    try { context = getAudioContext(); } catch { context = null; }
    if (!context) return { fallback: true, errorCode: 'PLAYBACK_BLOCKED', local: true };
    const player = createPCMPlayer({ context, signal: turn.signal, turnId: turn.turnId, sessionId: turn.sessionId,
      setTimeout, clearTimeout, now, timeoutMs: playbackTimeoutMs });
    turn.player = player;
    if (!(await player.resume())) {
      turn.playback = await player.done;
      return turn.signal.aborted ? { cancelled: true } : { fallback: true, errorCode: 'PLAYBACK_BLOCKED', local: true };
    }
    let current;
    try { current = await openSession(turn, route, request); } catch (raw) {
      const error = normalizeError(raw);
      player.cancel();
      if (turn.signal.aborted || error.code === 'ABORTED') return { cancelled: true };
      recordLiveFailure(error);
      return { fallback: true, errorCode: error.code };
    }
    turn.generation = current.generation;
    const cancelSession = () => { turn.closing ??= current.cancel().catch(() => {}); return turn.closing; };
    if (turn.signal.aborted) { player.cancel(); await cancelSession(); return { cancelled: true }; }
    let resolveOutcome, rejectOutcome;
    const outcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
    const abort = () => { void cancelSession(); };
    turn.signal.addEventListener('abort', abort, { once: true });
    turn.firstTimer = setTimeout(() => rejectOutcome(new ProviderError('TIMEOUT')), firstAudioTimeoutMs);
    player.done.then((playback) => { turn.playback = playback; if (playback.status !== 'completed') rejectOutcome(new PlaybackFault(playback)); });
    current.speak({ text: request.text }).then(resolveOutcome, rejectOutcome);
    let stream;
    try { stream = await outcome; } catch (raw) {
      clearTimeout(turn.firstTimer);
      turn.signal.removeEventListener('abort', abort);
      const local = raw instanceof PlaybackFault;
      const error = local ? null : normalizeError(raw);
      if (turn.signal.aborted || error?.code === 'ABORTED') { player.cancel(); await cancelSession(); await player.done; return { cancelled: true }; }
      void cancelSession();
      if (!local) recordLiveFailure(error);
      if (!turn.firstAudio) {
        player.cancel(); await player.done;
        return { fallback: true, errorCode: local ? 'PLAYBACK_BLOCKED' : error.code, local };
      }
      // Audio was heard: play what arrived, report the rest as failed, never re-read.
      const playback = await player.finish();
      return { status: 'partial', engine: 'live', messageKey: 'voice.partialFailure', firstAudio: true,
        errorCode: local ? (playback.status === 'timeout' ? 'TIMEOUT' : null) : error.code, gap: true, said: turn.said, playback };
    }
    clearTimeout(turn.firstTimer);
    turn.signal.removeEventListener('abort', abort);
    const playback = await player.finish();
    if (turn.signal.aborted || playback.status === 'cancelled') { await cancelSession(); return { cancelled: true }; }
    if (!turn.firstAudio) {
      // The server ended the turn without audio: nothing was heard yet.
      void cancelSession();
      recordLiveFailure(new ProviderError('INVALID_RESULT'));
      return { fallback: true, errorCode: 'INVALID_RESULT' };
    }
    const base = { engine: 'live', firstAudio: true, said: turn.said || stream.said || '', bytes: stream.bytes,
      model: stream.model, voice: stream.voice, playback };
    if (stream.status === 'interrupted' || playback.status !== 'completed') {
      if (playback.status !== 'completed') void cancelSession();
      return { ...base, status: 'partial', messageKey: 'voice.partialFailure', gap: true,
        errorCode: playback.status === 'timeout' ? 'TIMEOUT' : null };
    }
    return { ...base, status: 'completed', gap: false };
  }

  async function deviceTurn(turn, request, { fallback, liveErrorCode = null }) {
    if (!deviceTTS) return { status: 'unavailable', engine: 'device', messageKey: 'voice.deviceUnavailable', fallback, liveErrorCode };
    let result;
    try {
      result = await deviceTTS.speak({ text: request.text, language: request.language, voiceURI: request.deviceVoiceURI },
        { signal: turn.signal, turnId: turn.turnId, sessionId: turn.sessionId, generation: turn.generation });
    } catch { result = { status: 'failed' }; }
    const status = ['completed', 'cancelled', 'unavailable', 'failed', 'timeout'].includes(result?.status) ? result.status : 'failed';
    const messageKey = status === 'completed' ? (fallback ? 'voice.fallback' : undefined)
      : status === 'cancelled' ? 'error.ABORTED'
        : status === 'unavailable' ? 'voice.deviceUnavailable' : 'error.VOICE_FAILED';
    return { status, engine: 'device', messageKey, fallback, liveErrorCode,
      errorCode: status === 'cancelled' ? 'ABORTED' : status === 'timeout' ? 'TIMEOUT' : null,
      privacyMessageKey: 'voice.devicePrivacy', offlineGuaranteed: false,
      localService: typeof result?.localService === 'boolean' ? result.localService : null };
  }

  async function runTurn(request, context, id) {
    const turn = { turnId: context.turnId, sessionId: context.sessionId, controller: new AbortController(),
      generation: null, settled: false, firstAudio: false, said: '', player: null, playback: null, closing: null, firstTimer: undefined };
    turn.signal = turn.controller.signal;
    turn.done = new Promise((resolve) => { turn.finish = resolve; });
    const finish = (fields) => {
      const playback = fields.playback ?? turn.playback ?? {};
      return Object.freeze({ turnId: turn.turnId, sessionId: turn.sessionId, generation: turn.generation,
        engine: fields.engine ?? null, status: fields.status, messageKey: fields.messageKey,
        errorCode: fields.errorCode ?? null, fallback: fields.fallback === true, liveErrorCode: fields.liveErrorCode ?? null,
        deviceFallbackAvailable: fields.deviceFallbackAvailable === true, firstAudio: fields.firstAudio === true,
        bytes: fields.bytes ?? 0, said: fields.said ?? '', model: fields.model ?? null, voice: fields.voice ?? null,
        gap: fields.gap === true, privacyMessageKey: fields.privacyMessageKey, localService: fields.localService,
        offlineGuaranteed: fields.offlineGuaranteed, firstReceivedAt: playback.firstReceivedAt ?? null,
        firstScheduledAt: playback.firstScheduledAt ?? null, actualFirstSoundAt: null });
    };
    const cancelled = () => finish({ status: 'cancelled', messageKey: 'error.ABORTED', errorCode: 'ABORTED' });
    const route = { providerId: context.providerId, keySource: context.keySource, transport: context.transport ?? 'direct' };
    const output = request?.output ?? 'provider';
    if (!request || !validText(request.text, VOICE_POLICY.maxTextLength) || !validLanguage(request.language)
      || !['provider', 'device'].includes(output) || typeof context.turnId !== 'string' || typeof context.sessionId !== 'string'
      || (output === 'provider' && (typeof route.providerId !== 'string' || typeof route.keySource !== 'string'))) {
      turn.finish();
      return finish({ status: 'failed', messageKey: 'error.VOICE_FAILED', errorCode: 'INVALID_REQUEST' });
    }
    if (closed || id !== serial || context.signal?.aborted) { turn.finish(); return cancelled(); }
    const abort = () => turn.controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    active = turn;
    try {
      const allowDevice = request.allowDeviceFallback !== false && deviceTTS !== null;
      if (output === 'device') return finish(await deviceTurn(turn, request, { fallback: false }));
      const live = await liveTurn(turn, request, route);
      if (live.cancelled) return cancelled();
      if (!live.fallback) return finish({ ...live, deviceFallbackAvailable: deviceTTS !== null && live.status !== 'completed' });
      if (turn.signal.aborted) return cancelled();
      if (!allowDevice) {
        return finish({ status: 'failed', engine: 'live', errorCode: live.errorCode, deviceFallbackAvailable: deviceTTS !== null,
          messageKey: live.errorCode === 'PLAYBACK_BLOCKED' ? 'error.PLAYBACK_BLOCKED' : 'error.VOICE_FAILED' });
      }
      return finish(await deviceTurn(turn, request, { fallback: true, liveErrorCode: live.errorCode }));
    } finally {
      turn.settled = true;
      clearTimeout(turn.firstTimer);
      context.signal?.removeEventListener('abort', abort);
      if (active === turn) active = null;
      turn.finish();
    }
  }

  function cancelActive() {
    const turn = active;
    if (!turn) return Promise.resolve();
    turn.controller.abort();
    return turn.done;
  }
  return Object.freeze({
    speak(request, context = {}) {
      const id = ++serial;
      const previous = cancelActive();
      const run = queue.then(() => previous).then(() => runTurn(request, context, id));
      queue = run.catch(() => {});
      return run;
    },
    cancel() { return cancelActive(); },
    restart() {
      policy.restart();
      suspended = null; lastLiveError = null;
      const pending = cooldown;
      cooling = null; cooldown = null;
      pending?.abort();
    },
    async close() {
      closed = true;
      await cancelActive();
      lifetime.abort();
      const pending = cooldown;
      cooling = null; cooldown = null;
      pending?.abort();
      try { deviceTTS?.cancel?.(); } catch { /* Device speech is best effort. */ }
      await manager.close().catch(() => {});
      lease = null;
    },
    snapshot() {
      return Object.freeze({ live: suspended ? 'suspended' : cooling ? 'cooling' : 'ready',
        suspendedCode: suspended, lastLiveError, retries: policy.retries,
        sessionOpen: lease !== null && manager.isCurrent(lease.generation),
        generation: lease?.generation ?? null, active: active !== null, firstAudio: active?.firstAudio === true });
    },
  });
}
