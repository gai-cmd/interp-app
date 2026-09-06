// P3-24: the microphone permission and audio device section of the settings
// screen (design-p3 §1.14), mounted into the audio section by settings-view.
//
// The rule this section exists to keep: "자동 설정" means starting the request
// from a user gesture, never granting anything on the app's behalf. So the
// only thing here that touches the microphone is a button someone pressed, and
// that request is a `probe` — permission is obtained and every temporary track
// is stopped immediately, so no recording indicator is left burning after a
// settings save. The stream a start needs is acquired by the start itself,
// through the platform handover, so there is never a second prompt.
//
// Nothing here requests on mount, on render, or on a status change: a denial
// must not turn into a retry loop, and the header, hub listening and the
// administrator console must reach zero requests.
import { PERMISSION_STATES, permissionHintKey, permissionMessageKey } from '../audio/permissions.js';
import { createBinder } from './seq-view.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
/** The platform help lines, all three shown: the device is not detected here. */
export const PERMISSION_HELP_KEYS = Object.freeze(['permission.help.ios', 'permission.help.android',
  'permission.help.desktop', 'permission.help.menuVaries']);

/**
 * createAudioSettings({ permission, i18n, document, devices?, onRequest? })
 *
 * `permission` is createMicrophonePermission()'s result. `devices` is P3-25's
 * device service (optional; the lists simply stay empty without it).
 * `onRequest` lets the app run the gesture-scoped request itself (it owns the
 * activity lease); without it the service is asked directly.
 *
 * Returns frozen { element, render, refresh, destroy }.
 */
export function createAudioSettings({ permission, i18n, document: doc, devices = null,
  onRequest = null } = {}) {
  if (!doc || typeof i18n?.t !== 'function' || typeof permission?.snapshot !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  const removers = [];
  let destroyed = false, requesting = false;

  const root = element(doc, 'div', { className: 'audio-settings' });
  const title = element(doc, 'h4', { className: 'settings-block-title' });
  bind.text(title, 'permission.title');
  root.append(title);

  // Status is what the browser reports now, never a stored value (§1.14).
  const status = element(doc, 'p', { className: 'badge audio-permission-status',
    attributes: { role: 'status', 'aria-live': 'polite' } });
  root.append(status);
  const hint = element(doc, 'p', { className: 'settings-note audio-permission-hint' });
  root.append(hint);

  const requestButton = element(doc, 'button', { className: 'btn btn-secondary audio-permission-request',
    attributes: { type: 'button' } });
  bind.text(requestButton, 'permission.request');
  root.append(requestButton);
  // A gesture, and only a gesture. The probe purpose stops every track it got.
  const handler = async () => {
    if (destroyed || requesting) return;
    requesting = true;
    render();
    try { await (onRequest ? onRequest({ purpose: 'probe' }) : permission.request({ purpose: 'probe' })); }
    catch { /* The service reports failures through its snapshot, never by throwing. */ }
    finally { requesting = false; render(); }
  };
  requestButton.addEventListener('click', handler);
  removers.push(() => requestButton.removeEventListener('click', handler));

  for (const key of ['permission.gestureOnly', 'permission.notNeededHere', 'permission.notEvidence',
    'permission.noAutoRetry']) {
    const note = element(doc, 'p', { className: 'settings-note' });
    bind.text(note, key);
    root.append(note);
  }

  // Shown only while the permission is actually denied: help nobody needs is
  // noise, and it must not read as though something went wrong otherwise.
  const help = element(doc, 'div', { className: 'audio-permission-help' });
  const helpTitle = element(doc, 'h5', { className: 'audio-permission-help-title' });
  bind.text(helpTitle, 'permission.help.title');
  help.append(helpTitle);
  for (const key of PERMISSION_HELP_KEYS) {
    const line = element(doc, 'p', { className: 'settings-note' });
    bind.text(line, key);
    help.append(line);
  }
  help.hidden = true;
  root.append(help);

  // --- devices (P3-25's service; the lists are empty without it) ---
  const deviceBlock = element(doc, 'div', { className: 'audio-devices' });
  const selects = {};
  for (const [kind, labelKey, id] of [['audioinput', 'device.input', 'audio-device-input'],
    ['audiooutput', 'device.output', 'audio-device-output']]) {
    const row = element(doc, 'div', { className: `settings-field audio-device audio-device-${kind}` });
    const label = element(doc, 'label', { className: 'settings-label', attributes: { for: id } });
    bind.text(label, labelKey);
    const select = element(doc, 'select', { className: 'settings-select', attributes: { id } });
    const change = () => { attempt(() => devices?.select(kind, select.value || null)); render(); };
    select.addEventListener('change', change);
    removers.push(() => select.removeEventListener('change', change));
    row.append(label, select);
    deviceBlock.append(row);
    selects[kind] = { row, select, options: '' };
  }
  const deviceMessage = element(doc, 'p', { className: 'settings-note audio-device-message', attributes: { role: 'status' } });
  deviceBlock.append(deviceMessage);
  const refresh = element(doc, 'button', { className: 'btn btn-secondary audio-device-refresh', attributes: { type: 'button' } });
  bind.text(refresh, 'device.refresh');
  const refreshHandler = () => { attempt(() => devices?.refresh({ reason: 'manual' })); render(); };
  refresh.addEventListener('click', refreshHandler);
  removers.push(() => refresh.removeEventListener('click', refreshHandler));
  deviceBlock.append(refresh);
  for (const key of ['device.localOnly', 'device.inputAppliesNextStart', 'device.outputPcmOnly']) {
    const note = element(doc, 'p', { className: 'settings-note' });
    bind.text(note, key);
    deviceBlock.append(note);
  }
  deviceBlock.hidden = devices === null;
  root.append(deviceBlock);

  function renderDevices() {
    if (devices === null) return;
    const snapshot = attempt(() => devices.snapshot()) ?? null;
    if (!snapshot) return;
    for (const [kind, entry] of Object.entries(selects)) {
      const list = attempt(() => devices.list(kind)) ?? [];
      const wanted = list.map((item) => item.deviceId).join('\n');
      if (wanted !== entry.options) {
        entry.options = wanted;
        for (const option of Array.from(entry.select.childNodes)) option.remove();
        for (const item of list) {
          const option = element(doc, 'option', { attributes: { value: item.deviceId } });
          // A real device label is provider/OS data; only our own stand-ins
          // (system default, unlabelled) come from the dictionary.
          option.textContent = item.label || i18n.t(item.labelKey ?? 'device.unlabeled');
          entry.select.append(option);
        }
      }
      entry.select.value = snapshot.selected?.[kind]?.deviceId ?? '';
      entry.row.hidden = list.length === 0;
    }
    const key = snapshot.messageKey ?? (snapshot.labelsAvailable === false ? 'device.labelsAfterPermission'
      : snapshot.incomplete ? 'device.listIncomplete' : null);
    deviceMessage.hidden = key === null;
    if (key) deviceMessage.textContent = i18n.t(key);
  }

  function render() {
    if (destroyed) return;
    const state = attempt(() => permission.snapshot()) ?? null;
    if (!state) return;
    const messageKey = requesting ? 'permission.checking'
      : permissionMessageKey({ status: state.status, error: state.error, requesting: state.requesting });
    status.textContent = i18n.t(messageKey);
    status.setAttribute('data-permission', PERMISSION_STATES.includes(state.status) ? state.status : 'unsupported');
    const hintKey = permissionHintKey({ status: state.status, error: state.error });
    hint.hidden = !hintKey;
    if (hintKey) hint.textContent = i18n.t(hintKey);
    // Denied: the button stays, because the browser may have been changed since,
    // but the app never presses it on anyone's behalf.
    help.hidden = state.status !== 'denied';
    requestButton.disabled = requesting || state.requesting === true;
    renderDevices();
  }

  removers.push(permission.subscribe(() => render()));
  if (devices && typeof devices.subscribe === 'function') removers.push(devices.subscribe(() => render()));
  render();

  return Object.freeze({
    element: root,
    elements: Object.freeze({ status, hint, requestButton, help, deviceBlock, deviceMessage, refresh,
      inputSelect: selects.audioinput.select, outputSelect: selects.audiooutput.select }),
    render,
    refresh() { if (!destroyed) { bind.refresh(); render(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of removers) attempt(() => off());
      bind.clear();
      root.remove();
    },
  });
}
