import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, chromeCtx, shell, click, torrent } from './chrome-dom.js';

const env = installChromeDom();
const { STATUS_ITEMS, folderName, labelCounts, mount } = await import('../../src/app/js/ui/sidebar.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { memoryStorage, LOCAL_LABELS_KEY } = await import('../../src/app/js/rpc/labels.js');

function torrents() {
  return new Map([
    [1, torrent({ id: 1, hash: '1'.repeat(40), state: 'downloading', rateDownload: 5, labels: ['linux'], trackerHosts: ['a.invalid'], downloadDir: '/data/iso' })],
    [2, torrent({ id: 2, hash: '2'.repeat(40), state: 'seeding', rateDownload: 0, rateUpload: 3, labels: ['linux', 'video'], trackerHosts: ['a.invalid', 'b.invalid'], downloadDir: '/data/iso' })],
    [3, torrent({ id: 3, hash: '3'.repeat(40), state: 'stopped', rateDownload: 0, labels: [], trackerHosts: ['b.invalid'], downloadDir: '/data/video/' })],
    [4, torrent({ id: 4, hash: '4'.repeat(40), state: 'finished', rateDownload: 0, labels: [], trackerHosts: [], downloadDir: '/data/video/', warning: 'tracker down' })],
    [5, torrent({ id: 5, hash: '5'.repeat(40), state: 'error', error: 3, rateDownload: 0, labels: ['video'], trackerHosts: ['b.invalid'], downloadDir: '/data/iso' })],
  ]);
}

async function setup(opts = {}) {
  const made = await chromeCtx(opts);
  const { app, regions } = shell(env);
  made.ctx.store.set({ torrents: torrents() });
  const teardown = mount(regions.sidebar, made.ctx, { storage: opts.storage || memoryStorage() });
  return { ...made, app, root: regions.sidebar, teardown };
}

const section = (root, id) => root.querySelector(`[data-section="${id}"]`);
const items = (root, id) => section(root, id).querySelectorAll('.nav-item');
const labelOf = (item) => item.querySelector('.nav-label').textContent;
const countOf = (item) => item.querySelector('.nav-count').textContent;
const find = (root, id, label) => items(root, id).find((i) => labelOf(i) === label);

test('folderName and labelCounts', () => {
  assert.equal(folderName('/data/iso'), 'iso');
  assert.equal(folderName('/data/video/'), 'video');
  assert.equal(folderName('/'), '/');
  assert.equal(folderName('C:\\downloads\\tv'), 'tv');
  const labels = { read: (t) => t.labels };
  assert.deepEqual([...labelCounts(torrents(), labels).entries()], [['linux', 2], ['video', 2]]);
});

test('renders four sections with status counts in sidebar order', async () => {
  const { root, teardown } = await setup();
  assert.deepEqual(root.querySelectorAll('.nav-section').map((s) => s.getAttribute('data-section')), ['status', 'labels', 'trackers', 'folders']);
  assert.equal(root.getAttribute('id'), 'sidebar');
  const status = items(root, 'status');
  assert.deepEqual(status.map(labelOf), ['All', 'Active', 'Downloading', 'Seeding', 'Paused', 'Checking', 'Queued', 'Error', 'Warning']);
  assert.deepEqual(status.map(countOf), ['5', '2', '1', '1', '2', '0', '0', '1', '1']);
  assert.equal(STATUS_ITEMS.length, 9);
  assert.equal(status[0].getAttribute('aria-current'), 'true', 'All is active by default');
  assert.ok(status[0].classList.contains('is-active'));
  assert.deepEqual(items(root, 'labels').map((i) => `${labelOf(i)}:${countOf(i)}`), ['linux:2', 'video:2']);
  assert.deepEqual(items(root, 'trackers').map((i) => `${labelOf(i)}:${countOf(i)}`), ['a.invalid:2', 'b.invalid:3']);
  assert.deepEqual(items(root, 'folders').map((i) => `${labelOf(i)}:${countOf(i)}`), ['iso:3', 'video:2']);
  for (const b of root.querySelectorAll('button')) assert.equal(b.getAttribute('title'), null);
  teardown();
});

test('clicking filters writes the store, toggles facets, and closes the drawer', async () => {
  const { ctx, app, root, teardown } = await setup();
  app.setAttribute('data-sidebar-open', '');
  click(find(root, 'status', 'Paused'));
  assert.equal(ctx.store.get().filter.status, 'stopped');
  assert.equal(app.hasAttribute('data-sidebar-open'), false, 'picking a filter closes the drawer');
  assert.equal(find(root, 'status', 'Paused').getAttribute('aria-current'), 'true');
  assert.equal(find(root, 'status', 'All').getAttribute('aria-current'), null);

  click(find(root, 'labels', 'video'));
  assert.equal(ctx.store.get().filter.label, 'video');
  click(find(root, 'labels', 'video'));
  assert.equal(ctx.store.get().filter.label, null, 'second click clears the facet');
  click(find(root, 'trackers', 'b.invalid'));
  assert.equal(ctx.store.get().filter.tracker, 'b.invalid');
  click(find(root, 'folders', 'video'));
  assert.equal(ctx.store.get().filter.folder, '/data/video/', 'folders filter on the full path');
  assert.equal(ctx.store.get().filter.status, 'stopped', 'facets compose with status');
  click(find(root, 'status', 'Warning'));
  assert.equal(ctx.store.get().filter.status, 'warning');
  teardown();
});

test('the rail toggle persists in prefs and marks the shell', async () => {
  const { ctx, app, root, teardown } = await setup();
  const toggle = root.querySelector('.nav-rail-toggle');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse sidebar');
  click(toggle);
  assert.equal(ctx.store.get().prefs.sidebarRail, true);
  assert.equal(app.getAttribute('data-sidebar'), 'rail');
  assert.equal(root.querySelector('.nav-rail-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('.nav-rail-toggle').getAttribute('aria-label'), 'Expand sidebar');
  click(root.querySelector('.nav-rail-toggle'));
  assert.equal(ctx.store.get().prefs.sidebarRail, false);
  assert.equal(app.hasAttribute('data-sidebar'), false);
  teardown();
});

test('2.94: labels come from browser storage, and empty sections show their empty text', async () => {
  const storage = memoryStorage({ [LOCAL_LABELS_KEY]: JSON.stringify({ ['1'.repeat(40)]: ['local-a'], ['3'.repeat(40)]: ['local-a', 'local-b'] }) });
  const caps = buildCaps({ rpcVersion: 15 }, { dialect: 'legacy' });
  const { ctx, root, teardown } = await setup({ caps, storage });
  assert.deepEqual(items(root, 'labels').map((i) => `${labelOf(i)}:${countOf(i)}`), ['local-a:2', 'local-b:1'], 'native labels ignored on 2.94');
  ctx.store.set({ torrents: new Map() });
  assert.equal(items(root, 'labels').length, 0);
  assert.equal(section(root, 'labels').querySelector('.nav-empty').textContent, 'No labels yet');
  assert.equal(section(root, 'trackers').querySelector('.nav-empty').textContent, 'No trackers');
  assert.deepEqual(items(root, 'status').map(countOf), ['0', '0', '0', '0', '0', '0', '0', '0', '0']);
  teardown();
});

test('teardown stops re-rendering', async () => {
  const { ctx, root, teardown } = await setup();
  teardown();
  ctx.store.set({ torrents: new Map() });
  assert.equal(items(root, 'status')[0].querySelector('.nav-count').textContent, '5');
});
