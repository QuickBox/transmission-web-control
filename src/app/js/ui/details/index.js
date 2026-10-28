/**
 * Details drawer (wide), slide-over sheet (medium) or full-screen sheet
 * (narrow) for the `focused` torrent, with the General, Files, Trackers, Peers
 * and Options tabs and the empty state. Mounted into `[data-region="details"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
