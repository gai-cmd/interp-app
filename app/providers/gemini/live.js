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
import { ProviderError, assertActive, invalidResult, isResumeHandle, normalizeError } from '../contract.js';
import { SegmentAssembler } from '../../engine/segment-assembler.js';
import { buildLiveSetup, SIM_LIMITS } from './live-config.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const USAGE_FIELDS = Object.freeze(['promptTokens', 'responseTokens', 'totalTokens', 'cachedTokens']);
// Every INVALID_RESULT of this adapter names why (contract.js INVALID_RESULT_REASONS).
const invalid = (reason) => { throw invalidResult(reason); };
// What the player can play: PCM16 mono at the Live output rate. An omitted
// rate is the documented Live output rate. The type is read as a parameter
// list (2026-09-30) so that a harmless variation — channels=1, other spacing,
// case or order, a parameter this code does not know — no longer ends a whole
// interpretation. A rate or channel count that says something else is not
// playable as it stands, and neither is any other type.
function playable(mimeType) {
  if (typeof mimeType !== 'string' || mimeType.length > 256) return false;
  const [type, ...parameters] = mimeType.split(';').map((item) => item.trim().toLowerCase());
  if (type !== 'audio/pcm') return false;
  for (const parameter of parameters) {
    const at = parameter.indexOf('=');
    const name = (at < 0 ? parameter : parameter.slice(0, at)).trim();
    // A quoted value is the same value (MIME allows both spellings).
    const value = at < 0 ? '' : parameter.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
    if (name === 'rate' && value !== String(SIM_LIMITS.outputSampleRate)) return false;
    if (name === 'channels' && value !== '1') return false;
  }
  return true;
}
// Returns the decoded bytes, or { skip, dropped } for a part that is left out
// without ending the session: one bad part costs at most a moment of sound,
// which the engine marks as an audio gap when something playable was lost.
// The size limits and a payload that is not canonical base64 stay fatal.
function decodeAudio(inline) {
  if (!object(inline)) invalid('parts-shape');
  const { mimeType, data } = inline;
  if (!playable(mimeType)) {
    return { skip: 'audio-mime', dropped: typeof mimeType === 'string' && /^\s*audio\//i.test(mimeType)
      && typeof data === 'string' && data.length > 0 };
  }
  if (typeof data !== 'string') invalid('audio-encoding');
  if (!data.length) return { skip: 'audio-empty', dropped: false };
  if (data.length > Math.ceil(SIM_LIMITS.maxAudioBytes / 3) * 4) invalid('audio-size');
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid('audio-encoding');
  const binary = atob(data);
  if (btoa(binary) !== data) invalid('audio-encoding');
  if (binary.length > SIM_LIMITS.maxAudioBytes) invalid('audio-size');
  // An odd byte count is not refused here: see align() in connect().
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
// The whole message is validated before anything of it is emitted. Returns the
// decoded audio parts in order and the parts that were skipped.
function validateContent(content) {
  if (!object(content)) invalid('content-shape');
  const encoded = JSON.stringify(content);
  if (encoded.length > SIM_LIMITS.maxContentBytes
    || new TextEncoder().encode(encoded).byteLength > SIM_LIMITS.maxContentBytes) invalid('content-size');
  for (const key of ['turnComplete', 'generationComplete', 'interrupted']) {
    if (content[key] !== undefined && typeof content[key] !== 'boolean') invalid('flag-shape');
  }
  for (const key of ['inputTranscription', 'outputTranscription']) {
    const t = content[key];
    if (t === undefined) continue;
    if (!object(t) || (t.text !== undefined && typeof t.text !== 'string')
      || (t.finished !== undefined && typeof t.finished !== 'boolean')) invalid('transcript-shape');
    if (t.text !== undefined && t.text.length > SIM_LIMITS.maxTranscriptChars) invalid('transcript-size');
  }
  if (content.modelTurn !== undefined && !object(content.modelTurn)) invalid('parts-shape');
  const parts = content.modelTurn?.parts;
  if (parts !== undefined && !Array.isArray(parts)) invalid('parts-shape');
  const audio = [], skipped = [];
  for (const part of parts ?? []) {
    if (!object(part)) invalid('parts-shape');
    if (part.inlineData === undefined) continue;
    const decoded = decodeAudio(part.inlineData);
    if (decoded instanceof Uint8Array) audio.push(decoded); else skipped.push(decoded);
  }
  return { audio, skipped };
}

/**
 * createGeminiLive({ live, clock? }).open({ input: { format: 'pcm16' },
 * targetLanguage: 'ko'|'en'|'ja', model? }, routerContext).
 * live MUST be the same client instance used by voice; use the session manager.
 * sendAudio accepts 1..512 samples as Uint8Array PCM16 LE mono 16kHz and
 * resolves with the bytes still in the socket's send buffer (a number only).
 * finishInput ends input once, keeps receiving, and never locally completes a turn.
 * closed is the transport's physical-closure promise, not a cleanup deadline.
 * request.resumeHandle (optional) asks the instruction-driven setup to resume
 * an earlier session of the same operation; the translation route ignores it.
 * goAway is advisory (2026-09-30): it is forwarded and the session keeps
 * sending and receiving until the engine closes it. resumption {handle} and
 * usage {...} are forwarded as validated numbers/handles; malformed ones are
 * dropped without ending the session.
 * 2026-09-30: one unplayable part no longer ends the interpretation. A part
 * that is not 24 kHz mono PCM, or has no data, is left out; a part with an odd
 * byte count is joined with the next one of the same turn, as a streaming
 * PCM16 decoder does. Each is reported as anomaly {reason, dropped}. The
 * memory bounds and wrong field types still end the connection with
 * INVALID_RESULT, and error.reason then says which check it was.
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
    // PCM16 samples are two bytes, and a chunk may end between them. The
    // dangling byte is the first half of a sample whose second half opens the
    // next chunk, so it is carried there instead of being refused (which ended
    // the session) or dropped (which would shift every later sample by one
    // byte into noise). A turn boundary, an interruption and a new connection
    // (this closure) start clean: half a sample is not worth keeping across them.
    let carry = null;
    function align(chunk) {
      if (chunk.byteLength % 2) emit({ type: 'anomaly', reason: 'audio-odd-bytes', dropped: false });
      if (carry === null && chunk.byteLength % 2 === 0) return chunk;
      const joined = new Uint8Array((carry === null ? 0 : 1) + chunk.byteLength);
      if (carry !== null) joined[0] = carry;
      joined.set(chunk, carry === null ? 0 : 1);
      const dangling = joined.byteLength % 2 === 1;
      carry = dangling ? joined[joined.byteLength - 1] : null;
      // An exact-length copy: the player reads whole samples from what it is given.
      return joined.slice(0, joined.byteLength - (dangling ? 1 : 0));
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
          if (!Number.isFinite(event.timeLeftMs) || event.timeLeftMs < 0) invalid('goaway-shape');
          // Advisory only: input and output continue; the engine decides when
          // to hand over and closes this session itself.
          emit({ type: 'goAway', timeLeftMs: event.timeLeftMs });
          return;
        }
        if (event.type === 'resumption') {
          if (event.handle === null || isResumeHandle(event.handle)) emit({ type: 'resumption', handle: event.handle });
          return;
        }
        if (event.type === 'usage') {
          const report = Object.fromEntries(USAGE_FIELDS.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
          if (Object.keys(report).length && Object.values(report).every(count)) emit({ type: 'usage', ...report });
          return;
        }
        if (event.type !== 'content') return;
        const c = event.content;
        const { audio, skipped } = validateContent(c);
        // Counted first, so an interruption in the same message cannot hide them.
        // What an interruption cuts anyway was not lost to the anomaly.
        for (const part of skipped) {
          emit({ type: 'anomaly', reason: part.skip, dropped: part.dropped && c.interrupted !== true });
        }
        // Interruption wins over co-located completion/audio; never finalize a cut tail.
        if (c.interrupted) {
          carry = null;
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
          const pcm = align(chunk);
          // A lone half sample yields nothing to play yet.
          if (pcm.byteLength && !stopped) emit({ type: 'audio', audio: pcm, sampleRate: SIM_LIMITS.outputSampleRate });
        }
        if (!stopped && c.turnComplete) {
          carry = null;
          for (const asm of assemblers) asm.turnComplete();
          if (!stopped) emit({ type: 'complete' });
        }
        // generationComplete is not a playback/turn boundary.
      } catch (error) {
        // A validation above names its reason; anything else thrown in here is
        // this adapter's own fault (2026-09-30: a browser "Illegal invocation"
        // from a timer surfaced exactly like a malformed server message).
        fail(error instanceof ProviderError && error.code === 'INVALID_RESULT' ? error : invalidResult('adapter-handler'));
      }
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
      try { return transport.send(message); }
      catch (error) { fail(error); throw normalizeError(error); }
    }
    return Object.freeze({ closed: transport.closed,
      async sendAudio(pcm) {
        active();
        if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2
          || pcm.byteLength > SIM_LIMITS.maxInputBytes) throw new ProviderError('INVALID_REQUEST');
        const data = btoa(String.fromCharCode(...pcm));
        // Resolves with the transport's buffered byte count (2026-09-30, see
        // uplink-queue backlog pacing); callers that do not pace ignore it.
        return send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
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
