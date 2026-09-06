// New implementation of design-v0.6 §7.1 and §12: the common shell. Header
// with app name, provider/key-source badges (never a key value), connection
// state and a settings button; the sequential/simultaneous tabs with the
// simultaneous view and asynchronous cleanup; the notice region that shows
// store notices and clears them; and the settings container P1-16 fills.
// P3-15 (design-p3 §1.9, §1.11; DESIGN.md §4 header): the header order is
// app name | tabs (desktop only) | badges | KO EN JA | display | share |
// settings. The three UI languages are always visible (never an overflow
// menu); pressing one calls the same setLanguage() path the settings dialog
// uses, which changes text, document lang and title only — the interpretation
// pair and any open connection are untouched. On desktop (the 64rem query the
// sequential screen also uses) the tab row moves into the header between the
// title and the badges by moving the real nodes, so DOM, keyboard and visual
// order agree; below that it stays a separate row under the header.
// Importing touches no browser globals; document/window are injected.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { NOTICE_DURATION_MS, keySelectionKeys, resolveKey } from './errors.js';
import { DESKTOP_LAYOUT_QUERY, createBinder, createSeqView } from './seq-view.js';
import { createSimView } from './sim-view.js';
// P3-16: settings, display and share share one modal controller (mutual
// exclusion, inert background, focus trap, Escape, focus return).
import { createSheetGroup } from './sheet.js';

export const TABS = Object.freeze(['sequential', 'simultaneous']);
// P3-02e: simultaneous interpretation is the first screen (owner report
// 2026-09-06); the app remembers the last selected tab through initialTab.
export const DEFAULT_TAB = 'simultaneous';
// Settings targets a caller may ask the dialog to focus (P3-02e: key entry;
// P3-15: the display section, until P3-20 gives the display button its own sheet).
export const SETTINGS_TARGETS = Object.freeze(['key', 'display']);
// Header layouts (P3-15): 'stacked' keeps the tab row under the header,
// 'desktop' places it inside the header. Same query as the sequential screen.
export const SHELL_LAYOUTS = Object.freeze({ STACKED: 'stacked', DESKTOP: 'desktop' });
export const HEADER_LAYOUT_QUERY = DESKTOP_LAYOUT_QUERY;
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/**
 * mount({ root, i18n, engine, document?, window?, setTimeout?, clearTimeout?,
 *   initialTab?, onTabChange? })
 * builds the shell into root and returns { root, elements, seqView, i18n,
 * setLanguage, selectTab, showMessage, openSettings, closeSettings,
 * onSettingsOpen, openDisplay, openShare, closeShare, render, destroy }.
 * P1-19 creates i18n/config/capture/engine first, then mounts; P1-16 renders
 * settings into elements.panels.settingsBody.
 * The caller owns persistence of the UI language (separate from the
 * interpretation pair) and of the selected tab: initialTab is the remembered
 * tab (default: simultaneous) and onTabChange(id) reports later selections.
 * Every UI language change — header toggle, settings select or setLanguage()
 * — ends in onLanguageChange(language), the one place to persist it and to
 * swap the manifest link (P3-15).
 * openSettings(target) opens the dialog and tells onSettingsOpen listeners
 * which part to focus ('key' = the personal key entry, 'display' = the
 * display section); the key badge, the simultaneous view's "open settings"
 * action and the header display button use it.
 * The header layout follows window.matchMedia(HEADER_LAYOUT_QUERY) when the
 * injected window offers it; otherwise the stacked order stands.
 */
export function mount({ root, i18n, engine, document: doc = root?.ownerDocument, window: win = null,
  listenEngines, hubs = [], beforeTabChange, initialTab = DEFAULT_TAB, onTabChange = null,
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
  let noticeShownAt = null, noticeTimer = null, messageTimer = null;

  const app = element(doc, 'div', { className: 'shell' });
  root.append(app);

  // Header (§7.1, P3-15 order): name, [tabs on desktop], provider + key source
  // + connection badges, then the action row: KO EN JA, display, share, settings.
  const header = element(doc, 'header', { className: 'shell-header' });
  const title = element(doc, 'h1', { className: 'shell-title' });
  bind.text(title, 'app.name');
  const badges = element(doc, 'div', { className: 'shell-badges' });
  const providerBadge = element(doc, 'span', { className: 'badge shell-provider' });
  // The key-source badge is a button: "no key" leads straight to the key entry (P3-02e).
  const modeBadge = element(doc, 'button', { className: 'badge shell-mode', attributes: { type: 'button',
    'aria-haspopup': 'dialog', 'aria-controls': 'shell-settings' } });
  const connectionBadge = element(doc, 'span', { className: 'badge shell-connection', attributes: { role: 'status', 'aria-live': 'polite' } });
  badges.append(providerBadge, modeBadge, connectionBadge);
  const actions = element(doc, 'div', { className: 'shell-actions' });
  // UI language toggle: one always-visible pressed button per supported
  // language. The visible text is the language code itself (KO EN JA, the
  // same in every language); the accessible name is the dictionary's language
  // name and each button is tagged with its own lang.
  const languages = element(doc, 'div', { className: 'shell-languages', attributes: { role: 'group' } });
  bind.attribute(languages, 'aria-label', 'language.ui');
  const languageButtons = {};
  for (const code of SUPPORTED_LANGUAGES) {
    const button = element(doc, 'button', { className: 'btn btn-secondary shell-language',
      attributes: { type: 'button', 'aria-pressed': 'false', 'data-language': code, lang: code } });
    button.textContent = code.toUpperCase();
    bind.attribute(button, 'aria-label', `language.${code}`);
    languageButtons[code] = button;
    languages.append(button);
  }
  // Display button (DESIGN.md §10): until P3-20 mounts the display sheet it
  // opens the settings dialog on the display section, so it already works.
  const displayButton = element(doc, 'button', { className: 'btn btn-secondary shell-display-button',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'shell-settings' } });
  bind.text(displayButton, 'display.open');
  const shareButton = element(doc, 'button', { className: 'btn btn-secondary share-button',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'shell-share' } });
  bind.text(shareButton, 'share.open');
  const settingsButton = element(doc, 'button', { className: 'btn btn-secondary shell-settings-button',
    attributes: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'shell-settings' } });
  bind.text(settingsButton, 'common.settings');
  actions.append(languages, displayButton, shareButton, settingsButton);
  header.append(title, badges, actions);

  // Live regions: store notices (dismissable) and short shell messages.
  const notice = element(doc, 'div', { className: 'shell-notice', attributes: { role: 'status', 'aria-live': 'polite' } });
  notice.hidden = true;
  const noticeText = element(doc, 'span', { className: 'shell-notice-text' });
  const noticeClose = element(doc, 'button', { className: 'btn btn-secondary shell-notice-close', attributes: { type: 'button' } });
  bind.text(noticeClose, 'common.close');
  notice.append(noticeText, noticeClose);
  const message = element(doc, 'p', { className: 'shell-message', attributes: { role: 'status', 'aria-live': 'polite' } });
  // P3-21: the first-run host. The app mounts the shared key guide here when a
  // first run has no key to work with; it stays empty and hidden otherwise, and
  // never appears for hub listening, which needs no key at all.
  const firstRun = element(doc, 'div', { className: 'shell-first-run' });
  firstRun.hidden = true;
  message.hidden = true;

  // Tabs: both are live; simultaneous is the first screen unless a tab was remembered.
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
    const previous = selected;
    selected = id;
    for (const tabId of TABS) {
      const active = tabId === id;
      tabButtons[tabId].setAttribute('aria-selected', String(active));
      tabButtons[tabId].setAttribute('tabindex', active ? '0' : '-1');
      panels[tabId].hidden = !active;
    }
    // Only selections after mount are reported; the initial tab is the caller's own value.
    if (previous !== null && previous !== id && typeof onTabChange === 'function') attempt(() => onTabChange(id));
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
  const settings = element(doc, 'section', { className: 'shell-settings sheet', attributes: { id: 'shell-settings', role: 'dialog',
    'aria-modal': 'true', 'aria-labelledby': 'shell-settings-title' } });
  settings.hidden = true;
  const settingsHeader = element(doc, 'div', { className: 'shell-settings-header sheet-header' });
  const settingsTitle = element(doc, 'h2', { className: 'shell-settings-title sheet-title', attributes: { id: 'shell-settings-title' } });
  bind.text(settingsTitle, 'common.settings');
  const settingsClose = element(doc, 'button', { className: 'btn btn-secondary shell-settings-close', attributes: { type: 'button' } });
  bind.text(settingsClose, 'common.close');
  settingsHeader.append(settingsTitle, settingsClose);
  const settingsBody = element(doc, 'div', { className: 'shell-settings-body sheet-body' });
  settings.append(settingsHeader, settingsBody);
  const inertTargets = [header, notice, message, firstRun, tabs, main];
  const settingsOpenListeners = new Set();
  // One group for every modal surface of the shell: opening one closes the
  // others, the background is inert only while something is open, and focus
  // returns to whatever had it before (P3-16).
  const sheetGroup = createSheetGroup({ document: doc, background: inertTargets });
  const settingsCloseListeners = new Set();
  const settingsSheet = sheetGroup.register({ id: 'shell-settings', element: settings,
    openers: [settingsButton, modeBadge], initialFocus: settingsClose,
    // P3-22: leaving the settings screen must hide a revealed personal key,
    // however it was left (the close button, Escape, or another sheet opening).
    onClose() { for (const listener of [...settingsCloseListeners]) attempt(() => listener()); },
    // Notified after focus landed on the close button, so a listener that wants
    // a specific entry (P3-02e 'key') wins over the default focus.
    onOpened(target) {
      if (target) for (const listener of [...settingsOpenListeners]) attempt(() => listener(target));
    } });

  // target ('key') asks the mounted settings view (through onSettingsOpen) to
  // focus that entry; an already open dialog still forwards the target.
  function openSettings(target = null) {
    settingsSheet.open(SETTINGS_TARGETS.includes(target) ? target : null);
  }
  function closeSettings() { settingsSheet.close(); }

  // P3-20: the header's display entry point is its own sheet, not a jump into
  // the settings dialog. The controls inside are mounted by the app into
  // displayBody and are the SAME component the settings screen mounts, driven
  // by one appearance state, so the two entry points cannot disagree.
  const display = element(doc, 'section', { className: 'shell-display sheet', attributes: { id: 'shell-display',
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shell-display-title' } });
  const displayHeader = element(doc, 'div', { className: 'shell-display-header sheet-header' });
  const displayTitle = element(doc, 'h2', { className: 'sheet-title', attributes: { id: 'shell-display-title' } });
  bind.text(displayTitle, 'display.title');
  const displayClose = element(doc, 'button', { className: 'btn btn-secondary shell-display-close', attributes: { type: 'button' } });
  bind.text(displayClose, 'common.close');
  displayHeader.append(displayTitle, displayClose);
  const displayBody = element(doc, 'div', { className: 'shell-display-body sheet-body' });
  display.append(displayHeader, displayBody);
  const displaySheet = sheetGroup.register({ id: 'shell-display', element: display,
    openers: [displayButton], initialFocus: displayClose });
  function openDisplay() { displaySheet.open(); }
  function closeDisplay() { displaySheet.close(); }

  listen(settingsButton, 'click', () => openSettings());
  listen(modeBadge, 'click', () => openSettings('key'));
  listen(displayButton, 'click', openDisplay);
  listen(displayClose, 'click', closeDisplay);
  listen(settingsClose, 'click', closeSettings);

  // P2-25: new UI implementation; no translation, Live or QR generation code is ported.
  const share = element(doc, 'section', { className: 'share-dialog sheet', attributes: {
    id: 'shell-share', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title' } });
  share.hidden = true;
  const shareHeader = element(doc, 'div', { className: 'share-header sheet-header' });
  const shareTitle = element(doc, 'h2', { className: 'sheet-title', attributes: { id: 'share-title' } });
  bind.text(shareTitle, 'share.title');
  const shareClose = element(doc, 'button', { className: 'btn btn-secondary share-close', attributes: { type: 'button' } });
  bind.text(shareClose, 'share.close');
  shareHeader.append(shareTitle, shareClose);
  const shareImage = element(doc, 'img', { className: 'share-image', attributes: { width: '720', height: '720' } });
  bind.attribute(shareImage, 'alt', 'share.imageAlt');
  const shareImageHost = element(doc, 'div', { className: 'share-image-host' });
  const shareURL = element(doc, 'textarea', { className: 'share-url', attributes: { readonly: '', rows: '2' } });
  bind.attribute(shareURL, 'aria-label', 'share.urlLabel');
  const shareCopy = element(doc, 'button', { className: 'btn btn-primary share-copy', attributes: { type: 'button' } });
  bind.text(shareCopy, 'share.copy');
  const shareHint = element(doc, 'p');
  bind.text(shareHint, 'share.hint');
  const shareDeployment = element(doc, 'p', { className: 'share-deployment' });
  bind.text(shareDeployment, 'share.deployment');
  const shareStatus = element(doc, 'p', { attributes: { role: 'status', 'aria-live': 'polite' } });
  // P3-16: the sheet contract — a fixed title row, a scrolling body and a
  // sticky action row. The copy action is the only thing in the footer, so it
  // stays reachable on a small screen without scrolling the QR out of the way.
  const shareBody = element(doc, 'div', { className: 'sheet-body' });
  shareBody.append(shareImageHost, shareURL, shareHint, shareDeployment, shareStatus);
  const shareFooter = element(doc, 'div', { className: 'sheet-footer' });
  shareFooter.append(shareCopy);
  share.append(shareHeader, shareBody, shareFooter);
  let shareEpoch = 0, shareStatusKey = null;
  // P3-16: the modal mechanics move to the sheet group; the P2-25 URL, QR and
  // clipboard behaviour below is unchanged, only relocated into onOpen/onClose.
  const shareSheet = sheetGroup.register({ id: 'shell-share', element: share,
    openers: [shareButton], initialFocus: shareClose,
    onOpen() {
      if (destroyed) return false;
      // Only origin and pathname are read: query/fragment credentials never enter the UI or clipboard.
      const location = win?.location ?? doc.defaultView?.location;
      let path = location?.pathname ?? '/';
      path = path.replace(/\/releases\/[^/]+(?:\/.*)?$/, '/').replace(/\/index\.html$/, '/');
      if (!path.endsWith('/')) path += '/';
      shareURL.value = `${location?.origin ?? ''}${path}`;
      shareImage.setAttribute('src', `${path}icons/qr-site.png`);
      shareImageHost.append(shareImage);
      shareDeployment.hidden = location?.hostname === 'gai-cmd.github.io' && location?.protocol === 'https:' && path === '/interp-app/';
      shareStatusKey = null;
      shareStatus.textContent = '';
      return true;
    },
    onClose() { shareEpoch++; shareImage.remove(); } });
  function openShare() { shareSheet.open(); }
  function closeShare() { shareSheet.close(); }
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

  app.append(header, notice, message, firstRun, tabs, main, settings, display, share);

  // Header layout (P3-15). Desktop puts the tab row inside the header between
  // the title and the badges; below 64rem it is its own row under the header
  // (design-p3 §1.9). Real nodes move (no CSS order), and a focused tab keeps
  // focus across the move as in the sequential screen.
  let layout = null;
  function applyLayout(desktop) {
    const next = desktop ? SHELL_LAYOUTS.DESKTOP : SHELL_LAYOUTS.STACKED;
    if (next === layout) return layout;
    const active = doc.activeElement;
    layout = next;
    app.setAttribute('data-layout', layout);
    if (desktop) {
      header.append(title, tabs, badges, actions);
      app.append(header, notice, message, firstRun, main, settings, display, share);
    } else {
      header.append(title, badges, actions);
      app.append(header, notice, message, firstRun, tabs, main, settings, display, share);
    }
    if (active && active !== doc.activeElement && attempt(() => app.contains(active))) attempt(() => active.focus());
    return layout;
  }
  // Only the injected window's matchMedia is used (the sequential view owns
  // the document's); without it the stacked order stands.
  const media = attempt(() => win?.matchMedia?.(HEADER_LAYOUT_QUERY)) ?? null;
  const onMediaChange = (event) => applyLayout((event?.matches ?? media?.matches) === true);
  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onMediaChange);
      removers.push(() => attempt(() => media.removeEventListener('change', onMediaChange)));
    } else if (typeof media.addListener === 'function') {
      media.addListener(onMediaChange);
      removers.push(() => attempt(() => media.removeListener?.(onMediaChange)));
    }
  }
  applyLayout(media?.matches === true);

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
    document: doc, onSequential: () => switchTab('sequential'), onOpenSettings: () => openSettings('key') }) : null;
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
    for (const code of SUPPORTED_LANGUAGES) languageButtons[code].setAttribute('aria-pressed', String(code === i18n.language));
    if (shareStatusKey) shareStatus.textContent = i18n.t(shareStatusKey);
    seqView.refresh();
    simView?.refresh();
    render(snapshot);
    for (const listener of [...languageListeners]) attempt(() => listener(i18n.language));
  }
  // UI language only (§12): the interpretation pair stays in the store and
  // nothing about an open session is touched; the pressed button is a no-op.
  function setLanguage(language) {
    i18n.setLanguage(language);
    applyLanguage();
    return i18n.language;
  }
  for (const code of SUPPORTED_LANGUAGES) {
    listen(languageButtons[code], 'click', () => { if (code !== i18n.language) setLanguage(code); });
  }
  applyLanguage();
  selectTab(TABS.includes(initialTab) ? initialTab : DEFAULT_TAB);

  return Object.freeze({
    root: app,
    i18n,
    seqView, simView,
    elements: Object.freeze({ header, providerBadge, modeBadge, connectionBadge, settingsButton, notice, noticeClose, message, firstRun,
      tabs, tabButtons: Object.freeze({ ...tabButtons }),
      // P3-15: the action row, the language toggle and the display/share entry points.
      actions, languages, languageButtons: Object.freeze({ ...languageButtons }), displayButton, shareButton,
      panels: Object.freeze({ sequential: panels.sequential, simultaneous: panels.simultaneous, settings, settingsBody, settingsClose,
        display, displayBody, displayClose,
        share, shareClose, shareURL, shareCopy, shareStatus, shareImage, shareDeployment }) }),
    get selectedTab() { return selected; },
    get settingsOpen() { return !settings.hidden; },
    get shareOpen() { return !share.hidden; },
    get displayOpen() { return !display.hidden; },
    get layout() { return layout; },
    setLanguage,
    onLanguageChange(listener) {
      if (typeof listener !== 'function') throw new Error('INVALID_REQUEST');
      languageListeners.add(listener);
      return () => languageListeners.delete(listener);
    },
    selectTab, switchTab,
    showMessage,
    openSettings,
    closeSettings,
    onSettingsOpen(listener) {
      if (typeof listener !== 'function') throw new Error('INVALID_REQUEST');
      settingsOpenListeners.add(listener);
      return () => settingsOpenListeners.delete(listener);
    },
    onSettingsClose(listener) {
      if (typeof listener !== 'function') throw new Error('INVALID_REQUEST');
      settingsCloseListeners.add(listener);
      return () => settingsCloseListeners.delete(listener);
    },
    openDisplay, closeDisplay,
    openShare, closeShare,
    render,
    destroy() {
      destroyed = true; transition++;
      // Before anything else: no sheet, and no inert background, survives a teardown.
      sheetGroup.destroy();
      simView?.destroy();
      unsubscribe();
      cancelTimer(noticeTimer);
      cancelTimer(messageTimer);
      for (const remove of removers) remove();
      languageListeners.clear();
      settingsOpenListeners.clear();
      settingsCloseListeners.clear();
      seqView.destroy();
      bind.clear();
      app.remove();
    },
  });
}
