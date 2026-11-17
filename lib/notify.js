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
  return n;
}
module.exports = { notifyEnquiry, retryPending };
