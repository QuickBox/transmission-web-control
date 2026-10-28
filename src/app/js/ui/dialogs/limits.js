/**
 * Speed limits: the download and upload limits (and whether the global limits
 * apply) for the selected torrents, and the session's alternative speed
 * limits. Torrent values are read with one `torrent-get`; when the selection
 * disagrees, the field starts blank and is only written if the user sets it.
 * Session values go through `setSession`, which skips unchanged keys and keys
 * the daemon does not have. Speeds are whole kB/s.
 */

import { setSession } from '../../rpc/session.js?v=__QBV__';
import { parseAmount } from '../details/options.js?v=__QBV__';
import { errorMessage } from '../../core/errors.js?v=__QBV__';

const TORRENT_FIELDS = Object.freeze([
  'id', 'downloadLimit', 'downloadLimited', 'uploadLimit', 'uploadLimited', 'honorsSessionLimits',
]);

/**
 * The shared value of `key` across rows, or `undefined` when they differ or
 * none reported it.
 */
export function shared(rows, key) {
  const values = rows.map((r) => r[key]).filter((v) => v !== undefined);
  if (values.length === 0 || values.length !== rows.length) return undefined;
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

/**
 * @param {import('../../main.js').AppContext} ctx
 */
export function createLimitsDialog(ctx) {
  const { el, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  let seq = 0;

  /**
   * @param {number[]} [ids] the selection; without it only the session section shows
   * @returns {{ close: () => void, ready: Promise<void> }}
   */
  function open(ids) {
    const map = ctx.store.get().torrents;
    const targets = [...new Set(ids || [])].filter((id) => map.has(id));
    const session = ctx.store.get().session || {};
    const uid = `limits-${++seq}`;
    const dirty = new Set();

    function switchControl(key, labelKey) {
      const labelId = `${uid}-${key}-label`;
      const control = el('button', {
        type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': labelId,
        on: {
          click: () => {
            control.setAttribute('aria-checked', String(control.getAttribute('aria-checked') !== 'true'));
            dirty.add(key);
            sync();
          },
        },
      });
      const row = el('div', { class: 'option-row' }, [el('span', { class: 'option-label', id: labelId, text: t(labelKey) }), control]);
      return { row, control, key, get: () => control.getAttribute('aria-checked') === 'true', set: (on) => control.setAttribute('aria-checked', String(Boolean(on))) };
    }

    function numberControl(key, labelKey) {
      const id = `${uid}-${key}`;
      const control = el('input', {
        class: 'input option-number tabular', id, type: 'text', inputmode: 'numeric', autocomplete: 'off',
        on: { input: () => { dirty.add(key); control.removeAttribute('aria-invalid'); } },
      });
      const row = el('div', { class: 'option-row' }, [
        el('label', { class: 'option-label', for: id, text: t(labelKey) }),
        el('span', { class: 'option-field' }, [control, el('span', { class: 'option-unit', text: t('details.options.kbps') })]),
      ]);
      return {
        row, control, key,
        get: () => parseAmount(control.value, 0),
        set: (n) => { control.value = Number.isFinite(n) ? String(Math.round(n)) : ''; },
      };
    }

    const downOn = switchControl('downloadLimited', 'details.options.limitDownload');
    const down = numberControl('downloadLimit', 'details.options.downloadRate');
    const upOn = switchControl('uploadLimited', 'details.options.limitUpload');
    const up = numberControl('uploadLimit', 'details.options.uploadRate');
    const honors = switchControl('honorsSessionLimits', 'details.options.honorGlobal');
    const altDown = numberControl('alt-speed-down', 'dialogs.limits.altDown');
    const altUp = numberControl('alt-speed-up', 'dialogs.limits.altUp');
    const altOn = switchControl('alt-speed-enabled', 'dialogs.limits.altEnabled');
    altDown.set(Number(session.altSpeedDown));
    altUp.set(Number(session.altSpeedUp));
    altOn.set(session.altSpeedEnabled === true);

    const status = el('p', { class: 'field-help', 'aria-live': 'polite' });
    const error = el('p', { class: 'field-error', role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const save = el('button', { type: 'button', class: 'btn btn-primary', text: t('core.actions.save') });

    function sync() {
      down.control.disabled = !downOn.get();
      up.control.disabled = !upOn.get();
    }

    const torrentSection = targets.length ? el('section', { class: 'option-card' }, [
      el('h3', { class: 'detail-label', text: t('dialogs.limits.torrents', { count: targets.length, total: fmt.count(targets.length) }) }),
      downOn.row, down.row, upOn.row, up.row, honors.row, status,
    ]) : null;
    const sessionSection = el('section', { class: 'option-card' }, [
      el('h3', { class: 'detail-label', text: t('dialogs.limits.alt') }),
      el('p', { class: 'field-help', text: t('dialogs.limits.altHelp') }),
      altOn.row, altDown.row, altUp.row,
    ]);

    let ready = Promise.resolve();
    if (targets.length) {
      status.textContent = t('details.loading');
      ready = Promise.resolve()
        .then(() => ctx.rpc.call('torrent-get', { ids: targets, fields: [...TORRENT_FIELDS] }))
        .then((result) => {
          const rows = (result && Array.isArray(result.torrents) ? result.torrents : []).filter((r) => r && targets.includes(r.id));
          for (const c of [downOn, upOn, honors]) if (!dirty.has(c.key)) c.set(shared(rows, c.key) === true);
          for (const c of [down, up]) if (!dirty.has(c.key)) c.set(Number(shared(rows, c.key)));
          const mixed = TORRENT_FIELDS.slice(1).some((k) => shared(rows, k) === undefined);
          status.textContent = mixed ? t('dialogs.limits.mixed') : '';
          sync();
        }, () => {
          status.textContent = t('dialogs.limits.readFailed');
        });
    }
    sync();

    function submit() {
      error.textContent = '';
      const bad = [down, up, altDown, altUp].filter((c) => dirty.has(c.key) && c.control.value.trim() !== '' && c.get() === null);
      for (const c of bad) c.control.setAttribute('aria-invalid', 'true');
      if (bad.length) {
        error.textContent = t('dialogs.limits.invalid');
        return;
      }
      const torrentArgs = {};
      for (const c of [downOn, upOn, honors]) if (dirty.has(c.key)) torrentArgs[c.key] = c.get();
      for (const c of [down, up]) if (dirty.has(c.key) && c.get() !== null) torrentArgs[c.key] = c.get();
      const patch = {};
      for (const c of [altDown, altUp]) if (dirty.has(c.key) && c.get() !== null) patch[c.key] = c.get();
      if (dirty.has(altOn.key)) patch[altOn.key] = altOn.get();

      save.disabled = true;
      Promise.resolve()
        .then(() => (targets.length && Object.keys(torrentArgs).length
          ? ctx.rpc.call('torrent-set', { ids: targets, ...torrentArgs }) : null))
        .then(() => (Object.keys(patch).length ? setSession(ctx.rpc, ctx.caps, session, patch) : null))
        .then(() => {
          toast(t('dialogs.limits.saved'), { tone: 'success' });
          dialog.close('saved');
        }, (err) => {
          save.disabled = false;
          error.textContent = t('dialogs.limits.failed', { message: errorMessage(t, err) });
        });
    }

    cancel.addEventListener('click', () => dialog.close('cancel'));
    save.addEventListener('click', submit);
    const dialog = openDialog({
      title: t('dialogs.limits.title'),
      icon: 'tab-speed',
      body: el('div', { class: 'limits-form' }, [torrentSection, sessionSection, error]),
      actions: [cancel, save],
      initialFocus: targets.length ? downOn.control : altOn.control,
    });
    return { close: () => dialog.close('cancel'), ready };
  }

  return { open };
}
