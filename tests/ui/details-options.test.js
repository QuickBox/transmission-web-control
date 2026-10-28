import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent } from './details-dom.js';

const env = installDom();
const options = await import('../../src/app/js/ui/details/options.js');

const detail = {
  downloadLimit: 512.4, downloadLimited: true, uploadLimit: 100, uploadLimited: false, honorsSessionLimits: true,
  bandwidthPriority: 0, seedRatioMode: 1, seedRatioLimit: 2, seedIdleMode: 0, seedIdleLimit: 30, peerLimit: 50,
  sequentialDownload: false,
};

test('fields add sequential_download only when the daemon has it', () => {
  assert.equal(options.fields(null).includes('sequential_download'), false);
  assert.equal(options.fields({ sequential: false }).includes('sequential_download'), false);
  assert.equal(options.fields({ sequential: true }).at(-1), 'sequential_download');
  assert.ok(options.fields(null).includes('peer-limit'));
});

test('amounts parse as non-negative numbers, speeds as integers', () => {
  assert.equal(options.parseAmount('512.6'), 513);
  assert.equal(options.parseAmount('1,5', 2), 1.5);
  assert.equal(options.parseAmount('2.345', 2), 2.35);
  assert.equal(options.parseAmount('-1'), null);
  assert.equal(options.parseAmount('abc'), null);
  assert.equal(options.parseAmount(''), null);
});

async function view(caps = { sequential: true }, d = detail) {
  const made = await makeCtx();
  made.ctx.caps = caps;
  const refreshes = [];
  const tab = options.create(made.ctx, { refresh: () => refreshes.push(1), torrentId: () => 1 });
  env.body.replaceChildren(tab.root);
  tab.render(torrent(), d, { loading: false, error: null });
  const row = (label) => tab.root.querySelectorAll('.option-row').find((r) => r.textContent.startsWith(label));
  return { ...made, tab, row, refreshes };
}

test('controls reflect the torrent, with speeds rounded and dependent inputs disabled', async () => {
  const { row, tab } = await view();
  assert.equal(row('Limit download speed').querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
  const downRate = row('Download limit').querySelector('input');
  assert.equal(downRate.value, '512');
  assert.equal(downRate.disabled, false);
  assert.equal(row('Upload limit').querySelector('input').disabled, true);
  assert.equal(row('Stop seeding at ratio').querySelector('select').value, '1');
  assert.equal(row('Ratio').querySelector('input').disabled, false);
  assert.equal(row('Idle time').querySelector('input').disabled, true);
  assert.equal(row('Maximum peers').querySelector('input').value, '50');
  const sequentialCard = tab.root.querySelectorAll('.option-card').at(-1);
  assert.equal(sequentialCard.hidden, false);
});

test('sequential download is hidden without the cap', async () => {
  const { tab } = await view({ sequential: false }, { ...detail, sequentialDownload: undefined });
  assert.equal(tab.root.querySelectorAll('.option-card').at(-1).hidden, true);
});

test('each change writes one torrent-set in the legacy spelling, then refreshes', async () => {
  const { row, calls, refreshes } = await view();
  const up = row('Limit upload speed').querySelector('[role="switch"]');
  up.dispatch('click');
  await flush();
  assert.deepEqual(calls.at(-1), { method: 'torrent-set', args: { ids: [1], uploadLimited: true } });
  assert.equal(row('Upload limit').querySelector('input').disabled, false);
  const rate = row('Upload limit').querySelector('input');
  rate.value = '250.7';
  rate.dispatch('change');
  await flush();
  assert.deepEqual(calls.at(-1).args, { ids: [1], uploadLimit: 251 });
  const peers = row('Maximum peers').querySelector('input');
  peers.value = '80';
  peers.dispatch('change');
  await flush();
  assert.deepEqual(calls.at(-1).args, { ids: [1], 'peer-limit': 80 });
  const seq = row('Download pieces in order').querySelector('[role="switch"]');
  seq.dispatch('click');
  await flush();
  assert.deepEqual(calls.at(-1).args, { ids: [1], sequential_download: true });
  const prio = row('Bandwidth priority').querySelector('select');
  prio.value = '1';
  prio.dispatch('change');
  await flush();
  assert.deepEqual(calls.at(-1).args, { ids: [1], bandwidthPriority: 1 });
  assert.equal(refreshes.length, 5);
});

test('an invalid number is flagged and not sent', async () => {
  const { row, calls } = await view();
  const ratio = row('Ratio').querySelector('input');
  ratio.value = 'lots';
  ratio.dispatch('change');
  await flush();
  assert.equal(ratio.getAttribute('aria-invalid'), 'true');
  assert.equal(calls.length, 0);
});

test('a refresh does not overwrite the input being edited', async () => {
  const { row, tab } = await view();
  const rate = row('Download limit').querySelector('input');
  rate.focus();
  rate.value = '9';
  tab.render(torrent(), { ...detail, downloadLimit: 700 }, { loading: false, error: null });
  assert.equal(rate.value, '9');
  env.body.focus();
  tab.render(torrent(), { ...detail, downloadLimit: 700 }, { loading: false, error: null });
  assert.equal(rate.value, '700');
});

test('a failed write shows a toast and refetches to restore the truth', async () => {
  const { ctx, row, toasts, refreshes } = await view();
  ctx.rpc.call = () => Promise.reject(new Error('denied'));
  row('Follow the global speed limits').querySelector('[role="switch"]').dispatch('click');
  await flush();
  assert.match(toasts.at(-1).message, /Could not save the option: denied/);
  assert.equal(refreshes.length, 1);
});

test('loading and error states replace the form', async () => {
  const { tab } = await view();
  tab.render(torrent(), null, { loading: true, error: null });
  assert.equal(tab.root.querySelector('.options-grid').hidden, true);
  assert.match(tab.root.textContent, /Loading/);
  tab.render(torrent(), null, { loading: false, error: 'boom' });
  assert.match(tab.root.textContent, /Could not load details: boom/);
});
