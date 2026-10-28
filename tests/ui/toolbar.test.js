import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, chromeCtx, shell, click, byLabel, byAction, flush } from './chrome-dom.js';

const env = installChromeDom();
const { ACTIONS, mount, runAction } = await import('../../src/app/js/ui/toolbar.js');

async function setup(opts = {}) {
  const made = await chromeCtx(opts);
  const { app, regions } = shell(env);
  const requests = [];
  app.addEventListener('settings-request', (e) => requests.push({ type: 'settings-request', detail: e.detail }));
  const teardown = mount(regions.toolbar, made.ctx);
  return { ...made, app, root: regions.toolbar, requests, teardown };
}

test('action table: every entry has an icon and exactly one of method/dialog', () => {
  for (const a of ACTIONS) {
    assert.equal(typeof a.icon, 'string', a.id);
    assert.equal([a.method, a.dialog].filter(Boolean).length, 1, a.id);
    if (a.method) assert.match(a.method, /^(torrent-|queue-move-)/, 'legacy spelling');
  }
  assert.deepEqual(ACTIONS.filter((a) => a.dialog).map((a) => `${a.id}:${a.dialog}`), ['remove:remove', 'move:location', 'limits:limits', 'labels:labels', 'replaceTrackers:replaceTrackers', 'findData:autoMatch']);
  assert.deepEqual(ACTIONS.filter((a) => a.allowEmpty).map((a) => a.id), ['replaceTrackers'], 'only Replace trackers runs on an empty selection');
  assert.deepEqual(ACTIONS.filter((a) => a.bulk).map((a) => a.id), ['start', 'pause', 'remove']);
});

test('mounts the groups; selection enables the action buttons', async () => {
  const { ctx, root, teardown } = await setup();
  assert.ok(byLabel(root, 'Add torrent'));
  assert.ok(root.querySelector('.tb-hamburger'));
  assert.ok(root.querySelector('.tb-more'));
  assert.ok(root.querySelector('[role="search"]'));
  for (const id of ['start', 'pause', 'verify', 'reannounce', 'remove', 'move', 'limits', 'queue']) {
    const button = byAction(root, id);
    assert.ok(button, id);
    assert.equal(button.disabled, true, `${id} disabled with nothing selected`);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('title'), null, 'no native title');
    assert.ok(button.getAttribute('aria-label'));
  }
  ctx.store.set({ selection: new Set([1, 2]) });
  assert.equal(byAction(root, 'start').disabled, false);
  assert.equal(byAction(root, 'remove').getAttribute('aria-disabled'), 'false');
  teardown();
});

test('Start/Pause run the RPC on the selection in legacy spelling and tick the poller', async () => {
  const { ctx, root, calls, ticks, teardown } = await setup();
  ctx.store.set({ selection: new Set([3, 1]) });
  click(byAction(root, 'start'));
  await flush();
  assert.deepEqual(calls, [{ method: 'torrent-start', args: { ids: [3, 1] } }]);
  assert.equal(ticks.length, 1, 'the list refreshes after the action');
  click(byAction(root, 'pause'));
  await flush();
  assert.equal(calls.at(-1).method, 'torrent-stop');
  click(byAction(root, 'verify'));
  click(byAction(root, 'reannounce'));
  await flush();
  assert.deepEqual(calls.slice(2).map((c) => c.method), ['torrent-verify', 'torrent-reannounce']);
  teardown();
});

test('a failing action surfaces an error toast and resolves false', async () => {
  const { ctx, toasts, teardown } = await setup({ respond: () => Promise.reject(new Error('boom')) });
  const ok = await runAction(ctx, 'start', [1]);
  assert.equal(ok, false);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Could not Start: boom/);
  assert.equal(toasts[0].opts.tone, 'error');
  assert.equal(await runAction(ctx, 'start', []), false, 'nothing selected: no request');
  assert.equal(await runAction(ctx, 'nope', [1]), false);
  teardown();
});

test('Move, Speed limits, Remove, Settings and About go to the dialog registry, never events or RPC', async () => {
  const { ctx, root, requests, calls, teardown } = await setup();
  ctx.store.set({ selection: new Set([7]) });
  click(byAction(root, 'move'));
  click(byAction(root, 'limits'));
  click(byLabel(root, 'About'));
  click(byLabel(root, 'Settings'));
  assert.deepEqual(requests, [], 'no request events: the registry openers are called (no-ops while it is not mounted)');
  assert.equal(calls.length, 0, 'dialog actions make no RPC');
  for (const id of ['remove', 'move', 'limits', 'labels', 'findData']) {
    assert.equal(await runAction(ctx, id, [7]), true, `${id} resolves through the registry`);
    assert.equal(await runAction(ctx, id, []), false, `${id} needs a selection`);
  }
  assert.equal(await runAction(ctx, 'replaceTrackers', []), true, 'Replace trackers runs on every torrent when nothing is selected');
  assert.equal(calls.length, 0);
  teardown();
});

test('the Queue button and More button open menus built from the action table', async () => {
  const { ctx, root, menus, teardown } = await setup();
  ctx.store.set({ selection: new Set([1]) });
  click(byAction(root, 'queue'));
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].items.map((i) => i.label), ['Force start', 'Move to top', 'Move up', 'Move down', 'Move to bottom']);
  click(root.querySelector('.tb-more'));
  const more = menus[1].items;
  assert.ok(more.some((i) => i.label === 'Start'));
  assert.ok(more.some((i) => i.label === 'Queue' && Array.isArray(i.items)));
  assert.ok(more.some((i) => i.label === 'Theme' && i.items.length === 5));
  assert.ok(more.some((i) => i.label === 'Settings'));
  assert.ok(more.some((i) => i.label === 'Replace trackers' && !i.disabled));
  assert.ok(more.some((i) => i.label === 'Find data' && !i.disabled));
  assert.ok(!more.some((i) => i.label === 'Remove'), 'Remove stays a visible button');
  ctx.store.set({ selection: new Set() });
  click(root.querySelector('.tb-more'));
  const empty = menus[2].items;
  assert.equal(empty.find((i) => i.label === 'Find data').disabled, true, 'Find data needs a selection');
  assert.equal(empty.find((i) => i.label === 'Replace trackers').disabled, false, 'Replace trackers works on all torrents');
  assert.equal(empty.find((i) => i.label === 'Start').disabled, true);
  teardown();
});

test('live rates, the alt-speed switch and the theme menu follow the store', async () => {
  const { ctx, root, calls, menus, teardown } = await setup();
  ctx.store.set({ stats: { downloadSpeed: 2_500_000, uploadSpeed: 125_000 } });
  const values = root.querySelectorAll('.tb-rate-value').map((n) => n.textContent);
  assert.deepEqual(values, ['2.50 MB/s', '125 kB/s']);

  const toggle = root.querySelector('.tb-alt-speed');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  click(toggle);
  await flush();
  assert.deepEqual(calls, [{ method: 'session-set', args: { 'alt-speed-enabled': true } }]);
  assert.equal(ctx.store.get().session.altSpeedEnabled, true);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');

  click(byLabel(root, 'Theme'));
  assert.deepEqual(menus.at(-1).items.map((i) => i.label), ['Auto (dashboard)', 'Spectre', 'Smoked', 'Reel', 'Light']);
  assert.equal(menus.at(-1).items.filter((i) => i.checked).length, 1, 'exactly one theme is checked');
  teardown();
});

test('hamburger toggles the sidebar drawer; the search toggle opens the narrow search', async () => {
  const { app, root, teardown } = await setup();
  const hamburger = root.querySelector('.tb-hamburger');
  click(hamburger);
  assert.equal(app.hasAttribute('data-sidebar-open'), true);
  click(hamburger);
  assert.equal(app.hasAttribute('data-sidebar-open'), false);
  const searchToggle = root.querySelector('.tb-search-toggle');
  click(searchToggle);
  assert.equal(root.hasAttribute('data-search-open'), true);
  assert.equal(searchToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(globalThis.document.activeElement, root.querySelector('.search-input'));
  root.querySelector('.search-input').dispatch('keydown', { key: 'Escape' });
  assert.equal(root.hasAttribute('data-search-open'), false, 'Escape closes the narrow search');
  teardown();
});
