/**
 * Dialog registry. Owns the Add torrent and Remove dialogs, the window-wide
 * drop overlay for `.torrent` files, and the requests other modules send:
 *
 * - `remove-request` (bubbling CustomEvent from the list, `detail: { ids }`)
 *   opens the Remove confirm for those ids.
 * - `add-request` (`detail: { files?, links? }`) opens Add torrent.
 * - `openAdd(opts)` and `openRemove(ids)` do the same as direct calls; import
 *   this module with the same specifier `main.js` uses so they reach the
 *   mounted instance.
 *
 * Mounted into `[data-region="dialogs"]`.
 */

import { createAddDialog, isTorrentFile } from './add.js?v=__QBV__';
import { createRemoveDialog } from './remove.js?v=__QBV__';

export const ADD_REQUEST = 'add-request';
export const REMOVE_REQUEST = 'remove-request';

let instance = null;

/**
 * Open Add torrent, or add files to the one already open.
 * @param {{ files?: File[], links?: string[] }} [opts]
 */
export function openAdd(opts) {
  if (instance) instance.add.open(opts || {});
}

/** @param {number[]} ids */
export function openRemove(ids) {
  if (instance) instance.remove.open(ids);
}

function hasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return Boolean(types && [...types].includes('Files'));
}

/**
 * @param {HTMLElement} root The region element this module owns. It may replace
 *   the children of `root` and nothing outside it.
 * @param {import('../../main.js').AppContext} ctx Shared services, see `main.js`.
 * @returns {void | (() => void)} Optional teardown.
 */
export function mount(root, ctx) {
  const { el, icon, toast } = ctx.ui;
  const t = ctx.i18n;
  const app = root.closest('#app') || document.body;
  const add = createAddDialog(ctx);
  const remove = createRemoveDialog(ctx);

  const overlay = el('div', { class: 'drop-overlay', hidden: true, 'aria-hidden': 'true' }, [
    el('div', { class: 'drop-overlay-card' }, [
      icon('drop-zone', { size: 40 }),
      el('p', { class: 'drop-overlay-title', text: t('dialogs.drop.title') }),
      el('p', { class: 'drop-overlay-hint', text: t('dialogs.drop.hint') }),
    ]),
  ]);
  root.replaceChildren(overlay);

  let depth = 0;
  const show = (on) => { overlay.hidden = !on; };

  function onEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    show(true);
  }
  function onOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onLeave(e) {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const files = [...(e.dataTransfer.files || [])];
    if (!files.some(isTorrentFile)) {
      toast(t('dialogs.add.notTorrent'), { tone: 'warning' });
      return;
    }
    add.open({ files });
  }
  function onRemoveRequest(e) {
    const ids = e.detail && Array.isArray(e.detail.ids) ? e.detail.ids : [];
    remove.open(ids);
  }
  function onAddRequest(e) {
    add.open((e && e.detail) || {});
  }

  document.addEventListener('dragenter', onEnter);
  document.addEventListener('dragover', onOver);
  document.addEventListener('dragleave', onLeave);
  document.addEventListener('drop', onDrop);
  app.addEventListener(REMOVE_REQUEST, onRemoveRequest);
  app.addEventListener(ADD_REQUEST, onAddRequest);

  instance = { add, remove };
  return () => {
    document.removeEventListener('dragenter', onEnter);
    document.removeEventListener('dragover', onOver);
    document.removeEventListener('dragleave', onLeave);
    document.removeEventListener('drop', onDrop);
    app.removeEventListener(REMOVE_REQUEST, onRemoveRequest);
    app.removeEventListener(ADD_REQUEST, onAddRequest);
    if (instance && instance.add === add) instance = null;
  };
}
