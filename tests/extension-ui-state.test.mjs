import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { createListenState } from '../app/engine/listen-state.js';
import { ERROR_CODES } from '../app/providers/contract.js';
import { simFixture, tick, deferred } from './fixtures/sim.mjs';
import { GAP_KINDS, OUTPUT_STATES } from '../extension/lib/constants.js';
import { LANES, LIMITS, validateFrame, validateLaneState, validateUiState } from '../extension/lib/protocol.js';
import { buildCaptionFrame, buildStyleFrame, createFrameCoalescer } from '../extension/lib/caption-frames.js';
import {
  ACTIVE_PHASES, EXTENSION_ERROR_CODES, KEY_FAILURE_CODES, LANE_PHASES, OVERRIDDEN_ENGINE_CODES, QUOTA_CODES, TAB_CAPTURE_CODES,
  buildUiState, createIdleLaneState, errorKeyFor, laneStateFromSnapshot,
} from '../extension/lib/ui-state.js';

function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}
const LANE_KEYS = ['lane', 'phase', 'engineStatus', 'retries', 'output', 'model', 'route', 'fallback', 'targetLanguage', 'errorCode', 'quota',
  'keyFailure', 'level', 'tabId', 'captions', 'overlay', 'gap', 'epoch'];

// ---------------------------------------------------------------------------------------------
// errorKeyFor
const appDictionary = JSON.parse(await readFile(new URL('../app/i18n/en.json', import.meta.url), 'utf8'));
const extKeys = [...OVERRIDDEN_ENGINE_CODES, ...EXTENSION_ERROR_CODES].map((code) => `ext.error.${code}`);
const dictionary = new Set([...Object.keys(appDictionary), ...extKeys]);
const has = (key) => dictionary.has(key);

test('the code lists of section 4.6.2 are frozen and their sizes match section 9.6', () => {
  for (const list of [LANE_PHASES, ACTIVE_PHASES, QUOTA_CODES, KEY_FAILURE_CODES, EXTENSION_ERROR_CODES, OVERRIDDEN_ENGINE_CODES, TAB_CAPTURE_CODES]) {
    assert.ok(Object.isFrozen(list));
  }
  assert.deepEqual(LANE_PHASES, ['off', 'starting', 'running', 'reconnecting', 'stopping', 'error']);
  assert.deepEqual(ACTIVE_PHASES, ['starting', 'running', 'reconnecting']);
  assert.deepEqual(QUOTA_CODES, ['RATE_LIMITED', 'DAILY_LIMIT', 'TOKEN_LIMIT', 'UNKNOWN_429']);
  assert.deepEqual(KEY_FAILURE_CODES, ['CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'INVALID_KEY', 'PERMISSION_DENIED']);
  assert.deepEqual(TAB_CAPTURE_CODES, ['MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE', 'BROWSER_INTERRUPTED']);
  assert.equal(EXTENSION_ERROR_CODES.length, 12);
  assert.equal(OVERRIDDEN_ENGINE_CODES.length, 16);
  assert.equal(new Set([...EXTENSION_ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES]).size, 28, 'the two families do not overlap: 28 ext.error keys');
  assert.ok(EXTENSION_ERROR_CODES.includes('TAB_INPUT_LOST'));
  assert.ok(TAB_CAPTURE_CODES.every((code) => OVERRIDDEN_ENGINE_CODES.includes(code)));
});

test('errorKeyFor: ext.error.<CODE>, then error.<CODE>, then error.unknown (two levels, never sim.error.*)', () => {
  const dict = (...keys) => (key) => keys.includes(key);
  assert.equal(errorKeyFor('RATE_LIMITED', dict('ext.error.RATE_LIMITED', 'error.RATE_LIMITED')), 'ext.error.RATE_LIMITED');
  assert.equal(errorKeyFor('TIMEOUT', dict('error.TIMEOUT')), 'error.TIMEOUT');
  assert.equal(errorKeyFor('TIMEOUT', dict('ext.error.OTHER', 'sim.error.TIMEOUT')), 'error.unknown', 'sim.error.* is never consulted');
  assert.equal(errorKeyFor('RATE_LIMITED', dict('sim.error.RATE_LIMITED')), 'error.unknown');
  assert.equal(errorKeyFor('SOMETHING_NEW', dict()), 'error.unknown');
  assert.equal(errorKeyFor('RATE_LIMITED', () => true), 'ext.error.RATE_LIMITED');
  assert.equal(errorKeyFor('RATE_LIMITED', () => false), 'error.unknown');
  // whatever is not a machine code never reaches the dictionary
  const probed = [];
  const spy = (key) => { probed.push(key); return true; };
  for (const bad of [undefined, null, '', 'lower', 'A', 'HAS SPACE', 'X.Y', 'ext.error.X', 5, {}, ['NEEDS_ARM'], 'X'.repeat(50)]) assert.equal(errorKeyFor(bad, spy, 'tab'), 'error.unknown');
  assert.deepEqual(probed, []);
  // a dictionary that throws or is missing means "not there"
  assert.equal(errorKeyFor('INVALID_KEY', () => { throw new Error('boom'); }), 'error.unknown');
  for (const notFunction of [undefined, null, 'has', {}]) assert.equal(errorKeyFor('INVALID_KEY', notFunction), 'error.unknown');
  assert.deepEqual([errorKeyFor('INVALID_KEY', spy), probed.length], ['ext.error.INVALID_KEY', 1], 'the first level short-circuits');
});

test('errorKeyFor: on the tab lane the three capture codes read TAB_INPUT_LOST, on every other lane they do not', () => {
  for (const code of TAB_CAPTURE_CODES) {
    assert.equal(errorKeyFor(code, has, 'tab'), 'ext.error.TAB_INPUT_LOST', code);
    assert.equal(errorKeyFor(code, () => false, 'tab'), 'ext.error.TAB_INPUT_LOST', 'the remap is not conditional on the dictionary');
    assert.equal(errorKeyFor(code, has, 'mic'), `ext.error.${code}`, code);
    assert.equal(errorKeyFor(code, has), `ext.error.${code}`, code);
    assert.equal(errorKeyFor(code, has, null), `ext.error.${code}`, code);
    assert.equal(errorKeyFor(code, has, 'other'), `ext.error.${code}`, code);
  }
  // TIMEOUT is raised for the capture setup and for a provider timeout alike: not remapped
  for (const lane of ['tab', 'mic', null]) assert.equal(errorKeyFor('TIMEOUT', has, lane), 'error.TIMEOUT');
  assert.equal(errorKeyFor('INPUT_UNSUPPORTED', has, 'tab'), 'ext.error.INPUT_UNSUPPORTED', 'only the three codes are remapped');
});

test('errorKeyFor resolves every engine and extension code, for both lanes, to an existing key that is never sim.error.*', () => {
  const codes = new Set([...ERROR_CODES, ...EXTENSION_ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES, 'NEEDS_ARM', 'ALREADY_RUNNING', 'START_CANCELLED',
    'INVALID_MESSAGE', 'FORBIDDEN', 'UNKNOWN_TYPE', 'INTERNAL', 'CREDENTIAL_MISMATCH', 'CREDENTIAL_FORBIDDEN']);
  for (const code of codes) {
    for (const lane of [null, 'tab', 'mic']) {
      const key = errorKeyFor(code, has, lane);
      assert.ok(dictionary.has(key), `${code}/${lane} -> ${key}`);
      assert.equal(key.startsWith('sim.error.'), false, `${code}/${lane}`);
      assert.match(key, /^(ext\.error\.[A-Z][A-Z0-9_]+|error\.[A-Za-z][A-Za-z0-9_]*)$/);
      if (lane === 'tab' && key.startsWith('error.') && key !== 'error.unknown') {
        assert.doesNotMatch(String(appDictionary[key]), /microphone/i, `${code}: a tab-lane notice never talks about the microphone`);
      }
    }
  }
  // Codes that exist in the app dictionary and are not overridden fall back to the generic key, not to unknown.
  for (const code of ['NETWORK_ERROR', 'UNAVAILABLE', 'TIMEOUT', 'SETTINGS_UNSUPPORTED', 'SAFETY_BLOCKED', 'INVALID_RESULT', 'CREDENTIAL_MISMATCH']) {
    assert.equal(errorKeyFor(code, has, 'tab'), `error.${code}`);
  }
  for (const code of ['NEEDS_ARM', 'ALREADY_RUNNING', 'START_CANCELLED', 'INVALID_MESSAGE', 'FORBIDDEN', 'UNKNOWN_TYPE', 'INTERNAL']) {
    assert.equal(errorKeyFor(code, has, 'tab'), 'error.unknown', `${code} has no text of its own`);
  }
});

// ---------------------------------------------------------------------------------------------
// laneStateFromSnapshot
const snap = (patch = {}) => Object.freeze({ mode: 'direct', generation: 4, status: 'running', output: 'ready', broadcast: 'unknown', errorCode: null,
  messageKey: null, metrics: { firstAudioReceivedMs: 12 }, model: 'gemini-3.8-live', route: 'flash', fallback: false, defaultModel: 'gemini-3.8-live',
  skippedSegments: [], captions: { sessionId: 'sess-abc', generation: 4, epoch: 0, captions: [], gaps: { input: false, audio: false, reception: false }, metrics: {} },
  busy: true, retries: 0, ...patch });
const facts = (patch = {}) => ({ tabId: 12, captions: true, overlay: 'attached', epoch: 2, targetLanguage: 'ko', stopRequested: false, hostError: null,
  starting: false, stopping: false, ...patch });
const laneOf = ({ snapshot = snap(), lane = 'tab', level = 40, ...patch } = {}) => laneStateFromSnapshot({ lane, snapshot, facts: facts(patch), level });
const validated = (state) => { assert.deepEqual(validateLaneState(state, state.lane), state); return state; };

test('laneStateFromSnapshot: a running lane copies exactly the documented fields', () => {
  const state = validated(laneOf());
  assert.deepEqual(state, { lane: 'tab', phase: 'running', engineStatus: 'running', retries: 0, output: 'ready', model: 'gemini-3.8-live', route: 'flash',
    fallback: false, targetLanguage: 'ko', errorCode: null, quota: false, keyFailure: false, level: 40, tabId: 12, captions: true, overlay: 'attached',
    gap: null, epoch: 2 });
  assert.deepEqual(Object.keys(state), LANE_KEYS);
  assert.ok(isDeepFrozen(state));
  const idle = validated(createIdleLaneState('mic'));
  assert.deepEqual(idle, { lane: 'mic', phase: 'off', engineStatus: null, retries: 0, output: null, model: null, route: null, fallback: false, targetLanguage: null,
    errorCode: null, quota: false, keyFailure: false, level: 0, tabId: null, captions: false, overlay: 'unknown', gap: null, epoch: 0 });
  assert.throws(() => laneStateFromSnapshot({ lane: 'both' }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => laneStateFromSnapshot({}), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => laneStateFromSnapshot(), (error) => error.code === 'INVALID_REQUEST');
});

test('laneStateFromSnapshot: the engine status table of 4.6.2', () => {
  const phaseOf = (status, patch = {}, extra = {}) => { const s = validated(laneOf({ snapshot: snap({ status, ...extra }), ...patch })); return [s.phase, s.errorCode, s.engineStatus]; };
  assert.deepEqual(phaseOf('idle'), ['off', null, 'idle']);
  assert.deepEqual(phaseOf('preparing'), ['starting', null, 'preparing']);
  assert.deepEqual(phaseOf('connecting'), ['starting', null, 'connecting']);
  assert.deepEqual(phaseOf('running'), ['running', null, 'running']);
  assert.deepEqual(phaseOf('reconnecting', {}, { retries: 2 }), ['reconnecting', null, 'reconnecting']);
  assert.equal(laneOf({ snapshot: snap({ status: 'reconnecting', retries: 2 }) }).retries, 2);
  assert.deepEqual(phaseOf('stopping'), ['stopping', null, 'stopping']);
  assert.deepEqual(phaseOf('stopped', { stopRequested: true }), ['off', null, 'stopped']);
  assert.deepEqual(phaseOf('stopped', { stopRequested: false }), ['error', 'BROWSER_INTERRUPTED', 'stopped'], 'a stop nobody asked for is an interruption');
  assert.deepEqual(phaseOf('stopped', { stopRequested: undefined }), ['off', null, 'stopped'], 'only an explicit false counts as unrequested');
  assert.deepEqual(phaseOf('failed', {}, { errorCode: 'INVALID_KEY' }), ['error', 'INVALID_KEY', 'failed']);
  assert.deepEqual(phaseOf('failed', {}, { errorCode: null }), ['error', 'INTERNAL', 'failed'], 'a failure without a code still is an error');
  assert.deepEqual(phaseOf('failed', {}, { errorCode: 'not a code' }), ['error', 'INTERNAL', 'failed']);
  assert.deepEqual(phaseOf('sleeping'), ['off', null, null], 'an unknown status is no status');
});

test('laneStateFromSnapshot: every engine error code keeps its code and sets the quota and key-failure flags from the lists', () => {
  const codes = [...new Set([...ERROR_CODES, ...OVERRIDDEN_ENGINE_CODES, 'MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE'])];
  for (const code of codes) {
    const state = validated(laneOf({ snapshot: snap({ status: 'failed', errorCode: code }) }));
    assert.equal(state.phase, 'error');
    assert.equal(state.errorCode, code);
    assert.equal(state.quota, QUOTA_CODES.includes(code), code);
    assert.equal(state.keyFailure, KEY_FAILURE_CODES.includes(code), code);
    assert.equal(state.level, 0, 'a failed lane shows no input level');
  }
  assert.equal(laneOf({ snapshot: snap({ status: 'failed', errorCode: 'RATE_LIMITED' }) }).quota, true);
  assert.equal(laneOf({ snapshot: snap({ status: 'failed', errorCode: 'INVALID_KEY' }) }).keyFailure, true);
  assert.equal(laneOf({ snapshot: snap({ status: 'failed', errorCode: 'CREDENTIAL_FORBIDDEN' }) }).keyFailure, false);
  assert.equal(laneOf({ snapshot: snap({ status: 'failed', errorCode: 'BUDGET_EXHAUSTED' }) }).quota, false, 'BUDGET_EXHAUSTED is quota-suspect in the view model, not a quota code here');
});

test('laneStateFromSnapshot: host-level facts (no engine yet, stop in progress, host error, cancelled start)', () => {
  const none = (patch) => validated(laneStateFromSnapshot({ lane: 'tab', snapshot: null, facts: facts(patch), level: 55 }));
  assert.deepEqual([none({}).phase, none({}).engineStatus], ['off', null], 'no engine and nothing in progress');
  const acquiring = none({ starting: true });
  assert.deepEqual([acquiring.phase, acquiring.engineStatus, acquiring.model, acquiring.output, acquiring.level], ['starting', null, null, null, 0], 'acquiring the tab stream');
  assert.equal(acquiring.targetLanguage, 'ko');
  assert.equal(acquiring.tabId, 12);
  assert.deepEqual([none({ stopping: true }).phase, none({ stopping: true }).errorCode], ['stopping', null]);
  const ended = none({ hostError: 'TAB_ENDED' });
  assert.deepEqual([ended.phase, ended.errorCode, ended.quota, ended.keyFailure], ['error', 'TAB_ENDED', false, false]);
  assert.equal(none({ hostError: 'TAB_AUDIO_BLOCKED', starting: true }).phase, 'error', 'a host error outranks starting');
  // a start cancelled by a stop is off and carries no code
  const cancelled = none({ stopRequested: true, starting: false });
  assert.deepEqual([cancelled.phase, cancelled.errorCode], ['off', null]);
  // precedence: stopping, then host error, then the engine
  assert.equal(laneOf({ snapshot: snap({ status: 'running' }), hostError: 'TAB_ENDED' }).errorCode, 'TAB_ENDED');
  assert.equal(laneOf({ snapshot: snap({ status: 'failed', errorCode: 'INVALID_KEY' }), hostError: 'TAB_ENDED' }).errorCode, 'TAB_ENDED');
  assert.equal(laneOf({ snapshot: snap({ status: 'running' }), hostError: 'TAB_ENDED', stopping: true }).phase, 'stopping');
  assert.equal(laneOf({ snapshot: snap({ status: 'running' }), hostError: 'not a code' }).phase, 'running', 'an unusable host error is ignored');
  assert.equal(laneOf({ snapshot: snap({ status: 'idle' }), starting: true }).phase, 'off', 'a snapshot, when there is one, speaks for the engine');
  assert.equal(laneOf({ snapshot: snap({ status: 'stopped' }), stopRequested: true, hostError: 'TAB_ENDED' }).phase, 'error');
  assert.equal(laneStateFromSnapshot({ lane: 'tab', snapshot: undefined, facts: null, level: 3 }).phase, 'off');
  assert.equal(laneStateFromSnapshot({ lane: 'tab', snapshot: 'junk', facts: 'junk' }).phase, 'off');
});

test('laneStateFromSnapshot: output, retries, model, route, fallback, language and level are bounded and only shown while a session exists', () => {
  for (const output of OUTPUT_STATES) assert.equal(laneOf({ snapshot: snap({ output }) }).output, output);
  for (const bad of ['loud', '', null, undefined, 3]) assert.equal(laneOf({ snapshot: snap({ output: bad }) }).output, null);
  assert.equal(laneOf({ snapshot: snap({ status: 'idle', output: 'ready' }) }).output, null, 'off shows no output');
  assert.equal(laneOf({ snapshot: snap({ status: 'failed', errorCode: 'X_FAKE', output: 'ready' }) }).output, null, 'error shows no output');
  assert.equal(laneOf({ snapshot: snap({ status: 'stopping', output: 'muted' }) }).output, 'muted');
  for (const [given, expected] of [[0, 0], [3, 3], [4, 3], [99, 3], [-1, 0], [1.6, 2], [NaN, 0], [undefined, 0], ['2', 0], [Infinity, 0]]) {
    assert.equal(laneOf({ snapshot: snap({ retries: given }) }).retries, expected, String(given));
  }
  assert.equal(laneOf({ snapshot: snap({ status: 'idle', retries: 3 }) }).retries, 0);
  assert.equal(laneOf({ snapshot: snap({ model: 'm'.repeat(200) }) }).model.length, 64);
  for (const bad of ['', null, undefined, 4]) assert.equal(laneOf({ snapshot: snap({ model: bad }) }).model, null);
  assert.equal(laneOf({ snapshot: snap({ status: 'idle' }) }).model, null);
  assert.equal(laneOf({ snapshot: snap({ route: 'translation' }) }).route, 'translation');
  assert.equal(laneOf({ snapshot: snap({ route: 'flash' }) }).route, 'flash');
  for (const bad of ['other', null, undefined]) assert.equal(laneOf({ snapshot: snap({ route: bad }) }).route, null);
  assert.equal(laneOf({ snapshot: snap({ fallback: true }) }).fallback, true);
  for (const bad of ['yes', 1, undefined]) assert.equal(laneOf({ snapshot: snap({ fallback: bad }) }).fallback, false);
  assert.equal(laneOf({ snapshot: snap({ status: 'idle', fallback: true }) }).fallback, false);
  for (const language of ['ko', 'en', 'ja']) assert.equal(laneOf({ targetLanguage: language }).targetLanguage, language);
  for (const bad of ['fr', 'auto', null, undefined, 5]) assert.equal(laneOf({ targetLanguage: bad }).targetLanguage, null);
  assert.equal(laneOf({ snapshot: snap({ status: 'idle' }), targetLanguage: 'ja' }).targetLanguage, null, 'an idle lane has no running language');
  for (const [given, expected] of [[0, 0], [100, 100], [33.4, 33], [33.5, 34], [250, 100], [-3, 0], [NaN, 0], [null, 0], ['50', 0], [Infinity, 0]]) {
    assert.equal(laneOf({ level: given }).level, expected, String(given));
  }
  assert.equal(laneStateFromSnapshot({ lane: 'tab', snapshot: snap(), facts: facts() }).level, 0, 'no level given');
  assert.equal(laneOf({ snapshot: snap({ status: 'reconnecting' }), level: 70 }).level, 70);
  for (const status of ['preparing', 'connecting', 'stopping', 'idle', 'stopped']) assert.equal(laneOf({ snapshot: snap({ status }), level: 70, stopRequested: true }).level, 0, status);
});

test('laneStateFromSnapshot: tab id, captions flag, overlay, epoch and the first sticky gap', () => {
  assert.equal(laneOf({ lane: 'tab', tabId: 0 }).tabId, 0);
  assert.equal(laneOf({ lane: 'mic', tabId: 12 }).tabId, null, 'only the tab lane is bound to a tab');
  for (const bad of [-1, 1.5, '3', null, undefined, NaN]) assert.equal(laneOf({ tabId: bad }).tabId, null);
  assert.equal(laneOf({ captions: true }).captions, true);
  for (const bad of ['true', 1, null, undefined, false]) assert.equal(laneOf({ captions: bad }).captions, false);
  for (const overlay of ['unknown', 'attached', 'unavailable']) assert.equal(laneOf({ overlay }).overlay, overlay);
  for (const bad of ['gone', null, undefined, 4]) assert.equal(laneOf({ overlay: bad }).overlay, 'unknown');
  for (const [given, expected] of [[0, 0], [7, 7], [-1, 0], [1.5, 0], ['2', 0], [undefined, 0]]) assert.equal(laneOf({ epoch: given }).epoch, expected, String(given));
  const gaps = (input, audio, reception) => snap({ captions: { gaps: { input, audio, reception }, captions: [] } });
  assert.equal(laneOf({ snapshot: gaps(false, false, false) }).gap, null);
  assert.equal(laneOf({ snapshot: gaps(true, true, true) }).gap, 'input');
  assert.equal(laneOf({ snapshot: gaps(false, true, true) }).gap, 'audio');
  assert.equal(laneOf({ snapshot: gaps(false, false, true) }).gap, 'reception');
  assert.equal(laneOf({ snapshot: snap({ captions: null }) }).gap, null);
  assert.equal(laneOf({ snapshot: snap({ captions: { gaps: { input: 'yes' } } }) }).gap, null, 'only a real true counts');
  assert.deepEqual(GAP_KINDS, ['input', 'audio', 'reception']);
  assert.equal(laneOf({ snapshot: { ...gaps(true, false, false), status: 'idle' } }).gap, null, 'no gap line without a live session');
  assert.equal(laneOf({ snapshot: { ...gaps(true, false, false), status: 'failed', errorCode: 'X_FAKE' } }).gap, null);
  assert.equal(laneOf({ snapshot: { ...gaps(false, true, false), status: 'reconnecting' } }).gap, 'audio');
});

test('laneStateFromSnapshot never lets the session id, generation, metrics, raw captions, tab url or a key into the state', () => {
  const secretSnapshot = snap({ sessionId: 'sess-abc', generation: 987, metrics: { firstAudioReceivedMs: 1234567 }, discovered: ['model-x'], skippedSegments: ['seg-9'],
    url: 'https://secret.example/page', title: 'private title', key: ['synthetic', 'k'.repeat(24)].join('-'),
    captions: { sessionId: 'sess-abc', captions: [{ translatedText: 'private words', sourceText: 'secret speech' }], gaps: { input: true, audio: false, reception: false } } });
  const state = laneOf({ snapshot: secretSnapshot });
  const text = JSON.stringify(state);
  for (const leak of ['sess-abc', '987', '1234567', 'model-x', 'seg-9', 'secret.example', 'private', 'secret speech', 'synthetic']) assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(Object.keys(state), LANE_KEYS);
  for (const name of ['sessionId', 'generation', 'metrics', 'messageKey', 'busy', 'defaultModel']) assert.equal(name in state, false, name);
  assert.equal(state.gap, 'input');
});

test('laneStateFromSnapshot never throws and always yields a state the frame validator accepts (deterministic random inputs)', () => {
  let seed = 20260929;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const junk = [undefined, null, 0, -1, 7, 1.5, NaN, Infinity, '', 'x', 'ko', 'running', true, false, [], {}, [1], () => 1, 10n ** 3n === 1000n ? 'big' : 0];
  const statuses = ['idle', 'preparing', 'connecting', 'running', 'reconnecting', 'stopping', 'stopped', 'failed', 'weird', ...junk];
  const codes = [...ERROR_CODES, 'TAB_ENDED', 'lower', ...junk];
  for (let i = 0; i < 800; i += 1) {
    const snapshot = next() < 0.15 ? pick(junk) : { status: pick(statuses), output: pick([...OUTPUT_STATES, ...junk]), errorCode: pick(codes), retries: pick([0, 1, 2, 3, 9, ...junk]),
      model: pick(['gemini-3.8-live', 'm'.repeat(100), ...junk]), route: pick(['translation', 'flash', ...junk]), fallback: pick([true, false, ...junk]),
      captions: pick([null, { gaps: { input: pick([true, false, ...junk]), audio: pick([true, false]), reception: pick([true, false]) } }, ...junk]) };
    const f = next() < 0.1 ? pick(junk) : { tabId: pick([0, 5, ...junk]), captions: pick([true, false, ...junk]), overlay: pick(['unknown', 'attached', 'unavailable', ...junk]),
      epoch: pick([0, 3, ...junk]), targetLanguage: pick(['ko', 'en', 'ja', ...junk]), stopRequested: pick([true, false, undefined]), hostError: pick([null, 'TAB_ENDED', 'TAB_AUDIO_BLOCKED', ...junk]),
      starting: pick([true, false, ...junk]), stopping: pick([true, false, ...junk]) };
    const lane = pick(LANES);
    let state;
    assert.doesNotThrow(() => { state = laneStateFromSnapshot({ lane, snapshot, facts: f, level: pick([0, 50, 300, ...junk]) }); });
    assert.deepEqual(validateLaneState(state, lane), state, JSON.stringify(state));
  }
});

test('real engine snapshots map as documented (fake sockets and audio: nothing is audible)', async (t) => {
  const map = (f, patch = {}, lane = 'mic') => laneStateFromSnapshot({ lane, snapshot: f.engine.snapshot(), facts: facts({ tabId: null, ...patch }), level: 30 });
  const f = simFixture(); t.after(() => f.close());
  const handle = f.start();
  const preparing = validated(map(f));
  assert.deepEqual([preparing.phase, preparing.engineStatus, preparing.model, preparing.route], ['starting', 'preparing', 'gemini-3.8-live', 'flash']);
  await tick(); f.frame(); await tick();
  assert.deepEqual([map(f).phase, map(f).engineStatus], ['starting', 'connecting']);
  await f.open(); await handle.ready;
  const running = validated(map(f));
  assert.deepEqual([running.phase, running.engineStatus, running.retries, running.errorCode, running.level], ['running', 'running', 0, null, 30]);
  assert.equal(['ready', 'muted', 'unavailable', 'blocked', 'delayed', 'catching-up'].includes(running.output), true);
  f.sockets[0].json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota text that must never surface' } });
  const result = await handle.done;
  assert.equal(result.errorCode, 'UNKNOWN_429');
  const failed = validated(map(f));
  assert.deepEqual([failed.phase, failed.errorCode, failed.quota, failed.keyFailure, failed.engineStatus], ['error', 'UNKNOWN_429', true, false, 'failed']);
  assert.equal(JSON.stringify(failed).includes('quota text'), false);
});

test('real engine snapshots: a requested stop is off, the same stop without a request is BROWSER_INTERRUPTED, a denied microphone is an error', async (t) => {
  const f = simFixture(); t.after(() => f.close());
  await f.running();
  const stopped = await f.engine.stop();
  assert.equal(stopped.status, 'stopped');
  const shown = (stopRequested) => validated(laneStateFromSnapshot({ lane: 'tab', snapshot: f.engine.snapshot(), facts: facts({ stopRequested }), level: 0 }));
  assert.deepEqual([shown(true).phase, shown(true).errorCode], ['off', null]);
  assert.deepEqual([shown(false).phase, shown(false).errorCode], ['error', 'BROWSER_INTERRUPTED']);
  const permission = deferred();
  const denied = simFixture({ permission }); t.after(() => denied.close());
  const handle = denied.start();
  permission.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  await handle.done;
  const mic = validated(laneStateFromSnapshot({ lane: 'mic', snapshot: denied.engine.snapshot(), facts: facts(), level: 0 }));
  assert.deepEqual([mic.phase, mic.errorCode], ['error', 'MICROPHONE_DENIED']);
  assert.equal(errorKeyFor(mic.errorCode, has, 'mic'), 'ext.error.MICROPHONE_DENIED');
  assert.equal(errorKeyFor(mic.errorCode, has, 'tab'), 'ext.error.TAB_INPUT_LOST');
  const state = createListenState();
  state.transition('preparing');
  assert.equal(laneStateFromSnapshot({ lane: 'tab', snapshot: state.snapshot(), facts: facts() }).phase, 'starting', 'a bare listen-state snapshot maps too');
});

// ---------------------------------------------------------------------------------------------
// buildUiState
test('buildUiState assembles the envelope, derives concurrency from the lanes and keeps every string bounded', () => {
  const running = laneOf({ lane: 'tab' });
  const starting = laneOf({ lane: 'mic', snapshot: snap({ status: 'preparing' }), tabId: null });
  const failed = laneOf({ lane: 'mic', snapshot: snap({ status: 'failed', errorCode: 'INVALID_KEY' }) });
  const reconnecting = laneOf({ lane: 'tab', snapshot: snap({ status: 'reconnecting', retries: 1 }) });
  const state = buildUiState({ hostId: 'h-abc', seq: 17, speechMuted: false, lanes: { tab: running, mic: starting } });
  assert.deepEqual(Object.keys(state), ['v', 'seq', 'hostId', 'speechMuted', 'concurrent', 'lanes']);
  assert.deepEqual([state.v, state.seq, state.hostId, state.speechMuted, state.concurrent], [1, 17, 'h-abc', false, 2]);
  assert.deepEqual(state.lanes, { tab: running, mic: starting });
  assert.ok(isDeepFrozen(state));
  assert.deepEqual(validateUiState(state), state);
  assert.deepEqual(validateFrame('host->panel', { v: 1, type: 'state', state }), { ok: true, frame: { v: 1, type: 'state', state } });
  const concurrent = (tab, mic) => buildUiState({ hostId: 'h-1', seq: 1, lanes: { tab, mic } }).concurrent;
  assert.equal(concurrent(createIdleLaneState('tab'), createIdleLaneState('mic')), 0);
  assert.equal(concurrent(running, createIdleLaneState('mic')), 1);
  assert.equal(concurrent(reconnecting, starting), 2);
  assert.equal(concurrent(failed.lane === 'mic' ? createIdleLaneState('tab') : failed, failed), 0, 'a failed lane does not hold a session');
  assert.equal(concurrent(laneOf({ lane: 'tab', snapshot: snap({ status: 'stopping' }) }), createIdleLaneState('mic')), 0, 'stopping is on its way out');
  for (const phase of LANE_PHASES) assert.equal(ACTIVE_PHASES.includes(phase), ['starting', 'running', 'reconnecting'].includes(phase));
});

test('buildUiState defaults and sanitizes: idle lanes, muted, seq >= 1, a bounded printable host id', () => {
  const empty = buildUiState();
  assert.deepEqual(empty, { v: 1, seq: 1, hostId: 'h-unknown', speechMuted: true, concurrent: 0, lanes: { tab: createIdleLaneState('tab'), mic: createIdleLaneState('mic') } });
  assert.deepEqual(validateUiState(empty), empty);
  const odd = buildUiState({ hostId: 'has space', seq: 0, speechMuted: 'no', lanes: { tab: { lane: 'tab', phase: 'nonsense' }, mic: createIdleLaneState('tab') } });
  assert.equal(odd.hostId, 'h-unknown');
  assert.equal(odd.seq, 1);
  assert.equal(odd.speechMuted, true, 'a non-false value keeps the safe (muted) reading');
  assert.deepEqual(odd.lanes, empty.lanes, 'an invalid lane state, or one for the other lane, becomes an idle lane');
  assert.equal(buildUiState({ speechMuted: false }).speechMuted, false);
  for (const bad of [1.5, -4, NaN, '3', null]) assert.equal(buildUiState({ seq: bad }).seq, 1);
  assert.equal(buildUiState({ seq: 2 ** 40 }).seq, 2 ** 40);
  for (const bad of [5, null, '', 'x'.repeat(65), 'a\nb']) assert.equal(buildUiState({ hostId: bad }).hostId, 'h-unknown');
  assert.equal(buildUiState({ hostId: 'x'.repeat(64) }).hostId.length, 64);
  assert.equal(buildUiState({ lanes: null }).lanes.tab.phase, 'off');
});

test('buildUiState stays within 2 KB even when every field is at its bound', () => {
  const bigFacts = { tabId: 2 ** 31, captions: true, overlay: 'unavailable', epoch: 2 ** 31, targetLanguage: 'ja', hostError: 'X'.repeat(41) };
  const worstTab = laneStateFromSnapshot({ lane: 'tab', snapshot: snap({ status: 'reconnecting', output: 'catching-up', model: 'm'.repeat(500), retries: 99,
    route: 'translation', fallback: true, captions: { gaps: { input: true, audio: true, reception: true } } }), facts: bigFacts, level: 100 });
  const worstMic = laneStateFromSnapshot({ lane: 'mic', snapshot: snap({ status: 'reconnecting', output: 'delayed', model: 'm'.repeat(500), retries: 99, route: 'translation',
    fallback: true }), facts: { ...bigFacts, hostError: null }, level: 100 });
  const state = buildUiState({ hostId: 'h'.repeat(64), seq: 2 ** 31, speechMuted: false, lanes: { tab: worstTab, mic: worstMic } });
  const size = JSON.stringify(state).length;
  assert.ok(size <= 2048, `UiState is ${size} bytes`);
  assert.equal(state.lanes.tab.model.length, 64);
  assert.equal(state.lanes.tab.errorCode.length, 41);
  assert.ok(size < 1200, 'and in fact far below the contract\'s limit');
  assert.ok(JSON.stringify({ v: 1, type: 'state', state }).length <= LIMITS.maxFrameBytes);
});

// ---------------------------------------------------------------------------------------------
// buildCaptionFrame (real caption store snapshots)
let tickClock = 0;
const newStore = () => createCaptionStore({ sessionId: 'sess-1', generation: 0, now: () => (tickClock += 1) });
let sequence = 0;
function say(store, { id, text, role = 'translation', status = 'final', revision = 1 }) {
  const field = role === 'source' ? 'sourceText' : 'translatedText';
  store.upsertDirect({ id, sessionId: 'sess-1', generation: 0, role, sequence: (sequence += 1), revision, [field]: text, status, receivedAt: 10,
    finalizedAt: status === 'partial' ? null : 11 });
}
const frameOf = (store, patch = {}) => buildCaptionFrame({ captions: store?.snapshot() ?? null, lane: 'tab', lang: 'ko', epoch: 3, seq: 41, live: true, ...patch });
const ids = (frame) => frame.rows.map((row) => row.id);

test('buildCaptionFrame: rule 1, no captions gives an empty, valid frame', () => {
  const frame = buildCaptionFrame({ captions: null, lane: 'mic', lang: 'en', epoch: 1, seq: 2, live: true });
  assert.deepEqual(frame, { v: 1, type: 'captions', epoch: 1, seq: 2, lane: 'mic', lang: 'en', rows: [],
    gaps: { input: false, audio: false, reception: false }, live: true });
  assert.deepEqual(Object.keys(frame), ['v', 'type', 'epoch', 'seq', 'lane', 'lang', 'rows', 'gaps', 'live']);
  assert.ok(isDeepFrozen(frame));
  assert.equal(validateFrame('host->overlay', frame).ok, true);
  assert.deepEqual(buildCaptionFrame({ lane: 'tab', lang: 'ko' }).rows, []);
  assert.deepEqual(buildCaptionFrame({ captions: { captions: 'not rows' }, lane: 'tab', lang: 'ko' }).rows, []);
  assert.deepEqual(buildCaptionFrame({ captions: { captions: [null, 5, 'x'] }, lane: 'tab', lang: 'ko' }).rows, []);
  assert.equal(buildCaptionFrame({ lane: 'tab', lang: 'ko' }).live, false);
  assert.equal(buildCaptionFrame({ lane: 'tab', lang: 'ko', live: 'yes' }).live, false, 'only a real true is live');
  for (const lane of ['both', undefined, 'TAB']) assert.throws(() => buildCaptionFrame({ lane, lang: 'ko' }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => buildCaptionFrame(), (error) => error.code === 'INVALID_REQUEST');
});

test('buildCaptionFrame: rules 2 and 3, source rows only with showSource, text fields per role, empty text dropped', () => {
  const store = newStore();
  say(store, { id: 's1', role: 'source', text: 'hello' });
  say(store, { id: 't1', text: '안녕' });
  say(store, { id: 's2', role: 'source', text: 'how are you', status: 'partial' });
  say(store, { id: 't2', text: '잘 지내요', status: 'partial' });
  const without = frameOf(store);
  assert.deepEqual(ids(without), ['t1', 't2']);
  assert.deepEqual(without.rows.map((row) => row.text), ['안녕', '잘 지내요']);
  assert.equal(without.rows.every((row) => row.role === 'translation'), true);
  const withSource = frameOf(store, { showSource: true });
  assert.deepEqual(ids(withSource), ['s1', 't1', 's2', 't2'], 'first-arrival order: rows are never paired side by side');
  assert.deepEqual(withSource.rows.map((row) => [row.role, row.text]), [['source', 'hello'], ['translation', '안녕'], ['source', 'how are you'], ['translation', '잘 지내요']]);
  for (const flag of [undefined, false, 0, null, 'yes']) assert.deepEqual(ids(frameOf(store, { showSource: flag })), ['t1', 't2'], `showSource ${String(flag)} is not a true`);
  const blanks = newStore();
  say(blanks, { id: 'a', text: '   ' });
  say(blanks, { id: 'b', text: '\n\t' });
  say(blanks, { id: 'c', text: ' real ' });
  say(blanks, { id: 'd', role: 'source', text: '' });
  assert.deepEqual(frameOf(blanks, { showSource: true }).rows.map((row) => [row.id, row.text]), [['c', ' real ']], 'blank rows are dropped, text is otherwise kept as is');
});

test('buildCaptionFrame: rule 4, all partials plus the newest settled rows that fit, oldest first', () => {
  const store = newStore();
  for (let i = 1; i <= 5; i += 1) say(store, { id: `f${i}`, text: `final ${i}` });
  say(store, { id: 'p6', text: 'partial 6', status: 'partial' });
  const frame = frameOf(store, { maxRows: 4 });
  assert.deepEqual(ids(frame), ['f3', 'f4', 'f5', 'p6']);
  assert.deepEqual(frame.rows.map((row) => row.status), ['final', 'final', 'final', 'partial']);
  assert.deepEqual(ids(frameOf(store, { maxRows: 1 })), ['p6'], 'the partial is the newest thing being said');
  assert.deepEqual(ids(frameOf(store, { maxRows: 2 })), ['f5', 'p6']);
  assert.deepEqual(ids(frameOf(store, { maxRows: 6 })), ['f1', 'f2', 'f3', 'f4', 'f5', 'p6']);
  // no partial: the newest `maxRows` settled rows
  const settled = newStore();
  for (let i = 1; i <= 7; i += 1) say(settled, { id: `s${i}`, text: `row ${i}` });
  assert.deepEqual(ids(frameOf(settled, { maxRows: 3 })), ['s5', 's6', 's7']);
  // an interrupted row counts as settled and keeps its status
  const interrupted = newStore();
  say(interrupted, { id: 'x1', text: 'cut off', status: 'partial' });
  say(interrupted, { id: 'x2', text: 'next' });
  const cut = frameOf(interrupted);
  assert.deepEqual(cut.rows.map((row) => [row.id, row.status]), [['x1', 'interrupted'], ['x2', 'final']]);
  assert.deepEqual(ids(frameOf(interrupted, { maxRows: 1 })), ['x2']);
  // source and translation partials together: both are kept, and the bound still holds
  const both = newStore();
  say(both, { id: 's1', role: 'source', text: 'src', status: 'partial' });
  say(both, { id: 't1', text: 'trans', status: 'partial' });
  assert.deepEqual(ids(frameOf(both, { showSource: true, maxRows: 4 })), ['s1', 't1']);
  assert.deepEqual(ids(frameOf(both, { showSource: true, maxRows: 1 })), ['t1'], 'never more rows than maxRows: the newest partial wins');
  // rows the store gives without an `order` fall back to their position
  const bare = { captions: [{ role: 'translation', status: 'final', segmentId: 'b1', translatedText: 'one' }, { role: 'translation', status: 'final', segmentId: 'b2', translatedText: 'two' }] };
  assert.deepEqual(ids(buildCaptionFrame({ captions: bare, lane: 'tab', lang: 'ko', maxRows: 1 })), ['b2']);
  const unknown = { captions: [{ role: 'translation', status: 'weird', segmentId: 'w', translatedText: 'x' }, { role: 'system', status: 'final', segmentId: 'y', translatedText: 'x' }] };
  assert.deepEqual(buildCaptionFrame({ captions: unknown, lane: 'tab', lang: 'ko' }).rows, [], 'unknown roles and statuses are not shown');
});

test('buildCaptionFrame: rule 5, ids cut to 64, text cut to 400 keeping the END, skipped only for translation rows', () => {
  const store = newStore();
  say(store, { id: 'i'.repeat(100), text: 'long id' });
  say(store, { id: 'exact', text: 'e'.repeat(400) });
  say(store, { id: 'over', text: `${'a'.repeat(300)}${'b'.repeat(101)}` });
  say(store, { id: 'tail', text: `${'x'.repeat(500)}THE END` });
  const frame = frameOf(store, { maxRows: 6 });
  assert.equal(frame.rows[0].id.length, 64);
  assert.equal(frame.rows[1].text, 'e'.repeat(400), 'exactly 400 characters are kept whole');
  assert.equal(frame.rows[2].text.length, 400);
  assert.equal(frame.rows[2].text, `…${'a'.repeat(298)}${'b'.repeat(101)}`);
  assert.equal(frame.rows[3].text.length, 400);
  assert.ok(frame.rows[3].text.startsWith('…x') && frame.rows[3].text.endsWith('THE END'));
  assert.equal(validateFrame('host->panel', frame).ok, true);
  // emoji are two UTF-16 units: the cut never leaves half a pair at the front
  const emoji = newStore();
  say(emoji, { id: 'e1', text: '\u{1F600}'.repeat(500) });
  const cut = frameOf(emoji).rows[0].text;
  assert.ok(cut.length <= 400);
  assert.ok(cut.isWellFormed(), 'no lone surrogate');
  assert.ok(cut.startsWith('…\u{1F600}'));
  // skipped: translation rows whose segment the reply detector dropped; a source row with the same id is not
  const skipped = newStore();
  say(skipped, { id: 'seg-1', text: 'dropped reply' });
  say(skipped, { id: 'seg-1', role: 'source', text: 'source with the same id' });
  say(skipped, { id: 'seg-2', text: 'kept' });
  const marked = frameOf(skipped, { skippedSegments: ['seg-1', 'unrelated'], showSource: true });
  assert.deepEqual(marked.rows.map((row) => [row.role, row.id, row.skipped]), [['translation', 'seg-1', true], ['source', 'seg-1', false], ['translation', 'seg-2', false]]);
  assert.equal(frameOf(skipped, { skippedSegments: undefined }).rows.some((row) => row.skipped), false);
  assert.equal(frameOf(skipped, { skippedSegments: 'seg-1' }).rows.some((row) => row.skipped), false, 'not a list: nothing is skipped');
});

test('buildCaptionFrame: rule 6 copies the sticky gaps and rule 7 clamps maxRows', () => {
  const store = newStore();
  for (let i = 1; i <= 10; i += 1) say(store, { id: `r${i}`, text: `row ${i}` });
  assert.deepEqual(frameOf(store).gaps, { input: false, audio: false, reception: false });
  store.markGap('audio');
  assert.deepEqual(frameOf(store).gaps, { input: false, audio: true, reception: false });
  store.markGap('input'); store.markGap('reception');
  assert.deepEqual(frameOf(store).gaps, { input: true, audio: true, reception: true });
  assert.deepEqual(buildCaptionFrame({ captions: { captions: [], gaps: { input: 'yes', audio: 1, reception: true } }, lane: 'tab', lang: 'ko' }).gaps, { input: false, audio: false, reception: true });
  const rows = (maxRows) => frameOf(store, maxRows === undefined ? {} : { maxRows }).rows.length;
  assert.equal(rows(undefined), 4, 'the panel default');
  assert.equal(rows(0), 1);
  assert.equal(rows(-5), 1);
  assert.equal(rows(1), 1);
  assert.equal(rows(6), 6);
  assert.equal(rows(7), 6);
  assert.equal(rows(99), 6);
  assert.equal(rows(3.9), 3);
  assert.equal(rows(NaN), 4);
  assert.equal(rows('3'), 4, 'not a number: the default');
  assert.equal(rows(Infinity), 4);
  assert.equal(LIMITS.maxRows, 6);
});

test('buildCaptionFrame: counters and language are sanitized', () => {
  const frame = (patch) => buildCaptionFrame({ lane: 'tab', lang: 'ja', epoch: 5, seq: 9, ...patch });
  assert.deepEqual([frame({}).epoch, frame({}).seq, frame({}).lang], [5, 9, 'ja']);
  for (const bad of [-1, 1.5, NaN, '3', null, undefined, Infinity]) assert.deepEqual([frame({ epoch: bad }).epoch, frame({ seq: bad }).seq], [0, 0]);
  for (const bad of ['fr', 'src', '', null, undefined, 4]) assert.equal(frame({ lang: bad }).lang, 'en');
  assert.equal(validateFrame('host->panel', frame({ lang: 'nope' })).ok, true, 'the frame always validates');
});

test('buildCaptionFrame: rule 8, the frame always fits 8192 characters, dropping the oldest rows first', () => {
  const bytes = (frame) => JSON.stringify(frame).length;
  // every character escapes to six: 400 of them is 2400 characters of JSON per row
  const heavy = newStore();
  for (let i = 1; i <= 8; i += 1) say(heavy, { id: `h${i}`, text: '\u0001'.repeat(400) });
  const frame = frameOf(heavy, { maxRows: 6 });
  assert.ok(bytes(frame) <= LIMITS.maxFrameBytes, `${bytes(frame)} bytes`);
  assert.ok(frame.rows.length >= 1 && frame.rows.length < 6);
  assert.deepEqual(ids(frame), ['h3', 'h4', 'h5', 'h6', 'h7', 'h8'].slice(-frame.rows.length), 'the newest rows survive');
  assert.equal(validateFrame('host->panel', frame).ok, true);
  // the store's own ceiling: 100 settled rows of 16000 characters
  const huge = newStore();
  for (let i = 1; i <= 100; i += 1) say(huge, { id: `g${i}`, text: `${i}`.padStart(16000, 'w') });
  assert.equal(huge.snapshot().captions.length, 100);
  for (const maxRows of [1, 4, 6]) {
    const big = frameOf(huge, { maxRows });
    assert.equal(big.rows.length, maxRows);
    assert.ok(bytes(big) <= LIMITS.maxFrameBytes, `${maxRows}: ${bytes(big)} bytes`);
    assert.ok(big.rows.every((row) => row.text.length <= LIMITS.maxRowChars));
    assert.equal(validateFrame('host->overlay', big).ok, true);
  }
  // quotes escape to two characters
  const quoted = newStore();
  for (let i = 1; i <= 6; i += 1) say(quoted, { id: `q${i}`, text: '"'.repeat(400) });
  assert.ok(bytes(frameOf(quoted, { maxRows: 6 })) <= LIMITS.maxFrameBytes);
});

test('buildCaptionFrame never carries the session id, generation, times or metrics of the store', () => {
  const store = newStore();
  say(store, { id: 'a', text: 'visible words' });
  const text = JSON.stringify(frameOf(store));
  for (const leak of ['sess-1', 'generation', 'receivedAt', 'finalizedAt', 'metrics', 'sequence', 'revision', 'gapBefore', 'sourceText']) assert.equal(text.includes(leak), false, leak);
  assert.ok(text.includes('visible words'));
});

test('buildCaptionFrame properties over random stores: valid, bounded, chronological and never dropping a partial that fits', () => {
  let seed = 424242;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const alphabet = ['plain words', 'a', ' ', '\u0001\u0002', '"quoted"', '\u{1F600}', 'こんにちは', 'x'.repeat(300), '\\'];
  for (let round = 0; round < 150; round += 1) {
    const store = newStore();
    const count = Math.floor(next() * 14);
    for (let i = 0; i < count; i += 1) {
      const role = pick(['translation', 'translation', 'source']);
      const text = Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(alphabet)).join('');
      say(store, { id: `r${round}-${i}`, role, text, status: pick(['final', 'final', 'partial']) });
    }
    const showSource = next() < 0.5;
    const maxRows = pick([1, 2, 3, 4, 5, 6]);
    const skippedSegments = next() < 0.5 ? [`r${round}-1`] : [];
    const frame = buildCaptionFrame({ captions: store.snapshot(), skippedSegments, lane: pick(LANES), lang: pick(['ko', 'en', 'ja']), epoch: round, seq: round + 1, showSource, maxRows, live: true });
    assert.equal(validateFrame('host->panel', frame).ok, true, JSON.stringify(frame));
    assert.ok(JSON.stringify(frame).length <= LIMITS.maxFrameBytes);
    assert.ok(frame.rows.length <= maxRows);
    const order = new Map(store.snapshot().captions.map((row) => [row.segmentId, row.order]));
    const shown = frame.rows.map((row) => order.get(row.id));
    assert.deepEqual(shown, [...shown].sort((a, b) => a - b), 'oldest first, newest last');
    const eligible = store.snapshot().captions.filter((row) => (showSource || row.role === 'translation')
      && (row.role === 'source' ? row.sourceText : row.translatedText).trim() !== '');
    const partials = eligible.filter((row) => row.status === 'partial');
    const newestSettled = eligible.filter((row) => row.status !== 'partial').sort((a, b) => b.order - a.order);
    const expected = [...partials, ...newestSettled.slice(0, Math.max(0, maxRows - partials.length))].sort((a, b) => a.order - b.order).slice(-maxRows);
    if (JSON.stringify(frame).length < LIMITS.maxFrameBytes && frame.rows.length === expected.length) {
      assert.deepEqual(frame.rows.map((row) => row.id), expected.map((row) => row.segmentId), 'the selection rule of 4.6.3 rule 4');
    }
  }
});

test('buildStyleFrame refuses a style the host would never hold', () => {
  const style = { size: 1.5, position: 'bottom', display: 'dark', showSource: false, maxLines: 3, autoHideSeconds: 8 };
  assert.deepEqual(buildStyleFrame(style).style, { size: 1.5, position: 'bottom', display: 'dark', maxLines: 3, autoHideSeconds: 8 });
  assert.equal(buildStyleFrame({ ...style, showSource: undefined }).type, 'style', 'showSource is not part of the overlay frame');
  for (const bad of [null, undefined, {}, { ...style, size: 1.1 }, { ...style, position: 'left' }, { ...style, maxLines: 0 }, 'x']) {
    assert.throws(() => buildStyleFrame(bad), (error) => error.code === 'INVALID_REQUEST');
  }
});

// ---------------------------------------------------------------------------------------------
// createFrameCoalescer
function fakeClock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    timers,
    now: () => time,
    setTimeout(fn, ms) { id += 1; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(handle) { timers.delete(handle); },
    set(value) { time = value; },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); time = due[1].at; due[1].fn();
      }
      time = end;
    },
  };
}
function coalescer(options = {}) {
  const clock = fakeClock();
  const sent = [];
  const instance = createFrameCoalescer({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    send: (key, frame) => sent.push({ key, frame, at: clock.now() }), ...options });
  return { clock, sent, instance };
}
const frameWith = (value, seq = 0) => ({ v: 1, type: 'state', value, seq });

test('coalescer: the first push is sent at once, later ones wait for ONE trailing send that carries the newest frame', () => {
  const { clock, sent, instance } = coalescer();
  instance.push('state', frameWith('a'));
  assert.deepEqual(sent.map((item) => item.frame.value), ['a']);
  clock.advance(30);
  instance.push('state', frameWith('b'));
  instance.push('state', frameWith('c'));
  instance.push('state', frameWith('d'));
  assert.equal(sent.length, 1, 'nothing more inside the interval');
  assert.equal(clock.timers.size, 1, 'exactly one trailing timer');
  assert.equal([...clock.timers.values()][0].at, 100, 'at lastSend + intervalMs');
  clock.advance(69);
  assert.equal(sent.length, 1);
  clock.advance(1);
  assert.deepEqual(sent.map((item) => [item.frame.value, item.at]), [['a', 0], ['d', 100]], 'b and c were replaced, never sent');
  assert.equal(clock.timers.size, 0);
  clock.advance(500);
  instance.push('state', frameWith('e'));
  assert.equal(sent.at(-1).frame.value, 'e', 'after a quiet interval the leading edge is immediate again');
  assert.equal(sent.at(-1).at, 600);
});

test('coalescer: a key never sends more than once per interval, and the last frame is never lost', () => {
  const { clock, sent, instance } = coalescer();
  for (let t = 0; t <= 2000; t += 10) { clock.set(t); instance.push('captions:tab', { v: 1, type: 'captions', n: t }); clock.advance(0); }
  clock.advance(1000);
  const times = sent.map((item) => item.at);
  assert.ok(times.length >= 19 && times.length <= 21, `${times.length} sends for 2 s at 100 ms`);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= LIMITS.frameIntervalMs, `${times[i - 1]} -> ${times[i]}`);
  assert.equal(sent.at(-1).frame.n, 2000, 'the newest frame is delivered');
  assert.equal(LIMITS.frameIntervalMs, 100);
});

test('coalescer: keys are independent and the interval is configurable', () => {
  const { clock, sent, instance } = coalescer({ intervalMs: 250 });
  instance.push('state', frameWith('s1'));
  instance.push('captions:tab', frameWith('t1'));
  instance.push('captions:mic', frameWith('m1'));
  assert.deepEqual(sent.map((item) => item.key), ['state', 'captions:tab', 'captions:mic'], 'each key has its own leading edge');
  clock.advance(100);
  instance.push('state', frameWith('s2'));
  instance.push('captions:tab', frameWith('t2'));
  clock.advance(149);
  assert.equal(sent.length, 3);
  clock.advance(1);
  assert.deepEqual(sent.slice(3).map((item) => [item.key, item.at]), [['state', 250], ['captions:tab', 250]]);
  assert.equal(sent.some((item) => item.frame.value === 'm2'), false);
});

test('coalescer: a frame equal to the last SENT one, apart from seq, is skipped', () => {
  const { clock, sent, instance } = coalescer();
  instance.push('state', frameWith('a', 1));
  clock.advance(200);
  instance.push('state', frameWith('a', 2));
  instance.push('state', frameWith('a', 3));
  assert.equal(sent.length, 1, 'only seq changed: nothing to say');
  instance.push('state', frameWith('b', 4));
  assert.deepEqual(sent.map((item) => item.frame.seq), [1, 4]);
  // A then B pending then A again before the trailing send: the trailing send is a duplicate of what was sent
  clock.advance(200);
  instance.push('state', frameWith('c', 5));
  clock.advance(20);
  instance.push('state', frameWith('d', 6));
  instance.push('state', frameWith('c', 7));
  clock.advance(500);
  assert.deepEqual(sent.map((item) => item.frame.value), ['a', 'b', 'c'], 'the d that was replaced by c never went out, and c is not repeated');
  assert.equal(clock.timers.size, 0);
  // non-object frames compare by value
  const plain = coalescer();
  plain.instance.push('x', 'same'); plain.instance.push('x', 'same');
  plain.clock.advance(500);
  assert.equal(plain.sent.length, 1);
  plain.instance.push('x', 'other'); plain.clock.advance(500);
  assert.deepEqual(plain.sent.map((item) => item.frame), ['same', 'other']);
  plain.instance.push('x', undefined);
  plain.clock.advance(500);
  assert.equal(plain.sent.length, 2, 'undefined is not a frame');
});

test('coalescer: flush sends every pending frame now and cancels the trailing timers', () => {
  const { clock, sent, instance } = coalescer();
  instance.push('state', frameWith('a'));
  instance.push('captions:tab', frameWith('t1'));
  clock.advance(30);
  instance.push('state', frameWith('b'));
  instance.push('captions:tab', frameWith('t2'));
  assert.equal(clock.timers.size, 2);
  instance.flush();
  assert.deepEqual(sent.slice(2).map((item) => [item.key, item.frame.value, item.at]), [['state', 'b', 30], ['captions:tab', 't2', 30]]);
  assert.equal(clock.timers.size, 0, 'no second send later');
  clock.advance(1000);
  assert.equal(sent.length, 4);
  instance.flush();
  assert.equal(sent.length, 4, 'nothing pending: nothing sent');
  // a flush counts as a send: the next push waits out the interval from the flush
  const again = coalescer();
  again.instance.push('state', frameWith('a'));
  again.clock.advance(30);
  again.instance.push('state', frameWith('b'));
  again.instance.flush();
  assert.deepEqual(again.sent.map((item) => [item.frame.value, item.at]), [['a', 0], ['b', 30]]);
  again.clock.advance(10);
  again.instance.push('state', frameWith('c'));
  assert.equal(again.sent.length, 2);
  assert.equal([...again.clock.timers.values()][0].at, 130, 'lastSend + intervalMs after a flush');
  // flush still skips a duplicate
  const dupe = coalescer();
  dupe.instance.push('state', frameWith('a', 1));
  dupe.instance.push('state', frameWith('a', 2));
  dupe.instance.flush();
  assert.equal(dupe.sent.length, 1);
});

test('coalescer: dispose cancels timers, drops pending frames and ignores later calls', () => {
  const { clock, sent, instance } = coalescer();
  instance.push('state', frameWith('a'));
  clock.advance(10);
  instance.push('state', frameWith('b'));
  instance.push('captions:tab', frameWith('t'));
  instance.push('captions:tab', frameWith('t2'));
  assert.ok(clock.timers.size >= 1);
  instance.dispose();
  assert.equal(clock.timers.size, 0);
  clock.advance(1000);
  instance.push('state', frameWith('c'));
  instance.flush();
  clock.advance(1000);
  assert.deepEqual(sent.map((item) => item.frame.value), ['a', 't'], 'only what went out before dispose');
  assert.doesNotThrow(() => instance.dispose());
  // a timer that fires after dispose sends nothing
  const late = coalescer();
  late.instance.push('k', frameWith('a'));
  late.clock.advance(10);
  late.instance.push('k', frameWith('b'));
  const [pending] = [...late.clock.timers.values()];
  late.instance.dispose();
  pending.fn();
  assert.equal(late.sent.length, 1);
});

test('coalescer: send receives (key, frame) as pushed, and a throwing send never breaks it', () => {
  const calls = [];
  let fail = true;
  const clock = fakeClock();
  const instance = createFrameCoalescer({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    send(key, frame) { calls.push([key, frame]); if (fail) throw new Error('port closed'); } });
  const first = frameWith('a');
  assert.doesNotThrow(() => instance.push('state', first));
  assert.equal(calls[0][0], 'state');
  assert.equal(calls[0][1], first, 'the very object that was pushed');
  fail = false;
  clock.advance(150);
  instance.push('state', frameWith('b'));
  assert.equal(calls.length, 2, 'later frames still go out');
  assert.equal(instance.push.length, 2);
  assert.ok(Object.isFrozen(instance));
});

test('coalescer: construction needs send and the injected clock; the defaults use the real one', () => {
  const clock = fakeClock();
  for (const options of [{}, { send: 'x' }, { send: () => {}, now: 'x' }, { send: () => {}, setTimeout: null, now: clock.now }, { send: () => {}, clearTimeout: 3 }]) {
    assert.throws(() => createFrameCoalescer(options), (error) => error.code === 'INVALID_REQUEST');
  }
  assert.throws(() => createFrameCoalescer(), (error) => error.code === 'INVALID_REQUEST');
  const sent = [];
  const real = createFrameCoalescer({ send: (key, frame) => sent.push([key, frame]) });
  real.push('state', frameWith('a'));
  assert.equal(sent.length, 1, 'the leading edge needs no timer');
  real.dispose();
});
