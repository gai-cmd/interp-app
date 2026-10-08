// New implementation of docs/extension.md §21 (owner, 2026-10-08); no legacy code is ported.
// Where the self-update keeps the handle of the extension's own folder. A FileSystemDirectoryHandle cannot go into
// chrome.storage (it is not JSON), so it lives in IndexedDB, which stores it by structured clone, in database
// `interp-update`, object store `handles`, under the key `extensionDir`. This is the ONLY module of the extension that may
// name IndexedDB (the R11 scan exempts exactly this file): the factory is read from the injected `env` at call time, never
// at import time. The store never throws and never hangs on a refusal: a missing factory, a blocked or failed open, a
// refused transaction and a value that is not a directory handle all end as null / false, and the caller treats "no handle"
// as "no folder chosen yet".
const DB_NAME = 'interp-update';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'extensionDir';

const isDirectoryHandle = (value) => value !== null && typeof value === 'object' && value.kind === 'directory'
  && typeof value.getFileHandle === 'function' && typeof value.getDirectoryHandle === 'function';

/** Opens the database (creating the store on the first open); resolves null when that is not possible. */
function openDatabase(env) {
  return new Promise((resolve) => {
    try {
      const factory = env?.indexedDB;
      if (factory === undefined || factory === null || typeof factory.open !== 'function') { resolve(null); return; }
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        try { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME); } catch { /* the open then fails below */ }
      };
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

/**
 * Runs one transaction: `makeRequest(objectStore)` starts the request, and the result is read once the transaction has
 * completed. Resolves { ok: true, value } or { ok: false }; the database is closed in every case.
 */
async function transact(env, mode, makeRequest) {
  const db = await openDatabase(env);
  if (db === null) return { ok: false };
  try {
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, mode);
        const request = makeRequest(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve({ ok: true, value: request.result });
        tx.onerror = () => resolve({ ok: false });
        tx.onabort = () => resolve({ ok: false });
      } catch { resolve({ ok: false }); }
    });
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/**
 * createUpdateStore({ env }) -> Readonly<{ save(handle), load(), clear() }>. `env.indexedDB` is the factory (the pages
 * pass their own window's, a test passes a fake). save(handle) resolves true when the handle was stored (a value that is
 * not a directory handle is refused with false, and so is a handle the platform cannot clone); load() resolves the stored
 * directory handle or null; clear() resolves true when the record is gone (also when there was none).
 */
export function createUpdateStore({ env } = {}) {
  return Object.freeze({
    async save(handle) {
      if (!isDirectoryHandle(handle)) return false;
      return (await transact(env, 'readwrite', (store) => store.put(handle, HANDLE_KEY))).ok;
    },
    async load() {
      const result = await transact(env, 'readonly', (store) => store.get(HANDLE_KEY));
      return result.ok && isDirectoryHandle(result.value) ? result.value : null;
    },
    async clear() {
      return (await transact(env, 'readwrite', (store) => store.delete(HANDLE_KEY))).ok;
    },
  });
}
