// New implementation of docs/extension.md §5.2, §5.6.3, §5.7 and §5.8; no legacy code is ported.
// createLaneHost: the offscreen document's brain. It owns both lanes, the two port hubs, the frame coalescer and the
// live settings, and answers the service worker's `host/*` messages. Nothing here names a `chrome` global: the
// runtime arrives as `adapter.runtime` (the only namespace an offscreen document has; of its members only id, getURL,
// sendMessage, onMessage and onConnect are used, so the six-member rule of 3.4 holds). The API key passes through here inside one
// `host/lane-start` message and is never stored, logged or put in a frame; frames are built from LaneState and
// CaptionFrame only, so no audio, stream id, session id or key can be in them.
import { DEFAULT_STYLE, ORIGINAL_VOLUME, deepFreeze } from '../lib/constants.js';
import { buildCaptionFrame, buildStyleFrame, createFrameCoalescer } from '../lib/caption-frames.js';
import { LANES, LIMITS, PORT_NAMES, PROTOCOL_VERSION, createMessageRouter, makeFrame, makeMessage,
  validateFrame } from '../lib/protocol.js';
import { ACTIVE_PHASES, buildUiState, createIdleLaneState, laneStateFromSnapshot } from '../lib/ui-state.js';
import { createMicLane } from './mic-lane.js';
import { createOverlayHub } from './overlay-hub.js';
import { createPanelHub } from './panel-hub.js';
import { createTabLane } from './tab-lane.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const attemptAsync = async (fn) => { try { return await fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const IDLE_REPORT_RETRY_MS = 500;
const PANEL_ROWS = 4;
// Phases in which a lane has (or is giving up) a session: their end is an event the overlay has to hear about.
const LIVE_OR_STOPPING = Object.freeze([...ACTIVE_PHASES, 'stopping']);
// Only a lost connection is announced on the page (2026-09-30). A key swap or the planned ~10-minute handover
// (LaneState.reconnectReason) reconnects while interpreting goes on; "connection lost" there would be untrue.
const alarming = (state) => state.phase === 'reconnecting' && state.reconnectReason === null;

/** The realm's own clock (hubs, coalescers, grace timers). Arrow wrappers: a native timer is never called with a foreign `this`. */
export function createRealmClock(scope = globalThis) {
  return Object.freeze({
    setTimeout: (fn, ms) => scope.setTimeout(fn, ms),
    clearTimeout: (id) => scope.clearTimeout(id),
    now: () => scope.performance.now(),
  });
}

/** The `env` of createLaneHost from a global scope and the ENGINE clock (5.13). Nothing is read until this is called. */
export function createHostEnv(scope = globalThis, clock = createRealmClock(scope)) {
  return Object.freeze({
    AudioContext: scope.AudioContext,
    AudioWorkletNode: scope.AudioWorkletNode,
    navigator: scope.navigator,
    WebSocket: scope.WebSocket,
    fetch: (...args) => scope.fetch(...args),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    random: () => Math.random(),
    isSecureContext: scope.isSecureContext === true,
  });
}

const makeHostId = (env) => {
  const random = attempt(() => env.random()) ?? Math.random();
  return `h-${Math.floor(random * 36 ** 8).toString(36).padStart(8, '0')}`;
};

/**
 * `adapter` = { runtime }; `env` = { AudioContext, AudioWorkletNode, navigator, WebSocket, fetch, setTimeout,
 * clearTimeout, now, random, isSecureContext } where the timers are the ENGINE clock; `timers` = the REALM clock used by
 * hubs, coalescers and grace timers. `deps` overrides the real app modules in tests.
 */
export function createLaneHost({ adapter, env, deps = {}, hostId, timers = env } = {}) {
  const runtime = adapter.runtime;
  const id = hostId ?? makeHostId(env);
  const realm = Object.freeze({
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (handle) => timers.clearTimeout(handle),
    now: () => timers.now(),
  });

  let settings = deepFreeze({ speechMuted: true, tabOriginalVolume: ORIGINAL_VOLUME.initial,
    captions: { tab: false, mic: false }, style: { ...DEFAULT_STYLE } });
  let micActiveTabId = null;          // the tab you look at (host/overlay-wanted {active}); mic captions go only there
  let epochCounter = 0;
  let started = false, disposePromise = null, disposed = false;
  let router = null;
  const overlayOutcome = { tab: 'unknown', mic: 'unknown' };   // 'unavailable' after a failed attach for that lane
  const lastState = { tab: createIdleLaneState('tab'), mic: createIdleLaneState('mic') };
  const captionMemo = new Map();      // `${lane}:${destination}` -> { inputs, frame }
  const seqs = new Map();             // frame key -> last assigned seq (the host stamps seq at send time)
  const lingering = new Set();        // tab ids whose overlay port stays open a while to show a `stopped` status
  const lingerTimers = new Set();
  const nextSeq = (key) => { const value = (seqs.get(key) ?? 0) + 1; seqs.set(key, value); return value; };

  const lanes = {
    tab: createTabLane({ env, deps, timers: realm, onChange: (reason) => onLaneChange('tab', reason) }),
    mic: createMicLane({ env, deps, timers: realm, onChange: (reason) => onLaneChange('mic', reason) }),
  };

  // -------------------------------------------------------------------------------------------
  // Routing (5.6.3). A tab receives a lane's frames only while the lane is active and its captions are on.
  const isActive = (lane) => ACTIVE_PHASES.includes(lanes[lane].phase());
  const captionsOn = (lane) => settings.captions[lane] === true;
  const feedingTab = (lane) => (lane === 'tab' ? lanes.tab.facts().tabId : micActiveTabId);
  const routeTab = (lane) => (isActive(lane) && captionsOn(lane) ? feedingTab(lane) : null);
  const needed = (tabId) => lingering.has(tabId) || LANES.some((lane) => routeTab(lane) === tabId);

  const overlayValue = (lane) => {
    const tabId = routeTab(lane);
    if (tabId !== null && overlayHub.has(tabId)) return 'attached';
    return overlayOutcome[lane] === 'unavailable' ? 'unavailable' : 'unknown';
  };
  const laneState = (lane) => laneStateFromSnapshot({ lane, snapshot: lanes[lane].snapshot(),
    facts: { ...lanes[lane].facts(), captions: captionsOn(lane), overlay: overlayValue(lane) }, level: lanes[lane].level() });

  // -------------------------------------------------------------------------------------------
  // Frames. The coalescer holds one pending frame per key and calls onSend at most once per interval per key.
  function captionsFrame(lane, destination) {
    const controller = lanes[lane];
    const snapshot = controller.snapshot();
    const facts = controller.facts();
    const phase = lastState[lane].phase;
    const languages = Array.isArray(facts.languages) ? facts.languages.join('>') : null;   // a string, so the memo compares by value
    const inputs = [snapshot?.captions ?? null, snapshot?.skippedSegments ?? null, facts.epoch, facts.targetLanguage,
      languages, phase, settings.style.showSource, destination === 'overlay' ? settings.style.maxLines : PANEL_ROWS];
    const memo = captionMemo.get(`${lane}:${destination}`);
    if (memo && memo.inputs.every((value, index) => value === inputs[index])) return memo.frame;
    // A lane that ended in error keeps showing what it last said (panel preview, 8.2.3 rule 16): the finished run's
    // captions are gone from the engine, so the frame of THIS run is kept, marked not live. Another run's rows never are.
    if (phase === 'error' && memo && memo.frame.epoch === facts.epoch) {
      const kept = memo.frame.live ? deepFreeze({ ...memo.frame, live: false }) : memo.frame;
      captionMemo.set(`${lane}:${destination}`, { inputs, frame: kept });
      return kept;
    }
    const frame = buildCaptionFrame({ captions: snapshot?.captions ?? null, skippedSegments: snapshot?.skippedSegments ?? [],
      lane, lang: facts.targetLanguage, languages: facts.languages, epoch: facts.epoch, seq: 0,
      showSource: settings.style.showSource,
      maxRows: destination === 'overlay' ? settings.style.maxLines : PANEL_ROWS,
      live: phase === 'running' || phase === 'reconnecting' });
    captionMemo.set(`${lane}:${destination}`, { inputs, frame });
    return frame;
  }
  const stateFrame = (fresh) => {
    const lanesNow = fresh ? { tab: laneState('tab'), mic: laneState('mic') } : lastState;
    return { v: PROTOCOL_VERSION, type: 'state', state: buildUiState({ hostId: id, seq: 1, speechMuted: settings.speechMuted, lanes: lanesNow }) };
  };
  const styleFrame = () => buildStyleFrame(settings.style);

  // The last step before a frame leaves: stamp the seq and re-validate, so what is sent is always a sanitized copy.
  function stamped(direction, frame, key) {
    const out = frame.type === 'state' ? { ...frame, state: { ...frame.state, seq: nextSeq(key) } } : { ...frame, seq: nextSeq(key) };
    const checked = validateFrame(direction, out);
    return checked.ok ? checked.frame : null;
  }
  function onSend(key, frame) {
    if (key === 'state') {
      const out = stamped('host->panel', frame, key);
      if (out) panelHub.broadcast(out);
      return;
    }
    const [, lane, destination] = key.split(':');
    if (destination === 'panel') {
      const out = stamped('host->panel', frame, key);
      if (out) panelHub.broadcast(out);
      return;
    }
    const tabId = routeTab(lane);
    const out = tabId === null ? null : stamped('host->overlay', frame, key);
    if (out) overlayHub.send(tabId, out);
  }
  const coalescer = createFrameCoalescer({ now: realm.now, setTimeout: realm.setTimeout, clearTimeout: realm.clearTimeout,
    send: onSend });

  const pushState = () => coalescer.push('state', stateFrame(false));
  function pushCaptions(lane) {
    coalescer.push(`captions:${lane}:panel`, captionsFrame(lane, 'panel'));
    if (routeTab(lane) !== null) coalescer.push(`captions:${lane}:overlay`, captionsFrame(lane, 'overlay'));
  }
  // A frame straight to one overlay port (a reply to hello, a route change): the port has never seen it, so no dedupe.
  function sendCaptionsTo(tabId, lane) {
    const out = stamped('host->overlay', captionsFrame(lane, 'overlay'), `captions:${lane}:overlay`);
    if (out) overlayHub.send(tabId, out, { force: true });
  }
  const sendStatus = (lane, phase, tabId = routeTab(lane)) => {
    if (tabId !== null && overlayHub.has(tabId)) overlayHub.send(tabId, makeFrame('status', { lane, phase }));
  };
  function sendClear(tabId, lane) {
    if (tabId === null || !overlayHub.has(tabId)) return;
    overlayHub.send(tabId, makeFrame('clear', { lane }));
    overlayHub.forget(tabId, lane);   // the next captions frame must not be deduped against the one before the clear
  }

  // Ports no lane needs any more get `bye` and are closed; `delayMs` keeps a port a while after an error so its
  // `stopped` status row can be read (LIMITS.statusLingerMs).
  function releaseUnneeded(delayMs = 0, tabId = null) {
    if (delayMs > 0 && tabId !== null) {
      lingering.add(tabId);
      const timer = realm.setTimeout(() => {
        lingerTimers.delete(timer);
        lingering.delete(tabId);
        releaseUnneeded(0);
      }, delayMs);
      lingerTimers.add(timer);
      return;
    }
    for (const openTab of overlayHub.tabIds()) if (!needed(openTab)) overlayHub.close(openTab);
  }

  // -------------------------------------------------------------------------------------------
  // Lane changes: every lane and engine notification lands here.
  function laneEnded(lane, state) {
    const tabId = captionsOn(lane) ? feedingTab(lane) : null;
    const unrequested = state.phase === 'error' || lanes[lane].facts().stopRequested !== true;
    coalescer.flush();
    if (tabId !== null) {
      // 5.7 step 4: a lane that ended in error, or that nobody asked to stop, says so BEFORE its rows are cleared.
      if (unrequested) sendStatus(lane, 'stopped', tabId);
      sendClear(tabId, lane);
    }
    if (unrequested && tabId !== null) releaseUnneeded(LIMITS.statusLingerMs, tabId);   // this tab's port lingers
    releaseUnneeded(0);   // every other port nobody needs goes now
    // 5.7 step 6: nothing running and nobody watching: start counting down to idle.
    if (!LANES.some(isActive) && panelHub.count() === 0) panelHub.armGrace();
  }

  function onTransition(lane, previous, state) {
    if (state.phase === 'starting') overlayOutcome[lane] = 'unknown';
    if (alarming(state) && !alarming(previous)) sendStatus(lane, 'reconnecting');
    // Back, or the reconnect became a calm one: the page's reconnecting row goes.
    else if (alarming(previous) && !alarming(state) && ['running', 'reconnecting'].includes(state.phase)) sendStatus(lane, 'running');
    if ((state.phase === 'off' || state.phase === 'error') && LIVE_OR_STOPPING.includes(previous.phase)) laneEnded(lane, state);
  }

  function onLaneChange(lane, reason = 'data') {
    if (disposed) return;
    const previous = lastState[lane];
    const state = laneState(lane);
    lastState[lane] = state;
    const moved = previous.phase !== state.phase;
    // A calm reconnect that turns into a lost connection (or back) keeps the phase but changes what the page is told.
    if (moved || previous.reconnectReason !== state.reconnectReason) onTransition(lane, previous, state);
    pushState();
    pushCaptions(lane);
    if (moved || reason === 'phase') coalescer.flush();
  }
  const refresh = () => { for (const lane of LANES) onLaneChange(lane, 'data'); };

  // -------------------------------------------------------------------------------------------
  // Settings (4.2.2). `next` is a sanitized HostSettings.
  function applySettings(next) {
    const previous = settings;
    settings = next;
    if (next.speechMuted !== previous.speechMuted) for (const lane of LANES) lanes[lane].setMuted(next.speechMuted);
    if (next.tabOriginalVolume !== previous.tabOriginalVolume) lanes.tab.setOriginalVolume(next.tabOriginalVolume);
    if (JSON.stringify(next.style) !== JSON.stringify(previous.style)) {
      for (const tabId of overlayHub.tabIds()) overlayHub.send(tabId, styleFrame());
    }
    for (const lane of LANES) {
      if (previous.captions[lane] && !next.captions[lane]) {
        // Turned off: clear what the lane was feeding, close the ports nobody needs any more.
        const tabId = feedingTab(lane);
        if (tabId !== null) sendClear(tabId, lane);
        releaseUnneeded(0);
      } else if (!previous.captions[lane] && next.captions[lane]) {
        // Turned on: only re-enables routing on a port that already exists (attaching a page is the SW's job).
        const tabId = routeTab(lane);
        if (tabId !== null && overlayHub.has(tabId)) sendCaptionsTo(tabId, lane);
      }
    }
    refresh();
    coalescer.flush();
  }

  function setMicActiveTab(next) {
    if (next === micActiveTabId) return;
    const previous = micActiveTabId;
    const wasFeeding = routeTab('mic') === previous;
    micActiveTabId = next;
    overlayOutcome.mic = 'unknown';
    // Mic captions are private to you: they leave the old tab at once and never reach a background tab.
    if (previous !== null && wasFeeding) sendClear(previous, 'mic');
    releaseUnneeded(0);
    const target = routeTab('mic');
    if (target !== null && overlayHub.has(target)) {
      sendCaptionsTo(target, 'mic');
      if (alarming(lastState.mic)) sendStatus('mic', 'reconnecting', target);
    }
    onLaneChange('mic', 'data');
  }

  // -------------------------------------------------------------------------------------------
  // Hubs.
  const panelHub = createPanelHub({ runtime, timers: realm,
    onHello(port) {
      panelHub.sendTo(port, stamped('host->panel', stateFrame(true), 'state'));
      for (const lane of LANES) panelHub.sendTo(port, stamped('host->panel', captionsFrame(lane, 'panel'), `captions:${lane}:panel`));
    },
    onAllGone: (reason) => { void onPanelsGone(reason); } });

  const overlayHub = createOverlayHub({ runtime, timers: realm,
    canAccept: (tabId) => LANES.some((lane) => routeTab(lane) === tabId),
    onHello(tabId) {
      overlayHub.send(tabId, styleFrame(), { force: true });
      for (const lane of LANES) {
        if (routeTab(lane) !== tabId) continue;
        sendCaptionsTo(tabId, lane);
        if (alarming(lastState[lane])) sendStatus(lane, 'reconnecting', tabId);
      }
      refresh();
    },
    onClose: () => refresh() });

  async function reportIdle(reason) {
    const send = () => runtime.sendMessage(makeMessage('sw/host-idle', { hostId: id, reason }));
    let answered = false, answer;
    try { answer = await send(); answered = true; } catch { /* retried once below */ }
    if (!answered) {
      await new Promise((resolve) => { realm.setTimeout(resolve, IDLE_REPORT_RETRY_MS); });
      try { answer = await send(); answered = true; } catch { /* handled below */ }
    }
    // `closed:true` ends this document, and a refusal (`ok:false`, FORBIDDEN or INVALID_MESSAGE) is not fixed by asking
    // again. `closed:false` means the SW still saw a start of its own in flight (6.9) and kept the document, and two
    // failed sends mean it never heard us: either way nothing will report again by itself, because the hub's one-shot
    // flag is spent, so an idle document (and `interp.host.v1.up`) would stay for good. Ask the hub for another report
    // after a growing delay; its cap ends the chain and a returning panel cancels it.
    if (answered && (answer?.closed === true || answer?.ok === false)) return;
    if (!disposed) panelHub.rearm(reason);
  }
  async function onPanelsGone(reason) {
    await Promise.all(LANES.map((lane) => attemptAsync(() => lanes[lane].stop())));
    coalescer.flush();
    await reportIdle(reason);
  }

  // -------------------------------------------------------------------------------------------
  // Messages (5.2). Handlers return the response WITHOUT `ok`; a thrown Error{code} becomes {ok:false, code}.
  const handlers = {
    'host/ping': async () => ({ hostId: id, protocol: PROTOCOL_VERSION,
      lanes: { tab: lanes.tab.phase(), mic: lanes.mic.phase() }, tabId: lanes.tab.facts().tabId, panels: panelHub.count() }),

    'host/lane-start': async (message) => {
      const { lane } = message;
      const refused = lanes[lane].refusal();
      if (refused) throw codedError(refused);
      const epoch = ++epochCounter;
      // Speech mute is ONE flag for both lanes: a lane that starts next to a running one follows the flag the host has.
      const otherActive = LANES.some((other) => other !== lane && isActive(other));
      const speechMuted = otherActive ? settings.speechMuted : message.muted;
      applySettings(deepFreeze({ speechMuted, captions: { ...settings.captions, [lane]: message.captions },
        tabOriginalVolume: lane === 'tab' ? message.tab.originalVolume : settings.tabOriginalVolume,
        style: { ...message.style } }));
      return lanes[lane].start({ ...message, muted: speechMuted, epoch });
    },

    'host/lane-stop': async (message) => {
      await Promise.all((message.lane === undefined ? LANES : [message.lane]).map((lane) => lanes[lane].stop()));
      return {};
    },

    'host/settings': async (message) => { applySettings(deepFreeze(message.settings)); return {}; },

    'host/overlay-wanted': async ({ tabId, active }) => {
      if (active === true) setMicActiveTab(tabId);
      else if (micActiveTabId === tabId) setMicActiveTab(null);
      const wantedLanes = [];
      if (isActive('tab') && captionsOn('tab') && lanes.tab.facts().tabId === tabId) wantedLanes.push('tab');
      if (isActive('mic') && captionsOn('mic') && active === true) wantedLanes.push('mic');
      const wanted = wantedLanes.length > 0 && (overlayHub.has(tabId) || overlayHub.count() < LIMITS.maxOverlayPorts);
      return { wanted, lanes: wantedLanes };
    },

    'host/overlay-result': async ({ ok, lanes: named }) => {
      if (!ok) for (const lane of named) overlayOutcome[lane] = 'unavailable';
      refresh();
      return {};
    },

    'host/tab-removed': async ({ tabId }) => {
      if (micActiveTabId === tabId) setMicActiveTab(null);
      if (lanes.tab.facts().tabId === tabId) await lanes.tab.stop({ error: 'TAB_ENDED' });
      return {};
    },
  };

  const onConnect = (port) => {
    if (port?.name === PORT_NAMES.panel) panelHub.accept(port);
    else if (port?.name === PORT_NAMES.overlay) overlayHub.accept(port);
    // any other name: ignored (a disconnect() from a non-owner would only notify the sender)
  };

  return Object.freeze({
    /** Idempotent. Registers the listeners BEFORE any awaited work: the SW pings right after createDocument resolves. */
    start() {
      if (started || disposed) return;
      started = true;
      router = createMessageRouter({ runtime, target: 'offscreen', handlers });
      runtime.onConnect.addListener(onConnect);
      panelHub.armInitialGrace();   // a crashed panel must not leave a running host and a capture indicator (F10)
    },

    /** stop() of both lanes, hubs closed (bye), listeners removed. */
    dispose() {
      disposePromise ??= (async () => {
        await Promise.all(LANES.map((lane) => attemptAsync(() => lanes[lane].dispose())));
        coalescer.flush();
        disposed = true;
        panelHub.broadcast(makeFrame('bye'));
        overlayHub.dispose();
        panelHub.dispose();
        coalescer.dispose();
        for (const timer of lingerTimers) attempt(() => realm.clearTimeout(timer));
        lingerTimers.clear();
        router?.dispose();
        attempt(() => runtime.onConnect.removeListener(onConnect));
      })();
      return disposePromise;
    },

    uiState: () => buildUiState({ hostId: id, seq: Math.max(1, seqs.get('state') ?? 1), speechMuted: settings.speechMuted,
      lanes: { tab: laneState('tab'), mic: laneState('mic') } }),
  });
}
