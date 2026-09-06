// New implementation of design-v0.6 §5.4; no legacy code is ported.
import { SecurityError } from './redact.js';

// Call before importing/starting the application, diagnostics or persistence.
// Inject window.location/history at startup; imports have no browser effects.
export function bootstrapSharedKey({ location, history, keyStore }) {
  let fragment;
  try {
    fragment = location.hash;
    if (!fragment) return Object.freeze({ received: false });
    // Drop state as well: an earlier entry may have retained credential data.
    // Clear query data defensively rather than forwarding unknown URL secrets.
    history.replaceState(null, '', location.pathname);
  } catch {
    throw new SecurityError('URL_CLEANUP_FAILED');
  }
  try {
    keyStore.receiveSharedFragment(fragment);
    return Object.freeze({ received: true });
  } finally {
    fragment = null;
  }
}
