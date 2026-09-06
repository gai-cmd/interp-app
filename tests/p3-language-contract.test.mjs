import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLiveSetup, LIVE_MODELS } from '../app/providers/gemini/live-config.js';
import { PolicyError, POLICY_ERROR_CODES } from '../app/policy/runtime.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { errorKey, resolveKey, lastErrorDiagnostic } from '../app/ui/errors.js';
import { keyStoreErrorKey } from '../app/ui/settings-view.js';
import { listenFailure } from '../app/ui/sim-view.js';
const ko = JSON.parse(await readFile(new URL('../app/i18n/ko.json', import.meta.url)));
const i18n = { has: key => Object.hasOwn(ko, key) };

test('source selection never emits an unsupported translation field or excludes third languages', () => {
  for (const sourceLanguage of ['auto', 'ko', 'en', 'ja']) {
    const setup = buildLiveSetup({ sourceLanguage, targetLanguage: 'ja' });
    assert.deepEqual(setup.generationConfig.translationConfig, { targetLanguageCode: 'ja', echoTargetLanguage: false });
    assert.equal(setup.inputAudioTranscription, undefined);
    assert.deepEqual(setup.generationConfig.inputAudioTranscription, {});
  }
  const flash = buildLiveSetup({ model: LIVE_MODELS[1], sourceLanguage: 'ko', targetLanguage: 'ja' });
  assert.match(flash.systemInstruction.parts[0].text, /hint, not a filter/);
  assert.throws(() => buildLiveSetup({ sourceLanguage: 'invalid', targetLanguage: 'ja' }), { code: 'INVALID_REQUEST' });
});

test('policy reasons survive the session deadline and every UI error mapper', async () => {
  const manager = createSessionManager();
  try {
    for (const code of POLICY_ERROR_CODES) {
      await assert.rejects(manager.replace(() => { throw new PolicyError(code); },
        { signal: new AbortController().signal }), error => error.code === code);
      const error = new PolicyError(code);
      assert.equal(errorKey(error), `error.${code}`);
      assert.equal(keyStoreErrorKey(error), `error.${code}`);
      assert.equal(listenFailure(i18n, error).code, code);
      assert.equal(resolveKey(i18n, errorKey(error)), `error.${code}`);
      assert.equal(lastErrorDiagnostic(), code);
    }
  } finally { await manager.close(); }
});

test('unclassified diagnostics retain only fixed categories and registered codes', () => {
  listenFailure(i18n, { code: 'PRIVATE_KEY', message: 'private URL and speech', cause: {} });
  assert.equal(lastErrorDiagnostic(), 'UNCLASSIFIED_ERROR');
  resolveKey(i18n, 'PRIVATE_KEY');
  assert.equal(lastErrorDiagnostic(), 'UNRESOLVED_MESSAGE_KEY');
  resolveKey(i18n, 'error.PROVIDER_ERROR');
  assert.equal(lastErrorDiagnostic(), 'PROVIDER_ERROR');
});
