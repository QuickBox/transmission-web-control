/**
 * Popup menus anchored to a control. The anchor gets `aria-haspopup` and
 * `aria-expanded`; the menu takes focus on its first enabled item. Arrow
 * keys, Home and End move, Enter and Space activate, Escape closes and
 * returns focus to the anchor, Tab closes. A pointer press outside, a scroll
 * or a resize closes it. The menu is placed before it is shown, so it never
 * paints at a placeholder position.
 */

import { el } from './dom.js?v=__QBV__';
import { icon } from './icons.js?v=__QBV__';

const EDGE = 8;
const GAP = 4;
let open = null;

/**
 * @typedef {{ label: string, icon?: string, onSelect?: () => void, disabled?: boolean,
 *   destructive?: boolean, checked?: boolean, items?: MenuItem[] } | 'separator'} MenuItem
 */

function itemNodes(items, close) {
  const nodes = [];
  for (const item of items) {
    if (item === 'separator') {
      nodes.push(el('div', { class: 'menu-separator', role: 'separator' }));
      continue;
    }
    if (Array.isArray(item.items)) {
      nodes.push(el('div', { class: 'menu-group', role: 'group', 'aria-label': item.label }, [
        el('div', { class: 'menu-group-label', 'aria-hidden': 'true', text: item.label }),
        ...itemNodes(item.items, close),
      ]));
      continue;
    }
    const checkable = typeof item.checked === 'boolean';
    nodes.push(el('button', {
      type: 'button',
      class: ['menu-item', item.destructive && 'menu-item-destructive'],
      role: checkable ? 'menuitemradio' : 'menuitem',
      'aria-checked': checkable ? String(item.checked) : null,
      'aria-disabled': item.disabled ? 'true' : null,
      tabindex: '-1',
      on: {
        click: () => {
          if (item.disabled) return;
          close(true);
          if (item.onSelect) item.onSelect();
        },
      },
    }, [
      item.icon ? icon(item.icon, { size: 16 }) : null,
      el('span', { class: 'menu-label', text: item.label }),
      checkable ? el('span', { class: 'menu-check' }, [item.checked ? icon('menu-check', { size: 16 }) : null]) : null,
    ]));
  }
  return nodes;
}

function place(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  let left = r.left;
  if (left + w > vw - EDGE) left = r.right - w;
  left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
  let top = r.bottom + GAP;
  if (top + h > vh - EDGE && r.top - GAP - h >= EDGE) top = r.top - GAP - h;
  top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

/**
 * Open a menu under `anchor`. Opening another menu closes this one; calling
 * it again for the anchor whose menu is open closes it (a toggle).
 * @param {HTMLElement} anchor
 * @param {MenuItem[]} items
 * @param {{ label?: string }} [opts] accessible name, defaults to the anchor's
 * @returns {{ close: () => void }}
 */
export function menu(anchor, items, opts = {}) {
  if (open && open.anchor === anchor) {
    const previous = open;
    previous.close(true);
    return { close: () => previous.close(true) };
  }
  if (open) open.close(false);

  const panel = el('div', {
    class: 'menu',
    role: 'menu',
    tabindex: '-1',
    'aria-label': opts.label || anchor.getAttribute('aria-label') || null,
  });

  function enabledItems() {
    return [...panel.querySelectorAll('.menu-item')].filter((n) => n.getAttribute('aria-disabled') !== 'true');
  }

  function move(delta, absolute) {
    const list = enabledItems();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement);
    let next;
    if (absolute === 'first') next = 0;
    else if (absolute === 'last') next = list.length - 1;
    else next = (index + delta + list.length) % list.length;
    list[next].focus();
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0, 'first'); }
    else if (e.key === 'End') { e.preventDefault(); move(0, 'last'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  }

  function onOutside(e) {
    if (!panel.contains(e.target) && !anchor.contains(e.target)) close(false);
  }

  function onViewport(e) {
    if (e.type === 'scroll' && panel.contains(e.target)) return;
    close(false);
  }

  let closed = false;
  function close(restoreFocus) {
    if (closed) return;
    closed = true;
    panel.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('scroll', onViewport, true);
    globalThis.removeEventListener('resize', onViewport);
    if (open && open.panel === panel) open = null;
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }

  panel.append(...itemNodes(items, close));
  panel.addEventListener('keydown', onKey);
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  document.body.append(panel);
  place(panel, anchor);
  panel.classList.add('is-open');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('scroll', onViewport, true);
  globalThis.addEventListener('resize', onViewport);

  const checked = panel.querySelector('.menu-item[aria-checked="true"]:not([aria-disabled="true"])');
  (checked || enabledItems()[0] || panel).focus();

  open = { panel, anchor, close };
  return { close: () => close(true) };
}
