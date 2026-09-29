// New implementation of docs/extension.md §5.13; no legacy code is ported.
// The engine clock and the worker-timer seam (K5). An offscreen document is never composited, so Chrome may
// throttle its main-thread timers; the uplink pump, the player monitor and the capture watchdog all run on the
// ENGINE clock. This module BUILDS the remedy (timers driven by a dedicated worker, whose expiry arrives as a
// message task) but ships it OFF: "a worker's timers are not throttled like page timers" is itself unmeasured
// (assumption A27). Switching it on is TIMER_MODE plus checklist 13.22.

/** 'realm' (v1) = the realm's own setTimeout/clearTimeout/now; 'worker' = createWorkerTimers. */
export const TIMER_MODE = 'realm';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
const delayOf = (ms) => Math.max(0, Number(ms) || 0);

/**
 * `realm` = { setTimeout, clearTimeout, now } of the page (the fallback and the clock of `now`). `Worker` is the
 * constructor and `url` the script; both injectable so tests never spawn a worker. Timer ids are this module's
 * own counter in every mode, so an id handed out before a fallback still cancels afterwards. If the worker cannot
 * be created, raises `error`, or a post throws, every pending timer is re-armed on the realm (never a silent hang).
 */
export function createWorkerTimers({ Worker = globalThis.Worker, url = new URL('./timer-worker.js', import.meta.url),
  realm } = {}) {
  const pending = new Map();   // id -> { fn, dueAt, realmId }
  let serial = 0, worker = null, fallback = false, disposed = false;

  const armOnRealm = (id, entry) => {
    entry.realmId = realm.setTimeout(() => fire(id), Math.max(0, entry.dueAt - realm.now()));
  };
  function fire(id) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.fn();
  }
  function useRealm() {
    if (fallback) return;
    fallback = true;
    const dead = worker;
    worker = null;
    if (dead) attempt(() => dead.terminate());
    for (const [id, entry] of pending) if (entry.realmId === undefined) armOnRealm(id, entry);
  }
  function post(message) {
    if (!worker) return false;
    try { worker.postMessage(message); return true; } catch { return false; }
  }

  try {
    worker = new Worker(url, { type: 'module' });
    worker.addEventListener('message', ({ data }) => {
      if (data !== null && typeof data === 'object' && data.t === 'fire' && Number.isSafeInteger(data.id)) fire(data.id);
    });
    worker.addEventListener('error', useRealm);
  } catch {
    worker = null;
    fallback = true;
  }

  return Object.freeze({
    setTimeout(fn, ms) {
      const id = ++serial;
      if (disposed) return id;
      const delay = delayOf(ms);
      const entry = { fn, dueAt: realm.now() + delay, realmId: undefined };
      pending.set(id, entry);
      if (fallback || !post({ t: 'set', id, ms: delay })) {
        useRealm();
        if (entry.realmId === undefined) armOnRealm(id, entry);
      }
      return id;
    },
    clearTimeout(id) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (entry.realmId !== undefined) realm.clearTimeout(entry.realmId);
      else post({ t: 'clear', id });
    },
    now: () => realm.now(),
    dispose() {
      disposed = true;
      for (const entry of pending.values()) if (entry.realmId !== undefined) attempt(() => realm.clearTimeout(entry.realmId));
      pending.clear();
      const dead = worker;
      worker = null;
      if (dead) attempt(() => dead.terminate());
    },
  });
}

/**
 * The clock the engine runs on. `realm` mode returns the realm's own clock object unchanged (D4: "real timers"),
 * `worker` mode returns worker-driven timers whose `now` is still the realm's.
 */
export function createEngineClock({ mode = TIMER_MODE, realm, Worker } = {}) {
  return mode === 'worker' ? createWorkerTimers({ Worker, realm }) : realm;
}
