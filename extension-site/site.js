// Renders the Live Interpreter download and guide page from content.js. Text only ever goes in through textContent
// and createElement, never parsed as HTML. `?lang=ko|ja|en&os=win|mac` pick the variant; `&print=1` is the PDF mode the
// package script prints (it also passes `version` and `released`, so the PDF never depends on a network fetch).
import { CONTENT, LANGS, OSES, SITE, manualFile } from './content.js';

const params = new URLSearchParams(window.location.search);
const printing = params.get('print') === '1';
const pick = (value, allowed) => (allowed.includes(value) ? value : null);

function detectLanguage() {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const base = String(tag ?? '').toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'en';
}

function detectOs() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac/i.test(platform) || /Macintosh|Mac OS X/.test(navigator.userAgent ?? '') ? 'mac' : 'win';
}

const state = {
  lang: pick(params.get('lang'), LANGS) ?? detectLanguage(),
  os: pick(params.get('os'), OSES) ?? detectOs(),
  latest: null,
};

// --- DOM helpers ------------------------------------------------------------------------------------------------

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Material Icons paths (Apache License 2.0).
const PATHS = Object.freeze({
  puzzle: 'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z',
  pin: 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z',
  reload: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
});

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name}`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (token, name) => (name in values ? String(values[name]) : token));

// --- inline markup ----------------------------------------------------------------------------------------------

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[(?:btn|toggle|kbd|folder|link):[^\]]+\]|\[(?:puzzle|pin|reload|ext)\])/g;

function token(raw, ui) {
  if (raw.startsWith('**')) return el('strong', {}, raw.slice(2, -2));
  if (raw.startsWith('`')) return el('code', {}, raw.slice(1, -1));
  const colon = raw.indexOf(':');
  const kind = colon === -1 ? raw.slice(1, -1) : raw.slice(1, colon);
  const value = colon === -1 ? '' : raw.slice(colon + 1, -1);
  switch (kind) {
    case 'btn': return el('span', { class: 'chip chip-btn' }, value);
    case 'toggle': return el('span', { class: 'chip chip-toggle' }, value, el('span', { class: 'switch', 'aria-hidden': 'true' }));
    case 'kbd': return el('kbd', {}, value);
    case 'folder': return el('span', { class: 'chip chip-folder' }, icon('folder'), value);
    case 'link': return el('a', { href: value, target: '_blank', rel: 'noopener' }, value.replace(/^https:\/\//, ''));
    case 'ext': return el('img', { class: 'chip-ext', src: 'icons/icon-32.png', alt: 'Live Interpreter', width: '18', height: '18' });
    default: return el('span', { class: 'chip-icon', role: 'img', 'aria-label': ui.icons[kind] ?? kind }, icon(kind));
  }
}

function inline(text, ui) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    fragment.append(token(match[0], ui));
    last = match.index + match[0].length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

// A step or bullet: a string, { win, mac } or { text, note }. Returns null when it does not apply to this OS.
function itemFor(item, os) {
  if (typeof item === 'string') return { text: item };
  if (item && ('win' in item || 'mac' in item)) return typeof item[os] === 'string' ? { text: item[os] } : null;
  return item && typeof item.text === 'string' ? item : null;
}

const perOs = (value, os) => (value && !Array.isArray(value) && typeof value === 'object' && ('win' in value || 'mac' in value) ? value[os] : value);

// --- rendering --------------------------------------------------------------------------------------------------

function formatDate(released, lang) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(released ?? '')) return '';
  const date = new Date(`${released}T00:00:00Z`);
  return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function segmented(label, options, current, onPick) {
  const group = el('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const [value, text] of options) {
    const button = el('button', { type: 'button', 'aria-pressed': String(value === current), lang: value in CONTENT ? value : null }, text);
    button.addEventListener('click', () => onPick(value));
    group.append(button);
  }
  return group;
}

function renderSection(section, ui, os) {
  const node = el('section', { class: 'card', id: section.id, 'aria-labelledby': `h-${section.id}` });
  node.append(el('h2', { id: `h-${section.id}` }, section.title));
  const intro = perOs(section.intro, os);
  if (typeof intro === 'string') node.append(el('p', { class: 'intro' }, inline(intro, ui)));
  for (const para of section.paras ?? []) node.append(el('p', {}, inline(para, ui)));
  const steps = perOs(section.steps, os);
  if (Array.isArray(steps)) {
    const list = el('ol', { class: 'steps' });
    for (const raw of steps) {
      const item = itemFor(raw, os);
      if (!item) continue;
      const li = el('li', {}, inline(item.text, ui));
      if (item.note) li.append(el('span', { class: 'step-note' }, inline(item.note, ui)));
      list.append(li);
    }
    node.append(list);
  }
  const bullets = perOs(section.bullets, os);
  if (Array.isArray(bullets)) {
    const list = el('ul', { class: 'bullets' });
    for (const raw of bullets) {
      const item = itemFor(raw, os);
      if (item) list.append(el('li', {}, inline(item.text, ui)));
    }
    node.append(list);
  }
  if (Array.isArray(section.faq)) {
    const list = el('dl', { class: 'faq' });
    for (const entry of section.faq) {
      if (entry.os && entry.os !== os) continue;
      list.append(el('dt', {}, inline(entry.q, ui)), el('dd', {}, inline(entry.a, ui)));
    }
    node.append(list);
  }
  return node;
}

function render() {
  const { lang, os, latest } = state;
  const content = CONTENT[lang];
  const { ui } = content;
  const osName = ui.os[os];
  document.documentElement.lang = lang;
  document.documentElement.classList.toggle('print-mode', printing);
  document.title = printing ? `Live Interpreter — ${fill(ui.manualTitle, { os: osName })}` : 'Live Interpreter';

  const app = document.getElementById('app');
  app.replaceChildren();

  const brand = el('div', { class: 'brand' },
    el('img', { src: 'icons/icon-128.png', alt: '', width: '48', height: '48' }),
    el('div', {}, el('h1', {}, 'Live Interpreter'), el('p', { class: 'tagline' }, ui.tagline),
      el('p', { class: 'print-only manual-title' }, fill(ui.manualTitle, { os: osName }))));
  const controls = el('div', { class: 'controls' },
    segmented(ui.languageLabel, LANGS.map((code) => [code, CONTENT[code].name]), lang, (value) => update({ lang: value })),
    segmented(ui.osLabel, OSES.map((code) => [code, ui.os[code]]), os, (value) => update({ os: value })));
  app.append(el('header', { class: 'top' }, brand, controls));

  const version = latest?.version
    ? fill(ui.versionLine, { version: latest.version, date: formatDate(latest.released, lang) }).replace(/\s·\s$/, '')
    : ui.versionUnknown;
  const download = el('a', { class: 'download', href: SITE.zip, download: SITE.zip }, icon('download'), ui.download);
  const pdf = el('a', { href: `manuals/${manualFile(os, lang)}` }, fill(ui.manualPdf, { os: osName }));
  const webApp = el('a', { href: SITE.webApp, target: '_blank', rel: 'noopener' }, ui.webApp);
  app.append(el('div', { class: 'hero' },
    download,
    el('p', { class: 'version' }, version),
    el('p', { class: 'note' }, ui.downloadNote),
    el('p', { class: 'hero-links' }, pdf, webApp),
    el('p', { class: 'print-only source' }, fill(ui.printSource, { url: `${SITE.origin}/` }))));

  for (const section of content.sections) app.append(renderSection(section, ui, os));

  const manuals = el('ul', { class: 'manuals' });
  for (const code of LANGS) {
    for (const system of OSES) {
      manuals.append(el('li', {}, el('a', { href: `manuals/${manualFile(system, code)}`, lang: code }, `${CONTENT[code].name} · ${CONTENT[code].ui.os[system]}`)));
    }
  }
  app.append(el('footer', { class: 'foot' }, el('h2', {}, ui.allManuals), manuals));
}

function update(next) {
  Object.assign(state, next);
  if (!printing) {
    const query = new URLSearchParams({ lang: state.lang, os: state.os });
    window.history.replaceState(null, '', `?${query}`);
  }
  render();
}

async function loadLatest() {
  const version = params.get('version');
  if (version) return { version, released: params.get('released') ?? '' };
  try {
    const response = await fetch(SITE.latest, { cache: 'no-cache' });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.version === 'string' ? { version: data.version, released: typeof data.released === 'string' ? data.released : '' } : null;
  } catch {
    return null;
  }
}

render();
state.latest = await loadLatest();
render();
document.documentElement.dataset.ready = 'true';
