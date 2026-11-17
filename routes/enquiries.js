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
const T = require('../lib/time');
const { limited } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const V = require('../views/pages');
const consult = require('../lib/consult');
const archive = require('../lib/archive');

const sources = require('../lib/sources');
const router = express.Router();
const th = A.requireRole('therapist', '/staff/therapist', V.forbidden);
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const text = (v, max = 100) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const PUBLIC_SRC = ['website', 'google', 'facebook'];

// Where did this visitor come from? Taken from the link they followed: our own ?src=, the ad networks' click tags
// (Google adds gclid, Facebook/Instagram add fbclid), a utm_source tag, or the page they came from. Only known sources
// are recognised, so a made-up link cannot add anything to the list. Many browsers and apps hide the referring page,
// so tagged ad links are the reliable way.
function detectSrc(req) {
  const qy = req.query || {};
  const u = String(qy.utm_source || '').toLowerCase();
  let host = ''; try { host = new URL(req.get('referer') || '').hostname.toLowerCase(); } catch (_) {}
  const from = re => re.test(host);
  let heard = null;
  if (qy.gclid || qy.gbraid || qy.wbraid || /google|adwords/.test(u)) heard = 'Google ads';
  else if (/instagram|^ig$/.test(u) || from(/(^|\.)instagram\./)) heard = 'Instagram';
  else if (qy.fbclid || /facebook|^fb$|meta/.test(u) || from(/(^|\.)(facebook|fb)\./)) heard = 'Facebook';   // fbclid is added by both; the tag or page tells Instagram apart
  else if (/linkedin/.test(u) || from(/(^|\.)linkedin\./)) heard = 'LinkedIn';
  else if (from(/(^|\.)(google|bing|duckduckgo|ecosia|yahoo)\./)) heard = 'Browser search';   // arrived from search results, no ad click tag
  const chan = PUBLIC_SRC.includes(qy.src) ? qy.src : heard === 'Google ads' ? 'google' : heard === 'Facebook' || heard === 'Instagram' ? 'facebook' : null;
  return { src: chan, heard };
}
const DETECTED = ['Google ads', 'Facebook', 'Instagram', 'LinkedIn', 'Browser search', 'Website'];
const HEARD = { google: 'Google ads', facebook: 'Facebook', website: 'Website' };
async function heardFor(src, detected) {
  const name = DETECTED.includes(detected) ? detected : HEARD[src]; if (!name) return null;
  await q(`INSERT INTO core.referral_sources (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
  return name;
}
const campaignOf = v => String(v ?? '').replace(/[\r\n\t<>]/g, ' ').trim().slice(0, 100) || null;

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
  res.send(V.enquireForm({ therapists: list, src: detectSrc(req).src || 'website', heard: detectSrc(req).heard, campaign: campaignOf(req.query.utm_campaign), pick: list.length === 1 ? list[0].id : null }));
});
router.get('/enquire/thanks', (_req, res) => res.send(V.enquireThanks()));
router.get('/enquire/t/:slug', async (req, res) => {
  const t = await one(`SELECT id, name FROM core.staff WHERE enquiry_slug=$1 AND role='therapist' AND status='active'`, [String(req.params.slug)]);
  if (!t) return res.status(404).send(V.forbidden());
  res.send(V.enquireForm({ therapist: t, slug: req.params.slug, src: detectSrc(req).src || 'therapist_page', heard: detectSrc(req).heard, campaign: campaignOf(req.query.utm_campaign) }));
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
  const again = async msg => res.status(400).send(V.enquireForm({ therapists: b.slug ? null : await activeTherapists(), therapist: b.slug ? therapist : null, slug: b.slug, src, heard: b.heard, campaign: campaignOf(b.campaign), pick: therapist && therapist.id, f, error: msg }));
  if (!therapist) return again('Please choose who you would like to hear from.');
  if (!f.name) return again('Please enter your name.');
  if (!f.email && !f.phone) return again('Please give an email address or a phone number so we can reply.');
  if (f.email && !EMAIL_RE.test(f.email)) return again('That email address does not look right.');
  if (f.for_child && !f.child_name) return again("Please enter the child's name.");
  // Limit counts accepted enquiries only, so a typo in the form never locks anyone out.
  if (limited(`enquire:${req.ip}`, 5, 3600000)) return res.status(429).send(V.enquireThanks('Too many enquiries from this connection. Please try again later.'));
  const [e] = await q(`INSERT INTO clinical.enquiries (therapist_id, channel, for_child, name, email, phone, guardian_name, guardian_email, guardian_phone, heard_from, campaign) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    f.for_child ? [therapist.id, src, true, f.child_name, null, null, f.name, f.email || null, f.phone || null, await heardFor(src, b.heard), campaignOf(b.campaign)]
                : [therapist.id, src, false, f.name, f.email || null, f.phone || null, null, null, null, await heardFor(src, b.heard), campaignOf(b.campaign)]);
  await audit(req, 'enquiry.received', { actorType: 'public', subjectType: 'enquiry', subjectId: e.id, detail: { channel: src } });
  await require('../lib/notify').notifyEnquiry(e.id);   // retried in the background if the mail server is down
  res.redirect('/enquire/thanks');
});

// ---------- therapist ----------
// An enquiry is someone who has not yet been booked in. Booking the initial consultation turns them into a CLIENT
// (status "Consultation booked"), so enquiries only ever holds people not yet booked. Ones that go nowhere are archived.
const own = req => one(`SELECT * FROM clinical.enquiries WHERE id=$1 AND therapist_id=$2`, [Number(req.params.id) || 0, req.session.staff.id]);
const MSG = {
  added: ['Enquiry added.', true], saved: ['Saved.', true], contact: ['Add an email address or a phone number.', false], name: ['Enter a name.', false], email: ['That email address does not look right.', false],
  booked: ['Consultation booked. They are now in your Clients, and have been emailed the date, a calendar file and an invitation to their client area.', true],
  booked_nomail: ['Consultation booked and they are now in your Clients. Some emails could not be sent: open their record and use Send invitation again once email is working.', true],
  need_email: ['An email address is needed to book a consultation (the parent or guardian\'s, for a child), so they can be invited to their client area. Add one, then book.', false],
  taken: ['That email address already belongs to a client record in this practice, so a consultation cannot be booked with it. Use "Change contact details" on the enquiry to give a different email, or ask your practice manager.', false],
  linked: ['Linked to the existing client record. This enquiry has been closed.', true], merged: ['Duplicate removed. The other enquiry for this person carries on.', true], in_archive: ['That person is in your archive. Restore them from there rather than booking again.', false],
  date: ['Enter a real date and time.', false], deleted: ['Enquiry deleted.', true], archived: ['Archived. If they get in touch again you will be shown the match.', true],
  restored: ['Restored.', true], reactivated: ['Restored from the archive. They are back in Clients at the consultation stage.', true], gone: ['That archived record is no longer available.', false],
};
const bookResult = r => (r.invited ? 'booked' : 'booked_nomail');
const codeMsg = err => ({ email: 'need_email', taken: 'taken', archived: 'in_archive' })[err.code];

router.get('/therapist/enquiries', th, async (req, res) => {
  const me = req.session.staff, slug = await slugFor(me.id), base = process.env.BASE_URL || '';
  await archive.archiveStale(me.id);
  const rows = await q(`SELECT * FROM clinical.enquiries WHERE therapist_id=$1 AND archived_at IS NULL AND stage='new' ORDER BY created_at DESC`, [me.id]);
  for (const e of rows) { e.matches = await archive.findMatches(me.id, e); e.live = await archive.findLive(me.id, e); e.elsewhere = await archive.takenElsewhere(me.id, e.for_child ? (e.email || e.guardian_email) : e.email); }
  const [msg, ok] = MSG[String(req.query.msg || '')] || [];
  res.status(ok === false ? 400 : 200).send(V.therapistEnquiries(rows, { mine: `${base}/enquire/t/${slug}`, practice: `${base}/enquire`, sources: await sources.active() }, msg, ok));
});

router.get('/therapist/enquiries/new', th, async (_req, res) => res.send(V.enquiryManual({ enquiry_date: T.inputDate(new Date()) }, null, await sources.active())));

router.post('/therapist/enquiries/add', th, async (req, res) => {
  const me = req.session.staff, b = req.body, child = b.type === 'child';
  const f = { type: child ? 'child' : 'adult', first: text(b.first_name), last: text(b.last_name), email: String(b.email || '').trim().toLowerCase().slice(0, 254), phone: text(b.phone, 40),
    address: text(b.address, 300), enquiry_date: text(b.enquiry_date, 10), ic_date: text(b.ic_date, 10), ic_time: text(b.ic_time, 5) || '10:00', notes: text(b.notes, 1000),
    guardian_name: text(b.guardian_name), relationship: text(b.relationship), guardian_email: String(b.guardian_email || '').trim().toLowerCase().slice(0, 254), guardian_phone: text(b.guardian_phone, 40) };
  f.heard = text(b.heard, 20); f.heard_other = text(b.heard_other, 100); f.referrer = text(b.referrer, 100);
  const again = async msg => res.status(400).send(V.enquiryManual(f, msg, await sources.active()));
  const name = `${f.first} ${f.last}`.trim();
  if (!f.first || !f.last) return again('Enter a first and last name.');
  if (f.email && !EMAIL_RE.test(f.email)) return again('That email address does not look right.');
  if (f.guardian_email && !EMAIL_RE.test(f.guardian_email)) return again("The parent or guardian's email address does not look right.");
  if (child && !f.guardian_name) return again("Enter the parent or guardian's name.");
  if (!f.email && !f.phone && !(child && (f.guardian_email || f.guardian_phone))) return again('Add an email address or a phone number.');
  const ed = f.enquiry_date && /^\d{4}-\d{2}-\d{2}$/.test(f.enquiry_date) && !isNaN(new Date(f.enquiry_date)) ? f.enquiry_date : T.inputDate(new Date());
  let ic = null;
  if (f.ic_date) { ic = T.fromLocal(f.ic_date, f.ic_time); if (!ic) return again('Enter a real consultation date and time.'); }
  const heardName = await sources.resolve(f.heard, f.heard_other);
  const [e] = await q(`INSERT INTO clinical.enquiries (therapist_id, channel, for_child, name, email, phone, address, enquiry_date, notes, stage, guardian_name, relationship, guardian_email, guardian_phone, heard_from, referrer_name)
    VALUES ($1,'phone',$2,$3,$4,$5,$6,$7,$8,'new',$9,$10,$11,$12,$13,$14) RETURNING *`,
    [me.id, child, name, f.email || null, f.phone || null, f.address || null, ed, f.notes || null,
     child ? f.guardian_name : null, child ? f.relationship || null : null, child ? f.guardian_email || null : null, child ? f.guardian_phone || null : null, heardName, f.referrer || null]);
  await audit(req, 'enquiry.added', { actorType: 'staff', actorId: me.id, subjectType: 'enquiry', subjectId: e.id, detail: { channel: 'phone' } });
  if (!ic) return res.redirect('/therapist/enquiries?msg=added');
  try { const r = await consult.bookFromEnquiry({ req, me, enquiry: e, at: ic }); return res.redirect(`/therapist/client/${r.client.id}?msg=${r.invited ? 'ic_set' : 'ic_set_nomail'}`); }
  catch (err) { if (!codeMsg(err)) throw err; return res.redirect(`/therapist/enquiries?msg=${codeMsg(err)}`); }
});

router.post('/therapist/enquiries/:id', th, async (req, res) => {
  const me = req.session.staff, e = await own(req);
  if (!e) return res.status(404).send(V.forbidden());
  const done = msg => res.redirect(`/therapist/enquiries?msg=${msg}`), b = req.body, action = String(b.action || '');
  const log = (what, detail) => audit(req, what, { actorType: 'staff', actorId: me.id, subjectType: 'enquiry', subjectId: e.id, detail });
  if (action === 'delete') { await q(`DELETE FROM clinical.enquiries WHERE id=$1 AND stage <> 'converted'`, [e.id]); await log('enquiry.deleted'); return done('deleted'); }
  if (e.stage === 'converted') return res.redirect(e.converted_client_id ? `/therapist/client/${e.converted_client_id}` : '/therapist/clients');
  if (action === 'notes') { await q(`UPDATE clinical.enquiries SET notes=$2, last_activity_at=now() WHERE id=$1`, [e.id, text(b.notes, 1000) || null]); return done('saved'); }
  if (action === 'heard') {   // set or correct where they heard about us (and who referred them)
    const name = await sources.resolve(b.heard, b.heard_other);
    await q(`UPDATE clinical.enquiries SET heard_from=$2, referrer_name=$3, last_activity_at=now() WHERE id=$1`, [e.id, name, name === 'Referral' ? text(b.referrer, 100) || null : null]);
    return done('saved');
  }
  if (action === 'link_client') {   // the therapist confirms this is a person who is already their client
    const m = (await archive.findLive(me.id, e)).find(x => x.kind === 'client' && x.id === (Number(b.match) || 0));
    if (!m) return done('gone');
    await q(`UPDATE clinical.enquiries SET stage='converted', converted_client_id=$2 WHERE id=$1`, [e.id, m.id]);
    await log('enquiry.linked_client', { client: m.id });
    return res.redirect(`/therapist/client/${m.id}?msg=saved`);
  }
  if (action === 'merge_enquiry') {   // same person as another enquiry of theirs: keep that one, drop this
    const m = (await archive.findLive(me.id, e)).find(x => x.kind === 'enquiry' && x.id === (Number(b.match) || 0));
    if (!m) return done('gone');
    await q(`DELETE FROM clinical.enquiries WHERE id=$1`, [e.id]);
    await log('enquiry.merged', { into: m.id });
    return done('merged');
  }
  if (action === 'contact') {   // fill in or change an email (or phone) so a consultation can be booked
    const email = String(b.email || '').trim().toLowerCase().slice(0, 254), phone = text(b.phone, 40);
    if (email && !EMAIL_RE.test(email)) return done('email');
    await q(e.for_child ? `UPDATE clinical.enquiries SET guardian_email=COALESCE($2,guardian_email), guardian_phone=COALESCE($3,guardian_phone), last_activity_at=now() WHERE id=$1`
                        : `UPDATE clinical.enquiries SET email=COALESCE($2,email), phone=COALESCE($3,phone), last_activity_at=now() WHERE id=$1`, [e.id, email || null, phone || null]);
    return done('saved');
  }
  if (action === 'consult') {
    const at = T.fromLocal(b.date, b.time);
    if (!at) return done('date');
    try { const r = await consult.bookFromEnquiry({ req, me, enquiry: e, at }); return done(bookResult(r)); }
    catch (err) { if (!codeMsg(err)) throw err; return done(codeMsg(err)); }
  }
  if (action === 'archive') {
    await q(`UPDATE clinical.enquiries SET archived_at=now(), archive_reason='manual' WHERE id=$1`, [e.id]);
    await log('enquiry.archived'); return done('archived');
  }
  if (action === 'restore_match') {   // the therapist has checked it is the same person as an archived record
    const kind = b.kind === 'client' ? 'client' : 'enquiry', id = Number(b.match) || 0;
    const m = (await archive.findMatches(me.id, e)).find(x => x.kind === kind && x.id === id);
    if (!m) return done('gone');
    if (kind === 'client') {
      await archive.restoreClient(me.id, id);
      await q(`UPDATE clinical.enquiries SET stage='converted', converted_client_id=$2 WHERE id=$1`, [e.id, id]);
      const c = await one(`SELECT * FROM clinical.clients WHERE id=$1`, [id]);
      await consult.sendInvite(c, me.name);
      await log('enquiry.matched_archive', { client: id });
      return res.redirect(`/therapist/client/${id}?msg=restored`);
    }
    await archive.restoreEnquiry(me.id, id);
    await q(`DELETE FROM clinical.enquiries WHERE id=$1`, [e.id]);   // the earlier record carries on; no duplicate
    await log('enquiry.matched_archive', { enquiry: id });
    return done('restored');
  }
  done('saved');
});

module.exports = { router, slugFor };
