import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  POLICY_CLIENT, POLICY_CLIENT_ERRORS, POLICY_STATUSES, REFRESH_REASONS, createPolicyClient, policyUrlFor,
} from '../app/policy/client.js';
import { POLICY_LIMITS, validatePolicy } from '../app/policy/schema.js';
import { APP_VERSION } from '../app/version.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { examplePolicy, policyWith, serialized, trilingual } from './fixtures/policy.mjs';
import {
  ORIGIN, POLICY_URL, ROOT, START, controlledFetch, createClock, location, policyResponse, policySource, scriptedFetch, settle,
} from './fixtures/policy-fetch.mjs';

// P3-06: the policy client fetches one fixed same-origin policy.json, rejects
// redirects, oversized bodies and slow replies, refreshes every 60 s in the
// foreground, treats a policy older than 5 min as no authority, rejects
// revision conflicts and rollbacks, and discards replies that arrive late.

const MINUTE = 60000;
const SECOND = 1000;

// `transport` is a { fetch, calls } pair (scriptedFetch / controlledFetch);
// `steps` builds one from scripted replies. Reply factories keep every
// Response fresh, since a body can only be read once.
function harness({ transport, ignoreAbort, steps, clock = createClock(), pathname = ROOT, ...rest } = {}) {
  const scripted = transport ?? scriptedFetch(steps ?? (() => policyResponse()), { ignoreAbort });
  const events = [];
  const client = createPolicyClient({
    fetch: scripted.fetch, location: location(pathname), now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ...rest,
  });
  client.subscribe((snapshot) => events.push(snapshot));
  return { client, clock, events, calls: scripted.calls };
}
const validated = (policy) => {
  const result = validatePolicy(policy);
  assert.deepEqual(result.ok ? [] : result.issues, []);
  return result.policy;
};
const revised = (revision, mutate = () => {}) => serialized(policyWith((policy) => { policy.revision = revision; mutate(policy); }));
function assertDeepFrozen(value, path = 'value') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), path);
  for (const [key, item] of Object.entries(value)) assertDeepFrozen(item, `${path}.${key}`);
}
// The clock is synchronous: a request opened by a tick only settles after
// advance() returns, so minutes are advanced one at a time to stay inside the
// 5 s request deadline.
async function tickMinutes(clock, minutes) {
  for (let minute = 0; minute < minutes; minute += 1) { clock.advance(MINUTE); await settle(); }
}
async function ready(options) {
  const h = harness(options);
  await h.client.start();
  assert.equal(h.client.snapshot().status, 'ready');
  return h;
}

test('constants: statuses, reasons, limits and error codes are the documented closed sets', () => {
  assert.deepEqual(POLICY_STATUSES, ['loading', 'ready', 'stale', 'failed', 'expired']);
  assert.deepEqual(REFRESH_REASONS, ['start', 'timer', 'foreground', 'preflight', 'manual']);
  assert.deepEqual(POLICY_CLIENT, { fileName: 'policy.json', timeoutMs: 5 * SECOND, refreshMs: MINUTE,
    maxAgeMs: 5 * MINUTE, bodyBytes: POLICY_LIMITS.bodyBytes });
  assert.equal(POLICY_CLIENT.bodyBytes, 65536);
  for (const code of POLICY_CLIENT_ERRORS) assert.match(code, /^POLICY_[A-Z_]+$/);
  assert.ok(Object.isFrozen(POLICY_CLIENT) && Object.isFrozen(POLICY_STATUSES) && Object.isFrozen(POLICY_CLIENT_ERRORS));
});

test('policy URL: deployed root up to the last slash of location.pathname, never releases/<id>', () => {
  assert.equal(policyUrlFor(location('/interp-app/')), POLICY_URL);
  assert.equal(policyUrlFor(location('/interp-app/index.html')), POLICY_URL);
  assert.equal(policyUrlFor(location('/interp-app/?share=1#frag')), POLICY_URL);
  assert.equal(policyUrlFor(location('/interp-app/index.html?x=1#y')), POLICY_URL);
  assert.equal(policyUrlFor(location('/')), `${ORIGIN}/policy.json`);
  assert.equal(policyUrlFor(`${ORIGIN}/interp-app/`), POLICY_URL, 'a string href is accepted');
  assert.equal(policyUrlFor(location('/interp-app/', 'http://localhost:8080')), 'http://localhost:8080/interp-app/policy.json');
  // Module URLs live under releases/<id>/; they must never be the base.
  assert.equal(policyUrlFor(location('/interp-app/')).includes('releases'), false);
  assert.equal(policyUrlFor('file:///Users/x/interp-app/index.html'), null);
  assert.equal(policyUrlFor('about:blank'), null);
  assert.equal(policyUrlFor(undefined), null);
  assert.equal(policyUrlFor({}), null);
  assert.equal(policyUrlFor('not a url'), null);
});

test('constructor: frozen handle, validated inputs, initial loading snapshot without any fetch', () => {
  const { client, calls } = harness();
  assert.ok(Object.isFrozen(client));
  assert.deepEqual(Object.keys(client).sort(), ['appVersion', 'refresh', 'snapshot', 'start', 'stop', 'subscribe', 'url']);
  assert.equal(client.url, POLICY_URL);
  assert.equal(client.appVersion, APP_VERSION);
  assert.deepEqual(client.snapshot(), { status: 'loading', policy: null, revision: null, fetchedAt: null, error: null });
  assert.ok(Object.isFrozen(client.snapshot()));
  assert.equal(client.snapshot(), client.snapshot(), 'same reference while nothing changed');
  assert.equal(calls.length, 0, 'creating the client performs no request');
  assert.throws(() => createPolicyClient({ appVersion: 'v1' }), { name: 'TypeError', message: 'VERSION_INVALID' });
  assert.throws(() => createPolicyClient({ now: 5 }), { name: 'TypeError' });
  assert.throws(() => createPolicyClient({ registeredHubIds: 'venue-main' }), { name: 'TypeError' });
  assert.throws(() => client.subscribe(null), { name: 'TypeError' });
  assert.throws(() => client.refresh({ reason: 'background' }), { name: 'TypeError' });
  const other = createPolicyClient({ fetch: () => policyResponse(), location: location(ROOT), appVersion: '1.2.3' });
  assert.equal(other.appVersion, '1.2.3');
});

test('start: fixed URL, no-store, redirect error, same-origin, signal; first policy applied atomically', async () => {
  const { client, clock, events, calls } = harness();
  const promise = client.start();
  assert.equal(client.snapshot().status, 'loading', 'loading while the first request is in flight');
  const snapshot = await promise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, POLICY_URL);
  const { init } = calls[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.mode, 'same-origin');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);
  assert.deepEqual(init.headers, { accept: 'application/json' });

  assert.equal(snapshot, client.snapshot());
  assert.deepEqual(Object.keys(snapshot), ['status', 'policy', 'revision', 'fetchedAt', 'error']);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.fetchedAt, START);
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.policy, validated(examplePolicy()));
  assertDeepFrozen(snapshot);
  assert.deepEqual(events.map((event) => event.status), ['ready'], 'one notification for the transition');
  assert.equal(events[0], snapshot);
  assert.equal(clock.pending.includes(MINUTE), true, '60 s refresh timer armed after start');
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes(ORIGIN) || text.includes('http'), false, 'snapshot carries no URL');
});

test('start is idempotent and deduplicates the in-flight request; stop is idempotent', async () => {
  const controlled = controlledFetch();
  const { client, clock, calls } = harness({ transport: controlled });
  const first = client.start();
  const second = client.start();
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(client.refresh({ reason: 'manual' }), first, 'refresh joins the in-flight request');
  controlled.release(0, policyResponse());
  await first;
  assert.equal(client.snapshot().status, 'ready');
  assert.equal(await client.start(), client.snapshot(), 'a started client resolves its snapshot');
  assert.equal(calls.length, 1);
  client.stop();
  client.stop();
  assert.equal(clock.size, 0, 'stop releases every timer');
  clock.advance(10 * MINUTE);
  assert.equal(calls.length, 1, 'no refresh after stop');
});

test('rejected replies: redirect, foreign origin, other path, opaque type, non-200 status, thrown fetch', async () => {
  const cases = [
    ['redirected flag', () => policyResponse(undefined, { redirected: true }), 'POLICY_FETCH_REDIRECT'],
    ['opaque redirect', () => policyResponse(undefined, { type: 'opaqueredirect' }), 'POLICY_FETCH_REDIRECT'],
    ['final URL on another origin', () => policyResponse(undefined, { url: 'https://evil.example/interp-app/policy.json' }), 'POLICY_FETCH_ORIGIN'],
    ['final URL under releases/', () => policyResponse(undefined, { url: `${ORIGIN}${ROOT}releases/r1/policy.json` }), 'POLICY_FETCH_REDIRECT'],
    ['cors response type', () => policyResponse(undefined, { type: 'cors' }), 'POLICY_FETCH_ORIGIN'],
    ['opaque response type', () => policyResponse(undefined, { type: 'opaque' }), 'POLICY_FETCH_ORIGIN'],
    ['404', () => policyResponse('not found', { status: 404 }), 'POLICY_FETCH_STATUS'],
    ['500', () => policyResponse('', { status: 500 }), 'POLICY_FETCH_STATUS'],
    ['204', () => policyResponse('', { status: 204 }), 'POLICY_FETCH_STATUS'],
    ['network TypeError', () => new TypeError('Failed to fetch'), 'POLICY_FETCH_NETWORK'],
    ['non-response value', () => 'text', 'POLICY_FETCH_NETWORK'],
  ];
  for (const [name, reply, code] of cases) {
    const { client, events } = harness({ steps: reply });
    const snapshot = await client.start();
    assert.equal(snapshot.status, 'failed', name);
    assert.equal(snapshot.policy, null, name);
    assert.equal(snapshot.error, code, name);
    assert.deepEqual(events.map((event) => event.status), ['failed'], name);
    assert.ok(POLICY_CLIENT_ERRORS.includes(code));
  }
  // With a policy in memory the same rejections leave it in place as stale.
  for (const [name, reply, code] of cases) {
    const { client, clock } = await ready({ steps: (call, index) => (index === 0 ? policyResponse() : reply()) });
    clock.advance(MINUTE);
    await settle();
    const snapshot = client.snapshot();
    assert.equal(snapshot.status, 'stale', name);
    assert.equal(snapshot.error, code, name);
    assert.equal(snapshot.revision, 1, name);
    assert.deepEqual(snapshot.policy, validated(examplePolicy()), name);
  }
});

test('no usable location or fetch: every refresh fails with a code and nothing is thrown', async () => {
  const clock = createClock();
  const missing = createPolicyClient({ fetch: () => policyResponse(), location: 'file:///index.html', now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  assert.equal(missing.url, null);
  assert.deepEqual(await missing.refresh(), { status: 'failed', policy: null, revision: null, fetchedAt: null, error: 'POLICY_FETCH_ORIGIN' });
  // null (not undefined) so the global fetch default is not picked up: no network in tests.
  const noFetch = createPolicyClient({ fetch: null, location: location(ROOT), now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  assert.equal((await noFetch.refresh()).error, 'POLICY_FETCH_NETWORK');
});

test('body limit: exactly 64 KiB accepted, one byte more rejected while reading, Content-Length is not trusted', async () => {
  const exact = serialized(examplePolicy(), { bytes: POLICY_LIMITS.bodyBytes });
  const { client } = harness({ steps: [policyResponse(exact, { chunkSize: 1000 })] });
  assert.equal((await client.start()).status, 'ready');

  const over = serialized(examplePolicy(), { bytes: POLICY_LIMITS.bodyBytes + 1 });
  const padded = serialized(examplePolicy(), { bytes: 4 * POLICY_LIMITS.bodyBytes });
  const source = policySource(padded, { chunkSize: 1000 });
  const big = harness({ steps: [source.response] });
  const snapshot = await big.client.start();
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.error, 'POLICY_TOO_LARGE');
  await settle();
  assert.ok(source.pulled() <= POLICY_LIMITS.bodyBytes + 3000, `stopped reading near the limit, pulled ${source.pulled()}`);

  // A small Content-Length does not excuse an oversized body (browser-shaped
  // object: Node's Response would already choke on the mismatch).
  const lying = harness({ steps: [{ status: 200, headers: new Headers({ 'content-length': '10' }), body: new Response(over).body,
    url: POLICY_URL, redirected: false, type: 'basic' }] });
  assert.equal((await lying.client.start()).error, 'POLICY_TOO_LARGE');
  // A declared oversized body is refused before reading.
  const declared = harness({ steps: [policyResponse(exact, { headers: { 'content-length': String(POLICY_LIMITS.bodyBytes + 1) } })] });
  assert.equal((await declared.client.start()).error, 'POLICY_TOO_LARGE');
  // Responses without a stream body are read whole and bounded the same way.
  const plain = harness({ steps: [(() => {
    const response = { status: 200, headers: new Headers(), body: null, url: POLICY_URL, redirected: false, type: 'basic',
      arrayBuffer: async () => new TextEncoder().encode(serialized(examplePolicy())).buffer };
    return response;
  })()] });
  assert.equal((await plain.client.start()).status, 'ready');
});

test('invalid bodies: malformed JSON, schema issues and invalid UTF-8 surface a code, never the body', async () => {
  const cases = [
    ['not JSON', policyResponse('{ nope'), 'POLICY_SCHEMA'],
    ['array', policyResponse('[]'), 'POLICY_SCHEMA'],
    ['unknown schema', policyResponse(serialized(policyWith((policy) => { policy.schemaVersion = 2; }))), 'POLICY_SCHEMA'],
    ['unknown key', policyResponse(serialized(policyWith((policy) => { policy.apiKey = 'x'; }))), 'POLICY_UNKNOWN_KEY'],
    ['bad text', policyResponse(serialized(policyWith((policy) => { policy.emergency.reason = { ko: 'a' }; }))), 'POLICY_TEXT'],
    ['invalid UTF-8', policyResponse(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), 'POLICY_INVALID'],
    ['empty body', policyResponse(''), 'POLICY_SCHEMA'],
  ];
  for (const [name, reply, code] of cases) {
    const { client } = harness({ steps: [reply] });
    const snapshot = await client.start();
    assert.equal(snapshot.status, 'failed', name);
    assert.equal(snapshot.error, code, name);
    assert.equal(JSON.stringify(snapshot).includes('nope'), false, name);
  }
  // registeredHubIds is forwarded to the validator.
  const hub = serialized(policyWith((policy) => { policy.hubControl = { enabled: true, allowedHubIds: ['venue-main'], allowDirectSubscription: false }; }));
  const rejected = harness({ steps: [policyResponse(hub)], registeredHubIds: [] });
  assert.equal((await rejected.client.start()).error, 'POLICY_REFERENCE');
  const accepted = harness({ steps: [policyResponse(hub)], registeredHubIds: ['venue-main'] });
  assert.equal((await accepted.client.start()).status, 'ready');
});

test('timeout: a reply slower than 5 s fails with POLICY_FETCH_TIMEOUT, aborts the request and is ignored when it finally arrives', async () => {
  const controlled = controlledFetch({ ignoreAbort: true });
  const { client, clock, calls, events } = harness({ transport: controlled });
  const promise = client.start();
  clock.advance(5 * SECOND - 1);
  await settle();
  assert.equal(client.snapshot().status, 'loading');
  clock.advance(1);
  const snapshot = await promise;
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.error, 'POLICY_FETCH_TIMEOUT');
  assert.equal(calls[0].signal.aborted, true, 'the fetch signal is aborted at the deadline');
  // The transport ignored the abort and answers later with a newer policy.
  controlled.release(0, policyResponse(revised(9)));
  await settle();
  assert.equal(client.snapshot().status, 'failed', 'late reply discarded');
  assert.equal(client.snapshot().revision, null);
  assert.deepEqual(events.map((event) => event.status), ['failed']);
  // The next timer refresh recovers.
  clock.advance(MINUTE);
  controlled.release(1, policyResponse(revised(2)));
  await settle();
  assert.equal(client.snapshot().status, 'ready');
  assert.equal(client.snapshot().revision, 2);
});

test('foreground refresh: every 60 s while started; manual refresh re-arms the timer; ticks never overlap', async () => {
  const { client, clock, calls } = await ready();
  assert.equal(calls.length, 1);
  // The request opens in a microtask after the tick, hence settle() after advance().
  clock.advance(MINUTE - 1);
  await settle();
  assert.equal(calls.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(calls.length, 2, 'timer refresh at 60 s');
  clock.advance(MINUTE);
  await settle();
  assert.equal(calls.length, 3);
  clock.advance(30 * SECOND);
  await client.refresh({ reason: 'foreground' });
  assert.equal(calls.length, 4);
  clock.advance(MINUTE - 1);
  await settle();
  assert.equal(calls.length, 4, 'the manual refresh restarted the 60 s cadence');
  clock.advance(1);
  await settle();
  assert.equal(calls.length, 5);
  assert.equal(client.snapshot().status, 'ready');
  assert.equal(client.snapshot().fetchedAt, clock.now());
});

test('a timer tick during an in-flight request joins it instead of opening a second one', async () => {
  const controlled = controlledFetch();
  const { client, clock, calls } = harness({ transport: controlled });
  const first = client.start();
  controlled.release(0, policyResponse());
  await first;
  clock.advance(MINUTE);
  await settle();
  assert.equal(calls.length, 2, 'the tick opened one request');
  clock.advance(4 * SECOND);
  await settle();
  const preflight = client.refresh({ reason: 'preflight' });
  const foreground = client.refresh({ reason: 'foreground' });
  assert.equal(calls.length, 2, 'no overlapping request while one is pending');
  assert.equal(preflight, foreground);
  controlled.release(1, policyResponse(revised(2)));
  assert.equal((await preflight).revision, 2);
  assert.equal(client.snapshot().status, 'ready');
  // The tick cadence is measured from completion, so ticks never overlap a
  // request either: the next one is a full 60 s away.
  assert.ok(clock.pending.includes(MINUTE));
});

test('5 minute validity: temporary failures keep the last policy as stale, then it stops being authority', async () => {
  const failing = (call, index) => (index === 0 ? policyResponse() : new TypeError('offline'));
  const { client, clock, events } = await ready({ steps: failing });
  const original = client.snapshot().policy;
  for (let minute = 1; minute <= 5; minute += 1) {
    clock.advance(MINUTE);
    await settle();
    const snapshot = client.snapshot();
    assert.equal(snapshot.status, 'stale', `minute ${minute}`);
    assert.equal(snapshot.error, 'POLICY_FETCH_NETWORK');
    assert.equal(snapshot.policy, original, 'same frozen policy object while stale');
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.fetchedAt, START);
  }
  clock.advance(1);
  const dropped = client.snapshot();
  assert.equal(dropped.status, 'failed', 'beyond 5 min the policy is no authority');
  assert.equal(dropped.policy, null);
  assert.equal(dropped.revision, 1, 'revision stays for the block banner');
  assert.equal(dropped.error, 'POLICY_FETCH_NETWORK');
  assert.deepEqual(events.map((event) => event.status), ['ready', 'stale', 'failed'], 'age transition notified without a fetch');
  assert.equal(events.at(-1), dropped);
});

test('5 minute validity: a stopped client (no refresh) also loses authority by age, reported as POLICY_STALE', async () => {
  const { client, clock, events } = await ready();
  client.stop();
  clock.advance(5 * MINUTE);
  assert.equal(client.snapshot().status, 'ready', 'still inside the window');
  clock.advance(1);
  const snapshot = client.snapshot();
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.policy, null);
  assert.equal(snapshot.error, 'POLICY_STALE');
  // Listeners were not notified while stopped (timers released) but the next
  // notification is emitted from the state they last saw.
  assert.deepEqual(events.map((event) => event.status), ['ready']);
  await client.start();
  assert.equal(client.snapshot().status, 'ready');
  assert.deepEqual(events.map((event) => event.status), ['ready', 'ready']);
  assert.equal(events[1].fetchedAt, clock.now());
});

test('validUntil: the policy expires at the exact instant, is retained, and expiry is notified by timer', async () => {
  const until = new Date(START + 2 * MINUTE).toISOString().replace('.000Z', 'Z');
  const body = revised(3, (policy) => { policy.validUntil = until; });
  const { client, clock, events } = await ready({ steps: () => policyResponse(body) });
  await tickMinutes(clock, 1);
  clock.advance(MINUTE - 1);
  await settle();
  assert.equal(client.snapshot().status, 'ready');
  clock.advance(1);
  const snapshot = client.snapshot();
  assert.equal(snapshot.status, 'expired');
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.policy.validUntil, until, 'policy retained so the block reason is specific');
  assert.deepEqual(events.map((event) => event.status), ['ready', 'ready', 'expired']);
  // Re-validating the same expired document keeps it expired, not stale or failed.
  await tickMinutes(clock, 3);
  assert.equal(client.snapshot().status, 'expired');
  assert.equal(client.snapshot().fetchedAt, clock.now());
  // Age still wins over expiry once the policy is too old to be authority.
  client.stop();
  clock.advance(6 * MINUTE);
  assert.equal(client.snapshot().status, 'failed');
});

test('revision rules: same revision with other content conflicts, lower revision is a rollback, higher is applied', async () => {
  const bodies = [
    revised(5),
    revised(5, (policy) => { policy.features.diagnostics = false; }),
    revised(4),
    revised(5),
    revised(6, (policy) => { policy.features.diagnostics = false; }),
  ];
  const { client, clock, events } = await ready({ steps: bodies.map((body) => policyResponse(body)) });
  const first = client.snapshot().policy;
  assert.equal(first.revision, 5);

  clock.advance(MINUTE);
  await settle();
  let snapshot = client.snapshot();
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.error, 'POLICY_REVISION_CONFLICT');
  assert.equal(snapshot.policy, first, 'conflicting content never replaces the accepted policy');
  assert.equal(snapshot.fetchedAt, START);

  clock.advance(MINUTE);
  await settle();
  snapshot = client.snapshot();
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.error, 'POLICY_REVISION_ROLLBACK');
  assert.equal(snapshot.policy, first);

  clock.advance(MINUTE);
  await settle();
  snapshot = client.snapshot();
  assert.equal(snapshot.status, 'ready', 'identical content is a successful re-validation');
  assert.equal(snapshot.policy, first, 'same object reference for identical content');
  assert.equal(snapshot.fetchedAt, START + 3 * MINUTE);

  clock.advance(MINUTE);
  await settle();
  snapshot = client.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.revision, 6);
  assert.notEqual(snapshot.policy, first);
  assert.equal(snapshot.policy.features.diagnostics, false);
  assert.deepEqual(events.map((event) => [event.status, event.error]),
    [['ready', null], ['stale', 'POLICY_REVISION_CONFLICT'], ['stale', 'POLICY_REVISION_ROLLBACK'], ['ready', null], ['ready', null]]);
});

test('revision rules survive loss of authority: a rollback is still refused after the policy aged out', async () => {
  const steps = [policyResponse(revised(5)), new TypeError('offline'), new TypeError('offline'), new TypeError('offline'),
    new TypeError('offline'), new TypeError('offline'), policyResponse(revised(4)), policyResponse(revised(5))];
  const { client, clock } = await ready({ steps });
  await tickMinutes(clock, 5);
  clock.advance(1);
  assert.equal(client.snapshot().status, 'failed');
  clock.advance(MINUTE);
  await settle();
  assert.equal(client.snapshot().status, 'failed');
  assert.equal(client.snapshot().error, 'POLICY_REVISION_ROLLBACK');
  assert.equal(client.snapshot().revision, 5);
  clock.advance(MINUTE);
  await settle();
  assert.equal(client.snapshot().status, 'ready');
  assert.equal(client.snapshot().revision, 5);
});

test('late replies: stop() discards the in-flight reply even when the transport ignores the abort', async () => {
  const controlled = controlledFetch({ ignoreAbort: true });
  const { client, clock, calls, events } = harness({ transport: controlled });
  const pending = client.start();
  client.stop();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(clock.size, 0);
  controlled.release(0, policyResponse(revised(9)));
  const snapshot = await pending;
  assert.equal(snapshot.status, 'loading', 'the cancelled request resolves with the unchanged snapshot');
  assert.equal(client.snapshot().policy, null);
  assert.deepEqual(events, []);
});

test('late replies: a reply from before stop()/start() cannot overwrite the newer policy, even with a higher revision', async () => {
  const controlled = controlledFetch({ ignoreAbort: true });
  const { client, events } = harness({ transport: controlled });
  const old = client.start();
  client.stop();
  const fresh = client.start();
  assert.notEqual(old, fresh);
  controlled.release(1, policyResponse(revised(2)));
  assert.equal((await fresh).revision, 2);
  controlled.release(0, policyResponse(revised(7)));
  await old;
  await settle();
  assert.equal(client.snapshot().revision, 2, 'stale generation discarded although its revision is higher');
  assert.equal(client.snapshot().status, 'ready');
  assert.deepEqual(events.map((event) => event.revision), [2]);
});

test('subscribe: a re-validation with new fetchedAt is delivered, snapshot() never emits, unsubscribe and listener errors are contained', async () => {
  const { client, clock, events } = await ready();
  client.subscribe(() => { throw new Error('consumer'); });
  const seen = [];
  const unsubscribe = client.subscribe((snapshot) => seen.push(snapshot.status));
  clock.advance(MINUTE);
  await settle();
  assert.equal(events.length, 2, 'fetchedAt moved, so the snapshot changed');
  assert.equal(events[1].policy, events[0].policy, 'identical content keeps the same policy object');
  assert.deepEqual(seen, ['ready'], 'delivered despite the throwing listener before it');
  const before = events.length;
  client.snapshot(); client.snapshot();
  assert.equal(events.length, before, 'snapshot() itself never emits');
  unsubscribe();
  clock.advance(MINUTE);
  await settle();
  assert.deepEqual(seen, ['ready']);
  assert.equal(events.length, before + 1);
});

test('memory only: the accepted policy is the frozen validator output and cannot be mutated through the snapshot', async () => {
  const { client } = await ready();
  assertDeepFrozen(client.snapshot().policy, 'policy');
  assert.throws(() => { client.snapshot().policy.features.sequential = false; }, TypeError);
  assert.throws(() => { client.snapshot().status = 'ready'; }, TypeError);
});

test('i18n: every client status has policy.status.<status> in all three languages', async () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const dictionary = JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'));
    for (const status of POLICY_STATUSES) assert.equal(typeof dictionary[`policy.status.${status}`], 'string', `${language} ${status}`);
  }
});

test('trilingual fixture helper keeps the three languages the validator expects', () => {
  assert.deepEqual(Object.keys(trilingual('x')), ['ko', 'en', 'ja']);
});
