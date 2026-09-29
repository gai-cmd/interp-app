// New implementation of docs/extension.md §8.3; no legacy code is ported.
// ENTRY (R10): the composition root of the options page. It is the only place that reads the page globals.
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../lib/i18n.js';
import { createOptionsController } from './controller.js';

const controller = createOptionsController({
  document: globalThis.document,
  adapter: createChromeAdapter(),
  i18n: { current: createFallbackI18n() },
  loadI18n: (options) => loadExtensionI18n({ fetch: (url, init) => globalThis.fetch(url, init), ...options }),
  timers: {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  navigator: globalThis.navigator,
});

controller.start().catch(() => {});
globalThis.addEventListener('pagehide', () => controller.dispose(), { once: true });
