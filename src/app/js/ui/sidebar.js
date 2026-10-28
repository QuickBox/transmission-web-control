/**
 * Filter sidebar: Status, Labels, Trackers and Folders sections with count
 * pills. Writes the `filter` store key and reads `torrents`. Collapses to a
 * rail (persisted in `prefs.sidebarRail`) and becomes an off-canvas drawer
 * below 960px (the shell toggles `#app[data-sidebar-open]`; picking a filter
 * closes it). Items are created once per key and patched in place on every
 * store update, so a poll never steals focus or swallows a press in flight.
 * Mounted into `[data-region="sidebar"]`.
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

  /**
   * One nav item, created once per key and patched afterwards so a poll never
   * replaces the node a user is focusing or pressing.
   */
  function createItem(section, key, spec) {
    const label = el('span', { class: 'nav-label', text: spec.label });
    const count = el('span', { class: 'count-pill nav-count', text: ctx.fmt.count(spec.count) });
    const button = el('button', {
      type: 'button',
      class: 'nav-item',
      'data-key': key,
      on: { click: () => entry.onClick() },
    }, [
      spec.iconName ? el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon(spec.iconName, { size: 16 })) : el('span', { class: 'nav-dot', 'aria-hidden': 'true' }),
      label,
      count,
    ]);
    const entry = { li: el('li', {}, button), button, label, count, spec };
    tooltip(button, () => (entry.spec.hint ? `${entry.spec.label} (${entry.spec.hint})` : `${entry.spec.label} · ${ctx.fmt.count(entry.spec.count)}`));
    entry.onClick = () => entry.spec.onClick();
    return entry;
  }

  function patchItem(entry, spec) {
    entry.spec = spec;
    if (entry.label.textContent !== spec.label) entry.label.textContent = spec.label;
    const countText = ctx.fmt.count(spec.count);
    if (entry.count.textContent !== countText) entry.count.textContent = countText;
    entry.button.classList.toggle('is-active', Boolean(spec.active));
    if (spec.active) entry.button.setAttribute('aria-current', 'true');
    else entry.button.removeAttribute('aria-current');
  }

  /** Put `nodes` under `list` in order, moving only the nodes that are out of place. */
  function reconcileOrder(list, nodes) {
    nodes.forEach((node, i) => {
      const current = list.children[i];
      if (current === node) return;
      if (current) list.insertBefore(node, current);
      else list.append(node);
    });
    for (const extra of [...list.children].slice(nodes.length)) extra.remove();
  }

  const sections = new Map();
  function createSection(id, title) {
    const list = el('ul', { class: 'nav-list', role: 'list' });
    const emptyNote = el('p', { class: 'nav-empty', text: t(`main.sidebar.no${id[0].toUpperCase()}${id.slice(1)}`), hidden: true });
    const root = el('section', { class: 'nav-section', 'data-section': id, 'aria-labelledby': `sidebar-${id}` }, [
      el('h2', { class: 'nav-heading', id: `sidebar-${id}`, text: title }),
      list,
      emptyNote,
    ]);
    const section = { root, list, emptyNote, entries: new Map() };
    sections.set(id, section);
    return root;
  }

  /** Bring one section in line with `specs` (ordered, keyed by `spec.key`): create, patch, drop, reorder. */
  function renderSection(id, specs) {
    const section = sections.get(id);
    const keys = new Set(specs.map((s) => s.key));
    for (const [key, entry] of section.entries) {
      if (!keys.has(key)) {
        entry.li.remove();
        section.entries.delete(key);
      }
    }
    const nodes = specs.map((spec) => {
      let entry = section.entries.get(spec.key);
      if (!entry) {
        entry = createItem(id, spec.key, spec);
        section.entries.set(spec.key, entry);
      }
      patchItem(entry, spec);
      return entry.li;
    });
    reconcileOrder(section.list, nodes);
    section.list.hidden = specs.length === 0;
    section.emptyNote.hidden = specs.length > 0;
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

  clear(root,
    el('div', { class: 'nav' }, [
      createSection('status', t('main.sidebar.status')),
      createSection('labels', t('main.sidebar.labels')),
      createSection('trackers', t('main.sidebar.trackers')),
      createSection('folders', t('main.sidebar.folders')),
    ]),
    el('div', { class: 'nav-foot' }, railButton),
  );

  function render() {
    const { torrents, filter } = store.get();
    const agg = aggregate(torrents.values());
    renderSection('status', STATUS_ITEMS.map((s) => ({
      key: s.id,
      label: statusLabel(t, s.id),
      count: s.count(agg),
      iconName: s.icon,
      active: (filter.status || 'all') === s.id,
      onClick: () => setFilter({ status: s.id }),
    })));
    renderSection('labels', [...labelCounts(torrents, labels).entries()].map(([label, count]) => ({
      key: label,
      label,
      count,
      active: filter.label === label,
      onClick: () => toggleValue('label', label),
    })));
    renderSection('trackers', [...agg.trackers.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((tr) => ({ key: tr.key, label: tr.key, count: tr.count, active: filter.tracker === tr.key, onClick: () => toggleValue('tracker', tr.key) })));
    renderSection('folders', [...agg.folders.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((f) => ({ key: f.key, label: folderName(f.key), count: f.count, active: filter.folder === f.key, hint: f.key, onClick: () => toggleValue('folder', f.key) })));
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
