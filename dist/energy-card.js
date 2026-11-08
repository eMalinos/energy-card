/**
 * energy-card — electricity card for Home Assistant.
 * Consumption and cost (kWh, Kč incl. VAT and fixed fees) for today / this month / this year,
 * compared like-for-like with the previous period and the same period last year; the meter
 * reading in two registers (VT, NT) with calibration and meter replacement.
 *
 * kWh and Kč always come from the hourly long-term statistics of `energy_entity` (never from
 * the meter registers), each hour priced by the price list valid that day, split into VT / NT
 * by the minutes of the hour that fall into an NT window (Czech public holidays count as
 * weekend days). https://github.com/eMalinos/energy-card
 */

const VERSION = '0.3.0';

const REQUIRED = ['energy_entity', 'power_entity', 'meter_vt', 'meter_nt', 'meter_history', 'meter_script'];
const CACHE_MS = 5 * 60 * 1000;

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const MONTHS_SHORT = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const GRANS = { day: 'Den', month: 'Měsíc', year: 'Rok' };

const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const czDate = (d) => `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;

export function fmt(n, d = 0) {
  return Number(n).toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// "48 315,0" / "48315.0" -> 48315
export function parseNum(s) {
  const t = String(s ?? '').replace(/[\s ]/g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
}

// Price list dates as `YYYY-MM-DD`: a Date or an ISO date-time (YAML/JSON round trips) -> its local date.
export function toDay(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(+d) ? String(v) : isoDay(d);
}

// `accent` lands in CSS backgrounds: a colour only, never url(...) or anything else.
const isColor = (v) => typeof v === 'string' && !/var\(|url\(/i.test(v) && (globalThis.CSS?.supports ? CSS.supports('color', v) : /^#[0-9a-f]{3,8}$/i.test(v));

export function normalizeConfig(config) {
  for (const k of REQUIRED) {
    if (!config || !config[k]) throw new Error(`energy-card: ${k} is required`);
  }
  let lists = config.price_lists ?? [];
  if (typeof lists === 'string') {
    try { lists = JSON.parse(lists); } catch { throw new Error('energy-card: price_lists is not valid JSON'); }
  }
  if (!Array.isArray(lists)) throw new Error('energy-card: price_lists must be a list');
  const num = (v) => { // "200" + 1.5 must not concatenate; "5,2" is 5.2; junk is no price
    const x = typeof v === 'number' ? v : parseNum(v);
    return Number.isFinite(x) ? x : null;
  };
  lists = lists.map((l) => ({
    ...l, valid_from: toDay(l.valid_from), valid_to: toDay(l.valid_to),
    vt: num(l.vt) ?? 0, nt: num(l.nt), poze: num(l.poze) ?? 0, fixed: num(l.fixed) ?? 0,
  }));
  return {
    ...config,
    phase_entities: Array.isArray(config.phase_entities) ? config.phase_entities : [],
    price_lists: lists.sort((a, b) => a.valid_from.localeCompare(b.valid_from)),
    accent: isColor(config.accent) ? config.accent : undefined, // unset: --hfb-accent, then blue
  };
}

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const holidayCache = new Map();
export function czechHolidays(year) {
  if (!holidayCache.has(year)) {
    const e = easterSunday(year);
    const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'].map((md) => `${year}-${md}`);
    const easter = [-2, 1].map((off) => isoDay(new Date(year, e.getMonth(), e.getDate() + off))); // Good Friday, Easter Monday
    holidayCache.set(year, new Set([...fixed, ...easter]));
  }
  return holidayCache.get(year);
}

export function dayType(date) {
  const wd = date.getDay();
  return wd === 0 || wd === 6 || czechHolidays(date.getFullYear()).has(isoDay(date)) ? 'weekend_holiday' : 'workday';
}

export function listFor(lists, date) {
  const day = isoDay(date);
  return lists.find((l) => l.valid_from <= day && (!l.valid_to || day <= l.valid_to)) || null;
}

const toMin = (s) => {
  const [h, m] = String(s ?? '').trim().split(':').map(Number);
  return h * 60 + m;
};

// Minutes of the hour starting at `start` that fall into an NT window of that day's type.
export function ntMinutes(list, start) {
  if (!list || list.nt == null) return 0;
  const from = start.getHours() * 60 + start.getMinutes();
  const to = from + 60;
  let n = 0;
  for (const w of list.nt_windows?.[dayType(start)] || []) {
    const [a, b] = String(w).split(/[-–]/).map(toMin);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue; // not "HH:MM-HH:MM"
    const segs = b > a ? [[a, b]] : [[a, 1440], [0, b]]; // `24:00` = midnight; a window over midnight wraps
    for (const [s, e] of segs) n += Math.max(0, Math.min(to, e) - Math.max(from, s));
  }
  return Math.min(60, n);
}

// hours = [{start: Date, kwh}] -> {kwh, ntKwh, kc (variable part only), unpriced}
export function priceHours(hours, lists) {
  const r = { kwh: 0, ntKwh: 0, kc: 0, unpriced: false };
  for (const h of hours) {
    const kwh = Math.max(0, h.kwh || 0); // a meter reset shows up as a negative hour
    r.kwh += kwh;
    const list = listFor(lists, h.start);
    if (!list) {
      if (kwh > 0) r.unpriced = true;
      continue;
    }
    const nt = ntMinutes(list, h.start) / 60;
    r.ntKwh += kwh * nt;
    r.kc += (kwh * ((list.nt ?? 0) * nt + list.vt * (1 - nt) + (list.poze || 0))) / 1000;
  }
  return r;
}

// Fixed monthly fees for [from, to), pro rata by (parts of) days, each day by its own list.
export function fixedFor(lists, from, to) {
  let sum = 0;
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d < to;) {
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const share = (Math.min(+to, +next) - Math.max(+from, +d)) / (next - d);
    const list = listFor(lists, d);
    if (list && share > 0) sum += ((list.fixed || 0) * share) / daysIn(d.getFullYear(), d.getMonth());
    d = next;
  }
  return sum;
}

// Like-for-like ranges: the comparison period up to the same offset (day clamped to the month's last day).
// At a period's last millisecond (a whole past period, see anchor()) the comparisons are whole too.
export function ranges(now, gran) {
  const r = likeRanges(now, gran);
  if (!complete(now, gran)) return r;
  const whole = (rg) => rg && [rg[0], new Date(+periodEnd(gran, rg[0]) - 1)];
  return { cur: r.cur, prev: whole(r.prev), yoy: whole(r.yoy) };
}

const complete = (now, gran) => +now + 1 === +periodEnd(gran, likeRanges(now, gran).cur[0]);

function likeRanges(now, gran) {
  const Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
  const at = (y, m, d) => new Date(y, m, Math.min(d, daysIn(y, m)), now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  if (gran === 'day') {
    const prevEnd = new Date(Y, M, D - 1, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    const yoyEnd = at(Y - 1, M, D);
    return { cur: [new Date(Y, M, D), now], prev: [day0(prevEnd), prevEnd], yoy: [day0(yoyEnd), yoyEnd] };
  }
  if (gran === 'month') {
    const pm = new Date(Y, M - 1, 1);
    return {
      cur: [new Date(Y, M, 1), now],
      prev: [pm, at(pm.getFullYear(), pm.getMonth(), D)],
      yoy: [new Date(Y - 1, M, 1), at(Y - 1, M, D)],
    };
  }
  return { cur: [new Date(Y, 0, 1), now], prev: [new Date(Y - 1, 0, 1), at(Y - 1, M, D)], yoy: null };
}

export function periodEnd(gran, start) {
  const y = start.getFullYear(), m = start.getMonth();
  if (gran === 'day') return new Date(y, m, start.getDate() + 1);
  if (gran === 'month') return new Date(y, m + 1, 1);
  return new Date(y + 1, 0, 1);
}

// Totals of one range: kWh, Kč incl. fixed fees (`total`), the fixed part, NT kWh.
export function summarize(hours, lists, from, to) {
  const p = priceHours(hours, lists);
  const fixed = fixedFor(lists, from, to);
  return { ...p, fixed, total: p.kc + fixed };
}

const HOUR_MS = 3600000;
export const hourFloor = (d) => new Date(Math.floor(+d / HOUR_MS) * HOUR_MS);

// Where the current range's data ends: the end of its last hourly row (statistics lag behind
// `now`), never past the current full hour and never before the range start. (+1 ms: a past
// period is anchored at its last millisecond, see anchor(), and its last hour is complete.)
export function dataEnd(curHours, start, now) {
  const last = curHours.reduce((m, h) => Math.max(m, +h.start + HOUR_MS), +start);
  return new Date(Math.max(+start, Math.min(last, +hourFloor(new Date(+now + 1)))));
}

// `now` for the period `offset` periods back (0 = the current one): the past one's last millisecond.
export function anchor(now, gran, offset) {
  if (!offset) return now;
  const s = ranges(now, gran).cur[0];
  const start = gran === 'day' ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + offset)
    : gran === 'month' ? new Date(s.getFullYear(), s.getMonth() + offset, 1) : new Date(s.getFullYear() + offset, 0, 1);
  return new Date(+periodEnd(gran, start) - 1);
}

// Like-for-like over complete hours: cut every range at the offset where the current data ends,
// then sum each. `cur`, `prev`, `yoy` = hours fetched for ranges(hourFloor(now), gran).
export function analyze(gran, now, lists, cur, prev, yoy) {
  const end = new Date(Math.min(+dataEnd(cur, ranges(now, gran).cur[0], now), +now));
  const r = ranges(end, gran);
  const cut = (hs, rg) => (hs && rg ? hs.filter((h) => h.start >= rg[0] && h.start < rg[1]) : null);
  const hours = { cur: cut(cur, r.cur), prev: cut(prev, r.prev), yoy: cut(yoy, r.yoy) };
  const sum = (k) => hours[k] && summarize(hours[k], lists, ...r[k]);
  return { end, r, hours, cur: sum('cur'), prev: sum('prev'), yoy: sum('yoy') };
}

export function bucketIndex(gran, d) {
  return gran === 'day' ? d.getHours() : gran === 'month' ? d.getDate() - 1 : d.getMonth();
}

// Hours -> bars: 24 hours, the month's days, or 12 months; each {kwh, kc (variable part)}.
export function buckets(hours, lists, gran, n) {
  const out = Array.from({ length: n }, () => ({ kwh: 0, kc: 0 }));
  for (const h of hours) {
    const b = out[bucketIndex(gran, h.start)];
    if (!b) continue;
    const p = priceHours([h], lists);
    b.kwh += p.kwh;
    b.kc += p.kc;
  }
  return out;
}

export function pct(cur, prev) {
  return prev > 0 ? ((cur - prev) / prev) * 100 : null;
}

// Period names: card range label, stats names and span, chip labels.
export function names(now, gran, past = false) {
  const Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
  const r = ranges(now, gran);
  if (past) { // statistics may end early in a past period: then it is like-for-like up to there
    const n = names(now, gran);
    const span = complete(now, gran) ? { day: 'celý den', month: 'celý měsíc', year: 'celý rok' }[gran] : n.span;
    return gran === 'day' ? { ...n, cur: czDate(now), prev: czDate(r.prev[0]), span } : { ...n, span };
  }
  if (gran === 'day') {
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const yoy = czDate(r.yoy[0]);
    return { range: `Dnes · do ${time}`, span: `do ${time}`, cur: 'Dnes', prev: 'Včera', yoy, chipPrev: 'vs včera', chipYoy: `vs ${yoy}` };
  }
  if (gran === 'month') {
    const pm = r.prev[0];
    return {
      range: `${cap(MONTHS[M])} · 1.–${D}.`, span: `1.–${D}.`,
      cur: `${cap(MONTHS[M])} ${Y}`, prev: `${cap(MONTHS[pm.getMonth()])} ${pm.getFullYear()}`, yoy: `${cap(MONTHS[M])} ${Y - 1}`,
      chipPrev: `vs ${MONTHS[pm.getMonth()]}`, chipYoy: `vs ${MONTHS[M]} ${Y - 1}`,
    };
  }
  return {
    range: `${Y} · 1. 1.–${D}. ${M + 1}.`, span: M === 0 ? 'leden' : `leden–${MONTHS[M]}`,
    cur: String(Y), prev: String(Y - 1), yoy: null, chipPrev: `vs ${Y - 1}`, chipYoy: null,
  };
}

// The only place that reads consumption: hourly `change` from the long-term statistics.
export async function fetchHours(hass, entity, start, end) {
  const res = await hass.callWS({
    type: 'recorder/statistics_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    statistic_ids: [entity],
    period: 'hour',
    types: ['change'],
    units: { energy: 'kWh' },
  });
  return (res?.[entity] || []).map((x) => ({ start: new Date(x.start), kwh: Number(x.change) || 0 })).filter((h) => !Number.isNaN(+h.start));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICON = {
  bolt: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"></path></svg>',
  meter: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9h10M7 13h4M14 13h3M7 17h10"></path></svg>',
  pen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"></path></svg>',
  grid: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 2 4 22M16 2l4 20M6 8h12M5 14h14M12 2v20"></path></svg>',
  house: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3 2 12h3v8h5v-6h4v6h5v-8h3z"></path></svg>',
  stats: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"></path></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>',
  prev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>',
  next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>',
};

export const STYLE = `
:host{display:block;--ec-accent:var(--hfb-accent,#0288d1);--ec-text:var(--hfb-text,var(--primary-text-color,#212121));--ec-muted:var(--hfb-text-2,var(--secondary-text-color,#6b6b6b));--ec-soft:var(--hfb-fill,var(--secondary-background-color,#f5f5f5));--ec-bg:var(--hfb-card,var(--card-background-color,#ffffff));--ec-line:var(--hfb-border,var(--divider-color,#e6e6e6))}
.card{background:var(--ha-card-background,var(--ec-bg));color:var(--ec-text);border-radius:var(--ha-card-border-radius,var(--hfb-card-radius,20px));padding:18px 20px 16px;box-shadow:var(--ha-card-box-shadow,var(--hfb-card-shadow,0 1px 4px rgba(0,0,0,.08)));display:flex;flex-direction:column;gap:14px;box-sizing:border-box;font-family:inherit}
button,input{font-family:inherit;color:inherit}
button{cursor:pointer}
.muted{color:var(--ec-muted)}
.head{display:flex;align-items:center;gap:10px}
.ico{width:36px;height:36px;flex:none;border-radius:50%;background:var(--hfb-heat-dot,#fff3e0);box-shadow:var(--hfb-heat-glow,none);color:var(--hfb-dot-on-icon,#ef6c00);display:flex;align-items:center;justify-content:center}
.head h2{margin:0;font-size:16px;font-weight:500}
.grow{flex:1;min-width:0}
.sub{font-size:12px;color:var(--ec-muted)}
.now{text-align:right}
.now b{font-size:22px;font-weight:700}
.now small{font-size:11px;color:var(--ec-muted);display:block}
.unit{font-size:13px;font-weight:500;color:var(--ec-muted)}
.meter{display:flex;align-items:center;gap:12px;background:var(--ec-soft);border-radius:14px;padding:10px 10px 10px 14px;color:var(--ec-muted)}
.meter .regs{flex:1;min-width:0;display:flex;gap:18px;flex-wrap:wrap}
.reg{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.5px;color:var(--ec-text)}
.reg small{font-size:12px;font-weight:500;color:var(--ec-muted)}
.lbl{font-size:11px;color:var(--ec-muted)}
.btn2{height:44px;border:0;border-radius:12px;background:var(--hfb-btn-raised-bg,var(--ec-bg));padding:0 14px;font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;box-shadow:var(--hfb-btn-raised-shadow,0 1px 3px rgba(0,0,0,.1))}
.flow{position:relative;background:var(--ec-soft);border-radius:16px;height:150px}
.flow>svg{position:absolute;inset:0;width:100%;height:100%}
@keyframes flow{to{stroke-dashoffset:-20}}
.fl{fill:none;stroke-width:2;stroke-linecap:round;stroke-dasharray:0.1 10;animation:flow 1.1s linear infinite}
.fb{fill:none;stroke-width:1.5;opacity:.35}
@media (prefers-reduced-motion:reduce){.fl{animation:none}}
.flow.idle .fl{display:none}
.pf{position:absolute;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;color:var(--ec-muted);white-space:nowrap}
.pf .c{width:78px;height:78px;box-sizing:border-box;border-radius:50%;background:var(--ec-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font-size:12px;font-weight:500;color:var(--ec-text)}
.seg{display:flex;background:var(--hfb-seg-track,var(--ec-soft));border-radius:12px;padding:3px;gap:3px}
.seg button{flex:1;height:36px;border:0;border-radius:10px;font-size:13px;font-weight:500;background:transparent;color:var(--ec-muted)}
.seg button[aria-selected="true"],.seg button[aria-checked="true"]{background:var(--hfb-seg-on,var(--ec-bg));color:var(--hfb-seg-on-color,var(--ec-text));box-shadow:var(--hfb-seg-on-shadow,0 1px 3px rgba(0,0,0,.12))}
.seg.units button{flex:none;height:32px;padding:0 12px}
.sum{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.sum>div{flex:1;min-width:160px}
.big{font-size:28px;font-weight:700;line-height:1.15}
.big small{font-size:14px;font-weight:500;color:var(--ec-muted)}
.kc{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:2px}
.kc b{font-size:18px;font-weight:500}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:-4px}
.chip{border-radius:14px;padding:6px 12px;font-size:12px;font-weight:700}
.chip.up{background:var(--hfb-delta-up-bg,#fff3e0);color:var(--hfb-delta-up-color,#b34700)}
.chip.down{background:var(--hfb-delta-down-bg,#e0f2f1);color:var(--hfb-delta-down-color,#00695c)}
.note{font-size:12px;color:var(--ec-muted)}
.cta{height:44px;border:0;border-radius:14px;background:var(--hfb-btn-primary-bg,var(--ec-text));color:var(--hfb-btn-primary-color,var(--ec-bg));padding:0 18px;font-size:14px;font-weight:500;display:flex;align-items:center;justify-content:center;gap:8px}
.cta:disabled{opacity:.4;cursor:default}
dialog{border:0;padding:0;border-radius:20px;background:var(--ec-bg);color:var(--ec-text);width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);box-shadow:0 12px 40px rgba(0,0,0,.14)}
dialog::backdrop{background:rgba(0,0,0,.4)}
.dlg{padding:20px;display:flex;flex-direction:column;gap:14px}
.dhead{display:flex;align-items:center;gap:10px}
.dhead h3{margin:0;flex:1;font-size:18px;font-weight:500}
.x{width:44px;height:44px;border:0;border-radius:12px;background:transparent;display:flex;align-items:center;justify-content:center}
.nav{display:flex;align-items:center;gap:8px;margin:-6px 0}
.nav b{flex:1;text-align:center;font-size:15px;font-weight:500}
.x:disabled{opacity:.3;cursor:default}
.pills{display:flex;gap:8px;flex-wrap:wrap}
.pills button{height:36px;padding:0 14px;border-radius:18px;font-size:13px;font-weight:500;border:1px solid var(--ec-line);background:var(--ec-bg)}
.pills button[aria-checked="true"]{background:var(--ec-text);border-color:var(--ec-text);color:var(--ec-bg)}
.cmp{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
.cmp .v{font-size:30px;font-weight:700;line-height:1.1}
.cmp .p{font-size:17px;font-weight:500;color:var(--ec-muted)}
.sp{flex:1}
.bars{height:150px;display:flex;align-items:flex-end;gap:2px;border-bottom:1px solid var(--ec-line)}
.bars>div{flex:1;min-width:0;height:100%;display:flex;align-items:flex-end;justify-content:center;gap:1px}
.bars i{width:45%;max-width:10px;border-radius:3px 3px 0 0;background:#c9c9c9}
.bars i.c{background:var(--ec-accent)}
.blab{display:flex;gap:2px;margin-top:6px}
.blab span{flex:1;min-width:0;text-align:center;font-size:10px;color:var(--ec-muted);overflow:hidden}
.legend{display:flex;gap:14px;align-items:center;font-size:12px;color:var(--ec-muted);flex-wrap:wrap}
.legend span{display:flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:3px;background:#c9c9c9}
.legend i.c{background:var(--ec-accent)}
.kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.kpis div{background:var(--ec-soft);border-radius:14px;padding:10px 12px}
.kpis b{display:block;font-size:15px;font-weight:500}
.intro{font-size:13px;color:var(--ec-muted);line-height:1.45}
.flds{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.fld{display:flex;flex-direction:column;gap:6px}
.fld label{font-size:12px;color:var(--ec-muted)}
.fld input{height:44px;border:1px solid var(--ec-line);border-radius:12px;padding:0 12px;font-size:16px;background:var(--ec-bg);box-sizing:border-box;width:100%}
.prev{background:var(--ec-soft);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;font-size:13px}
.prev div{display:flex;justify-content:space-between;gap:10px}
.ok{display:flex;gap:10px;align-items:flex-start;font-size:12px;color:#00695c;background:#e0f2f1;border-radius:12px;padding:10px 12px;line-height:1.4}
.ok svg{flex:none;margin-top:1px}
.hist{display:flex;flex-direction:column;gap:2px}
.hist .row{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-top:1px solid var(--ec-line);font-size:13px}
.hist .row span:first-child{color:var(--ec-muted);width:76px;flex:none}
.hist .row span:nth-child(2){flex:1;min-width:0}
.err{color:var(--error-color,#db4437)}
`;

const diff = (cur, prev, d, unit) => `${cur > prev ? '+' : ''}${fmt(cur - prev, d)} ${unit}`;
const chipHtml = (cur, prev, d, unit, label) => {
  const p = pct(cur, prev);
  return p == null ? '' : `<span class="chip ${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲ +' : '▼ '}${fmt(p, 1)} % (${diff(cur, prev, d, unit)}) ${esc(label)}</span>`;
};
const cacheKey = (gran, offset) => (offset ? `${gran}${offset}` : gran);

class EnergyCard extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this._gran = 'month';
    this._cache = {}; // gran -> {at, now, cur, prev, yoy} (hours) or {at, now, error}
    this._loading = {};
    this._stats = { gran: 'month', cmp: 'prev', unit: 'kwh', offset: 0 };
    this._meter = null; // meter pop-up form while open
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="card"></div><dialog class="stats" aria-label="Statistiky energie"></dialog><dialog class="meterdlg" aria-label="Elektroměr"></dialog>`;
    this._card = this.shadowRoot.querySelector('.card');
    this._statsDlg = this.shadowRoot.querySelector('.stats');
    this._meterDlg = this.shadowRoot.querySelector('.meterdlg');
    this.shadowRoot.addEventListener('click', (e) => this._onClick(e));
    this.shadowRoot.addEventListener('input', (e) => this._onInput(e));
    for (const d of [this._statsDlg, this._meterDlg]) {
      d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // a tap on the backdrop closes it
    }
    this._meterDlg.addEventListener('close', () => { this._meter = null; });
    this._onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      for (const c of Object.values(this._cache)) c.at = 0;
      this._load(this._gran);
      if (this._statsDlg.open) this._load(this._stats.gran, this._stats.offset);
    };
  }

  static getStubConfig() {
    return {
      energy_entity: 'sensor.energy_total', power_entity: 'sensor.power_total',
      meter_vt: 'sensor.hfb_energy_meter_vt', meter_nt: 'sensor.hfb_energy_meter_nt',
      meter_history: 'sensor.hfb_energy_meter_history', meter_script: 'script.hfb_energy_meter_set', price_lists: [],
    };
  }

  setConfig(config) {
    this._cfg = normalizeConfig(config);
    this._cache = {};
    if (this._cfg.accent) this.style.setProperty('--ec-accent', this._cfg.accent); else this.style.removeProperty('--ec-accent');
    if (this._hass) { this._render(); this._load(this._gran); }
  }

  // Structure is rendered on config / data / tab changes; a hass update only patches the live values
  // (keeps focus and the flow animation) and reloads statistics once the 5-minute cache is stale.
  set hass(hass) {
    this._hass = hass;
    if (!this._cfg) return;
    if (this._card.firstChild) this._live(); else this._render();
    if (this._meter && this._meterDlg.open) this._refreshMeter();
    this._load(this._gran);
    if (this._statsDlg.open) this._load(this._stats.gran, this._stats.offset);
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    document.addEventListener('visibilitychange', this._onVisibility);
    this._load(this._gran);
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  // Hours of the ranges of `gran` (`offset` periods back) with their summaries, cached for 5 minutes
  // and per range start (Den rolls over at midnight).
  _load(gran, offset = 0) {
    const ck = cacheKey(gran, offset);
    if (!this._hass || !this._cfg || this._loading[ck]) return;
    const now = anchor(new Date(), gran, offset);
    const key = +ranges(now, gran).cur[0];
    const c = this._cache[ck];
    if (c && c.key === key && ((offset && !c.error) || Date.now() - c.at < CACHE_MS)) return;
    const r = ranges(offset ? now : hourFloor(now), gran);
    const cfg = this._cfg;
    // a past range ends at its last millisecond: fetch up to the full hour so its last row comes too
    const get = (rg) => (rg ? fetchHours(this._hass, cfg.energy_entity, rg[0], new Date(+rg[1] + (offset ? 1 : 0))) : Promise.resolve(null));
    this._loading[ck] = Promise.all([get(r.cur), get(r.prev), get(r.yoy)])
      .then(([cur, prev, yoy]) => ({ at: Date.now(), key, ...analyze(gran, now, cfg.price_lists, cur, prev, yoy) }))
      .catch((e) => ({ at: Date.now(), key, error: e?.message || String(e) }))
      .then((res) => {
        this._loading[ck] = null;
        if (cfg !== this._cfg) return this._load(gran, offset); // config changed meanwhile: load for the new one
        this._cache[ck] = res;
        if (!offset && gran === this._gran) this._render();
        if (this._statsDlg.open && gran === this._stats.gran && offset === this._stats.offset) this._renderStats();
      });
  }

  _twoTariffs() {
    return listFor(this._cfg.price_lists, new Date())?.nt != null;
  }

  _num(entity) {
    const v = parseFloat(this._hass.states[entity]?.state);
    return Number.isFinite(v) ? v : null;
  }

  _onClick(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const v = b.dataset.val;
    switch (b.dataset.act) {
      case 'gran':
        this._gran = v;
        this._render();
        this._load(v);
        break;
      case 'stats':
        this._stats = { gran: this._gran, cmp: 'prev', unit: 'kwh', offset: 0 };
        this._renderStats();
        this._statsDlg.showModal();
        this._load(this._gran);
        break;
      case 'sgran':
        this._stats.gran = v;
        this._stats.offset = 0;
        this._renderStats();
        this._load(v);
        break;
      case 'snav': { // older / newer period, 0 = Dnes; past results kept for the viewed one only
        const s = this._stats;
        s.offset = v === '0' ? 0 : Math.min(0, s.offset + Number(v));
        const keep = cacheKey(s.gran, s.offset);
        for (const k of Object.keys(this._cache)) if (!GRANS[k] && k !== keep) delete this._cache[k];
        this._renderStats();
        this._load(s.gran, s.offset);
        break;
      }
      case 'scmp':
        this._stats.cmp = v;
        this._renderStats();
        break;
      case 'sunit':
        this._stats.unit = v;
        this._renderStats();
        break;
      case 'meter':
        this._meter = { mode: 'align', vt: '', nt: '', old_vt: '', old_nt: '', date: isoDay(new Date()), saved: false, error: '' };
        this._renderMeter();
        this._meterDlg.showModal();
        break;
      case 'mode':
        Object.assign(this._meter, { mode: v, saved: false, error: '' });
        this._renderMeter();
        break;
      case 'save':
        this._save();
        break;
      case 'close':
        b.closest('dialog').close();
        break;
    }
  }

  _onInput(e) {
    const f = e.target.dataset.f;
    if (!f || !this._meter) return;
    this._meter[f] = e.target.value;
    this._meter.saved = false;
    this._meter.error = '';
    // only the preview and the button: a full render would drop the focus
    this.shadowRoot.querySelector('.prev').innerHTML = this._meterPreview();
    this._updateSaveBtn();
  }

  // ---- card -------------------------------------------------------------

  _render() {
    if (!this._cfg || !this._hass) return;
    const phases = this._cfg.phase_entities.length ? '<div class="sub" data-live="phases"></div>' : '';
    const reg = (key, label) => `<div><div class="lbl">${label}</div><div class="reg"><span data-live="${key}"></span> <small>kWh</small></div></div>`;
    const regs = this._twoTariffs() ? reg('vt', 'Stav elektroměru · VT') + reg('nt', 'NT') : reg('vt', 'Stav elektroměru');
    const path = (cls) => `<path class="${cls}" vector-effect="non-scaling-stroke" stroke="#488fc2" d="M60 75 H340"></path>`;
    this._card.innerHTML = `<div class="head"><span class="ico">${ICON.bolt}</span><div class="grow"><h2>Energie</h2>${phases}</div>`
      + '<div class="now"><b data-live="power"></b> <span class="unit">W</span><small>spotřeba teď</small></div></div>'
      + `<div class="meter">${ICON.meter}<div class="regs">${regs}</div><button class="btn2" data-act="meter">${ICON.pen}Elektroměr</button></div>`
      + `<div class="flow"><svg viewBox="0 0 400 150" preserveAspectRatio="none" aria-hidden="true">${path('fb')}${path('fl')}</svg>`
      + `<div class="pf" style="left:15%"><span>Síť</span><span class="c" style="border:3px solid #488fc2"><span style="color:#488fc2">${ICON.grid}</span><span style="color:#2b6a99">→ <span data-live="flow"></span></span></span></div>`
      + `<div class="pf" style="left:85%"><span>Dům</span><span class="c" style="border:3px solid var(--ec-accent)">${ICON.house}<span data-live="flow"></span></span></div></div>`
      + this._period();
    this._live();
  }

  // The values that change with every hass update.
  _live() {
    const w = this._num(this._cfg.power_entity);
    const v = (x, d) => (x == null ? '–' : fmt(x, d));
    const val = {
      power: v(w, 0),
      flow: w == null ? '–' : `${fmt(w, 0)} W`,
      phases: this._cfg.phase_entities.map((id, i) => `L${i + 1} ${v(this._num(id), 0)} W`).join(' · '),
      vt: v(this._num(this._cfg.meter_vt), 1),
      nt: v(this._num(this._cfg.meter_nt), 1),
    };
    for (const el of this._card.querySelectorAll('[data-live]')) {
      const t = val[el.dataset.live];
      if (el.textContent !== t) el.textContent = t;
    }
    this._card.querySelector('.flow').classList.toggle('idle', !(w > 0));
  }

  _period() {
    const tabs = Object.entries(GRANS).map(([id, label]) => `<button role="tab" aria-selected="${id === this._gran}" data-act="gran" data-val="${id}">${label}</button>`).join('');
    const c = this._cache[this._gran];
    const btn = `<button class="cta" data-act="stats">${ICON.stats}Statistiky</button>`;
    let body;
    let chipRow = '';
    if (!c || !c.cur) {
      body = `<div><div class="note${c?.error ? ' err' : ''}">${c?.error ? esc(c.error) : 'Načítám statistiky…'}</div><div class="big">– <small>kWh</small></div></div>`;
    } else {
      const { cur, prev, yoy } = c;
      const n = names(c.end, this._gran);
      const d = this._gran === 'year' ? 0 : 1;
      const nt = this._twoTariffs() && cur.kwh > 0 ? Math.round((cur.ntKwh / cur.kwh) * 100) : null;
      // no consumption in the comparison period = no data yet: no chip (fixed fees alone would compare as +1000 %)
      const both = (o, label) => (o && o.kwh > 0 ? chipHtml(cur.kwh, o.kwh, d, 'kWh', label) + chipHtml(cur.total, o.total, 0, 'Kč', label) : '');
      const chips = both(prev, n.chipPrev) + both(yoy, n.chipYoy);
      body = `<div><div class="note">${esc(n.range)}</div><div class="big">${fmt(cur.kwh, d)} <small>kWh</small></div>`
        + `<div class="kc"><b>≈ ${fmt(cur.total, 0)} Kč</b><span class="note">vč. DPH a stálých plateb ${fmt(cur.fixed, 0)} Kč</span></div>`
        + (nt != null ? `<div class="note">NT ${nt} % · VT ${100 - nt} %</div>` : '')
        + (cur.unpriced || prev.unpriced || yoy?.unpriced ? '<div class="note">část období bez ceníku</div>' : '')
        + '</div>';
      // full card width: four chips (kWh and Kč, two comparisons) don't fit next to the button
      chipRow = `<div class="chips">${chips}</div>`;
    }
    return `<div class="seg" role="tablist" aria-label="Období">${tabs}</div><div class="sum">${body}${btn}</div>${chipRow}`;
  }

  // ---- stats pop-up -----------------------------------------------------

  _renderStats() {
    const s = this._stats;
    const past = s.offset < 0;
    const today = past ? `<button class="btn2" data-act="snav" data-val="0">Dnes</button>` : '';
    const head = `<div class="dhead"><h3>Statistiky energie</h3>${today}<div class="seg units" role="radiogroup" aria-label="Jednotky">`
      + [['kwh', 'kWh'], ['kc', 'Kč']].map(([id, l]) => `<button role="radio" aria-checked="${s.unit === id}" data-act="sunit" data-val="${id}">${l}</button>`).join('')
      + `</div><button class="x" aria-label="Zavřít" data-act="close">${ICON.close}</button></div>`;
    const nav = `<div class="nav"><button class="x" aria-label="Předchozí" data-act="snav" data-val="-1">${ICON.prev}</button>`
      + `<b>${esc(names(anchor(new Date(), s.gran, s.offset), s.gran, past).cur)}</b>`
      + `<button class="x" aria-label="Další" data-act="snav" data-val="1"${past ? '' : ' disabled'}>${ICON.next}</button></div>`;
    const tabs = `<div class="seg" role="tablist" aria-label="Období">${Object.entries(GRANS).map(([id, l]) => `<button role="tab" aria-selected="${s.gran === id}" data-act="sgran" data-val="${id}">${l}</button>`).join('')}</div>${nav}`;
    const c = this._cache[cacheKey(s.gran, s.offset)];
    if (!c || !c.cur) {
      this._statsDlg.innerHTML = `<div class="dlg">${head}${tabs}<div class="note${c?.error ? ' err' : ''}">${c?.error ? esc(c.error) : 'Načítám statistiky…'}</div></div>`;
      return;
    }
    if (past && !c.hours.cur.length) {
      this._statsDlg.innerHTML = `<div class="dlg">${head}${tabs}<div class="note">Za toto období nejsou statistiky.</div></div>`;
      return;
    }
    const lists = this._cfg.price_lists;
    const gran = s.gran;
    const kc = s.unit === 'kc';
    const cmp = gran === 'year' ? 'prev' : s.cmp;
    const { r, end } = c;
    const nm = names(end, gran, past);
    const last = new Date(Math.max(+r.cur[0], +end - 1)); // the last hour with data
    const n = gran === 'day' ? 24 : gran === 'month' ? daysIn(end.getFullYear(), end.getMonth()) : 12;
    const val = (b) => (kc ? b.kc : b.kwh);
    const cmpHours = cmp === 'yoy' ? c.hours.yoy : c.hours.prev;
    const cur = buckets(c.hours.cur, lists, gran, n).map(val);
    const prev = buckets(cmpHours, lists, gran, n).map(val);
    const prevName = cmp === 'yoy' ? nm.yoy : nm.prev;
    const u = kc ? 'Kč' : 'kWh';
    const d = gran === 'year' || kc ? 0 : 1;
    const sum = (a) => a.reduce((t, v) => t + v, 0);
    const curV = sum(cur), prevV = sum(prev);
    const p = pct(curV, prevV);
    const elapsed = end > r.cur[0] ? bucketIndex(gran, last) + 1 : 1;
    const max = Math.max(...cur, ...prev) || 1;
    const label = (i) => (gran === 'day' ? (i % 3 === 0 ? String(i) : '') : gran === 'month' ? ((i + 1) % 5 === 0 || i === 0 ? String(i + 1) : '') : MONTHS_SHORT[i]);
    const tip = (i) => (gran === 'day' ? `${i}:00` : gran === 'month' ? `${i + 1}.` : MONTHS_SHORT[i]);
    const bars = cur.map((v, i) => `<div title="${tip(i)}: ${i < elapsed ? fmt(v, 1) : '–'} / ${fmt(prev[i], 1)} ${u}"><i style="height:${(prev[i] / max) * 100}%"></i><i class="c" style="height:${(i < elapsed ? v / max : 0) * 100}%"></i></div>`).join('');
    const labels = cur.map((_, i) => `<span>${label(i)}</span>`).join('');
    const peak = cur.slice(0, elapsed).reduce((best, v, i) => (v > cur[best] ? i : best), 0);
    const peakLabel = gran === 'day' ? `${peak}:00` : gran === 'month' ? `${peak + 1}. ${end.getMonth() + 1}.` : MONTHS_SHORT[peak];
    const share = (end - r.cur[0]) / (periodEnd(gran, r.cur[0]) - r.cur[0]);
    const kpis = [
      { l: gran === 'day' ? 'Ø za hodinu' : gran === 'year' ? 'Ø za měsíc' : 'Ø za den', v: `${fmt(curV / elapsed, 1)} ${u}` },
      { l: 'Špička', v: `${peakLabel} · ${fmt(cur[peak], 1)} ${u}` },
      { l: 'Rozdíl', v: diff(curV, prevV, d, u) },
      kc
        ? { l: 'Vč. stálých plateb', v: `≈ ${fmt(curV + c.cur.fixed, 0)} Kč` }
        : { l: past ? 'Vč. stálých plateb' : 'Odhad za celé období', v: past ? `≈ ${fmt(c.cur.total, 0)} Kč` : `≈ ${fmt(share > 0 ? curV / share : 0, 0)} kWh` },
    ];
    const cmpPills = gran === 'year' ? '' : `<div class="pills" role="radiogroup" aria-label="Porovnat s">${[['prev', nm.prev], ['yoy', nm.yoy]].map(([id, l]) => `<button role="radio" aria-checked="${cmp === id}" data-act="scmp" data-val="${id}">vs ${esc(l)}</button>`).join('')}</div>`;
    const unpriced = kc && (c.cur.unpriced || (cmp === 'yoy' ? c.yoy : c.prev).unpriced);
    this._statsDlg.innerHTML = `<div class="dlg">${head}${tabs}${cmpPills}`
      + `<div class="cmp"><div><div class="note">${esc(nm.cur)} · ${esc(nm.span)}</div><div class="v">${fmt(curV, d)} <span class="unit">${u}</span></div></div>`
      + `<div style="padding-bottom:4px"><div class="note">${esc(prevName)} · ${esc(nm.span)}</div><div class="p">${fmt(prevV, d)} ${u}</div></div><div class="sp"></div>`
      + (p == null ? '' : `<span class="chip ${p > 0 ? 'up' : 'down'}" style="margin-bottom:6px;font-size:13px">${p > 0 ? '▲ +' : '▼ '}${fmt(p, 1)} % (${diff(curV, prevV, d, u)})</span>`) + '</div>'
      + `<div><div class="bars">${bars}</div><div class="blab">${labels}</div></div>`
      + `<div class="legend"><span><i class="c"></i>${esc(nm.cur)}</span><span><i></i>${esc(prevName)}</span></div>`
      + `<div class="kpis">${kpis.map((k) => `<div><span class="lbl">${k.l}</span><b>${k.v}</b></div>`).join('')}</div>`
      + `<div class="lbl">Porovnáno za stejný úsek období (${esc(nm.span)}).${kc ? ' Každé období svým ceníkem, bez stálých plateb.' : ''}${unpriced ? ' Část období bez ceníku.' : ''}</div></div>`;
  }

  // ---- meter pop-up -----------------------------------------------------

  _renderMeter() {
    const m = this._meter;
    const two = this._twoTariffs();
    const fld = (f, label, type = 'text') => `<div class="fld"><label for="m_${f}">${label}</label><input id="m_${f}" data-f="${f}" type="${type}"${type === 'text' ? ' inputmode="decimal"' : ''} value="${esc(m[f])}"></div>`;
    const regs = (pre, label) => fld(pre + 'vt', two ? `${label} · VT (kWh)` : `${label} (kWh)`) + (two ? fld(pre + 'nt', `${label} · NT (kWh)`) : '');
    const form = m.mode === 'align'
      ? `<div class="intro">Opiš čísla z elektroměru. HA si dopočítá základ, aby stav v HA seděl.</div><div class="flds">${regs('', 'Stav na elektroměru')}</div>`
      : '<div class="intro">Distributor vyměnil elektroměr. HA bude dál pokračovat od stavu nového elektroměru.</div>'
        + `<div class="flds">${fld('date', 'Datum výměny', 'date')}</div>`
        + `<div class="flds">${regs('old_', 'Konečný stav starého, nepovinné')}</div>`
        + `<div class="flds">${regs('', 'Počáteční stav nového')}</div>`;
    const tabs = [['align', 'Srovnat stav'], ['replace', 'Výměna elektroměru']].map(([id, l]) => `<button role="tab" aria-selected="${m.mode === id}" data-act="mode" data-val="${id}">${l}</button>`).join('');
    this._meterDlg.innerHTML = `<div class="dlg"><div class="dhead"><h3>Elektroměr</h3><button class="x" aria-label="Zavřít" data-act="close">${ICON.close}</button></div>`
      + `<div class="seg" role="tablist" aria-label="Akce">${tabs}</div>${form}<div class="prev">${this._meterPreview()}</div>`
      + `<div class="ok">${ICON.check}<span>Statistiky spotřeby se nezmění. Přírůstky se počítají jen ze Shelly, takže kalibrace ani výměna nevyrobí skok.</span></div>`
      + `<button class="cta" data-act="save"></button><div class="hist"><div class="lbl" style="margin-bottom:6px">Historie</div><div class="hrows">${this._history()}</div></div></div>`;
    this._updateSaveBtn();
  }

  // While open: "Stav v HA teď" and the history follow hass (the form inputs stay untouched).
  _refreshMeter() {
    for (const [sel, html] of [['.prev', this._meterPreview()], ['.hrows', this._history()]]) {
      const el = this._meterDlg.querySelector(sel);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    }
  }

  _meterPreview() {
    const m = this._meter;
    const regs = this._twoTariffs() ? [['vt', ' VT', this._cfg.meter_vt], ['nt', ' NT', this._cfg.meter_nt]] : [['vt', '', this._cfg.meter_vt]];
    const kwh = (v) => (Number.isFinite(v) ? `${fmt(v, 1)} kWh` : '–');
    const diff = (a, b) => (Number.isFinite(a) && b != null ? `${a - b >= 0 ? '+' : ''}${fmt(a - b, 1)} kWh` : '–');
    const row = (l, v, strong) => `<div><span class="muted">${l}</span><span${strong ? ' style="font-weight:500"' : ''}>${v}</span></div>`;
    return regs.map(([f, sfx, id]) => {
      const now = this._num(id);
      if (m.mode === 'align') return row(`Stav v HA teď${sfx}`, kwh(now ?? NaN)) + row(`Změna stavu v HA${sfx}`, diff(parseNum(m[f]), now), true);
      const old = parseNum(m['old_' + f]);
      return row(`Elektroměr v HA po uložení${sfx}`, kwh(parseNum(m[f])), true)
        + row(`Starý elektroměr vs HA${sfx}`, Number.isFinite(old) ? diff(old, now) : 'nevyplněno');
    }).join('');
  }

  // Service data for meter_script, or null while the form is incomplete.
  _meterData() {
    const m = this._meter;
    const two = this._twoTariffs();
    const ok = (v) => Number.isFinite(v) && v >= 0;
    const data = { kind: m.mode, vt: parseNum(m.vt) };
    if (two) data.nt = parseNum(m.nt);
    if (!ok(data.vt) || (two && !ok(data.nt))) return null;
    if (m.mode === 'replace') {
      for (const f of two ? ['old_vt', 'old_nt'] : ['old_vt']) {
        if (String(m[f]).trim() === '') continue;
        const v = parseNum(m[f]);
        if (!ok(v)) return null;
        data[f] = v;
      }
      if (m.date) data.date = m.date;
    }
    return data;
  }

  _updateSaveBtn() {
    const b = this.shadowRoot.querySelector('[data-act="save"]');
    const m = this._meter;
    b.disabled = !this._meterData() || m.saved || m.saving;
    b.textContent = m.error || (m.saving ? 'Ukládám…' : m.saved ? 'Uloženo' : m.mode === 'align' ? 'Uložit stav' : 'Uložit výměnu');
  }

  async _save() {
    const m = this._meter;
    const data = this._meterData();
    if (!data || m.saving) return;
    m.saving = true; // one call per click: the button is disabled until the script answers
    this._updateSaveBtn();
    try {
      await this._hass.callService('script', this._cfg.meter_script.replace(/^script\./, ''), data);
      m.saved = true;
    } catch (e) {
      m.error = `Chyba: ${e?.message || e}`;
    }
    m.saving = false;
    if (this._meter === m) { this._updateSaveBtn(); this._refreshMeter(); }
  }

  _history() {
    const raw = this._hass.states[this._cfg.meter_history]?.attributes?.entries;
    const entries = Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];
    if (!entries.length) return '<div class="row"><span></span><span class="muted">Zatím žádné záznamy</span></div>';
    const v = (x) => fmt(Number(x), 1);
    return [...entries].reverse().map((e) => {
      const t = new Date(e.time);
      const val = e.nt != null ? `VT ${v(e.vt)} · NT ${v(e.nt)}` : v(e.vt);
      return `<div class="row"><span>${Number.isNaN(+t) ? '' : czDate(t)}</span><span>${e.kind === 'replace' ? 'Výměna elektroměru' : 'Srovnání se stavem'}</span><span class="muted">${esc(val)} kWh</span></div>`;
    }).join('');
  }
}

if (globalThis.customElements && !customElements.get('energy-card')) {
  customElements.define('energy-card', EnergyCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'energy-card', name: 'Energy Card', description: 'Electricity: consumption and cost by VT/NT price lists, comparisons, meter reading.' });
  console.info(`%c ENERGY-CARD %c ${VERSION} `, 'color:#fff;background:#0288d1', '');
}

export { EnergyCard, VERSION };
