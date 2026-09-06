/**
 * Ported from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart/JpPcm.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: static module, mono input, transferable copy, silent output.
 * P3-02d: voice-band filter (first-order IIR high-pass ~80 Hz and low-pass
 * ~8 kHz, state kept across blocks) and an energy gate that replaces blocks
 * below an RMS threshold with digital silence, so the model's VAD does not
 * react to background music or noise. Both are on by default; the owner can
 * post { type: 'configure', filter, sensitivity } on the port. Gate state
 * changes are reported as { type: 'gate', open, rms } before the PCM block;
 * consumers that only accept Float32Array messages ignore them.
 */
const HIGH_PASS_HZ = 80;
const LOW_PASS_HZ = 8000;
// RMS after the filter (full scale 1.0). Deliberately conservative: a quiet
// speaker must pass; music rejection is best-effort. 'high' hears more.
const GATE_THRESHOLDS = Object.freeze({ low: 0.015, normal: 0.006, high: 0.002 });
// The gate stays open this long after the level drops, so word tails survive.
const GATE_HOLD_MS = 400;
const DEFAULT_CONFIG = Object.freeze({ filter: true, sensitivity: 'normal' });

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // AudioWorkletGlobalScope defines sampleRate; a test sandbox may not.
    this.rate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    const dt = 1 / this.rate;
    const rc = (hz) => 1 / (2 * Math.PI * hz);
    this.highPassGain = rc(HIGH_PASS_HZ) / (rc(HIGH_PASS_HZ) + dt);
    // A low-pass at or above Nyquist is a pass-through.
    this.lowPassGain = LOW_PASS_HZ * 2 < this.rate ? dt / (rc(LOW_PASS_HZ) + dt) : 1;
    this.holdBlocks = Math.max(1, Math.ceil((GATE_HOLD_MS / 1000) * this.rate / 128));
    this.config = { ...DEFAULT_CONFIG };
    this.previousInput = 0; this.highPassOutput = 0; this.lowPassOutput = 0;
    this.hold = 0; this.open = null;
    this.port.onmessage = ({ data }) => this.configure(data);
  }

  configure(data) {
    if (!data || data.type !== 'configure') return;
    if (typeof data.filter === 'boolean') this.config.filter = data.filter;
    if (Object.hasOwn(GATE_THRESHOLDS, data.sensitivity)) this.config.sensitivity = data.sensitivity;
  }

  // Filter state persists across process() calls; never reset it per block.
  filter(samples) {
    let x1 = this.previousInput, hp = this.highPassOutput, lp = this.lowPassOutput;
    const a = this.highPassGain, b = this.lowPassGain;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      hp = a * (hp + x - x1);
      x1 = x;
      lp += b * (hp - lp);
      samples[i] = lp;
    }
    this.previousInput = x1; this.highPassOutput = hp; this.lowPassOutput = lp;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    const samples = channel.slice();
    if (this.config.filter) this.filter(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    if (rms >= GATE_THRESHOLDS[this.config.sensitivity]) this.hold = this.holdBlocks;
    else if (this.hold > 0) this.hold--;
    const open = this.hold > 0;
    if (!open) samples.fill(0);
    if (open !== this.open) { this.open = open; this.port.postMessage({ type: 'gate', open, rms }); }
    this.port.postMessage(samples, [samples.buffer]);
    return true;
  }
}
registerProcessor('interp-capture', CaptureProcessor);
