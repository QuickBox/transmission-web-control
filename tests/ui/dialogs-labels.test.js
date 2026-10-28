import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

installDom();
const labelsDialog = await import('../../src/app/js/ui/dialogs/labels.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { getSession } = await import('../../src/app/js/rpc/session.js');
const { fetchTorrents } = await import('../../src/app/js/rpc/torrents.js');
const { memoryStorage, LOCAL_LABELS_KEY, LABELS_IMPORTED_KEY } = await import('../../src/app/js/rpc/labels.js');

test('nextLabels removes, then adds without duplicates', () => {
  assert.deepEqual(labelsDialog.nextLabels(['a', 'b'], new Set(['c', 'a']), new Set(['b'])), ['a', 'c']);
  assert.deepEqual(labelsDialog.nextLabels(undefined, new Set(['x']), new Set()), ['x']);
});

async function recorded(version, mutate) {
  const sets = [];
  const { transport, dialect } = recordedTransport(version, {
    'torrent-set': (body) => {
      sets.push(dialect === DIALECT.JSONRPC ? body.params : body.arguments);
      return okResponse(dialect, body);
    },
  });
  const client = createClient({ transport, dialect });
  const caps = buildCaps(await getSession(client), { dialect });
  let { torrents } = await fetchTorrents(client, caps, new Map());
  if (mutate) torrents = mutate(torrents);
  const made = await makeCtx();
  made.ctx.rpc = client;
  made.ctx.caps = caps;
  made.ctx.store.set({ torrents });
  return { ...made, sets, caps, torrents };
}

const boxes = (record) => record.opts.body.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'checkbox');
const box = (record, name) => boxes(record).find((b) => b.parentNode.textContent === name);

test('2.94: labels live in browser storage; only changed labels move, per torrent', async () => {
  const storage = memoryStorage();
  const env = await recorded('rpc-15');
  assert.equal(env.caps.nativeLabels, false);
  const ids = [...env.torrents.keys()].slice(0, 2);
  const [a, b] = ids.map((id) => env.torrents.get(id));
  storage.setItem(LOCAL_LABELS_KEY, JSON.stringify({ [a.hash.toLowerCase()]: ['tv', 'keep'], [b.hash.toLowerCase()]: ['tv'] }));
  labelsDialog.createLabelsDialog(env.ctx, { storage }).open(ids);
  const record = env.dialogs.at(-1);
  assert.match(record.opts.description, /saved in this browser only/);
  assert.equal(box(record, 'tv').checked, true);
  assert.equal(box(record, 'keep').indeterminate, true, 'only one of the two has it');
  box(record, 'tv').checked = false;
  box(record, 'tv').dispatch('change');
  record.opts.body.querySelectorAll('input').find((i) => i.getAttribute('type') !== 'checkbox').value = 'hd';
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(env.sets.length, 0, 'no torrent-set on 2.94');
  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_LABELS_KEY)), {
    [a.hash.toLowerCase()]: ['keep', 'hd'],
    [b.hash.toLowerCase()]: ['hd'],
  });
  assert.equal(record.closed, 'saved');
});

test('4.1.3 JSON-RPC: native labels write one torrent-set per resulting label set', async () => {
  const env = await recorded('rpc-41-jsonrpc', (map) => {
    const next = new Map();
    let i = 0;
    for (const [id, t] of map) next.set(id, { ...t, labels: i++ === 0 ? ['tv', 'keep'] : ['tv'] });
    return next;
  });
  assert.equal(env.caps.nativeLabels, true);
  const ids = [...env.torrents.keys()].slice(0, 2);
  labelsDialog.createLabelsDialog(env.ctx, { storage: memoryStorage() }).open(ids);
  const record = env.dialogs.at(-1);
  box(record, 'tv').checked = false;
  box(record, 'tv').dispatch('change');
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.deepEqual(env.sets, [{ ids: [ids[0]], labels: ['keep'] }, { ids: [ids[1]], labels: [] }]);
});

test('native daemon: the one-time import offer copies browser labels and keeps the local copy', async () => {
  const storage = memoryStorage();
  const env = await recorded('rpc-41-jsonrpc');
  const [first] = env.torrents.values();
  storage.setItem(LOCAL_LABELS_KEY, JSON.stringify({ [first.hash.toLowerCase()]: ['legacy'] }));
  labelsDialog.createLabelsDialog(env.ctx, { storage }).open([first.id]);
  const record = env.dialogs.at(-1);
  const offer = record.opts.body.querySelector('.label-import');
  assert.match(offer.textContent, /Labels for 1 torrent are saved in this browser/);
  offer.querySelector('button').dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.deepEqual(env.sets.at(-1).labels, [...first.labels, 'legacy'].filter((v, i, a) => a.indexOf(v) === i));
  assert.equal(storage.getItem(LABELS_IMPORTED_KEY), '1');
  assert.ok(storage.getItem(LOCAL_LABELS_KEY).includes('legacy'), 'browser copy kept');
  assert.equal(record.opts.body.querySelector('.label-import'), null);
  labelsDialog.createLabelsDialog(env.ctx, { storage }).open([first.id]);
  assert.equal(env.dialogs.at(-1).opts.body.querySelector('.label-import'), null, 'offered once');
});

test('no change closes without writing; label names render as text', async () => {
  const env = await recorded('rpc-41-jsonrpc', (map) => {
    const next = new Map();
    for (const [id, t] of map) next.set(id, { ...t, labels: ['<img src=x>'] });
    return next;
  });
  const [first] = env.torrents.values();
  labelsDialog.createLabelsDialog(env.ctx, { storage: memoryStorage() }).open([first.id]);
  const record = env.dialogs.at(-1);
  assert.equal(record.opts.body.querySelector('.label-name').textContent, '<img src=x>');
  record.opts.actions[1].dispatch('click');
  await flush();
  assert.equal(env.sets.length, 0);
  assert.equal(record.closed, 'cancel');
});
