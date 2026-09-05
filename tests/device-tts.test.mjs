import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceTTS } from '../app/audio/device-tts.js';
function setup(options = {}) {
  const timers = new Map(); let id = 0;
  class Synth extends EventTarget {
    voices = []; spoken = []; cancelled = 0;
    getVoices() { return this.voices; }
    speak(u) { this.spoken.push(u); }
    cancel() { this.cancelled++; }
  }
  const synth = new Synth();
  const tts = createDeviceTTS({ speechSynthesis: synth,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (key) => timers.delete(key), ...options });
  return { tts, synth, timers };
}
const voice = { lang: 'ja-JP', voiceURI: 'ja', localService: false };
const request = { text: 'こんにちは', language: 'ja-JP' };

test('waits for delayed voice list, picks target language, and cleans on end', async () => {
  const { tts, synth, timers } = setup();
  const done = tts.speak(request, { turnId: 't1', generation: 2 });
  assert.equal(synth.spoken.length, 0);
  synth.voices = [{ lang: 'en-US' }, voice]; synth.dispatchEvent(new Event('voiceschanged'));
  assert.equal(synth.spoken.length, 1); assert.equal(synth.spoken[0].voice, voice);
  synth.spoken[0].onend();
  const result = await done;
  assert.equal(result.status, 'completed'); assert.equal(result.turnId, 't1');
  assert.equal(result.offlineGuaranteed, false); assert.equal(result.localService, false);
  assert.equal(result.privacyMessageKey, 'voice.devicePrivacy');
  assert.equal(timers.size, 0); assert.equal(synth.spoken[0].text, '');
});

test('abort during voice loading cannot cause late speech', async () => {
  const { tts, synth, timers } = setup(); const controller = new AbortController();
  const done = tts.speak(request, { signal: controller.signal });
  const lateTimers = [...timers.values()]; controller.abort('SECRET');
  synth.voices = [voice]; synth.dispatchEvent(new Event('voiceschanged'));
  lateTimers.forEach(({ fn }) => fn());
  assert.equal((await done).status, 'cancelled'); assert.equal(synth.spoken.length, 0);
  assert.equal(timers.size, 0);
});

test('replacement and close cancel speaking and ignore stale events', async () => {
  const { tts, synth, timers } = setup(); synth.voices = [voice];
  const first = tts.speak(request); const lateEnd = synth.spoken[0].onend;
  const second = tts.speak(request); lateEnd();
  assert.equal((await first).status, 'cancelled'); assert.equal(synth.cancelled, 1);
  tts.close(); assert.equal((await second).status, 'cancelled');
  assert.equal(synth.cancelled, 2); assert.equal(timers.size, 0);
  assert.equal((await tts.speak(request)).status, 'cancelled');
});

test('voice wait expiry never reads in an unrelated language', async () => {
  const { tts, synth, timers } = setup(); synth.voices = [{ lang: 'en-US' }];
  const done = tts.speak(request);
  [...timers.values()].find((t) => t.ms === 1500).fn();
  assert.equal((await done).messageKey, 'voice.deviceUnavailable');
  assert.equal(synth.spoken.length, 0); assert.equal(timers.size, 0);
});

test('deadline cancels stuck utterance; errors never preserve browser event data', async () => {
  for (const mode of ['timeout', 'error', 'throw']) {
    const { tts, synth, timers } = setup(); synth.voices = [voice];
    if (mode === 'throw') synth.speak = () => { throw Error('SECRET'); };
    const done = tts.speak(request);
    if (mode === 'timeout') [...timers.values()].find((t) => t.ms === 120000).fn();
    if (mode === 'error') synth.spoken[0].onerror({ error: 'SECRET' });
    const result = await done;
    assert.equal(result.status, mode === 'timeout' ? 'timeout' : 'failed');
    assert.ok(!JSON.stringify(result).includes('SECRET')); assert.equal(timers.size, 0);
    assert.equal(synth.cancelled, 1);
  }
});

test('unsupported environment and already aborted request settle without speech', async () => {
  assert.equal((await createDeviceTTS().speak(request)).status, 'unavailable');
  const { tts, synth, timers } = setup();
  assert.equal((await tts.speak(request, { signal: AbortSignal.abort() })).status, 'cancelled');
  assert.equal(synth.spoken.length, 0); assert.equal(timers.size, 0);
});

test('voice-list timeout rechecks when voiceschanged is not implemented', async () => {
  const { tts, synth, timers } = setup();
  synth.addEventListener = undefined;
  const done = tts.speak(request);
  synth.voices = [{ ...voice, localService: true }];
  [...timers.values()].find((t) => t.ms === 1500).fn();
  synth.spoken[0].onend();
  const result = await done;
  assert.equal(result.localService, true); assert.equal(result.offlineGuaranteed, false);
  assert.equal(timers.size, 0);
});
