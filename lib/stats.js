// lib/stats.js — practice statistics for the practice manager. COUNTS ONLY: no client names, emails,
// notes or other detail ever leaves these queries. Therapists appear by name (they are staff);
// their clients appear only as numbers.
const { q, one } = require('./db');

// tid: limit everything to one therapist's own clients and enquiries (their own statistics page); null = whole practice.
async function practiceStats(tid = null) {
  tid = tid || null;
  const therapists = await q(`
    SELECT s.id, s.name, s.status,
      count(DISTINCT c.id) FILTER (WHERE c.status = 'active')::int   AS active_clients,
      count(DISTINCT c.id) FILTER (WHERE c.status = 'readonly')::int AS readonly_clients,
      count(DISTINCT c.id) FILTER (WHERE c.status = 'closed' AND c.archived_at IS NULL)::int AS closed_clients,
      count(DISTINCT c.id) FILTER (WHERE c.status IN ('consultation','attended'))::int AS consultation_clients,
      count(DISTINCT c.id) FILTER (WHERE c.archived_at IS NOT NULL)::int AS archived_clients,
      count(a.id) FILTER (WHERE a.status = 'booked' AND a.starts_at > now())::int AS upcoming,
      count(a.id) FILTER (WHERE a.status = 'booked' AND a.starts_at <= now() AND a.starts_at > now() - interval '30 days')::int AS delivered_30,
      count(a.id) FILTER (WHERE a.status = 'cancelled' AND a.starts_at > now() - interval '30 days')::int AS cancelled_30,
      count(a.id) FILTER (WHERE a.status = 'booked' AND a.change_requested_at IS NOT NULL AND a.starts_at > now())::int AS change_requests
    FROM core.staff s
    LEFT JOIN clinical.clients c ON c.therapist_id = s.id
    LEFT JOIN clinical.appointments a ON a.client_id = c.id
    WHERE s.role = 'therapist' AND s.status <> 'removed' AND ($1::bigint IS NULL OR s.id = $1)
    GROUP BY s.id, s.name, s.status
    ORDER BY s.status, s.name`, [tid]);
  const sum = k => therapists.reduce((n, t) => n + t[k], 0);
  const totals = Object.fromEntries(['active_clients', 'readonly_clients', 'closed_clients', 'consultation_clients', 'archived_clients', 'upcoming', 'delivered_30', 'cancelled_30', 'change_requests'].map(k => [k, sum(k)]));
  const accounts = await one(`SELECT
      count(*) FILTER (WHERE role='therapist' AND status='active')::int AS therapists,
      count(*) FILTER (WHERE role='therapist' AND status='suspended')::int AS suspended,
      count(*) FILTER (WHERE role='practice_manager' AND status='active')::int AS managers
    FROM core.staff`);
  // Enquiries: counts by route and by stage only. No names, contacts or notes.
  const byChannel = await q(`SELECT channel, count(*)::int n FROM clinical.enquiries WHERE ($1::bigint IS NULL OR therapist_id=$1) GROUP BY channel`, [tid]);
  const byStage = await q(`SELECT stage, count(*)::int n FROM clinical.enquiries WHERE archived_at IS NULL AND ($1::bigint IS NULL OR therapist_id=$1) GROUP BY stage`, [tid]);
  const archivedEnq = (await one(`SELECT count(*)::int n FROM clinical.enquiries WHERE archived_at IS NOT NULL AND ($1::bigint IS NULL OR therapist_id=$1)`, [tid])).n;
  const byHeard = await q(`SELECT COALESCE(heard_from,'Not known') h, count(*)::int n FROM clinical.enquiries WHERE ($1::bigint IS NULL OR therapist_id=$1) GROUP BY 1`, [tid]);
  const byCampaign = await q(`SELECT campaign c, count(*)::int n FROM clinical.enquiries WHERE campaign IS NOT NULL AND ($1::bigint IS NULL OR therapist_id=$1) GROUP BY 1 ORDER BY n DESC LIMIT 12`, [tid]);
  const enquiries = { campaign: Object.fromEntries(byCampaign.map(r => [r.c, r.n])), heard: Object.fromEntries(byHeard.map(r => [r.h, r.n])), channel: Object.fromEntries(byChannel.map(r => [r.channel, r.n])), stage: Object.fromEntries(byStage.map(r => [r.stage, r.n])), archived: archivedEnq };
  // Programmes: counts by programme name only (no client, no price per client).
  const byProgramme = await q(`SELECT coalesce(b.name,'Unnamed') AS name, count(DISTINCT b.id)::int AS blocks,
      count(a.id) FILTER (WHERE a.status='booked' AND a.starts_at <= now())::int AS delivered
    FROM clinical.programme_blocks b JOIN clinical.clients bc ON bc.id=b.client_id LEFT JOIN clinical.appointments a ON a.block_id=b.id
    WHERE ($1::bigint IS NULL OR bc.therapist_id=$1) GROUP BY 1 ORDER BY 2 DESC, 1`, [tid]);
  const rep = await one(`SELECT (SELECT count(*) FROM (SELECT client_id FROM clinical.programme_blocks pb JOIN clinical.clients pc ON pc.id=pb.client_id WHERE ($1::bigint IS NULL OR pc.therapist_id=$1) GROUP BY pb.client_id HAVING count(*) > 1) x)::int AS repeat_clients,
      (SELECT count(*) FROM clinical.programme_blocks sb JOIN clinical.clients sc ON sc.id=sb.client_id WHERE sb.sessions = 1 AND ($1::bigint IS NULL OR sc.therapist_id=$1))::int AS single_blocks`, [tid]);
  return { therapists, totals, accounts, enquiries, blocks: { byProgramme, ...rep } };
}
module.exports = { practiceStats };
