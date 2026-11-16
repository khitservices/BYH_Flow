// Integration tests for the therapist's own clients and the client invitation.
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const run = 'c' + Date.now().toString(36);
const em = n => `${n}.${run}@example.test`;

let server, base, q, mail;
test.before(async () => {
  if (skip) return;
  const app = require('../server'); ({ q } = require('../lib/db')); mail = require('../lib/mail');
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
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
const addStaff = (n, role) => q(`INSERT INTO core.staff (name,email,role) VALUES ($1,$2,$3) RETURNING *`, [n, em(n), role]).then(r => r[0]);
const last = (to, re) => [...mail.outbox].reverse().find(x => x.to === to && re.test(x.subject));
async function staffIn(email) {
  const c = client(); await c.post('/staff/request-code', { email });
  await c.post('/staff/verify', { email, code: last(email, /sign-in code/).html.match(/>(\d{6})</)[1] });
  return c;
}
async function clientIn(email) { // null when no link is emailed, or the link does not sign them in
  const c = client(); const n = mail.outbox.length; await c.post('/request-link', { email });
  const m = mail.outbox.slice(n).find(x => x.to === email && /sign-in link/.test(x.subject)); if (!m) return null;
  const r = await c.post('/auth/' + m.html.match(/\/auth\/([a-f0-9]+)/)[1]);
  return r.loc === '/journal' ? c : null;
}
const idOf = async e => (await q(`SELECT id FROM clinical.clients WHERE email=$1`, [e]))[0].id;

test('a therapist adds a client, who is invited and can sign in to the client area', { skip }, async () => {
  const t = await addStaff('Thera One', 'therapist'); const c = await staffIn(t.email);
  assert.equal((await c.post('/therapist/clients/add', { name: '', email: em('a') })).status, 400);
  assert.equal((await c.post('/therapist/clients/add', { name: 'A', email: 'nope' })).status, 400);
  const r = await c.post('/therapist/clients/add', { name: 'Alex Client', email: em('alex').toUpperCase() });
  assert.equal(r.status, 200); assert.match(r.text, /emailed an invitation/); assert.match(r.text, /Alex Client/);
  const inv = last(em('alex'), /client area/);
  assert.ok(inv); assert.match(inv.html, /Thera One has set up a private client area/); assert.ok(!/\/auth\//.test(inv.html));
  assert.equal((await c.post('/therapist/clients/add', { name: 'Dup', email: em('alex') })).status, 400);
  const cl = await clientIn(em('alex'));
  assert.equal((await cl.get('/journal')).status, 200);
  assert.equal((await cl.get('/therapist/clients')).status, 403);
  assert.match((await c.get('/therapist')).text, /Clients \(1\)/);
});

test('a therapist sees and changes only their own clients; a practice manager account sees none', { skip }, async () => {
  const a = await addStaff('Thera A', 'therapist'), b = await addStaff('Thera B', 'therapist'), p = await addStaff('Manager', 'practice_manager');
  const ca = await staffIn(a.email), cb = await staffIn(b.email), cp = await staffIn(p.email);
  await ca.post('/therapist/clients/add', { name: 'Only For A', email: em('onlya') });
  const id = await idOf(em('onlya'));
  assert.ok((await ca.get('/therapist/clients')).text.includes('Only For A'));
  assert.ok(!(await cb.get('/therapist/clients')).text.includes('Only For A'));
  for (const action of ['edit', 'invite', 'close', 'readonly', 'reopen']) {
    assert.equal((await cb.post(`/therapist/clients/${id}`, { action, name: 'Hijack', email: em('hijack') })).status, 404);
  }
  assert.equal((await q(`SELECT name, status FROM clinical.clients WHERE id=$1`, [id]))[0].name, 'Only For A');
  assert.equal((await cp.get('/therapist/clients')).status, 403);
  assert.equal((await cp.post('/therapist/clients/add', { name: 'X', email: em('x') })).status, 403);
  assert.equal((await cp.post(`/therapist/clients/${id}`, { action: 'close' })).status, 403);
  assert.equal((await client().get('/therapist/clients')).status, 302);
});

test('closing a record signs the client out and stops sign-in; reopening restores it; edits are kept', { skip }, async () => {
  const t = await addStaff('Thera C', 'therapist'); const c = await staffIn(t.email);
  await c.post('/therapist/clients/add', { name: 'Casey', email: em('casey') });
  const id = await idOf(em('casey'));
  const cl = await clientIn(em('casey'));
  assert.equal((await cl.get('/journal')).status, 200);
  await c.post(`/therapist/clients/${id}`, { action: 'close' });
  assert.equal((await cl.get('/journal')).status, 302);
  assert.equal(await clientIn(em('casey')), null);
  assert.equal((await c.post(`/therapist/clients/${id}`, { action: 'invite' })).status, 400);
  await c.post(`/therapist/clients/${id}`, { action: 'reopen' });
  assert.ok(await clientIn(em('casey')));
  const e = await c.post(`/therapist/clients/${id}`, { action: 'edit', name: 'Casey Renamed', email: em('casey2') });
  assert.equal(e.status, 200); assert.ok(await clientIn(em('casey2'))); assert.equal(await clientIn(em('casey')), null);
  const audit = await q(`SELECT action FROM core.audit_log WHERE subject_type='client' AND subject_id=$1`, [id]);
  for (const a of ['client.created', 'client.invited', 'client.status_changed', 'client.edited']) assert.ok(audit.some(r => r.action === a), a);
});
