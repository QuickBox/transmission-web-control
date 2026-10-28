/**
 * Set the data location of the selected torrents through
 * `torrent-set-location`: either move the data to the new folder, or point
 * the torrents at data that is already there. The free space of the typed
 * folder is shown as the user types.
 */

import { getFreeSpace } from '../../rpc/session.js?v=__QBV__';
import { refreshAfterWrite } from '../../rpc/poller.js?v=__QBV__';
import { errorMessage } from '../../core/errors.js?v=__QBV__';

/**
 * The folder the selected torrents share, or the first one's when they differ.
 * @param {Array<{ downloadDir?: string }>} torrents
 */
export function commonDir(torrents) {
  const dirs = torrents.map((t) => (typeof t.downloadDir === 'string' ? t.downloadDir : ''));
  return dirs[0] || '';
}

/**
 * @param {import('../../main.js').AppContext} ctx
 */
export function createLocationDialog(ctx) {
  const { el, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  let seq = 0;

  /**
   * @param {number[]} ids
   * @returns {{ close: () => void }|null} `null` when none of the ids is known
   */
  function open(ids) {
    const map = ctx.store.get().torrents;
    const targets = [...new Set(ids || [])].map((id) => map.get(id)).filter(Boolean);
    if (targets.length === 0) return null;
    const uid = `location-${++seq}`;
    let timer = 0;
    let freeSeq = 0;
    const differ = new Set(targets.map((tor) => tor.downloadDir)).size > 1;

    const field = el('input', {
      class: 'input mono', id: `${uid}-path`, value: commonDir(targets), autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': `${uid}-free ${uid}-error`,
      on: { input: schedule, change: check },
    });
    const free = el('p', { class: 'field-help tabular', id: `${uid}-free`, 'aria-live': 'polite' });
    const error = el('p', { class: 'field-error', id: `${uid}-error`, role: 'alert' });
    const moveRadio = el('input', { type: 'radio', class: 'checkbox', name: `${uid}-mode`, id: `${uid}-move`, checked: true });
    const findRadio = el('input', { type: 'radio', class: 'checkbox', name: `${uid}-mode`, id: `${uid}-find` });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const save = el('button', { type: 'button', class: 'btn btn-primary', text: t('dialogs.location.submit') });

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(check, 400);
    }

    function check() {
      clearTimeout(timer);
      const path = field.value.trim();
      const mine = ++freeSeq;
      if (!path) {
        free.textContent = '';
        return;
      }
      free.textContent = t('dialogs.add.freeChecking');
      Promise.resolve()
        .then(() => getFreeSpace(ctx.rpc, path))
        .then((r) => {
          if (mine !== freeSeq) return;
          free.textContent = r.sizeBytes == null ? t('dialogs.add.freeUnknown')
            : r.totalSize ? t('dialogs.add.freeOf', { free: fmt.bytes(r.sizeBytes), total: fmt.bytes(r.totalSize) })
              : t('dialogs.add.free', { free: fmt.bytes(r.sizeBytes) });
        }, () => {
          if (mine === freeSeq) free.textContent = t('dialogs.add.freeUnknown');
        });
    }

    function submit(e) {
      if (e) e.preventDefault();
      const location = field.value.trim();
      if (!location) {
        field.setAttribute('aria-invalid', 'true');
        error.textContent = t('dialogs.location.empty');
        return;
      }
      field.removeAttribute('aria-invalid');
      error.textContent = '';
      const move = moveRadio.checked;
      save.disabled = true;
      Promise.resolve()
        .then(() => ctx.rpc.call('torrent-set-location', { ids: targets.map((tor) => tor.id), location, move }))
        .then(() => refreshAfterWrite(ctx, targets.map((tor) => tor.id)))
        .then(() => {
          toast(t(move ? 'dialogs.location.moving' : 'dialogs.location.pointed', {
            count: targets.length, total: fmt.count(targets.length),
          }), { tone: 'success' });
          dialog.close('saved');
        }, (err) => {
          save.disabled = false;
          error.textContent = t('dialogs.location.failed', { message: errorMessage(t, err) });
        });
    }

    const body = el('form', { class: 'form-stack', on: { submit } }, [
      el('label', { class: 'field-label', for: field.id, text: t('dialogs.location.folder') }),
      field,
      free,
      differ ? el('p', { class: 'field-help', text: t('dialogs.location.differ') }) : null,
      el('fieldset', { class: 'choice-group' }, [
        el('legend', { class: 'field-label', text: t('dialogs.location.mode') }),
        el('label', { class: 'check-row', for: moveRadio.id }, [moveRadio, el('span', { text: t('dialogs.location.move') })]),
        el('label', { class: 'check-row', for: findRadio.id }, [findRadio, el('span', { text: t('dialogs.location.find') })]),
      ]),
      error,
    ]);
    cancel.addEventListener('click', () => dialog.close('cancel'));
    save.addEventListener('click', () => submit());

    const dialog = openDialog({
      title: targets.length === 1 ? t('dialogs.location.titleOne') : t('dialogs.location.titleMany', {
        count: targets.length, total: fmt.count(targets.length),
      }),
      description: targets.length === 1 ? targets[0].name : null,
      icon: 'header-datadir',
      body,
      actions: [cancel, save],
      initialFocus: field,
      onClose: () => clearTimeout(timer),
    });
    check();
    return { close: () => dialog.close('cancel') };
  }

  return { open };
}
