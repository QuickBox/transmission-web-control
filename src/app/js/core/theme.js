/**
 * Theme variants and the QuickBox dashboard follow.
 *
 * Order: the local pick (`qb-transmission-variant`), and when that is `auto`
 * (or unset), the dashboard's `qb_theme` cookie mapped 1:1; anything unknown
 * is spectre. In `auto` the page re-reads the cookie whenever it becomes
 * visible or gains focus, so a theme change in the dashboard follows here
 * without a reload. The inline script in `index.html` runs the same
 * resolution before first paint; this module owns it afterwards.
 *
 * Only `data-qb-variant` on <html> is written. `color-scheme` and
 * `accent-color` come from `tokens.css`.
 */

export const VARIANTS = Object.freeze(['spectre', 'smoked', 'reel', 'defaulted']);
export const STORAGE_KEY = 'qb-transmission-variant';
const COOKIE = /(?:^|;\s*)qb_theme=([^;]*)/;

/**
 * @param {string} cookieString `document.cookie`
 * @returns {string} the variant named by `qb_theme`, or spectre
 */
export function cookieVariant(cookieString) {
  const m = typeof cookieString === 'string' ? cookieString.match(COOKIE) : null;
  let value = '';
  if (m) {
    try {
      value = decodeURIComponent(m[1]);
    } catch {
      value = m[1];
    }
  }
  return VARIANTS.includes(value) ? value : 'spectre';
}

/**
 * @param {string|null} stored the saved pick
 * @param {string} cookieString
 * @returns {string}
 */
export function resolveVariant(stored, cookieString) {
  return VARIANTS.includes(stored) ? stored : cookieVariant(cookieString);
}

/** @returns {'auto'|string} the saved pick, `auto` when none or invalid */
export function preference() {
  try {
    const v = globalThis.localStorage.getItem(STORAGE_KEY);
    return VARIANTS.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

const listeners = new Set();
let started = false;

/** @returns {string} the variant on <html> now */
export function currentVariant() {
  return document.documentElement.getAttribute('data-qb-variant') || 'spectre';
}

function apply(variant) {
  if (variant === currentVariant() && started) return;
  document.documentElement.setAttribute('data-qb-variant', variant);
  for (const fn of [...listeners]) {
    try {
      fn(variant);
    } catch (err) {
      console.error(err);
    }
  }
}

function follow() {
  if (preference() !== 'auto') return;
  apply(cookieVariant(document.cookie));
}

/** Apply the resolved variant and start following the dashboard. Idempotent. */
export function startTheme() {
  const pick = preference();
  apply(resolveVariant(pick === 'auto' ? null : pick, document.cookie));
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) follow();
  });
  globalThis.addEventListener('focus', follow);
}

/**
 * Save a pick and apply it. `auto` clears the pick and follows the dashboard.
 * @param {'auto'|string} choice
 */
export function setVariant(choice) {
  try {
    if (VARIANTS.includes(choice)) globalThis.localStorage.setItem(STORAGE_KEY, choice);
    else globalThis.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the pick lasts for this page only.
  }
  apply(VARIANTS.includes(choice) ? choice : cookieVariant(document.cookie));
}

/**
 * Call `fn(variant)` on every change.
 * @param {(variant: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onVariant(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
