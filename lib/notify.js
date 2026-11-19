// lib/notify.js — tells a therapist about a new enquiry that came in through a public link. The email is sent as the
// enquiry arrives; if that fails (mail server down), a background check every few minutes tries again, up to 5 times
// within 2 days. Runs on the server, so it does not depend on anyone having the app open. No personal detail in the email.
const { q, one } = require('./db');
const mail = require('./mail');

async function notifyEnquiry(id) {
  const e = await one(`UPDATE clinical.enquiries SET notify_attempts = notify_attempts + 1 WHERE id=$1 AND notified_at IS NULL RETURNING id, therapist_id`, [id]);
  if (!e) return false;
  try {
    const t = await one(`SELECT name, email FROM core.staff WHERE id=$1`, [e.therapist_id]);
    await mail.sendMail(t.email, 'New enquiry', mail.newEnquiryEmail(t.name, `${process.env.BASE_URL}/staff`));
    await q(`UPDATE clinical.enquiries SET notified_at=now() WHERE id=$1`, [id]);
    return true;
  } catch (err) { console.error('[notify] enquiry email failed:', err.message); return false; }
}
async function retryPending() {
  const rows = await q(`SELECT id FROM clinical.enquiries WHERE notified_at IS NULL AND channel <> 'phone' AND notify_attempts < 5
      AND created_at > now() - interval '2 days' AND created_at < now() - interval '1 minute' ORDER BY id`);
  let n = 0; for (const r of rows) if (await notifyEnquiry(r.id)) n++;
  return n + await retryNotices();
}

// A client asked for something: tell their therapist (no detail in the email). Recorded first, retried if the send fails.
const SUBJECT = { change: ['A client has asked to change an appointment', t => mail.changeRequestEmail(t.name, `${process.env.BASE_URL}/staff`)], data: ['A client has made a request', t => mail.dataRequestEmail(t.name, `${process.env.BASE_URL}/staff`)] };
async function sendNotice(id) {
  const n = await one(`UPDATE core.notices SET attempts = attempts + 1 WHERE id=$1 AND sent_at IS NULL RETURNING id, kind, therapist_id`, [id]);
  if (!n) return false;
  try {
    const t = await one(`SELECT name, email FROM core.staff WHERE id=$1`, [n.therapist_id]);
    await mail.sendMail(t.email, SUBJECT[n.kind][0], SUBJECT[n.kind][1](t));
    await q(`UPDATE core.notices SET sent_at=now() WHERE id=$1`, [id]);
    return true;
  } catch (err) { console.error('[notify] notice failed:', err.message); return false; }
}
async function queueNotice(therapistId, kind) {
  const [n] = await q(`INSERT INTO core.notices (therapist_id, kind) VALUES ($1,$2) RETURNING id`, [therapistId, kind]);
  return sendNotice(n.id);
}
async function retryNotices() {
  const rows = await q(`SELECT id FROM core.notices WHERE sent_at IS NULL AND attempts < 5 AND created_at > now() - interval '2 days' AND created_at < now() - interval '1 minute' ORDER BY id`);
  let n = 0; for (const r of rows) if (await sendNotice(r.id)) n++;
  return n;
}
module.exports = { notifyEnquiry, retryPending, queueNotice, retryNotices };
