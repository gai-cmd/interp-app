import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SECRET_PATTERNS } from '../scripts/check-release.mjs';
import {
  CAPTION_DISPLAYS, CAPTION_POSITIONS, CAPTION_SIZE, DEFAULT_STYLE, GAP_KINDS, HOST_ID_PATTERN, KEY_PATTERN, LANE_PHASES,
  MACHINE_CODE_PATTERN, STYLE_LIMITS, TARGET_LANGUAGES, VOICE_GENDERS, clampCaptionSize, deepFreeze, isMachineCode,
  isPlainObject, isValidStyle, normalizeStyle,
} from '../extension/lib/constants.js';
import {
  FRAME_DIRECTIONS, FRAME_TYPES, LANES, LIMITS, MESSAGE_CATALOG, MESSAGE_TYPES, PATHS, PORT_NAMES, PROTOCOL_CODES,
  PROTOCOL_VERSION, SENDER_ROLES, STORAGE_KEYS, TARGETS, createMessageRouter, makeFrame, makeMessage, senderRole,
  validateFrame, validateLaneState, validateMessage, validateUiState,
} from '../extension/lib/protocol.js';
import { buildCaptionFrame, buildStyleFrame } from '../extension/lib/caption-frames.js';
import { buildUiState, createIdleLaneState } from '../extension/lib/ui-state.js';

// Fixtures are inline (group D's shared fakes land in parallel): a runtime bus with the three members the
// router and senderRole read, and runtime-assembled fake keys (the privacy scan reads every file under tests/).
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `${['chrome', 'extension'].join('-')}://${EXT_ID}`;
const FAKE_KEY = ['synthetic', 'x'.repeat(24)].join('-');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeRuntime() {
  const listeners = new Set();
  return { id: EXT_ID, getURL: (path = '') => `${ORIGIN}/${path}`, listeners,
    onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } };
}
// Delivers one message to every listener the way the fan-out does and collects what they answered.
async function deliver(runtime, message, sender) {
  const responses = [], returned = [];
  for (const fn of [...runtime.listeners]) returned.push(fn(message, sender, (body) => responses.push(body)));
  await flush();
  return { responses, returned };
}
const SENDERS = Object.freeze({
  sw: { id: EXT_ID, url: `${ORIGIN}/extension/background/service-worker.js`, origin: ORIGIN },
  swBare: { id: EXT_ID },
  panel: { id: EXT_ID, url: `${ORIGIN}/extension/panel/panel.html`, origin: ORIGIN, frameId: 0, documentId: 'doc-1' },
  offscreen: { id: EXT_ID, url: `${ORIGIN}/extension/engine/host.html`, origin: ORIGIN, frameId: 0, documentId: 'doc-2' },
  options: { id: EXT_ID, url: `${ORIGIN}/extension/options/options.html`, origin: ORIGIN, frameId: 0, tab: { id: 9 } },
  permission: { id: EXT_ID, url: `${ORIGIN}/extension/permission/mic-permission.html`, origin: ORIGIN, frameId: 0, tab: { id: 10 } },
  content: { id: EXT_ID, url: 'https://claude.ai/doc/1', origin: 'https://claude.ai', frameId: 0, tab: { id: 3 } },
});

const STYLE = Object.freeze({ size: 1.5, position: 'bottom', display: 'dark', showSource: false, maxLines: 3, autoHideSeconds: 8 });
const LANE_START = Object.freeze({ lane: 'tab', key: FAKE_KEY,
  request: { targetLanguage: 'ko', model: 'gemini-3.5-live-translate-preview' }, voiceGender: 'female', muted: true,
  captions: false, style: STYLE, tab: { tabId: 123, streamId: 'fake-stream-1', originalVolume: 65 } });
const MIC_START = (() => { const { tab, ...rest } = LANE_START; return Object.freeze({ ...rest, lane: 'mic' }); })();
const HOST_SETTINGS = Object.freeze({ settings: { speechMuted: true, tabOriginalVolume: 65,
  captions: { tab: true, mic: false }, style: STYLE } });
// One valid payload per catalog row (target and version come from the catalog).
const VALID = Object.freeze({
  'sw/lane-start': { lane: 'tab', tabId: 5 },
  'sw/lane-stop': {},
  'sw/permission-open': {},
  'sw/host-probe': {},
  'sw/host-idle': { hostId: 'h-abc123', reason: 'panel-gone' },
  'host/ping': {},
  'host/lane-start': LANE_START,
  'host/lane-stop': { lane: 'mic' },
  'host/settings': HOST_SETTINGS,
  'host/overlay-wanted': { tabId: 7, active: true },
  'host/overlay-result': { tabId: 7, ok: false, lanes: ['tab', 'mic'] },
  'host/tab-removed': { tabId: 7 },
  'content/overlay-attach': {},
});
const message = (type, payload = VALID[type]) => ({ v: 1, target: MESSAGE_CATALOG[type].target, type, ...payload });
const clone = (value) => JSON.parse(JSON.stringify(value));
const withPatch = (base, patch) => ({ ...clone(base), ...patch });

function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

test('shared constants are frozen and pinned to the values of section 3.5', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(PORT_NAMES, { panel: 'interp-panel/1', overlay: 'interp-overlay/1' });
  assert.deepEqual(LANES, ['tab', 'mic']);
  assert.deepEqual(TARGETS, ['sw', 'offscreen', 'panel', 'content']);
  assert.deepEqual(SENDER_ROLES, ['sw', 'panel', 'offscreen', 'options', 'permission', 'content', 'foreign']);
  assert.deepEqual(STORAGE_KEYS, { settings: 'interp.settings.v1', key: 'interp.key.v1', armed: 'interp.armed.v1',
    host: 'interp.host.v1', lastStop: 'interp.lastStop.v1' });
  assert.deepEqual(PATHS, { sw: 'extension/background/service-worker.js', panel: 'extension/panel/panel.html',
    options: 'extension/options/options.html', host: 'extension/engine/host.html',
    permission: 'extension/permission/mic-permission.html', overlay: 'extension/overlay/overlay.js' });
  assert.deepEqual(LIMITS, { maxFrameBytes: 8192, maxRowChars: 400, maxRows: 6, maxOverlayPorts: 4, maxPanelPorts: 4,
    frameIntervalMs: 100, panelGraceMs: 3000, panelInitialGraceMs: 15000, statusLingerMs: 9000, stopWaitMs: 4000,
    startSettleMs: 3000, streamIdMaxChars: 512, keyMaxChars: 512, titleMaxChars: 60, maxArmedTabs: 32 });
  assert.deepEqual(PROTOCOL_CODES, ['INVALID_MESSAGE', 'FORBIDDEN', 'UNKNOWN_TYPE', 'INTERNAL']);
  for (const value of [PORT_NAMES, LANES, TARGETS, SENDER_ROLES, STORAGE_KEYS, PATHS, LIMITS, PROTOCOL_CODES, MESSAGE_CATALOG,
    MESSAGE_TYPES, FRAME_TYPES, FRAME_DIRECTIONS, VOICE_GENDERS, TARGET_LANGUAGES, CAPTION_SIZE, CAPTION_POSITIONS,
    CAPTION_DISPLAYS, STYLE_LIMITS, DEFAULT_STYLE, LANE_PHASES, GAP_KINDS]) assert.ok(isDeepFrozen(value));
  // The two numbers that must agree across the modules that cannot import each other.
  assert.equal(STYLE_LIMITS.maxLines.max, LIMITS.maxRows);
  assert.equal(LIMITS.keyMaxChars, 512);
  assert.ok(KEY_PATTERN.test('a'.repeat(LIMITS.keyMaxChars)) && !KEY_PATTERN.test('a'.repeat(LIMITS.keyMaxChars + 1)));
});

test('the catalog has the 13 rows of section 4.2 with a target that matches the type prefix', () => {
  assert.deepEqual([...MESSAGE_TYPES].sort(), Object.keys(VALID).sort());
  const targetOfPrefix = { sw: 'sw', host: 'offscreen', content: 'content' };
  for (const type of MESSAGE_TYPES) {
    const row = MESSAGE_CATALOG[type];
    assert.equal(row.target, targetOfPrefix[type.split('/')[0]], type);
    assert.ok(row.roles.length > 0 && row.roles.every((role) => SENDER_ROLES.includes(role) && role !== 'foreign'), type);
    assert.ok(row.errors.length > 0 && row.errors.every(isMachineCode), type);
  }
  assert.deepEqual(MESSAGE_CATALOG['sw/lane-start'].roles, ['panel']);
  assert.deepEqual(MESSAGE_CATALOG['sw/host-idle'].roles, ['offscreen']);
  assert.deepEqual(MESSAGE_CATALOG['host/lane-start'].roles, ['sw']);
  assert.deepEqual(MESSAGE_CATALOG['content/overlay-attach'].roles, ['sw']);
  assert.ok(MESSAGE_CATALOG['sw/lane-start'].errors.includes('NEEDS_ARM'));
  assert.ok(!MESSAGE_CATALOG['host/lane-start'].errors.includes('NEEDS_ARM'));
  assert.equal(MESSAGE_CATALOG['host/lane-start'].errors.length, MESSAGE_CATALOG['sw/lane-start'].errors.length - 1);
  for (const type of MESSAGE_TYPES) assert.ok(!MESSAGE_CATALOG[type].roles.includes('content'), 'a content script may send no catalog message');
});

test('validateMessage accepts one valid payload per row and returns a frozen sanitized copy', () => {
  for (const type of MESSAGE_TYPES) {
    const result = validateMessage(message(type));
    assert.equal(result.ok, true, type);
    assert.deepEqual(result.message, message(type), type);
    assert.ok(isDeepFrozen(result.message) && Object.isFrozen(result), type);
  }
  const mic = validateMessage(message('host/lane-start', MIC_START));
  assert.equal(mic.ok, true);
  assert.equal('tab' in mic.message, false);
  assert.equal(validateMessage(message('sw/lane-stop', {})).ok, true);
  assert.equal(validateMessage(message('sw/lane-stop', { lane: 'tab' })).ok, true);
});

test('validateMessage drops unknown fields at every level so they can never be forwarded', () => {
  const noisy = message('host/lane-start', { ...clone(LANE_START), extra: 1, request: { ...LANE_START.request, extra: 2 },
    tab: { ...LANE_START.tab, extra: 3 }, style: { ...STYLE, extra: 4 } });
  const clean = validateMessage(noisy);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.message, message('host/lane-start'));
  assert.equal(validateMessage({ ...message('sw/lane-start', { lane: 'mic', tabId: 12, junk: true }) }).ok, true);
  assert.deepEqual(validateMessage(message('sw/lane-start', { lane: 'mic', tabId: 12, junk: true })).message,
    message('sw/lane-start', { lane: 'mic' }), 'tabId is ignored for the microphone');
  const settings = validateMessage(message('host/settings', { settings: { ...clone(HOST_SETTINGS.settings), extra: 1,
    captions: { tab: true, mic: false, extra: 2 } }, extra: 3 }));
  assert.deepEqual(settings.message, message('host/settings'));
  assert.deepEqual(validateMessage(message('host/overlay-result', { tabId: 1, ok: true, lanes: ['tab'], key: FAKE_KEY })).message,
    message('host/overlay-result', { tabId: 1, ok: true, lanes: ['tab'] }));
});

test('validateMessage rejects a broken envelope', () => {
  const good = message('host/ping');
  for (const bad of [null, undefined, 'x', 5, [], [good], () => good, { ...good, v: 2 }, { ...good, v: '1' }, { ...good, v: undefined },
    { ...good, target: 'sw' }, { ...good, target: 'panel' }, { ...good, target: undefined }, { ...good, type: undefined },
    { ...good, type: 'host/unknown' }, { ...good, type: 'constructor' }, { ...good, type: '__proto__' }, { ...good, type: 'toString' },
    { ...good, type: ['host/ping'] }, { v: 1, target: 'offscreen' }, { v: 1, type: 'host/ping' }]) {
    assert.deepEqual(validateMessage(bad), { ok: false, code: 'INVALID_MESSAGE' });
  }
  const explosive = { v: 1, target: 'offscreen', type: 'host/lane-stop', get lane() { throw new Error('boom'); } };
  assert.equal(validateMessage(explosive).ok, false, 'a throwing getter is an invalid message, not an exception');
  // The prefix decides the target: a valid type under the wrong target is refused.
  for (const type of MESSAGE_TYPES) {
    for (const target of TARGETS.filter((candidate) => candidate !== MESSAGE_CATALOG[type].target)) {
      assert.equal(validateMessage({ ...message(type), target }).ok, false, `${type} to ${target}`);
    }
  }
});

test('validateMessage checks each row payload', () => {
  const invalid = (type, payload) => assert.equal(validateMessage(message(type, payload)).ok, false, `${type} ${JSON.stringify(payload)}`);
  for (const bad of [{}, { lane: 'sw' }, { lane: 'tab' }, { lane: 'tab', tabId: -1 }, { lane: 'tab', tabId: 1.5 },
    { lane: 'tab', tabId: '1' }, { lane: 'tab', tabId: null }, { lane: 'both' }, { lane: null }]) invalid('sw/lane-start', bad);
  for (const bad of [{ lane: 'sw' }, { lane: null }, { lane: 0 }]) { invalid('sw/lane-stop', bad); invalid('host/lane-stop', bad); }
  for (const bad of [{}, { hostId: 'h-1' }, { reason: 'panel-gone' }, { hostId: 'h-1', reason: 'bored' }, { hostId: '', reason: 'panel-gone' },
    { hostId: 'x'.repeat(65), reason: 'panel-gone' }, { hostId: 'has space', reason: 'initial-grace' }, { hostId: 5, reason: 'panel-gone' },
    { hostId: 'h-1', reason: undefined }]) invalid('sw/host-idle', bad);
  for (const reason of ['panel-gone', 'initial-grace']) assert.equal(validateMessage(message('sw/host-idle', { hostId: 'x'.repeat(64), reason })).ok, true);
  for (const bad of [{}, { tabId: 1 }, { active: true }, { tabId: -1, active: true }, { tabId: 1, active: 'yes' }, { tabId: 1.2, active: true }]) invalid('host/overlay-wanted', bad);
  for (const bad of [{}, { tabId: 1, ok: true }, { tabId: 1, ok: 'y', lanes: [] }, { tabId: 1, ok: true, lanes: ['tab', 'tab'] },
    { tabId: 1, ok: true, lanes: ['tab', 'mic', 'tab'] }, { tabId: 1, ok: true, lanes: ['sw'] }, { tabId: 1, ok: true, lanes: 'tab' },
    { tabId: -3, ok: true, lanes: [] }]) invalid('host/overlay-result', bad);
  assert.equal(validateMessage(message('host/overlay-result', { tabId: 0, ok: true, lanes: [] })).ok, true);
  for (const bad of [{}, { tabId: -1 }, { tabId: 'a' }, { tabId: 2 ** 60 }]) invalid('host/tab-removed', bad);
  const settings = HOST_SETTINGS.settings;
  for (const bad of [{}, { settings: null }, { settings: { ...settings, speechMuted: 'yes' } }, { settings: { ...settings, tabOriginalVolume: 101 } },
    { settings: { ...settings, tabOriginalVolume: -1 } }, { settings: { ...settings, tabOriginalVolume: 50.5 } },
    { settings: { ...settings, captions: { tab: true } } }, { settings: { ...settings, captions: { tab: 1, mic: false } } },
    { settings: { ...settings, style: { ...STYLE, size: 1.1 } } }, { settings: { ...settings, style: undefined } },
    { settings: { ...settings, key: FAKE_KEY, speechMuted: undefined } }]) invalid('host/settings', bad);
});

test('host/lane-start: key, stream id, tab and request shape rules of section 4.2.1', () => {
  const invalid = (patch, label) => {
    const result = validateMessage(message('host/lane-start', withPatch(LANE_START, patch)));
    assert.equal(result.ok, false, label);
    assert.equal(JSON.stringify(result).includes('synthetic'), false, `${label}: a failure never echoes the input`);
  };
  for (const [label, key] of [['empty', ''], ['space', 'has space'], ['control', 'bad\u0007key'], ['non-ASCII', `café-${'x'.repeat(24)}`],
    ['DEL', `key\u007f${'x'.repeat(24)}`], ['513 chars', 'x'.repeat(513)], ['number', 12345], ['null', null], ['array', [FAKE_KEY]]]) invalid({ key }, `key ${label}`);
  assert.equal(validateMessage(message('host/lane-start', withPatch(LANE_START, { key: 'x'.repeat(512) }))).ok, true);
  assert.equal(validateMessage(message('host/lane-start', withPatch(LANE_START, { key: '!' }))).ok, true);
  invalid({ lane: 'both' }, 'lane');
  invalid({ request: { targetLanguage: 'fr', model: 'gemini-3.8-live' } }, 'language');
  invalid({ request: { targetLanguage: 'ko', model: 'm'.repeat(65) } }, 'model too long');
  invalid({ request: { targetLanguage: 'ko', model: '' } }, 'model empty');
  invalid({ request: { targetLanguage: 'ko', model: 7 } }, 'model type');
  invalid({ request: { targetLanguage: 'ko' } }, 'model missing');
  invalid({ request: null }, 'request');
  assert.equal(validateMessage(message('host/lane-start', withPatch(LANE_START, { request: { targetLanguage: 'ja', model: 'm'.repeat(64) } }))).ok, true);
  invalid({ voiceGender: 'robot' }, 'voice');
  invalid({ muted: 'true' }, 'muted');
  invalid({ captions: 0 }, 'captions');
  invalid({ style: { ...STYLE, maxLines: 7 } }, 'style');
  invalid({ style: null }, 'style null');
  const tab = (patch) => ({ tab: { ...LANE_START.tab, ...patch } });
  invalid({ tab: undefined }, 'tab missing for the tab lane');
  invalid(tab({ tabId: -1 }), 'tabId');
  invalid(tab({ tabId: 1.5 }), 'tabId fraction');
  invalid(tab({ streamId: '' }), 'streamId empty');
  invalid(tab({ streamId: 's'.repeat(513) }), 'streamId long');
  invalid(tab({ streamId: 12 }), 'streamId type');
  invalid(tab({ originalVolume: 101 }), 'volume high');
  invalid(tab({ originalVolume: -1 }), 'volume low');
  invalid(tab({ originalVolume: 65.5 }), 'volume fraction');
  invalid(tab({ originalVolume: '65' }), 'volume type');
  assert.equal(validateMessage(message('host/lane-start', withPatch(LANE_START, tab({ streamId: 's'.repeat(512), originalVolume: 0 })))).ok, true);
  assert.equal(validateMessage(message('host/lane-start', withPatch(LANE_START, tab({ originalVolume: 100, tabId: 0 })))).ok, true);
  assert.equal(validateMessage(message('host/lane-start', withPatch(MIC_START, { tab: LANE_START.tab }))).ok, false, 'tab is present iff lane is tab');
  assert.equal(validateMessage(message('host/lane-start', MIC_START)).ok, true);
});

test('makeMessage builds the envelope, cannot be told a different target and refuses what a receiver would refuse', () => {
  for (const type of MESSAGE_TYPES) assert.deepEqual(makeMessage(type, VALID[type]), message(type), type);
  assert.deepEqual(makeMessage('sw/lane-stop'), { v: 1, target: 'sw', type: 'sw/lane-stop' });
  assert.deepEqual(makeMessage('sw/lane-stop', { v: 9, target: 'offscreen', type: 'host/ping' }), { v: 1, target: 'sw', type: 'sw/lane-stop' });
  assert.ok(Object.isFrozen(makeMessage('host/ping')));
  const failed = (fn) => { try { fn(); } catch (error) { return error; } return null; };
  for (const attemptMessage of [() => makeMessage('nope'), () => makeMessage(undefined), () => makeMessage('sw/lane-start', { lane: 'tab' }),
    () => makeMessage('host/lane-start', withPatch(LANE_START, { key: `${FAKE_KEY} with space` }))]) {
    const error = failed(attemptMessage);
    assert.equal(error?.code, 'INVALID_MESSAGE');
    assert.equal(JSON.stringify([error.message, error.code]).includes('synthetic'), false, 'the error never carries the payload');
    assert.equal(String(error.stack).includes('synthetic'), false);
  }
});

test('the validator accepts every normalizeStyle output over a grid and rejects off-grid raw values', () => {
  let count = 0;
  for (let step = 0; step <= 8; step += 1) {
    const size = 1 + step * 0.125;
    for (const position of CAPTION_POSITIONS) for (const display of CAPTION_DISPLAYS) {
      for (const maxLines of [1, 2, 3, 4, 5, 6]) for (const autoHideSeconds of [0, 1, 8, 59, 60]) {
        for (const showSource of [false, true]) {
          const raw = { size, position, display, showSource, maxLines, autoHideSeconds };
          const style = normalizeStyle(raw);
          assert.deepEqual(style, raw);
          assert.equal(isValidStyle(style), true);
          assert.equal(validateMessage(message('host/settings', { settings: { ...HOST_SETTINGS.settings, style } })).ok, true);
          assert.equal(validateMessage(message('host/lane-start', withPatch(LANE_START, { style }))).ok, true);
          count += 1;
        }
      }
    }
  }
  assert.equal(count, 9 * 2 * 3 * 6 * 5 * 2);
  const offGrid = [1.1, 1.0625, 2.125, 0.875, 0, -1, '1.5', NaN, Infinity, null, undefined, {}, true];
  for (const size of offGrid) {
    assert.equal(isValidStyle({ ...STYLE, size }), false, `size ${String(size)}`);
    assert.equal(validateMessage(message('host/settings', { settings: { ...HOST_SETTINGS.settings, style: { ...STYLE, size } } })).ok, false);
    assert.equal(isValidStyle(normalizeStyle({ ...STYLE, size })), true, 'normalizing the raw value always yields a valid style');
  }
  for (const patch of [{ position: 'left' }, { display: 'blue' }, { maxLines: 0 }, { maxLines: 7 }, { maxLines: 2.5 }, { maxLines: '3' },
    { autoHideSeconds: -1 }, { autoHideSeconds: 61 }, { autoHideSeconds: 1.5 }, { showSource: 'no' }, { showSource: undefined }]) {
    assert.equal(isValidStyle({ ...STYLE, ...patch }), false, JSON.stringify(patch));
    assert.equal(isValidStyle(normalizeStyle({ ...STYLE, ...patch })), true);
  }
  assert.equal(isValidStyle(null), false);
  assert.equal(isValidStyle({ ...STYLE, showSource: undefined }, { showSource: false }), true, 'the overlay style has no showSource');
  assert.deepEqual(normalizeStyle(undefined), DEFAULT_STYLE);
  assert.deepEqual(normalizeStyle([1, 2]), DEFAULT_STYLE);
  assert.deepEqual(normalizeStyle({ ...STYLE, size: '1.6', extra: 1 }), { ...STYLE, size: 1.625 });
});

test('clampCaptionSize keeps the semantics of the app (nearest step, default on garbage)', () => {
  assert.equal(clampCaptionSize(undefined), 1.5);
  assert.equal(clampCaptionSize('abc'), 1.5);
  assert.equal(clampCaptionSize(0), 1);
  assert.equal(clampCaptionSize(99), 2);
  assert.equal(clampCaptionSize('1.26'), 1.25);
  assert.equal(clampCaptionSize(1.1875), 1.25);
});

test('senderRole classifies every row of the table in 4.4', () => {
  const runtime = fakeRuntime();
  const role = (sender) => senderRole(sender, runtime);
  assert.equal(role(SENDERS.sw), 'sw');
  assert.equal(role(SENDERS.panel), 'panel');
  assert.equal(role(SENDERS.offscreen), 'offscreen');
  // The options and permission pages are opened in tabs: origin decides, never `sender.tab` alone.
  assert.equal(role(SENDERS.options), 'options');
  assert.equal(role(SENDERS.permission), 'permission');
  assert.equal(role({ ...SENDERS.panel, tab: { id: 1 } }), 'panel');
  assert.equal(role(SENDERS.content), 'content');
  assert.equal(role({ id: EXT_ID, tab: { id: 3 }, frameId: 0 }), 'content', 'a tab sender with no origin at all is still not the SW');
  // The SW's MessageSender may have no url (A23): the narrow url-less rule.
  assert.equal(role(SENDERS.swBare), 'sw');
  assert.equal(role({ id: EXT_ID, origin: ORIGIN }), 'sw');
  assert.equal(role({ id: EXT_ID, origin: ORIGIN, url: undefined }), 'sw');
  for (const extra of [{ frameId: 0 }, { documentId: 'd' }, { tab: { id: 1 } }]) {
    assert.equal(role({ id: EXT_ID, origin: ORIGIN, ...extra }), 'foreign', `an extension sender with no url and ${Object.keys(extra)[0]} is not the SW`);
  }
  // Paths under extension/ that are not a page group are foreign; the overlay is a content script, never a page.
  for (const path of ['extension/overlay/overlay.js', 'extension/lib/protocol.js', 'other.html', 'extension/panelx/a.html', '']) {
    assert.equal(role({ id: EXT_ID, url: `${ORIGIN}/${path}`, origin: ORIGIN, frameId: 0 }), 'foreign', path);
  }
  assert.equal(role({ id: EXT_ID, url: `${ORIGIN}/extension/panel/../background/x.js`, origin: ORIGIN }), 'sw', 'dot segments are resolved before the prefix test');
  assert.equal(role({ id: EXT_ID, url: `${ORIGIN}//extension/panel/panel.html?x=1#y`, origin: ORIGIN, frameId: 0 }), 'panel');
  // Other extensions, pages without a tab, and unusable input.
  assert.equal(role({ ...SENDERS.panel, id: 'someoneelse' }), 'foreign');
  assert.equal(role({ url: SENDERS.panel.url, origin: ORIGIN }), 'foreign');
  assert.equal(role({ id: EXT_ID, url: 'https://claude.ai/', origin: 'https://claude.ai', frameId: 0 }), 'foreign', 'a page frame without a tab');
  for (const bad of [undefined, null, 'sw', 5, []]) assert.equal(role(bad), 'foreign');
  assert.equal(senderRole(SENDERS.sw, undefined), 'foreign');
  assert.equal(senderRole(SENDERS.sw, { getURL: runtime.getURL }), 'foreign');
  assert.equal(role({ get id() { throw new Error('boom'); } }), 'foreign', 'never throws');
  assert.equal(senderRole(SENDERS.panel, { id: EXT_ID, getURL() { throw new Error('boom'); } }), 'foreign');
});

test('a content script is never sw, panel or offscreen, whatever its url claims', () => {
  const runtime = fakeRuntime();
  const forged = [
    { id: EXT_ID, url: `https://evil.example/${'extension/background/service-worker.js'}`, origin: 'https://evil.example', tab: { id: 4 }, frameId: 0 },
    { id: EXT_ID, url: `${ORIGIN}/extension/panel/panel.html`, origin: 'https://evil.example', tab: { id: 4 }, frameId: 0 },
    { id: EXT_ID, origin: 'https://evil.example', tab: { id: 4 }, frameId: 0, documentId: 'x' },
    { id: EXT_ID, url: 'https://evil.example/', tab: { id: 4 }, frameId: 2 },
    { id: EXT_ID, tab: { id: 4 } },
  ];
  for (const sender of forged) {
    const role = senderRole(sender, runtime);
    assert.equal(role, 'content', JSON.stringify(sender));
    for (const type of MESSAGE_TYPES) assert.equal(MESSAGE_CATALOG[type].roles.includes(role), false);
  }
});

test('the router ignores other targets and non-messages without answering (step 1)', async () => {
  const runtime = fakeRuntime();
  let called = 0;
  createMessageRouter({ runtime, target: 'sw', handlers: { 'sw/host-probe': async () => { called += 1; return { up: true }; } } });
  const ignored = [null, undefined, 'sw/host-probe', 4, [], { ...message('host/ping') }, { ...message('sw/host-probe'), v: 2 },
    { ...message('sw/host-probe'), target: 'panel' }, { ...message('sw/host-probe'), target: undefined }, { type: 'sw/host-probe' }];
  for (const item of ignored) {
    const { responses, returned } = await deliver(runtime, item, SENDERS.panel);
    assert.deepEqual(returned, [false]);
    assert.deepEqual(responses, []);
  }
  assert.equal(called, 0);
  const ok = await deliver(runtime, message('sw/host-probe'), SENDERS.panel);
  assert.deepEqual(ok, { responses: [{ ok: true, up: true }], returned: [true] });
  assert.equal(called, 1);
});

test('the router answers INVALID_MESSAGE, FORBIDDEN and UNKNOWN_TYPE, in that order of checks (steps 2-4)', async () => {
  const runtime = fakeRuntime();
  const called = [];
  const handlers = Object.fromEntries(MESSAGE_TYPES.map((type) => [type, async (received) => { called.push(type); return { echoed: received.type }; }]));
  delete handlers['sw/host-probe'];
  createMessageRouter({ runtime, target: 'sw', handlers });
  const forbidden = { ok: false, code: 'FORBIDDEN' };
  // 2: validation comes before the role check
  assert.deepEqual(await deliver(runtime, message('sw/lane-start', { lane: 'tab' }), SENDERS.panel),
    { responses: [{ ok: false, code: 'INVALID_MESSAGE' }], returned: [false] });
  assert.deepEqual(await deliver(runtime, message('sw/lane-start', { lane: 'tab' }), SENDERS.content),
    { responses: [{ ok: false, code: 'INVALID_MESSAGE' }], returned: [false] });
  // 3: every sender that is not the panel is forbidden for the panel's messages, and a content script for every type
  for (const sender of [SENDERS.sw, SENDERS.offscreen, SENDERS.options, SENDERS.permission, SENDERS.content, SENDERS.swBare, { id: 'x' }, undefined]) {
    assert.deepEqual(await deliver(runtime, message('sw/lane-start'), sender), { responses: [forbidden], returned: [false] });
  }
  assert.deepEqual(await deliver(runtime, message('sw/host-idle'), SENDERS.panel), { responses: [forbidden], returned: [false] });
  assert.deepEqual(await deliver(runtime, message('sw/host-idle'), SENDERS.offscreen).then((r) => r.returned), [true]);
  assert.deepEqual(called, ['sw/host-idle']);
  // 4: a valid, permitted message whose handler is missing
  assert.deepEqual(await deliver(runtime, message('sw/host-probe'), SENDERS.panel),
    { responses: [{ ok: false, code: 'UNKNOWN_TYPE' }], returned: [false] });
  // Every catalog type: a content sender is FORBIDDEN, never handled.
  for (const type of MESSAGE_TYPES) {
    const contextRuntime = fakeRuntime();
    let handled = 0;
    createMessageRouter({ runtime: contextRuntime, target: MESSAGE_CATALOG[type].target, handlers: { [type]: async () => { handled += 1; return {}; } } });
    assert.deepEqual(await deliver(contextRuntime, message(type), SENDERS.content), { responses: [forbidden], returned: [false] }, type);
    assert.equal(handled, 0, type);
  }
});

test('handlers get the sanitized message, the sender and the role; the router adds ok (step 5)', async () => {
  const runtime = fakeRuntime();
  const seen = [];
  createMessageRouter({ runtime, target: 'offscreen', handlers: {
    'host/lane-start': async (received, sender, role) => { seen.push({ received, sender, role }); return { epoch: 3, ok: false, code: 'X_FAKE' }; },
    'host/ping': (received) => ({ hostId: 'h-1', protocol: 1, lanes: { tab: 'off', mic: 'off' }, tabId: null, panels: 0, sync: received.type }),
    'host/lane-stop': async () => undefined,
    'host/tab-removed': async () => 'not an object',
  } });
  const noisy = { ...message('host/lane-start'), extra: 'dropped', request: { ...LANE_START.request, extra: 1 } };
  const first = await deliver(runtime, noisy, SENDERS.sw);
  assert.deepEqual(first, { responses: [{ epoch: 3, ok: true }], returned: [true] }, 'a handler cannot override ok or code');
  assert.deepEqual(seen[0].received, message('host/lane-start'), 'unknown fields are never forwarded');
  assert.ok(Object.isFrozen(seen[0].received));
  assert.equal(seen[0].sender, SENDERS.sw);
  assert.equal(seen[0].role, 'sw');
  assert.deepEqual((await deliver(runtime, message('host/ping'), SENDERS.swBare)).responses,
    [{ hostId: 'h-1', protocol: 1, lanes: { tab: 'off', mic: 'off' }, tabId: null, panels: 0, sync: 'host/ping', ok: true }], 'a synchronous handler works too');
  assert.deepEqual((await deliver(runtime, message('host/lane-stop'), SENDERS.sw)).responses, [{ ok: true }]);
  assert.deepEqual((await deliver(runtime, message('host/tab-removed'), SENDERS.sw)).responses, [{ ok: true }]);
});

test('a throwing handler becomes a machine code and its text is discarded (steps 5 and 6)', async () => {
  const runtime = fakeRuntime();
  const secret = 'provider said: token leaked';
  const coded = (code, text = secret) => Object.assign(new Error(text), { code });
  createMessageRouter({ runtime, target: 'sw', handlers: {
    'sw/lane-start': async () => { throw coded('NEEDS_ARM'); },
    'sw/lane-stop': async () => { throw new Error(secret); },
    'sw/permission-open': async () => { throw coded('lowercase_code'); },
    'sw/host-probe': () => { throw coded('X'); },
    'sw/host-idle': async () => { throw secret; },
  } });
  const answer = async (type, sender = SENDERS.panel) => (await deliver(runtime, message(type), sender)).responses;
  assert.deepEqual(await answer('sw/lane-start'), [{ ok: false, code: 'NEEDS_ARM' }], 'a thrown machine code passes');
  assert.deepEqual(await answer('sw/lane-stop'), [{ ok: false, code: 'INTERNAL' }]);
  assert.deepEqual(await answer('sw/permission-open'), [{ ok: false, code: 'INTERNAL' }], 'a code that is not machine-shaped is INTERNAL');
  assert.deepEqual(await answer('sw/host-probe'), [{ ok: false, code: 'INTERNAL' }], 'a one-letter code does not match the shape');
  assert.deepEqual(await answer('sw/host-idle', SENDERS.offscreen), [{ ok: false, code: 'INTERNAL' }], 'a thrown string');
  for (const body of [await answer('sw/lane-stop'), await answer('sw/host-idle', SENDERS.offscreen)]) assert.equal(JSON.stringify(body).includes('leaked'), false);
});

test('the router never logs, never rethrows and survives a sendResponse that throws', async (t) => {
  const calls = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace']) t.mock.method(console, name, () => { calls.push(name); });
  const runtime = fakeRuntime();
  createMessageRouter({ runtime, target: 'sw', handlers: { 'sw/lane-stop': async () => { throw new Error('x'); }, 'sw/host-probe': async () => ({ up: false }) } });
  const [listener] = [...runtime.listeners];
  for (const type of ['sw/lane-stop', 'sw/host-probe', 'sw/lane-start']) {
    assert.doesNotThrow(() => listener(message(type, type === 'sw/lane-start' ? { lane: 'x' } : {}), SENDERS.panel, () => { throw new Error('port closed'); }));
  }
  assert.doesNotThrow(() => listener(message('sw/host-probe'), { get id() { throw new Error('boom'); } }, () => {}));
  await flush();
  assert.deepEqual(calls, []);
});

test('the router may be given a role resolver, can be disposed and rejects a wrong setup', async () => {
  const runtime = fakeRuntime();
  const router = createMessageRouter({ runtime, target: 'sw', roleOf: () => 'panel', handlers: { 'sw/host-probe': async () => ({ up: true }) } });
  assert.deepEqual((await deliver(runtime, message('sw/host-probe'), undefined)).responses, [{ ok: true, up: true }]);
  assert.equal(runtime.listeners.size, 1);
  router.dispose();
  assert.equal(runtime.listeners.size, 0);
  assert.doesNotThrow(() => router.dispose());
  assert.ok(Object.isFrozen(router));
  const rejected = (options) => { try { createMessageRouter(options); } catch (error) { return error.code; } return null; };
  assert.equal(rejected({ runtime, target: 'nowhere' }), 'INVALID_REQUEST');
  assert.equal(rejected({ runtime: {}, target: 'sw' }), 'INVALID_REQUEST');
  assert.equal(rejected(undefined), 'INVALID_REQUEST');
  // 'panel' is reserved: the router accepts it, but no v1 message uses it, so nothing validates.
  const panelRuntime = fakeRuntime();
  createMessageRouter({ runtime: panelRuntime, target: 'panel', handlers: {} });
  assert.deepEqual((await deliver(panelRuntime, { v: 1, target: 'panel', type: 'panel/anything' }, SENDERS.sw)).responses, [{ ok: false, code: 'INVALID_MESSAGE' }]);
  assert.deepEqual((await deliver(panelRuntime, message('sw/host-probe'), SENDERS.panel)).responses, [], 'a message for another target is left alone');
});

test('two routers on one bus stay silent for each other so the first sendResponse is the right one', async () => {
  const bus = fakeRuntime();
  createMessageRouter({ runtime: bus, target: 'sw', handlers: { 'sw/host-probe': async () => ({ from: 'sw' }) } });
  createMessageRouter({ runtime: bus, target: 'offscreen', handlers: { 'host/ping': async () => ({ from: 'offscreen' }) } });
  assert.deepEqual(await deliver(bus, message('sw/host-probe'), SENDERS.panel), { responses: [{ from: 'sw', ok: true }], returned: [true, false] });
  assert.deepEqual(await deliver(bus, message('host/ping'), SENDERS.sw), { responses: [{ from: 'offscreen', ok: true }], returned: [false, true] });
});

test('frames: one validator per direction returns a sanitized frozen copy and drops the rest', () => {
  assert.deepEqual(FRAME_DIRECTIONS, ['panel->host', 'host->panel', 'overlay->host', 'host->overlay']);
  const hello = { v: 1, type: 'hello' };
  assert.deepEqual(validateFrame('panel->host', { ...hello, extra: 1 }), { ok: true, frame: hello });
  assert.deepEqual(validateFrame('overlay->host', hello), { ok: true, frame: hello });
  assert.deepEqual(validateFrame('host->panel', { v: 1, type: 'bye' }), { ok: true, frame: { v: 1, type: 'bye' } });
  assert.deepEqual(validateFrame('host->overlay', { v: 1, type: 'bye' }), { ok: true, frame: { v: 1, type: 'bye' } });
  // direction gates the type: the overlay and the panel send nothing but hello
  for (const type of ['state', 'captions', 'bye', 'style', 'clear', 'status']) {
    assert.equal(validateFrame('panel->host', { v: 1, type }).ok, false, type);
    assert.equal(validateFrame('overlay->host', { v: 1, type }).ok, false, type);
  }
  assert.equal(validateFrame('host->panel', hello).ok, false);
  assert.equal(validateFrame('host->overlay', hello).ok, false);
  assert.equal(validateFrame('host->panel', { v: 1, type: 'style', style: buildStyleFrame(STYLE).style }).ok, false, 'style is for the overlay only');
  assert.equal(validateFrame('host->overlay', { v: 1, type: 'state', state: buildUiState({ hostId: 'h-1', seq: 1 }) }).ok, false, 'state is for the panel only');
  for (const bad of [null, undefined, 'hello', [], { type: 'hello' }, { v: 2, type: 'hello' }, { v: 1 }, { v: 1, type: 'nope' }]) {
    assert.deepEqual(validateFrame('panel->host', bad), { ok: false });
  }
  assert.deepEqual(validateFrame('sideways', hello), { ok: false });
  assert.deepEqual(validateFrame(undefined, hello), { ok: false });
  assert.deepEqual(validateFrame('__proto__', hello), { ok: false });
  const clear = validateFrame('host->overlay', { v: 1, type: 'clear', lane: 'mic', junk: 1 });
  assert.deepEqual(clear.frame, { v: 1, type: 'clear', lane: 'mic' });
  assert.equal(validateFrame('host->overlay', { v: 1, type: 'clear', lane: 'sw' }).ok, false);
  assert.equal(validateFrame('host->overlay', { v: 1, type: 'clear' }).ok, false);
  for (const phase of ['reconnecting', 'stopped', 'running']) assert.equal(validateFrame('host->overlay', { v: 1, type: 'status', lane: 'tab', phase }).ok, true);
  for (const phase of ['off', 'error', undefined, 'Running']) assert.equal(validateFrame('host->overlay', { v: 1, type: 'status', lane: 'tab', phase }).ok, false);
  assert.equal(validateFrame('host->overlay', { v: 1, type: 'status', lane: 'x', phase: 'running' }).ok, false);
  assert.ok(isDeepFrozen(clear));
});

test('frames: the style frame carries exactly the five overlay fields', () => {
  const frame = buildStyleFrame(STYLE);
  assert.deepEqual(frame, { v: 1, type: 'style', style: { size: 1.5, position: 'bottom', display: 'dark', maxLines: 3, autoHideSeconds: 8 } });
  assert.deepEqual(validateFrame('host->overlay', frame), { ok: true, frame });
  const noisy = validateFrame('host->overlay', { ...frame, style: { ...frame.style, showSource: true, extra: 1 } });
  assert.deepEqual(noisy.frame, frame, 'showSource is applied host-side and never forwarded');
  for (const patch of [{ size: 1.1 }, { position: 'left' }, { display: 'x' }, { maxLines: 9 }, { autoHideSeconds: 100 }, { size: undefined }]) {
    assert.equal(validateFrame('host->overlay', { ...frame, style: { ...frame.style, ...patch } }).ok, false, JSON.stringify(patch));
  }
});

test('frames: a state frame validates UiState field by field and rejects anything out of range', () => {
  const state = buildUiState({ hostId: 'h-1', seq: 4, speechMuted: false });
  const frame = { v: 1, type: 'state', state };
  assert.deepEqual(validateFrame('host->panel', frame), { ok: true, frame });
  assert.deepEqual(validateUiState(state), state);
  const lane = (patch, which = 'tab') => ({ ...frame, state: { ...state, lanes: { ...state.lanes, [which]: { ...state.lanes[which], ...patch } } } });
  const bad = [{ phase: 'weird' }, { engineStatus: 'sleeping' }, { retries: 4 }, { retries: -1 }, { output: 'loud' }, { model: 'm'.repeat(65) }, { model: '' },
    { route: 'flash2' }, { fallback: 'no' }, { targetLanguage: 'fr' }, { errorCode: 'lower' }, { errorCode: 'X'.repeat(50) }, { quota: 1 },
    { keyFailure: null }, { level: 101 }, { level: 0.5 }, { tabId: -1 }, { tabId: '3' }, { captions: 'on' }, { overlay: 'gone' }, { gap: 'other' },
    { epoch: -1 }, { epoch: 1.5 }, { lane: 'mic' }];
  for (const patch of bad) assert.equal(validateFrame('host->panel', lane(patch)).ok, false, JSON.stringify(patch));
  const good = { phase: 'running', engineStatus: 'running', retries: 3, output: 'catching-up', model: 'm'.repeat(64), route: 'translation', fallback: true,
    targetLanguage: 'ja', errorCode: 'RATE_LIMITED', quota: true, keyFailure: false, level: 100, tabId: 0, captions: true, overlay: 'attached', gap: 'reception', epoch: 9 };
  assert.equal(validateFrame('host->panel', lane(good)).ok, true);
  for (const patch of [{ seq: 0 }, { seq: 1.5 }, { hostId: '' }, { hostId: 'a b' }, { hostId: 'x'.repeat(65) }, { speechMuted: 'no' }, { concurrent: 3 }, { concurrent: -1 },
    { v: 2 }, { lanes: null }, { lanes: { tab: state.lanes.tab } }, { lanes: { tab: state.lanes.mic, mic: state.lanes.mic } }]) {
    assert.equal(validateFrame('host->panel', { ...frame, state: { ...state, ...patch } }).ok, false, JSON.stringify(patch));
  }
  assert.equal(validateLaneState(state.lanes.tab, 'mic'), null);
  assert.equal(validateLaneState(state.lanes.tab, 'both'), null);
  assert.equal(validateFrame('host->panel', { ...frame, state: { ...state, secret: FAKE_KEY, lanes: { tab: { ...state.lanes.tab, sessionId: 's' }, mic: state.lanes.mic } } }).frame.state.secret, undefined);
  assert.equal('sessionId' in validateFrame('host->panel', { ...frame, state: { ...state, lanes: { tab: { ...state.lanes.tab, sessionId: 's' }, mic: state.lanes.mic } } }).frame.state.lanes.tab, false);
});

test('frames: a captions frame is bounded, typed and capped at 8192 characters of JSON', () => {
  const row = { id: 't1', role: 'translation', status: 'final', text: 'hello', skipped: false };
  const frame = { v: 1, type: 'captions', epoch: 2, seq: 5, lane: 'tab', lang: 'ko', rows: [row], gaps: { input: false, audio: true, reception: false }, live: true };
  for (const direction of ['host->panel', 'host->overlay']) assert.deepEqual(validateFrame(direction, frame), { ok: true, frame });
  assert.equal(validateFrame('panel->host', frame).ok, false);
  const noisy = validateFrame('host->panel', { ...frame, junk: 1, rows: [{ ...row, junk: 2 }], gaps: { ...frame.gaps, junk: true } });
  assert.deepEqual(noisy.frame, frame);
  const bad = [{ epoch: -1 }, { seq: 'a' }, { lane: 'sw' }, { lang: 'src' }, { lang: undefined }, { live: 1 }, { rows: 'x' }, { rows: Array.from({ length: 7 }, () => row) },
    { rows: [{ ...row, id: '' }] }, { rows: [{ ...row, id: 'i'.repeat(65) }] }, { rows: [{ ...row, role: 'system' }] }, { rows: [{ ...row, status: 'done' }] },
    { rows: [{ ...row, text: '' }] }, { rows: [{ ...row, text: 'x'.repeat(401) }] }, { rows: [{ ...row, skipped: 0 }] }, { rows: [null] },
    { gaps: null }, { gaps: { input: false, audio: false } }, { gaps: { input: 0, audio: false, reception: false } }];
  for (const patch of bad) assert.equal(validateFrame('host->panel', { ...frame, ...patch }).ok, false, JSON.stringify(patch));
  assert.equal(validateFrame('host->panel', { ...frame, rows: [{ ...row, text: 'x'.repeat(400) }] }).ok, true);
  assert.equal(validateFrame('host->panel', { ...frame, rows: Array.from({ length: 6 }, (_, i) => ({ ...row, id: `t${i}` })) }).ok, true);
  const huge = { ...frame, rows: Array.from({ length: 6 }, (_, i) => ({ ...row, id: `t${i}`, text: `${'\u0007'.repeat(400)}`.slice(0, 400) })) };
  assert.ok(JSON.stringify(huge).length > LIMITS.maxFrameBytes);
  assert.equal(validateFrame('host->panel', huge).ok, false, 'a frame over the byte cap is dropped');
  const built = buildCaptionFrame({ captions: null, lane: 'mic', lang: 'en', epoch: 1, seq: 2, live: true });
  assert.equal(validateFrame('host->overlay', built).ok, true);
});

test('makeFrame stamps the version, checks the shape and refuses a frame no receiver accepts', () => {
  assert.deepEqual(makeFrame('hello'), { v: 1, type: 'hello' });
  assert.deepEqual(makeFrame('bye'), { v: 1, type: 'bye' });
  assert.deepEqual(makeFrame('clear', { lane: 'tab' }), { v: 1, type: 'clear', lane: 'tab' });
  assert.deepEqual(makeFrame('status', { lane: 'mic', phase: 'reconnecting' }), { v: 1, type: 'status', lane: 'mic', phase: 'reconnecting' });
  assert.deepEqual(makeFrame('clear', { lane: 'tab', v: 9, type: 'bye' }), { v: 1, type: 'clear', lane: 'tab' });
  assert.deepEqual(makeFrame('state', { state: buildUiState({ hostId: 'h-9', seq: 2 }) }).state.hostId, 'h-9');
  assert.deepEqual(makeFrame('style', buildStyleFrame(STYLE)).style.maxLines, 3);
  assert.ok(Object.isFrozen(makeFrame('hello')));
  for (const attemptFrame of [() => makeFrame('clear', { lane: 'nope' }), () => makeFrame('nope'), () => makeFrame('state', {}), () => makeFrame('status', { lane: 'tab' })]) {
    assert.throws(attemptFrame, (error) => error.code === 'INVALID_MESSAGE');
  }
});

test('constants: helpers for plain data, machine codes and key shapes', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  for (const value of [null, undefined, [], 'x', 1, () => {}, new Map(), new Date(), new (class Thing {})()]) assert.equal(isPlainObject(value), false);
  assert.equal(isPlainObject(JSON.parse('{"a":1}')), true);
  assert.equal(deepFreeze({ a: { b: [{ c: 1 }] } }).a.b[0].c, 1);
  assert.ok(isDeepFrozen(deepFreeze({ a: { b: [{ c: 1 }] } })));
  assert.ok(isDeepFrozen(deepFreeze(Object.freeze({ inner: { x: 1 } }))), 'a frozen shell does not stop the descent');
  for (const code of ['NEEDS_ARM', 'HOST_UNAVAILABLE', 'UNKNOWN_429', 'AB']) assert.equal(isMachineCode(code), true, code);
  for (const code of ['A', 'a', 'Needs_ARM', '1ABC', 'AB CD', 'X'.repeat(42), '', null, undefined, 4]) assert.equal(isMachineCode(code), false, String(code));
  assert.ok(MACHINE_CODE_PATTERN.test('X'.repeat(41)) && !MACHINE_CODE_PATTERN.test('X'.repeat(42)));
  assert.ok(HOST_ID_PATTERN.test('h-1') && !HOST_ID_PATTERN.test('h 1') && !HOST_ID_PATTERN.test('h'.repeat(65)));
});

test('source hygiene of the five lib files: no platform names, no logging, allowed imports only, no key-shaped text', async () => {
  const files = { constants: [], protocol: ['./constants.js'],
    settings: ['./constants.js', './protocol.js', '../../app/providers/gemini/live-config.js', '../../app/security/shared-key.js'],
    'ui-state': ['./constants.js', './protocol.js'], 'caption-frames': ['./constants.js', './protocol.js'] };
  const platformWord = new RegExp(`\\b(${['chr', 'ome'].join('')}|browser)\\b`, 'i');
  for (const [name, allowed] of Object.entries(files)) {
    const source = await readFile(new URL(`../extension/lib/${name}.js`, import.meta.url), 'utf8');
    // comments and string literals are removed first: a justification comment may say "console" or "document"
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    assert.equal(/chrome/i.test(source), false, `${name}: the word chrome does not appear at all`);
    assert.equal(platformWord.test(code), false, `${name}: no platform identifier`);
    for (const forbidden of [/\bconsole\./, /\beval\(/, /new Function/, /innerHTML|outerHTML|insertAdjacentHTML/, /document\.write/, /\bdebugger\b/,
      /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, /\bdocument\./, /\bwindow\./, /\bnavigator\b/, /importScripts/, /\bfetch\(/]) {
      assert.equal(forbidden.test(code), false, `${name}: ${forbidden}`);
    }
    const specifiers = [...source.matchAll(/(?:import|export)[^;]*?from\s*'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(specifiers)].sort(), [...allowed].sort(), `${name}: imports`);
    for (const specifier of specifiers) assert.ok(specifier.startsWith('.') && specifier.endsWith('.js'), specifier);
    for (const pattern of SECRET_PATTERNS) assert.equal(pattern.test(source), false, `${name}: ${pattern}`);
  }
});

test('importing any lib module touches no platform global', async () => {
  const names = ['chrome', 'browser', 'document', 'window', 'localStorage', 'sessionStorage', 'indexedDB', 'AudioContext'];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`import touched ${name}`); } });
  }
  try {
    for (const file of ['constants', 'protocol', 'settings', 'ui-state', 'caption-frames']) {
      await import(`../extension/lib/${file}.js?purity=${file}`);
    }
  } finally {
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
  assert.ok(true);
});

test('LaneState helpers used by these tests stay consistent with the frame validator', () => {
  for (const lane of LANES) assert.deepEqual(validateLaneState(createIdleLaneState(lane), lane), createIdleLaneState(lane));
});
