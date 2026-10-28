import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { installDom, makeCtx, flush, torrent, FakeElement } from './details-dom.js';

const env = installDom();
const dialogs = await import('../../src/app/js/ui/dialogs/index.js');
const { ICON_NAMES } = await import('../../src/app/js/core/icons.js');

async function mounted() {
  const made = await makeCtx();
  const app = new FakeElement('div');
  app.setAttribute('id', 'app');
  const table = new FakeElement('section');
  const region = new FakeElement('div');
  app.append(table, region);
  env.body.replaceChildren(app);
  const teardown = dialogs.mount(region, made.ctx);
  made.ctx.store.set({
    torrents: new Map([
      [1, torrent({ id: 1, name: '<i>first</i>' })],
      [2, torrent({ id: 2, name: 'second' })],
      [3, torrent({ id: 3, name: 'third' })],
    ]),
    selection: new Set([1, 2, 3]),
    focused: 2,
  });
  return { ...made, table, teardown };
}

test('a bubbling remove-request opens a destructive confirm focused on Cancel, data kept by default', async () => {
  const { table, dialogs: opened, calls, ctx, teardown } = await mounted();
  table.dispatch('remove-request', { detail: { ids: [1, 2] } });
  const record = opened.at(-1);
  assert.equal(record.opts.tone, 'danger');
  assert.equal(record.opts.title, 'Remove 2 torrents?');
  const [cancel, confirm] = record.opts.actions;
  assert.equal(record.opts.initialFocus, cancel);
  assert.equal(cancel.textContent, 'Cancel');
  assert.equal(confirm.textContent, 'Remove');
  const names = record.opts.body[0].querySelectorAll('li').map((li) => li.textContent);
  assert.deepEqual(names, ['<i>first</i>', 'second']);
  const box = record.opts.body[1].querySelector('input');
  assert.equal(box.checked, false);
  confirm.dispatch('click');
  await flush();
  assert.deepEqual(calls.at(-1), { method: 'torrent-remove', args: { ids: [1, 2], 'delete-local-data': false } });
  assert.deepEqual([...ctx.store.get().selection], [3]);
  assert.equal(ctx.store.get().focused, null);
  assert.equal(record.closed, 'removed');
  teardown();
});

test('ticking delete data changes the button, warns, and sends delete-local-data', async () => {
  const { dialogs: opened, calls, teardown } = await mounted();
  dialogs.openRemove([3]);
  const record = opened.at(-1);
  assert.equal(record.opts.title, 'Remove this torrent?');
  const box = record.opts.body[1].querySelector('input');
  box.checked = true;
  box.dispatch('change');
  const confirm = record.opts.actions[1];
  assert.equal(confirm.textContent, 'Remove and delete data');
  assert.equal(record.opts.body[2].hidden, false);
  confirm.dispatch('click');
  await flush();
  assert.deepEqual(calls.at(-1).args, { ids: [3], 'delete-local-data': true });
  teardown();
});

test('unknown ids open nothing; a failed remove keeps the dialog and re-enables the button', async () => {
  const { ctx, dialogs: opened, toasts, teardown } = await mounted();
  dialogs.openRemove([99]);
  assert.equal(opened.length, 0);
  ctx.rpc.call = () => Promise.reject(new Error('forbidden'));
  dialogs.openRemove([1]);
  const record = opened.at(-1);
  record.opts.actions[1].dispatch('click');
  await flush();
  assert.equal(record.closed, null);
  assert.equal(record.opts.actions[1].disabled, false);
  assert.match(toasts.at(-1).message, /Could not remove: forbidden/);
  teardown();
});

test('more than five torrents are summarised after the first five names', async () => {
  const made = await makeCtx();
  const region = new FakeElement('div');
  env.body.replaceChildren(region);
  const teardown = dialogs.mount(region, made.ctx);
  const many = new Map(Array.from({ length: 8 }, (_, i) => [i + 1, torrent({ id: i + 1, name: `t${i + 1}` })]));
  made.ctx.store.set({ torrents: many });
  dialogs.openRemove([...many.keys()]);
  const items = made.dialogs.at(-1).opts.body[0].querySelectorAll('li').map((li) => li.textContent);
  assert.deepEqual(items, ['t1', 't2', 't3', 't4', 't5', 'and 3 more']);
  teardown();
});

test('every icon name the views use exists in the icon set', () => {
  const dirs = ['../../src/app/js/ui/details/', '../../src/app/js/ui/dialogs/'];
  const used = new Set();
  for (const dir of dirs) {
    const url = new URL(dir, import.meta.url);
    for (const file of readdirSync(url)) {
      const text = readFileSync(new URL(file, url), 'utf8');
      for (const m of text.matchAll(/(?:icon\(|icon: )'([a-z0-9-]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/, '(file-[a-z]+)'\]/g)) used.add(m[1]);
      for (const line of text.split('\n').filter((l) => /const glyph =/.test(l))) {
        for (const m of line.matchAll(/'([a-z]+-[a-z0-9-]+)'/g)) used.add(m[1]);
      }
    }
  }
  assert.ok(used.size > 10, `scanned ${used.size} names`);
  for (const name of used) assert.ok(ICON_NAMES.includes(name), `icon "${name}" exists`);
});
