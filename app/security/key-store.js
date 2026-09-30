// New implementation of design-v0.6 §11/20 and design-p3 §1.7 (P3-08: shared
// metadata carries the payload version and event ID); no legacy code is ported.
import { ProviderError, QUOTA_ERROR_CODES, assertActive } from '../providers/contract.js';
import { assertKeyPolicy, parseSharedFragment, validateKey } from './shared-key.js';
import { SecurityError } from './redact.js';
import { keyFingerprint } from './fingerprint.js';

// 2026-09-30 (owner: "무료키가 교체될때 타임러그를 최대한 줄여서"): a built-in
// key that hit its quota is remembered across starts and page loads, so the
// next visit does not open a session on it only to be refused again. The
// record maps a key FINGERPRINT (8 hex of SHA-256, see fingerprint.js) to the
// epoch millisecond its cooldown ends; the key itself is never written.
export const BUILTIN_COOLDOWN_STORAGE_KEY = 'interp-app.builtin-cooldown.v1';
export const BUILTIN_COOLDOWN = Object.freeze({
  // A per-minute limit (RATE_LIMITED) is over within a minute. The same short
  // wait applies to TOKEN_LIMIT and UNKNOWN_429, see builtinCooldownEnd.
  rateLimitedMs: 60000,
  // A value further ahead than the longest real cooldown (the next Pacific
  // midnight is at most 25 h away, DST included) is corrupt and ignored, so a
  // damaged record can never bench a key for good.
  maxAheadMs: 26 * 3600000,
  maxEntries: 32,
});
// Only a structured per-day quota (DAILY_LIMIT: a QuotaFailure id with PerDay)
// waits for the daily reset. Review 2026-09-30 reversed the first cut, which
// also benched TOKEN_LIMIT and UNKNOWN_429 until midnight: gemini/errors.js
// gives TOKEN_LIMIT only to token quotas whose id does NOT say PerDay, and
// every Live close with a 429 reason is UNKNOWN_429 (no QuotaFailure there),
// so a per-minute or concurrent-session limit benched a key for up to 23 h and
// a reload could find the whole pool "spent" — the opposite of the owner's
// request. docs/architecture.md: an unknown 429 is never taken as daily.
const DAILY_FAMILY = new Set(['DAILY_LIMIT']);
const SHORT_FAMILY = new Set(['RATE_LIMITED', 'TOKEN_LIMIT', 'UNKNOWN_429']);
const fingerprintPattern = /^[0-9a-f]{8}$/;
const PACIFIC = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch { return null; }
})();
// Milliseconds to add to UTC for the wall clock in Los Angeles at `at`.
function pacificOffset(at) {
  const parts = Object.fromEntries(PACIFIC.formatToParts(new Date(at))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  if (!Number.isFinite(wall)) throw new Error('TIME_ZONE');
  return wall - Math.floor(at / 1000) * 1000;
}
/**
 * The first midnight in America/Los_Angeles after `at` (epoch ms). Gemini
 * requests-per-day quotas "reset at midnight Pacific time"
 * (https://ai.google.dev/gemini-api/docs/rate-limits, read 2026-09-30).
 * Without time-zone data the reset is taken as Pacific Standard Time (UTC-8),
 * which is never earlier than the real one.
 */
export function nextPacificMidnight(at) {
  try {
    if (!PACIFIC) throw new Error('TIME_ZONE');
    const offset = pacificOffset(at);
    const wall = new Date(at + offset);
    const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
    // The offset may change before that midnight (DST); Los Angeles never
    // skips or repeats midnight, so one correction at the target is exact.
    return midnight - pacificOffset(midnight - offset);
  } catch {
    const wall = new Date(at - 8 * 3600000);
    return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1) + 8 * 3600000;
  }
}
/** When a built-in key refused with `code` at `at` may be tried again; null for a non-quota code. */
export function builtinCooldownEnd(code, at) {
  if (SHORT_FAMILY.has(code)) return at + BUILTIN_COOLDOWN.rateLimitedMs;
  return DAILY_FAMILY.has(code) ? nextPacificMidnight(at) : null;
}

/**
 * Inject localStorage only when persistence is offered. Only personal methods
 * access it, plus the built-in cooldown record above (fingerprints and times,
 * never a key; unreadable or corrupt storage means "no cooldown").
 * References are opaque and resolve only at adapter authentication.
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
 * A built-in pool rotation emits 'key-rotated', not 'key-changed' (2026-09-30):
 * the spent key is not revoked, so work in progress may continue on the next
 * key; references to the spent key are invalidated all the same.
 */
export function createKeyStore({ registry, storage, now = Date.now,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout } = {}) {
  if (!registry) throw new ProviderError('INVALID_REQUEST');
  const personal = new Map();
  const builtins = new Map();
  const builtinEntry = (pool) => ({ key: pool.keys[pool.index], remembered: false, builtin: true, pool });
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
  // Built-in cooldowns: best effort in both directions. A read that fails or
  // finds anything malformed yields no cooldown; a write that fails is ignored.
  function readCooldowns() {
    const record = new Map();
    try {
      const raw = storage?.getItem(BUILTIN_COOLDOWN_STORAGE_KEY);
      if (typeof raw !== 'string') return record;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return record;
      const at = now();
      for (const [print, until] of Object.entries(parsed).slice(0, BUILTIN_COOLDOWN.maxEntries)) {
        if (fingerprintPattern.test(print) && Number.isFinite(until) && until > at
          && until - at <= BUILTIN_COOLDOWN.maxAheadMs) record.set(print, until);
      }
    } catch { return new Map(); }
    return record;
  }
  // When key `index` of a pool may be used again, or null when it may be used
  // now: the later of its cooldown on this page (pool.spent, set when the pool
  // left it) and the stored one from any page.
  function blockedUntil(pool, index, record) {
    const until = Math.max(pool.spent.get(index) ?? -Infinity, record.get(pool.prints[index]) ?? -Infinity);
    return until > now() ? until : null;
  }
  // The first key after the active one, going round the pool, that is not
  // cooling down; -1 when there is none. Going round (review, 2026-09-30) lets
  // a key skipped at load, or left for a per-minute limit, come back once its
  // cooldown is over instead of the pool reading as spent.
  function spareIndex(pool, record = readCooldowns()) {
    for (let step = 1; step < pool.keys.length; step++) {
      const index = (pool.index + step) % pool.keys.length;
      if (blockedUntil(pool, index, record) === null) return index;
    }
    return -1;
  }
  function rememberCooldown(print, code) {
    const until = builtinCooldownEnd(code, now());
    if (until === null || !storage) return;
    try {
      const record = readCooldowns();
      record.set(print, Math.max(until, record.get(print) ?? 0));
      const entries = [...record].sort((a, b) => b[1] - a[1]).slice(0, BUILTIN_COOLDOWN.maxEntries);
      storage.setItem(BUILTIN_COOLDOWN_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* The pool still moves on; only the memory across loads is lost. */ }
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
    // Owner (2026-09-07): `keys` is one key or a list used in turns — the
    // pool keeps its position, and rotateBuiltin() moves to the next key.
    // 2026-09-30: the pool starts at the first key that is not cooling down
    // (see BUILTIN_COOLDOWN_STORAGE_KEY). When every key is, the pool starts
    // spent — as if each had failed on this page — on the key whose cooldown
    // ends first. The keys themselves stay in memory only.
    setBuiltin(providerId, keys) {
      address(providerId, 'personal');
      const list = [...new Set((Array.isArray(keys) ? keys : [keys]).map((key) => validateKey(key)))];
      if (!list.length) throw new ProviderError('INVALID_KEY');
      const prints = Object.freeze(list.map((key) => keyFingerprint(key)));
      const pool = { keys: Object.freeze(list), prints, index: 0, exhausted: false, spent: new Map() };
      const record = readCooldowns();
      const until = prints.map((_, index) => blockedUntil(pool, index, record));
      pool.index = until.indexOf(null);
      pool.exhausted = pool.index < 0;
      if (pool.exhausted) pool.index = until.indexOf(Math.min(...until));
      builtins.set(providerId, pool);
      if (personal.has(providerId) || shared.has(providerId)) return;
      personal.set(providerId, builtinEntry(pool));
      if (!selection) selection = Object.freeze({ providerId, keySource: 'personal' });
      notify('key-changed', providerId, 'personal');
    },
    /**
     * Moves the built-in pool to its next key after the active one hit its
     * quota. Returns { index, count } when a spare key took over (references
     * to the spent key are invalidated by the 'key-rotated' event), or null
     * when the pool is spent — which the metadata then reports as
     * builtinExhausted. `code` (a 429-family code) records the spent key's
     * cooldown; keys still cooling down (from this page or an earlier one)
     * are skipped, and the search goes round the pool. The key the pool leaves
     * is not chosen again on this page before its cooldown ends — never, for
     * a rotation without a quota code, as before cooldowns existed.
     */
    rotateBuiltin(providerId, { code = null } = {}) {
      address(providerId, 'personal');
      const pool = builtins.get(providerId);
      if (!pool) return null;
      const active = personal.get(providerId)?.builtin === true;
      const end = QUOTA_ERROR_CODES.includes(code) ? builtinCooldownEnd(code, now()) : null;
      pool.spent.set(pool.index, Math.max(pool.spent.get(pool.index) ?? -Infinity, end ?? Infinity));
      // Only the site key that was in use is remembered, never a person's own.
      if (active && end !== null) rememberCooldown(pool.prints[pool.index], code);
      const next = spareIndex(pool);
      if (next < 0) {
        if (pool.exhausted) return null;
        pool.exhausted = true;
        if (active) notify('key-rotated', providerId, 'personal');
        return null;
      }
      pool.index = next;
      pool.exhausted = false;
      if (active) { personal.set(providerId, builtinEntry(pool)); notify('key-rotated', providerId, 'personal'); }
      return Object.freeze({ index: pool.index, count: pool.keys.length });
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
        ? { providerId, keySource, remembered: entry.remembered, length: entry.builtin ? 0 : entry.key.length,
          // builtinSpare (2026-09-30): another key could take over right now,
          // cooldowns included — what a caller asks before relying on a swap.
          ...(entry.builtin ? { builtin: true, builtinIndex: entry.pool.index, builtinCount: entry.pool.keys.length,
            builtinExhausted: entry.pool.exhausted, builtinSpare: spareIndex(entry.pool) >= 0 } : {}) }
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
        personal.set(providerId, builtinEntry(builtins.get(providerId)));
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
