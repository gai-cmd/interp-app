// New offline harness for design-p2 §17; no legacy implementation is ported.
// Exercise existing P2 client/store/speaker contracts without opening a network socket.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHubClient, HUB_CLIENT_LIMITS } from '../app/hub/client.js';
import { createCaptionStore, MAX_CAPTIONS } from '../app/engine/caption-store.js';
import { createCaptionSpeaker } from '../app/audio/caption-speaker.js';

const fail = () => { throw new Error('P2_LOAD_INVALID_ARGUMENTS'); };
export function parseArgs(args) {
  const keys = new Map([['--mode', 'mode'], ['--listeners', 'listeners'],
    ['--languages', 'languages'], ['--duration-seconds', 'durationSeconds']]);
  const values = { mode: 'mock' }, seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = keys.get(args[i]), value = args[i + 1];
    if (!key || seen.has(key) || typeof value !== 'string') fail();
    seen.add(key);
    if (key === 'mode') { if (value !== 'mock') fail(); values.mode = value; }
    else {
      if (!/^[1-9][0-9]*$/.test(value)) fail();
      values[key] = Number(value);
    }
  }
  validate(values);
  return Object.freeze(values);
}
function validate(v) {
  if (!v || v.mode !== 'mock' || ![v.listeners, v.languages, v.durationSeconds]
    .every(n => Number.isSafeInteger(n) && n > 0) || v.languages > 3
    || !Number.isSafeInteger(v.listeners * v.languages * v.durationSeconds * 8)
    || !Number.isSafeInteger(v.durationSeconds * 1000)) fail();
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time, random: () => 0,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout(key) { timers.delete(key); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let next;
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].fn();
      }
      time = end;
    },
    size: () => timers.size,
  };
}

export async function runMock(options) {
  validate(options);
  const { listeners: N, languages: L, durationSeconds: T } = options;
  const timing = clock(), langs = ['ko', 'en', 'ja'].slice(0, L);
  const people = [], recent = [];
  const metrics = { partials: 0, finals: 0, corrections: 0, replayDeliveries: 0,
    duplicateInputs: 0, duplicatesSuppressed: 0, duplicateSpeech: 0, replaySpeech: 0,
    appliedFinals: 0, maxConcurrentSpeechPerListener: 0,
    orderErrors: 0, overflows: 0, reconnects: 0, speechRequests: 0, skippedSpeech: 0,
    maxReceiveMessages: 0, maxReceiveBytes: 0, maxTtsWaiting: 0, maxCaptionRows: 0,
    maxTrackedRecords: 0, identityEntriesDerived: 0, finalTrackedRecords: 0 };
  const check = condition => { if (!condition) throw new Error('P2_LOAD_INVARIANT_FAILED'); };
  const trackedRecordBound = 30 + N * (MAX_CAPTIONS + L + HUB_CLIENT_LIMITS.queueMessages + 21 + 4 * T);
  const heapBefore = process.memoryUsage().heapUsed;
  let seq = 0;
  const hello = JSON.stringify({ type: 'hello', sessionId: 'mock', settings: { allowedLangs: langs } });
  function inspect() {
    let records = recent.length;
    for (const p of people) {
      const c = p.op.snapshot(), s = p.speaker.snapshot(), rows = p.store.snapshot().captions;
      metrics.maxReceiveMessages = Math.max(metrics.maxReceiveMessages, c.maxMessages);
      metrics.maxReceiveBytes = Math.max(metrics.maxReceiveBytes, c.maxBytes);
      metrics.maxTtsWaiting = Math.max(metrics.maxTtsWaiting, s.maxWaiting);
      metrics.maxCaptionRows = Math.max(metrics.maxCaptionRows, rows.length);
      check(c.maxMessages <= HUB_CLIENT_LIMITS.queueMessages && c.maxBytes <= HUB_CLIENT_LIMITS.queueBytes);
      check(s.waiting <= 20 && rows.filter(r => r.status !== 'partial').length <= MAX_CAPTIONS);
      check(rows.filter(r => r.status === 'partial').length <= L);
      check(new Set(rows.map(r => r.id)).size === rows.length);
      // Count observable records and derived speaker identity entries, not all JS objects.
      records += rows.length + c.pendingMessages + s.waiting + Number(s.speaking) + p.identities;
    }
    check(records <= trackedRecordBound);
    metrics.maxTrackedRecords = Math.max(metrics.maxTrackedRecords, records);
  }
  try {
    for (let i = 0; i < N; i++) {
      const p = { language: langs[i % L], slow: i % 2 === 0, socket: null,
        replay: false, lastSeq: 0, identities: 0, lastSpoken: -1, connected: 0, activeSpeech: 0 };
      class MockSocket extends EventTarget {
        readyState = 1;
        constructor() { super(); p.socket = this; p.connected++; }
        message(data) { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data })); }
        close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
      }
      const deviceTTS = {
        speak({ text }, { signal }) {
          metrics.speechRequests++;
          p.activeSpeech++;
          metrics.maxConcurrentSpeechPerListener = Math.max(metrics.maxConcurrentSpeechPerListener, p.activeSpeech);
          const id = Number(text.split(':')[1]);
          if (id <= p.lastSpoken) metrics.duplicateSpeech++;
          if (p.replay) metrics.replaySpeech++;
          p.lastSpoken = id;
          return new Promise(done => {
            let ended = false;
            const finish = status => {
              if (ended) return;
              ended = true; p.activeSpeech--; timing.clearTimeout(timer);
              signal.removeEventListener('abort', abort); done({ status });
            };
            const abort = () => finish('cancelled');
            const timer = timing.setTimeout(() => finish('completed'), p.slow ? 5000 : 50);
            signal.addEventListener('abort', abort, { once: true });
          });
        }, cancel() {},
      };
      p.store = createCaptionStore({ sessionId: `mock-${i}`, now: timing.now });
      p.speaker = createCaptionSpeaker({ deviceTTS, language: p.language, muted: false, ...timing });
      const client = createHubClient({ hubs: [{ id: 'mock', url: 'wss://mock.invalid/ws' }], WebSocket: MockSocket, ...timing });
      p.op = client.join({ hubId: 'mock', roomCode: 'Mock' }, { onEvent(e) {
        if (e.type === 'gap' && e.reason === 'receive-overflow') metrics.overflows++;
        if (e.type !== 'caption') return;
        if (!p.replay && e.seq < p.lastSeq) metrics.orderErrors++;
        if (!p.replay) p.lastSeq = e.seq;
        const update = p.store.upsertHub({ ...e, epoch: 0 });
        if (!update.applied) metrics.duplicatesSuppressed++;
        if (update.newFinal) metrics.appliedFinals++;
        if (update.newFinal && e.lang === p.language) p.identities++;
        p.speaker.enqueue(update, { replay: p.replay });
      } });
      people.push(p);
    }
    await flush();
    for (const p of people) p.socket.message(hello);
    await Promise.all(people.map(p => p.op.ready));
    const broadcast = event => {
      const raw = JSON.stringify(event);
      for (const p of people) p.socket.message(raw);
      inspect();
    };
    // Four synthetic segments per language per virtual second, not an operating target.
    for (let second = 0; second < T; second++) {
      for (let part = 0; part < 4; part++) {
        const id = second * 4 + part;
        for (const lang of langs) {
          const base = { type: 'cast.caption', lang, segmentId: `s${id}`, text: `mock:${id}` };
          broadcast({ ...base, seq: ++seq, revision: 0, final: false }); metrics.partials++;
          const final = { ...base, seq: ++seq, revision: 1, final: true };
          broadcast(final); metrics.finals++;
          broadcast(final); metrics.duplicateInputs += N;
          const correction = { ...final, seq: ++seq, revision: 2 };
          broadcast(correction); metrics.corrections++;
          recent.push(correction); if (recent.length > 30) recent.shift();
        }
        timing.advance(250); await flush();
      }
    }
    // Hold Blob decoding while filling real receive queues. Alternate count/byte limits.
    const gates = [];
    for (const [i, p] of people.entries()) {
      p.speaker.setMuted(true);
      if (!p.slow) { p.socket.close(); continue; }
      const raw = i % 4 === 0 ? '{}' : ' '.repeat(HUB_CLIENT_LIMITS.messageBytes);
      let release;
      const gate = new Promise(done => { release = done; });
      class HeldBlob extends Blob { async arrayBuffer() { await gate; return super.arrayBuffer(); } }
      gates.push(release);
      p.socket.message(new HeldBlob([raw]));
      const count = i % 4 === 0 ? HUB_CLIENT_LIMITS.queueMessages : 2;
      for (let j = 0; j < count; j++) { p.socket.message(raw); inspect(); }
    }
    await flush();
    timing.advance(1000); await flush();
    for (const release of gates) release();
    await flush();
    for (const p of people) {
      check(p.connected === 2 && p.op.snapshot().pendingMessages === 0);
      metrics.reconnects++;
      p.replay = true; p.socket.message(hello);
      p.store.markGap('reception');
      for (const event of recent) { p.socket.message(JSON.stringify(event)); metrics.replayDeliveries++; }
      p.replay = false;
      check(p.op.snapshot().state === 'running');
      metrics.skippedSpeech += p.speaker.snapshot().skipped;
      metrics.identityEntriesDerived += p.identities;
    }
    inspect();
    check(metrics.duplicateSpeech === 0 && metrics.replaySpeech === 0 && metrics.orderErrors === 0);
    check(metrics.overflows === Math.ceil(N / 2));
    check(metrics.duplicatesSuppressed === metrics.duplicateInputs + metrics.replayDeliveries);
    check(metrics.appliedFinals === N * L * T * 4 && metrics.maxConcurrentSpeechPerListener === 1);
  } finally {
    for (const p of people) { p.speaker.close(); p.store.close(); }
    await Promise.all(people.map(p => p.op.close()));
    recent.length = 0;
  }
  metrics.finalTrackedRecords = timing.size() + people.reduce((sum, p) => sum
    + p.store.snapshot().captions.length + p.speaker.snapshot().waiting
    + Number(p.speaker.snapshot().speaking) + p.op.snapshot().pendingMessages
    + p.activeSpeech + Number(p.socket.readyState !== 3), 0);
  check(metrics.finalTrackedRecords === 0);
  return { mode: 'mock', networkConnections: 0, parameters: { listeners: N, languages: L, durationSeconds: T },
    virtualElapsedMs: timing.now(), traffic: { segmentsPerLanguagePerSecond: 4, recentFinalLimit: 30 },
    limits: { ...HUB_CLIENT_LIMITS, captions: MAX_CAPTIONS, ttsWaiting: 20, trackedRecordBound }, metrics,
    memory: { heapBeforeBytes: heapBefore, heapAfterBytes: process.memoryUsage().heapUsed,
      exactHeapObjectCount: null, identityCountMethod: 'derived-from-unique-selected-finals',
      identityRetention: 'until-participant-close' },
    checks: 'passed', fieldCapacity: 'unverified' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runMock(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ code: error?.message === 'P2_LOAD_INVALID_ARGUMENTS'
      ? 'P2_LOAD_INVALID_ARGUMENTS' : 'P2_LOAD_FAILED' }));
    process.exitCode = 1;
  }
}
