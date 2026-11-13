// server.js — phase 1 skeleton: health check only. Feature work starts in phase 2.
require('dotenv').config();
const express = require('express');
const { pool } = require('./lib/db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind nginx on the same host

// Baseline security headers. While the instance runs silently (pre-cutover) it is also noindex.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  if (process.env.NOINDEX !== 'false') res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Liveness + DB check. Deliberately returns no detail on failure.
app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.get('/', (_req, res) => res.type('text').send('Practice app — foundations only.'));

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => console.log(`listening on ${port}`));
}
module.exports = app;
