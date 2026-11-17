// lib/auth.js — sign-in codes and links, sessions, role guards.
require('dotenv').config();
const crypto = require('crypto');
const { q, one } = require('./db');

const IDLE_MS = 30 * 60 * 1000;          // 30 minutes of inactivity
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // hard cap, however active
const CODE_TTL_MS = 10 * 60 * 1000;
const LINK_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ characters)');
  return s;
}
const hash = v => crypto.createHmac('sha256', secret()).update(String(v)).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const safeEqual = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };

// ---- staff: 6-digit emailed code ----
// A code belongs to an email address, not to one account: a person with a practice manager account and a
// therapist account under the same address gets one code, then chooses which account to enter.
// `staff` is any active account with that address (the token row needs one to hang from).
//
// Earlier codes are NOT voided here: the caller does that once the new code has actually been delivered
// (supersedeStaffCodes), or voids the new one if sending failed (voidToken). That way a code printed by
// scripts/signin-code.js still works when the mailbox is not set up or is broken.
const lc = e => String(e || '').trim().toLowerCase();
const accountsFor = email => q(`SELECT * FROM core.staff WHERE lower(email)=$1 AND status='active' ORDER BY role DESC, id`, [lc(email)]);

async function issueStaffCode(staff, ttlMs = CODE_TTL_MS) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const r = await q(`INSERT INTO core.auth_tokens (kind, staff_id, secret_hash, expires_at) VALUES ('staff_code',$1,$2,$3) RETURNING id`,
    [staff.id, hash(`${lc(staff.email)}:${code}`), new Date(Date.now() + ttlMs)]);
  return { code, id: r[0].id };
}
const supersedeStaffCodes = (email, keepId) =>
  q(`UPDATE core.auth_tokens t SET used_at=now() FROM core.staff s WHERE t.staff_id=s.id AND lower(s.email)=$1
     AND t.kind='staff_code' AND t.id<>$2 AND t.used_at IS NULL`, [lc(email), keepId]);
const voidToken = id => q(`UPDATE core.auth_tokens SET used_at=now() WHERE id=$1 AND used_at IS NULL`, [id]);

async function verifyStaffCode(email, code) {
  const t = await one(`SELECT t.* FROM core.auth_tokens t JOIN core.staff s ON s.id=t.staff_id
                       WHERE t.kind='staff_code' AND lower(s.email)=$1 AND s.status='active' AND t.used_at IS NULL
                       AND t.expires_at > now() ORDER BY t.id DESC LIMIT 1`, [lc(email)]);
  if (!t) return false;
  if (t.attempts >= MAX_CODE_ATTEMPTS) { await q(`UPDATE core.auth_tokens SET used_at=now() WHERE id=$1`, [t.id]); return false; }
  const ok = /^\d{6}$/.test(String(code)) && safeEqual(t.secret_hash, hash(`${lc(email)}:${code}`));
  if (!ok) { await q(`UPDATE core.auth_tokens SET attempts=attempts+1 WHERE id=$1`, [t.id]); return false; }
  const used = await q(`UPDATE core.auth_tokens SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id`, [t.id]);
  return used.length === 1;
}

// After a correct code, when the address has more than one account: a 5-minute, single-use ticket that
// lets the browser choose one of those accounts. It never grants access to anything by itself.
async function issuePick(staff) {
  const ticket = random();
  await q(`INSERT INTO core.auth_tokens (kind, staff_id, secret_hash, expires_at) VALUES ('staff_pick',$1,$2,$3)`,
    [staff.id, hash(ticket), new Date(Date.now() + 5 * 60 * 1000)]);
  return ticket;
}
const pickEmail = async (ticket, consume) => {
  const sql = consume
    ? `UPDATE core.auth_tokens t SET used_at=now() FROM core.staff s WHERE s.id=t.staff_id AND t.kind='staff_pick' AND t.secret_hash=$1
       AND t.used_at IS NULL AND t.expires_at > now() RETURNING s.email`
    : `SELECT s.email FROM core.auth_tokens t JOIN core.staff s ON s.id=t.staff_id WHERE t.kind='staff_pick' AND t.secret_hash=$1
       AND t.used_at IS NULL AND t.expires_at > now()`;
  const r = await q(sql, [hash(String(ticket || ''))]);
  return r[0] ? r[0].email : null;
};

// ---- clients: emailed link, plus a poll key so an installed phone app can finish its own sign-in ----
async function issueClientLink(client, pollKey) {
  const token = random();
  await q(`INSERT INTO core.auth_tokens (kind, client_id, secret_hash, poll_hash, expires_at) VALUES ('client_link',$1,$2,$3,$4)`,
    [client.id, hash(token), hash(pollKey), new Date(Date.now() + LINK_TTL_MS)]);
  return token;
}
const peekClientLink = token => one(`SELECT id FROM core.auth_tokens WHERE kind='client_link' AND secret_hash=$1
                                     AND used_at IS NULL AND expires_at > now()`, [hash(token)]);
async function consumeClientLink(token) {
  const r = await q(`UPDATE core.auth_tokens SET used_at=now() WHERE kind='client_link' AND secret_hash=$1
                     AND used_at IS NULL AND expires_at > now() RETURNING client_id`, [hash(token)]);
  return r[0] || null;
}
async function claimPoll(pollKey) {
  const r = await q(`UPDATE core.auth_tokens SET poll_claimed_at=now() WHERE id = (
      SELECT id FROM core.auth_tokens WHERE kind='client_link' AND poll_hash=$1 AND used_at IS NOT NULL
      AND poll_claimed_at IS NULL AND used_at > now() - interval '5 minutes' ORDER BY id DESC LIMIT 1)
    RETURNING client_id`, [hash(pollKey)]);
  return r[0] || null;
}

// ---- sessions ----
async function createSession({ staffId = null, clientId = null, role = null }) {
  const id = random(); // fresh id at every sign-in
  await q(`INSERT INTO core.sessions (id_hash, staff_id, client_id, active_role, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [hash(id), staffId, clientId, role, new Date(Date.now() + IDLE_MS)]);
  return id;
}

async function getSession(req) {
  const id = req.signedCookies && req.signedCookies.sid;
  if (!id) return null;
  const s = await one(`SELECT * FROM core.sessions WHERE id_hash=$1`, [hash(id)]);
  if (!s) return null;
  const now = Date.now();
  if (new Date(s.expires_at).getTime() < now || new Date(s.created_at).getTime() + ABSOLUTE_MS < now) {
    await q(`DELETE FROM core.sessions WHERE id_hash=$1`, [s.id_hash]);
    return null;
  }
  let staff = null, client = null;
  if (s.staff_id) {
    staff = await one(`SELECT * FROM core.staff WHERE id=$1 AND status='active'`, [s.staff_id]);
    if (!staff) return null;
  } else {
    client = await one(`SELECT * FROM clinical.clients WHERE id=$1 AND status IN ('consultation','attended','active','readonly')`, [s.client_id]);
    if (!client) return null;
  }
  if (new Date(s.expires_at).getTime() - now < IDLE_MS - 60000) { // slide the idle window, at most once a minute
    await q(`UPDATE core.sessions SET expires_at=$2 WHERE id_hash=$1`, [s.id_hash, new Date(now + IDLE_MS)]);
  }
  // A staff session's role is always the account's own role; it cannot be switched.
  return { idHash: s.id_hash, role: staff ? staff.role : 'client', staff, client };
}

const destroySession = id => q(`DELETE FROM core.sessions WHERE id_hash=$1`, [hash(id)]);
const endStaffSessions = staffId => q(`DELETE FROM core.sessions WHERE staff_id=$1`, [staffId]);

// ---- guards ----
// requireRole('therapist') is the ONLY door to clinical routes. A practice manager account gets 403 there,
// so the "no clinical access" rule is enforced in one place.
function requireRole(role, loginPath, forbiddenPage) {
  return async (req, res, next) => {
    let s;
    try { s = await getSession(req); } catch (e) { return next(e); }
    if (!s) return res.redirect(loginPath);
    if (s.role !== role) return res.status(403).send(forbiddenPage());
    req.session = s;
    next();
  };
}

module.exports = {
  accountsFor, issueStaffCode, supersedeStaffCodes, voidToken, verifyStaffCode, issuePick, pickEmail, endStaffSessions, issueClientLink, peekClientLink, consumeClientLink, claimPoll,
  createSession, getSession, destroySession, requireRole, random,
};
