// New implementation of docs/extension.md §11.2; no legacy code is ported.
//
// A single-process model of the Chrome extension runtime, built so that the
// service worker, the offscreen host and the page controllers can be tested
// against the SAME seams the real browser exposes: a JSON-serializing message
// bus with fan-out, ports, a service worker that idles out and revives, one
// offscreen document, a per-tab tabCapture/activeTab grant with the exact
// error strings Chromium produces, storage areas with access levels, and a
// strict user-gesture model for sidePanel.open. Nothing here touches a real
// browser, device or clock: time is virtual (browser.clock) and no sound can
// be produced. Where the model is stricter or looser than Chrome the comment
// says so, because a green test proves only what the fake enforces.
//
// Beyond the members promised in 11.2 the browser offers (all optional):
//   browser.settle()                    flush pending microtask chains (no time passes)
//   browser.withGesture(fn)             run fn with a user gesture but WITHOUT any tab grant
//   browser.pushState(tabId, url)       same-document navigation: grant and content script survive
//   browser.install(reason)             fire runtime.onInstalled in the service worker
//   browser.tabRecord / contentContext / hasGrant / storageData(area) / listenerErrors / injections / autoPanelOpens
//   browser.on<Hook> = fn               onCreateOffscreen(context), onInject(tabId, files), onContentCreated(context),
//                                       onTabCreate(tab), onPanelOpen(record), onOpenOptions(): a throwing hook is
//                                       recorded in listenerErrors, never thrown into the browser call
//   context.invalidate()                the extension was reloaded under a content script (runtime.id vanishes)
//   context.storageTouched              a content context read chrome.storage at least once
// The message bus reports sender kinds as plain strings in browser.deliveries:
//   { from, to, kind: 'message' | 'response' | 'port-frame', json, fromId, toId }.
import { setImmediate as nextTask } from 'node:timers';

export const GRANT_ERROR = 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.';
export const ACTIVE_STREAM_ERROR = 'Cannot capture a tab with an active stream.';
// Stand-in for "a few seconds" (documented, real value unknown: assumption A20).
export const STREAM_ID_TTL_MS = 5000;

export const NO_RECEIVER_ERROR = 'Could not establish connection. Receiving end does not exist.';
export const PORT_CLOSED_ERROR = 'The message port closed before a response was received.';
export const GESTURE_ERROR = '`sidePanel.open()` may only be called in response to a user gesture.';
export const SINGLE_DOCUMENT_ERROR = 'Only a single offscreen document may be created.';
export const NO_DOCUMENT_ERROR = 'No current offscreen document.';
export const REASON_ERROR = 'A `reason` must be provided.';
export const INVALID_TAB_ERROR = 'Invalid tab specified.';
export const CANNOT_CAPTURE_ERROR = 'Cannot capture this page.';
export const INVALIDATED_ERROR = 'Extension context invalidated.';
export const STORAGE_DENIED_ERROR = 'Access to storage is not allowed from this context.';
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const SW_IDLE_MS = 30000;
export const AUDIO_PLAYBACK_CLOSE_MS = 30000;
export const OFFSCREEN_REASONS = Object.freeze(['TESTING', 'AUDIO_PLAYBACK', 'IFRAME_SCRIPTING', 'DOM_SCRAPING', 'BLOBS',
  'DOM_PARSER', 'USER_MEDIA', 'DISPLAY_MEDIA', 'WEB_RTC', 'CLIPBOARD', 'LOCAL_STORAGE', 'WORKERS', 'BATTERY_STATUS',
  'MATCH_MEDIA', 'GEOLOCATION']);

const RESTRICTED_SCHEMES = Object.freeze(['chrome:', 'about:', 'chrome-extension:']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// A macrotask hop: every pending microtask chain finishes first. It orders
// delivery only; it never measures time (the virtual clock does).
const flush = () => new Promise((resolve) => nextTask(resolve));

// ---------------------------------------------------------------------------
// Virtual clock: the only source of time for every fake behavior.
export function createFakeClock({ start = 0 } = {}) {
  let now = start, serial = 0;
  const timers = new Map();
  return Object.freeze({
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = ++serial;
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Fires due timers in order, flushing microtasks between them. */
    async advance(ms) {
      const end = now + Math.max(0, Number(ms) || 0);
      await flush();
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  });
}

// ---------------------------------------------------------------------------
// Media doubles shared with fake-audio.mjs (which re-exports them). A track
// belongs to a "source"; when every track of a source has ended the source is
// released, which is how a tab capture becomes free again.
export function createMediaSource(onRelease) {
  const tracks = new Set();
  return { tracks, onRelease, released: false,
    add(track) { tracks.add(track); },
    release() {
      if (this.released || [...tracks].some((track) => track.readyState !== 'ended')) return;
      this.released = true;
      attempt(() => this.onRelease?.());
    },
    endAll() { for (const track of [...tracks]) track.end(); } };
}

let trackSerial = 0;
export class FakeTrack extends EventTarget {
  constructor({ kind = 'audio', label = '', source = null, deviceId = 'fake-device', settings = {}, captureHandle = null } = {}) {
    super();
    this.id = `fake-track-${++trackSerial}`;
    this.kind = kind; this.label = label; this.deviceId = deviceId;
    // §19: a display-capture track reports extra settings (suppressLocalAudioPlayback) and, on its video track, the
    // capture handle of the captured page ({ handle } or null).
    this.settings = { ...settings }; this.captureHandle = captureHandle;
    this.readyState = 'live'; this.muted = false; this.enabled = true; this.stops = 0;
    this.source = source;
    source?.add(this);
  }
  /** Like MediaStreamTrack.stop(): ends the track WITHOUT an `ended` event. */
  stop() {
    this.stops++;
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.source?.release();
  }
  /** The source ended by itself (tab closed, capture revoked): `ended` fires. */
  end() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
    this.source?.release();
  }
  mute() { this.muted = true; this.dispatchEvent(new Event('mute')); }
  unmute() { this.muted = false; this.dispatchEvent(new Event('unmute')); }
  clone() {
    return new FakeTrack({ kind: this.kind, label: this.label, source: this.source, deviceId: this.deviceId });
  }
  getSettings() { return { deviceId: this.deviceId, ...this.settings }; }
  /** Like the real one: a track that was stopped no longer tells which page it captured. */
  getCaptureHandle() { return this.readyState === 'ended' ? null : this.captureHandle; }
}

let streamSerial = 0;
export class FakeMediaStream extends EventTarget {
  constructor(tracks = []) {
    super();
    this.id = `fake-media-${++streamSerial}`;
    this.tracks = [...tracks];
  }
  get active() { return this.tracks.some((track) => track.readyState !== 'ended'); }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
  clone() { return new FakeMediaStream(this.tracks.map((track) => track.clone())); }
}

// ---------------------------------------------------------------------------
// JSON semantics of the message bus: typed arrays become objects, Map becomes
// {}, undefined vanishes, and 64 MiB is the hard cap.
function serialize(value) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('Message length exceeded maximum allowed length.');
  return text;
}
const parse = (text) => (text === undefined ? undefined : JSON.parse(text));
const chromeError = (message) => new Error(message);
const domError = (name, message) => new DOMException(message, name);

function originKey(url) {
  const parsed = attempt(() => new URL(url));
  if (!parsed) return null;
  return parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//${parsed.host}`;
}
const schemeOf = (url) => attempt(() => new URL(url).protocol) ?? '';
const isWebUrl = (url) => ['http:', 'https:'].includes(schemeOf(url));
const isRestricted = (url) => RESTRICTED_SCHEMES.includes(schemeOf(url));

function matchesUrlFilter(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  const regex = new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return regex.test(url);
}

const PANEL_PATH = 'extension/panel/panel.html';
const OPTIONS_PATH = 'extension/options/options.html';
const PERMISSION_PATH = 'extension/permission/mic-permission.html';
const HOST_PATH = 'extension/engine/host.html';
const SW_PATH = 'extension/background/service-worker.js';
const CONTEXT_KINDS = Object.freeze(['panel', 'options', 'permission', 'offscreen', 'content']);
const DEFAULT_PATHS = Object.freeze({ panel: PANEL_PATH, options: OPTIONS_PATH, permission: PERMISSION_PATH, offscreen: HOST_PATH });
const CONTEXT_TYPES = Object.freeze({ offscreen: 'OFFSCREEN_DOCUMENT', panel: 'SIDE_PANEL', options: 'TAB', permission: 'TAB', sw: 'BACKGROUND' });

export function createFakeBrowser({
  extensionId = 'abcdefghijklmnopabcdefghijklmnop',
  strictGesture = true,
  // What sendMessage does when listeners exist but none answers: real Chrome is
  // believed to reject ('reject', assumption A24); the first draft assumed undefined.
  noResponder = 'reject',
  // false: the service worker's MessageSender has no `url` (assumption A23).
  swSenderHasUrl = true,
  // Content context after TRUSTED_CONTEXTS: no chrome.storage at all, or the
  // object with every call rejecting (assumption A25).
  contentStorage = 'absent',
  // What commands.getAll reports for _execute_action; null = unassigned.
  shortcut = 'Alt+Shift+Y',
  messages = {},
} = {}) {
  if (!['reject', 'undefined'].includes(noResponder)) throw new TypeError('noResponder must be reject or undefined');
  if (!['absent', 'rejects'].includes(contentStorage)) throw new TypeError('contentStorage must be absent or rejects');

  const clock = createFakeClock();
  const origin = `chrome-extension://${extensionId}`;
  const url = (path = '') => `${origin}/${String(path).replace(/^\/+/, '')}`;
  const resolveUrl = (value) => (/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : url(value));

  const browser = {};
  const contexts = new Set();
  const tabs = new Map();
  const grants = new Map();
  const streamIds = new Map();
  const captures = new Map();
  const areas = { local: new Map(), session: new Map() };
  const deliveries = [];
  const listenerErrors = [];
  const menus = [];
  const injections = [];
  const panelOpens = [];
  const autoPanelOpens = [];
  const sw = { bootstrap: null, context: null, starts: 0, wake: new Set(), idleTimer: null, idleTimeoutMs: SW_IDLE_MS };
  const state = {
    tabSerial: 100, contextSerial: 0, streamSerial: 0, focusedWindowId: 1, gestureActive: false,
    accessLevel: null, failAccess: false, panelBehavior: { openPanelOnActionClick: false },
    offscreen: null, optionsOpens: 0, shortcut, contentScripts: true, audible: false,
  };

  const log = (from, to, kind, json, extra = {}) => { deliveries.push({ from, to, kind, json, ...extra }); };
  const recordError = (error) => { listenerErrors.push(error); };
  // Test-owned hooks (browser.onCreateOffscreen, onInject, ...) may throw or
  // reject: that is a page failing, never the fake's own failure, so it is
  // recorded in browser.listenerErrors and the browser call carries on.
  const hook = async (name, ...args) => { try { await browser[name]?.(...args); } catch (error) { recordError(error); } };
  const hookSync = (name, ...args) => { try { browser[name]?.(...args); } catch (error) { recordError(error); } };

  // -------------------------------------------------------------------------
  // Contexts
  const isDeadSw = (context) => context.kind === 'sw' && !context.alive;
  const hasListener = (context, name) => (context.listeners.get(name)?.length ?? 0) > 0;
  const assertAlive = (context) => {
    if (!context.alive || context.invalidated) throw chromeError(INVALIDATED_ERROR);
  };
  const touchSw = () => { if (sw.context?.alive) armIdle(); };
  const armIdle = () => {
    clock.clearTimeout(sw.idleTimer);
    sw.idleTimer = clock.setTimeout(() => { sw.idleTimer = null; killSw(); }, sw.idleTimeoutMs);
  };
  // Every chrome.* function of a context goes through this guard: a killed
  // service worker's stale closures fail the way an invalidated one does, and
  // any API call counts as activity for the idle timer.
  const guarded = (context, fn) => (...args) => {
    assertAlive(context);
    if (context.kind === 'sw') touchSw();
    return fn(...args);
  };

  function makeEvent(context, name) {
    return Object.freeze({
      addListener(listener) {
        assertAlive(context);
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        const list = context.listeners.get(name) ?? [];
        if (!list.includes(listener)) list.push(listener);
        context.listeners.set(name, list);
        if (context.kind === 'sw') sw.wake.add(name);
      },
      removeListener(listener) {
        const list = context.listeners.get(name);
        if (list) context.listeners.set(name, list.filter((item) => item !== listener));
      },
      hasListener: (listener) => (context.listeners.get(name) ?? []).includes(listener),
      hasListeners: () => hasListener(context, name),
    });
  }

  function senderOf(context) {
    if (context.kind === 'sw') return { id: extensionId, ...(swSenderHasUrl ? { url: context.url } : {}), origin };
    if (context.kind === 'content') {
      return { id: extensionId, url: context.url, origin: originKey(context.url),
        tab: tabView(tabs.get(context.tabId)), frameId: context.frameId };
    }
    const sender = { id: extensionId, url: context.url, origin };
    if (context.tabId !== null && tabs.has(context.tabId)) {
      sender.tab = tabView(tabs.get(context.tabId));
      sender.frameId = context.frameId;
    }
    return sender;
  }

  // Runs one event's listeners. With `gesture` the user-gesture flag is up for
  // the SYNCHRONOUS part of each listener call only (strict model).
  function fire(context, name, args, { gesture = false } = {}) {
    const results = [];
    for (const listener of [...(context.listeners.get(name) ?? [])]) {
      const previous = state.gestureActive;
      state.gestureActive = gesture;
      try {
        const result = listener(...parse(serialize(args) ?? '[]'));
        results.push(Promise.resolve(result));
        if (result && typeof result.catch === 'function') result.catch(recordError);
      } catch (error) {
        recordError(error);
        results.push(Promise.reject(error));
      } finally { state.gestureActive = previous; }
    }
    for (const result of results) result.catch(() => {});
    return results;
  }

  // Delivers a browser event to every context that listens to it, later in the
  // same task queue (real events are asynchronous). A dead service worker that
  // registered the event is woken first.
  function broadcast(name, args, { include = () => true } = {}) {
    queueMicrotask(() => {
      for (const context of [...contexts]) {
        if (context.kind === 'sw' || context.invalidated || !include(context) || !hasListener(context, name)) continue;
        fire(context, name, args);
      }
      const worker = sw.context;
      if (worker && include(worker) && (worker.alive ? hasListener(worker, name) : sw.wake.has(name))) {
        const live = worker.alive ? worker : startSw();
        if (worker.alive) armIdle();
        fire(live, name, args);
      }
    });
  }

  function makeContext(kind, { url: pageUrl, tabId = null, frameId = 0, windowId = null } = {}) {
    const context = {
      id: ++state.contextSerial, kind, url: pageUrl, tabId, frameId, windowId,
      alive: true, invalidated: false, listeners: new Map(), ports: new Set(), closeHooks: new Set(),
      storageTouched: false,
      get sender() { return senderOf(context); },
      onClose(fn) { context.closeHooks.add(fn); },
      close() { closeContext(context); },
      // The extension was reloaded or updated under a running content script:
      // chrome.runtime.id vanishes, every API throws, its ports die.
      invalidate() {
        if (context.invalidated) return;
        context.invalidated = true;
        if (context.chrome?.runtime) context.chrome.runtime.id = undefined;
        for (const port of [...context.ports]) port._end({ fireOwn: true });
        for (const onClose of [...context.closeHooks]) attempt(() => onClose());
        context.closeHooks.clear();
      },
    };
    context.chrome = buildChrome(context);
    contexts.add(context);
    return context;
  }

  function closeContext(context) {
    if (!context.alive) return;
    context.alive = false;
    contexts.delete(context);
    for (const port of [...context.ports]) port._end({ fireOwn: false });
    for (const onClose of [...context.closeHooks]) attempt(() => onClose());
    context.closeHooks.clear();
    context.listeners.clear();
    if (state.offscreen?.context === context) state.offscreen = null;
    if (context.kind === 'sw') { clock.clearTimeout(sw.idleTimer); sw.idleTimer = null; }
  }

  // A revived worker that throws while bootstrapping is recorded (nobody is
  // waiting for it); register() lets the first failure reach the test.
  function startSw({ propagate = false } = {}) {
    const context = makeContext('sw', { url: url(SW_PATH) });
    sw.context = context;
    sw.starts++;
    armIdle();
    try { sw.bootstrap?.(context.chrome); } catch (error) { if (propagate) throw error; recordError(error); }
    return context;
  }
  function killSw() {
    if (!sw.context?.alive) return false;
    closeContext(sw.context);
    return true;
  }
  // Returns the live service worker context for an event, waking it when it
  // registered that event before it died (Chrome persists event registrations).
  function liveSw(name) {
    const worker = sw.context;
    if (!worker) return null;
    if (worker.alive) return worker;
    return sw.wake.has(name) ? startSw() : null;
  }

  // -------------------------------------------------------------------------
  // Messages: JSON both ways, fan-out to every other context with a listener,
  // first sendResponse wins, a listener returning true keeps the channel open.
  function messageRecipients(from) {
    const out = [...contexts].filter((context) => context !== from && context.kind !== 'content'
      && !context.invalidated && hasListener(context, 'runtime.onMessage'));
    const worker = sw.context;
    if (worker && !worker.alive && worker !== from && sw.wake.has('runtime.onMessage')) out.push(worker);
    return out;
  }
  const contentRecipients = (tabId, frameId) => [...contexts].filter((context) => context.kind === 'content'
    && context.tabId === tabId && !context.invalidated && (frameId === undefined || context.frameId === frameId)
    && hasListener(context, 'runtime.onMessage'));

  function dispatchMessage(from, recipients, text) {
    return new Promise((resolve, reject) => {
      let answered = false, open = 0, invoked = 0;
      const hooks = [];
      const settled = () => { answered = true; for (const [owner, onClose] of hooks) owner.closeHooks.delete(onClose); };
      const settleEmpty = () => {
        if (answered) return;
        settled();
        if (noResponder === 'reject') reject(chromeError(PORT_CLOSED_ERROR));
        else resolve(undefined);
      };
      for (const target of recipients) {
        const context = isDeadSw(target) ? liveSw('runtime.onMessage') : target;
        if (!context) continue;
        if (context.kind === 'sw') armIdle();
        for (const listener of [...(context.listeners.get('runtime.onMessage') ?? [])]) {
          invoked++;
          log(from.kind, context.kind, 'message', text ?? '', { fromId: from.id, toId: context.id });
          const respond = (value) => {
            if (answered) return;
            let out;
            try { out = serialize(value); } catch (error) { settled(); reject(error); return; }
            settled();
            log(context.kind, from.kind, 'response', out ?? '', { fromId: context.id, toId: from.id });
            resolve(parse(out));
          };
          let returned;
          try { returned = listener(parse(text), parse(serialize(senderOf(from))), respond); } catch (error) { recordError(error); continue; }
          if (returned === true) {
            open++;
            // The channel dies without an answer when the responder goes away.
            const onClose = () => { open--; if (open === 0 && !answered) settleEmpty(); };
            hooks.push([context, onClose]);
            context.onClose(onClose);
          }
        }
      }
      if (invoked === 0) { settled(); reject(chromeError(NO_RECEIVER_ERROR)); return; }
      if (!answered && open === 0) settleEmpty();
    });
  }

  // Serialization happens in the calling turn, so an unserializable or
  // oversize message THROWS synchronously (the 64 MiB cap); everything after it
  // (delivery, the answer) is asynchronous and rejects instead.
  function sendMessageFrom(from, message) {
    const text = serialize(message);
    return (async () => {
      await null;
      const recipients = messageRecipients(from);
      if (!recipients.length) throw chromeError(NO_RECEIVER_ERROR);
      return dispatchMessage(from, recipients, text);
    })();
  }
  function sendTabMessageFrom(from, tabId, message, options = {}) {
    if (!Number.isInteger(tabId)) throw new TypeError('tabId must be an integer');
    const text = serialize(message);
    return (async () => {
      await null;
      if (!tabs.has(tabId)) throw chromeError(`No tab with id: ${tabId}.`);
      const recipients = contentRecipients(tabId, options?.frameId);
      if (!recipients.length) throw chromeError(NO_RECEIVER_ERROR);
      return dispatchMessage(from, recipients, text);
    })();
  }

  // -------------------------------------------------------------------------
  // Ports. One channel = one sender port + one port per receiving context. A
  // receiver's disconnect() notifies ONLY the sender (observed); a sender's
  // disconnect() notifies every receiver. Frames are JSON both ways.
  function makePortEnd(owner, name, sender, channel, isSender) {
    const onMessageListeners = [], onDisconnectListeners = [];
    const port = {
      name, ...(sender ? { sender } : {}), disconnected: false,
      onMessage: Object.freeze({
        addListener: (fn) => { onMessageListeners.push(fn); },
        removeListener: (fn) => { const at = onMessageListeners.indexOf(fn); if (at >= 0) onMessageListeners.splice(at, 1); },
        hasListener: (fn) => onMessageListeners.includes(fn),
      }),
      onDisconnect: Object.freeze({
        addListener: (fn) => { onDisconnectListeners.push(fn); },
        removeListener: (fn) => { const at = onDisconnectListeners.indexOf(fn); if (at >= 0) onDisconnectListeners.splice(at, 1); },
        hasListener: (fn) => onDisconnectListeners.includes(fn),
      }),
      postMessage(message) {
        if (port.disconnected || owner.invalidated) throw chromeError('Attempting to use a disconnected port object');
        const text = serialize(message);
        if (owner.kind === 'sw') touchSw();
        const targets = isSender ? channel.receivers : [channel.sender];
        queueMicrotask(() => {
          for (const target of targets) {
            if (target.disconnected || target._owner.invalidated) continue;
            log(owner.kind, target._owner.kind, 'port-frame', text ?? '', { fromId: owner.id, toId: target._owner.id, port: name });
            if (target._owner.kind === 'sw') touchSw();
            for (const fn of [...target._messageListeners]) {
              try { fn(parse(text), target); } catch (error) { recordError(error); }
            }
          }
        });
      },
      disconnect() {
        if (port.disconnected) return;
        port._end({ fireOwn: false });
      },
      _owner: owner, _messageListeners: onMessageListeners, _isSender: isSender,
      _notify(error) {
        if (port.disconnected) return;
        port.disconnected = true;
        owner.ports.delete(port);
        if (error) port.error = error;
        queueMicrotask(() => { for (const fn of [...onDisconnectListeners]) attempt(() => fn(port)); });
      },
      _end({ fireOwn }) {
        if (port.disconnected) return;
        port.disconnected = true;
        owner.ports.delete(port);
        if (isSender) for (const receiver of channel.receivers) receiver._notify();
        else channel.sender._notify();
        if (fireOwn) queueMicrotask(() => { for (const fn of [...onDisconnectListeners]) attempt(() => fn(port)); });
      },
    };
    owner.ports.add(port);
    return port;
  }

  function connectFrom(from, info) {
    assertAlive(from);
    const name = typeof info?.name === 'string' ? info.name : '';
    const channel = { receivers: [], sender: null };
    const senderPort = makePortEnd(from, name, null, channel, true);
    channel.sender = senderPort;
    const senderInfo = parse(serialize(senderOf(from)));
    const candidates = [...contexts].filter((context) => context !== from && context.kind !== 'content'
      && !context.invalidated && hasListener(context, 'runtime.onConnect'));
    const worker = sw.context;
    if (worker && !worker.alive && worker !== from && sw.wake.has('runtime.onConnect')) candidates.push(worker);
    if (!candidates.length) {
      queueMicrotask(() => senderPort._notify(chromeError(NO_RECEIVER_ERROR)));
      return senderPort;
    }
    queueMicrotask(() => {
      for (const candidate of candidates) {
        // Opening a port wakes a dead worker but never resets a live one's idle timer.
        const context = isDeadSw(candidate) ? liveSw('runtime.onConnect') : candidate;
        if (!context || !context.alive) continue;
        const receiver = makePortEnd(context, name, senderInfo, channel, false);
        channel.receivers.push(receiver);
        for (const fn of [...(context.listeners.get('runtime.onConnect') ?? [])]) {
          try { fn(receiver); } catch (error) { recordError(error); }
        }
      }
      if (!channel.receivers.length) senderPort._notify(chromeError(NO_RECEIVER_ERROR));
    });
    return senderPort;
  }

  // -------------------------------------------------------------------------
  // Tabs and windows
  function tabView(tab) {
    if (!tab) return undefined;
    return { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, active: tab.active, status: tab.status,
      index: [...tabs.values()].filter((item) => item.windowId === tab.windowId).indexOf(tab), incognito: false };
  }
  function markActive(tab) {
    for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
    tab.active = true;
  }
  function closeContentFor(tabId) {
    for (const context of [...contexts]) if (context.tabId === tabId && context.kind === 'content') closeContext(context);
  }
  function createContentFor(tab) {
    if (!state.contentScripts || !isWebUrl(tab.url)) return null;
    const context = makeContext('content', { url: tab.url, tabId: tab.id, frameId: 0 });
    hookSync('onContentCreated', context);
    return context;
  }
  function endCapture(tabId) {
    const capture = captures.get(tabId);
    if (capture) capture.source.endAll();
    captures.delete(tabId);
  }

  function requireTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) throw chromeError(`No tab with id: ${tabId}.`);
    return tab;
  }

  const wrap = (context, api) => {
    for (const [name, value] of Object.entries(api)) if (typeof value === 'function') api[name] = guarded(context, value);
    return api;
  };

  const tabsApi = (context) => wrap(context, {
    get: async (tabId) => tabView(requireTab(tabId)),
    query: async (filter = {}) => [...tabs.values()].filter((tab) => {
      if (filter.active !== undefined && tab.active !== filter.active) return false;
      if (filter.windowId !== undefined && tab.windowId !== filter.windowId) return false;
      if ((filter.lastFocusedWindow === true || filter.currentWindow === true) && tab.windowId !== state.focusedWindowId) return false;
      if ((filter.lastFocusedWindow === false || filter.currentWindow === false) && tab.windowId === state.focusedWindowId) return false;
      if (filter.status !== undefined && tab.status !== filter.status) return false;
      if (filter.url !== undefined) {
        const patterns = Array.isArray(filter.url) ? filter.url : [filter.url];
        if (!patterns.some((pattern) => matchesUrlFilter(pattern, tab.url))) return false;
      }
      return true;
    }).map(tabView),
    create: async ({ url: target = 'about:blank', active = true, windowId } = {}) => {
      const tab = addTab({ url: target, windowId: windowId ?? state.focusedWindowId, active: false });
      if (active) {
        markActive(tab);
        broadcast('tabs.onActivated', [{ tabId: tab.id, windowId: tab.windowId }]);
      }
      hookSync('onTabCreate', tabView(tab));
      return tabView(tab);
    },
    update: async (tabId, properties = {}) => {
      const tab = requireTab(tabId);
      if (properties.active === true) {
        markActive(tab);
        broadcast('tabs.onActivated', [{ tabId: tab.id, windowId: tab.windowId }]);
      }
      if (typeof properties.url === 'string') void browser.navigate(tabId, properties.url).catch(recordError);
      return tabView(tab);
    },
    sendMessage: (tabId, message, options) => sendTabMessageFrom(context, tabId, message, options),
    onRemoved: makeEvent(context, 'tabs.onRemoved'),
    onUpdated: makeEvent(context, 'tabs.onUpdated'),
    onActivated: makeEvent(context, 'tabs.onActivated'),
  });

  function addTab({ id, url: tabUrl = 'about:blank', windowId = 1, active, title = '', content = true } = {}) {
    const tabId = id ?? ++state.tabSerial;
    if (tabs.has(tabId)) throw new Error(`tab ${tabId} already exists`);
    const first = ![...tabs.values()].some((tab) => tab.windowId === windowId);
    const tab = { id: tabId, url: tabUrl, windowId, active: false, title, status: 'complete' };
    tabs.set(tabId, tab);
    if (active === true || (active === undefined && first)) markActive(tab);
    if (content) createContentFor(tab);
    return tab;
  }

  // -------------------------------------------------------------------------
  // Storage
  function accessible(context, areaName) {
    if (context.kind === 'offscreen') return false;
    if (context.kind !== 'content') return true;
    return areaName === 'local' && state.accessLevel !== 'TRUSTED_CONTEXTS';
  }
  function storageArea(context, areaName) {
    const data = areas[areaName];
    const deny = () => {
      if (context.kind === 'content' && !accessible(context, areaName)) return Promise.reject(chromeError(STORAGE_DENIED_ERROR));
      return null;
    };
    const commit = (changes) => {
      if (!Object.keys(changes).length) return;
      broadcast('storage.onChanged', [changes, areaName], { include: (target) => accessible(target, areaName) });
    };
    const area = {
      get: async (keys) => {
        const denied = deny(); if (denied) return denied;
        const out = {};
        const copy = (value) => parse(serialize(value));
        if (keys === null || keys === undefined) { for (const [key, value] of data) out[key] = copy(value); return out; }
        if (typeof keys === 'string') { if (data.has(keys)) out[keys] = copy(data.get(keys)); return out; }
        if (Array.isArray(keys)) { for (const key of keys) if (data.has(key)) out[key] = copy(data.get(key)); return out; }
        for (const [key, fallback] of Object.entries(keys)) out[key] = data.has(key) ? copy(data.get(key)) : copy(fallback);
        return out;
      },
      set: async (items) => {
        const denied = deny(); if (denied) return denied;
        if (!items || typeof items !== 'object' || Array.isArray(items)) throw new TypeError('items must be an object');
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          const text = serialize(value);
          if (text === undefined) continue;
          const previous = data.has(key) ? serialize(data.get(key)) : undefined;
          if (previous === text) continue;
          data.set(key, parse(text));
          changes[key] = { ...(previous === undefined ? {} : { oldValue: parse(previous) }), newValue: parse(text) };
        }
        commit(changes);
      },
      remove: async (keys) => {
        const denied = deny(); if (denied) return denied;
        const changes = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (!data.has(key)) continue;
          changes[key] = { oldValue: parse(serialize(data.get(key))) };
          data.delete(key);
        }
        commit(changes);
      },
    };
    if (areaName === 'local' && context.kind !== 'content') {
      area.setAccessLevel = async ({ accessLevel } = {}) => {
        if (state.failAccess) throw chromeError('Storage access level could not be set.');
        if (!['TRUSTED_CONTEXTS', 'TRUSTED_AND_UNTRUSTED_CONTEXTS'].includes(accessLevel)) throw new TypeError('invalid accessLevel');
        state.accessLevel = accessLevel;
      };
    }
    return wrap(context, area);
  }
  function storageApi(context) {
    return { local: storageArea(context, 'local'), ...(context.kind === 'content' ? {} : { session: storageArea(context, 'session') }),
      onChanged: makeEvent(context, 'storage.onChanged') };
  }

  // -------------------------------------------------------------------------
  // tabCapture: exact Chromium error strings, per-tab activeTab grant,
  // single-use stream ids that expire.
  function hasPendingId(tabId) {
    return [...streamIds.values()].some((entry) => entry.tabId === tabId && !entry.used && entry.expiresAt > clock.now());
  }
  async function getMediaStreamId({ targetTabId } = {}) {
    const tabId = targetTabId ?? [...tabs.values()].find((tab) => tab.active && tab.windowId === state.focusedWindowId)?.id;
    const tab = tabs.get(tabId);
    if (!tab) throw chromeError(INVALID_TAB_ERROR);
    if (!grants.has(tabId)) throw chromeError(GRANT_ERROR);
    if (isRestricted(tab.url)) throw chromeError(CANNOT_CAPTURE_ERROR);
    if (captures.has(tabId) || hasPendingId(tabId)) throw chromeError(ACTIVE_STREAM_ERROR);
    const id = `fake-stream-${++state.streamSerial}`;
    streamIds.set(id, { tabId, expiresAt: clock.now() + STREAM_ID_TTL_MS, used: false });
    return id;
  }
  function consumeStreamId(id, { video = false } = {}) {
    const entry = streamIds.get(id);
    if (!entry || entry.used || entry.expiresAt <= clock.now() || !tabs.has(entry.tabId)) {
      throw domError('NotAllowedError', 'Error starting tab capture');
    }
    entry.used = true;
    const source = createMediaSource(() => { if (captures.get(entry.tabId) === capture) captures.delete(entry.tabId); });
    const stream = new FakeMediaStream([new FakeTrack({ kind: 'audio', label: `tab-${entry.tabId}`, source })]);
    if (video) stream.addTrack(new FakeTrack({ kind: 'video', label: `tab-${entry.tabId}`, source }));
    const capture = { tabId: entry.tabId, streamId: id, stream, source, startedAt: clock.now() };
    captures.set(entry.tabId, capture);
    return stream;
  }

  // -------------------------------------------------------------------------
  // Offscreen document
  const openDocument = (pageUrl) => makeContext('offscreen', { url: resolveUrl(pageUrl) });
  const offscreenApi = () => ({
    createDocument: async ({ url: pageUrl, reasons, justification } = {}) => {
      if (state.offscreen) throw chromeError(SINGLE_DOCUMENT_ERROR);
      if (!Array.isArray(reasons) || !reasons.length || !reasons.every((reason) => OFFSCREEN_REASONS.includes(reason))) {
        throw chromeError(REASON_ERROR);
      }
      if (typeof justification !== 'string' || !justification.trim()) throw chromeError('A `justification` must be provided.');
      if (typeof pageUrl !== 'string' || !pageUrl) throw chromeError('A `url` must be provided.');
      const created = openDocument(pageUrl);
      const record = { url: pageUrl, reasons: [...reasons] };
      Object.defineProperty(record, 'context', { value: created, enumerable: false });
      state.offscreen = record;
      // A document that only plays audio is closed by Chrome after 30 s
      // without audible output; the reasons list decides, the clock drives it.
      if (reasons.length === 1 && reasons[0] === 'AUDIO_PLAYBACK') {
        const check = () => {
          if (state.offscreen !== record) return;
          if (state.audible) { clock.setTimeout(check, AUDIO_PLAYBACK_CLOSE_MS); return; }
          closeContext(created);
          state.offscreen = null;
        };
        clock.setTimeout(check, AUDIO_PLAYBACK_CLOSE_MS);
      }
      // createDocument resolves after the initial load; a hook that throws is
      // a page whose script failed (a zombie: the document stays, nobody answers).
      await hook('onCreateOffscreen', created);
    },
    closeDocument: async () => {
      if (!state.offscreen) throw chromeError(NO_DOCUMENT_ERROR);
      closeContext(state.offscreen.context);
      state.offscreen = null;
    },
  });

  function getContexts({ contextTypes, documentUrls } = {}) {
    return [...contexts].filter((context) => CONTEXT_TYPES[context.kind] !== undefined)
      .map((context) => ({ contextType: CONTEXT_TYPES[context.kind], contextId: `fake-context-${context.id}`,
        documentUrl: context.url, documentOrigin: origin,
        tabId: context.tabId ?? -1, frameId: context.tabId === null ? -1 : context.frameId, windowId: -1, incognito: false }))
      .filter((record) => (!contextTypes || contextTypes.includes(record.contextType))
        && (!documentUrls || documentUrls.includes(record.documentUrl)));
  }

  // -------------------------------------------------------------------------
  // chrome.* per context kind
  function buildChrome(context) {
    const g = (fn) => guarded(context, fn);
    const offscreenRuntime = {
      id: extensionId,
      getURL: g((path = '') => url(path)),
      sendMessage: g((message) => sendMessageFrom(context, message)),
      connect: g((info) => connectFrom(context, info)),
      onMessage: makeEvent(context, 'runtime.onMessage'),
      onConnect: makeEvent(context, 'runtime.onConnect'),
    };
    if (context.kind === 'offscreen') return { runtime: offscreenRuntime };
    if (context.kind === 'content') {
      const chromeObject = {
        runtime: { id: extensionId, connect: offscreenRuntime.connect, onMessage: offscreenRuntime.onMessage,
          sendMessage: offscreenRuntime.sendMessage },
        i18n: i18nApi(context),
      };
      // The storage object is decided at access time: it depends on the access
      // level that the service worker (or options page) sets later.
      Object.defineProperty(chromeObject, 'storage', { enumerable: true, get() {
        context.storageTouched = true;
        if (state.accessLevel === 'TRUSTED_CONTEXTS' && contentStorage === 'absent') return undefined;
        return storageApi(context);
      } });
      return chromeObject;
    }
    const chromeObject = {
      runtime: { ...offscreenRuntime,
        openOptionsPage: g(async () => { state.optionsOpens++; hookSync('onOpenOptions'); }),
        getContexts: g(async (filter) => getContexts(filter)),
        onInstalled: makeEvent(context, 'runtime.onInstalled'),
        onStartup: makeEvent(context, 'runtime.onStartup') },
      storage: storageApi(context),
      tabs: tabsApi(context),
      windows: { getCurrent: g(async () => ({ id: context.windowId ?? state.focusedWindowId, focused: true, type: 'normal' })) },
      commands: { getAll: g(async () => [{ name: '_execute_action', description: '', shortcut: state.shortcut ?? '' }]) },
      i18n: i18nApi(context),
    };
    if (context.kind === 'sw') {
      Object.assign(chromeObject, {
        tabCapture: { getMediaStreamId: g(getMediaStreamId),
          getCapturedTabs: g(async () => [...captures.values()].map((capture) => ({ tabId: capture.tabId, status: 'active', fullscreen: false }))) },
        sidePanel: {
          open: g((options = {}) => {
            if (strictGesture && !state.gestureActive) return Promise.reject(chromeError(GESTURE_ERROR));
            if (!Number.isInteger(options.tabId) && !Number.isInteger(options.windowId)) {
              return Promise.reject(chromeError('At least one of `tabId` or `windowId` must be specified.'));
            }
            if (Number.isInteger(options.tabId) && !tabs.has(options.tabId)) return Promise.reject(chromeError(`No tab with id: ${options.tabId}.`));
            const record = { windowId: options.windowId ?? null, tabId: options.tabId ?? null };
            panelOpens.push(record);
            hookSync('onPanelOpen', record);
            return Promise.resolve();
          }),
          setPanelBehavior: g(async ({ openPanelOnActionClick } = {}) => {
            if (typeof openPanelOnActionClick !== 'boolean') throw new TypeError('openPanelOnActionClick must be a boolean');
            state.panelBehavior = { openPanelOnActionClick };
          }),
        },
        action: { onClicked: makeEvent(context, 'action.onClicked') },
        contextMenus: {
          create: g((properties = {}) => {
            if (typeof properties.id !== 'string' || !properties.id) throw new TypeError('id must be a non-empty string');
            if (menus.some((menu) => menu.id === properties.id)) throw chromeError(`Cannot create item with duplicate id ${properties.id}`);
            menus.push(parse(serialize(properties)));
            return properties.id;
          }),
          removeAll: g(async () => { menus.length = 0; }),
          onClicked: makeEvent(context, 'contextMenus.onClicked'),
        },
        offscreen: offscreenApi(),
        scripting: {
          executeScript: g(async ({ target, files } = {}) => {
            const tab = requireTab(target?.tabId);
            if (!grants.has(tab.id)) throw chromeError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
            injections.push({ tabId: tab.id, files: [...(files ?? [])] });
            await hook('onInject', tab.id, [...(files ?? [])]);
            return [{ frameId: 0, result: null }];
          }),
        },
      });
    }
    return chromeObject;
  }
  function i18nApi(context) {
    return {
      getMessage: guarded(context, (name, substitutions) => {
        const entry = messages[name];
        const text = typeof entry === 'string' ? entry : entry?.message ?? '';
        const list = substitutions === undefined ? [] : [].concat(substitutions);
        return text.replace(/\$(\d)/g, (_match, index) => list[Number(index) - 1] ?? '');
      }),
      getUILanguage: guarded(context, () => 'en'),
    };
  }

  // -------------------------------------------------------------------------
  // Invocation (toolbar click, shortcut, context menu). Each one grants
  // tabCapture + activeTab for that tab BEFORE the listeners run, and holds
  // the gesture flag up for the synchronous part of every listener call.
  function invoke(tabId, { needsSuppression, eventName, argsOf }) {
    const tab = requireTab(tabId);
    if (needsSuppression && state.panelBehavior.openPanelOnActionClick) {
      autoPanelOpens.push({ tabId, windowId: tab.windowId });
      return Promise.resolve([]);
    }
    grants.set(tabId, { origin: originKey(tab.url), at: clock.now() });
    const worker = liveSw(eventName);
    if (!worker) return Promise.resolve([]);
    armIdle();
    const results = fire(worker, eventName, argsOf(tab), { gesture: true });
    return Promise.allSettled(results).then(async (settled) => { await flush(); return settled; });
  }

  // defineProperties, not assign: the accessors below must stay accessors.
  Object.defineProperties(browser, Object.getOwnPropertyDescriptors({
    extensionId, origin, url, clock, tabs, grants, captures, deliveries, listenerErrors, menus, injections, panelOpens, autoPanelOpens,
    settle: flush,
    get contentScripts() { return state.contentScripts; },
    set contentScripts(value) { state.contentScripts = Boolean(value); },
    get audible() { return state.audible; },
    set audible(value) { state.audible = Boolean(value); },
    get shortcut() { return state.shortcut; },
    set shortcut(value) { state.shortcut = value; },
    get accessLevel() { return state.accessLevel; },
    get panelBehavior() { return { ...state.panelBehavior }; },
    get offscreenDocument() { return state.offscreen; },
    get gestureActive() { return state.gestureActive; },
    get optionsOpens() { return state.optionsOpens; },
    get focusedWindowId() { return state.focusedWindowId; },
    failSetAccessLevel(value = true) { state.failAccess = Boolean(value); },
    storageData(areaName) { return Object.fromEntries([...areas[areaName]].map(([key, value]) => [key, parse(serialize(value))])); },
    hasGrant: (tabId) => grants.has(tabId),
    hasContent: (tabId) => [...contexts].some((context) => context.kind === 'content' && context.tabId === tabId),
    contentContext: (tabId) => [...contexts].find((context) => context.kind === 'content' && context.tabId === tabId && context.frameId === 0),
    contexts: () => [...contexts],
    consumeStreamId,
    addTab,
    tabRecord: (tabId) => tabView(tabs.get(tabId)),

    async navigate(tabId, target) {
      const tab = requireTab(tabId);
      const previous = tab.url;
      tab.url = target; tab.status = 'loading';
      if (originKey(previous) !== originKey(target)) grants.delete(tabId);
      closeContentFor(tabId);
      broadcast('tabs.onUpdated', [tabId, { status: 'loading', url: target }, tabView(tab)]);
      await flush();
      tab.status = 'complete';
      createContentFor(tab);
      broadcast('tabs.onUpdated', [tabId, { status: 'complete' }, tabView(tab)]);
      await flush();
    },
    // Same-document navigation (history.pushState): the grant and the content
    // script survive, only the url change is reported.
    async pushState(tabId, target) {
      const tab = requireTab(tabId);
      tab.url = target;
      broadcast('tabs.onUpdated', [tabId, { url: target }, tabView(tab)]);
      await flush();
    },
    async closeTab(tabId) {
      const tab = requireTab(tabId);
      tabs.delete(tabId);
      for (const context of [...contexts]) if (context.tabId === tabId) closeContext(context);
      endCapture(tabId);
      grants.delete(tabId);
      broadcast('tabs.onRemoved', [tabId, { windowId: tab.windowId, isWindowClosing: false }]);
      await flush();
    },
    async activateTab(tabId) {
      const tab = requireTab(tabId);
      markActive(tab);
      broadcast('tabs.onActivated', [{ tabId, windowId: tab.windowId }]);
      await flush();
    },
    focusWindow(windowId) { state.focusedWindowId = windowId; },

    // Browser start: the service worker runs (or is revived) and hears onStartup.
    async startup() {
      const worker = liveSw('runtime.onStartup');
      if (worker) { armIdle(); fire(worker, 'runtime.onStartup', []); }
      await flush();
    },
    async install(reason = 'install') {
      const worker = liveSw('runtime.onInstalled');
      if (worker) { armIdle(); fire(worker, 'runtime.onInstalled', [{ reason }]); }
      await flush();
    },

    createContext(kind, { url: pageUrl, tabId, frameId = 0, windowId } = {}) {
      if (!CONTEXT_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${CONTEXT_KINDS.join(', ')}`);
      if (kind === 'content') {
        const tab = requireTab(tabId);
        return makeContext('content', { url: pageUrl ?? tab.url, tabId, frameId });
      }
      if (tabId !== undefined) requireTab(tabId);
      return makeContext(kind, { url: resolveUrl(pageUrl ?? DEFAULT_PATHS[kind]), tabId: tabId ?? null, frameId, windowId: windowId ?? null });
    },

    sw: Object.freeze({
      /** Creates the service worker and runs `bootstrap(chrome)` now and at every later start. */
      register(bootstrap) {
        if (typeof bootstrap !== 'function') throw new TypeError('bootstrap must be a function');
        killSw();
        sw.bootstrap = bootstrap;
        sw.wake.clear();
        return startSw({ propagate: true });
      },
      get running() { return sw.context?.alive === true; },
      get starts() { return sw.starts; },
      get context() { return sw.context; },
      get idleTimeoutMs() { return sw.idleTimeoutMs; },
      set idleTimeoutMs(value) { sw.idleTimeoutMs = value; if (sw.context?.alive) armIdle(); },
      kill: killSw,
    }),

    clickAction: (tabId) => invoke(tabId, { needsSuppression: true, eventName: 'action.onClicked', argsOf: (tab) => [tabView(tab)] }),
    pressShortcut: (tabId) => (state.shortcut === null || state.shortcut === undefined ? Promise.resolve([])
      : invoke(tabId, { needsSuppression: true, eventName: 'action.onClicked', argsOf: (tab) => [tabView(tab)] })),
    clickContextMenu(tabId, menuItemId) {
      if (!menus.some((item) => item.id === menuItemId)) throw new Error(`No context menu item ${menuItemId}`);
      return invoke(tabId, { needsSuppression: false, eventName: 'contextMenus.onClicked',
        argsOf: (tab) => [{ menuItemId, pageUrl: tab.url, frameId: 0, editable: false }, tabView(tab)] });
    },
    /** A user gesture without any grant (a click inside a page or the panel). */
    withGesture(fn) {
      const previous = state.gestureActive;
      state.gestureActive = true;
      try { return fn(); } finally { state.gestureActive = previous; }
    },
  }));
  return browser;
}
