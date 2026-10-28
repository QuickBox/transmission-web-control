/**
 * Modal dialogs. One anatomy for every dialog: a blurred backdrop, a panel
 * with a header (optional tone tile, title, description, close button), one
 * scrolling body and a footer of actions.
 *
 * Behaviour: the page behind is `inert` while a dialog is open, Tab and
 * Shift+Tab cycle inside the panel, Escape and a backdrop click close it
 * (unless `dismissible: false`), and focus returns to whatever had it before
 * the dialog opened. Dialogs stack; only the top one reacts to keys.
 */

import { el } from './dom.js?v=__QBV__';
import { icon } from './icons.js?v=__QBV__';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const TONE_ICON = {
  info: 'header-about',
  warning: 'header-confirm',
  danger: 'header-confirm',
  success: 'menu-check',
};

/** @type {Array<{ panel: HTMLElement, close: (reason?: string) => void, dismissible: boolean }>} */
const stack = [];
let seq = 0;

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => !n.closest('[inert]') && n.getClientRects().length);
}

function setBackgroundInert(on) {
  const app = document.getElementById('app');
  if (app) app.inert = on;
}

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (!top.dismissible) return;
    e.preventDefault();
    e.stopPropagation();
    top.close('escape');
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusables(top.panel);
  if (items.length === 0) {
    e.preventDefault();
    top.panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !top.panel.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !top.panel.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * @param {(key: string) => string} t
 */
export function createDialogs(t) {
  /**
   * @param {{
   *   title: string, description?: string, body?: Node | Node[], actions?: Node[],
   *   size?: 'sm'|'md'|'lg', tone?: 'info'|'warning'|'danger'|'success', icon?: string,
   *   dismissible?: boolean, initialFocus?: HTMLElement, onClose?: (reason: string) => void,
   * }} opts
   * @returns {{ root: HTMLElement, body: HTMLElement, close: (reason?: string) => void }}
   */
  function openDialog(opts) {
    const id = `dialog-${++seq}`;
    const dismissible = opts.dismissible !== false;
    const returnTo = document.activeElement;
    const glyph = opts.icon || TONE_ICON[opts.tone];

    const body = el('div', { class: 'dialog-body' }, opts.body || []);
    const header = el('header', { class: 'dialog-header' }, [
      glyph ? el('span', { class: ['dialog-tile', opts.tone && `dialog-tile-${opts.tone}`] }, [icon(glyph, { size: 18 })]) : null,
      el('div', { class: 'dialog-heading' }, [
        el('h2', { class: 'dialog-title', id: `${id}-title`, text: opts.title }),
        opts.description ? el('p', { class: 'dialog-desc', id: `${id}-desc`, text: opts.description }) : null,
      ]),
      dismissible ? el('button', {
        type: 'button', class: 'btn-icon btn-icon-sm dialog-close', 'aria-label': t('core.dialog.close'),
        on: { click: () => close('close') },
      }, [icon('menu-close', { size: 16 })]) : null,
    ]);
    const footer = opts.actions && opts.actions.length ? el('footer', { class: 'dialog-footer' }, opts.actions) : null;
    const panel = el('div', {
      class: ['dialog', `dialog-${opts.size || 'md'}`],
      role: opts.tone === 'danger' || opts.tone === 'warning' ? 'alertdialog' : 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': `${id}-title`,
      'aria-describedby': opts.description ? `${id}-desc` : null,
      tabindex: '-1',
    }, [header, body, footer]);

    let pressedOnBackdrop = false;
    const backdrop = el('div', {
      class: 'dialog-backdrop',
      on: {
        pointerdown: (e) => { pressedOnBackdrop = e.target === backdrop; },
        click: (e) => {
          if (dismissible && pressedOnBackdrop && e.target === backdrop) close('backdrop');
          pressedOnBackdrop = false;
        },
      },
    }, [panel]);

    let closed = false;
    function close(reason = 'close') {
      if (closed) return;
      closed = true;
      const index = stack.findIndex((entry) => entry.panel === panel);
      if (index !== -1) stack.splice(index, 1);
      backdrop.remove();
      if (stack.length === 0) {
        setBackgroundInert(false);
        document.removeEventListener('keydown', onKeydown, true);
      }
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
      if (opts.onClose) opts.onClose(reason);
    }

    if (stack.length === 0) {
      setBackgroundInert(true);
      document.addEventListener('keydown', onKeydown, true);
    }
    stack.push({ panel, close, dismissible });
    document.body.append(backdrop);

    const first = opts.initialFocus || panel.querySelector('[autofocus]') || focusables(body)[0]
      || (footer && focusables(footer)[0]) || panel;
    first.focus();
    return { root: panel, body, close };
  }

  /**
   * @param {{ title: string, message: string, confirmLabel?: string, cancelLabel?: string,
   *   destructive?: boolean, tone?: 'info'|'warning'|'danger'|'success' }} opts
   * @returns {Promise<boolean>}
   */
  function confirm(opts) {
    return new Promise((resolve) => {
      let result = false;
      const cancel = el('button', {
        type: 'button', class: 'btn btn-secondary', text: opts.cancelLabel || t('core.actions.cancel'),
        on: { click: () => dialog.close('cancel') },
      });
      const ok = el('button', {
        type: 'button',
        class: ['btn', opts.destructive ? 'btn-destructive' : 'btn-primary'],
        text: opts.confirmLabel || t('core.actions.ok'),
        on: { click: () => { result = true; dialog.close('confirm'); } },
      });
      const dialog = openDialog({
        title: opts.title,
        size: 'sm',
        tone: opts.tone || (opts.destructive ? 'danger' : undefined),
        description: opts.message,
        actions: [cancel, ok],
        initialFocus: opts.destructive ? cancel : ok,
        onClose: () => resolve(result),
      });
    });
  }

  return { openDialog, confirm };
}
