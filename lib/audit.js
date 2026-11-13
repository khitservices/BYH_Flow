// lib/audit.js — append-only record of sign-ins and access. Never pass codes, tokens or clinical content.
const { q } = require('./db');

async function audit(req, action, { actorType = null, actorId = null, subjectType = null, subjectId = null, detail = null } = {}) {
  try {
    await q(`INSERT INTO core.audit_log (actor_type, actor_id, action, subject_type, subject_id, detail, ip)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actorType, actorId, action, subjectType, subjectId, detail ? JSON.stringify(detail) : null, (req && req.ip) || null]);
  } catch (e) {
    console.error('[audit] write failed:', e.message); // auditing must never break the request
  }
}

module.exports = { audit };
