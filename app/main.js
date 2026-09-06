// New implementation of design-v0.6 §§5.4, 6.1, 7.1, 11, 12 and 13: the page
// bootstrap that wires i18n, the shared-key fragment, configuration, capture,
// the voice and sequential engines, the shell, diagnostics, settings and the
// PWA layer. Nothing is ported from interp-web or jp-patch.
//
// Importing this module has no effect in Node; in a browser the guarded call
// at the bottom starts the app. Order (P1-13..18 contracts):
//   1. strip the URL fragment (history.replaceState) before anything else;
//   2. loadI18n from navigator.languages (or the remembered UI language);
//   3. createAppConfig (storage only when personal-key persistence is offered)
//      and hand the held fragment to the key store; loadPersonal('gemini');
//   4. one createCapture and one createVoiceEngine shared by the sequential
//      engine and diagnostics; mount the shell; diagnostics; settings; PWA.
// P2: listening ownership and generation guards join the P1 lifecycle.
// P3-07: the site policy (design-p3 §1.5-§1.6) gates every execution path
// here, not only the buttons: sequential start/retry/replay, diagnostics,
// direct Live and hub join call policy.assertAction() first, the router checks
// the route again, and a restrictive policy change runs the existing
// stopWork() cleanup. A wider policy only reopens the gate; nothing restarts.
// P3-11: venue live control (design-p3 §1.8). One control state per app feeds
// policyRuntime.setHubControl(); the hub listening socket carries the
// negotiation while the user has joined an event, and direct listening keeps a
// control-only audience connection instead. That connection is not app work:
// it holds no activity lease, uses no key, microphone or speech, and
// stopWork() never closes it, so a release notice still arrives after a stop.
// It ends only with leaving the event, the event ending in the policy, or teardown.
// Teardown: policy -> settings -> listening -> diagnostics -> shell -> engine -> config -> pwa.
// No logging anywhere: errors become dictionary keys rendered as text.
import fallbackDictionary from './i18n/boot-fallback.js';
import { createI18n, loadI18n } from './i18n/index.js';
import { bootstrapSharedKey } from './security/bootstrap.js';
import { redact } from './security/redact.js';
import { createAppConfig } from './config.js';
import { createPlatform } from './platform.js';
import { createCapture } from './audio/capture.js';
import { createDeviceTTS } from './audio/device-tts.js';
import { createVoiceEngine } from './engine/voice.js';
import { createSeqEngine } from './engine/seq.js';
import { createDiagnostics } from './engine/diagnostics.js';
import { DEFAULT_TAB, TABS, mount } from './ui/shell.js';
import { createSettingsView } from './ui/settings-view.js';
import { errorCodeKey, resolveKey } from './ui/errors.js';
import { createPolicyClient } from './policy/client.js';
import { ACTIONS, PolicyError, createPolicyRuntime, isPolicyError } from './policy/runtime.js';
import { createPreferences } from './preferences.js';
import { withDeadline } from './engine/retry.js';
import { TURN_PHASE, isAppBusy } from './state.js';
import { ProviderError } from './providers/contract.js';
import { createActivity } from './engine/activity.js';
import { createSimEngine } from './engine/sim.js';
import { createHubListenEngine } from './engine/hub-listen.js';
import { createHubClient, createHubControl } from './hub/client.js';
import { REGISTERED_HUBS, validateRoomCode } from './hub/protocol.js';
import { resolveEffective } from './policy/resolve.js';
import { createPwa, createPwaControls, UPDATE_KEYS } from './pwa.js';

// UI settings live in localStorage per device (§11.1); keys are ours alone.
export const UI_LANGUAGE_STORAGE_KEY = 'interp-app.ui.v1.language';
export const INSTALL_HINT_STORAGE_KEY = 'interp-app.ui.v1.install-hint';
// P3-02e: the last selected tab; a first visit opens simultaneous interpretation.
export const UI_TAB_STORAGE_KEY = 'interp-app.ui.v1.tab';
export const ROOT_ID = 'app';
// Application startup deadline, not a provider retry budget.
export const BOOT_TIMEOUT_MS = 10000;
// Live voice audio is 24 kHz PCM (P1-10 player); the context is created once.
export const AUDIO_CONTEXT_OPTIONS = Object.freeze({ sampleRate: 24000 });
export const PROVIDER_ID = 'gemini';
const GESTURE_EVENTS = Object.freeze(['pointerdown', 'keydown']);
// Notices for policy changes that keep or reopen work (§1.5 table); a change
// that ends work is announced by the stop path itself, only when work ran.
const POLICY_CHANGE_KEYS = Object.freeze({ reopened: 'policy.changed.reopened', display: 'policy.changed.display',
  pricing: 'policy.changed.pricing', updated: 'policy.changed.updated' });
const languagePattern = /^(ko|en|ja)$/;
// Policy sharedEvents[].id shape (P3-04 schema), for explicit event participation.
const eventIdPattern = /^[a-z0-9-]{1,64}$/;

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

/** localStorage when it is usable; storage failures are treated as "no storage". */
export function usableStorage(win) {
  const storage = attempt(() => win.localStorage);
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    && typeof storage.removeItem === 'function' ? storage : null;
}
export function readUiLanguage(storage) {
  const value = attempt(() => storage?.getItem(UI_LANGUAGE_STORAGE_KEY));
  return typeof value === 'string' && languagePattern.test(value) ? value : undefined;
}
export function writeUiLanguage(storage, language) {
  if (!languagePattern.test(language)) return false;
  return attempt(() => { storage.setItem(UI_LANGUAGE_STORAGE_KEY, language); return true; }) === true;
}
/** The remembered tab, or undefined for a first visit or a corrupt value. */
export function readUiTab(storage) {
  const value = attempt(() => storage?.getItem(UI_TAB_STORAGE_KEY));
  return typeof value === 'string' && TABS.includes(value) ? value : undefined;
}
export function writeUiTab(storage, tab) {
  if (!TABS.includes(tab)) return false;
  return attempt(() => { storage.setItem(UI_TAB_STORAGE_KEY, tab); return true; }) === true;
}
/** The manifest link follows the UI language (§12: one manifest per language). */
export function applyManifestLanguage(doc, language) {
  if (!languagePattern.test(language)) return false;
  const link = attempt(() => doc.querySelector('link[rel="manifest"]'));
  if (!link) return false;
  link.setAttribute('href', `./manifest.${language}.webmanifest`);
  return true;
}

/**
 * Step 1 of the bootstrap: remove the fragment from the URL and history
 * before any other module runs, holding the payload for the key store that
 * does not exist yet. Returns { received, deliver(keyStore) }; deliver hands
 * the fragment over exactly once and drops it.
 */
export function captureSharedFragment({ location, history }) {
  let held = null;
  const holder = { receiveSharedFragment(fragment) { held = fragment; } };
  const result = bootstrapSharedKey({ location, history, keyStore: holder });
  return Object.freeze({
    received: result.received,
    deliver(keyStore) {
      const fragment = held;
      held = null;
      if (fragment === null) return false;
      keyStore.receiveSharedFragment(fragment);
      return true;
    },
  });
}

/**
 * startApp({ window, root?, fetch?, setTimeout?, clearTimeout?, now? }) boots the
 * application into root (default: #app) and resolves an app handle
 * { i18n, config, engine, shell, diagnostics, settingsView, pwa, getAudioContext,
 *   policy, policyClient, preferences, setLanguage, close }. A failed start
 * renders the failure as dictionary text inside root and resolves null;
 * nothing is logged. The shell mounts before the first policy reply; the
 * handle resolves once that reply (or its failure) is in, so callers see a
 * settled gate. `now` returns epoch milliseconds for policy dates.
 */
// hubs is a trusted code registry, never a settings or QR value.
async function bootApp({ window: win, root: givenRoot, signal: bootSignal, hubs = REGISTERED_HUBS, fetch: fetcher = win?.fetch?.bind?.(win),
  setTimeout: schedule = win?.setTimeout?.bind?.(win), clearTimeout: cancelTimer = win?.clearTimeout?.bind?.(win),
  now = () => Date.now() } = {}) {
  const doc = win?.document;
  const nav = win?.navigator;
  const root = givenRoot ?? attempt(() => doc.getElementById(ROOT_ID));
  if (!doc || !nav || !root || typeof fetcher !== 'function' || typeof schedule !== 'function' || typeof cancelTimer !== 'function'
    || typeof now !== 'function') {
    throw new Error('INVALID_REQUEST');
  }
  const timing = { setTimeout: schedule, clearTimeout: cancelTimer };
  const loadMessages = async (options) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // Own cancellation while dictionaries load, before the shell owns pagehide.
    win.addEventListener?.('pagehide', abort);
    bootSignal?.addEventListener('abort', abort, { once: true });
    if (bootSignal?.aborted) abort();
    try {
      return await withDeadline((signal) => loadI18n({ ...options, signal }),
        { ...timing, signal: controller.signal, timeoutMs: BOOT_TIMEOUT_MS });
    } finally {
      win.removeEventListener?.('pagehide', abort);
      bootSignal?.removeEventListener('abort', abort);
    }
  };
  const showFailure = (i18n, code) => showBootFailure(root, i18n, code);

  // 1. The fragment leaves the URL before i18n is fetched or storage is read.
  let shared;
  try {
    shared = captureSharedFragment({ location: win.location, history: win.history });
  } catch (error) {
    const i18n = await loadMessages({ fetch: fetcher, languages: nav.languages ?? [] }).catch(() => null);
    showFailure(i18n, redact(error).code);
    return null;
  }

  // 2. UI language: remembered choice first, then navigator.languages.
  const storage = usableStorage(win);
  const remembered = readUiLanguage(storage);
  let i18n;
  try {
    i18n = await loadMessages({ fetch: fetcher, languages: nav.languages ?? [], ...(remembered ? { language: remembered } : {}) });
  } catch (error) { showFailure(null, error?.code === 'ABORTED' ? 'ABORTED' : 'NETWORK_ERROR'); return null; }
  applyManifestLanguage(doc, i18n.language);

  let config = null, engine = null, voiceEngine = null, capture = null, store = null;
  let shell = null, settingsView = null, controls = null, diagnostics = null, pwa = null, closed = false;
  let audioContext = null, closing = null;
  let simEngine = null, hubEngine = null, listenEngines = null;
  let policyClient = null, policyRuntime = null, preferences = null, gatedEngine = null, gatedDiagnostics = null;
  // P3-11: live-control state, the joined event and the control-only connection.
  let hubControl = null, eventLink = null, membership = null, controlOp = null, listenControlled = false;
  let controlClosing = Promise.resolve(), linkState = 'idle', linkError = null;
  const activity = createActivity(timing);
  let lifecycleGeneration = 0, transitions = 0, cleanupFailed = false;
  const listeningBusy = () => closed || doc.hidden || cleanupFailed || activity.occupied || transitions > 0
    || simEngine?.snapshot().busy || hubEngine?.snapshot().busy;
  const busy = () => isAppBusy({ sequential: engine?.snapshot(),
    listening: [simEngine?.snapshot(), hubEngine?.snapshot()], activity: activity.snapshot(),
    diagnostics: diagnostics?.snapshot(), transitioning: cleanupFailed || transitions > 0 || config?.sessionManager.occupied === true });

  // Invalidate first; cleanup remains busy until every owner confirms closure.
  async function stopWork() {
    lifecycleGeneration++;
    transitions++;
    try {
      const results = await Promise.allSettled([activity.close(), engine?.stop(), diagnostics?.cancel()]);
      cleanupFailed = results.some(result => result.status === 'rejected');
      if (cleanupFailed) throw new ProviderError('SESSION_CLOSED');
    } finally {
      transitions--;
      pwa?.reloadIfPending();
    }
  }
  // A restrictive policy change (§1.5): the gate is already closed by the
  // runtime; active work ends through the same cleanup as a key change, and
  // late results are dropped by the lifecycle generation. Never auto-resumes.
  async function onPolicyStop() {
    if (!busy()) { lifecycleGeneration++; return; }
    notify?.('policy.changed.stopped');
    await stopWork();
  }
  // Router boundary guard; before the runtime exists nothing may route.
  const policyGuard = Object.freeze({ assertRoute(route) {
    if (!policyRuntime) throw new PolicyError('POLICY_LOADING');
    return policyRuntime.assertRoute(route);
  } });
  // Views map thrown errors with errorKey(), which cannot name PolicyError
  // codes; the block reason is set after their synchronous handler ran so the
  // notice the user sees is the policy reason (error.POLICY_* keys, P3-02).
  function announceBlock(error) {
    if (!isPolicyError(error)) return;
    const key = errorCodeKey(error.code);
    queueMicrotask(() => notify?.(key));
  }
  function gated(kind, fn) {
    return (...args) => {
      try { policyRuntime.assertAction(kind); } catch (error) { announceBlock(error); throw error; }
      return fn(...args);
    };
  }
  function ownedListener(raw, kind) {
    let lease = null;
    const end = () => kind === 'sim' ? raw.stop() : raw.leave();
    const stop = async () => {
      const epoch = lifecycleGeneration;
      if (lease) await lease.close();
      else await end();
      if (closed || epoch !== lifecycleGeneration) throw new ProviderError('ABORTED');
    };
    function start(request) {
      try { policyRuntime.assertAction(kind === 'sim' ? ACTIONS.simDirect : ACTIONS.hubJoin); }
      catch (error) { announceBlock(error); throw error; }
      if (closed || doc.hidden || cleanupFailed || transitions || engine.snapshot().busy
        || diagnostics?.snapshot().running != null || pwa?.snapshot().applying) throw new ProviderError('SESSION_LIMIT');
      const owned = activity.acquire(kind, { cancel: end, close: async () => {
        await end();
        if (kind === 'sim') await config.sessionManager.close();
      } });
      lease = owned;
      try {
        let handle;
        if (kind === 'sim') {
          const selection = config.keyStore.getSelection();
          if (!selection || selection.keySource !== 'personal'
            || !config.keyStore.getMetadata(selection.providerId, selection.keySource)) throw new ProviderError('CREDENTIAL_REQUIRED');
          // P3-02e: name the missing browser feature instead of a late generic
          // microphone failure (no getUserMedia: insecure context or old browser;
          // no AudioWorklet: streaming capture cannot run).
          if (typeof nav.mediaDevices?.getUserMedia !== 'function' || typeof win.AudioWorkletNode !== 'function'
            || typeof (win.AudioContext ?? win.webkitAudioContext) !== 'function') throw new ProviderError('INPUT_UNSUPPORTED');
          handle = raw.start(request, { ...selection, signal: owned.signal,
            sessionId: `listen-${owned.generation}` });
        } else handle = raw.join(request, { signal: owned.signal });
        Promise.resolve(handle.done).finally(() => owned.close()).catch(() => {});
        return handle;
      } catch (error) {
        owned.close().catch(() => {});
        throw new ProviderError(redact(error).code);
      }
    }
    return Object.freeze({ ...raw, start, join: start, stop, leave: stop });
  }
  const removers = [];
  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    removers.push(() => attempt(() => target.removeEventListener(type, handler, options)));
  };
  let getAudioContext, notify;
  try {
    // 3. Configuration; storage is offered only when it is actually usable.
    config = createAppConfig({ fetch: fetcher, WebSocket: win.WebSocket, Blob: win.Blob, storage: storage ?? undefined, ...timing,
      policy: policyGuard });
    // 3b. Site policy: one fixed policy.json at the deployed root (§1.3), the
    // personal-choice store (P3-05) and the runtime that gates execution.
    policyClient = createPolicyClient({ fetch: fetcher, location: win.location, now, ...timing,
      registeredHubIds: hubs.map((hub) => hub.id) });
    preferences = createPreferences({ storage, now });
    policyRuntime = createPolicyRuntime({ client: policyClient, preferences, activity, sessionManager: config.sessionManager,
      now, stopWork: onPolicyStop });
    const startupNotices = [];
    try { shared.deliver(config.keyStore); } catch (error) { startupNotices.push(`error.${redact(error).code}`); }
    if (storage) {
      try { config.keyStore.loadPersonal(PROVIDER_ID); } catch (error) {
        // A corrupt stored value is removed; the user re-enters the key.
        attempt(() => config.keyStore.deleteKey(PROVIDER_ID, 'personal'));
        startupNotices.push(`error.${redact(error).code}`);
      }
    }

    // 4. Audio: one 24 kHz context, created and resumed inside a user gesture.
    getAudioContext = function () {
      const Context = win.AudioContext ?? win.webkitAudioContext;
      if (typeof Context !== 'function') return null;
      if (!audioContext || audioContext.state === 'closed') {
        audioContext = attempt(() => new Context({ ...AUDIO_CONTEXT_OPTIONS })) ?? attempt(() => new Context()) ?? null;
      }
      if (audioContext && audioContext.state !== 'running') attempt(() => Promise.resolve(audioContext.resume()).catch(() => {}));
      return audioContext;
    };
    for (const type of GESTURE_EVENTS) listen(doc, type, () => { getAudioContext(); }, { capture: true, passive: true });

    const deviceTTS = typeof win.speechSynthesis?.speak === 'function' && typeof win.SpeechSynthesisUtterance === 'function'
      ? createDeviceTTS({ speechSynthesis: win.speechSynthesis, SpeechSynthesisUtterance: win.SpeechSynthesisUtterance, ...timing })
      : null;
    const getDeviceVoices = typeof win.speechSynthesis?.getVoices === 'function'
      ? () => attempt(() => win.speechSynthesis.getVoices()) ?? [] : null;

    // 5. One capture and one voice engine shared by the sequential engine and diagnostics.
    capture = createCapture({ platform: createPlatform(win),
      onLevel: (level) => shell?.seqView.onLevel(level), onWarning: (warning) => shell?.seqView.onWarning(warning) });
    voiceEngine = createVoiceEngine({ router: config.router, deviceTTS, getAudioContext, sessionManager: config.sessionManager, ...timing });
    engine = createSeqEngine({ config, capture, voiceEngine, ...timing,
      isBusy: () => listeningBusy() || diagnostics?.snapshot().running != null || pwa?.snapshot().applying === true });
    store = engine.state;
    notify = (key) => { if (!store.closed) attempt(() => store.setNotice(resolveKey(i18n, key))); };
    // Every sequential start path is gated; the raw engine stays internal.
    gatedEngine = Object.freeze({ ...engine, startRecording: gated(ACTIONS.seqStart, engine.startRecording),
      submitText: gated(ACTIONS.seqStart, engine.submitText), retry: gated(ACTIONS.seqRetry, engine.retry),
      replay: gated(ACTIONS.seqReplay, engine.replay) });

    simEngine = createSimEngine({ router: config.router, sessionManager: config.sessionManager,
      platform: createPlatform(win), getAudioContext, ...timing,
      resolveFallback: (...args) => config.resolveFallback(PROVIDER_ID, 'live')?.(...args),
      onLevel: level => shell?.simView?.onLevel(level) });
    // P2-13 requires speak/cancel even on browsers without speech synthesis.
    // Keep captions available through its existing unavailable-output contract.
    const hubTTS = deviceTTS ?? Object.freeze({
      speak: async () => ({ status: 'unavailable' }), cancel() {},
    });
    // P3-11: live control (design-p3 §1.8). Only a code-registered hub the site
    // policy allows is trusted; the negotiation is sent only for the event the
    // user joined, and the hub's answer is applied only for that same event.
    hubControl = createHubControl({ now, ...timing });
    const hubClient = createHubClient({ hubs, WebSocket: win.WebSocket, ...timing });
    const controlClient = createHubClient({ hubs, WebSocket: win.WebSocket, ...timing });
    const hubRule = () => policyRuntime.snapshot().policy?.hubControl ?? null;
    const hubAllowed = (hubId) => { const rule = hubRule(); return rule?.enabled === true && rule.allowedHubIds.includes(hubId); };
    // The hello of the next attempt: the joined event plus the last accepted epoch and revision.
    const controlFor = (hubId) => {
      if (!membership || !hubAllowed(hubId)) return null;
      const state = hubControl.snapshot();
      return state.supported === true && state.eventId === membership.eventId
        ? { eventId: membership.eventId, epoch: state.epoch, revision: state.revision ?? 0 } : { eventId: membership.eventId };
    };
    // Whichever connection carries the negotiation feeds the one control state.
    const controlEvents = (hubId, inner) => (event) => {
      inner?.(event);
      if ((event.type !== 'hello' && event.type !== 'control') || !membership || !hubAllowed(hubId)) return;
      if (event.type === 'hello') hubControl.negotiate(event.control?.eventId === membership.eventId ? event.control : null);
      else hubControl.receive(event);
    };
    const linkListeners = new Set();
    const notifyLink = () => { for (const listener of [...linkListeners]) attempt(() => listener(eventLink.snapshot())); };
    // Control-only audience connection for direct listening: receive-only, no
    // activity lease, no key, microphone or speech. Suspended while a listening
    // socket carries the negotiation and resumed when that socket has closed.
    function openControlOnly() {
      if (!membership || controlOp || listenControlled || closed || hubRule()?.allowDirectSubscription !== true) return;
      const { hubId, roomCode } = membership;
      let op;
      try {
        op = controlClient.join({ hubId, roomCode }, { control: () => controlFor(hubId),
          onEvent: controlEvents(hubId, (event) => {
            if (event.type === 'connection' && controlOp === op) { linkState = event.state; notifyLink(); }
          }) });
      } catch (error) { linkState = 'failed'; linkError = redact(error).code; notifyLink(); return; }
      controlOp = op; linkState = 'connecting'; linkError = null;
      op.done.then((outcome) => {
        if (controlOp !== op) return;
        controlOp = null; linkState = outcome.state;
        linkError = outcome.error && outcome.error.code !== 'ABORTED' ? outcome.error.code : null;
        // Ended without a successor: the venue control cannot be confirmed (TTL covers reconnects).
        if (membership && !listenControlled) hubControl.disconnected();
        notifyLink();
      });
      notifyLink();
    }
    function suspendControlOnly() {
      const op = controlOp;
      if (!op) return controlClosing;
      controlOp = null; linkState = 'stopping'; notifyLink();
      // Ownership is kept until the socket has physically closed (P2-11 contract).
      controlClosing = op.close().catch(() => op.closed).then(() => { if (controlOp === null && linkState === 'stopping') { linkState = 'idle'; notifyLink(); } });
      return controlClosing;
    }
    async function resumeControlOnly() { await controlClosing; openControlOnly(); }
    const listenClient = Object.freeze({ join(request, options = {}) {
      const hubId = request?.hubId;
      const carries = controlFor(hubId) !== null;
      const handle = hubClient.join(request, { ...options, onEvent: controlEvents(hubId, options.onEvent),
        ...(carries ? { control: () => controlFor(hubId) } : {}) });
      if (carries) {
        // The listening socket is reused for control (§1.8); one connection per hub.
        listenControlled = true;
        void suspendControlOnly();
        handle.closed.then(() => { listenControlled = false; void resumeControlOnly(); });
      }
      return handle;
    } });
    // The joined event: explicit participation first, else the shared key's event (P3-08).
    function syncEvent() {
      const shared = attempt(() => config.keyStore.getMetadata(PROVIDER_ID, 'shared')?.eventId);
      attempt(() => policyRuntime.setEvent(membership?.eventId ?? (typeof shared === 'string' ? shared : null)));
    }
    const eventEntries = () => {
      const policy = policyRuntime.snapshot().policy;
      return Object.freeze((policy?.sharedEvents ?? []).map((entry) => Object.freeze({ id: entry.id, label: entry.label, eventName: entry.eventName,
        status: resolveEffective({ policy, preferences: null, event: entry.id, now }).event?.status ?? 'removed' })));
    };
    function joinEvent({ eventId, hubId, roomCode } = {}) {
      if (closed) throw new ProviderError('SESSION_CLOSED');
      if (membership) throw new ProviderError('SESSION_LIMIT');
      if (typeof eventId !== 'string' || !eventIdPattern.test(eventId)) throw new ProviderError('INVALID_REQUEST');
      validateRoomCode(roomCode);
      const snapshot = policyRuntime.snapshot();
      const refuse = (code) => { const error = new PolicyError(code); announceBlock(error); throw error; };
      if (snapshot.blocked !== null) refuse(snapshot.blocked.code);
      const rule = snapshot.policy?.hubControl;
      if (!rule || rule.enabled !== true) refuse('POLICY_FEATURE_DISABLED');
      if (!rule.allowedHubIds.includes(hubId)) throw new ProviderError('HUB_REQUIRED');
      if (resolveEffective({ policy: snapshot.policy, preferences: null, event: eventId, now }).event?.status !== 'active') refuse('EVENT_ENDED');
      membership = { eventId, hubId, roomCode };
      syncEvent();
      try { policyRuntime.assertAction(ACTIONS.eventJoin); }
      catch (error) { membership = null; syncEvent(); announceBlock(error); throw error; }
      openControlOnly();
      notify('event.joined');
      notifyLink();
    }
    // Leaving ends event-scoped work, clears the control state (the gate reopens
    // only through the policy runtime) and closes the control-only connection.
    async function leaveEvent() {
      if (!membership) return;
      membership = null;
      notifyLink();
      if (busy()) await stopWork().catch(() => {});
      hubControl.reset();
      syncEvent();
      await suspendControlOnly();
      if (!closed) notify('event.left');
      notifyLink();
    }
    eventLink = Object.freeze({
      snapshot() {
        const rule = hubRule();
        return Object.freeze({ enabled: rule?.enabled === true, controlOnlyAllowed: rule?.allowDirectSubscription === true,
          allowedHubIds: Object.freeze([...(rule?.allowedHubIds ?? [])]), events: eventEntries(),
          joined: membership ? Object.freeze({ eventId: membership.eventId, hubId: membership.hubId }) : null,
          connection: linkState, errorCode: linkError, control: hubControl.snapshot() });
      },
      subscribe(listener) {
        if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
        linkListeners.add(listener); return () => linkListeners.delete(listener);
      },
      join: joinEvent, leave: leaveEvent,
    });
    removers.push(hubControl.subscribe((state) => { attempt(() => policyRuntime.setHubControl(membership ? state : null)); notifyLink(); }));
    hubEngine = createHubListenEngine({ client: listenClient, deviceTTS: hubTTS, ...timing });
    listenEngines = { direct: ownedListener(simEngine, 'sim'), hub: ownedListener(hubEngine, 'hub') };
    shell = mount({ root, i18n, engine: gatedEngine, listenEngines, hubs,
      beforeTabChange: stopWork, document: doc, window: win, ...timing,
      // The last tab is remembered per device; the first visit opens simultaneous interpretation.
      initialTab: readUiTab(storage) ?? DEFAULT_TAB,
      onTabChange: (tab) => { if (storage) writeUiTab(storage, tab); } });
    // P3-02c: caption board preferences share the UI storage; only this module reads localStorage.
    if (storage) shell.simView?.setStorage(storage);
    // P3-11: the simultaneous screen offers event participation and shows the control state.
    shell.simView?.setHubControl(eventLink);
    removers.push(config.keyStore.subscribe(() => {
      if (busy()) stopWork().catch(() => notify('error.SESSION_CLOSED'));
      else lifecycleGeneration++;
      // The joined shared-key event follows the shared metadata (eventId once
      // P3-08's v2 payload carries it) unless the user joined an event explicitly.
      syncEvent();
    }));
    // The event list follows the policy; an event that is no longer active is left (§1.8 scope).
    removers.push(policyRuntime.subscribe((snapshot) => {
      if (membership && snapshot.policy && snapshot.eventId === membership.eventId && snapshot.event?.status !== 'active') {
        queueMicrotask(() => { leaveEvent().catch(() => {}); });
      }
      notifyLink();
    }));
    diagnostics = createDiagnostics({ config, voiceEngine, capture, getAudioContext, ...timing,
      isBusy: () => listeningBusy() || engine.snapshot().busy || pwa?.snapshot().applying === true });
    gatedDiagnostics = Object.freeze({ ...diagnostics, run: gated(ACTIONS.diagnostics, diagnostics.run) });
    // Policy changes that keep or reopen work are announced; a stop announces itself.
    removers.push(policyRuntime.subscribe((snapshot, change) => {
      const key = POLICY_CHANGE_KEYS[change.type];
      if (key) notify(key);
    }));
    pwa = createPwa({ window: win, navigator: nav, isBusy: busy, ...timing });
    removers.push(activity.subscribe(() => pwa.reloadIfPending()));
    removers.push(engine.subscribeWork(() => pwa.reloadIfPending()));
    removers.push(diagnostics.subscribe(() => pwa.reloadIfPending()));
    removers.push(config.sessionManager.subscribe(() => pwa.reloadIfPending()));
    const version = await pwa.getVersion();
    const standalone = pwa.snapshot().standalone;
    settingsView = createSettingsView({ shell, i18n, config, engine: gatedEngine, diagnostics: gatedDiagnostics, document: doc, persistence: storage !== null,
      app: { ...(version ? { version } : {}), standalone }, getDeviceVoices, simEngine,
      metrics: { snapshot: () => simEngine.snapshot().metrics,
        subscribe: fn => simEngine.subscribe(() => fn()) },
      onUiLanguageChange: (language) => { if (storage) writeUiLanguage(storage, language); applyManifestLanguage(doc, language); } });
    controls = createPwaControls({ root: settingsView.elements.appActions, document: doc, i18n, shell, pwa, notify });
    // P3-02e: the key badge and the simultaneous screen's "open settings"
    // action land on the key entry; a stored key can still be gone on this
    // device (iOS keeps separate storage for Safari and the home-screen app
    // and evicts script storage after seven days without use), so the key
    // section says that the key may have to be entered again here.
    removers.push(shell.onSettingsOpen((target) => {
      if (target !== 'key') return;
      const input = settingsView.elements.keyInput;
      attempt(() => input.scrollIntoView?.({ block: 'center' }));
      attempt(() => input.focus());
    }));
    const retentionNote = doc.createElement('p');
    retentionNote.setAttribute('class', 'settings-note settings-key-retention');
    const renderRetentionNote = () => { retentionNote.textContent = i18n.t('settings.keyRetentionHint'); };
    renderRetentionNote();
    settingsView.elements.sections.key.append(retentionNote);
    removers.push(shell.onLanguageChange(renderRetentionNote));
    listen(win.speechSynthesis, 'voiceschanged', () => settingsView.render());
    for (const key of startupNotices) notify(key);
  } catch {
    await teardown();
    showFailure(i18n, 'unknown');
    return null;
  }

  // Update available: one notice; the settings app section keeps the button.
  let updateAnnounced = false;
  removers.push(pwa.subscribe((snapshot) => {
    if (snapshot.updateAvailable && !updateAnnounced) { updateAnnounced = true; notify(UPDATE_KEYS.available); }
  }));
  // First successful interpretation suggests installing (§6.1 step 9), once.
  let installHinted = attempt(() => storage?.getItem(INSTALL_HINT_STORAGE_KEY)) === '1';
  removers.push(store.subscribe((snapshot) => {
    if (snapshot.activeTurnId === null) pwa.reloadIfPending();
    if (installHinted || pwa.snapshot().standalone || pwa.snapshot().installed) return;
    if (!snapshot.turns.some((turn) => turn.phase === TURN_PHASE.COMPLETED)) return;
    installHinted = true;
    attempt(() => storage?.setItem(INSTALL_HINT_STORAGE_KEY, '1'));
    // Deferred: the store is mid-commit inside this listener.
    schedule(() => notify('pwa.installPrompt'), 0);
  }));
  // The shell shows the offline badge; the notice says new turns need a connection (§13.2).
  listen(win, 'offline', () => notify('pwa.offline'));
  // Leaving the page ends active work; an unload (not bfcache) closes everything.
  // The policy timer stops with the page and resumes on foreground return (§1.5).
  listen(win, 'pagehide', (event) => {
    policyClient.stop();
    stopWork().catch(() => notify('error.SESSION_CLOSED'));
    if (event?.persisted !== true) close();
  });
  listen(doc, 'visibilitychange', () => {
    if (doc.hidden) {
      policyClient.stop();
      stopWork().catch(() => notify('error.SESSION_CLOSED'));
    } else if (!closed) void policyClient.start();
  });
  // Registration happens last so it never delays the first paint.
  pwa.register();
  // The shell is up; the handle waits for the first policy reply so the gate
  // is settled (ready or blocked with a specific reason) when callers get it.
  await policyClient.start();

  async function teardown() {
    // Own listeners first, then the P1-16 order: policy -> settings ->
    // diagnostics -> shell -> engine -> config; PWA and audio context go last.
    for (const remove of removers.splice(0)) remove();
    policyRuntime?.close();
    policyClient?.stop();
    controls?.destroy();
    settingsView?.destroy();
    await stopWork().catch(() => {});
    // The control-only connection ends with the page, never with stopWork().
    membership = null;
    hubControl?.reset();
    if (controlOp) { const op = controlOp; controlOp = null; await op.close().catch(() => {}); }
    hubControl?.close();
    await Promise.allSettled([simEngine?.close(), hubEngine?.close()]);
    await diagnostics?.close();
    shell?.destroy();
    if (engine) await engine.close();
    else await voiceEngine?.close();
    await config?.dispose();
    pwa?.close();
    if (audioContext) { const context = audioContext; audioContext = null; attempt(() => Promise.resolve(context.close()).catch(() => {})); }
  }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = teardown();
    return closing;
  }

  return Object.freeze({
    i18n, config, engine: gatedEngine, capture, voiceEngine, shell, diagnostics: gatedDiagnostics, settingsView, controls, pwa, getAudioContext,
    listenEngines, activity, stopWork, policy: policyRuntime, policyClient, preferences,
    // P3-11: live-control state and the event link the simultaneous screen uses.
    hubControl, eventLink,
    get closed() { return closed; },
    // UI language only (the interpretation pair is engine state).
    setLanguage(language) {
      const applied = shell.setLanguage(language);
      if (storage) writeUiLanguage(storage, applied);
      applyManifestLanguage(doc, applied);
      return applied;
    },
    close,
  });
}

// Only minimal English failure messages belong in the bootstrap module graph.
// Tests keep this subset identical to en.json. No raw exception reaches the DOM.
function showBootFailure(root, i18n, code = 'unknown') {
  if (!root) return;
  const messages = i18n ?? createI18n({ dictionaries: { en: fallbackDictionary }, language: 'en' });
  root.setAttribute('role', 'alert');
  root.setAttribute('lang', messages.language);
  root.textContent = messages.t(resolveKey(messages, `error.${code}`));
}

export async function startApp(options = {}) {
  const root = options.root ?? attempt(() => options.window.document.getElementById(ROOT_ID));
  if (!root) throw new Error('INVALID_REQUEST');
  root.removeAttribute('role');
  root.removeAttribute('lang');
  root.textContent = '';
  try { return await bootApp(options); }
  catch { showBootFailure(root); return null; }
}

// Browser entry: deferred modules normally run after parsing. Also support
// an embedding that imports the entry before #app has been parsed.
export function autoStart(win) {
  const run = () => startApp({ window: win }).catch(() => {
    showBootFailure(attempt(() => win.document.getElementById(ROOT_ID)));
  });
  if (win.document.readyState !== 'loading') return run();
  return new Promise((resolve) => {
    win.document.addEventListener('DOMContentLoaded', () => resolve(run()), { once: true });
  });
}

// Browser entry: Node tests import the exports only.
if (typeof window !== 'undefined' && window.document && typeof window.document.getElementById === 'function') {
  autoStart(window);
}
