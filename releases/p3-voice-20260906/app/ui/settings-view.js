// New implementation of design-v0.6 §§6.2, 6.3, 7.4, 11 and 12 and design-p3
// §1.6/§1.12 (P3-19): the settings screen mounted into the shell's settings
// dialog, in the ten-section order of §1.12 — display·language, interpretation,
// provider·API key, venue shared key, plan·usage, microphone·audio devices,
// connection diagnostics, records, app·site policy, terms. Each section has a
// title and a one-or-two-sentence hint. One registered provider shows its title
// only; the provider picker appears once two or more are registered. Keys are
// addressed as (providerId, keySource): personal keys can be entered, checked,
// deleted and optionally remembered; shared keys are shown as temporary event
// credentials; hub-only providers get no key input. Saving a key never starts
// a check, and mode changes are explicit. Key values never reach the DOM,
// notices or logs; the input is cleared on save.
// P3-02d: an audio section (noise suppression, voice-band filter, gate
// sensitivity, last applied microphone settings) and one shared voice choice:
// the provider voice picked here also drives the simultaneous voice, and the
// simultaneous screen's female/male choice is mirrored into this picker.
// P3-19: with a policy runtime, the interpretation pair and voice output show
// their value source and lock reason (§1.6), options outside the allowed range
// are hidden, a forced value is written to the engine, and the app section
// carries the policy view (app version, revision, block reason, lock list).
// Personal choices made here are recorded in the preference store when one is
// given, so the resolver can tell them from administrator defaults. The P1-16
// element names, the PWA insertion point (appActions) and the diagnostics
// view are kept; the sections map keeps the P1 names as aliases.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { LIVE_MODELS, DEFAULT_LIVE_MODEL, liveVoicePreference } from '../providers/gemini/live-config.js';
import { voiceGender, voiceTone } from '../providers/gemini/voice.js';
import { AUDIO_SENSITIVITIES, APPLIED_SETTING_NAMES, audioPreferences } from '../audio/capture.js';
import { VOICE_OUTPUTS } from '../state.js';
import { redact } from '../security/redact.js';
import { createBinder, SOURCE_OPTIONS } from './seq-view.js';
import { errorKey, resolveKey } from './errors.js';
import { createDiagnosticsView } from './diagnostics-view.js';
import { SETTING_NAMES, createLockNote, createPolicyView } from './policy-view.js';

export const KEY_SOURCES = Object.freeze(['personal', 'shared']);
// Section order of design-p3 §1.12 (the settings.section.* / sectionHint.* keys).
export const SETTINGS_SECTIONS = Object.freeze(['display', 'interpretation', 'provider', 'sharedKey', 'billing', 'audio',
  'diagnostics', 'records', 'app', 'terms']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const kebab = (value) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

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
 *   persistence?, app?, getDeviceVoices?, onUiLanguageChange?, policy?, preferences? })
 * mounts into shell.elements.panels.settingsBody and re-renders through
 * shell.onLanguageChange. engine is the sequential engine (state,
 * setInterpretation, setVoice); diagnostics is createDiagnostics()'s result.
 * persistence says whether a storage was given to the key store (the
 * "remember" option is offered only then). app is { version?, standalone? }
 * for the app section (version is the release ID; the numeric app version is
 * shown by the policy view). getDeviceVoices() lists SpeechSynthesis voices.
 * Optional metrics and hub expose snapshot()/subscribe(); the composition root
 * must supply the current operational collector and venue listener explicitly.
 * policy (optional) is createPolicyRuntime()'s result; preferences (optional)
 * is createPreferences()'s result and receives the choices made here.
 * Returns { element, elements, providerId, selectProvider, render, refresh,
 * diagnosticsView, policyView, destroy }.
 */
export function createSettingsView({ shell, i18n, config, engine, diagnostics, document: doc = shell?.root?.ownerDocument,
  persistence = false, app = null, simEngine = null, metrics = null, hub = null, getDeviceVoices = null, onUiLanguageChange = null,
  audio = audioPreferences, voicePreference = liveVoicePreference, policy = null, preferences = null } = {}) {
  const root = shell?.elements?.panels?.settingsBody;
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof shell.onLanguageChange !== 'function'
    || typeof config?.keyStore?.subscribe !== 'function' || typeof config.registry?.get !== 'function'
    || !Array.isArray(config.providers) || !config.providers.length
    || typeof engine?.state?.subscribe !== 'function' || typeof diagnostics?.run !== 'function'
    || (policy !== null && (typeof policy?.snapshot !== 'function' || typeof policy.subscribe !== 'function'))
    || (preferences !== null && typeof preferences?.set !== 'function')) {
    throw new Error('INVALID_REQUEST');
  }
  const { keyStore } = config;
  const store = engine.state;
  const bind = createBinder(i18n);
  const removers = [];
  let snapshot = store.snapshot();
  let policyState = policy ? attempt(() => policy.snapshot()) ?? null : null;
  let providerId = attempt(() => keyStore.getSelection())?.providerId ?? config.defaults?.providerId ?? config.providers[0].id;
  if (!config.providers.some((item) => item.id === providerId)) providerId = config.providers[0].id;
  let confirmingDelete = false, confirmingClear = false, keyFeedbackKey = null;
  // P3-22 personal key entry state (owner, 2026-09-06):
  // - `keyRevealed`: the value is on screen because someone pressed 표시.
  // - `keyEditing`: someone is typing a new key, so the mask is gone.
  // Neither survives leaving the screen: closeKeyEntry() puts both back.
  let keyRevealed = false, keyEditing = false;

  function notify(key) {
    attempt(() => store.setNotice(resolveKey(i18n, key)));
  }
  // Engine and store calls run inside the gesture; failures become notices.
  function call(action, toKey = errorKey) {
    try { return action(); } catch (error) { notify(toKey(error)); return undefined; }
  }
  // The choice made here is the personal choice the resolver reads (§1.5).
  function remember(name, value) {
    if (preferences) attempt(() => preferences.set(name, value));
  }
  const policyEntry = (name) => policyState?.settings?.[name] ?? null;
  const allowedFor = (name) => { const entry = policyEntry(name); return Array.isArray(entry?.allowed) ? entry.allowed : null; };
  const descriptor = () => attempt(() => config.registry.get(providerId).descriptor) ?? null;
  const selection = () => attempt(() => keyStore.getSelection()) ?? null;
  const metadata = (source) => attempt(() => keyStore.getMetadata(providerId, source)) ?? null;
  const labelKey = (desc) => resolveKey(i18n, desc?.label, 'common.unknown');
  // A §1.12 section: title, hint and an accessible name for the region.
  function section(name) {
    const id = `settings-section-${kebab(name)}`;
    const node = element(doc, 'section', { className: `settings-section settings-${kebab(name)}`,
      attributes: { 'data-section': name, 'aria-labelledby': id } });
    const title = element(doc, 'h3', { className: 'settings-section-title', attributes: { id } });
    bind.text(title, `settings.section.${name}`);
    const hint = element(doc, 'p', { className: 'settings-section-hint' });
    bind.text(hint, `settings.sectionHint.${name}`);
    node.append(title, hint);
    return node;
  }
  function block(className) {
    return element(doc, 'div', { className: `settings-block ${className}` });
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
  // Policy source/lock note under a control (§1.6); absent without a runtime.
  function lockNote(row, control, id) {
    if (!policy) return null;
    const lock = createLockNote({ document: doc, i18n, control, id });
    row.append(lock.element);
    return lock;
  }

  const container = element(doc, 'div', { className: 'settings' });
  root.append(container);

  // 1. Display and language: the UI language (never policy locked, §1.4);
  // mode, tone, text and caption size controls mount into displayControls (P3-20).
  const displaySection = section('display');
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
  field(displaySection, 'settings-ui-language', 'language.ui', uiSelect);
  const uiLanguageNote = note(displaySection, 'policy.lock.uiLanguage');
  uiLanguageNote.hidden = !policy;
  const displayControls = block('settings-display-controls');
  displaySection.append(displayControls);

  // 2. Interpretation: the pair (separate from the display language, §12),
  // then voice output, provider voice (preview on demand only), device voice and Live model.
  const interpretationSection = section('interpretation');
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
  // Same language on both sides moves the other side (as in the sequential
  // screen), choosing a replacement the policy allows.
  const permitted = (name, candidates) => {
    const allowed = allowedFor(name);
    return candidates.find((value) => typeof value === 'string' && (allowed === null || allowed.includes(value))) ?? null;
  };
  function applyPair(sourceLanguage, targetLanguage, changed) {
    const current = snapshot.interpretation;
    if (sourceLanguage === targetLanguage) {
      if (changed === 'target') {
        sourceLanguage = permitted(SETTING_NAMES.sourceLanguage,
          [current.targetLanguage, 'auto', ...SUPPORTED_LANGUAGES].filter((value) => value !== targetLanguage)) ?? current.sourceLanguage;
      } else {
        targetLanguage = permitted(SETTING_NAMES.targetLanguage,
          [current.sourceLanguage !== 'auto' ? current.sourceLanguage : null, i18n.language, ...SUPPORTED_LANGUAGES]
            .filter((value) => value !== sourceLanguage)) ?? current.targetLanguage;
      }
    }
    if (call(() => { engine.setInterpretation({ sourceLanguage, targetLanguage }); return true; })) {
      remember(SETTING_NAMES.sourceLanguage, sourceLanguage);
      remember(SETTING_NAMES.targetLanguage, targetLanguage);
    }
    render(store.snapshot());
  }
  sourceSelect.addEventListener('change', () => applyPair(sourceSelect.value, snapshot.interpretation.targetLanguage, 'source'));
  targetSelect.addEventListener('change', () => applyPair(snapshot.interpretation.sourceLanguage, targetSelect.value, 'target'));
  const sourceField = field(interpretationSection, 'settings-source-language', 'language.source', sourceSelect);
  const sourceLock = lockNote(sourceField, sourceSelect, 'settings-source-language-lock');
  const targetField = field(interpretationSection, 'settings-target-language', 'language.target', targetSelect);
  const targetLock = lockNote(targetField, targetSelect, 'settings-target-language-lock');

  const voiceBlock = block('settings-voice');
  interpretationSection.append(voiceBlock);
  const outputSelect = element(doc, 'select', { className: 'settings-select' });
  for (const value of VOICE_OUTPUTS) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `voice.${value}`);
    outputSelect.append(option);
  }
  outputSelect.addEventListener('change', () => {
    if (call(() => { engine.setVoice({ output: outputSelect.value }); return true; })) remember(SETTING_NAMES.voiceOutput, outputSelect.value);
    render(store.snapshot());
  });
  const outputField = field(voiceBlock, 'settings-voice-output', 'voice.output', outputSelect);
  const outputLock = lockNote(outputField, outputSelect, 'settings-voice-output-lock');
  const voiceSelect = element(doc, 'select', { className: 'settings-select' });
  voiceSelect.addEventListener('change', () => {
    const chosen = voiceSelect.value || null;
    call(() => engine.setVoice({ voice: chosen }));
    // The same choice drives the simultaneous voice; a live session keeps its voice until restarted.
    call(() => voicePreference.set({ voice: chosen }));
    if (simEngine?.snapshot?.().busy) notify('sim.voiceRestart');
    render(store.snapshot());
  });
  const voiceField = field(voiceBlock, 'settings-voice-name', 'voice.select', voiceSelect);
  // Owner, 2026-09-06: the picker says whether a voice reads male or female and
  // what it sounds like, so it is not 30 bare names. The note states where each
  // half comes from, because Google publishes the tone but not the gender.
  const voiceGenderNote = note(voiceBlock, 'voice.genderNote', 'settings-note settings-voice-note');
  const previewButton = button(voiceField, 'voice.preview', 'btn-secondary settings-voice-preview', () => {
    call(() => diagnostics.run('voice', { ...checkOptions() }));
  });
  // Why the preview cannot run, or that it plays a voice the interpretation
  // will not use. Empty and hidden when the button simply works.
  // Built without bind.text: its text is chosen per render (and carries the
  // current output name), so a language refresh must not overwrite it.
  const previewNote = element(doc, 'p', { className: 'settings-note settings-voice-preview-note',
    attributes: { role: 'status' } });
  previewNote.hidden = true;
  voiceBlock.append(previewNote);
  const deviceSelect = element(doc, 'select', { className: 'settings-select' });
  deviceSelect.addEventListener('change', () => { call(() => engine.setVoice({ deviceVoiceURI: deviceSelect.value || null })); render(store.snapshot()); });
  const deviceField = field(voiceBlock, 'settings-device-voice', 'voice.device', deviceSelect);
  deviceField.hidden = typeof getDeviceVoices !== 'function';
  note(voiceBlock, 'voice.devicePrivacy');

  const modelSelect = element(doc, 'select', { className: 'settings-select' });
  for (const [index, value] of LIVE_MODELS.entries()) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `sim.model${index}`); modelSelect.append(option);
  }
  modelSelect.value = simEngine?.model ?? DEFAULT_LIVE_MODEL;
  const modelField = field(voiceBlock, 'settings-live-model', 'sim.model', modelSelect);
  modelField.hidden = !simEngine;
  note(modelField, 'sim.modelHelp');
  modelSelect.addEventListener('change', async () => {
    modelSelect.disabled = true;
    try { await simEngine?.setModel(modelSelect.value); }
    catch (error) { notify(errorKey(error)); }
    finally { modelSelect.value = simEngine?.model ?? DEFAULT_LIVE_MODEL; modelSelect.disabled = false; }
  });

  // 3. Provider and API key: a title alone for one provider, a picker for two
  // or more (§7.4); then the personal key block (input, remember, save, delete,
  // check, guidance). P3-21 adds the key guide card to this section.
  const providerSection = section('provider');
  const providerTitle = element(doc, 'p', { className: 'settings-provider-name' });
  const providerSelect = element(doc, 'select', { className: 'settings-select' });
  for (const desc of config.providers) {
    const option = element(doc, 'option', { attributes: { value: desc.id } });
    bind.text(option, labelKey(desc));
    providerSelect.append(option);
  }
  // P3-21 mounts the shared key guide card here; the block keeps its place in
  // the section whether or not the app decides to fill it.
  const keyGuideHost = block('settings-key-guide');
  const providerField = field(providerSection, 'settings-provider-select', 'settings.provider', providerSelect);
  providerField.hidden = config.providers.length < 2;
  providerTitle.hidden = !providerField.hidden;
  providerSection.append(keyGuideHost);
  providerSelect.addEventListener('change', () => selectProvider(providerSelect.value));
  providerSection.append(providerTitle);
  const terms = element(doc, 'p', { className: 'settings-terms' });
  providerSection.append(terms);

  const keyBlock = block('settings-key');
  providerSection.append(keyBlock);
  const keyTitle = element(doc, 'h4', { className: 'settings-block-title' });
  bind.text(keyTitle, 'settings.personalKey');
  keyBlock.append(keyTitle);
  const keyStatus = element(doc, 'p', { className: 'badge settings-key-status', attributes: { role: 'status', 'aria-live': 'polite' } });
  keyBlock.append(keyStatus);
  const hubOnly = note(keyBlock, 'settings.hubKey', 'settings-hub-only');
  const keyForm = element(doc, 'form', { className: 'settings-key-form', attributes: { novalidate: '' } });
  const keyInput = element(doc, 'input', { className: 'settings-key-input', attributes: { type: 'password', autocomplete: 'off',
    autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', inputmode: 'text', maxlength: '512' } });
  bind.attribute(keyInput, 'placeholder', 'settings.keyPlaceholder');
  const keyRow = field(keyForm, 'settings-key-input', 'settings.key', keyInput);
  // Show / hide toggle (§1.12 "입력 중인 키에 표시/숨김 토글"). The owner's
  // 2026-09-06 addendum extends it to a stored key: the field shows a mask so
  // it does not look empty on a phone, and this button is the only way to see
  // the value behind it.
  const keyToggle = element(doc, 'button', { className: 'btn btn-secondary settings-key-toggle',
    attributes: { type: 'button', 'aria-pressed': 'false', 'aria-controls': 'settings-key-input' } });
  keyRow.append(keyToggle);
  const keyToggleHint = note(keyForm, 'keyGuide.showHint', 'settings-note settings-key-toggle-hint');
  keyToggle.addEventListener('click', () => setKeyRevealed(!keyRevealed));
  const rememberRow = element(doc, 'div', { className: 'settings-field settings-remember' });
  const rememberInput = element(doc, 'input', { className: 'settings-checkbox', attributes: { type: 'checkbox', id: 'settings-remember' } });
  const rememberLabel = element(doc, 'label', { className: 'settings-label', attributes: { for: 'settings-remember' } });
  bind.text(rememberLabel, 'settings.rememberKey');
  rememberInput.checked = persistence && (metadata('personal')?.remembered ?? true);
  rememberRow.append(rememberInput, rememberLabel);
  const storageWarning = note(rememberRow, 'settings.rememberWarning');
  storageWarning.setAttribute('id', 'settings-remember-warning');
  rememberInput.setAttribute('aria-describedby', 'settings-remember-warning');
  rememberRow.hidden = !persistence;
  keyForm.append(rememberRow);
  const keyActions = element(doc, 'div', { className: 'settings-actions' });
  const saveButton = element(doc, 'button', { className: 'btn btn-primary settings-key-save', attributes: { type: 'submit' } });
  bind.text(saveButton, 'common.save');
  keyActions.append(saveButton);
  keyForm.append(keyActions);
  keyForm.addEventListener('submit', (event) => { event.preventDefault?.(); saveKey(); });
  keyBlock.append(keyForm);
  const keyFeedback = element(doc, 'p', { className: 'badge settings-key-feedback',
    attributes: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
  keyBlock.append(keyFeedback);
  // The mask stands in for a stored key: same length, no information about the
  // value. It is placeholder text in the field, never something the save path
  // can read back as a key (saveKey() ignores the field while it is masked).
  const MASK_CHARACTER = '\u2022';
  const maskFor = (length) => MASK_CHARACTER.repeat(Math.max(0, Math.min(512, Number(length) || 0)));
  const storedKeyLength = () => (keyEditing ? 0 : metadata('personal')?.length ?? 0);
  /** True while the field shows the mask rather than something a person typed. */
  const keyMasked = () => !keyEditing && !keyRevealed && storedKeyLength() > 0;

  function setKeyRevealed(on) {
    const length = metadata('personal')?.length ?? 0;
    // Nothing to reveal, or the person is typing: the toggle only changes the
    // field type so they can check what they are entering.
    if (on && !keyEditing && length === 0) { keyRevealed = false; renderKeyEntry(); return; }
    keyRevealed = on === true;
    renderKeyEntry();
    attempt(() => keyInput.focus());
  }
  /** Leaving the screen (or saving) always hides the value again. */
  function closeKeyEntry() {
    keyRevealed = false;
    keyEditing = false;
    keyInput.value = '';
    renderKeyEntry();
  }
  // However the settings screen is left, a revealed key goes back behind the
  // mask (owner, 2026-09-06). The shell owns the sheet, so it reports the close.
  if (typeof shell?.onSettingsClose === 'function') removers.push(shell.onSettingsClose(() => closeKeyEntry()));
  function renderKeyEntry() {
    const stored = metadata('personal');
    const length = stored?.length ?? 0;
    const canReveal = keyEditing || length > 0;
    keyToggle.hidden = !canReveal;
    keyToggle.setAttribute('aria-pressed', String(keyRevealed));
    keyToggle.textContent = i18n.t(keyRevealed ? 'keyGuide.hide' : 'keyGuide.show');
    keyToggleHint.hidden = !canReveal;
    if (keyEditing) {
      // Typing: the field holds what the person typed; the toggle only decides
      // whether they can read it back.
      keyInput.setAttribute('type', keyRevealed ? 'text' : 'password');
      return;
    }
    if (keyRevealed && length > 0) {
      // The one place a stored key value reaches the DOM, and only because
      // someone asked for it. Hiding, saving, deleting or closing clears it.
      keyInput.setAttribute('type', 'text');
      keyInput.value = attempt(() => keyStore.revealPersonal(providerId)) ?? '';
      return;
    }
    keyInput.setAttribute('type', 'password');
    keyInput.value = maskFor(length);
  }
  // The first keystroke turns the mask into an empty field: what follows is a
  // new key, and the mask must never be submitted as one.
  keyInput.addEventListener('input', () => {
    if (keyEditing) return;
    keyEditing = true;
    keyRevealed = false;
    // Whatever the person typed lands after the mask; only their text survives.
    const typed = typeof keyInput.value === 'string' ? keyInput.value.replaceAll(MASK_CHARACTER, '') : '';
    keyInput.value = typed;
    renderKeyEntry();
  });
  keyInput.addEventListener('beforeinput', () => { if (!keyEditing) keyInput.value = ''; });

  function saveKey() {
    // A masked field carries no key: pressing save without typing must not read
    // the mask, and must not claim anything was saved.
    if (keyMasked()) { keyFeedbackKey = 'error.INVALID_KEY'; render(); attempt(() => keyInput.focus()); return; }
    const value = typeof keyInput.value === 'string' ? keyInput.value.trim() : '';
    // The field is emptied before the store call so the value lives in one place.
    keyInput.value = '';
    keyEditing = false;
    keyRevealed = false;
    if (!value) { keyFeedbackKey = 'error.INVALID_KEY'; render(); attempt(() => keyInput.focus()); return; }
    const remember = persistence && rememberInput.checked === true;
    // No check runs here: the user starts diagnostics explicitly (§6.2).
    try {
      keyStore.setPersonal(providerId, value, { remember });
      // The owner's wording: what happened to the key, right under the field.
      keyFeedbackKey = remember ? 'keyGuide.saved.browser' : 'keyGuide.saved.session';
    } catch (error) {
      // A failed save never shows a success line (§1.12).
      keyFeedbackKey = keyStoreErrorKey(error); notify(keyFeedbackKey);
    }
    render();
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
    // A deleted key must not stay on screen, revealed or masked.
    closeKeyEntry();
    if (call(() => { keyStore.deleteKey(providerId, 'personal'); return true; }, keyStoreErrorKey)) notify('settings.keyDeleted');
  });
  button(deleteConfirm, 'common.cancel', 'btn-secondary', () => showDeleteConfirm(false));
  keyManage.append(deleteConfirm);
  keyBlock.append(keyManage);
  function showDeleteConfirm(show) {
    confirmingDelete = show;
    deleteConfirm.hidden = !show;
    deleteButton.setAttribute('aria-expanded', String(show));
    attempt(() => (show ? deleteYes : deleteButton).focus());
  }
  for (const key of ['settings.keyMemory', 'settings.keyStorageWarning', 'settings.keyCreate', 'settings.keyRestriction', 'settings.keyRevoke']) {
    note(keyBlock, key);
  }

  // 4. Venue shared key: event and temporary status when present, otherwise
  // QR/paste import; then the explicit personal/shared choice (§6.3, §9.4).
  const sharedKeySection = section('sharedKey');
  const sharedBlock = block('settings-shared');
  sharedKeySection.append(sharedBlock);
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
  sharedBlock.append(sharedStatus, sharedEvent, sharedUntil, sharedEnd, sharedForm);
  note(sharedBlock, 'settings.sharedTemporary');

  const modeBlock = block('settings-mode');
  sharedKeySection.append(modeBlock);
  const modeTitle = element(doc, 'h4', { className: 'settings-block-title' });
  bind.text(modeTitle, 'settings.keySource');
  modeBlock.append(modeTitle);
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
  modeBlock.append(modeGroup);
  note(modeBlock, 'settings.modeExplicit');

  // 5. Plan and usage: the hint only; P3-31 mounts the plan/usage controls here.
  const billingSection = section('billing');

  // 6. Microphone and audio devices: speech-only defaults (P3-02d). Changes
  // apply at the next capture start. P3-24/28 add permission and device controls.
  const audioSection = section('audio');
  note(audioSection, 'audio.description');
  function toggle(id, labelKey, helpKey, onChange) {
    const row = element(doc, 'div', { className: 'settings-field settings-audio-toggle' });
    const input = element(doc, 'input', { className: 'settings-checkbox', attributes: { type: 'checkbox', id } });
    const label = element(doc, 'label', { className: 'settings-label', attributes: { for: id } });
    bind.text(label, labelKey);
    input.addEventListener('change', () => { onChange(input.checked === true); renderAudio(); });
    row.append(input, label);
    audioSection.append(row);
    note(audioSection, helpKey);
    return input;
  }
  const noiseInput = toggle('settings-audio-noise', 'audio.noiseSuppression', 'audio.noiseSuppressionHelp',
    (checked) => call(() => audio.set({ noiseSuppression: checked })));
  const filterInput = toggle('settings-audio-filter', 'audio.voiceFilter', 'audio.voiceFilterHelp',
    (checked) => call(() => audio.set({ voiceFilter: checked })));
  const sensitivitySelect = element(doc, 'select', { className: 'settings-select' });
  for (const value of AUDIO_SENSITIVITIES) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `audio.sensitivity.${value}`);
    sensitivitySelect.append(option);
  }
  sensitivitySelect.addEventListener('change', () => { call(() => audio.set({ sensitivity: sensitivitySelect.value })); renderAudio(); });
  field(audioSection, 'settings-audio-sensitivity', 'audio.sensitivity', sensitivitySelect);
  note(audioSection, 'audio.sensitivityHelp');
  // What the browser actually applied at the last capture (track.getSettings()).
  const appliedLine = element(doc, 'p', { className: 'settings-audio-applied', attributes: { role: 'status' } });
  audioSection.append(appliedLine);
  function renderAudio() {
    const current = attempt(() => audio.snapshot()) ?? {};
    noiseInput.checked = current.noiseSuppression !== false;
    filterInput.checked = current.voiceFilter !== false;
    sensitivitySelect.value = AUDIO_SENSITIVITIES.includes(current.sensitivity) ? current.sensitivity : 'normal';
    const applied = current.applied ?? null;
    appliedLine.hidden = applied === null;
    appliedLine.textContent = applied === null ? '' : `${i18n.t('audio.applied')}: ${APPLIED_SETTING_NAMES.map((name) =>
      `${i18n.t(`audio.${name}`)} ${i18n.t(applied[name] === true ? 'audio.on' : applied[name] === false ? 'audio.off' : 'audio.unknown')}`).join(' · ')}`;
  }
  renderAudio();

  // 7. Connection diagnostics: per-capability checks against the selected
  // provider and key source, plus the hub state (unchanged diagnostics view).
  const diagnosticsSection = section('diagnostics');
  function checkOptions() {
    const { interpretation, voice } = snapshot;
    return { sourceLanguage: interpretation.sourceLanguage, targetLanguage: interpretation.targetLanguage,
      ...(voice.voice ? { voice: voice.voice } : {}) };
  }
  const diagnosticsView = createDiagnosticsView({ root: diagnosticsSection, i18n, diagnostics, document: doc, notify, metrics, hub,
    // The table describes the displayed provider; results need its selected key source.
    getRoute: () => { const current = selection(); return { providerId, keySource: current?.providerId === providerId ? current.keySource : null }; },
    getOptions: checkOptions });

  // 8. Records stay OFF (§14.1, design-p3 §4.3): memory note and clearing with confirmation.
  const recordsSection = section('records');
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

  // 9. App and site policy: run form and release ID; install and update
  // controls mount into appActions (P1-19); the policy view follows.
  const appSection = section('app');
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
  const policyView = policy ? createPolicyView({ root: appSection, i18n, policy, document: doc, notify }) : null;

  // 10. Terms and guidance: data handling, eligibility and quota facts (§11.4).
  const termsSection = section('terms');
  for (const key of ['notice.data', 'notice.eligibility', 'notice.accuracy', 'quota.unknown', 'quota.noPaidSwitch']) note(termsSection, key);
  const quotaScope = note(termsSection, 'quota.project', 'settings-note settings-quota-scope');

  const sections = { display: displaySection, interpretation: interpretationSection, provider: providerSection, sharedKey: sharedKeySection,
    billing: billingSection, audio: audioSection, diagnostics: diagnosticsSection, records: recordsSection, app: appSection, terms: termsSection };
  container.append(...SETTINGS_SECTIONS.map((name) => sections[name]));

  function selectProvider(id) {
    if (!config.providers.some((item) => item.id === id) || id === providerId) return providerId;
    providerId = id;
    keyFeedbackKey = null;
    rememberInput.checked = persistence && (metadata('personal')?.remembered ?? true);
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
    renderKeyEntry();
    deleteButton.disabled = personal === null;
    if (deleteButton.disabled && confirmingDelete) showDeleteConfirm(false);
    // The router only honours the selected source, so the check needs it selected.
    checkButton.disabled = personal === null || current?.providerId !== providerId || current.keySource !== 'personal';
  }

  function renderShared(desc) {
    const direct = acceptsDirectKey(desc, 'shared');
    // No shared key for this provider: neither the import nor the choice applies.
    sharedKeySection.hidden = !direct;
    sharedBlock.hidden = !direct;
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

  /** "Kore · 여성 · Firm", or "Sulafat · Warm" when the sources disagree. */
  function voiceOptionLabel(value) {
    const gender = voiceGender(value);
    const tone = voiceTone(value) ?? '';
    if (!tone) return value;
    return gender
      ? i18n.t('voice.option', { name: value, gender: i18n.t(`voice.gender.${gender}`), tone })
      : i18n.t('voice.optionNoGender', { name: value, tone });
  }
  function renderVoice(desc) {
    const settings = snapshot.voice;
    outputLock?.update(policyEntry(SETTING_NAMES.voiceOutput));
    outputSelect.value = settings.output;
    const cap = desc?.capabilities?.voice;
    // Only voices the registered, directly callable voice capability declares (§7.4).
    const voices = cap?.implementation === 'ready' && desc.browserDirect && cap.transports.includes('direct') ? cap.voices : [];
    const wanted = ['', ...voices];
    if (Array.from(voiceSelect.childNodes).map((option) => option.getAttribute('value')).join('\n') !== wanted.join('\n')) {
      for (const option of Array.from(voiceSelect.childNodes)) option.remove();
      for (const value of wanted) {
        const option = element(doc, 'option', { attributes: { value } });
        // Voice identifiers and Google's one-word tone are registered provider
        // data, not dictionary text; only the gender word is translated.
        if (value) option.textContent = voiceOptionLabel(value); else option.setAttribute('data-default', 'true');
        voiceSelect.append(option);
      }
    }
    const defaultOption = voiceSelect.childNodes[0];
    if (defaultOption) defaultOption.textContent = i18n.t('voice.provider');
    voiceSelect.value = voices.includes(settings.voice) ? settings.voice : '';
    voiceField.hidden = voices.length === 0;
    // Owner, 2026-09-06: the preview used to switch itself off whenever voice
    // output was not "provider", so the button sat dead with nothing saying
    // why. Previewing is about hearing the selected voice, which is exactly
    // what someone choosing between 30 of them needs, so it now works whatever
    // the output route is; only a running check (one at a time) still blocks
    // it, and the reason is written next to the button either way.
    const running = diagnostics.snapshot().running !== null;
    previewButton.disabled = voices.length === 0 || running;
    const outputElsewhere = settings.output !== 'provider';
    previewNote.hidden = !(running || outputElsewhere) || voices.length === 0;
    if (!previewNote.hidden) {
      previewNote.textContent = running
        ? i18n.t('voice.previewRunning')
        : i18n.t('voice.previewNotOutput', { output: i18n.t(`voice.${settings.output}`) });
    }
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
    sourceLock?.update(policyEntry(SETTING_NAMES.sourceLanguage));
    targetLock?.update(policyEntry(SETTING_NAMES.targetLanguage));
    sourceSelect.value = snapshot.interpretation.sourceLanguage;
    targetSelect.value = snapshot.interpretation.targetLanguage;
    const desc = descriptor();
    const current = selection();
    keyFeedback.hidden = !keyFeedbackKey;
    keyFeedback.textContent = keyFeedbackKey ? i18n.t(resolveKey(i18n, keyFeedbackKey)) : '';
    renderProvider(desc);
    renderKey(desc, current);
    renderShared(desc);
    renderMode(desc, current);
    renderVoice(desc);
    clearButton.disabled = snapshot.activeTurnId !== null || snapshot.turns.length === 0;
    if (clearButton.disabled && confirmingClear) showClearConfirm(false);
    diagnosticsView.render();
  }

  // Effective values reach the engine (§1.5 order): a forced value always;
  // an administrator default only when the policy first arrives or its
  // revision changes and the store records personal choices (so a choice made
  // elsewhere, e.g. the sequential screen, is not overwritten on every check).
  function effective(entry, current, push) {
    if (!entry || typeof entry !== 'object') return current;
    if (entry.locked === true) return entry.value;
    return push && preferences !== null && entry.source !== 'personal' ? entry.value : current;
  }
  function applyPolicy(next, { push = false } = {}) {
    policyState = next ?? null;
    const state = store.snapshot();
    const pair = state.interpretation;
    const sourceLanguage = effective(policyEntry(SETTING_NAMES.sourceLanguage), pair.sourceLanguage, push);
    const targetLanguage = effective(policyEntry(SETTING_NAMES.targetLanguage), pair.targetLanguage, push);
    if (sourceLanguage !== pair.sourceLanguage || targetLanguage !== pair.targetLanguage) {
      call(() => engine.setInterpretation({ sourceLanguage, targetLanguage }));
    }
    const output = effective(policyEntry(SETTING_NAMES.voiceOutput), state.voice.output, push);
    if (output !== state.voice.output) call(() => engine.setVoice({ output }));
    render(store.snapshot());
  }

  function refresh() {
    bind.refresh();
    diagnosticsView.refresh();
    policyView?.refresh();
    renderAudio();
    render(snapshot);
  }
  // The simultaneous screen's gender choice lands here as the matching provider voice.
  function mirrorVoice(preference) {
    const cap = descriptor()?.capabilities?.voice;
    const name = preference?.voiceName;
    if (!Array.isArray(cap?.voices) || !cap.voices.includes(name) || snapshot.voice.voice === name) return;
    call(() => engine.setVoice({ voice: name }));
    render(store.snapshot());
  }

  removers.push(store.subscribe(render));
  removers.push(attempt(() => keyStore.subscribe(() => { keyFeedbackKey = null; render(); })) ?? (() => {}));
  removers.push(diagnostics.subscribe(() => render()));
  removers.push(shell.onLanguageChange(refresh));
  removers.push(attempt(() => audio.subscribe(() => renderAudio())) ?? (() => {}));
  removers.push(attempt(() => voicePreference.subscribe(mirrorVoice)) ?? (() => {}));
  if (policy) {
    removers.push(policy.subscribe((next, change) => applyPolicy(next, { push: change?.type === 'initial' || change?.revisionChanged === true })));
    applyPolicy(policyState, { push: Boolean(policyState?.policy) });
  } else {
    render(snapshot);
  }

  return Object.freeze({
    element: container,
    elements: Object.freeze({ uiSelect, sourceSelect, targetSelect, providerSelect, providerTitle, keyInput, rememberInput, saveButton,
      checkButton, deleteButton, deleteConfirm, keyStatus, keyFeedback, modelSelect, sharedInput, sharedImport, sharedEnd, sharedEvent, modeInputs: Object.freeze(
        Object.fromEntries(KEY_SOURCES.map((source) => [source, modeInputs[source].input]))),
      outputSelect, voiceSelect, previewButton, deviceSelect, clearButton, clearConfirm, appActions, displayControls, keyGuideHost,
      noiseInput, filterInput, sensitivitySelect, appliedLine,
      locks: Object.freeze({ sourceSelect: sourceLock?.element ?? null, targetSelect: targetLock?.element ?? null, outputSelect: outputLock?.element ?? null }),
      policy: policyView?.elements ?? null,
      sections: Object.freeze({ ...sections,
        // P1-16 names, kept for existing callers: the blocks that now live inside the sections above.
        language: displaySection, key: keyBlock, shared: sharedBlock, mode: modeBlock, voice: voiceBlock, notices: termsSection }) }),
    get providerId() { return providerId; },
    selectProvider,
    diagnosticsView,
    policyView,
    render,
    /** P3-22: leaving the settings screen hides a revealed key (owner, 2026-09-06). */
    closeKeyEntry,
    refresh,
    destroy() {
      for (const remove of removers) attempt(remove);
      diagnosticsView.destroy();
      policyView?.destroy();
      bind.clear();
      container.remove();
    },
  });
}
