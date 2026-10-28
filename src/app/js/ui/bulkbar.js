/**
 * Sticky bottom action bar shown while `selection` is non-empty on narrow
 * layouts: Start, Pause, Remove, More. Mounted into `[data-region="bulkbar"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
