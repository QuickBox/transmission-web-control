/**
 * Top app bar: QuickBox mark, Add torrent, the Start/Pause/Verify/Reannounce,
 * Remove and Move/Speed/Queue groups, search, the live rate widget, the
 * alt-speed toggle, the theme switcher, Settings and About. Below 960px the
 * secondary groups fold into a More menu; below 640px it shows the hamburger,
 * a search icon, Add and More. Mounted into `[data-region="toolbar"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
