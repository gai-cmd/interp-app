// New implementation of design-p2 §7.3; no legacy code is ported.
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { MAX_CAPTIONS } from '../engine/caption-store.js';
import { createBinder } from './seq-view.js';
import { errorKey, levelPercent } from './errors.js';

/** engines: {direct, hub?}, using their snapshot/subscribe/start or join/stop
 * or leave/setMuted APIs. startDirect(request) is a gesture-synchronous app
 * adapter that supplies the direct engine's context and activity ownership.
 * hubs contains code-registered {id, labelKey} entries only. The app owns
 * engine cleanup on tab/page exit; destroy only detaches this view.
 */
export function createSimView({ root, i18n, engines, engine, hubs = [], startDirect,
  targetLanguage = 'ja', onSequential, document: doc = root?.ownerDocument } = {}) {
  engines ??= { direct: engine };
  if (!root || !doc || !i18n?.t || !engines.direct?.subscribe) throw new Error('INVALID_REQUEST');
  const bind = createBinder(i18n), rows = new Map(), listeners = [];
  let mode = 'direct', target = SUPPORTED_LANGUAGES.includes(targetLanguage) ? targetLanguage : 'ja';
  let disposed = false, pending = false, following = true, snapshot, unsubscribe, headphonesHinted = false;
  const current = () => engines[mode];
  const node = (tag, name, parent, key, attrs = {}) => {
    const el = doc.createElement(tag);
    el.setAttribute('class', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (key) bind.text(el, key);
    parent?.append(el); return el;
  };
  const section = node('section', 'sim', root);
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
  const button = (name, key) => node('button', `btn btn-secondary ${name}`, controls, key, { type: 'button' });
  const start = button('sim-start', 'common.start'), stop = button('sim-stop', 'common.stop');
  const sound = button('sim-sound', 'sim.enableSound');
  const source = button('sim-source', 'sim.captions.showSource');
  source.setAttribute('aria-pressed', 'false');
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
  const gaps = Object.fromEntries(['input', 'audio', 'reception'].map(cause =>
    [cause, node('p', `sim-gap-${cause}`, section, `sim.gap.${cause}`, { role: 'status' })]));
  const recent = node('p', 'sim-recent', section, 'sim.captions.recent');
  const empty = node('p', 'sim-empty', section, 'sim.captions.empty');
  const list = node('div', 'sim-captions', section, null, { tabindex: '0', 'aria-live': 'off' });
  bind.attribute(list, 'aria-label', 'sim.captions.latest');
  const announcement = node('p', 'sr-only sim-announcement', section, null, { 'aria-live': 'polite', 'aria-atomic': 'true' });
  const latest = node('button', 'btn btn-secondary sim-latest', section, 'sim.captions.latest', { type: 'button' });
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
  listen(modeSelect, 'change', () => { const next = modeSelect.value;
    if (next !== mode && (next === 'direct' || (next === 'hub' && engines.hub && hubs.length))) void change(() => { mode = next; rows.clear(); list.textContent = ''; following = true; });
  });
  listen(language, 'change', () => { const next = language.value;
    if (SUPPORTED_LANGUAGES.includes(next) && next !== target) void change(() => { target = next; });
  });
  listen(start, 'click', () => {
    if (pending || snapshot.busy || !['idle', 'stopped', 'failed'].includes(snapshot.status)) return;
    setText(notice, '');
    // Speaker playback re-enters the microphone and can read as conversation; stress headphones once.
    if (mode === 'direct' && !headphonesHinted) { headphonesHinted = true; setText(notice, i18n.t('sim.headphonesStart')); }
    call(() => mode === 'hub' ? current().join({ hubId: venueSelect.value, roomCode: room.value, language: target })
      : (startDirect ?? (request => current().start(request)))({ targetLanguage: target }));
  });
  listen(stop, 'click', () => call(end));
  listen(sound, 'click', () => call(() => current().setMuted(!['muted', 'blocked', 'unavailable'].includes(snapshot.output))));
  listen(source, 'click', () => { source.setAttribute('aria-pressed', String(source.getAttribute('aria-pressed') !== 'true')); render(); });
  listen(fallback, 'click', () => call(async () => { await end(); if (!disposed) onSequential?.(); }));
  listen(list, 'scroll', () => { following = list.scrollHeight - list.clientHeight - list.scrollTop <= 24; latest.hidden = following; });
  listen(latest, 'click', () => { following = true; list.scrollTop = list.scrollHeight; latest.hidden = true; });

  function renderCaptions() {
    const data = snapshot.captions;
    const visible = (data?.captions ?? []).filter(c => (c.role !== 'source' || source.getAttribute('aria-pressed') === 'true')
      && (mode !== 'hub' || c.role === 'source' || c.lang === target));
    const settled = visible.filter(c => c.status !== 'partial').slice(-MAX_CAPTIONS);
    const keep = new Set([...settled, ...visible.filter(c => c.status === 'partial')].map(c => c.id));
    // Keep the first surviving visible row fixed even when the oldest row is
    // evicted. CSS disables native anchoring to avoid applying compensation twice.
    const top = list.getBoundingClientRect?.().top ?? 0;
    const anchor = [...rows].find(([id, row]) => keep.has(id) && (row.el.getBoundingClientRect?.().bottom ?? 0) > top);
    const before = anchor?.[1].el.getBoundingClientRect?.().top;
    for (const [id, row] of rows) if (!keep.has(id)) { row.el.remove(); rows.delete(id); }
    let finalText = '';
    for (const c of visible.filter(c => keep.has(c.id))) {
      let row = rows.get(c.id);
      if (!row) {
        const el = node('article', 'sim-caption', list);
        row = { el, label: node('span', 'turn-label', el), text: node('p', 'turn-text', el), status: null };
        rows.set(c.id, row);
      }
      const text = c.role === 'source' ? c.sourceText : c.translatedText;
      if (c.status === 'final' && row.status === 'partial' && c.role === 'translation') finalText = text;
      if (c.status === 'final' && row.status === null && c.role === 'translation' && mode === 'direct') finalText = text;
      row.status = c.status;
      row.el.setAttribute('data-status', c.status);
      const skipped = c.role === 'translation' && snapshot.skippedSegments?.includes(c.segmentId) === true;
      row.el.setAttribute('data-skipped', String(skipped));
      setText(row.label, `${i18n.t(c.role === 'source' ? 'seq.original' : 'seq.translation')} · ${i18n.t(skipped ? 'sim.captions.skipped' : `sim.captions.${c.status}`)}`);
      setText(row.text, text ?? '');
      row.el.setAttribute('data-gap-before', String(c.gapBefore === true));
      if (c.role === 'translation') row.text.setAttribute('lang', target);
    }
    if (finalText) setText(announcement, finalText);
    if (following) list.scrollTop = list.scrollHeight;
    else if (before !== undefined) list.scrollTop += anchor[1].el.getBoundingClientRect().top - before;
    latest.hidden = following; empty.hidden = rows.size > 0;
    for (const [cause, el] of Object.entries(gaps)) el.hidden = !data?.gaps?.[cause];
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
    stop.disabled = !busy || pending;
    sound.disabled = pending || snapshot.status !== 'running';
    setText(start, i18n.t(snapshot.status === 'failed' || snapshot.status === 'stopped' ? (hub ? 'hub.reconnect' : 'sim.restart') : (hub ? 'hub.join' : 'common.start')));
    setText(stop, i18n.t(hub ? 'hub.leave' : 'common.stop'));
    setText(sound, i18n.t(['muted', 'blocked', 'unavailable'].includes(snapshot.output) ? 'sim.enableSound' : 'sim.mute'));
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
  return Object.freeze({ element: section, render,
    refresh() { if (!disposed) { bind.refresh(); render(); } },
    onLevel(value) { if (!disposed && mode === 'direct' && snapshot.status === 'running') meter.setAttribute('value', String(levelPercent(value))); },
    focusInput() { (mode === 'hub' ? room : start).focus(); },
    destroy() { if (disposed) return; disposed = true; unsubscribe?.(); for (const off of listeners) off(); bind.clear(); rows.clear(); room.value = ''; section.remove(); },
  });
}
