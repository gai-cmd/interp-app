// New implementation of docs/extension.md §11.1 (extension-arming); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArming, originOf } from '../extension/background/arming.js';

// Section 6.2: armed-tab bookkeeping over storage.session. The record is bookkeeping (Chromium holds the real grant),
// so every method is total: a storage failure reads as "not armed" and a failed write is dropped.

const KEY = 'interp.armed.v1';

// An in-memory session area. `delay(op)` may return a number of macrotask hops to wait, to interleave concurrent calls.
function sessionArea({ delay = () => 0, failGet = false, failSet = false } = {}) {
  const data = new Map();
  const calls = [];
  const hop = async (count) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    data, calls,
    async get(key) {
      calls.push(['get', key]);
      await hop(delay('get'));
      if (failGet) throw new Error('storage down');
      return data.has(key) ? { [key]: JSON.parse(JSON.stringify(data.get(key))) } : {};
    },
    async set(items) {
      calls.push(['set', Object.keys(items)]);
      await hop(delay('set'));
      if (failSet) throw new Error('quota');
      for (const [key, value] of Object.entries(items)) data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async remove(key) { calls.push(['remove', key]); data.delete(key); },
  };
}
const tab = (id, url = 'https://claude.ai/doc', windowId = 1) => ({ id, windowId, url });
let clock = 1_000;
const make = (area, options = {}) => createArming({ storageSession: area, now: () => (clock += 1), ...options });

test('originOf: http(s) origins only; everything else is null', () => {
  assert.equal(originOf('https://claude.ai/a/b?c#d'), 'https://claude.ai');
  assert.equal(originOf('http://localhost:8080/x'), 'http://localhost:8080');
  for (const url of ['file:///tmp/a.html', 'chrome://extensions', 'about:blank', 'data:text/html,hi', 'chrome-extension://abc/panel.html',
    'not a url', '', undefined, null, 42, {}]) assert.equal(originOf(url), null, String(url));
});

test('arm, isArmed, get and clear; the stored shape is { v: 1, tabs: { id: { windowId, origin, at } } }', async () => {
  const area = sessionArea();
  const arming = make(area);
  assert.equal(await arming.isArmed(7), false);
  assert.equal(await arming.get(7), null);
  await arming.arm(tab(7, 'https://claude.ai/doc', 3));
  assert.equal(await arming.isArmed(7), true);
  const entry = await arming.get(7);
  assert.deepEqual({ ...entry, at: typeof entry.at }, { windowId: 3, origin: 'https://claude.ai', at: 'number' });
  assert.deepEqual(Object.keys(area.data.get(KEY)), ['v', 'tabs']);
  assert.equal(area.data.get(KEY).v, 1);
  await arming.arm(tab(8, 'file:///x.html'));
  assert.equal((await arming.get(8)).origin, null, 'file: has an opaque origin');
  await arming.clear(7);
  assert.equal(await arming.isArmed(7), false);
  assert.equal(await arming.isArmed(8), true);
  await arming.clear(999);   // unknown tab: no-op
  await arming.clearAll();
  assert.equal(area.data.has(KEY), false);
  assert.equal(await arming.isArmed(8), false);
});

test('arming a tab twice refreshes its record instead of adding a second one', async () => {
  const area = sessionArea();
  const arming = make(area);
  await arming.arm(tab(7));
  const first = (await arming.get(7)).at;
  await arming.arm(tab(7, 'https://claude.ai/other'));
  assert.ok((await arming.get(7)).at > first);
  assert.deepEqual(Object.keys(area.data.get(KEY).tabs), ['7']);
});

test('at most 32 entries: the oldest is evicted first and the tab being armed is never the one evicted', async () => {
  const area = sessionArea();
  const arming = make(area);
  for (let id = 1; id <= 40; id += 1) await arming.arm(tab(id));
  const ids = Object.keys(area.data.get(KEY).tabs).map(Number).sort((a, b) => a - b);
  assert.equal(ids.length, 32);
  assert.deepEqual(ids, Array.from({ length: 32 }, (_, i) => i + 9));

  // equal timestamps: insertion order decides, and the newest survives
  const tied = make(sessionArea(), { now: () => 5, maxTabs: 3 });
  for (const id of [1, 2, 3, 4]) await tied.arm(tab(id));
  assert.equal(await tied.isArmed(4), true);
  assert.equal(await tied.isArmed(1), false);
});

test('concurrent arm calls are serialized: interleaved read-modify-writes lose nothing', async () => {
  let turn = 0;
  const area = sessionArea({ delay: (op) => (op === 'get' ? (turn += 1) % 4 : 1) });
  const arming = make(area);
  await Promise.all(Array.from({ length: 20 }, (_, i) => arming.arm(tab(i + 1))));
  assert.equal(Object.keys(area.data.get(KEY).tabs).length, 20);
  await Promise.all([arming.clear(1), arming.clear(2), arming.arm(tab(100)), arming.onTabUpdated(3, { url: 'https://other.example/' })]);
  const ids = new Set(Object.keys(area.data.get(KEY).tabs).map(Number));
  assert.equal(ids.has(1) || ids.has(2) || ids.has(3), false);
  assert.equal(ids.has(100), true);
  assert.equal(ids.size, 18);
});

test('onTabUpdated keeps same-origin changes (including pushState-like ones) and clears everything else', async () => {
  const arming = make(sessionArea());
  const cases = [
    ['same origin, other path', 'https://claude.ai/other/page?q=1#frag', true],
    ['pushState-like change', 'https://claude.ai/doc#section-2', true],
    ['other origin', 'https://example.com/', false],
    ['other port', 'https://claude.ai:8443/', false],
    ['other scheme', 'http://claude.ai/', false],
    ['non-http url', 'chrome://newtab/', false],
    ['about:blank', 'about:blank', false],
    ['unparsable url', 'not a url', false],
  ];
  for (const [name, url, keeps] of cases) {
    await arming.arm(tab(7));
    await arming.onTabUpdated(7, { url });
    assert.equal(await arming.isArmed(7), keeps, name);
  }
  await arming.arm(tab(7));
  for (const changeInfo of [{}, { status: 'complete' }, { title: 'x' }, { url: 12 }, undefined, null]) {
    await arming.onTabUpdated(7, changeInfo);
    assert.equal(await arming.isArmed(7), true, `no url string: ${JSON.stringify(changeInfo)}`);
  }
  await arming.onTabUpdated(999, { url: 'https://example.com/' });   // unknown tab: no-op
  await arming.arm(tab(9, 'file:///a.html'));
  await arming.onTabUpdated(9, { url: 'file:///b.html' });
  assert.equal(await arming.isArmed(9), false, 'an opaque origin never matches, so the record is dropped');
});

test('a storage failure never rejects: reads say "not armed", failed writes are dropped', async () => {
  const broken = make(sessionArea({ failGet: true }));
  assert.equal(await broken.isArmed(1), false);
  assert.equal(await broken.get(1), null);
  await broken.arm(tab(1));
  await broken.clear(1);
  await broken.onTabUpdated(1, { url: 'https://x.example/' });
  await broken.clearAll();

  const readOnly = make(sessionArea({ failSet: true }));
  await readOnly.arm(tab(1));
  assert.equal(await readOnly.isArmed(1), false);
});

test('corrupt or foreign stored shapes are ignored, and a good entry next to a bad one survives', async () => {
  const area = sessionArea();
  const arming = make(area);
  for (const bad of [null, 'x', 7, [], { v: 2, tabs: {} }, { v: 1 }, { v: 1, tabs: [] }, { v: 1, tabs: 'x' }]) {
    area.data.set(KEY, bad);
    assert.equal(await arming.isArmed(1), false);
  }
  area.data.set(KEY, { v: 1, tabs: { 1: { windowId: 1, origin: 'https://a.example', at: 5 }, x: { at: 1 }, 2: 'no', 3: { at: 'late' } } });
  assert.equal(await arming.isArmed(1), true);
  assert.equal(await arming.isArmed(2), false);
  assert.equal(await arming.isArmed(3), false);
  await arming.arm(tab(4));
  assert.deepEqual(Object.keys(area.data.get(KEY).tabs).sort(), ['1', '4'], 'unusable entries are dropped on the next write');
});

test('arm ignores a tab without an integer id', async () => {
  const area = sessionArea();
  const arming = make(area);
  for (const bad of [undefined, null, {}, { id: '7' }, { id: 1.5 }]) await arming.arm(bad);
  assert.equal(area.data.has(KEY), false);
});
