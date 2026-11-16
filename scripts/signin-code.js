// scripts/signin-code.js — print a one-time sign-in code for a staff member, without sending any email.
// For the very first sign-in (before the mailbox is set up in Settings) and as the way back in if a
// later change to the email settings stops codes arriving. Only someone with access to the server can
// run it. Usage (inside the app container):
//   docker compose exec app node scripts/signin-code.js email@example.com
require('dotenv').config();
const { one, q, pool } = require('../lib/db');
const A = require('../lib/auth');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('usage: signin-code.js email');
  const staff = await one(`SELECT * FROM core.staff WHERE lower(email)=$1 AND status='active'`, [email]);
  if (!staff) throw new Error('no active staff member with that email (add them with create-staff.js first)');
  const { code, id } = await A.issueStaffCode(staff, 30 * 60 * 1000);
  await A.supersedeStaffCodes(staff.id, id);
  await q(`INSERT INTO core.audit_log (actor_type, actor_id, action) VALUES ('staff',$1,'staff.code_printed')`, [staff.id]);
  console.log(`Sign-in code for ${staff.email}: ${code}`);
  console.log(`Valid for 30 minutes, once. Go to ${process.env.BASE_URL || ''}/staff, enter the email, then this code.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
