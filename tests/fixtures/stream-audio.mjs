// Synthetic PCM and independent wall/audio clocks; no recorded speech or services.
export const pcm = seconds => new Uint8Array(Math.round(seconds * 24000) * 2);

export function streamAudio() {
  let wall = 0, serial = 0;
  const timers = new Map(), made = [];
  const context = new EventTarget();
  Object.assign(context, { currentTime: 0, state: 'running', destination: {}, allocations: 0,
    resume: async () => { context.setState('running'); },
    setState(state) { this.state = state; this.dispatchEvent(new Event('statechange')); },
    createBuffer(channels, size, rate) {
      this.allocations++;
      const data = new Float32Array(size);
      return { channels, rate, data, getChannelData: () => data };
    },
    createBufferSource() {
      const source = { buffer: null, onended: null, stopped: false, disconnected: false,
        connect() {}, start(at) { this.at = at; },
        stop() { this.stopped = true; }, disconnect() { this.disconnected = true; } };
      made.push(source);
      return source;
    },
  });
  function advance(ms, audio = true) {
    const target = wall + ms;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      const next = entry ? entry[1].at : target;
      if (audio && context.state === 'running') context.currentTime += (next - wall) / 1000;
      wall = next;
      if (!entry) break;
      timers.delete(entry[0]); entry[1].fn();
    }
  }
  return { context, made, timers, advance, options: { context, now: () => wall,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: wall + ms }); return id; },
    clearTimeout(id) { timers.delete(id); } } };
}
