// routes/sessions.js — booking and schedule for the therapist account. CLINICAL: therapist only, and
// every query is limited to the signed-in therapist's own clients. Carried over from the BYH app
// (book, schedule, add / reschedule / cancel / remove a session), with calendar files in place of
// Microsoft Graph meetings: the client's email carries a calendar file, and the therapist can
// download one or subscribe their own calendar to a private feed.
const express = require('express');
const crypto = require('crypto');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const ics = require('../lib/ics');
const T = require('../lib/time');
const brand = require('../lib/brand');
const { audit } = require('../lib/audit');
const { limited } = require('../lib/ratelimit');
const V = require('../views/pages');

const router = express.Router();
const th = A.requireRole('therapist', '/staff', V.forbidden);
const feedHash = token => crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update('calfeed:' + token).digest('hex');
const ownClient = (req, id) => one(`SELECT * FROM clinical.clients WHERE id=$1 AND therapist_id=$2`, [Number(id) || 0, req.session.staff.id]);
const ownAppt = (req, id) => one(`SELECT a.*, c.name AS client_name, c.email AS client_email, c.status AS client_status
  FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id WHERE a.id=$1 AND c.therapist_id=$2`, [Number(id) || 0, req.session.staff.id]);
// In the therapist's own calendar a session shows as first name and initial, nothing else.
const shortName = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };

// Tell the client by email, with a calendar file. Only for sessions still to come; never blocks the action.
async function notify(appt, client, kind) {
  if (new Date(appt.starts_at) <= new Date() || !['active', 'readonly'].includes(client.status)) return false;
  try {
    const m = await mail.getSettings();
    const cancel = kind === 'cancelled';
    const content = ics.calendar(cancel ? 'CANCEL' : 'REQUEST', [ics.vevent(appt, {
      title: `${brand.BRAND.practiceName} appointment`, cancelled: cancel,
      organizer: m.from_address ? { name: m.from_name || brand.BRAND.practiceName, email: m.from_address } : null,
      attendee: { name: client.name, email: client.email },
    })]);
    const whenText = T.when(appt.starts_at);
    await mail.sendMail(client.email, cancel ? 'Appointment cancelled' : (kind === 'moved' ? 'Your appointment has moved' : 'Your appointment'),
      cancel ? mail.apptCancelledEmail(client.name, whenText) : mail.apptBookedEmail(client.name, whenText, kind === 'moved'),
      null, { icalEvent: { method: cancel ? 'CANCEL' : 'REQUEST', content } });
    return true;
  } catch (e) { console.error('[sessions] email failed:', e.message); return false; }
}

async function book(req, client, date, time) {
  const at = T.fromLocal(date, time);
  if (!at) return { error: 'date' };
  if (client.status !== 'active') return { error: 'inactive' };
  const [a] = await q(`INSERT INTO clinical.appointments (client_id, starts_at) VALUES ($1,$2) RETURNING *`, [client.id, at]);
  await audit(req, 'session.booked', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'client', subjectId: client.id });
  const future = at > new Date();
  return { appt: a, msg: !future ? 'recorded' : ((await notify(a, client, 'booked')) ? 'booked' : 'booked_nomail') };
}

const MSG = {
  booked: ['Session booked. The client has been emailed the date and a calendar file.', true],
  booked_nomail: ['Session booked, but the email to the client could not be sent.', false],
  recorded: ['Past session recorded. No email was sent.', true],
  moved: ['Session moved. The client has been emailed the new date.', true], moved_nomail: ['Session moved, but the email to the client could not be sent.', false],
  cancelled: ['Session cancelled. The client has been told.', true], cancelled_quiet: ['Session cancelled.', true],
  removed: ['Session removed.', true], date: ['Enter a real date and time.', false],
  inactive: ['Sessions can only be booked for a client whose record is active.', false], pick: ['Choose a client.', false],
};
const flash = req => MSG[String(req.query.msg || '')] || [];

// ---- one client's sessions ----
router.get('/therapist/client/:id/sessions', th, async (req, res) => {
  const c = await ownClient(req, req.params.id);
  if (!c) return res.status(404).send(V.forbidden());
  const appts = await q(`SELECT * FROM clinical.appointments WHERE client_id=$1 ORDER BY starts_at`, [c.id]);
  const [msg, ok] = flash(req);
  res.status(ok === false ? 400 : 200).send(V.clientSessions(c, appts, msg, ok));
});

router.post('/therapist/client/:id/sessions', th, async (req, res) => {
  const c = await ownClient(req, req.params.id);
  if (!c) return res.status(404).send(V.forbidden());
  const r = await book(req, c, req.body.date, req.body.time);
  res.redirect(`/therapist/client/${c.id}/sessions?msg=${r.error || r.msg}`);
});

// ---- book from one place ----
router.get('/therapist/book', th, async (req, res) => {
  const active = await q(`SELECT id, name FROM clinical.clients WHERE therapist_id=$1 AND status='active' ORDER BY lower(name)`, [req.session.staff.id]);
  const [msg, ok] = flash(req);
  res.status(ok === false ? 400 : 200).send(V.book(active, msg, ok));
});

router.post('/therapist/book', th, async (req, res) => {
  const c = await ownClient(req, req.body.client_id);
  if (!c) return res.redirect('/therapist/book?msg=pick');
  const r = await book(req, c, req.body.date, req.body.time);
  res.redirect(r.error ? `/therapist/book?msg=${r.error}` : `/therapist/client/${c.id}/sessions?msg=${r.msg}`);
});

// ---- change one session ----
router.post('/therapist/session/:id', th, async (req, res) => {
  const a = await ownAppt(req, req.params.id);
  if (!a) return res.status(404).send(V.forbidden());
  const client = { id: a.client_id, name: a.client_name, email: a.client_email, status: a.client_status };
  const back = msg => res.redirect(`${req.body.return === 'schedule' ? '/therapist/schedule' : `/therapist/client/${a.client_id}/sessions`}?msg=${msg}`);
  const log = (what) => audit(req, what, { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'client', subjectId: a.client_id });
  const action = String(req.body.action || '');

  if (action === 'reschedule') {
    const at = T.fromLocal(req.body.date, req.body.time);
    if (!at) return back('date');
    const [moved] = await q(`UPDATE clinical.appointments SET starts_at=$2, status='booked', cancelled_at=NULL, ics_sequence=ics_sequence+1,
        change_requested_at=NULL, change_request_kind=NULL, change_request_reason=NULL WHERE id=$1 RETURNING *`, [a.id, at]);
    await log('session.moved');
    return back(at <= new Date() ? 'recorded' : ((await notify(moved, client, 'moved')) ? 'moved' : 'moved_nomail'));
  }
  if (action === 'cancel') {
    if (a.status === 'cancelled') return back('cancelled_quiet');
    const [gone] = await q(`UPDATE clinical.appointments SET status='cancelled', cancelled_at=now(), ics_sequence=ics_sequence+1,
        change_requested_at=NULL, change_request_kind=NULL, change_request_reason=NULL WHERE id=$1 RETURNING *`, [a.id]);
    await log('session.cancelled');
    return back((await notify(gone, client, 'cancelled')) ? 'cancelled' : 'cancelled_quiet');
  }
  if (action === 'remove') { // for a session entered by mistake: gone completely, not kept as cancelled
    if (a.status === 'booked') await notify({ ...a, ics_sequence: a.ics_sequence + 1 }, client, 'cancelled');
    await q(`DELETE FROM clinical.appointments WHERE id=$1`, [a.id]);
    await log('session.removed');
    return back('removed');
  }
  back('date');
});

// ---- schedule: the next 60 days across this therapist's clients ----
router.get('/therapist/schedule', th, async (req, res) => {
  const rows = await q(`SELECT a.*, c.name AS client_name, c.under16 FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id
    WHERE c.therapist_id=$1 AND c.status <> 'closed' AND a.status='booked' AND a.starts_at > now() - interval '2 hours'
      AND a.starts_at < now() + interval '60 days' ORDER BY a.starts_at`, [req.session.staff.id]);
  const [msg, ok] = flash(req);
  res.status(ok === false ? 400 : 200).send(V.schedule(rows, { hasFeed: !!req.session.staff.cal_feed_hash }, msg, ok));
});

// Create (or replace) the private calendar link. The link is shown once, here; only its hash is stored.
router.post('/therapist/schedule/feed', th, async (req, res) => {
  const me = req.session.staff;
  if (req.body.action === 'off') {
    await q(`UPDATE core.staff SET cal_feed_hash=NULL WHERE id=$1`, [me.id]);
    await audit(req, 'calendar.feed_removed', { actorType: 'staff', actorId: me.id });
    return res.redirect('/therapist/schedule');
  }
  const token = A.random();
  await q(`UPDATE core.staff SET cal_feed_hash=$2 WHERE id=$1`, [me.id, feedHash(token)]);
  await audit(req, 'calendar.feed_created', { actorType: 'staff', actorId: me.id });
  res.send(V.feedLink(`${process.env.BASE_URL}/cal/${token}.ics`));
});

const sendIcs = (res, name, content) => res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }).send(content);

// One session as a file, for the therapist's own calendar.
router.get('/therapist/session/:id/calendar.ics', th, async (req, res) => {
  const a = await ownAppt(req, req.params.id);
  if (!a) return res.status(404).send(V.forbidden());
  sendIcs(res, 'session.ics', ics.calendar('PUBLISH', [ics.vevent(a, { title: `Session: ${shortName(a.client_name)}`, cancelled: a.status === 'cancelled' })]));
});

// The private feed. No sign-in (calendar apps cannot sign in): the long random link is the key.
// It gives dates, times and "first name + initial" only.
router.get('/cal/:token.ics', async (req, res) => {
  if (limited(`cal|${req.ip}`, 120, 10 * 60 * 1000)) return res.status(429).send('Too many requests');
  const token = String(req.params.token || '');
  const staff = /^[a-f0-9]{64}$/.test(token) && await one(`SELECT id, name FROM core.staff WHERE cal_feed_hash=$1 AND role='therapist' AND status='active'`, [feedHash(token)]);
  if (!staff) return res.status(404).send('Not found');
  const rows = await q(`SELECT a.*, c.name AS client_name FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id
    WHERE c.therapist_id=$1 AND a.status='booked' AND a.starts_at > now() - interval '30 days' ORDER BY a.starts_at`, [staff.id]);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' })
    .send(ics.calendar('PUBLISH', rows.map(a => ics.vevent(a, { title: `Session: ${shortName(a.client_name)}` })), `${brand.BRAND.practiceShort} sessions`));
});

module.exports = { router, book };
