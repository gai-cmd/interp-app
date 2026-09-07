// New implementation of design-v0.6 §11; no legacy code is ported.
import { ERROR_CODES } from '../providers/contract.js';

export const SECURITY_CODES = Object.freeze([
  'INVALID_SHARED_PAYLOAD', 'SHARED_USE_ENDED', 'URL_CLEANUP_FAILED',
  'STORAGE_FAILED', 'STORE_CLOSED', 'SECURITY_ERROR',
]);

// Machine codes only. P1-04/P1-15 translate these; never display raw messages.
export class SecurityError extends Error {
  constructor(code) {
    const safe = SECURITY_CODES.includes(code) ? code : 'SECURITY_ERROR';
    super(safe);
    this.name = 'SecurityError';
    this.code = safe;
  }
}

// A diagnostic allowlist, not a key-pattern blacklist. Arbitrary strings, object
// keys, nested causes, stacks, URLs, headers and payloads are never copied.
// Do not use this for application data or as permission to log raw inputs.
export function redact(value) {
  try {
    const code = Object.getOwnPropertyDescriptor(value, 'code')?.value;
    return Object.freeze({ code: [...ERROR_CODES, ...SECURITY_CODES].includes(code)
      ? code : 'SECURITY_ERROR' });
  } catch {
    return Object.freeze({ code: 'SECURITY_ERROR' });
  }
}
