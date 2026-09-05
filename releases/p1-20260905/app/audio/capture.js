/**
 * Ported from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart capture graph.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: injected platform, actual rate resampling, bounded PTT, no IPC/React,
 * static worklet, normalized results and cleanup across asynchronous races.
 */
import { createPlatform } from '../platform.js';
import { createResampler } from './resampler.js';
import { float32ToPCM16, encodeWav } from './wav.js';

export const MAX_CAPTURE_MS = 30000;
const attempt = fn => { try { return fn(); } catch { return undefined; } };
const stopTracks = stream => { for (const track of stream.getTracks()) attempt(() => track.stop()); };

/**
 * Call start() directly from a user gesture, after stopping playback.
 * It returns {done, stop, cancel} synchronously, even during permission prompts.
 * done always resolves: success | silence | error | cancelled | interrupted.
 * Events/results contain dictionary keys and safe codes, never native errors.
 * A two-second missing-frame watchdog detects unavailable/stalled input; the
 * RMS threshold is an input heuristic, not speech recognition or a VAD claim.
 */
export function createCapture({ platform = createPlatform(), onLevel, onWarning } = {}) {
  let active;
  function start({ signal, turnId, sessionId, generation } = {}) {
    if (active) throw new Error('INVALID_REQUEST');
    let resolve;
    const done = new Promise(r => { resolve = r; });
    let ended = false, stream, context, node, source, resampler;
    let frames = 0, audible = false, rate, timer, watchdog, warning;
    let chunks = [];
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
      for (const id of [timer, watchdog, warning]) platform.clearTimeout(id);
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
      if (status === 'success') {
        if (!frames) result = { ...result, status: 'error', code: 'MICROPHONE_UNAVAILABLE' };
        else if (!audible) result = { ...result, status: 'silence', messageKey: 'seq.silence' };
        else {
          chunks.push(resampler.flush());
          const samples = new Float32Array(chunks.reduce((sum, part) => sum + part.length, 0));
          let offset = 0;
          for (const part of chunks) { samples.set(part, offset); offset += part.length; }
          result.pcm = float32ToPCM16(samples);
          result.wav = encodeWav(result.pcm);
        }
      }
      if (result.code) result.messageKey = `error.${result.code}`;
      chunks = [];
      resampler?.reset();
      active = undefined;
      resolve(Object.freeze(result));
      return done;
    }
    const session = Object.freeze({ done,
      stop: () => finish('success', undefined, 'stop'),
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
        timer = platform.setTimeout(() => finish('error', 'TIMEOUT', 'setup'), MAX_CAPTURE_MS);
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
            const samples = data.subarray(0, Math.min(data.length, rate * 30 - frames));
            let sum = 0, peak = 0;
            for (const value of samples) {
              if (!Number.isFinite(value)) throw new Error('MICROPHONE_UNAVAILABLE');
              sum += value * value; peak = Math.max(peak, Math.abs(value));
            }
            const rms = Math.sqrt(sum / samples.length);
            audible ||= rms >= 0.001;
            frames += samples.length;
            chunks.push(resampler.process(samples));
            armWatchdog();
            attempt(() => onLevel?.({ ...metadata, rms, peak, inputSampleRate: rate,
              durationMs: frames / rate * 1000, messageKey: 'seq.inputLevel' }));
            if (frames >= rate * 30) finish('success', undefined, 'limit');
          } catch { finish('error', 'MICROPHONE_UNAVAILABLE'); }
        };
        source.connect(node);
        node.connect(context.destination);
        platform.clearTimeout(timer);
        timer = platform.setTimeout(() => finish('success', undefined, 'limit'), MAX_CAPTURE_MS);
        warning = platform.setTimeout(() => attempt(() => onWarning?.({ ...metadata,
          messageKey: 'seq.recordingEnding' })), 25000);
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
