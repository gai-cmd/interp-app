// New implementation of design-v0.6 §5.4/11/20; no legacy code is ported.
import { ProviderError } from '../providers/contract.js';
import { SecurityError } from './redact.js';

export const MAX_FRAGMENT_LENGTH = 8192;
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

// Wire format: #shared=<encodeURIComponent(JSON.stringify(payload))>.
// expiresAt is optional integer Unix milliseconds, an app usage deadline only.
// No encoder is exposed: the browser must not regenerate credential URLs.
export function parseSharedFragment(fragment, { registry, now = Date.now } = {}) {
  try {
    if (typeof fragment !== 'string' || fragment.length > MAX_FRAGMENT_LENGTH
      || !fragment.startsWith('#shared=')) throw new Error();
    const payload = JSON.parse(decodeURIComponent(fragment.slice(8)));
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
      || Object.keys(payload).some((key) => !['version', 'providerId', 'eventName', 'key', 'expiresAt'].includes(key))
      || payload.version !== 1 || typeof payload.providerId !== 'string'
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(payload.providerId)
      || typeof payload.eventName !== 'string' || !payload.eventName.trim()
      || payload.eventName.length > 120 || /[\u0000-\u001f\u007f]/.test(payload.eventName)
      || (payload.expiresAt !== undefined && (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt < 0))) {
      throw new Error();
    }
    assertKeyPolicy(registry, payload.providerId, 'shared');
    validateKey(payload.key);
    if (payload.expiresAt !== undefined && payload.expiresAt <= now()) {
      throw new SecurityError('SHARED_USE_ENDED');
    }
    return Object.freeze({ providerId: payload.providerId, key: payload.key,
      eventName: payload.eventName, expiresAt: payload.expiresAt ?? null });
  } catch (error) {
    throw new SecurityError(error instanceof SecurityError ? error.code : 'INVALID_SHARED_PAYLOAD');
  }
}
