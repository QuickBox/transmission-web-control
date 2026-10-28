/**
 * Footer chips: download/upload rate and limits, alt-speed, free space, port
 * status, Transmission and RPC version, torrent counts, and the connection
 * state in a polite live region. Reads `stats`, `session`, `connection`,
 * `torrents`, `selection`. Below 640px only the down, up and free-space chips
 * stay (`data-essential`). Mounted into `[data-region="statusbar"]`.
 */

import { getFreeSpace, testPort } from '../rpc/session.js?v=__QBV__';

/** Free space is re-read at most this often while polling continues. */
export const FREE_SPACE_INTERVAL_MS = 60_000;

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../main.js').AppContext} ctx Shared services, see `main.js`.
 * @param {{ now?: () => number }} [options]
 * @returns {() => void} Teardown.
 */
export function mount(root, ctx, options = {}) {
  const { el, clear, icon, tooltip } = ctx.ui;
  const t = ctx.i18n;
  const { store } = ctx;
  const now = options.now || Date.now;

  function chip(id, iconName, extra = {}) {
    const value = el('span', { class: 'chip-value', text: '' });
    const node = el('span', {
      class: ['chip', extra.class],
      'data-chip': id,
      'data-essential': extra.essential ? '' : null,
      hidden: Boolean(extra.hidden),
    }, [iconName ? icon(iconName, { size: 14 }) : null, value]);
    return { node, value };
  }

  const down = chip('down', 'statusbar-download', { essential: true });
  const up = chip('up', 'statusbar-upload', { essential: true });
  const alt = chip('alt-speed', 'tab-speed', { hidden: true });
  const free = chip('free', 'meter-disk', { essential: true });
  const port = chip('port', 'statusbar-port');
  const version = chip('version', null);
  const counts = chip('counts', null);
  const connection = el('span', { class: 'chip chip-connection', 'data-chip': 'connection', role: 'status', 'aria-live': 'polite', hidden: true });

  tooltip(down.node, () => t('main.statusbar.down'));
  tooltip(up.node, () => t('main.statusbar.up'));
  tooltip(alt.node, () => t('main.statusbar.altSpeed'));
  tooltip(free.node, () => t('main.statusbar.free'));
  tooltip(port.node, () => t('main.statusbar.port'));
  tooltip(version.node, () => t('main.statusbar.version'));

  clear(root, down.node, up.node, alt.node, free.node, port.node, el('span', { class: 'chip-spacer' }), connection, version.node, counts.node);

  function rate(speed, limited, limit) {
    const text = ctx.fmt.speed(speed || 0);
    return limited && Number.isFinite(limit) ? t('main.statusbar.limit', { rate: text, limit: ctx.fmt.speed(limit * 1000) }) : text;
  }

  function applyStats() {
    const { stats, session } = store.get();
    const altOn = Boolean(session.altSpeedEnabled);
    down.value.textContent = rate(stats.downloadSpeed, altOn || session.speedLimitDownEnabled, altOn ? session.altSpeedDown : session.speedLimitDown);
    up.value.textContent = rate(stats.uploadSpeed, altOn || session.speedLimitUpEnabled, altOn ? session.altSpeedUp : session.speedLimitUp);
    alt.node.hidden = !altOn;
    alt.value.textContent = altOn ? t('main.statusbar.altSpeedOn') : '';
  }

  function applyCounts() {
    const { torrents, selection } = store.get();
    const total = t('core.count.torrents', { count: torrents.size });
    counts.value.textContent = selection.size > 0 ? `${total} · ${t('core.count.selected', { count: selection.size })}` : total;
  }

  function applyVersion() {
    const { session } = store.get();
    const caps = ctx.caps;
    const daemon = typeof session.version === 'string' ? session.version.replace(/\s*\(.*\)\s*$/, '') : null;
    const rpc = caps && (caps.semver || (caps.rpc > 0 ? String(caps.rpc) : null));
    const parts = [];
    if (daemon) parts.push(t('main.statusbar.version', { version: daemon }));
    if (rpc) parts.push(t('main.statusbar.rpc', { rpc }));
    version.value.textContent = parts.join(' · ');
    version.node.hidden = parts.length === 0;
  }

  function applyConnection() {
    const { connection: c } = store.get();
    const online = c.state === 'online';
    connection.hidden = online;
    connection.setAttribute('data-state', c.state);
    connection.textContent = online ? '' : t(`core.connection.${c.state}`);
  }

  // ---- free space and port: on demand, bounded by time ----------------------

  let freeAt = 0;
  let freeDir = null;
  let freeInFlight = false;
  async function refreshFree(force) {
    const { session, connection: c } = store.get();
    const dir = session.downloadDir;
    if (!dir || c.state !== 'online' || freeInFlight) return;
    if (!force && dir === freeDir && now() - freeAt < FREE_SPACE_INTERVAL_MS) return;
    freeInFlight = true;
    try {
      const out = await getFreeSpace(ctx.rpc, dir);
      freeDir = dir;
      freeAt = now();
      free.value.textContent = out.sizeBytes === null ? ctx.fmt.bytes(NaN) : t('main.statusbar.freeValue', { free: ctx.fmt.bytes(out.sizeBytes) });
    } catch {
      free.value.textContent = ctx.fmt.bytes(NaN);
    } finally {
      freeInFlight = false;
    }
  }

  let portFor = null;
  let portInFlight = false;
  async function refreshPort() {
    const { session, connection: c } = store.get();
    const key = `${session.peerPort}|${ctx.caps && ctx.caps.portTestByProtocol}`;
    if (c.state !== 'online' || portInFlight || key === portFor || session.peerPort === undefined) return;
    portInFlight = true;
    try {
      const results = await testPort(ctx.rpc, ctx.caps);
      portFor = key;
      const labelFor = (r) => {
        const protocol = r.protocol === 'any' ? '' : r.protocol.toUpperCase();
        if (r.open === null) return t('main.statusbar.portUnknown', { protocol });
        return t(r.open ? 'main.statusbar.portOpen' : 'main.statusbar.portClosed', { protocol });
      };
      port.value.textContent = results.map(labelFor).join(' · ').replace(/\s{2,}/g, ' ').trim();
      port.node.setAttribute('data-open', results.every((r) => r.open === true) ? 'true' : results.some((r) => r.open === true) ? 'partial' : 'false');
    } catch {
      port.value.textContent = t('main.statusbar.portUnknown', { protocol: '' }).trim();
      port.node.setAttribute('data-open', 'false');
    } finally {
      portInFlight = false;
    }
  }

  const offs = [
    store.subscribe('stats', () => {
      applyStats();
      refreshFree(false);
    }),
    store.subscribe('session', () => {
      applyStats();
      applyVersion();
      refreshFree(store.get().session.downloadDir !== freeDir);
      refreshPort();
    }),
    store.subscribe('torrents', applyCounts),
    store.subscribe('selection', applyCounts),
    store.subscribe('connection', () => {
      applyConnection();
      refreshFree(false);
      refreshPort();
    }),
  ];
  applyStats();
  applyCounts();
  applyVersion();
  applyConnection();
  refreshFree(true);
  refreshPort();

  return () => {
    for (const off of offs) off();
  };
}
