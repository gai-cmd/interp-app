// New implementation of docs/extension.md §6; no legacy code is ported.
// The service worker's logic with an injected adapter. It is thin and stateless by design: every durable fact lives
// in chrome.storage (armed tabs, the host flag, why the last run ended, settings, the key) or is asked of the host,
// so a worker that idles out and restarts loses at most the two pieces of in-memory state below (the in-flight
// starts with their cancel flags, and the lifecycle mutex) and never correctness (6.10).
//
// What this file guarantees, each pinned by tests/extension-sw.test.mjs:
//   * the first call of onActionClicked is sidePanel.open, in the same synchronous turn as the click (the user
//     gesture that also grants tabCapture is only alive for that turn);
//   * the stream-id mint is the LAST awaited step before host/lane-start is sent (an id is single-use and expires);
//   * the API key leaves this file in exactly one message, host/lane-start, and is never stored or logged;
//   * a Stop overtakes a start that is still inside ensureOffscreen, the mint or the host (stop wins).
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { isMachineCode } from '../lib/constants.js';
import {
  LANES, LIMITS, PATHS, SETUP_QUERY, STORAGE_KEYS, createMessageRouter, makeMessage,
} from '../lib/protocol.js';
import {
  hostSettingsOf, laneRequestOf, normalizeSettings, readKey, readSettings, resolveKey,
} from '../lib/settings.js';
import { createArming } from './arming.js';

const HOST_JUSTIFICATION = 'Runs the live interpretation engine and the tab audio graph.';
const MENU_ID = 'interp-open';
const MENU_CONTEXTS = Object.freeze(['page', 'video', 'audio', 'frame']);
const CAPTURABLE_SCHEMES = Object.freeze(['http:', 'https:', 'file:']);
const ATTACH_DELAYS_MS = Object.freeze([0, 150, 400, 1000]);
const PING_ATTEMPTS = 20;
const PING_INTERVAL_MS = 100;
const STOP_POLL_MS = 100;
const MINT_RETRY_MS = 250;
const LIVE_LANE_PHASES = Object.freeze(['starting', 'running', 'reconnecting', 'stopping']);
const IDLE_LANE_PHASES = Object.freeze(['off', 'error']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codeError = (code) => Object.assign(new Error(code), { code });
const isObject = (value) => value !== null && typeof value === 'object';
const schemeOf = (url) => attempt(() => new URL(url).protocol) ?? '';

export function createServiceWorker({ adapter, now = () => Date.now(), setTimeout = globalThis.setTimeout } = {}) {
  const { runtime, storage, tabs, tabCapture, sidePanel, action, contextMenus, offscreen, scripting, i18n } = adapter;
  const local = storage.local;
  const session = storage.session;
  const arming = createArming({ storageSession: session, now });
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const settle = async (task) => { try { return await task(); } catch { return undefined; } };

  // ---------------------------------------------------------------------------------------------
  // In-memory state (rebuilt empty after a restart): the starts in flight, and the lifecycle mutex.
  const starting = new Map();   // lane -> { cancelled }
  let chain = Promise.resolve();
  const exclusive = (task) => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  // ---------------------------------------------------------------------------------------------
  // storage.session records (4.10)
  async function readRecord(key) {
    const stored = await settle(() => session.get(key));
    return isObject(stored) ? stored[key] : undefined;
  }
  const writeRecord = (key, value) => settle(() => session.set({ [key]: value }));
  const hostUp = async () => (await readRecord(STORAGE_KEYS.host))?.up === true;
  const writeHost = (up, hostId) => writeRecord(STORAGE_KEYS.host, { v: 1, up, hostId, at: now() });
  async function markHostUp(hostId) {
    const record = await readRecord(STORAGE_KEYS.host);
    if (record?.up === true && record.hostId === hostId) return;   // unchanged: do not wake the panel for nothing
    await writeHost(true, hostId);
  }
  const writeLastStop = (reason) => writeRecord(STORAGE_KEYS.lastStop, { v: 1, reason, at: now() });

  // ---------------------------------------------------------------------------------------------
  // The one way to talk to the host (6.3). It never throws and never returns a non-object: a rejection ("Receiving end
  // does not exist", "The message port closed before a response was received"), `undefined`, a non-object and any
  // response without ok === true all become a machine code, so success REQUIRES res?.ok === true [assumption A24].
  async function sendToHost(message) {
    let res;
    try { res = await runtime.sendMessage(message); } catch { return { ok: false, code: 'HOST_UNAVAILABLE' }; }
    if (isObject(res) && res.ok === true) return res;
    return { ok: false, code: isObject(res) && isMachineCode(res.code) ? res.code : 'HOST_UNAVAILABLE' };
  }
  const ping = () => sendToHost(makeMessage('host/ping'));

  async function hostExists() {
    if (typeof runtime.getContexts !== 'function') return false;
    const found = await settle(() => runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [runtime.getURL(PATHS.host)],
    }));
    return Array.isArray(found) && found.length > 0;
  }
  const closeDocumentQuietly = () => settle(() => offscreen.closeDocument());   // "No current offscreen document." is fine

  // ---------------------------------------------------------------------------------------------
  // 6.3.1 ensureOffscreen: mutex, handshake by ping, zombie recovery.
  async function waitForHost() {
    for (let round = 0; round < PING_ATTEMPTS; round += 1) {
      const res = await ping();
      if (res.ok && typeof res.hostId === 'string') return res;
      if (round < PING_ATTEMPTS - 1) await sleep(PING_INTERVAL_MS);
    }
    return null;
  }

  const ensureOffscreen = () => exclusive(async () => {
    let existing = await hostExists();
    for (let round = 0; round < 2; round += 1) {   // round 0 may find a ZOMBIE: a document whose host.js failed at import
      if (!existing) {
        try {
          // Exactly USER_MEDIA: AUDIO_PLAYBACK would let Chrome close the document after 30 s without audio.
          await offscreen.createDocument({ url: PATHS.host, reasons: ['USER_MEDIA'], justification: HOST_JUSTIFICATION });
        } catch (error) {
          if (!/single offscreen document/i.test(String(attempt(() => error.message)))) throw codeError('HOST_UNAVAILABLE');
        }
      }
      const answer = await waitForHost();
      if (answer) return { hostId: answer.hostId };
      await closeDocumentQuietly();   // zombie: close it and recreate ONCE
      existing = false;
    }
    throw codeError('HOST_UNAVAILABLE');
  });

  // 6.9: refuses while a lane other than `except` is starting; never closes while a lane is running (callers check).
  const closeHost = ({ except = null } = {}) => exclusive(async () => {
    for (const lane of starting.keys()) if (lane !== except) return false;
    await closeDocumentQuietly();
    await writeHost(false, null);
    return true;
  });

  // ---------------------------------------------------------------------------------------------
  // 6.4 the mint and its error mapping.
  const rawMint = (tabId) => tabCapture.getMediaStreamId({ targetTabId: tabId });
  const messageOf = (error) => String(attempt(() => error.message) ?? '');
  const isActiveStreamError = (error) => messageOf(error).startsWith('Cannot capture a tab with an active stream');

  async function mapMintError(error, tabId) {
    const text = messageOf(error);
    if (text.startsWith('Extension has not been invoked')) {
      await arming.clear(tabId);
      return codeError('NEEDS_ARM');
    }
    if (text.startsWith('Cannot capture this page')) return codeError('TAB_UNSUPPORTED');
    if (text.startsWith('Error finding tab to capture') || text.startsWith('Invalid tab specified')) return codeError('TAB_GONE');
    return codeError('TAB_CAPTURE_FAILED');   // the message is discarded
  }

  // Recovery for "Cannot capture a tab with an active stream." Each step is tried once.
  async function recoverActiveStream(tabId, lane) {
    const first = await ping();   // a FRESH ping, never a cached one
    if (first.ok && LIVE_LANE_PHASES.includes(first.lanes?.tab)) throw codeError('ALREADY_RUNNING');
    await sleep(MINT_RETRY_MS);   // a stop that just completed may still be releasing the capture registry
    try { return await rawMint(tabId); } catch (error) { if (!isActiveStreamError(error)) throw await mapMintError(error, tabId); }
    const second = await ping();
    if (second.ok && IDLE_LANE_PHASES.includes(second.lanes?.tab) && IDLE_LANE_PHASES.includes(second.lanes?.mic)) {
      // An orphaned capture that our own dead document held (or a crash leftover): recreate the document once.
      if (await closeHost({ except: lane })) {
        await ensureOffscreen();
        try { return await rawMint(tabId); } catch (error) { if (!isActiveStreamError(error)) throw await mapMintError(error, tabId); }
      }
    }
    throw codeError('TAB_CAPTURE_BUSY');   // another extension or tool captures the tab; we cannot release it
  }

  async function mintStreamId(tabId, lane) {
    try { return await rawMint(tabId); } catch (error) {
      if (isActiveStreamError(error)) return recoverActiveStream(tabId, lane);
      throw await mapMintError(error, tabId);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 6.7 overlay attach.
  async function activeTabId() {
    const found = await settle(() => tabs.query({ active: true, lastFocusedWindow: true }));
    return Array.isArray(found) && Number.isInteger(found[0]?.id) ? found[0].id : null;
  }

  async function sendAttach(tabId) {
    try {
      const res = await tabs.sendMessage(tabId, makeMessage('content/overlay-attach'), { frameId: 0 });
      return isObject(res) && res.ok === true;
    } catch { return false; }
  }

  async function attachOverlay(tabId, { inject = false } = {}) {
    for (const delay of ATTACH_DELAYS_MS) {   // the content script may not be listening yet right after status:'complete'
      if (delay > 0) await sleep(delay);
      if (await sendAttach(tabId)) return true;
    }
    if (!inject || !scripting) return false;
    // An already-open armed tab never received the static content script: activeTab gives us scripting access.
    try { await scripting.executeScript({ target: { tabId }, files: [PATHS.overlay] }); } catch { return false; }
    return sendAttach(tabId);
  }

  async function considerOverlay(tabId) {
    try {
      if (!Number.isInteger(tabId) || !(await hostUp())) return;
      const active = (await activeTabId()) === tabId;
      const wanted = await sendToHost(makeMessage('host/overlay-wanted', { tabId, active }));
      if (!wanted.ok || wanted.wanted !== true) return;
      const ok = await attachOverlay(tabId, { inject: await arming.isArmed(tabId) });
      await sendToHost(makeMessage('host/overlay-result', { tabId, ok, lanes: wanted.lanes }));
    } catch { /* fire-and-forget: an overlay problem must never surface as a start failure */ }
  }

  async function afterLaneStarted(lane, tabId) {
    await considerOverlay(lane === 'tab' ? tabId : await activeTabId());
  }

  // ---------------------------------------------------------------------------------------------
  // 6.3 start orchestration.
  async function startLane({ lane, tabId } = {}) {
    if (!LANES.includes(lane)) throw codeError('INVALID_REQUEST');
    // In memory; the host repeats the check authoritatively. A start that a stop already cancelled still holds the lane
    // until it has unwound (a hung getUserMedia can keep it there for a long time). Answering ALREADY_RUNNING to the
    // NEXT press would be wrong twice: nothing is running, and the panel deliberately ignores that code, so the press
    // would vanish without a word. LANE_STOPPING is what the panel shows as "still stopping, press Start again".
    const inFlight = starting.get(lane);
    if (inFlight) throw codeError(inFlight.cancelled ? 'LANE_STOPPING' : 'ALREADY_RUNNING');
    const run = { cancelled: false };
    starting.set(lane, run);
    const alive = () => { if (run.cancelled) throw codeError('START_CANCELLED'); };
    try {
      // 1. Settings and key. The worker is the only context that reads the key.
      let settings;
      let personal;
      try { settings = await readSettings(local); personal = await readKey(local); } catch { throw codeError('INTERNAL'); }
      alive();
      const key = resolveKey({ personal, builtin: BUILTIN_KEYS });
      if (key === null) throw codeError('CREDENTIAL_REQUIRED');

      // 2. Tab lane: the tab must exist, be capturable by scheme, and be armed.
      if (lane === 'tab') {
        let tab;
        try { tab = await tabs.get(tabId); } catch { throw codeError('TAB_GONE'); }
        alive();
        if (!isObject(tab)) throw codeError('TAB_GONE');
        if (typeof tab.url === 'string' && !CAPTURABLE_SCHEMES.includes(schemeOf(tab.url))) throw codeError('TAB_UNSUPPORTED');
        const armed = await arming.isArmed(tabId);
        alive();
        if (!armed) throw codeError('NEEDS_ARM');
      }

      // 3. Wait out a lane that is still stopping. This MUST happen before the mint: an id the host then refuses
      //    stays pending and blocks the next mint of that tab ("Cannot capture a tab with an active stream.").
      if (await hostExists()) {
        for (let waited = 0; ; waited += STOP_POLL_MS) {
          alive();
          const answer = await ping();   // a FRESH ping each time
          alive();
          if (!answer.ok || answer.lanes?.[lane] !== 'stopping') break;
          if (waited >= LIMITS.stopWaitMs) throw codeError('LANE_STOPPING');
          await sleep(STOP_POLL_MS);
        }
      }

      // 4. The host: created if missing, answered a ping, flagged up.
      const { hostId } = await ensureOffscreen();
      alive();
      await markHostUp(hostId);
      alive();

      // 5. The request. `key` is copied into the one message below and nowhere else.
      const payload = {
        lane, key,
        request: laneRequestOf(settings, lane),
        voiceGender: settings.voiceGender,
        muted: settings.speechMuted,
        captions: settings.lanes[lane].captions,
        style: hostSettingsOf(settings).style,
      };
      if (lane === 'tab') payload.tab = { tabId, originalVolume: settings.lanes.tab.originalVolume };

      // 6. The mint is the LAST awaited step before the send: the id is single-use and short-lived.
      if (lane === 'tab') payload.tab.streamId = await mintStreamId(tabId, lane);
      alive();   // a stop that landed during the mint: nothing is sent, the host already got its host/lane-stop
      const message = makeMessage('host/lane-start', payload);
      let res = await sendToHost(message);
      if (!res.ok && res.code === 'HOST_UNAVAILABLE') {   // exactly ONE retry: the document was not listening yet
        await ensureOffscreen();
        alive();
        res = await sendToHost(message);
      }

      // 7. Stop wins: a stop that reached the host before this start, or just after it, must leave the lane off.
      if (run.cancelled) {
        await sendToHost(makeMessage('host/lane-stop', { lane }));
        throw codeError('START_CANCELLED');
      }
      if (!res.ok) throw codeError(res.code);
      await settle(() => session.remove(STORAGE_KEYS.lastStop));   // a new run began
      afterLaneStarted(lane, tabId).catch(() => {});
    } finally {
      if (starting.get(lane) === run) starting.delete(lane);
    }
  }

  // 6.11 sw/lane-stop: cancel starts that have not reached the host, then tell the host (best effort, never throws).
  async function stopLane({ lane } = {}) {
    const named = LANES.includes(lane) ? [lane] : LANES;
    for (const name of named) {
      const run = starting.get(name);
      if (run) run.cancelled = true;
    }
    await settle(() => sendToHost(makeMessage('host/lane-stop', LANES.includes(lane) ? { lane } : {})));
  }

  // 6.11 sw/host-probe: compare interp.host.v1.up with reality.
  async function probeHost() {
    const record = await readRecord(STORAGE_KEYS.host);
    if (!(await hostExists())) {
      if (record?.up === true) { await writeHost(false, null); await writeLastStop('host-lost'); }
      return false;
    }
    const answer = await ping();
    if (!answer.ok) {   // a renderer crash left a zombie
      await closeHost({ except: null });
      await writeLastStop('host-lost');
      return false;
    }
    if (record?.up !== true) await writeHost(true, answer.hostId);
    return true;
  }

  // 6.9 sw/host-idle: the host says nobody is listening any more.
  async function onHostIdle({ reason }) {
    const answer = await ping();
    if (!answer.ok) {
      if (await hostUp()) { await writeHost(false, null); await writeLastStop(reason); }
      return { closed: false };
    }
    const idle = IDLE_LANE_PHASES.includes(answer.lanes?.tab) && IDLE_LANE_PHASES.includes(answer.lanes?.mic);
    // A start that passed ensureOffscreen and the mint but has not delivered host/lane-start yet is invisible to
    // host/ping: only the in-memory set can see it.
    if (starting.size === 0 && answer.panels === 0 && idle && (await closeHost({ except: null }))) {
      await writeLastStop(reason);
      return { closed: true };
    }
    return { closed: false };
  }

  // 6.8 sw/permission-open: one permission tab, created or focused.
  async function openPermission() {
    const url = runtime.getURL(PATHS.permission);
    const existing = await tabs.query({ url });
    if (Array.isArray(existing) && Number.isInteger(existing[0]?.id)) {
      await tabs.update(existing[0].id, { active: true });
      return { tabId: existing[0].id };
    }
    const created = await tabs.create({ url });
    return { tabId: created.id };
  }

  // ---------------------------------------------------------------------------------------------
  // 6.1 listeners.
  async function bootstrap() {
    // The panel behavior persists in the profile and `true` would suppress both action.onClicked and the tab grant.
    await Promise.all([
      settle(() => sidePanel.setPanelBehavior({ openPanelOnActionClick: false })),
      // Re-applied at every start: whether the level persists across restarts is unstated [assumption A10].
      settle(() => local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })),
    ]);
  }

  async function onInstalled(details) {
    await settle(async () => {
      await contextMenus.removeAll();   // menus persist across restarts: creating twice would throw "duplicate id"
      contextMenus.create({ id: MENU_ID, title: i18n.getMessage('menuOpen'), contexts: [...MENU_CONTEXTS] });
    });
    await settle(() => session.remove([STORAGE_KEYS.armed, STORAGE_KEYS.host, STORAGE_KEYS.lastStop]));
    await bootstrap();
    // §17: a FIRST install opens the setup page (the permission page in setup mode): it asks for the microphone at once
    // and shows the pin and first-use steps, so nobody has to find the microphone button before the first Start.
    // An update (Reload after a new folder) or a Chrome update never opens it.
    if (details?.reason === 'install') await settle(() => tabs.create({ url: `${runtime.getURL(PATHS.permission)}?${SETUP_QUERY}` }));
  }

  const onStartup = () => bootstrap();

  // 6.5: sidePanel.open is the FIRST call, in the same synchronous turn as the click. Any await before it (even a
  // storage read) would lose the user gesture.
  function openPanel(tab) {
    try { return Promise.resolve(sidePanel.open({ windowId: tab?.windowId })); } catch (error) { return Promise.reject(error); }
  }
  function armAndOpen(tab) {
    const opened = openPanel(tab);
    const armed = arming.arm(tab);
    return Promise.allSettled([opened, armed]).then(() => considerOverlay(tab?.id));
  }
  const onActionClicked = (tab) => armAndOpen(tab);
  function onMenuClicked(info, tab) {
    if (info?.menuItemId !== MENU_ID || !tab) return undefined;
    return armAndOpen(tab);
  }

  async function onTabRemoved(tabId) {
    await arming.clear(tabId);
    if (await hostUp()) await sendToHost(makeMessage('host/tab-removed', { tabId }));
  }

  async function onTabUpdated(tabId, changeInfo) {
    await arming.onTabUpdated(tabId, changeInfo);
    if (changeInfo?.status === 'complete') await considerOverlay(tabId);
  }

  const onTabActivated = ({ tabId } = {}) => considerOverlay(tabId);

  // 6.6: one path for hot settings. Panel and options write storage.local; this forwards the edit to the host.
  async function onStorageChanged(changes, areaName) {
    const change = areaName === 'local' ? changes?.[STORAGE_KEYS.settings] : undefined;
    if (!change || !(await hostUp())) return;
    const next = normalizeSettings(change.newValue);
    const previous = normalizeSettings(change.oldValue);   // an absent old value normalizes to the defaults
    await sendToHost(makeMessage('host/settings', { settings: hostSettingsOf(next) }));
    for (const lane of LANES) {
      if (previous.lanes[lane].captions !== false || next.lanes[lane].captions !== true) continue;
      if (lane === 'tab') {
        const answer = await ping();
        if (answer.ok && Number.isInteger(answer.tabId)) await considerOverlay(answer.tabId);
      } else {
        await considerOverlay(await activeTabId());
      }
    }
  }

  const handlers = Object.freeze({
    onActionClicked, onMenuClicked, onInstalled, onStartup, onTabRemoved, onTabUpdated, onTabActivated, onStorageChanged,
  });

  function register() {
    // Every listener is registered synchronously, none conditionally, none inside a promise. runtime.onConnect is NOT
    // registered (F1) and neither is commands.onCommand (_execute_action dispatches action.onClicked).
    runtime.onInstalled.addListener(onInstalled);
    runtime.onStartup.addListener(onStartup);
    createMessageRouter({
      runtime, target: 'sw',
      handlers: {
        'sw/lane-start': async ({ lane, tabId }) => { await startLane({ lane, tabId }); return {}; },
        'sw/lane-stop': async ({ lane }) => { await stopLane({ lane }); return {}; },
        'sw/permission-open': () => openPermission(),
        'sw/host-probe': async () => ({ up: await probeHost() }),
        'sw/host-idle': (message) => onHostIdle(message),
      },
    });
    action.onClicked.addListener(onActionClicked);
    contextMenus.onClicked.addListener(onMenuClicked);
    tabs.onRemoved.addListener(onTabRemoved);
    tabs.onUpdated.addListener(onTabUpdated);
    tabs.onActivated.addListener(onTabActivated);
    storage.onChanged.addListener(onStorageChanged);
    bootstrap().catch(() => {});
  }

  return Object.freeze({
    register, bootstrap, handlers, startLane, stopLane, ensureOffscreen, closeHost, probeHost, considerOverlay,
  });
}
