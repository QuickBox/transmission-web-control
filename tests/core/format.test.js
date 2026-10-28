import test from 'node:test';
import assert from 'node:assert/strict';
import { bytes, speed, eta, ratio, percent, date, count, bindFormat, EMPTY, INFINITY } from '../../src/app/js/core/format.js';

test('bytes: SI by default, IEC on request, unknown is an em dash', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(999), '999 B');
  assert.equal(bytes(1000), '1.00 kB');
  assert.equal(bytes(1536, { base: 1024 }), '1.50 KiB');
  assert.equal(bytes(25_400_000), '25.4 MB');
  assert.equal(bytes(734_000_000_000), '734 GB');
  assert.equal(bytes(-1), EMPTY);
  assert.equal(bytes(NaN), EMPTY);
  assert.equal(bytes(undefined), EMPTY);
});

test('bytes: locale decimal separator and translated labels', () => {
  assert.equal(bytes(1500, { locale: 'de' }), '1,50 kB');
  assert.equal(bytes(1500, { locale: 'fr', units: { size1000: ['o', 'ko', 'Mo', 'Go', 'To', 'Po'] } }), '1,50 ko');
});

test('speed appends the per-second template', () => {
  assert.equal(speed(2_500_000), '2.50 MB/s');
  assert.equal(speed(0), '0 B/s');
  assert.equal(speed(-1), EMPTY);
});

test('eta: two largest units, Transmission sentinels', () => {
  assert.equal(eta(0), '0s');
  assert.equal(eta(59), '59s');
  assert.equal(eta(249), '4m 9s');
  assert.equal(eta(3600), '1h');
  assert.equal(eta(3 * 86400 + 5 * 3600 + 7), '3d 5h');
  assert.equal(eta(86400 + 30), '1d');
  assert.equal(eta(-1), EMPTY);
  assert.equal(eta(-2), INFINITY);
});

test('ratio: two decimals, -1 is unknown, -2 is infinite', () => {
  assert.equal(ratio(1.234), '1.23');
  assert.equal(ratio(0), '0.00');
  assert.equal(ratio(-1), EMPTY);
  assert.equal(ratio(-2), INFINITY);
});

test('percent rounds down so an incomplete torrent never reads 100%', () => {
  assert.equal(percent(0.9999), '99.9%');
  assert.equal(percent(1), '100.0%');
  assert.equal(percent(0.4567, { digits: 0 }), '45%');
  assert.equal(percent(0.29), '29.0%');
  assert.equal(percent(1.4), '100.0%');
  assert.equal(percent(NaN), EMPTY);
});

test('date: 0 means never; formatted in the given zone', () => {
  assert.equal(date(0), EMPTY);
  assert.equal(date(-5), EMPTY);
  assert.match(date(1_700_000_000, { locale: 'en', timeZone: 'UTC' }), /Nov 14, 2023.*10:13/);
});

test('count groups digits', () => {
  assert.equal(count(12345), '12,345');
  assert.equal(count(12345, { locale: 'de' }), '12.345');
});

test('bindFormat applies locale and units to every function', () => {
  const fmt = bindFormat({ locale: 'de', units: { day: '{n} T' } });
  assert.equal(fmt.bytes(1500), '1,50 kB');
  assert.equal(fmt.bytes(1536, { base: 1024 }), '1,50 KiB');
  assert.equal(fmt.eta(90000), '1 T 1h');
  assert.equal(fmt.ratio(0.5), '0,50');
  assert.ok(Object.isFrozen(fmt));
});
