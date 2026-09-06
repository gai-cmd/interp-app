import test from 'node:test';
import assert from 'node:assert/strict';
import { createListenMetrics, METRICS_POLICY, METRIC_NAMES } from '../app/engine/listen-metrics.js';
import { readFile } from 'node:fs/promises';

test('local monotonic milestones never use server timestamps or scheduled audio as physical sound', () => {
  let time = 100;
  const m = createListenMetrics({ now: () => time });
  time = 120; m.mark('setupMs');
  time = 110; m.mark('firstPartialMs');
  time = NaN; m.mark('firstFinalMs');
  time = 140; m.mark('firstAudioScheduledMs');
  assert.equal(m.mark('physicalFirstSoundMs'), false);
  assert.equal(m.observe('serverTs', 999999), false);
  const s = m.snapshot();
  assert.equal(s.setupMs, 20); assert.equal(s.firstPartialMs, 20); assert.equal(s.firstFinalMs, 20);
  assert.equal(s.firstAudioScheduledMs, 40); assert.equal(s.firstAudioReceivedMs, null);
  assert.equal(s.ttsFirstStartMs, null);
  assert.equal(m.mark('setupMs'), false);
});

test('bounded rolling percentiles and lifetime maxima separate app queue delay from latency', () => {
  let time = 0;
  const m = createListenMetrics({ now: () => time, maxSamples: 4 });
  m.queue(9000); time = 100; m.queue(4000); time = 250; m.queue(3000);
  time = 500; m.queue(100); m.queue(200);
  const s = m.snapshot();
  assert.equal(s.delayedMs, 250); assert.equal(s.queueP50Ms, 200);
  assert.equal(s.queueP95Ms, 4000); assert.equal(s.queueMaxMs, 9000); assert.equal(s.sampleCount, 4);
  for (let i = 0; i < 10000; i++) m.queue(i);
  assert.equal(m.snapshot().sampleCount, 4);
  time = 600; m.stop(); const stopped = m.snapshot().delayedMs;
  time = 900; assert.equal(m.snapshot().delayedMs, stopped);
  assert.equal(m.queue(1), false); assert.equal(m.mark('setupMs'), false);
});

test('only numeric allowlisted aggregates survive, with bounded sums and optional memory', () => {
  const m = createListenMetrics({ getMemory() { throw new Error('SECRET'); } });
  assert.equal(m.observe('sourceText', 'SECRET'), false);
  assert.equal(m.observe('sentFrames', { key: 'SECRET' }), false);
  assert.equal(m.observe('sentFrames', Infinity), false);
  assert.equal(m.observe('sentFrames', -1), false);
  m.observe('sentFrames', Number.MAX_VALUE); m.observe('sentFrames', 100);
  m.observe('inputQueueMax', 8); m.observe('inputQueueMax', 1);
  assert.equal(m.snapshot().sentFrames, METRICS_POLICY.maxValue);
  assert.equal(m.snapshot().inputQueueMax, 8);
  assert.equal(m.snapshot().memoryState, 'unsupported');
  assert.equal(JSON.stringify(m.snapshot()).includes('SECRET'), false);
  assert.equal(createListenMetrics({ getMemory: () => 1024 }).snapshot().memoryBytes, 1024);
  assert.throws(() => createListenMetrics({ maxSamples: 513 }), /INVALID_REQUEST/);
  let calls = 0; const off = m.subscribe(() => calls++); m.observe('duplicates'); off(); m.observe('duplicates');
  assert.equal(calls, 1);
});

test('every displayed metric has all three translations', async () => {
  for (const lang of ['ko', 'en', 'ja']) {
    const dict = JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const name of METRIC_NAMES) assert.equal(typeof dict[`diagnostics.${name}`], 'string');
  }
});


test('speech latency estimates preserve audio before speech end and reset across reconnects', () => {
  let time = 0; const m = createListenMetrics({ now: () => time });
  m.inputLevel(0.1); time = 200; m.audioReceived();
  assert.equal(m.snapshot().speechToFirstAudioMs, 200);
  assert.equal(m.snapshot().speechEndToFirstAudioMs, null);
  time = 500; m.inputLevel(0.1); time = 900; m.inputLevel(0);
  assert.equal(m.snapshot().speechEndToFirstAudioMs, -300);
  time = 1000; m.inputLevel(0.1); time = 1400; m.inputLevel(0);
  time = 1500; m.audioReceived();
  assert.equal(m.snapshot().speechEndToFirstAudioMs, 500);
  m.resetInput(); time = 2000; m.audioReceived();
  assert.equal(m.snapshot().speechToFirstAudioMs, 500);
  m.stop(); time = 3000; m.inputLevel(0.1); m.audioReceived();
  assert.equal(m.snapshot().speechToFirstAudioMs, 500);
});
