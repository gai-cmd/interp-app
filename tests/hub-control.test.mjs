// P3-10: the live-control state of one joined event (design-p3 §1.8).
// Ordering (reverse, duplicate, new epoch), TTL, the stop latch, renegotiation
// and the intersection with the site policy. The parser (P3-09) and the socket
// (P3-11) are covered by their own suites; nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubControl, HUB_CONTROL_INITIAL_EPOCH } from '../app/hub/control.js';
import { createHubControl as reexported } from '../app/hub/client.js';
import { HUB_LIMITS } from '../app/hub/protocol.js';
import { resolveEffective } from '../app/policy/resolve.js';
import { examplePolicy } from './fixtures/policy.mjs';
import { controlFixture, initialState, negotiation, parsed, parsedRelease,
  EPOCH, EVENT_ID } from './fixtures/hub-control.mjs';

test('control state: creation, the frozen snapshot and the re-export from client.js', () => {
  const { control } = controlFixture();
  assert.deepEqual(control.snapshot(), initialState);
  assert.ok(Object.isFrozen(control.snapshot()));
  assert.equal(control.snapshot(), control.snapshot(), 'an unchanged snapshot is not rebuilt');
  assert.equal(reexported, createHubControl, 'client.js re-exports this module, it does not copy it');
  assert.equal(HUB_CONTROL_INITIAL_EPOCH, 'initial');
  assert.throws(() => createHubControl({ now: 'later' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => createHubControl({ setTimeout: 1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => createHubControl({ clearTimeout: 1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => control.subscribe(null), { code: 'INVALID_REQUEST' });
  control.close();
});

test('negotiation: nothing is accepted before a hello, and the hello revision is only a hint', () => {
  const { control, clock } = controlFixture();
  assert.equal(control.receive(parsed()), false, 'no snapshot lands before a negotiation');
  assert.deepEqual(control.snapshot(), initialState);
  control.negotiate(negotiation());
  const negotiated = control.snapshot();
  assert.equal(negotiated.supported, true);
  assert.equal(negotiated.eventId, EVENT_ID);
  assert.equal(negotiated.epoch, EPOCH);
  assert.equal(negotiated.revision, null, 'the hello revision is a hint; the first snapshot lands at any revision');
  assert.equal(negotiated.expiresAt, HUB_LIMITS.ttlMaxSeconds * 1000, 'the first snapshot gets the longest TTL');
  assert.equal(clock.size, 1);
  assert.throws(() => control.negotiate({ version: 1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => control.negotiate({ eventId: EVENT_ID, epoch: 7 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => control.negotiate([]), { code: 'INVALID_REQUEST' });
  control.close();
});

test('ordering: another event or epoch is ignored, a lower revision never releases, a repeat is the heartbeat', () => {
  const { control, clock, changes } = controlFixture();
  control.negotiate(negotiation());
  assert.equal(control.receive(parsed({ epoch: 'other-epoch' })), false);
  assert.equal(control.receive(parsed({ eventId: 'other-event' })), false);
  assert.equal(control.receive({ ...parsed(), type: 'hello' }), false, 'only a control envelope is a snapshot');
  assert.equal(control.receive({ ...parsed(), revision: 1.5 }), false, 'a non-integer revision is not an order');
  assert.equal(control.receive(null), false);

  assert.equal(control.receive(parsed()), true);
  const applied = control.snapshot();
  assert.equal(applied.revision, 13);
  assert.equal(applied.stopped, true);
  assert.deepEqual([...applied.disabledFeatures], ['simultaneousDirect']);
  assert.ok(Object.isFrozen(applied.disabledFeatures));
  assert.equal(applied.notice.id, 'pause-13');
  assert.equal(applied.expiresAt, 60000);

  clock.advance(1000);
  const before = changes.length;
  assert.equal(control.receive(parsed()), false, 'the same revision is a heartbeat, not a change');
  assert.equal(control.snapshot().expiresAt, 61000, 'the heartbeat re-arms the TTL');
  assert.equal(changes.length, before + 1, 'the heartbeat still notifies (expiresAt moved)');

  assert.equal(control.receive(parsedRelease({ revision: 12 })), false, 'out-of-order release is dropped');
  assert.equal(control.snapshot().stopped, true);
  assert.equal(control.receive(parsedRelease()), true, 'a higher revision releases');
  assert.deepEqual({ ...control.snapshot(), expiresAt: null },
    { ...initialState, supported: true, eventId: EVENT_ID, epoch: EPOCH, revision: 14 });
  control.close();
});

test('TTL and disconnection set heartbeatLost only; the stop latch survives both', () => {
  const { control, clock } = controlFixture();
  control.negotiate(negotiation());
  control.receive(parsed({ ttlSeconds: 10 }));
  clock.advance(9999);
  assert.equal(control.snapshot().heartbeatLost, false);
  clock.advance(1);
  assert.equal(control.snapshot().heartbeatLost, true, 'the deadline runs on the app clock');
  assert.equal(control.snapshot().stopped, true, 'expiry never releases a stop');
  assert.equal(control.receive(parsed({ ttlSeconds: 10 })), false);
  assert.equal(control.snapshot().heartbeatLost, false, 'the heartbeat clears the loss');

  control.disconnected();
  assert.equal(control.snapshot().heartbeatLost, true);
  assert.equal(control.snapshot().expiresAt, null);
  assert.equal(control.snapshot().stopped, true, 'a dropped socket never releases a stop');
  assert.equal(clock.size, 0, 'no timer is left running while disconnected');
  clock.advance(HUB_LIMITS.ttlMaxSeconds * 1000);
  assert.equal(control.snapshot().stopped, true);
  control.close();
});

test('renegotiation: the same epoch continues the order, a new epoch restarts it, neither releases the latch', () => {
  const { control } = controlFixture();
  control.negotiate(negotiation());
  control.receive(parsed({ ttlSeconds: 10 }));
  control.disconnected();

  control.negotiate(negotiation({ revision: 13 }));
  assert.equal(control.snapshot().heartbeatLost, false, 'a fresh hello clears the loss');
  assert.equal(control.snapshot().revision, 13, 'the same epoch keeps the revision order');
  assert.equal(control.snapshot().stopped, true);
  assert.equal(control.receive(parsedRelease({ revision: 13 })), false, 'a repeat of the carried revision is a heartbeat');
  assert.equal(control.snapshot().stopped, true);

  control.negotiate(negotiation({ epoch: 'next-epoch' }));
  assert.equal(control.snapshot().revision, null, 'a new epoch restarts the order');
  assert.equal(control.snapshot().stopped, true, 'a broadcast restart does not release a stop');
  assert.equal(control.receive(parsedRelease({ epoch: 'next-epoch', revision: 1 })), true);
  assert.equal(control.snapshot().stopped, false, 'only a newer accepted snapshot releases');
  control.close();
});

test('a hub without the extension is unsupported and cannot release, and has no heartbeat to lose', () => {
  const { control, clock } = controlFixture();
  control.negotiate(negotiation());
  control.receive(parsed());
  control.negotiate(null);
  const state = control.snapshot();
  assert.equal(state.supported, false);
  assert.equal(state.eventId, null);
  assert.equal(state.epoch, null);
  assert.equal(state.revision, null);
  assert.equal(state.stopped, true, 'losing the extension does not release a stop');
  assert.equal(state.expiresAt, null);
  assert.equal(clock.size, 0);
  assert.equal(control.receive(parsed({ revision: 99 })), false, 'an unsupported hub cannot be obeyed');
  clock.advance(HUB_LIMITS.ttlMaxSeconds * 1000);
  assert.equal(control.snapshot().heartbeatLost, false);
  assert.equal(control.snapshot().stopped, true);
  control.close();
});

test('reset clears the latch, close freezes the state, and unsubscribe stops notifications', () => {
  const { control, clock, changes, unsubscribe } = controlFixture();
  control.negotiate(negotiation());
  control.receive(parsed());
  assert.equal(control.snapshot().stopped, true);
  control.reset();
  assert.deepEqual(control.snapshot(), initialState, 'only reset() clears a latch without a newer snapshot');
  assert.equal(clock.size, 0);

  control.negotiate(negotiation());
  const counted = changes.length;
  unsubscribe();
  control.receive(parsed());
  assert.equal(changes.length, counted, 'an unsubscribed listener is not called');

  const stopped = control.snapshot();
  control.close();
  control.negotiate(negotiation({ epoch: 'after-close' }));
  control.receive(parsedRelease({ epoch: 'after-close', revision: 1 }));
  control.disconnected();
  control.reset();
  assert.deepEqual(control.snapshot(), stopped, 'a closed state changes nothing');
  assert.equal(clock.size, 0, 'close disarms the TTL timer');
});

test('a listener that throws cannot break the state or the other listeners', () => {
  const { control } = controlFixture();
  const seen = [];
  control.subscribe(() => { throw new Error('consumer'); });
  control.subscribe((value) => seen.push(value.revision));
  control.negotiate(negotiation());
  assert.equal(control.receive(parsed()), true);
  assert.deepEqual(seen, [null, 13]);
  control.close();
});

test('site policy ∩ hub control: the hub only adds restrictions and never grants them', () => {
  const { control } = controlFixture();
  const policy = examplePolicy();
  const effective = (hubControl) => resolveEffective({ policy, preferences: {}, hubControl,
    appVersion: '1.0.0', now: () => new Date('2026-09-06T01:00:00Z') });

  const open = effective(control.snapshot());
  assert.equal(open.blocked, null, 'an unnegotiated control blocks nothing on its own');

  control.negotiate(negotiation());
  control.receive(parsed());
  const stopped = effective(control.snapshot());
  assert.equal(stopped.blocked.code, 'HUB_CONTROL_STOPPED');
  assert.equal(stopped.features.simultaneousDirect.enabled, false);
  assert.equal(stopped.features.simultaneousDirect.reasonKey, 'hubControl.stopped');

  control.receive(parsedRelease());
  const released = effective(control.snapshot());
  assert.equal(released.blocked, null);
  assert.deepEqual(Object.keys(released.features).filter((key) => released.features[key].reasonKey === 'hubControl.stopped'), [],
    'releasing the hub restriction leaves no hub reason behind');
  for (const [name, feature] of Object.entries(released.features)) {
    assert.equal(feature.enabled, open.features[name].enabled, `${name}: the hub cannot grant beyond the site policy`);
  }
  assert.equal(released.features.sharedKeys.enabled, false, 'a site-disabled feature stays off through any hub state');
  assert.equal(released.features.sharedKeys.reasonKey, 'policy.featureOff');

  control.disconnected();
  assert.equal(effective(control.snapshot()).blocked.code, 'HUB_CONTROL_LOST', 'an unconfirmable control blocks');
  control.close();
});
