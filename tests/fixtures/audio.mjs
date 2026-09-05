// Deterministic synthetic audio only; no recorded speech.
export function tone(sampleRate, frequency, length = sampleRate, amplitude = 0.5) {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate));
}

export function join(parts, Type = Float32Array) {
  const result = new Type(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function chunks(samples, sizes = [1, 127, 128, 511, 3, 1024, 17]) {
  const result = [];
  for (let offset = 0, i = 0; offset < samples.length; i++) {
    const end = Math.min(samples.length, offset + sizes[i % sizes.length]);
    result.push(samples.subarray(offset, end));
    offset = end;
  }
  return result;
}

export function rms(samples, trim = 128) {
  let energy = 0;
  for (let i = trim; i < samples.length - trim; i++) energy += samples[i] ** 2;
  return Math.sqrt(energy / (samples.length - 2 * trim));
}

// Independently specified canonical 16 kHz WAV containing -32768, 0, 32767.
export const goldenWav = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 42, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0,
  0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0,
  0x64, 0x61, 0x74, 0x61, 6, 0, 0, 0, 0, 0x80, 0, 0, 0xff, 0x7f,
);
