import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSimView } from '../app/ui/sim-view.js';
import { createListenState } from '../app/engine/listen-state.js';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { createI18n } from '../app/i18n/index.js';
import { FakeElement, byClass, all, tick } from './fixtures/scenarios.mjs';
const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async lang =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));
function fake(mode) {
  const state = createListenState({ mode }), captions = createCaptionStore({ sessionId: mode });
  const listeners = new Set(), calls = [];
  let extra = {};
  const snapshot = () => ({ ...state.snapshot(), captions: captions.snapshot(), ...extra });
  const publish = () => { for (const fn of listeners) fn(snapshot()); };
  state.subscribe(publish); captions.subscribe(publish);
  return { state, captions, calls, snapshot,
    patch(value) { extra = { ...extra, ...value }; publish(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get subscribers() { return listeners.size; },
    start(request) { calls.push(['start', request]); state.transition('preparing'); state.transition('connecting'); state.transition('running'); },
    join(request) { calls.push(['join', request]); state.transition('preparing'); state.transition('connecting'); state.transition('running'); },
    stop() { calls.push(['stop']); if (!['idle', 'stopped'].includes(state.snapshot().status)) { state.transition('stopping'); state.transition('stopped'); } },
    leave() { calls.push(['leave']); },
    setMuted(value) { calls.push(['mute', value]); state.setOutput(value ? 'muted' : 'ready'); },
  };
}
function setup({ hubs = true } = {}) {
  const doc = { createElement(tag) { return new FakeElement(doc, tag); } };
  const root = doc.createElement('main'), direct = fake('direct'), hub = fake('hub');
  const i18n = createI18n({ dictionaries, language: 'en' });
  const view = createSimView({ root, i18n, engines: { direct, hub },
    hubs: hubs ? [{ id: 'venue', labelKey: 'hub.venue' }] : [], startDirect: request => direct.start(request) });
  const get = name => byClass(root, `sim-${name}`);
  const choose = (name, value) => { get(name).value = value; get(name).dispatch('change'); };
  return { root, direct, hub, i18n, view, get, choose };
}
function caption(engine, sequence, status = 'final', text = `caption ${sequence}`, revision = 0, role = 'translation') {
  engine.captions.upsertDirect({ id: `${role}-${sequence}`, sessionId: 'direct', generation: 0, role, sequence,
    revision, status, [role === 'source' ? 'sourceText' : 'translatedText']: text, receivedAt: 1,
    finalizedAt: status === 'partial' ? null : 2 });
}

test('creation is passive; gestures start, mute, and stop; UI refresh preserves controls', () => {
  const f = setup();
  assert.deepEqual(f.direct.calls, []); assert.deepEqual(f.hub.calls, []);
  f.get('start').dispatch('click'); assert.equal(f.direct.calls[0][0], 'start');
  f.get('sound').dispatch('click'); assert.deepEqual(f.direct.calls.at(-1), ['mute', false]);
  f.i18n.setLanguage('ko'); f.view.refresh();
  assert.equal(f.get('mode').parentNode.children.length, 2);
  assert.equal(f.get('room').parentNode.children.length, 2);
  assert.equal(f.get('target').value, 'ja');
  assert.equal(f.direct.calls.length, 2);
  f.get('stop').dispatch('click'); assert.equal(f.direct.calls.at(-1)[0], 'stop');
  const start = f.get('start'); f.view.destroy(); f.view.destroy();
  assert.equal(f.direct.subscribers, 0); assert.equal(start.listenerCount, 0);
});

test('partial captions update in place without live announcements; final revisions do not repeat', () => {
  const f = setup(), payload = '<img src=x onerror=alert(1)>';
  caption(f.direct, 1, 'partial', payload);
  const row = f.get('caption');
  assert.ok(row.textContent.includes(payload));
  assert.equal(row.getAttribute('data-status'), 'partial');
  assert.equal(f.get('announcement').textContent, '');
  caption(f.direct, 1, 'partial', `${payload} next`, 1);
  assert.equal(f.get('caption'), row); assert.equal(f.get('announcement').textContent, '');
  caption(f.direct, 1, 'final', payload, 2);
  assert.equal(f.get('announcement').textContent, payload);
  caption(f.direct, 1, 'final', 'corrected', 3);
  assert.equal(f.get('announcement').textContent, payload);
  assert.equal(f.get('captions').getAttribute('aria-live'), 'off');
  assert.equal(all(f.root, n => n.tagName === 'IMG').length, 0);
  assert.equal(all(row, n => n.classes.has('turn-text'))[0].textContent, 'corrected');
  assert.equal(all(f.root, n => n.textContent === dictionaries.en['seq.original']).length, 0);
  caption(f.direct, 1, 'final', 'received source', 0, 'source');
  assert.equal(f.get('captions').children.length, 1);
  f.get('source').dispatch('click'); assert.equal(f.get('captions').children.length, 2);
});

test('100 settled rows plus active partials; anchor compensation survives eviction', () => {
  const f = setup();
  for (let i = 0; i < 100; i++) caption(f.direct, i);
  const list = f.get('captions');
  list.scrollTop = 200; list.clientHeight = 100; list.scrollHeight = 2000;
  list.getBoundingClientRect = () => ({ top: 0 });
  for (const row of list.children) row.getBoundingClientRect = () => {
    const top = list.children.indexOf(row) * 20 - list.scrollTop;
    return { top, bottom: top + 20 };
  };
  list.dispatch('scroll');
  caption(f.direct, 100);
  assert.equal(list.children.length, 100); assert.equal(list.scrollTop, 180);
  assert.equal(f.get('latest').hidden, false);
  caption(f.direct, 101, 'partial'); assert.equal(list.children.length, 101);
  f.get('latest').dispatch('click'); assert.equal(list.scrollTop, 2000);
});

test('language and mode changes await cleanup and never start a new connection', async () => {
  const f = setup(); f.get('start').dispatch('click');
  let finish; f.direct.stop = () => new Promise(resolve => { finish = resolve; });
  f.choose('target', 'en');
  assert.equal(f.get('start').disabled, true);
  assert.equal(f.get('target').value, 'ja');
  finish(); await tick(); assert.equal(f.get('target').value, 'en');
  f.choose('mode', 'hub'); finish(); await tick();
  assert.deepEqual(f.hub.calls, []); assert.equal(f.get('room').parentNode.hidden, false);
  f.get('room').value = 'room-memory-only'; f.get('start').dispatch('click');
  assert.deepEqual(f.hub.calls[0], ['join', { hubId: 'venue', roomCode: 'room-memory-only', language: 'en' }]);
});

test('hub language intersection, recent notice, independent output and cause-specific gaps', async () => {
  const f = setup(); f.choose('mode', 'hub'); await tick();
  f.hub.patch({ status: 'running', allowedLangs: ['en', 'fr'], recentPossible: true, output: 'blocked' });
  assert.equal(f.get('target').children.find(n => n.getAttribute('value') === 'ja').disabled, true);
  assert.equal(f.get('recent').hidden, false);
  assert.equal(f.get('status').textContent, dictionaries.en['sim.status.running']);
  assert.equal(f.get('output').textContent, dictionaries.en['sim.output.blocked']);
  f.hub.captions.markGap('audio'); assert.equal(f.get('gap-audio').hidden, false);
  assert.equal(f.get('gap-reception').hidden, true);
  f.hub.captions.markGap('reception'); assert.equal(f.get('gap-reception').hidden, false);
  f.hub.captions.upsertHub({ epoch: 0, lang: 'ja', segmentId: 'old', seq: 1, text: 'past', final: true, revision: 0 });
  assert.equal(f.get('announcement').textContent, '');
  f.hub.patch({ allowedLangs: [] }); assert.ok(f.get('target').children.every(n => n.disabled));
});

test('unregistered hubs are hidden and rejected promises expose no raw error', async () => {
  const f = setup({ hubs: false }); assert.equal(f.get('mode').children.length, 1);
  f.direct.start = () => { throw new Error('SECRET endpoint detail'); };
  f.get('start').dispatch('click'); assert.equal(f.get('notice').textContent, dictionaries.en['error.unknown']);
  f.direct.start = () => ({ ready: Promise.reject(new Error('SECRET')), done: Promise.reject(new Error('SECRET')) });
  f.get('start').dispatch('click'); await tick();
  assert.equal(f.root.textContent.includes('SECRET'), false);
});
