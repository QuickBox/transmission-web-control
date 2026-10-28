/**
 * Options tab: per-torrent speed limits, global-limit honouring, bandwidth
 * priority, seeding stop rules (ratio and idle), the peer limit and, on
 * daemons with `caps.sequential`, sequential download. Each control writes
 * through `torrent-set` as soon as it changes, then the tab refetches; a
 * control the user is editing is never overwritten by a refresh.
 */

import { errorMessage } from '../../core/errors.js?v=__QBV__';

export const id = 'options';
export const labelKey = 'details.tabs.options';
export const live = false;

const BASE_FIELDS = Object.freeze([
  'downloadLimit', 'downloadLimited', 'uploadLimit', 'uploadLimited', 'honorsSessionLimits',
  'bandwidthPriority', 'seedRatioMode', 'seedRatioLimit', 'seedIdleMode', 'seedIdleLimit', 'peer-limit',
]);

/**
 * The `torrent-get` fields this tab needs on a daemon with these caps.
 * @param {{ sequential?: boolean }|null} caps
 */
export function fields(caps) {
  return caps && caps.sequential ? [...BASE_FIELDS, 'sequential_download'] : [...BASE_FIELDS];
}

/**
 * Parse a non-negative number from an input. Speeds and counts are rounded to
 * integers; `decimals` keeps that many places (ratio).
 * @returns {number|null} `null` when the text is not a non-negative number
 */
export function parseAmount(text, decimals = 0) {
  const trimmed = String(text ?? '').trim().replace(',', '.');
  if (trimmed === '' || !/^\d*\.?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * @param {import('../../main.js').AppContext} ctx
 * @param {import('./index.js').TabHost} host
 * @returns {import('./index.js').TabView}
 */
export function create(ctx, host) {
  const { el, toast } = ctx.ui;
  const t = ctx.i18n;
  let torrentId = null;
  let seq = 0;
  const uid = () => `opt-${++seq}`;

  function send(patch) {
    if (torrentId == null) return Promise.resolve();
    return Promise.resolve()
      .then(() => ctx.rpc.call('torrent-set', { ids: [torrentId], ...patch }))
      .then(() => host.refresh(), (err) => {
        toast(t('details.options.saveFailed', { message: errorMessage(t, err) }), { tone: 'error' });
        host.refresh();
      });
  }

  function switchRow(labelKey, onToggle) {
    const labelId = uid();
    const button = el('button', {
      type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': labelId,
      on: {
        click: () => {
          const next = button.getAttribute('aria-checked') !== 'true';
          button.setAttribute('aria-checked', String(next));
          onToggle(next);
        },
      },
    });
    const row = el('div', { class: 'option-row' }, [el('span', { class: 'option-label', id: labelId, text: t(labelKey) }), button]);
    return { row, control: button, set: (on) => button.setAttribute('aria-checked', String(Boolean(on))) };
  }

  function numberRow(labelKey, unitKey, decimals, onValue) {
    const inputId = uid();
    const input = el('input', {
      class: 'input option-number tabular', id: inputId, type: 'text', inputmode: decimals ? 'decimal' : 'numeric',
      autocomplete: 'off', spellcheck: 'false',
      on: {
        change: () => {
          const value = parseAmount(input.value, decimals);
          if (value === null) {
            input.setAttribute('aria-invalid', 'true');
            return;
          }
          input.removeAttribute('aria-invalid');
          input.value = String(value);
          onValue(value);
        },
      },
    });
    const row = el('div', { class: 'option-row' }, [
      el('label', { class: 'option-label', for: inputId, text: t(labelKey) }),
      el('span', { class: 'option-field' }, [input, unitKey ? el('span', { class: 'option-unit', text: t(unitKey) }) : null]),
    ]);
    return {
      row,
      control: input,
      set: (n) => { input.value = Number.isFinite(n) ? String(decimals ? n : Math.round(n)) : ''; },
      enable: (on) => { input.disabled = !on; },
    };
  }

  function selectRow(labelKey, choices, onValue) {
    const selectId = uid();
    const select = el('select', {
      class: 'select option-select', id: selectId,
      on: { change: () => onValue(Number(select.value)) },
    }, choices.map(([value, key]) => el('option', { value: String(value), text: t(key) })));
    const row = el('div', { class: 'option-row' }, [
      el('label', { class: 'option-label', for: selectId, text: t(labelKey) }), select,
    ]);
    return { row, control: select, set: (v) => { select.value = String(v); } };
  }

  const down = switchRow('details.options.limitDownload', (on) => {
    downRate.enable(on);
    send({ downloadLimited: on });
  });
  const downRate = numberRow('details.options.downloadRate', 'details.options.kbps', 0, (n) => send({ downloadLimit: n }));
  const up = switchRow('details.options.limitUpload', (on) => {
    upRate.enable(on);
    send({ uploadLimited: on });
  });
  const upRate = numberRow('details.options.uploadRate', 'details.options.kbps', 0, (n) => send({ uploadLimit: n }));
  const honors = switchRow('details.options.honorGlobal', (on) => send({ honorsSessionLimits: on }));
  const priority = selectRow('details.options.priority', [
    [1, 'details.options.priorityHigh'], [0, 'details.options.priorityNormal'], [-1, 'details.options.priorityLow'],
  ], (v) => send({ bandwidthPriority: v }));

  const ratioMode = selectRow('details.options.ratioMode', [
    [0, 'details.options.useGlobal'], [1, 'details.options.stopAtRatio'], [2, 'details.options.unlimited'],
  ], (v) => {
    ratio.enable(v === 1);
    send({ seedRatioMode: v });
  });
  const ratio = numberRow('details.options.ratio', null, 2, (n) => send({ seedRatioLimit: n }));
  const idleMode = selectRow('details.options.idleMode', [
    [0, 'details.options.useGlobal'], [1, 'details.options.stopWhenIdle'], [2, 'details.options.unlimited'],
  ], (v) => {
    idle.enable(v === 1);
    send({ seedIdleMode: v });
  });
  const idle = numberRow('details.options.idle', 'details.options.minutes', 0, (n) => send({ seedIdleLimit: n }));
  const peers = numberRow('details.options.peerLimit', null, 0, (n) => send({ 'peer-limit': n }));
  const sequential = switchRow('details.options.sequential', (on) => send({ sequential_download: on }));

  const message = el('p', { class: 'details-message' });
  const sequentialCard = el('section', { class: 'option-card' }, [
    el('h3', { class: 'detail-label', text: t('details.options.order') }), sequential.row,
  ]);
  const form = el('div', { class: 'options-grid' }, [
    el('section', { class: 'option-card' }, [
      el('h3', { class: 'detail-label', text: t('details.options.speed') }),
      down.row, downRate.row, up.row, upRate.row, honors.row, priority.row,
    ]),
    el('section', { class: 'option-card' }, [
      el('h3', { class: 'detail-label', text: t('details.options.seeding') }),
      ratioMode.row, ratio.row, idleMode.row, idle.row,
    ]),
    el('section', { class: 'option-card' }, [
      el('h3', { class: 'detail-label', text: t('details.options.peers') }), peers.row,
    ]),
    sequentialCard,
  ]);
  const root = el('div', { class: 'options' }, [message, form]);

  /** Write a value into a control unless the user is in it right now. */
  function apply(row, value) {
    if (document.activeElement === row.control) return;
    row.set(value);
  }

  return {
    root,
    render(torrent, d, state) {
      if (torrent.id !== torrentId) torrentId = torrent.id;
      if (!d || state.error) {
        form.hidden = true;
        message.hidden = false;
        message.textContent = state.error ? t('details.loadFailedWith', { message: state.error }) : t('details.loading');
        return;
      }
      form.hidden = false;
      message.hidden = true;
      apply(down, d.downloadLimited === true);
      apply(downRate, Math.round(Number(d.downloadLimit)));
      downRate.enable(d.downloadLimited === true);
      apply(up, d.uploadLimited === true);
      apply(upRate, Math.round(Number(d.uploadLimit)));
      upRate.enable(d.uploadLimited === true);
      apply(honors, d.honorsSessionLimits !== false);
      apply(priority, [1, 0, -1].includes(d.bandwidthPriority) ? d.bandwidthPriority : 0);
      apply(ratioMode, [0, 1, 2].includes(d.seedRatioMode) ? d.seedRatioMode : 0);
      apply(ratio, Number(d.seedRatioLimit));
      ratio.enable(d.seedRatioMode === 1);
      apply(idleMode, [0, 1, 2].includes(d.seedIdleMode) ? d.seedIdleMode : 0);
      apply(idle, Number(d.seedIdleLimit));
      idle.enable(d.seedIdleMode === 1);
      apply(peers, Number(d.peerLimit));
      const hasSequential = Boolean(ctx.caps && ctx.caps.sequential) && typeof d.sequentialDownload === 'boolean';
      sequentialCard.hidden = !hasSequential;
      if (hasSequential) apply(sequential, d.sequentialDownload);
    },
  };
}
