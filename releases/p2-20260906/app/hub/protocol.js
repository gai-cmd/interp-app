/**
 * Ported from: ~/jarvis2/interp-web/server.js
 * Symbols: publicSettings, castStart, castStop, wss connection audience messages
 * Ported on: 2026-09-05
 * Source SHA-256: b179d94a9de1f6af012e3b40226199bb6c30e4b5564d00b97931cdbbb6cd7d48
 * Protocol reference: ~/jarvis2/interp-web/lib/live.js (LiveLane status events)
 * Source SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Changes: receive-only ES module; strict bounds, field allowlists, no raw errors.
 */
import { ProviderError } from '../providers/contract.js';

// P2-20 must register reviewed endpoints and update ENDPOINT_ORIGINS and CSP.
export const REGISTERED_HUBS = Object.freeze([]);
export const HUB_LIMITS = Object.freeze({ messageBytes: 1048576, textChars: 16000, idChars: 256 });
const languages = ['ko', 'en', 'ja'];
const states = ['connecting', 'connected', 'rotating', 'reconnecting', 'error', 'fatal'];
const invalid = () => { throw new ProviderError('INVALID_RESULT'); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(v);

export function validateRoomCode(code) {
  // Legacy generation removes base64url punctuation, so codes can be shorter than seven.
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(code)) throw new ProviderError('INVALID_REQUEST');
  return code;
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

/** Accept decoded WebSocket text only. P2-11 owns bounded Blob/ArrayBuffer
 * conversion and ordered delivery. Unknown envelopes return null; malformed
 * known envelopes throw a code-only error. No filtering, deduplication, replay
 * inference, seq gap counting, I/O or retained session state occurs here.
 */
export function parseHubMessage(raw) {
  let msg;
  try {
    if (typeof raw !== 'string' || raw.length > HUB_LIMITS.messageBytes
      || new TextEncoder().encode(raw).byteLength > HUB_LIMITS.messageBytes) invalid();
    msg = JSON.parse(raw);
  } catch { invalid(); }
  if (!object(msg) || typeof msg.type !== 'string' || msg.type.length > 64) invalid();
  let event;
  switch (msg.type) {
    case 'hello':
      if (!identifier(msg.sessionId)) invalid();
      event = { type: 'hello', sessionId: msg.sessionId, settings: settings(msg.settings) };
      break;
    case 'settings':
      event = { type: 'settings', settings: settings(msg.settings) };
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
