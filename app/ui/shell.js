// New implementation of design-v0.6 §7.1 and §12: the common shell. Header
// with app name, provider/key-source badges (never a key value), connection
// state and a settings button; the sequential/simultaneous tabs with the
// simultaneous tab blocked as planned (P2); the notice region that shows
// store notices and clears them; and the settings container P1-16 fills.
// Importing touches no browser globals; document/window are injected.
import { NOTICE_DURATION_MS, keySelectionKeys, resolveKey } from './errors.js';
import { createBinder, createSeqView } from './seq-view.js';

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
  header.append(title, badges, settingsButton);

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
  tabButtons.simultaneous.setAttribute('aria-disabled', 'true');
  const planned = element(doc, 'p', { className: 'shell-planned' });
  bind.text(planned, 'tabs.simultaneousPending');
  panels.simultaneous.append(planned);
  const main = element(doc, 'main', { className: 'shell-main' });
  main.append(panels.sequential, panels.simultaneous);

  let selected = null;
  function selectTab(id) {
    if (!TABS.includes(id)) return selected;
    // P2 feature: keep the current tab and explain instead of running anything.
    if (tabButtons[id].getAttribute('aria-disabled') === 'true') { showMessage('tabs.simultaneousPending'); return selected; }
    selected = id;
    for (const tabId of TABS) {
      const active = tabId === id;
      tabButtons[tabId].setAttribute('aria-selected', String(active));
      tabButtons[tabId].setAttribute('tabindex', active ? '0' : '-1');
      panels[tabId].hidden = !active;
    }
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

  app.append(header, notice, message, tabs, main, settings);

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
    seqView.refresh();
    render(snapshot);
    for (const listener of [...languageListeners]) attempt(() => listener(i18n.language));
  }
  applyLanguage();
  selectTab('sequential');

  return Object.freeze({
    root: app,
    i18n,
    seqView,
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
    selectTab,
    showMessage,
    openSettings,
    closeSettings,
    render,
    destroy() {
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
