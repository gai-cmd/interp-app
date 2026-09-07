/**
 * Ported from: ~/jarvis2/jp-patch/inject/ambient-state.js
 * Symbols: jpGeminiSpeak PCM decoding and AudioContext scheduling
 * Ported on: 2026-09-05
 * Source SHA-256: 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: reuse wav.js LE decoder; bounded continuous playback, turn recovery,
 * injected clock, source cleanup, no Electron/React or finite-turn watchdog.
 */
import { pcm16ToFloat32 } from './wav.js';

const attempt = fn => { try { return fn(); } catch { return undefined; } };

/** One player per connection generation; the caller owns the AudioContext.
 * Call resume from a gesture. Route audio to enqueue, complete to turnComplete,
 * interrupted to interrupt, and connection teardown to cancel. Subtitle finals
 * and PCM chunks are never turn boundaries. Callbacks contain machine data only.
 */
export function createStreamPlayer({ context, signal, onState, onDrop,
  now = () => globalThis.performance.now(),
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
  maxQueueSeconds = 8, maxSources = 256, muted: initiallyMuted = false } = {}) {
  if (!context || !Number.isFinite(maxQueueSeconds) || maxQueueSeconds <= 0 || maxQueueSeconds > 8
    || !Number.isInteger(maxSources) || maxSources < 1 || maxSources > 256) {
    throw new Error('AUDIO_INVALID_OPTIONS');
  }
  const sources = new Map();
  let nextAt = 0, muted = Boolean(initiallyMuted), terminal = false, catchingUp = false;
  let recoveryTimer, monitorTimer, lastState, messageKey, resumePending;
  let firstReceivedAt = null, firstScheduledAt = null, droppedMs = 0, forcedBoundaries = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function snapshot() {
    const queuedSeconds = terminal ? 0 : Math.max(0, nextAt - context.currentTime);
    const state = terminal ? 'unavailable' : muted ? 'muted'
      : context.state !== 'running' ? 'blocked' : catchingUp ? 'catching-up'
        : queuedSeconds >= 3 ? 'delayed' : 'ready';
    return { state, terminal, muted, catchingUp, queuedSeconds, sourceCount: sources.size,
      delayed: state === 'delayed', firstReceivedAt, firstScheduledAt,
      actualFirstSoundAt: null, droppedMs, forcedBoundaries, messageKey };
  }
  function notify() {
    const value = snapshot();
    if (value.state !== lastState) {
      lastState = value.state;
      attempt(() => onState?.(value));
    }
  }
  function release(source, stop) {
    sources.delete(source);
    source.onended = null;
    if (stop) attempt(() => source.stop());
    attempt(() => source.disconnect());
    attempt(() => { source.buffer = null; });
  }
  function discard() {
    let seconds = 0;
    for (const [source, span] of sources) {
      seconds += Math.max(0, span.end - Math.max(span.start, context.currentTime));
      release(source, true);
    }
    nextAt = 0;
    clear(monitorTimer); monitorTimer = undefined;
    return seconds * 1000;
  }
  function drop(reason, durationMs) {
    droppedMs += durationMs;
    attempt(() => onDrop?.({ reason, durationMs }));
  }
  function resetRecovery() {
    catchingUp = false;
    clear(recoveryTimer); recoveryTimer = undefined;
  }
  function cancel() { return finish('cancelled', 'error.ABORTED'); }
  function finish(status, key) {
    if (terminal) return done;
    terminal = true;
    messageKey = key;
    resetRecovery();
    const duration = discard();
    signal?.removeEventListener('abort', cancel);
    context.removeEventListener?.('statechange', contextChanged);
    drop(status, duration);
    notify();
    resolveDone({ ...snapshot(), status });
    return done;
  }
  function contextChanged() {
    if (terminal) return;
    if (context.state === 'closed') { finish('failed', 'error.VOICE_FAILED'); return; }
    if (context.state !== 'running') {
      resetRecovery();
      const duration = discard();
      drop('blocked', duration);
    }
    notify();
  }
  // A single short timer updates delayed status even when no new PCM arrives.
  // AudioContext time, never wall time, determines how much audio remains.
  function monitor() {
    monitorTimer = undefined;
    if (terminal) return;
    contextChanged();
    if (terminal) return;
    for (const [source, span] of sources) {
      if (span.end <= context.currentTime) release(source, false);
    }
    if (!sources.size) nextAt = 0;
    notify();
    if (!terminal && sources.size) monitorTimer = schedule(monitor, 50);
  }
  function recover(forced) {
    if (terminal || !catchingUp) return false;
    resetRecovery();
    if (forced) { forcedBoundaries++; drop('forced-boundary', 0); }
    notify();
    return true;
  }
  function enqueue(pcm) {
    if (terminal) return false;
    const length = pcm instanceof ArrayBuffer || pcm instanceof Uint8Array || pcm instanceof DataView
      ? pcm.byteLength : -1;
    if (length <= 0 || length % 2) { finish('failed', 'error.VOICE_FAILED'); return false; }
    firstReceivedAt ??= now();
    const duration = length / 48000;
    contextChanged();
    if (terminal) return false;
    if (muted || context.state !== 'running' || catchingUp) {
      drop(muted ? 'muted' : context.state !== 'running' ? 'blocked' : 'catching-up', duration * 1000);
      return false;
    }
    // Reap completed sources even if the browser delayed their ended events.
    for (const [source, span] of sources) {
      if (span.end <= context.currentTime) release(source, false);
    }
    const at = Math.max(nextAt, context.currentTime + 0.06);
    if (at + duration - context.currentTime > maxQueueSeconds || sources.size >= maxSources) {
      const skipped = discard() + duration * 1000;
      catchingUp = true;
      recoveryTimer = schedule(() => recover(true), 2000);
      drop('overflow', skipped);
      notify();
      return false;
    }
    try {
      const samples = pcm16ToFloat32(pcm);
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      sources.set(source, { start: at, end: at + duration });
      source.buffer = buffer;
      source.onended = () => {
        if (terminal || !sources.has(source)) return;
        release(source, false);
        if (!sources.size) {
          nextAt = 0;
          clear(monitorTimer); monitorTimer = undefined;
        }
        notify();
      };
      source.connect(context.destination);
      source.start(at);
      nextAt = at + duration;
      firstScheduledAt ??= at;
      if (monitorTimer === undefined) monitorTimer = schedule(monitor, 50);
      notify();
      return !terminal;
    } catch { finish('failed', 'error.VOICE_FAILED'); return false; }
  }
  function setMuted(value) {
    if (terminal || muted === Boolean(value)) return;
    muted = Boolean(value);
    resetRecovery();
    const duration = discard();
    drop('muted', duration);
    notify();
  }
  function interrupt() {
    if (terminal) return;
    resetRecovery();
    const duration = discard();
    drop('interrupted', duration);
    notify();
  }
  function resume() {
    if (terminal) return Promise.resolve(false);
    if (resumePending) return resumePending;
    // Invoke resume synchronously to preserve the user's activation.
    let result;
    try { result = context.resume(); }
    catch { contextChanged(); return Promise.resolve(false); }
    resumePending = Promise.resolve(result).then(() => {
      if (terminal) return false;
      contextChanged();
      return !terminal && context.state === 'running';
    }, () => { if (!terminal) contextChanged(); return false; })
      .finally(() => { resumePending = undefined; });
    return resumePending;
  }
  signal?.addEventListener('abort', cancel, { once: true });
  context.addEventListener?.('statechange', contextChanged);
  if (signal?.aborted) cancel();
  else contextChanged();
  return Object.freeze({ enqueue, resume, setMuted, interrupt, turnComplete: () => recover(false),
    cancel, close: cancel, snapshot, done });
}
