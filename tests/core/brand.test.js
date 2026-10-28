import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from '../ui/details-dom.js';

installDom();
const { MARK_RATIO, MARK_SHAPES, MARK_VIEWBOX, quickboxMark } = await import('../../src/app/js/core/brand.js');

/** Every attribute value and inline style on a node and its descendants. */
function values(node, out = []) {
  for (const v of node.attributes.values()) out.push(v);
  for (const v of node.styles.values()) out.push(v);
  for (const c of node.children) if (c.nodeType === 1) values(c, out);
  return out;
}

test('the mark is the ten visible brand shapes, each filled from a brand token', () => {
  assert.equal(MARK_SHAPES.length, 10);
  const fills = new Set(MARK_SHAPES.map((s) => s.fill));
  assert.deepEqual([...fills].sort(), ['green', 'greenDeep', 'grey', 'greyLight']);
  for (const s of MARK_SHAPES) {
    assert.ok(s.tag === 'path' || s.tag === 'polygon');
    assert.equal(typeof (s.d ?? s.points), 'string');
    const first = (s.d ?? s.points).match(/-?\d+\.?\d*/g).slice(0, 2).map(Number);
    assert.ok(first[0] >= 0 && first[0] <= 447.6 && first[1] >= 0 && first[1] <= 378.5, `shape starts inside the viewBox: ${first}`);
  }
  assert.equal(MARK_VIEWBOX, '0 0 447.6 378.5');
  assert.ok(Math.abs(MARK_RATIO - 447.6 / 378.5) < 1e-9);
});

test('decorative by default: aria-hidden, sized from width, no title, no hex, no URL', () => {
  const mark = quickboxMark({ size: 30 });
  assert.equal(mark.tagName, 'SVG');
  assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(mark.getAttribute('role'), null);
  assert.equal(mark.getAttribute('width'), '30');
  assert.equal(mark.getAttribute('height'), String(Math.round((30 / MARK_RATIO) * 10) / 10));
  assert.equal(mark.getAttribute('focusable'), 'false');
  assert.equal(mark.getAttribute('class'), 'brand-mark');
  assert.equal(mark.children.length, 10);
  const all = values(mark);
  assert.ok(all.every((v) => !/#[0-9a-f]{3,8}\b/i.test(v)), 'no hex colour on the mark');
  assert.ok(all.every((v) => !/https?:\/\//.test(v)), 'no URL on the mark');
  assert.equal(mark.getAttribute('title'), null);
  for (const shape of mark.children) {
    assert.match(shape.styles.get('fill'), /^var\(--qb-brand-(green|green-deep|grey|grey-light)\)$/);
    assert.equal(shape.getAttribute('fill'), null, 'fill comes from the token, not an attribute');
    assert.equal(shape.getAttribute('title'), null);
  }
});

test('with a label it is an image with that name; className is appended', () => {
  const mark = quickboxMark({ size: 56, label: 'QuickBox', className: 'about-mark' });
  assert.equal(mark.getAttribute('role'), 'img');
  assert.equal(mark.getAttribute('aria-label'), 'QuickBox');
  assert.equal(mark.getAttribute('aria-hidden'), null);
  assert.equal(mark.getAttribute('class'), 'brand-mark about-mark');
  assert.equal(quickboxMark().getAttribute('width'), '24', 'default size');
  assert.equal(quickboxMark({ size: -5 }).getAttribute('width'), '24', 'bad size falls back');
});

test('the module itself carries no hex colour and no URL', () => {
  const text = readFileSync(new URL('../../src/app/js/core/brand.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.ok(text.length < 20_000, `brand.js stays small (${text.length} bytes)`);
});
