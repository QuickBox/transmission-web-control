/**
 * The search field: writes `filter.search` (debounced) and follows the store
 * when something else changes it. `Ctrl K` / `Cmd K` focuses it from anywhere,
 * Escape clears it and returns focus to the list. Rendered by the toolbar;
 * exported so the toolbar can expand it to full width on narrow layouts.
 */

export const DEBOUNCE_MS = 150;

const isMac = () => /Mac|iPhone|iPad/.test((globalThis.navigator && globalThis.navigator.platform) || '');

/** `Ctrl K` on most platforms, `⌘ K` on Apple ones. */
export function shortcutLabel() {
  return isMac() ? '⌘ K' : 'Ctrl K';
}

/**
 * @param {import('../main.js').AppContext} ctx
 * @param {{ timers?: { setTimeout: Function, clearTimeout: Function }, onEscape?: () => void }} [options]
 * @returns {{ root: HTMLElement, input: HTMLInputElement, focus: () => void, clear: () => void, destroy: () => void }}
 */
export function createSearch(ctx, options = {}) {
  const { el, icon, tooltip } = ctx.ui;
  const t = ctx.i18n;
  const { store } = ctx;
  const clock = options.timers || { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  let timer = null;

  const input = el('input', {
    type: 'search',
    class: 'input search-input',
    placeholder: t('main.search.placeholder'),
    'aria-label': t('main.search.placeholder'),
    'aria-keyshortcuts': 'Control+K Meta+K',
    autocomplete: 'off',
    spellcheck: 'false',
    value: store.get().filter.search || '',
  });
  const clearButton = el('button', {
    type: 'button',
    class: 'btn-icon btn-icon-sm search-clear',
    'aria-label': t('main.search.clear'),
    hidden: !input.value,
  }, icon('menu-close', { size: 14 }));
  tooltip(clearButton, () => t('main.search.clear'));
  const chip = el('kbd', { class: 'kbd search-kbd', 'aria-hidden': 'true', text: shortcutLabel() });
  const root = el('div', { class: 'search', role: 'search' }, [
    el('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon('toolbar-search', { size: 16 })),
    input,
    clearButton,
    chip,
  ]);

  function commit(value) {
    const filter = store.get().filter;
    if (filter.search === value) return;
    store.set({ filter: { ...filter, search: value } });
  }

  function onInput() {
    clearButton.hidden = !input.value;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      commit(input.value.trim());
    }, DEBOUNCE_MS);
  }

  function clear() {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    input.value = '';
    clearButton.hidden = true;
    commit('');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      clear();
      if (options.onEscape) options.onEscape();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      commit(input.value.trim());
    }
  }

  function onGlobalKey(e) {
    if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      focus();
    }
  }

  function focus() {
    input.focus();
    if (typeof input.select === 'function') input.select();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  clearButton.addEventListener('click', () => {
    clear();
    focus();
  });
  document.addEventListener('keydown', onGlobalKey);
  const off = store.subscribe('filter', (filter) => {
    const value = filter.search || '';
    if (input.value !== value && timer === null) {
      input.value = value;
      clearButton.hidden = !value;
    }
  });

  return {
    root,
    input,
    focus,
    clear,
    destroy() {
      off();
      document.removeEventListener('keydown', onGlobalKey);
      if (timer !== null) clock.clearTimeout(timer);
    },
  };
}
