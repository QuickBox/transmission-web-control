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

/** A port test that failed outright is not repeated sooner than this. */
export const PORT_RETRY_MS = 60_000;

const PROTOCOL_LABEL = Object.freeze({ ipv4: 'IPv4', ipv6: 'IPv6' });

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
  tooltip(version.node, () => t('main.statusbar.versionTip'));

  free.value.textContent = t('main.statusbar.freeChecking');

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
    const { torrents, selection, order, filter } = store.get();
    const all = t('core.count.torrents', { count: torrents.size });
    // With a filter or search active the list is shorter than the daemon's set.
    const filtered = Boolean(filter) && (filter.status !== 'all' || filter.label || filter.tracker || filter.folder || filter.search);
    const total = filtered && order.length !== torrents.size ? t('main.statusbar.countsOf', { shown: ctx.fmt.count(order.length), total: all }) : all;
    counts.value.textContent = selection.size > 0 ? `${total} · ${t('core.count.selected', { count: selection.size })}` : total;
  }

  function applyVersion() {
    const { session } = store.get();
    const caps = ctx.caps;
    const daemon = typeof session.version === 'string' ? session.version.replace(/\s*\(.*\)\s*$/, '') : null;
    let rpc = null;
    if (caps && caps.dialect === 'legacy' && caps.rpc > 0) rpc = t('main.statusbar.rpc', { rpc: String(caps.rpc) });
    else if (caps && caps.semver) rpc = t('main.statusbar.rpcSemver', { semver: caps.semver });
    const parts = [];
    if (daemon) parts.push(t('main.statusbar.version', { version: daemon }));
    if (rpc) parts.push(rpc);
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
  let portRetry = { key: null, at: 0 };

  function portLine(port, states) {
    return t('main.statusbar.portLine', { port: String(port), states });
  }

  function portState(r) {
    if (r.unavailable) return t('main.statusbar.portStateUnavailable');
    if (r.open === null) return t('main.statusbar.portStateUnknown');
    return t(r.open ? 'main.statusbar.portStateOpen' : 'main.statusbar.portStateClosed');
  }

  function portStates(results) {
    return results
      .map((r) => (r.protocol === 'any' ? portState(r) : t('main.statusbar.portProtocol', { protocol: PROTOCOL_LABEL[r.protocol] || r.protocol, state: portState(r) })))
      .join(' · ');
  }

  /** Only probes that produced a verdict colour the chip; an unavailable one is neither open nor closed. */
  function portOpenness(results) {
    const known = results.filter((r) => r.open !== null);
    if (known.length === 0) return 'unknown';
    if (known.every((r) => r.open)) return 'true';
    return known.some((r) => r.open) ? 'partial' : 'false';
  }

  async function refreshPort() {
    const { session, connection: c } = store.get();
    const peerPort = session.peerPort;
    const key = `${peerPort}|${ctx.caps && ctx.caps.portTestByProtocol}`;
    if (c.state !== 'online' || portInFlight || key === portFor || peerPort === undefined) return;
    if (portRetry.key === key && now() < portRetry.at) return;
    portInFlight = true;
    port.value.textContent = portLine(peerPort, t('main.statusbar.portStateChecking'));
    port.node.setAttribute('data-open', 'unknown');
    try {
      const results = await testPort(ctx.rpc, ctx.caps);
      portFor = key;
      port.value.textContent = portLine(peerPort, portStates(results));
      port.node.setAttribute('data-open', portOpenness(results));
    } catch {
      portRetry = { key, at: now() + PORT_RETRY_MS };
      port.value.textContent = portLine(peerPort, t('main.statusbar.portStateUnavailable'));
      port.node.setAttribute('data-open', 'unknown');
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
    store.subscribe('order', applyCounts),
    store.subscribe('filter', applyCounts),
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
