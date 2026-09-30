// 2026-09-30: built-in keys that hit their quota are remembered across starts
// and page loads by fingerprint and expiry, never by the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRegistry } from '../app/providers/registry.js';
import { provider, adapter } from './fixtures/providers.mjs';
import { BUILTIN_COOLDOWN_STORAGE_KEY, builtinCooldownEnd, createKeyStore, nextPacificMidnight } from '../app/security/key-store.js';
import { keyFingerprint, sha256Hex } from '../app/security/fingerprint.js';

// Runtime-assembled synthetic keys; nothing key-shaped is written in the source.
const pool = (count = 3) => Array.from({ length: count }, (_, i) => ['synthetic', 'cooldown', 'key', String(i + 1)].join('-'));
const address = { providerId: 'alpha', keySource: 'personal', transport: 'direct' };
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); } };
}
function open({ at = Date.UTC(2026, 8, 30, 12), store: backing = storage() } = {}) {
  const registry = createRegistry();
  registry.register(provider(), adapter());
  let now = at;
  const store = createKeyStore({ registry, storage: backing, now: () => now });
  return { store, backing, advance(ms) { now += ms; }, get now() { return now; } };
}
const inUse = (store) => store.resolveCredential(store.getCredentialRef(address).reference, address);
const record = (backing) => JSON.parse(backing.data.get(BUILTIN_COOLDOWN_STORAGE_KEY));

test('fingerprints are the first 8 hex digits of SHA-256, identical to node:crypto', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const text of ['', ...pool(5), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'), `length ${text.length}`);
  }
  assert.equal(keyFingerprint(pool()[0]), createHash('sha256').update(pool()[0]).digest('hex').slice(0, 8));
});

// Review 2026-09-30 reversed the first cut of this test, which pinned TOKEN_LIMIT
// and UNKNOWN_429 to the daily reset too: a Live 429 close is always
// UNKNOWN_429 (no structured quota id), so a per-minute or concurrent-session
// limit benched a key for up to 23 h. Only a structured per-day quota waits.
test('cooldown ends: DAILY_LIMIT at the next midnight in Los Angeles (DST included); every other 429 after 60 s', () => {
  const at = Date.UTC(2026, 8, 30, 12);
  for (const code of ['RATE_LIMITED', 'TOKEN_LIMIT', 'UNKNOWN_429']) assert.equal(builtinCooldownEnd(code, at), at + 60000, code);
  assert.equal(builtinCooldownEnd('DAILY_LIMIT', at), Date.UTC(2026, 9, 1, 7));
  assert.equal(builtinCooldownEnd('INVALID_KEY', at), null);
  // Summer (PDT, UTC-7) and winter (PST, UTC-8).
  assert.equal(nextPacificMidnight(Date.UTC(2026, 8, 30, 6, 59)), Date.UTC(2026, 8, 30, 7));
  assert.equal(nextPacificMidnight(Date.UTC(2026, 8, 30, 7)), Date.UTC(2026, 9, 1, 7));
  assert.equal(nextPacificMidnight(Date.UTC(2026, 11, 15, 12)), Date.UTC(2026, 11, 16, 8));
  // DST ends 2026-11-01 02:00 PDT: the following midnight is in PST.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 31, 20)), Date.UTC(2026, 10, 1, 7));
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 1, 8, 30)), Date.UTC(2026, 10, 2, 8));
  // DST starts 2027-03-14 02:00 PST: that midnight is still PST, the next is PDT.
  assert.equal(nextPacificMidnight(Date.UTC(2027, 2, 13, 20)), Date.UTC(2027, 2, 14, 8));
  assert.equal(nextPacificMidnight(Date.UTC(2027, 2, 14, 12)), Date.UTC(2027, 2, 15, 7));
});

test('a spent site key is recorded by fingerprint, skipped at the next page load, and back once its cooldown ends', () => {
  const keys = pool();
  const first = open();
  first.store.setBuiltin('alpha', keys);
  assert.equal(inUse(first.store), keys[0]);
  assert.deepEqual(first.store.rotateBuiltin('alpha', { code: 'RATE_LIMITED' }), { index: 1, count: 3 });
  const stored = record(first.backing);
  assert.deepEqual(stored, { [keyFingerprint(keys[0])]: first.now + 60000 });
  assert.ok(!first.backing.data.get(BUILTIN_COOLDOWN_STORAGE_KEY).includes(keys[0]), 'never the key itself');
  first.store.dispose();
  // Next page load, 30 s later: the pool starts on the second key.
  const second = open({ at: first.now + 30000, store: first.backing });
  second.store.setBuiltin('alpha', keys);
  assert.equal(inUse(second.store), keys[1]);
  assert.deepEqual([second.store.getMetadata('alpha', 'personal').builtinIndex, second.store.getMetadata('alpha', 'personal').builtinExhausted], [1, false]);
  second.store.dispose();
  // Past the cooldown: the first key is used again.
  const third = open({ at: first.now + 61000, store: first.backing });
  third.store.setBuiltin('alpha', keys);
  assert.equal(inUse(third.store), keys[0]);
  third.store.dispose();
});

test('rotation skips later keys still cooling from an earlier page; all cooling starts spent on the key that frees first', () => {
  const keys = pool(4);
  const at = Date.UTC(2026, 8, 30, 12);
  const backing = storage({ [BUILTIN_COOLDOWN_STORAGE_KEY]: JSON.stringify({
    [keyFingerprint(keys[1])]: at + 30000, [keyFingerprint(keys[2])]: at + 3600000 }) });
  const page = open({ at, store: backing });
  page.store.setBuiltin('alpha', keys);
  assert.equal(inUse(page.store), keys[0]);
  assert.deepEqual(page.store.rotateBuiltin('alpha', { code: 'DAILY_LIMIT' }), { index: 3, count: 4 }, 'keys 2 and 3 are skipped');
  assert.equal(record(backing)[keyFingerprint(keys[0])], Date.UTC(2026, 9, 1, 7));
  assert.equal(page.store.rotateBuiltin('alpha', { code: 'DAILY_LIMIT' }), null);
  assert.equal(page.store.getMetadata('alpha', 'personal').builtinExhausted, true);
  page.store.dispose();
  // Every key cooling: the pool starts spent, on the one whose cooldown ends first.
  const next = open({ at: at + 1000, store: backing });
  next.store.setBuiltin('alpha', keys);
  assert.deepEqual([next.store.getMetadata('alpha', 'personal').builtinIndex, next.store.getMetadata('alpha', 'personal').builtinExhausted], [1, true]);
  assert.equal(inUse(next.store), keys[1]);
  assert.equal(next.store.rotateBuiltin('alpha', { code: 'RATE_LIMITED' }), null, 'a spent pool does not rotate');
  next.store.dispose();
});

test('corrupt, hostile, absent or throwing storage means no cooldown and never blocks the pool', () => {
  const keys = pool(2);
  const at = Date.UTC(2026, 8, 30, 12);
  const print = keyFingerprint(keys[0]);
  for (const value of ['{', '[]', 'null', '"text"', JSON.stringify({ [print]: 'soon' }), JSON.stringify({ [print]: at + 30 * 3600000 }),
    JSON.stringify({ [print]: at - 1 }), JSON.stringify({ NOT_A_PRINT: at + 60000 })]) {
    const page = open({ at, store: storage({ [BUILTIN_COOLDOWN_STORAGE_KEY]: value }) });
    page.store.setBuiltin('alpha', keys);
    assert.equal(inUse(page.store), keys[0], value);
    page.store.dispose();
  }
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const blocked = open({ at, store: throwing });
  blocked.store.setBuiltin('alpha', keys);
  assert.deepEqual(blocked.store.rotateBuiltin('alpha', { code: 'UNKNOWN_429' }), { index: 1, count: 2 }, 'a failed write still rotates');
  blocked.store.dispose();
  const registry = createRegistry();
  registry.register(provider(), adapter());
  const memoryOnly = createKeyStore({ registry });
  memoryOnly.setBuiltin('alpha', keys);
  assert.deepEqual(memoryOnly.rotateBuiltin('alpha', { code: 'UNKNOWN_429' }), { index: 1, count: 2 });
  memoryOnly.dispose();
});

test('only the site key in use is recorded: a person\'s own key and non-quota codes leave no cooldown', () => {
  const keys = pool(3);
  const page = open();
  page.store.setBuiltin('alpha', keys);
  assert.deepEqual(page.store.rotateBuiltin('alpha', { code: 'INVALID_KEY' }), { index: 1, count: 3 });
  assert.equal(page.backing.data.has(BUILTIN_COOLDOWN_STORAGE_KEY), false, 'not a quota: nothing to wait for');
  assert.deepEqual(page.store.rotateBuiltin('alpha', { code: 'UNKNOWN_429' }), { index: 2, count: 3 });
  assert.deepEqual(Object.keys(record(page.backing)), [keyFingerprint(keys[1])], 'the site key that hit its quota');
  page.store.setPersonal('alpha', ['own', 'person', 'key'].join('-'));
  assert.equal(page.store.rotateBuiltin('alpha', { code: 'DAILY_LIMIT' }), null);
  assert.deepEqual(Object.keys(record(page.backing)), [keyFingerprint(keys[1])], 'the own key is never recorded');
  page.store.dispose();
});
