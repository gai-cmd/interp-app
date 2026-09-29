// New implementation of docs/extension.md §11.1 (extension-options); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOCUMENTATION_LINKS } from '../app/config.js';
import { LIVE_MODELS } from '../app/providers/gemini/live-config.js';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../extension/lib/i18n.js';
import { KEY_GUIDE_URL, KEY_USAGE_URL } from '../extension/lib/links.js';
import { STYLE_LIMITS } from '../extension/lib/constants.js';
import { createDefaultSettings } from '../extension/lib/settings.js';
import { OPTIONS_ELEMENT_IDS, createOptionsController } from '../extension/options/controller.js';
import { FakeEvent, parseHtml } from './fixtures/extension-dom.mjs';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';

// Section 11.1 `extension-options`: the options controller against the PARSED real options.html, the fake browser
// and the REAL dictionaries (loaded through the extension loader over file: URLs). Nothing here launches a browser
// or touches audio; time is the fake browser's clock; the only "key" is assembled at runtime.
const SETTINGS = 'interp.settings.v1';
const KEY = 'interp.key.v1';
const FAKE_KEY = ['synthetic', 'x'.repeat(24)].join('-');
const optionsHtml = readFileSync(fileURLToPath(new URL('../extension/options/options.html', import.meta.url)), 'utf8');

// Synchronous reads inside an async function: the whole load settles in microtasks, so the fake clock's flush is enough.
async function fileFetch(url) {
  try {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  } catch { return { ok: false, json: async () => { throw new Error('missing'); } }; }
}
const loadI18n = (options) => loadExtensionI18n({ fetch: fileFetch, ...options });
const dictionaries = {};
for (const language of ['en', 'ko', 'ja']) dictionaries[language] = await loadI18n({ language });

const flatten = (value, prefix = '', out = {}) => {
  if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, out);
  else out[prefix] = value;
  return out;
};
const changedPaths = (before, after) => {
  const a = flatten(before); const b = flatten(after);
  return Object.keys({ ...a, ...b }).filter((path) => !Object.is(a[path], b[path]));
};

// One options page: a fake browser, an options context wrapped by the real adapter, the parsed real markup.
// `prepare(local)` may wrap or delete members of storage.local BEFORE the adapter copies them.
async function openPage(t, {
  browser = createFakeBrowser(), languages = ['en'], prepare = () => {}, loader = loadI18n, keepStopped = false,
} = {}) {
  const log = [];
  const context = browser.createContext('options');
  const local = context.chrome.storage.local;
  const rawSet = local.set; const rawLevel = local.setAccessLevel;
  local.set = (items) => { log.push(['set', Object.keys(items)]); return rawSet(items); };
  local.setAccessLevel = (options) => { log.push(['level', options.accessLevel]); return rawLevel(options); };
  prepare(local, log);
  const adapter = createChromeAdapter(context.chrome);
  const document = parseHtml(optionsHtml);
  const i18n = { current: createFallbackI18n() };
  const controller = createOptionsController({
    document, adapter, i18n, loadI18n: loader, timers: { setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout },
    navigator: { languages },
  });
  if (!keepStopped) t.after(() => controller.dispose());
  await controller.start();
  await browser.settle();
  const $ = (id) => document.getElementById(id);
  const fire = async (id, type, patch = {}) => {
    const element = $(id);
    Object.assign(element, patch);
    element.dispatchEvent(new FakeEvent(type, { bubbles: true }));
    await browser.settle();
  };
  const click = async (id) => { $(id).click(); await browser.settle(); };
  const text = (key, params) => i18n.current.t(key, params);
  const stored = () => browser.storageData('local')[SETTINGS];
  return { browser, context, adapter, document, i18n, controller, log, $, fire, click, text, stored };
}

function* walk(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* walk(child);
}
function pageContains(document, needle) {
  for (const node of walk(document)) {
    if (node.nodeType === 3 && String(node.data).includes(needle)) return true;
    if (node.nodeType !== 1) continue;
    if (node.attributes.some((attribute) => String(attribute.value).includes(needle))) return true;
    if (['input', 'textarea', 'select'].includes(node.localName) && String(node.value).includes(needle)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
test('every id of 7.3 exists once in the page and the controller only touches ids that exist', async (t) => {
  const page = await openPage(t);
  const table73 = ['opt-key', 'opt-key-toggle', 'opt-key-save', 'opt-key-delete', 'opt-key-status', 'opt-key-guide', 'opt-key-note',
    'opt-ui-language', 'opt-ui-language-hint', 'opt-target-tab', 'opt-target-mic', 'opt-model-tab', 'opt-model-tab-hint', 'opt-model-mic',
    'opt-model-mic-hint', 'opt-voice', 'opt-volume', 'opt-volume-value', 'opt-captions-tab', 'opt-captions-mic', 'opt-caption-size',
    'opt-caption-size-value', 'opt-caption-position', 'opt-caption-display', 'opt-caption-source', 'opt-caption-lines', 'opt-caption-hide',
    'opt-privacy-audio', 'opt-privacy-free', 'opt-privacy-page', 'opt-saved'];
  for (const id of table73) assert.ok(page.$(id), `#${id} exists in options.html`);
  const all = [...walk(page.document)].filter((node) => node.nodeType === 1 && node.id).map((node) => node.id);
  for (const id of table73) assert.equal(all.filter((item) => item === id).length, 1, `#${id} appears once`);
  for (const id of OPTIONS_ELEMENT_IDS) assert.ok(page.$(id), `controller id #${id} exists in options.html`);
  // Every interactive control of the table is bound (a change or click listener is registered).
  const interactive = ['opt-ui-language', 'opt-target-tab', 'opt-target-mic', 'opt-model-tab', 'opt-model-mic', 'opt-voice', 'opt-volume',
    'opt-captions-tab', 'opt-captions-mic', 'opt-caption-size', 'opt-caption-position', 'opt-caption-display', 'opt-caption-source',
    'opt-caption-lines', 'opt-caption-hide', 'opt-key-save', 'opt-key-delete', 'opt-key-toggle'];
  for (const id of interactive) assert.ok(page.$(id).listenerCount > 0, `#${id} is bound`);
  assert.equal(page.$('opt-saved').getAttribute('role'), 'status');
  assert.equal(page.$('opt-saved').hidden, false, '#opt-saved is a persistent live region');
});

test('links.js parity: the two documentation URLs equal app/config.js DOCUMENTATION_LINKS', () => {
  assert.equal(KEY_GUIDE_URL, DOCUMENTATION_LINKS.apiKeyCreate);
  assert.equal(KEY_USAGE_URL, DOCUMENTATION_LINKS.apiKeyUsage);
});

test('the key guide link gets its href from links.js and keeps target and rel', async (t) => {
  const page = await openPage(t);
  const link = page.$('opt-key-guide');
  assert.equal(link.getAttribute('href'), KEY_GUIDE_URL);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('the model selects are filled from LIVE_MODELS; sim.model0 carries "(default)", which is true for the microphone only', async (t) => {
  const page = await openPage(t);
  for (const id of ['opt-model-tab', 'opt-model-mic']) {
    assert.deepEqual(page.$(id).options.map((option) => option.value), [...LIVE_MODELS]);
  }
  // Microphone: the app's labels, the default model tagged (the microphone default IS the default Live model).
  assert.deepEqual(page.$('opt-model-mic').options.map((option) => option.textContent),
    ['sim.model0', 'sim.model1', 'sim.model2'].map((key) => page.text(key)));
  // Tab audio: its default is the translation model, so the same three models but no "(default)" on the first one.
  assert.deepEqual(page.$('opt-model-tab').options.map((option) => option.textContent),
    ['ext.options.modelLive', 'sim.model1', 'sim.model2'].map((key) => page.text(key)));
  assert.notEqual(page.$('opt-model-tab').options[0].textContent, page.text('sim.model0'));
  assert.doesNotMatch(page.$('opt-model-tab').options[0].textContent, /default/i);
  assert.match(page.$('opt-model-mic').options[0].textContent, /default/i);
  assert.equal(page.$('opt-model-tab').value, LIVE_MODELS[1], 'the tab default is the translation model (its label is not tagged either way)');
  // The defaults of 7.1 are selected: the translation model for the tab, the default Live model for the microphone.
  assert.equal(page.$('opt-model-tab').value, page.stored().lanes.tab.model);
  assert.equal(page.$('opt-model-mic').value, page.stored().lanes.mic.model);
});

test('first run with an empty store seeds the defaults from navigator.languages', async (t) => {
  const page = await openPage(t, { languages: ['ko-KR', 'en'] });
  assert.deepEqual(page.stored(), JSON.parse(JSON.stringify(createDefaultSettings('ko'))));
  assert.equal(page.$('opt-target-tab').value, 'ko');
  assert.equal(page.$('opt-target-mic').value, 'en');
  assert.equal(page.$('opt-ui-language').value, 'auto');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'ko', 'the page follows the browser language while uiLanguage is auto');
});

test('a stored record is shown, not overwritten, on the next open', async (t) => {
  const browser = createFakeBrowser();
  const first = await openPage(t, { browser });
  await first.fire('opt-target-tab', 'change', { value: 'ja' });
  first.controller.dispose();
  const second = await openPage(t, { browser, languages: ['ko'] });
  assert.equal(second.$('opt-target-tab').value, 'ja');
  assert.equal(second.stored().lanes.tab.targetLanguage, 'ja');
});

// Each control writes exactly its own setting (a storage diff of one path).
const FIELD_CASES = [
  ['opt-ui-language', 'value', 'ko', 'uiLanguage', 'ko'],
  ['opt-target-tab', 'value', 'ja', 'lanes.tab.targetLanguage', 'ja'],
  ['opt-target-mic', 'value', 'ko', 'lanes.mic.targetLanguage', 'ko'],
  ['opt-model-tab', 'value', LIVE_MODELS[0], 'lanes.tab.model', LIVE_MODELS[0]],
  ['opt-model-mic', 'value', LIVE_MODELS[1], 'lanes.mic.model', LIVE_MODELS[1]],
  ['opt-voice', 'value', 'male', 'voiceGender', 'male'],
  ['opt-volume', 'value', '40', 'lanes.tab.originalVolume', 40],
  ['opt-captions-tab', 'checked', false, 'lanes.tab.captions', false],
  ['opt-captions-mic', 'checked', true, 'lanes.mic.captions', true],
  ['opt-caption-size', 'value', '1.75', 'captions.size', 1.75],
  ['opt-caption-position', 'value', 'top', 'captions.position', 'top'],
  ['opt-caption-display', 'value', 'light', 'captions.display', 'light'],
  ['opt-caption-source', 'checked', true, 'captions.showSource', true],
  ['opt-caption-lines', 'value', '5', 'captions.maxLines', 5],
  ['opt-caption-hide', 'value', '20', 'captions.autoHideSeconds', 20],
];
for (const [id, kind, input, path, expected] of FIELD_CASES) {
  test(`#${id} writes exactly ${path} and confirms with #opt-saved for 2000 ms`, async (t) => {
    const page = await openPage(t);
    const before = page.stored();
    assert.equal(page.$('opt-saved').textContent, '', 'nothing is confirmed before an edit');
    await page.fire(id, 'change', kind === 'checked' ? { checked: input } : { value: input });
    const after = page.stored();
    assert.deepEqual(changedPaths(before, after), [path], `only ${path} changed`);
    assert.equal(flatten(after)[path], expected);
    assert.equal(page.$('opt-saved').textContent, page.text('ext.options.saved'));
    assert.notEqual(page.$('opt-saved').textContent, '');
    await page.browser.clock.advance(1999);
    assert.notEqual(page.$('opt-saved').textContent, '', 'still shown just before 2000 ms');
    await page.browser.clock.advance(1);
    assert.equal(page.$('opt-saved').textContent, '', 'cleared at 2000 ms');
    assert.equal(page.$('opt-saved').hidden, false, 'the live region is never hidden');
  });
}

test('the confirmation is the localized ext.options.saved text', async (t) => {
  const page = await openPage(t);
  await page.fire('opt-voice', 'change', { value: 'male' });
  assert.equal(page.$('opt-saved').textContent, 'Saved.');
});

test('the range outputs follow the thumb while it moves and only `change` saves', async (t) => {
  const page = await openPage(t);
  const before = page.stored();
  await page.fire('opt-volume', 'input', { value: '20' });
  assert.equal(page.$('opt-volume-value').textContent, page.text('ext.volume.value', { percent: 20 }));
  await page.fire('opt-caption-size', 'input', { value: '2' });
  assert.equal(page.$('opt-caption-size-value').textContent, page.text('display.captions.value', { size: 2 }));
  assert.deepEqual(page.stored(), before, 'input events save nothing');
  assert.equal(page.$('opt-saved').textContent, '');
});

test('an emptied or non-numeric number field is restored to the stored value without a write', async (t) => {
  const page = await openPage(t);
  const before = page.stored();
  const writes = page.log.filter(([kind]) => kind === 'set').length;
  await page.fire('opt-caption-lines', 'change', { value: '' });
  assert.equal(page.$('opt-caption-lines').value, '3', 'an emptied field goes back to the stored value');
  await page.fire('opt-caption-hide', 'change', { value: 'abc' });
  assert.equal(page.$('opt-caption-hide').value, '8');
  assert.deepEqual(page.stored(), before);
  assert.equal(page.log.filter(([kind]) => kind === 'set').length, writes, 'no write happened');
  assert.equal(page.$('opt-saved').textContent, '', 'and nothing was confirmed');
  await page.fire('opt-caption-hide', 'change', { value: '0' });
  assert.equal(page.stored().captions.autoHideSeconds, 0, '0 means never hide and is a valid value');
});

// Was: any out-of-range integer was written, normalizeStyle turned it into the DEFAULT (3 lines, 8 seconds), the page said
// "Saved." and showed the default: neither the typed value nor the previous one. Now the field goes back to what was there.
const NUMBER_FIELDS = [
  ['opt-caption-lines', 'captions.maxLines', STYLE_LIMITS.maxLines, ['0', '7', '10', '2.5', '-1', '1e3'], '5'],
  ['opt-caption-hide', 'captions.autoHideSeconds', STYLE_LIMITS.autoHideSeconds, ['61', '90', '-1', '2.5', '1e3'], '30'],
];
for (const [id, path, limits, invalid, previous] of NUMBER_FIELDS) {
  test(`#${id}: a value outside ${limits.min}..${limits.max} (or not a whole number) restores the previous value, writes nothing and never says "Saved."`, async (t) => {
    const page = await openPage(t);
    await page.fire(id, 'change', { value: previous });
    assert.equal(flatten(page.stored())[path], Number(previous));
    assert.equal(page.$('opt-saved').textContent, page.text('ext.options.saved'));
    await page.browser.clock.advance(2000);   // the confirmation of the valid edit is over
    assert.equal(page.$('opt-saved').textContent, '');
    for (const typed of invalid) {
      const before = page.stored();
      const writes = page.log.filter(([kind]) => kind === 'set').length;
      await page.fire(id, 'change', { value: typed });
      assert.equal(page.$(id).value, previous, `${typed}: the field shows the previous value again, not a default`);
      assert.equal(flatten(page.stored())[path], Number(previous), `${typed}: the stored value is untouched`);
      assert.deepEqual(page.stored(), before);
      assert.equal(page.log.filter(([kind]) => kind === 'set').length, writes, `${typed}: no storage write`);
      assert.equal(page.$('opt-saved').textContent, '', `${typed}: no false confirmation`);
    }
    // The boundaries themselves are valid, and each one is confirmed.
    for (const edge of [String(limits.min), String(limits.max)]) {
      await page.fire(id, 'change', { value: edge });
      assert.equal(flatten(page.stored())[path], Number(edge), `${edge} is accepted`);
      assert.equal(page.$(id).value, edge);
      assert.equal(page.$('opt-saved').textContent, page.text('ext.options.saved'), `${edge} is confirmed`);
      await page.browser.clock.advance(2000);
    }
  });
}

test('an invalid number leaves an earlier confirmation or error alone (it neither adds "Saved." nor clears the failure)', async (t) => {
  const page = await openPage(t, { prepare: (local) => { local.get = () => Promise.reject(new Error('storage unavailable')); } });
  assert.equal(page.$('opt-saved').textContent, page.text('ext.error.STORAGE_FAILED'));
  await page.fire('opt-caption-lines', 'change', { value: '99' });
  assert.equal(page.$('opt-saved').textContent, page.text('ext.error.STORAGE_FAILED'), 'the sticky error is still there');
  assert.equal(page.$('opt-caption-lines').value, '3');
});

test('the number-field labels state the range the field accepts, in every language', async () => {
  for (const language of ['en', 'ko', 'ja']) {
    const i18n = dictionaries[language];
    for (const [key, limits] of [['ext.options.captionLines', STYLE_LIMITS.maxLines], ['ext.options.autoHide', STYLE_LIMITS.autoHideSeconds]]) {
      assert.match(i18n.t(key), new RegExp(`${limits.min}\\s*[–~〜-]\\s*${limits.max}`), `${language} ${key} names ${limits.min}-${limits.max}`);
    }
  }
  // The markup's own bounds and the limits are the same numbers (the browser's spinner agrees with the controller).
  const html = optionsHtml;
  assert.match(html, new RegExp(`id="opt-caption-lines" type="number" min="${STYLE_LIMITS.maxLines.min}" max="${STYLE_LIMITS.maxLines.max}"`));
  assert.match(html, new RegExp(`id="opt-caption-hide" type="number" min="${STYLE_LIMITS.autoHideSeconds.min}" max="${STYLE_LIMITS.autoHideSeconds.max}"`));
});

test('the Korean key-saved line uses the extension\'s own wording, not the app\'s formal one', async (t) => {
  const page = await openPage(t, { languages: ['ko-KR'] });
  await page.fire('opt-key', 'input', { value: FAKE_KEY });
  await page.click('opt-key-save');
  assert.equal(page.i18n.current.language, 'ko');
  assert.equal(page.$('opt-key-status').textContent, '키를 이 브라우저에 저장했어요.');
  assert.notEqual(page.$('opt-key-status').textContent, page.i18n.current.t('settings.keySavedBrowser'));
});

test('the volume and size outputs show the stored values after start', async (t) => {
  const page = await openPage(t);
  assert.equal(page.$('opt-volume').value, '65');
  assert.equal(page.$('opt-volume-value').textContent, page.text('ext.volume.value', { percent: 65 }));
  assert.equal(page.$('opt-caption-size-value').textContent, page.text('display.captions.value', { size: 1.5 }));
});

// ---------------------------------------------------------------------------------------------
// The key (7.4)
test('saving a key: trimmed, access level set BEFORE the write, input cleared, status ext.key.savedBrowser', async (t) => {
  const page = await openPage(t);
  assert.equal(page.$('opt-key-status').textContent, page.text('settings.noKey'));
  assert.equal(page.browser.accessLevel, null);
  await page.fire('opt-key', 'input', { value: `  ${FAKE_KEY}  ` });
  await page.click('opt-key-save');
  assert.equal(page.browser.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(page.browser.storageData('local')[KEY].value, FAKE_KEY, 'the stored key is trimmed');
  assert.deepEqual(page.browser.storageData('local')[KEY], { v: 1, value: FAKE_KEY });
  const level = page.log.findIndex(([kind]) => kind === 'level');
  const write = page.log.findIndex(([kind, keys]) => kind === 'set' && Array.isArray(keys) && keys.includes(KEY));
  assert.ok(level >= 0 && write >= 0 && level < write, `setAccessLevel (${level}) comes before the key write (${write})`);
  assert.equal(page.$('opt-key').value, '', 'the input is cleared after a successful save');
  assert.equal(page.$('opt-key-status').textContent, page.text('ext.key.savedBrowser'));
});

test('after a save the key is stored: a fresh page reports keyStored, and a re-render keeps the state', async (t) => {
  const browser = createFakeBrowser();
  const first = await openPage(t, { browser });
  await first.fire('opt-key', 'input', { value: FAKE_KEY });
  await first.click('opt-key-save');
  await first.fire('opt-ui-language', 'change', { value: 'ja' });   // a full re-render in another language
  assert.equal(first.$('opt-key-status').textContent, first.text('ext.key.savedBrowser'));
  first.controller.dispose();
  const second = await openPage(t, { browser });
  assert.equal(second.$('opt-key-status').textContent, second.text('settings.keyStored'));
  assert.notEqual(second.text('settings.keyStored'), second.text('settings.noKey'));
});

test('the key never appears in any element text or attribute of the page after a successful save', async (t) => {
  const page = await openPage(t);
  await page.fire('opt-key', 'input', { value: FAKE_KEY });
  await page.click('opt-key-toggle');   // even shown as text while typing, it must be gone after the save
  await page.click('opt-key-save');
  assert.equal(pageContains(page.document, FAKE_KEY), false, 'no node holds the key');
  assert.equal(pageContains(page.document, FAKE_KEY.slice(0, 12)), false, 'nor a prefix of it');
  await page.fire('opt-ui-language', 'change', { value: 'ko' });
  assert.equal(pageContains(page.document, FAKE_KEY), false, 'a re-render does not bring it back');
  // The stored key is never read back into the page even when a fresh page opens.
  const second = await openPage(t, { browser: page.browser });
  assert.equal(pageContains(second.document, FAKE_KEY), false);
});

test('an invalid key shows error.INVALID_KEY and writes nothing (no access-level call either)', async (t) => {
  const page = await openPage(t);
  for (const bad of ['has a space', '   ', 'x'.repeat(513), 'ключ']) {
    await page.fire('opt-key', 'input', { value: bad });
    await page.click('opt-key-save');
    assert.equal(page.$('opt-key-status').textContent, page.text('error.INVALID_KEY'), `rejects ${JSON.stringify(bad.slice(0, 8))}`);
  }
  assert.equal(page.browser.storageData('local')[KEY], undefined);
  assert.equal(page.browser.accessLevel, null);
  assert.equal(page.log.some(([kind]) => kind === 'level'), false);
});

test('a rejecting setAccessLevel refuses the save with ext.error.STORAGE_FAILED and writes NOTHING', async (t) => {
  const page = await openPage(t);
  page.browser.failSetAccessLevel(true);
  await page.fire('opt-key', 'input', { value: FAKE_KEY });
  await page.click('opt-key-save');
  assert.equal(page.$('opt-key-status').textContent, page.text('ext.error.STORAGE_FAILED'));
  assert.equal(page.browser.storageData('local')[KEY], undefined);
  assert.equal(page.log.some(([kind, keys]) => kind === 'set' && Array.isArray(keys) && keys.includes(KEY)), false);
  assert.notEqual(page.$('opt-key-status').textContent, page.text('ext.key.savedBrowser'));
});

test('a missing setAccessLevel API refuses the save the same way', async (t) => {
  const page = await openPage(t, { prepare: (local) => { delete local.setAccessLevel; } });
  assert.equal(page.adapter.storage.local.setAccessLevel, undefined, 'the adapter skips a member the namespace lacks');
  await page.fire('opt-key', 'input', { value: FAKE_KEY });
  await page.click('opt-key-save');
  assert.equal(page.$('opt-key-status').textContent, page.text('ext.error.STORAGE_FAILED'));
  assert.equal(page.browser.storageData('local')[KEY], undefined);
});

test('a key write that rejects after the access level was set reports ext.error.STORAGE_FAILED', async (t) => {
  const page = await openPage(t, {
    prepare: (local) => {
      const set = local.set;
      local.set = (items) => (Object.hasOwn(items, KEY) ? Promise.reject(new Error('disk full')) : set(items));
    },
  });
  await page.fire('opt-key', 'input', { value: FAKE_KEY });
  await page.click('opt-key-save');
  assert.equal(page.$('opt-key-status').textContent, page.text('ext.error.STORAGE_FAILED'));
  assert.equal(page.browser.storageData('local')[KEY], undefined);
});

test('deleting the key: keyDeleted now, noKey on the next open', async (t) => {
  const browser = createFakeBrowser();
  const first = await openPage(t, { browser });
  await first.fire('opt-key', 'input', { value: FAKE_KEY });
  await first.click('opt-key-save');
  assert.ok(browser.storageData('local')[KEY]);
  await first.click('opt-key-delete');
  assert.equal(browser.storageData('local')[KEY], undefined);
  assert.equal(first.$('opt-key-status').textContent, first.text('settings.keyDeleted'));
  assert.equal(first.$('opt-key').value, '');
  first.controller.dispose();
  const second = await openPage(t, { browser });
  assert.equal(second.$('opt-key-status').textContent, second.text('settings.noKey'));
});

test('the show/hide toggle swaps the input type and the label, and never uses aria-pressed', async (t) => {
  const page = await openPage(t);
  const input = page.$('opt-key'); const toggle = page.$('opt-key-toggle');
  assert.equal(input.type, 'password');
  assert.equal(toggle.textContent, page.text('ext.options.keyShow'));
  await page.click('opt-key-toggle');
  assert.equal(input.type, 'text');
  assert.equal(toggle.textContent, page.text('ext.options.keyHide'));
  assert.equal(toggle.hasAttribute('aria-pressed'), false);
  assert.equal(toggle.getAttribute('aria-controls'), 'opt-key');
  await page.click('opt-key-toggle');
  assert.equal(input.type, 'password');
  assert.equal(toggle.textContent, page.text('ext.options.keyShow'));
  assert.equal(toggle.hasAttribute('aria-pressed'), false);
  assert.notEqual(page.text('ext.options.keyShow'), page.text('ext.options.keyHide'));
});

// ---------------------------------------------------------------------------------------------
test('storage rejecting at start shows the defaults and ext.error.STORAGE_FAILED without throwing', async (t) => {
  const page = await openPage(t, {
    prepare: (local) => { local.get = () => Promise.reject(new Error('storage unavailable')); },
  });
  assert.equal(page.$('opt-saved').textContent, page.text('ext.error.STORAGE_FAILED'));
  await page.browser.clock.advance(5000);
  assert.equal(page.$('opt-saved').textContent, page.text('ext.error.STORAGE_FAILED'), 'an error stays until the next successful write');
  const defaults = createDefaultSettings('en');
  assert.equal(page.$('opt-target-tab').value, defaults.lanes.tab.targetLanguage);
  assert.equal(page.$('opt-volume').value, String(defaults.lanes.tab.originalVolume));
  assert.equal(page.$('opt-key-status').textContent, page.text('settings.noKey'));
  assert.equal(page.$('opt-saved').hidden, false);
});

test('changing uiLanguage re-renders the page: html lang, labels, model names and outputs', async (t) => {
  const page = await openPage(t);
  assert.equal(page.document.documentElement.getAttribute('lang'), 'en');
  assert.equal(page.$('opt-title').textContent, 'Options');
  await page.fire('opt-ui-language', 'change', { value: 'ko' });
  const ko = dictionaries.ko;
  assert.equal(page.i18n.current.language, 'ko');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'ko');
  assert.equal(page.$('opt-title').textContent, ko.t('ext.options.title'));
  assert.notEqual(page.$('opt-title').textContent, 'Options');
  assert.equal(page.document.title, ko.t('ext.options.title'));
  assert.equal(page.$('opt-key-toggle').textContent, ko.t('ext.options.keyShow'));
  assert.equal(page.$('opt-volume-value').textContent, ko.t('ext.volume.value', { percent: 65 }));
  assert.equal(page.$('opt-model-tab').options[0].textContent, ko.t('ext.options.modelLive'));
  assert.equal(page.$('opt-model-mic').options[0].textContent, ko.t('sim.model0'));
  assert.equal(page.$('opt-key-status').textContent, ko.t('settings.noKey'));
  assert.equal(page.$('opt-ui-language').value, 'ko', 'the select keeps the chosen value');
  await page.fire('opt-ui-language', 'change', { value: 'auto' });
  assert.equal(page.i18n.current.language, 'en', 'auto follows navigator.languages again');
});

test('an edit made in another context (the panel) re-renders live through storage.onChanged', async (t) => {
  const page = await openPage(t);
  const panel = page.browser.createContext('panel');
  const next = structuredClone(page.stored());
  next.lanes.tab.originalVolume = 20;
  next.captions.size = 1.25;
  next.lanes.mic.captions = true;
  await panel.chrome.storage.local.set({ [SETTINGS]: next });
  await page.browser.settle();
  assert.equal(page.$('opt-volume').value, '20');
  assert.equal(page.$('opt-volume-value').textContent, page.text('ext.volume.value', { percent: 20 }));
  assert.equal(page.$('opt-caption-size').value, '1.25');
  assert.equal(page.$('opt-caption-size-value').textContent, page.text('display.captions.value', { size: 1.25 }));
  assert.equal(page.$('opt-captions-mic').checked, true);
  // A key stored by another context flips the status too.
  await panel.chrome.storage.local.set({ [KEY]: { v: 1, value: FAKE_KEY } });
  await page.browser.settle();
  assert.equal(page.$('opt-key-status').textContent, page.text('settings.keyStored'));
  assert.equal(pageContains(page.document, FAKE_KEY), false);
});

test('a failing dictionary load renders the boot dictionary and recovers on the automatic retry', async (t) => {
  let attempts = 0;
  const loader = (options) => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error('I18N_LOAD_FAILED')) : loadI18n(options);
  };
  const page = await openPage(t, { loader });
  const boot = createFallbackI18n();
  assert.equal(page.i18n.current.has('ext.options.title'), false, 'only the boot dictionary is loaded');
  assert.equal(page.$('opt-title').textContent, boot.t('error.unknown'), 'unknown keys render the generic error text, never the key');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'en');
  assert.equal(attempts, 1);
  await page.browser.clock.advance(2000);
  assert.equal(attempts, 2);
  assert.equal(page.i18n.current.has('ext.options.title'), true);
  assert.equal(page.$('opt-title').textContent, 'Options');
  assert.equal(page.$('opt-model-tab').options[0].textContent, page.text('ext.options.modelLive'));
  assert.equal(page.$('opt-model-mic').options[0].textContent, page.text('sim.model0'));
});

test('dispose removes every listener: edits are no longer saved and other contexts no longer re-render the page', async (t) => {
  const page = await openPage(t, { keepStopped: true });
  const ids = OPTIONS_ELEMENT_IDS.filter((id) => page.$(id).listenerCount > 0);
  assert.ok(ids.length >= 15);
  assert.equal(page.adapter.storage.onChanged.hasListeners(), true);
  page.controller.dispose();
  for (const id of ids) assert.equal(page.$(id).listenerCount, 0, `#${id} has no listener left`);
  assert.equal(page.adapter.storage.onChanged.hasListeners(), false);
  const before = page.stored();
  await page.fire('opt-voice', 'change', { value: 'male' });
  assert.deepEqual(page.stored(), before, 'a change after dispose saves nothing');
  const other = page.browser.createContext('panel');
  const next = structuredClone(before);
  next.lanes.tab.originalVolume = 10;
  await other.chrome.storage.local.set({ [SETTINGS]: next });
  await page.browser.settle();
  assert.equal(page.$('opt-volume').value, '65', 'the page no longer follows storage');
  page.controller.dispose();   // idempotent
});

test('the options page never reads the key back: only hasKey-style state reaches the DOM', async (t) => {
  const browser = createFakeBrowser();
  await browser.createContext('panel').chrome.storage.local.set({ [KEY]: { v: 1, value: FAKE_KEY } });
  const page = await openPage(t, { browser });
  assert.equal(page.$('opt-key-status').textContent, page.text('settings.keyStored'));
  assert.equal(page.$('opt-key').value, '', 'the input stays empty');
  assert.equal(pageContains(page.document, FAKE_KEY), false);
  // No document mutation API that writes markup was used (the fake throws on innerHTML): reaching here proves it.
  assert.equal(page.controller.dispose(), undefined);
});
