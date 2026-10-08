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
import { createDefaultSettings, laneRequestOf } from '../extension/lib/settings.js';
import { OPTIONS_ELEMENT_IDS, UPDATE_ERROR_KEY, UPDATE_STEP_KEY, createOptionsController } from '../extension/options/controller.js';
import { UPDATE_ERROR_KEY as PANEL_ERROR_KEY, UPDATE_STEPS } from '../extension/panel/view-model.js';
import { UPDATE_ERROR_CODES } from '../extension/lib/self-update.js';
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
  updater = null, hash = '', awaitStart = true, version = '0.5.0', beforeStart = () => {},
} = {}) {
  const log = [];
  const context = browser.createContext('options');
  context.chrome.runtime.getManifest = () => ({ version });   // the fake runtime has none; §21 shows "you have {current}"
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
    navigator: { languages }, updater, hash,
  });
  if (!keepStopped) t.after(() => controller.dispose());
  beforeStart({ document, $: (id) => document.getElementById(id) });
  // A test that gates the updater cannot wait for start(): the flow it starts ends only when the gate opens.
  const started = controller.start();
  if (awaitStart) await started;
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
  return { browser, context, adapter, document, i18n, controller, log, $, fire, click, text, stored, started };
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

test('the model selects are filled from LIVE_MODELS; the first option of both is the automatic latest model (§24)', async (t) => {
  const page = await openPage(t);
  for (const id of ['opt-model-tab', 'opt-model-mic']) {
    assert.deepEqual(page.$(id).options.map((option) => option.value), [...LIVE_MODELS]);
  }
  // §24: both selects offer the same three models, and their first option (the DEFAULT model) is the automatic latest one:
  // it names no version, because it follows the newest general Google Live model; the other two keep the app's labels.
  for (const id of ['opt-model-tab', 'opt-model-mic']) {
    assert.deepEqual(page.$(id).options.map((option) => option.textContent),
      ['ext.options.modelAuto', 'sim.model1', 'sim.model2'].map((key) => page.text(key)), id);
  }
  assert.notEqual(page.$('opt-model-mic').options[0].textContent, page.text('sim.model0'), 'not the fixed "Gemini 3.8 Live (default)"');
  assert.doesNotMatch(page.$('opt-model-mic').options[0].textContent, /3\.8/);
  assert.equal(page.$('opt-model-tab').value, LIVE_MODELS[0], 'the tab default is the latest Live model, like the microphone\'s');
  // The defaults of 7.1 are selected: the latest Live model on both lanes.
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
  ['opt-model-tab', 'value', LIVE_MODELS[1], 'lanes.tab.model', LIVE_MODELS[1]],   // the translation-only preview: a change from the default
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

// Two-way is chosen in the panel; this page shows no two-way control, but it does change the first language of a lane.
// It must give the pair the panel gives: before, the settings' repair replaced the partner with the default partner of
// the new target (ja<->en set to en became en<->ko, a language the user never chose).
test('a target change keeps a stored two-way pair to the user\'s own languages: ja<->en set to en is en<->ja, as in the panel', async (t) => {
  const browser = createFakeBrowser();
  const seeded = structuredClone(createDefaultSettings('en'));
  Object.assign(seeded.lanes.tab, { twoWay: true, targetLanguage: 'ja', partnerLanguage: 'en' });
  await browser.createContext('panel').chrome.storage.local.set({ [SETTINGS]: seeded });
  const page = await openPage(t, { browser });
  assert.equal(page.$('opt-target-tab').value, 'ja');
  const before = page.stored();
  const sets = page.log.filter(([kind]) => kind === 'set').length;
  await page.fire('opt-target-tab', 'change', { value: 'en' });
  const tab = page.stored().lanes.tab;
  assert.deepEqual([tab.targetLanguage, tab.partnerLanguage, tab.twoWay], ['en', 'ja', true]);
  assert.deepEqual(laneRequestOf(page.stored(), 'tab').languages, ['en', 'ja'], 'the next start interprets between en and ja');
  assert.deepEqual(changedPaths(before, page.stored()).sort(), ['lanes.tab.partnerLanguage', 'lanes.tab.targetLanguage']);
  assert.equal(page.log.filter(([kind]) => kind === 'set').length - sets, 1, 'one write carries both fields');
  assert.equal(page.$('opt-target-tab').value, 'en');
  assert.equal(page.$('opt-saved').textContent, page.text('ext.options.saved'));
  // A first language that is not the partner leaves the partner alone.
  await page.fire('opt-target-tab', 'change', { value: 'ko' });
  assert.deepEqual([page.stored().lanes.tab.targetLanguage, page.stored().lanes.tab.partnerLanguage], ['ko', 'ja']);
});

test('a target change on the options page never puts a language the user did not choose into the pair (both lanes, every pair)', async (t) => {
  const page = await openPage(t);
  const other = page.browser.createContext('panel');
  const languages = ['ko', 'en', 'ja'];
  for (const lane of ['tab', 'mic']) {
    for (const target of languages) {
      for (const partner of languages.filter((code) => code !== target)) {
        for (const value of languages) {
          const seeded = structuredClone(page.stored());
          Object.assign(seeded.lanes[lane], { twoWay: true, targetLanguage: target, partnerLanguage: partner });
          await other.chrome.storage.local.set({ [SETTINGS]: seeded });
          await page.browser.settle();
          await page.fire(`opt-target-${lane}`, 'change', { value });
          const result = page.stored().lanes[lane];
          const label = `${lane} ${target}<->${partner} set to ${value}: ${result.targetLanguage}<->${result.partnerLanguage}`;
          assert.equal(result.targetLanguage, value, label);
          assert.notEqual(result.partnerLanguage, value, label);
          assert.ok([target, partner].includes(result.partnerLanguage), label);
          assert.equal(result.partnerLanguage, value === partner ? target : partner, label);
        }
      }
    }
  }
});

test('the options page and the panel change the first language through the one shared settings helper', () => {
  for (const file of ['extension/options/controller.js', 'extension/panel/controller.js']) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    assert.match(source, /import \{[^}]*\bsetLaneTargetLanguage\b[^}]*\} from '\.\.\/lib\/settings\.js'/, `${file} imports the helper`);
    assert.doesNotMatch(source, /\.targetLanguage = /, `${file} does not set a target language on its own`);
  }
});

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
  assert.equal(page.$('opt-volume').value, '45', '§20: the starting original volume');
  assert.equal(page.$('opt-volume-value').textContent, page.text('ext.volume.value', { percent: 45 }));
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
  assert.equal(page.$('opt-volume-value').textContent, ko.t('ext.volume.value', { percent: 45 }));
  assert.equal(page.$('opt-model-tab').options[0].textContent, ko.t('ext.options.modelAuto'));
  assert.equal(page.$('opt-model-mic').options[0].textContent, ko.t('ext.options.modelAuto'));
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
  assert.equal(page.$('opt-model-tab').options[0].textContent, page.text('ext.options.modelAuto'));
  assert.equal(page.$('opt-model-mic').options[0].textContent, page.text('ext.options.modelAuto'));
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
  assert.equal(page.$('opt-volume').value, '45', 'the page no longer follows storage');
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

// =============================================================================================
// §21 (owner, 2026-10-08): the "Automatic updates" section. A STUB updater stands in for createSelfUpdater: no network, no
// file system, no picker, no permission prompt. What is under test is what the page asks of the updater, when, and what it
// shows of the answer.
// =============================================================================================
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function stubUpdater({
  enabled = true, folder = 'none', autoApply = true, check = { available: true, version: '0.6.0' }, pending = null, lastError = null,
  choose = async () => ({ ok: true }), run = async () => ({ ok: true, version: '0.6.0' }), steps = [],
} = {}) {
  const calls = { status: 0, check: 0, choose: 0, run: [], forget: 0, auto: [] };
  const state = { folder, autoApply, check, pending, lastError };
  const updater = {
    enabled, calls, state,
    status: async () => { calls.status += 1; return { enabled, folder: state.folder, autoApply: state.autoApply, appliedVersion: null, pending: state.pending, lastError: state.lastError }; },
    check: async () => { calls.check += 1; if (state.check instanceof Error) throw state.check; return state.check; },
    chooseFolder: async () => {
      calls.choose += 1;
      const result = await choose(state);
      if (result?.ok === true) state.folder = 'granted';
      return result;
    },
    run: async (options) => {
      calls.run.push({ allowPrompt: options.allowPrompt, hasOnStep: typeof options.onStep === 'function' });
      for (const step of steps) { options.onStep(step); await Promise.resolve(); }
      return run(options, state);
    },
    forgetFolder: async () => { calls.forget += 1; state.folder = 'none'; },
    setAutoApply: async (on) => { calls.auto.push(on); state.autoApply = on; },
  };
  return updater;
}
const UPDATE_IDS = ['update-section', 'update-lead', 'update-status', 'update-detail', 'update-folder-help', 'update-actions', 'btn-update-folder',
  'btn-update-now', 'btn-update-forget', 'update-auto', 'update-auto-row', 'update-disabled-note'];
// Shown = neither hidden itself nor inside something hidden (the checkbox is hidden through its label).
const visible = (element) => { for (let node = element; node && node.nodeType === 1; node = node.parentElement) if (node.hidden) return false; return true; };
const shown = (page, ids = UPDATE_IDS) => ids.filter((id) => visible(page.$(id)));
// Every text the status line showed from now on (a test then sees the steps a run passed through, not only the last one).
function recordStatus(element) {
  let owner = Object.getPrototypeOf(element);
  while (owner !== null && !Object.hasOwn(owner, 'textContent')) owner = Object.getPrototypeOf(owner);
  const original = Object.getOwnPropertyDescriptor(owner, 'textContent');
  const writes = [];
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get() { return original.get.call(this); },
    set(value) { writes.push(String(value)); original.set.call(this, value); },
  });
  return writes;
}

test('§21 the error and step tables are literal, complete and the same on both pages', () => {
  assert.deepEqual(Object.keys(UPDATE_ERROR_KEY).sort(), [...UPDATE_ERROR_CODES].sort(), 'one key per UPDATE_* code of extension/lib/self-update.js');
  assert.deepEqual(UPDATE_ERROR_KEY, PANEL_ERROR_KEY, 'the panel and the options page word every code with the same key');
  assert.deepEqual(Object.keys(UPDATE_STEP_KEY), UPDATE_STEPS, 'the five steps, in the order the updater reports them');
  for (const code of UPDATE_ERROR_CODES) assert.equal(UPDATE_ERROR_KEY[code], `ext.updater.error.${code}`);
  for (const step of UPDATE_STEPS) assert.equal(UPDATE_STEP_KEY[step], `ext.updater.step.${step}`);
  for (const language of ['en', 'ko', 'ja']) {
    for (const key of [...Object.values(UPDATE_ERROR_KEY), ...Object.values(UPDATE_STEP_KEY), 'ext.updater.error.UNKNOWN']) {
      assert.equal(dictionaries[language].has(key), true, `${language} ${key}`);
    }
  }
  assert.ok(Object.isFrozen(UPDATE_ERROR_KEY) && Object.isFrozen(UPDATE_STEP_KEY));
});

test('§21 without a usable updater the section only says that updates are off, and nothing is asked of anyone', async (t) => {
  for (const [name, updater] of [['no updater', null], ['a disabled updater (an unkeyed development folder)', stubUpdater({ enabled: false })]]) {
    const page = await openPage(t, { updater, hash: '#update' });
    assert.deepEqual(shown(page), ['update-section', 'update-status', 'update-disabled-note'], name);
    assert.equal(page.$('update-disabled-note').hidden, false, name);
    assert.equal(page.$('update-disabled-note').textContent, page.text('ext.updater.disabled'), name);
    for (const id of ['update-lead', 'update-detail', 'update-folder-help', 'update-actions', 'btn-update-folder', 'btn-update-now', 'btn-update-forget', 'update-auto-row']) {
      assert.equal(page.$(id).hidden, true, `${name}: #${id}`);
    }
    assert.equal(page.$('update-status').textContent, '', name);
    assert.equal(page.$('update-status').hidden, false, `${name}: the live region is never hidden`);
    assert.equal(page.$('btn-update-folder').listenerCount, 0, `${name}: no handler on a control that is not there`);
    if (updater) assert.deepEqual([updater.calls.status, updater.calls.check, updater.calls.choose, updater.calls.run.length], [0, 0, 0, 0], name);
  }
  assert.match(dictionaries.en.t('ext.updater.disabled'), /development build/i);
});

test('§21 each folder state shows the buttons it calls for, in words, with the check result beside it', async (t) => {
  const cases = [
    // [folder, available, buttons shown, label of the update button]
    ['none', true, ['btn-update-folder'], null],
    ['none', false, ['btn-update-folder'], null],
    ['gone', true, ['btn-update-folder', 'btn-update-forget'], null],
    ['granted', true, ['btn-update-now', 'btn-update-forget'], 'ext.updater.button.update'],
    ['granted', false, ['btn-update-forget'], null],
    ['needs-click', true, ['btn-update-now', 'btn-update-forget'], 'ext.updater.button.allow'],
    ['needs-click', false, ['btn-update-forget'], null],
  ];
  const detailKey = { none: 'ext.updater.folder.none', gone: 'ext.updater.folder.gone', granted: 'ext.updater.folder.granted', 'needs-click': 'ext.updater.folder.needsClick' };
  for (const [folder, available, buttons, label] of cases) {
    const updater = stubUpdater({ folder, check: { available, version: available ? '0.6.0' : '0.5.0' } });
    const page = await openPage(t, { updater });
    const name = `${folder}/${available ? 'newer' : 'current'}`;
    assert.deepEqual(shown(page, ['btn-update-folder', 'btn-update-now', 'btn-update-forget']), buttons, name);
    assert.equal(page.$('update-actions').hidden, buttons.length === 0, name);
    assert.equal(page.$('update-folder-help').hidden, !buttons.includes('btn-update-folder'), `${name}: the help for the picker shows with the picker's button`);
    assert.equal(page.$('update-disabled-note').hidden, true, name);
    if (label) assert.equal(page.$('btn-update-now').textContent, page.text(label), name);
    assert.equal(page.$('update-detail').textContent, page.text(detailKey[folder]), name);
    assert.equal(page.$('update-status').textContent,
      available ? page.text('ext.updater.available', { version: '0.6.0', current: '0.5.0' }) : page.text('ext.updater.check.none', { current: '0.5.0' }), name);
    assert.equal(page.$('update-status').getAttribute('data-kind'), null, name);
    assert.equal(updater.calls.check, 1, `${name}: the check runs when the page opens`);
    assert.deepEqual([updater.calls.choose, updater.calls.run.length], [0, 0], `${name}: nothing else runs without a click or #update`);
  }
});

test('§21 a check that could not be done says so; a stored interruption or failure is shown beside the folder state', async (t) => {
  for (const check of [{ available: false, version: null }, new Error('network'), null, 'nonsense']) {
    const page = await openPage(t, { updater: stubUpdater({ folder: 'granted', check }) });
    assert.equal(page.$('update-status').textContent, page.text('ext.updater.check.failed'), String(check));
    assert.equal(page.$('btn-update-now').hidden, true, 'nothing to update');
  }
  const page = await openPage(t, { updater: stubUpdater({ folder: 'granted', check: { available: false, version: '0.5.0' },
    pending: { version: '0.6.0', at: 5 }, lastError: 'UPDATE_WRITE_FAILED' }) });
  assert.equal(page.$('update-detail').textContent, [page.text('ext.updater.folder.granted'), page.text('ext.updater.pendingNote'),
    page.text('ext.updater.lastError', { error: page.text('ext.updater.error.UPDATE_WRITE_FAILED') })].join(' '));
  // A status that cannot be read leaves the page working, with no button it cannot stand behind.
  const broken = stubUpdater();
  broken.status = async () => { throw new Error('storage'); };
  const odd = await openPage(t, { updater: broken });
  assert.deepEqual(shown(odd, ['btn-update-folder', 'btn-update-now', 'btn-update-forget']), []);
  assert.equal(odd.$('update-disabled-note').hidden, true);
});

test('§21 opened without #update the page checks and offers, but never updates by itself', async (t) => {
  for (const hash of ['', '#other', '#update-now', '#UPDATE']) {
    const updater = stubUpdater({ folder: 'granted' });
    const page = await openPage(t, { updater, hash });
    assert.equal(updater.calls.check, 1, hash);
    assert.deepEqual([updater.calls.run.length, updater.calls.choose], [0, 0], `"${hash}": no run without the banner's #update or a click`);
    assert.equal(page.$('btn-update-now').hidden, false, hash);
    assert.notEqual(page.document.activeElement?.id, 'update-status', `"${hash}": opening the page does not move the focus`);
  }
});

test('§21 #update with a folder the browser lets us write to: the page updates at once, without asking for any permission', async (t) => {
  const updater = stubUpdater({ folder: 'granted', steps: ['checking', 'downloading', 'verifying', 'writing', 'reloading'] });
  let writes;
  const page = await openPage(t, { updater, hash: '#update', awaitStart: false, beforeStart: ({ $ }) => { writes = recordStatus($('update-status')); } });
  await page.started;
  await page.browser.settle();
  assert.deepEqual(updater.calls.run, [{ allowPrompt: false, hasOnStep: true }], 'one run, and it may not prompt: no click is behind it');
  assert.equal(updater.calls.choose, 0);
  assert.equal(updater.calls.check, 1);
  // First the page's own check and its news, then the run: every step it reports, in its order.
  assert.deepEqual(writes.filter((text, index) => text !== '' && text !== writes[index - 1]), [
    page.text('ext.updater.step.checking'), page.text('ext.updater.available', { version: '0.6.0', current: '0.5.0' }),
    ...['checking', 'downloading', 'verifying', 'writing', 'reloading'].map((step) => page.text(`ext.updater.step.${step}`)),
  ], 'every step, in the updater\'s order');
  assert.equal(page.$('update-status').textContent, page.text('ext.updater.step.reloading'), 'a success ends on "reloading": the page goes away');
});

test('§21 #update: each folder state shows the right first move, and only the click that follows may ask the browser', async (t) => {
  // needs-click: the button's own click is the user gesture, so IT runs the update with permission to prompt.
  const renew = stubUpdater({ folder: 'needs-click', steps: ['checking', 'reloading'] });
  const a = await openPage(t, { updater: renew, hash: '#update' });
  assert.equal(renew.calls.run.length, 0, 'no automatic run: a permission request from a page with no click would be refused');
  assert.equal(a.$('btn-update-now').hidden, false);
  assert.equal(a.$('btn-update-now').textContent, a.text('ext.updater.button.allow'));
  await a.click('btn-update-now');
  assert.deepEqual(renew.calls.run, [{ allowPrompt: true, hasOnStep: true }]);

  // none: the folder button comes first; its click chooses the folder and carries on to the update, still inside the click.
  const fresh = stubUpdater({ folder: 'none', steps: ['checking', 'downloading', 'reloading'] });
  const b = await openPage(t, { updater: fresh, hash: '#update' });
  assert.deepEqual([fresh.calls.choose, fresh.calls.run.length], [0, 0], 'the picker needs a click');
  assert.equal(b.$('btn-update-folder').hidden, false);
  assert.equal(b.$('btn-update-now').hidden, true);
  await b.click('btn-update-folder');
  assert.equal(fresh.calls.choose, 1);
  assert.deepEqual(fresh.calls.run, [{ allowPrompt: true, hasOnStep: true }], 'then the update, with the click\'s right to ask');
  assert.equal(b.$('update-status').textContent, b.text('ext.updater.step.reloading'));

  // none and nothing newer: the folder is saved and that is all
  const idle = stubUpdater({ folder: 'none', check: { available: false, version: '0.5.0' } });
  const c = await openPage(t, { updater: idle, hash: '#update' });
  await c.click('btn-update-folder');
  assert.deepEqual([idle.calls.choose, idle.calls.run.length], [1, 0]);
  assert.equal(c.$('update-status').textContent, `${c.text('ext.updater.folderSaved')} ${c.text('ext.updater.check.none', { current: '0.5.0' })}`);
  assert.equal(c.$('btn-update-folder').hidden, true, 'the folder is set now');
  assert.equal(c.$('btn-update-forget').hidden, false);

  // gone: the same first move as none
  const lost = stubUpdater({ folder: 'gone' });
  const d = await openPage(t, { updater: lost, hash: '#update' });
  assert.equal(lost.calls.run.length, 0);
  assert.equal(d.$('btn-update-folder').hidden, false);

  // granted but nothing newer, or no answer from the check: nothing to run
  for (const check of [{ available: false, version: '0.5.0' }, { available: false, version: null }]) {
    const quiet = stubUpdater({ folder: 'granted', check });
    await openPage(t, { updater: quiet, hash: '#update' });
    assert.equal(quiet.calls.run.length, 0);
  }
});

test('§21 #update brings the section into view and puts the keyboard focus on its status line', async (t) => {
  const updater = stubUpdater({ folder: 'needs-click' });
  const browser = createFakeBrowser();
  const page = await openPage(t, { browser, updater, hash: '#update', awaitStart: false });
  await page.started;
  assert.equal(page.document.activeElement?.id, 'update-status', 'a keyboard user lands on what the page says about the update');
  assert.equal(page.$('update-status').getAttribute('tabindex'), '-1', 'focusable by script, not a tab stop');
  assert.equal(page.$('update-status').getAttribute('role'), 'status');
});

test('§21 a click on the folder button asks the updater to choose, once; a double click while it works is ignored', async (t) => {
  const gate = deferred();
  const updater = stubUpdater({ folder: 'none', check: { available: false, version: '0.5.0' }, choose: async () => { await gate.promise; return { ok: true }; } });
  const page = await openPage(t, { updater });
  assert.equal(updater.calls.choose, 0);
  page.$('btn-update-folder').click();
  page.$('btn-update-folder').click();
  await page.browser.settle();
  await page.click('btn-update-folder');
  assert.equal(updater.calls.choose, 1, 'one picker, whatever the number of clicks');
  assert.equal(page.$('update-status').textContent, page.text('ext.updater.status.picking'), 'the page says what the browser is waiting for');
  for (const id of ['btn-update-folder', 'btn-update-now', 'btn-update-forget']) assert.equal(page.$(id).getAttribute('aria-disabled'), 'true', `#${id} is busy`);
  assert.equal(page.$('btn-update-folder').hasAttribute('disabled'), false, 'never natively disabled: the focus would drop');
  gate.resolve();
  await page.browser.settle();
  assert.equal(updater.calls.choose, 1);
  for (const id of ['btn-update-folder', 'btn-update-now', 'btn-update-forget']) assert.equal(page.$(id).hasAttribute('aria-disabled'), false, `#${id} is free again`);
});

test('§21 a double click on the update button runs the update once', async (t) => {
  const gate = deferred();
  const updater = stubUpdater({ folder: 'granted', run: async () => { await gate.promise; return { ok: false, code: 'UPDATE_FETCH_FAILED' }; }, steps: ['checking'] });
  const page = await openPage(t, { updater });
  page.$('btn-update-now').click();
  page.$('btn-update-now').click();
  page.$('btn-update-now').click();
  await page.browser.settle();
  assert.equal(updater.calls.run.length, 1);
  assert.equal(page.$('btn-update-now').getAttribute('aria-disabled'), 'true');
  gate.resolve();
  await page.browser.settle();
  assert.equal(page.$('btn-update-now').hasAttribute('aria-disabled'), false);
  await page.click('btn-update-now');   // after a failure the click works again
  assert.equal(updater.calls.run.length, 2);
  assert.deepEqual(updater.calls.run.map((call) => call.allowPrompt), [true, true], 'every run from a click may ask');
});

test('§21 the steps show in the order the updater reports them, in the live region, and the buttons wait meanwhile', async (t) => {
  const gates = Object.fromEntries(UPDATE_STEPS.map((step) => [step, deferred()]));
  const updater = stubUpdater({
    folder: 'granted',
    run: async () => ({ ok: true, version: '0.6.0' }),
  });
  updater.run = async (options) => {
    updater.calls.run.push({ allowPrompt: options.allowPrompt, hasOnStep: true });
    for (const step of UPDATE_STEPS) { options.onStep(step); await gates[step].promise; }
    return { ok: true, version: '0.6.0' };
  };
  const page = await openPage(t, { updater });
  assert.equal(page.$('update-status').getAttribute('role'), 'status');
  page.$('btn-update-now').click();
  await page.browser.settle();
  for (const step of UPDATE_STEPS) {
    assert.equal(page.$('update-status').textContent, page.text(`ext.updater.step.${step}`), step);
    assert.equal(page.$('update-status').hidden, false, `${step}: a live region is never hidden`);
    assert.equal(page.$('btn-update-now').getAttribute('aria-disabled'), 'true', `${step}: busy`);
    gates[step].resolve();
    await page.browser.settle();
  }
  assert.equal(page.$('update-status').textContent, page.text('ext.updater.step.reloading'));
  assert.equal(page.$('btn-update-now').getAttribute('aria-disabled'), 'true', 'after a success the page stays busy: the extension is about to reload');
  // ...but if it does not reload, the buttons come back, so the page is never stuck.
  await page.browser.clock.advance(14_999);
  assert.equal(page.$('btn-update-now').getAttribute('aria-disabled'), 'true');
  await page.browser.clock.advance(1);
  assert.equal(page.$('btn-update-now').hasAttribute('aria-disabled'), false);
  assert.equal(updater.calls.run.length, 1);
});

test('§21 every error code of the updater is shown as its own sentence, on a run and on choosing the folder, and the page recovers', async (t) => {
  for (const code of UPDATE_ERROR_CODES) {
    const running = stubUpdater({ folder: 'granted', run: async () => ({ ok: false, code }) });
    const page = await openPage(t, { updater: running });
    await page.click('btn-update-now');
    assert.equal(page.$('update-status').textContent, page.text(`ext.updater.error.${code}`), `run: ${code}`);
    assert.equal(page.$('update-status').getAttribute('data-kind'), 'error', `run: ${code}: marked as an error as well as worded`);
    assert.equal(page.$('btn-update-now').hasAttribute('aria-disabled'), false, `run: ${code}: the retry is possible`);
    assert.equal(page.$('btn-update-now').hidden, false);
    assert.ok(running.calls.status >= 2, `${code}: the folder state is read again after a failure`);

    const choosing = stubUpdater({ folder: 'none', choose: async () => ({ ok: false, code }) });
    const second = await openPage(t, { updater: choosing });
    await second.click('btn-update-folder');
    assert.equal(second.$('update-status').textContent, second.text(`ext.updater.error.${code}`), `choose: ${code}`);
    assert.equal(choosing.calls.run.length, 0, `choose: ${code}: a folder that was not chosen starts no update`);
    assert.equal(second.$('btn-update-folder').hidden, false);
  }
  // Nothing the updater could say may put a raw code or an exception text in front of a person.
  const odd = [async () => { throw new Error('UPDATE_SECRET_INTERNALS'); }, async () => ({ ok: false, code: 'SOMETHING_NEW' }), async () => undefined, async () => ({ ok: false })];
  for (const run of odd) {
    const page = await openPage(t, { updater: stubUpdater({ folder: 'granted', run }) });
    await page.click('btn-update-now');
    assert.equal(page.$('update-status').textContent, page.text('ext.updater.error.UNKNOWN'));
    assert.doesNotMatch(page.$('update-status').textContent, /SOMETHING_NEW|UPDATE_SECRET/);
  }
  const pick = await openPage(t, { updater: stubUpdater({ folder: 'none', choose: async () => { throw new Error('picker exploded'); } }) });
  await pick.click('btn-update-folder');
  assert.equal(pick.$('update-status').textContent, pick.text('ext.updater.error.UNKNOWN'));
});

test('§21 focus: a button that goes away does not take the keyboard focus with it', async (t) => {
  // choosing the folder replaces the folder button with the forget button
  const chosen = stubUpdater({ folder: 'none', check: { available: false, version: '0.5.0' } });
  const a = await openPage(t, { updater: chosen });
  a.$('btn-update-folder').focus();
  assert.equal(a.document.activeElement?.id, 'btn-update-folder');
  await a.click('btn-update-folder');
  assert.equal(a.$('btn-update-folder').hidden, true);
  assert.equal(a.document.activeElement?.id, 'update-status', 'the status line, which says what happened');
  // forgetting removes the forget button itself
  a.$('btn-update-forget').focus();
  await a.click('btn-update-forget');
  assert.equal(a.$('btn-update-forget').hidden, true);
  assert.equal(a.document.activeElement?.id, 'update-status');
  assert.equal(chosen.calls.forget, 1);
  assert.equal(a.$('opt-saved').textContent, a.text('ext.options.saved'), 'and the shared live region confirms it');
  // a button that stays (a failed update) keeps the focus where the person had it
  const failing = stubUpdater({ folder: 'granted', run: async () => ({ ok: false, code: 'UPDATE_FETCH_FAILED' }) });
  const b = await openPage(t, { updater: failing });
  b.$('btn-update-now').focus();
  await b.click('btn-update-now');
  assert.equal(b.document.activeElement?.id, 'btn-update-now');
});

test('§21 the automatic-update box shows the stored choice and writes the person\'s change through the updater', async (t) => {
  const updater = stubUpdater({ folder: 'granted', autoApply: false });
  const page = await openPage(t, { updater });
  assert.equal(page.$('update-auto').checked, false, 'the stored "off" is shown');
  assert.equal(page.$('update-auto').type, 'checkbox');
  assert.equal(page.$('update-auto').closest('label')?.id, 'update-auto-row');
  await page.fire('update-auto', 'change', { checked: true });
  assert.deepEqual(updater.calls.auto, [true]);
  assert.equal(page.$('update-auto').checked, true);
  assert.equal(page.$('opt-saved').textContent, page.text('ext.options.saved'));
  await page.fire('update-auto', 'change', { checked: false });
  assert.deepEqual(updater.calls.auto, [true, false]);
  assert.equal(page.$('update-auto').checked, false, 'the box keeps what was clicked');
  const fresh = await openPage(t, { updater: stubUpdater({ folder: 'none', autoApply: true }) });
  assert.equal(fresh.$('update-auto').checked, true);
});

test('§21 the section speaks the chosen language, and a language change re-words what is on screen', async (t) => {
  const updater = stubUpdater({ folder: 'needs-click' });
  const page = await openPage(t, { updater, languages: ['ko-KR'] });
  const ko = dictionaries.ko;
  assert.equal(page.$('opt-h-update').textContent, ko.t('ext.updater.title'));
  assert.equal(page.$('update-lead').textContent, ko.t('ext.updater.lead'));
  assert.equal(page.$('btn-update-now').textContent, ko.t('ext.updater.button.allow'));
  assert.equal(page.$('btn-update-folder').textContent, ko.t('ext.updater.button.chooseFolder'));
  assert.equal(page.$('update-status').textContent, ko.t('ext.updater.available', { version: '0.6.0', current: '0.5.0' }));
  assert.equal(page.$('update-detail').textContent, ko.t('ext.updater.folder.needsClick'));
  await page.fire('opt-ui-language', 'change', { value: 'ja' });
  const ja = dictionaries.ja;
  assert.equal(page.$('btn-update-now').textContent, ja.t('ext.updater.button.allow'));
  assert.equal(page.$('update-status').textContent, ja.t('ext.updater.available', { version: '0.6.0', current: '0.5.0' }));
  assert.equal(page.$('update-detail').textContent, ja.t('ext.updater.folder.needsClick'));
  assert.equal(page.$('update-auto-row').querySelector('span').textContent, ja.t('ext.updater.autoApply'));
});

test('§21 nothing is rendered as markup: a reason that looks like markup stays text', async (t) => {
  // The fake document throws on innerHTML, so reaching the end proves no markup was written; the text check proves where it went.
  const hostile = '<img src=x onerror=alert(1)>';
  const updater = stubUpdater({ folder: 'granted', lastError: 'UPDATE_BAD_HASH' });
  updater.status = async () => ({ enabled: true, folder: 'granted', autoApply: true, appliedVersion: null, pending: null, lastError: hostile });
  const page = await openPage(t, { updater });
  assert.doesNotMatch(page.$('update-detail').textContent, /<img|onerror/, 'an unknown error text is replaced by the generic sentence, never echoed');
  assert.equal(page.$('update-detail').children.length, 0);
});

test('§21 dispose removes the update handlers and the reload timer', async (t) => {
  const updater = stubUpdater({ folder: 'granted' });
  const page = await openPage(t, { updater, keepStopped: true });
  const ids = ['btn-update-folder', 'btn-update-now', 'btn-update-forget', 'update-auto'];
  for (const id of ids) assert.ok(page.$(id).listenerCount > 0, `#${id} is bound`);
  await page.click('btn-update-now');   // a success leaves the reload timer pending
  assert.ok(page.browser.clock.pending() > 0);
  page.controller.dispose();
  for (const id of ids) assert.equal(page.$(id).listenerCount, 0, `#${id} has no listener left`);
  assert.equal(page.browser.clock.pending(), 0);
  const before = updater.calls.run.length;
  await page.click('btn-update-now');
  assert.equal(updater.calls.run.length, before, 'a click after dispose does nothing');
});

test('§21 the options controller names no fetch, no hash, no file system and no storage of the update itself', () => {
  const source = readFileSync(fileURLToPath(new URL('../extension/options/controller.js', import.meta.url)), 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*\/\//.test(line)).map((line) => line.replace(/\s\/\/.*$/, '')).join('\n');
  for (const word of ['fetch(', 'crypto', 'subtle', 'showDirectoryPicker', 'requestPermission', 'queryPermission', 'createWritable', 'indexedDB',
    'innerHTML', 'sha256']) {
    assert.equal(code.includes(word), false, `controller.js does not name ${word}`);
  }
  const entry = readFileSync(fileURLToPath(new URL('../extension/options/options.js', import.meta.url)), 'utf8');
  assert.match(entry, /pickDirectory: \(\) => globalThis\.showDirectoryPicker\(\{ mode: 'readwrite', id: 'li-extension' \}\)/);
  assert.match(entry, /keyed: BUILTIN_KEYS\.length > 0/);
});
