// New implementation of docs/extension.md §8.2.4; no legacy code is ported.
// ENTRY (R10): the composition root of the side panel. It is the only place that reads the page globals; the
// controller receives everything by injection. The boot dictionary is in place before the real one arrives, so the
// panel never shows a blank page while the dictionaries load.
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../lib/i18n.js';
import { createPanelController } from './controller.js';

const controller = createPanelController({
  document: globalThis.document,
  adapter: createChromeAdapter(),
  i18n: { current: createFallbackI18n() },
  loadI18n: (options) => loadExtensionI18n({ fetch: (url, init) => globalThis.fetch(url, init), ...options }),
  timers: {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    now: () => Date.now(),
  },
  navigator: globalThis.navigator,
});

controller.start().catch(() => {});
// Closing the panel drops its port, which starts the host's grace period; disconnecting explicitly makes that prompt.
globalThis.addEventListener('pagehide', () => controller.dispose(), { once: true });
