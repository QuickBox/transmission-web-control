/**
 * Trackers tab: every tracker by tier, with its announce state, last result
 * and peer counts. Counts the tracker did not report show as an em dash; a
 * failed last announce shows the warning glyph and the tracker's message as
 * text.
 *
 * Editing goes through `setTrackers`. Daemons that take a whole announce list
 * (`caps.trackerList`) get one tiered text editor; older daemons get per-row
 * Add, Edit (replace) and Remove, which `setTrackers` turns into
 * `trackerAdd`, `trackerReplace` and `trackerRemove`.
 *
 * The torrent's `trackers` come with every poll, so the tab fetches nothing.
 */

import { formatTrackerList, parseTrackerList, setTrackers, tiersFromTrackers } from '../../rpc/trackers.js?v=__QBV__';
import { promptDialog } from '../dialogs/rename.js?v=__QBV__';

export const id = 'trackers';
export const labelKey = 'details.tabs.trackers';
export const live = false;
export const fields = Object.freeze([]);

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** @param {string} line */
export function isAnnounceUrl(line) {
  return URL_RE.test(line);
}

/**
 * The first line of `text` that is not an announce URL, or `null`.
 * @param {string} text
 */
export function invalidLine(text) {
  for (const tier of parseTrackerList(text)) for (const url of tier) if (!isAnnounceUrl(url)) return url;
  return null;
}

/**
 * Announce state of one tracker for display.
 * @param {{ lastAnnounceSucceeded: boolean, lastAnnounceTime: number, lastAnnounceResult: string }} tracker
 * @returns {'ok'|'warning'|'pending'}
 */
export function trackerHealth(tracker) {
  if (tracker.lastAnnounceSucceeded) return 'ok';
  if (tracker.lastAnnounceTime > 0) return 'warning';
  return 'pending';
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @returns {import('./index.js').TabView}
 */
export function create(ctx) {
  const { el, icon, tooltip, toast, openDialog, confirm } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;

  let current = null;

  const summary = el('p', { class: 'trackers-summary' });
  const actions = el('div', { class: 'trackers-actions' });
  const list = el('div', { class: 'trackers-list' });
  const root = el('div', { class: 'trackers' }, [el('div', { class: 'trackers-bar' }, [summary, actions]), list]);

  function count(n) {
    return n == null || n < 0 ? '—' : fmt.count(n);
  }

  function listMode() {
    return Boolean(ctx.caps && ctx.caps.trackerList);
  }

  /** Write the tiers; resolves after the success toast, rejects with a readable message. */
  function save(tiers) {
    const torrentId = current.id;
    return Promise.resolve()
      .then(() => setTrackers(ctx.rpc, ctx.caps, [torrentId], tiers))
      .then(() => { toast(t('details.trackers.saved'), { tone: 'success' }); }, (err) => {
        throw new Error(t('details.trackers.saveFailed', { message: (err && err.message) || '' }));
      });
  }

  /** The one-field dialog for an announce URL. */
  function urlDialog({ title, value, onSave }) {
    return promptDialog(ctx, {
      title,
      icon: 'tab-trackers',
      label: t('details.trackers.url'),
      value,
      placeholder: t('details.trackers.urlPlaceholder'),
      mono: true,
      validate: (url) => (isAnnounceUrl(url) ? null : t('details.trackers.invalidUrl')),
      onSave,
    });
  }

  function editList() {
    const text = formatTrackerList(tiersFromTrackers(current.trackers));
    const area = el('textarea', {
      class: 'textarea mono', id: `tracker-list-${current.id}`, rows: 10, spellcheck: 'false', value: text,
      'aria-describedby': `tracker-list-help-${current.id}`,
    });
    const help = el('p', { class: 'field-help', id: `tracker-list-help-${current.id}`, text: t('details.trackers.listHelp') });
    const error = el('p', { class: 'field-error', role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const ok = el('button', { type: 'button', class: 'btn btn-primary', text: t('core.actions.save') });
    const dialog = openDialog({
      title: t('details.trackers.editTitle'),
      description: current.name,
      icon: 'tab-trackers',
      size: 'lg',
      body: el('div', { class: 'form-stack' }, [
        el('label', { class: 'field-label', for: area.id, text: t('details.trackers.announceList') }),
        area, help, error,
      ]),
      actions: [cancel, ok],
      initialFocus: area,
    });
    cancel.addEventListener('click', () => dialog.close('cancel'));
    ok.addEventListener('click', () => {
      const bad = invalidLine(area.value);
      if (bad) {
        area.setAttribute('aria-invalid', 'true');
        error.textContent = t('details.trackers.invalidLine', { line: bad });
        return;
      }
      ok.disabled = true;
      save(area.value).then(() => dialog.close('saved'), (err) => {
        ok.disabled = false;
        error.textContent = err.message;
      });
    });
    return dialog;
  }

  function addTracker() {
    return urlDialog({
      title: t('details.trackers.addTitle'),
      onSave: (url) => save([...tiersFromTrackers(current.trackers), [url]]),
    });
  }

  function replaceTracker(tracker) {
    return urlDialog({
      title: t('details.trackers.editOne'),
      value: tracker.announce,
      onSave: (url) => save(tiersFromTrackers(current.trackers)
        .map((tier) => tier.map((u) => (u === tracker.announce ? url : u)))),
    });
  }

  function removeTracker(tracker) {
    return confirm({
      title: t('details.trackers.removeTitle'),
      message: t('details.trackers.removeMessage', { host: tracker.host || tracker.announce }),
      confirmLabel: t('details.trackers.remove'),
      destructive: true,
    }).then((yes) => {
      if (!yes) return null;
      const tiers = tiersFromTrackers(current.trackers)
        .map((tier) => tier.filter((u) => u !== tracker.announce))
        .filter((tier) => tier.length > 0);
      return save(tiers).catch((err) => { toast(err.message, { tone: 'error' }); });
    });
  }

  function rowButton(iconName, labelKey, vars, focusKey, onClick) {
    const label = t(labelKey, vars);
    const button = el('button', {
      type: 'button', class: 'btn-icon btn-icon-xs', 'aria-label': label, 'data-focus': focusKey, on: { click: onClick },
    }, [icon(iconName, { size: 14 })]);
    tooltip(button, label);
    return button;
  }

  function trackerRow(tracker, editable) {
    const health = trackerHealth(tracker);
    const glyph = health === 'ok' ? 'menu-check' : health === 'warning' ? 'state-error' : 'state-queued';
    const host = tracker.host || tracker.announce;
    const next = tracker.nextAnnounceTime > 0 ? tracker.nextAnnounceTime - Math.floor(Date.now() / 1000) : -1;
    const lastLine = health === 'pending'
      ? t('details.trackers.notAnnounced')
      : t('details.trackers.lastAnnounce', {
        when: fmt.date(tracker.lastAnnounceTime),
        result: tracker.lastAnnounceResult || t(health === 'ok' ? 'details.trackers.success' : 'details.trackers.failed'),
      });
    return el('li', { class: ['tracker', `is-${health}`] }, [
      el('span', { class: 'tracker-glyph' }, [icon(glyph, { size: 16, label: t(`details.trackers.health.${health}`) })]),
      el('div', { class: 'tracker-main' }, [
        el('p', { class: 'tracker-host', text: host }),
        el('p', { class: 'tracker-url mono', text: tracker.announce }),
        el('p', { class: 'tracker-last', text: lastLine }),
        el('p', { class: 'tracker-counts tabular' }, [
          el('span', { text: t('details.trackers.seeders', { count: count(tracker.seederCount) }) }),
          el('span', { text: t('details.trackers.leechers', { count: count(tracker.leecherCount) }) }),
          el('span', { text: t('details.trackers.downloads', { count: count(tracker.downloadCount) }) }),
          next > 0 ? el('span', { text: t('details.trackers.next', { in: fmt.eta(next) }) }) : null,
        ]),
      ]),
      editable ? el('div', { class: 'tracker-actions' }, [
        rowButton('header-rename', 'details.trackers.editOneFor', { host }, `edit ${tracker.announce}`, () => replaceTracker(tracker)),
        rowButton('toolbar-remove', 'details.trackers.removeFor', { host }, `remove ${tracker.announce}`, () => removeTracker(tracker)),
      ]) : null,
    ]);
  }

  return {
    root,
    render(torrent) {
      current = torrent;
      const active = document.activeElement;
      const focusKey = active && root.contains(active) ? active.getAttribute('data-focus') : null;
      const trackers = Array.isArray(torrent.trackers) ? torrent.trackers : [];
      const byTier = new Map();
      for (const tr of trackers) {
        if (!byTier.has(tr.tier)) byTier.set(tr.tier, []);
        byTier.get(tr.tier).push(tr);
      }
      const tiers = [...byTier.keys()].sort((a, b) => a - b);
      const editable = !listMode();
      summary.textContent = trackers.length
        ? t('details.trackers.summary', { count: trackers.length, total: fmt.count(trackers.length), tiers: fmt.count(tiers.length) })
        : t('details.trackers.none');
      actions.replaceChildren(listMode()
        ? el('button', { type: 'button', class: 'btn btn-secondary', 'data-focus': 'bar', on: { click: editList } }, [
          icon('header-rename', { size: 16 }), t('details.trackers.edit')])
        : el('button', { type: 'button', class: 'btn btn-secondary', 'data-focus': 'bar', on: { click: addTracker } }, [
          icon('toolbar-add', { size: 16 }), t('details.trackers.add')]));
      list.replaceChildren(...tiers.map((tier, i) => el('section', { class: 'tracker-tier' }, [
        el('h3', { class: 'detail-label', text: t('details.trackers.tier', { n: fmt.count(i + 1) }) }),
        el('ul', { class: 'tracker-rows' }, byTier.get(tier).map((tr) => trackerRow(tr, editable))),
      ])));
      if (focusKey) {
        const again = [...root.querySelectorAll('[data-focus]')].find((n) => n.getAttribute('data-focus') === focusKey);
        if (again) again.focus();
      }
    },
  };
}
