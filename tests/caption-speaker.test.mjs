import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionSpeaker } from '../app/audio/caption-speaker.js';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { createSpeechFixture, voices, flush } from './fixtures/speech.mjs';

function setup(options = {}) {
  const f = createSpeechFixture();
  const states = [], drops = [];
  const store = createCaptionStore({ sessionId: 'test', epoch: 1, ...f.clock });
  const speaker = createCaptionSpeaker({ deviceTTS: f.deviceTTS, epoch: 1, ...f.clock,
    onState: s => states.push(s), onDrop: d => drops.push(d), ...options });
  let seq = 0;
  function update(id, extra = {}) {
    return store.upsertHub({ epoch: 1, lang: 'ja', segmentId: String(id), seq: ++seq,
      revision: 1, final: true, text: `sentence ${id}`, ...extra });
  }
  return { ...f, states, drops, speaker, store, update,
    send(id, extra, context) { return speaker.enqueue(update(id, extra), context); } };
}

test('only new selected final translations speak, serially, without revision rereads', async () => {
  const f = setup({ muted: false });
  f.send('partial', { final: false }); f.send('source', { lang: 'src' }); f.send('other', { lang: 'en' });
  const first = f.update('a'); assert.equal(f.speaker.enqueue(first), true);
  assert.equal(f.speaker.enqueue(first), false);
  f.send('a', { revision: 2, text: 'corrected' });
  f.send('b'); f.send('b', { revision: 3 }); f.send('c', { final: false });
  assert.equal(f.synth.spoken.length, 1); assert.equal(f.speaker.snapshot().waiting, 1);
  f.synth.end(); await flush(); assert.equal(f.synth.spoken.length, 2);
  f.synth.end(); await flush();
  f.send('a', { revision: 4 });
  assert.equal(f.synth.spoken.length, 2); assert.equal(f.speaker.snapshot().completed, 2);
  assert.equal(f.timers.size, 0); f.speaker.close();
});

test('default mute, replay and stale epoch never cause historical speech, even after eviction', async () => {
  const f = setup(); const old = f.update('old'); f.speaker.enqueue(old);
  f.speaker.setMuted(false); assert.equal(f.speaker.enqueue(old), false);
  f.send('replay', {}, { replay: true });
  assert.equal(f.speaker.enqueue({ ...old, caption: { ...old.caption, epoch: 0, order: 999 } }), false);
  for (let i = 0; i < 130; i++) f.send(i, {}, { replay: true });
  assert.equal(f.speaker.enqueue(old), false); f.send('old', { revision: 10 });
  assert.equal(f.synth.spoken.length, 0);
  f.send('fresh'); assert.equal(f.synth.spoken.length, 1); f.speaker.close();
});

test('waiting queue is capped at 20 and overflow discards oldest whole sentence', async () => {
  const f = setup({ muted: false });
  for (let i = 0; i < 26; i++) f.send(i);
  assert.equal(f.synth.spoken.length, 1); assert.equal(f.speaker.snapshot().waiting, 20);
  assert.equal(f.speaker.snapshot().skipped, 5); assert.equal(f.speaker.snapshot().state, 'catching-up');
  f.synth.end(); await flush(); assert.equal(f.synth.spoken[1].text, 'sentence 6');
  assert.equal(f.speaker.snapshot().maxWaiting, 20); f.speaker.close(); assert.equal(f.timers.size, 0);
});

test('timer warns at 3 seconds and skips only waits exceeding 8 seconds, retaining fresh speech', async () => {
  const f = setup({ muted: false }); f.send('active'); f.send('old');
  await f.advance(2999); assert.equal(f.speaker.snapshot().state, 'ready');
  await f.advance(1); assert.equal(f.states.at(-1).state, 'delayed');
  await f.advance(4000); f.send('fresh');
  await f.advance(1000); assert.equal(f.speaker.snapshot().waiting, 2);
  await f.advance(1); assert.equal(f.speaker.snapshot().waiting, 1);
  assert.equal(f.speaker.snapshot().skipped, 1); assert.equal(f.states.at(-1).state, 'catching-up');
  f.synth.end(); await flush(); assert.equal(f.synth.spoken[1].text, 'sentence fresh');
  assert.equal(f.speaker.snapshot().maxWaitMs, 1001); f.speaker.close();
});

test('mute and language change abort active output and fence late completions', async () => {
  const f = setup({ muted: false }); f.send('a'); f.send('b');
  const late = f.synth.spoken[0].onend;
  f.speaker.setMuted(true); late(); await flush(); f.send('muted');
  assert.equal(f.speaker.snapshot().waiting, 0); assert.equal(f.timers.size, 0);
  f.speaker.setMuted(false); f.send('c');
  f.speaker.setLanguage('en'); await flush();
  assert.equal(f.speaker.snapshot().state, 'muted');
  f.speaker.setMuted(false); f.send('d', { lang: 'en' });
  assert.equal(f.synth.spoken.at(-1).lang, 'en');
  assert.equal(f.speaker.snapshot().completed, 0); f.speaker.close(); f.speaker.close();
  assert.equal(f.speaker.enqueue(f.update('late')), false); assert.equal(f.timers.size, 0);
});

for (const mode of ['empty', 'wrong-language', 'query-throws', 'error', 'no-end']) {
  test(`device TTS ${mode} settles and clears output without affecting caption reception`, async () => {
    const f = setup({ muted: false });
    if (mode === 'empty') f.synth.voices = [];
    if (mode === 'wrong-language') f.synth.voices = [voices[2]];
    if (mode === 'query-throws') f.synth.getVoices = () => { throw Error('SECRET'); };
    f.send('a'); f.send('b');
    if (mode === 'error') f.synth.spoken[0].onerror({ error: 'SECRET' });
    await f.advance(mode === 'no-end' ? 120000 : 1500);
    assert.equal(f.speaker.snapshot().state, 'unavailable');
    assert.equal(f.speaker.snapshot().failures, 1); assert.equal(f.speaker.snapshot().waiting, 0);
    assert.equal(f.timers.size, 0); assert.equal(f.synth.listeners.size, 0);
    f.send('still-receiving'); assert.equal(f.store.snapshot().captions.length, 3);
    assert.ok(!JSON.stringify(f.speaker.snapshot()).includes('SECRET'));
    assert.ok(!JSON.stringify(f.states).includes('sentence'));
    f.synth.getVoices = () => voices; f.speaker.setMuted(false); f.send('resume');
    f.synth.end(); await flush(); assert.equal(f.speaker.snapshot().completed, 1);
    f.speaker.close();
  });
}

test('delayed voiceschanged serializes loading and cancellation removes listeners', async () => {
  const f = setup({ muted: false }); f.synth.voices = [];
  f.send('a'); f.send('b'); await f.advance(1000);
  assert.equal(f.synth.spoken.length, 0); assert.equal(f.synth.listeners.size, 1);
  f.synth.changeVoices(voices); assert.equal(f.synth.spoken.length, 1);
  f.synth.end(); await flush(); assert.equal(f.synth.spoken.length, 2); f.speaker.close();
  const g = setup({ muted: false }); g.synth.voices = []; g.send('a'); g.speaker.close();
  g.synth.changeVoices(voices); await g.advance(120000);
  assert.equal(g.synth.spoken.length, 0); assert.equal(g.synth.listeners.size, 0); assert.equal(g.timers.size, 0);
});

test('injected throws and rejected promises are sanitized and observers cannot break cleanup', async () => {
  for (const speak of [() => { throw Error('SECRET'); }, () => Promise.reject(Error('SECRET'))]) {
    const f = setup({ muted: false, deviceTTS: { speak, cancel() {} }, onState() { throw Error('observer'); } });
    f.send('a'); await flush();
    assert.equal(f.speaker.snapshot().messageKey, 'error.VOICE_FAILED');
    assert.equal(f.speaker.snapshot().failures, 1); f.speaker.close();
  }
});

test('abort is terminal and never closes the shared device TTS', async () => {
  const controller = new AbortController(); const f = setup({ muted: false, signal: controller.signal });
  f.send('a'); controller.abort('SECRET'); await flush();
  assert.equal(f.speaker.snapshot().terminal, true); assert.equal(f.timers.size, 0);
  const done = f.deviceTTS.speak({ text: 'other owner', language: 'ja' }); f.synth.end();
  assert.equal((await done).status, 'completed');
  const g = setup({ signal: AbortSignal.abort() }); g.speaker.setMuted(false); g.send('a');
  assert.equal(g.synth.spoken.length, 0);
});


test('a state observer can close during enqueue without leaving queued text or timers', () => {
  let speaker;
  const f = setup({ muted: false, onState() { speaker?.close(); } });
  speaker = f.speaker;
  assert.equal(f.send('a'), false);
  assert.equal(speaker.snapshot().waiting, 0);
  assert.equal(f.synth.spoken.length, 0);
  assert.equal(f.timers.size, 0);
});
