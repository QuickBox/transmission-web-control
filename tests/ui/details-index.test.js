import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent, FakeElement } from './details-dom.js';

const env = installDom({ width: 1440 });
const details = await import('../../src/app/js/ui/details/index.js');
const general = await import('../../src/app/js/ui/details/general.js');
const files = await import('../../src/app/js/ui/details/files.js');

function shell() {
  const app = new FakeElement('div');
  app.setAttribute('id', 'app');
  for (const cls of ['shell-toolbar', 'shell-sidebar', 'shell-table', 'shell-statusbar', 'shell-bulkbar']) {
    const region = new FakeElement('div');
    region.setAttribute('class', cls);
    app.append(region);
  }
  const main = new FakeElement('main');
  const root = new FakeElement('section');
  main.append(root);
  app.append(main);
  env.body.replaceChildren(app);
  return { app, root };
}

function setup(width = 1440, opts = {}) {
  env.media.width = width;
  return makeCtx(opts).then((made) => {
    const { app, root } = shell();
    const teardown = details.mount(root, made.ctx);
    return { ...made, app, root, teardown };
  });
}

const tabs = (root) => root.querySelectorAll('[role="tab"]');
const selected = (root) => tabs(root).find((tab) => tab.getAttribute('aria-selected') === 'true');

test('no focused torrent shows the empty state', async () => {
  const { root, calls, teardown } = await setup();
  const drawer = root.querySelector('.details');
  assert.ok(drawer.classList.contains('is-empty'));
  assert.match(root.querySelector('.details-empty').textContent, /Select a torrent/);
  assert.equal(calls.length, 0);
  teardown();
});

test('focusing a torrent renders its name as text and fetches General fields once', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { ctx, root, calls, teardown } = await setup(1440, { details: { 1: { comment: 'hi' } } });
  ctx.store.set({ torrents: new Map([[1, torrent({ name: hostile })]]), focused: 1 });
  await flush();
  assert.ok(!root.querySelector('.details').classList.contains('is-empty'));
  assert.equal(root.querySelector('.details-name').textContent, hostile);
  assert.equal(root.querySelector('.details-name').children.length, 1);
  assert.equal(root.querySelector('.details-status').getAttribute('data-state'), 'downloading');
  assert.deepEqual(calls, [{ method: 'torrent-get', args: { ids: [1], fields: ['id', ...general.fields] } }]);
  ctx.store.set({ torrents: new Map([[1, torrent({ name: hostile, rateDownload: 1 })]]) });
  await flush();
  assert.equal(calls.length, 1, 'static General fields are not refetched on a poll');
  teardown();
});

test('tabs follow the arrow keys, persist in prefs, and fetch their fields', async () => {
  const { ctx, root, calls, teardown } = await setup(1440, { details: { 1: { files: [], fileStats: [] } } });
  ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1 });
  await flush();
  const list = root.querySelector('[role="tablist"]');
  assert.equal(selected(root).getAttribute('data-tab'), 'general');
  assert.equal(tabs(root).filter((tab) => tab.getAttribute('tabindex') === '0').length, 1);
  selected(root).dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(selected(root).getAttribute('data-tab'), 'files');
  assert.equal(env.doc.activeElement, selected(root));
  assert.equal(ctx.store.get().prefs.detailsTab, 'files');
  assert.equal(root.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), selected(root).getAttribute('id'));
  await flush();
  assert.deepEqual(calls.at(-1).args.fields, ['id', ...files.fields]);
  assert.deepEqual(tabs(root).map((tab) => tab.getAttribute('data-tab')), ['general', 'files', 'trackers', 'peers', 'options']);
  list.dispatch('keydown', { key: 'End' });
  assert.equal(selected(root).getAttribute('data-tab'), 'options');
  list.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(selected(root).getAttribute('data-tab'), 'general', 'wraps around');
  list.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(selected(root).getAttribute('data-tab'), 'options');
  teardown();
});

test('a live tab refetches on each poll, one request in flight at a time', async () => {
  let release;
  const pending = [];
  const { ctx, calls, teardown } = await setup(1440, {
    respond: (method) => {
      if (method !== 'torrent-get') return Promise.resolve({});
      return new Promise((resolve) => { pending.push(resolve); release = resolve; });
    },
  });
  ctx.store.set({ prefs: { detailsTab: 'peers' } });
  ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1 });
  await flush();
  assert.equal(calls.length, 1);
  ctx.store.set({ torrents: new Map([[1, torrent({ rateDownload: 5 })]]) });
  ctx.store.set({ torrents: new Map([[1, torrent({ rateDownload: 6 })]]) });
  await flush();
  assert.equal(calls.length, 1, 'polls during a request queue instead of stacking');
  release({ torrents: [{ id: 1, peers: [] }] });
  await flush();
  await flush();
  assert.equal(calls.length, 2, 'exactly one queued refetch runs');
  pending.at(-1)({ torrents: [{ id: 1, peers: [] }] });
  await flush();
  teardown();
});

test('a response for a torrent that lost focus is not rendered', async () => {
  const resolvers = [];
  const { ctx, root, teardown } = await setup(1440, {
    respond: (method, args) => new Promise((resolve) => resolvers.push({ id: args.ids[0], resolve })),
  });
  ctx.store.set({ prefs: { detailsTab: 'peers' } });
  ctx.store.set({ torrents: new Map([[1, torrent()], [2, torrent({ id: 2, name: 'second' })]]), focused: 1 });
  await flush();
  ctx.store.set({ focused: 2 });
  resolvers[0].resolve({ torrents: [{ id: 1, peers: [{ address: '192.0.2.10', port: 51413, clientName: 'Stale' }] }] });
  await flush();
  await flush();
  assert.ok(!root.textContent.includes('Stale'));
  teardown();
});

test('a failed fetch shows a load error, not an exception', async () => {
  const { ctx, root, teardown } = await setup(1440, {
    respond: () => Promise.reject(Object.assign(new Error('timeout'), { status: 0 })),
  });
  ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1 });
  await flush();
  await flush();
  const notice = root.querySelector('.details-notice');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Could not load details: Cannot reach Transmission/, 'a request that never reached the daemon reads as the translated offline text');
  teardown();
});

test('an unwired rpc (throws synchronously) degrades to a load error', async () => {
  const { ctx, root, teardown } = await setup(1440, {
    respond: () => { throw new Error('rpc.call is not wired yet'); },
  });
  ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1 });
  await flush();
  await flush();
  assert.match(root.querySelector('.details-notice').textContent, /not wired yet/);
  teardown();
});

test('on narrow screens openDetails opens a full-screen sheet; Escape closes it and returns focus', async () => {
  const { ctx, app, root, teardown } = await setup(375);
  ctx.store.set({ torrents: new Map([[7, torrent({ id: 7 })]]) });
  const opener = app.querySelector('.shell-table');
  opener.focus();
  details.openDetails(7, { tab: 'files' });
  await flush();
  assert.equal(ctx.store.get().focused, 7);
  assert.equal(app.getAttribute('data-details'), 'open');
  assert.equal(app.querySelector('.shell-table').inert, true, 'content behind the full-screen sheet is inert');
  assert.equal(selected(root).getAttribute('data-tab'), 'files');
  assert.equal(env.doc.activeElement, selected(root));
  const esc = selected(root).dispatch('keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(app.hasAttribute('data-details'), false);
  assert.equal(app.querySelector('.shell-table').inert, false);
  assert.equal(env.doc.activeElement, opener);
  teardown();
});

test('on medium screens the sheet is not modal and the back button closes it', async () => {
  const { ctx, app, root, teardown } = await setup(800);
  ctx.store.set({ torrents: new Map([[1, torrent()]]) });
  details.openDetails(1);
  assert.equal(app.getAttribute('data-details'), 'open');
  assert.equal(app.querySelector('.shell-table').inert, false);
  root.querySelector('.details-back').dispatch('click');
  assert.equal(app.hasAttribute('data-details'), false);
  teardown();
});

test('on wide screens openDetails sets focused, opens no sheet, and leaves keyboard focus alone', async () => {
  const { ctx, app, teardown } = await setup(1440);
  ctx.store.set({ torrents: new Map([[1, torrent()]]) });
  const list = app.querySelector('.shell-table');
  list.focus();
  details.openDetails(1);
  assert.equal(app.hasAttribute('data-details'), false);
  assert.equal(ctx.store.get().focused, 1);
  assert.equal(env.doc.activeElement, list, 'the list keeps focus on wide layouts');
  details.openDetails(1, { focus: true });
  assert.equal(env.doc.activeElement.getAttribute('role'), 'tab');
  teardown();
});

test('the resize grip moves by keyboard within bounds and persists in prefs', async () => {
  const { ctx, root, teardown } = await setup(1440);
  const grip = root.querySelector('.details-grip');
  assert.equal(grip.getAttribute('role'), 'separator');
  assert.equal(root.styles.get('--details-h'), '38%');
  grip.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(ctx.store.get().prefs.detailsHeight, 40);
  assert.equal(root.styles.get('--details-h'), '40%');
  assert.equal(grip.getAttribute('aria-valuenow'), '40');
  grip.dispatch('keydown', { key: 'Home' });
  assert.equal(ctx.store.get().prefs.detailsHeight, 70);
  grip.dispatch('keydown', { key: 'End' });
  assert.equal(ctx.store.get().prefs.detailsHeight, 20);
  teardown();
});

test('Options asks for sequential_download only when the caps say so; Trackers fetches nothing', async () => {
  const { ctx, root, calls, teardown } = await setup(1440, { details: { 1: {} } });
  ctx.caps = { sequential: true };
  ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1, prefs: { detailsTab: 'general' } });
  await flush();
  details.showTab('trackers');
  await flush();
  const before = calls.length;
  details.showTab('options');
  await flush();
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).args.fields.at(-1), 'sequential_download');
  void root;
  teardown();
});

test('a saved tab and height are restored on mount', async () => {
  env.media.width = 1440;
  const made = await makeCtx();
  made.ctx.store.set({ prefs: { detailsTab: 'peers', detailsHeight: 55 } });
  const { root } = shell();
  const teardown = details.mount(root, made.ctx);
  made.ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1 });
  assert.equal(selected(root).getAttribute('data-tab'), 'peers');
  assert.equal(root.styles.get('--details-h'), '55%');
  teardown();
});

test('a tab strip that scrolls marks the side that still hides tabs', async () => {
  const { root, teardown } = await setup(375);
  try {
    const strip = root.querySelector('[role="tablist"]');
    const measure = (scrollWidth, scrollLeft) => {
      Object.assign(strip, { scrollWidth, clientWidth: 363, scrollLeft });
      strip.dispatch('scroll');
      return [strip.hasAttribute('data-more-start'), strip.hasAttribute('data-more-end')];
    };
    assert.deepEqual(measure(400, 0), [false, true], 'more tabs to the right');
    assert.deepEqual(measure(400, 37), [true, false], 'more tabs to the left');
    assert.deepEqual(measure(363, 0), [false, false], 'no fade when every tab fits');
  } finally {
    teardown();
  }
});

/** Lay the five tabs out in a stub strip `width` px wide, honouring its scrollLeft. */
function layOutStrip(strip, width, tabWidth = 76) {
  const buttons = strip.querySelectorAll('[role="tab"]');
  Object.assign(strip, { clientWidth: width, scrollWidth: tabWidth * buttons.length, scrollLeft: 0 });
  strip.getBoundingClientRect = () => ({ left: 0, right: width, width });
  buttons.forEach((b, i) => {
    b.getBoundingClientRect = () => {
      const left = i * tabWidth - strip.scrollLeft;
      return { left, right: left + tabWidth, width: tabWidth };
    };
  });
  return buttons;
}

const fullyInside = (strip, button) => {
  const box = button.getBoundingClientRect();
  return box.left >= 0 && box.right <= strip.clientWidth;
};

test('at 320px the restored last tab is scrolled fully into view on open and on resize, without taking focus', async () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} };
  const made = await makeCtx();
  made.ctx.store.set({ prefs: { ...made.ctx.store.get().prefs, detailsTab: 'options' } });
  env.media.width = 320;
  const { app, root } = shell();
  const teardown = details.mount(root, made.ctx);
  try {
    const strip = root.querySelector('[role="tablist"]');
    const buttons = layOutStrip(strip, 304);
    const options = buttons.find((b) => b.getAttribute('data-tab') === 'options');
    const focusBefore = env.doc.activeElement;
    observers.forEach((o) => o.fn());
    assert.equal(options.getAttribute('aria-selected'), 'true');
    assert.ok(fullyInside(strip, options), 'the restored tab is fully inside the strip');
    assert.equal(strip.hasAttribute('data-more-start'), true, 'the fade marks the hidden first tabs');
    assert.equal(env.doc.activeElement, focusBefore, 'revealing did not move focus');

    details.showTab('general');
    const general = buttons.find((b) => b.getAttribute('data-tab') === 'general');
    assert.ok(fullyInside(strip, general), 'a tab chosen through the API is revealed too');

    strip.scrollLeft = 70;
    made.ctx.store.set({ torrents: new Map([[1, torrent()]]), focused: 1 });
    await flush();
    assert.equal(strip.scrollLeft, 70, 'a render that keeps the same tab leaves the user scroll alone');
    void app;
  } finally {
    teardown();
    delete globalThis.ResizeObserver;
  }
});
