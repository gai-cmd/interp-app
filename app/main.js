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
// Teardown: settings -> diagnostics -> shell -> engine -> config -> pwa.
// No logging anywhere: errors become dictionary keys rendered as text.
import fallbackDictionary from './i18n/en.json' with { type: 'json' };
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
import { TURN_PHASE } from './state.js';
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
async function bootApp({ window: win, root: givenRoot, fetch: fetcher = win?.fetch?.bind?.(win),
  setTimeout: schedule = win?.setTimeout?.bind?.(win), clearTimeout: cancelTimer = win?.clearTimeout?.bind?.(win) } = {}) {
  const doc = win?.document;
  const nav = win?.navigator;
  const root = givenRoot ?? attempt(() => doc.getElementById(ROOT_ID));
  if (!doc || !nav || !root || typeof fetcher !== 'function' || typeof schedule !== 'function' || typeof cancelTimer !== 'function') {
    throw new Error('INVALID_REQUEST');
  }
  const timing = { setTimeout: schedule, clearTimeout: cancelTimer };
  const loadMessages = (options) => withDeadline((signal) => loadI18n({ ...options, signal }), { ...timing, timeoutMs: BOOT_TIMEOUT_MS });
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
  } catch { showFailure(null, 'NETWORK_ERROR'); return null; }
  applyManifestLanguage(doc, i18n.language);

  let config = null, engine = null, voiceEngine = null, capture = null, store = null;
  let shell = null, settingsView = null, controls = null, diagnostics = null, pwa = null, closed = false;
  let audioContext = null;
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
      isBusy: () => diagnostics?.snapshot().running != null || pwa?.snapshot().applying === true });
    store = engine.state;
    notify = (key) => { if (!store.closed) attempt(() => store.setNotice(resolveKey(i18n, key))); };

    shell = mount({ root, i18n, engine, document: doc, window: win, ...timing });
    diagnostics = createDiagnostics({ config, voiceEngine, capture, getAudioContext, ...timing,
      isBusy: () => store.snapshot().activeTurnId !== null || pwa?.snapshot().applying === true });
    const isBusy = () => (!store.closed && store.snapshot().activeTurnId !== null) || diagnostics.snapshot().running !== null;
    pwa = createPwa({ window: win, navigator: nav, isBusy, ...timing });
    const version = await pwa.getVersion();
    const standalone = pwa.snapshot().standalone;
    settingsView = createSettingsView({ shell, i18n, config, engine, diagnostics, document: doc, persistence: storage !== null,
      app: { ...(version ? { version } : {}), standalone }, getDeviceVoices,
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
    attempt(() => engine.cancel());
    attempt(() => diagnostics.cancel());
    if (event?.persisted !== true) close();
  });
  // Registration happens last so it never delays the first paint.
  pwa.register();

  async function teardown() {
    // Own listeners first, then the P1-16 order: settings -> diagnostics ->
    // shell -> engine -> config; the PWA layer and audio context go last.
    for (const remove of removers.splice(0)) remove();
    controls?.destroy();
    settingsView?.destroy();
    await diagnostics?.close();
    shell?.destroy();
    if (engine) await engine.close();
    else await voiceEngine?.close();
    await config?.dispose();
    pwa?.close();
    if (audioContext) { const context = audioContext; audioContext = null; attempt(() => Promise.resolve(context.close()).catch(() => {})); }
  }
  async function close() {
    if (closed) return;
    closed = true;
    await teardown();
  }

  return Object.freeze({
    i18n, config, engine, capture, voiceEngine, shell, diagnostics, settingsView, controls, pwa, getAudioContext,
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

// The fallback is the existing English dictionary, loaded with the module graph,
// independent of runtime fetch/storage/SW. No raw exception reaches the DOM.
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
