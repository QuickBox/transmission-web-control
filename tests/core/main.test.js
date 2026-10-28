import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attributes = new Map();
    this.children = [];
    this.style = { setProperty() {} };
  }
  setAttribute(k, v) { this.attributes.set(k, v); }
  addEventListener() {}
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  querySelector(sel) {
    const m = /^\[data-region="(\w+)"\]$/.exec(sel);
    if (!m) return null;
    return this.children.find((c) => c.attributes && c.attributes.get('data-region') === m[1]) || null;
  }
}

const root = new FakeNode('html');
globalThis.document = {
  documentElement: root,
  cookie: 'Language=de',
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag),
  getElementById: () => null,
  addEventListener() {},
};
globalThis.addEventListener = () => {};

const { boot, MODULES } = await import('../../src/app/js/main.js');

test('boot mounts every module into its own region and publishes the context', async () => {
  const app = new FakeNode('div');
  const existing = new FakeNode('div');
  existing.setAttribute('data-region', 'table');
  app.append(existing);

  const ctx = await boot(app);

  const regions = app.children.map((c) => c.attributes.get('data-region'));
  assert.deepEqual(regions.sort(), MODULES.map(([name]) => name).sort());
  assert.equal(app.children.filter((c) => c === existing).length, 1);
  assert.equal(root.attributes.get('lang'), 'de');

  assert.deepEqual(Object.keys(ctx).sort(), ['caps', 'fmt', 'i18n', 'rpc', 'store', 'ui']);
  assert.deepEqual(Object.keys(ctx.ui).sort(),
    ['clear', 'confirm', 'el', 'icon', 'menu', 'openDialog', 'svg', 'toast', 'tooltip']);
  assert.equal(typeof ctx.i18n, 'function');
  assert.equal(ctx.i18n.lang, 'de');
  assert.equal(typeof ctx.store.subscribe, 'function');
  assert.equal(ctx.fmt.bytes(1500), '1,50 kB');
  for (const name of ['icon', 'tooltip', 'toast', 'openDialog', 'confirm', 'menu']) {
    assert.equal(typeof ctx.ui[name], 'function', name);
  }
  assert.equal(existing.attributes.get('aria-label'), 'core.regions.table');
  assert.equal(root.attributes.get('data-qb-variant'), 'spectre');
  assert.throws(() => ctx.rpc.call('session-get'), /rpc\.call is not wired yet/);
});
