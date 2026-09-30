import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS } from '../scripts/check-release.mjs';
import {
  CONTENT_SECURITY_POLICY, DEFAULT_KEY_FILE, EXTENSION_FOLDER, MANUALS, README_NAME, SITE_SOURCE_FILES,
  checkZipEntries, latestJson, localDate, parseArguments, printUrl, readmeText, vercelConfig,
} from '../scripts/package-extension.mjs';
import { CONTENT, LANGS, OSES, SITE, manualFile } from '../extension-site/content.js';

// docs/extension-install.md: the member package (scripts/package-extension.mjs) and the download site
// (extension-site/). Pure helpers and the page content only: nothing here builds, zips, prints or serves.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// --- latest.json, vercel.json ---------------------------------------------------------------------------------------

test('latest.json has exactly version, released, download and page, pointing at the public site', () => {
  const value = latestJson({ version: '0.2.0', released: '2026-09-30' });
  assert.deepEqual(Object.keys(value), ['version', 'released', 'download', 'page']);
  assert.deepEqual(value, {
    version: '0.2.0',
    released: '2026-09-30',
    download: 'https://kc-live-interpreter.vercel.app/live-interpreter.zip',
    page: 'https://kc-live-interpreter.vercel.app/',
  });
  for (const bad of [{}, { version: 'v0.2', released: '2026-09-30' }, { version: '0.2.0', released: '30/09/2026' }, { version: '1', released: '2026-09-30' }]) {
    assert.throws(() => latestJson(bad), /^Error: PACKAGE_(?:VERSION|DATE)_INVALID$/);
  }
});

test('vercel.json: CORS and no-cache on latest.json, no-cache on the zip and manuals, nosniff/no-referrer/noindex everywhere', () => {
  const { headers } = vercelConfig();
  const rule = (source) => Object.fromEntries(headers.find((entry) => entry.source === source).headers.map(({ key, value }) => [key, value]));
  assert.deepEqual(rule('/latest.json'), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
  assert.equal(rule('/live-interpreter.zip')['Cache-Control'], 'no-cache');
  assert.equal(rule('/manuals/(.*)')['Cache-Control'], 'no-cache');
  const all = rule('/(.*)');
  assert.equal(all['X-Content-Type-Options'], 'nosniff');
  assert.equal(all['Referrer-Policy'], 'no-referrer');
  assert.equal(all['X-Robots-Tag'], 'noindex, nofollow');
  // The CSP is the page's only: on a PDF it would also govern Chrome's built-in viewer.
  assert.equal(all['Content-Security-Policy'], undefined);
  assert.equal(rule('/')['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
  assert.equal(rule('/index.html')['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
  assert.equal(headers.filter((entry) => entry.headers.some(({ key }) => key === 'Content-Security-Policy')).length, 2);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe/);
});

// --- manuals, README, zip layout ------------------------------------------------------------------------------------

test('six manuals, one per OS and language, with unique ASCII names', () => {
  assert.equal(MANUALS.length, 6);
  const names = MANUALS.map((manual) => manual.name);
  assert.equal(new Set(names).size, 6);
  for (const name of names) assert.match(name, /^Manual-(?:Windows|Mac)-(?:KO|JA|EN)\.pdf$/);
  assert.equal(manualFile('win', 'ko'), 'Manual-Windows-KO.pdf');
  assert.equal(manualFile('mac', 'ja'), 'Manual-Mac-JA.pdf');
});

test('README.txt: BOM, CRLF, every manual name, the folder to load and the site address', () => {
  const text = readmeText({ version: '0.2.0' });
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.ok(text.includes('\r\n'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  assert.ok(text.includes('Live Interpreter 0.2.0'));
  assert.ok(text.includes(`${SITE.origin}/`));
  for (const manual of MANUALS) assert.ok(text.includes(manual.name), manual.name);
  assert.equal(text.split(EXTENSION_FOLDER).length - 1, 3, 'the folder is named once per language');
});

const GOOD_ZIP = [
  `${EXTENSION_FOLDER}/`, `${EXTENSION_FOLDER}/manifest.json`, `${EXTENSION_FOLDER}/extension/lib/builtin-key.js`,
  `${EXTENSION_FOLDER}/_locales/ko/messages.json`, README_NAME, ...MANUALS.map((manual) => manual.name),
];

test('zip layout: the good layout passes', () => {
  assert.deepEqual(checkZipEntries(GOOD_ZIP), []);
});

test('zip layout: a missing manifest, manual or README, a wrapper folder, junk and non-ASCII names are all reported', () => {
  assert.ok(checkZipEntries(GOOD_ZIP.filter((entry) => !entry.endsWith('manifest.json'))).includes('MANIFEST_MISSING'));
  assert.ok(checkZipEntries(GOOD_ZIP.filter((entry) => entry !== 'Manual-Mac-EN.pdf')).includes('MANUAL_MISSING Manual-Mac-EN.pdf'));
  assert.ok(checkZipEntries(GOOD_ZIP.filter((entry) => entry !== README_NAME)).includes('README_MISSING'));
  const wrapped = GOOD_ZIP.map((entry) => `live-interpreter/${entry}`);
  assert.ok(checkZipEntries(wrapped).includes('MANIFEST_MISSING'));
  assert.ok(checkZipEntries(wrapped).some((problem) => problem.startsWith('UNEXPECTED ')));
  assert.deepEqual(checkZipEntries([...GOOD_ZIP, `${EXTENSION_FOLDER}/.DS_Store`]), [`JUNK ${EXTENSION_FOLDER}/.DS_Store`]);
  assert.deepEqual(checkZipEntries([...GOOD_ZIP, `${EXTENSION_FOLDER}/.interp-extension-build`]), [`JUNK ${EXTENSION_FOLDER}/.interp-extension-build`]);
  assert.deepEqual(checkZipEntries([...GOOD_ZIP, '__MACOSX/x']), ['UNEXPECTED __MACOSX/x', 'JUNK __MACOSX/x']);
  assert.deepEqual(checkZipEntries([...GOOD_ZIP, `${EXTENSION_FOLDER}/설명.txt`]), [`NON_ASCII ${EXTENSION_FOLDER}/설명.txt`]);
  assert.deepEqual(checkZipEntries([...GOOD_ZIP, 'notes.txt']), ['UNEXPECTED notes.txt']);
  assert.ok(checkZipEntries(null).includes('MANIFEST_MISSING'));
});

// --- CLI arguments, dates, print URLs -------------------------------------------------------------------------------

test('arguments: defaults, each flag once with a value, a well-formed date', () => {
  assert.deepEqual({ ...parseArguments([]) }, { builtinKeyFile: DEFAULT_KEY_FILE, chrome: null, released: null });
  assert.deepEqual({ ...parseArguments(['--builtin-key-file', '/k', '--chrome', '/c', '--released', '2026-10-01']) },
    { builtinKeyFile: '/k', chrome: '/c', released: '2026-10-01' });
  for (const bad of [['--zip'], ['--chrome'], ['--chrome', '--released'], ['--chrome', '/a', '--chrome', '/b'], ['--released', '2026-9-1'], 'x']) {
    assert.throws(() => parseArguments(bad), /^Error: PACKAGE_ARGUMENT_INVALID$/);
  }
  assert.match(DEFAULT_KEY_FILE, /\.config[\\/]interp-app[\\/]builtin-key$/);
});

test('localDate is the local calendar date; printUrl carries lang, os, print, version and released', () => {
  assert.equal(localDate(new Date(2026, 8, 30, 23, 59)), '2026-09-30');
  assert.equal(localDate(new Date(2027, 0, 5)), '2027-01-05');
  const url = new URL(printUrl('http://127.0.0.1:1234', { os: 'mac', lang: 'ja', version: '0.2.0', released: '2026-09-30' }));
  assert.equal(url.origin, 'http://127.0.0.1:1234');
  assert.deepEqual(Object.fromEntries(url.searchParams), { lang: 'ja', os: 'mac', print: '1', version: '0.2.0', released: '2026-09-30' });
});

// --- page content ---------------------------------------------------------------------------------------------------

const MARKUP_KINDS = new Set(['btn', 'toggle', 'kbd', 'folder', 'link', 'puzzle', 'pin', 'reload', 'ext']);
const BARE_KINDS = new Set(['puzzle', 'pin', 'reload', 'ext']);

function* strings(value, path = '') {
  if (typeof value === 'string') { yield [path, value]; return; }
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) yield* strings(item, `${path}[${index}]`); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`);
}

const perOs = (value, os) => (value && !Array.isArray(value) && typeof value === 'object' && ('win' in value || 'mac' in value) ? value[os] : value);
const itemsFor = (list, os) => (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' || !(('win' in item) || ('mac' in item)) || typeof item[os] === 'string');
const textOf = (item, os) => (typeof item === 'string' ? item : (item.text ?? item[os]) + (item.note ? ` ${item.note}` : ''));

test('content: the three languages have the same UI keys and the same sections, steps, bullets and FAQ per OS', () => {
  assert.deepEqual([...LANGS], ['ko', 'ja', 'en']);
  assert.deepEqual([...OSES], ['win', 'mac']);
  const shape = (lang) => {
    const { ui, sections } = CONTENT[lang];
    return {
      ui: Object.keys(ui).sort(),
      icons: Object.keys(ui.icons).sort(),
      os: Object.keys(ui.os).sort(),
      sections: sections.map((section) => ({
        id: section.id,
        paras: (section.paras ?? []).length,
        intro: OSES.map((os) => typeof perOs(section.intro, os)),
        steps: OSES.map((os) => itemsFor(perOs(section.steps, os), os).length),
        notes: OSES.map((os) => itemsFor(perOs(section.steps, os), os).filter((item) => typeof item === 'object' && item.note).length),
        bullets: OSES.map((os) => itemsFor(perOs(section.bullets, os), os).length),
        faq: (section.faq ?? []).map((entry) => entry.os ?? 'all'),
      })),
    };
  };
  assert.deepEqual(shape('ja'), shape('ko'));
  assert.deepEqual(shape('en'), shape('ko'));
  assert.deepEqual(CONTENT.ko.sections.map((section) => section.id), ['about', 'install', 'first-use', 'language', 'key', 'update', 'notes', 'trouble']);
});

test('content: every inline token is a known kind, and bold and code marks are balanced', () => {
  for (const lang of LANGS) {
    for (const [path, text] of strings(CONTENT[lang])) {
      for (const match of text.matchAll(/\[([a-z]+)(:[^\]]*)?\]/g)) {
        assert.ok(MARKUP_KINDS.has(match[1]), `${lang}${path}: unknown token ${match[0]}`);
        assert.equal(match[2] === undefined, BARE_KINDS.has(match[1]), `${lang}${path}: ${match[0]} value presence`);
      }
      assert.equal(text.split('**').length % 2, 1, `${lang}${path}: unbalanced **`);
      assert.equal(text.split('`').length % 2, 1, `${lang}${path}: unbalanced backtick`);
    }
  }
});

test('content: install says which folder to pick and where to go, update names the reload, for both OSes and all languages', () => {
  for (const lang of LANGS) {
    const section = (id) => CONTENT[lang].sections.find((entry) => entry.id === id);
    for (const os of OSES) {
      const install = itemsFor(perOs(section('install').steps, os), os).map((item) => textOf(item, os)).join('\n');
      assert.ok(install.includes(`[folder:${EXTENSION_FOLDER}]`), `${lang}/${os} install names the folder`);
      assert.ok(install.includes('`chrome://extensions`'), `${lang}/${os} install names chrome://extensions`);
      assert.ok(install.includes('[toggle:'), `${lang}/${os} install shows the developer-mode toggle`);
      assert.ok(install.includes('[pin]') && install.includes('[puzzle]'), `${lang}/${os} install pins the icon`);
      const update = itemsFor(perOs(section('update').steps, os), os).map((item) => textOf(item, os)).join('\n');
      assert.ok(update.includes('[reload]'), `${lang}/${os} update shows the reload button`);
      assert.ok(update.includes(`[folder:${EXTENSION_FOLDER}]`) || update.includes('live-interpreter'), `${lang}/${os} update says where`);
    }
    const trouble = section('trouble').faq.map((entry) => entry.a).join('\n');
    assert.ok(trouble.includes('`manifest.json`') && trouble.includes('`extension`'), `${lang} troubleshooting explains the wrong-folder error`);
  }
});

test('content: links are https to the web app or AI Studio only', () => {
  const allowed = new Set(['interp-app.vercel.app', 'aistudio.google.com']);
  let count = 0;
  for (const lang of LANGS) {
    for (const [path, text] of strings(CONTENT[lang])) {
      for (const match of text.matchAll(/\[link:([^\]]+)\]/g)) {
        const url = new URL(match[1]);
        assert.equal(url.protocol, 'https:', `${lang}${path}`);
        assert.ok(allowed.has(url.hostname), `${lang}${path}: ${url.hostname}`);
        count += 1;
      }
    }
  }
  assert.equal(count, 6, 'two links per language');
  assert.equal(SITE.origin, 'https://kc-live-interpreter.vercel.app');
  assert.equal(SITE.zip, 'live-interpreter.zip');
});

// --- site sources ---------------------------------------------------------------------------------------------------

test('site sources: no key-shaped string, no inline script, and the page loads its own stylesheet and module', async () => {
  for (const file of SITE_SOURCE_FILES) {
    const text = await readFile(join(repoRoot, 'extension-site', file), 'utf8');
    const hits = SECRET_PATTERNS.filter((pattern) => pattern.test(text));
    assert.deepEqual(hits, [], `extension-site/${file} contains a key-shaped string`);
  }
  const html = await readFile(join(repoRoot, 'extension-site', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="site\.js"/);
  assert.equal(scripts[0][2].trim(), '', 'no inline script body');
  assert.match(html, /<link rel="stylesheet" href="site\.css">/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  const js = await readFile(join(repoRoot, 'extension-site', 'site.js'), 'utf8');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), false, 'text goes in through textContent/createElement only');
});
