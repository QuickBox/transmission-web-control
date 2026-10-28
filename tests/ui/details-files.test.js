import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent } from './details-dom.js';

const env = installDom();
const files = await import('../../src/app/js/ui/details/files.js');
const { buildFileTree, visibleRows, windowRange, fileIcon, ROW_HEIGHT } = files;

const sample = {
  files: [
    { name: 'Show/S01/e01.mkv', length: 100, bytesCompleted: 100 },
    { name: 'Show/S01/e02.mkv', length: 100, bytesCompleted: 50 },
    { name: 'Show/info.nfo', length: 10, bytesCompleted: 10 },
    { name: 'Show/S02/e01.mkv', length: 100, bytesCompleted: 0 },
  ],
  fileStats: [
    { wanted: true, priority: 0, bytesCompleted: 100 },
    { wanted: true, priority: 1, bytesCompleted: 50 },
    { wanted: true, priority: 0, bytesCompleted: 10 },
    { wanted: false, priority: 0, bytesCompleted: 0 },
  ],
};

test('the tree groups paths into folders, folders first, with aggregates', () => {
  const { roots, count } = buildFileTree(sample.files, sample.fileStats);
  assert.equal(count, 4);
  assert.equal(roots.length, 1);
  const show = roots[0];
  assert.equal(show.name, 'Show');
  assert.deepEqual(show.children.map((c) => c.name), ['S01', 'S02', 'info.nfo']);
  assert.equal(show.size, 310);
  assert.equal(show.done, 160);
  assert.equal(show.wanted, 'mixed');
  assert.equal(show.priority, 'mixed');
  const s01 = show.children[0];
  assert.equal(s01.wanted, true);
  assert.equal(s01.priority, 'mixed');
  assert.deepEqual(s01.indices.sort(), [0, 1]);
  assert.equal(show.children[1].wanted, false);
  assert.equal(s01.children[0].key, 'Show/S01/e01.mkv');
});

test('wanted comes from fileStats only; without fileStats it is unknown', () => {
  const top = buildFileTree([{ name: 'a.iso', length: 5, wanted: false }], undefined);
  assert.equal(top.roots[0].wanted, null);
  assert.equal(top.roots[0].priority, null);
  const missingRow = buildFileTree(sample.files, [sample.fileStats[0]]);
  assert.equal(missingRow.roots[0].wanted, null, 'a folder with an unknown child is unknown');
});

test('a single-file torrent is one root row; garbage entries do not throw', () => {
  const single = buildFileTree([{ name: 'disc.iso', length: 9 }], [{ wanted: true, priority: -1 }]);
  assert.equal(single.roots.length, 1);
  assert.equal(single.roots[0].isDir, false);
  assert.equal(single.roots[0].priority, -1);
  assert.doesNotThrow(() => buildFileTree([null, {}, { name: '' }], null));
  assert.equal(buildFileTree(undefined, undefined).count, 0);
});

test('visible rows follow expansion, with set sizes and positions', () => {
  const { roots } = buildFileTree(sample.files, sample.fileStats);
  assert.equal(visibleRows(roots, new Set()).length, 1);
  const rows = visibleRows(roots, new Set(['Show', 'Show/S01']));
  assert.deepEqual(rows.map((r) => r.node.name), ['Show', 'S01', 'e01.mkv', 'e02.mkv', 'S02', 'info.nfo']);
  assert.deepEqual([rows[4].posinset, rows[4].setsize], [2, 3]);
});

test('window range covers the viewport plus overscan, clamped', () => {
  assert.deepEqual(windowRange(0, 320, 32, 5000), { start: 0, end: 18 });
  assert.deepEqual(windowRange(3200, 320, 32, 5000), { start: 92, end: 118 });
  assert.deepEqual(windowRange(999999, 320, 32, 20), { start: 2, end: 20 }, 'scrolled past the end shows the last page');
  assert.deepEqual(windowRange(0, 0, 32, 0), { start: 0, end: 0 });
});

test('file icons follow the extension', () => {
  assert.equal(fileIcon('a.MKV'), 'file-video');
  assert.equal(fileIcon('b.flac'), 'file-audio');
  assert.equal(fileIcon('c.part01.rar'), 'file-archive');
  assert.equal(fileIcon('readme'), 'file-generic');
});

async function view(detail, opts = {}) {
  const made = await makeCtx(opts);
  const refreshes = [];
  const host = { refresh: () => refreshes.push(1), torrentId: () => 1 };
  const tab = files.create(made.ctx, host);
  env.body.replaceChildren(tab.root);
  const list = tab.root.querySelector('[role="tree"]');
  list.clientHeight = 320;
  tab.render(torrent(), detail, { loading: false, error: null });
  return { ...made, tab, list, refreshes };
}

const rowsOf = (list) => list.querySelectorAll('[role="treeitem"]');

test('5,000 files: builds fast and renders only the rows in view', async () => {
  const big = { files: [], fileStats: [] };
  for (let i = 0; i < 5000; i += 1) {
    big.files.push({ name: `Pack/disc${Math.floor(i / 500)}/track${String(i).padStart(4, '0')}.flac`, length: 1000 + i });
    big.fileStats.push({ wanted: i % 7 !== 0, priority: 0, bytesCompleted: i % 3 ? 1000 : 0 });
  }
  const started = performance.now();
  const tree = buildFileTree(big.files, big.fileStats);
  const all = visibleRows(tree.roots, new Set(['Pack', ...Array.from({ length: 10 }, (_, d) => `Pack/disc${d}`)]));
  const elapsed = performance.now() - started;
  assert.equal(all.length, 5011);
  assert.ok(elapsed < 500, `build + flatten took ${elapsed.toFixed(1)} ms`);

  const { tab, list } = await view(big);
  assert.match(tab.root.querySelector('.files-summary').textContent, /5,000 files, 4,285 to download/);
  assert.equal(rowsOf(list).length, 11, 'root and its ten folders');
  const disc0 = rowsOf(list).find((r) => r.textContent.startsWith('disc0'));
  disc0.dispatch('click', { target: disc0.querySelector('[data-action="toggle-open"]') });
  const spacer = list.querySelector('.files-spacer');
  assert.equal(spacer.styles.get('height'), `${511 * ROW_HEIGHT}px`);
  assert.ok(rowsOf(list).length <= 30, `rendered ${rowsOf(list).length} rows`);
  list.scrollTop = 300 * ROW_HEIGHT;
  list.dispatch('scroll');
  const indices = rowsOf(list).map((r) => Number(r.getAttribute('data-index')));
  assert.ok(indices.includes(300) && rowsOf(list).length <= 31);
  assert.equal(rowsOf(list).find((r) => r.getAttribute('data-index') === '300').styles.get('top'), `${300 * ROW_HEIGHT}px`);
});

test('rows carry tree semantics and untrusted names as text', async () => {
  const hostile = { files: [{ name: 'x/<b onmouseover=alert(1)>.mkv', length: 1 }], fileStats: [{ wanted: true, priority: 0 }] };
  const { tab, list } = await view(hostile);
  assert.equal(tab.root.querySelector('.files-summary').textContent, '1 file', 'no download split when every file is wanted');
  const [folder, file] = rowsOf(list);
  assert.equal(folder.getAttribute('aria-expanded'), 'true');
  assert.equal(folder.getAttribute('aria-level'), '1');
  assert.equal(file.getAttribute('aria-level'), '2');
  assert.equal(file.getAttribute('aria-checked'), 'true');
  assert.equal(file.querySelector('.file-name').textContent, '<b onmouseover=alert(1)>.mkv');
  assert.equal(rowsOf(list).filter((r) => r.getAttribute('tabindex') === '0').length, 1);
});

test('toggling download sends files-unwanted with every index under a folder', async () => {
  const { list, calls, refreshes } = await view(sample);
  const s01 = rowsOf(list).find((r) => r.textContent.startsWith('S01'));
  s01.dispatch('click', { target: s01.querySelector('[data-action="toggle-wanted"]') });
  await flush();
  assert.deepEqual(calls.at(-1), { method: 'torrent-set', args: { ids: [1], 'files-unwanted': [0, 1] } });
  assert.equal(refreshes.length, 1);
});

test('keyboard: Space toggles, arrows move and expand, Left returns to the parent', async () => {
  const { list, calls } = await view(sample);
  const focused = () => rowsOf(list).find((r) => r.getAttribute('tabindex') === '0');
  list.dispatch('keydown', { key: 'ArrowDown' });
  assert.match(focused().textContent, /^S01/);
  list.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(focused().getAttribute('aria-expanded'), 'true');
  list.dispatch('keydown', { key: 'ArrowRight' });
  assert.match(focused().textContent, /^e01\.mkv/);
  list.dispatch('keydown', { key: ' ' });
  await flush();
  assert.deepEqual(calls.at(-1).args, { ids: [1], 'files-unwanted': [0] });
  list.dispatch('keydown', { key: 'ArrowLeft' });
  assert.match(focused().textContent, /^S01/);
  list.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(focused().getAttribute('aria-expanded'), 'false');
  list.dispatch('keydown', { key: 'End' });
  assert.match(focused().textContent, /^info\.nfo/);
});

test('the row menu sets priority with the legacy key, and offers rename', async () => {
  const { list, menus, calls } = await view(sample);
  const s01 = rowsOf(list).find((r) => r.textContent.startsWith('S01'));
  s01.dispatch('click', { target: s01.querySelector('[data-action="menu"]') });
  const { items } = menus.at(-1);
  const priority = items.find((i) => i.items);
  assert.deepEqual(priority.items.map((i) => [i.label, i.checked]), [['High', false], ['Normal', false], ['Low', false]]);
  priority.items[0].onSelect();
  await flush();
  assert.deepEqual(calls.at(-1), { method: 'torrent-set', args: { ids: [1], 'priority-high': [0, 1] } });
  assert.ok(items.some((i) => i.label === 'Rename…'));
  const { ICON_NAMES } = await import('../../src/app/js/core/icons.js');
  const named = items.flatMap((i) => (i.items ? i.items : [i])).filter((i) => i && i.icon);
  assert.ok(named.length > 0);
  for (const item of named) assert.ok(ICON_NAMES.includes(item.icon), `menu icon ${item.icon} exists`);
});

test('without fileStats there is no download toggle and Space sends nothing', async () => {
  const { list, menus, calls } = await view({ files: sample.files });
  const root = rowsOf(list)[0];
  assert.equal(root.hasAttribute('aria-checked'), false);
  list.dispatch('keydown', { key: ' ' });
  list.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(menus.at(-1).items.map((i) => i.label), ['Rename…']);
});

test('rename validates the name, then calls torrent-rename-path with the full path', async () => {
  const { list, dialogs, calls, refreshes } = await view(sample);
  list.dispatch('keydown', { key: 'F2' });
  const dialog = dialogs.at(-1);
  assert.equal(dialog.opts.title, 'Rename folder');
  assert.equal(dialog.opts.description, 'Show');
  const form = dialog.opts.body;
  const input = form.querySelector('input');
  assert.equal(input.value, 'Show');
  input.value = 'bad/name';
  form.dispatch('submit');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(calls.length, 0);
  input.value = '  Show (2024)  ';
  form.dispatch('submit');
  await flush();
  assert.deepEqual(calls.at(-1), { method: 'torrent-rename-path', args: { ids: [1], path: 'Show', name: 'Show (2024)' } });
  assert.equal(dialog.closed, 'saved');
  assert.equal(refreshes.length, 1);
});

test('a missing file list or a load error shows a message instead of rows', async () => {
  const made = await makeCtx();
  const tab = files.create(made.ctx, { refresh() {}, torrentId: () => 1 });
  tab.render(torrent(), null, { loading: true, error: null });
  assert.match(tab.root.textContent, /Loading/);
  tab.render(torrent(), {}, { loading: false, error: null });
  assert.match(tab.root.textContent, /no file list/);
  tab.render(torrent(), null, { loading: false, error: 'timeout' });
  assert.match(tab.root.textContent, /Could not load details: timeout/);
});
