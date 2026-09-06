// Synthetic audience envelopes matching interp-web/server.js; no real room or keys.
// P3-09 adds the control extension of design-p3 §1.8 (hello.control and the
// policy.control snapshot). No hub address, room code, key or QR payload here.
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

// --- P3-09 control extension (§1.8 examples verbatim) ---
export const EVENT_ID = 'service-20260906';
export const EPOCH = 'broadcast-epoch';
/** hello.control as an extended hub echoes it after negotiation. */
export const control = (overrides = {}) => ({ version: 1, eventId: EVENT_ID, epoch: EPOCH, revision: 12, ...overrides });
/** Server hello from a hub that supports the extension (§1.8 "협상"). */
export const controlHello = (overrides = {}) => ({ ...hello(), control: control(overrides) });
/** Three-language plain-text notice body. */
export const noticeText = (overrides = {}) => ({ ko: '잠시 통역을 중지합니다.',
  en: 'Interpretation is temporarily paused.', ja: '通訳を一時停止します。', ...overrides });
export const notice = (overrides = {}) => ({ id: 'pause-13', severity: 'warning', text: noticeText(), ...overrides });
/** Full policy.control snapshot (§1.8 example: stopped, one feature disabled, one notice). */
export const snapshot = (overrides = {}) => ({ type: 'policy.control', version: 1, eventId: EVENT_ID, epoch: EPOCH,
  revision: 13, issuedAt: '2026-09-06T01:00:00Z', ttlSeconds: 60, scope: 'event', stopped: true,
  disabledFeatures: ['simultaneousDirect'], notice: notice(), ...overrides });
/** Release snapshot: nothing stopped or disabled, no notice. */
export const releaseSnapshot = (overrides = {}) => snapshot({ revision: 14, stopped: false, disabledFeatures: [], notice: null, ...overrides });
/** Wire text of `value` padded with trailing JSON whitespace to exactly `bytes` UTF-8 bytes,
 * so the size limit can be exercised without adding any field. */
export const padded = (value, bytes) => {
  const text = wire(value);
  const length = new TextEncoder().encode(text).byteLength;
  if (bytes < length) throw new Error('fixture: padding target smaller than the envelope');
  return text + ' '.repeat(bytes - length);
};
