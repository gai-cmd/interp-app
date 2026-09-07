// New implementation of design-v0.6 §6.1 (install guidance), §12 (manifest
// per language), §13.2 (update policy) and §13.3 (iOS): the page side of the
// P1-18 service worker. Nothing here is ported from interp-web or jp-patch.
//
// Policy:
// - register('./sw.js') at the root scope; registration never blocks the UI.
// - A waiting worker (found at registration or after updatefound) means an
//   update is available. It is applied only when the user asks, nothing is
//   interpreting or being checked, and the worker counts exactly one window
//   client. With more clients the caller shows the "close other tabs"
//   guidance and the update stays pending (§13.2).
// - The worker skips waiting only on 'interp:apply-update'; controllerchange
//   then reloads this page. A controllerchange this page did not request
//   (another tab applied the update) reloads only when idle; otherwise the
//   reload waits until the caller reports idle (reloadIfPending).
// - Install: beforeinstallprompt is captured and shown as a button; iOS gets
//   the manual "add to Home Screen" guidance; installed apps show nothing.
// - Every string is a dictionary key rendered with textContent. No logging.
import { createBinder } from './ui/seq-view.js';
import { resolveKey } from './ui/errors.js';

export const WORKER_URL = './sw.js';
export const WORKER_SCOPE = './';
// Design values: how long a worker reply is awaited, and how many window
// clients may exist for an update to apply (this page only).
export const PWA_POLICY = Object.freeze({ replyTimeoutMs: 3000, maxClientsForUpdate: 1,
  // Owner (2026-09-07): with autoApply an update installs itself as soon as
  // the page is idle and alone; a refusal (busy, other tabs) is retried at
  // this interval and on every idle signal, so nothing waits for a button.
  autoRetryMs: 15000 });
// Same shape the settings view accepts for app.version (P1-16) and the
// release id pattern of scripts/stage-release.mjs (P1-18).
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const UPDATE_RESULT = Object.freeze({ APPLIED: 'applied', NONE: 'none', UNSUPPORTED: 'unsupported',
  ACTIVE: 'active', OTHER_TABS: 'other-tabs', FAILED: 'failed' });
// Dictionary keys for each install situation (§6.1 step 9, §13.3).
export const INSTALL_KEYS = Object.freeze({ installed: 'pwa.installed', prompt: 'pwa.install',
  ios: 'pwa.iosInstall', browser: 'pwa.browserInstall', unavailable: 'pwa.installUnavailable' });
// Keys the update flow shows for each deferral reason.
export const UPDATE_KEYS = Object.freeze({ available: 'pwa.updateAvailable', active: 'pwa.updateAvailable',
  otherTabs: 'pwa.closeOtherTabs' });

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

/** Home-screen launch (display-mode media query, or Safari's navigator.standalone). */
export function isStandalone({ matchMedia, navigator } = {}) {
  if (navigator?.standalone === true) return true;
  return attempt(() => typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)')?.matches === true) === true;
}

/** iPhone/iPad (including iPadOS reporting as Mac with touch); no manual prompt API there. */
export function isIOS(navigator = {}) {
  const agent = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  if (/\b(?:iPhone|iPad|iPod)\b/.test(agent)) return true;
  return navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints) > 1;
}

/** Which install guidance to show for a snapshot; a key of INSTALL_KEYS. */
export function installGuidanceKey({ standalone, installed, installAvailable, ios, supported } = {}) {
  if (standalone || installed) return INSTALL_KEYS.installed;
  if (installAvailable) return INSTALL_KEYS.prompt;
  if (ios) return INSTALL_KEYS.ios;
  if (!supported) return INSTALL_KEYS.unavailable;
  return INSTALL_KEYS.browser;
}

/** Release ids come from the worker (interp:release); anything else is null. */
export function versionOf(reply) {
  const release = reply?.type === 'interp:release' ? reply.release : null;
  return typeof release === 'string' && VERSION_PATTERN.test(release) ? release : null;
}

/**
 * createPwa({ window, navigator?, document?, isBusy?, setTimeout?, clearTimeout?,
 *   replyTimeoutMs?, autoApply? }) returns { supported, register(), getVersion(),
 * countClients(), applyUpdate(), forceUpdate(), reloadIfPending(), promptInstall(),
 * snapshot(), subscribe(listener), close() }. isBusy() reports whether an
 * interpretation turn or a diagnostic check is running; while it is true no
 * update applies and no unrequested controller change reloads the page.
 * Every method resolves; failures surface as snapshot fields, never as thrown
 * browser errors or logs.
 * autoApply (owner, 2026-09-07; the app turns it on) applies a waiting update
 * without a button press whenever the page is idle and the only tab, and
 * re-checks for updates on registration and each time the page becomes
 * visible, bypassing the HTTP cache for sw.js (updateViaCache: 'none') so a
 * host that caches the worker script (GitHub Pages, 10 minutes) cannot delay
 * it. A running interpretation is never interrupted: busy pages retry when
 * the work ends, exactly as the button path does.
 */
export function createPwa({ window: win, navigator: nav = win?.navigator, isBusy = () => false,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout,
  replyTimeoutMs = PWA_POLICY.replyTimeoutMs, autoApply = false } = {}) {
  if (!win || typeof isBusy !== 'function' || typeof schedule !== 'function' || typeof cancelTimer !== 'function'
    || !Number.isFinite(replyTimeoutMs) || replyTimeoutMs <= 0) throw new Error('INVALID_REQUEST');
  const container = nav?.serviceWorker;
  const supported = Boolean(container && typeof container.register === 'function' && win.isSecureContext !== false);
  const listeners = new Set();
  const removers = [];
  let registration = null, waiting = null, installPrompt = null, requested = false, reloaded = false, closed = false;
  let retryTimer = null;
  const state = { supported, registered: false, standalone: isStandalone({ matchMedia: win.matchMedia?.bind?.(win), navigator: nav }),
    ios: isIOS(nav), installAvailable: false, installed: false, updateAvailable: false, version: null, applying: false,
    reloadPending: false, autoApply: autoApply === true };

  function snapshot() { return Object.freeze({ ...state }); }
  function notify() {
    const current = snapshot();
    for (const listener of [...listeners]) attempt(() => listener(current));
  }
  function listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    removers.push(() => attempt(() => target.removeEventListener(type, handler, options)));
  }
  function setWaiting(worker) {
    waiting = worker ?? null;
    const available = waiting !== null;
    if (available !== state.updateAvailable) { state.updateAvailable = available; notify(); }
    if (available) tryAutoApply();
  }
  // The automatic path is the button path with the same refusals; a refusal
  // only schedules another attempt, so the update is never forced onto a
  // busy page or a page with siblings.
  function tryAutoApply() {
    if (!state.autoApply || closed || !waiting || state.applying || isBusy()) return;
    api.applyUpdate().then((outcome) => {
      if (closed || outcome.result === UPDATE_RESULT.APPLIED || outcome.result === UPDATE_RESULT.NONE
        || outcome.result === UPDATE_RESULT.UNSUPPORTED) return;
      cancelTimer(retryTimer);
      retryTimer = schedule(() => { retryTimer = null; tryAutoApply(); }, PWA_POLICY.autoRetryMs);
      retryTimer?.unref?.();
    }, () => {});
  }
  function checkForUpdate() {
    if (closed || !registration || typeof registration.update !== 'function') return;
    attempt(() => Promise.resolve(registration.update()).catch(() => {}));
  }

  // One request/reply over a MessageChannel; null on timeout, no worker or failure.
  function ask(worker, type) {
    return new Promise((resolve) => {
      const Channel = win.MessageChannel;
      if (!worker || typeof worker.postMessage !== 'function' || typeof Channel !== 'function') { resolve(null); return; }
      let channel, timer, settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cancelTimer(timer);
        if (channel) { channel.port1.onmessage = null; attempt(() => channel.port1.close()); }
        resolve(value);
      };
      try {
        channel = new Channel();
        channel.port1.onmessage = (event) => finish(event?.data ?? null);
        timer = schedule(() => finish(null), replyTimeoutMs);
        worker.postMessage({ type }, [channel.port2]);
      } catch { finish(null); }
    });
  }
  const activeWorker = () => container?.controller ?? registration?.active ?? null;

  // A newly installed worker beside an existing controller is an update.
  function track(worker) {
    if (!worker) return;
    const onState = () => {
      if (worker.state === 'installed' && container.controller) setWaiting(worker);
      else if (worker.state === 'activated' || worker.state === 'redundant') {
        if (waiting === worker) setWaiting(null);
        attempt(() => worker.removeEventListener('statechange', onState));
      }
    };
    listen(worker, 'statechange', onState);
    onState();
  }
  function reload() {
    if (reloaded) return;
    reloaded = true;
    state.reloadPending = false;
    attempt(() => win.location.reload());
  }
  function onControllerChange() {
    if (requested || !isBusy()) { reload(); notify(); return; }
    state.reloadPending = true;
    notify();
  }

  if (supported) {
    listen(container, 'controllerchange', onControllerChange);
  }
  listen(win, 'beforeinstallprompt', (event) => {
    attempt(() => event.preventDefault());
    installPrompt = typeof event?.prompt === 'function' ? event : null;
    state.installAvailable = installPrompt !== null;
    notify();
  });
  listen(win, 'appinstalled', () => {
    installPrompt = null;
    state.installAvailable = false;
    state.installed = true;
    notify();
  });

  const api = {
    supported,
    // Never throws; an unsupported or failed registration leaves registered=false.
    async register() {
      if (!supported || closed) return null;
      try {
        registration = await container.register(WORKER_URL, { scope: WORKER_SCOPE, updateViaCache: 'none' });
      } catch { registration = null; }
      if (!registration || closed) { notify(); return null; }
      state.registered = true;
      listen(registration, 'updatefound', () => track(registration.installing));
      if (registration.waiting) setWaiting(registration.waiting);
      else if (registration.installing) track(registration.installing);
      if (state.autoApply) {
        // Ask the browser for a fresh worker now and whenever the page comes
        // back into view (a phone that was in the pocket during a deploy).
        checkForUpdate();
        listen(win.document, 'visibilitychange', () => { if (win.document?.hidden === false) checkForUpdate(); });
      }
      notify();
      return registration;
    },
    // Release id of the worker serving this page (controller first), or null.
    async getVersion() {
      const version = versionOf(await ask(activeWorker(), 'interp:get-release'));
      if (version !== state.version) { state.version = version; notify(); }
      return version;
    },
    // Window clients as counted by the waiting worker (all tabs of this scope).
    async countClients() {
      const reply = await ask(waiting ?? activeWorker(), 'interp:count-clients');
      const count = reply?.type === 'interp:clients' ? reply.count : null;
      return Number.isInteger(count) && count >= 0 ? count : null;
    },
    // User-initiated (§13.2): refuses while busy or with other tabs open.
    async applyUpdate() {
      if (!supported) return Object.freeze({ result: UPDATE_RESULT.UNSUPPORTED });
      if (!waiting) return Object.freeze({ result: UPDATE_RESULT.NONE });
      if (isBusy()) return Object.freeze({ result: UPDATE_RESULT.ACTIVE });
      if (state.applying) return Object.freeze({ result: UPDATE_RESULT.ACTIVE });
      state.applying = true;
      notify();
      try {
        const count = await api.countClients();
        if (count === null || count !== PWA_POLICY.maxClientsForUpdate) {
          return Object.freeze({ result: UPDATE_RESULT.OTHER_TABS, count });
        }
        // Re-check: a turn may have started while the count was pending.
        if (isBusy() || !waiting) return Object.freeze({ result: waiting ? UPDATE_RESULT.ACTIVE : UPDATE_RESULT.NONE });
        const reply = await ask(waiting, 'interp:apply-update');
        if (reply?.type === 'interp:update-deferred') return Object.freeze({ result: UPDATE_RESULT.OTHER_TABS });
        if (reply?.type !== 'interp:updating') return Object.freeze({ result: UPDATE_RESULT.FAILED });
        requested = true;
        return Object.freeze({ result: UPDATE_RESULT.APPLIED, release: versionOf({ type: 'interp:release', release: reply.release }) });
      } finally {
        state.applying = false;
        notify();
      }
    },
    /**
     * Owner (2026-09-07): the header's "update" button. Asks the browser for a
     * fresh worker now, applies it when one is waiting (same refusals as the
     * button in settings), and otherwise reloads the page so a stale shell
     * cannot outlive a deploy. Resolves { result } from UPDATE_RESULT plus
     * 'reloaded' when nothing was waiting and the page reloads itself.
     */
    async forceUpdate() {
      if (isBusy()) return Object.freeze({ result: UPDATE_RESULT.ACTIVE });
      if (registration && typeof registration.update === 'function') {
        try { await Promise.race([Promise.resolve(registration.update()), new Promise((r) => schedule(r, replyTimeoutMs))]); } catch { /* A failed check is not an error to show. */ }
        if (!waiting && registration.waiting) setWaiting(registration.waiting);
        // The new worker may still be installing: give it the reply window to reach 'installed'.
        if (!waiting && registration.installing) await new Promise((r) => schedule(r, replyTimeoutMs));
      }
      if (waiting) return api.applyUpdate();
      if (!supported) { reload(); return Object.freeze({ result: 'reloaded' }); }
      reload();
      return Object.freeze({ result: 'reloaded' });
    },
    // Called by the app when interpretation ends; reloads a deferred controller change.
    reloadIfPending() {
      // Every idle signal is also the moment a deferred automatic update may go.
      if (!isBusy()) tryAutoApply();
      if (!state.reloadPending || isBusy()) return false;
      reload();
      notify();
      return true;
    },
    // From a user gesture; resolves the outcome ('accepted' | 'dismissed' | null).
    async promptInstall() {
      const prompt = installPrompt;
      if (!prompt) return null;
      installPrompt = null;
      state.installAvailable = false;
      notify();
      let outcome = null;
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        outcome = choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
      } catch { outcome = null; }
      if (outcome === 'accepted') state.installed = true;
      notify();
      return outcome;
    },
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('INVALID_REQUEST');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      cancelTimer(retryTimer); retryTimer = null;
      if (closed) return;
      closed = true;
      for (const remove of removers) remove();
      listeners.clear();
      installPrompt = null;
      waiting = null;
    },
  };
  return Object.freeze(api);
}

/**
 * createPwaControls({ root, document?, i18n, shell, pwa, notify })
 * mounts the install/update controls of the settings app section (§7.4 "앱")
 * into root (settingsView.elements.appActions). notify(key) shows a notice.
 * Returns { element, elements, render, refresh, destroy }.
 */
export function createPwaControls({ root, document: doc = root?.ownerDocument, i18n, shell, pwa, notify = () => {} } = {}) {
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof shell?.onLanguageChange !== 'function'
    || typeof pwa?.subscribe !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  const removers = [];
  const element = (tag, className, attributes = {}) => {
    const node = doc.createElement(tag);
    node.setAttribute('class', className);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const container = element('div', 'pwa-controls');
  const installHint = element('p', 'pwa-install-hint', { role: 'status' });
  const installButton = element('button', 'btn btn-primary pwa-install', { type: 'button' });
  bind.text(installButton, INSTALL_KEYS.prompt);
  const updateHint = element('p', 'pwa-update-hint', { role: 'status', 'aria-live': 'polite' });
  bind.text(updateHint, UPDATE_KEYS.available);
  const updateButton = element('button', 'btn btn-primary pwa-update', { type: 'button' });
  bind.text(updateButton, 'pwa.update');
  container.append(installHint, installButton, updateHint, updateButton);
  root.append(container);

  installButton.addEventListener('click', () => { pwa.promptInstall(); });
  updateButton.addEventListener('click', () => {
    pwa.applyUpdate().then((outcome) => {
      if (outcome.result === UPDATE_RESULT.ACTIVE) notify(UPDATE_KEYS.active);
      else if (outcome.result === UPDATE_RESULT.OTHER_TABS) notify(UPDATE_KEYS.otherTabs);
    }, () => {});
  });

  function render(snapshot = pwa.snapshot()) {
    const key = installGuidanceKey(snapshot);
    installHint.textContent = i18n.t(resolveKey(i18n, key));
    installHint.setAttribute('data-install', key.slice('pwa.'.length));
    installButton.hidden = !snapshot.installAvailable;
    updateHint.hidden = !snapshot.updateAvailable;
    updateButton.hidden = !snapshot.updateAvailable;
    updateButton.disabled = snapshot.applying === true;
  }
  function refresh() { bind.refresh(); render(); }
  removers.push(pwa.subscribe(render));
  removers.push(shell.onLanguageChange(refresh));
  render();

  return Object.freeze({
    element: container,
    elements: Object.freeze({ installHint, installButton, updateHint, updateButton }),
    render,
    refresh,
    destroy() {
      for (const remove of removers) attempt(remove);
      bind.clear();
      container.remove();
    },
  });
}
