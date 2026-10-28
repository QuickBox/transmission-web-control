/**
 * Settings: daemon settings in six pages (Downloading, Speed, Network, Queue,
 * Seeding, Blocklist) plus this interface's own (Interface).
 *
 * The dialog reads the full session when it opens. A daemon row appears only
 * when the daemon reports its key (`caps.has`), so each Transmission version
 * shows exactly what it supports. Save sends only the keys the user changed,
 * through `setSession`, which also keeps a daemon-side encryption value it
 * does not know and never writes the legacy transport flags next to
 * `preferred_transports`. Interface choices (theme, language, refresh
 * interval) apply on Save too; settings can be exported and imported as a
 * JSON file. Row density and the list's columns apply as soon as they change,
 * so the list behind the dialog shows the result.
 */

import { buildCaps } from '../../rpc/caps.js?v=__QBV__';
import { toCamelKey } from '../../rpc/client.js?v=__QBV__';
import { ENCRYPTION_VALUES, getSession, setSession, testPort } from '../../rpc/session.js?v=__QBV__';
import { VARIANTS, preference, setVariant } from '../../core/theme.js?v=__QBV__';
import { LANGUAGES, LANGUAGE_NAMES, STORAGE_KEY as LANGUAGE_KEY, saveLanguage } from '../../core/i18n.js?v=__QBV__';
import { parseAmount } from '../details/options.js?v=__QBV__';
import { COLUMNS, DEFAULT_COLUMNS, columnsFromPrefs } from '../table.js?v=__QBV__';

export const EXPORT_FORMAT = 'qb-transmission-settings';
const DAYS = Object.freeze([1, 2, 4, 8, 16, 32, 64]);

const sw = (key, extra) => ({ type: 'switch', key, ...extra });
const num = (key, extra) => ({ type: 'number', key, ...extra });
const text = (key, extra) => ({ type: 'text', key, ...extra });

/** The pages and their rows, in display order. */
export const PAGES = Object.freeze([
  { id: 'downloading', rows: [
    text('download-dir', { mono: true }),
    sw('start-added-torrents'),
    sw('trash-original-torrent-files'),
    sw('rename-partial-files'),
    sw('incomplete-dir-enabled'),
    text('incomplete-dir', { mono: true, dependsOn: 'incomplete-dir-enabled' }),
    sw('sequential_download'),
    sw('script-torrent-added-enabled'),
    text('script-torrent-added-filename', { mono: true, dependsOn: 'script-torrent-added-enabled' }),
    sw('script-torrent-done-enabled'),
    text('script-torrent-done-filename', { mono: true, dependsOn: 'script-torrent-done-enabled', help: 'scriptHelp' }),
    sw('script-torrent-done-seeding-enabled'),
    text('script-torrent-done-seeding-filename', { mono: true, dependsOn: 'script-torrent-done-seeding-enabled' }),
    { type: 'textarea', key: 'default-trackers', help: 'defaultTrackersHelp' },
  ] },
  { id: 'speed', rows: [
    sw('speed-limit-down-enabled'),
    num('speed-limit-down', { unit: 'kbps', dependsOn: 'speed-limit-down-enabled' }),
    sw('speed-limit-up-enabled'),
    num('speed-limit-up', { unit: 'kbps', dependsOn: 'speed-limit-up-enabled' }),
    num('alt-speed-down', { unit: 'kbps' }),
    num('alt-speed-up', { unit: 'kbps' }),
    sw('alt-speed-time-enabled'),
    { type: 'time', key: 'alt-speed-time-begin', dependsOn: 'alt-speed-time-enabled' },
    { type: 'time', key: 'alt-speed-time-end', dependsOn: 'alt-speed-time-enabled' },
    { type: 'days', key: 'alt-speed-time-day', dependsOn: 'alt-speed-time-enabled' },
  ] },
  { id: 'network', rows: [
    num('peer-port'),
    { type: 'port-test' },
    sw('peer-port-random-on-start'),
    sw('port-forwarding-enabled'),
    { type: 'select', key: 'encryption', options: ENCRYPTION_VALUES },
    num('peer-limit-global'),
    num('peer-limit-per-torrent'),
    sw('dht-enabled'),
    sw('pex-enabled'),
    sw('lpd-enabled'),
    sw('utp-enabled', { hiddenWith: 'preferred_transports' }),
    sw('tcp-enabled', { hiddenWith: 'preferred_transports' }),
    { type: 'readonly', key: 'preferred_transports' },
  ] },
  { id: 'queue', rows: [
    sw('download-queue-enabled'),
    num('download-queue-size', { dependsOn: 'download-queue-enabled' }),
    sw('seed-queue-enabled'),
    num('seed-queue-size', { dependsOn: 'seed-queue-enabled' }),
    sw('queue-stalled-enabled'),
    num('queue-stalled-minutes', { unit: 'minutes', dependsOn: 'queue-stalled-enabled' }),
  ] },
  { id: 'seeding', rows: [
    sw('seedRatioLimited'),
    num('seedRatioLimit', { decimals: 2, dependsOn: 'seedRatioLimited' }),
    sw('idle-seeding-limit-enabled'),
    num('idle-seeding-limit', { unit: 'minutes', dependsOn: 'idle-seeding-limit-enabled' }),
  ] },
  { id: 'blocklist', rows: [
    sw('blocklist-enabled'),
    text('blocklist-url', { mono: true, dependsOn: 'blocklist-enabled' }),
    { type: 'blocklist-update' },
  ] },
  { id: 'interface', rows: [{ type: 'interface' }] },
]);

/** `"HH:MM"` for minutes after midnight. */
export function minutesToTime(minutes) {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.min(1439, Math.round(minutes))) : 0;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes after midnight for `"HH:MM"`, or `null`. */
export function timeToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * The column set after turning `id` on or off. Name is always on; a column
 * turned on goes to the end; the result never lists `name` (the list always
 * puts it first).
 * @param {object} prefs
 * @param {string} id
 * @param {boolean} on
 * @returns {string[]}
 */
export function toggleColumn(prefs, id, on) {
  const current = columnsFromPrefs(prefs).map((c) => c.id).filter((c) => c !== 'name');
  if (id === 'name') return current;
  const without = current.filter((c) => c !== id);
  return on ? [...without, id] : without;
}

/** Whether the daemon reports a row's key (rows without a key always show). */
export function rowVisible(row, caps) {
  if (!row.key || row.type === 'interface') return true;
  if (!caps || typeof caps.has !== 'function' || !caps.has(row.key)) return false;
  if (row.hiddenWith && caps.has(row.hiddenWith)) return false;
  return true;
}

/**
 * Validate an imported settings file; returns what to apply or `null`.
 * @param {unknown} data
 * @returns {{ prefs: object, theme: string|null, language: string|null }|null}
 */
export function readImport(data) {
  if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT) return null;
  const prefs = data.prefs && typeof data.prefs === 'object' && !Array.isArray(data.prefs) ? data.prefs : {};
  const clean = {};
  for (const [k, v] of Object.entries(prefs)) {
    if (/^[\w-]{1,64}$/.test(k) && ['string', 'number', 'boolean', 'object'].includes(typeof v)) clean[k] = v;
  }
  const theme = data.theme === 'auto' || VARIANTS.includes(data.theme) ? data.theme : null;
  const language = data.language === 'auto' || LANGUAGES.includes(data.language) ? data.language : null;
  return { prefs: clean, theme, language };
}

function storedLanguage() {
  try {
    const v = globalThis.localStorage.getItem(LANGUAGE_KEY);
    return LANGUAGES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @param {{ reload?: () => void, download?: (blob: Blob, name: string) => void }} [deps]
 */
export function createSettingsDialog(ctx, deps = {}) {
  const { el, icon, toast, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;
  let seq = 0;
  let active = null;

  const reload = deps.reload || (() => globalThis.location.reload());
  const download = deps.download || ((blob, name) => {
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function label(key) {
    return t(`dialogs.settings.rows.${toCamelKey(key)}`);
  }

  function open(opts = {}) {
    if (active) return active;
    const uid = `settings-${++seq}`;
    const changes = new Map();
    const invalid = new Set();
    const controls = new Map();
    let session = {};
    let caps = null;
    let pageId = PAGES.some((p) => p.id === opts.page) ? opts.page : PAGES[0].id;
    const ui = { theme: preference(), language: storedLanguage(), pollInterval: Number(ctx.store.get().prefs.pollInterval) || 5 };
    const uiStart = { ...ui };

    const status = el('p', { class: 'field-help', role: 'status' });
    const error = el('p', { class: 'field-error', role: 'alert' });
    const nav = el('div', { class: 'settings-nav', role: 'tablist', 'aria-orientation': 'vertical', on: { keydown: onNavKey } });
    const panel = el('div', { class: 'settings-panel', role: 'tabpanel', tabindex: '0', id: `${uid}-panel` });
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.cancel') });
    const save = el('button', { type: 'button', class: 'btn btn-primary', text: t('core.actions.save'), disabled: true });

    function original(key) {
      return session[toCamelKey(key)];
    }

    function current(key) {
      return changes.has(key) ? changes.get(key) : original(key);
    }

    function record(key, value) {
      if (value === original(key) || JSON.stringify(value) === JSON.stringify(original(key))) changes.delete(key);
      else changes.set(key, value);
      syncDependents();
    }

    function syncDependents() {
      for (const c of controls.values()) {
        if (c.dependsOn && c.setDisabled) c.setDisabled(current(c.dependsOn) !== true);
      }
    }

    function rowShell(row, controlNode, extras = []) {
      const id = `${uid}-${toCamelKey(row.key)}`;
      return el('div', { class: ['option-row', (row.type === 'textarea' || row.type === 'text') && 'option-row-stack'] }, [
        el('label', { class: 'option-label', for: id, id: `${id}-label`, text: label(row.key) }),
        controlNode,
        ...extras,
      ]);
    }

    function helpLine(row) {
      return row.help ? el('p', { class: 'field-help settings-help', text: t(`dialogs.settings.${row.help}`) }) : null;
    }

    function buildRow(row) {
      const id = row.key ? `${uid}-${toCamelKey(row.key)}` : null;
      if (row.type === 'switch') {
        const control = el('button', {
          type: 'button', class: 'switch', role: 'switch', id, 'aria-labelledby': `${id}-label`,
          'aria-checked': String(current(row.key) === true),
          on: { click: () => { const next = control.getAttribute('aria-checked') !== 'true'; control.setAttribute('aria-checked', String(next)); record(row.key, next); } },
        });
        controls.set(row.key, { dependsOn: row.dependsOn, setDisabled: (off) => { control.disabled = off; } });
        return rowShell(row, control);
      }
      if (row.type === 'number') {
        const value = original(row.key);
        const control = el('input', {
          class: 'input option-number tabular', id, type: 'text', inputmode: row.decimals ? 'decimal' : 'numeric',
          autocomplete: 'off', value: Number.isFinite(value) ? String(row.decimals ? value : Math.round(value)) : '',
          on: {
            input: () => {
              const n = parseAmount(control.value, row.decimals || 0);
              if (n === null) {
                invalid.add(row.key);
                control.setAttribute('aria-invalid', 'true');
              } else {
                invalid.delete(row.key);
                control.removeAttribute('aria-invalid');
                record(row.key, n);
              }
              syncSave();
            },
          },
        });
        controls.set(row.key, { dependsOn: row.dependsOn, setDisabled: (off) => { control.disabled = off; } });
        return rowShell(row, el('span', { class: 'option-field' }, [
          control, row.unit ? el('span', { class: 'option-unit', text: t(`dialogs.settings.${row.unit}`) }) : null,
        ]));
      }
      if (row.type === 'text' || row.type === 'textarea') {
        const value = original(row.key);
        const control = el(row.type === 'textarea' ? 'textarea' : 'input', {
          class: [row.type === 'textarea' ? 'textarea' : 'input', 'settings-text', row.mono && 'mono'], id,
          autocomplete: 'off', spellcheck: 'false', value: typeof value === 'string' ? value : '',
          rows: row.type === 'textarea' ? 5 : null,
          on: { input: () => record(row.key, row.type === 'textarea' ? control.value : control.value.trim()) },
        });
        controls.set(row.key, { dependsOn: row.dependsOn, setDisabled: (off) => { control.disabled = off; } });
        return el('div', { class: 'settings-field' }, [rowShell(row, control), helpLine(row)]);
      }
      if (row.type === 'select') {
        const value = original(row.key);
        const known = row.options.includes(value);
        const control = el('select', {
          class: 'select option-select', id, on: { change: () => { if (control.value !== '__custom') record(row.key, control.value); } },
        }, [
          ...row.options.map((o) => el('option', { value: o, text: t(`dialogs.settings.encryption.${o}`) })),
          known ? null : el('option', { value: '__custom', disabled: true, text: t('dialogs.settings.custom', { value: String(value ?? '') }) }),
        ]);
        control.value = known ? value : '__custom';
        return rowShell(row, control);
      }
      if (row.type === 'time') {
        const control = el('input', {
          class: 'input option-number tabular', id, type: 'time', value: minutesToTime(original(row.key)),
          on: { change: () => { const m = timeToMinutes(control.value); if (m !== null) record(row.key, m); } },
        });
        controls.set(row.key, { dependsOn: row.dependsOn, setDisabled: (off) => { control.disabled = off; } });
        return rowShell(row, control);
      }
      if (row.type === 'days') {
        const mask = Number(original(row.key)) || 0;
        const boxes = DAYS.map((bit, i) => el('label', { class: 'day-box' }, [
          el('input', {
            type: 'checkbox', class: 'checkbox', 'data-bit': bit, checked: Boolean(mask & bit),
            on: { change: () => record(row.key, boxes.reduce((acc, b) => acc | (b.firstChild.checked ? Number(b.firstChild.getAttribute('data-bit')) : 0), 0)) },
          }),
          el('span', { text: t(`dialogs.settings.days.${i}`) }),
        ]));
        const group = el('div', { class: 'day-boxes', role: 'group', 'aria-labelledby': `${id}-label` }, boxes);
        controls.set(row.key, { dependsOn: row.dependsOn, setDisabled: (off) => { for (const b of boxes) b.firstChild.disabled = off; } });
        return el('div', { class: 'option-row option-row-stack' }, [
          el('span', { class: 'option-label', id: `${id}-label`, text: label(row.key) }), group,
        ]);
      }
      if (row.type === 'readonly') {
        const value = original(row.key);
        const shown = Array.isArray(value) ? value.join(', ') : String(value ?? '');
        return el('div', { class: 'settings-field' }, [
          el('div', { class: 'option-row' }, [
            el('span', { class: 'option-label', text: label(row.key) }),
            el('span', { class: 'mono settings-readonly', text: shown || '—' }),
          ]),
          el('p', { class: 'field-help settings-help', text: t('dialogs.settings.transportsHelp') }),
        ]);
      }
      if (row.type === 'port-test') return portTestRow();
      if (row.type === 'blocklist-update') return blocklistRow();
      if (row.type === 'interface') return interfaceRows();
      return null;
    }

    function portTestRow() {
      const chips = el('span', { class: 'port-chips', 'aria-live': 'polite' });
      const button = el('button', { type: 'button', class: 'btn btn-secondary', text: t('dialogs.settings.testPort') });
      button.addEventListener('click', () => {
        button.disabled = true;
        chips.replaceChildren(el('span', { class: 'field-help', text: t('dialogs.settings.testing') }));
        Promise.resolve()
          .then(() => testPort(ctx.rpc, caps))
          .then((results) => {
            chips.replaceChildren(...results.map((r) => el('span', {
              class: ['badge', 'port-chip', r.open === true && 'is-open', r.open === false && 'is-closed'],
              text: t(`dialogs.settings.port.${r.protocol}`, {
                state: t(r.open === true ? 'dialogs.settings.port.open' : r.open === false ? 'dialogs.settings.port.closed' : 'dialogs.settings.port.unknown'),
              }),
            })));
          }, (err) => {
            chips.replaceChildren(el('span', { class: 'field-error', text: t('dialogs.settings.portFailed', { message: (err && err.message) || '' }) }));
          })
          .finally(() => { button.disabled = false; });
      });
      return el('div', { class: 'option-row' }, [el('span', { class: 'option-label', text: t('dialogs.settings.portStatus') }), el('span', { class: 'option-field' }, [chips, button])]);
    }

    function blocklistRow() {
      const size = el('span', { class: 'field-help tabular', 'aria-live': 'polite', text: t('dialogs.settings.blocklistSize', { count: Number(session.blocklistSize) || 0, total: fmt.count(Number(session.blocklistSize) || 0) }) });
      const button = el('button', { type: 'button', class: 'btn btn-secondary', text: t('dialogs.settings.blocklistUpdate') });
      button.addEventListener('click', () => {
        button.disabled = true;
        Promise.resolve()
          .then(() => ctx.rpc.call('blocklist-update'))
          .then((r) => {
            const n = r && Number.isFinite(r.blocklistSize) ? r.blocklistSize : 0;
            size.textContent = t('dialogs.settings.blocklistSize', { count: n, total: fmt.count(n) });
            toast(t('dialogs.settings.blocklistUpdated'), { tone: 'success' });
          }, (err) => toast(t('dialogs.settings.blocklistFailed', { message: (err && err.message) || '' }), { tone: 'error' }))
          .finally(() => { button.disabled = false; });
      });
      return el('div', { class: 'option-row' }, [size, button]);
    }

    function interfaceRows() {
      const themeSel = el('select', { class: 'select option-select', id: `${uid}-theme`, on: { change: () => { ui.theme = themeSel.value; syncSave(); } } },
        ['auto', ...VARIANTS].map((v) => el('option', { value: v, text: t(`core.theme.${v}`) })));
      themeSel.value = ui.theme;
      const langSel = el('select', { class: 'select option-select', id: `${uid}-lang`, on: { change: () => { ui.language = langSel.value; syncSave(); } } },
        [el('option', { value: 'auto', text: t('core.language.auto') }), ...LANGUAGES.map((c) => el('option', { value: c, text: LANGUAGE_NAMES[c] }))]);
      langSel.value = ui.language;
      const poll = el('input', {
        class: 'input option-number tabular', id: `${uid}-poll`, type: 'text', inputmode: 'numeric', value: String(ui.pollInterval),
        on: {
          input: () => {
            const n = parseAmount(poll.value, 0);
            if (n === null || n < 1 || n > 600) {
              invalid.add('pollInterval');
              poll.setAttribute('aria-invalid', 'true');
            } else {
              invalid.delete('pollInterval');
              poll.removeAttribute('aria-invalid');
              ui.pollInterval = n;
            }
            syncSave();
          },
        },
      });
      const fileInput = el('input', {
        type: 'file', class: 'sr-only', accept: 'application/json,.json', tabindex: '-1', 'aria-hidden': 'true',
        on: { change: () => { importFile(fileInput.files && fileInput.files[0]); fileInput.value = ''; } },
      });
      const exportBtn = el('button', { type: 'button', class: 'btn btn-secondary', on: { click: exportSettings } }, [
        icon('statusbar-download', { size: 16 }), t('dialogs.settings.export')]);
      const importBtn = el('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => fileInput.click() } }, [
        icon('statusbar-upload', { size: 16 }), t('dialogs.settings.import')]);
      const prefsNow = () => ctx.store.get().prefs;
      const setPrefs = (patch) => ctx.store.set({ prefs: { ...prefsNow(), ...patch } });
      const densityLabel = `${uid}-density-label`;
      const density = el('button', {
        type: 'button', class: 'switch', role: 'switch', id: `${uid}-density`, 'aria-labelledby': densityLabel,
        'aria-checked': String(prefsNow().density === 'compact'),
        on: {
          click: () => {
            const compact = density.getAttribute('aria-checked') !== 'true';
            density.setAttribute('aria-checked', String(compact));
            setPrefs({ density: compact ? 'compact' : 'comfortable' });
          },
        },
      });
      const columnBoxes = el('ul', { class: 'column-boxes', 'aria-labelledby': `${uid}-columns-label` });
      function renderColumns() {
        const shown = new Set(columnsFromPrefs(prefsNow()).map((c) => c.id));
        columnBoxes.replaceChildren(...COLUMNS.map((column) => {
          const box = el('input', {
            type: 'checkbox', class: 'checkbox', id: `${uid}-col-${column.id}`, 'data-column': column.id,
            checked: shown.has(column.id), disabled: column.id === 'name',
            on: { change: () => setPrefs({ columns: toggleColumn(prefsNow(), column.id, box.checked) }) },
          });
          return el('li', {}, [el('label', { class: 'check-row', for: box.id }, [box, el('span', { text: t(`main.columns.${column.id}`) })])]);
        }));
      }
      renderColumns();
      const resetColumns = el('button', {
        type: 'button', class: 'btn btn-secondary', text: t('dialogs.settings.columnsReset'),
        on: { click: () => { setPrefs({ columns: [...DEFAULT_COLUMNS] }); renderColumns(); } },
      });

      return el('div', { class: 'settings-interface' }, [
        el('div', { class: 'option-row' }, [el('label', { class: 'option-label', for: themeSel.id, text: t('core.theme.label') }), themeSel]),
        el('div', { class: 'option-row' }, [el('label', { class: 'option-label', for: langSel.id, text: t('core.language.label') }), langSel]),
        el('p', { class: 'field-help settings-help', text: t('dialogs.settings.languageHelp') }),
        el('div', { class: 'option-row' }, [
          el('label', { class: 'option-label', for: poll.id, text: t('dialogs.settings.pollInterval') }),
          el('span', { class: 'option-field' }, [poll, el('span', { class: 'option-unit', text: t('dialogs.settings.seconds') })]),
        ]),
        el('div', { class: 'option-row' }, [
          el('span', { class: 'option-label', text: t('dialogs.settings.backup') }),
          el('span', { class: 'option-field' }, [exportBtn, importBtn, fileInput]),
        ]),
        el('h4', { class: 'settings-subtitle', text: t('dialogs.settings.list') }),
        el('p', { class: 'field-help settings-help', text: t('dialogs.settings.listHelp') }),
        el('div', { class: 'option-row' }, [el('span', { class: 'option-label', id: densityLabel, text: t('dialogs.settings.compactRows') }), density]),
        el('div', { class: 'option-row' }, [
          el('span', { class: 'option-label', id: `${uid}-columns-label`, text: t('dialogs.settings.columns') }),
          resetColumns,
        ]),
        columnBoxes,
      ]);
    }

    function exportSettings() {
      const data = { format: EXPORT_FORMAT, version: 1, theme: ui.theme, language: ui.language, prefs: { ...ctx.store.get().prefs, pollInterval: ui.pollInterval } };
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'transmission-ui-settings.json');
    }

    function importFile(file) {
      if (!file) return;
      Promise.resolve()
        .then(() => file.text())
        .then((raw) => {
          const parsed = readImport(JSON.parse(raw));
          if (!parsed) throw new Error(t('dialogs.settings.importInvalid'));
          ctx.store.set({ prefs: { ...ctx.store.get().prefs, ...parsed.prefs } });
          if (parsed.theme) setVariant(parsed.theme);
          toast(t('dialogs.settings.imported'), { tone: 'success' });
          if (parsed.language && parsed.language !== storedLanguage()) {
            saveLanguage(parsed.language);
            reload();
          }
        })
        .catch((err) => toast(t('dialogs.settings.importFailed', { message: (err && err.message) || '' }), { tone: 'error' }));
    }

    function uiChanged() {
      return ui.theme !== uiStart.theme || ui.language !== uiStart.language || ui.pollInterval !== uiStart.pollInterval;
    }

    function syncSave() {
      save.disabled = invalid.size > 0 || (changes.size === 0 && !uiChanged());
    }

    function showPage(id, focus) {
      pageId = id;
      for (const button of nav.children) {
        const on = button.getAttribute('data-page') === id;
        button.setAttribute('aria-selected', String(on));
        button.setAttribute('tabindex', on ? '0' : '-1');
        if (on && focus) button.focus();
      }
      panel.setAttribute('aria-labelledby', `${uid}-nav-${id}`);
      for (const section of panel.children) section.hidden = section.getAttribute('data-page') !== id;
    }

    function onNavKey(e) {
      const ids = [...nav.children].map((b) => b.getAttribute('data-page'));
      const i = ids.indexOf(pageId);
      let next = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
      else if (e.key === 'Home') next = ids[0];
      else if (e.key === 'End') next = ids[ids.length - 1];
      if (next) {
        e.preventDefault();
        showPage(next, true);
      }
    }

    function build() {
      const pages = PAGES.map((page) => ({ page, rows: page.rows.filter((row) => rowVisible(row, caps)) }))
        .filter((p) => p.rows.length > 0);
      nav.replaceChildren(...pages.map(({ page }) => el('button', {
        type: 'button', role: 'tab', class: 'settings-tab', id: `${uid}-nav-${page.id}`, 'data-page': page.id,
        'aria-controls': panel.id, on: { click: () => showPage(page.id, true) },
      }, [t(`dialogs.settings.pages.${page.id}`)])));
      panel.replaceChildren(...pages.map(({ page, rows }) => el('section', { class: 'settings-page', 'data-page': page.id }, [
        el('h3', { class: 'settings-page-title', text: t(`dialogs.settings.pages.${page.id}`) }),
        ...rows.map(buildRow),
      ])));
      syncDependents();
      showPage(pages.some((p) => p.page.id === pageId) ? pageId : pages[0].page.id, false);
      if (document.activeElement === cancel) {
        const selected = [...nav.children].find((b) => b.getAttribute('aria-selected') === 'true');
        if (selected) selected.focus();
      }
    }

    function submit() {
      error.textContent = '';
      if (invalid.size) {
        error.textContent = t('dialogs.settings.invalid');
        return;
      }
      save.disabled = true;
      Promise.resolve()
        .then(() => (changes.size ? setSession(ctx.rpc, caps, session, Object.fromEntries(changes)) : {}))
        .then(() => (changes.size ? getSession(ctx.rpc).then((fresh) => ctx.store.set({ session: fresh })) : null))
        .then(() => {
          if (ui.theme !== uiStart.theme) setVariant(ui.theme);
          if (ui.pollInterval !== uiStart.pollInterval) {
            ctx.store.set({ prefs: { ...ctx.store.get().prefs, pollInterval: ui.pollInterval } });
          }
          toast(t('dialogs.settings.saved'), { tone: 'success' });
          dialog.close('saved');
          if (ui.language !== uiStart.language) {
            saveLanguage(ui.language);
            reload();
          }
        }, (err) => {
          save.disabled = false;
          error.textContent = t('dialogs.settings.failed', { message: (err && err.message) || '' });
        });
    }

    cancel.addEventListener('click', () => dialog.close('cancel'));
    save.addEventListener('click', submit);
    const dialog = openDialog({
      title: t('dialogs.settings.title'),
      icon: 'header-settings',
      size: 'lg',
      body: el('div', { class: 'settings' }, [nav, panel, status, error]),
      actions: [cancel, save],
      initialFocus: cancel,
      onClose: () => { active = null; },
    });

    status.textContent = t('details.loading');
    const ready = Promise.resolve()
      .then(() => getSession(ctx.rpc))
      .then((fresh) => {
        session = fresh || {};
        caps = buildCaps(session, { dialect: (ctx.caps && ctx.caps.dialect) || ctx.rpc.dialect });
        status.textContent = '';
        build();
      }, (err) => {
        status.textContent = '';
        error.textContent = t('dialogs.settings.loadFailed', { message: (err && err.message) || '' });
      });

    active = { close: () => dialog.close('cancel'), ready, showPage: (id) => showPage(id, false) };
    return active;
  }

  return { open };
}
