// routes/therapist.js — the therapist account's own clients. CLINICAL: every route is behind
// requireRole('therapist'), and every query is limited to the signed-in therapist's own clients,
// so one therapist can never see or change another's, and a practice manager account cannot get here at all.
// Carried over from the BYH app's therapist section (add client, client page, manage programme).
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const brand = require('../lib/brand');
const { audit } = require('../lib/audit');
const V = require('../views/pages');
const T = require('../lib/time');
const { book } = require('./sessions');
const { activeProgrammes, pence } = require('./programmes');
const { sendForm, activeTemplates } = require('./forms');
const consult = require('../lib/consult');
const blocks = require('../lib/blocks');
const archive = require('../lib/archive');

const router = express.Router();
const th = A.requireRole('therapist', '/staff/therapist', V.forbidden);
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const LENGTHS = [6, 8, 10, 12];
const RESUME_DAYS = 28; // reopened within this: same programme carries on; after it: a fresh programme
const text = (v, max = 100) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const norm = e => String(e || '').trim().toLowerCase().slice(0, 254);
const length = (v, fallback) => (LENGTHS.includes(Number(v)) ? Number(v) : fallback);
const dow = v => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 6 ? Number(v) : 3);

// Which session the client is on: sessions had before joining, plus booked sessions already in the past,
// plus one. A missed week does not move it on; only sessions delivered do. Never more than the programme length.
const position = (c, held = 0) => !c.programme_sessions ? null : ({ on: Math.min(c.sessions_before_app + held + 1, c.programme_sessions), of: c.programme_sessions });
const heldCount = async id => (await one(`SELECT count(*)::int n FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id WHERE a.client_id=$1 AND a.block_id IS NOT DISTINCT FROM c.current_block_id AND a.status='booked' AND a.starts_at <= now()`, [id])).n;

// "AND therapist_id" is the access rule: someone else's client is simply not found.
const own = (req) => one(`SELECT * FROM clinical.clients WHERE id=$1 AND therapist_id=$2`, [Number(req.params.id) || 0, req.session.staff.id]);

router.get('/therapist', th, async (req, res) => {
  const me = req.session.staff;
  const today = await q(`SELECT a.starts_at, c.name FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id
    WHERE c.therapist_id=$1 AND a.status='booked' AND a.starts_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
      AND a.starts_at < (date_trunc('day', now() AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2
    UNION ALL SELECT c.ic_at, c.name || ' (consultation)' FROM clinical.clients c
    WHERE c.therapist_id=$1 AND c.status IN ('consultation','attended') AND c.archived_at IS NULL AND c.ic_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
      AND c.ic_at < (date_trunc('day', now() AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2 ORDER BY 1`, [me.id, T.ZONE]);
  const d = await one(`SELECT
      (SELECT count(*) FROM clinical.clients WHERE therapist_id=$1 AND status='active')::int AS active,
      (SELECT count(*) FROM clinical.clients c WHERE c.therapist_id=$1 AND c.status <> 'closed' AND (c.ic_change_requested_at IS NOT NULL OR EXISTS (SELECT 1 FROM clinical.appointments a WHERE a.client_id=c.id AND a.status='booked' AND a.change_requested_at IS NOT NULL AND a.starts_at > now())))::int AS wants_change,
      (SELECT count(*) FROM clinical.enquiries WHERE therapist_id=$1 AND stage='new' AND archived_at IS NULL)::int AS enq_new,
      (SELECT count(*) FROM clinical.clients WHERE therapist_id=$1 AND status IN ('consultation','attended') AND archived_at IS NULL)::int AS consults,
      (SELECT count(*) FROM documents.forms WHERE therapist_id=$1 AND status='sent')::int AS forms_waiting`, [me.id]);
  res.send(V.therapistHome({ who: me.name, today: today.map(a => ({ time: T.timeShort(a.starts_at), name: a.name })),
    clients: { active: d.active, wants_change: d.wants_change, consultations: d.consults }, enquiries: { new: d.enq_new }, forms_waiting: d.forms_waiting }));
});

router.get('/therapist/clients', th, async (req, res) => {
  const rows = await q(`SELECT c.*,
      (SELECT count(*)::int FROM clinical.appointments a WHERE a.client_id=c.id AND a.block_id IS NOT DISTINCT FROM c.current_block_id AND a.status='booked' AND a.starts_at <= now()) AS held,
      (SELECT min(a.starts_at) FROM clinical.appointments a WHERE a.client_id=c.id AND a.status='booked' AND a.starts_at > now()) AS next_at,
      (c.ic_change_requested_at IS NOT NULL OR EXISTS (SELECT 1 FROM clinical.appointments a WHERE a.client_id=c.id AND a.status='booked' AND a.starts_at > now() AND a.change_requested_at IS NOT NULL)) AS wants_change
    FROM clinical.clients c WHERE c.therapist_id=$1 AND c.archived_at IS NULL ORDER BY (c.status='closed'), (c.status IN ('active','readonly')), lower(c.name)`, [req.session.staff.id]);
  res.send(V.clients(rows.map(c => ({ ...c, pos: position(c, c.held), next: c.next_at ? T.when(c.next_at) : null, ic_text: c.ic_at ? T.when(c.ic_at) : null }))));
});

const sendInvite = (client, therapist) => consult.sendInvite(client, therapist.name);

const withProgrammes = async f => ({ ...f, programmes: await activeProgrammes() });

// "Turn into a client" from an enquiry: pre-fills the form. The therapist still checks it and, for a child, records consent.
router.get('/therapist/clients/add', th, async (req, res) => {
  const e = req.query.from ? await one(`SELECT * FROM clinical.enquiries WHERE id=$1 AND therapist_id=$2 AND stage <> 'converted'`, [Number(req.query.from) || 0, req.session.staff.id]) : null;
  if (!e) return res.send(V.clientAdd(await withProgrammes({})));
  res.send(V.clientAdd(await withProgrammes(e.for_child
    ? { from_enquiry: e.id, name: e.name, email: e.email, phone: e.phone, under16: true, guardian_name: e.guardian_name, guardian_email: e.guardian_email, guardian_phone: e.guardian_phone }
    : { from_enquiry: e.id, name: e.name, email: e.email, phone: e.phone })));
});

router.post('/therapist/clients/add', th, async (req, res) => {
  const me = req.session.staff, b = req.body;
  const f = {
    name: text(b.name), email: norm(b.email), phone: text(b.phone, 40), under16: b.under16 === 'on',
    reminder_dow: dow(b.reminder_dow), programme: Number(b.programme) || null,
    guardian_name: text(b.guardian_name), guardian_email: norm(b.guardian_email), guardian_phone: text(b.guardian_phone, 40),
    consent_note: text(b.consent_note, 500), consent_date: text(b.consent_date, 10),
  };
  const prog = await one(`SELECT * FROM core.programmes WHERE id=$1 AND active`, [f.programme || 0]);
  f.sessions = prog ? prog.sessions : 1;
  // Joining part-way through: must leave at least one session to come.
  let prior = Number(b.sessions_before_app);
  if (!Number.isInteger(prior) || prior < 0) prior = 0;
  f.sessions_before_app = Math.min(prior, f.sessions - 1);
  const enq = b.from_enquiry ? await one(`SELECT id FROM clinical.enquiries WHERE id=$1 AND therapist_id=$2 AND stage <> 'converted'`, [Number(b.from_enquiry) || 0, me.id]) : null;
  if (enq) f.from_enquiry = enq.id;
  const again = async msg => res.status(400).send(V.clientAdd(await withProgrammes(f), msg));
  if (!prog) return again('Choose a programme. If none is listed, ask your practice manager to set them up.');
  if (!f.name) return again("Enter the client's name.");
  if (!EMAIL_RE.test(f.email)) return again('Enter a valid email address.');
  const existing = await one(`SELECT id, therapist_id FROM clinical.clients WHERE lower(email)=$1`, [f.email]);
  // Never say whose client it is: that would leak another therapist's client list.
  if (existing) return again(existing.therapist_id === me.id ? 'That email address already belongs to one of your clients. Open their record to reopen or change it.' : 'That email address already belongs to a client record in this practice.');

  let consent = { status: 'n/a', at: null, method: null, note: null, by: null };
  if (f.under16) {
    if (b.consent_confirmed !== 'on') return again('For a client under 16, confirm that a parent or guardian has given consent before adding them.');
    if (!f.guardian_name) return again("Enter the parent or guardian's name.");
    if (f.guardian_email && !EMAIL_RE.test(f.guardian_email)) return again("The parent or guardian's email address does not look right.");
    const d = f.consent_date ? new Date(f.consent_date) : new Date();
    consent = { status: 'granted', at: isNaN(d) || d > new Date() ? new Date() : d, method: 'in_person', note: f.consent_note || null, by: me.id };
  }
  const [client] = await q(
    `INSERT INTO clinical.clients (therapist_id, name, email, phone, under16, guardian_name, guardian_email, guardian_phone,
       consent_status, consent_at, consent_method, consent_note, consent_recorded_by, programme_sessions, sessions_before_app, reminder_dow,
       programme_id, programme_name, programme_price_pence, reminders_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [me.id, f.name, f.email, f.phone || null, f.under16, f.under16 ? f.guardian_name : null, f.under16 ? f.guardian_email || null : null,
     f.under16 ? f.guardian_phone || null : null, consent.status, consent.at, consent.method, consent.note, consent.by,
     f.sessions, f.sessions_before_app, f.reminder_dow, prog.id, prog.name, prog.price_pence, f.sessions > 1]); // one-off sessions start with weekly reminders off
  await blocks.startBlock(client.id, prog, f.sessions_before_app);
  const who = { actorType: 'staff', actorId: me.id, subjectType: 'client', subjectId: client.id };
  await audit(req, 'client.created', { ...who, detail: { under16: f.under16 } });
  if (f.under16) await audit(req, 'client.consent_attested', who);
  if (enq) {
    await q(`UPDATE clinical.enquiries SET stage='converted', converted_client_id=$2 WHERE id=$1 AND therapist_id=$3`, [enq.id, client.id, me.id]);
    await q(`UPDATE documents.forms SET client_id=$2 WHERE enquiry_id=$1 AND therapist_id=$3`, [enq.id, client.id, me.id]); // signed forms move into the client folder
    await audit(req, 'enquiry.converted', { ...who, subjectType: 'enquiry', subjectId: enq.id });
  }
  const sent = await sendInvite(client, me);
  if (sent) await audit(req, 'client.invited', who);
  // Optional first session, booked in the same step (as in the BYH app).
  if (b.first_date) await book(req, client, b.first_date, b.first_time || '14:00');
  res.redirect(`/therapist/client/${client.id}?msg=${sent ? 'added' : 'added_nomail'}`);
});

const MSG = {
  added: ['Added, and an invitation to their client area has been emailed.', true],
  added_nomail: ['Added, but the invitation email could not be sent. Use "Send invitation again" once email is working.', false],
  saved: ['Saved.', true], invited: ['Invitation sent.', true], invite_failed: ['The invitation email could not be sent.', false],
  closed_no_invite: ['Reopen the record before sending an invitation.', false],
  details: ['Enter a name and a valid email address.', false], taken: ['That email address already belongs to a client record in this practice.', false],
  form_sent: ['Form sent. They have been emailed a link to read and sign it.', true], form_notsent: ['The form is ready but the email could not be sent. Try Send again once email is working.', false],
  form_email: ['This client has no email address to send it to (the parent or guardian\'s, for a child).', false], form_fee: ['Enter the fee per session, like 60 or 60.50.', false], form_template: ['Choose a form.', false],
  extended: ['Programme extended.', true], reminders: ['Reminder setting changed.', true],
  readonly: ['They can still sign in and read, but not add anything.', true], closed: ['Record closed. They can no longer sign in.', true],
  resumed: ['Record reopened. Their programme carries on where it left off.', true], fresh: ['Record reopened with a new programme. The earlier one is kept separately.', true],
  active: ['Record is active.', true], ic_set: ['Consultation set. They have been emailed the date and a calendar file.', true], ic_set_nomail: ['Consultation set. No email was sent (it could not be sent).', true],
  ic_cleared: ['Consultation removed.', true], date: ['Enter a real date and time.', false], attended: ['Marked as attended. The form has been emailed for signing.', true],
  proceeded: ['They are now an active client. Book their sessions from here.', true], nodate: ['Choose a programme first.', false], consent: ['For a client under 16, confirm that a parent or guardian has given consent.', false],
  archived: ['Archived as did not proceed. You can restore them from the archive if they get in touch again.', true], restored: ['Restored. They are back at the consultation stage.', true],
  block_started: ['New block started. Their earlier blocks are kept, and sessions you book now count against this one.', true],
  block_open: ['The current block still has sessions to come. Tick "end it early" to start a new block now.', false],
  unknown: ['Unknown action.', false],
};

router.get('/therapist/client/:id', th, async (req, res) => {
  const me = req.session.staff, c = await own(req);
  if (!c) return res.status(404).send(V.forbidden());
  await audit(req, 'client.viewed', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'client', subjectId: c.id });
  const m = MSG[String(req.query.msg || '')];
  const gapDays = c.closed_at ? (Date.now() - new Date(c.closed_at).getTime()) / 86400000 : 0;
  const next = await one(`SELECT starts_at FROM clinical.appointments WHERE client_id=$1 AND status='booked' AND starts_at > now() ORDER BY starts_at LIMIT 1`, [c.id]);
  res.status(m && m[1] === false ? 400 : 200).send(V.clientRecord({ ...c, ic_text: c.ic_at ? T.when(c.ic_at) : null, ic_date: c.ic_at ? T.inputDate(c.ic_at) : '', ic_time: c.ic_at ? T.timeShort(c.ic_at) : '10:00', pos: position(c, await heldCount(c.id)), next: next ? T.when(next.starts_at) : null, freshOnReopen: c.status === 'closed' && gapDays > RESUME_DAYS, programmes: await activeProgrammes(), blocks: await blocks.blocksFor(c.id), scores: await require('../lib/scores').series(c.id), data_requests: (await q(`SELECT id, kind, note, created_at FROM clinical.data_requests WHERE client_id=$1 AND handled_at IS NULL ORDER BY id`, [c.id])).map(r => ({ ...r, when: T.when(r.created_at) })), forms: await q(`SELECT id, template_name, audience, status, sent_at, signed_at FROM documents.forms WHERE client_id=$1 AND therapist_id=$2 ORDER BY id`, [c.id, me.id]), templates: (await activeTemplates()).filter(t => t.audience === (c.under16 ? 'child' : 'adult')), fee_pence: (await one(`SELECT default_fee_pence FROM core.staff WHERE id=$1`, [me.id])).default_fee_pence }, m && m[0], m ? m[1] : undefined));
});

router.post('/therapist/client/:id', th, async (req, res) => {
  const me = req.session.staff, action = String(req.body.action || '');
  const c = await own(req);
  if (!c) return res.status(404).send(V.forbidden());
  const done = msg => res.redirect(`/therapist/client/${c.id}?msg=${msg}`);
  const log = (what, detail) => audit(req, what, { actorType: 'staff', actorId: me.id, subjectType: 'client', subjectId: c.id, detail });
  const endSessions = () => q(`DELETE FROM core.sessions WHERE client_id=$1`, [c.id]);

  if (action === 'send_form') {
    const fee = pence(req.body.fee);
    if (fee == null) return done('form_fee');
    try {
      const r = await sendForm({ therapistId: me.id, templateId: req.body.template, client: c, fee_pence: fee, session_format: req.body.session_format === 'online' ? 'online' : 'inperson', req });
      return done(r.sent ? 'form_sent' : 'form_notsent');
    } catch (err) { if (err.code === 'email') return done('form_email'); if (err.code === 'template') return done('form_template'); throw err; }
  }
  const pre = ['consultation', 'attended'].includes(c.status);
  if (action === 'ic' && pre) {
    const at = T.fromLocal(req.body.date, req.body.time);
    if (!at) return done('date');
    const moved = !!c.ic_at;
    const [n] = await q(`UPDATE clinical.clients SET ic_at=$2, ic_sequence=ic_sequence+$3, ic_change_requested_at=NULL, ic_change_kind=NULL, ic_change_reason=NULL WHERE id=$1 RETURNING *`, [c.id, at, moved ? 1 : 0]);
    await log('client.consultation_set');
    return done(at > new Date() && await consult.notifyConsultation(n, moved ? 'moved' : 'booked') ? 'ic_set' : 'ic_set_nomail');
  }
  if (action === 'data_done') {
    await q(`UPDATE clinical.data_requests SET handled_at=now(), handled_note=$3 WHERE id=$1 AND client_id=$2 AND handled_at IS NULL`, [Number(req.body.id) || 0, c.id, String(req.body.note || '').trim().slice(0, 300) || null]);
    await log('client.data_request_handled');
    return done('saved');
  }
  if (action === 'dismiss_ic_request' && pre) {
    await q(`UPDATE clinical.clients SET ic_change_requested_at=NULL, ic_change_kind=NULL, ic_change_reason=NULL WHERE id=$1`, [c.id]);
    return done('saved');
  }
  if (action === 'clear_ic' && pre) {
    if (c.ic_at && c.ic_at > new Date()) await consult.notifyConsultation({ ...c, ic_sequence: c.ic_sequence + 1 }, 'cancelled');
    await q(`UPDATE clinical.clients SET ic_at=NULL, ic_sequence=ic_sequence+1, ic_change_requested_at=NULL, ic_change_kind=NULL, ic_change_reason=NULL WHERE id=$1`, [c.id]);
    await log('client.consultation_cleared'); return done('ic_cleared');
  }
  if (action === 'attended' && pre) {
    const fee = pence(req.body.fee);
    if (fee == null) return done('form_fee');
    try {
      const r = await sendForm({ therapistId: me.id, templateId: req.body.template, client: c, fee_pence: fee, session_format: req.body.session_format === 'online' ? 'online' : 'inperson', req });
      await q(`UPDATE clinical.clients SET status='attended' WHERE id=$1`, [c.id]);
      await log('client.attended', { form: r.id });
      return done(r.sent ? 'attended' : 'form_notsent');
    } catch (err) { if (err.code === 'email') return done('form_email'); if (err.code === 'template') return done('form_template'); throw err; }
  }
  if (action === 'proceed' && pre) {
    const prog = await one(`SELECT * FROM core.programmes WHERE id=$1 AND active`, [Number(req.body.programme) || 0]);
    if (!prog) return done('nodate');
    let consent = [c.consent_status, c.consent_at, c.consent_method, c.consent_note, c.consent_recorded_by];
    if (c.under16) {
      if (req.body.consent_confirmed !== 'on') return done('consent');
      const d = req.body.consent_date ? new Date(req.body.consent_date) : new Date();
      consent = ['granted', isNaN(d) || d > new Date() ? new Date() : d, 'in_person', text(req.body.consent_note, 500) || null, me.id];
    }
    let prior = Number(req.body.sessions_before_app); if (!Number.isInteger(prior) || prior < 0) prior = 0;
    await q(`UPDATE clinical.clients SET consent_status=$2, consent_at=$3, consent_method=$4, consent_note=$5, consent_recorded_by=$6 WHERE id=$1`, [c.id, ...consent]);
    await blocks.startBlock(c.id, prog, prior);
    if (c.under16) await log('client.consent_attested');
    await log('client.proceeded', { programme: prog.id });
    return done('proceeded');
  }
  if (action === 'did_not_proceed' && pre) {
    if (c.ic_at && c.ic_at > new Date()) await consult.notifyConsultation({ ...c, ic_sequence: c.ic_sequence + 1 }, 'cancelled');
    await q(`UPDATE clinical.clients SET status='closed', closed_at=now(), closed_reason='did_not_proceed', archived_at=now() WHERE id=$1`, [c.id]);
    await endSessions();
    await log('client.archived', { reason: 'did_not_proceed' });
    return res.redirect('/therapist/clients');
  }
  if (action === 'restore' && c.archived_at) {
    await archive.restoreClient(me.id, c.id);
    await log('client.restored');
    return done('restored');
  }
  if (action === 'invite') {
    if (c.status === 'closed') return done('closed_no_invite');
    const sent = await sendInvite(c, me);
    if (sent) await log('client.invited');
    return done(sent ? 'invited' : 'invite_failed');
  }
  if (action === 'edit') {
    const name = text(req.body.name), email = norm(req.body.email), phone = text(req.body.phone, 40);
    if (!name || !EMAIL_RE.test(email)) return done('details');
    if (await one(`SELECT 1 FROM clinical.clients WHERE lower(email)=$1 AND id<>$2`, [email, c.id])) return done('taken');
    const emailChanged = email !== c.email.toLowerCase();
    await q(`UPDATE clinical.clients SET name=$2, email=$3, phone=$4 WHERE id=$1`, [c.id, name, email, phone || null]);
    if (emailChanged) await endSessions(); // a new address must prove itself with a fresh sign-in
    await log('client.edited', { email_changed: emailChanged });
    return done('saved');
  }
  if (['extend', 'reminders', 'readonly'].includes(action) && pre) return done('unknown');
  if (action === 'extend') {
    const add = length(req.body.add_sessions, 6);
    if (c.programme_sessions + add > 60) return done('unknown');
    await q(`UPDATE clinical.clients SET programme_sessions=programme_sessions+$2, status='active', closed_at=NULL WHERE id=$1`, [c.id, add]);
    await q(`UPDATE clinical.programme_blocks SET sessions=sessions+$2 WHERE id=$1`, [c.current_block_id, add]);
    await log('client.programme_extended', { add });
    return done('extended');
  }
  if (action === 'new_block') {
    if (pre || c.archived_at) return done('unknown');
    const prog = await one(`SELECT * FROM core.programmes WHERE id=$1 AND active`, [Number(req.body.programme) || 0]);
    if (!prog) return done('nodate');
    const held = await heldCount(c.id);
    if (c.status !== 'closed' && position(c, held) && held + c.sessions_before_app < c.programme_sessions && req.body.end_early !== 'on') return done('block_open');
    await blocks.startBlock(c.id, prog, 0);
    await log('client.block_started', { programme: prog.id });
    return done('block_started');
  }
  if (action === 'reminders') {
    await q(`UPDATE clinical.clients SET reminders_on=$2, reminder_dow=$3 WHERE id=$1`, [c.id, req.body.reminders_on === 'on', dow(req.body.reminder_dow)]);
    await log('client.reminders_changed');
    return done('reminders');
  }
  if (action === 'readonly') {
    await q(`UPDATE clinical.clients SET status='readonly' WHERE id=$1`, [c.id]);
    await log('client.status_changed', { status: 'readonly' });
    return done('readonly');
  }
  if (action === 'close') {
    await q(`UPDATE clinical.clients SET status='closed', closed_at=now(), closed_reason='completed' WHERE id=$1`, [c.id]);
    await endSessions();
    await log('client.status_changed', { status: 'closed' });
    return done('closed');
  }
  if (action === 'reopen') {
    const gapDays = c.closed_at ? (Date.now() - new Date(c.closed_at).getTime()) / 86400000 : 0;
    if (pre || c.archived_at) return done('unknown');
    if (c.status !== 'closed' || gapDays <= RESUME_DAYS) {
      await q(`UPDATE clinical.clients SET status='active', closed_at=NULL WHERE id=$1`, [c.id]);
      await log('client.status_changed', { status: 'active' });
      return done(c.status === 'closed' ? 'resumed' : 'active');
    }
    const prog = await one(`SELECT * FROM core.programmes WHERE id=$1 AND active`, [Number(req.body.programme) || 0]);
    if (!prog) return done('unknown');
    await blocks.startBlock(c.id, prog, 0);
    await log('client.status_changed', { status: 'active', new_programme: true });
    return done('fresh');
  }
  done('unknown');
});

router.get('/therapist/stats', th, async (req, res) => res.send(V.practiceStats(await require('../lib/stats').practiceStats(req.session.staff.id), true)));
router.get('/therapist/archive', th, async (req, res) => {
  const me = req.session.staff;
  const clients = await q(`SELECT id, name, archived_at FROM clinical.clients WHERE therapist_id=$1 AND archived_at IS NOT NULL ORDER BY archived_at DESC`, [me.id]);
  const enquiries = await q(`SELECT id, name, archived_at, archive_reason FROM clinical.enquiries WHERE therapist_id=$1 AND archived_at IS NOT NULL ORDER BY archived_at DESC`, [me.id]);
  const m = MSG[String(req.query.msg || '')] || [];
  res.send(V.archivePage(clients, enquiries, m[0], m[1]));
});
router.post('/therapist/archive/enquiry/:id', th, async (req, res) => {
  const e = await one(`SELECT id FROM clinical.enquiries WHERE id=$1 AND therapist_id=$2 AND archived_at IS NOT NULL`, [Number(req.params.id) || 0, req.session.staff.id]);
  if (!e) return res.status(404).send(V.forbidden());
  await archive.restoreEnquiry(req.session.staff.id, e.id);
  await audit(req, 'enquiry.restored', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'enquiry', subjectId: e.id });
  res.redirect('/therapist/enquiries?msg=restored');
});

module.exports = router;
