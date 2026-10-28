/**
 * About: the QuickBox mark, this interface's version, the Transmission
 * version and RPC details from the session and caps, the credit to the
 * project this interface is based on (plain text, no link), and a local link
 * to the web interface Transmission ships, which the installer keeps as
 * `index.original.html`.
 */

import { VERSION } from '../../version.js?v=__QBV__';

const MARK_POLYGONS = Object.freeze([
  '195,144.9 183.1,138 171.3,144.9 171.3,158.6 183.1,165.4 195,158.6',
  '230.8,202 210,189.9 189.2,202 189.2,226 210,238 230.8,226',
  '280.6,6.8 124,97.2 124,119.7 151,104.1 183.8,123 280.6,67.1 385,127.4 385,247.9 280.6,308.2 208.4,266.5 189.2,277.5 165.2,263.6 165.2,235.9 176.2,229.5 176.2,175.1 151,189.6 131.9,178.6 139.6,174.1 139.6,143.6 113.2,128.3 86.7,143.6 86.7,174.1 113.2,189.4 124,183.1 124,210.3 149.7,225.1 149.7,263.8 124.5,278.4 280.6,368.4 437.2,278 437.2,97.2',
  '127.1,227.3 105.8,215 84.4,227.3 84.4,252 105.8,264.3 127.1,252',
  '43.4,183 43.4,202 59.9,211.5 76.3,202 76.3,183 59.9,173.5',
  '31.9,220.6 31.9,233.9 43.4,240.5 54.9,233.9 54.9,220.6 43.4,214',
  '10.5,174.8 10.5,182.6 17.2,186.5 24,182.6 24,174.8 17.2,170.9',
  '55,128.9 55,142.7 67,149.6 78.9,142.7 78.9,128.9 67,122',
]);
const MARK_SHADE = Object.freeze([
  '280.6,368.4 280.6,308.2 385,247.9 385,127.4 437.2,97.2 437.2,278',
  '280.6,272.3 280.6,187.6 353.9,145.3 353.9,229.9',
]);
const MARK_PATH = 'M280.6,103l-73.3,42.3v35.9l16-9.2l30.6,17.7v35.4L226.4,241l54.2,31.3l73.3-42.3v-84.6L280.6,103z M273.8,170.3l-14.5,8.4l-14.5-8.4v-16.8l14.5-8.4l14.5,8.4V170.3z';

export const ORIGINAL_UI = 'index.original.html';

/**
 * The QuickBox mark as inline SVG, tinted with `currentColor`.
 * @param {(tag: string, props?: object, children?: Node[]) => SVGElement} svg
 * @param {string} label accessible name
 */
export function quickboxMark(svg, label) {
  return svg('svg', { class: 'about-mark', viewBox: '0 0 447.6 378.5', role: 'img', 'aria-label': label }, [
    ...MARK_POLYGONS.map((points) => svg('polygon', { points, fill: 'currentColor' })),
    svg('path', { d: MARK_PATH, fill: 'currentColor' }),
    ...MARK_SHADE.map((points) => svg('polygon', { points, fill: 'currentColor', opacity: '0.7' })),
  ]);
}

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
  const { el, svg, openDialog } = ctx.ui;
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
        quickboxMark(svg, t('core.app.brand')),
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
