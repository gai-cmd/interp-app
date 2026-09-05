import test from 'node:test';
import assert from 'node:assert/strict';
import { createResampler } from '../app/audio/resampler.js';
import { float32ToPCM16, pcm16ToFloat32, encodeWav, validateWav } from '../app/audio/wav.js';
import { tone, join, chunks, rms, goldenWav } from './fixtures/audio.mjs';

function convert(inputSampleRate, samples, sizes) {
  const resampler = createResampler({ inputSampleRate });
  const parts = sizes ? chunks(samples, sizes) : [samples];
  return join([...parts.map(part => resampler.process(part)), resampler.flush()]);
}

for (const rate of [44100, 48000]) {
  test(`${rate} Hz: exact duration, passband amplitude and waveform timing`, () => {
    for (const frequency of [300, 1000, 6000]) {
      const output = convert(rate, tone(rate, frequency));
      assert.equal(output.length, 16000);
      assert.ok(Math.abs(rms(output) - 0.5 / Math.sqrt(2)) < 0.002);
      const reference = tone(16000, frequency);
      const difference = output.map((sample, i) => sample - reference[i]);
      assert.ok(rms(difference) < 0.002);
    }
  });

  test(`${rate} Hz: attenuates out-of-band tones by at least 60 dB`, () => {
    for (const frequency of [8500, 10000, 12000, 18000, 21000]) {
      const output = convert(rate, tone(rate, frequency));
      assert.ok(rms(output) < 0.5 / Math.sqrt(2) * 0.001, `frequency ${frequency}`);
    }
  });

  test(`${rate} Hz: frame partitioning preserves phase and filter history`, () => {
    const samples = tone(rate, 1234, rate + 137);
    samples[127] = 1;
    samples[128] = -1;
    samples[511] = 1;
    const expected = convert(rate, samples);
    assert.equal(expected.length, Math.floor(samples.length * 16000 / rate));
    for (const sizes of [[128], [1], [1, 127, 511, 3, 1024, 17]]) {
      assert.deepEqual(convert(rate, samples, sizes), expected);
    }
  });

  test(`${rate} Hz: silence, DC, empty frames and short final tails`, () => {
    assert.ok(convert(rate, new Float32Array(rate)).every(value => value === 0));
    const dc = convert(rate, new Float32Array(rate).fill(0.25));
    assert.ok(dc.subarray(128, -128).every(value => Math.abs(value - 0.25) < 1e-6));
    for (const length of [0, 1, 2, 3, 4, 95, 96, 97, 127, 128, 129, 1001]) {
      const samples = tone(rate, 1000, length);
      const stream = createResampler({ inputSampleRate: rate });
      assert.equal(stream.process(new Float32Array()).length, 0);
      const output = join([stream.process(samples), stream.process(new Float32Array()), stream.flush()]);
      assert.equal(output.length, Math.floor(length * 16000 / rate));
      assert.deepEqual(output, convert(rate, samples, [1]));
      assert.equal(stream.flush().length, 0);
      assert.throws(() => stream.process(samples), /AUDIO_STREAM_FINISHED/);
      stream.reset();
      assert.deepEqual(join([stream.process(samples), stream.flush()]), output);
    }
  });
}

test('equal-rate input is copied without filtering or quantization', () => {
  const stream = createResampler({ inputSampleRate: 16000 });
  const input = Float32Array.of(-1, 0.2, 0, 1);
  const output = stream.process(input);
  assert.deepEqual(output, input);
  output.fill(0);
  assert.equal(input[0], -1);
  assert.equal(stream.flush().length, 0);
});

test('invalid inputs are rejected without retaining values or corrupting state', () => {
  for (const inputSampleRate of [undefined, 0, -1, NaN, Infinity, 44100.5, '48000', 192001]) {
    assert.throws(() => createResampler({ inputSampleRate }), /AUDIO_INVALID_SAMPLE_RATE/);
  }
  assert.throws(() => createResampler({ inputSampleRate: 8000 }), /AUDIO_UPSAMPLING_UNSUPPORTED/);
  const stream = createResampler({ inputSampleRate: 48000 });
  const input = tone(48000, 1000, 400);
  const head = stream.process(input);
  for (const bad of [[0], 'private-input', Float32Array.of(NaN), Float32Array.of(Infinity)]) {
    assert.throws(() => stream.process(bad), { message: 'AUDIO_INVALID_SAMPLES' });
    assert.throws(() => float32ToPCM16(bad), { message: 'AUDIO_INVALID_SAMPLES' });
  }
  input.fill(0);
  assert.deepEqual(join([head, stream.flush()]), convert(48000, tone(48000, 1000, 400)));
});

test('PCM16 clips, rounds and writes explicitly little-endian', () => {
  assert.deepEqual(float32ToPCM16(Float32Array.of(-2, -1, -0.5, 0, 0.5, 1, 2)),
    Uint8Array.of(0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127));
  const output = float32ToPCM16(Float32Array.of(1 / 32767, -1 / 32768));
  assert.deepEqual(output, Uint8Array.of(1, 0, 255, 255));
});

test('PCM decoder honors unaligned view offsets and rejects truncated samples', () => {
  const backing = Uint8Array.of(99, 0, 128, 0, 64, 255, 127, 99);
  const expected = Float32Array.of(-1, 0.5, 32767 / 32768);
  assert.deepEqual(pcm16ToFloat32(backing.subarray(1, 7)), expected);
  assert.deepEqual(pcm16ToFloat32(new DataView(backing.buffer, 1, 6)), expected);
  assert.deepEqual(pcm16ToFloat32(backing.slice(1, 7).buffer), expected);
  assert.throws(() => pcm16ToFloat32(Uint8Array.of(0)), /AUDIO_INVALID_PCM_LENGTH/);
  assert.throws(() => pcm16ToFloat32(new Int16Array(2)), /AUDIO_INVALID_BYTES/);
});

test('WAV header and body match independently specified bytes', () => {
  const pcm = Uint8Array.of(0, 128, 0, 0, 255, 127);
  assert.deepEqual(encodeWav(pcm), goldenWav);
  const padded = join([Uint8Array.of(9), goldenWav, Uint8Array.of(9)], Uint8Array);
  const parsed = validateWav(new DataView(padded.buffer, 1, goldenWav.length), { sampleRate: 16000 });
  assert.deepEqual(parsed, { sampleRate: 16000, channels: 1, bitsPerSample: 16,
    sampleCount: 3, durationSeconds: 3 / 16000, pcm });
  parsed.pcm.fill(0);
  assert.equal(padded[46], 128);
  assert.deepEqual(encodeWav(new DataView(padded.buffer, 45, 6)), goldenWav);
});

test('WAV validator rejects malformed headers, lengths, formats and wrong rate', () => {
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const corrupt = goldenWav.slice();
    corrupt[offset] ^= 1;
    assert.throws(() => validateWav(corrupt), /AUDIO_INVALID_WAV/);
  }
  for (const length of [0, 12, 43, 44, 49]) {
    assert.throws(() => validateWav(goldenWav.slice(0, length)), /AUDIO_INVALID_WAV/);
  }
  assert.throws(() => validateWav(join([goldenWav, Uint8Array.of(0)], Uint8Array)), /AUDIO_INVALID_WAV/);
  assert.throws(() => validateWav(goldenWav, { sampleRate: 24000 }), /AUDIO_INVALID_WAV/);
  assert.throws(() => encodeWav(Uint8Array.of(0)), /AUDIO_INVALID_PCM_LENGTH/);
  assert.throws(() => encodeWav(new Uint8Array(), { sampleRate: NaN }), /AUDIO_INVALID_SAMPLE_RATE/);
  assert.equal(validateWav(encodeWav(new Uint8Array())).sampleCount, 0);
  assert.equal(validateWav(encodeWav(new Uint8Array(48000), { sampleRate: 24000 })).durationSeconds, 1);
});

test('chunked capture to PCM to WAV produces one second of 16 kHz mono audio', () => {
  const stream = createResampler({ inputSampleRate: 44100 });
  const pcm = join([...chunks(tone(44100, 1000)).map(part => float32ToPCM16(stream.process(part))),
    float32ToPCM16(stream.flush())], Uint8Array);
  const wav = encodeWav(pcm);
  const parsed = validateWav(wav, { sampleRate: 16000 });
  assert.equal(wav.length, 32044);
  assert.equal(parsed.sampleCount, 16000);
  assert.equal(parsed.durationSeconds, 1);
  assert.ok(Math.abs(rms(pcm16ToFloat32(parsed.pcm)) - 0.5 / Math.sqrt(2)) < 0.001);
});
