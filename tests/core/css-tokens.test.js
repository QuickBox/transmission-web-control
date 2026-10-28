import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../../src/app/', import.meta.url);
const read = (dir) => readdirSync(new URL(dir, root)).filter((f) => /\.(css|js)$/.test(f)).map((f) => [`${dir}${f}`, readFileSync(new URL(`${dir}${f}`, root), 'utf8')]);

function sources() {
  const out = [...read('css/')];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith('.js')) out.push([`${dir}${entry.name}`, readFileSync(new URL(`${dir}${entry.name}`, root), 'utf8')]);
    }
  };
  walk('js/');
  return out;
}

test('every custom property a stylesheet reads is defined by a stylesheet or set from script', () => {
  const files = sources();
  const defined = new Set();
  for (const [, text] of files) {
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    for (const m of text.matchAll(/['"`](--[\w-]+)['"`]/g)) defined.add(m[1]);
  }
  const missing = [];
  for (const [name, text] of files.filter(([n]) => n.endsWith('.css'))) {
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      // `var(--x, fallback)` is allowed to read an optional token
      if (!defined.has(m[1]) && m[2] === ')') missing.push(`${name}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'an undefined var() with no fallback paints nothing');
});
