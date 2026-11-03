// Audited NYSE equity calendar, 2026–2028. Source checked 2026-10-03:
// https://www.nyse.com/trade/hours-calendars
export const CALENDAR_VERSION = 'nyse-2026-2028-v1';
const holidays = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);
const earlyClose = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
const ny = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
// Scheduled occurrence and market date are different identities. Monday and
// exchange holidays use the most recent closed session, never a fabricated day.
export function scheduledReportWindow(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('calendar_unavailable');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  return {date, ready: weekday >= 1 && weekday <= 6 && Number(parts.hour) * 60 + Number(parts.minute) >= 840};
}
export function latestClosedTradingDay(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('calendar_unavailable');
  const parts = Object.fromEntries(ny.formatToParts(now).map(p => [p.type, p.value]));
  let day = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  for (let i = 0; i < 14; i++) {
    const year = Number(day.slice(0, 4));
    if (year < 2026 || year > 2028) throw new Error('calendar_unavailable');
    const date = new Date(day + 'T00:00:00Z');
    const weekday = date.getUTCDay();
    if (weekday > 0 && weekday < 6 && !holidays.has(day) && (i > 0 || minutes >= (earlyClose.has(day) ? 780 : 960))) {
      return {date: day, calendarVersion: CALENDAR_VERSION};
    }
    day = new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
  }
  throw new Error('calendar_unavailable');
}

export function elapsedTradingDays(from: string, to: string) {
  const start = Date.parse(from + 'T00:00Z');
  const end = Date.parse(to + 'T00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end ||
      from < '2026-01-01' || to > '2028-12-31') return null;
  let count = 0;
  for (let time = start + 86400000; time <= end; time += 86400000) {
    const date = new Date(time);
    const weekday = date.getUTCDay();
    if (weekday > 0 && weekday < 6 && !holidays.has(date.toISOString().slice(0, 10))) count++;
  }
  return count;
}
