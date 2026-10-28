import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, torrent, FakeElement } from './details-dom.js';

const env = installDom({ width: 1440 });

// The shim dispatches through `dispatch(type, init)`; the grid uses the DOM
// `dispatchEvent(new CustomEvent(...))` for its outbound event.
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

const {
  CARD_COLUMNS, COLUMNS, DEFAULT_COLUMNS, DEFAULT_SORT, REMOVE_REQUEST, ROW_HEIGHT,
  columnsFromPrefs, matchesFilter, mount, sortFromPrefs, sortTorrents, visibleTorrents,
} = await import('../../src/app/js/ui/table.js');

const STATES = ['downloading', 'seeding', 'stopped', 'finished', 'error', 'queued', 'checking'];

/** `n` store-shaped torrents with varied states and names. */
function torrents(n) {
  const map = new Map();
  for (let i = 1; i <= n; i += 1) {
    const state = STATES[i % STATES.length];
    map.set(i, torrent({
      id: i,
      hash: i.toString(16).padStart(40, '0'),
      name: `torrent-${String(n - i + 1).padStart(5, '0')}`,
      state,
      status: state === 'downloading' ? 4 : state === 'seeding' ? 6 : state === 'checking' ? 2 : state === 'queued' ? 3 : 0,
      error: state === 'error' ? 3 : 0,
      totalSize: i * 1000,
      rateDownload: state === 'downloading' ? i : 0,
      rateUpload: state === 'seeding' ? i : 0,
      eta: state === 'downloading' ? i * 10 : -1,
      seederCount: i % 3 === 0 ? null : i,
      queuePosition: i - 1,
      labels: i % 2 ? ['odd'] : ['even'],
      trackerHosts: [`t${i % 2}.invalid`],
      downloadDir: i % 2 ? '/a' : '/b',
      warning: i % 7 === 0 ? 'Could not connect to tracker' : '',
    }));
  }
  return map;
}

/** The shared ctx loads `core` and `details`; the table also needs `main`. */
async function tableCtx() {
  const made = await makeCtx();
  const { readFileSync } = await import('node:fs');
  const { loadTranslator } = await import('../../src/app/js/core/i18n.js');
  const load = async (lang, ns) => {
    try {
      return JSON.parse(readFileSync(new URL(`../../src/app/i18n/${lang}/${ns}.json`, import.meta.url), 'utf8'));
    } catch {
      return null;
    }
  };
  made.ctx.i18n = await loadTranslator({ lang: 'en', namespaces: ['core', 'main'], load });
  return made;
}

async function setup({ count = 20, height = 400, prefs = {}, filter } = {}) {
  const made = await tableCtx();
  const { ctx } = made;
  const root = new FakeElement('div');
  root.setAttribute('class', 'shell-table');
  root.clientHeight = height;
  env.body.replaceChildren(root);
  const seed = { torrents: torrents(count), prefs };
  if (filter) seed.filter = filter;
  ctx.store.set(seed);
  const teardown = mount(root, ctx);
  const grid = root.querySelector('[role="grid"]');
  return { ...made, ctx, root, grid, teardown };
}

const rowsOf = (root) => root.querySelectorAll('.torrents-row');
const idsOf = (root) => rowsOf(root).map((r) => Number(r.getAttribute('data-id')));
const rowFor = (root, id) => root.querySelector(`[data-id="${id}"]`);
const click = (node, init = {}) => node.dispatch('click', { ctrlKey: false, metaKey: false, shiftKey: false, ...init });
const key = (grid, k, init = {}) => grid.dispatch('keydown', { key: k, ctrlKey: false, metaKey: false, shiftKey: false, ...init });

test('column and sort prefs are validated against the catalogue', () => {
  assert.deepEqual(columnsFromPrefs({}).map((c) => c.id), DEFAULT_COLUMNS);
  assert.deepEqual(columnsFromPrefs({ columns: ['status', 'bogus', 'name', 'id'] }).map((c) => c.id), ['name', 'status', 'id']);
  assert.deepEqual(sortFromPrefs({}), DEFAULT_SORT);
  assert.deepEqual(sortFromPrefs({ sort: { key: 'name', dir: 'desc' } }), { key: 'name', dir: 'desc' });
  assert.deepEqual(sortFromPrefs({ sort: { key: 'nope', dir: 'desc' } }), DEFAULT_SORT);
  assert.deepEqual(sortFromPrefs({ sort: { key: 'name', dir: 'sideways' } }), { key: 'name', dir: 'asc' });
  for (const c of COLUMNS) assert.ok(c.id === 'name' || c.id === 'status' || c.id === 'percentDone' || typeof c.text === 'function', c.id);
  for (const id of CARD_COLUMNS) assert.ok(COLUMNS.some((c) => c.id === id), id);
});

test('sortTorrents: text, numeric, missing values last, ties on id, both directions', () => {
  const list = [...torrents(9).values()];
  const byName = sortTorrents(list, { key: 'name', dir: 'asc' }).map((t) => t.name);
  assert.deepEqual(byName, [...byName].sort());
  assert.deepEqual(sortTorrents(list, { key: 'name', dir: 'desc' }).map((t) => t.name), [...byName].reverse());
  assert.deepEqual(sortTorrents(list, { key: 'totalSize', dir: 'desc' }).map((t) => t.id), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const seeders = sortTorrents(list, { key: 'seederCount', dir: 'asc' });
  assert.deepEqual(seeders.slice(-3).map((t) => t.seederCount), [null, null, null], 'unknown counts sort last ascending');
  const seedersDesc = sortTorrents(list, { key: 'seederCount', dir: 'desc' });
  assert.deepEqual(seedersDesc.slice(-3).map((t) => t.seederCount), [null, null, null], 'and last descending');
  assert.equal(seedersDesc[0].seederCount, 8);
  const eta = sortTorrents(list, { key: 'eta', dir: 'asc' });
  assert.ok(eta.at(-1).eta < 0, 'eta -1 (none) sorts last');
  const status = sortTorrents(list, { key: 'status', dir: 'asc' }).map((t) => t.state);
  assert.deepEqual(status, [...status].sort((a, b) => ['stopped', 'queued', 'checking', 'downloading', 'seeding', 'finished', 'error'].indexOf(a) - ['stopped', 'queued', 'checking', 'downloading', 'seeding', 'finished', 'error'].indexOf(b)));
  assert.notEqual(sortTorrents(list, DEFAULT_SORT), list, 'returns a copy');
});

test('matchesFilter / visibleTorrents', () => {
  const map = torrents(14);
  assert.equal(visibleTorrents(map, { status: 'all' }).length, 14);
  assert.ok(visibleTorrents(map, { status: 'downloading' }).every((t) => t.state === 'downloading'));
  assert.ok(visibleTorrents(map, { status: 'stopped' }).every((t) => t.state === 'stopped' || t.state === 'finished'));
  assert.ok(visibleTorrents(map, { status: 'active' }).every((t) => t.rateDownload > 0 || t.rateUpload > 0));
  assert.deepEqual(visibleTorrents(map, { status: 'warning' }).map((t) => t.id), [7, 14]);
  assert.ok(visibleTorrents(map, { label: 'odd' }).every((t) => t.id % 2 === 1));
  assert.ok(visibleTorrents(map, { tracker: 't0.invalid' }).every((t) => t.id % 2 === 0));
  assert.deepEqual(visibleTorrents(map, { folder: '/b' }).length, 7);
  assert.deepEqual(visibleTorrents(map, { search: 'torrent-00001' }).map((t) => t.id), [14]);
  assert.deepEqual(visibleTorrents(map, { status: 'downloading', label: 'even', search: 'TORRENT' }).map((t) => t.id).sort((a, b) => a - b), [14]);
  assert.equal(matchesFilter(torrent({ labels: undefined, trackerHosts: undefined }), { label: 'x' }), false, 'missing arrays never throw');
  assert.equal(matchesFilter(torrent({ labels: undefined }), {}), true);
});

test('mount renders a grid with header, rows, aria row counts and publishes order', async () => {
  const { ctx, root, grid, teardown } = await setup({ count: 5, prefs: { sort: { key: 'name', dir: 'asc' } } });
  assert.equal(grid.getAttribute('role'), 'grid');
  assert.equal(grid.getAttribute('aria-multiselectable'), 'true');
  assert.equal(grid.getAttribute('aria-rowcount'), '6');
  const headers = root.querySelectorAll('[role="columnheader"]');
  assert.equal(headers.length, DEFAULT_COLUMNS.length + 1);
  assert.equal(headers[1].getAttribute('data-col'), 'name');
  assert.equal(headers[1].getAttribute('aria-sort'), 'ascending');
  assert.equal(headers[2].getAttribute('aria-sort'), 'none');
  assert.ok(grid.styles.get('--cols').startsWith('44px minmax(180px, 1fr)'));
  const rows = rowsOf(root);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-rowindex')), ['2', '3', '4', '5', '6']);
  assert.deepEqual(idsOf(root), [5, 4, 3, 2, 1], 'name ascending = reverse id (names count down)');
  assert.deepEqual(ctx.store.get().order, [5, 4, 3, 2, 1]);
  assert.equal(rows[0].styles.get('top'), '0px');
  assert.equal(rows[1].styles.get('top'), `${ROW_HEIGHT.comfortable}px`);
  assert.equal(root.querySelector('.torrents-body').styles.get('height'), `${5 * ROW_HEIGHT.comfortable}px`);
  const status = rows[0].querySelector('.status');
  assert.equal(status.getAttribute('data-state'), ctx.store.get().torrents.get(5).state);
  assert.equal(status.textContent, 'Queued');
  const bar = rows[0].querySelector('.progress');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '50');
  assert.equal(rows[0].querySelector('.progress-bar').styles.get('--pct'), '50%');
  const hostile = '<img src=x onerror=alert(1)>';
  ctx.store.set({ torrents: new Map([[1, torrent({ id: 1, name: hostile })]]) });
  assert.equal(rowFor(root, 1).querySelector('.cell-name-text').textContent, hostile);
  assert.equal(rowFor(root, 1).querySelector('.cell-name-text').children.length, 1, 'name is one text node');
  assert.equal(rowFor(root, 1).querySelector('.cell-name-text').getAttribute('title'), null, 'no native title');
  assert.equal(rowFor(root, 1).querySelector('.cell-name').children.length, 1, 'the name cell holds the text span (no glyph without a warning)');
  teardown();
});

test('header click sorts and toggles direction through prefs', async () => {
  const { ctx, root, teardown } = await setup({ count: 4 });
  const nameButton = root.querySelectorAll('[role="columnheader"]')[1].querySelector('button');
  click(nameButton);
  assert.deepEqual(ctx.store.get().prefs.sort, { key: 'name', dir: 'asc' });
  assert.deepEqual(idsOf(root), [4, 3, 2, 1]);
  click(root.querySelectorAll('[role="columnheader"]')[1].querySelector('button'));
  assert.deepEqual(ctx.store.get().prefs.sort, { key: 'name', dir: 'desc' });
  assert.deepEqual(idsOf(root), [1, 2, 3, 4]);
  assert.equal(root.querySelectorAll('[role="columnheader"]')[1].getAttribute('aria-sort'), 'descending');
  teardown();
});

test('selection: click, modifier toggle, shift range, header select-all, pruning', async () => {
  const { ctx, root, teardown } = await setup({ count: 8 });
  const sel = () => [...ctx.store.get().selection].sort((a, b) => a - b);
  click(rowFor(root, 2));
  assert.deepEqual(sel(), [2]);
  assert.equal(rowFor(root, 2).getAttribute('aria-selected'), 'true');
  assert.ok(rowFor(root, 2).classList.contains('is-selected'));
  click(rowFor(root, 5), { ctrlKey: true });
  assert.deepEqual(sel(), [2, 5]);
  click(rowFor(root, 5), { metaKey: true });
  assert.deepEqual(sel(), [2], 'modifier click toggles off and moves the anchor');
  click(rowFor(root, 6), { shiftKey: true });
  assert.deepEqual(sel(), [5, 6], 'shift selects the range from the last anchor');
  click(rowFor(root, 8), { shiftKey: true, ctrlKey: true });
  assert.deepEqual(sel(), [5, 6, 7, 8], 'shift+modifier adds the range');
  click(rowFor(root, 1).querySelector('.checkbox'));
  assert.deepEqual(sel(), [1, 5, 6, 7, 8], 'checkbox click toggles without clearing');
  let selectAll = root.querySelector('.torrents-head').querySelector('.checkbox');
  assert.equal(selectAll.checked, false);
  assert.equal(selectAll.indeterminate, true, 'a partial selection shows as indeterminate');
  click(rowFor(root, 2), { shiftKey: true });
  assert.deepEqual(sel(), [1, 2], 'shift range from the checkbox anchor replaces');
  click(rowFor(root, 4));
  assert.deepEqual(sel(), [4]);
  selectAll = root.querySelector('.torrents-head').querySelector('.checkbox');
  assert.equal(selectAll.indeterminate, true);
  root.querySelector('.torrents-head').querySelector('.checkbox').dispatch('change');
  assert.deepEqual(sel(), [1, 2, 3, 4, 5, 6, 7, 8], 'header checkbox selects every visible row');
  root.querySelector('.torrents-head').querySelector('.checkbox').dispatch('change');
  assert.deepEqual(sel(), [], 'and clears when all were selected');
  ctx.store.set({ selection: new Set([1, 2, 3]) });
  const next = new Map(ctx.store.get().torrents);
  next.delete(2);
  ctx.store.set({ torrents: next, focused: 2 });
  assert.deepEqual(sel(), [1, 3], 'a removed torrent leaves the selection');
  assert.equal(ctx.store.get().focused, null, 'and the details focus');
  teardown();
});

test('keyboard: roving tabindex, arrows, Home/End, Space, Enter, Delete, Ctrl+A, Escape', async () => {
  const { ctx, root, grid, teardown } = await setup({ count: 12, height: 200 });
  const removed = [];
  root.addEventListener(REMOVE_REQUEST, (e) => removed.push(e.detail.ids));
  assert.equal(rowsOf(root).filter((r) => r.getAttribute('tabindex') === '0').length, 1, 'exactly one row is tabbable');
  key(grid, 'ArrowDown');
  assert.equal(rowFor(root, 1).getAttribute('tabindex'), '0');
  assert.equal(globalThis.document.activeElement, rowFor(root, 1));
  key(grid, 'ArrowDown');
  key(grid, 'ArrowDown');
  assert.equal(rowFor(root, 3).getAttribute('tabindex'), '0');
  assert.equal(rowFor(root, 1).getAttribute('tabindex'), '-1');
  key(grid, ' ');
  assert.deepEqual([...ctx.store.get().selection], [3]);
  key(grid, 'ArrowDown', { shiftKey: true });
  key(grid, 'ArrowDown', { shiftKey: true });
  assert.deepEqual([...ctx.store.get().selection].sort((a, b) => a - b), [3, 4, 5], 'shift+arrow extends from the anchor');
  key(grid, 'Enter');
  assert.equal(ctx.store.get().focused, 5);
  assert.ok(rowFor(root, 5).hasAttribute('data-focused'));
  key(grid, 'End');
  assert.equal(rowFor(root, 12).getAttribute('tabindex'), '0');
  assert.ok(root.scrollTop > 0, 'End scrolls the virtual window down');
  key(grid, 'Home');
  assert.equal(root.scrollTop, 0);
  assert.equal(rowFor(root, 1).getAttribute('tabindex'), '0');
  key(grid, 'a', { ctrlKey: true });
  assert.equal(ctx.store.get().selection.size, 12);
  key(grid, 'Delete');
  assert.equal(removed.length, 1);
  assert.deepEqual([...removed[0]].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  key(grid, 'Escape');
  assert.equal(ctx.store.get().selection.size, 0);
  key(grid, 'Delete');
  assert.deepEqual(removed[1], [1], 'with nothing selected the active row is the target');
  teardown();
});

test('virtual window: 5,000 rows render only the visible slice and keep aria indexes', async () => {
  const { ctx, root, grid, teardown } = await setup({ count: 5000, height: 400, prefs: { sort: { key: 'id', dir: 'asc' } } });
  const h = ROW_HEIGHT.comfortable;
  assert.equal(grid.getAttribute('aria-rowcount'), '5001');
  assert.equal(root.querySelector('.torrents-body').styles.get('height'), `${5000 * h}px`);
  let rows = rowsOf(root);
  assert.ok(rows.length >= 10 && rows.length <= 10 + 6, `top window renders ${rows.length} rows`);
  assert.equal(rows[0].getAttribute('aria-rowindex'), '2');
  assert.equal(rows[0].getAttribute('data-id'), '1');

  root.scrollTop = 2500 * h;
  root.dispatch('scroll');
  rows = rowsOf(root);
  assert.ok(rows.length >= 10 && rows.length <= 10 + 12, `mid window renders ${rows.length} rows`);
  const first = Number(rows[0].getAttribute('data-id'));
  const last = Number(rows.at(-1).getAttribute('data-id'));
  assert.ok(first >= 2500 - 6 + 1 && first <= 2501, `window starts near 2500 (got ${first})`);
  assert.ok(last >= 2510 && last <= 2510 + 6 + 1, `window ends near 2510 (got ${last})`);
  assert.equal(rows[0].getAttribute('aria-rowindex'), String(first + 1));
  assert.equal(rows[0].styles.get('top'), `${(first - 1) * h}px`);

  root.scrollTop = 5000 * h;
  root.dispatch('scroll');
  rows = rowsOf(root);
  assert.equal(Number(rows.at(-1).getAttribute('data-id')), 5000, 'bottom window ends on the last row');
  assert.ok(rows.length <= 12, 'no rows past the end');

  ctx.store.set({ prefs: { sort: { key: 'id', dir: 'asc' }, density: 'compact' } });
  assert.equal(root.querySelector('.torrents-body').styles.get('height'), `${5000 * ROW_HEIGHT.compact}px`, 'compact rows re-measure');
  teardown();
});

/** A poll: a new object for every torrent that changed, the same object for the rest. */
function poll(ctx, changed) {
  const next = new Map(ctx.store.get().torrents);
  for (const id of changed) next.set(id, { ...next.get(id), rateDownload: 1000 + (next.get(id).rateDownload || 0) });
  ctx.store.set({ torrents: next });
}

test('row nodes survive a poll, so a click straddling it still lands on the row', async () => {
  const { ctx, root, teardown } = await setup({ count: 8 });
  const held = rowFor(root, 3);
  const heldCheck = held.querySelector('.cell-check');
  const heldName = held.querySelector('.cell-name');
  poll(ctx, [3, 4]);
  assert.equal(rowFor(root, 3), held, 'the row element is the same node');
  assert.equal(held.parentNode !== null && root.contains(held), true, 'and still attached');
  assert.equal(held.querySelector('.cell-check'), heldCheck, 'the checkbox cell is kept');
  assert.notEqual(held.querySelector('.cell-name'), heldName, 'data cells of a changed torrent are rebuilt');
  assert.match(held.querySelector('.cell-rateDownload').textContent, /B\/s/, 'and show the new value');
  click(held);
  assert.deepEqual([...ctx.store.get().selection], [3]);
  assert.equal(held.getAttribute('aria-selected'), 'true');
  teardown();
});

test('a poll leaves untouched rows and the body children alone', async () => {
  const { ctx, root, teardown } = await setup({ count: 8 });
  const before = rowsOf(root);
  const cells = before.map((r) => r.children.slice());
  const body = root.querySelector('.torrents-body');
  let replaced = 0;
  const original = body.replaceChildren.bind(body);
  body.replaceChildren = (...nodes) => { replaced += 1; return original(...nodes); };
  poll(ctx, [2]);
  assert.equal(replaced, 0, 'the window kept its membership and order');
  assert.deepEqual(rowsOf(root), before, 'same nodes in the same order');
  before.forEach((row, i) => {
    if (Number(row.getAttribute('data-id')) === 2) return;
    assert.deepEqual(row.children, cells[i], `row ${row.getAttribute('data-id')} kept every cell`);
  });
  teardown();
});

test('the header is not rebuilt by a poll', async () => {
  const { ctx, root, teardown } = await setup({ count: 8 });
  const head = root.querySelector('.torrents-head');
  const button = head.querySelector('button');
  poll(ctx, [1]);
  assert.equal(head.querySelector('button'), button);
  click(button);
  assert.equal(ctx.store.get().prefs.sort.key, 'name');
  teardown();
});

test('a plain click selects and shows the details; checkbox, modifier and shift clicks only select', async () => {
  const { ctx, root, teardown } = await setup({ count: 8 });
  assert.equal(ctx.store.get().focused, null);
  click(rowFor(root, 2), { ctrlKey: true });
  click(rowFor(root, 3).querySelector('.checkbox'));
  click(rowFor(root, 4), { shiftKey: true });
  assert.equal(ctx.store.get().focused, null, 'selection-only clicks leave the details alone');
  click(rowFor(root, 5));
  assert.deepEqual([...ctx.store.get().selection], [5]);
  assert.equal(ctx.store.get().focused, 5, 'a plain click shows the torrent');
  assert.equal(rowFor(root, 5).hasAttribute('data-focused'), true);
  teardown();
});

test('the status column is sized for the longest state label of the active language', async () => {
  const { grid, teardown } = await setup({ count: 3 });
  const widths = grid.styles.get('--cols').split(' ');
  const status = widths.find((w) => /^\d+px$/.test(w) && Number.parseInt(w, 10) >= 128);
  assert.ok(status, grid.styles.get('--cols'));
  assert.ok(Number.parseInt(status, 10) >= 128 && Number.parseInt(status, 10) < 184, 'English fits the floor, not the German width');
  teardown();
});

test('an idle rate shows a muted dash and a live rate shows its speed', async () => {
  const made = await tableCtx();
  const root = new FakeElement('div');
  root.clientHeight = 300;
  env.body.replaceChildren(root);
  const idle = { id: 1, name: 'idle', state: 'stopped', status: 0, error: 0, rateDownload: 0, rateUpload: 0 };
  const busy = { id: 2, name: 'busy', state: 'downloading', status: 4, error: 0, rateDownload: 2048, rateUpload: 0 };
  made.ctx.store.set({ torrents: new Map([[1, idle], [2, busy]]), prefs: { columns: COLUMNS.map((c) => c.id) } });
  const teardown = mount(root, made.ctx);
  const idleDown = rowFor(root, 1).querySelector('.cell-rateDownload');
  assert.equal(idleDown.textContent, '—');
  assert.equal(idleDown.hasAttribute('data-empty'), true, 'the dash is flagged so CSS can mute it');
  assert.equal(rowFor(root, 1).querySelector('.cell-rateUpload').textContent, '—');
  const busyDown = rowFor(root, 2).querySelector('.cell-rateDownload');
  assert.match(busyDown.textContent, /KB\/s|kB\/s/);
  assert.equal(busyDown.hasAttribute('data-empty'), false);
  assert.equal(rowFor(root, 2).querySelector('.cell-rateUpload').hasAttribute('data-empty'), true);
  teardown();
});

test('a row missing optional fields renders without throwing', async () => {
  const made = await tableCtx();
  const root = new FakeElement('div');
  root.clientHeight = 300;
  env.body.replaceChildren(root);
  const bare = { id: 9, name: 'bare', state: 'stopped', status: 0, error: 0 };
  made.ctx.store.set({ torrents: new Map([[9, bare]]), prefs: { columns: COLUMNS.map((c) => c.id) } });
  const teardown = mount(root, made.ctx);
  const row = rowFor(root, 9);
  assert.ok(row, 'row rendered');
  assert.equal(row.querySelectorAll('[role="gridcell"]').length, COLUMNS.length + 1);
  assert.equal(row.querySelector('.cell-seederCount').textContent, '—');
  assert.equal(row.querySelector('.cell-labels').textContent, '—', 'no labels shows the dash');
  assert.equal(row.querySelector('.cell-trackers').textContent, '—');
  assert.equal(row.querySelector('.cell-downloadDir').textContent, '—');
  assert.equal(row.querySelector('.cell-labels').hasAttribute('data-empty'), true);
  assert.equal(row.querySelector('.cell-eta').textContent, '—');
  assert.equal(row.querySelector('.progress').getAttribute('aria-valuenow'), '0');
  assert.equal(root.querySelector('.torrents-empty').hidden, true);
  made.ctx.store.set({ filter: { status: 'seeding', label: null, tracker: null, folder: null, search: '' } });
  assert.equal(rowsOf(root).length, 0);
  assert.equal(root.querySelector('.torrents-empty').hidden, false);
  assert.match(root.querySelector('.torrents-empty').textContent, /match/);
  made.ctx.store.set({ torrents: new Map(), connection: { state: 'online', error: null, since: 1 } });
  assert.match(root.querySelector('.torrents-empty').textContent, /No torrents yet/, 'an online daemon with no torrents');
  assert.equal(root.querySelector('[role="grid"]').getAttribute('tabindex'), '0', 'an empty grid is itself tabbable');
  teardown();
});

test('teardown unsubscribes from the store', async () => {
  const { ctx, root, teardown } = await setup({ count: 2 });
  teardown();
  ctx.store.set({ torrents: torrents(6) });
  assert.equal(rowsOf(root).length, 2, 'no re-render after teardown');
});

test('an empty list names the connection state until a poll has succeeded', async () => {
  const made = await tableCtx();
  const root = new FakeElement('div');
  root.clientHeight = 300;
  env.body.replaceChildren(root);
  // Boot while the daemon is unreachable: the store has no torrents and the poller reported offline.
  made.ctx.store.set({ connection: { state: 'offline', error: 'HTTP 500', since: 1 } });
  const teardown = mount(root, made.ctx);
  const empty = root.querySelector('.torrents-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Cannot reach Transmission/, 'offline boot tells the truth');
  assert.doesNotMatch(empty.textContent, /No torrents/);
  assert.equal(empty.getAttribute('data-state'), 'offline');
  made.ctx.store.set({ connection: { state: 'unauthorized', error: 'HTTP 401', since: 2 } });
  assert.match(empty.textContent, /refused the login/);
  made.ctx.store.set({ connection: { state: 'connecting', error: null, since: 0 } });
  assert.match(empty.textContent, /Connecting/);
  // The daemon answers with no torrents: now "no torrents" is a fact.
  made.ctx.store.set({ connection: { state: 'online', error: null, since: 3 } });
  assert.match(empty.textContent, /No torrents yet/);
  assert.equal(empty.getAttribute('data-state'), null);
  // Torrents exist but the filter hides them: the filter message, whatever the connection.
  made.ctx.store.set({ torrents: new Map([[1, torrent({ id: 1, state: 'seeding' })]]), filter: { status: 'error', label: null, tracker: null, folder: null, search: '' } });
  assert.match(empty.textContent, /match/);
  made.ctx.store.set({ connection: { state: 'offline', error: 'x', since: 4 } });
  assert.match(empty.textContent, /match/, 'a loaded list keeps the filter message when the daemon drops');
  teardown();
});
