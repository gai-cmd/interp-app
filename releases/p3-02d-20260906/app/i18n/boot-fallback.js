// New implementation of design-p2 P2-19; no legacy code is ported.
// Minimal bootstrap-only subset of en.json, checked by app-lifecycle tests.
// Keep ordinary UI translations in the JSON dictionaries.
export default Object.freeze({
  "error.unknown": "The task could not be completed. Check settings and retry.",
  "error.NETWORK_ERROR": "Check your network connection.",
  "error.ABORTED": "The task was cancelled."
});
