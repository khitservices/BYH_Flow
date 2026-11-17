// lib/scores.js — the weekly 1-10 "how I feel" score. One per client per week (weeks start Monday, UK time).
// A week with no entry is a gap. Never counted or shown to the practice manager.
const { q, one } = require('./db');
const T = require('./time');
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function weekStart(now = new Date()) {
  const today = T.inputDate(now), dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
  return addDays(today, -dow);
}
// The last n weeks, oldest first, this week last; score is null where nothing was entered.
async function series(clientId, n = 12, now = new Date()) {
  const cur = weekStart(now), from = addDays(cur, -7 * (n - 1));
  const rows = await q(`SELECT to_char(week_start,'YYYY-MM-DD') AS w, score FROM clinical.weekly_scores WHERE client_id=$1 AND week_start >= $2::date`, [clientId, from]);
  const by = Object.fromEntries(rows.map(r => [r.w, r.score]));
  return Array.from({ length: n }, (_, i) => { const w = addDays(from, 7 * i); return { week: w, score: by[w] ?? null, current: w === cur }; });
}
async function save(clientId, score, now = new Date()) {
  const s = Number(score); if (!Number.isInteger(s) || s < 1 || s > 10) return false;
  await q(`INSERT INTO clinical.weekly_scores (client_id, week_start, score) VALUES ($1,$2,$3)
           ON CONFLICT (client_id, week_start) DO UPDATE SET score=EXCLUDED.score, entered_at=now()`, [clientId, weekStart(now), s]);
  return true;
}
module.exports = { weekStart, series, save };
