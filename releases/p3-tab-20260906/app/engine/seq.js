// New implementation of design-v0.6 §§6.4, 7.2, 8.1, 8.2, 8.5, 9.3 and 14.1:
// one sequential flow PTT/text -> combined translate -> captions -> voice ->
// idle, with cancellation. Policy only; no legacy handlers are ported.
import { ProviderError, normalizeError } from '../providers/contract.js';
import { createRetryExecutor } from './retry.js';
import { createVoiceEngine } from './voice.js';
import { createState, TURN_PHASE } from '../state.js';

// Design values pending device measurement, not provider facts.
export const SEQ_POLICY = Object.freeze({ translateTimeoutMs: 30000, maxTextLength: 4000 });
// Every messageKey this engine writes beyond error.* and capture/voice keys.
export const SEQ_MESSAGE_KEYS = Object.freeze(['seq.silence', 'seq.unrecognized', 'seq.captionsOnly',
  'seq.cancelled', 'mode.changed', 'records.sharedEnded', 'error.VOICE_FAILED', 'error.ABORTED',
  'error.CREDENTIAL_REQUIRED']);

const validText = (value) => typeof value === 'string' && Boolean(value.trim())
  && value.length <= SEQ_POLICY.maxTextLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const terminal = new Set([TURN_PHASE.COMPLETED, TURN_PHASE.SILENCE, TURN_PHASE.UNRECOGNIZED,
  TURN_PHASE.ERROR, TURN_PHASE.CANCELLED]);
const silence = Object.freeze({ sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'no-speech', model: null });

/**
 * createSeqEngine({ config, capture, voiceEngine?, state?, deviceTTS?,
 *   getAudioContext?, sessionId?, setTimeout?, clearTimeout?, now?, random? })
 * config is createAppConfig()'s result; capture is createCapture()'s. Without
 * voiceEngine one is created on config.sessionManager (the single Live slot).
 * Call startRecording()/submitText()/replay() directly from a user gesture.
 * Each returns { turnId, done }; done resolves with the final turn record and
 * never rejects. One active turn: a new utterance cancels the previous
 * recording, request or playback first, so nothing records during playback.
 * Late results after cancel, key or language changes are discarded by turn
 * signal, state generation and the store's per-turn commit guard. A voice
 * failure never removes a committed translation; the user may re-read with
 * replay(turnId, { output: 'device' }). Key store events abort work, close the
 * Live socket and, when shared use ends, clear the in-memory conversation.
 * Records stay OFF (§14.1). close() ends everything; the engine is then dead.
 */
export function createSeqEngine({ config, capture, voiceEngine, state, deviceTTS = null, getAudioContext, isBusy = () => false,
  sessionId = globalThis.crypto.randomUUID(), setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout, now = () => Date.now(), random = Math.random } = {}) {
  if (typeof isBusy !== 'function' || typeof config?.router?.call !== 'function' || typeof config.keyStore?.subscribe !== 'function'
    || typeof config.resolveFallback !== 'function' || typeof capture?.start !== 'function'
    || (voiceEngine !== undefined && typeof voiceEngine?.speak !== 'function')
    || (voiceEngine === undefined && typeof getAudioContext !== 'function')) {
    throw new ProviderError('INVALID_REQUEST');
  }
  const timing = { setTimeout, clearTimeout, now, random };
  const store = state ?? createState({ defaults: config.defaults, sessionId, now });
  const voice = voiceEngine ?? createVoiceEngine({ router: config.router, deviceTTS, getAudioContext,
    sessionManager: config.sessionManager, ...timing });
  let active = null, serial = 0, closed = false, stopping = 0;
  const settling = new Set(), workListeners = new Set(), latest = new Map();
  const notifyWork = () => { for (const fn of workListeners) { try { fn(); } catch { /* Observer-owned failure. */ } } };
  const ensureOpen = () => { if (closed) throw new ProviderError('SESSION_CLOSED'); };
  // The composition root guards diagnostics and update application.
  const ensureStart = () => { ensureOpen(); if (stopping || isBusy()) throw new ProviderError('INVALID_REQUEST'); };
  const record = (turnId) => store.snapshot().turns.find((turn) => turn.turnId === turnId) ?? null;
  const stale = (turn) => turn.signal.aborted || store.snapshot().generation !== turn.generation;

  // Synchronous: the store already shows the cancellation when this returns.
  function abortActive() {
    const turn = active;
    if (!turn) return Promise.resolve();
    active = null;
    turn.controller.abort();
    turn.captureSession?.cancel();
    store.cancelTurn(turn.turnId);
    return turn.done;
  }

  function selection() {
    try { return config.keyStore.getSelection(); } catch { return null; }
  }
  // The selected source must currently hold a key; nothing records otherwise.
  function credential() {
    const address = selection();
    try { return address && config.keyStore.getMetadata(address.providerId, address.keySource) ? address : null; }
    catch { return null; }
  }
  function syncSelection() {
    if (!store.closed) store.setKeySelection(selection());
  }

  function launch(turnId, work) {
    const controller = new AbortController();
    const turn = { turnId, controller, signal: controller.signal, generation: store.snapshot().generation,
      captureSession: null, done: null };
    active = turn;
    latest.set(turnId, turn);
    turn.done = (async () => {
      let failure = null;
      try { await work(turn); } catch (raw) { failure = normalizeError(raw).code; }
      finally {
        if (active === turn) active = null;
        if (!store.closed && !stale(turn)) {
          const current = record(turnId);
          if (current && !terminal.has(current.phase)) {
            if (turn.signal.aborted || failure === 'ABORTED') store.cancelTurn(turnId);
            else store.failTurn(turnId, { errorCode: failure ?? 'PROVIDER_ERROR' });
          }
          store.finishTurn(turnId);
        }
        if (latest.get(turnId) === turn) latest.delete(turnId);
      }
      return record(turnId);
    })();
    settling.add(turn.done);
    notifyWork();
    turn.done.finally(() => { settling.delete(turn.done); notifyWork(); });
    return Object.freeze({ turnId, done: turn.done });
  }

  async function translateAndSpeak(turn, input) {
    const { turnId } = turn;
    const current = record(turnId);
    const address = credential();
    if (!address) { store.failTurn(turnId, { errorCode: 'CREDENTIAL_REQUIRED' }); return; }
    const route = { providerId: address.providerId, keySource: address.keySource, transport: store.snapshot().transport };
    const executor = createRetryExecutor({ call: config.router.call, ...timing, timeoutMs: SEQ_POLICY.translateTimeoutMs,
      context: { ...route, turnId, sessionId: store.snapshot().sessionId, generation: turn.generation, signal: turn.signal } });
    const request = { input, targetLanguage: current.targetLanguage,
      ...(current.sourceLanguage === 'auto' ? {} : { sourceLanguage: current.sourceLanguage }) };
    let result;
    try {
      result = await executor.run('translate', request, { resolveFallback: config.resolveFallback(route.providerId) });
    } catch (raw) {
      const error = normalizeError(raw);
      if (stale(turn) || error.code === 'ABORTED') { store.cancelTurn(turnId); return; }
      store.failTurn(turnId, { errorCode: error.code });
      return;
    }
    // A late REST result after cancel or a key/language change is discarded.
    if (stale(turn)) { store.cancelTurn(turnId); return; }
    if (!store.commitTranslation(turnId, result) || result.status !== 'ok') return;
    await speak(turn, route, result.translatedText, current.targetLanguage);
  }

  async function speak(turn, route, text, language, output = store.snapshot().voice.output) {
    const { turnId } = turn;
    const settings = store.snapshot().voice;
    if (output === 'off') { store.setVoiceResult(turnId, { status: 'off', messageKey: 'seq.captionsOnly' }); return; }
    if (!store.beginSpeaking(turnId)) return;
    let result;
    try {
      result = await voice.speak({ text, language, output, allowDeviceFallback: settings.allowDeviceFallback,
        ...(settings.voice ? { voice: settings.voice } : {}),
        ...(settings.deviceVoiceURI ? { deviceVoiceURI: settings.deviceVoiceURI } : {}) },
      { signal: turn.signal, turnId, sessionId: store.snapshot().sessionId, ...route });
    } catch { result = { status: 'failed', messageKey: 'error.VOICE_FAILED', errorCode: 'VOICE_FAILED' }; }
    if (turn.signal.aborted) {
      result = { ...result, status: 'cancelled', messageKey: 'error.ABORTED', errorCode: 'ABORTED' };
    }
    // Voice outcome sits beside the captions; the translation stays committed.
    if (latest.get(turnId) === turn && store.snapshot().generation === turn.generation) store.setVoiceResult(turnId, result);
  }

  function onKeyEvent(event) {
    if (closed) return;
    const aborted = active !== null;
    abortActive();
    const sharedEnded = event.type === 'shared-use-ended' || event.type === 'store-closed'
      || (event.type === 'key-deleted' && event.keySource === 'shared');
    if (!store.closed) {
      store.invalidate(aborted ? 'mode.changed' : null);
      syncSelection();
      if (sharedEnded) store.clearTurns(event.type === 'store-closed' ? null : 'records.sharedEnded');
    }
    // A socket authenticated with the previous key must not outlive it.
    try { Promise.resolve(config.sessionManager?.close?.()).catch(() => {}); } catch { /* Already closed. */ }
    if (event.type === 'key-changed' || event.type === 'selection-changed') voice.restart?.();
  }
  const unsubscribe = config.keyStore.subscribe(onKeyEvent);
  syncSelection();

  const api = {
    state: store,
    get sessionId() { return store.snapshot().sessionId; },
    // From a user gesture: cancels playback synchronously, then opens the mic.
    startRecording() {
      ensureStart();
      abortActive();
      const turnId = `turn-${++serial}`;
      store.beginTurn({ turnId, input: 'voice' });
      return launch(turnId, async (turn) => {
        if (!credential()) { store.failTurn(turnId, { errorCode: 'CREDENTIAL_REQUIRED' }); return; }
        turn.captureSession = capture.start({ signal: turn.signal, turnId, sessionId: store.snapshot().sessionId, generation: turn.generation });
        const captured = await turn.captureSession.done;
        turn.captureSession = null;
        if (stale(turn) || captured.status === 'cancelled') { store.cancelTurn(turnId); return; }
        if (captured.status === 'silence') { store.commitTranslation(turnId, silence); return; }
        if (captured.status !== 'success') { store.failTurn(turnId, { errorCode: captured.code, messageKey: captured.messageKey }); return; }
        store.beginTranslating(turnId);
        await translateAndSpeak(turn, { format: 'wav', audio: captured.wav });
      });
    },
    stopRecording() {
      ensureOpen();
      const turn = active;
      if (!turn?.captureSession) return null;
      const session = turn.captureSession;
      turn.captureSession = null;
      session.stop();
      return Object.freeze({ turnId: turn.turnId, done: turn.done });
    },
    submitText(text) {
      ensureStart();
      if (!validText(text)) throw new ProviderError('INVALID_REQUEST');
      abortActive();
      const turnId = `turn-${++serial}`;
      const sourceText = text.trim();
      store.beginTurn({ turnId, input: 'text', sourceText });
      return launch(turnId, (turn) => translateAndSpeak(turn, { format: 'text', text: sourceText }));
    },
    // Reprocesses the same record from its source text; no duplicate turn.
    retry(turnId) {
      ensureStart();
      const current = record(turnId);
      if (!current || !terminal.has(current.phase) || !current.sourceText) throw new ProviderError('INVALID_REQUEST');
      abortActive();
      if (!store.retryTurn(turnId)) throw new ProviderError('INVALID_REQUEST');
      return launch(turnId, (turn) => translateAndSpeak(turn, { format: 'text', text: current.sourceText }));
    },
    // Re-reads a completed translation, typically with device speech (§9.3).
    replay(turnId, { output = 'device' } = {}) {
      ensureStart();
      const current = record(turnId);
      if (!current || current.phase !== TURN_PHASE.COMPLETED || !['provider', 'device'].includes(output)) throw new ProviderError('INVALID_REQUEST');
      abortActive();
      return launch(turnId, async (turn) => {
        // Device speech needs no provider key; a provider re-read does.
        const address = credential() ?? (output === 'device' ? selection() : null);
        if (output === 'provider' && !address) {
          store.setVoiceResult(turnId, { status: 'failed', messageKey: 'error.CREDENTIAL_REQUIRED', errorCode: 'CREDENTIAL_REQUIRED' });
          return;
        }
        const route = { providerId: address?.providerId, keySource: address?.keySource, transport: store.snapshot().transport };
        await speak(turn, route, current.translatedText, current.targetLanguage, output);
      });
    },
    cancel() {
      ensureOpen();
      return abortActive();
    },
    // Changing the interpretation pair ends the active turn (§7.1).
    setInterpretation(pair) {
      ensureOpen();
      const aborted = active !== null;
      abortActive();
      store.setInterpretation(pair);
      store.invalidate(aborted ? 'mode.changed' : null);
    },
    // Voice settings apply from the next line; the current one is not cut.
    setVoice(options) {
      ensureOpen();
      store.setVoice(options);
    },
    async stop() {
      ensureOpen();
      stopping++;
      abortActive();
      notifyWork();
      try {
        await Promise.all([...settling]);
        await config.sessionManager?.close?.();
      } finally { stopping--; notifyWork(); }
    },
    subscribeWork(listener) { workListeners.add(listener); return () => workListeners.delete(listener); },
    subscribeVoice(listener) { return voice.subscribe?.(listener) ?? (() => {}); },
    snapshot() {
      return Object.freeze({ closed, busy: active !== null || settling.size > 0 || stopping > 0, activeTurnId: active?.turnId ?? null,
        recording: Boolean(active?.captureSession), voice: voice.snapshot?.() ?? null });
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      const pending = abortActive();
      try { capture.cancel(); } catch { /* Capture is already idle. */ }
      await Promise.all([pending, ...settling]);
      await voice.close?.();
      store.close();
      workListeners.clear();
    },
  };
  return Object.freeze(api);
}
