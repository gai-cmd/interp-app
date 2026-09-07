// Release verification (design-v0.6 §11.2 "배포 산출물의 비밀 검사", §13.2,
// §17.4 "정적 캐시 허용 목록·불완전 릴리스 거부·비밀 검사"). Exit 1 on any
// issue. Output is limited to fixed codes and release-relative paths; file
// contents are never echoed. The secret scan is pattern based and is not a
// proof of absence: keep the release review and provider-side key hygiene.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ENTRY_BOOT_FILE, ENTRY_FILE, ENTRY_MODULE_FILE, HEADERS_FILE, RELEASES_DIRECTORY, RELEASE_ID_PATTERN,
  POLICY_FILE, RELEASE_MANIFEST, ROOT_FILES, WORKER_FILE, isVersionedPath, readRelease, shellFor,
} from './stage-release.mjs';
// P3-36: the deployed policy is checked with the app's own validator and the
// app's own version, so a release cannot ship a policy the app would reject.
import { validatePolicy } from '../app/policy/schema.js';
import { findForbidden } from '../app/admin/policy-editor.js';
import { APP_VERSION, parseVersion } from '../app/version.js';

/** -1 / 0 / 1 comparing two numeric triplets; an unparsable one sorts lowest. */
function compareVersions(left, right) {
  const a = parseVersion(left) ?? [0, 0, 0];
  const b = parseVersion(right) ?? [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

// Key-shaped strings (§11.2). Add patterns; never add real values as tests.
export const SECRET_PATTERNS = Object.freeze([
  /AIza[0-9A-Za-z_-]{20,}/,                                   // Google API key
  /\bsk-[A-Za-z0-9_-]{20,}/,                                  // sk-… style keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,                             // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,                           // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                       // PEM private keys
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /#shared=%7B/i,                                             // shared-key QR payload (§5.4)
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i,
]);

// Owner decision (2026-09-07): this build ships a built-in provider key so a
// device that has never been set up can start without typing one. Exactly one
// file may carry it. The scan above stays on for every other file, so an
// accidental key anywhere else is still refused, and a match inside this file
// is reported as a NOTICE rather than passing silently: a release that carries
// a key has to say so out loud. Removing the key from the file removes the
// notice; this list must never grow to cover a file that merely happens to
// contain one.
export const SECRET_EXEMPT_FILES = Object.freeze(['app/security/builtin-key.js']);
/** True for the one versioned file allowed to carry the built-in key. */
export function isSecretExempt(path) {
  const kind = classifyPath(path);
  return kind?.kind === 'versioned' && SECRET_EXEMPT_FILES.includes(kind.file);
}

// Content-Security-Policy directives the release must carry (§11.2).
const REQUIRED_CSP = Object.freeze({
  'default-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'blob:'],
  'worker-src': ["'self'"],
  'frame-ancestors': ["'none'"],
});
const LOCAL_SOURCES = new Set(["'self'", "'none'"]);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const sameSet = (left, right) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

async function listFiles(root) {
  const files = [];
  const issues = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) { issues.push({ code: 'RELEASE_SYMLINK', path }); continue; }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path);
      else issues.push({ code: 'RELEASE_UNEXPECTED_FILE', path });
    }
  }
  await walk(root);
  return { files: files.sort(), issues };
}

// Allowlist for the deploy root: fixed root files and releases/<id>/ trees.
export function classifyPath(path) {
  if (ROOT_FILES.includes(path)) return { kind: 'root' };
  const match = path.match(/^releases\/([^/]+)\/(.+)$/);
  if (!match || !RELEASE_ID_PATTERN.test(match[1])) return null;
  if (match[2] === RELEASE_MANIFEST) return { kind: 'manifest', id: match[1] };
  return isVersionedPath(match[2]) ? { kind: 'versioned', id: match[1], file: match[2] } : null;
}

// Allowlisted versioned files of one release (unexpected files are reported separately).
function versionedFiles(files, id) {
  return files.map((path) => classifyPath(path)).filter((kind) => kind?.kind === 'versioned' && kind.id === id).map((kind) => kind.file);
}

/** Parse a Cloudflare Pages `_headers` file into [{ path, headers: Map }]. */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { rules.push({ path: raw.trim(), headers: new Map() }); continue; }
    const colon = raw.indexOf(':');
    if (!rules.length || colon < 0) return null;
    rules.at(-1).headers.set(raw.slice(0, colon).trim().toLowerCase(), raw.slice(colon + 1).trim());
  }
  return rules;
}

export function parseCsp(value) {
  const directives = new Map();
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    directives.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return directives;
}

/** Issues for a CSP string against the expected endpoint origins. */
export function checkCsp(value, endpointOrigins) {
  const issues = [];
  const csp = parseCsp(value);
  for (const [name, expected] of Object.entries(REQUIRED_CSP)) {
    if (!csp.has(name) || !sameSet(csp.get(name), expected)) issues.push('RELEASE_CSP_MISMATCH');
  }
  const connect = csp.get('connect-src');
  if (!connect || !sameSet(connect, ["'self'", ...endpointOrigins])) issues.push('RELEASE_CSP_MISMATCH');
  for (const [name, sources] of csp) {
    for (const source of sources) {
      const lowered = source.toLowerCase();
      if (lowered === "'unsafe-inline'" || lowered === "'unsafe-eval'" || lowered.startsWith("'nonce-")
          || lowered.startsWith("'sha")) issues.push('RELEASE_CSP_MISMATCH');
      const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
      if (remote && (name !== 'connect-src' || !endpointOrigins.includes(source))) issues.push('RELEASE_CSP_MISMATCH');
      if (!Object.hasOwn(REQUIRED_CSP, name) && name !== 'connect-src' && !LOCAL_SOURCES.has(lowered)) {
        issues.push('RELEASE_CSP_MISMATCH');
      }
    }
  }
  return [...new Set(issues)];
}

function checkHeadersFile(text, endpointOrigins) {
  const rules = parseHeaders(text);
  if (!rules) return ['RELEASE_HEADERS_INVALID'];
  const issues = [];
  const global = rules.find((rule) => rule.path === '/*');
  if (!global) return ['RELEASE_HEADERS_INVALID'];
  const csp = global.headers.get('content-security-policy');
  if (!csp) issues.push('RELEASE_HEADERS_INVALID');
  else issues.push(...checkCsp(csp, endpointOrigins));
  const permissions = global.headers.get('permissions-policy') ?? '';
  if (!/(?:^|,)\s*microphone=\(self\)\s*(?:,|$)/.test(permissions)) issues.push('RELEASE_HEADERS_INVALID');
  const worker = rules.find((rule) => rule.path === `/${WORKER_FILE}`);
  if (!/\bno-cache\b/.test(worker?.headers.get('cache-control') ?? '')) issues.push('RELEASE_HEADERS_INVALID');
  return [...new Set(issues)];
}

const SCRIPT_SRC = /\bsrc\s*=\s*(["'])([^"']*)\1/i;
// Attributes that would make the boot script asynchronous or a module.
const NON_SYNC_ATTRIBUTE = /\s(?:type|async|defer|nomodule)(?:\s*=|\s|$)/i;

/**
 * Attribute references of the entry HTML; null when the markup is unsafe.
 * The entry may load exactly two scripts (design-p3 §1.10, §4.2): first a
 * classic synchronous script with a src (the appearance boot), placed before
 * any stylesheet link so it runs before the first paint, then one module
 * script. Anything else (inline code, handlers, styles, <base>, extra or
 * deferred scripts) is rejected. Returns { references, modules, boot }.
 */
export function entryReferences(html) {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/<base\b/i.test(markup) || /\son[a-z]+\s*=/i.test(markup)) return null;
  if (/<script\b[^>]*>\s*[^<\s][\s\S]*?<\/script>/i.test(markup)) return null;
  if (/<style\b/i.test(markup) || /\sstyle\s*=/i.test(markup)) return null;
  const scripts = [...markup.matchAll(/<script\b([^>]*)>/gi)];
  if (scripts.length !== 2) return null;
  const [bootTag, moduleTag] = scripts;
  if (NON_SYNC_ATTRIBUTE.test(bootTag[1]) || !/\btype=(["'])module\1/.test(moduleTag[1])) return null;
  const boot = bootTag[1].match(SCRIPT_SRC)?.[2];
  const module = moduleTag[1].match(SCRIPT_SRC)?.[2];
  if (boot === undefined || module === undefined) return null;
  const stylesheet = markup.search(/<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1/i);
  if (stylesheet >= 0 && stylesheet < bootTag.index) return null;
  const references = [...markup.matchAll(/\b(?:href|src)\s*=\s*(["'])([^"']*)\1/gi)].map((match) => match[2]);
  return { references, modules: [module], boot };
}

function checkEntry(html, files) {
  const parsed = entryReferences(html);
  if (!parsed) return { issues: [{ code: 'RELEASE_ENTRY_INVALID', path: ENTRY_FILE }], current: null };
  const issues = [];
  const ids = new Set();
  for (const reference of parsed.references) {
    const path = reference.replace(/[?#].*$/, '');
    if (!path.startsWith('./') || path.includes('..')) { issues.push({ code: 'RELEASE_ENTRY_INVALID', path: ENTRY_FILE }); continue; }
    const target = path.slice(2);
    const kind = classifyPath(target);
    if (!kind || kind.kind === 'manifest') { issues.push({ code: 'RELEASE_ENTRY_INVALID', path: ENTRY_FILE }); continue; }
    if (!files.includes(target)) issues.push({ code: 'RELEASE_MISSING_FILE', path: target });
    if (kind.kind === 'versioned') ids.add(kind.id);
  }
  const current = ids.size === 1 ? [...ids][0] : null;
  // Both scripts have fixed paths inside the current release (architecture.md "릴리스·서비스 워커").
  if (!current || parsed.modules.length !== 1 || parsed.modules[0] !== `./${RELEASES_DIRECTORY}/${current}/${ENTRY_MODULE_FILE}`
      || parsed.boot !== `./${RELEASES_DIRECTORY}/${current}/${ENTRY_BOOT_FILE}`) {
    issues.push({ code: 'RELEASE_ENTRY_INVALID', path: ENTRY_FILE });
  }
  return { issues, current };
}

async function loadEndpointOrigins(releaseDir) {
  const module = await import(pathToFileURL(join(releaseDir, 'app', 'config.js')).href);
  const origins = module.ENDPOINT_ORIGINS;
  if (!Array.isArray(origins) || !origins.length
      || !origins.every((origin) => typeof origin === 'string' && /^(?:https|wss):\/\/[^/]+$/.test(origin))) {
    throw new Error('RELEASE_CONFIG_INVALID');
  }
  return [...origins];
}

/**
 * checkRelease({ dir, endpointOrigins? }) inspects a staged deploy root and
 * returns { ok, issues: [{ code, path? }], releases, current }. Without
 * endpointOrigins, each release's own app/config.js is imported (the shipped
 * code is the reference for CSP connect-src).
 */
/**
 * P3-36: the deployed policy must be a policy the app would accept. A release
 * that ships an invalid one is a release that blocks every start (§1.5), and a
 * policy that carries a credential is a public file leaking one — neither may
 * be deployed, so both are refused here rather than discovered in production.
 *
 * The check runs the SAME validator the app runs; there is no looser build-time
 * version of it.
 */
export async function checkDeployedPolicy(root) {
  const issues = [];
  let text;
  try { text = await readFile(join(root, POLICY_FILE), 'utf8'); }
  catch { return [{ code: 'RELEASE_POLICY_MISSING', path: POLICY_FILE }]; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return [{ code: 'RELEASE_POLICY_INVALID', path: POLICY_FILE }]; }
  // A credential in the public policy file, whatever produced it.
  const forbidden = findForbidden(parsed);
  for (const path of forbidden) issues.push({ code: 'RELEASE_POLICY_SECRET', path: `${POLICY_FILE}/${path}` });
  const result = validatePolicy(parsed);
  if (!result.ok) {
    for (const issue of result.issues) {
      issues.push({ code: 'RELEASE_POLICY_INVALID', path: `${POLICY_FILE}/${issue.path || ''}` });
    }
  } else if (compareVersions(result.policy.minAppVersion, APP_VERSION) > 0) {
    // A policy demanding a newer app than the one being deployed locks the
    // release out of its own site.
    issues.push({ code: 'RELEASE_POLICY_VERSION', path: `${POLICY_FILE}/minAppVersion` });
  }
  return issues;
}

export async function checkRelease({ dir, endpointOrigins } = {}) {
  let root;
  try {
    root = resolve(dir);
    if (!(await lstat(root)).isDirectory()) throw new Error();
  } catch { return { ok: false, issues: [{ code: 'RELEASE_DIR_INVALID' }], releases: [], current: null }; }
  const { files, issues } = await listFiles(root);
  issues.push(...await checkDeployedPolicy(root));
  const releases = new Set();
  for (const path of files) {
    const kind = classifyPath(path);
    if (!kind) issues.push({ code: 'RELEASE_UNEXPECTED_FILE', path });
    else if (kind.id) releases.add(kind.id);
  }
  for (const file of ROOT_FILES) if (!files.includes(file)) issues.push({ code: 'RELEASE_MISSING_FILE', path: file });

  const contents = new Map();
  const notices = [];
  for (const path of files) {
    const bytes = await readFile(join(root, path));
    contents.set(path, bytes);
    const text = bytes.toString('latin1');
    if (!SECRET_PATTERNS.some((pattern) => pattern.test(text))) continue;
    // The built-in key file is the one reviewed exception; it is announced,
    // not accepted in silence. Everything else is still a release blocker.
    if (isSecretExempt(path)) notices.push({ code: 'RELEASE_BUILTIN_KEY', path });
    else issues.push({ code: 'RELEASE_SECRET_PATTERN', path });
  }

  // Every release directory must be complete and byte-identical to its manifest.
  const originsByRelease = new Map();
  for (const id of [...releases].sort()) {
    const prefix = `${RELEASES_DIRECTORY}/${id}/`;
    if (endpointOrigins) originsByRelease.set(id, [...endpointOrigins]);
    else {
      try { originsByRelease.set(id, await loadEndpointOrigins(join(root, RELEASES_DIRECTORY, id))); }
      catch { issues.push({ code: 'RELEASE_CONFIG_INVALID', path: `${prefix}app/config.js` }); }
    }
    let manifest = null;
    try { manifest = JSON.parse(contents.get(`${prefix}${RELEASE_MANIFEST}`)?.toString('utf8') ?? ''); } catch { manifest = null; }
    if (!manifest || manifest.id !== id || !manifest.files || typeof manifest.files !== 'object') {
      issues.push({ code: 'RELEASE_MANIFEST_INVALID', path: `${prefix}${RELEASE_MANIFEST}` });
      continue;
    }
    const listed = Object.keys(manifest.files).sort();
    const present = versionedFiles(files, id);
    if (!sameSet(listed, present)) issues.push({ code: 'RELEASE_MANIFEST_INVALID', path: `${prefix}${RELEASE_MANIFEST}` });
    for (const file of present) {
      if (Object.hasOwn(manifest.files, file) && manifest.files[file] !== sha256(contents.get(`${prefix}${file}`))) {
        issues.push({ code: 'RELEASE_HASH_MISMATCH', path: `${prefix}${file}` });
      }
    }
  }

  // Entry and worker must agree on one existing release and its full shell.
  let current = null;
  if (contents.has(ENTRY_FILE)) {
    const entry = checkEntry(contents.get(ENTRY_FILE).toString('utf8'), files);
    issues.push(...entry.issues);
    current = entry.current && releases.has(entry.current) ? entry.current : null;
    if (entry.current && !current) issues.push({ code: 'RELEASE_ENTRY_INVALID', path: ENTRY_FILE });
  }
  if (contents.has(WORKER_FILE)) {
    const release = readRelease(contents.get(WORKER_FILE).toString('utf8'));
    const versioned = current ? versionedFiles(files, current) : [];
    if (!release || !current || release.id !== current || !Array.isArray(release.shell)
        || !sameSet(release.shell, shellFor(current, versioned))) {
      issues.push({ code: 'RELEASE_SW_INVALID', path: WORKER_FILE });
    }
  }
  if (contents.has(HEADERS_FILE)) {
    const origins = current ? originsByRelease.get(current) : null;
    const expected = origins ?? (endpointOrigins ? [...endpointOrigins] : null);
    if (!expected) issues.push({ code: 'RELEASE_CSP_MISMATCH', path: HEADERS_FILE });
    else {
      for (const code of checkHeadersFile(contents.get(HEADERS_FILE).toString('utf8'), expected)) issues.push({ code, path: HEADERS_FILE });
      for (const [id, releaseOrigins] of originsByRelease) {
        if (!sameSet(releaseOrigins, expected)) issues.push({ code: 'RELEASE_CSP_MISMATCH', path: `${RELEASES_DIRECTORY}/${id}/app/config.js` });
      }
    }
  }
  const unique = [...new Map(issues.map((issue) => [`${issue.code}:${issue.path ?? ''}`, issue])).values()];
  return { ok: unique.length === 0, issues: unique, notices, releases: [...releases].sort(), current, files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let result;
  if (args.length !== 1 || args[0].startsWith('--')) result = { ok: false, issues: [{ code: 'RELEASE_ARGUMENT_INVALID' }] };
  else {
    try { result = await checkRelease({ dir: args[0] }); }
    catch { result = { ok: false, issues: [{ code: 'RELEASE_CHECK_FAILED' }] }; }
  }
  if (result.ok) {
    // Notices never fail the run, but a passing release that ships the
    // built-in key says so before it says OK. A failing run stays silent on
    // stdout: there the issues are the whole story.
    for (const notice of result.notices ?? []) console.log(notice.path ? `${notice.code} ${notice.path}` : notice.code);
    console.log(`RELEASE_OK current=${result.current} releases=${result.releases.length} files=${result.files}`);
  }
  else {
    for (const issue of result.issues) console.error(issue.path ? `${issue.code} ${issue.path}` : issue.code);
    process.exitCode = 1;
  }
}
