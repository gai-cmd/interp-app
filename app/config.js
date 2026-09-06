// New implementation of design-v0.6 §§8.1, 11.2, 15 and 20: the composition
// root that wires reviewed providers, the key store and the router. Importing
// this module touches no browser globals; environment objects are injected.
import { REGISTERED_HUBS, HUB_ENDPOINTS } from './hub/config.js';
import { ProviderError } from './providers/contract.js';
import { createRegistry } from './providers/registry.js';
import { createRouter } from './providers/router.js';
import { createKeyStore } from './security/key-store.js';
import { createSessionManager } from './engine/session-manager.js';
import { VOICE_POLICY } from './engine/voice.js';
import { GEMINI_ENDPOINTS, GEMINI_PROVIDER_ID, registerGemini, resolveGeminiFallback, resolveGeminiLiveFallback } from './providers/gemini/index.js';

// Fixed at review time. P2-20 builds CSP connect-src from this list; the QR
// payload, settings UI and runtime options cannot add or replace entries.
// Audience hubs add network destinations, not provider transports or keys.
export const ENDPOINT_ALLOWLIST = Object.freeze([...new Set([...GEMINI_ENDPOINTS, ...HUB_ENDPOINTS])]);
export const ENDPOINT_ORIGINS = Object.freeze([...new Set(ENDPOINT_ALLOWLIST.map((endpoint) => new URL(endpoint).origin))]);

// P3-21: documents the UI links the reader OUT to (design-p3 §1.12 fixes these
// three). They are navigation targets opened in a new tab, never fetched, so
// they are a separate registry: adding one here does NOT widen the CSP
// connect-src that ENDPOINT_ALLOWLIST builds. Every outbound link in the app
// comes from this table, so a new destination is a reviewed change here.
export const DOCUMENTATION_LINKS = Object.freeze({
  apiKeyCreate: 'https://aistudio.google.com/apikey',
  apiKeyUsage: 'https://ai.google.dev/gemini-api/docs/api-key',
  billing: 'https://ai.google.dev/gemini-api/docs/billing?hl=en',
});
export const DOCUMENTATION_ORIGINS = Object.freeze([...new Set(Object.values(DOCUMENTATION_LINKS).map((url) => new URL(url).origin))]);

// P1 ships one real provider; test-only providers are never registered here.
export const PRODUCT_PROVIDER_IDS = Object.freeze([GEMINI_PROVIDER_ID]);

// Owner design values for P1-14 state; the UI language is chosen separately.
export const APP_DEFAULTS = Object.freeze({
  providerId: GEMINI_PROVIDER_ID,
  transport: 'direct',
  interpretation: Object.freeze({ sourceLanguage: 'ko', targetLanguage: 'ja' }),
  voice: Object.freeze({ output: 'provider', allowDeviceFallback: true }),
  records: Object.freeze({ persist: false }),
  capture: Object.freeze({ maxDurationMs: 30000 }),
});

function assertAllowed(descriptors) {
  for (const descriptor of descriptors) {
    if (!PRODUCT_PROVIDER_IDS.includes(descriptor.id)
      || !descriptor.endpoints.every((endpoint) => ENDPOINT_ALLOWLIST.includes(endpoint))) {
      throw new ProviderError('INVALID_PROVIDER');
    }
  }
}

/**
 * createAppConfig({ fetch?, WebSocket?, Blob?, storage?, setTimeout?, clearTimeout?, now?, policy? })
 * returns { registry, keyStore, router, sessionManager, providers, endpoints,
 * endpointOrigins, defaults, policy, resolveFallback, dispose }. Create it once per app
 * (P1-19) after bootstrapSharedKey has removed any URL fragment; pass
 * localStorage only when personal-key persistence is offered. Keys flow
 * keyStore -> router reference -> adapter authentication boundary; nothing
 * here or in callers receives a raw key. sessionManager is the single Live
 * slot shared by voice, diagnostics and later simultaneous interpretation.
 * resolveFallback(providerId, capability = 'translate') returns the registered model-fallback resolver
 * for createRetryExecutor, or null when the provider declares none.
 * policy (P3-07) is an optional { assertRoute(route) } guard handed to the
 * router so the site policy is checked at the provider boundary as well as
 * before each start; the composition root passes the policy runtime's guard.
 * Without it the P1/P2 router contract is unchanged (module tests, fixtures).
 */
export function createAppConfig({ fetch, WebSocket, Blob, storage, setTimeout, clearTimeout, now, policy = null } = {}) {
  if (policy !== null && typeof policy?.assertRoute !== 'function') throw new ProviderError('INVALID_REQUEST');
  const registry = createRegistry();
  const keyStore = createKeyStore({ registry, storage, now, setTimeout, clearTimeout });
  const resolveCredential = (reference, address, options) => keyStore.resolveCredential(reference, address, options);
  registerGemini(registry, { resolveCredential, fetch, WebSocket, Blob, setTimeout, clearTimeout });
  const providers = registry.list();
  assertAllowed(providers);
  const router = createRouter({ registry, getCredentialRef: (address, options) => keyStore.getCredentialRef(address, options),
    ...(policy ? { policy } : {}) });
  const sessionManager = createSessionManager({ timeoutMs: VOICE_POLICY.turnTimeoutMs, setTimeout, clearTimeout });
  const fallbacks = Object.freeze({ [GEMINI_PROVIDER_ID]: resolveGeminiFallback });
  return Object.freeze({
    registry, keyStore, router, sessionManager, providers, hubs: REGISTERED_HUBS, policy,
    endpoints: ENDPOINT_ALLOWLIST, endpointOrigins: ENDPOINT_ORIGINS, defaults: APP_DEFAULTS,
    resolveFallback(providerId, capability = 'translate') {
      if (providerId === GEMINI_PROVIDER_ID && capability === 'live') return resolveGeminiLiveFallback;
      return ['translate', 'stt'].includes(capability) ? fallbacks[providerId] ?? null : null;
    },
    // Ends every session and credential; callers stop engines first (P1-14).
    async dispose() {
      keyStore.dispose();
      await sessionManager.close().catch(() => {});
    },
  });
}
