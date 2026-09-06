// P3-20: the display controls of design-p3 §1.12 section 1 — mode, tone, app
// text size, caption size and a preview — as one component mounted in two
// places: the header's 화면 sheet and the settings screen's display section.
//
// The two mounts are two renderings of ONE state, never two states. Nothing
// here keeps a value: every control reads app/ui/appearance.js (mode, tone,
// text) or the preference store (captions.size) and writes back through them,
// and every instance subscribes to appearance, so a change made in either
// place is on screen in the other before the press finishes.
//
// Policy locks come from the same effective settings the resolver produced:
// a forced value disables its control and says why (createLockNote, §1.6),
// and values outside the administrator's allowed range are not offered.
import { APPEARANCE_SETTINGS, SYSTEM_MODE } from './appearance.js';
import { REGISTERED_SETTINGS } from '../policy/schema.js';
import { CAPTION_SIZE, clampCaptionSize, stepCaptionSize } from '../preferences.js';
import { createBinder } from './seq-view.js';
import { createLockNote, SETTING_NAMES } from './policy-view.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
// Registered names are composed rather than written as dotted literals, so the
// i18n regression does not read them as dictionary keys (as in policy-view.js).
const MODE_VALUES = Object.freeze([...REGISTERED_SETTINGS[SETTING_NAMES.mode].values]);
const TONE_VALUES = Object.freeze([...REGISTERED_SETTINGS[SETTING_NAMES.tone].values]);
const TEXT_VALUES = Object.freeze([...REGISTERED_SETTINGS[SETTING_NAMES.text].values]);
/** Dictionary key of one option, e.g. display.mode.dark / display.tone.navy. */
const optionKey = (group, value) => `display.${group}.${value}`;
const GROUPS = Object.freeze([
  { name: SETTING_NAMES.mode, group: 'mode', values: MODE_VALUES, hint: 'display.systemHint' },
  { name: SETTING_NAMES.tone, group: 'tone', values: TONE_VALUES, hint: 'display.monoHint' },
  { name: SETTING_NAMES.text, group: 'text', values: TEXT_VALUES, hint: 'display.textHint' },
]);

/**
 * createDisplayControls({ appearance, i18n, document, preferences?, policy?,
 * instance? }) appends nothing itself; the caller places `element`.
 *
 * - `appearance` is createAppearance()'s result and is the only owner of mode,
 *   tone and text. It is also the change feed: this component re-renders on
 *   every emission, whoever caused it.
 * - `preferences` is the store; only captions.size is written directly here,
 *   because it is not an appearance attribute. It is read back from the same
 *   effective settings, so a policy lock applies to it too.
 * - `policy` (createPolicyRuntime()) enables the lock notes. Without it the
 *   controls work and simply never claim an administrator set anything.
 * - `instance` distinguishes the two mounts in the DOM (ids must stay unique)
 *   and appears as data-instance.
 *
 * Returns frozen { element, render, refresh, destroy }.
 */
export function createDisplayControls({ appearance, i18n, document: doc, preferences = null,
  policy = null, instance = 'settings' } = {}) {
  if (!doc || typeof i18n?.t !== 'function' || typeof appearance?.snapshot !== 'function'
    || typeof appearance.subscribe !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  const removers = [];
  const listen = (node, type, fn) => { node.addEventListener(type, fn); removers.push(() => node.removeEventListener(type, fn)); };
  const id = (suffix) => `display-${instance}-${suffix}`;
  let destroyed = false;

  const root = element(doc, 'div', { className: 'display-controls',
    attributes: { 'data-instance': instance, role: 'group', 'aria-labelledby': id('title') } });
  const title = element(doc, 'h3', { className: 'display-title', attributes: { id: id('title') } });
  bind.text(title, 'display.title');
  root.append(title);

  // One radio group per appearance setting. Radios (not a select) so the whole
  // choice is visible at a glance and every option keeps its own touch target.
  const groups = new Map();
  for (const spec of GROUPS) {
    const field = element(doc, 'fieldset', { className: `display-group display-${spec.group}` });
    const legend = element(doc, 'legend', { className: 'display-legend' });
    bind.text(legend, `display.${spec.group}`);
    field.append(legend);
    const options = new Map();
    for (const value of spec.values) {
      const label = element(doc, 'label', { className: 'display-option' });
      const input = element(doc, 'input', { className: 'display-input',
        attributes: { type: 'radio', name: id(spec.group), value, id: id(`${spec.group}-${value}`) } });
      const text = element(doc, 'span', { className: 'display-option-text' });
      bind.text(text, optionKey(spec.group, value));
      label.append(input, text);
      field.append(label);
      options.set(value, { label, input });
      listen(input, 'change', () => { if (input.checked) apply(spec.name, value); });
    }
    const hint = element(doc, 'p', { className: 'display-hint' });
    bind.text(hint, spec.hint);
    field.append(hint);
    const lock = policy ? createLockNote({ document: doc, i18n, control: field, id: id(`${spec.group}-lock`) }) : null;
    if (lock) field.append(lock.element);
    root.append(field);
    groups.set(spec.name, { spec, field, options, lock });
  }

  // Caption size: the §1.10 scale that stacks on top of the app text size, so
  // it gets its own slider plus the 가− / 가+ steps the caption board also uses.
  const captions = element(doc, 'div', { className: 'display-group display-captions' });
  const captionsLabel = element(doc, 'label', { className: 'display-legend', attributes: { for: id('captions') } });
  bind.text(captionsLabel, 'display.captions.size');
  const smaller = element(doc, 'button', { className: 'btn btn-secondary display-captions-smaller', attributes: { type: 'button' } });
  bind.text(smaller, 'display.captions.smaller');
  const slider = element(doc, 'input', { className: 'display-captions-slider',
    attributes: { type: 'range', id: id('captions'), min: String(CAPTION_SIZE.min),
      max: String(CAPTION_SIZE.max), step: String(CAPTION_SIZE.step) } });
  const larger = element(doc, 'button', { className: 'btn btn-secondary display-captions-larger', attributes: { type: 'button' } });
  bind.text(larger, 'display.captions.larger');
  const captionsValue = element(doc, 'output', { className: 'display-captions-value' });
  const captionsRow = element(doc, 'div', { className: 'display-captions-row' });
  captionsRow.append(smaller, slider, larger, captionsValue);
  const captionsRange = element(doc, 'p', { className: 'display-hint' });
  bind.text(captionsRange, 'display.captions.range');
  const captionsHint = element(doc, 'p', { className: 'display-hint' });
  bind.text(captionsHint, 'display.captions.hint');
  captions.append(captionsLabel, captionsRow, captionsRange, captionsHint);
  const captionsLock = policy ? createLockNote({ document: doc, i18n, control: slider, id: id('captions-lock') }) : null;
  if (captionsLock) captions.append(captionsLock.element);
  root.append(captions);

  // Preview: the sample carries the caption size so the effect of both scales
  // is visible without leaving the sheet.
  const preview = element(doc, 'div', { className: 'display-preview' });
  const previewTitle = element(doc, 'h4', { className: 'display-preview-title' });
  bind.text(previewTitle, 'display.preview');
  const previewSample = element(doc, 'p', { className: 'display-preview-sample turn-text' });
  bind.text(previewSample, 'display.previewSample');
  preview.append(previewTitle, previewSample);
  root.append(preview);

  const savedNote = element(doc, 'p', { className: 'display-hint display-saved' });
  bind.text(savedNote, 'display.savedOnDevice');
  root.append(savedNote);
  // Shown only when a write did not reach storage, so the choice is honest
  // about surviving a reload (the store reports persisted:false).
  const failedNote = element(doc, 'p', { className: 'display-note display-not-saved', attributes: { role: 'status' } });
  bind.text(failedNote, 'error.STORAGE_FAILED');
  failedNote.hidden = true;
  root.append(failedNote);

  function apply(name, value) {
    if (destroyed) return;
    // appearance.set() refuses a locked or disallowed value without writing;
    // render() then puts the control back on the effective value.
    attempt(() => appearance.set(name, value));
    render();
  }
  function applyCaptionSize(value) {
    if (destroyed || !preferences) return;
    const next = clampCaptionSize(value);
    if (captionSetting().locked === true) { render(); return; }
    attempt(() => preferences.set(SETTING_NAMES.captionsSize, next));
    render();
  }
  // appearance.snapshot().settings carries only the three <html> settings, so
  // the caption size is read from the runtime's effective settings (policy ∩
  // personal). Without a runtime the personal choice is the effective value.
  const effective = () => attempt(() => appearance.snapshot().settings) ?? {};
  function captionSetting() {
    const fromPolicy = attempt(() => policy?.snapshot().settings?.[SETTING_NAMES.captionsSize]);
    if (fromPolicy) return fromPolicy;
    const value = attempt(() => preferences?.get(SETTING_NAMES.captionsSize));
    return { value: value ?? CAPTION_SIZE.initial, locked: false, reasonKey: null, source: null };
  }

  function render() {
    if (destroyed) return;
    const state = attempt(() => appearance.snapshot());
    if (!state) return;
    for (const [name, entry] of groups) {
      const setting = state.settings?.[name] ?? null;
      const allowed = Array.isArray(setting?.allowed) ? setting.allowed : null;
      const current = setting?.value ?? null;
      for (const [value, option] of entry.options) {
        // An option the administrator excluded is not offered at all (§1.6).
        const offered = !allowed || allowed.includes(value);
        option.label.hidden = !offered;
        option.input.disabled = !offered || setting?.locked === true;
        option.input.checked = value === current;
      }
      entry.lock?.update(setting);
    }
    const caption = captionSetting();
    const size = clampCaptionSize(caption.value);
    const locked = caption.locked === true;
    slider.value = String(size);
    slider.disabled = locked || !preferences;
    smaller.disabled = slider.disabled || size <= CAPTION_SIZE.min;
    larger.disabled = slider.disabled || size >= CAPTION_SIZE.max;
    const text = i18n.t('display.captions.value', { size: String(size) });
    if (captionsValue.textContent !== text) captionsValue.textContent = text;
    slider.setAttribute('aria-valuetext', text);
    captionsLock?.update(caption);
    // The preview shows the caption scale on top of whatever text size is set.
    attempt(() => previewSample.style?.setProperty?.('--caption-size', `${size}rem`));
    // The resolved mode is what the page actually shows, which is not the
    // stored choice while "system" follows the device.
    root.setAttribute('data-resolved-mode', state.resolvedMode ?? SYSTEM_MODE);
    failedNote.hidden = state.persisted !== false;
  }

  listen(slider, 'input', () => applyCaptionSize(slider.value));
  listen(smaller, 'click', () => applyCaptionSize(stepCaptionSize(currentSize(), -1)));
  listen(larger, 'click', () => applyCaptionSize(stepCaptionSize(currentSize(), 1)));
  const currentSize = () => clampCaptionSize(captionSetting().value);

  // The change feed: any instance, the settings screen, the caption board or a
  // new policy revision lands here, so the two mounts cannot drift apart.
  removers.push(appearance.subscribe(() => render()));
  if (preferences && typeof preferences.subscribe === 'function') {
    removers.push(preferences.subscribe(() => render()));
  }
  render();

  return Object.freeze({
    element: root,
    elements: Object.freeze({ slider, smaller, larger, captionsValue, preview: previewSample,
      groups: Object.freeze(Object.fromEntries([...groups].map(([name, entry]) => [name, entry.field]))) }),
    render,
    refresh() { if (!destroyed) { bind.refresh(); for (const entry of groups.values()) entry.lock?.refresh(); captionsLock?.refresh(); render(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of removers) attempt(() => off());
      bind.clear();
      root.remove();
    },
  });
}
export { APPEARANCE_SETTINGS, MODE_VALUES, TONE_VALUES, TEXT_VALUES };
