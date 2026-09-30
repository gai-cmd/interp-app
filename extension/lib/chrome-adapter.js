// New implementation of docs/extension.md §3.4; no legacy code is ported.
// The ONLY module (besides the caption overlay) that names the platform global. Everything else receives the
// adapter it returns by injection, which is what lets the service worker, the panel and the options page run in
// Node against tests/fixtures/fake-chrome.mjs and keeps the import-graph rule R8 checkable.
//
// ADAPTER_SURFACE has exactly the shape of the adapter, so a test can walk both in parallel: an array lists the
// member names copied from that namespace, `true` is an event or property copied by name, and an object nests.

export const ADAPTER_SURFACE = Object.freeze({
  runtime: Object.freeze(['id', 'getURL', 'getManifest', 'reload', 'sendMessage', 'connect', 'openOptionsPage', 'getContexts',
    'onMessage', 'onConnect', 'onInstalled', 'onStartup']),
  storage: Object.freeze({
    local: Object.freeze(['get', 'set', 'remove', 'setAccessLevel']),
    session: Object.freeze(['get', 'set', 'remove']),
    onChanged: true,
  }),
  tabs: Object.freeze(['get', 'query', 'create', 'update', 'sendMessage', 'onRemoved', 'onUpdated', 'onActivated']),
  windows: Object.freeze(['getCurrent']),
  tabCapture: Object.freeze(['getMediaStreamId', 'getCapturedTabs']),
  sidePanel: Object.freeze(['open', 'setPanelBehavior']),
  action: Object.freeze(['onClicked']),
  commands: Object.freeze(['getAll']),
  contextMenus: Object.freeze(['create', 'removeAll', 'onClicked']),
  offscreen: Object.freeze(['createDocument', 'closeDocument']),
  scripting: Object.freeze(['executeScript']),
  i18n: Object.freeze(['getMessage', 'getUILanguage']),
});

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');

// A member that the real namespace does not have is SKIPPED, never bound: `undefined.bind` would throw while the
// host is still starting, before any listener exists, and every later start would fail with HOST_UNAVAILABLE.
function copyLevel(source, spec) {
  if (!isObject(source)) return undefined;
  const out = {};
  if (Array.isArray(spec)) {
    for (const name of spec) {
      const value = attempt(() => source[name]);
      if (value === undefined) continue;
      out[name] = typeof value === 'function' ? value.bind(source) : value;
    }
    return Object.freeze(out);
  }
  for (const [name, inner] of Object.entries(spec)) {
    const value = attempt(() => source[name]);
    if (value === undefined) continue;
    if (inner === true) { out[name] = value; continue; }
    const child = copyLevel(value, inner);
    if (child !== undefined) out[name] = child;
  }
  return Object.freeze(out);
}

/**
 * A frozen adapter over `chromeApi`. Namespaces and members that the given object lacks are absent from the result
 * (an offscreen document only has `runtime`), methods are bound to their namespace, events and plain properties are
 * passed through unchanged, and anything not listed in ADAPTER_SURFACE is not copied.
 */
export function createChromeAdapter(chromeApi = globalThis.chrome) {
  return copyLevel(chromeApi, ADAPTER_SURFACE) ?? Object.freeze({});
}
