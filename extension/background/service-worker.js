// New implementation of docs/extension.md §6; no legacy code is ported.
// ENTRY (R10): the only module of the worker with an import-time effect. It builds the adapter over the real global
// and registers every listener synchronously, in the first turn of the worker, as an MV3 worker must.
import { createChromeAdapter } from '../lib/chrome-adapter.js';
import { createServiceWorker } from './sw-core.js';

createServiceWorker({ adapter: createChromeAdapter() }).register();
