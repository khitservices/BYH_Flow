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

const add = (c, f) => c.post('/therapist/clients/add', { name: 'Someone', sessions: '8', sessions_before_app: '0', reminder_dow: '3', ...f });
const row = async id => (await q(`SELECT * FROM clinical.clients WHERE id=$1`, [id]))[0];
const act = (c, id, f) => c.post(`/therapist/client/${id}`, f);

test('a therapist adds a client, who is invited and can sign in to the client area', { skip }, async () => {
  const t = await addStaff('Thera One', 'therapist'); const c = await staffIn(t.email);
  assert.equal((await add(c, { name: '', email: em('a') })).status, 400);
  assert.equal((await add(c, { name: 'A', email: 'nope' })).status, 400);
  const r = await add(c, { name: 'Alex Client', email: em('alex').toUpperCase(), phone: '07000 000000', sessions: '10', sessions_before_app: '3', reminder_dow: '5' });
  assert.equal(r.status, 302);
  const id = await idOf(em('alex')); assert.equal(r.loc, `/therapist/client/${id}?msg=added`);
  const rec = await c.get(r.loc);
  assert.match(rec.text, /Alex Client/); assert.match(rec.text, /session 4 of 10/); assert.match(rec.text, /emailed/);
  const saved = await row(id);
  assert.equal(saved.reminder_dow, 5); assert.equal(saved.under16, false); assert.equal(saved.consent_status, 'n/a');
  const inv = last(em('alex'), /client area/);
  assert.ok(inv); assert.match(inv.html, /Thera One has set up a private client area/); assert.ok(!/\/auth\//.test(inv.html));
  const dup = await add(c, { name: 'Dup', email: em('alex') });
  assert.equal(dup.status, 400); assert.match(dup.text, /one of your clients/);
  const cl = await clientIn(em('alex'));
  assert.equal((await cl.get('/journal')).status, 200);
  assert.equal((await cl.get('/therapist/clients')).status, 403);
  assert.equal((await cl.get(`/therapist/client/${id}`)).status, 403);
  assert.match((await c.get('/therapist')).text, /Clients \(1\)/);
  assert.match((await c.get('/therapist/clients')).text, /session 4 of 10/);
  // joining part-way through always leaves at least one session to come; odd lengths fall back to 8
  await add(c, { name: 'Late', email: em('late'), sessions: '6', sessions_before_app: '99' });
  assert.equal((await row(await idOf(em('late')))).sessions_before_app, 5);
  await add(c, { name: 'Odd', email: em('odd'), sessions: '500' });
  assert.equal((await row(await idOf(em('odd')))).programme_sessions, 8);
});

test('an under-16 client cannot be added without recorded consent', { skip }, async () => {
  const t = await addStaff('Thera U', 'therapist'); const c = await staffIn(t.email);
  const teen = { name: 'Teen', email: em('teen'), under16: 'on', guardian_name: 'Pat Parent', guardian_email: em('parent'), consent_date: '2026-11-01', consent_note: 'At the first meeting' };
  const no = await add(c, teen);
  assert.equal(no.status, 400); assert.match(no.text, /given consent/); assert.match(no.text, /Pat Parent/); // what was typed is kept
  assert.equal((await add(c, { ...teen, consent_confirmed: 'on', guardian_name: '' })).status, 400);
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.clients WHERE email=$1`, [em('teen')]))[0].n, 0);
  const ok = await add(c, { ...teen, consent_confirmed: 'on' });
  assert.equal(ok.status, 302);
  const s = await row(await idOf(em('teen')));
  assert.equal(s.under16, true); assert.equal(s.consent_status, 'granted'); assert.equal(s.consent_method, 'in_person');
  assert.equal(s.consent_recorded_by, t.id); assert.equal(s.guardian_name, 'Pat Parent'); assert.equal(new Date(s.consent_at).toISOString().slice(0, 10), '2026-11-01');
  const rec = await c.get(`/therapist/client/${s.id}`);
  assert.match(rec.text, /Consent \(under 16\)/); assert.match(rec.text, /At the first meeting/);
  assert.ok(last(em('teen'), /client area/));            // the young person gets their own invitation
  assert.ok(!mail.outbox.some(m => m.to === em('parent'))); // nothing is emailed to the guardian
  await assert.rejects(q(`UPDATE clinical.clients SET consent_status='n/a' WHERE id=$1`, [s.id])); // the database refuses too
});

test('a therapist sees and changes only their own clients; a practice manager account sees none', { skip }, async () => {
  const a = await addStaff('Thera A', 'therapist'), b = await addStaff('Thera B', 'therapist'), p = await addStaff('Manager', 'practice_manager');
  const ca = await staffIn(a.email), cb = await staffIn(b.email), cp = await staffIn(p.email);
  await add(ca, { name: 'Only For A', email: em('onlya') });
  const id = await idOf(em('onlya'));
  assert.ok((await ca.get('/therapist/clients')).text.includes('Only For A'));
  assert.ok(!(await cb.get('/therapist/clients')).text.includes('Only For A'));
  assert.equal((await cb.get(`/therapist/client/${id}`)).status, 404);
  for (const action of ['edit', 'invite', 'close', 'readonly', 'reopen', 'extend', 'reminders']) {
    assert.equal((await act(cb, id, { action, name: 'Hijack', email: em('hijack') })).status, 404);
  }
  const other = await add(cb, { name: 'Mine?', email: em('onlya') });
  assert.equal(other.status, 400); assert.ok(!other.text.includes('Only For A')); assert.ok(!other.text.includes('Thera A')); // no hint whose client it is
  assert.equal((await row(id)).name, 'Only For A'); assert.equal((await row(id)).status, 'active');
  for (const path of ['/therapist/clients', '/therapist/clients/add', `/therapist/client/${id}`]) assert.equal((await cp.get(path)).status, 403);
  assert.equal((await add(cp, { name: 'X', email: em('x') })).status, 403);
  assert.equal((await act(cp, id, { action: 'close' })).status, 403);
  assert.equal((await client().get('/therapist/clients')).status, 302);
});

test('closing signs the client out and stops sign-in; reopening soon resumes, later starts a new programme', { skip }, async () => {
  const t = await addStaff('Thera C', 'therapist'); const c = await staffIn(t.email);
  await add(c, { name: 'Casey', email: em('casey'), sessions: '6', sessions_before_app: '2' });
  const id = await idOf(em('casey'));
  const cl = await clientIn(em('casey'));
  assert.equal((await cl.get('/journal')).status, 200);
  await act(c, id, { action: 'close' });
  assert.equal((await cl.get('/journal')).status, 302);
  assert.equal(await clientIn(em('casey')), null);
  assert.equal((await act(c, id, { action: 'invite' })).loc, `/therapist/client/${id}?msg=closed_no_invite`);
  assert.equal((await act(c, id, { action: 'reopen' })).loc, `/therapist/client/${id}?msg=resumed`);
  let s = await row(id);
  assert.equal(s.status, 'active'); assert.equal(s.programme_number, 1); assert.equal(s.sessions_before_app, 2);
  assert.ok(await clientIn(em('casey')));
  await act(c, id, { action: 'close' });
  await q(`UPDATE clinical.clients SET closed_at = now() - interval '40 days' WHERE id=$1`, [id]);
  assert.match((await c.get(`/therapist/client/${id}`)).text, /starts a new programme/);
  assert.equal((await act(c, id, { action: 'reopen', sessions: '12' })).loc, `/therapist/client/${id}?msg=fresh`);
  s = await row(id);
  assert.equal(s.programme_number, 2); assert.equal(s.programme_sessions, 12); assert.equal(s.sessions_before_app, 0); assert.equal(s.closed_at, null);
});

test('programme can be extended, reminders changed and details edited; changes are audited', { skip }, async () => {
  const t = await addStaff('Thera D', 'therapist'); const c = await staffIn(t.email);
  await add(c, { name: 'Dana', email: em('dana') });
  const id = await idOf(em('dana'));
  await act(c, id, { action: 'extend', add_sessions: '6' });
  assert.equal((await row(id)).programme_sessions, 14);
  assert.match((await c.get(`/therapist/client/${id}?msg=extended`)).text, /Programme extended/); // opening a record is itself logged
  await act(c, id, { action: 'reminders', reminder_dow: '1' }); // box unticked = off
  let s = await row(id); assert.equal(s.reminders_on, false); assert.equal(s.reminder_dow, 1);
  await act(c, id, { action: 'reminders', reminders_on: 'on', reminder_dow: '6' });
  s = await row(id); assert.equal(s.reminders_on, true); assert.equal(s.reminder_dow, 6);
  await act(c, id, { action: 'readonly' }); assert.equal((await row(id)).status, 'readonly');
  assert.ok(await clientIn(em('dana'))); // read-only clients can still sign in
  await act(c, id, { action: 'reopen' }); assert.equal((await row(id)).status, 'active');
  assert.equal((await act(c, id, { action: 'edit', name: 'Dana', email: 'bad' })).loc, `/therapist/client/${id}?msg=details`);
  await act(c, id, { action: 'edit', name: 'Dana Renamed', email: em('dana2'), phone: '07111 111111' });
  s = await row(id); assert.equal(s.name, 'Dana Renamed'); assert.equal(s.phone, '07111 111111');
  assert.ok(await clientIn(em('dana2'))); assert.equal(await clientIn(em('dana')), null);
  const audit = await q(`SELECT action FROM core.audit_log WHERE subject_type='client' AND subject_id=$1`, [id]);
  for (const a of ['client.created', 'client.invited', 'client.viewed', 'client.programme_extended', 'client.reminders_changed', 'client.status_changed', 'client.edited']) assert.ok(audit.some(r => r.action === a), a);
});
