import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const SRC = new URL('../../src/', import.meta.url);
const html = readFileSync(new URL('index.html', SRC), 'utf8');

test('the browser tab icon is the one Transmission ships next to the app', () => {
  const links = [...html.matchAll(/<link\s+rel="icon"[^>]*>/g)].map((m) => m[0]);
  assert.equal(links.length, 1, 'exactly one icon link');
  assert.match(links[0], /href="images\/favicon\.ico"/, 'relative, unstamped path into the stock web directory');
  assert.doesNotMatch(links[0], /__QBV__/);
  assert.doesNotMatch(html, /favicon\.svg/, 'no SVG icon link: 2.94 and 3.00 ship none');
  assert.equal(existsSync(new URL('favicon.ico', SRC)), false, 'the app ships no favicon of its own');
});
