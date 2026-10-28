import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

installDom();
const location = await import('../../src/app/js/ui/dialogs/location.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');

async function setup(version) {
  const made = await makeCtx();
  const moves = [];
  if (version) {
    const { transport, dialect } = recordedTransport(version, {
      'torrent-set-location': (body) => {
        moves.push(dialect === DIALECT.JSONRPC ? body.params : body.arguments);
        return okResponse(dialect, body);
      },
    });
    made.ctx.rpc = createClient({ transport, dialect });
  }
  made.ctx.store.set({
    torrents: new Map([
      [1, torrent({ id: 1, downloadDir: '/home/u/a' })],
      [2, torrent({ id: 2, downloadDir: '/home/u/b' })],
    ]),
  });
  return { ...made, moves };
}

test('one torrent: its folder is prefilled, free space is read, and move is the default', async () => {
  const { ctx, dialogs, moves } = await setup('rpc-15');
  location.createLocationDialog(ctx).open([1]);
  const record = dialogs.at(-1);
  const body = record.opts.body;
  const field = body.querySelector('input');
  assert.equal(field.value, '/home/u/a');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.match(body.querySelector('.field-help').textContent, /free/);
  field.value = '/home/u/moved';
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.deepEqual(moves, [{ ids: [1], location: '/home/u/moved', move: true }]);
  assert.equal(record.closed, 'saved');
});

test('4.1.3 JSON-RPC: "already there" sends move false for the whole selection', async () => {
  const { ctx, dialogs, moves } = await setup('rpc-41-jsonrpc');
  location.createLocationDialog(ctx).open([1, 2]);
  const record = dialogs.at(-1);
  assert.equal(record.opts.title, 'Set the location of 2 torrents');
  assert.match(record.opts.body.textContent, /different folders/);
  const radios = record.opts.body.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'radio');
  radios[0].checked = false;
  radios[1].checked = true;
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.deepEqual(moves, [{ ids: [1, 2], location: '/home/u/a', move: false }]);
});

test('an empty folder is refused before any request', async () => {
  const { ctx, dialogs, calls } = await setup();
  location.createLocationDialog(ctx).open([1]);
  const record = dialogs.at(-1);
  record.opts.body.querySelector('input').value = '  ';
  record.opts.actions[1].dispatch('click');
  await flush();
  assert.equal(calls.filter((c) => c.method === 'torrent-set-location').length, 0);
  assert.match(record.opts.body.textContent, /Enter a folder/);
  assert.equal(location.createLocationDialog(ctx).open([42]), null);
});
