// New implementation of design-p2 §§7.3, 8.6, 10 and 17; no legacy code is ported.
// Direct input uses the existing P2-02 SegmentAssembler event contract.
import { ProviderError } from '../providers/contract.js';

export const MAX_CAPTIONS = 100;
export const GAP_CAUSES = Object.freeze(['input', 'audio', 'reception']);
const invalid = () => { throw new ProviderError('INVALID_REQUEST'); };
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const string = (v, max = 1024) => typeof v === 'string' && v.length > 0 && v.length <= max;
const time = (v) => Number.isFinite(v) && v >= 0;
const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const item of Object.values(v)) freeze(item);
    Object.freeze(v);
  }
  return v;
};

/** Memory-only snapshots. upsertDirect accepts assembler events; upsertHub
 * accepts validated {epoch, lang, segmentId, seq, text, final, revision} snapshots.
 * newFinal is a one-time eligibility signal, NOT permission to speak: callers
 * must also gate target language, mute, replay and reconnect uncertainty.
 * Hub input must preserve server order before language filtering. Numeric seq
 * gaps never imply missing captions. Retained IDs accept corrections; lane
 * watermarks suppress evicted replay without an unbounded tombstone collection.
 * One active partial per role/language; replaced tails become interrupted.
 */
export function createCaptionStore({ sessionId, generation = 0, epoch = 0,
  now = () => performance.now() } = {}) {
  if (!string(sessionId, 256) || !integer(generation) || !integer(epoch) || typeof now !== 'function') invalid();
  let rows = [], order = 0, closed = false;
  let watermarks = new Map();
  let gaps = { input: false, audio: false, reception: false };
  let stats = { revisions: 0, duplicates: 0, interrupted: 0, firstPartialAt: null, firstFinalAt: null };
  let snapshot;
  const listeners = new Set();
  const open = () => { if (closed) throw new ProviderError('SESSION_CLOSED'); };
  const clock = () => { const value = now(); if (!time(value)) invalid(); return value; };
  function publish() {
    snapshot = freeze({ sessionId, generation, epoch, captions: [...rows], gaps: { ...gaps }, metrics: { ...stats } });
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* Consumer-owned failure. */ }
    }
  }
  function trim() {
    let excess = rows.filter((r) => r.status !== 'partial').length - MAX_CAPTIONS;
    rows = rows.filter((r) => r.status === 'partial' || excess-- <= 0);
  }
  function ignore() {
    stats.duplicates++;
    publish();
    return Object.freeze({ applied: false, newFinal: false });
  }
  function upsert(record, lane, cursor) {
    const old = rows.find((r) => r.id === record.id);
    if (old ? record.revision <= old.revision : cursor <= (watermarks.get(lane) ?? -1)) return ignore();
    if (old && (old.sequence !== record.sequence || old.role !== record.role)) invalid();
    const at = clock();
    const status = old && old.status !== 'partial' ? old.status : record.status;
    const newFinal = status === 'final' && (!old || old.status === 'partial');
    const next = freeze({ ...record, status, order: old?.order ?? ++order,
      receivedAt: old?.receivedAt ?? record.receivedAt ?? at,
      finalizedAt: old?.finalizedAt ?? (status === 'partial' ? null : record.finalizedAt ?? at),
      gapBefore: Boolean(old?.gapBefore || record.gapBefore), lane });
    if (old) {
      stats.revisions++;
      rows = rows.map((r) => r === old ? next : r);
    } else {
      rows = rows.map((r) => {
        if (r.lane !== lane || r.status !== 'partial') return r;
        stats.interrupted++;
        return freeze({ ...r, status: 'interrupted', finalizedAt: at });
      });
      rows.push(next);
    }
    watermarks.set(lane, Math.max(cursor, watermarks.get(lane) ?? -1));
    if (status === 'partial' && stats.firstPartialAt === null) stats.firstPartialAt = at;
    if (newFinal && stats.firstFinalAt === null) stats.firstFinalAt = at;
    if (status === 'interrupted' && old?.status !== 'interrupted') stats.interrupted++;
    trim(); publish();
    return Object.freeze({ applied: true, newFinal, caption: next });
  }
  function interrupt() {
    const at = clock();
    rows = rows.map((r) => {
      if (r.status !== 'partial') return r;
      stats.interrupted++;
      return freeze({ ...r, status: 'interrupted', finalizedAt: at });
    });
    trim();
  }
  publish();
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener) {
      open(); if (typeof listener !== 'function') invalid();
      listeners.add(listener); return () => listeners.delete(listener);
    },
    upsertDirect(s) {
      open();
      if (!s || s.sessionId !== sessionId || s.generation !== generation) return Object.freeze({ applied: false, newFinal: false });
      const field = s.role === 'source' ? 'sourceText' : 'translatedText';
      if (!string(s.id) || !['source', 'translation'].includes(s.role) || !integer(s.sequence)
        || !integer(s.revision) || !['partial', 'final', 'interrupted'].includes(s.status)
        || typeof s[field] !== 'string' || s[field].length > 16000
        || !time(s.receivedAt) || (s.status === 'partial' ? s.finalizedAt !== null : !time(s.finalizedAt))) invalid();
      let processing;
      if (s.processing !== undefined) {
        const live = s.processing?.live;
        if (!live || typeof live.providerId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(live.providerId)
          || typeof live.model !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(live.model)) invalid();
        processing = { live: { providerId: live.providerId, model: live.model } };
      }
      return upsert({ id: JSON.stringify(['direct', sessionId, generation, s.role, s.id]),
        segmentId: s.id, sessionId, generation, role: s.role, sequence: s.sequence, revision: s.revision,
        [field]: s[field], status: s.status, gapBefore: s.gapBefore === true,
        receivedAt: s.receivedAt, finalizedAt: s.finalizedAt,
        ...(processing ? { processing } : {}) }, `direct:${s.role}`, s.sequence);
    },
    upsertHub(s) {
      open();
      if (!s || s.epoch !== epoch) return Object.freeze({ applied: false, newFinal: false });
      if (!['src', 'ko', 'en', 'ja'].includes(s.lang) || !string(s.segmentId, 256)
        || !integer(s.seq) || !integer(s.revision) || typeof s.final !== 'boolean'
        || typeof s.text !== 'string' || s.text.length > 16000) invalid();
      const id = JSON.stringify(['hub', epoch, s.lang, s.segmentId]);
      const old = rows.find((r) => r.id === id);
      return upsert({ id, segmentId: s.segmentId, sessionId, epoch, lang: s.lang,
        role: s.lang === 'src' ? 'source' : 'translation',
        sequence: old?.sequence ?? order + 1, remoteSeq: s.seq, revision: s.revision,
        [s.lang === 'src' ? 'sourceText' : 'translatedText']: s.text,
        status: s.final ? 'final' : 'partial', gapBefore: false }, `hub:${s.lang}`, s.seq);
    },
    markGap(cause) {
      open(); if (!GAP_CAUSES.includes(cause)) invalid();
      gaps = { ...gaps, [cause]: true }; publish();
    },
    interrupt() { open(); interrupt(); publish(); },
    setGeneration(next) {
      open(); if (!integer(next) || next <= generation) invalid();
      interrupt(); generation = next;
      watermarks.delete('direct:source'); watermarks.delete('direct:translation'); publish();
    },
    // Reconnect keeps the epoch. Explicit rejoin/new broadcast resets it.
    resetEpoch(next) {
      open(); if (!integer(next) || next <= epoch) invalid();
      epoch = next; rows = []; order = 0; watermarks.clear();
      gaps = { input: false, audio: false, reception: false };
      stats = { revisions: 0, duplicates: 0, interrupted: 0, firstPartialAt: null, firstFinalAt: null };
      publish();
    },
    close() {
      if (closed) return;
      closed = true; rows = []; watermarks.clear(); publish(); listeners.clear();
    },
  });
}
