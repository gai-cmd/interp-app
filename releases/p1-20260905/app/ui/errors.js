// New implementation of design-v0.6 §§7.2, 7.5 and 12: DOM-free mapping from
// P1-14 snapshots (status, turn phase, voice outcome, notices, thrown engine
// errors) to dictionary keys and display decisions. Views render the returned
// keys with i18n.t() and textContent; no provider text or raw error is echoed.
import { PHASE_MESSAGE_KEYS, SEQ_STATUS, STATUS_MESSAGE_KEYS, TURN_PHASE } from '../state.js';
import { normalizeError } from '../providers/contract.js';

// Design values, not measurements: how long a notice stays before the UI
// clears it, and the RMS treated as a full meter for the input level.
export const NOTICE_DURATION_MS = 8000;
export const LEVEL_FULL_SCALE_RMS = 0.25;
export const UNKNOWN_KEY = 'error.unknown';

const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
const terminal = new Set([TURN_PHASE.COMPLETED, TURN_PHASE.SILENCE, TURN_PHASE.UNRECOGNIZED,
  TURN_PHASE.ERROR, TURN_PHASE.CANCELLED]);

/** A dictionary key the i18n instance knows; anything else becomes error.unknown. */
export function resolveKey(i18n, key, fallback = UNKNOWN_KEY) {
  return typeof key === 'string' && keyPattern.test(key) && i18n.has(key) ? key : fallback;
}

/** Session status badge (§7.2 state flow). */
export function statusKey(status) {
  return STATUS_MESSAGE_KEYS[status] ?? STATUS_MESSAGE_KEYS[SEQ_STATUS.IDLE];
}

/**
 * Per-turn processing line. Errors prefer the engine's messageKey, then the
 * normalized code; a completed turn that is currently being spoken says so.
 */
export function turnKey(turn, snapshot = null) {
  if (!turn) return UNKNOWN_KEY;
  if (turn.phase === TURN_PHASE.ERROR) {
    if (turn.messageKey) return turn.messageKey;
    return /^[A-Z][A-Z0-9_]{0,39}$/.test(turn.errorCode ?? '') ? `error.${turn.errorCode}` : UNKNOWN_KEY;
  }
  if (turn.phase === TURN_PHASE.COMPLETED && snapshot?.activeTurnId === turn.turnId
    && snapshot.status === SEQ_STATUS.SPEAKING) return STATUS_MESSAGE_KEYS.speaking;
  return turn.messageKey ?? PHASE_MESSAGE_KEYS[turn.phase] ?? UNKNOWN_KEY;
}

/** Voice outcome sits beside the captions; nothing is shown for a clean read. */
export function voiceKey(turn) {
  const voice = turn?.voice;
  if (!voice) return null;
  if (voice.messageKey) return voice.messageKey;
  return voice.fallback ? 'voice.fallback' : null;
}

export function noticeKey(notice) {
  return notice?.messageKey ?? null;
}

/** Thrown engine/store errors map to error.<CODE>; the raw error is dropped. */
export function errorKey(error) {
  return `error.${normalizeError(error).code}`;
}

/** Header badge: provider label key and key-source mode key (never a key value). */
export function keySelectionKeys(selection) {
  if (!selection) return { providerKey: null, modeKey: 'settings.noKey' };
  return { providerKey: `providers.${selection.providerId}`,
    modeKey: selection.keySource === 'shared' ? 'mode.shared' : 'mode.personal' };
}

/** Which per-turn buttons a bubble offers for this snapshot. */
export function turnActions(turn, snapshot) {
  if (!turn || !snapshot) return { retry: false, play: false, deviceReplay: false, stopPlayback: false };
  const active = snapshot.activeTurnId === turn.turnId;
  const completed = turn.phase === TURN_PHASE.COMPLETED;
  const speaking = active && snapshot.status === SEQ_STATUS.SPEAKING;
  const output = snapshot.voice?.output ?? 'provider';
  return {
    // Same record reprocessed (§7.2); voice turns keep no audio, so re-record.
    retry: terminal.has(turn.phase) && !completed && Boolean(turn.sourceText) && !active,
    play: completed && !speaking && output !== 'off',
    deviceReplay: completed && !speaking && turn.voice?.deviceFallbackAvailable === true && output !== 'device',
    stopPlayback: speaking,
  };
}

/** Output for the bubble's play button; provider re-reads need the provider setting. */
export function replayOutput(snapshot) {
  return snapshot?.voice?.output === 'provider' ? 'provider' : 'device';
}

/** Input level event -> 0..100 for a role="meter"; NaN and negatives read as silence. */
export function levelPercent(level) {
  const rms = Number(level?.rms);
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(100, Math.round((rms / LEVEL_FULL_SCALE_RMS) * 100));
}

/** Everything a bubble shows, already resolved to safe dictionary keys. */
export function describeTurn(i18n, turn, snapshot) {
  const voice = voiceKey(turn);
  return Object.freeze({
    statusKey: resolveKey(i18n, turnKey(turn, snapshot)),
    voiceKey: voice ? resolveKey(i18n, voice) : null,
    sourceText: typeof turn?.sourceText === 'string' ? turn.sourceText : '',
    translatedText: typeof turn?.translatedText === 'string' ? turn.translatedText : '',
    actions: turnActions(turn, snapshot),
  });
}
