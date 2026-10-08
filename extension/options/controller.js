// New implementation of docs/extension.md §7.3, §7.4, §8.3 and §21; no legacy code is ported.
// The options page controller. Every control saves on `change` through ONE one-field settings write; the key has its
// own Save. The key is written only after storage.local.setAccessLevel('TRUSTED_CONTEXTS') succeeded (the promise that
// `ext.keyStorage` makes to the user is only made when the level really was set), it is cleared from the input after
// the save, and it is never read back into the page: the page shows a stored / not-stored state and nothing else.
// §21: the "Automatic updates" section drives the injected self-updater (createSelfUpdater). This page is where the
// two things that need a person happen: choosing the folder (a click, so the picker has user activation) and allowing
// the browser to write to it again (a click, so the permission request has one). Nothing here fetches, hashes or writes
// by itself; it asks the updater and shows what the updater says, in words (every code and step has a literal key).
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
// §21: after a run reported success the extension reloads and this page goes away. If it is still here after this long,
// the reload did not happen: the buttons come back instead of staying greyed out forever.
const RELOAD_WAIT_MS = 15_000;
const I18N_RETRY_MS = Object.freeze([2_000, 6_000, 18_000]);
// sim.model0..2 are the labels of LIVE_MODELS by index (9.4); a model beyond the table shows its own id. sim.model0
// carries the app's "(default)" tag. Both lanes default to the latest Live model since 0.5.1 (2026-10-08; the tab
// lane's default used to be the translation model); the tab select keeps its plain label of that model and says the
// default in its hint (ext.options.modelTabHint).
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

// §21: one literal table per kind of text, so the i18n checker sees every key. A step or an error code the table does not
// know gets the generic sentence, never a raw code in front of a person. tests/extension-options.test.mjs checks the
// error table against UPDATE_ERROR_CODES of extension/lib/self-update.js.
export const UPDATE_STEP_KEY = Object.freeze({
  checking: 'ext.updater.step.checking', downloading: 'ext.updater.step.downloading', verifying: 'ext.updater.step.verifying',
  writing: 'ext.updater.step.writing', reloading: 'ext.updater.step.reloading',
});
export const UPDATE_ERROR_KEY = Object.freeze({
  UPDATE_DISABLED: 'ext.updater.error.UPDATE_DISABLED', UPDATE_NO_FOLDER: 'ext.updater.error.UPDATE_NO_FOLDER',
  UPDATE_NEEDS_PERMISSION: 'ext.updater.error.UPDATE_NEEDS_PERMISSION', UPDATE_PERMISSION_DENIED: 'ext.updater.error.UPDATE_PERMISSION_DENIED',
  UPDATE_WRONG_FOLDER: 'ext.updater.error.UPDATE_WRONG_FOLDER', UPDATE_NOT_NEWER: 'ext.updater.error.UPDATE_NOT_NEWER',
  UPDATE_FETCH_FAILED: 'ext.updater.error.UPDATE_FETCH_FAILED', UPDATE_BAD_SIGNATURE: 'ext.updater.error.UPDATE_BAD_SIGNATURE',
  UPDATE_BAD_MANIFEST: 'ext.updater.error.UPDATE_BAD_MANIFEST', UPDATE_UNSAFE_PATH: 'ext.updater.error.UPDATE_UNSAFE_PATH',
  UPDATE_TOO_LARGE: 'ext.updater.error.UPDATE_TOO_LARGE', UPDATE_BAD_HASH: 'ext.updater.error.UPDATE_BAD_HASH',
  UPDATE_WRITE_FAILED: 'ext.updater.error.UPDATE_WRITE_FAILED', UPDATE_PICK_CANCELLED: 'ext.updater.error.UPDATE_PICK_CANCELLED',
  UPDATE_BUSY: 'ext.updater.error.UPDATE_BUSY',
});
const UPDATE_UNKNOWN_ERROR_KEY = 'ext.updater.error.UNKNOWN';
const FOLDER_KEY = Object.freeze({
  none: 'ext.updater.folder.none', granted: 'ext.updater.folder.granted', 'needs-click': 'ext.updater.folder.needsClick',
  gone: 'ext.updater.folder.gone',
});
const stepKeyOf = (step) => (Object.hasOwn(UPDATE_STEP_KEY, step) ? UPDATE_STEP_KEY[step] : UPDATE_STEP_KEY.checking);
const errorKeyOf = (code) => (typeof code === 'string' && Object.hasOwn(UPDATE_ERROR_KEY, code) ? UPDATE_ERROR_KEY[code] : UPDATE_UNKNOWN_ERROR_KEY);
// The controls of the section that stay hidden when the updater is off, and the three buttons (focus is rescued from them).
const UPDATE_LIVE_ONLY_IDS = Object.freeze(['update-lead', 'update-detail', 'update-actions', 'update-auto-row']);
const UPDATE_BUTTON_IDS = Object.freeze(['btn-update-folder', 'btn-update-now', 'btn-update-forget']);

// Every element id the controller touches; a test parses options.html and checks each one exists (8.1).
export const OPTIONS_ELEMENT_IDS = Object.freeze([
  ...FIELDS.map(([id]) => id),
  'opt-key', 'opt-key-toggle', 'opt-key-save', 'opt-key-delete', 'opt-key-status', 'opt-key-guide',
  'opt-volume-value', 'opt-caption-size-value', 'opt-saved',
  'update-section', 'update-lead', 'update-status', 'update-detail', 'update-folder-help', 'update-actions', ...UPDATE_BUTTON_IDS,
  'update-auto', 'update-auto-row', 'update-disabled-note',
]);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const settle = async (task) => { try { return await task(); } catch { return undefined; } };
const isObject = (value) => value !== null && typeof value === 'object';

const defaultSettingsApi = Object.freeze({ readSettings, updateSettings, writeSettings, writeKey, deleteKey, hasKey });

/**
 * createOptionsController({ document, adapter, i18n: { current }, loadI18n, settingsApi, timers, navigator, updater, hash })
 * -> { start, dispose }. `updater` (§21, createSelfUpdater) drives the "Automatic updates" section; without one, or when it is
 * not `enabled` (an unkeyed development folder), the section only says that updates are off. `hash` is the page's
 * location.hash: "#update" means the person came from the panel's update banner, so the page checks at once and, when the
 * folder is writable without a prompt, updates without being asked again.
 */
export function createOptionsController({
  document, adapter, i18n, loadI18n, settingsApi = defaultSettingsApi, timers = {}, navigator = {}, updater = null, hash = '',
} = {}) {
  const setTimeout = timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimeout = timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const local = adapter.storage.local;
  const t = (key, params) => i18n.current.t(key, params);

  const S = { settings: createDefaultSettings('en'), keyStored: false, keyFlash: null, savedKey: null, appliedLanguage: null };
  // §21: what the section knows. `status` = updater.status(), `check` = the last updater.check() ({ available, version }),
  // `step` = the step of a run in progress, `checking` = the check on page open is under way, `picking` = the folder
  // picker is open, `busy` = an action (choose, update, forget) is running: a second click is ignored while it is.
  const U = { status: null, check: null, step: null, checking: false, picking: false, busy: false, error: null, notice: null };
  const updaterEnabled = isObject(updater) && updater.enabled === true;
  let disposed = false;
  let savedTimer = null;
  let retryTimer = null;
  let reloadTimer = null;
  const els = new Map();
  const removers = [];

  const setText = (id, text) => { const el = els.get(id); if (el && el.textContent !== text) el.textContent = text; };
  const setHidden = (id, hidden) => { const el = els.get(id); if (el && el.hidden !== hidden) el.hidden = hidden; };
  function setAttr(id, name, value) {
    const el = els.get(id);
    if (!el) return;
    if (value === null) { if (el.getAttribute(name) !== null) el.removeAttribute(name); } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
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
    renderUpdate();
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
  // §21: the "Automatic updates" section.
  const runningVersion = () => { const version = attempt(() => adapter.runtime.getManifest?.().version); return typeof version === 'string' ? version : ''; };
  const codeOf = (result) => (isObject(result) && typeof result.code === 'string' ? result.code : 'UNKNOWN');

  // One sentence per state, in priority order: the picker is open, a step runs, the check runs, a failure, then the
  // news (the folder was saved; a newer version exists / you are up to date / the check did not work).
  function updateStatusLine() {
    if (U.picking) return { text: t('ext.updater.status.picking'), kind: null };
    if (U.step !== null) return { text: t(stepKeyOf(U.step)), kind: null };
    if (U.checking) return { text: t(UPDATE_STEP_KEY.checking), kind: null };
    if (U.error !== null) return { text: t(errorKeyOf(U.error)), kind: 'error' };
    const parts = [];
    if (U.notice !== null) parts.push(t(U.notice));
    if (U.check !== null) {
      if (U.check.available) parts.push(t('ext.updater.available', { version: U.check.version, current: runningVersion() }));
      else if (U.check.version !== null) parts.push(t('ext.updater.check.none', { current: runningVersion() }));
      else parts.push(t('ext.updater.check.failed'));
    }
    return { text: parts.join(' '), kind: null };
  }
  function updateDetailLine() {
    const { status } = U;
    if (!isObject(status)) return '';
    const parts = [];
    if (Object.hasOwn(FOLDER_KEY, status.folder)) parts.push(t(FOLDER_KEY[status.folder]));
    if (isObject(status.pending)) parts.push(t('ext.updater.pendingNote'));
    // The reason of the last failed attempt (maybe the panel's silent one) while this page shows no failure of its own.
    if (typeof status.lastError === 'string' && U.error === null && U.step === null) {
      parts.push(t('ext.updater.lastError', { error: t(errorKeyOf(status.lastError)) }));
    }
    return parts.join(' ');
  }

  function renderUpdate() {
    if (disposed || !i18n.current || !els.has('update-section')) return;
    for (const id of UPDATE_LIVE_ONLY_IDS) setHidden(id, !updaterEnabled);
    setHidden('update-disabled-note', updaterEnabled);
    if (!updaterEnabled) {
      setHidden('update-folder-help', true);
      setText('update-status', '');
      return;
    }
    const folder = isObject(U.status) ? U.status.folder : null;
    const available = U.check?.available === true;
    const choose = folder === 'none' || folder === 'gone';
    const now = (folder === 'granted' || folder === 'needs-click') && available;
    const forget = folder !== null && folder !== 'none';
    // The focus rescue below needs to know where it was BEFORE anything is hidden.
    const focused = document.activeElement;
    setHidden('btn-update-folder', !choose);
    setHidden('btn-update-now', !now);
    setHidden('btn-update-forget', !forget);
    setHidden('update-actions', !(choose || now || forget));
    setHidden('update-folder-help', !choose);
    setText('btn-update-now', t(folder === 'needs-click' ? 'ext.updater.button.allow' : 'ext.updater.button.update'));
    // aria-disabled, never `disabled`: a natively disabled button drops the keyboard focus the click just had. The
    // handlers ignore a click while an action runs.
    for (const id of UPDATE_BUTTON_IDS) setAttr(id, 'aria-disabled', U.busy ? 'true' : null);
    const auto = els.get('update-auto');
    const wanted = !isObject(U.status) || U.status.autoApply !== false;
    if (auto && auto.checked !== wanted) auto.checked = wanted;
    const line = updateStatusLine();
    setText('update-status', line.text);
    setAttr('update-status', 'data-kind', line.kind);
    setText('update-detail', updateDetailLine());
    // A button that just went away (the folder was chosen, forgotten, or the update is under way) must not take the
    // keyboard focus with it: it goes to the status line, which says what happened.
    const gone = UPDATE_BUTTON_IDS.map((id) => els.get(id)).find((el) => el && el === focused && (el.hidden || el.parentElement?.hidden));
    if (gone) attempt(() => els.get('update-status')?.focus());
  }

  async function refreshUpdateStatus() {
    const status = await settle(() => updater.status());
    if (disposed) return;
    if (isObject(status)) U.status = status;
  }

  async function checkForNewVersion() {
    U.checking = true;
    renderUpdate();
    const result = await settle(() => updater.check());
    if (disposed) return;
    U.checking = false;
    U.check = isObject(result)
      ? { available: result.available === true, version: typeof result.version === 'string' ? result.version : null }
      : { available: false, version: null };
    renderUpdate();
  }

  // `allowPrompt` is true only when a click started this (a user gesture, so the browser may ask); the automatic run for
  // "#update" never asks. A success leaves the buttons off: the updater reloaded the extension and this page goes away.
  async function runUpdate({ allowPrompt }) {
    U.error = null;
    U.notice = null;
    U.step = 'checking';
    renderUpdate();
    let result;
    try { result = await updater.run({ onStep: onUpdateStep, allowPrompt }); } catch { result = null; }
    if (disposed) return false;
    if (isObject(result) && result.ok === true) {
      U.step = 'reloading';
      reloadTimer = setTimeout(() => { reloadTimer = null; U.step = null; U.busy = false; renderUpdate(); }, RELOAD_WAIT_MS);
      renderUpdate();
      return true;
    }
    U.step = null;
    U.error = codeOf(result);
    await refreshUpdateStatus();
    return false;
  }
  function onUpdateStep(name) {
    if (disposed || U.step === null) return;
    U.step = typeof name === 'string' ? name : U.step;
    renderUpdate();
  }

  // Every action is: claim `busy` synchronously (a second click that arrives while it runs is ignored), do it, release.
  async function guarded(action) {
    if (U.busy || disposed || !updaterEnabled) return;
    U.busy = true;
    let reloading = false;
    try { reloading = (await action()) === true; } finally {
      if (!disposed && !reloading) { U.busy = false; renderUpdate(); }
    }
  }

  const onUpdateNow = () => guarded(() => runUpdate({ allowPrompt: true }));
  const onChooseFolder = () => guarded(async () => {
    U.error = null;
    U.notice = null;
    U.picking = true;
    renderUpdate();
    let result;
    // The picker is the first thing awaited: this runs inside the click, which is the user activation it needs.
    try { result = await updater.chooseFolder(); } catch { result = null; }
    U.picking = false;
    if (disposed) return false;
    if (!isObject(result) || result.ok !== true) {
      U.error = codeOf(result);
      await refreshUpdateStatus();
      return false;
    }
    await refreshUpdateStatus();
    // The folder is chosen and writable now; when a newer version exists the click carries on to the update.
    if (U.check?.available === true) return runUpdate({ allowPrompt: true });
    U.notice = 'ext.updater.folderSaved';
    return false;
  });
  const onForget = () => guarded(async () => {
    U.error = null;
    U.notice = null;
    await settle(() => updater.forgetFolder());
    await refreshUpdateStatus();
    flash('ext.options.saved');
    return false;
  });
  async function onAutoApply() {
    if (!updaterEnabled) return;
    const wanted = els.get('update-auto')?.checked === true;
    if (isObject(U.status)) U.status = { ...U.status, autoApply: wanted };   // the box keeps what was just clicked while the write is under way
    await settle(() => updater.setAutoApply(wanted));
    await refreshUpdateStatus();
    flash('ext.options.saved');
    renderUpdate();
  }

  async function startUpdate() {
    renderUpdate();
    if (!updaterEnabled) return;
    bind('btn-update-folder', 'click', onChooseFolder);
    bind('btn-update-now', 'click', onUpdateNow);
    bind('btn-update-forget', 'click', onForget);
    bind('update-auto', 'change', onAutoApply);
    const arrived = hash === '#update';
    await refreshUpdateStatus();
    if (disposed) return;
    renderUpdate();
    if (arrived) {
      // The page is long and its section id is not "update": bring the section into view and let a keyboard user start there.
      attempt(() => els.get('update-section')?.scrollIntoView?.());
      attempt(() => els.get('update-status')?.focus());
    }
    await checkForNewVersion();
    // From the panel's banner with a folder the browser lets us write to right now: nothing to ask, so do it.
    if (arrived && !disposed && U.check?.available === true && U.status?.folder === 'granted') {
      await guarded(() => runUpdate({ allowPrompt: false }));
    }
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
    await startUpdate();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(savedTimer);
    clearTimeout(retryTimer);
    clearTimeout(reloadTimer);
    for (const remove of removers.splice(0)) remove();
  }

  return Object.freeze({ start, dispose });
}
