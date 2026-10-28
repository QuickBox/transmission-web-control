/**
 * Labels for the selected torrents. Every known label is a checkbox that is
 * on, off, or mixed (some selected torrents have it); new labels are typed in.
 * Only the labels the user changed are added or removed, so torrents keep
 * the labels they do not share. Native labels on 3.00 and later, browser
 * storage on 2.94 (`createLabelStore`).
 *
 * On a daemon with native labels, labels saved in this browser by the
 * previous interface can be copied to Transmission once; the browser copy
 * is kept.
 */

import { createLabelStore } from '../../rpc/labels.js?v=__QBV__';
import { browserStorage, parseLabels } from './add.js?v=__QBV__';

/**
 * The label set each torrent ends with: its own labels, minus the removed,
 * plus the added.
 * @param {string[]} current
 * @param {Set<string>} add
 * @param {Set<string>} remove
 */
export function nextLabels(current, add, remove) {
  const out = (current || []).filter((l) => !remove.has(l));
  for (const l of add) if (!out.includes(l)) out.push(l);
  return out;
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @param {{ storage?: object }} [deps]
 */
export function createLabelsDialog(ctx, deps = {}) {
  const { el, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  let seq = 0;

  const store = () => createLabelStore({ client: ctx.rpc, caps: ctx.caps, storage: deps.storage || browserStorage() });

  /**
   * @param {number[]} ids
   * @returns {{ close: () => void }|null}
   */
  function open(ids) {
    const torrentsMap = ctx.store.get().torrents;
    const targets = [...new Set(ids || [])].map((id) => torrentsMap.get(id)).filter(Boolean);
    if (targets.length === 0) return null;
    const uid = `labels-${++seq}`;
    const labels = store();
    const own = new Map(targets.map((tor) => [tor.id, labels.read(tor)]));
    const known = labels.allLabels([...torrentsMap.values()]);
    const state = new Map();
    for (const label of known) {
      const have = targets.filter((tor) => own.get(tor.id).includes(label)).length;
      state.set(label, have === 0 ? 'false' : have === targets.length ? 'true' : 'mixed');
    }
    const initial = new Map(state);

    const boxes = el('ul', { class: 'label-boxes', 'aria-label': t('dialogs.labels.existing') });
    function renderBoxes() {
      boxes.replaceChildren(...[...state.keys()].map((label, i) => {
        const box = el('input', {
          type: 'checkbox', class: 'checkbox', id: `${uid}-l${i}`,
          checked: state.get(label) === 'true', indeterminate: state.get(label) === 'mixed',
          on: { change: () => { state.set(label, box.checked ? 'true' : 'false'); } },
        });
        return el('li', {}, [el('label', { class: 'check-row', for: box.id }, [box, el('span', { class: 'label-name', text: label })])]);
      }));
      boxes.hidden = state.size === 0;
    }
    renderBoxes();

    const field = el('input', {
      class: 'input', id: `${uid}-new`, autocomplete: 'off', placeholder: t('dialogs.add.labelsPlaceholder'),
      'aria-describedby': `${uid}-error`,
    });
    const error = el('p', { class: 'field-error', id: `${uid}-error`, role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const save = el('button', { type: 'button', class: 'btn btn-primary', text: t('core.actions.save') });

    let offer = null;
    if (labels.mode === 'native') {
      const { count } = labels.importOffer(torrentsMap);
      if (count > 0) {
        const copy = el('button', { type: 'button', class: 'btn btn-secondary', text: t('dialogs.labels.importAction') });
        offer = el('div', { class: 'label-import', role: 'status' }, [
          el('p', { text: t('dialogs.labels.importOffer', { count, total: fmt.count(count) }) }),
          copy,
        ]);
        copy.addEventListener('click', () => {
          copy.disabled = true;
          Promise.resolve()
            .then(() => labels.importLocal(torrentsMap))
            .then(({ imported }) => {
              offer.remove();
              toast(t('dialogs.labels.imported', { count: imported, total: fmt.count(imported) }), { tone: 'success' });
            }, (err) => {
              copy.disabled = false;
              toast(t('dialogs.labels.importFailed', { message: (err && err.message) || '' }), { tone: 'error' });
            });
        });
      }
    }

    function submit() {
      const typed = parseLabels(field.value);
      if (typed.some((l) => l.length > 128)) {
        field.setAttribute('aria-invalid', 'true');
        error.textContent = t('dialogs.labels.tooLong');
        return;
      }
      const add = new Set(typed);
      const remove = new Set();
      for (const [label, value] of state) {
        if (value === initial.get(label)) continue;
        if (value === 'true') add.add(label);
        else remove.add(label);
      }
      if (add.size === 0 && remove.size === 0) {
        dialog.close('cancel');
        return;
      }
      const groups = new Map();
      for (const tor of targets) {
        const next = nextLabels(own.get(tor.id), add, remove);
        const key = JSON.stringify([...next].sort());
        if (key === JSON.stringify([...own.get(tor.id)].sort())) continue;
        if (!groups.has(key)) groups.set(key, { labels: next, torrents: [] });
        groups.get(key).torrents.push(tor);
      }
      save.disabled = true;
      const writes = [...groups.values()];
      writes.reduce((p, g) => p.then(() => labels.write(g.torrents, g.labels)), Promise.resolve())
        .then(() => {
          toast(t('dialogs.labels.saved'), { tone: 'success' });
          dialog.close('saved');
        }, (err) => {
          save.disabled = false;
          error.textContent = t('dialogs.labels.failed', { message: (err && err.message) || '' });
        });
    }

    cancel.addEventListener('click', () => dialog.close('cancel'));
    save.addEventListener('click', submit);

    const dialog = openDialog({
      title: targets.length === 1 ? t('dialogs.labels.titleOne')
        : t('dialogs.labels.titleMany', { count: targets.length, total: fmt.count(targets.length) }),
      description: targets.length === 1 ? targets[0].name
        : labels.mode === 'native' ? null : t('dialogs.labels.browserOnly'),
      icon: 'header-label',
      body: el('div', { class: 'form-stack labels-form' }, [
        offer,
        boxes,
        el('label', { class: 'field-label', for: field.id, text: t('dialogs.labels.add') }),
        field,
        labels.mode === 'native' || targets.length > 1 ? null : el('p', { class: 'field-help', text: t('dialogs.labels.browserOnly') }),
        error,
      ]),
      actions: [cancel, save],
      initialFocus: field,
    });
    return { close: () => dialog.close('cancel') };
  }

  return { open };
}
