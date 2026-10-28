import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

installDom();
const limits = await import('../../src/app/js/ui/dialogs/limits.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { getSession } = await import('../../src/app/js/rpc/session.js');
const { fetchTorrents } = await import('../../src/app/js/rpc/torrents.js');

test('shared values: equal across rows or undefined', () => {
  assert.equal(limits.shared([{ a: 1 }, { a: 1 }], 'a'), 1);
  assert.equal(limits.shared([{ a: 1 }, { a: 2 }], 'a'), undefined);
  assert.equal(limits.shared([{ a: 1 }, {}], 'a'), undefined);
  assert.equal(limits.shared([], 'a'), undefined);
});

async function recorded(version) {
  const writes = [];
  const { transport, dialect } = recordedTransport(version, {
    'torrent-set': (body) => {
      writes.push({ method: 'torrent-set', args: dialect === DIALECT.JSONRPC ? body.params : body.arguments });
      return okResponse(dialect, body);
    },
    'session-set': (body) => {
      writes.push({ method: 'session-set', args: dialect === DIALECT.JSONRPC ? body.params : body.arguments });
      return okResponse(dialect, body);
    },
  });
  const client = createClient({ transport, dialect });
  const session = await getSession(client);
  const caps = buildCaps(session, { dialect });
  const { torrents } = await fetchTorrents(client, caps, new Map());
  const made = await makeCtx();
  made.ctx.rpc = client;
  made.ctx.caps = caps;
  made.ctx.store.set({ torrents, session });
  return { ...made, writes, session, torrents, dialect };
}

const row = (record, label) => record.opts.body.querySelectorAll('.option-row').find((r) => r.textContent.startsWith(label));

for (const version of ['rpc-15', 'rpc-41-jsonrpc']) {
  test(`${version}: only changed fields are written, speeds as integers, alt speed through session-set`, async () => {
    const env = await recorded(version);
    const id = [...env.torrents.keys()][0];
    const handle = limits.createLimitsDialog(env.ctx).open([id]);
    await handle.ready;
    const record = env.dialogs.at(-1);
    const sections = record.opts.body.querySelectorAll('section');
    assert.equal(sections.length, 2);
    const torrentRows = (label) => sections[0].querySelectorAll('.option-row').find((r) => r.textContent.startsWith(label));
    const sw = torrentRows('Limit download speed').querySelector('[role="switch"]');
    if (sw.getAttribute('aria-checked') !== 'true') sw.dispatch('click');
    const rate = torrentRows('Download limit').querySelector('input');
    assert.equal(rate.disabled, false);
    rate.value = '700.6';
    rate.dispatch('input');
    const alt = sections[1].querySelectorAll('.option-row').find((r) => r.textContent.startsWith('Download limit')).querySelector('input');
    assert.equal(alt.value, String(Math.round(env.session.altSpeedDown)));
    alt.value = String(Math.round(env.session.altSpeedDown) + 10);
    alt.dispatch('input');
    record.opts.actions[1].dispatch('click');
    for (let i = 0; i < 8; i += 1) await flush();
    const tset = env.writes.find((w) => w.method === 'torrent-set');
    const dl = env.dialect === DIALECT.JSONRPC ? 'download_limit' : 'downloadLimit';
    const dlOn = env.dialect === DIALECT.JSONRPC ? 'download_limited' : 'downloadLimited';
    assert.deepEqual(tset.args, { ids: [id], [dlOn]: true, [dl]: 701 });
    const sset = env.writes.find((w) => w.method === 'session-set');
    const altKey = env.dialect === DIALECT.JSONRPC ? 'alt_speed_down' : 'alt-speed-down';
    assert.deepEqual(sset.args, { [altKey]: Math.round(env.session.altSpeedDown) + 10 });
    assert.equal(record.closed, 'saved');
  });
}

test('without a selection only the alternative speed section shows; unchanged values send nothing', async () => {
  const env = await recorded('rpc-15');
  limits.createLimitsDialog(env.ctx).open([]);
  const record = env.dialogs.at(-1);
  assert.equal(record.opts.body.querySelectorAll('section').length, 1);
  record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(env.writes.length, 0);
  assert.equal(record.closed, 'saved');
});

test('a selection with different limits starts blank and says so; invalid numbers are refused', async () => {
  const made = await makeCtx({
    respond: (method) => Promise.resolve(method === 'torrent-get' ? {
      torrents: [
        { id: 1, downloadLimit: 100, downloadLimited: true, uploadLimit: 5, uploadLimited: false, honorsSessionLimits: true },
        { id: 2, downloadLimit: 200, downloadLimited: true, uploadLimit: 5, uploadLimited: false, honorsSessionLimits: true },
      ],
    } : {}),
  });
  made.ctx.store.set({ torrents: new Map([[1, { id: 1 }], [2, { id: 2 }]]) });
  const handle = limits.createLimitsDialog(made.ctx).open([1, 2]);
  await handle.ready;
  const record = made.dialogs.at(-1);
  assert.equal(row(record, 'Download limit').querySelector('input').value, '');
  assert.equal(row(record, 'Limit download speed').querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
  assert.match(record.opts.body.textContent, /different values/);
  const up = row(record, 'Upload limit').querySelector('input');
  up.value = 'fast';
  up.dispatch('input');
  record.opts.actions[1].dispatch('click');
  await flush();
  assert.equal(up.getAttribute('aria-invalid'), 'true');
  assert.equal(made.calls.filter((c) => c.method === 'torrent-set').length, 0);
});
