// Synthetic browser boundaries; production capture/router/adapter/player compose unchanged.
import { createAppConfig } from '../../app/config.js';
import { createSimEngine } from '../../app/engine/sim.js';
import { createSessionManager } from '../../app/engine/session-manager.js';
import { streamAudio } from './stream-audio.mjs';
import { createSocketFixture, deferred, tick } from './live.mjs';
export { deferred, tick };

export function simFixture({ autoClose = true, permission, blocked = false } = {}) {
  const audio = streamAudio(), sockets = createSocketFixture({ autoClose });
  const config = createAppConfig({ WebSocket: sockets.WebSocket, fetch: async () => { throw Error('unexpected REST'); } });
  config.keyStore.setPersonal('gemini', 'synthetic-sim-credential');
  config.keyStore.select('gemini', 'personal');
  const manager = createSessionManager({ timeoutMs: 50 });
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false,
    stops: 0, stop() { this.stops++; this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = { connect() {}, disconnect() {}, port: { close() {} } };
  const micContext = Object.assign(new EventTarget(), { sampleRate: 16000, state: 'running', destination: {},
    resume: async () => {}, close: async () => { micContext.state = 'closed'; },
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }) });
  let micCalls = 0;
  const platform = { document: Object.assign(new EventTarget(), { hidden: false }), page: new EventTarget(),
    isSecureContext: true, isUserActive: () => true, createAudioContext: () => micContext,
    createWorkletNode: () => node, getUserMedia() { micCalls++; return permission?.promise ?? Promise.resolve(stream); },
    setTimeout: audio.options.setTimeout, clearTimeout: audio.options.clearTimeout };
  if (blocked) {
    audio.context.state = 'suspended';
    audio.context.resume = async () => { throw Error('synthetic blocked'); };
  }
  const calls = [];
  const engine = createSimEngine({ router: { call(...args) { calls.push(args[0]); return config.router.call(...args); } },
    sessionManager: manager, platform, getAudioContext: () => audio.context,
    resolveFallback: config.resolveFallback('gemini', 'live'), ...audio.options, random: () => 0.5 });
  const frame = (value = 0.25) => node.port.onmessage?.({ data: new Float32Array(1024).fill(value) });
  const start = (request = {}, context = {}) => engine.start({ targetLanguage: 'ko', ...request },
    { providerId: 'gemini', keySource: 'personal', sessionId: 'sim-test', ...context });
  async function open(socket = sockets.sockets.at(-1)) {
    socket.open(); socket.json({ setupComplete: {} }); await tick();
    return socket;
  }
  async function running(request) {
    const handle = start(request); await tick(); frame(); await tick(); await open(); await handle.ready; return handle;
  }
  return { engine, manager, config, audio, track, stream, platform, node, frame, start, open, running,
    calls, sockets: sockets.sockets, micCalls: () => micCalls,
    async close() {
      const closing = engine.close();
      for (const s of sockets.sockets) s.finishClose();
      await closing; await manager.close(); await config.dispose();
    } };
}

export const content = (socket, value) => socket.json({ serverContent: value });
export const audioContent = { modelTurn: { parts: [{ inlineData: { data: 'AQD/fw==', mimeType: 'audio/pcm;rate=24000' } }] } };
