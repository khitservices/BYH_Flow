// lib/consult.js — the step from enquiry to client: booking the initial consultation (IC).
// Booking the IC makes the person a CLIENT at once (status 'consultation'), invites them to their client area, and emails
// the booking with a calendar file. Shared by the enquiry pages and the client record.
const { q, one } = require('./db');
const mail = require('./mail');
const brand = require('./brand');
const ics = require('./ics');
const T = require('./time');
const { audit } = require('./audit');

const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
// Who the booking emails go to: the person, or for a child the parent or guardian.
const addressee = c => ({ to: c.under16 ? (c.guardian_email || c.email) : c.email, name: c.under16 ? (c.guardian_name || c.name) : c.name });

async function sendInvite(client, therapistName) {
  try {
    await mail.sendMail(client.email, `Your client area with ${brand.BRAND.practiceName}`, mail.clientInviteEmail(client.name, therapistName, `${process.env.BASE_URL}/`));
    await q(`UPDATE clinical.clients SET invited_at=now() WHERE id=$1`, [client.id]);
    return true;
  } catch (e) { console.error('[clients] invite failed:', e.message); return false; }
}

// kind: booked | moved | cancelled. Returns true if an email went.
async function notifyConsultation(c, kind) {
  const { to, name } = addressee(c);
  if (!to || !c.ic_at) return false;
  try {
    const m = await mail.getSettings(), cancel = kind === 'cancelled';
    const a = { id: c.id, uid_kind: 'consultation', starts_at: c.ic_at, duration_min: 60, ics_sequence: c.ic_sequence };
    const content = ics.calendar(cancel ? 'CANCEL' : 'REQUEST', [ics.vevent(a, {
      title: `${brand.BRAND.practiceName} initial consultation`, cancelled: cancel,
      organizer: m.from_address ? { name: m.from_name || brand.BRAND.practiceName, email: m.from_address } : null, attendee: { name, email: to } })]);
    const when = T.when(c.ic_at), th = await one(`SELECT name FROM core.staff WHERE id=$1`, [c.therapist_id]);
    await mail.sendMail(to, cancel ? 'Consultation cancelled' : 'Your initial consultation',
      cancel ? mail.consultationCancelledEmail(name, when) : mail.consultationEmail(name, when, kind === 'moved', th.name), null, { icalEvent: { method: cancel ? 'CANCEL' : 'REQUEST', content } });
    return true;
  } catch (err) { console.error('[consult] email failed:', err.message); return false; }
}

// Turn an enquiry into a client by booking the consultation. Throws an Error with .code: email | taken | archived.
async function bookFromEnquiry({ req, me, enquiry: e, at }) {
  const email = (e.for_child ? (e.email || e.guardian_email) : e.email || '').toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw Object.assign(new Error('email'), { code: 'email' });
  const existing = await one(`SELECT id, therapist_id, archived_at FROM clinical.clients WHERE lower(email)=$1`, [email]);
  if (existing) throw Object.assign(new Error('taken'), { code: existing.therapist_id === me.id && existing.archived_at ? 'archived' : 'taken' });
  const [c] = await q(`INSERT INTO clinical.clients (therapist_id, name, email, phone, under16, guardian_name, guardian_email, guardian_phone, consent_status,
      status, ic_at, channel, address, enquiry_date, programme_sessions)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'consultation',$10,$11,$12,$13,NULL) RETURNING *`,
    [me.id, e.name, email, e.phone, e.for_child, e.for_child ? e.guardian_name : null, e.for_child ? e.guardian_email : null, e.for_child ? e.guardian_phone : null,
     e.for_child ? 'pending' : 'n/a', at, e.channel, e.address, e.enquiry_date]);
  await q(`UPDATE clinical.enquiries SET stage='converted', converted_client_id=$2, ic_at=$3, last_activity_at=now() WHERE id=$1`, [e.id, c.id, at]);
  await q(`UPDATE documents.forms SET client_id=$2 WHERE enquiry_id=$1`, [e.id, c.id]);
  const who = { actorType: 'staff', actorId: me.id, subjectType: 'client', subjectId: c.id };
  await audit(req, 'client.created', { ...who, detail: { from: 'enquiry', under16: e.for_child } });
  await audit(req, 'enquiry.converted', { ...who, subjectType: 'enquiry', subjectId: e.id });
  const invited = await sendInvite(c, me.name);
  const emailed = at > new Date() ? await notifyConsultation(c, 'booked') : false;
  return { client: c, invited, emailed };
}

module.exports = { EMAIL_RE, addressee, sendInvite, notifyConsultation, bookFromEnquiry };
