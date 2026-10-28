#!/usr/bin/env node
/**
 * Static gates over the shipped app tree (`src/app`).
 *
 *   node tools/check.mjs            scan, exit 1 on any hit or on zero files
 *   node tools/check.mjs --selftest prove every gate fires and every exemption holds
 *
 * Gates:
 *   hex         a hex colour outside `css/tokens.css`
 *   sink        a markup sink (innerHTML, insertAdjacentHTML, outerHTML,
 *               document.write, srcdoc, DOMParser, createContextualFragment)
 *   title       a native title attribute or `.title =` (document.title is allowed)
 *   url         an absolute or protocol-relative URL other than the SVG namespace
 *   stripe      a left border or inset stripe accent
 *   rpc-version the RPC version read outside `js/rpc/caps.js`
 *   mjs         a `.mjs` file (the daemon's web server is only known to serve `.js`)
 */

import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.mjs']);
const SVG_NS = 'http://www.w3.org/2000/svg';

const GATES = [
  {
    id: 'hex',
    skip: (rel) => rel === 'css/tokens.css',
    test: (line) => /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/i.test(line),
  },
  {
    id: 'sink',
    test: (line) => /\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc|DOMParser|createContextualFragment)\b|document\.write/.test(line),
  },
  {
    id: 'title',
    test: (line) => /\btitle=["'`]/.test(line)
      || /(?<!document)\.title\s*=(?!=)/.test(line)
      || /setAttribute\(\s*["'`]title["'`]/.test(line),
  },
  {
    id: 'url',
    test: (line) => {
      for (const m of line.matchAll(/https?:\/\/[^\s'"`)<>,]*/gi)) {
        if (m[0] !== SVG_NS) return true;
      }
      return /["'`(=]\s*\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(line);
    },
  },
  {
    id: 'stripe',
    test: (line) => /\bborder-(?:left|inline-start)(?:-[a-z]+)?\s*:/.test(line)
      || /\bborder(?:Left|InlineStart)\w*\b/.test(line)
      || /\binset\s+-?\d*\.?\d+(?:px|rem|em)\s+0(?:px)?\s/.test(line),
  },
  {
    id: 'rpc-version',
    skip: (rel) => rel === 'js/rpc/caps.js',
    test: (line) => /(?<![Tt]ransmission-)rpc[-_]version/.test(line),
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

/**
 * @param {string} appDir the directory to scan (normally `src/app`)
 * @returns {{ files: number, hits: string[] }}
 */
export function scan(appDir) {
  const files = walk(appDir);
  const hits = [];
  for (const file of files) {
    const rel = relative(appDir, file).split(sep).join('/');
    if (rel.endsWith('.mjs')) hits.push(`${rel}: [mjs] modules must be .js`);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const gate of GATES) {
        if (gate.skip && gate.skip(rel)) continue;
        if (gate.test(line)) hits.push(`${rel}:${i + 1}: [${gate.id}] ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return { files: files.length, hits };
}

function report(appDir) {
  const { files, hits } = scan(appDir);
  for (const hit of hits) console.log(hit);
  if (files === 0) {
    console.log(`check: FAIL, scanned 0 files under ${appDir}`);
    return 1;
  }
  console.log(`check: ${hits.length ? 'FAIL' : 'ok'}, ${files} files, ${hits.length} hits`);
  return hits.length ? 1 : 0;
}

const BAD = {
  'js/a.js': 'node.innerHTML = name;',
  'js/b.js': 'node.insertAdjacentHTML("beforeend", s);',
  'js/c.js': 'document.write(s);',
  'js/d.js': 'const c = "#1e293b";',
  'css/e.css': '.x { color: #fff; }',
  'js/f.js': 'button.title = label;',
  'js/g.html': '<span title="x">y</span>',
  'js/h.js': 'node.setAttribute("title", s);',
  'js/i.js': 'fetch("https://api.example.test/x");',
  'js/j.js': 'const u = "//cdn.example.test/font.css";',
  'css/k.css': '.row { border-left: 3px solid red; }',
  'css/l.css': '.row { box-shadow: inset 3px 0 0 red; }',
  'js/m.js': 'if (session["rpc-version"] > 15) {}',
  'js/n.js': 'const v = s.rpc_version_semver;',
  'js/o.mjs': 'export {};',
  'i18n/en/p.json': '{"a": "see https://example.test"}',
  'js/q.js': 'node.style.borderLeftColor = c;',
  'js/r.js': 'const ns = "https://www.w3.org/2000/svg";',
};

const GOOD = {
  'css/tokens.css': ':root { --qb-bg: #0b1220; }',
  'js/rpc/caps.js': 'const v = session["rpc-version-semver"] || session["rpc-version"];',
  'js/rpc/client.js': 'const RPC_VERSION_HEADER = "X-Transmission-Rpc-Version"; h.get("x-transmission-rpc-version");',
  'js/core/icons.js': 'document.createElementNS("http://www.w3.org/2000/svg", "svg");',
  'js/main.js': 'document.title = name; openDialog({ title: t("x") }); const { title = "" } = o;',
  'js/core/dom.js': 'node.textContent = text; app.querySelector("#app");',
  'css/base.css': '.btn { border: 1px solid var(--qb-border); box-shadow: 0 0 0 2px var(--qb-ring); }',
  'i18n/en/core.json': '{"a": "Speed {size}/s", "b": "#1 in queue"}',
};

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${body}\n`);
  }
}

function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'twc-check-'));
  const failures = [];
  try {
    const empty = join(base, 'empty');
    mkdirSync(empty);
    if (scan(empty).files !== 0) failures.push('empty tree reported files');
    if (report(empty) === 0) failures.push('zero files passed');

    const good = join(base, 'good');
    writeTree(good, GOOD);
    const g = scan(good);
    if (g.hits.length) failures.push(`clean tree hit:\n  ${g.hits.join('\n  ')}`);
    if (report(good) !== 0) failures.push('clean tree did not pass');

    for (const [rel, body] of Object.entries(BAD)) {
      const dir = join(base, `bad-${rel.replace(/[^\w]/g, '_')}`);
      writeTree(dir, { ...GOOD, [rel]: body });
      const b = scan(dir);
      if (!b.hits.some((h) => h.startsWith(rel))) failures.push(`not caught: ${rel} ${body}`);
      if (report(dir) === 0) failures.push(`passed with a hit: ${rel}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const cases = 2 + 2 + Object.keys(BAD).length * 2;
  if (failures.length) {
    console.log(`selftest: FAIL\n${failures.join('\n')}`);
    return 1;
  }
  console.log(`selftest: ok, ${cases} assertions (empty tree fails, clean tree passes, ${Object.keys(BAD).length} violations caught)`);
  return 0;
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  process.exitCode = selftest();
} else {
  process.exitCode = report(join(REPO, 'src', 'app'));
}
