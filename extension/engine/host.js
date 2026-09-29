// New implementation of docs/extension.md §5.1 and §5.13; no legacy code is ported.
// ENTRY (R10): the only side-effect module of the offscreen host besides timer-worker.js. It composes the real
// environment and starts the host; everything testable lives in lane-host.js.
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createHostEnv, createLaneHost, createRealmClock } from './lane-host.js';
import { createEngineClock } from './worker-timers.js';

const realm = createRealmClock(globalThis);
// TIMER_MODE decides whether the engine runs on the realm's timers (v1) or on worker-driven ones (5.13).
const engine = createEngineClock({ realm, Worker: globalThis.Worker });
createLaneHost({ adapter: createChromeAdapter(), env: createHostEnv(globalThis, engine), timers: realm }).start();
