import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/app/js/version.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const SEMVER = /^\d+\.\d+\.\d+$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('VERSION is a plain SemVer', () => {
  assert.match(VERSION, SEMVER);
});

test('package.json and the newest changelog entry carry the same version', () => {
  assert.equal(JSON.parse(read('package.json')).version, VERSION);
  const index = JSON.parse(read('changelogs/index.json'));
  assert.ok(Array.isArray(index) && index.length > 0);
  assert.equal(index[0].version, VERSION);
});

test('version.js has no imports, so it loads before any cache key is stamped', () => {
  assert.doesNotMatch(read('src/app/js/version.js'), /^\s*import\b/m);
});

test('every relative static import in the app carries the release cache key', () => {
  const missing = [];
  for (const file of walk(join(REPO, 'src', 'app', 'js')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      if (!m[1].endsWith('?v=__QBV__')) missing.push(`${file.slice(REPO.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the entry page loads app assets through the release cache key', () => {
  const html = read('src/index.html');
  const refs = [...html.matchAll(/\b(?:href|src)="(app\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  assert.deepEqual(refs.filter((r) => !r.endsWith('?v=__QBV__')), []);
});
