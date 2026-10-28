/**
 * About: the QuickBox mark, this interface's version, the Transmission
 * version and RPC details from the session and caps, the credit to the
 * project this interface is based on (plain text, no link), and a local link
 * to the web interface Transmission ships, which the installer keeps as
 * `index.original.html`.
 */

import { VERSION } from '../../version.js?v=__QBV__';
import { quickboxMark } from '../../core/brand.js?v=__QBV__';

export const ORIGINAL_UI = 'index.original.html';

/**
 * Display lines for the daemon: its version string and the RPC it speaks.
 * @param {{ version?: string }} session
 * @param {{ rpc?: number, semver?: string|null, dialect?: string }|null} caps
 */
export function daemonInfo(session, caps) {
  const version = session && typeof session.version === 'string' && session.version ? session.version : null;
  let rpc = null;
  if (caps && (caps.semver || caps.rpc)) {
    rpc = { semver: caps.semver || null, rpc: caps.rpc || null, dialect: caps.dialect === 'jsonrpc' ? 'jsonrpc' : 'legacy' };
  }
  return { version, rpc };
}

/**
 * @param {import('../../main.js').AppContext} ctx
 */
export function createAboutDialog(ctx) {
  const { el, openDialog } = ctx.ui;
  const t = ctx.i18n;
  const fmt = ctx.fmt;

  function row(labelKey, value) {
    return el('div', { class: 'fact' }, [
      el('dt', { class: 'detail-label', text: t(labelKey) }),
      el('dd', { class: 'fact-value' }, [el('span', { class: 'detail-value', text: value })]),
    ]);
  }

  function open() {
    const { version, rpc } = daemonInfo(ctx.store.get().session, ctx.caps);
    const rpcText = !rpc ? t('dialogs.about.unknown')
      : [
        rpc.semver ? t('dialogs.about.rpcSemver', { semver: rpc.semver }) : null,
        rpc.rpc ? t('dialogs.about.rpcVersion', { rpc: fmt.count(rpc.rpc) }) : null,
        t(rpc.dialect === 'jsonrpc' ? 'dialogs.about.jsonrpc' : 'dialogs.about.legacy'),
      ].filter(Boolean).join(' · ');
    const close = el('button', { type: 'button', class: 'btn btn-secondary', text: t('core.actions.close') });
    const body = el('div', { class: 'about' }, [
      el('div', { class: 'about-brand' }, [
        quickboxMark({ size: 56, label: t('core.app.brand'), className: 'about-mark' }),
        el('div', {}, [
          el('p', { class: 'about-name', text: t('dialogs.about.product') }),
          el('p', { class: 'about-version tabular', text: t('dialogs.about.uiVersion', { version: VERSION }) }),
        ]),
      ]),
      el('dl', { class: 'facts about-facts' }, [
        row('dialogs.about.transmission', version || t('dialogs.about.unknown')),
        row('dialogs.about.rpc', rpcText),
      ]),
      el('p', { class: 'about-credit', text: t('dialogs.about.credit') }),
      el('a', { class: 'about-original', href: ORIGINAL_UI, text: t('dialogs.about.original') }),
    ]);
    close.addEventListener('click', () => dialog.close('close'));
    const dialog = openDialog({
      title: t('dialogs.about.title'),
      icon: 'header-about',
      body,
      actions: [close],
      initialFocus: close,
    });
    return { close: () => dialog.close('close') };
  }

  return { open };
}
