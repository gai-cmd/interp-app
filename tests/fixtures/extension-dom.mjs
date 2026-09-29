// New implementation of docs/extension.md §11.3; no legacy code is ported.
//
// A small DOM double for the extension pages and the caption overlay. It does
// NOT extend the app fixtures (tests/fixtures/scenarios.mjs): it has its own
// parser for the controlled markup of section 8 (well-formed, no scripts, void
// elements, boolean attributes), a selector matcher good enough for ids,
// classes, tags, attributes and the descendant/child combinators, event
// dispatch with bubbling, shadow roots that model open vs closed, popover,
// constructable stylesheets and a document with visibility and fullscreen
// events. There is no layout and no CSS cascade: what this proves is which
// nodes, attributes and text a controller produced, never how it looks.
//
// Like the app's scenario fixture, every way of writing markup (innerHTML,
// outerHTML, insertAdjacentHTML, document.write) throws, so a controller that
// renders untrusted text through HTML fails loudly instead of silently.
import vm from 'node:vm';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'main', 'nav', 'p', 'section', 'span']);
const CUSTOM_ELEMENT = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const camel = (name) => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
const domError = (name, message) => new DOMException(message, name);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
  if (body[0] === '#') {
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  }
  return ENTITIES[body.toLowerCase()] ?? match;
});

// ---------------------------------------------------------------------------
export class FakeEvent {
  constructor(type, init = {}) {
    const { bubbles = false, cancelable = false, composed = false, ...rest } = init;
    this.type = type; this.bubbles = bubbles; this.cancelable = cancelable; this.composed = composed;
    this.defaultPrevented = false; this.target = null; this.currentTarget = null;
    this._stopped = false; this._immediate = false;
    Object.assign(this, rest);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; this._immediate = true; }
}
const asFakeEvent = (event) => {
  if (event instanceof FakeEvent) return event;
  const { type, bubbles, cancelable, composed, ...rest } = event;
  const own = Object.fromEntries(Object.entries(rest).filter(([key]) => !['target', 'currentTarget', 'defaultPrevented', 'timeStamp', 'isTrusted'].includes(key)));
  return new FakeEvent(type, { bubbles, cancelable, composed, ...own });
};

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, listener, options) {
    if (!listener) return;
    const once = typeof options === 'object' && options !== null && options.once === true;
    const list = this._listeners.get(type) ?? [];
    if (list.some((entry) => entry.listener === listener)) return;
    list.push({ listener, once });
    this._listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }
  get listenerCount() { return [...this._listeners.values()].reduce((sum, list) => sum + list.length, 0); }
  listeners(type) { return (this._listeners.get(type) ?? []).map((entry) => entry.listener); }
  _eventParent() { return null; }
  _invoke(event) {
    for (const entry of [...(this._listeners.get(event.type) ?? [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      // A throwing listener propagates to the dispatcher (stricter than the
      // DOM, which reports and continues): a controller that lets an error
      // escape an event handler must fail its test.
      if (typeof entry.listener === 'function') entry.listener.call(this, event); else entry.listener.handleEvent(event);
      if (event._immediate) break;
    }
  }
  /** Bubbling dispatch (capture phase is not modeled). Returns !defaultPrevented. */
  dispatchEvent(input) {
    const event = asFakeEvent(input);
    event.target = this;
    let node = this;
    while (node) {
      event.currentTarget = node;
      node._invoke(event);
      if (event._stopped || !event.bubbles) break;
      const parent = node._eventParent(event);
      node = parent;
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

// ---------------------------------------------------------------------------
export class FakeText {
  constructor(ownerDocument, data) {
    this.nodeType = 3; this.ownerDocument = ownerDocument; this.data = String(data); this.parentNode = null;
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value ?? ''); }
  get isConnected() { return Boolean(this.parentNode?.isConnected); }
  remove() { this.parentNode?._detach(this); }
}

export class FakeCSSStyleSheet {
  constructor() { this.cssText = ''; this.replaceCalls = 0; }
  replaceSync(text) { this.replaceCalls++; this.cssText = String(text); }
  async replace(text) { this.replaceSync(text); return this; }
}

class FakeStyleDeclaration {
  constructor() { this._props = new Map(); }
  setProperty(name, value, priority = '') { this._props.set(name, { value: String(value), priority }); }
  getPropertyValue(name) { return this._props.get(name)?.value ?? ''; }
  getPropertyPriority(name) { return this._props.get(name)?.priority ?? ''; }
  removeProperty(name) { const previous = this.getPropertyValue(name); this._props.delete(name); return previous; }
  get length() { return this._props.size; }
  get cssText() { return [...this._props].map(([name, { value, priority }]) => `${name}: ${value}${priority ? ` !${priority}` : ''};`).join(' '); }
}
const makeStyle = () => {
  const target = new FakeStyleDeclaration();
  return new Proxy(target, {
    get: (object, key) => (key in object || typeof key !== 'string' ? Reflect.get(object, key) : object.getPropertyValue(kebab(key))),
    set: (object, key, value) => { object.setProperty(kebab(String(key)), value); return true; },
  });
};

// ---------------------------------------------------------------------------
// Selectors: comma lists of compounds joined by descendant (' ') or child ('>').
// A compound is an optional tag or '*', then #id, .class, [attr], [attr op value],
// :checked, :disabled, :not(compound). Anything else throws, so a typo in a
// test cannot silently match nothing.
function parseCompound(text, at) {
  const compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [], nots: [] };
  let index = at;
  const ident = () => { const match = /^[A-Za-z0-9_\-\\]+/.exec(text.slice(index)); if (!match) throw new Error(`bad selector near "${text.slice(index)}"`); index += match[0].length; return match[0]; };
  if (text[index] === '*') { compound.tag = '*'; index++; } else if (/[A-Za-z]/.test(text[index] ?? '')) compound.tag = ident().toLowerCase();
  for (;;) {
    const char = text[index];
    if (char === '#') { index++; compound.id = ident(); } else if (char === '.') { index++; compound.classes.push(ident()); } else if (char === '[') {
      const end = text.indexOf(']', index);
      if (end < 0) throw new Error('unterminated attribute selector');
      const body = text.slice(index + 1, end);
      const match = /^\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(body);
      if (!match) throw new Error(`bad attribute selector [${body}]`);
      compound.attrs.push({ name: match[1].toLowerCase(), op: match[2] ?? null, value: match[3] ?? match[4] ?? match[5] ?? '' });
      index = end + 1;
    } else if (char === ':') {
      index++;
      const name = ident();
      if (name === 'not') {
        if (text[index] !== '(') throw new Error(':not needs an argument');
        const end = text.indexOf(')', index);
        compound.nots.push(parseCompound(text.slice(index + 1, end), 0).compound);
        index = end + 1;
      } else if (name === 'checked' || name === 'disabled') compound.pseudos.push(name);
      else throw new Error(`unsupported pseudo-class :${name}`);
    } else break;
  }
  return { compound, index };
}
function parseSelectors(selector) {
  const out = [];
  for (const part of String(selector).split(/,(?![^\[(]*[\])])/)) {
    const text = part.trim();
    if (!text) throw new Error('empty selector');
    const chain = [];
    let index = 0, combinator = null;
    while (index < text.length) {
      while (text[index] === ' ') index++;
      if (text[index] === '>') { combinator = '>'; index++; while (text[index] === ' ') index++; }
      if (index >= text.length) break;
      const { compound, index: next } = parseCompound(text, index);
      if (next === index) throw new Error(`bad selector "${text}"`);
      chain.push({ combinator: chain.length ? (combinator ?? ' ') : null, compound });
      combinator = null;
      index = next;
      if (text[index] === ' ' || text[index] === '>') combinator = ' ';
    }
    out.push(chain);
  }
  return out;
}
const attrMatches = (element, { name, op, value }) => {
  const actual = element.getAttribute(name);
  if (actual === null) return false;
  switch (op) {
    case null: return true;
    case '=': return actual === value;
    case '~=': return actual.split(/\s+/).includes(value);
    case '^=': return actual.startsWith(value);
    case '$=': return actual.endsWith(value);
    case '*=': return actual.includes(value);
    case '|=': return actual === value || actual.startsWith(`${value}-`);
    default: return false;
  }
};
const compoundMatches = (element, c) => (c.tag === null || c.tag === '*' || element.localName === c.tag)
  && (c.id === null || element.id === c.id)
  && c.classes.every((name) => element.classList.contains(name))
  && c.attrs.every((attr) => attrMatches(element, attr))
  && c.pseudos.every((name) => (name === 'checked' ? element.checked : element.disabled))
  && !c.nots.some((not) => compoundMatches(element, not));
function chainMatches(element, chain, at) {
  if (!compoundMatches(element, chain[at].compound)) return false;
  if (at === 0) return true;
  const { combinator } = chain[at];
  if (combinator === '>') return element.parentElement !== null && chainMatches(element.parentElement, chain, at - 1);
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) if (chainMatches(ancestor, chain, at - 1)) return true;
  return false;
}
const matchesAny = (element, selector) => parseSelectors(selector).some((chain) => chainMatches(element, chain, chain.length - 1));
function* descendants(node) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    yield child;
    yield* descendants(child);
  }
}

// ---------------------------------------------------------------------------
// Shared node behavior (children, queries) for elements, shadow roots and documents.
class FakeParent extends FakeEventTarget {
  constructor() { super(); this.childNodes = []; }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  _detach(node) { this.childNodes = this.childNodes.filter((item) => item !== node); node.parentNode = null; }
  _adopt(node) {
    if (typeof node === 'string') node = new FakeText(this.ownerDocument ?? this, node);
    if (node.nodeType === 1) for (let up = this; up; up = up.parentNode) if (up === node) throw domError('HierarchyRequestError', 'a node cannot contain itself');
    node.parentNode?._detach(node);
    node.parentNode = this;
    return node;
  }
  // A fragment hands over its children and stays empty, like the DOM's.
  _flatten(nodes) { return nodes.flatMap((node) => (node instanceof FakeFragment ? node.childNodes.splice(0).map((child) => { child.parentNode = null; return child; }) : [node])); }
  append(...nodes) { for (const node of this._flatten(nodes)) this.childNodes.push(this._adopt(node)); }
  prepend(...nodes) { this.childNodes.unshift(...this._flatten(nodes).map((node) => this._adopt(node))); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, reference) {
    const adopted = this._adopt(node);
    const at = reference ? this.childNodes.indexOf(reference) : -1;
    if (reference && at < 0) throw domError('NotFoundError', 'reference node is not a child');
    if (at < 0) this.childNodes.push(adopted); else this.childNodes.splice(at, 0, adopted);
    return node;
  }
  removeChild(node) {
    if (node.parentNode !== this) throw domError('NotFoundError', 'node is not a child');
    this._detach(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this._detach(child);
    this.append(...nodes);
  }
  contains(node) { for (let up = node; up; up = up.parentNode) if (up === this) return true; return false; }
  querySelectorAll(selector) { return [...descendants(this)].filter((element) => matchesAny(element, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getElementById(id) { return [...descendants(this)].find((element) => element.id === id) ?? null; }
  getElementsByTagName(tag) { return [...descendants(this)].filter((element) => tag === '*' || element.localName === tag.toLowerCase()); }
  get innerHTML() { throw new Error('INNER_HTML_USED'); }
  set innerHTML(_value) { throw new Error('INNER_HTML_USED'); }
}

export class FakeFragment extends FakeParent {
  constructor(ownerDocument) { super(); this.nodeType = 11; this.ownerDocument = ownerDocument; this.parentNode = null; this.isFragment = true; }
  get isConnected() { return false; }
}

export class FakeShadowRoot extends FakeParent {
  constructor(host, mode, ownerDocument) {
    super();
    this.nodeType = 11; this.host = host; this.mode = mode; this.ownerDocument = ownerDocument;
    this.parentNode = null; this._sheets = [];
  }
  get adoptedStyleSheets() { return this._sheets; }
  set adoptedStyleSheets(sheets) { this._sheets = [...sheets]; }
  get isConnected() { return this.host.isConnected; }
  getRootNode() { return this; }
  // Events cross the boundary only when composed, like the real DOM.
  _eventParent(event) { return event.composed ? this.host : null; }
}

const CLASS_ATTR = 'class';
function makeClassList(element) {
  const read = () => (element.getAttribute(CLASS_ATTR) ?? '').split(/\s+/).filter(Boolean);
  const write = (names) => element.setAttribute(CLASS_ATTR, names.join(' '));
  return {
    add: (...names) => { const list = read(); for (const name of names) if (!list.includes(name)) list.push(name); write(list); },
    remove: (...names) => write(read().filter((name) => !names.includes(name))),
    toggle: (name, force) => { const has = read().includes(name); const on = force ?? !has; if (on && !has) write([...read(), name]); if (!on && has) write(read().filter((item) => item !== name)); return on; },
    contains: (name) => read().includes(name),
    replace: (from, to) => { const list = read(); if (!list.includes(from)) return false; write(list.map((name) => (name === from ? to : name))); return true; },
    get length() { return read().length; },
    get value() { return read().join(' '); },
    [Symbol.iterator]: () => read()[Symbol.iterator](),
  };
}

export class FakeElement extends FakeParent {
  constructor(ownerDocument, tagName, { namespace = 'html' } = {}) {
    super();
    this.nodeType = 1; this.ownerDocument = ownerDocument; this.namespace = namespace;
    this.localName = tagName.toLowerCase();
    this.tagName = namespace === 'html' ? tagName.toUpperCase() : tagName;
    this.parentNode = null;
    this._attrs = new Map();
    this._style = makeStyle();
    this._classList = null; this._dataset = null; this._shadow = null; this._checked = undefined; this._value = undefined; this._selectedIndex = undefined;
    this.lastShadowRoot = null; this.popoverCalls = []; this.popoverOpen = false;
    if (ownerDocument?.supportsPopover === false) {
      for (const name of ['showPopover', 'hidePopover', 'togglePopover']) this[name] = undefined;
      Object.defineProperty(this, 'popover', { value: undefined, writable: true, configurable: true, enumerable: true });
    }
  }

  // Attributes
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  getAttributeNames() { return [...this._attrs.keys()]; }
  getAttribute(name) { return this._attrs.has(name.toLowerCase()) ? this._attrs.get(name.toLowerCase()) : null; }
  setAttribute(name, value) { this._attrs.set(name.toLowerCase(), String(value)); }
  removeAttribute(name) { this._attrs.delete(name.toLowerCase()); }
  hasAttribute(name) { return this._attrs.has(name.toLowerCase()); }
  toggleAttribute(name, force) {
    const on = force ?? !this.hasAttribute(name);
    if (on) { if (!this.hasAttribute(name)) this.setAttribute(name, ''); } else this.removeAttribute(name);
    return on;
  }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute(CLASS_ATTR) ?? ''; }
  set className(value) { this.setAttribute(CLASS_ATTR, value); }
  get classList() { return (this._classList ??= makeClassList(this)); }
  get style() { return this._style; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { this.toggleAttribute('hidden', Boolean(value)); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
  get open() { return this.hasAttribute('open'); }
  set open(value) { this.toggleAttribute('open', Boolean(value)); }
  get type() { return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : this.localName === 'button' ? 'submit' : ''); }
  set type(value) { this.setAttribute('type', value); }
  get tabIndex() { const value = this.getAttribute('tabindex'); return value === null ? -1 : Number(value); }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get lang() { return this.getAttribute('lang') ?? ''; }
  set lang(value) { this.setAttribute('lang', value); }
  get dataset() {
    return (this._dataset ??= new Proxy({}, {
      get: (_target, key) => (typeof key === 'string' ? this.getAttribute(`data-${kebab(key)}`) ?? undefined : undefined),
      set: (_target, key, value) => { this.setAttribute(`data-${kebab(String(key))}`, value); return true; },
      deleteProperty: (_target, key) => { this.removeAttribute(`data-${kebab(String(key))}`); return true; },
      has: (_target, key) => typeof key === 'string' && this.hasAttribute(`data-${kebab(key)}`),
      ownKeys: () => this.getAttributeNames().filter((name) => name.startsWith('data-')).map((name) => camel(name.slice(5))),
      getOwnPropertyDescriptor: (_target, key) => (typeof key === 'string' && this.hasAttribute(`data-${kebab(key)}`)
        ? { value: this.getAttribute(`data-${kebab(key)}`), enumerable: true, configurable: true, writable: true } : undefined),
    }));
  }

  // Text and tree
  get textContent() { return this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value) {
    for (const child of [...this.childNodes]) this._detach(child);
    const text = String(value ?? '');
    if (text !== '') this.append(new FakeText(this.ownerDocument, text));
  }
  get innerText() { return this.textContent; }
  set innerText(_value) { throw new Error('INNER_TEXT_USED'); }
  get outerHTML() { throw new Error('OUTER_HTML_USED'); }
  set outerHTML(_value) { throw new Error('OUTER_HTML_USED'); }
  insertAdjacentHTML() { throw new Error('INSERT_ADJACENT_HTML_USED'); }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get nextElementSibling() { const siblings = this.parentNode?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { const siblings = this.parentNode?.children ?? []; return siblings[siblings.indexOf(this) - 1] ?? null; }
  remove() { this.parentNode?._detach(this); }
  getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  get isConnected() { const root = this.getRootNode(); return root.nodeType === 9 || (root.nodeType === 11 && root.host.isConnected); }
  matches(selector) { return matchesAny(this, selector); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  _eventParent() { return this.parentNode; }

  // Form controls
  get options() { return [...descendants(this)].filter((element) => element.localName === 'option'); }
  get selectedIndex() {
    const options = this.options;
    if (this._selectedIndex !== undefined) return this._selectedIndex < options.length ? this._selectedIndex : -1;
    const marked = options.findIndex((option) => option.hasAttribute('selected'));
    return marked >= 0 ? marked : options.length ? 0 : -1;
  }
  set selectedIndex(index) { this._selectedIndex = index; }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(value) { this._checked = Boolean(value); }
  get value() {
    switch (this.localName) {
      case 'select': return this.options[this.selectedIndex]?.value ?? '';
      case 'option': return this.getAttribute('value') ?? this.textContent;
      case 'output': return this.textContent;
      case 'meter': return Number(this.getAttribute('value') ?? 0);
      case 'textarea': return this._value ?? this.textContent;
      case 'input': {
        if (this._value !== undefined) return this._value;
        const attribute = this.getAttribute('value');
        if (attribute !== null) return attribute;
        if (this.type === 'range') { const min = Number(this.getAttribute('min') ?? 0), max = Number(this.getAttribute('max') ?? 100); return String(min + (max - min) / 2); }
        return this.type === 'checkbox' || this.type === 'radio' ? 'on' : '';
      }
      default: return this.getAttribute('value') ?? '';
    }
  }
  set value(next) {
    if (this.localName === 'select') { this._selectedIndex = this.options.findIndex((option) => option.value === String(next)); return; }
    if (this.localName === 'meter') { this.setAttribute('value', next); return; }
    if (this.localName === 'output') { this.textContent = next; return; }
    this._value = String(next);
  }

  // Focus and activation
  focus() {
    if (this.disabled) return;
    const document = this.ownerDocument;
    const previous = document?.activeElement;
    if (previous === this) return;
    if (previous) previous.dispatchEvent(new FakeEvent('blur'));
    if (document) document.activeElement = this;
    this.dispatchEvent(new FakeEvent('focus'));
  }
  blur() {
    const document = this.ownerDocument;
    if (document?.activeElement !== this) return;
    document.activeElement = null;
    this.dispatchEvent(new FakeEvent('blur'));
  }
  /** Activation behavior: checkbox toggles (and reverts when prevented), summary toggles its details. */
  click() {
    if (this.disabled) return;
    const checkbox = this.localName === 'input' && this.type === 'checkbox';
    const before = this.checked;
    if (checkbox) this.checked = !before;
    const proceed = this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }));
    if (checkbox) {
      if (!proceed) { this.checked = before; return; }
      this.dispatchEvent(new FakeEvent('input', { bubbles: true }));
      this.dispatchEvent(new FakeEvent('change', { bubbles: true }));
    } else if (proceed && this.localName === 'summary' && this.parentElement?.localName === 'details') {
      this.parentElement.open = !this.parentElement.open;
    }
  }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView() {}

  // Shadow DOM: a closed root is invisible to the page (`shadowRoot` is null);
  // the test keeps its own handle in `lastShadowRoot`.
  attachShadow({ mode } = {}) {
    if (mode !== 'open' && mode !== 'closed') throw new TypeError('mode must be open or closed');
    if (!SHADOW_HOSTS.has(this.localName) && !CUSTOM_ELEMENT.test(this.localName)) throw domError('NotSupportedError', `<${this.localName}> cannot host a shadow root`);
    if (this._shadow) throw domError('NotSupportedError', 'the element already hosts a shadow root');
    this._shadow = new FakeShadowRoot(this, mode, this.ownerDocument);
    this.lastShadowRoot = this._shadow;
    return this._shadow;
  }
  get shadowRoot() { return this._shadow?.mode === 'open' ? this._shadow : null; }

  // Popover: records calls; needs the popover attribute like the real API.
  get popover() { return this.getAttribute('popover'); }
  set popover(value) { if (value === null || value === undefined) this.removeAttribute('popover'); else this.setAttribute('popover', value); }
  showPopover() {
    if (!this.hasAttribute('popover')) throw domError('InvalidStateError', 'element is not a popover');
    this.popoverCalls.push('show'); this.popoverOpen = true;
  }
  hidePopover() {
    if (!this.hasAttribute('popover')) throw domError('InvalidStateError', 'element is not a popover');
    this.popoverCalls.push('hide'); this.popoverOpen = false;
  }
  togglePopover() { if (this.popoverOpen) this.hidePopover(); else this.showPopover(); return this.popoverOpen; }
}

// String attributes that the DOM reflects as properties (el.href = x sets the
// attribute), so controllers written either way behave the same in the fake.
const REFLECTED = { href: 'href', src: 'src', target: 'target', rel: 'rel', name: 'name', title: 'title', placeholder: 'placeholder',
  min: 'min', max: 'max', step: 'step', autocomplete: 'autocomplete', htmlFor: 'for', ariaLabel: 'aria-label',
  ariaDescribedBy: 'aria-describedby', ariaValueText: 'aria-valuetext' };
for (const [property, attribute] of Object.entries(REFLECTED)) {
  Object.defineProperty(FakeElement.prototype, property, {
    configurable: true, enumerable: true,
    get() { return this.getAttribute(attribute) ?? ''; },
    set(value) { if (value === null || value === undefined) this.removeAttribute(attribute); else this.setAttribute(attribute, value); },
  });
}
Object.defineProperty(FakeElement.prototype, 'maxLength', {
  configurable: true, enumerable: true,
  get() { const value = this.getAttribute('maxlength'); return value === null ? -1 : Number(value); },
  set(value) { this.setAttribute('maxlength', value); },
});

// ---------------------------------------------------------------------------
export class FakeDocument extends FakeParent {
  constructor({ popover = true } = {}) {
    super();
    this.nodeType = 9; this.supportsPopover = popover; this.ownerDocument = null; this.parentNode = null;
    this.visibilityState = 'visible'; this.fullscreenElement = null; this.activeElement = null;
    this.readyState = 'complete'; this.strayText = []; this.doctype = null;
  }
  get isConnected() { return true; }
  get hidden() { return this.visibilityState === 'hidden'; }
  get documentElement() { return this.children.find((element) => element.localName === 'html') ?? this.children[0] ?? null; }
  get head() { return this.documentElement?.children.find((element) => element.localName === 'head') ?? null; }
  get body() { return this.documentElement?.children.find((element) => element.localName === 'body') ?? null; }
  get title() { return this.getElementsByTagName('title')[0]?.textContent ?? ''; }
  set title(value) {
    let element = this.getElementsByTagName('title')[0];
    if (!element) { element = this.createElement('title'); this.head?.append(element); }
    element.textContent = value;
  }
  createElement(tagName) { return new FakeElement(this, String(tagName)); }
  createElementNS(namespace, tagName) { return new FakeElement(this, String(tagName), { namespace: String(namespace).endsWith('svg') ? 'svg' : 'html' }); }
  createTextNode(data) { return new FakeText(this, data); }
  createDocumentFragment() { return new FakeFragment(this); }
  getRootNode() { return this; }
  setVisibility(state) {
    this.visibilityState = state;
    this.dispatchEvent(new FakeEvent('visibilitychange'));
  }
  setFullscreen(element) {
    this.fullscreenElement = element ?? null;
    this.dispatchEvent(new FakeEvent('fullscreenchange'));
  }
  write() { throw new Error('DOCUMENT_WRITE_USED'); }
  writeln() { throw new Error('DOCUMENT_WRITE_USED'); }
}

/** An empty page: html > head + body. */
export function createFakeDocument(options) {
  return parseHtml('<!doctype html><html lang="en"><head></head><body></body></html>', options);
}

// ---------------------------------------------------------------------------
// parseHtml: only the controlled markup of section 8. Malformed input (a
// mismatched or unclosed tag, a duplicate attribute, a self-closing HTML
// element) throws, because a page skeleton that a browser would quietly repair
// is a bug worth failing on. Text between tags is kept as a text node and
// listed in document.strayText, which is how the R12 test finds literal text.
export function parseHtml(source, options = {}) {
  const document = new FakeDocument(options);
  const stack = [];
  const svgDepth = () => stack.filter((element) => element.localName === 'svg').length;
  const attach = (node) => { (stack.at(-1) ?? document).append(node); };
  let index = 0;
  const fail = (message) => { throw new Error(`parseHtml: ${message} at offset ${index}`); };
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end < 0) fail('unterminated comment');
      index = end + 3;
    } else if (source.startsWith('<!', index)) {
      const end = source.indexOf('>', index);
      if (end < 0) fail('unterminated declaration');
      document.doctype = source.slice(index + 2, end).trim().toLowerCase();
      index = end + 1;
    } else if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index);
      if (end < 0) fail('unterminated closing tag');
      const name = source.slice(index + 2, end).trim().toLowerCase();
      const open = stack.pop();
      if (!open || open.localName !== name) fail(`mismatched </${name}>`);
      index = end + 1;
    } else if (source[index] === '<' && /[A-Za-z]/.test(source[index + 1] ?? '')) {
      index++;
      const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(source.slice(index));
      const name = nameMatch[0];
      index += name.length;
      const inSvg = svgDepth() > 0 || name.toLowerCase() === 'svg';
      const element = new FakeElement(document, inSvg ? name : name.toLowerCase(), { namespace: inSvg ? 'svg' : 'html' });
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(source[index] ?? '')) index++;
        if (index >= source.length) fail('unterminated tag');
        if (source.startsWith('/>', index)) { selfClosing = true; index += 2; break; }
        if (source[index] === '>') { index++; break; }
        const attrMatch = /^[^\s=/>]+/.exec(source.slice(index));
        if (!attrMatch) fail('bad attribute');
        const attrName = attrMatch[0].toLowerCase();
        index += attrMatch[0].length;
        while (/\s/.test(source[index] ?? '')) index++;
        let value = '';
        if (source[index] === '=') {
          index++;
          while (/\s/.test(source[index] ?? '')) index++;
          const quote = source[index];
          if (quote === '"' || quote === "'") {
            const end = source.indexOf(quote, index + 1);
            if (end < 0) fail('unterminated attribute value');
            value = decode(source.slice(index + 1, end));
            index = end + 1;
          } else {
            const bare = /^[^\s>]*/.exec(source.slice(index))[0];
            value = decode(bare);
            index += bare.length;
          }
        }
        if (element.hasAttribute(attrName)) fail(`duplicate attribute ${attrName}`);
        element.setAttribute(attrName, value);
      }
      attach(element);
      const local = element.localName;
      if (VOID.has(local) && element.namespace === 'html') continue;
      if (selfClosing) {
        if (!inSvg) fail(`<${name}/> is self-closing but not a void element`);
        continue;
      }
      if (RAW_TEXT.has(local) && element.namespace === 'html') {
        const close = new RegExp(`</${local}\\s*>`, 'i').exec(source.slice(index));
        if (!close) fail(`unterminated <${local}>`);
        const text = source.slice(index, index + close.index);
        if (text !== '') element.append(new FakeText(document, text));
        index += close.index + close[0].length;
        continue;
      }
      stack.push(element);
    } else {
      let end = source.indexOf('<', index);
      if (end < 0) end = source.length;
      const text = decode(source.slice(index, end));
      index = end;
      if (text.trim() === '') continue;
      if (!stack.length) fail('text outside the root element');
      const parent = stack.at(-1);
      attach(new FakeText(document, text));
      document.strayText.push({ parent, text: text.trim() });
    }
  }
  if (stack.length) fail(`unclosed <${stack.at(-1).localName}>`);
  return document;
}

/**
 * Runs `source` as a classic script (no module semantics) inside
 * vm.createContext(sandbox) and returns its completion value; the sandbox
 * object holds whatever globals the script set. This is how overlay.js is
 * exercised: it must parse and run without import/export.
 */
export function runClassicScript(source, sandbox = {}, { filename = 'classic-script.js' } = {}) {
  vm.createContext(sandbox);
  return new vm.Script(String(source), { filename }).runInContext(sandbox);
}
