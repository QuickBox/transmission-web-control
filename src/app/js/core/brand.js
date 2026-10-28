/**
 * The QuickBox mark (green hexagon, grey cube, particle dots) as inline SVG.
 * The ten shapes are the visible layer of the brand icon, traced once here so
 * the app ships no image file and loads no URL. Fills come from the
 * `--qb-brand-*` tokens, so the light variant can shift the greys for
 * contrast without touching this module.
 */

import { svg } from './dom.js?v=__QBV__';

export const MARK_VIEWBOX = '0 0 447.6 378.5';

/** Aspect ratio of the mark (width / height). */
export const MARK_RATIO = 447.6 / 378.5;

const FILL = Object.freeze({
  green: 'var(--qb-brand-green)',
  greenDeep: 'var(--qb-brand-green-deep)',
  grey: 'var(--qb-brand-grey)',
  greyLight: 'var(--qb-brand-grey-light)',
});

/** @type {readonly { tag: 'path'|'polygon', fill: keyof typeof FILL, d?: string, points?: string }[]} */
export const MARK_SHAPES = Object.freeze([
  { tag: 'polygon', fill: 'greyLight', points: '195,144.9 183.1,138 171.3,144.9 171.3,158.6 183.1,165.4 195,158.6' },
  { tag: 'polygon', fill: 'greyLight', points: '230.8,202 210,189.9 189.2,202 189.2,226 210,238 230.8,226' },
  { tag: 'polygon', fill: 'green', points: '280.6,6.8 124,97.2 124,119.7 151,104.1 183.8,123 280.6,67.1 385,127.4 385,247.9 280.6,308.2 208.4,266.5 189.2,277.5 165.2,263.6 165.2,235.9 176.2,229.5 176.2,175.1 151,189.6 131.9,178.6 139.6,174.1 139.6,143.6 113.2,128.3 86.7,143.6 86.7,174.1 113.2,189.4 124,183.1 124,210.3 149.7,225.1 149.7,263.8 124.5,278.4 280.6,368.4 437.2,278 437.2,97.2' },
  { tag: 'polygon', fill: 'green', points: '127.1,227.3 105.8,215 84.4,227.3 84.4,252 105.8,264.3 127.1,252' },
  { tag: 'polygon', fill: 'green', points: '43.4,183 43.4,202 59.9,211.5 76.3,202 76.3,183 59.9,173.5' },
  { tag: 'polygon', fill: 'green', points: '31.9,220.6 31.9,233.9 43.4,240.5 54.9,233.9 54.9,220.6 43.4,214' },
  { tag: 'polygon', fill: 'green', points: '10.5,174.8 10.5,182.6 17.2,186.5 24,182.6 24,174.8 17.2,170.9' },
  { tag: 'polygon', fill: 'green', points: '55,128.9 55,142.7 67,149.6 78.9,142.7 78.9,128.9 67,122' },
  { tag: 'polygon', fill: 'greenDeep', points: '280.6,368.4 280.6,308.2 385,247.9 385,127.4 437.2,97.2 437.2,278' },
  { tag: 'polygon', fill: 'grey', points: '280.6,272.3 280.6,187.6 353.9,145.3 353.9,229.9' },
]);

/**
 * @param {{ size?: number, label?: string, className?: string }} [opts]
 *   `size` is the rendered width in px (height follows the ratio). With a
 *   `label` the mark is an image with that name; without one it is decorative
 *   (`aria-hidden`), for use beside visible text.
 * @returns {SVGElement}
 */
export function quickboxMark(opts = {}) {
  const width = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 24;
  const height = Math.round((width / MARK_RATIO) * 10) / 10;
  const a11y = opts.label ? { role: 'img', 'aria-label': opts.label } : { 'aria-hidden': 'true' };
  return svg('svg', {
    class: ['brand-mark', opts.className].filter(Boolean).join(' '),
    viewBox: MARK_VIEWBOX,
    width,
    height,
    focusable: 'false',
    ...a11y,
  }, MARK_SHAPES.map((shape) => svg(shape.tag, {
    ...(shape.d ? { d: shape.d } : { points: shape.points }),
    style: { fill: FILL[shape.fill] },
  })));
}
