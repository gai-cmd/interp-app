// New implementation of docs/extension.md §7.3, §7.4 and §8.3; no legacy code is ported.
// The options page controller. Every control saves on `change` through ONE one-field settings write; the key has its
// own Save. The key is written only after storage.local.setAccessLevel('TRUSTED_CONTEXTS') succeeded (the promise that
// `ext.keyStorage` makes to the user is only made when the level really was set), it is cleared from the input after
// the save, and it is never read back into the page: the page shows a stored / not-stored state and nothing else.
import { selectLanguage } from '../../app/i18n/index.js';
import { LIVE_MODELS } from '../../app/providers/gemini/live-config.js';
import { validateKey } from '../../app/security/shared-key.js';
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { STYLE_LIMITS } from '../lib/constants.js';
import { applyI18n } from '../lib/dom-i18n.js';
import { createFallbackI18n } from '../lib/i18n.js';
import { KEY_GUIDE_URL } from '../lib/links.js';
import { STORAGE_KEYS } from '../lib/protocol.js';
import {
  createDefaultSettings, deleteKey, hasKey, normalizeSettings, readSettings, setLaneTargetLanguage, updateSettings, writeKey,
  writeSettings,
} from '../lib/settings.js';

const SAVED_FLASH_MS = 2_000;
const I18N_RETRY_MS = Object.freeze([2_000, 6_000, 18_000]);
// sim.model0..2 are the labels of LIVE_MODELS by index (9.4); a model beyond the table shows its own id. sim.model0
// carries the app's "(default)" tag, which is true for the microphone only: the tab lane's default is the translation
// model, so its select shows the same model without the tag.
const MODEL_KEYS = Object.freeze({
  'opt-model-tab': Object.freeze(['ext.options.modelLive', 'sim.model1', 'sim.model2']),
  'opt-model-mic': Object.freeze(['sim.model0', 'sim.model1', 'sim.model2']),
});

// [control id, how the control is read, getter, setter, integer range]. Every control of 7.3 that maps to one setting.
// The range is checked here because normalizeStyle would quietly turn an out-of-range integer into the DEFAULT.
const FIELDS = Object.freeze([
  ['opt-ui-language', 'value', (s) => s.uiLanguage, (s, v) => { s.uiLanguage = v; }],
  // The page shows no two-way control, but a stored pair must survive a target change here exactly as in the panel.
  ['opt-target-tab', 'value', (s) => s.lanes.tab.targetLanguage, (s, v) => { setLaneTargetLanguage(s, 'tab', v); }],
  ['opt-target-mic', 'value', (s) => s.lanes.mic.targetLanguage, (s, v) => { setLaneTargetLanguage(s, 'mic', v); }],
  ['opt-model-tab', 'value', (s) => s.lanes.tab.model, (s, v) => { s.lanes.tab.model = v; }],
  ['opt-model-mic', 'value', (s) => s.lanes.mic.model, (s, v) => { s.lanes.mic.model = v; }],
  ['opt-voice', 'value', (s) => s.voiceGender, (s, v) => { s.voiceGender = v; }],
  ['opt-volume', 'number', (s) => s.lanes.tab.originalVolume, (s, v) => { s.lanes.tab.originalVolume = v; }],
  ['opt-captions-tab', 'checked', (s) => s.lanes.tab.captions, (s, v) => { s.lanes.tab.captions = v; }],
  ['opt-captions-mic', 'checked', (s) => s.lanes.mic.captions, (s, v) => { s.lanes.mic.captions = v; }],
  ['opt-caption-size', 'number', (s) => s.captions.size, (s, v) => { s.captions.size = v; }],
  ['opt-caption-position', 'value', (s) => s.captions.position, (s, v) => { s.captions.position = v; }],
  ['opt-caption-display', 'value', (s) => s.captions.display, (s, v) => { s.captions.display = v; }],
  ['opt-caption-source', 'checked', (s) => s.captions.showSource, (s, v) => { s.captions.showSource = v; }],
  ['opt-caption-lines', 'number', (s) => s.captions.maxLines, (s, v) => { s.captions.maxLines = v; }, STYLE_LIMITS.maxLines],
  ['opt-caption-hide', 'number', (s) => s.captions.autoHideSeconds, (s, v) => { s.captions.autoHideSeconds = v; }, STYLE_LIMITS.autoHideSeconds],
]);

// Every element id the controller touches; a test parses options.html and checks each one exists (8.1).
export const OPTIONS_ELEMENT_IDS = Object.freeze([
  ...FIELDS.map(([id]) => id),
  'opt-key', 'opt-key-toggle', 'opt-key-save', 'opt-key-delete', 'opt-key-status', 'opt-key-guide',
  'opt-volume-value', 'opt-caption-size-value', 'opt-saved',
]);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const settle = async (task) => { try { return await task(); } catch { return undefined; } };
const isObject = (value) => value !== null && typeof value === 'object';

const defaultSettingsApi = Object.freeze({ readSettings, updateSettings, writeSettings, writeKey, deleteKey, hasKey });

/** createOptionsController({ document, adapter, i18n: { current }, loadI18n, settingsApi, timers, navigator }) -> { start, dispose } */
export function createOptionsController({
  document, adapter, i18n, loadI18n, settingsApi = defaultSettingsApi, timers = {}, navigator = {},
} = {}) {
  const setTimeout = timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimeout = timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const local = adapter.storage.local;
  const t = (key, params) => i18n.current.t(key, params);

  const S = { settings: createDefaultSettings('en'), keyStored: false, keyFlash: null, savedKey: null, appliedLanguage: null };
  let disposed = false;
  let savedTimer = null;
  let retryTimer = null;
  const els = new Map();
  const removers = [];

  const setText = (id, text) => { const el = els.get(id); if (el && el.textContent !== text) el.textContent = text; };
  function setControl(id, kind, value) {
    const el = els.get(id);
    if (!el) return;
    if (kind === 'checked') { if (el.checked !== value) el.checked = value; } else if (String(el.value) !== String(value)) el.value = String(value);
  }

  // A short confirmation in the persistent live region #opt-saved; an error stays until the next successful write.
  function flash(key, { sticky = false } = {}) {
    clearTimeout(savedTimer);
    savedTimer = null;
    setText('opt-saved', t(key));
    if (!sticky) savedTimer = setTimeout(() => { savedTimer = null; setText('opt-saved', ''); }, SAVED_FLASH_MS);
  }

  function fillModels() {
    for (const id of ['opt-model-tab', 'opt-model-mic']) {
      const select = els.get(id);
      if (!select) continue;
      const labels = MODEL_KEYS[id];
      const options = LIVE_MODELS.map((model, index) => {
        const option = document.createElement('option');
        option.setAttribute('value', model);
        option.textContent = labels[index] ? t(labels[index]) : model;
        return option;
      });
      select.replaceChildren(...options);
    }
  }

  function keyStatusKey() {
    if (S.keyFlash) return S.keyFlash;
    if (S.keyStored) return 'settings.keyStored';
    return BUILTIN_KEYS.length > 0 ? 'ext.key.builtin' : 'settings.noKey';
  }
  function renderToggle() {
    const input = els.get('opt-key');
    setText('opt-key-toggle', t(input?.type === 'text' ? 'ext.options.keyHide' : 'ext.options.keyShow'));
  }

  function render() {
    if (disposed || !i18n.current) return;
    const { settings } = S;
    for (const [id, kind, get] of FIELDS) setControl(id, kind, get(settings));
    setText('opt-volume-value', t('ext.volume.value', { percent: settings.lanes.tab.originalVolume }));
    setText('opt-caption-size-value', t('display.captions.value', { size: settings.captions.size }));
    setText('opt-key-status', t(keyStatusKey()));
    renderToggle();
  }

  function resolvedLanguage() {
    return S.settings.uiLanguage === 'auto' ? selectLanguage(navigator.languages ?? []) : S.settings.uiLanguage;
  }
  function applyLanguageIfChanged() {
    const language = resolvedLanguage();
    if (S.appliedLanguage === language) return;
    S.appliedLanguage = language;
    i18n.current.setLanguage(language);
    applyI18n(document, i18n.current);
    fillModels();
  }

  async function writeField(mutator) {
    try {
      S.settings = await settingsApi.updateSettings(local, mutator);
      flash('ext.options.saved');
    } catch { flash('ext.error.STORAGE_FAILED', { sticky: true }); }
    applyLanguageIfChanged();
    render();
  }

  function onFieldChange([id, kind, , set, range]) {
    const el = els.get(id);
    if (!el) return undefined;
    let value;
    if (kind === 'checked') value = el.checked === true;
    else if (kind === 'number') {
      const typed = Number(el.value);
      const usable = String(el.value).trim() !== '' && Number.isFinite(typed)
        && (range === undefined || (Number.isInteger(typed) && typed >= range.min && typed <= range.max));
      // Not a value the setting can hold: put the STORED value back and say nothing. Writing it would have shown
      // "Saved." while the field silently snapped to a default that is neither what was typed nor what was there.
      if (!usable) { render(); return undefined; }
      value = typed;
    } else value = el.value;
    return writeField((settings) => set(settings, value));
  }

  // ---------------------------------------------------------------------------------------------
  // The key (7.4). Nothing here echoes it: failures name a code, successes clear the input.
  async function saveKey() {
    const input = els.get('opt-key');
    if (!input) return;
    const value = typeof input.value === 'string' ? input.value.trim() : '';
    try { validateKey(value); } catch { S.keyFlash = 'error.INVALID_KEY'; render(); return; }
    const setLevel = local.setAccessLevel;
    if (typeof setLevel !== 'function') { S.keyFlash = 'ext.error.STORAGE_FAILED'; render(); return; }
    try { await setLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { S.keyFlash = 'ext.error.STORAGE_FAILED'; render(); return; }
    try { await settingsApi.writeKey(local, value); } catch (error) {
      S.keyFlash = attempt(() => error.code) === 'INVALID_KEY' ? 'error.INVALID_KEY' : 'ext.error.STORAGE_FAILED';
      render();
      return;
    }
    input.value = '';
    S.keyStored = true;
    S.keyFlash = 'ext.key.savedBrowser';   // not the app's settings.keySavedBrowser: its Korean text is in a formal register
    render();
  }
  async function removeKey() {
    const input = els.get('opt-key');
    try { await settingsApi.deleteKey(local); } catch { S.keyFlash = 'ext.error.STORAGE_FAILED'; render(); return; }
    if (input) input.value = '';
    S.keyStored = false;
    S.keyFlash = 'settings.keyDeleted';
    render();
  }
  function toggleKey() {
    const input = els.get('opt-key');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    renderToggle();
  }
  async function refreshKey() {
    const present = await settle(() => settingsApi.hasKey(local));
    if (disposed) return;
    S.keyStored = present === true;
    render();
  }

  // ---------------------------------------------------------------------------------------------
  function onStorageChanged(changes, areaName) {
    if (disposed || areaName !== 'local' || !isObject(changes)) return;
    if (changes[STORAGE_KEYS.settings]) {
      S.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);   // an edit made in the panel shows up live
      applyLanguageIfChanged();
    }
    if (changes[STORAGE_KEYS.key]) void refreshKey();
    render();
  }

  function scheduleI18nRetry(round) {
    if (disposed || round >= I18N_RETRY_MS.length) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      try {
        i18n.current = await loadDictionaries();
        S.appliedLanguage = null;
        applyLanguageIfChanged();
        render();
      } catch { scheduleI18nRetry(round + 1); }
    }, I18N_RETRY_MS[round]);
  }
  function loadDictionaries() {
    const language = S.settings.uiLanguage === 'auto' ? undefined : S.settings.uiLanguage;
    return loadI18n({ language, languages: navigator.languages ?? [] });
  }

  function bind(id, type, handler) {
    const el = els.get(id);
    if (!el) return;
    const wrapped = (event) => { void Promise.resolve().then(() => handler(event)).catch(() => {}); };
    el.addEventListener(type, wrapped);
    removers.push(() => el.removeEventListener(type, wrapped));
  }

  async function start() {
    for (const id of OPTIONS_ELEMENT_IDS) {
      const el = document.getElementById(id);
      if (el) els.set(id, el);
    }
    let storageFailed = false;
    try {
      const stored = await local.get(STORAGE_KEYS.settings);
      if (isObject(stored) && stored[STORAGE_KEYS.settings] === undefined) {
        // First run: seed the two target languages from the browser language instead of the bare defaults.
        S.settings = createDefaultSettings(selectLanguage(navigator.languages ?? []));
        await settle(() => settingsApi.writeSettings(local, S.settings));
      } else {
        S.settings = await settingsApi.readSettings(local);
      }
    } catch { storageFailed = true; }   // the page shows the defaults, never an exception
    const present = await settle(() => settingsApi.hasKey(local));
    S.keyStored = present === true;
    try { i18n.current = await loadDictionaries(); } catch {
      i18n.current = createFallbackI18n({ language: S.settings.uiLanguage === 'auto' ? undefined : S.settings.uiLanguage });
      scheduleI18nRetry(0);
    }
    S.appliedLanguage = null;
    applyLanguageIfChanged();
    els.get('opt-key-guide')?.setAttribute('href', KEY_GUIDE_URL);
    render();
    if (storageFailed) flash('ext.error.STORAGE_FAILED', { sticky: true });

    for (const field of FIELDS) {
      bind(field[0], 'change', () => onFieldChange(field));
    }
    // The range outputs follow the thumb while it moves; only `change` saves.
    bind('opt-volume', 'input', () => setText('opt-volume-value', t('ext.volume.value', { percent: Number(els.get('opt-volume').value) })));
    bind('opt-caption-size', 'input', () => setText('opt-caption-size-value',
      t('display.captions.value', { size: Number(els.get('opt-caption-size').value) })));
    bind('opt-key-save', 'click', saveKey);
    bind('opt-key-delete', 'click', removeKey);
    bind('opt-key-toggle', 'click', toggleKey);
    const changed = adapter.storage.onChanged;
    if (typeof changed?.addListener === 'function') {
      changed.addListener(onStorageChanged);
      removers.push(() => attempt(() => changed.removeListener(onStorageChanged)));
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(savedTimer);
    clearTimeout(retryTimer);
    for (const remove of removers.splice(0)) remove();
  }

  return Object.freeze({ start, dispose });
}
