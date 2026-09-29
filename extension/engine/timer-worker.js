// New implementation of docs/extension.md §5.13; no legacy code is ported.
// ENTRY (R10): the script behind engine/worker-timers.js. A dedicated worker runs the real timers and reports each
// expiry with a message, which the offscreen page handles as a task instead of a throttled timer callback.
// Plain script syntax (no import/export) so it runs unchanged as a module worker and under node:vm in tests.
const running = new Map();

globalThis.onmessage = ({ data }) => {
  if (data === null || typeof data !== 'object' || !Number.isSafeInteger(data.id)) return;
  if (data.t === 'set') {
    const { id } = data;
    clearTimeout(running.get(id));
    running.set(id, setTimeout(() => {
      running.delete(id);
      globalThis.postMessage({ t: 'fire', id });
    }, Math.max(0, Number(data.ms) || 0)));
  } else if (data.t === 'clear') {
    clearTimeout(running.get(data.id));
    running.delete(data.id);
  }
};
