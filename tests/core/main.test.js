import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeElement } from '../ui/details-dom.js';
import { recordedTransport } from '../fixtures/load.js';

const env = installDom({ width: 1440 });
env.doc.cookie = 'Language=de';
env.doc.getElementById = () => null;
env.doc.visibilityState = 'visible';
globalThis.addEventListener = () => {};

const { PREFS_KEY, boot, loadPrefs, MODULES } = await import('../../src/app/js/main.js');
const { memoryStorage } = await import('../../src/app/js/rpc/labels.js');

/** Timers that never fire, so the poller's cadence cannot outlive a test. */
const timers = { setTimeout: () => 1, clearTimeout() {} };

function app() {
  const node = new FakeElement('div');
  node.setAttribute('id', 'app');
  const existing = new FakeElement('div');
  existing.setAttribute('data-region', 'table');
  node.append(existing);
  env.body.replaceChildren(node);
  return { node, existing };
}

test('boot connects to the daemon, builds caps, mounts every module and primes the store', async () => {
  const { node, existing } = app();
  const { transport } = recordedTransport('rpc-17');
  const ctx = await boot(node, { transport, timers, storage: memoryStorage() });

  const regions = node.children.map((c) => c.getAttribute('data-region'));
  assert.deepEqual(regions.sort(), MODULES.map(([name]) => name).sort());
  assert.equal(node.children.filter((c) => c === existing).length, 1);
  assert.equal(env.doc.documentElement.getAttribute('lang'), 'de');

  assert.deepEqual(Object.keys(ctx).sort(), ['caps', 'fmt', 'i18n', 'poller', 'rpc', 'store', 'ui']);
  assert.deepEqual(Object.keys(ctx.ui).sort(),
    ['clear', 'confirm', 'el', 'icon', 'menu', 'openDialog', 'svg', 'toast', 'tooltip']);
  assert.equal(ctx.i18n.lang, 'de');
  assert.equal(ctx.fmt.bytes(1500), '1,50 kB');
  assert.equal(existing.getAttribute('aria-label'), 'core.regions.table');
  assert.equal(env.doc.documentElement.getAttribute('data-qb-variant'), 'spectre');

  assert.equal(ctx.caps.rpc, 17, 'caps come from the recorded 4.0.6 session-get');
  assert.equal(ctx.caps.semver, '5.3.0');
  assert.equal(ctx.caps.trackerList, true);
  assert.equal(ctx.caps.sequential, false);
  const state = ctx.store.get();
  assert.equal(state.connection.state, 'online');
  assert.equal(typeof state.session.downloadDir, 'string', 'full session stored');
  assert.equal(state.torrents.size, 6, 'first poll primed the torrent list');
  assert.ok(Number.isInteger(state.stats.torrentCount));
  assert.equal(typeof ctx.poller.stop, 'function');
  assert.equal(ctx.poller.isRunning(), true);
  const first = transport.calls.find((c) => c.init.headers['X-Transmission-Session-Id']);
  assert.equal(first.body.method, 'session-get', 'the first authenticated call is the full session-get');
  const stats = await ctx.rpc.call('session-stats');
  assert.ok(Number.isInteger(stats.torrentCount), 'ctx.rpc is the live client');
  ctx.poller.stop();
});

test('boot with the daemon down still mounts, closes every gate and reports the connection', async () => {
  const { node } = app();
  const transport = async () => new Response('nope', { status: 500 });
  const ctx = await boot(node, { transport, timers, storage: memoryStorage() });
  assert.equal(node.children.length, MODULES.length);
  assert.equal(ctx.caps.rpc, 0);
  assert.equal(ctx.caps.nativeLabels, false);
  assert.equal(ctx.store.get().connection.state, 'offline');
  assert.match(ctx.store.get().connection.error, /HTTP 500/);
  ctx.poller.stop();
});

test('a daemon that refuses the login reports unauthorized', async () => {
  const { node } = app();
  const transport = async () => new Response('', { status: 401 });
  const ctx = await boot(node, { transport, timers, storage: memoryStorage() });
  assert.equal(ctx.store.get().connection.state, 'unauthorized');
  ctx.poller.stop();
});

test('prefs are seeded from storage before mount and saved on every change', async () => {
  const { node } = app();
  const storage = memoryStorage({ [PREFS_KEY]: JSON.stringify({ detailsTab: 'files', detailsHeight: 45, pollInterval: 9 }) });
  const { transport } = recordedTransport('rpc-16');
  const ctx = await boot(node, { transport, timers, storage });
  assert.deepEqual(ctx.store.get().prefs, { detailsTab: 'files', detailsHeight: 45, pollInterval: 9 });
  ctx.store.set({ prefs: { ...ctx.store.get().prefs, sort: { key: 'name', dir: 'desc' } } });
  assert.deepEqual(JSON.parse(storage.getItem(PREFS_KEY)), {
    detailsTab: 'files', detailsHeight: 45, pollInterval: 9, sort: { key: 'name', dir: 'desc' },
  });
  ctx.poller.stop();
});

test('corrupt or missing prefs fall back to defaults and a failing storage is tolerated', async () => {
  assert.deepEqual(loadPrefs(memoryStorage({ [PREFS_KEY]: '{not json' })), {});
  assert.deepEqual(loadPrefs(memoryStorage({ [PREFS_KEY]: '[1,2]' })), {});
  assert.deepEqual(loadPrefs(memoryStorage()), {});
  assert.deepEqual(loadPrefs({ getItem() { throw new Error('blocked'); } }), {});
  const { node } = app();
  const broken = {
    getItem: () => '{"pollInterval": 3}',
    setItem() { throw new Error('quota'); },
    removeItem() {},
  };
  const { transport } = recordedTransport('rpc-16');
  const ctx = await boot(node, { transport, timers, storage: broken });
  assert.equal(ctx.store.get().prefs.pollInterval, 3);
  ctx.store.set({ prefs: { pollInterval: 4 } });
  assert.equal(ctx.store.get().prefs.pollInterval, 4, 'the store keeps the change even when saving fails');
  ctx.poller.stop();
});
