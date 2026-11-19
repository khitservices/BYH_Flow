// routes/pwa.js — lets a therapist put the "Add an enquiry" form on their phone's home screen.
// Public files carry no client data. /app/enquiry opens the form, asking them to sign in first if needed.
const express = require('express');
const pwa = require('../lib/pwa');
const A = require('../lib/auth');
const router = express.Router();
router.get('/app/manifest.webmanifest', (_req, res) => res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify(pwa.manifest())));
router.get('/app/client.webmanifest', (_req, res) => res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify(pwa.clientManifest())));
router.get('/app/icon-:size.png', (req, res) => { const s = Number(req.params.size); if (![180, 192, 512].includes(s)) return res.status(404).end(); res.type('png').set('Cache-Control', 'public, max-age=3600').send(pwa.icon(s)); });
router.get('/app/sw.js', (_req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(pwa.SW));
router.get('/app/enquiry', async (req, res, next) => {
  let s; try { s = await A.getSession(req); } catch (e) { return next(e); }
  if (s && s.role === 'therapist') return res.redirect('/therapist/enquiries/new');
  res.cookie('appnext', '1', { httpOnly: true, signed: true, sameSite: 'lax', secure: req.secure || process.env.NODE_ENV === 'production', maxAge: 15 * 60 * 1000 });   // after sign-in, come back to the form
  res.redirect('/staff/therapist');
});
module.exports = { router };
