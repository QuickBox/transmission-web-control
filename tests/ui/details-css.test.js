import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DETAILS_CSS = readFileSync(new URL('../../src/app/css/details.css', import.meta.url), 'utf8');

/** Declarations of the first top-level rule whose selector list is exactly `selector`. */
function declarations(css, selector) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = flat.search(new RegExp(`(^|\\})\\s*${selector.replace(/[.[\]*+?^$(){}|\\]/g, '\\$&')}\\s*\\{`));
  assert.notEqual(at, -1, `${selector} has a rule`);
  const open = flat.indexOf('{', at + 1);
  return flat.slice(open + 1, flat.indexOf('}', open));
}

test('an option card is one column no wider than the card, so translations wrap inside it', () => {
  assert.match(declarations(DETAILS_CSS, '.option-card'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('the details tab strip scrolls on narrow screens and fades the hidden side', () => {
  assert.match(DETAILS_CSS, /\.details-tabs\s*\{[^}]*overflow-x:\s*auto/, 'the strip scrolls');
  assert.match(declarations(DETAILS_CSS, '.details-tabs[data-more-end]'), /mask-image:/);
  assert.match(declarations(DETAILS_CSS, '.details-tabs[data-more-start]'), /mask-image:/);
  assert.match(declarations(DETAILS_CSS, '.details-tab'), /flex:\s*none/, 'tabs keep their width and scroll instead of squeezing');
});
