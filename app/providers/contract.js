// New implementation of design-v0.6 §20; no legacy runtime code is ported.
export const CAPABILITIES = Object.freeze(['translate', 'stt', 'live', 'voice']);
export const TRANSPORTS = Object.freeze(['direct', 'hub']);
export const IMPLEMENTATIONS = Object.freeze(['ready', 'planned', 'unsupported']);
// Normalized adapter events only; raw provider envelopes never cross the router.
export const STREAM_EVENT_FIELDS = Object.freeze(Object.fromEntries(Object.entries({
  audio: ['audio', 'sampleRate'], transcript: ['text', 'final'],
  subtitle: ['sourceText', 'translatedText', 'final', 'revision', 'segmentId', 'seq', 'role'],
  goAway: ['timeLeftMs'],
  // 2026-09-30: session resumption and token accounting (live only).
  resumption: ['handle'], usage: ['promptTokens', 'responseTokens', 'totalTokens', 'cachedTokens'],
  // 2026-09-30: a harmless per-part anomaly the adapter skipped or repaired (live only).
  anomaly: ['reason', 'dropped'],
  interrupted: [], complete: [], error: ['error'], closed: [],
}).map(([type, fields]) => [type, Object.freeze(fields)])));
// An opaque provider resumption handle: printable ASCII, 1..4096 characters.
// It is a credential-like token for one conversation, so it is only ever held
// in memory and sent back to the provider in a setup, never stored or shown.
export const isResumeHandle = (value) => typeof value === 'string' && /^[\x20-\x7e]{1,4096}$/.test(value);
export const ERROR_CODES = Object.freeze([
  'INVALID_PROVIDER', 'DUPLICATE_PROVIDER', 'UNKNOWN_PROVIDER', 'INVALID_REQUEST',
  'CAPABILITY_UNSUPPORTED', 'CAPABILITY_UNIMPLEMENTED', 'INPUT_UNSUPPORTED',
  'TRANSPORT_UNSUPPORTED', 'HUB_REQUIRED', 'CREDENTIAL_FORBIDDEN',
  'CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'BUDGET_REQUIRED', 'BUDGET_EXHAUSTED',
  'ABORTED', 'SESSION_CLOSED', 'INVALID_RESULT', 'PROVIDER_ERROR',
  'INVALID_KEY', 'PERMISSION_DENIED', 'IP_DENIED', 'RATE_LIMITED', 'DAILY_LIMIT',
  'SESSION_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429', 'UNAVAILABLE', 'NETWORK_ERROR',
  'MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'SAFETY_BLOCKED', 'TIMEOUT',
]);
// The 429 family: the quota behind one key is spent, per minute, per day or
// for an unknown reason. 2026-09-30: engines hand exactly these to an injected
// swapCredential() so the site's built-in keys can be swapped without a stop.
export const QUOTA_ERROR_CODES = Object.freeze(['RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429']);

// 2026-09-30: WHY a Live INVALID_RESULT was raised. On that day real runs ended
// with INVALID_RESULT and nothing on screen said which check had refused what,
// so every place on the Live path that raises the code now names one of these.
// The list is closed: a reason is an identifier chosen by this code, never a
// provider text, a message fragment or a value. In receive order:
//   message-type      a socket frame that is not text, ArrayBuffer or Blob
//   message-size      one frame above the transport's byte limit
//   queue-overflow    frames arriving faster than they are decoded (count or bytes)
//   message-parse     not UTF-8, not JSON, or a Blob that could not be read
//   message-shape     the parsed message is not an object
//   setup-shape       setupComplete is not an object, or came before the setup was sent
//   content-shape     serverContent before setup completed, or not an object
//   content-size      one serverContent above the adapter's byte limit
//   flag-shape        turnComplete / generationComplete / interrupted is not a boolean
//   transcript-shape  a transcription that is not {text?: string, finished?: boolean}
//   transcript-size   a transcription text above the character limit
//   parts-shape       modelTurn, its parts, one part or its inlineData has the wrong type
//   audio-encoding    audio data that is not a canonical base64 string
//   audio-size        one audio part above the byte limit
//   audio-mime        (skipped, never fatal) a part that is not 24 kHz mono PCM
//   audio-empty       (skipped, never fatal) an audio part without data
//   audio-odd-bytes   (repaired, never fatal) an audio part that ends in half a sample
//   goaway-shape      a goAway event without a usable time
//   client-handler    an exception inside the transport's own message handling
//   adapter-handler   an exception inside the adapter's event handling
//   event-handler     an exception inside the engine's event handling
export const INVALID_RESULT_REASONS = Object.freeze([
  'message-type', 'message-size', 'queue-overflow', 'message-parse', 'message-shape',
  'setup-shape', 'content-shape', 'content-size', 'flag-shape', 'transcript-shape', 'transcript-size',
  'parts-shape', 'audio-encoding', 'audio-size', 'audio-mime', 'audio-empty', 'audio-odd-bytes',
  'goaway-shape', 'client-handler', 'adapter-handler', 'event-handler',
]);
export const isInvalidResultReason = (value) => typeof value === 'string' && INVALID_RESULT_REASONS.includes(value);

// Codes are machine identifiers, never UI text. P1-04/P1-15 own translations.
// Never retain a raw error, cause, credential, request, or caller-supplied message.
export class ProviderError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.includes(code) ? code : 'PROVIDER_ERROR';
    super(safeCode);
    this.name = 'ProviderError';
    this.code = safeCode;
  }
}

/** An INVALID_RESULT that says why: error.reason is one of INVALID_RESULT_REASONS, or absent. */
export function invalidResult(reason) {
  const error = new ProviderError('INVALID_RESULT');
  if (isInvalidResultReason(reason)) error.reason = reason;
  return error;
}

export function normalizeError(error, normalize) {
  try {
    const result = error instanceof ProviderError ? error : normalize?.(error);
    const safe = new ProviderError(result?.code);
    // Preserve only bounded scheduling metadata, never arbitrary provider fields.
    if (Number.isFinite(result?.retryAfterMs) && result.retryAfterMs >= 0) {
      safe.retryAfterMs = result.retryAfterMs;
    }
    // ...and the fixed reason of an INVALID_RESULT: a listed identifier or nothing.
    if (safe.code === 'INVALID_RESULT' && isInvalidResultReason(result?.reason)) safe.reason = result.reason;
    return safe;
  } catch {
    return new ProviderError('PROVIDER_ERROR');
  }
}

export function assertActive(signal) {
  if (signal?.aborted) throw new ProviderError('ABORTED');
}

const identifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]*$/.test(value);
const i18nKey = (value) => typeof value === 'string' && /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
function requireValid(condition) {
  if (!condition) throw new ProviderError('INVALID_PROVIDER');
}
function snapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])));
  }
  return value;
}

/**
 * Registration is trusted, code-owned configuration, never QR/user configuration.
 * transports is an array of 'direct'/'hub'; label and terms.notice are i18n keys.
 * Each ready direct capability requires a matching adapter method. Hub adapters
 * are injected into the router separately and never substitute direct methods.
 * fallbackPolicy is declarative; the router never retries or switches providers.
 */
export function defineProvider(definition, adapter = {}) {
  try {
    requireValid(definition && identifier(definition.id) && i18nKey(definition.label));
    requireValid(typeof definition.browserDirect === 'boolean');
    const capabilities = {};
    const methods = {};
    for (const name of CAPABILITIES) {
      const cap = definition.capabilities?.[name];
      requireValid(cap && IMPLEMENTATIONS.includes(cap.implementation));
      requireValid(Array.isArray(cap.transports) && cap.transports.every((route) => TRANSPORTS.includes(route)));
      requireValid(new Set(cap.transports).size === cap.transports.length);
      for (const field of ['inputFormats', 'outputFormats', 'models', 'voices']) requireValid(strings(cap[field]));
      if (cap.implementation === 'ready') {
        requireValid(cap.transports.length > 0 && cap.inputFormats.length > 0 && cap.outputFormats.length > 0);
        if (name === 'translate') requireValid(cap.inputFormats.includes('text'));
        if (definition.browserDirect && cap.transports.includes('direct')) {
          const owner = name === 'live' || name === 'voice' ? adapter[name] : adapter;
          const method = name === 'live' || name === 'voice' ? owner?.open : owner?.[name];
          requireValid(typeof method === 'function');
          methods[name] = method.bind(owner);
        }
      }
      capabilities[name] = Object.fromEntries(['implementation', 'transports', 'inputFormats', 'outputFormats', 'models', 'voices'].map((field) => [field, cap[field]]));
    }
    const credentialPolicy = {};
    for (const field of ['directPersonal', 'directShared', 'hubManaged']) {
      requireValid(typeof definition.credentialPolicy?.[field] === 'boolean');
      credentialPolicy[field] = definition.credentialPolicy[field];
    }
    requireValid(identifier(definition.quotaPolicy?.scope));
    requireValid(typeof definition.quotaPolicy.normalizeError === 'function');
    requireValid(definition.fallbackPolicy && typeof definition.fallbackPolicy === 'object');
    const fallbackPolicy = {};
    // Candidates are local model IDs only; cross-provider fallback is disabled in P1.
    for (const name of CAPABILITIES) {
      const candidates = definition.fallbackPolicy[name] ?? [];
      requireValid(Array.isArray(candidates));
      fallbackPolicy[name] = candidates.map((candidate) => {
        requireValid(candidate && Object.keys(candidate).every((key) => ['model', 'on', 'condition'].includes(key)));
        requireValid(capabilities[name].models.includes(candidate.model));
        requireValid(Array.isArray(candidate.on) && candidate.on.every((code) => ['MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'UNAVAILABLE', 'NETWORK_ERROR', 'INVALID_RESULT'].includes(code)));
        requireValid(identifier(candidate.condition));
        return { model: candidate.model, on: candidate.on, condition: candidate.condition };
      });
    }
    requireValid(strings(definition.endpoints));
    for (const endpoint of definition.endpoints) {
      const url = new URL(endpoint);
      requireValid(['https:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
    }
    requireValid(i18nKey(definition.terms?.notice));
    requireValid(['unreviewed', 'reviewed'].includes(definition.terms.status));
    requireValid(definition.terms.reviewedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(definition.terms.reviewedAt));
    requireValid(definition.terms.status !== 'reviewed' || definition.terms.reviewedAt !== null);
    return Object.freeze({
      descriptor: snapshot({ id: definition.id, label: definition.label,
        browserDirect: definition.browserDirect, capabilities, credentialPolicy,
        quotaPolicy: { scope: definition.quotaPolicy.scope, normalizeError: definition.quotaPolicy.normalizeError },
        fallbackPolicy, endpoints: definition.endpoints,
        terms: { notice: definition.terms.notice, status: definition.terms.status, reviewedAt: definition.terms.reviewedAt },
      }),
      methods: Object.freeze(methods),
    });
  } catch {
    throw new ProviderError('INVALID_PROVIDER');
  }
}

/**
 * Adapter data contracts (language tags and model IDs are provider-owned):
 * request.input = { format: 'text', text } or { format: 'wav', audio };
 * streaming input uses format 'pcm16'. Other fields: sourceLanguage,
 * targetLanguage, language, voice, model. No credential/endpoint request fields.
 * TranslationResult: { sourceText, translatedText, detectedLanguage, status, model }.
 * SttResult: { sourceText, detectedLanguage, status, model }.
 * Finite status: 'ok' | 'no-speech' | 'unrecognized'.
 * Adapters emit via context.onEvent({ type, ...data }); consumers receive
 * { ...data, turnId, sessionId, generation } and terminal 'closed' at most once.
 * STREAM_EVENT_FIELDS lists the only forwarded data fields; undefined is omitted.
 * subtitle optionally adds segmentId (string), seq (nonnegative safe integer),
 * and role ('source' | 'translation'). Existing subtitle fields remain unchanged.
 * Adapters own field validation and segment identity/order, not the router.
 * goAway { timeLeftMs: nonnegative finite number } is an advisory event, not
 * terminal: the engine owns stopping input, confirmed close, and recovery budget.
 * 2026-09-30: after goAway a live session stays fully usable (input and
 * output) until the engine closes it or the provider's deadline passes.
 * resumption { handle: isResumeHandle string | null } carries the newest
 * resumable point (null: not resumable now); usage { promptTokens?,
 * responseTokens?, totalTokens?, cachedTokens? } carries nonnegative safe
 * integers only. A live request may name resumeHandle (live only).
 * anomaly { reason: one of INVALID_RESULT_REASONS, dropped: boolean } (live
 * only, 2026-09-30) reports one part the adapter skipped or repaired without
 * ending the session; dropped says whether playable audio was lost with it.
 * An error event's INVALID_RESULT may carry error.reason from the same list.
 * Routing IDs are snapshotted from context and override all adapter event IDs.
 * Consumer close/abort/cancel suppress events immediately, including 'closed'.
 * LiveSession: sendAudio(pcm), finishInput(), close() -> Promise<void>.
 * VoiceSession: speak(request), cancel(), close() -> Promise<void>.
 * close resolves only after resource shutdown, and must also work after abort.
 * Adapters must observe context.signal for fetch/socket/audio cleanup, enforce
 * I/O limits/timeouts, and must not log credentials or perform hidden retries.
 */
