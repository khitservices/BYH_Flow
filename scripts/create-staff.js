// scripts/create-staff.js — add an account from the server. Needed once, for the first practice manager;
// after that the practice manager adds people on the Team page. A practice manager account and a
// therapist account are separate: give both flags to create both under the same email address.
// Usage (inside the app container):
//   docker compose exec app node scripts/create-staff.js "Name" email@example.com --practice-manager [--therapist]
require('dotenv').config();
const { q, pool } = require('../lib/db');

(async () => {
  const [name, email, ...flags] = process.argv.slice(2);
  if (!name || !email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('usage: create-staff.js "Name" email [--practice-manager] [--therapist]');
  const roles = [flags.includes('--practice-manager') && 'practice_manager', flags.includes('--therapist') && 'therapist'].filter(Boolean);
  if (!roles.length) throw new Error('give at least one of --practice-manager / --therapist');
  for (const role of roles) {
    const rows = await q(
      `INSERT INTO core.staff (name, email, role) VALUES ($1,$2,$3)
       ON CONFLICT (lower(email), role) DO UPDATE SET name=$1, status='active' RETURNING id, role`, [name, email.toLowerCase(), role]);
    console.log('account saved:', rows[0]);
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
