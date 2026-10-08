// New implementation of docs/extension.md §10.6; no legacy code is ported.
//
// The extension's built-in provider key slot. It mirrors app/security/builtin-key.js
// on purpose: in git the list is ALWAYS empty, and only a local, explicit
// `node scripts/build-extension.mjs --builtin-key-file <path>` build writes keys
// into the gitignored copy under dist/. Nothing in the source tree ever holds one:
// a key committed to a public repository is revoked by secret scanning within
// minutes (this happened to the web app's first built-in key on 2026-09-07).
//
// Rules for the one line below:
//   - The build replaces that exact text, once, in the OUTPUT copy. Do not reformat
//     it, add a second copy of it (comments included) or split it over lines, or the
//     keyed build refuses with EXTENSION_KEY_SLOT_INVALID.
//   - This module imports nothing and touches no global, so any extension context
//     may import it. The whole list is used as a pool (§20, 7.4): the worker sends
//     every key of it (at most LIMITS.maxPoolKeys) in host/lane-start, and the lane
//     moves to the next key by itself when one hits its quota or is refused. A
//     personal key stored by the options page always wins and never falls back.
//   - Anyone who holds a keyed folder or zip can read the keys. The members' zip is
//     keyed on purpose (owner decision, §16); the same free keys are in the web app.
export const BUILTIN_KEYS = Object.freeze([]);
