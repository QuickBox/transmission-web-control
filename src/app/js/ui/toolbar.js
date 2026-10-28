/**
 * Top app bar: QuickBox mark, Add torrent, the Start/Pause/Verify/Reannounce,
 * Remove and Move/Speed/Queue groups, search, the live rate widget, the
 * alt-speed toggle, the theme switcher, Settings and About. Below 960px the
 * secondary groups fold into a More menu; below 640px it shows the hamburger,
 * a search icon, Add and More. Mounted into `[data-region="toolbar"]`.
 *
 * The torrent actions live here as `ACTIONS` and `runAction`, shared with the
 * bulk bar, so one table drives both surfaces.
 */

import { errorMessage } from '../core/errors.js?v=__QBV__';
import { preference, setVariant, VARIANTS } from '../core/theme.js?v=__QBV__';
import { setSession } from '../rpc/session.js?v=__QBV__';
import {
  openAbout, openAdd, openAutoMatch, openLabels, openLimits, openLocation, openRemove, openRename, openReplaceTrackers, openSettings,
} from './dialogs/index.js?v=__QBV__';
import { createSearch } from './search.js?v=__QBV__';
import { refreshAfterWrite } from '../rpc/poller.js?v=__QBV__';
import { quickboxMark } from '../core/brand.js?v=__QBV__';

/** Dialog openers by action, each taking the selected ids. */
const DIALOGS = Object.freeze({
  remove: openRemove,
  location: openLocation,
  limits: openLimits,
  labels: openLabels,
  replaceTrackers: openReplaceTrackers,
  autoMatch: openAutoMatch,
  rename: (ids) => openRename(ids[0]),
});

/**
 * Selection actions. `method` is the legacy RPC spelling sent with `{ ids }`;
 * `dialog` names the registry opener called with the ids instead. `group`
 * places the control: toolbar groups, `queue` (Queue menu) or `tools` (More
 * menu only); `bulk` marks the bulk-bar set; `allowEmpty` lets the action run
 * with nothing selected (the dialog then covers every torrent); `single`
 * needs exactly one torrent.
 * @type {readonly { id: string, icon: string, method?: string, dialog?: keyof typeof DIALOGS,
 *   group: 'transfer'|'remove'|'manage'|'queue'|'tools', bulk?: boolean, destructive?: boolean,
 *   allowEmpty?: boolean, single?: boolean }[]}
 */
export const ACTIONS = Object.freeze([
  { id: 'start', icon: 'toolbar-start', method: 'torrent-start', group: 'transfer', bulk: true },
  { id: 'pause', icon: 'toolbar-pause', method: 'torrent-stop', group: 'transfer', bulk: true },
  { id: 'verify', icon: 'fm-refresh', method: 'torrent-verify', group: 'transfer' },
  { id: 'reannounce', icon: 'statusbar-connections', method: 'torrent-reannounce', group: 'transfer' },
  { id: 'forceStart', icon: 'toolbar-start', method: 'torrent-start-now', group: 'queue' },
  { id: 'remove', icon: 'toolbar-remove', dialog: 'remove', group: 'remove', bulk: true, destructive: true },
  { id: 'move', icon: 'header-datadir', dialog: 'location', group: 'manage' },
  { id: 'limits', icon: 'tab-speed', dialog: 'limits', group: 'manage' },
  { id: 'labels', icon: 'header-label', dialog: 'labels', group: 'manage' },
  { id: 'queueTop', icon: 'toolbar-move-up', method: 'queue-move-top', group: 'queue' },
  { id: 'queueUp', icon: 'toolbar-move-up', method: 'queue-move-up', group: 'queue' },
  { id: 'queueDown', icon: 'toolbar-move-down', method: 'queue-move-down', group: 'queue' },
  { id: 'queueBottom', icon: 'toolbar-move-down', method: 'queue-move-bottom', group: 'queue' },
  { id: 'replaceTrackers', icon: 'tab-trackers', dialog: 'replaceTrackers', group: 'tools', allowEmpty: true },
  { id: 'findData', icon: 'file-folder', dialog: 'autoMatch', group: 'tools' },
  { id: 'rename', icon: 'header-rename', dialog: 'rename', group: 'tools', single: true },
]);

const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

const byGroup = (...groups) => ACTIONS.filter((a) => groups.includes(a.group));

/**
 * Where each action lives in the toolbar, derived from the same filters
 * `mount` renders with, so a test can check reachability against the CSS
 * visibility rules instead of the DOM alone.
 */
export const SURFACES = Object.freeze({
  /** Icon buttons in the transfer, remove and manage groups. */
  buttons: Object.freeze(byGroup('transfer', 'remove', 'manage').map((a) => a.id)),
  /** The Queue button's menu (the manage group's last control). */
  queueMenu: Object.freeze(byGroup('queue').map((a) => a.id)),
  /** The More menu: the tools, and the button actions again for narrow layouts. */
  moreMenu: Object.freeze(byGroup('transfer', 'manage', 'queue', 'tools').map((a) => a.id)),
});

/** Does an action run for this many selected torrents? */
export function actionEnabled(action, count) {
  if (action.single) return count === 1;
  return count > 0 || Boolean(action.allowEmpty);
}

/**
 * Run one action on `ids`. RPC actions resolve after the next poll tick so the
 * list reflects the change; success and failure both surface as a toast.
 * @param {import('../main.js').AppContext} ctx
 * @param {string} actionId
 * @param {number[]} ids
 * @returns {Promise<boolean>} whether the action ran
 */
export async function runAction(ctx, actionId, ids) {
  const action = ACTION_BY_ID.get(actionId);
  if (!action || !Array.isArray(ids) || !actionEnabled(action, ids.length)) return false;
  if (action.dialog) {
    DIALOGS[action.dialog](ids);
    return true;
  }
  try {
    await ctx.rpc.call(action.method, { ids });
    // The daemon applies most of these after the reply, so the list can lag a
    // poll behind; the notice confirms the request was accepted right away.
    ctx.ui.toast(ctx.i18n(`main.feedback.done.${action.id}`, { count: ids.length, total: ctx.fmt.count(ids.length) }), { tone: 'success', timeout: 3000 });
    await refreshAfterWrite(ctx, ids);
    return true;
  } catch (err) {
    ctx.ui.toast(ctx.i18n('main.feedback.actionFailed', {
      action: ctx.i18n(`main.actions.${action.id}`),
      message: errorMessage(ctx.i18n, err),
    }), { tone: 'error' });
    return false;
  }
}

/** Menu items for `actions`, each enabled only while something is selected (unless `allowEmpty`). */
export function actionMenuItems(ctx, actions, ids) {
  return actions.map((action) => ({
    label: ctx.i18n(`main.actions.${action.id}`),
    icon: action.icon,
    destructive: Boolean(action.destructive),
    disabled: !actionEnabled(action, ids.length),
    onSelect: () => runAction(ctx, action.id, ids),
  }));
}

const THEME_CHOICES = Object.freeze(['auto', ...VARIANTS]);

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {() => void} Teardown.
 */
export function mount(root, ctx) {
  const { el, clear, icon, tooltip, menu } = ctx.ui;
  const t = ctx.i18n;
  const { store } = ctx;
  const app = root.closest('#app');
  const selected = () => [...store.get().selection];

  function iconButton(label, name, onClick, extra = {}) {
    const button = el('button', { type: 'button', class: ['btn-icon', extra.class], 'aria-label': label, ...extra.attrs }, icon(name, { size: 18 }));
    tooltip(button, () => (typeof label === 'function' ? label() : label));
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  // ---- left: hamburger, mark, Add, action groups --------------------------

  const hamburger = iconButton(t('main.actions.menu'), 'menu', () => {
    if (!app) return;
    if (app.hasAttribute('data-sidebar-open')) app.removeAttribute('data-sidebar-open');
    else app.setAttribute('data-sidebar-open', '');
  }, { class: 'tb-hamburger', attrs: { 'aria-controls': 'sidebar', 'aria-expanded': 'false' } });

  const brand = el('div', { class: 'tb-brand' }, [
    el('span', { class: 'tb-mark', 'aria-hidden': 'true' }, quickboxMark({ size: 30 })),
    el('span', { class: 'tb-wordmark', text: t('core.app.name') }),
  ]);

  const addButton = el('button', { type: 'button', class: 'btn btn-primary tb-add', 'aria-label': t('main.actions.add') }, [
    icon('toolbar-add', { size: 18 }),
    el('span', { class: 'tb-add-label', text: t('main.actions.add') }),
  ]);
  tooltip(addButton, () => t('main.actions.add'));
  addButton.addEventListener('click', () => openAdd());

  const actionButtons = new Map();
  function actionButton(action) {
    const button = iconButton(t(`main.actions.${action.id}`), action.icon, () => runAction(ctx, action.id, selected()), {
      class: action.destructive && 'tb-destructive',
      attrs: { 'data-action': action.id },
    });
    actionButtons.set(action.id, button);
    return button;
  }

  const queueButton = iconButton(t('main.actions.queue'), 'toolbar-move-up', () => {
    menu(queueButton, actionMenuItems(ctx, byGroup('queue'), selected()), { label: t('main.actions.queue') });
  }, { attrs: { 'aria-haspopup': 'menu', 'data-action': 'queue' } });
  actionButtons.set('queue', queueButton);

  const transferGroup = el('div', { class: 'btn-group tb-group', role: 'group', 'aria-label': t('main.toolbar.transferGroup') },
    byGroup('transfer').map(actionButton));
  const removeGroup = el('div', { class: 'btn-group tb-group', role: 'group' }, byGroup('remove').map(actionButton));
  const manageGroup = el('div', { class: 'btn-group tb-group tb-secondary', role: 'group', 'aria-label': t('main.toolbar.manageGroup') }, [
    ...byGroup('manage').map(actionButton),
    queueButton,
  ]);

  // ---- right: search, rates, alt-speed, theme, settings, about, more ------

  const search = createSearch(ctx, {
    onEscape: () => {
      root.removeAttribute('data-search-open');
      const grid = app && app.querySelector('[role="grid"]');
      if (grid && typeof grid.focus === 'function') grid.focus();
    },
  });
  const searchToggle = iconButton(t('main.search.open'), 'toolbar-search', () => {
    const open = root.hasAttribute('data-search-open');
    if (open) root.removeAttribute('data-search-open');
    else {
      root.setAttribute('data-search-open', '');
      search.focus();
    }
    searchToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
  }, { class: 'tb-search-toggle', attrs: { 'aria-expanded': 'false' } });

  const downRate = el('span', { class: 'tb-rate-value', text: ctx.fmt.speed(0) });
  const upRate = el('span', { class: 'tb-rate-value', text: ctx.fmt.speed(0) });
  const rates = el('div', { class: 'tb-rates tb-secondary', role: 'status', 'aria-live': 'off' }, [
    el('span', { class: 'tb-rate' }, [icon('statusbar-download', { size: 14 }), downRate]),
    el('span', { class: 'tb-rate' }, [icon('statusbar-upload', { size: 14 }), upRate]),
  ]);
  tooltip(rates, () => t('main.toolbar.rates', { down: downRate.textContent, up: upRate.textContent }));

  const altSpeed = el('button', { type: 'button', class: 'switch tb-alt-speed tb-secondary', role: 'switch', 'aria-checked': 'false', 'aria-label': t('main.toolbar.altSpeed') });
  tooltip(altSpeed, () => t('main.toolbar.altSpeed'));
  altSpeed.addEventListener('click', async () => {
    const session = store.get().session;
    const next = !session.altSpeedEnabled;
    altSpeed.setAttribute('aria-checked', String(next));
    try {
      await setSession(ctx.rpc, ctx.caps, session, { 'alt-speed-enabled': next });
      store.set({ session: { ...store.get().session, altSpeedEnabled: next } });
    } catch (err) {
      altSpeed.setAttribute('aria-checked', String(!next));
      ctx.ui.toast(t('main.feedback.actionFailed', { action: t('main.toolbar.altSpeed'), message: errorMessage(t, err) }), { tone: 'error' });
    }
  });

  const themeButton = iconButton(t('core.theme.label'), 'palette-switch', () => {
    const current = preference();
    menu(themeButton, THEME_CHOICES.map((choice) => ({
      label: t(`core.theme.${choice}`),
      checked: current === choice,
      onSelect: () => setVariant(choice),
    })), { label: t('core.theme.label') });
  }, { class: 'tb-secondary', attrs: { 'aria-haspopup': 'menu' } });

  const settingsButton = iconButton(t('main.actions.settings'), 'toolbar-settings', () => openSettings(), { class: 'tb-secondary' });
  const aboutButton = iconButton(t('main.actions.about'), 'toolbar-help', () => openAbout(), { class: 'tb-secondary' });

  const moreButton = iconButton(t('core.actions.more'), 'more', () => {
    const ids = selected();
    const session = store.get().session;
    const items = [
      ...actionMenuItems(ctx, byGroup('transfer', 'manage'), ids),
      { label: t('main.actions.queue'), icon: 'toolbar-move-up', items: actionMenuItems(ctx, byGroup('queue'), ids) },
      'separator',
      ...actionMenuItems(ctx, byGroup('tools'), ids),
      'separator',
      { label: t('main.toolbar.altSpeed'), checked: Boolean(session.altSpeedEnabled), onSelect: () => altSpeed.click() },
      { label: t('core.theme.label'), icon: 'palette-switch', items: THEME_CHOICES.map((choice) => ({ label: t(`core.theme.${choice}`), checked: preference() === choice, onSelect: () => setVariant(choice) })) },
      'separator',
      { label: t('main.actions.settings'), icon: 'toolbar-settings', onSelect: () => openSettings() },
      { label: t('main.actions.about'), icon: 'toolbar-help', onSelect: () => openAbout() },
    ];
    menu(moreButton, items, { label: t('core.actions.more') });
  }, { class: 'tb-more', attrs: { 'aria-haspopup': 'menu' } });

  clear(root,
    hamburger,
    brand,
    addButton,
    el('span', { class: 'separator-v tb-secondary', 'aria-hidden': 'true' }),
    transferGroup,
    el('span', { class: 'separator-v', 'aria-hidden': 'true' }),
    removeGroup,
    el('span', { class: 'separator-v tb-secondary', 'aria-hidden': 'true' }),
    manageGroup,
    el('div', { class: 'tb-spacer' }),
    search.root,
    searchToggle,
    rates,
    altSpeed,
    themeButton,
    settingsButton,
    aboutButton,
    moreButton,
  );

  // ---- store wiring --------------------------------------------------------

  function applySelection(selection) {
    for (const [id, button] of actionButtons) {
      const action = ACTION_BY_ID.get(id);
      const off = action ? !actionEnabled(action, selection.size) : selection.size === 0;
      button.disabled = off;
      button.setAttribute('aria-disabled', String(off));
    }
  }

  function applyStats(stats) {
    downRate.textContent = ctx.fmt.speed(stats.downloadSpeed ?? 0);
    upRate.textContent = ctx.fmt.speed(stats.uploadSpeed ?? 0);
  }

  function applySession(session) {
    altSpeed.setAttribute('aria-checked', String(Boolean(session.altSpeedEnabled)));
  }

  function syncSidebarState() {
    if (app) hamburger.setAttribute('aria-expanded', String(app.hasAttribute('data-sidebar-open')));
  }

  const offs = [
    store.subscribe('selection', applySelection),
    store.subscribe('stats', applyStats),
    store.subscribe('session', applySession),
  ];
  applySelection(store.get().selection);
  applyStats(store.get().stats);
  applySession(store.get().session);

  let observer = null;
  if (app && typeof MutationObserver === 'function') {
    observer = new MutationObserver(syncSidebarState);
    observer.observe(app, { attributes: true, attributeFilter: ['data-sidebar-open'] });
  }

  return () => {
    for (const off of offs) off();
    search.destroy();
    if (observer) observer.disconnect();
  };
}
