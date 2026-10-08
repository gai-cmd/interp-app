// New implementation of docs/extension.md §8.2.4 and §21; no legacy code is ported.
// ENTRY (R10): the composition root of the side panel. It is the only place that reads the page globals; the
// controller receives everything by injection. The boot dictionary is in place before the real one arrives, so the
// panel never shows a blank page while the dictionaries load.
import { createRelaySender } from '../lib/audio-relay.js';
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { canOpenDialogInPanel } from '../lib/display-media.js';
import { createFallbackI18n, loadExtensionI18n } from '../lib/i18n.js';
import { createSelfUpdater } from '../lib/update-run.js';
import { createUpdateStateApi } from '../lib/update-state.js';
import { createUpdateStore } from '../lib/update-store.js';
import { createPanelController } from './controller.js';

const adapter = createChromeAdapter();
const pageFetch = (url, init) => globalThis.fetch(url, init);
const manifestVersion = () => { try { return String(adapter.runtime.getManifest().version); } catch { return ''; } };

// §21: the same updater the options page builds. The panel only reads its status and runs it WITHOUT permission to
// prompt; it never picks a folder (no user activation here, and before Chrome 143 no permission manager), so its
// `pickDirectory` refuses by construction instead of reaching for the picker. The updater is an add-on: if building it
// fails for any reason the panel still starts, with the manual banner of §16.
function buildUpdater() {
  try {
    return createSelfUpdater({
      fetch: pageFetch,
      subtle: globalThis.crypto?.subtle,
      store: createUpdateStore({ env: globalThis }),
      stateApi: createUpdateStateApi({ local: adapter.storage.local }),
      running: {
        version: manifestVersion(),
        manifestBytes: async () => new Uint8Array(await (await pageFetch(adapter.runtime.getURL('manifest.json'))).arrayBuffer()),
      },
      keyed: BUILTIN_KEYS.length > 0,
      pickDirectory: () => Promise.reject(new Error('UPDATE_PICK_NOT_IN_PANEL')),
      reload: () => adapter.runtime.reload(),
    });
  } catch {
    return null;
  }
}

// 2026-10-08: Chrome's share dialog asked from THIS page (Chrome 153 and later; the gate says whether it may be), and the
// relay that carries the chosen tab's audio to the host. Everything is read from the page's own realm when it is used.
const media = Object.freeze({
  canOpenDialog: () => canOpenDialogInPanel({ navigator: globalThis.navigator, env: globalThis }),
  openShareDialog: (constraints) => globalThis.navigator.mediaDevices.getDisplayMedia(constraints),
  createRelaySender: ({ track, relayId }) => createRelaySender({ track, relayId,
    env: { MediaStreamTrackProcessor: globalThis.MediaStreamTrackProcessor, BroadcastChannel: globalThis.BroadcastChannel } }),
  random: (bytes) => globalThis.crypto.getRandomValues(bytes),
});

const controller = createPanelController({
  document: globalThis.document,
  adapter,
  i18n: { current: createFallbackI18n() },
  loadI18n: (options) => loadExtensionI18n({ fetch: (url, init) => globalThis.fetch(url, init), ...options }),
  timers: {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    now: () => Date.now(),
  },
  navigator: globalThis.navigator,
  fetch: (url, init) => globalThis.fetch(url, init),
  updater: buildUpdater(),
  media,
});

controller.start().catch(() => {});
// Closing the panel drops its port, which starts the host's grace period; disconnecting explicitly makes that prompt.
// A tab this page captured itself (2026-10-08) is released with it: its relay ends as the panel's own stop.
globalThis.addEventListener('pagehide', () => controller.dispose(), { once: true });
