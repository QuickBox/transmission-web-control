import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installChromeDom, chromeCtx, shell, click, byLabel, byAction, flush } from './chrome-dom.js';

const env = installChromeDom();
const { ACTIONS, SURFACES, actionEnabled, mount, runAction } = await import('../../src/app/js/ui/toolbar.js');
const CHROME_CSS = readFileSync(new URL('../../src/app/css/chrome.css', import.meta.url), 'utf8');

/** Split a stylesheet into top-level rules and the body of each `@container toolbar (...)` block. */
function toolbarLayers(css) {
  const layers = { base: '', containers: {} };
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@container toolbar', i);
    if (at === -1) {
      layers.base += css.slice(i);
      break;
    }
    layers.base += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const query = css.slice(at, open).trim();
    const width = Number(/max-width:\s*(\d+)px/.exec(query)[1]);
    layers.containers[width] = css.slice(open + 1, j - 1);
    i = j;
  }
  return layers;
}

/** Is `selector` set to `display: none` by a rule in `cssText`? */
function hiddenIn(cssText, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[,\\s])${escaped}\\s*(,[^{]*)?\\{[^}]*display:\\s*none`, 'm');
  const commaRe = new RegExp(`[^{}]*${escaped}[^{]*\\{[^}]*display:\\s*none`);
  return re.test(cssText) || commaRe.test(cssText);
}

/**
 * Action ids a user can reach at a toolbar container width, from the
 * toolbar's own structure (`SURFACES`) and the stylesheet's visibility rules.
 */
function reachableAt(width) {
  const layers = toolbarLayers(CHROME_CSS);
  const active = Object.keys(layers.containers).map(Number).filter((max) => width <= max).map((max) => layers.containers[max]);
  const hidden = (selector) => hiddenIn(layers.base, selector) || active.some((body) => hiddenIn(body, selector));
  const out = new Set();
  const secondaryHidden = hidden('.shell-toolbar .tb-secondary');
  const nonRemoveGroupsHidden = hidden('.shell-toolbar .tb-group:not(:has([data-action="remove"]))');
  for (const id of SURFACES.buttons) {
    const action = ACTIONS.find((a) => a.id === id);
    const inManage = action.group === 'manage';
    const inRemove = action.group === 'remove';
    if (nonRemoveGroupsHidden && !inRemove) continue;
    if (secondaryHidden && inManage) continue;
    out.add(id);
  }
  const queueReachable = !(secondaryHidden || nonRemoveGroupsHidden);
  if (queueReachable) for (const id of SURFACES.queueMenu) out.add(id);
  if (!hidden('.tb-more') && !hidden('.shell-toolbar .tb-more')) for (const id of SURFACES.moreMenu) out.add(id);
  return out;
}

async function setup(opts = {}) {
  const made = await chromeCtx(opts);
  const { app, regions } = shell(env);
  const teardown = mount(regions.toolbar, made.ctx);
  return { ...made, app, root: regions.toolbar, teardown };
}

test('action table: every entry has an icon and exactly one of method/dialog', () => {
  for (const a of ACTIONS) {
    assert.equal(typeof a.icon, 'string', a.id);
    assert.equal([a.method, a.dialog].filter(Boolean).length, 1, a.id);
    if (a.method) assert.match(a.method, /^(torrent-|queue-move-)/, 'legacy spelling');
  }
  assert.deepEqual(ACTIONS.filter((a) => a.dialog).map((a) => `${a.id}:${a.dialog}`), ['remove:remove', 'move:location', 'limits:limits', 'labels:labels', 'replaceTrackers:replaceTrackers', 'findData:autoMatch', 'rename:rename']);
  assert.deepEqual(ACTIONS.filter((a) => a.allowEmpty).map((a) => a.id), ['replaceTrackers'], 'only Replace trackers runs on an empty selection');
  assert.deepEqual(ACTIONS.filter((a) => a.single).map((a) => a.id), ['rename'], 'only Rename needs exactly one torrent');
  const rename = ACTIONS.find((a) => a.id === 'rename');
  assert.deepEqual([0, 1, 2].map((n) => actionEnabled(rename, n)), [false, true, false]);
  assert.deepEqual([0, 1, 2].map((n) => actionEnabled(ACTIONS.find((a) => a.id === 'start'), n)), [false, true, true]);
  assert.deepEqual(ACTIONS.filter((a) => a.bulk).map((a) => a.id), ['start', 'pause', 'remove']);
});

test('every action is reachable at every width, from the toolbar structure and the stylesheet rules', () => {
  const all = new Set(ACTIONS.map((a) => a.id));
  for (const width of [1920, 1440, 960]) {
    assert.deepEqual([...reachableAt(width)].sort(), [...all].sort(), `wide ${width}: every action has an entry point`);
  }
  assert.deepEqual([...reachableAt(800)].sort(), [...all].sort(), 'medium: More carries what the groups fold');
  assert.deepEqual([...reachableAt(375)].sort(), [...all].sort(), 'narrow: Remove stays a button, the rest is in More');
  // The derivation reads the real rules: a stylesheet that hides More on wide loses the tools.
  const layers = toolbarLayers(CHROME_CSS);
  assert.equal(hiddenIn(layers.base, '.tb-more'), false, '.tb-more is not hidden by default');
  assert.equal(hiddenIn(layers.base, '.tb-hamburger'), true, 'the parser sees the hamburger hidden by default');
  assert.equal(hiddenIn(layers.containers[959], '.shell-toolbar .tb-secondary'), true, 'the parser sees secondary hidden under 960');
  assert.ok(SURFACES.buttons.includes('labels'), 'Labels has a toolbar button in the manage group');
  for (const id of ['replaceTrackers', 'findData', 'rename']) assert.ok(SURFACES.moreMenu.includes(id), `${id} is in More`);
});

test('mounts the groups; selection enables the action buttons', async () => {
  const { ctx, root, teardown } = await setup();
  const mark = root.querySelector('.tb-mark');
  assert.equal(mark.textContent, '', 'the brand is the mark, not a letter');
  const brand = mark.querySelector('svg');
  assert.equal(brand.getAttribute('aria-hidden'), 'true', 'decorative beside the wordmark');
  assert.equal(brand.children.length, 10);
  assert.ok(brand.children.every((s) => /^var\(--qb-brand-/.test(s.styles.get('fill'))), 'brand fills come from tokens');
  assert.equal(root.querySelector('.tb-wordmark').textContent, 'Transmission');
  assert.ok(byLabel(root, 'Add torrent'));
  assert.ok(root.querySelector('.tb-hamburger'));
  assert.ok(root.querySelector('.tb-more'));
  assert.ok(root.querySelector('[role="search"]'));
  for (const id of ['start', 'pause', 'verify', 'reannounce', 'remove', 'move', 'limits', 'labels', 'queue']) {
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

test('every RPC action confirms with a translated success toast that carries the count', async () => {
  const { ACTIONS } = await import('../../src/app/js/ui/toolbar.js');
  const { ctx, toasts, teardown } = await setup();
  const rpcActions = ACTIONS.filter((a) => a.method);
  assert.ok(rpcActions.length >= 9);
  for (const action of rpcActions) {
    toasts.length = 0;
    assert.equal(await runAction(ctx, action.id, [4, 5]), true, action.id);
    assert.equal(toasts.length, 1, `${action.id} shows one toast`);
    assert.equal(toasts[0].opts.tone, 'success');
    assert.match(toasts[0].message, /\b2 torrents\b/, `${action.id}: ${toasts[0].message}`);
    assert.doesNotMatch(toasts[0].message, /main\.|\{\w+\}/, 'no raw key or placeholder');
  }
  toasts.length = 0;
  await runAction(ctx, 'start', [4]);
  assert.equal(toasts[0].message, 'Started 1 torrent', 'the singular form is used for one');
  teardown();
});

test('a failing action surfaces an error toast and resolves false', async () => {
  const { ctx, toasts, teardown } = await setup({ respond: () => Promise.reject(new Error('boom')) });
  const ok = await runAction(ctx, 'start', [1]);
  assert.equal(ok, false);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Start failed: boom', 'label first, as the other catalogs order it');
  assert.equal(toasts[0].opts.tone, 'error');
  const { RpcError } = await import('../../src/app/js/rpc/client.js');
  toasts.length = 0;
  ctx.rpc.call = () => Promise.reject(new RpcError(0, 'Failed to fetch'));
  await runAction(ctx, 'pause', [1]);
  assert.equal(toasts[0].message, 'Pause failed: Cannot reach Transmission. Retrying.', 'a network failure is not the browser text');
  assert.equal(await runAction(ctx, 'start', []), false, 'nothing selected: no request');
  assert.equal(await runAction(ctx, 'nope', [1]), false);
  teardown();
});

test('Move, Speed limits, Remove, Settings and About go to the dialog registry, never events or RPC', async () => {
  const { ctx, root, calls, teardown } = await setup();
  ctx.store.set({ selection: new Set([7]) });
  click(byAction(root, 'move'));
  click(byAction(root, 'limits'));
  click(byLabel(root, 'About'));
  click(byLabel(root, 'Settings'));
  assert.equal(calls.length, 0, 'dialog actions call the registry openers (no-ops while it is not mounted) and make no RPC');
  for (const id of ['remove', 'move', 'limits', 'labels', 'findData', 'rename']) {
    assert.equal(await runAction(ctx, id, [7]), true, `${id} resolves through the registry`);
    assert.equal(await runAction(ctx, id, []), false, `${id} needs a selection`);
  }
  assert.equal(await runAction(ctx, 'rename', [7, 8]), false, 'Rename refuses two torrents');
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
  assert.ok(more.some((i) => i.label === 'Rename' && !i.disabled), 'Rename enabled with one torrent selected');
  ctx.store.set({ selection: new Set([1, 2]) });
  click(root.querySelector('.tb-more'));
  assert.equal(menus.at(-1).items.find((i) => i.label === 'Rename').disabled, true, 'Rename needs exactly one torrent');
  assert.ok(!more.some((i) => i.label === 'Remove'), 'Remove stays a visible button');
  ctx.store.set({ selection: new Set() });
  click(root.querySelector('.tb-more'));
  const empty = menus.at(-1).items;
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

test('store updates patch the toolbar in place: action buttons keep their nodes', async () => {
  const { ctx, root, teardown } = await setup();
  const start = byAction(root, 'start');
  const labels = byAction(root, 'labels');
  start.focus();
  ctx.store.set({ selection: new Set([1]) });
  ctx.store.set({ stats: { downloadSpeed: 5, uploadSpeed: 6 } });
  ctx.store.set({ session: { ...ctx.store.get().session, altSpeedEnabled: true } });
  ctx.store.set({ torrents: new Map([[1, { id: 1 }]]) });
  assert.equal(byAction(root, 'start'), start);
  assert.equal(byAction(root, 'labels'), labels);
  assert.equal(globalThis.document.activeElement, start);
  assert.equal(start.disabled, false);
  teardown();
});
