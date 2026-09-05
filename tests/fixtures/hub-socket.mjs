// Offline audience socket and deterministic time; reuse the browser-shaped P1 fixture.
export { createSocketFixture, deferred, DelayedBlob, tick } from './live.mjs';
export { hub, hello, caption, status, wire } from './hub.mjs';
export function createClock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    random: () => 0,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        timers.delete(id); time = timer.at; timer.callback();
      }
      time = end;
    },
    get size() { return timers.size; },
  };
}
