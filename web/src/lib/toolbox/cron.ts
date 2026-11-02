/** Five-field cron (minute hour day-of-month month day-of-week) with names, ranges, steps and @macros. */

export interface CronField { values: Set<number>; any: boolean }
export interface CronSchedule { minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField; source: string }

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const SPEC = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
] as const;

function parseField(src: string, i: number): CronField {
  const spec = SPEC[i];
  const values = new Set<number>();
  const num = (t: string) => {
    const up = t.toUpperCase();
    if ('names' in spec) { const k = (spec.names as readonly string[]).indexOf(up); if (k >= 0) return k + spec.base; }
    if (!/^\d+$/.test(t)) throw new Error(`Bad ${spec.name} value "${t}"`);
    const n = Number(t);
    if (n < spec.min || n > spec.max) throw new Error(`${spec.name} ${n} is out of range ${spec.min}-${spec.max}`);
    return n;
  };
  const any = src === '*' || src === '?';
  for (const part of src.split(',')) {
    if (!part) throw new Error(`Empty item in ${spec.name}`);
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step "${stepStr}" in ${spec.name}`);
    let lo: number, hi: number;
    if (range === '*' || range === '?') { lo = spec.min; hi = i === 4 ? 6 : spec.max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = num(a); hi = num(b); if (lo > hi) throw new Error(`Range ${range} runs backwards in ${spec.name}`); }
    else { lo = num(range); hi = stepStr === undefined ? lo : (i === 4 ? 6 : spec.max); }
    for (let v = lo; v <= hi; v += step) values.add(i === 4 && v === 7 ? 0 : v);
  }
  return { values, any: any };
}

export function parseCron(expr: string): CronSchedule {
  const src = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 6) throw new Error('Six fields: seconds (Quartz/Spring style) are not supported; drop the first field');
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields, got ${parts.length}`);
  if (/[LW#]/i.test(src.replace(/[A-Z]{3}/gi, ''))) throw new Error('L, W and # (Quartz extensions) are not supported');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, i));
  return { minute, hour, dom, month, dow, source: src };
}

/** Day matches per POSIX cron: when both day fields are restricted, either may match. */
function dayMatches(s: CronSchedule, dom: number, dow: number): boolean {
  if (s.dom.any && s.dow.any) return true;
  if (s.dom.any) return s.dow.values.has(dow);
  if (s.dow.any) return s.dom.values.has(dom);
  return s.dom.values.has(dom) || s.dow.values.has(dow);
}

/** The next `count` run times after `from` (ms), in local time or UTC. */
export function nextRuns(s: CronSchedule, count: number, from = Date.now(), utc = false): Date[] {
  const d = new Date(from);
  const get = {
    Y: () => (utc ? d.getUTCFullYear() : d.getFullYear()), M: () => (utc ? d.getUTCMonth() : d.getMonth()), D: () => (utc ? d.getUTCDate() : d.getDate()),
    W: () => (utc ? d.getUTCDay() : d.getDay()), h: () => (utc ? d.getUTCHours() : d.getHours()), m: () => (utc ? d.getUTCMinutes() : d.getMinutes()),
  };
  const set = (Y: number, M: number, D: number, h: number, m: number) => { if (utc) d.setTime(Date.UTC(Y, M, D, h, m)); else d.setTime(new Date(Y, M, D, h, m).getTime()); };
  set(get.Y(), get.M(), get.D(), get.h(), get.m() + 1);
  const out: Date[] = [];
  for (let guard = 0; out.length < count && guard < 200000; guard++) {
    if (!s.month.values.has(get.M() + 1)) { set(get.Y(), get.M() + 1, 1, 0, 0); continue; }
    if (!dayMatches(s, get.D(), get.W())) { set(get.Y(), get.M(), get.D() + 1, 0, 0); continue; }
    if (!s.hour.values.has(get.h())) { set(get.Y(), get.M(), get.D(), get.h() + 1, 0); continue; }
    if (!s.minute.values.has(get.m())) { set(get.Y(), get.M(), get.D(), get.h(), get.m() + 1); continue; }
    out.push(new Date(d.getTime()));
    set(get.Y(), get.M(), get.D(), get.h(), get.m() + 1);
  }
  return out;
}

/** Compact list form of a field for the breakdown table: "0,15,30,45" or "every value". */
export function fieldSummary(f: CronField, i: number): string {
  const all = [...f.values].sort((a, b) => a - b);
  const span = i === 4 ? 7 : SPEC[i].max - SPEC[i].min + 1;
  if (all.length === span) return '*';
  const label = (v: number) => (i === 3 ? MONTHS[v - 1] : i === 4 ? DAYS[v] : String(v));
  return all.map(label).join(', ');
}

export const CRON_FIELD_NAMES = SPEC.map((s) => s.name);

export const CRON_PRESETS: { expr: string; key: string }[] = [
  { expr: '*/5 * * * *', key: 'every5' },
  { expr: '0 * * * *', key: 'hourly' },
  { expr: '0 9 * * *', key: 'daily9' },
  { expr: '0 9 * * 1-5', key: 'weekdays9' },
  { expr: '30 18 * * 5', key: 'friday' },
  { expr: '0 0 1 * *', key: 'monthly' },
  { expr: '0 3 * * 0', key: 'sunday3' },
  { expr: '0 */6 * * *', key: 'every6h' },
];

/** Shape of a field's values: everything, "every n" (written with a slash), one contiguous range, or a list. */
type Shape = { kind: 'any' } | { kind: 'step'; n: number } | { kind: 'range'; from: number; to: number } | { kind: 'list'; values: number[] };

function shape(f: CronField, src: string, min: number, max: number): Shape {
  const v = [...f.values].sort((a, b) => a - b);
  if (f.any || v.length === max - min + 1) return { kind: 'any' };
  if (src.includes('/') && v.length >= 2 && v[0] === min) {
    const n = v[1] - v[0];
    if (n > 1 && v.every((x, i) => x === min + i * n) && v[v.length - 1] + n > max) return { kind: 'step', n };
  }
  if (v.length >= 2 && v[v.length - 1] - v[0] === v.length - 1) return { kind: 'range', from: v[0], to: v[v.length - 1] };
  return { kind: 'list', values: v };
}

const KO_DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');
const sorted = (f: CronField) => [...f.values].sort((a, b) => a - b);

/**
 * Plain-language reading of a schedule, in Korean or English. Written here rather than taken from a library
 * because the day-of-month / day-of-week rule (either matches when both are set) and month restrictions need
 * natural word order in both languages.
 */
export function describeCron(s: CronSchedule, lang: 'ko' | 'en'): string {
  const ko = lang === 'ko';
  const src = s.source.split(/\s+/);
  const minute = shape(s.minute, src[0], 0, 59);
  const hour = shape(s.hour, src[1], 0, 23);
  const dom = shape(s.dom, src[2], 1, 31);
  const month = shape(s.month, src[3], 1, 12);
  const dow = shape(s.dow, src[4], 0, 6);
  const short = (v: number) => (ko ? KO_DAYS[v] : EN_DAYS[v].slice(0, 3));

  // Days of the week: "월~금" / "Mon–Fri", "월, 수, 금요일" / "Mon, Wed, Fri", "월요일" / "Monday".
  const dowText = (() => {
    if (dow.kind === 'any') return '';
    if (dow.kind === 'range') return `${short(dow.from)}${ko ? '~' : '–'}${short(dow.to)}`;
    const v = sorted(s.dow);
    if (v.length === 1) return ko ? `${KO_DAYS[v[0]]}요일` : EN_DAYS[v[0]];
    return ko ? `${v.map(short).join(', ')}요일` : v.map(short).join(', ');
  })();
  // Months: "11월" / "November", "3~5월" / "Mar–May", "1, 4, 7월" / "Jan, Apr, Jul".
  const monthText = (() => {
    if (month.kind === 'any') return '';
    const m = (v: number) => (ko ? String(v) : EN_MONTHS[v - 1].slice(0, 3));
    if (month.kind === 'range') return ko ? `${m(month.from)}~${m(month.to)}월` : `${m(month.from)}–${m(month.to)}`;
    const v = sorted(s.month);
    if (v.length === 1) return ko ? `${v[0]}월` : EN_MONTHS[v[0] - 1];
    return ko ? `${v.join(', ')}월` : v.map(m).join(', ');
  })();
  // Days of the month: "3일" / "day 3", "1~5일" / "days 1–5", "1, 15일" / "days 1, 15".
  const domDays = sorted(s.dom);
  const domText = (() => {
    if (dom.kind === 'any') return '';
    if (dom.kind === 'step') return ko ? `${dom.n}일마다` : `every ${dom.n} days`;
    if (dom.kind === 'range') return ko ? `${dom.from}~${dom.to}일` : `days ${dom.from}–${dom.to}`;
    return ko ? `${domDays.join(', ')}일` : domDays.length === 1 ? `day ${domDays[0]}` : `days ${domDays.join(', ')}`;
  })();

  // The day part. Both day fields set means either matches (POSIX cron), so "A or B".
  const allDays = !domText && !dowText && !monthText;
  const day = (() => {
    if (!domText && !dowText) return monthText ? (ko ? `${monthText} 매일` : `every day in ${monthText}`) : (ko ? '매일' : 'every day');
    const domPart = domText && (ko
      ? `${monthText || '매월'} ${domText}`
      : !monthText ? `${domText} of every month` : domDays.length === 1 && dom.kind === 'list' ? `${monthText} ${domDays[0]}` : `${domText} of ${monthText}`);
    const dowPart = dowText && (ko ? (monthText ? `${monthText}의 매주 ${dowText}` : `매주 ${dowText}`) : monthText ? `every ${dowText} in ${monthText}` : `every ${dowText}`);
    if (domPart && dowPart) return ko ? `${domPart} 또는 ${dowPart}` : `${domPart} or ${dowPart}`;
    return domPart || dowPart;
  })();

  // The time part: clock times ("09:00 · 18:30"), or a repeat ("every 15 minutes", "every hour at :30")
  // that may be limited to some hours.
  const mins = sorted(s.minute);
  const hours = sorted(s.hour);
  const minuteList = ko ? (mins.length === 1 && mins[0] === 0 ? '정각' : mins.map((m) => `${m}분`).join(', ')) : mins.map((m) => `:${pad(m)}`).join(', ');
  const hourWindow = (() => {
    if (hour.kind === 'any') return '';
    if (hour.kind === 'range') return ko ? `${pad(hour.from)}:00~${pad(hour.to)}:59 사이` : `between ${pad(hour.from)}:00 and ${pad(hour.to)}:59`;
    return ko ? `${hours.join(', ')}시에` : `during hours ${hours.join(', ')}`;
  })();
  // Clock times need listed minutes and listed (or contiguous) hours, few enough to spell out.
  const fixed = minute.kind === 'list' && (hour.kind === 'list' || hour.kind === 'range') && hours.length * mins.length <= 8;
  const time = (() => {
    if (fixed) return hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`)).join(ko ? ' · ' : ', ');
    if (minute.kind === 'list') {
      if (hour.kind === 'any') return ko ? `매시 ${minuteList}` : `every hour at ${minuteList}`;
      if (hour.kind === 'step') return ko ? `${hour.n}시간마다 ${minuteList}` : `every ${hour.n} hours at ${minuteList}`;
      if (hour.kind === 'range') return ko ? `${hour.from}~${hour.to}시 매시 ${minuteList}` : `every hour from ${pad(hour.from)}:00 to ${pad(hour.to)}:00 at ${minuteList}`;
      return ko ? `${hourWindow} ${minuteList}` : `at ${minuteList} ${hourWindow}`;
    }
    const every = minute.kind === 'step' ? (ko ? `${minute.n}분마다` : `every ${minute.n} minutes`)
      : minute.kind === 'range' ? (ko ? `${minute.from}~${minute.to}분 매분` : `every minute from :${pad(minute.from)} to :${pad(minute.to)}`)
      : (ko ? '매분' : 'every minute');
    if (hour.kind === 'step') return ko ? `${hour.n}시간마다 ${every}` : `${every} every ${hour.n} hours`;
    return hourWindow ? (ko ? `${hourWindow} ${every}` : `${every} ${hourWindow}`) : every;
  })();

  if (ko) return allDays && !fixed ? time : `${day} ${time}`;
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  if (allDays && !fixed) return cap(time);
  return fixed ? `${cap(day)} at ${time}` : `${cap(time)}, ${day}`;
}
