/**
 * Ported from: ~/jarvis2/interp-web/server.js
 * Symbols: publicSettings, castStart, castStop, wss connection audience messages
 * Ported on: 2026-09-05
 * Source SHA-256: b179d94a9de1f6af012e3b40226199bb6c30e4b5564d00b97931cdbbb6cd7d48
 * Protocol reference: ~/jarvis2/interp-web/lib/live.js (LiveLane status events)
 * Source SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Changes: receive-only ES module; strict bounds, field allowlists, no raw errors.
 *
 * P3-09 (design-p3 §1.8, architecture.md "허브 통제"): the control extension is
 * a new implementation, not ported. `hello` gains an optional `control` field
 * (negotiation) and `policy.control` is a full snapshot envelope. Both are
 * normalized here without any clock, state, ordering or TTL evaluation; P3-10
 * (`control.js`) owns epoch/revision ordering, the monotonic TTL and the stop
 * latch. A hub can only add restrictions: the snapshot carries no key,
 * endpoint, model, pricing or personal setting, and unknown keys are rejected.
 * The legacy `settings` envelope keeps its language-only meaning and never
 * grants control.
 */
import { ProviderError } from '../providers/contract.js';
// Cyclic with schema.js (which imports REGISTERED_HUBS); every binding below is
// read at call time only, never during module evaluation.
import { NOTICE_SEVERITIES, POLICY_LIMITS, REGISTERED_FEATURES } from '../policy/schema.js';

// P2-20 must register reviewed endpoints and update ENDPOINT_ORIGINS and CSP.
export const REGISTERED_HUBS = Object.freeze([]);
// controlBytes bounds the `policy.control` envelope (§1.8 "최대 16KiB"); the
// legacy envelopes keep messageBytes. TTL bounds are inclusive seconds.
export const HUB_LIMITS = Object.freeze({ messageBytes: 1048576, textChars: 16000, idChars: 256,
  controlBytes: 16384, ttlMinSeconds: 10, ttlMaxSeconds: 120, epochChars: 64 });
export const HUB_CONTROL_VERSION = 1;
export const HUB_CONTROL_SCOPES = Object.freeze(['event']);
const languages = ['ko', 'en', 'ja'];
const states = ['connecting', 'connected', 'rotating', 'reconnecting', 'error', 'fatal'];
const HELLO_CONTROL_KEYS = Object.freeze(['version', 'eventId', 'epoch', 'revision']);
const SNAPSHOT_KEYS = Object.freeze(['type', 'version', 'eventId', 'epoch', 'revision', 'issuedAt',
  'ttlSeconds', 'scope', 'stopped', 'disabledFeatures', 'notice']);
const NOTICE_KEYS = Object.freeze(['id', 'severity', 'text']);
// Same shapes as policy schema identifiers (sharedEvents[].id, notices[].id).
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const EPOCH_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MARKUP = /<\/?[a-zA-Z!?]/;
const invalid = () => { throw new ProviderError('INVALID_RESULT'); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(v);
const eventId = (v) => typeof v === 'string' && ID_PATTERN.test(v);
const epoch = (v) => typeof v === 'string' && EPOCH_PATTERN.test(v);
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

export function validateRoomCode(code) {
  // Legacy generation removes base64url punctuation, so codes can be shorter than seven.
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(code)) throw new ProviderError('INVALID_REQUEST');
  return code;
}

/** Outbound negotiation hello (§1.8). Returns the wire text for socket.send.
 * `session` is an optional session identifier (string or { sessionId });
 * `control` is optional { eventId, epoch, revision? } — omitted for a legacy
 * hello. The event ID and epoch come from the joined event, never from the
 * hub, QR or settings. Malformed input throws INVALID_REQUEST.
 */
export function buildHello(session, control) {
  const sessionId = object(session) ? session.sessionId : session;
  if (sessionId !== undefined && sessionId !== null && !identifier(sessionId)) throw new ProviderError('INVALID_REQUEST');
  const message = { type: 'hello', ...(sessionId ? { sessionId } : {}), settings: {} };
  if (control !== undefined && control !== null) {
    if (!object(control) || !onlyKeys(control, ['eventId', 'epoch', 'revision']) || !eventId(control.eventId)
      || !epoch(control.epoch) || (control.revision !== undefined && !integer(control.revision))) {
      throw new ProviderError('INVALID_REQUEST');
    }
    message.control = { version: HUB_CONTROL_VERSION, eventId: control.eventId, epoch: control.epoch,
      revision: control.revision ?? 0 };
  }
  const wire = JSON.stringify(message);
  if (new TextEncoder().encode(wire).byteLength > HUB_LIMITS.controlBytes) throw new ProviderError('INVALID_REQUEST');
  return wire;
}

/** Trusted composition-only registry injection, never settings/QR input.
 * Captures a validated copy. Per-join callers supply only a registered ID and code.
 */
export function createHubProtocol({ hubs = REGISTERED_HUBS } = {}) {
  const endpoints = new Map();
  try {
    if (!Array.isArray(hubs)) throw 0;
    for (const hub of hubs) {
      if (!hub || typeof hub.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(hub.id) || endpoints.has(hub.id)) throw 0;
      const url = new URL(hub.url);
      if (typeof hub.url !== 'string' || url.protocol !== 'wss:' || !url.hostname
        || url.username || url.password || url.pathname !== '/ws' || url.search || url.hash
        || url.href !== hub.url) throw 0;
      endpoints.set(hub.id, url.href);
    }
  } catch { throw new ProviderError('INVALID_REQUEST'); }
  return Object.freeze({
    buildUrl(hubId, roomCode) {
      const code = validateRoomCode(roomCode);
      if (!endpoints.has(hubId)) throw new ProviderError('HUB_REQUIRED');
      return `${endpoints.get(hubId)}?room=${encodeURIComponent(code)}`;
    },
    buildHello,
    parse: parseHubMessage,
  });
}

function settings(value) {
  if (!object(value) || !Array.isArray(value.allowedLangs) || value.allowedLangs.length > 64
    || !value.allowedLangs.every((lang) => typeof lang === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang) && lang.length <= 35)) invalid();
  const allowedLangs = Object.freeze([...new Set(value.allowedLangs.filter((lang) => languages.includes(lang)))]);
  // An empty intersection remains empty: the consumer must stop, not invent support.
  const defaultLang = allowedLangs.includes(value.defaultLang) ? value.defaultLang : allowedLangs[0] ?? null;
  return Object.freeze({ allowedLangs, defaultLang });
}

/** hello.control: absent → null (hub without the extension, "실시간 관리 미지원").
 * A different integer version is also unsupported (nothing negotiated), so
 * listening can continue. A present version-1 object must be exact.
 */
function helloControl(value) {
  if (value === undefined || value === null) return null;
  if (!object(value) || !Number.isSafeInteger(value.version)) invalid();
  if (value.version !== HUB_CONTROL_VERSION) return null;
  if (!onlyKeys(value, HELLO_CONTROL_KEYS) || !eventId(value.eventId) || !epoch(value.epoch) || !integer(value.revision)) invalid();
  return Object.freeze({ version: HUB_CONTROL_VERSION, eventId: value.eventId, epoch: value.epoch, revision: value.revision });
}

// { ko, en, ja } plain text, same rules as policy notices (P3-04): every
// language present, non-blank, ≤ POLICY_LIMITS.textChars code points, no
// control characters or tag-like markup, no extra keys.
function noticeText(value) {
  if (!object(value) || !onlyKeys(value, languages)) invalid();
  const text = {};
  for (const language of languages) {
    const entry = value[language];
    if (typeof entry !== 'string' || !entry.trim() || Array.from(entry).length > POLICY_LIMITS.textChars
      || CONTROL_CHARS.test(entry) || MARKUP.test(entry)) invalid();
    text[language] = entry;
  }
  return Object.freeze(text);
}

function notice(value) {
  if (value === null) return null;
  if (!object(value) || !onlyKeys(value, NOTICE_KEYS) || !eventId(value.id)
    || !NOTICE_SEVERITIES.includes(value.severity)) invalid();
  return Object.freeze({ id: value.id, severity: value.severity, text: noticeText(value.text) });
}

/** policy.control full snapshot (§1.8). Every field is required except that
 * notice may be null. disabledFeatures is a unique subset of REGISTERED_FEATURES:
 * a hub can switch registered features off, never on, and never touches keys,
 * endpoints, models, pricing or personal settings (unknown keys are rejected).
 */
function controlSnapshot(msg) {
  if (!onlyKeys(msg, SNAPSHOT_KEYS) || msg.version !== HUB_CONTROL_VERSION || !eventId(msg.eventId)
    || !epoch(msg.epoch) || !Number.isSafeInteger(msg.revision) || msg.revision < 1
    || typeof msg.issuedAt !== 'string' || !DATETIME_PATTERN.test(msg.issuedAt) || !Number.isFinite(Date.parse(msg.issuedAt))
    || !Number.isSafeInteger(msg.ttlSeconds) || msg.ttlSeconds < HUB_LIMITS.ttlMinSeconds || msg.ttlSeconds > HUB_LIMITS.ttlMaxSeconds
    || !HUB_CONTROL_SCOPES.includes(msg.scope) || typeof msg.stopped !== 'boolean'
    || !Array.isArray(msg.disabledFeatures) || msg.disabledFeatures.length > REGISTERED_FEATURES.length
    || new Set(msg.disabledFeatures).size !== msg.disabledFeatures.length
    || !msg.disabledFeatures.every((feature) => REGISTERED_FEATURES.includes(feature))
    || msg.notice === undefined) invalid();
  return { type: 'control', version: HUB_CONTROL_VERSION, eventId: msg.eventId, epoch: msg.epoch,
    revision: msg.revision, issuedAt: msg.issuedAt, ttlSeconds: msg.ttlSeconds, scope: msg.scope,
    stopped: msg.stopped, disabledFeatures: Object.freeze([...msg.disabledFeatures]), notice: notice(msg.notice) };
}

/** Accept decoded WebSocket text only. P2-11 owns bounded Blob/ArrayBuffer
 * conversion and ordered delivery. Unknown envelopes return null; malformed
 * known envelopes throw a code-only error. No filtering, deduplication, replay
 * inference, seq gap counting, I/O or retained session state occurs here.
 * `hello` carries `control` (null when the hub lacks the extension) and
 * `policy.control` normalizes to a `control` snapshot; ordering and TTL are
 * P3-10's job.
 */
export function parseHubMessage(raw) {
  let msg, bytes;
  try {
    if (typeof raw !== 'string' || raw.length > HUB_LIMITS.messageBytes) invalid();
    bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > HUB_LIMITS.messageBytes) invalid();
    msg = JSON.parse(raw);
  } catch { invalid(); }
  if (!object(msg) || typeof msg.type !== 'string' || msg.type.length > 64) invalid();
  let event;
  switch (msg.type) {
    case 'hello':
      if (!identifier(msg.sessionId)) invalid();
      event = { type: 'hello', sessionId: msg.sessionId, settings: settings(msg.settings), control: helloControl(msg.control) };
      break;
    case 'settings':
      // Language settings only: this legacy envelope never carries control.
      event = { type: 'settings', settings: settings(msg.settings) };
      break;
    case 'policy.control':
      if (bytes > HUB_LIMITS.controlBytes) invalid();
      event = controlSnapshot(msg);
      break;
    case 'cast.caption':
      if (![...languages, 'src'].includes(msg.lang) || !identifier(msg.segmentId)
        || !integer(msg.seq) || !integer(msg.revision) || typeof msg.final !== 'boolean'
        || typeof msg.text !== 'string' || msg.text.length > HUB_LIMITS.textChars
        || (msg.ts !== undefined && !integer(msg.ts))) invalid();
      event = { type: 'caption', lang: msg.lang, segmentId: msg.segmentId, seq: msg.seq,
        text: msg.text, final: msg.final, revision: msg.revision,
        ...(msg.ts === undefined ? {} : { ts: msg.ts }) };
      break;
    case 'status':
      // Only the exact LiveLane status shape gets legacy compatibility.
      if (![...languages, '*'].includes(msg.lang) || !states.includes(msg.state)) return null;
      // Falls through to the same normalization as cast.status.
    case 'cast.status':
      if (![...languages, '*'].includes(msg.lang) || !states.includes(msg.state)) invalid();
      event = { type: 'status', lang: msg.lang, state: msg.state };
      // model and detail are unnecessary for audience state; never retain them.
      break;
    case 'cast.stopped': {
      const reason = msg.reason === 'all lanes fatal' || msg.reason === 'start failed' ? 'broadcast-error'
        : msg.reason === 'auto-stop 150분' ? 'time-limit' : 'stopped';
      event = { type: 'stopped', reason };
      break;
    }
    case 'closed': event = { type: 'closed', reason: 'room-closed' }; break;
    case 'outside': case 'denied': event = { type: 'denied', reason: msg.type }; break;
    default: return null;
  }
  return Object.freeze(event);
}
