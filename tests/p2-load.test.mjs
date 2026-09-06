import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseArgs, runMock } from '../scripts/p2-load.mjs';

const args = ['--listeners', '4', '--languages', '2', '--duration-seconds', '10'];
test('N/L/T are mandatory positive safe integers; only offline mock mode is accepted', () => {
  assert.deepEqual(parseArgs(args), { mode: 'mock', listeners: 4, languages: 2, durationSeconds: 10 });
  for (const invalid of [[], args.slice(0, 4), args.slice(2), args.slice(0, 2).concat(args.slice(4)),
    [...args, '--listeners', '4'], [...args, '--mode', 'live'], [...args, '--room', 'PRIVATE'],
    [...args, '--key', 'PRIVATE'], [...args, '--url', 'https://PRIVATE'], [...args, '--mode'],
    ['--mode', 'mock', '--mode', 'mock', ...args]]) {
    assert.throws(() => parseArgs(invalid), { message: 'P2_LOAD_INVALID_ARGUMENTS' });
  }
  for (const index of [1, 3, 5]) for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 1', '+1', '01', '9007199254740992']) {
    const invalid = [...args]; invalid[index] = value;
    assert.throws(() => parseArgs(invalid), { message: 'P2_LOAD_INVALID_ARGUMENTS' });
  }
  assert.throws(() => parseArgs(['--listeners', '1', '--languages', '4', '--duration-seconds', '1']));
  assert.throws(() => parseArgs(['--listeners', '9007199254740991', '--languages', '1', '--duration-seconds', '1']));
});

test('real receive and speech queues hit bounds, isolate slow clients and replay silently offline', async () => {
  const names = ['fetch', 'WebSocket', 'navigator', 'localStorage', 'sessionStorage'];
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let accesses = 0;
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true,
      get() { accesses++; throw new Error('PRIVATE'); } });
    const result = await runMock(parseArgs(args));
    const m = result.metrics;
    assert.equal(accesses, 0);
    assert.equal(result.networkConnections, 0);
    assert.equal(result.fieldCapacity, 'unverified');
    assert.equal(m.appliedFinals, 320); assert.equal(m.maxConcurrentSpeechPerListener, 1);
    assert.ok(m.maxTrackedRecords <= result.limits.trackedRecordBound);
    assert.equal(m.partials, 80); assert.equal(m.finals, 80); assert.equal(m.corrections, 80);
    assert.equal(m.reconnects, 4); assert.equal(m.overflows, 2);
    assert.equal(m.maxReceiveMessages, 128); assert.equal(m.maxReceiveBytes, 2097152);
    assert.equal(m.maxTtsWaiting, 20); assert.ok(m.skippedSpeech > 0);
    assert.equal(m.duplicatesSuppressed, m.duplicateInputs + m.replayDeliveries);
    assert.equal(m.duplicateSpeech + m.replaySpeech + m.orderErrors, 0);
    assert.ok(m.speechRequests > 0); assert.equal(m.identityEntriesDerived, 160);
    assert.equal(m.finalTrackedRecords, 0);
    assert.equal(result.memory.exactHeapObjectCount, null);
    assert.equal(JSON.stringify(result).includes('mock:'), false);
    assert.equal(JSON.stringify(result).includes('wss:'), false);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

test('longer streams evict captions while identity retention is explicitly proportional to duration', async () => {
  const short = await runMock({ mode: 'mock', listeners: 2, languages: 3, durationSeconds: 12 });
  const long = await runMock({ mode: 'mock', listeners: 2, languages: 3, durationSeconds: 30 });
  for (const r of [short, long]) {
    assert.equal(r.metrics.maxCaptionRows, 101);
    assert.equal(r.metrics.finalTrackedRecords, 0);
    assert.equal(r.metrics.duplicatesSuppressed, r.metrics.duplicateInputs + r.metrics.replayDeliveries);
  }
  assert.equal(long.metrics.identityEntriesDerived / short.metrics.identityEntriesDerived, 30 / 12);
  assert.ok(long.metrics.maxTrackedRecords > short.metrics.maxTrackedRecords);
});

test('minimum workload still exercises disconnect/replay and validates the exported runner', async () => {
  const r = await runMock({ mode: 'mock', listeners: 1, languages: 1, durationSeconds: 1 });
  assert.equal(r.metrics.reconnects, 1); assert.equal(r.metrics.replayDeliveries, 4);
  assert.equal(r.metrics.finalTrackedRecords, 0);
  await assert.rejects(runMock({ mode: 'real', listeners: 1, languages: 1, durationSeconds: 1 }),
    { message: 'P2_LOAD_INVALID_ARGUMENTS' });
});

test('CLI emits aggregate JSON and rejects secret-bearing arguments without echoing them', () => {
  const cwd = new URL('../', import.meta.url);
  const ok = spawnSync(process.execPath, ['scripts/p2-load.mjs', ...args], { cwd, encoding: 'utf8' });
  assert.equal(ok.status, 0); assert.equal(ok.stderr, '');
  assert.equal(JSON.parse(ok.stdout).checks, 'passed');
  for (const extra of [['--room', 'PRIVATE_SENTINEL'], ['--key', 'PRIVATE_SENTINEL'], ['--mode', 'PRIVATE_SENTINEL']]) {
    const bad = spawnSync(process.execPath, ['scripts/p2-load.mjs', ...args, ...extra], { cwd, encoding: 'utf8' });
    assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
    assert.deepEqual(JSON.parse(bad.stderr), { code: 'P2_LOAD_INVALID_ARGUMENTS' });
    assert.equal(bad.stderr.includes('PRIVATE_SENTINEL'), false);
  }
});
