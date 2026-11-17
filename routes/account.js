// routes/account.js — the therapist's own account page: relaxation link, handing clients over to a
// colleague, and asking for the account to be closed. Carried over from the BYH app. Therapist only.
// Handover is done by the therapist, not the manager, because only the therapist can see who their clients are.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const mail = require('../lib/mail');
const brand = require('../lib/brand');
const { audit } = require('../lib/audit');
const { limited } = require('../lib/ratelimit');
const V = require('../views/pages');

const router = express.Router();
const th = A.requireRole('therapist', '/staff/therapist', V.forbidden);

const MSG = {
  sender_saved: ['Saved. Emails to your clients now come from your address.', true], sender_cleared: ['Removed. Emails to your clients come from the practice address again.', true],
  sender_bad: ['Check your email address.', false], sender_nokey: ['The password cannot be saved yet because the server has no secrets key. The address alone can be saved.', false],
  sender_tested: ['Test email sent to you. Check your inbox.', true], sender_failed: ['The test email could not be sent. The mail server may need your own mailbox password, or the address is not set up there.', false], sender_limited: ['Too many tests. Try again in a few minutes.', false],
  place_saved: ['Usual place saved.', true], place_bad: ['That place is not available.', false],
  details_saved: ['Your details are saved.', true], details_fee: ['Enter the fee like 60 or 60.50.', false],
  relax_saved: ['Relaxation link saved.', true], relax_cleared: ['Relaxation link removed.', true], relax_bad: ['That does not look like a web address.', false],
  handover_bad: ['Choose a colleague to hand over to.', false], handover_none: ['Choose at least one client to hand over.', false],
  close_asked: ['Your request has been sent to the practice manager. Nothing changes until they act on it.', true],
  close_withdrawn: ['Your request to close the account has been withdrawn.', true],
};

router.get('/therapist/account', th, async (req, res) => {
  const me = req.session.staff;
  const mine = await q(`SELECT id, name FROM clinical.clients WHERE therapist_id=$1 AND status <> 'closed' ORDER BY lower(name)`, [me.id]);
  const colleagues = await q(`SELECT id, name FROM core.staff WHERE role='therapist' AND status='active' AND id<>$1 ORDER BY lower(name)`, [me.id]);
  const key = String(req.query.msg || ''), moved = /^moved(\d{1,4})$/.exec(key);
  const [msg, ok] = moved ? [`${moved[1]} client${moved[1] === '1' ? '' : 's'} handed over. Each has been told by email.`, true] : (key === 'sender_bad' ? [String(req.query.why || 'Check your email address.').slice(0, 200), false] : (MSG[key] || []));
  const ms = await mail.getSettings();
  const domain = String(ms.from_address || '').split('@')[1] || '';
  res.status(ok === false ? 400 : 200).send(V.therapistAccount(me, mine, colleagues, msg, ok, { locs: await require('../lib/locations').active(), domain, practiceFrom: ms.from_address }));
});

router.post('/therapist/account', th, async (req, res) => {
  const me = req.session.staff, action = String(req.body.action || '');
  const done = m => res.redirect(`/therapist/account?msg=${m}`);
  const who = { actorType: 'staff', actorId: me.id };

  if (action === 'details') {
    const b = req.body, c = (v, n) => String(v || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, n) || null;
    const raw = String(b.default_fee || '').trim().replace(/^£/, '');
    if (raw && !/^\d{1,5}(\.\d{1,2})?$/.test(raw)) return done('details_fee');
    await q(`UPDATE core.staff SET qualifications=$2, address=$3, postcode=$4, phone=$5, default_fee_pence=$6 WHERE id=$1`,
      [me.id, c(b.qualifications, 200), c(b.address, 200), c(b.postcode, 20), c(b.phone, 40), raw ? Math.round(Number(raw) * 100) : null]);
    return done('details_saved');
  }
  if (action === 'sender') {
    const b = req.body;
    if (!String(b.sender_address || '').trim() && !String(b.sender_name || '').trim()) {
      await q(`UPDATE core.staff SET sender_name=NULL, sender_address=NULL, sender_password_enc=NULL WHERE id=$1`, [me.id]);
      await audit(req, 'account.sender_cleared', who); return done('sender_cleared');
    }
    const r = await mail.checkSender(b.sender_name, b.sender_address);
    if (r.error) return res.redirect(`/therapist/account?msg=sender_bad&why=${encodeURIComponent(r.error)}`);
    const pw = String(b.sender_password || '').slice(0, 500);
    if (pw && !require('../lib/secretbox').configured()) return done('sender_nokey');
    await q(`UPDATE core.staff SET sender_name=$2, sender_address=$3 WHERE id=$1`, [me.id, r.name || null, r.address]);
    if (pw) await q(`UPDATE core.staff SET sender_password_enc=$2 WHERE id=$1`, [me.id, require('../lib/secretbox').seal(pw)]);
    await audit(req, 'account.sender_saved', { ...who, detail: { password_changed: !!pw } });
    return done('sender_saved');
  }
  if (action === 'sender_test') {
    if (limited(`sendertest|${me.id}`, 10, 10 * 60 * 1000)) return done('sender_limited');
    try { await mail.sendFrom(me.id, me.email, 'Test email from your own address', mail.testEmail()); await audit(req, 'account.sender_tested', who); return done('sender_tested'); }
    catch (e) { console.error('[account] sender test failed:', e.message); return done('sender_failed'); }
  }
  if (action === 'place') {
    const id = Number(req.body.location) || 0;
    const l = id ? await one(`SELECT id FROM core.locations WHERE id=$1 AND active`, [id]) : null;
    if (id && !l) return done('place_bad');
    await q(`UPDATE core.staff SET default_location_id=$2 WHERE id=$1`, [me.id, l ? l.id : null]);
    return done('place_saved');
  }
  if (action === 'relax') {
    let url = String(req.body.relax_url || '').trim().slice(0, 500);
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url; // be forgiving about a missing https://
    if (url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw 0; url = u.href; } catch { return done('relax_bad'); } }
    await q(`UPDATE core.staff SET relax_url=$2 WHERE id=$1`, [me.id, url || null]);
    await audit(req, 'account.relax_link_changed', who);
    return done(url ? 'relax_saved' : 'relax_cleared');
  }

  if (action === 'handover') {
    const to = await one(`SELECT id, name FROM core.staff WHERE id=$1 AND role='therapist' AND status='active' AND id<>$2`, [Number(req.body.to) || 0, me.id]);
    if (!to) return done('handover_bad');
    const ids = [].concat(req.body.client_id || []).map(Number).filter(Number.isInteger);
    if (req.body.scope !== 'all' && !ids.length) return done('handover_none');
    // "therapist_id = me" in the UPDATE is the access rule: only this therapist's own clients can move.
    const moved = req.body.scope === 'all'
      ? await q(`UPDATE clinical.clients SET therapist_id=$2 WHERE therapist_id=$1 AND status <> 'closed' RETURNING id, name, email, status`, [me.id, to.id])
      : await q(`UPDATE clinical.clients SET therapist_id=$2 WHERE therapist_id=$1 AND id = ANY($3::int[]) RETURNING id, name, email, status`, [me.id, to.id, ids]);
    if (req.body.scope === 'all') await q(`UPDATE clinical.enquiries SET therapist_id=$2 WHERE therapist_id=$1 AND stage <> 'converted'`, [me.id, to.id]);
    for (const c of moved) {
      await audit(req, 'client.handed_over', { ...who, subjectType: 'client', subjectId: c.id, detail: { to: to.id } });
      if (c.status === 'closed') continue;
      try { await mail.sendMail(c.email, `A change at ${brand.BRAND.practiceName}`, mail.handoverEmail(c.name, to.name)); }
      catch (e) { console.error('[handover] email failed:', e.message); }
    }
    return done(moved.length ? `moved${moved.length}` : 'handover_none');
  }

  if (action === 'request_close') {
    if (!me.close_requested_at) {
      await q(`UPDATE core.staff SET close_requested_at=now() WHERE id=$1`, [me.id]);
      await audit(req, 'account.close_requested', who);
      const managers = await q(`SELECT DISTINCT email FROM core.staff WHERE role='practice_manager' AND status='active'`);
      for (const m of managers) {
        try { await mail.sendMail(m.email, `Request to close a therapist account`, mail.closeRequestEmail(me.name, `${process.env.BASE_URL}/staff`)); }
        catch (e) { console.error('[close-request] email failed:', e.message); }
      }
    }
    return done('close_asked');
  }
  if (action === 'withdraw_close') {
    await q(`UPDATE core.staff SET close_requested_at=NULL WHERE id=$1`, [me.id]);
    await audit(req, 'account.close_withdrawn', who);
    return done('close_withdrawn');
  }
  done('handover_bad');
});

module.exports = router;
