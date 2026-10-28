// Shared setup for the main-view chrome tests (toolbar, sidebar, status bar,
// bulk bar, search): the details DOM shim plus the `main` catalog, an `#app`
// shell with every region, a recording rpc, and the few DOM pieces the shim
// lacks (CustomEvent, dispatchEvent, document listeners).

import { installDom, makeCtx, FakeElement } from './details-dom.js';

export { FakeElement, flush, torrent } from './details-dom.js';
export { installDom };

/** Install the shim and the extras once per test file. */
export function installChromeDom({ width = 1440 } = {}) {
  const env = installDom({ width });
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
      this.bubbles = Boolean(init.bubbles);
    }
  };
  FakeElement.prototype.dispatchEvent = function dispatchEvent(event) {
    this.dispatch(event.type, { detail: event.detail });
    return true;
  };
  const docListeners = new Map();
  env.doc.addEventListener = (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  };
  env.doc.removeEventListener = (type, fn) => {
    const list = docListeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  };
  env.doc.dispatch = (type, init = {}) => {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of [...(docListeners.get(type) || [])]) fn(event);
    return event;
  };
  env.docListeners = docListeners;
  return env;
}

/** `#app` with the shell regions `index.html` provides; returns the region map. */
export function shell(env) {
  const app = new FakeElement('div');
  app.setAttribute('id', 'app');
  app.setAttribute('class', 'shell');
  const regions = {};
  for (const [tag, cls, name] of [
    ['header', 'shell-toolbar', 'toolbar'],
    ['nav', 'shell-sidebar', 'sidebar'],
    ['section', 'shell-table', 'table'],
    ['section', 'shell-details', 'details'],
    ['footer', 'shell-statusbar', 'statusbar'],
    ['div', 'shell-bulkbar', 'bulkbar'],
    ['div', 'shell-dialogs', 'dialogs'],
  ]) {
    const node = new FakeElement(tag);
    node.setAttribute('class', cls);
    node.setAttribute('data-region', name);
    app.append(node);
    regions[name] = node;
  }
  env.body.replaceChildren(app);
  return { app, regions };
}

/**
 * A context with the `core` + `main` catalogs, 4.0.6-shaped caps by default,
 * a recording rpc (`calls`), a recording poller (`ticks`) and the shim's
 * recording `toast`/`menu`/`openDialog`.
 */
export async function chromeCtx({ caps, respond, session } = {}) {
  const made = await makeCtx({ respond });
  const { readFileSync } = await import('node:fs');
  const { loadTranslator } = await import('../../src/app/js/core/i18n.js');
  const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
  const load = async (lang, ns) => {
    try {
      return JSON.parse(readFileSync(new URL(`../../src/app/i18n/${lang}/${ns}.json`, import.meta.url), 'utf8'));
    } catch {
      return null;
    }
  };
  made.ctx.i18n = await loadTranslator({ lang: 'en', namespaces: ['core', 'main'], load });
  const baseSession = {
    version: '4.0.6 (38c164933e)', rpcVersion: 17, rpcVersionSemver: '5.3.0', downloadDir: '/home/user/torrents',
    altSpeedEnabled: false, altSpeedDown: 50, altSpeedUp: 50, speedLimitDown: 1024, speedLimitDownEnabled: false,
    speedLimitUp: 512, speedLimitUpEnabled: false, peerPort: 51413, utpEnabled: true, tcpEnabled: true, encryption: 'preferred',
    ...session,
  };
  made.ctx.caps = caps || buildCaps(baseSession, { dialect: 'legacy' });
  made.ctx.store.set({ session: baseSession, connection: { state: 'online', error: null, since: 1 } });
  const ticks = [];
  made.ctx.poller = { tick: async () => { ticks.push(Date.now()); }, refreshAll: async () => {}, start: async () => {}, stop() {}, isRunning: () => true, isPaused: () => false };
  return { ...made, ticks };
}

export const click = (node, init = {}) => node.dispatch('click', { ctrlKey: false, metaKey: false, shiftKey: false, ...init });
export const byLabel = (root, label) => root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === label) || null;
export const byAction = (root, id) => root.querySelector(`[data-action="${id}"]`);
