/**
 * Ported from: ~/jarvis2/interp-web/lib/live.js
 * Symbols: LiveLane._dispatch, send, stop
 * Ported on: 2026-09-05
 * Source SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Also: ~/jarvis2/jp-patch/inject/main-handlers.js (voiceOpen PCM dispatch)
 * Source SHA-256: b00a8d33e6d2eea4c072c948b921b5b42f7ad0ad2a445e0f4b3eff074147e78b
 * Changes: Injected browser Live client, bounded PCM, independent assemblers;
 * no Node/Electron, audio discard, credentials, buffering, retries or rotation.
 */
import { ProviderError, assertActive, normalizeError } from '../contract.js';
import { SegmentAssembler } from '../../engine/segment-assembler.js';
import { buildLiveSetup, SIM_LIMITS } from './live-config.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = () => { throw new ProviderError('INVALID_RESULT'); };
function decodeAudio(inline) {
  if (!object(inline)) invalid();
  const { mimeType, data } = inline;
  // An omitted rate uses the documented Live output rate; other parameters fail closed.
  if (typeof mimeType !== 'string' || !/^audio\/pcm(?:;\s*rate=24000)?$/i.test(mimeType)) invalid();
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(SIM_LIMITS.maxAudioBytes / 3) * 4
    || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid();
  const binary = atob(data);
  if (btoa(binary) !== data || binary.length % 2 || binary.length > SIM_LIMITS.maxAudioBytes) invalid();
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function validateContent(content) {
  if (!object(content)) invalid();
  const encoded = JSON.stringify(content);
  if (encoded.length > SIM_LIMITS.maxContentBytes
    || new TextEncoder().encode(encoded).byteLength > SIM_LIMITS.maxContentBytes) invalid();
  for (const key of ['turnComplete', 'generationComplete', 'interrupted']) {
    if (content[key] !== undefined && typeof content[key] !== 'boolean') invalid();
  }
  for (const key of ['inputTranscription', 'outputTranscription']) {
    const t = content[key];
    if (t === undefined) continue;
    if (!object(t) || (t.text !== undefined && (typeof t.text !== 'string' || t.text.length > SIM_LIMITS.maxTranscriptChars))
      || (t.finished !== undefined && typeof t.finished !== 'boolean')) invalid();
  }
  if (content.modelTurn !== undefined && !object(content.modelTurn)) invalid();
  const parts = content.modelTurn?.parts;
  if (parts !== undefined && !Array.isArray(parts)) invalid();
  const audio = [];
  for (const part of parts ?? []) {
    if (!object(part)) invalid();
    if (part.inlineData !== undefined) audio.push(decodeAudio(part.inlineData));
  }
  return audio;
}

/**
 * createGeminiLive({ live, clock? }).open({ input: { format: 'pcm16' },
 * targetLanguage: 'ko'|'en'|'ja', model? }, routerContext).
 * live MUST be the same client instance used by voice; use the session manager.
 * sendAudio accepts 1..512 samples as Uint8Array PCM16 LE mono 16kHz.
 * finishInput ends input once, keeps receiving, and never locally completes a turn.
 * closed is the transport's physical-closure promise, not a cleanup deadline.
 */
export function createGeminiLive({ live, clock } = {}) {
  if (typeof live?.open !== 'function') throw new ProviderError('INVALID_REQUEST');
  return Object.freeze({ async open(request, context = {}) {
    try {
      assertActive(context.signal);
      if (!context.signal) throw new ProviderError('CREDENTIAL_REQUIRED');
      if (request?.input?.format !== 'pcm16') throw new ProviderError('INPUT_UNSUPPORTED');
      if ((request.input.sampleRate !== undefined && request.input.sampleRate !== 16000)
        || (request.input.channels !== undefined && request.input.channels !== 1)) throw new ProviderError('INPUT_UNSUPPORTED');
      const setup = buildLiveSetup(request);
      return await connect(setup, context);
    } catch (error) { throw normalizeError(error); }
  } });

  async function connect(setup, context) {
    let transport, closing, stopped = false, inputEnded = false, closedEmitted = false, failure;
    const ids = { turnId: context.turnId, sessionId: context.sessionId, generation: context.generation };
    const emit = (event) => {
      if (context.signal.aborted || (stopped && !['error', 'closed'].includes(event.type))) return;
      try { context.onEvent?.({ ...event, ...ids }); } catch { /* Consumer-owned failure. */ }
    };
    const assemblers = ['source', 'translation'].map((role) => new SegmentAssembler({
      sessionId: context.sessionId, generation: context.generation, role, ...(clock ? { clock } : {}),
      onSegment(s) {
        if (stopped) return;
        emit({ type: 'subtitle', role, segmentId: s.id, seq: s.sequence, revision: s.revision,
          final: s.status === 'final', ...(role === 'source'
            ? { sourceText: s.sourceText } : { translatedText: s.translatedText }) });
      },
    }));
    function stop() {
      stopped = true;
      context.signal.removeEventListener('abort', abort);
      for (const asm of assemblers) asm.cancel();
    }
    function close() {
      stop();
      if (transport && !closing) {
        closing = Promise.resolve().then(() => transport.close()).catch((error) => { throw normalizeError(error); });
        closing.catch(() => {});
      }
      return closing;
    }
    function abort() { close(); }
    function fail(error) {
      if (stopped) return;
      failure = normalizeError(error);
      stop();
      emit({ type: 'error', error: failure });
      close();
    }
    function handle(event) {
      if (event?.type === 'closed') {
        if (closedEmitted) return;
        closedEmitted = true;
        const notify = !stopped || Boolean(failure);
        stop();
        if (notify) emit({ type: 'closed' });
        return;
      }
      if (stopped || context.signal.aborted) return;
      try {
        if (event.type === 'error') { fail(event.error); return; }
        if (event.type === 'goAway') {
          if (!Number.isFinite(event.timeLeftMs) || event.timeLeftMs < 0) invalid();
          inputEnded = true;
          emit({ type: 'goAway', timeLeftMs: event.timeLeftMs });
          close();
          return;
        }
        if (event.type !== 'content') return;
        const c = event.content;
        const audio = validateContent(c);
        // Interruption wins over co-located completion/audio; never finalize a cut tail.
        if (c.interrupted) {
          for (const asm of assemblers) asm.interrupt();
          emit({ type: 'interrupted' });
          return;
        }
        for (const [index, key] of ['inputTranscription', 'outputTranscription'].entries()) {
          if (stopped) return;
          const t = c[key];
          if (t !== undefined) assemblers[index].push({ text: t.text ?? '', mode: 'delta', finished: t.finished ?? false });
        }
        for (const chunk of audio) {
          if (stopped) return;
          emit({ type: 'audio', audio: chunk, sampleRate: SIM_LIMITS.outputSampleRate });
        }
        if (!stopped && c.turnComplete) {
          for (const asm of assemblers) asm.turnComplete();
          if (!stopped) emit({ type: 'complete' });
        }
        // generationComplete is not a playback/turn boundary.
      } catch { fail(new ProviderError('INVALID_RESULT')); }
    }
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      transport = await live.open({ setup }, { ...context, onEvent: handle });
      if (stopped || context.signal.aborted) {
        await close();
        throw failure ?? new ProviderError(context.signal.aborted ? 'ABORTED' : 'SESSION_CLOSED');
      }
    } catch (error) { stop(); throw normalizeError(error); }
    function active() {
      assertActive(context.signal);
      if (stopped || inputEnded) throw new ProviderError('SESSION_CLOSED');
    }
    function send(message) {
      try { transport.send(message); }
      catch (error) { fail(error); throw normalizeError(error); }
    }
    return Object.freeze({ closed: transport.closed,
      async sendAudio(pcm) {
        active();
        if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2
          || pcm.byteLength > SIM_LIMITS.maxInputBytes) throw new ProviderError('INVALID_REQUEST');
        const data = btoa(String.fromCharCode(...pcm));
        send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
      },
      async finishInput() {
        assertActive(context.signal);
        if (stopped) throw new ProviderError('SESSION_CLOSED');
        if (inputEnded) return;
        inputEnded = true;
        // Default server VAD: https://ai.google.dev/api/live#bidigeneratecontentrealtimeinput
        send({ realtimeInput: { audioStreamEnd: true } });
      },
      close,
    });
  }
}
