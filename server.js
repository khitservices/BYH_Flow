// server.js — phase 2a: health check, security headers, sign-in and role shells.
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool } = require('./lib/db');

if (process.env.NODE_ENV === 'production' && (process.env.SESSION_SECRET || '').length < 32) {
  console.error('SESSION_SECRET must be set (32+ characters). Refusing to start.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind nginx on the same host
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-only-not-for-production-use-0000'));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
    'Cache-Control': 'no-store',
  });
  if (process.env.NOINDEX !== 'false') res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// State-changing requests must come from this site (SameSite=Lax cookies already cover most cases).
app.use((req, res, next) => {
  if (req.method !== 'POST' || !process.env.BASE_URL) return next();
  const origin = req.get('origin');
  if (origin && origin !== new URL(process.env.BASE_URL).origin) return res.status(403).send('Forbidden');
  next();
});

// Liveness + DB check. Deliberately returns no detail on failure.
app.get('/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

app.use(require('./lib/brand').ensureLoaded);
app.use(require('./routes/auth'));
app.use(require('./routes/sessions').router);
app.use(require('./routes/programmes').router);
app.use(require('./routes/enquiries').router);
app.use(require('./routes/therapist'));
app.use(require('./routes/account'));

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).send('Something went wrong.');
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) app.listen(port, () => console.log(`listening on ${port}`));
module.exports = app;
