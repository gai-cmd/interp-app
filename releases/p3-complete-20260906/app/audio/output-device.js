// P3-27: routing PCM playback to a chosen output device (design-p3 §1.14).
//
// The only thing this can steer is the app's own AudioContext, through
// AudioContext.setSinkId. That matters for what it CANNOT steer, and the UI
// must not imply otherwise:
//   - device speech (speechSynthesis) has no sink of its own and always plays
//     on the system output, whatever is chosen here;
//   - a browser that only implements HTMLMediaElement.setSinkId cannot route an
//     AudioContext, so support is detected on the context, never on an element.
//
// Applying is asynchronous and can be refused, and the device can vanish while
// the switch is in flight. Nothing here reports success before the browser has
// actually confirmed it, and a result that arrives after a newer request (or
// after the context closed) is dropped rather than reported.
import { SYSTEM_DEFAULT_DEVICE_IDS } from '../preferences.js';

export const OUTPUT_STATES = Object.freeze(['unsupported', 'system', 'applying', 'applied', 'failed']);
/** Why an apply did not take effect; never a native error. */
export const OUTPUT_ERRORS = Object.freeze(['unsupported', 'denied', 'notFound', 'unknown']);
const MESSAGE_KEYS = Object.freeze({
  unsupported: 'device.outputUnsupported', denied: 'device.outputPermission',
  notFound: 'device.disappeared', unknown: 'device.outputPcmOnly',
});

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
/** null (system default) for every id a browser uses to mean "the system". */
const normalizeId = (deviceId) =>
  typeof deviceId === 'string' && deviceId && !SYSTEM_DEFAULT_DEVICE_IDS.includes(deviceId) ? deviceId : null;

/** setSinkId on the AudioContext is the only support that counts here. */
export function supportsOutputSelection(context) {
  return typeof context?.setSinkId === 'function';
}

/** Classify a setSinkId rejection by name; nothing native is forwarded. */
export function classifySinkError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
  return 'unknown';
}

/**
 * createOutputDevice({ getAudioContext, now? })
 *   select(deviceId)  → Promise<snapshot>. Applies the sink to the current
 *                       context and to every context created later.
 *   apply(context)    → Promise<snapshot>. Called for a freshly created
 *                       context, before anything is played through it.
 *   snapshot()        → frozen { state, deviceId, applied, supported, error,
 *                       messageKey }. `applied` is the id the browser
 *                       confirmed, which is not the request until it succeeds.
 *   subscribe(fn) / destroy()
 */
export function createOutputDevice({ getAudioContext, now = Date.now } = {}) {
  if (typeof getAudioContext !== 'function') throw new Error('INVALID_REQUEST');
  const listeners = new Set();
  let wanted = null, applied = null, state = 'system', error = null, supported = null;
  let generation = 0, destroyed = false, cached = null;

  const snapshot = () => {
    cached ??= Object.freeze({ state, deviceId: wanted, applied, supported, error,
      messageKey: error ? MESSAGE_KEYS[error] : null, changedAt: now() });
    return cached;
  };
  function notify() {
    cached = null;
    const value = snapshot();
    for (const fn of [...listeners]) { try { fn(value); } catch { /* Consumer-owned failure. */ } }
  }

  async function route(context, epoch) {
    if (!context) { supported = null; return snapshot(); }
    supported = supportsOutputSelection(context);
    if (!supported) {
      // Nothing to route: the system output is what plays, and saying so is not
      // a failure of the user's choice.
      state = 'unsupported'; applied = null; error = wanted === null ? null : 'unsupported';
      notify(); return snapshot();
    }
    if (wanted === null) {
      // Back to the system default: '' is the documented way to ask for it.
      state = 'applying'; error = null; notify();
      try { await context.setSinkId(''); } catch (raw) {
        if (epoch !== generation || destroyed) return snapshot();
        state = 'failed'; error = classifySinkError(raw); notify(); return snapshot();
      }
      if (epoch !== generation || destroyed) return snapshot();
      state = 'system'; applied = null; error = null; notify(); return snapshot();
    }
    state = 'applying'; error = null; notify();
    try { await context.setSinkId(wanted); } catch (raw) {
      // A refusal or a vanished device leaves playback on whatever the context
      // was already using; the state says so rather than claiming success.
      if (epoch !== generation || destroyed) return snapshot();
      state = 'failed'; error = classifySinkError(raw); notify(); return snapshot();
    }
    // A late completion of a superseded switch is dropped, not reported.
    if (epoch !== generation || destroyed) return snapshot();
    state = 'applied'; applied = wanted; error = null;
    notify();
    return snapshot();
  }

  return Object.freeze({
    snapshot,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
    async select(deviceId) {
      if (destroyed) return snapshot();
      const next = normalizeId(deviceId);
      wanted = next;
      const epoch = ++generation;
      return route(attempt(() => getAudioContext()) ?? null, epoch);
    },
    /** A new context starts on the chosen sink before anything is played. */
    async apply(context) {
      if (destroyed) return snapshot();
      const epoch = ++generation;
      return route(context ?? attempt(() => getAudioContext()) ?? null, epoch);
    },
    destroy() { destroyed = true; generation++; listeners.clear(); },
  });
}
