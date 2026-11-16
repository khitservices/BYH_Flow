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
  await q(`DELETE FROM clinical.clients WHERE email LIKE '%.${run}@example.test'`);
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
const addStaff = async (n, pm, th) => { let first; for (const role of [th && 'therapist', pm && 'practice_manager'].filter(Boolean)) { const [r] = await q(`INSERT INTO core.staff (name,email,role) VALUES ($1,$2,$3) RETURNING *`, [n, em(n), role]); first = first || r; } return first; };
const lastCode = to => { const m = [...mail.outbox].reverse().find(x => x.to === to && /sign-in code/.test(x.subject)); return m && m.html.match(/>(\d{6})</)[1]; };
async function login(c, email) {
  await c.post('/staff/request-code', { email });
  return c.post('/staff/verify', { email, code: lastCode(email) });
}
const form = over => ({ from_address: 'practice@example.test', from_name: 'Test Practice', smtp_host: 'smtp.example.test', smtp_port: '587', smtp_user: '', smtp_password: 'S3cret-pass!', action: 'save', ...over });

test('a printed code signs in when the mailbox cannot send, and works only once', { skip }, async () => {
  const s = await addStaff('owner', true, true); const c = client();
  const { code, id } = await A.issueStaffCode(s, 30 * 60 * 1000); // what scripts/signin-code.js does
  await A.supersedeStaffCodes(s.email, id);
  mail.testHooks.failNext = true;                                  // the sign-in page tries to email a code and fails
  await c.post('/staff/request-code', { email: s.email });
  assert.equal(lastCode(s.email), undefined);
  const r = await c.post('/staff/verify', { email: s.email, code });
  assert.equal(r.status, 302); assert.equal(r.loc, '/choose-account');
  assert.equal((await client().post('/staff/verify', { email: s.email, code })).status, 401);
});

test('an emailed code replaces a printed one once it has been delivered', { skip }, async () => {
  const s = await addStaff('owner2', true, false);
  const { code, id } = await A.issueStaffCode(s, 30 * 60 * 1000);
  await A.supersedeStaffCodes(s.email, id);
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
  assert.ok(!page.text.includes('S3cret-pass!')); assert.match(page.text, /leave blank to keep it/); assert.match(page.text, /name="smtp_password"[^>]*value=""/);
  const audit = await q(`SELECT detail FROM core.audit_log WHERE action='mail.settings_saved' AND actor_id=$1`, [p.id]);
  assert.ok(audit.length >= 2); assert.ok(!JSON.stringify(audit).includes('S3cret-pass!'));
});

test('test email goes to the signed-in manager with the unsaved values and saves nothing', { skip }, async () => {
  const p = await addStaff('pm2', true, false); const c = client();
  await login(c, p.email);
  const before = (await q(`SELECT smtp_host FROM core.mail_settings WHERE id=1`))[0].smtp_host;
  const r = await c.post('/practice/settings/email', form({ action: 'test', smtp_host: 'unsaved.example.test' }));
  assert.equal(r.status, 200); assert.match(r.text, /Test email sent/);
  assert.match(r.text, /name="smtp_password"[^>]*value="S3cret-pass!"/); // typed password is kept after a test, so Save needs no retyping
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

test('team: only a practice manager account can manage it; adding someone sends an invitation they can sign in from', { skip }, async () => {
  const t = await addStaff('tteam', false, true); const tc = client(); await login(tc, t.email);
  assert.equal((await tc.get('/practice/team')).status, 403);
  assert.equal((await tc.post('/practice/team/add', { name: 'X', email: em('x'), role: 'practice_manager' })).status, 403);
  const p = await addStaff('pmteam', true, false); const c = client(); await login(c, p.email);
  assert.equal((await c.post('/practice/team/add', { name: 'New', email: 'nope', role: 'therapist' })).status, 400);
  assert.equal((await c.post('/practice/team/add', { name: 'New', email: em('new'), role: 'owner' })).status, 400);
  const r = await c.post('/practice/team/add', { name: 'New Therapist', email: em('new').toUpperCase(), role: 'therapist' });
  assert.equal(r.status, 200); assert.match(r.text, /emailed an invitation/);
  const inv = mail.outbox.at(-1);
  assert.equal(inv.to, em('new')); assert.match(inv.html, /therapist account/); assert.match(inv.html, /\/staff"/); assert.ok(!/\d{6}/.test(inv.html.replace(/#[0-9a-f]{6}/g, '')));
  assert.equal((await c.post('/practice/team/add', { name: 'Dup', email: em('new'), role: 'therapist' })).status, 400);
  const nc = client(); assert.equal((await login(nc, em('new'))).loc, '/therapist');
  // the same person can also be given a separate practice manager account
  assert.equal((await c.post('/practice/team/add', { name: 'New Therapist', email: em('new'), role: 'practice_manager' })).status, 200);
  assert.equal((await login(client(), em('new'))).loc, '/choose-account');
  mail.testHooks.failNext = true;
  const f = await c.post('/practice/team/add', { name: 'Late', email: em('late'), role: 'therapist' });
  assert.equal(f.status, 200); assert.match(f.text, /could not be sent/);
});

test('team: suspend signs the person out, you cannot remove yourself, and removal moves clients without showing them', { skip }, async () => {
  const p = await addStaff('pmrm', true, false); const c = client(); await login(c, p.email);
  const a = await addStaff('leaver', false, true), b = await addStaff('stayer', false, true);
  await q(`INSERT INTO clinical.clients (therapist_id,name,email) VALUES ($1,'Private Person',$2)`, [a.id, em('cl')]);
  const ac = client(); await login(ac, a.email);
  assert.equal((await ac.get('/therapist')).status, 200);
  assert.equal((await c.post(`/practice/team/${p.id}`, { action: 'remove' })).status, 400);
  assert.equal((await c.post(`/practice/team/${p.id}`, { action: 'suspend' })).status, 400);
  await c.post(`/practice/team/${a.id}`, { action: 'suspend' });
  assert.equal((await ac.get('/therapist')).status, 302); // signed out at once
  const n0 = mail.outbox.length; await client().post('/staff/request-code', { email: a.email });
  assert.equal(mail.outbox.length, n0); // a suspended account gets no code
  await c.post(`/practice/team/${a.id}`, { action: 'reactivate' });
  const page = await c.get('/practice/team');
  assert.match(page.text, /1 client/); assert.ok(!page.text.includes('Private Person')); assert.ok(!page.text.includes(em('cl')));
  assert.equal((await c.post(`/practice/team/${a.id}`, { action: 'remove' })).status, 400);                    // has a client: must choose who takes over
  assert.equal((await c.post(`/practice/team/${a.id}`, { action: 'remove', reassign_to: p.id })).status, 400); // a manager account cannot take clients
  const done = await c.post(`/practice/team/${a.id}`, { action: 'remove', reassign_to: b.id });
  assert.equal(done.status, 200); assert.ok(!done.text.includes('Private Person'));
  assert.equal((await q(`SELECT therapist_id FROM clinical.clients WHERE email=$1`, [em('cl')]))[0].therapist_id, b.id);
  assert.equal((await q(`SELECT status FROM core.staff WHERE id=$1`, [a.id]))[0].status, 'removed');
  const before = mail.outbox.length; await client().post('/staff/request-code', { email: a.email });
  assert.equal(mail.outbox.length, before); // a removed account gets no code
  const e = await c.post(`/practice/team/${b.id}`, { action: 'edit', name: 'Stayer Renamed', email: em('stayer2') });
  assert.equal(e.status, 200); assert.equal((await login(client(), em('stayer2'))).loc, '/therapist');
});
