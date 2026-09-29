// New implementation of docs/extension.md §4.6.3 and §4.7; no legacy code is ported.
// Builds the bounded caption and style frames the offscreen host sends over its ports, and the coalescer that
// keeps those ports from being flooded (the engine notifies on every audio chunk). Pure: timers and the clock are
// injected and no global is touched at import time. Provider text and captions only ever leave the host through
// these frames, so every text is capped and every frame is size-fitted before it can be sent.
import {
  CAPTION_ROLES, CAPTION_STATUSES, GAP_KINDS, TARGET_LANGUAGES, deepFreeze, isLanguagePair, isValidStyle,
} from './constants.js';
import { LANES, LIMITS, PROTOCOL_VERSION } from './protocol.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const codedError = (code) => Object.assign(new Error(code), { code });
const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const FIT_ROW_CHARS = 120;   // last resort of rule 8 when one row alone is still too large
const DEFAULT_ROWS = 4;      // the panel's row count

// Newest words are the ones being spoken, so a long text keeps its END. Never starts on half a surrogate pair.
function tail(value, max) {
  if (value.length <= max) return value;
  let start = value.length - (max - 1);
  const unit = value.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return `\u2026${value.slice(start)}`;
}

const frameSize = (frame) => JSON.stringify(frame).length;

// Letters per script. The `g` flag is only there for String.match, which resets it, so the shared patterns are safe.
const SCRIPTS = Object.freeze({ hangul: /\p{Script=Hangul}/gu, kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  han: /\p{Script=Han}/gu, latin: /\p{Script=Latin}/gu });
const lettersOf = (value, pattern) => (value.match(pattern) ?? []).length;

/**
 * The language a two-way caption row is written in, guessed from its script and always one of `pair`. The engine
 * gives no language per row (a two-way lane renders each utterance into the OTHER language of the pair), so the script
 * decides: Hangul or kana mark Korean or Japanese (the larger count wins a mixed row, so names and loanwords in Latin
 * letters never turn a Korean or Japanese line into English), Han letters alone mean Japanese, Latin letters mean
 * English. A guess that is not in the pair (Han alone in a Korean/English pair), or a row with no letter at all
 * (digits, punctuation), takes the lane's own language `target`, or the pair's first language when `target` is not in it.
 */
export function guessRowLanguage(value, pair, target) {
  const fallback = pair.includes(target) ? target : pair[0];
  if (typeof value !== 'string') return fallback;
  const hangul = lettersOf(value, SCRIPTS.hangul);
  const kana = lettersOf(value, SCRIPTS.kana);
  let guess = null;
  if (hangul > 0 || kana > 0) guess = hangul > kana ? 'ko' : 'ja';
  else if (lettersOf(value, SCRIPTS.han) > 0) guess = 'ja';
  else if (lettersOf(value, SCRIPTS.latin) > 0) guess = 'en';
  return pair.includes(guess) ? guess : fallback;
}

/**
 * CaptionFrame (4.6.3). `captions` is the engine snapshot's `captions` (the caption store snapshot, rows in
 * `captions.captions`) or null; `skippedSegments` is the snapshot's list of segment ids the reply detector dropped.
 * Rules, in the contract's numbering:
 *  1 null captions -> no rows, no gaps.   2 translation rows, plus source rows only with `showSource`.
 *  3 text is `sourceText` / `translatedText`; rows whose trimmed text is empty are dropped.
 *  4 all partials + the newest settled rows that fit `maxRows`, sorted by `order` (newest last).
 *  5 `id` = segmentId cut to 64, `text` cut to LIMITS.maxRowChars keeping the END, `skipped` for translation rows.
 *  6 `gaps` copied.   7 `maxRows` clamped to 1..LIMITS.maxRows (the panel uses 4, the overlay `style.maxLines`).
 *  8 the frame always fits LIMITS.maxFrameBytes: oldest rows go first, then row texts shrink to 120 characters.
 *  10 two-way (`languages` is a pair of two distinct languages): a row comes out in either language of the pair, so every
 *     row carries `lang` (guessRowLanguage) and the frame's own `lang` is the language of its newest row (the overlay
 *     draws one `lang` per lane). Without a pair (one-way, or an invalid pair) no row has `lang` and the frame's `lang`
 *     is the lane's language, exactly as before.
 * Returns a frozen frame. An unknown lane is a programming error and throws Error{code:'INVALID_REQUEST'}; an unknown
 * `lang` is emitted as 'en' (the lane always passes its validated target language, so this is unreachable in the host).
 */
export function buildCaptionFrame({ captions = null, skippedSegments = [], lane, lang, epoch = 0, seq = 0,
  showSource = false, maxRows = DEFAULT_ROWS, live = false, languages = null } = {}) {
  if (!LANES.includes(lane)) throw codedError('INVALID_REQUEST');
  const limit = Number.isFinite(maxRows) ? Math.min(LIMITS.maxRows, Math.max(1, Math.trunc(maxRows))) : DEFAULT_ROWS;
  const source = Array.isArray(captions?.captions) ? captions.captions : [];
  const skipped = new Set(Array.isArray(skippedSegments) ? skippedSegments : []);
  const wanted = showSource === true ? CAPTION_ROLES : ['translation'];
  const pair = isLanguagePair(languages) ? [languages[0], languages[1]] : null;

  const candidates = [];
  source.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || !wanted.includes(row.role) || !CAPTION_STATUSES.includes(row.status)) return;
    const value = row.role === 'source' ? row.sourceText : row.translatedText;
    if (typeof value !== 'string' || value.trim() === '') return;
    const segmentId = typeof row.segmentId === 'string' && row.segmentId !== '' ? row.segmentId : String(row.id ?? '');
    candidates.push({ order: Number.isFinite(row.order) ? row.order : index, status: row.status, role: row.role,
      segmentId, text: value });
  });
  const partials = candidates.filter((row) => row.status === 'partial');
  const settled = candidates.filter((row) => row.status !== 'partial').sort((a, b) => a.order - b.order);
  const kept = [...partials, ...settled.slice(Math.max(0, settled.length - Math.max(0, limit - partials.length)))]
    .sort((a, b) => a.order - b.order).slice(-limit);   // partials are at most one per role: the slice only bounds a pathological store

  let rows = kept.map((row) => {
    const shown = tail(row.text, LIMITS.maxRowChars);
    return {
      id: row.segmentId.slice(0, 64) || `r${row.order}`,
      role: row.role,
      status: row.status,
      text: shown,
      skipped: row.role === 'translation' && skipped.has(row.segmentId),
      ...(pair === null ? {} : { lang: guessRowLanguage(shown, pair, lang) }),   // the language of what is drawn (its newest words)
    };
  });
  const gaps = Object.fromEntries(GAP_KINDS.map((kind) => [kind, captions?.gaps?.[kind] === true]));
  const laneLang = TARGET_LANGUAGES.includes(lang) ? lang : 'en';
  const make = () => ({ v: PROTOCOL_VERSION, type: 'captions', epoch: counter(epoch), seq: counter(seq), lane,
    lang: rows.at(-1)?.lang ?? laneLang, rows, gaps, live: live === true });

  while (rows.length > 1 && frameSize(make()) > LIMITS.maxFrameBytes) rows = rows.slice(1);
  if (frameSize(make()) > LIMITS.maxFrameBytes) rows = rows.map((row) => ({ ...row, text: tail(row.text, FIT_ROW_CHARS) }));
  if (frameSize(make()) > LIMITS.maxFrameBytes) rows = [];   // unreachable with the constants above; the guarantee is unconditional
  return deepFreeze(make());
}

/**
 * The overlay's `style` frame (4.5): the style of settings without `showSource`, which the host applies itself while
 * building rows. Throws Error{code:'INVALID_REQUEST'} for a style that fails isValidStyle (the SW and settings.js only
 * ever produce valid ones).
 */
export function buildStyleFrame(style) {
  if (!isValidStyle(style, { showSource: false })) throw codedError('INVALID_REQUEST');
  const { size, position, display, maxLines, autoHideSeconds } = style;
  return deepFreeze({ v: PROTOCOL_VERSION, type: 'style', style: { size, position, display, maxLines, autoHideSeconds } });
}

// A frame compared without its `seq`: the host renumbers every emission, which must not defeat the dedupe.
function fingerprint(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return JSON.stringify(frame);
  const rest = { ...frame };
  delete rest.seq;
  return JSON.stringify(rest);
}

/**
 * Per-key coalescing (4.7). `push(key, frame)` keeps ONE pending frame per key; the first push after a quiet
 * `intervalMs` is sent at once (leading edge), later ones wait for a single trailing send at lastSend + intervalMs, so a
 * key never sends more than once per interval. A frame whose JSON (minus `seq`) equals the last SENT one is skipped.
 * `send(key, frame)` is the caller's callback (the host assigns `seq` there, so this stays pure). `flush()` sends
 * everything pending now, ignoring the interval (before `bye`, `clear`, lane end); `dispose()` cancels the timers and
 * drops pending frames for good. A throwing `send` never breaks the coalescer.
 */
export function createFrameCoalescer({ now = () => globalThis.performance.now(), setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout, intervalMs = LIMITS.frameIntervalMs, send } = {}) {
  if (typeof send !== 'function' || typeof now !== 'function' || typeof setTimeout !== 'function'
    || typeof clearTimeout !== 'function') throw codedError('INVALID_REQUEST');
  const slots = new Map();
  let disposed = false;

  function transmit(key, slot) {
    if (slot.timer !== null) { attempt(() => clearTimeout(slot.timer)); slot.timer = null; }
    if (!slot.has) return;
    const { frame } = slot;
    slot.has = false; slot.frame = undefined;
    const print = attempt(() => fingerprint(frame));
    if (print === undefined || print === slot.last) return;   // unserializable, or nothing new to say
    slot.last = print;
    slot.sentAt = now();
    attempt(() => send(key, frame));
  }

  return Object.freeze({
    push(key, frame) {
      if (disposed || frame === undefined) return;
      let slot = slots.get(key);
      if (!slot) { slot = { has: false, frame: undefined, last: undefined, sentAt: -Infinity, timer: null }; slots.set(key, slot); }
      slot.has = true; slot.frame = frame;
      if (slot.timer !== null) return;                        // the trailing send will carry the newest frame
      const wait = slot.sentAt + intervalMs - now();
      if (wait <= 0) transmit(key, slot);
      else slot.timer = setTimeout(() => { slot.timer = null; if (!disposed) transmit(key, slot); }, wait);
    },
    flush() {
      if (disposed) return;
      for (const [key, slot] of [...slots]) transmit(key, slot);
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) {
        if (slot.timer !== null) attempt(() => clearTimeout(slot.timer));
        slot.timer = null; slot.has = false; slot.frame = undefined;
      }
      slots.clear();
    },
  });
}
