import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMicrophonePermission, classifyMediaError, stopStream, permissionMessageKey, permissionHintKey,
  PERMISSION_STATES, PERMISSION_ERRORS, REQUEST_PURPOSES, DEFAULT_CONSTRAINTS } from '../app/audio/permissions.js';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { navigator, stream, mediaError, permissionStatus, deferred, settle, clock } from './fixtures/permissions.mjs';

const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async language =>
  [language, JSON.parse(await readFile(new URL(`../app/i18n/${language}.json`, import.meta.url), 'utf8'))])));

function service(options = {}) {
  const env = navigator(options);
  const time = clock();
  const events = [];
  const permission = createMicrophonePermission({ navigator: env.navigator, now: time.now });
  permission.subscribe(snapshot => events.push(snapshot));
  return { permission, env, time, events };
}

test('import and construction touch neither the Permissions API nor the microphone', () => {
  const { permission, env } = service({ permissions: 'granted', media: () => stream() });
  const snapshot = permission.snapshot();
  assert.equal(env.calls.length, 0);
  assert.equal(env.statuses.length, 0);
  assert.equal(snapshot.status, 'unsupported');
  assert.equal(snapshot.supported, null);
  assert.equal(snapshot.requesting, false);
  assert.equal(snapshot.messageKey, 'permission.unsupported');
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(permission));
  assert.deepEqual([...PERMISSION_STATES], ['granted', 'denied', 'prompt', 'unsupported']);
  assert.deepEqual([...PERMISSION_ERRORS], ['denied', 'noDevice', 'busy', 'unknown']);
  assert.deepEqual([...REQUEST_PURPOSES], ['probe', 'start']);
  assert.deepEqual(DEFAULT_CONSTRAINTS, { audio: true, video: false });
  assert.throws(() => permission.subscribe('nope'), /INVALID_REQUEST/);
});

test('every message and hint key the service emits exists in all three dictionaries', () => {
  const keys = new Set();
  for (const status of PERMISSION_STATES) for (const error of [null, ...PERMISSION_ERRORS]) for (const requesting of [false, true]) {
    keys.add(permissionMessageKey({ status, error, requesting }));
    const hint = permissionHintKey({ status, error });
    if (hint) keys.add(hint);
  }
  keys.add('error.ABORTED').add('error.MICROPHONE_DENIED').add('error.MICROPHONE_UNAVAILABLE');
  assert.ok(keys.size >= 10);
  for (const language of SUPPORTED_LANGUAGES) for (const key of keys) assert.ok(Object.hasOwn(dictionaries[language], key), `${language}: ${key}`);
  assert.equal(permissionMessageKey({ status: 'prompt', requesting: true }), 'permission.checking');
  assert.equal(permissionMessageKey({ status: 'granted', error: 'busy' }), 'permission.busy');
  assert.equal(permissionMessageKey({ status: 'bogus' }), 'permission.unsupported');
  assert.equal(permissionHintKey({ status: 'granted' }), null);
  assert.equal(permissionHintKey({ status: 'granted', error: 'noDevice' }), 'permission.noDeviceHint');
});

test('query with a supported Permissions API reports the browser state and subscribes to change once', async () => {
  const { permission, env, events, time } = service({ permissions: 'prompt' });
  const first = await permission.query();
  assert.equal(first.status, 'prompt');
  assert.equal(first.supported, true);
  assert.equal(first.queriedAt, time.now());
  assert.equal(first.messageKey, 'permission.prompt');
  assert.equal(first.hintKey, null);
  assert.equal(env.statuses.length, 1);
  assert.equal(env.last().listeners, 1);
  // change → granted, then → denied, both observed without another query.
  time.advance(1000);
  env.last().set('granted');
  assert.equal(permission.snapshot().status, 'granted');
  assert.equal(permission.snapshot().queriedAt, time.now());
  env.last().set('denied');
  assert.equal(permission.snapshot().status, 'denied');
  assert.equal(permission.snapshot().messageKey, 'permission.denied');
  assert.equal(permission.snapshot().hintKey, 'permission.noAutoRetry');
  assert.deepEqual(events.map(e => e.status), ['prompt', 'granted', 'denied']);
  assert.equal(env.calls.length, 0, 'query never opens the microphone');
});

test('query without the Permissions API, or when it throws, rejects or returns garbage, is unsupported not denied', async () => {
  for (const permissions of ['unsupported', 'throws', 'rejects', 'garbage']) {
    const { permission } = service({ permissions });
    const snapshot = await permission.query();
    assert.equal(snapshot.status, 'unsupported', permissions);
    assert.equal(snapshot.supported, false, permissions);
    assert.equal(snapshot.messageKey, 'permission.unsupported', permissions);
    assert.equal(snapshot.hintKey, 'permission.unsupportedHint', permissions);
    assert.equal(snapshot.error, null, permissions);
  }
  // A descriptor other than microphone is never sent.
  const env = navigator({ permissions: 'granted' });
  assert.throws(() => env.navigator.permissions.query({ name: 'camera' }), TypeError);
});

test('repeated queries coalesce, replace the watched status and drop late results', async () => {
  const gate = deferred();
  const late = permissionStatus('denied');
  const fresh = permissionStatus('granted');
  const { permission, env } = service({ permissions: index => (index === 0 ? gate.promise.then(() => late) : fresh) });
  // Concurrent calls share one query while pending.
  const a = permission.query();
  const b = permission.query();
  assert.equal(a, b);
  gate.resolve();
  assert.equal((await a).status, 'denied');
  assert.equal(late.listeners, 1);
  // A later query replaces the watched object; the old one is released.
  const second = await permission.query();
  assert.equal(second.status, 'granted');
  assert.equal(late.listeners, 0);
  assert.equal(fresh.listeners, 1);
  late.set('prompt');
  assert.equal(permission.snapshot().status, 'granted', 'stale status objects are ignored');
  assert.equal(env.statuses.length, 2);
});

test('legacy onchange-only status objects are watched and released', async () => {
  const status = permissionStatus('prompt', { legacy: true });
  const { permission } = service({ permissions: status });
  await permission.query();
  assert.equal(typeof status.onchange, 'function');
  status.set('granted');
  assert.equal(permission.snapshot().status, 'granted');
  permission.destroy();
  assert.equal(status.onchange, null);
  status.set('denied');
  assert.equal(permission.snapshot().status, 'granted', 'no updates after destroy');
});

test('probe request grants, stops every temporary track at once and records granted', async () => {
  const media = stream(2);
  const { permission, env, events, time } = service({ permissions: 'unsupported', media: () => media });
  await permission.query();
  const result = await permission.request({ purpose: 'probe' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'granted');
  assert.equal(result.stream, null);
  assert.equal(result.cancelled, false);
  assert.equal(result.error, null);
  assert.ok(Object.isFrozen(result));
  assert.ok(media.stopped(), 'probe stops all tracks');
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0].constraints, DEFAULT_CONSTRAINTS);
  const snapshot = permission.snapshot();
  assert.equal(snapshot.status, 'granted');
  assert.equal(snapshot.supported, false, 'unsupported query stays unsupported; the request result is the evidence');
  assert.equal(snapshot.requesting, false);
  assert.equal(snapshot.requestedAt, time.now());
  assert.equal(snapshot.messageKey, 'permission.granted');
  assert.deepEqual(events.map(e => [e.requesting, e.messageKey]),
    [[false, 'permission.unsupported'], [true, 'permission.checking'], [false, 'permission.granted']]);
});

test('start request hands the live stream to the caller with custom constraints and does not stop it', async () => {
  const media = stream();
  const { permission, env } = service({ permissions: 'prompt', media: () => media });
  const constraints = { audio: { channelCount: 1, noiseSuppression: true }, video: false };
  const result = await permission.request({ purpose: 'start', constraints });
  assert.equal(result.ok, true);
  assert.equal(result.stream, media);
  assert.ok(media.live(), 'caller owns the stream');
  assert.equal(env.calls[0].constraints, constraints);
  assert.equal(permission.snapshot().status, 'granted');
  // The caller releases it through the shared helper.
  stopStream(result.stream);
  assert.ok(media.stopped());
  stopStream(null);
  stopStream({ getTracks: () => { throw new Error('secret'); } });
});

test('denial is distinguished from missing device, busy device and unknown failures, without leaking the error', async () => {
  const cases = [
    ['NotAllowedError', 'denied', 'MICROPHONE_DENIED', 'denied', 'permission.denied', 'permission.noAutoRetry'],
    ['SecurityError', 'denied', 'MICROPHONE_DENIED', 'denied', 'permission.denied', 'permission.noAutoRetry'],
    ['NotFoundError', 'noDevice', 'MICROPHONE_UNAVAILABLE', 'prompt', 'permission.noDevice', 'permission.noDeviceHint'],
    ['OverconstrainedError', 'noDevice', 'MICROPHONE_UNAVAILABLE', 'prompt', 'permission.noDevice', 'permission.noDeviceHint'],
    ['NotReadableError', 'busy', 'MICROPHONE_UNAVAILABLE', 'prompt', 'permission.busy', 'permission.busyHint'],
    ['AbortError', 'unknown', 'MICROPHONE_UNAVAILABLE', 'prompt', 'permission.prompt', null],
    ['TypeError', 'unknown', 'MICROPHONE_UNAVAILABLE', 'prompt', 'permission.prompt', null],
  ];
  for (const [name, error, code, status, messageKey, hintKey] of cases) {
    const { permission } = service({ permissions: 'prompt', media: () => mediaError(name) });
    await permission.query();
    const result = await permission.request({ purpose: 'probe' });
    assert.equal(result.ok, false, name);
    assert.equal(result.error, error, name);
    assert.equal(result.code, code, name);
    assert.equal(result.status, status, name);
    assert.equal(result.messageKey, messageKey, name);
    assert.equal(result.hintKey, hintKey, name);
    assert.equal(result.cancelled, false, name);
    assert.equal(result.stream, null, name);
    assert.ok(!JSON.stringify(result).includes('secret'), name);
    assert.ok(!JSON.stringify(permission.snapshot()).includes('secret'), name);
    assert.equal(permission.snapshot().requesting, false, name);
  }
  assert.equal(classifyMediaError(undefined), 'unknown');
  assert.equal(classifyMediaError('NotAllowedError'), 'unknown', 'a bare string is not an error');
  assert.equal(classifyMediaError({ name: 'TrackStartError' }), 'busy');
  assert.equal(classifyMediaError({ name: 'PermissionDeniedError' }), 'denied');
  assert.equal(classifyMediaError({ name: 'DevicesNotFoundError' }), 'noDevice');
});

test('NotReadableError on a granted browser keeps granted and a later success clears the busy error', async () => {
  const media = stream();
  const { permission } = service({ permissions: 'granted', media: [mediaError('NotReadableError'), () => media] });
  await permission.query();
  const busy = await permission.request({ purpose: 'probe' });
  assert.equal(busy.status, 'granted', 'busy is not denial');
  assert.equal(busy.error, 'busy');
  assert.equal(permission.snapshot().messageKey, 'permission.busy');
  const ok = await permission.request({ purpose: 'probe' });
  assert.equal(ok.ok, true);
  assert.equal(permission.snapshot().error, null);
  assert.equal(permission.snapshot().messageKey, 'permission.granted');
});

test('a browser change to granted or prompt clears a denial, but a device error stays until the next request', async () => {
  const { permission, env } = service({ permissions: 'prompt', media: [mediaError('NotAllowedError'), mediaError('NotFoundError')] });
  await permission.query();
  await permission.request({ purpose: 'probe' });
  assert.equal(permission.snapshot().status, 'denied');
  assert.equal(permission.snapshot().error, 'denied');
  env.last().set('prompt');
  assert.equal(permission.snapshot().status, 'prompt');
  assert.equal(permission.snapshot().error, null);
  assert.equal(permission.snapshot().code, null);
  await permission.request({ purpose: 'probe' });
  assert.equal(permission.snapshot().error, 'noDevice');
  env.last().set('granted');
  assert.equal(permission.snapshot().status, 'granted');
  assert.equal(permission.snapshot().error, 'noDevice', 'device errors are not a permission fact');
  assert.equal(permission.snapshot().messageKey, 'permission.noDevice');
});

test('no getUserMedia support is reported as unknown, not denied', async () => {
  const { permission } = service({ permissions: 'unsupported' });
  const result = await permission.request({ purpose: 'probe' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown');
  assert.equal(result.status, 'unsupported');
});

test('a stream without audio tracks is stopped and reported as noDevice', async () => {
  const empty = stream(0);
  const { permission } = service({ permissions: 'prompt', media: () => empty });
  await permission.query();
  const result = await permission.request({ purpose: 'start' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'noDevice');
  assert.equal(result.stream, null);
  assert.equal(permission.snapshot().status, 'prompt');
});

test('concurrent requests share one getUserMedia; only the first caller receives the stream', async () => {
  const gate = deferred();
  const media = stream();
  const { permission, env } = service({ permissions: 'prompt', media: () => gate.promise });
  const first = permission.request({ purpose: 'start' });
  const second = permission.request({ purpose: 'start' });
  const third = permission.request({ purpose: 'probe' });
  await settle();
  assert.equal(env.calls.length, 1);
  assert.equal(permission.snapshot().requesting, true);
  assert.equal(permission.snapshot().messageKey, 'permission.checking');
  gate.resolve(media);
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(a.stream, media);
  assert.equal(b.ok, true);
  assert.equal(b.stream, null);
  assert.equal(c.ok, true);
  assert.equal(c.stream, null);
  assert.ok(media.live(), 'the owner keeps the stream');
  assert.equal(env.calls.length, 1);
  // After settlement a new request is a new getUserMedia.
  const later = await permission.request({ purpose: 'probe' });
  assert.equal(later.ok, true);
  assert.equal(env.calls.length, 2);
  stopStream(media);
});

test('when the first caller is a probe and a starter joins, the stream is stopped and nobody owns it', async () => {
  const gate = deferred();
  const media = stream();
  const { permission, env } = service({ permissions: 'prompt', media: () => gate.promise });
  const probe = permission.request({ purpose: 'probe' });
  const start = permission.request({ purpose: 'start' });
  gate.resolve(media);
  const [a, b] = await Promise.all([probe, start]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.stream, null);
  assert.ok(media.stopped());
  assert.equal(env.calls.length, 1);
});

test('cancelling before the prompt resolves stops the late stream and still records granted', async () => {
  const gate = deferred();
  const media = stream();
  const { permission, events } = service({ permissions: 'unsupported', media: () => gate.promise });
  const controller = new AbortController();
  const promise = permission.request({ purpose: 'start', signal: controller.signal });
  await settle();
  assert.equal(permission.snapshot().requesting, true);
  controller.abort();
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.code, 'ABORTED');
  assert.equal(result.messageKey, 'error.ABORTED');
  assert.equal(result.stream, null);
  assert.equal(permission.snapshot().requesting, false, 'cancel ends the checking state immediately');
  assert.ok(media.live());
  gate.resolve(media);
  await settle();
  assert.ok(media.stopped(), 'late stream after cancel is stopped');
  assert.equal(permission.snapshot().status, 'granted', 'the grant itself was real');
  assert.equal(events.filter(e => e.requesting).length, 1);
});

test('an already-aborted signal never calls getUserMedia', async () => {
  const { permission, env } = service({ permissions: 'prompt', media: () => stream() });
  const controller = new AbortController();
  controller.abort();
  const result = await permission.request({ purpose: 'probe', signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(env.calls.length, 0);
  assert.equal(permission.snapshot().requesting, false);
});

test('when the owner cancels, the next waiting caller inherits the stream', async () => {
  const gate = deferred();
  const media = stream();
  const { permission, env } = service({ permissions: 'prompt', media: () => gate.promise });
  const controller = new AbortController();
  const first = permission.request({ purpose: 'start', signal: controller.signal });
  const second = permission.request({ purpose: 'start' });
  controller.abort();
  assert.equal((await first).cancelled, true);
  assert.equal(permission.snapshot().requesting, true, 'another caller is still waiting');
  gate.resolve(media);
  const result = await second;
  assert.equal(result.stream, media);
  assert.ok(media.live());
  assert.equal(env.calls.length, 1);
  stopStream(media);
});

test('a late denial after cancel is recorded without a retry and never rejects', async () => {
  const gate = deferred();
  const { permission, env } = service({ permissions: 'unsupported', media: () => gate.promise });
  const controller = new AbortController();
  const promise = permission.request({ purpose: 'probe', signal: controller.signal });
  controller.abort();
  assert.equal((await promise).cancelled, true);
  gate.reject(mediaError('NotAllowedError'));
  await settle();
  assert.equal(permission.snapshot().status, 'denied');
  assert.equal(permission.snapshot().requesting, false);
  assert.equal(env.calls.length, 1, 'no automatic re-request after denial');
});

test('destroy resolves waiting callers as cancelled, stops the late stream and detaches from the browser', async () => {
  const gate = deferred();
  const media = stream();
  const { permission, env, events } = service({ permissions: 'granted', media: () => gate.promise });
  await permission.query();
  const status = env.last();
  const promise = permission.request({ purpose: 'start' });
  permission.destroy();
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(status.listeners, 0);
  const seen = events.length;
  gate.resolve(media);
  await settle();
  assert.ok(media.stopped());
  assert.equal(events.length, seen, 'no notifications after destroy');
  assert.equal(permission.snapshot().requesting, false);
  assert.equal((await permission.request({ purpose: 'probe' })).cancelled, true);
  assert.equal(env.calls.length, 1);
  assert.equal(await permission.query(), permission.snapshot());
  assert.equal(typeof permission.subscribe(() => {}), 'function');
  permission.destroy();
});

test('an invalid purpose is rejected before touching the browser', async () => {
  const { permission, env } = service({ permissions: 'prompt', media: () => stream() });
  await assert.rejects(permission.request({ purpose: 'peek' }), /INVALID_REQUEST/);
  assert.equal(env.calls.length, 0);
  assert.equal(permission.snapshot().requesting, false);
});

test('subscribers get frozen snapshots only on change and can unsubscribe; a throwing listener is contained', async () => {
  const { permission, env } = service({ permissions: 'granted', media: () => stream() });
  const seen = [];
  const off = permission.subscribe(snapshot => { seen.push(snapshot); throw new Error('listener'); });
  await permission.query();
  await permission.query();
  assert.equal(seen.length, 1, 'an identical query result does not notify');
  assert.ok(seen.every(Object.isFrozen));
  off();
  env.last().set('denied');
  assert.equal(seen.length, 1);
  assert.equal(permission.snapshot().status, 'denied');
});

test('a broken clock leaves timestamps null instead of throwing', async () => {
  const env = navigator({ permissions: 'granted', media: () => stream() });
  const permission = createMicrophonePermission({ navigator: env.navigator, now: () => { throw new Error('clock'); } });
  await permission.query();
  const result = await permission.request({ purpose: 'probe' });
  assert.equal(result.ok, true);
  assert.equal(permission.snapshot().queriedAt, null);
  assert.equal(permission.snapshot().requestedAt, null);
  const bare = createMicrophonePermission();
  assert.equal((await bare.query()).status, 'unsupported');
  assert.equal((await bare.request({ purpose: 'probe' })).error, 'unknown');
});
