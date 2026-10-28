/**
 * Find data: for each selected torrent that has no data yet, try candidate
 * folders in order (a torrent that already has data is left alone). For
 * each one the torrent is pointed at the folder (`torrent-set-location` with
 * `move: false`, so nothing is moved) and verified; as soon as the check finds
 * any of the torrent's data there, that folder is kept and the next torrent
 * starts. A torrent no folder matched is pointed back at its original folder.
 * The folder list is kept in `prefs.findDataFolders`.
 */

const CHECKING = new Set([1, 2]);
const TIMEOUT_MS = 10 * 60 * 1000;

/** Folders from the text box: trimmed, non-empty, de-duplicated. */
export function parseFolders(text) {
  return [...new Set(String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Suggested folders: the saved list, else every torrent's folder plus the
 * session's download folder.
 */
export function suggestFolders(saved, torrents, session) {
  if (Array.isArray(saved) && saved.length) return saved.filter((s) => typeof s === 'string' && s);
  const set = new Set();
  if (session && typeof session.downloadDir === 'string' && session.downloadDir) set.add(session.downloadDir);
  for (const t of torrents) if (t.downloadDir) set.add(t.downloadDir);
  return [...set].sort();
}

/**
 * Try `folders` for one torrent.
 * @param {{ call: (method: string, args?: object) => Promise<any> }} rpc
 * @param {{ id: number, downloadDir: string }} torrent
 * @param {string[]} folders
 * @param {{ sleep: (ms: number) => Promise<void>, now: () => number, cancelled: () => boolean,
 *   onStep?: (folder: string, index: number) => void, pollMs?: number, timeoutMs?: number }} env
 * @returns {Promise<{ folder: string|null, cancelled: boolean }>}
 */
export async function matchTorrent(rpc, torrent, folders, env) {
  const pollMs = env.pollMs ?? 1000;
  const timeoutMs = env.timeoutMs ?? TIMEOUT_MS;
  for (let i = 0; i < folders.length; i += 1) {
    if (env.cancelled()) break;
    const folder = folders[i];
    if (env.onStep) env.onStep(folder, i);
    await rpc.call('torrent-set-location', { ids: [torrent.id], location: folder, move: false });
    await rpc.call('torrent-verify', { ids: [torrent.id] });
    const started = env.now();
    for (;;) {
      await env.sleep(pollMs);
      const result = await rpc.call('torrent-get', { ids: [torrent.id], fields: ['id', 'status', 'percentDone'] });
      const row = result && Array.isArray(result.torrents) ? result.torrents.find((r) => r && r.id === torrent.id) : null;
      if (row && row.percentDone > 0) return { folder, cancelled: false };
      if (!row || !CHECKING.has(row.status) || env.cancelled() || env.now() - started > timeoutMs) break;
    }
  }
  await rpc.call('torrent-set-location', { ids: [torrent.id], location: torrent.downloadDir, move: false });
  return { folder: null, cancelled: env.cancelled() };
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, pollMs?: number }} [deps]
 */
export function createAutoMatchDialog(ctx, deps = {}) {
  const { el, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  let seq = 0;

  /**
   * @param {number[]} ids
   * @returns {{ close: () => void, run: () => Promise<void> }|null}
   */
  function open(ids) {
    const state = ctx.store.get();
    const targets = [...new Set(ids || [])].map((id) => state.torrents.get(id)).filter(Boolean);
    if (targets.length === 0) return null;
    const uid = `match-${++seq}`;
    let running = false;
    let stop = false;

    const folders = el('textarea', {
      class: 'textarea mono', id: `${uid}-folders`, rows: 5, spellcheck: 'false',
      value: suggestFolders(state.prefs.findDataFolders, [...state.torrents.values()], state.session).join('\n'),
      'aria-describedby': `${uid}-help`,
    });
    const progress = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
    const results = el('ul', { class: 'match-results' });
    const error = el('p', { class: 'field-error', role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const start = el('button', { type: 'button', class: 'btn btn-primary', text: t('dialogs.match.submit') });

    async function run() {
      const list = parseFolders(folders.value);
      if (list.length === 0) {
        folders.setAttribute('aria-invalid', 'true');
        error.textContent = t('dialogs.match.noFolders');
        return;
      }
      folders.removeAttribute('aria-invalid');
      error.textContent = '';
      ctx.store.set({ prefs: { ...ctx.store.get().prefs, findDataFolders: list } });
      running = true;
      stop = false;
      start.disabled = true;
      folders.disabled = true;
      cancel.textContent = t('dialogs.match.stop');
      results.replaceChildren();
      let found = 0;
      try {
        for (const [n, torrent] of targets.entries()) {
          if (stop) break;
          if (torrent.percentDone > 0) {
            results.append(el('li', { class: ['match-result', 'is-skipped'] }, [
              el('span', { class: 'match-name', text: torrent.name }),
              el('span', { class: 'match-folder', text: t('dialogs.match.hasData') }),
            ]));
            continue;
          }
          const outcome = await matchTorrent(ctx.rpc, torrent, list, {
            sleep, now, pollMs: deps.pollMs, cancelled: () => stop,
            onStep: (folder, i) => {
              progress.textContent = t('dialogs.match.trying', {
                name: torrent.name, n: fmt.count(n + 1), of: fmt.count(targets.length), folder, i: fmt.count(i + 1), folders: fmt.count(list.length),
              });
            },
          });
          if (outcome.folder) found += 1;
          results.append(el('li', { class: ['match-result', outcome.folder ? 'is-found' : 'is-missing'] }, [
            el('span', { class: 'match-name', text: torrent.name }),
            el('span', { class: 'mono match-folder', text: outcome.folder || t('dialogs.match.notFound') }),
          ]));
        }
        progress.textContent = stop ? t('dialogs.match.stopped')
          : t('dialogs.match.finished', { found: fmt.count(found), total: fmt.count(targets.length) });
        if (!stop) toast(progress.textContent, { tone: found ? 'success' : 'warning' });
      } catch (err) {
        error.textContent = t('dialogs.match.failed', { message: (err && err.message) || '' });
      } finally {
        running = false;
        start.disabled = false;
        folders.disabled = false;
        cancel.textContent = t('core.actions.close');
      }
    }

    cancel.addEventListener('click', () => {
      if (running) {
        stop = true;
        progress.textContent = t('dialogs.match.stopping');
        return;
      }
      dialog.close('cancel');
    });
    start.addEventListener('click', () => { run(); });

    const dialog = openDialog({
      title: t('dialogs.match.title'),
      description: t('dialogs.match.description', { count: targets.length, total: fmt.count(targets.length) }),
      icon: 'header-datadir',
      size: 'lg',
      dismissible: true,
      body: el('div', { class: 'form-stack' }, [
        el('label', { class: 'field-label', for: folders.id, text: t('dialogs.match.folders') }),
        folders,
        el('p', { class: 'field-help', id: `${uid}-help`, text: t('dialogs.match.help') }),
        progress,
        results,
        error,
      ]),
      actions: [cancel, start],
      initialFocus: folders,
      onClose: () => { stop = true; },
    });
    return { close: () => dialog.close('cancel'), run };
  }

  return { open };
}
