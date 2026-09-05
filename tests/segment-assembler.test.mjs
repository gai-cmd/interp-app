import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentAssembler } from '../app/engine/segment-assembler.js';
import { fakeClock, sentences } from './fixtures/segments.mjs';

function setup(options = {}) {
  const clock = fakeClock(), events = [];
  const asm = new SegmentAssembler({ sessionId: 'session', generation: 2, role: 'translation',
    clock, onSegment: (s) => events.push(s), ...options });
  return { asm, clock, events, push: (text, extra = {}) => asm.push({ text, mode: 'delta', ...extra }) };
}
for (const [index, fixture] of sentences.entries()) test(`sentence boundaries ${index}`, () => {
  const { asm, clock, events, push } = setup();
  fixture.chunks.forEach((text) => push(text));
  asm.turnComplete();
  assert.deepEqual(events.filter((s) => s.status === 'final').map((s) => s.translatedText), fixture.expected);
  assert.equal(clock.size, 0);
});
test('silence is 1500ms from last transcription; stale timer cannot flush', () => {
  const { clock, events, push } = setup();
  push('one'); const [stale] = clock.callbacks();
  clock.tick(1000); push(' two'); stale();
  clock.tick(1499); assert.equal(events.at(-1).status, 'partial');
  clock.tick(1);
  assert.deepEqual(events.map((s) => s.revision), [1, 2, 3]);
  assert.equal(new Set(events.map((s) => s.id)).size, 1);
  assert.equal(events.at(-1).receivedAt, 0);
  assert.equal(events.at(-1).finalizedAt, 2500);
  assert.equal(clock.size, 0);
});
test('snapshots replace active text including deletion', () => {
  const { asm, events, clock, push } = setup();
  push('wrong'); push('right', { mode: 'snapshot' });
  assert.equal(events.at(-1).translatedText, 'right');
  push('', { mode: 'snapshot' });
  assert.equal(events.at(-1).translatedText, '');
  asm.flush(); assert.equal(events.at(-1).status, 'final');
  assert.equal(clock.size, 0);
});
test('length bound splits large packets at grapheme boundaries', () => {
  const { asm, events, push, clock } = setup({ maxChars: 3 });
  const text = '가👨‍👩‍👧‍👦e\u0301🇯🇵나다라마바사';
  push(text); asm.flush();
  const finals = events.filter((s) => s.status === 'final');
  assert.equal(finals.map((s) => s.translatedText).join(''), text);
  assert.ok(finals.every((s) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s.translatedText)].length <= 3));
  assert.equal(clock.size, 0);
});
test('roles and generations have independent counters and collision-free IDs', () => {
  const source = setup({ role: 'source' }), translation = setup(), next = setup({ generation: 3 });
  source.push('하나。둘。'); translation.push('one!'); next.push('one!');
  assert.deepEqual(source.events.map((s) => s.sequence), [1, 2]);
  assert.equal(translation.events[0].sequence, 1);
  assert.equal(source.events[0].sourceText, '하나。');
  assert.equal(new Set([...source.events, ...translation.events, ...next.events].map((s) => s.id)).size, 4);
});
test('finished, turnComplete and flush are idempotent without empty segments', () => {
  const { asm, push, events, clock } = setup();
  push('done', { finished: true }); asm.turnComplete(); asm.flush();
  assert.equal(events.length, 1); assert.equal(events[0].status, 'final');
  assert.equal(clock.size, 0);
});
test('interrupt preserves unfinished status and allows a new segment', () => {
  const { asm, push, events, clock } = setup({ gapBefore: true });
  push('unfinished'); asm.interrupt(); asm.interrupt();
  assert.equal(events.at(-1).status, 'interrupted');
  assert.equal(clock.size, 0);
  push('new', { finished: true });
  assert.equal(events.at(-1).sequence, 2);
  assert.equal(events[0].gapBefore, true); assert.equal(events.at(-1).gapBefore, false);
});
test('cancel clears timers and rejects all late work including queued callbacks', () => {
  const { asm, push, events, clock } = setup();
  push('unfinished'); const [late] = clock.callbacks();
  asm.cancel(); asm.cancel(); late(); push('late'); asm.flush(); asm.interrupt(); clock.tick(5000);
  assert.deepEqual(events.map((s) => s.status), ['partial', 'interrupted']);
  assert.equal(clock.size, 0);
  assert.equal(asm.revise(events[0].id, { text: 'late', revision: 9 }), false);
});
test('higher terminal revisions correct the same row without returning to partial', () => {
  const { asm, push, events } = setup();
  push('old', { finished: true }); const old = events[0];
  assert.equal(asm.revise(old.id, { text: 'new', revision: 2 }), true);
  assert.equal(asm.revise(old.id, { text: 'stale', revision: 1 }), false);
  assert.equal(asm.revise(old.id, { text: 'duplicate', revision: 2 }), false);
  assert.equal(events.length, 2); assert.equal(events[1].status, 'final');
  assert.equal(events[1].id, old.id); assert.equal(events[1].finalizedAt, old.finalizedAt);
  assert.equal(old.translatedText, 'old'); assert.ok(Object.isFrozen(events[1]));
});
test('terminal correction cache retains at most 100 segments', () => {
  const { asm, push, events } = setup();
  for (let i = 0; i < 101; i++) push('same!', { finished: true });
  assert.equal(asm.revise(events[0].id, { text: 'new', revision: 2 }), false);
  assert.equal(asm.revise(events[1].id, { text: 'new', revision: 2 }), true);
});
test('invalid arguments produce only a safe existing error code', () => {
  const { asm, clock } = setup();
  assert.throws(() => asm.push({ text: 'private-content', mode: 'private-mode' }), (e) => {
    assert.equal(e.code, 'INVALID_REQUEST'); assert.ok(!JSON.stringify(e).includes('private')); return true;
  });
  assert.equal(clock.size, 0);
});
test('consumer cancellation during emission leaves no tail or timer', () => {
  const events = [], clock = fakeClock();
  let asm;
  asm = new SegmentAssembler({ sessionId: 's', generation: 0, role: 'source', clock,
    onSegment(s) { events.push(s); asm.cancel(); } });
  asm.push({ text: 'first! second!', mode: 'delta' });
  assert.equal(events.length, 2);
  assert.equal(events[1].status, 'interrupted');
  assert.equal(clock.size, 0);
});

test('graphemes extending across packets are not cut at the length boundary', () => {
  const { asm, events, push, clock } = setup({ maxChars: 1 });
  push('e'); push('\u0301'); push('\ud83d'); push('\ude00'); asm.flush();
  assert.deepEqual(events.filter((s) => s.status === 'final').map((s) => s.translatedText), ['e\u0301', '😀']);
  assert.equal(clock.size, 0);
});
test('correction preserves interrupted status and silence callback is invalidated', () => {
  const { asm, events, push, clock } = setup();
  push('part'); const [late] = clock.callbacks(); asm.interrupt();
  assert.equal(asm.revise(events[0].id, { text: 'corrected', revision: 3 }), true);
  late(); assert.equal(events.at(-1).status, 'interrupted');
  assert.equal(events.length, 3); assert.equal(clock.size, 0);
});
