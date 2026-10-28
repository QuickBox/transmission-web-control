import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, chromeCtx, shell, click, byAction, flush } from './chrome-dom.js';

const env = installChromeDom();
const { BULK_ACTIONS, mount } = await import('../../src/app/js/ui/bulkbar.js');

async function setup() {
  const made = await chromeCtx();
  const { regions } = shell(env);
  const teardown = mount(regions.bulkbar, made.ctx);
  return { ...made, root: regions.bulkbar, teardown };
}

test('empty without a selection; renders count, Start, Pause, Remove, More and Clear with one', async () => {
  const { ctx, root, teardown } = await setup();
  assert.equal(root.children.length, 0);
  assert.equal(root.getAttribute('role'), null);
  assert.deepEqual(BULK_ACTIONS, ['start', 'pause', 'remove']);

  ctx.store.set({ selection: new Set([4, 9]) });
  assert.equal(root.getAttribute('role'), 'toolbar');
  assert.equal(root.getAttribute('aria-label'), '2 selected');
  assert.equal(root.querySelector('.bulk-count').textContent, '2 selected');
  for (const id of BULK_ACTIONS) {
    const button = byAction(root, id);
    assert.ok(button, id);
    assert.equal(button.getAttribute('title'), null);
    assert.ok(button.getAttribute('aria-label'));
  }
  assert.ok(root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'More'));
  assert.ok(root.querySelector('.bulk-clear'));

  ctx.store.set({ selection: new Set() });
  assert.equal(root.children.length, 0, 'emptied again, which hides the bar');
  teardown();
});

test('Start runs on the current selection; More lists the remaining actions; Clear empties the selection', async () => {
  const { ctx, root, calls, ticks, menus, teardown } = await setup();
  ctx.store.set({ selection: new Set([4, 9]) });
  click(byAction(root, 'start'));
  await flush();
  assert.deepEqual(calls, [{ method: 'torrent-start', args: { ids: [4, 9] } }]);
  assert.equal(ticks.length, 1);

  click(root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'More'));
  assert.equal(menus.length, 1);
  const labels = menus[0].items.map((i) => i.label);
  assert.ok(labels.includes('Verify local data') && labels.includes('Move to top') && labels.includes('Set location'));
  assert.ok(!labels.includes('Start') && !labels.includes('Remove'), 'bulk buttons are not repeated in More');

  click(root.querySelector('.bulk-clear'));
  assert.equal(ctx.store.get().selection.size, 0);
  assert.equal(root.children.length, 0);
  teardown();
});

test('teardown empties the region and unsubscribes', async () => {
  const { ctx, root, teardown } = await setup();
  ctx.store.set({ selection: new Set([1]) });
  assert.ok(root.children.length > 0);
  teardown();
  assert.equal(root.children.length, 0);
  ctx.store.set({ selection: new Set([1, 2]) });
  assert.equal(root.children.length, 0);
});
