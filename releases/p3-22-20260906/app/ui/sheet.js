// Shared modal behaviour for the settings, display and share surfaces
// (design-p3 §1.9 "모바일 시트·데스크톱 모달", DESIGN.md §9).
//
// One group owns all sheets of a screen so that opening one closes the others
// (§1.9 "설정·화면·공유 시트는 상호 배타적으로 연다"). A group only moves
// focus, the `inert` attribute and `hidden`; it never touches the engine, the
// microphone or any session, so opening a sheet cannot stop an interpretation.
//
// The focus order is read from the live tree at every Tab, so a sheet whose
// content appears later (a settings section, a copy button that only exists
// after a policy loads) traps correctly without re-registering.
//
// The DOM surface used here is deliberately small (childNodes, hidden,
// get/set/removeAttribute, focus, contains) so the same code runs against the
// browser and the test document double.

/** Elements that take focus by default, in DOM order. */
const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'SUMMARY']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

function focusable(node) {
  if (!node || node.nodeType === 3) return false;
  if (node.hidden || node.disabled === true) return false;
  if (node.hasAttribute?.('inert') || node.getAttribute?.('aria-hidden') === 'true') return false;
  const index = node.getAttribute?.('tabindex');
  if (index !== null && index !== undefined) return Number(index) >= 0;
  if (!FOCUSABLE_TAGS.has(node.tagName)) return false;
  return node.tagName !== 'A' || node.hasAttribute?.('href');
}
/** Focusable descendants in DOM order; a hidden subtree is skipped entirely. */
export function focusableWithin(root, out = []) {
  for (const child of root?.childNodes ?? []) {
    if (child.hidden || child.hasAttribute?.('inert')) continue;
    if (focusable(child)) out.push(child);
    focusableWithin(child, out);
  }
  return out;
}

/**
 * createSheetGroup({ document, background, onChange })
 *
 * `background` are the nodes marked `inert` while any sheet is open — the
 * header, notice, message, tabs and main region. They are always restored on
 * close and on destroy(), so no sheet can leave the page inert.
 *
 * register({ element, openers, initialFocus, restoreTo, onOpen, onClose, id })
 * returns a frozen { id, element, open(detail), close(), isOpen }.
 * - `openers` get aria-expanded true/false and are the focus of last resort.
 * - `initialFocus` (node or function) receives focus when the sheet opens;
 *   without it the first focusable element in the sheet does.
 * - `onOpen(detail)` runs while the sheet is already visible but before focus
 *   moves, so it may add or hide content and the focus trap will see it.
 *   Returning false aborts the open and restores the previous state.
 * - `onOpened(detail)` runs after focus landed, so a listener may move focus
 *   somewhere more useful than the default (P3-02e: the personal key entry).
 * - `onClose()` runs after the sheet is hidden and before focus returns.
 *
 * Escape closes the sheet and Tab/Shift+Tab wrap inside it. Both are handled on
 * the sheet element itself, so a keystroke outside never closes a sheet.
 */
export function createSheetGroup({ document: doc, background = [], onChange = () => {} } = {}) {
  if (!doc) throw new TypeError('createSheetGroup requires a document');
  const sheets = new Map();
  let open = null, restoreFocus = null, destroyed = false;

  const applyBackground = (inert) => {
    for (const node of background) {
      if (inert) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
    }
  };
  const expand = (entry, value) => {
    for (const opener of entry.openers) opener.setAttribute?.('aria-expanded', value ? 'true' : 'false');
  };
  const announce = () => attempt(() => onChange(open ? open.id : null));

  function focusInto(entry) {
    const wanted = typeof entry.initialFocus === 'function' ? attempt(entry.initialFocus) : entry.initialFocus;
    const target = wanted ?? focusableWithin(entry.element)[0] ?? entry.element;
    attempt(() => target.focus());
  }

  function close(entry, { restore = true, silent = false } = {}) {
    if (!entry || open !== entry) return false;
    open = null;
    entry.element.hidden = true;
    expand(entry, false);
    applyBackground(false);
    attempt(() => entry.onClose?.());
    const target = restoreFocus;
    restoreFocus = null;
    if (restore) attempt(() => (target ?? entry.restoreTo ?? entry.openers[0])?.focus());
    // A swap is one change, not a close followed by an open: onChange must not
    // see a moment where nothing is open.
    if (!silent) announce();
    return true;
  }

  function openSheet(entry, detail) {
    if (destroyed) return false;
    if (open === entry) {
      // An already open sheet still forwards the detail (P3-02e: a second press
      // of a different opener asks for another section) without resetting focus
      // to the top of the sheet.
      attempt(() => entry.onOpen?.(detail, { reopened: true }));
      attempt(() => entry.onOpened?.(detail, { reopened: true }));
      return true;
    }
    const previous = open;
    const keepFocus = previous ? restoreFocus : (doc.activeElement ?? entry.openers[0] ?? null);
    if (previous) close(previous, { restore: false, silent: true });
    restoreFocus = keepFocus;
    open = entry;
    entry.element.hidden = false;
    expand(entry, true);
    applyBackground(true);
    if (attempt(() => entry.onOpen?.(detail, { reopened: false })) === false) { close(entry); return false; }
    focusInto(entry);
    attempt(() => entry.onOpened?.(detail, { reopened: false }));
    announce();
    return true;
  }

  function keydown(entry, event) {
    if (open !== entry) return;
    if (event.key === 'Escape') { event.preventDefault?.(); close(entry); return; }
    if (event.key !== 'Tab') return;
    const order = focusableWithin(entry.element);
    if (order.length === 0) return;
    const active = doc.activeElement;
    const at = order.indexOf(active);
    // Focus that escaped the sheet (or never entered it) is pulled back to the
    // edge the keystroke is heading for, so the trap has no gap.
    if (at === -1) { event.preventDefault?.(); attempt(() => (event.shiftKey ? order.at(-1) : order[0]).focus()); return; }
    if (event.shiftKey && at === 0) { event.preventDefault?.(); attempt(() => order.at(-1).focus()); }
    else if (!event.shiftKey && at === order.length - 1) { event.preventDefault?.(); attempt(() => order[0].focus()); }
  }

  return Object.freeze({
    register({ id, element, openers = [], initialFocus = null, restoreTo = null,
      onOpen = null, onOpened = null, onClose = null } = {}) {
      if (!element) throw new TypeError('a sheet needs an element');
      const key = id ?? element.getAttribute?.('id') ?? `sheet-${sheets.size + 1}`;
      const entry = { id: key, element, openers, initialFocus, restoreTo, onOpen, onOpened, onClose };
      sheets.set(key, entry);
      element.hidden = true;
      expand(entry, false);
      const handler = (event) => keydown(entry, event);
      entry.detach = () => element.removeEventListener?.('keydown', handler);
      element.addEventListener?.('keydown', handler);
      return Object.freeze({
        id: key,
        element,
        open: (detail) => openSheet(entry, detail),
        close: () => close(entry),
        get isOpen() { return open === entry; },
      });
    },
    /** Close whatever is open; used by teardown and by screen changes. */
    closeAll({ restore = true } = {}) { return close(open, { restore }); },
    get openId() { return open ? open.id : null; },
    /** Focus order of the open sheet, for tests and for callers that must
     * verify DOM order matches the visual order (§1.9 V07). */
    focusOrder() { return open ? focusableWithin(open.element) : []; },
    destroy() {
      destroyed = true;
      close(open, { restore: false });
      applyBackground(false);
      for (const entry of sheets.values()) attempt(() => entry.detach?.());
      sheets.clear();
    },
  });
}
