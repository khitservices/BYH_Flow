// Integration tests for the therapist's account page: relaxation link, handover, close request.
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const run = 'a' + Date.now().toString(36);
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
const acct = (c, f) => c.post('/therapist/account', f);
const staffRow = async id => (await q(`SELECT * FROM core.staff WHERE id=$1`, [id]))[0];

test('relaxation link: saved, tidied, cleared, and anything that is not a web address refused', { skip }, async () => {
  const t = await addStaff('Thera R', 'therapist'); const c = await staffIn(t.email);
  assert.equal((await acct(c, { action: 'relax', relax_url: 'example.org/calm' })).loc, '/therapist/account?msg=relax_saved');
  assert.equal((await staffRow(t.id)).relax_url, 'https://example.org/calm');
  for (const bad of ['javascript:alert(1)', 'not a link', 'ftp://example.org/x']) assert.equal((await acct(c, { action: 'relax', relax_url: bad })).loc, '/therapist/account?msg=relax_bad');
  assert.equal((await staffRow(t.id)).relax_url, 'https://example.org/calm');
  assert.match((await c.get('/therapist/account')).text, /value="https:\/\/example\.org\/calm"/);
  assert.equal((await acct(c, { action: 'relax', relax_url: '' })).loc, '/therapist/account?msg=relax_cleared');
  assert.equal((await staffRow(t.id)).relax_url, null);
});

test('handover moves only the therapist\'s own chosen clients, with their sessions, and tells each client', { skip }, async () => {
  const a = await addStaff('Thera Giver', 'therapist'), b = await addStaff('Thera Taker', 'therapist'), o = await addStaff('Thera Other', 'therapist'), p = await addStaff('Mgr A', 'practice_manager');
  const ca = await staffIn(a.email), cb = await staffIn(b.email), co = await staffIn(o.email), cp = await staffIn(p.email);
  await add(ca, { name: 'Move Me', email: em('move'), first_date: '2027-09-01', first_time: '10:00' }); await add(ca, { name: 'Keep Me', email: em('keep') });
  await add(co, { name: 'Not Yours', email: em('noty') });
  const move = await idOf(em('move')), keep = await idOf(em('keep')), noty = await idOf(em('noty'));
  const page = await ca.get('/therapist/account');
  assert.match(page.text, /Thera Taker/); assert.match(page.text, /Move Me/); assert.ok(!page.text.includes('Not Yours')); assert.ok(!page.text.includes('Mgr A'));
  assert.equal((await acct(ca, { action: 'handover', to: p.id, scope: 'all' })).loc, '/therapist/account?msg=handover_bad'); // not to a manager account
  assert.equal((await acct(ca, { action: 'handover', to: a.id, scope: 'all' })).loc, '/therapist/account?msg=handover_bad'); // not to yourself
  assert.equal((await acct(ca, { action: 'handover', to: b.id, scope: 'some' })).loc, '/therapist/account?msg=handover_none');
  const n = mail.outbox.length;
  // someone else's client slipped into the list is ignored
  const r = await ca.post('/therapist/account', new URLSearchParams([['action', 'handover'], ['to', b.id], ['scope', 'some'], ['client_id', move], ['client_id', noty]]));
  assert.equal(r.loc, '/therapist/account?msg=moved1');
  const owner = async id => (await q(`SELECT therapist_id FROM clinical.clients WHERE id=$1`, [id]))[0].therapist_id;
  assert.equal(await owner(move), b.id); assert.equal(await owner(keep), a.id); assert.equal(await owner(noty), o.id);
  const told = mail.outbox.slice(n).filter(m => m.to === em('move'));
  assert.equal(told.length, 1); assert.match(told[0].html, /looked after by Thera Taker/);
  assert.equal(mail.outbox.slice(n).filter(m => m.to === em('noty') || m.to === em('keep')).length, 0);
  assert.equal((await ca.get(`/therapist/client/${move}`)).status, 404);            // the giver can no longer see them
  assert.equal((await cb.get(`/therapist/client/${move}`)).status, 200);            // the taker can
  assert.match((await cb.get(`/therapist/client/${move}/sessions`)).text, /1 September 2027/); // sessions came too
  assert.match((await ca.get('/therapist/account?msg=moved1')).text, /1 client handed over/);
  assert.equal((await acct(ca, { action: 'handover', to: b.id, scope: 'all' })).loc, '/therapist/account?msg=moved1');
  assert.equal(await owner(keep), b.id);
  assert.equal((await cp.get('/therapist/account')).status, 403); assert.equal((await acct(cp, { action: 'handover', to: b.id, scope: 'all' })).status, 403);
  const audit = await q(`SELECT 1 FROM core.audit_log WHERE action='client.handed_over' AND subject_id=$1`, [move]); assert.equal(audit.length, 1);
});

test('asking to close the account tells the practice manager, shows on the Team page, and can be withdrawn', { skip }, async () => {
  const t = await addStaff('Thera Leaving', 'therapist'), p = await addStaff('Mgr C', 'practice_manager');
  const c = await staffIn(t.email), cp = await staffIn(p.email);
  const n = mail.outbox.length;
  assert.equal((await acct(c, { action: 'request_close' })).loc, '/therapist/account?msg=close_asked');
  assert.ok((await staffRow(t.id)).close_requested_at);
  const sent = mail.outbox.slice(n).filter(m => m.to === p.email);
  assert.equal(sent.length, 1); assert.match(sent[0].html, /Thera Leaving has asked/);
  await acct(c, { action: 'request_close' }); // asking twice does not email twice
  assert.equal(mail.outbox.slice(n).filter(m => m.to === p.email).length, 1);
  assert.equal((await c.get('/therapist')).status, 200); // nothing changes until the manager acts
  assert.match((await cp.get('/practice/team')).text, /Thera Leaving<\/strong>[^]*?Has asked for this account to be closed/);
  assert.match((await c.get('/therapist/account')).text, /Withdraw my request/);
  await acct(c, { action: 'withdraw_close' });
  assert.equal((await staffRow(t.id)).close_requested_at, null);
  await acct(c, { action: 'request_close' });
  await cp.post(`/practice/team/${t.id}`, { action: 'remove' });
  const gone = await staffRow(t.id); assert.equal(gone.status, 'removed'); assert.equal(gone.close_requested_at, null);
  assert.equal((await c.get('/therapist/account')).status, 302);
});
