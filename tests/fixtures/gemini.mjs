// Synthetic provider payloads only; no real keys, recordings or user utterances.
export const key = 'synthetic-gemini-secret';
export const model = 'gemini-3.1-flash-lite';
export const output = (changes = {}) => ({ sourceText: '사과 12개', translatedText: '12 apples',
  detectedLanguage: 'ko', status: 'ok', ...changes });
export const request = (changes = {}) => ({ instruction: 'Return the requested structured result.',
  parts: [{ text: '사과 12개' }], ...changes });
export const context = (changes = {}) => ({ providerId: 'gemini', transport: 'direct', keySource: 'personal',
  turnId: 'turn-1', sessionId: 'session-1', generation: 1,
  credentialRef: Object.freeze({}), signal: new AbortController().signal, ...changes });
export const envelope = (text = JSON.stringify(output()), changes = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], ...changes,
});
export const response = (body = envelope(), options) => new Response(JSON.stringify(body), options);
export function chunkedResponse(text, { chunkSize = 7, headers, onCancel = () => {} } = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += chunkSize));
    },
    cancel: onCancel,
  }), { headers });
}
export function clock() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    setTimeout(fn) { timers.set(++id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire() { for (const fn of [...timers.values()]) fn(); },
  };
}
