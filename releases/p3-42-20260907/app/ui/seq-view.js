// New implementation of design-v0.6 §7.2 and §12: the sequential screen.
// It only reads P1-14 snapshots and calls the engine from user gestures. All
// text comes from the i18n dictionaries and every provider string (source,
// translation) is rendered with textContent, never as markup. The DOM stays
// bounded because the store keeps at most MAX_TURNS turns and this view
// mirrors that list one element per turn.
//
// P3-17 (DESIGN.md §5, §8; design-p3 §1.9): the screen has two layouts and the
// DOM order follows the visual order in both, so Tab order never diverges.
//   stacked (<64rem): language pair, transcript, then a sticky bottom dock with
//     the status row, PTT, start/finish, hint and text form (thumb range).
//   desktop (>=64rem): a 24rem control column (pair + dock) on the left and the
//     transcript in the variable-width column on the right.
// The switch moves real nodes (matchMedia on the same 64rem breakpoint as the
// stylesheet) instead of using CSS `order`, which would leave keyboard
// navigation in the source order.
import { MAX_TURNS, SEQ_STATUS, TURN_PHASE } from '../state.js';
import { SEQ_POLICY } from '../engine/seq.js';
import { MAX_CAPTURE_MS } from '../audio/capture.js';
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { describeTurn, errorKey, levelPercent, replayOutput, resolveKey, statusKey } from './errors.js';

export const SOURCE_OPTIONS = Object.freeze(['auto', ...SUPPORTED_LANGUAGES]);
export const MAX_RENDERED_TURNS = MAX_TURNS;
// Must equal the desktop breakpoint in styles.css (DESIGN.md §8: 64rem).
export const DESKTOP_LAYOUT_QUERY = '(min-width: 64rem)';
export const SEQ_LAYOUTS = Object.freeze({ STACKED: 'stacked', DESKTOP: 'desktop' });
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
  bind.text(swapButton, 'language.swapShort');
  bind.attribute(swapButton, 'aria-label', 'language.swap');
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

  // Push-to-talk plus the accessible start/finish alternative (§7.2). The PTT
  // label is render-driven: it reads "recording" while pressed (DESIGN.md §4).
  const controls = element(doc, 'div', { className: 'seq-controls' });
  const pttButton = element(doc, 'button', { className: 'btn btn-primary seq-ptt', attributes: { type: 'button', 'aria-pressed': 'false' } });
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
  const submitHint = element(doc, 'p', { className: 'seq-hint', attributes: { id: 'seq-submit-hint' } });
  bind.text(submitHint, 'seq.submitHint');
  textarea.setAttribute('aria-describedby', 'seq-submit-hint');
  // Visual order is textarea | send, hint underneath; the DOM matches it.
  form.append(textLabel, textarea, submitButton, submitHint);
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

  // Layout containers (P3-17). The transcript owns the records row because
  // "clear" acts on the transcript; the dock holds everything needed while
  // speaking so it can stay visible at the bottom of a phone screen.
  const transcript = element(doc, 'div', { className: 'seq-transcript' });
  transcript.append(recordsRow, empty, list);
  const dock = element(doc, 'div', { className: 'seq-dock' });
  dock.append(statusRow, controls, hint, form);
  const column = element(doc, 'div', { className: 'seq-column' });
  let layout = null;
  function applyLayout(desktop) {
    const next = desktop ? SEQ_LAYOUTS.DESKTOP : SEQ_LAYOUTS.STACKED;
    if (next === layout) return layout;
    // Moving a focused node blurs it in real browsers; put focus back so a
    // rotation or window resize does not drop the user out of the screen.
    const active = doc.activeElement;
    layout = next;
    section.setAttribute('data-layout', layout);
    if (desktop) {
      column.append(pairRow, dock);
      section.append(column, transcript);
    } else {
      column.remove();
      section.append(pairRow, transcript, dock);
    }
    if (active && active !== doc.activeElement && attempt(() => section.contains(active))) attempt(() => active.focus());
    return layout;
  }
  // Same query as the stylesheet; without matchMedia (no window, old engines)
  // the stacked order stands and the CSS grid stays off (it keys on data-layout).
  const media = attempt(() => doc.defaultView?.matchMedia?.(DESKTOP_LAYOUT_QUERY)) ?? null;
  const onMediaChange = (event) => applyLayout((event?.matches ?? media?.matches) === true);
  let stopMedia = () => {};
  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onMediaChange);
      stopMedia = () => attempt(() => media.removeEventListener('change', onMediaChange));
    } else if (typeof media.addListener === 'function') {
      media.addListener(onMediaChange);
      stopMedia = () => attempt(() => media.removeListener?.(onMediaChange));
    }
  }
  applyLayout(media?.matches === true);

  function createTurnNode(turn) {
    const article = element(doc, 'article', { className: 'turn', attributes: { 'data-turn-id': turn.turnId } });
    // Meta (DESIGN.md §4): time, status, engine and elapsed time, muted 0.8125rem.
    const meta = element(doc, 'p', { className: 'turn-meta' });
    const time = element(doc, 'time', { className: 'turn-time' });
    const status = element(doc, 'span', { className: 'badge turn-status' });
    const engine_ = element(doc, 'span', { className: 'turn-engine mono' });
    const latency = element(doc, 'span', { className: 'turn-latency' });
    meta.append(time, status, engine_, latency);
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
      deviceReplay: button('turn-device', 'seq.replayDevice', (turnId) => call(() => engine.replay(turnId, { output: 'device' }))),
      stopPlayback: button('turn-stop', 'seq.stopPlayback', () => call(() => engine.cancel())),
    };
    article.append(meta, sourceBlock, translationBlock, voice, actions);
    return { article, time, status, engine: engine_, latency, sourceLabel: sourceLabelNode, sourceText,
      translationLabel: translationLabelNode, translatedText, voice, buttons, createdAt: null };
  }

  // Elapsed time of a finished turn (start to end, including playback), as a
  // localized unit string; no dictionary key is needed for the unit.
  function elapsedText(turn) {
    if (typeof turn.createdAt !== 'number' || typeof turn.endedAt !== 'number' || turn.endedAt < turn.createdAt) return '';
    const seconds = (turn.endedAt - turn.createdAt) / 1000;
    return attempt(() => i18n.formatNumber(seconds, { style: 'unit', unit: 'second', unitDisplay: 'narrow', maximumFractionDigits: 1 })) ?? '';
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
    // State also travels as an attribute (border style), never by colour alone.
    if (turn.phase === TURN_PHASE.ERROR) node.status.setAttribute('data-state', 'error');
    else if (turn.phase === TURN_PHASE.RECORDING) node.status.setAttribute('data-state', 'recording');
    else node.status.removeAttribute('data-state');
    const engineName = typeof turn.model === 'string' ? turn.model : '';
    node.engine.textContent = engineName;
    node.engine.hidden = engineName === '';
    const elapsed = elapsedText(turn);
    node.latency.textContent = elapsed;
    node.latency.hidden = elapsed === '';
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
    if (status === SEQ_STATUS.RECORDING) statusBadge.setAttribute('data-state', 'recording');
    else statusBadge.removeAttribute('data-state');
    pttButton.setAttribute('aria-pressed', String(status === SEQ_STATUS.RECORDING));
    pttButton.textContent = i18n.t(status === SEQ_STATUS.RECORDING ? 'seq.recording' : 'seq.holdToTalk');
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
    // 'stacked' or 'desktop' (P3-17); follows the 64rem media query.
    get layout() { return layout; },
    // UI language changed: re-apply dictionary text and re-render bubbles.
    refresh() { bind.refresh(); render(snapshot); },
    onLevel(level) { if (recording()) setLevel(levelPercent(level)); },
    onWarning(warning) { if (recording()) hint.textContent = i18n.t(resolveKey(i18n, warning?.messageKey, 'seq.recordingEnding')); },
    focusInput() { attempt(() => textarea.focus()); },
    destroy() {
      unsubscribe();
      stopMedia();
      bind.clear();
      turnNodes.clear();
      section.remove();
    },
  });
}
