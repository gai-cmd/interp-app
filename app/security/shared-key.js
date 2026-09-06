// New implementation of design-v0.6 §5.4/11/20 and design-p3 §1.7 "공용 키
// payload" (P3-08 adds payload v2); no legacy code is ported.
import { ProviderError } from '../providers/contract.js';
import { SecurityError } from './redact.js';

export const MAX_FRAGMENT_LENGTH = 8192;
// Payload versions this parser accepts. v1 is the P1 format; v2 (P3-08) adds
// the policy event ID so the key can be tied to one listed event.
export const SHARED_PAYLOAD_VERSIONS = Object.freeze([1, 2]);
// Same shape as policy sharedEvents[].id (schema.js) and hub control eventId.
export const EVENT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
// C0 controls and DEL, written as escapes so the source stays printable.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');
const V1_KEYS = Object.freeze(['version', 'providerId', 'eventName', 'key', 'expiresAt']);
const V2_KEYS = Object.freeze([...V1_KEYS, 'eventId']);

export function validateKey(key) {
  // Provider-neutral printable ASCII; providers perform actual authentication.
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(key)) {
    throw new ProviderError('INVALID_KEY');
  }
  return key;
}

export function assertKeyPolicy(registry, providerId, keySource) {
  const { descriptor } = registry.get(providerId);
  if (!descriptor.browserDirect || !['personal', 'shared'].includes(keySource)
    || !descriptor.credentialPolicy[keySource === 'personal' ? 'directPersonal' : 'directShared']) {
    throw new ProviderError('CREDENTIAL_FORBIDDEN');
  }
  return descriptor;
}

const validEventName = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 120
  && !CONTROL_CHARS.test(value);
const validDeadline = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Wire format: #shared=<encodeURIComponent(JSON.stringify(payload))>.
 *
 *   v1: { version: 1, providerId, eventName, key, expiresAt? }
 *   v2: { version: 2, providerId, eventId, eventName, key, expiresAt }
 *
 * expiresAt is integer Unix milliseconds, an app usage deadline only (optional
 * in v1, required in v2 because the policy comparison needs it). eventId must
 * match EVENT_ID_PATTERN. Returns a frozen { version, providerId, eventId,
 * key, eventName, expiresAt } with eventId null for v1 and expiresAt null when
 * absent. The parser does not consult the policy: matching the entry against
 * the listed events (v2 by ID plus provider, name and expiry; v1 by a unique
 * provider, name and expiry match) is resolveEffective's job (policy/resolve.js).
 * An eventId is a lookup key, never a signature or proof of the administrator.
 * No encoder is exposed: the browser must not regenerate credential URLs.
 */
export function parseSharedFragment(fragment, { registry, now = Date.now } = {}) {
  try {
    if (typeof fragment !== 'string' || fragment.length > MAX_FRAGMENT_LENGTH
      || !fragment.startsWith('#shared=')) throw new Error();
    const payload = JSON.parse(decodeURIComponent(fragment.slice(8)));
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
      || !SHARED_PAYLOAD_VERSIONS.includes(payload.version)) throw new Error();
    const version = payload.version;
    const allowed = version === 2 ? V2_KEYS : V1_KEYS;
    if (Object.keys(payload).some((key) => !allowed.includes(key))
      || typeof payload.providerId !== 'string' || !PROVIDER_ID_PATTERN.test(payload.providerId)
      || !validEventName(payload.eventName)
      || (payload.expiresAt !== undefined && !validDeadline(payload.expiresAt))) {
      throw new Error();
    }
    if (version === 2 && (typeof payload.eventId !== 'string' || !EVENT_ID_PATTERN.test(payload.eventId)
      || payload.expiresAt === undefined)) {
      throw new Error();
    }
    assertKeyPolicy(registry, payload.providerId, 'shared');
    validateKey(payload.key);
    if (payload.expiresAt !== undefined && payload.expiresAt <= now()) {
      throw new SecurityError('SHARED_USE_ENDED');
    }
    return Object.freeze({ version, providerId: payload.providerId, eventId: version === 2 ? payload.eventId : null,
      key: payload.key, eventName: payload.eventName, expiresAt: payload.expiresAt ?? null });
  } catch (error) {
    throw new SecurityError(error instanceof SecurityError ? error.code : 'INVALID_SHARED_PAYLOAD');
  }
}
