// scripts/create-staff.js — add or update a staff member (no admin screen exists yet).
// Usage (inside the app container):
//   docker compose exec app node scripts/create-staff.js "Name" email@example.com --therapist --practice-manager
require('dotenv').config();
const { q, pool } = require('../lib/db');

(async () => {
  const [name, email, ...flags] = process.argv.slice(2);
  if (!name || !email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('usage: create-staff.js "Name" email [--therapist] [--practice-manager]');
  const pm = flags.includes('--practice-manager'), th = flags.includes('--therapist');
  if (!pm && !th) throw new Error('give at least one of --therapist / --practice-manager');
  const rows = await q(
    `INSERT INTO core.staff (name, email, is_practice_manager, is_therapist) VALUES ($1,$2,$3,$4)
     ON CONFLICT (lower(email)) DO UPDATE SET name=$1, is_practice_manager=$3, is_therapist=$4, status='active'
     RETURNING id, is_practice_manager, is_therapist`, [name, email, pm, th]);
  console.log('staff saved:', rows[0]);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
