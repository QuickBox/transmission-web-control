import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, FakeElement } from './details-dom.js';
import { makeTransport, okResponse } from '../fixtures/load.js';

// A write refetches the edited torrent as a NEW store object, so the open
// details tab re-renders; the tab patches in place, so the control the user
// pressed keeps its node and its focus.

const env = installDom();
const { createClient } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { createPoller } = await import('../../src/app/js/rpc/poller.js');
const { createStore } = await import('../../src/app/js/core/store.js');
const details = await import('../../src/app/js/ui/details/index.js');

const SESSION = 'testSessionId0123456789abcdefghijklmnopqrs';
const T1 = 'https://a.invalid/announce';
const T2 = 'https://b.invalid/announce';

function daemon() {
  const row = { id: 1, hashString: '1'.repeat(40), name: 'idle-one', status: 0, labels: [], trackerStats: [{ id: 10, tier: 0, announce: T1, host: 'a.invalid', lastAnnounceSucceeded: true }], trackers: [{ id: 10, tier: 0, announce: T1 }] };
  return makeTransport({ sessionId: SESSION, rpcVersionHeader: null }, {
    'torrent-get': (body) => {
      const { ids } = body.arguments;
      if (ids === 'recently-active') return okResponse('legacy', body, { torrents: [], removed: [] });
      return okResponse('legacy', body, { torrents: [row] });
    },
    'torrent-set': (body) => {
      const urls = String(body.arguments.trackerList || '').split('\n').filter(Boolean);
      if (urls.length) {
        row.trackerStats = urls.map((announce, i) => ({ id: 100 + i, tier: 0, announce, host: new URL(announce).hostname, lastAnnounceSucceeded: true }));
        row.trackers = urls.map((announce, i) => ({ id: 100 + i, tier: 0, announce }));
      }
      return okResponse('legacy', body, {});
    },
    'session-get': (body) => okResponse('legacy', body, { 'rpc-version': 17, 'rpc-version-semver': '5.3.0', version: '4.0.6 (test)', 'download-dir': '/d' }),
    'session-stats': (body) => okResponse('legacy', body, { torrentCount: 1 }),
  });
}

test('a tracker write refetches a new store object; the open Trackers tab updates in place and keeps focus', async () => {
  const made = await makeCtx();
  const ctx = made.ctx;
  ctx.rpc = createClient({ transport: daemon() });
  ctx.caps = buildCaps({ rpcVersion: 17, rpcVersionSemver: '5.3.0' }, { dialect: 'legacy' });
  ctx.store = createStore();
  ctx.poller = createPoller({ client: ctx.rpc, caps: ctx.caps, store: ctx.store, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ctx.poller.start();

  const app = new FakeElement('div');
  app.setAttribute('id', 'app');
  const root = new FakeElement('section');
  app.append(root);
  env.body.replaceChildren(app);
  const teardown = details.mount(root, ctx);
  try {
    ctx.store.set({ focused: 1 });
    details.showTab('trackers');
    await flush();
    const before = ctx.store.get().torrents.get(1);
    const edit = root.querySelector('.trackers-actions').querySelector('button');
    assert.equal(edit.textContent, 'Edit trackers');
    edit.focus();
    edit.dispatch('click');
    const dialog = made.dialogs.at(-1);
    dialog.opts.body.querySelector('textarea').value = T2;
    dialog.opts.actions[1].dispatch('click');
    for (let i = 0; i < 8; i += 1) await flush();

    const after = ctx.store.get().torrents.get(1);
    assert.notEqual(after, before, 'refreshTorrents hands back a new object for the written id');
    assert.match(root.querySelector('.tracker-host').textContent, /b\.invalid/, 'the open tab shows the new tracker');
    assert.equal(root.querySelector('.trackers-actions').querySelector('button'), edit, 'the bar button is the same node');
    assert.equal(env.doc.activeElement, edit, 'focus stayed on it');
  } finally {
    teardown();
  }
});
