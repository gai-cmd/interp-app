import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { EXTENSION_KEY_PREFIX, checkI18n, checkSource, validateDictionaries } from '../scripts/check-i18n.mjs';

// docs/extension.md §11.1 (group A, M0), starting from the prototype of Appendix C.
// The first three tests use fixture roots in temp directories (fake dictionaries built
// here, nothing from extension/). The last two read only group A's own
// extension/_locales files; everything that needs the rest of the real tree (the
// ext.* mirror rule of §9.3, getMessage literals) lives in tests/extension-tree.test.mjs (M3).

const app = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));
const ext = { en: { 'ext.a.one': 'One {n}', 'ext.a.two': 'Two' }, ko: { 'ext.a.one': '하나 {n}', 'ext.a.two': '둘' },
  ja: { 'ext.a.one': '一 {n}', 'ext.a.two': '二' } };
const options = { requireErrorKeys: false, keyPrefix: EXTENSION_KEY_PREFIX };

async function fixture(t, { extension = ext, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'interp-ext-i18n-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app/i18n'), { recursive: true });
  for (const language of SUPPORTED_LANGUAGES) await writeFile(join(root, `app/i18n/${language}.json`), JSON.stringify(app[language]));
  if (extension) {
    await mkdir(join(root, 'extension/i18n'), { recursive: true });
    for (const language of SUPPORTED_LANGUAGES) await writeFile(join(root, `extension/i18n/${language}.json`), JSON.stringify(extension[language]));
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const codes = (result) => result.issues.map((issue) => typeof issue === 'string' ? issue : issue.code);

test('extension dictionaries: parity, placeholders and the ext. prefix are enforced without the app error keys', () => {
  assert.deepEqual(validateDictionaries(ext, options), []);
  assert.ok(validateDictionaries(ext).includes('I18N_MISSING_ERROR'), 'default mode still demands the app error keys');
  const mutate = (fn) => { const d = structuredClone(ext); fn(d); return validateDictionaries(d, options); };
  assert.ok(mutate((d) => { delete d.ja['ext.a.two']; }).includes('I18N_KEY_MISMATCH'));
  assert.ok(mutate((d) => { d.ko['ext.a.one'] = '하나 {m}'; }).includes('I18N_PLACEHOLDER_MISMATCH'));
  assert.ok(mutate((d) => { for (const v of Object.values(d)) { v['plain.key'] = 'x'; } }).includes('I18N_KEY_PREFIX'));
});

test('checker skips a tree without extension/, and validates one that has it', async (t) => {
  assert.equal((await checkI18n({ root: await fixture(t, { extension: null }) })).ok, true);
  const root = await fixture(t, { files: { 'extension/sidepanel/panel.js': "el.textContent = i18n.t('ext.a.one'); bind.text(el, 'ext.a.two'); i18n.t('common.start');" } });
  const result = await checkI18n({ root });
  assert.deepEqual([result.ok, result.issues], [true, []]);
});

test('extension sources are checked against the union of app and extension keys; the app never sees ext keys', async (t) => {
  for (const [source, code] of [
    ["i18n.t('ext.a.missing')", 'I18N_UNKNOWN_UI_KEY'],
    ["bind.text(el, 'ext.a.typo')", 'I18N_UNKNOWN_UI_KEY'],
    ["i18n.t('sim.doesNotExist')", 'I18N_UNKNOWN_UI_KEY'],
    ["el.textContent = 'Start'", 'I18N_LITERAL_UI_TEXT'],
  ]) {
    const root = await fixture(t, { files: { 'extension/x.js': source } });
    assert.ok(codes(await checkI18n({ root })).includes(code), source);
  }
  const html = await fixture(t, { files: { 'extension/sidepanel/panel.html': '<button>Start</button>' } });
  assert.ok(codes(await checkI18n({ root: html })).includes('I18N_LITERAL_UI_TEXT'));
  const appUse = await fixture(t, { files: { 'app/ui/x.js': "i18n.t('ext.a.one')" } });
  assert.ok(codes(await checkI18n({ root: appUse })).includes('I18N_UNKNOWN_UI_KEY'), 'web app code may not use an extension key');
  // A collision is only possible if an app key starts with ext.; simulate it by adding one to the app dictionaries.
  const withApp = await fixture(t, { extension: ext });
  for (const language of SUPPORTED_LANGUAGES) {
    const dictionary = JSON.parse(await readFile(join(withApp, `app/i18n/${language}.json`), 'utf8'));
    dictionary['ext.a.one'] = 'clash {n}';
    await writeFile(join(withApp, `app/i18n/${language}.json`), JSON.stringify(dictionary));
  }
  assert.ok(codes(await checkI18n({ root: withApp })).includes('I18N_KEY_COLLISION'));
  const badExt = structuredClone(ext); delete badExt.ja['ext.a.two'];
  assert.ok(codes(await checkI18n({ root: await fixture(t, { extension: badExt }) })).includes('I18N_KEY_MISMATCH'));
  assert.deepEqual(checkSource("t('ext.a.one')", { ...app.en, ...ext.en }, { literalPrefix: 'ext.' }), []);
  assert.deepEqual(checkSource("const s = `ext.status.${state}`;", { ...app.en }, { literalPrefix: 'ext.' }), [], 'dynamic keys are not literals');
});

// --- group A's own _locales files (§9.3): the only real-tree reads of this file ---

// The twelve message names of §9.3 (the table of what the manifest, the SW and the overlay ask Chrome for).
const MESSAGE_NAMES = Object.freeze(['actionTitle', 'commandOpen', 'extDescription', 'extName', 'menuOpen', 'overlayGap',
  'overlayHide', 'overlayLaneMic', 'overlayLaneTab', 'overlayReconnecting', 'overlayRegion', 'overlayStopped']);
const locale = async (language) => {
  const text = await readFile(new URL(`../extension/_locales/${language}/messages.json`, import.meta.url), 'utf8');
  return { text, messages: JSON.parse(text) };
};
const locales = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) => [language, await locale(language)])));
const length = (value) => [...value].length;

test('the three _locales files carry the same message names, each with a message and an English description', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const { text, messages } = locales[language];
    assert.deepEqual(Object.keys(messages).sort(), MESSAGE_NAMES, `${language} message names`);
    assert.equal((text.match(/"message"\s*:/g) ?? []).length, MESSAGE_NAMES.length, `${language} has no duplicated entry`);
    assert.ok(text.endsWith('}\n'), `${language} ends with a newline`);
    for (const [name, entry] of Object.entries(messages)) {
      assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/, 'camelCase, no dots (Chrome message names)');
      assert.deepEqual(Object.keys(entry).sort(), ['description', 'message'], `${language}.${name} keys`);
      assert.ok(typeof entry.message === 'string' && entry.message.trim() && entry.message === entry.message.trim(), `${language}.${name} message`);
      assert.ok(typeof entry.description === 'string' && entry.description.trim(), `${language}.${name} description`);
      assert.ok(!entry.message.includes('$'), `${language}.${name} declares no placeholders, so it may not use $`);
    }
  }
  // The description is a note for translators: English everywhere, never translated.
  for (const name of MESSAGE_NAMES) {
    assert.equal(locales.ko.messages[name].description, locales.en.messages[name].description, `ko.${name} description`);
    assert.equal(locales.ja.messages[name].description, locales.en.messages[name].description, `ja.${name} description`);
    assert.doesNotMatch(locales.en.messages[name].description, /[^\x20-\x7e]/, `en.${name} description is plain ASCII`);
  }
});

test('the _locales limits hold in every language and each file really is in its language', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const { messages } = locales[language];
    assert.ok(length(messages.extDescription.message) <= 132, `${language} extDescription <= 132 characters`);
    assert.ok(length(messages.extName.message) <= 45, `${language} extName <= 45 characters`);
  }
  const hangul = /[가-힣]/, japanese = /[぀-ヿ一-鿿]/, cjk = /[぀-ヿ㄰-㆏一-鿿가-힣]/;
  // extName is the English product name in every language (§16, owner 2026-09-30); every other message is translated.
  for (const language of SUPPORTED_LANGUAGES) assert.equal(locales[language].messages.extName.message, 'Live Interpreter');
  for (const name of MESSAGE_NAMES.filter((message) => message !== 'extName')) {
    assert.ok(hangul.test(locales.ko.messages[name].message), `ko.${name} is Korean`);
    assert.ok(japanese.test(locales.ja.messages[name].message) && !hangul.test(locales.ja.messages[name].message), `ja.${name} is Japanese`);
    assert.ok(!cjk.test(locales.en.messages[name].message), `en.${name} is English`);
  }
  // The two lane chips must be distinguishable, and the shortcut text must say more than the tooltip.
  for (const language of SUPPORTED_LANGUAGES) {
    const { messages } = locales[language];
    assert.notEqual(messages.overlayLaneTab.message, messages.overlayLaneMic.message, `${language} lane chips`);
    assert.notEqual(messages.actionTitle.message, messages.commandOpen.message, `${language} action and shortcut text`);
  }
});
