import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig, easterSunday, czechHolidays, dayType, listFor, ntMinutes, priceHours, fixedFor, ranges, names, buckets, pct, parseNum, fmt,
} from '../dist/energy-card.js';

// The current contract (spec, Facts): ČEZ D25d, incl. VAT.
const D25D = {
  name: 'ČEZ Refix D25d', valid_from: '2025-02-01', valid_to: '',
  vt: 6045.56, nt: 3551.62, poze: 598.95, fixed: 454.77,
  nt_windows: {
    workday: ['00:00-04:10', '16:55-18:55', '22:10-24:00'],
    weekend_holiday: ['01:55-05:50', '15:20-17:50', '22:25-24:00'],
  },
};
const SINGLE = { name: 'single', valid_from: '2025-02-01', valid_to: '', vt: 5000, nt: null, poze: 600, fixed: 300, nt_windows: { workday: [], weekend_holiday: [] } };
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const CFG = {
  energy_entity: 'sensor.e', power_entity: 'sensor.p', meter_vt: 'sensor.vt', meter_nt: 'sensor.nt',
  meter_history: 'sensor.h', meter_script: 'script.s',
};

test('Easter and Czech holidays', () => {
  assert.equal(easterSunday(2025).getTime(), at(2025, 4, 20).getTime());
  assert.equal(easterSunday(2026).getTime(), at(2026, 4, 5).getTime());
  const h = czechHolidays(2026);
  assert.ok(h.has('2026-04-03')); // Good Friday
  assert.ok(h.has('2026-04-06')); // Easter Monday
  assert.ok(h.has('2026-10-28') && h.has('2026-12-24') && h.has('2026-07-06'));
  assert.equal(h.size, 13);
});

test('dayType: weekend and holiday', () => {
  assert.equal(dayType(at(2026, 10, 27)), 'workday'); // Tuesday
  assert.equal(dayType(at(2026, 10, 28)), 'weekend_holiday'); // Wednesday, holiday
  assert.equal(dayType(at(2026, 10, 31)), 'weekend_holiday'); // Saturday
});

test('ntMinutes: D25d windows', () => {
  const wd = (h) => ntMinutes(D25D, at(2026, 10, 27, h)); // Tuesday
  assert.equal(wd(4), 10);
  assert.equal(wd(16), 5);
  assert.equal(wd(17), 60);
  assert.equal(wd(22), 50);
  assert.equal(wd(23), 60); // 24:00 = midnight
  assert.equal(wd(12), 0);
  const sat = (h) => ntMinutes(D25D, at(2026, 10, 31, h));
  assert.equal(sat(1), 5);
  assert.equal(sat(5), 50);
  // 28. 10. is a holiday on a Wednesday: weekend windows
  assert.equal(ntMinutes(D25D, at(2026, 10, 28, 1)), 5);
  assert.equal(ntMinutes(D25D, at(2026, 10, 28, 0)), 0);
  assert.equal(ntMinutes(SINGLE, at(2026, 10, 27, 1)), 0);
  assert.equal(ntMinutes(null, at(2026, 10, 27, 1)), 0);
});

test('priceHours: NT, half NT, negative hour, no list', () => {
  const nt = priceHours([{ start: at(2026, 10, 27, 1), kwh: 1 }], [D25D]);
  close(nt.kc, (3551.62 + 598.95) / 1000);
  close(nt.ntKwh, 1);
  const half = { ...D25D, nt_windows: { workday: ['10:00-10:30'], weekend_holiday: [] } };
  close(priceHours([{ start: at(2026, 10, 27, 10), kwh: 2 }], [half]).kc, (2 * ((3551.62 + 6045.56) / 2 + 598.95)) / 1000);
  const neg = priceHours([{ start: at(2026, 9, 3, 10), kwh: -6404.5 }, { start: at(2026, 9, 3, 11), kwh: 1 }], [D25D]);
  assert.equal(neg.kwh, 1);
  close(neg.kc, (6045.56 + 598.95) / 1000);
  const none = priceHours([{ start: at(2024, 5, 1, 10), kwh: 3 }], [D25D]);
  assert.deepEqual(none, { kwh: 3, ntKwh: 0, kc: 0, unpriced: true });
});

test('price list boundary mid-month', () => {
  const a = { ...SINGLE, valid_from: '2026-01-01', valid_to: '2026-03-15', vt: 4000, poze: 0 };
  const b = { ...SINGLE, valid_from: '2026-03-16', valid_to: '', vt: 5000, poze: 0 };
  assert.equal(listFor([a, b], at(2026, 3, 15, 23)), a);
  assert.equal(listFor([a, b], at(2026, 3, 16)), b);
  assert.equal(listFor([a, b], at(2025, 12, 31)), null);
  const r = priceHours([{ start: at(2026, 3, 15, 12), kwh: 1 }, { start: at(2026, 3, 16, 12), kwh: 1 }], [a, b]);
  close(r.kc, 9);
});

test('fixedFor: whole month and half', () => {
  close(fixedFor([D25D], at(2026, 11, 1), at(2026, 12, 1)), 454.77);
  close(fixedFor([D25D], at(2026, 11, 1), at(2026, 11, 16)), 454.77 / 2);
  close(fixedFor([D25D], at(2026, 11, 10), at(2026, 11, 10, 12)), 454.77 / 30 / 2);
  close(fixedFor([D25D], at(2025, 1, 1), at(2025, 2, 1)), 0); // before the first list
});

test('ranges: like-for-like', () => {
  const m = ranges(at(2026, 3, 31, 14), 'month');
  assert.deepEqual(m.cur.map(Number), [at(2026, 3, 1), at(2026, 3, 31, 14)].map(Number));
  assert.deepEqual(m.prev.map(Number), [at(2026, 2, 1), at(2026, 2, 28, 14)].map(Number));
  assert.deepEqual(m.yoy.map(Number), [at(2025, 3, 1), at(2025, 3, 31, 14)].map(Number));
  assert.deepEqual(ranges(at(2028, 3, 31, 9), 'month').prev.map(Number), [at(2028, 2, 1), at(2028, 2, 29, 9)].map(Number));
  const leap = ranges(at(2028, 2, 29, 10), 'month');
  assert.deepEqual(leap.yoy.map(Number), [at(2027, 2, 1), at(2027, 2, 28, 10)].map(Number));
  const jan = ranges(at(2026, 1, 15, 8), 'month');
  assert.deepEqual(jan.prev.map(Number), [at(2025, 12, 1), at(2025, 12, 15, 8)].map(Number));
  const d = ranges(at(2026, 3, 1, 8, 30), 'day');
  assert.deepEqual(d.cur.map(Number), [at(2026, 3, 1), at(2026, 3, 1, 8, 30)].map(Number));
  assert.deepEqual(d.prev.map(Number), [at(2026, 2, 28), at(2026, 2, 28, 8, 30)].map(Number));
  assert.deepEqual(d.yoy.map(Number), [at(2025, 3, 1), at(2025, 3, 1, 8, 30)].map(Number));
  assert.deepEqual(ranges(at(2028, 2, 29, 10), 'day').yoy.map(Number), [at(2027, 2, 28), at(2027, 2, 28, 10)].map(Number));
  const y = ranges(at(2028, 2, 29, 10), 'year');
  assert.deepEqual(y.prev.map(Number), [at(2027, 1, 1), at(2027, 2, 28, 10)].map(Number));
  assert.equal(y.yoy, null);
});

test('names: labels in Czech', () => {
  const n = names(at(2026, 10, 30, 14, 20), 'month');
  assert.equal(n.range, 'Říjen · 1.–30.');
  assert.equal(n.chipPrev, 'vs září');
  assert.equal(n.chipYoy, 'vs říjen 2025');
  assert.equal(names(at(2026, 10, 30, 14, 20), 'day').range, 'Dnes · do 14:20');
  assert.equal(names(at(2026, 10, 30), 'year').chipPrev, 'vs 2025');
});

test('buckets and pct', () => {
  const b = buckets([{ start: at(2026, 10, 27, 1), kwh: 1 }, { start: at(2026, 10, 27, 1, 30), kwh: 1 }, { start: at(2026, 10, 27, 23), kwh: -5 }], [D25D], 'day', 24);
  assert.equal(b[1].kwh, 2);
  assert.equal(b[23].kwh, 0);
  close(b[1].kc, (2 * (3551.62 + 598.95)) / 1000);
  assert.equal(pct(110, 100).toFixed(1), '10.0');
  assert.equal(pct(1, 0), null);
});

test('normalizeConfig', () => {
  for (const k of Object.keys(CFG)) {
    const c = { ...CFG };
    delete c[k];
    assert.throws(() => normalizeConfig(c), new RegExp(`energy-card: ${k} is required`));
  }
  const later = { ...SINGLE, valid_from: '2027-01-01' };
  const n = normalizeConfig({ ...CFG, price_lists: JSON.stringify([later, D25D]) });
  assert.deepEqual(n.price_lists.map((l) => l.valid_from), ['2025-02-01', '2027-01-01']);
  assert.equal(n.accent, '#0288d1');
  assert.deepEqual(n.phase_entities, []);
  assert.throws(() => normalizeConfig({ ...CFG, price_lists: '{bad' }), /not valid JSON/);
  assert.deepEqual(normalizeConfig(CFG).price_lists, []);
});

test('parseNum and fmt', () => {
  assert.equal(parseNum('48 315,5'), 48315.5);
  assert.equal(parseNum('48315.5'), 48315.5);
  assert.ok(Number.isNaN(parseNum('')));
  assert.equal(fmt(1460, 0).replace(/\s/g, ' '), '1 460');
});
