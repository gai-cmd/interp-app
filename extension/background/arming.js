// New implementation of docs/extension.md §6.2; no legacy code is ported.
// Armed-tab bookkeeping over storage.session. Chromium is the real authority for the per-tab tabCapture grant
// (it is given by a toolbar click, the _execute_action shortcut or a context-menu click and dropped on a
// cross-origin navigation or when the tab goes away); this record only feeds the panel ("this tab is ready") and
// the NEEDS_ARM decision, so a stale entry is harmless: the mint fails and the entry is cleared (6.4). Nothing here
// ever rejects: a storage failure reads as "not armed" and a failed write is dropped.
import { LIMITS, STORAGE_KEYS } from '../lib/protocol.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const KEY = STORAGE_KEYS.armed;

/** `origin` of an http(s) URL, else null (opaque, file:, unparsable or missing). */
export function originOf(url) {
  const parsed = typeof url === 'string' ? attempt(() => new URL(url)) : undefined;
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.origin : null;
}

const entryOf = (value) => (isObject(value) && Number.isFinite(value.at)
  ? { windowId: Number.isInteger(value.windowId) ? value.windowId : null,
    origin: typeof value.origin === 'string' ? value.origin : null, at: value.at }
  : null);

export function createArming({ storageSession, now = () => Date.now(), maxTabs = LIMITS.maxArmedTabs } = {}) {
  // One promise chain serializes every read-modify-write, so two events in the same tick cannot lose an update.
  let chain = Promise.resolve();
  const serialized = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  async function read() {
    const stored = await storageSession.get(KEY);
    const record = isObject(stored) ? stored[KEY] : undefined;
    const tabs = {};
    if (isObject(record) && record.v === 1 && isObject(record.tabs)) {
      for (const [id, value] of Object.entries(record.tabs)) {
        const entry = entryOf(value);
        if (entry && /^\d+$/.test(id)) tabs[id] = entry;
      }
    }
    return tabs;
  }
  const write = (tabs) => storageSession.set({ [KEY]: { v: 1, tabs } });
  const safely = (task) => serialized(async () => {
    try { return await task(); } catch { return undefined; }
  });

  const arm = (tab) => safely(async () => {
    if (!Number.isInteger(tab?.id)) return;
    const tabs = await read();
    delete tabs[String(tab.id)];
    // Oldest first, and the tab being armed is never the one evicted.
    const others = Object.entries(tabs).sort((a, b) => a[1].at - b[1].at);
    while (others.length > maxTabs - 1) delete tabs[others.shift()[0]];
    tabs[String(tab.id)] = { windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
      origin: originOf(tab.url), at: now() };
    await write(tabs);
  });

  const get = async (tabId) => {
    const tabs = await safely(read);
    return tabs?.[String(tabId)] ?? null;
  };

  const clear = (tabId) => safely(async () => {
    const tabs = await read();
    if (!Object.hasOwn(tabs, String(tabId))) return;
    delete tabs[String(tabId)];
    await write(tabs);
  });

  // Same-origin navigation (also SPA pushState) keeps the grant, like Chromium; anything else drops the record.
  const onTabUpdated = (tabId, changeInfo) => safely(async () => {
    if (typeof changeInfo?.url !== 'string') return;
    const tabs = await read();
    const entry = tabs[String(tabId)];
    if (!entry) return;
    const origin = originOf(changeInfo.url);
    if (origin !== null && origin === entry.origin) return;
    delete tabs[String(tabId)];
    await write(tabs);
  });

  return Object.freeze({
    arm,
    isArmed: async (tabId) => (await get(tabId)) !== null,
    get,
    clear,
    clearAll: () => safely(() => storageSession.remove(KEY)),
    onTabUpdated,
  });
}
