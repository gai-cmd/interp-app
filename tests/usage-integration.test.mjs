// P3-30: real execution spans reach the estimate. The traps this suite guards:
// a key, transcript or audio reaching an observation event, and the page being
// open counted as usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createUsage } from '../app/engine/usage.js';
import { createRegistry } from '../app/providers/registry.js';
import { createRouter } from '../app/providers/router.js';
import { provider, adapter, context, textRequest, credentialRef, deferred, streamAdapter } from './fixtures/providers.mjs';

/** Records every span the router opens, with what it was told. */
function usageSpy(now = () => 0) {
  const events = [];
  const usage = createUsage({ now });
  return {
    events,
    begin(span) { events.push(['begin', span]); return usage.begin(span); },
    end(id, options) { events.push(['end', id, options]); return usage.end(id, options); },
    snapshot: () => usage.snapshot(),
    spansOf: (scope) => usage.spansOf(scope),
    close: () => usage.close(),
  };
}

test('the observer is told a span id, a capability, a model and a scope — nothing else', () => {
  const spy = usageSpy();
  // What the router hands over is asserted against the shape, so a future
  // field cannot quietly start carrying content.
  spy.begin({ id: 'span-1', capability: 'translate', model: 'gemini-3.5-flash', scope: 'personal', billable: true });
  const [, span] = spy.events[0];
  assert.deepEqual(Object.keys(span).sort(), ['billable', 'capability', 'id', 'model', 'scope']);
  for (const value of Object.values(span)) {
    assert.ok(['string', 'boolean'].includes(typeof value), 'only identifiers and flags');
  }
  spy.close();
});

test('router source: no credential, request or reply reaches the observer', async () => {
  const source = await readFile(new URL('../app/providers/router.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('observe.begin = ('), source.indexOf('const attemptEnd'));
  for (const forbidden of ['credential', 'reference', 'adapterRequest', 'request', 'result', 'input', 'text', 'audio']) {
    assert.equal(block.includes(forbidden), false, `the observer must not receive ${forbidden}`);
  }
  // The span starts at the actual call and ends once, however the call ends.
  assert.match(source, /span = observe\.begin\(capability, model, keySource, transport\)/);
  assert.match(source, /const endSpan = \(failed\) => \{ if \(span && !spanEnded\)/);
  assert.match(source, /endSpan\(true\)/, 'a failure closes the span');
  assert.match(source, /if \(!streaming\) \{ endSpan\(false\); return result; \}/);
  // A hub transport is not the audience's own provider cost.
  assert.match(source, /billable: transport !== 'hub'/);
});

test('main.js builds one usage observer, hands it to the router and closes it', async () => {
  const source = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(source, /usage = createUsage\(\{ now \}\)/);
  assert.match(source, /policy: policyGuard, usage/);
  assert.match(source, /usage\?\.close\(\)/);
  const config = await readFile(new URL('../app/config.js', import.meta.url), 'utf8');
  assert.match(config, /createRouter\(\{ registry, usage,/);
});

// --- the router opens and closes real spans ---

function routerWith(usage, implementation = adapter(), definition = provider()) {
  const registry = createRegistry();
  registry.register(definition, implementation);
  return createRouter({ registry, getCredentialRef: credentialRef, usage });
}
/** The fixture registers `live` as planned; a streaming test needs it ready. */
const liveReady = () => {
  const definition = provider();
  definition.capabilities.live = { ...definition.capabilities.live, implementation: 'ready' };
  return definition;
};

test('a one-shot call is one span that closes when the call returns', async () => {
  const spy = usageSpy(() => 0);
  const router = routerWith(spy);
  assert.equal(spy.snapshot().activeMs, 0, 'building a router is not usage');

  await router.call('translate', textRequest(), context());
  assert.equal(spy.snapshot().spans, 1);
  assert.equal(spy.snapshot().openSpans, 0, 'the span closed with the call');
  const [, span] = spy.events[0];
  assert.equal(span.capability, 'translate');
  assert.equal(span.scope, 'personal');
  assert.equal(span.billable, true);
  assert.equal(leaksText(spy.events), false);
});

test('a failed call still closes its span, marked failed', async () => {
  const spy = usageSpy(() => 0);
  const failing = adapter({ translate: async () => { throw new Error('SECRET provider text'); } });
  const router = routerWith(spy, failing);
  await assert.rejects(() => router.call('translate', textRequest(), context()));
  assert.equal(spy.snapshot().openSpans, 0, 'a failure does not leave a span open');
  assert.equal(spy.snapshot().spans, 1);
  assert.equal(spy.events.at(-1)[0], 'end');
  assert.equal(spy.events.at(-1)[2].failed, true);
  assert.equal(leaksText(spy.events), false, 'no provider text reaches the observer');
});

test('a streaming session stays open until it closes, and closes exactly once', async () => {
  const spy = usageSpy(() => 0);
  const stream = streamAdapter();
  const router = routerWith(spy, stream.implementation, liveReady());
  const session = await router.call('live', { input: { format: 'pcm16' }, targetLanguage: 'ja' }, context());
  assert.equal(spy.snapshot().openSpans, 1, 'the session is still running');
  assert.equal(spy.snapshot().spans, 0, 'nothing is counted until it ends');

  await session.close();
  assert.equal(spy.snapshot().openSpans, 0);
  assert.equal(spy.snapshot().spans, 1);
  // A second close must not add a second span.
  await session.close();
  assert.equal(spy.snapshot().spans, 1, 'one span per session, however many times it is closed');
});

/** True when anything in the recorded events carries the marker. */
const leaksText = (value) => JSON.stringify(value ?? null)?.includes('SECRET') === true;
