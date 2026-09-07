/**
 * Microphone permission service (design-p3 §1.14, architecture.md P3-23).
 * New implementation; nothing is ported from the legacy tree.
 *
 * One owner for the three things the app must not scatter: querying the
 * Permissions API, requesting the microphone from a user gesture, and the
 * ownership of the stream that request produces. The service never touches
 * storage (a past value is not evidence of the current permission), never
 * retries a denial on its own, and never exposes native error objects.
 *
 * Status is what the browser reports right now: granted | denied | prompt,
 * or unsupported when the Permissions API is missing, rejects the query, or
 * returns something unrecognisable. A query failure is therefore never shown
 * as a denial; unsupported browsers fall back to real request results and to
 * query() being called again when the page returns to the foreground.
 *
 * getUserMedia rejections are classified by name, not forwarded:
 *   denied   — NotAllowedError / SecurityError / PermissionDeniedError
 *   noDevice — NotFoundError / DevicesNotFoundError / OverconstrainedError
 *   busy     — NotReadableError / TrackStartError (device in use, never denial)
 *   unknown  — everything else, including AbortError and non-Error rejections
 * Only denied changes the reported status; the others leave it untouched
 * because the browser may well have granted the permission already.
 */

export const PERMISSION_STATES = Object.freeze(['granted', 'denied', 'prompt', 'unsupported']);
export const PERMISSION_ERRORS = Object.freeze(['denied', 'noDevice', 'busy', 'unknown']);
export const REQUEST_PURPOSES = Object.freeze(['probe', 'start']);

// Used when the caller passes no constraints; capture paths pass their own.
export const DEFAULT_CONSTRAINTS = Object.freeze({ audio: true, video: false });

const ERROR_NAMES = Object.freeze({
  NotAllowedError: 'denied', SecurityError: 'denied', PermissionDeniedError: 'denied',
  NotFoundError: 'noDevice', DevicesNotFoundError: 'noDevice', OverconstrainedError: 'noDevice',
  NotReadableError: 'busy', TrackStartError: 'busy',
});
const ERROR_CODES = Object.freeze({
  denied: 'MICROPHONE_DENIED', noDevice: 'MICROPHONE_UNAVAILABLE', busy: 'MICROPHONE_UNAVAILABLE',
  unknown: 'MICROPHONE_UNAVAILABLE',
});
const HINT_KEYS = Object.freeze({
  unsupported: 'permission.unsupportedHint', denied: 'permission.noAutoRetry',
  busy: 'permission.busyHint', noDevice: 'permission.noDeviceHint',
});

const attempt = fn => { try { return fn(); } catch { return undefined; } };

/** Classify a getUserMedia rejection by its name only; the object itself is dropped. */
export function classifyMediaError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  return ERROR_NAMES[name] ?? 'unknown';
}

/** Stop every track of a stream, tolerating partial or foreign stream objects. */
export function stopStream(stream) {
  const tracks = attempt(() => stream?.getTracks?.()) ?? [];
  for (const track of tracks) attempt(() => track.stop());
}

/** Dictionary key describing a snapshot; 'checking' wins while a request is in flight. */
export function permissionMessageKey({ status, error, requesting } = {}) {
  if (requesting) return 'permission.checking';
  if (error === 'busy' || error === 'noDevice') return `permission.${error}`;
  if (error === 'denied') return 'permission.denied';
  return PERMISSION_STATES.includes(status) ? `permission.${status}` : 'permission.unsupported';
}

/** Secondary hint key for the same snapshot, or null when the status needs none. */
export function permissionHintKey({ status, error } = {}) {
  if (error === 'busy' || error === 'noDevice') return HINT_KEYS[error];
  if (error === 'denied' || status === 'denied') return HINT_KEYS.denied;
  if (status === 'unsupported') return HINT_KEYS.unsupported;
  return null;
}

function stateOf(permissionStatus) {
  const state = permissionStatus?.state;
  return state === 'granted' || state === 'denied' || state === 'prompt' ? state : null;
}

/**
 * createMicrophonePermission({ navigator, now })
 *   query()      → Promise<snapshot>. Feature-detects navigator.permissions,
 *                  subscribes to `change` on the returned status, never throws.
 *                  Concurrent calls share one query; the latest wins.
 *   request({ signal, purpose, constraints })
 *                → Promise<result>. Call from a user gesture only. purpose
 *                  'probe' stops the tracks immediately; 'start' (default)
 *                  hands the stream to the caller, who owns it from then on.
 *                  Concurrent calls share one getUserMedia; the stream goes to
 *                  the earliest caller that has not cancelled, and only when
 *                  that caller asked to start. A stream arriving after every
 *                  caller cancelled is stopped at once; the granted status is
 *                  still recorded because it is true.
 *   snapshot()   → frozen { status, supported, error, code, messageKey, hintKey,
 *                  requesting, queriedAt, requestedAt }. supported is null
 *                  until the first query, then true/false.
 *   subscribe(fn) → unsubscribe; fn(snapshot) after every change.
 *   destroy()    → unsubscribes from the browser, resolves waiting callers as
 *                  cancelled and stops any stream that arrives later.
 *
 * result: frozen { ok, status, error, code, messageKey, hintKey, cancelled, stream }
 * where stream is a MediaStream only for ok && purpose 'start' && owner.
 */
export function createMicrophonePermission({ navigator, now = Date.now } = {}) {
  const listeners = new Set();
  let state = Object.freeze({
    status: 'unsupported', supported: null, error: null, code: null,
    messageKey: 'permission.unsupported', hintKey: HINT_KEYS.unsupported,
    requesting: false, queriedAt: null, requestedAt: null,
  });
  let permissionStatus = null, unwatch = null, querying = null, pending = null;
  let destroyed = false, generation = 0;

  const timestamp = () => { const value = attempt(() => now()); return Number.isFinite(value) ? value : null; };
  function update(patch) {
    const next = { ...state, ...patch };
    next.messageKey = permissionMessageKey(next);
    next.hintKey = permissionHintKey(next);
    const changed = Object.keys(next).some(key => next[key] !== state[key]);
    state = Object.freeze(next);
    if (changed) for (const fn of [...listeners]) attempt(() => fn(state));
    return state;
  }
  // A browser-reported status is the authority: it clears a stale denial
  // classification, but a device error stays until the next request.
  function applyStatus(status) {
    const clear = state.error === 'denied' && status !== 'denied';
    return update({ status, supported: true, queriedAt: timestamp(),
      ...(clear ? { error: null, code: null } : {}) });
  }

  function watch(status) {
    if (permissionStatus === status) return;
    attempt(() => unwatch?.());
    permissionStatus = status;
    const onChange = () => {
      if (destroyed || permissionStatus !== status) return;
      const next = stateOf(status);
      if (next) applyStatus(next);
      else update({ status: 'unsupported', supported: false, queriedAt: timestamp() });
    };
    if (typeof status.addEventListener === 'function') {
      status.addEventListener('change', onChange);
      unwatch = () => attempt(() => status.removeEventListener('change', onChange));
    } else {
      status.onchange = onChange;
      unwatch = () => { if (status.onchange === onChange) status.onchange = null; };
    }
  }

  async function runQuery() {
    const query = navigator?.permissions?.query;
    const mine = ++generation;
    let status = null;
    if (typeof query === 'function') {
      // Some browsers throw synchronously (TypeError for an unknown name),
      // others reject; both mean "cannot query", never "denied".
      status = await (attempt(() => Promise.resolve(query.call(navigator.permissions, { name: 'microphone' }))
        .catch(() => null)) ?? null);
    }
    if (destroyed || mine !== generation) return state;
    const next = stateOf(status);
    if (!next) return update({ status: 'unsupported', supported: false, queriedAt: timestamp() });
    watch(status);
    return applyStatus(next);
  }

  function query() {
    if (destroyed) return Promise.resolve(state);
    if (!querying) querying = runQuery().finally(() => { querying = null; });
    return querying;
  }

  const result = (ok, extra = {}) => Object.freeze({ ok, status: state.status, error: state.error,
    code: state.code, messageKey: state.messageKey, hintKey: state.hintKey, cancelled: false, stream: null, ...extra });
  const cancelled = () => result(false, { cancelled: true, code: 'ABORTED', messageKey: 'error.ABORTED' });

  function request({ signal, purpose = 'start', constraints = DEFAULT_CONSTRAINTS } = {}) {
    if (!REQUEST_PURPOSES.includes(purpose)) return Promise.reject(new Error('INVALID_REQUEST'));
    if (destroyed || signal?.aborted) return Promise.resolve(cancelled());
    const current = pending ?? startRequest(constraints);
    // A synchronous failure (no getUserMedia, invalid constraints) settles
    // before anyone joins; such a request is never kept as pending.
    pending = current.settled() ? null : current;
    return current.join({ signal, purpose });
  }

  function startRequest(constraints) {
    const waiters = new Set();
    let owner = null, settled = null;
    update({ requesting: true, requestedAt: timestamp() });

    function join({ signal, purpose }) {
      if (settled) return Promise.resolve(settled);
      const waiter = { purpose };
      waiter.promise = new Promise(resolve => { waiter.resolve = resolve; });
      const onAbort = () => {
        if (!waiters.delete(waiter)) return;
        if (owner === waiter) owner = waiters.values().next().value ?? null;
        waiter.resolve(cancelled());
        if (!waiters.size && !settled) update({ requesting: false });
      };
      waiter.detach = () => attempt(() => signal?.removeEventListener('abort', onAbort));
      waiters.add(waiter);
      owner ??= waiter;
      attempt(() => signal?.addEventListener('abort', onAbort, { once: true }));
      return waiter.promise;
    }
    function settle(value, stream = null) {
      if (settled) return;
      settled = value;
      if (pending === handle) pending = null;
      for (const waiter of [...waiters]) {
        waiter.detach();
        // Only the owner receives the stream; joiners learn the status only.
        waiter.resolve(waiter === owner && stream ? Object.freeze({ ...value, stream }) : value);
      }
      waiters.clear();
    }
    const handle = Object.freeze({ join, abort: () => settle(cancelled()), settled: () => settled !== null });

    (async () => {
      let stream;
      try {
        const media = navigator?.mediaDevices?.getUserMedia;
        if (typeof media !== 'function') throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
        stream = await media.call(navigator.mediaDevices, constraints);
      } catch (error) {
        if (settled) return;
        const kind = classifyMediaError(error);
        update({ requesting: false, error: kind, code: ERROR_CODES[kind], ...(kind === 'denied' ? { status: 'denied' } : {}) });
        settle(result(false));
        return;
      }
      const tracks = attempt(() => stream?.getAudioTracks?.()) ?? [];
      // Late arrival after destroy or after every caller cancelled, a probe, or
      // an empty stream: nothing may keep the microphone open.
      const keep = !settled && !destroyed && owner?.purpose === 'start' && tracks.length > 0;
      if (!keep) stopStream(stream);
      if (settled) return;
      if (!tracks.length) {
        update({ requesting: false, error: 'noDevice', code: ERROR_CODES.noDevice });
        settle(result(false));
        return;
      }
      // The browser handed over a live track: that is direct evidence of a grant.
      update({ requesting: false, status: 'granted', error: null, code: null });
      settle(result(true), keep ? stream : null);
    })();

    return handle;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    attempt(() => unwatch?.());
    unwatch = null; permissionStatus = null;
    pending?.abort();
    update({ requesting: false });
    listeners.clear();
  }

  return Object.freeze({
    query, request, destroy,
    snapshot: () => state,
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('INVALID_REQUEST');
      if (destroyed) return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}
