// routes/locations.js — practice manager keeps the list of places sessions happen (online, a therapist's home, a residency
// at an osteopath's, a dentist's surgery…). Settings only; no client detail here. Therapists choose their usual one in My account.
const express = require('express');
const { q, one } = require('../lib/db');
const A = require('../lib/auth');
const { audit } = require('../lib/audit');
const V = require('../views/pages');
const router = express.Router();
const pm = A.requireRole('practice_manager', '/staff/practice', V.forbidden);
const text = (v, max) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);

const list = () => q(`SELECT l.*, (SELECT count(*)::int FROM core.staff s WHERE s.default_location_id=l.id) AS used_by FROM core.locations l ORDER BY l.active DESC, (l.kind='online') DESC, lower(l.name)`);
router.get('/practice/locations', pm, async (req, res) => res.send(V.locationsPage(await list(), req.query.msg === 'saved' ? 'Saved.' : null, true)));

router.post('/practice/locations', pm, async (req, res) => {
  const b = req.body, who = { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'location' };
  const again = async msg => res.status(400).send(V.locationsPage(await list(), msg, false));
  if (b.action === 'retire' || b.action === 'restore') {
    const l = await one(`SELECT id, kind FROM core.locations WHERE id=$1`, [Number(b.id) || 0]);
    if (!l) return again('That place no longer exists.');
    await q(`UPDATE core.locations SET active=$2 WHERE id=$1`, [l.id, b.action === 'restore']);
    if (b.action === 'retire') await q(`UPDATE core.staff SET default_location_id=NULL WHERE default_location_id=$1`, [l.id]);   // sessions already booked keep what they were told
    await audit(req, `location.${b.action}`, { ...who, subjectId: l.id });
    return res.redirect('/practice/locations?msg=saved');
  }
  const name = text(b.name, 100), kind = b.kind === 'online' ? 'online' : 'inperson', address = text(b.address, 300), note = text(b.note, 300);
  if (!name) return again('Enter a name for the place.');
  if (kind === 'inperson' && !address) return again('Enter the address, so clients know where to go.');
  if (b.id) {
    const r = await q(`UPDATE core.locations SET name=$2, kind=$3, address=$4, note=$5 WHERE id=$1 RETURNING id`, [Number(b.id) || 0, name, kind, kind === 'online' ? null : address, note || null]);
    if (!r.length) return again('That place no longer exists.');
    await audit(req, 'location.edited', { ...who, subjectId: r[0].id });
  } else {
    const [l] = await q(`INSERT INTO core.locations (name, kind, address, note) VALUES ($1,$2,$3,$4) RETURNING id`, [name, kind, kind === 'online' ? null : address, note || null]);
    await audit(req, 'location.added', { ...who, subjectId: l.id });
  }
  res.redirect('/practice/locations?msg=saved');
});

// "How did you hear about us" list — same manager-only settings pattern.
const srcs = () => q(`SELECT r.*, (SELECT count(*)::int FROM clinical.enquiries e WHERE e.heard_from = r.name) AS n FROM core.referral_sources r ORDER BY r.active DESC, lower(r.name)`);
router.get('/practice/sources', pm, async (req, res) => res.send(V.sourcesPage(await srcs(), req.query.msg === 'saved' ? 'Saved.' : null, true)));
router.post('/practice/sources', pm, async (req, res) => {
  const b = req.body, name = text(b.name, 100), who = { actorType: 'staff', actorId: req.session.staff.id, subjectType: 'referral_source' };
  const again = async msg => res.status(400).send(V.sourcesPage(await srcs(), msg, false));
  const id = Number(b.id) || 0;
  if (b.action === 'retire' || b.action === 'restore') { await q(`UPDATE core.referral_sources SET active=$2 WHERE id=$1`, [id, b.action === 'restore']); await audit(req, `source.${b.action}`, { ...who, subjectId: id }); return res.redirect('/practice/sources?msg=saved'); }
  if (!name) return again('Enter a name.');
  try {
    if (id) {
      const old = await one(`SELECT name FROM core.referral_sources WHERE id=$1`, [id]); if (!old) return again('That source no longer exists.');
      await q(`UPDATE core.referral_sources SET name=$2 WHERE id=$1`, [id, name]);
      await q(`UPDATE clinical.enquiries SET heard_from=$2 WHERE heard_from=$1`, [old.name, name]); await q(`UPDATE clinical.clients SET heard_from=$2 WHERE heard_from=$1`, [old.name, name]);
    } else await q(`INSERT INTO core.referral_sources (name) VALUES ($1)`, [name]);
  } catch (e) { if (e.code === '23505') return again('That source is already in the list.'); throw e; }
  await audit(req, id ? 'source.renamed' : 'source.added', { ...who, subjectId: id || null });
  res.redirect('/practice/sources?msg=saved');
});
module.exports = { router };
