/**
 * Torrent list: the virtualised `role=grid` table, sorting, the selection
 * model and keyboard, and the card layout under its container query. Reads
 * `torrents`, `order`, `filter`; writes `selection` and `focused`.
 * Mounted into `[data-region="table"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
