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

function client(ip) {
  const jar = {};
  const call = async (method, path, form) => {
    const r = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(ip ? { 'x-forwarded-for': ip } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
  };
  return { get: p => call('GET', p), post: (p, f) => call('POST', p, f), cookie: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
}
const addStaff = (n, role) => q(`INSERT INTO core.staff (name,email,role) VALUES ($1,$2,$3) RETURNING *`, [n, em(n), role]).then(r => r[0]);
const last = (to, re) => [...mail.outbox].reverse().find(x => x.to === to && re.test(x.subject));
async function staffIn(email, ip) {
  const c = client(ip); await c.post('/staff/request-code', { email });
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
  const st = (await cp.get('/practice/stats')).text; assert.match(st, /Google ad<\/span>[\s\S]*?<strong>1<\/strong>/); assert.ok(!st.includes('Pat Public'));
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

test('therapist pipeline: phone capture, booking the consultation makes them a client, did-not-proceed is archived and restorable', { skip }, async () => {
  const a = await addStaff('Thera Pipe', 'therapist'); const c = await staffIn(a.email);
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Phil', last_name: 'Phone', phone: '07700 900111', notes: 'rang Tuesday', enquiry_date: '2027-08-30' })).loc, '/therapist/enquiries?msg=added');
  assert.equal((await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'No', last_name: 'Body' })).status, 400);
  let e = await enq('Phil Phone'); assert.equal(e.channel, 'phone'); assert.equal(e.notes, 'rang Tuesday'); assert.equal(e.stage, 'new');
  // no email on file: cannot be booked (they could not be invited to their client area), until one is added
  assert.equal((await post(c, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-09-02', time: '11:00' })).loc, '/therapist/enquiries?msg=need_email');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.clients WHERE name='Phil Phone'`))[0].n, 0);
  // with an email: booking the consultation creates the client at once, emails the date + calendar file + invitation
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Emma', last_name: 'Mail', email: em('emma'), phone: '07700 900777', address: '3 Low Road' }); e = await enq('Emma Mail');
  let n = mail.outbox.length;
  assert.equal((await post(c, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-09-03', time: '10:00' })).loc, '/therapist/enquiries?msg=booked');
  let m = mail.outbox.slice(n).filter(x => x.to === em('emma'));
  const book = m.find(x => x.icalEvent); assert.ok(book); assert.match(book.html, /3 September 2027 at 10:00/); assert.match(book.icalEvent.content, /UID:consultation-\d+@/); assert.match(book.icalEvent.content, /SEQUENCE:0/);
  assert.ok(m.some(x => /client area/.test(x.html)), 'invited to their client area at booking');
  e = await enq('Emma Mail'); assert.equal(e.stage, 'converted'); assert.ok(e.converted_client_id);
  let cl = (await q(`SELECT * FROM clinical.clients WHERE id=$1`, [e.converted_client_id]))[0];
  assert.equal(cl.status, 'consultation'); assert.equal(cl.programme_sessions, null); assert.equal(cl.address, '3 Low Road'); assert.equal(cl.channel, 'phone');
  assert.ok(!(await c.get('/therapist/enquiries')).text.includes('Emma Mail'));                 // no longer an enquiry
  assert.match((await c.get('/therapist/clients')).text, /Emma Mail[\s\S]*Consultation booked/);
  assert.ok(await clientIn(em('emma')), 'they can sign in to their client area straight away');
  const home = (await (await clientIn(em('emma'))).get('/journal')).text; assert.match(home, /Your initial consultation/); assert.match(home, /3 September 2027 at 10:00/);
  // move it (replaces the calendar entry); programme actions are not offered yet
  n = mail.outbox.length;
  await post(c, `/therapist/client/${cl.id}`, { action: 'ic', date: '2027-09-04', time: '12:00' });
  m = mail.outbox.slice(n).find(x => x.to === em('emma')); assert.match(m.html, /has moved/); assert.match(m.icalEvent.content, /SEQUENCE:1/);
  const rec = (await c.get(`/therapist/client/${cl.id}`)).text; assert.match(rec, /Initial consultation/); assert.ok(!rec.includes('Extend programme'));
  assert.equal((await post(c, `/therapist/client/${cl.id}`, { action: 'extend', add_sessions: '6' })).loc, `/therapist/client/${cl.id}?msg=unknown`);
  // proceeding needs a programme (and, under 16, consent), then they are Active
  assert.equal((await post(c, `/therapist/client/${cl.id}`, { action: 'proceed' })).loc, `/therapist/client/${cl.id}?msg=nodate`);
  // did not proceed: cancelled, archived, kept, out of the lists
  n = mail.outbox.length;
  await post(c, `/therapist/client/${cl.id}`, { action: 'did_not_proceed' });
  m = mail.outbox.slice(n).find(x => x.to === em('emma')); assert.match(m.html, /cancelled/);
  cl = (await q(`SELECT * FROM clinical.clients WHERE id=$1`, [cl.id]))[0];
  assert.equal(cl.status, 'closed'); assert.equal(cl.closed_reason, 'did_not_proceed'); assert.ok(cl.archived_at);
  assert.ok(!(await c.get('/therapist/clients')).text.includes('Emma Mail'));
  assert.match((await c.get('/therapist/archive')).text, /Emma Mail/);
  assert.equal(await clientIn(em('emma')), null, 'archived: no sign-in');
  // she gets in touch again: the new enquiry is matched against the archive, the therapist confirms, the old record is restored
  const anon = client('10.20.30.40');
  assert.equal((await post(anon, '/enquire', { therapist: a.id, name: 'Emma M', email: em('EMMA'.toLowerCase()) })).loc, '/enquire/thanks');
  const again = (await q(`SELECT * FROM clinical.enquiries WHERE therapist_id=$1 AND stage='new' AND name='Emma M'`, [a.id]))[0];
  const list = (await c.get('/therapist/enquiries')).text; assert.match(list, /Matches an archived client/); assert.match(list, /Emma Mail/);
  const rb = await post(c, `/therapist/enquiries/${again.id}`, { action: 'restore_match', kind: 'client', match: cl.id });
  assert.equal(rb.loc, `/therapist/client/${cl.id}?msg=restored`);
  cl = (await q(`SELECT * FROM clinical.clients WHERE id=$1`, [cl.id]))[0]; assert.equal(cl.status, 'consultation'); assert.equal(cl.archived_at, null);
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.clients WHERE lower(email)=$1`, [em('emma')]))[0].n, 1);   // no duplicate
  assert.equal((await q(`SELECT stage FROM clinical.enquiries WHERE id=$1`, [again.id]))[0].stage, 'converted');
  // another therapist never sees this therapist's archive
  const o = await addStaff('Thera Other Pipe', 'therapist'), co = await staffIn(o.email);
  await post(c, `/therapist/client/${cl.id}`, { action: 'did_not_proceed' });
  await post(anon, '/enquire', { therapist: o.id, name: 'Emma Elsewhere', email: em('emma') });
  assert.ok(!(await co.get('/therapist/enquiries')).text.includes('Matches an archived'));
  // an enquiry archived by hand is matched the same way and restored without a duplicate
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Ned', last_name: 'Nowhere', email: em('ned') }); e = await enq('Ned Nowhere');
  assert.equal((await post(c, `/therapist/enquiries/${e.id}`, { action: 'archive' })).loc, '/therapist/enquiries?msg=archived');
  await post(anon, '/enquire', { therapist: a.id, name: 'Ned N', email: em('ned') });
  const ned2 = (await q(`SELECT id FROM clinical.enquiries WHERE name='Ned N'`))[0];
  assert.match((await c.get('/therapist/enquiries')).text, /Matches an archived enquiry/);
  await post(c, `/therapist/enquiries/${ned2.id}`, { action: 'restore_match', kind: 'enquiry', match: e.id });
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.enquiries WHERE therapist_id=$1 AND name LIKE 'Ned%'`, [a.id]))[0].n, 1);
  assert.equal((await enq('Ned Nowhere')).archived_at, null);
  // 60 days with no progress archives an enquiry automatically
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Old', last_name: 'Enquiry', email: em('old') });
  await q(`UPDATE clinical.enquiries SET created_at = now() - interval '61 days', last_activity_at = now() - interval '61 days' WHERE name='Old Enquiry'`);
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'New', last_name: 'Enquiry', email: em('newer') });
  assert.ok(!(await c.get('/therapist/enquiries')).text.includes('Old Enquiry'));
  assert.equal((await enq('Old Enquiry')).archive_reason, 'stale'); assert.equal((await enq('New Enquiry')).archived_at, null);
  // under 16: the child is invited at the guardian's address, consent is recorded when they proceed
  await post(c, '/therapist/enquiries/add', { type: 'child', first_name: 'Kid', last_name: 'Pat', guardian_name: 'Parent Pat', relationship: 'Mother', guardian_email: em('parent'), guardian_phone: '07700 900333' }); e = await enq('Kid Pat');
  await post(c, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-10-01', time: '09:00' });
  const kid = (await q(`SELECT * FROM clinical.clients WHERE name='Kid Pat'`))[0]; assert.equal(kid.under16, true); assert.equal(kid.consent_status, 'pending'); assert.equal(kid.email, em('parent'));
  assert.equal((await post(c, `/therapist/client/${kid.id}`, { action: 'proceed', programme: await progId(8) })).loc, `/therapist/client/${kid.id}?msg=consent`);
  assert.equal((await post(c, `/therapist/client/${kid.id}`, { action: 'proceed', programme: await progId(8), consent_confirmed: 'on', consent_date: '2027-10-01' })).loc, `/therapist/client/${kid.id}?msg=proceeded`);
  const act = (await q(`SELECT * FROM clinical.clients WHERE id=$1`, [kid.id]))[0]; assert.equal(act.status, 'active'); assert.equal(act.consent_status, 'granted'); assert.equal(act.programme_sessions, 8);
  await assert.rejects(q(`UPDATE clinical.clients SET consent_status='pending' WHERE id=$1`, [kid.id]));          // database refuses an active under-16 without consent
  // removing a therapist with an open enquiry needs a taker, and the enquiry goes with it
  const b = await addStaff('Thera Taker2', 'therapist'), p = await addStaff('Mgr Pipe', 'practice_manager'), cp = await staffIn(p.email);
  await q(`UPDATE clinical.clients SET status='closed' WHERE therapist_id=$1`, [a.id]);
  const open = await q(`SELECT count(*)::int n FROM clinical.enquiries WHERE therapist_id=$1 AND stage<>'converted'`, [a.id]); assert.ok(open[0].n > 0);
  assert.match((await cp.post(`/practice/team/${a.id}`, { action: 'remove' })).text, /open enquir/);
  await cp.post(`/practice/team/${a.id}`, { action: 'remove', reassign_to: b.id });
  assert.equal((await enq('Phil Phone')).therapist_id, b.id);
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
  const r = await post(c, '/therapist/enquiries/add', { type: 'child', first_name: 'Ben', last_name: 'Child', phone: '07700 900444', guardian_name: 'Gail Guardian', relationship: 'Aunt', guardian_email: em('gail'), address: '2 Low Road', ic_date: '2027-09-10', ic_time: '15:30' });
  assert.match(r.loc, /^\/therapist\/client\/\d+\?msg=ic_set/);                      // a consultation date makes them a client straight away
  const cl = (await q(`SELECT * FROM clinical.clients WHERE name='Ben Child'`))[0];
  assert.equal(cl.under16, true); assert.equal(cl.status, 'consultation'); assert.equal(cl.guardian_name, 'Gail Guardian'); assert.equal(cl.address, '2 Low Road'); assert.equal(cl.email, em('gail'));
  assert.equal((await enq('Ben Child')).stage, 'converted');
  const m = mail.outbox.slice(n).find(x => x.to === em('gail') && x.icalEvent); assert.ok(m, 'the guardian is emailed, not the child');
  assert.match(m.html, /Hello Gail/); assert.match(m.html, /10 September 2027 at 15:30/);
  const rec = (await c.get(r.loc.split('?')[0])).text; assert.match(rec, /Parent or guardian: Gail Guardian/); assert.match(rec, /Consent is recorded when they proceed/);
  // without a consultation date it stays an enquiry
  await post(c, '/therapist/enquiries/add', { type: 'adult', first_name: 'Still', last_name: 'Enquiry', email: em('still') });
  const page = (await c.get('/therapist/enquiries')).text; assert.match(page, /Still Enquiry/); assert.ok(!page.includes('Ben Child'));
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
  await q(`UPDATE clinical.clients SET programme_id=NULL WHERE email=$1`, [em('quit')]); await q(`UPDATE clinical.clients SET current_block_id=NULL WHERE email=$1`, [em('quit')]); await q(`UPDATE clinical.appointments SET block_id=NULL WHERE block_id IN (SELECT id FROM clinical.programme_blocks WHERE programme_id=$1)`, [prog.id]); await q(`DELETE FROM clinical.programme_blocks WHERE programme_id=$1`, [prog.id]); await q(`DELETE FROM core.programmes WHERE id=$1`, [prog.id]);
});

test('landing pages: each user type gets their own overview, and the manager sees numbers only', { skip }, async () => {
  const t = await addStaff('Thera Home', 'therapist'), p = await addStaff('Mgr Home', 'practice_manager');
  const ct = await staffIn(t.email), cp = await staffIn(p.email);
  await post(ct, '/therapist/enquiries/add', { type: 'adult', first_name: 'Hidden', last_name: 'Enquirer', email: em('hide') });
  await add(ct, { name: 'Secret Clientname', email: em('secretc'), first_date: '2027-09-20', first_time: '10:00' });
  const th = (await ct.get('/therapist')).text;
  assert.match(th, /Hello Thera/); assert.match(th, /<h2>Enquiries<\/h2><span class="stat">1<\/span>/); assert.match(th, /<h2>Clients<\/h2><span class="stat">1<\/span>/); assert.match(th, /Sign out/);
  assert.match(th, /class="grid"/); assert.match(th, /class="side"/); assert.match(th, /href="\/therapist\/clients"/);                                  // the wide, card layout
  const pm = (await cp.get('/practice')).text;
  assert.match(pm, /Practice overview/); assert.match(pm, /<h2>Team<\/h2>/); assert.match(pm, /<h2>Programmes<\/h2>/); assert.match(pm, /Sign out/);
  for (const hidden of ['Hidden Enquirer', 'Secret Clientname', 'Clientname', em('hide')]) assert.ok(!pm.includes(hidden), hidden);
  const cl = await clientIn(em('secretc')); assert.ok(cl);
  const home = (await cl.get('/journal')).text;
  assert.match(home, /Hello Secret/); assert.match(home, /Your next session/); assert.match(home, /20 September 2027 at 10:00/); assert.match(home, /[Ss]ession 1 of 8/); assert.match(home, /Your client area with Thera Home/);
  assert.equal((await cl.get('/practice')).status, 403); assert.equal((await cl.get('/therapist')).status, 403);
  const list = (await ct.get('/therapist/enquiries')).text; assert.match(list, /Book the initial consultation/); assert.ok(!list.includes('Mark as proceeding'));
});

test('cleanse script refuses to run without the exact confirmation', async () => {
  const { spawnSync } = require('node:child_process');
  for (const args of [[], ['full'], ['full', '--confirm'], ['full', '--confirm', 'yes'], ['everything', '--confirm', 'ERASE']]) {
    const r = spawnSync(process.execPath, ['scripts/cleanse.js', ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage: cleanse\.js/);
  }
});

test('blocks of sessions: a further block or a standalone session is kept distinct, counts follow the block, the manager sees counts only', { skip }, async () => {
  const t = await addStaff('Thera Blocks', 'therapist'), p = await addStaff('Mgr Blocks', 'practice_manager');
  const ct = await staffIn(t.email), cp = await staffIn(p.email);
  const name = 'Cessation ' + run;
  await post(cp, '/practice/programmes', { name, sessions: '1', price: '75' });
  const single = (await q(`SELECT * FROM core.programmes WHERE name=$1`, [name]))[0];
  await add(ct, { name: 'Blocky Client', email: em('blocky'), sessions: '6' });
  const id = await idOf(em('blocky'));
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.programme_blocks WHERE client_id=$1`, [id]))[0].n, 1);
  // two sessions held in block 1; a new block needs the current one ended
  await post(ct, '/therapist/book', { client_id: id, date: '2026-01-05', time: '10:00' }); await post(ct, '/therapist/book', { client_id: id, date: '2026-01-12', time: '10:00' });
  assert.equal((await post(ct, `/therapist/client/${id}`, { action: 'new_block', programme: single.id })).loc, `/therapist/client/${id}?msg=block_open`);
  assert.equal((await post(ct, `/therapist/client/${id}`, { action: 'new_block', programme: single.id, end_early: 'on' })).loc, `/therapist/client/${id}?msg=block_started`);
  const bl = await q(`SELECT * FROM clinical.programme_blocks WHERE client_id=$1 ORDER BY number`, [id]);
  assert.equal(bl.length, 2); assert.ok(bl[0].ended_at); assert.equal(bl[1].sessions, 1); assert.equal(bl[1].price_pence, 7500);
  const c2 = (await q(`SELECT * FROM clinical.clients WHERE id=$1`, [id]))[0]; assert.equal(c2.programme_sessions, 1); assert.equal(c2.programme_number, 2);
  // the new session counts against block 2; block 1's two sessions stay with block 1
  await post(ct, '/therapist/book', { client_id: id, date: '2026-02-02', time: '10:00' });
  const by = await q(`SELECT block_id, count(*)::int n FROM clinical.appointments WHERE client_id=$1 GROUP BY 1 ORDER BY 1`, [id]);
  assert.deepEqual(by.map(r => r.n), [2, 1]); assert.equal(Number(by[1].block_id), Number(bl[1].id));
  const rec = (await ct.get(`/therapist/client/${id}`)).text; assert.match(rec, /Block 1/); assert.match(rec, new RegExp(`Block 2: ${name}`)); assert.match(rec, /Start a further block/);
  const cl = await clientIn(em('blocky')); const home = (await cl.get('/journal')).text; assert.match(home, new RegExp(`${name}: session 1 of 1`)); assert.match(home, /Earlier:/);
  const pm = (await cp.get('/practice/stats')).text; assert.match(pm, new RegExp(name)); assert.ok(!pm.includes('Blocky'));
});

test('client can ask to move or cancel the consultation and sessions; therapist is told; only their own, only future ones', { skip }, async () => {
  const t = await addStaff('Thera Ask', 'therapist'), ct = await staffIn(t.email);
  await post(ct, '/therapist/enquiries/add', { type: 'adult', first_name: 'Ivy', last_name: 'Ask', email: em('ivy'), ic_date: '2027-05-04', ic_time: '10:00' });
  const id = await idOf(em('ivy')); const cl = await clientIn(em('ivy'));
  assert.match((await cl.get('/journal/sessions')).text, /4 May 2027 at 10:00/);
  const n = mail.outbox.length;
  assert.match((await post(cl, '/journal/sessions', { target: 'ic', kind: 'reschedule', reason: 'Mornings are hard' })).loc, /msg=asked/);
  const m = mail.outbox.slice(n).find(x => x.to === t.email); assert.ok(m); assert.ok(!/Ivy|Mornings/.test(m.html));      // no personal detail by email
  assert.match((await cl.get('/journal/sessions')).text, /You asked to move this: Mornings are hard/);
  let rec = (await ct.get(`/therapist/client/${id}`)).text; assert.match(rec, /Client asked to move this: Mornings are hard/);
  assert.match((await ct.get('/therapist/clients')).text, /Asked to change a session/); assert.match((await ct.get('/therapist')).text, /asked to change a session/);
  await post(ct, `/therapist/client/${id}`, { action: 'ic', date: '2027-05-06', time: '11:00' });             // moving it clears the request
  assert.ok(!(await ct.get(`/therapist/client/${id}`)).text.includes('Client asked to'));
  await post(cl, '/journal/sessions', { target: 'ic', kind: 'cancel' }); await post(cl, '/journal/sessions', { target: 'ic', action: 'withdraw' });
  assert.equal((await q(`SELECT ic_change_requested_at FROM clinical.clients WHERE id=$1`, [id]))[0].ic_change_requested_at, null);
  // sessions: a future one can be asked about, a past one and someone else's cannot
  await post(ct, `/therapist/client/${id}`, { action: 'proceed', programme: await progId(8) });
  await post(ct, '/therapist/book', { client_id: id, date: '2027-06-01', time: '10:00' }); await post(ct, '/therapist/book', { client_id: id, date: '2026-01-01', time: '10:00' });
  const fut = (await q(`SELECT id FROM clinical.appointments WHERE client_id=$1 AND starts_at > now()`, [id]))[0].id, past = (await q(`SELECT id FROM clinical.appointments WHERE client_id=$1 AND starts_at < now()`, [id]))[0].id;
  assert.match((await post(cl, '/journal/sessions', { target: String(fut), kind: 'cancel', reason: 'Away' })).loc, /msg=asked/);
  assert.match((await ct.get(`/therapist/client/${id}/sessions`)).text, /Client asked to cancel this: Away/);
  assert.match((await post(cl, '/journal/sessions', { target: String(past), kind: 'cancel' })).loc, /msg=gone/);
  await add(ct, { name: 'Other Person', email: em('otherp') }); const oid = await idOf(em('otherp'));
  await post(ct, '/therapist/book', { client_id: oid, date: '2027-06-02', time: '10:00' });
  const theirs = (await q(`SELECT id FROM clinical.appointments WHERE client_id=$1`, [oid]))[0].id;
  assert.match((await post(cl, '/journal/sessions', { target: String(theirs), kind: 'cancel' })).loc, /msg=gone/);
  assert.equal((await q(`SELECT change_requested_at FROM clinical.appointments WHERE id=$1`, [theirs]))[0].change_requested_at, null);
  assert.equal((await client().get('/journal/sessions')).status, 302);                                            // signed out: sign in first
});

test('duplicate email: the enquiry shows who it matches and can be linked or removed; another therapist\'s client is never named', { skip }, async () => {
  const a = await addStaff('Thera Dup', 'therapist'), b = await addStaff('Thera Dup2', 'therapist');
  const ca = await staffIn(a.email), cb = await staffIn(b.email), anon = client('10.20.30.50');
  await add(ca, { name: 'Dora Dup', email: em('dora') }); const cid = await idOf(em('dora'));
  await post(anon, '/enquire', { therapist: a.id, name: 'Dora D', email: em('dora') });
  const e = (await q(`SELECT * FROM clinical.enquiries WHERE name='Dora D'`))[0];
  let page = (await ca.get('/therapist/enquiries')).text; assert.match(page, /Already your client:<\/strong> Dora Dup/); assert.match(page, /Change contact details/);
  assert.equal((await post(ca, `/therapist/enquiries/${e.id}`, { action: 'consult', date: '2027-07-01', time: '10:00' })).loc, '/therapist/enquiries?msg=taken');
  assert.equal((await post(ca, `/therapist/enquiries/${e.id}`, { action: 'link_client', match: cid })).loc, `/therapist/client/${cid}?msg=saved`);
  assert.equal((await q(`SELECT stage, converted_client_id FROM clinical.enquiries WHERE id=$1`, [e.id]))[0].stage, 'converted');
  assert.ok(!(await ca.get('/therapist/enquiries')).text.includes('Dora D'));
  // two enquiries from the same person: remove the duplicate
  await post(ca, '/therapist/enquiries/add', { type: 'adult', first_name: 'Twin', last_name: 'One', email: em('twin') });
  await post(anon, '/enquire', { therapist: a.id, name: 'Twin Two', email: em('twin') });
  const two = (await q(`SELECT id FROM clinical.enquiries WHERE name='Twin Two'`))[0], one1 = (await q(`SELECT id FROM clinical.enquiries WHERE name='Twin One'`))[0];
  assert.match((await ca.get('/therapist/enquiries')).text, /Possible duplicate/);
  assert.equal((await post(ca, `/therapist/enquiries/${two.id}`, { action: 'merge_enquiry', match: one1.id })).loc, '/therapist/enquiries?msg=merged');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.enquiries WHERE name LIKE 'Twin%'`))[0].n, 1);
  // another therapist's enquiry with Dora's email: told it cannot be used, nothing about whose, and can change the email and carry on
  await post(anon, '/enquire', { therapist: b.id, name: 'Dora Again', email: em('dora') });
  const x = (await q(`SELECT id FROM clinical.enquiries WHERE name='Dora Again'`))[0];
  page = (await cb.get('/therapist/enquiries')).text; assert.match(page, /already registered to a client in this practice/); assert.ok(!page.includes('Dora Dup'));
  await post(cb, `/therapist/enquiries/${x.id}`, { action: 'contact', email: em('dora2') });
  assert.equal((await post(cb, `/therapist/enquiries/${x.id}`, { action: 'consult', date: '2027-07-02', time: '10:00' })).loc, '/therapist/enquiries?msg=booked');
});

test('sign-in pages say who they are for; the colour takes a hex code; a logo can be uploaded, shown and removed', { skip }, async () => {
  const anon = client('10.20.30.60');
  assert.match((await anon.get('/')).text, /Client sign-in/);
  const th = await anon.get('/therapist'); assert.equal(th.loc, '/staff/therapist');
  assert.match((await anon.get('/staff/therapist')).text, /Therapist sign-in/); assert.ok(!(await anon.get('/staff/therapist')).text.includes('Client sign-in</strong>'));
  assert.equal((await anon.get('/practice')).loc, '/staff/practice');
  assert.match((await anon.get('/staff/practice')).text, /Practice manager sign-in/);
  const p = await addStaff('Mgr Brand', 'practice_manager'), cp = await staffIn(p.email);
  const settings = (await cp.get('/practice/settings/practice')).text; assert.match(settings, /id="color_hex"/); assert.match(settings, /type="color"/);
  const was = (await q(`SELECT color_primary, practice_name FROM core.practice_settings`))[0];
  for (const [typed, saved] of [['0A7B7D', '#0a7b7d'], ['#C0392B', '#c0392b'], ['#073', '#007733']]) {
    assert.equal((await cp.post('/practice/settings/practice', { practice_name: was.practice_name || 'Test Practice', color_primary: typed })).status, 200);
    assert.equal((await q(`SELECT color_primary FROM core.practice_settings`))[0].color_primary, saved);
  }
  assert.equal((await cp.post('/practice/settings/practice', { practice_name: 'X', color_primary: 'banana' })).status, 400);
  assert.equal((await cp.post('/practice/settings/practice', { practice_name: 'X', color_primary: '#ffff99' })).status, 400);       // too pale for white text
  await cp.post('/practice/settings/practice', { practice_name: was.practice_name || 'Test Practice', color_primary: was.color_primary || '#007c7e' });
  // logo: a real PNG is accepted, a disguised file and an oversize one are not, and it is public
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = async (buf, name, type) => { const fd = new FormData(); fd.append('logo', new Blob([buf], { type }), name); const r = await fetch(`${base}/practice/settings/logo`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: cp.cookie() } }); return { status: r.status, text: await r.text() }; };
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml')).status, 400);
  assert.equal((await up(Buffer.from('not an image at all'), 'x.png', 'image/png')).status, 400);
  assert.equal((await up(Buffer.concat([png, Buffer.alloc(600 * 1024)]), 'big.png', 'image/png')).status, 400);
  const ok = await up(png, 'logo.png', 'image/png'); assert.equal(ok.status, 200); assert.match(ok.text, /Logo saved/);
  const pub = await fetch(`${base}/brand/logo`); assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'image/png');
  assert.match((await anon.get('/')).text, /\/brand\/logo\?v=\d+/);
  assert.match((await cp.get('/practice')).text, /\/brand\/logo\?v=\d+/);
  assert.equal((await client().post('/practice/settings/logo', {})).status, 302);                                                   // signed out cannot change it
  await cp.post('/practice/settings/logo', { action: 'remove' });
  assert.equal((await fetch(`${base}/brand/logo`)).status, 404);
});

test('therapist sends from their own address; locations are kept by the manager and used for session bookings only', { skip }, async () => {
  const t = await addStaff('Thera Own', 'therapist'), t2 = await addStaff('Thera Plain', 'therapist'), p = await addStaff('Mgr Loc', 'practice_manager');
  const ct = await staffIn(t.email, '10.77.1.1'), ct2 = await staffIn(t2.email, '10.77.1.2'), cp = await staffIn(p.email, '10.77.1.3');
  await q(`UPDATE core.mail_settings SET from_address='practice@betteryou.example'`);
  // own address: must be on the practice's domain; optional password never echoed
  assert.match((await ct.post('/therapist/account', { action: 'sender', sender_name: 'Kat', sender_address: 'kat@elsewhere.example' })).loc, /sender_bad/);
  assert.match((await ct.post('/therapist/account', { action: 'sender', sender_name: 'Kat B', sender_address: 'Kat@betteryou.example', sender_password: 'hunter2-secret' })).loc, /sender_saved/);
  const row = (await q(`SELECT sender_name, sender_address, sender_password_enc FROM core.staff WHERE id=$1`, [t.id]))[0];
  assert.equal(row.sender_address, 'kat@betteryou.example'); assert.ok(row.sender_password_enc && !row.sender_password_enc.includes('hunter2'));
  const acct = (await ct.get('/therapist/account')).text; assert.ok(!acct.includes('hunter2')); assert.match(acct, /value="kat@betteryou.example"/);
  let n = mail.outbox.length;
  await ct.post('/therapist/account', { action: 'sender_test' });
  assert.equal(mail.outbox.slice(n).find(x => x.to === t.email).from, 'kat@betteryou.example');
  // a booking for her client comes from her address; another therapist's comes from the practice address
  const a1 = await add(ct, { name: 'Own Client', email: em('ownc') }); const a2 = await add(ct2, { name: 'Plain Client', email: em('plainc') });;
  const oc = await idOf(em('ownc')), pc = await idOf(em('plainc'));
  // locations: manager adds; therapist, not manager, cannot; in-person needs an address
  assert.equal((await ct.get('/practice/locations')).status, 403);
  assert.match((await cp.get('/practice/locations')).text, /Online \(video call\)/);
  assert.equal((await cp.post('/practice/locations', { name: 'Smith Osteopaths', kind: 'inperson', address: '' })).status, 400);
  assert.equal((await cp.post('/practice/locations', { name: 'Smith Osteopaths ' + run, kind: 'inperson', address: '12 High St, Braintree', note: 'Ring the side bell' })).loc, '/practice/locations?msg=saved');
  const loc = (await q(`SELECT * FROM core.locations WHERE name=$1`, ['Smith Osteopaths ' + run]))[0];
  const online = (await q(`SELECT * FROM core.locations WHERE kind='online'`))[0];
  await ct.post('/therapist/account', { action: 'place', location: String(online.id) });
  assert.match((await ct.get('/therapist/book')).text, new RegExp(`value="${online.id}" selected`));       // her usual place is the default
  n = mail.outbox.length;
  await ct.post('/therapist/book', { client_id: oc, date: '2027-08-02', time: '10:00' });                     // usual place
  await ct.post('/therapist/book', { client_id: oc, date: '2027-08-09', time: '10:00', location: String(loc.id) });   // this one differs
  const mails = mail.outbox.slice(n).filter(x => x.to === em('ownc'));
  assert.equal(mails.length, 2); assert.ok(mails.every(m => m.from === 'kat@betteryou.example'));
  assert.match(mails[0].html, /Online \(video call\)/); assert.match(mails[1].html, /Smith Osteopaths[^<]*, 12 High St, Braintree/); assert.match(mails[1].html, /Ring the side bell/);
  assert.match(mails[1].icalEvent.content, /LOCATION:Smith Osteopaths/);
  n = mail.outbox.length; await ct2.post('/therapist/book', { client_id: pc, date: '2027-08-03', time: '10:00' });
  const plain = mail.outbox.slice(n).find(x => x.to === em('plainc')); assert.equal(plain.from, null); assert.ok(!/Where:/.test(plain.html));   // no place set, practice sender
  // a session keeps the place it was booked with even if the location is later edited; the client sees it
  await cp.post('/practice/locations', { id: String(loc.id), name: 'Smith Osteopaths ' + run, kind: 'inperson', address: 'Moved Road' });
  const cl = await clientIn(em('ownc')); const mine = (await cl.get('/journal/sessions')).text; assert.match(mine, /12 High St, Braintree/); assert.ok(!mine.includes('Moved Road'));
  assert.match((await ct.get(`/therapist/client/${oc}/sessions`)).text, /Smith Osteopaths/);
  // retiring a place stops it being offered and clears it as anyone's usual place
  await cp.post('/practice/locations', { id: String(online.id), action: 'retire' });
  assert.equal((await q(`SELECT default_location_id FROM core.staff WHERE id=$1`, [t.id]))[0].default_location_id, null);
  await cp.post('/practice/locations', { id: String(online.id), action: 'restore' });
  assert.match((await ct.post('/therapist/account', { action: 'sender', sender_name: '', sender_address: '' })).loc, /sender_cleared/);
  assert.equal((await q(`SELECT sender_password_enc FROM core.staff WHERE id=$1`, [t.id]))[0].sender_password_enc, null);
  await q(`UPDATE core.mail_settings SET from_address=NULL`);
});

test('how did you hear about us: pick from the list or type a new source, it joins the list, follows the enquiry into the client, manager sees counts only', { skip }, async () => {
  const t = await addStaff('Thera Src', 'therapist'), p = await addStaff('Mgr Src', 'practice_manager');
  const ct = await staffIn(t.email, '10.78.1.1'), cp = await staffIn(p.email, '10.78.1.2');
  assert.match((await ct.get('/therapist/enquiries/new')).text, /How did they hear about us/);
  assert.equal((await ct.get('/practice/sources')).status, 403);
  const man = f => ct.post('/therapist/enquiries/add', { type: 'adult', first_name: 'Src', last_name: f.l, email: f.e, ...f.x });
  await man({ l: 'One', e: em('src1'), x: { heard: 'other', heard_other: 'Smith Osteopaths ' + run, ic_date: '2027-09-06' } });
  assert.equal((await q(`SELECT heard_from FROM clinical.clients WHERE email=$1`, [em('src1')]))[0].heard_from, 'Smith Osteopaths ' + run);   // carried onto the client
  const list = (await ct.get('/therapist/enquiries/new')).text; assert.match(list, new RegExp('Smith Osteopaths ' + run));                      // now offered to everyone
  const sid = (await q(`SELECT id FROM core.referral_sources WHERE name='Facebook'`))[0].id;
  await man({ l: 'Two', e: em('src2'), x: { heard: String(sid) } });
  assert.equal((await q(`SELECT heard_from FROM clinical.enquiries WHERE email=$1`, [em('src2')]))[0].heard_from, 'Facebook');
  await man({ l: 'Three', e: em('src3'), x: { heard: 'other', heard_other: 'smith osteopaths ' + run } });                                     // same name, any case: no duplicate
  assert.equal((await q(`SELECT count(*)::int n FROM core.referral_sources WHERE lower(name)=lower($1)`, ['Smith Osteopaths ' + run]))[0].n, 1);
  const pg = (await cp.get('/practice/sources')).text; assert.match(pg, /Smith Osteopaths/); assert.ok(!pg.includes(em('src1')));
  assert.match((await cp.get('/practice/stats')).text, /How they heard about us/);
  const rid = (await q(`SELECT id FROM core.referral_sources WHERE name=$1`, ['Smith Osteopaths ' + run]))[0].id;
  await cp.post('/practice/sources', { id: String(rid), action: 'rename', name: 'Smith Osteo Clinic ' + run });
  assert.equal((await q(`SELECT heard_from FROM clinical.clients WHERE email=$1`, [em('src1')]))[0].heard_from, 'Smith Osteo Clinic ' + run);
  await cp.post('/practice/sources', { id: String(rid), action: 'retire' });
  assert.ok(!(await ct.get('/therapist/enquiries/new')).text.includes('Smith Osteo Clinic ' + run));
});

test('weekly score: one per week, editable within the week, gaps shown, client and own therapist only, never the manager', { skip }, async () => {
  const scores = require('../lib/scores');
  assert.equal(scores.weekStart(new Date('2026-11-18T10:00:00Z')), '2026-11-16');    // Wednesday -> Monday
  assert.equal(scores.weekStart(new Date('2026-11-22T23:30:00Z')), '2026-11-16');    // Sunday night stays in the week
  assert.equal(scores.weekStart(new Date('2026-11-23T00:30:00Z')), '2026-11-23');
  assert.equal(scores.weekStart(new Date('2026-03-29T23:30:00Z')), '2026-03-30');    // clocks change: 00:30 BST Monday is the new week
  const a = await addStaff('Thera Score', 'therapist'), o = await addStaff('Thera NoScore', 'therapist'), p = await addStaff('Mgr Score', 'practice_manager');
  const ca = await staffIn(a.email, '10.79.1.1'), co = await staffIn(o.email, '10.79.1.2'), cp = await staffIn(p.email, '10.79.1.3');
  await add(ca, { name: 'Score Client', email: em('scorec') }); const id = await idOf(em('scorec'));
  const cl = await clientIn(em('scorec')); assert.ok(cl);
  assert.match((await cl.get('/journal')).text, /Give this week/);
  assert.equal((await cl.post('/journal/score', { score: '11' })).loc, '/journal/score?msg=bad');
  assert.equal((await cl.post('/journal/score', { score: '0' })).loc, '/journal/score?msg=bad');
  assert.equal((await cl.post('/journal/score', { score: '4' })).loc, '/journal/score?msg=saved');
  assert.equal((await cl.post('/journal/score', { score: '7', note: 'Slept better <b>this</b> week' })).loc, '/journal/score?msg=saved');                  // changed, not duplicated
  assert.deepEqual((await q(`SELECT score FROM clinical.weekly_scores WHERE client_id=$1`, [id])).map(r => r.score), [7]);
  // an earlier week and a gap between: entered directly
  await q(`INSERT INTO clinical.weekly_scores (client_id, week_start, score) VALUES ($1, $2::date - 21, 3)`, [id, scores.weekStart()]);
  const s = await scores.series(id); assert.equal(s.length, 12); assert.equal(s[11].score, 7); assert.equal(s[10].score, null); assert.equal(s[8].score, 3);
  assert.match((await cl.get('/journal/score')).text, /not entered/);
  const rec = (await ca.get(`/therapist/client/${id}`)).text; assert.match(rec, /How they have been feeling/); assert.match(rec, /Slept better &lt;b&gt;this/);    // the note is shown to the therapist, escaped
  assert.match((await cl.get('/journal/score')).text, /Slept better/);
  assert.equal((await co.get(`/therapist/client/${id}`)).status, 404);                                               // another therapist cannot see the client at all
  for (const url of ['/practice/stats', '/practice']) { const t = (await cp.get(url)).text; assert.ok(!/How they have been feeling|weekly_scores|Slept better/.test(t)); }
  assert.equal((await cp.get(`/therapist/client/${id}`)).status, 403);
  // also open to people who have only had a consultation
  await add(ca, { name: 'Pre Client', email: em('prec') });
  await q(`UPDATE clinical.clients SET status='consultation', ic_at=now()+interval '3 days', programme_sessions=NULL WHERE email=$1`, [em('prec')]);
  const cc = await clientIn(em('prec')); assert.equal((await cc.get('/journal/score')).status, 200);       // open from the first consultation, so nothing is hidden or redirected
  assert.match((await ca.get(`/therapist/client/${await idOf(em('prec'))}`)).text, /How they have been feeling/);
});

test('enquiry links detect where the visitor came from and fill in how they heard about us', { skip }, async () => {
  const a = await addStaff('Thera Detect', 'therapist');
  const hid = async (path, headers = {}) => { const t = await (await fetch(base + path, { headers })).text(); return (t.match(/name="src" value="([^"]*)"/) || [])[1]; };
  assert.equal(await hid('/enquire?gclid=abc123'), 'google');
  assert.equal(await hid('/enquire?fbclid=zzz'), 'facebook');
  assert.equal(await hid('/enquire?utm_source=Instagram'), 'facebook');
  assert.equal(await hid('/enquire', { referer: 'https://www.google.com/' }), 'google');
  assert.equal(await hid('/enquire', { referer: 'https://l.facebook.com/l.php?u=x' }), 'facebook');
  assert.equal(await hid('/enquire?utm_source=<script>'), 'website');                      // unknown tags change nothing
  assert.equal(await hid('/enquire?src=google&fbclid=1'), 'google');                       // our own tag wins
  const before = (await q(`SELECT count(*)::int n FROM core.referral_sources`))[0].n;
  const post = (ip, f) => client(ip).post('/enquire', { therapist: a.id, ...f });
  await post('10.80.1.1', { src: 'google', name: 'Ad Person', email: em('adp') });
  await post('10.80.1.2', { src: 'facebook', name: 'Fb Person', email: em('fbp') });
  await post('10.80.1.3', { name: 'Direct Person', email: em('dirp') });
  assert.match(await (await fetch(base + '/enquire?gclid=1&utm_campaign=Spring%20Stress%20Ads')).text(), /name="campaign" value="Spring Stress Ads"/);
  await post('10.80.1.5', { src: 'google', campaign: 'Spring Stress Ads', name: 'Camp Person', email: em('campp') });
  const h = async e => (await q(`SELECT channel, heard_from FROM clinical.enquiries WHERE email=$1`, [e]))[0];
  assert.deepEqual(await h(em('adp')), { channel: 'google', heard_from: 'Google' });
  assert.deepEqual(await h(em('fbp')), { channel: 'facebook', heard_from: 'Facebook' });
  assert.deepEqual(await h(em('dirp')), { channel: 'website', heard_from: 'Website' });
  assert.equal((await q(`SELECT count(*)::int n FROM core.referral_sources`))[0].n, before);   // nothing new invented
  assert.equal((await q(`SELECT campaign FROM clinical.enquiries WHERE email=$1`, [em('campp')]))[0].campaign, 'Spring Stress Ads');
  const cm = await addStaff('Mgr Camp', 'practice_manager'), cpm = await staffIn(cm.email, '10.80.1.9');
  const st = (await cpm.get('/practice/stats')).text; assert.match(st, /Spring Stress Ads/); assert.match(st, /Facebook/); assert.ok(!st.includes(em('campp')));
  await post('10.80.1.4', { src: '<script>', name: 'Odd Person', email: em('oddp') });
  assert.equal((await h(em('oddp'))).heard_from, 'Website');
});
