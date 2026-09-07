/**
 * Ported from: ~/jarvis2/interp-web/lib/translate.js
 * Symbols: GEMINI_MODELS_FAST, translate generationConfig
 * Ported on: 2026-09-05
 * Source SHA-256: 718fa137329f2ef4d5b0291ca3e445ddfcd1118fb2c7d01bc1fdf492c4d95cad
 * Changes: Fixed model allowlist; no aliases, credential URLs, or variant loops.
 */
import { ProviderError } from '../contract.js';

export const REST_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.5-flash';
export const MODELS = Object.freeze([DEFAULT_MODEL, FALLBACK_MODEL]);
// Application limits, not statements about provider quotas. WAV framing is P1-07.
export const REST_LIMITS = Object.freeze({ timeoutMs: 30000, maxResponseBytes: 1048576,
  maxRequestBytes: 2097152, maxAudioBytes: 960044, maxTextLength: 16000 });

// Gemini 3 does not guarantee thinking-off. Use its supported minimum instead
// of claiming that the legacy thinkingBudget: 0 disables reasoning.
// https://ai.google.dev/gemini-api/docs/generate-content/thinking (2026-09-05)
const settings = Object.freeze({
  [DEFAULT_MODEL]: Object.freeze({ thinkingLevel: 'minimal' }),
  [FALLBACK_MODEL]: null,
});
export function generationConfig(model = DEFAULT_MODEL) {
  if (!MODELS.includes(model)) throw new ProviderError('MODEL_UNSUPPORTED');
  return { temperature: 0.3, maxOutputTokens: 4096, responseMimeType: 'application/json',
    ...(settings[model] ? { thinkingConfig: { ...settings[model] } } : {}) };
}
