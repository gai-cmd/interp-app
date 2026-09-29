// New implementation of docs/extension.md §4.4 (port acceptance), §4.5 and §5.6.3; no legacy code is ported.
// The registry of caption-overlay ports, one per tab. It decides nothing about WHICH lane feeds which tab (the host
// routes) and knows no lane: it accepts a port under the rules of 4.4, keeps the newest port of a tab, evicts the
// least recently used tab beyond the cap, and delivers frames to a tab's port.
import { LIMITS, PORT_NAMES, makeFrame, senderRole, validateFrame } from '../lib/protocol.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// A port closed straight after a postMessage may lose that message (unverified in Chrome, A28), so the host closes
// a port a little AFTER its `bye`; the overlay closes the port itself on `bye`, this is only the cleanup.
const CLOSE_DELAY_MS = 250;
const print = (frame) => {
  const rest = { ...frame };
  delete rest.seq;
  return JSON.stringify(rest);
};
const kindOf = (frame) => `${frame.type}:${frame.lane ?? ''}`;
// Only these repeat harmlessly. `clear`, `status` and `bye` are events: a second `clear` after new captions is real.
const DEDUPED = new Set(['captions', 'style']);

/**
 * `canAccept(tabId)` is the host's routing policy (a tab is acceptable only while some lane feeds it).
 * `onHello(tabId)` answers the overlay's first frame; `onClose(tabId)` reports a port that went away on its own (the
 * page navigated, the tab closed, a send failed) — never one the host closed itself. `timers` is the realm clock.
 */
export function createOverlayHub({ runtime, timers, maxPorts = LIMITS.maxOverlayPorts, canAccept = () => true, onHello,
  onClose, closeDelayMs = CLOSE_DELAY_MS, roleOf = (sender) => senderRole(sender, runtime) } = {}) {
  const ports = new Map();   // tabId -> { port, last: Map<kind, print> }; insertion order = least recently used first
  const closing = new Set(); // { timer, entry }: ports told `bye` that are not disconnected yet
  let disposed = false;

  // Disconnect after a delay on the injected clock, or right after the posted frames when there is no delay.
  function disconnectLater(entry, delayMs) {
    const job = { timer: null, run: null, done: false };
    job.run = () => {
      if (job.done) return;   // a dispose may run it early; the scheduled call must then do nothing
      job.done = true;
      closing.delete(job);
      attempt(() => entry.port.disconnect());
    };
    closing.add(job);
    if (delayMs > 0 && timers) job.timer = timers.setTimeout(job.run, delayMs);
    else Promise.resolve().then(job.run);
  }

  const touch = (tabId, entry) => { ports.delete(tabId); ports.set(tabId, entry); };
  function drop(tabId, entry, { disconnect = false } = {}) {
    if (ports.get(tabId) !== entry) return false;   // a replaced port's late event must not touch the new one
    ports.delete(tabId);
    if (disconnect) attempt(() => entry.port.disconnect());
    return true;
  }

  function close(tabId, { bye = true, delayMs = closeDelayMs } = {}) {
    const entry = ports.get(tabId);
    if (!entry) return false;
    ports.delete(tabId);   // forgotten at once: no more routing, and its late events are ignored
    if (bye) {
      attempt(() => entry.port.postMessage(makeFrame('bye')));
      disconnectLater(entry, delayMs);
    } else attempt(() => entry.port.disconnect());
    return true;
  }

  return Object.freeze({
    /**
     * Rules of 4.4: right name, sender role `content`, top frame, an integer tab id, and the host's policy. A port with
     * another name is ignored (returns false, NOT disconnected: another extension page may own it); a port that breaks
     * a rule is disconnected. A second port for a tab REPLACES the first: the old one is disconnected and forgotten
     * BEFORE the new one is registered.
     */
    accept(port) {
      if (disposed || port?.name !== PORT_NAMES.overlay) return false;
      const sender = port.sender;
      const tabId = sender?.tab?.id;
      if (roleOf(sender) !== 'content' || sender.frameId !== 0 || !Number.isInteger(tabId) || tabId < 0
        || !attempt(() => canAccept(tabId))) {
        attempt(() => port.disconnect());
        return false;
      }
      const previous = ports.get(tabId);
      if (previous) drop(tabId, previous, { disconnect: true });
      else if (ports.size >= maxPorts) {
        const [oldestId] = ports.entries().next().value;
        close(oldestId);
        attempt(() => onClose?.(oldestId));
      }
      const entry = { port, last: new Map() };
      ports.set(tabId, entry);
      port.onMessage.addListener((frame) => {
        if (ports.get(tabId) !== entry) return;
        const checked = validateFrame('overlay->host', frame);
        if (checked.ok && checked.frame.type === 'hello') { touch(tabId, entry); attempt(() => onHello?.(tabId)); }
      });
      port.onDisconnect.addListener(() => { if (drop(tabId, entry)) attempt(() => onClose?.(tabId)); });
      return true;
    },

    has: (tabId) => ports.has(tabId),
    count: () => ports.size,
    tabIds: () => [...ports.keys()],

    /**
     * To one tab's port, deduped per kind. `force` skips the dedupe (a reply to hello, a frame re-sent after a route
     * change: the port has never seen it). A postMessage that throws removes the port.
     */
    send(tabId, frame, { force = false } = {}) {
      const entry = ports.get(tabId);
      if (!entry) return false;
      const key = kindOf(frame), fingerprint = print(frame), deduped = DEDUPED.has(frame.type);
      if (!force && deduped && entry.last.get(key) === fingerprint) return true;
      try { entry.port.postMessage(frame); } catch {
        if (drop(tabId, entry)) attempt(() => onClose?.(tabId));
        return false;
      }
      if (deduped) entry.last.set(key, fingerprint);
      touch(tabId, entry);
      return true;
    },

    /** Forget what a tab's port has seen of one lane's captions (after a clear: the next frame must be sent). */
    forget(tabId, lane) {
      const entry = ports.get(tabId);
      if (entry) entry.last.delete(`captions:${lane}`);
    },

    /** Tells the overlay to remove its UI (`bye`), forgets the port now and closes it from this side shortly after. */
    close,

    dispose() {
      disposed = true;
      for (const [tabId] of [...ports]) close(tabId, { delayMs: 0 });
      // Whatever was already told `bye` is disconnected now instead of after its delay.
      for (const job of [...closing]) {
        if (job.timer !== null) attempt(() => timers.clearTimeout(job.timer));
        job.run();
      }
    },
  });
}
