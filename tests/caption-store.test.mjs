import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { SegmentAssembler } from '../app/engine/segment-assembler.js';

const direct = (patch = {}) => ({ id: 'one', sessionId: 's', generation: 0, role: 'translation',
  sequence: 1, revision: 1, translatedText: 'Hello', status: 'partial', receivedAt: 10, finalizedAt: null, ...patch });
const hub = (patch = {}) => ({ epoch: 0, lang: 'ja', segmentId: 'one', seq: 1,
  revision: 1, text: 'こんにちは', final: false, ...patch });
const store = () => createCaptionStore({ sessionId: 's', now: () => 20 });

test('assembler events upsert one row and corrections never reopen or repeat final', () => {
  const s = store(); const results = [];
  const clock = { now: () => 10, setTimeout: () => 1, clearTimeout() {} };
  const asm = new SegmentAssembler({ sessionId: 's', generation: 0, role: 'translation', clock,
    onSegment: (segment) => results.push(s.upsertDirect(segment)) });
  asm.push({ text: 'Hello', mode: 'delta' });
  asm.push({ text: ' world', mode: 'delta' }); asm.flush();
  const id = s.snapshot().captions[0].segmentId;
  asm.revise(id, { text: 'Corrected', revision: 10 });
  assert.equal(s.snapshot().captions.length, 1);
  assert.deepEqual(results.map((r) => r.newFinal), [false, false, true, false]);
  const row = s.snapshot().captions[0];
  s.upsertDirect(direct({ id, revision: 11, translatedText: 'New snapshot' }));
  assert.equal(s.snapshot().captions[0].status, 'final');
  assert.equal(s.snapshot().captions[0].finalizedAt, row.finalizedAt);
  assert.equal(s.snapshot().captions[0].translatedText, 'New snapshot');
  asm.cancel();
});
test('stale revisions and duplicate finals do not overwrite text or replay', () => {
  const s = store();
  assert.equal(s.upsertHub(hub({ final: true, revision: 3 })).newFinal, true);
  for (const revision of [1, 2, 3]) assert.equal(s.upsertHub(hub({ revision, final: true, text: 'stale' })).applied, false);
  assert.equal(s.upsertHub(hub({ revision: 4, seq: 8, final: false, text: 'corrected' })).newFinal, false);
  assert.equal(s.snapshot().captions[0].status, 'final');
  assert.equal(s.snapshot().captions[0].translatedText, 'corrected');
  assert.equal(s.snapshot().metrics.duplicates, 3);
});
test('direct roles and connection generations have independent IDs and counters', () => {
  const s = store(); s.upsertDirect(direct());
  s.upsertDirect(direct({ role: 'source', sourceText: 'Source' }));
  assert.equal(s.snapshot().captions.length, 2);
  s.setGeneration(1);
  assert.ok(s.snapshot().captions.every((r) => r.status === 'interrupted'));
  assert.equal(s.upsertDirect(direct({ revision: 9 })).applied, false);
  s.upsertDirect(direct({ generation: 1 }));
  assert.equal(s.snapshot().captions.length, 3);
  assert.equal(new Set(s.snapshot().captions.map((r) => r.id)).size, 3);
});
test('hub languages and epochs separate IDs; remote seq never becomes local sequence or a gap', () => {
  const s = store();
  s.upsertHub(hub({ seq: 100, final: true }));
  s.upsertHub(hub({ lang: 'en', seq: 101, final: true }));
  s.upsertHub(hub({ segmentId: 'two', seq: 130, final: true }));
  assert.deepEqual(s.snapshot().captions.map((r) => r.sequence), [1, 2, 3]);
  assert.deepEqual(s.snapshot().captions.map((r) => r.remoteSeq), [100, 101, 130]);
  assert.equal(s.snapshot().gaps.reception, false);
  assert.equal(s.upsertHub(hub({ seq: 100, final: true })).newFinal, false);
  s.resetEpoch(1);
  assert.equal(s.upsertHub(hub()).applied, false);
  assert.equal(s.upsertHub(hub({ epoch: 1, final: true })).newFinal, true);
  assert.equal(s.snapshot().captions.length, 1);
});
test('100 terminal rows plus bounded active partials; evicted replay is suppressed', () => {
  const s = store();
  for (let i = 1; i <= 150; i++) s.upsertHub(hub({ segmentId: String(i), seq: i, final: true }));
  s.upsertHub(hub({ segmentId: 'active', seq: 151 }));
  s.upsertHub(hub({ segmentId: 'source', lang: 'src', seq: 152 }));
  assert.equal(s.snapshot().captions.length, 102);
  assert.equal(s.snapshot().captions[0].segmentId, '51');
  assert.equal(s.upsertHub(hub({ segmentId: '1', seq: 1, final: true })).applied, false);
  for (let i = 153; i < 400; i++) s.upsertHub(hub({ segmentId: String(i), seq: i }));
  assert.equal(s.snapshot().captions.length, 102);
  s.interrupt(); s.interrupt();
  assert.equal(s.snapshot().captions.length, 100);
  assert.ok(s.snapshot().captions.every((r) => r.status !== 'partial'));
});
test('input, audio and reception gaps are separate and never alter translation', () => {
  const s = store(); s.upsertDirect(direct({ status: 'final', finalizedAt: 12 }));
  const row = s.snapshot().captions[0];
  s.markGap('audio');
  assert.deepEqual(s.snapshot().gaps, { input: false, audio: true, reception: false });
  s.markGap('input'); s.markGap('reception');
  assert.equal(s.snapshot().captions[0], row);
  assert.deepEqual(s.snapshot().gaps, { input: true, audio: true, reception: true });
  assert.throws(() => s.markGap('raw detail'), { code: 'INVALID_REQUEST' });
});
test('snapshots retain only allowed data, are immutable and dispose subscriptions', () => {
  const s = store(); let count = 0;
  s.subscribe(() => { throw Error('consumer'); });
  const off = s.subscribe(() => count++);
  const result = s.upsertHub(hub({ detail: 'private', key: 'private', ts: 999999999 }));
  assert.ok(!JSON.stringify(s.snapshot()).includes('private'));
  assert.ok(!JSON.stringify(s.snapshot()).includes('999999999'));
  assert.throws(() => { result.caption.translatedText = 'mutated'; }, TypeError);
  off(); s.close(); s.close();
  assert.equal(count, 1); assert.equal(s.snapshot().captions.length, 0);
  assert.throws(() => s.upsertHub(hub()), { code: 'SESSION_CLOSED' });
});
test('malformed input is rejected without echoing payloads', () => {
  const s = store();
  for (const patch of [{ seq: NaN }, { seq: -1 }, { revision: 1.5 }, { lang: 'xx' }, { final: 'true' }, { text: null }]) {
    assert.throws(() => s.upsertHub(hub(patch)), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => s.upsertDirect(direct({ processing: { live: { providerId: 'gemini', model: 'https://private' } } })),
    (e) => e.code === 'INVALID_REQUEST' && !JSON.stringify(e).includes('private'));
  assert.equal(s.snapshot().captions.length, 0);
});
