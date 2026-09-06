// P3-16: the shared sheet/modal behaviour (design-p3 §1.9).
// Mutual exclusion, inert background, Tab/Shift+Tab trap, Escape, focus return
// and the sticky action row. Part one drives app/ui/sheet.js directly; part two
// checks that the shell's settings and share surfaces really run on it, that
// opening a sheet touches no engine, and that no inert survives a close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSheetGroup, focusableWithin } from '../app/ui/sheet.js';

// --- a document double with the surface sheet.js uses ---
class Node {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this.hidden = false; this.disabled = false;
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  remove() { if (!this.parentNode) return; this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, handler) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
function fixture() {
  const doc = { activeElement: null };
  const make = (tag) => new Node(doc, tag);
  doc.createElement = make;
  const header = make('header'), main = make('main');
  const background = [header, main];

  const build = (name) => {
    const element = make('section');
    const close = make('button'), first = make('button'), last = make('button');
    element.append(close, first, last);
    const opener = make('button');
    header.append(opener);
    return { element, close, first, last, opener, name };
  };
  const a = build('a'), b = build('b');
  const changes = [];
  const group = createSheetGroup({ document: doc, background, onChange: (id) => changes.push(id) });
  const sheetA = group.register({ id: 'a', element: a.element, openers: [a.opener], initialFocus: a.close });
  const sheetB = group.register({ id: 'b', element: b.element, openers: [b.opener], initialFocus: b.close });
  const inert = () => background.map((node) => node.hasAttribute('inert'));
  return { doc, group, a, b, sheetA, sheetB, background, header, main, inert, changes, make };
}
const tab = (element, shiftKey = false) => element.dispatch('keydown', { key: 'Tab', shiftKey });
const escape = (element) => element.dispatch('keydown', { key: 'Escape' });

test('a registered sheet starts hidden, collapsed and with the background untouched', () => {
  const f = fixture();
  assert.equal(f.a.element.hidden, true);
  assert.equal(f.b.element.hidden, true);
  assert.equal(f.a.opener.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.inert(), [false, false]);
  assert.equal(f.group.openId, null);
  assert.equal(f.sheetA.isOpen, false);
  assert.throws(() => f.group.register({}), TypeError);
  assert.throws(() => createSheetGroup({}), TypeError);
});

test('opening marks the background inert, moves focus in and reports the open sheet', () => {
  const f = fixture();
  f.doc.activeElement = f.a.opener;
  assert.equal(f.sheetA.open(), true);
  assert.equal(f.a.element.hidden, false);
  assert.equal(f.a.opener.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.inert(), [true, true]);
  assert.equal(f.doc.activeElement, f.a.close, 'initialFocus wins');
  assert.equal(f.group.openId, 'a');
  assert.deepEqual(f.changes, ['a']);
});

test('sheets are mutually exclusive and the background is never left inert', () => {
  const f = fixture();
  f.doc.activeElement = f.a.opener;
  f.sheetA.open();
  f.sheetB.open();
  assert.equal(f.a.element.hidden, true, 'opening one closes the other');
  assert.equal(f.b.element.hidden, false);
  assert.equal(f.a.opener.getAttribute('aria-expanded'), 'false');
  assert.equal(f.b.opener.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.inert(), [true, true], 'the background stays inert across a swap');
  assert.equal(f.group.openId, 'b');

  f.sheetB.close();
  assert.deepEqual(f.inert(), [false, false], 'no inert survives the close');
  assert.equal(f.group.openId, null);
  assert.equal(f.doc.activeElement, f.a.opener,
    'focus returns to whatever had it before the first sheet, not to the sheet that swapped in');
  assert.deepEqual(f.changes, ['a', 'b', null]);
});

test('Escape closes the sheet and returns focus; a keystroke on a closed sheet does nothing', () => {
  const f = fixture();
  f.doc.activeElement = f.a.opener;
  f.sheetA.open();
  const event = escape(f.a.element);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.a.element.hidden, true);
  assert.equal(f.doc.activeElement, f.a.opener);
  assert.deepEqual(f.inert(), [false, false]);
  escape(f.a.element);
  assert.equal(f.group.openId, null, 'Escape on a closed sheet is inert');
});

test('Tab and Shift+Tab wrap inside the open sheet only', () => {
  const f = fixture();
  f.sheetA.open();
  f.a.last.focus();
  assert.equal(tab(f.a.element).defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.a.close, 'Tab past the end wraps to the first');
  assert.equal(tab(f.a.element).defaultPrevented, false, 'a Tab in the middle is the browser\u2019s');
  f.a.close.focus();
  assert.equal(tab(f.a.element, true).defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.a.last, 'Shift+Tab before the first wraps to the last');
  // Focus that escaped the sheet is pulled back to the edge the key heads for.
  f.doc.activeElement = f.header;
  tab(f.a.element);
  assert.equal(f.doc.activeElement, f.a.close);
  f.doc.activeElement = f.header;
  tab(f.a.element, true);
  assert.equal(f.doc.activeElement, f.a.last);
  // A keystroke on the sheet that is not open is ignored.
  tab(f.b.element);
  assert.equal(f.doc.activeElement, f.a.last);
});

test('the focus order follows the live DOM: hidden and disabled controls drop out and new ones join', () => {
  const f = fixture();
  f.sheetA.open();
  assert.deepEqual(f.group.focusOrder(), [f.a.close, f.a.first, f.a.last]);
  f.a.first.hidden = true;
  f.a.last.disabled = true;
  assert.deepEqual(f.group.focusOrder(), [f.a.close]);
  const added = f.make('input');
  f.a.element.append(added);
  assert.deepEqual(f.group.focusOrder(), [f.a.close, added], 'content added while open is trapped too');
  // A hidden or inert subtree is skipped whole, and tabindex decides for the rest.
  const box = f.make('div');
  const inside = f.make('button');
  box.append(inside);
  box.hidden = true;
  f.a.element.append(box);
  assert.equal(f.group.focusOrder().includes(inside), false);
  box.hidden = false;
  assert.equal(f.group.focusOrder().includes(inside), true);
  box.setAttribute('inert', '');
  assert.equal(f.group.focusOrder().includes(inside), false);
  const skipped = f.make('button');
  skipped.setAttribute('tabindex', '-1');
  f.a.element.append(skipped);
  assert.equal(focusableWithin(f.a.element).includes(skipped), false, 'tabindex="-1" is not in the tab order');
});

test('onOpen may abort, onOpened runs after focus landed, and a reopen keeps focus where it is', () => {
  const f = fixture();
  const seen = [];
  let allow = true;
  const element = f.make('section');
  const inner = f.make('button');
  element.append(inner);
  const sheet = f.group.register({ id: 'c', element, openers: [f.a.opener],
    onOpen: (detail) => { seen.push(['open', detail, f.doc.activeElement]); return allow; },
    onOpened: (detail) => { seen.push(['opened', detail, f.doc.activeElement]); },
    onClose: () => seen.push(['close']) });

  allow = false;
  assert.equal(sheet.open('x'), false, 'a refused open does not leave the sheet showing');
  assert.equal(element.hidden, true);
  assert.deepEqual(f.inert(), [false, false], 'a refused open restores the background');

  allow = true;
  seen.length = 0;
  sheet.open('y');
  assert.equal(seen[0][0], 'open');
  assert.notEqual(seen[0][2], inner, 'onOpen runs before focus moves, so it can still change the content');
  assert.deepEqual([seen[1][0], seen[1][1], seen[1][2]], ['opened', 'y', inner]);

  inner.focus();
  seen.length = 0;
  sheet.open('z');
  assert.deepEqual(seen.map((entry) => entry[0]), ['open', 'opened'], 'a reopen notifies without closing');
  assert.equal(f.doc.activeElement, inner, 'a reopen does not throw focus back to the top');
});

test('destroy closes everything, clears inert and detaches the key handlers', () => {
  const f = fixture();
  f.doc.activeElement = f.a.opener;
  f.sheetA.open();
  const before = f.a.element.listenerCount;
  assert.ok(before > 0);
  f.group.destroy();
  assert.equal(f.a.element.hidden, true);
  assert.deepEqual(f.inert(), [false, false], 'a teardown never leaves the page inert');
  assert.equal(f.a.element.listenerCount, 0);
  assert.equal(f.group.openId, null);
  assert.equal(f.sheetA.open(), false, 'a destroyed group opens nothing');
  assert.deepEqual(f.inert(), [false, false]);
  assert.deepEqual(f.group.focusOrder(), []);
});

test('closeAll is safe with nothing open and closes what is open', () => {
  const f = fixture();
  assert.equal(f.group.closeAll(), false);
  f.sheetA.open();
  assert.equal(f.group.closeAll(), true);
  assert.deepEqual(f.inert(), [false, false]);
});

test('a listener that throws cannot leave the group half open', () => {
  const f = fixture();
  const element = f.make('section');
  element.append(f.make('button'));
  const sheet = f.group.register({ id: 'd', element,
    onOpen: () => { throw new Error('consumer'); },
    onClose: () => { throw new Error('consumer'); } });
  assert.equal(sheet.open(), true, 'a throwing onOpen is not a refusal');
  assert.equal(f.group.openId, 'd');
  sheet.close();
  assert.equal(f.group.openId, null);
  assert.deepEqual(f.inert(), [false, false]);
});

// --- the shell really runs on the group, and the CSS carries the contract ---

test('styles: the settings and share surfaces use the .sheet contract, with a scrolling body and a sticky action row', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? null : css.slice(at, css.indexOf('}', at));
  };
  const sheet = rule('.sheet');
  assert.match(sheet, /position:\s*fixed/);
  assert.match(sheet, /display:\s*flex/);
  assert.match(sheet, /flex-direction:\s*column/);
  const body = rule('.sheet-body');
  assert.match(body, /overflow-y:\s*auto/, 'the body scrolls, not the sheet');
  assert.match(body, /min-height:\s*0/, 'a flex child needs min-height 0 to scroll');
  const bars = rule('.sheet-header, .sheet-footer');
  assert.match(bars, /position:\s*sticky/, 'the title row and the action row stay put');
  assert.match(css, /\.sheet-footer\s*\{[^}]*bottom:\s*0/);
  assert.match(css, /\.sheet-footer\s*\{[^}]*env\(safe-area-inset-bottom\)/);
  // The old per-dialog positioning is gone: both now carry .sheet in the DOM.
  assert.equal(rule('.shell-settings'), null, 'settings no longer positions itself');
  assert.equal(rule('.share-dialog'), null, 'share no longer positions itself');
  // Tablet and up: one centred modal rule for every sheet, capped at 640px.
  const desktop = css.slice(css.indexOf('@media (min-width: 40rem)'));
  assert.match(desktop, /\.sheet\s*\{[^}]*width:\s*min\(640px/);
  assert.match(desktop, /\.sheet\s*\{[^}]*box-shadow:\s*var\(--dialog-shadow\)/);
});

test('shell: the modal mechanics are delegated, not duplicated, and the share behaviour is only relocated', async () => {
  const shell = await readFile(new URL('../app/ui/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /import \{ createSheetGroup \} from '\.\/sheet\.js'/);
  assert.match(shell, /createSheetGroup\(\{ document: doc, background: inertTargets \}\)/);
  // Exactly one place may touch inert, and it is not this file.
  assert.equal(/setAttribute\('inert'/.test(shell), false, 'shell.js no longer sets inert itself');
  assert.equal(/removeAttribute\('inert'/.test(shell), false, 'shell.js no longer clears inert itself');
  // Escape and the Tab trap live in sheet.js now.
  assert.equal(/key === 'Escape'/.test(shell), false, 'Escape handling is not duplicated per dialog');
  assert.equal(/event\.key !== 'Tab'/.test(shell), false, 'the Tab trap is not duplicated per dialog');
  // The teardown closes the group before anything else, so nothing stays inert.
  assert.match(shell, /sheetGroup\.destroy\(\);/);
  // P2-25 behaviour was moved, not rewritten: the URL, the QR path and the
  // clipboard call are still the same code, now inside the sheet hooks.
  assert.match(shell, /icons\/qr-site\.png/);
  assert.match(shell, /clipboard\?\.writeText/);
  assert.match(shell, /shareStatusKey/);
  // Opening or closing a sheet must not reach the engine or a session.
  const hooks = shell.slice(shell.indexOf('const shareSheet'), shell.indexOf('function openShare'));
  for (const forbidden of ['engine.', 'stopWork', 'cancel(', 'start(']) {
    assert.equal(hooks.includes(forbidden), false, `the share sheet hooks must not call ${forbidden}`);
  }
});
