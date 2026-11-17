// lib/stats.js — practice statistics for the practice manager. COUNTS ONLY: no client names, emails,
// notes or other detail ever leaves these queries. Therapists appear by name (they are staff);
// their clients appear only as numbers.
const { q, one } = require('./db');

async function practiceStats() {
  const therapists = await q(`
    SELECT s.id, s.name, s.status,
      count(DISTINCT c.id) FILTER (WHERE c.status = 'active')::int   AS active_clients,
      count(DISTINCT c.id) FILTER (WHERE c.status = 'readonly')::int AS readonly_clients,
      count(DISTINCT c.id) FILTER (WHERE c.status = 'closed')::int   AS closed_clients,
      count(a.id) FILTER (WHERE a.status = 'booked' AND a.starts_at > now())::int AS upcoming,
      count(a.id) FILTER (WHERE a.status = 'booked' AND a.starts_at <= now() AND a.starts_at > now() - interval '30 days')::int AS delivered_30,
      count(a.id) FILTER (WHERE a.status = 'cancelled' AND a.starts_at > now() - interval '30 days')::int AS cancelled_30,
      count(a.id) FILTER (WHERE a.status = 'booked' AND a.change_requested_at IS NOT NULL AND a.starts_at > now())::int AS change_requests
    FROM core.staff s
    LEFT JOIN clinical.clients c ON c.therapist_id = s.id
    LEFT JOIN clinical.appointments a ON a.client_id = c.id
    WHERE s.role = 'therapist' AND s.status <> 'removed'
    GROUP BY s.id, s.name, s.status
    ORDER BY s.status, s.name`);
  const sum = k => therapists.reduce((n, t) => n + t[k], 0);
  const totals = Object.fromEntries(['active_clients', 'readonly_clients', 'closed_clients', 'upcoming', 'delivered_30', 'cancelled_30', 'change_requests'].map(k => [k, sum(k)]));
  const accounts = await one(`SELECT
      count(*) FILTER (WHERE role='therapist' AND status='active')::int AS therapists,
      count(*) FILTER (WHERE role='therapist' AND status='suspended')::int AS suspended,
      count(*) FILTER (WHERE role='practice_manager' AND status='active')::int AS managers
    FROM core.staff`);
  // Enquiries: counts by route and by stage only. No names, contacts or notes.
  const byChannel = await q(`SELECT channel, count(*)::int n FROM clinical.enquiries GROUP BY channel`);
  const byStage = await q(`SELECT stage, count(*)::int n FROM clinical.enquiries GROUP BY stage`);
  const enquiries = { channel: Object.fromEntries(byChannel.map(r => [r.channel, r.n])), stage: Object.fromEntries(byStage.map(r => [r.stage, r.n])) };
  return { therapists, totals, accounts, enquiries };
}
module.exports = { practiceStats };
