/**
 * Filter sidebar: Status, Labels, Trackers and Folders sections with count
 * pills. Writes the `filter` store key and reads `torrents`. Collapses to a
 * rail (persisted in `prefs.sidebarRail`) and becomes an off-canvas drawer
 * below 960px (the shell toggles `#app[data-sidebar-open]`; picking a filter
 * closes it). Mounted into `[data-region="sidebar"]`.
 */

import { aggregate } from '../rpc/torrents.js?v=__QBV__';
import { createLabelStore, memoryStorage } from '../rpc/labels.js?v=__QBV__';

/** Status entries in sidebar order: filter value, icon, count source. */
export const STATUS_ITEMS = Object.freeze([
  { id: 'all', icon: 'sidebar-all', count: (agg) => agg.count },
  { id: 'active', icon: 'state-active', count: (agg) => agg.active },
  { id: 'downloading', icon: 'state-downloading', count: (agg) => agg.states.downloading },
  { id: 'seeding', icon: 'state-seeding', count: (agg) => agg.states.seeding },
  { id: 'stopped', icon: 'state-paused', count: (agg) => agg.states.stopped + agg.states.finished },
  { id: 'checking', icon: 'state-checking', count: (agg) => agg.states.checking },
  { id: 'queued', icon: 'state-queued', count: (agg) => agg.states.queued },
  { id: 'error', icon: 'state-error', count: (agg) => agg.states.error },
  { id: 'warning', icon: 'state-error', count: (agg) => agg.warning },
]);

function statusLabel(t, id) {
  if (id === 'all' || id === 'active' || id === 'stopped' || id === 'warning') return t(`main.sidebar.${id}`);
  return t(`core.status.${id}`);
}

/** Label counts: native labels from the rows, browser labels through the store. */
export function labelCounts(torrents, labels) {
  const counts = new Map();
  for (const torrent of torrents.values()) {
    for (const label of labels.read(torrent)) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Last path segment, for folder rows; the full path stays in the tooltip. */
export function folderName(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed || path : trimmed.slice(i + 1) || trimmed;
}

function storageFor() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    // Blocked storage: labels on 2.94 last for this page only.
  }
  return memoryStorage();
}

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @param {{ storage?: object }} [options] label storage for 2.94 (tests inject it)
 * @returns {() => void} Teardown.
 */
export function mount(root, ctx, options = {}) {
  const { el, clear, icon, tooltip } = ctx.ui;
  const t = ctx.i18n;
  const { store } = ctx;
  const app = root.closest('#app');
  const labels = createLabelStore({ client: ctx.rpc, caps: ctx.caps, storage: options.storage || storageFor() });

  root.setAttribute('id', 'sidebar');

  function setFilter(patch) {
    const filter = store.get().filter;
    const next = { ...filter, ...patch };
    const same = Object.keys(next).every((k) => next[k] === filter[k]);
    if (!same) store.set({ filter: next });
    if (app && app.hasAttribute('data-sidebar-open')) app.removeAttribute('data-sidebar-open');
  }

  function toggleValue(key, value) {
    setFilter({ [key]: store.get().filter[key] === value ? null : value });
  }

  function item({ label, count, iconName, active, onClick, hint }) {
    const button = el('button', {
      type: 'button',
      class: ['nav-item', active && 'is-active'],
      'aria-current': active ? 'true' : null,
      on: { click: onClick },
    }, [
      iconName ? el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 16 })) : el('span', { class: 'nav-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'nav-label', text: label }),
      el('span', { class: 'count-pill nav-count', text: ctx.fmt.count(count) }),
    ]);
    tooltip(button, () => (hint ? `${label} (${hint})` : `${label} · ${ctx.fmt.count(count)}`));
    return el('li', { role: 'none' }, button);
  }

  function section(id, title, items) {
    return el('section', { class: 'nav-section', 'data-section': id, 'aria-labelledby': `sidebar-${id}` }, [
      el('h2', { class: 'nav-heading', id: `sidebar-${id}`, text: title }),
      items.length > 0
        ? el('ul', { class: 'nav-list', role: 'list' }, items)
        : el('p', { class: 'nav-empty', text: t(`main.sidebar.no${id[0].toUpperCase()}${id.slice(1)}`) }),
    ]);
  }

  const railButton = el('button', { type: 'button', class: 'btn-icon btn-icon-md nav-rail-toggle', 'aria-pressed': 'false' });
  tooltip(railButton, () => t(store.get().prefs.sidebarRail ? 'main.toolbar.expand' : 'main.toolbar.collapse'));
  railButton.addEventListener('click', () => {
    const prefs = store.get().prefs;
    store.set({ prefs: { ...prefs, sidebarRail: !prefs.sidebarRail } });
  });

  function applyRail(prefs) {
    const rail = Boolean(prefs.sidebarRail);
    if (app) {
      if (rail) app.setAttribute('data-sidebar', 'rail');
      else app.removeAttribute('data-sidebar');
    }
    railButton.setAttribute('aria-pressed', String(rail));
    railButton.setAttribute('aria-label', t(rail ? 'main.toolbar.expand' : 'main.toolbar.collapse'));
    clear(railButton, icon(rail ? 'panel-collapsed' : 'panel-expanded', { size: 18 }));
  }

  function render() {
    const { torrents, filter } = store.get();
    const agg = aggregate(torrents.values());
    const status = STATUS_ITEMS.map((s) => item({
      label: statusLabel(t, s.id),
      count: s.count(agg),
      iconName: s.icon,
      active: (filter.status || 'all') === s.id,
      onClick: () => setFilter({ status: s.id }),
    }));
    const labelItems = [...labelCounts(torrents, labels).entries()].map(([label, count]) => item({
      label,
      count,
      active: filter.label === label,
      onClick: () => toggleValue('label', label),
    }));
    const trackerItems = [...agg.trackers.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((tr) => item({ label: tr.key, count: tr.count, active: filter.tracker === tr.key, onClick: () => toggleValue('tracker', tr.key) }));
    const folderItems = [...agg.folders.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((f) => item({ label: folderName(f.key), count: f.count, active: filter.folder === f.key, hint: f.key, onClick: () => toggleValue('folder', f.key) }));

    clear(root,
      el('div', { class: 'nav' }, [
        section('status', t('main.sidebar.status'), status),
        section('labels', t('main.sidebar.labels'), labelItems),
        section('trackers', t('main.sidebar.trackers'), trackerItems),
        section('folders', t('main.sidebar.folders'), folderItems),
      ]),
      el('div', { class: 'nav-foot' }, railButton),
    );
    applyRail(store.get().prefs);
  }

  const offs = [
    store.subscribe('torrents', render),
    store.subscribe('filter', render),
    store.subscribe('prefs', () => applyRail(store.get().prefs)),
  ];
  render();

  return () => {
    for (const off of offs) off();
  };
}
