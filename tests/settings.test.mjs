import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createI18n, SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { checkSource } from '../scripts/check-i18n.mjs';
import { createState } from '../app/state.js';
import { APP_DEFAULTS, createAppConfig } from '../app/config.js';
import { ProviderError } from '../app/providers/contract.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { createKeyStore } from '../app/security/key-store.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { createDiagnostics, DIAGNOSTIC_KINDS } from '../app/engine/diagnostics.js';
import { mount } from '../app/ui/shell.js';
import { acceptsDirectKey, createSettingsView, KEY_SOURCES, keyStoreErrorKey, sharedFragmentFrom } from '../app/ui/settings-view.js';
import { checkState, createDiagnosticsView, STATE_KEYS } from '../app/ui/diagnostics-view.js';
import { SecurityError } from '../app/security/redact.js';
import { provider } from './fixtures/providers.mjs';
import { goldenWav } from './fixtures/audio.mjs';
import { createClock, deferred, tick } from './fixtures/live.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await read(`app/i18n/${language}.json`))])));
const ko = dictionaries.ko;
const KEY = 'PERSONAL-SECRET-KEY';
const fragment = (providerId, eventName = 'Sunday <b>service</b>') => `#shared=${encodeURIComponent(JSON.stringify(
  { version: 1, providerId, eventName, key: 'SHARED-SECRET-KEY' }))}`;
async function until(condition, limit = 100) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}

// Minimal DOM double (same surface as the P1-15 tests): innerHTML throws so
// any markup rendering of provider or QR text fails loudly.
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set();
    this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.style = {}; this.text = '';
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
  remove() { if (!this.parentNode) return; this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); this.parentNode = null; }
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
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
}
function createDocument() {
  const doc = { title: '', activeElement: null };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('body');
  return doc;
}
const all = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes) all(child, predicate, out);
  return out;
};
const byClass = (node, name) => all(node, (item) => item.classes.has(name))[0];
const visible = (node) => { for (let item = node; item; item = item.parentNode) if (item.hidden) return false; return true; };
const clickable = (node) => visible(node) && !node.disabled;
// Every text node and attribute value in the tree, for secret scans.
const domText = (node) => all(node, () => true).map((item) => `${item.text}\n${[...item.attributes.values()].join('\n')}\n${item.value}`).join('\n');
const options = (select) => select.childNodes.map((option) => option.getAttribute('value'));
function choose(select, value) { select.value = value; return select.dispatch('change'); }

function fakeTimers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    clearTimeout: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; },
    run() { const pending = queue.splice(0); for (const timer of pending) timer.fn?.(); return pending.filter((timer) => timer.fn).length; },
    get pending() { return queue.filter((timer) => timer.fn); },
  };
}
// Sequential-engine double on the real store (P1-14 snapshot shape).
function fakeEngine() {
  let clock = 0, serial = 0;
  const state = createState({ sessionId: 'session-1', now: () => ++clock });
  const calls = [];
  const engine = {
    state, calls, voice: { sessionOpen: false },
    startRecording() { calls.push(['startRecording']); const turnId = `turn-${++serial}`; state.beginTurn({ turnId, input: 'voice' }); return { turnId }; },
    stopRecording() { calls.push(['stopRecording']); return null; },
    submitText(text) { calls.push(['submitText', text]); const turnId = `turn-${++serial}`; state.beginTurn({ turnId, input: 'text', sourceText: text.trim() }); return { turnId }; },
    retry(turnId) { calls.push(['retry', turnId]); return { turnId }; },
    replay(turnId, options) { calls.push(['replay', turnId, options]); return { turnId }; },
    cancel() { calls.push(['cancel']); const turnId = state.snapshot().activeTurnId; if (turnId) state.cancelTurn(turnId); },
    setInterpretation(pair) { calls.push(['setInterpretation', pair]); state.setInterpretation(pair); },
    setVoice(settings) { calls.push(['setVoice', settings]); state.setVoice(settings); },
    snapshot() { return { closed: false, voice: engine.voice }; },
    complete(turnId, sourceText, translatedText) {
      state.commitTranslation(turnId, { status: 'ok', sourceText, translatedText, detectedLanguage: 'ko', model: 'm' });
      state.finishTurn(turnId);
    },
  };
  return engine;
}
// Scripted adapter for the fixture providers (value, Error or function per call).
function scriptedAdapter() {
  const a = { calls: [], sessions: [], script: { translate: [], stt: [], voice: [] } };
  const step = (name, request, context) => {
    a.calls.push({ name, request, context });
    const next = a.script[name].shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request, context) : next;
  };
  a.translate = async (request, context) => step('translate', request, context)
    ?? { sourceText: request.input.text, translatedText: 'こんにちは', detectedLanguage: 'ko', status: 'ok', model: 'test-model' };
  a.stt = async (request, context) => step('stt', request, context)
    ?? { sourceText: 'hello', detectedLanguage: 'en', status: 'ok', model: 'test-model' };
  a.voice = { async open(request, context) {
    step('voice', request, context);
    const session = { request, context, speaks: [], open: true, pending: null,
      speak(req) { session.speaks.push(req); return new Promise((resolve, reject) => { session.pending = { resolve, reject }; }); },
      async cancel() { session.open = false; }, async close() { session.open = false; },
      audio(bytes = 4800) { context.onEvent({ type: 'audio', audio: new Uint8Array(bytes), sampleRate: 24000 }); },
      complete() { session.pending.resolve({ status: 'completed', bytes: 4800, chunks: 1, said: '', model: 'test-model', voice: 'Kore' }); } };
    a.sessions.push(session);
    return session;
  } };
  a.live = { async open() { return { async sendAudio() {}, async finishInput() {}, async close() {} }; } };
  return a;
}
function fakeCapture() {
  const capture = { sessions: [], active: null };
  capture.start = (context) => {
    if (capture.active) throw new ProviderError('INVALID_REQUEST');
    const gate = deferred();
    const session = { context, done: gate.promise, ended: false };
    const finish = (result) => {
      if (session.ended) return session.done;
      session.ended = true; capture.active = null;
      gate.resolve(Object.freeze({ turnId: context.turnId, sessionId: context.sessionId, generation: context.generation, sampleRate: 16000, durationMs: 1000, ...result }));
      return session.done;
    };
    session.finish = finish;
    session.stop = () => finish({ status: 'success', wav: goldenWav, pcm: new Int16Array(3) });
    session.cancel = () => finish({ status: 'cancelled', code: 'ABORTED', reason: 'cancel', messageKey: 'error.ABORTED' });
    context.signal?.addEventListener('abort', session.cancel, { once: true });
    capture.sessions.push(session); capture.active = session;
    return session;
  };
  capture.stop = () => capture.active?.stop();
  capture.cancel = () => capture.active?.cancel();
  return capture;
}
function fakeAudioContext() {
  const sources = [];
  return { currentTime: 0, destination: {}, sources, async resume() {},
    createBuffer(channels, size, rate) { const data = new Float32Array(size); return { data, duration: size / rate, getChannelData: () => data }; },
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, stop() {}, start() { setImmediate(() => this.onended?.()); } };
      sources.push(source); return source;
    } };
}
function fakeStorage() {
  const map = new Map();
  return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) };
}
// alpha (direct, voices) + hubonly (no browser calls): the multi-provider structure of §20.3.
function fixtureConfig({ storage } = {}) {
  const registry = createRegistry();
  const adapter = scriptedAdapter();
  const alpha = provider('alpha');
  alpha.capabilities.voice.voices = ['Kore', 'Orus'];
  registry.register(alpha, adapter);
  const capability = (implementation, transports, inputFormats, outputFormats) => ({ implementation, transports, inputFormats, outputFormats, models: ['test-model'], voices: [] });
  registry.register(provider('hubonly', { browserDirect: false,
    credentialPolicy: { directPersonal: false, directShared: false, hubManaged: true },
    capabilities: { translate: capability('ready', ['hub'], ['text'], ['translation']), stt: capability('ready', ['hub'], ['wav'], ['transcript']),
      live: capability('planned', ['hub'], ['pcm16'], ['pcm16']), voice: capability('ready', ['hub'], ['text'], ['pcm16']) } }), {});
  const keyStore = createKeyStore({ registry, storage });
  const router = createRouter({ registry, getCredentialRef: (address, options) => keyStore.getCredentialRef(address, options) });
  const clock = createClock();
  const sessionManager = createSessionManager({ timeoutMs: 60000, ...clock });
  return { registry, keyStore, router, sessionManager, defaults: APP_DEFAULTS, providers: registry.list(), resolveFallback: () => null,
    adapter, clock, async dispose() { keyStore.dispose(); await sessionManager.close().catch(() => {}); } };
}

function harness({ config = fixtureConfig(), language = 'ko', persistence = false, capture = fakeCapture(), app = null,
  getDeviceVoices = null } = {}) {
  const doc = createDocument();
  const root = doc.createElement('div');
  const timers = fakeTimers();
  const engine = fakeEngine();
  const i18n = createI18n({ dictionaries, language });
  const shell = mount({ root, i18n, engine, document: doc, ...timers });
  shell.openSettings();
  const clock = config.clock ?? createClock();
  const audio = fakeAudioContext();
  const diagnostics = createDiagnostics({ config, capture, getAudioContext: () => audio, ...clock, random: () => 0, now: () => 1000 });
  const uiLanguages = [];
  const view = createSettingsView({ shell, i18n, config, engine, diagnostics, document: doc, persistence, app, getDeviceVoices,
    onUiLanguageChange: (value) => uiLanguages.push(value) });
  const el = (name) => byClass(root, name);
  const diagRow = (kind) => all(root, (node) => node.classes.has('diag-check') && node.getAttribute('data-kind') === kind)[0];
  const capRow = (name) => all(root, (node) => node.classes.has('diag-capability') && node.getAttribute('data-capability') === name)[0];
  const notice = () => engine.state.snapshot().notice?.messageKey ?? null;
  return { doc, root, timers, engine, state: engine.state, i18n, shell, config, keyStore: config.keyStore, adapter: config.adapter,
    capture, audio, diagnostics, view, el, diagRow, capRow, notice, uiLanguages, clock };
}
async function teardown(h) {
  h.view.destroy();
  await h.diagnostics.close();
  h.shell.destroy();
  await h.config.dispose();
}

test('settings and diagnostics sources use only existing dictionary keys and never render markup', async () => {
  const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
  for (const file of ['app/ui/settings-view.js', 'app/ui/diagnostics-view.js', 'app/engine/diagnostics.js']) {
    const source = await read(file);
    assert.deepEqual(checkSource(source, dictionaries.en), [], file);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|innerText|createContextualFragment/.test(source), false, file);
    assert.equal(/\bDOMParser\b|document\.write|\beval\(|console\./.test(source), false, file);
    const literals = [...source.matchAll(/(['"`])([^'"`\r\n]+)\1/g)].map((match) => match[2]).filter((value) => keyPattern.test(value));
    assert.ok(literals.length > 0, file);
    for (const key of literals) assert.ok(Object.hasOwn(dictionaries.en, key), `${file}: ${key}`);
  }
  for (const key of Object.values(STATE_KEYS)) assert.ok(Object.hasOwn(dictionaries.en, key), key);
  for (const kind of DIAGNOSTIC_KINDS) assert.ok(Object.hasOwn(dictionaries.en, `diagnostics.${kind}`), kind);
  assert.deepEqual([...KEY_SOURCES], ['personal', 'shared']);
  assert.equal(acceptsDirectKey({ browserDirect: true, credentialPolicy: { directPersonal: true, directShared: false } }, 'shared'), false);
  assert.equal(acceptsDirectKey({ browserDirect: false, credentialPolicy: { directPersonal: true, directShared: true } }, 'personal'), false);
  assert.equal(acceptsDirectKey(null, 'personal'), false);
  assert.equal(keyStoreErrorKey(new SecurityError('INVALID_SHARED_PAYLOAD')), 'error.INVALID_SHARED_PAYLOAD');
  assert.equal(keyStoreErrorKey(new ProviderError('INVALID_KEY')), 'error.INVALID_KEY');
  assert.equal(keyStoreErrorKey(new Error('SECRET')), 'error.SECURITY_ERROR');
  assert.equal(sharedFragmentFrom(' https://example.invalid/app/#shared=abc '), '#shared=abc');
  assert.equal(sharedFragmentFrom('#shared=abc'), '#shared=abc');
  assert.equal(sharedFragmentFrom('no fragment'), '');
  assert.equal(sharedFragmentFrom(null), '');
  assert.deepEqual(checkState('text', { running: { kind: 'text', capturing: false } }, []), { state: 'running', result: null, capturing: false });
  assert.deepEqual(checkState('microphone', { running: null, results: [] }, []), { state: 'untested', result: null, capturing: false });
});

test('one registered provider shows its title without a picker, mounts into the shell dialog and follows the UI language', async () => {
  const config = createAppConfig();
  const h = harness({ config });
  assert.equal(h.shell.elements.panels.settingsBody.childNodes[0], h.view.element);
  assert.equal(h.view.providerId, 'gemini');
  assert.equal(visible(h.view.elements.providerSelect), false, 'no picker for one provider');
  assert.equal(visible(h.view.elements.providerTitle), true);
  assert.equal(h.view.elements.providerTitle.textContent, ko['providers.gemini']);
  assert.equal(h.el('settings-terms').textContent, ko['providers.geminiTerms']);
  assert.equal(h.view.elements.keyStatus.textContent, ko['settings.noKey']);
  assert.equal(visible(h.el('settings-hub-only')), false);
  assert.equal(visible(h.el('settings-remember')), false, 'no remember option without storage');
  assert.equal(h.view.elements.keyInput.getAttribute('type'), 'password');
  assert.equal(h.view.elements.keyInput.getAttribute('autocomplete'), 'off');
  assert.equal(h.view.elements.keyInput.getAttribute('placeholder'), ko['settings.keyPlaceholder']);
  assert.equal(options(h.view.elements.voiceSelect).length, 31, 'default plus the registered Live voices');
  assert.equal(h.view.elements.voiceSelect.childNodes[0].textContent, ko['voice.provider']);
  assert.equal(h.view.elements.voiceSelect.childNodes[1].textContent, 'Kore');
  assert.equal(visible(h.view.elements.deviceSelect), false);
  assert.equal(visible(h.el('settings-quota-scope')), true, 'project-scoped quota note for Gemini');
  assert.equal(h.el('settings-quota-scope').textContent, ko['quota.project']);
  assert.equal(h.el('settings-app-mode').textContent, ko['pwa.web']);
  assert.equal(visible(h.el('settings-app-version')), false);
  assert.equal(byClass(h.root, 'diag-scope').textContent, ko['diagnostics.scope']);
  for (const [name, state] of [['translate', 'untested'], ['stt', 'untested'], ['live', 'planned'], ['voice', 'untested']]) {
    assert.equal(h.capRow(name).getAttribute('data-state'), state, name);
    assert.equal(byClass(h.capRow(name), 'diag-capability-state').textContent, ko[STATE_KEYS[state]]);
  }
  assert.equal(byClass(h.capRow('translate'), 'diag-capability-route').textContent, ko['capability.direct']);
  for (const kind of ['text', 'ptt', 'voice', 'live']) assert.equal(byClass(h.diagRow(kind), 'diag-check-run').disabled, true, `${kind} needs a key`);
  assert.equal(byClass(h.diagRow('playback'), 'diag-check-run').disabled, false);
  for (const language of ['en', 'ja', 'ko']) {
    h.shell.setLanguage(language);
    const dictionary = dictionaries[language];
    assert.equal(h.view.elements.uiSelect.value, language);
    assert.equal(h.view.elements.keyStatus.textContent, dictionary['settings.noKey']);
    assert.equal(byClass(h.root, 'settings-section-title').textContent, dictionary['language.ui']);
    assert.equal(byClass(h.diagRow('text'), 'diag-check-label').textContent, dictionary['diagnostics.text']);
    assert.equal(byClass(h.capRow('live'), 'diag-capability-state').textContent, dictionary['capability.planned']);
    assert.equal(h.view.elements.voiceSelect.childNodes[0].textContent, dictionary['voice.provider']);
    assert.equal(byClass(h.diagRow('text'), 'diag-check-run').textContent, dictionary['common.check']);
  }
  choose(h.view.elements.uiSelect, 'ja');
  assert.equal(h.doc.title, dictionaries.ja['app.name']);
  assert.deepEqual(h.uiLanguages, ['ja']);
  assert.equal(config.sessionManager.occupied, false);
  assert.deepEqual(h.engine.calls, []);
  await teardown(h);
});

test('two providers show a picker; a hub-only provider blocks key entry; personal keys save, check, remember and delete explicitly', async () => {
  const storage = fakeStorage();
  const h = harness({ config: fixtureConfig({ storage }), persistence: true });
  const { elements } = h.view;
  assert.equal(visible(elements.providerSelect), true);
  assert.deepEqual(options(elements.providerSelect), ['alpha', 'hubonly']);
  assert.equal(visible(elements.providerTitle), false);
  assert.equal(elements.providerSelect.childNodes[1].textContent, ko['common.unknown'], 'fixture labels are not dictionary keys');

  choose(elements.providerSelect, 'hubonly');
  assert.equal(h.view.providerId, 'hubonly');
  assert.equal(visible(h.el('settings-hub-only')), true);
  assert.equal(h.el('settings-hub-only').textContent, ko['settings.hubKey']);
  assert.equal(visible(elements.keyInput), false);
  assert.equal(visible(elements.saveButton), false);
  assert.equal(visible(elements.checkButton), false);
  assert.equal(visible(h.el('settings-shared')), false);
  assert.equal(visible(elements.modeInputs.personal), false);
  assert.equal(visible(elements.modeInputs.shared), false);
  assert.equal(visible(elements.voiceSelect), false, 'hub-only voices are not offered');
  for (const name of ['translate', 'stt', 'voice']) assert.equal(h.capRow(name).getAttribute('data-state'), 'hubRequired', name);
  assert.equal(byClass(h.capRow('translate'), 'diag-capability-state').textContent, ko['capability.hubRequired']);
  assert.equal(byClass(h.capRow('translate'), 'diag-capability-route').textContent, ko['capability.hub']);
  assert.equal(h.capRow('live').getAttribute('data-state'), 'planned');
  for (const kind of ['text', 'ptt', 'voice', 'live']) assert.equal(byClass(h.diagRow(kind), 'diag-check-run').disabled, true, kind);
  assert.throws(() => h.keyStore.setPersonal('hubonly', KEY), (error) => error.code === 'CREDENTIAL_FORBIDDEN');
  assert.equal(h.view.selectProvider('bogus'), 'hubonly');

  choose(elements.providerSelect, 'alpha');
  assert.equal(visible(elements.keyInput), true);
  assert.equal(visible(h.el('settings-remember')), true);
  assert.equal(elements.modeInputs.personal.disabled, true);
  assert.equal(elements.checkButton.disabled, true);
  assert.equal(elements.deleteButton.disabled, true);
  elements.keyInput.value = `  ${KEY}  `;
  const submit = h.el('settings-key-form').dispatch('submit');
  assert.equal(submit.defaultPrevented, true);
  assert.equal(elements.keyInput.value, '', 'the field is emptied on save');
  assert.deepEqual(h.keyStore.getMetadata('alpha', 'personal'), { providerId: 'alpha', keySource: 'personal', remembered: false });
  assert.deepEqual(h.keyStore.getSelection(), { providerId: 'alpha', keySource: 'personal' });
  assert.equal(h.adapter.calls.length, 0, 'saving a key starts no check');
  assert.equal(h.diagnostics.snapshot().running, null);
  assert.equal(h.notice(), null);
  assert.equal(storage.map.size, 0);
  assert.equal(elements.keyStatus.textContent, ko['settings.keyMemory']);
  assert.equal(elements.keyStatus.getAttribute('data-key'), 'memory');
  assert.equal(elements.modeInputs.personal.checked, true);
  assert.equal(elements.modeInputs.personal.disabled, false);
  assert.equal(elements.modeInputs.shared.disabled, true);
  assert.equal(elements.checkButton.disabled, false);
  assert.equal(elements.deleteButton.disabled, false);
  assert.equal(/SECRET/.test(domText(h.root)), false, 'the key never reaches the DOM');
  assert.equal(/SECRET/.test(JSON.stringify(h.state.snapshot())), false);
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'untested', 'a saved key is not a passed check');

  elements.checkButton.dispatch('click');
  assert.equal(h.diagnostics.snapshot().running.kind, 'text');
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'running');
  assert.equal(byClass(h.diagRow('text'), 'diag-check-run').textContent, ko['common.cancel']);
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.adapter.calls[0].context.keySource, 'personal');
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'available');
  assert.equal(byClass(h.capRow('translate'), 'diag-capability-state').textContent, ko['capability.available']);
  assert.equal(byClass(h.diagRow('text'), 'diag-check-state').textContent, ko['capability.available']);
  assert.equal(byClass(h.diagRow('text'), 'diag-check-model').textContent, 'test-model');
  for (const name of ['stt', 'voice']) assert.equal(h.capRow(name).getAttribute('data-state'), 'untested', `${name} stays untested`);

  // Remembering is a per-save choice and needs the offered storage.
  elements.rememberInput.checked = true;
  elements.keyInput.value = 'REMEMBERED-SECRET-KEY';
  h.el('settings-key-form').dispatch('submit');
  assert.equal(storage.map.get('interp-app.personal-key.v1.alpha'), 'REMEMBERED-SECRET-KEY');
  assert.equal(elements.keyStatus.getAttribute('data-key'), 'remembered');
  assert.equal(elements.keyStatus.textContent, ko['settings.keyStored']);
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'untested', 'a new key invalidates the old result');
  assert.equal(h.adapter.calls.length, 1, 'still no automatic check');
  assert.equal(/SECRET/.test(domText(h.root)), false);

  elements.keyInput.value = 'bad key with spaces';
  h.el('settings-key-form').dispatch('submit');
  assert.equal(h.notice(), 'error.INVALID_KEY');
  assert.equal(elements.keyInput.value, '');
  assert.equal(storage.map.get('interp-app.personal-key.v1.alpha'), 'REMEMBERED-SECRET-KEY', 'a rejected key keeps the stored one');
  h.state.setNotice(null);

  elements.deleteButton.dispatch('click');
  assert.equal(visible(elements.deleteConfirm), true);
  assert.equal(byClass(elements.deleteConfirm, 'settings-confirm-text').textContent, ko['settings.deleteKeyConfirm']);
  assert.equal(h.doc.activeElement, byClass(elements.deleteConfirm, 'settings-key-delete-confirm'));
  elements.deleteConfirm.childNodes[2].dispatch('click');
  assert.equal(visible(elements.deleteConfirm), false);
  assert.notEqual(h.keyStore.getMetadata('alpha', 'personal'), null, 'cancel keeps the key');
  elements.deleteButton.dispatch('click');
  byClass(elements.deleteConfirm, 'settings-key-delete-confirm').dispatch('click');
  assert.equal(h.keyStore.getMetadata('alpha', 'personal'), null);
  assert.equal(storage.map.size, 0);
  assert.equal(h.notice(), 'settings.keyDeleted');
  assert.equal(elements.keyStatus.textContent, ko['settings.noKey']);
  assert.equal(elements.checkButton.disabled, true);
  assert.equal(elements.modeInputs.personal.disabled, true);
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(/SECRET/.test(domText(h.root)), false);
  await teardown(h);
});

test('shared keys import from a pasted link, show the event as text, switch modes only on request and end explicitly', async () => {
  const h = harness();
  const { elements } = h.view;
  h.keyStore.setPersonal('alpha', KEY);
  assert.equal(elements.modeInputs.personal.checked, true);
  assert.equal(visible(h.el('settings-shared-form')), true);
  assert.equal(visible(elements.sharedEnd), false);
  assert.equal(h.el('settings-shared-status').textContent, ko['settings.noKey']);

  elements.sharedInput.value = `https://example.invalid/app/${fragment('alpha', 'Sunday <b>service</b>')}`;
  const submit = h.el('settings-shared-form').dispatch('submit');
  assert.equal(submit.defaultPrevented, true);
  assert.equal(elements.sharedInput.value, '');
  assert.equal(h.keyStore.getMetadata('alpha', 'shared').eventName, 'Sunday <b>service</b>');
  assert.equal(elements.sharedEvent.textContent, ko['settings.event'].replace('{event}', 'Sunday <b>service</b>'));
  assert.equal(elements.sharedEvent.childNodes.length, 0, 'event name is text, not markup');
  assert.equal(visible(elements.sharedEnd), true);
  assert.equal(visible(h.el('settings-shared-form')), false);
  assert.equal(h.el('settings-shared-status').textContent, ko['mode.shared']);
  assert.equal(visible(h.el('settings-shared-until')), false, 'no deadline given');
  assert.deepEqual(h.keyStore.getSelection(), { providerId: 'alpha', keySource: 'personal' }, 'a personal key stays the default');
  assert.equal(elements.modeInputs.shared.disabled, false);
  assert.equal(elements.modeInputs.shared.checked, false);
  assert.equal(h.adapter.calls.length, 0, 'receiving a shared key starts no check');
  assert.equal(/SECRET/.test(domText(h.root)), false);

  elements.modeInputs.shared.checked = true;
  elements.modeInputs.shared.dispatch('change');
  assert.deepEqual(h.keyStore.getSelection(), { providerId: 'alpha', keySource: 'shared' });
  assert.equal(elements.modeInputs.shared.checked, true);
  assert.equal(elements.modeInputs.personal.checked, false);
  assert.equal(elements.checkButton.disabled, true, 'the personal check needs the personal source selected');
  assert.equal(h.adapter.calls.length, 0);
  byClass(h.diagRow('text'), 'diag-check-run').dispatch('click');
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.adapter.calls[0].context.keySource, 'shared');
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'available');
  elements.modeInputs.personal.checked = true;
  elements.modeInputs.personal.dispatch('change');
  assert.deepEqual(h.keyStore.getSelection(), { providerId: 'alpha', keySource: 'personal' });
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'untested', 'results are per key source');

  elements.sharedEnd.dispatch('click');
  assert.equal(h.keyStore.getMetadata('alpha', 'shared'), null);
  assert.equal(visible(h.el('settings-shared-form')), true);
  assert.equal(visible(elements.sharedEnd), false);
  assert.equal(elements.modeInputs.shared.disabled, true);
  elements.sharedInput.value = 'no fragment here';
  h.el('settings-shared-form').dispatch('submit');
  assert.equal(h.notice(), null);
  assert.equal(h.doc.activeElement, elements.sharedInput);
  elements.sharedInput.value = '#shared=%zz';
  h.el('settings-shared-form').dispatch('submit');
  assert.equal(h.notice(), 'error.INVALID_SHARED_PAYLOAD');
  assert.equal(elements.sharedInput.value, '');
  elements.sharedInput.value = fragment('hubonly');
  h.el('settings-shared-form').dispatch('submit');
  assert.equal(h.notice(), 'error.INVALID_SHARED_PAYLOAD', 'hub-only providers accept no browser key');
  assert.equal(/SECRET/.test(domText(h.root)), false);
  assert.equal(/SECRET/.test(JSON.stringify(h.state.snapshot())), false);
  await teardown(h);
});

test('voice, device voice, interpretation pair and preview call the engine only from controls', async () => {
  const voices = [{ voiceURI: 'ko-1', name: 'Yuna', lang: 'ko-KR', localService: true }, { voiceURI: 'ja-1', name: 'Kyoko', lang: 'ja-JP' }, { bogus: true }];
  const h = harness({ getDeviceVoices: () => voices });
  const { elements } = h.view;
  h.keyStore.setPersonal('alpha', KEY);
  assert.equal(elements.outputSelect.value, 'provider');
  assert.deepEqual(options(elements.outputSelect), ['provider', 'device', 'off']);
  assert.deepEqual(options(elements.voiceSelect), ['', 'Kore', 'Orus']);
  assert.deepEqual(options(elements.deviceSelect), ['', 'ko-1', 'ja-1']);
  assert.equal(elements.deviceSelect.childNodes[1].textContent, 'Yuna (ko-KR)');
  assert.equal(elements.deviceSelect.childNodes[0].textContent, ko['language.auto']);
  assert.equal(elements.previewButton.disabled, false);
  choose(elements.voiceSelect, 'Orus');
  assert.deepEqual(h.engine.calls.at(-1), ['setVoice', { voice: 'Orus' }]);
  assert.equal(h.state.snapshot().voice.voice, 'Orus');
  choose(elements.deviceSelect, 'ja-1');
  assert.equal(h.state.snapshot().voice.deviceVoiceURI, 'ja-1');
  choose(elements.outputSelect, 'device');
  assert.equal(h.state.snapshot().voice.output, 'device');
  assert.equal(elements.previewButton.disabled, true, 'no provider preview without provider output');
  choose(elements.outputSelect, 'provider');
  assert.equal(h.adapter.calls.length, 0, 'choosing a voice opens no session');
  assert.equal(h.config.sessionManager.occupied, false);

  elements.previewButton.dispatch('click');
  assert.equal(h.diagnostics.snapshot().running.kind, 'voice');
  assert.equal(elements.previewButton.disabled, true);
  await until(() => h.adapter.sessions[0]?.speaks.length === 1);
  assert.equal(h.adapter.sessions[0].request.voice, 'Orus', 'the preview uses the chosen voice');
  assert.equal(h.adapter.sessions[0].request.language, 'ja');
  assert.equal(h.config.sessionManager.occupied, true);
  h.adapter.sessions[0].audio(); h.adapter.sessions[0].complete();
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(h.capRow('voice').getAttribute('data-state'), 'available');
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'untested', 'a voice pass says nothing about translation');
  assert.equal(elements.previewButton.disabled, false);

  choose(elements.targetSelect, 'ko');
  assert.deepEqual(h.engine.calls.at(-1), ['setInterpretation', { sourceLanguage: 'ja', targetLanguage: 'ko' }]);
  assert.equal(elements.sourceSelect.value, 'ja');
  choose(elements.sourceSelect, 'auto');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'auto', targetLanguage: 'ko' });
  h.engine.setInterpretation = () => { throw new ProviderError('SESSION_CLOSED'); };
  choose(elements.targetSelect, 'en');
  assert.equal(elements.targetSelect.value, 'ko', 'a rejected change reverts to the store');
  assert.equal(h.notice(), 'error.SESSION_CLOSED');
  await teardown(h);
  assert.equal(h.config.sessionManager.occupied, false);
});

test('diagnostic rows start, stop and cancel checks from their buttons and show per-check outcomes', async () => {
  const h = harness();
  h.keyStore.setPersonal('alpha', KEY);
  const run = (kind) => byClass(h.diagRow(kind), 'diag-check-run');
  const state = (kind) => byClass(h.diagRow(kind), 'diag-check-state').textContent;
  const message = (kind) => byClass(h.diagRow(kind), 'diag-check-message');
  assert.equal(run('live').disabled, true);
  assert.equal(state('live'), ko['capability.planned']);
  assert.equal(h.diagRow('live').getAttribute('data-state'), 'planned');
  assert.equal(byClass(h.root, 'diag-user-start').textContent, ko['diagnostics.userStart']);
  for (const kind of ['text', 'ptt', 'voice', 'microphone', 'playback']) assert.equal(clickable(run(kind)), true, kind);

  run('ptt').dispatch('click');
  assert.equal(h.capture.sessions.length, 1, 'capture starts in the gesture');
  assert.equal(run('ptt').textContent, ko['common.stop']);
  assert.equal(run('ptt').getAttribute('aria-pressed'), 'true');
  assert.equal(state('ptt'), ko['diagnostics.running']);
  for (const kind of ['text', 'voice', 'microphone', 'playback']) assert.equal(run(kind).disabled, true, `${kind} waits`);
  run('ptt').dispatch('click');
  assert.equal(h.capture.sessions[0].ended, true);
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(h.adapter.calls.length, 1);
  assert.equal(h.adapter.calls[0].name, 'stt');
  assert.equal(state('ptt'), ko['capability.available']);
  assert.equal(h.capRow('stt').getAttribute('data-state'), 'available');
  assert.equal(visible(message('ptt')), false);

  h.adapter.script.translate.push(new ProviderError('INVALID_KEY'));
  run('text').dispatch('click');
  assert.equal(run('text').textContent, ko['common.cancel']);
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(state('text'), ko['capability.failed']);
  assert.equal(visible(message('text')), true);
  assert.equal(message('text').textContent, ko['error.INVALID_KEY']);
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'failed');

  const gate = deferred();
  h.adapter.script.translate.push(() => gate.promise);
  run('text').dispatch('click');
  await until(() => h.adapter.calls.length === 3);
  run('text').dispatch('click');
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(state('text'), ko['seq.cancelled']);
  assert.equal(message('text').textContent, ko['seq.cancelled']);
  gate.resolve({ sourceText: 'x', translatedText: 'y', detectedLanguage: 'ko', status: 'ok', model: 'test-model' });
  await tick(); await tick();
  assert.equal(state('text'), ko['seq.cancelled'], 'a late reply does not revive a cancelled check');

  run('microphone').dispatch('click');
  h.capture.sessions.at(-1).finish({ status: 'silence', messageKey: 'seq.silence' });
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(state('microphone'), ko['capability.failed']);
  assert.equal(message('microphone').textContent, ko['seq.silence']);
  run('playback').dispatch('click');
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(state('playback'), ko['capability.available']);
  assert.equal(h.audio.sources.length, 1);
  assert.equal(h.adapter.calls.length, 3);
  // A thrown engine error becomes a notice, never a crash.
  h.diagnostics.close();
  run('playback').dispatch('click');
  assert.equal(h.notice(), 'error.SESSION_CLOSED');
  h.view.destroy();
  h.shell.destroy();
  await h.config.dispose();
});

test('records clearing needs confirmation, the app section shows version and form, and destroy detaches everything', async () => {
  const h = harness({ app: { version: '1.2.3', standalone: true } });
  const { elements } = h.view;
  assert.equal(h.el('settings-app-mode').textContent, ko['pwa.standalone']);
  assert.equal(h.el('settings-app-version').textContent, ko['pwa.version'].replace('{version}', '1.2.3'));
  assert.equal(elements.appActions.childNodes.length, 0, 'install controls belong to P1-19');
  assert.equal(elements.clearButton.disabled, true);
  const { turnId } = h.engine.submitText('hello');
  assert.equal(elements.clearButton.disabled, true, 'blocked while a turn is active');
  h.engine.complete(turnId, 'hello', '안녕');
  assert.equal(elements.clearButton.disabled, false);
  elements.clearButton.dispatch('click');
  assert.equal(visible(elements.clearConfirm), true);
  elements.clearConfirm.childNodes[2].dispatch('click');
  assert.equal(h.state.snapshot().turns.length, 1);
  elements.clearButton.dispatch('click');
  byClass(elements.clearConfirm, 'settings-records-clear-confirm').dispatch('click');
  assert.equal(h.state.snapshot().turns.length, 0);
  assert.equal(h.notice(), 'records.cleared');
  assert.equal(visible(elements.clearConfirm), false);

  assert.throws(() => createSettingsView({ shell: h.shell, i18n: h.i18n, config: h.config, engine: {}, diagnostics: h.diagnostics, document: h.doc }), { message: 'INVALID_REQUEST' });
  assert.throws(() => createDiagnosticsView({ root: h.root, i18n: h.i18n, document: h.doc }), { message: 'INVALID_REQUEST' });
  const rendered = [];
  const stop = h.diagnostics.subscribe(() => rendered.push(1));
  h.view.destroy();
  assert.equal(h.shell.elements.panels.settingsBody.childNodes.length, 0);
  h.keyStore.setPersonal('alpha', KEY);
  h.shell.setLanguage('en');
  h.state.setNotice('mode.changed');
  assert.equal(h.el('settings'), undefined);
  stop();
  await h.diagnostics.close();
  h.shell.destroy();
  await h.config.dispose();
  assert.equal(h.timers.pending.length, 0);
});
