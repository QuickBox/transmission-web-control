/**
 * Torrent list: the virtualised `role=grid` table, sorting, the selection
 * model and keyboard, and the card layout under its container query. Reads
 * `torrents`, `filter`, `prefs`, `focused`; writes `order` (the sorted,
 * filtered ids every other module shares), `selection` and `focused`.
 * Mounted into `[data-region="table"]`, which is the scroll container.
 *
 * Only the rows inside the scrolled window (plus a small overscan) exist in
 * the DOM; every row is the same height for the current layout, so the window
 * is plain arithmetic on `scrollTop`. The rows are rebuilt from the store on
 * each change: the window is at most a few dozen rows, so that is cheaper and
 * safer than diffing.
 */

import { EMPTY } from '../core/format.js?v=__QBV__';
import { STATES, searchTorrents } from '../rpc/torrents.js?v=__QBV__';
import { openDetails } from './details/index.js?v=__QBV__';

/** Fired on the region root (bubbling) when the user asks to remove the selection. */
export const REMOVE_REQUEST = 'remove-request';

/** Row heights per layout, in px; `table.css` mirrors them. */
export const ROW_HEIGHT = Object.freeze({ comfortable: 40, compact: 32, cards: 112 });

/** Below this container width the rows render as cards (`table.css` has the same number). */
export const CARD_MAX_WIDTH = 720;

const OVERSCAN = 6;
/** Tracker-warning glyph; `table.css` tints it with the checking hue. */
const WARNING_ICON = 'state-error';

const compareText = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
const joinList = (list) => (Array.isArray(list) ? list.join(', ') : '');
const countOrEmpty = (ctx, n) => (n === null || n === undefined ? ctx.fmt.count(NaN) : ctx.fmt.count(n));

/**
 * Column catalogue. `narrow` is the hide-on-narrow tier (0 always shown, 3
 * hidden first); `value` feeds the sort, `text` the cell; a column without
 * `text` has a dedicated renderer.
 * @type {readonly { id: string, width: string, align?: 'end', sortable: boolean, narrow: 0|1|2|3,
 *   value: (t: object) => string|number|null, text?: (t: object, ctx: object) => string }[]}
 */
export const COLUMNS = Object.freeze([
  { id: 'name', width: 'minmax(220px, 1fr)', sortable: true, narrow: 0, value: (t) => t.name },
  { id: 'status', width: 'minmax(128px, max-content)', sortable: true, narrow: 0, value: (t) => STATES.indexOf(t.state) },
  { id: 'percentDone', width: '132px', sortable: true, narrow: 0, value: (t) => t.percentDone },
  { id: 'totalSize', width: '96px', align: 'end', sortable: true, narrow: 0, value: (t) => t.totalSize, text: (t, ctx) => ctx.fmt.bytes(t.totalSize) },
  { id: 'rateDownload', width: '96px', align: 'end', sortable: true, narrow: 0, value: (t) => t.rateDownload, text: (t, ctx) => (t.rateDownload > 0 ? ctx.fmt.speed(t.rateDownload) : EMPTY) },
  { id: 'rateUpload', width: '96px', align: 'end', sortable: true, narrow: 0, value: (t) => t.rateUpload, text: (t, ctx) => (t.rateUpload > 0 ? ctx.fmt.speed(t.rateUpload) : EMPTY) },
  { id: 'eta', width: '84px', align: 'end', sortable: true, narrow: 1, value: (t) => (t.eta < 0 ? null : t.eta), text: (t, ctx) => ctx.fmt.eta(t.eta) },
  { id: 'uploadRatio', width: '72px', align: 'end', sortable: true, narrow: 2, value: (t) => t.uploadRatio, text: (t, ctx) => ctx.fmt.ratio(t.uploadRatio) },
  { id: 'seederCount', width: '76px', align: 'end', sortable: true, narrow: 2, value: (t) => t.seederCount, text: (t, ctx) => countOrEmpty(ctx, t.seederCount) },
  { id: 'leecherCount', width: '76px', align: 'end', sortable: true, narrow: 2, value: (t) => t.leecherCount, text: (t, ctx) => countOrEmpty(ctx, t.leecherCount) },
  { id: 'uploadedEver', width: '96px', align: 'end', sortable: true, narrow: 3, value: (t) => t.uploadedEver, text: (t, ctx) => ctx.fmt.bytes(t.uploadedEver) },
  { id: 'addedDate', width: '156px', sortable: true, narrow: 3, value: (t) => t.addedDate, text: (t, ctx) => ctx.fmt.date(t.addedDate) },
  { id: 'doneDate', width: '156px', sortable: true, narrow: 3, value: (t) => t.doneDate, text: (t, ctx) => ctx.fmt.date(t.doneDate) },
  { id: 'activityDate', width: '156px', sortable: true, narrow: 3, value: (t) => t.activityDate, text: (t, ctx) => ctx.fmt.date(t.activityDate) },
  { id: 'queuePosition', width: '64px', align: 'end', sortable: true, narrow: 3, value: (t) => t.queuePosition, text: (t, ctx) => ctx.fmt.count(t.queuePosition) },
  { id: 'downloadDir', width: '220px', sortable: true, narrow: 3, value: (t) => t.downloadDir, text: (t) => t.downloadDir },
  { id: 'labels', width: '150px', sortable: true, narrow: 3, value: (t) => joinList(t.labels), text: (t) => joinList(t.labels) },
  { id: 'trackers', width: '170px', sortable: true, narrow: 3, value: (t) => joinList(t.trackerHosts), text: (t) => joinList(t.trackerHosts) },
  { id: 'id', width: '56px', align: 'end', sortable: true, narrow: 3, value: (t) => t.id, text: (t, ctx) => ctx.fmt.count(t.id) },
]);

const COLUMN_BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

/**
 * Columns shown until the user picks their own set (`prefs.columns`). The
 * fixed widths sum to about 1110px, so the set fits a 1440px window with the
 * sidebar docked and no sideways scroll; the name column takes the rest.
 */
export const DEFAULT_COLUMNS = Object.freeze([
  'name', 'status', 'percentDone', 'totalSize', 'rateDownload', 'rateUpload', 'eta',
  'uploadRatio', 'seederCount', 'leecherCount',
]);

/** Columns a card shows regardless of `prefs.columns`. */
export const CARD_COLUMNS = Object.freeze(['name', 'status', 'percentDone', 'rateDownload', 'rateUpload', 'eta', 'totalSize']);

export const DEFAULT_SORT = Object.freeze({ key: 'queuePosition', dir: 'asc' });

/** `prefs.columns` validated against the catalogue; `name` is always first. */
export function columnsFromPrefs(prefs) {
  const wanted = Array.isArray(prefs && prefs.columns) ? prefs.columns : DEFAULT_COLUMNS;
  const ids = ['name', ...wanted.filter((id) => id !== 'name' && COLUMN_BY_ID.has(id))];
  return ids.map((id) => COLUMN_BY_ID.get(id));
}

/** `prefs.sort` validated; unknown keys fall back to the default. */
export function sortFromPrefs(prefs) {
  const sort = prefs && prefs.sort;
  if (!sort || !COLUMN_BY_ID.has(sort.key) || !COLUMN_BY_ID.get(sort.key).sortable) return DEFAULT_SORT;
  return { key: sort.key, dir: sort.dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * Does a torrent pass the sidebar filter? `stopped` covers finished torrents
 * too (the sidebar has one Paused/Stopped entry), `active` means transferring,
 * `warning` means a tracker warning is set.
 */
export function matchesFilter(t, filter) {
  const f = filter || {};
  switch (f.status) {
    case undefined:
    case null:
    case 'all':
      break;
    case 'active':
      if (!(t.rateDownload > 0 || t.rateUpload > 0)) return false;
      break;
    case 'warning':
      if (!t.warning) return false;
      break;
    case 'stopped':
      if (t.state !== 'stopped' && t.state !== 'finished') return false;
      break;
    default:
      if (t.state !== f.status) return false;
  }
  if (f.label && !(Array.isArray(t.labels) && t.labels.includes(f.label))) return false;
  if (f.tracker && !(Array.isArray(t.trackerHosts) && t.trackerHosts.includes(f.tracker))) return false;
  if (f.folder && t.downloadDir !== f.folder) return false;
  return true;
}

/**
 * The torrents the list shows for a filter, unsorted.
 * @param {Map<number, object>|Iterable<object>} torrents
 * @param {object} filter
 * @returns {object[]}
 */
export function visibleTorrents(torrents, filter) {
  const all = torrents instanceof Map ? [...torrents.values()] : [...torrents];
  const matched = all.filter((t) => matchesFilter(t, filter));
  return filter && filter.search ? searchTorrents(matched, filter.search) : matched;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || Number.isNaN(a)) return 1;
  if (b === null || b === undefined || Number.isNaN(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return compareText(a, b);
}

/**
 * A sorted copy. Missing values sort last in either direction; ties break on id.
 * @param {object[]} list
 * @param {{ key: string, dir: 'asc'|'desc' }} sort
 */
export function sortTorrents(list, sort) {
  const column = COLUMN_BY_ID.get(sort && sort.key) || COLUMN_BY_ID.get(DEFAULT_SORT.key);
  const sign = sort && sort.dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = column.value(a);
    const vb = column.value(b);
    const missingA = va === null || va === undefined;
    const missingB = vb === null || vb === undefined;
    if (missingA !== missingB) return missingA ? 1 : -1;
    const c = compareValues(va, vb) * sign;
    return c !== 0 ? c : a.id - b.id;
  });
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function rowHeightFor(layout, prefs) {
  if (layout === 'cards') return ROW_HEIGHT.cards;
  return prefs && prefs.density === 'compact' ? ROW_HEIGHT.compact : ROW_HEIGHT.comfortable;
}

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {() => void} Teardown.
 */
export function mount(root, ctx) {
  const { el, clear, icon, tooltip } = ctx.ui;
  const t = ctx.i18n;
  const { store } = ctx;

  let rows = [];
  let indexById = new Map();
  let columns = columnsFromPrefs(store.get().prefs);
  let sort = sortFromPrefs(store.get().prefs);
  let layout = 'rows';
  let activeId = null;
  let anchorId = null;
  let frame = 0;

  const body = el('div', { class: 'torrents-body', role: 'rowgroup' });
  const head = el('div', { class: 'torrents-head', role: 'row', 'aria-rowindex': 1 });
  const empty = el('div', { class: 'torrents-empty', hidden: true });
  const grid = el('div', {
    class: 'torrents',
    role: 'grid',
    'aria-multiselectable': 'true',
    'aria-rowcount': 1,
    'data-layout': layout,
    tabindex: 0,
  }, [head, body]);
  clear(root, grid, empty);

  const rowHeight = () => rowHeightFor(layout, store.get().prefs);
  const selection = () => store.get().selection;
  const torrentById = (id) => store.get().torrents.get(id);

  // ---- header -------------------------------------------------------------

  function setSort(key) {
    const next = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    const prefs = store.get().prefs;
    store.set({ prefs: { ...prefs, sort: next } });
  }

  function renderHead() {
    const allVisible = rows.length > 0 && rows.every((r) => selection().has(r.id));
    const someVisible = !allVisible && rows.some((r) => selection().has(r.id));
    const selectAll = el('input', {
      type: 'checkbox',
      class: 'checkbox',
      'aria-label': t('main.table.selectAll'),
      checked: allVisible,
      indeterminate: someVisible,
      on: { change: () => setSelection(allVisible ? [] : rows.map((r) => r.id)) },
    });
    const cells = [el('div', { role: 'columnheader', class: 'cell cell-check', 'data-col': 'check' }, selectAll)];
    for (const column of columns) {
      const active = sort.key === column.id;
      const label = t(`main.columns.${column.id}`);
      const header = el('div', {
        role: 'columnheader',
        class: ['cell', column.align === 'end' && 'cell-end'],
        'data-col': column.id,
        'data-narrow': column.narrow,
        'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      });
      if (column.sortable) {
        const button = el('button', {
          type: 'button',
          class: ['sort', active && 'is-active'],
          'data-dir': active ? sort.dir : null,
          on: { click: () => setSort(column.id) },
        }, [el('span', { class: 'sort-label', text: label }), active ? icon(sort.dir === 'asc' ? 'sort-asc' : 'sort-desc', { size: 14 }) : null]);
        tooltip(button, () => t(active && sort.dir === 'asc' ? 'main.table.sortDescending' : 'main.table.sortAscending', { column: label }));
        header.append(button);
      } else {
        header.append(el('span', { class: 'sort-label', text: label }));
      }
      cells.push(header);
    }
    clear(head, ...cells);
    grid.style.setProperty('--cols', `44px ${columns.map((c) => c.width).join(' ')}`);
  }

  // ---- rows ---------------------------------------------------------------

  function renderCell(column, torrent) {
    const cell = el('div', {
      role: 'gridcell',
      class: ['cell', column.align === 'end' && 'cell-end', `cell-${column.id}`],
      'data-col': column.id,
      'data-narrow': column.narrow,
    });
    if (column.id === 'name') {
      const name = el('span', { class: 'cell-name', text: torrent.name });
      tooltip(name, () => torrent.name);
      cell.append(name);
      if (torrent.warning) {
        const glyph = el('span', { class: 'cell-warning', role: 'img', 'aria-label': t('main.table.trackerWarning') }, icon(WARNING_ICON, { size: 14 }));
        tooltip(glyph, () => torrent.warning);
        cell.append(glyph);
      }
    } else if (column.id === 'status') {
      cell.append(el('span', { class: 'status', 'data-state': torrent.state, text: t(`core.status.${torrent.state}`) }));
    } else if (column.id === 'percentDone') {
      const fraction = torrent.state === 'checking' ? torrent.recheckProgress : torrent.percentDone;
      const pct = Math.round(Math.min(1, Math.max(0, fraction || 0)) * 100);
      cell.append(el('div', {
        class: 'progress',
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': pct,
        'data-state': torrent.state,
      }, [
        el('span', { class: 'progress-bar', style: { '--pct': `${pct}%` } }),
        el('span', { class: 'progress-text', text: ctx.fmt.percent(fraction || 0) }),
      ]));
    } else {
      const text = column.text(torrent, ctx);
      cell.textContent = text;
      if (text === EMPTY) cell.setAttribute('data-empty', '');
    }
    return cell;
  }

  function renderRow(torrent, index) {
    const selected = selection().has(torrent.id);
    const checkbox = el('input', {
      type: 'checkbox',
      class: 'checkbox',
      tabindex: -1,
      checked: selected,
      'aria-label': t('main.table.selectRow', { name: torrent.name }),
    });
    const row = el('div', {
      class: ['torrents-row', selected && 'is-selected'],
      role: 'row',
      'aria-rowindex': index + 2,
      'aria-selected': selected ? 'true' : 'false',
      'data-id': torrent.id,
      'data-state': torrent.state,
      'data-focused': store.get().focused === torrent.id ? '' : null,
      tabindex: torrent.id === activeId ? 0 : -1,
      style: { top: `${index * rowHeight()}px` },
    }, [el('div', { role: 'gridcell', class: 'cell cell-check', 'data-col': 'check' }, checkbox)]);
    const cardOnly = layout === 'cards';
    for (const column of columns) {
      if (cardOnly && !CARD_COLUMNS.includes(column.id)) continue;
      row.append(renderCell(column, torrent));
    }
    if (cardOnly) {
      for (const id of CARD_COLUMNS) {
        if (!columns.some((c) => c.id === id)) row.append(renderCell(COLUMN_BY_ID.get(id), torrent));
      }
    }
    return row;
  }

  function windowBounds() {
    const height = rowHeight();
    const viewport = root.clientHeight || 0;
    const first = Math.max(0, Math.floor((root.scrollTop || 0) / height) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil(((root.scrollTop || 0) + viewport) / height) + OVERSCAN);
    return { first, last: Math.max(first, last) };
  }

  function renderWindow() {
    frame = 0;
    const { first, last } = windowBounds();
    const rendered = [];
    let activeRendered = false;
    for (let i = first; i < last; i += 1) {
      const row = renderRow(rows[i], i);
      if (rows[i].id === activeId) activeRendered = true;
      rendered.push(row);
    }
    if (!activeRendered && rendered.length > 0) rendered[0].setAttribute('tabindex', '0');
    body.style.setProperty('height', `${rows.length * rowHeight()}px`);
    grid.setAttribute('aria-rowcount', String(rows.length + 1));
    grid.setAttribute('tabindex', rows.length === 0 ? '0' : '-1');
    clear(body, ...rendered);
    const { torrents } = store.get();
    empty.hidden = rows.length > 0;
    empty.textContent = rows.length > 0 ? '' : t(torrents.size === 0 ? 'main.table.noTorrents' : 'main.table.noMatches');
  }

  function scheduleWindow() {
    if (frame) return;
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(renderWindow);
    else renderWindow();
  }

  /** Recompute the visible, sorted list from the store and publish `order`. */
  function recompute() {
    const state = store.get();
    columns = columnsFromPrefs(state.prefs);
    sort = sortFromPrefs(state.prefs);
    rows = sortTorrents(visibleTorrents(state.torrents, state.filter), sort);
    indexById = new Map(rows.map((r, i) => [r.id, i]));
    const order = rows.map((r) => r.id);
    const patch = {};
    if (!sameIds(order, state.order)) patch.order = order;
    const pruned = [...state.selection].filter((id) => state.torrents.has(id));
    if (pruned.length !== state.selection.size) patch.selection = new Set(pruned);
    if (state.focused != null && !state.torrents.has(state.focused)) patch.focused = null;
    if (activeId != null && !state.torrents.has(activeId)) activeId = null;
    if (anchorId != null && !state.torrents.has(anchorId)) anchorId = null;
    if (Object.keys(patch).length > 0) store.set(patch);
    renderHead();
    renderWindow();
  }

  // ---- selection ----------------------------------------------------------

  function setSelection(ids) {
    const next = new Set(ids);
    const current = selection();
    if (next.size === current.size && [...next].every((id) => current.has(id))) return;
    store.set({ selection: next });
  }

  function rangeIds(fromId, toId) {
    const a = indexById.get(fromId);
    const b = indexById.get(toId);
    if (a === undefined || b === undefined) return [toId];
    return rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id);
  }

  function select(id, { toggle = false, range = false, additive = false } = {}) {
    if (range && anchorId != null) {
      const picked = rangeIds(anchorId, id);
      setSelection(additive ? [...selection(), ...picked] : picked);
    } else if (toggle) {
      const next = new Set(selection());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchorId = id;
      setSelection(next);
    } else {
      anchorId = id;
      setSelection([id]);
    }
  }

  function ensureVisible(index) {
    const height = rowHeight();
    const top = index * height;
    const viewport = root.clientHeight || 0;
    if (top < root.scrollTop) root.scrollTop = top;
    else if (viewport > 0 && top + height > root.scrollTop + viewport) root.scrollTop = top + height - viewport;
  }

  function setActive(id, { focus = true } = {}) {
    if (!indexById.has(id)) return;
    activeId = id;
    ensureVisible(indexById.get(id));
    renderWindow();
    if (focus) {
      const row = body.querySelector(`[data-id="${id}"]`);
      if (row) row.focus();
    }
  }

  function rowIdFromEvent(e) {
    const row = e.target && typeof e.target.closest === 'function' ? e.target.closest('[role="row"]') : null;
    if (!row || row === head) return null;
    const id = Number.parseInt(row.getAttribute('data-id'), 10);
    return Number.isInteger(id) ? id : null;
  }

  function onClick(e) {
    const id = rowIdFromEvent(e);
    if (id === null) return;
    const onCheckbox = Boolean(e.target.closest('.cell-check'));
    const modifier = e.ctrlKey || e.metaKey;
    if (e.shiftKey) select(id, { range: true, additive: modifier });
    else if (onCheckbox || modifier) select(id, { toggle: true });
    else select(id);
    activeId = id;
    renderWindow();
  }

  /** Open the details drawer on a torrent; `focused` is set even before the drawer mounts. */
  function showDetails(id) {
    openDetails(id);
    if (store.get().focused !== id) store.set({ focused: id });
  }

  function onDoubleClick(e) {
    const id = rowIdFromEvent(e);
    if (id !== null) showDetails(id);
  }

  function requestRemove() {
    const ids = selection().size > 0 ? [...selection()] : activeId != null ? [activeId] : [];
    if (ids.length === 0) return;
    root.dispatchEvent(new CustomEvent(REMOVE_REQUEST, { bubbles: true, detail: { ids } }));
  }

  function moveActive(delta, extend) {
    if (rows.length === 0) return;
    const current = activeId != null && indexById.has(activeId) ? indexById.get(activeId) : -1;
    const next = Math.min(rows.length - 1, Math.max(0, current === -1 ? 0 : current + delta));
    const id = rows[next].id;
    if (extend) {
      if (anchorId == null) anchorId = activeId ?? id;
      setSelection(rangeIds(anchorId, id));
    }
    setActive(id);
  }

  function onKeyDown(e) {
    const modifier = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1, e.shiftKey);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1, e.shiftKey);
        break;
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault();
        const page = Math.max(1, Math.floor((root.clientHeight || 0) / rowHeight()) - 1);
        moveActive(e.key === 'PageDown' ? page : -page, e.shiftKey);
        break;
      }
      case 'Home':
        e.preventDefault();
        moveActive(-rows.length, e.shiftKey);
        break;
      case 'End':
        e.preventDefault();
        moveActive(rows.length, e.shiftKey);
        break;
      case ' ':
        if (activeId == null) return;
        e.preventDefault();
        select(activeId, { toggle: true });
        break;
      case 'Enter':
        if (activeId == null) return;
        e.preventDefault();
        showDetails(activeId);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        requestRemove();
        break;
      case 'Escape':
        if (selection().size === 0) return;
        e.preventDefault();
        setSelection([]);
        break;
      case 'a':
      case 'A':
        if (!modifier) return;
        e.preventDefault();
        setSelection(rows.map((r) => r.id));
        break;
      default:
    }
  }

  /** The row that takes focus when the grid itself receives it. */
  function onFocusIn(e) {
    const id = rowIdFromEvent(e);
    if (id !== null && id !== activeId) {
      activeId = id;
      renderWindow();
    }
  }

  // ---- layout -------------------------------------------------------------

  function setLayout(next) {
    if (next === layout) return;
    layout = next;
    grid.setAttribute('data-layout', layout);
    renderWindow();
  }

  let resize = null;
  if (typeof ResizeObserver === 'function') {
    resize = new ResizeObserver((entries) => {
      const width = entries.length ? entries[entries.length - 1].contentRect.width : root.clientWidth;
      setLayout(width <= CARD_MAX_WIDTH ? 'cards' : 'rows');
    });
    resize.observe(root);
  }

  grid.addEventListener('click', onClick);
  grid.addEventListener('dblclick', onDoubleClick);
  grid.addEventListener('keydown', onKeyDown);
  grid.addEventListener('focusin', onFocusIn);
  root.addEventListener('scroll', scheduleWindow);

  const offs = [
    store.subscribe('torrents', recompute),
    store.subscribe('filter', recompute),
    store.subscribe('prefs', recompute),
    store.subscribe('selection', () => {
      renderHead();
      renderWindow();
    }),
    store.subscribe('focused', renderWindow),
  ];
  recompute();

  return () => {
    for (const off of offs) off();
    grid.removeEventListener('click', onClick);
    grid.removeEventListener('dblclick', onDoubleClick);
    grid.removeEventListener('keydown', onKeyDown);
    grid.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('scroll', scheduleWindow);
    if (resize) resize.disconnect();
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  };
}
