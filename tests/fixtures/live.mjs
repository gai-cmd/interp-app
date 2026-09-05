// Browser-shaped transport fixtures; no network, Node ws, or credentials retained.
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function createSocketFixture({ autoClose = true, throwSend = false, throwClose = false,
  throwConstruct = false, inspectURL } = {}) {
  const sockets = [];
  class WebSocket {
    constructor(url) {
      inspectURL?.(url);
      if (throwConstruct) throw new Error('SECRET constructor URL');
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.listeners = new Map();
      this.sent = [];
      this.closeCalls = 0;
      sockets.push(this);
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type, fields = {}) {
      for (const callback of [...(this.listeners.get(type) ?? [])]) callback({ type, target: this, ...fields });
    }
    open() { this.readyState = 1; this.emit('open'); }
    message(data) { this.emit('message', { data }); }
    json(value) { this.message(JSON.stringify(value)); }
    send(text) {
      if (throwSend || this.readyState !== 1) throw new Error('SECRET send');
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.closeCalls++;
      if (throwClose) throw new Error('SECRET close');
      this.readyState = 2;
      if (autoClose) queueMicrotask(() => this.finishClose());
    }
    finishClose(code = 1000, reason = 'SECRET key=https://private/') {
      this.readyState = 3; this.emit('close', { code, reason });
    }
    get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  }
  return { WebSocket, sockets };
}
export class DelayedBlob extends Blob {
  constructor(text, gate) { super([text]); this.gate = gate; }
  async arrayBuffer() { await this.gate.promise; return super.arrayBuffer(); }
}
export function createClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, value] = entry; timers.delete(id); now = value.at; value.callback();
      }
      now = end;
    },
    get size() { return timers.size; },
  };
}
