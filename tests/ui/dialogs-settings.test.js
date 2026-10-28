import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush } from './details-dom.js';
import { okResponse, recordedTransport } from '../fixtures/load.js';

installDom();
const settings = await import('../../src/app/js/ui/dialogs/settings.js');
const { createClient, DIALECT } = await import('../../src/app/js/rpc/client.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');
const { getSession } = await import('../../src/app/js/rpc/session.js');

test('time and import helpers', () => {
  assert.equal(settings.minutesToTime(0), '00:00');
  assert.equal(settings.minutesToTime(1035), '17:15');
  assert.equal(settings.timeToMinutes('17:15'), 1035);
  assert.equal(settings.timeToMinutes('24:00'), null);
  assert.equal(settings.readImport({ format: 'other' }), null);
  assert.deepEqual(settings.readImport({ format: settings.EXPORT_FORMAT, theme: 'reel', language: 'xx', prefs: { pollInterval: 3, 'bad key!': 1 } }),
    { prefs: { pollInterval: 3 }, theme: 'reel', language: null });
});

async function recorded(version, extra = {}) {
  const writes = [];
  const handler = (method) => (body) => {
    writes.push({ method, args: body.params ?? body.arguments });
    return okResponse(dialect, body, typeof extra[method] === 'function' ? extra[method](body) : extra[method] || {});
  };
  const { transport, dialect } = recordedTransport(version, {
    'session-set': handler('session-set'),
    'port-test': handler('port-test'),
    'blocklist-update': handler('blocklist-update'),
  });
  const client = createClient({ transport, dialect });
  const session = await getSession(client);
  const made = await makeCtx();
  made.ctx.rpc = client;
  made.ctx.caps = buildCaps(session, { dialect });
  made.ctx.store.set({ session });
  return { ...made, writes, session, dialect };
}

const ids = (root) => {
  const out = [];
  const walk = (n) => { for (const c of n.children || []) { if (c.nodeType === 1) { const id = c.getAttribute('id'); if (id) out.push([id, c]); walk(c); } } };
  walk(root);
  return out;
};
const control = (root, camel) => (ids(root).find(([id]) => id.endsWith(`-${camel}`)) || [])[1] || null;

async function openOn(version, extra) {
  const env = await recorded(version, extra);
  const reloads = [];
  const downloads = [];
  const dlg = settings.createSettingsDialog(env.ctx, { reload: () => reloads.push(1), download: (blob, name) => downloads.push({ blob, name }) });
  const handle = dlg.open();
  await handle.ready;
  const record = env.dialogs.at(-1);
  return { ...env, handle, record, body: record.opts.body, reloads, downloads };
}

const GATED = {
  'rpc-15': { defaultTrackers: false, scriptTorrentAddedEnabled: false, utpEnabled: true, tcpEnabled: false, preferredTransports: false, sequentialDownload: false },
  'rpc-17': { defaultTrackers: true, scriptTorrentAddedEnabled: true, utpEnabled: true, tcpEnabled: true, preferredTransports: false, sequentialDownload: false },
  'rpc-41-legacy': { defaultTrackers: true, scriptTorrentAddedEnabled: true, utpEnabled: false, tcpEnabled: false, preferredTransports: true, sequentialDownload: true },
  'rpc-41-jsonrpc': { defaultTrackers: true, scriptTorrentAddedEnabled: true, utpEnabled: false, tcpEnabled: false, preferredTransports: true, sequentialDownload: true },
};

for (const [version, expect] of Object.entries(GATED)) {
  test(`${version}: rows follow the keys the daemon reports`, async () => {
    const { body } = await openOn(version);
    const tabs = body.querySelectorAll('[role="tab"]').map((tab) => tab.getAttribute('data-page'));
    assert.deepEqual(tabs, ['downloading', 'speed', 'network', 'queue', 'seeding', 'blocklist', 'interface']);
    for (const [camel, present] of Object.entries(expect)) {
      const found = camel === 'preferredTransports'
        ? body.textContent.includes('Transports')
        : Boolean(control(body, camel));
      assert.equal(found, present, `${camel} ${present ? 'shown' : 'hidden'}`);
    }
    assert.ok(control(body, 'downloadDir'), 'core rows always there');
    assert.ok(control(body, 'peerPort'));
    assert.match(body.textContent, /TR_TORRENT_NAME/, 'script help is an inline line, not a link');
    assert.equal(body.querySelectorAll('a').length, 0);
  });
}

test('save sends only the changed keys, in each dialect, then refreshes the stored session', async () => {
  for (const version of ['rpc-15', 'rpc-41-jsonrpc']) {
    const env = await openOn(version);
    const dir = control(env.body, 'downloadDir');
    const save = env.record.opts.actions[1];
    assert.equal(save.disabled, true, 'nothing to save yet');
    dir.value = '/srv/new-downloads';
    dir.dispatch('input');
    const port = control(env.body, 'peerPort');
    port.value = String(env.session.peerPort);
    port.dispatch('input');
    assert.equal(save.disabled, false);
    save.dispatch('click');
    for (let i = 0; i < 8; i += 1) await flush();
    const key = env.dialect === DIALECT.JSONRPC ? 'download_dir' : 'download-dir';
    assert.deepEqual(env.writes.filter((w) => w.method === 'session-set').map((w) => w.args), [{ [key]: '/srv/new-downloads' }], version);
    assert.equal(env.record.closed, 'saved');
    assert.ok(env.ctx.store.get().session.downloadDir, 'session refreshed from the daemon');
  }
});

test('4.1: preferred_transports is shown read-only and the legacy transport flags are never written', async () => {
  const env = await openOn('rpc-41-legacy');
  assert.equal(control(env.body, 'utpEnabled'), null);
  assert.match(env.body.textContent, /sets the transports in its settings file/);
  const seq = control(env.body, 'sequentialDownload');
  seq.dispatch('click');
  env.record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  const sent = env.writes.filter((w) => w.method === 'session-set').map((w) => w.args);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]), ['sequential_download']);
});

test('an unknown encryption value shows as Custom and is never written back', async () => {
  const env = await openOn('rpc-17');
  const made = await makeCtx({ respond: (method) => Promise.resolve(method === 'session-get' ? { ...env.session, encryption: 'mystery' } : {}) });
  made.ctx.caps = env.ctx.caps;
  const handle = settings.createSettingsDialog(made.ctx).open();
  await handle.ready;
  const body = made.dialogs.at(-1).opts.body;
  const select = control(body, 'encryption');
  assert.equal(select.value, '__custom');
  assert.match(select.textContent, /Custom \(mystery\)/);
  const dir = control(body, 'downloadDir');
  dir.value = '/x';
  dir.dispatch('input');
  made.dialogs.at(-1).opts.actions[1].dispatch('click');
  for (let i = 0; i < 6; i += 1) await flush();
  const set = made.calls.find((c) => c.method === 'session-set');
  assert.ok(set);
  assert.equal('encryption' in set.args, false);
});

test('an invalid number blocks Save', async () => {
  const env = await openOn('rpc-15');
  const port = control(env.body, 'peerPort');
  port.value = 'abc';
  port.dispatch('input');
  assert.equal(port.getAttribute('aria-invalid'), 'true');
  assert.equal(env.record.opts.actions[1].disabled, true);
});

test('port test: two protocol chips on 4.1, one below', async () => {
  const modern = await openOn('rpc-41-jsonrpc', { 'port-test': (body) => ({ port_is_open: (body.params || {}).ip_protocol === 'ipv4' }) });
  modern.body.querySelectorAll('button').find((b) => b.textContent === 'Test port').dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.deepEqual(modern.body.querySelectorAll('.port-chip').map((c) => c.textContent), ['IPv4 open', 'IPv6 closed']);
  const old = await openOn('rpc-15', { 'port-test': { 'port-is-open': true } });
  old.body.querySelectorAll('button').find((b) => b.textContent === 'Test port').dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.deepEqual(old.body.querySelectorAll('.port-chip').map((c) => c.textContent), ['Port open']);
});

test('blocklist update calls blocklist-update and shows the new size', async () => {
  const env = await openOn('rpc-15', { 'blocklist-update': { 'blocklist-size': 1234 } });
  env.handle.showPage('blocklist');
  env.body.querySelectorAll('button').find((b) => b.textContent === 'Update now').dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.ok(env.writes.some((w) => w.method === 'blocklist-update'));
  assert.match(env.body.textContent, /1,234 rules/);
});

test('interface: theme, refresh interval and language apply on Save; language reloads', async () => {
  const env = await openOn('rpc-15');
  const theme = control(env.body, 'theme');
  theme.value = 'reel';
  theme.dispatch('change');
  const poll = control(env.body, 'poll');
  poll.value = '10';
  poll.dispatch('input');
  const lang = control(env.body, 'lang');
  lang.value = 'de';
  lang.dispatch('change');
  env.record.opts.actions[1].dispatch('click');
  for (let i = 0; i < 8; i += 1) await flush();
  assert.equal(env.writes.filter((w) => w.method === 'session-set').length, 0, 'no daemon change');
  assert.equal(globalThis.document.documentElement.getAttribute('data-qb-variant'), 'reel');
  assert.equal(env.ctx.store.get().prefs.pollInterval, 10);
  assert.equal(env.reloads.length, 1);
});

test('export writes a settings file through a Blob; import applies it', async () => {
  const env = await openOn('rpc-15');
  env.ctx.store.set({ prefs: { detailsTab: 'files' } });
  env.body.querySelectorAll('button').find((b) => b.textContent === 'Export').dispatch('click');
  assert.equal(env.downloads.length, 1);
  assert.equal(env.downloads[0].name, 'transmission-ui-settings.json');
  const data = JSON.parse(await env.downloads[0].blob.text());
  assert.equal(data.format, settings.EXPORT_FORMAT);
  assert.equal(data.prefs.detailsTab, 'files');
  const file = env.body.querySelectorAll('input').find((i) => i.getAttribute('type') === 'file');
  file.files = [{ text: async () => JSON.stringify({ ...data, prefs: { detailsTab: 'peers' } }) }];
  file.dispatch('change');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(env.ctx.store.get().prefs.detailsTab, 'peers');
  file.files = [{ text: async () => '{"format":"nope"}' }];
  file.dispatch('change');
  for (let i = 0; i < 6; i += 1) await flush();
  assert.match(env.toasts.at(-1).message, /not a settings file/);
});
