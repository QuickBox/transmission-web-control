/**
 * Files tab: the torrent's files as a folder tree with per-file and
 * per-folder download (wanted) and priority, and rename. Only the rows in
 * view are in the DOM, so a torrent with thousands of files stays responsive.
 *
 * Wanted is read from `fileStats[i].wanted` only. Changes go through
 * `torrent-set` (`files-wanted`, `files-unwanted`, `priority-*`) and
 * `torrent-rename-path`, then the tab refetches.
 *
 * Keyboard (the tree is one tab stop): Up/Down, Home/End, PageUp/PageDown
 * move; Right expands or enters a folder, Left collapses or goes to the
 * parent; Space toggles download; Enter or the context-menu key opens the
 * row's actions; F2 renames.
 */

import { nameProblem, promptDialog } from '../dialogs/rename.js?v=__QBV__';
import { refreshAfterWrite } from '../../rpc/poller.js?v=__QBV__';
import { errorMessage } from '../../core/errors.js?v=__QBV__';

export const id = 'files';
export const labelKey = 'details.tabs.files';
export const live = true;
export const fields = Object.freeze(['files', 'fileStats']);

export const ROW_HEIGHT = 32;
const OVERSCAN = 8;
const PRIORITY_KEY = { 1: 'priority-high', 0: 'priority-normal', '-1': 'priority-low' };
const PRIORITY_LABEL = { 1: 'details.files.high', 0: 'details.files.normal', '-1': 'details.files.low' };

const EXT_ICON = [
  [/\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flv)$/i, 'file-video'],
  [/\.(mp3|flac|m4a|aac|ogg|opus|wav|ape|alac|wma)$/i, 'file-audio'],
  [/\.(jpe?g|png|gif|webp|bmp|tiff?|svg|heic)$/i, 'file-image'],
  [/\.(zip|rar|r\d\d|7z|tar|gz|bz2|xz|zst|iso|img|dmg)$/i, 'file-archive'],
  [/\.(txt|nfo|md|srt|ass|ssa|sub|idx|log|cue|sfv|pdf|epub|mobi)$/i, 'file-text'],
];

/** @param {string} name */
export function fileIcon(name) {
  for (const [pattern, icon] of EXT_ICON) if (pattern.test(name)) return icon;
  return 'file-generic';
}

/**
 * @typedef {{
 *   key: string, name: string, depth: number, parent: FileNode|null, isDir: boolean,
 *   children: FileNode[], index: number, indices: number[],
 *   size: number, done: number, wanted: boolean|'mixed'|null, priority: number|'mixed'|null,
 * }} FileNode
 */

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

function compareNodes(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return collator ? collator.compare(a.name, b.name) : a.name.localeCompare(b.name);
}

/** `null` when any value is unknown, the shared value, or `'mixed'`. */
function combine(values) {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return values.every((v) => v === values[0]) ? values[0] : 'mixed';
}

/**
 * Build the folder tree from `files` and `fileStats`. Folders aggregate size,
 * completed bytes, wanted (`'mixed'` when children disagree) and priority.
 * Without `fileStats`, wanted and priority are `null`.
 * @param {Array<{name?: string, length?: number, bytesCompleted?: number}>} files
 * @param {Array<{wanted?: boolean, priority?: number, bytesCompleted?: number}>|undefined} fileStats
 * @returns {{ roots: FileNode[], count: number }}
 */
export function buildFileTree(files, fileStats) {
  const roots = [];
  const dirs = new Map();
  const list = Array.isArray(files) ? files : [];
  const stats = Array.isArray(fileStats) ? fileStats : null;

  function dirFor(parts, depth) {
    const key = parts.slice(0, depth + 1).join('/');
    let node = dirs.get(key);
    if (node) return node;
    const parent = depth > 0 ? dirFor(parts, depth - 1) : null;
    node = {
      key, name: parts[depth], depth, parent, isDir: true, children: [], index: -1, indices: [],
      size: 0, done: 0, wanted: null, priority: null,
    };
    dirs.set(key, node);
    (parent ? parent.children : roots).push(node);
    return node;
  }

  list.forEach((file, index) => {
    const path = typeof file?.name === 'string' && file.name ? file.name : String(index);
    const parts = path.split('/').filter(Boolean);
    const leafName = parts.pop() || path;
    const parent = parts.length ? dirFor(parts, parts.length - 1) : null;
    const stat = stats ? stats[index] : null;
    const node = {
      key: path, name: leafName, depth: parts.length, parent, isDir: false, children: [], index,
      indices: [index],
      size: finite(file?.length),
      done: finite(stat && Number.isFinite(stat.bytesCompleted) ? stat.bytesCompleted : file?.bytesCompleted),
      wanted: stat && typeof stat.wanted === 'boolean' ? stat.wanted : null,
      priority: stat && Number.isFinite(stat.priority) ? Math.max(-1, Math.min(1, stat.priority)) : null,
    };
    (parent ? parent.children : roots).push(node);
  });

  function finish(node) {
    if (!node.isDir) return;
    for (const child of node.children) {
      finish(child);
      node.size += child.size;
      node.done += child.done;
      for (const i of child.indices) node.indices.push(i);
    }
    node.wanted = combine(node.children.map((c) => c.wanted));
    node.priority = combine(node.children.map((c) => c.priority));
    node.children.sort(compareNodes);
  }
  roots.forEach(finish);
  roots.sort(compareNodes);
  return { roots, count: list.length };
}

/**
 * The rows currently visible: every root, plus the children of expanded folders.
 * @param {FileNode[]} roots
 * @param {Set<string>} expanded
 * @returns {Array<{ node: FileNode, posinset: number, setsize: number }>}
 */
export function visibleRows(roots, expanded) {
  const out = [];
  const walk = (nodes) => {
    nodes.forEach((node, i) => {
      out.push({ node, posinset: i + 1, setsize: nodes.length });
      if (node.isDir && expanded.has(node.key)) walk(node.children);
    });
  };
  walk(roots);
  return out;
}

/**
 * Which rows to render for a scroll position.
 * @returns {{ start: number, end: number }} `end` is exclusive
 */
export function windowRange(scrollTop, viewport, rowHeight, total, overscan = OVERSCAN) {
  const count = Math.ceil(Math.max(viewport, rowHeight) / rowHeight);
  const first = Math.min(Math.floor(Math.max(0, scrollTop) / rowHeight), Math.max(0, total - count));
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + count + overscan);
  return { start, end: Math.max(start, end) };
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @param {import('./index.js').TabHost} host
 * @returns {import('./index.js').TabView}
 */
export function create(ctx, host) {
  const { el, icon, toast, menu } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;

  let torrentId = null;
  let tree = { roots: [], count: 0 };
  let rows = [];
  let expanded = new Set();
  let focusIndex = 0;
  let painted = new Map();
  let frame = 0;

  const summary = el('p', { class: 'files-summary tabular' });
  const message = el('p', { class: 'details-message' });
  const spacer = el('div', { class: 'files-spacer' });
  const list = el('div', {
    class: 'files-list', role: 'tree', 'aria-label': t('details.files.label'),
    on: { scroll: schedulePaint, keydown: onKey, click: onClick, dblclick: onDblClick, focusin: onFocusIn },
  }, [spacer]);
  const head = el('div', { class: 'files-head', 'aria-hidden': 'true' }, [
    el('span', { class: 'files-head-name', text: t('details.files.name') }),
    el('span', { class: 'files-head-size', text: t('details.files.size') }),
    el('span', { class: 'files-head-done', text: t('details.files.done') }),
    el('span', { class: 'files-head-more' }),
  ]);
  const root = el('div', { class: 'files' }, [summary, message, head, list]);

  function nodeAt(index) {
    return rows[index] ? rows[index].node : null;
  }

  /**
   * One row node per tree key, kept across polls and patched in place: a row
   * the user is pressing or has focused stays the same node when fresh stats
   * arrive, so the press still lands and focus is never dropped.
   */
  const rowNodes = new Map();

  function buildRow(node) {
    const r = { node: null, open: null, checked: undefined, priority: undefined };
    r.toggle = el('span', { class: 'file-toggle', 'aria-hidden': 'true', 'data-action': node.isDir ? 'toggle-open' : null });
    r.check = el('span', { class: 'file-check', 'aria-hidden': 'true' });
    r.name = el('span', { class: 'file-name', text: node.name });
    r.chip = el('span', { class: 'badge file-priority', hidden: true });
    r.size = el('span', { class: 'file-size tabular' });
    r.fill = el('span', { class: 'meter-fill' });
    r.percent = el('span');
    r.el = el('div', { class: 'file-row', role: 'treeitem' }, [
      r.toggle,
      r.check,
      el('span', { class: 'file-icon', 'aria-hidden': 'true' }, [icon(node.isDir ? 'file-folder' : fileIcon(node.name), { size: 16 })]),
      r.name,
      r.chip,
      r.size,
      el('span', { class: 'file-done tabular' }, [el('span', { class: 'meter meter-sm', 'aria-hidden': 'true' }, [r.fill]), r.percent]),
      el('button', {
        type: 'button', class: 'btn-icon btn-icon-xs file-more', tabindex: '-1', 'data-action': 'menu',
        'aria-label': t('details.files.actions', { name: node.name }),
      }, [icon('more', { size: 14 })]),
    ]);
    return r;
  }

  function setAttr(node, name, value) {
    if (value == null) node.removeAttribute(name);
    else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function rowFor(index) {
    const { node, posinset, setsize } = rows[index];
    let r = rowNodes.get(node.key);
    if (!r) {
      r = buildRow(node);
      rowNodes.set(node.key, r);
    }
    r.node = node;
    const isOpen = node.isDir && expanded.has(node.key);
    const fraction = node.size > 0 ? node.done / node.size : node.done > 0 ? 1 : 0;
    const checked = node.wanted === 'mixed' ? 'mixed' : node.wanted === null ? null : String(node.wanted);
    r.el.classList.toggle('is-skipped', node.wanted === false);
    setAttr(r.el, 'aria-level', node.depth + 1);
    setAttr(r.el, 'aria-setsize', setsize);
    setAttr(r.el, 'aria-posinset', posinset);
    setAttr(r.el, 'aria-expanded', node.isDir ? String(isOpen) : null);
    setAttr(r.el, 'aria-checked', checked);
    setAttr(r.el, 'tabindex', index === focusIndex ? '0' : '-1');
    setAttr(r.el, 'data-index', index);
    r.el.style.setProperty('top', `${index * ROW_HEIGHT}px`);
    r.el.style.setProperty('--depth', String(node.depth));
    if (node.isDir && r.open !== isOpen) {
      r.open = isOpen;
      r.toggle.replaceChildren(icon(isOpen ? 'panel-expanded' : 'panel-collapsed', { size: 16 }));
    }
    if (r.checked !== checked) {
      r.checked = checked;
      r.check.classList.toggle('is-on', checked === 'true');
      r.check.classList.toggle('is-mixed', checked === 'mixed');
      r.check.classList.toggle('is-unknown', checked === null);
      setAttr(r.check, 'data-action', checked === null ? null : 'toggle-wanted');
      r.check.replaceChildren(...(checked === 'true' ? [icon('menu-check', { size: 12 })] : []));
    }
    if (r.priority !== node.priority) {
      r.priority = node.priority;
      const shown = node.priority === 'mixed' || node.priority === 1 || node.priority === -1;
      r.chip.hidden = !shown;
      r.chip.classList.toggle('is-high', node.priority === 1);
      setText(r.chip, !shown ? '' : node.priority === 'mixed' ? t('details.files.mixed') : t(PRIORITY_LABEL[node.priority]));
    }
    setText(r.size, fmt.bytes(node.size));
    r.fill.style.setProperty('width', `${Math.min(1, fraction) * 100}%`);
    setText(r.percent, fmt.percent(fraction, { digits: 0 }));
    return r.el;
  }

  function paint() {
    frame = 0;
    spacer.style.setProperty('height', `${rows.length * ROW_HEIGHT}px`);
    const viewport = list.clientHeight || ROW_HEIGHT * 20;
    const { start, end } = windowRange(list.scrollTop, viewport, ROW_HEIGHT, rows.length);
    const keep = new Set();
    for (let i = start; i < end; i += 1) keep.add(i);
    if (focusIndex < rows.length) keep.add(focusIndex);
    const hadFocus = list.contains(document.activeElement) && document.activeElement !== list;
    const next = new Map();
    for (const index of [...keep].sort((a, b) => a - b)) next.set(index, rowFor(index));
    // A poll that changes no row membership or order moves no node.
    const before = [...painted.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const after = [...next.values()];
    if (before.length !== after.length || before.some((n, i) => n !== after[i])) {
      const staying = new Set(after);
      for (const node of before) if (!staying.has(node)) node.remove();
      for (const node of after) list.append(node);
    }
    painted = next;
    if (hadFocus && painted.has(focusIndex)) painted.get(focusIndex).focus({ preventScroll: true });
  }

  function schedulePaint() {
    if (frame) return;
    if (typeof globalThis.requestAnimationFrame === 'function') frame = globalThis.requestAnimationFrame(paint);
    else paint();
  }

  function moveFocus(index) {
    if (rows.length === 0) return;
    const previous = painted.get(focusIndex);
    focusIndex = Math.max(0, Math.min(rows.length - 1, index));
    const top = focusIndex * ROW_HEIGHT;
    const viewport = list.clientHeight || ROW_HEIGHT * 20;
    const scrollBefore = list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + viewport) list.scrollTop = top + ROW_HEIGHT - viewport;
    if (list.scrollTop !== scrollBefore || !painted.has(focusIndex)) {
      paint();
    } else if (previous) {
      previous.setAttribute('tabindex', '-1');
    }
    const row = painted.get(focusIndex);
    if (row) {
      row.setAttribute('tabindex', '0');
      row.focus({ preventScroll: true });
    }
  }

  /** Make `index` the tab stop without scrolling or repainting. */
  function markFocus(index) {
    const previous = painted.get(focusIndex);
    if (previous) previous.setAttribute('tabindex', '-1');
    focusIndex = index;
    const row = painted.get(index);
    if (row) row.setAttribute('tabindex', '0');
  }

  function setOpen(node, open) {
    if (!node || !node.isDir || expanded.has(node.key) === open) return;
    if (open) expanded.add(node.key);
    else expanded.delete(node.key);
    rows = visibleRows(tree.roots, expanded);
    focusIndex = Math.max(0, rows.findIndex((r) => r.node === node));
    paint();
  }

  function send(args) {
    return Promise.resolve()
      .then(() => ctx.rpc.call('torrent-set', { ids: [torrentId], ...args }))
      .then(() => refreshAfterWrite(ctx, [torrentId]))
      .then(() => host.refresh(), (err) => {
        toast(t('details.files.saveFailed', { message: errorMessage(t, err) }), { tone: 'error' });
      });
  }

  function setWanted(node, wanted) {
    if (!node || node.wanted === null) return;
    send({ [wanted ? 'files-wanted' : 'files-unwanted']: node.indices.slice() });
  }

  function setPriority(node, priority) {
    if (!node || node.priority === null) return;
    send({ [PRIORITY_KEY[priority]]: node.indices.slice() });
  }

  function rename(node) {
    if (!node) return;
    promptDialog(ctx, {
      title: t(node.isDir ? 'details.files.renameFolder' : 'details.files.renameFile'),
      description: node.key,
      icon: 'header-rename',
      label: t('details.files.newName'),
      value: node.name,
      validate: (value) => (nameProblem(value) ? t('details.files.renameInvalid') : null),
      onSave: (value) => {
        if (value === node.name) return Promise.resolve();
        return Promise.resolve()
          .then(() => ctx.rpc.call('torrent-rename-path', { ids: [torrentId], path: node.key, name: value }))
          .then(() => refreshAfterWrite(ctx, [torrentId]))
          .then(() => {
            toast(t('details.files.renamed', { name: value }), { tone: 'success' });
            host.refresh();
          }, (err) => {
            throw new Error(t('details.files.renameFailed', { message: errorMessage(t, err) }));
          });
      },
    });
  }

  function openMenu(node, anchor) {
    if (!node) return;
    const items = [];
    if (node.wanted !== null) {
      items.push(node.wanted === true
        ? { label: t('details.files.skip'), icon: 'toolbar-pause', onSelect: () => setWanted(node, false) }
        : { label: t('details.files.download'), icon: 'statusbar-download', onSelect: () => setWanted(node, true) });
    }
    if (node.priority !== null) {
      items.push({
        label: t('details.files.priority'),
        items: [1, 0, -1].map((p) => ({
          label: t(PRIORITY_LABEL[p]), checked: node.priority === p, onSelect: () => setPriority(node, p),
        })),
      });
    }
    if (items.length) items.push('separator');
    items.push({ label: t('details.files.rename'), icon: 'header-rename', onSelect: () => rename(node) });
    menu(anchor, items, { label: t('details.files.actions', { name: node.name }) });
  }

  function indexOf(target) {
    const row = target instanceof Element ? target.closest('.file-row') : null;
    return row ? Number(row.getAttribute('data-index')) : -1;
  }

  function onClick(e) {
    const index = indexOf(e.target);
    if (index < 0) return;
    const action = e.target.closest('[data-action]');
    const node = nodeAt(index);
    if (!action) {
      moveFocus(index);
      return;
    }
    markFocus(index);
    const kind = action.getAttribute('data-action');
    if (kind === 'toggle-open') setOpen(node, !expanded.has(node.key));
    else if (kind === 'toggle-wanted') setWanted(node, node.wanted !== true);
    else if (kind === 'menu') openMenu(node, action);
  }

  function onDblClick(e) {
    const node = nodeAt(indexOf(e.target));
    if (node && node.isDir && !e.target.closest('[data-action]')) setOpen(node, !expanded.has(node.key));
  }

  function onFocusIn(e) {
    const index = indexOf(e.target);
    if (index >= 0 && index !== focusIndex) {
      const previous = painted.get(focusIndex);
      if (previous) previous.setAttribute('tabindex', '-1');
      focusIndex = index;
      e.target.closest('.file-row').setAttribute('tabindex', '0');
    }
  }

  function onKey(e) {
    if (rows.length === 0) return;
    const node = nodeAt(focusIndex);
    const page = Math.max(1, Math.floor((list.clientHeight || ROW_HEIGHT * 20) / ROW_HEIGHT) - 1);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': moveFocus(focusIndex + 1); break;
      case 'ArrowUp': moveFocus(focusIndex - 1); break;
      case 'Home': moveFocus(0); break;
      case 'End': moveFocus(rows.length - 1); break;
      case 'PageDown': moveFocus(focusIndex + page); break;
      case 'PageUp': moveFocus(focusIndex - page); break;
      case 'ArrowRight':
        if (node.isDir && !expanded.has(node.key)) setOpen(node, true);
        else if (node.isDir && node.children.length) moveFocus(focusIndex + 1);
        break;
      case 'ArrowLeft':
        if (node.isDir && expanded.has(node.key)) setOpen(node, false);
        else if (node.parent) moveFocus(rows.findIndex((r) => r.node === node.parent));
        break;
      case ' ': setWanted(node, node.wanted !== true); break;
      case 'Enter':
      case 'ContextMenu': openMenu(node, painted.get(focusIndex) || list); break;
      case 'F10': if (e.shiftKey) openMenu(node, painted.get(focusIndex) || list); else handled = false; break;
      case 'F2': rename(node); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  return {
    root,
    render(torrent, detail, state) {
      if (torrent.id !== torrentId) {
        torrentId = torrent.id;
        rowNodes.clear();
        expanded = new Set();
        focusIndex = 0;
        list.scrollTop = 0;
        tree = { roots: [], count: 0 };
      }
      const filesList = detail && Array.isArray(detail.files) ? detail.files : null;
      if (!filesList) {
        rows = [];
        message.textContent = state.error ? t('details.loadFailedWith', { message: state.error })
          : state.loading ? t('details.loading') : t('details.files.none');
        message.hidden = false;
        summary.textContent = '';
        head.hidden = true;
        list.hidden = true;
        paint();
        return;
      }
      const firstBuild = tree.count === 0;
      tree = buildFileTree(filesList, detail.fileStats);
      if (firstBuild) for (const r of tree.roots) if (r.isDir) expanded.add(r.key);
      rows = visibleRows(tree.roots, expanded);
      const visible = new Set(rows.map((r) => r.node.key));
      for (const key of rowNodes.keys()) if (!visible.has(key)) rowNodes.delete(key);
      if (focusIndex >= rows.length) focusIndex = Math.max(0, rows.length - 1);
      const wantedCount = Array.isArray(detail.fileStats) ? detail.fileStats.filter((s) => s && s.wanted).length : null;
      // The download split is only news when some files are skipped.
      summary.textContent = wantedCount == null || wantedCount === tree.count
        ? t('details.files.count', { count: tree.count, total: fmt.count(tree.count) })
        : t('details.files.countWanted', { count: tree.count, total: fmt.count(tree.count), wanted: fmt.count(wantedCount) });
      message.hidden = !state.error;
      if (state.error) message.textContent = t('details.loadFailedWith', { message: state.error });
      head.hidden = rows.length === 0;
      list.hidden = rows.length === 0;
      if (rows.length === 0) {
        message.hidden = false;
        message.textContent = t('details.files.none');
      }
      paint();
    },
    destroy() {
      if (frame && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(frame);
    },
  };
}
