// New implementation of design-p3 §1.6 ("설정에는 다음 출처를 표시한다") and
// §1.12 section 9 ("앱·관리 정책"), P3-19; no legacy code is ported. Two parts:
//
// - createLockNote() decorates one settings control with the source of its
//   effective value (personal choice, administrator default, forced value) and
//   the lock or restriction reason. A forced value disables the control and
//   shows a padlock plus text; the reason is a readable node linked through
//   aria-describedby, so the state is never carried by colour alone. Options
//   outside the administrator's allowed range are hidden and disabled.
// - createPolicyView() renders the site-policy facts of the app section: app
//   version (numeric, distinct from the release ID the PWA line shows), policy
//   revision, published/valid-until/minimum-version dates, last check, the
//   whole-run block reason with its revision and a recheck button, the list
//   of locked or restricted settings and disabled features, and the hub
//   live-control state while an event is joined.
//
// `policy` is createPolicyRuntime()'s result (snapshot/subscribe/refresh).
// Snapshots carry validated policy data and codes only; the emergency reason
// and nothing else from the policy body is rendered, always through
// textContent. Importing touches no browser globals.
import { REGISTERED_FEATURES, REGISTERED_SETTINGS } from '../policy/schema.js';
import { APP_VERSION } from '../version.js';
import { createBinder } from './seq-view.js';
import { errorCodeKey, resolveKey } from './errors.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// Registered setting names are composed, not written as dotted literals: the
// i18n regressions treat dotted string literals in UI sources as dictionary keys.
const name = (scope, key) => `${scope}.${key}`;
export const SETTING_NAMES = Object.freeze({
  mode: name('ui', 'mode'), tone: name('ui', 'tone'), text: name('ui', 'text'), captionsSize: name('captions', 'size'),
  sourceLanguage: name('interpretation', 'sourceLanguage'), targetLanguage: name('interpretation', 'targetLanguage'),
  voiceOutput: name('voice', 'output'), billingPlan: name('billing', 'plan'),
});
/** Dictionary label of each registered setting (P3-03 display/billing keys, P1 language/voice keys). */
export const SETTING_LABEL_KEYS = Object.freeze({
  [SETTING_NAMES.mode]: 'display.mode', [SETTING_NAMES.tone]: 'display.tone', [SETTING_NAMES.text]: 'display.text',
  [SETTING_NAMES.captionsSize]: 'display.captions.size', [SETTING_NAMES.sourceLanguage]: 'language.source',
  [SETTING_NAMES.targetLanguage]: 'language.target', [SETTING_NAMES.voiceOutput]: 'voice.output',
  [SETTING_NAMES.billingPlan]: 'billing.planLabel',
});
export const SOURCE_KEYS = Object.freeze({ personal: 'policy.source.personal', policyDefault: 'policy.source.policyDefault',
  forced: 'policy.source.forced', appDefault: 'policy.source.appDefault' });
export const STATUS_KEYS = Object.freeze({ loading: 'policy.status.loading', ready: 'policy.status.ready',
  stale: 'policy.status.stale', failed: 'policy.status.failed', expired: 'policy.status.expired' });
export const HUB_CONTROL_KEYS = Object.freeze({ supported: 'hubControl.supported', unsupported: 'hubControl.unsupported',
  stopped: 'hubControl.stopped', lost: 'hubControl.lost' });
const FEATURE_LABEL_PREFIX = name('admin', 'feature');
const UPDATE_HINT_CODE = 'APP_VERSION_TOO_OLD';

function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/**
 * describeSetting(entry) reads one resolveEffective() setting entry into what
 * a control shows (§1.6 table): { locked, sourceKey, reasonKey, allowed }.
 * A personal choice or app default shows nothing; a policy default is
 * labelled; a forced value is locked and labelled; a narrowed range keeps the
 * restriction reason. `allowed` is the enum list or null (numbers, no policy).
 */
export function describeSetting(entry) {
  if (!entry || typeof entry !== 'object') return Object.freeze({ locked: false, sourceKey: null, reasonKey: null, allowed: null });
  const locked = entry.locked === true;
  const sourceKey = locked ? SOURCE_KEYS.forced : entry.source === 'policyDefault' ? SOURCE_KEYS.policyDefault : null;
  const reasonKey = typeof entry.reasonKey === 'string' ? entry.reasonKey : null;
  return Object.freeze({ locked, sourceKey, reasonKey, allowed: Array.isArray(entry.allowed) ? [...entry.allowed] : null });
}

/** Hub live-control state text for the joined event (P3-10 snapshot shape). */
export function hubControlKey(control) {
  if (!control || typeof control !== 'object') return null;
  if (control.stopped === true) return HUB_CONTROL_KEYS.stopped;
  if (control.heartbeatLost === true) return HUB_CONTROL_KEYS.lost;
  return control.supported === true ? HUB_CONTROL_KEYS.supported : HUB_CONTROL_KEYS.unsupported;
}

/**
 * createLockNote({ document, i18n, control, id }) appends nothing itself: the
 * caller places `element` (a <p> with the given id) next to the control.
 * update(entry) applies one setting entry: disables the control while locked,
 * links the note through aria-describedby whenever it says something, hides
 * select options outside the allowed range, and shows the padlock only for a
 * forced value. refresh() re-renders the last entry after a language change.
 */
export function createLockNote({ document: doc, i18n, control, id } = {}) {
  if (!doc || !control || typeof i18n?.t !== 'function' || typeof id !== 'string' || !id) throw new Error('INVALID_REQUEST');
  const node = element(doc, 'p', { className: 'settings-lock', attributes: { id, 'data-locked': 'false' } });
  const icon = element(doc, 'span', { className: 'settings-lock-icon', attributes: { 'aria-hidden': 'true' } });
  const label = element(doc, 'span', { className: 'settings-lock-label' });
  const source = element(doc, 'span', { className: 'settings-lock-source' });
  const reason = element(doc, 'span', { className: 'settings-lock-reason' });
  node.append(icon, label, source, reason);
  node.hidden = true;
  let last = null;

  function restrict(allowed) {
    if (control.tagName !== 'SELECT') return;
    for (const option of Array.from(control.childNodes ?? [])) {
      if (typeof option?.getAttribute !== 'function') continue;
      const permitted = allowed === null || allowed.includes(option.getAttribute('value'));
      option.hidden = !permitted;
      option.disabled = !permitted;
    }
  }
  function update(entry = null) {
    last = entry;
    const described = describeSetting(entry);
    control.disabled = described.locked;
    restrict(described.allowed);
    const visible = described.locked || described.sourceKey !== null || described.reasonKey !== null;
    if (visible) control.setAttribute('aria-describedby', id); else control.removeAttribute('aria-describedby');
    node.hidden = !visible;
    node.setAttribute('data-locked', String(described.locked));
    node.setAttribute('data-source', typeof entry?.source === 'string' ? entry.source : '');
    icon.hidden = !described.locked;
    label.hidden = !described.locked;
    label.textContent = described.locked ? i18n.t('policy.lock.label') : '';
    source.hidden = described.sourceKey === null;
    source.textContent = described.sourceKey ? i18n.t(described.sourceKey) : '';
    const reasonKey = described.reasonKey ? resolveKey(i18n, described.reasonKey, null) : null;
    reason.hidden = reasonKey === null;
    reason.textContent = reasonKey ? i18n.t(reasonKey) : '';
  }
  update(null);
  return Object.freeze({ element: node, update, refresh() { update(last); }, get entry() { return last; } });
}

/**
 * createPolicyView({ root, i18n, policy, document?, appVersion?, notify? })
 * renders the site-policy block into root and follows policy.subscribe().
 * Returns { element, elements, render, refresh, destroy }. Dates are shown
 * through i18n.formatDate; revisions are passed as strings so no digit
 * grouping applies (P3-02 note). The recheck button calls
 * policy.refresh({ reason: 'manual' }) and stays disabled until it settles.
 */
export function createPolicyView({ root, i18n, policy, document: doc = root?.ownerDocument, appVersion = APP_VERSION, notify = null } = {}) {
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof policy?.snapshot !== 'function'
    || typeof policy.subscribe !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  let snapshot = policy.snapshot();
  let refreshing = false;

  const container = element(doc, 'div', { className: 'policy', attributes: { 'data-status': '' } });
  root.append(container);
  const title = element(doc, 'h4', { className: 'policy-title' });
  bind.text(title, 'policy.title');
  const description = element(doc, 'p', { className: 'settings-note policy-description' });
  bind.text(description, 'policy.description');
  const status = element(doc, 'p', { className: 'badge policy-status', attributes: { role: 'status', 'aria-live': 'polite' } });
  container.append(title, description, status);

  // Facts: label/value pairs. Values are versions, revisions and dates only.
  const facts = element(doc, 'dl', { className: 'policy-facts' });
  const fact = (key, className, code = false) => {
    const row = element(doc, 'div', { className: 'policy-fact' });
    const term = element(doc, 'dt', { className: 'policy-fact-label' });
    bind.text(term, key);
    const value = element(doc, 'dd', { className: `policy-fact-value ${className}${code ? ' policy-code' : ''}` });
    row.append(term, value);
    facts.append(row);
    return value;
  };
  const appVersionValue = fact('policy.appVersion', 'policy-app-version', true);
  const revisionValue = fact('policy.revision', 'policy-revision', true);
  const publishedValue = fact('policy.publishedAt', 'policy-published');
  const validUntilValue = fact('policy.validUntil', 'policy-valid-until');
  const minVersionValue = fact('policy.minAppVersion', 'policy-min-version', true);
  const fetchedValue = fact('policy.fetchedAt', 'policy-fetched');
  container.append(facts);

  // Whole-run block: reason, revision, emergency text, persistent note, recheck.
  const blocked = element(doc, 'div', { className: 'policy-blocked', attributes: { role: 'group' } });
  const blockedTitle = element(doc, 'p', { className: 'policy-blocked-title' });
  bind.text(blockedTitle, 'policy.blocked.title');
  const blockedReason = element(doc, 'p', { className: 'policy-blocked-reason', attributes: { role: 'status', 'aria-live': 'polite' } });
  const blockedRevision = element(doc, 'p', { className: 'policy-blocked-revision policy-code' });
  const emergency = element(doc, 'p', { className: 'policy-emergency' });
  const emergencyLabel = element(doc, 'span', { className: 'policy-emergency-label' });
  bind.text(emergencyLabel, 'policy.emergencyReason');
  const emergencyText = element(doc, 'span', { className: 'policy-emergency-text' });
  emergency.append(emergencyLabel, emergencyText);
  const persistent = element(doc, 'p', { className: 'settings-note policy-blocked-persistent' });
  bind.text(persistent, 'policy.blocked.persistent');
  const updateHint = element(doc, 'p', { className: 'settings-note policy-blocked-update' });
  bind.text(updateHint, 'policy.blocked.updateHint');
  blocked.append(blockedTitle, blockedReason, blockedRevision, emergency, persistent, updateHint);
  container.append(blocked);
  const actions = element(doc, 'div', { className: 'settings-actions policy-actions' });
  const recheck = element(doc, 'button', { className: 'btn btn-secondary policy-recheck', attributes: { type: 'button' } });
  bind.text(recheck, 'policy.recheck');
  recheck.addEventListener('click', () => {
    if (refreshing || typeof policy.refresh !== 'function') return;
    refreshing = true;
    render();
    let pending;
    try { pending = Promise.resolve(policy.refresh({ reason: 'manual' })); } catch (error) { pending = Promise.reject(error); }
    pending.then(() => {}, () => { attempt(() => notify?.('policy.status.failed')); })
      .then(() => { refreshing = false; render(); });
  });
  actions.append(recheck);
  container.append(actions);

  // Lock reasons: settings the administrator forced or narrowed, features off.
  const locks = element(doc, 'div', { className: 'policy-locks' });
  const locksTitle = element(doc, 'p', { className: 'policy-locks-title' });
  bind.text(locksTitle, 'policy.lock.reason');
  const lockList = element(doc, 'ul', { className: 'policy-lock-list' });
  const featureList = element(doc, 'ul', { className: 'policy-feature-list' });
  locks.append(locksTitle, lockList, featureList);
  container.append(locks);

  // Hub live control while an event is joined (§1.8): state and revision.
  const hub = element(doc, 'div', { className: 'policy-hub' });
  const hubTitle = element(doc, 'p', { className: 'policy-hub-title' });
  bind.text(hubTitle, 'hubControl.title');
  const hubState = element(doc, 'p', { className: 'badge policy-hub-state', attributes: { role: 'status', 'aria-live': 'polite' } });
  const hubRevision = element(doc, 'p', { className: 'policy-hub-revision policy-code' });
  const hubScope = element(doc, 'p', { className: 'settings-note' });
  bind.text(hubScope, 'hubControl.scope');
  hub.append(hubTitle, hubState, hubRevision, hubScope);
  container.append(hub);
  for (const key of ['policy.staleHint', 'policy.notPersisted', 'policy.propagation']) {
    const note = element(doc, 'p', { className: 'settings-note' });
    bind.text(note, key);
    container.append(note);
  }

  function formatDate(value) {
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(time)) return null;
    return attempt(() => i18n.formatDate(new Date(time), { dateStyle: 'medium', timeStyle: 'short' })) ?? null;
  }
  // The emergency reason is three-language policy text: the UI language first,
  // then English, rendered as text only.
  function emergencyReason(policyDoc) {
    const reason = policyDoc?.emergency?.stopped === true ? policyDoc.emergency.reason : null;
    if (!reason || typeof reason !== 'object') return '';
    const text = reason[i18n.language] ?? reason.en ?? Object.values(reason).find((item) => typeof item === 'string');
    return typeof text === 'string' ? text : '';
  }
  function clear(list) { for (const item of [...list.childNodes]) item.remove(); }
  function item(list, labelKey, sourceKey, reasonKey, attributes) {
    const row = element(doc, 'li', { className: 'policy-lock-item', attributes });
    const label = element(doc, 'span', { className: 'policy-lock-item-label' });
    label.textContent = i18n.t(labelKey);
    row.append(label);
    if (sourceKey) {
      const source = element(doc, 'span', { className: 'policy-lock-item-source' });
      source.textContent = i18n.t(sourceKey);
      row.append(source);
    }
    const reason = element(doc, 'span', { className: 'policy-lock-item-reason' });
    reason.textContent = reasonKey ? i18n.t(reasonKey) : '';
    reason.hidden = !reasonKey;
    row.append(reason);
    list.append(row);
  }

  function render(next = policy.snapshot()) {
    snapshot = next;
    const policyDoc = snapshot.policy ?? null;
    container.setAttribute('data-status', typeof snapshot.status === 'string' ? snapshot.status : '');
    status.textContent = i18n.t(resolveKey(i18n, STATUS_KEYS[snapshot.status], 'policy.none'));
    status.setAttribute('data-status', typeof snapshot.status === 'string' ? snapshot.status : '');
    appVersionValue.textContent = typeof appVersion === 'string' ? appVersion : String(snapshot.appVersion ?? '');
    const revision = Number.isSafeInteger(snapshot.revision) ? String(snapshot.revision) : null;
    revisionValue.textContent = revision ?? i18n.t('policy.none');
    publishedValue.textContent = formatDate(policyDoc?.publishedAt) ?? i18n.t('policy.none');
    validUntilValue.textContent = policyDoc ? (formatDate(policyDoc.validUntil) ?? i18n.t('policy.noExpiry')) : i18n.t('policy.none');
    minVersionValue.textContent = typeof policyDoc?.minAppVersion === 'string' ? policyDoc.minAppVersion : i18n.t('policy.none');
    fetchedValue.textContent = formatDate(snapshot.fetchedAt) ?? i18n.t('policy.none');

    const block = snapshot.blocked ?? null;
    blocked.hidden = block === null;
    blocked.setAttribute('data-code', block?.code ?? '');
    blockedReason.textContent = block ? i18n.t(resolveKey(i18n, errorCodeKey(block.code))) : '';
    const blockRevision = Number.isSafeInteger(block?.revision) ? String(block.revision) : null;
    blockedRevision.hidden = blockRevision === null;
    blockedRevision.textContent = blockRevision === null ? '' : i18n.t('policy.blocked.revision', { revision: blockRevision });
    const reasonText = block?.code === 'POLICY_STOPPED' ? emergencyReason(policyDoc) : '';
    emergency.hidden = reasonText === '';
    emergencyText.textContent = reasonText;
    updateHint.hidden = block?.code !== UPDATE_HINT_CODE;
    recheck.disabled = refreshing || typeof policy.refresh !== 'function';
    recheck.setAttribute('aria-busy', String(refreshing));

    clear(lockList);
    const settings = snapshot.settings ?? {};
    for (const settingName of Object.keys(REGISTERED_SETTINGS)) {
      const entry = settings[settingName];
      const described = describeSetting(entry);
      if (!described.locked && described.reasonKey === null) continue;
      item(lockList, SETTING_LABEL_KEYS[settingName], described.sourceKey, resolveKey(i18n, described.reasonKey, null),
        { 'data-setting': settingName, 'data-locked': String(described.locked) });
    }
    clear(featureList);
    // Without a policy every feature is off for the one reason the block
    // already states; the list only itemises what a loaded policy turned off.
    const features = policyDoc ? snapshot.features ?? {} : {};
    for (const feature of REGISTERED_FEATURES) {
      const entry = features[feature];
      if (!entry || entry.enabled !== false) continue;
      item(featureList, `${FEATURE_LABEL_PREFIX}.${feature}`, null, resolveKey(i18n, entry.reasonKey, 'policy.featureOff'), { 'data-feature': feature });
    }
    locks.hidden = lockList.childNodes.length === 0 && featureList.childNodes.length === 0;

    const control = snapshot.hubControl ?? null;
    hub.hidden = control === null;
    const hubKey = hubControlKey(control);
    hubState.textContent = hubKey ? i18n.t(hubKey) : '';
    hubState.setAttribute('data-state', hubKey ? hubKey.slice('hubControl.'.length) : '');
    const hubRev = Number.isSafeInteger(control?.revision) ? String(control.revision) : null;
    hubRevision.hidden = hubRev === null;
    hubRevision.textContent = hubRev === null ? '' : i18n.t('hubControl.revision', { revision: hubRev });
  }

  const unsubscribe = policy.subscribe(() => render());
  render(snapshot);

  return Object.freeze({
    element: container,
    elements: Object.freeze({ status, appVersion: appVersionValue, revision: revisionValue, publishedAt: publishedValue,
      validUntil: validUntilValue, minAppVersion: minVersionValue, fetchedAt: fetchedValue, blocked, blockedReason, blockedRevision,
      emergency: emergencyText, updateHint, recheck, locks, lockList, featureList, hub, hubState, hubRevision }),
    render,
    refresh() { bind.refresh(); render(snapshot); },
    destroy() {
      attempt(unsubscribe);
      bind.clear();
      container.remove();
    },
  });
}
