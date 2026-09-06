// P3-10 fixtures: the live-control state under test consumes *parsed* events
// (P3-09 `protocol.js` output), never wire text. Envelope shapes come from
// ./hub.mjs so both tasks read the same §1.8 examples; here they are turned into
// the parser's output shape and paired with a deterministic clock.
// No hub address, room code, key or QR payload appears here.
import { createHubControl } from '../../app/hub/control.js';
import { createClock } from './hub-socket.mjs';
import { EPOCH, EVENT_ID, control as helloControl, notice, noticeText,
  releaseSnapshot, snapshot } from './hub.mjs';

export { EPOCH, EVENT_ID, createClock, helloControl, notice, noticeText };

/** The state a freshly created control reports, and what reset() returns to. */
export const initialState = Object.freeze({ supported: null, eventId: null, epoch: null,
  revision: null, stopped: false, disabledFeatures: [], notice: null,
  heartbeatLost: false, expiresAt: null });

/** A `policy.control` envelope as P3-09's parser hands it over: `type: 'control'`
 * and an own copy of disabledFeatures. Overrides are applied to the envelope. */
export const parsed = (overrides = {}) => {
  const message = snapshot(overrides);
  return { ...message, type: 'control', disabledFeatures: [...message.disabledFeatures] };
};
/** Parsed release snapshot: nothing stopped or disabled, no notice. */
export const parsedRelease = (overrides = {}) => {
  const message = releaseSnapshot(overrides);
  return { ...message, type: 'control', disabledFeatures: [...message.disabledFeatures] };
};
/** hello.control as an extended hub answers it (the negotiate() argument). */
export const negotiation = (overrides = {}) => helloControl(overrides);

/** A control state on a fake clock, recording every subscriber notification. */
export function controlFixture() {
  const clock = createClock(), changes = [];
  const control = createHubControl(clock);
  const unsubscribe = control.subscribe((value) => changes.push(value));
  return { clock, changes, control, unsubscribe };
}
