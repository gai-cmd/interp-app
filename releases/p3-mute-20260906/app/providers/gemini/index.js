// New implementation of design-v0.6 §20 (provider registration) for Gemini.
// Composition only: models, limits, prompts and transports live in sibling files.
import { createGeminiLive } from './live.js';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS } from './live-config.js';
import { normalizeGeminiError } from './errors.js';
import { DEFAULT_MODEL, FALLBACK_MODEL, MODELS, REST_ENDPOINT } from './config.js';
import { createGeminiRest } from './rest.js';
import { createGeminiTranslate, resolveGeminiFallback } from './translate.js';
import { createGeminiStt } from './stt.js';
import { createGeminiLiveClient, LIVE_ENDPOINT } from './live-client.js';
import { createGeminiVoice, DEFAULT_VOICE, DEFAULT_VOICE_MODEL, VOICE_MODELS, VOICE_NAMES } from './voice.js';

export const GEMINI_PROVIDER_ID = 'gemini';
// The only network destinations this provider may use; P1-18 derives CSP from it.
export const GEMINI_ENDPOINTS = Object.freeze([REST_ENDPOINT, LIVE_ENDPOINT]);
export const GEMINI_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL, fallbackModel: FALLBACK_MODEL,
  liveModel: DEFAULT_LIVE_MODEL, voiceModel: DEFAULT_VOICE_MODEL, voice: DEFAULT_VOICE });

// Same transition resolveGeminiFallback performs; registered so the router can
// audit it. Cross-provider and key-source changes are never candidates (§20.4).
const modelFallback = Object.freeze([Object.freeze({ model: FALLBACK_MODEL, condition: 'default-model-failed',
  on: Object.freeze(['MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'UNAVAILABLE', 'NETWORK_ERROR', 'INVALID_RESULT']) })]);
const liveFallback = Object.freeze(LIVE_MODELS.slice(1).map((model, index) => Object.freeze({
  model, condition: `live-model-${index}-failed`,
  on: Object.freeze(['MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'UNAVAILABLE', 'NETWORK_ERROR']),
})));

// Live candidates move forward only; REST quality fallback never enters this path.
export function resolveGeminiLiveFallback(error, request) {
  const current = request.model ?? DEFAULT_LIVE_MODEL;
  const candidate = liveFallback[LIVE_MODELS.indexOf(current)];
  return candidate?.on.includes(error.code) ? { ...request, model: candidate.model } : null;
}
const capability = (implementation, inputFormats, outputFormats, models = [], voices = []) => Object.freeze({
  implementation, transports: Object.freeze(['direct']), inputFormats: Object.freeze(inputFormats),
  outputFormats: Object.freeze(outputFormats), models: Object.freeze(models), voices: Object.freeze(voices),
});

/**
 * Trusted, code-owned registration (§20.2). Declares what P1 implements: text and
 * WAV combined translation, WAV transcription, Live voice and interpretation.
 * Registration is
 * policy, not evidence that the current key, browser or network works.
 * terms.status stays 'unreviewed' until an owner review records a date (§11.4).
 */
export const GEMINI_DEFINITION = Object.freeze({
  id: GEMINI_PROVIDER_ID,
  label: 'providers.gemini',
  browserDirect: true,
  capabilities: Object.freeze({
    translate: capability('ready', ['text', 'wav'], ['translation'], MODELS),
    stt: capability('ready', ['wav'], ['transcript'], MODELS),
    live: capability('ready', ['pcm16'], ['pcm16', 'subtitle'], LIVE_MODELS),
    voice: capability('ready', ['text'], ['pcm16'], VOICE_MODELS, VOICE_NAMES),
  }),
  credentialPolicy: Object.freeze({ directPersonal: true, directShared: true, hubManaged: false }),
  quotaPolicy: Object.freeze({ scope: 'project', normalizeError: normalizeGeminiError }),
  fallbackPolicy: Object.freeze({ translate: modelFallback, stt: modelFallback, live: liveFallback, voice: Object.freeze([]) }),
  endpoints: GEMINI_ENDPOINTS,
  terms: Object.freeze({ notice: 'providers.geminiTerms', status: 'unreviewed', reviewedAt: null }),
});

/**
 * createGeminiAdapter({ resolveCredential, fetch?, WebSocket?, Blob?, setTimeout?, clearTimeout? })
 * builds the direct-call adapter matching GEMINI_DEFINITION. resolveCredential is
 * the key store's authentication boundary; adapters never receive raw keys.
 * Environment objects default to globals at creation, never at import. One
 * live client per app: voice sessions share its single socket slot, and P2
 * live must reuse the same client rather than open a second transport.
 */
export function createGeminiAdapter({ resolveCredential, fetch, WebSocket, Blob, setTimeout, clearTimeout } = {}) {
  // Undefined fields fall through to each factory's own global defaults.
  const rest = createGeminiRest({ resolveCredential, fetch, setTimeout, clearTimeout });
  const live = createGeminiLiveClient({ resolveCredential, WebSocket, Blob, setTimeout, clearTimeout });
  return Object.freeze({
    translate: createGeminiTranslate({ rest }),
    stt: createGeminiStt({ rest }),
    live: createGeminiLive({ live, clock: { setTimeout: setTimeout ?? globalThis.setTimeout,
      clearTimeout: clearTimeout ?? globalThis.clearTimeout, now: () => globalThis.performance.now() } }),
    voice: createGeminiVoice({ live, setTimeout, clearTimeout }),
  });
}

// Pass to createRetryExecutor.run({ resolveFallback }) for translate and stt.
export { resolveGeminiFallback };

export function registerGemini(registry, options) {
  return registry.register(GEMINI_DEFINITION, createGeminiAdapter(options));
}
