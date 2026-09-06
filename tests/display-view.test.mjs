// P3-20: the display controls of design-p3 §1.12 section 1, mounted twice.
// The point of this suite is the trap the task names — two entry points must
// not grow two stored states — so nearly every test mounts BOTH instances over
// one appearance state and asserts they agree after a change made in either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDisplayControls, MODE_VALUES, TEXT_VALUES, TONE_VALUES } from '../app/ui/display-view.js';
import { createAppearance, DARK_SCHEME_QUERY, SYSTEM_MODE } from '../app/ui/appearance.js';
import { createPolicyRuntime } from '../app/policy/runtime.js';
import { createPolicyClient } from '../app/policy/client.js';
import { CAPTION_SIZE, createPreferences, storageKeyFor } from '../app/preferences.js';
import { REGISTERED_SETTINGS } from '../app/policy/schema.js';
import { createI18n } from '../app/i18n/index.js';
import { examplePolicy, policyWith, serialized } from './fixtures/policy.mjs';
import { createClock, policyResponse, scriptedFetch, settle } from './fixtures/policy-fetch.mjs';
import { FakeElement, all, byClass } from './fixtures/scenarios.mjs';

const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async (lang) =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));

class StyledElement extends FakeElement {
  constructor(doc, tag) {
    super(doc, tag);
    this.style.properties = {};
    this.style.setProperty = (name, value) => { this.style.properties[name] = value; };
  }
}
function fakeStorage(initial = {}, { failing = new Set() } = {}) {
  const map = new Map(Object.entries(initial));
  const fail = (method) => { if (failing.has(method)) throw new Error('QuotaExceededError'); };
  return {
    map,
    getItem(key) { fail('getItem'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { fail('setItem'); map.set(key, String(value)); },
    removeItem(key) { fail('removeItem'); map.delete(key); },
  };
}
function fakeMatchMedia({ dark = false } = {}) {
  const lists = new Map();
  const matchMedia = (media) => {
    if (!lists.has(media)) {
      const listeners = new Set();
      lists.set(media, { media, matches: media === DARK_SCHEME_QUERY ? dark : false, listeners,
        addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) });
    }
    return lists.get(media);
  };
  return { matchMedia, setDark(value) {
    const list = matchMedia(DARK_SCHEME_QUERY);
    list.matches = value;
    for (const fn of [...list.listeners]) fn({ media: list.media, matches: value });
  } };
}
const activityDouble = () => Object.freeze({ occupied: false,
  snapshot: () => Object.freeze({ generation: 1, occupied: false, active: false, kind: null }),
  close: () => Promise.resolve() });

/** Two mounts of the component over one appearance state, as main.js wires them. */
async function harness({ policy = examplePolicy(), storage = fakeStorage(), withPolicy = true, language = 'ko' } = {}) {
  const clock = createClock();
  const doc = { activeElement: null, createElement: (tag) => new StyledElement(doc, tag) };
  doc.documentElement = doc.createElement('html');
  const media = fakeMatchMedia();
  const preferences = createPreferences({ storage, now: clock.now });
  let runtime = null;
  if (withPolicy) {
    const scripted = scriptedFetch(() => policyResponse(serialized(policy)));
    const client = createPolicyClient({ fetch: scripted.fetch, location: 'https://gai-cmd.github.io/interp-app/',
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    runtime = createPolicyRuntime({ client, preferences, activity: activityDouble(),
      sessionManager: { occupied: false, close: () => Promise.resolve() }, now: clock.now });
    await client.start();
    await settle();
  }
  const i18n = createI18n({ dictionaries, language });
  const appearance = createAppearance({ document: doc, matchMedia: media.matchMedia, preferences, runtime, now: clock.now });
  const mount = (instance) => createDisplayControls({ appearance, i18n, document: doc, preferences,
    policy: runtime, instance });
  const sheet = mount('sheet'), settings = mount('settings');
  const radio = (view, group, value) => all(view.element, (node) =>
    node.getAttribute('id') === `display-${view === sheet ? 'sheet' : 'settings'}-${group}-${value}`)[0];
  return { doc, i18n, storage, preferences, appearance, runtime, media, clock, sheet, settings, radio,
    both: [sheet, settings],
    close() { sheet.destroy(); settings.destroy(); appearance.destroy(); runtime?.close(); },
  };
}
const checked = (view, group) => all(view.element, (node) => node.tagName === 'INPUT'
  && node.getAttribute('name')?.endsWith(`-${group}`) && node.checked)[0]?.getAttribute('value') ?? null;
const sizeOf = (view) => byClass(view.element, 'display-captions-slider').value;

test('the two mounts are one state: a change in either is on screen in both', async () => {
  const h = await harness();
  assert.equal(checked(h.sheet, 'mode'), 'system');
  assert.equal(checked(h.settings, 'mode'), 'system');

  // Change from the header sheet.
  const dark = h.radio(h.sheet, 'mode', 'dark');
  dark.checked = true; dark.dispatch('change');
  assert.equal(checked(h.sheet, 'mode'), 'dark');
  assert.equal(checked(h.settings, 'mode'), 'dark', 'the settings mount followed without being told');
  assert.equal(h.doc.documentElement.getAttribute('data-mode'), 'dark');

  // Change from the settings screen.
  const forest = h.radio(h.settings, 'tone', 'forest');
  forest.checked = true; forest.dispatch('change');
  assert.equal(checked(h.sheet, 'tone'), 'forest');
  assert.equal(h.doc.documentElement.getAttribute('data-tone'), 'forest');

  // One stored value per setting, no per-instance copies.
  assert.equal(h.storage.map.get(storageKeyFor('ui.mode')), 'dark');
  assert.equal(h.storage.map.get(storageKeyFor('ui.tone')), 'forest');
  assert.equal([...h.storage.map.keys()].filter((key) => key.includes('sheet') || key.includes('settings')).length, 0,
    'no control invents its own storage key');
  h.close();
});

test('mode, tone and text offer exactly the registered values and write the <html> attributes', async () => {
  const h = await harness();
  assert.deepEqual([...MODE_VALUES], [...REGISTERED_SETTINGS['ui.mode'].values]);
  assert.deepEqual([...TONE_VALUES], [...REGISTERED_SETTINGS['ui.tone'].values]);
  assert.deepEqual([...TEXT_VALUES], [...REGISTERED_SETTINGS['ui.text'].values]);
  for (const [group, values, attribute] of [['mode', MODE_VALUES, 'data-mode'], ['tone', TONE_VALUES, 'data-tone'],
    ['text', TEXT_VALUES, 'data-text']]) {
    for (const value of values) {
      const input = h.radio(h.sheet, group, value);
      assert.ok(input, `${group}.${value} is offered`);
      input.checked = true; input.dispatch('change');
      assert.equal(checked(h.settings, group), value);
      // "system" mode is the absence of the attribute, not a value.
      const expected = group === 'mode' && value === SYSTEM_MODE ? null : value;
      assert.equal(h.doc.documentElement.getAttribute(attribute), expected);
    }
  }
  h.close();
});

test('every option carries its own label and the hints of §1.12 are present in all three languages', async () => {
  for (const language of ['ko', 'en', 'ja']) {
    const h = await harness({ language });
    const text = (node) => node.textContent;
    for (const [group, values] of [['mode', MODE_VALUES], ['tone', TONE_VALUES], ['text', TEXT_VALUES]]) {
      for (const value of values) {
        const label = h.radio(h.sheet, group, value).parentNode;
        assert.equal(text(label), dictionaries[language][`display.${group}.${value}`], `${language} ${group}.${value}`);
      }
    }
    const hints = all(h.sheet.element, (node) => node.classes.has('display-hint')).map(text);
    for (const key of ['display.systemHint', 'display.monoHint', 'display.textHint', 'display.captions.range',
      'display.captions.hint', 'display.savedOnDevice']) {
      assert.ok(hints.includes(dictionaries[language][key]), `${language} is missing ${key}`);
    }
    h.close();
  }
});

test('the caption size is the shared 1~2rem scale: slider, 가− and 가+ move one stored value in both mounts', async () => {
  const h = await harness();
  assert.equal(sizeOf(h.sheet), String(CAPTION_SIZE.initial));
  assert.equal(sizeOf(h.settings), String(CAPTION_SIZE.initial));
  const slider = byClass(h.sheet.element, 'display-captions-slider');
  assert.equal(slider.getAttribute('min'), String(CAPTION_SIZE.min));
  assert.equal(slider.getAttribute('max'), String(CAPTION_SIZE.max));
  assert.equal(slider.getAttribute('step'), String(CAPTION_SIZE.step));

  byClass(h.settings.element, 'display-captions-larger').dispatch('click');
  assert.equal(sizeOf(h.settings), '1.625');
  assert.equal(sizeOf(h.sheet), '1.625', 'the other mount followed');
  assert.equal(h.storage.map.get(storageKeyFor('captions.size')), '1.625');
  byClass(h.sheet.element, 'display-captions-smaller').dispatch('click');
  assert.equal(sizeOf(h.settings), '1.5');

  slider.value = '1.875'; slider.dispatch('input');
  assert.equal(sizeOf(h.settings), '1.875');
  assert.equal(byClass(h.settings.element, 'display-captions-value').textContent, '1.875rem');
  // Out-of-range input is clamped, not stored raw.
  slider.value = '9'; slider.dispatch('input');
  assert.equal(sizeOf(h.sheet), String(CAPTION_SIZE.max));
  assert.equal(byClass(h.sheet.element, 'display-captions-larger').disabled, true);
  assert.equal(h.storage.map.get(storageKeyFor('captions.size')), String(CAPTION_SIZE.max));
  h.close();
});

test('the preview carries the caption size and the resolved mode follows the system scheme', async () => {
  const h = await harness();
  const preview = () => byClass(h.sheet.element, 'display-preview-sample');
  assert.equal(preview().style.properties['--caption-size'], `${CAPTION_SIZE.initial}rem`);
  assert.equal(preview().textContent, dictionaries.ko['display.previewSample']);
  byClass(h.sheet.element, 'display-captions-larger').dispatch('click');
  assert.equal(preview().style.properties['--caption-size'], '1.625rem');

  // "system" is not a look: the resolved mode is what the page really shows.
  assert.equal(h.sheet.element.getAttribute('data-resolved-mode'), 'light');
  h.media.setDark(true);
  assert.equal(h.sheet.element.getAttribute('data-resolved-mode'), 'dark');
  assert.equal(h.settings.element.getAttribute('data-resolved-mode'), 'dark', 'both mounts see the system change');
  const light = h.radio(h.sheet, 'mode', 'light');
  light.checked = true; light.dispatch('change');
  assert.equal(h.sheet.element.getAttribute('data-resolved-mode'), 'light', 'a forced mode wins over the system scheme');
  h.close();
});

test('a policy lock disables the control in both mounts and says why; a restricted range hides the rest', async () => {
  const locked = policyWith((policy) => {
    policy.settings['ui.tone'] = { default: 'mono', allowed: ['mono'], locked: true };
    policy.settings['ui.text'] = { default: 'm', allowed: ['m', 'l'], locked: false };
    policy.settings['captions.size'] = { default: 1.25, min: 1, max: 2, step: 0.125, locked: true };
  });
  const h = await harness({ policy: locked });
  for (const view of h.both) {
    const tone = byClass(view.element, 'display-tone');
    assert.equal(checked(view, 'tone'), 'mono', 'the forced value is what the control shows');
    for (const value of TONE_VALUES) {
      assert.equal(h.radio(view, 'tone', value).disabled, true, `${value} is not choosable while the tone is locked`);
    }
    const note = byClass(tone, 'settings-lock');
    assert.equal(note.getAttribute('data-locked'), 'true');
    assert.ok(note.textContent.length > 0, 'the reason is readable text, not colour alone');
    assert.equal(tone.getAttribute('aria-describedby'), note.getAttribute('id'));

    // A restricted (not locked) range simply does not offer the rest.
    for (const value of TEXT_VALUES) {
      const offered = ['m', 'l'].includes(value);
      assert.equal(h.radio(view, 'text', value).parentNode.hidden, !offered, `text ${value}`);
      assert.equal(h.radio(view, 'text', value).disabled, !offered);
    }
    // The caption size is locked too, so neither the slider nor the steps move.
    assert.equal(byClass(view.element, 'display-captions-slider').disabled, true);
    assert.equal(byClass(view.element, 'display-captions-smaller').disabled, true);
    assert.equal(byClass(view.element, 'display-captions-larger').disabled, true);
    assert.equal(sizeOf(view), '1.25');
  }
  // A refused write never reaches storage and never desynchronises the mounts.
  const navy = h.radio(h.sheet, 'tone', 'navy');
  navy.checked = true; navy.dispatch('change');
  assert.equal(checked(h.sheet, 'tone'), 'mono');
  assert.equal(checked(h.settings, 'tone'), 'mono');
  assert.equal(h.storage.map.has(storageKeyFor('ui.tone')), false);
  byClass(h.sheet.element, 'display-captions-larger').dispatch('click');
  assert.equal(h.storage.map.has(storageKeyFor('captions.size')), false);
  h.close();
});

test('a storage failure is reported instead of pretending the choice will survive a reload', async () => {
  const h = await harness({ storage: fakeStorage({}, { failing: new Set(['setItem']) }) });
  const note = byClass(h.sheet.element, 'display-not-saved');
  assert.equal(note.hidden, true);
  const dark = h.radio(h.sheet, 'mode', 'dark');
  dark.checked = true; dark.dispatch('change');
  // The choice still applies in this run, and both mounts show it...
  assert.equal(h.doc.documentElement.getAttribute('data-mode'), 'dark');
  assert.equal(checked(h.settings, 'mode'), 'dark');
  // ...but neither claims it was saved.
  assert.equal(byClass(h.sheet.element, 'display-not-saved').hidden, false);
  assert.equal(byClass(h.settings.element, 'display-not-saved').hidden, false);
  assert.equal(byClass(h.sheet.element, 'display-not-saved').textContent, dictionaries.ko['error.STORAGE_FAILED']);
  h.close();
});

test('a language change re-renders both mounts, and destroy detaches them from the shared state', async () => {
  const h = await harness();
  h.i18n.setLanguage('ja');
  for (const view of h.both) view.refresh();
  assert.equal(h.radio(h.sheet, 'mode', 'dark').parentNode.textContent, dictionaries.ja['display.mode.dark']);
  assert.equal(byClass(h.settings.element, 'display-preview-sample').textContent, dictionaries.ja['display.previewSample']);

  h.sheet.destroy();
  const dark = h.radio(h.settings, 'mode', 'dark');
  dark.checked = true; dark.dispatch('change');
  assert.equal(h.doc.documentElement.getAttribute('data-mode'), 'dark', 'the surviving mount still works');
  h.sheet.destroy();
  h.settings.destroy();
  h.appearance.destroy();
  h.runtime?.close();
});

test('the component works without a policy runtime and refuses an unusable mount', async () => {
  const h = await harness({ withPolicy: false });
  assert.equal(byClass(h.sheet.element, 'settings-lock'), undefined, 'no runtime, no administrator claims');
  const dark = h.radio(h.sheet, 'mode', 'dark');
  dark.checked = true; dark.dispatch('change');
  assert.equal(h.doc.documentElement.getAttribute('data-mode'), 'dark');
  assert.equal(checked(h.settings, 'mode'), 'dark');
  assert.throws(() => createDisplayControls({}), { message: 'INVALID_REQUEST' });
  assert.throws(() => createDisplayControls({ appearance: h.appearance, document: h.doc }), { message: 'INVALID_REQUEST' });
  h.close();
});

test('main.js mounts the same component in both places over one appearance state', async () => {
  const source = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ createDisplayControls \} from '\.\/ui\/display-view\.js'/);
  // One loop, two hosts, one appearance and one preference store.
  assert.match(source, /\[\['sheet', shell\.elements\.panels\.displayBody\],\s*\n?\s*\['settings', settingsView\.elements\.displayControls\]\]/);
  const block = source.slice(source.indexOf('for (const [instance, host]'), source.indexOf('removers.push(shell.onSettingsOpen'));
  assert.equal((block.match(/createDisplayControls\(/g) ?? []).length, 1, 'one construction site, not one per entry point');
  assert.match(block, /appearance, i18n, document: doc, preferences/);
  assert.match(source, /displayViews\.splice\(0\)/, 'both mounts are torn down');
});
