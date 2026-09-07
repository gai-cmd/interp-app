/**
 * Ported from: ~/jarvis2/jp-patch/inject/ambient-state.js, jpGeminiSpeak.
 * Ported on: 2026-09-05
 * Source SHA-256: 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: Injected environment, explicit LE decoding, bounded per-turn queue,
 * ended-source cleanup and terminal cancellation. No React or Electron.
 */
import { pcm16ToFloat32 } from './wav.js';

/** One player per turn. Call resume() from a user gesture, enqueue PCM, then finish().
 * done always resolves. Context ownership stays with the caller. Chunk boundaries
 * are NOT linguistic boundaries: overflow terminates this turn with gap=true.
 * Metrics describe reception/scheduling only, never physical speaker onset.
 */
export function createPCMPlayer({ context, signal, turnId, sessionId, generation,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
  now = () => globalThis.performance.now(), maxQueueSeconds = 8, maxSources = 256,
  timeoutMs = 120000 } = {}) {
  if (!context || !Number.isFinite(maxQueueSeconds) || maxQueueSeconds <= 0 || maxQueueSeconds > 8
    || !Number.isInteger(maxSources) || maxSources < 1 || maxSources > 256
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('AUDIO_INVALID_OPTIONS');
  const sources = new Set();
  let terminal = false, finishing = false, nextAt = 0, timer;
  let firstReceivedAt = null, firstScheduledAt = null;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const metadata = { turnId, sessionId, generation };
  function release(source, stop) {
    source.onended = null;
    if (stop) { try { source.stop(); } catch { /* Already stopped. */ } }
    try { source.disconnect(); } catch { /* Best effort after context closure. */ }
    source.buffer = null;
    sources.delete(source);
  }
  function settle(status, messageKey, gap = false) {
    if (terminal) return;
    terminal = true;
    clear(timer);
    signal?.removeEventListener('abort', cancel);
    for (const source of sources) release(source, true);
    nextAt = 0;
    resolve({ ...metadata, status, messageKey, gap, firstReceivedAt, firstScheduledAt,
      actualFirstSoundAt: null });
  }
  function cancel() { settle('cancelled', 'error.ABORTED'); }
  function snapshot() {
    const queuedSeconds = terminal ? 0 : Math.max(0, nextAt - context.currentTime);
    return { queuedSeconds, sourceCount: sources.size, delayed: queuedSeconds >= 3,
      firstReceivedAt, firstScheduledAt, actualFirstSoundAt: null, terminal };
  }
  function enqueue(pcm) {
    if (terminal || finishing) return false;
    const length = pcm instanceof ArrayBuffer ? pcm.byteLength
      : pcm instanceof Uint8Array || pcm instanceof DataView ? pcm.byteLength : -1;
    if (length <= 0 || length % 2) { settle('failed', 'error.VOICE_FAILED'); return false; }
    const at = Math.max(nextAt, context.currentTime + 0.06);
    const duration = length / 2 / 24000;
    if (at + duration - context.currentTime > maxQueueSeconds
      || sources.size >= maxSources) {
      settle('overflow', 'voice.partialFailure', true);
      return false;
    }
    let source;
    try {
      const samples = pcm16ToFloat32(pcm);
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.getChannelData(0).set(samples);
      source = context.createBufferSource();
      sources.add(source);
      source.buffer = buffer;
      source.onended = () => {
        if (terminal || !sources.has(source)) return;
        release(source, false);
        if (finishing && sources.size === 0) settle('completed');
      };
      source.connect(context.destination);
      source.start(at);
      firstReceivedAt ??= now();
      firstScheduledAt ??= at;
      nextAt = at + duration;
      return true;
    } catch { settle('failed', 'error.VOICE_FAILED'); return false; }
  }
  async function resume() {
    if (terminal) return false;
    try { await context.resume(); }
    catch { settle('failed', 'error.VOICE_FAILED'); return false; }
    return !terminal;
  }
  function finish() {
    finishing = true;
    if (!sources.size) settle('completed');
    return done;
  }
  timer = schedule(() => settle('timeout', 'error.TIMEOUT'), timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return { enqueue, resume, finish, cancel, close: cancel, snapshot, done };
}
