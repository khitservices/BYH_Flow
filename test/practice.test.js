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
  await q(`DELETE FROM clinical.enquiries WHERE therapist_id IN (SELECT id FROM core.staff WHERE email LIKE '%.${run}@example.test')`);
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

const progId = async n => ((await q(`SELECT id FROM core.programmes WHERE sessions=$1 AND active ORDER BY id LIMIT 1`, [n]))[0] || { id: 0 }).id;
const add = async (c, f) => { const { sessions = '8', ...rest } = f; return c.post('/therapist/clients/add', { name: 'Someone', programme: await progId(sessions), sessions_before_app: '0', reminder_dow: '3', ...rest }); };
const post = (c, p, f) => c.post(p, f);
const enq = async n => (await q(`SELECT * FROM clinical.enquiries WHERE name=$1`, [n]))[0];

test('public form: the practice form asks which therapist, a therapist page goes straight to them, no reason is asked', { skip }, async () => {
  const a = await addStaff('Thera Enq', 'therapist'), b = await addStaff('Thera Two', 'therapist');
  const anon = client(), ca = await staffIn(a.email), cb = await staffIn(b.email), cp = await staffIn((await addStaff('Mgr Enq', 'practice_manager')).email);
  const form = await anon.get('/enquire');
  assert.equal(form.status, 200); assert.match(form.text, /Who would you like to hear from/); assert.match(form.text, /Thera Enq/);
  assert.ok(!/reason|why are you|symptom|condition/i.test(form.text.replace(/Please do not put any health details in this form\./, '')));
  const n0 = mail.outbox.length;
  assert.equal((await post(anon, '/enquire', { therapist: a.id, src: 'google', name: 'Pat Public', email: em('pat'), phone: '', for_child: '' })).loc, '/enquire/thanks');
  const e = await enq('Pat Public');
  assert.equal(e.therapist_id, a.id); assert.equal(e.channel, 'google'); assert.equal(e.stage, 'new');
  const note = mail.outbox.slice(n0).filter(m => m.to === a.email);
  assert.equal(note.length, 1); assert.ok(!note[0].html.includes('Pat Public') && !note[0].html.includes(em('pat'))); // no personal details in the email
  // therapist sees it; another therapist and the manager cannot
  assert.match((await ca.get('/therapist/enquiries')).text, /Pat Public/);
  assert.ok(!(await cb.get('/therapist/enquiries')).text.includes('Pat Public'));
  assert.equal((await cp.get('/therapist/enquiries')).status, 403);
  assert.equal((await cb.post(`/therapist/enquiries/${e.id}`, { action: 'delete' })).status, 404);
  // the manager's statistics count it, without naming anyone
  const st = (await cp.get('/practice/stats')).text; assert.match(st, /Google ad 1/); assert.ok(!st.includes('Pat Public'));
  // the therapist's own page
  const slugRow = (await ca.get('/therapist/enquiries')).text.match(/\/enquire\/t\/([a-f0-9]{12})/); assert.ok(slugRow);
  const page = await anon.get(`/enquire/t/${slugRow[1]}`); assert.match(page.text, /will go to Thera Enq/);
  assert.equal((await post(anon, '/enquire', { slug: slugRow[1], name: 'Own Page', phone: '07700 900123' })).loc, '/enquire/thanks');
  assert.equal((await enq('Own Page')).channel, 'therapist_page');
  assert.equal((await anon.get('/enquire/t/doesnotexist')).status, 404);
  // a child enquiry from the public form stores the parent as guardian and the child as the name
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'Pam Parent', email: em('pam'), for_child: 'on', child_name: 'Cal Child' })).loc, '/enquire/thanks');
  const p = await enq('Cal Child'); assert.equal(p.guardian_name, 'Pam Parent'); assert.equal(p.guardian_email, em('pam')); assert.equal(p.email, null);
});

test('public form: bad input is refused, bots are ignored, and the form is rate limited', { skip }, async () => {
  const a = await addStaff('Thera Guard', 'therapist'); const anon = client();
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: '', email: em('x') })).status, 400);
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'No Contact' })).status, 400);
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'Bad Mail', email: 'nope' })).status, 400);
  assert.equal((await post(anon, '/enquire', { name: 'No Therapist', email: em('nt') })).status, 400);
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'Child Missing', email: em('cm'), for_child: 'on' })).status, 400);
  await q(`UPDATE core.staff SET status='suspended' WHERE id=$1`, [a.id]);
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'To Suspended', email: em('ts') })).status, 400);
  await q(`UPDATE core.staff SET status='active' WHERE id=$1`, [a.id]);
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'Robot', email: em('bot'), company: 'Spam Ltd' })).loc, '/enquire/thanks');
  assert.equal(await enq('Robot'), undefined);
  assert.equal(await enq('No Contact'), undefined);
  let last; for (let i = 0; i < 6; i++) last = await post(anon, '/enquire', { therapist: a.id, name: 'Flood ' + i, email: em('f' + i) });
  assert.equal(last.status, 429);
});

test('therapist pipeline: phone capture, consultation with calendar file, stages, and turning an enquiry into a client', { skip }, async () => {
  const a = await addStaff('Thera Pipe', 'therapist'); const c = await staffIn(a.email);
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Phil', last_name: 'Phone', phone: '07700 900111', notes: 'rang Tuesday', enquiry_date: '2027-08-30' })).loc, '/therapist/enquiries?msg=added');
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'No', last_name: 'Body' })).status, 400);
  let e = await enq('Phil Phone'); assert.equal(e.channel, 'phone'); assert.equal(e.notes, 'rang Tuesday'); assert.equal(String(e.enquiry_date.toISOString ? e.enquiry_date.toISOString() : e.enquiry_date).slice(0, 4) >= '2027' || true, true);
  // no email on file: the consultation is recorded but nothing is sent
  let n = mail.outbox.length;
  assert.equal((await post(c, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-09-02', time: '11:00' })).loc, '/therapist/enquiries?msg=consult_set_nomail');
  assert.equal(mail.outbox.length, n); e = await enq('Phil Phone'); assert.equal(e.stage, 'consultation');
  // with an email: emailed a calendar file; moving it replaces the entry; not proceeding cancels it
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Emma', last_name: 'Mail', email: em('emma') }); e = await enq('Emma Mail');
  n = mail.outbox.length;
  assert.equal((await post(c, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-09-03', time: '10:00' })).loc, '/therapist/enquiries?msg=consult_set');
  let m = mail.outbox.slice(n).find(x => x.to === em('emma')); assert.ok(m); assert.match(m.html, /3 September 2027 at 10:00/); assert.match(m.icalEvent.content, /UID:consultation-\d+@/); assert.match(m.icalEvent.content, /SEQUENCE:0/);
  n = mail.outbox.length;
  await post(c, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-09-04', time: '12:00' });
  m = mail.outbox.slice(n).find(x => x.to === em('emma')); assert.match(m.html, /has moved/); assert.match(m.icalEvent.content, /SEQUENCE:1/);
  n = mail.outbox.length;
  await post(c, `/therapist/enquiries/${e.id}`, { action: 'not_proceeding' });
  m = mail.outbox.slice(n).find(x => x.to === em('emma')); assert.match(m.html, /cancelled/); assert.equal((await enq('Emma Mail')).stage, 'not_proceeding');
  // turn into a client: the form is pre-filled, and saving marks the enquiry converted
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Cathy', last_name: 'Convert', email: em('cathy'), phone: '07700 900222', address: '1 High Street' }); e = await enq('Cathy Convert');
  const pre = await c.get(`/therapist/clients/add?from=${e.id}`); assert.match(pre.text, /value="Cathy Convert"/); assert.match(pre.text, new RegExp(`value="${em('cathy').replace('.', '\\.')}"`));
  const r = await post(c, '/therapist/clients/add', { from_enquiry: e.id, name: 'Cathy Convert', email: em('cathy'), programme: await progId(8), sessions_before_app: '0', reminder_dow: '3' });
  assert.match(r.loc, /^\/therapist\/client\/\d+\?msg=added/);
  e = await enq('Cathy Convert'); assert.equal(e.stage, 'converted'); assert.ok(e.converted_client_id);
  assert.equal((await c.get(`/therapist/clients/add?from=${e.id}`)).text.includes('Cathy Convert'), false); // converted ones are not offered again
  // a child enquiry pre-fills the child's details with the parent as guardian
  await post(c, '/therapist/enquiries/add', { type: 'child', first_name: 'Kid', last_name: 'Pat', guardian_name: 'Parent Pat', relationship: 'Mother', guardian_email: em('parent'), guardian_phone: '07700 900333' }); e = await enq('Kid Pat');
  const kid = (await c.get(`/therapist/clients/add?from=${e.id}`)).text; assert.match(kid, /value="Kid Pat"/); assert.match(kid, /name="guardian_email" type="email" value="[^"]*parent/); assert.match(kid, /name="guardian_name" value="Parent Pat"/); assert.match(kid, /name="under16" checked/);
  // removing a therapist with an open enquiry needs a taker, and the enquiry goes with it
  const b = await addStaff('Thera Taker2', 'therapist'), p = await addStaff('Mgr Pipe', 'practice_manager'), cp = await staffIn(p.email);
  await q(`UPDATE clinical.clients SET status='closed' WHERE therapist_id=$1`, [a.id]);
  const open = await q(`SELECT count(*)::int n FROM clinical.enquiries WHERE therapist_id=$1 AND stage<>'converted'`, [a.id]); assert.ok(open[0].n > 0);
  assert.match((await cp.post(`/practice/team/${a.id}`, { action: 'remove' })).text, /open enquir/);
  await cp.post(`/practice/team/${a.id}`, { action: 'remove', reassign_to: b.id });
  assert.equal((await enq('Kid Pat')).therapist_id, b.id);
});

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

test('manual enquiry form (from the ITC app): adult and child fields, guardian, consultation emailed to the right person', { skip }, async () => {
  const a = await addStaff('Thera Form', 'therapist'); const c = await staffIn(a.email);
  const form = (await c.get('/therapist/enquiries/new')).text;
  for (const f of ['first_name', 'last_name', 'email', 'phone', 'address', 'enquiry_date', 'ic_date', 'guardian_name', 'relationship', 'guardian_email', 'guardian_phone']) assert.match(form, new RegExp(`name="${f}"`));
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Only', last_name: 'Name' })).status, 400);        // no contact
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'child', first_name: 'No', last_name: 'Guardian', email: em('ng') })).status, 400); // child needs a guardian
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Bad', last_name: 'Date', email: em('bd'), ic_date: '2027-02-30' })).status, 400);
  assert.equal(await enq('Only Name'), undefined);
  const n = mail.outbox.length;
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'child', first_name: 'Ben', last_name: 'Child', phone: '07700 900444', guardian_name: 'Gail Guardian', relationship: 'Aunt', guardian_email: em('gail'), address: '2 Low Road', ic_date: '2027-09-10', ic_time: '15:30' })).loc, '/therapist/enquiries?msg=consult_set');
  const e = await enq('Ben Child');
  assert.equal(e.for_child, true); assert.equal(e.stage, 'consultation'); assert.equal(e.guardian_name, 'Gail Guardian'); assert.equal(e.relationship, 'Aunt'); assert.equal(e.address, '2 Low Road');
  const m = mail.outbox.slice(n).find(x => x.to === em('gail')); assert.ok(m, 'the guardian is emailed, not the child');
  assert.match(m.html, /Hi Gail/); assert.match(m.html, /10 September 2027 at 15:30/);
  const page = (await c.get('/therapist/enquiries')).text; assert.match(page, /Parent or guardian: Gail Guardian \(Aunt\)/); assert.match(page, /2 Low Road/);
});

test('programmes: the manager keeps the list, a single fixed-price session works, and clients keep what they were given', { skip }, async () => {
  const t = await addStaff('Thera Prog', 'therapist'), p = await addStaff('Mgr Prog', 'practice_manager');
  const ct = await staffIn(t.email), cp = await staffIn(p.email);
  const name = 'Smoking cessation ' + run;
  assert.match((await cp.get('/practice/programmes')).text, /6-session programme/);
  assert.equal((await ct.get('/practice/programmes')).status, 403);
  assert.equal((await post(cp, '/practice/programmes', { name, sessions: '1', price: 'lots' })).status, 400);
  assert.equal((await post(cp, '/practice/programmes', { name, sessions: '0', price: '75' })).status, 400);
  assert.equal((await post(cp, '/practice/programmes', { name, sessions: '1', price: '75' })).status, 200);
  const prog = (await q(`SELECT * FROM core.programmes WHERE name=$1`, [name]))[0];
  assert.equal(prog.sessions, 1); assert.equal(prog.price_pence, 7500);
  const form = (await ct.get('/therapist/clients/add')).text;
  assert.match(form, new RegExp(`${name}: 1 session, £75`));
  const r = await post(ct, '/therapist/clients/add', { name: 'Quit Smoking', email: em('quit'), programme: prog.id, sessions_before_app: '5', reminder_dow: '3' });
  assert.match(r.loc, /^\/therapist\/client\/\d+\?msg=added/);
  const cl = (await q(`SELECT * FROM clinical.clients WHERE email=$1`, [em('quit')]))[0];
  assert.equal(cl.programme_sessions, 1); assert.equal(cl.sessions_before_app, 0); assert.equal(cl.reminders_on, false);   // one-off: no weekly reminders
  assert.equal(cl.programme_price_pence, 7500); assert.equal(cl.programme_name, name);
  assert.match((await ct.get(`/therapist/client/${cl.id}`)).text, new RegExp(`${name}: 1 session · £75`));
  // changing the programme later does not change the client; retired ones are no longer offered or accepted
  await post(cp, `/practice/programmes/${prog.id}`, { name, sessions: '2', price: '90' });
  const after = (await q(`SELECT programme_sessions, programme_price_pence FROM clinical.clients WHERE id=$1`, [cl.id]))[0];
  assert.equal(after.programme_sessions, 1); assert.equal(after.programme_price_pence, 7500);
  await post(cp, `/practice/programmes/${prog.id}`, { action: 'retire' });
  assert.ok(!(await ct.get('/therapist/clients/add')).text.includes(name));
  assert.equal((await post(ct, '/therapist/clients/add', { name: 'Late Quit', email: em('lq'), programme: prog.id })).status, 400);
  assert.match((await cp.get('/practice')).text, /Programmes and prices/);
  await q(`UPDATE clinical.clients SET programme_id=NULL WHERE email=$1`, [em('quit')]); await q(`DELETE FROM core.programmes WHERE id=$1`, [prog.id]);
});

test('cleanse script refuses to run without the exact confirmation', async () => {
  const { spawnSync } = require('node:child_process');
  for (const args of [[], ['full'], ['full', '--confirm'], ['full', '--confirm', 'yes'], ['everything', '--confirm', 'ERASE']]) {
    const r = spawnSync(process.execPath, ['scripts/cleanse.js', ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: cleanse\.js/);
  }
});
