// New implementation of docs/extension.md §8.4; no legacy code is ported.
// ENTRY (R10): the composition root of the microphone-permission page. It has no dictionary of its own to trust, so it
// loads the same merged dictionaries as the other pages, in the language chosen in the options when that can be read.
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createFallbackI18n, loadExtensionI18n } from '../lib/i18n.js';
import { readSettings } from '../lib/settings.js';
import { createPermissionController } from './controller.js';

async function main() {
  let language;
  try {
    const settings = await readSettings(createChromeAdapter().storage.local);
    if (settings.uiLanguage !== 'auto') language = settings.uiLanguage;
  } catch { /* no stored language: follow the browser */ }
  let i18n;
  try {
    i18n = await loadExtensionI18n({ fetch: (url, init) => globalThis.fetch(url, init), language, languages: globalThis.navigator.languages });
  } catch { i18n = createFallbackI18n({ language }); }
  await createPermissionController({
    document: globalThis.document,
    navigator: globalThis.navigator,
    window: globalThis,
    i18n,
    timers: { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  }).start();
}

main().catch(() => {});
