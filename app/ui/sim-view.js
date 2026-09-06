// New implementation of design-p2 §7.3; no legacy code is ported.
// P3-02c: the caption list moved into caption-board.js, which also owns the
// captions-only full-screen frame. This view keeps session ownership: the
// full-screen bar buttons are created here and reuse the same handlers.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { createBinder } from './seq-view.js';
import { createCaptionBoard } from './caption-board.js';
import { errorKey, levelPercent } from './errors.js';

/** engines: {direct, hub?}, using their snapshot/subscribe/start or join/stop
 * or leave/setMuted APIs. startDirect(request) is a gesture-synchronous app
 * adapter that supplies the direct engine's context and activity ownership.
 * hubs contains code-registered {id, labelKey} entries only. The app owns
 * engine cleanup on tab/page exit; destroy only detaches this view.
 * window (wake lock) and timers default to the document's view so the shell
 * needs no new wiring; the app hands its usable storage over with
 * setStorage(storage) after mount (only app/main.js reads localStorage).
 */
export function createSimView({ root, i18n, engines, engine, hubs = [], startDirect,
  targetLanguage = 'ja', onSequential, document: doc = root?.ownerDocument, window: win = doc?.defaultView ?? null,
  storage = null, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancelTimer = globalThis.clearTimeout } = {}) {
  engines ??= { direct: engine };
  if (!root || !doc || !i18n?.t || !engines.direct?.subscribe) throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n), listeners = [];
  let mode = 'direct', target = SUPPORTED_LANGUAGES.includes(targetLanguage) ? targetLanguage : 'ja';
  let disposed = false, pending = false, snapshot, unsubscribe, headphonesHinted = false;
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
  const language = select('sim-target', 'language.target');
  const options = SUPPORTED_LANGUAGES.map(value => node('option', '', language, `language.${value}`, { value }));
  const button = (name, key, parent = controls) => node('button', `btn btn-secondary ${name}`, parent, key, { type: 'button' });
  const start = button('sim-start', 'common.start'), stop = button('sim-stop', 'common.stop');
  const sound = button('sim-sound', 'sim.enableSound');
  const source = button('sim-source', 'sim.captions.showSource');
  source.setAttribute('aria-pressed', 'false');
  const captionOnly = button('sim-caption-only', 'captionOnly.enter');
  captionOnly.setAttribute('aria-pressed', 'false');
  const fallback = button('sim-fallback', 'sim.sequentialFallback');
  const directHints = node('div', 'sim-hints', section);
  for (const key of ['sim.sourceAuto', 'sim.headphones', 'sim.seatAudio', 'sim.personalKey', 'sim.liveVoice']) node('p', '', directHints, key);
  const hubHints = node('div', 'sim-hints', section);
  for (const key of ['hub.noKeyOrMicrophone', 'hub.deviceSpeech', 'hub.recentNotice']) node('p', '', hubHints, key);
  const status = node('p', 'badge sim-status', section, null, { role: 'status' });
  // Active model and route (translation-only / auxiliary flash / fallback), always visible for direct listening.
  const route = node('p', 'sim-route', section, null, { role: 'status' });
  const output = node('p', 'sim-output', section, null, { role: 'status' });
  const broadcast = node('p', 'sim-broadcast', section, null, { role: 'status' });
  const notice = node('p', 'sim-notice', section, null, { role: 'status' });
  const meter = node('meter', 'sim-level', section, null, { min: '0', max: '100', value: '0' });
  bind.attribute(meter, 'aria-label', 'seq.inputLevel');
  const recent = node('p', 'sim-recent', section, 'sim.captions.recent');
  // Full-screen bar controls and the large start button share this view's handlers.
  const fsStop = button('sim-fs-stop', 'common.stop', null);
  const fsSound = button('sim-fs-sound', 'sim.enableSound', null);
  const fsSource = button('sim-fs-source', 'sim.captions.showSource', null);
  fsSource.setAttribute('aria-pressed', 'false');
  const fsPrimary = node('button', 'btn btn-primary sim-fs-primary', null, 'common.start', { type: 'button' });
  const board = createCaptionBoard({ parent: section, i18n, document: doc, window: win, storage,
    controls: [fsStop, fsSound, fsSource], primary: fsPrimary,
    setTimeout: schedule, clearTimeout: cancelTimer,
    onToggle(on) {
      section.setAttribute('data-caption-only', String(on));
      captionOnly.setAttribute('aria-pressed', String(on));
      if (snapshot) render();
    } });
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  const listen = (el, event, fn) => { el.addEventListener(event, fn); listeners.push(() => el.removeEventListener(event, fn)); };
  function call(fn) {
    if (disposed) return;
    try {
      const result = fn();
      const failed = () => { if (!disposed) setText(notice, i18n.t('error.unknown')); };
      if (result?.then) result.catch(failed);
      result?.ready?.catch(failed); result?.done?.catch(failed);
      return result;
    } catch { setText(notice, i18n.t('error.unknown')); }
  }
  const end = () => mode === 'hub' ? current().leave() : current().stop();
  async function change(apply) {
    if (pending || disposed) return;
    pending = true; render();
    try {
      await end();
      if (disposed) return;
      apply(); subscribe(); setText(notice, i18n.t('sim.settingsChanged'));
    } catch { if (!disposed) setText(notice, i18n.t('error.unknown')); }
    finally { pending = false; if (!disposed) render(); }
  }
  const canStart = () => !pending && !snapshot.busy && ['idle', 'stopped', 'failed'].includes(snapshot.status);
  function startSession() {
    if (!canStart()) return;
    setText(notice, '');
    // Speaker playback re-enters the microphone and can read as conversation; stress headphones once.
    if (mode === 'direct' && !headphonesHinted) { headphonesHinted = true; setText(notice, i18n.t('sim.headphonesStart')); }
    call(() => mode === 'hub' ? current().join({ hubId: venueSelect.value, roomCode: room.value, language: target })
      : (startDirect ?? (request => current().start(request)))({ targetLanguage: target }));
  }
  const stopSession = () => call(end);
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
    if (SUPPORTED_LANGUAGES.includes(next) && next !== target) void change(() => { target = next; });
  });
  for (const el of [start, fsPrimary]) listen(el, 'click', startSession);
  for (const el of [stop, fsStop]) listen(el, 'click', stopSession);
  for (const el of [sound, fsSound]) listen(el, 'click', toggleSound);
  for (const el of [source, fsSource]) listen(el, 'click', toggleSource);
  listen(captionOnly, 'click', () => board.setCaptionOnly(!board.captionOnly));
  listen(fallback, 'click', () => call(async () => { await end(); if (!disposed) onSequential?.(); }));

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
    venueSelect.parentNode.hidden = roomLabel.hidden = !hub;
    venueSelect.disabled = room.disabled = busy || pending;
    directHints.hidden = hub; hubHints.hidden = !hub; meter.hidden = hub;
    broadcast.hidden = !hub; recent.hidden = !hub || !snapshot.recentPossible;
    const allowed = hub && (snapshot.allowedLangs?.length || snapshot.status === 'running') ? snapshot.allowedLangs : SUPPORTED_LANGUAGES;
    for (const option of options) option.disabled = !allowed.includes(option.getAttribute('value'));
    start.disabled = busy || pending || !allowed.includes(target);
    stop.disabled = fsStop.disabled = !busy || pending;
    sound.disabled = fsSound.disabled = pending || snapshot.status !== 'running';
    const startKey = snapshot.status === 'failed' || snapshot.status === 'stopped' ? (hub ? 'hub.reconnect' : 'sim.restart') : (hub ? 'hub.join' : 'common.start');
    for (const el of [start, fsPrimary]) setText(el, i18n.t(startKey));
    for (const el of [stop, fsStop]) setText(el, i18n.t(hub ? 'hub.leave' : 'common.stop'));
    const soundKey = ['muted', 'blocked', 'unavailable'].includes(snapshot.output) ? 'sim.enableSound' : 'sim.mute';
    for (const el of [sound, fsSound]) setText(el, i18n.t(soundKey));
    // Before a session the full screen shows one large start button; the bar shows stop while busy.
    fsPrimary.hidden = start.disabled;
    fsStop.hidden = !busy;
    setText(status, i18n.t(`sim.status.${snapshot.status}`));
    route.hidden = hub;
    const routeKey = snapshot.fallback === true ? 'sim.route.fallback' : snapshot.route === 'flash' ? 'sim.route.flash' : 'sim.route.translation';
    setText(route, hub ? '' : `${i18n.t(routeKey)} · ${typeof snapshot.model === 'string' ? snapshot.model : ''}`);
    setText(output, i18n.t(`sim.output.${snapshot.output.replaceAll('-', '_')}`));
    setText(broadcast, hub ? i18n.t(`hub.broadcast.${snapshot.broadcast}`) : '');
    if (snapshot.errorCode) setText(notice, i18n.t(errorKey({ code: snapshot.errorCode })));
    fallback.hidden = hub || snapshot.status !== 'failed' || !onSequential;
    if (snapshot.status !== 'running') meter.setAttribute('value', '0');
    renderCaptions();
  }
  function subscribe() { unsubscribe?.(); snapshot = current().snapshot(); unsubscribe = current().subscribe(render); render(snapshot); }
  subscribe();
  return Object.freeze({ element: section, board, render,
    refresh() { if (!disposed) { bind.refresh(); board.refresh(); render(); } },
    setStorage(next) { if (!disposed) board.setStorage(next); },
    onLevel(value) { if (!disposed && mode === 'direct' && snapshot.status === 'running') meter.setAttribute('value', String(levelPercent(value))); },
    focusInput() { (mode === 'hub' ? room : start).focus(); },
    destroy() { if (disposed) return; disposed = true; unsubscribe?.(); for (const off of listeners) off(); board.destroy(); bind.clear(); room.value = ''; section.remove(); },
  });
}
