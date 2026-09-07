import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SEQ_STATUS, TURN_PHASE } from '../app/state.js';
import { SEQ_POLICY } from '../app/engine/seq.js';
import { DEFAULT_MODEL, FALLBACK_MODEL } from '../app/providers/gemini/config.js';
import { validateWav } from '../app/audio/wav.js';
import { UI_TAB_STORAGE_KEY, startApp } from '../app/main.js';
import {
  DEVICE_VOICES, boot, captureConsole, createBrowser, frames, leaks, live, rest, secrets, sharedFragment, sleep, tick, until, visible,
} from './fixtures/scenarios.mjs';

// P1-20 integration regression (design-v0.6 §17.4): the real app boots in a
// fake browser and each scenario crosses module boundaries — DOM -> shell ->
// sequential engine -> retry executor -> router -> key store -> Gemini
// adapters -> scripted fetch/WebSocket -> audio player/device speech -> store
// -> DOM. Nothing here restates an implementation; every assertion is an
// outcome the user or the network would observe. Time is virtual, so retry
// waits and deadlines are proven by advancing the clock, not by sleeping.
// Node cannot prove microphone, autoplay or install behaviour on a phone;
// P1-21 records those on real devices.

const ko = JSON.parse(await readFile(new URL('../app/i18n/ko.json', import.meta.url), 'utf8'));
const decode = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

// Every scenario runs with console captured: the app must never log.
async function scenario(t, options, run) {
  const console_ = captureConsole();
  t.after(console_.restore);
  // P3-02e: the first screen is simultaneous interpretation, and since the
  // owner's 2026-09-06 change every launch opens there whatever was used last.
  // These are sequential scenarios, so they switch tab the way a person does.
  const b = await boot({ ...options, storage: { [UI_TAB_STORAGE_KEY]: 'sequential', ...(options.storage ?? {}) } });
  await b.app.shell.switchTab('sequential');
  assert.equal(b.app.shell.selectedTab, 'sequential');
  try { await run(b); } finally { await b.close(); }
  assert.deepEqual(console_.calls, [], 'nothing was logged');
  assert.equal(leaks(b.store.snapshot()), false, 'no key in the final state');
  assert.equal(leaks(b.text()), false, 'no key in the final DOM');
}

test('silence: a push-to-talk turn with no audible input ends without any provider call; audible speech goes out as one WAV request', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.setVoiceOutput('off');
    b.press();
    assert.equal(b.store.snapshot().status, SEQ_STATUS.RECORDING);
    assert.equal(b.el('seq-ptt').getAttribute('aria-pressed'), 'true');
    await until(() => b.audio.nodes.length === 1);
    b.microphone.feed(frames.silence());
    b.microphone.feed(frames.silence());
    assert.equal(b.el('seq-level').getAttribute('aria-valuenow'), '0', 'silence moves no meter');
    b.release();
    await b.idle();
    const [silent] = b.turns();
    assert.deepEqual([silent.input, silent.phase, silent.messageKey, silent.errorCode, silent.translatedText],
      ['voice', TURN_PHASE.SILENCE, 'seq.silence', null, '']);
    assert.equal(b.gemini.calls.length, 0, 'silence never reaches the provider');
    assert.equal(b.microphone.streams[0].stopped, true, 'the microphone is released');
    assert.equal(b.audio.contexts[0].state, 'closed', 'the capture context is closed');
    assert.equal(b.bubble(silent.turnId).childNodes[0].childNodes[1].textContent, ko['seq.silence']);
    assert.equal(b.store.snapshot().status, SEQ_STATUS.IDLE);

    // Audible input: capture -> 16 kHz WAV -> one combined translate request.
    b.gemini.script.push(rest.translation({ sourceText: '사과 12개', translatedText: '12 apples' }));
    b.press();
    await until(() => b.audio.nodes.length === 2);
    for (let i = 0; i < 4; i++) b.microphone.feed(frames.speech());
    assert.notEqual(b.el('seq-level').getAttribute('aria-valuenow'), '0', 'speech moves the meter');
    b.release();
    await b.idle();
    const spoken = b.turns()[1];
    assert.deepEqual([spoken.input, spoken.phase, spoken.sourceText, spoken.translatedText], ['voice', TURN_PHASE.COMPLETED, '사과 12개', '12 apples']);
    assert.equal(b.gemini.calls.length, 1);
    const [call] = b.gemini.calls;
    assert.equal(call.headers['x-goog-api-key'], secrets.personal);
    assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`);
    const part = JSON.parse(call.body).contents[0].parts[0];
    assert.equal(part.inlineData.mimeType, 'audio/wav');
    const wav = decode(part.inlineData.data);
    assert.doesNotThrow(() => validateWav(wav, { sampleRate: 16000 }), 'the request carries a valid 16 kHz WAV');
    assert.ok(wav.byteLength > 44);
    assert.equal(leaks(call.url) || leaks(call.body), false);
    assert.equal(b.microphone.streams[1].stopped, true);
    assert.equal(JSON.stringify(b.store.snapshot()).includes('inlineData'), false, 'no audio is kept in state');
  });
});

test('403 ends the turn after exactly one request; a per-minute 429 waits Retry-After and retries once; retry reuses the record', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.setVoiceOutput('off');
    b.gemini.script.push(rest.forbidden());
    const forbidden = await b.submitText('사과 12개').done;
    assert.deepEqual([forbidden.phase, forbidden.errorCode, forbidden.messageKey], [TURN_PHASE.ERROR, 'PERMISSION_DENIED', 'error.PERMISSION_DENIED']);
    assert.equal(b.gemini.calls.length, 1);
    b.clock.advance(60000);
    await tick();
    assert.equal(b.gemini.calls.length, 1, 'a permission failure is never retried automatically');
    assert.equal(b.el('shell-mode').textContent, ko['mode.personal'], 'no automatic switch of key source');
    const bubble = b.bubble(forbidden.turnId);
    assert.equal(bubble.childNodes[0].childNodes[1].textContent, ko['error.PERMISSION_DENIED']);
    assert.equal(visible(bubble.childNodes[4].childNodes[0]), true, 'retry is offered');
    assert.equal(leaks(forbidden), false);

    // A per-minute limit is transient: the executor waits the server value, then retries the same model.
    b.gemini.script.push(rest.perMinute429(7), rest.translation({ translatedText: '12 apples' }));
    const limited = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 2);
    await until(() => b.clock.pending.includes(7000));
    b.clock.advance(6999);
    await tick();
    assert.equal(b.gemini.calls.length, 2, 'nothing is sent before Retry-After elapses');
    b.clock.advance(1);
    await until(() => b.gemini.calls.length === 3);
    const done = await limited.done;
    assert.deepEqual([done.phase, done.translatedText, done.errorCode, done.attempts], [TURN_PHASE.COMPLETED, '12 apples', null, 1]);
    assert.equal(b.gemini.calls[2].url, b.gemini.calls[1].url, 'same model on a transient retry');
    assert.equal(b.turns().length, 2, 'one record per utterance');

    // The bubble's retry button reprocesses the failed record inside a fresh budget.
    b.gemini.script.push(rest.translation({ translatedText: '12 apples' }));
    b.clickTurn(forbidden.turnId, 'turn-retry');
    await b.idle();
    const retried = b.turn(forbidden.turnId);
    assert.deepEqual([retried.phase, retried.translatedText, retried.attempts], [TURN_PHASE.COMPLETED, '12 apples', 2]);
    assert.equal(b.turns().length, 2);
    assert.equal(b.gemini.calls.length, 4);
  });
});

test('invalid key: a rejected key ends the turn with error.INVALID_KEY, never enters speaking and opens no socket', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    assert.equal(b.store.snapshot().voice.output, 'provider');
    const statuses = [];
    b.store.subscribe((snapshot) => statuses.push(snapshot.status));
    b.gemini.script.push(rest.error(400, { rpc: 'INVALID_ARGUMENT', reason: 'API_KEY_INVALID' }));
    const turnId = b.submitForm('사과 12개 주세요');
    await b.idle();
    const turn = b.turn(turnId);
    assert.deepEqual([turn.phase, turn.errorCode, turn.messageKey, turn.voice], [TURN_PHASE.ERROR, 'INVALID_KEY', 'error.INVALID_KEY', null]);
    assert.equal(statuses.includes(SEQ_STATUS.SPEAKING), false, 'no speaking state without a translation');
    assert.equal(b.sockets.length, 0);
    assert.equal(b.gemini.calls.length, 1);
    const bubble = b.bubble(turnId);
    assert.equal(bubble.childNodes[0].childNodes[1].textContent, ko['error.INVALID_KEY']);
    assert.equal(bubble.getAttribute('data-phase'), TURN_PHASE.ERROR);
    // Bubble buttons are DOM children even when hidden, so textContent of the
    // article always carries their labels; visibility is what the user sees.
    const [retry, play, device, stop] = bubble.childNodes[4].childNodes;
    assert.deepEqual([visible(retry), visible(play), visible(device), visible(stop)], [true, false, false, false]);
    assert.equal(stop.textContent, ko['seq.stopPlayback']);
    assert.equal(b.el('shell-mode').textContent, ko['mode.personal'], 'the key stays selected; the user replaces it');
    assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal')?.remembered, false, 'a rejected key is not deleted on its own');
  });
});

// Regression for the cold-load voice-list race: on a cold load Chrome's speechSynthesis.getVoices()
// returns [] until voiceschanged fires. The auto option must exist even
// while the voice list is empty, and the late list must refresh the select.
test('cold load: the app boots when the device voice list is still empty', async (t) => {
  const console_ = captureConsole();
  t.after(console_.restore);
  const voices = [];
  const browser = createBrowser({ deviceVoices: voices });
  const app = await startApp({ builtinKey: () => null, window: browser.win, setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout });
  assert.deepEqual(console_.calls, []);
  assert.ok(app, `startApp resolved null; #app shows: ${browser.root.textContent}`);
  t.after(() => app.close());
  const select = app.settingsView.elements.deviceSelect;
  assert.equal(select.childNodes.length, 1);
  assert.equal(select.childNodes[0].textContent, ko['language.auto']);
  voices.push(...DEVICE_VOICES);
  browser.synth.voicesChanged();
  assert.equal(select.childNodes.length, 4);
  assert.equal(browser.sockets.length, 0);
  assert.ok(browser.root.childNodes[0]?.classes.has('shell'));
  await until(() => browser.container.registrations.length === 1);
  await app.close();
  assert.equal(browser.synth.listenerCount, 0);
});

// Numeric contract codes survive state, diagnostics and rendering.
test('unclassified 429: the turn ends after one request with UNKNOWN_429 and no automatic wait', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.setVoiceOutput('off');
    b.gemini.script.push(rest.unknown429(30));
    const unknown = await b.submitText('사과 12개').done;
    assert.equal(b.gemini.calls.length, 1);
    b.clock.advance(60000);
    await tick();
    assert.equal(b.gemini.calls.length, 1, 'an unclassified 429 does not wait or retry (§9.2)');
    assert.deepEqual([unknown.phase, unknown.errorCode, unknown.messageKey], [TURN_PHASE.ERROR, 'UNKNOWN_429', 'error.UNKNOWN_429']);
    assert.equal(b.bubble(unknown.turnId).childNodes[0].childNodes[1].textContent, ko['error.UNKNOWN_429']);
    b.gemini.script.push(rest.unknown429());
    const checked = await b.app.diagnostics.run('text').done;
    assert.equal(checked.errorCode, 'UNKNOWN_429');
    assert.equal(checked.messageKey, 'error.UNKNOWN_429');
  });
});

test('503: the default model falls back to the second model after the server wait; three failures exhaust the budget; cancel ends a pending wait', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.setVoiceOutput('off');
    b.gemini.script.push(rest.unavailable(3), rest.translation({ translatedText: '12 apples' }));
    const first = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 1);
    assert.match(b.gemini.calls[0].url, new RegExp(`/${DEFAULT_MODEL}:generateContent$`));
    await until(() => b.clock.pending.includes(3000));
    assert.equal(b.store.snapshot().status, SEQ_STATUS.TRANSLATING, 'the turn keeps waiting');
    b.clock.advance(3000);
    await until(() => b.gemini.calls.length === 2);
    assert.match(b.gemini.calls[1].url, new RegExp(`/${FALLBACK_MODEL}:generateContent$`), 'fallback model after 503');
    const done = await first.done;
    assert.deepEqual([done.phase, done.translatedText, done.model, done.attempts], [TURN_PHASE.COMPLETED, '12 apples', FALLBACK_MODEL, 1]);

    // Three 503s: default -> fallback -> fallback, then the budget is spent.
    b.gemini.script.push(rest.unavailable(), rest.unavailable(), rest.unavailable());
    const second = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 3);
    await until(() => b.clock.pending.some((ms) => ms >= 1000 && ms <= 1250));
    b.clock.advance(1250);
    await until(() => b.gemini.calls.length === 4);
    await until(() => b.clock.pending.some((ms) => ms >= 2000 && ms <= 2500));
    b.clock.advance(2500);
    await until(() => b.gemini.calls.length === 5);
    const failed = await second.done;
    assert.deepEqual([failed.phase, failed.errorCode], [TURN_PHASE.ERROR, 'UNAVAILABLE']);
    b.clock.advance(60000);
    await tick();
    assert.equal(b.gemini.calls.length, 5, 'no fourth attempt');
    assert.equal(b.gemini.script.length, 0);
    assert.equal(b.bubble(failed.turnId).childNodes[0].childNodes[1].textContent, ko['error.UNAVAILABLE']);

    // Cancel during the retry wait: no further request, the turn is cancelled at once.
    b.gemini.script.push(rest.unavailable());
    const third = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 6);
    await until(() => b.clock.pending.some((ms) => ms >= 1000 && ms <= 1250));
    b.cancel();
    assert.equal(b.turn(third.turnId).phase, TURN_PHASE.CANCELLED);
    assert.equal((await third.done).phase, TURN_PHASE.CANCELLED);
    b.clock.advance(60000);
    await tick();
    assert.equal(b.gemini.calls.length, 6, 'the aborted wait sends nothing');
  });
});

test('cancel: an in-flight request aborts and its late result is discarded; cancelling playback keeps the captions and closes the Live socket', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.setVoiceOutput('off');
    const hang = rest.hang();
    b.gemini.script.push(hang.responder);
    const turnId = b.submitForm('사과 12개');
    assert.ok(turnId);
    assert.equal(b.el('seq-text').value, '', 'the text field is cleared on submit');
    await until(() => b.gemini.calls.length === 1);
    assert.equal(visible(b.el('seq-cancel')), true);
    b.cancel();
    assert.equal(b.gemini.calls[0].signal.aborted, true, 'the fetch is aborted');
    assert.equal(b.turn(turnId).phase, TURN_PHASE.CANCELLED, 'the store shows the cancellation at once');
    assert.equal(b.store.snapshot().status, SEQ_STATUS.IDLE);
    hang.release(rest.translation({ translatedText: '12 apples' }));
    await tick(); await tick(); await tick();
    assert.deepEqual([b.turn(turnId).phase, b.turn(turnId).translatedText], [TURN_PHASE.CANCELLED, ''], 'the late result is discarded');
    assert.equal(b.bubble(turnId).childNodes[0].childNodes[1].textContent, ko['seq.cancelled']);
    assert.equal(b.speech.utterances.length, 0);

    // Provider voice: cancel while audio is playing.
    b.setVoiceOutput('provider');
    b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
    const spoken = b.submitText('사과 12개');
    await until(() => b.sockets.length === 1);
    const ws = b.sockets[0];
    live.ready(ws);
    await until(() => ws.sent.length === 2);
    assert.equal(live.sentText(ws), 'りんご12個', 'the translation is the line read aloud');
    ws.json(live.chunk());
    await until(() => b.audio.scheduled === 1);
    assert.equal(b.store.snapshot().status, SEQ_STATUS.SPEAKING);
    b.clickTurn(spoken.turnId, 'turn-stop');
    const result = await spoken.done;
    assert.equal(result.phase, TURN_PHASE.COMPLETED, 'captions survive');
    assert.equal(result.translatedText, 'りんご12個');
    assert.deepEqual([result.voice.status, result.voice.errorCode], ['cancelled', 'ABORTED']);
    await until(() => ws.closeCalls === 1);
    ws.json(live.chunk());
    await tick();
    assert.equal(b.audio.scheduled, 1, 'audio after cancel is dropped');
    await until(() => b.app.config.sessionManager.occupied === false);
    assert.equal(b.app.engine.snapshot().voice.sessionOpen, false);
    assert.equal(b.el('shell-connection').getAttribute('data-connection'), 'idle');
    assert.equal(b.speech.utterances.length, 0, 'no device re-read after a cancel');
  });
});

test('late response: a request past the deadline is abandoned and retried; its answer and a result after a language change are discarded', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.setVoiceOutput('off');
    const slow = rest.hang();
    b.gemini.script.push(slow.responder, rest.translation({ translatedText: '12 apples' }));
    const first = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 1);
    b.clock.advance(SEQ_POLICY.translateTimeoutMs);
    await until(() => b.gemini.calls[0].signal.aborted);
    assert.equal(b.turn(first.turnId).phase, TURN_PHASE.TRANSLATING, 'a timeout is retried, not surfaced');
    await until(() => b.clock.pending.some((ms) => ms >= 1000 && ms <= 1250));
    b.clock.advance(1250);
    await until(() => b.gemini.calls.length === 2);
    const done = await first.done;
    assert.deepEqual([done.phase, done.translatedText], [TURN_PHASE.COMPLETED, '12 apples']);
    slow.release(rest.translation({ translatedText: 'LATE 12' }));
    await tick(); await tick(); await tick();
    assert.equal(b.turn(first.turnId).translatedText, '12 apples', 'the abandoned answer changes nothing');
    assert.equal(b.turns().length, 1);

    // Changing the pair while a request is out cancels it; its result is dropped.
    const pending = rest.hang();
    b.gemini.script.push(pending.responder);
    const second = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 3);
    b.byId('seq-target').value = 'en';
    b.byId('seq-target').dispatch('change');
    assert.deepEqual(b.store.snapshot().interpretation, { sourceLanguage: 'ko', targetLanguage: 'en' });
    assert.equal(b.notice(), 'mode.changed');
    pending.release(rest.translation({ translatedText: '12 apples' }));
    const cancelled = await second.done;
    assert.deepEqual([cancelled.phase, cancelled.translatedText], [TURN_PHASE.CANCELLED, '']);
    assert.equal(b.gemini.calls.length, 3);
    b.gemini.script.push(rest.translation({ translatedText: '12 apples' }));
    const next = await b.submitText('사과 12개').done;
    assert.deepEqual([next.targetLanguage, next.phase], ['en', TURN_PHASE.COMPLETED]);
    assert.equal(JSON.parse(b.gemini.calls[3].body).systemInstruction.parts[0].text.includes('Translate into en'), true);
  });
});

test('voice partial failure: a Live failure before any audio falls back to device speech once; after audio the line is reported partial and re-read only on request', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    assert.equal(b.store.snapshot().voice.output, 'provider');
    b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
    const first = b.submitText('사과 12개');
    await until(() => b.sockets.length === 1);
    const ws = b.sockets[0];
    live.ready(ws);
    await until(() => ws.sent.length === 2);
    ws.json(live.error(503, 'UNAVAILABLE'));
    const fallen = await first.done;
    assert.equal(fallen.phase, TURN_PHASE.COMPLETED);
    assert.equal(fallen.translatedText, 'りんご12個');
    assert.deepEqual([fallen.voice.status, fallen.voice.engine, fallen.voice.fallback, fallen.voice.messageKey, fallen.voice.gap],
      ['completed', 'device', true, 'voice.fallback', false]);
    assert.deepEqual(b.speech.utterances, [{ text: 'りんご12個', lang: 'ja', voiceURI: 'fake-ja' }], 'device speech read the line once');
    assert.equal(b.audio.scheduled, 0, 'no provider audio was played');
    await until(() => ws.closeCalls === 1);
    assert.equal(b.bubble(first.turnId).childNodes[3].textContent, ko['voice.fallback']);
    assert.equal(b.app.engine.snapshot().voice.live, 'cooling', 'the Live path cools down after the failure');
    b.clock.advance(5000);
    await until(() => b.app.engine.snapshot().voice.live === 'ready');

    // Audio was heard, then the stream failed: partial, never re-read automatically.
    b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
    const second = b.submitText('사과 12개');
    await until(() => b.sockets.length === 2);
    const ws2 = b.sockets[1];
    live.ready(ws2);
    await until(() => ws2.sent.length === 2);
    ws2.json(live.chunk());
    await until(() => b.audio.scheduled === 1);
    ws2.json(live.transcript('りんご'));
    ws2.json(live.error(503, 'UNAVAILABLE'));
    const partial = await second.done;
    assert.equal(partial.phase, TURN_PHASE.COMPLETED);
    assert.equal(partial.translatedText, 'りんご12個', 'the translation is kept');
    assert.deepEqual([partial.voice.status, partial.voice.engine, partial.voice.messageKey, partial.voice.gap, partial.voice.deviceFallbackAvailable, partial.voice.said],
      ['partial', 'live', 'voice.partialFailure', true, true, 'りんご']);
    assert.equal(b.speech.utterances.length, 1, 'no automatic device re-read after audio was heard');
    await until(() => ws2.closeCalls === 1);
    const bubble = b.bubble(second.turnId);
    assert.equal(bubble.childNodes[3].textContent, ko['voice.partialFailure']);
    const deviceButton = bubble.childNodes[4].childNodes[2];
    assert.equal(visible(deviceButton), true, 'the device re-read button is offered');
    assert.equal(deviceButton.textContent, ko['seq.replayDevice']);
    b.clickTurn(second.turnId, 'turn-device');
    await b.idle();
    const reread = b.turn(second.turnId);
    assert.deepEqual([reread.voice.status, reread.voice.engine, reread.translatedText], ['completed', 'device', 'りんご12個']);
    assert.equal(b.speech.utterances.length, 2);
    assert.equal(b.speech.utterances[1].text, 'りんご12個');
    assert.equal(b.gemini.calls.length, 2, 'a re-read never translates again');
    assert.equal(b.sockets.length, 2, 'a device re-read opens no socket');
  });
});

test('shared end: ending shared use clears the conversation, the key, the Live socket and diagnostics; the deadline ends it on its own', async (t) => {
  await scenario(t, { hash: sharedFragment() }, async (b) => {
    assert.equal(b.win.location.hash, '');
    assert.equal(b.app.config.keyStore.getSelection(), null, 'shared mode is an explicit choice');
    assert.equal(b.byId('settings-mode-personal').disabled, true, 'no personal key to select');
    b.selectMode('shared');
    assert.equal(b.el('shell-mode').textContent, ko['mode.shared']);
    b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
    const spoken = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 1);
    assert.equal(b.gemini.calls[0].headers['x-goog-api-key'], secrets.shared);
    await until(() => b.sockets.length === 1);
    const ws = b.sockets[0];
    live.ready(ws);
    await until(() => ws.sent.length === 2);
    ws.json(live.chunk());
    ws.json(live.complete());
    const done = await spoken.done;
    assert.deepEqual([done.phase, done.voice.status, done.voice.engine], [TURN_PHASE.COMPLETED, 'completed', 'live']);
    assert.equal(b.app.engine.snapshot().voice.sessionOpen, true, 'the session is kept for the next line');

    // A diagnostics result for the shared key exists before the end.
    b.gemini.script.push(rest.translation({ translatedText: 'Hello. This is a connection check.', sourceText: '안녕하세요. 연결 확인입니다.' }));
    const check = await b.app.diagnostics.run('text', { sourceLanguage: 'ko', targetLanguage: 'en' }).done;
    assert.deepEqual([check.state, check.keySource], ['available', 'shared']);

    b.el('settings-shared-end').dispatch('click');
    assert.deepEqual(b.turns(), [], 'the temporary conversation is gone');
    assert.equal(b.notice(), 'records.sharedEnded');
    assert.equal(b.el('shell-notice-text').textContent, ko['records.sharedEnded']);
    assert.equal(b.app.config.keyStore.getMetadata('gemini', 'shared'), null);
    assert.deepEqual(b.store.snapshot().keySelection, { providerId: 'gemini', keySource: 'shared' }, 'no fallback to another source');
    assert.equal(visible(b.el('seq-empty')), true);
    assert.equal(b.el('settings-shared-status').textContent, ko['settings.noKey']);
    assert.equal(b.el('settings-shared-form').hidden, false, 'a new QR can be imported');
    await until(() => ws.closeCalls === 1);
    await until(() => b.app.config.sessionManager.occupied === false);
    assert.equal(b.app.engine.snapshot().voice.sessionOpen, false, 'the socket authenticated with the ended key is closed');
    assert.equal(b.app.diagnostics.snapshot().results.some((result) => result.keySource === 'shared'), false, 'results for the ended key are dropped');
    const refused = await b.submitText('사과 12개').done;
    assert.deepEqual([refused.phase, refused.errorCode], [TURN_PHASE.ERROR, 'CREDENTIAL_REQUIRED']);
    const recording = await b.app.engine.startRecording().done;
    assert.equal(recording.errorCode, 'CREDENTIAL_REQUIRED');
    assert.equal(b.audio.nodes.length, 0, 'no microphone without a key');
    assert.equal(b.gemini.calls.length, 2, 'no request without a key');
    assert.equal(b.sockets.length, 1);
    // Only UI preferences reach storage (the install hint after the first success), never a key.
    assert.deepEqual([...b.storage.keys()].filter((key) => !key.startsWith('interp-app.ui.')), [], 'shared use stores no key');
    assert.equal(leaks([...b.storage.entries()]), false);
  });

  // The usage deadline: the key store ends shared use when it passes.
  const expiresAt = Date.now() + 1500;
  await scenario(t, { hash: sharedFragment({ expiresAt }) }, async (b) => {
    b.selectMode('shared');
    b.setVoiceOutput('off');
    assert.equal(b.el('settings-shared-until').hidden, false);
    assert.equal(b.app.config.keyStore.getMetadata('gemini', 'shared').usageEndsAt, expiresAt);
    b.gemini.script.push(rest.translation({ translatedText: '12 apples' }));
    const done = await b.submitText('사과 12개').done;
    assert.equal(done.phase, TURN_PHASE.COMPLETED);
    await sleep(1600);
    b.clock.advance(2000);
    assert.deepEqual(b.turns(), []);
    assert.equal(b.notice(), 'records.sharedEnded');
    assert.equal(b.app.config.keyStore.getMetadata('gemini', 'shared'), null);
    assert.equal(b.el('settings-shared-until').hidden, true);
    assert.equal((await b.submitText('사과 12개').done).errorCode, 'CREDENTIAL_REQUIRED');
    assert.equal(b.gemini.calls.length, 1);
  });

  // A QR whose deadline already passed is refused at start with a notice.
  await scenario(t, { hash: sharedFragment({ expiresAt: Date.now() - 1 }) }, async (b) => {
    assert.equal(b.notice(), 'error.SHARED_USE_ENDED');
    assert.equal(b.app.config.keyStore.getMetadata('gemini', 'shared'), null);
    assert.equal(b.byId('settings-mode-shared').disabled, true);
  });
});

test('key change mid-turn: saving a new personal key aborts the request and closes the Live socket opened with the old key', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    b.gemini.script.push(rest.translation({ translatedText: 'りんご12個' }));
    const first = b.submitText('사과 12개');
    await until(() => b.sockets.length === 1);
    const ws = b.sockets[0];
    live.ready(ws);
    await until(() => ws.sent.length === 2);
    ws.json(live.chunk());
    ws.json(live.complete());
    assert.equal((await first.done).voice.status, 'completed');
    assert.equal(b.app.engine.snapshot().voice.sessionOpen, true);
    const hang = rest.hang();
    b.gemini.script.push(hang.responder);
    const second = b.submitText('사과 12개');
    await until(() => b.gemini.calls.length === 2);
    b.enterPersonalKey({ key: `${secrets.personal}-NEW` });
    assert.equal(b.gemini.calls[1].signal.aborted, true);
    assert.equal(b.turn(second.turnId).phase, TURN_PHASE.CANCELLED);
    assert.equal(b.notice(), 'mode.changed');
    await until(() => ws.closeCalls === 1);
    await until(() => b.app.config.sessionManager.occupied === false);
    hang.release(rest.translation());
    await tick(); await tick();
    assert.equal(b.turn(second.turnId).translatedText, '');
    assert.equal(b.turns().length, 2, 'a personal key change keeps the visible conversation');
    b.setVoiceOutput('off');
    b.gemini.script.push(rest.translation({ translatedText: '12 apples' }));
    const third = await b.submitText('사과 12개').done;
    assert.equal(third.phase, TURN_PHASE.COMPLETED);
    assert.equal(b.gemini.calls[2].headers['x-goog-api-key'], `${secrets.personal}-NEW`, 'the next request uses the new key');
  });
});

test('sequential work and diagnostics never overlap capture or playback', async (t) => {
  await scenario(t, {}, async (b) => {
    b.enterPersonalKey();
    const recording = b.app.engine.startRecording();
    assert.throws(() => b.app.diagnostics.run('playback'), (error) => error.code === 'INVALID_REQUEST');
    assert.equal(b.audio.scheduled, 0);
    await b.app.engine.cancel();
    await recording.done;
    const check = b.app.diagnostics.run('microphone');
    assert.throws(() => b.app.engine.startRecording(), (error) => error.code === 'INVALID_REQUEST');
    assert.throws(() => b.app.engine.submitText('hello'), (error) => error.code === 'INVALID_REQUEST');
    await check.cancel();
    assert.equal((await check.done).state, 'cancelled');
    b.setVoiceOutput('off');
    assert.equal((await b.submitText('사과 12개').done).phase, TURN_PHASE.COMPLETED);
  });
});
