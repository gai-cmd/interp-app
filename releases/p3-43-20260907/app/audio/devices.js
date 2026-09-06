/**
 * Audio device list and selection (design-p3 §1.14, architecture.md P3-25).
 * New implementation; nothing is ported from the legacy tree.
 *
 * One owner for enumerateDevices(), the two stored device choices and the
 * "selected device disappeared" rule. The list always starts with the system
 * default entry, is refreshed on `devicechange`, on return to the foreground
 * and when the microphone permission becomes granted, and is never assumed
 * complete: browsers hide labels and devices before permission and may hide
 * whole kinds (outputs) behind a permission of their own.
 *
 * A device ID is not a permanent identifier. It is scoped to this origin and
 * browser profile, it may change after site data is cleared or per session,
 * and before permission a browser may expose no IDs at all. So a stored ID is
 * only declared lost, and the choice reverted to the system default, when the
 * list of its kind is authoritative (permission granted or labels visible)
 * and non-empty and still does not contain it. An empty or hidden list keeps
 * the stored choice and reports it as not present.
 *
 * Device IDs and labels stay in this module, the preference store and the
 * settings UI; they never enter policy, logs or diagnostics exports. Errors
 * from the browser are classified, never forwarded or logged.
 */
import { AUDIO_DEVICE_PREFERENCES, isSystemDefaultDeviceId, normalizePreference } from '../preferences.js';

export const DEVICE_KINDS = Object.freeze(['audioinput', 'audiooutput']);
export const DEVICE_STATUSES = Object.freeze(['idle', 'refreshing', 'ready', 'unsupported', 'failed']);
export const REFRESH_REASONS = Object.freeze(['manual', 'devicechange', 'foreground', 'permission']);
// Labels are user-visible text only; anything longer is not a device name.
export const DEVICE_LABEL_MAX_CHARS = 128;

const SELECT_MESSAGE_KEYS = Object.freeze({
  audioinput: 'device.inputAppliesNextStart', audiooutput: 'device.outputPcmOnly',
});
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const SCALAR_FIELDS = Object.freeze(['status', 'supported', 'labelsAvailable', 'incomplete', 'messageKey', 'refreshedAt', 'persisted']);

const attempt = fn => { try { return fn(); } catch { return undefined; } };
const invalid = () => { throw new Error('INVALID_REQUEST'); };

/** The entry every list starts with: the browser's current default for that kind. */
export function systemDefaultEntry(kind) {
  if (!DEVICE_KINDS.includes(kind)) invalid();
  return Object.freeze({ kind, deviceId: '', label: '', labelKey: 'device.systemDefault', isDefault: true });
}

/** Dictionary key for a select() result or a list entry without a label. */
export function deviceMessageKey(kind) {
  return SELECT_MESSAGE_KEYS[kind] ?? null;
}

function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARS, '').trim();
  return Array.from(text).slice(0, DEVICE_LABEL_MAX_CHARS).join('');
}

/**
 * Pure list builder shared by refresh() and tests: turns raw MediaDeviceInfo
 * objects into one frozen list per kind. `granted` says the microphone
 * permission is known to be granted (the P3-23 service's status).
 *
 * Rules, per kind:
 *   - the system default entry comes first and is always present;
 *   - pseudo IDs (empty, `default`, `communications`) are represented by that
 *     entry and dropped; a repeated (kind, deviceId) is listed once;
 *   - an ID the preference store could not keep is not listed;
 *   - a device without a label is listed only when the list is authoritative,
 *     so nothing is guessed before permission (§1.14);
 *   - `authoritative` is granted || some device of the kind carries a label;
 *   - `hidden` counts the devices dropped for lacking a label; `incomplete`
 *     is true when anything was hidden.
 */
export function buildDeviceLists(rawDevices, { granted = false } = {}) {
  const raw = Array.isArray(rawDevices) ? rawDevices : (attempt(() => Array.from(rawDevices ?? [])) ?? []);
  const result = {};
  for (const kind of DEVICE_KINDS) {
    const name = AUDIO_DEVICE_PREFERENCES[kind];
    const seen = new Set();
    const candidates = [];
    let labelled = false;
    for (const item of raw) {
      if (item?.kind !== kind) continue;
      const deviceId = typeof item.deviceId === 'string' ? item.deviceId : '';
      const label = cleanLabel(item.label);
      if (label) labelled = true;
      if (isSystemDefaultDeviceId(deviceId) || normalizePreference(name, deviceId) === null || seen.has(deviceId)) continue;
      seen.add(deviceId);
      candidates.push({ deviceId, label });
    }
    const authoritative = granted || labelled;
    const listed = candidates.filter(candidate => candidate.label || authoritative);
    const entries = [systemDefaultEntry(kind), ...listed.map(({ deviceId, label }) => Object.freeze({
      kind, deviceId, label, labelKey: label ? null : 'device.unlabeled', isDefault: false,
    }))];
    result[kind] = Object.freeze({
      entries: Object.freeze(entries), authoritative, labelled,
      hidden: candidates.length - listed.length, incomplete: candidates.length !== listed.length,
    });
  }
  return Object.freeze(result);
}

/**
 * createAudioDevices({ navigator, preferences, permission?, document?, now? })
 *   refresh({ reason })  → Promise<snapshot>. Calls enumerateDevices(), rebuilds
 *                  the lists and reverts a stored choice whose device is gone.
 *                  Concurrent calls share one enumeration; a change arriving
 *                  during one schedules exactly one more. Never throws.
 *   list(kind?)   → frozen entries of the kind, or of both kinds in order.
 *                  Each entry is { kind, deviceId, label, labelKey, isDefault };
 *                  the system default (deviceId '') is always first.
 *   select(kind, deviceId) → frozen { ok, persisted, kind, deviceId, messageKey }.
 *                  null, '' or a pseudo ID clears the choice (system default).
 *                  The choice is stored only; applying it to capture (P3-26)
 *                  or to the playback context (P3-27) is the caller's job.
 *   snapshot()    → frozen { status, supported, labelsAvailable, incomplete,
 *                  devices: { audioinput, audiooutput }, selected: { [kind]:
 *                  { deviceId, present } }, recovered, messageKey, persisted,
 *                  refreshedAt }. supported is null until the first refresh.
 *   subscribe(fn) → unsubscribe; fn(snapshot) after every change.
 *   destroy()     → detaches from the browser, the permission service and the
 *                  preference store; a late enumeration result is dropped.
 *
 * The permission service (P3-23) is optional: with it, a status change to
 * granted refreshes the list and granted makes lists authoritative. document
 * is optional: with it, a return to the visible state refreshes a list that
 * was requested before. Storage failure is the preference store's concern:
 * a rejected write stays effective for this run and `persisted` reports it.
 */
export function createAudioDevices({ navigator, preferences, permission = null, document = null, now = Date.now } = {}) {
  if (!preferences || typeof preferences.get !== 'function' || typeof preferences.set !== 'function'
    || typeof preferences.remove !== 'function') invalid();
  if (typeof now !== 'function') invalid();
  const listeners = new Set();
  const detachers = [];
  let lists = buildDeviceLists([]);
  let state = null;
  let running = null, dirty = false, destroyed = false, generation = 0, reconciling = false;

  const timestamp = () => { const value = attempt(() => now()); return Number.isFinite(value) ? value : null; };
  const granted = () => attempt(() => permission?.snapshot?.()?.status) === 'granted';
  const stored = kind => attempt(() => preferences.get(AUDIO_DEVICE_PREFERENCES[kind])) ?? null;
  // Kinds whose last write (select or reversion) in this run was rejected by
  // storage. The store's own flag follows its latest access, reads included,
  // so a rejected write is remembered here until a write of that kind succeeds.
  const unsaved = new Set();
  const persisted = () => unsaved.size === 0 && attempt(() => preferences.persisted) === true;
  const recordWrite = (kind, result) => { if (result?.persisted === true) unsaved.delete(kind); else unsaved.add(kind); };

  function selection() {
    const selected = {};
    for (const kind of DEVICE_KINDS) {
      const deviceId = stored(kind);
      const present = deviceId === null || lists[kind].entries.some(entry => entry.deviceId === deviceId);
      selected[kind] = Object.freeze({ deviceId, present });
    }
    return Object.freeze(selected);
  }
  function update(patch) {
    const base = state ?? {
      status: 'idle', supported: null, labelsAvailable: false, incomplete: true,
      recovered: Object.freeze([]), messageKey: null, refreshedAt: null,
    };
    const next = { ...base, ...patch };
    next.devices = Object.freeze(Object.fromEntries(DEVICE_KINDS.map(kind => [kind, lists[kind].entries])));
    next.selected = selection();
    next.persisted = persisted();
    const changed = state === null
      || SCALAR_FIELDS.some(key => next[key] !== state[key])
      || next.recovered.join() !== state.recovered.join()
      || DEVICE_KINDS.some(kind => next.devices[kind] !== state.devices[kind]
        || next.selected[kind].deviceId !== state.selected[kind].deviceId
        || next.selected[kind].present !== state.selected[kind].present);
    state = Object.freeze(next);
    if (changed && !destroyed) for (const fn of [...listeners]) attempt(() => fn(state));
    return state;
  }
  update({});

  async function run() {
    const mine = ++generation;
    update({ status: 'refreshing' });
    const enumerate = navigator?.mediaDevices?.enumerateDevices;
    if (typeof enumerate !== 'function') {
      lists = buildDeviceLists([]);
      return update({ status: 'unsupported', supported: false, labelsAvailable: false, incomplete: true,
        recovered: Object.freeze([]), messageKey: null, refreshedAt: timestamp() });
    }
    let raw;
    try { raw = await enumerate.call(navigator.mediaDevices); } catch {
      if (destroyed || mine !== generation) return state;
      // The list is unknown, not empty: keep the previous entries and choices.
      return update({ status: 'failed', supported: true, incomplete: true, recovered: Object.freeze([]), messageKey: null,
        refreshedAt: timestamp() });
    }
    if (destroyed || mine !== generation) return state;
    lists = buildDeviceLists(raw, { granted: granted() });
    const recovered = [];
    reconciling = true;
    try {
      for (const kind of DEVICE_KINDS) {
        const deviceId = stored(kind);
        const { entries, authoritative } = lists[kind];
        if (deviceId === null || !authoritative || entries.length < 2) continue;
        if (entries.some(entry => entry.deviceId === deviceId)) continue;
        // The device this ID named is gone (unplugged, or the ID was reissued): back to the system default.
        recordWrite(kind, attempt(() => preferences.remove(AUDIO_DEVICE_PREFERENCES[kind])));
        recovered.push(kind);
      }
    } finally { reconciling = false; }
    return update({
      status: 'ready', supported: true,
      labelsAvailable: DEVICE_KINDS.some(kind => lists[kind].labelled),
      incomplete: DEVICE_KINDS.some(kind => lists[kind].incomplete),
      recovered: Object.freeze(recovered), messageKey: recovered.length ? 'device.disappeared' : null,
      refreshedAt: timestamp(),
    });
  }

  function refresh({ reason = 'manual' } = {}) {
    if (!REFRESH_REASONS.includes(reason)) return Promise.reject(new Error('INVALID_REQUEST'));
    if (destroyed) return Promise.resolve(state);
    if (running) { dirty = true; return running; }
    running = run().finally(() => {
      running = null;
      if (dirty && !destroyed) { dirty = false; refresh({ reason }); }
    });
    return running;
  }

  function list(kind) {
    if (kind === undefined) return Object.freeze(DEVICE_KINDS.flatMap(item => [...lists[item].entries]));
    if (!DEVICE_KINDS.includes(kind)) invalid();
    return lists[kind].entries;
  }

  function select(kind, deviceId) {
    if (!DEVICE_KINDS.includes(kind)) invalid();
    const name = AUDIO_DEVICE_PREFERENCES[kind];
    const messageKey = deviceMessageKey(kind);
    let result;
    if (isSystemDefaultDeviceId(deviceId)) result = attempt(() => preferences.remove(name));
    else result = attempt(() => preferences.set(name, deviceId));
    if (!result?.ok) return Object.freeze({ ok: false, persisted: persisted(), kind, deviceId: null, code: 'INVALID_REQUEST',
      messageKey: 'error.INVALID_REQUEST' });
    recordWrite(kind, result);
    update({});
    return Object.freeze({ ok: true, persisted: result.persisted === true, kind, deviceId: stored(kind), messageKey });
  }

  function listen(target, type, handler) {
    if (typeof target?.addEventListener !== 'function') return false;
    target.addEventListener(type, handler);
    detachers.push(() => attempt(() => target.removeEventListener(type, handler)));
    return true;
  }
  // devicechange: a plug or unplug, or the browser revealing devices after permission.
  const mediaDevices = navigator?.mediaDevices;
  if (mediaDevices && !listen(mediaDevices, 'devicechange', () => refresh({ reason: 'devicechange' }))
    && typeof mediaDevices === 'object' && 'ondevicechange' in mediaDevices) {
    const handler = () => refresh({ reason: 'devicechange' });
    mediaDevices.ondevicechange = handler;
    detachers.push(() => { if (mediaDevices.ondevicechange === handler) mediaDevices.ondevicechange = null; });
  }
  // Foreground return: only a list somebody already asked for is refreshed.
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.supported !== null) refresh({ reason: 'foreground' });
  });
  // Permission granted: labels and hidden devices become visible.
  if (typeof permission?.subscribe === 'function') {
    let previous = attempt(() => permission.snapshot?.()?.status) ?? null;
    const off = attempt(() => permission.subscribe(snapshot => {
      const status = snapshot?.status ?? null;
      if (status === 'granted' && previous !== 'granted') refresh({ reason: 'permission' });
      previous = status;
    }));
    if (typeof off === 'function') detachers.push(() => attempt(off));
  }
  // The store changed underneath (another tab, or a reset): recompute the selection.
  if (typeof preferences.subscribe === 'function') {
    const off = attempt(() => preferences.subscribe(event => {
      if (reconciling || !Object.values(AUDIO_DEVICE_PREFERENCES).includes(event?.name)) return;
      update({});
    }));
    if (typeof off === 'function') detachers.push(() => attempt(off));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    dirty = false;
    for (const detach of detachers.splice(0)) detach();
    listeners.clear();
    if (state.status === 'refreshing') state = Object.freeze({ ...state, status: state.supported === null ? 'idle' : 'ready' });
  }

  return Object.freeze({
    refresh, list, select, destroy,
    snapshot: () => state,
    subscribe(fn) {
      if (typeof fn !== 'function') invalid();
      if (destroyed) return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}
