// Built-in provider key (owner decision, 2026-09-07).
//
// The owner asked that a device which has never been set up be able to start
// interpreting without typing anything, so the site ships one Gemini key.
//
// This is a deliberate, reviewed exception to design-v0.6 §11.2 "배포 산출물의
// 비밀 검사", NOT an oversight, and it is the ONLY file allowed to carry a
// credential: scripts/check-release.mjs keeps the AIza… scan active on every
// other file and names this path in its exempt-file list, so a passing release
// prints RELEASE_BUILTIN_KEY instead of waving the key through in silence.
//
// What the owner accepted when choosing this:
//   - The key is readable by anyone who opens the site. Google's own guidance
//     (https://ai.google.dev/gemini-api/docs/api-key) is not to ship keys in
//     client code, and the Generative Language API has no reliable HTTP
//     referrer restriction, so the site's origin cannot fence it in.
//   - Every call made with it bills the owner's Google account. Set a budget
//     cap on the project and rotate the key at the first sign of abuse.
//   - The value is NOT in git. GitHub secret scanning reports any Google key
//     pushed to a public repository and Google revokes it within minutes
//     (this happened to the first key on 2026-09-07). The committed value
//     stays empty and scripts/stage-release.mjs --builtin-key-file <path>
//     writes the real key into the staged copy only, so it reaches the
//     deployed site and never a repository. Rotating means replacing the
//     local file and staging a new release.
//
// The value flows through exactly one path: app/main.js installs it as the
// personal key when a device has none of its own, so it uses the reviewed
// key-store, router and credential-reference boundary like any typed key. A
// key the person entered themselves always wins — nothing here overwrites it,
// and nothing here is ever written to storage.
import { GEMINI_PROVIDER_ID } from '../providers/gemini/index.js';

/** The provider the built-in key authenticates against. */
export const BUILTIN_PROVIDER_ID = GEMINI_PROVIDER_ID;

/**
 * The shipped keys, in the order they are used. In git this is always the
 * empty list (see above); a release staged with --builtin-key-file carries the
 * file's keys here, one per line. Owner (2026-09-07): several free-tier keys
 * are used in turns — when the active one hits its quota (429) the app moves
 * to the next, and only when the last one is spent does it report the site
 * key as blocked. Deploying with none makes the app behave exactly as it did
 * before this file existed (the key entry is the only way in).
 */
export const BUILTIN_KEYS = Object.freeze([]);

/** The keys for `providerId` in rotation order, or null when this build ships none for it. */
export function builtinKeyFor(providerId) {
  return providerId === BUILTIN_PROVIDER_ID && BUILTIN_KEYS.length ? [...BUILTIN_KEYS] : null;
}
