// routes/therapist.js — the therapist account's own clients. CLINICAL: every route is behind
// requireRole('therapist'), and every query is limited to the signed-in therapist's own clients,
// so one therapist can never see or change another's, and a practice manager account cannot get here at all.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const brand = require('../lib/brand');
const { audit } = require('../lib/audit');
const V = require('../views/pages');

const router = express.Router();
const th = A.requireRole('therapist', '/staff', V.forbidden);
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const cleanName = v => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);
const norm = e => String(e || '').trim().toLowerCase().slice(0, 254);

router.get('/therapist', th, async (req, res) => {
  const [{ n }] = await q(`SELECT count(*)::int n FROM clinical.clients WHERE therapist_id=$1 AND status <> 'closed'`, [req.session.staff.id]);
  res.send(V.shell(req.session.staff.name, 'Therapist', 'Sessions and journals will appear here as they are built.', [
    { href: '/therapist/clients', label: `Clients (${n})` },
  ]));
});

async function clientsPage(req, res, msg, ok) {
  const rows = await q(`SELECT id, name, email, status, invited_at FROM clinical.clients WHERE therapist_id=$1
                        ORDER BY (status='closed'), lower(name)`, [req.session.staff.id]);
  res.status(ok === false ? 400 : 200).send(V.clients(rows, msg, ok));
}

async function sendInvite(client, therapist) {
  try {
    await mail.sendMail(client.email, `Your client area with ${brand.BRAND.practiceName}`, mail.clientInviteEmail(client.name, therapist.name, `${process.env.BASE_URL}/`));
    await q(`UPDATE clinical.clients SET invited_at=now() WHERE id=$1`, [client.id]);
    return true;
  } catch (e) { console.error('[clients] invite failed:', e.message); return false; }
}

router.get('/therapist/clients', th, (req, res) => clientsPage(req, res));

router.post('/therapist/clients/add', th, async (req, res) => {
  const me = req.session.staff, name = cleanName(req.body.name), email = norm(req.body.email);
  if (!name) return clientsPage(req, res, 'Enter the client\'s name.', false);
  if (!EMAIL_RE.test(email)) return clientsPage(req, res, 'Enter a valid email address.', false);
  if (await one(`SELECT 1 FROM clinical.clients WHERE lower(email)=$1`, [email])) return clientsPage(req, res, 'That email address already belongs to a client record in this practice.', false);
  const [client] = await q(`INSERT INTO clinical.clients (therapist_id, name, email) VALUES ($1,$2,$3) RETURNING *`, [me.id, name, email]);
  await audit(req, 'client.created', { actorType: 'staff', actorId: me.id, subjectType: 'client', subjectId: client.id });
  const sent = await sendInvite(client, me);
  if (sent) await audit(req, 'client.invited', { actorType: 'staff', actorId: me.id, subjectType: 'client', subjectId: client.id });
  clientsPage(req, res, sent ? `${name} was added and has been emailed an invitation to their client area.` : `${name} was added, but the invitation email could not be sent. Use "Send invitation again" once email is working.`, true);
});

router.post('/therapist/clients/:id', th, async (req, res) => {
  const me = req.session.staff, action = String(req.body.action || '');
  // "AND therapist_id" is the access rule: someone else's client is simply not found.
  const client = await one(`SELECT * FROM clinical.clients WHERE id=$1 AND therapist_id=$2`, [Number(req.params.id) || 0, me.id]);
  if (!client) return res.status(404).send(V.forbidden());
  const log = (what, detail) => audit(req, what, { actorType: 'staff', actorId: me.id, subjectType: 'client', subjectId: client.id, detail });
  const endSessions = () => q(`DELETE FROM core.sessions WHERE client_id=$1`, [client.id]);

  if (action === 'invite') {
    if (client.status === 'closed') return clientsPage(req, res, 'Reopen the record before sending an invitation.', false);
    const sent = await sendInvite(client, me);
    if (sent) await log('client.invited');
    return clientsPage(req, res, sent ? `Invitation sent to ${client.name}.` : 'The invitation email could not be sent.', sent);
  }
  if (action === 'edit') {
    const name = cleanName(req.body.name), email = norm(req.body.email);
    if (!name || !EMAIL_RE.test(email)) return clientsPage(req, res, 'Enter a name and a valid email address.', false);
    if (await one(`SELECT 1 FROM clinical.clients WHERE lower(email)=$1 AND id<>$2`, [email, client.id])) return clientsPage(req, res, 'That email address already belongs to a client record in this practice.', false);
    const emailChanged = email !== client.email.toLowerCase();
    await q(`UPDATE clinical.clients SET name=$2, email=$3 WHERE id=$1`, [client.id, name, email]);
    if (emailChanged) await endSessions();
    await log('client.edited', { email_changed: emailChanged });
    return clientsPage(req, res, 'Saved.', true);
  }
  const next = { close: 'closed', readonly: 'readonly', reopen: 'active' }[action];
  if (!next) return clientsPage(req, res, 'Unknown action.', false);
  await q(`UPDATE clinical.clients SET status=$2 WHERE id=$1`, [client.id, next]);
  if (next === 'closed') await endSessions();
  await log('client.status_changed', { status: next });
  clientsPage(req, res, { closed: `${client.name}'s record is closed. They can no longer sign in.`, readonly: `${client.name} can still sign in and read, but not add anything.`, active: `${client.name}'s record is active.` }[next], true);
});

module.exports = router;
