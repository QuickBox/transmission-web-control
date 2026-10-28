/**
 * Entry point: resolves the language, loads the catalogs, builds the shared
 * context and mounts every UI module into its region of `#app`.
 *
 * Each module exports `mount(root, ctx)`. `root` is the module's own
 * `[data-region="<name>"]` element inside `#app` (created here when the page
 * does not already provide it); a module renders into its root only.
 */

import { el, svg, clear } from './core/dom.js?v=__QBV__';
import { createStore } from './core/store.js?v=__QBV__';
import { detectLanguage, fetchManifest, loadTranslator } from './core/i18n.js?v=__QBV__';
import { bindFormat } from './core/format.js?v=__QBV__';
import { startTheme } from './core/theme.js?v=__QBV__';
import { icon } from './core/icons.js?v=__QBV__';
import { tooltip } from './core/tooltip.js?v=__QBV__';
import { createToast } from './core/toast.js?v=__QBV__';
import { createDialogs } from './core/dialog.js?v=__QBV__';
import { menu } from './core/menu.js?v=__QBV__';
import * as toolbar from './ui/toolbar.js?v=__QBV__';
import * as sidebar from './ui/sidebar.js?v=__QBV__';
import * as table from './ui/table.js?v=__QBV__';
import * as statusbar from './ui/statusbar.js?v=__QBV__';
import * as bulkbar from './ui/bulkbar.js?v=__QBV__';
import * as details from './ui/details/index.js?v=__QBV__';
import * as dialogs from './ui/dialogs/index.js?v=__QBV__';

/** Fixed mount order: chrome first, dialogs last so they layer above. */
export const MODULES = Object.freeze([
  ['toolbar', toolbar],
  ['sidebar', sidebar],
  ['table', table],
  ['statusbar', statusbar],
  ['bulkbar', bulkbar],
  ['details', details],
  ['dialogs', dialogs],
]);

/**
 * @typedef {{
 *   call: (method: string, args?: object) => Promise<any>,
 * }} Rpc
 * Typed helpers (`rpc/torrents.js`, `rpc/session.js`) wrap `call`.
 *
 * @typedef {{
 *   dialect: 'jsonrpc'|'legacy', rpc: number, semver: string|null, jsonRpc: boolean,
 *   nativeLabels: boolean, tableFormat: boolean, sessionFields: boolean,
 *   trackerList: boolean, sequential: boolean, portTestByProtocol: boolean,
 *   has: (sessionKey: string) => boolean,
 * }} Caps
 * Owned by `rpc/caps.js`; every version-gated surface reads this, never the
 * RPC version itself.
 *
 * @typedef {'info'|'success'|'warning'|'error'} Tone
 * @typedef {{ label: string, icon?: string, onSelect?: () => void, disabled?: boolean,
 *   destructive?: boolean, checked?: boolean, items?: MenuItem[] } | 'separator'} MenuItem
 *
 * @typedef {{
 *   el: typeof el,
 *   svg: typeof svg,
 *   clear: typeof clear,
 *   icon: (name: string, opts?: { size?: number, label?: string }) => SVGElement,
 *   tooltip: (target: Element, text: string | (() => string)) => () => void,
 *   toast: (message: string, opts?: { tone?: Tone, timeout?: number }) => void,
 *   openDialog: (opts: { title: string, description?: string, body?: Node | Node[],
 *     actions?: Node[], size?: 'sm'|'md'|'lg', tone?: 'info'|'warning'|'danger'|'success',
 *     icon?: string, dismissible?: boolean, initialFocus?: HTMLElement,
 *     onClose?: (reason: string) => void }) => { root: HTMLElement, body: HTMLElement, close: () => void },
 *   confirm: (opts: { title: string, message: string, confirmLabel?: string, cancelLabel?: string,
 *     destructive?: boolean, tone?: 'info'|'warning'|'danger'|'success' }) => Promise<boolean>,
 *   menu: (anchor: HTMLElement, items: MenuItem[], opts?: { label?: string }) => { close: () => void },
 * }} Ui
 *
 * @typedef {{
 *   rpc: Rpc,
 *   store: import('./core/store.js').Store,
 *   caps: Caps,
 *   i18n: import('./core/i18n.js').Translate,
 *   fmt: import('./core/format.js').Formatter,
 *   ui: Ui,
 * }} AppContext
 */

/** A service whose module has not been wired into this build yet. */
function notWired(name) {
  return () => {
    throw new Error(`${name} is not wired yet`);
  };
}

/**
 * @param {import('./core/i18n.js').Translate} t
 * @returns {AppContext['ui']}
 */
function buildUi(t) {
  const { openDialog, confirm } = createDialogs(t);
  return { el, svg, clear, icon, tooltip, toast: createToast(t), openDialog, confirm, menu };
}

/** Landmark names, and the off-canvas sidebar's scrim and Escape close. */
function wireShell(app, t) {
  for (const name of ['toolbar', 'sidebar', 'table', 'details', 'statusbar']) {
    const region = app.querySelector(`[data-region="${name}"]`);
    if (region) region.setAttribute('aria-label', t(`core.regions.${name}`));
  }
  const closeSidebar = () => app.removeAttribute('data-sidebar-open');
  const scrim = app.querySelector('[data-shell-scrim]');
  if (scrim) scrim.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.hasAttribute('data-sidebar-open') && !app.inert) closeSidebar();
  });
}

/** @returns {{ rpc: Rpc, caps: Caps|null }} */
function buildRpc() {
  return { rpc: { call: notWired('rpc.call') }, caps: null };
}

function regionFor(app, name) {
  const existing = app.querySelector(`[data-region="${name}"]`);
  if (existing) return existing;
  const region = el('div', { 'data-region': name });
  app.append(region);
  return region;
}

/**
 * @param {Element} app
 * @returns {Promise<AppContext>}
 */
export async function boot(app) {
  startTheme();
  const lang = detectLanguage();
  const t = await loadTranslator({ lang, available: await fetchManifest() });
  document.documentElement.setAttribute('lang', t.lang);

  const units = {};
  for (const name of ['size1000', 'size1024']) {
    if (t.has(`core.units.${name}`)) units[name] = t(`core.units.${name}`).split(' ');
  }
  for (const name of ['perSecond', 'day', 'hour', 'minute', 'second']) {
    if (t.has(`core.units.${name}`)) units[name] = t(`core.units.${name}`);
  }

  const { rpc, caps } = buildRpc();
  /** @type {AppContext} */
  const ctx = {
    rpc,
    store: createStore(),
    caps,
    i18n: t,
    fmt: bindFormat({ locale: t.lang, units }),
    ui: buildUi(t),
  };
  wireShell(app, t);

  for (const [name, mod] of MODULES) {
    try {
      mod.mount(regionFor(app, name), ctx);
    } catch (err) {
      console.error(`mount ${name} failed`, err);
    }
  }
  return ctx;
}

if (typeof document !== 'undefined') {
  const app = document.getElementById('app');
  if (app) boot(app).catch((err) => console.error('boot failed', err));
}
