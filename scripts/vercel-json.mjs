// Vercel deployment config for a staged deploy root (owner, 2026-09-07: the
// site moved from GitHub Pages to Vercel so the built-in key never passes
// through a public repository). Vercel does not read Cloudflare's `_headers`,
// so this writes the SAME headers as `vercel.json` from the deploy root's own
// `_headers` — one source, two formats. Usage:
//   node scripts/vercel-json.mjs <deploy-root>   (writes <deploy-root>/vercel.json)
// Run it AFTER check-release (vercel.json is not an allowlisted release file)
// and on the copy that is uploaded, never on the git-tracked deploy root.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseHeaders } from './check-release.mjs';

const root = process.argv[2];
if (!root) { console.error('RELEASE_ARGUMENT_INVALID'); process.exit(1); }
const rules = parseHeaders(await readFile(join(resolve(root), '_headers'), 'utf8'));
if (!rules) { console.error('RELEASE_HEADERS_INVALID'); process.exit(1); }

// Cloudflare path patterns -> Vercel path-to-regexp sources.
const toSource = (path) => path === '/*' ? '/(.*)' : path === '/' ? '/' : path.endsWith('/*') ? `${path.slice(0, -2)}/(.*)` : path;
const headers = rules.map((rule) => ({
  source: toSource(rule.path),
  headers: [...rule.headers].map(([key, value]) => ({ key, value })),
}));
const config = {
  // A static upload: nothing is built, nothing is a serverless function.
  cleanUrls: false,
  trailingSlash: false,
  headers,
};
await writeFile(join(resolve(root), 'vercel.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`VERCEL_JSON_OK rules=${headers.length}`);
