// Synthetic protocol events; no microphone, credentials, or network.
export { fakeClock } from './segments.mjs';
export const request = { input: { format: 'pcm16' }, targetLanguage: 'ko' };
export const pcmContent = (data = 'AQD/fw==', mimeType = 'audio/pcm;rate=24000') => ({
  modelTurn: { parts: [{ inlineData: { data, mimeType } }] },
});
export function fakeLive({ deferred = false, closeError, openError } = {}) {
  let context, resolveOpen, resolveClosed;
  const calls = [], sent = [];
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let closes = 0;
  const session = { closed, send(message) { sent.push(message); },
    close() { closes++; return closeError ? Promise.reject(closeError) : closed; } };
  return { calls, sent, get closes() { return closes; }, session,
    emit(event) { context.onEvent(event); },
    content(content) { context.onEvent({ type: 'content', content }); },
    confirm() { resolveClosed(); context.onEvent({ type: 'closed' }); },
    resolve() { resolveOpen(session); },
    async open(req, ctx) {
      calls.push(req); context = ctx;
      if (openError) throw openError;
      if (deferred) return new Promise((resolve) => { resolveOpen = resolve; });
      return session;
    },
  };
}
