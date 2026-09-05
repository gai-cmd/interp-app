// New implementation of design-v0.6 §12; no legacy code is ported.
export const SUPPORTED_LANGUAGES = Object.freeze(['ko', 'en', 'ja']);
export const FALLBACK_LANGUAGE = 'en';

function supportedLanguage(value) {
  if (typeof value !== 'string') return undefined;
  const tag = value.trim().replaceAll('_', '-');
  try {
    const base = new Intl.Locale(tag).language;
    return SUPPORTED_LANGUAGES.includes(base) ? base : undefined;
  } catch { return undefined; }
}

export function normalizeLanguage(value) {
  return supportedLanguage(value) ?? FALLBACK_LANGUAGE;
}

// Pass navigator.languages explicitly; never read browser globals on import.
export function selectLanguage(languages = []) {
  for (const value of Array.isArray(languages) ? languages : [languages]) {
    const language = supportedLanguage(value);
    if (language) return language;
  }
  return FALLBACK_LANGUAGE;
}

function copyDictionary(dictionary) {
  return Object.freeze(Object.fromEntries(Object.entries(dictionary ?? {})
    .filter(([, value]) => typeof value === 'string' && value.trim())));
}

/**
 * Synchronous, DOM-free instance. Dictionaries are flat dotted-key objects.
 * The caller owns persistence of UI language, separately from interpretation.
 * Render t()/error() results with textContent, never innerHTML. Parameters must
 * be public display values, never credentials or raw provider error messages.
 */
export function createI18n({ dictionaries, language, languages = [] } = {}) {
  if (!dictionaries?.en || typeof dictionaries.en['error.unknown'] !== 'string'
      || !dictionaries.en['error.unknown'].trim()) {
    throw new Error('I18N_INVALID_DICTIONARY');
  }
  const messages = Object.fromEntries(SUPPORTED_LANGUAGES.map(
    (locale) => [locale, copyDictionary(dictionaries[locale])],
  ));
  let current = language === undefined ? selectLanguage(languages) : normalizeLanguage(language);
  function has(key) {
    return typeof key === 'string' && Object.hasOwn(messages.en, key);
  }
  function t(key, parameters = {}) {
    // Unknown input is never echoed: it could be a raw error or a credential.
    const safeKey = has(key) ? key : 'error.unknown';
    const template = messages[current][safeKey] ?? messages.en[safeKey];
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name) => {
      if (!parameters || !Object.hasOwn(parameters, name)) return token;
      const value = parameters[name];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return new Intl.NumberFormat(current).format(value);
      }
      return typeof value === 'string' ? value : token;
    });
  }
  return Object.freeze({
    get language() { return current; },
    setLanguage(value) { current = normalizeLanguage(value); return current; },
    has,
    t,
    // Accept normalized code strings only, never inspect provider error objects.
    error(code) { return t(typeof code === 'string' && has(`error.${code}`) ? `error.${code}` : 'error.unknown'); },
    formatNumber(value, options) { return new Intl.NumberFormat(current, options).format(value); },
    formatDate(value, options) { return new Intl.DateTimeFormat(current, options).format(value); },
  });
}

/** Fetch only fixed, same-module JSON assets; fetch is injectable for Node tests. */
export async function loadI18n({ fetch: fetcher = globalThis.fetch, signal, ...options } = {}) {
  try {
    const entries = await Promise.all(SUPPORTED_LANGUAGES.map(async (language) => {
      const response = await fetcher(new URL(`./${language}.json`, import.meta.url), { credentials: 'omit', ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error('I18N_LOAD_FAILED');
      return [language, await response.json()];
    }));
    return createI18n({ ...options, dictionaries: Object.fromEntries(entries) });
  } catch {
    // Do not retain fetch errors, URLs, response bodies, or causes.
    throw new Error('I18N_LOAD_FAILED');
  }
}
