import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  matchLanguage, readCookie, resolveLanguage, flattenCatalog, loadTranslator,
  LANGUAGES, FULL_LANGUAGES, PARTIAL_LANGUAGES, LANGUAGE_NAMES,
} from '../../src/app/js/core/i18n.js';

test('17 languages: the QuickBox 7 plus 10 inherited, each with an own-language name', () => {
  assert.equal(FULL_LANGUAGES.length, 7);
  assert.equal(PARTIAL_LANGUAGES.length, 10);
  for (const code of LANGUAGES) assert.ok(LANGUAGE_NAMES[code], code);
});

test('matchLanguage maps cookie, underscore and region tags', () => {
  assert.equal(matchLanguage('pt-br'), 'pt-BR');
  assert.equal(matchLanguage('zh-cn'), 'zh-CN');
  assert.equal(matchLanguage('zh_TW'), 'zh-TW');
  assert.equal(matchLanguage('pt_PT'), 'pt-PT');
  assert.equal(matchLanguage('pt'), 'pt-BR');
  assert.equal(matchLanguage('zh'), 'zh-CN');
  assert.equal(matchLanguage('zh-Hant-HK'), 'zh-TW');
  assert.equal(matchLanguage('zh-Hans-SG'), 'zh-CN');
  assert.equal(matchLanguage('de-AT'), 'de');
  assert.equal(matchLanguage('EN-gb'), 'en');
  assert.equal(matchLanguage('xx'), null);
  assert.equal(matchLanguage(''), null);
  assert.equal(matchLanguage(undefined), null);
});

test('readCookie finds the exact name only', () => {
  const c = 'qb_theme=reel; xLanguage=fr; Language=pt-br; other=1';
  assert.equal(readCookie(c, 'Language'), 'pt-br');
  assert.equal(readCookie('Language=zh%2Dcn', 'Language'), 'zh-cn');
  assert.equal(readCookie('', 'Language'), null);
});

test('resolution order: local pick, Language cookie, browser, English', () => {
  const cookie = 'Language=de';
  const browser = ['fr-FR', 'en'];
  assert.equal(resolveLanguage({ stored: 'es', cookie, browser }), 'es');
  assert.equal(resolveLanguage({ stored: 'auto', cookie, browser }), 'de');
  assert.equal(resolveLanguage({ stored: 'klingon', cookie, browser }), 'de');
  assert.equal(resolveLanguage({ stored: null, cookie: 'Language=xx', browser }), 'fr');
  assert.equal(resolveLanguage({ browser: ['xx', 'nl-BE'] }), 'nl');
  assert.equal(resolveLanguage({ browser: ['xx'] }), 'en');
  assert.equal(resolveLanguage(), 'en');
});

test('flattenCatalog prefixes the namespace, keeps plurals, drops non-text', () => {
  const flat = flattenCatalog('core', {
    a: { b: 'B' },
    n: { one: '{count} item', other: '{count} items' },
    bad: 42,
    list: ['x'],
    odd: { one: 'x' },
  });
  assert.equal(flat.get('core.a.b'), 'B');
  assert.deepEqual(flat.get('core.n'), { one: '{count} item', other: '{count} items' });
  assert.equal(flat.has('core.bad'), false);
  assert.equal(flat.has('core.list'), false);
  assert.equal(flat.has('core.odd.one'), true);
  assert.equal(flattenCatalog('core', null).size, 0);
});

function fakeLoader(catalogs) {
  const calls = [];
  const load = async (lang, ns) => {
    calls.push(`${lang}/${ns}`);
    const value = catalogs[`${lang}/${ns}`];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return { load, calls };
}

test('per-key English fallback, then the key itself', async () => {
  const { load } = fakeLoader({
    'en/core': { hello: 'Hello', bye: 'Bye' },
    'hu/core': { hello: 'Szia' },
  });
  const t = await loadTranslator({ lang: 'hu', namespaces: ['core'], load });
  assert.equal(t.lang, 'hu');
  assert.equal(t('core.hello'), 'Szia');
  assert.equal(t('core.bye'), 'Bye');
  assert.equal(t('core.missing'), 'core.missing');
  assert.equal(t.has('core.bye'), true);
  assert.equal(t.has('core.missing'), false);
});

test('interpolation and plurals', async () => {
  const { load } = fakeLoader({
    'en/core': { n: { one: '{count} torrent', other: '{count} torrents' }, g: 'Hi {name}, {who}' },
    'fr/core': { n: { one: '{count} torrent', other: '{count} torrents FR' } },
  });
  const en = await loadTranslator({ lang: 'en', namespaces: ['core'], load });
  assert.equal(en('core.n', { count: 1 }), '1 torrent');
  assert.equal(en('core.n', { count: 2 }), '2 torrents');
  assert.equal(en('core.n'), '{count} torrents');
  assert.equal(en('core.g', { name: '<b>x</b>' }), 'Hi <b>x</b>, {who}');
  const fr = await loadTranslator({ lang: 'fr', namespaces: ['core'], load });
  assert.equal(fr('core.n', { count: 0 }), '0 torrent');
  assert.equal(fr('core.n', { count: 5 }), '5 torrents FR');
});

test('a missing, failing or garbage catalog degrades to English', async () => {
  const { load, calls } = fakeLoader({
    'en/core': { a: 'A' },
    'en/main': { b: 'B' },
    'de/core': new Error('network'),
    'de/main': 'not an object',
  });
  const t = await loadTranslator({ lang: 'de', namespaces: ['core', 'main', 'details'], load });
  assert.equal(t('core.a'), 'A');
  assert.equal(t('main.b'), 'B');
  assert.deepEqual(calls.sort(), ['de/core', 'de/details', 'de/main', 'en/core', 'en/details', 'en/main']);
});

test('English only fetches English; an unknown code loads English', async () => {
  const { load, calls } = fakeLoader({ 'en/core': { a: 'A' } });
  const t = await loadTranslator({ lang: 'xx', namespaces: ['core'], load });
  assert.equal(t.lang, 'en');
  assert.deepEqual(calls, ['en/core']);
});

test('the shipped English core catalog is plain text and loads', async () => {
  const url = new URL('../../src/app/i18n/en/core.json', import.meta.url);
  const catalog = JSON.parse(readFileSync(url, 'utf8'));
  const flat = flattenCatalog('core', catalog);
  assert.ok(flat.size > 40);
  for (const [key, value] of flat) {
    const texts = typeof value === 'string' ? [value] : Object.values(value);
    for (const text of texts) assert.doesNotMatch(text, /<[a-z!/]/i, key);
  }
  const t = await loadTranslator({ lang: 'en', namespaces: ['core'], load: async () => catalog });
  assert.equal(t('core.count.torrents', { count: 3 }), '3 torrents');
  assert.equal(t('core.status.seeding'), 'Seeding');
});
