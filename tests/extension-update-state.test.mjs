import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../extension/lib/protocol.js';
import { UPDATE_ERROR_CODES } from '../extension/lib/self-update.js';
import { createUpdateStateApi, normalizeUpdateState } from '../extension/lib/update-state.js';

// docs/extension.md §21: the small record `interp.update.v1` of the self-update. What matters: garbage can never produce an
// unsafe value (appliedPaths decides what the next update may DELETE), and a patch changes only the fields it names with one write.

const DEFAULTS = Object.freeze({ v: 1, folder: false, autoApply: true, appliedVersion: null, appliedPaths: [], pending: null, lastError: null });
const KEY = 'interp.update.v1';

function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}
/** An in-memory chrome.storage.local that counts its writes; `delay` makes every call yield, so overlapping calls interleave. */
function createLocal({ data = {}, delay = false, failSet = false, failGet = false } = {}) {
  const store = { ...data };
  const log = { gets: 0, sets: [] };
  const yielded = async () => { if (delay) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    store,
    log,
    async get(key) {
      log.gets += 1;
      await yielded();
      if (failGet) throw new Error('storage read failed');
      return Object.hasOwn(store, key) ? { [key]: structuredClone(store[key]) } : {};
    },
    async set(items) {
      await yielded();
      if (failSet) throw new Error('storage write failed');
      log.sets.push(structuredClone(items));
      for (const [key, value] of Object.entries(items)) store[key] = structuredClone(value);
    },
  };
}

test('the record lives under interp.update.v1', () => {
  assert.equal(STORAGE_KEYS.update, KEY);
  assert.ok(Object.isFrozen(STORAGE_KEYS));
});

test('normalizeUpdateState: anything that is not a record gives the defaults, frozen', () => {
  for (const garbage of [undefined, null, 0, 5, 'text', true, [], [1, 2], () => {}, Symbol.iterator, {}, new Map(), new (class Thing { folder = true; })()]) {
    const state = normalizeUpdateState(garbage);
    assert.deepEqual(state, DEFAULTS, String(garbage?.constructor?.name ?? garbage));
    assert.ok(isDeepFrozen(state));
  }
  assert.deepEqual(normalizeUpdateState(), DEFAULTS);
  assert.notEqual(normalizeUpdateState(), normalizeUpdateState(), 'a fresh object each time');
});

test('normalizeUpdateState: a good record survives unchanged and is idempotent', () => {
  const good = { v: 1, folder: true, autoApply: false, appliedVersion: '0.5.0', appliedPaths: ['manifest.json', 'extension/lib/a.js'], pending: { version: '0.6.0', at: 1234 }, lastError: 'UPDATE_WRITE_FAILED' };
  const state = normalizeUpdateState(good);
  assert.deepEqual(state, good);
  assert.deepEqual(normalizeUpdateState(state), good);
  assert.ok(isDeepFrozen(state));
  assert.deepEqual(good.appliedPaths, ['manifest.json', 'extension/lib/a.js'], 'the input is not touched');
});

test('normalizeUpdateState: each field falls back alone, and only to its safe value', () => {
  const only = (field, value) => normalizeUpdateState({ [field]: value });
  // folder: only the boolean true means a folder was chosen
  for (const value of [false, 0, 1, 'true', 'yes', null, {}, []]) assert.equal(only('folder', value).folder, false, `folder ${JSON.stringify(value)}`);
  assert.equal(only('folder', true).folder, true);
  // autoApply: default ON; only a boolean overrides it
  assert.equal(only('autoApply', undefined).autoApply, true);
  assert.equal(only('autoApply', false).autoApply, false);
  assert.equal(only('autoApply', true).autoApply, true);
  for (const value of ['no', 0, null, {}, 'false']) assert.equal(only('autoApply', value).autoApply, true, `autoApply ${JSON.stringify(value)}`);
  // appliedVersion: a Chrome version string or null
  assert.equal(only('appliedVersion', '1.2.3.4').appliedVersion, '1.2.3.4');
  for (const value of ['v1', '1.2.3.4.5', '', 5, null, {}, '../1', '1..2']) assert.equal(only('appliedVersion', value).appliedVersion, null, `appliedVersion ${JSON.stringify(value)}`);
  // lastError: one of the UPDATE_ codes or null
  for (const code of UPDATE_ERROR_CODES) assert.equal(only('lastError', code).lastError, code, code);
  for (const value of ['UPDATE_FAKE', 'INTERNAL', 'update_busy', '', 5, null, {}, ['UPDATE_BUSY']]) assert.equal(only('lastError', value).lastError, null, `lastError ${JSON.stringify(value)}`);
  // v is always 1 and unknown fields are dropped
  assert.equal(normalizeUpdateState({ v: 7 }).v, 1);
  assert.deepEqual(Object.keys(normalizeUpdateState({ extra: 1, __proto__: { x: 1 }, folder: true })).sort(), Object.keys(DEFAULTS).sort());
});

test('normalizeUpdateState: pending is a version and a non-negative whole number of milliseconds, nothing else', () => {
  assert.deepEqual(normalizeUpdateState({ pending: { version: '0.5.0', at: 0 } }).pending, { version: '0.5.0', at: 0 });
  assert.deepEqual(normalizeUpdateState({ pending: { version: '0.5.0', at: 1, extra: 'x' } }).pending, { version: '0.5.0', at: 1 }, 'extra fields are dropped');
  for (const pending of [null, undefined, 5, 'x', [], {}, { version: '0.5.0' }, { at: 1 }, { version: 'x', at: 1 }, { version: '0.5.0', at: -1 }, { version: '0.5.0', at: 1.5 },
    { version: '0.5.0', at: '1' }, { version: '0.5.0', at: NaN }, { version: '0.5.0', at: Infinity }, { version: '0.5.0', at: 2 ** 60 }, { version: 5, at: 1 }]) {
    assert.equal(normalizeUpdateState({ pending }).pending, null, JSON.stringify(pending) ?? String(pending));
  }
});

test('normalizeUpdateState: appliedPaths keeps only safe paths, each once, in order, at most 400', () => {
  const unsafe = ['../escape.js', '/abs.js', 'a\\b.js', 'C:/x.js', '_metadata/x', 'a//b', 'a/./b', 'a/../b', '', ' a', 'a.', 'con.js', '_x.js', 'é.js', 'a\u0000b', 5, null, undefined, {}, ['a.js'], true];
  const state = normalizeUpdateState({ appliedPaths: ['manifest.json', ...unsafe, 'extension/lib/a.js', 'manifest.json', '_locales/en/messages.json', 'extension/lib/a.js'] });
  assert.deepEqual(state.appliedPaths, ['manifest.json', 'extension/lib/a.js', '_locales/en/messages.json']);
  for (const value of [undefined, null, 'manifest.json', {}, 5, { 0: 'manifest.json', length: 1 }]) assert.deepEqual(normalizeUpdateState({ appliedPaths: value }).appliedPaths, [], String(value));
  const many = Array.from({ length: 500 }, (_, index) => `extension/f${index}.js`);
  const capped = normalizeUpdateState({ appliedPaths: many }).appliedPaths;
  assert.equal(capped.length, 400);
  assert.deepEqual(capped, many.slice(0, 400), 'the first 400, in order');
  assert.equal(normalizeUpdateState({ appliedPaths: Array.from({ length: 400 }, (_, index) => `f${index}`) }).appliedPaths.length, 400);
  // A record that was corrupted on disk never yields a path outside the folder, whatever the shape.
  const corrupted = normalizeUpdateState(JSON.parse('{"appliedPaths":["ok.js","../../etc/passwd","..\\\\..\\\\x"],"__proto__":{"appliedPaths":["../x"]}}'));
  assert.deepEqual(corrupted.appliedPaths, ['ok.js']);
});

test('normalizeUpdateState never throws, even for an object whose fields throw when read', () => {
  const hostile = { get folder() { throw new Error('boom'); } };
  assert.deepEqual(normalizeUpdateState(hostile), DEFAULTS);
  const hostilePaths = { appliedPaths: new Proxy([], { get() { throw new Error('boom'); } }) };
  assert.deepEqual(normalizeUpdateState(hostilePaths), DEFAULTS);
});

test('read returns the normalized stored record, and the defaults when there is none, garbage, or the storage fails', async () => {
  const stored = { v: 1, folder: true, autoApply: false, appliedVersion: '0.5.0', appliedPaths: ['manifest.json'], pending: null, lastError: 'UPDATE_BUSY' };
  assert.deepEqual(await createUpdateStateApi({ local: createLocal({ data: { [KEY]: stored } }) }).read(), stored);
  assert.deepEqual(await createUpdateStateApi({ local: createLocal() }).read(), DEFAULTS);
  assert.deepEqual(await createUpdateStateApi({ local: createLocal({ data: { [KEY]: 'garbage' } }) }).read(), DEFAULTS);
  assert.deepEqual(await createUpdateStateApi({ local: createLocal({ data: { [KEY]: { folder: 'yes', appliedPaths: ['../x'] } } }) }).read(), DEFAULTS);
  assert.deepEqual(await createUpdateStateApi({ local: createLocal({ failGet: true }) }).read(), DEFAULTS, 'a storage that fails reads as the defaults');
  assert.deepEqual(await createUpdateStateApi({ local: { get: async () => null } }).read(), DEFAULTS, 'a storage that answers nothing');
  assert.deepEqual(await createUpdateStateApi({ local: { get: () => { throw new Error('sync'); } } }).read(), DEFAULTS);
  const other = createLocal({ data: { 'interp.settings.v1': { folder: true } } });
  assert.deepEqual(await createUpdateStateApi({ local: other }).read(), DEFAULTS, 'another key is not this record');
  assert.ok(isDeepFrozen(await createUpdateStateApi({ local: createLocal() }).read()));
});

test('patch changes only the named fields, with one write, under interp.update.v1', async () => {
  const local = createLocal({ data: { [KEY]: { v: 1, folder: true, autoApply: false, appliedVersion: '0.4.0', appliedPaths: ['manifest.json'], pending: null, lastError: 'UPDATE_BUSY' } } });
  const api = createUpdateStateApi({ local });
  const next = await api.patch({ pending: { version: '0.5.0', at: 7 } });
  assert.equal(local.log.sets.length, 1, 'one write');
  assert.deepEqual(Object.keys(local.log.sets[0]), [KEY]);
  assert.deepEqual(next, { v: 1, folder: true, autoApply: false, appliedVersion: '0.4.0', appliedPaths: ['manifest.json'], pending: { version: '0.5.0', at: 7 }, lastError: 'UPDATE_BUSY' });
  assert.deepEqual(local.store[KEY], next, 'what is stored is what is returned');
  assert.deepEqual(await api.read(), next);
  assert.ok(isDeepFrozen(next));
  // Several fields at once, and clearing with null.
  const cleared = await api.patch({ pending: null, appliedVersion: '0.5.0', appliedPaths: ['a.js', 'b.js'], lastError: null });
  assert.equal(local.log.sets.length, 2);
  assert.deepEqual(cleared, { v: 1, folder: true, autoApply: false, appliedVersion: '0.5.0', appliedPaths: ['a.js', 'b.js'], pending: null, lastError: null });
  assert.deepEqual((await api.patch({ folder: false, autoApply: true })).folder, false);
  assert.equal((await api.patch({ appliedVersion: null })).appliedVersion, null);
});

test('patch ignores unknown fields and undefined values, and normalizes what it stores', async () => {
  const local = createLocal();
  const api = createUpdateStateApi({ local });
  await api.patch({ folder: true, appliedVersion: '0.5.0' });
  const next = await api.patch({ v: 9, extra: 'x', folder: undefined, appliedVersion: undefined, lastError: 'UPDATE_NOT_A_CODE', appliedPaths: ['ok.js', '../bad.js', '/abs'], autoApply: 'maybe', pending: { version: 'x', at: 1 } });
  assert.deepEqual(next, { v: 1, folder: true, autoApply: true, appliedVersion: '0.5.0', appliedPaths: ['ok.js'], pending: null, lastError: null });
  assert.deepEqual(local.store[KEY], next);
  assert.deepEqual(Object.keys(local.store[KEY]).sort(), Object.keys(DEFAULTS).sort());
  for (const empty of [undefined, null, 5, 'x', [], {}]) {
    const before = local.log.sets.length;
    assert.deepEqual(await api.patch(empty), next, `patch(${JSON.stringify(empty)}) changes nothing`);
    assert.equal(local.log.sets.length, before + 1, 'and still writes once');
  }
});

test('patches that overlap in time do not lose each other\'s fields, and a failed write does not stop the next patch', async () => {
  const local = createLocal({ delay: true });
  const api = createUpdateStateApi({ local });
  await Promise.all([
    api.patch({ folder: true }), api.patch({ appliedVersion: '0.5.0' }), api.patch({ autoApply: false }), api.patch({ lastError: 'UPDATE_BAD_HASH' }),
    api.patch({ appliedPaths: ['manifest.json'] }),
  ]);
  assert.deepEqual(await api.read(), { v: 1, folder: true, autoApply: false, appliedVersion: '0.5.0', appliedPaths: ['manifest.json'], pending: null, lastError: 'UPDATE_BAD_HASH' });
  assert.equal(local.log.sets.length, 5);
  const failing = createLocal({ failSet: true });
  const failingApi = createUpdateStateApi({ local: failing });
  await assert.rejects(failingApi.patch({ folder: true }), /storage write failed/);
  const broken = { calls: 0, async get() { return {}; }, async set() { broken.calls += 1; if (broken.calls === 1) throw new Error('first write fails'); } };
  const brokenApi = createUpdateStateApi({ local: broken });
  const first = brokenApi.patch({ folder: true });
  const second = brokenApi.patch({ folder: true });
  await assert.rejects(first, /first write fails/);
  assert.deepEqual((await second).folder, true, 'the queue is not poisoned by the first failure');
});

test('the state record holds no handle, no key and no secret: only its seven fields', async () => {
  const local = createLocal();
  await createUpdateStateApi({ local }).patch({ folder: true, appliedVersion: '0.5.0', appliedPaths: ['a.js'], pending: { version: '0.6.0', at: 1 }, lastError: 'UPDATE_BUSY' });
  assert.deepEqual(Object.keys(local.store[KEY]), ['v', 'folder', 'autoApply', 'appliedVersion', 'appliedPaths', 'pending', 'lastError']);
  assert.equal(JSON.stringify(local.store).includes('handle'), false);
});
