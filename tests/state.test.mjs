import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createState, SEQ_STATUS, TURN_PHASE, STATUS_MESSAGE_KEYS, PHASE_MESSAGE_KEYS, VOICE_OUTPUTS, MAX_TURNS } from '../app/state.js';
import { APP_DEFAULTS } from '../app/config.js';
import { ProviderError } from '../app/providers/contract.js';

const code = (expected) => (error) => error instanceof ProviderError && error.code === expected;
const ok = (changes = {}) => ({ sourceText: '사과 12개', translatedText: 'りんご12個', detectedLanguage: 'ko', status: 'ok', model: 'test-model', ...changes });
function setup() {
  let clock = 0;
  const store = createState({ sessionId: 'session-1', now: () => ++clock });
  const changes = [];
  store.subscribe((snapshot) => changes.push(snapshot));
  return { store, changes, turn: (id = 'turn-1') => store.snapshot().turns.find((t) => t.turnId === id) };
}
const deepFrozen = (value) => value === null || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

test('defaults come from app config, records stay OFF and snapshots are frozen data', () => {
  const { store } = setup();
  const s = store.snapshot();
  assert.equal(s.sessionId, 'session-1');
  assert.equal(s.generation, 0);
  assert.equal(s.status, SEQ_STATUS.IDLE);
  assert.equal(s.activeTurnId, null);
  assert.equal(s.keySelection, null);
  assert.equal(s.transport, APP_DEFAULTS.transport);
  assert.deepEqual(s.interpretation, { ...APP_DEFAULTS.interpretation });
  assert.deepEqual(s.voice, { output: 'provider', allowDeviceFallback: true, voice: null, deviceVoiceURI: null });
  assert.deepEqual(s.records, { persist: false, messageKey: 'records.off' });
  assert.deepEqual(s.turns, []);
  assert.ok(deepFrozen(s));
  assert.equal(typeof store.setRecords, 'undefined');
  assert.throws(() => createState({ sessionId: 'bad id' }), code('INVALID_REQUEST'));
  assert.throws(() => createState({ sessionId: 's', defaults: { ...APP_DEFAULTS, transport: 'hub' } }), code('INVALID_REQUEST'));
  assert.deepEqual([...VOICE_OUTPUTS], ['provider', 'device', 'off']);
});

test('status and phase keys exist in every dictionary', async () => {
  for (const language of ['ko', 'en', 'ja']) {
    const dictionary = JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'));
    for (const key of [...Object.values(STATUS_MESSAGE_KEYS), ...Object.values(PHASE_MESSAGE_KEYS), 'records.off']) {
      assert.equal(typeof dictionary[key], 'string', `${language}:${key}`);
    }
  }
  assert.deepEqual(Object.keys(STATUS_MESSAGE_KEYS).sort(), Object.values(SEQ_STATUS).sort());
  assert.deepEqual(Object.keys(PHASE_MESSAGE_KEYS).sort(), Object.values(TURN_PHASE).sort());
});

test('settings are validated and stored separately from turns', () => {
  const { store } = setup();
  store.setKeySelection({ providerId: 'gemini', keySource: 'shared', extra: 'SECRET' });
  assert.deepEqual(store.snapshot().keySelection, { providerId: 'gemini', keySource: 'shared' });
  store.setKeySelection(null);
  assert.equal(store.snapshot().keySelection, null);
  assert.throws(() => store.setKeySelection({ providerId: 'gemini', keySource: 'hub' }), code('INVALID_REQUEST'));
  store.setInterpretation({ sourceLanguage: 'auto', targetLanguage: 'en' });
  assert.deepEqual(store.snapshot().interpretation, { sourceLanguage: 'auto', targetLanguage: 'en' });
  assert.throws(() => store.setInterpretation({ sourceLanguage: 'en', targetLanguage: 'en' }), code('INVALID_REQUEST'));
  assert.throws(() => store.setInterpretation({ sourceLanguage: 'ko', targetLanguage: 'fr' }), code('INVALID_REQUEST'));
  assert.throws(() => store.setInterpretation({ sourceLanguage: 'auto', targetLanguage: 'auto' }), code('INVALID_REQUEST'));
  store.setVoice({ output: 'device' });
  assert.deepEqual(store.snapshot().voice, { output: 'device', allowDeviceFallback: true, voice: null, deviceVoiceURI: null });
  store.setVoice({ voice: 'Kore', allowDeviceFallback: false });
  assert.equal(store.snapshot().voice.voice, 'Kore');
  assert.equal(store.snapshot().voice.allowDeviceFallback, false);
  assert.throws(() => store.setVoice({ output: 'loud' }), code('INVALID_REQUEST'));
  assert.throws(() => store.setVoice({ voice: 'bad voice' }), code('INVALID_REQUEST'));
  store.setNotice('mode.changed');
  assert.equal(store.snapshot().notice.messageKey, 'mode.changed');
  store.setNotice(null);
  assert.equal(store.snapshot().notice, null);
  assert.throws(() => store.setNotice('not a key'), code('INVALID_REQUEST'));
  assert.equal(store.invalidate(), 1);
  assert.equal(store.invalidate('settings.keyDeleted'), 2);
  assert.equal(store.snapshot().notice.messageKey, 'settings.keyDeleted');
  assert.equal(store.snapshot().status, SEQ_STATUS.IDLE);
});

test('a text turn commits its translation once and keeps it through the voice outcome', () => {
  const { store, changes, turn } = setup();
  assert.equal(store.beginTurn({ turnId: 'turn-1', input: 'text', sourceText: '사과 12개' }), 'turn-1');
  assert.equal(store.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.equal(store.snapshot().activeTurnId, 'turn-1');
  assert.deepEqual({ ...turn() }, { turnId: 'turn-1', sequence: 1, input: 'text', phase: TURN_PHASE.TRANSLATING, createdAt: 1, endedAt: null,
    sourceLanguage: 'ko', targetLanguage: 'ja', sourceText: '사과 12개', translatedText: '', detectedLanguage: null, model: null,
    messageKey: undefined, errorCode: null, attempts: 1, voice: null });
  assert.throws(() => store.beginTurn({ turnId: 'turn-2', input: 'text', sourceText: 'x' }), code('INVALID_REQUEST'));
  assert.equal(store.commitTranslation('turn-1', ok()), true);
  assert.equal(turn().phase, TURN_PHASE.COMPLETED);
  assert.equal(turn().translatedText, 'りんご12個');
  assert.equal(turn().model, 'test-model');
  // The turn stays active for voice; a second (late) result is ignored.
  assert.equal(store.snapshot().activeTurnId, 'turn-1');
  assert.equal(store.commitTranslation('turn-1', ok({ translatedText: '다른 결과' })), false);
  assert.equal(turn().translatedText, 'りんご12個');
  assert.equal(store.beginSpeaking('turn-1'), true);
  assert.equal(store.snapshot().status, SEQ_STATUS.SPEAKING);
  assert.equal(store.setVoiceResult('turn-1', { status: 'failed', engine: 'live', messageKey: 'error.VOICE_FAILED',
    errorCode: 'INVALID_RESULT', deviceFallbackAvailable: true, secret: 'SECRET' }), true);
  assert.deepEqual({ ...turn().voice }, { status: 'failed', engine: 'live', messageKey: 'error.VOICE_FAILED', errorCode: 'INVALID_RESULT',
    fallback: false, deviceFallbackAvailable: true, gap: false, said: '' });
  // Voice failure never deletes or downgrades the translation.
  assert.equal(turn().phase, TURN_PHASE.COMPLETED);
  assert.equal(turn().translatedText, 'りんご12個');
  assert.equal(store.finishTurn('turn-1'), true);
  assert.equal(store.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(store.snapshot().activeTurnId, null);
  assert.equal(turn().endedAt, 2);
  assert.equal(store.finishTurn('turn-1'), false);
  assert.equal(JSON.stringify(store.snapshot()).includes('SECRET'), false);
  assert.equal(changes.length, 5);
  assert.ok(changes.every(deepFrozen));
  assert.throws(() => store.beginTurn({ turnId: 'turn-1', input: 'text', sourceText: 'x' }), code('INVALID_REQUEST'));
  assert.equal(store.commitTranslation('turn-1', ok()), false);
});

test('a voice turn records, translates, and treats silence and unrecognized speech as normal results', () => {
  const { store, turn } = setup();
  store.beginTurn({ turnId: 'turn-1', input: 'voice' });
  assert.equal(store.snapshot().status, SEQ_STATUS.RECORDING);
  assert.equal(turn().phase, TURN_PHASE.RECORDING);
  assert.throws(() => store.beginTurn({ turnId: 'turn-9', input: 'voice', sourceText: 'x' }), code('INVALID_REQUEST'));
  // An ok result cannot skip the translating phase; silence from capture can end it.
  assert.equal(store.commitTranslation('turn-1', ok()), false);
  assert.equal(store.beginTranslating('turn-1'), true);
  assert.equal(store.beginTranslating('turn-1'), false);
  assert.equal(store.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.equal(store.commitTranslation('turn-1', { sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'unrecognized', model: 'test-model' }), true);
  assert.equal(turn().phase, TURN_PHASE.UNRECOGNIZED);
  assert.equal(turn().messageKey, 'seq.unrecognized');
  assert.equal(turn().errorCode, null);
  assert.equal(store.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(store.snapshot().activeTurnId, null);
  assert.equal(store.beginSpeaking('turn-1'), false);
  assert.equal(store.setVoiceResult('turn-1', { status: 'completed' }), false);
  store.beginTurn({ turnId: 'turn-2', input: 'voice' });
  assert.equal(store.commitTranslation('turn-2', { sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'no-speech', model: null }), true);
  assert.equal(turn('turn-2').phase, TURN_PHASE.SILENCE);
  assert.equal(turn('turn-2').messageKey, 'seq.silence');
  assert.equal(turn('turn-2').endedAt, 4);
  assert.equal(store.snapshot().activeTurnId, null);
  store.beginTurn({ turnId: 'turn-3', input: 'voice' });
  assert.equal(store.failTurn('turn-3', { errorCode: 'MICROPHONE_DENIED', messageKey: 'error.MICROPHONE_DENIED' }), true);
  assert.equal(turn('turn-3').phase, TURN_PHASE.ERROR);
  assert.equal(turn('turn-3').errorCode, 'MICROPHONE_DENIED');
  assert.equal(store.failTurn('turn-3', { errorCode: 'TIMEOUT' }), false);
  assert.equal(turn('turn-3').errorCode, 'MICROPHONE_DENIED');
  assert.throws(() => store.failTurn('turn-3', { errorCode: 'secret key' }), code('INVALID_REQUEST'));
  store.beginTurn({ turnId: 'turn-4', input: 'text', sourceText: 'x' });
  assert.equal(store.failTurn('turn-4', { errorCode: 'INVALID_KEY' }), true);
  assert.equal(turn('turn-4').messageKey, 'error.INVALID_KEY');
  assert.equal(store.commitTranslation('turn-4', ok()), false);
  assert.equal(turn('turn-4').translatedText, '');
});

test('cancel ends an unfinished turn but only deactivates a completed one', () => {
  const { store, turn } = setup();
  store.beginTurn({ turnId: 'turn-1', input: 'text', sourceText: '안녕' });
  assert.equal(store.cancelTurn('turn-1'), true);
  assert.deepEqual([turn().phase, turn().errorCode, turn().messageKey], [TURN_PHASE.CANCELLED, 'ABORTED', 'seq.cancelled']);
  assert.equal(store.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(store.cancelTurn('turn-1'), false);
  assert.equal(store.commitTranslation('turn-1', ok()), false);
  store.beginTurn({ turnId: 'turn-2', input: 'text', sourceText: '안녕' });
  store.commitTranslation('turn-2', ok());
  store.beginSpeaking('turn-2');
  assert.equal(store.cancelTurn('turn-2'), true);
  assert.equal(turn('turn-2').phase, TURN_PHASE.COMPLETED);
  assert.equal(turn('turn-2').translatedText, 'りんご12個');
  assert.equal(store.snapshot().activeTurnId, null);
  assert.equal(store.cancelTurn('turn-2'), false);
  assert.equal(store.cancelTurn('missing'), false);
  // A completed idle turn can be re-activated for a user-chosen re-read.
  assert.equal(store.beginSpeaking('turn-2'), true);
  assert.equal(store.snapshot().activeTurnId, 'turn-2');
  assert.equal(store.setVoiceResult('turn-2', { status: 'completed', engine: 'device', fallback: true, messageKey: 'voice.fallback' }), true);
  assert.equal(turn('turn-2').voice.fallback, true);
  assert.equal(store.finishTurn('turn-2'), true);
  assert.throws(() => store.setVoiceResult('turn-2', { status: 'completed', messageKey: 'raw text' }), code('INVALID_REQUEST'));
});

test('retry reprocesses the same record without appending a duplicate', () => {
  const { store, turn } = setup();
  store.beginTurn({ turnId: 'turn-1', input: 'text', sourceText: '안녕' });
  store.failTurn('turn-1', { errorCode: 'UNAVAILABLE' });
  store.beginTurn({ turnId: 'turn-2', input: 'voice' });
  assert.equal(store.retryTurn('turn-1'), false);
  store.cancelTurn('turn-2');
  assert.equal(store.retryTurn('turn-2'), false);
  store.setInterpretation({ sourceLanguage: 'ko', targetLanguage: 'en' });
  assert.equal(store.retryTurn('turn-1'), true);
  assert.equal(store.snapshot().turns.length, 2);
  assert.equal(store.snapshot().activeTurnId, 'turn-1');
  assert.equal(store.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.deepEqual([turn().phase, turn().attempts, turn().errorCode, turn().messageKey, turn().targetLanguage, turn().endedAt],
    [TURN_PHASE.TRANSLATING, 2, null, undefined, 'en', null]);
  assert.equal(store.retryTurn('turn-1'), false);
  store.commitTranslation('turn-1', ok({ translatedText: '12 apples' }));
  assert.equal(turn().translatedText, '12 apples');
  assert.equal(store.snapshot().turns.map((t) => t.turnId).join(','), 'turn-1,turn-2');
});

test('the conversation is memory only, bounded, cleared on demand and gone after close', () => {
  const { store } = setup();
  for (let i = 1; i <= MAX_TURNS + 5; i++) {
    store.beginTurn({ turnId: `turn-${i}`, input: 'text', sourceText: 'x' });
    store.commitTranslation(`turn-${i}`, ok());
    store.finishTurn(`turn-${i}`);
  }
  assert.equal(store.snapshot().turns.length, MAX_TURNS);
  assert.equal(store.snapshot().turns[0].turnId, 'turn-6');
  store.beginTurn({ turnId: 'active', input: 'text', sourceText: 'x' });
  assert.throws(() => store.clearTurns(), code('INVALID_REQUEST'));
  store.cancelTurn('active');
  store.clearTurns('records.sharedEnded');
  assert.deepEqual(store.snapshot().turns, []);
  assert.equal(store.snapshot().notice.messageKey, 'records.sharedEnded');
  assert.equal(store.snapshot().records.persist, false);
  const seen = [];
  const unsubscribe = store.subscribe(() => { seen.push(1); throw new Error('SECRET listener'); });
  store.setNotice(null);
  assert.equal(seen.length, 1);
  unsubscribe();
  store.setNotice(null);
  assert.equal(seen.length, 1);
  store.beginTurn({ turnId: 'last', input: 'text', sourceText: 'x' });
  const final = store.close();
  assert.equal(store.closed, true);
  assert.deepEqual([final.turns, final.activeTurnId, final.status, final.keySelection], [[], null, SEQ_STATUS.IDLE, null]);
  assert.equal(store.close(), store.snapshot());
  for (const call of [() => store.beginTurn({ turnId: 'x', input: 'text', sourceText: 'x' }), () => store.subscribe(() => {}),
    () => store.setInterpretation({ sourceLanguage: 'ko', targetLanguage: 'en' }), () => store.invalidate(), () => store.clearTurns()]) {
    assert.throws(call, code('SESSION_CLOSED'));
  }
});


test('numeric error codes are accepted but malformed codes never enter state', () => {
  const { store, turn } = setup();
  store.beginTurn({ turnId: 'turn-1', input: 'text', sourceText: 'hello' });
  for (const errorCode of ['429', '_CODE', 'unknown_429', 'UNKNOWN-429', 'CODE secret', 'A'.repeat(41), 'CODE\n']) {
    assert.throws(() => store.failTurn('turn-1', { errorCode }), code('INVALID_REQUEST'));
  }
  store.failTurn('turn-1', { errorCode: 'UNKNOWN_429' });
  assert.equal(turn().errorCode, 'UNKNOWN_429');
});
