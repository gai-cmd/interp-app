// New implementation of docs/extension.md §8.2.7; no legacy code is ported.
// The panel's data-plane connection to the offscreen host: it opens the `interp-panel/1` port, says hello, routes the
// three host -> panel frames to callbacks and reports the end of the connection. It never reconnects by itself: the
// controller reconnects when the host flag turns up, at start and after a successful sw/lane-start. Frames are
// validated with the protocol's own validator, so an invalid or oversize frame is dropped silently (4.4).
import { PORT_NAMES, makeFrame, validateFrame } from '../lib/protocol.js';

const attempt = (fn) => { try { return fn(); } catch { return undefined; } };

/**
 * createHostLink({ adapter, onState, onCaptions, onConnection }) -> Readonly<{ connect, disconnect, connected }>
 * onState(uiState), onCaptions(captionFrame), onConnection(connected, { bye }): `bye` tells the controller whether
 * the host announced its own end before the port closed (an expected loss).
 */
export function createHostLink({ adapter, onState = () => {}, onCaptions = () => {}, onConnection = () => {} } = {}) {
  let current = null;
  let sawBye = false;

  function connect() {
    if (current !== null) return;   // idempotent while a port is open
    const port = attempt(() => adapter.runtime.connect({ name: PORT_NAMES.panel }));
    if (!port) { onConnection(false, { bye: false }); return; }
    current = port;
    sawBye = false;
    // Every handler first checks `port === current`, so a late event of a port we already dropped changes nothing.
    port.onMessage.addListener((raw) => {
      if (port !== current) return;
      const checked = validateFrame('host->panel', raw);
      if (!checked.ok) return;
      const { frame } = checked;
      if (frame.type === 'state') onState(frame.state);
      else if (frame.type === 'captions') onCaptions(frame);
      else if (frame.type === 'bye') sawBye = true;
    });
    port.onDisconnect.addListener(() => {
      if (port !== current) return;
      current = null;
      const bye = sawBye;
      sawBye = false;
      onConnection(false, { bye });
    });
    attempt(() => port.postMessage(makeFrame('hello')));
  }

  // The panel's own disconnect (dispose, host flag down) is not a "loss": no callback.
  function disconnect() {
    const port = current;
    current = null;
    sawBye = false;
    if (port) attempt(() => port.disconnect());
  }

  return Object.freeze({ connect, disconnect, connected: () => current !== null });
}
