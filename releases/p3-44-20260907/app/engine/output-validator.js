/**
 * Ported from: ~/jarvis2/interp-web/lib/translate.js
 * Symbols: clean, inTargetLanguage, translate.accept
 * Ported on: 2026-09-05
 * Source SHA-256: 718fa137329f2ef4d5b0291ca3e445ddfcd1118fb2c7d01bc1fdf492c4d95cad
 * Changes: Strict structured output; no quote stripping or script-based truth
 * claims. Mixed language and names are accepted. Numeric checks are lexical,
 * not evidence of semantic accuracy, unit equivalence, or faithful audio STT.
 */
import { ProviderError } from '../providers/contract.js';

export const MAX_OUTPUT_LENGTH = 16000;
const invalid = () => { throw new ProviderError('INVALID_RESULT'); };
const text = (value) => typeof value === 'string' && value.length <= MAX_OUTPUT_LENGTH
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

// Preserve whole numeric tokens, multiplicity, signs, decimal precision and
// large integers without Number coercion. Grouping/fullwidth are normalized.
// Written-out numerals, unit conversions and date/verse semantics are outside
// this check. P1-08 prompts must request preservation of digit notation.
export function numericTokens(value) {
  return (value.normalize('NFKC').replace(/−/gu, '-').match(
    /[+-]?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?(?:%|‰)?/gu,
  ) ?? []).map((token) => token.replaceAll(',', '').replace(/^\+/, '')).sort();
}

/** Returns only the common result contract; passing is NOT translation accuracy.
 * raw is a JSON string or a parsed JSON object. model comes from the request,
 * never the provider payload. sourceText, when supplied, is the trusted text
 * input and must match the echoed source. Omit it for audio transcription.
 * detectedLanguage accepts BCP-47-like tags plus 'mixed' and 'und'. No script
 * test can decide whether names, numbers or mixed-language text are correct.
 */
export function validateOutput(raw, { capability = 'translate', model, sourceText } = {}) {
  try {
    if (!['translate', 'stt'].includes(capability) || typeof model !== 'string' || !model) invalid();
    if (typeof raw === 'string') {
      if (raw.length > MAX_OUTPUT_LENGTH * 12 + 1024) invalid();
      // Accept one complete JSON fence, never prose surrounding JSON.
      const fenced = raw.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
      raw = JSON.parse(fenced ? fenced[1] : raw);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    const fields = ['sourceText', 'detectedLanguage', 'status',
      ...(capability === 'translate' ? ['translatedText'] : [])];
    if (Object.keys(raw).length !== fields.length || fields.some((key) => !Object.hasOwn(raw, key))) invalid();
    if (!text(raw.sourceText) || (capability === 'translate' && !text(raw.translatedText))) invalid();
    if (typeof raw.detectedLanguage !== 'string'
      || !/^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|mixed|und)$/.test(raw.detectedLanguage)
      || raw.detectedLanguage.length > 35) invalid();
    if (!['ok', 'no-speech', 'unrecognized'].includes(raw.status)) invalid();
    if (sourceText !== undefined && (!text(sourceText) || raw.sourceText.trim() !== sourceText.trim())) invalid();
    const source = raw.sourceText.trim();
    const translated = capability === 'translate' ? raw.translatedText.trim() : undefined;
    if (raw.status === 'ok') {
      if (!source || (capability === 'translate' && !translated)) invalid();
      if (capability === 'translate' && JSON.stringify(numericTokens(source)) !== JSON.stringify(numericTokens(translated))) invalid();
    } else if (source || (capability === 'translate' && translated) || raw.detectedLanguage !== 'und') invalid();
    return Object.freeze({ sourceText: source,
      ...(capability === 'translate' ? { translatedText: translated } : {}),
      detectedLanguage: raw.detectedLanguage, status: raw.status, model });
  } catch { throw new ProviderError('INVALID_RESULT'); }
}
