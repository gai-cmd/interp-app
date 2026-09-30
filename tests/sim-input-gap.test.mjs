import test from 'node:test';
import assert from 'node:assert/strict';
import { audioContent, content, simFixture, tick } from './fixtures/sim.mjs';

// 2026-09-30 (owner report): every session showed "some audio was not sent, so some captions may be missing" from its
// first second. The capture delivers frames before the first connection is ready; those frames were marked as an input
// gap, and the flag is sticky for the whole session. Input that arrives during the FIRST setup is not a gap in an
// interpretation (nothing was being interpreted yet); input lost while a running session reconnects still is.
const gaps = (f) => f.engine.snapshot().captions.gaps;

test('frames captured while the first connection is being set up mark NO input gap (fails before 2026-09-30)', async (t) => {
  const f = simFixture(); t.after(() => f.close());
  const handle = f.start();
  await tick();
  for (let count = 0; count < 12; count += 1) { f.frame(); await tick(); }   // about 0.4 s of input while connecting
  assert.equal(f.engine.snapshot().status, 'connecting');
  assert.deepEqual(gaps(f), { input: false, audio: false, reception: false });
  await f.open(); await handle.ready;
  assert.equal(f.engine.snapshot().status, 'running');
  for (let count = 0; count < 4; count += 1) { f.frame(); await tick(); }
  assert.deepEqual(gaps(f), { input: false, audio: false, reception: false }, 'a session that simply started shows no gap note');
});

test('input that arrives while a RUNNING session reconnects is still an input gap', async (t) => {
  const f = simFixture(); t.after(() => f.close());
  await f.running();
  assert.equal(gaps(f).input, false);
  f.sockets[0].json({ error: { code: 503 } });   // UNAVAILABLE: the engine replaces the connection
  for (let round = 0; round < 50 && f.engine.snapshot().status !== 'reconnecting'; round += 1) await tick();
  assert.equal(f.engine.snapshot().status, 'reconnecting');
  f.frame(); await tick();
  assert.equal(gaps(f).input, true, 'speech during the reconnect never reached the interpreter');
});

// The same day, the same kind of false note: with the interpreted voice muted (the extension's default, captions only)
// the player "drops" every chunk, and each drop was marked as an audio gap: "queued speech was skipped" for the whole
// session. Audio the person chose not to hear is not a gap.
test('a muted session marks NO audio gap for the audio it does not play (fails before 2026-09-30)', async (t) => {
  const f = simFixture(); t.after(() => f.close());
  await f.running({ muted: true });
  assert.equal(f.engine.snapshot().output, 'muted');
  for (let count = 0; count < 5; count += 1) content(f.sockets[0], audioContent);
  content(f.sockets[0], { outputTranscription: { text: '자막' }, turnComplete: true });
  await tick();
  assert.deepEqual(gaps(f), { input: false, audio: false, reception: false });
  assert.ok(f.engine.snapshot().captions.captions.some((row) => row.translatedText === '자막'), 'captions still arrive');
});

test('an unmuted session still marks an audio gap when queued speech is cut by an interruption', async (t) => {
  const f = simFixture(); t.after(() => f.close());
  await f.running();
  for (let count = 0; count < 5; count += 1) content(f.sockets[0], audioContent);
  await tick();
  assert.equal(gaps(f).audio, false);
  content(f.sockets[0], { interrupted: true });
  await tick();
  assert.equal(gaps(f).audio, true);
});

// Review findings of the same day, the same rule applied to the two remaining places.
test('a skipped audio part marks an audio gap only when the voice is on', async (t) => {
  const wrongRate = { modelTurn: { parts: [{ inlineData: { data: 'AQD/fw==', mimeType: 'audio/pcm;rate=16000' } }] } };
  const muted = simFixture(); t.after(() => muted.close());
  await muted.running({ muted: true });
  content(muted.sockets[0], wrongRate); await tick();
  assert.equal(gaps(muted).audio, false, 'nothing would have been played');
  assert.equal(muted.engine.snapshot().metrics.invalidResults['audio-mime'], 1, 'the skipped part is still counted');
  await muted.close();   // the Live slot is shared by every fixture in this realm
  const heard = simFixture(); t.after(() => heard.close());
  await heard.running();
  content(heard.sockets[0], wrongRate); await tick();
  assert.equal(gaps(heard).audio, true);
});

test('a first setup that fails and is retried marks NO reception gap; a connection lost while running does', async (t) => {
  const f = simFixture(); t.after(() => f.close());
  const handle = f.start();
  await tick(); f.frame(); await tick();
  f.sockets[0].open();
  f.sockets[0].json({ error: { code: 503 } });   // UNAVAILABLE before setupComplete: the engine tries again
  for (let round = 0; round < 50 && f.engine.snapshot().status !== 'reconnecting'; round += 1) await tick();
  assert.equal(f.engine.snapshot().status, 'reconnecting');
  assert.deepEqual(gaps(f), { input: false, audio: false, reception: false }, 'nothing had been received yet');
  for (let elapsed = 0; f.sockets.length === 1 && elapsed < 10000; elapsed += 250) { f.frame(); f.audio.advance(250); await tick(); }
  assert.equal(f.sockets.length, 2, 'the retry opened a second connection');
  await f.open(); await handle.ready;
  assert.equal(f.engine.snapshot().status, 'running');
  assert.deepEqual(gaps(f), { input: false, audio: false, reception: false });
  f.sockets[1].json({ error: { code: 503 } });
  for (let round = 0; round < 50 && f.engine.snapshot().status !== 'reconnecting'; round += 1) await tick();
  assert.equal(gaps(f).reception, true, 'captions of a running interpretation may be missing');
});
