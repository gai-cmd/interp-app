import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as nodeSign, webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildExtension } from '../scripts/build-extension.mjs';
import {
  generateUpdateKeyPair, publicKeyOf, signUpdateManifest, verifyUpdateManifest as nodeVerifyUpdateManifest,
} from '../scripts/update-signing.mjs';
import {
  SELF_UPDATE_LIMITS, UPDATE_ERROR_CODES, UPDATE_FORMAT, applyUpdate, downloadUpdate, folderRelation, isSafeUpdatePath, planUpdate,
  verifyUpdateManifest,
} from '../extension/lib/self-update.js';
import { updateTreeUrls } from '../extension/lib/update-check.js';
import { UPDATE_PUBLIC_KEYS } from '../extension/lib/update-keys.js';
import { buildSignedTree, createFakeFolder, createFakeSite } from './fixtures/fake-fs.mjs';

// docs/extension.md §21 (owner, 2026-10-08): the pure part of the extension's self-update. The extension replaces the files
// of its own folder, so what is pinned here is what makes that safe: the signature over the exact manifest bytes (primary and
// backup key, no other key, no other algorithm), a strict manifest, paths that can never leave the folder, every download
// checked against the signed size and hash BEFORE the first write, the write order (manifest.json last), an interrupted
// apply that a retry finishes, and obsolete files removed only from the list of the previous apply. No test touches a
// network, a disk outside a temp folder, a browser or a key of the owner: keys are generated here and injected.

const subtle = webcrypto.subtle;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const hex = (content) => createHash('sha256').update(typeof content === 'string' ? enc(content) : content).digest('hex');
const codeOf = (promise) => promise.then(() => null, (error) => error?.code ?? `no code: ${error?.message}`);
const codeOfSync = (fn) => { try { fn(); return null; } catch (error) { return error?.code ?? `no code: ${error?.message}`; } };
const entry = (path, content) => ({ path, size: enc(content).length, sha256: hex(content) });

const primary = generateUpdateKeyPair();
const backup = generateUpdateKeyPair();
const stranger = generateUpdateKeyPair();
const KEYS = [primary.publicB64, backup.publicB64];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Signs the exact text of a manifest (an object is written the way the release script writes it). */
function signText(source, pem = primary.privatePem) {
  const manifestBytes = enc(typeof source === 'string' ? source : `${JSON.stringify(source, null, 2)}\n`);
  return { manifestBytes, signature: signUpdateManifest(manifestBytes, pem) };
}
const GOOD_FILES = Object.freeze({
  'manifest.json': '{ "version": "0.5.0" }\n', 'extension/lib/a.js': 'export const a = 1;\n', '_locales/en/messages.json': '{}\n',
});
const goodManifest = (overrides = {}) => ({
  format: 1, version: '0.5.0', released: '2026-10-08', files: Object.entries(GOOD_FILES).map(([path, content]) => entry(path, content)), ...overrides,
});
const verifyOf = (signed, publicKeys = KEYS) => verifyUpdateManifest({ ...signed, publicKeys, subtle });

// ---------------------------------------------------------------------------------------------------------------------
// Constants.

test('the contract constants: format 1, the limits of section 21, and the fifteen UPDATE_ codes, all frozen', () => {
  assert.equal(UPDATE_FORMAT, 1);
  assert.deepEqual(SELF_UPDATE_LIMITS, { maxFiles: 400, maxFileBytes: 2097152, maxTotalBytes: 16777216, maxManifestBytes: 262144, maxPathChars: 255 });
  assert.deepEqual([...UPDATE_ERROR_CODES], [
    'UPDATE_DISABLED', 'UPDATE_NO_FOLDER', 'UPDATE_NEEDS_PERMISSION', 'UPDATE_PERMISSION_DENIED', 'UPDATE_WRONG_FOLDER', 'UPDATE_NOT_NEWER',
    'UPDATE_FETCH_FAILED', 'UPDATE_BAD_SIGNATURE', 'UPDATE_BAD_MANIFEST', 'UPDATE_UNSAFE_PATH', 'UPDATE_TOO_LARGE', 'UPDATE_BAD_HASH',
    'UPDATE_WRITE_FAILED', 'UPDATE_PICK_CANCELLED', 'UPDATE_BUSY',
  ]);
  assert.ok(Object.isFrozen(SELF_UPDATE_LIMITS) && Object.isFrozen(UPDATE_ERROR_CODES));
});

// ---------------------------------------------------------------------------------------------------------------------
// Paths.

test('isSafeUpdatePath accepts the shapes of the extension tree', () => {
  for (const path of ['manifest.json', 'extension/lib/self-update.js', 'extension/panel/panel.html', 'icons/icon-128.png',
    '_locales/en/messages.json', 'app/i18n/ko.json', 'styles.css', 'my file.js', 'a/b/c/d/e.txt', 'extension/_nested.js', 'v1.2.3/x', 'A-B_c.d']) {
    assert.equal(isSafeUpdatePath(path), true, path);
  }
  assert.equal(isSafeUpdatePath('a'.repeat(255)), true, '255 characters is the limit');
});

test('isSafeUpdatePath refuses every way out of the folder, every alias and every name the platform treats specially', () => {
  const bad = [
    ['empty', ''], ['absolute', '/etc/passwd'], ['leading slash', '/manifest.json'], ['parent', '../x'], ['parent in the middle', 'a/../b'],
    ['only ..', '..'], ['dot segment', 'a/./b'], ['only .', '.'], ['empty segment', 'a//b'], ['trailing slash', 'a/'], ['backslash', 'a\\b'],
    ['backslash parent', '..\\x'], ['drive letter', 'C:/x'], ['drive letter, no slash', 'c:x'], ['colon (an alternate stream on Windows)', 'a.txt:evil'],
    ['_metadata folder', '_metadata/verified_contents.json'], ['_metadata nested', 'a/_metadata/x'], ['_metadata in other case', 'a/_METADATA'],
    ['a name starting with _metadata', 'a/_metadata.json'], ['NUL', 'a\u0000b'], ['newline', 'a\nb'], ['tab', 'a\tb'], ['DEL', 'a\u007fb'],
    ['C1 control', 'a\u0085b'], ['non-ASCII', 'é.js'], ['non-ASCII, a look-alike dot', 'a\u2024js'], ['space-like', 'a\u00a0b'],
    ['percent escape', 'a%2fb'], ['question mark', 'a?b'], ['star', 'a*b'], ['quote', 'a"b'], ['angle bracket', 'a<b'], ['pipe', 'a|b'],
    ['a name ending in a dot', 'a.'], ['a name ending in a space', 'a '], ['a name starting with a space', ' a'], ['a nested name ending in a dot', 'x/y.'],
    ['a Windows device name', 'CON'], ['a device name with an extension', 'x/nul.txt'], ['a numbered device name', 'COM1.js'],
    ['a device name in another case', 'Lpt9'], ['a root name starting with _', '_x.js'], ['a root folder starting with _', '_other/x.js'],
    ['_locales as a file', '_locales'], ['too long', 'a'.repeat(256)],
    ['not a string: null', null], ['not a string: undefined', undefined], ['not a string: number', 1], ['not a string: array', ['a']], ['not a string: object', { toString: () => 'a' }],
  ];
  for (const [name, path] of bad) assert.equal(isSafeUpdatePath(path), false, name);
});

// ---------------------------------------------------------------------------------------------------------------------
// The signature.

test('a manifest signed by the primary key and one signed by the backup key are both accepted, and the result is the frozen manifest', async () => {
  for (const [name, pem] of [['primary', primary.privatePem], ['backup', backup.privatePem]]) {
    const manifest = await verifyOf(signText(goodManifest(), pem));
    assert.deepEqual(manifest, goodManifest(), name);
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.files) && Object.isFrozen(manifest.files[0]), `${name}: frozen`);
  }
  // The order of the key list does not matter, and one key of the list is enough.
  assert.equal((await verifyOf(signText(goodManifest(), backup.privatePem), [backup.publicB64])).version, '0.5.0');
  assert.equal((await verifyOf(signText(goodManifest(), backup.privatePem), [primary.publicB64, backup.publicB64])).version, '0.5.0');
  // The text of manifest.sig usually ends with a newline.
  const signed = signText(goodManifest());
  assert.equal((await verifyOf({ ...signed, signature: `${signed.signature}\n` })).version, '0.5.0');
});

test('any single flipped byte of the manifest makes the signature fail', async () => {
  const signed = signText(goodManifest());
  assert.ok(signed.manifestBytes.length > 100);
  for (let index = 0; index < signed.manifestBytes.length; index += 1) {
    const copy = new Uint8Array(signed.manifestBytes);
    copy[index] ^= 0x01;
    assert.equal(await codeOf(verifyOf({ manifestBytes: copy, signature: signed.signature })), 'UPDATE_BAD_SIGNATURE', `byte ${index}`);
  }
});

test('any single flipped byte of the signature fails, and so does a signature that is not exactly 64 canonical bytes', async () => {
  const signed = signText(goodManifest());
  const raw = Buffer.from(signed.signature, 'base64');
  assert.equal(raw.length, 64);
  for (let index = 0; index < raw.length; index += 1) {
    const copy = Buffer.from(raw);
    copy[index] ^= 0x80;
    assert.equal(await codeOf(verifyOf({ ...signed, signature: copy.toString('base64') })), 'UPDATE_BAD_SIGNATURE', `signature byte ${index}`);
  }
  const bad = {
    truncated: raw.subarray(0, 63).toString('base64'),
    'half': raw.subarray(0, 32).toString('base64'),
    extended: Buffer.concat([raw, Buffer.from([0])]).toString('base64'),
    empty: '',
    'not base64': '!!!!',
    'url-safe characters': `${signed.signature.slice(0, 10)}-_${signed.signature.slice(12)}`,
    'no padding': signed.signature.replace(/=+$/, ''),
    'whitespace inside': `${signed.signature.slice(0, 40)} ${signed.signature.slice(40)}`,
    'a DER encoded signature': nodeSign('sha256', signed.manifestBytes, { key: primary.privatePem }).toString('base64'),
    'the unused padding bits changed (not canonical)': `${signed.signature.slice(0, -3)}${B64[B64.indexOf(signed.signature.at(-3)) ^ 1]}==`,
  };
  for (const [name, signature] of Object.entries(bad)) assert.equal(await codeOf(verifyOf({ ...signed, signature })), 'UPDATE_BAD_SIGNATURE', name);
  for (const value of [null, undefined, 5, {}, raw]) assert.equal(await codeOf(verifyOf({ ...signed, signature: value })), 'UPDATE_BAD_SIGNATURE', String(value));
});

test('the extension\'s own checks of the signature text stand on their own: a crypto object that says yes to everything still gets a refusal for a bad signature', async () => {
  const signed = signText(goodManifest());
  const raw = Buffer.from(signed.signature, 'base64');
  const yes = { importKey: async () => ({}), verify: async () => true };
  const accepted = await verifyUpdateManifest({ ...signed, publicKeys: KEYS, subtle: yes });
  assert.equal(accepted.version, '0.5.0', 'the stand-in does say yes to a well-formed signature');
  const bad = {
    truncated: raw.subarray(0, 63).toString('base64'), extended: Buffer.concat([raw, Buffer.from([0])]).toString('base64'), empty: '',
    'a DER encoded signature': nodeSign('sha256', signed.manifestBytes, { key: primary.privatePem }).toString('base64'),
    'no padding': signed.signature.replace(/=+$/, ''), 'url-safe characters': `${signed.signature.slice(0, 10)}-_${signed.signature.slice(12)}`,
    'whitespace inside': `${signed.signature.slice(0, 40)} ${signed.signature.slice(40)}`,
    'the unused padding bits changed (not canonical)': `${signed.signature.slice(0, -3)}${B64[B64.indexOf(signed.signature.at(-3)) ^ 1]}==`,
    'padding in the middle': `${signed.signature.slice(0, 40)}====${signed.signature.slice(44)}`,
  };
  for (const [name, signature] of Object.entries(bad)) {
    assert.equal(await codeOf(verifyUpdateManifest({ ...signed, signature, publicKeys: KEYS, subtle: yes })), 'UPDATE_BAD_SIGNATURE', name);
  }
  // The same for the manifest: size and key list are judged before the crypto object is asked.
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, manifestBytes: new Uint8Array(SELF_UPDATE_LIMITS.maxManifestBytes + 1), publicKeys: KEYS, subtle: yes })), 'UPDATE_TOO_LARGE');
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, publicKeys: [], subtle: yes })), 'UPDATE_BAD_SIGNATURE');
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, publicKeys: ['not base64!'], subtle: yes })), 'UPDATE_BAD_SIGNATURE', 'a key that does not decode is skipped, not imported');
});

test('a signature made with another key, over other bytes, or over bytes that differ even by a trailing newline is refused', async () => {
  assert.equal(await codeOf(verifyOf(signText(goodManifest(), stranger.privatePem))), 'UPDATE_BAD_SIGNATURE', 'a key that is not on the list');
  const one = signText(goodManifest());
  const other = signText(goodManifest({ version: '0.5.1' }));
  assert.equal(await codeOf(verifyOf({ manifestBytes: other.manifestBytes, signature: one.signature })), 'UPDATE_BAD_SIGNATURE', 'the signature of another manifest');
  const appended = new Uint8Array([...one.manifestBytes, 0x0a]);
  assert.equal(await codeOf(verifyOf({ manifestBytes: appended, signature: one.signature })), 'UPDATE_BAD_SIGNATURE', 'signed bytes are exact: a trailing newline is another file');
  const reformatted = enc(JSON.stringify(goodManifest()));
  assert.equal(await codeOf(verifyOf({ manifestBytes: reformatted, signature: one.signature })), 'UPDATE_BAD_SIGNATURE', 'the same JSON written differently');
});

test('a key of another algorithm, another curve, a broken key or an empty list can not vouch for anything; a broken key does not stop a good one', async () => {
  const signed = signText(goodManifest());
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  for (const [name, keys] of [['P-384', [p384]], ['RSA', [rsa]], ['Ed25519', [ed]], ['garbage text', ['not a key']], ['truncated key', [primary.publicB64.slice(0, 60)]],
    ['empty list', []], ['not a list', null], ['a non-string entry', [5, null, {}]]]) {
    assert.equal(await codeOf(verifyOf(signed, keys)), 'UPDATE_BAD_SIGNATURE', name);
  }
  assert.equal((await verifyOf(signed, ['not a key', p384, rsa, ed, primary.publicB64])).version, '0.5.0', 'the good key is found behind four bad ones');
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, publicKeys: KEYS })), 'UPDATE_BAD_SIGNATURE', 'no crypto object');
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, publicKeys: KEYS, subtle: {} })), 'UPDATE_BAD_SIGNATURE');
  const throwing = { importKey: () => Promise.reject(new Error('boom')), verify: () => Promise.reject(new Error('boom')) };
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, publicKeys: KEYS, subtle: throwing })), 'UPDATE_BAD_SIGNATURE', 'a crypto failure is a refusal, not a pass');
  const yes = { importKey: async () => ({}), verify: async () => 'true' };
  assert.equal(await codeOf(verifyUpdateManifest({ ...signed, publicKeys: KEYS, subtle: yes })), 'UPDATE_BAD_SIGNATURE', 'only the boolean true counts');
});

test('manifest bytes that are missing, empty, oversized or not bytes are refused before the signature is looked at', async () => {
  const signed = signText(goodManifest());
  for (const value of [undefined, null, 'text', 5, [1, 2, 3], {}]) assert.equal(await codeOf(verifyOf({ ...signed, manifestBytes: value })), 'UPDATE_BAD_MANIFEST', String(value));
  assert.equal(await codeOf(verifyOf({ ...signed, manifestBytes: new Uint8Array(0) })), 'UPDATE_BAD_MANIFEST');
  const huge = signText(`{"format":1,"pad":"${'x'.repeat(SELF_UPDATE_LIMITS.maxManifestBytes)}"}`);
  assert.equal(await codeOf(verifyOf(huge)), 'UPDATE_TOO_LARGE', 'over 256 KiB even when the signature is good');
  const edge = signText(`${' '.repeat(SELF_UPDATE_LIMITS.maxManifestBytes - 2)}[]`);
  assert.equal(edge.manifestBytes.length, SELF_UPDATE_LIMITS.maxManifestBytes);
  assert.equal(await codeOf(verifyOf(edge)), 'UPDATE_BAD_MANIFEST', 'exactly 256 KiB is read (and is not a manifest)');
  // An ArrayBuffer and a DataView are bytes too.
  assert.equal((await verifyOf({ ...signed, manifestBytes: signed.manifestBytes.buffer.slice(signed.manifestBytes.byteOffset, signed.manifestBytes.byteOffset + signed.manifestBytes.byteLength) })).version, '0.5.0');
  const padded = new Uint8Array(signed.manifestBytes.length + 10);
  padded.set(signed.manifestBytes, 5);
  assert.equal((await verifyOf({ ...signed, manifestBytes: padded.subarray(5, 5 + signed.manifestBytes.length) })).version, '0.5.0', 'a view into a larger buffer is read by its own range');
});

// ---------------------------------------------------------------------------------------------------------------------
// The manifest.

const manyFiles = (count, size = 1) => Array.from({ length: count }, (_, index) => ({ path: `extension/f${index}.js`, size, sha256: hex(`${index}`) }));
const withFiles = (files) => goodManifest({ files: [entry('manifest.json', '{}'), ...files] });
const MANIFEST_CASES = [
  ['format 2', (m) => ({ ...m, format: 2 }), 'UPDATE_BAD_MANIFEST'],
  ['format as a string', (m) => ({ ...m, format: '1' }), 'UPDATE_BAD_MANIFEST'],
  ['no format', ({ format, ...rest }) => rest, 'UPDATE_BAD_MANIFEST'],
  ['an extra top-level field', (m) => ({ ...m, note: 'x' }), 'UPDATE_BAD_MANIFEST'],
  ['a __proto__ field', () => '{"format":1,"version":"0.5.0","released":"2026-10-08","files":[],"__proto__":{}}', 'UPDATE_BAD_MANIFEST'],
  ['the root is an array', () => '[]', 'UPDATE_BAD_MANIFEST'],
  ['the root is null', () => 'null', 'UPDATE_BAD_MANIFEST'],
  ['the text is not JSON', () => '{ not json', 'UPDATE_BAD_MANIFEST'],
  ['a version that is not a version', (m) => ({ ...m, version: 'latest' }), 'UPDATE_BAD_MANIFEST'],
  ['a version with five parts', (m) => ({ ...m, version: '1.2.3.4.5' }), 'UPDATE_BAD_MANIFEST'],
  ['a version as a number', (m) => ({ ...m, version: 5 }), 'UPDATE_BAD_MANIFEST'],
  ['no released', ({ released, ...rest }) => rest, 'UPDATE_BAD_MANIFEST'],
  ['released as a number', (m) => ({ ...m, released: 20261008 }), 'UPDATE_BAD_MANIFEST'],
  ['released with a control character', (m) => ({ ...m, released: '2026\n10' }), 'UPDATE_BAD_MANIFEST'],
  ['released longer than 64 characters', (m) => ({ ...m, released: 'x'.repeat(65) }), 'UPDATE_BAD_MANIFEST'],
  ['files is not an array', (m) => ({ ...m, files: {} }), 'UPDATE_BAD_MANIFEST'],
  ['files is empty', (m) => ({ ...m, files: [] }), 'UPDATE_BAD_MANIFEST'],
  ['a file entry that is a string', (m) => ({ ...m, files: [...m.files, 'extension/x.js'] }), 'UPDATE_BAD_MANIFEST'],
  ['a file entry with an extra field', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), mode: 755 }] }), 'UPDATE_BAD_MANIFEST'],
  ['a file entry without a hash', (m) => ({ ...m, files: [...m.files, { path: 'x.js', size: 1 }] }), 'UPDATE_BAD_MANIFEST'],
  ['a hash in upper case', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), sha256: hex('x').toUpperCase() }] }), 'UPDATE_BAD_MANIFEST'],
  ['a hash that is too short', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), sha256: hex('x').slice(1) }] }), 'UPDATE_BAD_MANIFEST'],
  ['a hash that is not hex', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), sha256: 'g'.repeat(64) }] }), 'UPDATE_BAD_MANIFEST'],
  ['a negative size', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), size: -1 }] }), 'UPDATE_BAD_MANIFEST'],
  ['a fractional size', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), size: 1.5 }] }), 'UPDATE_BAD_MANIFEST'],
  ['a size as a string', (m) => ({ ...m, files: [...m.files, { ...entry('x.js', 'x'), size: '1' }] }), 'UPDATE_BAD_MANIFEST'],
  ['no manifest.json among the files', (m) => ({ ...m, files: m.files.filter((file) => file.path !== 'manifest.json') }), 'UPDATE_BAD_MANIFEST'],
  ['manifest.json only in another case', (m) => ({ ...m, files: m.files.map((file) => (file.path === 'manifest.json' ? { ...file, path: 'Manifest.json' } : file)) }), 'UPDATE_BAD_MANIFEST'],
  ['a file over 2 MiB', (m) => ({ ...m, files: [...m.files, { path: 'big.bin', size: SELF_UPDATE_LIMITS.maxFileBytes + 1, sha256: hex('x') }] }), 'UPDATE_TOO_LARGE'],
  ['more than 400 files', () => withFiles(manyFiles(400)), 'UPDATE_TOO_LARGE'],
  ['over 16 MiB in total', () => withFiles(Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.bin`, size: SELF_UPDATE_LIMITS.maxFileBytes, sha256: hex(`${index}`) }))), 'UPDATE_TOO_LARGE'],
  ['a path with ..', (m) => ({ ...m, files: [...m.files, entry('../escape.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a path with .. in the middle', (m) => ({ ...m, files: [...m.files, entry('a/../../escape.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['an absolute path', (m) => ({ ...m, files: [...m.files, entry('/etc/hosts', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a backslash path', (m) => ({ ...m, files: [...m.files, entry('a\\b.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a drive letter', (m) => ({ ...m, files: [...m.files, entry('C:/x.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a _metadata path', (m) => ({ ...m, files: [...m.files, entry('_metadata/computed_hashes.json', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a control character in a path', (m) => ({ ...m, files: [...m.files, entry('a\u0001b.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a path that is not a string', (m) => ({ ...m, files: [...m.files, { path: 5, size: 1, sha256: hex('x') }] }), 'UPDATE_UNSAFE_PATH'],
  ['the same path twice', (m) => ({ ...m, files: [...m.files, entry('extension/lib/a.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['the same path in another case', (m) => ({ ...m, files: [...m.files, entry('Extension/Lib/A.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a file that is also a folder', (m) => ({ ...m, files: [...m.files, entry('extension/lib/a.js/inner.js', 'x')] }), 'UPDATE_UNSAFE_PATH'],
  ['a folder that is also a file, in another case', (m) => ({ ...m, files: [...m.files, entry('EXTENSION', 'x')] }), 'UPDATE_UNSAFE_PATH'],
];
test('a validly signed manifest is still refused when its structure, limits or paths are wrong (each case alone)', async () => {
  assert.equal((await verifyOf(signText(goodManifest()))).files.length, 3, 'the baseline passes');
  for (const [name, change, code] of MANIFEST_CASES) {
    const changed = change(goodManifest());
    assert.equal(await codeOf(verifyOf(signText(changed))), code, name);
  }
});

test('a manifest with a non-ASCII byte is refused even when signed (every field of it is ASCII)', async () => {
  assert.equal(await codeOf(verifyOf(signText(goodManifest({ released: '2026-10-08 \u00e9' })))), 'UPDATE_BAD_MANIFEST');
  const bytes = new Uint8Array([...enc(JSON.stringify(goodManifest())), 0xc3, 0xa9]);
  const signature = signUpdateManifest(bytes, primary.privatePem);
  assert.equal(await codeOf(verifyOf({ manifestBytes: bytes, signature })), 'UPDATE_BAD_MANIFEST');
});

test('the limits themselves are allowed: 400 files, one file of 2 MiB, exactly 16 MiB in total', async () => {
  const four = withFiles(manyFiles(399));
  assert.equal(four.files.length, 400);
  assert.equal((await verifyOf(signText(four))).files.length, 400);
  const manifestSize = 100;
  const big = SELF_UPDATE_LIMITS.maxFileBytes;
  const rest = SELF_UPDATE_LIMITS.maxTotalBytes - manifestSize - 7 * big;
  const files = [{ path: 'manifest.json', size: manifestSize, sha256: hex('m') }, ...Array.from({ length: 7 }, (_, index) => ({ path: `f${index}.bin`, size: big, sha256: hex(`${index}`) })),
    { path: 'rest.bin', size: rest, sha256: hex('r') }];
  assert.equal(files.reduce((sum, file) => sum + file.size, 0), SELF_UPDATE_LIMITS.maxTotalBytes);
  assert.equal((await verifyOf(signText(goodManifest({ files })))).files.length, 9);
  files[8] = { ...files[8], size: rest + 1 };
  assert.equal(await codeOf(verifyOf(signText(goodManifest({ files })))), 'UPDATE_TOO_LARGE', 'one byte more than 16 MiB');
  assert.equal((await verifyOf(signText(goodManifest({ files: [entry('manifest.json', 'm'), { path: 'one.bin', size: 0, sha256: hex('') }] })))).files[1].size, 0, 'an empty file is a file');
});

// ---------------------------------------------------------------------------------------------------------------------
// The version rule.

test('planUpdate: only a strictly newer version is an update', () => {
  const plan = (version, runningVersion) => planUpdate({ manifest: { version }, runningVersion });
  assert.deepEqual(plan('0.5.0', '0.4.0'), { ok: true });
  assert.deepEqual(plan('0.10.0', '0.9.9'), { ok: true }, 'numeric, not text order');
  assert.deepEqual(plan('1.0', '0.99.99'), { ok: true });
  assert.deepEqual(plan('0.5.0.1', '0.5.0'), { ok: true });
  assert.deepEqual(plan('0.5.0', '0.5.0'), { ok: false, code: 'UPDATE_NOT_NEWER' }, 'the same version');
  assert.deepEqual(plan('0.5', '0.5.0'), { ok: false, code: 'UPDATE_NOT_NEWER' }, 'the same version, spelled shorter');
  assert.deepEqual(plan('0.4.0', '0.5.0'), { ok: false, code: 'UPDATE_NOT_NEWER' }, 'a lower version is a rollback');
  assert.deepEqual(plan('0.9.9', '0.10.0'), { ok: false, code: 'UPDATE_NOT_NEWER' });
  assert.deepEqual(plan('latest', '0.4.0'), { ok: false, code: 'UPDATE_BAD_MANIFEST' }, 'a manifest version nobody can read');
  assert.deepEqual(plan(undefined, '0.4.0'), { ok: false, code: 'UPDATE_BAD_MANIFEST' });
  assert.deepEqual(plan('0.5.0', 'dev'), { ok: false, code: 'UPDATE_NOT_NEWER' }, 'a running version nobody can read proves nothing');
  assert.deepEqual(plan('0.5.0', undefined), { ok: false, code: 'UPDATE_NOT_NEWER' });
  assert.deepEqual(planUpdate({ runningVersion: '0.4.0' }), { ok: false, code: 'UPDATE_BAD_MANIFEST' });
  assert.deepEqual(planUpdate(), { ok: false, code: 'UPDATE_BAD_MANIFEST' });
});

// ---------------------------------------------------------------------------------------------------------------------
// Downloading.

const TREE_FILES = Object.freeze({
  'manifest.json': '{"manifest_version":3,"version":"0.5.0"}\n',
  'extension/lib/a.js': 'export const a = 2;\n',
  'extension/panel/panel.html': '<!doctype html>\n',
  '_locales/en/messages.json': '{}\n',
  'icons/icon 16.png': 'PNGDATA',
});
const makeTree = (files = TREE_FILES, version = '0.5.0') => buildSignedTree({ version, files, privatePem: primary.privatePem });
const verified = async (tree) => verifyOf({ manifestBytes: tree.manifestBytes, signature: tree.signature });

test('downloadUpdate fetches every file of the signed list at its derived URL, checks size and hash, and returns private copies in manifest order', async () => {
  const tree = makeTree();
  const site = createFakeSite({ latest: '0.5.0', trees: [tree] });
  const asked = [];
  const progress = [];
  const files = await downloadUpdate({
    manifest: await verified(tree), subtle, onProgress: (info) => progress.push(info),
    fetchBytes: (url, options) => { asked.push([url, options.maxBytes]); return site.fetchBytes(url, options); },
  });
  const urls = updateTreeUrls('0.5.0');
  assert.deepEqual([...files.keys()], tree.manifest.files.map((file) => file.path), 'manifest order');
  assert.deepEqual(asked.map(([url]) => url).sort(), tree.manifest.files.map((file) => urls.file(file.path)).sort());
  assert.ok(asked.some(([url]) => url.endsWith('/files/icons/icon%2016.png')), 'a path segment is percent-encoded');
  for (const [url, limit] of asked) assert.equal(limit, tree.manifest.files.find((file) => urls.file(file.path) === url).size, 'the body limit is the signed size');
  for (const [path, bytes] of files) assert.deepEqual(bytes, tree.files.get(path), path);
  assert.equal(progress.length, 5);
  assert.deepEqual(progress.map((info) => info.total), [5, 5, 5, 5, 5]);
  assert.deepEqual(progress.map((info) => info.done).sort(), [1, 2, 3, 4, 5]);
  const fetched = new Uint8Array(enc('abc'));
  const own = await downloadUpdate({
    manifest: await verified(makeTree({ 'manifest.json': '{"version":"0.5.0"}\n', 'x.txt': 'abc' })), subtle,
    fetchBytes: async (url) => (url.endsWith('x.txt') ? fetched : enc('{"version":"0.5.0"}\n')),
  });
  fetched[0] = 0x7a;
  assert.equal(dec(own.get('x.txt')), 'abc', 'what is hashed is what is kept: the downloader keeps no handle on it');
});

test('downloadUpdate returns the files in manifest order even when later files arrive first', async () => {
  const files = { 'manifest.json': '{"version":"0.5.0"}\n' };
  for (let index = 0; index < 12; index += 1) files[`extension/f${String(index).padStart(2, '0')}.js`] = `export const n = ${index};\n`;
  const tree = makeTree(files);
  const site = createFakeSite({ latest: '0.5.0', trees: [tree] });
  const order = tree.manifest.files.map((file) => file.path);
  const urls = updateTreeUrls('0.5.0');
  const delays = new Map(order.map((path, index) => [urls.file(path), (order.length - index) * 4]));
  const map = await downloadUpdate({
    manifest: await verified(tree), subtle,
    fetchBytes: async (url, options) => { await new Promise((resolve) => setTimeout(resolve, delays.get(url))); return site.fetchBytes(url, options); },
  });
  assert.deepEqual([...map.keys()], order, 'manifest order, whatever the arrival order');
});

test('downloadUpdate refuses a file whose bytes, size or hash differ from the signed list', async () => {
  const tree = makeTree();
  const manifest = await verified(tree);
  const urls = updateTreeUrls('0.5.0');
  const target = urls.file('extension/lib/a.js');
  const run = (change) => {
    const site = createFakeSite({ latest: '0.5.0', trees: [tree] });
    change(site);
    return codeOf(downloadUpdate({ manifest, subtle, fetchBytes: site.fetchBytes }));
  };
  assert.equal(await run(() => {}), null, 'the baseline passes');
  assert.equal(await run((site) => site.override(target, enc('export const a = 3;\n'))), 'UPDATE_BAD_HASH', 'same size, other bytes');
  assert.equal(await run((site) => site.override(target, enc('export const a = 2;'))), 'UPDATE_BAD_HASH', 'shorter');
  assert.equal(await run((site) => site.override(target, enc('export const a = 2;\n\n'))), 'UPDATE_TOO_LARGE', 'longer than signed, a downloader that stops at the signed size');
  const lenient = createFakeSite({ latest: '0.5.0', trees: [tree] });
  lenient.override(target, enc('export const a = 2;\n\n'));
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle, fetchBytes: async (url) => lenient.fetchBytes(url) })), 'UPDATE_BAD_HASH', 'longer, a downloader that did not stop');
  assert.equal(await run((site) => site.override(target, new Uint8Array(0))), 'UPDATE_BAD_HASH', 'empty');
  assert.equal(await run((site) => site.override(urls.file('manifest.json'), enc('{"manifest_version":3,"version":"0.5.1"}\n'))), 'UPDATE_BAD_HASH', 'a manifest.json that is not the signed one');
  assert.equal(await run((site) => site.override(target, null)), 'UPDATE_FETCH_FAILED', 'a file the site does not have');
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle, fetchBytes: async () => { throw new TypeError('offline'); } })), 'UPDATE_FETCH_FAILED');
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle, fetchBytes: async () => { throw Object.assign(new Error('x'), { code: 'UPDATE_TOO_LARGE' }); } })), 'UPDATE_TOO_LARGE', 'a body over its limit keeps its code');
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle, fetchBytes: async () => { throw Object.assign(new Error('x'), { code: 'UPDATE_BAD_SIGNATURE' }); } })), 'UPDATE_FETCH_FAILED', 'a downloader can not report any other code');
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle, fetchBytes: async () => 'text' })), 'UPDATE_FETCH_FAILED', 'not bytes');
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle, fetchBytes: async () => null })), 'UPDATE_FETCH_FAILED');
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle })), 'UPDATE_FETCH_FAILED', 'no downloader');
  assert.equal(await codeOf(downloadUpdate({ manifest, fetchBytes: async (url) => createFakeSite({ latest: '1', trees: [tree] }).fetchBytes(url) })), 'UPDATE_BAD_HASH', 'no crypto object');
  const brokenDigest = { digest: () => Promise.reject(new Error('boom')) };
  assert.equal(await codeOf(downloadUpdate({ manifest, subtle: brokenDigest, fetchBytes: async (url) => createFakeSite({ latest: '1', trees: [tree] }).fetchBytes(url) })), 'UPDATE_BAD_HASH');
});

test('downloadUpdate: the manifest.json that is downloaded must carry the signed version', async () => {
  const wrongVersion = buildSignedTree({ version: '0.5.0', privatePem: primary.privatePem, files: { ...TREE_FILES, 'manifest.json': '{"version":"0.4.9"}\n' } });
  assert.equal(await codeOf(downloadUpdate({ manifest: await verified(wrongVersion), subtle, fetchBytes: createFakeSite({ latest: '0.5.0', trees: [wrongVersion] }).fetchBytes })), 'UPDATE_BAD_MANIFEST');
  for (const [name, text] of [['no version', '{}\n'], ['a numeric version', '{"version":5}\n'], ['not JSON', 'nope'], ['an array', '[]'], ['the version only equal as a number', '{"version":0.5}\n'],
    ['the same version written shorter', '{"version":"0.5"}\n']]) {
    const tree = buildSignedTree({ version: '0.5.0', privatePem: primary.privatePem, files: { ...TREE_FILES, 'manifest.json': text } });
    assert.equal(await codeOf(downloadUpdate({ manifest: await verified(tree), subtle, fetchBytes: createFakeSite({ latest: '0.5.0', trees: [tree] }).fetchBytes })), 'UPDATE_BAD_MANIFEST', name);
  }
  const ok = buildSignedTree({ version: '0.5.0', privatePem: primary.privatePem, files: { ...TREE_FILES, 'manifest.json': '{\n  "version": "0.5.0"\n}\n' } });
  assert.equal(await codeOf(downloadUpdate({ manifest: await verified(ok), subtle, fetchBytes: createFakeSite({ latest: '0.5.0', trees: [ok] }).fetchBytes })), null);
});

test('downloadUpdate checks the manifest itself first: a bad one is refused before a single request', async () => {
  const asked = [];
  const fetchBytes = async (url) => { asked.push(url); return new Uint8Array(0); };
  for (const [name, manifest, code] of [
    ['a path with ..', { ...goodManifest(), files: [...goodManifest().files, entry('../x.js', 'x')] }, 'UPDATE_UNSAFE_PATH'],
    ['the same path twice', { ...goodManifest(), files: [...goodManifest().files, entry('manifest.json', 'x')] }, 'UPDATE_UNSAFE_PATH'],
    ['a version that is not one', { ...goodManifest(), version: '../0.5.0' }, 'UPDATE_BAD_MANIFEST'],
    ['not an object', null, 'UPDATE_BAD_MANIFEST'],
    ['a file over 2 MiB', { ...goodManifest(), files: [...goodManifest().files, { path: 'big', size: 2097153, sha256: hex('x') }] }, 'UPDATE_TOO_LARGE'],
  ]) {
    assert.equal(await codeOf(downloadUpdate({ manifest, fetchBytes, subtle })), code, name);
  }
  assert.deepEqual(asked, [], 'nothing was requested');
});

test('downloadUpdate stops starting new downloads after the first failure and reports that failure, and a throwing progress callback changes nothing', async () => {
  const files = { 'manifest.json': '{"version":"0.5.0"}\n' };
  for (let index = 0; index < 60; index += 1) files[`extension/f${String(index).padStart(2, '0')}.js`] = `export const n = ${index};\n`;
  const tree = makeTree(files);
  const site = createFakeSite({ latest: '0.5.0', trees: [tree] });
  const first = updateTreeUrls('0.5.0').file(tree.manifest.files[0].path);
  site.override(first, enc('tampered'));
  let calls = 0;
  const code = await codeOf(downloadUpdate({ manifest: await verified(tree), subtle, fetchBytes: (url, options) => { calls += 1; return site.fetchBytes(url, options); } }));
  assert.equal(code, 'UPDATE_BAD_HASH');
  assert.ok(calls < 30, `${calls} requests of 61: the failure stopped the rest`);
  site.clearOverrides();
  const map = await downloadUpdate({ manifest: await verified(tree), subtle, fetchBytes: site.fetchBytes, onProgress: () => { throw new Error('ui bug'); } });
  assert.equal(map.size, 61);
});

// ---------------------------------------------------------------------------------------------------------------------
// The folder.

const RUNNING_MANIFEST = '{"manifest_version":3,"version":"0.4.0"}\n';
const TARGET_MANIFEST = TREE_FILES['manifest.json'];

test('folderRelation: running, target or other, judged by the bytes of manifest.json', async () => {
  const relation = (folder, running = enc(RUNNING_MANIFEST), target = enc(TARGET_MANIFEST)) => folderRelation({ dir: folder.handle, runningManifestBytes: running, targetManifestBytes: target });
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST } })), 'running');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': TARGET_MANIFEST } })), 'target');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': '{"version":"0.3.0"}\n' } })), 'other');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST.replace('0.4.0', '0.4.1') } })), 'other', 'one character off');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': `${RUNNING_MANIFEST}\n` } })), 'other', 'one byte more');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST.trimEnd() } })), 'other', 'one byte less');
  assert.equal(await relation(createFakeFolder({ files: { 'other.json': RUNNING_MANIFEST } })), 'other', 'no manifest.json in the folder');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json/inner': 'x' } })), 'other', 'manifest.json is a folder');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST }, permission: 'prompt' })), 'other', 'a folder that can not be read');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST } }), null, null), 'other', 'nothing to compare with');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST } }), null, enc(RUNNING_MANIFEST)), 'target', 'only the target is known');
  assert.equal(await relation(createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST } }), enc(RUNNING_MANIFEST), enc(RUNNING_MANIFEST)), 'running', 'running wins over target');
  assert.equal(await folderRelation({ dir: null, runningManifestBytes: enc(RUNNING_MANIFEST) }), 'other');
  assert.equal(await folderRelation({ dir: {}, runningManifestBytes: enc(RUNNING_MANIFEST) }), 'other');
  assert.equal(await folderRelation(), 'other');
  const huge = createFakeFolder({ files: { 'manifest.json': new Uint8Array(SELF_UPDATE_LIMITS.maxFileBytes + 1) } });
  assert.equal(await relation(huge, new Uint8Array(SELF_UPDATE_LIMITS.maxFileBytes + 1)), 'other', 'a huge manifest.json is not read');
  const folder = createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST } });
  await relation(folder);
  assert.ok(folder.untouched, 'reading changes nothing');
});

// ---------------------------------------------------------------------------------------------------------------------
// Applying.

const OLD_FILES = Object.freeze({
  'manifest.json': RUNNING_MANIFEST, 'extension/lib/a.js': 'export const a = 1;\n', 'extension/lib/old.js': 'export const old = 1;\n',
  'extension/panel/panel.html': '<!doctype html><!-- old -->\n', 'user-notes.txt': 'mine',
});
async function ready({ files = TREE_FILES, folderFiles = OLD_FILES, folderOptions = {} } = {}) {
  const tree = makeTree(files);
  const manifest = await verified(tree);
  const folder = createFakeFolder({ files: folderFiles, ...folderOptions });
  return { tree, manifest, folder, files: tree.files, expected: new Map([...tree.files].map(([path, bytes]) => [path, dec(bytes)])) };
}
// The tree the previous apply wrote (user-notes.txt is the person's own file, not part of it).
const PREVIOUS = Object.freeze(['manifest.json', 'extension/lib/a.js', 'extension/lib/old.js', 'extension/panel/panel.html']);
const textOf = (folder) => new Map([...folder.snapshot()].map(([path, bytes]) => [path, dec(bytes)]));

test('applyUpdate writes every file with manifest.json last, creates sub-folders, and removes only obsolete files of the previous apply', async () => {
  const { manifest, folder, files, expected } = await ready();
  const progress = [];
  const result = await applyUpdate({
    dir: folder.handle, manifest, files, onProgress: (info) => progress.push(info),
    previousPaths: PREVIOUS,
  });
  assert.equal(folder.commits.at(-1), 'manifest.json', 'manifest.json is committed last');
  assert.equal(folder.commits.filter((path) => path === 'manifest.json').length, 1);
  assert.deepEqual([...folder.commits].sort(), [...files.keys()].sort(), 'every signed file was committed once');
  assert.deepEqual(result.written, folder.commits, 'written lists the commits, in order');
  assert.deepEqual(result.removed, ['extension/lib/old.js']);
  assert.deepEqual(folder.removed, ['extension/lib/old.js']);
  assert.deepEqual(textOf(folder), new Map([...expected, ['user-notes.txt', 'mine']].sort(([a], [b]) => (a < b ? -1 : 1))), 'the new tree, and the file nobody listed is untouched');
  const lines = folder.log.map((item) => `${item.op}:${item.path}`);
  const removeAt = lines.indexOf('remove:extension/lib/old.js');
  const lastOtherCommit = Math.max(...lines.map((line, index) => (line.startsWith('commit:') && line !== 'commit:manifest.json' ? index : -1)));
  assert.ok(removeAt > lastOtherCommit, 'obsolete files go after the other files');
  assert.ok(removeAt < lines.indexOf('commit:manifest.json'), 'and before manifest.json');
  assert.deepEqual(progress.map((info) => info.done), [1, 2, 3, 4, 5]);
  assert.equal(progress.at(-1).path, 'manifest.json');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.written) && Object.isFrozen(result.removed));
  assert.ok(folder.directories().includes('_locales/en') && folder.directories().includes('icons'));
});

test('applyUpdate with no previous list deletes nothing (the first version of the updater has none)', async () => {
  const { manifest, folder, files } = await ready();
  for (const previousPaths of [undefined, [], null, 'extension/lib/old.js', {}]) {
    const fresh = createFakeFolder({ files: OLD_FILES });
    const result = await applyUpdate({ dir: fresh.handle, manifest, files, previousPaths });
    assert.deepEqual(result.removed, [], String(previousPaths));
    assert.ok(fresh.exists('extension/lib/old.js') && fresh.exists('user-notes.txt'));
  }
  assert.deepEqual((await applyUpdate({ dir: folder.handle, manifest, files })).removed, []);
});

test('applyUpdate never removes manifest.json, anything outside the previous list, a path that is not safe, or a file the new tree writes (any case)', async () => {
  const { manifest, files } = await ready();
  const evil = ['manifest.json', 'Manifest.JSON', '../outside.txt', '/etc/hosts', 'a\\b', '_metadata/x', 'not/there/at/all.js', 5, null, 'extension/panel/panel.html', 'extension/lib/old.js'];
  const folder = createFakeFolder({ files: { ...OLD_FILES, 'unlisted.txt': 'not in any list' } });
  const result = await applyUpdate({ dir: folder.handle, manifest, files, previousPaths: evil });
  assert.deepEqual(result.removed, ['extension/lib/old.js'], 'only listed, safe paths that the new tree does not write');
  assert.ok(!folder.exists('extension/lib/old.js'));
  assert.equal(folder.text('unlisted.txt'), 'not in any list', 'a file nobody listed stays, even though the new tree does not have it');
  assert.equal(folder.text('user-notes.txt'), 'mine');
  assert.equal(folder.text('manifest.json'), TARGET_MANIFEST, 'manifest.json is the new one');
  assert.equal(folder.text('extension/panel/panel.html'), '<!doctype html>\n', 'a listed path the new tree writes is rewritten, not removed');
  // A disk that ignores case: the previous list spells a path the new tree also writes in another case.
  const insensitive = createFakeFolder({ files: { ...OLD_FILES, 'Extension/Lib/A.js': 'old a' }, caseInsensitive: true });
  const again = await applyUpdate({ dir: insensitive.handle, manifest, files, previousPaths: ['Extension/Lib/A.js', 'EXTENSION/LIB/OLD.JS'] });
  assert.equal(insensitive.text('extension/lib/a.js'), 'export const a = 2;\n', 'the file the new tree writes is still there');
  assert.deepEqual(again.removed, ['EXTENSION/LIB/OLD.JS'], 'the real obsolete file is found whatever the case');
  assert.ok(!insensitive.exists('extension/lib/old.js'));
});

test('applyUpdate refuses an inconsistent request before it writes anything', async () => {
  const { manifest, folder, files } = await ready();
  const missing = new Map(files);
  missing.delete('extension/lib/a.js');
  const extra = new Map(files);
  extra.set('extension/lib/extra.js', enc('x'));
  const swapped = new Map(files);
  swapped.set('extension/lib/a.js', enc('export const a = 22;\n'));
  const empty = new Map(files);
  empty.set('extension/lib/a.js', new Uint8Array(0));
  const notBytes = new Map(files);
  notBytes.set('extension/lib/a.js', 'text');
  const cases = [
    ['a file missing', { manifest, files: missing }, 'UPDATE_BAD_MANIFEST'], ['a file too many', { manifest, files: extra }, 'UPDATE_BAD_MANIFEST'],
    ['not a Map', { manifest, files: Object.fromEntries(files) }, 'UPDATE_BAD_MANIFEST'], ['no files', { manifest }, 'UPDATE_BAD_MANIFEST'],
    ['a file of another size', { manifest, files: swapped }, 'UPDATE_BAD_HASH'], ['an empty file', { manifest, files: empty }, 'UPDATE_BAD_HASH'],
    ['bytes that are text', { manifest, files: notBytes }, 'UPDATE_BAD_MANIFEST'],
    ['no manifest', { files }, 'UPDATE_BAD_MANIFEST'],
    ['a manifest with an unsafe path', { manifest: { ...manifest, files: [...manifest.files, entry('../x.js', 'x')] }, files }, 'UPDATE_UNSAFE_PATH'],
    ['a manifest with a path twice', { manifest: { ...manifest, files: [...manifest.files, manifest.files[1]] }, files }, 'UPDATE_UNSAFE_PATH'],
    ['a manifest without manifest.json', { manifest: { ...manifest, files: manifest.files.filter((file) => file.path !== 'manifest.json') }, files }, 'UPDATE_BAD_MANIFEST'],
    ['a manifest of a version nobody can read', { manifest: { ...manifest, version: 'x' }, files }, 'UPDATE_BAD_MANIFEST'],
  ];
  for (const [name, request, code] of cases) {
    assert.equal(await codeOf(applyUpdate({ dir: folder.handle, ...request })), code, name);
    assert.ok(folder.untouched, `${name}: nothing was written`);
  }
  assert.equal(await codeOf(applyUpdate({ manifest, files })), 'UPDATE_WRITE_FAILED', 'no folder');
  assert.equal(await codeOf(applyUpdate({ dir: {}, manifest, files })), 'UPDATE_WRITE_FAILED', 'not a folder');
  assert.equal(await codeOf(applyUpdate()), 'UPDATE_BAD_MANIFEST');
});

test('applyUpdate: an interrupted apply leaves the old manifest.json, and running it again finishes with the same bytes', async () => {
  const { manifest, folder, files, expected } = await ready();
  const previousPaths = [...PREVIOUS];
  folder.failAfterCommits(2);
  const error = await applyUpdate({ dir: folder.handle, manifest, files, previousPaths }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, 'UPDATE_WRITE_FAILED');
  assert.ok(error.cause instanceof Error && error.cause.name === 'NoModificationAllowedError', 'the platform error is kept as the cause');
  assert.equal(folder.text('manifest.json'), RUNNING_MANIFEST, 'manifest.json was not reached: the folder still says "not applied"');
  assert.equal(folder.commits.length, 2);
  assert.ok(folder.exists('extension/lib/old.js'), 'obsolete files are removed only after every file is written');
  folder.clearFailures();
  const retry = await applyUpdate({ dir: folder.handle, manifest, files, previousPaths });
  assert.equal(retry.written.at(-1), 'manifest.json');
  assert.deepEqual(retry.removed, ['extension/lib/old.js']);
  assert.deepEqual(textOf(folder), new Map([...expected, ['user-notes.txt', 'mine']].sort(([a], [b]) => (a < b ? -1 : 1))));
  const clean = createFakeFolder({ files: OLD_FILES });
  await applyUpdate({ dir: clean.handle, manifest, files, previousPaths });
  assert.deepEqual(folder.snapshot(), clean.snapshot(), 'the retry ends exactly where an uninterrupted apply ends');
  const snapshot = folder.snapshot();
  await applyUpdate({ dir: folder.handle, manifest, files, previousPaths });
  assert.deepEqual(folder.snapshot(), snapshot, 'applying twice is the same as applying once');
});

test('applyUpdate: a locked file, a failing write, a failing close or a lost permission is UPDATE_WRITE_FAILED and manifest.json stays old', async () => {
  const scenarios = [
    ['a locked file (Windows)', (folder) => folder.lock('extension/lib/a.js')],
    ['a file that fails to open', (folder) => folder.inject('extension/panel/panel.html', 'open')],
    ['a failing write', (folder) => folder.inject('_locales/en/messages.json', 'write')],
    ['a failing close', (folder) => folder.inject('icons/icon 16.png', 'close')],
    ['a permission that is gone', (folder) => { folder.permission = 'prompt'; }],
    ['a permission that was denied', (folder) => { folder.permission = 'denied'; }],
  ];
  for (const [name, break_] of scenarios) {
    const { manifest, folder, files } = await ready();
    break_(folder);
    const error = await applyUpdate({ dir: folder.handle, manifest, files, previousPaths: PREVIOUS }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, 'UPDATE_WRITE_FAILED', name);
    assert.ok(error.cause, `${name}: the cause is kept`);
    folder.permission = 'granted';
    assert.equal(folder.text('manifest.json'), RUNNING_MANIFEST, `${name}: manifest.json is still the old one`);
    assert.ok(folder.exists('extension/lib/old.js'), `${name}: nothing was deleted`);
    assert.ok(!folder.commits.includes('manifest.json'), name);
  }
  // A failed write is aborted, not committed: the file keeps its previous bytes, and a writer that is still open is aborted.
  for (const phase of ['write', 'close']) {
    const { manifest, folder, files } = await ready();
    folder.inject('extension/lib/a.js', phase);
    await codeOf(applyUpdate({ dir: folder.handle, manifest, files }));
    assert.equal(folder.text('extension/lib/a.js'), 'export const a = 1;\n', `${phase}: the old bytes stay`);
    assert.ok(folder.log.some((item) => item.op === 'abort' && item.path === 'extension/lib/a.js'), `${phase}: the writer was aborted`);
    assert.ok(!folder.commits.includes('extension/lib/a.js'), `${phase}: not committed`);
  }
  // A write that fails first stops everything after it.
  const stopped = await ready();
  stopped.folder.inject('extension/lib/a.js', 'open');
  await codeOf(applyUpdate({ dir: stopped.folder.handle, manifest: stopped.manifest, files: stopped.files }));
  assert.deepEqual(stopped.folder.commits, ['_locales/en/messages.json'], 'nothing after the failed file was written');
});

test('applyUpdate: an obsolete file that can not be deleted does not fail the update', async () => {
  const { manifest, folder, files } = await ready();
  folder.lock('extension/lib/old.js');
  const result = await applyUpdate({ dir: folder.handle, manifest, files, previousPaths: ['extension/lib/old.js'] });
  assert.deepEqual(result.removed, []);
  assert.ok(folder.exists('extension/lib/old.js'));
  assert.equal(folder.text('manifest.json'), TARGET_MANIFEST);
  const other = await ready();
  other.folder.inject('extension/lib/old.js', 'remove');
  assert.deepEqual((await applyUpdate({ dir: other.folder.handle, manifest: other.manifest, files: other.files, previousPaths: ['extension/lib/old.js'] })).removed, []);
});

test('applyUpdate: a name that is already a file where a folder is needed fails the write, never the folder around it', async () => {
  const { manifest, folder, files } = await ready({ folderFiles: { ...OLD_FILES, _locales: 'a file called _locales' } });
  assert.equal(await codeOf(applyUpdate({ dir: folder.handle, manifest, files })), 'UPDATE_WRITE_FAILED');
  assert.equal(folder.text('manifest.json'), RUNNING_MANIFEST);
});

// ---------------------------------------------------------------------------------------------------------------------
// Node signs, the extension verifies (the release script's round trip).

test('interop: a manifest signed by the release script is verified by the extension with WebCrypto, end to end, and not by a Node-default (DER) signature', async () => {
  const tree = makeTree();
  assert.equal(nodeVerifyUpdateManifest(tree.manifestBytes, tree.signature, primary.publicB64), true, 'the script verifies its own signature');
  assert.equal(publicKeyOf(primary.privatePem), primary.publicB64);
  const manifest = await verified(tree);
  const site = createFakeSite({ latest: '0.5.0', trees: [tree] });
  const downloaded = await downloadUpdate({ manifest, subtle, fetchBytes: site.fetchBytes });
  const folder = createFakeFolder({ files: OLD_FILES });
  await applyUpdate({ dir: folder.handle, manifest, files: downloaded });
  assert.equal(folder.text('manifest.json'), TARGET_MANIFEST);
  const der = nodeSign('sha256', tree.manifestBytes, { key: primary.privatePem }).toString('base64');
  assert.equal(await codeOf(verifyOf({ manifestBytes: tree.manifestBytes, signature: der })), 'UPDATE_BAD_SIGNATURE');
  // Whatever order the keys come in, and with a signature made by the second key.
  const backupTree = buildSignedTree({ version: '0.5.0', files: TREE_FILES, privatePem: backup.privatePem });
  assert.equal((await verifyOf({ manifestBytes: backupTree.manifestBytes, signature: backupTree.signature }, [backup.publicB64, primary.publicB64])).version, '0.5.0');
});

test('the public keys built into the extension are two different, importable ECDSA P-256 keys (no private key is read here)', async () => {
  assert.equal(UPDATE_PUBLIC_KEYS.length, 2);
  assert.notEqual(UPDATE_PUBLIC_KEYS[0], UPDATE_PUBLIC_KEYS[1]);
  assert.ok(Object.isFrozen(UPDATE_PUBLIC_KEYS));
  for (const key of UPDATE_PUBLIC_KEYS) {
    const imported = await subtle.importKey('spki', Buffer.from(key, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    assert.equal(imported.algorithm.namedCurve, 'P-256');
  }
  // A signature by a throw-away key is not accepted under the real keys.
  assert.equal(await codeOf(verifyUpdateManifest({ ...signText(goodManifest()), publicKeys: UPDATE_PUBLIC_KEYS, subtle })), 'UPDATE_BAD_SIGNATURE');
});

test('the real built extension: every file passes the path and size rules, and the whole tree downloads, verifies and applies byte for byte', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'interp-self-update-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(parent, 'package.json'), '{"type":"module"}\n');
  const out = join(parent, 'extension');
  const built = await buildExtension({ root: repoRoot, out });
  const files = {};
  for (const path of built.files) files[path] = await readFile(join(out, ...path.split('/')));
  assert.ok(Object.keys(files).length > 40 && Object.keys(files).length <= SELF_UPDATE_LIMITS.maxFiles, `${Object.keys(files).length} files`);
  for (const [path, bytes] of Object.entries(files)) {
    assert.equal(isSafeUpdatePath(path), true, `${path} is a safe update path`);
    assert.ok(bytes.length <= SELF_UPDATE_LIMITS.maxFileBytes, `${path} is within the file limit`);
  }
  const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
  assert.ok(total <= SELF_UPDATE_LIMITS.maxTotalBytes, `${total} bytes in total`);
  const tree = buildSignedTree({ version: built.version, files, privatePem: primary.privatePem });
  assert.ok(tree.manifestBytes.length < SELF_UPDATE_LIMITS.maxManifestBytes);
  const manifest = await verifyOf({ manifestBytes: tree.manifestBytes, signature: tree.signature });
  const site = createFakeSite({ latest: built.version, trees: [tree] });
  const downloaded = await downloadUpdate({ manifest, subtle, fetchBytes: site.fetchBytes });
  const folder = createFakeFolder({ files: { 'manifest.json': RUNNING_MANIFEST } });
  await applyUpdate({ dir: folder.handle, manifest, files: downloaded });
  assert.deepEqual([...folder.snapshot().keys()], Object.keys(files).sort());
  for (const [path, bytes] of folder.snapshot()) assert.deepEqual(Buffer.from(bytes), files[path], path);
  assert.equal(folder.commits.at(-1), 'manifest.json');
});

// ---------------------------------------------------------------------------------------------------------------------
// Hygiene.

const MODULES = ['self-update', 'update-store', 'update-state', 'update-run', 'update-check'].map((name) => `extension/lib/${name}.js`);
// Comments and single-quoted strings blanked (the modules have no regexp literal holding a quote or a double slash).
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n]*$/gm, '$1')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");

test('hygiene: no self-update module names a platform global, and only update-store.js names indexedDB', async () => {
  const platform = ['chrome', 'browser', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'AudioContext', 'setTimeout',
    'setInterval', 'clearTimeout', 'clearInterval', 'TextDecoder', 'TextEncoder', 'atob', 'btoa', 'crypto', 'showDirectoryPicker', 'globalThis', 'self', 'importScripts', 'process', 'require'];
  for (const path of MODULES) {
    const source = await readFile(join(repoRoot, path), 'utf8');
    const code = codeOnly(source);
    assert.equal(/\bindexedDB\b/.test(code), path === 'extension/lib/update-store.js', `${path}: indexedDB`);
    if (path !== 'extension/lib/update-store.js') assert.equal(/indexeddb/i.test(source), false, `${path}: the word does not appear even in a comment`);
    for (const name of platform) assert.equal(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code), false, `${path} names ${name}`);
    // fetch is only ever the injected parameter, never a global call.
    assert.equal(/(?<![\w$.])fetch\s*\(/.test(code), false, `${path}: a bare fetch( call`);
  }
});

test('hygiene: importing each self-update module touches no platform global at import time', async () => {
  const names = ['chrome', 'browser', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'indexedDB', 'AudioContext', 'fetch', 'crypto',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'TextDecoder', 'TextEncoder', 'atob', 'btoa', 'URL', 'Response'];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, get() { throw new Error(`touched ${name}`); }, set() { throw new Error(`assigned ${name}`); } });
  }
  const failures = [];
  try {
    for (const path of MODULES) {
      // A fresh URL evaluates the module's own top level again (its imports are already cached and pure).
      try { await import(`${pathToFileURL(join(repoRoot, path)).href}?hygiene=${Date.now()}`); } catch (error) { failures.push(`${path}: ${error.message}`); }
    }
  } finally {
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
  assert.deepEqual(failures, []);
  for (const name of names) assert.doesNotThrow(() => globalThis[name], `${name} is readable again`);
});
