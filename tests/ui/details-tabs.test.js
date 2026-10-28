import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, torrent } from './details-dom.js';

const env = installDom();
const general = await import('../../src/app/js/ui/details/general.js');
const peers = await import('../../src/app/js/ui/details/peers.js');

const ok = { loading: false, error: null };

async function generalView(t, detail, state = ok) {
  const made = await makeCtx();
  const view = general.create(made.ctx);
  env.body.replaceChildren(view.root);
  view.render(t, detail, state);
  const card = (label) => view.root.querySelectorAll('.stat-card').find((c) => c.textContent.startsWith(label));
  const fact = (label) => view.root.querySelectorAll('.fact').find((f) => f.textContent.startsWith(label));
  return { ...made, view, card, fact };
}

test('General formats through ctx.fmt and shows unknown counts as an em dash', async () => {
  const { card } = await generalView(torrent({ seederCount: null, leecherCount: -1 }), null);
  assert.equal(card('Progress').textContent, 'Progress50.0%');
  assert.equal(card('Download speed').textContent, 'Download speed2.50 MB/s');
  assert.equal(card('Seeders').textContent, 'Seeders—');
  assert.equal(card('Leechers').textContent, 'Leechers—');
  assert.equal(card('Peers').textContent, 'Peers129 sending · 2 receiving');
  const idle = await generalView(torrent({ peersConnected: 0, peersSendingToUs: 0, peersGettingFromUs: 0 }), null);
  assert.equal(idle.card('Peers').textContent, 'Peers0', 'no sending/receiving split without peers');
});

test('a General poll updates values in place; its copy buttons stay the same nodes', async () => {
  const { view } = await generalView(torrent(), { hashString: 'abc', magnetLink: 'magnet:?xt=urn:btih:abc' });
  const buttons = view.root.querySelectorAll('button');
  assert.ok(buttons.length > 0, 'General has copy buttons');
  buttons[0].focus();
  view.render(torrent({ downloadedEver: 1 }), { hashString: 'abc', magnetLink: 'magnet:?xt=urn:btih:abc' }, ok);
  assert.deepEqual(view.root.querySelectorAll('button'), buttons);
  assert.equal(env.doc.activeElement, buttons[0]);
});

test('General shows static facts once fetched, and an em dash where the daemon has none', async () => {
  const { fact } = await generalView(torrent(), {
    comment: '<script>x</script>', creator: '', pieceCount: 1430, pieceSize: 4194304, isPrivate: true, dateCreated: 0,
  });
  assert.equal(fact('Comment').textContent, 'Comment<script>x</script>');
  assert.equal(fact('Created by').textContent, 'Created by—');
  assert.equal(fact('Pieces').textContent, 'Pieces1,430 × 4.00 MiB');
  assert.equal(fact('Privacy').textContent, 'PrivacyPrivate torrent');
  assert.equal(fact('Created').textContent, 'Created—');
  const loading = await generalView(torrent(), null, { loading: true, error: null });
  assert.equal(loading.fact('Comment').textContent, 'Comment', 'blank while loading, not a dash');
});

test('General raises the torrent error, then a tracker warning, in the notice', async () => {
  const failed = await generalView(torrent({ error: 3, errorString: 'No data found' }), null);
  const notice = failed.view.root.querySelector('.details-notice');
  assert.equal(notice.hidden, false);
  assert.ok(notice.classList.contains('is-error'));
  assert.match(notice.textContent, /No data found/);
  const warned = await generalView(torrent({ warning: 'Connection refused' }), null);
  assert.match(warned.view.root.querySelector('.details-notice').textContent, /Tracker: Connection refused/);
  const fine = await generalView(torrent(), null);
  assert.equal(fine.view.root.querySelector('.details-notice').hidden, true);
});

test('General copy buttons use the clipboard and confirm with a toast', async () => {
  const written = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (s) => { written.push(s); return Promise.resolve(); } } }, configurable: true,
  });
  const { view, toasts } = await generalView(torrent(), { magnetLink: 'magnet:?xt=urn:btih:aaa' });
  const buttons = view.root.querySelectorAll('button');
  buttons.find((b) => b.getAttribute('aria-label') === 'Copy hash').dispatch('click');
  buttons.find((b) => b.getAttribute('aria-label') === 'Copy magnet link').dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written, ['a'.repeat(40), 'magnet:?xt=urn:btih:aaa']);
  assert.equal(toasts.at(-1).message, 'Copied');
});

test('peer addresses bracket IPv6 and keep the port', () => {
  assert.equal(peers.peerAddress({ address: '192.0.2.4', port: 51413 }), '192.0.2.4:51413');
  assert.equal(peers.peerAddress({ address: '2001:db8::1', port: 6881 }), '[2001:db8::1]:6881');
  assert.equal(peers.peerAddress({ address: '198.51.100.9' }), '198.51.100.9');
  assert.equal(peers.peerAddress({}), '');
});

test('peers sort busiest first and skip junk entries', () => {
  const sorted = peers.sortPeers([
    { address: '192.0.2.1', rateToClient: 10 },
    null,
    { address: '192.0.2.2', rateToClient: 500, rateToPeer: 1 },
    { address: '192.0.2.3' },
  ]);
  assert.deepEqual(sorted.map((p) => p.address), ['192.0.2.2', '192.0.2.1', '192.0.2.3']);
});

test('the Peers table renders untrusted client names as text and labels every cell', async () => {
  const made = await makeCtx();
  const view = peers.create(made.ctx);
  view.render(torrent(), {
    peers: [{ address: '203.0.113.7', port: 1, clientName: '<img src=x>', progress: 0.42, rateToClient: 2048, rateToPeer: 0, flagStr: 'DE' }],
  }, ok);
  const cells = view.root.querySelectorAll('td');
  assert.equal(cells[1].textContent, '<img src=x>');
  assert.equal(cells[1].children.length, 1);
  assert.equal(cells[2].textContent, '42%');
  assert.equal(cells[3].textContent, '2.05 kB/s');
  assert.equal(cells[0].getAttribute('data-label'), 'Address');
  assert.match(view.root.querySelector('.peers-summary').textContent, /1 peer$/);
  assert.equal(view.root.querySelector('caption').textContent, 'Connected peers');
});

test('a peers poll patches each address row in place and drops departed peers', async () => {
  const made = await makeCtx();
  const view = peers.create(made.ctx);
  const a = { address: '203.0.113.7', port: 1, clientName: 'A', progress: 0.1, rateToClient: 0, rateToPeer: 0, flagStr: 'D' };
  const b = { address: '198.51.100.9', port: 2, clientName: 'B', progress: 0.2, rateToClient: 0, rateToPeer: 0, flagStr: 'E' };
  view.render(torrent(), { peers: [a, b] }, ok);
  const body = view.root.querySelector('tbody');
  const rowA = body.children.find((r) => r.textContent.startsWith('203.0.113.7'));
  view.render(torrent(), { peers: [{ ...a, progress: 0.9 }] }, ok);
  const rows = body.children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0], rowA, 'same row node after the poll');
  assert.match(rowA.textContent, /90%/);
});

test('Peers with a missing list, no peers, or a load error show a message', async () => {
  const made = await makeCtx();
  const view = peers.create(made.ctx);
  view.render(torrent(), null, { loading: true, error: null });
  assert.match(view.root.textContent, /Loading/);
  view.render(torrent(), {}, ok);
  assert.match(view.root.textContent, /No peers connected/);
  view.render(torrent(), { peers: [] }, ok);
  assert.equal(view.root.querySelector('.peers-scroll').hidden, true);
  view.render(torrent(), null, { loading: false, error: 'boom' });
  assert.match(view.root.textContent, /Could not load details: boom/);
});
