// New implementation of design-p2 §17; no legacy runtime code is ported.
// Feed local observations explicitly. Never subtract server timestamps or
// AudioContext seconds from this clock. No text, identifiers or audio is kept.
export const METRICS_POLICY = Object.freeze({ maxSamples: 512, maxValue: Number.MAX_SAFE_INTEGER });
export const METRIC_NAMES = Object.freeze([
  'setupMs', 'reconnects', 'recoveryMs', 'closeFailures', 'inputSampleRate', 'sentFrames',
  'inputQueueMax', 'droppedInputMs', 'firstPartialMs', 'firstFinalMs', 'revisions',
  'duplicates', 'interrupted', 'possibleGaps', 'firstAudioReceivedMs', 'firstAudioScheduledMs',
  'queueP50Ms', 'queueP95Ms', 'queueMaxMs', 'delayedMs', 'droppedAudioMs',
  'ttsFirstRequestMs', 'ttsFirstStartMs', 'ttsWaitMs', 'skippedSentences', 'speechFailures'
]);
const counters = new Set(['reconnects', 'closeFailures', 'sentFrames', 'droppedInputMs', 'revisions',
  'duplicates', 'interrupted', 'possibleGaps', 'droppedAudioMs', 'skippedSentences', 'speechFailures']);
const firsts = new Set(['setupMs', 'firstPartialMs', 'firstFinalMs', 'firstAudioReceivedMs',
  'firstAudioScheduledMs', 'ttsFirstRequestMs', 'ttsFirstStartMs']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bounded = value => Math.min(METRICS_POLICY.maxValue, value);

/** One collector per listening run. mark(name) records elapsed local time;
 * observe(name, number) adds counters or updates gauges. queue(ms) samples
 * queue wait, not end-to-end latency. stop() freezes duration accounting.
 * Memory is optional and must be an explicit browser measurement in bytes.
 */
export function createListenMetrics({ now = () => performance.now(), maxSamples = METRICS_POLICY.maxSamples,
  getMemory = null } = {}) {
  if (typeof now !== 'function' || !Number.isInteger(maxSamples) || maxSamples < 1
    || maxSamples > METRICS_POLICY.maxSamples) throw new Error('INVALID_REQUEST');
  let last = 0;
  function clock() {
    const value = now();
    if (number(value)) last = Math.max(last, bounded(value));
    return last;
  }
  const start = clock();
  const values = Object.fromEntries(METRIC_NAMES.map(name => [name, counters.has(name) ? 0 : null]));
  const samples = [];
  let stopped = false, delayedAt = null, delayed = 0, observations = 0;
  const listeners = new Set();
  function snapshot() {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    let memoryBytes = null;
    try { const value = getMemory?.(); if (number(value)) memoryBytes = bounded(value); } catch { /* Optional API. */ }
    return Object.freeze({ ...values, queueP50Ms: percentile(0.5), queueP95Ms: percentile(0.95),
      delayedMs: bounded(delayed + (delayedAt === null ? 0 : clock() - delayedAt)),
      sampleCount: samples.length, observations, stopped, memoryBytes,
      memoryState: memoryBytes === null ? 'unsupported' : 'measured' });
  }
  function notify() { const value = snapshot(); for (const fn of [...listeners]) { try { fn(value); } catch { /* Consumer. */ } } }
  return Object.freeze({ snapshot,
    mark(name) {
      if (stopped || !firsts.has(name) || values[name] !== null) return false;
      values[name] = clock() - start; notify(); return true;
    },
    observe(name, value = 1) {
      if (stopped || !METRIC_NAMES.includes(name) || firsts.has(name) || !number(value)
        || ['queueP50Ms', 'queueP95Ms', 'queueMaxMs', 'delayedMs'].includes(name)) return false;
      values[name] = bounded(counters.has(name) ? values[name] + value
        : name === 'inputQueueMax' ? Math.max(values[name] ?? 0, value) : value);
      notify(); return true;
    },
    queue(value) {
      if (stopped || !number(value)) return false;
      const at = clock(); value = bounded(value);
      if (delayedAt !== null) delayed = bounded(delayed + at - delayedAt);
      delayedAt = value > 3000 ? at : null;
      if (samples.length === maxSamples) samples.shift();
      samples.push(value); observations = bounded(observations + 1);
      values.queueMaxMs = Math.max(values.queueMaxMs ?? 0, value); notify(); return true;
    },
    stop() {
      if (stopped) return;
      if (delayedAt !== null) delayed = bounded(delayed + clock() - delayedAt);
      delayedAt = null; stopped = true; notify();
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    }
  });
}
