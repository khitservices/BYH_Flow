// lib/notify.js — tells a therapist about a new enquiry that came in through a public link. The email is sent as the
// enquiry arrives; if that fails (mail server down), a background check every few minutes tries again, up to 5 times
// within 2 days. Runs on the server, so it does not depend on anyone having the app open. No personal detail in the email.
const { q, one } = require('./db');
const mail = require('./mail');
const storage = require('./storage');

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
  return n + await retryNotices() + await retryCopies();
}

// A client asked for something: tell their therapist (no detail in the email). Recorded first, retried if the send fails.
const SUBJECT = { change: ['A client has asked to change an appointment', t => mail.changeRequestEmail(t.name, `${process.env.BASE_URL}/staff`)], data: ['A client has made a request', t => mail.dataRequestEmail(t.name, `${process.env.BASE_URL}/staff`)] };
async function sendNotice(id) {
  const n = await one(`UPDATE core.notices SET attempts = attempts + 1 WHERE id=$1 AND sent_at IS NULL RETURNING id, kind, therapist_id, ref_id`, [id]);
  if (!n) return false;
  try {
    const t = await one(`SELECT name, email FROM core.staff WHERE id=$1`, [n.therapist_id]);
    if (n.kind === 'signed') { const f = await one(`SELECT rendered->>'title' AS title FROM documents.forms WHERE id=$1`, [n.ref_id]); await mail.sendMail(t.email, 'A form has been signed', mail.formSignedNoticeEmail(t.name, f ? f.title : 'A form')); }
    else await mail.sendMail(t.email, SUBJECT[n.kind][0], SUBJECT[n.kind][1](t));
    await q(`UPDATE core.notices SET sent_at=now() WHERE id=$1`, [id]);
    return true;
  } catch (err) { console.error('[notify] notice failed:', err.message); return false; }
}
async function queueNotice(therapistId, kind, refId = null) {
  const [n] = await q(`INSERT INTO core.notices (therapist_id, kind, ref_id) VALUES ($1,$2,$3) RETURNING id`, [therapistId, kind, refId]);
  return sendNotice(n.id);
}
async function retryNotices() {
  const rows = await q(`SELECT id FROM core.notices WHERE sent_at IS NULL AND attempts < 5 AND created_at > now() - interval '2 days' AND created_at < now() - interval '1 minute' ORDER BY id`);
  let n = 0; for (const r of rows) if (await sendNotice(r.id)) n++;
  return n;
}
// The signed copy to the person who signed. Tried when they sign; if the mail server fails, again every few minutes (5 tries, 2 days).
async function sendSignerCopy(id) {
  const f = await one(`UPDATE documents.forms SET copy_attempts = copy_attempts + 1 WHERE id=$1 AND status='signed' AND copy_sent_at IS NULL AND file_id IS NOT NULL RETURNING id, therapist_id, sent_to, file_id, rendered, signer`, [id]);
  if (!f) return false;
  try {
    if (!f.sent_to) { await q(`UPDATE documents.forms SET copy_attempts = 99 WHERE id=$1`, [id]); return false; }   // no address to send to
    await mail.sendFrom(f.therapist_id, f.sent_to, f.rendered.title, mail.formSignedEmail(f.signer && f.signer.name, f.rendered.title), null, { attachments: [{ filename: `${f.rendered.title}.pdf`, content: await storage.get(f.file_id), contentType: 'application/pdf' }] });
    await q(`UPDATE documents.forms SET copy_sent_at=now() WHERE id=$1`, [id]);
    return true;
  } catch (err) { console.error('[notify] signed copy failed:', err.message); return false; }
}
async function retryCopies() {
  const rows = await q(`SELECT id FROM documents.forms WHERE status='signed' AND copy_sent_at IS NULL AND copy_attempts < 5 AND signed_at > now() - interval '2 days' AND signed_at < now() - interval '1 minute' ORDER BY id`);
  let n = 0; for (const r of rows) if (await sendSignerCopy(r.id)) n++;
  return n;
}
module.exports = { sendSignerCopy, retryCopies, notifyEnquiry, retryPending, queueNotice, retryNotices };
