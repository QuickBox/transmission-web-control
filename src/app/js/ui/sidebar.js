/**
 * Filter sidebar: Status, Labels, Trackers and Folders sections with count
 * pills. Writes the `filter` store key and reads `torrents`. Collapses to a
 * rail (persisted in `prefs`) and becomes an off-canvas drawer below 960px.
 * Mounted into `[data-region="sidebar"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
