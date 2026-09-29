// New implementation of docs/extension.md §9.5; no legacy code is ported.
// Loads the app dictionaries and the extension's own `ext.*` dictionaries, merges them per language and returns an
// app I18n instance. `fetch` is injected (the extension pages pass the page's own), so nothing here reads a global
// at import time and the loader is testable over file: URLs. A failed load throws Error('I18N_LOAD_FAILED') and
// retains no cause, URL or body: a dictionary that fails to parse must never leak into a log or a notice.
import {
  SUPPORTED_LANGUAGES, createI18n, selectLanguage,
} from '../../app/i18n/index.js';
import bootDictionary from '../../app/i18n/boot-fallback.js';

const failure = () => new Error('I18N_LOAD_FAILED');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const usable = (dictionary) => isPlainObject(dictionary)
  && Object.values(dictionary).every((value) => typeof value === 'string' && value.trim() !== '');

async function fetchDictionary(fetcher, url, signal, check) {
  const response = await fetcher(url, { credentials: 'omit', signal });
  if (!response?.ok) throw failure();
  const dictionary = await response.json();
  if (!usable(dictionary) || !check(dictionary)) throw failure();
  return dictionary;
}

/**
 * Both dictionaries of every language, merged (`{ ...app, ...ext }`). Language negotiation: `language` when it is
 * one of ko/en/ja, else the first supported entry of `languages` (pass navigator.languages; this module never reads
 * it), else English. An abort rejects the whole load the same way as any other failure.
 */
export async function loadExtensionI18n({ fetch: fetcher = globalThis.fetch, language, languages = [], signal } = {}) {
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(failure());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (typeof fetcher !== 'function' || signal?.aborted) throw failure();
    const loading = Promise.all(SUPPORTED_LANGUAGES.map(async (code) => {
      const [app, ext] = await Promise.all([
        fetchDictionary(fetcher, new URL(`../../app/i18n/${code}.json`, import.meta.url), signal,
          (dictionary) => typeof dictionary['error.unknown'] === 'string'),
        fetchDictionary(fetcher, new URL(`../i18n/${code}.json`, import.meta.url), signal,
          (dictionary) => Object.keys(dictionary).every((key) => key.startsWith('ext.'))),
      ]);
      // ext last is defensive only: the checker guarantees the two key sets are disjoint.
      return [code, { ...app, ...ext }];
    }));
    const entries = await Promise.race([loading, aborted]);
    if (signal?.aborted) throw failure();
    const chosen = SUPPORTED_LANGUAGES.includes(language) ? language : selectLanguage(languages);
    return createI18n({ dictionaries: Object.fromEntries(entries), language: chosen });
  } catch {
    throw failure();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The three-key English boot dictionary: enough for `error.unknown`, never a blank page. */
export function createFallbackI18n({ language } = {}) {
  return createI18n({ dictionaries: { en: bootDictionary, ko: {}, ja: {} }, language });
}
