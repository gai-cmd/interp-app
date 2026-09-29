// New implementation of docs/extension.md §11.1 (extension-chrome-adapter); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ADAPTER_SURFACE, createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';

// Section 3.4: the adapter is the ONLY seam that names the platform global. These tests walk the adapter and the
// nested ADAPTER_SURFACE in parallel, so a new API use forces a doc and test change, and they pin the "absent member
// is skipped, never bound" rule that keeps the offscreen host from dying at start.

const isNamespaceSpec = (spec) => spec !== true && !Array.isArray(spec);

// Walks adapter and surface together; `real` is the chrome-shaped object the adapter was made from.
function walk(adapter, spec, real, path, visit) {
  if (Array.isArray(spec)) {
    for (const name of spec) visit(`${path}.${name}`, adapter, real, name);
    for (const name of Object.keys(adapter)) assert.ok(spec.includes(name), `${path}.${name} is not in the surface`);
    return;
  }
  for (const [name, inner] of Object.entries(spec)) {
    if (inner === true) { visit(`${path}.${name}`, adapter, real, name); continue; }
    const child = adapter[name];
    if (real?.[name] === undefined) { assert.equal(child, undefined, `${path}.${name} is absent from the real object`); continue; }
    assert.ok(child, `${path}.${name} is present`);
    walk(child, inner, real[name], `${path}.${name}`, visit);
  }
  for (const name of Object.keys(adapter)) assert.ok(name in spec, `${path}.${name} is not in the surface`);
}

test('ADAPTER_SURFACE is deeply frozen and nested like the adapter', () => {
  assert.ok(Object.isFrozen(ADAPTER_SURFACE));
  for (const spec of Object.values(ADAPTER_SURFACE)) {
    assert.ok(Object.isFrozen(spec));
    if (isNamespaceSpec(spec)) for (const inner of Object.values(spec)) if (inner !== true) assert.ok(Object.isFrozen(inner));
  }
  assert.deepEqual(Object.keys(ADAPTER_SURFACE), ['runtime', 'storage', 'tabs', 'windows', 'tabCapture', 'sidePanel', 'action',
    'commands', 'contextMenus', 'offscreen', 'scripting', 'i18n']);
});

test('the adapter over the service worker context mirrors the surface member by member', () => {
  const browser = createFakeBrowser();
  const real = browser.sw.register(() => {}).chrome;
  const adapter = createChromeAdapter(real);
  assert.ok(Object.isFrozen(adapter));
  walk(adapter, ADAPTER_SURFACE, real, 'adapter', (path, holder, source, name) => {
    if (source?.[name] === undefined) { assert.equal(holder[name], undefined, `${path} is skipped when absent`); return; }
    assert.notEqual(holder[name], undefined, `${path} is copied`);
  });
  for (const namespace of ['runtime', 'storage', 'tabs', 'windows', 'tabCapture', 'sidePanel', 'action', 'commands',
    'contextMenus', 'offscreen', 'scripting', 'i18n']) assert.ok(adapter[namespace], `${namespace} exists in the worker`);
  assert.ok(Object.isFrozen(adapter.runtime));
  assert.ok(Object.isFrozen(adapter.storage));
  assert.ok(Object.isFrozen(adapter.storage.local));
  assert.equal(typeof adapter.runtime.onStartup.addListener, 'function');
  assert.equal(typeof adapter.commands.getAll, 'function');
});

test('an extra method on the real object is not copied, and events and properties pass through unchanged', () => {
  const browser = createFakeBrowser();
  const real = browser.sw.register(() => {}).chrome;
  real.runtime.somethingNew = () => 'x';
  real.somethingElse = { a: 1 };
  const adapter = createChromeAdapter(real);
  assert.equal(adapter.runtime.somethingNew, undefined);
  assert.equal(adapter.somethingElse, undefined);
  assert.equal(adapter.runtime.onMessage, real.runtime.onMessage);
  assert.equal(adapter.storage.onChanged, real.storage.onChanged);
  assert.equal(adapter.runtime.id, real.runtime.id);
  assert.equal(typeof adapter.runtime.id, 'string');
});

test('methods are bound to their namespace', async () => {
  const calls = [];
  const local = { get(keys) { calls.push([this === local, keys]); return Promise.resolve({}); } };
  const adapter = createChromeAdapter({ storage: { local } });
  const { get } = adapter.storage.local;
  await get('k');
  assert.deepEqual(calls, [[true, 'k']]);
  assert.equal(adapter.runtime, undefined);
});

test('a member absent from a real namespace is skipped and never bound', () => {
  const runtime = { id: 'x', getURL: (path) => path, sendMessage: async () => ({}), onMessage: { addListener() {} } };
  let adapter;
  assert.doesNotThrow(() => { adapter = createChromeAdapter({ runtime }); });
  assert.equal(adapter.runtime.getContexts, undefined);
  assert.equal(adapter.runtime.openOptionsPage, undefined);
  assert.equal(adapter.runtime.onInstalled, undefined);
  assert.equal(adapter.runtime.onStartup, undefined);
  assert.deepEqual(Object.keys(adapter.runtime).sort(), ['getURL', 'id', 'onMessage', 'sendMessage']);
  assert.equal(adapter.storage, undefined);
  assert.equal(adapter.tabs, undefined);
  // storage without a session area (an extension page in a profile that lacks it) keeps `local` only
  const partial = createChromeAdapter({ storage: { local: { get: async () => ({}) } } });
  assert.deepEqual(Object.keys(partial.storage), ['local']);
  assert.deepEqual(Object.keys(partial.storage.local), ['get']);
});

test('namespaces absent from the real object stay undefined; a missing object gives an empty frozen adapter', () => {
  const adapter = createChromeAdapter({ runtime: { id: 'x' } });
  for (const namespace of ['storage', 'tabs', 'windows', 'tabCapture', 'sidePanel', 'action', 'commands', 'contextMenus',
    'offscreen', 'scripting', 'i18n']) assert.equal(adapter[namespace], undefined, namespace);
  for (const missing of [undefined, null, 0, 'text']) {
    const empty = createChromeAdapter(missing);
    assert.deepEqual(Object.keys(empty), []);
    assert.ok(Object.isFrozen(empty));
  }
});

test('the offscreen document yields exactly its six runtime members', () => {
  const browser = createFakeBrowser();
  const host = browser.createContext('offscreen');
  const adapter = createChromeAdapter(host.chrome);
  assert.deepEqual(Object.keys(adapter), ['runtime']);
  assert.deepEqual(Object.keys(adapter.runtime).sort(), ['connect', 'getURL', 'id', 'onConnect', 'onMessage', 'sendMessage']);
  assert.equal(adapter.runtime.getContexts, undefined);
  assert.equal(adapter.runtime.openOptionsPage, undefined);
  assert.equal(adapter.runtime.onInstalled, undefined);
});

test('the side panel context has commands.getAll and runtime.onStartup but none of the worker-only namespaces', async () => {
  const browser = createFakeBrowser({ shortcut: 'Alt+Shift+Y' });
  const panel = browser.createContext('panel');
  const adapter = createChromeAdapter(panel.chrome);
  assert.equal(typeof adapter.runtime.onStartup.addListener, 'function');
  assert.equal(typeof adapter.runtime.getContexts, 'function');
  assert.equal(typeof adapter.windows.getCurrent, 'function');
  for (const namespace of ['tabCapture', 'sidePanel', 'action', 'contextMenus', 'offscreen', 'scripting']) {
    assert.equal(adapter[namespace], undefined, `${namespace} is worker-only`);
  }
  assert.deepEqual(await adapter.commands.getAll(), [{ name: '_execute_action', description: '', shortcut: 'Alt+Shift+Y' }]);
});

// R8 in miniature: the identifier `chrome` appears in the adapter's parameter default only. Comments, string literals and
// template literals are stripped first, so a justification that says "browser" cannot fail the scan.
function stripSource(source) {
  let out = '';
  for (let at = 0; at < source.length;) {
    const c = source[at];
    const n = source[at + 1];
    if (c === '/' && n === '/') { while (at < source.length && source[at] !== '\n') at += 1; } else if (c === '/' && n === '*') {
      at = source.indexOf('*/', at + 2); at = at < 0 ? source.length : at + 2;
    } else if (c === '\'' || c === '"' || c === '`') {
      at += 1;
      while (at < source.length && source[at] !== c) at += source[at] === '\\' ? 2 : 1;
      at += 1; out += '""';
    } else { out += c; at += 1; }
  }
  return out;
}

test('only lib/chrome-adapter.js names the platform global; every other owned source file receives an adapter', async () => {
  const owned = ['extension/lib/chrome-adapter.js', 'extension/lib/i18n.js', 'extension/lib/dom-i18n.js', 'extension/lib/links.js',
    'extension/background/service-worker.js', 'extension/background/sw-core.js', 'extension/background/arming.js',
    'extension/panel/panel.js', 'extension/panel/controller.js', 'extension/panel/view-model.js', 'extension/panel/host-link.js',
    'extension/options/options.js', 'extension/options/controller.js', 'extension/permission/mic-permission.js',
    'extension/permission/controller.js'];
  const counts = {};
  for (const path of owned) {
    const code = stripSource(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
    counts[path] = (code.match(/\b(chrome|browser)\b/g) ?? []).length;
  }
  assert.equal(counts['extension/lib/chrome-adapter.js'], 1, 'one default-parameter use');
  for (const [path, count] of Object.entries(counts)) if (path !== 'extension/lib/chrome-adapter.js') assert.equal(count, 0, path);
});
