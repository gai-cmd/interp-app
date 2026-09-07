// Original implementation of design-p2 §8.5/17; no legacy send loop is ported.
import { ProviderError, normalizeError } from '../providers/contract.js';

export const UPLINK_LIMITS = Object.freeze({ frameBytes: 1024, frameMs: 32,
  maxFrames: 8, maxAgeMs: 256 });

/**
 * One queue per Live connection. enqueue is synchronous and copies PCM.
 * setReady(true) only after open resolves; false discards all waiting input.
 * cancel is terminal, but cannot retract a send already accepted by transport.
 * The eight-frame bound includes the single in-flight send. No catch-up burst:
 * send starts are >=32ms apart, using actual monotonic time, not timer deadlines.
 * onDrop reports input gaps, not missing captions. Callbacks receive no PCM.
 */
export function createUplinkQueue({ sendAudio, signal, onDrop, onError,
  clock = { now: () => performance.now(), setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout } } = {}) {
  if (typeof sendAudio !== 'function') throw new ProviderError('INVALID_REQUEST');
  let ready = false, cancelled = false, sending = false, timer;
  let queue = [], nextAt = -Infinity;
  let sentFrames = 0, droppedFrames = 0, maxFrames = 0;
  const notify = (fn, value) => { try { fn?.(value); } catch { /* Observer-owned failure. */ } };
  function drop(count, reason) {
    if (!count) return;
    droppedFrames += count;
    notify(onDrop, Object.freeze({ reason, frames: count, durationMs: count * 32 }));
  }
  function discard(reason) {
    const count = queue.length;
    queue = [];
    drop(count, reason);
  }
  function clearTimer() { clock.clearTimeout(timer); timer = undefined; }
  function cancel() {
    if (cancelled) return;
    cancelled = true; ready = false; clearTimer();
    signal?.removeEventListener('abort', cancel);
    discard('cancelled');
  }
  function expire() {
    const time = clock.now();
    let count = 0;
    while (queue.length && time - queue[0].at >= UPLINK_LIMITS.maxAgeMs) {
      queue.shift(); count++;
    }
    drop(count, 'stale');
  }
  function schedule() {
    if (cancelled || !ready || sending || timer !== undefined || !queue.length) return;
    timer = clock.setTimeout(pump, Math.max(0, nextAt - clock.now()));
  }
  async function pump() {
    timer = undefined;
    if (cancelled || !ready || sending) return;
    expire();
    if (cancelled || !ready || !queue.length) return;
    if (clock.now() < nextAt) { schedule(); return; }
    const frame = queue.shift();
    sending = true;
    nextAt = clock.now() + UPLINK_LIMITS.frameMs;
    try {
      await sendAudio(frame.pcm);
      if (!cancelled) sentFrames++;
    } catch (error) {
      if (!cancelled) {
        const safe = normalizeError(error);
        cancel();
        notify(onError, safe);
      }
    } finally { sending = false; schedule(); }
  }
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return Object.freeze({
    enqueue(pcm) {
      if (cancelled) return false;
      if (!(pcm instanceof Uint8Array) || pcm.byteLength !== UPLINK_LIMITS.frameBytes) {
        throw new ProviderError('INVALID_REQUEST');
      }
      if (!ready) { drop(1, 'not-ready'); return false; }
      expire();
      if (cancelled || !ready) return false;
      if (queue.length + Number(sending) >= UPLINK_LIMITS.maxFrames) {
        queue.shift(); drop(1, 'overflow');
      }
      if (cancelled || !ready) return false;
      queue.push({ pcm: pcm.slice(), at: clock.now() });
      maxFrames = Math.max(maxFrames, queue.length + Number(sending));
      schedule();
      return true;
    },
    setReady(value) {
      if (cancelled) return;
      ready = value === true;
      if (!ready) { clearTimer(); discard('not-ready'); }
      else schedule();
    },
    cancel,
    getStats: () => Object.freeze({ queuedFrames: queue.length, inFlight: Number(sending),
      maxFrames, sentFrames, droppedFrames, droppedMs: droppedFrames * 32 }),
  });
}
