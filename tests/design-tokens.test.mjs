// P3-12: design tokens, four tones x two modes, text steps, shared components
// and computed WCAG contrast. The stylesheet is parsed with a small cascade
// model (specificity + order + media) so the assertions exercise the real
// selectors rather than a hand-copied table. A Node parser is not a browser:
// layout, touch size and rendered contrast stay manual items (V01–V03, V07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

const TONES = ['navy', 'warm', 'forest', 'mono'];
const MODES = ['light', 'dark'];
const TEXT_STEPS = { s: '87.5%', m: '100%', l: '112.5%', xl: '125%' };
const TOKENS = ['bg', 'surface', 'surface-alt', 'text', 'text-muted', 'border', 'accent', 'accent-soft',
  'accent-text', 'success', 'warning', 'danger', 'recording', 'focus'];
// DESIGN.md §2 light/dark table for the default tone; tones may only change the accent/background families.
const NAVY = {
  light: { bg: '#f6f7f9', surface: '#ffffff', 'surface-alt': '#eef1f5', text: '#1a1d21', 'text-muted': '#4d5560',
    border: '#c9d0d8', accent: '#1f5f8b', 'accent-soft': '#e8f1f8', 'accent-text': '#ffffff', success: '#1e7a46',
    warning: '#8a5a00', danger: '#a5282c', recording: '#b3261e', focus: '#ff9f1c' },
  dark: { bg: '#14171b', surface: '#1e2329', 'surface-alt': '#262c34', text: '#edf0f3', 'text-muted': '#aab3bd',
    border: '#3a434d', accent: '#7fb6dd', 'accent-soft': '#22313d', 'accent-text': '#0f1a22', success: '#7fd5a3',
    warning: '#ffcf6a', danger: '#ff8a80', recording: '#ff6b60', focus: '#ff9f1c' },
};
const TONE_ONLY = new Set(['bg', 'surface', 'surface-alt', 'accent', 'accent-soft', 'accent-text']);

// --- minimal CSS model -------------------------------------------------------

function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, ''); }

// Flattens rules into { media, selector, declarations } in source order.
function parseRules(source, media = null, out = []) {
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    if (open < 0) break;
    const prelude = source.slice(index, open).trim();
    let depth = 1; let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + 1, cursor - 1);
    if (prelude.startsWith('@media')) parseRules(body, prelude.slice('@media'.length).trim(), out);
    else if (prelude.startsWith('@')) { /* other at-rules carry no tokens */ }
    else {
      const declarations = [];
      for (const part of body.split(';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        declarations.push([part.slice(0, colon).trim(), part.slice(colon + 1).replace(/!important/g, '').trim()]);
      }
      for (const selector of prelude.split(',')) out.push({ media, selector: selector.trim(), declarations });
    }
    index = cursor;
  }
  return out;
}

const RULES = parseRules(stripComments(css));

// Matches selectors that target the root element only: `:root`/`html` followed
// by attribute selectors and :not([attr]) clauses. Returns specificity or null.
function matchRoot(selector, attrs) {
  const match = /^(:root|html)((?:\[[^\]]+\]|:not\(\[[^\]]+\]\))*)$/.exec(selector);
  if (!match) return null;
  let specificity = match[1] === ':root' ? 10 : 1;
  const clauses = match[2].match(/:not\(\[[^\]]+\]\)|\[[^\]]+\]/g) ?? [];
  for (const clause of clauses) {
    const negated = clause.startsWith(':not(');
    const inner = /\[([a-z-]+)(?:="([^"]*)")?\]/.exec(clause);
    const present = Object.hasOwn(attrs, inner[1]) && (inner[2] === undefined || attrs[inner[1]] === inner[2]);
    if (present === negated) return null;
    specificity += 10;
  }
  return specificity;
}

function mediaApplies(media, env) {
  if (media === null) return true;
  if (media === '(prefers-color-scheme: dark)') return env.systemDark;
  return false; // min-width, hover, reduced-motion: not part of the root token cascade
}

// Computes the root's custom properties for the given html attributes and environment.
function resolveRoot(attrs, env) {
  const winners = new Map();
  RULES.forEach((rule, order) => {
    if (!mediaApplies(rule.media, env)) return;
    const specificity = matchRoot(rule.selector, attrs);
    if (specificity === null) return;
    for (const [property, value] of rule.declarations) {
      const current = winners.get(property);
      if (!current || specificity >= current.specificity) winners.set(property, { specificity, order, value });
    }
  });
  const raw = Object.fromEntries([...winners].map(([property, entry]) => [property, entry.value]));
  const resolve = (value, depth = 0) => {
    assert.ok(depth < 10, `var() chain too deep in ${value}`);
    return value.replace(/var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)/g, (_all, name, fallback) => {
      if (Object.hasOwn(raw, name)) return resolve(raw[name], depth + 1);
      assert.ok(fallback !== undefined, `unresolved ${name}`);
      return resolve(fallback, depth + 1);
    });
  };
  return Object.fromEntries(Object.entries(raw).map(([property, value]) => [property, resolve(value)]));
}

function tokens(tone, mode, env) {
  const attrs = {};
  if (tone !== 'navy') attrs['data-tone'] = tone;
  if (mode !== 'system') attrs['data-mode'] = mode;
  const root = resolveRoot(attrs, env);
  const result = {};
  for (const name of TOKENS) result[name] = root[`--${name}`];
  result['danger-text'] = root['--danger-text'];
  result['translation-bg'] = root['--translation-bg'];
  result['color-scheme'] = root['color-scheme'];
  return result;
}

// --- WCAG 2.x contrast ---------------------------------------------------------

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/, `not a 6-digit hex colour: ${hex}`);
  const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));
}

export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const TEXT_PAIRS = [
  // foreground, background, minimum, label
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-alt'], ['text', 'accent-soft'],
  ['text-muted', 'bg'], ['text-muted', 'surface'], ['text-muted', 'surface-alt'], ['text-muted', 'accent-soft'],
  ['accent-text', 'accent'], ['danger-text', 'danger'],
  ['accent', 'bg'], ['accent', 'surface'], ['accent', 'surface-alt'],
  ['success', 'bg'], ['success', 'surface'], ['warning', 'bg'], ['warning', 'surface'],
  ['danger', 'bg'], ['danger', 'surface'], ['recording', 'bg'], ['recording', 'surface'],
];

// --- tests -----------------------------------------------------------------------

test('contrast helper matches the WCAG reference values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(contrast('#777777', '#ffffff') > 4.47 && contrast('#777777', '#ffffff') < 4.49, true);
  assert.equal(contrast('#1f5f8b', '#ffffff') > 6.5, true);
});

test('every tone x mode defines all DESIGN.md §2 tokens as hex colours', () => {
  for (const tone of TONES) for (const mode of MODES) {
    const set = tokens(tone, mode, { systemDark: false });
    for (const name of TOKENS) assert.match(set[name] ?? '', /^#[0-9a-f]{6}$/, `${tone}/${mode} --${name}`);
    assert.match(set['danger-text'], /^#[0-9a-f]{6}$/, `${tone}/${mode} --danger-text`);
    assert.equal(set['translation-bg'], set['accent-soft'], `${tone}/${mode} --translation-bg aliases --accent-soft`);
    assert.equal(set['color-scheme'], mode, `${tone}/${mode} color-scheme`);
  }
});

test('navy is the DESIGN.md §2 table and other tones only change accent/background families', () => {
  for (const mode of MODES) {
    const navy = tokens('navy', mode, { systemDark: false });
    for (const name of TOKENS) assert.equal(navy[name], NAVY[mode][name], `navy/${mode} --${name}`);
    for (const tone of TONES.slice(1)) {
      const set = tokens(tone, mode, { systemDark: false });
      for (const name of TOKENS) {
        if (!TONE_ONLY.has(name)) assert.equal(set[name], navy[name], `${tone}/${mode} shares --${name}`);
      }
      assert.notEqual(set.accent, navy.accent, `${tone}/${mode} has its own accent`);
    }
  }
  assert.equal(tokens('warm', 'light', { systemDark: false }).accent, '#8a4b1f');
  assert.equal(tokens('warm', 'light', { systemDark: false }).bg, '#faf6f0');
  assert.equal(tokens('warm', 'dark', { systemDark: false }).bg, '#1b1613');
  assert.equal(tokens('forest', 'light', { systemDark: false }).accent, '#1f6b4a');
  assert.equal(tokens('forest', 'light', { systemDark: false }).bg, '#f3f8f5');
  assert.equal(tokens('forest', 'dark', { systemDark: false }).bg, '#121b16');
  assert.equal(tokens('mono', 'light', { systemDark: false }).accent, '#111111');
  assert.equal(tokens('mono', 'light', { systemDark: false }).bg, '#ffffff');
  assert.equal(tokens('mono', 'dark', { systemDark: false }).bg, '#000000');
});

test('mode cascade: system follows the media query, forced light beats system dark, forced dark beats system light', () => {
  for (const tone of TONES) {
    const light = tokens(tone, 'light', { systemDark: false });
    const dark = tokens(tone, 'dark', { systemDark: false });
    assert.notEqual(light.bg, dark.bg, tone);
    assert.deepEqual(tokens(tone, 'system', { systemDark: false }), light, `${tone} system/light`);
    assert.deepEqual(tokens(tone, 'system', { systemDark: true }), dark, `${tone} system/dark`);
    assert.deepEqual(tokens(tone, 'light', { systemDark: true }), light, `${tone} forced light on system dark`);
    assert.deepEqual(tokens(tone, 'dark', { systemDark: false }), dark, `${tone} forced dark on system light`);
  }
});

test('text contrast is at least 4.5:1 in all eight tone/mode combinations', () => {
  const report = [];
  for (const tone of TONES) for (const mode of MODES) {
    const set = tokens(tone, mode, { systemDark: false });
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrast(set[fg], set[bg]);
      report.push(`${tone}/${mode} ${fg} on ${bg} = ${ratio.toFixed(2)}`);
      assert.ok(ratio >= 4.5, `${tone}/${mode}: --${fg} ${set[fg]} on --${bg} ${set[bg]} is ${ratio.toFixed(2)}:1`);
    }
    // Non-text: border and recording state against the surfaces they outline (3:1 where achievable;
    // the dark border is a documented low-contrast separator, so it is only checked in light mode).
    if (mode === 'light') assert.ok(contrast(set.border, set.surface) >= 1.5, `${tone}/light border visible`);
    assert.ok(contrast(set.recording, set.surface) >= 3, `${tone}/${mode} recording border`);
  }
  assert.equal(report.length, TONES.length * MODES.length * TEXT_PAIRS.length);
});

test('focus ring: 2px orange with 2px offset plus a text-colour ring so one ring is visible on any background', () => {
  const rule = RULES.find((entry) => entry.selector === ':focus-visible' && entry.media === null);
  assert.ok(rule, ':focus-visible rule');
  const declarations = Object.fromEntries(rule.declarations);
  assert.equal(declarations.outline, '2px solid var(--focus)');
  assert.equal(declarations['outline-offset'], '2px');
  assert.match(declarations['box-shadow'], /^0 0 0 2px var\(--text\)$/);
  for (const tone of TONES) for (const mode of MODES) {
    const set = tokens(tone, mode, { systemDark: false });
    assert.equal(set.focus, '#ff9f1c', `${tone}/${mode} --focus`);
    // The ring is drawn outside the element, over the page or card behind it.
    for (const surface of ['bg', 'surface', 'surface-alt']) {
      const best = Math.max(contrast(set.focus, set[surface]), contrast(set.text, set[surface]));
      assert.ok(best >= 3, `${tone}/${mode}: focus rings on --${surface} reach ${best.toFixed(2)}:1`);
    }
    if (mode === 'dark') assert.ok(contrast(set.focus, set.bg) >= 3, `${tone}/dark orange ring alone`);
  }
});

test('text steps are 87.5/100/112.5/125 percent and do not touch the 44px targets', () => {
  for (const [step, size] of Object.entries(TEXT_STEPS)) {
    const root = resolveRoot({ 'data-text': step }, { systemDark: false });
    assert.equal(root['font-size'], size, `data-text=${step}`);
    assert.equal(root['--touch'], '44px', `data-text=${step} keeps --touch`);
  }
  assert.equal(resolveRoot({}, { systemDark: false })['font-size'], '100%');
  assert.equal(/font-size:\s*\d+(\.\d+)?px/.test(css), false, 'no fixed px font sizes');
  assert.match(css, /--touch: 44px/);
});

test('shared components exist with the DESIGN.md §4 contract', () => {
  const block = (selector) => {
    const rule = RULES.find((entry) => entry.selector === selector && entry.media === null);
    assert.ok(rule, `rule ${selector}`);
    return Object.fromEntries(rule.declarations);
  };
  const btn = block('.btn');
  assert.equal(btn['min-height'], 'var(--touch)');
  assert.equal(btn['min-width'], 'var(--touch)');
  assert.equal(btn['border-radius'], 'var(--radius)');
  assert.equal(btn['font-weight'], '600');
  assert.equal(btn['touch-action'], 'manipulation');
  assert.equal(block('.btn-primary').background, 'var(--accent)');
  assert.equal(block('.btn-primary').color, 'var(--accent-text)');
  assert.equal(block('.btn-secondary').background, 'var(--surface-alt)');
  assert.equal(block('.btn-danger').background, 'var(--danger)');
  assert.equal(block('.btn-text').color, 'var(--accent)');
  assert.equal(block('.btn-text')['text-decoration'], 'none');
  const disabled = block('.btn:disabled');
  assert.equal(disabled.background, 'var(--surface-alt)');
  assert.equal(disabled.color, 'var(--text-muted)');
  assert.equal(disabled.opacity, undefined, 'disabled uses tokens, not opacity');
  assert.equal(/\.btn[^{]*\{[^}]*opacity/s.test(css), false, 'no opacity on buttons');
  assert.equal(/aria-disabled[^{]*\{[^}]*opacity/s.test(css), false, 'no opacity on aria-disabled');
  assert.equal(block('.card')['border-radius'], 'var(--radius-card)');
  assert.equal(block('.card')['box-shadow'], undefined, 'cards are flat');
  assert.equal(block('.badge')['border-radius'], '999px');
  assert.equal(block('.badge')['font-size'], '0.8125rem');
  const tab = block('.shell-tab');
  assert.equal(tab['min-height'], 'var(--touch)');
  assert.equal(block('.shell-tab[aria-selected="true"]')['border-bottom-color'], 'var(--accent)');
  assert.equal(block('.shell-tab[aria-selected="true"]')['font-weight'], '700');
  assert.ok(RULES.some((entry) => entry.selector === '.tabs' && entry.media === null));
  assert.ok(RULES.some((entry) => entry.selector === '.tab' && entry.media === null));
  const sheet = block('.sheet');
  assert.equal(sheet.position, 'fixed');
  assert.equal(sheet.inset, '0');
  assert.equal(block('.sheet-header').position, 'sticky');
  assert.equal(block('.sheet-footer').position, 'sticky');
  assert.equal(block('.sheet-body')['overflow-y'], 'auto');
  const modal = RULES.find((entry) => entry.selector === '.sheet' && entry.media === '(min-width: 40rem)');
  assert.ok(modal, 'tablet modal');
  const modalDeclarations = Object.fromEntries(modal.declarations);
  assert.match(modalDeclarations.width, /640px/);
  assert.equal(modalDeclarations['box-shadow'], 'var(--dialog-shadow)');
  assert.equal(resolveRoot({}, { systemDark: false })['--dialog-shadow'], '0 12px 32px rgba(0, 0, 0, 0.18)');
  assert.equal(block('textarea')['min-height'], 'var(--touch)');
  assert.equal(block('select')['min-height'], 'var(--touch)');
  assert.match(css, /select, textarea \{[^}]*min-height: var\(--touch\)/s);
  const ptt = block('.seq-ptt');
  assert.equal(ptt['min-height'], 'max(64px, 4rem)');
  assert.equal(ptt['touch-action'], 'none');
  const desktopPtt = RULES.find((entry) => entry.selector === '.seq-ptt' && entry.media === '(min-width: 64rem)');
  assert.equal(Object.fromEntries(desktopPtt.declarations)['min-height'], 'max(56px, 3.5rem)');
  assert.match(block('.seq-ptt[aria-pressed="true"]')['box-shadow'], /3px var\(--recording\)/);
  assert.equal(block('.turn-text-translation').background, 'var(--accent-soft)');
  assert.equal(block('.turn-text').background, 'var(--surface-alt)');
  assert.equal(block('.sim-caption[data-status="partial"]').color, 'var(--text-muted)');
});

test('typography, spacing scale and breakpoints follow DESIGN.md §3, §5 and §8', () => {
  const root = resolveRoot({}, { systemDark: false });
  assert.deepEqual(['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7'].map((name) => root[name]),
    ['0.25rem', '0.5rem', '0.75rem', '1rem', '1.5rem', '2rem', '3rem']);
  assert.equal(root['--radius'], '0.75rem');
  assert.equal(root['--radius-card'], '1rem');
  assert.equal(root['--motion'], '150ms ease-out');
  const body = Object.fromEntries(RULES.find((entry) => entry.selector === 'body'
    && entry.declarations.some(([property]) => property === 'font-family')).declarations);
  assert.equal(body['font-size'], '1rem');
  assert.equal(body['line-height'], '1.5');
  assert.match(body['font-family'], /^-apple-system, "Segoe UI", Roboto, "Noto Sans KR", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif$/);
  assert.equal(body['overflow-wrap'], 'anywhere');
  const declaration = (selector, property) => Object.fromEntries(RULES.find((entry) => entry.selector === selector && entry.media === null).declarations)[property];
  assert.equal(declaration('.text-sub', 'font-size'), '0.875rem');
  assert.equal(declaration('.label', 'font-size'), '0.8125rem');
  assert.equal(declaration('.label', 'font-weight'), '600');
  assert.equal(declaration('.title', 'font-size'), '1.25rem');
  assert.equal(declaration('.app-title', 'font-size'), '1.125rem');
  assert.equal(declaration('.shell-title', 'font-size'), '1.125rem');
  assert.equal(declaration('.caption-text', 'font-size'), '1.25rem');
  const tabletCaption = RULES.find((entry) => entry.selector === '.turn-text-translation' && entry.media === '(min-width: 40rem)');
  assert.equal(Object.fromEntries(tabletCaption.declarations)['font-size'], '1.5rem');
  assert.match(declaration('.mono', 'font-family'), /^ui-monospace/);
  const medias = [...new Set(RULES.map((entry) => entry.media).filter(Boolean))];
  assert.deepEqual(medias.filter((media) => /width/.test(media)).sort(), ['(min-width: 40rem)', '(min-width: 64rem)']);
  assert.equal(/max-width\s*:\s*\d/.test(medias.join(' ')), false, 'min-width breakpoints only');
  const main40 = RULES.filter((entry) => entry.media === '(min-width: 40rem)' && entry.selector === '.shell-main');
  assert.ok(main40.some((entry) => Object.fromEntries(entry.declarations)['max-width'] === '40rem'));
  const main64 = RULES.filter((entry) => entry.media === '(min-width: 64rem)' && entry.selector === '.shell-main');
  assert.ok(main64.some((entry) => Object.fromEntries(entry.declarations)['max-width'] === '60rem'));
});

test('hover, reduced motion, forced colours and static-asset hygiene', () => {
  for (const rule of RULES) {
    if (/:hover/.test(rule.selector)) assert.equal(rule.media, '(hover: hover)', `hover only inside @media (hover: hover): ${rule.selector}`);
  }
  const reduced = RULES.filter((entry) => entry.media === '(prefers-reduced-motion: reduce)');
  assert.ok(reduced.length > 0);
  const universal = reduced.find((entry) => entry.selector === '*');
  assert.ok(universal, 'universal reduced-motion rule');
  const declarations = Object.fromEntries(universal.declarations);
  assert.equal(declarations['transition-duration'], '0s');
  assert.equal(declarations['animation-duration'], '0s');
  assert.ok(RULES.some((entry) => entry.media === '(forced-colors: active)'));
  assert.equal(/https?:\/\/|@import|url\(/.test(css), false);
  assert.equal(/content:\s*["'][^"']*[A-Za-z가-힣ぁ-んァ-ン]/.test(css), false, 'no visible text in CSS');
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});

test('caption board display modes reuse the tone light/dark sets and the mono high-contrast set', () => {
  const board = (display) => Object.fromEntries(RULES.find((entry) =>
    entry.selector === `.caption-board[data-caption-only="true"][data-display="${display}"]`).declarations);
  assert.equal(board('light')['--bg'], 'var(--light-bg)');
  assert.equal(board('dark')['--bg'], 'var(--dark-bg)');
  assert.equal(board('light')['--translation-bg'], 'var(--accent-soft)');
  const mono = board('mono');
  assert.equal(mono['--bg'], '#000000');
  assert.equal(mono['--text'], '#ffffff');
  assert.ok(contrast(mono['--text'], mono['--bg']) >= 4.5);
  assert.ok(contrast(mono['--text-muted'], mono['--bg']) >= 4.5);
  assert.ok(contrast(mono['--accent-text'], mono['--accent']) >= 4.5);
  assert.ok(contrast(mono['--danger'], mono['--bg']) >= 4.5);
});
