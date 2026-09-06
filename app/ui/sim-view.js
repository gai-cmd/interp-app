// New implementation of design-p2 §7.3; no legacy code is ported.
// P3-02c: the caption list moved into caption-board.js, which also owns the
// captions-only full-screen frame. This view keeps session ownership: the
// full-screen bar buttons are created here and reuse the same handlers.
// P3-02d: a female/male voice choice (shared with the settings voice picker
// through liveVoicePreference, gender remembered in UI storage) and a speech
// gate indicator beside the level meter.
// P3-02e: failures are shown by code (never the generic error.unknown when a
// code is known); a missing or rejected key offers "open settings"; a manual
// "reopen session" button replaces the running Live session; the status line
// counts automatic session replacements while the engine reconnects.
// P3-11 (design-p3 §1.8): venue live control. The app hands its event link over
// with setHubControl(link) after mount (like setStorage). The section offers
// explicit event participation for direct listening (event, venue, room code,
// join/leave) and shows the negotiated control state for both modes:
// supported / unsupported / stopped / lost, the control revision and the
// venue's notice text. Joining never starts the microphone, a key or speech.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { normalizeError } from '../providers/contract.js';
import { LIVE_VOICE_GENDERS, LIVE_GENDER_VOICES, DEFAULT_LIVE_VOICE_GENDER, liveVoicePreference } from '../providers/gemini/live-config.js';
import { createBinder, SOURCE_OPTIONS } from './seq-view.js';
import { createCaptionBoard, DEFAULT_DISPLAY } from './caption-board.js';
import { CAPTION_SIZE, stepCaptionSize } from '../preferences.js';
import { UNKNOWN_KEY, errorCodeKey, levelPercent, resolveKey } from './errors.js';

export const VOICE_GENDER_STORAGE_KEY = 'interp-app.ui.v1.voiceGender';
// Two-way interpretation on/off. The two languages are the ones on screen
// (owner, 2026-09-07), so nothing else is stored here.
export const TWO_WAY_STORAGE_KEY = 'interp-app.ui.v1.twoWay';
// The spoken language of the simultaneous screen; absent means automatic.
export const SIM_SOURCE_STORAGE_KEY = 'interp-app.ui.v1.simSource';
// Failure codes whose remedy is the key entry in settings.
export const KEY_FAILURE_CODES = Object.freeze(['CREDENTIAL_REQUIRED', 'CREDENTIAL_MISMATCH', 'INVALID_KEY', 'PERMISSION_DENIED']);
const codePattern = /^[A-Z][A-Z0-9_]{0,39}$/;

/**
 * The dictionary key for a failure of the listening screen: a simultaneous-
 * specific text (sim.error.CODE) when one exists, else the shared error.CODE;
 * only recognised codes are used, so no raw error text can reach the DOM.
 * Returns { code, key }; code is null when nothing specific is known.
 */
export function listenFailure(i18n, error) {
  const own = typeof error?.code === 'string' && codePattern.test(error.code) ? error.code : null;
  const normalized = normalizeError(error).code;
  const code = own && i18n.has(errorCodeKey(own)) ? own : normalized !== 'PROVIDER_ERROR' ? normalized : null;
  if (!code) return { code: null, key: UNKNOWN_KEY };
  const specific = `sim.error.${code}`;
  return { code, key: i18n.has(specific) ? specific : errorCodeKey(code) };
}
/** The remembered spoken language, or null for automatic detection. */
export function readSimSource(storage) {
  let value;
  try { value = storage?.getItem(SIM_SOURCE_STORAGE_KEY); } catch { value = null; }
  return SUPPORTED_LANGUAGES.includes(value) ? value : null;
}

/** Whether two-way interpretation was left on. The languages are its own two. */
export function readTwoWay(storage) {
  try { return storage?.getItem(TWO_WAY_STORAGE_KEY) === '1'; } catch { return false; }
}

/** The remembered gender, or the default for a missing/corrupt value. */
export function readVoiceGender(storage) {
  let value;
  try { value = storage?.getItem(VOICE_GENDER_STORAGE_KEY); } catch { value = null; }
  return LIVE_VOICE_GENDERS.includes(value) ? value : DEFAULT_LIVE_VOICE_GENDER;
}

/** engines: {direct, hub?}, using their snapshot/subscribe/start or join/stop
 * or leave/setMuted APIs. startDirect(request) is a gesture-synchronous app
 * adapter that supplies the direct engine's context and activity ownership.
 * hubs contains code-registered {id, labelKey} entries only. The app owns
 * engine cleanup on tab/page exit; destroy only detaches this view.
 * window (wake lock) and timers default to the document's view so the shell
 * needs no new wiring; the app hands its usable storage over with
 * setStorage(storage) after mount (only app/main.js reads localStorage).
 * onOpenSettings() is offered as an action when the failure is a key problem.
 * setHubControl(link) (P3-11) receives the app's event link: { snapshot(),
 * subscribe(fn), join({ eventId, hubId, roomCode }), leave() } whose snapshot is
 * { enabled, controlOnlyAllowed, allowedHubIds, events: [{ id, label, eventName,
 * status }], joined: { eventId, hubId } | null, connection, errorCode, control }.
 * Event labels are policy text shown as text; every other string is a key.
 */
export function createSimView({ root, i18n, engines, engine, hubs = [], startDirect,
  targetLanguage = 'ja', onSequential, onOpenSettings, document: doc = root?.ownerDocument, window: win = doc?.defaultView ?? null,
  storage = null, voicePreference = liveVoicePreference,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout } = {}) {
  engines ??= { direct: engine };
  if (!root || !doc || !i18n?.t || !engines.direct?.subscribe) throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n), listeners = [];
  let mode = 'direct', target = SUPPORTED_LANGUAGES.includes(targetLanguage) ? targetLanguage : 'ja';
  // Two-way state: whether it is on. Its two languages are the 발화 / 도착
  // selects, so there is no third control to keep in step.
  let twoWay = false;
  // 'auto' keeps the previous behaviour (the model decides from what it hears).
  let spoken = 'auto';
  let disposed = false, pending = false, snapshot, unsubscribe, headphonesHinted = false, store = storage, speaking = false;
  // The last failure of this screen (start rejected before the engine ran, or
  // a rejected handle); the engine's own errorCode is read from the snapshot.
  let failure = null;
  const current = () => engines[mode];
  const node = (tag, name, parent, key, attrs = {}) => {
    const el = doc.createElement(tag);
    el.setAttribute('class', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (key) bind.text(el, key);
    parent?.append(el); return el;
  };
  const section = node('section', 'sim', root, null, { 'data-caption-only': 'false' });
  const controls = node('div', 'sim-controls', section);
  const select = (name, key) => {
    const label = node('label', 'sim-field', controls);
    node('span', '', label, key);
    return node('select', name, label);
  };
  const modeSelect = select('sim-mode', 'sim.listenMode');
  node('option', '', modeSelect, 'sim.direct', { value: 'direct' });
  if (engines.hub && hubs.length) node('option', '', modeSelect, 'sim.hub', { value: 'hub' });
  const venueSelect = select('sim-venue', 'hub.venue');
  for (const hub of hubs) node('option', '', venueSelect, hub.labelKey, { value: hub.id });
  venueSelect.value = hubs[0]?.id ?? '';
  const roomLabel = node('label', 'sim-field', controls);
  node('span', '', roomLabel, 'hub.roomCode');
  const room = node('input', 'sim-room', roomLabel, null,
    { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '128' });
  bind.attribute(room, 'placeholder', 'hub.roomCodePlaceholder');
  // Owner, 2026-09-07: the simultaneous screen had no source language at all,
  // so the model was left to guess what it was hearing — a Korean speaker
  // asking for Japanese could get English. Both ends are now chosen here.
  const sourceSelect = select('sim-spoken', 'language.source');
  for (const value of SOURCE_OPTIONS) {
    node('option', '', sourceSelect, value === 'auto' ? 'language.auto' : `language.${value}`, { value });
  }
  const language = select('sim-target', 'language.target');
  const options = SUPPORTED_LANGUAGES.map(value => node('option', '', language, `language.${value}`, { value }));
  // Two-way (owner, 2026-09-06): one microphone, one session, and the direction
  // decided per utterance by the language heard. The target select keeps its
  // meaning — it is one side of the pair — and a second select names the other.
  const twoWayRow = node('label', 'sim-field sim-two-way', controls);
  const twoWayInput = node('input', 'sim-two-way-input', twoWayRow, null, { type: 'checkbox', id: 'sim-two-way' });
  const twoWayText = node('span', '', twoWayRow, 'sim.twoWay');
  const twoWayPair = node('p', 'sim-two-way-pair', controls, null, { role: 'status' });
  const twoWayHint = node('p', 'sim-two-way-hint', controls, 'sim.twoWay.hint');
  const twoWayVoice = node('p', 'sim-two-way-voice', controls, 'sim.twoWay.oneVoice');
  // Voice: gender only in this scope; the effective voice is resolved by live-config.
  const voice = select('sim-voice', 'sim.voice');
  for (const value of LIVE_VOICE_GENDERS) node('option', '', voice, `sim.voice.${value}`, { value });
  const voiceLabel = voice.parentNode;
  const button = (name, key, parent = controls) => node('button', `btn btn-secondary ${name}`, parent, key, { type: 'button' });
  // Placed in the source row, but built here because `button` is defined above.
  const swap = button('sim-swap', 'language.swap', sourceSelect.parentNode);
  const start = button('sim-start', 'common.start'), stop = button('sim-stop', 'common.stop');
  const sound = button('sim-sound', 'sim.enableSound');
  const source = button('sim-source', 'sim.captions.showSource');
  source.setAttribute('aria-pressed', 'false');
  const captionOnly = button('sim-caption-only', 'captionOnly.enter');
  captionOnly.setAttribute('aria-pressed', 'false');
  // Manual session replacement while a direct session runs or reconnects.
  const reopen = button('sim-reopen', 'sim.reopen');
  const fallback = button('sim-fallback', 'sim.sequentialFallback');
  // Key problems point to the settings key entry instead of a generic notice.
  const openSettings = button('sim-open-settings', 'sim.openSettings');
  openSettings.setAttribute('aria-haspopup', 'dialog');
  const directHints = node('div', 'sim-hints', section);
  for (const key of ['sim.sourceAuto', 'sim.headphones', 'sim.seatAudio', 'sim.personalKey', 'sim.liveVoice']) node('p', '', directHints, key);
  const hubHints = node('div', 'sim-hints', section);
  for (const key of ['hub.noKeyOrMicrophone', 'hub.deviceSpeech', 'hub.recentNotice']) node('p', '', hubHints, key);
  // P3-11: venue live control; hidden until the app hands its event link over
  // and the site policy enables hub control.
  const control = node('div', 'sim-control', section);
  control.hidden = true;
  node('h2', 'sim-control-title', control, 'hubControl.title');
  const eventLabel = node('label', 'sim-field', control);
  node('span', '', eventLabel, 'event.select');
  const eventSelect = node('select', 'sim-event', eventLabel);
  const eventNone = node('p', 'sim-event-none', control, 'event.none');
  const eventName = node('p', 'sim-event-name', control);
  const eventJoin = button('sim-event-join', 'event.join', control);
  const eventLeave = button('sim-event-leave', 'event.leave', control);
  const controlStatus = node('p', 'badge sim-control-status', control, null, { role: 'status', 'data-control': 'none' });
  const controlRevision = node('p', 'sim-control-revision', control);
  // The venue's notice is plain text in the UI language, never markup.
  const controlNotice = node('p', 'sim-control-notice', control, null, { role: 'status' });
  const eventError = node('p', 'sim-event-error', control, null, { role: 'status' });
  const controlHints = node('div', 'sim-hints', control);
  const controlOnlyHint = node('p', '', controlHints, 'hubControl.controlOnly');
  node('p', '', controlHints, 'hubControl.releaseOnly');
  node('p', '', controlHints, 'hubControl.scope');
  const unsupportedHint = node('p', '', controlHints, 'hubControl.unsupportedHint');
  let link = null, unsubscribeLink = null, eventFailure = null, eventOptions = '';
  const status = node('p', 'badge sim-status', section, null, { role: 'status' });
  // Active model and route (translation-only / auxiliary flash / fallback), always visible for direct listening.
  const route = node('p', 'sim-route', section, null, { role: 'status' });
  const output = node('p', 'sim-output', section, null, { role: 'status' });
  const broadcast = node('p', 'sim-broadcast', section, null, { role: 'status' });
  const notice = node('p', 'sim-notice', section, null, { role: 'status' });
  const meter = node('meter', 'sim-level', section, null, { min: '0', max: '100', value: '0' });
  bind.attribute(meter, 'aria-label', 'seq.inputLevel');
  // Gate state: "no speech" while only music/noise (or nothing) reaches the microphone.
  const speech = node('p', 'badge sim-speech', section, null, { role: 'status', 'data-speech': 'none' });
  speech.hidden = true;
  const recent = node('p', 'sim-recent', section, 'sim.captions.recent');
  // P3-18: the caption board carries its own size on top of the app text size
  // (§1.10), so the 가−/가+ buttons and the high-contrast toggle sit next to
  // the board itself and not in the app-wide display settings. They move the
  // same stored value as the caption-only slider and the settings screen.
  const captionControls = node('div', 'sim-caption-controls', section, null, { role: 'group' });
  bind.attribute(captionControls, 'aria-label', 'display.captions.size');
  const smaller = button('sim-caption-smaller', 'display.captions.smaller', captionControls);
  const sizeValue = node('output', 'sim-caption-size', captionControls);
  const larger = button('sim-caption-larger', 'display.captions.larger', captionControls);
  const contrast = button('sim-caption-contrast', 'captionOnly.display.mono', captionControls);
  contrast.setAttribute('aria-pressed', 'false');
  node('p', 'sim-caption-range', captionControls, 'display.captions.range');
  // Full-screen bar controls and the large start button share this view's handlers.
  const fsStop = button('sim-fs-stop', 'common.stop', null);
  const fsSound = button('sim-fs-sound', 'sim.enableSound', null);
  const fsSource = button('sim-fs-source', 'sim.captions.showSource', null);
  fsSource.setAttribute('aria-pressed', 'false');
  const fsReopen = button('sim-fs-reopen', 'sim.reopen', null);
  const fsPrimary = node('button', 'btn btn-primary sim-fs-primary', null, 'common.start', { type: 'button' });
  const board = createCaptionBoard({ parent: section, i18n, document: doc, window: win, storage,
    controls: [fsStop, fsSound, fsSource, fsReopen], primary: fsPrimary,
    setTimeout: schedule, clearTimeout: cancelTimer,
    onToggle(on) {
      section.setAttribute('data-caption-only', String(on));
      captionOnly.setAttribute('aria-pressed', String(on));
      if (snapshot) render();
    } });
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  const listen = (el, event, fn) => { el.addEventListener(event, fn); listeners.push(() => el.removeEventListener(event, fn)); };
  // A failure is rendered by its code; the raw error is dropped here.
  function fail(error) {
    if (disposed) return;
    failure = listenFailure(i18n, error);
    render();
  }
  function call(fn) {
    if (disposed) return;
    try {
      const result = fn();
      if (result?.then) result.catch(fail);
      result?.ready?.catch(fail); result?.done?.catch(fail);
      return result;
    } catch (error) { fail(error); }
  }
  const end = () => mode === 'hub' ? current().leave() : current().stop();
  async function change(apply) {
    if (pending || disposed) return;
    pending = true; render();
    try {
      await end();
      if (disposed) return;
      apply(); subscribe(); setText(notice, i18n.t('sim.settingsChanged'));
    } catch (error) { fail(error); }
    finally { pending = false; if (!disposed) render(); }
  }
  /** The two languages to interpret between, or null when one-way. */
  /** Two-way interprets between the two languages already on screen. */
  function twoWayPair2() {
    if (!twoWay || mode !== 'direct') return null;
    // Owner, 2026-09-07: the pair IS 발화 ↔ 도착. There is no third language
    // control, so what the screen shows is what the session interprets between.
    if (!SUPPORTED_LANGUAGES.includes(spoken) || spoken === target) return null;
    return [spoken, target];
  }
  /** The first supported language that is not `language`. */
  const otherThan = (language) => SUPPORTED_LANGUAGES.find((value) => value !== language) ?? null;
  function renderTwoWay() {
    // Two-way needs a microphone of our own: a hub listener receives a finished
    // broadcast and has no direction to choose.
    const applies = mode === 'direct';
    twoWayRow.hidden = !applies;
    twoWayInput.checked = twoWay && applies;
    twoWayInput.disabled = pending;
    const on = applies && twoWay;
    twoWayHint.hidden = !on;
    twoWayVoice.hidden = !on;
    twoWayPair.hidden = !on;
    if (on) {
      const pair = twoWayPair2();
      setText(twoWayPair, pair === null ? i18n.t('sim.twoWay.sameLanguage')
        : i18n.t('sim.twoWay.pair', { source: i18n.t(`language.${pair[0]}`), target: i18n.t(`language.${pair[1]}`) }));
    }
  }
  listen(twoWayInput, 'change', () => {
    twoWay = twoWayInput.checked === true;
    // Two-way has to know both ends, so an automatic source is resolved to a
    // real language the moment it is turned on.
    if (twoWay && (spoken === 'auto' || spoken === target)) {
      spoken = otherThan(target) ?? spoken;
      rememberLanguages();
    }
    rememberTwoWay();
    if (mode === 'direct' && running()) setText(notice, i18n.t('sim.voiceRestart'));
    render();
  });
  function rememberTwoWay() {
    try {
      if (twoWay) store?.setItem(TWO_WAY_STORAGE_KEY, '1');
      else store?.removeItem(TWO_WAY_STORAGE_KEY);
    } catch { /* Storage refusal keeps the in-memory choice. */ }
  }
  function restoreTwoWay() {
    twoWay = readTwoWay(store);
    if (twoWay && (spoken === 'auto' || spoken === target)) spoken = otherThan(target) ?? spoken;
    renderTwoWay();
  }

  const canStart = () => !pending && !snapshot.busy && ['idle', 'stopped', 'failed'].includes(snapshot.status);
  function startSession() {
    if (!canStart()) return;
    failure = null;
    setText(notice, '');
    // Speaker playback re-enters the microphone and can read as conversation; stress headphones once.
    if (mode === 'direct' && !headphonesHinted) { headphonesHinted = true; setText(notice, i18n.t('sim.headphonesStart')); }
    const pair = twoWayPair2();
    call(() => mode === 'hub' ? current().join({ hubId: venueSelect.value, roomCode: room.value, language: target })
      : (startDirect ?? (request => current().start(request)))({
        targetLanguage: target,
        ...(spoken === 'auto' ? {} : { sourceLanguage: spoken }),
        ...(pair === null ? {} : { languages: pair }) }));
  }
  const stopSession = () => call(end);
  // Manual "reopen session": physical close of the current direct session,
  // then a fresh start with the same settings (a new recovery budget).
  function reopenSession() {
    if (pending || disposed || mode !== 'direct' || !running()) return;
    pending = true; render();
    call(async () => {
      try { await end(); }
      finally { pending = false; }
      if (disposed) return;
      render();
      startSession();
    });
  }
  const toggleSound = () => call(() => current().setMuted(!['muted', 'blocked', 'unavailable'].includes(snapshot.output)));
  const sourceShown = () => source.getAttribute('aria-pressed') === 'true';
  function toggleSource() {
    const next = String(!sourceShown());
    source.setAttribute('aria-pressed', next); fsSource.setAttribute('aria-pressed', next);
    render();
  }
  listen(modeSelect, 'change', () => { const next = modeSelect.value;
    if (next !== mode && (next === 'direct' || (next === 'hub' && engines.hub && hubs.length))) void change(() => { mode = next; board.clear(); });
  });
  listen(language, 'change', () => { const next = language.value;
    if (!SUPPORTED_LANGUAGES.includes(next) || next === target) return;
    void change(() => {
      target = next;
      // Interpreting a language into itself is a no-op; the other end moves
      // away rather than the app silently doing nothing.
      if (spoken !== 'auto' && spoken === target) {
        spoken = otherThan(target) ?? spoken;
        rememberLanguages();
      }
    });
  });
  listen(sourceSelect, 'change', () => {
    const next = sourceSelect.value;
    if (!SOURCE_OPTIONS.includes(next) || next === spoken) return;
    // A source equal to the target would ask for a no-op; move the target away
    // rather than silently interpreting into the language just spoken.
    void change(() => {
      spoken = next;
      if (spoken !== 'auto' && spoken === target) target = SUPPORTED_LANGUAGES.find((value) => value !== spoken) ?? target;
      rememberLanguages();
    });
  });
  listen(swap, 'click', () => {
    if (spoken === 'auto') return;
    void change(() => { const previous = target; target = spoken; spoken = previous; rememberLanguages(); });
  });
  function rememberLanguages() {
    try {
      if (spoken === 'auto') store?.removeItem(SIM_SOURCE_STORAGE_KEY);
      else store?.setItem(SIM_SOURCE_STORAGE_KEY, spoken);
    } catch { /* Storage refusal keeps the in-memory choice. */ }
  }
  function restoreLanguages() {
    const remembered = readSimSource(store);
    if (remembered === null) return;
    spoken = remembered;
    // A remembered spoken language that equals the default target moves the
    // target, not the choice the person actually made.
    if (spoken === target) target = otherThan(spoken) ?? target;
  }
  const running = () => Boolean(snapshot?.busy) || !['idle', 'stopped', 'failed'].includes(snapshot?.status);
  // A voice change never stops the session: it applies at the next start (restart notice).
  listen(voice, 'change', () => {
    const next = voice.value;
    if (!LIVE_VOICE_GENDERS.includes(next)) return;
    // Comparing genders alone was not enough: the settings screen can select a
    // voice that belongs to neither gender (Puck, Charon, ...), which leaves the
    // gender unclaimed. Re-picking the gender shown must then still take effect,
    // so the decision is made on the voice that would actually speak.
    if (voicePreference.snapshot().voiceName === LIVE_GENDER_VOICES[next]) return;
    call(() => voicePreference.set({ gender: next }));
    if (mode === 'direct' && running()) setText(notice, i18n.t('sim.voiceRestart'));
  });
  function rememberVoice(value) {
    try { if (value === DEFAULT_LIVE_VOICE_GENDER) store?.removeItem(VOICE_GENDER_STORAGE_KEY); else store?.setItem(VOICE_GENDER_STORAGE_KEY, value); }
    catch { /* Storage refusal keeps the in-memory choice. */ }
  }
  // A voice chosen by name in settings has no gender this app can claim; the
  // select then shows that voice name rather than lying about the gender.
  const customVoice = node('option', 'sim-voice-custom', voice, null, { value: '' });
  function showVoice(value) {
    const named = value.gender === null && typeof value.voiceName === 'string';
    customVoice.hidden = !named;
    // Provider voice identifiers are registered data, not dictionary text
    // (the settings picker renders them the same way).
    customVoice.textContent = named ? value.voiceName : '';
    voice.value = named ? '' : value.gender;
  }
  const unsubscribeVoice = voicePreference.subscribe(value => {
    if (disposed) return;
    showVoice(value);
    if (value.gender !== null) rememberVoice(value.gender);
  });
  function restoreVoice() {
    const remembered = readVoiceGender(store);
    // An explicit voice picked in settings outranks a remembered gender; only a
    // still-gendered preference is restored from storage.
    if (voicePreference.snapshot().gender !== null && remembered !== voicePreference.snapshot().gender) {
      call(() => voicePreference.set({ gender: remembered }));
    }
    showVoice(voicePreference.snapshot());
  }
  restoreVoice();
  restoreLanguages();
  restoreTwoWay();
  for (const el of [start, fsPrimary]) listen(el, 'click', startSession);
  for (const el of [stop, fsStop]) listen(el, 'click', stopSession);
  for (const el of [sound, fsSound]) listen(el, 'click', toggleSound);
  for (const el of [source, fsSource]) listen(el, 'click', toggleSource);
  for (const el of [reopen, fsReopen]) listen(el, 'click', reopenSession);
  listen(openSettings, 'click', () => { if (typeof onOpenSettings === 'function') call(onOpenSettings); });
  listen(captionOnly, 'click', () => board.setCaptionOnly(!board.captionOnly));
  // The buttons report the value they produced, so a press at either end is
  // visibly a no-op instead of silently doing nothing.
  function renderCaptionControls() {
    const size = board.size;
    setText(sizeValue, i18n.t('display.captions.value', { size: String(size) }));
    sizeValue.setAttribute('aria-live', 'polite');
    smaller.disabled = size <= CAPTION_SIZE.min;
    larger.disabled = size >= CAPTION_SIZE.max;
    const high = board.display === 'mono';
    contrast.setAttribute('aria-pressed', String(high));
  }
  const stepSize = (direction) => { board.setSize(stepCaptionSize(board.size, direction)); renderCaptionControls(); };
  listen(smaller, 'click', () => stepSize(-1));
  listen(larger, 'click', () => stepSize(1));
  // High contrast is a toggle here, not the three-way cycle of the full-screen
  // bar: pressing it turns the monochrome mode on, pressing it again restores
  // the saved-by-default dark board.
  listen(contrast, 'click', () => { board.setDisplay(board.display === 'mono' ? DEFAULT_DISPLAY : 'mono'); renderCaptionControls(); });
  renderCaptionControls();
  listen(fallback, 'click', () => call(async () => { await end(); if (!disposed) onSequential?.(); }));
  // Event participation is a gesture; a refused join is named by its code here.
  listen(eventSelect, 'change', () => render());
  listen(eventJoin, 'click', () => {
    if (!link || pending || disposed) return;
    eventFailure = null;
    try { link.join({ eventId: eventSelect.value, hubId: venueSelect.value, roomCode: room.value }); }
    catch (error) { eventFailure = listenFailure(i18n, error); }
    render();
  });
  listen(eventLeave, 'click', () => { if (link) { eventFailure = null; call(() => link.leave()); } });
  const eventText = (entry) => (typeof entry.label?.[i18n.language] === 'string' ? entry.label[i18n.language]
    : typeof entry.eventName === 'string' ? entry.eventName : entry.id);
  const activeEvent = (events, id) => events.some(entry => entry.id === id && entry.status === 'active');

  // The control section: returns the link snapshot when the section is shown.
  function renderControl(hub) {
    const ls = link?.snapshot() ?? null;
    control.hidden = !ls?.enabled;
    if (!ls?.enabled) return null;
    const joined = ls.joined, events = ls.events;
    // Rebuild the event options only when the list, statuses or language change.
    const signature = `${i18n.language}|${events.map(entry => `${entry.id}:${entry.status}`).join(',')}`;
    if (signature !== eventOptions) {
      eventOptions = signature;
      const previous = eventSelect.value;
      for (const option of [...eventSelect.children]) option.remove();
      for (const entry of events) {
        const option = node('option', '', eventSelect, null, { value: entry.id });
        setText(option, `${eventText(entry)} · ${i18n.t(resolveKey(i18n, `event.status.${entry.status}`))}`);
        option.disabled = entry.status !== 'active';
      }
      const chosen = activeEvent(events, previous) ? previous : events.find(entry => entry.status === 'active')?.id ?? '';
      eventSelect.value = chosen;
    }
    eventNone.hidden = joined !== null || events.length > 0;
    eventLabel.hidden = joined !== null || events.length === 0;
    eventSelect.disabled = pending;
    eventJoin.hidden = joined !== null || events.length === 0;
    eventJoin.disabled = pending || !activeEvent(events, eventSelect.value) || !ls.allowedHubIds.includes(venueSelect.value);
    eventLeave.hidden = joined === null;
    eventLeave.disabled = pending;
    const entry = joined ? events.find(item => item.id === joined.eventId) : null;
    eventName.hidden = joined === null;
    setText(eventName, joined ? `${i18n.t('event.name')}: ${entry ? eventText(entry) : joined.eventId}` : '');
    // Stopped wins over a lost heartbeat; before any hello the connection state shows.
    const c = ls.control;
    const state = joined === null ? null : c.stopped ? 'stopped' : c.heartbeatLost ? 'lost'
      : c.supported === true ? 'supported' : c.supported === false ? 'unsupported' : null;
    const connection = hub && snapshot?.busy ? snapshot.status : ls.connection;
    controlStatus.hidden = joined === null;
    controlStatus.setAttribute('data-control', state ?? (joined ? connection : 'none'));
    setText(controlStatus, joined === null ? '' : i18n.t(resolveKey(i18n, state ? `hubControl.${state}` : `sim.status.${connection}`)));
    controlRevision.hidden = joined === null || c.revision === null;
    setText(controlRevision, joined !== null && c.revision !== null ? i18n.t('hubControl.revision', { revision: String(c.revision) }) : '');
    const text = joined !== null ? c.notice?.text?.[i18n.language] : undefined;
    controlNotice.hidden = typeof text !== 'string';
    setText(controlNotice, typeof text === 'string' ? text : '');
    unsupportedHint.hidden = state !== 'unsupported';
    controlOnlyHint.hidden = hub;
    const errorKey = eventFailure ? eventFailure.key : ls.errorCode ? resolveKey(i18n, errorCodeKey(ls.errorCode)) : null;
    eventError.hidden = errorKey === null;
    setText(eventError, errorKey ? i18n.t(errorKey) : '');
    return ls;
  }

  function renderCaptions() {
    const data = snapshot.captions;
    const visible = (data?.captions ?? []).filter(c => (c.role !== 'source' || sourceShown())
      && (mode !== 'hub' || c.role === 'source' || c.lang === target));
    board.render({ captions: visible, skippedSegments: snapshot.skippedSegments, gaps: data?.gaps, lang: target,
      announceFirstFinal: mode === 'direct', status: status.textContent, notice: notice.textContent });
  }
  function render(next = current().snapshot()) {
    if (disposed) return;
    snapshot = next;
    const hub = mode === 'hub', busy = snapshot.busy || !['idle', 'stopped', 'failed'].includes(snapshot.status);
    modeSelect.value = mode; language.value = target;
    modeSelect.disabled = language.disabled = pending;
    // Direct listening shows venue and room code only while an event can be joined (P3-11).
    const ls = renderControl(hub);
    const eventUi = !hub && ls !== null && ls.joined === null && ls.events.length > 0;
    venueSelect.parentNode.hidden = roomLabel.hidden = !hub && !eventUi;
    venueSelect.disabled = room.disabled = busy || pending;
    for (const option of venueSelect.children) option.disabled = eventUi && !ls.allowedHubIds.includes(option.getAttribute('value'));
    if (eventUi && !ls.allowedHubIds.includes(venueSelect.value)) {
      const allowed = hubs.find(entry => ls.allowedHubIds.includes(entry.id));
      if (allowed) { venueSelect.value = allowed.id; eventJoin.disabled = pending || !activeEvent(ls.events, eventSelect.value); }
    }
    // Hub listening uses device speech, so the provider voice choice is hidden there.
    voiceLabel.hidden = hub; voice.disabled = pending;
    sourceSelect.value = spoken;
    sourceSelect.disabled = pending || hub;
    sourceSelect.parentNode.hidden = hub;
    swap.disabled = pending || spoken === 'auto';
    renderTwoWay();
    directHints.hidden = hub; hubHints.hidden = !hub; meter.hidden = hub;
    speech.hidden = hub || snapshot.status !== 'running';
    broadcast.hidden = !hub; recent.hidden = !hub || !snapshot.recentPossible;
    // A running hub with no declared languages offers none; an engine that
    // reports no list at all must not crash the render.
    const declared = Array.isArray(snapshot.allowedLangs) ? snapshot.allowedLangs : null;
    const allowed = hub && declared && (declared.length || snapshot.status === 'running') ? declared : SUPPORTED_LANGUAGES;
    for (const option of options) option.disabled = !allowed.includes(option.getAttribute('value'));
    start.disabled = busy || pending || !allowed.includes(target);
    stop.disabled = fsStop.disabled = !busy || pending;
    sound.disabled = fsSound.disabled = pending || snapshot.status !== 'running';
    // After a failure the primary action reads "reopen session"; after a user stop, "restart".
    const startKey = hub ? (snapshot.status === 'failed' || snapshot.status === 'stopped' ? 'hub.reconnect' : 'hub.join')
      : snapshot.status === 'failed' ? 'sim.reopen' : snapshot.status === 'stopped' ? 'sim.restart' : 'common.start';
    for (const el of [start, fsPrimary]) setText(el, i18n.t(startKey));
    for (const el of [stop, fsStop]) setText(el, i18n.t(hub ? 'hub.leave' : 'common.stop'));
    const soundKey = ['muted', 'blocked', 'unavailable'].includes(snapshot.output) ? 'sim.enableSound' : 'sim.mute';
    for (const el of [sound, fsSound]) setText(el, i18n.t(soundKey));
    // Before a session the full screen shows one large start button; the bar shows stop while busy.
    fsPrimary.hidden = start.disabled;
    fsStop.hidden = !busy;
    // Manual replacement is offered only while a direct session exists.
    reopen.hidden = fsReopen.hidden = hub || !busy;
    reopen.disabled = fsReopen.disabled = pending;
    // Automatic replacement shows its count: "replacing session · n".
    const retries = Number.isInteger(snapshot.retries) && snapshot.retries > 0 ? snapshot.retries : 0;
    setText(status, !hub && snapshot.status === 'reconnecting' ? i18n.t('sim.status.replacing', { count: retries })
      : i18n.t(`sim.status.${snapshot.status}`));
    route.hidden = hub;
    const routeKey = snapshot.fallback === true ? 'sim.route.fallback' : snapshot.route === 'flash' ? 'sim.route.flash' : 'sim.route.translation';
    setText(route, hub ? '' : `${i18n.t(routeKey)} · ${typeof snapshot.model === 'string' ? snapshot.model : ''}`);
    setText(output, i18n.t(`sim.output.${snapshot.output.replaceAll('-', '_')}`));
    setText(broadcast, hub ? i18n.t(`hub.broadcast.${snapshot.broadcast}`) : '');
    // A failure of this screen wins over the engine's last result; both are codes only.
    const shown = failure ?? (snapshot.errorCode ? listenFailure(i18n, { code: snapshot.errorCode }) : null);
    if (shown) setText(notice, i18n.t(shown.key));
    openSettings.hidden = hub || !shown || !KEY_FAILURE_CODES.includes(shown.code) || typeof onOpenSettings !== 'function';
    fallback.hidden = hub || snapshot.status !== 'failed' || !onSequential;
    if (snapshot.status !== 'running') { meter.setAttribute('value', '0'); speaking = false; }
    renderSpeech();
    renderCaptions();
  }
  function renderSpeech() {
    speech.setAttribute('data-speech', speaking ? 'detected' : 'none');
    setText(speech, i18n.t(speaking ? 'sim.speech.detected' : 'sim.speech.none'));
  }
  function subscribe() { unsubscribe?.(); snapshot = current().snapshot(); unsubscribe = current().subscribe(render); render(snapshot); }
  subscribe();
  return Object.freeze({ element: section, board, render,
    refresh() { if (!disposed) { bind.refresh(); board.refresh(); renderCaptionControls(); render(); } },
    setStorage(next) { if (!disposed) { store = next; board.setStorage(next); renderCaptionControls(); restoreVoice(); restoreLanguages(); restoreTwoWay(); render(); } },
    // P3-11: the app's event link (null detaches); the section re-renders on its changes.
    setHubControl(next) {
      if (disposed) return;
      unsubscribeLink?.(); unsubscribeLink = null; eventFailure = null; eventOptions = '';
      link = next && typeof next.snapshot === 'function' && typeof next.subscribe === 'function' ? next : null;
      if (link) unsubscribeLink = link.subscribe(() => { if (!disposed) render(); });
      render();
    },
    // Level events carry gate: 'open' | 'closed' from capture.js; the streaming
    // capture reports gated frames as exact silence, so rms 0 also reads "no speech".
    onLevel(value) {
      if (disposed || mode !== 'direct' || snapshot.status !== 'running') return;
      meter.setAttribute('value', String(levelPercent(value)));
      speaking = value?.gate !== undefined ? value.gate === 'open' : Number(value?.rms) > 0;
      renderSpeech();
    },
    focusInput() { (mode === 'hub' ? room : start).focus(); },
    destroy() {
      if (disposed) return;
      disposed = true; unsubscribe?.(); unsubscribeVoice(); unsubscribeLink?.(); link = null;
      for (const off of listeners) off(); board.destroy(); bind.clear(); room.value = ''; section.remove();
    },
  });
}
