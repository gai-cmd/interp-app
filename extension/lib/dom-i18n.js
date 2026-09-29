// New implementation of docs/extension.md §8.1; no legacy code is ported.
// The data-i18n binder shared by the three extension pages. Text goes in through textContent and attributes only
// (never innerHTML); the four attribute spellings are the ones the i18n checker accepts (F11). It is idempotent, so a
// language change simply calls it again.
const TEXT = 'data-i18n';
const ATTRIBUTES = Object.freeze([['data-i18n-label', 'aria-label'], ['data-i18n-tip', 'title'],
  ['data-i18n-hint', 'placeholder']]);

/**
 * Resolves every `data-i18n*` element under `root` with `i18n.t`. When `root` is a document it also sets the
 * document title from `<title data-i18n>` and `<html lang>` from `i18n.language`.
 */
export function applyI18n(root, i18n) {
  if (!root || typeof root.querySelectorAll !== 'function' || typeof i18n?.t !== 'function') return;
  for (const element of root.querySelectorAll(`[${TEXT}]`)) {
    const key = element.getAttribute(TEXT);
    if (key) element.textContent = i18n.t(key);
  }
  for (const [binder, attribute] of ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${binder}]`)) {
      const key = element.getAttribute(binder);
      if (key) element.setAttribute(attribute, i18n.t(key));
    }
  }
  if (root.documentElement) {
    root.documentElement.setAttribute('lang', i18n.language);
    const title = root.querySelector('title[data-i18n]');
    const key = title?.getAttribute(TEXT);
    if (key) root.title = i18n.t(key);
  }
}
