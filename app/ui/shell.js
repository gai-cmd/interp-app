// New implementation of design-v0.6 §7.1 and §12: the common shell. Header
// with app name, provider/key-source badges (never a key value), connection
// state and a settings button; the sequential/simultaneous tabs with the
// simultaneous view and asynchronous cleanup; the notice region that shows
// store notices and clears them; and the settings container P1-16 fills.
// Importing touches no browser globals; document/window are injected.
import { NOTICE_DURATION_MS, keySelectionKeys, resolveKey } from './errors.js';
import { createBinder, createSeqView } from './seq-view.js';
import { createSimView } from './sim-view.js';

export const TABS = Object.freeze(['sequential', 'simultaneous']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/**
 * mount({ root, i18n, engine, document?, window?, setTimeout?, clearTimeout? })
 * builds the shell into root and returns { root, elements, seqView, i18n,
 * setLanguage, selectTab, showMessage, openSettings, closeSettings, render,
 * destroy }. P1-19 creates i18n/config/capture/engine first, then mounts;
 * P1-16 renders settings into elements.panels.settingsBody. The caller owns
 * persistence of the UI language (separate from the interpretation pair).
 */
export function mount({ root, i18n, engine, document: doc = root?.ownerDocument, window: win = null,
  listenEngines, hubs = [], beforeTabChange,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout } = {}) {
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof engine?.state?.subscribe !== 'function') {
    throw new Error('INVALID_REQUEST');
  }
  const store = engine.state;
  const bind = createBinder(i18n);
  const removers = [];
  const listen = (target, type, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    removers.push(() => attempt(() => target.removeEventListener(type, handler)));
  };
  let snapshot = store.snapshot();
  let noticeShownAt = null, noticeTimer = null, messageTimer = null, restoreFocus = null;

  const app = element(doc, 'div', { className: 'shell' });
  root.append(app);

  // Header (§7.1): name, provider + key source, connection, settings.
  const header = element(doc, 'header', { className: 'shell-header' });
  const title = element(doc, 'h1', { className: 'shell-title' });
  bind.text(title, 'app.name');
  const badges = element(doc, 'div', { className: 'shell-badges' });
  const providerBadge = element(doc, 'span', { className: 'badge shell-provider' });
  const modeBadge = element(doc, 'span', { className: 'badge shell-mode' });
  const connectionBadge = element(doc, 'span', { className: 'badge shell-connection', attributes: { role: 'status', 'aria-live': 'polite' } });
  badges.append(providerBadge, modeBadge, connectionBadge);
  const settingsButton = element(doc, 'button', { className: 'btn btn-secondary shell-settings-button',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'shell-settings' } });
  bind.text(settingsButton, 'common.settings');
  const shareButton = element(doc, 'button', { className: 'btn btn-secondary share-button',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'shell-share' } });
  bind.text(shareButton, 'share.open');
  header.append(title, badges, shareButton, settingsButton);

  // Live regions: store notices (dismissable) and short shell messages.
  const notice = element(doc, 'div', { className: 'shell-notice', attributes: { role: 'status', 'aria-live': 'polite' } });
  notice.hidden = true;
  const noticeText = element(doc, 'span', { className: 'shell-notice-text' });
  const noticeClose = element(doc, 'button', { className: 'btn btn-secondary shell-notice-close', attributes: { type: 'button' } });
  bind.text(noticeClose, 'common.close');
  notice.append(noticeText, noticeClose);
  const message = element(doc, 'p', { className: 'shell-message', attributes: { role: 'status', 'aria-live': 'polite' } });
  message.hidden = true;

  // Tabs: sequential is live; simultaneous is displayed as planned and blocked.
  const tabs = element(doc, 'nav', { className: 'shell-tabs', attributes: { role: 'tablist' } });
  const tabButtons = {};
  const panels = {};
  for (const id of TABS) {
    const tab = element(doc, 'button', { className: 'shell-tab', attributes: { type: 'button', role: 'tab', id: `tab-${id}`,
      'aria-controls': `panel-${id}`, 'aria-selected': 'false', tabindex: '-1' } });
    bind.text(tab, `tabs.${id}`);
    const panel = element(doc, 'section', { className: `shell-panel panel-${id}`, attributes: { role: 'tabpanel', id: `panel-${id}`,
      'aria-labelledby': `tab-${id}`, tabindex: '0' } });
    panel.hidden = true;
    tabButtons[id] = tab;
    panels[id] = panel;
    tabs.append(tab);
  }
  const main = element(doc, 'main', { className: 'shell-main' });
  main.append(panels.sequential, panels.simultaneous);

  let selected = null, transition = 0, destroyed = false;
  function selectTab(id) {
    if (!TABS.includes(id)) return selected;
    if (destroyed) return selected;
    if (beforeTabChange && selected !== null && id !== selected) {
      void switchTab(id);
      return selected;
    }
    transition++;
    return applyTab(id);
  }
  function applyTab(id) {
    selected = id;
    for (const tabId of TABS) {
      const active = tabId === id;
      tabButtons[tabId].setAttribute('aria-selected', String(active));
      tabButtons[tabId].setAttribute('tabindex', active ? '0' : '-1');
      panels[tabId].hidden = !active;
    }
    return selected;
  }
  // selectTab retains its synchronous selected-id contract. Await switchTab
  // when the caller needs physical cleanup and the final selection.
  async function switchTab(id) {
    if (!TABS.includes(id) || destroyed) return selected;
    const epoch = ++transition;
    try {
      await beforeTabChange?.(id);
      if (!destroyed && epoch === transition) {
        applyTab(id);
        tabButtons[id].focus();
      }
    } catch { if (!destroyed && epoch === transition) showMessage('error.SESSION_CLOSED'); }
    return selected;
  }
  for (const id of TABS) {
    listen(tabButtons[id], 'click', () => selectTab(id));
    listen(tabButtons[id], 'keydown', (event) => {
      const index = TABS.indexOf(id);
      const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length] : null;
      if (!next) return;
      event.preventDefault?.();
      attempt(() => tabButtons[next].focus());
    });
  }

  // Settings container (§7.4 content is P1-16); modal with focus return.
  const settings = element(doc, 'section', { className: 'shell-settings', attributes: { id: 'shell-settings', role: 'dialog',
    'aria-modal': 'true', 'aria-labelledby': 'shell-settings-title' } });
  settings.hidden = true;
  const settingsHeader = element(doc, 'div', { className: 'shell-settings-header' });
  const settingsTitle = element(doc, 'h2', { className: 'shell-settings-title', attributes: { id: 'shell-settings-title' } });
  bind.text(settingsTitle, 'common.settings');
  const settingsClose = element(doc, 'button', { className: 'btn btn-secondary shell-settings-close', attributes: { type: 'button' } });
  bind.text(settingsClose, 'common.close');
  settingsHeader.append(settingsTitle, settingsClose);
  const settingsBody = element(doc, 'div', { className: 'shell-settings-body' });
  settings.append(settingsHeader, settingsBody);
  const inertTargets = [header, notice, message, tabs, main];

  function openSettings() {
    if (!settings.hidden) return;
    closeShare();
    restoreFocus = doc.activeElement ?? settingsButton;
    settings.hidden = false;
    settingsButton.setAttribute('aria-expanded', 'true');
    for (const target of inertTargets) target.setAttribute('inert', '');
    attempt(() => settingsClose.focus());
  }
  function closeSettings() {
    if (settings.hidden) return;
    settings.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false');
    for (const target of inertTargets) target.removeAttribute('inert');
    const target = restoreFocus;
    restoreFocus = null;
    attempt(() => (target ?? settingsButton).focus());
  }
  listen(settingsButton, 'click', openSettings);
  listen(settingsClose, 'click', closeSettings);
  listen(settings, 'keydown', (event) => { if (event.key === 'Escape') { event.preventDefault?.(); closeSettings(); } });

  // P2-25: new UI implementation; no translation, Live or QR generation code is ported.
  const share = element(doc, 'section', { className: 'share-dialog', attributes: {
    id: 'shell-share', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title' } });
  share.hidden = true;
  const shareHeader = element(doc, 'div', { className: 'share-header' });
  const shareTitle = element(doc, 'h2', { attributes: { id: 'share-title' } });
  bind.text(shareTitle, 'share.title');
  const shareClose = element(doc, 'button', { className: 'btn btn-secondary share-close', attributes: { type: 'button' } });
  bind.text(shareClose, 'share.close');
  shareHeader.append(shareTitle, shareClose);
  const shareImage = element(doc, 'img', { className: 'share-image', attributes: { width: '720', height: '720' } });
  bind.attribute(shareImage, 'alt', 'share.imageAlt');
  const shareURL = element(doc, 'textarea', { className: 'share-url', attributes: { readonly: '', rows: '2' } });
  bind.attribute(shareURL, 'aria-label', 'share.urlLabel');
  const shareCopy = element(doc, 'button', { className: 'btn btn-primary share-copy', attributes: { type: 'button' } });
  bind.text(shareCopy, 'share.copy');
  const shareHint = element(doc, 'p');
  bind.text(shareHint, 'share.hint');
  const shareDeployment = element(doc, 'p', { className: 'share-deployment' });
  bind.text(shareDeployment, 'share.deployment');
  const shareStatus = element(doc, 'p', { attributes: { role: 'status', 'aria-live': 'polite' } });
  share.append(shareHeader, shareImage, shareURL, shareCopy, shareHint, shareDeployment, shareStatus);
  let shareFocus = null, shareEpoch = 0, shareStatusKey = null;
  function openShare() {
    if (destroyed || !share.hidden) return;
    closeSettings();
    shareFocus = doc.activeElement ?? shareButton;
    // Only origin and pathname are read: query/fragment credentials never enter the UI or clipboard.
    const location = win?.location ?? doc.defaultView?.location;
    let path = location?.pathname ?? '/';
    path = path.replace(/\/releases\/[^/]+(?:\/.*)?$/, '/').replace(/\/index\.html$/, '/');
    if (!path.endsWith('/')) path += '/';
    shareURL.value = `${location?.origin ?? ''}${path}`;
    shareImage.setAttribute('src', `${path}icons/qr-site.png`);
    shareDeployment.hidden = shareURL.value === 'https://gai-cmd.github.io/interp-app/';
    shareStatusKey = null;
    shareStatus.textContent = '';
    share.hidden = false;
    shareButton.setAttribute('aria-expanded', 'true');
    for (const target of inertTargets) target.setAttribute('inert', '');
    attempt(() => shareClose.focus());
  }
  function closeShare() {
    if (share.hidden) return;
    shareEpoch++;
    share.hidden = true;
    shareButton.setAttribute('aria-expanded', 'false');
    for (const target of inertTargets) target.removeAttribute('inert');
    attempt(() => (shareFocus ?? shareButton).focus());
    shareFocus = null;
  }
  listen(shareButton, 'click', openShare);
  listen(shareClose, 'click', closeShare);
  listen(shareCopy, 'click', async () => {
    const epoch = ++shareEpoch;
    let key = 'share.copied';
    try {
      const clipboard = (win ?? doc.defaultView)?.navigator?.clipboard;
      if (typeof clipboard?.writeText !== 'function') throw 0;
      await clipboard.writeText(shareURL.value);
    } catch { key = 'share.copyFailed'; }
    if (destroyed || share.hidden || epoch !== shareEpoch) return;
    shareStatusKey = key;
    shareStatus.textContent = i18n.t(key);
    if (key === 'share.copyFailed') attempt(() => { shareURL.focus(); shareURL.select(); });
  });
  listen(share, 'keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault?.(); closeShare(); }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && doc.activeElement === shareClose) {
      event.preventDefault?.(); shareCopy.focus();
    } else if (!event.shiftKey && doc.activeElement === shareCopy) {
      event.preventDefault?.(); shareClose.focus();
    }
  });

  app.append(header, notice, message, tabs, main, settings, share);

  // Short shell-level messages (e.g. blocked tab); auto-clear.
  function showMessage(key) {
    message.textContent = i18n.t(resolveKey(i18n, key));
    message.hidden = false;
    cancelTimer(messageTimer);
    messageTimer = schedule(() => { message.hidden = true; message.textContent = ''; }, NOTICE_DURATION_MS);
  }

  // Store notices are displayed here, then cleared by the UI (P1-14 contract).
  function clearNotice() {
    cancelTimer(noticeTimer);
    noticeTimer = null;
    if (snapshot.notice !== null) attempt(() => store.setNotice(null));
  }
  listen(noticeClose, 'click', clearNotice);
  function renderNotice() {
    const current = snapshot.notice;
    if (!current) {
      notice.hidden = true;
      noticeText.textContent = '';
      noticeShownAt = null;
      cancelTimer(noticeTimer);
      noticeTimer = null;
      return;
    }
    noticeText.textContent = i18n.t(resolveKey(i18n, current.messageKey));
    notice.hidden = false;
    if (noticeShownAt === current.at) return;
    noticeShownAt = current.at;
    cancelTimer(noticeTimer);
    noticeTimer = schedule(clearNotice, NOTICE_DURATION_MS);
  }

  function renderConnection() {
    const offline = win?.navigator?.onLine === false;
    const sessionOpen = attempt(() => engine.snapshot?.()?.voice?.sessionOpen) === true;
    const key = offline ? 'connection.offline' : sessionOpen ? 'connection.connected' : null;
    connectionBadge.hidden = key === null;
    connectionBadge.textContent = key ? i18n.t(key) : '';
    connectionBadge.setAttribute('data-connection', offline ? 'offline' : sessionOpen ? 'connected' : 'idle');
  }

  function render(next = store.snapshot()) {
    snapshot = next;
    const { providerKey, modeKey } = keySelectionKeys(snapshot.keySelection);
    providerBadge.hidden = providerKey === null;
    providerBadge.textContent = providerKey ? i18n.t(resolveKey(i18n, providerKey, 'common.unknown')) : '';
    modeBadge.textContent = i18n.t(resolveKey(i18n, modeKey));
    modeBadge.setAttribute('data-key-source', snapshot.keySelection?.keySource ?? 'none');
    renderConnection();
    renderNotice();
  }

  const seqView = createSeqView({ root: panels.sequential, i18n, engine, document: doc });
  const simView = listenEngines ? createSimView({ root: panels.simultaneous, i18n, engines: listenEngines, hubs,
    document: doc, onSequential: () => switchTab('sequential') }) : null;
  const unsubscribe = store.subscribe(render);
  removers.push(engine.subscribeVoice?.(renderConnection) ?? (() => {}));
  listen(win, 'online', renderConnection);
  listen(win, 'offline', renderConnection);
  // Leaving the page ends the active turn so no late audio plays on return.
  listen(win, 'pagehide', () => attempt(() => engine.cancel()));

  // Views mounted later (P1-16 settings/diagnostics) refresh through this hook.
  const languageListeners = new Set();
  function applyLanguage() {
    if (doc.documentElement) doc.documentElement.setAttribute('lang', i18n.language);
    doc.title = i18n.t('app.name');
    bind.refresh();
    if (shareStatusKey) shareStatus.textContent = i18n.t(shareStatusKey);
    seqView.refresh();
    simView?.refresh();
    render(snapshot);
    for (const listener of [...languageListeners]) attempt(() => listener(i18n.language));
  }
  applyLanguage();
  selectTab('sequential');

  return Object.freeze({
    root: app,
    i18n,
    seqView, simView,
    elements: Object.freeze({ header, providerBadge, modeBadge, connectionBadge, settingsButton, notice, noticeClose, message,
      tabs, tabButtons: Object.freeze({ ...tabButtons }),
      panels: Object.freeze({ sequential: panels.sequential, simultaneous: panels.simultaneous, settings, settingsBody, settingsClose }) }),
    get selectedTab() { return selected; },
    get settingsOpen() { return !settings.hidden; },
    // UI language only; the interpretation pair lives in the store.
    setLanguage(language) { i18n.setLanguage(language); applyLanguage(); return i18n.language; },
    onLanguageChange(listener) {
      if (typeof listener !== 'function') throw new Error('INVALID_REQUEST');
      languageListeners.add(listener);
      return () => languageListeners.delete(listener);
    },
    selectTab, switchTab,
    showMessage,
    openSettings,
    closeSettings,
    openShare, closeShare,
    render,
    destroy() {
      destroyed = true; transition++;
      simView?.destroy();
      unsubscribe();
      cancelTimer(noticeTimer);
      cancelTimer(messageTimer);
      for (const remove of removers) remove();
      languageListeners.clear();
      seqView.destroy();
      bind.clear();
      app.remove();
    },
  });
}
