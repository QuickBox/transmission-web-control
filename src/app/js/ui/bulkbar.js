/**
 * Sticky bottom action bar shown while `selection` is non-empty on narrow
 * layouts: the count, Start, Pause, Remove and a More menu with the rest of
 * the actions. The region is emptied when nothing is selected, which is what
 * hides it (`.shell-bulkbar:empty`). Mounted into `[data-region="bulkbar"]`.
 */

import { ACTIONS, actionMenuItems, runAction } from './toolbar.js?v=__QBV__';

/** Actions that get their own button; everything else goes behind More. */
export const BULK_ACTIONS = Object.freeze(ACTIONS.filter((a) => a.bulk).map((a) => a.id));

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {() => void} Teardown.
 */
export function mount(root, ctx) {
  const { el, clear, icon, tooltip, menu } = ctx.ui;
  const t = ctx.i18n;
  const { store } = ctx;

  function render(selection) {
    const ids = [...selection];
    if (ids.length === 0) {
      clear(root);
      root.removeAttribute('role');
      return;
    }
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', t('core.count.selected', { count: ids.length }));
    const buttons = BULK_ACTIONS.map((id) => {
      const action = ACTIONS.find((a) => a.id === id);
      const button = el('button', {
        type: 'button',
        class: ['btn-icon', action.destructive && 'bulk-destructive'],
        'aria-label': t(`main.actions.${id}`),
        'data-action': id,
      }, icon(action.icon, { size: 20 }));
      tooltip(button, () => t(`main.actions.${id}`));
      button.addEventListener('click', () => runAction(ctx, id, [...store.get().selection]));
      return button;
    });
    const more = el('button', { type: 'button', class: 'btn-icon', 'aria-label': t('core.actions.more'), 'aria-haspopup': 'menu' }, icon('more', { size: 20 }));
    tooltip(more, () => t('core.actions.more'));
    more.addEventListener('click', () => {
      const current = [...store.get().selection];
      menu(more, actionMenuItems(ctx, ACTIONS.filter((a) => !a.bulk), current), { label: t('core.actions.more') });
    });
    const clearButton = el('button', { type: 'button', class: 'btn-icon btn-icon-md bulk-clear', 'aria-label': t('main.bulkbar.clear') }, icon('menu-close', { size: 16 }));
    tooltip(clearButton, () => t('main.bulkbar.clear'));
    clearButton.addEventListener('click', () => store.set({ selection: new Set() }));

    clear(root,
      el('span', { class: 'bulk-count', text: t('core.count.selected', { count: ids.length }) }),
      el('span', { class: 'bulk-spacer' }),
      ...buttons,
      more,
      clearButton,
    );
  }

  const off = store.subscribe('selection', render);
  render(store.get().selection);
  return () => {
    off();
    clear(root);
  };
}
