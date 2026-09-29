// New implementation of docs/extension.md §11.1 (extension-i18n-loader); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyI18n } from '../extension/lib/dom-i18n.js';
import { createFallbackI18n, loadExtensionI18n } from '../extension/lib/i18n.js';
import { parseHtml } from './fixtures/extension-dom.mjs';

// Section 9.5: the loader merges app and ext dictionaries per language over an INJECTED fetch (here: file: URLs of the
// real dictionaries), negotiates the language without reading a global, and fails with a bare I18N_LOAD_FAILED.

const readJson = async (url) => JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
const LANGUAGES = ['ko', 'en', 'ja'];

// A fetch over the real files; `edit(path, dictionary)` may change a parsed dictionary, `fail(path)` may break a request.
function fileFetch({ edit = (_path, dictionary) => dictionary, fail = () => null } = {}) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    const path = String(url).replace(/^.*\/(app\/i18n|extension\/i18n)\//, '$1/');
    const broken = fail(path);
    if (broken === 'reject') throw new Error('network down');
    if (broken === 'status') return { ok: false, status: 404, json: async () => ({}) };
    if (broken === 'json') return { ok: true, json: async () => { throw new SyntaxError('bad json'); } };
    if (broken === 'array') return { ok: true, json: async () => [] };
    return { ok: true, json: async () => edit(path, await readJson(url)) };
  };
  return Object.assign(fetcher, { requests });
}

test('loadExtensionI18n merges the app and extension dictionaries and requests all six files without credentials', async () => {
  const fetcher = fileFetch();
  const i18n = await loadExtensionI18n({ fetch: fetcher, language: 'ko' });
  assert.equal(i18n.language, 'ko');
  assert.equal(fetcher.requests.length, 6);
  for (const language of LANGUAGES) {
    assert.ok(fetcher.requests.some((r) => r.url.endsWith(`/app/i18n/${language}.json`)), `app ${language}`);
    assert.ok(fetcher.requests.some((r) => r.url.endsWith(`/extension/i18n/${language}.json`)), `ext ${language}`);
  }
  for (const request of fetcher.requests) assert.equal(request.init.credentials, 'omit');
  const ko = await readJson(new URL('../extension/i18n/ko.json', import.meta.url));
  const app = await readJson(new URL('../app/i18n/ko.json', import.meta.url));
  assert.equal(i18n.t('ext.name'), ko['ext.name']);
  assert.equal(i18n.t('common.start'), app['common.start']);
  assert.ok(i18n.has('ext.lane.tab.title'));
  assert.ok(i18n.has('sim.status.idle'));
  assert.equal(i18n.setLanguage('en'), 'en');
  assert.notEqual(i18n.t('ext.name'), ko['ext.name']);
});

test('language negotiation: language beats languages, an invalid language falls back to languages, then English', async () => {
  assert.equal((await loadExtensionI18n({ fetch: fileFetch(), language: 'ja', languages: ['ko'] })).language, 'ja');
  assert.equal((await loadExtensionI18n({ fetch: fileFetch(), language: 'fr', languages: ['ko-KR', 'en'] })).language, 'ko');
  assert.equal((await loadExtensionI18n({ fetch: fileFetch(), languages: ['de', 'ja-JP'] })).language, 'ja');
  assert.equal((await loadExtensionI18n({ fetch: fileFetch(), languages: ['de'] })).language, 'en');
  assert.equal((await loadExtensionI18n({ fetch: fileFetch() })).language, 'en');
});

test('per key the chain is current language, then English, then error.unknown; unknown keys are never echoed', async () => {
  const fetcher = fileFetch({ edit: (path, dictionary) => {
    if (path === 'extension/i18n/ko.json') { const { 'ext.arm.ready': _dropped, ...rest } = dictionary; return rest; }
    return dictionary;
  } });
  const i18n = await loadExtensionI18n({ fetch: fetcher, language: 'ko' });
  const en = await readJson(new URL('../extension/i18n/en.json', import.meta.url));
  assert.equal(i18n.t('ext.arm.ready'), en['ext.arm.ready'], 'falls back to English for that key only');
  const app = await readJson(new URL('../app/i18n/ko.json', import.meta.url));
  assert.equal(i18n.t('ext.no.such.key'), app['error.unknown'], 'in the current language');
  assert.equal(i18n.has('ext.no.such.key'), false);
  assert.equal(i18n.t('../../etc/passwd').includes('passwd'), false);
});

test('I18N_LOAD_FAILED for every kind of broken input, and the error retains no cause, URL or body', async () => {
  const breakers = {
    'http error': fileFetch({ fail: (path) => (path === 'extension/i18n/ja.json' ? 'status' : null) }),
    'invalid JSON': fileFetch({ fail: (path) => (path === 'app/i18n/en.json' ? 'json' : null) }),
    'not an object': fileFetch({ fail: (path) => (path === 'app/i18n/ko.json' ? 'array' : null) }),
    'fetch rejects': fileFetch({ fail: (path) => (path === 'extension/i18n/en.json' ? 'reject' : null) }),
    'blank value': fileFetch({ edit: (path, dictionary) => (path === 'extension/i18n/ko.json' ? { ...dictionary, 'ext.name': '   ' } : dictionary) }),
    'non-string value': fileFetch({ edit: (path, dictionary) => (path === 'app/i18n/ja.json' ? { ...dictionary, 'common.start': 7 } : dictionary) }),
    'missing error.unknown': fileFetch({ edit: (path, dictionary) => {
      if (path !== 'app/i18n/en.json') return dictionary;
      const { 'error.unknown': _dropped, ...rest } = dictionary;
      return rest;
    } }),
    'key without the ext. prefix': fileFetch({ edit: (path, dictionary) => (path === 'extension/i18n/en.json' ? { ...dictionary, 'common.start': 'x' } : dictionary) }),
    'no fetch at all': undefined,
  };
  for (const [name, fetcher] of Object.entries(breakers)) {
    const error = await loadExtensionI18n({ fetch: fetcher ?? null, language: 'en' }).then(() => null, (thrown) => thrown);
    assert.ok(error instanceof Error, name);
    assert.equal(error.message, 'I18N_LOAD_FAILED', name);
    assert.equal(error.cause, undefined, `${name}: no cause`);
    assert.equal(Object.keys(error).length, 0, `${name}: no extra fields`);
  }
});

test('an abort rejects the whole load the same way, before and during the fetches', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(loadExtensionI18n({ fetch: fileFetch(), signal: before.signal }), { message: 'I18N_LOAD_FAILED' });

  const during = new AbortController();
  const held = () => new Promise(() => {});   // a fetch that never answers, and ignores its signal
  const pending = loadExtensionI18n({ fetch: held, signal: during.signal });
  during.abort();
  await assert.rejects(pending, { message: 'I18N_LOAD_FAILED' });
});

test('createFallbackI18n renders the three-key English boot dictionary and never a blank', () => {
  const i18n = createFallbackI18n({ language: 'ko' });
  assert.equal(i18n.language, 'ko');
  assert.equal(i18n.has('error.unknown'), true);
  assert.equal(i18n.has('ext.name'), false);
  assert.ok(i18n.t('ext.name').length > 0, 'an unknown key renders error.unknown');
  assert.equal(i18n.t('ext.name'), i18n.t('error.unknown'));
  assert.equal(createFallbackI18n().language, 'en');
});

// The strings added for the review fixes must reach the pages THROUGH the loader (the merged app + ext dictionaries),
// in every language, from the extension file and not from an app key of the same idea.
test('the keys added for the review fixes resolve through the loader in ko, en and ja, and are ext.* keys the app does not have', async () => {
  const added = {
    'ext.status.off': { ko: '꺼져 있어요', en: 'Off', ja: 'オフ' },
    'ext.route.fallbackNote': {
      ko: '예비 모델이 통역 중이에요. 들리는 말에 통역 대신 대답할 수 있어요.',
      en: 'A backup model is interpreting. It may answer what it hears instead of translating.',
      ja: '予備モデルが通訳しています。聞こえた内容を通訳せずに返答することがあります。',
    },
    'ext.key.savedBrowser': { ko: '키를 이 브라우저에 저장했어요.', en: 'Key saved in this browser.', ja: 'キーをこのブラウザに保存しました。' },
    'ext.options.modelLive': { ko: 'Gemini 3.8 Live', en: 'Gemini 3.8 Live', ja: 'Gemini 3.8 Live' },
  };
  for (const language of LANGUAGES) {
    const i18n = await loadExtensionI18n({ fetch: fileFetch(), language });
    const app = await readJson(new URL(`../app/i18n/${language}.json`, import.meta.url));
    for (const [key, values] of Object.entries(added)) {
      assert.equal(i18n.has(key), true, `${language} ${key} is known`);
      assert.equal(i18n.t(key), values[language], `${language} ${key}`);
      assert.equal(Object.hasOwn(app, key), false, `${key} is not an app key`);
    }
  }
  // A dictionary that lacks one of them falls back to English for that key only, never to the raw key.
  const missing = fileFetch({ edit: (path, dictionary) => {
    if (path !== 'extension/i18n/ko.json') return dictionary;
    const { 'ext.status.off': _dropped, ...rest } = dictionary;
    return rest;
  } });
  const ko = await loadExtensionI18n({ fetch: missing, language: 'ko' });
  assert.equal(ko.t('ext.status.off'), 'Off');
  assert.equal(ko.t('ext.key.savedBrowser'), '키를 이 브라우저에 저장했어요.');
});

// Two-way mode: the five ext.twoWay.* strings reach the panel through the loader in every language (the extension had no
// two-way key before, and a test used to assert exactly that).
const TWO_WAY = {
  'ext.twoWay.label': { ko: '양방향 통역', en: 'Two-way interpretation', ja: '双方向通訳' },
  'ext.twoWay.partner': { ko: '상대 언어', en: 'Other language', ja: '相手の言語' },
  'ext.twoWay.targetLabel': { ko: '첫 번째 언어', en: 'First language', ja: '1つ目の言語' },
  'ext.twoWay.hint': {
    ko: '두 언어를 서로 통역해요. 두 언어로 말이 오가는 자리에 알맞아요.',
    en: 'Interprets between the two languages in both directions, for a conversation in both.',
    ja: '2つの言語を相互に通訳します。2つの言語で会話する場面に向いています。',
  },
  'ext.twoWay.modelNote': {
    ko: '양방향은 통역 전용 모델을 쓸 수 없어서 이 레인은 Gemini 3.8 Live를 써요.',
    en: 'Two-way cannot use the translation-only model, so this lane uses Gemini 3.8 Live.',
    ja: '双方向では翻訳専用モデルを使えないため、このレーンはGemini 3.8 Liveを使います。',
  },
};

test('the two-way keys resolve through the loader in ko, en and ja, are ext.* keys the app does not have, and fall back to English per key', async () => {
  for (const language of LANGUAGES) {
    const i18n = await loadExtensionI18n({ fetch: fileFetch(), language });
    const app = await readJson(new URL(`../app/i18n/${language}.json`, import.meta.url));
    for (const [key, values] of Object.entries(TWO_WAY)) {
      assert.equal(i18n.has(key), true, `${language} ${key} is known`);
      assert.equal(i18n.t(key), values[language], `${language} ${key}`);
      assert.equal(Object.hasOwn(app, key), false, `${key} is not an app key`);
    }
  }
  const missing = fileFetch({ edit: (path, dictionary) => {
    if (path !== 'extension/i18n/ja.json') return dictionary;
    const { 'ext.twoWay.modelNote': _dropped, ...rest } = dictionary;
    return rest;
  } });
  const ja = await loadExtensionI18n({ fetch: missing, language: 'ja' });
  assert.equal(ja.t('ext.twoWay.modelNote'), TWO_WAY['ext.twoWay.modelNote'].en, 'a missing key falls back to English, never to the raw key');
  assert.equal(ja.t('ext.twoWay.hint'), TWO_WAY['ext.twoWay.hint'].ja, 'the other keys stay in Japanese');
});

test('all 122 ext.* keys of every language resolve through the loader, and the languages carry the same key set', async () => {
  const keysOf = async (language) => Object.keys(await readJson(new URL(`../extension/i18n/${language}.json`, import.meta.url)));
  const reference = (await keysOf('en')).sort();
  assert.equal(reference.length, 122, '117 + the five two-way keys');
  for (const language of LANGUAGES) {
    assert.deepEqual((await keysOf(language)).sort(), reference, `${language} has the key set of en`);
    const i18n = await loadExtensionI18n({ fetch: fileFetch(), language });
    for (const key of reference) assert.equal(i18n.has(key), true, `${language} ${key}`);
  }
});

test('applyI18n fills the two-way lines of the real panel markup in each language and keeps them through a language change', async () => {
  const markup = await readFile(new URL('../extension/panel/panel.html', import.meta.url), 'utf8');
  const document = parseHtml(markup);
  const i18n = await loadExtensionI18n({ fetch: fileFetch(), language: 'en' });
  const read = (id) => document.getElementById(id).textContent;
  applyI18n(document, i18n);
  for (const lane of ['tab', 'mic']) {
    assert.equal(read(`${lane}-two-way-hint`), TWO_WAY['ext.twoWay.hint'].en);
    assert.equal(read(`${lane}-two-way-note`), TWO_WAY['ext.twoWay.modelNote'].en);
    assert.equal(document.getElementById(`${lane}-two-way`).closest('label').querySelector('span').textContent, TWO_WAY['ext.twoWay.label'].en);
    assert.equal(document.getElementById(`${lane}-partner`).closest('label').querySelector('span').textContent, TWO_WAY['ext.twoWay.partner'].en);
  }
  // The controller puts the two-way key on the first select's label; the binder must then keep it in the right language.
  document.getElementById('tab-target-label').setAttribute('data-i18n', 'ext.twoWay.targetLabel');
  for (const language of ['ko', 'ja']) {
    i18n.setLanguage(language);
    applyI18n(document, i18n);
    assert.equal(read('tab-target-label'), TWO_WAY['ext.twoWay.targetLabel'][language], language);
    assert.equal(read('tab-two-way-hint'), TWO_WAY['ext.twoWay.hint'][language], language);
    assert.equal(read('mic-two-way-note'), TWO_WAY['ext.twoWay.modelNote'][language], language);
    assert.equal(read('mic-target-label'), i18n.t('language.target'), 'a label the controller did not switch stays the one-way label');
  }
});

const SKELETON = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title data-i18n="ext.name"></title></head><body>
<h1 id="h" data-i18n="ext.name"></h1>
<button id="b" type="button" data-i18n-label="permission.request" data-i18n-tip="permission.request"></button>
<input id="i" type="text" data-i18n-hint="settings.keyPlaceholder">
<select id="s"><option id="o" value="ko" data-i18n="language.ko"></option></select>
<p id="plain">unbound</p></body></html>`;

test('applyI18n sets text, aria-label, title, placeholder, document title and html lang, and is idempotent', async () => {
  const document = parseHtml(SKELETON);
  const fetcher = fileFetch();
  const i18n = await loadExtensionI18n({ fetch: fetcher, language: 'ko' });
  applyI18n(document, i18n);
  const ko = await readJson(new URL('../extension/i18n/ko.json', import.meta.url));
  const app = await readJson(new URL('../app/i18n/ko.json', import.meta.url));
  assert.equal(document.getElementById('h').textContent, ko['ext.name']);
  assert.equal(document.getElementById('b').getAttribute('aria-label'), app['permission.request']);
  assert.equal(document.getElementById('b').getAttribute('title'), app['permission.request']);
  assert.equal(document.getElementById('i').getAttribute('placeholder'), app['settings.keyPlaceholder']);
  assert.equal(document.getElementById('o').textContent, app['language.ko']);
  assert.equal(document.title, ko['ext.name']);
  assert.equal(document.documentElement.getAttribute('lang'), 'ko');
  assert.equal(document.getElementById('plain').textContent, 'unbound');

  applyI18n(document, i18n);   // idempotent
  assert.equal(document.getElementById('h').textContent, ko['ext.name']);
  assert.equal(document.documentElement.getAttribute('lang'), 'ko');

  i18n.setLanguage('ja');
  applyI18n(document, i18n);   // a language change is just another call
  const ja = await readJson(new URL('../extension/i18n/ja.json', import.meta.url));
  assert.equal(document.getElementById('h').textContent, ja['ext.name']);
  assert.equal(document.documentElement.getAttribute('lang'), 'ja');
  assert.equal(document.title, ja['ext.name']);
});

test('applyI18n on an element root binds only its subtree and leaves the document title alone; bad input is ignored', async () => {
  const document = parseHtml(SKELETON);
  const i18n = await loadExtensionI18n({ fetch: fileFetch(), language: 'en' });
  const section = document.createElement('section');
  const label = document.createElement('span');
  label.setAttribute('data-i18n', 'common.start');
  section.append(label);
  document.body.append(section);
  const before = document.title;
  applyI18n(section, i18n);
  assert.equal(label.textContent, i18n.t('common.start'));
  assert.equal(document.title, before);
  assert.doesNotThrow(() => applyI18n(null, i18n));
  assert.doesNotThrow(() => applyI18n(document, null));
  assert.doesNotThrow(() => applyI18n({}, i18n));
});
