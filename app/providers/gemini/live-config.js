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

/** Route of a model: 'translation' (translationConfig, structurally cannot
 * reply) or 'flash' (general Live model steered by the interpreter prompt).
 * Unknown or corrupted values fall back to the translation-only default. */
export const sanitizeLiveModel = (model) => LIVE_MODELS.includes(model) ? model : DEFAULT_LIVE_MODEL;
export const liveRoute = (model) => LIVE_MODEL_CONFIG[sanitizeLiveModel(model)].setup;

// Reply detection for the flash route (P3-02b). Deliberately short and
// start-anchored: an assistant opener, a self-identification as an AI, or a
// finished sentence with no target-script letters. Everything else passes.
// A speaker's own "Yes, I can help you" would also match; that trade-off is accepted.
const replyPhrases = Object.freeze({
  ko: Object.freeze([
    // Hangul syllables are precomposed: 드리/드려/드릴/드립 are distinct code points.
    /^(?:네|예|물론이죠|물론입니다|그럼요)[,!.\s]*(?:제가\s*)?(?:도와|알려|답변|설명)\s*드[리려릴립]/u,
    /^(?:무엇을|어떻게|뭘)\s*도와\s*드릴까요/u,
    /^(?:저는|제 이름은)\s*(?:AI|인공\s*지능|언어\s*모델|어시스턴트|비서|Gemini|제미나이)/iu,
  ]),
  en: Object.freeze([
    /^(?:yes|sure|of course|certainly|absolutely|okay|ok)[,!.\s]+(?:i can|i'll|i will|i'd be happy to|i'm happy to|let me)\s+(?:help|assist|explain|answer|tell)/iu,
    /^(?:i can|i'll|i will|i'd be happy to|i'm happy to|let me)\s+(?:help|assist)\s+(?:you|with)/iu,
    /^(?:how|what) can i help/iu,
    /^(?:as an ai|i am an ai|i'm an ai|as a language model|i am a language model|i'm a language model)/iu,
  ]),
  ja: Object.freeze([
    /^(?:はい|ええ|もちろん|かしこまりました|承知(?:しま|いたしま)した)[、,!！。\s]*(?:私が)?(?:お手伝い|お答え|ご説明|ご案内)/u,
    /^(?:何か|何を|どのように)?お手伝い(?:できること|しましょうか|いたしましょうか)/u,
    /^(?:私|わたし)は(?:AI|人工知能|言語モデル|アシスタント)/u,
  ]),
});
const count = (text, re) => (text.match(re) ?? []).length;
const scripts = (text) => ({ hangul: count(text, /\p{Script=Hangul}/gu), latin: count(text, /\p{Script=Latin}/gu),
  kana: count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu), han: count(text, /\p{Script=Han}/gu) });
// Only finished sentences are checked: an interim fragment may legitimately
// start with a foreign name or acronym before the target-language text arrives.
function foreignScript(text, targetLanguage) {
  const s = scripts(text);
  if (targetLanguage === 'ko') return s.hangul === 0 && (s.kana >= 6 || s.latin >= 16);
  if (targetLanguage === 'en') return s.latin === 0 && (s.hangul >= 6 || s.kana >= 6 || s.han >= 6);
  return s.kana + s.han === 0 && (s.hangul >= 6 || s.latin >= 16);
}
/** detectReply(text, targetLanguage, { final }) → 'phrase' | 'language' | null. */
export function detectReply(text, targetLanguage, { final = false } = {}) {
  if (typeof text !== 'string' || !Object.hasOwn(replyPhrases, targetLanguage)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (replyPhrases[targetLanguage].some((re) => re.test(trimmed))) return 'phrase';
  return final && foreignScript(trimmed, targetLanguage) ? 'language' : null;
}

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
