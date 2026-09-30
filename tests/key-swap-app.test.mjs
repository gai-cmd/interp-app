// 2026-09-30 (owner: "무료키가 교체될때 타임러그를 최대한 줄여서 자연스럽게"):
// the app wiring of the built-in key swap, proven against the real app in the
// fake browser. Keys are assembled at runtime; nothing here is a real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TURN_PHASE } from '../app/state.js';
import { LIVE_ENDPOINT } from '../app/providers/gemini/live-client.js';
import { boot, byClass, captureConsole, leaks, live, rest, tick, until } from './fixtures/scenarios.mjs';

const siteKeys = (count) => Array.from({ length: count }, (_, i) => ['synthetic', 'site', 'key', String(i + 1)].join('-'));
const ownKey = () => ['synthetic', 'own', 'key'].join('-');
const socketKey = (url) => decodeURIComponent(url.slice(`${LIVE_ENDPOINT}?key=`.length));
const quota = (ws) => ws.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET quota text' } });

async function startListening(b) {
  const sockets = b.sockets.length;
  b.el('sim-start').dispatch('click');
  await until(() => b.audio.nodes.at(-1)?.port.onmessage);
  b.microphone.feed(new Float32Array(4096).fill(0.1));
  await until(() => b.sockets.length === sockets + 1);
  live.ready(b.sockets[sockets]);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'running');
  return b.sockets[sockets];
}

test('a pool rotation keeps the running session; a real key change still stops it', async t => {
  const captured = captureConsole(); t.after(captured.restore);
  const keys = siteKeys(2);
  const b = await boot({ builtinKey: () => keys });
  t.after(() => b.close());
  const ws = await startListening(b);
  const events = [];
  const off = b.app.config.keyStore.subscribe((event) => events.push(event.type)); t.after(off);
  assert.deepEqual(b.app.config.keyStore.rotateBuiltin('gemini'), { index: 1, count: 2 });
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(events, ['key-rotated']);
  assert.equal(ws.closeCalls, 0, 'the socket was not closed');
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'running');
  assert.equal(byClass(b.root, 'billing-key-changed').hidden, true, 'no "your key changed" note for a site-key swap');
  b.enterPersonalKey({ key: ownKey() });
  await until(() => !b.app.listenEngines.direct.snapshot().busy);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'stopped');
  assert.ok(ws.closeCalls >= 1, 'a key the person entered ends the session built on the old one');
  assert.equal(leaks({ logs: captured.calls }), false);
});

test('only the site key is swapped: the same 429 on a key the person entered ends the session', async t => {
  const keys = siteKeys(3);
  const b = await boot({ builtinKey: () => keys });
  t.after(() => b.close());
  const first = await startListening(b);
  quota(first);
  await until(() => b.sockets.length === 2);
  assert.equal(socketKey(b.socketURLs[1]), keys[1], 'the site key is swapped in the session');
  live.ready(b.sockets[1]);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'running');
  b.el('sim-stop').dispatch('click');
  await until(() => !b.app.listenEngines.direct.snapshot().busy);
  b.enterPersonalKey({ key: ownKey() });
  const own = await startListening(b);
  assert.equal(socketKey(b.socketURLs.at(-1)), ownKey());
  const sockets = b.sockets.length;
  quota(own);
  await until(() => b.app.listenEngines.direct.snapshot().status === 'failed');
  await until(() => !b.app.listenEngines.direct.snapshot().busy);
  b.clock.advance(10000); await tick();
  assert.equal(b.sockets.length, sockets, 'no other key, no restart');
  assert.equal(b.app.listenEngines.direct.snapshot().errorCode, 'UNKNOWN_429');
  assert.equal(byClass(b.root, 'sim-notice').getAttribute('data-failure'), 'UNKNOWN_429');
  b.app.config.keyStore.deleteKey('gemini', 'personal');
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal').builtinIndex, 1, 'the pool did not move for the own key');
});

test('an app restart more than 5 s after the last gesture captures with sticky activation, and fails without any', async t => {
  for (const hasBeenActive of [true, false]) {
    // One app at a time: the Live slot is shared by every app in this module graph.
    const b = await boot({ builtinKey: () => siteKeys(1) });
    try {
      await startListening(b);
      b.el('sim-stop').dispatch('click');
      await until(() => !b.app.listenEngines.direct.snapshot().busy);
      // The transient activation of the start press has lapsed; nothing was pressed since.
      b.win.navigator.userActivation.isActive = false;
      b.win.navigator.userActivation.hasBeenActive = hasBeenActive;
      b.clock.advance(6000); await tick();
      const nodes = b.audio.nodes.length, sockets = b.sockets.length;
      b.app.shell.simView.restart();
      if (hasBeenActive) {
        await until(() => b.audio.nodes.length > nodes && b.audio.nodes.at(-1)?.port.onmessage);
        b.microphone.feed(new Float32Array(4096).fill(0.1));
        await until(() => b.sockets.length === sockets + 1);
        live.ready(b.sockets.at(-1));
        await until(() => b.app.listenEngines.direct.snapshot().status === 'running');
      } else {
        await until(() => b.app.listenEngines.direct.snapshot().status === 'failed');
        assert.equal(b.app.listenEngines.direct.snapshot().errorCode, 'MICROPHONE_UNAVAILABLE');
        assert.equal(b.sockets.length, sockets);
      }
    } finally { await b.close(); }
  }
});

test('sequential: a 429 on the site key is sent again once, silently, on the spare key; an own key is not', async t => {
  const keys = siteKeys(3);
  const b = await boot({ builtinKey: () => keys });
  t.after(() => b.close());
  b.setVoiceOutput('off');
  const phases = [];
  const off = b.store.subscribe((snapshot) => { for (const turn of snapshot.turns) phases.push(turn.phase); }); t.after(off);
  // A per-minute 429 with a long server delay is not waited out on the spent key.
  b.gemini.script.push(rest.perMinute429(30), rest.translation());
  const turn = await b.submitText('사과 12개').done;
  assert.equal(turn.phase, TURN_PHASE.COMPLETED);
  assert.deepEqual(b.gemini.calls.map((call) => call.headers['x-goog-api-key']), [keys[0], keys[1]]);
  assert.equal(phases.includes(TURN_PHASE.ERROR), false, 'the failure never showed');
  assert.equal(b.clock.pending.some((ms) => ms >= 1000 && ms < 60000), false, 'no retry wait was armed');
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal').builtinIndex, 1);
  // Once per turn: the spare key failing too ends the turn (and the fallback moves the pool on for that second failure).
  b.gemini.script.push(rest.unknown429(), rest.unknown429());
  const twice = await b.submitText('사과 12개').done;
  assert.deepEqual([twice.phase, twice.errorCode], [TURN_PHASE.ERROR, 'UNKNOWN_429']);
  assert.deepEqual(b.gemini.calls.slice(2).map((call) => call.headers['x-goog-api-key']), [keys[1], keys[2]]);
  // The pool is spent now; later commits never rotate again for the old failed turn.
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal').builtinExhausted, true);
  // A key the person entered: one request, the ordinary failure, no swap.
  b.enterPersonalKey({ key: ownKey() });
  b.gemini.script.push(rest.unknown429());
  const own = await b.submitText('사과 12개').done;
  assert.deepEqual([own.phase, own.errorCode], [TURN_PHASE.ERROR, 'UNKNOWN_429']);
  assert.equal(b.gemini.calls.length, 5);
  assert.equal(b.gemini.calls[4].headers['x-goog-api-key'], ownKey());
});

test('sequential: recorded speech is retried on the spare key too, from the audio the turn already holds', async t => {
  const keys = siteKeys(2);
  const b = await boot({ builtinKey: () => keys });
  t.after(() => b.close());
  await b.app.shell.switchTab('sequential');
  b.setVoiceOutput('off');
  b.gemini.script.push(rest.unknown429(), rest.translation({ sourceText: '사과 12개' }));
  b.press();
  await until(() => b.audio.nodes.length === 1);
  const tone = new Float32Array(4800).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000));
  for (let i = 0; i < 10; i++) b.microphone.feed(tone);
  b.release();
  await b.idle();
  const [turn] = b.turns();
  assert.deepEqual([turn.input, turn.phase], ['voice', TURN_PHASE.COMPLETED]);
  assert.equal(b.gemini.calls.length, 2);
  assert.deepEqual(b.gemini.calls.map((call) => call.headers['x-goog-api-key']), keys);
  assert.equal(b.gemini.calls[0].body, b.gemini.calls[1].body, 'the same recorded audio, sent again');
});

test('a failure the swap could not cover rotates once: an old failed turn never moves the pool again', async t => {
  const keys = siteKeys(5);
  const b = await boot({ builtinKey: () => keys });
  t.after(() => b.close());
  b.setVoiceOutput('off');
  const events = [];
  const off = b.app.config.keyStore.subscribe((event) => events.push(event.type)); t.after(off);
  // Turn 1: key 1 fails, the swap retries on key 2, which fails too; the fallback moves to key 3.
  b.gemini.script.push(rest.unknown429(), rest.unknown429());
  assert.equal((await b.submitText('사과 12개').done).phase, TURN_PHASE.ERROR);
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal').builtinIndex, 2);
  // Turn 2: the same on keys 3 and 4; the fallback moves to key 5.
  b.gemini.script.push(rest.unknown429(), rest.unknown429());
  assert.equal((await b.submitText('사과 12개').done).phase, TURN_PHASE.ERROR);
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal').builtinIndex, 4);
  // Turn 3 succeeds; its many store commits must not re-rotate for turn 1 or 2.
  const done = await b.submitText('사과 12개').done;
  assert.equal(done.phase, TURN_PHASE.COMPLETED);
  assert.equal(b.gemini.calls.at(-1).headers['x-goog-api-key'], keys[4]);
  assert.deepEqual([b.app.config.keyStore.getMetadata('gemini', 'personal').builtinIndex,
    b.app.config.keyStore.getMetadata('gemini', 'personal').builtinExhausted], [4, false]);
  assert.equal(events.filter((type) => type === 'key-rotated').length, 4, 'one rotation per failure, four failures');
});
