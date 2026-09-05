import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createDevServer } from '../scripts/serve.mjs';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'interp-serve-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'public');
  await mkdir(root);
  const server = await createDevServer({ root });
  t.after(() => server.closeAllConnections());
  // Exercise Node's HTTP parser and response stream without requiring a TCP bind.
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    socket.on('error', reject);
    socket.on('finish', () => {
      const raw = Buffer.concat(chunks);
      const boundary = raw.indexOf('\r\n\r\n');
      const lines = raw.subarray(0, boundary).toString().split('\r\n');
      const headers = Object.fromEntries(lines.slice(1).map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      socket.destroy();
      resolve({ status: Number(lines[0].split(' ')[1]), headers, body: raw.subarray(boundary + 4) });
    });
    server.emit('connection', socket);
    socket.push(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  return { temp, root, get };
}

test('serves static formats, binary bytes, query paths and HEAD metadata', async (t) => {
  const { root, get } = await fixture(t);
  const types = {
    html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm',
    wav: 'audio/wav', txt: 'text/plain; charset=utf-8', unknown: 'application/octet-stream',
  };
  const bytes = Buffer.from([0, 127, 128, 255]);
  for (const [extension, type] of Object.entries(types)) {
    await writeFile(join(root, `asset.${extension}`), bytes);
    const response = await get(`/asset.${extension}?v=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], type);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.body, bytes);
  }
  const head = await get('/asset.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '4');
  assert.equal(head.body.length, 0);
  await writeFile(join(root, '한 글.js'), 'export {};');
  assert.equal((await get('/%ED%95%9C%20%EA%B8%80.js')).status, 200);
});

test('directory indexes work without listings or SPA fallback', async (t) => {
  const { root, get } = await fixture(t);
  assert.equal((await get('/')).status, 404);
  await writeFile(join(root, 'index.html'), '<main>fixture</main>');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'index.html'), 'nested');
  for (const path of ['/', '/nested/', '/nested']) assert.equal((await get(path)).status, 200);
  assert.equal((await get('/missing.js')).status, 404);
  const post = await get('/index.html', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal(post.body.length, 0);
});

test('rejects traversal, malformed encodings, hidden paths and symlink escapes', async (t) => {
  const { root, temp, get } = await fixture(t);
  await writeFile(join(temp, 'secret.txt'), 'TEST_SECRET_ONLY');
  await writeFile(join(root, '.env'), 'TEST_SECRET_ONLY');
  await mkdir(join(temp, 'public-sibling'));
  await writeFile(join(temp, 'public-sibling', 'secret.txt'), 'TEST_SECRET_ONLY');
  await symlink(join(temp, 'secret.txt'), join(root, 'link.txt'));
  await symlink(join(temp, 'public-sibling'), join(root, 'linked'));
  await mkdir(join(root, 'indexed'));
  await symlink(join(temp, 'secret.txt'), join(root, 'indexed', 'index.html'));
  const paths = [
    '/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt',
    '/a/../../secret.txt', '/%252e%252e/secret.txt', '/..%5csecret.txt',
    '//secret.txt', '/%00', '/%0a', '/%', '/%FF', '/.env', '/%2eenv',
    '/.git/config', '/link.txt', '/linked/secret.txt', '/indexed/',
  ];
  for (const path of paths) {
    const response = await get(path);
    assert.equal(response.status, 403, path);
    assert.equal(response.body.length, 0, path);
  }
  const response = await get('/missing?key=TEST_SECRET_ONLY');
  assert.equal(response.status, 404);
  assert.ok(!JSON.stringify(response).includes('TEST_SECRET_ONLY'));
  assert.equal((await get('/missing', 'HEAD')).body.length, 0);
});

test('CLI rejects invalid arguments without echoing their contents', () => {
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port'], ['--key', 'TEST_SECRET_ONLY']]) {
    const child = spawnSync(process.execPath, ['scripts/serve.mjs', ...args], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, 'SERVER_START_FAILED\n');
  }
});
