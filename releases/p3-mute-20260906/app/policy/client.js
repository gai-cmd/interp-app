// New implementation of design-p3 §1.3 and §1.5 and architecture.md "정책 모듈"
// (client.js, P3-06); no legacy code is ported. The client fetches the one
// fixed `policy.json` at the deployed root, validates it with the shared
// validator and keeps the accepted policy in memory only. Only a validated,
// recent policy counts as execution authority:
//
//   fixed URL from location (never import.meta.url / releases/<id>/)
//   same origin, redirect: 'error', cache: 'no-store', 5 s deadline, 64 KiB body
//   -> validatePolicy -> revision conflict / rollback check -> atomic swap
//   60 s foreground refresh, refresh({ reason }) on foreground return / preflight
//   5 min memory validity: an older policy is not authority, whatever the reason
//
// Every request carries a generation; a reply that arrives after stop() or
// after a newer request is discarded even when the transport ignored the
// abort. Importing touches no browser globals, network or storage. Snapshots
// are frozen and carry codes only, never response bodies or URLs.
import { POLICY_LIMITS, validatePolicy } from './schema.js';
import { withDeadline } from '../engine/retry.js';
import { APP_VERSION, parseVersion } from '../version.js';

export const POLICY_CLIENT = Object.freeze({
  fileName: 'policy.json', timeoutMs: 5000, refreshMs: 60000, maxAgeMs: 300000, bodyBytes: POLICY_LIMITS.bodyBytes,
});
export const POLICY_STATUSES = Object.freeze(['loading', 'ready', 'stale', 'failed', 'expired']);
export const REFRESH_REASONS = Object.freeze(['start', 'timer', 'foreground', 'preflight', 'manual']);
// snapshot().error values this module produces itself; validation failures
// surface the first validatePolicy issue code (POLICY_ISSUE_CODES) instead.
// None of these is a dictionary key: the UI shows policy.status.<status>.
export const POLICY_CLIENT_ERRORS = Object.freeze(['POLICY_FETCH_ORIGIN', 'POLICY_FETCH_REDIRECT', 'POLICY_FETCH_STATUS',
  'POLICY_FETCH_TIMEOUT', 'POLICY_FETCH_NETWORK', 'POLICY_TOO_LARGE', 'POLICY_INVALID',
  'POLICY_REVISION_CONFLICT', 'POLICY_REVISION_ROLLBACK', 'POLICY_STALE']);

const MAX_DELAY = 2147483647;
const SAME_ORIGIN_TYPES = Object.freeze(['basic', 'default', undefined, null, '']);

/**
 * The single policy URL for a document location: the deployed root is
 * `location.pathname` up to and including its last `/`, so `/interp-app/`,
 * `/interp-app/index.html` and `/interp-app/?x` all resolve to
 * `/interp-app/policy.json`. Only http(s) locations qualify; anything else
 * (file:, about:, opaque origins) returns null and every refresh fails with
 * POLICY_FETCH_ORIGIN. The module's own URL (`releases/<id>/`) is never used.
 */
export function policyUrlFor(location) {
  let base;
  try {
    const href = typeof location === 'string' ? location : location?.href;
    base = new URL(href);
  } catch { return null; }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  const root = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  return `${base.origin}${root}${POLICY_CLIENT.fileName}`;
}

function outcome(error) { return { ok: false, error }; }

/**
 * createPolicyClient({ fetch, location, now, setTimeout, clearTimeout, appVersion, registeredHubIds })
 * returns frozen { start(), stop(), refresh({ reason }), snapshot(), subscribe(fn), url, appVersion }.
 *
 * - `now` returns epoch milliseconds (policy dates are absolute UTC).
 * - snapshot() -> frozen { status, policy, revision, fetchedAt, error }:
 *   status is POLICY_STATUSES; policy is the frozen validatePolicy() output or
 *   null when it is not authority (loading, failed); revision stays the last
 *   accepted revision for banners; error is a code string or null.
 * - Status is derived from time at every call: `ready` within 5 min of the
 *   last successful validation, `stale` within that window after a failed
 *   refresh, `failed` beyond it (or before any success), `expired` once
 *   validUntil passes (policy retained so the block reason is specific).
 * - refresh() deduplicates an in-flight request, re-arms the 60 s timer while
 *   started and resolves with the snapshot; it never rejects.
 * - start() performs the first refresh and arms the timer; stop() cancels the
 *   timer and the in-flight request; both are idempotent.
 * - subscribe(fn) calls fn(snapshot) after each change and returns an
 *   unsubscribe function. Listener errors are swallowed.
 * The response body and the URL never appear in snapshots or errors.
 */
export function createPolicyClient({ fetch: fetchImpl = globalThis.fetch, location = globalThis.location,
  now = () => Date.now(), setTimeout: schedule = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
  appVersion = APP_VERSION, registeredHubIds } = {}) {
  if (typeof now !== 'function' || typeof schedule !== 'function' || typeof clear !== 'function') throw new TypeError('POLICY_CLIENT_INVALID');
  if (!parseVersion(appVersion)) throw new TypeError('VERSION_INVALID');
  if (registeredHubIds !== undefined && !Array.isArray(registeredHubIds)) throw new TypeError('POLICY_CLIENT_INVALID');
  const url = policyUrlFor(location);
  const timing = { setTimeout: schedule, clearTimeout: clear };
  const listeners = new Set();
  // Accepted policy (memory only) and the identity used for same-revision conflicts.
  let policy = null, revision = null, contentId = null, fetchedAt = null;
  let lastError = null, attempted = false;
  // Request generation: a reply is applied only when it is still the newest.
  let generation = 0, inflight = null;
  let started = false, tickTimer = null, ageTimer = null, expiryTimer = null;
  let last = null, emitted = null;

  function derive(time) {
    if (policy === null) {
      return { status: attempted ? 'failed' : 'loading', policy: null, revision, fetchedAt, error: lastError };
    }
    if (time - fetchedAt > POLICY_CLIENT.maxAgeMs) {
      return { status: 'failed', policy: null, revision, fetchedAt, error: lastError ?? 'POLICY_STALE' };
    }
    if (typeof policy.validUntil === 'string' && time >= Date.parse(policy.validUntil)) {
      return { status: 'expired', policy, revision, fetchedAt, error: null };
    }
    if (lastError !== null) return { status: 'stale', policy, revision, fetchedAt, error: lastError };
    return { status: 'ready', policy, revision, fetchedAt, error: null };
  }

  // Same reference while nothing changed, so subscribers can compare identity.
  function current() {
    const next = derive(now());
    if (last && last.status === next.status && last.policy === next.policy && last.revision === next.revision
      && last.fetchedAt === next.fetchedAt && last.error === next.error) return last;
    last = Object.freeze(next);
    return last;
  }

  // Compares against the last snapshot listeners saw, not the last derived
  // one, so a transition first observed through snapshot() is still emitted.
  function notify() {
    const snapshot = current();
    if (snapshot === emitted) return;
    emitted = snapshot;
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* Consumer-owned failure. */ }
    }
  }

  function clearStateTimers() {
    clear(ageTimer); clear(expiryTimer);
    ageTimer = expiryTimer = null;
  }

  // Time-based transitions (5 min validity, validUntil) notify without a fetch.
  function armStateTimers() {
    clearStateTimers();
    if (policy === null) return;
    const time = now();
    ageTimer = schedule(notify, Math.min(MAX_DELAY, Math.max(0, fetchedAt + POLICY_CLIENT.maxAgeMs - time) + 1));
    if (typeof policy.validUntil === 'string') {
      const delay = Date.parse(policy.validUntil) - time;
      if (delay > 0 && delay <= MAX_DELAY) expiryTimer = schedule(notify, delay);
    }
  }

  function armTick() {
    clear(tickTimer);
    tickTimer = started ? schedule(() => { void refresh({ reason: 'timer' }); }, POLICY_CLIENT.refreshMs) : null;
  }

  async function readBody(response, signal) {
    const limit = POLICY_CLIENT.bodyBytes;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) return outcome('POLICY_TOO_LARGE');
    const body = response.body;
    let bytes;
    if (body && typeof body.getReader === 'function') {
      // Count what actually arrives; Content-Length alone is not trusted.
      const reader = body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        if (signal.aborted) { await reader.cancel().catch(() => {}); return outcome('POLICY_FETCH_NETWORK'); }
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) { await reader.cancel().catch(() => {}); return outcome('POLICY_TOO_LARGE'); }
        chunks.push(value);
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } else if (body === null && typeof response.arrayBuffer !== 'function') {
      return outcome('POLICY_INVALID');
    } else {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > limit) return outcome('POLICY_TOO_LARGE');
      bytes = new Uint8Array(buffer);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return outcome('POLICY_INVALID'); }
    return { ok: true, text };
  }

  function checkResponse(response) {
    if (!response || typeof response !== 'object') return outcome('POLICY_FETCH_NETWORK');
    if (response.redirected === true || response.type === 'opaqueredirect') return outcome('POLICY_FETCH_REDIRECT');
    if (!SAME_ORIGIN_TYPES.includes(response.type)) return outcome('POLICY_FETCH_ORIGIN');
    if (typeof response.url === 'string' && response.url !== '') {
      let final;
      try { final = new URL(response.url); } catch { return outcome('POLICY_FETCH_ORIGIN'); }
      const expected = new URL(url);
      if (final.origin !== expected.origin) return outcome('POLICY_FETCH_ORIGIN');
      if (final.pathname !== expected.pathname) return outcome('POLICY_FETCH_REDIRECT');
    }
    if (response.status !== 200) return outcome('POLICY_FETCH_STATUS');
    return null;
  }

  // Never rejects: resolves with { ok: true, policy } or { ok: false, error },
  // or { ok: false, error: null } when the request was cancelled. The request
  // opens synchronously so a caller's stop() always finds a signal to abort.
  async function load(controller) {
    if (url === null || typeof fetchImpl !== 'function') return outcome(url === null ? 'POLICY_FETCH_ORIGIN' : 'POLICY_FETCH_NETWORK');
    let request;
    try {
      request = Promise.resolve(fetchImpl(url, {
        method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json' }, signal: controller.signal,
      }));
    } catch { return outcome('POLICY_FETCH_NETWORK'); }
    request.catch(() => { /* Observed below or discarded after the deadline. */ });
    try {
      return await withDeadline(async (signal) => {
        // The deadline aborts its own signal; forward it to the transport.
        signal.addEventListener('abort', () => controller.abort(), { once: true });
        const response = await request;
        if (signal.aborted) return outcome(null);
        const rejected = checkResponse(response);
        if (rejected) return rejected;
        const body = await readBody(response, signal);
        if (!body.ok) return body;
        if (signal.aborted) return outcome(null);
        const result = validatePolicy(body.text, { registeredHubIds, now: now() });
        if (!result.ok) return outcome(result.issues[0]?.code ?? 'POLICY_INVALID');
        return { ok: true, policy: result.policy };
      }, { ...timing, signal: controller.signal, timeoutMs: POLICY_CLIENT.timeoutMs });
    } catch (error) {
      // withDeadline aborts its own signal on every failure, so the transport
      // signal cannot tell a cancel from a network error; the code can.
      if (error?.code === 'TIMEOUT') return outcome('POLICY_FETCH_TIMEOUT');
      if (error?.code === 'ABORTED') return outcome(null);
      return outcome('POLICY_FETCH_NETWORK');
    }
  }

  function apply(result) {
    attempted = true;
    if (result.ok) {
      const next = result.policy;
      const id = JSON.stringify(next);
      if (revision !== null && next.revision < revision) lastError = 'POLICY_REVISION_ROLLBACK';
      else if (revision !== null && next.revision === revision && id !== contentId) lastError = 'POLICY_REVISION_CONFLICT';
      else {
        // Atomic swap; identical content keeps the same frozen object.
        if (id !== contentId) { policy = next; contentId = id; }
        revision = next.revision;
        fetchedAt = now();
        lastError = null;
      }
    } else {
      lastError = result.error;
    }
    armStateTimers();
    notify();
  }

  function refresh({ reason = 'manual' } = {}) {
    if (!REFRESH_REASONS.includes(reason)) throw new TypeError('POLICY_CLIENT_INVALID');
    if (inflight) return inflight.promise;
    const mine = ++generation;
    const controller = new AbortController();
    const promise = load(controller).then((result) => {
      // Cancelled by stop() or superseded: the reply is discarded unread.
      if (mine !== generation || inflight?.generation !== mine) return current();
      inflight = null;
      if (result.error !== null || result.ok) apply(result);
      armTick();
      return current();
    });
    inflight = { generation: mine, controller, promise };
    armTick();
    return promise;
  }

  function start() {
    if (started) return inflight ? inflight.promise : Promise.resolve(current());
    started = true;
    armStateTimers();
    return refresh({ reason: 'start' });
  }

  function stop() {
    started = false;
    generation += 1;
    clear(tickTimer);
    tickTimer = null;
    clearStateTimers();
    if (inflight) {
      const pending = inflight;
      inflight = null;
      pending.controller.abort();
    }
  }

  return Object.freeze({
    url, appVersion, start, stop, refresh,
    snapshot: () => current(),
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('POLICY_CLIENT_INVALID');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
