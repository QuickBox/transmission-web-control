import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, FakeElement } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

const env = installDom();
const add = await import('../../src/app/js/ui/dialogs/add.js');
const dialogs = await import('../../src/app/js/ui/dialogs/index.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { getSession } = await import('../../src/app/js/rpc/session.js');
const { memoryStorage, LOCAL_LABELS_KEY } = await import('../../src/app/js/rpc/labels.js');

const fakeFile = (name, text = 'd8:announce0:e', type = '') => ({
  name, type, size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

test('links: magnets, URLs and bare info hashes; anything else is rejected', () => {
  const hash = 'a'.repeat(40);
  assert.deepEqual(add.parseLinks(`magnet:?xt=urn:btih:${hash}\n\n  ${hash}  \nmagnet:?xt=urn:btih:${hash}`).links,
    [`magnet:?xt=urn:btih:${hash}`]);
  assert.deepEqual(add.parseLinks('udp://host.invalid/a.torrent').links, ['udp://host.invalid/a.torrent']);
  assert.equal(add.parseLinks('hello world').invalid, 'hello world');
  assert.deepEqual(add.parseLabels(' tv, hd ,tv,, '), ['tv', 'hd']);
  assert.equal(add.isTorrentFile({ name: 'x.TORRENT' }), true);
  assert.equal(add.isTorrentFile({ name: 'x.txt', type: 'application/x-bittorrent' }), true);
  assert.equal(add.isTorrentFile({ name: 'x.txt' }), false);
});

test('metainfo is the base64 of the file bytes', async () => {
  assert.equal(await add.fileToBase64(fakeFile('a.torrent', 'hello')), Buffer.from('hello').toString('base64'));
});

async function recorded(version, onAdd) {
  const adds = [];
  const sets = [];
  const { transport, dialect } = recordedTransport(version, {
    'torrent-add': (body) => {
      const args = dialect === DIALECT.JSONRPC ? body.params : body.arguments;
      adds.push(args);
      return okResponse(dialect, body, onAdd(args, adds.length, dialect));
    },
    'torrent-set': (body) => {
      sets.push(dialect === DIALECT.JSONRPC ? body.params : body.arguments);
      return okResponse(dialect, body);
    },
  });
  const client = createClient({ transport, dialect });
  const session = await getSession(client);
  const caps = buildCaps(session, { dialect });
  const made = await makeCtx();
  made.ctx.rpc = client;
  made.ctx.caps = caps;
  made.ctx.store.set({ session });
  return { ...made, adds, sets, caps, session, dialect };
}

const added = (key) => (args, n) => ({ [key]: { id: 100 + n, hashString: `${'b'.repeat(39)}${n}`, name: `t${n}` } });

test('2.94: files and links are added paused as asked, labels go to browser storage', async () => {
  const env1 = await recorded('rpc-15', added('torrent-added'));
  assert.equal(env1.caps.nativeLabels, false);
  const storage = memoryStorage();
  const dlg = add.createAddDialog(env1.ctx, { storage });
  dlg.open({ files: [fakeFile('ubuntu.torrent'), fakeFile('notes.txt')] });
  const record = env1.dialogs.at(-1);
  assert.equal(record.opts.title, 'Add torrents');
  assert.match(env1.toasts.at(-1).message, /Only \.torrent files/);
  const body = record.opts.body;
  assert.equal(body.querySelectorAll('.file-chip').length, 1);
  const [links, dir, labels] = [body.querySelector('textarea'), body.querySelectorAll('input')[1], body.querySelectorAll('input')[2]];
  assert.equal(dir.value, env1.session.downloadDir);
  await flush(); await flush(); await flush();
  assert.match(body.querySelector('.field-help').textContent, /free/);
  links.value = `magnet:?xt=urn:btih:${'c'.repeat(40)}`;
  labels.value = 'tv, hd';
  body.querySelector('[role="switch"]').dispatch('click');
  const submit = record.opts.actions[1];
  submit.dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.equal(env1.adds.length, 2);
  assert.equal(env1.adds[0].metainfo, Buffer.from('d8:announce0:e').toString('base64'));
  assert.equal(env1.adds[0]['download-dir'], env1.session.downloadDir);
  assert.equal(env1.adds[0].paused, env1.session.startAddedTorrents !== false);
  assert.equal(env1.adds[1].filename, `magnet:?xt=urn:btih:${'c'.repeat(40)}`);
  assert.equal(env1.sets.length, 0, 'no native labels on 2.94');
  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_LABELS_KEY)), {
    [`${'b'.repeat(39)}1`]: ['tv', 'hd'], [`${'b'.repeat(39)}2`]: ['tv', 'hd'],
  });
  assert.equal(record.closed, 'added');
  assert.equal(env1.toasts.at(-1).message, 'Added 2 torrents');
});

test('4.1.3 JSON-RPC: labels follow as one torrent-set labels', async () => {
  const env2 = await recorded('rpc-41-jsonrpc', added('torrent_added'));
  assert.equal(env2.caps.nativeLabels, true);
  const dlg = add.createAddDialog(env2.ctx, { storage: memoryStorage() });
  dlg.open({ links: [`magnet:?xt=urn:btih:${'d'.repeat(40)}`] });
  const record = env2.dialogs.at(-1);
  record.opts.body.querySelectorAll('input')[2].value = 'linux';
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.equal(env2.adds.length, 1);
  assert.equal(env2.adds[0].filename, `magnet:?xt=urn:btih:${'d'.repeat(40)}`);
  assert.deepEqual(env2.sets, [{ ids: [101], labels: ['linux'] }]);
});

test('duplicates close with a notice; total failure keeps the dialog open with the reason', async () => {
  const dup = await recorded('rpc-15', () => ({ 'torrent-duplicate': { id: 1, hashString: 'e'.repeat(40), name: 'x' } }));
  add.createAddDialog(dup.ctx, { storage: memoryStorage() }).open({ files: [fakeFile('a.torrent')] });
  dup.dialogs.at(-1).opts.actions[1].dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.equal(dup.dialogs.at(-1).closed, 'added');
  assert.match(dup.toasts.at(-1).message, /already in the list/);

  const bad = await recorded('rpc-15', () => ({}));
  bad.ctx.rpc.call = (method, args) => (method === 'torrent-add' ? Promise.reject(new Error('invalid or corrupt torrent file')) : Promise.resolve({ path: args.path, sizeBytes: 1 }));
  add.createAddDialog(bad.ctx, { storage: memoryStorage() }).open({ files: [fakeFile('<b>x</b>.torrent')] });
  const record = bad.dialogs.at(-1);
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.equal(record.closed, null);
  assert.equal(record.opts.body.querySelector('.field-error').textContent, 'Could not add <b>x</b>.torrent: invalid or corrupt torrent file');
  assert.equal(record.opts.actions[1].disabled, false);
});

test('an invalid link is flagged before anything is sent; Add stays disabled when empty', async () => {
  const { ctx, calls, dialogs: opened } = await makeCtx();
  add.createAddDialog(ctx, { storage: memoryStorage() }).open();
  const record = opened.at(-1);
  const submit = record.opts.actions[1];
  assert.equal(submit.disabled, true);
  const links = record.opts.body.querySelector('textarea');
  links.value = 'not a link';
  links.dispatch('input');
  assert.equal(submit.disabled, false);
  submit.dispatch('click');
  await flush();
  assert.equal(links.getAttribute('aria-invalid'), 'true');
  assert.equal(calls.filter((c) => c.method === 'torrent-add').length, 0);
});

test('the drop overlay shows on a file drag and a drop opens Add with the files', async () => {
  const { ctx, dialogs: opened } = await makeCtx();
  const app = new FakeElement('div');
  app.setAttribute('id', 'app');
  const region = new FakeElement('div');
  app.append(region);
  env.body.replaceChildren(app);
  const teardown = dialogs.mount(region, ctx);
  const overlay = region.querySelector('.drop-overlay');
  assert.equal(overlay.hidden, true);
  const transfer = { types: ['Files'], files: [fakeFile('a.torrent')] };
  env.doc.dispatch('dragenter', { dataTransfer: transfer });
  assert.equal(overlay.hidden, false);
  env.doc.dispatch('dragenter', { dataTransfer: transfer });
  env.doc.dispatch('dragleave', { dataTransfer: transfer });
  assert.equal(overlay.hidden, false, 'nested enter/leave keeps it up');
  const drop = env.doc.dispatch('drop', { dataTransfer: transfer });
  assert.equal(drop.defaultPrevented, true);
  assert.equal(overlay.hidden, true);
  assert.equal(opened.at(-1).opts.title, 'Add torrents');
  assert.equal(opened.at(-1).opts.body.querySelectorAll('.file-chip').length, 1);
  env.doc.dispatch('drop', { dataTransfer: { types: ['Files'], files: [fakeFile('b.torrent')] } });
  assert.equal(opened.length, 1, 'a second drop joins the open dialog');
  assert.equal(opened.at(-1).opts.body.querySelectorAll('.file-chip').length, 2);
  env.doc.dispatch('dragenter', { dataTransfer: { types: ['text/plain'] } });
  assert.equal(overlay.hidden, true, 'text drags are ignored');
  teardown();
});
