// Integration tests for the in-app email settings and the printed first sign-in code.
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const run = 'm' + Date.now().toString(36);
const em = n => `${n}.${run}@example.test`;

let server, base, q, mail, A;
test.before(async () => {
  if (skip) return;
  const app = require('../server'); ({ q } = require('../lib/db')); mail = require('../lib/mail'); A = require('../lib/auth');
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  await q(`UPDATE core.mail_settings SET smtp_host=NULL, smtp_port=NULL, smtp_secure=false, smtp_user=NULL,
           smtp_password_enc=NULL, from_name=NULL, from_address=NULL, updated_at=NULL, updated_by=NULL WHERE id=1`);
  await q(`UPDATE core.practice_settings SET practice_name=NULL, practice_short=NULL, color_primary=NULL, updated_at=NULL, updated_by=NULL WHERE id=1`);
  await q(`DELETE FROM core.staff WHERE email LIKE '%.${run}@example.test'`);
  server.close(); await require('../lib/db').pool.end();
});

function client() {
  const jar = {};
  const call = async (method, path, form) => {
    const r = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
  };
  return { get: p => call('GET', p), post: (p, f) => call('POST', p, f) };
}
const addStaff = (n, pm, th) => q(`INSERT INTO core.staff (name,email,is_practice_manager,is_therapist) VALUES ($1,$2,$3,$4) RETURNING *`, [n, em(n), pm, th]).then(r => r[0]);
const lastCode = to => { const m = [...mail.outbox].reverse().find(x => x.to === to && /sign-in code/.test(x.subject)); return m && m.html.match(/>(\d{6})</)[1]; };
async function login(c, email) {
  await c.post('/staff/request-code', { email });
  return c.post('/staff/verify', { email, code: lastCode(email) });
}
const form = over => ({ from_address: 'practice@example.test', from_name: 'Test Practice', smtp_host: 'smtp.example.test', smtp_port: '587', smtp_user: '', smtp_password: 'S3cret-pass!', action: 'save', ...over });

test('a printed code signs in when the mailbox cannot send, and works only once', { skip }, async () => {
  const s = await addStaff('owner', true, true); const c = client();
  const { code, id } = await A.issueStaffCode(s, 30 * 60 * 1000); // what scripts/signin-code.js does
  await A.supersedeStaffCodes(s.id, id);
  mail.testHooks.failNext = true;                                  // the sign-in page tries to email a code and fails
  await c.post('/staff/request-code', { email: s.email });
  assert.equal(lastCode(s.email), undefined);
  const r = await c.post('/staff/verify', { email: s.email, code });
  assert.equal(r.status, 302); assert.equal(r.loc, '/choose-role');
  assert.equal((await client().post('/staff/verify', { email: s.email, code })).status, 401);
});

test('an emailed code replaces a printed one once it has been delivered', { skip }, async () => {
  const s = await addStaff('owner2', true, false);
  const { code, id } = await A.issueStaffCode(s, 30 * 60 * 1000);
  await A.supersedeStaffCodes(s.id, id);
  await client().post('/staff/request-code', { email: s.email });
  assert.equal((await client().post('/staff/verify', { email: s.email, code })).status, 401);
  assert.equal((await client().post('/staff/verify', { email: s.email, code: lastCode(s.email) })).status, 302);
});

test('only the practice manager role reaches email settings', { skip }, async () => {
  const t = await addStaff('thonly', false, true); const c = client();
  await login(c, t.email);
  assert.equal((await c.get('/practice/settings/email')).status, 403);
  assert.equal((await c.post('/practice/settings/email', form())).status, 403);
  assert.equal((await client().get('/practice/settings/email')).status, 302);
  const row = (await q(`SELECT smtp_host FROM core.mail_settings WHERE id=1`))[0];
  assert.equal(row.smtp_host, null);
});

test('settings save, the password is sealed and never shown, and a blank password keeps the saved one', { skip }, async () => {
  const p = await addStaff('pm', true, false); const c = client();
  await login(c, p.email);
  assert.equal((await c.post('/practice/settings/email', form({ smtp_host: 'bad host!' }))).status, 400);
  assert.equal((await c.post('/practice/settings/email', form({ smtp_port: '99999' }))).status, 400);
  assert.equal((await c.post('/practice/settings/email', form({ from_address: 'not-an-address' }))).status, 400);
  const r = await c.post('/practice/settings/email', form());
  assert.equal(r.status, 200); assert.match(r.text, /Saved\./); assert.ok(!r.text.includes('S3cret-pass!'));
  let row = (await q(`SELECT * FROM core.mail_settings WHERE id=1`))[0];
  assert.equal(row.smtp_host, 'smtp.example.test'); assert.equal(row.smtp_user, 'practice@example.test'); assert.equal(row.updated_by, p.id);
  assert.match(row.smtp_password_enc, /^v1\./); assert.ok(!JSON.stringify(row).includes('S3cret-pass!'));
  assert.equal(require('../lib/secretbox').open(row.smtp_password_enc), 'S3cret-pass!');
  const sealed = row.smtp_password_enc;
  await c.post('/practice/settings/email', form({ smtp_password: '', smtp_port: '465', smtp_secure: 'on' }));
  row = (await q(`SELECT * FROM core.mail_settings WHERE id=1`))[0];
  assert.equal(row.smtp_port, 465); assert.equal(row.smtp_secure, true); assert.equal(row.smtp_password_enc, sealed);
  const page = await c.get('/practice/settings/email');
  assert.ok(!page.text.includes('S3cret-pass!')); assert.match(page.text, /Leave blank to keep it/);
  const audit = await q(`SELECT detail FROM core.audit_log WHERE action='mail.settings_saved' AND actor_id=$1`, [p.id]);
  assert.ok(audit.length >= 2); assert.ok(!JSON.stringify(audit).includes('S3cret-pass!'));
});

test('test email goes to the signed-in manager with the unsaved values and saves nothing', { skip }, async () => {
  const p = await addStaff('pm2', true, false); const c = client();
  await login(c, p.email);
  const before = (await q(`SELECT smtp_host FROM core.mail_settings WHERE id=1`))[0].smtp_host;
  const r = await c.post('/practice/settings/email', form({ action: 'test', smtp_host: 'unsaved.example.test' }));
  assert.equal(r.status, 200); assert.match(r.text, /Test email sent/);
  const m = mail.outbox.at(-1);
  assert.equal(m.to, p.email); assert.equal(m.override.smtp_host, 'unsaved.example.test');
  assert.equal((await q(`SELECT smtp_host FROM core.mail_settings WHERE id=1`))[0].smtp_host, before);
  mail.testHooks.failNext = true;
  assert.equal((await c.post('/practice/settings/email', form({ action: 'test' }))).status, 400);
});

test('practice name and colour are set in the app, appear on pages and emails, and unsafe values are refused', { skip }, async () => {
  const t = await addStaff('th3', false, true); const tc = client();
  await login(tc, t.email);
  assert.equal((await tc.post('/practice/settings/practice', { practice_name: 'X', color_primary: '#123456' })).status, 403);
  const p = await addStaff('pm3', true, false); const c = client();
  await login(c, p.email);
  const bad = v => c.post('/practice/settings/practice', { practice_name: 'Calm & Co', color_primary: '#224466', ...v }).then(r => r.status);
  assert.equal(await bad({ practice_name: ' ' }), 400);
  assert.equal(await bad({ color_primary: 'red;}body{display:none' }), 400);
  assert.equal(await bad({ color_primary: '#ffee88' }), 400); // too pale for white button text
  const r = await c.post('/practice/settings/practice', { practice_name: 'Calm & Co <b>', practice_short: 'Calm', color_primary: '#224466' });
  assert.equal(r.status, 200); assert.match(r.text, /Saved\./);
  const home = await client().get('/');
  assert.ok(home.text.includes('Calm &amp; Co &lt;b&gt;')); assert.ok(!home.text.includes('<b>')); assert.ok(home.text.includes('#224466'));
  await client().post('/staff/request-code', { email: p.email });
  assert.ok(mail.outbox.at(-1).html.includes('Calm &amp; Co')); assert.ok(mail.outbox.at(-1).html.includes('#224466'));
});
