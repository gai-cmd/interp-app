// P3-21: one API key guidance card in the three places design-p3 §1.12 names,
// and — the trap this task warns about — nowhere on the hub listening path,
// where an audience member needs no key of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createKeyGuide, KEY_GUIDE_LINKS, KEY_GUIDE_STEP_KEYS, KEY_GUIDE_VARIANTS } from '../app/ui/key-guide.js';
import { createI18n } from '../app/i18n/index.js';
import { FakeElement, all, byClass, boot, domText, secrets, tick, until } from './fixtures/scenarios.mjs';

const dictionaries = Object.fromEntries(await Promise.all(['ko', 'en', 'ja'].map(async (lang) =>
  [lang, JSON.parse(await readFile(new URL(`../app/i18n/${lang}.json`, import.meta.url)))])));
function fixture({ variant = 'settings', language = 'ko', onOpenSettings = null } = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeElement(doc, tag) };
  const i18n = createI18n({ dictionaries, language });
  const guide = createKeyGuide({ i18n, document: doc, variant, onOpenSettings });
  return { doc, i18n, guide };
}
const anchors = (guide) => all(guide.element, (node) => node.tagName === 'A');

test('the card links exactly the three fixed documents, always in a new tab with noopener noreferrer', () => {
  const { guide } = fixture();
  const links = anchors(guide);
  assert.deepEqual(links.map((node) => node.getAttribute('href')),
    [KEY_GUIDE_LINKS.create, KEY_GUIDE_LINKS.usage, KEY_GUIDE_LINKS.billing]);
  assert.deepEqual({ ...KEY_GUIDE_LINKS }, {
    create: 'https://aistudio.google.com/apikey',
    usage: 'https://ai.google.dev/gemini-api/docs/api-key',
    billing: 'https://ai.google.dev/gemini-api/docs/billing?hl=en',
  }, 'design-p3 §1.12 fixes these three URLs');
  for (const link of links) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer', 'a new tab never gets an opener reference');
    assert.ok(link.textContent.includes(dictionaries.ko['keyGuide.newTab']),
      'the accessible name says the link opens a new tab');
  }
  // Nothing else is linked out of this card.
  assert.equal(links.length, 3);
  guide.destroy();
});

test('the three steps are an ordered list in the fixed order, in all three languages', () => {
  assert.deepEqual([...KEY_GUIDE_STEP_KEYS], ['keyGuide.step1', 'keyGuide.step2', 'keyGuide.step3']);
  for (const language of ['ko', 'en', 'ja']) {
    const { guide } = fixture({ language });
    const list = byClass(guide.element, 'key-guide-steps');
    assert.equal(list.tagName, 'OL', 'a real list, so the count and position are announced');
    assert.deepEqual(list.childNodes.map((node) => node.textContent),
      KEY_GUIDE_STEP_KEYS.map((key) => dictionaries[language][key]), language);
    guide.destroy();
  }
});

test('creating a key being free is never presented as free interpretation, and the restriction is a step not a tip', () => {
  const { guide } = fixture();
  const text = (name) => byClass(guide.element, name).textContent;
  assert.equal(text('key-guide-free'), dictionaries.ko['keyGuide.freeNote']);
  assert.equal(text('key-guide-not-all-free'), dictionaries.ko['keyGuide.notAllFree']);
  assert.equal(text('key-guide-restriction'), dictionaries.ko['keyGuide.restriction']);
  assert.equal(text('key-guide-restriction-why'), dictionaries.ko['keyGuide.restrictionWhy']);
  // The billing link travels with the caveat, never alone as an upsell.
  const order = all(guide.element, (node) => node.classes.has('key-guide-not-all-free') || node.classes.has('key-guide-billing'));
  assert.deepEqual(order.map((node) => node.classes.has('key-guide-billing')), [false, true]);
  guide.destroy();
});

test('a variant only adds context; the settings mount has no lead line and no settings button', () => {
  assert.deepEqual([...KEY_GUIDE_VARIANTS], ['settings', 'firstRun', 'emptyDirect']);
  const settings = fixture({ variant: 'settings' }).guide;
  assert.equal(byClass(settings.element, 'key-guide-lead'), undefined);
  assert.equal(byClass(settings.element, 'key-guide-open-settings'), undefined,
    'the settings screen is already open; a button to open it would be a loop');

  const first = fixture({ variant: 'firstRun', onOpenSettings: () => {} }).guide;
  assert.equal(byClass(first.element, 'key-guide-lead').textContent, dictionaries.ko['keyGuide.firstRun']);
  const empty = fixture({ variant: 'emptyDirect', onOpenSettings: () => {} }).guide;
  assert.equal(byClass(empty.element, 'key-guide-lead').textContent, dictionaries.ko['keyGuide.emptyDirect']);
  // The guidance itself is identical everywhere: same steps, same links.
  for (const guide of [settings, first, empty]) {
    assert.deepEqual(anchors(guide).map((node) => node.getAttribute('href')), Object.values(KEY_GUIDE_LINKS));
    assert.deepEqual(byClass(guide.element, 'key-guide-steps').childNodes.map((node) => node.textContent),
      KEY_GUIDE_STEP_KEYS.map((key) => dictionaries.ko[key]));
    guide.destroy();
  }
});

test('the settings button reports the press once and survives a listener that throws', () => {
  let presses = 0;
  const { guide } = fixture({ variant: 'firstRun', onOpenSettings: () => { presses++; throw new Error('consumer'); } });
  const button = byClass(guide.element, 'key-guide-open-settings');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  button.dispatch('click');
  assert.equal(presses, 1);
  guide.destroy();
  button.dispatch('click');
  assert.equal(presses, 1, 'a destroyed card is detached');
});

test('visibility, language refresh and invalid construction', () => {
  const { guide, i18n } = fixture({ variant: 'emptyDirect', onOpenSettings: () => {} });
  assert.equal(guide.visible, true);
  guide.setVisible(false);
  assert.equal(guide.element.hidden, true);
  assert.equal(guide.visible, false);
  guide.setVisible(true);
  i18n.setLanguage('ja');
  guide.refresh();
  assert.equal(byClass(guide.element, 'key-guide-lead').textContent, dictionaries.ja['keyGuide.emptyDirect']);
  assert.equal(byClass(guide.element, 'key-guide-title').textContent, dictionaries.ja['keyGuide.title']);
  guide.destroy();
  assert.throws(() => createKeyGuide({}), { message: 'INVALID_REQUEST' });
  const doc = { createElement: (tag) => new FakeElement(doc, tag) };
  assert.throws(() => createKeyGuide({ i18n, document: doc, variant: 'hub' }), { message: 'INVALID_REQUEST' });
});

// --- the three placements in the running app ---

test('a first run without a key shows the guide; saving a key removes it from both conditional places', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  const cards = () => all(b.root, (node) => node.classes.has('key-guide'));
  const shown = () => cards().filter((node) => node.getAttribute('data-variant') !== 'settings'
    && !node.hidden && node.parentNode?.hidden !== true).map((node) => node.getAttribute('data-variant'));

  assert.equal(cards().length, 3, 'the settings mount plus the two conditional ones');
  assert.deepEqual(shown().sort(), ['emptyDirect', 'firstRun'],
    'a first run on the simultaneous tab sees both');
  assert.equal(b.el('settings-key-guide').childNodes.length, 1, 'the settings card is always mounted');
  assert.equal(cards().find((node) => node.getAttribute('data-variant') === 'settings').hidden, false);

  b.enterPersonalKey({ key: secrets.personal, remember: true });
  await until(() => shown().length === 0);
  assert.deepEqual(shown(), [], 'a stored personal key silences both prompts');
  assert.equal(cards().find((node) => node.getAttribute('data-variant') === 'settings').hidden, false,
    'the settings card stays: it is reference material, not a prompt');
});

test('a first visit on a build that ships a key sees no key prompt at all: the badge shows a key and the start path is open', async (t) => {
  // Owner (2026-09-07): a person who has never used the app opens the site
  // and can start straight away. Nothing stored, nothing typed.
  const builtin = `${secrets.personal}-BUILT-IN`;
  const b = await boot({ builtinKey: () => builtin });
  t.after(() => b.app.close());
  const cards = () => all(b.root, (node) => node.classes.has('key-guide'));
  const shown = () => cards().filter((node) => node.getAttribute('data-variant') !== 'settings'
    && !node.hidden && node.parentNode?.hidden !== true).map((node) => node.getAttribute('data-variant'));
  assert.deepEqual(shown(), [], 'no "create a key" card greets the first visitor');
  assert.equal(b.app.shell.elements.firstRun.hidden, true);
  assert.equal(b.app.shell.elements.modeBadge.getAttribute('data-key-source'), 'personal');
  assert.equal(b.app.shell.selectedTab, 'simultaneous', 'and the first screen is the interpreting one');
  assert.equal(b.el('sim-open-settings')?.hidden ?? true, true, 'no "open settings for a key" action is offered');
  assert.equal(b.text().includes(builtin), false, 'the key itself is nowhere on screen');
  // The settings card stays as reference material, and the sequential tab has no prompt either.
  b.app.shell.selectTab('sequential');
  await tick();
  assert.deepEqual(shown(), []);
});

test('the guide never appears on the hub listening path', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  const visible = (variant) => all(b.root, (node) => node.getAttribute('data-variant') === variant)
    .some((node) => !node.hidden && node.parentNode?.hidden !== true);

  // The sequential tab is not a direct-listening screen, so the simultaneous
  // card goes away with it while the first-run card stays.
  b.app.shell.selectTab('sequential');
  await tick();
  assert.equal(visible('emptyDirect'), false, 'the direct card belongs to the simultaneous screen');

  b.app.shell.selectTab('simultaneous');
  await tick();
  assert.equal(visible('emptyDirect'), true);
  // Switching the simultaneous screen to hub listening must not put a "create a
  // key" card in front of an audience member who needs no key.
  const modeSelect = b.el('sim-mode');
  modeSelect.value = 'hub';
  modeSelect.dispatch('change');
  await tick();
  const board = b.el('caption-board');
  assert.equal(all(board, (node) => node.classes.has('key-guide')).length, 0,
    'the empty caption board never carries key guidance');
  assert.equal(b.el('sim-open-settings').hidden, true, 'hub listening does not point at the key entry either');
});

test('no key value, and no key-shaped text, can reach the guidance card', async (t) => {
  const b = await boot();
  t.after(() => b.app.close());
  b.enterPersonalKey({ key: secrets.personal, remember: true });
  await tick();
  for (const card of all(b.root, (node) => node.classes.has('key-guide'))) {
    assert.equal(domText(card).includes('SECRET'), false, 'the card renders guidance, never a key');
  }
});

test('main.js mounts one card per placement and tears them all down', async () => {
  const source = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ createKeyGuide \} from '\.\/ui\/key-guide\.js'/);
  assert.match(source, /\[\['firstRun', shell\.elements\.firstRun\],/);
  assert.match(source, /\['emptyDirect', shell\.simView\?\.element \?\? null\]\]/);
  assert.match(source, /keyGuides\.splice\(0\)/);
  // No hub placement exists at all — the trap is closed by construction.
  assert.equal(/'hubListen'|hubEngine\.element|hub.*createKeyGuide/.test(source), false);
});
