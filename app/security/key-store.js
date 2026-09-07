// New implementation of design-v0.6 §11/20 and design-p3 §1.7 (P3-08: shared
// metadata carries the payload version and event ID); no legacy code is ported.
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
 *
 * Shared keys live in memory only and are never persisted. Their metadata
 * ({ version, eventId, eventName, usageEndsAt, providerId }) is the descriptor
 * the composition root hands to the policy runtime, which resolves it against
 * the listed events (policy/resolve.js): v2 by eventId plus provider, name and
 * expiry; v1 (eventId null) by a unique provider, name and expiry match. The
 * store itself never consults the policy and treats no eventId as a signature.
 * A personal key stays selected when a shared payload arrives (personal first).
 */
export function createKeyStore({ registry, storage, now = Date.now,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout } = {}) {
  if (!registry) throw new ProviderError('INVALID_REQUEST');
  const personal = new Map();
  const builtins = new Map();
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
  // P3-02e: a write that raised nothing is not proof of persistence (private
  // browsing, evicted or quota-limited storage). Read the value back; on a
  // mismatch remove whatever was written and report the failure, so the UI
  // never claims "saved in this browser" for a key that will not survive.
  function persistVerified(providerId, key) {
    persist('setItem', providerId, key);
    let stored;
    try { stored = storage.getItem(storageName(providerId)); } catch { stored = undefined; }
    if (stored === key) return;
    try { storage.removeItem(storageName(providerId)); } catch { /* Nothing readable was kept. */ }
    throw new SecurityError('STORAGE_FAILED');
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
    // Built-in credentials use the personal transport, but are never UI secrets
    // or persistent user entries. Register even when a personal key wins.
    setBuiltin(providerId, key) {
      address(providerId, 'personal');
      validateKey(key);
      const entry = { key, remembered: false, builtin: true };
      builtins.set(providerId, entry);
      if (personal.has(providerId) || shared.has(providerId)) return;
      personal.set(providerId, entry);
      if (!selection) selection = Object.freeze({ providerId, keySource: 'personal' });
      notify('key-changed', providerId, 'personal');
    },
    setPersonal(providerId, key, { remember = false } = {}) {
      address(providerId, 'personal');
      validateKey(key);
      if (typeof remember !== 'boolean') throw new ProviderError('INVALID_REQUEST');
      // Invalidate the old key even if removing its persistent copy fails.
      personal.delete(providerId);
      notify('key-deleted', providerId, 'personal');
      if (remember) persistVerified(providerId, key);
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
      // Shared metadata is the policy-matching descriptor (never the key):
      // version and eventId (null for v1) come straight from the payload.
      return Object.freeze(keySource === 'personal'
        // P3-22 (owner, 2026-09-06): the settings screen shows a mask of the
        // stored key so the field does not look empty on a phone. The mask
        // needs the length and nothing else, so the length — not the value —
        // is what the metadata carries.
        ? { providerId, keySource, remembered: entry.remembered, length: entry.builtin ? 0 : entry.key.length, ...(entry.builtin ? { builtin: true } : {}) }
        : { providerId, keySource, version: entry.version, eventId: entry.eventId, eventName: entry.eventName,
          usageEndsAt: entry.expiresAt, administratorVerified: false, networkRestrictionVerified: false });
    },
    // P3-22 (owner, 2026-09-06): the only path that hands a key value back to
    // the UI, for the explicit "show" toggle of the personal key entry. It
    // narrows design-p3 §1.12 "저장 키 자동 재노출 없음": nothing is revealed
    // automatically — a person must press the toggle, and the settings view
    // clears the field again on hide, on save and when the screen closes.
    //
    // Personal keys only. A shared event key is never revealed or persisted
    // (§1.12), and no reference, storage read or provider call happens here.
    revealPersonal(providerId) {
      address(providerId, 'personal');
      const entry = personal.get(providerId);
      return entry?.builtin ? null : entry?.key ?? null;
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
      if (keySource === 'personal' && personal.get(providerId)?.builtin) return;
      mapFor(keySource).delete(providerId);
      if (keySource === 'personal' && builtins.has(providerId) && !shared.has(providerId)) {
        personal.set(providerId, builtins.get(providerId));
      }
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
      builtins.clear();
      shared.clear();
      selection = null;
      notify('store-closed');
      listeners.clear();
    },
  };
  return Object.freeze(api);
}
