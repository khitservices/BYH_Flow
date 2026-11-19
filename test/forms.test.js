// Integration tests for digital forms: templates, sending, signing, the client folder and the client area.
const test = require('node:test');
const assert = require('node:assert');

process.env.MAIL_TRANSPORT = 'memory';
process.env.SESSION_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.BASE_URL = 'http://localhost';
process.env.FILE_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.STORAGE_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'byhforms-'));
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
  await q(`DELETE FROM documents.forms WHERE therapist_id IN (SELECT id FROM core.staff WHERE email LIKE '%.${run}@example.test')`);
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
  return { get: p => call('GET', p), post: (p, f) => call('POST', p, f) };
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

const icDate = () => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
// Booking the initial consultation makes the person a client at once ("Consultation booked"); forms are sent from the client record.
const book = async (c, f) => { await c.post('/therapist/enquiries/add', { type: 'adult', ic_date: icDate(), ic_time: '10:00', ...f }); return (await q(`SELECT * FROM clinical.clients WHERE lower(email)=$1`, [String(f.email || f.guardian_email).toLowerCase()]))[0]; };
const tplId = async audience => (await q(`SELECT id FROM core.form_templates WHERE audience=$1 AND name LIKE 'Inspired To Change%' ORDER BY id LIMIT 1`, [audience]))[0].id;
const linkOf = (to, since) => { const m = mail.outbox.slice(since).find(x => x.to === to && /\/sign\/[a-f0-9]{64}/.test(x.html)); return m && m.html.match(/\/sign\/([a-f0-9]{64})/)[1]; };
const signBody = (extra = {}) => ({ signer_name: 'Alice Adult', signer_address: '1 High Street', signer_phone: '07700 900555', choice_tracker: 'yes', choice_newsletter: 'on', agree: 'on', ...extra });

test('attended → form emailed → signed in the app → stored in the client folder → client area', { skip }, async () => {
  const a = await addStaff('Thera Form', 'therapist'), b = await addStaff('Thera Other', 'therapist'), p = await addStaff('Mgr Form', 'practice_manager');
  const ca = await staffIn(a.email), cb = await staffIn(b.email), cp = await staffIn(p.email), anon = client();
  await post(ca, '/therapist/account', { action: 'details', qualifications: 'DipSFH', address: '52 Long Road', postcode: 'CM7 1XS', phone: '01376 000000', default_fee: '60' });
  assert.match((await ca.get('/therapist/account')).text, /value="DipSFH"/);
  const e = await book(ca, { first_name: 'Alice', last_name: 'Adult', email: em('alice'), phone: '07700 900555' }), tpl = await tplId('adult');
  assert.equal(e.status, 'consultation');
  assert.match((await ca.get(`/therapist/client/${e.id}`)).text, /Attended: send for signing/);
  // bad fee and a child template for an adult are refused
  assert.equal((await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: tpl, fee: 'free', session_format: 'online' })).loc, `/therapist/client/${e.id}?msg=form_fee`);
  assert.equal((await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: await tplId('child'), fee: '60', session_format: 'online' })).loc, `/therapist/client/${e.id}?msg=form_template`);
  const n = mail.outbox.length;
  assert.equal((await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: tpl, fee: '60', session_format: 'online' })).loc, `/therapist/client/${e.id}?msg=attended`);
  assert.equal((await q(`SELECT status FROM clinical.clients WHERE id=$1`, [e.id]))[0].status, 'attended');
  const token = linkOf(em('alice'), n); assert.ok(token, 'signing link emailed');
  // the signer sees the filled-in agreement, no sign-in needed
  const page = await anon.get(`/sign/${token}`);
  assert.equal(page.status, 200); assert.match(page.text, /Client Therapy Agreement/); assert.match(page.text, /£60 per session/); assert.match(page.text, /online via Zoom/); assert.match(page.text, /52 Long Road/);
  assert.ok(!page.text.includes('{{'));
  // validation
  for (const bad of [{ agree: '' }, { choice_tracker: '' }, { signer_name: 'A' }, { signer_address: '' }]) assert.equal((await post(anon, `/sign/${token}`, signBody(bad))).status, 400);
  assert.equal((await q(`SELECT status FROM documents.forms WHERE client_id=$1`, [e.id]))[0].status, 'sent');
  // sign
  const n2 = mail.outbox.length;
  const done = await post(anon, `/sign/${token}`, signBody());
  assert.equal(done.status, 200); assert.match(done.text, /is signed/);
  const f = (await q(`SELECT * FROM documents.forms WHERE client_id=$1`, [e.id]))[0];
  assert.equal(f.status, 'signed'); assert.ok(f.file_id); assert.equal(f.token_hash, null); assert.equal(f.signer.choices.tracker, 'yes'); assert.equal(f.signer.name, 'Alice Adult');
  assert.match(f.content_sha256, /^[a-f0-9]{64}$/);
  const copy = mail.outbox.slice(n2).find(x => x.to === em('alice')); assert.ok(copy.attachments[0].content.subarray(0, 5).toString() === '%PDF-');
  const notice = mail.outbox.slice(n2).find(x => x.to === a.email); assert.ok(notice); assert.ok(!notice.html.includes('Alice') && !notice.html.includes('1 High Street'));
  // the therapist's home page announces it until they open it
  const thome = (await ca.get('/therapist')).text; assert.match(thome, /Recently signed/); assert.match(thome, /Alice Adult<\/strong> signed/);
  assert.equal((await anon.get(`/sign/${token}`)).status, 404);                                                        // link is spent
  assert.equal((await post(anon, `/sign/${token}`, signBody())).status, 404);
  // the therapist can open it; nobody else can
  assert.equal((await anon.get(`/therapist/forms/${f.id}/pdf`)).status, 302);   // signed out: sent to sign in
  const mine = await ca.get(`/therapist/forms/${f.id}/pdf`); assert.equal(mine.status, 200); assert.match(mine.text.slice(0, 8), /%PDF-/);
  assert.ok(!/Recently signed/.test((await ca.get('/therapist')).text), 'opening the signed copy clears it from the home page');
  assert.ok(!/Recently signed/.test((await cb.get('/therapist')).text), 'another therapist never sees it');
  assert.equal((await cb.get(`/therapist/forms/${f.id}/pdf`)).status, 404);
  assert.equal((await cp.get(`/therapist/forms/${f.id}/pdf`)).status, 403);
  assert.match((await ca.get(`/therapist/client/${e.id}`)).text, /Signed/);
  // proceeding after the consultation makes them an active client with a programme; the signed form stays in their folder
  const r = await post(ca, `/therapist/client/${e.id}`, { action: 'proceed', programme: await progId(8), sessions_before_app: '0' });
  assert.equal(r.loc, `/therapist/client/${e.id}?msg=proceeded`);
  assert.equal((await q(`SELECT status, programme_sessions FROM clinical.clients WHERE id=$1`, [e.id]))[0].programme_sessions, 8);
  const rec = (await ca.get(`/therapist/client/${e.id}`)).text; assert.match(rec, /Open signed copy/);
  const cl = await clientIn(em('alice')); assert.ok(cl);
  const home = (await cl.get('/journal')).text; assert.match(home, /<h2>Forms<\/h2>/); assert.match(home, /Open my copy/);
  const mine2 = await cl.get(`/client/forms/${f.id}/pdf`); assert.equal(mine2.status, 200);
  assert.equal((await anon.get(`/client/forms/${f.id}/pdf`)).status, 302);
});

test('a resent form replaces the old link; an expired link stops working', { skip }, async () => {
  const a = await addStaff('Thera Resend', 'therapist'); const ca = await staffIn(a.email), anon = client();
  const e = await book(ca, { first_name: 'Rita', last_name: 'Resend', email: em('rita') });
  const send = async () => { const n = mail.outbox.length; await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: await tplId('adult'), fee: '50', session_format: 'inperson' }); return linkOf(em('rita'), n); };
  const one = await send(), two = await send();
  assert.notEqual(one, two);
  assert.equal((await anon.get(`/sign/${one}`)).status, 404); assert.equal((await anon.get(`/sign/${two}`)).status, 200);
  assert.deepEqual((await q(`SELECT status FROM documents.forms WHERE client_id=$1 ORDER BY id`, [e.id])).map(r => r.status), ['void', 'sent']);
  await q(`UPDATE documents.forms SET token_expires_at = now() - interval '1 day' WHERE client_id=$1 AND status='sent'`, [e.id]);
  assert.equal((await anon.get(`/sign/${two}`)).status, 404);
  assert.equal((await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: await tplId('adult'), fee: '50', session_format: 'inperson' })).loc, `/therapist/client/${e.id}?msg=attended`); // can always send again
});

test('child forms go to the guardian; a client with no email address cannot be sent one', { skip }, async () => {
  const a = await addStaff('Thera Child', 'therapist'); const ca = await staffIn(a.email), anon = client();
  const e = await book(ca, { type: 'child', first_name: 'Kit', last_name: 'Kid', guardian_name: 'Gus Guardian', relationship: 'Father', guardian_email: em('gus') });
  assert.equal(e.email, em('gus')); assert.equal(e.consent_status, 'pending');   // a child with no email of their own: the guardian's address is used to invite
  const n = mail.outbox.length;
  assert.equal((await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: await tplId('child'), fee: '60', session_format: 'online' })).loc, `/therapist/client/${e.id}?msg=attended`);
  const token = linkOf(em('gus'), n); assert.ok(token);
  const page = (await anon.get(`/sign/${token}`)).text; assert.match(page, /Parental Consent Form/); assert.match(page, /consent for Kit Kid/); assert.match(page, /Relationship to the child/);
  assert.equal((await post(anon, `/sign/${token}`, signBody({ signer_name: 'Gus Guardian', signer_relationship: 'Father' }))).status, 200);
  assert.equal((await q(`SELECT signer FROM documents.forms WHERE client_id=$1`, [e.id]))[0].signer.relationship, 'Father');
  // a phone-only enquiry cannot be booked: an email is needed to invite them
  await post(ca, '/therapist/enquiries/add', { type: 'adult', first_name: 'Phone', last_name: 'Only', phone: '07700 900666', ic_date: icDate(), ic_time: '10:00' });
  assert.equal((await q(`SELECT count(*)::int n FROM clinical.clients WHERE name='Phone Only'`))[0].n, 0);
  const pe = (await q(`SELECT id FROM clinical.enquiries WHERE name='Phone Only'`))[0];
  assert.equal((await post(ca, `/therapist/enquiries/${pe.id}`, { action: 'consult', date: icDate(), time: '10:00' })).loc, '/therapist/enquiries?msg=need_email');
  await post(ca, `/therapist/enquiries/${pe.id}`, { action: 'contact', email: em('phoneonly') });
  assert.equal((await post(ca, `/therapist/enquiries/${pe.id}`, { action: 'consult', date: icDate(), time: '10:00' })).loc, '/therapist/enquiries?msg=booked');
  assert.equal((await q(`SELECT stage FROM clinical.enquiries WHERE id=$1`, [pe.id]))[0].stage, 'converted');
});

test('a client added directly can be sent a form from their record, and signs it in their client area', { skip }, async () => {
  const a = await addStaff('Thera Direct', 'therapist'); const ca = await staffIn(a.email);
  const r = await add(ca, { name: 'Dana Direct', email: em('dana') }); const id = await idOf(em('dana'));
  assert.match((await ca.get(`/therapist/client/${id}`)).text, /Send a form/);
  assert.match((await post(ca, `/therapist/client/${id}`, { action: 'send_form', template: await tplId('adult'), fee: '55', session_format: 'inperson' })).loc, /msg=form_sent/);
  const cl = await clientIn(em('dana')); assert.ok(cl);
  const home = (await cl.get('/journal')).text; assert.match(home, /Read and sign/);
  const fid = (await q(`SELECT id FROM documents.forms WHERE client_id=$1`, [id]))[0].id;
  assert.match((await cl.get(`/client/forms/${fid}`)).text, /£55 per session/);
  assert.equal((await post(cl, `/client/forms/${fid}`, signBody({ agree: '' }))).status, 400);
  assert.equal((await post(cl, `/client/forms/${fid}`, signBody({ signer_name: 'Dana Direct' }))).status, 200);
  assert.match((await cl.get('/journal')).text, /Open my copy/);
  assert.match((await ca.get(`/therapist/client/${id}`)).text, /Open signed copy/);
  // another client cannot reach it
  await add(ca, { name: 'Eve Else', email: em('eve') }); const other = await clientIn(em('eve'));
  assert.equal((await other.get(`/client/forms/${fid}/pdf`)).status, 404);
});

test('form templates: the manager adds and edits them, sent forms keep their wording, others are refused', { skip }, async () => {
  const t = await addStaff('Thera Tpl', 'therapist'), p = await addStaff('Mgr Tpl', 'practice_manager');
  const ct = await staffIn(t.email), cp = await staffIn(p.email), anon = client();
  assert.equal((await ct.get('/practice/forms')).status, 403);
  assert.match((await cp.get('/practice/forms')).text, /Inspired To Change: Client Therapy Agreement/);
  const mk = (o = {}) => ({ name: 'Standalone consent ' + run, audience: 'adult', title: 'Consent to treatment', wording: 'I agree to treatment with {{therapist_name}}.\n\n# Fees\n\nMy fee is {{fee}}.', signer_fields: ['phone'], choices: 'photos | tick | optional | I am happy to be photographed', closing: '', signing_intro: '', footer: '{{therapist_name}}', ...o });
  assert.equal((await post(cp, '/practice/forms', mk({ wording: '# Bad\n\nHello {{secret_field}}' }))).status, 400);
  assert.equal((await post(cp, '/practice/forms', mk({ choices: 'x | maybe | required | odd' }))).status, 400);
  assert.equal((await post(cp, '/practice/forms', mk({ signer_fields: ['relationship'] }))).status, 400);   // relationship only on child forms
  assert.equal((await post(cp, '/practice/forms', mk())).loc, '/practice/forms?msg=saved');
  const tpl = (await q(`SELECT * FROM core.form_templates WHERE name=$1`, ['Standalone consent ' + run]))[0];
  assert.match((await cp.get(`/practice/forms/${tpl.id}/preview`)).text, /My fee is £60/);
  // therapist sends the new form; later editing the template does not change what was sent
  const e = await book(ct, { first_name: 'Tess', last_name: 'Tpl', email: em('tess') });
  const n = mail.outbox.length;
  await post(ct, `/therapist/client/${e.id}`, { action: 'attended', template: tpl.id, fee: '45', session_format: 'inperson' });
  const token = linkOf(em('tess'), n); assert.match((await anon.get(`/sign/${token}`)).text, /My fee is £45/);
  await post(cp, `/practice/forms/${tpl.id}`, mk({ wording: '# Fees\n\nChanged wording {{fee}}.' }));
  assert.match((await anon.get(`/sign/${token}`)).text, /My fee is £45/);
  assert.ok(!(await anon.get(`/sign/${token}`)).text.includes('Changed wording'));
  // retired templates are no longer offered, and cannot be sent
  await post(cp, `/practice/forms/${tpl.id}`, { action: 'retire' });
  assert.equal((await post(ct, `/therapist/client/${e.id}`, { action: 'attended', template: tpl.id, fee: '45', session_format: 'inperson' })).loc, `/therapist/client/${e.id}?msg=form_template`);
  assert.match((await cp.get('/practice')).text, /<h2>Forms<\/h2>/);
  await q(`DELETE FROM documents.forms WHERE template_id=$1`, [tpl.id]); await q(`DELETE FROM core.form_templates WHERE id=$1`, [tpl.id]);
});

test('signed form: a failed email to the signer is retried, the therapist notice is retried, dismiss works', { skip }, async () => {
  const notify = require('../lib/notify');
  const a = await addStaff('Thera Retry', 'therapist'), ca = await staffIn(a.email, '10.91.1.1'), anon = client('10.91.1.2');
  await post(ca, '/therapist/account', { action: 'details', qualifications: 'DipSFH', address: '52 Long Road', postcode: 'CM7 1XS', phone: '01376 000000', default_fee: '60' });
  const e = await book(ca, { first_name: 'Rita', last_name: 'Retry', email: em('ritaretry'), phone: '07700 900777' }), tpl = await tplId('adult');
  const n = mail.outbox.length;
  const att = await post(ca, `/therapist/client/${e.id}`, { action: 'attended', template: tpl, fee: '60', session_format: 'online' }); assert.equal(att.loc, `/therapist/client/${e.id}?msg=attended`, att.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  const token = linkOf(em('ritaretry'), n); assert.ok(token);
  const n2 = mail.outbox.length;
  mail.testHooks.failNext = true;                                   // the first email out (the signer's copy) fails
  assert.match((await post(anon, `/sign/${token}`, signBody({ signer_name: 'Rita Retry' }))).text, /is signed/);   // signing itself is never blocked by email
  const f = (await q(`SELECT * FROM documents.forms WHERE client_id=$1`, [e.id]))[0];
  assert.equal(f.status, 'signed'); assert.equal(f.copy_sent_at, null); assert.equal(f.copy_attempts, 1);
  assert.ok(!mail.outbox.slice(n2).some(x => x.to === em('ritaretry')), 'no copy yet');
  assert.ok(mail.outbox.slice(n2).some(x => x.to === a.email), 'the therapist notice still went');
  assert.equal(await notify.retryCopies(), 0, 'too soon to retry');
  await q(`UPDATE documents.forms SET signed_at = now() - interval '2 minutes' WHERE id=$1`, [f.id]);
  assert.equal(await notify.retryCopies(), 1);
  const copy = mail.outbox.slice(n2).find(x => x.to === em('ritaretry')); assert.ok(copy); assert.equal(copy.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.equal(await notify.retryCopies(), 0, 'sent once only');
  assert.ok((await q(`SELECT copy_sent_at FROM documents.forms WHERE id=$1`, [f.id]))[0].copy_sent_at);
  // therapist notice failing is retried too
  await q(`UPDATE documents.forms SET status='sent' WHERE id=$1`, [f.id]); await q(`UPDATE documents.forms SET status='signed' WHERE id=$1`, [f.id]);
  const before = mail.outbox.length; mail.testHooks.failNext = true;
  assert.equal(await notify.queueNotice(a.id, 'signed', f.id), false);
  await q(`UPDATE core.notices SET created_at = now() - interval '2 minutes' WHERE ref_id=$1 AND sent_at IS NULL`, [f.id]);
  assert.ok(await notify.retryNotices() >= 1); assert.ok(mail.outbox.slice(before).some(x => x.to === a.email && /signed/i.test(x.subject)));
  // dismiss from the home page
  assert.match((await ca.get('/therapist')).text, /Rita Retry<\/strong> signed/);
  await ca.post('/therapist/forms/seen', { id: String(f.id) });
  assert.ok(!/Recently signed/.test((await ca.get('/therapist')).text));
});
