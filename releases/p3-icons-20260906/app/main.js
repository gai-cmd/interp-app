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
// Teardown: settings -> listening -> diagnostics -> shell -> engine -> config -> pwa.
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
import { mount } from './ui/shell.js';
import { createSettingsView } from './ui/settings-view.js';
import { resolveKey } from './ui/errors.js';
import { withDeadline } from './engine/retry.js';
import { TURN_PHASE, isAppBusy } from './state.js';
import { ProviderError } from './providers/contract.js';
import { createActivity } from './engine/activity.js';
import { createSimEngine } from './engine/sim.js';
import { createHubListenEngine } from './engine/hub-listen.js';
import { createHubClient } from './hub/client.js';
import { REGISTERED_HUBS } from './hub/protocol.js';
import { createPwa, createPwaControls, UPDATE_KEYS } from './pwa.js';

// UI settings live in localStorage per device (§11.1); keys are ours alone.
export const UI_LANGUAGE_STORAGE_KEY = 'interp-app.ui.v1.language';
export const INSTALL_HINT_STORAGE_KEY = 'interp-app.ui.v1.install-hint';
export const ROOT_ID = 'app';
// Application startup deadline, not a provider retry budget.
export const BOOT_TIMEOUT_MS = 10000;
// Live voice audio is 24 kHz PCM (P1-10 player); the context is created once.
export const AUDIO_CONTEXT_OPTIONS = Object.freeze({ sampleRate: 24000 });
export const PROVIDER_ID = 'gemini';
const GESTURE_EVENTS = Object.freeze(['pointerdown', 'keydown']);
const languagePattern = /^(ko|en|ja)$/;

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
 * startApp({ window, root?, fetch?, setTimeout?, clearTimeout? }) boots the
 * application into root (default: #app) and resolves an app handle
 * { i18n, config, engine, shell, diagnostics, settingsView, pwa, getAudioContext,
 *   setLanguage, close }. A failed start renders the failure as dictionary
 * text inside root and resolves null; nothing is logged.
 */
// hubs is a trusted code registry, never a settings or QR value.
async function bootApp({ window: win, root: givenRoot, signal: bootSignal, hubs = REGISTERED_HUBS, fetch: fetcher = win?.fetch?.bind?.(win),
  setTimeout: schedule = win?.setTimeout?.bind?.(win), clearTimeout: cancelTimer = win?.clearTimeout?.bind?.(win) } = {}) {
  const doc = win?.document;
  const nav = win?.navigator;
  const root = givenRoot ?? attempt(() => doc.getElementById(ROOT_ID));
  if (!doc || !nav || !root || typeof fetcher !== 'function' || typeof schedule !== 'function' || typeof cancelTimer !== 'function') {
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
    config = createAppConfig({ fetch: fetcher, WebSocket: win.WebSocket, Blob: win.Blob, storage: storage ?? undefined, ...timing });
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

    simEngine = createSimEngine({ router: config.router, sessionManager: config.sessionManager,
      platform: createPlatform(win), getAudioContext, ...timing,
      resolveFallback: (...args) => config.resolveFallback(PROVIDER_ID, 'live')?.(...args),
      onLevel: level => shell?.simView?.onLevel(level) });
    // P2-13 requires speak/cancel even on browsers without speech synthesis.
    // Keep captions available through its existing unavailable-output contract.
    const hubTTS = deviceTTS ?? Object.freeze({
      speak: async () => ({ status: 'unavailable' }), cancel() {},
    });
    hubEngine = createHubListenEngine({ client: createHubClient({ hubs, WebSocket: win.WebSocket, ...timing }), deviceTTS: hubTTS, ...timing });
    listenEngines = { direct: ownedListener(simEngine, 'sim'), hub: ownedListener(hubEngine, 'hub') };
    shell = mount({ root, i18n, engine, listenEngines, hubs,
      beforeTabChange: stopWork, document: doc, window: win, ...timing });
    // P3-02c: caption board preferences share the UI storage; only this module reads localStorage.
    if (storage) shell.simView?.setStorage(storage);
    removers.push(config.keyStore.subscribe(() => {
      if (busy()) stopWork().catch(() => notify('error.SESSION_CLOSED'));
      else lifecycleGeneration++;
    }));
    diagnostics = createDiagnostics({ config, voiceEngine, capture, getAudioContext, ...timing,
      isBusy: () => listeningBusy() || engine.snapshot().busy || pwa?.snapshot().applying === true });
    pwa = createPwa({ window: win, navigator: nav, isBusy: busy, ...timing });
    removers.push(activity.subscribe(() => pwa.reloadIfPending()));
    removers.push(engine.subscribeWork(() => pwa.reloadIfPending()));
    removers.push(diagnostics.subscribe(() => pwa.reloadIfPending()));
    removers.push(config.sessionManager.subscribe(() => pwa.reloadIfPending()));
    const version = await pwa.getVersion();
    const standalone = pwa.snapshot().standalone;
    settingsView = createSettingsView({ shell, i18n, config, engine, diagnostics, document: doc, persistence: storage !== null,
      app: { ...(version ? { version } : {}), standalone }, getDeviceVoices, simEngine,
      metrics: { snapshot: () => simEngine.snapshot().metrics,
        subscribe: fn => simEngine.subscribe(() => fn()) },
      onUiLanguageChange: (language) => { if (storage) writeUiLanguage(storage, language); applyManifestLanguage(doc, language); } });
    controls = createPwaControls({ root: settingsView.elements.appActions, document: doc, i18n, shell, pwa, notify });
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
  listen(win, 'pagehide', (event) => {
    stopWork().catch(() => notify('error.SESSION_CLOSED'));
    if (event?.persisted !== true) close();
  });
  listen(doc, 'visibilitychange', () => {
    if (doc.hidden) stopWork().catch(() => notify('error.SESSION_CLOSED'));
  });
  // Registration happens last so it never delays the first paint.
  pwa.register();

  async function teardown() {
    // Own listeners first, then the P1-16 order: settings -> diagnostics ->
    // shell -> engine -> config; the PWA layer and audio context go last.
    for (const remove of removers.splice(0)) remove();
    controls?.destroy();
    settingsView?.destroy();
    await stopWork().catch(() => {});
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
    i18n, config, engine, capture, voiceEngine, shell, diagnostics, settingsView, controls, pwa, getAudioContext,
    listenEngines, activity, stopWork,
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
