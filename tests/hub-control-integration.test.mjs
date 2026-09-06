import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startApp } from '../app/main.js';
import { HUB_CONTROL_INITIAL_EPOCH } from '../app/hub/client.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { all, byClass, choose, createBrowser, domText, leaks, scenarioPolicy, tick, until } from './fixtures/scenarios.mjs';
import { exampleEvent } from './fixtures/policy.mjs';
import { EPOCH, EVENT_ID, controlHello, hello, releaseSnapshot, snapshot } from './fixtures/hub.mjs';

// P3-11 (design-p3 §1.8): the real app against the fake browser. A direct-mode
// user joins a registered event explicitly and keeps a control-only audience
// connection; a hub listener's socket carries the negotiation instead. The
// control connection is not app work: no key, microphone or speech, no activity
// lease, and stopWork() never closes it, so the release notice still arrives.

const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));
const ko = dictionaries.ko;
const HUB_ID = 'test';
const ROOM = 'abc123';
const KEY = 'PERSONAL-SECRET-KEY-0123456789';
const testHubs = [{ id: HUB_ID, labelKey: 'hub.venue', url: 'wss://hub.example.test/ws' }];
const activeEvent = (overrides = {}) => exampleEvent({ enabled: true, startsAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ...overrides });
const controlPolicy = (mutate = () => {}) => scenarioPolicy((policy) => {
  policy.sharedEvents = [activeEvent()];
  policy.hubControl = { enabled: true, allowedHubIds: [HUB_ID], allowDirectSubscription: true };
  mutate(policy);
});
const negotiation = (epoch, revision) => ({ type: 'hello', settings: {}, control: { version: 1, eventId: EVENT_ID, epoch, revision } });
const el = (b, name) => byClass(b.root, name);
const notice = (b) => b.app.engine.state.snapshot().notice?.messageKey ?? null;
const textOf = (b, key) => all(b.root, (node) => node.text === ko[key])[0];

async function boot(t, options = {}) {
  const b = createBrowser({ policy: controlPolicy(), ...options });
  b.app = await startApp({ window: b.win, hubs: testHubs });
  assert.ok(b.app, 'the app started');
  t.after(async () => {
    for (const socket of b.sockets) socket.finishClose();
    await b.app.close();
  });
  await b.app.shell.switchTab('simultaneous');
  await until(() => el(b, 'sim-control').hidden === false, 50);
  return b;
}
function joinFromScreen(b, { room = ROOM } = {}) {
  el(b, 'sim-event').value = EVENT_ID;
  el(b, 'sim-venue').value = HUB_ID;
  el(b, 'sim-room').value = room;
  el(b, 'sim-event-join').dispatch('click');
}
/** The socket at `index` once it exists, opened. */
async function opened(b, index) {
  await until(() => b.sockets.length > index);
  const socket = b.sockets[index];
  socket.open();
  return socket;
}
function enterKey(b) {
  const input = el(b, 'settings-key-input');
  input.value = KEY;
  // P3-22: typing is what clears the mask of a stored key.
  input.dispatch('input');
  el(b, 'settings-key-form').dispatch('submit');
  assert.equal(input.value.includes(KEY), false);
  assert.match(input.value, /^\u2022*$/);
}
async function runDirect(b, socketIndex) {
  const handle = b.app.listenEngines.direct.start({ targetLanguage: 'ja' });
  await until(() => b.audio.nodes.at(-1)?.port.onmessage);
  b.microphone.feed(new Float32Array(4096).fill(0.1));
  await until(() => b.sockets.length > socketIndex);
  const socket = b.sockets[socketIndex];
  socket.open(); socket.json({ setupComplete: {} });
  await handle.ready;
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'running');
  return { handle, socket };
}
const quiet = (b) => {
  assert.equal(b.microphone.streams.length, 0, 'no microphone');
  assert.equal(b.gemini.calls.length, 0, 'no provider call');
  assert.equal(b.speech.utterances.length, 0, 'no device speech');
  assert.equal(b.app.config.keyStore.getSelection(), null, 'no key selected');
  assert.equal(b.app.activity.occupied, false, 'no activity lease');
  assert.equal(b.app.engine.snapshot().busy, false);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'idle');
  assert.equal(b.app.listenEngines.hub.snapshot().status, 'idle');
};

test('control-only connection: explicit join negotiates without key, microphone, speech or activity; stop keeps the socket; release reopens without a start', async (t) => {
  const b = await boot(t);
  const status = el(b, 'sim-control-status');
  assert.equal(status.hidden, true);
  assert.equal(el(b, 'sim-event-leave').hidden, true);
  assert.equal(el(b, 'sim-venue').parentNode.hidden, false, 'direct listening shows venue and room while an event can be joined');
  assert.equal(el(b, 'sim-event').value, EVENT_ID);
  assert.equal(el(b, 'sim-event').children[0].textContent, `9월 6일 예배 · ${ko['event.status.active']}`);
  joinFromScreen(b);
  assert.equal(notice(b), 'event.joined');
  assert.deepEqual(b.app.eventLink.snapshot().joined, { eventId: EVENT_ID, hubId: HUB_ID });
  assert.equal(b.app.policy.snapshot().eventId, EVENT_ID);
  assert.equal(el(b, 'sim-event-join').hidden, true);
  assert.equal(el(b, 'sim-event-leave').hidden, false);
  assert.equal(el(b, 'sim-event-name').textContent, `${ko['event.name']}: 9월 6일 예배`);
  const socket = await opened(b, 0);
  assert.deepEqual(b.socketURLs, [`wss://hub.example.test/ws?room=${ROOM}`]);
  assert.deepEqual(socket.sent, [negotiation(HUB_CONTROL_INITIAL_EPOCH, 0)]);
  socket.json(controlHello());
  await tick();
  assert.equal(b.app.hubControl.snapshot().supported, true);
  assert.equal(status.textContent, ko['hubControl.supported']);
  assert.equal(status.getAttribute('data-control'), 'supported');
  quiet(b);
  assert.equal(b.app.policy.snapshot().blocked, null);

  // Stop: the gate closes with the hub code, the socket stays open.
  socket.json(snapshot());
  await tick();
  assert.deepEqual(b.app.policy.snapshot().blocked, { code: 'HUB_CONTROL_STOPPED', revision: 1 });
  assert.equal(b.app.policy.snapshot().features.simultaneousDirect.enabled, false);
  assert.throws(() => b.app.listenEngines.direct.start({ targetLanguage: 'ja' }), { code: 'HUB_CONTROL_STOPPED' });
  await until(() => !b.app.activity.occupied);
  assert.equal(status.textContent, ko['hubControl.stopped']);
  assert.equal(el(b, 'sim-control-revision').textContent, ko['hubControl.revision'].replace('{revision}', '13'));
  assert.equal(el(b, 'sim-control-notice').textContent, '잠시 통역을 중지합니다.');
  assert.equal(el(b, 'sim-control-notice').hidden, false);
  b.app.setLanguage('en');
  assert.equal(status.textContent, dictionaries.en['hubControl.stopped']);
  assert.equal(el(b, 'sim-control-notice').textContent, 'Interpretation is temporarily paused.');
  b.app.setLanguage('ko');
  // The expected trap: cleanup paths and a hidden page must not end the control connection.
  await b.app.stopWork();
  b.doc.hidden = true; b.doc.dispatch('visibilitychange'); await tick();
  b.doc.hidden = false; b.doc.dispatch('visibilitychange'); await tick();
  b.win.dispatch('pagehide', { persisted: true }); await tick();
  assert.equal(socket.readyState, 1, 'the control socket survives stopWork, visibility changes and bfcache');
  assert.equal(socket.closeCalls, 0);
  assert.equal(b.sockets.length, 1);
  // A repeated snapshot is the heartbeat: nothing changes, nothing is released.
  socket.json(snapshot()); await tick();
  assert.equal(b.app.hubControl.snapshot().revision, 13);
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED');
  // A lower revision is ignored even when it says "released".
  socket.json(releaseSnapshot({ revision: 12 })); await tick();
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED');
  // Release: a newer snapshot reopens the gate; nothing starts by itself.
  socket.json(releaseSnapshot()); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.equal(b.app.hubControl.snapshot().stopped, false);
  assert.equal(status.textContent, ko['hubControl.supported']);
  assert.equal(el(b, 'sim-control-revision').textContent, ko['hubControl.revision'].replace('{revision}', '14'));
  assert.equal(el(b, 'sim-control-notice').hidden, true);
  assert.equal(b.sockets.length, 1, 'no automatic start');
  assert.throws(() => b.app.listenEngines.direct.start({ targetLanguage: 'ja' }), { code: 'CREDENTIAL_REQUIRED' }, 'the gate is open again');
  await until(() => !b.app.activity.occupied);
  quiet(b);
  assert.equal(leaks(domText(b.root)), false);
  assert.equal(leaks(b.app.hubControl.snapshot()), false);
});

test('heartbeat loss after the TTL blocks with HUB_CONTROL_LOST, keeps a stop latched and clears on the next snapshot', async (t) => {
  const b = await boot(t);
  joinFromScreen(b);
  const socket = await opened(b, 0);
  socket.json(controlHello()); socket.json(releaseSnapshot({ revision: 1, ttlSeconds: 30 }));
  await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
  b.clock.advance(29999); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
  b.clock.advance(1); await tick();
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_LOST');
  assert.equal(el(b, 'sim-control-status').textContent, ko['hubControl.lost']);
  assert.equal(socket.readyState, 1);
  socket.json(releaseSnapshot({ revision: 1, ttlSeconds: 30 })); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null, 'the heartbeat itself clears a lost heartbeat');
  // A stop stays latched through a lost heartbeat.
  socket.json(snapshot({ revision: 2, ttlSeconds: 10 })); await tick();
  b.clock.advance(10000); await tick();
  assert.equal(b.app.hubControl.snapshot().heartbeatLost, true);
  assert.equal(b.app.hubControl.snapshot().stopped, true);
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED');
  assert.equal(el(b, 'sim-control-status').textContent, ko['hubControl.stopped']);
  // A connection that ends without a successor is a lost heartbeat too, never a release.
  socket.finishClose(1006); await tick();
  b.clock.advance(8000); await tick();
  const next = b.sockets[1];
  assert.ok(next, 'the audience client reconnects');
  next.open();
  assert.deepEqual(next.sent, [negotiation(EPOCH, 2)], 'a reconnect carries the accepted epoch and revision');
  next.json(controlHello()); await tick();
  assert.equal(b.app.hubControl.snapshot().stopped, true, 'renegotiation does not release');
  assert.equal(b.app.hubControl.snapshot().revision, 2);
  next.json(releaseSnapshot({ revision: 3 })); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
});

test('a stop received while a direct session runs ends the session through the existing cleanup and keeps the control socket', async (t) => {
  const b = await boot(t);
  enterKey(b);
  joinFromScreen(b);
  const control = await opened(b, 0);
  control.json(controlHello()); control.json(releaseSnapshot({ revision: 1 }));
  await tick();
  const { handle, socket: live } = await runDirect(b, 1);
  assert.equal(b.app.activity.occupied, true);
  control.json(snapshot({ revision: 2 }));
  await handle.done;
  await until(() => !b.app.activity.occupied);
  await until(() => live.readyState === 3);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'stopped');
  assert.equal(notice(b), 'policy.changed.stopped');
  assert.equal(control.readyState, 1, 'the control connection outlives the audio work');
  assert.equal(control.closeCalls, 0);
  assert.equal(b.app.config.sessionManager.occupied, false);
  control.json(releaseSnapshot({ revision: 3 })); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.equal(b.sockets.length, 2, 'no automatic resume after the release');
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'stopped');
  assert.equal(notice(b), 'policy.changed.reopened');
});

test('leaving the event closes the control connection, clears the control state and the joined event, and allows a new join', async (t) => {
  const b = await boot(t);
  joinFromScreen(b);
  const socket = await opened(b, 0);
  socket.json(controlHello()); socket.json(snapshot());
  await tick();
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED');
  el(b, 'sim-event-leave').dispatch('click');
  await until(() => socket.readyState === 3);
  await until(() => b.app.eventLink.snapshot().connection === 'idle');
  assert.equal(b.app.eventLink.snapshot().joined, null);
  assert.equal(b.app.policy.snapshot().hubControl, null);
  assert.equal(b.app.policy.snapshot().eventId, null);
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.deepEqual(b.app.hubControl.snapshot(), { supported: null, eventId: null, epoch: null, revision: null, stopped: false,
    disabledFeatures: [], notice: null, heartbeatLost: false, expiresAt: null });
  assert.equal(notice(b), 'event.left');
  assert.equal(el(b, 'sim-control-status').hidden, true);
  assert.equal(el(b, 'sim-event-join').hidden, false);
  assert.equal(el(b, 'sim-event-leave').hidden, true);
  // Late frames on the old socket change nothing.
  socket.json(releaseSnapshot({ revision: 99 })); await tick();
  assert.equal(b.app.hubControl.snapshot().revision, null);
  joinFromScreen(b);
  const next = await opened(b, 1);
  assert.deepEqual(next.sent, [negotiation(HUB_CONTROL_INITIAL_EPOCH, 0)], 'a fresh join starts a fresh negotiation');
  assert.equal(b.sockets.length, 2);
});

test('a hub without the extension shows "live control not supported" and listening or direct start stays possible', async (t) => {
  const b = await boot(t);
  joinFromScreen(b);
  const socket = await opened(b, 0);
  socket.json(hello());
  await tick();
  assert.equal(b.app.hubControl.snapshot().supported, false);
  assert.equal(el(b, 'sim-control-status').textContent, ko['hubControl.unsupported']);
  assert.equal(el(b, 'sim-control-status').getAttribute('data-control'), 'unsupported');
  assert.equal(textOf(b, 'hubControl.unsupportedHint').hidden, false);
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.equal(b.app.policy.snapshot().hubControl.supported, false);
  b.app.policy.assertAction('sim.direct');
  b.app.policy.assertAction('hub.join');
  // A snapshot from a hub that did not negotiate is not applied.
  socket.json(snapshot()); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.equal(b.app.hubControl.snapshot().stopped, false);
  // A hello for another event is not this event's control either.
  socket.finishClose(1006); await tick(); b.clock.advance(8000); await tick();
  const next = b.sockets[1]; next.open(); next.json(controlHello({ eventId: 'other-event' })); await tick();
  assert.equal(b.app.hubControl.snapshot().supported, false);
  assert.equal(textOf(b, 'hubControl.unsupportedHint').hidden, false);
  assert.equal(leaks(domText(b.root)), false);
});

test('hub listening reuses its socket for control: the control-only connection is suspended, a stop ends listening, and the control connection resumes for the release', async (t) => {
  const b = await boot(t);
  joinFromScreen(b);
  const first = await opened(b, 0);
  first.json(controlHello()); first.json(releaseSnapshot({ revision: 5 }));
  await tick();
  choose(el(b, 'sim-mode'), 'hub');
  await until(() => el(b, 'sim-mode').value === 'hub');
  assert.equal(el(b, 'sim-control').hidden, false, 'the control state stays visible in hub mode');
  assert.equal(textOf(b, 'hubControl.controlOnly').hidden, true);
  const handle = b.app.listenEngines.hub.join({ hubId: HUB_ID, roomCode: ROOM, language: 'ja' });
  const listen = await opened(b, 1);
  await until(() => first.readyState === 3);
  assert.deepEqual(listen.sent, [negotiation(EPOCH, 5)], 'the listening socket carries the negotiation');
  listen.json(controlHello());
  await handle.ready;
  assert.equal(b.app.listenEngines.hub.snapshot().status, 'running');
  assert.equal(b.app.hubControl.snapshot().supported, true);
  assert.equal(b.app.hubControl.snapshot().revision, 5);
  assert.equal(b.sockets.length, 2, 'one connection to the hub');
  assert.equal(el(b, 'sim-control-status').textContent, ko['hubControl.supported']);
  // Captions still flow on the shared socket (muted until a gesture, so no speech).
  listen.json({ type: 'cast.caption', lang: 'ja', segmentId: 's1', seq: 1, revision: 1, text: '字幕', final: true });
  await until(() => b.app.listenEngines.hub.snapshot().translations.length === 1);
  // Stop: listening ends, the listening socket closes, the control-only connection takes over.
  listen.json(snapshot({ revision: 6 }));
  await handle.done;
  await until(() => !b.app.activity.occupied);
  await until(() => listen.readyState === 3);
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED');
  assert.equal(notice(b), 'policy.changed.stopped');
  const resumed = await opened(b, 2);
  assert.deepEqual(resumed.sent, [negotiation(EPOCH, 6)]);
  resumed.json(controlHello()); resumed.json(snapshot({ revision: 6 }));
  await tick();
  assert.equal(b.app.hubControl.snapshot().heartbeatLost, false);
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED', 'the heartbeat keeps the stop');
  assert.throws(() => b.app.listenEngines.hub.join({ hubId: HUB_ID, roomCode: ROOM, language: 'ja' }), { code: 'HUB_CONTROL_STOPPED' });
  await until(() => !b.app.activity.occupied);
  resumed.json(releaseSnapshot({ revision: 7 })); await tick();
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.equal(b.sockets.length, 3, 'listening is not rejoined automatically');
  assert.equal(b.app.listenEngines.hub.snapshot().status, 'stopped');
  b.app.policy.assertAction('hub.join');
  assert.equal(b.speech.utterances.length, 0);
  assert.equal(b.gemini.calls.length, 0);
});

test('an event that leaves the policy list is left automatically and its control connection is closed', async (t) => {
  let current = controlPolicy();
  const b = await boot(t, { policy: () => current });
  joinFromScreen(b);
  const socket = await opened(b, 0);
  socket.json(controlHello()); socket.json(snapshot());
  await tick();
  assert.equal(b.app.policy.snapshot().blocked.code, 'HUB_CONTROL_STOPPED');
  current = controlPolicy((policy) => { policy.revision = 2; policy.sharedEvents = []; });
  await b.app.policy.refresh({ reason: 'manual' });
  await until(() => b.app.eventLink.snapshot().joined === null);
  await until(() => socket.readyState === 3);
  assert.equal(b.app.policy.snapshot().hubControl, null);
  assert.equal(b.app.policy.snapshot().eventId, null);
  assert.equal(b.app.policy.snapshot().blocked, null);
  assert.equal(el(b, 'sim-event-none').hidden, false);
  assert.equal(el(b, 'sim-event-join').hidden, true);
  assert.equal(el(b, 'sim-venue').parentNode.hidden, true, 'nothing to join: venue and room are hidden in direct mode');
  assert.equal(b.sockets.length, 1);
});

test('policy gating: disabled hub control hides the section, a hub outside allowedHubIds and an inactive event are refused, direct subscription can be withheld', async (t) => {
  const off = createBrowser({ policy: controlPolicy((policy) => { policy.hubControl = { enabled: false, allowedHubIds: [HUB_ID], allowDirectSubscription: false }; }) });
  off.app = await startApp({ window: off.win, hubs: testHubs });
  t.after(() => off.app.close());
  await off.app.shell.switchTab('simultaneous');
  assert.equal(el(off, 'sim-control').hidden, true);
  assert.equal(el(off, 'sim-venue').parentNode.hidden, true);
  assert.throws(() => off.app.eventLink.join({ eventId: EVENT_ID, hubId: HUB_ID, roomCode: ROOM }), { code: 'POLICY_FEATURE_DISABLED' });
  await tick();
  assert.equal(notice(off), 'error.POLICY_FEATURE_DISABLED');
  assert.equal(off.sockets.length, 0);

  const b = await boot(t, { policy: controlPolicy((policy) => {
    policy.sharedEvents.push(activeEvent({ id: 'service-20260913', eventName: '2026-09-13', enabled: false }));
    policy.hubControl.allowDirectSubscription = false;
  }) });
  assert.equal(el(b, 'sim-event').children.length, 2);
  assert.equal(el(b, 'sim-event').children[1].disabled, true, 'only active events can be chosen');
  assert.throws(() => b.app.eventLink.join({ eventId: EVENT_ID, hubId: 'other', roomCode: ROOM }), { code: 'HUB_REQUIRED' });
  assert.throws(() => b.app.eventLink.join({ eventId: 'service-20260913', hubId: HUB_ID, roomCode: ROOM }), { code: 'EVENT_ENDED' });
  assert.throws(() => b.app.eventLink.join({ eventId: EVENT_ID, hubId: HUB_ID, roomCode: 'a&role=source' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => b.app.eventLink.join({ eventId: 'SECRET EVENT', hubId: HUB_ID, roomCode: ROOM }), { code: 'INVALID_REQUEST' });
  assert.equal(b.app.eventLink.snapshot().joined, null);
  assert.equal(b.app.policy.snapshot().eventId, null);
  // The screen names a refused join by its code.
  el(b, 'sim-event').value = 'service-20260913'; el(b, 'sim-venue').value = HUB_ID; el(b, 'sim-room').value = ROOM;
  el(b, 'sim-event-join').dispatch('click');
  assert.equal(el(b, 'sim-event-error').textContent, ko['error.EVENT_ENDED']);
  assert.equal(el(b, 'sim-event-error').hidden, false);
  // Direct subscription withheld: the event is joined, no control-only connection opens.
  joinFromScreen(b);
  await tick(); await tick();
  assert.deepEqual(b.app.eventLink.snapshot().joined, { eventId: EVENT_ID, hubId: HUB_ID });
  assert.equal(b.sockets.length, 0);
  assert.equal(el(b, 'sim-event-error').hidden, true);
  assert.equal(b.app.eventLink.snapshot().connection, 'idle');
  // The hub listening socket still negotiates for the joined event.
  const handle = b.app.listenEngines.hub.join({ hubId: HUB_ID, roomCode: ROOM, language: 'ja' });
  const listen = await opened(b, 0);
  assert.deepEqual(listen.sent, [negotiation(HUB_CONTROL_INITIAL_EPOCH, 0)]);
  listen.json(controlHello()); await handle.ready;
  assert.equal(b.app.hubControl.snapshot().supported, true);
  await b.app.listenEngines.hub.leave();
  await until(() => !b.app.activity.occupied);
  await tick(); await tick();
  assert.equal(b.sockets.length, 1, 'no control-only connection without allowDirectSubscription');
  assert.throws(() => b.app.eventLink.join({ eventId: EVENT_ID, hubId: HUB_ID, roomCode: ROOM }), { code: 'SESSION_LIMIT' });
  assert.equal(leaks(domText(b.root)), false);
});

test('teardown closes the control connection and leaves no listeners; the joined event never reaches storage', async (t) => {
  const b = createBrowser({ policy: controlPolicy() });
  b.app = await startApp({ window: b.win, hubs: testHubs });
  assert.ok(b.app);
  await b.app.shell.switchTab('simultaneous');
  await until(() => el(b, 'sim-control').hidden === false, 50);
  joinFromScreen(b);
  const socket = await opened(b, 0);
  socket.json(controlHello()); socket.json(snapshot());
  await tick();
  assert.equal(b.ops.filter((op) => op.startsWith('storage.set')).length, 0, 'nothing is persisted');
  b.win.dispatch('pagehide', { persisted: false });
  await b.app.close();
  await until(() => socket.readyState === 3);
  assert.equal(socket.listenerCount, 0);
  assert.equal(b.win.listenerCount, 0);
  assert.equal(b.doc.listenerCount, 0);
  assert.equal(b.root.childNodes.length, 0);
  assert.equal(leaks(b.ops), false);
});
