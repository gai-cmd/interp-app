// P3-21: one API key guidance card, reused in the three places design-p3 §1.12
// names — the settings key section, the first-run notice, and the empty direct
// interpretation screen when no key is available.
//
// It is deliberately NOT shown on the hub listening screen: an audience member
// following a venue broadcast needs no key of their own, and telling them to
// create one would block the one path that works without credentials.
//
// The links are fixed by the design and are the only URLs this app opens:
// they always open in a new tab with noopener noreferrer, and the accessible
// name says so. No key value is read, written or rendered here.
import { DOCUMENTATION_LINKS } from '../config.js';
import { createBinder } from './seq-view.js';

/** The three documents §1.12 fixes, from the single outbound-link registry. */
export const KEY_GUIDE_LINKS = Object.freeze({
  create: DOCUMENTATION_LINKS.apiKeyCreate,
  usage: DOCUMENTATION_LINKS.apiKeyUsage,
  billing: DOCUMENTATION_LINKS.billing,
});
export const KEY_GUIDE_STEP_KEYS = Object.freeze(['keyGuide.step1', 'keyGuide.step2', 'keyGuide.step3']);
/** Where the card is mounted. The variant only adds context, never a different guide. */
export const KEY_GUIDE_VARIANTS = Object.freeze(['settings', 'firstRun', 'emptyDirect']);
/** The lead line above the steps, per placement. `settings` has the section hint already. */
const LEAD_KEYS = Object.freeze({ settings: null, firstRun: 'keyGuide.firstRun', emptyDirect: 'keyGuide.emptyDirect' });

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/**
 * createKeyGuide({ i18n, document, variant?, onOpenSettings? }) appends
 * nothing itself; the caller places `element`.
 *
 * `onOpenSettings` adds the "enter the key in settings" button, which is only
 * useful where the settings screen is not already open — so the settings mount
 * passes nothing and the other two pass the shell's opener.
 *
 * Returns frozen { element, variant, setVisible(on), refresh(), destroy() }.
 */
export function createKeyGuide({ i18n, document: doc, variant = 'settings', onOpenSettings = null } = {}) {
  if (!doc || typeof i18n?.t !== 'function' || !KEY_GUIDE_VARIANTS.includes(variant)) throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  const removers = [];
  let destroyed = false;

  const root = element(doc, 'section', { className: `key-guide key-guide-${variant}`,
    attributes: { 'data-variant': variant, 'aria-labelledby': `key-guide-${variant}-title` } });
  const title = element(doc, 'h3', { className: 'key-guide-title', attributes: { id: `key-guide-${variant}-title` } });
  bind.text(title, 'keyGuide.title');
  root.append(title);

  const leadKey = LEAD_KEYS[variant];
  if (leadKey) {
    const lead = element(doc, 'p', { className: 'key-guide-lead' });
    bind.text(lead, leadKey);
    root.append(lead);
  }

  // The three steps, in order, as a real list so a screen reader announces the
  // count and position rather than three loose sentences.
  const steps = element(doc, 'ol', { className: 'key-guide-steps' });
  for (const key of KEY_GUIDE_STEP_KEYS) {
    const item = element(doc, 'li', { className: 'key-guide-step' });
    bind.text(item, key);
    steps.append(item);
  }
  root.append(steps);

  // One helper for every outbound link: new tab, no opener, and "opens in a new
  // tab" inside the accessible name instead of only in a title attribute.
  const links = {};
  function link(name, href, labelKey) {
    const wrap = element(doc, 'p', { className: `key-guide-link key-guide-${name}` });
    const anchor = element(doc, 'a', { className: 'key-guide-anchor',
      attributes: { href, target: '_blank', rel: 'noopener noreferrer' } });
    const label = element(doc, 'span', { className: 'key-guide-link-label' });
    bind.text(label, labelKey);
    const newTab = element(doc, 'span', { className: 'key-guide-new-tab' });
    bind.text(newTab, 'keyGuide.newTab');
    // "opens in a new tab" is part of the link text, so it is in the accessible
    // name for every reader, not only in a title attribute a screen reader may
    // skip. No extra dictionary key is needed for the composition.
    anchor.append(label, newTab);
    wrap.append(anchor);
    root.append(wrap);
    links[name] = anchor;
    return anchor;
  }
  link('create', KEY_GUIDE_LINKS.create, 'keyGuide.createLink');
  link('usage', KEY_GUIDE_LINKS.usage, 'keyGuide.usageLink');

  // Free to create is not free to use: §1.12 forbids claiming otherwise, so the
  // billing link travels with the note that says why it is there.
  const free = element(doc, 'p', { className: 'key-guide-free' });
  bind.text(free, 'keyGuide.freeNote');
  root.append(free);
  const notAllFree = element(doc, 'p', { className: 'key-guide-not-all-free' });
  bind.text(notAllFree, 'keyGuide.notAllFree');
  root.append(notAllFree);
  link('billing', KEY_GUIDE_LINKS.billing, 'keyGuide.billingLink');

  // The restriction is a step to complete after creating the key, not an
  // optional hardening tip (§1.12).
  const restriction = element(doc, 'p', { className: 'key-guide-restriction' });
  bind.text(restriction, 'keyGuide.restriction');
  const restrictionWhy = element(doc, 'p', { className: 'key-guide-restriction-why' });
  bind.text(restrictionWhy, 'keyGuide.restrictionWhy');
  root.append(restriction, restrictionWhy);

  let openButton = null;
  if (typeof onOpenSettings === 'function') {
    openButton = element(doc, 'button', { className: 'btn btn-primary key-guide-open-settings',
      attributes: { type: 'button', 'aria-haspopup': 'dialog' } });
    bind.text(openButton, 'keyGuide.openSettings');
    const handler = () => attempt(() => onOpenSettings());
    openButton.addEventListener('click', handler);
    removers.push(() => openButton.removeEventListener('click', handler));
    root.append(openButton);
  }

  return Object.freeze({
    element: root,
    variant,
    elements: Object.freeze({ steps, openButton, links: Object.freeze({ ...links }) }),
    /** Hidden by default nowhere: the caller decides when its placement applies. */
    setVisible(on) { if (!destroyed) root.hidden = !on; return !root.hidden; },
    get visible() { return !root.hidden; },
    refresh() { if (!destroyed) bind.refresh(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of removers) attempt(off);
      bind.clear();
      root.remove();
    },
  });
}
