// New implementation of design-v0.6 §11/20; no legacy code is ported.
import { ProviderError, assertActive } from '../providers/contract.js';
import { assertKeyPolicy, parseSharedFragment, validateKey } from './shared-key.js';
import { SecurityError } from './redact.js';

/**
 * Inject localStorage only when persistence is offered. Only personal methods
 * access it. References are opaque and resolve only at adapter authentication.
 * subscribe receives synchronous, secret-free invalidation events. P1-14/19
 * must stop requests/sockets/audio and clear shared temporary records on these
 * events; key revocation alone cannot recall keys already given to a provider.
 * UI eventName is untrusted text, never an administrator identity or HTML.
 */
export function createKeyStore({ registry, storage, now = Date.now,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout } = {}) {
  if (!registry) throw new ProviderError('INVALID_REQUEST');
  const personal = new Map();
  const shared = new Map();
  const references = new WeakMap();
  const listeners = new Set();
  let selection = null;
  let generation = 0;
  let timer;
  let closed = false;
  const storageName = (id) => `interp-app.personal-key.v1.${id}`;
  const ensureOpen = () => { if (closed) throw new SecurityError('STORE_CLOSED'); };
  const mapFor = (source) => source === 'personal' ? personal : shared;
  function address(providerId, keySource) {
    ensureOpen();
    assertKeyPolicy(registry, providerId, keySource);
  }
  function notify(type, providerId = null, keySource = null) {
    generation += 1;
    const event = Object.freeze({ type, providerId, keySource, generation });
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Never retain or propagate consumer errors. */ }
    }
  }
  function persist(method, providerId, key) {
    try {
      if (!storage) throw new Error();
      return storage[method](storageName(providerId), ...(method === 'setItem' ? [key] : []));
    } catch { throw new SecurityError('STORAGE_FAILED'); }
  }
  function armExpiry() {
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    const ends = [...shared.values()].map((entry) => entry.expiresAt).filter((end) => end !== null);
    if (!closed && ends.length) {
      timer = schedule(expireShared, Math.min(2147483647, Math.max(0, Math.min(...ends) - now())));
      timer?.unref?.();
    }
  }
  function expireShared() {
    ensureOpen();
    const ended = [...shared].filter(([, entry]) => entry.expiresAt !== null && entry.expiresAt <= now());
    for (const [id] of ended) {
      shared.delete(id);
      // Keep the selected source: expiry must never fall back to personal.
      notify('shared-use-ended', id, 'shared');
    }
    armExpiry();
  }
  const api = {
    subscribe(listener) {
      ensureOpen();
      if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPersonal(providerId, key, { remember = false } = {}) {
      address(providerId, 'personal');
      validateKey(key);
      if (typeof remember !== 'boolean') throw new ProviderError('INVALID_REQUEST');
      // Invalidate the old key even if removing its persistent copy fails.
      personal.delete(providerId);
      notify('key-deleted', providerId, 'personal');
      if (remember) persist('setItem', providerId, key);
      else if (storage) persist('removeItem', providerId);
      personal.set(providerId, { key, remembered: remember });
      if (!selection) selection = Object.freeze({ providerId, keySource: 'personal' });
      notify('key-changed', providerId, 'personal');
    },
    loadPersonal(providerId) {
      address(providerId, 'personal');
      const key = persist('getItem', providerId);
      if (key === null) return false;
      validateKey(key);
      personal.set(providerId, { key, remembered: true });
      if (!selection) selection = Object.freeze({ providerId, keySource: 'personal' });
      notify('key-changed', providerId, 'personal');
      return true;
    },
    receiveSharedFragment(fragment) {
      ensureOpen();
      const entry = parseSharedFragment(fragment, { registry, now });
      shared.set(entry.providerId, entry);
      armExpiry();
      // Even users without a personal key explicitly choose shared mode.
      notify('key-changed', entry.providerId, 'shared');
    },
    select(providerId, keySource) {
      address(providerId, keySource);
      expireShared();
      if (!mapFor(keySource).has(providerId)) throw new ProviderError('CREDENTIAL_REQUIRED');
      if (selection?.providerId === providerId && selection.keySource === keySource) return;
      selection = Object.freeze({ providerId, keySource });
      notify('selection-changed', providerId, keySource);
    },
    getSelection() { ensureOpen(); return selection; },
    getMetadata(providerId, keySource) {
      address(providerId, keySource);
      expireShared();
      const entry = mapFor(keySource).get(providerId);
      if (!entry) return null;
      return Object.freeze(keySource === 'personal'
        ? { providerId, keySource, remembered: entry.remembered }
        : { providerId, keySource, eventName: entry.eventName,
          usageEndsAt: entry.expiresAt, administratorVerified: false, networkRestrictionVerified: false });
    },
    getCredentialRef({ providerId, keySource, transport }, { signal } = {}) {
      address(providerId, keySource);
      assertActive(signal);
      expireShared();
      if (transport !== 'direct') throw new ProviderError('CREDENTIAL_FORBIDDEN');
      if (selection?.providerId !== providerId || selection?.keySource !== keySource) {
        throw new ProviderError('CREDENTIAL_MISMATCH');
      }
      if (!mapFor(keySource).has(providerId)) throw new ProviderError('CREDENTIAL_REQUIRED');
      const reference = Object.freeze(Object.create(null));
      references.set(reference, { providerId, keySource, generation });
      return Object.freeze({ providerId, keySource, transport, reference });
    },
    resolveCredential(reference, { providerId, keySource, transport }, { signal } = {}) {
      address(providerId, keySource);
      assertActive(signal);
      expireShared();
      const ref = references.get(reference);
      if (!ref || ref.providerId !== providerId || ref.keySource !== keySource || transport !== 'direct'
        || ref.generation !== generation) throw new ProviderError('CREDENTIAL_MISMATCH');
      const entry = mapFor(keySource).get(providerId);
      if (!entry) throw new ProviderError('CREDENTIAL_REQUIRED');
      return entry.key;
    },
    deleteKey(providerId, keySource) {
      address(providerId, keySource);
      mapFor(keySource).delete(providerId);
      armExpiry();
      notify('key-deleted', providerId, keySource);
      if (keySource === 'personal' && storage) persist('removeItem', providerId);
    },
    endShared(providerId) {
      address(providerId, 'shared');
      shared.delete(providerId);
      armExpiry();
      notify('shared-use-ended', providerId, 'shared');
    },
    expireShared,
    dispose() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) unschedule(timer);
      personal.clear();
      shared.clear();
      selection = null;
      notify('store-closed');
      listeners.clear();
    },
  };
  return Object.freeze(api);
}
