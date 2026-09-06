// P3-34: the shared-event key payload generator (§1.7 step 8). Separate from
// the policy draft on purpose: the policy is a public document and must never
// carry a key, and this is not the P2-25 site QR either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GENERATED_VERSION, activeEvents, buildSharedPayload,
  createSharedPayloadTool } from '../app/admin/shared-payload.js';
import { MAX_FRAGMENT_LENGTH, parseSharedFragment } from '../app/security/shared-key.js';
import { createRegistry } from '../app/providers/registry.js';
import { registerGemini } from '../app/providers/gemini/index.js';
import { createPolicyEditor } from '../app/admin/policy-editor.js';
import { createPolicyExport } from '../app/admin/export.js';
import { policyWith } from './fixtures/policy.mjs';

const KEY = 'ADMIN-SHARED-SECRET-KEY';
const NOW = Date.parse('2026-09-06T01:00:00Z');
const withEvents = () => policyWith((policy) => {
  policy.features.sharedKeys = true;
  policy.sharedEvents = [
    { id: 'service-20260906', providerId: 'gemini', eventName: 'Service', label: null,
      startsAt: '2026-09-06T00:00:00Z', expiresAt: '2026-09-06T03:00:00Z', enabled: true, allowedCapabilities: null },
    { id: 'service-past', providerId: 'gemini', eventName: 'Past', label: null,
      startsAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-01T03:00:00Z', enabled: true, allowedCapabilities: null },
    { id: 'service-off', providerId: 'gemini', eventName: 'Off', label: null,
      startsAt: '2026-09-06T00:00:00Z', expiresAt: '2026-09-06T03:00:00Z', enabled: false, allowedCapabilities: null },
  ];
});
function realRegistry() {
  const registry = createRegistry();
  registerGemini(registry, { resolveCredential: async () => 'unused' });
  return registry;
}

test('only an active, unexpired, enabled event can be named', () => {
  const events = activeEvents(withEvents(), { now: NOW });
  assert.deepEqual(events.map((event) => event.id), ['service-20260906'],
    'a past event and a disabled one are not offered');
  assert.deepEqual(activeEvents(null, { now: NOW }), []);
  for (const eventId of ['service-past', 'service-off', 'nope', undefined]) {
    assert.deepEqual(buildSharedPayload({ policy: withEvents(), eventId, key: KEY, now: NOW }),
      { ok: false, error: 'event' }, String(eventId));
  }
});

test('a generated v2 payload round-trips through the app\'s own parser', () => {
  const built = buildSharedPayload({ policy: withEvents(), eventId: 'service-20260906', key: KEY,
    now: NOW, registry: realRegistry() });
  assert.equal(built.ok, true);
  assert.equal(built.payload.version, GENERATED_VERSION);
  assert.equal(GENERATED_VERSION, 2);
  // Every field comes from the deployed policy, so the app will recognise it.
  assert.equal(built.payload.eventId, 'service-20260906');
  assert.equal(built.payload.providerId, 'gemini');
  assert.equal(built.payload.eventName, 'Service');
  // The policy states an ISO datetime; the payload format carries epoch ms.
  assert.equal(built.payload.expiresAt, Date.parse('2026-09-06T03:00:00Z'));
  assert.equal(built.roundTrips, true);

  const parsed = parseSharedFragment(built.fragment, { registry: realRegistry(), now: () => NOW });
  assert.equal(parsed.version, 2);
  assert.equal(parsed.eventId, 'service-20260906');
  assert.equal(parsed.key, KEY);
  assert.ok(built.fragment.startsWith('#shared='), 'the existing fragment format is kept');
});

test('a missing key, a missing expiry and an over-long fragment are refused', () => {
  const policy = withEvents();
  assert.deepEqual(buildSharedPayload({ policy, eventId: 'service-20260906', key: '', now: NOW }),
    { ok: false, error: 'key' });
  assert.deepEqual(buildSharedPayload({ policy, eventId: 'service-20260906', key: '   ', now: NOW }),
    { ok: false, error: 'key' });
  const noExpiry = policyWith((p) => {
    p.features.sharedKeys = true;
    p.sharedEvents = [{ ...policy.sharedEvents[0], expiresAt: null }];
  });
  assert.deepEqual(buildSharedPayload({ policy: noExpiry, eventId: 'service-20260906', key: KEY, now: NOW }),
    { ok: false, error: 'expiry' });
  // The length cap of the existing format is kept.
  const long = buildSharedPayload({ policy, eventId: 'service-20260906', key: 'x'.repeat(MAX_FRAGMENT_LENGTH), now: NOW });
  assert.deepEqual(long, { ok: false, error: 'tooLong' });
});

test('the key stays in memory, is handed over only on an explicit copy, and is cleared on close', async () => {
  const written = [];
  const tool = createSharedPayloadTool({ policy: withEvents(), now: () => NOW, registry: realRegistry(),
    navigator: { clipboard: { writeText: async (text) => written.push(text) } } });
  assert.deepEqual(tool.events().map((event) => event.id), ['service-20260906']);
  assert.equal(tool.fragment, null);
  assert.deepEqual(await tool.copy(), { result: 'blocked' }, 'nothing to copy before generating');

  const result = tool.generate({ eventId: 'service-20260906', key: KEY });
  assert.equal(result.ok, true);
  // The generate() result reports a length and the metadata, never the key.
  assert.equal(JSON.stringify(result).includes(KEY), false, 'the key is not echoed back');
  assert.equal(written.length, 0, 'generating does not copy');

  assert.deepEqual(await tool.copy(), { result: 'copied' });
  assert.equal(written[0].includes(KEY), true, 'the copy is the one place the key travels');
  tool.close();
  assert.equal(tool.fragment, null, 'closing forgets the key-bearing fragment');
  assert.deepEqual(await tool.copy(), { result: 'blocked' });
});

test('a clipboard failure offers the text instead of losing the work', async () => {
  const tool = createSharedPayloadTool({ policy: withEvents(), now: () => NOW, navigator: {} });
  tool.generate({ eventId: 'service-20260906', key: KEY });
  const result = await tool.copy();
  assert.equal(result.result, 'manual');
  assert.ok(result.text.startsWith('#shared='));
});

test('the key never reaches the policy draft or its export', async () => {
  const editor = createPolicyEditor({ deployed: withEvents() });
  const tool = createSharedPayloadTool({ policy: withEvents(), now: () => NOW });
  tool.generate({ eventId: 'service-20260906', key: KEY });
  editor.bumpRevision();
  const exporter = createPolicyExport({ editor, navigator: {} });
  assert.equal(exporter.text().includes(KEY), false, 'the export carries no key');
  assert.equal(JSON.stringify(editor.snapshot()).includes(KEY), false, 'the draft carries no key');

  // The generator is a separate module from the editor and its export.
  const source = await readFile(new URL('../app/admin/shared-payload.js', import.meta.url), 'utf8');
  assert.equal(source.includes('policy-editor.js'), false, 'the generator does not touch the draft');
  assert.equal(source.includes('export.js'), false);
  // And it is not the site QR: no QR generation, no navigation.
  assert.equal(/qr|QR/.test(source.replace(/\/\/.*$/gm, '')), false, 'no QR image generation here');
  assert.equal(/location\s*[=.]|window\.open/.test(source), false, 'nothing navigates on its own');
});
