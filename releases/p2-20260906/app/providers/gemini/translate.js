/**
 * Ported from: ~/jarvis2/interp-web/lib/translate.js
 * Symbols: translate
 * Ported on: 2026-09-05
 * Source SHA-256: 718fa137329f2ef4d5b0291ca3e445ddfcd1118fb2c7d01bc1fdf492c4d95cad
 * Changes: One attempt via shared REST, WAV combined transcription/translation,
 * structured validation; retries belong exclusively to the common executor.
 */
import { ProviderError, assertActive, normalizeError } from '../contract.js';
import { validateWav } from '../../audio/wav.js';
import { validateOutput } from '../../engine/output-validator.js';
import { DEFAULT_MODEL, FALLBACK_MODEL, MODELS, REST_LIMITS } from './config.js';
import { buildInstruction } from './prompts.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += alphabet[value >>> 18] + alphabet[(value >>> 12) & 63]
      + (i + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=')
      + (i + 2 < bytes.length ? alphabet[value & 63] : '=');
  }
  return result;
}

function inputParts(input, capability) {
  if (input?.format === 'text' && capability === 'translate') {
    if (typeof input.text !== 'string' || !input.text.trim()
      || input.text.length > REST_LIMITS.maxTextLength
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)) throw new ProviderError('INVALID_REQUEST');
    return [{ text: input.text }];
  }
  if (input?.format !== 'wav') throw new ProviderError('INPUT_UNSUPPORTED');
  try {
    const audio = input.audio;
    if (!(audio instanceof Uint8Array || audio instanceof ArrayBuffer || audio instanceof DataView)
      || audio.byteLength > REST_LIMITS.maxAudioBytes) throw new ProviderError('INVALID_REQUEST');
    const wav = audio instanceof ArrayBuffer ? new Uint8Array(audio)
      : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    validateWav(wav, { sampleRate: 16000 });
    return [{ inlineData: { mimeType: 'audio/wav', data: base64(wav) } }];
  } catch { throw new ProviderError('INVALID_REQUEST'); }
}

// Shared finite-attempt boundary for translation and independent STT. The router
// charges context.budget once. Never create a budget or call STT from translation.
export function createGeminiFinite(capability, { rest } = {}) {
  if (!['translate', 'stt'].includes(capability) || typeof rest?.generateContent !== 'function') {
    throw new ProviderError('INVALID_REQUEST');
  }
  return async (request, context = {}) => {
    try {
      assertActive(context.signal);
      if (!request || !context.signal) throw new ProviderError('INVALID_REQUEST');
      const model = request.model ?? DEFAULT_MODEL;
      if (!MODELS.includes(model)) throw new ProviderError('MODEL_UNSUPPORTED');
      const instruction = buildInstruction(capability, request);
      const parts = inputParts(request.input, capability);
      const sourceText = request.input.format === 'text' ? request.input.text : undefined;
      const result = await rest.generateContent({ model, instruction, parts }, context);
      assertActive(context.signal);
      return validateOutput(result.text, { capability, model, sourceText });
    } catch (error) { throw normalizeError(error); }
  };
}

export function createGeminiTranslate(options) {
  return createGeminiFinite('translate', options);
}

// Pass to createRetryExecutor.run as resolveFallback after registering the same
// policy. Only the fixed default -> fallback transition is allowed; no cycling.
export function resolveGeminiFallback(error, request) {
  if ((request.model ?? DEFAULT_MODEL) !== DEFAULT_MODEL
    || !['INVALID_RESULT', 'MODEL_UNSUPPORTED', 'SETTINGS_UNSUPPORTED', 'UNAVAILABLE', 'NETWORK_ERROR'].includes(error.code)) return null;
  return { ...request, model: FALLBACK_MODEL };
}
