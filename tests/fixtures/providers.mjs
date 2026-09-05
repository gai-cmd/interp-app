// Synthetic providers and credentials only; never imported by product modules.
export function provider(id = 'alpha', overrides = {}) {
  const capability = (inputFormats, outputFormats) => ({
    implementation: 'ready', transports: ['direct'], inputFormats, outputFormats,
    models: ['test-model'], voices: [],
  });
  return {
    id, label: `providers.${id}`, browserDirect: true,
    capabilities: {
      translate: capability(['text'], ['translation']), stt: capability(['wav'], ['transcript']),
      live: { ...capability(['pcm16'], ['pcm16', 'subtitle']), implementation: 'planned' },
      voice: capability(['text'], ['pcm16']),
    },
    credentialPolicy: { directPersonal: true, directShared: true, hubManaged: false },
    quotaPolicy: { scope: 'project', normalizeError: () => ({ code: 'PROVIDER_ERROR' }) },
    fallbackPolicy: {}, endpoints: ['https://example.invalid/api', 'wss://example.invalid/live'],
    terms: { notice: 'providers.testTerms', status: 'unreviewed', reviewedAt: null },
    ...overrides,
  };
}

export function adapter(calls = []) {
  const record = (name, request, context) => { calls.push({ name, request, context }); };
  return {
    async translate(request, context) {
      record('translate', request, context);
      return { sourceText: 'hello', translatedText: '안녕', detectedLanguage: 'en', status: 'ok', model: 'test-model' };
    },
    async stt(request, context) {
      record('stt', request, context);
      return { sourceText: 'hello', detectedLanguage: 'en', status: 'ok', model: 'test-model' };
    },
    voice: { async open(request, context) {
      record('voice', request, context);
      return { async speak() {}, async cancel() {}, async close() {} };
    } },
    live: { async open(request, context) {
      record('live', request, context);
      return { async sendAudio() {}, async finishInput() {}, async close() {} };
    } },
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const textRequest = () => ({ input: { format: 'text', text: 'hello' }, targetLanguage: 'ko' });
export function context(overrides = {}) {
  return { providerId: 'alpha', keySource: 'personal', transport: 'direct',
    turnId: 'turn-1', sessionId: 'session-1', generation: 1,
    signal: new AbortController().signal, budget: { consume() {} }, ...overrides };
}
export const credentialRef = (address) => ({ ...address, reference: Object.freeze({ token: Symbol('test-reference') }) });
