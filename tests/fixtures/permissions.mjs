// Offline stand-ins for the microphone permission service (P3-23): a
// navigator with a scripted Permissions API and a scripted getUserMedia,
// plus counting streams and tracks. Tests only; never imported by product
// modules. No key, device label or hub address appears here.

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Let queued microtasks and already-resolved promises settle. */
export async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
}

/** A getUserMedia-style rejection carrying a secret-looking message the service must drop. */
export function mediaError(name, message = 'secret-device-detail') {
  return Object.assign(new Error(message), { name });
}

/** Counting audio track; stop() is idempotent like the browser's. */
export function track(kind = 'audio') {
  return Object.assign(new EventTarget(), {
    kind, readyState: 'live', muted: false, stops: 0,
    stop() { this.stops += 1; this.readyState = 'ended'; },
  });
}

/** A MediaStream-shaped object with `count` audio tracks (0 makes an empty stream). */
export function stream(count = 1) {
  const tracks = Array.from({ length: count }, () => track());
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    stopped: () => tracks.length > 0 && tracks.every(t => t.stops > 0),
    live: () => tracks.some(t => t.readyState === 'live'),
  };
}

/**
 * PermissionStatus-shaped object. `set(state)` changes the state and fires
 * `change` (through addEventListener listeners and onchange). Pass
 * `{ legacy: true }` for an object that only supports onchange.
 */
export function permissionStatus(state = 'prompt', { legacy = false } = {}) {
  const target = new EventTarget();
  const status = {
    state,
    onchange: null,
    listeners: 0,
    set(next) {
      status.state = next;
      const event = new Event('change');
      if (!legacy) target.dispatchEvent(event);
      status.onchange?.(event);
    },
  };
  if (!legacy) {
    status.addEventListener = (type, fn) => { status.listeners += 1; target.addEventListener(type, fn); };
    status.removeEventListener = (type, fn) => { status.listeners -= 1; target.removeEventListener(type, fn); };
  }
  return status;
}

/**
 * Navigator stand-in.
 *   permissions: 'granted' | 'denied' | 'prompt' — query resolves a status with that state
 *                'unsupported' — no navigator.permissions at all
 *                'throws'      — query throws synchronously (TypeError, like Firefox for 'microphone')
 *                'rejects'     — query returns a rejected promise
 *                'garbage'     — query resolves to an object with an unknown state
 *                a permissionStatus() object — returned as is
 *                a function    — called per query, may return any of the above values
 *   media:       a function (constraints, index) → stream | Promise | Error, or an
 *                array of such steps consumed in order (the last one repeats).
 *                An Error return value rejects. Omit to have no mediaDevices.
 * Every getUserMedia call is recorded in `calls` with its constraints.
 */
export function navigator({ permissions = 'prompt', media } = {}) {
  const calls = [];
  const statuses = [];
  const nav = {};
  const steps = media === undefined ? null : (Array.isArray(media) ? media : [media]);
  if (steps) {
    nav.mediaDevices = {
      getUserMedia(constraints) {
        const index = calls.length;
        calls.push({ constraints });
        const step = steps[Math.min(index, steps.length - 1)];
        let produced;
        try { produced = typeof step === 'function' ? step(constraints, index) : step; }
        catch (error) { return Promise.reject(error); }
        return Promise.resolve(produced).then(value => (value instanceof Error ? Promise.reject(value) : value));
      },
    };
  }
  const resolvePermissions = () => (typeof permissions === 'function' ? permissions(statuses.length) : permissions);
  if (permissions !== 'unsupported') {
    nav.permissions = {
      query(descriptor) {
        if (descriptor?.name !== 'microphone') throw new TypeError('unsupported descriptor');
        const mode = resolvePermissions();
        if (mode === 'unsupported') throw new TypeError('permissions unsupported');
        if (mode === 'throws') throw new TypeError('microphone is not a valid permission name');
        if (mode === 'rejects') return Promise.reject(new TypeError('query rejected'));
        if (mode === 'garbage') return Promise.resolve({ state: 'maybe' });
        const status = typeof mode === 'string' ? permissionStatus(mode) : mode;
        statuses.push(status);
        return Promise.resolve(status);
      },
    };
  }
  return { navigator: nav, calls, statuses, last: () => statuses.at(-1) ?? null };
}

/** Manual epoch clock for `now` injection. */
export function clock(start = Date.parse('2026-09-06T01:00:00Z')) {
  let time = start;
  return { now: () => time, advance(ms) { time += ms; } };
}
