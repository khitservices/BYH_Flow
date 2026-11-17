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

test('practice statistics: the manager sees counts only, and nobody else gets the page', { skip }, async () => {
  const a = await addStaff('Thera Stat', 'therapist'), p = await addStaff('Mgr Stat', 'practice_manager');
  const ca = await staffIn(a.email), cp = await staffIn(p.email);
  await add(ca, { name: 'Secretname Clientperson', email: em('secret'), first_date: '2027-09-01', first_time: '10:00' });
  await add(ca, { name: 'Another Person', email: em('other') });
  const r = await cp.get('/practice/stats');
  assert.equal(r.status, 200);
  assert.match(r.text, /Thera Stat/);
  assert.match(r.text, /Thera Stat<\/td><td>2<\/td><td>1<\/td>/);       // 2 active clients, 1 upcoming session
  for (const hidden of ['Secretname', 'Clientperson', 'Another Person', em('secret'), em('other')]) assert.ok(!r.text.includes(hidden), hidden);
  assert.match((await cp.get('/practice')).text, /Practice statistics/);
  assert.equal((await ca.get('/practice/stats')).status, 403);              // therapist refused
  assert.equal((await client().get('/practice/stats')).status, 302);        // signed out goes to sign-in
});

test('cleanse script refuses to run without the exact confirmation', async () => {
  const { spawnSync } = require('node:child_process');
  for (const args of [[], ['full'], ['full', '--confirm'], ['full', '--confirm', 'yes'], ['everything', '--confirm', 'ERASE']]) {
    const r = spawnSync(process.execPath, ['scripts/cleanse.js', ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: cleanse\.js/);
  }
});
