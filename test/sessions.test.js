// Integration tests for booking, schedule, calendar files and the private calendar feed.
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const run = 's' + Date.now().toString(36);
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

const T = require('../lib/time');
const progId = async n => ((await q(`SELECT id FROM core.programmes WHERE sessions=$1 AND active ORDER BY id LIMIT 1`, [n]))[0] || { id: 0 }).id;
const add = async (c, f) => { const { sessions = '8', ...rest } = f; return c.post('/therapist/clients/add', { name: 'Someone', programme: await progId(sessions), sessions_before_app: '0', reminder_dow: '3', ...rest }); };
const appts = cid => q(`SELECT * FROM clinical.appointments WHERE client_id=$1 ORDER BY id`, [cid]);
const mailsTo = (to, from = 0) => mail.outbox.slice(from).filter(m => m.to === to);
const raw = async (path, cookie) => { const r = await fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} }); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };

test('booking emails the client the date with a calendar file; a past date just records the session', { skip }, async () => {
  const t = await addStaff('Thera S', 'therapist'); const c = await staffIn(t.email);
  await add(c, { name: 'Alex Carter', email: em('alex') }); const cid = await idOf(em('alex'));
  assert.equal((await c.post(`/therapist/client/${cid}/sessions`, { date: '2027-02-31', time: '10:30' })).loc, `/therapist/client/${cid}/sessions?msg=date`);
  assert.equal((await c.post(`/therapist/client/${cid}/sessions`, { date: 'soon', time: '10:30' })).loc, `/therapist/client/${cid}/sessions?msg=date`);
  assert.equal((await appts(cid)).length, 0);
  const n = mail.outbox.length;
  const r = await c.post(`/therapist/client/${cid}/sessions`, { date: '2027-07-01', time: '10:30' });
  assert.equal(r.loc, `/therapist/client/${cid}/sessions?msg=booked`);
  const [a] = await appts(cid);
  assert.equal(new Date(a.starts_at).toISOString(), '2027-07-01T09:30:00.000Z'); // 10:30 UK summer time
  const [m] = mailsTo(em('alex'), n);
  assert.match(m.html, /Thursday 1 July 2027 at 10:30/); assert.ok(!/session \d|hypno/i.test(m.html.replace(/<h2[^]*?<\/h2>/, ''))); // date only, nothing clinical
  assert.equal(m.icalEvent.method, 'REQUEST');
  assert.match(m.icalEvent.content, /METHOD:REQUEST/); assert.match(m.icalEvent.content, /DTSTART:20270701T093000Z/); assert.match(m.icalEvent.content, /DTEND:20270701T103000Z/);
  assert.match(m.icalEvent.content, new RegExp(`UID:appointment-${a.id}@`)); assert.match(m.icalEvent.content, /SEQUENCE:0/);
  assert.match((await c.get(`/therapist/client/${cid}`)).text, /Next: Thursday 1 July 2027 at 10:30/);
  assert.match((await c.get('/therapist/clients')).text, /session 1 of 8/);
  const n2 = mail.outbox.length;
  assert.equal((await c.post(`/therapist/client/${cid}/sessions`, { date: '2026-01-05', time: '09:00' })).loc, `/therapist/client/${cid}/sessions?msg=recorded`);
  assert.equal(mailsTo(em('alex'), n2).length, 0);
  assert.match((await c.get('/therapist/clients')).text, /session 2 of 8/); // a delivered session moves the count on
  const page = await c.get(`/therapist/client/${cid}/sessions`);
  assert.match(page.text, /Coming up/); assert.match(page.text, /Monday 5 January 2026 at 09:00/);
});

test('moving a session replaces the calendar entry; cancelling tells the client and keeps the record; removing deletes it', { skip }, async () => {
  const t = await addStaff('Thera M', 'therapist'); const c = await staffIn(t.email);
  await add(c, { name: 'Morgan Lee', email: em('morgan'), first_date: '2027-03-10', first_time: '11:00' }); const cid = await idOf(em('morgan'));
  let [a] = await appts(cid);
  assert.ok(a, 'first session booked from the add-client form'); assert.equal(new Date(a.starts_at).toISOString(), '2027-03-10T11:00:00.000Z');
  let n = mail.outbox.length;
  assert.equal((await c.post(`/therapist/session/${a.id}`, { action: 'reschedule', date: '2027-03-12', time: '15:00' })).loc, `/therapist/client/${cid}/sessions?msg=moved`);
  let [m] = mailsTo(em('morgan'), n);
  assert.match(m.subject, /moved/); assert.match(m.html, /Friday 12 March 2027 at 15:00/);
  assert.match(m.icalEvent.content, new RegExp(`UID:appointment-${a.id}@`)); assert.match(m.icalEvent.content, /SEQUENCE:1/); assert.match(m.icalEvent.content, /DTSTART:20270312T150000Z/);
  n = mail.outbox.length;
  assert.equal((await c.post(`/therapist/session/${a.id}`, { action: 'cancel', return: 'schedule' })).loc, '/therapist/schedule?msg=cancelled');
  [m] = mailsTo(em('morgan'), n);
  assert.match(m.subject, /cancelled/); assert.equal(m.icalEvent.method, 'CANCEL'); assert.match(m.icalEvent.content, /METHOD:CANCEL/); assert.match(m.icalEvent.content, /STATUS:CANCELLED/); assert.match(m.icalEvent.content, /SEQUENCE:2/);
  [a] = await appts(cid); assert.equal(a.status, 'cancelled'); assert.ok(a.cancelled_at);
  const soon = T.inputDate(Date.now() + 10 * 86400000); // the schedule covers the next 60 days
  await c.post(`/therapist/session/${a.id}`, { action: 'reschedule', date: soon, time: '10:00' }); // moving a cancelled session books it again
  [a] = await appts(cid); assert.equal(a.status, 'booked'); assert.equal(a.cancelled_at, null);
  assert.ok((await c.get('/therapist/schedule')).text.includes('Morgan Lee'));
  await c.post(`/therapist/session/${a.id}`, { action: 'cancel' });
  assert.ok(!(await c.get('/therapist/schedule')).text.includes('Morgan Lee'));
  await c.post(`/therapist/session/${a.id}`, { action: 'reschedule', date: soon, time: '11:00' });
  [a] = await appts(cid);
  n = mail.outbox.length;
  assert.equal((await c.post(`/therapist/session/${a.id}`, { action: 'remove' })).loc, `/therapist/client/${cid}/sessions?msg=removed`);
  assert.equal((await appts(cid)).length, 0); assert.equal(mailsTo(em('morgan'), n)[0].icalEvent.method, 'CANCEL');
  await c.post(`/therapist/client/${cid}`, { action: 'close' });
  assert.equal((await c.post(`/therapist/client/${cid}/sessions`, { date: '2027-04-01', time: '10:00' })).loc, `/therapist/client/${cid}/sessions?msg=inactive`);
  assert.equal((await appts(cid)).length, 0);
});

test('sessions are private to the therapist: another therapist, a manager and a client are all refused', { skip }, async () => {
  const a = await addStaff('Thera X', 'therapist'), b = await addStaff('Thera Y', 'therapist'), p = await addStaff('Mgr S', 'practice_manager');
  const ca = await staffIn(a.email), cb = await staffIn(b.email), cp = await staffIn(p.email);
  await add(ca, { name: 'Private Pat', email: em('pat') }); const cid = await idOf(em('pat'));
  await ca.post('/therapist/book', { client_id: cid, date: '2027-05-05', time: '12:00' });
  const [s] = await appts(cid);
  assert.equal((await cb.get(`/therapist/client/${cid}/sessions`)).status, 404);
  assert.equal((await cb.post(`/therapist/client/${cid}/sessions`, { date: '2027-05-06', time: '12:00' })).status, 404);
  assert.equal((await cb.post('/therapist/book', { client_id: cid, date: '2027-05-06', time: '12:00' })).loc, '/therapist/book?msg=pick');
  for (const action of ['reschedule', 'cancel', 'remove']) assert.equal((await cb.post(`/therapist/session/${s.id}`, { action, date: '2027-06-01', time: '10:00' })).status, 404);
  assert.equal((await cb.get(`/therapist/session/${s.id}/calendar.ics`)).status, 404);
  assert.ok(!(await cb.get('/therapist/schedule')).text.includes('Private Pat'));
  assert.ok(!(await cb.get('/therapist/book')).text.includes('Private Pat'));
  for (const path of ['/therapist/schedule', '/therapist/book', `/therapist/client/${cid}/sessions`, `/therapist/session/${s.id}/calendar.ics`]) assert.equal((await cp.get(path)).status, 403);
  assert.equal((await cp.post(`/therapist/session/${s.id}`, { action: 'cancel' })).status, 403);
  const cl = await clientIn(em('pat'));
  assert.equal((await cl.get('/therapist/schedule')).status, 403);
  const [still] = await appts(cid); assert.equal(still.status, 'booked'); assert.equal((await appts(cid)).length, 1);
  const file = await ca.get(`/therapist/session/${s.id}/calendar.ics`);
  assert.equal(file.status, 200); assert.match(file.text, /SUMMARY:Session: Private P\./); assert.match(file.text, /DTSTART:20270505T110000Z/);
});

test('the private calendar link works without sign-in, shows first name and initial only, and can be replaced or turned off', { skip }, async () => {
  const t = await addStaff('Thera F', 'therapist'); const c = await staffIn(t.email);
  await add(c, { name: 'Jordan Blackwood', email: em('jordan'), first_date: '2027-08-02', first_time: '09:00' }); const cid = await idOf(em('jordan'));
  await c.post('/therapist/book', { client_id: cid, date: '2027-08-09', time: '09:00' });
  const [, second] = await appts(cid);
  await c.post(`/therapist/session/${second.id}`, { action: 'cancel' });
  assert.match((await c.get('/therapist/schedule')).text, /Create my calendar link/);
  const made = await c.post('/therapist/schedule/feed', {});
  const url = made.text.match(/value="http:\/\/localhost(\/cal\/[a-f0-9]{64}\.ics)"/)[1];
  const stored = (await q(`SELECT cal_feed_hash FROM core.staff WHERE id=$1`, [t.id]))[0].cal_feed_hash;
  assert.ok(stored && !url.includes(stored)); // only a hash is kept
  const feed = await raw(url);
  assert.equal(feed.status, 200); assert.match(feed.type, /text\/calendar/);
  assert.match(feed.text, /SUMMARY:Session: Jordan B\./); assert.ok(!feed.text.includes('Blackwood')); assert.ok(!feed.text.includes(em('jordan')));
  assert.equal(feed.text.match(/BEGIN:VEVENT/g).length, 1); // the cancelled one is left out
  assert.match(feed.text, /DTSTART:20270802T080000Z/);
  assert.equal((await raw('/cal/' + 'a'.repeat(64) + '.ics')).status, 404);
  assert.equal((await raw('/cal/nonsense.ics')).status, 404);
  const again = await c.post('/therapist/schedule/feed', {});
  const url2 = again.text.match(/(\/cal\/[a-f0-9]{64}\.ics)/)[1];
  assert.equal((await raw(url)).status, 404); assert.equal((await raw(url2)).status, 200);
  await c.post('/therapist/schedule/feed', { action: 'off' });
  assert.equal((await raw(url2)).status, 404);
  const home = await c.get('/therapist');
  assert.match(home.text, /No sessions today/);
});
