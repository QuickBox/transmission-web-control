import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

const env = installDom();
const trackersTab = await import('../../src/app/js/ui/details/trackers.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { getSession } = await import('../../src/app/js/rpc/session.js');
const { fetchTorrents } = await import('../../src/app/js/rpc/torrents.js');
const { formatTrackerList, tiersFromTrackers } = await import('../../src/app/js/rpc/trackers.js');

const ok = { loading: false, error: null };

test('announce URL checks and health', () => {
  assert.equal(trackersTab.isAnnounceUrl('udp://tracker.invalid:6969/announce'), true);
  assert.equal(trackersTab.isAnnounceUrl('tracker.invalid/announce'), false);
  assert.equal(trackersTab.invalidLine('udp://a.invalid/x\n\nnot a url'), 'not a url');
  assert.equal(trackersTab.invalidLine('udp://a.invalid/x\n\nhttps://b.invalid/y'), null);
  assert.equal(trackersTab.trackerHealth({ lastAnnounceSucceeded: true, lastAnnounceTime: 5 }), 'ok');
  assert.equal(trackersTab.trackerHealth({ lastAnnounceSucceeded: false, lastAnnounceTime: 5 }), 'warning');
  assert.equal(trackersTab.trackerHealth({ lastAnnounceSucceeded: false, lastAnnounceTime: 0 }), 'pending');
});

function tracker(over) {
  return {
    id: 0, tier: 0, host: 'tracker.invalid', announce: 'udp://tracker.invalid:6969/announce', scrape: '',
    announceState: 0, lastAnnounceSucceeded: true, lastAnnounceResult: 'Success', lastAnnounceTime: 1_700_000_000,
    nextAnnounceTime: 0, seederCount: 12, leecherCount: null, downloaderCount: null, downloadCount: -1, ...over,
  };
}

test('rows show tiers, an em dash for unknown counts, and the warning glyph with the message as text', async () => {
  const { ctx } = await makeCtx();
  const view = trackersTab.create(ctx);
  view.render(torrent({
    trackers: [
      tracker({ id: 1 }),
      tracker({ id: 2, tier: 1, host: 'b.invalid', announce: 'https://b.invalid/announce',
        lastAnnounceSucceeded: false, lastAnnounceResult: '<b>Connection refused</b>' }),
    ],
  }), null, ok);
  const rows = view.root.querySelectorAll('.tracker');
  assert.equal(rows.length, 2);
  assert.equal(view.root.querySelectorAll('.tracker-tier').length, 2);
  assert.match(view.root.querySelector('.trackers-summary').textContent, /2 trackers in 2 tiers/);
  assert.match(rows[0].textContent, /Seeders 12.*Leechers —.*Downloads —/);
  assert.ok(rows[1].classList.contains('is-warning'));
  assert.equal(rows[1].querySelector('svg').getAttribute('aria-label'), 'Last announce failed');
  assert.match(rows[1].querySelector('.tracker-last').textContent, /<b>Connection refused<\/b>$/);
});

async function recorded(version) {
  const sets = [];
  const { transport, dialect } = recordedTransport(version, {
    'torrent-set': (body) => {
      sets.push(dialect === DIALECT.JSONRPC ? body.params : body.arguments);
      return okResponse(dialect, body);
    },
  });
  const client = createClient({ transport, dialect });
  const caps = buildCaps(await getSession(client), { dialect });
  const { torrents } = await fetchTorrents(client, caps, new Map());
  const made = await makeCtx();
  made.ctx.rpc = client;
  made.ctx.caps = caps;
  return { ...made, sets, caps, dialect, torrents };
}

test('2.94 (rows): Edit replaces one tracker through trackerReplace', async () => {
  const { ctx, sets, caps, torrents, dialogs, toasts } = await recorded('rpc-15');
  assert.equal(caps.trackerList, false);
  const t1 = torrents.get(1);
  assert.ok(t1 && t1.trackers.length === 2, 'recorded torrent 1 has two trackers');
  const view = trackersTab.create(ctx);
  env.body.replaceChildren(view.root);
  view.render(t1, null, ok);
  assert.equal(view.root.querySelector('.trackers-actions').querySelector('button').textContent, 'Add tracker');
  const second = t1.trackers[1];
  const edit = view.root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === `Edit ${second.host}`);
  edit.dispatch('click');
  const dialog = dialogs.at(-1);
  const input = dialog.opts.body.querySelector('input');
  assert.equal(input.value, second.announce);
  input.value = 'not a url';
  dialog.opts.actions[1].dispatch('click');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(sets.length, 0);
  input.value = 'https://replacement.invalid/announce';
  dialog.opts.actions[1].dispatch('click');
  await flush(); await flush(); await flush();
  assert.deepEqual(sets, [{ ids: [1], trackerReplace: [second.id, 'https://replacement.invalid/announce'] }]);
  assert.equal(dialog.closed, 'saved');
  assert.equal(toasts.at(-1).message, 'Trackers saved');
});

test('2.94 (rows): Add puts a new tier, Remove confirms first', async () => {
  const { ctx, sets, torrents, dialogs } = await recorded('rpc-15');
  let answer = false;
  ctx.ui.confirm = (opts) => { assert.equal(opts.destructive, true); return Promise.resolve(answer); };
  const view = trackersTab.create(ctx);
  env.body.replaceChildren(view.root);
  view.render(torrents.get(1), null, ok);
  view.root.querySelector('.trackers-actions').querySelector('button').dispatch('click');
  const add = dialogs.at(-1);
  add.opts.body.querySelector('input').value = 'udp://added.invalid:6969/announce';
  add.opts.actions[1].dispatch('click');
  await flush(); await flush(); await flush();
  assert.deepEqual(sets.at(-1), { ids: [1], trackerAdd: ['udp://added.invalid:6969/announce'] });
  const first = torrents.get(1).trackers[0];
  const remove = view.root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === `Remove ${first.host}`);
  remove.dispatch('click');
  await flush();
  assert.equal(sets.length, 1, 'declined: nothing sent');
  answer = true;
  remove.dispatch('click');
  await flush(); await flush(); await flush();
  assert.deepEqual(sets.at(-1), { ids: [1], trackerRemove: [first.id] });
});

test('4.1.3 (JSON-RPC): one tiered editor writes tracker_list', async () => {
  const { ctx, sets, caps, torrents, dialogs } = await recorded('rpc-41-jsonrpc');
  assert.equal(caps.trackerList, true);
  const t1 = torrents.get(1);
  const view = trackersTab.create(ctx);
  env.body.replaceChildren(view.root);
  view.render(t1, null, ok);
  assert.equal(view.root.querySelectorAll('.tracker-actions').length, 0, 'no per-row editing on list daemons');
  view.root.querySelector('.trackers-actions').querySelector('button').dispatch('click');
  const dialog = dialogs.at(-1);
  const area = dialog.opts.body.querySelector('textarea');
  assert.equal(area.value, formatTrackerList(tiersFromTrackers(t1.trackers)));
  area.value = `${t1.trackers[0].announce}\n\nudp://added.invalid:6969/announce`;
  dialog.opts.actions[1].dispatch('click');
  await flush(); await flush(); await flush();
  assert.deepEqual(sets, [{ ids: [1], tracker_list: `${t1.trackers[0].announce}\n\nudp://added.invalid:6969/announce` }]);
  assert.equal(dialog.closed, 'saved');
});

test('a re-render keeps keyboard focus on the same row action', async () => {
  const { ctx } = await makeCtx();
  const view = trackersTab.create(ctx);
  env.body.replaceChildren(view.root);
  const tor = torrent({ trackers: [tracker({ id: 1 })] });
  view.render(tor, null, ok);
  view.root.querySelectorAll('button').find((b) => /^Remove/.test(b.getAttribute('aria-label') || '')).focus();
  view.render({ ...tor, trackers: [tracker({ id: 1, seederCount: 13 })] }, null, ok);
  assert.match(env.doc.activeElement.getAttribute('aria-label'), /^Remove tracker\.invalid/);
  assert.ok(view.root.contains(env.doc.activeElement));
});
