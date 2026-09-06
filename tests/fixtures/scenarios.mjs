// P1-20 integration fixtures: a fake browser that boots the real application
// (app/main.js and every module it imports) against scripted Gemini REST and
// Live transports, a fake microphone that emits synthetic frames, device
// speech, storage, a virtual clock and a service-worker double. No network,
// no recordings, no real credentials: the "keys" are runtime-assembled
// markers that are deliberately not key-shaped, so tests can prove where a
// key must never appear (URL, storage, DOM, snapshots, errors, logs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { startApp } from '../../app/main.js';
import { REST_ENDPOINT } from '../../app/providers/gemini/config.js';
import { createSocketFixture } from './live.mjs';
import { envelope, response as restResponse } from './gemini.mjs';
import { tone } from './audio.mjs';
import { policyWith } from './policy.mjs';

// P3-07: the app fetches the site policy from the deployed root (design-p3
// §1.3, §4.2 "P1/P2 테스트 fixture는 유효 정책 응답을 주입"). The fake
// browser lives at this origin and serves the §1.4 example policy unless a
// test scripts something else through createBrowser({ policy }). The P1/P2
// shared-mode scenarios predate the event list, so the served default turns
// the sharedKeys feature on; P3-08 binds v1 fragments to active events.
export const APP_ORIGIN = 'https://app.example.test';
export const POLICY_URL = `${APP_ORIGIN}/policy.json`;
export function scenarioPolicy(mutate = () => {}) {
  return policyWith((policy) => { policy.features.sharedKeys = true; mutate(policy); });
}
/** Same-origin 200 JSON reply for a policy document (or any JSON value). */
export function policyReply(policy = scenarioPolicy(), { status = 200 } = {}) {
  return new Response(JSON.stringify(policy), { status, headers: { 'content-type': 'application/json' } });
}

// The marker every leak scan looks for; the keys carry it and nothing else does.
export const SECRET_MARK = 'SECRET';
export const secrets = Object.freeze({
  personal: ['P1-20', 'PERSONAL', SECRET_MARK, 'KEY', '0123456789'].join('-'),
  shared: ['P1-20', 'SHARED', SECRET_MARK, 'KEY', '9876543210'].join('-'),
});
const markerPattern = new RegExp(SECRET_MARK);
/** True when any string reachable from value carries the marker. */
export const leaks = (value) => markerPattern.test(`${inspect(value, { depth: 8 })}${attemptJson(value)}`);
function attemptJson(value) { try { return JSON.stringify(value) ?? ''; } catch { return ''; } }

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(condition, limit = 500) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}

/** #shared= fragment as the P1-03 QR encodes it; eventName is untrusted text. */
export function sharedFragment({ providerId = 'gemini', eventName = 'Sunday <b>service</b>', key = secrets.shared, expiresAt } = {}) {
  return `#shared=${encodeURIComponent(JSON.stringify({ version: 1, providerId, eventName, key,
    ...(expiresAt === undefined ? {} : { expiresAt }) }))}`;
}

// ---------------------------------------------------------------------------
// Virtual clock: every app timer (retry waits, deadlines, capture watchdogs,
// notices, worker replies) lands here and fires only through advance().
export function createVirtualClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return Object.freeze({
    setTimeout(fn, ms = 0) {
      const id = ++next;
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    get now() { return now; },
    /** Remaining delays of every armed timer, in ms. */
    get pending() { return [...timers.values()].map((timer) => timer.at - now); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        timers.delete(entry[0]);
        now = Math.max(now, entry[1].at);
        entry[1].fn();
      }
      now = end;
    },
  });
}

// ---------------------------------------------------------------------------
// Minimal DOM double (same surface as the P1-15/16/19 tests): innerHTML and
// friends throw so any markup rendering of provider or QR text fails loudly.
export class FakeElement {
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
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
export const all = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes) all(child, predicate, out);
  return out;
};
export const byClass = (node, name) => all(node, (item) => item.classes.has(name))[0];
export const visible = (node) => { for (let item = node; item; item = item.parentNode) if (item.hidden) return false; return true; };
/** Every text node, attribute value and form value in the tree, for leak scans. */
export const domText = (node) => all(node, () => true)
  .map((item) => `${item.text}\n${[...item.attributes.values()].join('\n')}\n${item.value}`).join('\n');
export function choose(select, value) { select.value = value; return select.dispatch('change'); }

function createDocument() {
  const doc = new FakeElement(null, '#document');
  doc.ownerDocument = doc;
  doc.title = ''; doc.activeElement = null; doc.hidden = false;
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.append(doc.documentElement);
  const manifest = doc.createElement('link');
  manifest.setAttribute('rel', 'manifest');
  manifest.setAttribute('href', './manifest.ko.webmanifest');
  doc.head.append(manifest);
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.append(root);
  doc.getElementById = (id) => all(doc, (node) => node.getAttribute('id') === id)[0] ?? null;
  doc.querySelector = (selector) => {
    assert.equal(selector, 'link[rel="manifest"]');
    return all(doc, (node) => node.tagName === 'LINK' && node.getAttribute('rel') === 'manifest')[0] ?? null;
  };
  return { doc, root, manifest };
}

function fakeStorage(ops, initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map,
    getItem: (key) => { ops.push(`storage.get:${key}`); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { ops.push(`storage.set:${key}`); map.set(key, String(value)); },
    removeItem: (key) => { ops.push(`storage.remove:${key}`); map.delete(key); } };
}

// Web Audio double: the 24 kHz playback context (P1-10 player) and the capture
// context (P1-09, worklet node) share one class; sources end on the next tick.
function createAudio(record) {
  class AudioContext {
    constructor(options) {
      this.options = options ?? null; this.sampleRate = options?.sampleRate ?? 48000; this.state = 'suspended';
      this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} };
      this.resumes = 0; this.closes = 0;
      record.contexts.push(this);
    }
    async resume() { this.resumes += 1; if (this.state !== 'closed') this.state = 'running'; }
    async close() { this.closes += 1; this.state = 'closed'; }
    createBuffer(channels, size, rate) { const data = new Float32Array(size); return { data, duration: size / rate, getChannelData: () => data }; }
    createBufferSource() {
      const source = { buffer: null, onended: null, connect() {}, disconnect() {}, stop() {},
        start() { record.scheduled += 1; setImmediate(() => source.onended?.()); } };
      return source;
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class AudioWorkletNode {
    constructor(context, name) {
      this.context = context; this.name = name; this.onprocessorerror = null;
      this.port = { onmessage: null, close() {} };
      record.nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  return { AudioContext, AudioWorkletNode };
}

// Microphone double: getUserMedia yields one live mono track; tests feed
// Float32 frames into the active worklet node. Frames are synthetic only.
function createMicrophone(record) {
  const listeners = () => {
    const map = new Map();
    return { addEventListener(type, fn) { (map.get(type) ?? map.set(type, new Set()).get(type)).add(fn); },
      removeEventListener(type, fn) { map.get(type)?.delete(fn); } };
  };
  return {
    async getUserMedia() {
      const track = { kind: 'audio', readyState: 'live', muted: false, ...listeners(),
        stop() { track.readyState = 'ended'; stream.stopped = true; } };
      const stream = { stopped: false, getTracks: () => [track], getAudioTracks: () => [track] };
      record.streams.push(stream);
      return stream;
    },
    /** Deliver one frame to the most recent capture node. */
    feed(samples) {
      const node = record.nodes.at(-1);
      assert.ok(node?.port?.onmessage, 'no capture node is listening');
      node.port.onmessage({ data: samples });
    },
  };
}
export const frames = Object.freeze({
  silence: (length = 4800) => new Float32Array(length),
  speech: (length = 4800, sampleRate = 48000) => tone(sampleRate, 440, length, 0.3),
});

// Device speech double (P1-10 device TTS): voices for the three languages;
// utterances end on the next tick unless a test holds them.
export const DEVICE_VOICES = Object.freeze([
  { voiceURI: 'fake-ko', lang: 'ko-KR', name: 'Fake KO', localService: true, default: true },
  { voiceURI: 'fake-en', lang: 'en-US', name: 'Fake EN', localService: true, default: true },
  { voiceURI: 'fake-ja', lang: 'ja-JP', name: 'Fake JA', localService: true, default: true },
]);
function createSpeech(record, voices = [...DEVICE_VOICES]) {
  const listeners = new Map();
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; this.lang = ''; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; }
  }
  const synth = {
    mode: 'auto', pending: null,
    getVoices: () => voices,
    speak(utterance) {
      record.utterances.push({ text: utterance.text, lang: utterance.lang, voiceURI: utterance.voice?.voiceURI ?? null });
      if (synth.mode === 'auto') setImmediate(() => utterance.onend?.());
      else synth.pending = utterance;
    },
    cancel() { record.cancels += 1; },
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    voicesChanged() { for (const listener of [...(listeners.get('voiceschanged') ?? [])]) listener(); },
    get listenerCount() { return [...listeners.values()].reduce((total, set) => total + set.size, 0); },
  };
  return { synth, SpeechSynthesisUtterance };
}

// Controller worker double answering the P1-18 protocol for one release id.
export function fakeWorker(release, { clients = 1 } = {}) {
  const worker = new FakeElement(null, 'worker');
  worker.state = 'activated';
  worker.received = [];
  worker.calls = { skipWaiting: 0 };
  worker.postMessage = (message, [port] = []) => {
    worker.received.push(structuredClone(message));
    const reply = (data) => port?.postMessage(data);
    if (message.type === 'interp:get-release') reply({ type: 'interp:release', release });
    else if (message.type === 'interp:count-clients') reply({ type: 'interp:clients', count: clients });
    else if (message.type === 'interp:apply-update') { worker.calls.skipWaiting += 1; reply({ type: 'interp:updating', release }); }
  };
  return worker;
}
class FakePort {
  constructor() { this.onmessage = null; this.closed = false; }
  postMessage(message) { const peer = this.peer; const data = structuredClone(message); queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data }); }); }
  close() { this.closed = true; }
}
class FakeMessageChannel {
  constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

// ---------------------------------------------------------------------------
// Scripted transports. REST responders are queued per call: a Response, a
// function (call) => Response | Promise, or nothing for a plain success.
const errorBody = (status, { rpc, reason, quotaId, message } = {}) => ({ error: {
  code: status, status: rpc, message: message ?? `${SECRET_MARK} provider message`,
  details: [
    ...(reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : []),
    ...(quotaId ? [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }] : []),
  ] } });
export const rest = Object.freeze({
  /** Structured translation echoing the request text (validateOutput requires the echo). */
  translation: ({ translatedText = '12 apples', sourceText, detectedLanguage = 'ko' } = {}) => (call) => {
    let part = null;
    try { part = JSON.parse(call.body)?.contents?.[0]?.parts?.[0] ?? null; } catch { part = null; }
    const source = sourceText ?? (typeof part?.text === 'string' ? part.text : '사과 12개');
    return restResponse(envelope(JSON.stringify({ sourceText: source, translatedText, detectedLanguage, status: 'ok' })));
  },
  /** Provider-reported silence: no text, detectedLanguage und. */
  noSpeech: () => restResponse(envelope(JSON.stringify({ sourceText: '', translatedText: '', detectedLanguage: 'und', status: 'no-speech' }))),
  /** HTTP error with the Gemini JSON error shape; the message carries the marker. */
  error: (status, { rpc, reason, quotaId, retryAfter, message } = {}) => restResponse(errorBody(status, { rpc, reason, quotaId, message }),
    { status, headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) } }),
  forbidden: () => rest.error(403, { rpc: 'PERMISSION_DENIED' }),
  unknown429: (retryAfter) => rest.error(429, { rpc: 'RESOURCE_EXHAUSTED', retryAfter }),
  perMinute429: (retryAfter) => rest.error(429, { rpc: 'RESOURCE_EXHAUSTED', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel', retryAfter }),
  unavailable: (retryAfter) => rest.error(503, { rpc: 'UNAVAILABLE', retryAfter }),
  /** A request that never answers until release() is called with a responder. */
  hang() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return { responder: (call) => gate.then((next) => (typeof next === 'function' ? next(call) : next)), release };
  },
});

const b64 = (bytes) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
export const live = Object.freeze({
  /** Complete the setup handshake on a socket the app just opened. */
  ready(ws) { ws.open(); ws.json({ setupComplete: {} }); },
  /** One PCM16 24 kHz chunk of `bytes` (even) bytes. */
  chunk: (bytes = 4800) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: b64(new Uint8Array(bytes)) } }] } } }),
  transcript: (text) => ({ serverContent: { outputTranscription: { text } } }),
  complete: () => ({ serverContent: { turnComplete: true } }),
  error: (status = 503, rpc = 'UNAVAILABLE') => ({ error: { code: status, status: rpc, message: `${SECRET_MARK} live message` } }),
  /** The user text turn the adapter sends for a spoken line. */
  sentText: (ws, index = 1) => ws.sent[index]?.clientContent?.turns?.[0]?.parts?.[0]?.text ?? null,
});

// ---------------------------------------------------------------------------
/**
 * createBrowser(options) builds the fake window. fetch serves app/i18n/*.json
 * from disk, the site policy at POLICY_URL and scripted Gemini REST responses;
 * WebSocket is the P1-11 socket fixture (URLs recorded, never thrown on);
 * everything else is refused. `policy` is the served policy document, a
 * function (call, index) -> Response | document | Error, or null to refuse;
 * every policy request is recorded in `policyCalls`.
 */
export function createBrowser({ hash = '', storage: storageInit = {}, withStorage = true, languages = ['ko-KR', 'en-US'],
  controller = null, waiting = null, clients = 1, clock = createVirtualClock(), online = true,
  deviceVoices = [...DEVICE_VOICES], policy = scenarioPolicy() } = {}) {
  const ops = [];
  const { doc, root, manifest } = createDocument();
  const gemini = { calls: [], script: [] };
  const policyCalls = [];
  const socketURLs = [];
  const fixture = createSocketFixture({ autoClose: false, inspectURL: (url) => { socketURLs.push(String(url)); } });
  // A browser delivers the close event as a later task, never in the same
  // microtask as close(); the P1-11 fixture's microtask close is too eager for
  // cross-module ordering, so closure is confirmed on the next macrotask.
  class WebSocket extends fixture.WebSocket {
    close(...args) {
      super.close(...args);
      setImmediate(() => { if (this.readyState !== 3) this.finishClose(); });
    }
  }
  const sockets = { WebSocket, sockets: fixture.sockets };
  const audio = { contexts: [], nodes: [], scheduled: 0 };
  const speech = { utterances: [], cancels: 0 };
  const microphoneRecord = { streams: [], nodes: audio.nodes };
  const { AudioContext, AudioWorkletNode } = createAudio(audio);
  // Chrome fills speechSynthesis.getVoices() asynchronously: a cold load sees [] first.
  const { synth, SpeechSynthesisUtterance } = createSpeech(speech, deviceVoices);
  const microphone = createMicrophone(microphoneRecord);
  const win = new FakeElement(doc, 'window');
  win.document = doc;
  win.isSecureContext = true;
  win.MessageChannel = FakeMessageChannel;
  win.WebSocket = sockets.WebSocket;
  win.Blob = Blob;
  win.AudioContext = AudioContext;
  win.AudioWorkletNode = AudioWorkletNode;
  win.speechSynthesis = synth;
  win.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  win.setTimeout = clock.setTimeout;
  win.clearTimeout = clock.clearTimeout;
  win.matchMedia = () => ({ matches: false });
  win.location = { hash, pathname: '/', search: '', origin: APP_ORIGIN, protocol: 'https:', host: 'app.example.test',
    get href() { return `${APP_ORIGIN}${this.pathname}${this.search}${this.hash}`; }, reloads: 0, reload() { this.reloads += 1; } };
  win.history = { states: [], replaceState(state, title, url) { this.states.push({ state, title, url }); ops.push(`replaceState:${url}`); win.location.hash = ''; } };
  if (withStorage) win.localStorage = fakeStorage(ops, storageInit);
  const container = new FakeElement(doc, 'serviceworker');
  container.controller = controller;
  container.registrations = [];
  const registration = new FakeElement(doc, 'registration');
  Object.assign(registration, { scope: 'https://app.example.test/', waiting, installing: null, active: controller });
  container.register = async (url, options) => { container.registrations.push({ url, options }); return registration; };
  win.navigator = { languages, onLine: online, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128', serviceWorker: container,
    userActivation: { isActive: true }, mediaDevices: { getUserMedia: microphone.getUserMedia } };
  win.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('file:')) {
      ops.push('fetch:i18n');
      assert.match(url, /\/app\/i18n\/(?:ko|en|ja)\.json$/);
      return new Response(await readFile(fileURLToPath(url)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === POLICY_URL) {
      ops.push('fetch:policy');
      const call = { url, init, signal: init.signal ?? null, index: policyCalls.length };
      policyCalls.push(call);
      if (policy === null) throw new Error('UNEXPECTED_FETCH');
      const produced = typeof policy === 'function' ? await policy(call, call.index) : policy;
      if (produced instanceof Error) throw produced;
      return produced instanceof Response ? produced : policyReply(produced);
    }
    if (url.startsWith(`${REST_ENDPOINT}/`)) {
      ops.push('fetch:gemini');
      const call = { url, method: init.method, headers: { ...init.headers }, signal: init.signal, body: init.body,
        credentials: init.credentials, referrerPolicy: init.referrerPolicy };
      gemini.calls.push(call);
      const next = gemini.script.shift();
      return typeof next === 'function' ? next(call) : next ?? rest.translation()(call);
    }
    throw new Error('UNEXPECTED_FETCH');
  };
  return { win, doc, root, manifest, ops, clock, gemini, audio, speech, synth, microphone: { ...microphone, streams: microphoneRecord.streams },
    container, registration, sockets: sockets.sockets, socketURLs, policyCalls,
    get storage() { return win.localStorage?.map; },
    /** Every URL the app opened over either transport. */
    get networkURLs() { return [...gemini.calls.map((call) => call.url), ...socketURLs]; } };
}

/**
 * boot(options) starts the real app in a fresh fake browser and returns the
 * browser plus UI helpers. Everything the helpers do goes through the DOM the
 * shell built (settings form, mode radios, PTT button, bubble buttons).
 */
export async function boot(options = {}) {
  const browser = createBrowser(options);
  const app = await startApp({ window: browser.win, setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout });
  assert.ok(app, 'the app started');
  const store = app.engine.state;
  const el = (name) => byClass(browser.root, name);
  const byId = (id) => all(browser.root, (node) => node.getAttribute('id') === id)[0];
  const bubble = (turnId) => all(browser.root, (node) => node.getAttribute('data-turn-id') === turnId)[0];
  const ptt = el('seq-ptt');
  const handle = {
    ...browser, app, store, el, byId, bubble,
    turns: () => store.snapshot().turns,
    turn: (turnId) => store.snapshot().turns.find((turn) => turn.turnId === turnId) ?? null,
    notice: () => store.snapshot().notice?.messageKey ?? null,
    text: () => domText(browser.root),
    /** Resolves once no turn is active (a spoken completed turn stays active until playback ends). */
    idle: (limit) => until(() => store.snapshot().activeTurnId === null, limit),
    enterPersonalKey({ key = secrets.personal, remember = false } = {}) {
      const input = el('settings-key-input');
      input.value = key;
      el('settings-remember').childNodes[0].checked = remember;
      el('settings-key-form').dispatch('submit');
      assert.equal(input.value, '', 'the key field is emptied on save');
    },
    selectMode(source) {
      const radio = byId(`settings-mode-${source}`);
      assert.equal(radio.disabled, false, `${source} mode is selectable`);
      radio.checked = true;
      radio.dispatch('change');
    },
    setVoiceOutput(value) { choose(byId('settings-voice-output'), value); },
    submitText(text) { return app.engine.submitText(text); },
    /** The sequential screen's text form; the active turn id is returned. */
    submitForm(text) {
      const textarea = el('seq-text');
      textarea.value = text;
      el('seq-form').dispatch('submit');
      return store.snapshot().activeTurnId;
    },
    press() { ptt.dispatch('pointerdown', { button: 0, pointerId: 1 }); },
    release() { ptt.dispatch('pointerup', { pointerId: 1 }); },
    cancel() { el('seq-cancel').dispatch('click'); },
    clickTurn(turnId, className) {
      const button = byClass(bubble(turnId), className);
      assert.ok(button && visible(button), `${className} is offered on ${turnId}`);
      button.dispatch('click');
    },
    close: () => app.close(),
  };
  return handle;
}

/** Records console use for the duration of a test; the app must never log. */
export function captureConsole() {
  const names = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'];
  const calls = [];
  const original = Object.fromEntries(names.map((name) => [name, console[name]]));
  for (const name of names) console[name] = (...args) => { calls.push({ name, args }); };
  return { calls, restore() { for (const name of names) console[name] = original[name]; } };
}
