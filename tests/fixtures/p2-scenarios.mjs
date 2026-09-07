// P2-21 composition fixtures. Reuses P1 browser doubles; no legacy code port.
// Only browser boundaries are doubled. startApp builds all production engines.
import assert from 'node:assert/strict';
import { startApp } from '../../app/main.js';
import { createBrowser, choose, byClass, domText, secrets, live, until, tick } from './scenarios.mjs';
import { hello, caption } from './hub.mjs';
export { live, until, tick, caption };
export const roomCode = ['p221', 'room'].join('');
export const hubs = [{ id: 'integration', labelKey: 'hub.venue', url: 'wss://hub.example.invalid/ws' }];

export async function scenario(t, { personal = true, ...options } = {}) {
  const b = createBrowser(options);
  const BaseSocket = b.win.WebSocket;
  b.socketPeak = 0;
  b.win.WebSocket = class extends BaseSocket {
    constructor(url) {
      super(url);
      b.socketPeak = Math.max(b.socketPeak, b.sockets.filter(ws => ws.readyState !== 3).length);
      assert.ok(b.socketPeak <= 1, 'physical sockets, including closing sockets, must not overlap');
    }
  };
  // Keep scheduled sources alive until explicit completion/cancellation.
  const BaseAudio = b.win.AudioContext;
  b.sources = [];
  b.win.AudioContext = class extends BaseAudio {
    createBufferSource() {
      const source = { buffer: null, onended: null, stopped: false, connect() {}, disconnect() {},
        start() { b.audio.scheduled++; }, stop() { this.stopped = true; } };
      b.sources.push(source);
      return source;
    }
  };
  b.app = await startApp({ window: b.win, hubs, builtinKey: () => null, autoApplyUpdates: false });
  assert.ok(b.app);
  b.el = name => byClass(b.root, name);
  b.text = () => domText(b.root);
  t.after(async () => {
    for (const ws of b.sockets) ws.finishClose();
    await b.app.close();
  });
  if (personal) b.app.config.keyStore.setPersonal('gemini', secrets.personal);
  b.direct = async () => {
    await b.app.shell.switchTab('simultaneous');
    const count = b.sockets.length;
    const handle = b.app.listenEngines.direct.start({ targetLanguage: 'ja' });
    await until(() => b.audio.nodes.at(-1)?.port.onmessage);
    b.microphone.feed(new Float32Array(4096).fill(0.1));
    await until(() => b.sockets.length > count);
    const ws = b.sockets.at(-1);
    live.ready(ws); await handle.ready;
    return { handle, ws };
  };
  b.hub = async () => {
    await b.app.stopWork();
    await b.app.shell.switchTab('simultaneous');
    choose(b.el('sim-mode'), 'hub');
    await until(() => b.el('sim-mode').value === 'hub' && !b.el('sim-mode').disabled);
    const count = b.sockets.length;
    const handle = b.app.listenEngines.hub.join({ hubId: hubs[0].id, roomCode, language: 'ja' });
    await until(() => b.sockets.length > count);
    const ws = b.sockets.at(-1);
    ws.open(); ws.json(hello()); await handle.ready;
    return { handle, ws };
  };
  return b;
}
export function holdClose(ws) {
  ws.close = () => { ws.closeCalls++; ws.readyState = 2; };
}
export function observations(b) {
  return { dom: b.text(), location: b.win.location, history: b.win.history.states,
    storage: [...b.storage], operations: b.ops,
    sequential: b.app.engine.snapshot(), direct: b.app.listenEngines.direct.snapshot(),
    hub: b.app.listenEngines.hub.snapshot(), diagnostics: b.app.diagnostics.snapshot(),
    activity: b.app.activity.snapshot(), pwa: b.app.pwa.snapshot(),
    restURLs: b.gemini.calls.map(c => c.url), restBodies: b.gemini.calls.map(c => c.body),
    frames: b.sockets.map(ws => ws.sent) };
}
