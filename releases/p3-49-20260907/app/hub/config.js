// New implementation of design-p2 §10 and P2-20; no legacy code ported.
// P2-10 owns the code registry already consumed by main.js and the client.
// Reuse it until that dependency can move its declaration here atomically.
import { REGISTERED_HUBS, createHubProtocol } from './protocol.js';
import { ProviderError } from '../providers/contract.js';

export { REGISTERED_HUBS };

/** Validate reviewed code entries, never settings, QR data or room codes. */
export function hubEndpoints(hubs = REGISTERED_HUBS) {
  createHubProtocol({ hubs });
  try {
    for (const hub of hubs) {
      if (typeof hub.labelKey !== 'string' || !/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(hub.labelKey)) throw 0;
    }
    return Object.freeze([...new Set(hubs.map((hub) => hub.url))]);
  } catch { throw new ProviderError('INVALID_REQUEST'); }
}

export const HUB_ENDPOINTS = hubEndpoints();
/** CSP sources never include the WebSocket path or a room code. */
export function hubOrigins(hubs = REGISTERED_HUBS) {
  return Object.freeze([...new Set(hubEndpoints(hubs).map((endpoint) => new URL(endpoint).origin))]);
}

export const HUB_ORIGINS = hubOrigins();
