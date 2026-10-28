// A small DOM stand-in for the details view tests: enough of Element,
// events and document for `el()`, the tab views and the drawer to run in Node.

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class ClassList {
  constructor(node) {
    this.node = node;
  }

  values() {
    return (this.node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  contains(name) {
    return this.values().includes(name);
  }

  add(...names) {
    const set = new Set(this.values());
    for (const n of names) set.add(n);
    this.node.setAttribute('class', [...set].join(' '));
  }

  remove(...names) {
    this.node.setAttribute('class', this.values().filter((v) => !names.includes(v)).join(' '));
  }

  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : force;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

export class FakeElement {
  constructor(tag, ns = null) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.styles = new Map();
    this.style = { setProperty: (k, v) => this.styles.set(k, v), getPropertyValue: (k) => this.styles.get(k) || '' };
    this.classList = new ClassList(this);
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.value = '';
  }

  get textContent() {
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren();
    if (value !== '' && value != null) this.append(String(value));
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n === globalThis.document.body) return true;
    return false;
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }

  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'object' && n !== null ? n : new FakeText(n);
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i !== -1) this.children.splice(i, 1);
    node.parentNode = null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  matches(selector) {
    return selector.split(',').some((s) => matchOne(this, s.trim()));
  }

  closest(selector) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.nodeType !== 1) continue;
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  /** Dispatch a bubbling event with `init` merged in; returns the event. */
  dispatch(type, init = {}) {
    const event = {
      type, target: this, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...init,
    };
    for (let n = this; n && !event.propagationStopped; n = n.parentNode) {
      for (const fn of [...(n.listeners ? n.listeners.get(type) || [] : [])]) fn(event);
    }
    return event;
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  select() {}

  requestSubmit() {
    this.dispatch('submit');
  }

  setPointerCapture() {}

  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }

  getClientRects() {
    return [];
  }
}

function matchOne(node, selector) {
  let m = /^\.([\w-]+)$/.exec(selector);
  if (m) return node.classList.contains(m[1]);
  m = /^#([\w-]+)$/.exec(selector);
  if (m) return node.getAttribute('id') === m[1];
  m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (m) return m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
  m = /^([a-z]+)$/i.exec(selector);
  if (m) return node.tagName === m[1].toUpperCase();
  return false;
}

/** Install `document`, `Element`, `HTMLElement` and `matchMedia` globals. */
export function installDom({ width = 1440 } = {}) {
  const body = new FakeElement('body');
  const doc = {
    body,
    activeElement: body,
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    addEventListener() {},
    removeEventListener() {},
    execCommand: () => true,
  };
  globalThis.document = doc;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  const media = { width };
  globalThis.matchMedia = (query) => {
    const m = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? media.width <= Number(m[1]) : false,
      addEventListener() {},
      removeEventListener() {},
    };
  };
  return { doc, body, media };
}

/**
 * A test context: a real store, formatter, English catalogs and DOM helpers,
 * a recording `rpc`, and recording `toast`, `menu` and `openDialog`.
 * `details` maps a torrent id to the `torrent-get` row the fake daemon returns.
 */
export async function makeCtx({ details = {}, respond } = {}) {
  const { readFileSync } = await import('node:fs');
  const { el, svg, clear } = await import('../../src/app/js/core/dom.js');
  const { icon } = await import('../../src/app/js/core/icons.js');
  const { createStore } = await import('../../src/app/js/core/store.js');
  const { bindFormat } = await import('../../src/app/js/core/format.js');
  const { loadTranslator } = await import('../../src/app/js/core/i18n.js');
  const load = async (lang, ns) => {
    try {
      return JSON.parse(readFileSync(new URL(`../../src/app/i18n/${lang}/${ns}.json`, import.meta.url), 'utf8'));
    } catch {
      return null;
    }
  };
  const t = await loadTranslator({ lang: 'en', namespaces: ['core', 'details'], load });
  const calls = [];
  const rpc = {
    call(method, args) {
      calls.push({ method, args });
      if (respond) return respond(method, args);
      if (method === 'torrent-get') {
        const row = details[args.ids[0]];
        return Promise.resolve({ torrents: row ? [{ id: args.ids[0], ...row }] : [] });
      }
      return Promise.resolve({});
    },
  };
  const toasts = [];
  const menus = [];
  const dialogs = [];
  const ui = {
    el, svg, clear, icon,
    tooltip: () => () => {},
    toast: (message, opts) => toasts.push({ message, opts }),
    menu: (anchor, items, opts) => {
      menus.push({ anchor, items, opts });
      return { close() {} };
    },
    openDialog: (opts) => {
      const record = { opts, closed: null, close(reason) { record.closed = reason || 'close'; } };
      dialogs.push(record);
      return { root: el('div'), body: el('div'), close: record.close };
    },
    confirm: () => Promise.resolve(false),
  };
  const ctx = {
    rpc, caps: null, store: createStore(), i18n: t, fmt: bindFormat({ locale: 'en' }), ui,
  };
  return { ctx, calls, toasts, menus, dialogs };
}

/** Let queued promise callbacks run. */
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A store-shaped torrent with overrides. */
export function torrent(overrides = {}) {
  return {
    id: 1, hash: 'a'.repeat(40), name: 'ubuntu-24.04-desktop-amd64.iso', status: 4, state: 'downloading',
    error: 0, errorString: '', warning: '', totalSize: 6_000_000_000, sizeWhenDone: 6_000_000_000,
    leftUntilDone: 3_000_000_000, percentDone: 0.5, recheckProgress: 0, rateDownload: 2_500_000, rateUpload: 0,
    eta: 1200, uploadRatio: 0.1, uploadedEver: 300_000_000, downloadedEver: 3_000_000_000, peersConnected: 12,
    peersGettingFromUs: 2, peersSendingToUs: 9, seederCount: 40, leecherCount: 7, downloadDir: '/home/u/torrents',
    addedDate: 1_700_000_000, doneDate: 0, activityDate: 1_700_000_500, queuePosition: 0, isFinished: false,
    labels: [], trackers: [], trackerHosts: [],
    ...overrides,
  };
}
