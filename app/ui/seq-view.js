// New implementation of design-v0.6 §7.2 and §12: the sequential screen.
// It only reads P1-14 snapshots and calls the engine from user gestures. All
// text comes from the i18n dictionaries and every provider string (source,
// translation) is rendered with textContent, never as markup. The DOM stays
// bounded because the store keeps at most MAX_TURNS turns and this view
// mirrors that list one element per turn.
import { MAX_TURNS, SEQ_STATUS } from '../state.js';
import { SEQ_POLICY } from '../engine/seq.js';
import { MAX_CAPTURE_MS } from '../audio/capture.js';
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { describeTurn, errorKey, levelPercent, replayOutput, resolveKey, statusKey } from './errors.js';

export const SOURCE_OPTIONS = Object.freeze(['auto', ...SUPPORTED_LANGUAGES]);
export const MAX_RENDERED_TURNS = MAX_TURNS;
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

/** Records dictionary-bound text/attributes so a UI language change re-applies them. */
export function createBinder(i18n) {
  const bindings = new Set();
  function add(apply) { bindings.add(apply); apply(); return () => bindings.delete(apply); }
  return Object.freeze({
    text(element, key, parameters) { return add(() => { element.textContent = i18n.t(key, parameters); }); },
    attribute(element, name, key, parameters) { return add(() => element.setAttribute(name, i18n.t(key, parameters))); },
    refresh() { for (const apply of [...bindings]) apply(); },
    clear() { bindings.clear(); },
  });
}

function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
const languageAttribute = (node, ...candidates) => {
  const language = candidates.find((value) => SUPPORTED_LANGUAGES.includes(value));
  if (language) node.setAttribute('lang', language); else node.removeAttribute('lang');
};

/**
 * createSeqView({ root, i18n, engine, document? }) renders into root and
 * subscribes to engine.state. Returns { element, render, refresh, onLevel,
 * onWarning, focusInput, destroy }. Wire onLevel/onWarning to
 * createCapture({ onLevel, onWarning }) in the app bootstrap (P1-19).
 */
export function createSeqView({ root, i18n, engine, document: doc = root?.ownerDocument } = {}) {
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof engine?.startRecording !== 'function'
    || typeof engine.state?.subscribe !== 'function') throw new Error('INVALID_REQUEST');
  const store = engine.state;
  const bind = createBinder(i18n);
  const turnNodes = new Map();
  let snapshot = store.snapshot();
  let confirmingClear = false;

  // Engine calls run synchronously inside the gesture; failures become notices.
  function notify(key) {
    attempt(() => store.setNotice(resolveKey(i18n, key)));
  }
  function call(action) {
    try { return action(); } catch (error) { notify(errorKey(error)); return undefined; }
  }

  const section = element(doc, 'section', { className: 'seq', attributes: { 'data-status': snapshot.status } });
  root.append(section);

  // Language pair (independent of the UI language, §12).
  const pairRow = element(doc, 'div', { className: 'seq-pair' });
  const sourceLabel = element(doc, 'label', { className: 'seq-pair-label', attributes: { for: 'seq-source' } });
  bind.text(sourceLabel, 'language.source');
  const sourceSelect = element(doc, 'select', { className: 'seq-select', attributes: { id: 'seq-source' } });
  for (const value of SOURCE_OPTIONS) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, value === 'auto' ? 'language.auto' : `language.${value}`);
    sourceSelect.append(option);
  }
  const swapButton = element(doc, 'button', { className: 'btn btn-secondary seq-swap', attributes: { type: 'button' } });
  bind.text(swapButton, 'language.swap');
  const targetLabel = element(doc, 'label', { className: 'seq-pair-label', attributes: { for: 'seq-target' } });
  bind.text(targetLabel, 'language.target');
  const targetSelect = element(doc, 'select', { className: 'seq-select', attributes: { id: 'seq-target' } });
  for (const value of SUPPORTED_LANGUAGES) {
    const option = element(doc, 'option', { attributes: { value } });
    bind.text(option, `language.${value}`);
    targetSelect.append(option);
  }
  pairRow.append(sourceLabel, sourceSelect, swapButton, targetLabel, targetSelect);

  // Choosing the same language on both sides swaps the other side instead of
  // failing; auto-detect has no counterpart, so the UI language stands in.
  function applyPair(sourceLanguage, targetLanguage, changed = 'source') {
    const current = snapshot.interpretation;
    if (sourceLanguage === targetLanguage) {
      if (changed === 'target') sourceLanguage = current.targetLanguage;
      else targetLanguage = current.sourceLanguage !== 'auto' ? current.sourceLanguage
        : [i18n.language, ...SUPPORTED_LANGUAGES].find((value) => value !== sourceLanguage);
    }
    call(() => engine.setInterpretation({ sourceLanguage, targetLanguage }));
    syncPair();
  }
  sourceSelect.addEventListener('change', () => applyPair(sourceSelect.value, snapshot.interpretation.targetLanguage, 'source'));
  targetSelect.addEventListener('change', () => applyPair(snapshot.interpretation.sourceLanguage, targetSelect.value, 'target'));
  swapButton.addEventListener('click', () => {
    const { sourceLanguage, targetLanguage } = snapshot.interpretation;
    const nextTarget = sourceLanguage !== 'auto' ? sourceLanguage
      : [i18n.language, ...SUPPORTED_LANGUAGES].find((value) => value !== targetLanguage);
    applyPair(targetLanguage, nextTarget, 'swap');
  });

  // Status badge and input level (color is never the only state signal).
  const statusRow = element(doc, 'div', { className: 'seq-status-row' });
  const statusBadge = element(doc, 'span', { className: 'badge seq-status', attributes: { role: 'status', 'aria-live': 'polite' } });
  const meter = element(doc, 'div', { className: 'seq-level', attributes: { role: 'meter', 'aria-valuemin': '0',
    'aria-valuemax': '100', 'aria-valuenow': '0' } });
  bind.attribute(meter, 'aria-label', 'seq.inputLevel');
  const meterBar = element(doc, 'div', { className: 'seq-level-bar' });
  meter.append(meterBar);
  statusRow.append(statusBadge, meter);
  function setLevel(percent) {
    meter.setAttribute('aria-valuenow', String(percent));
    meterBar.style.width = `${percent}%`;
  }

  // Push-to-talk plus the accessible start/finish alternative (§7.2).
  const controls = element(doc, 'div', { className: 'seq-controls' });
  const pttButton = element(doc, 'button', { className: 'btn btn-primary seq-ptt', attributes: { type: 'button', 'aria-pressed': 'false' } });
  bind.text(pttButton, 'seq.holdToTalk');
  const toggleButton = element(doc, 'button', { className: 'btn btn-secondary seq-toggle', attributes: { type: 'button' } });
  const cancelButton = element(doc, 'button', { className: 'btn btn-secondary seq-cancel', attributes: { type: 'button' } });
  bind.text(cancelButton, 'common.cancel');
  const hint = element(doc, 'p', { className: 'seq-hint', attributes: { 'aria-live': 'polite' } });
  controls.append(pttButton, toggleButton, cancelButton);

  const recording = () => snapshot.status === SEQ_STATUS.RECORDING;
  const start = () => { if (!recording()) call(() => engine.startRecording()); };
  const stop = () => { if (recording()) call(() => engine.stopRecording()); };
  // Hold state: which input is holding the PTT button, so a release from the
  // other input (or a stray blur) does not end a recording it did not start.
  let held = null, pointerId = null;
  pttButton.addEventListener('pointerdown', (event) => {
    if (held || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault?.();
    held = 'pointer';
    pointerId = event.pointerId ?? null;
    attempt(() => pttButton.setPointerCapture?.(event.pointerId));
    start();
  });
  const release = (event) => {
    if (held !== 'pointer') return;
    if (event?.pointerId !== undefined && pointerId !== null && event.pointerId !== pointerId) return;
    held = null; pointerId = null;
    stop();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pttButton.addEventListener(type, release);
  pttButton.addEventListener('contextmenu', (event) => event.preventDefault?.());
  const holdKey = (event) => [' ', 'Enter', 'Spacebar'].includes(event.key);
  pttButton.addEventListener('keydown', (event) => {
    if (!holdKey(event)) return;
    event.preventDefault?.();
    if (held || event.repeat) return;
    held = 'key';
    start();
  });
  const releaseKey = (event) => {
    if (held !== 'key' || (event && !holdKey(event))) return;
    event?.preventDefault?.();
    held = null;
    stop();
  };
  pttButton.addEventListener('keyup', releaseKey);
  pttButton.addEventListener('blur', () => releaseKey(null));
  toggleButton.addEventListener('click', () => { if (recording()) stop(); else start(); });
  cancelButton.addEventListener('click', () => call(() => engine.cancel()));

  // Text input works without a microphone (§7.2, §7.5).
  const form = element(doc, 'form', { className: 'seq-form', attributes: { novalidate: '' } });
  const textLabel = element(doc, 'label', { className: 'sr-only', attributes: { for: 'seq-text' } });
  bind.text(textLabel, 'seq.textInput');
  const textarea = element(doc, 'textarea', { className: 'seq-text', attributes: { id: 'seq-text', rows: '2',
    maxlength: String(SEQ_POLICY.maxTextLength), autocomplete: 'off', enterkeyhint: 'send' } });
  bind.attribute(textarea, 'placeholder', 'seq.textPlaceholder');
  const submitButton = element(doc, 'button', { className: 'btn btn-primary seq-submit', attributes: { type: 'submit' } });
  bind.text(submitButton, 'seq.translate');
  form.append(textLabel, textarea, submitButton);
  function submit() {
    const value = typeof textarea.value === 'string' ? textarea.value : '';
    if (!value.trim()) { attempt(() => textarea.focus()); return; }
    if (call(() => engine.submitText(value))) textarea.value = '';
  }
  form.addEventListener('submit', (event) => { event.preventDefault?.(); submit(); });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault?.(); submit(); }
  });

  // Records stay OFF in P1 (§14.1); clearing needs an inline confirmation.
  const recordsRow = element(doc, 'div', { className: 'seq-records' });
  const recordsBadge = element(doc, 'span', { className: 'badge seq-records-status' });
  const clearButton = element(doc, 'button', { className: 'btn btn-secondary seq-clear', attributes: { type: 'button' } });
  bind.text(clearButton, 'records.clear');
  const confirmRow = element(doc, 'div', { className: 'seq-confirm', attributes: { role: 'group' } });
  confirmRow.hidden = true;
  const confirmText = element(doc, 'span', { className: 'seq-confirm-text' });
  bind.text(confirmText, 'records.clearConfirm');
  const confirmButton = element(doc, 'button', { className: 'btn btn-danger', attributes: { type: 'button' } });
  bind.text(confirmButton, 'common.delete');
  const keepButton = element(doc, 'button', { className: 'btn btn-secondary', attributes: { type: 'button' } });
  bind.text(keepButton, 'common.cancel');
  confirmRow.append(confirmText, confirmButton, keepButton);
  recordsRow.append(recordsBadge, clearButton, confirmRow);
  function showConfirm(show) {
    confirmingClear = show;
    confirmRow.hidden = !show;
    clearButton.setAttribute('aria-expanded', String(show));
    attempt(() => (show ? confirmButton : clearButton).focus());
  }
  clearButton.addEventListener('click', () => showConfirm(!confirmingClear));
  keepButton.addEventListener('click', () => showConfirm(false));
  confirmButton.addEventListener('click', () => {
    showConfirm(false);
    call(() => store.clearTurns('records.cleared'));
  });

  // Conversation bubbles: one element per stored turn, updated in place.
  const list = element(doc, 'div', { className: 'seq-turns', attributes: { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' } });
  const empty = element(doc, 'p', { className: 'seq-empty' });
  bind.text(empty, 'seq.empty');
  section.append(pairRow, statusRow, controls, hint, form, recordsRow, empty, list);

  function createTurnNode(turn) {
    const article = element(doc, 'article', { className: 'turn', attributes: { 'data-turn-id': turn.turnId } });
    const meta = element(doc, 'p', { className: 'turn-meta' });
    const time = element(doc, 'time', { className: 'turn-time' });
    const status = element(doc, 'span', { className: 'badge turn-status' });
    meta.append(time, status);
    const sourceBlock = element(doc, 'div', { className: 'turn-block turn-source' });
    const sourceLabelNode = element(doc, 'span', { className: 'turn-label' });
    const sourceText = element(doc, 'p', { className: 'turn-text' });
    sourceBlock.append(sourceLabelNode, sourceText);
    const translationBlock = element(doc, 'div', { className: 'turn-block turn-translation' });
    const translationLabelNode = element(doc, 'span', { className: 'turn-label' });
    const translatedText = element(doc, 'p', { className: 'turn-text turn-text-translation' });
    translationBlock.append(translationLabelNode, translatedText);
    const voice = element(doc, 'p', { className: 'turn-voice' });
    const actions = element(doc, 'div', { className: 'turn-actions' });
    const button = (className, key, onClick) => {
      const node = element(doc, 'button', { className: `btn btn-secondary ${className}`, attributes: { type: 'button' } });
      node.hidden = true;
      node.addEventListener('click', () => onClick(turn.turnId));
      actions.append(node);
      return { node, key };
    };
    const buttons = {
      retry: button('turn-retry', 'common.retry', (turnId) => call(() => engine.retry(turnId))),
      play: button('turn-play', 'seq.play', (turnId) => call(() => engine.replay(turnId, { output: replayOutput(snapshot) }))),
      deviceReplay: button('turn-device', 'voice.device', (turnId) => call(() => engine.replay(turnId, { output: 'device' }))),
      stopPlayback: button('turn-stop', 'seq.stopPlayback', () => call(() => engine.cancel())),
    };
    article.append(meta, sourceBlock, translationBlock, voice, actions);
    return { article, time, status, sourceLabel: sourceLabelNode, sourceText, translationLabel: translationLabelNode,
      translatedText, voice, buttons, createdAt: null };
  }

  function updateTurnNode(node, turn) {
    const description = describeTurn(i18n, turn, snapshot);
    node.article.setAttribute('data-phase', turn.phase);
    node.article.classList.toggle('turn-active', snapshot.activeTurnId === turn.turnId);
    if (node.createdAt !== turn.createdAt) {
      node.createdAt = turn.createdAt;
      node.time.setAttribute('datetime', new Date(turn.createdAt).toISOString());
    }
    node.time.textContent = attempt(() => i18n.formatDate(new Date(turn.createdAt), { timeStyle: 'short' })) ?? '';
    node.status.textContent = i18n.t(description.statusKey);
    node.sourceLabel.textContent = i18n.t('seq.original');
    node.translationLabel.textContent = i18n.t('seq.translation');
    node.sourceText.textContent = description.sourceText;
    languageAttribute(node.sourceText, turn.detectedLanguage, turn.sourceLanguage);
    node.translatedText.textContent = description.translatedText;
    languageAttribute(node.translatedText, turn.targetLanguage);
    node.voice.textContent = description.voiceKey ? i18n.t(description.voiceKey) : '';
    node.voice.hidden = !description.voiceKey;
    for (const [name, { node: button, key }] of Object.entries(node.buttons)) {
      button.textContent = i18n.t(key);
      button.hidden = !description.actions[name];
    }
  }

  function renderTurns() {
    const turns = snapshot.turns.slice(-MAX_RENDERED_TURNS);
    const keep = new Set(turns.map((turn) => turn.turnId));
    for (const [turnId, node] of turnNodes) {
      if (!keep.has(turnId)) { node.article.remove(); turnNodes.delete(turnId); }
    }
    for (const turn of turns) {
      let node = turnNodes.get(turn.turnId);
      if (!node) { node = createTurnNode(turn); turnNodes.set(turn.turnId, node); list.append(node.article); }
      updateTurnNode(node, turn);
    }
    empty.hidden = turns.length > 0;
  }

  function syncPair() {
    sourceSelect.value = snapshot.interpretation.sourceLanguage;
    targetSelect.value = snapshot.interpretation.targetLanguage;
  }

  function render(next = store.snapshot()) {
    snapshot = next;
    const status = snapshot.status;
    const busy = snapshot.activeTurnId !== null;
    section.setAttribute('data-status', status);
    statusBadge.textContent = i18n.t(statusKey(status));
    pttButton.setAttribute('aria-pressed', String(status === SEQ_STATUS.RECORDING));
    toggleButton.textContent = i18n.t(status === SEQ_STATUS.RECORDING ? 'seq.stopRecording' : 'seq.startRecording');
    cancelButton.hidden = !busy || status === SEQ_STATUS.RECORDING;
    if (status !== SEQ_STATUS.RECORDING) {
      setLevel(0);
      hint.textContent = i18n.t('seq.recordingLimit', { seconds: Math.round(MAX_CAPTURE_MS / 1000) });
    }
    clearButton.disabled = busy || snapshot.turns.length === 0;
    if (clearButton.disabled && confirmingClear) showConfirm(false);
    recordsBadge.textContent = i18n.t(resolveKey(i18n, snapshot.records?.messageKey, 'records.off'));
    syncPair();
    renderTurns();
  }

  const unsubscribe = store.subscribe(render);
  render(snapshot);

  return Object.freeze({
    element: section,
    render,
    // UI language changed: re-apply dictionary text and re-render bubbles.
    refresh() { bind.refresh(); render(snapshot); },
    onLevel(level) { if (recording()) setLevel(levelPercent(level)); },
    onWarning(warning) { if (recording()) hint.textContent = i18n.t(resolveKey(i18n, warning?.messageKey, 'seq.recordingEnding')); },
    focusInput() { attempt(() => textarea.focus()); },
    destroy() {
      unsubscribe();
      bind.clear();
      turnNodes.clear();
      section.remove();
    },
  });
}
