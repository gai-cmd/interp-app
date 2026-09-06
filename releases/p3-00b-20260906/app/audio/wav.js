/**
 * Ported from: ~/jarvis2/jp-patch/inject/ambient-state.js
 * Symbols: jpSimStart PCM quantization in h.node.port.onmessage
 * Ported on: 2026-09-05
 * Source SHA-256: 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: Explicit LE bytes, nearest rounding, finite input validation;
 * new WAV encoder/validator. No React, Electron, base64 or browser globals.
 */

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof DataView) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('AUDIO_INVALID_BYTES');
}

function validateRate(rate) {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) {
    throw new RangeError('AUDIO_INVALID_SAMPLE_RATE');
  }
}

/** Convert normalized mono Float32 PCM to signed PCM16 LE, saturating at ±1. */
export function float32ToPCM16(samples) {
  if (!(samples instanceof Float32Array)) throw new TypeError('AUDIO_INVALID_SAMPLES');
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new TypeError('AUDIO_INVALID_SAMPLES');
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** Decode signed LE PCM (including offset views); reject partial samples. */
export function pcm16ToFloat32(pcm) {
  const bytes = bytesOf(pcm);
  if (bytes.byteLength % 2) throw new RangeError('AUDIO_INVALID_PCM_LENGTH');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** Wrap PCM16 LE bytes in a canonical 44-byte mono WAV header. Returns Uint8Array. */
export function encodeWav(pcm, { sampleRate = 16000 } = {}) {
  validateRate(sampleRate);
  const bytes = bytesOf(pcm);
  if (bytes.byteLength % 2 || bytes.byteLength > 0xffffffff - 36) {
    throw new RangeError('AUDIO_INVALID_PCM_LENGTH');
  }
  const wav = new Uint8Array(44 + bytes.byteLength);
  const view = new DataView(wav.buffer);
  function tag(offset, text) {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  }
  tag(0, 'RIFF');
  view.setUint32(4, 36 + bytes.byteLength, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, bytes.byteLength, true);
  wav.set(bytes, 44);
  return wav;
}

/**
 * Validate this app's canonical mono PCM16 WAV, not arbitrary media uploads.
 * Returns metadata and an owned PCM copy. Optional expected rate enforces API input.
 */
export function validateWav(wav, { sampleRate: expectedRate } = {}) {
  const bytes = bytesOf(wav);
  const invalid = () => { throw new RangeError('AUDIO_INVALID_WAV'); };
  if (bytes.byteLength < 44) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function tag(offset, text) {
    return [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  }
  const sampleRate = view.getUint32(24, true);
  const dataLength = view.getUint32(40, true);
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || view.getUint32(4, true) !== bytes.byteLength - 8
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || sampleRate < 8000 || sampleRate > 192000
    || view.getUint32(28, true) !== sampleRate * 2 || view.getUint16(32, true) !== 2
    || view.getUint16(34, true) !== 16 || dataLength % 2 || dataLength !== bytes.byteLength - 44) invalid();
  if (expectedRate !== undefined) {
    validateRate(expectedRate);
    if (expectedRate !== sampleRate) invalid();
  }
  return { sampleRate, channels: 1, bitsPerSample: 16, sampleCount: dataLength / 2,
    durationSeconds: dataLength / 2 / sampleRate, pcm: bytes.slice(44) };
}
