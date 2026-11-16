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
// Earlier codes are NOT voided here: the caller does that once the new code has actually been delivered
// (supersedeStaffCodes), or voids the new one if sending failed (voidToken). That way a code printed by
// scripts/signin-code.js still works when the mailbox is not set up or is broken.
async function issueStaffCode(staff, ttlMs = CODE_TTL_MS) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const r = await q(`INSERT INTO core.auth_tokens (kind, staff_id, secret_hash, expires_at) VALUES ('staff_code',$1,$2,$3) RETURNING id`,
    [staff.id, hash(`${staff.id}:${code}`), new Date(Date.now() + ttlMs)]);
  return { code, id: r[0].id };
}
const supersedeStaffCodes = (staffId, keepId) =>
  q(`UPDATE core.auth_tokens SET used_at=now() WHERE kind='staff_code' AND staff_id=$1 AND id<>$2 AND used_at IS NULL`, [staffId, keepId]);
const voidToken = id => q(`UPDATE core.auth_tokens SET used_at=now() WHERE id=$1 AND used_at IS NULL`, [id]);

async function verifyStaffCode(staff, code) {
  const t = await one(`SELECT * FROM core.auth_tokens WHERE kind='staff_code' AND staff_id=$1 AND used_at IS NULL
                       AND expires_at > now() ORDER BY id DESC LIMIT 1`, [staff.id]);
  if (!t) return false;
  if (t.attempts >= MAX_CODE_ATTEMPTS) { await q(`UPDATE core.auth_tokens SET used_at=now() WHERE id=$1`, [t.id]); return false; }
  const ok = /^\d{6}$/.test(String(code)) && safeEqual(t.secret_hash, hash(`${staff.id}:${code}`));
  if (!ok) { await q(`UPDATE core.auth_tokens SET attempts=attempts+1 WHERE id=$1`, [t.id]); return false; }
  const used = await q(`UPDATE core.auth_tokens SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id`, [t.id]);
  return used.length === 1;
}

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
    client = await one(`SELECT * FROM clinical.clients WHERE id=$1 AND status IN ('active','readonly')`, [s.client_id]);
    if (!client) return null;
  }
  if (new Date(s.expires_at).getTime() - now < IDLE_MS - 60000) { // slide the idle window, at most once a minute
    await q(`UPDATE core.sessions SET expires_at=$2 WHERE id_hash=$1`, [s.id_hash, new Date(now + IDLE_MS)]);
  }
  return { idHash: s.id_hash, role: s.active_role, staff, client };
}

const setRole = (idHash, role) => q(`UPDATE core.sessions SET active_role=$2 WHERE id_hash=$1`, [idHash, role]);
const destroySession = id => q(`DELETE FROM core.sessions WHERE id_hash=$1`, [hash(id)]);
const rolesOf = staff => [staff.is_practice_manager && 'practice_manager', staff.is_therapist && 'therapist'].filter(Boolean);

// ---- guards ----
// requireRole('therapist') is the ONLY door to clinical routes. A practice manager who is not acting
// as a therapist gets 403 there, so the "no clinical access" rule is enforced in one place.
function requireRole(role, loginPath, forbiddenPage) {
  return async (req, res, next) => {
    let s;
    try { s = await getSession(req); } catch (e) { return next(e); }
    if (!s) return res.redirect(loginPath);
    if (role !== 'client' && s.staff && s.role === null) return res.redirect('/choose-role');
    if (s.role !== role) return res.status(403).send(forbiddenPage());
    req.session = s;
    next();
  };
}

module.exports = {
  issueStaffCode, supersedeStaffCodes, voidToken, verifyStaffCode, issueClientLink, peekClientLink, consumeClientLink, claimPoll,
  createSession, getSession, setRole, destroySession, rolesOf, requireRole, random,
};
