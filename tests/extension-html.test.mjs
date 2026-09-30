// New implementation of docs/extension.md 11.1 (extension-html), 8.1-8.4 and 9.2; no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkSource } from '../scripts/check-i18n.mjs';
import { STYLE_LIMITS } from '../extension/lib/constants.js';
import { parseHtml } from './fixtures/extension-dom.mjs';

// Section 11.1 `extension-html`. M1 part: the three page skeletons carry the final
// ids, binder attributes and live-region markup that the controllers of group C
// code against (I6), every data-i18n key exists in the dictionaries, and the pages
// obey R12. M2 part (the last section of this file): the stylesheets. panel.css has
// a rule for every selector of the 8.2.2 attribute table and the sticky button row,
// both page stylesheets use only tokens of styles.css and keep hover, motion and
// forced colors in their media queries, and the overlay's token table (8.5.2,
// extracted from the SHEET literal of overlay.js) equals the values in styles.css
// and passes the WCAG contrast checks.

const root = fileURLToPath(new URL('../', import.meta.url));
const readText = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = async (path) => JSON.parse(await readText(path));
const LANGUAGES = ['en', 'ko', 'ja'];
const BINDERS = ['data-i18n', 'data-i18n-label', 'data-i18n-tip', 'data-i18n-hint'];

const PAGES = Object.freeze({
  panel: { path: 'extension/panel/panel.html', styles: ['../../styles.css', './panel.css'], script: './panel.js', bodyClass: 'panel' },
  options: { path: 'extension/options/options.html', styles: ['../../styles.css', '../pages.css'], script: './options.js', bodyClass: 'page options-page' },
  permission: { path: 'extension/permission/mic-permission.html', styles: ['../../styles.css', '../pages.css'], script: './mic-permission.js', bodyClass: 'page permission-page' },
});

const pages = {};
for (const [name, page] of Object.entries(PAGES)) {
  const source = await readText(page.path);
  pages[name] = { ...page, source, document: parseHtml(source) };
}
const dictionaries = Object.fromEntries(await Promise.all(LANGUAGES.map(async (language) =>
  [language, { ext: await readJson(`extension/i18n/${language}.json`), app: await readJson(`app/i18n/${language}.json`) }])));

function* walk(node) {
  for (const child of node.children) { yield child; yield* walk(child); }
}
const elementsOf = (name) => [...walk(pages[name].document)];
const byId = (name, id) => pages[name].document.getElementById(id);
const idsInOrder = (name) => elementsOf(name).filter((element) => element.id).map((element) => element.id);
const position = (name, id) => { const at = idsInOrder(name).indexOf(id); assert.notEqual(at, -1, `#${id} exists in ${name}`); return at; };
const assertIncreasing = (name, ids) => {
  const positions = ids.map((id) => position(name, id));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `DOM order in ${name}: ${ids.join(' < ')}`);
};
const optionValues = (name, id) => byId(name, id).options.map((option) => option.value);
const optionKeys = (name, id) => byId(name, id).options.map((option) => option.getAttribute('data-i18n'));
const attrs = (name, id) => Object.fromEntries(byId(name, id).attributes.map((attribute) => [attribute.name, attribute.value]));

const PANEL_IDS = ['app', 'panel-title', 'status-pill', 'key-missing', 'key-missing-text', 'btn-key-options', 'stop-note',
  'card-tab', 'tab-enabled', 'tab-title', 'tab-target-label', 'tab-target', 'tab-two-way', 'tab-partner-row', 'tab-partner', 'tab-two-way-hint',
  'tab-two-way-note', 'tab-apply-next', 'tab-source-note', 'tab-volume', 'tab-volume-value', 'tab-captions',
  'tab-tabline', 'tab-arm-note', 'tab-status', 'tab-route', 'tab-route-note', 'tab-output', 'tab-gap', 'tab-level', 'tab-notice', 'tab-preview',
  'card-mic', 'mic-enabled', 'mic-title', 'mic-mode', 'mic-target-label', 'mic-target', 'mic-two-way', 'mic-partner-row', 'mic-partner',
  'mic-two-way-hint', 'mic-two-way-note', 'mic-apply-next', 'mic-source-note', 'mic-captions', 'mic-captions-hint',
  'mic-permission-status', 'btn-mic-allow', 'mic-status', 'mic-route', 'mic-route-note', 'mic-output', 'mic-gap', 'mic-level', 'mic-notice', 'mic-preview',
  'no-lane-note', 'mute-note', 'echo-note', 'close-note', 'howto', 'howto-steps', 'usage-note',
  'btn-start', 'btn-mic-permission', 'btn-mute', 'btn-options'];
const OPTIONS_IDS = ['opt-title', 'opt-lead', 'opt-h-key', 'opt-key', 'opt-key-toggle', 'opt-key-save', 'opt-key-delete', 'opt-key-status',
  'opt-key-guide', 'opt-key-note', 'opt-h-lanes', 'opt-ui-language', 'opt-ui-language-hint', 'opt-target-tab', 'opt-target-mic',
  'opt-model-tab', 'opt-model-tab-hint', 'opt-model-mic', 'opt-model-mic-hint', 'opt-voice', 'opt-voice-hint', 'opt-volume', 'opt-volume-value',
  'opt-captions-tab', 'opt-captions-mic', 'opt-captions-mic-hint', 'opt-defaults-hint', 'opt-h-captions', 'opt-caption-size',
  'opt-caption-size-value', 'opt-caption-size-hint', 'opt-caption-position', 'opt-caption-display', 'opt-caption-source', 'opt-caption-lines',
  'opt-caption-hide', 'opt-h-privacy', 'opt-privacy-audio', 'opt-privacy-free', 'opt-privacy-page', 'opt-saved'];
// The row order of the 7.3 table (8.3: inside a section the DOM order is the row order).
const OPTIONS_ROW_ORDER = ['opt-key', 'opt-key-toggle', 'opt-key-save', 'opt-key-delete', 'opt-key-status', 'opt-key-guide', 'opt-key-note',
  'opt-ui-language', 'opt-target-tab', 'opt-target-mic', 'opt-model-tab', 'opt-model-mic', 'opt-voice', 'opt-volume', 'opt-captions-tab',
  'opt-captions-mic', 'opt-caption-size', 'opt-caption-position', 'opt-caption-display', 'opt-caption-source', 'opt-caption-lines',
  'opt-caption-hide', 'opt-privacy-audio', 'opt-privacy-free', 'opt-privacy-page', 'opt-saved'];
const PERMISSION_IDS = ['perm-title', 'perm-lead', 'perm-always', 'perm-request', 'perm-status', 'perm-help', 'perm-close'];
const ID_LISTS = { panel: PANEL_IDS, options: OPTIONS_IDS, permission: PERMISSION_IDS };

// ---------------------------------------------------------------------------
// R12 and the shared page shell

for (const name of Object.keys(PAGES)) {
  test(`${name} page: R12 (module scripts only, no inline script or handler, relative links, no literal text, empty title)`, async () => {
    const { document, source } = pages[name];
    const page = PAGES[name];
    assert.equal(document.doctype, 'doctype html');
    assert.ok(document.documentElement.getAttribute('lang'), '<html lang> is set (the controller updates it)');
    assert.equal(document.head.querySelector('meta[charset]')?.getAttribute('charset'), 'utf-8');
    assert.match(document.head.querySelector('meta[name=viewport]')?.getAttribute('content') ?? '', /width=device-width/);
    const title = document.querySelector('title');
    assert.equal(title.textContent, '', '<title> is empty in markup');
    assert.ok(title.getAttribute('data-i18n'), '<title> is filled by the binder');
    assert.equal(document.body.className, page.bodyClass);

    const scripts = document.querySelectorAll('script');
    assert.equal(scripts.length, 1, 'exactly one script');
    assert.equal(scripts[0].getAttribute('type'), 'module');
    assert.equal(scripts[0].getAttribute('src'), page.script);
    assert.equal(scripts[0].textContent, '', 'no inline script text');
    assert.equal(scripts[0].parentNode, document.body, 'the script sits at the end of body');

    const links = document.querySelectorAll('link');
    assert.deepEqual(links.map((link) => link.getAttribute('href')), page.styles, 'styles.css first, then the page stylesheet, by exact relative path');
    assert.ok(links.every((link) => link.getAttribute('rel') === 'stylesheet'));
    for (const href of page.styles) {
      const file = new URL(href, new URL(`../${page.path}`, import.meta.url));
      assert.ok((await stat(file)).isFile(), `${href} resolves to ${fileURLToPath(file).replace(root, '')}`);
    }

    for (const element of [document.documentElement, ...walk(document)]) {
      for (const { name: attribute, value } of element.attributes) {
        assert.equal(/^on/i.test(attribute), false, `no inline handler ${attribute} on <${element.localName}>`);
        if (['href', 'src', 'action', 'srcset', 'xlink:href', 'poster'].includes(attribute)) {
          assert.match(value, /^\.{1,2}\//, `${attribute} on <${element.localName}> is relative`);
          assert.equal(/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//'), false, `no remote URL in ${attribute}`);
        }
        assert.notEqual(attribute, 'style', 'no inline style attribute');
        if (['title', 'placeholder', 'aria-label', 'alt'].includes(attribute)) assert.equal(value, '', `no literal ${attribute} text`);
      }
      assert.ok(!['iframe', 'object', 'embed', 'style', 'form'].includes(element.localName),
        `<${element.localName}> is not used (no iframe, inline style, form or embed)`);
    }
    assert.deepEqual(document.strayText, [], 'no literal text between tags: every string comes from a data-i18n attribute');
    assert.doesNotMatch(source, /<(?:iframe|form|style)\b/i);
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(source, /https?:\/\//i, 'no remote URL anywhere in the markup');
  });

  test(`${name} page: every id of the contract exists exactly once and no id repeats`, () => {
    const seen = new Map();
    for (const id of idsInOrder(name)) seen.set(id, (seen.get(id) ?? 0) + 1);
    assert.deepEqual([...seen].filter(([, count]) => count > 1), [], 'no duplicate id');
    for (const id of ID_LISTS[name]) assert.equal(seen.get(id), 1, `#${id}`);
  });

  test(`${name} page: only the four binder attributes, every key exists in ko, en and ja, no literal UI attributes`, () => {
    const used = new Set();
    for (const element of elementsOf(name)) {
      for (const { name: attribute, value } of element.attributes) {
        if (!attribute.startsWith('data-i18n')) continue;
        assert.ok(BINDERS.includes(attribute), `${attribute} is not a binder spelling (allowed: ${BINDERS.join(', ')})`);
        assert.match(value, /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, `${attribute}="${value}" has the shape of a key`);
        used.add(value);
      }
    }
    assert.ok(used.size > 3);
    for (const language of LANGUAGES) {
      const union = { ...dictionaries[language].app, ...dictionaries[language].ext };
      for (const key of used) assert.equal(typeof union[key], 'string', `${key} exists in ${language}`);
    }
  });

  test(`${name} page: the repo i18n checker accepts the markup (no literal UI text, unknown keys or forbidden attributes)`, () => {
    const union = { ...dictionaries.en.app, ...dictionaries.en.ext };
    assert.deepEqual(checkSource(pages[name].source, union, { html: true }), []);
  });
}

// ---------------------------------------------------------------------------
// Side panel

test('panel: DOM order equals the tab order of 8.2.6 and the button row closes the page', () => {
  assertIncreasing('panel', ['btn-key-options', 'tab-enabled', 'tab-target', 'tab-volume', 'tab-captions', 'tab-preview', 'mic-enabled',
    'mic-target', 'mic-captions', 'btn-mic-allow', 'mic-preview', 'howto', 'btn-start', 'btn-mic-permission', 'btn-mute', 'btn-options']);
  const row = pages.panel.document.querySelector('.button-row');
  assert.deepEqual(row.children.map((element) => element.id), ['btn-start', 'btn-mic-permission', 'btn-mute', 'btn-options']);
  assert.equal(byId('panel', 'app').lastElementChild, row, 'the sticky row is the last block of main');
  for (const id of ['usage-note', 'mute-note', 'echo-note', 'close-note']) {
    assert.ok(position('panel', id) < position('panel', 'btn-start'), `#${id} scrolls above the sticky row`);
  }
  assert.ok(position('panel', 'card-tab') < position('panel', 'card-mic'));
  assert.ok(position('panel', 'no-lane-note') > position('panel', 'mic-preview') && position('panel', 'no-lane-note') < position('panel', 'howto'));
  // Was: "a disabled control is disabled, never aria-disabled". A natively disabled button is skipped by Tab, so the
  // description that says WHY Start cannot start (aria-describedby) could not be reached with a keyboard (checklist 13.31):
  // Start is aria-disabled instead, and the controller ignores its click while it is.
  assert.equal(elementsOf('panel').some((element) => element.hasAttribute('disabled')), false, 'no control is natively disabled');
  assert.deepEqual(elementsOf('panel').filter((element) => element.hasAttribute('aria-disabled')).map((element) => `${element.id}=${element.getAttribute('aria-disabled')}`),
    ['btn-start=true'], 'only Start carries aria-disabled, and its markup starts in the state the first render would give a fresh profile');
});

// The persistent regions of 8.2.1 and 8.2.6 with their required role.
// The per-lane status lines (#tab-status, #mic-status) are deliberately NOT here any more: the pill and the notices announce
// the same change, so a live status line announced each state two or three times.
const STATUS_REGIONS = ['status-pill', 'key-missing', 'stop-note', 'tab-apply-next', 'tab-arm-note', 'tab-route-note', 'tab-output', 'tab-gap',
  'mic-apply-next', 'mic-permission-status', 'mic-route-note', 'mic-output', 'mic-gap', 'no-lane-note', 'mute-note', 'echo-note', 'usage-note'];
const ALERT_REGIONS = ['tab-notice', 'mic-notice'];

test('panel: live regions are persistent (a role, never hidden, no static text) and the two notices are alerts', () => {
  for (const id of STATUS_REGIONS) {
    const region = byId('panel', id);
    assert.equal(region.getAttribute('role'), 'status', `#${id} is role=status`);
    assert.equal(region.hidden, false, `#${id} is never hidden (a region that appears with its text is often not announced)`);
    assert.equal(region.textContent.trim(), '', `#${id} carries no static text`);
    assert.equal(region.hasAttribute('data-i18n'), false, `#${id} is written by the controller, not the binder`);
  }
  for (const id of ALERT_REGIONS) {
    const region = byId('panel', id);
    assert.equal(region.getAttribute('role'), 'alert', `#${id} is role=alert`);
    assert.equal(region.hidden, false);
    assert.equal(region.textContent.trim(), '');
  }
  assert.equal(byId('panel', 'status-pill').getAttribute('aria-live'), 'polite');
  assert.equal(byId('panel', 'status-pill').getAttribute('data-state'), 'idle');
  assert.equal(byId('panel', 'status-pill').localName, 'p');
  assert.ok(byId('panel', 'status-pill').classList.contains('badge'));
  // The regions and notices also keep the classes the shared stylesheet styles.
  for (const id of ['key-missing', 'stop-note', 'tab-arm-note', 'tab-notice', 'mic-notice', 'no-lane-note', 'echo-note']) {
    assert.ok(byId('panel', id).classList.contains('notice'), `#${id}.notice`);
  }
  assert.equal(byId('panel', 'key-missing-text').textContent, '');
  assert.equal(byId('panel', 'btn-key-options').hidden, true, 'the button inside the key notice is hidden, the notice itself is not');
});

test('panel: the lane status lines are plain text (not live, never hidden): the pill and the notices announce the change once', () => {
  for (const id of ['tab-status', 'mic-status']) {
    const line = byId('panel', id);
    assert.equal(line.hasAttribute('role'), false, `#${id} has no role`);
    assert.equal(line.hasAttribute('aria-live'), false, `#${id} is not aria-live`);
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, '');
    assert.ok(line.classList.contains('text-sub'));
  }
  assert.ok(position('panel', 'tab-route') < position('panel', 'tab-route-note') && position('panel', 'tab-route-note') < position('panel', 'tab-output'));
  assert.ok(position('panel', 'mic-route') < position('panel', 'mic-route-note') && position('panel', 'mic-route-note') < position('panel', 'mic-output'));
  for (const id of ['tab-route', 'mic-route']) assert.equal(byId('panel', id).hasAttribute('role'), false, 'the route line stays plain: the backup-model warning is written to the live note next to it');
});

test('panel: hidden is used only on non-live elements, and every one of them is listed', () => {
  const hidden = elementsOf('panel').filter((element) => element.hidden).map((element) => element.id).sort();
  // The two-way rows (the partner row and the model note of each lane) are plain elements that start hidden: two-way is off.
  // The update banner (§16) is a plain row too: it appears only while the download site publishes a newer version.
  assert.deepEqual(hidden, ['btn-key-options', 'btn-mic-allow', 'close-note', 'mic-level', 'mic-partner-row', 'mic-preview', 'mic-route',
    'mic-two-way-note', 'tab-level', 'tab-partner-row', 'tab-preview', 'tab-route', 'tab-tabline', 'tab-two-way-note', 'update-note'].sort());
  for (const id of [...STATUS_REGIONS, ...ALERT_REGIONS]) assert.equal(byId('panel', id).hidden, false);
});

test('panel: Start, mute and permission buttons (labels come from the controller or from binder attributes only)', () => {
  const start = byId('panel', 'btn-start');
  assert.deepEqual([start.localName, start.getAttribute('type')], ['button', 'button']);
  assert.ok(start.classList.contains('btn') && start.classList.contains('btn-primary'));
  assert.equal(start.getAttribute('aria-describedby'), 'key-missing no-lane-note');
  assert.equal(start.getAttribute('aria-disabled'), 'true', 'never natively disabled: it stays focusable so the description can be heard');
  assert.equal(start.hasAttribute('disabled'), false);
  for (const id of start.getAttribute('aria-describedby').split(' ')) assert.ok(byId('panel', id), `aria-describedby points at #${id}`);
  assert.equal(start.textContent, '');
  assert.equal(start.hasAttribute('data-i18n'), false, 'Start/Stop/Cancel is swapped by the controller');

  const mute = byId('panel', 'btn-mute');
  assert.equal(mute.getAttribute('data-muted'), 'true');
  assert.equal(mute.hasAttribute('aria-pressed'), false, 'the label swaps, so no aria-pressed');
  assert.equal(mute.hasAttribute('data-i18n-label') || mute.hasAttribute('data-i18n-tip'), false, 'aria-label and title are set by the controller');
  assert.ok(mute.classList.contains('icon-btn'));

  const permission = byId('panel', 'btn-mic-permission');
  assert.equal(permission.getAttribute('data-i18n-label'), 'permission.request');
  assert.equal(permission.getAttribute('data-i18n-tip'), 'permission.request');
  assert.ok(permission.classList.contains('icon-btn'));

  // The mute icon has a SECOND path, the slash across the speaker; CSS shows it only while data-muted="true" (state is a
  // shape, not colour alone). The permission icon keeps one path.
  for (const [id, paths] of [['btn-mic-permission', 1], ['btn-mute', 2]]) {
    const [icon, ...rest] = byId('panel', id).children;
    assert.equal(rest.length, 0);
    assert.equal(icon.localName, 'svg');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.getAttribute('focusable'), 'false');
    assert.equal(icon.getAttribute('viewbox'), '0 0 24 24');
    assert.ok(icon.classList.contains('icon'));
    assert.deepEqual(icon.children.map((child) => child.localName), Array(paths).fill('path'), 'inline path data only: no <title>, no <text>');
    for (const path of icon.children) assert.match(path.getAttribute('d'), /^M[\d\s.a-zA-Z-]+$/);
    assert.equal(icon.textContent, '');
  }
  const [speaker, slash] = byId('panel', 'btn-mute').children[0].children;
  assert.equal(speaker.hasAttribute('class'), false, 'the speaker glyph is always drawn');
  assert.equal(slash.getAttribute('class'), 'icon-slash', 'the slash is the path CSS reveals for the muted state');
  assert.equal(slash.getAttribute('fill'), 'currentColor', 'it follows the button colour (and forced colors)');
  assert.equal(byId('panel', 'btn-mic-allow').getAttribute('data-i18n'), 'ext.permission.allowButton');
  assert.equal(byId('panel', 'btn-key-options').getAttribute('data-i18n'), 'ext.key.enter');
  assert.equal(byId('panel', 'btn-options').getAttribute('data-i18n'), 'ext.options.title');
  assert.notEqual(byId('panel', 'btn-key-options').getAttribute('data-i18n'), byId('panel', 'btn-options').getAttribute('data-i18n'),
    'two buttons never share the accessible name "Options"');
});

test('panel: lane cards, selects, slider, meters, previews and the how-to disclosure', () => {
  for (const [lane, title] of [['tab', 'ext.lane.tab.title'], ['mic', 'ext.lane.mic.title']]) {
    const card = byId('panel', `card-${lane}`);
    assert.equal(card.localName, 'section');
    assert.equal(card.getAttribute('data-lane'), lane);
    assert.equal(card.getAttribute('aria-labelledby'), `${lane}-title`);
    assert.equal(byId('panel', `${lane}-title`).getAttribute('data-i18n'), title);
    assert.equal(byId('panel', `${lane}-enabled`).type, 'checkbox');
    assert.equal(byId('panel', `${lane}-captions`).type, 'checkbox');
    assert.deepEqual(optionValues('panel', `${lane}-target`), ['ko', 'en', 'ja']);
    assert.deepEqual(optionKeys('panel', `${lane}-target`), ['language.ko', 'language.en', 'language.ja']);
    assert.equal(byId('panel', `${lane}-source-note`).getAttribute('data-i18n'), 'ext.source.auto');
    assert.equal(byId('panel', `${lane}-level`).localName, 'meter');
    for (const id of [`${lane}-preview`]) {
      assert.equal(byId('panel', id).getAttribute('tabindex'), '0');
      assert.equal(byId('panel', id).getAttribute('role'), 'region', 'aria-label is not allowed on a generic div: a focusable named box needs a role');
      assert.equal(byId('panel', id).getAttribute('aria-live'), 'off', 'captions are not announced');
      assert.equal(byId('panel', id).getAttribute('data-i18n-label'), 'sim.captions.latest');
    }
    for (const control of card.querySelectorAll('input, select')) assert.ok(control.closest('label'), `#${control.id} is wrapped by a label`);
  }
  assert.equal(byId('panel', 'tab-captions').closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.captions.show');
  assert.equal(byId('panel', 'mic-captions-hint').getAttribute('data-i18n'), 'ext.captions.micHint');
  assert.equal(byId('panel', 'mic-mode').localName, 'p', 'the mode is a static line, not a control that does nothing');
  assert.equal(byId('panel', 'mic-mode').getAttribute('data-i18n'), 'ext.mic.mode');
  assert.equal(byId('panel', 'mic-enabled').closest('label').querySelector('span').id, 'mic-title');

  assert.deepEqual(attrs('panel', 'tab-volume'), { id: 'tab-volume', type: 'range', min: '0', max: '100', step: '5' });
  const output = byId('panel', 'tab-volume-value');
  assert.equal(output.localName, 'output');
  assert.equal(output.getAttribute('for'), 'tab-volume');
  assert.equal(byId('panel', 'tab-volume').closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.tab.originalVolume');

  assert.deepEqual([byId('panel', 'tab-level').getAttribute('data-i18n-label'), byId('panel', 'mic-level').getAttribute('data-i18n-label')],
    ['ext.level.tab', 'seq.inputLevel']);
  for (const id of ['tab-level', 'mic-level']) {
    assert.deepEqual([byId('panel', id).getAttribute('min'), byId('panel', id).getAttribute('max'), byId('panel', id).getAttribute('value')], ['0', '100', '0']);
  }

  const howto = byId('panel', 'howto');
  assert.equal(howto.localName, 'details');
  assert.equal(howto.open, false);
  assert.equal(howto.querySelector('summary').getAttribute('data-i18n'), 'ext.howto.link');
  assert.equal(byId('panel', 'howto-steps').localName, 'ol');
  assert.deepEqual(byId('panel', 'howto-steps').children.map((item) => item.getAttribute('data-i18n')), ['ext.howto.keepOpen', 'sim.headphonesStart',
    'ext.howto.step2', 'ext.howto.step3', 'ext.howto.step4', 'ext.howto.step5', 'ext.howto.stepCall']);
  assert.equal(byId('panel', 'close-note').getAttribute('data-i18n'), 'ext.panel.closeStops');
  assert.equal(byId('panel', 'panel-title').getAttribute('data-i18n'), 'ext.name');
  assert.equal(byId('panel', 'panel-title').localName, 'h1');
});

// ---------------------------------------------------------------------------
// Options page (7.3, 8.3)

test('options: DOM order follows the 7.3 table and the section structure of 8.3', () => {
  assertIncreasing('options', ['opt-title', 'opt-lead', 'opt-h-key', ...OPTIONS_ROW_ORDER.slice(0, 7), 'opt-h-lanes', ...OPTIONS_ROW_ORDER.slice(7, 16),
    'opt-defaults-hint', 'opt-h-captions', ...OPTIONS_ROW_ORDER.slice(16, 22), 'opt-h-privacy', ...OPTIONS_ROW_ORDER.slice(22)]);
  assertIncreasing('options', OPTIONS_ROW_ORDER);
  assert.equal(byId('options', 'opt-title').localName, 'h1');
  for (const [id, key] of [['opt-h-key', 'settings.key'], ['opt-h-lanes', 'ext.options.section.lanes'], ['opt-h-captions', 'ext.options.section.captions'],
    ['opt-h-privacy', 'ext.options.section.privacy']]) {
    assert.equal(byId('options', id).localName, 'h2');
    assert.equal(byId('options', id).getAttribute('data-i18n'), key);
  }
  assert.equal(byId('options', 'opt-saved').getAttribute('role'), 'status');
  assert.equal(byId('options', 'opt-saved').textContent, '');
  assert.equal(byId('options', 'opt-saved').hidden, false);
  assert.equal(byId('options', 'opt-key-status').getAttribute('role'), 'status');
  assert.equal(byId('options', 'opt-key-status').textContent, '');
  assert.equal(byId('options', 'opt-key-status').hidden, false);
  for (const section of pages.options.document.querySelectorAll('section')) {
    assert.equal(section.getAttribute('aria-labelledby') && byId('options', section.getAttribute('aria-labelledby')).localName, 'h2');
  }
});

test('options: the key controls (password input never prefilled, toggle without aria-pressed, guide link without an href in markup)', () => {
  const key = byId('options', 'opt-key');
  assert.equal(key.localName, 'input');
  assert.deepEqual(attrs('options', 'opt-key'), { id: 'opt-key', type: 'password', maxlength: '512', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', 'data-i18n-hint': 'settings.keyPlaceholder' });
  assert.equal(key.hasAttribute('value'), false, 'the stored key is never rendered into the input');
  assert.equal(key.closest('label').querySelector('span').getAttribute('data-i18n'), 'settings.key');

  const toggle = byId('options', 'opt-key-toggle');
  assert.equal(toggle.getAttribute('aria-controls'), 'opt-key');
  assert.equal(toggle.hasAttribute('aria-pressed'), false);
  assert.equal(toggle.getAttribute('type'), 'button');
  assert.equal(toggle.getAttribute('data-i18n'), 'ext.options.keyShow', 'starts as "Show key"; the controller swaps it');
  assert.equal(byId('options', 'opt-key-save').getAttribute('data-i18n'), 'common.save');
  assert.ok(byId('options', 'opt-key-save').classList.contains('btn-primary'));
  assert.equal(byId('options', 'opt-key-delete').getAttribute('data-i18n'), 'settings.deleteKey');

  const guide = byId('options', 'opt-key-guide');
  assert.equal(guide.localName, 'a');
  assert.equal(guide.getAttribute('target'), '_blank');
  assert.equal(guide.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(guide.hasAttribute('href'), false, 'a remote URL may not appear in markup (R12): the controller sets it from links.js');
  assert.deepEqual(guide.children.map((child) => child.getAttribute('data-i18n')), ['keyGuide.createLink', 'keyGuide.newTab']);
  assert.deepEqual(byId('options', 'opt-key-note').children.map((child) => child.getAttribute('data-i18n')), ['ext.keyStorage', 'settings.keyStorageWarning']);
});

test('options: every control of 7.3 has its type, range, enum values and label keys', () => {
  const language = ['ko', 'en', 'ja'], languageKeys = ['language.ko', 'language.en', 'language.ja'];
  assert.deepEqual(optionValues('options', 'opt-ui-language'), ['auto', ...language]);
  assert.deepEqual(optionKeys('options', 'opt-ui-language'), ['language.auto', ...languageKeys]);
  assert.equal(byId('options', 'opt-ui-language').closest('label').querySelector('span').getAttribute('data-i18n'), 'language.ui');
  assert.equal(byId('options', 'opt-ui-language-hint').getAttribute('data-i18n'), 'ext.options.uiLanguageHint');
  for (const [id, lane] of [['opt-target-tab', 'ext.lane.tab.title'], ['opt-target-mic', 'ext.lane.mic.title']]) {
    assert.deepEqual(optionValues('options', id), language);
    assert.deepEqual(optionKeys('options', id), languageKeys);
    assert.deepEqual(byId('options', id).closest('label').children.filter((child) => child.localName === 'span').map((span) => span.getAttribute('data-i18n')),
      [lane, 'language.target']);
  }
  for (const [id, label, hint, hintKey] of [['opt-model-tab', 'ext.options.modelTab', 'opt-model-tab-hint', 'ext.options.modelTabHint'],
    ['opt-model-mic', 'ext.options.modelMic', 'opt-model-mic-hint', 'ext.options.modelMicHint']]) {
    assert.equal(byId('options', id).localName, 'select');
    assert.deepEqual(byId('options', id).options, [], 'the controller fills the options from LIVE_MODELS');
    assert.equal(byId('options', id).closest('label').querySelector('span').getAttribute('data-i18n'), label);
    assert.equal(byId('options', hint).getAttribute('data-i18n'), hintKey);
  }
  assert.deepEqual(optionValues('options', 'opt-voice'), ['female', 'male']);
  assert.deepEqual(optionKeys('options', 'opt-voice'), ['sim.voice.female', 'sim.voice.male']);
  assert.equal(byId('options', 'opt-voice').closest('label').querySelector('span').getAttribute('data-i18n'), 'sim.voice');
  assert.equal(byId('options', 'opt-voice-hint').getAttribute('data-i18n'), 'sim.voiceRestart');

  assert.deepEqual(attrs('options', 'opt-volume'), { id: 'opt-volume', type: 'range', min: '0', max: '100', step: '5' });
  assert.equal(byId('options', 'opt-volume-value').localName, 'output');
  assert.equal(byId('options', 'opt-volume-value').getAttribute('for'), 'opt-volume');
  assert.equal(byId('options', 'opt-volume').closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.tab.originalVolume');
  for (const [id, lane] of [['opt-captions-tab', 'ext.lane.tab.title'], ['opt-captions-mic', 'ext.lane.mic.title']]) {
    assert.equal(byId('options', id).type, 'checkbox');
    assert.deepEqual(byId('options', id).closest('label').children.filter((child) => child.localName === 'span').map((span) => span.getAttribute('data-i18n')),
      [lane, 'ext.captions.show']);
  }
  assert.equal(byId('options', 'opt-captions-mic-hint').getAttribute('data-i18n'), 'ext.captions.micHint');
  assert.equal(byId('options', 'opt-defaults-hint').getAttribute('data-i18n'), 'ext.options.defaultsHint');

  assert.deepEqual(attrs('options', 'opt-caption-size'), { id: 'opt-caption-size', type: 'range', min: '1', max: '2', step: '0.125' });
  assert.equal(byId('options', 'opt-caption-size-value').localName, 'output');
  assert.equal(byId('options', 'opt-caption-size-value').getAttribute('for'), 'opt-caption-size');
  assert.equal(byId('options', 'opt-caption-size').closest('label').querySelector('span').getAttribute('data-i18n'), 'display.captions.size');
  assert.equal(byId('options', 'opt-caption-size-hint').getAttribute('data-i18n'), 'display.captions.range');
  assert.deepEqual(optionValues('options', 'opt-caption-position'), ['top', 'bottom']);
  assert.deepEqual(optionKeys('options', 'opt-caption-position'), ['ext.options.position.top', 'ext.options.position.bottom']);
  assert.equal(byId('options', 'opt-caption-position').closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.options.captionPosition');
  assert.deepEqual(optionValues('options', 'opt-caption-display'), ['dark', 'light', 'mono']);
  assert.deepEqual(optionKeys('options', 'opt-caption-display'), ['captionOnly.display.dark', 'captionOnly.display.light', 'captionOnly.display.mono']);
  assert.equal(byId('options', 'opt-caption-display').closest('label').querySelector('span').getAttribute('data-i18n'), 'captionOnly.display');
  assert.equal(byId('options', 'opt-caption-source').type, 'checkbox');
  assert.equal(byId('options', 'opt-caption-source').closest('label').querySelector('span').getAttribute('data-i18n'), 'sim.captions.showSource');
  assert.deepEqual([attrs('options', 'opt-caption-lines').type, attrs('options', 'opt-caption-lines').min, attrs('options', 'opt-caption-lines').max], ['number', '1', '6']);
  assert.deepEqual([attrs('options', 'opt-caption-hide').type, attrs('options', 'opt-caption-hide').min, attrs('options', 'opt-caption-hide').max], ['number', '0', '60']);
  assert.equal(byId('options', 'opt-caption-lines').closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.options.captionLines');
  assert.equal(byId('options', 'opt-caption-hide').closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.options.autoHide');
  for (const [id, key] of [['opt-privacy-audio', 'ext.privacy.audio'], ['opt-privacy-free', 'ext.privacy.freeTier'], ['opt-privacy-page', 'ext.privacy.page']]) {
    assert.equal(byId('options', id).getAttribute('data-i18n'), key);
  }
  for (const control of pages.options.document.querySelectorAll('input, select')) {
    assert.ok(control.closest('label'), `#${control.id} has an accessible name from its label`);
  }
});

// ---------------------------------------------------------------------------
// Microphone-permission page (8.4)

test('permission: ids, keys and the persistent status region', () => {
  // The primary button is named like the panel's Allow microphone button and the notices that point at it
  // (ext.permission.allowButton), not "Request microphone permission".
  for (const [id, key, tag] of [['perm-title', 'ext.permission.title', 'h1'], ['perm-lead', 'ext.permission.lead', 'p'],
    ['perm-always', 'ext.permission.chooseAlways', 'p'], ['perm-request', 'ext.permission.allowButton', 'button'],
    ['perm-close', 'common.close', 'button']]) {
    assert.equal(byId('permission', id).localName, tag);
    assert.equal(byId('permission', id).getAttribute('data-i18n'), key);
  }
  for (const id of ['perm-status', 'perm-help']) {
    const region = byId('permission', id);
    assert.equal(region.getAttribute('role'), 'status', `#${id} is role=status`);
    assert.equal(region.hidden, false, `#${id} is a persistent live region: never hidden`);
    assert.equal(region.textContent, '', `#${id} carries no static text`);
    assert.equal(region.hasAttribute('data-i18n'), false, `#${id} is written by the controller, not the binder`);
  }
  assert.equal(byId('permission', 'perm-help').localName, 'p');
  assert.ok(byId('permission', 'perm-help').classList.contains('notice'));
  for (const id of ['perm-request', 'perm-close']) assert.equal(byId('permission', id).getAttribute('type'), 'button');
  assertIncreasing('permission', ['perm-title', 'perm-lead', 'perm-always', 'perm-request', 'perm-close', 'perm-status', 'perm-help']);
});

// ---------------------------------------------------------------------------
// Dictionaries

const placeholdersOf = (value) => [...new Set([...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]))].sort().join(',');

test('dictionaries: 129 ext.* keys with identical key sets and placeholders in ko, en and ja, none shadowing an app key', () => {
  const keys = Object.keys(dictionaries.en.ext);
  assert.equal(keys.length, 129, '117 + the five ext.twoWay.* keys of the two-way mode + the seven §16 keys (display-language switch, update banner)');
  assert.equal(new Set(keys).size, 129);
  for (const language of LANGUAGES) {
    const dictionary = dictionaries[language].ext;
    assert.deepEqual(Object.keys(dictionary).sort(), [...keys].sort(), `${language} has the same keys as en`);
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(key.startsWith('ext.'), key);
      assert.match(key, /^ext(\.[A-Za-z0-9_]+)+$/);
      assert.equal(typeof value, 'string', key);
      assert.equal(value, value.trim(), `${language} ${key} has no edge whitespace`);
      assert.notEqual(value, '', `${language} ${key} is not blank`);
      assert.equal(placeholdersOf(value), placeholdersOf(dictionaries.en.ext[key]), `${language} ${key} keeps its placeholders`);
      assert.equal(Object.hasOwn(dictionaries[language].app, key), false, `${key} does not collide with an app key`);
    }
  }
  assert.deepEqual(Object.fromEntries(keys.filter((key) => placeholdersOf(dictionaries.en.ext[key])).map((key) => [key, placeholdersOf(dictionaries.en.ext[key])])), {
    'ext.lane.statusLine': 'lane,status', 'ext.volume.value': 'percent', 'ext.tab.target': 'title', 'ext.status.reconnecting': 'count', 'ext.arm.shortcut': 'shortcut',
    'ext.update.available': 'current,version',
  });
  for (const key of keys.filter((name) => name.startsWith('ext.error.'))) assert.match(key, /^ext\.error\.[A-Z][A-Z0-9_]+$/, 'error keys are ext.error.<CODE>');
});

test('dictionaries: the wording promises of 9.2 hold (limits, estimate marker, mute hint names the button, the two-way keys)', () => {
  const markers = { ko: '측정', en: 'estimate', ja: '実測' };
  for (const language of LANGUAGES) {
    const dictionary = dictionaries[language].ext;
    assert.ok(dictionary['ext.description'].length <= 132, `${language} description fits the manifest limit`);
    assert.ok(dictionary['ext.name'].length <= 45, `${language} name fits the manifest limit`);
    assert.ok(dictionary['ext.usage.twoSessions'].includes(markers[language]), `${language} says the doubling is not measured`);
    assert.ok(dictionary['ext.mic.mutedHint'].includes(dictionary['ext.sound.on']), `${language} mute hint names the button label exactly`);
    assert.notEqual(dictionary['ext.sound.on'], dictionary['ext.sound.off']);
    // The reverse of the former "no two-way key" promise (D10 was reversed): the extension offers a two-way mode, in five keys.
    assert.deepEqual(Object.keys(dictionary).filter((key) => /twoWay/i.test(key)).sort(),
      ['ext.twoWay.hint', 'ext.twoWay.label', 'ext.twoWay.modelNote', 'ext.twoWay.partner', 'ext.twoWay.targetLabel'], `${language} offers the two-way mode`);
    assert.doesNotMatch(Object.values(dictionary).join('\n'), /<[a-z][^>]*>|&[a-z]+;/i, 'no markup in a dictionary value');
  }
  // §16 (owner, 2026-09-30): the product name is English in every language.
  for (const language of LANGUAGES) assert.equal(dictionaries[language].ext['ext.name'], 'Live Interpreter');
  // The display-language buttons name each language in itself, whatever language the panel shows.
  for (const language of LANGUAGES) {
    assert.deepEqual(['ko', 'ja', 'en'].map((code) => dictionaries[language].ext[`ext.uiLanguage.${code}`]), ['한국어', '日本語', 'English']);
  }
});

test('dictionaries: the strings of the review fixes carry the agreed wording in ko, en and ja', () => {
  const agreed = {
    'ext.status.off': { ko: '꺼져 있어요', en: 'Off', ja: 'オフ' },
    'ext.route.fallbackNote': {
      ko: '예비 모델이 통역 중이에요. 들리는 말에 통역 대신 대답할 수 있어요.',
      en: 'A backup model is interpreting. It may answer what it hears instead of translating.',
      ja: '予備モデルが通訳しています。聞こえた内容を通訳せずに返答することがあります。',
    },
    'ext.key.savedBrowser': { ko: '키를 이 브라우저에 저장했어요.', en: 'Key saved in this browser.', ja: 'キーをこのブラウザに保存しました。' },
  };
  for (const [key, byLanguage] of Object.entries(agreed)) {
    for (const language of LANGUAGES) assert.equal(dictionaries[language].ext[key], byLanguage[language], `${language} ${key}`);
  }
  // The fallback warning names no medium: it is shown on the microphone card too, where "video" (영상) was wrong.
  assert.doesNotMatch(dictionaries.ko.ext['ext.route.fallbackNote'], /영상/);
  // The route line keeps a SHORT label (plus the model id, added by the controller); the sentence lives in the note.
  for (const language of LANGUAGES) {
    const label = dictionaries[language].ext['ext.route.fallback'];
    assert.ok(label.length < 20, `${language} ext.route.fallback is a label, not a sentence (${label})`);
    assert.doesNotMatch(label, /[.。]/, `${language}: no full stop on the route label`);
    assert.notEqual(label, dictionaries[language].ext['ext.route.fallbackNote']);
  }
  // The Korean key-saved line is in the same register as every ext.* string, unlike the app's settings.keySavedBrowser.
  assert.match(dictionaries.ko.ext['ext.key.savedBrowser'], /요\.$/);
  assert.match(dictionaries.ko.app['settings.keySavedBrowser'], /습니다$/, 'the app string this replaces is the formal one');
  // One name for the allow action: the button of the panel and of the permission page, the page title and the notices.
  for (const language of LANGUAGES) {
    const { ext } = dictionaries[language];
    assert.equal(ext['ext.permission.title'], ext['ext.permission.allowButton'], `${language}: page title = button label`);
    assert.ok(ext['ext.error.MICROPHONE_DENIED'].includes(ext['ext.permission.allowButton']), `${language}: the notice names the button exactly`);
  }
  // The number-field labels state the range the field accepts (STYLE_LIMITS is the single source of the limits).
  for (const language of LANGUAGES) {
    const { ext } = dictionaries[language];
    for (const [key, limits] of [['ext.options.captionLines', STYLE_LIMITS.maxLines], ['ext.options.autoHide', STYLE_LIMITS.autoHideSeconds]]) {
      assert.match(ext[key], new RegExp(`${limits.min}\\s*[–~〜-]\\s*${limits.max}`), `${language} ${key} states ${limits.min}-${limits.max}`);
    }
  }
  // The untagged model label used by the tab select: same product name as sim.model0 without the "(default)" tag.
  for (const language of LANGUAGES) {
    const plain = dictionaries[language].ext['ext.options.modelLive'];
    const tagged = dictionaries[language].app['sim.model0'];
    assert.ok(tagged.startsWith(plain) && tagged !== plain, `${language}: ${plain} is sim.model0 without its tag`);
    assert.doesNotMatch(plain, /[()（）]/);
  }
});

test('dictionaries: the two-way strings carry the agreed wording in ko, en and ja (ko in the polite 해요체, the model note names Gemini 3.8 Live)', () => {
  const agreed = {
    'ext.twoWay.label': { ko: '양방 통역', en: 'Two-way interpretation', ja: '双方向通訳' },
    'ext.twoWay.partner': { ko: '상대 언어', en: 'Other language', ja: '相手の言語' },
    'ext.twoWay.targetLabel': { ko: '첫 번째 언어', en: 'First language', ja: '1つ目の言語' },
    'ext.twoWay.hint': {
      ko: '두 언어를 서로 통역해요. 두 언어로 말이 오가는 자리에 알맞아요.',
      en: 'Interprets between the two languages in both directions, for a conversation in both.',
      ja: '2つの言語を相互に通訳します。2つの言語で会話する場面に向いています。',
    },
    'ext.twoWay.modelNote': {
      ko: '양방 통역은 번역 전용 모델을 쓸 수 없어서 이 통역은 Gemini 3.8 Live를 써요.',
      en: 'Two-way cannot use the translation-only model, so this interpretation uses Gemini 3.8 Live.',
      ja: '双方向では翻訳専用モデルを使えないため、この通訳はGemini 3.8 Liveを使います。',
    },
  };
  assert.deepEqual(Object.keys(agreed).sort(), Object.keys(dictionaries.en.ext).filter((key) => key.startsWith('ext.twoWay.')).sort(), 'every two-way key is pinned');
  for (const [key, byLanguage] of Object.entries(agreed)) {
    for (const language of LANGUAGES) assert.equal(dictionaries[language].ext[key], byLanguage[language], `${language} ${key}`);
  }
  for (const key of ['ext.twoWay.hint', 'ext.twoWay.modelNote']) assert.match(dictionaries.ko.ext[key], /요\.$/, `${key} is in the 해요체 like every other ext.* sentence`);
  // The first-language label is a label (no full stop) and differs from the one-way "Target language" label it replaces.
  for (const language of LANGUAGES) {
    assert.doesNotMatch(dictionaries[language].ext['ext.twoWay.targetLabel'], /[.。]/);
    assert.notEqual(dictionaries[language].ext['ext.twoWay.targetLabel'], dictionaries[language].app['language.target']);
  }
});

test('dictionaries: the two-way strings use the product terms of the app and the rest of the extension, never the internal word "lane"', () => {
  for (const language of LANGUAGES) {
    const { ext, app } = dictionaries[language];
    // One feature, one name: the panel checkbox reads like the web app's two-way toggle.
    assert.equal(ext['ext.twoWay.label'], app['sim.twoWay'], `${language}: ext.twoWay.label is the app's sim.twoWay`);
    // The note names the translation-only model the way the route line (sim.route.translation) and the options hint do.
    const term = { ko: '번역 전용 모델', en: 'translation-only model', ja: '翻訳専用モデル' }[language];
    for (const text of [ext['ext.twoWay.modelNote'], app['sim.route.translation'], ext['ext.options.modelTabHint']]) {
      assert.ok(String(text).toLowerCase().includes(term), `${language}: "${text}" says ${term}`);
    }
    // The cards are "Tab audio" and "Microphone": "lane" is a code word, not a product term (placeholders aside).
    for (const [key, value] of Object.entries(ext)) {
      assert.doesNotMatch(value.replace(/\{[^}]*\}/g, ''), /lane|레인|レーン/i, `${language} ${key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Two-way mode (panel): markup contract of the ids the controller wires

for (const lane of ['tab', 'mic']) {
  test(`panel (${lane} card): the two-way checkbox, the partner row, the hint and the model note`, () => {
    const card = byId('panel', `card-${lane}`);
    // The checkbox is named by its label and points at the static hint as its description.
    const box = byId('panel', `${lane}-two-way`);
    assert.equal(box.type, 'checkbox');
    assert.equal(box.closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.twoWay.label', 'the label is the checkbox name');
    assert.equal(box.getAttribute('aria-describedby'), `${lane}-two-way-hint`);
    assert.equal(box.hasAttribute('checked'), false, 'two-way starts off');

    // The first select's label carries an id so the controller can swap its wording; it starts as the one-way label.
    const targetLabel = byId('panel', `${lane}-target-label`);
    assert.equal(targetLabel.getAttribute('data-i18n'), 'language.target');
    assert.equal(targetLabel.closest('label'), byId('panel', `${lane}-target`).closest('label'), 'the label wraps the select it names');

    // The partner row: hidden while two-way is off, a label wrapping the select, options = the languages but the first one.
    const row = byId('panel', `${lane}-partner-row`);
    assert.equal(row.hidden, true, 'the partner row starts hidden (two-way is off)');
    assert.equal(row.hasAttribute('role'), false, 'a plain row, not a live region');
    assert.equal(row.hasAttribute('aria-live'), false);
    const partner = byId('panel', `${lane}-partner`);
    assert.equal(partner.localName, 'select');
    assert.equal(row.contains(partner), true);
    assert.equal(partner.closest('label').querySelector('span').getAttribute('data-i18n'), 'ext.twoWay.partner');
    assert.equal(row.querySelectorAll('label').length, 1);
    const firstTarget = optionValues('panel', `${lane}-target`)[0];
    assert.deepEqual(optionValues('panel', `${lane}-partner`), ['ko', 'en', 'ja'].filter((code) => code !== firstTarget), 'the markup lists every language but the one the target select starts on');
    assert.deepEqual(optionKeys('panel', `${lane}-partner`), optionValues('panel', `${lane}-partner`).map((code) => `language.${code}`));

    // The hint and the note are plain <p> lines: no role, no aria-live (8.2.1: nothing that goes hidden -> visible is live).
    for (const [suffix, key] of [['hint', 'ext.twoWay.hint'], ['note', 'ext.twoWay.modelNote']]) {
      const line = byId('panel', `${lane}-two-way-${suffix}`);
      assert.equal(line.localName, 'p');
      assert.equal(line.getAttribute('data-i18n'), key);
      assert.equal(line.hasAttribute('role'), false, `#${line.id} has no role`);
      assert.equal(line.hasAttribute('aria-live'), false, `#${line.id} is not aria-live`);
      assert.ok(line.classList.contains('text-sub'));
    }
    assert.equal(byId('panel', `${lane}-two-way-hint`).hidden, false, 'the hint always explains the checkbox');
    assert.equal(byId('panel', `${lane}-two-way-note`).hidden, true, 'the model note starts hidden');
    assert.equal(byId('panel', `${lane}-two-way-note`).getAttribute('aria-describedby'), null);
    assert.ok(![...card.querySelectorAll('[aria-describedby]')].some((element) => element.getAttribute('aria-describedby').includes('note')),
      'the note is never a description: a hidden element would still be read');

    // Every control of the card stays wrapped by a label, and DOM order = tab order: target, checkbox, partner.
    for (const control of card.querySelectorAll('input, select')) assert.ok(control.closest('label'), `#${control.id} is wrapped by a label`);
    assertIncreasing('panel', [`${lane}-target`, `${lane}-two-way`, `${lane}-partner`, `${lane}-two-way-hint`, `${lane}-two-way-note`, `${lane}-apply-next`, `${lane}-source-note`]);
    assert.ok(position('panel', `card-${lane}`) < position('panel', `${lane}-two-way`));
  });
}

test('panel: the two-way controls sit inside their own lane cards and the tab order of 8.2.6 still holds', () => {
  assertIncreasing('panel', ['tab-enabled', 'tab-target', 'tab-two-way', 'tab-partner', 'tab-volume', 'tab-captions', 'mic-enabled', 'mic-target',
    'mic-two-way', 'mic-partner', 'mic-captions', 'btn-start']);
  for (const lane of ['tab', 'mic']) {
    for (const id of ['target-label', 'two-way', 'partner-row', 'partner', 'two-way-hint', 'two-way-note']) {
      assert.equal(byId('panel', `${lane}-${id}`).closest('section').id, `card-${lane}`, `#${lane}-${id} is in the ${lane} card`);
    }
  }
});

// ---------------------------------------------------------------------------
// Stylesheets (M2)

// A very small CSS reader: top-level rules and the rules inside @media, comments removed.
function cssRules(css, media = null) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    const head = text.slice(index, open).trim();
    let depth = 1, close = open + 1;
    while (close < text.length && depth > 0) { if (text[close] === '{') depth++; else if (text[close] === '}') depth--; close++; }
    const body = text.slice(open + 1, close - 1);
    if (head.startsWith('@')) rules.push(...cssRules(body, head));
    else {
      const declarations = Object.fromEntries(body.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const at = part.indexOf(':');
        return [part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/\s+/g, ' ')];
      }));
      rules.push({ media, selectors: head.split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')), declarations });
    }
    index = close;
  }
  return rules;
}
const declarationsFor = (rules, selector, media = null) => Object.assign({}, ...rules
  .filter((rule) => rule.media === media && rule.selectors.includes(selector)).map((rule) => rule.declarations));

const stylesText = await readText('styles.css');
const stylesTokens = new Set([...stylesText.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
const stylesHex = new Set([...stylesText.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map((match) => match[0].toLowerCase()));
const sheets = {};
for (const [name, path] of [['panel', 'extension/panel/panel.css'], ['pages', 'extension/pages.css']]) {
  const source = await readText(path);
  sheets[name] = { path, source, css: source.replace(/\/\*[\s\S]*?\*\//g, ''), rules: cssRules(source) };
}

test('stylesheets: no url(), @import or @font-face, only tokens and hex values that styles.css has, text in rem', () => {
  for (const { path, css } of Object.values(sheets)) {
    assert.doesNotMatch(css, /url\s*\(/i, `${path} has no url()`);
    assert.doesNotMatch(css, /@import/i, `${path} has no @import`);
    assert.doesNotMatch(css, /@font-face/i, `${path} declares no font`);
    for (const [, token] of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) assert.ok(stylesTokens.has(token), `${path} uses ${token}, which styles.css defines`);
    for (const [hex] of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) assert.ok(stylesHex.has(hex.toLowerCase()), `${path} uses ${hex}, which styles.css has`);
    assert.doesNotMatch(css, /font-size:\s*[\d.]+px/i, `${path}: text sizes are rem, never fixed px`);
    assert.doesNotMatch(css, /(?:^|[;{\s])font:[^;}]*\d(?:px)\b/i, `${path}: no px in a font shorthand`);
    assert.doesNotMatch(css, /!important/, `${path} does not need !important`);
  }
});

const ATTENTION = { outline: '2px solid var(--accent)', 'outline-offset': '2px', 'font-weight': '700' };
const EMPTY = { margin: '0', padding: '0', border: '0', 'min-height': '0' };
// One row per selector of the 8.2.2 attribute table (plus the sticky row and the mute cue), with the declarations it REQUIRES.
const PANEL_TABLE = [
  ['#btn-options[data-attention="true"]', ATTENTION],
  ['#btn-mic-permission[data-attention="true"]', ATTENTION],
  ['#btn-mic-allow[data-attention="true"]', ATTENTION],
  ['#tab-arm-note[data-attention="true"]', { outline: '2px solid var(--accent)' }],
  ['#tab-arm-note[data-attention="true"]::before', { content: '"\\2192\\00a0"' }],
  ['#usage-note[data-emphasis="true"]', { 'font-weight': '700', 'border-inline-start': '4px solid var(--warning)', 'padding-inline-start': 'var(--space-2)' }],
  ['#status-pill[data-state="idle"]', { 'border-color': 'var(--border)' }],
  ['#status-pill[data-state="starting"]', { 'border-color': 'var(--warning)', 'border-style': 'dashed' }],
  ['#status-pill[data-state="running"]', { 'border-color': 'var(--success)', 'border-style': 'solid' }],
  ['#btn-mute[data-muted="true"]', { 'border-color': 'var(--danger)', color: 'var(--danger)', background: 'var(--surface-alt)' }],
  ['.icon-slash', { display: 'none' }],
  ['#btn-mute[data-muted="true"] .icon-slash', { display: 'inline' }],
  ['.notice:empty', EMPTY],
  ['.text-sub:empty', EMPTY],
  ['.button-row', { position: 'sticky', bottom: '0', 'z-index': '1', background: 'var(--surface)', 'border-top': '1px solid var(--border)',
    'padding-block': 'var(--space-2)' }],
];

test('panel.css: a rule for EVERY selector of the 8.2.2 attribute table, with the declarations the contract requires', () => {
  for (const [selector, required] of PANEL_TABLE) {
    const declared = declarationsFor(sheets.panel.rules, selector);
    assert.notDeepEqual(declared, {}, `panel.css has a rule for ${selector}`);
    for (const [property, value] of Object.entries(required)) assert.equal(declared[property], value, `${selector} { ${property} }`);
  }
});

test('styles.css dims an aria-disabled button exactly like a disabled one, and hover skips it (Start uses aria-disabled)', () => {
  const rules = cssRules(stylesText);
  const shared = rules.find((rule) => rule.media === null && rule.selectors.includes('.btn:disabled'));
  assert.ok(shared, 'the .btn:disabled rule exists');
  assert.ok(shared.selectors.includes('.btn[aria-disabled="true"]'), 'one rule: an aria-disabled button looks exactly like a disabled one');
  assert.equal(shared.declarations.cursor, 'not-allowed');
  const hoverSelectors = rules.filter((rule) => rule.media === '@media (hover: hover)').flatMap((rule) => rule.selectors);
  assert.ok(hoverSelectors.includes('.btn-primary:hover:not(:disabled):not([aria-disabled="true"])'), 'no hover feedback on a dimmed Start');
  assert.equal(declarationsFor(sheets.panel.rules, '#btn-start').background, undefined, 'panel.css does not repaint Start over the dimmed look');
});

test('panel.css: the attribute values the controller sets are exactly the ones styled (no data-state, data-attention or data-emphasis without a rule)', () => {
  const html = pages.panel.source;
  const used = (name) => new Set([...html.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map((match) => match[1]));
  const styled = (attribute, id) => [...new Set(sheets.panel.rules.flatMap((rule) => rule.selectors)
    .filter((selector) => selector.startsWith(`#${id}[${attribute}="`)).map((selector) => selector.match(/="([^"]+)"/)[1]))];
  assert.deepEqual(new Set(styled('data-state', 'status-pill')), new Set(['idle', 'starting', 'running']), 'the three panel-only pill states');
  assert.ok(used('data-state').has('idle'), 'the pill starts as idle in the markup');
  for (const id of ['btn-options', 'btn-mic-permission', 'btn-mic-allow', 'tab-arm-note']) assert.deepEqual(styled('data-attention', id), ['true'], id);
  assert.deepEqual(styled('data-emphasis', 'usage-note'), ['true']);
  assert.deepEqual(styled('data-muted', 'btn-mute'), ['true']);
  assert.ok(used('data-muted').has('true'), 'the mute button starts muted in the markup');
});

test('panel.css: the empty-live-region collapse never hides a region (no display:none, no [hidden] on live elements), and #key-missing collapses through its text span', () => {
  const declared = declarationsFor(sheets.panel.rules, '.notice:empty');
  assert.equal(declared.display, undefined, 'a collapsed region stays in the accessibility tree: no display:none');
  const key = declarationsFor(sheets.panel.rules, '#key-missing:has(> #key-missing-text:empty)');
  for (const [property, value] of Object.entries(EMPTY)) assert.equal(key[property], value);
  assert.equal(key.display, undefined);
  // The reason it needs :has(): #key-missing holds a span and a button, so it is never :empty itself.
  assert.equal(pages.panel.document.getElementById('key-missing').children.length, 2);
  assert.equal(pages.panel.document.getElementById('key-missing-text').textContent, '');
});

test('panel.css: layout facts of 8.2.2 (sticky opaque row, 44 px icon buttons, a preview of at most 10 rem, row bars, 320 px friendly)', () => {
  const rules = sheets.panel.rules;
  const row = declarationsFor(rules, '.button-row');
  assert.equal(row.display, 'flex');
  assert.equal(row['flex-wrap'], 'wrap');
  assert.equal(row.gap, 'var(--space-2)');
  assert.notEqual(row.background, 'transparent', 'opaque: scrolled content never shows through');
  assert.equal(declarationsFor(rules, '.icon-btn')['min-width'], 'var(--touch)');
  assert.equal(declarationsFor(rules, '.icon-btn')['min-height'], 'var(--touch)');
  const preview = declarationsFor(rules, '.caption-preview');
  assert.equal(preview['max-height'], '10rem');
  assert.equal(preview['overflow-y'], 'auto');
  assert.equal(preview['font-size'], '1rem');
  assert.equal(declarationsFor(rules, '.caption-preview > * + *')['border-top'], '1px solid var(--border)', 'rows separated by 1 px --border');
  assert.deepEqual([declarationsFor(rules, '.caption-preview > [data-status="partial"]').color, declarationsFor(rules, '.caption-preview > [data-status="partial"]')['border-inline-start']],
    ['var(--text-muted)', '3px dashed var(--accent)']);
  assert.equal(declarationsFor(rules, '.caption-preview > [data-status="interrupted"]')['border-inline-start'], '3px solid var(--danger)');
  assert.equal(declarationsFor(rules, '.caption-preview > [data-skipped="true"]').color, 'var(--text-muted)');
  assert.equal(declarationsFor(rules, '.caption-flag')['font-weight'], '700', 'the text label of a skipped or interrupted row is styled');
  // The sticky row is the last block of main and main is a column, so `margin-top: auto` puts it at the bottom of a short page.
  assert.equal(declarationsFor(rules, '.panel main').display, 'flex');
  assert.equal(declarationsFor(rules, '.panel main')['flex-direction'], 'column');
  assert.equal(declarationsFor(rules, '.panel main > .button-row')['margin-top'], 'auto');
  assert.equal(declarationsFor(rules, '.panel main > .button-row')['margin-inline'], 'calc(-1 * var(--page-x))');
  assert.equal(declarationsFor(rules, '.panel main')['padding'], 'var(--page-x)');
  assert.equal(sheets.panel.css.includes('min-width: 320') || sheets.panel.css.includes('width: 320'), false, 'no fixed panel width');
});

test('panel.css: the partner row is indented under the checkbox text and the sheet never overrides its hidden attribute', () => {
  const row = declarationsFor(sheets.panel.rules, '.partner-row');
  assert.equal(row['padding-inline-start'], 'calc(1.25rem + var(--space-2))', 'the checkbox width plus its gap, as in .field-check');
  assert.equal(row.display, undefined, 'no display of its own: the hidden attribute of the markup hides it');
  // The hidden attribute wins because the shared stylesheet says so (`.partner-row` and `.field` would otherwise be laid out).
  assert.match(stylesText, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.equal(byId('panel', 'tab-partner-row').classList.contains('partner-row'), true);
  assert.equal(byId('panel', 'mic-partner-row').classList.contains('partner-row'), true);
  for (const rule of sheets.panel.rules) {
    for (const selector of rule.selectors.filter((name) => /partner|two-way/.test(name))) {
      assert.equal(rule.declarations.display, undefined, `${selector}: no display override that could show a hidden row`);
    }
  }
});

test('panel.css and pages.css: every id and class the selectors name exists in the markup they style', () => {
  const idsAndClasses = (name) => {
    const pageNames = name === 'panel' ? ['panel'] : ['options', 'permission'];
    const ids = new Set(), classes = new Set();
    for (const page of pageNames) {
      for (const element of elementsOf(page)) {
        if (element.id) ids.add(element.id);
        for (const className of (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) classes.add(className);
      }
      for (const className of pages[page].bodyClass.split(' ')) classes.add(className);
    }
    // Created at run time by the panel controller's makePreviewRow (8.2.2 preview rows): a row and its text label.
    if (name === 'panel') for (const className of ['caption-row', 'caption-flag']) classes.add(className);
    return { ids, classes };
  };
  for (const name of ['panel', 'pages']) {
    const { ids, classes } = idsAndClasses(name);
    for (const rule of sheets[name].rules) {
      for (const selector of rule.selectors) {
        const bare = selector.replace(/\[[^\]]*\]/g, '');
        for (const [, id] of bare.matchAll(/#([A-Za-z][\w-]*)/g)) assert.ok(ids.has(id), `${sheets[name].path}: #${id} exists in the page (${selector})`);
        for (const [, className] of bare.matchAll(/\.([A-Za-z][\w-]*)/g)) assert.ok(classes.has(className), `${sheets[name].path}: .${className} exists in the page (${selector})`);
      }
    }
  }
});

test('panel.css and pages.css: hover only inside (hover: hover), motion off under reduced motion, borders kept under forced colors', () => {
  for (const { path, rules } of Object.values(sheets)) {
    for (const rule of rules) {
      if (rule.selectors.some((selector) => selector.includes(':hover'))) assert.equal(rule.media, '@media (hover: hover)', `${path}: ${rule.selectors.join(', ')}`);
      const moving = ['transition', 'animation'].filter((property) => rule.declarations[property] !== undefined && rule.declarations[property] !== 'none');
      assert.deepEqual(moving, [], `${path}: no motion of its own (${rule.selectors.join(', ')})`);
    }
    const reduced = rules.filter((rule) => rule.media === '@media (prefers-reduced-motion: reduce)');
    assert.ok(reduced.some((rule) => rule.declarations.transition === 'none' && rule.declarations.animation === 'none'), `${path} switches motion off`);
    const forced = rules.filter((rule) => rule.media === '@media (forced-colors: active)');
    assert.ok(forced.length > 0 && forced.every((rule) => Object.keys(rule.declarations).every((property) => /border|outline/.test(property))),
      `${path}: forced colors keep BORDERS and outlines (state is never background alone)`);
  }
  assert.ok(sheets.panel.rules.some((rule) => rule.media === '@media (hover: hover)'), 'the panel has hover effects, in the right place');
});

test('pages.css: one centred column that works from 320 px, no sticky row, live regions collapse when empty, rows are label-wrapped grids', () => {
  const rules = sheets.pages.rules;
  const main = declarationsFor(rules, '.page main');
  assert.equal(main['max-width'], '40rem');
  assert.equal(main['margin-inline'], 'auto');
  assert.equal(main.padding, 'var(--page-x)');
  assert.equal(declarationsFor(rules, '.button-row').position, undefined, 'the options and permission button rows are not sticky');
  for (const selector of ['.notice:empty', '.text-sub:empty']) for (const [property, value] of Object.entries(EMPTY)) assert.equal(declarationsFor(rules, selector)[property], value, selector);
  assert.equal(declarationsFor(rules, '.field').display, 'grid');
  assert.equal(declarationsFor(rules, '.field-check')['min-height'], 'var(--touch)');
  assert.equal(declarationsFor(rules, '#opt-key-guide')['min-height'], 'var(--touch)');
  assert.equal(declarationsFor(rules, '.options-page #opt-saved').position, 'sticky');
  assert.equal(declarationsFor(rules, '.permission-page main')['max-width'], '32rem');
});

// The overlay's stylesheet is a JS literal (a content script cannot fetch a file), so it is extracted from the source
// the way tests/appearance-boot.test.mjs extracts its inline script.
const overlaySource = await readText('extension/overlay/overlay.js');
const sheetLiteral = /const SHEET = (\[[\s\S]*?\]\.join\('\\n'\));/.exec(overlaySource);
const overlayCss = sheetLiteral ? vm.runInNewContext(sheetLiteral[1]) : '';
const overlayRules = cssRules(overlayCss);

// The default (navy) tone's light and dark sets from the first :root block, and the mono board block of 8.5.2.
const rootBlock = /^:root \{([^}]*)\}/m.exec(stylesText)[1];
const palette = Object.fromEntries([...rootBlock.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2].toLowerCase()]));
const monoBlock = /\.caption-board\[data-caption-only="true"\]\[data-display="mono"\]\s*\{([^}]*)\}/.exec(stylesText)[1];
const mono = Object.fromEntries([...monoBlock.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2].toLowerCase()]));
const TOKENS = ['--bg', '--text', '--muted', '--border', '--accent', '--danger'];
const fromStyles = {
  dark: { '--bg': palette['--dark-surface'], '--text': palette['--dark-text'], '--muted': palette['--dark-text-muted'], '--border': palette['--dark-border'],
    '--accent': palette['--dark-accent'], '--danger': palette['--dark-danger'] },
  light: { '--bg': palette['--light-surface'], '--text': palette['--light-text'], '--muted': palette['--light-text-muted'], '--border': palette['--light-border'],
    '--accent': palette['--light-accent'], '--danger': palette['--light-danger'] },
  mono: { '--bg': mono['--bg'], '--text': mono['--text'], '--muted': mono['--text-muted'], '--border': mono['--border'], '--accent': mono['--accent'], '--danger': mono['--danger'] },
};
// The table of 8.5.2, written out so a change in styles.css is noticed twice (against the file and against the contract).
const CONTRACT_TABLE = {
  dark: { '--bg': '#1e2329', '--text': '#edf0f3', '--muted': '#aab3bd', '--border': '#3a434d', '--accent': '#7fb6dd', '--danger': '#ff8a80' },
  light: { '--bg': '#ffffff', '--text': '#1a1d21', '--muted': '#4d5560', '--border': '#c9d0d8', '--accent': '#1f5f8b', '--danger': '#a5282c' },
  mono: { '--bg': '#000000', '--text': '#ffffff', '--muted': '#d4d4d4', '--border': '#8a8a8a', '--accent': '#ffffff', '--danger': '#ffb4ab' },
};

test('overlay tokens (8.5.2): the stylesheet of overlay.js carries exactly the table of the contract, and it equals the values in styles.css', () => {
  assert.ok(sheetLiteral, 'the SHEET literal is found in overlay.js');
  for (const display of ['dark', 'light', 'mono']) {
    const declared = declarationsFor(overlayRules, `.wrap[data-display="${display}"]`);
    assert.deepEqual(Object.fromEntries(TOKENS.map((token) => [token, declared[token]])), CONTRACT_TABLE[display], `${display}: the contract table`);
    assert.deepEqual(fromStyles[display], CONTRACT_TABLE[display], `${display}: styles.css still holds the same values`);
  }
  assert.deepEqual(declarationsFor(overlayRules, '.wrap:not([data-display])'), declarationsFor(overlayRules, '.wrap[data-display="dark"]'), 'no data-display paints dark');
  assert.equal(Object.keys(fromStyles.mono).every((token) => fromStyles.mono[token]), true, 'the mono board block was found');
  assert.equal(new Set(TOKENS.map((token) => overlayCss.split(`var(${token})`).length > 1)).has(false), false, 'every token is used');
});

test('overlay stylesheet: reduced motion and forced colors, the flex-end overflow anchor with its top fade, no url(), only hex values of styles.css', () => {
  assert.doesNotMatch(overlayCss, /url\s*\(|@import|@font-face/i);
  for (const [hex] of overlayCss.matchAll(/#[0-9a-f]{3,8}\b/gi)) assert.ok(stylesHex.has(hex.toLowerCase()) || ['#000', '#fff'].includes(hex.toLowerCase()), `${hex} is in styles.css (or a mask stop)`);
  assert.deepEqual(declarationsFor(overlayRules, '.wrap', '@media (prefers-reduced-motion: no-preference)'), { transition: 'opacity 150ms ease-out' });
  assert.equal(declarationsFor(overlayRules, '.wrap', '@media (forced-colors: active)')['border-color'], 'CanvasText');
  const wrap = declarationsFor(overlayRules, '.wrap');
  assert.equal(wrap['justify-content'], 'flex-end');
  assert.match(wrap['mask-image'], /^linear-gradient\(to bottom, transparent 0, #000 1\.5em\)/);
  assert.equal(wrap['pointer-events'], 'none');
  assert.equal(declarationsFor(overlayRules, '.close')['pointer-events'], 'auto', 'the close button is the only interactive part');
  assert.equal(overlayRules.filter((rule) => rule.declarations['pointer-events'] === 'auto').length, 1);
  assert.equal(declarationsFor(overlayRules, '.close')['min-width'], '28px');
  assert.equal(declarationsFor(overlayRules, '.close')['min-height'], '28px');
});

// WCAG 2.x relative luminance and contrast ratio.
const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const [r, g, b] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('contrast helper: known values (black on white 21:1, identical colors 1:1, #767676 on white just passes 4.5:1)', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#123456', '#123456'), 1);
  assert.ok(contrast('#767676', '#ffffff') > 4.5 && contrast('#777777', '#ffffff') < 4.5);
});

test('contrast (overlay): text and muted text pass 4.5:1 and the accent and danger bars pass 3:1 on every display mode', () => {
  for (const display of ['dark', 'light', 'mono']) {
    const table = CONTRACT_TABLE[display];
    for (const token of ['--text', '--muted']) assert.ok(contrast(table[token], table['--bg']) >= 4.5, `${display} ${token} on --bg: ${contrast(table[token], table['--bg']).toFixed(2)}`);
    for (const token of ['--accent', '--danger']) assert.ok(contrast(table[token], table['--bg']) >= 3, `${display} ${token} bar on --bg: ${contrast(table[token], table['--bg']).toFixed(2)}`);
  }
  // The border is decoration on dark and light (the same token pair as the web app, about 1.6:1): the close button is
  // identified by its glyph, which is --text (checked above), and the mono set has a real 3:1 border.
  assert.ok(contrast(CONTRACT_TABLE.mono['--border'], CONTRACT_TABLE.mono['--bg']) >= 3);
});

test('contrast (panel): the text, link, bar and cue pairs of panel.css pass in the light and the dark set of styles.css', () => {
  for (const set of ['light', 'dark']) {
    const t = (name) => palette[`--${set}-${name}`];
    const text = [['text', 'surface'], ['text-muted', 'surface'], ['text', 'bg'], ['text-muted', 'bg'], ['text', 'surface-alt'],
      ['text-muted', 'surface-alt'], ['accent', 'surface']];   // body text, hints, preview rows, links and the hover color
    for (const [foreground, background] of text) assert.ok(contrast(t(foreground), t(background)) >= 4.5, `${set} ${foreground} on ${background}: ${contrast(t(foreground), t(background)).toFixed(2)}`);
    const graphic = [['accent', 'surface-alt'], ['danger', 'surface-alt'], ['danger', 'surface'], ['warning', 'surface'], ['success', 'surface'],
      ['accent', 'surface']];   // preview bars, the mute cue, the pill borders, the attention outline
    for (const [foreground, background] of graphic) assert.ok(contrast(t(foreground), t(background)) >= 3, `${set} ${foreground} on ${background}: ${contrast(t(foreground), t(background)).toFixed(2)}`);
  }
});
