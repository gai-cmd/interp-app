import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSimView, KEY_FAILURE_CODES, VOICE_GENDER_STORAGE_KEY, listenFailure, readVoiceGender } from '../app/ui/sim-view.js';
import { ProviderError } from '../app/providers/contract.js';
import { createLiveVoicePreference, liveVoicePreference } from '../app/providers/gemini/live-config.js';
import { BAR_HIDE_MS, CAPTION_ONLY_STORAGE_KEYS, CAPTION_SIZE, CAPTION_SIZE_STORAGE_KEY, clampCaptionSize,
  createCaptionBoard, readPreferences } from '../app/ui/caption-board.js';
import { CAPTION_SIZE as PREFERENCE_CAPTION_SIZE, clampCaptionSize as clampFromPreferences,
  stepCaptionSize, storageKeyFor } from '../app/preferences.js';
import { REGISTERED_SETTINGS } from '../app/policy/schema.js';
import { createListenState } from '../app/engine/listen-state.js';
import { createCaptionStore } from '../app/engine/caption-store.js';
import { createI18n } from '../app/i18n/index.js';
import { FakeElement, byClass, all, tick } from './fixtures/scenarios.mjs';
const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async lang =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));
// P3-02c surface: custom properties, the Fullscreen API and a stub wake lock.
class BoardElement extends FakeElement {
  constructor(doc, tag) {
    super(doc, tag);
    this.style.properties = {};
    this.style.setProperty = (name, value) => { this.style.properties[name] = value; };
    this.requestFullscreen = async (options) => { doc.fullscreenRequests.push({ el: this, options }); doc.fullscreenElement = this; };
  }
}
function fakeTimers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    clearTimeout: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; },
    run() { const pending = queue.splice(0); for (const timer of pending) timer.fn?.(); },
    get pending() { return queue.filter((timer) => timer.fn); },
  };
}
function fakeStorage(initial = {}, { failing = false } = {}) {
  const map = new Map(Object.entries(initial));
  return { map,
    getItem: (key) => { if (failing) throw new Error('QUOTA'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (failing) throw new Error('QUOTA'); map.set(key, String(value)); },
    removeItem: (key) => { if (failing) throw new Error('QUOTA'); map.delete(key); } };
}
function fakeWakeLock({ supported = true, fail = false } = {}) {
  const requests = [], sentinels = [];
  const navigator = supported ? { wakeLock: { async request(type) {
    requests.push(type);
    if (fail) throw new Error('NotAllowedError');
    const listeners = new Set();
    const sentinel = { released: false, addEventListener: (t, fn) => { if (t === 'release') listeners.add(fn); },
      async release() { sentinel.released = true; for (const fn of listeners) fn(); } };
    sentinels.push(sentinel); return sentinel;
  } } } : {};
  return { requests, sentinels, navigator };
}
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
function setup({ hubs = true, storage = null, wakeLock = fakeWakeLock(), timers = fakeTimers(), voicePreference = createLiveVoicePreference(),
  onOpenSettings } = {}) {
  const doc = { createElement(tag) { return new BoardElement(doc, tag); }, activeElement: null, hidden: false,
    fullscreenElement: null, fullscreenRequests: [], exits: 0, listeners: new Map(),
    async exitFullscreen() { doc.exits++; doc.fullscreenElement = null; },
    addEventListener(type, fn) { (doc.listeners.get(type) ?? doc.listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { doc.listeners.get(type)?.delete(fn); },
    dispatch(type) { for (const fn of [...(doc.listeners.get(type) ?? [])]) fn({ type }); } };
  const win = { navigator: wakeLock.navigator };
  const root = doc.createElement('main'), direct = fake('direct'), hub = fake('hub');
  const i18n = createI18n({ dictionaries, language: 'en' });
  const view = createSimView({ root, i18n, engines: { direct, hub }, document: doc, window: win, storage, ...timers, voicePreference,
    hubs: hubs ? [{ id: 'venue', labelKey: 'hub.venue' }] : [], startDirect: request => direct.start(request), onOpenSettings });
  const get = name => byClass(root, `sim-${name}`);
  const choose = (name, value) => { get(name).value = value; get(name).dispatch('change'); };
  return { root, doc, win, direct, hub, i18n, view, get, choose, storage, wakeLock, timers, voicePreference,
    board: byClass(root, 'caption-board'), bar: byClass(root, 'caption-board-bar'), b: name => byClass(root, `caption-board-${name}`) };
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

test('status line always shows the active model and route; fallback and reply skips are visible', async () => {
  const f = setup();
  f.direct.patch({ model: 'gemini-3.5-live-translate-preview', route: 'translation', fallback: false, skippedSegments: [] });
  assert.equal(f.get('route').hidden, false);
  assert.equal(f.get('route').textContent, `${dictionaries.en['sim.route.translation']} · gemini-3.5-live-translate-preview`);
  f.direct.patch({ model: 'gemini-3.1-flash-live-preview', route: 'flash' });
  assert.equal(f.get('route').textContent, `${dictionaries.en['sim.route.flash']} · gemini-3.1-flash-live-preview`);
  f.direct.patch({ fallback: true });
  assert.equal(f.get('route').textContent, `${dictionaries.en['sim.route.fallback']} · gemini-3.1-flash-live-preview`);
  f.i18n.setLanguage('ko'); f.view.refresh();
  assert.equal(f.get('route').textContent, `${dictionaries.ko['sim.route.fallback']} · gemini-3.1-flash-live-preview`);
  caption(f.direct, 1, 'interrupted', 'Sure, I can help you with that');
  f.direct.patch({ skippedSegments: ['translation-1'] });
  const row = f.get('caption');
  assert.equal(row.getAttribute('data-skipped'), 'true');
  assert.ok(all(row, n => n.classes.has('turn-label'))[0].textContent.includes(dictionaries.ko['sim.captions.skipped']));
  assert.equal(f.get('announcement').textContent, '');
  caption(f.direct, 2, 'final', 'Good morning');
  assert.equal(all(f.root, n => n.getAttribute('data-skipped') === 'true').length, 1);
  f.choose('mode', 'hub'); await tick();
  assert.equal(f.get('route').hidden, true);
});

test('voice choice: female default, male/female only, shared preference, restart notice, remembered gender', async () => {
  const storage = fakeStorage();
  const f = setup({ storage });
  const voice = f.get('voice');
  assert.deepEqual(voice.children.map(n => n.getAttribute('value')), ['female', 'male'], 'gender only: no role personas');
  assert.equal(voice.children[0].textContent, dictionaries.en['sim.voice.female']);
  assert.equal(voice.parentNode.children[0].textContent, dictionaries.en['sim.voice']);
  assert.equal(voice.value, 'female');
  assert.deepEqual(f.voicePreference.snapshot(), { gender: 'female', voice: null, voiceName: 'Kore' });
  // Idle change: no notice, preference and storage updated, no engine call.
  f.choose('voice', 'male');
  assert.equal(f.voicePreference.snapshot().voiceName, 'Orus');
  assert.equal(storage.map.get(VOICE_GENDER_STORAGE_KEY), 'male');
  assert.equal(f.get('notice').textContent, '');
  assert.deepEqual(f.direct.calls, []);
  // Running change: the session keeps going; the restart notice appears.
  f.get('start').dispatch('click');
  f.choose('voice', 'female');
  assert.equal(f.voicePreference.snapshot().voiceName, 'Kore');
  assert.equal(f.get('notice').textContent, dictionaries.en['sim.voiceRestart']);
  assert.equal(f.direct.calls.length, 1, 'no stop or restart on a voice change');
  assert.equal(storage.map.has(VOICE_GENDER_STORAGE_KEY), false, 'the default gender is not stored');
  // The settings picker (an explicit voice) is mirrored: Orus shows as male, another voice keeps the gender.
  f.voicePreference.set({ voice: 'Orus' }); assert.equal(voice.value, 'male');
  f.voicePreference.set({ voice: 'Zephyr' }); assert.equal(voice.value, 'male');
  assert.equal(storage.map.get(VOICE_GENDER_STORAGE_KEY), 'male');
  f.i18n.setLanguage('ja'); f.view.refresh();
  assert.equal(voice.children[1].textContent, dictionaries.ja['sim.voice.male']);
  assert.equal(voice.value, 'male');
  f.choose('mode', 'hub'); await tick();
  assert.equal(voice.parentNode.hidden, true, 'hub listening has no provider voice');
  f.choose('mode', 'direct'); await tick();
  assert.equal(voice.parentNode.hidden, false);
  // A second launch restores the remembered gender; corrupt values fall back to female.
  const g = setup({ storage: fakeStorage({ [VOICE_GENDER_STORAGE_KEY]: 'male' }) });
  assert.equal(g.get('voice').value, 'male'); assert.equal(g.voicePreference.snapshot().voiceName, 'Orus');
  const h = setup({ storage: fakeStorage({ [VOICE_GENDER_STORAGE_KEY]: 'robot' }) });
  assert.equal(h.get('voice').value, 'female');
  assert.equal(readVoiceGender(null), 'female'); assert.equal(readVoiceGender(fakeStorage({}, { failing: true })), 'female');
  // Late storage (main.js hands it over after mount) restores too; a failing storage never breaks the choice.
  const m = setup(); m.view.setStorage(fakeStorage({ [VOICE_GENDER_STORAGE_KEY]: 'male' }));
  assert.equal(m.get('voice').value, 'male');
  const k = setup({ storage: fakeStorage({}, { failing: true }) });
  k.choose('voice', 'male'); assert.equal(k.voicePreference.snapshot().gender, 'male');
  // The default view uses the module singleton and unsubscribes on destroy.
  const before = liveVoicePreference.snapshot().gender;
  const shared = setup({ voicePreference: liveVoicePreference });
  try {
    liveVoicePreference.set({ gender: 'male' }); assert.equal(shared.get('voice').value, 'male');
    const el = shared.get('voice'); shared.view.destroy();
    liveVoicePreference.set({ gender: 'female' }); assert.equal(el.value, 'male');
  } finally { liveVoicePreference.set({ gender: before }); }
  f.view.destroy(); assert.equal(f.get('voice'), undefined);
});

test('speech gate indicator: "no speech" while only music or silence reaches the microphone', () => {
  const f = setup();
  const speech = f.get('speech');
  assert.equal(speech.hidden, true);
  f.view.onLevel({ rms: 0.2, gate: 'open' });
  assert.equal(speech.getAttribute('data-speech'), 'none', 'levels before a session are ignored');
  f.get('start').dispatch('click');
  assert.equal(speech.hidden, false);
  assert.equal(speech.textContent, dictionaries.en['sim.speech.none']);
  f.view.onLevel({ rms: 0.2, gate: 'open' });
  assert.equal(speech.textContent, dictionaries.en['sim.speech.detected']);
  assert.equal(speech.getAttribute('data-speech'), 'detected');
  assert.equal(f.get('level').getAttribute('value'), '80');
  // Explicit gate state from capture.js wins over the level; gated streaming frames arrive as exact silence.
  f.view.onLevel({ rms: 0.2, gate: 'closed' });
  assert.equal(speech.textContent, dictionaries.en['sim.speech.none']);
  f.view.onLevel({ rms: 0 });
  assert.equal(speech.textContent, dictionaries.en['sim.speech.none']);
  assert.equal(f.get('level').getAttribute('value'), '0');
  f.view.onLevel({ rms: 0.05 });
  assert.equal(speech.textContent, dictionaries.en['sim.speech.detected']);
  f.i18n.setLanguage('ko'); f.view.refresh();
  assert.equal(speech.textContent, dictionaries.ko['sim.speech.detected'], 'a refresh keeps the last gate state in the new language');
  f.view.onLevel({ rms: 0 }); assert.equal(speech.textContent, dictionaries.ko['sim.speech.none']);
  f.get('stop').dispatch('click');
  assert.equal(speech.hidden, true); assert.equal(speech.getAttribute('data-speech'), 'none');
  assert.equal(f.get('level').getAttribute('value'), '0');
});

test('headphone warning is stressed once at the first direct start', () => {
  const f = setup();
  f.get('start').dispatch('click');
  assert.equal(f.get('notice').textContent, dictionaries.en['sim.headphonesStart']);
  f.get('stop').dispatch('click'); f.get('start').dispatch('click');
  assert.equal(f.get('notice').textContent, '');
});

test('unregistered hubs are hidden and rejected promises expose no raw error', async () => {
  const f = setup({ hubs: false }); assert.equal(f.get('mode').children.length, 1);
  f.direct.start = () => { throw new Error('SECRET endpoint detail'); };
  f.get('start').dispatch('click'); assert.equal(f.get('notice').textContent, dictionaries.en['error.unknown']);
  f.direct.start = () => ({ ready: Promise.reject(new Error('SECRET')), done: Promise.reject(new Error('SECRET')) });
  f.get('start').dispatch('click'); await tick();
  assert.equal(f.root.textContent.includes('SECRET'), false);
});

// P3-02e: failures are named by code; key problems lead to the settings key entry.
test('a missing or rejected key is named (never the generic text) and "open settings" leads to the key entry', async () => {
  let opened = 0;
  const f = setup({ onOpenSettings: () => { opened++; } });
  assert.equal(f.get('open-settings').hidden, true);
  // The app adapter rejects before the engine runs (no key selected).
  f.direct.start = () => { throw new ProviderError('CREDENTIAL_REQUIRED'); };
  f.get('start').dispatch('click');
  assert.equal(f.get('notice').textContent, dictionaries.en['sim.error.CREDENTIAL_REQUIRED']);
  assert.notEqual(f.get('notice').textContent, dictionaries.en['error.unknown']);
  assert.equal(f.get('open-settings').hidden, false);
  f.get('open-settings').dispatch('click'); assert.equal(opened, 1);
  f.i18n.setLanguage('ja'); f.view.refresh();
  assert.equal(f.get('notice').textContent, dictionaries.ja['sim.error.CREDENTIAL_REQUIRED']);
  // A policy block from the app gate shows its own reason; no key entry is offered.
  f.direct.start = () => { throw Object.assign(new Error('SECRET detail'), { code: 'POLICY_STOPPED' }); };
  f.get('start').dispatch('click');
  assert.equal(f.get('notice').textContent, dictionaries.ja['error.POLICY_STOPPED']);
  assert.equal(f.get('open-settings').hidden, true);
  // A browser without streaming capture is named; a rejected key (engine result) offers settings again.
  f.direct.start = () => { throw new ProviderError('INPUT_UNSUPPORTED'); };
  f.get('start').dispatch('click');
  assert.equal(f.get('notice').textContent, dictionaries.ja['sim.error.INPUT_UNSUPPORTED']);
  f.direct.start = () => { f.direct.patch({ status: 'failed', errorCode: 'INVALID_KEY' }); };
  f.get('start').dispatch('click');
  assert.equal(f.get('notice').textContent, dictionaries.ja['sim.error.INVALID_KEY']);
  assert.equal(f.get('open-settings').hidden, false);
  assert.equal(f.get('start').textContent, dictionaries.ja['sim.reopen'], 'after a failure the primary action reopens the session');
  assert.equal(f.get('fs-primary').textContent, dictionaries.ja['sim.reopen']);
  f.get('open-settings').dispatch('click'); assert.equal(opened, 2);
  // Starting again clears the screen failure; a stopped session says "restart".
  f.direct.patch({ status: 'idle', errorCode: null });
  f.direct.start = (request) => { f.direct.calls.push(['start', request]); f.direct.patch({ status: 'running' }); };
  f.get('start').dispatch('click');
  assert.equal(f.get('open-settings').hidden, true);
  f.direct.patch({ status: 'stopped' });
  assert.equal(f.get('start').textContent, dictionaries.ja['sim.restart']);
  // Hub failures never point to the personal key entry.
  f.choose('mode', 'hub'); await tick();
  f.hub.patch({ status: 'failed', errorCode: 'CREDENTIAL_REQUIRED' });
  assert.equal(f.get('open-settings').hidden, true);
  assert.equal(f.root.textContent.includes('SECRET'), false);
  // The mapping alone: known codes, app codes with a dictionary entry, and nothing else.
  assert.deepEqual(listenFailure(f.i18n, new Error('SECRET')), { code: null, key: 'error.unknown' });
  assert.deepEqual(listenFailure(f.i18n, { code: 'SECRET_CODE' }), { code: null, key: 'error.unknown' });
  assert.deepEqual(listenFailure(f.i18n, new ProviderError('NETWORK_ERROR')), { code: 'NETWORK_ERROR', key: 'error.NETWORK_ERROR' });
  // Capture codes arrive as the engine's errorCode string, not as ProviderError codes.
  assert.deepEqual(listenFailure(f.i18n, { code: 'MICROPHONE_DENIED' }), { code: 'MICROPHONE_DENIED', key: 'sim.error.MICROPHONE_DENIED' });
  assert.deepEqual(listenFailure(f.i18n, { code: 'RATE_LIMITED' }), { code: 'RATE_LIMITED', key: 'sim.error.RATE_LIMITED' });
  assert.deepEqual([...KEY_FAILURE_CODES], ['CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'INVALID_KEY', 'PERMISSION_DENIED']);
  // Without an onOpenSettings adapter the action is never shown.
  const g = setup();
  g.direct.start = () => { throw new ProviderError('CREDENTIAL_REQUIRED'); };
  g.get('start').dispatch('click');
  assert.equal(g.get('notice').textContent, dictionaries.en['sim.error.CREDENTIAL_REQUIRED']);
  assert.equal(g.get('open-settings').hidden, true);
});

test('reopen session: offered while a direct session exists, closes it and starts again; the status counts automatic replacements', async () => {
  const f = setup();
  assert.equal(f.get('reopen').hidden, true); assert.equal(f.get('fs-reopen').hidden, true);
  assert.ok(f.bar.contains(f.get('fs-reopen')), 'the full-screen bar carries the reopen control');
  f.get('start').dispatch('click');
  assert.equal(f.get('reopen').hidden, false); assert.equal(f.get('fs-reopen').hidden, false);
  assert.equal(f.get('reopen').textContent, dictionaries.en['sim.reopen']);
  assert.equal(f.get('status').textContent, dictionaries.en['sim.status.running']);
  // Automatic replacement in progress: "replacing session · n".
  f.direct.state.transition('reconnecting'); f.direct.patch({ retries: 2 });
  assert.equal(f.get('status').textContent, dictionaries.en['sim.status.replacing'].replace('{count}', '2'));
  assert.equal(f.get('reopen').hidden, false, 'a stuck replacement can be reopened by hand');
  f.i18n.setLanguage('ko'); f.view.refresh();
  assert.equal(f.get('status').textContent, dictionaries.ko['sim.status.replacing'].replace('{count}', '2'));
  f.direct.state.transition('running');
  assert.equal(f.get('status').textContent, dictionaries.ko['sim.status.running']);
  // Manual reopen: physical stop, then a fresh start with the same settings.
  f.get('fs-reopen').dispatch('click');
  assert.equal(f.get('reopen').disabled, true);
  await tick();
  assert.deepEqual(f.direct.calls.map(call => call[0]), ['start', 'stop', 'start']);
  assert.deepEqual(f.direct.calls.at(-1)[1], { targetLanguage: 'ja' });
  assert.equal(f.direct.snapshot().status, 'running');
  assert.equal(f.get('reopen').disabled, false);
  // A failing close is reported by its code and nothing restarts.
  f.direct.stop = () => { f.direct.calls.push(['stop']); throw new ProviderError('SESSION_CLOSED'); };
  f.get('reopen').dispatch('click'); await tick();
  assert.equal(f.get('notice').textContent, dictionaries.ko['error.SESSION_CLOSED']);
  assert.equal(f.direct.calls.filter(call => call[0] === 'start').length, 2);
  // Hub listening has no reopen control; the hub status line is unchanged.
  f.direct.stop = () => { f.direct.calls.push(['stop']); f.direct.state.transition('stopping'); f.direct.state.transition('stopped'); };
  f.choose('mode', 'hub'); await tick();
  assert.equal(f.get('reopen').hidden, true);
  f.hub.patch({ status: 'reconnecting', retries: 1 });
  assert.equal(f.get('status').textContent, dictionaries.ko['sim.status.reconnecting']);
  f.view.destroy();
});

test('captions-only mode: full screen, wake lock, auto-hiding bar, Escape and focus return', async () => {
  const storage = fakeStorage();
  const f = setup({ storage });
  const enter = f.get('caption-only');
  assert.equal(f.board.getAttribute('data-caption-only'), 'false');
  assert.equal(f.bar.hidden, true);
  assert.equal(f.b('status').hidden, true);
  enter.focus(); enter.dispatch('click');
  assert.equal(f.board.getAttribute('data-caption-only'), 'true');
  assert.equal(f.view.element.getAttribute('data-caption-only'), 'true');
  assert.equal(enter.getAttribute('aria-pressed'), 'true');
  assert.equal(f.doc.fullscreenRequests.length, 1);
  assert.equal(f.doc.fullscreenRequests[0].el, f.board);
  assert.deepEqual(f.wakeLock.requests, ['screen']);
  assert.equal(f.bar.hidden, false);
  assert.equal(f.doc.activeElement, f.b('exit'));
  assert.equal(f.b('status').hidden, false);
  assert.equal(f.b('status').textContent, dictionaries.en['sim.status.idle']);
  assert.equal(f.get('fs-primary').hidden, false);
  assert.equal(f.get('fs-primary').textContent, dictionaries.en['common.start']);
  assert.equal(storage.map.get(CAPTION_ONLY_STORAGE_KEYS.enabled), '1');
  await tick();
  assert.equal(f.b('wake').textContent, dictionaries.en['captionOnly.wakeLock.active']);
  // Focus inside the bar keeps it; the timer re-arms instead of hiding.
  assert.equal(f.timers.pending.length, 1); assert.equal(f.timers.pending[0].ms, BAR_HIDE_MS);
  f.timers.run(); assert.equal(f.bar.hidden, false); assert.equal(f.timers.pending.length, 1);
  f.doc.activeElement = null; f.timers.run(); assert.equal(f.bar.hidden, true);
  f.board.dispatch('click', { target: f.board }); assert.equal(f.bar.hidden, false);
  f.board.dispatch('click', { target: f.board }); assert.equal(f.bar.hidden, true);
  f.board.dispatch('keydown', { key: 'a' }); assert.equal(f.bar.hidden, false);
  const escape = f.board.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(f.board.getAttribute('data-caption-only'), 'false');
  assert.equal(f.bar.hidden, true); assert.equal(f.timers.pending.length, 0);
  assert.equal(f.doc.exits, 1);
  assert.equal(f.wakeLock.sentinels[0].released, true);
  assert.equal(f.doc.activeElement, enter);
  assert.equal(storage.map.has(CAPTION_ONLY_STORAGE_KEYS.enabled), false);
  assert.equal(f.b('status').hidden, true);
  enter.dispatch('click'); f.b('exit').dispatch('click');
  assert.equal(f.board.getAttribute('data-caption-only'), 'false');
  enter.dispatch('click'); f.view.destroy();
  assert.equal(f.doc.exits, 3); assert.equal(f.wakeLock.sentinels.length, 3);
  await tick(); assert.ok(f.wakeLock.sentinels.every(s => s.released));
  assert.equal(f.doc.listeners.get('visibilitychange').size, 0);
});

test('captions-only preferences: size slider and display mode persist and are restored without a gesture', () => {
  const storage = fakeStorage();
  const f = setup({ storage });
  const slider = f.b('slider');
  // P3-18: the slider is the §1.10 scale, 1~2rem in 0.125 steps, and the
  // default is the registered `captions.size` default.
  assert.equal(slider.getAttribute('min'), '1'); assert.equal(slider.getAttribute('max'), '2');
  assert.equal(CAPTION_SIZE.max, 2); assert.equal(CAPTION_SIZE.initial, 1.5);
  assert.equal(f.board.style.properties['--caption-size'], '1.5rem');
  assert.equal(f.b('display').textContent, `${dictionaries.en['captionOnly.display']}: ${dictionaries.en['captionOnly.display.dark']}`);
  f.get('caption-only').dispatch('click');
  slider.value = '2'; slider.dispatch('input');
  assert.equal(f.board.style.properties['--caption-size'], '2rem');
  assert.equal(f.b('size-value').textContent, '2rem');
  assert.equal(storage.map.get(CAPTION_SIZE_STORAGE_KEY), '2');
  slider.value = '9'; slider.dispatch('input');
  assert.equal(f.view.board.size, CAPTION_SIZE.max);
  f.b('display').dispatch('click');
  assert.equal(f.board.getAttribute('data-display'), 'mono');
  assert.equal(f.b('display').textContent, `${dictionaries.en['captionOnly.display']}: ${dictionaries.en['captionOnly.display.mono']}`);
  assert.equal(storage.map.get(CAPTION_ONLY_STORAGE_KEYS.display), 'mono');
  f.b('display').dispatch('click'); assert.equal(f.board.getAttribute('data-display'), 'light');
  f.i18n.setLanguage('ja'); f.view.refresh();
  assert.equal(f.b('display').textContent, `${dictionaries.ja['captionOnly.display']}: ${dictionaries.ja['captionOnly.display.light']}`);
  assert.equal(f.b('exit').textContent, dictionaries.ja['captionOnly.exit']);
  // A second launch restores everything; the stored mode resumes without requestFullscreen.
  const g = setup({ storage: fakeStorage(Object.fromEntries(storage.map)) });
  assert.equal(g.board.getAttribute('data-caption-only'), 'true');
  assert.equal(g.board.getAttribute('data-display'), 'light');
  assert.equal(g.board.style.properties['--caption-size'], '2rem');
  assert.equal(g.doc.fullscreenRequests.length, 0);
  assert.deepEqual(g.wakeLock.requests, ['screen']);
  g.board.dispatch('click', { target: g.board });
  assert.equal(g.doc.fullscreenRequests.length, 1, 'the first tap requests fullscreen once');
  g.board.dispatch('click', { target: g.board });
  assert.equal(g.doc.fullscreenRequests.length, 1);
  // Corrupt values fall back; a failing storage never breaks the view.
  const h = setup({ storage: fakeStorage({ [CAPTION_SIZE_STORAGE_KEY]: 'huge', [CAPTION_ONLY_STORAGE_KEYS.display]: 'neon', [CAPTION_ONLY_STORAGE_KEYS.enabled]: 'yes' }) });
  assert.equal(h.view.board.size, CAPTION_SIZE.initial); assert.equal(h.view.board.display, 'dark'); assert.equal(h.view.board.captionOnly, false);
  const k = setup({ storage: fakeStorage({}, { failing: true }) });
  k.get('caption-only').dispatch('click'); assert.equal(k.view.board.captionOnly, true);
  k.b('slider').value = '1.5'; k.b('slider').dispatch('input'); assert.equal(k.view.board.size, 1.5);
  assert.equal(clampCaptionSize('1.3'), 1.25); assert.equal(clampCaptionSize(0.2), 1); assert.equal(clampCaptionSize(undefined), CAPTION_SIZE.initial);
  assert.deepEqual(readPreferences(null), { size: CAPTION_SIZE.initial, display: 'dark', enabled: false });
  // The app hands storage over after mount (main.js); a late setStorage restores too.
  const m = setup();
  m.view.setStorage(fakeStorage({ [CAPTION_ONLY_STORAGE_KEYS.enabled]: '1', [CAPTION_SIZE_STORAGE_KEY]: '1.5' }));
  assert.equal(m.view.board.captionOnly, true); assert.equal(m.board.style.properties['--caption-size'], '1.5rem');
});

test('full-screen controls share the session handlers and the caption rows', async () => {
  const f = setup();
  f.get('caption-only').dispatch('click');
  assert.equal(f.get('fs-stop').hidden, true);
  f.get('fs-primary').dispatch('click');
  assert.equal(f.direct.calls[0][0], 'start');
  assert.equal(f.get('fs-primary').hidden, true);
  assert.equal(f.get('fs-stop').hidden, false); assert.equal(f.get('fs-stop').disabled, false);
  assert.equal(f.b('status').textContent, dictionaries.en['sim.status.running']);
  assert.equal(f.get('fs-sound').textContent, dictionaries.en['sim.enableSound']);
  f.get('fs-sound').dispatch('click'); assert.deepEqual(f.direct.calls.at(-1), ['mute', false]);
  assert.equal(f.get('fs-sound').textContent, dictionaries.en['sim.mute']);
  caption(f.direct, 1, 'final', 'translated'); caption(f.direct, 1, 'final', 'spoken', 0, 'source');
  assert.equal(f.get('captions').children.length, 1);
  f.get('fs-source').dispatch('click');
  assert.equal(f.get('fs-source').getAttribute('aria-pressed'), 'true'); assert.equal(f.get('source').getAttribute('aria-pressed'), 'true');
  assert.equal(f.get('captions').children.length, 2);
  assert.equal(f.get('captions').getAttribute('aria-live'), 'off');
  assert.equal(f.get('announcement').getAttribute('aria-live'), 'polite');
  assert.equal(f.get('announcement').textContent, 'translated');
  f.get('fs-stop').dispatch('click'); assert.equal(f.direct.calls.at(-1)[0], 'stop');
  assert.equal(f.get('fs-primary').hidden, false); assert.equal(f.get('fs-primary').textContent, dictionaries.en['sim.restart']);
  assert.equal(f.get('fs-stop').hidden, true);
  f.choose('mode', 'hub'); await tick();
  assert.equal(f.get('captions').children.length, 0);
  assert.equal(f.get('fs-primary').textContent, dictionaries.en['hub.join']);
  assert.ok(all(f.root, n => n.getAttribute('type') === 'button' && n.classes.has('btn')).every(n => n.classes.has('btn-secondary') || n.classes.has('btn-primary')));
});

test('wake lock: unsupported and failing requests are announced as text; a visible tab re-acquires a released lock', async () => {
  const none = setup({ wakeLock: fakeWakeLock({ supported: false }) });
  none.get('caption-only').dispatch('click'); await tick();
  assert.equal(none.b('wake').hidden, false);
  assert.equal(none.b('wake').textContent, dictionaries.en['captionOnly.wakeLock.unsupported']);
  const failing = setup({ wakeLock: fakeWakeLock({ fail: true }) });
  failing.get('caption-only').dispatch('click'); await tick();
  assert.equal(failing.b('wake').textContent, dictionaries.en['captionOnly.wakeLock.failed']);
  const f = setup();
  f.get('caption-only').dispatch('click'); await tick();
  await f.wakeLock.sentinels[0].release();
  assert.equal(f.b('wake').hidden, true);
  f.doc.dispatch('visibilitychange'); await tick();
  assert.deepEqual(f.wakeLock.requests, ['screen', 'screen']);
  assert.equal(f.b('wake').textContent, dictionaries.en['captionOnly.wakeLock.active']);
  f.b('exit').dispatch('click');
  f.doc.dispatch('visibilitychange'); await tick();
  assert.equal(f.wakeLock.requests.length, 2, 'no wake lock outside captions-only mode');
  assert.throws(() => createCaptionBoard({ i18n: f.i18n }), { message: 'INVALID_REQUEST' });
});

// --- P3-18: the caption board's own size and contrast ---

test('P3-18 caption size is one contract: the registered captions.size spec, the same storage key everywhere', () => {
  assert.equal(CAPTION_SIZE, PREFERENCE_CAPTION_SIZE, 'the board re-exports the preference contract, it does not copy it');
  assert.equal(clampCaptionSize, clampFromPreferences);
  const spec = REGISTERED_SETTINGS['captions.size'];
  assert.deepEqual({ ...CAPTION_SIZE }, { min: spec.min, max: spec.max, step: spec.step, initial: spec.default });
  assert.deepEqual({ min: CAPTION_SIZE.min, max: CAPTION_SIZE.max, step: CAPTION_SIZE.step }, { min: 1, max: 2, step: 0.125 },
    'design-p3 §1.10: a separate 1~2rem caption scale in 0.125 steps');
  assert.equal(storageKeyFor('captions.size'), CAPTION_SIZE_STORAGE_KEY,
    'the 가−/가+ buttons, the slider and the settings screen move one stored value');
  // The scale is closed under stepping and never leaves the range.
  assert.equal(stepCaptionSize(CAPTION_SIZE.min, -1), CAPTION_SIZE.min);
  assert.equal(stepCaptionSize(CAPTION_SIZE.max, 1), CAPTION_SIZE.max);
  assert.equal(stepCaptionSize(1.5, 1), 1.625);
  assert.equal(stepCaptionSize(1.5, -1), 1.375);
  assert.equal(clampCaptionSize(9), 2); assert.equal(clampCaptionSize(0), 1);
  assert.equal(clampCaptionSize('nonsense'), CAPTION_SIZE.initial);
  let value = CAPTION_SIZE.min;
  for (let i = 0; i < 32; i++) { value = stepCaptionSize(value, 1); assert.equal(clampCaptionSize(value), value, 'every step is a valid size'); }
  assert.equal(value, CAPTION_SIZE.max);
});

test('P3-18 가− / 가+ move the caption size, persist it and stop at both ends', () => {
  const storage = fakeStorage();
  const f = setup({ storage });
  const smaller = f.get('caption-smaller'), larger = f.get('caption-larger'), output = f.get('caption-size');
  assert.equal(smaller.textContent, dictionaries.en['display.captions.smaller']);
  assert.equal(larger.textContent, dictionaries.en['display.captions.larger']);
  assert.equal(f.board.style.properties['--caption-size'], '1.5rem');
  assert.equal(output.textContent, '1.5rem');
  assert.equal(smaller.disabled, false); assert.equal(larger.disabled, false);

  larger.dispatch('click');
  assert.equal(f.view.board.size, 1.625);
  assert.equal(f.board.style.properties['--caption-size'], '1.625rem');
  assert.equal(output.textContent, '1.625rem');
  assert.equal(storage.map.get(CAPTION_SIZE_STORAGE_KEY), '1.625');
  smaller.dispatch('click');
  assert.equal(f.view.board.size, 1.5);
  assert.equal(storage.map.get(CAPTION_SIZE_STORAGE_KEY), '1.5');

  // Both ends: the button that cannot move is disabled, never silently inert.
  for (let i = 0; i < 10; i++) larger.dispatch('click');
  assert.equal(f.view.board.size, CAPTION_SIZE.max);
  assert.equal(larger.disabled, true); assert.equal(smaller.disabled, false);
  for (let i = 0; i < 10; i++) smaller.dispatch('click');
  assert.equal(f.view.board.size, CAPTION_SIZE.min);
  assert.equal(smaller.disabled, true); assert.equal(larger.disabled, false);
  assert.equal(storage.map.get(CAPTION_SIZE_STORAGE_KEY), '1');

  // The same value drives the caption-only slider, and moving the slider
  // updates the buttons the next time the view renders.
  assert.equal(f.b('slider').value, '1');
  f.b('slider').value = '2'; f.b('slider').dispatch('input');
  f.view.refresh();
  assert.equal(f.get('caption-size').textContent, '2rem');
  assert.equal(f.get('caption-larger').disabled, true);
});

test('P3-18 changing the caption size never resets the reading position', () => {
  const f = setup({ storage: fakeStorage() });
  const list = f.b('list');
  list.scrollHeight = 4000; list.clientHeight = 400;
  // A reader who scrolled up keeps their position while the text resizes:
  // the scroll tells the board it is no longer following the newest row.
  list.scrollTop = 1200; list.dispatch('scroll');
  assert.equal(byClass(f.root, 'sim-latest').hidden, false, 'the "latest" button appears once the reader scrolls up');
  f.get('caption-larger').dispatch('click');
  assert.equal(list.scrollTop, 1200, 'a size change must not jump the list');
  f.get('caption-smaller').dispatch('click');
  assert.equal(list.scrollTop, 1200);
  f.get('caption-contrast').dispatch('click');
  assert.equal(list.scrollTop, 1200, 'the contrast toggle does not scroll either');
});

test('P3-18 the high-contrast toggle is a two-state option on the board and survives a reload', () => {
  const storage = fakeStorage();
  const f = setup({ storage });
  const contrast = f.get('caption-contrast');
  assert.equal(contrast.getAttribute('aria-pressed'), 'false');
  assert.equal(f.board.getAttribute('data-display'), 'dark');
  contrast.dispatch('click');
  assert.equal(contrast.getAttribute('aria-pressed'), 'true');
  assert.equal(f.board.getAttribute('data-display'), 'mono');
  assert.equal(storage.map.get(CAPTION_ONLY_STORAGE_KEYS.display), 'mono');
  contrast.dispatch('click');
  assert.equal(contrast.getAttribute('aria-pressed'), 'false');
  assert.equal(f.board.getAttribute('data-display'), 'dark', 'pressing again restores the default board, it does not cycle to light');
  contrast.dispatch('click');

  // A second launch restores both the size and the contrast, and a late
  // storage handover (main.js) brings the controls with it.
  const g = setup({ storage: fakeStorage(Object.fromEntries(storage.map)) });
  assert.equal(g.get('caption-contrast').getAttribute('aria-pressed'), 'true');
  const m = setup();
  m.view.setStorage(fakeStorage({ [CAPTION_SIZE_STORAGE_KEY]: '1.875', [CAPTION_ONLY_STORAGE_KEYS.display]: 'mono' }));
  assert.equal(m.get('caption-size').textContent, '1.875rem');
  assert.equal(m.get('caption-contrast').getAttribute('aria-pressed'), 'true');
  assert.equal(m.get('caption-larger').disabled, false);
});

test('P3-18 partial captions are still separated from final ones and are never announced', () => {
  const f = setup();
  f.get('start').dispatch('click');
  const captions = [
    { id: 'c1', role: 'translation', status: 'partial', translatedText: 'coming', segmentId: 's1' },
    { id: 'c2', role: 'translation', status: 'final', translatedText: 'settled one', segmentId: 's2' },
  ];
  f.view.board.render({ captions, lang: 'ja', announceFirstFinal: true });
  const rows = all(f.b('list'), (node) => node.classes.has('sim-caption'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('data-status'), 'partial');
  assert.equal(rows[1].getAttribute('data-status'), 'final');
  // A gap is its own marker, distinct from the partial/final split.
  assert.equal(rows[0].getAttribute('data-gap-before'), 'false');
  f.view.board.render({ captions: [{ ...captions[1], gapBefore: true }], lang: 'ja' });
  assert.equal(all(f.b('list'), (node) => node.classes.has('sim-caption'))[0].getAttribute('data-gap-before'), 'true');
  const announcement = byClass(f.root, 'sim-announcement');
  assert.equal(announcement.textContent.includes('coming'), false, 'a partial token is never read out');
  assert.equal(announcement.textContent.includes('settled one'), true);
  // The size controls do not change what is announced.
  f.get('caption-larger').dispatch('click');
  assert.equal(announcement.textContent.includes('coming'), false);
});

test('P3-18 styles: the caption controls meet the touch target and the board size stacks on the app text size', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? null : css.slice(at, css.indexOf('}', at));
  };
  const controls = rule('.sim-caption-controls');
  assert.ok(controls, 'the caption controls have a rule');
  assert.match(controls, /flex-wrap:\s*wrap/, 'the row wraps at XL text instead of clipping');
  const buttons = rule('.sim-caption-smaller, .sim-caption-larger, .sim-caption-contrast');
  assert.match(buttons, /min-width:\s*var\(--touch\)/);
  assert.match(buttons, /min-height:\s*var\(--touch\)/);
  // The board keeps its own rem on top of the app-wide zoom (§1.10).
  assert.match(css, /\.sim-caption \.turn-text \{[^}]*font-size:\s*var\(--caption-size/);
  assert.match(css, /\.caption-board \{[^}]*--caption-size:/);
});
