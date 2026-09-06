// Synthetic site policies for tests only; never imported by product modules.
// EXAMPLE mirrors design-p3 §1.4 verbatim; tests/policy-schema.test.mjs asserts
// that the deployed root policy.json is byte-for-byte the same document.
// No key, QR payload, room code or hub address appears here (§1.4).

const EXAMPLE = Object.freeze({
  schemaVersion: 1,
  revision: 1,
  publishedAt: '2026-09-06T00:00:00Z',
  validUntil: null,
  minAppVersion: '0.7.0',
  emergency: { stopped: false, reason: null },
  features: {
    sequential: true, simultaneousDirect: true, hubListen: true,
    diagnostics: true, sharedKeys: false, rememberPersonalKey: true,
  },
  settings: {
    'ui.mode': { default: 'system', allowed: ['system', 'light', 'dark'], locked: false },
    'ui.tone': { default: 'navy', allowed: ['navy', 'warm', 'forest', 'mono'], locked: false },
    'ui.text': { default: 'm', allowed: ['s', 'm', 'l', 'xl'], locked: false },
    'captions.size': { default: 1.5, min: 1, max: 2, step: 0.125, locked: false },
    'interpretation.sourceLanguage': { default: 'ko', allowed: ['auto', 'ko', 'en', 'ja'], locked: false },
    'interpretation.targetLanguage': { default: 'ja', allowed: ['ko', 'en', 'ja'], locked: false },
    'voice.output': { default: 'provider', allowed: ['provider', 'device', 'off'], locked: false },
    'billing.plan': { default: 'free', allowed: ['free', 'paid'], locked: false },
  },
  notices: [],
  sharedEvents: [],
  hubControl: { enabled: false, allowedHubIds: [], allowDirectSubscription: false },
  pricing: { revision: 1, updatedAt: '2026-09-06T00:00:00Z', currency: 'USD', allowLocalOverride: true, rates: [] },
});

// Hub IDs a test may hand to validatePolicy as the reviewed code registry.
export const REGISTERED_HUB_IDS = Object.freeze(['venue-main', 'venue-hall']);

/** Three-language text with a recognisable prefix per language. */
export function trilingual(base = 'text') {
  return { ko: `${base} 한국어`, en: `${base} English`, ja: `${base} 日本語` };
}

/** Fresh mutable copy of the §1.4 example policy. */
export function examplePolicy() { return structuredClone(EXAMPLE); }

/** Copy of the example after `mutate(policy)`; returns the mutated policy. */
export function policyWith(mutate) {
  const policy = examplePolicy();
  mutate(policy);
  return policy;
}

/** The §1.4 shared-key event example (disabled, so it validates with sharedKeys=false). */
export function exampleEvent(overrides = {}) {
  return {
    id: 'service-20260906', providerId: 'gemini', eventName: '2026-09-06',
    label: { ko: '9월 6일 예배', en: 'September 6 service', ja: '9月6日の礼拝' },
    startsAt: '2026-09-06T00:00:00Z', expiresAt: '2026-09-06T03:00:00Z', enabled: false,
    allowedCapabilities: ['translate', 'stt', 'voice'],
    ...overrides,
  };
}

export function exampleNotice(overrides = {}) {
  return {
    id: 'notice-1', severity: 'info', showFrom: '2026-09-06T00:00:00Z', showUntil: '2026-09-07T00:00:00Z',
    text: trilingual('notice'),
    ...overrides,
  };
}

export function exampleRate(overrides = {}) {
  return {
    model: 'gemini-3.1-flash-lite', capability: 'translate', unit: 'minute', amount: 0.02,
    basis: 'activeMinuteEstimate', confidence: 'medium', verifiedAt: '2026-09-06T00:00:00Z',
    ...overrides,
  };
}

/** Example plus one notice, one event, hub control and two rates (needs REGISTERED_HUB_IDS). */
export function fullPolicy() {
  return policyWith((policy) => {
    policy.revision = 7;
    policy.validUntil = '2026-12-31T23:59:59Z';
    policy.emergency = { stopped: true, reason: trilingual('reason') };
    policy.features.sharedKeys = true;
    policy.notices = [exampleNotice(), exampleNotice({ id: 'notice-2', severity: 'critical', showFrom: null, showUntil: null })];
    policy.sharedEvents = [exampleEvent({ enabled: true }), exampleEvent({ id: 'service-20260913', eventName: '2026-09-13', startsAt: '2026-09-13T00:00:00Z', expiresAt: '2026-09-13T03:00:00Z' })];
    policy.hubControl = { enabled: true, allowedHubIds: ['venue-main'], allowDirectSubscription: true };
    policy.pricing.rates = [exampleRate(), exampleRate({ capability: 'voice', amount: 0.05, confidence: 'low' })];
    policy.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: true };
    policy.settings['captions.size'] = { default: 1.75, min: 1.25, max: 2, step: 0.25, locked: false };
  });
}

/** JSON text of a policy, optionally padded with trailing spaces to exactly `bytes`. */
export function serialized(policy, { bytes } = {}) {
  const text = JSON.stringify(policy);
  if (bytes === undefined) return text;
  const length = new TextEncoder().encode(text).byteLength;
  if (bytes < length) throw new Error('fixture: padding target smaller than the document');
  return text + ' '.repeat(bytes - length);
}
