/**
 * Ported from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart capture graph.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: injected platform, actual rate resampling, bounded PTT, no IPC/React,
 * static worklet, normalized results and cleanup across asynchronous races.
 * P3-02d: speech-only defaults. getUserMedia asks for noise suppression, echo
 * cancellation, automatic gain and (ideal, feature-detected) voice isolation;
 * the applied track settings are recorded for the settings/diagnostics UI; the
 * worklet receives the voice-band filter and gate sensitivity preferences and
 * reports gate state, which level events carry as gate: 'open' | 'closed'.
 */
import { createPlatform } from '../platform.js';
import { createResampler } from './resampler.js';
import { float32ToPCM16, encodeWav } from './wav.js';

export const MAX_CAPTURE_MS = 30000;
const attempt = fn => { try { return fn(); } catch { return undefined; } };
const stopTracks = stream => { for (const track of stream.getTracks()) attempt(() => track.stop()); };

// Gate sensitivity: 'high' passes quiet speakers, 'low' suits noisy venues.
export const AUDIO_SENSITIVITIES = Object.freeze(['low', 'normal', 'high']);
export const AUDIO_PREFERENCE_DEFAULTS = Object.freeze({ noiseSuppression: true, voiceFilter: true, sensitivity: 'normal' });
// Constraint names whose applied values the UI shows (track.getSettings()).
export const APPLIED_SETTING_NAMES = Object.freeze(['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation']);

/**
 * In-memory audio preferences shared by the settings view and every capture.
 * Minimal interface for P3-02d: the app has no personal preference store yet
 * (design-p3 P3-05), so this run-scoped store is the single owner. applied is
 * the last track.getSettings() observed by a capture, or null. Invalid patches
 * throw; nothing here touches storage or the browser.
 */
export function createAudioPreferences(initial = {}) {
  const listeners = new Set();
  let state = Object.freeze({ ...AUDIO_PREFERENCE_DEFAULTS, applied: null });
  const notify = () => { for (const fn of [...listeners]) attempt(() => fn(state)); };
  const store = Object.freeze({
    snapshot: () => state,
    set({ noiseSuppression = state.noiseSuppression, voiceFilter = state.voiceFilter, sensitivity = state.sensitivity } = {}) {
      if (typeof noiseSuppression !== 'boolean' || typeof voiceFilter !== 'boolean'
        || !AUDIO_SENSITIVITIES.includes(sensitivity)) throw new Error('INVALID_REQUEST');
      if (noiseSuppression === state.noiseSuppression && voiceFilter === state.voiceFilter && sensitivity === state.sensitivity) return state;
      state = Object.freeze({ ...state, noiseSuppression, voiceFilter, sensitivity });
      notify(); return state;
    },
    recordApplied(settings) {
      const applied = settings === null ? null : normalizeSettings(settings);
      state = Object.freeze({ ...state, applied });
      notify(); return state;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('INVALID_REQUEST');
      listeners.add(fn); return () => listeners.delete(fn);
    },
  });
  store.set(initial);
  return store;
}
export const audioPreferences = createAudioPreferences();

/** Only the known boolean constraints, as booleans or null (unsupported/unknown). */
export function normalizeSettings(settings) {
  const out = {};
  for (const name of APPLIED_SETTING_NAMES) {
    const value = settings?.[name];
    out[name] = typeof value === 'boolean' ? value : null;
  }
  return Object.freeze(out);
}

/**
 * getUserMedia audio constraints. Bare values are ideal, not required, so no
 * browser rejects the request. voiceIsolation is newer and differs between
 * Chrome and Safari: it is requested as ideal, and only when the browser's
 * supported-constraint list is unknown or includes it.
 */
export function microphoneConstraints({ noiseSuppression = true } = {}, supported = null) {
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: noiseSuppression !== false, autoGainControl: true };
  if (!supported || supported.voiceIsolation === true) audio.voiceIsolation = { ideal: true };
  return { audio, video: false };
}

/**
 * Call start() directly from a user gesture, after stopping playback.
 * It returns {done, stop, cancel} synchronously, even during permission prompts.
 * done always resolves: success | silence | error | cancelled | interrupted.
 * Events/results contain dictionary keys and safe codes, never native errors.
 * A two-second missing-frame watchdog detects unavailable/stalled input; the
 * RMS threshold is an input heuristic, not speech recognition or a VAD claim.
 */
export function createCapture({ platform = createPlatform(), onLevel, onWarning, preferences = audioPreferences } = {}) {
  let active;
  function start({ signal, turnId, sessionId, generation } = {}) {
    if (active) throw new Error('INVALID_REQUEST');
    let resolve;
    const done = new Promise(r => { resolve = r; });
    let ended = false, stream, context, node, source, resampler;
    let frames = 0, audible = false, rate, timer, watchdog, warning;
    let chunks = [], settings = null, gate = 'open';
    const removers = [];
    const metadata = { turnId, sessionId, generation };
    // Preferences are read once per start; later changes apply to the next start.
    const prefs = attempt(() => preferences?.snapshot()) ?? AUDIO_PREFERENCE_DEFAULTS;
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
        sampleRate: 16000, durationMs: rate ? frames / rate * 1000 : 0, settings };
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
        const supported = attempt(() => platform.getSupportedConstraints?.()) ?? null;
        const incoming = await platform.getUserMedia(microphoneConstraints(prefs, supported));
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
        // What the browser actually applied, for the settings/diagnostics display.
        const observed = attempt(() => tracks[0].getSettings?.());
        settings = observed && typeof observed === 'object' ? normalizeSettings(observed) : null;
        attempt(() => preferences?.recordApplied(settings));
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
        // Worklet defaults already match the preference defaults; a missing port is not fatal.
        attempt(() => node.port.postMessage({ type: 'configure', filter: prefs.voiceFilter !== false,
          sensitivity: AUDIO_SENSITIVITIES.includes(prefs.sensitivity) ? prefs.sensitivity : 'normal' }));
        node.port.onmessage = ({ data }) => {
          if (ended) return;
          try {
            if (data?.type === 'gate') { gate = data.open === true ? 'open' : 'closed'; return; }
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
            attempt(() => onLevel?.({ ...metadata, rms, peak, gate, settings, inputSampleRate: rate,
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
