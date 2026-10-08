// docs/extension.md §16 (owner, 2026-09-30): the update check of the side panel, as pure functions over an injected fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  UPDATE_MANIFEST_URL, UPDATE_SITE_URL, UPDATE_TREE_URL, checkForUpdate, compareVersions, parseVersion, updateTreeUrls,
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

// ---------------------------------------------------------------------------------------------------------------------
// §21 (owner, 2026-10-08): the URLs of the signed update tree, derived from the version latest.json publishes.

const codeOf = (fn) => { try { fn(); return null; } catch (error) { return error?.code ?? `no code: ${error?.message}`; } };

test('UPDATE_TREE_URL is the update/ folder of the one download site, and latest.json stays what it was', () => {
  assert.equal(UPDATE_TREE_URL, 'https://kc-live-interpreter.vercel.app/update/');
  assert.equal(new URL(UPDATE_TREE_URL).origin, new URL(UPDATE_SITE_URL).origin, 'one site');
  assert.equal(new URL(UPDATE_TREE_URL).protocol, 'https:');
  assert.ok(UPDATE_TREE_URL.endsWith('/'), 'a base: the version is appended');
  assert.equal(UPDATE_MANIFEST_URL, 'https://kc-live-interpreter.vercel.app/latest.json');
});

test('updateTreeUrls: manifest, signature and file URLs of one version', () => {
  const urls = updateTreeUrls('0.5.0');
  assert.equal(urls.manifest, 'https://kc-live-interpreter.vercel.app/update/0.5.0/manifest.json');
  assert.equal(urls.signature, 'https://kc-live-interpreter.vercel.app/update/0.5.0/manifest.sig');
  assert.equal(urls.file('manifest.json'), 'https://kc-live-interpreter.vercel.app/update/0.5.0/files/manifest.json');
  assert.equal(urls.file('extension/lib/self-update.js'), 'https://kc-live-interpreter.vercel.app/update/0.5.0/files/extension/lib/self-update.js');
  assert.equal(urls.file('_locales/en/messages.json'), 'https://kc-live-interpreter.vercel.app/update/0.5.0/files/_locales/en/messages.json');
  assert.ok(Object.isFrozen(urls));
  assert.deepEqual(Object.keys(urls).sort(), ['file', 'manifest', 'signature']);
  assert.equal(updateTreeUrls('1.2.3.4').manifest, 'https://kc-live-interpreter.vercel.app/update/1.2.3.4/manifest.json');
  assert.equal(updateTreeUrls('1').signature, 'https://kc-live-interpreter.vercel.app/update/1/manifest.sig');
  assert.notEqual(updateTreeUrls('0.5.0').file('a.js'), updateTreeUrls('0.5.1').file('a.js'), 'every version has its own folder');
});

test('updateTreeUrls encodes every path segment and keeps the slashes between them', () => {
  const urls = updateTreeUrls('0.5.0');
  const base = 'https://kc-live-interpreter.vercel.app/update/0.5.0/files/';
  assert.equal(urls.file('icons/icon 16.png'), `${base}icons/icon%2016.png`);
  assert.equal(urls.file('a+b/c#d/e?f.js'), `${base}a%2Bb/c%23d/e%3Ff.js`);
  assert.equal(urls.file('50%.js'), `${base}50%25.js`);
  assert.equal(urls.file('a%2Fb'), `${base}a%252Fb`, 'an escape in a name is a literal percent, not a second slash');
  assert.equal(urls.file('x"y\'z<>.js'), `${base}x%22y'z%3C%3E.js`);
  for (const path of ['icons/icon 16.png', 'a+b/c#d/e?f.js', '50%.js', 'a%2Fb']) {
    const parsed = new URL(urls.file(path));
    assert.equal(parsed.search, '', `${path}: no query`);
    assert.equal(parsed.hash, '', `${path}: no fragment`);
    assert.equal(parsed.pathname.split('/').slice(4).map(decodeURIComponent).join('/'), path, `${path}: decodes back to the path`);
    assert.equal(parsed.origin, 'https://kc-live-interpreter.vercel.app');
  }
});

test('updateTreeUrls refuses a version that is not a Chrome version (it becomes part of a URL), with a coded error', () => {
  for (const bad of ['', 'latest', 'v1', '1.2.3.4.5', '1..2', '../0.5', '0.5.0/../../x', '0.5.0/', '0.5.0?x=1', '0.5.0#x', ' 0.5.0', '0.5.0 ', '0.5.0\n', '123456', '-1', '1e3',
    null, undefined, 5, 0.5, {}, [], ['0.5.0']]) {
    assert.equal(codeOf(() => updateTreeUrls(bad)), 'UPDATE_BAD_MANIFEST', JSON.stringify(bad) ?? String(bad));
  }
  assert.equal(codeOf(() => updateTreeUrls('0.5.0')), null);
  assert.equal(codeOf(() => updateTreeUrls()), 'UPDATE_BAD_MANIFEST');
});

test('updateTreeUrls().file refuses a path that could leave the version folder, with a coded error', () => {
  const { file } = updateTreeUrls('0.5.0');
  for (const bad of ['', '.', '..', '../x', 'a/../b', 'a/..', '/abs', 'a//b', 'a/', './a', 'a/./b', null, undefined, 5, {}, ['a']]) {
    assert.equal(codeOf(() => file(bad)), 'UPDATE_UNSAFE_PATH', JSON.stringify(bad) ?? String(bad));
  }
  assert.equal(codeOf(() => file('a..b/c.d')), null, 'dots inside a name are fine');
  assert.equal(codeOf(() => file('...')), null, 'only a segment that IS . or .. is refused (the safe-path rules of the manifest refuse the rest)');
});
