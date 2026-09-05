import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../app/engine/session-manager.js';
import { deferred, context } from './fixtures/providers.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const session = (close = async () => {}) => ({ close, async speak() {}, async cancel() {} });
const code = (value) => (error) => error.code === value;

test('all managers/providers serialize Live opens and wait for confirmed closure', async () => {
  const first = createSessionManager();
  const second = createSessionManager();
  const closed = deferred();
  let active = 0;
  let maximum = 0;
  const open = async (close) => {
    active++; maximum = Math.max(maximum, active);
    return session(async () => { await close(); active--; });
  };
  const a = await first.replace(() => open(() => closed.promise), context());
  let opened = false;
  const b = second.replace(() => { opened = true; return open(async () => {}); }, context({ providerId: 'beta' }));
  await tick(); assert.equal(opened, false);
  closed.resolve();
  const lease = await b;
  assert.equal(maximum, 1);
  assert.equal(first.isCurrent(a.generation), false);
  await assert.rejects(a.speak('old'), code('SESSION_CLOSED'));
  await lease.close(); assert.equal(active, 0);
});

test('abort closes late opens, suppresses stale events, and releases slot only after cleanup', async () => {
  const manager = createSessionManager({ timeoutMs: 30 });
  const pending = deferred();
  const controller = new AbortController();
  let ctx, closed = 0, events = 0;
  const opening = manager.replace((value) => { ctx = value; return pending.promise; }, context({ signal: controller.signal, onEvent() { events++; } }));
  await tick();
  controller.abort('SECRET');
  await assert.rejects(opening, code('ABORTED'));
  ctx.onEvent({ type: 'audio' }); assert.equal(events, 0);
  assert.equal(manager.occupied, true);
  pending.resolve(session(async () => { closed++; }));
  await manager.close();
  assert.equal(closed, 1); assert.equal(manager.occupied, false);
});

test('opening timeout blocks replacement until late socket closes', async () => {
  const manager = createSessionManager({ timeoutMs: 5 });
  const pending = deferred();
  await assert.rejects(manager.replace(() => pending.promise, context()), code('TIMEOUT'));
  let opened = 0;
  await assert.rejects(manager.replace(() => { opened++; return session(); }, context()), code('TIMEOUT'));
  assert.equal(opened, 0);
  pending.resolve(session());
  await manager.close();
  assert.equal(manager.occupied, false);
});

test('voice text errors are sanitized, terminate session, and never resend', async () => {
  const manager = createSessionManager();
  let speaks = 0, closes = 0;
  const lease = await manager.replace(async () => ({ ...session(async () => { closes++; }),
    async speak() { speaks++; throw new Error('SECRET'); } }), context());
  await assert.rejects(lease.speak('text'), (e) => e.code === 'PROVIDER_ERROR' && !JSON.stringify(e).includes('SECRET'));
  await manager.close();
  assert.equal(speaks, 1); assert.equal(closes, 1);
});

test('queued cancelled replacement never opens; close cancels an in-flight open', async () => {
  const manager = createSessionManager();
  const pending = deferred();
  const opening = manager.replace(() => pending.promise, context());
  await tick();
  const cancelled = manager.replace(() => { assert.fail(); }, context({ signal: AbortSignal.abort() }));
  const rejected = assert.rejects(cancelled, code('ABORTED'));
  const closing = manager.close();
  await assert.rejects(opening, code('ABORTED'));
  pending.resolve(session());
  await closing; await rejected;
});

test('failed close permanently blocks new sockets even through another manager', async () => {
  const { createSessionManager: isolated } = await import('../app/engine/session-manager.js?failed-close');
  const manager = isolated();
  const lease = await manager.replace(async () => session(async () => { throw new Error('SECRET'); }), context());
  await assert.rejects(lease.close(), code('PROVIDER_ERROR'));
  await assert.rejects(isolated().replace(() => { assert.fail(); }, context()), code('PROVIDER_ERROR'));
  assert.equal(manager.occupied, true);
});


test('replacement immediately retires events while old close is pending', async () => {
  const manager = createSessionManager();
  const closed = deferred(); let ctx, events = 0;
  await manager.replace(value => { ctx = value; return session(() => closed.promise); }, context({ onEvent() { events++; } }));
  const next = manager.replace(() => session(), context());
  ctx.onEvent({ type: 'audio' });
  assert.equal(events, 0); assert.equal(ctx.signal.aborted, true);
  closed.resolve(); await (await next).close();
});

test('remote closed stays SESSION_CLOSED; user abort stays ABORTED', async () => {
  for (const remote of [true, false]) {
    const manager = createSessionManager(); const controller = new AbortController();
    let ctx, events = 0;
    const lease = await manager.replace(value => { ctx = value; return { ...session(), speak: () => new Promise(() => {}) }; }, context({ signal: controller.signal, onEvent() { events++; } }));
    const speaking = lease.speak('text');
    await tick();
    if (remote) ctx.onEvent({ type: 'closed' }); else controller.abort();
    await assert.rejects(speaking, code(remote ? 'SESSION_CLOSED' : 'ABORTED'));
    ctx.onEvent({ type: 'closed' }); ctx.onEvent({ type: 'audio' });
    assert.equal(events, remote ? 1 : 0);
    await manager.close();
  }
});

test('subscription may close during reservation without an uninitialized opening promise', async () => {
  const manager = createSessionManager(); let closing;
  const unsubscribe = manager.subscribe(state => { if (state.active) closing = manager.close(); });
  await assert.rejects(manager.replace(() => session(), context()), code('ABORTED'));
  await closing; unsubscribe(); assert.equal(manager.occupied, false);
});
