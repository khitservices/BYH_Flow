// scripts/cleanse.js — clear test data from an instance. Run on the server only; there is deliberately
// no web page or URL for this, so no practice user can trigger it.
//   node scripts/cleanse.js keepteam --confirm ERASE   → delete clients, sessions (appointments), tokens, signed-in sessions; keep staff and settings
//   node scripts/cleanse.js full --confirm ERASE       → also delete therapists; keeps practice managers, mail and practice settings
require('dotenv').config();
const { q, one, pool } = require('../lib/db');

(async () => {
  const [action, flag, phrase] = process.argv.slice(2);
  if (!['keepteam', 'full'].includes(action) || flag !== '--confirm' || phrase !== 'ERASE')
    throw new Error('usage: cleanse.js keepteam|full --confirm ERASE');
  await q(`DELETE FROM clinical.appointments`);
  await q(`DELETE FROM clinical.clients`);          // cascades to client tokens and sessions
  if (action === 'full') {
    await q(`DELETE FROM core.staff WHERE role='therapist'`); // cascades to their tokens and sessions
  }
  await q(`DELETE FROM core.auth_tokens WHERE kind='client_link'`);
  await q(`UPDATE core.staff SET cal_feed_hash=NULL WHERE role='therapist'`);
  const n = await one(`SELECT (SELECT count(*) FROM clinical.clients)::int clients,
    (SELECT count(*) FROM core.staff WHERE role='therapist')::int therapists,
    (SELECT count(*) FROM core.staff WHERE role='practice_manager')::int managers`);
  console.log('done; remaining:', n);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
