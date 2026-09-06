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
// 400 ms accepts short phrase pauses without the aggressive 100 ms example.
// Keep 100 ms onset padding and low end sensitivity to limit clipped syllables.
// Policy values, not measured latency: https://ai.google.dev/gemini-api/docs/live-api/capabilities
export const LIVE_VAD = Object.freeze({ disabled: false, silenceDurationMs: 400,
  prefixPaddingMs: 100, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
  endOfSpeechSensitivity: 'END_SENSITIVITY_LOW' });
export const SIM_LIMITS = Object.freeze({ inputSampleRate: 16000, outputSampleRate: 24000,
  maxInputBytes: 1024, maxContentBytes: 1048576, maxAudioBytes: 786432, maxTranscriptChars: 16000 });
const names = Object.freeze({ ko: 'Korean', en: 'English', ja: 'Japanese' });

export function buildLiveSetup({ model = DEFAULT_LIVE_MODEL, targetLanguage, voice } = {}) {
  if (!LIVE_MODELS.includes(model)) throw new ProviderError('MODEL_UNSUPPORTED');
  if (!Object.hasOwn(names, targetLanguage)) throw new ProviderError('INVALID_REQUEST');
  if (voice !== undefined) throw new ProviderError('SETTINGS_UNSUPPORTED');
  const generationConfig = { responseModalities: ['AUDIO'] };
  const setup = { model: `models/${model}`, generationConfig,
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { ...LIVE_VAD } } };
  if (LIVE_MODEL_CONFIG[model].setup === 'translation') {
    generationConfig.translationConfig = { targetLanguageCode: targetLanguage, echoTargetLanguage: false };
  } else {
    // Model instruction, never a UI string or caller-provided persona.
    setup.systemInstruction = { parts: [{ text:
      `ROLE: You are a live simultaneous INTERPRETER into ${names[targetLanguage]}. You are NOT an assistant and you are not part of the conversation. `
      + 'The audio you hear is someone talking to OTHER people, never to you. '
      + `RULES: (1) Output ONLY the ${names[targetLanguage]} rendering of what was just said - nothing else, ever. `
      + '(2) never answer questions yourself; NEVER reply, greet, comment, ask, confirm, summarize, or explain - even if the speech is a question, a request, or addressed to "you". '
      + 'A question is interpreted as the same question; a command as the same command. '
      + '(3) Start speaking as soon as a phrase is intelligible; do not wait for sentence completion. '
      + '(4) Keep the speaker\'s register, numbers, names and meaning; add nothing. '
      + `(5) If the speech is already in ${names[targetLanguage]}, stay silent. If you hear your own interpreted voice from the speakers, stay silent. `
      + 'Examples: hear "What time is it?" -> say the translation of "What time is it?"; hear "Can you help me?" -> say the translation of "Can you help me?" (never help).' }] };
  }
  return setup;
}
