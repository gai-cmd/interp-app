// Original implementation of design-p2 §8.5/17; no legacy send loop is ported.
import { ProviderError, normalizeError } from '../providers/contract.js';

export const UPLINK_LIMITS = Object.freeze({ frameBytes: 1024, frameMs: 32,
  maxFrames: 8, maxAgeMs: 256,
  // 2026-09-30 key-swap bridge: the input held while a site key is swapped is
  // at most 4 s of 16 kHz PCM16 (125 frames of 32 ms) and is sent at most four
  // times faster than it was spoken (one frame per 8 ms), and only while the
  // transport's send buffer holds no more than backlogBufferedBytes — half of
  // the Gemini live-client audio guard (maxAudioBufferedBytes, 12288).
  backlogFrames: 125, backlogFrameMs: 8, backlogBufferedBytes: 6144,
  // 2026-09-30: how far behind its 8 ms schedule the held input may fall
  // before the lost time is forgiven, so a late pump sends at most this much
  // extra (4 frames) at once instead of the whole backlog.
  backlogCreditMs: 32 });

/**
 * One queue per Live connection. enqueue is synchronous and copies PCM.
 * setReady(true) only after open resolves; false discards all waiting input.
 * cancel is terminal, but cannot retract a send already accepted by transport.
 * The eight-frame bound includes the single in-flight send. onDrop reports
 * input gaps, not missing captions. Callbacks receive no PCM.
 *
 * Ordinary frames go out as soon as they arrive (2026-09-30). The pump used to
 * send one frame per timer tick, at least 32 ms apart, and never caught up
 * after a late tick. Measured the same day in desktop Chrome with the window
 * behind another one: page timers slowed to about 8 ticks a second, so about
 * 8 of every 31 frames were sent and the rest expired at 256 ms — roughly
 * three quarters of the speech never reached the interpreter, although the
 * capture itself kept delivering every frame. Frames now start the pump from
 * enqueue (a microtask, which timer throttling does not slow) and the pump
 * sends everything that is waiting, one send at a time. The real-time rate
 * comes from the capture; the queue no longer spaces it again. What bounds a
 * burst is the transport: sendAudio may resolve with the bytes still waiting
 * in its send buffer, and while that is above backlogBufferedBytes the next
 * frame waits one real-time interval (32 ms), well clear of the live-client
 * guard that would end the session.
 *
 * The one exception (2026-09-30) is `backlog`: frames held while the session
 * swapped to another site key. They are never dropped as stale, go out first
 * and in order, 8 ms apart on a schedule that forgives at most
 * backlogCreditMs of lateness, and input arriving meanwhile queues behind
 * them (bounded to backlogFrames, oldest dropped as 'overflow').
 * Unverified: Google does not document how the Live API treats audio sent
 * faster than real time. The pace and the 4 s bound limit what is asked of it.
 * Computed, not measured: 4x is about 1.4 Mbit/s of upload (4 x 32 kB/s PCM,
 * plus base64 and JSON). A result that is not a number (fakes, other
 * transports) never pauses the pump.
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
  let ready = false, cancelled = false, sending = false, kicked = false, timer, timerAt;
  // heldAt: when the next held frame may go (null until the first one went).
  // resumeAt: when ordinary frames may go again after the send buffer filled.
  let queue = [], heldAt = null, resumeAt = -Infinity;
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
  function clearTimer() { clock.clearTimeout(timer); timer = undefined; timerAt = undefined; }
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
  const waiting = () => queue.length > 0 || catchUp.length > 0;
  // The moment the next frame may go, by the rules above.
  const dueAt = () => (catchUp.length ? heldAt ?? -Infinity : resumeAt);
  // Start the pump without waiting for a timer: new input, readiness. A timer
  // that is waiting for a later moment keeps waiting; one that is already due
  // (a throttled page fires it late) is overtaken.
  function kick() {
    if (cancelled || !ready || sending || kicked || !waiting()) return;
    if (timer !== undefined) {
      if (clock.now() < timerAt) return;
      clearTimer();
    }
    kicked = true;
    queueMicrotask(() => { kicked = false; void pump(); });
  }
  function schedule(at) {
    if (cancelled || !ready || sending || timer !== undefined || !waiting()) return;
    timerAt = at;
    timer = clock.setTimeout(pump, Math.max(0, at - clock.now()));
  }
  async function pump() {
    timer = undefined; timerAt = undefined;
    if (cancelled || !ready || sending) return;
    sending = true;
    let wait = null;
    try {
      while (!cancelled && ready) {
        // Held input is late by design; only ordinary frames can go stale.
        const held = catchUp.length > 0;
        if (!held) expire();
        if (!(held ? catchUp.length : queue.length)) break;
        const now = clock.now();
        if (now < dueAt()) { wait = dueAt(); break; }
        const frame = held ? catchUp.shift() : queue.shift();
        if (held) heldAt = (heldAt === null ? now : Math.max(heldAt, now - UPLINK_LIMITS.backlogCreditMs))
          + UPLINK_LIMITS.backlogFrameMs;
        const buffered = await sendAudio(frame.pcm);
        if (cancelled) break;
        sentFrames++;
        if (Number.isFinite(buffered) && buffered > UPLINK_LIMITS.backlogBufferedBytes) {
          // The socket is not keeping up: leave it one real-time interval.
          const until = clock.now() + UPLINK_LIMITS.frameMs;
          if (held) heldAt = Math.max(heldAt, until); else resumeAt = until;
        }
      }
    } catch (error) {
      if (!cancelled) {
        const safe = normalizeError(error);
        cancel();
        notify(onError, safe);
      }
    } finally {
      sending = false;
      if (wait !== null) schedule(wait);
      // Frames that arrived during the last send, or a held backlog that
      // just finished, are picked up at once.
      else kick();
    }
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
        kick();
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
      kick();
      return true;
    },
    setReady(value) {
      if (cancelled) return;
      ready = value === true;
      if (!ready) { clearTimer(); discard('not-ready'); }
      else kick();
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
