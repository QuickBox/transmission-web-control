import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, shell, flush, torrent } from './chrome-dom.js';
import { makeTransport, okResponse } from '../fixtures/load.js';

// A write to an idle torrent must reach the store and the sidebar at once: the
// daemon's `recently-active` delta never reports idle torrents, so the poll
// alone would leave labels and trackers stale until a reload.

const env = installChromeDom();
const { createClient } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { createPoller } = await import('../../src/app/js/rpc/poller.js');
const { createStore } = await import('../../src/app/js/core/store.js');
const { loadTranslator } = await import('../../src/app/js/core/i18n.js');
const { bindFormat } = await import('../../src/app/js/core/format.js');
const { el, svg, clear } = await import('../../src/app/js/core/dom.js');
const { icon } = await import('../../src/app/js/core/icons.js');
const { memoryStorage } = await import('../../src/app/js/rpc/labels.js');
const sidebar = await import('../../src/app/js/ui/sidebar.js');
const labelsDialog = await import('../../src/app/js/ui/dialogs/labels.js');
const trackersTab = await import('../../src/app/js/ui/details/trackers.js');

const SESSION = 'testSessionId0123456789abcdefghijklmnopqrs';
const T1 = 'https://a.invalid/announce';
const T2 = 'https://b.invalid/announce';

/** A fake 4.0.6 daemon: two idle torrents; `recently-active` reports nothing. */
function daemon() {
  const rows = new Map([
    [1, { id: 1, hashString: '1'.repeat(40), name: 'idle-one', status: 0, labels: ['tv'], trackerStats: [{ id: 10, tier: 0, announce: T1, lastAnnounceSucceeded: true }], trackers: [{ id: 10, tier: 0, announce: T1 }] }],
    [2, { id: 2, hashString: '2'.repeat(40), name: 'idle-two', status: 0, labels: ['tv', 'keep'], trackerStats: [{ id: 20, tier: 0, announce: T1, lastAnnounceSucceeded: true }], trackers: [{ id: 20, tier: 0, announce: T1 }] }],
  ]);
  const gets = [];
  const sets = [];
  const transport = makeTransport({ sessionId: SESSION, rpcVersionHeader: null }, {
    'torrent-get': (body) => {
      const args = body.arguments;
      gets.push(args);
      if (args.ids === 'recently-active') return okResponse('legacy', body, { torrents: [], removed: [] });
      const ids = Array.isArray(args.ids) ? args.ids : [...rows.keys()];
      return okResponse('legacy', body, { torrents: ids.map((id) => rows.get(id)).filter(Boolean) });
    },
    'torrent-set': (body) => {
      const args = body.arguments;
      sets.push(args);
      for (const id of args.ids) {
        const row = rows.get(id);
        if (args.labels) row.labels = [...args.labels];
        if (typeof args.trackerList === 'string') {
          const urls = args.trackerList.split('\n').filter(Boolean);
          row.trackerStats = urls.map((announce, i) => ({ id: 100 + i, tier: 0, announce, lastAnnounceSucceeded: true }));
          row.trackers = urls.map((announce, i) => ({ id: 100 + i, tier: 0, announce }));
        }
      }
      return okResponse('legacy', body, {});
    },
    'session-get': (body) => okResponse('legacy', body, { 'rpc-version': 17, 'rpc-version-semver': '5.3.0', version: '4.0.6 (test)', 'download-dir': '/d' }),
    'session-stats': (body) => okResponse('legacy', body, { torrentCount: 2 }),
  });
  return { rows, gets, sets, transport };
}

async function setup() {
  const { readFileSync } = await import('node:fs');
  const load = async (lang, ns) => {
    try {
      return JSON.parse(readFileSync(new URL(`../../src/app/i18n/${lang}/${ns}.json`, import.meta.url), 'utf8'));
    } catch {
      return null;
    }
  };
  const t = await loadTranslator({ lang: 'en', namespaces: ['core', 'main', 'details', 'dialogs'], load });
  const d = daemon();
  const client = createClient({ transport: d.transport });
  const caps = buildCaps({ rpcVersion: 17, rpcVersionSemver: '5.3.0' }, { dialect: 'legacy' });
  const store = createStore();
  const timers = { setTimeout: () => 1, clearTimeout() {} };
  const poller = createPoller({ client, caps, store, timers });
  const dialogs = [];
  const toasts = [];
  const ui = {
    el, svg, clear, icon,
    tooltip: () => () => {},
    toast: (message, opts) => toasts.push({ message, opts }),
    menu: () => ({ close() {} }),
    openDialog: (opts) => {
      const record = { opts, closed: null, close(reason) { record.closed = reason || 'close'; } };
      dialogs.push(record);
      return { root: el('div'), body: el('div'), close: record.close };
    },
    confirm: () => Promise.resolve(true),
  };
  const ctx = { rpc: client, caps, store, i18n: t, fmt: bindFormat({ locale: 'en' }), ui, poller };
  await poller.start();
  const { regions } = shell(env);
  const teardown = sidebar.mount(regions.sidebar, ctx, { storage: memoryStorage() });
  return { ...d, ctx, store, poller, dialogs, toasts, root: regions.sidebar, teardown };
}

const labelItems = (root) => root.querySelector('[data-section="labels"]').querySelectorAll('.nav-item').map((b) => `${b.querySelector('.nav-label').textContent}:${b.querySelector('.nav-count').textContent}`);
const trackerItems = (root) => root.querySelector('[data-section="trackers"]').querySelectorAll('.nav-item').map((b) => `${b.querySelector('.nav-label').textContent}:${b.querySelector('.nav-count').textContent}`);
const settle = async () => { for (let i = 0; i < 8; i += 1) await flush(); };

test('a label written on an idle torrent shows in the store and the sidebar without a poll tick', async () => {
  const { ctx, store, root, dialogs, sets, gets, toasts, teardown } = await setup();
  assert.deepEqual(labelItems(root), ['keep:1', 'tv:2']);
  const before = store.get().torrents.get(1);
  const pollsBefore = gets.filter((a) => a.ids === 'recently-active').length;

  labelsDialog.createLabelsDialog(ctx, { storage: memoryStorage() }).open([1]);
  const record = dialogs.at(-1);
  const keep = record.opts.body.querySelectorAll('input').find((i) => i.getAttribute('type') === 'checkbox' && i.parentNode.textContent === 'keep');
  assert.ok(keep, 'the keep label is offered');
  keep.checked = true;
  keep.dispatch('change');
  record.opts.actions[1].dispatch('click');
  await settle();

  assert.deepEqual(sets, [{ ids: [1], labels: ['tv', 'keep'] }]);
  assert.equal(record.closed, 'saved');
  assert.equal(toasts.at(-1).message, 'Labels saved');
  const after = store.get().torrents.get(1);
  assert.notEqual(after, before, 'the store row is a new object');
  assert.deepEqual(after.labels, ['tv', 'keep'], 'the store shows the written labels');
  assert.deepEqual(labelItems(root), ['keep:2', 'tv:2'], 'the sidebar count moved');
  assert.equal(gets.filter((a) => a.ids === 'recently-active').length, pollsBefore, 'no poll tick was needed');
  assert.ok(gets.some((a) => Array.isArray(a.ids) && a.ids.length === 1 && a.ids[0] === 1 && a.fields.includes('labels')), 'the written id was re-read with the full field set');
  teardown();
});

test('a tracker edited on an idle torrent shows in the store and the sidebar without a poll tick', async () => {
  const { ctx, store, root, dialogs, sets, gets, toasts, teardown } = await setup();
  assert.deepEqual(trackerItems(root), ['a.invalid:2']);
  const view = trackersTab.create(ctx);
  env.body.append(view.root);
  view.render(store.get().torrents.get(1), null, { loading: false, error: null });
  const editButton = view.root.querySelectorAll('button').find((b) => b.textContent === 'Edit trackers' || b.getAttribute('aria-label') === 'Edit trackers');
  assert.ok(editButton, 'the trackerList edit control is present on a 4.0.6 daemon');
  editButton.dispatch('click');
  const dialog = dialogs.at(-1);
  const area = dialog.opts.body.querySelector('textarea') || dialog.opts.body.querySelector('input');
  area.value = T2;
  dialog.opts.actions[1].dispatch('click');
  await settle();

  assert.ok(sets.some((a) => typeof a.trackerList === 'string' && a.trackerList.includes(T2)), 'trackerList written on 4.0.6');
  assert.equal(toasts.at(-1).message, 'Trackers saved');
  const row = store.get().torrents.get(1);
  assert.deepEqual(row.trackerHosts, ['b.invalid'], 'the store shows the new tracker');
  assert.deepEqual(trackerItems(root), ['a.invalid:1', 'b.invalid:1'], 'the sidebar reflects the change');
  assert.equal(gets.filter((a) => a.ids === 'recently-active').length, 0, 'no poll tick');
  teardown();
});
