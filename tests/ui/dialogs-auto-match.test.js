import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent } from './details-dom.js';

installDom();
const match = await import('../../src/app/js/ui/dialogs/auto-match.js');

test('folders parse and suggestions come from torrents and the session', () => {
  assert.deepEqual(match.parseFolders(' /a\n\n/b\n/a '), ['/a', '/b']);
  assert.deepEqual(match.suggestFolders(null, [{ downloadDir: '/z' }, { downloadDir: '/a' }], { downloadDir: '/d' }), ['/a', '/d', '/z']);
  assert.deepEqual(match.suggestFolders(['/saved'], [{ downloadDir: '/z' }], {}), ['/saved']);
});

/** A daemon where torrent 1's data lives in `/data/right`. */
function fakeDaemon(right = '/data/right') {
  const calls = [];
  const state = { location: '/orig', checks: 0 };
  const rpc = {
    call(method, args) {
      calls.push({ method, args });
      if (method === 'torrent-set-location') state.location = args.location;
      if (method === 'torrent-verify') state.checks = 0;
      if (method === 'torrent-get') {
        state.checks += 1;
        const checking = state.checks < 2;
        const found = state.location === right && state.checks >= 1;
        return Promise.resolve({ torrents: [{ id: args.ids[0], status: checking ? 2 : 0, percentDone: found ? 0.4 : 0 }] });
      }
      return Promise.resolve({});
    },
  };
  return { rpc, calls, state };
}

const env = (cancelled = () => false) => {
  let t = 0;
  return { sleep: () => Promise.resolve(), now: () => (t += 1000), cancelled, pollMs: 0 };
};

test('tries folders in order with move=false, verifies, and keeps the first that has data', async () => {
  const d = fakeDaemon();
  const out = await match.matchTorrent(d.rpc, { id: 1, downloadDir: '/orig' }, ['/data/wrong', '/data/right', '/data/never'], env());
  assert.deepEqual(out, { folder: '/data/right', cancelled: false });
  const sets = d.calls.filter((c) => c.method === 'torrent-set-location').map((c) => c.args);
  assert.deepEqual(sets, [
    { ids: [1], location: '/data/wrong', move: false },
    { ids: [1], location: '/data/right', move: false },
  ]);
  assert.equal(d.calls.filter((c) => c.method === 'torrent-verify').length, 2);
});

test('no match puts the torrent back where it was', async () => {
  const d = fakeDaemon('/nowhere');
  const out = await match.matchTorrent(d.rpc, { id: 1, downloadDir: '/orig' }, ['/a', '/b'], env());
  assert.equal(out.folder, null);
  assert.deepEqual(d.calls.at(-1), { method: 'torrent-set-location', args: { ids: [1], location: '/orig', move: false } });
});

test('a check that never ends gives up after the timeout', async () => {
  const calls = [];
  const rpc = { call: (method, args) => { calls.push(method); return Promise.resolve(method === 'torrent-get' ? { torrents: [{ id: args.ids[0], status: 2, percentDone: 0 }] } : {}); } };
  const out = await match.matchTorrent(rpc, { id: 1, downloadDir: '/orig' }, ['/a'], { ...env(), timeoutMs: 5000 });
  assert.equal(out.folder, null);
  assert.ok(calls.filter((m) => m === 'torrent-get').length <= 7);
});

test('the dialog runs the selection, skips torrents that already have data, and saves the folder list', async () => {
  const d = fakeDaemon();
  const made = await makeCtx();
  made.ctx.rpc = d.rpc;
  made.ctx.store.set({
    torrents: new Map([
      [1, torrent({ id: 1, name: 'lost <data>', percentDone: 0, downloadDir: '/orig' })],
      [2, torrent({ id: 2, name: 'fine', percentDone: 0.7 })],
    ]),
  });
  const handle = match.createAutoMatchDialog(made.ctx, { sleep: () => Promise.resolve(), pollMs: 0 }).open([1, 2]);
  const record = made.dialogs.at(-1);
  const area = record.opts.body.querySelector('textarea');
  area.value = '/data/wrong\n/data/right';
  await handle.run();
  for (let i = 0; i < 4; i += 1) await flush();
  const rows = record.opts.body.querySelectorAll('.match-result').map((r) => r.textContent);
  assert.deepEqual(rows, ['lost <data>/data/right', 'fineAlready has data']);
  assert.deepEqual(made.ctx.store.get().prefs.findDataFolders, ['/data/wrong', '/data/right']);
  assert.match(made.toasts.at(-1).message, /Found data for 1 of 2/);
  assert.equal(record.opts.actions[0].textContent, 'Close');
});

test('an empty folder list is refused and unknown ids open nothing', async () => {
  const made = await makeCtx();
  made.ctx.store.set({ torrents: new Map([[1, torrent({ id: 1, percentDone: 0 })]]) });
  const handle = match.createAutoMatchDialog(made.ctx, { sleep: () => Promise.resolve(), pollMs: 0 }).open([1]);
  const record = made.dialogs.at(-1);
  record.opts.body.querySelector('textarea').value = '   ';
  await handle.run();
  assert.match(record.opts.body.textContent, /at least one folder/);
  assert.equal(made.calls.length, 0);
  assert.equal(match.createAutoMatchDialog(made.ctx).open([9]), null);
});

test('cancelling stops before the next folder and restores the original location', async () => {
  const d = fakeDaemon('/data/right');
  let stop = false;
  const out = await match.matchTorrent(d.rpc, { id: 1, downloadDir: '/orig' }, ['/data/wrong', '/data/right'], {
    ...env(() => stop),
    onStep: () => { stop = true; },
  });
  assert.deepEqual(out, { folder: null, cancelled: true });
  const sets = d.calls.filter((c) => c.method === 'torrent-set-location').map((c) => c.args.location);
  assert.deepEqual(sets, ['/data/wrong', '/orig']);
});
