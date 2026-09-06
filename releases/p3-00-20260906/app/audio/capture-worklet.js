/**
 * Ported from ~/jarvis2/jp-patch/inject/ambient-state.js, jpSimStart/JpPcm.
 * Date: 2026-09-05. Source SHA-256:
 * 7a0a3653557f2c173e0b3aab0e5b7a71f282e2212aa92a072b08af485a0b8e60
 * Changes: static module, mono input, transferable copy, silent output.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      const samples = channel.slice();
      this.port.postMessage(samples, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor('interp-capture', CaptureProcessor);
