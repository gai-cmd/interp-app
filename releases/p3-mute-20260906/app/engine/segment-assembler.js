/**
 * Ported from: ~/jarvis2/interp-web/lib/live.js
 * Symbols: SegmentAssembler
 * Ported on: 2026-09-05
 * Source SHA-256: 8afc7818740a45bb69e349450f4290b9574adcd24cb8ee294060ec08056febfe
 * Changes: ES module, explicit delta/snapshot, role-local IDs, Unicode boundaries,
 * interruption, monotonic injectable clock, bounded revisions and timer cleanup.
 */
import { ProviderError } from '../providers/contract.js';

const invalid = () => { throw new ProviderError('INVALID_REQUEST'); };
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const units = (text) => Array.from(graphemes.segment(text), ({ segment }) => segment);
const clockDefault = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

// A trailing period needs lookahead: the next packet may start with a digit.
function sentenceEnd(text) {
  const match = /[。！？!?…]+[。！？!?…"'”’」』）)]*|[.．]+["'”’」』）)]*/gu;
  for (const m of text.matchAll(match)) {
    const end = m.index + m[0].length;
    if (/^[.．]/u.test(m[0])) {
      if (end === text.length) continue;
      const before = text.slice(0, m.index + 1);
      if (/[0-9０-９]$/u.test(text.slice(0, m.index)) && /^[0-9０-９]/u.test(text.slice(end))) continue;
      if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Za-z]|\b(?:[A-Za-z]\.)+[A-Za-z])\.$/iu.test(before)) continue;
      if (/^[A-Za-z0-9]/u.test(text.slice(end))) continue;
    }
    return end;
  }
  return 0;
}

/** One instance per session/generation/role. Snapshot replaces the active tail.
 * push({ text, mode: 'delta'|'snapshot', finished? }); flush()/turnComplete();
 * interrupt() ends only the active segment; cancel() permanently closes this instance.
 * revise(id, { text, revision }) corrects a retained terminal segment, never reopens it.
 */
export class SegmentAssembler {
  #buffer = ''; #active = null; #sequence = 0; #timer = null; #token = 0;
  #closed = false; #history = new Map();
  constructor({ sessionId, generation, role, onSegment, silenceMs = 1500, maxChars = 140,
    clock = clockDefault, gapBefore = false } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
      !Number.isSafeInteger(generation) || generation < 0 ||
      !['source', 'translation'].includes(role) || typeof onSegment !== 'function' ||
      !Number.isFinite(silenceMs) || silenceMs <= 0 ||
      !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 10000 ||
      !['now', 'setTimeout', 'clearTimeout'].every((key) => typeof clock?.[key] === 'function')) invalid();
    this.sessionId = sessionId; this.generation = generation; this.role = role;
    this.onSegment = onSegment; this.silenceMs = silenceMs; this.maxChars = maxChars;
    this.clock = clock; this.gapBefore = gapBefore === true;
  }
  #clear() {
    ++this.#token;
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
  #emit(text, status) {
    if (!this.#active) {
      const sequence = ++this.#sequence;
      this.#active = { id: JSON.stringify([this.sessionId, this.generation, this.role, sequence]),
        sessionId: this.sessionId, generation: this.generation, role: this.role,
        sequence, revision: 0, gapBefore: this.gapBefore, receivedAt: this.clock.now() };
      this.gapBefore = false;
    }
    const segment = Object.freeze({ ...this.#active, revision: this.#active.revision + 1,
      [this.role === 'source' ? 'sourceText' : 'translatedText']: text, status,
      finalizedAt: status === 'partial' ? null : this.clock.now() });
    this.#active = status === 'partial' ? segment : null;
    if (status !== 'partial') {
      this.#history.set(segment.id, segment);
      if (this.#history.size > 100) this.#history.delete(this.#history.keys().next().value);
    }
    this.onSegment(segment);
  }
  push({ text = '', mode, finished = false } = {}) {
    if (this.#closed) return;
    if (typeof text !== 'string' || !['delta', 'snapshot'].includes(mode) || typeof finished !== 'boolean') invalid();
    this.#clear();
    this.#buffer = mode === 'delta' ? this.#buffer + text : text;
    while (this.#buffer && !this.#closed) {
      const boundary = sentenceEnd(this.#buffer);
      const parts = units(this.#buffer);
      // Keep the last grapheme open for combining marks or surrogate continuation.
      const limit = parts.length > this.maxChars ? parts.slice(0, this.maxChars).join('').length : 0;
      const end = boundary && limit ? Math.min(boundary, limit) : boundary || limit;
      if (!end) break;
      const sentence = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end);
      if (sentence) this.#emit(sentence, 'final');
    }
    if (this.#closed) return;
    if (finished) return this.flush();
    if (this.#buffer.trim() || this.#active) this.#emit(this.#buffer.trim(), 'partial');
    if (this.#closed || (!this.#buffer.trim() && !this.#active)) return;
    const token = this.#token;
    this.#timer = this.clock.setTimeout(() => {
      if (!this.#closed && token === this.#token) this.flush();
    }, this.silenceMs);
  }
  #finish(status) {
    this.#clear();
    const text = this.#buffer.trim();
    this.#buffer = '';
    if (text || this.#active) this.#emit(text, status);
  }
  flush() { if (!this.#closed) this.#finish('final'); }
  turnComplete() { this.flush(); }
  interrupt() { if (!this.#closed) this.#finish('interrupted'); }
  cancel() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#finish('interrupted'); } finally { this.#history.clear(); }
  }
  revise(id, { text, revision } = {}) {
    if (this.#closed) return false;
    if (typeof text !== 'string' || !Number.isSafeInteger(revision) || revision < 1 || units(text).length > this.maxChars) invalid();
    const old = this.#history.get(id);
    if (!old || revision <= old.revision) return false;
    const segment = Object.freeze({ ...old, revision,
      [this.role === 'source' ? 'sourceText' : 'translatedText']: text });
    this.#history.set(id, segment);
    this.onSegment(segment);
    return true;
  }
}
