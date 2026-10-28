import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag, ns = null) {
    this.tag = tag;
    this.ns = ns;
    this.attributes = new Map();
    this.children = [];
    this.listeners = [];
    this.styles = new Map();
    this.textContent = '';
    this.style = { setProperty: (k, v) => this.styles.set(k, v) };
  }
  setAttribute(k, v) { this.attributes.set(k, v); }
  addEventListener(type, fn) { this.listeners.push([type, fn]); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (ns, tag) => new FakeNode(tag, ns),
};

const { el, svg, clear } = await import('../../src/app/js/core/dom.js');

test('text renders as text, children flatten, falsy children skip', () => {
  const name = '<img src=x onerror=alert(1)>';
  const node = el('span', { text: name });
  assert.equal(node.textContent, name);
  assert.equal(node.children.length, 0);
  const list = el('ul', {}, [el('li'), null, false, [el('li'), 'tail'], 0]);
  assert.equal(list.children.length, 4);
  assert.equal(list.children[2], 'tail');
  assert.equal(list.children[3], '0');
});

test('attributes go through setAttribute; booleans and nulls behave', () => {
  const node = el('button', {
    class: ['btn', false, 'btn-primary'],
    type: 'button',
    'aria-pressed': 'true',
    'data-id': 7,
    tabindex: null,
    autofocus: true,
    inert: false,
  });
  assert.equal(node.attributes.get('class'), 'btn btn-primary');
  assert.equal(node.attributes.get('data-id'), '7');
  assert.equal(node.attributes.get('autofocus'), '');
  assert.equal(node.attributes.has('tabindex'), false);
  assert.equal(node.attributes.has('inert'), false);
});

test('form state is set as properties, events through addEventListener', () => {
  const fn = () => {};
  const input = el('input', { type: 'checkbox', checked: true, value: 'x', on: { change: fn } });
  assert.equal(input.checked, true);
  assert.equal(input.value, 'x');
  assert.equal(input.attributes.has('checked'), false);
  assert.deepEqual(input.listeners, [['change', fn]]);
});

test('a select value is set after its options exist', () => {
  let optionsAtSet = -1;
  const original = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const node = original(tag);
    if (tag === 'select') {
      Object.defineProperty(node, 'value', { set() { optionsAtSet = node.children.length; } });
    }
    return node;
  };
  try {
    el('select', { value: 'b' }, [el('option', { value: 'a' }), el('option', { value: 'b' })]);
  } finally {
    globalThis.document.createElement = original;
  }
  assert.equal(optionsAtSet, 2);
});

test('style is an object applied with setProperty', () => {
  const node = el('div', { style: { '--qb-w': '12px', width: null } });
  assert.equal(node.styles.get('--qb-w'), '12px');
  assert.equal(node.styles.has('width'), false);
  assert.throws(() => el('div', { style: 'color: red' }), /style must be an object/);
});

test('markup, handler strings, native tooltips and unknown props are refused', () => {
  for (const key of ['innerHTML', 'outerHTML', 'srcdoc', 'onclick', 'onError', 'title', 'src', 'formaction']) {
    assert.throws(() => el('div', { [key]: 'x' }), TypeError, key);
  }
  assert.throws(() => el('div', { on: { click: 'alert(1)' } }), /not a function/);
});

test('href allows fragments, same-origin relative paths and blob: only', () => {
  for (const href of [
    'index.original.html', './index.original.html', '../web/index.html', 'a/b-c_d.html?x=1&y=2#top',
    'folder/', '#settings', '#', 'blob:abc', 'blob:http:%2F%2Fhost/1f2e-3d',
  ]) {
    assert.equal(el('a', { href }).attributes.get('href'), href, href);
  }
  for (const href of [
    'javascript:alert(1)', ' JavaScript:x', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0001javascript:x',
    'data:text/html,x', 'mailto:a@b', 'ftp:x', 'vbscript:x',
    '//evil.example/x', '/\\evil.example', '\\\\evil.example', '/index.html', 'a b.html', 'a/../:b',
    '', ' ', 'index.html?q=<x>', 'blob: x',
  ]) {
    assert.throws(() => el('a', { href }), /refused href/, JSON.stringify(href));
  }
});

test('svg builds in the SVG namespace with its own allowlist', () => {
  const icon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'ic' }, [svg('path', { d: 'M0 0h24' })]);
  assert.equal(icon.ns, 'http://www.w3.org/2000/svg');
  assert.equal(icon.attributes.get('viewBox'), '0 0 24 24');
  assert.equal(icon.children[0].attributes.get('d'), 'M0 0h24');
  assert.throws(() => svg('svg', { onload: 'x' }), /refused handler/);
  assert.throws(() => svg('use', { href: '#x' }), /refused property/);
  assert.throws(() => svg('svg', { checked: true }), /refused property/);
});

test('clear replaces every child', () => {
  const node = el('div', {}, [el('span'), el('span')]);
  clear(node, 'only');
  assert.deepEqual(node.children, ['only']);
  clear(node);
  assert.deepEqual(node.children, []);
});
