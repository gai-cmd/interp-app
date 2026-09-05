// New implementation of design-v0.6 §§7.2, 8.1, 9.3 and 14.1: the DOM-free
// store that owns sequential-interpretation state. Engines mutate it through
// the methods below; views only read snapshots. No legacy code is ported.
import { ProviderError } from './providers/contract.js';
import { APP_DEFAULTS } from './config.js';

// Final spelling of the P1-01 state contract. Session status names the phase
// of the active turn; turn phases are terminal except recording/translating.
export const SEQ_STATUS = Object.freeze({ IDLE: 'idle', RECORDING: 'recording',
  TRANSLATING: 'translating', SPEAKING: 'speaking' });
export const TURN_PHASE = Object.freeze({ RECORDING: 'recording', TRANSLATING: 'translating',
  COMPLETED: 'completed', SILENCE: 'silence', UNRECOGNIZED: 'unrecognized',
  ERROR: 'error', CANCELLED: 'cancelled' });
// Dictionary keys P1-15 renders for each status/phase (check-i18n verifies error.*).
export const STATUS_MESSAGE_KEYS = Object.freeze({ idle: 'seq.idle', recording: 'seq.recording',
  translating: 'seq.translating', speaking: 'seq.speaking' });
export const PHASE_MESSAGE_KEYS = Object.freeze({ recording: 'seq.recording', translating: 'seq.translating',
  completed: 'seq.completed', silence: 'seq.silence', unrecognized: 'seq.unrecognized',
  error: 'error.unknown', cancelled: 'seq.cancelled' });
export const VOICE_OUTPUTS = Object.freeze(['provider', 'device', 'off']);
// Only the current screen is kept, in memory (§14.1); the oldest turns drop.
export const MAX_TURNS = 100;
const terminal = new Set([TURN_PHASE.COMPLETED, TURN_PHASE.SILENCE, TURN_PHASE.UNRECOGNIZED,
  TURN_PHASE.ERROR, TURN_PHASE.CANCELLED]);
const resultPhase = Object.freeze({ ok: TURN_PHASE.COMPLETED, 'no-speech': TURN_PHASE.SILENCE,
  unrecognized: TURN_PHASE.UNRECOGNIZED });
const resultMessageKey = Object.freeze({ 'no-speech': 'seq.silence', unrecognized: 'seq.unrecognized' });

const language = (value) => typeof value === 'string' && /^(ko|en|ja)$/.test(value);
const sourceLanguage = (value) => value === 'auto' || language(value);
const text = (value, max = 4000) => typeof value === 'string' && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const messageKey = (value) => value === undefined || (typeof value === 'string'
  && /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(value));
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const invalid = () => { throw new ProviderError('INVALID_REQUEST'); };
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
  }
  return value;
}

/**
 * createState({ defaults?, sessionId, now? }) returns a synchronous store:
 * { snapshot(), subscribe(listener), ...mutators, close() }. Snapshots are
 * frozen plain data safe for rendering with textContent; they never contain
 * keys, raw provider errors or audio. One active turn at a time; each turn is
 * a single record that is updated in place (retry never appends a duplicate).
 * commitTranslation applies at most once per turn attempt; voice results are
 * stored separately and never alter a committed translation. records.persist
 * is fixed OFF in P1 (§14.1): turns live only in memory until clearTurns().
 * generation increases on invalidate(); engines discard late results whose
 * generation no longer matches.
 */
export function createState({ defaults = APP_DEFAULTS, sessionId, now = () => Date.now() } = {}) {
  if (!identifier(sessionId) || typeof now !== 'function' || !defaults) invalid();
  const listeners = new Set();
  let closed = false;
  let sequence = 0;
  let state = {
    sessionId, generation: 0, status: SEQ_STATUS.IDLE, activeTurnId: null, notice: null,
    keySelection: null, transport: defaults.transport ?? 'direct',
    interpretation: { sourceLanguage: defaults.interpretation?.sourceLanguage ?? 'ko',
      targetLanguage: defaults.interpretation?.targetLanguage ?? 'ja' },
    voice: { output: defaults.voice?.output ?? 'provider', allowDeviceFallback: defaults.voice?.allowDeviceFallback !== false,
      voice: null, deviceVoiceURI: null },
    records: { persist: false, messageKey: 'records.off' },
    turns: [],
  };
  let snapshot = freeze(state);
  if (!sourceLanguage(state.interpretation.sourceLanguage) || !language(state.interpretation.targetLanguage)
    || !VOICE_OUTPUTS.includes(state.voice.output) || state.transport !== 'direct') invalid();

  function commit(next) {
    state = next;
    snapshot = freeze(next);
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* Consumer-owned failure. */ }
    }
    return snapshot;
  }
  const open = () => { if (closed) throw new ProviderError('SESSION_CLOSED'); };
  const find = (turnId) => state.turns.find((turn) => turn.turnId === turnId);
  function patchTurn(turnId, patch) {
    return commit({ ...state, turns: state.turns.map((turn) => turn.turnId === turnId ? { ...turn, ...patch } : turn) });
  }
  function deactivate(next, turnId) {
    return next.activeTurnId === turnId ? { ...next, status: SEQ_STATUS.IDLE, activeTurnId: null } : next;
  }
  function endTurn(turnId, patch) {
    const turn = find(turnId);
    if (!turn || terminal.has(turn.phase)) return false;
    const turns = state.turns.map((item) => item.turnId === turnId ? { ...item, ...patch, endedAt: now() } : item);
    commit(deactivate({ ...state, turns }, turnId));
    return true;
  }

  const api = {
    snapshot() { return snapshot; },
    subscribe(listener) {
      open();
      if (typeof listener !== 'function') invalid();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get closed() { return closed; },
    // Mirrors the key store selection for badges; the store stays the authority.
    setKeySelection(selection) {
      open();
      if (selection !== null && (!identifier(selection?.providerId) || !['personal', 'shared'].includes(selection?.keySource))) invalid();
      return commit({ ...state, keySelection: selection === null ? null
        : { providerId: selection.providerId, keySource: selection.keySource } });
    },
    setInterpretation({ sourceLanguage: source, targetLanguage: target } = {}) {
      open();
      if (!sourceLanguage(source) || !language(target) || source === target) invalid();
      return commit({ ...state, interpretation: { sourceLanguage: source, targetLanguage: target } });
    },
    setVoice({ output = state.voice.output, allowDeviceFallback = state.voice.allowDeviceFallback,
      voice = state.voice.voice, deviceVoiceURI = state.voice.deviceVoiceURI } = {}) {
      open();
      if (!VOICE_OUTPUTS.includes(output) || typeof allowDeviceFallback !== 'boolean'
        || (voice !== null && !identifier(voice)) || (deviceVoiceURI !== null && !text(deviceVoiceURI, 512))) invalid();
      return commit({ ...state, voice: { output, allowDeviceFallback, voice, deviceVoiceURI } });
    },
    setNotice(key) {
      open();
      if (key !== null && (!messageKey(key) || key === undefined)) invalid();
      return commit({ ...state, notice: key === null ? null : { messageKey: key, at: now() } });
    },
    // Invalidates every in-flight result; the engine aborts work separately.
    invalidate(noticeKey = null) {
      open();
      if (noticeKey !== null && (!messageKey(noticeKey) || noticeKey === undefined)) invalid();
      commit({ ...state, generation: state.generation + 1,
        notice: noticeKey === null ? state.notice : { messageKey: noticeKey, at: now() } });
      return state.generation;
    },
    beginTurn({ turnId, input, sourceText } = {}) {
      open();
      if (!identifier(turnId) || !['text', 'voice'].includes(input) || find(turnId)
        || (input === 'text' ? !text(sourceText) || !sourceText.trim() : sourceText !== undefined)) invalid();
      if (state.activeTurnId !== null) throw new ProviderError('INVALID_REQUEST');
      const phase = input === 'voice' ? TURN_PHASE.RECORDING : TURN_PHASE.TRANSLATING;
      const turn = { turnId, sequence: ++sequence, input, phase, createdAt: now(), endedAt: null,
        sourceLanguage: state.interpretation.sourceLanguage, targetLanguage: state.interpretation.targetLanguage,
        sourceText: input === 'text' ? sourceText : '', translatedText: '', detectedLanguage: null, model: null,
        messageKey: undefined, errorCode: null, attempts: 1, voice: null };
      commit({ ...state, status: phase, activeTurnId: turnId, turns: [...state.turns, turn].slice(-MAX_TURNS) });
      return turnId;
    },
    // Recording ended with audio; the same turn now waits for the provider.
    beginTranslating(turnId) {
      open();
      const turn = find(turnId);
      if (!turn || turn.phase !== TURN_PHASE.RECORDING || state.activeTurnId !== turnId) return false;
      commit({ ...state, status: SEQ_STATUS.TRANSLATING,
        turns: state.turns.map((item) => item.turnId === turnId ? { ...item, phase: TURN_PHASE.TRANSLATING } : item) });
      return true;
    },
    // Reprocess the same record (§7.2 retry): no duplicate, previous result cleared.
    retryTurn(turnId) {
      open();
      const turn = find(turnId);
      if (!turn || !terminal.has(turn.phase) || state.activeTurnId !== null || !turn.sourceText) return false;
      const reset = { phase: TURN_PHASE.TRANSLATING, translatedText: '', detectedLanguage: null, model: null,
        messageKey: undefined, errorCode: null, endedAt: null, attempts: turn.attempts + 1, voice: null,
        sourceLanguage: state.interpretation.sourceLanguage, targetLanguage: state.interpretation.targetLanguage };
      commit({ ...state, status: SEQ_STATUS.TRANSLATING, activeTurnId: turnId,
        turns: state.turns.map((item) => item.turnId === turnId ? { ...item, ...reset } : item) });
      return true;
    },
    // Applies once per attempt; a second commit or a late one is ignored.
    // Silence detected by capture commits 'no-speech' straight from recording.
    commitTranslation(turnId, result) {
      open();
      const turn = find(turnId);
      if (!turn || state.activeTurnId !== turnId || terminal.has(turn.phase)
        || (turn.phase === TURN_PHASE.RECORDING && result?.status === 'ok')) return false;
      if (!result || !Object.hasOwn(resultPhase, result.status) || !text(result.sourceText, 16000)
        || !text(result.translatedText ?? '', 16000) || (result.model !== null && typeof result.model !== 'string')
        || typeof result.detectedLanguage !== 'string') invalid();
      const phase = resultPhase[result.status];
      const turns = state.turns.map((item) => item.turnId !== turnId ? item : { ...item, phase,
        sourceText: result.status === 'ok' ? result.sourceText : item.sourceText,
        translatedText: result.status === 'ok' ? result.translatedText : '',
        detectedLanguage: result.detectedLanguage, model: result.model,
        messageKey: resultMessageKey[result.status], errorCode: null,
        ...(phase === TURN_PHASE.COMPLETED ? {} : { endedAt: now() }) });
      // A completed turn stays active for voice output; others end here.
      commit(phase === TURN_PHASE.COMPLETED ? { ...state, turns } : deactivate({ ...state, turns }, turnId));
      return true;
    },
    failTurn(turnId, { errorCode = null, messageKey: key } = {}) {
      open();
      if (!messageKey(key) || (errorCode !== null && !/^[A-Z][A-Z0-9_]{0,39}$/.test(errorCode))) invalid();
      return endTurn(turnId, { phase: TURN_PHASE.ERROR, errorCode,
        messageKey: key ?? (errorCode ? `error.${errorCode}` : 'error.unknown') });
    },
    cancelTurn(turnId) {
      open();
      const turn = find(turnId);
      if (!turn) return false;
      // A completed turn keeps its captions; only its playback is cancelled.
      if (terminal.has(turn.phase)) {
        if (state.activeTurnId !== turnId) return false;
        commit(deactivate({ ...state }, turnId));
        return true;
      }
      return endTurn(turnId, { phase: TURN_PHASE.CANCELLED, errorCode: 'ABORTED', messageKey: 'seq.cancelled' });
    },
    // Also re-activates an idle completed turn for a user-chosen re-read.
    beginSpeaking(turnId) {
      open();
      const turn = find(turnId);
      if (!turn || turn.phase !== TURN_PHASE.COMPLETED || ![null, turnId].includes(state.activeTurnId)) return false;
      commit({ ...state, status: SEQ_STATUS.SPEAKING, activeTurnId: turnId });
      return true;
    },
    // Voice output is recorded beside the translation and never replaces it.
    setVoiceResult(turnId, result) {
      open();
      const turn = find(turnId);
      if (!turn || turn.phase !== TURN_PHASE.COMPLETED) return false;
      if (!result || typeof result.status !== 'string' || !/^[a-z]{1,20}$/.test(result.status)
        || !messageKey(result.messageKey)) invalid();
      patchTurn(turnId, { voice: { status: result.status, engine: result.engine ?? null,
        messageKey: result.messageKey, errorCode: result.errorCode ?? null, fallback: result.fallback === true,
        deviceFallbackAvailable: result.deviceFallbackAvailable === true, gap: result.gap === true,
        said: typeof result.said === 'string' ? result.said : '' } });
      return true;
    },
    // The turn leaves the active slot; captions and voice outcome stay visible.
    finishTurn(turnId) {
      open();
      const turn = find(turnId);
      if (!turn || state.activeTurnId !== turnId) return false;
      if (!terminal.has(turn.phase)) return false;
      commit(deactivate({ ...state, turns: state.turns.map((item) => item.turnId === turnId && item.endedAt === null
        ? { ...item, endedAt: now() } : item) }, turnId));
      return true;
    },
    clearTurns(noticeKey = null) {
      open();
      if (noticeKey !== null && (!messageKey(noticeKey) || noticeKey === undefined)) invalid();
      if (state.activeTurnId !== null) throw new ProviderError('INVALID_REQUEST');
      return commit({ ...state, turns: [], notice: noticeKey === null ? state.notice : { messageKey: noticeKey, at: now() } });
    },
    close() {
      if (closed) return snapshot;
      closed = true;
      const result = commit({ ...state, status: SEQ_STATUS.IDLE, activeTurnId: null, turns: [], keySelection: null });
      listeners.clear();
      return result;
    },
  };
  return Object.freeze(api);
}
