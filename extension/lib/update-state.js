// New implementation of docs/extension.md §21 (owner, 2026-10-08); no legacy code is ported.
// The self-update's small persistent record, `interp.update.v1` in chrome.storage.local (STORAGE_KEYS.update): whether a
// folder was chosen, whether to apply updates by itself, what was applied last (the version and the paths, which is how the
// next update knows what is obsolete), an apply that was started and not finished, and the code of the last failure. The
// storage area is INJECTED (`adapter.storage.local`), so this module names no platform API and touches nothing at import
// time. It holds no secret and no handle (the handle is in update-store.js).
import { deepFreeze, isPlainObject } from './constants.js';
import { STORAGE_KEYS } from './protocol.js';
import { SELF_UPDATE_LIMITS, UPDATE_ERROR_CODES, isSafeUpdatePath } from './self-update.js';
import { parseVersion } from './update-check.js';

const MAX_PATHS = SELF_UPDATE_LIMITS.maxFiles;

function pendingOf(raw) {
  if (!isPlainObject(raw) || parseVersion(raw.version) === null || !Number.isSafeInteger(raw.at) || raw.at < 0) return null;
  return { version: raw.version, at: raw.at };
}

/**
 * Total: never throws. Garbage of any shape gives the safe defaults (no folder, automatic updates ON, nothing applied, nothing
 * pending, no error); `v` is always 1; unknown fields are dropped. appliedPaths keeps only safe paths (each once, in order, at
 * most 400): it decides what the next update may DELETE, so an entry that is not a safe path must never survive a round trip.
 * Frozen.
 */
export function normalizeUpdateState(raw) {
  try {
    const source = isPlainObject(raw) ? raw : {};
    const paths = Array.isArray(source.appliedPaths) ? source.appliedPaths : [];
    return deepFreeze({
      v: 1,
      folder: source.folder === true,
      autoApply: typeof source.autoApply === 'boolean' ? source.autoApply : true,
      appliedVersion: parseVersion(source.appliedVersion) === null ? null : source.appliedVersion,
      appliedPaths: [...new Set(paths.filter(isSafeUpdatePath))].slice(0, MAX_PATHS),
      pending: pendingOf(source.pending),
      lastError: UPDATE_ERROR_CODES.includes(source.lastError) ? source.lastError : null,
    });
  } catch {
    return deepFreeze({ v: 1, folder: false, autoApply: true, appliedVersion: null, appliedPaths: [], pending: null, lastError: null });
  }
}

// Writers to the same area run one after another, so two overlapping patches of one realm cannot lose each other's field.
const queues = new WeakMap();
function serialized(area, task) {
  if (Object(area) !== area) return Promise.resolve().then(task);
  const next = (queues.get(area) ?? Promise.resolve()).then(task, task);
  queues.set(area, next.then(() => undefined, () => undefined));
  return next;
}

const FIELDS = Object.freeze(['folder', 'autoApply', 'appliedVersion', 'appliedPaths', 'pending', 'lastError']);

/**
 * createUpdateStateApi({ local }) -> { read(), patch(partial) }. `local` is adapter.storage.local. read() never rejects: a
 * storage that fails or holds garbage reads as the defaults. patch(partial) reads the stored record, replaces the named
 * fields (only the six above; `undefined` leaves a field alone, `null` clears pending / appliedVersion / lastError),
 * normalizes and stores the result with ONE write, and resolves it. A storage error rejects (the updater decides what that means).
 */
export function createUpdateStateApi({ local } = {}) {
  const key = STORAGE_KEYS.update;
  const load = async () => {
    const stored = await local.get(key);
    return normalizeUpdateState(isPlainObject(stored) ? stored[key] : undefined);
  };
  return Object.freeze({
    async read() {
      try { return await load(); } catch { return normalizeUpdateState(undefined); }
    },
    patch(partial) {
      return serialized(local, async () => {
        const current = await load();
        const merged = { ...current };
        for (const field of FIELDS) if (isPlainObject(partial) && Object.hasOwn(partial, field) && partial[field] !== undefined) merged[field] = partial[field];
        const next = normalizeUpdateState(merged);
        await local.set({ [key]: next });
        return next;
      });
    },
  });
}
