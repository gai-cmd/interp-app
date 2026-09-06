import { createPolicyClient } from './app/policy/client.js';
import { POLICY_LIMITS } from './app/policy/schema.js';
import { examplePolicy, policyWith, serialized } from './tests/fixtures/policy.mjs';
import { ROOT, START, POLICY_URL, createClock, location, policyResponse, policySource, scriptedFetch, settle } from './tests/fixtures/policy-fetch.mjs';
const MINUTE = 60000;
async function run(name, steps, after) {
  const clock = createClock();
  const s = scriptedFetch(steps);
  const c = createPolicyClient({ fetch: s.fetch, location: location(ROOT), now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  console.log(name, 'start', (await c.start()).error, c.snapshot().status);
  if (after) await after(c, clock);
}
const over = serialized(examplePolicy(), { bytes: POLICY_LIMITS.bodyBytes + 1 });
const padded = serialized(examplePolicy(), { bytes: 4 * POLICY_LIMITS.bodyBytes });
const src = policySource(padded, { chunkSize: 1000 });
await run('big', [src.response]);
console.log('pulled', src.pulled());
await run('lying', [{ status: 200, headers: new Headers({ 'content-length': '10' }), body: new Response(over).body, url: POLICY_URL, redirected: false, type: 'basic' }]);
const until = new Date(START + 2 * MINUTE).toISOString().replace('.000Z', 'Z');
const body = serialized(policyWith((p) => { p.revision = 3; p.validUntil = until; }));
await run('validUntil', () => policyResponse(body), async (c, clock) => {
  clock.advance(MINUTE); await settle(); console.log('min1', c.snapshot().status, c.snapshot().error);
});
try {
  const r = new Response(over).body.getReader(); let t = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; t += value.byteLength; }
  console.log('plain read ok', t);
} catch (e) { console.log('plain read err', e.message); }
