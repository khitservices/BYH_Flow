// routes/enquiries.js — the enquiry pipeline. Two halves:
//  • PUBLIC (no sign-in): the enquiry form, either the practice's (asks which therapist) or one therapist's own page.
//  • THERAPIST (requireRole): their own enquiries only — "AND therapist_id = signed-in therapist" on every query — so a
//    practice manager account gets 403 and another therapist's enquiry is simply not found.
// The form collects name and contact only. It never asks why the person is enquiring (that is health information).
const express = require('express');
const crypto = require('node:crypto');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const brand = require('../lib/brand');
const ics = require('../lib/ics');
const T = require('../lib/time');
const { limited } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const V = require('../views/pages');

const router = express.Router();
const th = A.requireRole('therapist', '/staff', V.forbidden);
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const text = (v, max = 100) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const PUBLIC_SRC = ['website', 'google', 'facebook'];

async function slugFor(staffId) {
  const r = await one(`SELECT enquiry_slug FROM core.staff WHERE id=$1`, [staffId]);
  if (r && r.enquiry_slug) return r.enquiry_slug;
  const slug = crypto.randomBytes(6).toString('hex');
  await q(`UPDATE core.staff SET enquiry_slug=$2 WHERE id=$1 AND enquiry_slug IS NULL`, [staffId, slug]);
  return (await one(`SELECT enquiry_slug FROM core.staff WHERE id=$1`, [staffId])).enquiry_slug;
}
const activeTherapists = () => q(`SELECT id, name FROM core.staff WHERE role='therapist' AND status='active' ORDER BY lower(name)`);

// ---------- public ----------
router.get('/enquire', async (req, res) => {
  const list = await activeTherapists();
  res.send(V.enquireForm({ therapists: list, src: PUBLIC_SRC.includes(req.query.src) ? req.query.src : 'website', pick: list.length === 1 ? list[0].id : null }));
});
router.get('/enquire/thanks', (_req, res) => res.send(V.enquireThanks()));
router.get('/enquire/t/:slug', async (req, res) => {
  const t = await one(`SELECT id, name FROM core.staff WHERE enquiry_slug=$1 AND role='therapist' AND status='active'`, [String(req.params.slug)]);
  if (!t) return res.status(404).send(V.forbidden());
  res.send(V.enquireForm({ therapist: t, slug: req.params.slug, src: PUBLIC_SRC.includes(req.query.src) ? req.query.src : 'therapist_page' }));
});

router.post('/enquire', async (req, res) => {
  const b = req.body;
  if (b.company) return res.redirect('/enquire/thanks');                       // hidden field only a bot fills in
  const therapist = b.slug
    ? await one(`SELECT id, name FROM core.staff WHERE enquiry_slug=$1 AND role='therapist' AND status='active'`, [String(b.slug)])
    : await one(`SELECT id, name FROM core.staff WHERE id=$1 AND role='therapist' AND status='active'`, [Number(b.therapist) || 0]);
  const src = b.slug ? (PUBLIC_SRC.includes(b.src) ? b.src : 'therapist_page') : (PUBLIC_SRC.includes(b.src) ? b.src : 'website');
  const f = { name: text(b.name), email: String(b.email || '').trim().toLowerCase().slice(0, 254), phone: text(b.phone, 40), for_child: b.for_child === 'on', child_name: text(b.child_name) };
  const again = async msg => res.status(400).send(V.enquireForm({ therapists: b.slug ? null : await activeTherapists(), therapist: b.slug ? therapist : null, slug: b.slug, src, pick: therapist && therapist.id, f, error: msg }));
  if (!therapist) return again('Please choose who you would like to hear from.');
  if (!f.name) return again('Please enter your name.');
  if (!f.email && !f.phone) return again('Please give an email address or a phone number so we can reply.');
  if (f.email && !EMAIL_RE.test(f.email)) return again('That email address does not look right.');
  if (f.for_child && !f.child_name) return again("Please enter the child's name.");
  // Limit counts accepted enquiries only, so a typo in the form never locks anyone out.
  if (limited(`enquire:${req.ip}`, 5, 3600000)) return res.status(429).send(V.enquireThanks('Too many enquiries from this connection. Please try again later.'));
  const [e] = await q(`INSERT INTO clinical.enquiries (therapist_id, channel, for_child, name, child_name, email, phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [therapist.id, src, f.for_child, f.name, f.for_child ? f.child_name : null, f.email || null, f.phone || null]);
  await audit(req, 'enquiry.received', { actorType: 'public', subjectType: 'enquiry', subjectId: e.id, detail: { channel: src } });
  try {
    const t = await one(`SELECT name, email FROM core.staff WHERE id=$1`, [therapist.id]);
    await mail.sendMail(t.email, 'New enquiry', mail.newEnquiryEmail(t.name, `${process.env.BASE_URL}/staff`)); // no personal details in the email
  } catch (err) { console.error('[enquiries] notify failed:', err.message); }
  res.redirect('/enquire/thanks');
});

// ---------- therapist ----------
const own = req => one(`SELECT * FROM clinical.enquiries WHERE id=$1 AND therapist_id=$2`, [Number(req.params.id) || 0, req.session.staff.id]);
const MSG = {
  added: ['Enquiry added.', true], saved: ['Saved.', true], contact: ['Add an email address or a phone number.', false], name: ['Enter a name.', false], email: ['That email address does not look right.', false],
  consult_set: ['Consultation set. They have been emailed the date and a calendar file.', true], consult_set_nomail: ['Consultation set. No email was sent (no email address on the enquiry, or it could not be sent).', true],
  consult_cleared: ['Consultation removed.', true], date: ['Enter a real date and time.', false], deleted: ['Enquiry deleted.', true],
};

async function tellConsultation(e, kind) { // kind: booked | moved | cancelled. Returns true if an email went.
  if (!e.email || !e.ic_at) return false;
  try {
    const m = await mail.getSettings(), cancel = kind === 'cancelled';
    const a = { id: e.id, uid_kind: 'consultation', starts_at: e.ic_at, duration_min: 60, ics_sequence: e.ic_sequence };
    const content = ics.calendar(cancel ? 'CANCEL' : 'REQUEST', [ics.vevent(a, {
      title: `${brand.BRAND.practiceName} initial consultation`, cancelled: cancel,
      organizer: m.from_address ? { name: m.from_name || brand.BRAND.practiceName, email: m.from_address } : null, attendee: { name: e.name, email: e.email } })]);
    const when = T.when(e.ic_at);
    await mail.sendMail(e.email, cancel ? 'Consultation cancelled' : 'Your initial consultation',
      cancel ? mail.consultationCancelledEmail(e.name, when) : mail.consultationEmail(e.name, when, kind === 'moved'), null, { icalEvent: { method: cancel ? 'CANCEL' : 'REQUEST', content } });
    return true;
  } catch (err) { console.error('[enquiries] consultation email failed:', err.message); return false; }
}

router.get('/therapist/enquiries', th, async (req, res) => {
  const me = req.session.staff, slug = await slugFor(me.id), base = process.env.BASE_URL || '';
  const rows = await q(`SELECT * FROM clinical.enquiries WHERE therapist_id=$1 ORDER BY (stage IN ('not_proceeding','converted')), created_at DESC`, [me.id]);
  const [msg, ok] = MSG[String(req.query.msg || '')] || [];
  res.status(ok === false ? 400 : 200).send(V.therapistEnquiries(rows.map(e => ({ ...e, ic_text: e.ic_at ? T.when(e.ic_at) : null })), { mine: `${base}/enquire/t/${slug}`, practice: `${base}/enquire` }, msg, ok));
});

router.post('/therapist/enquiries/add', th, async (req, res) => {
  const me = req.session.staff, b = req.body;
  const name = text(b.name), email = String(b.email || '').trim().toLowerCase().slice(0, 254), phone = text(b.phone, 40), forChild = b.for_child === 'on';
  if (!name) return res.redirect('/therapist/enquiries?msg=name');
  if (!email && !phone) return res.redirect('/therapist/enquiries?msg=contact');
  if (email && !EMAIL_RE.test(email)) return res.redirect('/therapist/enquiries?msg=email');
  const [e] = await q(`INSERT INTO clinical.enquiries (therapist_id, channel, for_child, name, child_name, email, phone, notes) VALUES ($1,'phone',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [me.id, forChild, name, forChild ? text(b.child_name) || null : null, email || null, phone || null, text(b.notes, 1000) || null]);
  await audit(req, 'enquiry.added', { actorType: 'staff', actorId: me.id, subjectType: 'enquiry', subjectId: e.id, detail: { channel: 'phone' } });
  res.redirect('/therapist/enquiries?msg=added');
});

router.post('/therapist/enquiries/:id', th, async (req, res) => {
  const me = req.session.staff, e = await own(req);
  if (!e) return res.status(404).send(V.forbidden());
  const done = msg => res.redirect(`/therapist/enquiries?msg=${msg}`), b = req.body, action = String(b.action || '');
  const log = (what, detail) => audit(req, what, { actorType: 'staff', actorId: me.id, subjectType: 'enquiry', subjectId: e.id, detail });
  if (e.stage === 'converted' && action !== 'delete') return done('saved');
  if (action === 'notes') { await q(`UPDATE clinical.enquiries SET notes=$2 WHERE id=$1`, [e.id, text(b.notes, 1000) || null]); return done('saved'); }
  if (action === 'consult') {
    const at = T.fromLocal(b.date, b.time);
    if (!at) return done('date');
    const moved = !!e.ic_at;
    const [n] = await q(`UPDATE clinical.enquiries SET ic_at=$2, ic_sequence=ic_sequence+$3, stage='consultation' WHERE id=$1 RETURNING *`, [e.id, at, moved ? 1 : 0]);
    await log('enquiry.consultation_set');
    return done(at > new Date() && await tellConsultation(n, moved ? 'moved' : 'booked') ? 'consult_set' : 'consult_set_nomail');
  }
  if (action === 'clear_consult') {
    if (e.ic_at && e.ic_at > new Date()) await tellConsultation({ ...e, ic_sequence: e.ic_sequence + 1 }, 'cancelled');
    await q(`UPDATE clinical.enquiries SET ic_at=NULL, ic_sequence=ic_sequence+1, stage=CASE WHEN stage='consultation' THEN 'new' ELSE stage END WHERE id=$1`, [e.id]);
    await log('enquiry.consultation_cleared'); return done('consult_cleared');
  }
  if (['proceeding', 'not_proceeding', 'new'].includes(action)) {
    if (action === 'not_proceeding' && e.ic_at && e.ic_at > new Date()) await tellConsultation({ ...e, ic_sequence: e.ic_sequence + 1 }, 'cancelled');
    await q(`UPDATE clinical.enquiries SET stage=$2, ic_sequence=ic_sequence+1 WHERE id=$1`, [e.id, action === 'new' && e.ic_at ? 'consultation' : action]);
    await log('enquiry.stage', { stage: action }); return done('saved');
  }
  if (action === 'delete') {
    if (e.ic_at && e.ic_at > new Date() && e.stage !== 'converted') await tellConsultation({ ...e, ic_sequence: e.ic_sequence + 1 }, 'cancelled');
    await q(`DELETE FROM clinical.enquiries WHERE id=$1`, [e.id]); await log('enquiry.deleted'); return done('deleted');
  }
  done('saved');
});

module.exports = { router, slugFor };
