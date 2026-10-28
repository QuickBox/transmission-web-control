import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, chromeCtx, shell, flush, torrent } from './chrome-dom.js';

const env = installChromeDom();
const { FREE_SPACE_INTERVAL_MS, PORT_RETRY_MS, mount } = await import('../../src/app/js/ui/statusbar.js');
const { buildCaps } = await import('../../src/app/js/rpc/caps.js');

function respondWith(overrides = {}) {
  return (method, args) => {
    if (overrides[method]) return overrides[method](args);
    if (method === 'free-space') return Promise.resolve({ path: args.path, sizeBytes: 21_288_132_608, totalSize: 61_413_216_256 });
    if (method === 'port-test') return Promise.resolve({ portIsOpen: args && args.ip_protocol === 'ipv6' ? false : true });
    return Promise.resolve({});
  };
}

const chipCtx = (opts = {}) => chromeCtx({ respond: respondWith(opts.respond), caps: opts.caps, session: opts.session });

async function setup(opts = {}) {
  const made = await chipCtx(opts);
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

test('the count chip says how many of the daemon’s torrents the active filter shows', async () => {
  const { ctx, root, teardown } = await setup();
  ctx.store.set({ torrents: new Map([[1, torrent()], [2, torrent({ id: 2 })], [3, torrent({ id: 3 })]]), order: [1, 2, 3] });
  assert.equal(chipText(root, 'counts'), '3 torrents');
  ctx.store.set({ filter: { ...ctx.store.get().filter, search: 'x' }, order: [2] });
  assert.equal(chipText(root, 'counts'), '1 of 3 torrents');
  ctx.store.set({ selection: new Set([2]) });
  assert.equal(chipText(root, 'counts'), '1 of 3 torrents · 1 selected');
  ctx.store.set({ order: [] });
  assert.equal(chipText(root, 'counts'), '0 of 3 torrents · 1 selected');
  ctx.store.set({ filter: { ...ctx.store.get().filter, search: '' }, order: [1, 2, 3] });
  assert.equal(chipText(root, 'counts'), '3 torrents · 1 selected', 'back to the plain total when nothing filters');
  teardown();
});

test('version chip labels the RPC integer on legacy daemons and the semver on JSON-RPC', async () => {
  const { root, teardown } = await setup();
  assert.equal(chipText(root, 'version'), 'Transmission 4.0.6 · RPC 17');
  teardown();
  const caps15 = buildCaps({ rpcVersion: 15, version: '2.94 (d8e60ee44f)' }, { dialect: 'legacy' });
  const legacy = await setup({ caps: caps15, session: { version: '2.94 (d8e60ee44f)', rpcVersionSemver: undefined } });
  assert.equal(chipText(legacy.root, 'version'), 'Transmission 2.94 · RPC 15');
  legacy.teardown();
  const caps41 = buildCaps({ rpcVersion: 19, rpcVersionSemver: '6.0.1', version: '4.1.3 (838877323f)' }, { dialect: 'legacy' });
  const bench = await setup({ caps: caps41, session: { version: '4.1.3 (838877323f)', rpcVersion: 19, rpcVersionSemver: '6.0.1' } });
  assert.equal(chipText(bench.root, 'version'), 'Transmission 4.1.3 · RPC 19', 'a legacy 4.1 daemon shows its integer');
  bench.teardown();
  const caps41j = buildCaps({ rpcVersionSemver: '6.0.1', version: '4.1.3 (838877323f)' }, { dialect: 'jsonrpc' });
  const modern = await setup({ caps: caps41j, session: { version: '4.1.3 (838877323f)', rpcVersionSemver: '6.0.1' } });
  assert.equal(chipText(modern.root, 'version'), 'Transmission 4.1.3 · RPC semver 6.0.1');
  assert.equal(chip(modern.root, 'version').hidden, false);
  modern.teardown();
});

test('below 640px a limit shows as a marker while the rate stays whole, and the full text moves to the name and tooltip', async () => {
  const original = globalThis.matchMedia;
  const state = { matches: true, listeners: new Set() };
  globalThis.matchMedia = () => ({
    get matches() { return state.matches; },
    addEventListener: (type, fn) => state.listeners.add(fn),
    removeEventListener: (type, fn) => state.listeners.delete(fn),
  });
  try {
    const made = await chipCtx();
    const tips = new Map();
    made.ctx.ui = { ...made.ctx.ui, tooltip: (node, text) => tips.set(node.getAttribute('data-chip'), text) };
    made.ctx.store.set({ session: { ...made.ctx.store.get().session, speedLimitDownEnabled: true, speedLimitDown: 2048 } });
    const { regions } = shell(env);
    made.ctx.store.set({ stats: { downloadSpeed: 1_000_000, uploadSpeed: 20_000, torrentCount: 3 } });
    const teardown = mount(regions.statusbar, made.ctx, { now: () => 0 });
    await flush();
    const root = regions.statusbar;
    assert.equal(chipText(root, 'down'), '1.00 MB/s', 'narrow: the rate alone');
    const marker = chip(root, 'down').querySelector('.chip-limit');
    assert.equal(marker.hidden, false);
    assert.equal(marker.querySelector('svg, .icon').getAttribute('aria-label'), '1.00 MB/s of 2.05 MB/s', 'the marker carries the full text');
    assert.equal(tips.get('down')(), '1.00 MB/s of 2.05 MB/s', 'and so does the tooltip');
    assert.equal(chip(root, 'up').querySelector('.chip-limit').hidden, true, 'an unlimited chip has no marker');
    assert.equal(tips.get('up')(), 'Upload rate');

    state.matches = false;
    for (const fn of state.listeners) fn();
    assert.equal(chipText(root, 'down'), '1.00 MB/s of 2.05 MB/s', 'wide: the full text, unchanged');
    assert.equal(chip(root, 'down').querySelector('.chip-limit').hidden, true);
    assert.equal(tips.get('down')(), 'Download rate');
    teardown();
    assert.equal(state.listeners.size, 0, 'teardown removes the width listener');
  } finally {
    globalThis.matchMedia = original;
  }
});

test('every chip tooltip renders without an unfilled placeholder', async () => {
  const made = await chipCtx();
  const tips = new Map();
  made.ctx.ui = { ...made.ctx.ui, tooltip: (node, text) => tips.set(node.getAttribute('data-chip'), text) };
  const { regions } = shell(env);
  const teardown = mount(regions.statusbar, made.ctx, { now: () => 0 });
  await flush();
  assert.deepEqual([...tips.keys()].sort(), ['alt-speed', 'down', 'free', 'port', 'up', 'version']);
  for (const [id, text] of tips) {
    const rendered = text();
    assert.ok(rendered.length > 0, id);
    assert.doesNotMatch(rendered, /\{\w+\}/, `${id}: ${rendered}`);
  }
  teardown();
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

test('the free-space chip says it is checking until the first answer, then shows the value or a dash', async () => {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  const held = await setup({ respond: { 'free-space': () => pending } });
  assert.equal(chipText(held.root, 'free'), 'Checking free space');
  answer({ path: '/home/user/torrents', sizeBytes: 5_000_000_000 });
  await flush();
  assert.equal(chipText(held.root, 'free'), '5.00 GB free');
  held.teardown();
  const failed = await setup({ respond: { 'free-space': () => Promise.reject(new Error('no such path')) } });
  assert.equal(chipText(failed.root, 'free'), '—');
  failed.teardown();
});

test('port status: one probe below 4.1, two on 4.1 with per-protocol labels', async () => {
  const { root, calls, teardown } = await setup();
  const ports = () => calls.filter((c) => c.method === 'port-test');
  assert.equal(ports().length, 1);
  assert.equal(chipText(root, 'port'), 'Port 51413: open');
  assert.equal(chip(root, 'port').getAttribute('data-open'), 'true');
  teardown();

  const caps41 = buildCaps({ rpcVersionSemver: '6.0.1', version: '4.1.3 (838877323f)', peerPort: 51413 }, { dialect: 'jsonrpc' });
  const modern = await setup({ caps: caps41, session: { version: '4.1.3 (838877323f)', rpcVersionSemver: '6.0.1' } });
  const probes = modern.calls.filter((c) => c.method === 'port-test');
  assert.deepEqual(probes.map((c) => c.args.ip_protocol).sort(), ['ipv4', 'ipv6']);
  assert.equal(chipText(modern.root, 'port'), 'Port 51413: IPv4 open · IPv6 closed');
  assert.equal(chip(modern.root, 'port').getAttribute('data-open'), 'partial');
  modern.ctx.store.set({ session: { ...modern.ctx.store.get().session, altSpeedEnabled: true } });
  await flush();
  assert.equal(modern.calls.filter((c) => c.method === 'port-test').length, 2, 'an unrelated session change does not re-probe');
  modern.ctx.store.set({ session: { ...modern.ctx.store.get().session, peerPort: 6881 } });
  await flush();
  assert.equal(modern.calls.filter((c) => c.method === 'port-test').length, 4, 'a port change re-probes');
  modern.teardown();
});

test('a failing IPv6 probe is unavailable and the IPv4 verdict still shows', async () => {
  const caps41 = buildCaps({ rpcVersionSemver: '6.0.1', version: '4.1.3 (838877323f)' }, { dialect: 'jsonrpc' });
  const respond = {
    'port-test': (args) => (args.ip_protocol === 'ipv6'
      ? Promise.reject(new Error("Couldn't test port: No Response (0)"))
      : Promise.resolve({ portIsOpen: false })),
  };
  const { root, calls, teardown } = await setup({ caps: caps41, session: { peerPort: 57699 }, respond });
  assert.equal(chipText(root, 'port'), 'Port 57699: IPv4 closed · IPv6 unavailable');
  assert.doesNotMatch(chipText(root, 'port'), /\s{2,}/, 'no doubled spaces');
  assert.equal(chip(root, 'port').getAttribute('data-open'), 'false');
  assert.equal(calls.filter((c) => c.method === 'port-test').length, 2);
  teardown();
});

test('an IPv4 verdict with IPv6 unavailable is not painted as partial', async () => {
  const caps41 = buildCaps({ rpcVersionSemver: '6.0.1', version: '4.1.3 (838877323f)' }, { dialect: 'jsonrpc' });
  const respond = {
    'port-test': (args) => (args.ip_protocol === 'ipv6' ? Promise.reject(new Error('no ipv6')) : Promise.resolve({ portIsOpen: true })),
  };
  const { root, teardown } = await setup({ caps: caps41, respond });
  assert.equal(chipText(root, 'port'), 'Port 51413: IPv4 open · IPv6 unavailable');
  assert.equal(chip(root, 'port').getAttribute('data-open'), 'true');
  teardown();
});

test('when every probe fails the chip says unavailable and retries no sooner than the interval', async () => {
  const respond = { 'port-test': () => Promise.reject(new Error('daemon unreachable')) };
  const { ctx, root, calls, advance, teardown } = await setup({ respond });
  const probes = () => calls.filter((c) => c.method === 'port-test').length;
  assert.equal(chipText(root, 'port'), 'Port 51413: unavailable');
  assert.equal(chip(root, 'port').getAttribute('data-open'), 'unknown');
  assert.equal(probes(), 1);
  ctx.store.set({ session: { ...ctx.store.get().session, altSpeedEnabled: true } });
  await flush();
  assert.equal(probes(), 1, 'a poll inside the retry window does not re-probe');
  advance(PORT_RETRY_MS + 1);
  ctx.store.set({ session: { ...ctx.store.get().session, altSpeedEnabled: false } });
  await flush();
  assert.equal(probes(), 2, 'retried after the window');
  teardown();
});

test('connection chip is a polite live region that appears while offline or unauthorized', async () => {
  const { ctx, root, teardown } = await setup();
  const c = chip(root, 'connection');
  assert.equal(c.getAttribute('role'), 'status');
  assert.equal(c.getAttribute('aria-live'), 'polite');
  assert.equal(c.hidden, true);
  assert.equal(c.hasAttribute('data-essential'), false, 'nothing to show while online, at any width');
  ctx.store.set({ connection: { state: 'offline', error: 'HTTP 500', since: 2 } });
  assert.equal(c.hidden, false);
  assert.equal(c.hasAttribute('data-essential'), true, 'an unreachable daemon shows on phones too');
  assert.equal(c.getAttribute('data-state'), 'offline');
  assert.match(c.textContent, /Cannot reach Transmission/);
  ctx.store.set({ connection: { state: 'unauthorized', error: 'HTTP 401', since: 3 } });
  assert.match(c.textContent, /refused the login/);
  ctx.store.set({ connection: { state: 'online', error: null, since: 4 } });
  assert.equal(c.hidden, true);
  assert.equal(c.hasAttribute('data-essential'), false, 'back online drops the essential mark');
  teardown();
});

test('store updates patch the chips in place', async () => {
  const { ctx, root, teardown } = await setup();
  const nodes = ['down', 'up', 'free', 'port', 'version', 'counts', 'connection'].map((id) => chip(root, id));
  ctx.store.set({ stats: { downloadSpeed: 7, uploadSpeed: 8, torrentCount: 3 } });
  ctx.store.set({ session: { ...ctx.store.get().session, altSpeedEnabled: true } });
  ctx.store.set({ connection: { state: 'offline', error: 'x', since: 1 } });
  ctx.store.set({ torrents: new Map([[1, torrent()]]) });
  await flush();
  ['down', 'up', 'free', 'port', 'version', 'counts', 'connection'].forEach((id, i) => assert.equal(chip(root, id), nodes[i], `${id} chip keeps its node`));
  teardown();
});
