// lib/time.js — the practice's local time. Sessions are typed and shown in the practice's own time zone
// (so 10:30 stays 10:30 across the clock change), and stored as exact instants.
// The zone is fixed to UK time for now; it becomes a practice setting when a practice elsewhere needs it.
const ZONE = 'Europe/London';

// How far ahead of UTC the zone is at a given instant, in milliseconds.
function offsetMs(instant, zone = ZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

// '2026-11-20' + '10:30' in the practice's zone -> Date, or null if either part is not a real date/time.
function fromLocal(date, time, zone = ZONE) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '')), t = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || y < 2000 || y > 2100) return null;
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  if (new Date(wall).getUTCDate() !== da) return null; // e.g. 31 February
  let utc = wall - offsetMs(wall, zone);
  utc = wall - offsetMs(utc, zone); // settle either side of a clock change
  return new Date(utc);
}

const part = (d, opts, zone = ZONE) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', ...opts }).format(new Date(d));
const dateLong = d => part(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(',', '');
const timeShort = d => part(d, { hour: '2-digit', minute: '2-digit' });
const when = d => `${dateLong(d)} at ${timeShort(d)}`;
// For <input type="date"> / <input type="time"> values.
const inputDate = d => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };

module.exports = { ZONE, fromLocal, dateLong, timeShort, when, inputDate };
