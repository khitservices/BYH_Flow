// Integration tests for the client journal: private to the client, files checked and encrypted, edit window, counts-only for therapists.
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.FILE_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.STORAGE_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'byhjournal-'));
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const run = 'j' + Date.now().toString(36);
const em = n => `${n}.${run}@example.test`;
let server, base, q, mail;
test.before(async () => {
  if (skip) return;
  const app = require('../server'); ({ q } = require('../lib/db')); mail = require('../lib/mail');
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  await q(`DELETE FROM documents.forms WHERE therapist_id IN (SELECT id FROM core.staff WHERE email LIKE '%.${run}@example.test')`);
  await q(`DELETE FROM clinical.enquiries WHERE therapist_id IN (SELECT id FROM core.staff WHERE email LIKE '%.${run}@example.test')`);
  await q(`DELETE FROM clinical.clients WHERE email LIKE '%.${run}@example.test'`);
  await q(`DELETE FROM core.staff WHERE email LIKE '%.${run}@example.test'`);
  server.close(); await require('../lib/db').pool.end();
});

function client(ip) {
  const jar = {};
  const call = async (method, path, form, multipart) => {
    const headers = { ...(ip ? { 'x-forwarded-for': ip } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (multipart) body = multipart; else if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, redirect: 'manual', headers, body });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, loc: r.headers.get('location'), headers: r.headers, buf, text: buf.toString('utf8') };
  };
  return { get: p => call('GET', p), post: (p, f) => call('POST', p, f), upload: (p, fields, file) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); if (file) fd.append('file', new Blob([file.data], { type: file.type }), file.name); return call('POST', p, null, fd); } };
}
const addStaff = (n, role) => q(`INSERT INTO core.staff (name,email,role) VALUES ($1,$2,$3) RETURNING *`, [n, em(n), role]).then(r => r[0]);
const last = (to, re) => [...mail.outbox].reverse().find(x => x.to === to && re.test(x.subject));
async function staffIn(email, ip) {
  const c = client(ip); await c.post('/staff/request-code', { email });
  await c.post('/staff/verify', { email, code: last(email, /sign-in code/).html.match(/>(\d{6})</)[1] });
  return c;
}
async function clientIn(email, ip) {
  const c = client(ip); const n = mail.outbox.length; await c.post('/request-link', { email });
  const m = mail.outbox.slice(n).find(x => x.to === email && /sign-in link/.test(x.subject)); if (!m) return null;
  const r = await c.post('/auth/' + m.html.match(/\/auth\/([a-f0-9]+)/)[1]);
  return r.loc === '/journal' ? c : null;
}
const idOf = async e => (await q(`SELECT id FROM clinical.clients WHERE email=$1`, [e]))[0].id;
const progId = async n => ((await q(`SELECT id FROM core.programmes WHERE sessions=$1 AND active ORDER BY id LIMIT 1`, [n]))[0] || { id: 0 }).id;
const add = async (c, f) => c.post('/therapist/clients/add', { name: 'Someone', programme: await progId(8), sessions_before_app: '0', reminder_dow: '3', ...f });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('fake png body for the test')]);

test('journal: private to the client, files checked and encrypted, edit window, counts only for the therapist', { skip }, async () => {
  const t = await addStaff('Thera Journal', 'therapist'), m = await addStaff('Mgr Journal', 'practice_manager');
  const ct = await staffIn(t.email, '10.88.1.1'), cm = await staffIn(m.email, '10.88.1.2');
  await add(ct, { name: 'Jo Journal', email: em('jo') }); await add(ct, { name: 'Other Journal', email: em('other') });
  const jo = await clientIn(em('jo'), '10.88.2.1'), other = await clientIn(em('other'), '10.88.2.2'); assert.ok(jo && other);
  const id = await idOf(em('jo'));

  assert.match((await jo.get('/journal/entries')).text, /Only you can read your journal/);
  assert.match((await jo.get('/journal')).text, /Open my journal/);
  // text entry, escaped on the way out
  assert.equal((await jo.upload('/journal/entries', { body: 'SECRETWORDS <b>today</b> was calmer' })).loc, '/journal/entries?msg=saved');
  const page = (await jo.get('/journal/entries')).text; assert.match(page, /SECRETWORDS &lt;b&gt;today&lt;\/b&gt; was calmer/); assert.match(page, /\/edit/);
  // nothing at all is rejected
  assert.equal((await jo.upload('/journal/entries', { body: '   ' })).loc, '/journal/entries?msg=empty');
  // a real picture is accepted; a program wearing a picture's name and type is not
  assert.equal((await jo.upload('/journal/entries', { body: '' }, { data: PNG, type: 'image/png', name: 'my day.png' })).loc, '/journal/entries?msg=saved');
  assert.equal((await jo.upload('/journal/entries', { body: 'x' }, { data: Buffer.concat([Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0, 0, 0, 0]), Buffer.alloc(40)]), type: 'image/png', name: 'evil.png' })).loc, '/journal/entries?msg=file');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.journal_entries WHERE client_id=$1`, [id]))[0].n, 2);
  const fe = (await q(`SELECT id, file_object_id, file_name FROM clinical.journal_entries WHERE client_id=$1 AND file_object_id IS NOT NULL`, [id]))[0];
  assert.equal(fe.file_name, 'my day.png');
  // the owner can open it; it is encrypted on disk; others cannot
  const got = await jo.get(`/journal/file/${fe.id}`); assert.equal(got.status, 200); assert.deepStrictEqual(got.buf, PNG); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  const onDisk = require('node:fs').readFileSync(require('node:path').join(process.env.STORAGE_DIR, fe.file_object_id.slice(0, 2), fe.file_object_id)); assert.ok(!onDisk.includes(PNG));
  assert.equal((await other.get(`/journal/file/${fe.id}`)).status, 404);
  assert.notEqual((await ct.get(`/journal/file/${fe.id}`)).status, 200);          // the therapist is not the client
  assert.notEqual((await cm.get(`/journal/file/${fe.id}`)).status, 200);
  assert.notEqual((await client().get(`/journal/file/${fe.id}`)).status, 200);     // not signed in
  assert.ok(!(await other.get('/journal/entries')).text.includes('SECRETWORDS'));
  // therapist and manager: counts only, never content or file names
  const rec = (await ct.get(`/therapist/client/${id}`)).text;
  assert.match(rec, /Their journal/); assert.match(rec, /<strong>2<\/strong> entries so far/); assert.ok(!/SECRETWORDS|my day\.png|calmer/.test(rec));
  for (const u of ['/practice', '/practice/stats', '/therapist/stats', '/therapist/clients']) assert.ok(!/SECRETWORDS|my day\.png/.test((await (u.startsWith('/practice') ? cm : ct).get(u)).text));
  // editing: once, within 15 minutes, then locked for good
  const te = (await q(`SELECT id FROM clinical.journal_entries WHERE client_id=$1 AND body LIKE 'SECRET%'`, [id]))[0].id;
  assert.match((await jo.get(`/journal/entries/${te}/edit`)).text, /SECRETWORDS/);
  assert.equal((await jo.post(`/journal/entries/${te}/edit`, { body: 'Corrected words' })).loc, '/journal/entries?msg=edited');
  assert.match((await jo.get('/journal/entries')).text, /Corrected words/); assert.match((await jo.get('/journal/entries')).text, /edited/);
  assert.equal((await jo.post(`/journal/entries/${te}/edit`, { body: 'Again' })).loc, '/journal/entries?msg=locked');
  assert.equal((await jo.get(`/journal/entries/${te}/edit`)).loc, '/journal/entries?msg=locked');
  assert.equal((await other.post(`/journal/entries/${te}/edit`, { body: 'Not yours' })).loc, '/journal/entries?msg=locked');
  assert.match((await q(`SELECT body FROM clinical.journal_entries WHERE id=$1`, [te]))[0].body, /Corrected words/);
  await jo.upload('/journal/entries', { body: 'Old one' });
  const oldId = (await q(`SELECT id FROM clinical.journal_entries WHERE client_id=$1 AND body='Old one'`, [id]))[0].id;
  await q(`UPDATE clinical.journal_entries SET created_at = now() - interval '16 minutes' WHERE id=$1`, [oldId]);
  assert.equal((await jo.post(`/journal/entries/${oldId}/edit`, { body: 'Too late' })).loc, '/journal/entries?msg=locked');
  // entries sit under the next booked session
  await q(`INSERT INTO clinical.appointments (client_id, starts_at, status) VALUES ($1, now() + interval '3 days', 'booked')`, [id]);
  assert.match((await jo.get('/journal/entries')).text, /Leading up to your session on/);
  // earlier blocks: read only
  await q(`INSERT INTO clinical.journal_entries (client_id, block_id, body, created_at) VALUES ($1, NULL, 'FROMBEFORE', now() - interval '90 days')`, [id]);
  assert.ok(!(await jo.get('/journal/entries')).text.includes('FROMBEFORE')); assert.match((await jo.get('/journal/entries')).text, /Look back at earlier/);
  const ear = (await jo.get('/journal/earlier')).text; assert.match(ear, /FROMBEFORE/); assert.ok(!/\/edit/.test(ear));
  // a client who can only read cannot add or edit
  await q(`UPDATE clinical.clients SET status='readonly' WHERE id=$1`, [id]);
  assert.equal((await jo.upload('/journal/entries', { body: 'Not allowed' })).loc, '/journal/entries');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.journal_entries WHERE client_id=$1 AND body='Not allowed'`, [id]))[0].n, 0);
  assert.match((await jo.get('/journal/entries')).text, /read your journal but not add/);

  // support, relax and install pages
  await q(`UPDATE clinical.clients SET status='active' WHERE id=$1`, [id]);
  const sup = (await jo.get('/journal/support')).text; assert.match(sup, /tel:999/); assert.match(sup, /116 123/); assert.match(sup, /85258/); assert.match(sup, /tel:111/); assert.ok(!/0800 1111/.test(sup));
  await q(`UPDATE clinical.clients SET under16=true, consent_status='granted' WHERE id=$1`, [id]);
  assert.match((await jo.get('/journal/support')).text, /0800 1111/);
  assert.match((await jo.get('/journal/relax')).text, /not added a recording/);
  await q(`UPDATE core.staff SET relax_url='https://example.test/relax' WHERE id=$1`, [t.id]);
  assert.match((await jo.get('/journal/relax')).text, /href="https:\/\/example.test\/relax"/);
  const home = (await jo.get('/journal')).text; assert.match(home, /id="installcard"/); assert.match(home, /client\.webmanifest/);
  const man = JSON.parse((await client().get('/app/client.webmanifest')).text); assert.equal(man.start_url, '/journal');
  assert.notEqual((await ct.get('/journal/support')).status, 200);     // clients only
});

test('retention: periods worked out, journal deleted on request, records deleted when their time is up, never early', { skip }, async () => {
  const R = require('../lib/retention'), journal = require('../lib/journal'), storage = require('../lib/storage'), fs = require('node:fs'), path = require('node:path');
  const on = (id) => path.join(process.env.STORAGE_DIR, id.slice(0, 2), id);
  const D = s => new Date(s + 'T12:00:00Z'), day = d => d && d.toISOString().slice(0, 10);
  // the rules, as pure functions
  assert.equal(day(R.keepUntil({ under16: false }, D('2020-01-10'))), '2027-01-10');                                           // adult: 7 years
  assert.equal(R.keepUntil({ under16: true }, D('2022-03-01')), null);                                                         // child, no date of birth: cannot be worked out
  assert.equal(day(R.keepUntil({ under16: true, date_of_birth: '2015-06-01' }, D('2022-03-01'))), '2040-06-01');                // 6 at last contact: 25th birthday
  assert.equal(day(R.keepUntil({ under16: false, date_of_birth: '2005-01-01' }, D('2022-06-01'))), '2031-01-01');               // 17 at last contact: 26th birthday
  assert.equal(day(R.keepUntil({ under16: false, date_of_birth: '2000-01-01' }, D('2022-06-01'))), '2029-06-01');               // adult when they finished: 7 years
  assert.equal(day(R.keepUntil({ under16: true, date_of_birth: '2020-01-01' }, D('2012-01-01'))), '2045-01-01');                // (guard: later of the two rules)

  const t = await addStaff('Thera Retain', 'therapist'), ct = await staffIn(t.email, '10.89.1.1');
  const mk = async (n, extra = '') => { await add(ct, { name: 'Ret ' + n, email: em(n) }); const id = await idOf(em(n)); if (extra) await q(`UPDATE clinical.clients SET ${extra} WHERE id=$1`, [id]); return id; };
  // journal goes straight away on a deletion request, but only once confirmed; the clinical record stays
  const a = await mk('askdel'); const ca = await clientIn(em('askdel'), '10.89.2.1'); assert.ok(ca);
  await ca.upload('/journal/entries', { body: 'private words' }, { data: PNG, type: 'image/png', name: 'p.png' });
  const fid = (await q(`SELECT file_object_id AS f FROM clinical.journal_entries WHERE client_id=$1`, [a]))[0].f; assert.ok(fs.existsSync(on(fid)));
  assert.equal((await ca.post('/journal/account', { kind: 'delete' })).loc, '/journal/account?msg=confirm');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.journal_entries WHERE client_id=$1`, [a]))[0].n, 1);             // not confirmed: nothing deleted
  assert.equal((await ca.post('/journal/account', { kind: 'delete', confirm: 'on' })).loc, '/journal/account?msg=delete');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.journal_entries WHERE client_id=$1`, [a]))[0].n, 0); assert.ok(!fs.existsSync(on(fid)), 'file removed from the store');
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.clients WHERE id=$1`, [a]))[0].n, 1);                              // the clinical record is still there
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.data_requests WHERE client_id=$1 AND kind='delete'`, [a]))[0].n, 1);

  // records whose time is up are deleted completely; others are not touched
  const old = "status='closed', closed_at=now() - interval '8 years', created_at=now() - interval '9 years'";
  const due = await mk('due', old), held = await mk('held', old), young = await mk('young', "status='closed', closed_at=now() - interval '2 years'"), act = await mk('act', "created_at=now() - interval '9 years'");
  const kid = await mk('kid', old + ", under16=true, consent_status='granted'"), kidDob = await mk('kiddob', old + ", under16=true, consent_status='granted', date_of_birth=(now() - interval '14 years')::date");
  const arch = await mk('arch', old + ", archived_at=now()");
  await q(`UPDATE clinical.clients SET retention_hold=true, retention_hold_note='complaint' WHERE id=$1`, [held]);
  const pdf = await storage.put(Buffer.from('signed pdf')), jf = await storage.put(Buffer.from('journal file'));
  const enq = (await q(`INSERT INTO clinical.enquiries (therapist_id, channel, name, email, stage, converted_client_id) VALUES ($1,'website','Ret due',$2,'converted',$3) RETURNING id`, [t.id, em('due'), due]))[0].id;
  await q(`INSERT INTO documents.forms (therapist_id, client_id, enquiry_id, template_name, audience, rendered, content_sha256, status, file_id) VALUES ($1,$2,$3,'Agreement','adult','{}','x','signed',$4)`, [t.id, due, enq, pdf]);
  await q(`INSERT INTO clinical.journal_entries (client_id, block_id, body, file_object_id) VALUES ($1, NULL, 'x', $2)`, [due, jf]);
  await q(`INSERT INTO clinical.weekly_scores (client_id, week_start, score) VALUES ($1, current_date, 5)`, [due]);
  const n = await R.run(); assert.ok(n >= 1);
  const gone = async id => (await q(`SELECT count(*)::int n FROM clinical.clients WHERE id=$1`, [id]))[0].n === 0;
  assert.ok(await gone(due), 'record past its period is deleted');
  for (const [id, why] of [[held, 'on hold'], [young, 'not yet due'], [act, 'active client'], [kid, 'child without a date of birth'], [kidDob, 'child, due at 25'], [arch, 'archived']]) assert.ok(!(await gone(id)), why + ' is kept');
  assert.equal((await q(`SELECT count(*)::int n FROM documents.forms WHERE client_id=$1 OR enquiry_id=$2`, [due, enq]))[0].n, 0);
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.enquiries WHERE id=$1`, [enq]))[0].n, 0);
  assert.ok(!fs.existsSync(on(pdf)) && !fs.existsSync(on(jf)), 'signed PDF and journal file removed from the store');
  const au = (await q(`SELECT detail FROM core.audit_log WHERE action='client.record_deleted' AND subject_id=$1`, [due]))[0]; assert.ok(au); assert.ok(!/Ret due|example\.test/.test(JSON.stringify(au.detail)));   // a record that it happened, with no personal details
  assert.equal(await R.run(), 0);                                                                                                // nothing left to do

  // therapist screens: retention date shown, date of birth needed for a child, hold needs a reason
  assert.match((await ct.get(`/therapist/client/${kid}`)).text, /date of birth is needed/i);
  assert.match((await ct.get(`/therapist/client/${kidDob}`)).text, /then deleted automatically/);
  assert.equal((await ct.post(`/therapist/client/${act}`, { action: 'retention_hold', hold: 'on', hold_note: '' })).loc, `/therapist/client/${act}?msg=hold_why`);
  assert.equal((await ct.post(`/therapist/client/${act}`, { action: 'edit', name: 'Ret act', email: em('act'), date_of_birth: '2030-01-01' })).loc, `/therapist/client/${act}?msg=dob`);
  assert.equal((await ct.post(`/therapist/client/${act}`, { action: 'edit', name: 'Ret act', email: em('act'), date_of_birth: '1990-05-04' })).loc, `/therapist/client/${act}?msg=saved`);
  assert.equal(R.dateOnly((await q(`SELECT date_of_birth AS d FROM clinical.clients WHERE id=$1`, [act]))[0].d), '1990-05-04');
  assert.match((await ct.get(`/therapist/client/${act}`)).text, /value="1990-05-04"/);                                     // shown back as entered, whatever the server's time zone
});
