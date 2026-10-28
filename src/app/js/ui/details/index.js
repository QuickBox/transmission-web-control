/**
 * Details for the `focused` torrent: a resizable drawer under the list on
 * wide layouts, a right sheet on medium ones and a full-screen sheet with a
 * back button on narrow ones. Underline tabs (arrow keys, Home, End) switch
 * between tab views; with no torrent focused the drawer shows an empty state.
 *
 * Each tab view names the extra `torrent-get` fields it needs. Static fields
 * (`live: false`) are fetched once per torrent; live ones are fetched again
 * whenever the poller replaces the focused torrent in the store.
 *
 * Other modules call `openDetails(id, { tab })`, `closeDetails()` and
 * `showTab(id)`. The active tab and the drawer height live in `prefs`
 * (`detailsTab`, `detailsHeight`).
 */

import * as general from './general.js?v=__QBV__';
import * as files from './files.js?v=__QBV__';
import * as trackers from './trackers.js?v=__QBV__';
import * as peers from './peers.js?v=__QBV__';
import * as options from './options.js?v=__QBV__';

/**
 * @typedef {{
 *   id: string, labelKey: string, fields: string[] | ((caps: object|null) => string[]), live: boolean,
 *   create: (ctx: object, host: TabHost) => TabView,
 * }} DetailsTab
 * @typedef {{ refresh: () => void, torrentId: () => number|null }} TabHost
 * @typedef {{ loading: boolean, error: string|null }} TabState
 * @typedef {{ root: HTMLElement, render: (torrent: object, detail: object|null, state: TabState) => void,
 *   destroy?: () => void }} TabView
 */

/** Tab order. Views that are not built yet are simply absent. */
export const TABS = Object.freeze([general, files, trackers, peers, options]);

/**
 * The extra `torrent-get` fields a tab needs with the current caps.
 * @param {DetailsTab} tab
 * @param {object|null} caps
 */
export function tabFields(tab, caps) {
  return typeof tab.fields === 'function' ? tab.fields(caps) : tab.fields;
}

const SHEET_QUERY = '(max-width: 959px)';
const FULL_QUERY = '(max-width: 639px)';
const HEIGHT_MIN = 20;
const HEIGHT_MAX = 70;
const HEIGHT_STEP = 2;
const BEHIND_SHEET = ['.shell-toolbar', '.shell-sidebar', '.shell-table', '.shell-statusbar', '.shell-bulkbar'];

let instance = null;
let seq = 0;

function matches(query) {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(query).matches;
}

/**
 * Focus a torrent's details: sets `focused`, switches to `tab` when given,
 * opens the sheet on medium and narrow layouts and moves focus to the tabs.
 * @param {number} [id] keep the current torrent when omitted
 * @param {{ tab?: string, focus?: boolean }} [opts]
 */
export function openDetails(id, opts = {}) {
  if (!instance) return;
  instance.open(id, opts);
}

/** Close the sheet (medium, narrow) and return focus to where it came from. */
export function closeDetails() {
  if (instance) instance.close();
}

/** Switch the visible tab. */
export function showTab(id) {
  if (instance) instance.select(id, false);
}

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {
  const { el, icon, tooltip } = ctx.ui;
  const t = ctx.i18n;
  const app = root.closest('#app') || root.parentElement;
  const uid = `details-${++seq}`;

  /** @type {Map<string, TabView>} */
  const views = new Map();
  /** @type {Map<string, object>} */
  const cache = new Map();
  let activeId = TABS.some((tab) => tab.id === ctx.store.get().prefs.detailsTab)
    ? ctx.store.get().prefs.detailsTab : TABS[0].id;
  let shownTorrent = null;
  let shownId = null;
  let inflight = false;
  let dirty = false;
  let returnTo = null;
  let fetchSeq = 0;
  const loadErrors = new Map();

  const name = el('h2', { class: 'details-name', id: `${uid}-name` });
  const status = el('span', { class: 'status details-status' });
  const back = el('button', {
    type: 'button', class: 'btn btn-ghost details-back', on: { click: () => close() },
  }, [icon('panel-collapsed', { size: 18 }), el('span', { text: t('details.back') })]);
  const closeBtn = el('button', {
    type: 'button', class: 'btn-icon btn-icon-sm details-close', 'aria-label': t('details.close'),
    on: { click: () => close() },
  }, [icon('menu-close', { size: 16 })]);
  tooltip(closeBtn, t('details.close'));
  tooltip(name, () => (shownTorrent ? shownTorrent.name : ''));

  const tabButtons = new Map();
  const tablist = el('div', {
    class: 'details-tabs', role: 'tablist', 'aria-labelledby': `${uid}-name`,
    on: { keydown: onTabKey },
  }, TABS.map((tab) => {
    const button = el('button', {
      type: 'button', role: 'tab', class: 'details-tab', id: `${uid}-tab-${tab.id}`,
      'aria-controls': `${uid}-panel`, 'data-tab': tab.id,
      on: { click: () => select(tab.id, true) },
    }, [t(tab.labelKey)]);
    tabButtons.set(tab.id, button);
    return button;
  }));

  const panel = el('div', {
    class: 'details-panel', id: `${uid}-panel`, role: 'tabpanel', tabindex: '0',
  });
  const header = el('div', { class: 'details-header' }, [
    back,
    el('div', { class: 'details-title' }, [name, status]),
    closeBtn,
    tablist,
  ]);
  const empty = el('div', { class: 'details-empty' }, [
    el('span', { class: 'details-empty-icon' }, [icon('empty-state', { size: 40 })]),
    el('p', { class: 'details-empty-title', text: t('details.empty.title') }),
    el('p', { class: 'details-empty-hint', text: t('details.empty.hint') }),
  ]);
  const grip = el('div', {
    class: 'details-grip', role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal',
    'aria-label': t('details.resize'), 'aria-valuemin': HEIGHT_MIN, 'aria-valuemax': HEIGHT_MAX,
    on: { pointerdown: onGripDown, keydown: onGripKey },
  });
  tooltip(grip, t('details.resize'));
  const body = el('div', { class: 'details-body' }, [header, panel]);
  const shell = el('div', { class: 'details', on: { keydown: onKey } }, [grip, empty, body]);
  root.replaceChildren(shell);

  function viewFor(tabId) {
    let view = views.get(tabId);
    if (!view) {
      const tab = TABS.find((x) => x.id === tabId);
      view = tab.create(ctx, { refresh: () => fetchDetail(true), torrentId: () => shownId });
      views.set(tabId, view);
    }
    return view;
  }

  function activeTab() {
    return TABS.find((tab) => tab.id === activeId);
  }

  function cacheKey(tabId, id) {
    return `${tabId}:${id}`;
  }

  function applyHeight() {
    const pct = Number(ctx.store.get().prefs.detailsHeight);
    const value = Number.isFinite(pct) ? Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, pct)) : 38;
    root.style.setProperty('--details-h', `${value}%`);
    grip.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  function setHeight(pct) {
    const value = Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, pct));
    const prefs = ctx.store.get().prefs;
    if (prefs.detailsHeight === value) return;
    ctx.store.set({ prefs: { ...prefs, detailsHeight: value } });
  }

  function syncTabs() {
    for (const [id, button] of tabButtons) {
      const selected = id === activeId;
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('tabindex', selected ? '0' : '-1');
    }
    panel.setAttribute('aria-labelledby', `${uid}-tab-${activeId}`);
  }

  function renderView(state) {
    if (!shownTorrent) return;
    const view = viewFor(activeId);
    if (panel.firstChild !== view.root) panel.replaceChildren(view.root);
    const detail = cache.get(cacheKey(activeId, shownId)) || null;
    view.render(shownTorrent, detail, state || {
      loading: tabFields(activeTab(), ctx.caps).length > 0 && !detail && !loadErrors.has(activeId),
      error: loadErrors.get(activeId) || null,
    });
  }

  function render() {
    const { focused, torrents } = ctx.store.get();
    const torrent = focused == null ? null : torrents.get(focused) || null;
    if (!torrent) {
      shownTorrent = null;
      shownId = null;
      cache.clear();
      shell.classList.add('is-empty');
      return;
    }
    shell.classList.remove('is-empty');
    const changed = torrent !== shownTorrent;
    if (torrent.id !== shownId) {
      cache.clear();
      loadErrors.clear();
    }
    shownTorrent = torrent;
    shownId = torrent.id;
    name.textContent = torrent.name;
    status.setAttribute('data-state', torrent.state);
    status.textContent = t(`core.status.${torrent.state}`);
    syncTabs();
    renderView();
    if (changed) fetchDetail(false);
  }

  /**
   * Fetch the active tab's extra fields for the shown torrent. One request at
   * a time; a change while one is in flight queues exactly one more.
   */
  function fetchDetail(force) {
    const tab = activeTab();
    const wanted = tabFields(tab, ctx.caps);
    if (shownId == null || wanted.length === 0) return;
    const key = cacheKey(tab.id, shownId);
    if (!force && !tab.live && cache.has(key)) return;
    if (inflight) {
      dirty = true;
      return;
    }
    inflight = true;
    dirty = false;
    const id = shownId;
    const tabId = tab.id;
    const mine = ++fetchSeq;
    Promise.resolve()
      .then(() => ctx.rpc.call('torrent-get', { ids: [id], fields: ['id', ...wanted] }))
      .then((result) => {
        const row = result && Array.isArray(result.torrents)
          ? result.torrents.find((x) => x && x.id === id) || result.torrents[0] : null;
        cache.set(cacheKey(tabId, id), row || {});
        loadErrors.delete(tabId);
      }, (err) => {
        loadErrors.set(tabId, (err && err.message) || t('details.loadFailed'));
      })
      .finally(() => {
        inflight = false;
        if (mine === fetchSeq && id === shownId && tabId === activeId) renderView();
        if (dirty) fetchDetail(true);
      });
  }

  function select(tabId, focusTab) {
    if (!TABS.some((tab) => tab.id === tabId)) return;
    if (tabId !== activeId) {
      activeId = tabId;
      const prefs = ctx.store.get().prefs;
      if (prefs.detailsTab !== tabId) ctx.store.set({ prefs: { ...prefs, detailsTab: tabId } });
      syncTabs();
      renderView();
      fetchDetail(false);
    }
    if (focusTab) tabButtons.get(tabId).focus();
  }

  function onTabKey(e) {
    const ids = TABS.map((tab) => tab.id);
    const index = ids.indexOf(activeId);
    let next = null;
    if (e.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
    else if (e.key === 'ArrowLeft') next = ids[(index - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') next = ids[0];
    else if (e.key === 'End') next = ids[ids.length - 1];
    if (next) {
      e.preventDefault();
      select(next, true);
    }
  }

  function setSheetInert(on) {
    for (const selector of BEHIND_SHEET) {
      const node = app && app.querySelector(selector);
      if (node) node.inert = on;
    }
  }

  function isOpen() {
    return Boolean(app && app.getAttribute('data-details') === 'open');
  }

  function open(id, opts) {
    if (id != null && id !== ctx.store.get().focused) ctx.store.set({ focused: id });
    if (opts.tab) select(opts.tab, false);
    if (matches(SHEET_QUERY) && app) {
      if (!isOpen()) returnTo = document.activeElement;
      app.setAttribute('data-details', 'open');
      setSheetInert(matches(FULL_QUERY));
    }
    if (opts.focus !== false && shownTorrent) tabButtons.get(activeId).focus();
  }

  function close() {
    if (!isOpen()) return;
    app.removeAttribute('data-details');
    setSheetInert(false);
    const target = returnTo;
    returnTo = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' && isOpen() && !e.defaultPrevented) {
      e.preventDefault();
      close();
    }
  }

  function onGripDown(e) {
    const main = root.parentElement;
    if (!main || e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = main.getBoundingClientRect();
      if (r.height <= 0) return;
      setHeight(Math.round(((r.bottom - ev.clientY) / r.height) * 100));
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  function onGripKey(e) {
    const current = Number(grip.getAttribute('aria-valuenow')) || 38;
    if (e.key === 'ArrowUp') setHeight(current + HEIGHT_STEP);
    else if (e.key === 'ArrowDown') setHeight(current - HEIGHT_STEP);
    else if (e.key === 'Home') setHeight(HEIGHT_MAX);
    else if (e.key === 'End') setHeight(HEIGHT_MIN);
    else return;
    e.preventDefault();
  }

  const offFocused = ctx.store.subscribe('focused', render);
  const offTorrents = ctx.store.subscribe('torrents', (map) => {
    const next = shownId == null ? null : map.get(shownId);
    if (next === shownTorrent && shownTorrent) return;
    render();
  });
  const offPrefs = ctx.store.subscribe('prefs', applyHeight);
  const sheetQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(FULL_QUERY) : null;
  const onFull = () => setSheetInert(isOpen() && matches(FULL_QUERY));
  if (sheetQuery) sheetQuery.addEventListener('change', onFull);

  instance = { open, close, select };
  applyHeight();
  syncTabs();
  render();

  return () => {
    offFocused();
    offTorrents();
    offPrefs();
    if (sheetQuery) sheetQuery.removeEventListener('change', onFull);
    for (const view of views.values()) if (view.destroy) view.destroy();
    if (instance && instance.open === open) instance = null;
  };
}
