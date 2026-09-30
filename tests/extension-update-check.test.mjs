// docs/extension.md §16 (owner, 2026-09-30): the update check of the side panel, as pure functions over an injected fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  UPDATE_MANIFEST_URL, UPDATE_SITE_URL, checkForUpdate, compareVersions, parseVersion,
} from '../extension/lib/update-check.js';

test('parseVersion accepts Chrome manifest versions only', () => {
  assert.deepEqual(parseVersion('0.2.0'), [0, 2, 0]);
  assert.deepEqual(parseVersion('1'), [1]);
  assert.deepEqual(parseVersion('1.2.3.4'), [1, 2, 3, 4]);
  for (const bad of ['', '1.2.3.4.5', 'v1.2', '1..2', '1.2-beta', ' 1.2', '123456', null, undefined, 1.2, {}]) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

test('compareVersions orders numerically and treats missing parts as zero', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1, 'numeric, not string order');
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
  assert.equal(compareVersions('1.0', '0.99.99'), 1);
  assert.equal(compareVersions('x', '0.1'), null);
});

test('checkForUpdate: newer is available, anything else is not, and it never throws', async () => {
  const answer = (body, ok = true) => async () => ({ ok, json: async () => body });
  assert.deepEqual(await checkForUpdate({ fetch: answer({ version: '0.3.0' }), currentVersion: '0.2.0' }), { available: true, version: '0.3.0' });
  assert.deepEqual(await checkForUpdate({ fetch: answer({ version: '0.2.0' }), currentVersion: '0.2.0' }), { available: false, version: '0.2.0' });
  assert.deepEqual(await checkForUpdate({ fetch: answer({ version: '0.1.0' }), currentVersion: '0.2.0' }), { available: false, version: '0.1.0' });
  const none = { available: false, version: null };
  assert.deepEqual(await checkForUpdate({ fetch: answer({ version: '0.3.0' }, false), currentVersion: '0.2.0' }), none);
  assert.deepEqual(await checkForUpdate({ fetch: answer({ version: 3 }), currentVersion: '0.2.0' }), none);
  assert.deepEqual(await checkForUpdate({ fetch: answer(null), currentVersion: '0.2.0' }), none);
  assert.deepEqual(await checkForUpdate({ fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }), currentVersion: '0.2.0' }), none);
  assert.deepEqual(await checkForUpdate({ fetch: async () => { throw new TypeError('offline'); }, currentVersion: '0.2.0' }), none);
  assert.deepEqual(await checkForUpdate({ fetch: answer({ version: '0.3.0' }), currentVersion: 'dev' }), none);
  assert.deepEqual(await checkForUpdate({ currentVersion: '0.2.0' }), none);
  assert.ok(Object.isFrozen(await checkForUpdate({ fetch: answer({ version: '0.3.0' }), currentVersion: '0.2.0' })));
});

test('checkForUpdate sends a bare GET: the site file only, no credentials, no cache, no redirect, no body', async () => {
  const calls = [];
  await checkForUpdate({ fetch: async (url, init) => { calls.push([url, init]); return { ok: false }; }, currentVersion: '0.2.0' });
  assert.deepEqual(calls, [[UPDATE_MANIFEST_URL, { cache: 'no-store', credentials: 'omit', redirect: 'error' }]]);
  assert.equal(new URL(UPDATE_MANIFEST_URL).origin, new URL(UPDATE_SITE_URL).origin, 'the file and the page are one site');
  assert.equal(new URL(UPDATE_SITE_URL).protocol, 'https:');
});

test('the manifest version is one the update check can read', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.notEqual(parseVersion(manifest.version), null);
});
