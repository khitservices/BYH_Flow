// routes/auth.js — sign-in, role selection, sign-out, and the per-role landing shells.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const { audit } = require('../lib/audit');
const { limited } = require('../lib/ratelimit');
const V = require('../views/pages');

const router = express.Router();
const secure = (process.env.BASE_URL || '').startsWith('https');
const cookieOpts = { httpOnly: true, signed: true, sameSite: 'lax', secure, maxAge: 12 * 60 * 60 * 1000 };
const norm = e => String(e || '').trim().toLowerCase().slice(0, 254);
const landing = role => ({ practice_manager: '/practice', therapist: '/therapist', client: '/journal' }[role]);

async function startSession(req, res, opts, auditAction, who) {
  const old = req.signedCookies && req.signedCookies.sid;
  if (old) await A.destroySession(old);
  const sid = await A.createSession(opts);
  res.cookie('sid', sid, cookieOpts);
  await audit(req, auditAction, who);
}

// ---------- staff: emailed 6-digit code ----------
router.get('/staff', (_req, res) => res.send(V.staffLogin()));

router.post('/staff/request-code', async (req, res) => {
  const email = norm(req.body.email);
  // Identical response whether or not the address exists, and whether or not we're throttling.
  if (!limited(`code|${req.ip}|${email}`, 5, 10 * 60 * 1000)) {
    try {
      const staff = await one(`SELECT * FROM core.staff WHERE lower(email)=$1 AND status='active'`, [email]);
      if (staff) {
        const code = await A.issueStaffCode(staff);
        await mail.sendMail(staff.email, 'Your sign-in code', mail.staffCodeEmail(staff.name, code));
        await audit(req, 'staff.code_sent', { actorType: 'staff', actorId: staff.id });
      }
    } catch (e) { console.error('[auth] code request failed:', e.message); }
  }
  res.send(V.staffVerify(email));
});

router.post('/staff/verify', async (req, res) => {
  const email = norm(req.body.email);
  const fail = () => res.status(401).send(V.staffVerify(email, "That code didn't work or has expired."));
  if (limited(`verify|${req.ip}`, 20, 10 * 60 * 1000)) return fail();
  const staff = await one(`SELECT * FROM core.staff WHERE lower(email)=$1 AND status='active'`, [email]);
  if (!staff || !(await A.verifyStaffCode(staff, String(req.body.code || '').trim()))) {
    await audit(req, 'staff.signin_failed', { actorType: 'staff', actorId: staff ? staff.id : null });
    return fail();
  }
  const roles = A.rolesOf(staff);
  const role = roles.length === 1 ? roles[0] : null; // two roles: choose explicitly
  await startSession(req, res, { staffId: staff.id, role }, 'staff.signed_in', { actorType: 'staff', actorId: staff.id, detail: { role } });
  res.redirect(role ? landing(role) : '/choose-role');
});

router.get('/choose-role', async (req, res) => {
  const s = await A.getSession(req);
  if (!s || !s.staff) return res.redirect('/staff');
  const roles = A.rolesOf(s.staff);
  if (roles.length === 1) return res.redirect(landing(roles[0]));
  res.send(V.chooseRole(roles));
});

router.post('/choose-role', async (req, res) => {
  const s = await A.getSession(req);
  if (!s || !s.staff) return res.redirect('/staff');
  const role = String(req.body.role || '');
  if (!A.rolesOf(s.staff).includes(role)) return res.status(403).send(V.forbidden());
  await A.setRole(s.idHash, role);
  await audit(req, 'staff.role_selected', { actorType: 'staff', actorId: s.staff.id, detail: { role } });
  res.redirect(landing(role));
});

// ---------- clients: emailed link ----------
router.get('/', (_req, res) => res.send(V.clientLogin()));

router.post('/request-link', async (req, res) => {
  const email = norm(req.body.email);
  // The poll cookie is ALWAYS set, so the response gives away nothing about whether the address is registered.
  const pollKey = A.random();
  res.cookie('pk', pollKey, { httpOnly: true, signed: true, sameSite: 'lax', secure, maxAge: 16 * 60 * 1000 });
  if (!limited(`link|${req.ip}|${email}`, 5, 10 * 60 * 1000)) {
    try {
      const client = await one(`SELECT * FROM clinical.clients WHERE lower(email)=$1 AND status='active'`, [email]);
      if (client) {
        const token = await A.issueClientLink(client, pollKey);
        await mail.sendMail(client.email, 'Your sign-in link', mail.clientLinkEmail(client.name, `${process.env.BASE_URL}/auth/${token}`));
        await audit(req, 'client.link_sent', { actorType: 'client', actorId: client.id });
      }
    } catch (e) { console.error('[auth] link request failed:', e.message); }
  }
  res.send(V.clientSent());
});

// Must come before /auth/:token so "poll" is not read as a token.
router.get('/auth/poll', async (req, res) => {
  const pk = req.signedCookies && req.signedCookies.pk;
  if (!pk) return res.json({ ready: false });
  const claimed = await A.claimPoll(pk);
  if (!claimed) return res.json({ ready: false });
  const client = await one(`SELECT id FROM clinical.clients WHERE id=$1 AND status='active'`, [claimed.client_id]);
  if (!client) return res.json({ ready: false });
  await startSession(req, res, { clientId: client.id, role: 'client' }, 'client.signed_in', { actorType: 'client', actorId: client.id, detail: { via: 'poll' } });
  res.clearCookie('pk');
  res.json({ ready: true, dest: '/journal' });
});

// GET only shows a confirm button. Mail scanners that pre-fetch links would otherwise burn the one-time token.
router.get('/auth/:token', async (req, res) => {
  if (!(await A.peekClientLink(req.params.token))) return res.status(400).send(V.linkExpired());
  res.send(V.clientConfirm(req.params.token));
});

router.post('/auth/:token', async (req, res) => {
  const used = await A.consumeClientLink(req.params.token);
  if (!used) return res.status(400).send(V.linkExpired());
  const client = await one(`SELECT id FROM clinical.clients WHERE id=$1 AND status='active'`, [used.client_id]);
  if (!client) return res.status(400).send(V.linkExpired());
  await startSession(req, res, { clientId: client.id, role: 'client' }, 'client.signed_in', { actorType: 'client', actorId: client.id, detail: { via: 'link' } });
  res.redirect('/journal');
});

// ---------- common ----------
router.get('/ping', async (req, res) => { const s = await A.getSession(req); res.status(s ? 200 : 401).json({ ok: !!s }); });

router.get('/logout', async (req, res) => {
  const id = req.signedCookies && req.signedCookies.sid;
  if (id) await A.destroySession(id);
  res.clearCookie('sid');
  res.redirect('/');
});

// ---------- landing shells (real screens arrive in later phases) ----------
router.get('/practice', A.requireRole('practice_manager', '/staff', V.forbidden), (req, res) =>
  res.send(V.shell(req.session.staff.name, 'Practice manager', 'Enquiries, bookings and sources will appear here. Clinical records are not available in this role.', A.rolesOf(req.session.staff).length > 1)));

router.get('/therapist', A.requireRole('therapist', '/staff', V.forbidden), (req, res) =>
  res.send(V.shell(req.session.staff.name, 'Therapist', 'Your clients, sessions and journals will appear here.', A.rolesOf(req.session.staff).length > 1)));

router.get('/journal', A.requireRole('client', '/', V.forbidden), (req, res) =>
  res.send(V.shell(req.session.client.name, 'Client', 'Your journal will appear here.', false)));

module.exports = router;
