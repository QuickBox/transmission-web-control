/**
 * Pure display formatters. Each takes the raw RPC value and an optional
 * `opts = { locale, units }`; `bindFormat(opts)` returns the same functions
 * with `opts` applied, which is what `ctx.fmt` is. Unknown or "not available"
 * values render as an em dash, never as 0.
 */

export const EMPTY = '—';
export const INFINITY = '∞';

/** English unit labels; the core catalog's `core.units.*` keys override them. */
export const DEFAULT_UNITS = Object.freeze({
  size1000: ['B', 'kB', 'MB', 'GB', 'TB', 'PB'],
  size1024: ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'],
  perSecond: '{size}/s',
  day: '{n}d',
  hour: '{n}h',
  minute: '{n}m',
  second: '{n}s',
});

const numberFormats = new Map();
const dateFormats = new Map();

function numberFormat(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let nf = numberFormats.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, nf);
  }
  return nf;
}

function units(opts) {
  return opts && opts.units ? { ...DEFAULT_UNITS, ...opts.units } : DEFAULT_UNITS;
}

function locale(opts) {
  return (opts && opts.locale) || 'en';
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Byte count. `opts.base` is 1000 (Transmission's default size units) or 1024.
 * @param {number} n
 * @param {{ locale?: string, units?: object, base?: 1000|1024 }} [opts]
 */
export function bytes(n, opts) {
  if (!finite(n) || n < 0) return EMPTY;
  const base = opts && opts.base === 1024 ? 1024 : 1000;
  const labels = units(opts)[base === 1024 ? 'size1024' : 'size1000'];
  let i = 0;
  let v = n;
  while (v >= base && i < labels.length - 1) {
    v /= base;
    i += 1;
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  const text = numberFormat(locale(opts), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
  return `${text} ${labels[i]}`;
}

/**
 * Transfer rate in bytes per second.
 * @param {number} n
 * @param {{ locale?: string, units?: object, base?: 1000|1024 }} [opts]
 */
export function speed(n, opts) {
  const size = bytes(n, opts);
  return size === EMPTY ? EMPTY : fill(units(opts).perSecond, { size });
}

/**
 * Seconds as the two largest units ("2d 3h", "4m 9s"). Transmission's -1
 * (not available) is an em dash and -2 (unknown) is infinity.
 * @param {number} seconds
 * @param {{ locale?: string, units?: object }} [opts]
 */
export function eta(seconds, opts) {
  if (seconds === -2) return INFINITY;
  if (!finite(seconds) || seconds < 0) return EMPTY;
  const u = units(opts);
  const nf = numberFormat(locale(opts), { maximumFractionDigits: 0 });
  const s = Math.floor(seconds);
  const parts = [
    [Math.floor(s / 86400), u.day],
    [Math.floor((s % 86400) / 3600), u.hour],
    [Math.floor((s % 3600) / 60), u.minute],
    [s % 60, u.second],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return fill(u.second, { n: nf.format(0) });
  return parts
    .slice(first, first + 2)
    .filter(([n], idx) => idx === 0 || n > 0)
    .map(([n, tpl]) => fill(tpl, { n: nf.format(n) }))
    .join(' ');
}

/** Elapsed time, same shape as `eta`. */
export const duration = eta;

/**
 * Upload ratio. Transmission's -1 (not available) is an em dash and -2
 * (infinite) is infinity.
 * @param {number} r
 * @param {{ locale?: string }} [opts]
 */
export function ratio(r, opts) {
  if (r === -2) return INFINITY;
  if (!finite(r) || r < 0) return EMPTY;
  return numberFormat(locale(opts), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(r);
}

/**
 * A 0..1 fraction as a percentage, rounded DOWN so an incomplete torrent never
 * reads 100%.
 * @param {number} fraction
 * @param {{ locale?: string, digits?: number }} [opts]
 */
export function percent(fraction, opts) {
  if (!finite(fraction)) return EMPTY;
  const digits = opts && Number.isInteger(opts.digits) ? opts.digits : 1;
  const scale = 10 ** (digits + 2);
  const clamped = Math.min(1, Math.max(0, fraction));
  const floored = Math.floor(clamped * scale + 1e-9) / scale;
  return numberFormat(locale(opts), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(floored);
}

/**
 * A Unix timestamp in seconds. 0 and negatives (never happened) are an em dash.
 * @param {number} epochSeconds
 * @param {{ locale?: string, timeZone?: string }} [opts]
 */
export function date(epochSeconds, opts) {
  if (!finite(epochSeconds) || epochSeconds <= 0) return EMPTY;
  const loc = locale(opts);
  const timeZone = opts && opts.timeZone;
  const key = `${loc}|${timeZone || ''}`;
  let df = dateFormats.get(key);
  if (!df) {
    df = new Intl.DateTimeFormat(loc, { dateStyle: 'medium', timeStyle: 'short', timeZone });
    dateFormats.set(key, df);
  }
  return df.format(new Date(epochSeconds * 1000));
}

/**
 * Plain integer with locale grouping ("12,345").
 * @param {number} n
 * @param {{ locale?: string }} [opts]
 */
export function count(n, opts) {
  if (!finite(n)) return EMPTY;
  return numberFormat(locale(opts), { maximumFractionDigits: 0 }).format(n);
}

/**
 * @typedef {{
 *   bytes: (n: number, o?: object) => string, speed: (n: number, o?: object) => string,
 *   eta: (s: number) => string, duration: (s: number) => string,
 *   ratio: (r: number) => string, percent: (f: number, o?: object) => string,
 *   date: (t: number) => string, count: (n: number) => string,
 * }} Formatter
 */

/**
 * @param {{ locale?: string, units?: object }} opts
 * @returns {Formatter}
 */
export function bindFormat(opts) {
  const base = { locale: locale(opts), units: units(opts) };
  const withBase = (o) => (o ? { ...base, ...o } : base);
  return Object.freeze({
    bytes: (n, o) => bytes(n, withBase(o)),
    speed: (n, o) => speed(n, withBase(o)),
    eta: (s) => eta(s, base),
    duration: (s) => eta(s, base),
    ratio: (r) => ratio(r, base),
    percent: (f, o) => percent(f, withBase(o)),
    date: (t) => date(t, base),
    count: (n) => count(n, base),
  });
}
