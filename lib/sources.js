// lib/sources.js — "how did you hear about us". A managed list; a therapist can type a new one when entering an enquiry
// (for example the name of an osteopath who refers), and it joins the list for everyone.
const { q, one } = require('./db');
const active = () => q(`SELECT id, name FROM core.referral_sources WHERE active ORDER BY lower(name)`);
// chosen: id of a listed source, or 'other' with newName typed. Returns the name to store, or null when none given.
async function resolve(chosen, newName) {
  const typed = String(newName || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);
  if (chosen === 'other' && typed) {
    const [r] = await q(`INSERT INTO core.referral_sources (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET active=true RETURNING name`, [typed]);
    return r.name;
  }
  const s = Number(chosen) ? await one(`SELECT name FROM core.referral_sources WHERE id=$1 AND active`, [Number(chosen)]) : null;
  return s ? s.name : null;
}
module.exports = { active, resolve };
