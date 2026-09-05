// New implementation of design-v0.6 §20; no legacy runtime code is ported.
export const CAPABILITIES = Object.freeze(['translate', 'stt', 'live', 'voice']);
export const TRANSPORTS = Object.freeze(['direct', 'hub']);
export const IMPLEMENTATIONS = Object.freeze(['ready', 'planned', 'unsupported']);
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

export function normalizeError(error, normalize) {
  try {
    const result = error instanceof ProviderError ? error : normalize?.(error);
    const safe = new ProviderError(result?.code);
    // Preserve only bounded scheduling metadata, never arbitrary provider fields.
    if (Number.isFinite(result?.retryAfterMs) && result.retryAfterMs >= 0) {
      safe.retryAfterMs = result.retryAfterMs;
    }
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
 * LiveSession: sendAudio(pcm), finishInput(), close() -> Promise<void>.
 * VoiceSession: speak(request), cancel(), close() -> Promise<void>.
 * close resolves only after resource shutdown, and must also work after abort.
 * Adapters must observe context.signal for fetch/socket/audio cleanup, enforce
 * I/O limits/timeouts, and must not log credentials or perform hidden retries.
 */
