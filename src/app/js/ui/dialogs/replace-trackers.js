/**
 * Replace trackers: swap one announce URL for another in every selected
 * torrent that has it, keeping each torrent's tiers. Each torrent is written
 * through `setTrackers`, so 4.0+ daemons get one `trackerList` write and
 * older ones a `trackerReplace` for the row.
 */

import { setTrackers, tiersFromTrackers } from '../../rpc/trackers.js?v=__QBV__';
import { isAnnounceUrl } from '../details/trackers.js?v=__QBV__';

/**
 * The torrents that announce to `url`, and each one's tiers after the swap.
 * A torrent that already has `replacement` loses `url` instead of gaining a
 * duplicate.
 * @param {Array<{ id: number, trackers?: Array<{ announce: string, tier: number }> }>} torrents
 * @param {string} url
 * @param {string} replacement
 * @returns {Array<{ id: number, tiers: string[][] }>}
 */
export function planReplace(torrents, url, replacement) {
  const plan = [];
  for (const torrent of torrents) {
    const tiers = tiersFromTrackers(torrent.trackers || []);
    if (!tiers.some((tier) => tier.includes(url))) continue;
    const already = tiers.some((tier) => tier.includes(replacement));
    const next = tiers
      .map((tier) => tier.flatMap((u) => (u === url ? (already ? [] : [replacement]) : [u])))
      .filter((tier) => tier.length > 0);
    plan.push({ id: torrent.id, tiers: next });
  }
  return plan;
}

/** Every announce URL the torrents use, sorted. */
export function announceUrls(torrents) {
  const set = new Set();
  for (const t of torrents) for (const tr of t.trackers || []) if (tr.announce) set.add(tr.announce);
  return [...set].sort();
}

/**
 * @param {import('../../main.js').AppContext} ctx
 */
export function createReplaceTrackersDialog(ctx) {
  const { el, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  let seq = 0;

  /**
   * @param {number[]} [ids] the selection; without it every torrent is searched
   * @returns {{ close: () => void }}
   */
  function open(ids) {
    const map = ctx.store.get().torrents;
    const scope = ids && ids.length ? [...new Set(ids)].map((id) => map.get(id)).filter(Boolean) : [...map.values()];
    const uid = `replace-${++seq}`;
    const urls = announceUrls(scope);

    const find = el('input', {
      class: 'input mono', id: `${uid}-find`, autocomplete: 'off', spellcheck: 'false', list: `${uid}-urls`,
      on: { input: preview },
    });
    const list = el('datalist', { id: `${uid}-urls` }, urls.map((u) => el('option', { value: u })));
    const replace = el('input', {
      class: 'input mono', id: `${uid}-with`, autocomplete: 'off', spellcheck: 'false',
      placeholder: t('details.trackers.urlPlaceholder'),
    });
    const summary = el('p', { class: 'field-help', 'aria-live': 'polite' });
    const error = el('p', { class: 'field-error', role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const save = el('button', { type: 'button', class: 'btn btn-primary', text: t('dialogs.replace.submit') });

    function preview() {
      const url = find.value.trim();
      const count = url ? planReplace(scope, url, url).length : 0;
      summary.textContent = url ? t('dialogs.replace.matches', { count, total: fmt.count(count) }) : '';
    }

    async function submit() {
      error.textContent = '';
      const url = find.value.trim();
      const next = replace.value.trim();
      for (const [field, value] of [[find, url], [replace, next]]) {
        if (!isAnnounceUrl(value)) {
          field.setAttribute('aria-invalid', 'true');
          error.textContent = t('details.trackers.invalidUrl');
          return;
        }
        field.removeAttribute('aria-invalid');
      }
      if (url === next) {
        error.textContent = t('dialogs.replace.same');
        return;
      }
      const plan = planReplace(scope, url, next);
      if (plan.length === 0) {
        error.textContent = t('dialogs.replace.none');
        return;
      }
      save.disabled = true;
      let done = 0;
      try {
        for (const step of plan) {
          await setTrackers(ctx.rpc, ctx.caps, [step.id], step.tiers);
          done += 1;
        }
        toast(t('dialogs.replace.done', { count: done, total: fmt.count(done) }), { tone: 'success' });
        dialog.close('saved');
      } catch (err) {
        save.disabled = false;
        error.textContent = t('dialogs.replace.failed', {
          done: fmt.count(done), total: fmt.count(plan.length), message: (err && err.message) || '',
        });
      }
    }

    cancel.addEventListener('click', () => dialog.close('cancel'));
    save.addEventListener('click', () => { submit(); });
    const dialog = openDialog({
      title: t('dialogs.replace.title'),
      description: ids && ids.length
        ? t('dialogs.replace.scopeSelected', { count: scope.length, total: fmt.count(scope.length) })
        : t('dialogs.replace.scopeAll'),
      icon: 'tab-trackers',
      body: el('div', { class: 'form-stack' }, [
        el('label', { class: 'field-label', for: find.id, text: t('dialogs.replace.find') }), find, list,
        el('label', { class: 'field-label', for: replace.id, text: t('dialogs.replace.with') }), replace,
        summary, error,
      ]),
      actions: [cancel, save],
      initialFocus: find,
    });
    return { close: () => dialog.close('cancel') };
  }

  return { open };
}
