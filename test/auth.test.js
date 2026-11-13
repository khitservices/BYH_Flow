// Integration tests for sign-in and the access rules. Needs a migrated database:
//   DATABASE_URL=postgres://... npm run migrate && DATABASE_URL=postgres://... npm test
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.FILE_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const run = Date.now().toString(36);
const em = n => `${n}.${run}@example.test`;

let app, server, base, q, mail;
test.before(async () => {
  if (skip) return;
  app = require('../server'); ({ q } = require('../lib/db')); mail = require('../lib/mail');
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  await q(`DELETE FROM clinical.clients WHERE email LIKE '%.${run}@example.test'`);
  await q(`DELETE FROM core.staff WHERE email LIKE '%.${run}@example.test'`);
  server.close(); await require('../lib/db').pool.end();
});

// minimal cookie jar
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
  return { get: p => call('GET', p), post: (p, f) => call('POST', p, f), jar };
}
const addStaff = (n, pm, th) => q(`INSERT INTO core.staff (name,email,is_practice_manager,is_therapist) VALUES ($1,$2,$3,$4) RETURNING *`, [n, em(n), pm, th]).then(r => r[0]);
const lastCode = to => { const m = [...mail.outbox].reverse().find(x => x.to === to); return m && m.html.match(/>(\d{6})</)[1]; };
async function staffLogin(c, email) {
  await c.post('/staff/request-code', { email });
  return c.post('/staff/verify', { email, code: lastCode(email) });
}

test('therapist signs in with an emailed code and reaches clinical area', { skip }, async () => {
  const s = await addStaff('thera', false, true); const c = client();
  const r = await staffLogin(c, s.email);
  assert.equal(r.status, 302); assert.equal(r.loc, '/therapist');
  assert.equal((await c.get('/therapist')).status, 200);
});

test('practice manager (not a therapist) is refused clinical routes', { skip }, async () => {
  const s = await addStaff('pmonly', true, false); const c = client();
  const r = await staffLogin(c, s.email);
  assert.equal(r.loc, '/practice');
  assert.equal((await c.get('/practice')).status, 200);
  assert.equal((await c.get('/therapist')).status, 403);
});

test('dual-role staff must choose, and only therapist role reaches clinical', { skip }, async () => {
  const s = await addStaff('both', true, true); const c = client();
  const r = await staffLogin(c, s.email);
  assert.equal(r.loc, '/choose-role');
  assert.equal((await c.get('/therapist')).status, 302); // no role chosen yet
  await c.post('/choose-role', { role: 'practice_manager' });
  assert.equal((await c.get('/therapist')).status, 403);
  await c.post('/choose-role', { role: 'therapist' });
  assert.equal((await c.get('/therapist')).status, 200);
});

test('wrong codes lock the code out after 5 attempts; a code cannot be reused', { skip }, async () => {
  const s = await addStaff('lock', false, true); const c = client();
  await c.post('/staff/request-code', { email: s.email });
  const good = lastCode(s.email); const bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/staff/verify', { email: s.email, code: bad })).status, 401);
  assert.equal((await c.post('/staff/verify', { email: s.email, code: good })).status, 401);
  const c2 = client(); assert.equal((await staffLogin(c2, s.email)).status, 302);
  assert.equal((await client().post('/staff/verify', { email: s.email, code: lastCode(s.email) })).status, 401);
});

test('sign-in responses do not reveal whether an address is registered', { skip }, async () => {
  const s = await addStaff('known', false, true);
  const a = await client().post('/staff/request-code', { email: s.email });
  const b = await client().post('/staff/request-code', { email: em('nobody') });
  assert.equal(a.status, b.status); assert.equal(a.text.replace(s.email, 'X'), b.text.replace(em('nobody'), 'X'));
  const [t] = await q(`SELECT id FROM core.staff WHERE lower(email)=$1`, [s.email]);
  await q(`INSERT INTO clinical.clients (therapist_id,name,email) VALUES ($1,'Known Client',$2)`, [t.id, em('kc')]);
  const c1 = client(), c2 = client();
  const x = await c1.post('/request-link', { email: em('kc') }), y = await c2.post('/request-link', { email: em('ghost') });
  assert.equal(x.status, y.status); assert.equal(x.text, y.text);
  assert.ok(c1.jar.pk && c2.jar.pk, 'poll cookie set in both cases');
});

test('client link: scanner GET does not consume it, POST signs in, reuse fails, clients cannot reach staff areas', { skip }, async () => {
  const [t] = await q(`SELECT id FROM core.staff LIMIT 1`);
  const [cl] = await q(`INSERT INTO clinical.clients (therapist_id,name,email) VALUES ($1,'Link Client',$2) RETURNING *`, [t.id, em('lc')]);
  const c = client(); await c.post('/request-link', { email: cl.email });
  const link = mail.outbox.filter(m => m.to === cl.email).pop().html.match(/href="[^"]*\/auth\/([a-f0-9]+)"/)[1];
  assert.equal((await client().get(`/auth/${link}`)).status, 200);   // a mail scanner pre-fetching
  assert.equal((await client().get(`/auth/${link}`)).status, 200);   // still valid
  const other = client(); const r = await other.post(`/auth/${link}`);
  assert.equal(r.status, 302); assert.equal(r.loc, '/journal');
  assert.equal((await other.get('/journal')).status, 200);
  assert.equal((await other.get('/therapist')).status, 403);
  assert.equal((await other.get('/practice')).status, 403);
  assert.equal((await client().post(`/auth/${link}`)).status, 400);  // used
  // the originating device (holding the poll cookie) can now finish its own sign-in, once
  const p1 = await c.get('/auth/poll'); assert.ok(JSON.parse(p1.text).ready);
  assert.equal((await c.get('/journal')).status, 200);
  assert.ok(!JSON.parse((await client().get('/auth/poll')).text).ready);
});

test('closed client cannot sign in; suspended staff cannot sign in', { skip }, async () => {
  const [t] = await q(`SELECT id FROM core.staff LIMIT 1`);
  await q(`INSERT INTO clinical.clients (therapist_id,name,email,status) VALUES ($1,'Closed',$2,'closed')`, [t.id, em('cc')]);
  const before = mail.outbox.length;
  await client().post('/request-link', { email: em('cc') });
  assert.equal(mail.outbox.length, before, 'no email sent to a closed client');
  const s = await addStaff('susp', false, true); await q(`UPDATE core.staff SET status='suspended' WHERE id=$1`, [s.id]);
  await client().post('/staff/request-code', { email: s.email });
  assert.ok(!mail.outbox.some(m => m.to === s.email));
});

test('audit log records sign-ins and never stores codes or tokens', { skip }, async () => {
  const rows = await q(`SELECT action, detail::text d FROM core.audit_log WHERE at > now() - interval '5 minutes'`);
  assert.ok(rows.some(r => r.action === 'staff.signed_in'));
  assert.ok(rows.some(r => r.action === 'client.signed_in'));
  assert.ok(rows.every(r => !/\d{6}|[a-f0-9]{32,}/.test(r.d || '')));
});

test('cross-site POST is rejected', { skip }, async () => {
  const r = await fetch(base + '/staff/request-code', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.c' });
  assert.equal(r.status, 403);
});
