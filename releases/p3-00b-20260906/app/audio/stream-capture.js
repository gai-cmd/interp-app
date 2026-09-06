/**
 * Ported from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart capture graph and 512-sample framing.
 * Reuses app/audio/capture.js (P1 lifecycle), capture-worklet.js, resampler.js and wav.js.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: injected platform, actual rate resampling, continuous PCM, no IPC/React,
 * static worklet, normalized results and cleanup across asynchronous races.
 */
import { createPlatform } from '../platform.js';
import { createResampler } from './resampler.js';
import { float32ToPCM16 } from './wav.js';

export const SETUP_TIMEOUT_MS = 30000;
export const STREAM_FRAME_SAMPLES = 512;
const attempt = fn => { try { return fn(); } catch { return undefined; } };
const stopTracks = stream => { for (const track of stream.getTracks()) attempt(() => track.stop()); };

/**
 * Start from a user gesture. onFrame(pcm, metadata) is synchronous: feed a
 * connection-scoped uplink queue, never an async sendAudio callback.
 * stop/cancel discard the incomplete tail and resampler filter history; done
 * resolves without audio storage. No flush or zero-padded final frame is sent.
 * Silence is valid input. Missing worklet messages for two seconds stop capture.
 */
export function createStreamCapture({ platform = createPlatform(), onLevel, onFrame } = {}) {
  let active;
  function start({ signal, turnId, sessionId, generation } = {}) {
    if (active) throw new Error('INVALID_REQUEST');
    let resolve;
    const done = new Promise(r => { resolve = r; });
    let ended = false, stream, context, node, source, resampler;
    let frames = 0, emittedFrames = 0, rate, timer, watchdog;
    let pending = new Float32Array(STREAM_FRAME_SAMPLES), pendingLength = 0;
    const removers = [];
    const metadata = { turnId, sessionId, generation };
    function listen(target, type, fn) {
      if (!target?.addEventListener) return;
      target.addEventListener(type, fn);
      removers.push(() => target.removeEventListener(type, fn));
    }
    function finish(status, code, reason) {
      if (ended) return done;
      ended = true;
      for (const id of [timer, watchdog]) platform.clearTimeout(id);
      for (const remove of removers) attempt(remove);
      if (node) {
        node.port.onmessage = null;
        node.onprocessorerror = null;
        attempt(() => node.port.close());
        attempt(() => node.disconnect());
      }
      attempt(() => source?.disconnect());
      if (stream) stopTracks(stream);
      attempt(() => context?.close()?.catch(() => {}));
      let result = { ...metadata, status, code, reason, inputSampleRate: rate,
        sampleRate: 16000, durationMs: rate ? frames / rate * 1000 : 0 };
      result.emittedFrames = emittedFrames;
      result.discardedTailSamples = pendingLength;
      if (result.code) result.messageKey = `error.${result.code}`;
      pending = null;
      pendingLength = 0;
      resampler?.reset();
      active = undefined;
      resolve(Object.freeze(result));
      return done;
    }
    const session = Object.freeze({ done,
      stop: () => finish('stopped', undefined, 'stop'),
      cancel: () => finish('cancelled', 'ABORTED', 'cancel'),
    });
    active = session;
    const interrupt = () => finish('interrupted', 'BROWSER_INTERRUPTED', 'interrupted');
    listen(signal, 'abort', session.cancel);
    listen(platform.page, 'pagehide', interrupt);
    listen(platform.document, 'visibilitychange', () => {
      if (platform.document.hidden) interrupt();
    });
    if (signal?.aborted) { session.cancel(); return session; }
    if (platform.document?.hidden) { interrupt(); return session; }
    function armWatchdog() {
      platform.clearTimeout(watchdog);
      watchdog = platform.setTimeout(() => finish(frames ? 'interrupted' : 'error',
        frames ? 'BROWSER_INTERRUPTED' : 'MICROPHONE_UNAVAILABLE', 'no-input'), 2000);
    }
    async function open() {
      try {
        if (!platform.isSecureContext || !platform.isUserActive()) {
          finish('error', 'MICROPHONE_UNAVAILABLE'); return;
        }
        // Resume before the first await to preserve transient user activation.
        context = platform.createAudioContext();
        const resumed = Promise.resolve(context.resume());
        resumed.catch(() => finish('error', 'MICROPHONE_UNAVAILABLE'));
        timer = platform.setTimeout(() => finish('error', 'TIMEOUT', 'setup'), SETUP_TIMEOUT_MS);
        const incoming = await platform.getUserMedia({ audio: {
          channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        }, video: false });
        if (ended) { stopTracks(incoming); return; }
        stream = incoming;
        const tracks = stream.getAudioTracks();
        if (!tracks.length || tracks.some(track => track.readyState === 'ended' || track.muted)) {
          finish('error', 'MICROPHONE_UNAVAILABLE'); return;
        }
        for (const track of tracks) {
          listen(track, 'ended', interrupt);
          listen(track, 'mute', interrupt);
        }
        await resumed;
        if (ended) return;
        await context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
        if (ended) return;
        if (context.state !== 'running') { interrupt(); return; }
        rate = context.sampleRate;
        resampler = createResampler({ inputSampleRate: rate });
        source = context.createMediaStreamSource(stream);
        node = platform.createWorkletNode(context);
        node.onprocessorerror = () => finish('error', 'MICROPHONE_UNAVAILABLE');
        listen(context, 'statechange', () => { if (context.state !== 'running') interrupt(); });
        node.port.onmessage = ({ data }) => {
          if (ended) return;
          try {
            if (!(data instanceof Float32Array) || !data.length) return;
            const samples = data;
            let sum = 0, peak = 0;
            for (const value of samples) {
              if (!Number.isFinite(value)) throw new Error('MICROPHONE_UNAVAILABLE');
              sum += value * value; peak = Math.max(peak, Math.abs(value));
            }
            const rms = Math.sqrt(sum / samples.length);
            frames += samples.length;
            // Process bounded blocks even if a delayed port event contains more input.
            for (let offset = 0; offset < samples.length && !ended; offset += 2048) {
              const output = resampler.process(samples.subarray(offset, offset + 2048));
              for (let i = 0; i < output.length && !ended;) {
                const count = Math.min(STREAM_FRAME_SAMPLES - pendingLength, output.length - i);
                pending.set(output.subarray(i, i + count), pendingLength);
                pendingLength += count;
                i += count;
                if (pendingLength === STREAM_FRAME_SAMPLES) {
                  const pcm = float32ToPCM16(pending);
                  pendingLength = 0;
                  emittedFrames++;
                  onFrame?.(pcm, { ...metadata, sampleRate: 16000, channels: 1,
                    sequence: emittedFrames, inputSampleRate: rate });
                }
              }
            }
            if (ended) return;
            armWatchdog();
            attempt(() => onLevel?.({ ...metadata, rms, peak, inputSampleRate: rate,
              durationMs: frames / rate * 1000, messageKey: 'seq.inputLevel' }));
          } catch { finish('error', 'MICROPHONE_UNAVAILABLE'); }
        };
        source.connect(node);
        node.connect(context.destination);
        platform.clearTimeout(timer);
        armWatchdog();
      } catch (error) {
        finish('error', error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          ? 'MICROPHONE_DENIED' : 'MICROPHONE_UNAVAILABLE');
      }
    }
    void open();
    return session;
  }
  return Object.freeze({ start, stop: () => active?.stop(), cancel: () => active?.cancel() });
}
