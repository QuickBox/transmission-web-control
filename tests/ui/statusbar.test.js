import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, chromeCtx, shell, flush, torrent } from './chrome-dom.js';

const env = installChromeDom();
const { FREE_SPACE_INTERVAL_MS, mount } = await import('../../src/app/js/ui/statusbar.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');

function respondWith(overrides = {}) {
  return (method, args) => {
    if (method === 'free-space') return Promise.resolve({ path: args.path, sizeBytes: 21_288_132_608, totalSize: 61_413_216_256 });
    if (method === 'port-test') return Promise.resolve({ portIsOpen: args && args.ip_protocol === 'ipv6' ? false : true });
    if (overrides[method]) return overrides[method](args);
    return Promise.resolve({});
  };
}

async function setup(opts = {}) {
  const made = await chromeCtx({ respond: respondWith(opts.respond), caps: opts.caps, session: opts.session });
  const { regions } = shell(env);
  let clock = 1_000_000;
  const now = () => clock;
  made.ctx.store.set({ stats: { downloadSpeed: 1_000_000, uploadSpeed: 20_000, torrentCount: 3 }, ...(opts.state || {}) });
  const teardown = mount(regions.statusbar, made.ctx, { now });
  await flush();
  return { ...made, root: regions.statusbar, teardown, advance: (ms) => { clock += ms; } };
}

const chip = (root, id) => root.querySelector(`[data-chip="${id}"]`);
const chipText = (root, id) => chip(root, id).querySelector('.chip-value').textContent;

test('rates, limits, alt-speed chip and counts follow the store', async () => {
  const { ctx, root, teardown } = await setup();
  assert.equal(chipText(root, 'down'), '1.00 MB/s');
  assert.equal(chipText(root, 'up'), '20.0 kB/s');
  assert.equal(chip(root, 'alt-speed').hidden, true);
  assert.equal(chipText(root, 'counts'), '0 torrents');
  for (const id of ['down', 'up', 'free']) assert.ok(chip(root, id).hasAttribute('data-essential'), `${id} survives narrow`);
  for (const id of ['port', 'version', 'counts']) assert.equal(chip(root, id).hasAttribute('data-essential'), false, id);

  ctx.store.set({ session: { ...ctx.store.get().session, speedLimitDownEnabled: true, speedLimitDown: 2048 } });
  assert.equal(chipText(root, 'down'), '1.00 MB/s of 2.05 MB/s', 'speed-limit-down is in kB/s');
  ctx.store.set({ session: { ...ctx.store.get().session, altSpeedEnabled: true } });
  assert.equal(chip(root, 'alt-speed').hidden, false);
  assert.equal(chipText(root, 'alt-speed'), 'Limits on');
  assert.equal(chipText(root, 'down'), '1.00 MB/s of 50.0 kB/s', 'alt-speed limit wins while on');
  assert.equal(chipText(root, 'up'), '20.0 kB/s of 50.0 kB/s');

  ctx.store.set({ torrents: new Map([[1, torrent()], [2, torrent({ id: 2 })]]), selection: new Set([2]) });
  assert.equal(chipText(root, 'counts'), '2 torrents · 1 selected');
  ctx.store.set({ selection: new Set() });
  assert.equal(chipText(root, 'counts'), '2 torrents');
  for (const node of root.querySelectorAll('.chip')) assert.equal(node.getAttribute('title'), null);
  teardown();
});

test('version chip shows the daemon version without its hash plus the RPC semver or integer', async () => {
  const { root, teardown } = await setup();
  assert.equal(chipText(root, 'version'), 'Transmission 4.0.6 · RPC 5.3.0');
  teardown();
  const caps15 = buildCaps({ rpcVersion: 15, version: '2.94 (d8e60ee44f)' }, { dialect: 'legacy' });
  const legacy = await setup({ caps: caps15, session: { version: '2.94 (d8e60ee44f)', rpcVersionSemver: undefined } });
  assert.equal(chipText(legacy.root, 'version'), 'Transmission 2.94 · RPC 15');
  legacy.teardown();
});

test('free space is fetched once for the download dir, again after the interval or a dir change', async () => {
  const { ctx, root, calls, advance, teardown } = await setup();
  const frees = () => calls.filter((c) => c.method === 'free-space');
  assert.equal(frees().length, 1);
  assert.deepEqual(frees()[0].args, { path: '/home/user/torrents' });
  assert.equal(chipText(root, 'free'), '21.3 GB free');
  ctx.store.set({ stats: { downloadSpeed: 1, uploadSpeed: 1 } });
  await flush();
  assert.equal(frees().length, 1, 'a poll inside the interval does not refetch');
  advance(FREE_SPACE_INTERVAL_MS + 1);
  ctx.store.set({ stats: { downloadSpeed: 2, uploadSpeed: 1 } });
  await flush();
  assert.equal(frees().length, 2, 'refetched after the interval');
  ctx.store.set({ session: { ...ctx.store.get().session, downloadDir: '/elsewhere' } });
  await flush();
  assert.equal(frees().length, 3, 'a new download dir refetches at once');
  assert.deepEqual(frees()[2].args, { path: '/elsewhere' });
  teardown();
});

test('port status: one probe below 4.1, two on 4.1 with per-protocol labels', async () => {
  const { root, calls, teardown } = await setup();
  const ports = () => calls.filter((c) => c.method === 'port-test');
  assert.equal(ports().length, 1);
  assert.equal(chipText(root, 'port'), 'Port open');
  assert.equal(chip(root, 'port').getAttribute('data-open'), 'true');
  teardown();

  const caps41 = buildCaps({ rpcVersionSemver: '6.0.1', version: '4.1.3 (838877323f)', peerPort: 51413 }, { dialect: 'jsonrpc' });
  const modern = await setup({ caps: caps41, session: { version: '4.1.3 (838877323f)', rpcVersionSemver: '6.0.1' } });
  const probes = modern.calls.filter((c) => c.method === 'port-test');
  assert.deepEqual(probes.map((c) => c.args.ip_protocol).sort(), ['ipv4', 'ipv6']);
  assert.equal(chipText(modern.root, 'port'), 'Port IPV4 open · Port IPV6 closed');
  assert.equal(chip(modern.root, 'port').getAttribute('data-open'), 'partial');
  modern.ctx.store.set({ session: { ...modern.ctx.store.get().session, altSpeedEnabled: true } });
  await flush();
  assert.equal(modern.calls.filter((c) => c.method === 'port-test').length, 2, 'an unrelated session change does not re-probe');
  modern.ctx.store.set({ session: { ...modern.ctx.store.get().session, peerPort: 6881 } });
  await flush();
  assert.equal(modern.calls.filter((c) => c.method === 'port-test').length, 4, 'a port change re-probes');
  modern.teardown();
});

test('connection chip is a polite live region that appears while offline or unauthorized', async () => {
  const { ctx, root, teardown } = await setup();
  const c = chip(root, 'connection');
  assert.equal(c.getAttribute('role'), 'status');
  assert.equal(c.getAttribute('aria-live'), 'polite');
  assert.equal(c.hidden, true);
  ctx.store.set({ connection: { state: 'offline', error: 'HTTP 500', since: 2 } });
  assert.equal(c.hidden, false);
  assert.equal(c.getAttribute('data-state'), 'offline');
  assert.match(c.textContent, /Cannot reach Transmission/);
  ctx.store.set({ connection: { state: 'unauthorized', error: 'HTTP 401', since: 3 } });
  assert.match(c.textContent, /refused the login/);
  ctx.store.set({ connection: { state: 'online', error: null, since: 4 } });
  assert.equal(c.hidden, true);
  teardown();
});
