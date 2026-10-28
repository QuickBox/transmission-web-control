/**
 * Peers tab: connected peers, busiest first. Addresses and client names come
 * from remote peers and render as text only. No geolocation and no lookups:
 * nothing about a peer leaves this page.
 */

export const id = 'peers';
export const labelKey = 'details.tabs.peers';
export const live = true;
export const fields = Object.freeze(['peers']);

/**
 * `address:port`, with IPv6 addresses bracketed.
 * @param {{ address?: string, port?: number }} peer
 */
export function peerAddress(peer) {
  const address = typeof peer.address === 'string' ? peer.address : '';
  const port = Number.isFinite(peer.port) && peer.port > 0 ? `:${peer.port}` : '';
  return address.includes(':') ? `[${address}]${port}` : `${address}${port}`;
}

function rate(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Busiest first (download plus upload rate), then by address.
 * @param {object[]} list
 */
export function sortPeers(list) {
  return list
    .filter((p) => p && typeof p === 'object')
    .slice()
    .sort((a, b) => (rate(b.rateToClient) + rate(b.rateToPeer)) - (rate(a.rateToClient) + rate(a.rateToPeer))
      || peerAddress(a).localeCompare(peerAddress(b)));
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @returns {import('./index.js').TabView}
 */
export function create(ctx) {
  const { el } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;

  const summary = el('p', { class: 'peers-summary tabular' });
  const message = el('p', { class: 'details-message' });
  const tbody = el('tbody');
  const table = el('table', { class: 'peers-table' }, [
    el('caption', { class: 'sr-only', text: t('details.peers.caption') }),
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: t('details.peers.address') }),
      el('th', { scope: 'col', text: t('details.peers.client') }),
      el('th', { scope: 'col', class: 'num', text: t('details.peers.progress') }),
      el('th', { scope: 'col', class: 'num', text: t('details.peers.down') }),
      el('th', { scope: 'col', class: 'num', text: t('details.peers.up') }),
      el('th', { scope: 'col', text: t('details.peers.flags') }),
    ])]),
    tbody,
  ]);
  const scroller = el('div', { class: 'peers-scroll' }, [table]);
  const root = el('div', { class: 'peers' }, [summary, message, scroller]);

  function cell(labelKey, extra) {
    return el('td', { class: extra, 'data-label': t(labelKey) });
  }

  // One row per peer address, kept across polls and patched in place, so a
  // screen reader's place in the table and a text selection survive a poll.
  const rowNodes = new Map();

  function rowFor(peer) {
    const key = peerAddress(peer);
    let r = rowNodes.get(key);
    if (!r) {
      r = [
        cell('details.peers.address', 'mono'),
        cell('details.peers.client', 'peer-client'),
        cell('details.peers.progress', 'num tabular'),
        cell('details.peers.down', 'num tabular'),
        cell('details.peers.up', 'num tabular'),
        cell('details.peers.flags', 'mono peer-flags'),
      ];
      r.el = el('tr', {}, r);
      rowNodes.set(key, r);
    }
    const texts = [
      key,
      typeof peer.clientName === 'string' && peer.clientName ? peer.clientName : '—',
      fmt.percent(rate(peer.progress), { digits: 0 }),
      fmt.speed(rate(peer.rateToClient)),
      fmt.speed(rate(peer.rateToPeer)),
      typeof peer.flagStr === 'string' ? peer.flagStr : '',
    ];
    texts.forEach((text, i) => { if (r[i].textContent !== text) r[i].textContent = text; });
    return r.el;
  }

  function placeRows(rows) {
    const current = [...tbody.children];
    if (current.length === rows.length && current.every((n, i) => n === rows[i])) return;
    const keep = new Set(rows);
    for (const n of current) if (!keep.has(n)) n.remove();
    for (const n of rows) tbody.append(n);
  }

  return {
    root,
    render(torrent, detail, state) {
      const list = detail && Array.isArray(detail.peers) ? sortPeers(detail.peers) : null;
      if (!list || list.length === 0) {
        tbody.replaceChildren();
        rowNodes.clear();
        scroller.hidden = true;
        summary.textContent = '';
        message.hidden = false;
        message.textContent = state.error ? t('details.loadFailedWith', { message: state.error })
          : !list && state.loading ? t('details.loading') : t('details.peers.none');
        return;
      }
      message.hidden = !state.error;
      if (state.error) message.textContent = t('details.loadFailedWith', { message: state.error });
      scroller.hidden = false;
      summary.textContent = t('details.peers.count', { count: list.length, total: fmt.count(list.length) });
      const rows = list.map(rowFor);
      const live = new Set(rows);
      for (const [key, r] of rowNodes) if (!live.has(r.el)) rowNodes.delete(key);
      placeRows(rows);
    },
  };
}
