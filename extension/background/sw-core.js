// New implementation of docs/extension.md §6; no legacy code is ported.
// The service worker's logic with an injected adapter. It is thin and stateless by design: every durable fact lives
// in chrome.storage (armed tabs, the host flag, why the last run ended, settings, the key) or is asked of the host,
// so a worker that idles out and restarts loses at most the two pieces of in-memory state below (the in-flight
// starts with their cancel flags, and the lifecycle mutex) and never correctness (6.10).
//
// What this file guarantees, each pinned by tests/extension-sw.test.mjs:
//   * the first call of onActionClicked is sidePanel.open, in the same synchronous turn as the click (the user
//     gesture that also grants tabCapture is only alive for that turn);
//   * after the arming of a capturable tab has been written, the toolbar icon (its shortcut, the context menu) asks the
//     panel of that window to start on that tab (§20, interp.autostart.v1): the icon is the one instant start;
//   * the stream-id mint is the LAST awaited step before host/lane-start is sent (an id is single-use and expires);
//   * `pick` is what the panel sends for every tab it does not read as armed (§20): that start goes to the host
//     without a stream id and the host asks through Chrome's share dialog (§19), after the panel's own tab (and no
//     other page) was given its capture label. A start WITHOUT `pick` for a tab that is not armed after all (the
//     panel's armed record was stale) is refused with NEEDS_ARM, and the panel answers it with one more start with
//     `pick`; a start with `pick` is never answered NEEDS_ARM;
//   * the API key (a personal key, or the built-in pool) leaves this file in exactly one message, host/lane-start, and
//     is never stored or logged;
//   * a Stop overtakes a start that is still inside ensureOffscreen, the mint or the host (stop wins);
//   * a Stop that cancels a share-dialog start also closes the offscreen document when no other lane lives in it: a
//     dialog nobody answered stays open in the document for ever (it cannot be closed from there), and while it is open
//     the stream-id start of the SAME document never completes (see closeLeftOverDialog);
//   * §22: a `relay` start (the side panel opened the dialog itself and relays the tab's audio) asks the worker for no
//     arming, no mint, no label, no keep-alive and never leaves a dialog in the document; sw/tab-label labels the
//     panel's tab before the panel opens its dialog and always answers.
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { isMachineCode } from '../lib/constants.js';
import {
  LANES, LIMITS, PATHS, SETUP_QUERY, STORAGE_KEYS, createMessageRouter, makeMessage,
} from '../lib/protocol.js';
import {
  hostSettingsOf, laneRequestOf, moveOldTabDefaultModel, normalizeSettings, readKey, readSettings, resolveCredential,
  updateSettings,
} from '../lib/settings.js';
import { compareVersions } from '../lib/update-check.js';
import { createArming } from './arming.js';

const HOST_JUSTIFICATION = 'Runs the live interpretation engine and the tab audio graph.';
const MENU_ID = 'interp-open';
const MENU_CONTEXTS = Object.freeze(['page', 'video', 'audio', 'frame']);
const CAPTURABLE_SCHEMES = Object.freeze(['http:', 'https:', 'file:']);
const LABEL_SCHEMES = Object.freeze(['http:', 'https:']);   // where the overlay content script runs (manifest matches)
const NONCE_BYTES = 16;
// A picker start that fails with HOST_UNAVAILABLE is re-sent only when the failure came this soon (the document was
// not listening yet). Later than that the dialog was already open: a re-send would open a second one by itself.
const PICK_RETRY_WINDOW_MS = 1000;
const ATTACH_DELAYS_MS = Object.freeze([0, 150, 400, 1000]);
// §20: an update from a version before this one turns the interpreted voice on once (0.4.x started muted).
const VOICE_ON_SINCE = '0.5.0';
const LATEST_MODEL_SINCE = '0.5.1';
const PING_ATTEMPTS = 20;
const PING_INTERVAL_MS = 100;
const STOP_POLL_MS = 100;
const MINT_RETRY_MS = 250;
const LIVE_LANE_PHASES = Object.freeze(['starting', 'running', 'reconnecting', 'stopping']);
const ACTIVE_LANE_PHASES = Object.freeze(['starting', 'running', 'reconnecting']);
const IDLE_LANE_PHASES = Object.freeze(['off', 'error']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codeError = (code) => Object.assign(new Error(code), { code });
const isObject = (value) => value !== null && typeof value === 'object';
const schemeOf = (url) => attempt(() => new URL(url).protocol) ?? '';

export function createServiceWorker({ adapter, now = () => Date.now(), setTimeout = globalThis.setTimeout,
  getRandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes), builtinKeys = BUILTIN_KEYS } = {}) {
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
          // USER_MEDIA (the microphone, a minted tab stream) and DISPLAY_MEDIA (the share picker, §19). Never
          // AUDIO_PLAYBACK: it would let Chrome close the document after 30 s without audio.
          await offscreen.createDocument({ url: PATHS.host, reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'], justification: HOST_JUSTIFICATION });
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

  // 6.9: refuses while a lane other than `except` (a lane name, or a list of them) is starting; never closes while a lane
  // is running (callers check).
  const closeHost = ({ except = null } = {}) => exclusive(async () => {
    const allowed = [].concat(except ?? []);
    for (const lane of starting.keys()) if (!allowed.includes(lane)) return false;
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
  // §19 the share-picker start. The picker lets the user choose ANY tab, and nothing in the stream says which one.
  // The tab the panel is on (almost always the one that is then chosen) gets a label first: a capture handle
  // `<nonce>.<tabId>` that only this extension can read from the captured track. ONLY that tab: a page has one
  // capture-handle setting and cannot get its own back once it is replaced, so labelling every open page would break
  // pages that use the setting themselves (a slide deck presented through a call) on tabs that have nothing to do
  // with this start. A different tab chosen in the dialog is therefore interpreted without page captions.
  // The nonce is fresh per start and lives in this start's variables only.
  function makeNonce() {
    const bytes = getRandomValues(new Uint8Array(NONCE_BYTES));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Resolves true when the page answered that it took the label. Never rejects.
  async function labelTab(tab, nonce, { waitMs, cancelled = null }) {
    if (!Number.isInteger(tab?.id) || !LABEL_SCHEMES.includes(schemeOf(tab.url))) return false;
    const sent = settle(() => tabs.sendMessage(tab.id,
      makeMessage('content/capture-label', { label: `${nonce}.${tab.id}` }), { frameId: 0 }));
    // A page without the content script rejects at once; a frozen one may never answer, so the wait is bounded, and a
    // Stop ends it. A tab that misses its label is still interpreted: only its page captions are unavailable.
    const answer = await Promise.race([sent, sleep(waitMs), ...(cancelled ? [cancelled] : [])]);
    return isObject(answer) && answer.ok === true;
  }

  // §22 sw/tab-label: the panel is about to open the share dialog itself and asks for the label on its own tab first
  // (the same one-page rule as above; the nonce is the panel's). Always answers: a tab that is gone, a page that cannot
  // take a label or one that does not answer within LIMITS.labelWaitMs is `labelled: false`, never an error.
  async function labelPanelTab({ tabId, nonce }) {
    let tab;
    try { tab = await tabs.get(tabId); } catch { return { labelled: false }; }
    return { labelled: await labelTab(tab, nonce, { waitMs: LIMITS.labelWaitMs }) };
  }

  // While the picker is open nothing happens in this worker, and an idle MV3 worker is stopped after 30 s: the
  // panel's sw/lane-start would then end in an error although the user is still choosing. One cheap API call every
  // LIMITS.pickKeepAliveMs keeps it alive. Returns the function that ends the loop.
  function keepAwake() {
    let on = true;
    const tick = () => {
      if (!on) return;
      void settle(() => session.get(STORAGE_KEYS.host));
      setTimeout(tick, LIMITS.pickKeepAliveMs);
    };
    setTimeout(tick, LIMITS.pickKeepAliveMs);
    return () => { on = false; };
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
  // 6.3 start orchestration. `pick` (§20) = the panel asked for Chrome's share dialog: it sends it for every tab it does
  // not read as armed (the same dialog on every OS), on a Chrome where the panel cannot show that dialog itself.
  // `relay` (§22) = the panel showed the dialog itself, holds the captured track and relays its audio under this id;
  // `passthrough` = Chrome silenced that tab, `chosenTab` = the tab its capture label named (null: unknown). Such a
  // start skips the tab lookup, the arming, the mint, the label and the keep-alive; `tabId` is only the panel's tab.
  async function startLane({ lane, tabId, pick = false, relay = null, passthrough = false, chosenTab = null } = {}) {
    if (!LANES.includes(lane)) throw codeError('INVALID_REQUEST');
    if (relay !== null && pick) throw codeError('INVALID_REQUEST');   // two ways to ask for one dialog: a panel bug
    const relayed = lane === 'tab' && relay !== null;
    // In memory; the host repeats the check authoritatively. A start that a stop already cancelled still holds the lane
    // until it has unwound (a hung getUserMedia can keep it there for a long time). Answering ALREADY_RUNNING to the
    // NEXT press would be wrong twice: nothing is running, and the panel deliberately ignores that code, so the press
    // would vanish without a word. LANE_STOPPING is what the panel shows as "still stopping, press Start again".
    const inFlight = starting.get(lane);
    if (inFlight) throw codeError(inFlight.cancelled ? 'LANE_STOPPING' : 'ALREADY_RUNNING');
    // `dialogAsked` = host/lane-start of a share-dialog start has been sent: a dialog may be open in the document now.
    const run = { cancelled: false, signal: null, whenCancelled: null, dialogAsked: false };
    run.whenCancelled = new Promise((resolve) => { run.signal = resolve; });
    starting.set(lane, run);
    const alive = () => { if (run.cancelled) throw codeError('START_CANCELLED'); };
    try {
      // 1. Settings and key. The worker is the only context that reads the key. A stored personal key wins and never
      //    falls back; without one the whole built-in pool travels, and the lane moves through it by itself (§20).
      let settings;
      let personal;
      try { settings = await readSettings(local); personal = await readKey(local); } catch { throw codeError('INTERNAL'); }
      alive();
      const credential = resolveCredential({ personal, builtin: builtinKeys });
      if (credential === null) throw codeError('CREDENTIAL_REQUIRED');

      // 2. Tab lane: the tab must exist and be capturable by scheme. Armed (the toolbar icon was clicked on it) means
      //    the instant path below. Anything else is NEEDS_ARM, unless the panel asked for Chrome's share dialog
      //    (`pick`, §20, which it sends for every tab it does not read as armed): that start is asked through the share
      //    picker (§19). NEEDS_ARM is the defense for a stale armed record (the panel thought the tab armed and sent no
      //    `pick`); the panel answers it with one more start with `pick`. A tab that has no armed record at all is refused
      //    HERE, before any host work, and creates no offscreen document; a record that outlived Chrome's grant is only
      //    found by the mint (step 6), after the document exists and is flagged up.
      //    A relay start (§22) has its capture already: the tab it interprets is the one chosen in the dialog, so the
      //    panel's tab is neither looked up nor refused here.
      let armed = false;
      let tab = null;
      if (lane === 'tab' && !relayed) {
        try { tab = await tabs.get(tabId); } catch { throw codeError('TAB_GONE'); }
        alive();
        if (!isObject(tab)) throw codeError('TAB_GONE');
        if (typeof tab.url === 'string' && !CAPTURABLE_SCHEMES.includes(schemeOf(tab.url))) throw codeError('TAB_UNSUPPORTED');
        armed = await arming.isArmed(tabId);
        alive();
        if (!armed && !pick) throw codeError('NEEDS_ARM');
      }

      // 3. Wait out a lane that is still stopping. This MUST happen before the mint: an id the host then refuses
      //    stays pending and blocks the next mint of that tab ("Cannot capture a tab with an active stream.").
      //    For the same reason a lane the host already runs is refused HERE (§20 review: a panel that had no host
      //    state yet sent a start next to a running lane, and the id it left pending broke the next icon click).
      if (await hostExists()) {
        for (let waited = 0; ; waited += STOP_POLL_MS) {
          alive();
          const answer = await ping();   // a FRESH ping each time
          alive();
          if (answer.ok && ACTIVE_LANE_PHASES.includes(answer.lanes?.[lane])) throw codeError('ALREADY_RUNNING');
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

      // 5. The request. The credential (`key` or `keys`) is copied into the one message below and nowhere else.
      const payload = {
        lane, ...credential,
        request: laneRequestOf(settings, lane),
        voiceGender: settings.voiceGender,
        muted: settings.speechMuted,
        captions: settings.lanes[lane].captions,
        style: hostSettingsOf(settings).style,
      };

      // 6. The mint is the LAST awaited step before the send: the id is single-use and short-lived. A grant that
      //    turns out to be gone (the armed record was stale; mapMintError cleared it) is NEEDS_ARM, which the panel
      //    answers with one more start with `pick` (§20); a start that already carries `pick` goes on through the picker.
      let picking = false;
      if (relayed) {
        // §22: no mint and no label; the host listens on the relay channel and plays what the panel sends.
        payload.tab = { relay, tabId: chosenTab, passthrough, originalVolume: settings.lanes.tab.originalVolume };
      } else if (lane === 'tab') {
        let streamId = null;
        if (armed) {
          try { streamId = await mintStreamId(tabId, lane); } catch (error) { if (error?.code !== 'NEEDS_ARM' || !pick) throw error; }
          alive();   // a stop that landed during the mint: nothing is sent, the host already got its host/lane-stop
        }
        if (streamId !== null) {
          payload.tab = { tabId, streamId, originalVolume: settings.lanes.tab.originalVolume };
        } else {
          picking = true;
          const nonce = makeNonce();
          await labelTab(tab, nonce, { waitMs: LIMITS.pickLabelWaitMs, cancelled: run.whenCancelled });
          alive();
          payload.tab = { pick: nonce, originalVolume: settings.lanes.tab.originalVolume };
        }
      }
      const message = makeMessage('host/lane-start', payload);
      // A picker start answers only after the user chose (or closed the dialog): keep this worker alive meanwhile.
      const release = picking ? keepAwake() : () => {};
      const sentAt = now();
      run.dialogAsked = picking;   // set in the turn of the send: a stop that cancels this run from now on may leave a dialog behind
      let res;
      try {
        res = await sendToHost(message);
        // Exactly ONE retry: the document was not listening yet. For a picker start only while that can still be the
        // reason; a document that went away with the dialog open is reported, not asked a second time. Never for a
        // cancelled run: its stop may have closed the document on purpose (closeLeftOverDialog), and a retry would
        // create a new one (flagged down) only for alive() to end the run.
        if (!res.ok && res.code === 'HOST_UNAVAILABLE' && !run.cancelled && (!picking || now() - sentAt < PICK_RETRY_WINDOW_MS)) {
          await ensureOffscreen();
          alive();
          res = await sendToHost(message);
        }
      } finally { release(); }

      // 7. Stop wins: a stop that reached the host before this start, or just after it, must leave the lane off.
      if (run.cancelled) {
        await sendToHost(makeMessage('host/lane-stop', { lane }));
        throw codeError('START_CANCELLED');
      }
      if (!res.ok) throw codeError(res.code);
      await settle(() => session.remove(STORAGE_KEYS.lastStop));   // a new run began
      // A picker start reports the tab the user really chose (null: it could not be told, so no page gets captions); a
      // relay start (§22) names it itself.
      const reported = Number.isInteger(res.tabId) ? res.tabId : null;
      const captured = relayed ? chosenTab : picking ? reported : tabId;
      afterLaneStarted(lane, captured).catch(() => {});
    } finally {
      if (starting.get(lane) === run) starting.delete(lane);
    }
  }

  // A dialog that a stop leaves open (Chrome's share dialog cannot be closed from the document that asked for it) is a
  // trap, seen in headless Chrome for Testing 149 (docs/extension.md §20, check 20.5; headed Chrome and Windows
  // UNVERIFIED): while it is open, a tab-capture getUserMedia in the SAME document never completes. So the icon (an instant
  // stream-id start) could not take over an open dialog or one left behind, and a Stop then cost startSettleMs. Closing
  // the offscreen document removes the dialog at once (the next start recreates the document, through ensureOffscreen).
  // It is done only when nothing else lives in the document: `cancelled` = the lanes whose start this stop cancelled
  // (they are being torn down; their unwinding start still sits in `starting`, hence closeHost's `except`); any other
  // lane must be idle in a FRESH ping, and a ping that fails means the host is unusable, so it is closed too. A
  // running, starting, reconnecting or stopping microphone keeps the document: closing it would end the microphone.
  // KNOWN LIMIT: with the microphone running, the dialog this stop cancelled stays open (the next dialog start takes it
  // over inside the same document), and an instant tab start (the icon) can hang at "Checking permissions..." until
  // that dialog is answered, because the document cannot be closed.
  // The close runs inside the lifecycle mutex, so it waits for an ensureOffscreen in progress (a few ms; at most the
  // handshake's PING_ATTEMPTS * PING_INTERVAL_MS for a document that does not answer) and the stop answers after it.
  async function closeLeftOverDialog(cancelled) {
    const answer = await ping();
    if (answer.ok && LANES.some((name) => !cancelled.includes(name) && !IDLE_LANE_PHASES.includes(answer.lanes?.[name]))) return false;
    return closeHost({ except: cancelled });
  }

  // 6.11 sw/lane-stop: cancel starts that have not reached the host, then tell the host (best effort, never throws).
  async function stopLane({ lane } = {}) {
    const named = LANES.includes(lane) ? [lane] : LANES;
    const cancelled = [];
    let dialog = false;
    for (const name of named) {
      const run = starting.get(name);
      if (!run) continue;
      run.cancelled = true;
      run.signal();
      cancelled.push(name);
      dialog ||= run.dialogAsked;
    }
    await settle(() => sendToHost(makeMessage('host/lane-stop', LANES.includes(lane) ? { lane } : {})));
    if (dialog) await settle(() => closeLeftOverDialog(cancelled));
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

  // Two one-time moves of an UPDATED install, each from the version that introduced it; nothing else changes.
  // §20 (0.5.0): 0.4.x started every lane muted, and a member heard nothing: an update from a version before 0.5.0
  // turns the interpreted voice on ONCE; a later mute is the user's own and stays.
  // 0.5.1 (2026-10-08, owner): both lanes default to the latest Google Live model; an update from a version before 0.5.1
  // moves a tab lane that still holds the old default (the translation-only preview) to it ONCE, and a model the user
  // chose stays. With no stored settings there is nothing to change: the new defaults apply, and the panel still
  // seeds the languages on first run.
  async function migrateAfterUpdate(details) {
    if (details?.reason !== 'update') return;
    const voiceOn = compareVersions(details.previousVersion, VOICE_ON_SINCE) === -1;
    const latestModel = compareVersions(details.previousVersion, LATEST_MODEL_SINCE) === -1;
    if (!voiceOn && !latestModel) return;
    const stored = await settle(() => local.get(STORAGE_KEYS.settings));
    if (!isObject(stored) || !isObject(stored[STORAGE_KEYS.settings])) return;
    await settle(() => updateSettings(local, (settings) => {
      if (voiceOn) settings.speechMuted = false;
      if (latestModel) moveOldTabDefaultModel(settings);
    }));
  }

  async function onInstalled(details) {
    await settle(async () => {
      await contextMenus.removeAll();   // menus persist across restarts: creating twice would throw "duplicate id"
      contextMenus.create({ id: MENU_ID, title: i18n.getMessage('menuOpen'), contexts: [...MENU_CONTEXTS] });
    });
    await settle(() => session.remove([STORAGE_KEYS.armed, STORAGE_KEYS.host, STORAGE_KEYS.lastStop, STORAGE_KEYS.autostart]));
    await migrateAfterUpdate(details);
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
  // §20: the click also asks the panel of that window to start on that tab. The record is written AFTER the arming (the
  // panel starts only on a tab it reads as armed) and only for a page that can be captured; on any other page the click
  // only opens the panel, whose arm note says the page cannot be interpreted. The panel consumes the record once.
  function requestAutostart(tab) {
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.windowId)) return undefined;
    if (typeof tab.url === 'string' && !CAPTURABLE_SCHEMES.includes(schemeOf(tab.url))) return undefined;
    return writeRecord(STORAGE_KEYS.autostart, { v: 1, tabId: tab.id, windowId: tab.windowId, at: now() });
  }
  function armAndOpen(tab) {
    const opened = openPanel(tab);
    const asked = arming.arm(tab).then(() => requestAutostart(tab));
    return Promise.allSettled([opened, asked]).then(() => considerOverlay(tab?.id));
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
        'sw/lane-start': async ({ lane, tabId, pick, relay, passthrough, chosenTab }) => {
          await startLane({ lane, tabId, pick: pick === true,
            ...(relay === undefined ? {} : { relay, passthrough: passthrough === true, chosenTab: chosenTab ?? null }) });
          return {};
        },
        'sw/lane-stop': async ({ lane }) => { await stopLane({ lane }); return {}; },
        'sw/tab-label': (message) => labelPanelTab(message),
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
