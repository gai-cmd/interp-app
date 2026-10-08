import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateStore } from '../extension/lib/update-store.js';
import { createFakeFolder } from './fixtures/fake-fs.mjs';

// docs/extension.md §21: the only module that names IndexedDB. It keeps the handle of the extension's own folder in database
// `interp-update`, object store `handles`, key `extensionDir`, takes the factory from the injected env at call time, and
// never throws: every failure is null (load) or false (save, clear). The fake below is the part of IndexedDB the store uses
// (open with upgrade, a transaction that completes after the requests ran, close), with switches for every way it fails.

function createFakeIndexedDb(options = {}) {
  const databases = new Map();                       // name -> { version, stores: Map(name -> Map(key -> value)) }
  const state = { opens: [], upgrades: 0, connections: 0, transactions: [] };
  function connectionOf(database) {
    return {
      objectStoreNames: { contains: (name) => database.stores.has(name) },
      createObjectStore(name) {
        if (options.failCreateStore) throw new DOMException('no', 'InvalidStateError');
        database.stores.set(name, new Map());
        return {};
      },
      transaction(name, mode) {
        if (options.throwOnTransaction) throw new DOMException('no', 'InvalidStateError');
        if (!database.stores.has(name)) throw new DOMException('no such store', 'NotFoundError');
        state.transactions.push([name, mode]);
        const records = database.stores.get(name);
        const queued = [];
        const tx = {
          oncomplete: null, onerror: null, onabort: null,
          objectStore() {
            const request = (run) => {
              const item = { result: undefined, run };
              queued.push(item);
              return item;
            };
            return {
              put: (value, key) => {
                if (options.failClone && typeof value === 'object') throw new DOMException('could not be cloned', 'DataCloneError');
                return request(() => { records.set(key, value); });
              },
              get: (key) => request((item) => { item.result = records.get(key); }),
              delete: (key) => request(() => { records.delete(key); }),
            };
          },
        };
        queueMicrotask(() => queueMicrotask(() => {
          if (options.abortTransactions) { tx.onabort?.(); return; }
          if (options.failTransactions) { tx.onerror?.(); return; }
          for (const item of queued) item.run(item);
          tx.oncomplete?.();
        }));
        return tx;
      },
      close() { state.connections -= 1; },
    };
  }
  return {
    state,
    databases,
    open(name, version) {
      state.opens.push([name, version]);
      if (options.throwOnOpen) throw new DOMException('no', 'SecurityError');
      const request = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        if (options.failOpen) { request.onerror?.(); return; }
        if (options.blockOpen) { request.onblocked?.(); return; }
        let database = databases.get(name);
        const created = database === undefined;
        if (created) { database = { version: 0, stores: new Map() }; databases.set(name, database); }
        request.result = connectionOf(database);
        if (database.version < version) { database.version = version; state.upgrades += 1; request.onupgradeneeded?.({}); }
        state.connections += 1;
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const folderHandle = () => createFakeFolder({ files: { 'manifest.json': '{}' } }).handle;

test('the store keeps the folder handle in database interp-update, store handles, under the key extensionDir', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createUpdateStore({ env: { indexedDB } });
  const handle = folderHandle();
  assert.equal(await store.save(handle), true);
  assert.deepEqual(indexedDB.state.opens, [['interp-update', 1]]);
  assert.deepEqual([...indexedDB.databases.keys()], ['interp-update']);
  assert.deepEqual([...indexedDB.databases.get('interp-update').stores.keys()], ['handles']);
  assert.deepEqual([...indexedDB.databases.get('interp-update').stores.get('handles').keys()], ['extensionDir']);
  assert.equal(indexedDB.databases.get('interp-update').stores.get('handles').get('extensionDir'), handle);
  assert.deepEqual(indexedDB.state.transactions, [['handles', 'readwrite']]);
});

test('save, load and clear round trip, also through another store object on the same database', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createUpdateStore({ env: { indexedDB } });
  assert.equal(await store.load(), null, 'nothing stored yet');
  assert.equal(await store.clear(), true, 'clearing nothing is fine');
  const handle = folderHandle();
  assert.equal(await store.save(handle), true);
  assert.equal(await store.load(), handle);
  assert.equal(await createUpdateStore({ env: { indexedDB } }).load(), handle, 'the record lives in the database, not in the object');
  const replacement = folderHandle();
  assert.equal(await store.save(replacement), true);
  assert.equal(await store.load(), replacement, 'a second save replaces the first');
  assert.equal(await store.clear(), true);
  assert.equal(await store.load(), null);
  assert.equal(indexedDB.state.upgrades, 1, 'the store is created once');
  assert.equal(indexedDB.state.transactions.filter(([, mode]) => mode === 'readonly').length, 5, 'five loads, each one read-only transaction');
});

test('every operation closes its connection', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createUpdateStore({ env: { indexedDB } });
  await store.save(folderHandle());
  assert.equal(indexedDB.state.connections, 0);
  await store.load();
  assert.equal(indexedDB.state.connections, 0);
  await store.clear();
  assert.equal(indexedDB.state.connections, 0);
  const failing = createFakeIndexedDb({ failTransactions: true });
  await createUpdateStore({ env: { indexedDB: failing } }).save(folderHandle());
  assert.equal(failing.state.connections, 0, 'also after a failed transaction');
  const noStore = createFakeIndexedDb({ failCreateStore: true });
  await createUpdateStore({ env: { indexedDB: noStore } }).load();
  assert.equal(noStore.state.connections, 0, 'also when the transaction can not even start');
});

test('a missing, broken or late IndexedDB is a null / false, never an exception', async () => {
  for (const [name, env] of [
    ['no env', undefined], ['null env', null], ['an empty env', {}], ['indexedDB undefined', { indexedDB: undefined }], ['indexedDB null', { indexedDB: null }],
    ['indexedDB a string', { indexedDB: 'nope' }], ['indexedDB without open', { indexedDB: {} }], ['indexedDB.open not a function', { indexedDB: { open: 5 } }],
    ['a getter that throws', { get indexedDB() { throw new Error('storage disabled'); } }],
  ]) {
    const store = createUpdateStore({ env });
    assert.equal(await store.save(folderHandle()), false, `${name}: save`);
    assert.equal(await store.load(), null, `${name}: load`);
    assert.equal(await store.clear(), false, `${name}: clear`);
  }
  assert.equal(await createUpdateStore().load(), null, 'no argument at all');
  assert.equal(await createUpdateStore({}).save(folderHandle()), false);
  // env.indexedDB is read when a call is made, so a page whose factory appears later still works.
  const env = {};
  const store = createUpdateStore({ env });
  assert.equal(await store.save(folderHandle()), false);
  env.indexedDB = createFakeIndexedDb();
  assert.equal(await store.save(folderHandle()), true);
});

test('every failure of the database itself ends as null / false', async () => {
  const handle = folderHandle();
  for (const [name, options] of [
    ['open throws', { throwOnOpen: true }], ['open fails', { failOpen: true }], ['open is blocked', { blockOpen: true }],
    ['the transaction can not start', { throwOnTransaction: true }], ['the store can not be created', { failCreateStore: true }],
    ['the transaction errors', { failTransactions: true }], ['the transaction aborts', { abortTransactions: true }],
  ]) {
    const store = createUpdateStore({ env: { indexedDB: createFakeIndexedDb(options) } });
    assert.equal(await store.save(handle), false, `${name}: save`);
    assert.equal(await store.load(), null, `${name}: load`);
    assert.equal(await store.clear(), false, `${name}: clear`);
  }
  const cloneFails = createFakeIndexedDb({ failClone: true });
  assert.equal(await createUpdateStore({ env: { indexedDB: cloneFails } }).save(handle), false, 'a handle the platform can not clone');
  assert.equal(cloneFails.state.connections, 0);
});

test('only a directory handle is stored, and only a directory handle is returned', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createUpdateStore({ env: { indexedDB } });
  const file = { kind: 'file', getFile() {}, createWritable() {} };
  const half = { kind: 'directory', getFileHandle() {} };
  const lookalike = { kind: 'directory', getFileHandle() {}, getDirectoryHandle() {} };
  for (const [name, value] of [['null', null], ['undefined', undefined], ['a string', 'dir'], ['a number', 5], ['an empty object', {}], ['a file handle', file], ['a directory without getDirectoryHandle', half]]) {
    assert.equal(await store.save(value), false, name);
  }
  assert.equal(indexedDB.state.opens.length, 0, 'a refused value does not even open the database');
  assert.equal(await store.save(lookalike), true, 'what the platform clones as a directory handle has these members');
  // A record somebody else wrote under the key is not a handle.
  await store.clear();
  await store.save(folderHandle());
  const records = indexedDB.databases.get('interp-update').stores.get('handles');
  for (const junk of ['text', 5, null, {}, file, { kind: 'directory' }]) {
    records.set('extensionDir', junk);
    assert.equal(await store.load(), null, JSON.stringify(junk) ?? String(junk));
  }
});

test('the store object is frozen and has exactly save, load and clear', () => {
  const store = createUpdateStore({ env: {} });
  assert.ok(Object.isFrozen(store));
  assert.deepEqual(Object.keys(store).sort(), ['clear', 'load', 'save']);
});
