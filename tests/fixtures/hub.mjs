// Synthetic audience envelopes matching interp-web/server.js; no real room or keys.
export const hub = Object.freeze({ id: 'fixture', url: 'wss://hub.example.invalid/ws' });
export const hello = () => ({ type: 'hello', sessionId: 'web-20260905-120000-abcd',
  settings: { allowedLangs: ['ja', 'en', 'ko'], defaultLang: 'ja', castActive: true,
    castLangs: ['ja'], name: 'Synthetic room', allowSave: true } });
export const caption = (overrides = {}) => ({ type: 'cast.caption', lang: 'ja',
  segmentId: 'ja-out-1', seq: 1, text: 'こんにちは。', final: false, revision: 1, ts: 1788609600000, ...overrides });
export const status = (state = 'connected', lang = 'ja') => ({ type: 'cast.status', lang,
  ...{ type: 'status', state, model: 'fixture-model', detail: 'synthetic-private-detail' } });
export const replay = () => [caption({ seq: 12, final: true }),
  caption({ lang: 'src', seq: 19, final: true }),
  caption({ segmentId: 'ja-out-2', seq: 25, final: true })];
export const wire = (value) => JSON.stringify(value);
