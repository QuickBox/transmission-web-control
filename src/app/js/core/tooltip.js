/**
 * The one tooltip. There are no native browser tooltips in this app: a
 * control registers its hint here and a single shared panel shows it after a
 * hover delay, at once on keyboard focus, and hides on Escape, activation,
 * blur or pointer exit. A hint is not shown while its control (or the
 * nearest `[aria-expanded]` ancestor) is expanded, so it never covers the
 * menu the control just opened.
 */

const DELAY = 400;
const GAP = 6;
const EDGE = 8;

/** @type {WeakMap<Element, string | (() => string)>} */
const hints = new WeakMap();
let panel = null;
let timer = 0;
let current = null;
let installed = false;

function textOf(target) {
  const hint = hints.get(target);
  const text = typeof hint === 'function' ? hint() : hint;
  return typeof text === 'string' ? text.trim() : '';
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'tooltip';
  panel.setAttribute('role', 'tooltip');
  panel.setAttribute('aria-hidden', 'true');
  document.body.append(panel);
  return panel;
}

function suppressed(target) {
  const expanded = target.closest('[aria-expanded]');
  return Boolean(expanded && expanded.getAttribute('aria-expanded') === 'true');
}

function show(target, pointerX) {
  if (!target.isConnected || suppressed(target)) return;
  const text = textOf(target);
  if (!text) return;
  const tip = ensurePanel();
  tip.textContent = text;
  tip.classList.remove('is-visible');
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const anchorX = typeof pointerX === 'number' && r.width > tw * 2 ? pointerX : r.left + r.width / 2;
  const left = Math.max(EDGE, Math.min(anchorX - tw / 2, vw - tw - EDGE));
  let top = r.bottom + GAP;
  if (top + th > vh - EDGE) top = r.top - th - GAP;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(Math.max(EDGE, top))}px`;
  tip.classList.add('is-visible');
  current = target;
}

function hide() {
  clearTimeout(timer);
  current = null;
  if (panel) panel.classList.remove('is-visible');
}

function owner(node) {
  for (let el = node instanceof Element ? node : null; el; el = el.parentElement) {
    if (hints.has(el)) return el;
  }
  return null;
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const target = owner(e.target);
    if (!target || target === current) return;
    clearTimeout(timer);
    const x = e.clientX;
    timer = setTimeout(() => show(target, x), DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    const target = owner(e.target);
    if (target && !target.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const target = owner(e.target);
    if (target && e.target.matches(':focus-visible')) show(target);
  });
  document.addEventListener('focusout', () => hide());
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') hide();
  }, true);
  document.addEventListener('scroll', hide, true);
  globalThis.addEventListener('blur', hide);
}

/**
 * Give `target` a hint. A string, or a function read each time it shows. An
 * element with no accessible name takes a static string as its `aria-label`.
 * @param {Element} target
 * @param {string | (() => string)} text
 * @returns {() => void} removes the hint
 */
export function tooltip(target, text) {
  install();
  hints.set(target, text);
  const named = target.hasAttribute('aria-label') || target.hasAttribute('aria-labelledby')
    || (target.textContent || '').trim();
  if (!named && typeof text === 'string' && text.trim()) target.setAttribute('aria-label', text.trim());
  return () => {
    hints.delete(target);
    if (current === target) hide();
  };
}

/** Hide the hint now (for example before a view re-renders under it). */
export const hideTooltip = hide;
