import { createServer } from 'node:http';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
}));

function inside(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

// Validate before URL normalization can erase dot segments. Never echo requests.
function segmentsOf(target) {
  const raw = target.split('?')[0];
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  let path;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (/[\\\u0000-\u001f\u007f%#]/u.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.some((part) => part.startsWith('.'))) return null;
  return segments;
}

/** Create an unbound development server; importing this module has no side effects. */
export async function createDevServer({ root = projectRoot } = {}) {
  let base;
  try { base = await realpath(root); } catch { throw new Error('SERVER_ROOT_INVALID'); }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const end = (status) => {
      response.writeHead(status, { 'Content-Length': '0' });
      response.end();
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      end(405);
      return;
    }
    const segments = segmentsOf(request.url ?? '');
    if (!segments) { end(403); return; }
    let file;
    try {
      let target = base;
      for (const segment of segments) {
        target = join(target, segment);
        if ((await lstat(target)).isSymbolicLink()) { end(403); return; }
      }
      if ((await lstat(target)).isDirectory()) target = join(target, 'index.html');
      if ((await lstat(target)).isSymbolicLink()) { end(403); return; }
      const canonical = await realpath(target);
      if (!inside(base, canonical)) { end(403); return; }
      file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile()) { end(404); return; }
      response.writeHead(200, {
        'Content-Type': mimeTypes.get(extname(target).toLowerCase()) ?? 'application/octet-stream',
        'Content-Length': stat.size,
      });
      if (request.method === 'HEAD') response.end();
      else await pipeline(file.createReadStream({ autoClose: false }), response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else end(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404
        : ['EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? 403 : 500);
    } finally {
      await file?.close().catch(() => {});
    }
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) {
    throw new Error('SERVER_ARGUMENT_INVALID');
  }
  const port = args.length ? Number(args[1]) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SERVER_PORT_INVALID');
  const server = await createDevServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  process.stdout.write(`DEV_HTTP http://127.0.0.1:${port}\n`);
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('SERVER_START_FAILED\n');
    process.exitCode = 1;
  });
}
