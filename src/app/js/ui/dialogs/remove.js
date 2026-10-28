/**
 * Remove torrents: a destructive confirm with focus on Cancel. Downloaded
 * data is kept unless the user ticks the delete option, which also changes
 * the confirm label so the consequence is stated on the button itself.
 */

import { errorMessage } from '../../core/errors.js?v=__QBV__';

const LISTED = 5;

/**
 * @param {import('../../main.js').AppContext} ctx
 */
export function createRemoveDialog(ctx) {
  const { el, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;

  /**
   * @param {number[]} ids
   * @returns {{ close: () => void }|null} `null` when none of the ids is known
   */
  function open(ids) {
    const torrents = ctx.store.get().torrents;
    const targets = [...new Set(ids || [])].map((id) => torrents.get(id)).filter(Boolean);
    if (targets.length === 0) return null;
    const one = targets.length === 1;
    const checkId = `remove-data-${targets[0].id}`;

    const deleteData = el('input', {
      type: 'checkbox', id: checkId, class: 'checkbox', checked: false,
      on: { change: syncLabel },
    });
    const warn = el('p', { class: 'remove-warning', hidden: true, text: t('dialogs.remove.dataWarning') });
    const names = el('ul', { class: 'remove-names' }, [
      ...targets.slice(0, LISTED).map((tor) => el('li', { class: 'remove-name', text: tor.name })),
      targets.length > LISTED
        ? el('li', { class: 'remove-more', text: t('dialogs.remove.andMore', { count: targets.length - LISTED, total: fmt.count(targets.length - LISTED) }) })
        : null,
    ]);
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const confirmButton = el('button', { type: 'button', class: 'btn btn-destructive', text: t('dialogs.remove.confirm') });

    function syncLabel() {
      confirmButton.textContent = t(deleteData.checked ? 'dialogs.remove.confirmDelete' : 'dialogs.remove.confirm');
      warn.hidden = !deleteData.checked;
    }

    function remove() {
      const removeIds = targets.map((tor) => tor.id);
      confirmButton.disabled = true;
      Promise.resolve()
        .then(() => ctx.rpc.call('torrent-remove', { ids: removeIds, 'delete-local-data': deleteData.checked }))
        .then(() => {
          const { selection, focused } = ctx.store.get();
          const patch = {};
          if (removeIds.some((id) => selection.has(id))) patch.selection = new Set([...selection].filter((id) => !removeIds.includes(id)));
          if (removeIds.includes(focused)) patch.focused = null;
          if (Object.keys(patch).length) ctx.store.set(patch);
          toast(t('dialogs.remove.done', { count: removeIds.length, total: fmt.count(removeIds.length) }), { tone: 'success' });
          dialog.close('removed');
        }, (err) => {
          confirmButton.disabled = false;
          toast(t('dialogs.remove.failed', { message: errorMessage(t, err) }), { tone: 'error' });
        });
    }

    cancel.addEventListener('click', () => dialog.close('cancel'));
    confirmButton.addEventListener('click', remove);

    const dialog = openDialog({
      title: one ? t('dialogs.remove.titleOne') : t('dialogs.remove.titleMany', { count: targets.length, total: fmt.count(targets.length) }),
      description: t('dialogs.remove.message', { count: targets.length }),
      tone: 'danger',
      size: 'sm',
      body: [
        names,
        el('label', { class: 'check-row', for: checkId }, [deleteData, el('span', { text: t('dialogs.remove.deleteData') })]),
        warn,
      ],
      actions: [cancel, confirmButton],
      initialFocus: cancel,
    });
    return { close: () => dialog.close('cancel') };
  }

  return { open };
}
