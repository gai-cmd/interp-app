import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { generateUpdateKeyPair, signUpdateManifest } from '../scripts/update-signing.mjs';
import { UPDATE_ERROR_CODES } from '../extension/lib/self-update.js';
import { updateTreeUrls } from '../extension/lib/update-check.js';
import { createFetchBytes, createSelfUpdater } from '../extension/lib/update-run.js';
import { createUpdateStateApi } from '../extension/lib/update-state.js';
import { buildSignedTree, createFakeFolder, createFakeSite } from './fixtures/fake-fs.mjs';

// docs/extension.md §21: the orchestration of the self-update, run with fakes only: a fake download site (Response objects
// and a byte fetcher), an in-memory folder shaped like a FileSystemDirectoryHandle (permission states, locks, interruptions),
// an in-memory handle store and storage area. Nothing here touches a network, a disk, a browser or a key of the owner; the
// signatures are made with throw-away keys and verified by the extension's own WebCrypto path.

const subtle = webcrypto.subtle;
const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const primary = generateUpdateKeyPair();
const stranger = generateUpdateKeyPair();
const KEY = 'interp.update.v1';

const RUNNING_MANIFEST = '{"manifest_version":3,"version":"0.4.0"}\n';
const OLD_FILES = Object.freeze({
  'manifest.json': RUNNING_MANIFEST, 'extension/lib/a.js': 'export const a = 1;\n', 'extension/lib/old.js': 'export const old = 1;\n',
  'extension/panel/panel.html': '<!doctype html><!-- old -->\n', 'user-notes.txt': 'mine',
});
const NEW_FILES = Object.freeze({
  'manifest.json': '{"manifest_version":3,"version":"0.5.0"}\n', 'extension/lib/a.js': 'export const a = 2;\n',
  'extension/panel/panel.html': '<!doctype html>\n', '_locales/en/messages.json': '{}\n', 'icons/icon-16.png': 'PNG',
});
const PREVIOUS = Object.freeze(['manifest.json', 'extension/lib/a.js', 'extension/lib/old.js', 'extension/panel/panel.html']);
const NEW_PATHS = Object.keys(NEW_FILES).sort();

/** An in-memory chrome.storage.local. */
function createLocal(initial) {
  const store = initial === undefined ? {} : { [KEY]: structuredClone(initial) };
  const log = { sets: 0 };
  return {
    store,
    log,
    async get(key) { return Object.hasOwn(store, key) ? { [key]: structuredClone(store[key]) } : {}; },
    async set(items) { log.sets += 1; for (const [key, value] of Object.entries(items)) store[key] = structuredClone(value); },
  };
}

/** Everything one test needs, all fakes; `overrides` replace any createSelfUpdater option. */
function setup({ folderOptions = {}, state, overrides = {}, handle: handleOverride, tree: treeOverride, running = '0.4.0', latest = '0.5.0' } = {}) {
  const tree = treeOverride ?? buildSignedTree({ version: '0.5.0', files: NEW_FILES, privatePem: primary.privatePem });
  const site = createFakeSite({ latest, trees: [tree] });
  const folder = createFakeFolder({ files: OLD_FILES, ...folderOptions });
  const local = createLocal(state);
  const stateApi = createUpdateStateApi({ local });
  const store = {
    handle: handleOverride === undefined ? folder.handle : handleOverride, loads: 0, saves: [], clears: 0, saveResult: true,
    async load() { store.loads += 1; return store.handle; },
    async save(handle) { store.saves.push(handle); if (store.saveResult === true) store.handle = handle; return store.saveResult; },
    async clear() { store.clears += 1; store.handle = null; return true; },
  };
  const calls = { reloads: [], picks: 0 };
  const options = {
    fetch: site.fetch, fetchBytes: site.fetchBytes, subtle, store, stateApi, publicKeys: [primary.publicB64], keyed: true,
    running: { version: running, manifestBytes: async () => enc(RUNNING_MANIFEST) },
    pickDirectory: async () => { calls.picks += 1; return folder.handle; },
    reload: () => { calls.reloads.push(folder.commits.length); },
    now: () => 5000,
    ...overrides,
  };
  const updater = createSelfUpdater(options);
  return { tree, site, folder, local, stateApi, store, calls, updater, options, state: () => stateApi.read() };
}
const textOf = (folder) => new Map([...folder.snapshot()].map(([path, bytes]) => [path, dec(bytes)]));
const fileRequests = (site) => site.requests.filter((url) => url.includes('/files/'));

/** Publishes a manifest that was signed over its exact text: `object` is written the way the release script writes it. */
function publish(site, version, object, pem = primary.privatePem) {
  const urls = updateTreeUrls(version);
  const bytes = enc(typeof object === 'string' ? object : `${JSON.stringify(object, null, 2)}\n`);
  site.override(urls.manifest, bytes);
  site.override(urls.signature, enc(`${signUpdateManifest(bytes, pem)}\n`));
}

// ---------------------------------------------------------------------------------------------------------------------
// enabled

test('the updater is enabled only in a keyed build that has public keys and a folder picker', async () => {
  const flags = (overrides) => setup({ overrides }).updater.enabled;
  assert.equal(flags({}), true);
  assert.equal(flags({ keyed: false }), false);
  assert.equal(flags({ keyed: undefined }), false);
  assert.equal(flags({ keyed: 'yes' }), false, 'only the boolean true');
  assert.equal(flags({ keyed: 1 }), false);
  assert.equal(flags({ publicKeys: [] }), false);
  assert.equal(flags({ publicKeys: null }), false);
  assert.equal(flags({ pickDirectory: undefined }), false);
  assert.equal(flags({ pickDirectory: 'pick' }), false);
  assert.equal(createSelfUpdater().enabled, false);
  assert.equal(createSelfUpdater({}).enabled, false);
  const { updater } = setup();
  assert.ok(Object.isFrozen(updater));
  assert.deepEqual(Object.keys(updater).sort(), ['check', 'chooseFolder', 'enabled', 'forgetFolder', 'run', 'setAutoApply', 'status']);
});

test('an unkeyed build (a development folder) can never update: run and chooseFolder refuse without touching anything', async () => {
  const world = setup({ overrides: { keyed: false } });
  assert.deepEqual(await world.updater.run(), { ok: false, code: 'UPDATE_DISABLED' });
  assert.deepEqual(await world.updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_DISABLED' });
  assert.deepEqual(await world.updater.chooseFolder(), { ok: false, code: 'UPDATE_DISABLED' });
  assert.deepEqual(world.site.requests, [], 'no request at all');
  assert.equal(world.store.loads, 0, 'the stored handle is not even opened');
  assert.equal(world.calls.picks, 0);
  assert.ok(world.folder.untouched);
  assert.equal(world.folder.requests, 0);
  assert.equal(world.local.log.sets, 0, 'and nothing is recorded: nothing was tried');
  assert.deepEqual(await world.updater.status(), { enabled: false, folder: 'none', autoApply: true, appliedVersion: null, pending: null, lastError: null });
  assert.equal(world.calls.reloads.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// the whole flow

test('run: checks, downloads, verifies, writes (manifest.json last), records the state and only then reloads', async () => {
  const world = setup({ state: { v: 1, folder: true, appliedVersion: '0.4.0', appliedPaths: PREVIOUS, lastError: 'UPDATE_WRITE_FAILED' } });
  const steps = [];
  const result = await world.updater.run({ onStep: (name) => steps.push(name) });
  assert.deepEqual(result, { ok: true, version: '0.5.0' });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(steps, ['checking', 'downloading', 'verifying', 'writing', 'reloading']);
  assert.equal(world.folder.commits.at(-1), 'manifest.json');
  assert.deepEqual([...world.folder.commits].sort(), NEW_PATHS);
  assert.deepEqual(textOf(world.folder), new Map([...Object.entries(NEW_FILES), ['user-notes.txt', 'mine']].sort(([a], [b]) => (a < b ? -1 : 1))), 'the new tree, the person\'s own file untouched, the obsolete file gone');
  assert.deepEqual(world.folder.removed, ['extension/lib/old.js']);
  assert.deepEqual(world.calls.reloads, [5], 'reload ran once, after the last file was committed');
  assert.deepEqual(await world.state(), { v: 1, folder: true, autoApply: true, appliedVersion: '0.5.0', appliedPaths: NEW_PATHS, pending: null, lastError: null });
  // The site was asked for: latest.json, manifest, signature, then every file.
  const urls = updateTreeUrls('0.5.0');
  assert.equal(world.site.requests[0], 'https://kc-live-interpreter.vercel.app/latest.json');
  assert.deepEqual(world.site.requests.slice(1, 3), [urls.manifest, urls.signature]);
  assert.deepEqual(fileRequests(world.site).sort(), NEW_PATHS.map((path) => urls.file(path)).sort());
  assert.equal(world.folder.requests, 0, 'the permission was granted: no request');
});

test('run: with no list of the previous apply (the first updater version) nothing is deleted', async () => {
  const world = setup({ state: { v: 1, folder: true } });
  assert.equal((await world.updater.run()).ok, true);
  assert.deepEqual(world.folder.removed, []);
  assert.ok(world.folder.exists('extension/lib/old.js') && world.folder.exists('user-notes.txt'));
  assert.deepEqual((await world.state()).appliedPaths, NEW_PATHS);
});

test('run through the default downloader built from the page\'s fetch ends the same way', async () => {
  const world = setup({ overrides: { fetchBytes: undefined } });
  assert.deepEqual(await world.updater.run(), { ok: true, version: '0.5.0' });
  assert.deepEqual([...world.folder.commits].sort(), NEW_PATHS);
  assert.equal(world.folder.commits.at(-1), 'manifest.json');
  const tampered = setup({ overrides: { fetchBytes: undefined } });
  tampered.site.override(updateTreeUrls('0.5.0').file('extension/lib/a.js'), enc('export const a = 3;\n'));
  assert.deepEqual(await tampered.updater.run(), { ok: false, code: 'UPDATE_BAD_HASH' });
  assert.ok(tampered.folder.untouched);
});

test('the pending marker is stored before the first byte is written and cleared with the success record', async () => {
  const world = setup();
  const seen = [];
  const watched = { read: () => world.stateApi.read(), patch: async (partial) => { seen.push({ partial, mutations: world.folder.mutations.length }); return world.stateApi.patch(partial); } };
  const updater = createSelfUpdater({ ...world.options, stateApi: watched });
  assert.equal((await updater.run()).ok, true);
  assert.equal(seen.length, 2, 'two patches: the marker, then the record');
  assert.deepEqual(seen[0].partial, { pending: { version: '0.5.0', at: 5000 } });
  assert.equal(seen[0].mutations, 0, 'nothing had been written when the marker was stored');
  assert.deepEqual(Object.keys(seen[1].partial).sort(), ['appliedPaths', 'appliedVersion', 'lastError', 'pending']);
  assert.equal(seen[1].partial.pending, null);
  assert.equal(seen[1].mutations, world.folder.mutations.length, 'the record is stored after the last mutation');
});

test('an interrupted write leaves the marker and the old manifest.json; the next run finishes with exactly the bytes of a clean run', async () => {
  const world = setup({ state: { v: 1, folder: true, appliedVersion: '0.4.0', appliedPaths: PREVIOUS } });
  world.folder.failAfterCommits(2);
  const failed = await world.updater.run();
  assert.deepEqual(failed, { ok: false, code: 'UPDATE_WRITE_FAILED' });
  const afterFailure = await world.state();
  assert.deepEqual(afterFailure.pending, { version: '0.5.0', at: 5000 }, 'the marker says an apply was started');
  assert.equal(afterFailure.lastError, 'UPDATE_WRITE_FAILED');
  assert.equal(afterFailure.appliedVersion, '0.4.0', 'and nothing claims the new version');
  assert.equal(world.folder.text('manifest.json'), RUNNING_MANIFEST, 'the folder still says "not applied"');
  assert.equal(world.calls.reloads.length, 0, 'no reload after a failure');
  assert.ok(world.folder.exists('extension/lib/old.js'), 'nothing was deleted');
  assert.equal((await world.updater.status()).pending?.version, '0.5.0', 'the panel can see it');
  world.folder.clearFailures();
  const retried = await world.updater.run();
  assert.deepEqual(retried, { ok: true, version: '0.5.0' });
  const clean = setup({ state: { v: 1, folder: true, appliedVersion: '0.4.0', appliedPaths: PREVIOUS } });
  await clean.updater.run();
  assert.deepEqual(world.folder.snapshot(), clean.folder.snapshot(), 'idempotent: the same final bytes');
  const done = await world.state();
  assert.equal(done.pending, null);
  assert.equal(done.lastError, null);
  assert.equal(done.appliedVersion, '0.5.0');
  assert.deepEqual(world.calls.reloads, [2 + NEW_PATHS.length], 'one reload, after the retry wrote all files again (2 were committed by the failed run)');
});

test('a locked file (Windows) is UPDATE_WRITE_FAILED with the marker still set, the error recorded and nothing deleted', async () => {
  const world = setup({ state: { v: 1, folder: true, appliedPaths: PREVIOUS } });
  world.folder.lock('extension/lib/a.js');
  assert.deepEqual(await world.updater.run(), { ok: false, code: 'UPDATE_WRITE_FAILED' });
  const state = await world.state();
  assert.equal(state.pending?.version, '0.5.0');
  assert.equal(state.lastError, 'UPDATE_WRITE_FAILED');
  assert.equal(world.folder.text('manifest.json'), RUNNING_MANIFEST);
  assert.equal(world.folder.text('extension/lib/a.js'), 'export const a = 1;\n');
  assert.ok(world.folder.exists('extension/lib/old.js'));
  assert.equal(world.calls.reloads.length, 0);
  world.folder.unlock('extension/lib/a.js');
  assert.equal((await world.updater.run()).ok, true, 'and once the lock is gone the same call succeeds');
});

test('a "target" folder (everything written, the reload was missed) only records the state and reloads', async () => {
  const world = setup({ state: { v: 1, folder: true, appliedVersion: '0.4.0', appliedPaths: PREVIOUS, pending: { version: '0.5.0', at: 1 } } });
  for (const [path, content] of Object.entries(NEW_FILES)) world.folder.seed(path, content);
  world.folder.seed('user-notes.txt', 'mine');
  const before = world.folder.snapshot();
  const steps = [];
  const patches = [];
  const spy = { read: () => world.stateApi.read(), patch: async (partial) => { patches.push(partial); return world.stateApi.patch(partial); } };
  const updater = createSelfUpdater({ ...world.options, stateApi: spy });
  assert.deepEqual(await updater.run({ onStep: (name) => steps.push(name) }), { ok: true, version: '0.5.0' });
  assert.ok(world.folder.untouched, 'not one byte was written');
  assert.deepEqual(world.folder.snapshot(), before);
  assert.deepEqual(steps, ['checking', 'downloading', 'verifying', 'reloading'], 'no writing step');
  assert.equal(world.calls.reloads.length, 1);
  assert.equal(patches.some((partial) => partial.pending !== undefined && partial.pending !== null), false, 'no new marker');
  const state = await world.state();
  assert.equal(state.appliedVersion, '0.5.0');
  assert.deepEqual(state.appliedPaths, NEW_PATHS);
  assert.equal(state.pending, null);
});

test('a folder that is not THE loaded folder (its manifest.json is neither the running nor the new one) is refused untouched', async () => {
  const world = setup({ folderOptions: { files: { ...OLD_FILES, 'manifest.json': '{"manifest_version":3,"version":"0.3.0"}\n' } } });
  assert.deepEqual(await world.updater.run(), { ok: false, code: 'UPDATE_WRONG_FOLDER' });
  assert.ok(world.folder.untouched);
  assert.equal(world.calls.reloads.length, 0);
  const state = await world.state();
  assert.equal(state.lastError, 'UPDATE_WRONG_FOLDER');
  assert.equal(state.pending, null, 'no marker for an apply that never started');
  const none = setup({ folderOptions: { files: { 'other.txt': 'x' } } });
  assert.deepEqual(await none.updater.run(), { ok: false, code: 'UPDATE_WRONG_FOLDER' }, 'a folder without a manifest.json');
  const throwing = setup({ overrides: { running: { version: '0.4.0', manifestBytes: async () => { throw new Error('cannot read myself'); } } } });
  assert.deepEqual(await throwing.updater.run(), { ok: false, code: 'UPDATE_WRONG_FOLDER' }, 'nothing proves this is the loaded folder');
  assert.ok(throwing.folder.untouched);
});

// ---------------------------------------------------------------------------------------------------------------------
// permission

test('permission granted: the folder is used without any request', async () => {
  for (const allowPrompt of [false, true]) {
    const world = setup();
    assert.equal((await world.updater.run({ allowPrompt })).ok, true, `allowPrompt ${allowPrompt}`);
    assert.equal(world.folder.requests, 0);
  }
});

test('permission asks (prompt): without allowPrompt it is UPDATE_NEEDS_PERMISSION before any network or write, and never a request', async () => {
  const world = setup({ folderOptions: { permission: 'prompt' } });
  const steps = [];
  for (const allowPrompt of [undefined, false, 0, 1, 'yes', null]) {
    const result = await world.updater.run({ allowPrompt, onStep: (name) => steps.push(name) });
    assert.deepEqual(result, { ok: false, code: 'UPDATE_NEEDS_PERMISSION' }, String(allowPrompt));
  }
  assert.deepEqual(await world.updater.run({}), { ok: false, code: 'UPDATE_NEEDS_PERMISSION' });
  assert.deepEqual(await world.updater.run(), { ok: false, code: 'UPDATE_NEEDS_PERMISSION' });
  assert.equal(world.folder.requests, 0, 'only a caller that says a click is behind it may ask');
  assert.ok(world.folder.untouched);
  assert.deepEqual(world.site.requests, [], 'the permission is settled first: no download for nothing');
  assert.equal(world.calls.reloads.length, 0);
  assert.equal((await world.state()).lastError, null, 'this is a state of the folder, not a failed update');
  assert.deepEqual(steps, Array(6).fill('checking'));
});

test('permission asks (prompt): with allowPrompt it requests, first of all, and goes on when it is granted', async () => {
  const world = setup({ folderOptions: { permission: 'prompt', requestOutcome: 'granted' } });
  const events = [];
  const request = world.folder.handle.requestPermission;
  world.folder.handle.requestPermission = async (...args) => { events.push('request'); return request(...args); };
  const fetchBytes = world.site.fetchBytes;
  const fetchPage = world.site.fetch;
  const updater = createSelfUpdater({ ...world.options, fetch: async (url, init) => { events.push('network'); return fetchPage(url, init); }, fetchBytes: (url, options) => { events.push('network'); return fetchBytes(url, options); } });
  assert.deepEqual(await updater.run({ allowPrompt: true }), { ok: true, version: '0.5.0' });
  assert.equal(world.folder.requests, 1);
  assert.equal(events[0], 'request', 'the request comes before the first network call, while the click is still fresh');
  assert.equal(events.filter((name) => name === 'request').length, 1);
  assert.equal(world.folder.permission, 'granted');
  assert.deepEqual([...world.folder.commits].sort(), NEW_PATHS);
});

test('permission refused: a denied answer is UPDATE_PERMISSION_DENIED; an answer that stays "prompt" or a request that throws is UPDATE_NEEDS_PERMISSION', async () => {
  const denied = setup({ folderOptions: { permission: 'prompt', requestOutcome: 'denied' } });
  assert.deepEqual(await denied.updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_PERMISSION_DENIED' });
  assert.equal(denied.folder.requests, 1);
  assert.ok(denied.folder.untouched && denied.site.requests.length === 0);
  assert.equal((await denied.state()).lastError, 'UPDATE_PERMISSION_DENIED', 'a refusal is recorded');
  const stays = setup({ folderOptions: { permission: 'prompt', requestOutcome: 'prompt' } });
  assert.deepEqual(await stays.updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_NEEDS_PERMISSION' });
  const aborted = setup({ folderOptions: { permission: 'prompt', requestOutcome: new DOMException('aborted', 'AbortError') } });
  assert.deepEqual(await aborted.updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_NEEDS_PERMISSION' }, 'no permission manager in the side panel');
  assert.ok(aborted.folder.untouched);
  const blocked = setup({ folderOptions: { permission: 'denied' } });
  assert.deepEqual(await blocked.updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_PERMISSION_DENIED' });
  assert.equal(blocked.folder.requests, 0, 'a folder Chrome already denied is not asked again');
  const broken = setup({ overrides: { store: { async load() { return { kind: 'directory', getFileHandle() {}, getDirectoryHandle() {}, queryPermission: async () => { throw new Error('gone'); } }; } } } });
  assert.deepEqual(await broken.updater.run(), { ok: false, code: 'UPDATE_NO_FOLDER' }, 'a handle that can not even be queried');
});

test('a permission lost while the files were downloading stops the apply before any write and never asks', async () => {
  const world = setup();
  const lose = async (url, options) => { const bytes = await world.site.fetchBytes(url, options); if (url.includes('/files/')) world.folder.permission = 'prompt'; return bytes; };
  const updater = createSelfUpdater({ ...world.options, fetchBytes: lose });
  assert.deepEqual(await updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_NEEDS_PERMISSION' });
  assert.equal(world.folder.requests, 0);
  assert.ok(world.folder.untouched);
  assert.equal((await world.state()).pending, null, 'the marker is only set when the write is going to start');
});

test('no folder chosen: UPDATE_NO_FOLDER before any network, and not recorded as an error', async () => {
  const world = setup({ handle: null });
  assert.deepEqual(await world.updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_NO_FOLDER' });
  assert.deepEqual(world.site.requests, []);
  assert.equal((await world.state()).lastError, null);
  const throwing = setup({ overrides: { store: { async load() { throw new Error('indexedDB exploded'); } } } });
  assert.deepEqual(await throwing.updater.run(), { ok: false, code: 'UPDATE_NO_FOLDER' }, 'a store that throws is "no folder"');
});

// ---------------------------------------------------------------------------------------------------------------------
// what the site publishes

test('latest.json says nothing newer: UPDATE_NOT_NEWER, not recorded; unreadable: UPDATE_FETCH_FAILED', async () => {
  for (const [latest, running] of [['0.4.0', '0.4.0'], ['0.3.0', '0.4.0'], ['0.5.0', '0.5.0']]) {
    const world = setup({ latest, running });
    assert.deepEqual(await world.updater.run(), { ok: false, code: 'UPDATE_NOT_NEWER' }, `${latest} vs ${running}`);
    assert.equal((await world.state()).lastError, null);
    assert.deepEqual(fileRequests(world.site), []);
    assert.ok(world.folder.untouched);
  }
  const offline = setup({ overrides: { fetch: async () => { throw new TypeError('offline'); } } });
  assert.deepEqual(await offline.updater.run(), { ok: false, code: 'UPDATE_FETCH_FAILED' });
  assert.equal((await offline.state()).lastError, 'UPDATE_FETCH_FAILED');
  const missing = setup();
  missing.site.override('https://kc-live-interpreter.vercel.app/latest.json', null);
  assert.deepEqual(await missing.updater.run(), { ok: false, code: 'UPDATE_FETCH_FAILED' });
  const noFetch = setup({ overrides: { fetch: undefined, fetchBytes: undefined } });
  assert.deepEqual(await noFetch.updater.run(), { ok: false, code: 'UPDATE_FETCH_FAILED' });
});

test('the signed manifest is fetched and judged before any file is requested: bad signature, bad structure, bad path, wrong version', async () => {
  const urls = updateTreeUrls('0.5.0');
  const goodFiles = buildSignedTree({ version: '0.5.0', files: NEW_FILES }).manifest.files;
  const cases = [
    ['a signature by another key', (world) => publish(world.site, '0.5.0', world.tree.manifest, stranger.privatePem), 'UPDATE_BAD_SIGNATURE'],
    ['a signature that is not one', (world) => world.site.override(urls.signature, enc('AAAA\n')), 'UPDATE_BAD_SIGNATURE'],
    ['a signature file that is empty', (world) => world.site.override(urls.signature, new Uint8Array(0)), 'UPDATE_BAD_SIGNATURE'],
    ['a manifest changed after signing', (world) => world.site.override(urls.manifest, enc(dec(world.tree.manifestBytes).replace('2026-10-08', '2026-10-09'))), 'UPDATE_BAD_SIGNATURE'],
    ['a signed manifest of a path outside the folder', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, files: [...goodFiles, { path: '../escape.js', size: 1, sha256: 'a'.repeat(64) }] }), 'UPDATE_UNSAFE_PATH'],
    ['a signed manifest listing a path twice', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, files: [...goodFiles, goodFiles[0]] }), 'UPDATE_UNSAFE_PATH'],
    ['a signed manifest with an extra field', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, note: 'x' }), 'UPDATE_BAD_MANIFEST'],
    ['a signed manifest of a file that is too big', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, files: [...goodFiles, { path: 'big.bin', size: 3000000, sha256: 'a'.repeat(64) }] }), 'UPDATE_TOO_LARGE'],
    ['a signed manifest of another version (a newer one)', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, version: '0.5.1' }), 'UPDATE_BAD_MANIFEST'],
    ['a signed manifest of an older version (a replay)', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, version: '0.3.0' }), 'UPDATE_BAD_MANIFEST'],
    ['a signed manifest of the running version', (world) => publish(world.site, '0.5.0', { ...world.tree.manifest, version: '0.4.0' }), 'UPDATE_BAD_MANIFEST'],
    ['no manifest on the site', (world) => world.site.override(urls.manifest, null), 'UPDATE_FETCH_FAILED'],
    ['no signature on the site', (world) => world.site.override(urls.signature, null), 'UPDATE_FETCH_FAILED'],
    ['a manifest larger than allowed', (world) => world.site.override(urls.manifest, new Uint8Array(300000)), 'UPDATE_TOO_LARGE'],
    ['a signature file larger than allowed', (world) => world.site.override(urls.signature, new Uint8Array(5000)), 'UPDATE_TOO_LARGE'],
  ];
  for (const [name, change, code] of cases) {
    const world = setup({ state: { v: 1, folder: true, appliedPaths: PREVIOUS } });
    change(world);
    const steps = [];
    assert.deepEqual(await world.updater.run({ onStep: (step) => steps.push(step) }), { ok: false, code }, name);
    assert.deepEqual(fileRequests(world.site), [], `${name}: no file was requested`);
    assert.ok(world.folder.untouched, `${name}: the folder is untouched`);
    assert.equal(world.calls.reloads.length, 0, name);
    assert.equal((await world.state()).lastError, code, `${name}: recorded`);
    assert.equal((await world.state()).pending, null, name);
    assert.ok(!steps.includes('writing'), name);
  }
});

test('the manifest and the signature are fetched with their own body limits, and every file with its signed size', async () => {
  const world = setup();
  const asked = [];
  const updater = createSelfUpdater({ ...world.options, fetchBytes: (url, options) => { asked.push([url, options?.maxBytes]); return world.site.fetchBytes(url, options); } });
  assert.equal((await updater.run()).ok, true);
  const urls = updateTreeUrls('0.5.0');
  assert.deepEqual(asked.find(([url]) => url === urls.manifest), [urls.manifest, 262144]);
  assert.deepEqual(asked.find(([url]) => url === urls.signature), [urls.signature, 1024]);
  for (const file of world.tree.manifest.files) assert.deepEqual(asked.find(([url]) => url === urls.file(file.path)), [urls.file(file.path), file.size]);
});

test('a file that differs from the signed list is refused untouched: bytes, size, a missing file, a manifest.json of another version', async () => {
  const urls = updateTreeUrls('0.5.0');
  const cases = [
    ['other bytes of the same size', (site) => site.override(urls.file('extension/lib/a.js'), enc('export const a = 3;\n')), 'UPDATE_BAD_HASH'],
    ['a shorter file', (site) => site.override(urls.file('extension/lib/a.js'), enc('export const a')), 'UPDATE_BAD_HASH'],
    ['a longer file', (site) => site.override(urls.file('extension/lib/a.js'), enc('export const a = 2;\n// more\n')), 'UPDATE_TOO_LARGE'],
    ['an empty file', (site) => site.override(urls.file('icons/icon-16.png'), new Uint8Array(0)), 'UPDATE_BAD_HASH'],
    ['a missing file', (site) => site.override(urls.file('_locales/en/messages.json'), null), 'UPDATE_FETCH_FAILED'],
    ['a manifest.json that is not the signed one', (site) => site.override(urls.file('manifest.json'), enc('{"manifest_version":3,"version":"0.9.9"}\n')), 'UPDATE_BAD_HASH'],
  ];
  for (const [name, change, code] of cases) {
    const world = setup({ state: { v: 1, folder: true, appliedPaths: PREVIOUS } });
    change(world.site);
    assert.deepEqual(await world.updater.run(), { ok: false, code }, name);
    assert.ok(world.folder.untouched, `${name}: not one byte was written`);
    assert.equal(world.calls.reloads.length, 0, name);
    assert.equal((await world.state()).pending, null, `${name}: no marker`);
  }
  // A signed tree whose own manifest.json carries another version than the signed one.
  const wrong = buildSignedTree({ version: '0.5.0', privatePem: primary.privatePem, files: { ...NEW_FILES, 'manifest.json': '{"manifest_version":3,"version":"0.4.9"}\n' } });
  const world = setup({ tree: wrong });
  assert.deepEqual(await world.updater.run(), { ok: false, code: 'UPDATE_BAD_MANIFEST' });
  assert.ok(world.folder.untouched);
});

test('a downloader or a state storage that fails in an unexpected way is still one UPDATE_ code', async () => {
  const boom = setup({ overrides: { fetchBytes: async () => { throw new TypeError('socket hang up'); } } });
  assert.deepEqual(await boom.updater.run(), { ok: false, code: 'UPDATE_FETCH_FAILED' });
  const foreign = setup({ overrides: { stateApi: { read: async () => { throw Object.assign(new Error('disk'), { code: 'EACCES' }); }, patch: async () => {} } } });
  const foreignResult = await foreign.updater.run();
  assert.equal(foreignResult.ok, false);
  assert.ok(UPDATE_ERROR_CODES.includes(foreignResult.code), `${foreignResult.code}: a code of the platform never leaves the updater`);
  const nonBytes = setup({ overrides: { fetchBytes: async () => 'not bytes' } });
  assert.deepEqual(await nonBytes.updater.run(), { ok: false, code: 'UPDATE_FETCH_FAILED' });
  const noRecord = setup({ overrides: { stateApi: { read: async () => createUpdateStateApi({ local: createLocal() }).read(), patch: async () => { throw new Error('quota'); } } } });
  assert.deepEqual(await noRecord.updater.run(), { ok: false, code: 'UPDATE_WRITE_FAILED' }, 'without a marker nothing is written');
  assert.ok(noRecord.folder.untouched);
  for (const code of [(await boom.updater.run()).code, (await noRecord.updater.run()).code]) assert.ok(UPDATE_ERROR_CODES.includes(code));
});

test('a state storage that fails after the files are in place does not turn a success into a failure; a failing reload neither', async () => {
  const world = setup();
  const finalFails = { read: () => world.stateApi.read(), patch: async (partial) => { if (partial.appliedVersion !== undefined) throw new Error('quota'); return world.stateApi.patch(partial); } };
  const updater = createSelfUpdater({ ...world.options, stateApi: finalFails });
  assert.deepEqual(await updater.run(), { ok: true, version: '0.5.0' });
  assert.equal(world.folder.commits.at(-1), 'manifest.json');
  assert.equal(world.calls.reloads.length, 1);
  assert.equal((await world.state()).pending?.version, '0.5.0', 'the marker is still there, and the version judges it stale once the new code runs');
  const noReload = setup({ overrides: { reload: () => { throw new Error('no runtime'); } } });
  assert.deepEqual(await noReload.updater.run(), { ok: true, version: '0.5.0' });
  assert.equal(noReload.folder.commits.at(-1), 'manifest.json');
  const asyncReload = setup({ overrides: { reload: async () => { throw new Error('rejected'); } } });
  assert.deepEqual(await asyncReload.updater.run(), { ok: true, version: '0.5.0' });
  const none = setup({ overrides: { reload: undefined } });
  assert.deepEqual(await none.updater.run(), { ok: true, version: '0.5.0' });
});

test('a throwing onStep callback never stops an update', async () => {
  const world = setup();
  assert.deepEqual(await world.updater.run({ onStep: () => { throw new Error('ui bug'); } }), { ok: true, version: '0.5.0' });
  assert.equal(world.folder.commits.at(-1), 'manifest.json');
});

test('the steps stop where the failure is', async () => {
  const bad = setup();
  bad.site.override(updateTreeUrls('0.5.0').signature, enc('AAAA\n'));
  const steps = [];
  await bad.updater.run({ onStep: (name) => steps.push(name) });
  assert.deepEqual(steps, ['checking', 'downloading', 'verifying']);
  const write = setup();
  write.folder.lock('extension/lib/a.js');
  const writeSteps = [];
  await write.updater.run({ onStep: (name) => writeSteps.push(name) });
  assert.deepEqual(writeSteps, ['checking', 'downloading', 'verifying', 'writing']);
});

// ---------------------------------------------------------------------------------------------------------------------
// lastError

test('lastError records a failed attempt; BUSY, DISABLED, NOT_NEWER, NO_FOLDER and NEEDS_PERMISSION are not failed attempts; a success clears it', async () => {
  const world = setup({ state: { v: 1, folder: true, lastError: 'UPDATE_BAD_HASH' } });
  world.folder.permission = 'prompt';
  await world.updater.run();
  assert.equal((await world.state()).lastError, 'UPDATE_BAD_HASH', 'NEEDS_PERMISSION leaves the earlier record');
  world.folder.permission = 'granted';
  world.site.override(updateTreeUrls('0.5.0').signature, enc('AAAA\n'));
  await world.updater.run();
  assert.equal((await world.state()).lastError, 'UPDATE_BAD_SIGNATURE');
  world.site.clearOverrides();
  assert.equal((await world.updater.run()).ok, true);
  assert.equal((await world.state()).lastError, null);
  assert.equal((await world.updater.status()).lastError, null);
});

// ---------------------------------------------------------------------------------------------------------------------
// the busy lock

test('a second run, or choosing a folder, while a run is in flight is UPDATE_BUSY and changes nothing; the lock is released afterwards', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const world = setup();
  const updater = createSelfUpdater({ ...world.options, fetch: async (url, init) => { await gate; return world.site.fetch(url, init); } });
  const first = updater.run();
  assert.deepEqual(await updater.run(), { ok: false, code: 'UPDATE_BUSY' });
  assert.deepEqual(await updater.run({ allowPrompt: true }), { ok: false, code: 'UPDATE_BUSY' });
  assert.deepEqual(await updater.chooseFolder(), { ok: false, code: 'UPDATE_BUSY' });
  assert.equal(world.calls.picks, 0, 'the picker is not opened behind a running update');
  assert.equal((await world.state()).lastError, null, 'BUSY is not an error of the run that is going on');
  release();
  assert.deepEqual(await first, { ok: true, version: '0.5.0' });
  assert.deepEqual(await updater.run(), { ok: true, version: '0.5.0' }, 'the lock is released (this run finds the folder already updated: only the reload is left)');
  assert.equal(world.calls.reloads.length, 2);
  // A failed run releases the lock too.
  const failing = setup();
  failing.folder.lock('extension/lib/a.js');
  assert.equal((await failing.updater.run()).code, 'UPDATE_WRITE_FAILED');
  assert.equal((await failing.updater.run()).code, 'UPDATE_WRITE_FAILED', 'not BUSY');
  failing.folder.unlock('extension/lib/a.js');
  assert.equal((await failing.updater.run()).ok, true);
  // The lock covers a pick that throws.
  const picking = setup({ overrides: { pickDirectory: async () => { throw new DOMException('closed', 'AbortError'); } } });
  assert.equal((await picking.updater.chooseFolder()).code, 'UPDATE_PICK_CANCELLED');
  assert.equal((await picking.updater.run()).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// choosing the folder

test('chooseFolder: the right folder is saved and the state says so; the picker is opened in the same tick as the click', async () => {
  const world = setup({ handle: null, state: { v: 1, folder: false, lastError: 'UPDATE_NO_FOLDER' } });
  const pending = world.updater.chooseFolder();
  assert.equal(world.calls.picks, 1, 'pickDirectory ran synchronously: it needs the click\'s user activation');
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(world.store.saves, [world.folder.handle]);
  assert.equal((await world.state()).folder, true);
  assert.equal((await world.state()).lastError, null, 'a stale "no folder" is cleared');
  assert.equal((await world.updater.status()).folder, 'granted');
  assert.ok(world.folder.untouched, 'choosing writes nothing');
  assert.equal((await world.updater.run()).ok, true, 'and the saved folder is the one that gets updated');
});

test('chooseFolder: cancelled, refused by the picker, wrong folder, not a folder, or not saved', async () => {
  const cancelled = setup({ handle: null, overrides: { pickDirectory: async () => { throw new DOMException('The user aborted a request.', 'AbortError'); } } });
  assert.deepEqual(await cancelled.updater.chooseFolder(), { ok: false, code: 'UPDATE_PICK_CANCELLED' });
  assert.deepEqual(cancelled.store.saves, []);
  assert.equal((await cancelled.state()).folder, false);
  assert.equal((await cancelled.state()).lastError, null, 'cancelling is not an error');
  for (const error of [new DOMException('system folder', 'SecurityError'), new DOMException('no gesture', 'NotAllowedError'), new TypeError('no picker')]) {
    const refused = setup({ handle: null, overrides: { pickDirectory: async () => { throw error; } } });
    assert.deepEqual(await refused.updater.chooseFolder(), { ok: false, code: 'UPDATE_NO_FOLDER' }, error.name);
    assert.deepEqual(refused.store.saves, []);
  }
  const other = createFakeFolder({ files: { ...OLD_FILES, 'manifest.json': '{"manifest_version":3,"version":"0.4.0","name":"another copy"}\n' } });
  const wrong = setup({ handle: null, overrides: { pickDirectory: async () => other.handle } });
  assert.deepEqual(await wrong.updater.chooseFolder(), { ok: false, code: 'UPDATE_WRONG_FOLDER' });
  assert.deepEqual(wrong.store.saves, [], 'a wrong folder is never saved');
  assert.equal((await wrong.state()).folder, false);
  assert.ok(other.untouched);
  const empty = createFakeFolder();
  assert.deepEqual(await setup({ handle: null, overrides: { pickDirectory: async () => empty.handle } }).updater.chooseFolder(), { ok: false, code: 'UPDATE_WRONG_FOLDER' }, 'an empty folder');
  for (const value of [undefined, null, 'folder', {}, { kind: 'file' }]) {
    const odd = setup({ handle: null, overrides: { pickDirectory: async () => value } });
    assert.deepEqual(await odd.updater.chooseFolder(), { ok: false, code: 'UPDATE_NO_FOLDER' }, String(value));
  }
  const notSaved = setup({ handle: null });
  notSaved.store.saveResult = false;
  assert.deepEqual(await notSaved.updater.chooseFolder(), { ok: false, code: 'UPDATE_NO_FOLDER' });
  assert.equal((await notSaved.state()).folder, false, 'the state does not claim a folder that was not kept');
  const stateFails = setup({ handle: null, overrides: { stateApi: { read: async () => createUpdateStateApi({ local: createLocal() }).read(), patch: async () => { throw new Error('quota'); } } } });
  assert.deepEqual(await stateFails.updater.chooseFolder(), { ok: true }, 'the handle is kept; status() reads it from there');
});

// ---------------------------------------------------------------------------------------------------------------------
// status, check, forget, auto apply

test('status reports none, granted, needs-click and gone', async () => {
  const none = setup({ handle: null });
  assert.deepEqual(await none.updater.status(), { enabled: true, folder: 'none', autoApply: true, appliedVersion: null, pending: null, lastError: null });
  assert.ok(Object.isFrozen(await none.updater.status()));
  assert.equal((await setup().updater.status()).folder, 'granted');
  assert.equal((await setup({ folderOptions: { permission: 'prompt' } }).updater.status()).folder, 'needs-click', 'a click can renew it');
  assert.equal((await setup({ folderOptions: { permission: 'denied' } }).updater.status()).folder, 'gone');
  assert.equal((await setup({ handle: null, state: { v: 1, folder: true } }).updater.status()).folder, 'gone', 'a folder was set, the handle is missing');
  const unqueryable = setup({ handle: { kind: 'directory', getFileHandle() {}, getDirectoryHandle() {}, queryPermission: async () => { throw new Error('x'); } }, state: { v: 1, folder: true } });
  assert.equal((await unqueryable.updater.status()).folder, 'gone');
  const throwing = setup({ overrides: { store: { async load() { throw new Error('idb'); } } } });
  assert.equal((await throwing.updater.status()).folder, 'none');
  const full = setup({ state: { v: 1, folder: true, autoApply: false, appliedVersion: '0.4.0', lastError: 'UPDATE_BAD_HASH', pending: { version: '0.5.0', at: 9 } } });
  assert.deepEqual(await full.updater.status(), { enabled: true, folder: 'granted', autoApply: false, appliedVersion: '0.4.0', pending: { version: '0.5.0', at: 9 }, lastError: 'UPDATE_BAD_HASH' });
  assert.equal(full.site.requests.length, 0, 'status never touches the network');
  assert.ok(full.folder.untouched);
  assert.equal(full.folder.requests, 0, 'and never requests a permission');
});

test('a marker whose version is already the running one is stale: status hides it and the next run removes it', async () => {
  const state = { v: 1, folder: true, pending: { version: '0.5.0', at: 9 } };
  const running = setup({ running: '0.5.0', state });
  assert.equal((await running.updater.status()).pending, null);
  assert.equal((await running.state()).pending?.version, '0.5.0', 'status only reads');
  assert.deepEqual(await running.updater.run(), { ok: false, code: 'UPDATE_NOT_NEWER' });
  assert.equal((await running.state()).pending, null, 'run cleans it up');
  const newer = setup({ running: '0.6.0', state, latest: '0.6.0' });
  assert.equal((await newer.updater.status()).pending, null);
  const behind = setup({ running: '0.4.0', state });
  assert.deepEqual((await behind.updater.status()).pending, { version: '0.5.0', at: 9 }, 'an apply that did not finish is shown');
});

test('check is the update check of the page: newer, same, unreadable', async () => {
  const world = setup();
  assert.deepEqual(await world.updater.check(), { available: true, version: '0.5.0' });
  world.site.latest = '0.4.0';
  assert.deepEqual(await world.updater.check(), { available: false, version: '0.4.0' });
  world.site.override('https://kc-live-interpreter.vercel.app/latest.json', null);
  assert.deepEqual(await world.updater.check(), { available: false, version: null });
  assert.deepEqual(await setup({ overrides: { fetch: undefined } }).updater.check(), { available: false, version: null });
  assert.deepEqual(await setup({ overrides: { running: undefined } }).updater.check(), { available: false, version: null });
});

test('forgetFolder drops the handle, the folder flag, the marker and the error, and keeps what was applied; setAutoApply persists', async () => {
  const world = setup({ state: { v: 1, folder: true, autoApply: true, appliedVersion: '0.4.0', appliedPaths: PREVIOUS, pending: { version: '0.5.0', at: 1 }, lastError: 'UPDATE_WRITE_FAILED' } });
  await world.updater.forgetFolder();
  assert.equal(world.store.clears, 1);
  assert.deepEqual(await world.state(), { v: 1, folder: false, autoApply: true, appliedVersion: '0.4.0', appliedPaths: PREVIOUS, pending: null, lastError: null });
  assert.equal((await world.updater.status()).folder, 'none');
  assert.ok(world.folder.untouched, 'forgetting never touches the folder');
  await world.updater.setAutoApply(false);
  assert.equal((await world.updater.status()).autoApply, false);
  await world.updater.setAutoApply(true);
  assert.equal((await world.updater.status()).autoApply, true);
  await world.updater.setAutoApply('yes');
  assert.equal((await world.updater.status()).autoApply, false, 'only the boolean true turns it on');
  const failing = setup({ overrides: { stateApi: { read: async () => createUpdateStateApi({ local: createLocal() }).read(), patch: async () => { throw new Error('quota'); } }, store: { async clear() { throw new Error('idb'); } } } });
  await failing.updater.forgetFolder();
  await failing.updater.setAutoApply(false);
});

test('the silent path: a granted folder and an update run to the end with no prompt and no click', async () => {
  const world = setup({ state: { v: 1, folder: true, autoApply: true } });
  const status = await world.updater.status();
  assert.equal(status.folder, 'granted');
  assert.equal(status.autoApply, true);
  assert.equal((await world.updater.check()).available, true);
  assert.deepEqual(await world.updater.run({ allowPrompt: false }), { ok: true, version: '0.5.0' });
  assert.equal(world.folder.requests, 0);
  assert.equal(world.calls.picks, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// the default downloader

const bodyOf = (bytes, { split = 4, onCancel } = {}) => new ReadableStream({
  start(controller) { for (let index = 0; index < bytes.length; index += split) controller.enqueue(bytes.subarray(index, index + split)); controller.close(); },
  cancel() { onCancel?.(); },
});
const infinite = (onCancel) => new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { onCancel?.(); } });

test('createFetchBytes sends a bare GET and returns the bytes', async () => {
  const calls = [];
  const fetchBytes = createFetchBytes(async (url, init) => { calls.push([url, init]); return new Response(enc('hello world')); });
  const bytes = await fetchBytes('https://example.test/x', { maxBytes: 100 });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(dec(bytes), 'hello world');
  assert.deepEqual(calls, [['https://example.test/x', { cache: 'no-store', credentials: 'omit', redirect: 'error' }]]);
  assert.equal(dec(await fetchBytes('https://example.test/x')), 'hello world', 'the default limit is 2 MiB');
  const chunked = createFetchBytes(async () => new Response(bodyOf(enc('hello world, read in chunks of four'))));
  assert.equal(dec(await chunked('https://example.test/x', { maxBytes: 100 })), 'hello world, read in chunks of four', 'chunks are joined in order');
  assert.equal((await createFetchBytes(async () => new Response(new Uint8Array(0)))('u', { maxBytes: 0 })).length, 0);
});

test('createFetchBytes: anything but an OK answer, and any failure of fetch, is UPDATE_FETCH_FAILED', async () => {
  const code = (fetcher, ...args) => createFetchBytes(fetcher)('https://example.test/x', ...args).then(() => null, (error) => error.code);
  assert.equal(await code(async () => new Response('no', { status: 404 })), 'UPDATE_FETCH_FAILED');
  assert.equal(await code(async () => new Response('no', { status: 500 })), 'UPDATE_FETCH_FAILED');
  assert.equal(await code(async () => { throw new TypeError('offline'); }), 'UPDATE_FETCH_FAILED');
  assert.equal(await code(async () => { throw new DOMException('redirect', 'TypeError'); }), 'UPDATE_FETCH_FAILED');
  assert.equal(await code(async () => undefined), 'UPDATE_FETCH_FAILED');
  assert.equal(await code(async () => null), 'UPDATE_FETCH_FAILED');
  assert.equal(await code(undefined), 'UPDATE_FETCH_FAILED');
  assert.equal(await code('fetch'), 'UPDATE_FETCH_FAILED');
  const midway = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.error(new Error('connection reset')); } });
  assert.equal(await code(async () => new Response(midway)), 'UPDATE_FETCH_FAILED', 'a body that breaks half-way');
});

test('createFetchBytes refuses a body over the limit: by Content-Length without reading, and by the bytes actually read', async () => {
  const code = (fetcher, maxBytes) => createFetchBytes(fetcher)('https://example.test/x', { maxBytes }).then(() => null, (error) => error.code);
  let cancelled = false;
  let read = false;
  const declared = { ok: true, headers: new Headers({ 'content-length': '100' }), body: { cancel: async () => { cancelled = true; }, getReader() { read = true; throw new Error('must not be read'); } } };
  assert.equal(await code(async () => declared, 10), 'UPDATE_TOO_LARGE');
  assert.equal(read, false, 'the declared size was enough');
  assert.equal(cancelled, true, 'and the body was dropped');
  let streamCancelled = false;
  assert.equal(await code(async () => new Response(infinite(() => { streamCancelled = true; })), 10), 'UPDATE_TOO_LARGE', 'no Content-Length: stops at the limit');
  assert.equal(streamCancelled, true, 'the endless body was cancelled');
  assert.equal(await code(async () => new Response(new Uint8Array(11)), 10), 'UPDATE_TOO_LARGE', 'one byte over');
  assert.equal(await code(async () => new Response(new Uint8Array(10)), 10), null, 'exactly the limit');
  assert.equal(await code(async () => new Response(bodyOf(new Uint8Array(10))), 10), null, 'exactly the limit, in chunks');
  assert.equal(await code(async () => new Response(bodyOf(new Uint8Array(11))), 10), 'UPDATE_TOO_LARGE', 'one over, in chunks');
  // A lying Content-Length: the real count decides.
  assert.equal(await code(async () => new Response(new Uint8Array(50), { headers: { 'content-length': '5' } }), 10), 'UPDATE_TOO_LARGE');
  // A compressed answer: Content-Length counts the compressed bytes, which says nothing about the real size.
  assert.equal(await code(async () => new Response(new Uint8Array(5), { headers: { 'content-length': '100', 'content-encoding': 'gzip' } }), 10), null);
  assert.equal(await code(async () => new Response(new Uint8Array(50), { headers: { 'content-length': '20', 'content-encoding': 'br' } }), 10), 'UPDATE_TOO_LARGE', 'but the real bytes are still counted');
  assert.equal(await code(async () => new Response(new Uint8Array(5), { headers: { 'content-length': '100', 'content-encoding': 'identity' } }), 10), 'UPDATE_TOO_LARGE', 'identity is not compression');
  // No stream at all.
  const whole = (bytes) => async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => bytes.buffer });
  assert.equal(await code(whole(new Uint8Array(10)), 10), null);
  assert.equal(await code(whole(new Uint8Array(11)), 10), 'UPDATE_TOO_LARGE');
  assert.equal(dec(await createFetchBytes(whole(enc('abc')))('u')), 'abc');
  assert.equal(await createFetchBytes(async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => new Uint8Array(2097153).buffer }))('u').then(() => null, (error) => error.code), 'UPDATE_TOO_LARGE', 'the default limit is 2 MiB');
  assert.equal(await code(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(3).buffer }), 10), null, 'an answer with no headers object');
});
