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

  function cell(labelKey, text, extra) {
    return el('td', { class: extra, 'data-label': t(labelKey), text });
  }

  return {
    root,
    render(torrent, detail, state) {
      const list = detail && Array.isArray(detail.peers) ? sortPeers(detail.peers) : null;
      if (!list || list.length === 0) {
        tbody.replaceChildren();
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
      tbody.replaceChildren(...list.map((peer) => el('tr', {}, [
        cell('details.peers.address', peerAddress(peer), 'mono'),
        cell('details.peers.client', typeof peer.clientName === 'string' && peer.clientName ? peer.clientName : '—', 'peer-client'),
        cell('details.peers.progress', fmt.percent(rate(peer.progress), { digits: 0 }), 'num tabular'),
        cell('details.peers.down', fmt.speed(rate(peer.rateToClient)), 'num tabular'),
        cell('details.peers.up', fmt.speed(rate(peer.rateToPeer)), 'num tabular'),
        cell('details.peers.flags', typeof peer.flagStr === 'string' ? peer.flagStr : '', 'mono peer-flags'),
      ])));
    },
  };
}
