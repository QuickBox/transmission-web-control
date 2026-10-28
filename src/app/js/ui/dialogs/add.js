/**
 * Add torrents: dropped or browsed `.torrent` files (sent as `metainfo`),
 * magnet links and URLs (sent as `filename`), a download directory with its
 * free space, labels, and whether to start right away. Labels are written
 * after the add: on a daemon with native labels as one `torrent-set labels`,
 * otherwise into the browser label store.
 */

import { getFreeSpace } from '../../rpc/session.js?v=__QBV__';
import { refreshAfterWrite } from '../../rpc/poller.js?v=__QBV__';
import { createLabelStore, memoryStorage } from '../../rpc/labels.js?v=__QBV__';
import { errorMessage } from '../../core/errors.js?v=__QBV__';

const HASH_RE = /^(?:[0-9a-f]{40}|[a-z2-7]{32})$/i;
const LINK_RE = /^(?:magnet:\?|[a-z][a-z0-9+.-]*:\/\/)\S+$/i;

/** @param {{ name?: string, type?: string }} file */
export function isTorrentFile(file) {
  return Boolean(file) && (/\.torrent$/i.test(file.name || '') || file.type === 'application/x-bittorrent');
}

/**
 * Split the links box into magnet links and URLs; a bare info hash becomes a
 * magnet link.
 * @param {string} text
 * @returns {{ links: string[], invalid: string|null }}
 */
export function parseLinks(text) {
  const links = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const link = HASH_RE.test(line) ? `magnet:?xt=urn:btih:${line}` : line;
    if (!LINK_RE.test(link)) return { links, invalid: line };
    if (!links.includes(link)) links.push(link);
  }
  return { links, invalid: null };
}

/**
 * Comma-separated labels, trimmed and de-duplicated.
 * @param {string} text
 */
export function parseLabels(text) {
  return [...new Set(String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Base64 of a file's bytes, for `torrent-add` `metainfo`.
 * @param {{ arrayBuffer: () => Promise<ArrayBuffer> }} file
 */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** localStorage when the browser allows it, else memory for this page. */
export function browserStorage() {
  try {
    const storage = globalThis.localStorage;
    const probe = 'qb-transmission.probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return memoryStorage();
  }
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @param {{ storage?: object }} [deps]
 */
export function createAddDialog(ctx, deps = {}) {
  const { el, icon, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  let active = null;
  let seq = 0;

  function open(opts = {}) {
    if (active) {
      active.addFiles(opts.files || []);
      return active;
    }
    const uid = `add-${++seq}`;
    const session = ctx.store.get().session || {};
    /** @type {File[]} */
    let picked = [];
    let freeTimer = 0;
    let freeSeq = 0;

    const fileInput = el('input', {
      type: 'file', class: 'sr-only', accept: '.torrent,application/x-bittorrent', multiple: true, tabindex: '-1',
      'aria-hidden': 'true',
      on: { change: () => { addFiles([...fileInput.files]); fileInput.value = ''; } },
    });
    const browse = el('button', {
      type: 'button', class: 'btn btn-secondary', on: { click: () => fileInput.click() },
    }, [t('dialogs.add.browse')]);
    const chips = el('ul', { class: 'file-chips', 'aria-label': t('dialogs.add.selectedFiles') });
    const dropCard = el('div', { class: 'drop-card' }, [
      el('span', { class: 'drop-card-icon', 'aria-hidden': 'true' }, [icon('drop-zone', { size: 28 })]),
      el('p', { class: 'drop-card-text', text: t('dialogs.add.dropHint') }),
      browse,
      fileInput,
    ]);

    const links = el('textarea', {
      class: 'textarea mono', id: `${uid}-links`, rows: 3, spellcheck: 'false',
      placeholder: t('dialogs.add.linksPlaceholder'), on: { input: sync },
    });
    const dir = el('input', {
      class: 'input mono', id: `${uid}-dir`, value: typeof session.downloadDir === 'string' ? session.downloadDir : '',
      autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${uid}-free`,
      on: { input: scheduleFree, change: checkFree },
    });
    const free = el('p', { class: 'field-help tabular', id: `${uid}-free`, 'aria-live': 'polite' });
    const known = ctx.store.get().torrents;
    const labelStore = () => createLabelStore({ client: ctx.rpc, caps: ctx.caps, storage: deps.storage || browserStorage() });
    let suggestions = [];
    try {
      suggestions = labelStore().allLabels([...known.values()]);
    } catch {
      suggestions = [];
    }
    const labels = el('input', {
      class: 'input', id: `${uid}-labels`, autocomplete: 'off', list: `${uid}-label-list`,
      placeholder: t('dialogs.add.labelsPlaceholder'),
    });
    const datalist = el('datalist', { id: `${uid}-label-list` }, suggestions.map((l) => el('option', { value: l })));
    const startLabel = `${uid}-start-label`;
    const start = el('button', {
      type: 'button', class: 'switch', role: 'switch', 'aria-labelledby': startLabel,
      'aria-checked': String(session.startAddedTorrents !== false),
      on: { click: () => start.setAttribute('aria-checked', String(start.getAttribute('aria-checked') !== 'true')) },
    });
    const error = el('p', { class: 'field-error', role: 'alert' });

    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const submit = el('button', { type: 'button', class: 'btn btn-primary', text: t('dialogs.add.submit'), disabled: true });

    const body = el('div', { class: 'add-form' }, [
      dropCard,
      chips,
      el('div', { class: 'form-stack' }, [
        el('label', { class: 'field-label', for: links.id, text: t('dialogs.add.links') }), links,
      ]),
      el('div', { class: 'form-stack' }, [
        el('label', { class: 'field-label', for: dir.id, text: t('dialogs.add.directory') }), dir, free,
      ]),
      el('div', { class: 'form-stack' }, [
        el('label', { class: 'field-label', for: labels.id, text: t('dialogs.add.labels') }), labels, datalist,
      ]),
      el('div', { class: 'option-row' }, [el('span', { class: 'option-label', id: startLabel, text: t('dialogs.add.start') }), start]),
      error,
    ]);

    function sync() {
      submit.disabled = picked.length === 0 && links.value.trim() === '';
    }

    function renderChips() {
      chips.replaceChildren(...picked.map((file, i) => el('li', { class: 'file-chip' }, [
        el('span', { class: 'file-chip-icon', 'aria-hidden': 'true' }, [icon('file-generic', { size: 14 })]),
        el('span', { class: 'file-chip-name', text: file.name }),
        el('button', {
          type: 'button', class: 'btn-icon btn-icon-xs', 'aria-label': t('dialogs.add.removeFile', { name: file.name }),
          on: { click: () => { picked = picked.filter((_, j) => j !== i); renderChips(); sync(); } },
        }, [icon('menu-close', { size: 12 })]),
      ])));
      chips.hidden = picked.length === 0;
    }

    function addFiles(list) {
      const torrents = list.filter(isTorrentFile);
      if (list.length > torrents.length) toast(t('dialogs.add.notTorrent'), { tone: 'warning' });
      for (const file of torrents) {
        if (!picked.some((p) => p.name === file.name && p.size === file.size)) picked.push(file);
      }
      renderChips();
      sync();
    }

    function scheduleFree() {
      clearTimeout(freeTimer);
      freeTimer = setTimeout(checkFree, 400);
    }

    function checkFree() {
      clearTimeout(freeTimer);
      const path = dir.value.trim();
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

    async function send() {
      error.textContent = '';
      const parsed = parseLinks(links.value);
      if (parsed.invalid) {
        links.setAttribute('aria-invalid', 'true');
        error.textContent = t('dialogs.add.invalidLink', { line: parsed.invalid });
        return;
      }
      links.removeAttribute('aria-invalid');
      const items = [
        ...picked.map((file) => ({ name: file.name, file })),
        ...parsed.links.map((link) => ({ name: link, link })),
      ];
      if (items.length === 0) return;
      submit.disabled = true;
      const path = dir.value.trim();
      const paused = start.getAttribute('aria-checked') !== 'true';
      const added = [];
      let duplicates = 0;
      const failures = [];
      for (const item of items) {
        try {
          const args = { paused };
          if (path) args['download-dir'] = path;
          if (item.file) args.metainfo = await fileToBase64(item.file);
          else args.filename = item.link;
          const result = await ctx.rpc.call('torrent-add', args);
          const fresh = result && result.torrentAdded;
          const dupe = result && result.torrentDuplicate;
          if (fresh && Number.isInteger(fresh.id)) added.push({ id: fresh.id, hash: fresh.hashString, name: fresh.name });
          else if (dupe) duplicates += 1;
          else failures.push({ name: item.name, message: t('dialogs.add.noAnswer') });
        } catch (err) {
          failures.push({ name: item.name, message: errorMessage(t, err) });
        }
      }

      const wanted = parseLabels(labels.value);
      if (wanted.length && added.length) {
        try {
          await labelStore().write(added, wanted);
        } catch (err) {
          toast(t('dialogs.add.labelsFailed', { message: errorMessage(t, err) }), { tone: 'warning' });
        }
      }

      if (added.length) await refreshAfterWrite(ctx, added.map((a) => a.id));
      if (added.length || duplicates) {
        if (added.length) {
          toast(t('dialogs.add.added', { count: added.length, total: fmt.count(added.length) }), { tone: 'success' });
        }
        if (duplicates) {
          toast(t('dialogs.add.duplicates', { count: duplicates, total: fmt.count(duplicates) }), { tone: 'info' });
        }
        if (failures.length) {
          toast(t('dialogs.add.someFailed', { count: failures.length, total: fmt.count(failures.length) }), { tone: 'error' });
        }
        dialog.close('added');
        return;
      }
      submit.disabled = false;
      error.textContent = failures.length === 1
        ? t('dialogs.add.failedOne', { name: failures[0].name, message: failures[0].message })
        : t('dialogs.add.failedAll', { count: failures.length, total: fmt.count(failures.length) });
    }

    cancel.addEventListener('click', () => dialog.close('cancel'));
    submit.addEventListener('click', () => { send(); });

    const dialog = openDialog({
      title: t('dialogs.add.title'),
      icon: 'header-add-torrent',
      size: 'lg',
      body,
      actions: [cancel, submit],
      initialFocus: browse,
      onClose: () => {
        clearTimeout(freeTimer);
        active = null;
      },
    });

    active = { addFiles, send, close: (reason) => dialog.close(reason) };
    addFiles(opts.files || []);
    if (opts.links) {
      links.value = opts.links.join('\n');
      sync();
    }
    renderChips();
    checkFree();
    return active;
  }

  return { open, isOpen: () => Boolean(active), addFiles: (files) => active && active.addFiles(files) };
}
