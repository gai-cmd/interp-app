// Hub live-control state (P3-10). Owns the ordering, TTL and stop latch of one
// joined event: design-p3 §1.8, architecture.md "허브 통제", the server contract
// in docs/hub-control-protocol.md. The parser (P3-09, ./protocol.js) normalizes
// one received text; this module decides what a normalized snapshot may change.
// The socket and event join belong to P3-11 (./client.js, ../main.js).
//
// This state moved here unchanged from ./client.js, where P3-11 had to define it
// because P3-10 had not landed yet; client.js re-exports it for its callers.
import { HUB_LIMITS } from './protocol.js';
import { ProviderError } from '../providers/contract.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The epoch hint of a first negotiation: the app has no broadcast epoch until the
// hub's hello names one (§1.8 "새 epoch는 새 hello 이후에만 수락"); the server
// answers with the epoch it accepted regardless of this hint.
export const HUB_CONTROL_INITIAL_EPOCH = 'initial';

/**
 * Live-control state of one joined event (design-p3 §1.8, architecture.md
 * "허브 통제").
 *
 * createHubControl({ now, setTimeout, clearTimeout }) returns frozen
 * { negotiate(control), receive(snapshot), disconnected(), reset(), snapshot(), subscribe(fn), close() }.
 * - negotiate(hello.control | null): the hub's answer. null marks a hub without
 *   the extension (supported: false); a control object marks success and, when
 *   its epoch or event differs from the current one, opens a new epoch whose
 *   first snapshot is accepted at any revision.
 * - receive(control event): a full snapshot. Rejected (returns false) unless
 *   negotiated, same event and epoch, and a higher revision. A repeat of the
 *   current revision is the heartbeat: it re-arms the TTL and clears
 *   heartbeatLost without changing state. Lower revisions are ignored.
 * - The TTL runs on the app's monotonic timer from reception; expiry and
 *   disconnected() only set heartbeatLost. The stop latch, disabled features
 *   and notice are cleared by nothing but a newer accepted snapshot or reset().
 * - snapshot() -> frozen { supported: null | boolean, eventId, epoch, revision,
 *   stopped, disabledFeatures, notice, heartbeatLost, expiresAt }.
 *   supported is null before any hello. expiresAt is a `now()` value or null.
 */
export function createHubControl({ now = () => performance.now(), setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: clear = globalThis.clearTimeout } = {}) {
  if (typeof now !== 'function' || typeof schedule !== 'function' || typeof clear !== 'function') throw new ProviderError('INVALID_REQUEST');
  const initial = () => ({ supported: null, eventId: null, epoch: null, revision: null, stopped: false,
    disabledFeatures: Object.freeze([]), notice: null, heartbeatLost: false, expiresAt: null });
  const listeners = new Set();
  let state = initial(), timer = null, closed = false, cached = null;
  const snapshot = () => { cached ??= Object.freeze({ ...state }); return cached; };
  function notify() {
    cached = null;
    const value = snapshot();
    for (const listener of [...listeners]) { try { listener(value); } catch { /* Consumer-owned failure. */ } }
  }
  function disarm() { if (timer !== null) { clear(timer); timer = null; } }
  // Heartbeat deadline: a missing snapshot within ttlSeconds means the venue
  // control cannot be confirmed. It never releases a stop.
  function arm(seconds) {
    disarm();
    state.expiresAt = now() + seconds * 1000;
    timer = schedule(() => { timer = null; if (!closed && state.supported === true) { state.heartbeatLost = true; notify(); } }, seconds * 1000);
  }
  return Object.freeze({
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new ProviderError('INVALID_REQUEST');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    negotiate(control) {
      if (closed) return snapshot();
      if (control === null || control === undefined) {
        disarm();
        state.supported = false; state.eventId = null; state.epoch = null; state.revision = null;
        state.heartbeatLost = false; state.expiresAt = null;
        notify(); return snapshot();
      }
      if (!isObject(control) || typeof control.eventId !== 'string' || typeof control.epoch !== 'string') throw new ProviderError('INVALID_REQUEST');
      if (control.eventId !== state.eventId || control.epoch !== state.epoch) state.revision = null;
      state.supported = true; state.eventId = control.eventId; state.epoch = control.epoch; state.heartbeatLost = false;
      // The first full snapshot follows the hello; give it the longest TTL.
      arm(HUB_LIMITS.ttlMaxSeconds);
      notify(); return snapshot();
    },
    receive(value) {
      if (closed || state.supported !== true || !isObject(value) || value.type !== 'control') return false;
      if (value.eventId !== state.eventId || value.epoch !== state.epoch || !Number.isSafeInteger(value.revision)) return false;
      if (state.revision !== null && value.revision < state.revision) return false;
      if (value.revision === state.revision) {
        state.heartbeatLost = false; arm(value.ttlSeconds); notify(); return false;
      }
      state.revision = value.revision; state.stopped = value.stopped === true;
      state.disabledFeatures = Object.freeze([...value.disabledFeatures]); state.notice = value.notice ?? null;
      state.heartbeatLost = false;
      arm(value.ttlSeconds);
      notify(); return true;
    },
    disconnected() {
      if (closed) return snapshot();
      disarm();
      state.expiresAt = null;
      if (state.supported === true) state.heartbeatLost = true;
      notify(); return snapshot();
    },
    reset() {
      if (closed) return snapshot();
      disarm(); state = initial(); notify(); return snapshot();
    },
    close() { closed = true; disarm(); listeners.clear(); },
  });
}
