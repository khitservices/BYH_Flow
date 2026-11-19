// lib/reminders.js — the automatic emails: a weekly check-in prompt, appointment reminders, unsigned-form
// reminders and the therapist's morning summary. Run by the hourly sweep. Each email is claimed in
// core.reminder_log before it is sent, so nothing goes twice; a failed send is retried on later sweeps, up to 3 tries.
// Emails carry dates, links and counts only. Never anything about the therapy.
const { q, one } = require('./db');
const mail = require('./mail');
const T = require('./time');
const scores = require('./scores');
const locations = require('./locations');
const base = () => process.env.BASE_URL || '';

const WEEKLY_HOUR = 9, DIGEST_HOUR = 7;
const ukParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: T.ZONE, hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d).map(p => [p.type, p.value]));
const ukHour = d => Number(ukParts(d).hour) % 24;
const ukDow = d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(ukParts(d).weekday);

async function claim(kind, key) {
  const r = await q(`INSERT INTO core.reminder_log (kind, key) VALUES ($1,$2)
    ON CONFLICT (kind, key) DO UPDATE SET attempts = core.reminder_log.attempts + 1 WHERE core.reminder_log.sent_at IS NULL AND core.reminder_log.attempts < 3 RETURNING 1`, [kind, key]);
  return r.length > 0;
}
const sent = (kind, key) => q(`UPDATE core.reminder_log SET sent_at=now() WHERE kind=$1 AND key=$2`, [kind, key]);
async function once(kind, key, send) {
  if (!(await claim(kind, key))) return 0;
  try { await send(); await sent(kind, key); return 1; } catch (e) { console.error(`[reminders] ${kind} ${key}:`, e.message); return 0; }
}
const addressee = c => (c.under16 ? (c.guardian_email || c.email) : c.email);

async function weeklyCheckins(now) {
  if (ukHour(now) < WEEKLY_HOUR) return 0;
  const week = scores.weekStart(now); let n = 0;
  const rows = await q(`SELECT c.* FROM clinical.clients c WHERE c.status='active' AND c.archived_at IS NULL AND c.reminders_on AND c.reminder_dow=$1
      AND NOT EXISTS (SELECT 1 FROM clinical.weekly_scores s WHERE s.client_id=c.id AND s.week_start=$2::date)`, [ukDow(now), week]);
  for (const c of rows) {
    const to = addressee(c); if (!to) continue;
    n += await once('weekly', `${c.id}:${week}`, () => mail.sendFrom(c.therapist_id, to, 'Your weekly check-in', mail.weeklyReminderEmail(c.name, `${base()}/journal/score`, `${base()}/journal/entries`)));
  }
  return n;
}

// Sessions and consultations starting in the next day or so (not within the hour, when it is too late to help).
async function appointmentReminders(now) {
  let n = 0;
  const appts = await q(`SELECT a.*, c.name, c.email, c.under16, c.guardian_email, c.therapist_id FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id
      WHERE a.status='booked' AND c.archived_at IS NULL AND c.status <> 'readonly' AND c.reminders_on AND a.starts_at > $1::timestamptz + interval '1 hour' AND a.starts_at <= $1::timestamptz + interval '25 hours'`, [now]);
  for (const a of appts) {
    const to = addressee(a); if (!to) continue;
    n += await once('appointment', `${a.id}:${a.ics_sequence}`, () => mail.sendFrom(a.therapist_id, to, 'Reminder: your appointment', mail.apptReminderEmail(a.name, T.when(a.starts_at), locations.label(a), a.location_note)));
  }
  const ics = await q(`SELECT * FROM clinical.clients c WHERE c.status IN ('consultation') AND c.archived_at IS NULL AND c.reminders_on AND c.ic_at > $1::timestamptz + interval '1 hour' AND c.ic_at <= $1::timestamptz + interval '25 hours'`, [now]);
  for (const c of ics) {
    const to = addressee(c); if (!to) continue;
    n += await once('consultation', `${c.id}:${c.ic_sequence}`, () => mail.sendFrom(c.therapist_id, to, 'Reminder: your initial consultation', mail.apptReminderEmail(c.name, T.when(c.ic_at), '', null, 'initial consultation')));
  }
  return n;
}

// Unsigned forms: a reminder with a fresh link after 3 days and again after 7. Then it is left to the therapist.
async function formReminders(now) {
  const { reissueLink } = require('../routes/forms'); let n = 0;
  const rows = await q(`SELECT f.id, f.sent_to, f.sent_at, s.name AS therapist, f.therapist_id FROM documents.forms f JOIN core.staff s ON s.id=f.therapist_id
      WHERE f.status='sent' AND f.sent_to IS NOT NULL AND f.sent_at <= $1::timestamptz - interval '3 days'`, [now]);
  for (const f of rows) {
    const days = (new Date(now) - new Date(f.sent_at)) / 86400000, step = days >= 7 ? 2 : 1;
    for (let k = 1; k <= step; k++) {
      n += await once('form', `${f.id}:${k}`, async () => {
        const token = await reissueLink(f.id); if (!token) return;
        await mail.sendFrom(f.therapist_id, f.sent_to, 'Reminder: a form to sign', mail.formReminderEmail(f.therapist, `${base()}/sign/${token}`));
      });
    }
  }
  return n;
}

// The therapist's morning summary, Monday to Friday, only when there is something to say.
async function digests(now) {
  const dow = ukDow(now); if (ukHour(now) < DIGEST_HOUR || dow === 0 || dow === 6) return 0;
  const day = T.inputDate(now); let n = 0;
  for (const t of await q(`SELECT id, name, email FROM core.staff WHERE role='therapist' AND status='active'`)) {
    const d = await one(`SELECT
      (SELECT count(*) FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id WHERE c.therapist_id=$1 AND a.status='booked' AND a.starts_at >= $2::timestamptz AND a.starts_at < $2::timestamptz + interval '1 day')::int
      + (SELECT count(*) FROM clinical.clients c WHERE c.therapist_id=$1 AND c.status='consultation' AND c.archived_at IS NULL AND c.ic_at >= $2::timestamptz AND c.ic_at < $2::timestamptz + interval '1 day')::int AS today,
      (SELECT count(*) FROM clinical.enquiries WHERE therapist_id=$1 AND stage='new' AND archived_at IS NULL)::int AS enquiries,
      (SELECT count(*) FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id WHERE c.therapist_id=$1 AND a.status='booked' AND a.change_requested_at IS NOT NULL AND a.starts_at > $3::timestamptz)::int
      + (SELECT count(*) FROM clinical.clients c WHERE c.therapist_id=$1 AND c.archived_at IS NULL AND c.ic_change_requested_at IS NOT NULL)::int AS changes,
      (SELECT count(*) FROM documents.forms WHERE therapist_id=$1 AND status='sent')::int AS forms,
      (SELECT count(*) FROM clinical.weekly_scores s JOIN clinical.clients c ON c.id=s.client_id WHERE c.therapist_id=$1 AND s.note IS NOT NULL AND s.entered_at > $3::timestamptz - interval '1 day')::int AS notes,
      (SELECT count(*) FROM clinical.data_requests r JOIN clinical.clients c ON c.id=r.client_id WHERE c.therapist_id=$1 AND r.handled_at IS NULL)::int AS requests`,
      [t.id, T.fromLocal(day, '00:00'), now]);
    if (!d.today && !d.enquiries && !d.changes && !d.forms && !d.notes && !d.requests) continue;
    n += await once('digest', `${t.id}:${day}`, () => mail.sendMail(t.email, 'Your day', mail.digestEmail(t.name, d, `${base()}/therapist`)));
  }
  return n;
}

async function run(now = new Date()) {
  const out = { weekly: await weeklyCheckins(now), appointments: await appointmentReminders(now), forms: await formReminders(now), digests: await digests(now) };
  return out;
}
module.exports = { run, ukHour, ukDow };
