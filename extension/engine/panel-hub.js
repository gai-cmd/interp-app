// New implementation of docs/extension.md §4.4 (port acceptance), §4.5 and §5.8; no legacy code is ported.
// The registry of side-panel ports and the disconnect grace: when the LAST panel port is gone the lanes must not keep a
// Live connection and the tab-capture indicator alive, so a timer starts and, on expiry, the host stops everything and
// reports idle. Only a real port disconnect counts (never sidePanel.onClosed). Timers are the injected REALM clock.
import { LIMITS, PORT_NAMES, senderRole, validateFrame } from '../lib/protocol.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };
// Frames of one kind on one port are deduped against each other, so a port never gets the same state twice in a row.
const kindOf = (frame) => `${frame.type}:${frame.lane ?? ''}`;
const print = (frame) => {
  const rest = { ...frame };
  delete rest.seq;
  if (rest.state && typeof rest.state === 'object') rest.state = { ...rest.state, seq: 0 };   // the UiState's own counter
  return JSON.stringify(rest);
};

// The report can be answered "not closed" (the SW still has a start in flight, 6.9): the host then asks for it again.
// The delay doubles per repeat (3 s, 6 s, 12 s) and the number of repeats is capped, so an absent SW can never keep
// a timer chain alive: the cap ends it and any panel port resets it.
const REARM_BASE_MS = 3000;
const MAX_REARMS = 3;

/**
 * `runtime` gives senderRole its id and origin. `onHello(port)` answers a panel's first frame (the host sends the full
 * state and the latest captions with sendTo); `onAllGone(reason)` runs when the grace expires ('panel-gone' after the
 * last port left, 'initial-grace' when none ever connected).
 */
export function createPanelHub({ runtime, timers, graceMs = LIMITS.panelGraceMs, initialGraceMs = LIMITS.panelInitialGraceMs,
  maxPorts = LIMITS.maxPanelPorts, rearmBaseMs = REARM_BASE_MS, maxRearms = MAX_REARMS,
  onHello, onAllGone, roleOf = (sender) => senderRole(sender, runtime) } = {}) {
  const entries = new Set();     // { port, last: Map<kind, print> }
  let timer = null, timerReason = null, fired = false, disposed = false, rearms = 0;

  const cancelTimer = () => {
    if (timer !== null) attempt(() => timers.clearTimeout(timer));
    timer = null; timerReason = null;
  };
  function arm(ms, reason) {
    if (disposed || timer !== null || fired) return;
    timerReason = reason;
    timer = timers.setTimeout(() => {
      timer = null; timerReason = null;
      if (disposed || entries.size > 0) return;
      fired = true;                                   // one report per absence: a new port re-enables it
      attempt(() => onAllGone?.(reason));
    }, ms);
  }
  function forget(entry) {
    if (!entries.delete(entry)) return;
    if (entries.size === 0) arm(graceMs, 'panel-gone');
  }
  function post(entry, frame) {
    try { entry.port.postMessage(frame); return true; } catch { forget(entry); return false; }
  }

  return Object.freeze({
    /** false for a port that is not ours (left alone: another page may own it) or was refused (disconnected). */
    accept(port) {
      if (disposed || port?.name !== PORT_NAMES.panel) return false;
      if (roleOf(port.sender) !== 'panel' || entries.size >= maxPorts) { attempt(() => port.disconnect()); return false; }
      cancelTimer();
      fired = false;
      rearms = 0;                                     // a panel is a fresh start for the whole report cycle
      const entry = { port, last: new Map() };
      entries.add(entry);
      port.onMessage.addListener((frame) => {
        if (!entries.has(entry)) return;
        const checked = validateFrame('panel->host', frame);
        if (checked.ok && checked.frame.type === 'hello') attempt(() => onHello?.(port));
      });
      port.onDisconnect.addListener(() => forget(entry));
      return true;
    },

    /** Every port, deduped per port and kind; a postMessage that throws removes the port. */
    broadcast(frame) {
      const key = kindOf(frame), fingerprint = print(frame);
      for (const entry of [...entries]) {
        if (entry.last.get(key) === fingerprint) continue;
        if (post(entry, frame)) entry.last.set(key, fingerprint);
      }
    },

    /** Direct answer to one port (the hello reply); it also becomes that port's dedupe baseline. */
    sendTo(port, frame) {
      const entry = [...entries].find((item) => item.port === port);
      if (!entry) return false;
      if (!post(entry, frame)) return false;
      entry.last.set(kindOf(frame), print(frame));
      return true;
    },

    count: () => entries.size,

    /** The host was created but no panel has connected yet (F10). */
    armInitialGrace() { arm(initialGraceMs, 'initial-grace'); },

    /** 5.7 step 6: no lane is active and no panel exists. A no-op while a panel is connected or after a report. */
    armGrace() { if (entries.size === 0) arm(graceMs, 'panel-gone'); },

    /**
     * The last report got no usable answer (the SW said `closed:false`, or the send failed twice): allow ONE more report of
     * the same `reason` after a growing delay. Only valid while the report that fired is still the current one (a panel
     * that connected meanwhile reset it, and its own disconnect arms its own grace) and only up to `maxRearms` times.
     * Returns whether a repeat is now pending.
     */
    rearm(reason = 'panel-gone') {
      if (disposed || !fired || entries.size > 0 || rearms >= maxRearms) return false;
      const delay = rearmBaseMs * 2 ** rearms;
      rearms += 1;
      fired = false;
      arm(delay, reason);
      return true;
    },

    /** Disconnects right AFTER the frames already posted (the `bye` of the host's dispose), never before them. */
    dispose() {
      disposed = true;
      cancelTimer();
      const closing = [...entries];
      entries.clear();
      Promise.resolve().then(() => { for (const entry of closing) attempt(() => entry.port.disconnect()); });
    },
  });
}
