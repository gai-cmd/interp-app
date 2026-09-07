// New implementation of design-v0.6 §§6.1, 6.2, 7.4, 9.1 and 20.3: user-started
// connection checks, one capability at a time. P2 adds shared activity ownership
// and model-scoped checks (design-p2 §9/§17); no legacy code is ported. Results are kept per
// (providerId, keySource, check, requestedModel) and cleared when that key changes. Nothing
// here runs on its own: no check starts when a key is saved, and a check of
// one capability never marks another one available. Live checks go through
// the app's single session slot (config.sessionManager). No legacy code.
import { isPolicyError, PolicyError, POLICY_ERROR_CODES } from '../policy/errors.js';
import { createActivity } from './activity.js';
import { CAPABILITIES, ERROR_CODES, ProviderError, normalizeError as normalizeProviderError } from '../providers/contract.js';
import { createBudget, withDeadline } from './retry.js';
import { createVoiceEngine } from './voice.js';
import { createPCMPlayer } from '../audio/pcm-player.js';

// Policy denials are terminal application outcomes, not provider failures.
const normalizeError = error => isPolicyError(error) ? new PolicyError(error.code) : normalizeProviderError(error);

export const DIAGNOSTIC_KINDS = Object.freeze(['text', 'ptt', 'voice', 'live', 'microphone', 'playback']);
// Which registered capability a check attests; local checks attest none.
export const KIND_CAPABILITY = Object.freeze({ text: 'translate', ptt: 'stt', voice: 'voice', live: 'live',
  microphone: null, playback: null });
// Capability table states (§7.4): registration alone is never 'available'.
export const CAPABILITY_STATES = Object.freeze(['unsupported', 'planned', 'hubRequired', 'untested', 'running',
  'available', 'failed', 'cancelled']);
// Design values pending device measurement, not provider facts.
export const DIAGNOSTICS_POLICY = Object.freeze({ requestTimeoutMs: 30000, captureTimeoutMs: 40000,
  playbackTimeoutMs: 15000, toneMs: 300, toneHz: 440, toneAmplitude: 0.2, maxResults: 64 });
// Fixed provider inputs for checks. Model input only, never rendered as UI text.
export const SAMPLE_TEXT = Object.freeze({ ko: '안녕하세요. 연결 확인입니다.',
  en: 'Hello. This is a connection check.', ja: 'こんにちは。接続確認です。' });
// Every messageKey a result can carry beyond error.<CODE>; check-i18n keeps error.* complete.
export const DIAGNOSTIC_MESSAGE_KEYS = Object.freeze(['seq.silence', 'seq.unrecognized', 'seq.cancelled',
  'capability.planned', 'capability.unsupported', 'capability.hubRequired', 'voice.partialFailure',
  'voice.deviceUnavailable', 'error.VOICE_FAILED', 'error.PLAYBACK_BLOCKED', 'error.ABORTED']);

const network = new Set(['text', 'ptt', 'voice', 'live']);
const identifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const language = (value) => typeof value === 'string' && /^(ko|en|ja)$/.test(value);
const safeCodes = new Set([...ERROR_CODES, ...POLICY_ERROR_CODES, 'VOICE_FAILED', 'PLAYBACK_BLOCKED', 'MICROPHONE_UNAVAILABLE', 'MICROPHONE_DENIED']);
const errorCode = (value) => safeCodes.has(value) ? value : null;
const resultKey = ({ providerId, keySource, kind, requestedModel }) =>
  JSON.stringify([providerId ?? null, keySource ?? null, kind, requestedModel ?? null]);
const otherLanguage = (target) => ['ko', 'en', 'ja'].find((value) => value !== target);

/** PCM16 LE mono 24 kHz test tone for the playback check; deterministic and short. */
export function tonePCM({ ms = DIAGNOSTICS_POLICY.toneMs, hz = DIAGNOSTICS_POLICY.toneHz,
  amplitude = DIAGNOSTICS_POLICY.toneAmplitude, sampleRate = 24000 } = {}) {
  const length = Math.max(1, Math.round(sampleRate * ms / 1000));
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    // Fade in and out over 10 ms so the tone starts and ends without a click.
    const edge = Math.min(1, i / (sampleRate * 0.01), (length - 1 - i) / (sampleRate * 0.01));
    samples[i] = Math.round(Math.sin(2 * Math.PI * hz * i / sampleRate) * amplitude * edge * 32767);
  }
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * createDiagnostics({ config, voiceEngine?, capture?, getAudioContext?,
 *   sessionId?, now?, setTimeout?, clearTimeout?, random? })
 * config is createAppConfig()'s result. Pass the same voiceEngine the
 * sequential engine uses (P1-19); otherwise one is created on
 * config.sessionManager so the app still never holds two Live sessions.
 * capture is createCapture()'s result (shared with the sequential engine; only
 * one capture runs at a time). Returns { kinds, capabilities(route), run(kind,
 * options), cancel(), snapshot(), subscribe(listener), close() }.
 * run() is called from a user gesture and returns { kind, done, stop, cancel };
 * done always resolves with a frozen result record { kind, capability,
 * providerId, keySource, state, errorCode, messageKey, model, at }. stop() ends
 * a microphone/PTT capture early; a new run cancels the running check first.
 * Network checks use the selected (providerId, keySource) unless options name
 * another; the router refuses credentials outside the current selection.
 */
export function createDiagnostics({ config, voiceEngine, capture = null, getAudioContext = null,
  isBusy = () => false, activity = createActivity(), sessionId = 'diagnostics', now = () => performance.now(), setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout, random = Math.random } = {}) {
  if (typeof isBusy !== 'function' || typeof config?.router?.call !== 'function' || typeof config.registry?.get !== 'function'
    || typeof config.keyStore?.subscribe !== 'function' || typeof config.sessionManager?.replace !== 'function'
    || (voiceEngine !== undefined && typeof voiceEngine?.speak !== 'function')
    || (capture !== null && typeof capture?.start !== 'function')
    || (getAudioContext !== null && typeof getAudioContext !== 'function')
    || typeof now !== 'function' || typeof activity?.acquire !== 'function'
    || typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') {
    throw new ProviderError('INVALID_REQUEST');
  }
  const readNow = now;
  let lastTime = 0;
  now = () => {
    const value = readNow();
    if (Number.isFinite(value)) lastTime = Math.max(lastTime, Math.min(Number.MAX_SAFE_INTEGER, value));
    return lastTime;
  };
  const timing = { setTimeout, clearTimeout, now, random };
  const ownsVoice = voiceEngine === undefined;
  // Without an audio context Live voice cannot play; the check reports that.
  const audioContext = getAudioContext ?? (() => null);
  const voice = voiceEngine ?? createVoiceEngine({ router: config.router, deviceTTS: null, getAudioContext: audioContext,
    sessionManager: config.sessionManager, ...timing });
  const listeners = new Set();
  const results = new Map();
  let activityLease = null, liveUsed = false;
  const pending = new Set();
  let active = null, serial = 0, generation = 0, closed = false;

  function notify() {
    const snapshot = api.snapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* Consumer-owned failure. */ }
    }
  }
  function selection() {
    try { return config.keyStore.getSelection(); } catch { return null; }
  }
  function descriptor(providerId) {
    try { return config.registry.get(providerId).descriptor; } catch { return null; }
  }
  function targetOf(options) {
    return language(options.targetLanguage) ? options.targetLanguage : config.defaults?.interpretation?.targetLanguage ?? 'ja';
  }
  function sourceOf(options, target) {
    return language(options.sourceLanguage) && options.sourceLanguage !== target ? options.sourceLanguage : otherLanguage(target);
  }
  // Static routing state of one capability: what registration allows, before any check.
  function routing(desc, name) {
    const cap = desc.capabilities[name];
    if (cap.implementation === 'unsupported') return { state: 'unsupported', route: null };
    const direct = desc.browserDirect && cap.transports.includes('direct');
    const route = direct ? 'direct' : cap.transports.includes('hub') ? 'hub' : null;
    if (cap.implementation !== 'ready') return { state: 'planned', route };
    return { state: direct ? 'untested' : 'hubRequired', route };
  }
  function record(turn, fields) {
    const state = CAPABILITY_STATES.includes(fields.state) ? fields.state : 'failed';
    const code = errorCode(fields.errorCode);
    const messageKey = DIAGNOSTIC_MESSAGE_KEYS.includes(fields.messageKey)
      || (code && fields.messageKey === `error.${code}`) ? fields.messageKey : undefined;
    const models = descriptor(turn.route?.providerId)?.capabilities[turn.capability]?.models ?? [];
    return Object.freeze({ kind: turn.kind, capability: turn.capability, providerId: turn.route?.providerId ?? null,
      keySource: turn.route?.keySource ?? null, state, errorCode: code,
      messageKey: messageKey ?? (state === 'failed' && code ? `error.${code}` : state === 'cancelled' ? 'seq.cancelled' : undefined),
      model: models.includes(fields.model) ? fields.model : null, requestedModel: turn.model,
      ...(Number.isFinite(fields.setupMs) ? { setupMs: fields.setupMs } : {}), sequence: turn.sequence, at: now() });
  }
  // A check cancelled by a newer one must not overwrite the newer result.
  function store(result) {
    const key = resultKey(result);
    const existing = results.get(key);
    if (existing && existing.sequence > result.sequence) return;
    results.delete(key);
    if (results.size >= DIAGNOSTICS_POLICY.maxResults) results.delete(results.keys().next().value);
    results.set(key, result);
  }

  // One attempt, no fallback: a check reports what the default path does now.
  function call(turn, capability, request) {
    request = { ...request, ...(turn.explicitModel ? { model: turn.model } : {}) };
    const context = { ...turn.route, turnId: turn.turnId, sessionId, generation: turn.generation,
      budget: createBudget({ limit: 1 }) };
    return withDeadline((signal) => config.router.call(capability, request, { ...context, signal }),
      { ...timing, signal: turn.signal, timeoutMs: DIAGNOSTICS_POLICY.requestTimeoutMs });
  }

  async function textCheck(turn, options) {
    const target = targetOf(options);
    const source = sourceOf(options, target);
    const request = { input: { format: 'text', text: SAMPLE_TEXT[source] }, sourceLanguage: source, targetLanguage: target };
    const result = await call(turn, 'translate', request);
    if (result?.status !== 'ok' || typeof result.translatedText !== 'string' || !result.translatedText.trim()) {
      return { state: 'failed', errorCode: 'INVALID_RESULT', model: result?.model };
    }
    return { state: 'available', model: result.model };
  }

  // Microphone capture starts synchronously (inside the user gesture).
  function captureCheck(turn) {
    if (!capture) return Promise.resolve({ status: 'error', code: 'MICROPHONE_UNAVAILABLE' });
    let session;
    try {
      session = capture.start({ signal: turn.signal, turnId: turn.turnId, sessionId, generation: turn.generation });
    } catch { return Promise.resolve({ status: 'error', code: 'MICROPHONE_UNAVAILABLE' }); }
    turn.stop = () => { try { session.stop(); } catch { /* Already ended. */ } };
    turn.capturing = true;
    notify();
    return withDeadline(() => session.done, { ...timing, signal: turn.signal, timeoutMs: DIAGNOSTICS_POLICY.captureTimeoutMs })
      .catch((error) => {
        try { session.cancel(); } catch { /* Already ended. */ }
        const aborted = normalizeError(error).code === 'ABORTED';
        return { status: aborted ? 'cancelled' : 'error', code: aborted ? 'ABORTED' : 'MICROPHONE_UNAVAILABLE' };
      })
      .finally(() => { turn.capturing = false; turn.stop = null; });
  }
  function captureOutcome(captured) {
    if (captured.status === 'cancelled') return { state: 'cancelled' };
    if (captured.status === 'silence') return { state: 'failed', messageKey: 'seq.silence' };
    if (captured.status !== 'success') {
      return { state: 'failed', errorCode: captured.code ?? 'MICROPHONE_UNAVAILABLE', messageKey: captured.messageKey };
    }
    return null;
  }

  async function pttCheck(turn, options) {
    const captured = await captureCheck(turn);
    const failure = captureOutcome(captured);
    if (failure) return failure;
    const source = options.sourceLanguage;
    const request = { input: { format: 'wav', audio: captured.wav }, ...(language(source) ? { language: source } : {}) };
    const result = await call(turn, 'stt', request);
    if (result?.status === 'no-speech') return { state: 'failed', messageKey: 'seq.silence', model: result.model };
    if (result?.status === 'unrecognized') return { state: 'failed', messageKey: 'seq.unrecognized', model: result.model };
    if (result?.status !== 'ok' || typeof result.sourceText !== 'string' || !result.sourceText.trim()) {
      return { state: 'failed', errorCode: 'INVALID_RESULT', model: result?.model };
    }
    return { state: 'available', model: result.model };
  }

  async function voiceCheck(turn, options) {
    const target = targetOf(options);
    // A user-started check is a restart (§9.3): cooldown and suspension end here.
    voice.restart?.();
    const result = await voice.speak({ text: SAMPLE_TEXT[target], language: target, output: 'provider', allowDeviceFallback: false,
      ...(typeof options.voice === 'string' ? { voice: options.voice } : {}),
      ...(typeof options.model === 'string' ? { model: options.model } : {}) },
    { signal: turn.signal, turnId: turn.turnId, sessionId, ...turn.route });
    if (result.status === 'cancelled') return { state: 'cancelled' };
    if (result.status === 'completed' && result.engine === 'live' && result.firstAudio) {
      return { state: 'available', model: result.model };
    }
    return { state: 'failed', errorCode: result.liveErrorCode ?? result.errorCode ?? 'VOICE_FAILED',
      messageKey: result.messageKey, model: result.model };
  }

  // Opens and closes one simultaneous session through the shared slot (§9.1).
  async function liveCheck(turn, options) {
    liveUsed = true;
    const started = now();
    const target = targetOf(options);
    const request = { input: { format: 'pcm16' }, sourceLanguage: sourceOf(options, target), targetLanguage: target,
      ...(options.model ? { model: turn.model } : {}) };
    const open = (context) => config.router.call('live', request, { ...context, ...turn.route, budget: createBudget({ limit: 1 }) });
    const opening = config.sessionManager.replace(open, { signal: turn.signal, turnId: turn.turnId, sessionId });
    opening.catch(() => {});
    let lease;
    try {
      lease = await withDeadline(() => opening, { ...timing, signal: turn.signal, timeoutMs: DIAGNOSTICS_POLICY.requestTimeoutMs });
    } catch (error) {
      // A session that still opens after the deadline is closed, never kept.
      opening.then((late) => late.close()).catch(() => {});
      throw error;
    }
    const setupMs = Math.max(0, now() - started);
    await lease.close();
    return { state: 'available', model: turn.model, setupMs };
  }

  async function microphoneCheck(turn) {
    return captureOutcome(await captureCheck(turn)) ?? { state: 'available' };
  }

  async function playbackCheck(turn) {
    let context = null;
    try { context = audioContext(); } catch { context = null; }
    if (!context) return { state: 'failed', errorCode: 'PLAYBACK_BLOCKED' };
    const player = createPCMPlayer({ context, signal: turn.signal, turnId: turn.turnId, sessionId, generation: turn.generation,
      setTimeout, clearTimeout, timeoutMs: DIAGNOSTICS_POLICY.playbackTimeoutMs });
    if (!(await player.resume())) {
      const playback = await player.done;
      return playback.status === 'cancelled' ? { state: 'cancelled' } : { state: 'failed', errorCode: 'PLAYBACK_BLOCKED' };
    }
    if (turn.signal.aborted) { player.cancel(); return { state: 'cancelled' }; }
    player.enqueue(tonePCM());
    const playback = await player.finish();
    if (playback.status === 'completed') return { state: 'available' };
    if (playback.status === 'cancelled') return { state: 'cancelled' };
    return { state: 'failed', errorCode: playback.status === 'timeout' ? 'TIMEOUT' : 'PLAYBACK_BLOCKED', messageKey: playback.messageKey };
  }

  const checks = { text: textCheck, ptt: pttCheck, voice: voiceCheck, live: liveCheck, microphone: microphoneCheck, playback: playbackCheck };

  async function runTurn(turn, options) {
    try {
      if (closed || turn.signal.aborted) return record(turn, { state: 'cancelled' });
      if (network.has(turn.kind)) {
        if (!turn.route) return record(turn, { state: 'failed', errorCode: 'CREDENTIAL_REQUIRED' });
        const desc = descriptor(turn.route.providerId);
        if (!desc) return record(turn, { state: 'failed', errorCode: 'UNKNOWN_PROVIDER' });
        const { state } = routing(desc, turn.capability);
        // Unavailable paths are reported without any credential, network or microphone use.
        if (state !== 'untested') return record(turn, { state, messageKey: `capability.${state}` });
        let holds = false;
        try { holds = config.keyStore.getMetadata(turn.route.providerId, turn.route.keySource) !== null; } catch { holds = false; }
        if (!holds) return record(turn, { state: 'failed', errorCode: 'CREDENTIAL_REQUIRED' });
      }
      const outcome = await checks[turn.kind](turn, options);
      if (turn.signal.aborted) return record(turn, { state: 'cancelled' });
      return record(turn, outcome);
    } catch (raw) {
      const error = normalizeError(raw);
      if (turn.signal.aborted || error.code === 'ABORTED') return record(turn, { state: 'cancelled' });
      return record(turn, { state: 'failed', errorCode: error.code });
    }
  }

  function cancelActive() {
    const turn = active;
    if (!turn) return Promise.resolve();
    turn.controller.abort();
    return turn.done;
  }

  function onKeyEvent(event) {
    if (closed) return;
    generation += 1;
    cancelActive();
    if (event.type === 'store-closed' || event.type === 'selection-changed') {
      for (const [key, result] of results) if (result.providerId !== null) results.delete(key);
    } else {
      // Results describe one key; a changed or removed key invalidates them.
      for (const [key, result] of results) {
        if (result.providerId === event.providerId && result.keySource === event.keySource) results.delete(key);
      }
    }
    notify();
  }
  let unsubscribe = () => {};
  try { unsubscribe = config.keyStore.subscribe(onKeyEvent); } catch { closed = true; }

  const api = Object.freeze({
    kinds: DIAGNOSTIC_KINDS,
    /** Per-capability table for one route; without a check nothing is 'available'. */
    capabilities(route = selection(), options = {}) {
      const desc = route && identifier(route.providerId) ? descriptor(route.providerId) : null;
      return Object.freeze(CAPABILITIES.map((name) => {
        if (!desc) return Object.freeze({ capability: name, implementation: null, route: null, state: 'untested', result: null });
        const cap = desc.capabilities[name];
        const { state, route: path } = routing(desc, name);
        const kind = DIAGNOSTIC_KINDS.find((item) => KIND_CAPABILITY[item] === name);
        const running = active && !active.settled && active.kind === kind && active.route?.providerId === route.providerId
          && active.route.keySource === route.keySource && active.model === (options.model ?? cap.models[0] ?? null);
        let result = state === 'untested' && ['personal', 'shared'].includes(route.keySource)
          ? results.get(resultKey({ providerId: route.providerId, keySource: route.keySource, kind,
            requestedModel: options.model ?? cap.models[0] ?? null })) ?? null : null;
        if (result && result.requestedModel !== (options.model ?? cap.models[0] ?? null)) result = null;
        return Object.freeze({ capability: name, implementation: cap.implementation, route: path,
          state: running ? 'running' : result ? result.state : state, result });
      }));
    },
    run(kind, options = {}) {
      if (closed) throw new ProviderError('SESSION_CLOSED');
      // The composition root guards sequential work and update application.
      if (activityLease?.signal.aborted) throw new ProviderError('SESSION_LIMIT');
      if (isBusy()) throw new ProviderError('INVALID_REQUEST');
      if (!DIAGNOSTIC_KINDS.includes(kind) || !options || typeof options !== 'object') throw new ProviderError('INVALID_REQUEST');
      let route = null;
      if (network.has(kind)) {
        const chosen = identifier(options.providerId) && ['personal', 'shared'].includes(options.keySource)
          ? { providerId: options.providerId, keySource: options.keySource } : selection();
        route = chosen ? Object.freeze({ providerId: chosen.providerId, keySource: chosen.keySource, transport: 'direct' }) : null;
      }
      const models = descriptor(route?.providerId)?.capabilities[KIND_CAPABILITY[kind]]?.models ?? [];
      if (options.model !== undefined && !models.includes(options.model)) throw new ProviderError('MODEL_UNSUPPORTED');
      if (!activityLease) activityLease = activity.acquire('diagnostics', {
        cancel() { for (const item of pending) item.controller.abort(); },
        async close() {
          await Promise.all([...pending].map(item => item.work));
          if (liveUsed) await config.sessionManager.close();
        }
      });
      const controller = new AbortController();
      const turn = { kind, capability: KIND_CAPABILITY[kind], route, controller, signal: controller.signal,
        explicitModel: options.model !== undefined, model: options.model ?? models[0] ?? null, turnId: `check-${++serial}`, sequence: serial, generation, stop: null, capturing: false, settled: false, done: null };
      const abort = () => controller.abort();
      options.signal?.addEventListener?.('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      // The previous check is aborted, not awaited: capture must start in this gesture.
      cancelActive();
      active = turn;
      pending.add(turn);
      turn.work = runTurn(turn, options);
      turn.done = turn.work.then(async (result) => {
        pending.delete(turn);
        turn.settled = true;
        options.signal?.removeEventListener?.('abort', abort);
        if (active === turn) {
          const lease = activityLease;
          try { await lease.close(); } catch (raw) {
            turn.settled = true; active = null;
            const failed = record(turn, { state: 'failed', errorCode: normalizeError(raw).code });
            if (turn.generation === generation) store(failed);
            notify(); return failed;
          }
          liveUsed = false;
          if (activityLease === lease) activityLease = null;
          if (active === turn) active = null;
        }
        // A result for a key replaced meanwhile is not kept.
        if (result.providerId === null || turn.generation === generation) store(result);
        notify();
        return result;
      });
      notify();
      return Object.freeze({ kind, done: turn.done,
        stop() { if (active === turn) turn.stop?.(); },
        cancel() { if (active === turn) controller.abort(); return turn.done; } });
    },
    cancel() { return cancelActive(); },
    snapshot() {
      const turn = active && !active.settled ? active : null;
      return Object.freeze({ running: turn ? Object.freeze({ kind: turn.kind, providerId: turn.route?.providerId ?? null,
        keySource: turn.route?.keySource ?? null, capturing: turn.capturing }) : null,
      results: Object.freeze([...results.values()]), generation, closed });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      await cancelActive();
      if (ownsVoice) await voice.close?.();
      results.clear();
      listeners.clear();
    },
  });
  return api;
}
