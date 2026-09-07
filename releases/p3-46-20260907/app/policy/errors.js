// Dependency-free policy errors shared by execution and presentation boundaries.
export const POLICY_ERROR_CODES = Object.freeze(['POLICY_LOADING', 'POLICY_UNAVAILABLE', 'POLICY_EXPIRED', 'POLICY_STOPPED',
  'POLICY_FEATURE_DISABLED', 'APP_VERSION_TOO_OLD', 'EVENT_ENDED', 'HUB_CONTROL_STOPPED', 'HUB_CONTROL_LOST']);
/** Thrown by assertAction / assertRoute; `code` is one of POLICY_ERROR_CODES. */
export class PolicyError extends Error {
  constructor(code) {
    const safe = POLICY_ERROR_CODES.includes(code) ? code : 'POLICY_UNAVAILABLE';
    super(safe);
    this.name = 'PolicyError';
    this.code = safe;
  }
}
export function isPolicyError(error) {
  return error instanceof PolicyError
    || (error !== null && typeof error === 'object' && error.name === 'PolicyError' && POLICY_ERROR_CODES.includes(error.code));
}

