/**
 * Ported from: ~/jarvis2/interp-web/lib/live.js
 * Symbols: buildSetup, SIM_MODELS, FALLBACK_MODELS
 * Ported on: 2026-09-05
 * Source SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Changes: Fixed model/language validation, separate model policies, no cycling.
 */
import { ProviderError } from '../contract.js';

export const DEFAULT_LIVE_MODEL = 'gemini-3.5-live-translate-preview';
export const LIVE_MODELS = Object.freeze([DEFAULT_LIVE_MODEL,
  'gemini-3.1-flash-live-preview', 'gemini-live-2.5-flash-preview']);
// Repository candidates, not a claim of current account/model availability.
export const LIVE_MODEL_CONFIG = Object.freeze(Object.fromEntries(LIVE_MODELS.map((model) =>
  [model, Object.freeze({ setup: model === DEFAULT_LIVE_MODEL ? 'translation' : 'flash',
    automaticActivityDetection: true, transcriptionMode: 'delta', voices: Object.freeze([]) })])));
export const SIM_LIMITS = Object.freeze({ inputSampleRate: 16000, outputSampleRate: 24000,
  maxInputBytes: 1024, maxContentBytes: 1048576, maxAudioBytes: 786432, maxTranscriptChars: 16000 });
const names = Object.freeze({ ko: 'Korean', en: 'English', ja: 'Japanese' });

export function buildLiveSetup({ model = DEFAULT_LIVE_MODEL, targetLanguage, voice } = {}) {
  if (!LIVE_MODELS.includes(model)) throw new ProviderError('MODEL_UNSUPPORTED');
  if (!Object.hasOwn(names, targetLanguage)) throw new ProviderError('INVALID_REQUEST');
  if (voice !== undefined) throw new ProviderError('SETTINGS_UNSUPPORTED');
  const generationConfig = { responseModalities: ['AUDIO'] };
  const setup = { model: `models/${model}`, generationConfig,
    inputAudioTranscription: {}, outputAudioTranscription: {} };
  if (LIVE_MODEL_CONFIG[model].setup === 'translation') {
    generationConfig.translationConfig = { targetLanguageCode: targetLanguage, echoTargetLanguage: false };
  } else {
    // Model instruction, never a UI string or caller-provided persona.
    setup.systemInstruction = { parts: [{ text:
      `You are a simultaneous interpreter. Interpret what you hear into ${names[targetLanguage]} immediately, `
      + "in the speaker's own register. Speak only the interpretation: no commentary, never answer questions yourself. "
      + 'Preserve numbers, names and meaning; do not add content. '
      + `Never repeat an utterance already in ${names[targetLanguage]}. `
      + 'If you hear your own interpreted voice coming back through the speakers, stay silent.' }] };
  }
  return setup;
}
