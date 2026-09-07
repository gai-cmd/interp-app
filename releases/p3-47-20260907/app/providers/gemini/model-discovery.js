// Live model discovery (owner, 2026-09-06): the repository list in
// live-config.js is fixed at review time, so a newer Live model published by
// the provider was invisible until someone edited the code. This module asks
// the provider which models the account can actually use and reports the Live
// ones, so the app can adopt a new one on its own.
//
// What this deliberately does NOT do:
// - It never introduces an endpoint. The listing is a GET on the SAME
//   REST_ENDPOINT the app already calls, so the CSP connect-src is unchanged.
// - It never returns a model whose identifier is not a plain model id, and it
//   caps how many it will consider, so a hostile or broken reply cannot flood
//   the settings picker or become a path.
// - It never returns the key, the URL or any provider text: callers get model
//   ids and a code, nothing else.
//
// A discovered model has no repository entry, so callers must decide its setup
// route themselves; liveSetupFor() applies the same rule the repository uses —
// a translation-configured model is recognised by its id, everything else is
// driven by the system instruction, which is the safe default because it works
// on any Live model.
import { REST_ENDPOINT } from './config.js';
import { ProviderError } from '../contract.js';

/** The generation method a Live (bidirectional streaming) model reports. */
export const LIVE_METHOD = 'bidiGenerateContent';
/** Bounds on a reply we do not control. */
export const DISCOVERY_LIMITS = Object.freeze({ maxModels: 200, maxBytes: 1048576, timeoutMs: 15000 });
// A model id as the provider spells it: lowercase, digits, dot and dash. The
// "models/" prefix is stripped before this is applied.
const MODEL_ID = /^[a-z][a-z0-9.-]{0,63}$/;
// Only a model whose id says it is a translation model gets the translation
// setup; everything else uses the instruction route, which any Live model runs.
const TRANSLATION_ID = /(^|-)live-translate(-|$)/;

/** 'translation' | 'flash' for a model with no repository entry. */
export function liveSetupFor(model) {
  return TRANSLATION_ID.test(String(model ?? '')) ? 'translation' : 'flash';
}

/** The bare model id, or null when the name is not one we would ever call. */
export function modelIdOf(name) {
  if (typeof name !== 'string') return null;
  const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
  return MODEL_ID.test(id) ? id : null;
}

/**
 * discoverLiveModels({ fetch, key, signal, now? }) -> frozen
 * { models: [id], code: null } on success, or { models: [], code } on failure.
 *
 * The key travels in the same header the rest of the adapter uses and is never
 * put in the URL. Failures are codes only: a discovery that cannot run must
 * never block interpretation, so callers keep the repository list and carry on.
 */
export async function discoverLiveModels({ fetch: fetchImpl = globalThis.fetch, key,
  signal = null, limits = DISCOVERY_LIMITS } = {}) {
  const failure = (code) => Object.freeze({ models: Object.freeze([]), code });
  if (typeof fetchImpl !== 'function' || typeof key !== 'string' || !key) return failure('CREDENTIAL_REQUIRED');
  let response;
  try {
    response = await fetchImpl(REST_ENDPOINT, { method: 'GET', signal,
      headers: { 'x-goog-api-key': key, accept: 'application/json' } });
  } catch { return failure('NETWORK_ERROR'); }
  if (!response || typeof response.status !== 'number') return failure('INVALID_RESULT');
  if (response.status === 401 || response.status === 403) return failure('INVALID_KEY');
  if (response.status === 429) return failure('RATE_LIMITED');
  if (!response.ok) return failure('NETWORK_ERROR');
  let body;
  try { body = await response.json(); } catch { return failure('INVALID_RESULT'); }
  const listed = Array.isArray(body?.models) ? body.models.slice(0, limits.maxModels) : null;
  if (!listed) return failure('INVALID_RESULT');
  const models = [];
  for (const entry of listed) {
    const methods = entry?.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes(LIVE_METHOD)) continue;
    const id = modelIdOf(entry?.name);
    if (id && !models.includes(id)) models.push(id);
  }
  return Object.freeze({ models: Object.freeze(models), code: null });
}

/**
 * mergeLiveModels(known, discovered) -> frozen list, the repository order
 * first (so the reviewed default keeps its place) followed by anything new the
 * account can reach, in the order the provider listed it.
 */
export function mergeLiveModels(known, discovered) {
  const base = Array.isArray(known) ? known.filter((id) => modelIdOf(id) !== null) : [];
  const extra = (Array.isArray(discovered) ? discovered : [])
    .filter((id) => modelIdOf(id) !== null && !base.includes(id));
  return Object.freeze([...base, ...extra]);
}

/** The newest model to prefer, or null when nothing new was found. */
export function newestLiveModel(known, discovered) {
  const merged = mergeLiveModels(known, discovered);
  const added = merged.filter((id) => !(Array.isArray(known) ? known : []).includes(id));
  return added.length ? added[0] : null;
}

export { ProviderError };
