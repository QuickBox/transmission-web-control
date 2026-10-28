/**
 * Dialog registry: Add torrent, Remove, Location, Rename, Labels, Limits,
 * Settings, Replace trackers, Auto-match and About. Dialogs open through
 * `ctx.ui.openDialog`; this module owns the drop overlay and any dialog
 * opened from a keyboard shortcut. Mounted into `[data-region="dialogs"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
