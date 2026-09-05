import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubListenEngine } from '../app/engine/hub-listen.js';
import { createHubClient } from '../app/hub/client.js';
import { createSocketFixture, createClock, tick, hub, hello, caption } from './fixtures/hub-socket.mjs';

function fixture(options = {}) {
  const clock = createClock(), transport = createSocketFixture(options), spoken = [];
  const client = createHubClient({ hubs: [hub], ...transport, ...clock });
  const deviceTTS = { speak(request) { spoken.push(request); return Promise.resolve({ status: 'completed' }); }, cancel() {} };
  const engine = createHubListenEngine({ client, deviceTTS, ...clock });
  async function join() {
    const op = engine.join({ hubId: hub.id, roomCode: 'Test123', language: 'ja' });
    await tick(); transport.sockets.at(-1).open(); transport.sockets.at(-1).json(hello());
    await op.ready; return op;
  }
  return { ...transport, clock, spoken, engine, join };
}
const row = (seq, overrides = {}) => caption({ seq, segmentId: `s${seq}`, lang: 'ja', final: true, revision: 1, text: `text ${seq}`, ...overrides });

test('30 recent finals total across languages; separate source; muted until gesture', async () => {
  const f = fixture(); await f.join();
  assert.equal(f.engine.snapshot().broadcast, 'unknown');
  for (let n = 1; n <= 30; n++) f.sockets[0].json(row(n, { lang: ['ja', 'en', 'src'][n % 3] }));
  await tick();
  const s = f.engine.snapshot();
  assert.equal(s.captions.captions.length, 30);
  assert.equal(s.sources.length, 10); assert.equal(s.translations.length, 10);
  assert.equal(s.captions.gaps.reception, false); assert.equal(f.spoken.length, 0);
  f.engine.setMuted(false);
  f.sockets[0].json(row(3));
  f.sockets[0].json(row(3, { revision: 2, text: 'correction' }));
  f.sockets[0].json(row(31, { final: false }));
  await tick(); assert.equal(f.spoken.length, 0);
  f.sockets[0].json(row(31, { revision: 2 }));
  await tick(); assert.equal(f.spoken.length, 1);
  f.sockets[0].json(row(31, { revision: 3 }));
  f.sockets[0].json(row(32, { lang: 'src' }));
  await tick(); assert.equal(f.spoken.length, 1);
  await f.engine.close();
});

test('reconnect mutes, preserves deduplication, tolerates seq/ID reuse without claiming replay boundary', async () => {
  const f = fixture(); await f.join(); f.engine.setMuted(false);
  f.sockets[0].json(row(10)); await tick();
  f.sockets[0].finishClose(1006); await tick();
  assert.equal(f.engine.snapshot().output, 'muted');
  assert.equal(f.engine.snapshot().captions.gaps.reception, true);
  assert.equal(f.engine.setMuted(false), false);
  f.clock.advance(1000); await tick();
  const socket = f.sockets[1]; socket.open(); socket.json(hello());
  socket.json(row(10)); socket.json(row(1)); await tick();
  assert.equal(f.spoken.length, 1);
  f.engine.setMuted(false); socket.json(row(10, { revision: 2 }));
  socket.json(row(11)); await tick();
  assert.equal(f.spoken.length, 2);
  assert.equal(f.engine.snapshot().captions.captions.length, 2);
  await f.engine.close();
});

test('cast.stopped closes, never auto-rejoins, and explicit join creates fresh epoch', async () => {
  const f = fixture(); const op = await f.join();
  f.sockets[0].json(row(1)); f.sockets[0].json({ type: 'cast.stopped' });
  await op.done; await op.closed;
  assert.equal(f.engine.snapshot().status, 'stopped');
  assert.equal(f.engine.snapshot().broadcast, 'ended');
  f.clock.advance(10000); await tick(); assert.equal(f.sockets.length, 1);
  const old = f.engine.snapshot().captions.epoch;
  await f.join(); f.engine.setMuted(false); f.sockets[1].json(row(1)); await tick();
  assert.ok(f.engine.snapshot().captions.epoch > old); assert.equal(f.spoken.length, 1);
  await f.engine.close();
});

for (const message of [
  { type: 'settings', settings: { allowedLangs: ['en'], defaultLang: 'en' } },
  { type: 'closed' }, { type: 'outside' }, { type: 'denied' },
  { type: 'cast.status', lang: '*', state: 'fatal', detail: 'secret raw detail' },
]) test(`terminal ${message.type} clears output and ignores late captions`, async () => {
  const f = fixture(); const op = await f.join(); f.engine.setMuted(false);
  f.sockets[0].json(message); f.sockets[0].json(row(1));
  await op.done; await op.closed;
  assert.equal(f.engine.snapshot().busy, false);
  assert.equal(f.engine.snapshot().output, 'muted'); assert.equal(f.spoken.length, 0);
  assert.equal(JSON.stringify(f.engine.snapshot()).includes('secret raw detail'), false);
  await f.engine.close();
});

test('language change stops and requires manual join; muted finals never replay; bounded retention', async () => {
  const f = fixture(); await f.join();
  for (let n = 1; n <= 130; n++) { f.sockets[0].json(row(n)); }
  await tick(); assert.equal(f.engine.snapshot().captions.captions.length, 100);
  f.engine.setMuted(false); await tick(); assert.equal(f.spoken.length, 0);
  await f.engine.setLanguage('en'); await tick();
  assert.equal(f.engine.snapshot().status, 'stopped'); assert.equal(f.sockets.length, 1);
  await f.engine.leave(); await f.engine.close();
});

test('leave before hello invalidates callbacks and abort also shuts down', async () => {
  const f = fixture();
  const controller = new AbortController();
  const op = f.engine.join({ hubId: hub.id, roomCode: 'Test123' }, { signal: controller.signal });
  controller.abort(); await op.done; await op.closed;
  assert.equal((await op.ready).ready, false);
  assert.equal(f.engine.snapshot().status, 'stopped');
  await f.engine.close();
});

test('physical close timeout retains ownership until real close evidence', async () => {
  const f = fixture({ autoClose: false }); const op = await f.join();
  const leave = f.engine.leave(); await tick();
  f.clock.advance(5000); await tick(); await leave;
  assert.equal(f.engine.snapshot().status, 'failed');
  assert.equal(f.engine.snapshot().busy, true);
  assert.throws(() => f.engine.join({ hubId: hub.id, roomCode: 'Test123' }), { code: 'SESSION_LIMIT' });
  f.sockets[0].finishClose(); await op.closed;
  assert.equal(f.engine.snapshot().busy, false);
  await f.engine.close();
});

test('device speech failure does not stop captions and muted state discards old finals', async () => {
  const clock = createClock(), transport = createSocketFixture();
  const client = createHubClient({ hubs: [hub], ...transport, ...clock });
  let calls = 0;
  const engine = createHubListenEngine({ client, ...clock,
    deviceTTS: { speak() { calls++; throw new Error('private device failure'); }, cancel() {} } });
  const op = engine.join({ hubId: hub.id, roomCode: 'Test123' }); await tick();
  transport.sockets[0].json(hello()); await op.ready; engine.setMuted(false);
  transport.sockets[0].json(row(1)); await tick();
  assert.equal(engine.snapshot().output, 'unavailable');
  transport.sockets[0].json(row(2)); await tick();
  assert.equal(engine.snapshot().status, 'running');
  assert.equal(engine.snapshot().translations.length, 2); assert.equal(calls, 1);
  engine.setMuted(false); transport.sockets[0].json(row(2, { revision: 2 }));
  await tick(); assert.equal(calls, 1);
  await engine.close();
});
