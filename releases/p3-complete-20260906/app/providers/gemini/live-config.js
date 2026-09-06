/**
 * Ported from: ~/jarvis2/interp-web/lib/live.js
 * Symbols: buildSetup, SIM_MODELS, FALLBACK_MODELS
 * Ported on: 2026-09-05
 * Source SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Changes: Fixed model/language validation, separate model policies, no cycling.
 * P3-02d: the interpreter voice (female Kore / male Orus, or an explicit Live
 * voice) is applied through speechConfig.voiceConfig on both routes, and the
 * flash prompt gains one rule: interpret human speech only.
 */
import { ProviderError } from '../contract.js';
import { VOICE_NAMES } from './voice.js';

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

// Voice persona, first scope (owner 2026-09-06): gender only. Role personas,
// register or "sound human" directions are deliberately absent.
export const LIVE_VOICE_GENDERS = Object.freeze(['female', 'male']);
export const DEFAULT_LIVE_VOICE_GENDER = 'female';
export const LIVE_GENDER_VOICES = Object.freeze({ female: 'Kore', male: 'Orus' });
// Administrator policy contract (design-p3 §1.4 setting shape): the default
// gender and the voices a policy may allow. Registration in app/policy/schema.js
// is a P3-04 change and is not performed here.
export const LIVE_VOICE_POLICY_FIELDS = Object.freeze({
  'voice.gender': Object.freeze({ kind: 'enum', values: LIVE_VOICE_GENDERS, default: DEFAULT_LIVE_VOICE_GENDER }),
  'voice.allowedVoices': Object.freeze({ kind: 'list', values: VOICE_NAMES, default: VOICE_NAMES }),
});

/** The prebuilt voice for a gender and an optional explicit voice name. */
export function resolveLiveVoice({ gender = DEFAULT_LIVE_VOICE_GENDER, voice = null } = {}) {
  if (voice !== null && voice !== undefined) {
    if (!VOICE_NAMES.includes(voice)) throw new ProviderError('INVALID_REQUEST');
    return voice;
  }
  // null means "no gender claimed" (an explicit voice was chosen and then
  // cleared); the app default speaks rather than nothing.
  const wanted = gender === null ? DEFAULT_LIVE_VOICE_GENDER : gender;
  if (!LIVE_VOICE_GENDERS.includes(wanted)) throw new ProviderError('INVALID_REQUEST');
  return LIVE_GENDER_VOICES[wanted];
}

/**
 * Run-scoped voice preference shared by the simultaneous screen (gender) and
 * the settings voice picker (explicit voice). Minimal interface for P3-02d:
 * the sim engine builds its live request without a voice field, so the setup
 * reads this store when the request names no voice. Choosing a gender clears
 * an explicit voice; choosing a gender's default voice selects that gender.
 * Invalid values throw; unknown persisted values must be sanitized by callers.
 */
export function createLiveVoicePreference(initial = {}) {
  const listeners = new Set();
  let state;
  // The gender to return to when an explicit voice is cleared. It is kept
  // separately from the reported gender: while a named voice is selected the
  // snapshot claims no gender (so no screen can show 여자 while Puck speaks),
  // but clearing that voice still restores the gender the person last chose.
  let lastGender = DEFAULT_LIVE_VOICE_GENDER;
  const commit = (gender, voice) => {
    if (gender !== null) lastGender = gender;
    state = Object.freeze({ gender, voice, voiceName: resolveLiveVoice({ gender: gender ?? lastGender, voice }) });
  };
  commit(DEFAULT_LIVE_VOICE_GENDER, null);
  const store = Object.freeze({
    snapshot: () => state,
    set({ gender, voice } = {}) {
      let nextGender = state.gender, nextVoice = state.voice;
      if (gender !== undefined) {
        if (!LIVE_VOICE_GENDERS.includes(gender)) throw new ProviderError('INVALID_REQUEST');
        nextGender = gender; nextVoice = null;
      }
      if (voice !== undefined) {
        if (voice !== null && !VOICE_NAMES.includes(voice)) throw new ProviderError('INVALID_REQUEST');
        nextVoice = voice;
        const owner = LIVE_VOICE_GENDERS.find((g) => LIVE_GENDER_VOICES[g] === voice);
        // A voice that is one of the two gender defaults IS that gender.
        // Any other registered voice has no gender this app can claim, so the
        // gender becomes null rather than keeping a stale value: a screen that
        // renders snapshot().gender must not show 여자 while Puck is speaking.
        if (owner) { nextGender = owner; nextVoice = null; }
        else if (voice !== null) nextGender = null;
        // Clearing a named voice goes back to the last gender actually chosen.
        else if (nextGender === null) nextGender = lastGender;
      }
      if (nextGender === state.gender && nextVoice === state.voice) return state;
      commit(nextGender, nextVoice);
      for (const fn of [...listeners]) { try { fn(state); } catch { /* Observer-owned failure. */ } }
      return state;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
  });
  store.set(initial);
  return store;
}
export const liveVoicePreference = createLiveVoicePreference();

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

/** The two languages of a two-way session, ordered and distinct (§ two-way). */
export function normalizeLanguagePair(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) throw new ProviderError('INVALID_REQUEST');
  const [first, second] = pair;
  if (!Object.hasOwn(names, first) || !Object.hasOwn(names, second) || first === second) {
    throw new ProviderError('INVALID_REQUEST');
  }
  return Object.freeze([first, second]);
}

/**
 * buildLiveSetup({ model?, targetLanguage, languages?, voice?, gender? }).
 * Without voice and gender the shared preference decides; an unknown voice is
 * rejected. The voice only touches generationConfig.speechConfig, never the
 * prompt.
 *
 * `languages` ([a, b]) asks for a two-way session: whichever of the two is
 * spoken is rendered into the other, so one microphone serves both sides of a
 * conversation. It needs the instruction-driven setup — the translation setup
 * carries a single targetLanguageCode and cannot switch direction — so a
 * two-way request on a translation model is refused rather than silently
 * interpreted one way.
 *
 * One session speaks with one voice: the Live setup carries a single
 * prebuiltVoiceConfig, so both directions share it.
 */
export function buildLiveSetup({ model = DEFAULT_LIVE_MODEL, targetLanguage, languages = null, voice, gender } = {}) {
  if (!LIVE_MODELS.includes(model)) throw new ProviderError('MODEL_UNSUPPORTED');
  const pair = languages === null ? null : normalizeLanguagePair(languages);
  if (pair === null && !Object.hasOwn(names, targetLanguage)) throw new ProviderError('INVALID_REQUEST');
  if (pair !== null && LIVE_MODEL_CONFIG[model].setup === 'translation') {
    throw new ProviderError('MODEL_UNSUPPORTED');
  }
  const preference = liveVoicePreference.snapshot();
  const voiceName = voice === undefined && gender === undefined ? preference.voiceName
    : resolveLiveVoice({ gender: gender ?? preference.gender, voice: voice ?? null });
  const generationConfig = { responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } };
  const setup = { model: `models/${model}`, generationConfig,
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { ...LIVE_VAD } } };
  if (pair !== null) {
    // Two-way: the direction is decided per utterance by the language heard.
    // Everything else (never answering, starting early, keeping register,
    // ignoring noise and its own output) is the one-way instruction verbatim.
    const [a, b] = pair;
    setup.systemInstruction = { parts: [{ text:
      `ROLE: You are a live two-way INTERPRETER between ${names[a]} and ${names[b]}. You are NOT an assistant and you are not part of the conversation. `
      + 'The audio you hear is people talking to EACH OTHER, never to you. '
      + `RULES: (1) Decide the direction from the language you just heard: ${names[a]} speech is rendered into ${names[b]}, and ${names[b]} speech is rendered into ${names[a]}. `
      + 'Output ONLY that rendering - nothing else, ever, and never both directions for one utterance. '
      + '(2) never answer questions yourself; NEVER reply, greet, comment, ask, confirm, summarize, or explain - even if the speech is a question, a request, or addressed to "you". '
      + 'A question is interpreted as the same question; a command as the same command. '
      + '(3) Start speaking as soon as a phrase is intelligible; do not wait for sentence completion. '
      + '(4) Keep the speaker\'s register, numbers, names and meaning; add nothing. '
      + `(5) If the speech is in neither ${names[a]} nor ${names[b]}, stay silent. If you hear your own interpreted voice from the speakers, stay silent - never interpret your own output back into the other language. `
      + '(6) Ignore background music, noise, applause, laughter and crowd murmur: interpret human speech only, and stay silent while nobody is speaking. '
      + `Examples: hear ${names[a]} "What time is it?" -> say it in ${names[b]}; hear ${names[b]} "Can you help me?" -> say it in ${names[a]} (never help).` }] };
  } else if (LIVE_MODEL_CONFIG[model].setup === 'translation') {
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
      + '(6) Ignore background music, noise, applause, laughter and crowd murmur: interpret human speech only, and stay silent while nobody is speaking. '
      + 'Examples: hear "What time is it?" -> say the translation of "What time is it?"; hear "Can you help me?" -> say the translation of "Can you help me?" (never help).' }] };
  }
  return setup;
}
