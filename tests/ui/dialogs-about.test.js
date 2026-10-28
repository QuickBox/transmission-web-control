import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, makeCtx } from './details-dom.js';

installDom();
const about = await import('../../src/app/js/ui/dialogs/about.js');
const { VERSION } = await import('../../src/app/js/version.js');

test('daemon info reads the session version and the caps', () => {
  assert.deepEqual(about.daemonInfo({ version: '4.1.3 (abc)' }, { rpc: 19, semver: '6.0.1', dialect: 'jsonrpc' }),
    { version: '4.1.3 (abc)', rpc: { semver: '6.0.1', rpc: 19, dialect: 'jsonrpc' } });
  assert.deepEqual(about.daemonInfo({}, null), { version: null, rpc: null });
  assert.deepEqual(about.daemonInfo({ version: '2.94' }, { rpc: 15, semver: null, dialect: 'legacy' }).rpc,
    { semver: null, rpc: 15, dialect: 'legacy' });
});

test('About shows the mark, versions, a plain-text credit and only a local link', async () => {
  const { ctx, dialogs } = await makeCtx();
  ctx.caps = { rpc: 19, semver: '6.0.1', dialect: 'jsonrpc' };
  ctx.store.set({ session: { version: '4.1.3 (b2e5f2b)' } });
  about.createAboutDialog(ctx).open();
  const record = dialogs.at(-1);
  const body = record.opts.body;
  assert.equal(record.opts.title, 'About');
  assert.equal(record.opts.initialFocus, record.opts.actions[0]);
  const mark = body.querySelector('svg');
  assert.equal(mark.getAttribute('role'), 'img');
  assert.equal(mark.getAttribute('aria-label'), 'QuickBox');
  assert.match(body.textContent, new RegExp(`Version ${VERSION.replace(/\./g, '\\.')}`));
  assert.match(body.textContent, /4\.1\.3 \(b2e5f2b\)/);
  assert.match(body.textContent, /RPC 6\.0\.1 · version 19 · JSON-RPC/);
  const credit = body.querySelector('.about-credit');
  assert.equal(credit.textContent, 'Based on Transmission Web Control by ronggang (MIT)');
  assert.equal(credit.tagName, 'P');
  const links = body.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'index.original.html');
  assert.equal(links[0].textContent, 'Original web interface');
});

test('About with no session or caps says unknown instead of failing', async () => {
  const { ctx, dialogs } = await makeCtx();
  about.createAboutDialog(ctx).open();
  assert.match(dialogs.at(-1).opts.body.textContent, /TransmissionUnknown.*RPCUnknown/);
});

test('the about module carries no remote URL', () => {
  const text = readFileSync(new URL('../../src/app/js/ui/dialogs/about.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /https?:\/\//);
});
