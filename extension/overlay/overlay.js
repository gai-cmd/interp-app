// New implementation of docs/extension.md §8.5; no legacy code is ported.
// The caption overlay: a classic content script (no imports, R3) that draws the offscreen host's caption frames
// over a third-party page. What it does to the page is deliberately tiny: it appends ONE element (an unknown tag
// holding a CLOSED shadow root, so page CSS cannot reach in and page scripts cannot read the captions, which for
// the microphone lane are the user's own translated speech) and listens to two document events. It never reads
// page content, never stores anything, never logs, and never throws into the page: every entry point is guarded and
// a failure removes the overlay instead. It opens no port until the service worker asks (`content/overlay-attach`),
// and it only ever sends `hello`. Strings come from chrome.i18n (`_locales`): a content script cannot load the
// extension dictionary.
(function () {
  'use strict';

  // The wire constants live in ONE frozen literal so a test can pin them without importing protocol.js (3.5).
  const WIRE = Object.freeze({ port: 'interp-overlay/1', v: 1, maxRows: 6, maxRowChars: 400 });
  const KEY = Symbol.for('interp.overlay.v1');
  if (globalThis[KEY]) return;   // a second injection (static script + executeScript fallback) does nothing

  const LANES = Object.freeze(['tab', 'mic']);
  const LANGUAGES = Object.freeze(['ko', 'en', 'ja']);
  const ROW_STATUSES = Object.freeze(['final', 'partial', 'interrupted']);
  const GAP_KINDS = Object.freeze(['input', 'audio', 'reception']);
  const PHASES = Object.freeze(['reconnecting', 'stopped', 'running']);
  const POSITIONS = Object.freeze(['top', 'bottom']);
  const DISPLAYS = Object.freeze(['dark', 'light', 'mono']);
  const DEFAULT_STYLE = Object.freeze({ size: 1.5, position: 'bottom', display: 'dark', maxLines: 3, autoHideSeconds: 8 });
  const NO_GAPS = Object.freeze({ input: false, audio: false, reception: false });
  const MAX_FRAME_CHARS = 16384;
  const NOTE_MS = 8000;   // a gap line and a `stopped` row stay this long; `reconnecting` stays until `running`
  // `all: initial` is the isolation from page CSS, but the CSS `all` shorthand deliberately leaves `direction` and
  // `unicode-bidi` alone, so an rtl page (`<html dir="rtl">`) would flip the caption bar, its start-edge markers and
  // the neutral punctuation of ko/ja/en text. They are pinned on the host, and each row also gets dir="auto".
  const HOST_STYLE = Object.freeze([['all', 'initial'], ['direction', 'ltr'], ['unicode-bidi', 'isolate'], ['position', 'fixed'],
    ['inset', '0'], ['z-index', '2147483647'], ['pointer-events', 'none'], ['display', 'block'], ['contain', 'layout style']]);

  // Fullscreen (8.5.3). Elements that cannot render light-DOM children make a re-parented overlay vanish, so they are
  // refused by strategy 1 and handled by strategy 2 (top-layer popover). One constant orders the strategies; when
  // both refuse, the overlay stays where it is (strategy 3: invisible during fullscreen, the panel preview remains).
  const NO_CHILD_TAGS = Object.freeze(new Set(['VIDEO', 'IFRAME', 'CANVAS', 'IMG', 'EMBED', 'OBJECT', 'INPUT', 'TEXTAREA', 'SELECT', 'SVG']));
  const FULLSCREEN_ORDER = Object.freeze(['container', 'popover']);

  // Each message name is spelled out where it is read so a scan for getMessage('...') literals sees all seven.
  const LABELS = Object.freeze({
    region: () => chrome.i18n.getMessage('overlayRegion'),
    hide: () => chrome.i18n.getMessage('overlayHide'),
    laneTab: () => chrome.i18n.getMessage('overlayLaneTab'),
    laneMic: () => chrome.i18n.getMessage('overlayLaneMic'),
    gap: () => chrome.i18n.getMessage('overlayGap'),
    reconnecting: () => chrome.i18n.getMessage('overlayReconnecting'),
    stopped: () => chrome.i18n.getMessage('overlayStopped'),
  });

  // The stylesheet lives inside the shadow root. px, not rem: the host page's root font size is unknown. The tokens
  // are the hex values of styles.css (dark/light sets and the mono board block); tests compare them. The top fade
  // hides the cut of the oldest lines (the column overflows at its START edge, so the NEWEST row is never clipped);
  // a second, opaque mask layer keeps the close button's corner out of the fade so the button stays visible.
  const SHEET = [
    '*, *::before, *::after { box-sizing: border-box; }',
    '.wrap { --size: 1.5; position: fixed; left: 50%; transform: translateX(-50%); width: min(90vw, 896px);',
    '  max-height: min(40vh, calc(var(--size) * 16px * 1.35 * 8)); display: flex; flex-direction: column; justify-content: flex-end;',
    '  min-height: 0; overflow: hidden; padding: 8px 12px; border: 1px solid var(--border); border-radius: 12px;',
    '  background: var(--bg); color: var(--text);',
    '  font: 600 calc(var(--size) * 16px)/1.35 -apple-system, "Segoe UI", Roboto, "Noto Sans KR", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif;',
    '  letter-spacing: 0; text-align: start; pointer-events: none; opacity: 0.96;',
    '  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.5em), linear-gradient(#000, #000);',
    '  -webkit-mask-size: 100% 100%, 40px 40px; -webkit-mask-position: 0 0, right 0 top 0; -webkit-mask-repeat: no-repeat;',
    '  mask-image: linear-gradient(to bottom, transparent 0, #000 1.5em), linear-gradient(#000, #000);',
    '  mask-size: 100% 100%, 40px 40px; mask-position: 0 0, right 0 top 0; mask-repeat: no-repeat; }',
    '.wrap:not([data-display]), .wrap[data-display="dark"] { --bg: #1e2329; --text: #edf0f3; --muted: #aab3bd; --border: #3a434d; --accent: #7fb6dd; --danger: #ff8a80; }',
    '.wrap[data-display="light"] { --bg: #ffffff; --text: #1a1d21; --muted: #4d5560; --border: #c9d0d8; --accent: #1f5f8b; --danger: #a5282c; }',
    '.wrap[data-display="mono"] { --bg: #000000; --text: #ffffff; --muted: #d4d4d4; --border: #8a8a8a; --accent: #ffffff; --danger: #ffb4ab; }',
    '.wrap[data-position="top"] { top: 16px; }',
    '.wrap[data-position="bottom"] { bottom: 16px; }',
    '.wrap[hidden] { display: none; }',
    '.lane, .rows { display: flex; flex-direction: column; justify-content: flex-end; min-height: 0; }',
    '.row { margin: 0; overflow-wrap: anywhere; }',
    '.row[data-status="partial"] { color: var(--muted); border-inline-start: 3px dashed var(--accent); padding-inline-start: 8px; }',
    '.row[data-status="interrupted"] { color: var(--muted); border-inline-start: 3px solid var(--danger); padding-inline-start: 8px; }',
    '.chip { font: 700 12px/1 sans-serif; font-family: inherit; color: var(--muted); }',
    '.status { margin: 0; font: 600 13px/1.3 sans-serif; font-family: inherit; color: var(--muted); border-inline-start: 3px dashed var(--accent); padding-inline-start: 8px; }',
    '.gap { margin: 0; font: 600 13px/1.3 sans-serif; font-family: inherit; color: var(--muted); }',
    '.close { position: absolute; top: 4px; inset-inline-end: 4px; pointer-events: auto; min-width: 28px; min-height: 28px; margin: 0; padding: 0;',
    '  -webkit-appearance: none; appearance: none; border: 1px solid var(--border); border-radius: 50%; background: var(--bg); color: var(--text);',
    '  font: 700 18px/1 sans-serif; cursor: pointer; }',
    '.close::before { content: "\\00d7"; }',
    '.close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
    '@media (hover: hover) { .close:hover { border-color: var(--text); } }',
    '@media (prefers-reduced-motion: no-preference) { .wrap { transition: opacity 150ms ease-out; } }',
    '@media (forced-colors: active) { .wrap { border-color: CanvasText; } .close { border-color: CanvasText; } }',
  ].join('\n');

  const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
  // Arrays are told apart with Array.isArray (works across realms); prototypes are never compared.
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const alive = () => Boolean(attempt(() => chrome.runtime.id));   // gone after the extension is reloaded or updated
  const label = (name) => { const text = attempt(() => LABELS[name]()); return typeof text === 'string' ? text : ''; };

  const freshState = () => ({
    style: DEFAULT_STYLE,
    frames: { tab: null, mic: null },       // the last accepted captions frame per lane
    seen: { tab: -1, mic: -1 },             // the last epoch accepted per lane
    dismissed: { tab: null, mic: null },    // null, or the epoch that was on screen when the user pressed close
    status: { tab: null, mic: null },       // null | 'reconnecting' | 'stopped'
    prevGaps: { tab: NO_GAPS, mic: NO_GAPS },
    lastRows: { tab: null, mic: null },     // JSON of the previous rows, to tell "same words again" from news
    rowsHidden: { tab: false, mic: false }, // auto-hide after silence
    gapOn: false,
    timers: { hide: { tab: null, mic: null }, status: { tab: null, mic: null }, gap: null },
  });

  let state = freshState();
  let current = null;   // the one open port; every port handler first checks that it is still this one
  let ui = null;        // { host, shadow, wrap, close, mode } once a frame has been accepted

  // -------------------------------------------------------------------------
  // Timers (the page realm's own; a timer that fires after detach() was cleared with it)
  function disarm(bucket, key) {
    if (bucket[key] !== null && bucket[key] !== undefined) { clearTimeout(bucket[key]); bucket[key] = null; }
  }
  function arm(bucket, key, ms, fn) {
    disarm(bucket, key);
    bucket[key] = setTimeout(() => { bucket[key] = null; guard(fn); }, ms);
  }
  function clearTimers() {
    for (const lane of LANES) { disarm(state.timers.hide, lane); disarm(state.timers.status, lane); }
    disarm(state.timers, 'gap');
  }

  // Never throws into the page: a failing handler removes the overlay (the onMessage listener stays, so the next
  // lane start can attach again) rather than leaving a half-drawn one behind.
  function guard(fn) {
    try { fn(); } catch { attempt(() => detach()); }
  }

  // -------------------------------------------------------------------------
  // DOM
  function make(tag, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  function installSheet(shadow) {
    const adopted = attempt(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHEET);
      shadow.adoptedStyleSheets = [sheet];
      return true;
    });
    if (adopted) return;
    const tag = make('style');
    tag.textContent = SHEET;
    shadow.append(tag);
  }

  function ensureUi() {
    if (ui) return;
    const parent = document.documentElement;
    if (!parent) throw new Error('NO_DOCUMENT_ELEMENT');
    const host = make('interp-live-captions');
    for (const [name, value] of HOST_STYLE) host.style.setProperty(name, value, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });   // the only reference to the root is this closure
    installSheet(shadow);
    const wrap = make('div', 'wrap');
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', label('region'));
    wrap.hidden = true;
    const close = make('button', 'close');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', label('hide'));   // the glyph is drawn by CSS, the button has no text
    close.addEventListener('click', () => guard(dismiss));
    wrap.append(close);
    shadow.append(wrap);
    parent.appendChild(host);
    ui = { host, shadow, wrap, close, mode: null };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    syncFullscreen();
  }

  function removeUi() {
    if (!ui) return;
    const { host } = ui;
    ui = null;
    attempt(() => document.removeEventListener('visibilitychange', onVisibility));
    attempt(() => document.removeEventListener('fullscreenchange', onFullscreen));
    attempt(() => host.remove());   // leaving the DOM also leaves the top layer
  }

  function paintStyle() {
    const { wrap } = ui;
    wrap.setAttribute('data-position', state.style.position);
    wrap.setAttribute('data-display', state.style.display);
    wrap.style.setProperty('--size', String(state.style.size));
  }

  // -------------------------------------------------------------------------
  // What is shown
  function rowsOf(lane) {
    const frame = state.frames[lane];
    if (!frame || state.rowsHidden[lane] || state.dismissed[lane] !== null) return [];
    // Skipped translation rows are not drawn at all: a struck-through line with no label is unexplained over a video.
    const usable = frame.rows.filter((row) => row.skipped !== true && row.text.trim() !== '');
    // An interrupted row is dropped as soon as a newer row exists in the lane.
    const settled = usable.filter((row, index) => row.status !== 'interrupted' || index === usable.length - 1);
    return settled.slice(-state.style.maxLines);   // chronological, newest LAST
  }
  const phaseOf = (lane) => (state.dismissed[lane] === null ? state.status[lane] : null);

  // Keeps the END of a long text (the newest words are the ones being spoken) without splitting a surrogate pair.
  function clip(text) {
    if (text.length <= WIRE.maxRowChars) return text;
    let start = text.length - (WIRE.maxRowChars - 1);
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
    return `…${text.slice(start)}`;
  }

  function laneSection(lane, rows, phase) {
    const section = make('section', 'lane');
    section.setAttribute('data-lane', lane);
    const lang = state.frames[lane] ? state.frames[lane].lang : undefined;
    if (LANGUAGES.includes(lang)) section.setAttribute('lang', lang);
    const chip = make('span', 'chip');
    chip.textContent = label(lane === 'tab' ? 'laneTab' : 'laneMic');
    section.append(chip);
    if (rows.length > 0) {
      const list = make('div', 'rows');
      for (const row of rows) {
        const item = make('p', 'row');
        item.setAttribute('data-status', row.status);
        item.setAttribute('dir', 'auto');   // a row is shaped by its own text, not by the page's direction
        item.textContent = clip(row.text);
        list.append(item);
      }
      section.append(list);
    }
    if (phase) {
      const note = make('p', 'status');
      note.setAttribute('data-phase', phase);
      note.textContent = label(phase);
      section.append(note);
    }
    return section;
  }

  function render() {
    if (!ui) return;
    if (!ui.host.isConnected) restoreHost();   // the page (or a removed fullscreen container) took it away
    if (document.visibilityState === 'hidden') { ui.wrap.hidden = true; return; }
    const children = [ui.close];
    for (const lane of LANES) {
      const rows = rowsOf(lane);
      const phase = phaseOf(lane);
      if (rows.length > 0 || phase) children.push(laneSection(lane, rows, phase));
    }
    if (state.gapOn) {
      const gap = make('p', 'gap');
      gap.textContent = label('gap');
      children.push(gap);
    }
    ui.wrap.replaceChildren(...children);
    ui.wrap.hidden = children.length === 1;   // nothing to say: nothing is drawn over the page
  }

  const commit = () => { ensureUi(); paintStyle(); render(); };

  // -------------------------------------------------------------------------
  // Fullscreen (8.5.3): the host is `position: fixed`, but only the fullscreen element's subtree (or the top layer)
  // is painted, so the overlay is moved for the duration and ALWAYS put back.
  function restoreHost() {
    if (!ui) return;
    const { host } = ui;
    if (ui.mode === 'popover') {
      attempt(() => host.hidePopover?.());
      attempt(() => host.removeAttribute('popover'));
    }
    ui.mode = null;
    const parent = document.documentElement;
    if (parent && host.parentNode !== parent) attempt(() => parent.appendChild(host));
  }

  const STRATEGIES = Object.freeze({
    container(fs) {
      // A closed root cannot be detected (an accepted residual risk); an open one would not render a light-DOM child.
      if (NO_CHILD_TAGS.has(String(fs.tagName).toUpperCase()) || (fs.shadowRoot !== null && fs.shadowRoot !== undefined)) return false;
      try {
        fs.appendChild(ui.host);
        return true;
      } catch {
        restoreHost();
        return false;
      }
    },
    popover() {
      const { host } = ui;
      if (typeof host.showPopover !== 'function') return false;
      try {
        host.popover = 'manual';
        host.hidePopover?.();   // re-issued on every change so the host is stacked above the fullscreen element
        host.showPopover();
        ui.mode = 'popover';
        return true;
      } catch {
        attempt(() => host.removeAttribute('popover'));
        return false;
      }
    },
  });

  function syncFullscreen() {
    if (!ui) return;
    const fs = document.fullscreenElement;
    if (!fs || fs.isConnected === false) { restoreHost(); return; }
    if (fs === document.documentElement || ui.host.parentNode === fs) return;
    restoreHost();
    for (const name of FULLSCREEN_ORDER) {
      if (attempt(() => STRATEGIES[name](fs)) === true) return;
    }
  }

  const onFullscreen = () => guard(() => { syncFullscreen(); render(); });
  const onVisibility = () => guard(render);

  // -------------------------------------------------------------------------
  // Frames
  function armHide(lane) {
    disarm(state.timers.hide, lane);
    const seconds = state.style.autoHideSeconds;
    if (seconds > 0 && rowsOf(lane).length > 0) {
      arm(state.timers.hide, lane, seconds * 1000, () => { state.rowsHidden[lane] = true; render(); });
    }
  }

  function startGap() {
    state.gapOn = true;
    arm(state.timers, 'gap', NOTE_MS, () => { state.gapOn = false; render(); });
  }

  function onStyle(frame) {
    if (!isObject(frame.style)) return;
    const next = frame.style;
    const merged = { ...state.style };   // an out-of-range field keeps its previous value
    if (typeof next.size === 'number' && next.size >= 1 && next.size <= 2) merged.size = next.size;
    if (POSITIONS.includes(next.position)) merged.position = next.position;
    if (DISPLAYS.includes(next.display)) merged.display = next.display;
    if (Number.isInteger(next.maxLines) && next.maxLines >= 1 && next.maxLines <= 6) merged.maxLines = next.maxLines;
    if (Number.isInteger(next.autoHideSeconds) && next.autoHideSeconds >= 0 && next.autoHideSeconds <= 60) {
      merged.autoHideSeconds = next.autoHideSeconds;
    }
    const hideChanged = merged.autoHideSeconds !== state.style.autoHideSeconds;
    state.style = Object.freeze(merged);
    if (hideChanged) for (const lane of LANES) armHide(lane);
    commit();
  }

  const validRow = (row) => isObject(row) && typeof row.text === 'string' && ROW_STATUSES.includes(row.status);

  function onCaptions(frame) {
    if (JSON.stringify(frame).length > MAX_FRAME_CHARS) return;
    if (!LANES.includes(frame.lane) || !Number.isInteger(frame.epoch) || frame.epoch < 0 || !isObject(frame.gaps)
        || !Array.isArray(frame.rows) || frame.rows.length > WIRE.maxRows || !frame.rows.every(validRow)) return;
    const lane = frame.lane;
    // ONE rule for a dismissed lane: same or older epoch stays hidden (`<` would let the very next frame of the same
    // epoch, about 100 ms later, bring it back and the close button would look broken); a newer epoch is a new start.
    const dismissedAt = state.dismissed[lane];
    if (dismissedAt !== null && frame.epoch <= dismissedAt) return;
    state.dismissed[lane] = null;
    if (frame.epoch !== state.seen[lane]) { state.prevGaps[lane] = NO_GAPS; state.lastRows[lane] = null; }
    state.seen[lane] = frame.epoch;

    // The gap flags are sticky for a whole session, so only a false -> true transition earns a line (for a while).
    const gaps = { input: frame.gaps.input === true, audio: frame.gaps.audio === true, reception: frame.gaps.reception === true };
    if (GAP_KINDS.some((kind) => gaps[kind] && !state.prevGaps[lane][kind])) startGap();
    state.prevGaps[lane] = gaps;

    const rowsJson = JSON.stringify(frame.rows);
    const news = rowsJson !== state.lastRows[lane];
    state.lastRows[lane] = rowsJson;
    state.frames[lane] = frame;
    if (news) { state.rowsHidden[lane] = false; armHide(lane); }
    commit();
  }

  function onClear(frame) {
    if (!LANES.includes(frame.lane)) return;
    const lane = frame.lane;
    state.frames[lane] = null;
    state.dismissed[lane] = null;   // so the panel's captions checkbox off/on brings a dismissed overlay back
    state.prevGaps[lane] = NO_GAPS;
    state.lastRows[lane] = null;
    state.rowsHidden[lane] = false;
    disarm(state.timers.hide, lane);   // the lane's status row is kept
    commit();
  }

  function onStatus(frame) {
    if (!LANES.includes(frame.lane) || !PHASES.includes(frame.phase)) return;
    const lane = frame.lane;
    disarm(state.timers.status, lane);
    if (frame.phase === 'running') {
      state.status[lane] = null;
    } else {
      state.status[lane] = frame.phase;
      if (frame.phase === 'stopped') arm(state.timers.status, lane, NOTE_MS, () => { state.status[lane] = null; render(); });
    }
    commit();
  }

  function dismiss() {
    for (const lane of LANES) {
      if (rowsOf(lane).length > 0 || phaseOf(lane) !== null) state.dismissed[lane] = state.seen[lane];
    }
    state.gapOn = false;
    disarm(state.timers, 'gap');
    render();
  }

  function onFrame(port, frame) {
    if (port !== current) return;   // a late frame of a port the host replaced
    guard(() => {
      if (!alive()) { dispose(); return; }
      if (!isObject(frame) || frame.v !== WIRE.v) return;
      switch (frame.type) {
        case 'style': onStyle(frame); break;
        case 'captions': onCaptions(frame); break;
        case 'clear': onClear(frame); break;
        case 'status': onStatus(frame); break;
        case 'bye': detach(); break;
        default: break;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  function onDisconnect(port) {
    if (port !== current) return;   // a late disconnect of a replaced port can never dispose the UI the new one owns
    attempt(() => chrome.runtime.lastError);   // read it so the browser does not log it into the page
    if (alive()) guard(() => detach({ close: false })); else attempt(dispose);
  }

  function attach() {
    if (!alive()) { dispose(); return; }
    if (current) return;   // idempotent while connected: several triggers can send the message within milliseconds
    try {
      const port = chrome.runtime.connect({ name: WIRE.port });
      current = port;
      port.onMessage.addListener((frame) => onFrame(port, frame));
      port.onDisconnect.addListener(() => onDisconnect(port));
      port.postMessage({ v: WIRE.v, type: 'hello' });
    } catch {
      attempt(() => detach());
    }
  }

  // Removes the UI, closes the port and forgets everything, but keeps the onMessage listener so a later attach works.
  function detach({ close = true } = {}) {
    const port = current;
    current = null;
    if (close && port) attempt(() => port.disconnect());
    clearTimers();
    removeUi();
    state = freshState();
  }

  function dispose() {
    detach();
    attempt(() => chrome.runtime.onMessage.removeListener(onRuntimeMessage));
    if (globalThis[KEY] === handle) attempt(() => { delete globalThis[KEY]; });
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    const trusted = isObject(message) && message.v === WIRE.v && message.target === 'content'
      && message.type === 'content/overlay-attach' && isObject(sender)
      && sender.id === attempt(() => chrome.runtime.id) && sender.tab === undefined;
    if (!trusted) return undefined;   // not ours: stay silent
    attempt(attach);
    attempt(() => sendResponse({ ok: true }));   // answered in every case, so the service worker does not retry
    return undefined;
  }

  const handle = Object.freeze({ dispose });
  let listening = false;
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    listening = true;
  } catch {
    // no extension runtime here (or it is already orphaned): there is nothing to serve and nothing to mark
  }
  if (listening) globalThis[KEY] = handle;
})();
