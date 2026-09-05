// New implementation of design-v0.6 §§6.2, 6.3, 7.4, 11 and 12: the settings
// screen mounted into the shell's settings dialog. One registered provider
// shows its title only; the provider picker appears once two or more are
// registered. Keys are addressed as (providerId, keySource): personal keys
// can be entered, checked, deleted and optionally remembered; shared keys are
// shown as temporary event credentials; hub-only providers get no key input.
// Saving a key never starts a check, and mode changes are explicit. Key values
// never reach the DOM, notices or logs; the input is cleared on save.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { VOICE_OUTPUTS } from '../state.js';
import { redact } from '../security/redact.js';
import { createBinder, SOURCE_OPTIONS } from './seq-view.js';
import { errorKey, resolveKey } from './errors.js';
import { createDiagnosticsView } from './diagnostics-view.js';

export const KEY_SOURCES = Object.freeze(['personal', 'shared']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** Whether a provider accepts a browser-entered key of this source (§7.4, §20.2). */
export function acceptsDirectKey(descriptor, keySource) {
  if (!descriptor?.browserDirect || !KEY_SOURCES.includes(keySource)) return false;
  return descriptor.credentialPolicy[keySource === 'personal' ? 'directPersonal' : 'directShared'] === true;
}

/** Key-store failures carry security or provider codes; anything else is generic. */
export function keyStoreErrorKey(error) {
  return `error.${redact(error).code}`;
}

/** A pasted QR link or fragment reduces to the fragment the key store accepts. */
export function sharedFragmentFrom(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const index = text.indexOf('#');
  return index === -1 ? '' : text.slice(index);
}

/**
 * createSettingsView({ shell, i18n, config, engine, diagnostics, document?,
 *   persistence?, app?, getDeviceVoices?, onUiLanguageChange? })
 * mounts into shell.elements.panels.settingsBody and re-renders through
 * shell.onLanguageChange. engine is the sequential engine (state,
 * setInterpretation, setVoice); diagnostics is createDiagnostics()'s result.
 * persistence says whether a storage was given to the key store (the
 * "remember" option is offered only then). app is { version?, standalone? }
 * for the app section; getDeviceVoices() lists SpeechSynthesis voices.
 * Optional metrics and hub expose snapshot()/subscribe(); the composition root
 * must supply the current operational collector and venue listener explicitly.
 * Returns { element, elements, providerId, selectProvider, render, refresh,
 * diagnosticsView, destroy }.
 */
export function createSettingsView({ shell, i18n, config, engine, diagnostics, document: doc = shell?.root?.ownerDocument,
  persistence = false, app = null, metrics = null, hub = null, getDeviceVoices = null, onUiLanguageChange = null } = {}) {
  const root = shell?.elements?.panels?.settingsBody;
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof shell.onLanguageChange !== 'function'
    || typeof config?.keyStore?.subscribe !== 'function' || typeof config.registry?.get !== 'function'
    || !Array.isArray(config.providers) || !config.providers.length
    || typeof engine?.state?.subscribe !== 'function' || typeof diagnostics?.run !== 'function') {
    throw new Error('INVALID_REQUEST');
  }
  const { keyStore } = config;
  const store = engine.state;
  const bind = createBinder(i18n);
  const removers = [];
  let snapshot = store.snapshot();
  let providerId = attempt(() => keyStore.getSelection())?.providerId ?? config.defaults?.providerId ?? config.providers[0].id;
  if (!config.providers.some((item) => item.id === providerId)) providerId = config.providers[0].id;
  let confirmingDelete = false, confirmingClear = false;

  function notify(key) {
    attempt(() => store.setNotice(resolveKey(i18n, key)));
  }
  // Engine and store calls run inside the gesture; failures become notices.
  function call(action, toKey = errorKey) {
    try { return action(); } catch (error) { notify(toKey(error)); return undefined; }
  }
  const descriptor = () => attempt(() => config.registry.get(providerId).descriptor) ?? null;
  const selection = () => attempt(() => keyStore.getSelection()) ?? null;
  const metadata = (source) => attempt(() => keyStore.getMetadata(providerId, source)) ?? null;
  const labelKey = (desc) => resolveKey(i18n, desc?.label, 'common.unknown');
  function section(className, titleKey) {
    const node = element(doc, 'section', { className: `settings-section ${className}` });
    const title = element(doc, 'h3', { className: 'settings-section-title' });
    bind.text(title, titleKey);
    node.append(title);
    return node;
  }
  function field(parent, id, labelKey, control) {
    const row = element(doc, 'div', { className: 'settings-field' });
    const label = element(doc, 'label', { className: 'settings-label', attributes: { for: id } });
    bind.text(label, labelKey);
    control.setAttribute('id', id);
    row.append(label, control);
    parent.append(row);
    return row;
  }
  function note(parent, key, className = 'settings-note') {
    const node = element(doc, 'p', { className });
    bind.text(node, key);
    parent.append(node);
    return node;
  }
  function button(parent, key, className, onClick) {
    const node = element(doc, 'button', { className: `btn ${className}`, attributes: { type: 'button' } });
    bind.text(node, key);
    node.addEventListener('click', onClick);
    parent.append(node);
    return node;
  }

  const container = element(doc, 'div', { className: 'settings' });
  root.append(container);

  // Display language and interpretation pair are separate settings (§12).
  const languageSection = section('settings-language', 'language.ui');
  const uiSelect = element(doc, 'select', { className: 'settings-select' });
  for (const value of SUPPORTED_LANGUAGES) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `language.${value}`);
    uiSelect.append(option);
  }
  uiSelect.addEventListener('change', () => {
    const language = shell.setLanguage(uiSelect.value);
    attempt(() => onUiLanguageChange?.(language));
  });
  field(languageSection, 'settings-ui-language', 'language.ui', uiSelect);
  const sourceSelect = element(doc, 'select', { className: 'settings-select' });
  for (const value of SOURCE_OPTIONS) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, value === 'auto' ? 'language.auto' : `language.${value}`);
    sourceSelect.append(option);
  }
  const targetSelect = element(doc, 'select', { className: 'settings-select' });
  for (const value of SUPPORTED_LANGUAGES) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `language.${value}`);
    targetSelect.append(option);
  }
  // Same language on both sides moves the other side (as in the sequential screen).
  function applyPair(sourceLanguage, targetLanguage, changed) {
    const current = snapshot.interpretation;
    if (sourceLanguage === targetLanguage) {
      if (changed === 'target') sourceLanguage = current.targetLanguage;
      else targetLanguage = current.sourceLanguage !== 'auto' ? current.sourceLanguage
        : [i18n.language, ...SUPPORTED_LANGUAGES].find((value) => value !== sourceLanguage);
    }
    call(() => engine.setInterpretation({ sourceLanguage, targetLanguage }));
    render(store.snapshot());
  }
  sourceSelect.addEventListener('change', () => applyPair(sourceSelect.value, snapshot.interpretation.targetLanguage, 'source'));
  targetSelect.addEventListener('change', () => applyPair(snapshot.interpretation.sourceLanguage, targetSelect.value, 'target'));
  field(languageSection, 'settings-source-language', 'language.source', sourceSelect);
  field(languageSection, 'settings-target-language', 'language.target', targetSelect);

  // Provider: a title alone for one provider, a picker for two or more (§7.4).
  const providerSection = section('settings-provider', 'settings.provider');
  const providerTitle = element(doc, 'p', { className: 'settings-provider-name' });
  const providerSelect = element(doc, 'select', { className: 'settings-select' });
  for (const desc of config.providers) {
    const option = element(doc, 'option', { attributes: { value: desc.id } });
    bind.text(option, labelKey(desc));
    providerSelect.append(option);
  }
  const providerField = field(providerSection, 'settings-provider-select', 'settings.provider', providerSelect);
  providerField.hidden = config.providers.length < 2;
  providerTitle.hidden = !providerField.hidden;
  providerSelect.addEventListener('change', () => selectProvider(providerSelect.value));
  providerSection.append(providerTitle);
  const terms = element(doc, 'p', { className: 'settings-terms' });
  providerSection.append(terms);

  // Personal key: input, remember (only with storage), save, delete, check.
  const keySection = section('settings-key', 'settings.personalKey');
  const keyStatus = element(doc, 'p', { className: 'settings-key-status', attributes: { role: 'status', 'aria-live': 'polite' } });
  keySection.append(keyStatus);
  const hubOnly = note(keySection, 'settings.hubKey', 'settings-hub-only');
  const keyForm = element(doc, 'form', { className: 'settings-key-form', attributes: { novalidate: '' } });
  const keyInput = element(doc, 'input', { className: 'settings-key-input', attributes: { type: 'password', autocomplete: 'off',
    autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', inputmode: 'text', maxlength: '512' } });
  bind.attribute(keyInput, 'placeholder', 'settings.keyPlaceholder');
  field(keyForm, 'settings-key-input', 'settings.key', keyInput);
  const rememberRow = element(doc, 'div', { className: 'settings-field settings-remember' });
  const rememberInput = element(doc, 'input', { className: 'settings-checkbox', attributes: { type: 'checkbox', id: 'settings-remember' } });
  const rememberLabel = element(doc, 'label', { className: 'settings-label', attributes: { for: 'settings-remember' } });
  bind.text(rememberLabel, 'settings.rememberKey');
  rememberRow.append(rememberInput, rememberLabel);
  rememberRow.hidden = !persistence;
  keyForm.append(rememberRow);
  const keyActions = element(doc, 'div', { className: 'settings-actions' });
  const saveButton = element(doc, 'button', { className: 'btn btn-primary settings-key-save', attributes: { type: 'submit' } });
  bind.text(saveButton, 'common.save');
  keyActions.append(saveButton);
  keyForm.append(keyActions);
  keyForm.addEventListener('submit', (event) => { event.preventDefault?.(); saveKey(); });
  keySection.append(keyForm);
  function saveKey() {
    const value = typeof keyInput.value === 'string' ? keyInput.value.trim() : '';
    // The field is emptied before the store call so the value lives in one place.
    keyInput.value = '';
    if (!value) { attempt(() => keyInput.focus()); return; }
    const remember = persistence && rememberInput.checked === true;
    // No check runs here: the user starts diagnostics explicitly (§6.2).
    call(() => keyStore.setPersonal(providerId, value, { remember }), keyStoreErrorKey);
  }
  const keyManage = element(doc, 'div', { className: 'settings-actions settings-key-manage' });
  const checkButton = button(keyManage, 'common.check', 'btn-secondary settings-key-check', () => {
    call(() => diagnostics.run('text', { providerId, keySource: 'personal', ...checkOptions() }));
  });
  const deleteButton = button(keyManage, 'settings.deleteKey', 'btn-secondary settings-key-delete', () => showDeleteConfirm(!confirmingDelete));
  const deleteConfirm = element(doc, 'div', { className: 'settings-confirm', attributes: { role: 'group' } });
  deleteConfirm.hidden = true;
  const deleteText = element(doc, 'span', { className: 'settings-confirm-text' });
  bind.text(deleteText, 'settings.deleteKeyConfirm');
  deleteConfirm.append(deleteText);
  const deleteYes = button(deleteConfirm, 'common.delete', 'btn-danger settings-key-delete-confirm', () => {
    showDeleteConfirm(false);
    if (call(() => { keyStore.deleteKey(providerId, 'personal'); return true; }, keyStoreErrorKey)) notify('settings.keyDeleted');
  });
  button(deleteConfirm, 'common.cancel', 'btn-secondary', () => showDeleteConfirm(false));
  keyManage.append(deleteConfirm);
  keySection.append(keyManage);
  function showDeleteConfirm(show) {
    confirmingDelete = show;
    deleteConfirm.hidden = !show;
    deleteButton.setAttribute('aria-expanded', String(show));
    attempt(() => (show ? deleteYes : deleteButton).focus());
  }
  for (const key of ['settings.keyMemory', 'settings.keyStorageWarning', 'settings.keyCreate', 'settings.keyRestriction', 'settings.keyRevoke']) {
    note(keySection, key);
  }

  // Shared key: event and temporary status when present, otherwise QR/paste import.
  const sharedSection = section('settings-shared', 'settings.sharedKey');
  const sharedStatus = element(doc, 'p', { className: 'settings-shared-status', attributes: { role: 'status', 'aria-live': 'polite' } });
  const sharedEvent = element(doc, 'p', { className: 'settings-shared-event' });
  const sharedUntil = element(doc, 'p', { className: 'settings-shared-until' });
  const sharedEnd = element(doc, 'button', { className: 'btn btn-danger settings-shared-end', attributes: { type: 'button' } });
  bind.text(sharedEnd, 'mode.endShared');
  sharedEnd.addEventListener('click', () => call(() => keyStore.endShared(providerId), keyStoreErrorKey));
  const sharedForm = element(doc, 'form', { className: 'settings-shared-form', attributes: { novalidate: '' } });
  const sharedInput = element(doc, 'input', { className: 'settings-shared-input', attributes: { type: 'password', autocomplete: 'off',
    autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', inputmode: 'text', maxlength: '8192' } });
  bind.attribute(sharedInput, 'placeholder', 'settings.sharedImport');
  field(sharedForm, 'settings-shared-input', 'settings.sharedImport', sharedInput);
  const sharedImport = element(doc, 'button', { className: 'btn btn-secondary settings-shared-import', attributes: { type: 'submit' } });
  bind.text(sharedImport, 'settings.sharedImport');
  sharedForm.append(sharedImport);
  sharedForm.addEventListener('submit', (event) => {
    event.preventDefault?.();
    const fragment = sharedFragmentFrom(sharedInput.value);
    sharedInput.value = '';
    if (!fragment) { attempt(() => sharedInput.focus()); return; }
    call(() => keyStore.receiveSharedFragment(fragment), keyStoreErrorKey);
  });
  sharedSection.append(sharedStatus, sharedEvent, sharedUntil, sharedEnd, sharedForm);
  note(sharedSection, 'settings.sharedTemporary');

  // Usage mode: explicit personal/shared choice, never automatic (§6.3, §9.4).
  const modeSection = section('settings-mode', 'settings.keySource');
  const modeGroup = element(doc, 'div', { className: 'settings-modes', attributes: { role: 'radiogroup' } });
  bind.attribute(modeGroup, 'aria-label', 'settings.keySource');
  const modeInputs = {};
  for (const source of KEY_SOURCES) {
    const row = element(doc, 'div', { className: 'settings-field settings-mode-option' });
    const input = element(doc, 'input', { className: 'settings-radio', attributes: { type: 'radio', name: 'settings-mode',
      id: `settings-mode-${source}`, value: source } });
    const label = element(doc, 'label', { className: 'settings-label', attributes: { for: `settings-mode-${source}` } });
    bind.text(label, `mode.${source}`);
    input.addEventListener('change', () => {
      if (input.checked === false) return;
      call(() => keyStore.select(providerId, source), keyStoreErrorKey);
      render();
    });
    row.append(input, label);
    modeGroup.append(row);
    modeInputs[source] = { row, input };
  }
  modeSection.append(modeGroup);
  note(modeSection, 'settings.modeExplicit');

  // Voice output, provider voice (preview on demand only) and device voice.
  const voiceSection = section('settings-voice', 'voice.output');
  const outputSelect = element(doc, 'select', { className: 'settings-select' });
  for (const value of VOICE_OUTPUTS) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `voice.${value}`);
    outputSelect.append(option);
  }
  outputSelect.addEventListener('change', () => { call(() => engine.setVoice({ output: outputSelect.value })); render(store.snapshot()); });
  field(voiceSection, 'settings-voice-output', 'voice.output', outputSelect);
  const voiceSelect = element(doc, 'select', { className: 'settings-select' });
  voiceSelect.addEventListener('change', () => { call(() => engine.setVoice({ voice: voiceSelect.value || null })); render(store.snapshot()); });
  const voiceField = field(voiceSection, 'settings-voice-name', 'voice.select', voiceSelect);
  const previewButton = button(voiceField, 'voice.preview', 'btn-secondary settings-voice-preview', () => {
    call(() => diagnostics.run('voice', { ...checkOptions() }));
  });
  const deviceSelect = element(doc, 'select', { className: 'settings-select' });
  deviceSelect.addEventListener('change', () => { call(() => engine.setVoice({ deviceVoiceURI: deviceSelect.value || null })); render(store.snapshot()); });
  const deviceField = field(voiceSection, 'settings-device-voice', 'voice.device', deviceSelect);
  deviceField.hidden = typeof getDeviceVoices !== 'function';
  note(voiceSection, 'voice.devicePrivacy');

  // Diagnostics: per-capability checks against the selected provider and key source.
  const diagnosticsSection = section('settings-diagnostics', 'diagnostics.title');
  function checkOptions() {
    const { interpretation, voice } = snapshot;
    return { sourceLanguage: interpretation.sourceLanguage, targetLanguage: interpretation.targetLanguage,
      ...(voice.voice ? { voice: voice.voice } : {}) };
  }
  const diagnosticsView = createDiagnosticsView({ root: diagnosticsSection, i18n, diagnostics, document: doc, notify, metrics, hub,
    // The table describes the displayed provider; results need its selected key source.
    getRoute: () => { const current = selection(); return { providerId, keySource: current?.providerId === providerId ? current.keySource : null }; },
    getOptions: checkOptions });

  // Records stay OFF in P1 (§14.1): memory note and clearing with confirmation.
  const recordsSection = section('settings-records', 'settings.records');
  note(recordsSection, 'records.off');
  note(recordsSection, 'records.memory');
  const clearButton = button(recordsSection, 'records.clear', 'btn-secondary settings-records-clear', () => showClearConfirm(!confirmingClear));
  const clearConfirm = element(doc, 'div', { className: 'settings-confirm', attributes: { role: 'group' } });
  clearConfirm.hidden = true;
  const clearText = element(doc, 'span', { className: 'settings-confirm-text' });
  bind.text(clearText, 'records.clearConfirm');
  clearConfirm.append(clearText);
  const clearYes = button(clearConfirm, 'common.delete', 'btn-danger settings-records-clear-confirm', () => {
    showClearConfirm(false);
    call(() => store.clearTurns('records.cleared'));
  });
  button(clearConfirm, 'common.cancel', 'btn-secondary', () => showClearConfirm(false));
  recordsSection.append(clearConfirm);
  function showClearConfirm(show) {
    confirmingClear = show;
    clearConfirm.hidden = !show;
    clearButton.setAttribute('aria-expanded', String(show));
    attempt(() => (show ? clearYes : clearButton).focus());
  }

  // App: run form and version; install and update controls are added by P1-19.
  const appSection = section('settings-app', 'settings.app');
  const appMode = element(doc, 'p', { className: 'settings-app-mode' });
  bind.text(appMode, app?.standalone === true ? 'pwa.standalone' : 'pwa.web');
  const appVersion = element(doc, 'p', { className: 'settings-app-version' });
  const version = typeof app?.version === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(app.version) ? app.version : null;
  appVersion.hidden = version === null;
  if (version !== null) bind.text(appVersion, 'pwa.version', { version });
  const appActions = element(doc, 'div', { className: 'settings-actions settings-app-actions' });
  appSection.append(appMode, appVersion, appActions);
  note(appSection, 'pwa.installPrompt');
  note(appSection, 'pwa.nameLanguage');

  // Guidance: provider terms, data handling, eligibility and quota facts (§11.4).
  const noticeSection = section('settings-notices', 'settings.notices');
  for (const key of ['notice.data', 'notice.eligibility', 'notice.accuracy', 'quota.unknown', 'quota.noPaidSwitch']) note(noticeSection, key);
  const quotaScope = note(noticeSection, 'quota.project', 'settings-note settings-quota-scope');

  container.append(languageSection, providerSection, keySection, sharedSection, modeSection, voiceSection,
    diagnosticsSection, recordsSection, appSection, noticeSection);

  function selectProvider(id) {
    if (!config.providers.some((item) => item.id === id) || id === providerId) return providerId;
    providerId = id;
    showDeleteConfirm(false);
    render();
    return providerId;
  }

  function renderProvider(desc) {
    providerSelect.value = providerId;
    providerTitle.textContent = i18n.t(labelKey(desc));
    terms.textContent = i18n.t(resolveKey(i18n, desc?.terms?.notice, 'notice.data'));
    quotaScope.hidden = desc?.quotaPolicy?.scope !== 'project';
  }

  function renderKey(desc, current) {
    const direct = acceptsDirectKey(desc, 'personal');
    hubOnly.hidden = direct;
    keyStatus.hidden = !direct;
    keyForm.hidden = !direct;
    keyManage.hidden = !direct;
    const personal = direct ? metadata('personal') : null;
    keyStatus.textContent = i18n.t(!direct ? 'settings.hubKey' : !personal ? 'settings.noKey'
      : personal.remembered ? 'settings.keyStored' : 'settings.keyMemory');
    keyStatus.setAttribute('data-key', !direct ? 'hub' : !personal ? 'none' : personal.remembered ? 'remembered' : 'memory');
    deleteButton.disabled = personal === null;
    if (deleteButton.disabled && confirmingDelete) showDeleteConfirm(false);
    // The router only honours the selected source, so the check needs it selected.
    checkButton.disabled = personal === null || current?.providerId !== providerId || current.keySource !== 'personal';
  }

  function renderShared(desc) {
    const direct = acceptsDirectKey(desc, 'shared');
    sharedSection.hidden = !direct;
    const shared = direct ? metadata('shared') : null;
    sharedStatus.textContent = i18n.t(shared ? 'mode.shared' : 'settings.noKey');
    sharedEvent.hidden = shared === null;
    // Event names are untrusted QR text: rendered as text through the template.
    sharedEvent.textContent = shared ? i18n.t('settings.event', { event: shared.eventName }) : '';
    const until = shared && Number.isFinite(shared.usageEndsAt) ? attempt(() => i18n.formatDate(new Date(shared.usageEndsAt), { dateStyle: 'medium', timeStyle: 'short' })) : null;
    sharedUntil.hidden = !until;
    sharedUntil.textContent = until ? `${i18n.t('settings.sharedUntil')}: ${until}` : '';
    sharedEnd.hidden = shared === null;
    sharedForm.hidden = shared !== null;
  }

  function renderMode(desc, current) {
    for (const source of KEY_SOURCES) {
      const { row, input } = modeInputs[source];
      const allowed = acceptsDirectKey(desc, source);
      row.hidden = !allowed;
      const held = allowed && metadata(source) !== null;
      input.disabled = !held;
      input.checked = current?.providerId === providerId && current.keySource === source;
    }
  }

  function renderVoice(desc) {
    const settings = snapshot.voice;
    outputSelect.value = settings.output;
    const cap = desc?.capabilities?.voice;
    // Only voices the registered, directly callable voice capability declares (§7.4).
    const voices = cap?.implementation === 'ready' && desc.browserDirect && cap.transports.includes('direct') ? cap.voices : [];
    const wanted = ['', ...voices];
    if (Array.from(voiceSelect.childNodes).map((option) => option.getAttribute('value')).join('\n') !== wanted.join('\n')) {
      for (const option of Array.from(voiceSelect.childNodes)) option.remove();
      for (const value of wanted) {
        const option = element(doc, 'option', { attributes: { value } });
        // Voice identifiers are registered provider data, not dictionary text.
        if (value) option.textContent = value; else option.setAttribute('data-default', 'true');
        voiceSelect.append(option);
      }
    }
    const defaultOption = voiceSelect.childNodes[0];
    if (defaultOption) defaultOption.textContent = i18n.t('voice.provider');
    voiceSelect.value = voices.includes(settings.voice) ? settings.voice : '';
    voiceField.hidden = voices.length === 0;
    previewButton.disabled = settings.output !== 'provider' || voices.length === 0 || diagnostics.snapshot().running !== null;
    if (typeof getDeviceVoices === 'function') {
      const list = attempt(() => {
        const raw = getDeviceVoices();
        return (Array.isArray(raw) ? raw : []).filter((voice) => typeof voice?.voiceURI === 'string')
        .map((voice) => ({ voiceURI: voice.voiceURI, name: typeof voice.name === 'string' ? voice.name : voice.voiceURI,
          lang: typeof voice.lang === 'string' ? voice.lang : '' }));
      }) ?? [];
      const ids = ['', ...list.map((voice) => voice.voiceURI)];
      if (deviceSelect.childNodes.length !== ids.length || Array.from(deviceSelect.childNodes).map((option) => option.getAttribute('value')).join('\n') !== ids.join('\n')) {
        for (const option of Array.from(deviceSelect.childNodes)) option.remove();
        const auto = element(doc, 'option', { attributes: { value: '' } });
        deviceSelect.append(auto);
        for (const voice of list) {
          const option = element(doc, 'option', { attributes: { value: voice.voiceURI, lang: voice.lang } });
          option.textContent = voice.lang ? `${voice.name} (${voice.lang})` : voice.name;
          deviceSelect.append(option);
        }
      }
      deviceSelect.childNodes[0].textContent = i18n.t('language.auto');
      deviceSelect.value = ids.includes(settings.deviceVoiceURI) ? settings.deviceVoiceURI : '';
    }
  }

  function render(next = snapshot) {
    snapshot = next;
    uiSelect.value = i18n.language;
    sourceSelect.value = snapshot.interpretation.sourceLanguage;
    targetSelect.value = snapshot.interpretation.targetLanguage;
    const desc = descriptor();
    const current = selection();
    renderProvider(desc);
    renderKey(desc, current);
    renderShared(desc);
    renderMode(desc, current);
    renderVoice(desc);
    clearButton.disabled = snapshot.activeTurnId !== null || snapshot.turns.length === 0;
    if (clearButton.disabled && confirmingClear) showClearConfirm(false);
    diagnosticsView.render();
  }

  function refresh() {
    bind.refresh();
    diagnosticsView.refresh();
    render(snapshot);
  }

  removers.push(store.subscribe(render));
  removers.push(attempt(() => keyStore.subscribe(() => render())) ?? (() => {}));
  removers.push(diagnostics.subscribe(() => render()));
  removers.push(shell.onLanguageChange(refresh));
  render(snapshot);

  return Object.freeze({
    element: container,
    elements: Object.freeze({ uiSelect, sourceSelect, targetSelect, providerSelect, providerTitle, keyInput, rememberInput, saveButton,
      checkButton, deleteButton, deleteConfirm, keyStatus, sharedInput, sharedImport, sharedEnd, sharedEvent, modeInputs: Object.freeze(
        Object.fromEntries(KEY_SOURCES.map((source) => [source, modeInputs[source].input]))),
      outputSelect, voiceSelect, previewButton, deviceSelect, clearButton, clearConfirm, appActions, sections: Object.freeze({
        language: languageSection, provider: providerSection, key: keySection, shared: sharedSection, mode: modeSection,
        voice: voiceSection, diagnostics: diagnosticsSection, records: recordsSection, app: appSection, notices: noticeSection }) }),
    get providerId() { return providerId; },
    selectProvider,
    diagnosticsView,
    render,
    refresh,
    destroy() {
      for (const remove of removers) attempt(remove);
      diagnosticsView.destroy();
      bind.clear();
      container.remove();
    },
  });
}
