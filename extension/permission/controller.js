// New implementation of docs/extension.md §8.4; no legacy code is ported.
// The microphone-permission page: the one place that asks for the microphone, because neither the offscreen document
// nor (probably) the side panel can show the permission prompt. It calls getUserMedia once on load, stops every track
// at once in EVERY branch (the microphone is never left on: this page only wants the permission) and closes itself
// shortly after a grant. The instruction text tells the user what to AVOID ("Allow this time"), not a label to pick.
import { applyI18n } from '../lib/dom-i18n.js';

const CLOSE_AFTER_GRANT_MS = 2_000;
export const PERMISSION_ELEMENT_IDS = Object.freeze(['perm-request', 'perm-close', 'perm-status', 'perm-help']);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

/** createPermissionController({ document, navigator, window, i18n, timers }) -> Readonly<{ start(), dispose() }> */
export function createPermissionController({ document, navigator, window, i18n, timers = {} } = {}) {
  const setTimeout = timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimeout = timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const t = (key) => i18n.t(key);
  const els = new Map();
  const removers = [];
  let busy = false;
  let disposed = false;
  let closeTimer = null;

  const setStatus = (...keys) => {
    const el = els.get('perm-status');
    if (el) el.textContent = keys.map((key) => t(key)).join(' ');
  };
  // #perm-help is a persistent live region like #perm-status: it is never hidden or unhidden (a region that appears
  // together with its text is often not announced), its text is written after a denial and cleared otherwise.
  const setHelp = (visible) => {
    const el = els.get('perm-help');
    if (el) el.textContent = visible ? t('ext.permission.blockedHelp') : '';
  };
  // The tracks are stopped whatever the outcome; a stream that resolves after dispose is stopped too.
  const stopTracks = (stream) => {
    for (const track of attempt(() => stream.getTracks()) ?? []) attempt(() => track.stop());
  };

  function showGranted() {
    setHelp(false);
    setStatus('permission.granted', 'ext.permission.done');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { closeTimer = null; attempt(() => window.close()); }, CLOSE_AFTER_GRANT_MS);
  }

  function showFailure(name) {
    if (name === 'NotFoundError') { setHelp(false); setStatus('permission.noDevice', 'permission.noDeviceHint'); return; }
    if (name === 'NotReadableError') { setHelp(false); setStatus('permission.busy', 'permission.busyHint'); return; }
    // NotAllowedError, SecurityError and anything unexpected all read as a denial.
    setStatus('permission.denied');
    setHelp(true);
  }

  async function request() {
    if (busy || disposed) return;
    busy = true;
    setHelp(false);
    setStatus('permission.prompt');
    try {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (error) {
        if (!disposed) showFailure(attempt(() => error.name));
        return;
      }
      stopTracks(stream);
      if (!disposed) showGranted();
    } finally { busy = false; }
  }

  async function start() {
    for (const id of PERMISSION_ELEMENT_IDS) {
      const el = document.getElementById(id);
      if (el) els.set(id, el);
    }
    applyI18n(document, i18n);
    setHelp(false);
    const bind = (id, handler) => {
      const el = els.get(id);
      if (!el) return;
      const wrapped = () => { void Promise.resolve().then(handler).catch(() => {}); };
      el.addEventListener('click', wrapped);
      removers.push(() => el.removeEventListener('click', wrapped));
    };
    bind('perm-request', request);
    bind('perm-close', () => { clearTimeout(closeTimer); closeTimer = null; attempt(() => window.close()); });

    setStatus('permission.checking');
    let state;
    try { state = (await navigator.permissions?.query({ name: 'microphone' }))?.state; } catch { state = undefined; }
    if (disposed) return;
    if (state === 'granted') { showGranted(); return; }
    await request();
  }

  function dispose() {
    disposed = true;
    clearTimeout(closeTimer);
    for (const remove of removers.splice(0)) remove();
  }

  return Object.freeze({ start, dispose });
}
