// New implementation of P3-02c (docs/build/tasks/P3-02c.md) on top of the
// P2-16 caption list contract: one row per caption id, at most MAX_CAPTIONS
// settled rows plus the active partials, explicit scroll anchoring, follow /
// "latest" behaviour and final-only live announcements. It adds the
// captions-only full-screen frame: a top bar that hides itself after
// BAR_HIDE_MS, a text-size slider shared with the caption size preference,
// a light / dark / high-contrast display mode scoped to the board, screen
// wake lock and the Fullscreen API where available. Preferences live in
// localStorage under interp-app.ui.v1.* and are read once at creation.
// Nothing is ported from interp-web or jp-patch; no logging anywhere.
import { MAX_CAPTIONS } from '../engine/caption-store.js';
import { createBinder } from './seq-view.js';

// Caption size is the P3 §1.10 value the 가−/가+ controls share (rem).
export const CAPTION_SIZE_STORAGE_KEY = 'interp-app.ui.v1.captionSize';
export const CAPTION_ONLY_STORAGE_KEYS = Object.freeze({
  enabled: 'interp-app.ui.v1.captionOnly.enabled',
  display: 'interp-app.ui.v1.captionOnly.display',
});
export const CAPTION_SIZE = Object.freeze({ min: 1, max: 2.5, step: 0.125, initial: 1.25 });
export const DISPLAY_MODES = Object.freeze(['light', 'dark', 'mono']);
export const DEFAULT_DISPLAY = 'dark';
export const BAR_HIDE_MS = 3000;
const FOLLOW_SLACK_PX = 24;

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
export function clampCaptionSize(value) {
  const number = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(number)) return CAPTION_SIZE.initial;
  const steps = Math.round((number - CAPTION_SIZE.min) / CAPTION_SIZE.step);
  return Math.min(CAPTION_SIZE.max, Math.max(CAPTION_SIZE.min, CAPTION_SIZE.min + steps * CAPTION_SIZE.step));
}
export function readPreferences(storage) {
  const read = (key) => attempt(() => storage?.getItem(key));
  const display = read(CAPTION_ONLY_STORAGE_KEYS.display);
  return Object.freeze({
    size: clampCaptionSize(read(CAPTION_SIZE_STORAGE_KEY)),
    display: DISPLAY_MODES.includes(display) ? display : DEFAULT_DISPLAY,
    enabled: read(CAPTION_ONLY_STORAGE_KEYS.enabled) === '1',
  });
}

/**
 * createCaptionBoard({ parent, i18n, document?, window?, storage?, controls?,
 * primary?, onToggle?, setTimeout?, clearTimeout? }) appends the board to
 * parent. controls are caller-owned buttons placed in the full-screen bar;
 * primary is the caller-owned large start button shown above the list. The
 * caller keeps ownership of their state; this board only owns captions,
 * preferences, the bar and the full-screen lifecycle. storage is the app's
 * usable localStorage (only app/main.js touches it, P1-20 privacy contract);
 * setStorage(storage) hands it over after mount and restores the saved
 * preferences. Returns { element, list, bar, exit, captionOnly, size,
 * display, wakeState, render, clear, setCaptionOnly, setStorage, refresh,
 * destroy }.
 */
export function createCaptionBoard({ parent, i18n, document: doc = parent?.ownerDocument, window: win = doc?.defaultView ?? null,
  storage = null, controls = [], primary = null, onToggle,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout } = {}) {
  if (!parent || !doc || typeof i18n?.t !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n), rows = new Map(), listeners = [];
  let size = CAPTION_SIZE.initial, display = DEFAULT_DISPLAY, captionOnly = false;
  let disposed = false, following = true, barTimer = null, returnFocus = null, wantFullscreen = false;
  let wakeSentinel = null, wakeState = 'idle', wakeEpoch = 0;
  const node = (tag, name, target, key, attrs = {}) => {
    const el = doc.createElement(tag);
    el.setAttribute('class', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (key) bind.text(el, key);
    target?.append(el); return el;
  };
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  const listen = (el, event, fn) => {
    if (!el?.addEventListener) return;
    el.addEventListener(event, fn);
    listeners.push(() => attempt(() => el.removeEventListener(event, fn)));
  };
  const write = (key, value) => attempt(() => { if (value === null) storage?.removeItem(key); else storage?.setItem(key, value); });

  const board = node('section', 'caption-board', parent, null, { 'data-caption-only': 'false' });
  bind.attribute(board, 'aria-label', 'captionOnly.title');
  // Top bar: exit, text size, display mode, caller controls, wake lock state.
  const bar = node('div', 'caption-board-bar', board, null, { role: 'group' });
  bind.attribute(bar, 'aria-label', 'captionOnly.title');
  const exit = node('button', 'btn btn-secondary caption-board-exit', bar, 'captionOnly.exit', { type: 'button' });
  const sizeField = node('label', 'caption-board-size', bar);
  node('span', 'caption-board-size-label', sizeField, 'captionOnly.fontSize');
  const slider = node('input', 'caption-board-slider', sizeField, null, { type: 'range',
    min: String(CAPTION_SIZE.min), max: String(CAPTION_SIZE.max), step: String(CAPTION_SIZE.step) });
  const sizeValue = node('output', 'caption-board-size-value', sizeField);
  const displayButton = node('button', 'btn btn-secondary caption-board-display', bar, null, { type: 'button' });
  for (const control of controls) bar.append(control);
  const wake = node('p', 'caption-board-wake', bar, null, { role: 'status' });
  const status = node('p', 'caption-board-status', board, null, { role: 'status' });
  const notice = node('p', 'caption-board-notice', board, null, { role: 'status' });
  const primaryHost = node('div', 'caption-board-primary', board);
  if (primary) primaryHost.append(primary);
  const gaps = Object.fromEntries(['input', 'audio', 'reception'].map(cause =>
    [cause, node('p', `caption-board-gap sim-gap-${cause}`, board, `sim.gap.${cause}`, { role: 'status' })]));
  const empty = node('p', 'caption-board-empty sim-empty', board, 'sim.captions.empty');
  const list = node('div', 'caption-board-list sim-captions', board, null, { tabindex: '0', 'aria-live': 'off' });
  bind.attribute(list, 'aria-label', 'sim.captions.latest');
  // Only settled translations are announced (design-p3 §1.9: no partial reads).
  const announcement = node('p', 'sr-only sim-announcement', board, null, { 'aria-live': 'polite', 'aria-atomic': 'true' });
  const latest = node('button', 'btn btn-secondary sim-latest', board, 'sim.captions.latest', { type: 'button' });
  latest.hidden = true;

  function applySize() {
    attempt(() => board.style.setProperty('--caption-size', `${size}rem`));
    slider.value = String(size);
    slider.setAttribute('aria-valuetext', i18n.t('captionOnly.fontSizeValue', { size: String(size) }));
    setText(sizeValue, i18n.t('captionOnly.fontSizeValue', { size: String(size) }));
  }
  function applyDisplay() {
    board.setAttribute('data-display', display);
    setText(displayButton, `${i18n.t('captionOnly.display')}: ${i18n.t(`captionOnly.display.${display}`)}`);
  }
  function renderWake() {
    const key = wakeState === 'active' ? 'captionOnly.wakeLock.active' : wakeState === 'unsupported' ? 'captionOnly.wakeLock.unsupported'
      : wakeState === 'failed' ? 'captionOnly.wakeLock.failed' : null;
    setText(wake, key ? i18n.t(key) : '');
    wake.hidden = key === null;
  }
  function applyFrame() {
    board.setAttribute('data-caption-only', String(captionOnly));
    for (const el of [status, notice, primaryHost]) el.hidden = !captionOnly;
    if (!captionOnly) { bar.hidden = true; cancelTimer(barTimer); barTimer = null; }
  }

  // The bar shows on entry and on any tap or key, then hides after BAR_HIDE_MS
  // unless one of its controls has keyboard focus.
  function showBar() {
    if (!captionOnly || disposed) return;
    bar.hidden = false;
    cancelTimer(barTimer);
    barTimer = schedule(() => {
      barTimer = null;
      if (!captionOnly || disposed) return;
      if (doc.activeElement && bar.contains(doc.activeElement)) { showBar(); return; }
      bar.hidden = true;
    }, BAR_HIDE_MS);
  }
  function hideBar() { cancelTimer(barTimer); barTimer = null; bar.hidden = true; }

  // Wake lock needs a visible page; it is re-acquired when the tab returns.
  async function acquireWakeLock() {
    const epoch = ++wakeEpoch;
    const lock = win?.navigator?.wakeLock;
    if (typeof lock?.request !== 'function') { wakeState = 'unsupported'; renderWake(); return; }
    try {
      const sentinel = await lock.request('screen');
      if (disposed || !captionOnly || epoch !== wakeEpoch) { attempt(() => sentinel?.release?.()); return; }
      wakeSentinel = sentinel;
      wakeState = 'active';
      attempt(() => sentinel.addEventListener?.('release', () => {
        if (wakeSentinel === sentinel) { wakeSentinel = null; if (wakeState === 'active') wakeState = 'idle'; renderWake(); }
      }));
    } catch { wakeState = 'failed'; }
    if (!disposed) renderWake();
  }
  function releaseWakeLock() {
    wakeEpoch++;
    const sentinel = wakeSentinel;
    wakeSentinel = null; wakeState = 'idle';
    if (sentinel) attempt(() => Promise.resolve(sentinel.release()).catch(() => {}));
    renderWake();
  }
  function requestFullscreen() {
    wantFullscreen = false;
    const request = board.requestFullscreen ?? board.webkitRequestFullscreen;
    if (typeof request !== 'function') return;
    attempt(() => Promise.resolve(request.call(board, { navigationUI: 'hide' })).catch(() => {}));
  }
  function exitFullscreen() {
    const current = doc.fullscreenElement ?? doc.webkitFullscreenElement;
    if (current !== board) return;
    const leave = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (typeof leave === 'function') attempt(() => Promise.resolve(leave.call(doc)).catch(() => {}));
  }

  /** gesture=false restores a stored mode without the APIs that need a tap. */
  function setCaptionOnly(on, { gesture = true } = {}) {
    if (disposed || on === captionOnly) return captionOnly;
    captionOnly = on;
    applyFrame();
    if (on) {
      returnFocus = doc.activeElement ?? null;
      showBar();
      if (gesture) requestFullscreen(); else wantFullscreen = true;
      void acquireWakeLock();
      following = true; list.scrollTop = list.scrollHeight; latest.hidden = true;
      attempt(() => exit.focus());
    } else {
      releaseWakeLock();
      exitFullscreen();
      wantFullscreen = false;
      const target = returnFocus; returnFocus = null;
      if (target && target !== exit) attempt(() => target.focus());
    }
    write(CAPTION_ONLY_STORAGE_KEYS.enabled, on ? '1' : null);
    onToggle?.(on);
    return captionOnly;
  }

  listen(exit, 'click', () => setCaptionOnly(false));
  listen(slider, 'input', () => {
    const next = clampCaptionSize(slider.value);
    if (next === size) return;
    size = next; applySize(); write(CAPTION_SIZE_STORAGE_KEY, String(size));
    if (following) list.scrollTop = list.scrollHeight;
    showBar();
  });
  listen(slider, 'change', () => showBar());
  listen(displayButton, 'click', () => {
    display = DISPLAY_MODES[(DISPLAY_MODES.indexOf(display) + 1) % DISPLAY_MODES.length];
    applyDisplay(); write(CAPTION_ONLY_STORAGE_KEYS.display, display); showBar();
  });
  listen(board, 'click', (event) => {
    if (!captionOnly) return;
    const target = event?.target;
    if (target && target !== board && (bar.contains(target) || primaryHost.contains(target) || latest.contains(target))) { showBar(); return; }
    if (wantFullscreen) requestFullscreen();
    if (bar.hidden) showBar(); else hideBar();
  });
  listen(board, 'keydown', (event) => {
    if (!captionOnly) return;
    if (event?.key === 'Escape') { event.preventDefault?.(); setCaptionOnly(false); return; }
    showBar();
  });
  listen(list, 'scroll', () => { following = list.scrollHeight - list.clientHeight - list.scrollTop <= FOLLOW_SLACK_PX; latest.hidden = following; });
  listen(latest, 'click', () => { following = true; list.scrollTop = list.scrollHeight; latest.hidden = true; });
  listen(doc, 'visibilitychange', () => {
    if (captionOnly && !doc.hidden && !wakeSentinel && wakeState !== 'unsupported') void acquireWakeLock();
  });

  /**
   * render({ captions, skippedSegments?, gaps?, lang?, announceFirstFinal?,
   * status?, notice? }): captions are the already filtered rows in display
   * order. announceFirstFinal reads a final that was never seen partial.
   */
  function render({ captions = [], skippedSegments = [], gaps: gapState = null, lang = null, announceFirstFinal = false,
    status: statusText = '', notice: noticeText = '' } = {}) {
    if (disposed) return;
    const settled = captions.filter(c => c.status !== 'partial').slice(-MAX_CAPTIONS);
    const keep = new Set([...settled, ...captions.filter(c => c.status === 'partial')].map(c => c.id));
    // Keep the first surviving visible row fixed even when the oldest row is
    // evicted. CSS disables native anchoring to avoid applying compensation twice.
    const top = list.getBoundingClientRect?.().top ?? 0;
    const anchor = [...rows].find(([id, row]) => keep.has(id) && (row.el.getBoundingClientRect?.().bottom ?? 0) > top);
    const before = anchor?.[1].el.getBoundingClientRect?.().top;
    for (const [id, row] of rows) if (!keep.has(id)) { row.el.remove(); rows.delete(id); }
    let finalText = '';
    for (const c of captions.filter(c => keep.has(c.id))) {
      let row = rows.get(c.id);
      if (!row) {
        const el = node('article', 'sim-caption caption-board-row', list);
        row = { el, label: node('span', 'turn-label', el), text: node('p', 'turn-text', el), status: null };
        rows.set(c.id, row);
      }
      const text = c.role === 'source' ? c.sourceText : c.translatedText;
      if (c.status === 'final' && c.role === 'translation' && (row.status === 'partial' || (row.status === null && announceFirstFinal))) finalText = text;
      row.status = c.status;
      row.el.setAttribute('data-status', c.status);
      const skipped = c.role === 'translation' && skippedSegments?.includes(c.segmentId) === true;
      row.el.setAttribute('data-skipped', String(skipped));
      setText(row.label, `${i18n.t(c.role === 'source' ? 'seq.original' : 'seq.translation')} · ${i18n.t(skipped ? 'sim.captions.skipped' : `sim.captions.${c.status}`)}`);
      setText(row.text, text ?? '');
      row.el.setAttribute('data-gap-before', String(c.gapBefore === true));
      if (c.role === 'translation' && lang) row.text.setAttribute('lang', lang);
    }
    if (finalText) setText(announcement, finalText);
    if (following) list.scrollTop = list.scrollHeight;
    else if (before !== undefined) list.scrollTop += anchor[1].el.getBoundingClientRect().top - before;
    latest.hidden = following; empty.hidden = rows.size > 0;
    for (const [cause, el] of Object.entries(gaps)) el.hidden = !gapState?.[cause];
    setText(status, statusText ?? ''); setText(notice, noticeText ?? '');
  }
  function clear() { rows.clear(); list.textContent = ''; following = true; latest.hidden = true; empty.hidden = false; }
  /** Restores saved preferences; a stored captions-only mode resumes without the gesture-only APIs. */
  function setStorage(next) {
    if (disposed) return;
    storage = next ?? null;
    const preferences = readPreferences(storage);
    size = preferences.size; display = preferences.display;
    applySize(); applyDisplay();
    if (following) list.scrollTop = list.scrollHeight;
    if (preferences.enabled) setCaptionOnly(true, { gesture: false });
  }

  applySize(); applyDisplay(); renderWake(); applyFrame();
  if (storage) setStorage(storage);

  return Object.freeze({
    element: board, list, bar, exit,
    get captionOnly() { return captionOnly; },
    get size() { return size; },
    get display() { return display; },
    get wakeState() { return wakeState; },
    render, clear, setCaptionOnly, setStorage,
    refresh() { if (disposed) return; bind.refresh(); applySize(); applyDisplay(); renderWake(); },
    destroy() {
      if (disposed) return;
      disposed = true;
      cancelTimer(barTimer); barTimer = null;
      releaseWakeLock(); exitFullscreen();
      for (const off of listeners) off();
      bind.clear(); rows.clear(); board.remove();
    },
  });
}
