// New implementation of docs/extension.md §5.6.2; no legacy code is ported.
// The microphone lane: a permission preflight (an offscreen document cannot show a prompt), then the engine's own
// capture over the shimmed platform. The start/stop state machine is the shared controller of lane-engine.js.
import { createLaneController } from './lane-engine.js';
import { createLanePlatform } from './platform-shim.js';

const codedError = (code) => Object.assign(new Error(code), { code });

export function createMicLane({ env, deps = {}, timers, onChange, onLatest = null, cooldowns = null } = {}) {
  // Steps 2-3 of 5.6.2. Nothing exists yet while the permission query is pending, so a stop needs no cleanup here.
  async function acquire({ run }) {
    const permissions = env.navigator?.permissions;
    if (typeof permissions?.query === 'function') {
      let status;
      try { status = await permissions.query({ name: 'microphone' }); } catch { status = undefined; }   // a throwing query proceeds
      if (run.cancelled) throw codedError('START_CANCELLED');
      // The host cannot show a prompt: 'prompt' is as good as 'denied' here (the user grants it on the permission page).
      if (status?.state === 'denied' || status?.state === 'prompt') throw codedError('MICROPHONE_DENIED');
    }
    return { platform: createLanePlatform({ env, createPlatform: deps.createPlatform }) };
  }

  return createLaneController({ lane: 'mic', env, deps, timers, onChange, onLatest, acquire, cooldowns });
}
