// lib/locations.js — places sessions happen. Managed by the practice manager; used for session bookings only.
const { q, one } = require('./db');
const active = () => q(`SELECT * FROM core.locations WHERE active ORDER BY (kind='online'), lower(name)`);
// Which location a booking uses: the one chosen if it is valid, else the therapist's usual one, else none.
async function pick(therapistId, chosen) {
  const id = Number(chosen) || 0;
  if (id) { const l = await one(`SELECT * FROM core.locations WHERE id=$1 AND active`, [id]); if (l) return l; }
  if (chosen === 'none') return null;
  return one(`SELECT l.* FROM core.staff s JOIN core.locations l ON l.id=s.default_location_id AND l.active WHERE s.id=$1`, [therapistId]);
}
const snapshot = l => (l ? [l.id, l.name, l.address || null, l.note || null, l.kind] : [null, null, null, null, null]);
// "Online (video call)" or "Name, address"
const label = a => (a.location_name ? (a.location_kind === 'online' || !a.location_address ? a.location_name : `${a.location_name}, ${a.location_address}`) : null);
module.exports = { active, pick, snapshot, label };
