// lib/archive.js — the archive. Enquiries that go nowhere and clients who did not proceed are kept, out of the working
// lists. A returning person is matched against the receiving therapist's OWN archive only (same email or phone), so one
// therapist's archive is never revealed to another. The therapist confirms a match and restores it.
const { q } = require('./db');
const STALE_DAYS = 60;
const digits = v => String(v || '').replace(/\D/g, '');

// Archived records belonging to this therapist that look like the same person. contact: {email, guardian_email, phone, guardian_phone}
async function findMatches(therapistId, contact) {
  const emails = [contact.email, contact.guardian_email].filter(Boolean).map(s => s.toLowerCase());
  const phones = [contact.phone, contact.guardian_phone].map(digits).filter(p => p.length >= 7);
  if (!emails.length && !phones.length) return [];
  const sameCols = alias => `(lower(${alias}.email) = ANY($2) OR lower(${alias}.guardian_email) = ANY($2)
    OR regexp_replace(coalesce(${alias}.phone,''),'\\D','','g') = ANY($3) OR regexp_replace(coalesce(${alias}.guardian_phone,''),'\\D','','g') = ANY($3))`;
  const clients = await q(`SELECT 'client' AS kind, id, name, archived_at, 'did not proceed' AS reason FROM clinical.clients c
    WHERE therapist_id=$1 AND archived_at IS NOT NULL AND ${sameCols('c')}`, [therapistId, emails, phones]);
  const enquiries = await q(`SELECT 'enquiry' AS kind, id, name, archived_at, CASE archive_reason WHEN 'stale' THEN 'no progress for ${STALE_DAYS} days' ELSE 'archived' END AS reason FROM clinical.enquiries e
    WHERE therapist_id=$1 AND archived_at IS NOT NULL AND ${sameCols('e')}`, [therapistId, emails, phones]);
  return [...clients, ...enquiries].sort((a, b) => b.archived_at - a.archived_at);
}

// The same person already live in this therapist's own lists: a current client, or another enquiry not yet booked.
// (Another therapist's clients are never shown or named.)
async function findLive(therapistId, e) {
  const emails = [e.email, e.guardian_email].filter(Boolean).map(s => s.toLowerCase());
  const phones = [e.phone, e.guardian_phone].map(digits).filter(p => p.length >= 7);
  if (!emails.length && !phones.length) return [];
  const same = a => `(lower(${a}.email) = ANY($3) OR lower(${a}.guardian_email) = ANY($3) OR regexp_replace(coalesce(${a}.phone,''),'\\D','','g') = ANY($4) OR regexp_replace(coalesce(${a}.guardian_phone,''),'\\D','','g') = ANY($4))`;
  const clients = await q(`SELECT 'client' AS kind, id, name, status FROM clinical.clients c WHERE therapist_id=$1 AND $2::bigint IS NOT NULL AND archived_at IS NULL AND ${same('c')}`, [therapistId, e.id, emails, phones]);
  const enquiries = await q(`SELECT 'enquiry' AS kind, id, name, NULL AS status FROM clinical.enquiries x WHERE therapist_id=$1 AND id<>$2 AND archived_at IS NULL AND stage='new' AND ${same('x')}`, [therapistId, e.id, emails, phones]);
  return [...clients, ...enquiries];
}
// Is this email held by a client of ANOTHER therapist (so it cannot be used here)? Says nothing about whose.
const takenElsewhere = async (therapistId, email) => !!email && !!(await q(`SELECT 1 FROM clinical.clients WHERE lower(email)=$1 AND therapist_id<>$2`, [String(email).toLowerCase(), therapistId])).length;

// Enquiries with no progress for 60 days are archived. Run hourly and whenever a therapist opens their enquiries. Returns the count.
async function archiveStale(therapistId) {
  const r = await q(`UPDATE clinical.enquiries SET archived_at=now(), archive_reason='stale'
    WHERE archived_at IS NULL AND stage='new' AND greatest(created_at, last_activity_at) < now() - interval '${STALE_DAYS} days' ${therapistId ? 'AND therapist_id=$1' : ''} RETURNING id`, therapistId ? [therapistId] : []);
  return r.length;
}
async function restoreClient(therapistId, id) {
  const r = await q(`UPDATE clinical.clients SET archived_at=NULL, closed_reason=NULL, closed_at=NULL, status='consultation', ic_at=NULL, ic_sequence=ic_sequence+1
    WHERE id=$1 AND therapist_id=$2 AND archived_at IS NOT NULL RETURNING id`, [id, therapistId]);
  return r.length > 0;
}
async function restoreEnquiry(therapistId, id) {
  const r = await q(`UPDATE clinical.enquiries SET archived_at=NULL, archive_reason=NULL, last_activity_at=now() WHERE id=$1 AND therapist_id=$2 AND archived_at IS NOT NULL RETURNING id`, [id, therapistId]);
  return r.length > 0;
}
module.exports = { findLive, takenElsewhere, restoreClient, restoreEnquiry, findMatches, archiveStale, STALE_DAYS };
