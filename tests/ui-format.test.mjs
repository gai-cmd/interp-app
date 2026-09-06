import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createI18n, SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { checkSource } from '../scripts/check-i18n.mjs';
import { createState, MAX_TURNS, SEQ_STATUS, TURN_PHASE } from '../app/state.js';
import { ProviderError } from '../app/providers/contract.js';
import { describeTurn, errorKey, keySelectionKeys, levelPercent, NOTICE_DURATION_MS, replayOutput,
  resolveKey, statusKey, turnActions, turnKey, voiceKey } from '../app/ui/errors.js';
import { createSeqView, DESKTOP_LAYOUT_QUERY, SEQ_LAYOUTS, SOURCE_OPTIONS } from '../app/ui/seq-view.js';
import { HEADER_LAYOUT_QUERY, SETTINGS_TARGETS, SHELL_LAYOUTS, mount, TABS } from '../app/ui/shell.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await read(`app/i18n/${language}.json`))])));
const ko = dictionaries.ko;

// Minimal DOM double: only the surface the views use. innerHTML throws so any
// markup rendering of provider text fails loudly.
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set();
    this.hidden = false; this.disabled = false; this.value = ''; this.style = {}; this.text = '';
    this.classList = {
      add: (...names) => { for (const name of names) this.classes.add(name); this.syncClass(); },
      remove: (...names) => { for (const name of names) this.classes.delete(name); this.syncClass(); },
      toggle: (name, force) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); this.syncClass(); return on; },
      contains: (name) => this.classes.has(name),
    };
  }
  syncClass() { this.attributes.set('class', [...this.classes].join(' ')); }
  get children() { return this.childNodes; }
  get textContent() { return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this.text; }
  set textContent(value) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.text = String(value ?? ''); }
  get innerHTML() { throw new Error('INNER_HTML_USED'); }
  set innerHTML(_value) { throw new Error('INNER_HTML_USED'); }
  set innerText(_value) { throw new Error('INNER_TEXT_USED'); }
  set outerHTML(_value) { throw new Error('OUTER_HTML_USED'); }
  append(...nodes) { this.text = ''; for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  appendChild(node) { this.append(node); return node; }
  // Like a browser, detaching the focused subtree drops focus (P3-17 relayout must restore it).
  remove() {
    if (!this.parentNode) return;
    if (this.ownerDocument.activeElement && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'class') this.classes.clear(); }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  setPointerCapture() {}
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
}
function createDocument() {
  const doc = { title: '', activeElement: null };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('body');
  return doc;
}
function createWindow(doc) {
  const win = new FakeElement(doc, 'window');
  win.navigator = { onLine: true };
  return win;
}
const all = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes) all(child, predicate, out);
  return out;
};
const byClass = (node, name) => all(node, (item) => item.classes.has(name))[0];
const visible = (node) => { for (let item = node; item; item = item.parentNode) if (item.hidden) return false; return true; };
const clickable = (node) => visible(node) && !node.disabled;

function fakeTimers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    clearTimeout: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; },
    run() { const pending = queue.splice(0); for (const timer of pending) timer.fn?.(); return pending.filter((timer) => timer.fn).length; },
    get pending() { return queue.filter((timer) => timer.fn); },
  };
}

// Engine double on the real store so snapshots have the P1-14 shape.
function fakeEngine() {
  let clock = 0, serial = 0, recording = null;
  const state = createState({ sessionId: 'session-1', now: () => ++clock });
  const calls = [];
  // Like the real engine, a new utterance ends the previous turn first.
  const abortActive = () => { const active = state.snapshot().activeTurnId; recording = null; if (active) state.cancelTurn(active); };
  const engine = {
    state, calls, voice: { sessionOpen: false },
    startRecording() { calls.push(['startRecording']); abortActive(); const turnId = `turn-${++serial}`; state.beginTurn({ turnId, input: 'voice' }); recording = turnId; return { turnId }; },
    stopRecording() { calls.push(['stopRecording']); if (!recording) return null; const turnId = recording; recording = null; state.beginTranslating(turnId); return { turnId }; },
    submitText(text) {
      calls.push(['submitText', text]);
      if (typeof text !== 'string' || !text.trim()) throw new ProviderError('INVALID_REQUEST');
      abortActive();
      const turnId = `turn-${++serial}`;
      state.beginTurn({ turnId, input: 'text', sourceText: text.trim() });
      return { turnId };
    },
    retry(turnId) { calls.push(['retry', turnId]); abortActive(); if (!state.retryTurn(turnId)) throw new ProviderError('INVALID_REQUEST'); return { turnId }; },
    replay(turnId, options) { calls.push(['replay', turnId, options]); abortActive(); state.beginSpeaking(turnId); return { turnId }; },
    cancel() { calls.push(['cancel']); const turnId = state.snapshot().activeTurnId; recording = null; if (turnId) state.cancelTurn(turnId); },
    setInterpretation(pair) { calls.push(['setInterpretation', pair]); state.setInterpretation(pair); },
    snapshot() { return { closed: false, voice: engine.voice }; },
    complete(turnId, sourceText, translatedText, voice) {
      state.commitTranslation(turnId, { status: 'ok', sourceText, translatedText, detectedLanguage: 'ko', model: 'm' });
      if (voice) state.setVoiceResult(turnId, voice);
      state.finishTurn(turnId);
    },
  };
  return engine;
}
// MediaQueryList double: the view subscribes to 'change' and reads .matches.
function fakeMedia(matches) {
  const listeners = new Set();
  return {
    matches, media: null, queries: [],
    addEventListener(type, handler) { if (type === 'change') listeners.add(handler); },
    removeEventListener(type, handler) { if (type === 'change') listeners.delete(handler); },
    set(next) { this.matches = next; for (const handler of [...listeners]) handler({ matches: next, media: this.media }); },
    get listenerCount() { return listeners.size; },
  };
}
// media drives the sequential view (document.defaultView); headerMedia drives
// the shell header (the injected window), so each test sees one subscriber.
function harness({ language = 'ko', media = null, headerMedia = null, ...options } = {}) {
  const doc = createDocument();
  const win = createWindow(doc);
  if (media) doc.defaultView = { matchMedia(query) { media.queries.push(query); media.media = query; return media; } };
  if (headerMedia) win.matchMedia = (query) => { headerMedia.queries.push(query); headerMedia.media = query; return headerMedia; };
  const root = doc.createElement('div');
  const timers = fakeTimers();
  const engine = fakeEngine();
  const i18n = createI18n({ dictionaries, language });
  const shell = mount({ root, i18n, engine, document: doc, window: win, ...timers, ...options });
  const view = shell.seqView;
  const el = (name) => byClass(root, name);
  return { doc, win, root, timers, engine, state: engine.state, i18n, shell, view, el };
}

test('errors.js maps status, phase, error, voice and actions to safe dictionary keys', () => {
  const i18n = createI18n({ dictionaries, language: 'ko' });
  assert.equal(statusKey('recording'), 'seq.recording');
  assert.equal(statusKey('bogus'), 'seq.idle');
  const base = { turnId: 'turn-1', phase: TURN_PHASE.COMPLETED, sourceText: 'a', translatedText: 'b', voice: null };
  assert.equal(turnKey({ ...base, phase: TURN_PHASE.ERROR, messageKey: 'error.RATE_LIMITED', errorCode: 'RATE_LIMITED' }), 'error.RATE_LIMITED');
  assert.equal(turnKey({ ...base, phase: TURN_PHASE.ERROR, messageKey: undefined, errorCode: 'TIMEOUT' }), 'error.TIMEOUT');
  assert.equal(turnKey({ ...base, phase: TURN_PHASE.ERROR, messageKey: undefined, errorCode: 'bad code' }), 'error.unknown');
  assert.equal(turnKey({ ...base, phase: TURN_PHASE.SILENCE, messageKey: 'seq.silence' }), 'seq.silence');
  assert.equal(turnKey({ ...base, phase: TURN_PHASE.TRANSLATING }), 'seq.translating');
  assert.equal(turnKey(base, { activeTurnId: 'turn-1', status: SEQ_STATUS.SPEAKING }), 'seq.speaking');
  assert.equal(turnKey(base, { activeTurnId: null, status: SEQ_STATUS.IDLE }), 'seq.completed');
  assert.equal(turnKey(null), 'error.unknown');
  assert.equal(voiceKey({ voice: { status: 'partial', messageKey: 'voice.partialFailure' } }), 'voice.partialFailure');
  assert.equal(voiceKey({ voice: { status: 'completed', fallback: true } }), 'voice.fallback');
  assert.equal(voiceKey({ voice: { status: 'completed' } }), null);
  assert.equal(voiceKey({}), null);
  assert.equal(resolveKey(i18n, 'seq.idle'), 'seq.idle');
  assert.equal(resolveKey(i18n, 'not.a.key'), 'error.unknown');
  assert.equal(resolveKey(i18n, 'SECRET-KEY-VALUE', 'records.off'), 'records.off');
  assert.equal(resolveKey(i18n, '__proto__.x'), 'error.unknown');
  assert.equal(errorKey(new ProviderError('SESSION_CLOSED')), 'error.SESSION_CLOSED');
  assert.equal(errorKey(new Error('SECRET')), 'error.PROVIDER_ERROR');
  assert.equal(errorKey(null), 'error.PROVIDER_ERROR');
  assert.deepEqual(keySelectionKeys(null), { providerKey: null, modeKey: 'settings.noKey' });
  assert.deepEqual(keySelectionKeys({ providerId: 'gemini', keySource: 'shared' }), { providerKey: 'providers.gemini', modeKey: 'mode.shared' });
  const idle = { activeTurnId: null, status: SEQ_STATUS.IDLE, voice: { output: 'provider' } };
  assert.deepEqual(turnActions(base, idle), { retry: false, play: true, deviceReplay: false, stopPlayback: false });
  assert.deepEqual(turnActions({ ...base, voice: { deviceFallbackAvailable: true } }, idle),
    { retry: false, play: true, deviceReplay: true, stopPlayback: false });
  assert.deepEqual(turnActions({ ...base, voice: { deviceFallbackAvailable: true } }, { ...idle, voice: { output: 'device' } }),
    { retry: false, play: true, deviceReplay: false, stopPlayback: false });
  assert.deepEqual(turnActions(base, { ...idle, voice: { output: 'off' } }), { retry: false, play: false, deviceReplay: false, stopPlayback: false });
  assert.deepEqual(turnActions(base, { activeTurnId: 'turn-1', status: SEQ_STATUS.SPEAKING, voice: { output: 'provider' } }),
    { retry: false, play: false, deviceReplay: false, stopPlayback: true });
  assert.deepEqual(turnActions({ ...base, phase: TURN_PHASE.ERROR }, idle), { retry: true, play: false, deviceReplay: false, stopPlayback: false });
  assert.deepEqual(turnActions({ ...base, phase: TURN_PHASE.UNRECOGNIZED, sourceText: '' }, idle).retry, false);
  assert.deepEqual(turnActions({ ...base, phase: TURN_PHASE.TRANSLATING }, { ...idle, activeTurnId: 'turn-1' }).retry, false);
  assert.equal(replayOutput({ voice: { output: 'provider' } }), 'provider');
  assert.equal(replayOutput({ voice: { output: 'off' } }), 'device');
  assert.equal(levelPercent({ rms: 0.125 }), 50);
  assert.equal(levelPercent({ rms: 9 }), 100);
  assert.equal(levelPercent({ rms: -1 }), 0);
  assert.equal(levelPercent({ rms: Number.NaN }), 0);
  assert.equal(levelPercent(undefined), 0);
  const described = describeTurn(i18n, { ...base, phase: TURN_PHASE.ERROR, messageKey: 'nope.key', sourceText: '<b>x</b>', translatedText: null }, idle);
  assert.equal(described.statusKey, 'error.unknown');
  assert.equal(described.sourceText, '<b>x</b>');
  assert.equal(described.translatedText, '');
  assert.equal(Object.isFrozen(described), true);
  assert.deepEqual(SOURCE_OPTIONS, ['auto', 'ko', 'en', 'ja']);
  assert.deepEqual(TABS, ['sequential', 'simultaneous']);
});

test('index.html and styles.css are static, i18n-clean and sized for touch and zoom', async () => {
  const html = await read('index.html');
  assert.deepEqual(checkSource(html, dictionaries.en, { html: true }), []);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1[^"]*">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title><\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css">/);
  assert.match(html, /<script type="module" src="\.\/app\/main\.js"><\/script>/);
  assert.match(html, /<div id="app"/);
  // P3-13 (design-p3 §1.10, §4.2): the only classic script is the synchronous appearance boot, placed before the stylesheet.
  assert.deepEqual([...html.matchAll(/<script(?![^>]*type="module")[^>]*>/g)].map((match) => match[0]), ['<script src="./app/ui/appearance-boot.js">']);
  assert.ok(html.indexOf('<script src="./app/ui/appearance-boot.js">') < html.indexOf('<link rel="stylesheet"'));
  assert.equal(/https?:\/\//.test(html), false);
  const css = await read('styles.css');
  assert.match(css, /--touch: 44px/);
  assert.match(css, /\.btn \{[^}]*min-height: var\(--touch\)[^}]*min-width: var\(--touch\)/s);
  assert.match(css, /\.shell-tab \{[^}]*min-height: var\(--touch\)/s);
  assert.match(css, /select, textarea \{[^}]*min-height: var\(--touch\)/s);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /\.seq-ptt \{[^}]*touch-action: none/s);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.equal(/font-size:\s*\d+px/.test(css), false);
  assert.equal(/https?:\/\/|@import|url\(/.test(css), false);
});

test('ui sources use only existing dictionary keys and never assign literal UI text', async () => {
  const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
  for (const file of ['app/ui/shell.js', 'app/ui/seq-view.js', 'app/ui/errors.js']) {
    const source = await read(file);
    assert.deepEqual(checkSource(source, dictionaries.en), [], file);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|innerText|createContextualFragment/.test(source), false, file);
    assert.equal(/\bDOMParser\b|document\.write|\beval\(/.test(source), false, file);
    const literals = [...source.matchAll(/(['"`])([^'"`\r\n]+)\1/g)].map((match) => match[2]).filter((value) => keyPattern.test(value));
    assert.ok(literals.length > 0, file);
    for (const key of literals) assert.ok(Object.hasOwn(dictionaries.en, key), `${file}: ${key}`);
  }
  const shellSource = await read('app/ui/shell.js');
  for (const prefix of ['tabs.', 'language.', 'providers.']) {
    assert.ok(shellSource.includes(prefix) || (await read('app/ui/seq-view.js')).includes(prefix) || (await read('app/ui/errors.js')).includes(prefix), prefix);
  }
  for (const tab of TABS) assert.ok(Object.hasOwn(dictionaries.en, `tabs.${tab}`));
  for (const language of SOURCE_OPTIONS) assert.ok(Object.hasOwn(dictionaries.en, `language.${language}`));
});

test('mount builds the shell in three languages, shows key badges and manages the settings dialog', () => {
  const h = harness();
  assert.equal(h.doc.title, ko['app.name']);
  assert.equal(h.doc.documentElement.getAttribute('lang'), 'ko');
  assert.equal(byClass(h.root, 'shell-title').textContent, ko['app.name']);
  assert.equal(h.shell.elements.tabButtons.sequential.textContent, ko['tabs.sequential']);
  // P3-02e: simultaneous interpretation is the first screen by default.
  assert.equal(h.shell.elements.tabButtons.simultaneous.getAttribute('aria-selected'), 'true');
  assert.equal(h.shell.elements.panels.sequential.hidden, true);
  assert.equal(h.shell.elements.panels.simultaneous.hidden, false);
  assert.equal(h.shell.elements.panels.settings.hidden, true);
  assert.equal(h.shell.elements.modeBadge.textContent, ko['settings.noKey']);
  assert.equal(h.shell.elements.providerBadge.hidden, true);
  assert.equal(byClass(h.root, 'seq-ptt').textContent, ko['seq.holdToTalk']);
  assert.equal(byClass(h.root, 'seq-text').getAttribute('placeholder'), ko['seq.textPlaceholder']);
  assert.equal(byClass(h.root, 'seq-text').getAttribute('maxlength'), '4000');
  assert.equal(byClass(h.root, 'seq-hint').textContent, ko['seq.recordingLimit'].replace('{seconds}', '30'));
  assert.equal(byClass(h.root, 'seq-records-status').textContent, ko['records.off']);
  assert.equal(byClass(h.root, 'seq-empty').hidden, false);
  for (const region of ['seq-status', 'shell-notice', 'shell-message', 'shell-connection']) {
    assert.equal(byClass(h.root, region).getAttribute('aria-live'), 'polite', region);
  }
  assert.equal(byClass(h.root, 'seq-turns').getAttribute('role'), 'log');
  assert.equal(byClass(h.root, 'seq-level').getAttribute('role'), 'meter');

  h.state.setKeySelection({ providerId: 'gemini', keySource: 'shared' });
  assert.equal(h.shell.elements.providerBadge.hidden, false);
  assert.equal(h.shell.elements.providerBadge.textContent, ko['providers.gemini']);
  assert.equal(h.shell.elements.modeBadge.textContent, ko['mode.shared']);
  h.state.setKeySelection({ providerId: 'other', keySource: 'personal' });
  assert.equal(h.shell.elements.providerBadge.textContent, ko['common.unknown']);
  assert.equal(h.shell.elements.modeBadge.textContent, ko['mode.personal']);

  const languages = [];
  const stopListening = h.shell.onLanguageChange((language) => languages.push(language));
  assert.throws(() => h.shell.onLanguageChange(null), { message: 'INVALID_REQUEST' });
  for (const language of ['en', 'ja', 'ko']) {
    assert.equal(h.shell.setLanguage(`${language}-XX`), language);
    assert.equal(languages.at(-1), language);
    const dictionary = dictionaries[language];
    assert.equal(h.doc.title, dictionary['app.name']);
    assert.equal(h.doc.documentElement.getAttribute('lang'), language);
    assert.equal(h.shell.elements.tabButtons.simultaneous.textContent, dictionary['tabs.simultaneous']);
    assert.equal(byClass(h.root, 'seq-ptt').textContent, dictionary['seq.holdToTalk']);
    assert.equal(byClass(h.root, 'seq-text').getAttribute('placeholder'), dictionary['seq.textPlaceholder']);
    assert.equal(byClass(h.root, 'seq-status').textContent, dictionary['seq.idle']);
    assert.equal(h.shell.elements.modeBadge.textContent, dictionary['mode.personal']);
    assert.equal(byClass(h.root, 'seq-level').getAttribute('aria-label'), dictionary['seq.inputLevel']);
  }
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'ja' });
  stopListening();
  h.shell.setLanguage('en');
  assert.deepEqual(languages, ['en', 'ja', 'ko']);
  h.shell.setLanguage('ko');

  const button = h.shell.elements.settingsButton;
  button.focus();
  button.dispatch('click');
  assert.equal(h.shell.settingsOpen, true);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(h.shell.elements.panels.settings.getAttribute('role'), 'dialog');
  assert.equal(h.doc.activeElement, h.shell.elements.panels.settingsClose);
  assert.equal(byClass(h.root, 'shell-main').hasAttribute('inert'), true);
  assert.equal(h.shell.elements.panels.settingsBody.childNodes.length, 0);
  h.shell.elements.panels.settings.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.shell.settingsOpen, false);
  assert.equal(byClass(h.root, 'shell-main').hasAttribute('inert'), false);
  assert.equal(h.doc.activeElement, button);
  h.shell.openSettings();
  h.shell.elements.panels.settingsClose.dispatch('click');
  assert.equal(h.shell.settingsOpen, false);
  assert.deepEqual(h.engine.calls, []);
});

test('the simultaneous tab is enabled without starting work; selectTab stays synchronous', () => {
  const h = harness();
  const tab = h.shell.elements.tabButtons.simultaneous;
  assert.equal(tab.getAttribute('aria-disabled'), null);
  tab.dispatch('click');
  assert.equal(h.shell.selectedTab, 'simultaneous');
  assert.equal(h.shell.elements.panels.simultaneous.hidden, false);
  assert.equal(h.shell.elements.panels.sequential.hidden, true);
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(h.shell.selectTab('sequential'), 'sequential');
  assert.equal(h.shell.selectTab('bogus'), 'sequential');
  h.shell.elements.tabButtons.sequential.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.doc.activeElement, tab);
  assert.deepEqual(h.engine.calls, []);
  h.shell.destroy();
});

test('tab cleanup is awaited, reselection discards late results, and failed cleanup keeps the current panel', async () => {
  const pending = [];
  // P3-02e: the default tab moved to simultaneous; this test switches away from a remembered sequential tab.
  const h = harness({ initialTab: 'sequential', beforeTabChange: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  assert.equal(h.shell.selectTab('simultaneous'), 'sequential');
  assert.equal(h.shell.selectedTab, 'sequential');
  // Selecting the current panel withdraws the pending navigation.
  assert.equal(h.shell.selectTab('sequential'), 'sequential');
  pending.shift().resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.shell.selectedTab, 'sequential');
  const failed = h.shell.switchTab('simultaneous');
  pending.shift().reject(new Error('SECRET'));
  await failed;
  assert.equal(h.shell.selectedTab, 'sequential');
  assert.equal(h.shell.elements.message.textContent, ko['error.SESSION_CLOSED']);
  const switched = h.shell.switchTab('simultaneous');
  pending.shift().resolve();
  assert.equal(await switched, 'simultaneous');
  assert.equal(h.doc.activeElement, h.shell.elements.tabButtons.simultaneous);
  const late = h.shell.switchTab('sequential');
  h.shell.destroy();
  pending.shift().resolve();
  assert.equal(await late, 'simultaneous');
  assert.equal(h.root.childNodes.length, 0);
});

test('store notices are displayed, then cleared by the UI through setNotice(null)', () => {
  const h = harness();
  const notice = h.shell.elements.notice;
  assert.equal(notice.hidden, true);
  h.state.setNotice('mode.changed');
  assert.equal(notice.hidden, false);
  assert.equal(byClass(h.root, 'shell-notice-text').textContent, ko['mode.changed']);
  assert.equal(h.timers.pending.length, 1);
  assert.equal(h.timers.pending[0].ms, NOTICE_DURATION_MS);
  h.timers.run();
  assert.equal(h.state.snapshot().notice, null);
  assert.equal(notice.hidden, true);
  h.state.setNotice('records.cleared');
  h.shell.elements.noticeClose.dispatch('click');
  assert.equal(h.state.snapshot().notice, null);
  assert.equal(notice.hidden, true);
  assert.equal(h.timers.pending.length, 0);
  h.state.setNotice('error.RATE_LIMITED');
  h.state.setKeySelection(null);
  assert.equal(h.timers.pending.length, 1, 'a re-render does not re-arm the timer');
  assert.equal(byClass(h.root, 'shell-notice-text').textContent, ko['error.RATE_LIMITED']);
});

test('push-to-talk and the start/finish alternative call the engine synchronously from gestures', () => {
  const h = harness();
  const ptt = byClass(h.root, 'seq-ptt');
  const toggle = byClass(h.root, 'seq-toggle');
  const status = byClass(h.root, 'seq-status');
  const meter = byClass(h.root, 'seq-level');
  const hint = byClass(h.root, 'seq-hint');
  assert.equal(toggle.textContent, ko['seq.startRecording']);
  const down = ptt.dispatch('pointerdown', { button: 0, pointerId: 7 });
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(h.engine.calls, [['startRecording']]);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.RECORDING);
  assert.equal(ptt.getAttribute('aria-pressed'), 'true');
  assert.equal(status.textContent, ko['seq.recording']);
  assert.equal(toggle.textContent, ko['seq.stopRecording']);
  assert.equal(byClass(h.root, 'seq-cancel').hidden, true);
  h.view.onLevel({ rms: 0.125, messageKey: 'seq.inputLevel' });
  assert.equal(meter.getAttribute('aria-valuenow'), '50');
  assert.equal(byClass(h.root, 'seq-level-bar').style.width, '50%');
  h.view.onWarning({ messageKey: 'seq.recordingEnding' });
  assert.equal(hint.textContent, ko['seq.recordingEnding']);
  ptt.dispatch('pointerup', { pointerId: 99 });
  assert.equal(h.engine.calls.length, 1, 'another pointer does not release the hold');
  ptt.dispatch('pointerup', { pointerId: 7 });
  assert.deepEqual(h.engine.calls, [['startRecording'], ['stopRecording']]);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.equal(ptt.getAttribute('aria-pressed'), 'false');
  assert.equal(meter.getAttribute('aria-valuenow'), '0');
  assert.equal(hint.textContent, ko['seq.recordingLimit'].replace('{seconds}', '30'));
  assert.equal(byClass(h.root, 'seq-cancel').hidden, false);
  h.view.onLevel({ rms: 0.2 });
  assert.equal(meter.getAttribute('aria-valuenow'), '0', 'levels are ignored outside recording');
  byClass(h.root, 'seq-cancel').dispatch('click');
  assert.deepEqual(h.engine.calls.at(-1), ['cancel']);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(byClass(h.root, 'turn-status').textContent, ko['seq.cancelled']);

  h.engine.calls.length = 0;
  ptt.dispatch('keydown', { key: ' ' });
  ptt.dispatch('keydown', { key: ' ', repeat: true });
  assert.deepEqual(h.engine.calls, [['startRecording']]);
  ptt.dispatch('keyup', { key: ' ' });
  assert.deepEqual(h.engine.calls, [['startRecording'], ['stopRecording']]);
  h.engine.cancel();
  h.engine.calls.length = 0;
  ptt.dispatch('keydown', { key: 'Enter' });
  ptt.dispatch('blur');
  assert.deepEqual(h.engine.calls, [['startRecording'], ['stopRecording']]);
  h.engine.cancel();
  h.engine.calls.length = 0;
  toggle.dispatch('click');
  assert.deepEqual(h.engine.calls, [['startRecording']]);
  assert.equal(toggle.textContent, ko['seq.stopRecording']);
  ptt.dispatch('blur');
  assert.equal(h.engine.calls.length, 1, 'blur without a keyboard hold does not stop a toggled recording');
  toggle.dispatch('click');
  assert.deepEqual(h.engine.calls, [['startRecording'], ['stopRecording']]);
  h.engine.cancel();
  h.engine.calls.length = 0;
  ptt.dispatch('pointerdown', { button: 2, pointerId: 1 });
  assert.deepEqual(h.engine.calls, []);
  assert.equal(ptt.dispatch('contextmenu').defaultPrevented, true);
});

test('text input submits from the form, clears on success and turns engine errors into notices', () => {
  const h = harness();
  const textarea = byClass(h.root, 'seq-text');
  const form = byClass(h.root, 'seq-form');
  textarea.value = '   ';
  form.dispatch('submit');
  assert.deepEqual(h.engine.calls, []);
  assert.equal(h.doc.activeElement, textarea);
  textarea.value = '  사과 12개  ';
  const submit = form.dispatch('submit');
  assert.equal(submit.defaultPrevented, true);
  assert.deepEqual(h.engine.calls, [['submitText', '  사과 12개  ']]);
  assert.equal(textarea.value, '');
  assert.equal(h.state.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.equal(byClass(h.root, 'seq-empty').hidden, true);
  assert.equal(byClass(h.root, 'turn-status').textContent, ko['seq.translating']);
  assert.equal(byClass(h.root, 'seq-clear').disabled, true);
  textarea.value = 'again';
  textarea.dispatch('keydown', { key: 'Enter', ctrlKey: true });
  assert.deepEqual(h.engine.calls.at(-1), ['submitText', 'again']);
  textarea.value = 'plain enter';
  textarea.dispatch('keydown', { key: 'Enter' });
  assert.equal(h.engine.calls.length, 2);
  h.engine.submitText = () => { throw new ProviderError('SESSION_CLOSED'); };
  textarea.value = 'closed';
  form.dispatch('submit');
  assert.equal(textarea.value, 'closed');
  assert.equal(h.state.snapshot().notice.messageKey, 'error.SESSION_CLOSED');
  assert.equal(byClass(h.root, 'shell-notice-text').textContent, ko['error.SESSION_CLOSED']);
  h.engine.submitText = () => { throw new Error('SECRET-DETAIL'); };
  form.dispatch('submit');
  assert.equal(h.state.snapshot().notice.messageKey, 'error.PROVIDER_ERROR');
  assert.equal(JSON.stringify(h.state.snapshot()).includes('SECRET'), false);
});

test('bubbles render provider text with textContent and offer retry, play, device re-read and stop', () => {
  // P3-02e: bubbles live on the sequential panel, which is no longer the default tab.
  const h = harness({ initialTab: 'sequential' });
  const { turnId } = h.engine.submitText('<script>alert(1)</script> & "quotes"');
  const turn = () => byClass(h.root, 'turn');
  assert.equal(turn().getAttribute('data-turn-id'), turnId);
  assert.equal(byClass(turn(), 'turn-source').childNodes[1].textContent, '<script>alert(1)</script> & "quotes"');
  assert.equal(byClass(turn(), 'turn-source').childNodes[1].getAttribute('lang'), 'ko');
  assert.equal(byClass(turn(), 'turn-label').textContent, ko['seq.original']);
  h.state.failTurn(turnId, { errorCode: 'RATE_LIMITED' });
  h.state.finishTurn(turnId);
  assert.equal(turn().getAttribute('data-phase'), 'error');
  assert.equal(byClass(turn(), 'turn-status').textContent, ko['error.RATE_LIMITED']);
  const retry = byClass(turn(), 'turn-retry');
  assert.equal(clickable(retry), true);
  assert.equal(retry.textContent, ko['common.retry']);
  assert.equal(visible(byClass(turn(), 'turn-play')), false);
  retry.dispatch('click');
  assert.deepEqual(h.engine.calls.at(-1), ['retry', turnId]);
  assert.equal(byClass(turn(), 'turn-status').textContent, ko['seq.translating']);
  assert.equal(visible(retry), false);
  assert.equal(all(h.root, (node) => node.classes.has('turn')).length, 1, 'retry never duplicates a bubble');

  h.engine.complete(turnId, '사과 12개', '<img src=x onerror=alert(1)>りんご12個',
    { status: 'partial', messageKey: 'voice.partialFailure', errorCode: null, deviceFallbackAvailable: true, gap: true });
  const translation = byClass(turn(), 'turn-text-translation');
  assert.equal(translation.textContent, '<img src=x onerror=alert(1)>りんご12個');
  assert.equal(translation.getAttribute('lang'), 'ja');
  assert.equal(byClass(turn(), 'turn-status').textContent, ko['seq.completed']);
  assert.equal(byClass(turn(), 'turn-voice').textContent, ko['voice.partialFailure']);
  assert.equal(byClass(turn(), 'turn-time').hasAttribute('datetime'), true);
  const device = byClass(turn(), 'turn-device');
  assert.equal(clickable(device), true);
  assert.equal(device.textContent, ko['seq.replayDevice']);
  device.dispatch('click');
  assert.deepEqual(h.engine.calls.at(-1), ['replay', turnId, { output: 'device' }]);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.SPEAKING);
  assert.equal(byClass(turn(), 'turn-status').textContent, ko['seq.speaking']);
  assert.equal(turn().classes.has('turn-active'), true);
  const stop = byClass(turn(), 'turn-stop');
  assert.equal(clickable(stop), true);
  assert.equal(visible(device), false);
  assert.equal(visible(byClass(turn(), 'turn-play')), false);
  stop.dispatch('click');
  assert.deepEqual(h.engine.calls.at(-1), ['cancel']);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  assert.equal(translation.textContent, '<img src=x onerror=alert(1)>りんご12個', 'cancelling playback keeps captions');
  const play = byClass(turn(), 'turn-play');
  assert.equal(clickable(play), true);
  assert.equal(play.textContent, ko['seq.play']);
  play.dispatch('click');
  assert.deepEqual(h.engine.calls.at(-1), ['replay', turnId, { output: 'provider' }]);
  h.engine.cancel();
  h.state.setVoice({ output: 'device' });
  assert.equal(visible(byClass(turn(), 'turn-device')), false, 'device button is redundant when device output is selected');
  play.dispatch('click');
  assert.deepEqual(h.engine.calls.at(-1), ['replay', turnId, { output: 'device' }]);
  h.engine.cancel();
  h.state.setVoice({ output: 'off' });
  assert.equal(visible(play), false);
  assert.equal(visible(byClass(turn(), 'turn-device')), true);
  assert.equal(JSON.stringify(h.engine.calls).includes('SECRET'), false);
});

test('the DOM stays bounded to MAX_TURNS during a long session and follows the store order', () => {
  const h = harness();
  const list = byClass(h.root, 'seq-turns');
  for (let index = 0; index < MAX_TURNS + 50; index++) {
    const { turnId } = h.engine.submitText(`line ${index}`);
    h.engine.complete(turnId, `line ${index}`, `translated ${index}`);
  }
  assert.equal(h.state.snapshot().turns.length, MAX_TURNS);
  assert.equal(list.childNodes.length, MAX_TURNS);
  assert.deepEqual(list.childNodes.map((node) => node.getAttribute('data-turn-id')), h.state.snapshot().turns.map((turn) => turn.turnId));
  assert.equal(list.childNodes[0].getAttribute('data-turn-id'), 'turn-51');
  assert.equal(byClass(list.childNodes.at(-1), 'turn-text-translation').textContent, `translated ${MAX_TURNS + 49}`);
  assert.equal(all(h.root, (node) => node.classes.has('turn')).length, MAX_TURNS);
});

test('language pair controls keep source and target distinct, swap, and stay independent of the UI language', () => {
  const h = harness({ language: 'en' });
  const source = byClass(h.root, 'seq-swap').parentNode.childNodes[1];
  const target = byClass(h.root, 'seq-swap').parentNode.childNodes[4];
  assert.equal(source.getAttribute('id'), 'seq-source');
  assert.equal(target.getAttribute('id'), 'seq-target');
  assert.equal(source.value, 'ko');
  assert.equal(target.value, 'ja');
  assert.deepEqual(source.childNodes.map((option) => option.getAttribute('value')), ['auto', 'ko', 'en', 'ja']);
  assert.equal(source.childNodes[0].textContent, dictionaries.en['language.auto']);
  target.value = 'ko';
  target.dispatch('change');
  assert.deepEqual(h.engine.calls.at(-1), ['setInterpretation', { sourceLanguage: 'ja', targetLanguage: 'ko' }]);
  assert.equal(source.value, 'ja');
  source.value = 'ko';
  source.dispatch('change');
  assert.deepEqual(h.engine.calls.at(-1), ['setInterpretation', { sourceLanguage: 'ko', targetLanguage: 'ja' }]);
  byClass(h.root, 'seq-swap').dispatch('click');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ja', targetLanguage: 'ko' });
  source.value = 'auto';
  source.dispatch('change');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'auto', targetLanguage: 'ko' });
  byClass(h.root, 'seq-swap').dispatch('click');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'en' }, 'auto swaps to the UI language');
  h.shell.setLanguage('ja');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'en' });
  assert.equal(source.childNodes[0].textContent, dictionaries.ja['language.auto']);
  h.engine.setInterpretation = () => { throw new ProviderError('SESSION_CLOSED'); };
  target.value = 'ja';
  target.dispatch('change');
  assert.equal(target.value, 'en', 'a rejected change reverts to the store');
  assert.equal(h.state.snapshot().notice.messageKey, 'error.SESSION_CLOSED');
});

test('clearing the conversation needs confirmation and is blocked while a turn is active', () => {
  const h = harness();
  const clear = byClass(h.root, 'seq-clear');
  const confirm = byClass(h.root, 'seq-confirm');
  assert.equal(clear.disabled, true);
  const { turnId } = h.engine.submitText('hello');
  assert.equal(clear.disabled, true);
  h.engine.complete(turnId, 'hello', '안녕');
  assert.equal(clear.disabled, false);
  assert.equal(confirm.hidden, true);
  clear.dispatch('click');
  assert.equal(confirm.hidden, false);
  assert.equal(clear.getAttribute('aria-expanded'), 'true');
  assert.equal(byClass(confirm, 'seq-confirm-text').textContent, ko['records.clearConfirm']);
  confirm.childNodes[2].dispatch('click');
  assert.equal(confirm.hidden, true);
  assert.equal(h.state.snapshot().turns.length, 1);
  clear.dispatch('click');
  h.engine.submitText('busy');
  assert.equal(confirm.hidden, true, 'an active turn closes the confirmation');
  assert.equal(clear.disabled, true);
  h.engine.cancel();
  clear.dispatch('click');
  confirm.childNodes[1].dispatch('click');
  assert.equal(h.state.snapshot().turns.length, 0);
  assert.equal(h.state.snapshot().notice.messageKey, 'records.cleared');
  assert.equal(byClass(h.root, 'seq-empty').hidden, false);
  assert.equal(all(h.root, (node) => node.classes.has('turn')).length, 0);
});

test('connection badge follows offline events and Live session state; pagehide cancels; destroy detaches', () => {
  const h = harness();
  const badge = h.shell.elements.connectionBadge;
  assert.equal(badge.hidden, true);
  h.win.navigator.onLine = false;
  h.win.dispatch('offline');
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, ko['connection.offline']);
  h.win.navigator.onLine = true;
  h.win.dispatch('online');
  assert.equal(badge.hidden, true);
  h.engine.voice.sessionOpen = true;
  h.shell.render();
  assert.equal(badge.textContent, ko['connection.connected']);
  h.engine.submitText('x');
  h.win.dispatch('pagehide');
  assert.deepEqual(h.engine.calls.at(-1), ['cancel']);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.IDLE);
  assert.throws(() => mount({ root: h.root, i18n: h.i18n, engine: {} , document: h.doc }), { message: 'INVALID_REQUEST' });
  assert.throws(() => createSeqView({ root: h.root, i18n: h.i18n, document: h.doc }), { message: 'INVALID_REQUEST' });
  h.shell.destroy();
  assert.equal(h.root.childNodes.length, 0);
  h.state.setNotice('mode.changed');
  h.win.dispatch('pagehide');
  assert.equal(h.engine.calls.at(-1)[0], 'cancel', 'no listener runs after destroy');
  assert.equal(h.engine.calls.filter((call) => call[0] === 'cancel').length, 1);
  assert.equal(h.timers.pending.length, 0);
});

// --- P3-17: responsive sequential screen (design-p3 §1.9, DESIGN.md §4, §5, §8) ---

const classNames = (node) => node.childNodes.map((child) => [...child.classes].join(' '));
const focusableIds = (node) => all(node, (item) => ['BUTTON', 'SELECT', 'TEXTAREA'].includes(item.tagName) && visible(item))
  .map((item) => item.getAttribute('id') ?? [...item.classes].at(-1));

test('P3-17 stacked layout: DOM order is pair, transcript, dock and the dock holds status, PTT, start/finish, hint and form', () => {
  const h = harness({ initialTab: 'sequential' });
  const seq = h.view.element;
  assert.equal(h.view.layout, SEQ_LAYOUTS.STACKED);
  assert.equal(seq.getAttribute('data-layout'), 'stacked');
  assert.deepEqual(classNames(seq), ['seq-pair', 'seq-transcript', 'seq-dock']);
  const transcript = byClass(seq, 'seq-transcript');
  assert.deepEqual(classNames(transcript), ['seq-records', 'seq-empty', 'seq-turns']);
  const dock = byClass(seq, 'seq-dock');
  assert.deepEqual(classNames(dock), ['seq-status-row', 'seq-controls', 'seq-hint', 'seq-form']);
  assert.deepEqual(classNames(byClass(dock, 'seq-controls')), ['btn btn-primary seq-ptt', 'btn btn-secondary seq-toggle', 'btn btn-secondary seq-cancel']);
  // Text form: label, textarea, send, hint. The send button precedes the hint as on screen.
  assert.deepEqual(classNames(byClass(dock, 'seq-form')), ['sr-only', 'seq-text', 'btn btn-primary seq-submit', 'seq-hint']);
  assert.equal(byClass(dock, 'seq-text').getAttribute('aria-describedby'), 'seq-submit-hint');
  // Focus order in the stacked layout equals source order: selects/swap, transcript buttons, PTT, toggle, textarea, send.
  assert.deepEqual(focusableIds(seq), ['seq-source', 'seq-swap', 'seq-target', 'seq-clear', 'seq-ptt', 'seq-toggle', 'seq-text', 'seq-submit']);
  // No matchMedia (no window): the stacked order stands and the view still destroys cleanly.
  assert.equal(h.doc.defaultView, undefined);
  h.shell.destroy();
  assert.equal(h.root.childNodes.length, 0);
});

test('P3-17 desktop layout: the 64rem media query moves pair and dock into a 24rem column before the transcript, and back, keeping focus', () => {
  const media = fakeMedia(true);
  const h = harness({ initialTab: 'sequential', media });
  assert.deepEqual(media.queries, [DESKTOP_LAYOUT_QUERY]);
  assert.equal(DESKTOP_LAYOUT_QUERY, '(min-width: 64rem)');
  assert.equal(media.listenerCount, 1);
  const seq = h.view.element;
  assert.equal(h.view.layout, SEQ_LAYOUTS.DESKTOP);
  assert.equal(seq.getAttribute('data-layout'), 'desktop');
  assert.deepEqual(classNames(seq), ['seq-column', 'seq-transcript']);
  assert.deepEqual(classNames(byClass(seq, 'seq-column')), ['seq-pair', 'seq-dock']);
  assert.deepEqual(classNames(byClass(seq, 'seq-dock')), ['seq-status-row', 'seq-controls', 'seq-hint', 'seq-form']);
  // Source order on desktop = left column top to bottom, then the transcript on the right.
  assert.deepEqual(focusableIds(seq), ['seq-source', 'seq-swap', 'seq-target', 'seq-ptt', 'seq-toggle', 'seq-text', 'seq-submit', 'seq-clear']);

  // The screen keeps working after the move: PTT, text and bubbles all render in place.
  const ptt = byClass(seq, 'seq-ptt');
  ptt.dispatch('pointerdown', { button: 0, pointerId: 1 });
  assert.equal(ptt.textContent, ko['seq.recording']);
  assert.equal(byClass(seq, 'seq-status').getAttribute('data-state'), 'recording');
  ptt.dispatch('pointerup', { pointerId: 1 });
  assert.equal(ptt.textContent, ko['seq.holdToTalk']);
  assert.equal(byClass(seq, 'seq-status').getAttribute('data-state'), null);
  h.engine.cancel();
  const { turnId } = h.engine.submitText('hello');
  h.engine.complete(turnId, 'hello', 'こんにちは');
  assert.equal(byClass(seq, 'seq-transcript').contains(byClass(seq, 'turn')), true);

  // Narrowing below 64rem restores the stacked order; a focused PTT stays focused across the move.
  ptt.focus();
  media.set(false);
  assert.equal(h.view.layout, SEQ_LAYOUTS.STACKED);
  assert.deepEqual(classNames(seq), ['seq-pair', 'seq-transcript', 'seq-dock']);
  assert.equal(h.doc.activeElement, ptt);
  assert.equal(all(h.root, (node) => node.classes.has('seq-column')).length, 0, 'the column wrapper leaves the DOM');
  assert.equal(all(h.root, (node) => node.classes.has('turn')).length, 2, 'bubbles (cancelled PTT turn + text turn) survive the relayout');
  // The same state again is a no-op; widening moves the nodes back once.
  media.set(false);
  assert.deepEqual(classNames(seq), ['seq-pair', 'seq-transcript', 'seq-dock']);
  byClass(seq, 'seq-text').focus();
  media.set(true);
  assert.deepEqual(classNames(seq), ['seq-column', 'seq-transcript']);
  assert.equal(h.doc.activeElement, byClass(seq, 'seq-text'));
  assert.equal(h.engine.calls.filter((call) => call[0] === 'startRecording').length, 1, 'relayout never touches the engine');
  h.shell.destroy();
  assert.equal(media.listenerCount, 0, 'destroy removes the media listener');
});

test('P3-17 PTT label, status attribute and bubble meta (time, status, engine, elapsed) in three languages', () => {
  const h = harness({ initialTab: 'sequential' });
  const ptt = byClass(h.root, 'seq-ptt');
  const status = byClass(h.root, 'seq-status');
  ptt.dispatch('keydown', { key: ' ' });
  assert.equal(ptt.getAttribute('aria-pressed'), 'true');
  assert.equal(ptt.textContent, ko['seq.recording']);
  assert.equal(status.getAttribute('data-state'), 'recording');
  h.shell.setLanguage('ja');
  assert.equal(ptt.textContent, dictionaries.ja['seq.recording'], 'a language change keeps the pressed label');
  ptt.dispatch('keyup', { key: ' ' });
  assert.equal(ptt.textContent, dictionaries.ja['seq.holdToTalk']);
  assert.equal(status.getAttribute('data-state'), null);
  h.shell.setLanguage('ko');
  h.engine.cancel();

  const { turnId } = h.engine.submitText('사과 12개');
  const bubble = (id) => all(h.root, (node) => node.getAttribute('data-turn-id') === id)[0];
  const meta = bubble(turnId).childNodes[0];
  assert.deepEqual(classNames(meta), ['turn-time', 'badge turn-status', 'turn-engine mono', 'turn-latency']);
  assert.equal(meta.childNodes[1].textContent, ko['seq.translating']);
  assert.equal(meta.childNodes[2].hidden, true, 'no engine before the result');
  assert.equal(meta.childNodes[3].hidden, true, 'no elapsed time before the turn ends');
  h.engine.complete(turnId, '사과 12개', '12 apples');
  assert.equal(meta.childNodes[2].hidden, false);
  assert.equal(meta.childNodes[2].textContent, 'm', 'the engine is the model name from the store');
  // The engine double finishes the turn on complete(), so endedAt is set and the elapsed time appears.
  const stored = h.state.snapshot().turns.find((item) => item.turnId === turnId);
  assert.equal(typeof stored.endedAt, 'number');
  assert.equal(meta.childNodes[3].hidden, false);
  assert.equal(meta.childNodes[3].textContent, h.i18n.formatNumber((stored.endedAt - stored.createdAt) / 1000,
    { style: 'unit', unit: 'second', unitDisplay: 'narrow', maximumFractionDigits: 1 }));
  assert.match(meta.childNodes[3].textContent, /\d/);
  const failed = h.engine.submitText('again');
  h.state.failTurn(failed.turnId, { errorCode: 'RATE_LIMITED' });
  h.state.finishTurn(failed.turnId);
  const failedMeta = bubble(failed.turnId).childNodes[0];
  assert.equal(failedMeta.childNodes[1].getAttribute('data-state'), 'error');
  assert.equal(failedMeta.childNodes[2].hidden, true);
  assert.equal(meta.childNodes[1].getAttribute('data-state'), null);
  for (const language of ['en', 'ja']) {
    h.shell.setLanguage(language);
    assert.equal(meta.childNodes[1].textContent, dictionaries[language]['seq.completed']);
    assert.equal(meta.childNodes[2].textContent, 'm');
  }
  assert.equal(JSON.stringify(h.state.snapshot()).includes('SECRET'), false);
});

test('P3-17 styles: 40/64rem breakpoints, 24rem column + variable transcript, sticky dock, PTT sizes, bubble tokens, wrapping and no CSS order', async () => {
  const raw = await read('styles.css');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const escape = (value) => value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const block = (selector, source = css) => {
    const match = new RegExp(`(?:^|[\\n}])\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 's').exec(source);
    assert.ok(match, `rule ${selector}`);
    return Object.fromEntries(match[1].split(';').map((part) => part.split(':').map((value) => value.trim())).filter(([name]) => name));
  };
  const media = (query) => {
    const start = css.indexOf(`@media ${query} `);
    assert.ok(start >= 0, query);
    let depth = 0, index = css.indexOf('{', start);
    for (; index < css.length; index++) { if (css[index] === '{') depth++; else if (css[index] === '}' && --depth === 0) break; }
    return css.slice(start, index + 1);
  };
  // Breakpoints are min-width only, at exactly 40rem and 64rem; the view's query matches the stylesheet.
  assert.deepEqual([...new Set([...css.matchAll(/@media \(([^)]*width[^)]*)\)/g)].map((match) => match[1]))], ['min-width: 40rem', 'min-width: 64rem']);
  assert.ok(media(DESKTOP_LAYOUT_QUERY).length > 0);
  // Stacked: transcript grows, dock sticks to the bottom with the safe area and stays opaque.
  const dock = block('.seq-dock');
  assert.equal(dock.position, 'sticky');
  assert.equal(dock.bottom, '0');
  assert.match(dock['padding-bottom'], /safe-area-inset-bottom/);
  assert.equal(dock.background, 'var(--surface)');
  assert.equal(block('.seq-transcript').flex, '1 1 auto');
  assert.equal(block('.shell-panel').flex, '1 1 auto');
  // Desktop: 24rem control column + variable transcript, gated on the data-layout the view sets.
  const desktop = media('(min-width: 64rem)');
  const grid = block('.seq[data-layout="desktop"]', desktop);
  assert.equal(grid.display, 'grid');
  assert.equal(grid['grid-template-columns'], '24rem minmax(0, 1fr)');
  assert.equal(block('.seq[data-layout="desktop"] .seq-column', desktop).position, 'sticky');
  assert.equal(block('.seq[data-layout="desktop"] .seq-dock', desktop).position, 'static');
  assert.equal(block('.seq').display, 'flex', 'the base .seq rule is a single column');
  assert.equal(/\.seq(?:\[[^\]]*\])?\s*\{[^}]*display:\s*grid/.test(media('(min-width: 40rem)')), false, 'tablet stays one column');
  // Tablet+ keeps the 40rem/60rem caps (P3-12) and the larger translation size.
  assert.match(media('(min-width: 40rem)'), /\.shell-main[^{]*\{[^}]*max-width: 40rem/);
  assert.match(desktop, /\.shell-main[^{]*\{[^}]*max-width: 60rem/);
  assert.match(media('(min-width: 40rem)'), /\.turn-text-translation \{ font-size: 1\.5rem; \}/);
  // PTT: full-width row, 64px mobile / 56px desktop growing with zoom, recording border while pressed.
  const ptt = block('.seq-ptt');
  assert.equal(ptt.flex, '1 1 100%');
  assert.equal(ptt.width, '100%');
  assert.equal(ptt['min-height'], 'max(64px, 4rem)');
  assert.equal(block('.seq-ptt', desktop)['min-height'], 'max(56px, 3.5rem)');
  assert.match(block('.seq-ptt[aria-pressed="true"]')['box-shadow'], /inset 0 0 0 3px var\(--recording\)/);
  assert.equal(block('.seq-controls').display, 'flex');
  assert.equal(block('.seq-toggle, .seq-cancel').flex, '1 1 8rem');
  // Text form: textarea | send, hint below. Grid areas match the DOM order.
  const form = block('.seq-form');
  assert.equal(form['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(form['grid-template-areas'], '"text submit" "hint hint"');
  // Bubbles (DESIGN.md §4): source on surface-alt, translation on accent-soft, 2px start bar, muted meta, actions at the end.
  const text = block('.turn-text');
  assert.equal(text.background, 'var(--surface-alt)');
  assert.equal(text['border-inline-start'], '2px solid var(--border)');
  assert.equal(text['overflow-wrap'], 'anywhere');
  assert.equal(text['white-space'], 'pre-wrap');
  assert.equal(text['max-width'], '100%');
  assert.equal(block('.turn-text-translation').background, 'var(--accent-soft)');
  assert.equal(block('.turn-text-translation')['border-inline-start-color'], 'var(--accent)');
  assert.equal(block('.turn-meta')['font-size'], '0.8125rem');
  assert.equal(block('.turn-meta').color, 'var(--text-muted)');
  assert.equal(block('.turn-actions')['justify-content'], 'flex-end');
  assert.equal(block('.badge[data-state="recording"]')['border-color'], 'var(--recording)');
  assert.equal(block('.badge[data-state="error"]')['border-color'], 'var(--danger)');
  // Grid/flex children never force a horizontal scroll and no rule reorders visually.
  for (const selector of ['.seq', '.seq-transcript', '.seq-dock', '.seq-column', '.seq-controls', '.seq-form', '.seq-turns', '.turn-block']) {
    assert.equal(block(selector)['min-width'], '0', `${selector} min-width`);
  }
  assert.equal(/[^-\w]order\s*:/.test(css), false, 'no CSS order property');
  assert.equal(/overflow-x:\s*(auto|scroll)/.test(css), false, 'no horizontal scroll regions');
});

// --- P3-15: header language toggle and share placement (design-p3 §1.9, §1.11, §4.4; DESIGN.md §4, §10) ---

const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const byId = (node, id) => all(node, (item) => item.getAttribute('id') === id)[0];

test('P3-15 header: title, badges, then KO EN JA · display · share · settings in DOM order; the tab row sits under the header on mobile', () => {
  const h = harness();
  const app = h.root.childNodes[0];
  assert.equal(h.shell.layout, SHELL_LAYOUTS.STACKED);
  assert.equal(app.getAttribute('data-layout'), 'stacked');
  assert.deepEqual(classNames(app), ['shell-header', 'shell-notice', 'shell-message', 'shell-tabs', 'shell-main', 'shell-settings sheet', 'share-dialog sheet']);
  const header = h.shell.elements.header;
  assert.deepEqual(classNames(header), ['shell-title', 'shell-badges', 'shell-actions']);
  assert.deepEqual(classNames(h.shell.elements.actions),
    ['shell-languages', 'btn btn-secondary shell-display-button', 'btn btn-secondary share-button', 'btn btn-secondary shell-settings-button']);
  const languages = h.shell.elements.languages;
  assert.equal(languages.getAttribute('role'), 'group');
  assert.equal(languages.getAttribute('aria-label'), ko['language.ui']);
  assert.deepEqual(languages.childNodes.map((button) => button.getAttribute('data-language')), [...SUPPORTED_LANGUAGES]);
  assert.deepEqual(languages.childNodes.map((button) => button.textContent), ['KO', 'EN', 'JA']);
  for (const code of SUPPORTED_LANGUAGES) {
    const button = h.shell.elements.languageButtons[code];
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('lang'), code);
    assert.equal(button.getAttribute('aria-label'), ko[`language.${code}`]);
    assert.equal(button.getAttribute('aria-pressed'), String(code === 'ko'));
    assert.equal(visible(button), true, `${code} is always visible (no overflow menu)`);
  }
  assert.equal(h.shell.elements.displayButton.textContent, ko['display.open']);
  assert.equal(h.shell.elements.displayButton.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(h.shell.elements.shareButton.textContent, ko['share.open']);
  assert.equal(h.shell.elements.shareButton.getAttribute('aria-controls'), 'shell-share');
  assert.equal(h.shell.elements.settingsButton.textContent, ko['common.settings']);
  // Header focus order = DOM order = visual order: key badge, KO, EN, JA, display, share, settings.
  assert.deepEqual(focusableIds(header),
    ['shell-mode', 'shell-language', 'shell-language', 'shell-language', 'shell-display-button', 'share-button', 'shell-settings-button']);
  // The display button opens the settings dialog on the display section until P3-20 mounts its sheet.
  const targets = [];
  h.shell.onSettingsOpen((target) => targets.push(target));
  h.shell.elements.displayButton.focus();
  h.shell.elements.displayButton.dispatch('click');
  assert.equal(h.shell.settingsOpen, true);
  assert.deepEqual(targets, ['display']);
  assert.equal(h.shell.elements.displayButton.getAttribute('aria-expanded'), 'true');
  assert.equal(h.shell.elements.settingsButton.getAttribute('aria-expanded'), 'true');
  assert.equal(h.doc.activeElement, h.shell.elements.panels.settingsClose);
  h.shell.openDisplay();
  assert.deepEqual(targets, ['display', 'display'], 'an open dialog still forwards the target');
  h.shell.closeSettings();
  assert.equal(h.shell.elements.displayButton.getAttribute('aria-expanded'), 'false');
  assert.equal(h.doc.activeElement, h.shell.elements.displayButton, 'focus returns to the display button');
  assert.deepEqual(SETTINGS_TARGETS, ['key', 'display']);
  assert.deepEqual(h.engine.calls, []);
});

test('P3-15 language toggle: one change path updates text, lang, title and listeners; the interpretation pair, an active turn and the live connection stay', () => {
  const h = harness();
  h.engine.voice.sessionOpen = true;
  h.shell.render();
  assert.equal(h.shell.elements.connectionBadge.textContent, ko['connection.connected']);
  const { turnId } = h.engine.submitText('사과 12개');
  assert.equal(h.state.snapshot().status, SEQ_STATUS.TRANSLATING);
  const languages = [];
  h.shell.onLanguageChange((language) => languages.push(language));
  const en = h.shell.elements.languageButtons.en;
  en.focus();
  en.dispatch('click');
  assert.equal(h.i18n.language, 'en');
  assert.deepEqual(languages, ['en']);
  assert.equal(h.doc.documentElement.getAttribute('lang'), 'en');
  assert.equal(h.doc.title, dictionaries.en['app.name']);
  assert.equal(en.getAttribute('aria-pressed'), 'true');
  assert.equal(h.shell.elements.languageButtons.ko.getAttribute('aria-pressed'), 'false');
  assert.equal(h.shell.elements.languageButtons.ja.getAttribute('aria-pressed'), 'false');
  assert.equal(h.shell.elements.languages.getAttribute('aria-label'), dictionaries.en['language.ui']);
  assert.equal(en.getAttribute('aria-label'), dictionaries.en['language.en']);
  assert.equal(en.textContent, 'EN', 'the code is the visible label in every language');
  assert.equal(h.shell.elements.displayButton.textContent, dictionaries.en['display.open']);
  assert.equal(h.shell.elements.shareButton.textContent, dictionaries.en['share.open']);
  assert.equal(h.shell.elements.settingsButton.textContent, dictionaries.en['common.settings']);
  assert.equal(h.shell.elements.tabButtons.simultaneous.textContent, dictionaries.en['tabs.simultaneous']);
  assert.equal(h.doc.activeElement, en, 'focus stays on the pressed button');
  // Not the interpretation target, not a stop: the pair, the turn and the connection are untouched.
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'ja' });
  assert.equal(h.state.snapshot().activeTurnId, turnId);
  assert.equal(h.state.snapshot().status, SEQ_STATUS.TRANSLATING);
  assert.equal(byClass(h.root, 'turn-status').textContent, dictionaries.en['seq.translating']);
  assert.deepEqual(h.engine.calls, [['submitText', '사과 12개']], 'no setInterpretation, cancel or stop');
  assert.equal(h.engine.voice.sessionOpen, true);
  assert.equal(h.shell.elements.connectionBadge.textContent, dictionaries.en['connection.connected']);
  assert.equal(h.shell.elements.connectionBadge.getAttribute('data-connection'), 'connected');
  // The pressed button is a no-op; the other two and setLanguage() drive the same state.
  en.dispatch('click');
  assert.deepEqual(languages, ['en']);
  h.shell.elements.languageButtons.ja.dispatch('click');
  assert.equal(h.i18n.language, 'ja');
  assert.equal(h.shell.elements.languageButtons.ja.getAttribute('aria-pressed'), 'true');
  assert.equal(en.getAttribute('aria-pressed'), 'false');
  assert.equal(byClass(h.root, 'seq-ptt').textContent, dictionaries.ja['seq.holdToTalk']);
  assert.equal(h.shell.setLanguage('ko-KR'), 'ko');
  assert.deepEqual(languages, ['en', 'ja', 'ko']);
  assert.equal(h.shell.elements.languageButtons.ko.getAttribute('aria-pressed'), 'true');
  assert.equal(h.shell.elements.languageButtons.ja.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'ja' });
  assert.deepEqual(h.engine.calls, [['submitText', '사과 12개']]);
  // Changing the language while a dialog is open keeps it open.
  h.shell.openSettings();
  h.shell.setLanguage('en');
  assert.equal(h.shell.settingsOpen, true);
  h.shell.closeSettings();
  h.shell.destroy();
  h.shell.elements.languageButtons.ja.dispatch('click');
  assert.deepEqual(languages, ['en', 'ja', 'ko', 'en'], 'no listener runs after destroy');
});

test('P3-15 desktop header: the 64rem query moves the tab row between the title and the badges, and back, keeping focus', () => {
  const headerMedia = fakeMedia(true);
  const h = harness({ headerMedia });
  assert.equal(HEADER_LAYOUT_QUERY, DESKTOP_LAYOUT_QUERY);
  assert.deepEqual(headerMedia.queries, [HEADER_LAYOUT_QUERY]);
  assert.equal(headerMedia.listenerCount, 1);
  const app = h.root.childNodes[0];
  const header = h.shell.elements.header;
  const stacked = ['shell-header', 'shell-notice', 'shell-message', 'shell-tabs', 'shell-main', 'shell-settings sheet', 'share-dialog sheet'];
  assert.equal(h.shell.layout, SHELL_LAYOUTS.DESKTOP);
  assert.equal(app.getAttribute('data-layout'), 'desktop');
  assert.deepEqual(classNames(header), ['shell-title', 'shell-tabs', 'shell-badges', 'shell-actions']);
  assert.deepEqual(classNames(app), ['shell-header', 'shell-notice', 'shell-message', 'shell-main', 'shell-settings sheet', 'share-dialog sheet']);
  assert.deepEqual(focusableIds(header), ['tab-sequential', 'tab-simultaneous', 'shell-mode', 'shell-language', 'shell-language', 'shell-language',
    'shell-display-button', 'share-button', 'shell-settings-button']);
  assert.equal(h.view.layout, SEQ_LAYOUTS.STACKED, 'the window query is the header\'s; the sequential view keeps the document\'s');
  assert.equal(h.doc.defaultView, undefined);
  // Tabs keep working inside the header.
  const tab = h.shell.elements.tabButtons.sequential;
  tab.dispatch('click');
  assert.equal(h.shell.selectedTab, 'sequential');
  assert.equal(h.shell.elements.panels.sequential.hidden, false);
  tab.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.doc.activeElement, h.shell.elements.tabButtons.simultaneous);
  // Narrowing: the tab row returns under the header and a focused tab keeps focus.
  tab.focus();
  headerMedia.set(false);
  assert.equal(h.shell.layout, SHELL_LAYOUTS.STACKED);
  assert.equal(app.getAttribute('data-layout'), 'stacked');
  assert.deepEqual(classNames(header), ['shell-title', 'shell-badges', 'shell-actions']);
  assert.deepEqual(classNames(app), stacked);
  assert.equal(h.doc.activeElement, tab);
  headerMedia.set(false);
  assert.deepEqual(classNames(app), stacked, 'the same state again is a no-op');
  h.shell.elements.languageButtons.en.focus();
  headerMedia.set(true);
  assert.deepEqual(classNames(header), ['shell-title', 'shell-tabs', 'shell-badges', 'shell-actions']);
  assert.equal(h.doc.activeElement, h.shell.elements.languageButtons.en);
  assert.equal(h.shell.selectedTab, 'sequential', 'the selection survives the moves');
  // Dialog inert still covers the in-header tabs.
  h.shell.openSettings();
  assert.equal(h.shell.elements.tabs.hasAttribute('inert'), true);
  assert.equal(header.hasAttribute('inert'), true);
  h.shell.closeSettings();
  assert.equal(h.shell.elements.tabs.hasAttribute('inert'), false);
  assert.deepEqual(h.engine.calls, [], 'relayout never touches the engine');
  h.shell.destroy();
  assert.equal(headerMedia.listenerCount, 0, 'destroy removes the media listener');
  assert.equal(h.root.childNodes.length, 0);
});

test('P2-25 share dialog (P3-15 regression): origin + path only, QR image, copy and fallback, focus trap, Escape with focus return, exclusive with settings', async () => {
  const h = harness();
  const copied = [];
  h.win.navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
  h.win.location = { origin: 'https://example.test', hostname: 'example.test', protocol: 'https:',
    pathname: '/interp-app/releases/v9/index.html', search: '?k=SECRET', hash: '#k=SECRET' };
  const { shareButton } = h.shell.elements;
  const { share, shareClose, shareURL, shareCopy, shareStatus, shareImage, shareDeployment } = h.shell.elements.panels;
  assert.equal(share.hidden, true);
  assert.equal(share.getAttribute('id'), 'shell-share');
  assert.equal(share.getAttribute('role'), 'dialog');
  assert.equal(share.getAttribute('aria-modal'), 'true');
  assert.equal(share.getAttribute('aria-labelledby'), 'share-title');
  assert.equal(byId(share, 'share-title').textContent, ko['share.title']);
  assert.equal(byClass(share, 'share-image-host').childNodes.length, 0, 'the QR image is attached only while open');
  // Settings and share are mutually exclusive in both directions.
  h.shell.openSettings();
  h.shell.openShare();
  assert.equal(h.shell.settingsOpen, false);
  assert.equal(h.shell.shareOpen, true);
  h.shell.openSettings();
  assert.equal(h.shell.shareOpen, false);
  assert.equal(h.shell.settingsOpen, true);
  h.shell.closeSettings();

  shareButton.focus();
  shareButton.dispatch('click');
  assert.equal(h.shell.shareOpen, true);
  assert.equal(shareButton.getAttribute('aria-expanded'), 'true');
  assert.equal(h.doc.activeElement, shareClose);
  assert.equal(shareClose.textContent, ko['share.close']);
  assert.equal(byClass(h.root, 'shell-main').hasAttribute('inert'), true);
  assert.equal(h.shell.elements.header.hasAttribute('inert'), true);
  assert.equal(shareURL.value, 'https://example.test/interp-app/', 'release path, index.html, query and fragment are dropped');
  assert.equal(shareURL.getAttribute('readonly'), '');
  assert.equal(shareURL.getAttribute('aria-label'), ko['share.urlLabel']);
  assert.equal(shareImage.getAttribute('src'), '/interp-app/icons/qr-site.png');
  assert.equal(shareImage.getAttribute('alt'), ko['share.imageAlt']);
  assert.equal(shareImage.parentNode, byClass(share, 'share-image-host'));
  assert.equal(shareDeployment.hidden, false, 'off the deployed site the note says where the QR leads');
  assert.equal(shareDeployment.textContent, ko['share.deployment']);
  assert.equal(shareCopy.textContent, ko['share.copy']);
  assert.equal(shareStatus.getAttribute('aria-live'), 'polite');
  assert.equal(shareStatus.textContent, '');
  assert.equal(JSON.stringify([shareURL.value, shareImage.getAttribute('src')]).includes('SECRET'), false);
  // Copy: the clipboard gets exactly the URL; the status follows a language change.
  shareCopy.dispatch('click');
  await flush();
  assert.deepEqual(copied, ['https://example.test/interp-app/']);
  assert.equal(shareStatus.textContent, ko['share.copied']);
  h.shell.setLanguage('en');
  assert.equal(shareStatus.textContent, dictionaries.en['share.copied']);
  assert.equal(shareCopy.textContent, dictionaries.en['share.copy']);
  assert.equal(shareButton.textContent, dictionaries.en['share.open']);
  h.shell.setLanguage('ko');
  // Copy failure: the fallback text appears and the URL is selected for manual copying; nothing leaks.
  let selected = false;
  shareURL.select = () => { selected = true; };
  h.win.navigator.clipboard = { writeText: async () => { throw new Error('SECRET-CLIPBOARD'); } };
  shareCopy.dispatch('click');
  await flush();
  assert.equal(shareStatus.textContent, ko['share.copyFailed']);
  assert.equal(h.doc.activeElement, shareURL);
  assert.equal(selected, true);
  assert.equal(JSON.stringify(h.state.snapshot()).includes('SECRET'), false);
  // Focus trap: Tab from Copy wraps to Close; Shift+Tab from Close wraps to Copy.
  shareCopy.focus();
  assert.equal(share.dispatch('keydown', { key: 'Tab', shiftKey: false }).defaultPrevented, true);
  assert.equal(h.doc.activeElement, shareClose);
  assert.equal(share.dispatch('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, true);
  assert.equal(h.doc.activeElement, shareCopy);
  // Escape closes, focus returns to the share button, inert lifts and the image leaves the DOM.
  share.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.shell.shareOpen, false);
  assert.equal(share.hidden, true);
  assert.equal(shareButton.getAttribute('aria-expanded'), 'false');
  assert.equal(h.doc.activeElement, shareButton);
  assert.equal(byClass(h.root, 'shell-main').hasAttribute('inert'), false);
  assert.equal(h.shell.elements.header.hasAttribute('inert'), false);
  assert.equal(shareImage.parentNode, null);
  // A copy that settles after the dialog closed writes nothing.
  h.win.navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
  shareButton.dispatch('click');
  shareCopy.dispatch('click');
  shareClose.dispatch('click');
  await flush();
  assert.equal(h.shell.shareOpen, false);
  assert.equal(shareStatus.textContent, '');
  // On the deployed site the deployment note is hidden and the URL is the site root.
  h.win.location = { origin: 'https://gai-cmd.github.io', hostname: 'gai-cmd.github.io', protocol: 'https:', pathname: '/interp-app/' };
  shareButton.dispatch('click');
  assert.equal(shareURL.value, 'https://gai-cmd.github.io/interp-app/');
  assert.equal(shareImage.getAttribute('src'), '/interp-app/icons/qr-site.png');
  assert.equal(shareDeployment.hidden, true);
  shareClose.dispatch('click');
  assert.equal(h.shell.shareOpen, false);
  assert.deepEqual(h.engine.calls, [], 'sharing never touches the engine');
  h.shell.destroy();
});

test('P3-15 styles: the header and its action row wrap, the language toggle is never clipped, in-header tab rules only under data-layout="desktop"', async () => {
  const raw = await read('styles.css');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const escape = (value) => value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const rule = (selector, source = css) => {
    const match = new RegExp(`(?:^|[\\n}])\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 's').exec(source);
    assert.ok(match, `rule ${selector}`);
    return Object.fromEntries(match[1].split(';').map((part) => part.split(':').map((value) => value.trim())).filter(([name]) => name));
  };
  const desktopStart = css.indexOf('@media (min-width: 64rem) ');
  assert.ok(desktopStart >= 0);
  let depth = 0, end = css.indexOf('{', desktopStart);
  for (; end < css.length; end++) { if (css[end] === '{') depth++; else if (css[end] === '}' && --depth === 0) break; }
  const desktop = css.slice(desktopStart, end + 1);
  // Mobile: the header wraps; the action row is a full-width second line that wraps again; nothing clips.
  assert.equal(rule('.shell-header').display, 'flex');
  assert.equal(rule('.shell-header')['flex-wrap'], 'wrap');
  const actions = rule('.shell-actions');
  assert.equal(actions.display, 'flex');
  assert.equal(actions['flex-wrap'], 'wrap');
  assert.equal(actions.flex, '1 1 100%');
  assert.equal(actions['min-width'], '0');
  const languages = rule('.shell-languages');
  assert.equal(languages.display, 'flex');
  assert.equal(languages['flex-wrap'], 'wrap');
  for (const selector of ['.shell-header', '.shell-actions', '.shell-languages']) {
    const block = rule(selector);
    assert.equal(block.overflow ?? block['overflow-x'], undefined, `${selector} never clips the language toggle`);
  }
  // The pressed language reads as text (aria-pressed) and as the accent fill with accent text.
  const pressed = rule('.shell-language[aria-pressed="true"]');
  assert.equal(pressed.background, 'var(--accent)');
  assert.equal(pressed.color, 'var(--accent-text)');
  assert.equal(/\.shell-settings-button\s*\{[^}]*margin-left:\s*auto/.test(css), false, 'the settings button stays grouped in the action row');
  // Desktop: in-header tabs key on the data-layout the shell sets, inside the 64rem block only.
  const tabs = rule('.shell[data-layout="desktop"] .shell-header .shell-tabs', desktop);
  assert.equal(tabs['border-bottom'], '0');
  assert.equal(tabs.padding, '0');
  assert.equal(tabs['max-width'], 'none');
  assert.equal(rule('.shell[data-layout="desktop"] .shell-header .shell-tab', desktop).flex, '0 0 auto');
  assert.equal(rule('.shell[data-layout="desktop"] .shell-actions', desktop)['justify-content'], 'flex-end');
  assert.equal(css.indexOf('[data-layout="desktop"] .shell'), css.indexOf('[data-layout="desktop"] .shell', desktopStart), 'no desktop header rule outside the 64rem block');
  assert.equal(/[^-\w]order\s*:/.test(css), false, 'no CSS order property');
});
