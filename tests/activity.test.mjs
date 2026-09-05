import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity } from '../app/engine/activity.js';
import { createSessionManager } from '../app/engine/session-manager.js';
import { deferred, context } from './fixtures/providers.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const hooks = (extra = {}) => ({ cancel() {}, async close() {}, ...extra });
const code = expected => error => error.code === expected;

test('synchronous admission shares ownership across all managers and kinds', async () => {
  const a = createActivity(), b = createActivity();
  for (const kind of ['seq', 'sim', 'hub', 'diagnostics', 'preview']) {
    const lease = a.acquire(kind, hooks());
    assert.equal(b.occupied, true);
    for (const competitor of ['seq', 'sim', 'hub', 'diagnostics', 'preview']) {
      assert.throws(() => b.acquire(competitor, hooks()), code('SESSION_LIMIT'));
    }
    await assert.rejects(b.replace('diagnostics', hooks()), code('SESSION_LIMIT'));
    await assert.rejects(b.replace('preview', hooks()), code('SESSION_LIMIT'));
    assert.equal(lease.isCurrent(), true);
    await lease.close();
  }
});

test('transition invalidates before cancellation and waits for TTS and socket closure', async () => {
  const a = createActivity(), b = createActivity();
  const tts = deferred(), socket = deferred();
  let lease, cancelled = 0, closeStarted = false;
  lease = a.acquire('hub', hooks({ cancel() {
    cancelled++; assert.equal(lease.isCurrent(), false);
    assert.ok(a.generation > lease.generation); return tts.promise;
  }, close() { closeStarted = true; return socket.promise; } }));
  const next = b.replace('sim', hooks());
  assert.equal(cancelled, 1);
  assert.equal(lease.signal.aborted, true);
  await tick(); assert.equal(closeStarted, true);
  let acquired = false; next.then(() => { acquired = true; });
  socket.resolve(); await tick(); assert.equal(acquired, false);
  tts.resolve(); const live = await next;
  await lease.close(); assert.equal(live.isCurrent(), true);
  await live.close(); assert.equal(a.occupied, false);
});

test('concurrent replacements serialize and close cancels queued starts', async () => {
  const manager = createActivity();
  const old = manager.acquire('seq', hooks());
  const first = manager.replace('hub', hooks());
  const second = manager.replace('sim', hooks());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(old.isCurrent(), false); assert.equal(a.isCurrent(), false);
  assert.equal(b.isCurrent(), true);
  const pending = manager.replace('seq', hooks());
  const rejected = assert.rejects(pending, code('ABORTED'));
  await manager.close(); await rejected;
  assert.equal(manager.occupied, false);
});

test('hub TTS occupies app work without occupying provider Live slot', async () => {
  const activity = createActivity(), manager = createSessionManager();
  const hub = activity.acquire('hub', hooks());
  assert.equal(activity.occupied, true); assert.equal(manager.occupied, false);
  await hub.close();
  let live;
  const sim = activity.acquire('sim', hooks({ close: () => manager.close() }));
  live = await manager.replace(async () => ({ async close() {} }), context({ signal: sim.signal }));
  assert.equal(manager.occupied, true);
  await sim.close(); assert.equal(manager.occupied, false);
  assert.equal(manager.isCurrent(live.generation), false);
});

test('timeout retains ownership until late cleanup; cancellation rejects queued work', async () => {
  const manager = createActivity({ timeoutMs: 5 });
  const late = deferred();
  const lease = manager.acquire('hub', hooks({ close: () => late.promise }));
  await assert.rejects(lease.close(), code('TIMEOUT'));
  assert.equal(manager.occupied, true);
  await assert.rejects(manager.replace('sim', hooks()), code('TIMEOUT'));
  late.resolve(); await lease.close();
  const controller = new AbortController();
  const cancelled = manager.replace('seq', hooks({ signal: controller.signal }));
  controller.abort('SECRET');
  await assert.rejects(cancelled, code('ABORTED'));
  assert.equal(manager.occupied, false);
});

test('external abort suppresses events synchronously and observers expose no input data', async () => {
  const manager = createActivity(), controller = new AbortController(), states = [];
  const unsubscribe = manager.subscribe(state => states.push(state));
  const lease = manager.acquire('seq', hooks({ signal: controller.signal, secret: 'SECRET' }));
  controller.abort('SECRET');
  assert.equal(lease.isCurrent(), false);
  await lease.close(); unsubscribe();
  assert.equal(JSON.stringify(states).includes('SECRET'), false);
  assert.ok(states.every(Object.isFrozen));
});

test('permanent cleanup failures are isolated in a fresh module, never reset in production', async () => {
  for (const failure of ['cancel', 'close']) {
  const { createActivity: isolated } = await import(`../app/engine/activity.js?cleanup-failure-${failure}`);
  const manager = isolated(); let closed = 0;
  const lease = manager.acquire('hub', hooks({
    cancel() { if (failure === 'cancel') throw new Error('SECRET'); },
    close() { closed++; if (failure === 'close') throw new Error('SECRET'); },
  }));
  await assert.rejects(lease.close(), error => error.code === 'PROVIDER_ERROR' && !JSON.stringify(error).includes('SECRET'));
  assert.equal(closed, 1);
  await assert.rejects(isolated().replace('seq', hooks()), code('PROVIDER_ERROR'));
  assert.equal(manager.occupied, true);
  assert.equal(createActivity().occupied, false);
  }
});
