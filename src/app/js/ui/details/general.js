/**
 * General tab: transfer stat cards (live, from the store torrent) above the
 * torrent facts (static fields fetched once per torrent). An error or a
 * tracker warning shows as a tinted notice at the top.
 */

export const id = 'general';
export const labelKey = 'details.tabs.general';
export const live = false;
export const fields = Object.freeze([
  'comment', 'creator', 'dateCreated', 'pieceCount', 'pieceSize', 'isPrivate', 'magnetLink',
]);

/**
 * Copy text with the async clipboard, or a selected textarea where that API is
 * missing (plain-http installs are not a secure context).
 * @param {string} text
 * @returns {Promise<void>}
 */
export function copyText(text) {
  const clip = globalThis.navigator && globalThis.navigator.clipboard;
  if (clip && typeof clip.writeText === 'function') return clip.writeText(text);
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.setProperty('position', 'fixed');
    area.style.setProperty('opacity', '0');
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) resolve();
    else reject(new Error('copy failed'));
  });
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @returns {import('./index.js').TabView}
 */
export function create(ctx) {
  const { el, icon, tooltip, toast } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  const values = new Map();

  function value(key, extra) {
    const node = el('span', { class: ['detail-value', extra] });
    values.set(key, node);
    return node;
  }

  function card(key, labelKey) {
    return el('div', { class: 'stat-card' }, [
      el('span', { class: 'detail-label', text: t(labelKey) }),
      value(key, 'tabular'),
    ]);
  }

  function copyButton(labelKey, read) {
    const button = el('button', {
      type: 'button', class: 'btn-icon btn-icon-xs', 'aria-label': t(labelKey),
      on: {
        click: () => {
          const text = read();
          if (!text) return;
          copyText(text).then(
            () => toast(t('core.actions.copied'), { tone: 'success', timeout: 2000 }),
            () => toast(t('details.general.copyFailed'), { tone: 'error' }),
          );
        },
      },
    }, [icon('fm-copy', { size: 14 })]);
    tooltip(button, t(labelKey));
    return button;
  }

  function fact(key, labelKey, extras = []) {
    const row = el('div', { class: 'fact' }, [
      el('dt', { class: 'detail-label', text: t(labelKey) }),
      el('dd', { class: 'fact-value' }, [value(key, key === 'hash' || key === 'location' ? 'mono' : null), ...extras]),
    ]);
    return row;
  }

  let current = null;
  let detail = null;

  const notice = el('div', { class: 'details-notice', role: 'status', hidden: true }, [
    el('span', { class: 'details-notice-icon' }, [icon('state-error', { size: 18 })]),
    value('notice'),
  ]);
  const bar = el('div', { class: 'progress', 'aria-hidden': 'true' }, [el('span', { class: 'progress-fill' })]);
  const progressCard = el('div', { class: 'stat-card stat-card-progress' }, [
    el('span', { class: 'detail-label', text: t('details.general.progress') }),
    value('progress', 'tabular'),
    bar,
  ]);

  const root = el('div', { class: 'general' }, [
    notice,
    el('div', { class: 'stat-grid' }, [
      progressCard,
      card('downloaded', 'details.general.downloaded'),
      card('uploaded', 'details.general.uploaded'),
      card('ratio', 'details.general.ratio'),
      card('down', 'details.general.downloadSpeed'),
      card('up', 'details.general.uploadSpeed'),
      card('eta', 'details.general.eta'),
      card('peers', 'details.general.peers'),
      card('seeders', 'details.general.seeders'),
      card('leechers', 'details.general.leechers'),
    ]),
    el('dl', { class: 'facts' }, [
      fact('size', 'details.general.size'),
      fact('location', 'details.general.location'),
      fact('added', 'details.general.added'),
      fact('done', 'details.general.completed'),
      fact('activity', 'details.general.activity'),
      fact('hash', 'details.general.hash', [copyButton('details.general.copyHash', () => current && current.hash)]),
      fact('magnet', 'details.general.magnet', [copyButton('details.general.copyMagnet', () => detail && detail.magnetLink)]),
      fact('pieces', 'details.general.pieces'),
      fact('private', 'details.general.privacy'),
      fact('created', 'details.general.created'),
      fact('creator', 'details.general.creator'),
      fact('comment', 'details.general.comment'),
    ]),
  ]);

  function set(key, text) {
    const node = values.get(key);
    if (node.textContent !== text) node.textContent = text;
  }

  function staticText(text, state) {
    if (typeof text === 'string' && text) return text;
    return state.loading ? '' : '—';
  }

  return {
    root,
    render(torrent, data, state) {
      current = torrent;
      detail = data;
      const d = data || {};

      const problem = torrent.error ? torrent.errorString || t('core.status.error')
        : torrent.warning ? t('details.general.trackerWarning', { message: torrent.warning })
          : state.error ? t('details.loadFailedWith', { message: state.error }) : '';
      notice.hidden = !problem;
      notice.classList.toggle('is-error', Boolean(torrent.error || (!torrent.warning && state.error)));
      set('notice', problem);

      const fraction = torrent.state === 'checking' ? torrent.recheckProgress : torrent.percentDone;
      set('progress', fmt.percent(fraction));
      bar.firstChild.style.setProperty('width', `${Math.max(0, Math.min(1, fraction || 0)) * 100}%`);
      bar.setAttribute('data-state', torrent.state);
      set('downloaded', fmt.bytes(torrent.downloadedEver));
      set('uploaded', fmt.bytes(torrent.uploadedEver));
      set('ratio', fmt.ratio(torrent.uploadRatio));
      set('down', fmt.speed(torrent.rateDownload));
      set('up', fmt.speed(torrent.rateUpload));
      set('eta', torrent.state === 'downloading' ? fmt.eta(torrent.eta) : '—');
      set('peers', t('details.general.peersValue', {
        connected: fmt.count(torrent.peersConnected),
        sending: fmt.count(torrent.peersSendingToUs),
        getting: fmt.count(torrent.peersGettingFromUs),
      }));
      set('seeders', torrent.seederCount == null || torrent.seederCount < 0 ? '—' : fmt.count(torrent.seederCount));
      set('leechers', torrent.leecherCount == null || torrent.leecherCount < 0 ? '—' : fmt.count(torrent.leecherCount));

      set('size', torrent.sizeWhenDone === torrent.totalSize
        ? fmt.bytes(torrent.totalSize)
        : t('details.general.sizePartial', { wanted: fmt.bytes(torrent.sizeWhenDone), total: fmt.bytes(torrent.totalSize) }));
      set('location', torrent.downloadDir || '—');
      set('added', fmt.date(torrent.addedDate));
      set('done', fmt.date(torrent.doneDate));
      set('activity', fmt.date(torrent.activityDate));
      set('hash', torrent.hash || '—');
      set('magnet', staticText(d.magnetLink ? t('details.general.magnetReady') : '', state));
      set('pieces', Number.isFinite(d.pieceCount) && d.pieceCount > 0
        ? t('details.general.piecesValue', { count: fmt.count(d.pieceCount), size: fmt.bytes(d.pieceSize, { base: 1024 }) })
        : staticText('', state));
      set('private', typeof d.isPrivate === 'boolean'
        ? t(d.isPrivate ? 'details.general.private' : 'details.general.public') : staticText('', state));
      set('created', Number.isFinite(d.dateCreated) && d.dateCreated > 0 ? fmt.date(d.dateCreated) : staticText('', state));
      set('creator', staticText(d.creator, state));
      set('comment', staticText(d.comment, state));
    },
  };
}
