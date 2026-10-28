import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeDom, chromeCtx, shell, click } from './chrome-dom.js';

const env = installChromeDom();
const { DEBOUNCE_MS, createSearch, shortcutLabel } = await import('../../src/app/js/ui/search.js');

function fakeTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
    pending: () => [...pending.values()],
    flush() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
  };
}

async function setup() {
  const made = await chromeCtx();
  shell(env);
  const timers = fakeTimers();
  const escapes = [];
  const search = createSearch(made.ctx, { timers, onEscape: () => escapes.push(1) });
  return { ...made, timers, escapes, search };
}

test('shortcut label follows the platform', () => {
  const label = shortcutLabel();
  assert.ok(label === 'Ctrl K' || label === '⌘ K');
});

test('every locale placeholder fits the field the stylesheet sizes for it', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const i18n = new URL('../../src/app/i18n/', import.meta.url);
  const css = readFileSync(new URL('../../src/app/css/chrome.css', import.meta.url), 'utf8');
  const width = Number(/\.search \{[^}]*?width: (\d+)px/.exec(css)?.[1]);
  const longest = { lang: '', text: '' };
  for (const lang of readdirSync(i18n, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const main = JSON.parse(readFileSync(new URL(`${lang}/main.json`, i18n), 'utf8'));
    const text = main.search && main.search.placeholder;
    if (text && text.length > longest.text.length) Object.assign(longest, { lang, text });
  }
  // 34px icon padding + 62px chip padding leave `width - 96px`; the widest
  // Latin fallback font sets 14px text at about 7.5px per character.
  assert.ok(width >= 272, `search field width ${width}px`);
  assert.ok(longest.text.length * 7.5 <= width - 96, `${longest.lang} placeholder "${longest.text}" is too long for ${width}px`);
});

test('typing debounces into filter.search; Enter commits at once; the clear button empties it', async () => {
  const { ctx, timers, search } = await setup();
  assert.equal(search.root.getAttribute('role'), 'search');
  assert.equal(search.input.getAttribute('aria-keyshortcuts'), 'Control+K Meta+K');
  assert.equal(search.input.getAttribute('title'), null);
  search.input.value = ' ubuntu ';
  search.input.dispatch('input');
  assert.equal(ctx.store.get().filter.search, '', 'not yet');
  assert.equal(timers.pending()[0].ms, DEBOUNCE_MS);
  timers.flush();
  assert.equal(ctx.store.get().filter.search, 'ubuntu', 'trimmed');
  const clearButton = search.root.querySelector('.search-clear');
  assert.equal(clearButton.hidden, false);

  search.input.value = 'deb';
  search.input.dispatch('input');
  search.input.dispatch('keydown', { key: 'Enter' });
  assert.equal(ctx.store.get().filter.search, 'deb');
  assert.equal(timers.pending().length, 0, 'Enter cancels the pending debounce');

  click(clearButton);
  assert.equal(ctx.store.get().filter.search, '');
  assert.equal(search.input.value, '');
  assert.equal(clearButton.hidden, true);
  assert.equal(globalThis.document.activeElement, search.input, 'clearing keeps focus in the field');
  search.destroy();
});

test('Escape clears and hands focus back; Ctrl K and Cmd K focus the field from anywhere', async () => {
  const { ctx, search, escapes } = await setup();
  ctx.store.set({ filter: { ...ctx.store.get().filter, search: 'x' } });
  assert.equal(search.input.value, 'x', 'the field follows the store');
  search.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(ctx.store.get().filter.search, '');
  assert.deepEqual(escapes, [1]);

  globalThis.document.activeElement = null;
  const e1 = env.doc.dispatch('keydown', { key: 'k', ctrlKey: true, metaKey: false, altKey: false });
  assert.equal(e1.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, search.input);
  globalThis.document.activeElement = null;
  env.doc.dispatch('keydown', { key: 'K', ctrlKey: false, metaKey: true, altKey: false });
  assert.equal(globalThis.document.activeElement, search.input);
  globalThis.document.activeElement = null;
  env.doc.dispatch('keydown', { key: 'k', ctrlKey: false, metaKey: false, altKey: false });
  assert.equal(globalThis.document.activeElement, null, 'a bare k does nothing');
  search.destroy();
  assert.equal((env.docListeners.get('keydown') || []).length, 0, 'destroy removes the global listener');
});
