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
//   - Rotating means editing BUILTIN_KEY here and staging a new release.
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
 * The shipped key. Set to '' to deploy without one; the app then behaves
 * exactly as it did before this file existed (the key entry is the only way in).
 */
export const BUILTIN_KEY = 'AIzaSyDpqaUo0i3Rtc0fL0nw0AgneA2i-bEEwSI';

/** The key for `providerId`, or null when this build ships none for it. */
export function builtinKeyFor(providerId) {
  return providerId === BUILTIN_PROVIDER_ID && BUILTIN_KEY !== '' ? BUILTIN_KEY : null;
}
