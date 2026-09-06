/**
 * Ported from: ~/jarvis2/interp-web/lib/translate.js
 * Symbols: translate REST request and candidate extraction
 * Ported on: 2026-09-05
 * Source SHA-256: 718fa137329f2ef4d5b0291ca3e445ddfcd1118fb2c7d01bc1fdf492c4d95cad
 * Changes: Header authentication, bounded streaming reads, cancellation,
 * deadline and sanitized errors. One attempt only; no runtime dependencies.
 */
import { ProviderError, assertActive, normalizeError } from '../contract.js';
import { withDeadline } from '../../engine/retry.js';
import { normalizeGeminiError } from './errors.js';
import { DEFAULT_MODEL, REST_ENDPOINT, REST_LIMITS, generationConfig } from './config.js';

function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Best effort. */ }
}
async function readBody(response, signal, maxBytes) {
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    cancel(response.body);
    throw new ProviderError('INVALID_RESULT');
  }
  if (!response.body?.getReader) throw new ProviderError('INVALID_RESULT');
  const reader = response.body.getReader();
  const abort = () => cancel(reader);
  signal.addEventListener('abort', abort, { once: true });
  let complete = false;
  try {
    assertActive(signal);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let result = '';
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch { assertActive(signal); throw new ProviderError('NETWORK_ERROR'); }
      const { done, value } = chunk;
      assertActive(signal);
      if (done) {
        complete = true;
        try { return result + decoder.decode(); }
        catch { throw new ProviderError('INVALID_RESULT'); }
      }
      size += value.byteLength;
      if (size > maxBytes) throw new ProviderError('INVALID_RESULT');
      try { result += decoder.decode(value, { stream: true }); }
      catch { throw new ProviderError('INVALID_RESULT'); }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) cancel(reader);
    reader.releaseLock();
  }
}

function requestBody(request) {
  const { model = DEFAULT_MODEL, instruction, parts } = request;
  const config = generationConfig(model);
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > REST_LIMITS.maxTextLength
    || !Array.isArray(parts) || !parts.length || parts.length > 2) throw new ProviderError('INVALID_REQUEST');
  let audioCount = 0;
  const safeParts = parts.map((part) => {
    if (!part || typeof part !== 'object' || Object.keys(part).length !== 1) throw new ProviderError('INVALID_REQUEST');
    if (Object.hasOwn(part, 'text') && typeof part.text === 'string' && part.text.trim()
      && part.text.length <= REST_LIMITS.maxTextLength) return { text: part.text };
    const data = part.inlineData;
    if (!data || Object.keys(data).length !== 2 || data.mimeType !== 'audio/wav'
      || typeof data.data !== 'string' || !data.data.length || ++audioCount > 1
      || data.data.length > 4 * Math.ceil(REST_LIMITS.maxAudioBytes / 3)
      || data.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)) {
      throw new ProviderError('INVALID_REQUEST');
    }
    const bytes = data.data.length / 4 * 3 - (data.data.endsWith('==') ? 2 : data.data.endsWith('=') ? 1 : 0);
    if (bytes > REST_LIMITS.maxAudioBytes) throw new ProviderError('INVALID_REQUEST');
    return { inlineData: { mimeType: 'audio/wav', data: data.data } };
  });
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: safeParts }], generationConfig: config });
  if (new TextEncoder().encode(body).byteLength > REST_LIMITS.maxRequestBytes) throw new ProviderError('INVALID_REQUEST');
  return { model, body };
}

function extractText(body) {
  if (body?.promptFeedback?.blockReason && body.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    throw new ProviderError('SAFETY_BLOCKED');
  }
  const candidate = body?.candidates?.[0];
  const reason = candidate?.finishReason;
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(reason)
    || candidate?.safetyRatings?.some((rating) => rating.blocked === true)) throw new ProviderError('SAFETY_BLOCKED');
  if (reason !== 'STOP' || !Array.isArray(candidate?.content?.parts)) throw new ProviderError('INVALID_RESULT');
  const visible = candidate.content.parts.filter((part) => part?.thought !== true);
  if (!visible.length || visible.some((part) => typeof part?.text !== 'string'
    || part.functionCall || part.inlineData)) throw new ProviderError('INVALID_RESULT');
  const text = visible.map((part) => part.text).join('');
  if (!text.trim()) throw new ProviderError('INVALID_RESULT');
  return text;
}

/**
 * generateContent({ model?, instruction, parts }, context) -> { text, model }.
 * P1-08 owns prompts, WAV encoding and validateOutput; this transport never
 * guesses the capability or treats valid JSON as a valid translation.
 * resolveCredential uses keyStore.resolveCredential(reference, address, {signal}).
 * The router owns the shared attempt budget; this boundary never consumes twice.
 * request options cannot override endpoint, headers, or generation settings.
 */
export function createGeminiRest({ fetch: fetchImpl = globalThis.fetch, resolveCredential,
  timeoutMs = REST_LIMITS.timeoutMs, maxResponseBytes = REST_LIMITS.maxResponseBytes,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  if (typeof fetchImpl !== 'function' || typeof resolveCredential !== 'function'
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > REST_LIMITS.maxResponseBytes
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > REST_LIMITS.timeoutMs) throw new ProviderError('INVALID_REQUEST');
  return Object.freeze({
    async generateContent(request, context = {}) {
      try {
        assertActive(context.signal);
        if (context.providerId !== 'gemini' || context.transport !== 'direct'
          || !['personal', 'shared'].includes(context.keySource)) throw new ProviderError('CREDENTIAL_MISMATCH');
        if (!context.signal || context.credentialRef == null) throw new ProviderError('CREDENTIAL_REQUIRED');
        const { model, body } = requestBody(request);
        return await withDeadline(async (signal) => {
          const address = { providerId: 'gemini', keySource: context.keySource, transport: 'direct' };
          const key = await resolveCredential(context.credentialRef, address, { signal });
          assertActive(signal);
          if (typeof key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(key)) throw new ProviderError('CREDENTIAL_REQUIRED');
          let response;
          try {
            response = await fetchImpl(`${REST_ENDPOINT}/${model}:generateContent`, {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
              body, signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
            });
          } catch { assertActive(signal); throw new ProviderError('NETWORK_ERROR'); }
          if (signal.aborted) { cancel(response.body); assertActive(signal); }
          let parsed;
          try { parsed = JSON.parse(await readBody(response, signal, maxResponseBytes)); }
          catch (error) {
            assertActive(signal);
            if (error instanceof ProviderError) throw error;
            // HTML/empty error bodies must not hide status or Retry-After.
            if (response.ok) throw new ProviderError('INVALID_RESULT');
          }
          if (!response.ok || parsed?.error) throw normalizeGeminiError({ status: response.status,
            headers: response.headers, body: parsed });
          return Object.freeze({ text: extractText(parsed), model });
        }, { signal: context.signal, timeoutMs, setTimeout, clearTimeout });
      } catch (error) { throw normalizeError(error); }
    },
  });
}
