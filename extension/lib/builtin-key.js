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
//     may import it. Only BUILTIN_KEYS[0] is ever used (no rotation, §7.4), and the
//     personal key stored by the options page always wins over it.
//   - Anyone who holds a keyed folder or zip can read the key; a keyed build is a
//     personal convenience, never something to hand to other people.
export const BUILTIN_KEYS = Object.freeze([]);
