// New implementation of docs/extension.md §8.3 and §21; no legacy code is ported.
// ENTRY (R10): the composition root of the options page. It is the only place that reads the page globals.
import { BUILTIN_KEYS } from '../lib/builtin-key.js';
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../lib/i18n.js';
import { createSelfUpdater } from '../lib/update-run.js';
import { createUpdateStateApi } from '../lib/update-state.js';
import { createUpdateStore } from '../lib/update-store.js';
import { createOptionsController } from './controller.js';

const adapter = createChromeAdapter();
const pageFetch = (url, init) => globalThis.fetch(url, init);
const manifestVersion = () => { try { return String(adapter.runtime.getManifest().version); } catch { return ''; } };

// §21: the self-updater. This page is where a folder is chosen and where the browser may ask for the permission to write
// to it again, because it is an ordinary tab (open_in_tab) with user activation from the click on the button. The id
// makes the picker open where it was last used for this extension. The updater is an add-on: if building it fails for any
// reason the page still works, and its update section says that updates are off.
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
      pickDirectory: () => globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'li-extension' }),
      reload: () => adapter.runtime.reload(),
    });
  } catch {
    return null;
  }
}

const controller = createOptionsController({
  document: globalThis.document,
  adapter,
  i18n: { current: createFallbackI18n() },
  loadI18n: (options) => loadExtensionI18n({ fetch: (url, init) => globalThis.fetch(url, init), ...options }),
  timers: {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  navigator: globalThis.navigator,
  updater: buildUpdater(),
  hash: globalThis.location?.hash ?? '',
});

controller.start().catch(() => {});
globalThis.addEventListener('pagehide', () => controller.dispose(), { once: true });
