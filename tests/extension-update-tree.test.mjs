import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import { access, constants, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { OUTPUT_MARKER } from '../scripts/build-extension.mjs';
import {
  EXTENSION_FOLDER, MANUALS, SITE_ICONS, buildUpdateTree, collectUpdateFiles, createUpdateSigner, diffPaths, latestJson,
  packageExtension, parseArguments, runCli, unsafeUpdatePaths, updateManifestText, verifyUpdateTree, vercelConfig,
} from '../scripts/package-extension.mjs';
import { DEFAULT_UPDATE_KEY_FILE, generateUpdateKeyPair, verifyUpdateManifest as verifyWithNode } from '../scripts/update-signing.mjs';
import { SELF_UPDATE_LIMITS, UPDATE_FORMAT, verifyUpdateManifest as verifyWithExtension } from '../extension/lib/self-update.js';
import { UPDATE_PUBLIC_KEYS } from '../extension/lib/update-keys.js';

// docs/extension.md §21, release side: the signed update tree that scripts/package-extension.mjs writes into
// dist/extension-site/update/<version>/. Everything runs on FIXTURE folders in os.tmpdir() with a throw-away signing
// key that the test generates and injects (the owner's real keys in ~/.config/interp-app/ are never read). No browser,
// no network, no sound: packageExtension is driven with its two test hooks (a fake keyed build, fake manual PDFs). The
// script itself still runs the system zip/unzip to make and list the zip; this file spawns nothing and reads the zip
// with a small central-directory reader of its own.

const VERSION = '0.5.0';
const RELEASED = '2026-10-08';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const flip = (bytes, index) => { const copy = Buffer.from(bytes); copy[index] ^= 0x01; return copy; };
const pemBody = (pem) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

async function tempDir(t, prefix = 'interp-updtree-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** Every file under root as a POSIX relative path, sorted. */
async function listAll(root) {
  const paths = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else paths.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  await walk(root);
  return paths.sort();
}

/** A fake builtin key assembled at runtime (no key-shaped literal in the source). */
const FAKE_BUILTIN_KEY = ['AI', 'za', 'Sy', 'X'.repeat(35)].join('');

/** The keyed LiveInterpreter folder in miniature: what the build leaves in dist/extension-package/LiveInterpreter. */
function keyedFiles(version = VERSION) {
  const binary = Buffer.alloc(300);
  for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256;
  return {
    'manifest.json': `${JSON.stringify({ manifest_version: 3, name: '__MSG_extName__', version }, null, 2)}\n`,
    'extension/lib/builtin-key.js': `export const BUILTIN_KEYS = Object.freeze(['${FAKE_BUILTIN_KEY}']);\n`,
    'extension/panel/panel.html': '<!doctype html><title>Panel</title>\n',
    'extension/panel/panel.js': 'export const panel = 1;\n',
    '_locales/ko/messages.json': '{"extName":{"message":"실시간 통역"}}\n',
    'extension/i18n/ja.json': '{"hello":"こんにちは"}\n',
    'app/name with space.json': '{}\n',
    'icons/icon-16.png': binary,
    'icons/icon-32.png': binary,
    'icons/icon-48.png': binary,
    'icons/icon-128.png': binary,
    'styles.css': 'body { margin: 0; }\n',
  };
}

/** Dotfiles the tree must leave out. The zip step leaves out the first three as well (-x '*.DS_Store' and the build marker). */
const ZIP_EXCLUDED_DOT_FILES = Object.freeze({
  [OUTPUT_MARKER]: 'interp-extension-build/1\n',
  '.DS_Store': 'junk',
  'extension/.DS_Store': 'junk',
});
const OTHER_DOT_FILES = Object.freeze({ '.hidden/secret.js': 'export const hidden = 1;\n', 'extension/.env': 'SECRET=1\n' });

/** `dot`: 'zip' = only what the real zip excludes (the package run), 'all' = more dotfiles besides (the tree alone must still skip them). */
async function writeKeyedFolder(folder, { version = VERSION, dot = 'all', extra = {} } = {}) {
  const files = { ...keyedFiles(version), ...extra };
  for (const [path, content] of Object.entries(files)) await put(folder, path, content);
  for (const [path, content] of Object.entries({ ...ZIP_EXCLUDED_DOT_FILES, ...(dot === 'all' ? OTHER_DOT_FILES : {}) })) await put(folder, path, content);
  return files;
}

async function throwAway(t) {
  const dir = await tempDir(t, 'interp-updkey-');
  const pair = generateUpdateKeyPair();
  const keyFile = join(dir, 'update-signing.pem');
  await writeFile(keyFile, pair.privatePem, { mode: 0o600 });
  const publicKeys = [pair.publicB64];
  const signer = await createUpdateSigner({ keyFile, publicKeys });
  return { ...pair, keyFile, publicKeys, signer };
}

async function fixture(t, options) {
  const root = await tempDir(t);
  const extensionDir = join(root, 'LiveInterpreter');
  const siteDir = join(root, 'site');
  await mkdir(siteDir, { recursive: true });
  const files = await writeKeyedFolder(extensionDir, options);
  return { root, extensionDir, siteDir, files, key: await throwAway(t) };
}

async function build(fix, overrides = {}) {
  return buildUpdateTree({
    extensionDir: fix.extensionDir, siteDir: fix.siteDir, version: VERSION, released: RELEASED,
    signer: fix.key.signer, publicKeys: fix.key.publicKeys, ...overrides,
  });
}

const verifyOnDisk = async (treeDir, publicKeys) => {
  const manifestBytes = new Uint8Array(await readFile(join(treeDir, 'manifest.json')));
  const signature = (await readFile(join(treeDir, 'manifest.sig'), 'utf8')).trim();
  return verifyWithExtension({ manifestBytes, signature, publicKeys, subtle: webcrypto.subtle });
};

const plainFiles = (files) => Object.keys(files).sort();
const byteLength = (content) => Buffer.byteLength(content);

// --- the tree -------------------------------------------------------------------------------------------------------

test('tree: manifest.json, manifest.sig and files/** under update/<version>/, the extension verifier accepts them', async (t) => {
  const fix = await fixture(t);
  const result = await build(fix);
  const treeDir = join(fix.siteDir, 'update', VERSION);
  assert.equal(result.dir, treeDir);
  assert.equal(result.version, VERSION);
  const expected = plainFiles(fix.files);
  assert.equal(result.files, expected.length);
  assert.equal(result.bytes, Object.values(fix.files).reduce((sum, content) => sum + byteLength(content), 0));
  assert.deepEqual([...result.paths], expected);

  const onDisk = await listAll(treeDir);
  assert.deepEqual(onDisk, ['manifest.json', 'manifest.sig', ...expected.map((path) => `files/${path}`)].sort());

  const manifest = await verifyOnDisk(treeDir, fix.key.publicKeys);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.format, UPDATE_FORMAT);
  assert.equal(manifest.released, RELEASED);
  assert.deepEqual(manifest.files.map((file) => file.path), expected, 'sorted by path, every file once');
  for (const file of manifest.files) {
    const bytes = await readFile(join(treeDir, 'files', ...file.path.split('/')));
    assert.equal(file.size, bytes.length, file.path);
    assert.equal(file.sha256, sha256(bytes), file.path);
    assert.equal(Buffer.compare(bytes, Buffer.from(fix.files[file.path])), 0, `${file.path} is byte-identical to the source`);
  }
  // The manifest the extension itself ships is one of the listed files and is NOT the signed manifest.
  assert.ok(manifest.files.some((file) => file.path === 'manifest.json'));
  assert.notEqual(await readFile(join(treeDir, 'manifest.json'), 'utf8'), await readFile(join(treeDir, 'files', 'manifest.json'), 'utf8'));

  // A second, independent verifier (Node's own, not the extension's) and the raw WebCrypto primitive agree.
  const manifestBytes = await readFile(join(treeDir, 'manifest.json'));
  const signature = await readFile(join(treeDir, 'manifest.sig'), 'utf8');
  assert.equal(verifyWithNode(manifestBytes, signature.trim(), fix.key.publicB64), true);
  const key = await webcrypto.subtle.importKey('spki', Buffer.from(fix.key.publicB64, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature.trim(), 'base64'), manifestBytes), true);
  assert.equal(Buffer.from(signature.trim(), 'base64').length, 64, 'raw r||s');
});

test('tree: the signed manifest is 2-space JSON with a trailing newline, fields in the contract order, files sorted', async (t) => {
  const fix = await fixture(t);
  await build(fix);
  const text = await readFile(join(fix.siteDir, 'update', VERSION, 'manifest.json'), 'utf8');
  assert.equal(text.endsWith('}\n'), true);
  assert.equal(text.endsWith('\n\n'), false);
  assert.equal(text.includes('\r'), false);
  assert.ok(text.startsWith(`{\n  "format": 1,\n  "version": "${VERSION}",\n  "released": "${RELEASED}",\n  "files": [\n    {\n      "path": "`), text.slice(0, 120));
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['format', 'version', 'released', 'files']);
  for (const file of parsed.files) {
    assert.deepEqual(Object.keys(file), ['path', 'size', 'sha256']);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(Number.isInteger(file.size) && file.size >= 0, true);
  }
  const paths = parsed.files.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : 1)));
  assert.equal(text, JSON.stringify(parsed, null, 2) + '\n', 'canonical re-serialization is the same text');
  assert.equal(text, updateManifestText({ version: VERSION, released: RELEASED, files: [...parsed.files].reverse() }), 'the writer sorts, whatever the input order');
  assert.ok(Buffer.byteLength(text) <= SELF_UPDATE_LIMITS.maxManifestBytes);
});

test('tree: dotfiles, dot-folders and the build marker stay out; everything else, spaces and binary bytes included, goes in', async (t) => {
  const fix = await fixture(t);
  const result = await build(fix);
  const treeFiles = await listAll(join(fix.siteDir, 'update', VERSION, 'files'));
  assert.equal(treeFiles.some((path) => path.split('/').some((part) => part.startsWith('.'))), false);
  assert.equal(treeFiles.includes(OUTPUT_MARKER), false);
  assert.equal(treeFiles.includes('app/name with space.json'), true);
  assert.equal(treeFiles.includes('icons/icon-48.png'), true);
  assert.equal(result.files, treeFiles.length);
  const listed = (await collectUpdateFiles(fix.extensionDir)).map((file) => file.path);
  assert.deepEqual(listed, plainFiles(fix.files));
});

test('tree: the file set is what the zip step carries (dotfiles other than the zip exclusions are a mismatch, reported both ways)', () => {
  assert.deepEqual(diffPaths(['a', 'b'], ['b', 'a']), []);
  assert.deepEqual(diffPaths(['a', 'b'], ['a', 'b', '.gitkeep']), ['ZIP_ONLY .gitkeep']);
  assert.deepEqual(diffPaths(['a', 'b', 'c'], ['a']), ['TREE_ONLY b', 'TREE_ONLY c']);
  assert.deepEqual(diffPaths(['é'], ['é']), []);
  assert.deepEqual(diffPaths([], ['x\u001b[2Jy']), ['ZIP_ONLY x?[2Jy'], 'control characters never reach the terminal');
});

test('tree: replaces its own version folder as a whole, leaves other versions alone, and a rerun lists no stale file', async (t) => {
  const fix = await fixture(t);
  await put(fix.siteDir, 'update/0.4.0/manifest.json', 'older release');
  await put(fix.siteDir, `update/${VERSION}/files/extension/stale.js`, 'left over from an earlier run');
  await put(fix.siteDir, `update/${VERSION}/other.txt`, 'left over');
  await build(fix);
  const treeDir = join(fix.siteDir, 'update', VERSION);
  assert.equal(await exists(join(treeDir, 'files', 'extension', 'stale.js')), false);
  assert.equal(await exists(join(treeDir, 'other.txt')), false);
  assert.equal(await readFile(join(fix.siteDir, 'update', '0.4.0', 'manifest.json'), 'utf8'), 'older release');
  const again = await build(fix);
  assert.equal(again.files, plainFiles(fix.files).length);
  await verifyOnDisk(treeDir, fix.key.publicKeys);
});

// --- tampering ------------------------------------------------------------------------------------------------------

test('tamper: flipping ANY byte of manifest.json or of manifest.sig makes the extension verifier refuse the tree', async (t) => {
  const fix = await fixture(t);
  await build(fix);
  const treeDir = join(fix.siteDir, 'update', VERSION);
  const manifestBytes = await readFile(join(treeDir, 'manifest.json'));
  const signature = (await readFile(join(treeDir, 'manifest.sig'), 'utf8')).trim();
  const subtle = webcrypto.subtle;
  const publicKeys = fix.key.publicKeys;
  await verifyWithExtension({ manifestBytes: new Uint8Array(manifestBytes), signature, publicKeys, subtle });
  for (let index = 0; index < manifestBytes.length; index += 1) {
    await assert.rejects(verifyWithExtension({ manifestBytes: new Uint8Array(flip(manifestBytes, index)), signature, publicKeys, subtle }), (error) => typeof error.code === 'string', `manifest byte ${index}`);
  }
  const raw = Buffer.from(signature, 'base64');
  for (let index = 0; index < raw.length; index += 1) {
    await assert.rejects(verifyWithExtension({ manifestBytes: new Uint8Array(manifestBytes), signature: flip(raw, index).toString('base64'), publicKeys, subtle }), (error) => typeof error.code === 'string', `signature byte ${index}`);
  }
  // A signature made by a different key is refused as well: only the listed public keys count.
  const other = generateUpdateKeyPair();
  await assert.rejects(verifyWithExtension({ manifestBytes: new Uint8Array(manifestBytes), signature, publicKeys: [other.publicB64], subtle }), (error) => typeof error.code === 'string');
});

test('tamper: a changed, shortened, removed or extra file in files/ fails the check of the written tree', async (t) => {
  const fix = await fixture(t);
  await build(fix);
  const treeDir = join(fix.siteDir, 'update', VERSION);
  const options = { version: VERSION, publicKeys: fix.key.publicKeys };
  assert.deepEqual({ ...(await verifyUpdateTree(treeDir, options)) }, { files: plainFiles(fix.files).length, bytes: Object.values(fix.files).reduce((sum, content) => sum + byteLength(content), 0) });
  const problemsOf = async () => {
    try { await verifyUpdateTree(treeDir, options); } catch (error) { assert.equal(error.code, 'PACKAGE_UPDATE_TREE_INVALID'); return error.detail.problems; }
    return null;
  };
  // one small file, EVERY byte
  const small = join(treeDir, 'files', 'styles.css');
  const smallBytes = await readFile(small);
  for (let index = 0; index < smallBytes.length; index += 1) {
    await writeFile(small, flip(smallBytes, index));
    assert.deepEqual(await problemsOf(), ['HASH styles.css'], `styles.css byte ${index}`);
  }
  await writeFile(small, smallBytes);
  assert.equal(await problemsOf(), null);
  // every file, first / middle / last byte
  for (const path of plainFiles(fix.files)) {
    const target = join(treeDir, 'files', ...path.split('/'));
    const original = await readFile(target);
    for (const index of new Set([0, Math.floor(original.length / 2), original.length - 1])) {
      await writeFile(target, flip(original, index));
      assert.deepEqual(await problemsOf(), [`HASH ${path}`], `${path} byte ${index}`);
    }
    await writeFile(target, original.subarray(0, original.length - 1));
    assert.deepEqual(await problemsOf(), [`SIZE ${path}`], `${path} shortened`);
    await writeFile(target, Buffer.concat([original, Buffer.from('x')]));
    assert.deepEqual(await problemsOf(), [`SIZE ${path}`], `${path} lengthened`);
    await rm(target);
    assert.deepEqual(await problemsOf(), [`MISSING ${path}`], `${path} removed`);
    await writeFile(target, original);
    assert.equal(await problemsOf(), null, `${path} restored`);
  }
  await put(treeDir, 'files/extension/extra.js', 'not listed');
  assert.deepEqual(await problemsOf(), ['UNLISTED extension/extra.js']);
  await rm(join(treeDir, 'files', 'extension', 'extra.js'));
  // The signature itself, through the same entry point.
  const manifestPath = join(treeDir, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  await writeFile(manifestPath, flip(manifestBytes, 10));
  assert.deepEqual((await problemsOf())?.[0]?.startsWith('MANIFEST '), true);
  await writeFile(manifestPath, manifestBytes);
  await rm(join(treeDir, 'manifest.sig'));
  assert.deepEqual((await problemsOf())?.[0]?.startsWith('MANIFEST '), true);
});

test('tamper: a signer whose key the extension does not trust, or one that returns junk, leaves no deployable tree behind', async (t) => {
  const fix = await fixture(t);
  const stranger = generateUpdateKeyPair();
  const strangerFile = join(await tempDir(t, 'interp-updkey-'), 'stranger.pem');
  await writeFile(strangerFile, stranger.privatePem);
  const strangerSigner = await createUpdateSigner({ keyFile: strangerFile, publicKeys: [stranger.publicB64] });
  const treeDir = join(fix.siteDir, 'update', VERSION);
  // Signed with a real key, but the extension is only told about the throw-away one.
  await assert.rejects(build(fix, { signer: strangerSigner }), (error) => error.code === 'PACKAGE_UPDATE_TREE_INVALID' && error.detail.problems[0].startsWith('MANIFEST '));
  assert.equal(await exists(treeDir), false, 'a tree that fails its own check is removed');
  for (const sign of [() => 'AAAA', () => '', () => Buffer.alloc(64).toString('base64')]) {
    await assert.rejects(build(fix, { signer: { sign } }), { code: 'PACKAGE_UPDATE_TREE_INVALID' });
    assert.equal(await exists(treeDir), false);
  }
});

// --- keys ------------------------------------------------------------------------------------------------------------

test('key: a missing file is PACKAGE_UPDATE_KEY_MISSING; unusable material is PACKAGE_UPDATE_KEY_INVALID; an untrusted public key is PACKAGE_UPDATE_KEY_UNKNOWN', async (t) => {
  const dir = await tempDir(t, 'interp-updkey-');
  const good = generateUpdateKeyPair();
  const write = async (name, content) => { await writeFile(join(dir, name), content); return join(dir, name); };
  const publicKeys = [good.publicB64];
  const code = async (keyFile, keys = publicKeys) => {
    try { await createUpdateSigner({ keyFile, publicKeys: keys }); } catch (error) {
      assert.equal(error.message, error.code, 'the message is the code');
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes(pemBody(good.privatePem).slice(0, 30)), false);
      return error.code;
    }
    return 'OK';
  };
  assert.equal(await code(join(dir, 'does-not-exist.pem')), 'PACKAGE_UPDATE_KEY_MISSING');
  assert.equal(await code(dir), 'PACKAGE_UPDATE_KEY_MISSING', 'a directory is not a key file');
  assert.equal(await code(join(dir, 'nested', 'x.pem')), 'PACKAGE_UPDATE_KEY_MISSING');
  assert.equal(await code(await write('empty.pem', '')), 'PACKAGE_UPDATE_KEY_INVALID');
  assert.equal(await code(await write('junk.pem', 'not a key at all\n')), 'PACKAGE_UPDATE_KEY_INVALID');
  assert.equal(await code(await write('truncated.pem', good.privatePem.slice(0, 120))), 'PACKAGE_UPDATE_KEY_INVALID');
  const publicPem = createPublicKey({ key: Buffer.from(good.publicB64, 'base64'), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' });
  assert.equal(await code(await write('public.pem', publicPem)), 'PACKAGE_UPDATE_KEY_INVALID', 'a public key cannot sign');
  assert.equal(await code(await write('p384.pem', generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }))), 'PACKAGE_UPDATE_KEY_INVALID', 'wrong curve');
  assert.equal(await code(await write('rsa.pem', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))), 'PACKAGE_UPDATE_KEY_INVALID');
  const goodFile = await write('good.pem', good.privatePem);
  assert.equal(await code(goodFile), 'OK');
  assert.equal(await code(goodFile, [generateUpdateKeyPair().publicB64]), 'PACKAGE_UPDATE_KEY_UNKNOWN', 'valid key, but the extension does not trust it');
  assert.equal(await code(goodFile, []), 'PACKAGE_UPDATE_KEY_UNKNOWN');
  assert.equal(await code(goodFile, null), 'PACKAGE_UPDATE_KEY_UNKNOWN');
  assert.equal(await code(goodFile, [generateUpdateKeyPair().publicB64, good.publicB64]), 'OK', 'a backup key in the list counts');
});

test('key: the signer shows no key material when printed or serialized, and the committed key list is the default', async (t) => {
  const { signer, privatePem, publicB64 } = await throwAway(t);
  const shown = `${JSON.stringify(signer)} ${String(signer)} ${Object.keys(signer)} ${JSON.stringify(Object.getOwnPropertyNames(signer))}`;
  assert.equal(shown.includes(pemBody(privatePem).slice(0, 30)), false);
  assert.equal(signer.publicKey, publicB64);
  assert.deepEqual(Object.keys(signer).sort(), ['publicKey', 'sign']);
  assert.equal(Object.isFrozen(signer), true);
  // The default key list is the extension's own, so an unknown key can never be shipped by accident.
  const defaultsFile = join(await tempDir(t, 'interp-updkey-'), 'k.pem');
  await writeFile(defaultsFile, privatePem);
  await assert.rejects(createUpdateSigner({ keyFile: defaultsFile }), { code: 'PACKAGE_UPDATE_KEY_UNKNOWN' });
  assert.equal(UPDATE_PUBLIC_KEYS.includes(publicB64), false);
  assert.match(DEFAULT_UPDATE_KEY_FILE, /\.config[\\/]interp-app[\\/]update-signing-primary\.pem$/);
});

// --- the source folder ------------------------------------------------------------------------------------------------

async function assertRefused(t, code, mutate, label) {
  const fix = await fixture(t);
  await mutate(fix);
  await assert.rejects(build(fix), (error) => { assert.equal(error.code, code, label); assert.equal(error.message, code, label); return true; }, label);
  assert.equal(await exists(join(fix.siteDir, 'update')), false, `${label}: nothing is written`);
  return fix;
}

test('source folder: unsafe names are refused and nothing is written (PACKAGE_UPDATE_PATH_UNSAFE)', async (t) => {
  const names = [
    'extension/bad$name.js', 'extension/ünï.js', 'extension/a;b.js', 'extension/x&y.js', 'extension/a#b.js',
    '_metadata/verified.json', 'extension/_metadata/x.js', '_private/x.js', '_other.js',
    'extension/con.js', 'extension/NUL', 'extension/trailing.',
  ];
  for (const name of names) await assertRefused(t, 'PACKAGE_UPDATE_PATH_UNSAFE', (f) => put(f.extensionDir, name, 'x'), name);
});

test('source folder: a symbolic link (to a file or to a folder) is refused, not followed', async (t) => {
  await assertRefused(t, 'PACKAGE_UPDATE_PATH_UNSAFE', async (fix) => {
    await symlink(join(fix.extensionDir, 'styles.css'), join(fix.extensionDir, 'link.css'));
  }, 'file link');
  await assertRefused(t, 'PACKAGE_UPDATE_PATH_UNSAFE', async (fix) => {
    await symlink(join(fix.extensionDir, 'extension'), join(fix.extensionDir, 'linked-folder'));
  }, 'folder link');
});

test('source folder: names that differ only in case, or a file inside a file, are refused (Windows and macOS would merge them)', async (t) => {
  assert.deepEqual(unsafeUpdatePaths(['a/B.js', 'a/b.js', 'a/c.js']), ['a/B.js', 'a/b.js']);
  assert.deepEqual(unsafeUpdatePaths(['Extension/x.js', 'extension/y.js', 'manifest.json']), [], 'different files in folders that differ in case are fine');
  assert.deepEqual(unsafeUpdatePaths(['a', 'a/b.js']), ['a/b.js'], 'a name that is both a file and a folder');
  assert.deepEqual(unsafeUpdatePaths(['A', 'a/b.js']), ['a/b.js']);
  assert.deepEqual(unsafeUpdatePaths(['ok.js', 'bad$.js', '../x.js', '/abs.js', 'a\\b.js', 'a//b.js', '_x/y.js', '_locales/ko/m.json', 'a/_metadata/x']), ['bad$.js', '../x.js', '/abs.js', 'a\\b.js', 'a//b.js', '_x/y.js', 'a/_metadata/x']);
  // On a file system that keeps both names apart the whole tree build refuses them too.
  const fix = await fixture(t);
  await put(fix.extensionDir, 'extension/Case.js', 'a');
  await put(fix.extensionDir, 'extension/case.js', 'b');
  const both = (await listAll(join(fix.extensionDir, 'extension'))).filter((path) => path.toLowerCase() === 'case.js');
  if (both.length !== 2) return;
  await assert.rejects(build(fix), { code: 'PACKAGE_UPDATE_PATH_UNSAFE' });
  assert.equal(await exists(join(fix.siteDir, 'update')), false);
});

test('source folder: the extension\'s limits hold (file count, one file, total size) and nothing is written', async (t) => {
  await assertRefused(t, 'PACKAGE_UPDATE_TOO_LARGE', async (fix) => {
    await writeFile(join(fix.extensionDir, 'big.bin'), Buffer.alloc(SELF_UPDATE_LIMITS.maxFileBytes + 1));
  }, 'one file over the limit');
  await assertRefused(t, 'PACKAGE_UPDATE_TOO_LARGE', async (fix) => {
    const have = plainFiles(fix.files).length;
    for (let index = 0; index <= SELF_UPDATE_LIMITS.maxFiles - have; index += 1) await put(fix.extensionDir, `many/f${index}.txt`, 'x');
  }, 'one file too many');
  await assertRefused(t, 'PACKAGE_UPDATE_TOO_LARGE', async (fix) => {
    const piece = Buffer.alloc(Math.floor(SELF_UPDATE_LIMITS.maxFileBytes * 0.95), 7);
    for (let index = 0; index < Math.ceil(SELF_UPDATE_LIMITS.maxTotalBytes / piece.length) + 1; index += 1) await put(fix.extensionDir, `blob/b${index}.bin`, piece);
  }, 'total over the limit');
  // exactly at the limits is fine: one file of the maximum size, then the maximum number of files
  const fix = await fixture(t);
  await writeFile(join(fix.extensionDir, 'exact.bin'), Buffer.alloc(SELF_UPDATE_LIMITS.maxFileBytes, 1));
  assert.equal((await build(fix)).files, plainFiles(fix.files).length + 1);
  const full = await fixture(t);
  const have = plainFiles(full.files).length;
  for (let index = 0; index < SELF_UPDATE_LIMITS.maxFiles - have; index += 1) await put(full.extensionDir, `many/f${index}.txt`, 'x');
  assert.equal((await build(full)).files, SELF_UPDATE_LIMITS.maxFiles);
});

test('source folder: manifest.json must be there and carry the version being published', async (t) => {
  await assertRefused(t, 'PACKAGE_UPDATE_TREE_INVALID', async (fix) => { await rm(join(fix.extensionDir, 'manifest.json')); }, 'no manifest.json');
  await assertRefused(t, 'PACKAGE_UPDATE_TREE_INVALID', async (fix) => { await put(fix.extensionDir, 'manifest.json', '{"version":"0.4.9"}'); }, 'another version');
  await assertRefused(t, 'PACKAGE_UPDATE_TREE_INVALID', async (fix) => { await put(fix.extensionDir, 'manifest.json', 'not json'); }, 'not json');
  await assertRefused(t, 'PACKAGE_UPDATE_TREE_INVALID', async (fix) => { await put(fix.extensionDir, 'manifest.json', '{"version":5}'); }, 'version not a string');
  const fix = await fixture(t);
  await assert.rejects(build(fix, { version: '0.5' }), { code: 'PACKAGE_UPDATE_TREE_INVALID' }, 'folder says 0.5.0, caller says 0.5');
  for (const version of ['v0.5.0', '0.5.0/../../x', '', undefined, '1']) {
    await assert.rejects(build(fix, { version }), /^Error: PACKAGE_VERSION_INVALID$/, String(version));
  }
  await assert.rejects(build(fix, { released: '08/10/2026' }), /^Error: PACKAGE_DATE_INVALID$/);
  await assert.rejects(build(fix, { signer: null }), { code: 'PACKAGE_UPDATE_KEY_MISSING' });
  await assert.rejects(build(fix, { signer: {} }), { code: 'PACKAGE_UPDATE_KEY_MISSING' });
  assert.equal(await exists(join(fix.siteDir, 'update')), false);
});

// --- vercel.json and latest.json -------------------------------------------------------------------------------------

test('vercel.json: /update/(.*) answers with CORS and no-cache; latest.json keeps exactly its four fields', () => {
  const { headers } = vercelConfig();
  const rule = headers.find((entry) => entry.source === '/update/(.*)');
  assert.ok(rule, 'a rule for the update tree');
  assert.deepEqual(Object.fromEntries(rule.headers.map(({ key, value }) => [key, value])), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
  assert.equal(headers.filter((entry) => entry.source === '/update/(.*)').length, 1);
  const latest = headers.find((entry) => entry.source === '/latest.json');
  assert.deepEqual(Object.fromEntries(latest.headers.map(({ key, value }) => [key, value])), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
  assert.deepEqual(Object.keys(latestJson({ version: VERSION, released: RELEASED })), ['version', 'released', 'download', 'page']);
  // The global rule (nosniff, noindex) still comes first and still covers the update tree.
  assert.equal(headers[0].source, '/(.*)');
});

test('arguments: --update-key-file takes a value, --no-update-tree none, each once, and not together', () => {
  const defaults = { ...parseArguments([]) };
  assert.equal(defaults.updateTree, true);
  assert.equal(defaults.updateKeyFile, DEFAULT_UPDATE_KEY_FILE);
  assert.deepEqual({ ...parseArguments(['--update-key-file', '/tmp/k.pem']) }, { ...defaults, updateKeyFile: '/tmp/k.pem' });
  assert.deepEqual({ ...parseArguments(['--no-update-tree']) }, { ...defaults, updateTree: false });
  assert.deepEqual({ ...parseArguments(['--released', '2026-10-08', '--no-update-tree', '--chrome', '/c']) }, { ...defaults, released: '2026-10-08', chrome: '/c', updateTree: false });
  for (const bad of [
    ['--update-key-file'], ['--update-key-file', '--no-update-tree'], ['--update-key-file', ''], ['--update-key-file', '/a', '--update-key-file', '/b'],
    ['--no-update-tree', '--no-update-tree'], ['--no-update-tree', '--update-key-file', '/a'], ['--update-key-file', '/a', '--no-update-tree'],
    ['--no-update-tree', 'extra'], ['--no-update-tree=true'], ['--update-tree'],
  ]) {
    assert.throws(() => parseArguments(bad), /^Error: PACKAGE_ARGUMENT_INVALID$/, bad.join(' '));
  }
});

// --- packageExtension end to end (hooks: fake keyed build, fake manual PDFs) -----------------------------------------

async function onPath(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { await access(join(directory, name), constants.X_OK); return true; } catch { /* next directory */ }
  }
  return false;
}
const zipAvailable = (await onPath('zip')) && (await onPath('unzip'));

/** The entries of a zip file as Map name -> content, read from its central directory (stored and deflated entries). */
function readZip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'end of central directory');
  const entries = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'central directory entry');
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressed);
    const content = method === 0 ? raw : inflateRawSync(raw);
    assert.equal(content.length, size, `${name}: size`);
    entries.set(name, content);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}

/** A repo-shaped root with the site sources, and hooks that stand in for the keyed build and the Chrome PDF printing. */
async function packageFixture(t, { extra = {}, version = VERSION } = {}) {
  const root = await tempDir(t, 'interp-pkg-');
  for (const file of ['index.html', 'site.css', 'site.js', 'content.js']) await put(root, `extension-site/${file}`, `/* ${file} */\n`);
  const builtinKeyFile = join(root, 'builtin-key');
  await writeFile(builtinKeyFile, `${FAKE_BUILTIN_KEY}\n`);
  const calls = { build: 0, render: 0 };
  const hooks = {
    async buildExtension({ out }) {
      calls.build += 1;
      const files = await writeKeyedFolder(out, { version, extra, dot: 'zip' });
      return { out, files: Object.keys(files).sort(), version, builtinKeys: 1, zip: null };
    },
    async renderManuals({ siteDir }) {
      calls.render += 1;
      await mkdir(join(siteDir, 'manuals'), { recursive: true });
      for (const manual of MANUALS) await writeFile(join(siteDir, 'manuals', manual.name), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11000, 0x20)]));
    },
  };
  return { root, builtinKeyFile, hooks, calls, key: await throwAway(t) };
}

const runPackage = (pf, overrides = {}) => {
  const lines = [];
  const promise = packageExtension({
    root: pf.root, builtinKeyFile: pf.builtinKeyFile, released: RELEASED, hooks: pf.hooks, log: (line) => lines.push(line),
    updateKeyFile: pf.key.keyFile, updatePublicKeys: pf.key.publicKeys, ...overrides,
  });
  return { lines, promise };
};

const zipOf = async (pf) => readZip(await readFile(join(pf.root, 'dist', 'extension-site', 'live-interpreter.zip')));
const zipEntries = async (pf) => [...(await zipOf(pf)).keys()];

test('package: the tree is built from the keyed folder, announced on stdout, outside the zip, and byte-identical to what the zip carries', { skip: !zipAvailable }, async (t) => {
  const pf = await packageFixture(t);
  const { lines, promise } = runPackage(pf);
  const result = await promise;
  const site = join(pf.root, 'dist', 'extension-site');
  const files = keyedFiles();
  const expectedBytes = Object.values(files).reduce((sum, content) => sum + byteLength(content), 0);

  const treeLine = lines.find((line) => line.startsWith('PACKAGE_UPDATE_TREE '));
  assert.equal(treeLine, `PACKAGE_UPDATE_TREE version=${VERSION} files=${plainFiles(files).length} bytes=${expectedBytes}`);
  assert.deepEqual({ ...result.updateTree }, { version: VERSION, files: plainFiles(files).length, bytes: expectedBytes, dir: join(site, 'update', VERSION) });

  // exact zip contents: the extension folder, no update tree, no marker
  const zip = await zipOf(pf);
  const entries = [...zip.keys()];
  assert.equal(entries.some((entry) => entry.startsWith('update/') || entry.startsWith(`${EXTENSION_FOLDER}/update/`)), false, 'no update tree in the zip');
  assert.equal(entries.some((entry) => entry.includes('manifest.sig')), false);
  assert.equal(entries.some((entry) => entry.includes(OUTPUT_MARKER)), false);
  const zippedFiles = entries.filter((entry) => entry.startsWith(`${EXTENSION_FOLDER}/`) && !entry.endsWith('/')).map((entry) => entry.slice(EXTENSION_FOLDER.length + 1)).sort();
  assert.deepEqual(zippedFiles, plainFiles(files), 'the tree lists the zip\'s extension files and no others');

  const manifest = await verifyOnDisk(join(site, 'update', VERSION), pf.key.publicKeys);
  assert.deepEqual(manifest.files.map((file) => file.path), zippedFiles);
  for (const file of manifest.files) {
    const inZip = zip.get(`${EXTENSION_FOLDER}/${file.path}`);
    assert.ok(inZip, `${file.path} is in the zip`);
    assert.equal(sha256(inZip), file.sha256, `${file.path}: the signed hash is the hash of the bytes in the zip`);
    assert.equal(inZip.length, file.size);
    assert.equal(Buffer.compare(inZip, await readFile(join(site, 'update', VERSION, 'files', ...file.path.split('/')))), 0);
  }
  // the keyed file really is the keyed one (so the key pool keeps working after an update)
  const keyed = await readFile(join(site, 'update', VERSION, 'files', 'extension', 'lib', 'builtin-key.js'), 'utf8');
  assert.ok(keyed.includes(FAKE_BUILTIN_KEY));

  // the rest of the site is what it was: latest.json with its four fields, vercel.json with the rules
  assert.deepEqual(JSON.parse(await readFile(join(site, 'latest.json'), 'utf8')), latestJson({ version: VERSION, released: RELEASED }));
  assert.deepEqual(JSON.parse(await readFile(join(site, 'vercel.json'), 'utf8')), vercelConfig());
  for (const icon of SITE_ICONS) assert.equal(await exists(join(site, 'icons', icon)), true);
  assert.equal(pf.calls.build, 1);
  assert.equal(pf.calls.render, 1);
});

test('package: no private key text in any output line, site file, zip entry or the tree', { skip: !zipAvailable }, async (t) => {
  const pf = await packageFixture(t);
  const { lines, promise } = runPackage(pf);
  await promise;
  const needle = pemBody(pf.key.privatePem).slice(0, 40);
  assert.equal(lines.join('\n').includes(needle), false);
  assert.equal(lines.join('\n').includes('PRIVATE KEY'), false);
  assert.equal(lines.some((line) => line.includes(pf.key.keyFile)), false, 'not even the key file path is echoed');
  for (const path of await listAll(join(pf.root, 'dist'))) {
    const bytes = await readFile(join(pf.root, 'dist', ...path.split('/')));
    assert.equal(bytes.includes(needle), false, `dist/${path}`);
    assert.equal(bytes.includes('PRIVATE KEY'), false, `dist/${path}`);
  }
  const everything = Buffer.concat([...(await zipOf(pf)).values()]);
  assert.ok(everything.length > 1000, 'the zip was read');
  assert.equal(everything.includes(needle), false);
  // the public key may be anywhere; the private half must not derive from anything printed
  assert.equal(lines.some((line) => line.includes(pf.key.publicB64)), false);
});

test('package: a missing, invalid or unknown update key stops BEFORE dist/ is touched or the build starts', { skip: !zipAvailable }, async (t) => {
  const cases = [
    ['PACKAGE_UPDATE_KEY_MISSING', async (pf) => join(pf.root, 'no-such-key.pem')],
    ['PACKAGE_UPDATE_KEY_INVALID', async (pf) => { const file = join(pf.root, 'bad.pem'); await writeFile(file, 'junk'); return file; }],
    ['PACKAGE_UPDATE_KEY_UNKNOWN', async (pf) => { const file = join(pf.root, 'stranger.pem'); await writeFile(file, generateUpdateKeyPair().privatePem); return file; }],
  ];
  for (const [code, makeKeyFile] of cases) {
    const pf = await packageFixture(t);
    const updateKeyFile = await makeKeyFile(pf);
    const { lines, promise } = runPackage(pf, { updateKeyFile });
    await assert.rejects(promise, (error) => { assert.equal(error.code, code); assert.equal(error.message, code); return true; });
    assert.equal(await exists(join(pf.root, 'dist')), false, `${code}: dist/ must not even be created`);
    assert.equal(pf.calls.build, 0, `${code}: no build`);
    assert.equal(pf.calls.render, 0);
    assert.deepEqual(lines, []);
  }
  // a stale dist/ from an earlier release survives a refused run untouched
  const pf = await packageFixture(t);
  await put(pf.root, 'dist/extension-site/update/0.4.0/manifest.json', 'previous release');
  await assert.rejects(runPackage(pf, { updateKeyFile: join(pf.root, 'nope.pem') }).promise, { code: 'PACKAGE_UPDATE_KEY_MISSING' });
  assert.equal(await readFile(join(pf.root, 'dist/extension-site/update/0.4.0/manifest.json'), 'utf8'), 'previous release');
});

test('package: the default signing key is the extension\'s own list (an unlisted throw-away key is refused without updatePublicKeys)', { skip: !zipAvailable }, async (t) => {
  const pf = await packageFixture(t);
  await assert.rejects(packageExtension({ root: pf.root, builtinKeyFile: pf.builtinKeyFile, released: RELEASED, hooks: pf.hooks, updateKeyFile: pf.key.keyFile }), { code: 'PACKAGE_UPDATE_KEY_UNKNOWN' });
  assert.equal(pf.calls.build, 0);
});

test('package: --no-update-tree skips the tree on purpose, needs no key, and leaves the zip and the rest of the site as they are', { skip: !zipAvailable }, async (t) => {
  const withTree = await packageFixture(t);
  await runPackage(withTree).promise;
  const without = await packageFixture(t);
  const { lines, promise } = runPackage(without, { updateTree: false, updateKeyFile: join(without.root, 'no-such-key.pem') });
  const result = await promise;
  const site = join(without.root, 'dist', 'extension-site');
  assert.equal(await exists(join(site, 'update')), false);
  assert.equal(result.updateTree, null);
  assert.equal(lines.some((line) => /^PACKAGE_UPDATE_TREE version=/.test(line)), false);
  assert.ok(lines.includes('PACKAGE_UPDATE_TREE skipped=1'), 'the skip is visible, not silent');
  assert.deepEqual(await zipEntries(without), await zipEntries(withTree), 'same zip layout');
  assert.deepEqual((await listAll(site)).filter((path) => !path.startsWith('update/')), (await listAll(join(withTree.root, 'dist', 'extension-site'))).filter((path) => !path.startsWith('update/')));
});

test('package: an unsafe path, a limit or a version mismatch in the keyed folder fails the run (no tree, no PDFs)', { skip: !zipAvailable }, async (t) => {
  for (const [code, extra, version] of [
    ['PACKAGE_UPDATE_PATH_UNSAFE', { 'extension/bad$name.js': 'x' }, VERSION],
    ['PACKAGE_UPDATE_TOO_LARGE', { 'big.bin': Buffer.alloc(SELF_UPDATE_LIMITS.maxFileBytes + 1) }, VERSION],
  ]) {
    const pf = await packageFixture(t, { extra, version });
    await assert.rejects(runPackage(pf).promise, { code });
    assert.equal(await exists(join(pf.root, 'dist', 'extension-site', 'update')), false, code);
    assert.equal(pf.calls.render, 0, `${code}: refused before the slow PDF step`);
  }
  // the build reports 0.5.0 but its manifest.json says something else
  const pf = await packageFixture(t);
  const original = pf.hooks.buildExtension;
  pf.hooks.buildExtension = async (options) => {
    const result = await original(options);
    await put(options.out, 'manifest.json', '{"version":"0.4.0"}\n');
    return result;
  };
  await assert.rejects(runPackage(pf).promise, { code: 'PACKAGE_UPDATE_TREE_INVALID' });
});

test('package: a dotfile that the zip would carry but the tree leaves out is caught by the zip/tree comparison', { skip: !zipAvailable }, async (t) => {
  const pf = await packageFixture(t, { extra: { '.gitkeep': '' } });
  await assert.rejects(runPackage(pf).promise, (error) => {
    assert.equal(error.code, 'PACKAGE_UPDATE_TREE_INVALID');
    assert.deepEqual(error.detail.problems, ['ZIP_ONLY .gitkeep']);
    return true;
  });
});

// --- the CLI wrapper -------------------------------------------------------------------------------------------------

function sinks() {
  const out = [];
  const err = [];
  return { out, err, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
}

test('runCli: passes the parsed options to the run, prints the PACKAGE_* lines, one code on failure, never an unknown message', async () => {
  const seen = [];
  const ok = sinks();
  const code = await runCli(['--update-key-file', '/k.pem', '--released', RELEASED], {
    ...ok,
    run: async (options) => {
      seen.push(options);
      options.log(`PACKAGE_UPDATE_TREE version=${VERSION} files=3 bytes=9`);
      return { version: VERSION, keys: 1, released: RELEASED, zip: '/z', entries: 5, pdfs: 6, site: '/s' };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].updateKeyFile, '/k.pem');
  assert.equal(seen[0].updateTree, true);
  assert.equal(typeof seen[0].log, 'function');
  assert.equal(ok.out[0], `PACKAGE_UPDATE_TREE version=${VERSION} files=3 bytes=9\n`);
  assert.match(ok.out[1], /^PACKAGE_OK version=0\.5\.0 /);
  assert.deepEqual(ok.err, []);

  const skipped = [];
  await runCli(['--no-update-tree'], { ...sinks(), run: async (options) => { skipped.push(options); return { version: VERSION, keys: 1, released: RELEASED, zip: '/z', entries: 5, pdfs: 6, site: '/s' }; } });
  assert.equal(skipped[0].updateTree, false);

  for (const failure of ['PACKAGE_UPDATE_KEY_MISSING', 'PACKAGE_UPDATE_KEY_INVALID', 'PACKAGE_UPDATE_KEY_UNKNOWN', 'PACKAGE_UPDATE_PATH_UNSAFE']) {
    const bad = sinks();
    const exit = await runCli([], { ...bad, run: async () => { throw Object.assign(new Error(failure), { code: failure }); } });
    assert.equal(exit, 1);
    assert.deepEqual(bad.err, [`${failure}\n`]);
    assert.deepEqual(bad.out, []);
  }
  const problems = sinks();
  await runCli([], { ...problems, run: async () => { throw Object.assign(new Error('PACKAGE_UPDATE_TREE_INVALID'), { detail: { problems: ['HASH extension/a.js', 'SIZE b'] } }); } });
  assert.deepEqual(problems.err, ['PACKAGE_UPDATE_TREE_INVALID HASH extension/a.js, SIZE b\n']);

  const leak = sinks();
  const secret = ['-----BEGIN', 'PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49\n-----END', 'PRIVATE KEY-----'].join(' ');
  await runCli([], { ...leak, run: async () => { throw new Error(secret); } });
  assert.deepEqual(leak.err, ['PACKAGE_FAILED\n']);
  const bad = sinks();
  assert.equal(await runCli(['--update-key-file', '/a', '--no-update-tree'], { ...bad, run: async () => { throw new Error('must not run'); } }), 1);
  assert.deepEqual(bad.err, ['PACKAGE_ARGUMENT_INVALID\n']);
});
