// New implementation of docs/extension.md 8.5, 11.1 (extension-overlay) and 15.6; no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';
import { FakeCSSStyleSheet, createFakeDocument, parseHtml, runClassicScript } from './fixtures/extension-dom.mjs';

// extension/overlay/overlay.js runs here inside a `vm` context as a classic script (the way Chrome runs a content
// script), against the fake DOM and the fake chrome runtime of a CONTENT context. The host side of the port is a
// second fake context. Nothing here launches a browser, opens a socket or touches audio. The fake DOM has no layout
// and no CSS cascade, so what these tests prove is which nodes, attributes, text, timers and calls the overlay
// produces, never how it looks (checklist 13.30 and 13.14 cover that).

const SOURCE = await readFile(new URL('../extension/overlay/overlay.js', import.meta.url), 'utf8');
const ATTACH = Object.freeze({ v: 1, target: 'content', type: 'content/overlay-attach' });
const HELLO = Object.freeze({ v: 1, type: 'hello' });
const MESSAGES = Object.freeze({
  overlayRegion: 'Interpretation captions', overlayHide: 'Hide captions', overlayLaneTab: 'Tab audio',
  overlayLaneMic: 'Microphone', overlayGap: 'Some captions may be missing.', overlayReconnecting: 'Reconnecting…',
  overlayStopped: 'Interpretation stopped. Check the panel.',
});
const PAGE_HTML = `<!doctype html><html lang="en"><head><title>Host page</title></head><body>
<div id="app" class="page" data-x="1"><p id="para">Hello</p><button id="btn" type="button">Go</button></div>
<div id="player"><video id="video"></video></div></body></html>`;

// What the overlay may read from the page (8.5.1). createElement and the two listener methods are how it builds and
// wires its OWN element; the rest are the page properties the contract lists.
const ALLOWED_DOCUMENT = ['addEventListener', 'createElement', 'documentElement', 'fullscreenElement', 'removeEventListener', 'visibilityState'];
const ALLOWED_FULLSCREEN = ['appendChild', 'isConnected', 'shadowRoot', 'tagName'];

// A symbol-keyed global set inside a vm context stays in the context (Node mirrors only string keys onto the sandbox
// object), so the marker is read from inside it.
const marker = (env) => vm.runInContext('globalThis[Symbol.for("interp.overlay.v1")]', env.sandbox);
const symbolCount = (env) => vm.runInContext('Object.getOwnPropertySymbols(globalThis).length', env.sandbox);
const textOf = (node) => node.childNodes.map((child) => child.textContent).join('');

const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]\/\/ .*$/gm, '');

// ---------------------------------------------------------------------------
// Frames

const styleFrame = (style = {}) => ({ v: 1, type: 'style',
  style: { size: 1.5, position: 'bottom', display: 'dark', maxLines: 3, autoHideSeconds: 8, ...style } });
const row = (id, text, status = 'final', extra = {}) => ({ id, role: 'translation', status, text, skipped: false, ...extra });
const captionsFrame = (lane, rows, { epoch = 1, seq = 1, lang = 'ko', gaps = {} } = {}) => ({ v: 1, type: 'captions', epoch, seq, lane, lang,
  rows, gaps: { input: false, audio: false, reception: false, ...gaps }, live: true });
const clearFrame = (lane) => ({ v: 1, type: 'clear', lane });
const statusFrame = (lane, phase) => ({ v: 1, type: 'status', lane, phase });
const BYE = Object.freeze({ v: 1, type: 'bye' });

// ---------------------------------------------------------------------------
// Harness

// Wraps a content context's chrome so a test can see and steer what the script does: it records every getMessage
// name and every port it opens (with the disconnect and message handlers it registered, so a LATE disconnect or a
// LATE frame of a stale port can be replayed), makes runtime.id vanish (an orphaned script) and makes connect throw.
// It never spreads the real chrome object: its `storage` accessor would count as a read.
function spyChrome(content) {
  const real = content.chrome;
  const log = { names: [], connects: 0, ports: [] };
  const control = { id: undefined, orphaned: false, failConnect: false };
  const runtime = {
    get id() { return control.orphaned ? undefined : (control.id ?? real.runtime.id); },
    get lastError() { return undefined; },
    connect(info) {
      log.connects++;
      if (control.failConnect) throw new Error('connect failed');
      const port = real.runtime.connect(info);
      const record = { port, disconnectHandlers: [], messageHandlers: [] };
      log.ports.push(record);
      return new Proxy(port, { get(target, key) {
        if (key === 'onDisconnect') {
          return { addListener: (fn) => { record.disconnectHandlers.push(fn); target.onDisconnect.addListener(fn); },
            removeListener: (fn) => target.onDisconnect.removeListener(fn), hasListener: (fn) => target.onDisconnect.hasListener(fn) };
        }
        if (key === 'onMessage') {
          return { addListener: (fn) => { record.messageHandlers.push(fn); target.onMessage.addListener(fn); },
            removeListener: (fn) => target.onMessage.removeListener(fn), hasListener: (fn) => target.onMessage.hasListener(fn) };
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    onMessage: real.runtime.onMessage,
    sendMessage: real.runtime.sendMessage,
  };
  const i18n = { getMessage: (name, ...rest) => { log.names.push(name); return real.i18n.getMessage(name, ...rest); } };
  return { chrome: { runtime, i18n }, control, log };
}

// Every property the script reads from `document` is recorded; methods are bound to the real document so the fake's
// internals do not show up as reads.
function recordReads(target, reads) {
  return new Proxy(target, { get(object, key) {
    reads.add(String(key));
    const value = Reflect.get(object, key, object);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
}

async function boot({ messages = MESSAGES, popover = true, sheet = FakeCSSStyleSheet, html = null, install = true, browserOptions = {} } = {}) {
  const browser = createFakeBrowser({ messages, ...browserOptions });
  browser.addTab({ id: 7, url: 'https://example.test/page', active: true });
  const content = browser.contentContext(7);
  const sender = browser.createContext('panel');   // an extension context without a tab: the shape the service worker has
  const offscreen = browser.createContext('offscreen');
  const document = html === null ? createFakeDocument({ popover }) : parseHtml(html, { popover });
  const ports = [];      // the HOST ends of the overlay's ports
  const received = [];   // what the host heard from the overlay
  offscreen.chrome.runtime.onConnect.addListener((port) => {
    ports.push(port);
    port.onMessage.addListener((frame) => received.push(frame));
  });
  const spy = spyChrome(content);
  const documentReads = new Set();
  const sandbox = { chrome: spy.chrome, document: recordReads(document, documentReads),
    setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout };
  if (sheet) sandbox.CSSStyleSheet = sheet;
  const run = () => runClassicScript(SOURCE, sandbox, { filename: 'overlay.js' });

  const env = {
    browser, content, sender, offscreen, document, ports, received, sandbox, spy, documentReads, run,
    attach: async (message = ATTACH) => { const answer = await sender.chrome.tabs.sendMessage(7, message); await browser.settle(); return answer; },
    send: async (frame) => { ports.at(-1).postMessage(frame); await browser.settle(); },
    tick: (ms) => browser.clock.advance(ms),
    hostElement: () => document.querySelectorAll('interp-live-captions')[0] ?? null,
    // The test's own handle on the CLOSED root; the page has no such handle (host.shadowRoot is null).
    root: () => env.hostElement()?.lastShadowRoot ?? null,
    wrap: () => env.root()?.querySelector('.wrap') ?? null,
    start: async (style) => { await env.attach(); await env.send(styleFrame(style)); },
    shown() {
      const wrap = env.wrap();
      if (!wrap) return null;
      const lanes = {};
      for (const section of wrap.querySelectorAll('section')) {
        const status = section.querySelector('.status');
        lanes[section.getAttribute('data-lane')] = {
          lang: section.getAttribute('lang'),
          chip: section.querySelector('.chip').textContent,
          rows: section.querySelectorAll('.row').map((item) => [item.getAttribute('data-status'), item.textContent]),
          status: status ? [status.getAttribute('data-phase'), status.textContent] : null,
        };
      }
      const gap = wrap.querySelector('.gap');
      return { hidden: wrap.hidden, lanes, gap: gap ? gap.textContent : null };
    },
    rows: (lane) => env.shown().lanes[lane]?.rows ?? [],
    listenerCount: () => content.listeners.get('runtime.onMessage')?.length ?? 0,
  };
  if (install) run();
  return env;
}

// A very small CSS reader: top-level rules and the rules inside @media, comments removed.
function cssRules(css, media = null) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    const head = text.slice(index, open).trim();
    let depth = 1, close = open + 1;
    while (close < text.length && depth > 0) { if (text[close] === '{') depth++; else if (text[close] === '}') depth--; close++; }
    const body = text.slice(open + 1, close - 1);
    if (head.startsWith('@')) rules.push(...cssRules(body, head));
    else {
      const declarations = Object.fromEntries(body.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const at = part.indexOf(':');
        return [part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/\s+/g, ' ')];
      }));
      rules.push({ media, selectors: head.split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')), declarations });
    }
    index = close;
  }
  return rules;
}
const declarationsFor = (rules, selector, media = null) => Object.assign({}, ...rules
  .filter((rule) => rule.media === media && rule.selectors.includes(selector)).map((rule) => rule.declarations));

// ---------------------------------------------------------------------------
// The source itself

test('WIRE: one frozen literal, pinned against literals written in this test (the match with protocol.js is checked in extension-tree)', () => {
  const literals = SOURCE.match(/const WIRE = Object\.freeze\(\{[^}]*\}\);/g) ?? [];
  assert.equal(literals.length, 1, 'exactly one WIRE literal');
  const wire = vm.runInNewContext(`(${literals[0].slice('const WIRE = '.length, -1)})`);
  assert.deepEqual({ ...wire }, { port: 'interp-overlay/1', v: 1, maxRows: 6, maxRowChars: 400 });
  assert.equal(Object.isFrozen(wire), true);
  assert.equal(SOURCE.split('interp-overlay/1').length - 1, 1, 'the port name is spelled once');
  assert.equal(SOURCE.split("Symbol.for('interp.overlay.v1')").length - 1, 1);
});

test('source: a classic script in one strict IIFE with no imports, parseable by vm.Script, and free of forbidden constructs', () => {
  const code = strip(SOURCE);
  assert.match(code.trimStart(), /^\(function \(\) \{\n {2}'use strict';/, 'one IIFE whose first statement is the strict directive');
  assert.match(code.trimEnd(), /\}\)\(\);$/);
  assert.doesNotThrow(() => new vm.Script(SOURCE, { filename: 'overlay.js' }));
  assert.throws(() => vm.runInNewContext('export const x = 1;'), { name: 'SyntaxError' }, 'sanity: module syntax does not parse as a classic script');
  assert.doesNotMatch(code, /\b(?:import|export|require)\b/, 'no import, export or require');
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'console.', 'localStorage',
    'sessionStorage', 'indexedDB', 'debugger', '.focus(', 'aria-live', 'importScripts', 'chrome.storage']) {
    assert.equal(code.includes(forbidden), false, `no ${forbidden}`);
  }
  assert.equal(code.split('attachShadow(').length - 1, 1, 'one shadow root');
  assert.match(code, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.equal(code.split('addEventListener(').length - 1, 3, 'three listeners: the close button and the two document events');
  assert.deepEqual([...new Set([...code.matchAll(/\bdocument\.(\w+)/g)].map((match) => match[1]))].sort(), ALLOWED_DOCUMENT);
  assert.deepEqual([...new Set([...code.matchAll(/\bchrome\.(\w+\.\w+)/g)].map((match) => match[1]))].sort(),
    ['i18n.getMessage', 'runtime.connect', 'runtime.id', 'runtime.lastError', 'runtime.onMessage']);
  // Text only through textContent (fixtures throw on markup, and the repo's i18n checker flags literals): the chip, a
  // row, a status row, the gap line and the <style> fallback.
  assert.equal(code.split('.textContent =').length - 1, 5);
  assert.doesNotMatch(code, /textContent = ['"`]/, 'never a literal (the checker would flag it)');
});

test('source: every chrome.i18n message the overlay reads exists in all three _locales files', async () => {
  const names = [...SOURCE.matchAll(/getMessage\('(\w+)'\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(names, Object.keys(MESSAGES).sort(), 'the seven overlay messages of 9.3, each spelled as a literal');
  for (const language of ['en', 'ko', 'ja']) {
    const messages = JSON.parse(await readFile(new URL(`../extension/_locales/${language}/messages.json`, import.meta.url), 'utf8'));
    for (const name of names) assert.equal(typeof messages[name]?.message, 'string', `${language} has ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Load, injection and attach

test('load: nothing connects, nothing is drawn, one message listener is registered, and a second injection does nothing', async () => {
  const env = await boot();
  assert.equal(env.spy.log.connects, 0);
  assert.equal(env.ports.length, 0);
  assert.equal(env.content.ports.size, 0);
  assert.equal(env.hostElement(), null, 'the page is untouched until frames arrive');
  assert.equal(env.listenerCount(), 1);
  assert.equal(env.document.listenerCount, 0);
  const handle = marker(env);
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(Object.keys(handle), ['dispose']);
  assert.equal(symbolCount(env), 1, 'the marker is the only symbol it adds');
  assert.deepEqual(Object.keys(env.sandbox).sort(), ['CSSStyleSheet', 'chrome', 'clearTimeout', 'document', 'setTimeout'], 'no leaked globals');

  env.run();
  env.run();
  assert.equal(env.listenerCount(), 1, 'a second and third injection add no listener');
  assert.equal(marker(env), handle);
  assert.equal(env.spy.log.connects, 0);
});

test('load: without a chrome runtime nothing throws and no marker is left behind', () => {
  const sandbox = { document: createFakeDocument() };
  assert.doesNotThrow(() => runClassicScript(SOURCE, sandbox));
  assert.equal(vm.runInContext('Object.getOwnPropertySymbols(globalThis).length', sandbox), 0);
});

test('attach: an SW-shaped sender opens interp-overlay/1, the host hears only hello, and the answer is {ok:true}', async () => {
  const env = await boot();
  assert.deepEqual(await env.attach(), { ok: true });
  assert.equal(env.ports.length, 1);
  assert.equal(env.ports[0].name, 'interp-overlay/1');
  assert.deepEqual(env.received, [HELLO]);
  assert.equal(env.ports[0].sender.tab.id, 7, 'the host sees a content sender with its tab');
  assert.equal(env.ports[0].sender.frameId, 0);
  assert.equal(env.hostElement(), null, 'still nothing on the page: the UI is built when the first frame is accepted');
});

test('attach: accepted from the real service-worker context, with and without a sender url (A23)', async () => {
  for (const swSenderHasUrl of [true, false]) {
    const env = await boot({ browserOptions: { swSenderHasUrl } });
    let worker;
    env.browser.sw.register((chrome) => { worker = chrome; });
    assert.deepEqual(await worker.tabs.sendMessage(7, ATTACH), { ok: true }, `swSenderHasUrl=${swSenderHasUrl}`);
    await env.browser.settle();
    assert.equal(env.ports.length, 1);
  }
});

test('attach: refused (no answer, no port) for a sender with a tab, a foreign id, or a message with the wrong v, target or type', async () => {
  const env = await boot();
  const withTab = env.browser.createContext('panel', { tabId: 7 });
  await assert.rejects(withTab.chrome.tabs.sendMessage(7, ATTACH), /port closed/, 'sender.tab is defined');
  for (const message of [{ ...ATTACH, v: 2 }, { ...ATTACH, target: 'sw' }, { ...ATTACH, type: 'content/other' }, { v: 1 }, { ...ATTACH, target: undefined }]) {
    await assert.rejects(env.sender.chrome.tabs.sendMessage(7, message), /port closed/, JSON.stringify(message));
  }
  env.spy.control.id = 'a-different-extension-id';
  await assert.rejects(env.sender.chrome.tabs.sendMessage(7, ATTACH), /port closed/, 'sender.id is not this extension');
  env.spy.control.id = undefined;
  assert.equal(env.spy.log.connects, 0);
  assert.equal(env.ports.length, 0);
  assert.deepEqual(await env.attach(), { ok: true }, 'a good message still works afterwards');
});

// §19 (2026-09-30): the capture label. Both tests fail on v0.3.1, whose overlay ignored every message but overlay-attach.
const LABEL = `${'0123456789abcdef'.repeat(2)}.7`;
const LABEL_MESSAGE = Object.freeze({ v: 1, target: 'content', type: 'content/capture-label', label: LABEL });
async function bootWithCapture(capture) {
  const env = await boot({ install: false });
  env.sandbox.navigator = { mediaDevices: capture };
  env.run();
  return env;
}

test('capture-label: the page is tagged with the label for this extension\'s origin only; nothing connects, nothing is drawn, the answer is {ok:true}', async () => {
  const configs = [];
  const env = await bootWithCapture({ setCaptureHandleConfig: (config) => { configs.push(config); } });
  assert.deepEqual(await env.sender.chrome.tabs.sendMessage(7, LABEL_MESSAGE), { ok: true });
  // (compared as JSON: the script runs in its own realm, so its objects have that realm's prototypes)
  assert.equal(JSON.stringify(configs), JSON.stringify([{ handle: LABEL, exposeOrigin: false,
    permittedOrigins: [`chrome-extension://${env.content.chrome.runtime.id}`] }]));
  assert.equal(env.spy.log.connects, 0, 'a label opens no port');
  assert.equal(env.hostElement(), null, 'and draws nothing');
  assert.deepEqual([...env.documentReads], [], 'the page is not read');
  // A later start sends a new label: the newest one replaces the old one.
  const next = `${'f'.repeat(32)}.7`;
  await env.sender.chrome.tabs.sendMessage(7, { ...LABEL_MESSAGE, label: next });
  assert.equal(configs.at(-1).handle, next);
  // and the overlay still attaches as before
  assert.deepEqual(await env.attach(), { ok: true });
  assert.equal(env.spy.log.connects, 1);
});

test('capture-label: a malformed label sets nothing, an untrusted sender gets no answer, and a page without the API never throws', async () => {
  const configs = [];
  const env = await bootWithCapture({ setCaptureHandleConfig: (config) => { configs.push(config); } });
  for (const label of [undefined, null, 7, '', 'interp:abc', LABEL.toUpperCase(), `${LABEL}.1`, LABEL.slice(1), `${LABEL} `, `${'0'.repeat(32)}.`, `x${LABEL}`]) {
    assert.deepEqual(await env.sender.chrome.tabs.sendMessage(7, { ...LABEL_MESSAGE, label }), { ok: true }, `answered: ${JSON.stringify(label)}`);
  }
  assert.equal(configs.length, 0, 'nothing but a well-formed label reaches the page');
  const withTab = env.browser.createContext('panel', { tabId: 7 });
  await assert.rejects(withTab.chrome.tabs.sendMessage(7, LABEL_MESSAGE), /port closed/, 'a sender with a tab is not the service worker');
  env.spy.control.id = 'a-different-extension-id';
  await assert.rejects(env.sender.chrome.tabs.sendMessage(7, LABEL_MESSAGE), /port closed/);
  env.spy.control.id = undefined;
  assert.equal(configs.length, 0);

  // No navigator at all, no mediaDevices, no method, or a method that throws: answered, silent, and attach still works.
  for (const capture of [undefined, {}, { setCaptureHandleConfig() { throw new Error('InvalidStateError'); } }]) {
    const bare = await bootWithCapture(capture);
    assert.deepEqual(await bare.sender.chrome.tabs.sendMessage(7, LABEL_MESSAGE), { ok: true });
    assert.deepEqual(await bare.attach(), { ok: true });
  }
  const none = await boot();   // the sandbox has no `navigator` global
  assert.deepEqual(await none.sender.chrome.tabs.sendMessage(7, LABEL_MESSAGE), { ok: true });
  assert.equal(none.listenerCount(), 1);
});

test('attach: while a port is open a second attach opens no second port but still answers {ok:true}', async () => {
  const env = await boot();
  await env.attach();
  assert.deepEqual(await env.attach(), { ok: true });
  assert.deepEqual(await env.attach(), { ok: true });
  assert.equal(env.spy.log.connects, 1);
  assert.equal(env.ports.length, 1);
  assert.deepEqual(env.received, [HELLO], 'one hello only');
});

test('attach: a failing connect still answers {ok:true}, draws nothing and leaves the script able to attach later', async () => {
  const env = await boot();
  env.spy.control.failConnect = true;
  assert.deepEqual(await env.attach(), { ok: true });
  assert.equal(env.ports.length, 0);
  assert.equal(env.hostElement(), null);
  assert.equal(env.listenerCount(), 1);
  env.spy.control.failConnect = false;
  assert.deepEqual(await env.attach(), { ok: true });
  assert.equal(env.ports.length, 1);
  assert.deepEqual(env.received, [HELLO]);
});

// ---------------------------------------------------------------------------
// The host element, the closed root and the stylesheet

test('host element: an unknown tag under documentElement, styled through CSSOM with !important, a closed root only the script can reach', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'secret words')]));
  const host = env.hostElement();
  assert.equal(host.localName, 'interp-live-captions');
  assert.notEqual(host.localName, 'div');
  assert.equal(host.parentNode, env.document.documentElement);
  // `all: initial` does not reset `direction` or `unicode-bidi`, so both are pinned too: an rtl page must not flip the bar.
  const wanted = { all: 'initial', direction: 'ltr', 'unicode-bidi': 'isolate', position: 'fixed', inset: '0', 'z-index': '2147483647',
    'pointer-events': 'none', display: 'block', contain: 'layout style' };
  for (const [name, value] of Object.entries(wanted)) {
    assert.equal(host.style.getPropertyValue(name), value, name);
    assert.equal(host.style.getPropertyPriority(name), 'important', `${name} is !important`);
  }
  assert.equal(host.style.length, Object.keys(wanted).length, 'exactly these properties are set on the host, no more');
  assert.equal(host.getAttribute('style'), null, 'no style attribute (CSSOM only, which a strict page CSP allows)');
  assert.equal(host.getAttribute('class'), null);

  // What page scripts can see: a closed root is invisible from the page's side, and so is its text.
  assert.equal(host.shadowRoot, null);
  assert.equal(host.children.length, 0, 'no light-DOM children');
  assert.equal(host.textContent, '');
  assert.equal(env.document.documentElement.textContent.includes('secret words'), false);
  assert.equal(host.lastShadowRoot.mode, 'closed');
  assert.equal(textOf(host.lastShadowRoot.querySelector('.wrap')).includes('secret words'), true, 'the closure (the test handle) does see it');
  assert.equal(Object.keys(env.sandbox).some((name) => /wrap|root|host|state|ui/i.test(name)), false, 'no variable of the script is reachable as a global');
});

test('host element: the region and close button carry their labels from chrome.i18n and the glyph comes from CSS, not text', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const wrap = env.wrap();
  assert.equal(wrap.getAttribute('role'), 'region');
  assert.equal(wrap.getAttribute('aria-label'), MESSAGES.overlayRegion);
  const close = wrap.querySelector('.close');
  assert.equal(close.localName, 'button');
  assert.equal(close.getAttribute('type'), 'button');
  assert.equal(close.getAttribute('aria-label'), MESSAGES.overlayHide);
  assert.equal(close.textContent, '', 'the button has no text; its glyph is drawn by .close::before');
  assert.equal(wrap.children[0], close, 'the close button is the first child (the only pointer-events:auto element)');
  assert.equal(wrap.querySelectorAll('[aria-live]').length, 0, 'no aria-live on the overlay (partial captions would flood screen readers)');
  assert.equal(env.document.activeElement, null, 'the overlay never takes focus');
});

test('host element: every message the overlay reads is one of the seven of 9.3, and a missing message renders empty, never a key', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')], { gaps: { input: true } }));
  await env.send(captionsFrame('mic', [row('b', 'y')], { lang: 'en' }));
  await env.send(statusFrame('tab', 'reconnecting'));
  await env.send(statusFrame('mic', 'stopped'));
  assert.deepEqual([...new Set(env.spy.log.names)].sort(), Object.keys(MESSAGES).sort());

  const bare = await boot({ messages: {} });
  await bare.start();
  await bare.send(captionsFrame('tab', [row('a', 'x')]));
  await bare.send(statusFrame('tab', 'reconnecting'));
  assert.equal(bare.shown().lanes.tab.chip, '');
  assert.deepEqual(bare.shown().lanes.tab.status, ['reconnecting', '']);
  assert.equal(bare.wrap().getAttribute('aria-label'), '');
});

test('stylesheet: a constructable sheet is adopted (primary); without CSSStyleSheet or when it throws, a <style> element with the same text is the fallback', async () => {
  const primary = await boot();
  await primary.start();
  await primary.send(captionsFrame('tab', [row('a', 'x')]));
  const sheets = primary.root().adoptedStyleSheets;
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].replaceCalls, 1);
  const css = sheets[0].cssText;
  assert.match(css, /\.wrap \{/);
  assert.equal(primary.root().querySelectorAll('style').length, 0);

  const noApi = await boot({ sheet: null });
  await noApi.start();
  await noApi.send(captionsFrame('tab', [row('a', 'x')]));
  assert.equal(noApi.root().adoptedStyleSheets.length, 0);
  const [style] = noApi.root().querySelectorAll('style');
  assert.equal(style.textContent, css, 'the fallback carries the very same stylesheet text');

  class ThrowingSheet extends FakeCSSStyleSheet { replaceSync() { throw new Error('blocked'); } }
  const broken = await boot({ sheet: ThrowingSheet });
  await broken.start();
  await broken.send(captionsFrame('tab', [row('a', 'x')]));
  assert.equal(broken.root().adoptedStyleSheets.length, 0);
  assert.equal(broken.root().querySelectorAll('style')[0].textContent, css);
  assert.equal(broken.browser.listenerErrors.length, 0);
});

test('stylesheet: the bottom-anchored overflow rules of 8.5.2 are present (newest row last, oldest lines clip, a top fade, no url())', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const css = env.root().adoptedStyleSheets[0].cssText;
  const rules = cssRules(css);
  const wrap = declarationsFor(rules, '.wrap');
  assert.equal(wrap.display, 'flex');
  assert.equal(wrap['flex-direction'], 'column');
  assert.equal(wrap['justify-content'], 'flex-end', 'an overflowing column overflows at its START edge: the oldest lines clip');
  assert.equal(wrap.overflow, 'hidden');
  assert.equal(wrap['min-height'], '0');
  assert.equal(wrap['max-height'], 'min(40vh, calc(var(--size) * 16px * 1.35 * 8))');
  assert.equal(wrap.position, 'fixed');
  assert.equal(wrap.left, '50%');
  assert.equal(wrap.width, 'min(90vw, 896px)');
  assert.equal(wrap['pointer-events'], 'none');
  for (const property of ['-webkit-mask-image', 'mask-image']) {
    assert.match(wrap[property], /^linear-gradient\(to bottom, transparent 0, #000 1\.5em\)/, `${property} fades the top edge`);
  }
  for (const selector of ['.lane', '.rows']) {
    const column = declarationsFor(rules, selector);
    assert.deepEqual([column.display, column['flex-direction'], column['justify-content'], column['min-height']], ['flex', 'column', 'flex-end', '0'], selector);
  }
  assert.equal(declarationsFor(rules, '.wrap[data-position="top"]').top, '16px');
  assert.equal(declarationsFor(rules, '.wrap[data-position="bottom"]').bottom, '16px');
  assert.equal(declarationsFor(rules, '.wrap[hidden]').display, 'none');
  assert.equal(declarationsFor(rules, '.close')['pointer-events'], 'auto');
  assert.equal(declarationsFor(rules, '.close::before').content, '"\\00d7"');
  assert.deepEqual(declarationsFor(rules, '.wrap', '@media (prefers-reduced-motion: no-preference)'), { transition: 'opacity 150ms ease-out' });
  assert.equal(declarationsFor(rules, '.wrap', '@media (forced-colors: active)')['border-color'], 'CanvasText');
  assert.doesNotMatch(css, /url\s*\(|@import|@font-face/i);
  assert.doesNotMatch(css, /position:\s*(?:sticky|absolute)[^}]*\}\s*\.wrap/, 'nothing but the close button is absolute');
});

// ---------------------------------------------------------------------------
// Caption rendering (8.5.3)

test('captions: the last maxLines non-skipped rows, newest LAST, with status attributes, the lane chip and lang', async () => {
  const env = await boot();
  await env.start({ maxLines: 3 });
  await env.send(captionsFrame('tab', [row('a', 'one'), row('x', 'hidden one', 'final', { skipped: true }), row('b', 'two'), row('c', 'three'),
    row('d', 'four', 'partial')], { lang: 'ko' }));
  assert.deepEqual(env.rows('tab'), [['final', 'two'], ['final', 'three'], ['partial', 'four']]);
  assert.equal(env.shown().lanes.tab.lang, 'ko');
  assert.equal(env.shown().lanes.tab.chip, MESSAGES.overlayLaneTab);
  assert.equal(env.shown().hidden, false);

  await env.send(styleFrame({ maxLines: 1 }));
  assert.deepEqual(env.rows('tab'), [['partial', 'four']]);
  await env.send(styleFrame({ maxLines: 6 }));
  assert.deepEqual(env.rows('tab'), [['final', 'one'], ['final', 'two'], ['final', 'three'], ['partial', 'four']], 'skipped rows are not rendered and use no slot');
});

test('captions: every row of every status carries dir="auto" so mixed scripts are shaped by their own text', async () => {
  const env = await boot();
  await env.start({ maxLines: 6 });
  await env.send(captionsFrame('tab', [row('a', '안녕하세요'), row('b', 'hello 世界', 'interrupted'), row('c', 'こんにちは', 'partial')], { lang: 'ja' }));
  await env.send(captionsFrame('mic', [row('m', 'مرحبا'), row('n', '12:30 - 45%')], { lang: 'en' }));
  const rows = env.wrap().querySelectorAll('.row');
  assert.ok(rows.length >= 4, `rows are drawn (${rows.length})`);
  for (const item of rows) assert.equal(item.getAttribute('dir'), 'auto', `dir of "${item.textContent}"`);
  // Only the rows carry it: the lane sections, chips and status notes follow the pinned ltr of the host.
  assert.equal(env.wrap().querySelectorAll('[dir]').length, rows.length, 'no other element sets a direction');
  assert.equal(env.wrap().getAttribute('dir'), null);
});

test('captions: position top and bottom both keep the newest row last', async () => {
  for (const position of ['top', 'bottom']) {
    const env = await boot();
    await env.start({ position });
    await env.send(captionsFrame('mic', [row('a', 'old'), row('b', 'new')], { lang: 'en' }));
    assert.equal(env.wrap().getAttribute('data-position'), position);
    assert.deepEqual(env.rows('mic'), [['final', 'old'], ['final', 'new']], position);
  }
});

test('captions: an interrupted row is dropped as soon as a newer row exists, and kept while it is the newest', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'cut off', 'interrupted')]));
  assert.deepEqual(env.rows('tab'), [['interrupted', 'cut off']]);
  await env.send(captionsFrame('tab', [row('a', 'cut off', 'interrupted'), row('b', 'next')]));
  assert.deepEqual(env.rows('tab'), [['final', 'next']]);
  await env.send(captionsFrame('tab', [row('a', 'ok'), row('b', 'cut', 'interrupted')]));
  assert.deepEqual(env.rows('tab'), [['final', 'ok'], ['interrupted', 'cut']]);
});

test('captions: both lanes render in tab, mic order with their own chip and lang', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('mic', [row('m', 'hello')], { lang: 'en' }));
  await env.send(captionsFrame('tab', [row('t', '안녕')], { lang: 'ko' }));
  assert.deepEqual(Object.keys(env.shown().lanes), ['tab', 'mic']);
  assert.deepEqual(env.wrap().querySelectorAll('section').map((section) => section.getAttribute('data-lane')), ['tab', 'mic']);
  assert.deepEqual(env.shown().lanes.tab, { lang: 'ko', chip: MESSAGES.overlayLaneTab, rows: [['final', '안녕']], status: null });
  assert.deepEqual(env.shown().lanes.mic, { lang: 'en', chip: MESSAGES.overlayLaneMic, rows: [['final', 'hello']], status: null });
});

test('captions: text is set with textContent only, so markup in a caption stays text', async () => {
  const env = await boot();
  await env.start();
  const hostile = '<img src=x onerror=alert(1)><b>bold</b>';
  await env.send(captionsFrame('tab', [row('a', hostile)]));
  assert.deepEqual(env.rows('tab'), [['final', hostile]]);
  assert.equal(env.wrap().querySelectorAll('img').length + env.wrap().querySelectorAll('b').length, 0);
  assert.equal(env.hostElement().parentNode, env.document.documentElement, 'still alive: nothing used innerHTML (the fake would have thrown)');
});

test('captions: a long text is cut to 400 characters KEEPING THE END, and never through a surrogate pair', async () => {
  const env = await boot();
  await env.start();
  const long = `${'a'.repeat(900)}END`;
  await env.send(captionsFrame('tab', [row('a', long)]));
  const [[, text]] = env.rows('tab');
  assert.equal(text.length, 400);
  assert.equal(text, `…${long.slice(-399)}`);
  assert.equal(text.endsWith('aaaEND'), true);

  const pair = `${'x'.repeat(5)}\u{1F600}${'y'.repeat(398)}`;   // the cut would land on the low surrogate at index 6
  await env.send(captionsFrame('tab', [row('a', pair)]));
  const [[, cut]] = env.rows('tab');
  assert.equal(cut, `…${'y'.repeat(398)}`);
  assert.equal(/[\udc00-\udfff]/.test(cut.charAt(1)) && !/[\ud800-\udbff]/.test(cut.charAt(0)), false, 'no lone low surrogate');
  const exact = 'z'.repeat(400);
  await env.send(captionsFrame('tab', [row('a', exact)]));
  assert.equal(env.rows('tab')[0][1], exact, 'exactly 400 characters is left alone');
});

test('captions: lang decides the lang attribute only for ko, en and ja (anything else draws without it)', async () => {
  const env = await boot();
  await env.start();
  for (const lang of ['ko', 'en', 'ja']) {
    await env.send(captionsFrame('tab', [row('a', lang)], { lang }));
    assert.equal(env.shown().lanes.tab.lang, lang);
  }
  await env.send(captionsFrame('tab', [row('a', 'odd')], { lang: 'xx' }));
  assert.deepEqual(env.rows('tab'), [['final', 'odd']]);
  assert.equal(env.shown().lanes.tab.lang, null);
});

test('captions: malformed, oversized and unknown frames are ignored and change nothing', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'stays')], { epoch: 2 }));
  const before = env.shown();
  const good = captionsFrame('tab', [row('b', 'replaced')], { epoch: 2 });
  const bad = [
    null, 'text', 7, [], {}, { v: 1 }, { type: 'captions' },
    { ...good, v: 2 }, { ...good, type: 'captionz' },
    { ...good, lane: 'other' }, { ...good, lane: undefined }, { ...good, epoch: -1 }, { ...good, epoch: 1.5 }, { ...good, epoch: '2' },
    { ...good, rows: 'nope' }, { ...good, rows: undefined }, { ...good, rows: Array.from({ length: 7 }, (_, index) => row(`r${index}`, 'x')) },
    { ...good, rows: [{ id: 'a', status: 'final' }] }, { ...good, rows: [{ ...row('a', 'x'), status: 'shouting' }] }, { ...good, rows: [{ ...row('a', 'x'), text: 5 }] },
    { ...good, rows: [null] }, { ...good, gaps: undefined }, { ...good, gaps: 'no' },
    { ...good, pad: 'x'.repeat(20000) },
    statusFrame('nobody', 'stopped'), statusFrame('tab', 'exploding'), { v: 1, type: 'status', lane: 'tab' }, clearFrame('nobody'),
    { v: 1, type: 'style', style: null }, { v: 1, type: 'style', style: 'big' }, { v: 1, type: 'style' }, { v: 1, type: 'hello' }, { v: 1, type: 'anything' },
  ];
  for (const frame of bad) {
    await env.send(frame);
    assert.deepEqual(env.shown(), before, `ignored: ${JSON.stringify(frame)?.slice(0, 80)}`);
  }
  assert.equal(env.browser.listenerErrors.length, 0);
  assert.equal(env.ports[0].disconnected, false, 'garbage never closes the port');
  await env.send(good);
  assert.deepEqual(env.rows('tab'), [['final', 'replaced']]);
});

// ---------------------------------------------------------------------------
// style frame

test('style: valid values are stored and painted (position, display, --size), before any style frame the defaults hold', async () => {
  const env = await boot();
  await env.attach();
  await env.send(captionsFrame('tab', [row('a', 'one'), row('b', 'two'), row('c', 'three'), row('d', 'four')]));
  const wrap = env.wrap();
  assert.deepEqual([wrap.getAttribute('data-position'), wrap.getAttribute('data-display'), wrap.style.getPropertyValue('--size')], ['bottom', 'dark', '1.5']);
  assert.equal(env.rows('tab').length, 3, 'default maxLines is 3');

  await env.send(styleFrame({ size: 2, position: 'top', display: 'light', maxLines: 4, autoHideSeconds: 0 }));
  assert.deepEqual([wrap.getAttribute('data-position'), wrap.getAttribute('data-display'), wrap.style.getPropertyValue('--size')], ['top', 'light', '2']);
  assert.equal(env.rows('tab').length, 4);
  await env.send(styleFrame({ display: 'mono', size: 1, maxLines: 1 }));
  assert.deepEqual([wrap.getAttribute('data-display'), wrap.style.getPropertyValue('--size'), env.rows('tab').length], ['mono', '1', 1]);
});

test('style: an out-of-range or mistyped field keeps its previous value while valid fields in the same frame apply', async () => {
  const env = await boot();
  await env.start({ size: 1.75, position: 'top', display: 'light', maxLines: 5, autoHideSeconds: 20 });
  const wrap = env.wrap();
  const snapshot = () => [wrap.getAttribute('data-position'), wrap.getAttribute('data-display'), wrap.style.getPropertyValue('--size')];
  assert.deepEqual(snapshot(), ['top', 'light', '1.75']);
  for (const bad of [{ size: 3 }, { size: 0.5 }, { size: '2' }, { size: null }, { position: 'left' }, { display: 'neon' }, { maxLines: 0 }, { maxLines: 7 },
    { maxLines: 1.5 }, { maxLines: '3' }, { autoHideSeconds: -1 }, { autoHideSeconds: 61 }, { autoHideSeconds: 1.5 }]) {
    await env.send({ v: 1, type: 'style', style: bad });
    assert.deepEqual(snapshot(), ['top', 'light', '1.75'], JSON.stringify(bad));
  }
  await env.send(captionsFrame('tab', Array.from({ length: 6 }, (_, index) => row(`r${index}`, `row ${index}`))));
  assert.equal(env.rows('tab').length, 5, 'maxLines stayed 5');
  await env.send({ v: 1, type: 'style', style: { size: 1.25, position: 'sideways', maxLines: 99 } });
  assert.deepEqual(snapshot(), ['top', 'light', '1.25'], 'the valid size applied, the invalid fields did not');
  await env.tick(19999);
  assert.equal(env.shown().hidden, false, 'autoHideSeconds stayed 20');
});

// ---------------------------------------------------------------------------
// dismiss and epochs

test('dismiss: the close button hides the wrap; a frame of the SAME epoch (one rule: <=) and an older one stay hidden; a newer epoch shows it again', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'hello')], { epoch: 3 }));
  assert.equal(env.shown().hidden, false);
  env.wrap().querySelector('.close').click();
  assert.equal(env.shown().hidden, true);
  await env.send(captionsFrame('tab', [row('a', 'hello'), row('b', 'about 100 ms later')], { epoch: 3, seq: 2 }));
  assert.equal(env.shown().hidden, true, 'the very next frame of the same epoch must not undo the dismissal');
  await env.send(captionsFrame('tab', [row('c', 'stale')], { epoch: 2 }));
  assert.equal(env.shown().hidden, true, 'an older epoch is ignored too');
  await env.send(captionsFrame('tab', [row('d', 'new run')], { epoch: 4 }));
  assert.equal(env.shown().hidden, false);
  assert.deepEqual(env.rows('tab'), [['final', 'new run']]);
});

test('dismiss: clear {lane} resets the dismissal, so the panel captions checkbox off/on brings the overlay back at the same epoch', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'hello')], { epoch: 3 }));
  env.wrap().querySelector('.close').click();
  await env.send(clearFrame('tab'));
  assert.equal(env.shown().hidden, true, 'nothing to show right after clear');
  await env.send(captionsFrame('tab', [row('a', 'hello again')], { epoch: 3, seq: 9 }));
  assert.equal(env.shown().hidden, false);
  assert.deepEqual(env.rows('tab'), [['final', 'hello again']]);
});

test('dismiss: it is per lane, and a dismissed lane hides its status row too until a newer epoch or a clear', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'tab words')], { epoch: 3 }));
  await env.send(captionsFrame('mic', [row('b', 'mic words')], { epoch: 5, lang: 'en' }));
  await env.send(statusFrame('tab', 'reconnecting'));
  env.wrap().querySelector('.close').click();
  assert.equal(env.shown().hidden, true);
  await env.send(statusFrame('tab', 'reconnecting'));
  assert.equal(env.shown().hidden, true, 'a status frame does not bring back a dismissed lane');
  await env.send(captionsFrame('mic', [row('b', 'mic words'), row('c', 'more')], { epoch: 5, lang: 'en' }));
  assert.equal(env.shown().hidden, true, 'the mic lane is dismissed at epoch 5');
  await env.send(captionsFrame('mic', [row('d', 'a new mic run')], { epoch: 6, lang: 'en' }));
  assert.deepEqual(Object.keys(env.shown().lanes), ['mic'], 'only the lane with a newer epoch returns');
  await env.send(captionsFrame('tab', [row('e', 'tab is back')], { epoch: 4 }));
  assert.deepEqual(Object.keys(env.shown().lanes), ['tab', 'mic']);
  assert.deepEqual(env.shown().lanes.tab.status, ['reconnecting', MESSAGES.overlayReconnecting], 'the stored status shows again with the lane');
});

test('dismiss: a lane that has only a status row can be dismissed as well, and the gap line goes with the close', async () => {
  const env = await boot();
  await env.start();
  await env.send(statusFrame('tab', 'stopped'));
  assert.equal(env.shown().hidden, false);
  env.wrap().querySelector('.close').click();
  assert.equal(env.shown().hidden, true);

  const gapped = await boot();
  await gapped.start();
  await gapped.send(captionsFrame('mic', [row('a', 'x')], { gaps: { audio: true } }));
  assert.equal(gapped.shown().gap, MESSAGES.overlayGap);
  gapped.wrap().querySelector('.close').click();
  assert.equal(gapped.shown().hidden, true);
  assert.equal(gapped.browser.clock.pending(), 1, 'only the (still running) auto-hide timer of the dismissed rows remains; the gap timer is gone');
});

// ---------------------------------------------------------------------------
// status and gap lines

test('status: reconnecting persists until running, stopped clears after about 8 s, and a status alone shows the wrap', async () => {
  const env = await boot();
  await env.start();
  assert.equal(env.shown().hidden, true, 'nothing to say: nothing is drawn');
  await env.send(statusFrame('tab', 'reconnecting'));
  assert.equal(env.shown().hidden, false, 'a status row alone shows the wrap');
  assert.deepEqual(env.shown().lanes.tab.status, ['reconnecting', MESSAGES.overlayReconnecting]);
  assert.deepEqual(env.rows('tab'), []);
  await env.tick(60000);
  assert.deepEqual(env.shown().lanes.tab.status, ['reconnecting', MESSAGES.overlayReconnecting], 'it stays until running or bye');
  await env.send(statusFrame('tab', 'running'));
  assert.equal(env.shown().hidden, true);

  await env.send(statusFrame('mic', 'stopped'));
  assert.deepEqual(env.shown().lanes.mic.status, ['stopped', MESSAGES.overlayStopped]);
  await env.tick(7999);
  assert.notEqual(env.shown().lanes.mic, undefined);
  await env.tick(1);
  assert.equal(env.shown().hidden, true, 'the stopped row cleared itself');
  assert.equal(env.browser.clock.pending(), 0);
});

test('status: it sits next to the rows, survives a clear of the lane, and a later status replaces the earlier one and its timer', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'last words')]));
  await env.send(statusFrame('tab', 'stopped'));
  await env.send(clearFrame('tab'));
  assert.deepEqual(env.rows('tab'), [], 'clear dropped the rows');
  assert.deepEqual(env.shown().lanes.tab.status, ['stopped', MESSAGES.overlayStopped], 'and kept the status row');
  await env.tick(5000);
  await env.send(statusFrame('tab', 'reconnecting'));
  await env.tick(60000);
  assert.deepEqual(env.shown().lanes.tab.status, ['reconnecting', MESSAGES.overlayReconnecting], 'the old stopped timer no longer clears the new status');
});

test('gap line: a false -> true transition shows it for about 8 s, sticky flags do not restart it, a later transition shows it again', async () => {
  const env = await boot({ });
  await env.start({ autoHideSeconds: 0 });
  await env.send(captionsFrame('tab', [row('a', 'x')], { epoch: 1 }));
  assert.equal(env.shown().gap, null);
  await env.send(captionsFrame('tab', [row('a', 'x'), row('b', 'y')], { epoch: 1, gaps: { input: true } }));
  assert.equal(env.shown().gap, MESSAGES.overlayGap);
  await env.tick(4000);
  await env.send(captionsFrame('tab', [row('a', 'x'), row('b', 'y'), row('c', 'z')], { epoch: 1, gaps: { input: true } }));
  await env.tick(3999);
  assert.equal(env.shown().gap, MESSAGES.overlayGap, 'the sticky flag did not restart the 8 s');
  await env.tick(1);
  assert.equal(env.shown().gap, null, 'gone after about 8 s although the flag stays true');
  await env.send(captionsFrame('tab', [row('c', 'z')], { epoch: 1, gaps: { input: true } }));
  assert.equal(env.shown().gap, null, 'still no new transition');
  await env.send(captionsFrame('tab', [row('c', 'z')], { epoch: 1, gaps: { input: true, reception: true } }));
  assert.equal(env.shown().gap, MESSAGES.overlayGap, 'a second flag turning on is a new transition');
  await env.tick(8000);
  await env.send(captionsFrame('tab', [row('c', 'z')], { epoch: 2, gaps: { input: true } }));
  assert.equal(env.shown().gap, MESSAGES.overlayGap, 'a new epoch resets the flags it compares with');
});

test('gap line: it can show on its own (empty rows) and hides the wrap again afterwards', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [], { gaps: { audio: true } }));
  assert.equal(env.shown().hidden, false);
  assert.equal(env.shown().gap, MESSAGES.overlayGap);
  await env.tick(8000);
  assert.equal(env.shown().hidden, true);
});

// ---------------------------------------------------------------------------
// clear, auto-hide, visibility

test('clear: drops that lane\'s rows only, and a clear for a lane with nothing is harmless', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'tab')]));
  await env.send(captionsFrame('mic', [row('b', 'mic')], { lang: 'en' }));
  await env.send(clearFrame('tab'));
  assert.deepEqual(Object.keys(env.shown().lanes), ['mic']);
  await env.send(clearFrame('tab'));
  await env.send(clearFrame('mic'));
  assert.equal(env.shown().hidden, true);
  assert.equal(env.browser.clock.pending(), 0, 'no timer survives the clears');
});

test('auto-hide: rows hide after autoHideSeconds of unchanged frames, identical frames do not restart it, a different frame shows again', async () => {
  const env = await boot();
  await env.start({ autoHideSeconds: 3 });
  const one = captionsFrame('tab', [row('a', 'first')]);
  await env.send(one);
  assert.equal(env.shown().hidden, false);
  await env.tick(2000);
  await env.send({ ...one, seq: 2 });   // same rows again (a heartbeat from the host)
  await env.tick(999);
  assert.equal(env.shown().hidden, false);
  await env.tick(1);
  assert.equal(env.shown().hidden, true, 'hidden 3 s after the LAST DIFFERENT frame; the port stays open');
  assert.equal(env.ports[0].disconnected, false);
  await env.send({ ...one, seq: 3 });
  assert.equal(env.shown().hidden, true, 'the same words again do not bring it back');
  await env.send(captionsFrame('tab', [row('a', 'first'), row('b', 'second')]));
  assert.equal(env.shown().hidden, false);
  await env.tick(3000);
  assert.equal(env.shown().hidden, true);
});

test('auto-hide: 0 never hides, and changing the setting re-arms or disarms the running timers', async () => {
  const never = await boot();
  await never.start({ autoHideSeconds: 0 });
  await never.send(captionsFrame('tab', [row('a', 'still here')]));
  await never.tick(3600000);
  assert.equal(never.shown().hidden, false);
  assert.equal(never.browser.clock.pending(), 0);

  const env = await boot();
  await env.start({ autoHideSeconds: 5 });
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  await env.tick(4000);
  await env.send(styleFrame({ autoHideSeconds: 10 }));
  await env.tick(6000);
  assert.equal(env.shown().hidden, false, 'the new, longer period applies from the change');
  await env.tick(4000);
  assert.equal(env.shown().hidden, true);
  await env.send(captionsFrame('tab', [row('b', 'y')]));
  await env.send(styleFrame({ autoHideSeconds: 0 }));
  await env.tick(600000);
  assert.equal(env.shown().hidden, false, 'switching to 0 disarms the timer');
});

test('auto-hide: each lane has its own timer', async () => {
  const env = await boot();
  await env.start({ autoHideSeconds: 4 });
  await env.send(captionsFrame('tab', [row('a', 'early')]));
  await env.tick(2000);
  await env.send(captionsFrame('mic', [row('b', 'late')], { lang: 'en' }));
  await env.tick(2000);
  assert.deepEqual(Object.keys(env.shown().lanes), ['mic'], 'the tab lane timed out first');
  await env.tick(2000);
  assert.equal(env.shown().hidden, true);
});

test('visibility: nothing is rendered while the document is hidden, and the last frames render again when it is visible', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'while away')]));
  env.document.setVisibility('hidden');
  assert.equal(env.shown().hidden, true);
  await env.send(captionsFrame('tab', [row('a', 'while away'), row('b', 'news')]));
  assert.equal(env.shown().hidden, true, 'frames are still accepted, just not drawn');
  env.document.setVisibility('visible');
  assert.equal(env.shown().hidden, false);
  assert.deepEqual(env.rows('tab'), [['final', 'while away'], ['final', 'news']]);
});

// ---------------------------------------------------------------------------
// fullscreen (8.5.3)

const inside = (env) => env.hostElement().parentNode;
const player = (env) => env.document.getElementById('player');

test('fullscreen strategy 1: a plain container gets the host as a child and it is restored on exit', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'fullscreen words')]));
  env.document.setFullscreen(player(env));
  assert.equal(inside(env), player(env));
  assert.deepEqual(env.rows('tab'), [['final', 'fullscreen words']], 'still rendering');
  assert.equal(env.hostElement().popoverCalls.length, 0);
  env.document.setFullscreen(env.document.getElementById('app'));
  assert.equal(inside(env), env.document.getElementById('app'), 'moving between containers re-parents');
  env.document.setFullscreen(null);
  assert.equal(inside(env), env.document.documentElement);
  assert.equal(player(env).children.length, 1, 'the container has only its own child again');
});

test('fullscreen strategy 1: nothing to do for the root element, and a container that is already gone is treated as no fullscreen', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  env.document.setFullscreen(env.document.documentElement);
  assert.equal(inside(env), env.document.documentElement);
  assert.equal(env.hostElement().popoverCalls.length, 0);
  const detached = env.document.createElement('div');
  env.document.setFullscreen(detached);
  assert.equal(inside(env), env.document.documentElement, 'a detached element is never a home');
  assert.equal(detached.children.length, 0);
});

test('fullscreen strategy 1: restored when the container is removed (Chrome then fires fullscreenchange) and at the next render', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const host = env.hostElement();
  env.document.setFullscreen(player(env));
  assert.equal(host.parentNode, player(env));
  player(env).remove();
  env.document.setFullscreen(null);
  assert.equal(host.parentNode, env.document.documentElement);
  assert.equal(host.isConnected, true);

  const second = await boot({ html: PAGE_HTML });
  await second.start();
  await second.send(captionsFrame('tab', [row('a', 'x')]));
  const secondHost = second.hostElement();
  second.document.setFullscreen(player(second));
  player(second).remove();   // removed without an event: the host went with it
  assert.equal(secondHost.isConnected, false);
  await second.send(captionsFrame('tab', [row('a', 'x'), row('b', 'y')]));
  assert.equal(secondHost.parentNode, second.document.documentElement, 'every render puts it back');
  assert.equal(secondHost.isConnected, true);
});

test('fullscreen strategy 1: an exception while re-parenting restores at once and never reaches the page', async () => {
  const env = await boot({ html: PAGE_HTML, popover: false });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const container = player(env);
  container.appendChild = () => { throw new Error('the page forbids it'); };
  env.document.setFullscreen(container);
  assert.equal(inside(env), env.document.documentElement);
  assert.equal(env.browser.listenerErrors.length, 0);
  assert.deepEqual(env.rows('tab'), [['final', 'x']], 'the overlay is intact');
});

test('fullscreen strategy 1: refused for VIDEO, CANVAS, IMG, IFRAME, EMBED, OBJECT, INPUT, TEXTAREA, SELECT and SVG hosts, and for an open shadow root', async () => {
  const cases = ['video', 'canvas', 'img', 'iframe', 'embed', 'object', 'input', 'textarea', 'select'].map((tag) => (env) => env.document.createElement(tag));
  cases.push((env) => env.document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  cases.push((env) => { const div = env.document.createElement('div'); div.attachShadow({ mode: 'open' }); return div; });
  for (const make of cases) {
    const env = await boot({ html: PAGE_HTML });
    await env.start();
    await env.send(captionsFrame('tab', [row('a', 'x')]));
    const element = make(env);
    env.document.body.appendChild(element);
    env.document.setFullscreen(element);
    assert.equal(inside(env), env.document.documentElement, `${element.tagName}: not re-parented`);
    assert.equal(element.children.length, 0, `${element.tagName}: nothing appended`);
    assert.equal(env.hostElement().popover, 'manual', `${element.tagName}: strategy 2 took over`);
  }
});

test('fullscreen strategy 1: a container with a CLOSED shadow root cannot be detected and is used (the documented residual risk)', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const div = env.document.createElement('div');
  div.attachShadow({ mode: 'closed' });
  env.document.body.appendChild(div);
  env.document.setFullscreen(div);
  assert.equal(inside(env), div);
});

test('fullscreen strategy 2: a bare <video> gets a manual popover shown in the top layer, re-issued on every change, and removed on exit', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const host = env.hostElement();
  env.document.setFullscreen(env.document.getElementById('video'));
  assert.equal(host.parentNode, env.document.documentElement, 'it does not move');
  assert.equal(host.popover, 'manual');
  assert.equal(host.popoverOpen, true);
  assert.deepEqual(host.popoverCalls, ['hide', 'show']);
  env.document.setFullscreen(env.document.getElementById('video'));
  assert.deepEqual(host.popoverCalls, ['hide', 'show', 'hide', 'hide', 'show'], 'restored then re-issued so it stacks above the fullscreen element');
  env.document.setFullscreen(null);
  assert.equal(host.popover, null, 'the popover attribute is removed');
  assert.equal(host.popoverOpen, false);
  assert.equal(host.popoverCalls.at(-1), 'hide');
});

test('fullscreen strategy 3: without popover support nothing moves and nothing breaks', async () => {
  const env = await boot({ html: PAGE_HTML, popover: false });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const host = env.hostElement();
  env.document.setFullscreen(env.document.getElementById('video'));
  assert.equal(host.parentNode, env.document.documentElement);
  assert.equal(host.hasAttribute('popover'), false);
  assert.deepEqual(env.rows('tab'), [['final', 'x']]);
  env.document.setFullscreen(null);
  assert.equal(host.parentNode, env.document.documentElement);
});

test('fullscreen: already fullscreen when the overlay first draws puts it in the container from the start', async () => {
  const env = await boot({ html: PAGE_HTML });
  env.document.setFullscreen(player(env));
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  assert.equal(inside(env), player(env));
});

// ---------------------------------------------------------------------------
// The page is not touched beyond the allowed list

function snapshotPage(document, { without = 'interp-live-captions' } = {}) {
  const nodes = [];
  const visit = (element) => {
    nodes.push({ tag: element.localName, attributes: JSON.stringify(element.attributes), listeners: element.listenerCount,
      children: element.children.filter((child) => child.localName !== without).map((child) => child.localName), text: element.textContent });
    for (const child of element.children) if (child.localName !== without) visit(child);
  };
  visit(document.documentElement);
  return nodes;
}

test('page: one element is appended and two document events are listened to; no page element gets an attribute, a class or a listener, and all of it is undone', async () => {
  const env = await boot({ html: PAGE_HTML });
  const before = snapshotPage(env.document);
  assert.equal(env.document.listenerCount, 0);
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  await env.send(captionsFrame('mic', [row('b', 'y')], { lang: 'en', gaps: { input: true } }));
  await env.send(statusFrame('tab', 'reconnecting'));
  env.wrap().querySelector('.close').click();
  env.document.setFullscreen(player(env));
  env.document.setFullscreen(null);
  env.document.setFullscreen(env.document.getElementById('video'));
  env.document.setFullscreen(null);
  env.document.setVisibility('hidden');
  env.document.setVisibility('visible');
  assert.deepEqual(snapshotPage(env.document), before, 'mid-session the page (minus our host) is byte-for-byte what it was');
  assert.equal(env.document.documentElement.children.filter((child) => child.localName === 'interp-live-captions').length, 1);
  assert.deepEqual([env.document.listeners('visibilitychange').length, env.document.listeners('fullscreenchange').length, env.document.listenerCount], [1, 1, 2]);
  assert.equal(env.document.activeElement, null);

  await env.send(BYE);
  assert.deepEqual(snapshotPage(env.document), before);
  assert.equal(env.hostElement(), null, 'the host is gone');
  assert.equal(env.document.listenerCount, 0, 'both document listeners are removed');
  assert.equal(env.document.documentElement.children.length, before.find((node) => node.tag === 'html').children.length);
});

test('page: the only document properties read are documentElement, fullscreenElement, visibilityState and the build/wire helpers; the fullscreen element only for tagName, isConnected, shadowRoot and appendChild', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  const reads = new Set();
  const container = new Proxy(player(env), { get(target, key) {
    reads.add(String(key));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  env.document.setFullscreen(container);
  env.document.setFullscreen(null);
  env.document.setFullscreen(env.document.getElementById('video'));
  env.document.setFullscreen(null);
  env.document.setVisibility('hidden');
  env.document.setVisibility('visible');
  await env.send(BYE);
  assert.deepEqual([...env.documentReads].sort(), ALLOWED_DOCUMENT);
  assert.deepEqual([...reads].sort(), ALLOWED_FULLSCREEN);
});

test('page: nothing is stored and only hello ever leaves the overlay', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  await env.send(statusFrame('tab', 'stopped'));
  env.wrap().querySelector('.close').click();
  await env.send(BYE);
  assert.deepEqual(env.received, [HELLO]);
  const fromContent = env.browser.deliveries.filter((delivery) => delivery.from === 'content');
  assert.deepEqual(fromContent.filter((delivery) => delivery.kind === 'port-frame').map((delivery) => delivery.json), [JSON.stringify(HELLO)]);
  assert.deepEqual(fromContent.filter((delivery) => delivery.kind !== 'port-frame').map((delivery) => [delivery.kind, delivery.json]),
    [['response', '{"ok":true}']], 'the only other thing it ever sends is the {ok:true} answer to the attach message');
  assert.equal(env.content.storageTouched, false);
  assert.deepEqual(env.browser.storageData('local'), {});
  assert.deepEqual(env.browser.storageData('session'), {});
});

// ---------------------------------------------------------------------------
// Ports: bye, disconnect, reconnect, replaced ports, orphaning, failures

test('bye: removes the UI, closes the port, clears every timer, keeps the message listener, and a later attach starts clean', async () => {
  const env = await boot();
  await env.start({ autoHideSeconds: 10 });
  await env.send(captionsFrame('tab', [row('a', 'x')], { epoch: 3, gaps: { input: true } }));
  await env.send(statusFrame('mic', 'stopped'));
  assert.ok(env.browser.clock.pending() >= 3, 'auto-hide, gap and status timers are running');
  env.wrap().querySelector('.close').click();
  await env.send(BYE);
  assert.equal(env.hostElement(), null);
  assert.equal(env.ports[0].disconnected, true, 'the overlay closed its end');
  assert.equal(env.browser.clock.pending(), 0);
  assert.equal(env.listenerCount(), 1, 'the message listener stays for the next lane start');
  assert.ok(marker(env), 'still marked as injected');

  await env.attach();
  assert.equal(env.ports.length, 2);
  assert.deepEqual(env.received, [HELLO, HELLO]);
  await env.send(styleFrame());
  await env.send(captionsFrame('tab', [row('a', 'again')], { epoch: 3 }));
  assert.deepEqual(env.rows('tab'), [['final', 'again']], 'the dismissal of the previous run is forgotten with it');
});

test('disconnect: the host closing the port removes the UI but keeps the listener; attach then connects again', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  env.ports[0].disconnect();
  await env.browser.settle();
  assert.equal(env.hostElement(), null);
  assert.equal(env.browser.clock.pending() >= 0, true);
  assert.equal(env.document.listenerCount, 0);
  assert.equal(env.listenerCount(), 1);
  await env.attach();
  await env.send(styleFrame());
  await env.send(captionsFrame('tab', [row('b', 'back')]));
  assert.deepEqual(env.rows('tab'), [['final', 'back']]);
  assert.equal(env.spy.log.connects, 2);
});

test('disconnect: a port that finds no host receiver never draws anything', async () => {
  const env = await boot();
  env.offscreen.close();   // nobody listens for interp-overlay/1
  assert.deepEqual(await env.attach(), { ok: true });
  assert.equal(env.hostElement(), null);
  assert.equal(env.document.listenerCount, 0);
  assert.equal(env.listenerCount(), 1);
  assert.equal(env.browser.listenerErrors.length, 0);
});

test('disconnect: a LATE disconnect of a port that is no longer current cannot dispose the UI of the new one', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'first')]));
  const stale = env.spy.log.ports[0];
  env.ports[0].disconnect();
  await env.browser.settle();
  await env.start();
  await env.send(captionsFrame('tab', [row('b', 'second')]));
  assert.equal(env.ports.length, 2);
  for (const handler of stale.disconnectHandlers) handler(stale.port);   // the old port's disconnect arrives late
  assert.equal(env.hostElement()?.isConnected, true, 'the UI of the new port stays');
  assert.deepEqual(env.rows('tab'), [['final', 'second']]);
  await env.send(captionsFrame('tab', [row('b', 'second'), row('c', 'third')]));
  assert.deepEqual(env.rows('tab'), [['final', 'second'], ['final', 'third']], 'and it still receives frames');
  assert.equal(env.ports[1].disconnected, false);
});

test('disconnect: a late FRAME of a replaced port is ignored', async () => {
  const env = await boot();
  await env.start();
  const oldHostEnd = env.ports[0];
  env.ports[0].disconnect();
  await env.browser.settle();
  await env.start();
  await env.send(captionsFrame('tab', [row('b', 'current')]));
  const before = env.shown();
  // The recorded old port is disconnected; a frame delivered through it (as a racing host might) must do nothing.
  assert.throws(() => oldHostEnd.postMessage(captionsFrame('tab', [row('z', 'from the old port')])), /disconnected/);
  await env.browser.settle();
  assert.deepEqual(env.shown(), before);
  // The fake refuses to deliver through a closed port, so the racing frame is replayed through the handler the overlay
  // registered on the OLD port: it must not reach the UI of the port that replaced it.
  const stale = env.spy.log.ports[0];
  assert.equal(stale.messageHandlers.length, 1, 'the overlay registered one message handler on the old port');
  for (const handler of stale.messageHandlers) handler(captionsFrame('tab', [row('z', 'from the old port')], { epoch: 9 }));
  await env.browser.settle();
  assert.deepEqual(env.shown(), before, 'the late frame of the replaced port changed nothing');
  await env.send(captionsFrame('tab', [row('b', 'current'), row('c', 'next')], { epoch: 9 }));
  assert.deepEqual(env.rows('tab'), [['final', 'current'], ['final', 'next']], 'the current port still drives the UI');
});

test('bye: a late captions frame of the detached port draws nothing, so the overlay is never resurrected over the page', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'first')]));
  assert.equal(env.hostElement()?.isConnected, true);
  const stale = env.spy.log.ports[0];
  await env.send(BYE);
  assert.equal(env.hostElement(), null, 'bye removed the UI');
  // A captions frame that the host had already posted when it said bye arrives afterwards, on the same (old) port.
  for (const handler of stale.messageHandlers) handler(captionsFrame('tab', [row('z', 'late')], { epoch: 5 }));
  await env.browser.settle();
  assert.equal(env.hostElement(), null, 'no host element came back');
  assert.equal(env.document.querySelectorAll('interp-live-captions').length, 0);
  assert.equal(env.document.listenerCount, 0, 'no document listener came back');
  assert.equal(env.browser.clock.pending(), 0, 'no timer came back');
  assert.equal(env.listenerCount(), 1, 'the message listener stays for the next lane start');

  await env.attach();   // and the next run starts clean
  assert.equal(env.ports.length, 2);
  await env.send(styleFrame());
  await env.send(captionsFrame('tab', [row('a', 'again')], { epoch: 5 }));
  assert.deepEqual(env.rows('tab'), [['final', 'again']], 'the late frame left no dismissal or row behind');
});

test('orphan: a frame that arrives after chrome.runtime.id is gone removes the UI, the timers and the listener without throwing', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')], { gaps: { input: true } }));
  env.spy.control.orphaned = true;
  await env.send(captionsFrame('tab', [row('a', 'x'), row('b', 'y')]));
  assert.equal(env.hostElement(), null);
  assert.equal(env.document.listenerCount, 0);
  assert.equal(env.browser.clock.pending(), 0);
  assert.equal(env.listenerCount(), 0, 'the message listener is gone: this script is dead for good');
  assert.equal(marker(env), undefined, 'and a fresh injection may run');
  assert.equal(env.ports[0].disconnected, true);
  assert.equal(env.browser.listenerErrors.length, 0);
});

test('orphan: the extension being reloaded under the script (context invalidated) disposes it without throwing', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  env.content.invalidate();
  await env.browser.settle();
  assert.equal(env.hostElement(), null, 'the DOM is removed');
  assert.equal(env.document.listenerCount, 0);
  assert.equal(env.browser.clock.pending(), 0);
  assert.equal(marker(env), undefined);
  assert.equal(env.browser.listenerErrors.length, 0);
  assert.deepEqual(snapshotPage(env.document), snapshotPage(parseHtml(PAGE_HTML)), 'the page is exactly as it was');
  assert.doesNotThrow(() => env.run(), 'injecting again into a dead runtime is harmless');
});

test('orphan: a script that is orphaned when the attach arrives does not connect', async () => {
  const env = await boot();
  env.spy.control.orphaned = true;
  await assert.rejects(env.sender.chrome.tabs.sendMessage(7, ATTACH), /port closed/, 'runtime.id no longer matches the sender: not trusted, no answer');
  assert.equal(env.spy.log.connects, 0);
});

test('failure: a render that throws removes the overlay silently (also from a timer) and the next attach can start again', async () => {
  const env = await boot();
  await env.start({ autoHideSeconds: 5 });
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  env.wrap().replaceChildren = () => { throw new Error('boom'); };
  await env.send(captionsFrame('tab', [row('a', 'x'), row('b', 'y')]));
  assert.equal(env.browser.listenerErrors.length, 0, 'nothing escaped into the page');
  assert.equal(env.hostElement(), null);
  assert.equal(env.ports[0].disconnected, true);
  assert.equal(env.listenerCount(), 1);
  assert.equal(env.document.listenerCount, 0);
  assert.equal(env.browser.clock.pending(), 0);
  await env.attach();
  await env.send(captionsFrame('tab', [row('c', 'fresh')]));
  assert.deepEqual(env.rows('tab'), [['final', 'fresh']]);

  // The same failure inside a timer callback (auto-hide) is absorbed too: tick() would reject if it escaped.
  env.wrap().replaceChildren = () => { throw new Error('boom again'); };
  await env.tick(8000);   // the default autoHideSeconds
  assert.equal(env.hostElement(), null);
  assert.equal(env.browser.clock.pending(), 0);
});

test('failure: a throwing DOM event handler (the close button) and a throwing document event are absorbed', async () => {
  const env = await boot({ html: PAGE_HTML });
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  env.wrap().replaceChildren = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => env.wrap().querySelector('.close').click());
  assert.equal(env.hostElement(), null);
  await env.attach();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  env.wrap().replaceChildren = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => env.document.setVisibility('hidden'), 'hidden draws nothing, so nothing throws');
  assert.equal(env.hostElement()?.isConnected, true);
  assert.doesNotThrow(() => env.document.setVisibility('visible'));
  assert.equal(env.hostElement(), null);
});

test('dispose(): the exposed handle removes everything including the message listener and the marker', async () => {
  const env = await boot();
  await env.start();
  await env.send(captionsFrame('tab', [row('a', 'x')]));
  marker(env).dispose();
  await env.browser.settle();
  assert.equal(env.hostElement(), null);
  assert.equal(env.listenerCount(), 0);
  assert.equal(marker(env), undefined);
  assert.equal(env.ports[0].disconnected, true);
  assert.equal(env.browser.clock.pending(), 0);
  env.run();
  assert.equal(env.listenerCount(), 1, 'a new injection works after dispose');
});
