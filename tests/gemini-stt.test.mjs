import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiStt } from '../app/providers/gemini/stt.js';
import { createGeminiTranslate } from '../app/providers/gemini/translate.js';
import { encodeWav } from '../app/audio/wav.js';
import { context } from './fixtures/gemini.mjs';

const request = () => ({ input: { format: 'wav', audio: encodeWav(new Uint8Array(32)) }, language: 'ja-JP' });

test('independent STT returns transcription only, including names and mixed languages', async () => {
  const expected = { sourceText: 'OpenAI 東京 12', detectedLanguage: 'mixed', status: 'ok' };
  let calls = 0;
  const stt = createGeminiStt({ rest: { async generateContent(req) {
    calls++; assert.match(req.instruction, /Transcribe only, without translating/);
    assert.match(req.instruction, /ja-JP/);
    assert.equal(req.parts[0].inlineData.mimeType, 'audio/wav');
    return { text: JSON.stringify(expected) };
  } } });
  const result = await stt(request(), context());
  assert.deepEqual(result, { ...expected, model: 'gemini-3.1-flash-lite' });
  assert.equal(calls, 1);
});

for (const status of ['no-speech', 'unrecognized']) {
  test(`${status} is a normal structured result for both capabilities`, async () => {
    for (const translate of [false, true]) {
      const raw = { sourceText: '', detectedLanguage: 'und', status,
        ...(translate ? { translatedText: '' } : {}) };
      const fn = (translate ? createGeminiTranslate : createGeminiStt)({ rest: {
        async generateContent() { return { text: JSON.stringify(raw) }; },
      } });
      assert.equal((await fn({ ...request(), targetLanguage: 'en' }, context())).status, status);
    }
  });
}

test('STT rejects text, broken WAV, bad hints and extra translation fields', async () => {
  let calls = 0;
  const stt = createGeminiStt({ rest: { async generateContent() {
    calls++; return { text: JSON.stringify({ sourceText: 'hello', translatedText: '안녕', detectedLanguage: 'en', status: 'ok' }) };
  } } });
  for (const req of [{ input: { format: 'text', text: 'hello' } },
    { input: { format: 'wav', audio: new Uint8Array(44) } }, { ...request(), language: 'invalid' }]) {
    await assert.rejects(stt(req, context()));
  }
  assert.equal(calls, 0);
  await assert.rejects(stt(request(), context()), { code: 'INVALID_RESULT' });
  assert.equal(calls, 1);
});

test('abort drops late results and never exposes abort reasons or raw errors', async () => {
  const controller = new AbortController();
  const stt = createGeminiStt({ rest: { async generateContent(req, ctx) {
    assert.equal(ctx.signal, controller.signal);
    controller.abort('synthetic-secret');
    return { text: '{}' };
  } } });
  await assert.rejects(stt(request(), context({ signal: controller.signal })), { code: 'ABORTED', message: 'ABORTED' });
  const broken = createGeminiStt({ rest: { async generateContent() { throw new Error('synthetic-secret'); } } });
  await assert.rejects(broken(request(), context()), (error) => {
    assert.equal(error.code, 'PROVIDER_ERROR');
    assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
    assert.equal(error.cause, undefined); return true;
  });
});
