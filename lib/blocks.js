// lib/blocks.js — blocks of sessions. A client has a sequence of blocks (a programme of sessions, or a single standalone session);
// one is current. Sessions belong to the block current when they were booked. clients.programme_* mirrors the current block.
const { q, one } = require('./db');

const delivered = async block => block ? (await one(`SELECT count(*)::int n FROM clinical.appointments WHERE block_id=$1 AND status='booked' AND starts_at <= now()`, [block])).n : 0;

// Start a new block from a programme row. Ends the previous one. Returns the block.
async function startBlock(clientId, prog, prior = 0, { keepReminders = false } = {}) {
  const last = await one(`SELECT coalesce(max(number),0) n FROM clinical.programme_blocks WHERE client_id=$1`, [clientId]);
  await q(`UPDATE clinical.programme_blocks SET ended_at=now() WHERE client_id=$1 AND ended_at IS NULL`, [clientId]);
  const before = Math.max(0, Math.min(Number(prior) || 0, prog.sessions - 1));
  const [b] = await q(`INSERT INTO clinical.programme_blocks (client_id, number, programme_id, name, sessions, price_pence, sessions_before_app) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [clientId, last.n + 1, prog.id, prog.name, prog.sessions, prog.price_pence, before]);
  await q(`UPDATE clinical.clients SET current_block_id=$2, programme_id=$3, programme_name=$4, programme_sessions=$5, programme_price_pence=$6, sessions_before_app=$7,
      programme_number=$8, programme_started_at=now(), status='active', closed_at=NULL ${keepReminders ? '' : ', reminders_on=$9'} WHERE id=$1`,
    keepReminders ? [clientId, b.id, prog.id, prog.name, prog.sessions, prog.price_pence, before, b.number] : [clientId, b.id, prog.id, prog.name, prog.sessions, prog.price_pence, before, b.number, prog.sessions > 1]);
  return b;
}
const blocksFor = clientId => q(`SELECT b.*, (SELECT count(*)::int FROM clinical.appointments a WHERE a.block_id=b.id AND a.status='booked' AND a.starts_at <= now()) AS held
  FROM clinical.programme_blocks b WHERE client_id=$1 ORDER BY number`, [clientId]);
module.exports = { startBlock, blocksFor, delivered };
