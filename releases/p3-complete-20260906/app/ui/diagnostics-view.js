// New implementation of design-v0.6 §§6.1, 7.4 and 20.3: the capability table
// and the per-check rows (text translation, PTT, Live voice, simultaneous,
// microphone, playback). Every check starts from a button press; nothing runs
// on render or on key changes. States come from the diagnostics engine, so a
// registered capability shows "untested" until its own check passed, and a
// passed text check never changes the voice or PTT rows. All text is
// dictionary-bound and rendered with textContent.
import { METRIC_NAMES } from '../engine/listen-metrics.js';
import { CAPABILITIES } from '../providers/contract.js';
import { DIAGNOSTIC_KINDS, KIND_CAPABILITY } from '../engine/diagnostics.js';
import { createBinder } from './seq-view.js';
import { errorKey, resolveKey } from './errors.js';

export const STATE_KEYS = Object.freeze({ unsupported: 'capability.unsupported', planned: 'capability.planned',
  hubRequired: 'capability.hubRequired', untested: 'capability.untested', running: 'diagnostics.running',
  available: 'capability.available', failed: 'capability.failed', cancelled: 'seq.cancelled' });
export const ROUTE_KEYS = Object.freeze({ direct: 'capability.direct', hub: 'capability.hub' });
const blocked = new Set(['unsupported', 'planned', 'hubRequired']);
const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

function element(doc, tag, { className, attributes = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** Row state for one check kind from the engine snapshot and capability table. */
export function checkState(kind, snapshot, capabilities) {
  if (snapshot?.running?.kind === kind) return { state: 'running', result: null, capturing: snapshot.running.capturing === true };
  const capability = KIND_CAPABILITY[kind];
  if (capability) {
    const entry = capabilities?.find((item) => item.capability === capability);
    return { state: entry?.state ?? 'untested', result: entry?.result ?? null, capturing: false };
  }
  const result = snapshot?.results?.find((item) => item.kind === kind && item.providerId === null) ?? null;
  return { state: result?.state ?? 'untested', result, capturing: false };
}

/**
 * createDiagnosticsView({ root, i18n, diagnostics, getRoute?, getOptions?,
 *   notify?, document? }) renders into root. getRoute() returns the
 * { providerId, keySource } the table describes (the current key selection by
 * default); getOptions() supplies { sourceLanguage, targetLanguage, voice }
 * for checks; notify(key) receives dictionary keys for thrown engine errors.
 * metrics and hub optionally expose snapshot()/subscribe(). Missing observations
 * remain unmeasured; this view never opens a hub or promotes its state to Live.
 * Returns { element, render, refresh, destroy }.
 */
export function createDiagnosticsView({ root, i18n, diagnostics, getRoute = null, getOptions = null, notify = null, metrics = null, hub = null,
  document: doc = root?.ownerDocument } = {}) {
  if (!root || !doc || typeof i18n?.t !== 'function' || typeof diagnostics?.run !== 'function'
    || typeof diagnostics.subscribe !== 'function') throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n);
  let snapshot = diagnostics.snapshot();
  let handle = null;

  const section = element(doc, 'section', { className: 'diag' });
  root.append(section);
  const scope = element(doc, 'p', { className: 'diag-scope' });
  bind.text(scope, 'diagnostics.scope');
  const userStart = element(doc, 'p', { className: 'diag-user-start' });
  bind.text(userStart, 'diagnostics.userStart');

  // Capability table (§7.4): implementation, route and checked state per capability.
  const table = element(doc, 'table', { className: 'diag-capabilities' });
  const body = element(doc, 'tbody');
  table.append(body);
  const capabilityRows = {};
  for (const name of CAPABILITIES) {
    const row = element(doc, 'tr', { className: 'diag-capability', attributes: { 'data-capability': name } });
    const label = element(doc, 'th', { className: 'diag-capability-name', attributes: { scope: 'row' } });
    bind.text(label, `capability.${name}`);
    const state = element(doc, 'td', { className: 'diag-capability-state' });
    const route = element(doc, 'td', { className: 'diag-capability-route' });
    row.append(label, state, route);
    body.append(row);
    capabilityRows[name] = { row, state, route };
  }

  // One row per check; the button starts, stops (capture) or cancels it.
  const list = element(doc, 'div', { className: 'diag-checks' });
  const checkRows = {};
  for (const kind of DIAGNOSTIC_KINDS) {
    const row = element(doc, 'div', { className: 'diag-check', attributes: { 'data-kind': kind } });
    const label = element(doc, 'span', { className: 'diag-check-label' });
    bind.text(label, `diagnostics.${kind}`);
    const state = element(doc, 'span', { className: 'badge diag-check-state', attributes: { role: 'status', 'aria-live': 'polite' } });
    const message = element(doc, 'p', { className: 'diag-check-message' });
    message.hidden = true;
    const model = element(doc, 'span', { className: 'diag-check-model' });
    model.hidden = true;
    const button = element(doc, 'button', { className: 'btn btn-secondary diag-check-run', attributes: { type: 'button' } });
    button.addEventListener('click', () => press(kind));
    row.append(label, state, button, message, model);
    list.append(row);
    checkRows[kind] = { row, state, message, model, button };
  }
  section.append(scope, userStart, table, list);
  for (const key of ['diagnostics.liveScope', 'diagnostics.connectionOnly', 'diagnostics.metrics',
    'diagnostics.metricsPrivacy', 'diagnostics.timingBoundary', 'diagnostics.policyBudget']) {
    const note = element(doc, 'p'); bind.text(note, key); section.append(note);
  }
  const hubLabel = element(doc, 'p'); bind.text(hubLabel, 'diagnostics.hub');
  const hubStatus = element(doc, 'p', { attributes: { role: 'status' } });
  section.append(hubLabel, hubStatus);
  const metricRows = new Map();
  for (const name of METRIC_NAMES) {
    const row = element(doc, 'p', { attributes: { 'data-metric': name } });
    const label = element(doc, 'span'); bind.text(label, `diagnostics.${name}`);
    const value = element(doc, 'span'); row.append(label, value);
    section.append(row); metricRows.set(name, value);
  }
  function renderObservations() {
    const data = attempt(() => metrics?.snapshot());
    for (const [name, node] of metricRows) node.textContent = Number.isFinite(data?.[name])
      ? String(data[name]) : i18n.t('diagnostics.notMeasured');
    memoryState.textContent = data?.memoryState === 'unsupported' ? i18n.t('diagnostics.unsupported') : '';
    const state = attempt(() => hub?.snapshot())?.broadcast;
    const key = { waiting: 'hub.broadcast.waiting', receiving: 'hub.broadcast.receiving', ended: 'hub.broadcast.ended' }[state];
    hubStatus.textContent = key ? i18n.t(key) : i18n.t('diagnostics.notMeasured');
  }
  const memoryState = element(doc, 'p'); section.append(memoryState);
  const detachMetrics = metrics?.subscribe?.(renderObservations);
  const detachHub = hub?.subscribe?.(renderObservations);

  // keySource is null while the displayed provider has no selected key: the
  // table still shows registration state, but no network check can start.
  function route() {
    const value = attempt(() => getRoute?.()) ?? null;
    return value && typeof value.providerId === 'string'
      ? { providerId: value.providerId, keySource: typeof value.keySource === 'string' ? value.keySource : null } : null;
  }
  function press(kind) {
    const running = snapshot.running;
    if (running?.kind === kind && handle) {
      if (running.capturing) handle.stop(); else handle.cancel();
      return;
    }
    const current = route();
    const options = attempt(() => getOptions?.()) ?? {};
    try {
      handle = diagnostics.run(kind, { ...options, ...(current?.keySource ? current : {}) });
    } catch (error) {
      handle = null;
      attempt(() => notify?.(errorKey(error)));
    }
  }

  function render(next = diagnostics.snapshot()) {
    snapshot = next;
    renderObservations();
    const current = route();
    const capabilities = attempt(() => diagnostics.capabilities(current, attempt(() => getOptions?.()) ?? {})) ?? [];
    for (const name of CAPABILITIES) {
      const entry = capabilities.find((item) => item.capability === name);
      const nodes = capabilityRows[name];
      const state = entry?.state ?? 'untested';
      nodes.row.setAttribute('data-state', state);
      nodes.state.textContent = i18n.t(STATE_KEYS[state] ?? STATE_KEYS.untested);
      nodes.route.textContent = entry?.route && ROUTE_KEYS[entry.route] ? i18n.t(ROUTE_KEYS[entry.route]) : '';
    }
    const busy = snapshot.running !== null;
    for (const kind of DIAGNOSTIC_KINDS) {
      const nodes = checkRows[kind];
      const { state, result, capturing } = checkState(kind, snapshot, capabilities);
      nodes.row.setAttribute('data-state', state);
      nodes.state.textContent = i18n.t(STATE_KEYS[state] ?? STATE_KEYS.untested);
      const running = state === 'running';
      nodes.button.textContent = i18n.t(running ? (capturing ? 'common.stop' : 'common.cancel') : 'common.check');
      nodes.button.setAttribute('aria-pressed', String(running));
      nodes.button.disabled = !running && (busy || blocked.has(state) || (KIND_CAPABILITY[kind] !== null && !current?.keySource));
      const messageKey = !running && result && result.state !== 'available' ? resolveKey(i18n, result.messageKey, null) : null;
      nodes.message.hidden = messageKey === null;
      nodes.message.textContent = messageKey ? i18n.t(messageKey) : '';
      const model = !running && result?.state === 'available' && typeof result.model === 'string' ? result.model : '';
      nodes.model.hidden = !model;
      nodes.model.textContent = model;
    }
  }

  const unsubscribe = diagnostics.subscribe(render);
  render(snapshot);

  return Object.freeze({
    element: section,
    render,
    refresh() { bind.refresh(); render(snapshot); },
    destroy() {
      unsubscribe();
      detachMetrics?.(); detachHub?.();
      bind.clear();
      section.remove();
    },
  });
}
