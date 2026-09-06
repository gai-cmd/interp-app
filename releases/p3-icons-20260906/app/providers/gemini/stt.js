// New implementation of design-v0.6 §§8.2, 20.1; shared REST and validation
// boundaries are reused from translate.js. No legacy STT code is ported.
import { createGeminiFinite } from './translate.js';

// Independent transcription only. Normal PTT uses createGeminiTranslate instead.
// Reuse the same turn executor when following STT with text translation.
export function createGeminiStt(options) {
  return createGeminiFinite('stt', options);
}
