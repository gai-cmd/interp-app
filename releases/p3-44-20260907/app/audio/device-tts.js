// New browser device-speech implementation of design-v0.6 §8 and §14.
// No provider API is invoked; localService is a hint, not an offline guarantee.

/** Owns app speechSynthesis output (cancel is browser-global). One active turn.
 * speak(request, context) resolves on every terminal path; onstart is not an
 * acoustic measurement. UI must use messageKey and privacyMessageKey.
 */
export function createDeviceTTS({ speechSynthesis: synth, SpeechSynthesisUtterance: Utterance,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
  voiceWaitMs = 1500, timeoutMs = 120000 } = {}) {
  if (!Number.isFinite(voiceWaitMs) || voiceWaitMs < 0 || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0) throw new Error('AUDIO_INVALID_OPTIONS');
  let active = null, closed = false;
  function cancel() { active?.stop('cancelled', 'error.ABORTED'); }
  function speak({ text, language, voiceURI } = {}, { signal, turnId, sessionId, generation } = {}) {
    cancel();
    return new Promise((resolve) => {
      let ended = false, utterance, waitTimer, deadline, listening = false;
      const job = { stop };
      const result = { featureId: 'device-tts', turnId, sessionId, generation,
        privacyMessageKey: 'voice.devicePrivacy', offlineGuaranteed: false, localService: null };
      function stop(status, messageKey) {
        if (ended) return;
        ended = true;
        clear(waitTimer); clear(deadline);
        if (listening) synth.removeEventListener('voiceschanged', voicesChanged);
        signal?.removeEventListener('abort', abort);
        if (utterance) {
          utterance.onstart = utterance.onend = utterance.onerror = null;
          if (status !== 'completed') { try { synth.cancel(); } catch { /* Sanitized below. */ } }
          utterance.text = '';
        }
        if (active === job) active = null;
        resolve({ ...result, status, messageKey });
      }
      function abort() { stop('cancelled', 'error.ABORTED'); }
      function voicesChanged() { choose(false); }
      function choose(final) {
        if (ended || utterance) return;
        try {
          const voices = synth.getVoices();
          const lang = language.toLowerCase().replaceAll('_', '-');
          const matching = voices.filter((v) => v.lang.toLowerCase().replaceAll('_', '-').split('-')[0] === lang.split('-')[0]);
          const voice = matching.find((v) => v.voiceURI === voiceURI)
            || matching.find((v) => v.lang.toLowerCase().replaceAll('_', '-') === lang)
            || matching.find((v) => v.default) || matching[0];
          if (!voice) { if (final) stop('unavailable', 'voice.deviceUnavailable'); return; }
          clear(waitTimer);
          if (listening) { synth.removeEventListener('voiceschanged', voicesChanged); listening = false; }
          utterance = new Utterance(text);
          utterance.lang = language;
          utterance.voice = voice;
          result.localService = typeof voice.localService === 'boolean' ? voice.localService : null;
          utterance.onend = () => { if (!ended) stop('completed'); };
          utterance.onerror = () => { if (!ended) stop('failed', 'error.VOICE_FAILED'); };
          synth.speak(utterance);
        } catch { stop('failed', 'error.VOICE_FAILED'); }
      }
      active = job;
      if (closed || signal?.aborted) { abort(); return; }
      if (!synth || !Utterance) { stop('unavailable', 'voice.deviceUnavailable'); return; }
      if (typeof text !== 'string' || !text.trim() || text.length > 20000
        || typeof language !== 'string' || !/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(language)) {
        stop('failed', 'error.VOICE_FAILED'); return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      deadline = schedule(() => stop('timeout', 'error.TIMEOUT'), timeoutMs);
      try {
        if (typeof synth.addEventListener === 'function') {
          synth.addEventListener('voiceschanged', voicesChanged); listening = true;
        }
        waitTimer = schedule(() => choose(true), voiceWaitMs);
        choose(false);
      } catch { stop('failed', 'error.VOICE_FAILED'); }
    });
  }
  return { speak, cancel, close() { closed = true; cancel(); } };
}
