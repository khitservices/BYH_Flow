// routes/programmes.js — the practice's list of programmes (name, number of sessions, optional price).
// Practice manager only. Prices are recorded for the therapist to see; there are no payments in this app yet.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const { audit } = require('../lib/audit');
const V = require('../views/pages');

const router = express.Router();
const pm = A.requireRole('practice_manager', '/staff', V.forbidden);

const activeProgrammes = () => q(`SELECT * FROM core.programmes WHERE active ORDER BY sessions, lower(name)`);
// '75' or '75.50' → pence; blank → no price; anything else → undefined (refused).
function pence(v) {
  const s = String(v ?? '').trim().replace(/^£/, '');
  if (s === '') return null;
  return /^\d{1,5}(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : undefined;
}
const page = async (res, msg, ok, status = 200) => res.status(status).send(V.programmes(await q(`SELECT * FROM core.programmes ORDER BY (NOT active), sessions, lower(name)`), msg, ok));

router.get('/practice/programmes', pm, (_req, res) => page(res));

function read(b) {
  const name = String(b.name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80), sessions = Number(b.sessions), price = pence(b.price);
  if (!name) return { error: 'Enter a name.' };
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 60) return { error: 'Sessions must be a whole number from 1 to 60.' };
  if (price === undefined) return { error: 'Price must be an amount like 75 or 75.50, or left empty.' };
  return { name, sessions, price };
}

router.post('/practice/programmes', pm, async (req, res) => {
  const f = read(req.body);
  if (f.error) return page(res, f.error, false, 400);
  const [p] = await q(`INSERT INTO core.programmes (name, sessions, price_pence) VALUES ($1,$2,$3) RETURNING id`, [f.name, f.sessions, f.price]);
  await audit(req, 'programme.added', { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'programme', subjectId: p.id });
  page(res, 'Programme added.', true);
});

router.post('/practice/programmes/:id', pm, async (req, res) => {
  const p = await one(`SELECT * FROM core.programmes WHERE id=$1`, [Number(req.params.id) || 0]);
  if (!p) return res.status(404).send(V.forbidden());
  const log = what => audit(req, what, { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'programme', subjectId: p.id });
  if (req.body.action === 'retire' || req.body.action === 'restore') {
    await q(`UPDATE core.programmes SET active=$2 WHERE id=$1`, [p.id, req.body.action === 'restore']); await log('programme.' + req.body.action);
    return page(res, req.body.action === 'retire' ? 'Retired. Existing clients keep it; it is no longer offered for new ones.' : 'Offered again.', true);
  }
  const f = read(req.body);
  if (f.error) return page(res, f.error, false, 400);
  await q(`UPDATE core.programmes SET name=$2, sessions=$3, price_pence=$4 WHERE id=$1`, [p.id, f.name, f.sessions, f.price]); await log('programme.changed');
  page(res, 'Saved. Clients already on this programme keep what they were given.', true);
});

module.exports = { router, activeProgrammes, pence };
