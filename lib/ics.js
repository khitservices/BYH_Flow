// lib/ics.js — calendar files (iCalendar). Used for the file attached to appointment emails, the
// single-appointment download, and the therapist's private calendar feed. No Microsoft Graph involved.
const { BRAND } = require('./brand');

const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
const host = () => { try { return new URL(process.env.BASE_URL).host; } catch { return 'practice.local'; } };
const uid = (apptId, kind = 'appointment') => `${kind}-${apptId}@${host()}`;
// Lines longer than 75 bytes must be folded.
const fold = line => line.replace(/(.{70})(?=.)/g, '$1\r\n ');

function vevent(a, { title, cancelled, organizer, attendee }) {
  const end = new Date(new Date(a.starts_at).getTime() + (a.duration_min || 60) * 60000);
  return [
    'BEGIN:VEVENT', `UID:${uid(a.id, a.uid_kind)}`, `SEQUENCE:${a.ics_sequence || 0}`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(a.starts_at)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(title)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    organizer ? `ORGANIZER;CN=${esc(organizer.name)}:mailto:${organizer.email}` : null,
    attendee ? `ATTENDEE;CN=${esc(attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${attendee.email}` : null,
    'END:VEVENT',
  ].filter(Boolean);
}

function calendar(method, events, name) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${esc(BRAND.practiceName)}//Appointments//EN`, 'CALSCALE:GREGORIAN',
    `METHOD:${method}`, name ? `X-WR-CALNAME:${esc(name)}` : null, ...events.flat(), 'END:VCALENDAR']
    .filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

module.exports = { vevent, calendar, uid };
