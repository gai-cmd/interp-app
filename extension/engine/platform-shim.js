// New implementation of docs/extension.md §5.4; no legacy code is ported.
// The platform the capture chain (app/audio/stream-capture.js) receives inside the offscreen document. That chain
// refuses to run without a secure context and user activation, aborts while `document.hidden` and on `pagehide`;
// an offscreen document has no user input and may report itself hidden. The shim answers those questions the way a
// visible page would, and leaves everything that does real work (audio classes, the clock) real.
import { createPlatform as realCreatePlatform } from '../../app/platform.js';

const noop = () => {};
// Frozen and empty on purpose: the capture chain only asks `hidden` and registers/removes listeners.
const shimDocument = Object.freeze({ hidden: false, addEventListener: noop, removeEventListener: noop });

/**
 * `getUserMedia` is overridden ONLY for the tab lane: the tab lane must never fall through to a real microphone
 * request. `env.setTimeout/clearTimeout` are the ENGINE clock (5.13): the capture watchdog (2 s) and the setup
 * timeout (30 s) run on it. `createPlatform` is injectable for tests.
 */
export function createLanePlatform({ env, getUserMedia, createPlatform = realCreatePlatform } = {}) {
  const shimEnv = {
    isSecureContext: true,
    navigator: { userActivation: { isActive: true }, mediaDevices: env.navigator?.mediaDevices },
    document: shimDocument,
    AudioContext: env.AudioContext,
    AudioWorkletNode: env.AudioWorkletNode,
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    clearTimeout: (id) => env.clearTimeout(id),
    // `platform.page`: a 'pagehide' of the offscreen document must not interrupt a lane.
    addEventListener: noop,
    removeEventListener: noop,
  };
  const platform = createPlatform(shimEnv);
  return Object.freeze({ ...platform, ...(getUserMedia ? { getUserMedia } : {}) });
}
