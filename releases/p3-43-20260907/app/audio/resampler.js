// Original implementation for design-v0.6 §8.5/20; no legacy resampler was ported.

/**
 * Streaming mono Float32 PCM resampler. Pass the actual AudioContext rate.
 * process() returns Float32Array; concatenate its results and flush() once.
 * flush() zero-pads the edges and finishes at floor(inputLength * out / in).
 * reset() discards history for a new recording; never reset between frames.
 * Rates are integer Hz, 8–192 kHz; upsampling is intentionally unsupported.
 */
export function createResampler({ inputSampleRate, outputSampleRate = 16000 } = {}) {
  for (const rate of [inputSampleRate, outputSampleRate]) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) {
      throw new RangeError('AUDIO_INVALID_SAMPLE_RATE');
    }
  }
  if (outputSampleRate > inputSampleRate) throw new RangeError('AUDIO_UPSAMPLING_UNSUPPORTED');
  const ratio = inputSampleRate / outputSampleRate;
  const radius = Math.ceil(32 * ratio);
  const cutoff = 0.45 / ratio;
  // Rational phases avoid accumulating floating point timing error.
  let a = inputSampleRate;
  let b = outputSampleRate;
  while (b) [a, b] = [b, a % b];
  const step = inputSampleRate / a;
  const phases = outputSampleRate / a;
  const kernels = new Map();
  function kernel(phase) {
    if (kernels.has(phase)) return kernels.get(phase);
    const weights = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let j = -radius; j <= radius; j++) {
      const x = j - phase / phases;
      if (Math.abs(x) > radius) continue;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.42 + 0.5 * Math.cos(Math.PI * x / radius)
        + 0.08 * Math.cos(2 * Math.PI * x / radius);
      sum += weights[j + radius] = sinc * window;
    }
    for (let j = 0; j < weights.length; j++) weights[j] /= sum;
    if (kernels.size < 512) kernels.set(phase, weights);
    return weights;
  }
  let history = new Float32Array(0);
  let start = 0;
  let total = 0;
  let emitted = 0;
  let finished = false;
  function drain(final) {
    const limit = Math.floor(total * phases / step);
    const ready = final ? limit : Math.min(limit,
      Math.max(0, Math.ceil((total - radius) * phases / step)));
    const output = new Float32Array(Math.max(0, ready - emitted));
    for (let i = 0; i < output.length; i++, emitted++) {
      const position = emitted * step;
      const center = Math.floor(position / phases);
      const weights = kernel(position % phases);
      let value = 0;
      for (let j = -radius; j <= radius; j++) {
        const index = center + j;
        if (index >= 0 && index < total) value += history[index - start] * weights[j + radius];
      }
      output[i] = value;
    }
    const keepFrom = Math.min(total, Math.max(0, Math.floor(emitted * step / phases) - radius));
    history = history.slice(keepFrom - start);
    start = keepFrom;
    return output;
  }
  return Object.freeze({
    inputSampleRate, outputSampleRate,
    process(samples) {
      if (finished) throw new Error('AUDIO_STREAM_FINISHED');
      if (!(samples instanceof Float32Array)) throw new TypeError('AUDIO_INVALID_SAMPLES');
      for (const sample of samples) {
        if (!Number.isFinite(sample)) throw new TypeError('AUDIO_INVALID_SAMPLES');
      }
      if (inputSampleRate === outputSampleRate) return samples.slice();
      const next = new Float32Array(history.length + samples.length);
      next.set(history);
      next.set(samples, history.length);
      history = next;
      total += samples.length;
      return drain(false);
    },
    flush() {
      if (finished) return new Float32Array(0);
      finished = true;
      const output = drain(true);
      history = new Float32Array(0);
      return output;
    },
    reset() {
      history = new Float32Array(0);
      start = total = emitted = 0;
      finished = false;
    },
  });
}
