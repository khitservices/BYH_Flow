// routes/auth.js — sign-in, account choice, sign-out, settings, team, and the landing shells.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const { audit } = require('../lib/audit');
const { limited } = require('../lib/ratelimit');
const V = require('../views/pages');
const T = require('../lib/time');
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
router.get('/staff/therapist', (_req, res) => res.send(V.staffLogin('therapist')));
router.get('/staff/practice', (_req, res) => res.send(V.staffLogin('practice_manager')));
const asKind = v => (v === 'therapist' || v === 'practice_manager' ? v : undefined);

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
  res.send(V.staffVerify(email, undefined, asKind(req.body.as)));
});

const enter = (req, res, staff) =>
  startSession(req, res, { staffId: staff.id, role: staff.role }, 'staff.signed_in', { actorType: 'staff', actorId: staff.id, detail: { role: staff.role } })
    .then(() => { const back = staff.role === 'therapist' && req.signedCookies && req.signedCookies.appnext; if (back) res.clearCookie('appnext'); res.redirect(back ? '/therapist/enquiries/new' : landing(staff.role)); });

router.post('/staff/verify', async (req, res) => {
  const email = norm(req.body.email);
  const fail = () => res.status(401).send(V.staffVerify(email, "That code didn't work or has expired.", asKind(req.body.as)));
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
      const client = await one(`SELECT * FROM clinical.clients WHERE lower(email)=$1 AND status IN ('consultation','attended','active','readonly')`, [email]);
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
  const client = await one(`SELECT id FROM clinical.clients WHERE id=$1 AND status IN ('consultation','attended','active','readonly')`, [claimed.client_id]);
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
  const client = await one(`SELECT id FROM clinical.clients WHERE id=$1 AND status IN ('consultation','attended','active','readonly')`, [used.client_id]);
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
const pm = A.requireRole('practice_manager', '/staff/practice', V.forbidden);

router.get('/practice', pm, async (req, res) => {
  const m = await mail.getSettings();
  const d = await one(`SELECT (SELECT count(*) FROM core.programmes WHERE active)::int AS programmes, (SELECT count(*) FROM core.form_templates WHERE active)::int AS forms,
    (SELECT count(*) FROM core.staff WHERE role='therapist' AND status <> 'removed' AND close_requested_at IS NOT NULL)::int AS close_requests`);
  res.send(V.practiceHome({ who: req.session.staff.name, stats: await require('../lib/stats').practiceStats(), mailOk: !!m.configured, programmes: d.programmes, forms: d.forms, closeRequests: d.close_requests }));
});

router.get('/practice/stats', pm, async (_req, res) => res.send(V.practiceStats(await require('../lib/stats').practiceStats())));

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
    const [{ k }] = await q(`SELECT count(*)::int k FROM clinical.enquiries WHERE therapist_id=$1 AND stage <> 'converted'`, [staff.id]);
    let moved = 0;
    if (n + k > 0) {
      const to = await one(`SELECT id, name FROM core.staff WHERE id=$1 AND role='therapist' AND status='active' AND id<>$2`, [Number(req.body.reassign_to) || 0, staff.id]);
      if (!to) return teamPage(req, res, `${staff.name} has ${n} client${n === 1 ? '' : 's'} and ${k} open enquir${k === 1 ? 'y' : 'ies'}. Choose the therapist who will take them over, then remove.`, false);
      moved = (await q(`UPDATE clinical.clients SET therapist_id=$2 WHERE therapist_id=$1 RETURNING id`, [staff.id, to.id])).length;
      await q(`UPDATE clinical.enquiries SET therapist_id=$2 WHERE therapist_id=$1 AND stage <> 'converted'`, [staff.id, to.id]);
      await audit(req, 'team.clients_reassigned', { actorType: 'staff', actorId: me.id, subjectType: 'staff', subjectId: to.id, detail: { from: staff.id, count: moved } });
    }
    await q(`UPDATE core.staff SET status='removed', close_requested_at=NULL, cal_feed_hash=NULL WHERE id=$1`, [staff.id]);
    await A.endStaffSessions(staff.id);
    await log('team.removed');
    return teamPage(req, res, `${staff.name} was removed.${moved ? ` ${moved} client${moved === 1 ? ' was' : 's were'} moved to the therapist you chose.` : ''}`, true);
  }
  teamPage(req, res, 'Unknown action.', false);
});

// The logo is public on purpose: it is on the sign-in pages and in emails, before anyone has signed in.
router.get('/brand/logo', async (_req, res) => {
  const l = await brand.getLogo();
  if (!l) return res.status(404).end();
  res.set({ 'Content-Type': l.logo_type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }).send(l.logo);
});
const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: brand.MAX_LOGO + 1, files: 1, fields: 4 } });
router.post('/practice/settings/logo', pm, (req, res, next) => upload.single('logo')(req, res, err => {
  if (err) return res.status(400).send(V.practiceSettings(brandNow(), 'That picture is too large. Use one under 500 KB.', false));
  next();
}), async (req, res) => {
  const who = { actorType: 'staff', actorId: req.session.staff.id };
  if (req.body && req.body.action === 'remove') { await brand.removeLogo(req.session.staff.id); await audit(req, 'practice.logo_removed', who); return res.send(V.practiceSettings(brandNow(), 'Logo removed.', true)); }
  if (!req.file) return res.status(400).send(V.practiceSettings(brandNow(), 'Choose a picture to upload.', false));
  const r = await brand.saveLogo(req.file.buffer, req.session.staff.id);
  if (r.error) return res.status(400).send(V.practiceSettings(brandNow(), r.error, false));
  await audit(req, 'practice.logo_saved', who);
  res.send(V.practiceSettings(brandNow(), 'Logo saved.', true));
});

// ---------- settings: practice name and colour ----------
const brandNow = () => ({ practice_name: brand.BRAND.practiceName, practice_short: brand.BRAND.practiceShort, color_primary: brand.BRAND.colorPrimary });
router.get('/practice/settings/practice', pm, (_req, res) => res.send(V.practiceSettings(brandNow())));

router.post('/practice/settings/practice', pm, async (req, res) => {
  const { error, values } = brand.validate(req.body);
  if (error) return res.status(400).send(V.practiceSettings({ practice_name: req.body.practice_name, practice_short: req.body.practice_short, color_primary: req.body.color_primary }, error, false));
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

router.get('/journal', A.requireRole('client', '/', V.forbidden), async (req, res) => {
  const id = req.session.client.id;
  const c = await one(`SELECT c.*, s.name AS therapist, s.relax_url FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [id]);
  const forms = await q(`SELECT id, template_name, audience, status, sent_at, signed_at FROM documents.forms WHERE client_id=$1 AND status <> 'void' ORDER BY id`, [id]);
  const next = await one(`SELECT min(starts_at) AS at FROM clinical.appointments WHERE client_id=$1 AND status='booked' AND starts_at > now()`, [id]);
  const held = (await one(`SELECT count(*)::int n FROM clinical.appointments a JOIN clinical.clients c ON c.id=a.client_id WHERE a.client_id=$1 AND a.block_id IS NOT DISTINCT FROM c.current_block_id AND a.status='booked' AND a.starts_at <= now()`, [id])).n;
  const blocks = await require('../lib/blocks').blocksFor(id);
  const sc = (await scores.series(id, 1))[0].score;
  res.send(V.clientHome({ score: sc, who: c.name, blocks, blockName: c.programme_name, therapist: c.therapist, relax: c.relax_url, forms, next: next.at ? T.when(next.at) : null,
    ic: c.ic_at ? T.when(c.ic_at) : null, pre: c.status === 'consultation' || c.status === 'attended',
    pos: c.programme_sessions ? { on: Math.min(c.sessions_before_app + held + 1, c.programme_sessions), of: c.programme_sessions } : null }));
});

// ---- client: my sessions, and asking to rearrange ----
const myClient = A.requireRole('client', '/', V.forbidden);
const CMSG = { asked: ['Your therapist has been asked. They will be in touch to arrange it.', true], withdrawn: ['Request withdrawn.', true], gone: ['That appointment is not available to change.', false] };
async function sessionsData(id) {
  const c = await one(`SELECT c.*, s.name AS therapist FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [id]);
  const appts = await q(`SELECT id, starts_at, status, location_name, location_address, location_kind, change_requested_at, change_request_kind, change_request_reason FROM clinical.appointments WHERE client_id=$1 AND status='booked' ORDER BY starts_at`, [id]);
  return { c, ic: c.ic_at && ['consultation', 'attended'].includes(c.status) ? { when: T.when(c.ic_at), future: c.ic_at > new Date(), asked: !!c.ic_change_requested_at, kind: c.ic_change_kind, reason: c.ic_change_reason } : null,
    upcoming: appts.filter(a => a.starts_at > new Date()).map(a => ({ id: a.id, when: T.when(a.starts_at), where: require('../lib/locations').label(a), asked: !!a.change_requested_at, kind: a.change_request_kind, reason: a.change_request_reason })),
    past: appts.filter(a => a.starts_at <= new Date()).reverse().map(a => ({ when: T.when(a.starts_at) })), canAsk: c.status !== 'readonly' };
}
const scores = require('../lib/scores');
const scoreOK = c => c && c.status !== 'readonly';
router.get('/journal/score', myClient, async (req, res) => {
  const c = await one(`SELECT c.name, c.status, s.name AS therapist FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [req.session.client.id]);
  if (!scoreOK(c)) return res.redirect('/journal');
  const m = { saved: ['Saved. Thank you.', true], bad: ['Choose a score from 1 to 10.', false] }[String(req.query.msg || '')] || [];
  const series = await scores.series(req.session.client.id);
  res.send(V.clientScorePage({ who: c.name, therapist: c.therapist, series, note: series[series.length - 1].note }, m[0], m[1]));
});
router.post('/journal/score', myClient, async (req, res) => {
  const id = req.session.client.id, c = await one(`SELECT status FROM clinical.clients WHERE id=$1`, [id]);
  if (!scoreOK(c)) return res.redirect('/journal');
  res.redirect(`/journal/score?msg=${(await scores.save(id, req.body.score, req.body.note)) ? 'saved' : 'bad'}`);
});
// ---- client: private journal. Content and files are for the signed-in client only; therapists see counts (lib/journal.js counts()). ----
const journal = require('../lib/journal');
const jUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: journal.MAX_FILE, files: 1, fields: 4, parts: 6 } });
const JMSG = { saved: ['Saved to your journal.', true], empty: ['Write something or choose a file first.', false], file: ['That file could not be added. Use a photo, PDF, Word document or text file up to 15 MB.', false], big: ['That file is too large. The limit is 15 MB.', false], edited: ['Your entry has been changed.', true], locked: ['That entry can no longer be changed.', false] };
const jClient = id => one(`SELECT c.id, c.name, c.status, c.current_block_id, s.name AS therapist FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [id]);
const jCanAdd = c => c && c.status === 'active';
// Entries sit under the next booked session after they were written, so they read as preparation for it.
async function jGroups(c, items) {
  const appts = await q(`SELECT starts_at FROM clinical.appointments WHERE client_id=$1 AND status='booked' ORDER BY starts_at`, [c.id]);
  const groups = [];
  for (const e of items) {
    const t = appts.find(a => a.starts_at >= e.created_at);
    const label = t ? `Leading up to your session on ${T.dateLong(t.starts_at)}` : 'After your last booked session';
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push({ ...e, when: T.when(e.created_at) });
  }
  return groups;
}
router.get('/journal/entries', myClient, async (req, res) => {
  const c = await jClient(req.session.client.id), m = JMSG[String(req.query.msg || '')] || [];
  const earlier = (await one(`SELECT count(*)::int n FROM clinical.journal_entries WHERE client_id=$1 AND block_id IS DISTINCT FROM $2`, [c.id, c.current_block_id])).n;
  res.status(m[1] === false ? 400 : 200).send(V.clientJournalPage({ who: c.name, therapist: c.therapist, canAdd: jCanAdd(c), maxBody: journal.MAX_BODY, earlier: earlier > 0,
    groups: await jGroups(c, await journal.entries(c.id, c.current_block_id, true)) }, m[0], m[1]));
});
router.post('/journal/entries', myClient, (req, res, next) => jUpload.single('file')(req, res, err => err ? res.redirect('/journal/entries?msg=big') : next()), async (req, res) => {
  const c = await jClient(req.session.client.id);
  if (!jCanAdd(c)) return res.redirect('/journal/entries');
  const r = await journal.add(c, req.body.body, req.file);
  res.redirect(`/journal/entries?msg=${r.error || 'saved'}`);
});
router.get('/journal/entries/:id/edit', myClient, async (req, res) => {
  const c = await jClient(req.session.client.id), e = await journal.entries(c.id, c.current_block_id, true).then(l => l.find(x => String(x.id) === req.params.id));
  if (!jCanAdd(c) || !e || !e.editable_now) return res.redirect('/journal/entries?msg=locked');
  res.send(V.clientJournalEditPage({ id: e.id, body: e.body, when: T.when(e.created_at), who: c.name, maxBody: journal.MAX_BODY }));
});
router.post('/journal/entries/:id/edit', myClient, async (req, res) => {
  const c = await jClient(req.session.client.id);
  if (!jCanAdd(c) || !/^\d+$/.test(req.params.id)) return res.redirect('/journal/entries?msg=locked');
  const r = await journal.edit(c.id, req.params.id, req.body.body);
  res.redirect(`/journal/entries?msg=${r === 'saved' ? 'edited' : r === 'empty' ? 'empty' : 'locked'}`);
});
router.get('/journal/earlier', myClient, async (req, res) => {
  const c = await jClient(req.session.client.id);
  res.send(V.clientJournalEarlierPage({ who: c.name, groups: await jGroups(c, await journal.entries(c.id, c.current_block_id, false)) }));
});
router.get('/journal/file/:id', myClient, async (req, res) => {
  const f = /^\d+$/.test(req.params.id) ? await journal.file(req.session.client.id, req.params.id) : null;
  if (!f) return res.status(404).send(V.forbidden());
  res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', ...(f.mime === 'application/pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'" }), 'Content-Disposition': `${f.inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^A-Za-z0-9._ -]/g, '_')}"` }).send(f.buffer);
});
// ---- client: support numbers and the relaxation recording ----
router.get('/journal/support', myClient, async (req, res) => {
  const c = await one(`SELECT c.name, c.under16, s.name AS therapist FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [req.session.client.id]);
  res.send(V.clientSupportPage({ who: c.name, therapist: c.therapist, childline: !!c.under16 }));
});
router.get('/journal/relax', myClient, async (req, res) => {
  const c = await one(`SELECT c.name, s.name AS therapist, s.relax_url FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [req.session.client.id]);
  res.send(V.clientRelaxPage({ who: c.name, therapist: c.therapist, url: c.relax_url }));
});
// ---- client: account, requests about their information, help ----
const DMSG = { copy: ['Your request for a copy of your information has been passed to your therapist.', true], delete: ['Your request to delete your information has been passed to your therapist.', true],
  already: ['You already have that request open. Your therapist has it.', false], limited: ['Too many requests. Please try again later.', false], gone: ['That is not available.', false] };
const myAccount = async id => {
  const c = await one(`SELECT c.name, c.email, c.under16, c.guardian_email, c.status, s.name AS therapist FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [id]);
  return { c, requests: await q(`SELECT kind, created_at, handled_at FROM clinical.data_requests WHERE client_id=$1 ORDER BY id DESC LIMIT 10`, [id]) };
};
router.get('/journal/account', myClient, async (req, res) => {
  const [msg, ok] = DMSG[String(req.query.msg || '')] || [], d = await myAccount(req.session.client.id);
  res.send(V.clientAccountPage({ ...d.c, requests: d.requests.map(r => ({ kind: r.kind, when: T.when(r.created_at), done: !!r.handled_at })) }, msg, ok));
});
router.post('/journal/account', myClient, async (req, res) => {
  const id = req.session.client.id, kind = req.body.kind === 'delete' ? 'delete' : req.body.kind === 'copy' ? 'copy' : null;
  if (!kind) return res.redirect('/journal/account?msg=gone');
  if (require('../lib/ratelimit').limited(`datareq|${id}`, 5, 24 * 3600000)) return res.redirect('/journal/account?msg=limited');
  const c = await one(`SELECT therapist_id FROM clinical.clients WHERE id=$1`, [id]);
  if (await one(`SELECT 1 FROM clinical.data_requests WHERE client_id=$1 AND kind=$2 AND handled_at IS NULL`, [id, kind])) return res.redirect('/journal/account?msg=already');
  const note = String(req.body.note || '').replace(/[\r\t]/g, ' ').trim().slice(0, 500) || null;
  await q(`INSERT INTO clinical.data_requests (client_id, kind, note) VALUES ($1,$2,$3)`, [id, kind, note]);
  await audit(req, 'client.data_request', { actorType: 'client', actorId: id, subjectType: 'client', subjectId: id, detail: { kind } });
  await require('../lib/notify').queueNotice(c.therapist_id, 'data');
  res.redirect(`/journal/account?msg=${kind}`);
});
router.get('/journal/help', myClient, async (req, res) => {
  const c = await one(`SELECT c.name, s.name AS therapist, s.relax_url FROM clinical.clients c JOIN core.staff s ON s.id=c.therapist_id WHERE c.id=$1`, [req.session.client.id]);
  res.send(V.clientHelpPage({ who: c.name, therapist: c.therapist, relax: c.relax_url }));
});
router.get('/journal/sessions', myClient, async (req, res) => {
  const [msg, ok] = CMSG[String(req.query.msg || '')] || [];
  res.send(V.clientSessionsPage(await sessionsData(req.session.client.id), msg, ok));
});
router.post('/journal/sessions', myClient, async (req, res) => {
  const id = req.session.client.id, b = req.body, withdraw = b.action === 'withdraw';
  const c = await one(`SELECT * FROM clinical.clients WHERE id=$1`, [id]);
  if (c.status === 'readonly') return res.redirect('/journal/sessions?msg=gone');
  const kind = b.kind === 'cancel' ? 'cancel' : 'reschedule', reason = String(b.reason || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 300) || null;
  let found = false;
  if (b.target === 'ic') {
    found = !!(c.ic_at && c.ic_at > new Date() && ['consultation', 'attended'].includes(c.status));
    if (found) await q(withdraw ? `UPDATE clinical.clients SET ic_change_requested_at=NULL, ic_change_kind=NULL, ic_change_reason=NULL WHERE id=$1` : `UPDATE clinical.clients SET ic_change_requested_at=now(), ic_change_kind=$2, ic_change_reason=$3 WHERE id=$1`, withdraw ? [id] : [id, kind, reason]);
  } else {
    const a = await one(`SELECT id FROM clinical.appointments WHERE id=$1 AND client_id=$2 AND status='booked' AND starts_at > now()`, [Number(b.target) || 0, id]);   // only their own, still to come
    found = !!a;
    if (a) await q(withdraw ? `UPDATE clinical.appointments SET change_requested_at=NULL, change_request_kind=NULL, change_request_reason=NULL WHERE id=$1` : `UPDATE clinical.appointments SET change_requested_at=now(), change_request_kind=$2, change_request_reason=$3 WHERE id=$1`, withdraw ? [a.id] : [a.id, kind, reason]);
  }
  if (!found) return res.redirect('/journal/sessions?msg=gone');
  await audit(req, withdraw ? 'client.change_withdrawn' : 'client.change_requested', { actorType: 'client', actorId: id, subjectType: 'client', subjectId: id, detail: { target: b.target === 'ic' ? 'consultation' : 'session', kind: withdraw ? null : kind } });
  if (!withdraw) {
    await require('../lib/notify').queueNotice(c.therapist_id, 'change');
  }
  res.redirect(`/journal/sessions?msg=${withdraw ? 'withdrawn' : 'asked'}`);
});

module.exports = router;
