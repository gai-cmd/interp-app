// New implementation of design-p2 §§7.3, 8.4 and 9; no legacy code is ported.
import { ProviderError } from '../providers/contract.js';

export const LISTEN_STATUS = Object.freeze(['idle', 'preparing', 'connecting', 'running',
  'reconnecting', 'stopping', 'stopped', 'failed']);
export const OUTPUT_STATUS = Object.freeze(['muted', 'ready', 'blocked', 'delayed', 'catching-up', 'unavailable']);
export const BROADCAST_STATUS = Object.freeze(['unknown', 'waiting', 'receiving', 'ended']);
const edges = {
  idle: ['preparing'], stopped: ['preparing'], failed: ['preparing'],
  preparing: ['connecting', 'stopping', 'failed'],
  connecting: ['running', 'reconnecting', 'stopping', 'failed'],
  running: ['reconnecting', 'stopping', 'failed'],
  reconnecting: ['running', 'stopping', 'failed'], stopping: ['stopped', 'failed'],
};
const invalid = () => { throw new ProviderError('INVALID_REQUEST'); };

/** Pure screen state, not a resource owner. Engines must finish cleanup before
 * stopped/failed, and pass the captured generation to every async mutation.
 * A stop invalidates pending callbacks immediately; cleanup uses the new token.
 * This module exposes machine values only; P2-14/16 own dictionary rendering.
 */
export function createListenState({ mode = 'direct' } = {}) {
  if (!['direct', 'hub'].includes(mode)) invalid();
  let state = Object.freeze({ mode, generation: 0, status: 'idle', output: 'muted', broadcast: 'unknown' });
  let closed = false;
  const listeners = new Set();
  const open = () => { if (closed) throw new ProviderError('SESSION_CLOSED'); };
  function commit(patch) {
    state = Object.freeze({ ...state, ...patch });
    const snapshot = state;
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* Consumer-owned failure. */ }
    }
    return state;
  }
  return Object.freeze({
    snapshot: () => state,
    subscribe(listener) {
      open();
      if (typeof listener !== 'function') invalid();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transition(status, generation = state.generation) {
      open();
      if (!LISTEN_STATUS.includes(status)) invalid();
      if (generation !== state.generation) return false;
      if (status === state.status) return true;
      if (!edges[state.status].includes(status)) invalid();
      const reset = status === 'preparing';
      commit({ status, generation: state.generation + (reset || status === 'stopping' || status === 'failed' ? 1 : 0),
        ...(reset ? { output: 'muted', broadcast: 'unknown' } : {}),
        ...(status === 'stopped' || status === 'failed' ? { output: 'muted' } : {}) });
      return true;
    },
    setOutput(output, generation = state.generation) {
      open();
      if (!OUTPUT_STATUS.includes(output)) invalid();
      if (generation !== state.generation) return false;
      commit({ output });
      return true;
    },
    setBroadcast(broadcast, generation = state.generation) {
      open();
      if (mode !== 'hub' || !BROADCAST_STATUS.includes(broadcast)) invalid();
      if (generation !== state.generation) return false;
      commit({ broadcast });
      return true;
    },
    close() {
      if (closed) return state;
      closed = true;
      commit({ generation: state.generation + 1, status: 'stopped', output: 'muted', broadcast: 'unknown' });
      listeners.clear();
      return state;
    },
  });
}
