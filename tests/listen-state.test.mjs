import test from 'node:test';
import assert from 'node:assert/strict';
import { createListenState, LISTEN_STATUS, OUTPUT_STATUS } from '../app/engine/listen-state.js';

const paths = { idle: [], preparing: ['preparing'], connecting: ['preparing', 'connecting'],
  running: ['preparing', 'connecting', 'running'], reconnecting: ['preparing', 'connecting', 'running', 'reconnecting'],
  stopping: ['preparing', 'stopping'], stopped: ['preparing', 'stopping', 'stopped'], failed: ['preparing', 'failed'] };
const allowed = { idle: ['preparing'], preparing: ['connecting', 'stopping', 'failed'],
  connecting: ['running', 'reconnecting', 'stopping', 'failed'], running: ['reconnecting', 'stopping', 'failed'],
  reconnecting: ['running', 'stopping', 'failed'], stopping: ['stopped', 'failed'], stopped: ['preparing'], failed: ['preparing'] };

test('every session transition is validated against the design table', () => {
  for (const from of LISTEN_STATUS) for (const to of LISTEN_STATUS) {
    const state = createListenState();
    for (const step of paths[from]) state.transition(step);
    if (from === to || allowed[from].includes(to)) assert.equal(state.transition(to), true, `${from} -> ${to}`);
    else assert.throws(() => state.transition(to), { code: 'INVALID_REQUEST' });
  }
});
test('audio failure and hub waiting are independent of session success', () => {
  const state = createListenState({ mode: 'hub' });
  for (const step of paths.running) state.transition(step);
  assert.equal(state.snapshot().broadcast, 'unknown');
  state.setBroadcast('waiting');
  for (const output of OUTPUT_STATUS) {
    state.setOutput(output);
    assert.equal(state.snapshot().status, 'running');
    assert.equal(state.snapshot().broadcast, 'waiting');
  }
  state.setBroadcast('ended');
  state.transition('stopping'); state.transition('stopped');
  assert.equal(state.snapshot().output, 'muted');
  assert.equal(state.snapshot().broadcast, 'ended');
});
test('stop invalidates late callbacks and manual restart gets a fresh generation', () => {
  const state = createListenState({ mode: 'hub' });
  state.transition('preparing');
  const token = state.snapshot().generation;
  state.transition('stopping', token);
  assert.equal(state.transition('connecting', token), false);
  assert.equal(state.setOutput('ready', token), false);
  assert.equal(state.setBroadcast('receiving', token), false);
  state.transition('stopped');
  state.transition('preparing');
  assert.ok(state.snapshot().generation > token);
  assert.equal(state.snapshot().broadcast, 'unknown');
});
test('frozen subscriptions, sanitized errors and idempotent disposal', () => {
  const state = createListenState();
  let count = 0;
  state.subscribe(() => { throw Error('consumer'); });
  const unsubscribe = state.subscribe((s) => { count++; assert.ok(Object.isFrozen(s)); });
  state.transition('preparing'); unsubscribe(); state.transition('connecting');
  assert.equal(count, 1);
  assert.throws(() => state.setBroadcast('receiving'), { code: 'INVALID_REQUEST' });
  assert.throws(() => state.setOutput('https://secret.invalid'), (e) => !JSON.stringify(e).includes('secret'));
  state.close(); const snapshot = state.snapshot(); state.close();
  assert.equal(state.snapshot(), snapshot);
  assert.throws(() => state.transition('preparing'), { code: 'SESSION_CLOSED' });
});
