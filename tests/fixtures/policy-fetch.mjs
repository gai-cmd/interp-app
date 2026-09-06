// Offline stand-ins for the policy client (P3-06): a deployed-root location,
// an epoch clock with manual timers and a scripted same-origin fetch. Tests
// only; never imported by product modules. No key, QR payload or hub address
// appears here.
import { examplePolicy } from './policy.mjs';

export const ORIGIN = 'https://gai-cmd.github.io';
export const ROOT = '/interp-app/';
export const POLICY_URL = `${ORIGIN}${ROOT}policy.json`;
// Epoch milliseconds; the client compares validUntil against this clock.
export const START = Date.parse('2026-09-06T01:00:00Z');

/** Browser-shaped location for the deployed app (or any pathname / href). */
export function location(pathname = ROOT, origin = ORIGIN) {
  const url = new URL(pathname, origin);
  return Object.freeze({ href: url.href, origin: url.origin, protocol: url.protocol, host: url.host,
    pathname: url.pathname, search: url.search, hash: url.hash });
}

/** Deterministic epoch clock: timers fire in due order inside advance(ms). */
export function createClock(start = START) {
  let time = start, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, at: time + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        timers.delete(id);
        time = timer.at;
        timer.callback();
      }
      time = end;
    },
    get size() { return timers.size; },
    get pending() { return [...timers.values()].map((timer) => timer.at - time).sort((a, b) => a - b); },
  };
}

/** Let queued microtasks and already-resolved promises settle. */
export async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * A Response whose body is streamed in chunks (so the client must count bytes
 * itself). `url` / `redirected` / `type` mimic the browser's response fields.
 */
export function policyResponse(body = JSON.stringify(examplePolicy()), options = {}) {
  return policySource(body, options).response;
}

/** Like policyResponse, also exposing how many bytes the client pulled. */
export function policySource(body = JSON.stringify(examplePolicy()), {
  status = 200, headers = {}, url = POLICY_URL, redirected = false, type = 'basic', chunkSize = 4096,
} = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += chunkSize));
    },
  }, { highWaterMark: 0 });
  const response = new Response(status === 204 ? null : stream, { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: redirected });
  Object.defineProperty(response, 'type', { value: type });
  return { response, pulled: () => Math.min(offset, bytes.length) };
}

/**
 * Scripted fetch. `script` is a function (call, index) -> Response | Promise |
 * Error, or an array of such steps consumed in order (the last step repeats).
 * Every call is recorded as { url, init, signal }. With `ignoreAbort: false`
 * (default) a pending call rejects with AbortError once its signal aborts;
 * with `ignoreAbort: true` the response is delivered regardless, which is how
 * a late reply reaches a client that already moved on.
 */
export function scriptedFetch(script, { ignoreAbort = false } = {}) {
  const calls = [];
  const steps = Array.isArray(script) ? script : [script];
  const fetch = (url, init = {}) => {
    const index = calls.length;
    const call = { url: String(url), init, signal: init.signal ?? null };
    calls.push(call);
    const step = steps[Math.min(index, steps.length - 1)];
    const produce = () => (typeof step === 'function' ? step(call, index) : step);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => (value) => { if (!settled) { settled = true; fn(value); } };
      const abort = () => finish(reject)(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!ignoreAbort && call.signal) {
        if (call.signal.aborted) { abort(); return; }
        call.signal.addEventListener('abort', abort, { once: true });
      }
      let produced;
      try { produced = produce(); } catch (error) { finish(reject)(error); return; }
      Promise.resolve(produced).then((value) => {
        if (value instanceof Error) finish(reject)(value);
        else finish(resolve)(value);
      }, finish(reject));
    });
  };
  return { fetch, calls };
}

/** A fetch whose n-th response is released by the test (`release(index, response)`). */
export function controlledFetch({ ignoreAbort = false } = {}) {
  const gates = [];
  const scripted = scriptedFetch((call, index) => {
    const gate = deferred();
    gates[index] = gate;
    return gate.promise;
  }, { ignoreAbort });
  return {
    fetch: scripted.fetch,
    calls: scripted.calls,
    release(index, response) { gates[index]?.resolve(response); },
    fail(index, error = Object.assign(new TypeError('network'), { name: 'TypeError' })) { gates[index]?.reject(error); },
  };
}
