import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { ENDPOINT_ALLOWLIST, ENDPOINT_ORIGINS } from '../app/config.js';
import { GEMINI_ENDPOINTS } from '../app/providers/gemini/index.js';
import { REST_ENDPOINT } from '../app/providers/gemini/config.js';
import { LIVE_ENDPOINT } from '../app/providers/gemini/live-client.js';
import { normalizeGeminiError } from '../app/providers/gemini/errors.js';
import { ProviderError } from '../app/providers/contract.js';
import { SecurityError, redact } from '../app/security/redact.js';
import { parseSharedFragment } from '../app/security/shared-key.js';
import { TURN_PHASE } from '../app/state.js';
import { UI_LANGUAGE_STORAGE_KEY } from '../app/main.js';
import { collectVersionedFiles, stageRelease } from '../scripts/stage-release.mjs';
import { SECRET_PATTERNS, checkCsp, checkRelease, classifyPath, entryReferences, parseHeaders } from '../scripts/check-release.mjs';
import {
  SECRET_MARK, boot, captureConsole, leaks, live, rest, secrets, sharedFragment, until,
} from './fixtures/scenarios.mjs';

// P1-20 privacy regression (design-v0.6 §11, §17.4): where a key may exist
// and where it must never appear, proven against the real app in the fake
// browser, plus static checks of the shipped sources, headers and release.
// The marker keys are not key-shaped; the key-shaped patterns are checked
// against everything the repository could ship or log.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const KEY_SLOT = 'interp-app.personal-key.v1.gemini';
const count = (text, needle) => text.split(needle).length - 1;

async function listTree(root, { skip = () => false } = {}) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (skip(path, entry)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}
// Everything the fake browser recorded outside the two documented carriers.
function observable(b) {
  return {
    dom: b.text(), state: b.store.snapshot(), engine: b.app.engine.snapshot(), diagnostics: b.app.diagnostics.snapshot(),
    pwa: b.app.pwa.snapshot(), ops: b.ops, storage: [...(b.storage ?? [])], history: b.win.history.states, location: b.win.location,
    title: b.doc.title, restURLs: b.gemini.calls.map((call) => call.url), restBodies: b.gemini.calls.map((call) => call.body),
    socketFrames: b.sockets.map((ws) => ws.sent), notice: b.notice(),
  };
}

test('startup: the shared fragment leaves the URL and history before i18n or storage run; nothing about it is logged or kept', async (t) => {
  const console_ = captureConsole();
  t.after(console_.restore);
  const b = await boot({ hash: sharedFragment() });
  assert.equal(b.ops[0], 'replaceState:/', 'history is rewritten before anything else');
  assert.ok(b.ops.indexOf('fetch:i18n') > 0 && b.ops.indexOf(`storage.get:${UI_LANGUAGE_STORAGE_KEY}`) > 0);
  assert.deepEqual(b.win.history.states, [{ state: null, title: '', url: '/' }], 'no state object, no fragment in the rewritten entry');
  assert.equal(b.win.location.hash, '');
  assert.equal(b.gemini.calls.length + b.sockets.length, 0, 'no network before a user action');
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'shared')?.eventName, 'Sunday <b>service</b>');
  assert.equal(b.el('settings-shared-event').textContent.includes('<b>'), true, 'the event name is text, never markup');
  assert.equal(leaks(observable(b)), false);
  assert.deepEqual(console_.calls, []);
  await b.close();
  assert.equal(leaks(observable(b)), false, 'teardown leaves nothing behind');
  assert.equal(b.storage.size, 0);
});

test('shared mode: the key exists only in the REST header and the Live socket URL; never in storage, history, DOM, snapshots, frames, notices or errors', async (t) => {
  const console_ = captureConsole();
  t.after(console_.restore);
  const b = await boot({ hash: sharedFragment() });
  b.selectMode('shared');
  b.gemini.script.push(rest.error(403, { rpc: 'PERMISSION_DENIED' }), rest.translation({ translatedText: 'りんご12個' }));
  const denied = await b.submitText('사과 12개').done;
  assert.equal(denied.errorCode, 'PERMISSION_DENIED');
  const spoken = b.submitText('사과 12개');
  await until(() => b.sockets.length === 1);
  const ws = b.sockets[0];
  live.ready(ws);
  await until(() => ws.sent.length === 2);
  ws.json(live.chunk());
  ws.json(live.error(503, 'UNAVAILABLE'));
  const done = await spoken.done;
  assert.deepEqual([done.phase, done.voice.status], [TURN_PHASE.COMPLETED, 'partial']);
  // A pasted QR link through the settings form is the other entry point.
  const input = b.el('settings-shared-input');
  input.value = `https://app.example.test/${sharedFragment({ eventName: 'Evening' })}`;
  b.el('settings-shared-form').dispatch('submit');
  assert.equal(input.value, '', 'the pasted link is cleared at once');
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'shared').eventName, 'Evening');

  // The two documented carriers (§8.1: browser sockets cannot send headers).
  for (const call of b.gemini.calls) {
    assert.equal(call.headers['x-goog-api-key'], secrets.shared);
    assert.equal(call.method, 'POST');
    assert.deepEqual([call.credentials, call.referrerPolicy], ['omit', 'no-referrer']);
    assert.equal(leaks(call.url) || leaks(call.body), false, 'never in the URL or the body');
  }
  assert.equal(b.socketURLs.length, 1);
  assert.equal(b.socketURLs[0], `${LIVE_ENDPOINT}?key=${encodeURIComponent(secrets.shared)}`);
  // Everything else: nothing.
  const seen = observable(b);
  assert.equal(leaks(seen), false, 'no key outside the header and the socket URL');
  assert.equal(count(inspect(seen, { depth: 8 }), SECRET_MARK), 0);
  assert.equal(leaks(b.app), false, 'the app handle exposes no key');
  // Only UI preferences reach storage (the install hint after the first success), never a key.
  assert.deepEqual([...b.storage.keys()].filter((key) => !key.startsWith('interp-app.ui.')), [], 'shared mode persists no key');
  assert.equal(b.el('settings-shared-status').textContent, b.app.i18n.t('mode.shared'));
  assert.deepEqual(console_.calls, []);
  // Every network destination is a registered endpoint.
  for (const url of b.networkURLs) {
    assert.ok(url.startsWith(`${REST_ENDPOINT}/`) || url.startsWith(`${LIVE_ENDPOINT}?`), url.replace(/key=.*$/, 'key=…'));
  }
  await b.close();
  assert.equal(leaks(observable(b)), false);
});

test('personal key: memory only unless the user opts in; the remembered copy lives in the key-store slot alone and deletion removes it', async (t) => {
  const console_ = captureConsole();
  t.after(console_.restore);
  // Session-only: nothing persists, a reload starts without a key.
  const first = await boot();
  first.enterPersonalKey();
  assert.equal(first.el('settings-key-status').getAttribute('data-key'), 'memory');
  assert.equal(first.storage.has(KEY_SLOT), false);
  assert.equal(leaks([...first.storage]), false);
  first.gemini.script.push(rest.translation());
  first.setVoiceOutput('off');
  assert.equal((await first.submitText('사과 12개').done).phase, TURN_PHASE.COMPLETED);
  assert.equal(first.gemini.calls[0].headers['x-goog-api-key'], secrets.personal);
  assert.equal(leaks(observable(first)), false);
  first.win.dispatch('pagehide', { persisted: false });
  await until(() => first.store.closed);
  assert.equal(leaks([...first.storage]), false, 'unload leaves no key');
  const reloaded = await boot({ storage: Object.fromEntries(first.storage) });
  assert.equal(reloaded.app.config.keyStore.getMetadata('gemini', 'personal'), null);
  assert.equal(reloaded.el('settings-key-status').getAttribute('data-key'), 'none');
  await reloaded.close();

  // Opt-in: exactly one storage entry, the key-store slot, and only that value carries the key.
  const remembered = await boot();
  remembered.enterPersonalKey({ remember: true });
  assert.equal(remembered.el('settings-key-status').getAttribute('data-key'), 'remembered');
  assert.deepEqual([...remembered.storage.keys()], [KEY_SLOT]);
  assert.equal(remembered.storage.get(KEY_SLOT), secrets.personal);
  assert.equal(leaks(remembered.text()) || leaks(remembered.store.snapshot()) || leaks(remembered.ops), false, 'the DOM and state stay clean');
  await remembered.close();
  const restored = await boot({ storage: Object.fromEntries(remembered.storage) });
  assert.deepEqual(restored.app.config.keyStore.getSelection(), { providerId: 'gemini', keySource: 'personal' });
  assert.equal(restored.el('settings-key-status').getAttribute('data-key'), 'remembered');
  assert.equal(leaks(restored.text()), false);
  restored.el('settings-key-delete').dispatch('click');
  restored.el('settings-key-delete-confirm').dispatch('click');
  assert.equal(restored.storage.has(KEY_SLOT), false, 'deletion removes the stored copy');
  assert.equal(restored.app.config.keyStore.getMetadata('gemini', 'personal'), null);
  assert.equal(restored.notice(), 'settings.keyDeleted');
  await restored.close();
  // Replacing a remembered key with a session-only one drops the stored copy.
  const replaced = await boot({ storage: { [KEY_SLOT]: secrets.personal } });
  replaced.enterPersonalKey({ key: `${secrets.personal}-NEW`, remember: false });
  assert.equal(replaced.storage.has(KEY_SLOT), false);
  await replaced.close();
  assert.deepEqual(console_.calls, []);
});

test('errors carry codes only: provider messages, fragments, socket close reasons and thrown values never keep a key', () => {
  const marker = `${secrets.shared} ${SECRET_MARK}`;
  const remote = normalizeGeminiError({ status: 429, headers: new Headers({ 'retry-after': '5' }),
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: marker, details: [{ '@type': 'x', reason: marker }] } } });
  assert.equal(remote.code, 'UNKNOWN_429');
  assert.equal(remote.retryAfterMs, 5000);
  assert.equal(leaks(remote) || leaks(remote.stack) || leaks(remote.message), false);
  assert.equal(new ProviderError(marker).message, 'PROVIDER_ERROR');
  assert.equal(new SecurityError(marker).message, 'SECURITY_ERROR');
  assert.deepEqual(redact(new Error(marker)), { code: 'SECURITY_ERROR' });
  assert.deepEqual(redact({ code: 'INVALID_KEY', message: marker }), { code: 'INVALID_KEY' });
  const registry = { get: () => ({ descriptor: { browserDirect: true, credentialPolicy: { directPersonal: true, directShared: true } } }) };
  for (const fragment of [`#shared=${marker}`, `#shared=${encodeURIComponent(JSON.stringify({ version: 1, providerId: 'gemini', eventName: marker, key: 'a b' }))}`]) {
    let error;
    try { parseSharedFragment(fragment, { registry }); } catch (raw) { error = raw; }
    assert.equal(error.code, 'INVALID_SHARED_PAYLOAD');
    assert.equal(leaks(error) || leaks(error.stack), false);
  }
  assert.equal(leaks(inspect(new ProviderError('ABORTED'), { showHidden: true })), false);
});

test('no logging and no dynamic code: shipped sources never touch console, eval, markup sinks or unregistered origins', async () => {
  const versioned = await collectVersionedFiles(repoRoot);
  const sources = [...versioned.filter((file) => file.endsWith('.js')), 'sw.js'];
  const forbidden = [/\bconsole\./, /\beval\(/, /\bnew Function\(/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/,
    /\bimportScripts\(/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bdebugger\b/];
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const allowedOrigins = new Set(ENDPOINT_ORIGINS);
  for (const file of sources) {
    const code = stripComments(await readFile(join(repoRoot, file), 'utf8'));
    for (const pattern of forbidden) {
      // main.js reads localStorage once, through usableStorage, and hands it to the key store.
      if (file === 'app/main.js' && pattern.source === '\\blocalStorage\\b') continue;
      assert.equal(pattern.test(code), false, `${file} matches ${pattern}`);
    }
    for (const match of code.matchAll(/\b(?:https?|wss?):\/\/[^\s'"`)]+/g)) {
      assert.ok(allowedOrigins.has(new URL(match[0]).origin), `${file} references ${match[0]}`);
    }
    assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(code)), false, `${file} is key-shaped clean`);
    assert.equal(code.includes(SECRET_MARK), false, `${file} carries no test marker`);
  }
  const html = await readFile(join(repoRoot, 'index.html'), 'utf8');
  const entry = entryReferences(html);
  assert.ok(entry, 'no inline script, inline style or event handler in the entry');
  assert.deepEqual(entry.modules, ['./app/main.js']);
  assert.ok(entry.references.every((reference) => reference.startsWith('./')));
  // The worker skips waiting only on the page's explicit request and claims clients only then (§13.2).
  const worker = stripComments(await readFile(join(repoRoot, 'sw.js'), 'utf8'));
  assert.equal(count(worker, 'skipWaiting('), 1);
  assert.ok(worker.indexOf('self.skipWaiting()') > worker.indexOf("'interp:apply-update'"), 'skipWaiting sits in the apply-update branch');
  assert.equal(count(worker, 'clients.claim('), 1);
  assert.match(worker, /if \(applyRequested\) await self\.clients\.claim\(\)/);
  assert.doesNotMatch(worker, /cache\.add\(|cache\.addAll\(/, 'the shell is fetched with cache: reload and put explicitly');
});

test('CSP and endpoint allowlist: the headers list exactly the registered origins and nothing else', async () => {
  assert.deepEqual([...ENDPOINT_ALLOWLIST], [...GEMINI_ENDPOINTS]);
  assert.deepEqual([...ENDPOINT_ORIGINS], ['https://generativelanguage.googleapis.com', 'wss://generativelanguage.googleapis.com']);
  for (const endpoint of ENDPOINT_ALLOWLIST) {
    const url = new URL(endpoint);
    assert.ok(['https:', 'wss:'].includes(url.protocol) && !url.search && !url.hash && !url.username && !url.password, endpoint);
    assert.ok(ENDPOINT_ORIGINS.includes(url.origin));
  }
  const rules = parseHeaders(await readFile(join(repoRoot, '_headers'), 'utf8'));
  const global = rules.find((rule) => rule.path === '/*').headers;
  const csp = global.get('content-security-policy');
  assert.deepEqual(checkCsp(csp, ENDPOINT_ORIGINS), []);
  const connect = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src')).split(/\s+/).slice(1);
  assert.deepEqual(connect.sort(), ["'self'", ...ENDPOINT_ORIGINS].sort());
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|nonce-|'sha/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(global.get('permissions-policy'), /microphone=\(self\)/);
  assert.equal(global.get('referrer-policy'), 'no-referrer');
  assert.equal(global.get('x-content-type-options'), 'nosniff');
  assert.match(rules.find((rule) => rule.path === '/sw.js').headers.get('cache-control'), /no-cache/);
  // Adding or removing an origin anywhere breaks the check (the shipped config is the reference).
  assert.deepEqual(checkCsp(csp, [...ENDPOINT_ORIGINS, 'https://example.com']), ['RELEASE_CSP_MISMATCH']);
  assert.deepEqual(checkCsp(csp.replace(' wss://generativelanguage.googleapis.com', ''), ENDPOINT_ORIGINS), ['RELEASE_CSP_MISMATCH']);
});

test('release: staging the repository ships only the allowlist, passes check-release and carries no test secret or marker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'interp-rel-p1-20-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, 'release');
  const staged = await stageRelease({ id: 'p1-20', out });
  const files = await listTree(out);
  assert.deepEqual([...staged.files].sort(), files);
  for (const file of files) assert.ok(classifyPath(file), `${file} is allowlisted`);
  assert.equal(files.some((file) => /^(?:docs|tests|scripts|tools|node_modules|release|\.git|\.moai|\.claude)\//.test(file)), false);
  assert.equal(files.some((file) => /(?:^|\/)(?:package\.json|\.gitignore|README|\.env|\.DS_Store|.*\.test\.mjs|.*\.md|.*\.log)$/.test(file)), false);
  assert.ok(files.includes('releases/p1-20/app/main.js') && files.includes('releases/p1-20/app/security/key-store.js'));
  const result = await checkRelease({ dir: out });
  assert.deepEqual(result.issues, []);
  assert.deepEqual([result.ok, result.current, result.releases], [true, 'p1-20', ['p1-20']]);
  for (const file of files) {
    const text = (await readFile(join(out, file))).toString('latin1');
    assert.equal(text.includes(SECRET_MARK), false, `${file} carries no test marker`);
    assert.equal(text.includes(secrets.personal) || text.includes(secrets.shared), false, file);
    assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(text)), false, `${file} is key-shaped clean`);
  }
  assert.equal(files.filter((file) => file.startsWith('releases/p1-20/')).length, (await collectVersionedFiles(repoRoot)).length + 1);
});

test('test fixtures, test sources and build logs contain no key-shaped secret; the fixture keys are markers, not keys', async () => {
  for (const value of [secrets.personal, secrets.shared]) {
    assert.equal(SECRET_PATTERNS.some((pattern) => pattern.test(value)), false, 'fixture secrets must not look like real keys');
  }
  // The QR payload itself is what the release scan hunts for; the fixture builds it at runtime only.
  assert.equal(SECRET_PATTERNS.filter((pattern) => pattern.test(sharedFragment())).length, 1);
  const files = [
    ...(await listTree(join(repoRoot, 'tests'))).map((file) => `tests/${file}`),
    ...(await listTree(join(repoRoot, 'docs'))).filter((file) => /\.(?:md|log|json)$/.test(file)).map((file) => `docs/${file}`),
    ...(await listTree(join(repoRoot, 'scripts'))).map((file) => `scripts/${file}`),
  ];
  assert.ok(files.includes('tests/fixtures/scenarios.mjs') && files.includes('tests/privacy.test.mjs'));
  // Value-shaped patterns only: the PEM header and the QR prefix are structural
  // markers that the release checker's own source and its negative tests must spell out.
  const valuePatterns = SECRET_PATTERNS.filter((pattern) => !/PRIVATE KEY|#shared/.test(pattern.source));
  assert.equal(valuePatterns.length, SECRET_PATTERNS.length - 2);
  for (const file of files) {
    const text = await readFile(join(repoRoot, file), 'utf8');
    const hits = valuePatterns.filter((pattern) => pattern.test(text));
    assert.deepEqual(hits, [], `${file} contains a key-shaped string`);
  }
  // Nothing key-like sits at the repository root either (.env files, exports).
  const root = await readdir(repoRoot);
  assert.equal(root.some((name) => /^\.env/.test(name) || /\.(?:pem|key|p12)$/.test(name)), false);
});

// Product gap found by this regression (report for the P1-05/P1-12 owners):
// when the Live socket closes abruptly (network drop, code 1006) the session
// manager aborts the in-flight speak in the same task as the adapter's error,
// so the engine sees ABORTED, records the line as "cancelled" and neither
// falls back to device speech (before audio) nor reports it partial (after
// audio). Nothing leaks, but the user reads a cancellation they never made.
test('network drop on the Live socket falls back to device speech before audio and reports partial after audio',
  { todo: 'session-manager/voice engine treat a closed-event abort as a user cancel; fix belongs to P1-05/P1-12' }, async (t) => {
    const console_ = captureConsole();
    t.after(console_.restore);
    const b = await boot();
    b.enterPersonalKey();
    b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
    const first = b.submitText('사과 12개');
    await until(() => b.sockets.length === 1);
    live.ready(b.sockets[0]);
    await until(() => b.sockets[0].sent.length === 2);
    b.sockets[0].finishClose(1006, `${SECRET_MARK} dropped`);
    const dropped = await first.done;
    assert.equal(leaks(observable(b)), false);
    await b.close();
    assert.deepEqual(console_.calls, []);
    assert.deepEqual([dropped.voice.status, dropped.voice.engine, dropped.voice.fallback], ['completed', 'device', true]);
  });
