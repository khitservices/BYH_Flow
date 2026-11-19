// lib/retention.js — how long a client's clinical record is kept, and its deletion when that time is up.
// Kev's decisions (19 Nov 2026): adults 7 years after last contact; under-18s until the longer of 7 years after last contact and their
// 25th birthday (26th if they were 17 at last contact), which needs a date of birth; deleted automatically, unless the therapist has put a hold on.
// The clinical record = details, appointments, signed forms and their PDFs, weekly scores, and the enquiry it came from.
// Only CLOSED clients are ever deleted (not active or read-only); people archived as "did not proceed" go 1 year after archiving. The journal is the client's own and is handled separately (lib/journal.js wipe()).
const { pool, q, one } = require('./db');
const storage = require('./storage');
const YEARS = 7;
const addYears = (d, n) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x; };
// A DATE column arrives as midnight in the server's own time zone, so read its calendar day with local getters, never UTC ones.
const p2 = n => String(n).padStart(2, '0');
const dateOnly = d => (d instanceof Date ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : String(d || '').slice(0, 10));
const dobDate = d => new Date(dateOnly(d) + 'T00:00:00Z');

// The last day the practice was in contact: the latest past session or consultation, or when the record was closed.
async function lastContact(c) {
  const r = await one(`SELECT max(starts_at) AS s FROM clinical.appointments WHERE client_id=$1 AND status='booked' AND starts_at <= now()`, [c.id]);
  return [r.s, c.ic_at && c.ic_at <= new Date() ? c.ic_at : null, c.closed_at, c.created_at].filter(Boolean).map(x => new Date(x)).sort((a, b) => b - a)[0];
}
// Pure: when may this record be deleted? null = cannot be worked out (a child with no date of birth).
function keepUntil(c, last) {
  const adult = addYears(last, YEARS);
  if (!c.under16 && !c.date_of_birth) return adult;
  if (!c.date_of_birth) return null;
  const dob = dobDate(c.date_of_birth), ageAtLast = (last - dob) / (365.25 * 86400000);
  if (ageAtLast >= 18) return adult;
  const child = addYears(dob, ageAtLast >= 17 ? 26 : 25);
  return child > adult ? child : adult;
}
async function status(c) {
  const last = await lastContact(c), until = keepUntil(c, last);
  return { last, until, years: YEARS, needsDob: !until, due: !!until && until <= new Date() };
}

// Remove one client's clinical record completely: database rows first (in one step), then the encrypted files.
async function purge(clientId) {
  const db = await pool.connect(); let files = [];
  try {
    await db.query('BEGIN');
    const enq = (await db.query(`SELECT id FROM clinical.enquiries WHERE converted_client_id=$1`, [clientId])).rows.map(r => r.id);
    files = (await db.query(`SELECT file_id AS f FROM documents.forms WHERE file_id IS NOT NULL AND (client_id=$1 OR enquiry_id = ANY($2::int[]))
                             UNION SELECT file_object_id FROM clinical.journal_entries WHERE client_id=$1 AND file_object_id IS NOT NULL`, [clientId, enq])).rows.map(r => r.f);
    await db.query(`DELETE FROM documents.forms WHERE client_id=$1 OR enquiry_id = ANY($2::int[])`, [clientId, enq]);
    await db.query(`DELETE FROM clinical.enquiries WHERE id = ANY($1::int[])`, [enq]);
    await db.query(`DELETE FROM clinical.clients WHERE id=$1`, [clientId]);   // appointments, scores, journal, sessions, requests, blocks go with it
    await db.query(`INSERT INTO core.audit_log (actor_type, action, subject_type, subject_id, detail) VALUES ('system','client.record_deleted','client',$1,$2)`, [clientId, JSON.stringify({ reason: 'retention_period_ended', files: files.length })]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } finally { db.release(); }
  for (const f of files) await storage.remove(f).catch(e => console.error('[retention] file not removed', e.message));
}
// People who did not go ahead (Kev, 19 Nov): a client archived as "did not proceed", or an enquiry archived without becoming a client, are deleted 1 year after archiving.
const DID_NOT_PROCEED_YEARS = 1;
async function purgeEnquiry(enquiryId) {
  const db = await pool.connect(); let files = [];
  try {
    await db.query('BEGIN');
    files = (await db.query(`SELECT file_id AS f FROM documents.forms WHERE enquiry_id=$1 AND file_id IS NOT NULL`, [enquiryId])).rows.map(r => r.f);
    await db.query(`DELETE FROM documents.forms WHERE enquiry_id=$1`, [enquiryId]);
    await db.query(`DELETE FROM clinical.enquiries WHERE id=$1 AND stage <> 'converted'`, [enquiryId]);
    await db.query(`INSERT INTO core.audit_log (actor_type, action, subject_type, subject_id, detail) VALUES ('system','enquiry.record_deleted','enquiry',$1,$2)`, [enquiryId, JSON.stringify({ reason: 'did_not_proceed_1_year', files: files.length })]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } finally { db.release(); }
  for (const f of files) await storage.remove(f).catch(e => console.error('[retention] file not removed', e.message));
}
// Every record whose time is up. Runs with the hourly sweep; safe to run repeatedly.
async function run() {
  let n = 0;
  for (const c of await q(`SELECT * FROM clinical.clients WHERE status='closed' AND archived_at IS NULL AND NOT retention_hold`)) {
    const s = await status(c);
    if (s.due) { await purge(c.id); n++; }
  }
  for (const c of await q(`SELECT id FROM clinical.clients WHERE status='closed' AND archived_at IS NOT NULL AND archived_at < now() - interval '${DID_NOT_PROCEED_YEARS} year' AND NOT retention_hold`)) { await purge(c.id); n++; }
  for (const e of await q(`SELECT id FROM clinical.enquiries WHERE archived_at IS NOT NULL AND stage <> 'converted' AND archived_at < now() - interval '${DID_NOT_PROCEED_YEARS} year'`)) { await purgeEnquiry(e.id); n++; }
  return n;
}
module.exports = { dateOnly, YEARS, keepUntil, lastContact, status, purge, run };
