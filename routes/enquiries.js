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
const { sendForm, activeTemplates } = require('./forms');
const { pence } = require('./programmes');

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
  // The form is filled in by whoever is enquiring. For a child that is the parent or guardian, so their details go in the guardian fields.
  const again = async msg => res.status(400).send(V.enquireForm({ therapists: b.slug ? null : await activeTherapists(), therapist: b.slug ? therapist : null, slug: b.slug, src, pick: therapist && therapist.id, f, error: msg }));
  if (!therapist) return again('Please choose who you would like to hear from.');
  if (!f.name) return again('Please enter your name.');
  if (!f.email && !f.phone) return again('Please give an email address or a phone number so we can reply.');
  if (f.email && !EMAIL_RE.test(f.email)) return again('That email address does not look right.');
  if (f.for_child && !f.child_name) return again("Please enter the child's name.");
  // Limit counts accepted enquiries only, so a typo in the form never locks anyone out.
  if (limited(`enquire:${req.ip}`, 5, 3600000)) return res.status(429).send(V.enquireThanks('Too many enquiries from this connection. Please try again later.'));
  const [e] = await q(`INSERT INTO clinical.enquiries (therapist_id, channel, for_child, name, email, phone, guardian_name, guardian_email, guardian_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    f.for_child ? [therapist.id, src, true, f.child_name, null, null, f.name, f.email || null, f.phone || null]
                : [therapist.id, src, false, f.name, f.email || null, f.phone || null, null, null, null]);
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
  consult_cleared: ['Consultation removed.', true], form_sent: ['Form sent. They have been emailed a link to read and sign it.', true],
  form_notsent: ['The form is ready but the email could not be sent. Use Send again once email is working.', false], form_email: ['Add an email address first (the parent or guardian\'s, for a child).', false],
  form_fee: ['Enter the fee per session, like 60 or 60.50.', false], form_template: ['Choose a form.', false], date: ['Enter a real date and time.', false], deleted: ['Enquiry deleted.', true],
};

async function tellConsultation(e, kind) { // kind: booked | moved | cancelled. Returns true if an email went.
  const to = e.for_child ? (e.guardian_email || e.email) : e.email, who = e.for_child ? (e.guardian_name || e.name) : e.name;
  if (!to || !e.ic_at) return false;
  try {
    const m = await mail.getSettings(), cancel = kind === 'cancelled';
    const a = { id: e.id, uid_kind: 'consultation', starts_at: e.ic_at, duration_min: 60, ics_sequence: e.ic_sequence };
    const content = ics.calendar(cancel ? 'CANCEL' : 'REQUEST', [ics.vevent(a, {
      title: `${brand.BRAND.practiceName} initial consultation`, cancelled: cancel,
      organizer: m.from_address ? { name: m.from_name || brand.BRAND.practiceName, email: m.from_address } : null, attendee: { name: who, email: to } })]);
    const when = T.when(e.ic_at);
    await mail.sendMail(to, cancel ? 'Consultation cancelled' : 'Your initial consultation',
      cancel ? mail.consultationCancelledEmail(who, when) : mail.consultationEmail(who, when, kind === 'moved', (await one(`SELECT name FROM core.staff WHERE id=$1`, [e.therapist_id])).name), null, { icalEvent: { method: cancel ? 'CANCEL' : 'REQUEST', content } });
    return true;
  } catch (err) { console.error('[enquiries] consultation email failed:', err.message); return false; }
}

router.get('/therapist/enquiries', th, async (req, res) => {
  const me = req.session.staff, slug = await slugFor(me.id), base = process.env.BASE_URL || '';
  const rows = await q(`SELECT * FROM clinical.enquiries WHERE therapist_id=$1 ORDER BY (stage IN ('not_proceeding','converted')), created_at DESC`, [me.id]);
  const [msg, ok] = MSG[String(req.query.msg || '')] || [];
  const forms = await q(`SELECT id, enquiry_id, template_name, audience, status, sent_at, signed_at FROM documents.forms WHERE therapist_id=$1 AND enquiry_id IS NOT NULL ORDER BY id`, [me.id]);
  const tpl = await activeTemplates(), mine = await one(`SELECT default_fee_pence FROM core.staff WHERE id=$1`, [me.id]);
  res.status(ok === false ? 400 : 200).send(V.therapistEnquiries(rows.map(e => ({ ...e, ic_text: e.ic_at ? T.when(e.ic_at) : null, forms: forms.filter(f => f.enquiry_id === e.id), templates: tpl.filter(t => t.audience === (e.for_child ? 'child' : 'adult')), fee_pence: mine.default_fee_pence })), { mine: `${base}/enquire/t/${slug}`, practice: `${base}/enquire` }, msg, ok));
});

// The full enquiry form the therapist fills in themselves (from the ITC contact app): adult or child,
// first and last name, contact details, address, enquiry date, optional consultation, parent or guardian for a child.
router.get('/therapist/enquiries/new', th, (_req, res) => res.send(V.enquiryManual({ enquiry_date: T.inputDate(new Date()) })));

router.post('/therapist/enquiries/add', th, async (req, res) => {
  const me = req.session.staff, b = req.body, child = b.type === 'child';
  const f = { type: child ? 'child' : 'adult', first: text(b.first_name), last: text(b.last_name), email: String(b.email || '').trim().toLowerCase().slice(0, 254), phone: text(b.phone, 40),
    address: text(b.address, 300), enquiry_date: text(b.enquiry_date, 10), ic_date: text(b.ic_date, 10), ic_time: text(b.ic_time, 5) || '10:00', notes: text(b.notes, 1000),
    guardian_name: text(b.guardian_name), relationship: text(b.relationship), guardian_email: String(b.guardian_email || '').trim().toLowerCase().slice(0, 254), guardian_phone: text(b.guardian_phone, 40) };
  const again = msg => res.status(400).send(V.enquiryManual(f, msg));
  const name = `${f.first} ${f.last}`.trim();
  if (!f.first || !f.last) return again('Enter a first and last name.');
  if (f.email && !EMAIL_RE.test(f.email)) return again('That email address does not look right.');
  if (f.guardian_email && !EMAIL_RE.test(f.guardian_email)) return again("The parent or guardian's email address does not look right.");
  if (child && !f.guardian_name) return again("Enter the parent or guardian's name.");
  if (!f.email && !f.phone && !(child && (f.guardian_email || f.guardian_phone))) return again('Add an email address or a phone number.');
  const ed = f.enquiry_date && /^\d{4}-\d{2}-\d{2}$/.test(f.enquiry_date) && !isNaN(new Date(f.enquiry_date)) ? f.enquiry_date : T.inputDate(new Date());
  let ic = null;
  if (f.ic_date) { ic = T.fromLocal(f.ic_date, f.ic_time); if (!ic) return again('Enter a real consultation date and time.'); }
  const [e] = await q(`INSERT INTO clinical.enquiries (therapist_id, channel, for_child, name, email, phone, address, enquiry_date, notes, stage, ic_at, guardian_name, relationship, guardian_email, guardian_phone)
    VALUES ($1,'phone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [me.id, child, name, f.email || null, f.phone || null, f.address || null, ed, f.notes || null, ic ? 'consultation' : 'new', ic,
     child ? f.guardian_name : null, child ? f.relationship || null : null, child ? f.guardian_email || null : null, child ? f.guardian_phone || null : null]);
  await audit(req, 'enquiry.added', { actorType: 'staff', actorId: me.id, subjectType: 'enquiry', subjectId: e.id, detail: { channel: 'phone' } });
  if (ic) return res.redirect(`/therapist/enquiries?msg=${ic > new Date() && await tellConsultation(e, 'booked') ? 'consult_set' : 'consult_set_nomail'}`);
  res.redirect('/therapist/enquiries?msg=added');
});

router.post('/therapist/enquiries/:id', th, async (req, res) => {
  const me = req.session.staff, e = await own(req);
  if (!e) return res.status(404).send(V.forbidden());
  const done = msg => res.redirect(`/therapist/enquiries?msg=${msg}`), b = req.body, action = String(b.action || '');
  const log = (what, detail) => audit(req, what, { actorType: 'staff', actorId: me.id, subjectType: 'enquiry', subjectId: e.id, detail });
  if (e.stage === 'converted' && action !== 'delete') return done('saved');
  if (action === 'attended' || action === 'send_form') {
    const fee = pence(b.fee);
    if (fee == null) return done('form_fee');
    try {
      const r = await sendForm({ therapistId: me.id, templateId: b.template, enquiry: e, fee_pence: fee, session_format: b.session_format === 'online' ? 'online' : 'inperson', req });
      if (action === 'attended' || e.stage === 'consultation' || e.stage === 'new') await q(`UPDATE clinical.enquiries SET stage='attended' WHERE id=$1 AND stage IN ('new','consultation')`, [e.id]);
      await log('enquiry.attended', { form: r.id });
      return done(r.sent ? 'form_sent' : 'form_notsent');
    } catch (err) { if (err.code === 'email') return done('form_email'); if (err.code === 'template') return done('form_template'); throw err; }
  }
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
