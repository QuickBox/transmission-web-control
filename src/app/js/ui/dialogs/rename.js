/**
 * Rename a torrent (its top-level file or folder) through
 * `torrent-rename-path`, plus `promptDialog`, the shared one-field dialog
 * other dialogs build on.
 */

/**
 * A dialog with one labelled text field, inline validation and a Save that
 * stays disabled while the request runs.
 *
 * @param {import('../../main.js').AppContext} ctx
 * @param {{
 *   title: string, description?: string, icon?: string, label: string, value?: string,
 *   placeholder?: string, mono?: boolean,
 *   validate?: (value: string) => string|null,
 *   onSave: (value: string) => Promise<unknown>,
 * }} opts `validate` returns an error message or `null`; `onSave` rejecting
 *   with an error shows its message under the field and keeps the dialog open
 * @returns {{ close: (reason?: string) => void, field: HTMLInputElement }}
 */
export function promptDialog(ctx, opts) {
  const { el, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const id = `prompt-${Math.random().toString(36).slice(2, 10)}`;
  const field = el('input', {
    class: ['input', opts.mono && 'mono'], id, value: opts.value || '', autocomplete: 'off', spellcheck: 'false',
    placeholder: opts.placeholder || null, 'aria-describedby': `${id}-error`,
  });
  const error = el('p', { class: 'field-error', id: `${id}-error`, role: 'alert' });
  const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
  const save = el('button', { type: 'button', class: 'btn btn-primary', text: t('core.actions.save') });

  function fail(message) {
    field.setAttribute('aria-invalid', 'true');
    error.textContent = message;
  }

  function submit(e) {
    if (e) e.preventDefault();
    const value = field.value.trim();
    const problem = opts.validate ? opts.validate(value) : null;
    if (problem) {
      fail(problem);
      return;
    }
    field.removeAttribute('aria-invalid');
    error.textContent = '';
    save.disabled = true;
    Promise.resolve()
      .then(() => opts.onSave(value))
      .then(() => dialog.close('saved'), (err) => {
        save.disabled = false;
        fail((err && err.message) || t('dialogs.failed'));
      });
  }

  const form = el('form', { class: 'form-stack', on: { submit } }, [
    el('label', { class: 'field-label', for: id, text: opts.label }),
    field,
    error,
  ]);
  cancel.addEventListener('click', () => dialog.close('cancel'));
  save.addEventListener('click', () => submit());
  const dialog = openDialog({
    title: opts.title,
    description: opts.description,
    icon: opts.icon,
    body: form,
    actions: [cancel, save],
    initialFocus: field,
  });
  if (typeof field.select === 'function') field.select();
  return { close: (reason) => dialog.close(reason), field };
}

/**
 * Check a new file or folder name: not empty, no slash, not `.` or `..`.
 * @returns {'empty'|'slash'|'dots'|null}
 */
export function nameProblem(value) {
  if (!value) return 'empty';
  if (value.includes('/')) return 'slash';
  if (value === '.' || value === '..') return 'dots';
  return null;
}

/**
 * @param {import('../../main.js').AppContext} ctx
 */
export function createRenameDialog(ctx) {
  const { toast } = ctx.ui;
  const t = ctx.i18n;

  /**
   * @param {number} id
   * @returns {{ close: () => void }|null} `null` when the torrent is unknown
   */
  function open(id) {
    const torrent = ctx.store.get().torrents.get(id);
    if (!torrent) return null;
    return promptDialog(ctx, {
      title: t('dialogs.rename.title'),
      description: torrent.name,
      icon: 'header-rename',
      label: t('dialogs.rename.label'),
      value: torrent.name,
      validate: (value) => {
        const problem = nameProblem(value);
        return problem ? t(`dialogs.rename.${problem}`) : null;
      },
      onSave: (value) => {
        if (value === torrent.name) return Promise.resolve();
        return ctx.rpc.call('torrent-rename-path', { ids: [id], path: torrent.name, name: value })
          .then(() => toast(t('dialogs.rename.done', { name: value }), { tone: 'success' }));
      },
    });
  }

  return { open };
}
