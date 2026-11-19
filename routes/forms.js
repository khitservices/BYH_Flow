// routes/forms.js — digital forms. Sent from the app, signed in the app, stored in the app.
//  • PUBLIC /sign/<token>: the signer opens the emailed link (no sign-in) and signs by typing their name and ticking to agree.
//  • CLIENT /client/forms: a signed-in adult client sees and signs their own forms. A child's form is signed by the parent or
//    guardian through the emailed link, so a child client only sees its status.
//  • THERAPIST: sees and downloads the forms of their own enquiries and clients only (the client folder).
//  • PRACTICE MANAGER: keeps the list of form templates (wording as data). Never sees anyone's signed forms.
const express = require('express');
const crypto = require('node:crypto');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const brand = require('../lib/brand');
const storage = require('../lib/storage');
const F = require('../lib/forms');
const { signedPdf } = require('../lib/pdf');
const { limited } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const V = require('../views/pages');

const router = express.Router();
const th = A.requireRole('therapist', '/staff/therapist', V.forbidden);
const pm = A.requireRole('practice_manager', '/staff/practice', V.forbidden);
const cl = A.requireRole('client', '/', V.forbidden);
const tokenHash = t => crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update('form:' + t).digest('hex');
const text = (v, max = 200) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const DAYS = 30;

const activeTemplates = audience => q(`SELECT id, name, audience FROM core.form_templates WHERE active ${audience ? 'AND audience=$1' : ''} ORDER BY name`, audience ? [audience] : []);

// Create a form for someone and email them the signing link. Earlier unsigned forms of the same template for the same
// enquiry or client are voided, so a resend always leaves exactly one live link. Returns { id, sent }.
async function sendForm({ therapistId, templateId, enquiry, client, fee_pence, session_format, req }) {
  const tpl = await one(`SELECT * FROM core.form_templates WHERE id=$1 AND active`, [Number(templateId) || 0]);
  const me = await one(`SELECT * FROM core.staff WHERE id=$1`, [therapistId]);
  const subject = enquiry || client, child = enquiry ? enquiry.for_child : client.under16;
  if (!tpl || tpl.audience !== (child ? 'child' : 'adult')) throw Object.assign(new Error('template'), { code: 'template' });
  const to = child ? (subject.guardian_email || subject.email) : subject.email;
  const signerName = child ? (subject.guardian_name || subject.name) : subject.name;
  if (!to) throw Object.assign(new Error('email'), { code: 'email' });
  const rendered = F.render(tpl.body, { therapist: me, client_name: subject.name, fee_pence, session_format });
  const token = crypto.randomBytes(32).toString('hex');
  await q(`UPDATE documents.forms SET status='void', token_hash=NULL WHERE status='sent' AND template_id=$1 AND ${enquiry ? 'enquiry_id' : 'client_id'}=$2`, [tpl.id, subject.id]);
  const [f] = await q(`INSERT INTO documents.forms (therapist_id, enquiry_id, client_id, template_id, template_name, audience, rendered, content_sha256, sent_to, token_hash, token_expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' days')::interval) RETURNING id`,
    [therapistId, enquiry ? enquiry.id : null, client ? client.id : null, tpl.id, tpl.name, tpl.audience, rendered, F.sha(rendered), to, tokenHash(token), String(DAYS)]);
  await audit(req, 'form.sent', { actorType: 'staff', actorId: therapistId, subjectType: 'form', subjectId: f.id });
  let sent = true;
  try { await mail.sendFrom(me.id, to, rendered.title, mail.formRequestEmail(signerName, me.name, `${process.env.BASE_URL}/sign/${token}`)); }
  catch (e) { sent = false; console.error('[forms] email failed:', e.message); }
  return { id: f.id, sent };
}

// ---- signing (shared by the emailed link and the client area) ----
function readSigning(form, b) {
  const r = form.rendered, name = text(b.signer_name, 100), s = { name, choices: {} };
  if (name.length < 2) return { error: 'Type your full name to sign.' };
  for (const k of r.signer_fields) {
    s[k] = text(b['signer_' + k], k === 'address' ? 300 : 100);
    if (!s[k]) return { error: `Please fill in your ${{ address: 'address', phone: 'contact number', relationship: 'relationship to the child' }[k]}.` };
  }
  for (const c of r.choices) {
    if (c.type === 'yesno') { const v = b['choice_' + c.key]; if (v !== 'yes' && v !== 'no') return { error: 'Please answer every question.' }; s.choices[c.key] = v; }
    else s.choices[c.key] = b['choice_' + c.key] === 'on';
  }
  if (b.agree !== 'on') return { error: 'Please tick the box to confirm you have read and agree.' };
  return { s };
}

async function seal(form, s, req) {
  const at = new Date(), ip = req.ip;
  const lg = await brand.getLogo();
  const pdf = await signedPdf(form.rendered, { ...s, at, ip, sha: form.content_sha256 }, brand.BRAND.practiceName, lg && lg.logo_type !== 'image/webp' ? lg.logo : null);
  const fileId = await storage.put(pdf);
  const [done] = await q(`UPDATE documents.forms SET status='signed', signed_at=$2, signer=$3, signer_ip=$4, signer_agent=$5, file_id=$6, token_hash=NULL
    WHERE id=$1 AND status='sent' RETURNING id`, [form.id, at, JSON.stringify(s), ip || null, text(req.get('user-agent'), 300) || null, fileId]);
  if (!done) { await storage.remove(fileId).catch(() => {}); return false; }   // someone signed it a moment ago
  await audit(req, 'form.signed', { actorType: form.client_id && req.session && req.session.client ? 'client' : 'public', subjectType: 'form', subjectId: form.id });
  try { // a copy to the signer, and a plain notice (no details) to the therapist
    await mail.sendFrom(form.therapist_id, form.sent_to, form.rendered.title, mail.formSignedEmail(s.name, form.rendered.title), null, { attachments: [{ filename: `${form.rendered.title}.pdf`, content: pdf, contentType: 'application/pdf' }] });
    const t = await one(`SELECT name, email FROM core.staff WHERE id=$1`, [form.therapist_id]);
    await mail.sendMail(t.email, 'A form has been signed', mail.formSignedNoticeEmail(t.name, form.rendered.title));
  } catch (e) { console.error('[forms] signed email failed:', e.message); }
  return true;
}

async function byToken(token) {
  return one(`SELECT * FROM documents.forms WHERE token_hash=$1 AND status='sent' AND token_expires_at > now()`, [tokenHash(String(token))]);
}
router.get('/sign/:token', async (req, res) => {
  const f = await byToken(req.params.token);
  res.status(f ? 200 : 404).send(f ? V.signPage(f.rendered, `/sign/${req.params.token}`) : V.signGone());
});
router.post('/sign/:token', async (req, res) => {
  const f = await byToken(req.params.token);
  if (!f) return res.status(404).send(V.signGone());
  if (limited(`sign:${req.ip}`, 20, 3600000)) return res.status(429).send(V.signGone('Too many attempts from this connection. Please try again later.'));
  const r = readSigning(f, req.body);
  if (r.error) return res.status(400).send(V.signPage(f.rendered, `/sign/${req.params.token}`, r.error, req.body));
  res.send((await seal(f, r.s, req)) ? V.signDone(f.rendered.title, true) : V.signGone('This form has already been signed.'));
});

// ---- client area ----
const myForm = req => one(`SELECT * FROM documents.forms WHERE id=$1 AND client_id=$2 AND status <> 'void'`, [Number(req.params.id) || 0, req.session.client.id]);
router.get('/client/forms/:id', cl, async (req, res) => {
  const f = await myForm(req);
  if (!f || f.status !== 'sent' || f.audience !== 'adult') return res.status(404).send(V.forbidden());
  res.send(V.signPage(f.rendered, `/client/forms/${f.id}`, null, {}, '/journal'));
});
router.post('/client/forms/:id', cl, async (req, res) => {
  const f = await myForm(req);
  if (!f || f.status !== 'sent' || f.audience !== 'adult') return res.status(404).send(V.forbidden());
  const r = readSigning(f, req.body);
  if (r.error) return res.status(400).send(V.signPage(f.rendered, `/client/forms/${f.id}`, r.error, req.body, '/journal'));
  res.send((await seal(f, r.s, req)) ? V.signDone(f.rendered.title, false) : V.signGone('This form has already been signed.'));
});
router.get('/client/forms/:id/pdf', cl, async (req, res) => {
  const f = await myForm(req);
  if (!f || f.status !== 'signed' || f.audience !== 'adult') return res.status(404).send(V.forbidden());
  await audit(req, 'form.downloaded', { actorType: 'client', actorId: req.session.client.id, subjectType: 'form', subjectId: f.id });
  sendPdf(res, f, await storage.get(f.file_id));
});
function sendPdf(res, f, buf) {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${f.rendered.title.replace(/[^\w .-]/g, '')}.pdf"`, 'Cache-Control': 'private, no-store' }).send(buf);
}

// ---- therapist: the client folder ----
router.get('/therapist/forms/:id/pdf', th, async (req, res) => {
  const f = await one(`SELECT * FROM documents.forms WHERE id=$1 AND therapist_id=$2 AND status='signed'`, [Number(req.params.id) || 0, req.session.staff.id]);
  if (!f) return res.status(404).send(V.forbidden());
  await audit(req, 'form.viewed', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'form', subjectId: f.id });
  sendPdf(res, f, await storage.get(f.file_id));
});

// ---- practice manager: form templates ----
const TMSG = { saved: ['Saved. Forms already sent keep the wording they were sent with.', true], retired: ['Retired. It is no longer offered; forms already sent are unaffected.', true], restored: ['Offered again.', true] };
router.get('/practice/forms', pm, async (req, res) => {
  const [m, ok] = TMSG[req.query.msg] || [];
  res.send(V.formTemplates(await q(`SELECT id, name, audience, active FROM core.form_templates ORDER BY (NOT active), name`), m, ok));
});
const blank = { audience: 'adult', name: '', form: { title: '', wording: '', choices: '', signing_intro: '', closing: '', footer: '', signer_fields: [] } };
router.get('/practice/forms/new', pm, (_req, res) => res.send(V.formTemplateEdit(blank, F)));
router.get('/practice/forms/:id', pm, async (req, res) => {
  const t = await one(`SELECT * FROM core.form_templates WHERE id=$1`, [Number(req.params.id) || 0]);
  if (!t) return res.status(404).send(V.forbidden());
  res.send(V.formTemplateEdit({ id: t.id, name: t.name, audience: t.audience, active: t.active, form: F.toText(t.body) }, F));
});
router.get('/practice/forms/:id/preview', pm, async (req, res) => {
  const t = await one(`SELECT * FROM core.form_templates WHERE id=$1`, [Number(req.params.id) || 0]);
  if (!t) return res.status(404).send(V.forbidden());
  const me = await one(`SELECT * FROM core.staff WHERE id=$1`, [req.session.staff.id]);
  res.send(V.signPage(F.render(t.body, { therapist: { ...me, name: me.name }, client_name: '(client name)', fee_pence: 6000, session_format: 'inperson' }), '#', null, {}, '/practice/forms', true));
});
async function saveTemplate(req, res, id) {
  const b = req.body, audience = b.audience === 'child' ? 'child' : 'adult', name = text(b.name, 100), body = F.fromText(b);
  const data = { id, name, audience, form: { title: body.title, wording: b.wording, choices: b.choices, signing_intro: b.signing_intro, closing: b.closing, footer: b.footer, signer_fields: body.signer_fields } };
  const err = !name ? 'Give the form a name.' : F.validate(body, audience);
  if (err) return res.status(400).send(V.formTemplateEdit(data, F, err));
  if (id) await q(`UPDATE core.form_templates SET name=$2, audience=$3, body=$4, updated_at=now() WHERE id=$1`, [id, name, audience, JSON.stringify(body)]);
  else id = (await q(`INSERT INTO core.form_templates (name, audience, body) VALUES ($1,$2,$3) RETURNING id`, [name, audience, JSON.stringify(body)]))[0].id;
  await audit(req, id ? 'form_template.saved' : 'form_template.added', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'form_template', subjectId: id });
  res.redirect('/practice/forms?msg=saved');
}
router.post('/practice/forms', pm, (req, res) => saveTemplate(req, res, null));
router.post('/practice/forms/:id', pm, async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!await one(`SELECT 1 FROM core.form_templates WHERE id=$1`, [id])) return res.status(404).send(V.forbidden());
  if (req.body.action === 'retire' || req.body.action === 'restore') {
    await q(`UPDATE core.form_templates SET active=$2 WHERE id=$1`, [id, req.body.action === 'restore']);
    return res.redirect(`/practice/forms?msg=${req.body.action === 'retire' ? 'retired' : 'restored'}`);
  }
  saveTemplate(req, res, id);
});

// A fresh signing link for a form that is still unsigned (for a reminder). The text shown does not change.
async function reissueLink(formId) {
  const token = crypto.randomBytes(32).toString('hex');
  const r = await q(`UPDATE documents.forms SET token_hash=$2, token_expires_at = now() + ($3 || ' days')::interval WHERE id=$1 AND status='sent' RETURNING id`, [formId, tokenHash(token), String(DAYS)]);
  return r.length ? token : null;
}
module.exports = { router, sendForm, activeTemplates, reissueLink };
