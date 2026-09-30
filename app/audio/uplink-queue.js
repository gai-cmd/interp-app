// Original implementation of design-p2 §8.5/17; no legacy send loop is ported.
import { ProviderError, normalizeError } from '../providers/contract.js';

export const UPLINK_LIMITS = Object.freeze({ frameBytes: 1024, frameMs: 32,
  maxFrames: 8, maxAgeMs: 256,
  // 2026-09-30 key-swap bridge: the input held while a site key is swapped is
  // at most 4 s of 16 kHz PCM16 (125 frames of 32 ms) and is sent at most four
  // times faster than it was spoken (one frame per 8 ms), and only while the
  // transport's send buffer holds no more than backlogBufferedBytes — half of
  // the Gemini live-client audio guard (maxAudioBufferedBytes, 12288).
  backlogFrames: 125, backlogFrameMs: 8, backlogBufferedBytes: 6144 });

/**
 * One queue per Live connection. enqueue is synchronous and copies PCM.
 * setReady(true) only after open resolves; false discards all waiting input.
 * cancel is terminal, but cannot retract a send already accepted by transport.
 * The eight-frame bound includes the single in-flight send. No catch-up burst:
 * send starts are >=32ms apart, using actual monotonic time, not timer deadlines.
 * onDrop reports input gaps, not missing captions. Callbacks receive no PCM.
 *
 * The one exception (2026-09-30) is `backlog`: frames held while the session
 * swapped to another site key. They are never dropped as stale, go out first
 * and in order, >= backlogFrameMs apart, and input arriving meanwhile queues
 * behind them (bounded to backlogFrames, oldest dropped as 'overflow').
 * Once the backlog is empty the ordinary 32 ms / 256 ms policy applies again.
 * Unverified: Google does not document how the Live API treats audio sent
 * faster than real time. The pace and the 4 s bound limit what is asked of it.
 * Computed, not measured: 4x is about 1.4 Mbit/s of upload (4 x 32 kB/s PCM,
 * plus base64 and JSON). So the pace also follows the transport (review,
 * 2026-09-30): sendAudio may resolve with the bytes still waiting in its send
 * buffer, and while that is above backlogBufferedBytes the next held frame
 * waits a real-time interval (32 ms) instead of 8 ms. The buffer then stays
 * well under the transport's guard on any uplink that keeps up with real
 * time, which a 4x burst on a slower one would trip, ending the new session
 * and throwing the held input away. A result that is not a number (fakes,
 * other transports) leaves the 8 ms pace as it is.
 * takeUnsent() hands back, in order, the frames not yet given to sendAudio
 * and empties the queue without reporting them as dropped; the caller keeps
 * them (the next key swap, where they would otherwise be lost).
 */
export function createUplinkQueue({ sendAudio, signal, onDrop, onError, backlog,
  clock = { now: () => performance.now(), setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout } } = {}) {
  if (typeof sendAudio !== 'function') throw new ProviderError('INVALID_REQUEST');
  if (backlog !== undefined && backlog !== null && (!Array.isArray(backlog) || backlog.some((pcm) =>
    !(pcm instanceof Uint8Array) || pcm.byteLength !== UPLINK_LIMITS.frameBytes))) throw new ProviderError('INVALID_REQUEST');
  let ready = false, cancelled = false, sending = false, timer;
  let queue = [], nextAt = -Infinity;
  let catchUp = (backlog ?? []).slice(-UPLINK_LIMITS.backlogFrames).map((pcm) => ({ pcm: pcm.slice() }));
  let sentFrames = 0, droppedFrames = 0, maxFrames = 0;
  const notify = (fn, value) => { try { fn?.(value); } catch { /* Observer-owned failure. */ } };
  function drop(count, reason) {
    if (!count) return;
    droppedFrames += count;
    notify(onDrop, Object.freeze({ reason, frames: count, durationMs: count * 32 }));
  }
  function discard(reason) {
    const count = queue.length + catchUp.length;
    queue = []; catchUp = [];
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
    if (cancelled || !ready || sending || timer !== undefined || !(queue.length || catchUp.length)) return;
    timer = clock.setTimeout(pump, Math.max(0, nextAt - clock.now()));
  }
  async function pump() {
    timer = undefined;
    if (cancelled || !ready || sending) return;
    // Held input is late by design; only ordinary frames can go stale.
    const held = catchUp.length > 0;
    if (!held) expire();
    if (cancelled || !ready || !(held ? catchUp.length : queue.length)) return;
    if (clock.now() < nextAt) { schedule(); return; }
    const frame = held ? catchUp.shift() : queue.shift();
    sending = true;
    const startedAt = clock.now();
    nextAt = startedAt + (held ? UPLINK_LIMITS.backlogFrameMs : UPLINK_LIMITS.frameMs);
    try {
      const buffered = await sendAudio(frame.pcm);
      if (!cancelled) sentFrames++;
      if (held && Number.isFinite(buffered) && buffered > UPLINK_LIMITS.backlogBufferedBytes) {
        nextAt = Math.max(nextAt, startedAt + UPLINK_LIMITS.frameMs);
      }
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
      if (catchUp.length) {
        // Still catching up: keep speaking order behind the held input.
        if (catchUp.length >= UPLINK_LIMITS.backlogFrames) { catchUp.shift(); drop(1, 'overflow'); }
        catchUp.push({ pcm: pcm.slice() });
        maxFrames = Math.max(maxFrames, catchUp.length + Number(sending));
        schedule();
        return true;
      }
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
    takeUnsent() {
      const unsent = [...catchUp, ...queue].map((frame) => frame.pcm);
      catchUp = []; queue = [];
      return unsent;
    },
    getStats: () => Object.freeze({ queuedFrames: queue.length, backlogFrames: catchUp.length, inFlight: Number(sending),
      maxFrames, sentFrames, droppedFrames, droppedMs: droppedFrames * 32 }),
  });
}
