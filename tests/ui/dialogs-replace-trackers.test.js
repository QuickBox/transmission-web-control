import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

installDom();
const replace = await import('../../src/app/js/ui/dialogs/replace-trackers.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { getSession } = await import('../../src/app/js/rpc/session.js');
const { fetchTorrents } = await import('../../src/app/js/rpc/torrents.js');

const tr = (announce, tier = 0) => ({ announce, tier });

test('the plan swaps in place, keeps tiers, and never duplicates', () => {
  const torrents = [
    { id: 1, trackers: [tr('udp://a.invalid/x'), tr('udp://b.invalid/x', 1)] },
    { id: 2, trackers: [tr('udp://c.invalid/x')] },
    { id: 3, trackers: [tr('udp://a.invalid/x'), tr('udp://n.invalid/x')] },
  ];
  assert.deepEqual(replace.planReplace(torrents, 'udp://a.invalid/x', 'udp://n.invalid/x'), [
    { id: 1, tiers: [['udp://n.invalid/x'], ['udp://b.invalid/x']] },
    { id: 3, tiers: [['udp://n.invalid/x']] },
  ]);
  assert.deepEqual(replace.announceUrls(torrents), ['udp://a.invalid/x', 'udp://b.invalid/x', 'udp://c.invalid/x', 'udp://n.invalid/x']);
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
  made.ctx.store.set({ torrents });
  return { ...made, sets, caps, torrents };
}

for (const version of ['rpc-15', 'rpc-41-jsonrpc']) {
  test(`${version}: replacing an announce URL across the selection goes through setTrackers`, async () => {
    const env = await recorded(version);
    const t1 = env.torrents.get(1);
    const old = t1.trackers[1].announce;
    replace.createReplaceTrackersDialog(env.ctx).open([1]);
    const record = env.dialogs.at(-1);
    const [find, withField] = record.opts.body.querySelectorAll('input');
    find.value = old;
    find.dispatch('input');
    assert.match(record.opts.body.textContent, /1 torrent uses it/);
    withField.value = 'https://replacement.invalid/announce';
    record.opts.actions[1].dispatch('click');
    for (let i = 0; i < 10; i += 1) await flush();
    if (env.caps.trackerList) {
      const key = 'tracker_list';
      assert.equal(env.sets.length, 1);
      assert.ok(env.sets[0][key].includes('https://replacement.invalid/announce'));
      assert.ok(!env.sets[0][key].includes(old));
    } else {
      assert.deepEqual(env.sets, [{ ids: [1], trackerReplace: [t1.trackers[1].id, 'https://replacement.invalid/announce'] }]);
    }
    assert.equal(record.closed, 'saved');
    assert.equal(env.toasts.at(-1).message, 'Updated 1 torrent');
  });
}

test('bad, identical or unused URLs are refused before any write', async () => {
  const env = await recorded('rpc-15');
  replace.createReplaceTrackersDialog(env.ctx).open([1]);
  const record = env.dialogs.at(-1);
  const [find, withField] = record.opts.body.querySelectorAll('input');
  const click = async () => { record.opts.actions[1].dispatch('click'); for (let i = 0; i < 4; i += 1) await flush(); };
  find.value = 'nope';
  withField.value = 'udp://x.invalid/a';
  await click();
  assert.equal(find.getAttribute('aria-invalid'), 'true');
  find.value = 'udp://x.invalid/a';
  await click();
  assert.match(record.opts.body.textContent, /are the same/);
  find.value = 'udp://unused.invalid/a';
  await click();
  assert.match(record.opts.body.textContent, /No torrent in scope uses this URL/);
  assert.equal(env.sets.length, 0);
});
