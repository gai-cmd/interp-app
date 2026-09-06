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
import { acceptsDirectKey, createSettingsView, KEY_SOURCES, SETTINGS_SECTIONS, keyStoreErrorKey, sharedFragmentFrom } from '../app/ui/settings-view.js';
import { SETTING_NAMES, SETTING_LABEL_KEYS, createLockNote, createPolicyView, describeSetting, hubControlKey } from '../app/ui/policy-view.js';
import { REGISTERED_SETTINGS, validatePolicy } from '../app/policy/schema.js';
import { resolveEffective } from '../app/policy/resolve.js';
import { createPreferences } from '../app/preferences.js';
import { APP_VERSION } from '../app/version.js';
import { REGISTERED_HUB_IDS, examplePolicy, fullPolicy, policyWith, trilingual } from './fixtures/policy.mjs';
import { checkState, createDiagnosticsView, STATE_KEYS } from '../app/ui/diagnostics-view.js';
import { SecurityError } from '../app/security/redact.js';
import { createAudioPreferences } from '../app/audio/capture.js';
import { createLiveVoicePreference } from '../app/providers/gemini/live-config.js';
import { LIVE_GENDER_VOICES } from '../app/providers/gemini/live-config.js';
import { VOICE_NAMES, VOICE_PROFILES, voiceGender, voiceTone } from '../app/providers/gemini/voice.js';
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
  getDeviceVoices = null, simEngine = null, audioPreferences = undefined, voicePreference = undefined, policy = null, preferences = null } = {}) {
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
  const view = createSettingsView({ shell, i18n, config, engine, diagnostics, document: doc, persistence, app, getDeviceVoices, simEngine,
    ...(audioPreferences ? { audio: audioPreferences } : {}), ...(voicePreference ? { voicePreference } : {}), policy, preferences,
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
  for (const file of ['app/ui/settings-view.js', 'app/ui/policy-view.js', 'app/ui/diagnostics-view.js', 'app/engine/diagnostics.js']) {
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
  // Owner, 2026-09-06: each voice says how it reads and what it sounds like.
  assert.equal(h.view.elements.voiceSelect.childNodes[1].textContent, `Kore · ${ko['voice.gender.female']} · Firm`);
  assert.equal(visible(h.view.elements.deviceSelect), false);
  assert.equal(visible(h.el('settings-quota-scope')), true, 'project-scoped quota note for Gemini');
  assert.equal(h.el('settings-quota-scope').textContent, ko['quota.project']);
  assert.equal(h.el('settings-app-mode').textContent, ko['pwa.web']);
  assert.equal(visible(h.el('settings-app-version')), false);
  assert.equal(byClass(h.root, 'diag-scope').textContent, ko['diagnostics.scope']);
  for (const [name, state] of [['translate', 'untested'], ['stt', 'untested'], ['live', 'untested'], ['voice', 'untested']]) {
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
    // P3-19: the first section is display·language (settings.section.display), not the P1 language title.
    assert.equal(byClass(h.root, 'settings-section-title').textContent, dictionary['settings.section.display']);
    assert.equal(byClass(h.diagRow('text'), 'diag-check-label').textContent, dictionary['diagnostics.text']);
    assert.equal(byClass(h.capRow('live'), 'diag-capability-state').textContent, dictionary['capability.untested']);
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
  assert.equal(elements.rememberInput.checked, true);
  elements.rememberInput.checked = false; // Exercise the explicit session-only choice.
  elements.keyInput.value = `  ${KEY}  `;
  elements.keyInput.dispatch('input');
  const submit = h.el('settings-key-form').dispatch('submit');
  assert.equal(submit.defaultPrevented, true);
  // P3-22 (owner, 2026-09-06): the field shows a mask of the stored key after
  // a save instead of looking empty; the value itself is gone from the DOM.
  assert.equal(elements.keyInput.value, '\u2022'.repeat(KEY.length), 'the saved key is represented by a mask of its length');
  assert.equal(elements.keyInput.value.includes(KEY), false, 'the value never stays in the field');
  assert.equal(elements.keyInput.getAttribute('type'), 'password');
  assert.deepEqual(h.keyStore.getMetadata('alpha', 'personal'),
    { providerId: 'alpha', keySource: 'personal', remembered: false, length: KEY.length });
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
  // Typing is what clears the mask; assigning .value alone is not a keystroke.
  elements.keyInput.value = 'REMEMBERED-SECRET-KEY';
  elements.keyInput.dispatch('input');
  h.el('settings-key-form').dispatch('submit');
  assert.equal(storage.map.get('interp-app.personal-key.v1.alpha'), 'REMEMBERED-SECRET-KEY');
  assert.equal(elements.keyStatus.getAttribute('data-key'), 'remembered');
  assert.equal(elements.keyStatus.textContent, ko['settings.keyStored']);
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'untested', 'a new key invalidates the old result');
  assert.equal(h.adapter.calls.length, 1, 'still no automatic check');
  assert.equal(/SECRET/.test(domText(h.root)), false);

  elements.keyInput.value = 'bad key with spaces';
  elements.keyInput.dispatch('input');
  h.el('settings-key-form').dispatch('submit');
  assert.equal(h.notice(), 'error.INVALID_KEY');
  // A rejected key leaves the field showing the mask of the key still stored.
  assert.equal(elements.keyInput.value, '\u2022'.repeat('REMEMBERED-SECRET-KEY'.length));
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
  // Owner, 2026-09-06: the preview is how someone picks between 30 voices, so
  // it still plays when the interpretation output is routed elsewhere. What
  // changes is that the screen says so instead of leaving a dead button.
  assert.equal(elements.previewButton.disabled, false, 'the preview plays whatever the output route is');
  assert.equal(h.el('settings-voice-preview-note').hidden, false);
  assert.equal(h.el('settings-voice-preview-note').textContent,
    ko['voice.previewNotOutput'].replace('{output}', ko['voice.device']));
  choose(elements.outputSelect, 'provider');
  assert.equal(h.el('settings-voice-preview-note').hidden, true, 'nothing to say when the button just works');
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


test('key save feedback is inline, localized and distinguishes persistence, memory and failures', async t => {
  const storage = fakeStorage();
  const h = harness({ config: fixtureConfig({ storage }), persistence: true });
  t.after(() => teardown(h));
  const e = h.view.elements;
  assert.equal(e.rememberInput.checked, true);
  assert.equal(h.el('settings-remember').textContent.includes(ko['settings.rememberWarning']), true);
  // Typing replaces the mask (the input event is what a person produces).
  const save = value => { e.keyInput.value = value; e.keyInput.dispatch('input'); h.el('settings-key-form').dispatch('submit'); };
  save(KEY);
  assert.equal(e.keyFeedback.textContent, ko['keyGuide.saved.browser']);
  assert.equal(e.keyFeedback.hidden, false);
  assert.equal(e.keyStatus.getAttribute('data-key'), 'remembered');
  assert.equal(storage.map.size, 1);
  for (const lang of ['en', 'ja', 'ko']) {
    h.shell.setLanguage(lang);
    assert.equal(e.keyFeedback.textContent, dictionaries[lang]['keyGuide.saved.browser']);
  }
  e.rememberInput.checked = false; save(KEY);
  assert.equal(e.keyFeedback.textContent, ko['keyGuide.saved.session']);
  assert.equal(e.keyStatus.getAttribute('data-key'), 'memory'); assert.equal(storage.map.size, 0);
  save(''); assert.equal(e.keyFeedback.textContent, ko['error.INVALID_KEY']);
  save('bad key'); assert.equal(e.keyFeedback.textContent, ko['error.INVALID_KEY']);
  e.rememberInput.checked = true;
  storage.setItem = () => { throw Error('SECRET'); }; save(KEY);
  assert.equal(e.keyFeedback.textContent, ko['error.STORAGE_FAILED']);
  assert.equal(e.keyStatus.getAttribute('data-key'), 'none');
  assert.doesNotMatch(domText(h.root), /SECRET/);
});

test('settings exposes both Live models and applies selection without starting interpretation', async t => {
  const calls = [];
  const simEngine = { model: 'gemini-3.5-live-translate-preview', async setModel(model) { calls.push(model); this.model = model; } };
  const h = harness({ simEngine }); t.after(() => teardown(h));
  const select = h.view.elements.modelSelect;
  assert.ok(options(select).includes('gemini-3.1-flash-live-preview'));
  choose(select, 'gemini-3.1-flash-live-preview'); await tick();
  assert.deepEqual(calls, ['gemini-3.1-flash-live-preview']);
  assert.equal(select.disabled, false);
});

// P3-02d: audio section (speech-only defaults) and the shared simultaneous voice.
test('audio section: speech-only defaults on, toggles write the shared preferences, applied settings are shown', async t => {
  const audio = createAudioPreferences();
  const h = harness({ audioPreferences: audio }); t.after(() => teardown(h));
  const { elements } = h.view;
  const section = elements.sections.audio;
  // P3-19: the audio section carries the §1.12 title (microphone and audio devices) and a hint.
  assert.equal(section.childNodes[0].textContent, ko['settings.section.audio']);
  assert.equal(section.childNodes[1].textContent, ko['settings.sectionHint.audio']);
  assert.ok(section.parentNode.childNodes.indexOf(section) < section.parentNode.childNodes.indexOf(elements.sections.diagnostics));
  assert.equal(elements.noiseInput.checked, true); assert.equal(elements.filterInput.checked, true);
  assert.equal(elements.sensitivitySelect.value, 'normal');
  assert.deepEqual(options(elements.sensitivitySelect), ['low', 'normal', 'high']);
  assert.equal(elements.sensitivitySelect.childNodes[1].textContent, ko['audio.sensitivity.normal']);
  assert.equal(elements.appliedLine.hidden, true, 'nothing applied before a capture');
  for (const key of ['audio.description', 'audio.noiseSuppressionHelp', 'audio.voiceFilterHelp', 'audio.sensitivityHelp']) {
    assert.equal(all(section, (node) => node.textContent === ko[key]).length, 1, key);
  }
  elements.noiseInput.checked = false; elements.noiseInput.dispatch('change');
  assert.equal(audio.snapshot().noiseSuppression, false);
  elements.filterInput.checked = false; elements.filterInput.dispatch('change');
  assert.equal(audio.snapshot().voiceFilter, false);
  choose(elements.sensitivitySelect, 'high');
  assert.equal(audio.snapshot().sensitivity, 'high');
  assert.deepEqual(h.engine.calls, [], 'audio preferences never touch the sequential engine');
  // A capture reports what the browser applied; the line renders on/off/unknown per constraint and follows the UI language.
  audio.recordApplied({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, deviceId: 'SECRET' });
  assert.equal(elements.appliedLine.hidden, false);
  const text = elements.appliedLine.textContent;
  assert.ok(text.startsWith(`${ko['audio.applied']}: `));
  assert.ok(text.includes(`${ko['audio.echoCancellation']} ${ko['audio.on']}`));
  assert.ok(text.includes(`${ko['audio.noiseSuppression']} ${ko['audio.off']}`));
  assert.ok(text.includes(`${ko['audio.voiceIsolation']} ${ko['audio.unknown']}`));
  assert.doesNotMatch(domText(h.root), /SECRET/);
  h.shell.setLanguage('en');
  assert.ok(elements.appliedLine.textContent.startsWith(`${dictionaries.en['audio.applied']}: `));
  assert.equal(elements.noiseInput.checked, false, 'a refresh keeps the store values');
  // Another owner changing the store re-renders the controls.
  audio.set({ noiseSuppression: true, sensitivity: 'low' });
  assert.equal(elements.noiseInput.checked, true); assert.equal(elements.sensitivitySelect.value, 'low');
  audio.recordApplied(null); assert.equal(elements.appliedLine.hidden, true);
});

test('the provider voice picker and the simultaneous female/male choice share one value; a live session gets a restart notice', async t => {
  const voicePreference = createLiveVoicePreference();
  const simEngine = { model: 'gemini-3.5-live-translate-preview', busy: false, snapshot() { return { busy: this.busy }; }, async setModel() {} };
  const h = harness({ voicePreference, simEngine }); t.after(() => teardown(h));
  const { elements } = h.view;
  assert.deepEqual(options(elements.voiceSelect), ['', 'Kore', 'Orus']);
  // Settings -> simultaneous: an explicit voice becomes the live voice.
  choose(elements.voiceSelect, 'Orus');
  assert.deepEqual(h.engine.calls.at(-1), ['setVoice', { voice: 'Orus' }]);
  assert.deepEqual(voicePreference.snapshot(), { gender: 'male', voice: null, voiceName: 'Orus' });
  assert.equal(h.notice(), null, 'no restart notice while nothing is running');
  // Simultaneous -> settings: the gender choice lands as the matching provider voice.
  voicePreference.set({ gender: 'female' });
  assert.deepEqual(h.engine.calls.at(-1), ['setVoice', { voice: 'Kore' }]);
  assert.equal(h.state.snapshot().voice.voice, 'Kore'); assert.equal(elements.voiceSelect.value, 'Kore');
  const calls = h.engine.calls.length;
  voicePreference.set({ voice: 'Zephyr' });
  assert.equal(h.engine.calls.length, calls, 'a voice the provider does not list is not mirrored');
  assert.equal(h.state.snapshot().voice.voice, 'Kore');
  // Changing the voice during a live session keeps it running and asks for a restart.
  simEngine.busy = true;
  choose(elements.voiceSelect, 'Orus');
  assert.equal(h.notice(), 'sim.voiceRestart');
  assert.equal(voicePreference.snapshot().voiceName, 'Orus');
  assert.equal(h.adapter.calls.length, 0, 'choosing a voice opens no session');
  // Destroy unsubscribes: later preference changes no longer reach the engine.
  h.view.destroy();
  const after = h.engine.calls.length;
  voicePreference.set({ gender: 'female' });
  assert.equal(h.engine.calls.length, after);
});

// P3-19 (design-p3 §1.6, §1.12): section order, policy locks and the policy view.
const NOW = Date.parse('2026-09-06T01:00:00Z');
const NAMES = SETTING_NAMES;
// Stand-in for createPolicyRuntime(): the same snapshot shape, computed with
// the real validator and resolver; publish()/setStatus()/setHubControl() emit
// like the runtime, refresh() is settled by the test.
function policyDouble({ policy = examplePolicy(), status = 'ready', preferences = null, appVersion = APP_VERSION, fetchedAt = NOW, hubControl = null } = {}) {
  const listeners = new Set();
  const state = { policy: null, status, hubControl, fetchedAt, refreshes: [], pending: [] };
  const validated = (doc) => {
    if (doc === null) return null;
    const result = validatePolicy(doc, { registeredHubIds: REGISTERED_HUB_IDS, now: NOW });
    assert.ok(result.ok, JSON.stringify(result.issues));
    return result.policy;
  };
  state.policy = validated(policy);
  const snapshot = () => {
    const effective = resolveEffective({ policy: state.policy, preferences, event: null, hubControl: state.hubControl, appVersion, now: NOW });
    const blocked = state.policy === null ? { code: state.status === 'loading' ? 'POLICY_LOADING' : 'POLICY_UNAVAILABLE', revision: null } : effective.blocked;
    return Object.freeze({ status: state.status, revision: state.policy?.revision ?? null, fetchedAt: state.fetchedAt, error: null, policy: state.policy,
      blocked, settings: effective.settings, features: effective.features, event: null, eventId: null, hubControl: state.hubControl, cleanup: 'idle', appVersion });
  };
  const emit = (change) => {
    const current = snapshot();
    const frozen = Object.freeze({ type: 'status', stop: false, reopened: false, display: false, pricing: false, revisionChanged: false, ...change });
    for (const listener of [...listeners]) listener(current, frozen);
  };
  preferences?.subscribe?.(() => emit({ type: 'preference' }));
  return { snapshot, state, listeners,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh({ reason }) { state.refreshes.push(reason); return new Promise((resolve, reject) => state.pending.push({ resolve, reject })); },
    publish(doc, change = { type: 'updated', revisionChanged: true }) { state.policy = validated(doc); state.status = 'ready'; emit(change); },
    setStatus(status) { state.status = status; emit({ type: 'status' }); },
    setHubControl(control) { state.hubControl = control; emit({ type: 'hubControl' }); },
    settle(ok = true) { const next = state.pending.shift(); if (ok) next.resolve(snapshot()); else next.reject(new Error('SECRET')); } };
}
const control = (overrides = {}) => ({ supported: true, eventId: 'service-20260906', epoch: 1, revision: 3, stopped: false, heartbeatLost: false,
  disabledFeatures: [], expiresAt: null, ...overrides });
// Visible text parts of a lock note or list item (the padlock is CSS-drawn and aria-hidden).
const lockText = (node) => node.childNodes.filter((child) => !child.hidden && !child.classes.has('settings-lock-icon')).map((child) => child.textContent);

test('sections follow the §1.12 order with titles and hints; P1 element names, the PWA insertion point and the diagnostics view survive the move', async t => {
  const h = harness({ app: { version: 'r-2026-09-06', standalone: false } }); t.after(() => teardown(h));
  const { elements, element } = h.view;
  const { sections } = elements;
  assert.deepEqual([...SETTINGS_SECTIONS], ['display', 'interpretation', 'provider', 'sharedKey', 'billing', 'audio', 'diagnostics', 'records', 'app', 'terms']);
  assert.deepEqual(element.childNodes.map((node) => node.getAttribute('data-section')), [...SETTINGS_SECTIONS]);
  for (const name of SETTINGS_SECTIONS) {
    const section = sections[name];
    assert.equal(element.childNodes.indexOf(section) >= 0, true, name);
    assert.equal(section.tagName, 'SECTION');
    const [title, hint] = section.childNodes;
    assert.equal(title.tagName, 'H3');
    assert.equal(title.textContent, ko[`settings.section.${name}`], name);
    assert.equal(hint.textContent, ko[`settings.sectionHint.${name}`], name);
    assert.equal(section.getAttribute('aria-labelledby'), title.getAttribute('id'));
  }
  // P1-16 names stay usable: they point at the section or block that now holds the same controls.
  assert.equal(sections.language, sections.display);
  assert.equal(sections.notices, sections.terms);
  assert.equal(sections.display.contains(elements.uiSelect), true);
  assert.equal(sections.display.contains(elements.displayControls), true);
  assert.equal(elements.displayControls.childNodes.length, 0, 'display controls belong to P3-20');
  assert.equal(visible(byClass(sections.display, 'settings-note')), false, 'the UI-language lock note needs a policy');
  assert.equal(sections.interpretation.contains(elements.sourceSelect), true);
  assert.equal(sections.interpretation.contains(elements.targetSelect), true);
  assert.equal(sections.interpretation.contains(sections.voice), true);
  for (const name of ['outputSelect', 'voiceSelect', 'previewButton', 'deviceSelect', 'modelSelect']) assert.equal(sections.voice.contains(elements[name]), true, name);
  assert.equal(sections.provider.contains(elements.providerTitle), true);
  assert.equal(sections.provider.contains(elements.providerSelect), true);
  assert.equal(sections.provider.contains(sections.key), true);
  for (const name of ['keyInput', 'rememberInput', 'saveButton', 'checkButton', 'deleteButton', 'keyStatus', 'keyFeedback']) assert.equal(sections.key.contains(elements[name]), true, name);
  assert.equal(sections.sharedKey.contains(sections.shared), true);
  assert.equal(sections.sharedKey.contains(sections.mode), true);
  for (const name of ['sharedInput', 'sharedImport', 'sharedEnd', 'sharedEvent']) assert.equal(sections.shared.contains(elements[name]), true, name);
  assert.equal(sections.mode.contains(elements.modeInputs.personal), true);
  assert.equal(sections.mode.contains(elements.modeInputs.shared), true);
  // P3-31 landed: title, hint and the mount its plan/usage controls fill.
  assert.equal(sections.billing.childNodes.length, 3, 'title, hint and the P3-31 controls block');
  assert.ok(sections.billing.contains(elements.billingControls));
  for (const name of ['noiseInput', 'filterInput', 'sensitivitySelect', 'appliedLine']) assert.equal(sections.audio.contains(elements[name]), true, name);
  assert.equal(sections.records.contains(elements.clearButton), true);
  assert.equal(sections.app.contains(elements.appActions), true);
  assert.equal(sections.terms.contains(h.el('settings-quota-scope')), true);
  // The PWA controls (P1-19) and the composition root's retention note (P3-02e) still land in their sections.
  const pwaMarker = h.doc.createElement('div');
  elements.appActions.append(pwaMarker);
  assert.equal(sections.app.contains(pwaMarker), true);
  assert.equal(h.el('settings-app-version').textContent, ko['pwa.version'].replace('{version}', 'r-2026-09-06'));
  const retention = h.doc.createElement('p');
  sections.key.append(retention);
  assert.equal(sections.provider.contains(retention), true);
  // The diagnostics view is the same object and its per-check buttons still run.
  assert.equal(h.view.diagnosticsView.element.parentNode, sections.diagnostics);
  assert.equal(clickable(byClass(h.diagRow('playback'), 'diag-check-run')), true);
  byClass(h.diagRow('playback'), 'diag-check-run').dispatch('click');
  await until(() => h.diagnostics.snapshot().running === null);
  assert.equal(h.capRow('translate').getAttribute('data-state'), 'untested');
  assert.equal(byClass(h.diagRow('playback'), 'diag-check-state').textContent, ko['capability.available']);
  // Without a policy runtime nothing is locked and no policy block exists.
  assert.equal(h.view.policyView, null);
  assert.equal(elements.policy, null);
  assert.deepEqual(elements.locks, { sourceSelect: null, targetSelect: null, outputSelect: null });
  assert.equal(byClass(h.root, 'policy'), undefined);
  assert.equal(elements.targetSelect.disabled, false);
  assert.equal(elements.targetSelect.getAttribute('aria-describedby'), null);
  for (const language of ['en', 'ja']) {
    h.shell.setLanguage(language);
    for (const name of SETTINGS_SECTIONS) {
      assert.equal(sections[name].childNodes[0].textContent, dictionaries[language][`settings.section.${name}`], `${language} ${name}`);
      assert.equal(sections[name].childNodes[1].textContent, dictionaries[language][`settings.sectionHint.${name}`], `${language} ${name}`);
    }
  }
  // Helpers of the policy view.
  assert.deepEqual(describeSetting(null), { locked: false, sourceKey: null, reasonKey: null, allowed: null });
  assert.deepEqual(describeSetting({ value: 'ko', source: 'personal', allowed: ['ko', 'en'], locked: false, reasonKey: 'policy.lock.restricted' }),
    { locked: false, sourceKey: null, reasonKey: 'policy.lock.restricted', allowed: ['ko', 'en'] });
  assert.deepEqual(describeSetting({ value: 'ko', source: 'policyDefault', allowed: { min: 1, max: 2, step: 0.125 }, locked: false, reasonKey: null }),
    { locked: false, sourceKey: 'policy.source.policyDefault', reasonKey: null, allowed: null });
  assert.equal(describeSetting({ value: 'ko', source: 'forced', allowed: ['ko'], locked: true, reasonKey: 'policy.lock.forced' }).sourceKey, 'policy.source.forced');
  assert.equal(hubControlKey(null), null);
  assert.equal(hubControlKey(control()), 'hubControl.supported');
  assert.equal(hubControlKey(control({ supported: false })), 'hubControl.unsupported');
  assert.equal(hubControlKey(control({ stopped: true, heartbeatLost: true })), 'hubControl.stopped');
  assert.equal(hubControlKey(control({ heartbeatLost: true })), 'hubControl.lost');
  for (const [name, label] of Object.entries(SETTING_LABEL_KEYS)) {
    assert.ok(Object.hasOwn(REGISTERED_SETTINGS, name), name);
    for (const language of SUPPORTED_LANGUAGES) assert.ok(Object.hasOwn(dictionaries[language], label), `${language} ${label}`);
  }
  assert.deepEqual(Object.keys(SETTING_LABEL_KEYS).sort(), Object.keys(REGISTERED_SETTINGS).sort());
  assert.throws(() => createLockNote({ document: h.doc, i18n: h.i18n, control: elements.targetSelect }), { message: 'INVALID_REQUEST' });
  assert.throws(() => createPolicyView({ root: h.root, i18n: h.i18n, document: h.doc, policy: {} }), { message: 'INVALID_REQUEST' });
  assert.throws(() => createSettingsView({ shell: h.shell, i18n: h.i18n, config: h.config, engine: h.engine, diagnostics: h.diagnostics, document: h.doc, policy: { snapshot() {} } }),
    { message: 'INVALID_REQUEST' });
});

test('policy locks: a forced value disables the control with a padlock and a linked reason, a narrowed range hides options, defaults are labelled and personal choices are recorded', async t => {
  const preferences = createPreferences({ storage: fakeStorage(), now: () => NOW });
  const policy = policyDouble({ preferences, policy: policyWith((doc) => {
    doc.settings[NAMES.targetLanguage] = { default: 'en', allowed: ['en'], locked: true };
    doc.settings[NAMES.sourceLanguage] = { default: 'ko', allowed: ['ko', 'en'], locked: false };
    doc.settings[NAMES.voiceOutput] = { default: 'device', allowed: ['provider', 'device', 'off'], locked: false };
  }) });
  const h = harness({ policy, preferences }); t.after(() => teardown(h));
  const { elements } = h.view;
  const { locks } = elements;
  // Effective values reached the engine at mount: the forced target and the administrator defaults.
  assert.deepEqual(h.engine.calls, [['setInterpretation', { sourceLanguage: 'ko', targetLanguage: 'en' }], ['setVoice', { output: 'device' }]]);
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'en' });
  assert.equal(h.state.snapshot().voice.output, 'device');
  assert.equal(preferences.get(NAMES.targetLanguage), null, 'effective values are never written as personal choices');
  assert.equal(visible(byClass(elements.sections.display, 'settings-note')), true, 'the UI language cannot be locked');
  assert.equal(byClass(elements.sections.display, 'settings-note').textContent, ko['policy.lock.uiLanguage']);
  // Forced target: disabled, padlock, "value set by the administrator", reason, aria-describedby.
  assert.equal(elements.targetSelect.disabled, true);
  assert.equal(elements.targetSelect.value, 'en');
  assert.equal(elements.targetSelect.getAttribute('aria-describedby'), locks.targetSelect.getAttribute('id'));
  assert.equal(locks.targetSelect.parentNode, elements.targetSelect.parentNode, 'the note sits in the control row');
  assert.equal(locks.targetSelect.hidden, false);
  assert.equal(locks.targetSelect.getAttribute('data-locked'), 'true');
  assert.equal(locks.targetSelect.getAttribute('data-source'), 'forced');
  assert.equal(byClass(locks.targetSelect, 'settings-lock-icon').hidden, false);
  assert.equal(byClass(locks.targetSelect, 'settings-lock-icon').getAttribute('aria-hidden'), 'true');
  assert.deepEqual(lockText(locks.targetSelect), [ko['policy.lock.label'], ko['policy.source.forced'], ko['policy.lock.forced']]);
  assert.deepEqual(options(elements.targetSelect), ['ko', 'en', 'ja']);
  assert.deepEqual(elements.targetSelect.childNodes.map((option) => option.hidden), [true, false, true]);
  // Narrowed source: enabled, disallowed options hidden and disabled, restriction reason, default labelled.
  assert.equal(elements.sourceSelect.disabled, false);
  assert.deepEqual(elements.sourceSelect.childNodes.map((option) => [option.getAttribute('value'), option.hidden, option.disabled]),
    [['auto', true, true], ['ko', false, false], ['en', false, false], ['ja', true, true]]);
  assert.equal(elements.sourceSelect.getAttribute('aria-describedby'), locks.sourceSelect.getAttribute('id'));
  assert.equal(locks.sourceSelect.getAttribute('data-locked'), 'false');
  assert.equal(byClass(locks.sourceSelect, 'settings-lock-icon').hidden, true);
  assert.deepEqual(lockText(locks.sourceSelect), [ko['policy.source.policyDefault'], ko['policy.lock.restricted']]);
  // Administrator default without restriction: label only.
  assert.equal(elements.outputSelect.disabled, false);
  assert.deepEqual(lockText(locks.outputSelect), [ko['policy.source.policyDefault']]);
  assert.equal(elements.outputSelect.getAttribute('aria-describedby'), locks.outputSelect.getAttribute('id'));
  // The policy view lists the locked and restricted settings with their reasons.
  const items = elements.policy.lockList.childNodes;
  assert.deepEqual(items.map((item) => [item.getAttribute('data-setting'), item.getAttribute('data-locked')]),
    [[NAMES.sourceLanguage, 'false'], [NAMES.targetLanguage, 'true']]);
  assert.deepEqual(lockText(items[1]), [ko['language.target'], ko['policy.source.forced'], ko['policy.lock.forced']]);
  assert.deepEqual(lockText(items[0]), [ko['language.source'], ko['policy.source.policyDefault'], ko['policy.lock.restricted']]);
  assert.equal(elements.policy.locks.hidden, false);
  assert.deepEqual(elements.policy.featureList.childNodes.map((item) => item.getAttribute('data-feature')), ['sharedKeys'], 'the §1.4 example keeps shared keys off');
  // A personal choice is recorded; the resolver then reports it and the default label disappears.
  choose(elements.outputSelect, 'off');
  assert.equal(h.state.snapshot().voice.output, 'off');
  assert.equal(preferences.get(NAMES.voiceOutput), 'off');
  assert.equal(policy.snapshot().settings[NAMES.voiceOutput].source, 'personal');
  assert.equal(locks.outputSelect.hidden, true);
  assert.equal(elements.outputSelect.getAttribute('aria-describedby'), null);
  // A source equal to the forced target has no allowed replacement: the engine rejects it and nothing is recorded.
  choose(elements.sourceSelect, 'en');
  assert.equal(preferences.get(NAMES.sourceLanguage), null);
  assert.equal(h.notice(), 'error.INVALID_REQUEST');
  assert.equal(elements.sourceSelect.value, 'ko', 'a rejected change reverts to the store');
  h.state.setNotice(null);
  choose(elements.sourceSelect, 'ko');
  assert.equal(preferences.get(NAMES.sourceLanguage), 'ko');
  assert.deepEqual(lockText(locks.sourceSelect), [ko['policy.lock.restricted']], 'a personal choice inside the range keeps only the restriction');
  assert.equal(policy.snapshot().settings[NAMES.sourceLanguage].source, 'personal');
  // A wider policy unlocks the control, restores the options and keeps the personal choices; nothing restarts.
  const before = h.engine.calls.length;
  policy.publish(examplePolicy());
  assert.equal(elements.targetSelect.disabled, false);
  assert.equal(elements.targetSelect.getAttribute('aria-describedby'), null);
  assert.equal(locks.targetSelect.hidden, true);
  assert.equal(locks.targetSelect.getAttribute('data-locked'), 'false');
  assert.deepEqual(elements.sourceSelect.childNodes.map((option) => option.hidden), [false, false, false, false]);
  assert.equal(elements.policy.lockList.childNodes.length, 0);
  assert.equal(elements.policy.locks.hidden, false, 'the shared-key feature is still listed as off');
  assert.equal(h.engine.calls.length, before, 'personal choices are not rewritten on a wider policy');
  assert.deepEqual(h.state.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'en' });
  // A forced value arriving later is written to the engine even though a personal choice exists.
  policy.publish(policyWith((doc) => { doc.settings[NAMES.voiceOutput] = { default: 'provider', allowed: ['provider'], locked: true }; }));
  assert.deepEqual(h.engine.calls.at(-1), ['setVoice', { output: 'provider' }]);
  assert.equal(elements.outputSelect.disabled, true);
  assert.deepEqual(lockText(locks.outputSelect), [ko['policy.lock.label'], ko['policy.source.forced'], ko['policy.lock.forced']]);
  assert.equal(preferences.get(NAMES.voiceOutput), 'off', 'the personal choice survives the lock');
  h.shell.setLanguage('en');
  assert.deepEqual(lockText(locks.outputSelect), [dictionaries.en['policy.lock.label'], dictionaries.en['policy.source.forced'], dictionaries.en['policy.lock.forced']]);
  assert.deepEqual(lockText(elements.policy.lockList.childNodes[0]), [dictionaries.en['voice.output'], dictionaries.en['policy.source.forced'], dictionaries.en['policy.lock.forced']]);
  assert.doesNotMatch(domText(h.root), /SECRET/);
  // Destroy unsubscribes from the policy: a later lock no longer reaches the engine.
  h.view.destroy();
  assert.equal(policy.listeners.size, 0);
  const after = h.engine.calls.length;
  policy.publish(policyWith((doc) => { doc.settings[NAMES.voiceOutput] = { default: 'off', allowed: ['off'], locked: true }; }));
  assert.equal(h.engine.calls.length, after);
});

test('the policy view shows the app version apart from the release ID, revision and dates, the block reason with revision and recheck, features off and hub control', async t => {
  const policy = policyDouble({ policy: fullPolicy() });
  const h = harness({ policy, app: { version: 'r-2026-09-06' } }); t.after(() => teardown(h));
  const p = h.view.elements.policy;
  const date = (value) => h.i18n.formatDate(new Date(value), { dateStyle: 'medium', timeStyle: 'short' });
  assert.equal(h.view.policyView.element.parentNode, h.view.elements.sections.app);
  assert.equal(h.el('settings-app-version').textContent, ko['pwa.version'].replace('{version}', 'r-2026-09-06'), 'the release ID line');
  assert.equal(p.appVersion.textContent, APP_VERSION, 'the numeric app version');
  assert.notEqual(p.appVersion.textContent, 'r-2026-09-06');
  assert.equal(p.status.textContent, ko['policy.status.ready']);
  assert.equal(p.status.getAttribute('data-status'), 'ready');
  assert.equal(p.revision.textContent, '7');
  assert.equal(p.publishedAt.textContent, date('2026-09-06T00:00:00Z'));
  assert.equal(p.validUntil.textContent, date('2026-12-31T23:59:59Z'));
  assert.equal(p.minAppVersion.textContent, '0.7.0');
  assert.equal(p.fetchedAt.textContent, date(NOW));
  // Emergency stop: reason, revision, three-language administrator text, persistent note.
  assert.equal(p.blocked.hidden, false);
  assert.equal(p.blocked.getAttribute('data-code'), 'POLICY_STOPPED');
  assert.equal(p.blockedReason.textContent, ko['error.POLICY_STOPPED']);
  assert.equal(p.blockedRevision.textContent, ko['policy.blocked.revision'].replace('{revision}', '7'));
  assert.equal(p.emergency.textContent, 'reason 한국어');
  assert.equal(p.emergency.parentNode.hidden, false);
  assert.equal(p.updateHint.hidden, true);
  assert.equal(visible(byClass(p.blocked, 'policy-blocked-persistent')), true);
  // Lock list: the forced tone and the narrowed caption range of the full policy.
  assert.deepEqual(p.lockList.childNodes.map((item) => item.getAttribute('data-setting')), [NAMES.tone, NAMES.captionsSize]);
  assert.deepEqual(lockText(p.lockList.childNodes[0]), [ko['display.tone'], ko['policy.source.forced'], ko['policy.lock.forced']]);
  assert.deepEqual(lockText(p.lockList.childNodes[1]), [ko['display.captions.size'], ko['policy.source.policyDefault'], ko['policy.lock.restricted']]);
  assert.equal(p.featureList.childNodes.length, 0);
  assert.equal(p.hub.hidden, true);
  h.shell.setLanguage('en');
  assert.equal(p.emergency.textContent, 'reason English');
  assert.equal(p.status.textContent, dictionaries.en['policy.status.ready']);
  assert.equal(p.blockedReason.textContent, dictionaries.en['error.POLICY_STOPPED']);
  assert.equal(p.publishedAt.textContent, h.i18n.formatDate(new Date('2026-09-06T00:00:00Z'), { dateStyle: 'medium', timeStyle: 'short' }));
  h.shell.setLanguage('ko');
  // Recheck: one manual refresh, disabled until it settles; a failure becomes a notice.
  p.recheck.dispatch('click');
  assert.deepEqual(policy.state.refreshes, ['manual']);
  assert.equal(p.recheck.disabled, true);
  assert.equal(p.recheck.getAttribute('aria-busy'), 'true');
  p.recheck.dispatch('click');
  assert.deepEqual(policy.state.refreshes, ['manual'], 'no second request while one is pending');
  policy.settle(true);
  await until(() => p.recheck.disabled === false);
  assert.equal(h.notice(), null);
  p.recheck.dispatch('click');
  policy.settle(false);
  await until(() => p.recheck.disabled === false);
  assert.equal(h.notice(), 'policy.status.failed');
  assert.doesNotMatch(domText(h.root), /SECRET/);
  h.state.setNotice(null);
  // Hub live control while an event is joined.
  policy.setHubControl(control());
  assert.equal(p.hub.hidden, false);
  assert.equal(p.hubState.textContent, ko['hubControl.supported']);
  assert.equal(p.hubState.getAttribute('data-state'), 'supported');
  assert.equal(p.hubRevision.textContent, ko['hubControl.revision'].replace('{revision}', '3'));
  policy.setHubControl(control({ stopped: true, revision: 4 }));
  assert.equal(p.hubState.textContent, ko['hubControl.stopped']);
  assert.equal(p.hubRevision.textContent, ko['hubControl.revision'].replace('{revision}', '4'));
  policy.setHubControl(null);
  assert.equal(p.hub.hidden, true);
  // Features turned off are listed with their reason (the §1.4 example keeps shared keys off); the lifted stop hides the block.
  policy.publish(policyWith((doc) => { doc.features.diagnostics = false; doc.features.simultaneousDirect = false; }));
  assert.equal(p.blocked.hidden, true);
  assert.deepEqual(p.featureList.childNodes.map((item) => item.getAttribute('data-feature')), ['simultaneousDirect', 'diagnostics', 'sharedKeys']);
  assert.deepEqual(lockText(p.featureList.childNodes[1]), [ko['admin.feature.diagnostics'], ko['policy.featureOff']]);
  assert.deepEqual(lockText(p.featureList.childNodes[2]), [ko['admin.feature.sharedKeys'], ko['policy.featureOff']]);
  assert.equal(p.lockList.childNodes.length, 0);
  assert.equal(p.locks.hidden, false);
  assert.equal(p.validUntil.textContent, ko['policy.noExpiry']);
  assert.equal(p.revision.textContent, '1');
  // Status changes re-render the badge; stale keeps the facts.
  policy.setStatus('stale');
  assert.equal(p.status.textContent, ko['policy.status.stale']);
  assert.equal(p.revision.textContent, '1');
});

test('the policy view before the first reply, with a too-old app and without a refresh function', async t => {
  const loading = policyDouble({ policy: null, status: 'loading' });
  const a = harness({ policy: loading }); t.after(() => teardown(a));
  const pa = a.view.elements.policy;
  assert.equal(pa.status.textContent, ko['policy.status.loading']);
  assert.equal(pa.revision.textContent, ko['policy.none']);
  assert.equal(pa.publishedAt.textContent, ko['policy.none']);
  assert.equal(pa.validUntil.textContent, ko['policy.none']);
  assert.equal(pa.minAppVersion.textContent, ko['policy.none']);
  assert.equal(pa.appVersion.textContent, APP_VERSION);
  assert.equal(pa.blocked.getAttribute('data-code'), 'POLICY_LOADING');
  assert.equal(pa.blockedReason.textContent, ko['error.POLICY_LOADING']);
  assert.equal(pa.blockedRevision.hidden, true);
  assert.equal(pa.emergency.parentNode.hidden, true);
  assert.equal(pa.featureList.childNodes.length, 0, 'no policy: the block reason speaks, features are not itemised');
  assert.equal(pa.locks.hidden, true, 'app defaults are not locks');
  assert.deepEqual(a.engine.calls, [], 'no policy, nothing written to the engine');
  assert.equal(a.view.elements.targetSelect.disabled, false);
  assert.equal(a.view.elements.locks.targetSelect.hidden, true);
  // The first reply arrives as an initial change: defaults apply only with a preference store, so the engine keeps its pair here.
  loading.publish(examplePolicy(), { type: 'initial' });
  assert.equal(pa.status.textContent, ko['policy.status.ready']);
  assert.equal(pa.blocked.hidden, true);
  assert.deepEqual(a.engine.calls, []);
  assert.deepEqual(lockText(a.view.elements.locks.targetSelect), [ko['policy.source.policyDefault']]);

  const old = policyDouble({ policy: policyWith((doc) => { doc.minAppVersion = '9.0.0'; }), appVersion: '0.7.0' });
  const b = harness({ policy: old }); t.after(() => teardown(b));
  const pb = b.view.elements.policy;
  assert.equal(pb.blocked.getAttribute('data-code'), 'APP_VERSION_TOO_OLD');
  assert.equal(pb.blockedReason.textContent, ko['error.APP_VERSION_TOO_OLD']);
  assert.equal(pb.updateHint.hidden, false);
  assert.equal(pb.updateHint.textContent, ko['policy.blocked.updateHint']);
  assert.equal(pb.minAppVersion.textContent, '9.0.0');

  const fixed = policyDouble();
  const c = harness({ policy: { snapshot: fixed.snapshot, subscribe: fixed.subscribe } }); t.after(() => teardown(c));
  assert.equal(c.view.elements.policy.recheck.disabled, true, 'no refresh path, no recheck');
});

// --- P3-22: personal key show/hide and the save result (owner, 2026-09-06) ---

const MASK = '•';
const maskOf = (value) => MASK.repeat(value.length);

test('P3-22 a stored key fills the field with a mask of its length, never with the value', () => {
  const storage = fakeStorage();
  const h = harness({ config: fixtureConfig({ storage }) });
  const e = h.view.elements;
  // Nothing stored: an empty field, no toggle to press.
  assert.equal(e.keyInput.value, '');
  assert.equal(e.keyInput.getAttribute('type'), 'password');
  assert.equal(h.el('settings-key-toggle').hidden, true);

  e.keyInput.value = KEY; e.keyInput.dispatch('input');
  h.el('settings-key-form').dispatch('submit');
  // The field is not empty (the owner's phone complaint) and is not the key.
  assert.equal(e.keyInput.value, maskOf(KEY));
  assert.equal(e.keyInput.value.includes(KEY), false);
  assert.equal(e.keyInput.getAttribute('type'), 'password');
  assert.equal(h.keyStore.getMetadata('alpha', 'personal').length, KEY.length,
    'the mask length comes from the store, which exposes the length and not the value');
  assert.equal(/SECRET/.test(domText(h.root)), false, 'no key value anywhere in the DOM');
});

test('P3-22 the show toggle reveals the stored key, and hiding, saving, deleting or closing puts it back', () => {
  const h = harness({ config: fixtureConfig({ storage: fakeStorage() }) });
  const e = h.view.elements;
  const toggle = h.el('settings-key-toggle');
  e.keyInput.value = KEY; e.keyInput.dispatch('input');
  h.el('settings-key-form').dispatch('submit');

  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.textContent, ko['keyGuide.show']);
  assert.equal(toggle.getAttribute('aria-controls'), 'settings-key-input');

  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.textContent, ko['keyGuide.hide']);
  assert.equal(e.keyInput.getAttribute('type'), 'text');
  assert.equal(e.keyInput.value, KEY, 'the value is on screen only because someone asked');

  toggle.dispatch('click');
  assert.equal(e.keyInput.value, maskOf(KEY), 'hiding restores the mask');
  assert.equal(e.keyInput.getAttribute('type'), 'password');
  assert.equal(/SECRET/.test(domText(h.root)), false);

  // Leaving the settings screen hides a revealed key.
  toggle.dispatch('click');
  assert.equal(e.keyInput.value, KEY);
  h.shell.closeSettings();
  assert.equal(e.keyInput.value, maskOf(KEY), 'closing the screen hides the value');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(/SECRET/.test(domText(h.root)), false);

  // Deleting clears the field entirely and takes the toggle with it.
  toggle.dispatch('click');
  h.el('settings-key-delete').dispatch('click');
  h.el('settings-key-delete-confirm').dispatch('click');
  assert.equal(e.keyInput.value, '');
  assert.equal(h.el('settings-key-toggle').hidden, true);
  assert.equal(h.keyStore.getMetadata('alpha', 'personal'), null);
});

test('P3-22 typing replaces the mask, and the mask is never submitted as a key', () => {
  const storage = fakeStorage();
  const h = harness({ config: fixtureConfig({ storage }) });
  const e = h.view.elements;
  e.keyInput.value = KEY; e.keyInput.dispatch('input');
  h.el('settings-key-form').dispatch('submit');
  const stored = storage.map.get('interp-app.personal-key.v1.alpha');
  assert.equal(stored, undefined, 'session-only by default in this harness');

  // Pressing save on an untouched mask must not re-save anything and must not
  // claim success — the mask is not a key.
  h.el('settings-key-form').dispatch('submit');
  assert.equal(e.keyFeedback.textContent, ko['error.INVALID_KEY']);
  assert.equal(h.keyStore.getMetadata('alpha', 'personal').length, KEY.length, 'the stored key is untouched');

  // The first keystroke clears the mask so only what is typed survives.
  e.keyInput.value = `${maskOf(KEY)}NEW-PERSONAL-KEY-VALUE`;
  e.keyInput.dispatch('input');
  assert.equal(e.keyInput.value, 'NEW-PERSONAL-KEY-VALUE', 'the mask is stripped, not submitted');
  h.el('settings-key-form').dispatch('submit');
  assert.equal(h.keyStore.getMetadata('alpha', 'personal').length, 'NEW-PERSONAL-KEY-VALUE'.length);
  assert.equal(e.keyInput.value, maskOf('NEW-PERSONAL-KEY-VALUE'));
});

test('P3-22 the save result names what happened, and a failure never shows a success line', () => {
  const storage = fakeStorage();
  const h = harness({ config: fixtureConfig({ storage }), persistence: true });
  const e = h.view.elements;
  const save = (value, remember) => {
    e.rememberInput.checked = remember;
    e.keyInput.value = value; e.keyInput.dispatch('input');
    h.el('settings-key-form').dispatch('submit');
  };
  save(KEY, true);
  assert.equal(e.keyFeedback.textContent, ko['keyGuide.saved.browser']);
  assert.equal(e.keyFeedback.hidden, false);
  save(KEY, false);
  assert.equal(e.keyFeedback.textContent, ko['keyGuide.saved.session']);

  // A storage failure: no success wording, and no key value in the message.
  storage.setItem = () => { throw new Error('SECRET-IN-ERROR'); };
  save(KEY, true);
  assert.equal(e.keyFeedback.textContent, ko['error.STORAGE_FAILED']);
  assert.notEqual(e.keyFeedback.textContent, ko['keyGuide.saved.browser']);
  assert.notEqual(e.keyFeedback.textContent, ko['keyGuide.saved.session']);
  assert.equal(/SECRET/.test(domText(h.root)), false);
  // Nothing is stored, so the field has no mask to show.
  assert.equal(h.keyStore.getMetadata('alpha', 'personal'), null);
  assert.equal(e.keyInput.value, '');
});

test('P3-22 a shared event key is never masked, revealed or offered a toggle', () => {
  const h = harness({ config: fixtureConfig({ storage: fakeStorage() }) });
  const e = h.view.elements;
  // The shared entry is its own field and stays a password field with no toggle.
  assert.equal(e.sharedInput.getAttribute('type'), 'password');
  assert.equal(all(h.root, (node) => node.classes.has('settings-key-toggle')).length, 1,
    'only the personal key has a show toggle');
  // The store refuses to reveal anything but a personal key.
  assert.throws(() => h.keyStore.revealPersonal('nope'), { code: 'UNKNOWN_PROVIDER' });
  assert.equal(h.keyStore.revealPersonal('alpha'), null, 'nothing stored, nothing revealed');
});

test('styles: a note beside a checkbox takes the whole row, not the control column', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  // The row is a two-column grid: the control, then its label.
  const row = css.slice(css.indexOf('.settings-remember, .settings-mode-option {'));
  assert.match(row, /grid-template-columns:\s*var\(--touch\) minmax\(0, 1fr\)/);
  // Anything else in that row spans both columns. Without this a third child
  // lands in the 44px control column, which squeezed the Japanese storage
  // warning into one character per line on a phone.
  const span = css.slice(css.indexOf('.settings-remember > :not('));
  assert.ok(span.startsWith('.settings-remember > :not('), 'the span rule exists');
  assert.match(span.slice(0, 400), /grid-column:\s*1 \/ -1/);
  assert.match(span.slice(0, 400), /\.settings-mode-option > :not\(/);
  assert.match(span.slice(0, 400), /min-width:\s*0/);
});


test('the voice picker names the gender and Google\'s tone, and stays silent where the sources disagree', async () => {
  // The real provider registration, so the picker carries all 30 Live voices.
  const h = harness({ config: createAppConfig() });
  const nodes = h.view.elements.voiceSelect.childNodes.slice(1);
  const labels = nodes.map((node) => node.textContent);
  const values = nodes.map((node) => node.getAttribute('value'));
  assert.equal(labels.length, VOICE_NAMES.length);

  // Every registered voice has a profile, and the tone is Google's own word.
  for (const [index, value] of values.entries()) {
    const profile = VOICE_PROFILES[value];
    assert.ok(profile, `${value} has a profile`);
    assert.ok(labels[index].startsWith(`${value} · `), `${value} keeps its identifier first`);
    assert.ok(labels[index].endsWith(` · ${profile.tone}`), `${value} ends with its tone`);
  }
  // The two the sources disagree on show no gender at all rather than a guess.
  const undecided = VOICE_NAMES.filter((name) => VOICE_PROFILES[name].gender === null);
  assert.deepEqual(undecided.sort(), ['Pulcherrima', 'Sulafat']);
  for (const name of undecided) {
    const label = labels[values.indexOf(name)];
    assert.equal(label, `${name} · ${VOICE_PROFILES[name].tone}`);
    assert.equal(label.includes(ko['voice.gender.female']), false);
    assert.equal(label.includes(ko['voice.gender.male']), false);
  }
  // The counts the two public classifications agree on.
  const by = (gender) => VOICE_NAMES.filter((name) => VOICE_PROFILES[name].gender === gender).length;
  assert.deepEqual({ female: by('female'), male: by('male'), undecided: undecided.length }, { female: 12, male: 16, undecided: 2 });
  // The two voices the app actually commits to must agree with the profiles.
  assert.equal(voiceGender(LIVE_GENDER_VOICES.female), 'female');
  assert.equal(voiceGender(LIVE_GENDER_VOICES.male), 'male');
  assert.equal(voiceGender('nope'), null);
  assert.equal(voiceTone('nope'), null);
  // The note explains where each half of the label comes from, in every language.
  for (const lang of ['ko', 'en', 'ja']) {
    h.shell.setLanguage(lang);
    assert.equal(h.el('settings-voice-note').textContent, dictionaries[lang]['voice.genderNote']);
  }
  h.shell.setLanguage('ko');
});
