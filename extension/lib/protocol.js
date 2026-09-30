// New implementation of docs/extension.md §3.5 and §4; no legacy code is ported.
// Wire contract of the extension: shared constants, the control-plane message catalog with its
// validators, sender classification, the message router and the data-plane frame validators.
// Imports ONLY ./constants.js (R4), names no platform API (the runtime arrives by injection) and touches
// no global at import time. Failures are machine codes (4.1); nothing here logs, and a rejected
// message is never echoed, so a `key` in a bad `host/lane-start` cannot leak through an error.
import {
  CAPTION_ROLES, CAPTION_STATUSES, ENGINE_STATUSES, GAP_KINDS, HOST_ID_PATTERN, KEY_PATTERN, LANE_PHASES,
  MODEL_MAX_CHARS, ORIGINAL_VOLUME, OUTPUT_STATES, OVERLAY_STATES, RECONNECT_REASONS, ROUTES, STATUS_PHASES, TARGET_LANGUAGES,
  VOICE_GENDERS, deepFreeze, isLanguagePair, isMachineCode, isPlainObject, isValidStyle,
} from './constants.js';

export const PROTOCOL_VERSION = 1;
export const PORT_NAMES = Object.freeze({ panel: 'interp-panel/1', overlay: 'interp-overlay/1' });
export const LANES = Object.freeze(['tab', 'mic']);
export const TARGETS = Object.freeze(['sw', 'offscreen', 'panel', 'content']);   // 'panel' is reserved, unused in v1
export const SENDER_ROLES = Object.freeze(['sw', 'panel', 'offscreen', 'options', 'permission', 'content', 'foreign']);
export const STORAGE_KEYS = Object.freeze({
  settings: 'interp.settings.v1', key: 'interp.key.v1',      // storage.local
  armed: 'interp.armed.v1', host: 'interp.host.v1',          // storage.session
  lastStop: 'interp.lastStop.v1',                            // storage.session: why the last run ended (4.10)
});
export const PATHS = Object.freeze({                          // extension-root relative, no leading slash
  sw: 'extension/background/service-worker.js', panel: 'extension/panel/panel.html',
  options: 'extension/options/options.html', host: 'extension/engine/host.html',
  permission: 'extension/permission/mic-permission.html', overlay: 'extension/overlay/overlay.js',
});
// §17: the query the service worker appends to PATHS.permission on a first install; the page then shows the setup steps.
export const SETUP_QUERY = 'setup=1';
export const LIMITS = Object.freeze({
  maxFrameBytes: 8192,      // JSON.stringify(frame).length, hard cap for state/captions/style frames
  maxRowChars: 400,         // one caption row text, kept from the END (newest words)
  maxRows: 6,               // rows in one captions frame
  maxOverlayPorts: 4,       // simultaneously attached overlay tabs: the captured tab, the tab you look at, plus transition slack (LRU eviction)
  maxPanelPorts: 4,         // simultaneously connected panels (one per window)
  frameIntervalMs: 100,     // coalescing interval per lane and destination
  panelGraceMs: 3000,       // last panel port gone -> stop lanes
  panelInitialGraceMs: 15000, // host created but no panel port yet -> stop lanes and report idle
  statusLingerMs: 9000,     // after a lane ends in error, overlay ports stay open this long so the `status` frame can be read
  stopWaitMs: 4000,         // SW: how long a Start waits for a lane that is still 'stopping' (bounded poll, 6.3 step 3)
  startSettleMs: 3000,      // host: how long stop() waits for an in-flight start to notice its cancel flag
  streamIdMaxChars: 512, keyMaxChars: 512, titleMaxChars: 60,
  maxArmedTabs: 32,
});
// Codes the protocol layer itself answers with (4.9); every other code is a handler's or the engine's.
export const PROTOCOL_CODES = Object.freeze(['INVALID_MESSAGE', 'FORBIDDEN', 'UNKNOWN_TYPE', 'INTERNAL']);

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
/** Error carrying only a machine code (never a message that could hold a key or provider text). */
const codedError = (code) => Object.assign(new Error(code), { code });

const int = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const isLane = (value) => LANES.includes(value);
const own = (object, key) => (typeof key === 'string' && Object.hasOwn(object, key) ? object[key] : undefined);
const pickStyle = (style) => ({ size: style.size, position: style.position, display: style.display,
  showSource: style.showSource, maxLines: style.maxLines, autoHideSeconds: style.autoHideSeconds });

// ---------------------------------------------------------------------------------------------
// 4.2 message catalog (control plane). `errors` is the documented error-code column (the panel and
// the SW test against it); the router itself only ever produces PROTOCOL_CODES.
const LANE_START_ERRORS = ['NEEDS_ARM', 'CREDENTIAL_REQUIRED', 'TAB_UNSUPPORTED', 'TAB_GONE', 'TAB_CAPTURE_BUSY',
  'TAB_CAPTURE_FAILED', 'TAB_AUDIO_BLOCKED', 'HOST_UNAVAILABLE', 'ALREADY_RUNNING', 'LANE_STOPPING', 'START_CANCELLED',
  'MICROPHONE_DENIED', 'MICROPHONE_UNAVAILABLE', 'SESSION_LIMIT', 'MODEL_UNSUPPORTED', 'INVALID_REQUEST',
  'INVALID_MESSAGE', 'FORBIDDEN', 'INTERNAL'];
const row = (target, roles, errors) => Object.freeze({ target, roles: Object.freeze(roles), errors: Object.freeze(errors) });
export const MESSAGE_CATALOG = Object.freeze({
  'sw/lane-start': row('sw', ['panel'], LANE_START_ERRORS),
  'sw/lane-stop': row('sw', ['panel'], ['FORBIDDEN', 'INVALID_MESSAGE']),
  'sw/permission-open': row('sw', ['panel'], ['INTERNAL', 'FORBIDDEN']),
  'sw/host-probe': row('sw', ['panel'], ['FORBIDDEN']),
  'sw/host-idle': row('sw', ['offscreen'], ['FORBIDDEN', 'INVALID_MESSAGE']),
  'host/ping': row('offscreen', ['sw'], ['FORBIDDEN']),
  'host/lane-start': row('offscreen', ['sw'], LANE_START_ERRORS.filter((code) => code !== 'NEEDS_ARM')),
  'host/lane-stop': row('offscreen', ['sw'], ['FORBIDDEN', 'INVALID_MESSAGE']),
  'host/settings': row('offscreen', ['sw'], ['INVALID_MESSAGE', 'FORBIDDEN']),
  'host/overlay-wanted': row('offscreen', ['sw'], ['FORBIDDEN']),
  'host/overlay-result': row('offscreen', ['sw'], ['FORBIDDEN']),
  'host/tab-removed': row('offscreen', ['sw'], ['FORBIDDEN']),
  'content/overlay-attach': row('content', ['sw'], ['FORBIDDEN']),
});
export const MESSAGE_TYPES = Object.freeze(Object.keys(MESSAGE_CATALOG));

const laneList = (value) => Array.isArray(value) && value.length <= LANES.length && value.every(isLane)
  && new Set(value).size === value.length;

// 4.2.1: the ONE place the key and the stream id are validated on the wire.
function laneStartOf(m) {
  if (!isLane(m.lane) || !matches(KEY_PATTERN, m.key)) return null;
  const { request } = m;
  if (!isPlainObject(request) || !TARGET_LANGUAGES.includes(request.targetLanguage)
    || !text(request.model, 1, MODEL_MAX_CHARS)) return null;
  // Two-way: `languages` is optional, but when it is there it must be exactly two distinct interpretation languages
  // (anything else, null included, is refused: a half-valid pair must never be guessed into a one-way session).
  if (request.languages !== undefined && !isLanguagePair(request.languages)) return null;
  if (!VOICE_GENDERS.includes(m.voiceGender) || typeof m.muted !== 'boolean' || typeof m.captions !== 'boolean'
    || !isValidStyle(m.style)) return null;
  const pair = request.languages === undefined ? {} : { languages: [request.languages[0], request.languages[1]] };
  const out = { lane: m.lane, key: m.key, request: { targetLanguage: request.targetLanguage, model: request.model, ...pair },
    voiceGender: m.voiceGender, muted: m.muted, captions: m.captions, style: pickStyle(m.style) };
  if (m.lane === 'tab') {
    const { tab } = m;
    if (!isPlainObject(tab) || !int(tab.tabId) || !text(tab.streamId, 1, LIMITS.streamIdMaxChars)
      || !int(tab.originalVolume, ORIGINAL_VOLUME.min, ORIGINAL_VOLUME.max)) return null;
    out.tab = { tabId: tab.tabId, streamId: tab.streamId, originalVolume: tab.originalVolume };
  } else if (m.tab !== undefined) return null;   // `tab` is present iff lane === 'tab'
  return out;
}

function hostSettingsOfMessage(m) {
  const s = m.settings;
  if (!isPlainObject(s) || typeof s.speechMuted !== 'boolean' || !int(s.tabOriginalVolume, ORIGINAL_VOLUME.min, ORIGINAL_VOLUME.max)
    || !isPlainObject(s.captions) || typeof s.captions.tab !== 'boolean' || typeof s.captions.mic !== 'boolean'
    || !isValidStyle(s.style)) return null;
  return { settings: { speechMuted: s.speechMuted, tabOriginalVolume: s.tabOriginalVolume,
    captions: { tab: s.captions.tab, mic: s.captions.mic }, style: pickStyle(s.style) } };
}

// Each returns the sanitized payload fields (extra fields dropped) or null.
const PAYLOADS = {
  'sw/lane-start': (m) => {
    if (!isLane(m.lane)) return null;
    if (m.lane === 'mic') return { lane: 'mic' };     // tabId is ignored for the microphone
    return int(m.tabId) ? { lane: 'tab', tabId: m.tabId } : null;
  },
  'sw/lane-stop': (m) => (m.lane === undefined ? {} : isLane(m.lane) ? { lane: m.lane } : null),
  'sw/permission-open': () => ({}),
  'sw/host-probe': () => ({}),
  'sw/host-idle': (m) => (matches(HOST_ID_PATTERN, m.hostId) && ['panel-gone', 'initial-grace'].includes(m.reason)
    ? { hostId: m.hostId, reason: m.reason } : null),
  'host/ping': () => ({}),
  'host/lane-start': laneStartOf,
  'host/lane-stop': (m) => (m.lane === undefined ? {} : isLane(m.lane) ? { lane: m.lane } : null),
  'host/settings': hostSettingsOfMessage,
  'host/overlay-wanted': (m) => (int(m.tabId) && typeof m.active === 'boolean' ? { tabId: m.tabId, active: m.active } : null),
  'host/overlay-result': (m) => (int(m.tabId) && typeof m.ok === 'boolean' && laneList(m.lanes)
    ? { tabId: m.tabId, ok: m.ok, lanes: [...m.lanes] } : null),
  'host/tab-removed': (m) => (int(m.tabId) ? { tabId: m.tabId } : null),
  'content/overlay-attach': () => ({}),
};

const INVALID_MESSAGE = Object.freeze({ ok: false, code: 'INVALID_MESSAGE' });

/**
 * Envelope + payload check (4.1, 4.2). Returns Readonly<{ ok: true, message }> where `message` is a frozen
 * sanitized copy (unknown fields dropped, so they can never be forwarded), or the frozen
 * { ok: false, code: 'INVALID_MESSAGE' }. Never throws, never echoes the input.
 */
export function validateMessage(message) {
  const checked = attempt(() => {
    if (!isPlainObject(message) || message.v !== PROTOCOL_VERSION) return null;
    const entry = own(MESSAGE_CATALOG, message.type);
    if (!entry || message.target !== entry.target) return null;
    const payload = PAYLOADS[message.type](message);
    return payload === null ? null : { v: PROTOCOL_VERSION, target: entry.target, type: message.type, ...payload };
  });
  return checked ? Object.freeze({ ok: true, message: deepFreeze(checked) }) : INVALID_MESSAGE;
}

/**
 * The envelope for `type` around `payload` (target and version come from the catalog and cannot be
 * overridden). Throws Error{code:'INVALID_MESSAGE'} for an unknown type or a payload the receiver would refuse:
 * a programming error caught at the sender instead of as a silent INVALID_MESSAGE response. The error never
 * contains the payload.
 */
export function makeMessage(type, payload = {}) {
  const entry = own(MESSAGE_CATALOG, type);
  if (!entry) throw codedError('INVALID_MESSAGE');
  const checked = validateMessage({ ...(isPlainObject(payload) ? payload : {}), v: PROTOCOL_VERSION, target: entry.target, type });
  if (!checked.ok) throw codedError('INVALID_MESSAGE');
  return checked.message;
}

// ---------------------------------------------------------------------------------------------
// 4.4 sender classification.
const PAGE_ROLES = Object.freeze([['extension/background/', 'sw'], ['extension/panel/', 'panel'],
  ['extension/engine/', 'offscreen'], ['extension/options/', 'options'], ['extension/permission/', 'permission']]);

// scheme://host, or null. Deliberately not URL.origin: a runtime that follows the URL standard reports the
// origin of a non-special scheme (the extension's own) as the string 'null', which would make every
// extension page "equal" and every unparsable origin look like one.
function originOf(value) {
  const parsed = typeof value === 'string' ? attempt(() => new URL(value)) : undefined;
  return parsed && parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
}

function roleOfUrl(url) {
  const path = attempt(() => new URL(url).pathname.replace(/^\/+/, ''));
  return PAGE_ROLES.find(([prefix]) => typeof path === 'string' && path.startsWith(prefix))?.[1] ?? 'foreign';
}

/**
 * 'sw' | 'panel' | 'offscreen' | 'options' | 'permission' | 'content' | 'foreign' (SENDER_ROLES). The check order is
 * the table of 4.4: extension id, then ORIGIN (an options/permission page has `sender.tab` too), then the
 * narrow url-less service-worker rule (a content script always has `sender.tab`, so it can never be 'sw').
 * Never throws; anything unreadable is 'foreign'.
 */
export function senderRole(sender, runtime) {
  return attempt(() => {
    if (sender === null || typeof sender !== 'object' || typeof runtime?.id !== 'string' || sender.id !== runtime.id) return 'foreign';
    const extensionOrigin = originOf(runtime.getURL?.(''));
    const origin = originOf(sender.origin) ?? originOf(sender.url);
    const bare = sender.tab === undefined && sender.documentId === undefined && sender.frameId === undefined;
    if (origin !== null && origin === extensionOrigin) {
      if (typeof sender.url === 'string') return roleOfUrl(sender.url);
      return bare ? 'sw' : 'foreign';   // A23: an MV3 service worker's sender may carry no url
    }
    if (origin === null && bare) return 'sw';
    if (sender.tab !== undefined) return 'content';
    return 'foreign';
  }) ?? 'foreign';
}

// ---------------------------------------------------------------------------------------------
// 4.3 router.
const success = (result) => {
  const data = isPlainObject(result) ? { ...result } : {};
  delete data.ok; delete data.code;   // a handler cannot override the verdict
  return { ...data, ok: true };
};
const failure = (error) => {
  const code = attempt(() => error?.code);
  return { ok: false, code: isMachineCode(code) ? code : 'INTERNAL' };   // the exception text is discarded
};

/**
 * runtime.onMessage listener with the six steps of 4.3. `handlers[type](message, sender, role)` returns the response
 * WITHOUT `ok`; `message` is the sanitized copy from validateMessage. `roleOf` exists for tests. Returns
 * Readonly<{ dispose }>.
 */
export function createMessageRouter({ runtime, target, handlers = {}, roleOf = senderRole } = {}) {
  if (!TARGETS.includes(target) || typeof runtime?.onMessage?.addListener !== 'function') throw codedError('INVALID_REQUEST');
  const listener = (message, sender, sendResponse) => {
    // 1. Other contexts stay silent so the first sendResponse is the right one.
    if (!isPlainObject(message) || message.v !== PROTOCOL_VERSION || message.target !== target) return false;
    const reply = (body) => attempt(() => sendResponse(body));
    const checked = validateMessage(message);                                       // 2
    if (!checked.ok) { reply({ ok: false, code: 'INVALID_MESSAGE' }); return false; }
    const { type } = checked.message;
    const role = attempt(() => roleOf(sender, runtime)) ?? 'foreign';                // 3
    if (!MESSAGE_CATALOG[type].roles.includes(role)) { reply({ ok: false, code: 'FORBIDDEN' }); return false; }
    const handler = own(handlers, type);                                             // 4
    if (typeof handler !== 'function') { reply({ ok: false, code: 'UNKNOWN_TYPE' }); return false; }
    (async () => handler(checked.message, sender, role))()                           // 5
      .then((result) => reply(success(result)), (error) => reply(failure(error)));
    return true;                                                                     // asynchronous response
  };
  runtime.onMessage.addListener(listener);
  return Object.freeze({ dispose() { attempt(() => runtime.onMessage.removeListener(listener)); } });
}

// ---------------------------------------------------------------------------------------------
// 4.5 frames (data plane). One validator for every direction; it returns a sanitized frozen copy.
export const FRAME_TYPES = deepFreeze({
  'panel->host': ['hello'],
  'host->panel': ['state', 'captions', 'bye'],
  'overlay->host': ['hello'],
  'host->overlay': ['style', 'captions', 'clear', 'status', 'bye'],
});
export const FRAME_DIRECTIONS = Object.freeze(Object.keys(FRAME_TYPES));

const nullable = (value, list) => value === null || list.includes(value);
const bounded = (value) => value === null || text(value, 1, MODEL_MAX_CHARS);

/** LaneState (4.6.1): exactly these fields with exactly these ranges, or null. */
export function validateLaneState(value, lane) {
  if (!isPlainObject(value) || value.lane !== lane || !isLane(lane)) return null;
  const ok = LANE_PHASES.includes(value.phase) && nullable(value.engineStatus, ENGINE_STATUSES)
    && int(value.retries, 0, 3) && nullable(value.reconnectReason, RECONNECT_REASONS)
    && (value.reconnectReason === null || value.phase === 'reconnecting')
    && nullable(value.output, OUTPUT_STATES) && bounded(value.model)
    && nullable(value.route, ROUTES) && typeof value.fallback === 'boolean' && nullable(value.targetLanguage, TARGET_LANGUAGES)
    && (value.errorCode === null || isMachineCode(value.errorCode)) && typeof value.quota === 'boolean'
    && typeof value.keyFailure === 'boolean' && int(value.level, 0, 100) && (value.tabId === null || int(value.tabId))
    && typeof value.captions === 'boolean' && OVERLAY_STATES.includes(value.overlay) && nullable(value.gap, GAP_KINDS)
    && int(value.epoch);
  if (!ok) return null;
  return deepFreeze({ lane, phase: value.phase, engineStatus: value.engineStatus, retries: value.retries,
    reconnectReason: value.reconnectReason, output: value.output, model: value.model, route: value.route, fallback: value.fallback,
    targetLanguage: value.targetLanguage, errorCode: value.errorCode, quota: value.quota, keyFailure: value.keyFailure,
    level: value.level, tabId: value.tabId, captions: value.captions, overlay: value.overlay, gap: value.gap,
    epoch: value.epoch });
}

/** UiState (4.6.1) or null. */
export function validateUiState(value) {
  if (!isPlainObject(value) || value.v !== PROTOCOL_VERSION || !int(value.seq, 1) || !matches(HOST_ID_PATTERN, value.hostId)
    || typeof value.speechMuted !== 'boolean' || !int(value.concurrent, 0, LANES.length) || !isPlainObject(value.lanes)) return null;
  const tab = validateLaneState(value.lanes.tab, 'tab');
  const mic = validateLaneState(value.lanes.mic, 'mic');
  if (!tab || !mic) return null;
  return deepFreeze({ v: PROTOCOL_VERSION, seq: value.seq, hostId: value.hostId, speechMuted: value.speechMuted,
    concurrent: value.concurrent, lanes: { tab, mic } });
}

// `lang` is optional and only a two-way lane sends it: that lane's rows come out in either language of its pair, so
// the language of each row travels with the row (the frame's own `lang` stays the language of the newest one).
function captionRowOf(row) {
  if (!isPlainObject(row) || !text(row.id, 1, 64) || !CAPTION_ROLES.includes(row.role)
    || !CAPTION_STATUSES.includes(row.status) || !text(row.text, 1, LIMITS.maxRowChars)
    || typeof row.skipped !== 'boolean' || (row.lang !== undefined && !TARGET_LANGUAGES.includes(row.lang))) return null;
  return { id: row.id, role: row.role, status: row.status, text: row.text, skipped: row.skipped,
    ...(row.lang === undefined ? {} : { lang: row.lang }) };
}

// Each returns the sanitized payload fields or null.
const FRAMES = {
  hello: () => ({}),
  bye: () => ({}),
  state: (f) => {
    const state = validateUiState(f.state);
    return state ? { state } : null;
  },
  captions: (f) => {
    if (!int(f.epoch) || !int(f.seq) || !isLane(f.lane) || !TARGET_LANGUAGES.includes(f.lang) || typeof f.live !== 'boolean'
      || !Array.isArray(f.rows) || f.rows.length > LIMITS.maxRows || !isPlainObject(f.gaps)
      || GAP_KINDS.some((kind) => typeof f.gaps[kind] !== 'boolean')) return null;
    const rows = f.rows.map(captionRowOf);
    if (rows.includes(null)) return null;
    return { epoch: f.epoch, seq: f.seq, lane: f.lane, lang: f.lang, rows,
      gaps: { input: f.gaps.input, audio: f.gaps.audio, reception: f.gaps.reception }, live: f.live };
  },
  style: (f) => (isValidStyle(f.style, { showSource: false })
    ? { style: { size: f.style.size, position: f.style.position, display: f.style.display,
      maxLines: f.style.maxLines, autoHideSeconds: f.style.autoHideSeconds } } : null),
  clear: (f) => (isLane(f.lane) ? { lane: f.lane } : null),
  status: (f) => (isLane(f.lane) && STATUS_PHASES.includes(f.phase) ? { lane: f.lane, phase: f.phase } : null),
};

const INVALID_FRAME = Object.freeze({ ok: false });

/**
 * Validates one frame received on a port (4.4: an invalid frame is dropped silently, so the failure carries no
 * code). `direction` is one of FRAME_DIRECTIONS. Returns Readonly<{ ok: true, frame }> with a frozen sanitized copy
 * (unknown fields dropped) or the frozen { ok: false }. The size cap is LIMITS.maxFrameBytes of the JSON text.
 */
export function validateFrame(direction, frame) {
  const checked = attempt(() => {
    const allowed = own(FRAME_TYPES, direction);
    if (!allowed || !isPlainObject(frame) || frame.v !== PROTOCOL_VERSION || !allowed.includes(frame.type)) return null;
    if (JSON.stringify(frame).length > LIMITS.maxFrameBytes) return null;
    const payload = FRAMES[frame.type](frame);
    return payload === null ? null : { v: PROTOCOL_VERSION, type: frame.type, ...payload };
  });
  return checked ? Object.freeze({ ok: true, frame: deepFreeze(checked) }) : INVALID_FRAME;
}

/**
 * A frozen frame of `type` (version added, shape checked against every direction that carries the type). Throws
 * Error{code:'INVALID_MESSAGE'} for a frame no receiver would accept, so a host bug surfaces at the sender.
 */
export function makeFrame(type, payload = {}) {
  const frame = { ...(isPlainObject(payload) ? payload : {}), v: PROTOCOL_VERSION, type };
  for (const direction of FRAME_DIRECTIONS) {
    if (!FRAME_TYPES[direction].includes(type)) continue;
    const checked = validateFrame(direction, frame);
    if (checked.ok) return checked.frame;
  }
  throw codedError('INVALID_MESSAGE');
}
