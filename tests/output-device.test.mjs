// P3-27: routing PCM playback to a chosen output device (design-p3 §1.14).
// The traps this suite exists for: claiming support from HTMLMediaElement,
// claiming success before the browser confirmed it, and implying device speech
// follows the choice when it has no sink at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OUTPUT_ERRORS, OUTPUT_STATES, classifySinkError, createOutputDevice,
  supportsOutputSelection } from '../app/audio/output-device.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function contextDouble({ supported = true } = {}) {
  const calls = [];
  const gates = [];
  const context = { state: 'running', calls, gates };
  if (supported) {
    context.setSinkId = (id) => { calls.push(id); const gate = deferred(); gates.push(gate); return gate.promise; };
  }
  return context;
}
const named = (name) => Object.assign(new Error('nope'), { name });

test('support is read from the AudioContext, never from a media element', () => {
  assert.equal(supportsOutputSelection(contextDouble()), true);
  assert.equal(supportsOutputSelection(contextDouble({ supported: false })), false);
  assert.equal(supportsOutputSelection(null), false);
  // An element that can route is not evidence that the context can.
  assert.equal(supportsOutputSelection({ setSinkId: undefined, srcObject: null }), false);
  assert.deepEqual([...OUTPUT_STATES], ['unsupported', 'system', 'applying', 'applied', 'failed']);
  assert.deepEqual([...OUTPUT_ERRORS], ['unsupported', 'denied', 'notFound', 'unknown']);
});

test('nothing is reported as applied until the browser confirms it', async () => {
  const context = contextDouble();
  const device = createOutputDevice({ getAudioContext: () => context });
  const seen = [];
  device.subscribe((value) => seen.push(value.state));

  const pending = device.select('speaker-2');
  assert.deepEqual(context.calls, ['speaker-2']);
  assert.equal(device.snapshot().state, 'applying', 'in flight is not success');
  assert.equal(device.snapshot().applied, null, 'nothing is applied yet');

  context.gates[0].resolve();
  await pending;
  assert.equal(device.snapshot().state, 'applied');
  assert.equal(device.snapshot().applied, 'speaker-2');
  assert.equal(device.snapshot().error, null);
  assert.deepEqual(seen, ['applying', 'applied']);
  device.destroy();
});

test('a refusal or a vanished device is named and never becomes success', async () => {
  for (const [name, code] of [['NotAllowedError', 'denied'], ['SecurityError', 'denied'],
    ['NotFoundError', 'notFound'], ['OverconstrainedError', 'notFound'], ['TypeError', 'unknown']]) {
    const context = contextDouble();
    const device = createOutputDevice({ getAudioContext: () => context });
    const pending = device.select('speaker-2');
    context.gates[0].reject(named(name));
    await pending;
    assert.equal(device.snapshot().state, 'failed', name);
    assert.equal(device.snapshot().error, code, name);
    assert.equal(device.snapshot().applied, null, 'a failure applies nothing');
    assert.ok(device.snapshot().messageKey, 'the failure has a dictionary key');
    assert.equal(classifySinkError(named(name)), code);
    device.destroy();
  }
  assert.equal(classifySinkError(null), 'unknown');
  assert.equal(classifySinkError('string'), 'unknown');
});

test('a late completion of a superseded switch is dropped, not reported', async () => {
  const context = contextDouble();
  const device = createOutputDevice({ getAudioContext: () => context });
  const first = device.select('speaker-2');
  const second = device.select('speaker-3');
  assert.deepEqual(context.calls, ['speaker-2', 'speaker-3']);

  // The newer one lands first, then the older one completes.
  context.gates[1].resolve();
  await second;
  assert.equal(device.snapshot().applied, 'speaker-3');
  context.gates[0].resolve();
  await first;
  assert.equal(device.snapshot().applied, 'speaker-3', 'the stale result did not overwrite the newer one');
  assert.equal(device.snapshot().state, 'applied');

  // A result arriving after destroy() changes nothing either.
  const late = device.select('speaker-4');
  device.destroy();
  context.gates[2].resolve();
  await late;
  assert.equal(device.snapshot().applied, 'speaker-3');
});

test('an unsupported browser stays on the system output and says so without failing', async () => {
  const context = contextDouble({ supported: false });
  const device = createOutputDevice({ getAudioContext: () => context });
  await device.select('speaker-2');
  const state = device.snapshot();
  assert.equal(state.state, 'unsupported');
  assert.equal(state.supported, false);
  assert.equal(state.applied, null);
  assert.equal(state.messageKey, 'device.outputUnsupported');
  // Asking for the system default on such a browser is not an error at all.
  await device.select(null);
  assert.equal(device.snapshot().error, null);
  device.destroy();
});

test('the system default is requested as the empty sink, and pseudo ids mean the system', async () => {
  const context = contextDouble();
  const device = createOutputDevice({ getAudioContext: () => context });
  const back = device.select(null);
  context.gates[0].resolve();
  await back;
  assert.deepEqual(context.calls, ['']);
  assert.equal(device.snapshot().state, 'system');
  assert.equal(device.snapshot().applied, null);
  for (const pseudo of ['', 'default', 'communications']) {
    const pending = device.select(pseudo);
    context.gates.at(-1).resolve();
    await pending;
    assert.equal(device.snapshot().deviceId, null, `${pseudo} is the system default`);
  }
  device.destroy();
});

test('a context created later starts on the chosen sink before anything plays', async () => {
  let context = contextDouble();
  const device = createOutputDevice({ getAudioContext: () => context });
  const chosen = device.select('speaker-2');
  context.gates[0].resolve();
  await chosen;

  // The context was closed and a new one made: apply() routes it first.
  context = contextDouble();
  const applied = device.apply(context);
  assert.deepEqual(context.calls, ['speaker-2'], 'the new context is routed immediately');
  context.gates[0].resolve();
  await applied;
  assert.equal(device.snapshot().applied, 'speaker-2');
  device.destroy();
});

test('device speech is never claimed to follow the choice', async () => {
  const source = await readFile(new URL('../app/audio/output-device.js', import.meta.url), 'utf8');
  // The module must not reach for speechSynthesis at all.
  assert.equal(/speechSynthesis|SpeechSynthesis/.test(source.replace(/\/\/.*$/gm, '')), false);
  // And the dictionary line that says so exists for the UI to show.
  const ko = JSON.parse(await readFile(new URL('../app/i18n/ko.json', import.meta.url), 'utf8'));
  assert.ok(ko['device.deviceSpeechSystemOutput']);
  // main.js routes a newly created context and tears the router down.
  const main = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /created && outputDevice/);
  assert.match(main, /outputDevice\.apply\(audioContext\)/);
  assert.match(main, /outputDevice\?\.destroy\(\)/);
  assert.throws(() => createOutputDevice({}), { message: 'INVALID_REQUEST' });
});
