// New implementation of design-p3 §1.15 and §3 ("앱 버전"); no legacy code is
// ported. The app version is a numeric major.minor.patch that the policy's
// minAppVersion gate (P3-07) and check-release (P3-36) compare numerically.
// It is distinct from the release ID (RELEASE_ID_PATTERN / pwa VERSION_PATTERN),
// which is an arbitrary deploy label. tests/policy-schema.test.mjs asserts that
// package.json carries the same string.
export const APP_VERSION = '0.7.0';

// Strict numeric triplet: no "v" prefix, no leading zeros, no pre-release tag.
export const APP_VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** [major, minor, patch] as numbers, or null when the text is not a version. */
export function parseVersion(value) {
  const match = typeof value === 'string' ? APP_VERSION_PATTERN.exec(value) : null;
  return match ? Object.freeze([Number(match[1]), Number(match[2]), Number(match[3])]) : null;
}
