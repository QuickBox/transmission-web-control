import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeCtx, flush, torrent } from './details-dom.js';

installDom();
const rename = await import('../../src/app/js/ui/dialogs/rename.js');

test('name checks: empty, slash, dot names', () => {
  assert.equal(rename.nameProblem(''), 'empty');
  assert.equal(rename.nameProblem('a/b'), 'slash');
  assert.equal(rename.nameProblem('..'), 'dots');
  assert.equal(rename.nameProblem('Show (2024)'), null);
});

async function setup() {
  const made = await makeCtx();
  made.ctx.store.set({ torrents: new Map([[4, torrent({ id: 4, name: '<b>Old<b>' })]]) });
  return made;
}

test('rename prefills the name as text, validates, then calls torrent-rename-path with the old name as path', async () => {
  const { ctx, dialogs, calls, toasts } = await setup();
  const handle = rename.createRenameDialog(ctx).open(4);
  const record = dialogs.at(-1);
  assert.equal(record.opts.title, 'Rename torrent');
  assert.equal(record.opts.description, '<b>Old<b>');
  assert.equal(record.opts.initialFocus, handle.field);
  assert.equal(handle.field.value, '<b>Old<b>');
  handle.field.value = 'a/b';
  record.opts.actions[1].dispatch('click');
  assert.equal(handle.field.getAttribute('aria-invalid'), 'true');
  assert.match(record.opts.body.textContent, /cannot contain a slash/);
  handle.field.value = '  New name ';
  record.opts.actions[1].dispatch('click');
  await flush();
  assert.deepEqual(calls.at(-1), { method: 'torrent-rename-path', args: { ids: [4], path: '<b>Old<b>', name: 'New name' } });
  assert.equal(record.closed, 'saved');
  assert.equal(toasts.at(-1).message, 'Renamed to New name');
});

test('an unchanged name closes without a request; an rpc error stays in the dialog', async () => {
  const { ctx, dialogs, calls } = await setup();
  rename.createRenameDialog(ctx).open(4);
  dialogs.at(-1).opts.actions[1].dispatch('click');
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(dialogs.at(-1).closed, 'saved');
  ctx.rpc.call = () => Promise.reject(new Error('Invalid argument'));
  const handle = rename.createRenameDialog(ctx).open(4);
  handle.field.value = 'other';
  dialogs.at(-1).opts.actions[1].dispatch('click');
  await flush();
  assert.equal(dialogs.at(-1).closed, null);
  assert.match(dialogs.at(-1).opts.body.textContent, /Invalid argument/);
  assert.equal(dialogs.at(-1).opts.actions[1].disabled, false);
});

test('an unknown torrent opens nothing', async () => {
  const { ctx, dialogs } = await setup();
  assert.equal(rename.createRenameDialog(ctx).open(99), null);
  assert.equal(dialogs.length, 0);
});
