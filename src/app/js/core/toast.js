/**
 * Toasts: short notices in a polite live region at the bottom right (bottom
 * centre on narrow screens). Each carries a tone glyph and a dismiss button;
 * it closes itself after `timeout` ms, paused while hovered or focused. At
 * most four show at once; the oldest goes first.
 */

import { el } from './dom.js?v=__QBV__';
import { icon } from './icons.js?v=__QBV__';

const TONE_ICON = {
  info: 'header-about',
  success: 'menu-check',
  warning: 'header-confirm',
  error: 'state-error',
};
const MAX = 4;

/**
 * @param {(key: string) => string} t
 * @returns {(message: string, opts?: { tone?: 'info'|'success'|'warning'|'error', timeout?: number }) => { close: () => void }}
 */
export function createToast(t) {
  let region = null;

  function ensureRegion() {
    if (region && region.isConnected) return region;
    region = el('div', {
      class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-label': t('core.a11y.notifications'),
    });
    document.body.append(region);
    return region;
  }

  return function toast(message, opts = {}) {
    const tone = TONE_ICON[opts.tone] ? opts.tone : 'info';
    const timeout = Number.isFinite(opts.timeout) ? opts.timeout : tone === 'error' ? 8000 : 5000;
    let remaining = timeout;
    let started = 0;
    let timer = 0;

    const close = () => {
      clearTimeout(timer);
      item.remove();
    };
    const run = () => {
      if (remaining <= 0) return;
      started = Date.now();
      timer = setTimeout(close, remaining);
    };
    const pause = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      remaining -= Date.now() - started;
    };

    const item = el('div', {
      class: ['toast', `toast-${tone}`],
      on: { pointerenter: pause, pointerleave: run, focusin: pause, focusout: run },
    }, [
      el('span', { class: 'toast-icon' }, [icon(TONE_ICON[tone], { size: 18, label: t(`core.tone.${tone}`) })]),
      el('p', { class: 'toast-text', text: message }),
      el('button', {
        type: 'button', class: 'btn-icon btn-icon-sm', 'aria-label': t('core.toast.dismiss'), on: { click: close },
      }, [icon('menu-close', { size: 16 })]),
    ]);

    const host = ensureRegion();
    host.append(item);
    while (host.children.length > MAX) host.firstElementChild.remove();
    run();
    return { close };
  };
}
