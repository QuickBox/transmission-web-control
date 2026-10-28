/**
 * Language resolution and message catalogs.
 *
 * Order: the local pick (`qb-transmission-lang`), then the `Language` cookie
 * the QuickBox dashboard writes, then the browser languages, then English.
 *
 * Catalogs live at `app/i18n/<code>/<namespace>.json`, one file per lane
 * namespace. Nested objects flatten to dotted keys prefixed with the
 * namespace, so `core.json` `{"connection":{"lost":"..."}}` is read as
 * `t("core.connection.lost")`. A leaf whose keys are plural categories
 * (`one`, `other`, ...) is a plural message picked by `vars.count`.
 * Every key falls back to English on its own; a missing English key renders
 * the key itself. Messages are plain text and are only ever set as text.
 */

/** Languages that carry every key. */
export const FULL_LANGUAGES = Object.freeze(['en', 'da', 'de', 'es', 'fr', 'pt-BR', 'zh-CN']);

/** Inherited translations: partial, English per missing key. */
export const PARTIAL_LANGUAGES = Object.freeze([
  'hu', 'zh-TW', 'nl', 'ru', 'uk', 'ko', 'it', 'ro', 'pl', 'pt-PT',
]);

export const LANGUAGES = Object.freeze([...FULL_LANGUAGES, ...PARTIAL_LANGUAGES]);

/** Each language's own name, shown untranslated in the picker. */
export const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  da: 'Dansk',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  'pt-BR': 'Português (Brasil)',
  'zh-CN': '简体中文',
  hu: 'Magyar',
  'zh-TW': '繁體中文',
  nl: 'Nederlands',
  ru: 'Русский',
  uk: 'Українська',
  ko: '한국어',
  it: 'Italiano',
  ro: 'Română',
  pl: 'Polski',
  'pt-PT': 'Português (Portugal)',
});

export const NAMESPACES = Object.freeze(['core', 'main', 'details', 'dialogs']);

export const STORAGE_KEY = 'qb-transmission-lang';

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const BY_LOWER = new Map(LANGUAGES.map((code) => [code.toLowerCase(), code]));

/**
 * Map any language tag (`pt-br`, `zh_TW`, `de-AT`, `zh-Hant-HK`) to a
 * supported code, or `null`.
 * @param {unknown} tag
 * @returns {string|null}
 */
export function matchLanguage(tag) {
  if (typeof tag !== 'string') return null;
  const lower = tag.trim().replace(/_/g, '-').toLowerCase();
  if (!lower) return null;
  if (BY_LOWER.has(lower)) return BY_LOWER.get(lower);
  const parts = lower.split('-');
  const base = parts[0];
  if (base === 'zh') {
    const traditional = parts.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo');
    return traditional ? 'zh-TW' : 'zh-CN';
  }
  if (base === 'pt') return parts.slice(1).includes('pt') ? 'pt-PT' : 'pt-BR';
  return BY_LOWER.get(base) || null;
}

/**
 * Read one cookie value by name from a `document.cookie` string.
 * @param {string} cookieString
 * @param {string} name
 * @returns {string|null}
 */
export function readCookie(cookieString, name) {
  if (typeof cookieString !== 'string') return null;
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Resolve the UI language from its sources, highest priority first.
 * @param {{ stored?: string|null, cookie?: string|null, browser?: readonly string[] }} sources
 *   `stored` is the local pick (`auto` or empty means none), `cookie` is the raw
 *   `document.cookie`, `browser` is `navigator.languages`.
 * @returns {string}
 */
export function resolveLanguage({ stored, cookie, browser } = {}) {
  const pick = stored && stored !== 'auto' ? matchLanguage(stored) : null;
  if (pick) return pick;
  const fromCookie = matchLanguage(readCookie(cookie || '', 'Language'));
  if (fromCookie) return fromCookie;
  for (const tag of browser || []) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return 'en';
}

/**
 * Flatten a catalog into `namespace.dotted.key` entries. Non-string leaves
 * are dropped so a malformed catalog can never inject a non-text value.
 * @param {string} ns
 * @param {unknown} catalog
 * @returns {Map<string, string|Record<string, string>>}
 */
export function flattenCatalog(ns, catalog) {
  const out = new Map();
  const walk = (prefix, node) => {
    if (typeof node === 'string') {
      out.set(prefix, node);
      return;
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const keys = Object.keys(node);
    if (keys.length && keys.includes('other') && keys.every((k) => PLURAL_CATEGORIES.has(k))) {
      if (keys.every((k) => typeof node[k] === 'string')) out.set(prefix, { ...node });
      return;
    }
    for (const key of keys) walk(`${prefix}.${key}`, node[key]);
  };
  if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
    for (const key of Object.keys(catalog)) walk(`${ns}.${key}`, catalog[key]);
  }
  return out;
}

/**
 * @typedef {((key: string, vars?: Record<string, unknown>) => string) & {
 *   lang: string,
 *   has: (key: string) => boolean,
 * }} Translate
 */

/**
 * Build a translator over already-flattened English and active catalogs.
 * @param {string} lang
 * @param {Map<string, any>} active
 * @param {Map<string, any>} english
 * @returns {Translate}
 */
export function createTranslator(lang, active, english) {
  const plural = new Intl.PluralRules(lang);
  const t = (key, vars) => {
    let message = active.has(key) ? active.get(key) : english.get(key);
    if (message === undefined) return key;
    if (typeof message === 'object') {
      const n = vars && typeof vars.count === 'number' ? vars.count : NaN;
      const category = Number.isFinite(n) ? plural.select(n) : 'other';
      message = message[category] ?? message.other;
    }
    if (!vars) return message;
    return message.replace(/\{(\w+)\}/g, (m, name) => (
      Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null ? String(vars[name]) : m
    ));
  };
  t.lang = lang;
  t.has = (key) => active.has(key) || english.has(key);
  return t;
}

/**
 * Default catalog fetcher: same-origin, relative to this module, cache-busted.
 * Resolves `null` when the file is missing or unreadable.
 * @param {string} lang
 * @param {string} ns
 * @returns {Promise<unknown|null>}
 */
export async function fetchCatalog(lang, ns) {
  const url = new URL(`../../i18n/${lang}/${ns}.json?v=__QBV__`, import.meta.url);
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Load every namespace for `lang` (and English beneath it) and return `t`.
 * A missing or broken catalog degrades to English, never to a failure.
 * @param {{ lang: string, namespaces?: readonly string[], load?: (lang: string, ns: string) => Promise<unknown|null> }} opts
 * @returns {Promise<Translate>}
 */
export async function loadTranslator({ lang, namespaces = NAMESPACES, load = fetchCatalog }) {
  const code = matchLanguage(lang) || 'en';
  const english = new Map();
  const active = new Map();
  const safeLoad = (l, ns) => Promise.resolve().then(() => load(l, ns)).catch(() => null);
  await Promise.all(namespaces.map(async (ns) => {
    const [en, own] = await Promise.all([
      safeLoad('en', ns),
      code === 'en' ? null : safeLoad(code, ns),
    ]);
    for (const [k, v] of flattenCatalog(ns, en)) english.set(k, v);
    for (const [k, v] of flattenCatalog(ns, own)) active.set(k, v);
  }));
  return createTranslator(code, active, english);
}

/**
 * Read the browser-side sources and resolve the UI language.
 * @returns {string}
 */
export function detectLanguage() {
  let stored = null;
  try {
    stored = globalThis.localStorage ? globalThis.localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    stored = null;
  }
  const nav = globalThis.navigator;
  const browser = nav ? (nav.languages && nav.languages.length ? nav.languages : [nav.language]) : [];
  const cookie = globalThis.document ? globalThis.document.cookie : '';
  return resolveLanguage({ stored, cookie, browser });
}

/**
 * Save the local pick. `auto` (or an unsupported code) clears it so the
 * dashboard cookie and the browser decide again. The caller reloads.
 * @param {string} code
 * @returns {string} the language that will be used
 */
export function saveLanguage(code) {
  const match = code === 'auto' ? null : matchLanguage(code);
  try {
    if (match) globalThis.localStorage.setItem(STORAGE_KEY, match);
    else globalThis.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the pick lasts for this page only.
  }
  return match || detectLanguage();
}
