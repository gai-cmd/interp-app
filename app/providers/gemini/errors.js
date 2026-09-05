// New implementation of design-v0.6 §9; no legacy raw error/logging code is ported.
import { ProviderError, normalizeError } from '../contract.js';

// Input: parsed REST body plus HTTP status/headers, or a structured Live error.
// Never infer daily quota or IP denial from free-form messages.
export function normalizeGeminiError(input, { now = Date.now } = {}) {
  if (input instanceof ProviderError) return normalizeError(input);
  try {
    const body = input?.error ?? input?.body?.error ?? input;
    const details = Array.isArray(body?.details) ? body.details : [];
    const reasons = details.filter((d) => d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo').map((d) => d.reason);
    const status = input?.status ?? body?.code;
    const quota = details.filter((d) => d?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure')
      .flatMap((d) => Array.isArray(d.violations) ? d.violations : []);
    const ids = quota.map((v) => v?.quotaId).filter((v) => typeof v === 'string');
    let code = 'PROVIDER_ERROR';
    if (input?.name === 'AbortError') code = 'ABORTED';
    else if (reasons.includes('API_KEY_INVALID') || status === 401) code = 'INVALID_KEY';
    else if (reasons.includes('IP_ADDRESS_BLOCKED') || reasons.includes('API_KEY_IP_ADDRESS_BLOCKED')) code = 'IP_DENIED';
    else if (status === 403 || body?.status === 'PERMISSION_DENIED') code = 'PERMISSION_DENIED';
    else if (reasons.includes('SAFETY_BLOCKED')) code = 'SAFETY_BLOCKED';
    else if (reasons.includes('MODEL_NOT_SUPPORTED')) code = 'MODEL_UNSUPPORTED';
    else if (reasons.includes('SETTINGS_UNSUPPORTED')) code = 'SETTINGS_UNSUPPORTED';
    else if (status === 429 || body?.status === 'RESOURCE_EXHAUSTED') {
      if (ids.some((id) => /PerDay/i.test(id))) code = 'DAILY_LIMIT';
      else if (ids.some((id) => /ConcurrentSessions/i.test(id))) code = 'SESSION_LIMIT';
      else if (ids.some((id) => /Tokens/i.test(id))) code = 'TOKEN_LIMIT';
      else if (ids.some((id) => /PerMinute/i.test(id))) code = 'RATE_LIMITED';
      else code = 'UNKNOWN_429';
    } else if ([500, 502, 503, 504].includes(status) || body?.status === 'UNAVAILABLE') code = 'UNAVAILABLE';
    else if (input?.networkError === true) code = 'NETWORK_ERROR';
    const result = new ProviderError(code);
    const waits = [];
    const header = input?.headers?.get?.('retry-after') ?? input?.headers?.['retry-after'];
    if (typeof header === 'string') {
      const value = /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - now();
      if (Number.isFinite(value) && value >= 0) waits.push(value);
    }
    for (const detail of details) {
      if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
      const delay = detail.retryDelay;
      let value;
      if (typeof delay === 'string' && /^\d+(\.\d{1,9})?s$/.test(delay)) value = Number(delay.slice(0, -1)) * 1000;
      else if (delay && /^\d+$/.test(String(delay.seconds ?? 0)) && Number.isInteger(delay.nanos ?? 0)
        && (delay.nanos ?? 0) >= 0 && (delay.nanos ?? 0) < 1e9) value = Number(delay.seconds ?? 0) * 1000 + (delay.nanos ?? 0) / 1e6;
      if (Number.isFinite(value) && value >= 0) waits.push(value);
    }
    if (waits.length) result.retryAfterMs = Math.max(...waits);
    return result;
  } catch { return new ProviderError('PROVIDER_ERROR'); }
}
