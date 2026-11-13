// scripts/create-client.js — add a client (test use until the client screens exist).
// Usage: docker compose exec app node scripts/create-client.js "Name" client@example.com therapist@example.com
require('dotenv').config();
const { q, one, pool } = require('../lib/db');

(async () => {
  const [name, email, therapistEmail] = process.argv.slice(2);
  if (!name || !email || !therapistEmail) throw new Error('usage: create-client.js "Name" client-email therapist-email');
  const t = await one(`SELECT id FROM core.staff WHERE lower(email)=lower($1) AND is_therapist AND status='active'`, [therapistEmail]);
  if (!t) throw new Error('no active therapist with that email');
  const rows = await q(`INSERT INTO clinical.clients (therapist_id, name, email) VALUES ($1,$2,$3) RETURNING id`, [t.id, name, email]);
  console.log('client saved:', rows[0]);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
