// routes/auth.js — sign-in, account choice, sign-out, settings, team, and the landing shells.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const { audit } = require('../lib/audit');
const { limited } = require('../lib/ratelimit');
const V = require('../views/pages');
const brand = require('../lib/brand');

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
      const [staff] = await A.accountsFor(email);
      if (staff) {
        const { code, id } = await A.issueStaffCode(staff);
        try {
          await mail.sendMail(staff.email, 'Your sign-in code', mail.staffCodeEmail(staff.name, code));
        } catch (e) { await A.voidToken(id); throw e; } // an undelivered code must not displace one that works
        await A.supersedeStaffCodes(email, id);
        await audit(req, 'staff.code_sent', { actorType: 'staff', actorId: staff.id });
      }
    } catch (e) { console.error('[auth] code request failed:', e.message); }
  }
  res.send(V.staffVerify(email));
});

const enter = (req, res, staff) =>
  startSession(req, res, { staffId: staff.id, role: staff.role }, 'staff.signed_in', { actorType: 'staff', actorId: staff.id, detail: { role: staff.role } })
    .then(() => res.redirect(landing(staff.role)));

router.post('/staff/verify', async (req, res) => {
  const email = norm(req.body.email);
  const fail = () => res.status(401).send(V.staffVerify(email, "That code didn't work or has expired."));
  if (limited(`verify|${req.ip}`, 20, 10 * 60 * 1000)) return fail();
  const accounts = await A.accountsFor(email);
  if (!accounts.length || !(await A.verifyStaffCode(email, String(req.body.code || '').trim()))) {
    await audit(req, 'staff.signin_failed', { actorType: 'staff', actorId: accounts[0] ? accounts[0].id : null });
    return fail();
  }
  if (accounts.length === 1) return enter(req, res, accounts[0]);
  // Two separate accounts under this address: choose which one to enter. No session exists yet.
  res.cookie('pick', await A.issuePick(accounts[0]), { httpOnly: true, signed: true, sameSite: 'lax', secure, maxAge: 5 * 60 * 1000 });
  res.redirect('/choose-account');
});

router.get('/choose-account', async (req, res) => {
  const email = await A.pickEmail(req.signedCookies && req.signedCookies.pick, false);
  if (!email) return res.redirect('/staff');
  res.send(V.chooseAccount(await A.accountsFor(email)));
});

router.post('/choose-account', async (req, res) => {
  const email = await A.pickEmail(req.signedCookies && req.signedCookies.pick, true);
  res.clearCookie('pick');
  if (!email) return res.redirect('/staff');
  const staff = (await A.accountsFor(email)).find(a => String(a.id) === String(req.body.account));
  if (!staff) return res.status(403).send(V.forbidden());
  return enter(req, res, staff);
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
      const client = await one(`SELECT * FROM clinical.clients WHERE lower(email)=$1 AND status IN ('active','readonly')`, [email]);
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
  const client = await one(`SELECT id FROM clinical.clients WHERE id=$1 AND status IN ('active','readonly')`, [claimed.client_id]);
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
  const client = await one(`SELECT id FROM clinical.clients WHERE id=$1 AND status IN ('active','readonly')`, [used.client_id]);
  if (!client) return res.status(400).send(V.linkExpired());
  await startSession(req, res, { clientId: client.id, role: 'client' }, 'client.signed_in', { actorType: 'client', actorId: client.id, detail: { via: 'link' } });
  res.redirect('/journal');
});

// ---------- common ----------
router.get('/ping', async (req, res) => { const s = await A.getSession(req); res.status(s ? 200 : 401).json({ ok: !!s }); });

router.get('/logout', async (req, res) => {
  const id = req.signedCookies && req.signedCookies.sid;
  // Staff go back to the team sign-in page, clients to theirs, so nobody types their address into the wrong one.
  const s = id ? await A.getSession(req) : null;
  if (id) await A.destroySession(id);
  res.clearCookie('sid');
  res.redirect(s && s.staff ? '/staff' : '/');
});

// ---------- landing shells (real screens arrive in later phases) ----------
const pm = A.requireRole('practice_manager', '/staff', V.forbidden);

router.get('/practice', pm, async (req, res) => {
  const m = await mail.getSettings();
  res.send(V.shell(req.session.staff.name, 'Practice manager', 'Set up the practice and manage the team here. Client records are not available in this account.', [
    { href: '/practice/settings/practice', label: 'Practice details (name and colour)' },
    { href: '/practice/settings/email', label: m.configured ? 'Email settings' : 'Set up email (needed before anyone can sign in by email)' },
    { href: '/practice/team', label: 'Team (add or remove therapists and managers)' },
  ]));
});

// ---------- team: the practice manager adds, changes and removes accounts ----------
// Nothing here reads client records. Where a therapist has clients, only the COUNT is shown.
const ROLES = { therapist: 'Therapist', practice_manager: 'Practice manager' };
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const cleanName = v => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);

async function teamPage(req, res, msg, ok) {
  const team = await q(`SELECT s.id, s.name, s.email, s.role, s.status, s.invited_at, s.close_requested_at,
      (SELECT count(*)::int FROM clinical.clients c WHERE c.therapist_id = s.id AND c.status <> 'closed') AS clients
    FROM core.staff s WHERE s.status <> 'removed' ORDER BY s.role DESC, lower(s.name)`);
  res.status(ok === false ? 400 : 200).send(V.team(team, req.session.staff.id, msg, ok));
}

async function sendInvite(staff) {
  try {
    await mail.sendMail(staff.email, `You've been added to ${brand.BRAND.practiceName}`, mail.inviteEmail(staff.name, ROLES[staff.role], `${process.env.BASE_URL}/staff`));
    await q(`UPDATE core.staff SET invited_at=now() WHERE id=$1`, [staff.id]);
    return true;
  } catch (e) { console.error('[team] invite failed:', e.message); return false; }
}

router.get('/practice/team', pm, (req, res) => teamPage(req, res));

router.post('/practice/team/add', pm, async (req, res) => {
  const name = cleanName(req.body.name), email = norm(req.body.email), role = String(req.body.role || '');
  if (!name) return teamPage(req, res, 'Enter a name.', false);
  if (!EMAIL_RE.test(email)) return teamPage(req, res, 'Enter a valid email address.', false);
  if (!ROLES[role]) return teamPage(req, res, 'Choose the type of account.', false);
  const existing = await one(`SELECT id, status FROM core.staff WHERE lower(email)=$1 AND role=$2`, [email, role]);
  if (existing && existing.status !== 'removed') return teamPage(req, res, `That address already has a ${ROLES[role].toLowerCase()} account.`, false);
  const [staff] = existing
    ? await q(`UPDATE core.staff SET name=$2, status='active', invited_at=NULL WHERE id=$1 RETURNING *`, [existing.id, name])
    : await q(`INSERT INTO core.staff (name, email, role) VALUES ($1,$2,$3) RETURNING *`, [name, email, role]);
  await audit(req, 'team.added', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'staff', subjectId: staff.id, detail: { role } });
  const sent = await sendInvite(staff);
  teamPage(req, res, sent ? `${name} was added and has been emailed an invitation.` : `${name} was added, but the invitation email could not be sent. Check the email settings, then use "Send invitation again".`, true);
});

router.post('/practice/team/:id', pm, async (req, res) => {
  const me = req.session.staff, action = String(req.body.action || '');
  const staff = await one(`SELECT * FROM core.staff WHERE id=$1 AND status <> 'removed'`, [Number(req.params.id) || 0]);
  if (!staff) return teamPage(req, res, 'That account no longer exists.', false);
  const log = (what, detail) => audit(req, what, { actorType: 'staff', actorId: me.id, subjectType: 'staff', subjectId: staff.id, detail });

  if (action === 'invite') {
    if (staff.status !== 'active') return teamPage(req, res, 'Reactivate the account before sending an invitation.', false);
    const sent = await sendInvite(staff);
    if (sent) await log('team.invited');
    return teamPage(req, res, sent ? `Invitation sent to ${staff.name}.` : 'The invitation email could not be sent. Check the email settings.', sent);
  }
  if (action === 'edit') {
    const name = cleanName(req.body.name), email = norm(req.body.email);
    if (!name || !EMAIL_RE.test(email)) return teamPage(req, res, 'Enter a name and a valid email address.', false);
    if (await one(`SELECT 1 FROM core.staff WHERE lower(email)=$1 AND role=$2 AND id<>$3`, [email, staff.role, staff.id])) return teamPage(req, res, `That address already has a ${ROLES[staff.role].toLowerCase()} account.`, false);
    const emailChanged = email !== staff.email.toLowerCase();
    await q(`UPDATE core.staff SET name=$2, email=$3 WHERE id=$1`, [staff.id, name, email]);
    if (emailChanged) await A.endStaffSessions(staff.id); // a new address must prove itself with a fresh sign-in
    await log('team.edited', { email_changed: emailChanged });
    return teamPage(req, res, emailChanged && staff.id === me.id ? 'Saved. Sign in again with the new address.' : 'Saved.', true);
  }
  // The remaining actions change who can get in. You cannot do them to the account you are signed in with,
  // so a practice can never be left with no working practice manager.
  if (staff.id === me.id) return teamPage(req, res, 'You cannot suspend or remove the account you are signed in with. Ask another practice manager.', false);
  if (action === 'reactivate') {
    await q(`UPDATE core.staff SET status='active', close_requested_at=NULL WHERE id=$1`, [staff.id]);
    await log('team.reactivated');
    return teamPage(req, res, `${staff.name} can sign in again.`, true);
  }
  if (action === 'suspend') {
    await q(`UPDATE core.staff SET status='suspended' WHERE id=$1`, [staff.id]);
    await A.endStaffSessions(staff.id);
    await log('team.suspended');
    return teamPage(req, res, `${staff.name} is suspended and has been signed out. Their clients stay with them.`, true);
  }
  if (action === 'remove') {
    const [{ n }] = await q(`SELECT count(*)::int n FROM clinical.clients WHERE therapist_id=$1 AND status <> 'closed'`, [staff.id]);
    let moved = 0;
    if (n > 0) {
      const to = await one(`SELECT id, name FROM core.staff WHERE id=$1 AND role='therapist' AND status='active' AND id<>$2`, [Number(req.body.reassign_to) || 0, staff.id]);
      if (!to) return teamPage(req, res, `${staff.name} has ${n} client${n === 1 ? '' : 's'}. Choose the therapist who will take them over, then remove.`, false);
      moved = (await q(`UPDATE clinical.clients SET therapist_id=$2 WHERE therapist_id=$1 RETURNING id`, [staff.id, to.id])).length;
      await audit(req, 'team.clients_reassigned', { actorType: 'staff', actorId: me.id, subjectType: 'staff', subjectId: to.id, detail: { from: staff.id, count: moved } });
    }
    await q(`UPDATE core.staff SET status='removed', close_requested_at=NULL, cal_feed_hash=NULL WHERE id=$1`, [staff.id]);
    await A.endStaffSessions(staff.id);
    await log('team.removed');
    return teamPage(req, res, `${staff.name} was removed.${moved ? ` ${moved} client${moved === 1 ? ' was' : 's were'} moved to the therapist you chose.` : ''}`, true);
  }
  teamPage(req, res, 'Unknown action.', false);
});

// ---------- settings: practice name and colour ----------
const brandNow = () => ({ practice_name: brand.BRAND.practiceName, practice_short: brand.BRAND.practiceShort, color_primary: brand.BRAND.colorPrimary });
router.get('/practice/settings/practice', pm, (_req, res) => res.send(V.practiceSettings(brandNow())));

router.post('/practice/settings/practice', pm, async (req, res) => {
  const { error, values } = brand.validate(req.body);
  if (error) return res.status(400).send(V.practiceSettings({ practice_name: req.body.practice_name, practice_short: req.body.practice_short, color_primary: brand.BRAND.colorPrimary }, error, false));
  await brand.save(values, req.session.staff.id);
  await audit(req, 'practice.settings_saved', { actorType: 'staff', actorId: req.session.staff.id });
  res.send(V.practiceSettings(brandNow(), 'Saved.', true));
});

// ---------- settings: the practice's outgoing mailbox ----------
router.get('/practice/settings/email', pm, async (req, res) => res.send(V.mailSettings(await mail.getSettings(), req.session.staff.email)));

router.post('/practice/settings/email', pm, async (req, res) => {
  const test = req.body.action === 'test';
  const { error, values } = mail.validate(req.body);
  const again = async (msg, ok) => res.status(ok ? 200 : 400).send(V.mailSettings(
    { ...(await mail.getSettings()), ...(values || {}), ...(error ? { smtp_host: req.body.smtp_host, smtp_port: req.body.smtp_port, smtp_user: req.body.smtp_user, from_name: req.body.from_name, from_address: req.body.from_address } : {}) },
    req.session.staff.email, msg, ok, keepTyped ? String(req.body.smtp_password || '').slice(0, 500) : ''));
  // After a test or a rejected form, hand back the password the person just typed so they need not retype it
  // before saving. Only ever what came in on this request; the saved password is never sent to a browser.
  let keepTyped = true;
  if (error) return again(error, false);
  const who = { actorType: 'staff', actorId: req.session.staff.id };
  if (test) {
    if (limited(`mailtest|${req.session.staff.id}`, 10, 10 * 60 * 1000)) return again('Too many test emails. Try again in a few minutes.', false);
    try {
      await mail.sendMail(req.session.staff.email, 'Test email', mail.testEmail(), values);
      await audit(req, 'mail.test_sent', who);
      return again(`Test email sent to ${req.session.staff.email}. These settings are not saved until you press Save.`, true);
    } catch (e) {
      await audit(req, 'mail.test_failed', who);
      return again(`The test email could not be sent: ${e.message}`, false);
    }
  }
  const saved = await mail.saveSettings(values, req.session.staff.id);
  if (saved.error) return again(saved.error, false);
  keepTyped = false;
  await audit(req, 'mail.settings_saved', { ...who, detail: { host: values.smtp_host, port: values.smtp_port, from: values.from_address, password_changed: !!values.password } });
  again('Saved.', true);
});

router.get('/journal', A.requireRole('client', '/', V.forbidden), (req, res) =>
  res.send(V.shell(req.session.client.name, 'Client', 'Your journal will appear here.')));

module.exports = router;
