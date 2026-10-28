/**
 * Footer chips: download/upload rate and limits, alt-speed, free space, port
 * status, Transmission and RPC version, torrent counts. Reads `stats`,
 * `session`, `connection`. Mounted into `[data-region="statusbar"]`.
 *
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {}
