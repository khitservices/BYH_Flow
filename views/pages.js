// views/pages.js — minimal server-rendered pages. Everything user-supplied goes through esc().
const { BRAND } = require('../lib/brand');
const { esc } = require('../lib/mail');
const T = require('../lib/time');

// w: undefined = narrow (sign-in, public pages), 'read' = forms and settings, 'wide' = working pages that fill a desktop screen.
// nav: { who, home } adds a top bar with the person's name, a Home link and Sign out.
function page(title, body, w, nav) {
  const bar = nav ? `<div class="bar"><span><strong>${esc(BRAND.practiceName)}</strong></span><span>${esc(nav.who)} · ${nav.home ? `<a href="${esc(nav.home)}">Home</a> · ` : ''}<a href="/logout">Sign out</a></span></div>` : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ${esc(BRAND.practiceName)}</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#f6f8f8;color:#222;margin:0}
main{max-width:440px;margin:8vh auto;padding:28px;background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
main.read{max-width:700px;margin:3vh auto}main.wide{max-width:1040px;margin:3vh auto}main.nav{margin-top:0}
.bar{max-width:1040px;margin:0 auto;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 16px;font-size:14px}
h1{font-size:20px;color:${BRAND.colorPrimary};margin:0 0 16px}
label{display:block;font-size:14px;font-weight:600;margin-top:12px}label.check{font-weight:400;display:flex;gap:8px;align-items:center}label.check input{width:auto;margin:0}
button.alt{background:#fff;color:${BRAND.colorPrimary};border:1px solid ${BRAND.colorPrimary}}
input,button,select,textarea{font-size:16px;padding:11px;width:100%;box-sizing:border-box;margin:6px 0;border-radius:6px}
input,textarea{border:1px solid #bbb} button{border:0;background:${BRAND.colorPrimary};color:#fff;cursor:pointer}
main.read form,main.wide form{max-width:560px}
a{color:${BRAND.colorPrimary}} .muted{color:#666;font-size:14px} form.inline{display:inline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:16px;margin:16px 0}
.card{border:1px solid #e3e8e8;border-radius:10px;padding:16px;background:#fff;display:flex;flex-direction:column;gap:6px}
.card h2{font-size:15px;margin:0;color:#444}.card p{margin:2px 0}.card .links{margin-top:auto;padding-top:8px}.card .links a{display:inline-block;margin-right:14px}
.stat{font-size:32px;font-weight:700;color:${BRAND.colorPrimary};line-height:1.1}
.cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));column-gap:32px}
@media (max-width:700px){main,main.read,main.wide{margin:0;border-radius:0;box-shadow:none;padding:18px;min-height:100vh}.cols{display:block}}
</style></head><body>${bar}<main class="${w || ''}${nav ? ' nav' : ''}"><h1>${esc(BRAND.practiceName)}</h1>${body}</main></body></html>`;
}

const wide = (t, b) => page(t, b, 'wide'), read = (t, b) => page(t, b, 'read');
const clientLogin = () => page('Client sign-in', `<p><strong>Client sign-in</strong></p><p>Enter your email and we'll send you a sign-in link.</p>
<form method="post" action="/request-link"><input name="email" type="email" autocomplete="email" required placeholder="Your email">
<button>Email me a link</button></form><p class="muted">Therapist or practice manager? <a href="/staff">Use team sign-in</a></p>`);

const clientSent = () => page('Check your email', `<p>If that address is registered, we've emailed a sign-in link. It expires in 15 minutes.</p>
<p class="muted" id="s">Waiting for you to open it&hellip;</p>
<script>(function t(){fetch('/auth/poll',{credentials:'same-origin'}).then(r=>r.json()).then(j=>{if(j.ready)location=j.dest;else setTimeout(t,3000)}).catch(()=>setTimeout(t,6000))})()</script>`);

const clientConfirm = token => page('Sign in', `<p>Tap to finish signing in.</p>
<form method="post" action="/auth/${esc(token)}"><button>Continue</button></form>`);

const linkExpired = () => page('Link expired', `<p>That link has expired or has already been used.</p><p><a href="/">Request a new one</a></p>`);

const staffLogin = () => page('Team sign-in', `<p><strong>Team sign-in</strong></p><p>Enter your work email and we'll send a 6-digit code.</p>
<form method="post" action="/staff/request-code"><input name="email" type="email" autocomplete="email" required placeholder="Your email">
<button>Email me a code</button></form><p class="muted">Client? <a href="/">Use client sign-in</a></p>`);

const staffVerify = (email, error) => page('Enter code', `${error ? `<p style="color:#b00020">${esc(error)}</p>` : `<p>If that address belongs to the team, we've sent a code. It expires in 10 minutes.</p>`}
<form method="post" action="/staff/verify"><input type="hidden" name="email" value="${esc(email)}">
<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6-digit code">
<button>Sign in</button></form><p class="muted"><a href="/staff">Start again</a></p>`);

const ROLE_LABEL = { therapist: 'Therapist account (clients and their records)', practice_manager: 'Practice manager account (practice setup and team)' };
const chooseAccount = accounts => page('Choose account', `<p>This address has more than one account. Which do you want to use now?</p>
${accounts.map(a => `<form method="post" action="/choose-account"><input type="hidden" name="account" value="${esc(a.id)}">
<button>${esc(ROLE_LABEL[a.role])}</button></form>`).join('')}<p class="muted">To use the other one later, sign out and sign in again.</p>`);

const forbidden = () => page('Not available', `<p>You don't have access to this area in your current role.</p><p><a href="/">Back</a></p>`);

function shell(who, roleLabel, note, links = []) {
  return page(roleLabel, `<p>Signed in as <strong>${esc(who)}</strong> (${esc(roleLabel)}).</p><p class="muted">${esc(note)}</p>
${links.map(l => `<p><a href="${esc(l.href)}">${esc(l.label)}</a></p>`).join('')}<p><a href="/logout">Sign out</a></p>`);
}

// Team page (practice manager). Shows accounts and, for therapists, only HOW MANY clients they have.
function team(rows, myId, msg, ok) {
  const short = { therapist: 'Therapist', practice_manager: 'Practice manager' };
  const others = id => rows.filter(r => r.role === 'therapist' && r.status === 'active' && r.id !== id);
  const card = r => `<section style="border-top:1px solid #ddd;padding:14px 0" aria-label="${esc(r.name)}">
<p style="margin:0"><strong>${esc(r.name)}</strong>${r.id === myId ? ' (you)' : ''}<br><span class="muted">${esc(short[r.role])} · ${esc(r.email)} · ${r.status === 'active' ? (r.invited_at ? 'Active' : 'Active, not yet invited') : 'Suspended'}${r.role === 'therapist' ? ` · ${r.clients} client${r.clients === 1 ? '' : 's'}` : ''}</span>${r.close_requested_at ? '<br><strong style="color:#8a4a00">Has asked for this account to be closed</strong>' : ''}</p>
<details><summary>Change</summary>
<form method="post" action="/practice/team/${r.id}"><input type="hidden" name="action" value="edit">
<label for="n${r.id}">Name</label><input id="n${r.id}" name="name" required value="${esc(r.name)}">
<label for="e${r.id}">Email</label><input id="e${r.id}" name="email" type="email" required value="${esc(r.email)}">
<button class="alt">Save changes</button></form>
${r.status === 'active' ? `<form method="post" action="/practice/team/${r.id}"><input type="hidden" name="action" value="invite"><button class="alt">Send invitation again</button></form>` : ''}
${r.id === myId ? '' : `<form method="post" action="/practice/team/${r.id}"><input type="hidden" name="action" value="${r.status === 'active' ? 'suspend' : 'reactivate'}"><button class="alt">${r.status === 'active' ? 'Suspend (stops sign-in, keeps everything)' : 'Reactivate'}</button></form>
<form method="post" action="/practice/team/${r.id}"><input type="hidden" name="action" value="remove">
${r.clients > 0 ? `<label for="t${r.id}">Move their ${r.clients} client${r.clients === 1 ? '' : 's'} to</label><select id="t${r.id}" name="reassign_to" required style="font-size:16px;padding:11px;width:100%;margin:6px 0"><option value="">Choose a therapist</option>${others(r.id).map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>` : ''}
<button style="background:#b00020">Remove ${esc(r.name)}</button></form>`}
</details></section>`;
  return wide('Team', `<p><strong>Team</strong></p>
<p class="muted">Each account is either a therapist or a practice manager. One person can have both under the same email address; they are separate accounts.</p>
${msg ? `<p role="status" style="color:${ok === false ? '#b00020' : '#0a6b2d'}">${esc(msg)}</p>` : ''}
${rows.map(card).join('')}
<section style="border-top:1px solid #ddd;padding-top:14px"><p><strong>Add someone</strong></p>
<form method="post" action="/practice/team/add">
<label for="an">Name</label><input id="an" name="name" required>
<label for="ae">Email</label><input id="ae" name="email" type="email" required>
<label for="ar">Type of account</label><select id="ar" name="role" style="font-size:16px;padding:11px;width:100%;margin:6px 0"><option value="therapist">Therapist</option><option value="practice_manager">Practice manager</option></select>
<button>Add and send invitation</button></form></section>
<p><a href="/practice">Back</a></p>`);
}

// ---- therapist account: clients (carried over from the BYH app's therapist section) ----
const STATUS = { active: 'Active', readonly: 'Read-only', closed: 'Closed' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const sel = 'style="font-size:16px;padding:11px;width:100%;margin:6px 0;border-radius:6px;border:1px solid #bbb;background:#fff"';
const opts = (list, chosen) => list.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(chosen) ? ' selected' : ''}>${esc(t)}</option>`).join('');
const money = p => (p == null ? '' : `£${(p / 100).toFixed(2).replace(/\.00$/, '')}`);
const programmeLabel = p => `${p.name}: ${p.sessions} session${p.sessions === 1 ? '' : 's'}${p.price_pence != null ? `, ${money(p.price_pence)}` : ''}`;
const programmeOpts = (list, chosen) => list.map(p => `<option value="${p.id}"${String(chosen) === String(p.id) ? ' selected' : ''}>${esc(programmeLabel(p))}</option>`).join('');
const lengthOpts = chosen => opts([6, 8, 10, 12].map(n => [n, `${n} sessions`]), chosen);
const dayOpts = chosen => opts(DAYS.map((d, i) => [i, d]), chosen);
const note = (msg, ok) => (msg ? `<p role="status" style="color:${ok === false ? '#b00020' : '#0a6b2d'}">${esc(msg)}</p>` : '');
const day = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function clients(rows) {
  const row = r => `<p style="border-top:1px solid #ddd;padding:12px 0;margin:0"><a href="/therapist/client/${r.id}"><strong>${esc(r.name)}</strong></a><br>
<span class="muted">${STATUS[r.status]}${r.status === 'closed' ? '' : ` · session ${r.pos.on} of ${r.pos.of}`}${r.under16 ? ' · under 16' : ''}${r.next ? `<br>Next: ${esc(r.next)}` : ''}${r.wants_change ? '<br><strong style="color:#8a4a00">Has asked to change a session</strong>' : ''}</span></p>`;
  return wide('Clients', `<p><strong>Your clients</strong></p><p class="muted">Only you can see these.</p>
<div class="cols">${rows.length ? rows.map(row).join('') : '<p class="muted">No clients yet.</p>'}</div>
<form method="get" action="/therapist/clients/add" style="border-top:1px solid #ddd;padding-top:12px"><button>Add a client</button></form>
<p><a href="/therapist">Back</a></p>`);
}

function clientAdd(f, msg) {
  return read('Add a client', `<p><strong>Add a client</strong></p>
<p class="muted">They are emailed an invitation to their own client area.</p>${note(msg, false)}
<form method="post" action="/therapist/clients/add">${f.from_enquiry ? `<input type="hidden" name="from_enquiry" value="${esc(f.from_enquiry)}">` : ''}
<label for="name">Name</label><input id="name" name="name" required value="${esc(f.name)}">
<label for="email">Email (they sign in with this)</label><input id="email" name="email" type="email" required value="${esc(f.email)}">
<label for="phone">Phone (optional)</label><input id="phone" name="phone" type="tel" value="${esc(f.phone)}">
<label for="programme">Programme</label><select id="programme" name="programme" ${sel}>${programmeOpts(f.programmes || [], f.programme)}</select>
<label for="sba">Sessions already had before joining (0 for a new client)</label><input id="sba" name="sessions_before_app" inputmode="numeric" value="${esc(f.sessions_before_app || 0)}">
<label for="rd">Weekly journal reminder day</label><select id="rd" name="reminder_dow" ${sel}>${dayOpts(f.reminder_dow ?? 3)}</select>
<label for="fd">First session date (optional)</label><input id="fd" name="first_date" type="date">
<label for="ft">First session time</label><input id="ft" name="first_time" type="time" value="14:00">
<fieldset style="border:1px solid #ddd;border-radius:6px;margin:16px 0 8px;padding:8px 12px"><legend style="font-size:14px;font-weight:600">Under 16</legend>
<label class="check"><input type="checkbox" name="under16" ${f.under16 ? 'checked' : ''}> This client is under 16</label>
<p class="muted" style="margin:8px 0 0">If so, fill in the rest of this box. Consent is given to you in person; you record it here.</p>
<label for="gn">Parent or guardian's name</label><input id="gn" name="guardian_name" value="${esc(f.guardian_name)}">
<label for="ge">Their email (optional)</label><input id="ge" name="guardian_email" type="email" value="${esc(f.guardian_email)}">
<label for="gp">Their phone (optional)</label><input id="gp" name="guardian_phone" type="tel" value="${esc(f.guardian_phone)}">
<label for="cd">Date consent was given</label><input id="cd" name="consent_date" type="date" value="${esc(f.consent_date)}">
<label for="cnote">Note (optional, for example how it was given)</label><input id="cnote" name="consent_note" maxlength="500" value="${esc(f.consent_note)}">
<label class="check"><input type="checkbox" name="consent_confirmed"> I confirm a parent or guardian has given consent</label></fieldset>
<button>Add and send invitation</button></form><p><a href="/therapist/clients">Back</a></p>`);
}

function clientRecord(c, msg, ok) {
  const post = (action, inner) => `<form method="post" action="/therapist/client/${c.id}"><input type="hidden" name="action" value="${action}">${inner}</form>`;
  const sec = (title, inner) => `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>${title}</strong></p>${inner}</section>`;
  const closed = c.status === 'closed';
  return wide(c.name, `<p><strong>${esc(c.name)}</strong>${c.under16 ? ' <span class="muted">(under 16)</span>' : ''}<br>
<span class="muted">${STATUS[c.status]}${closed ? ` since ${day(c.closed_at)}` : ` · session ${c.pos.on} of ${c.pos.of}`}${c.programme_number > 1 ? ` · programme ${c.programme_number}` : ''}</span></p>
${note(msg, ok)}
${sec('Sessions', `<p class="muted" style="margin:0">${c.next ? `Next: ${esc(c.next)}` : 'No session booked.'}</p><p style="margin:6px 0 0"><a href="/therapist/client/${c.id}/sessions">Sessions: book, move or cancel</a></p>`)}
${sec('Contact', `<p class="muted" style="margin:0">${esc(c.email)}${c.phone ? ` · ${esc(c.phone)}` : ''}<br>${c.invited_at ? `Invited ${day(c.invited_at)}` : 'Not yet invited'}</p>
<details><summary>Change details</summary>${post('edit', `<label for="name">Name</label><input id="name" name="name" required value="${esc(c.name)}">
<label for="email">Email</label><input id="email" name="email" type="email" required value="${esc(c.email)}">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="${esc(c.phone)}"><button class="alt">Save changes</button>`)}</details>
${closed ? '' : post('invite', '<button class="alt">Send invitation again</button>')}`)}
${c.under16 ? sec('Consent (under 16)', `<p class="muted" style="margin:0">Parent or guardian: ${esc(c.guardian_name)}${c.guardian_email ? ` · ${esc(c.guardian_email)}` : ''}${c.guardian_phone ? ` · ${esc(c.guardian_phone)}` : ''}<br>
Consent given in person on ${day(c.consent_at)}${c.consent_note ? `. ${esc(c.consent_note)}` : ''}</p>`) : ''}
${sec('Forms', `${formsBlock(c.forms || [], 'therapist') || '<p class="muted" style="margin:0">No forms sent yet.</p>'}${closed || !(c.templates || []).length ? '' : `<details><summary>Send a form</summary>${post('send_form', `${templateSelect('c', c.templates)}${feeInput('c', c.fee_pence)}${formatSelect('c')}<button>Send for signing</button>`)}<p class="muted">${c.under16 ? 'It goes to the parent or guardian.' : 'It goes to the client.'} The signed copy is kept here.</p></details>`}`)}
${closed ? '' : sec('Programme', `<p class="muted" style="margin:0">${c.programme_name ? esc(c.programme_name) + ': ' : ''}${c.programme_sessions} session${c.programme_sessions === 1 ? '' : 's'}${c.programme_price_pence != null ? ` · ${money(c.programme_price_pence)}` : ''}${c.sessions_before_app ? `, ${c.sessions_before_app} had before joining` : ''}. Started ${day(c.programme_started_at)}.</p>
${post('extend', `<label for="add">Extend by</label><select id="add" name="add_sessions" ${sel}>${lengthOpts(6)}</select><button class="alt">Extend programme</button>`)}`)}
${closed ? '' : sec('Weekly journal reminder', post('reminders', `<label class="check"><input type="checkbox" name="reminders_on" ${c.reminders_on ? 'checked' : ''}> Send a weekly reminder</label>
<label for="rd">Day</label><select id="rd" name="reminder_dow" ${sel}>${dayOpts(c.reminder_dow)}</select><button class="alt">Save reminder setting</button>`))}
${sec('Record', closed
    ? post('reopen', `${c.freshOnReopen ? `<p class="muted" style="margin:0">Closed more than four weeks ago, so reopening starts a new programme. The earlier one is kept separately.</p><label for="ns">New programme</label><select id="ns" name="programme" ${sel}>${programmeOpts(c.programmes || [], c.programme_id)}</select>` : '<p class="muted" style="margin:0">Closed within the last four weeks, so reopening carries on the same programme.</p>'}<button>Reopen record</button>`)
    : (c.status === 'active' ? post('readonly', '<button class="alt">Make read-only (can sign in and read, not add)</button>') : post('reopen', '<button class="alt">Make active again</button>'))
      + post('close', '<button style="background:#b00020">Close record (stops sign-in)</button>'))}
<p><a href="/therapist/clients">Back to clients</a></p>`);
}

// ---- therapist account: home, booking and schedule ----
function therapistHome(d) {
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
  return page('Therapist', `<p style="margin:0 0 4px"><strong style="font-size:22px">Hello ${esc(String(d.who).split(/\s+/)[0])}</strong></p><p class="muted" style="margin:0">Here is where things stand.</p>
<div class="grid">
<section class="card"><h2>Today</h2>${d.today.length ? d.today.map(a => `<p>${esc(a.time)} &nbsp; ${esc(a.name)}</p>`).join('') : '<p class="muted">No sessions today.</p>'}
<div class="links"><a href="/therapist/schedule">Schedule</a><a href="/therapist/book">Book a session</a></div></section>
<section class="card"><h2>Enquiries</h2><span class="stat">${d.enquiries.new}</span><p class="muted">new · ${n(d.enquiries.consultations, 'consultation', 'consultations')} coming up</p>
<div class="links"><a href="/therapist/enquiries">Open enquiries</a><a href="/therapist/enquiries/new">Add an enquiry</a></div></section>
<section class="card"><h2>Clients</h2><span class="stat">${d.clients.active}</span><p class="muted">active${d.clients.wants_change ? ` · <strong style="color:#8a4a00">${n(d.clients.wants_change, 'client has', 'clients have')} asked to change a session</strong>` : ''}</p>
<div class="links"><a href="/therapist/clients">Your clients</a><a href="/therapist/clients/add">Add a client</a></div></section>
<section class="card"><h2>Forms</h2><span class="stat">${d.forms_waiting}</span><p class="muted">waiting to be signed</p>
<div class="links"><a href="/therapist/enquiries">Enquiries</a><a href="/therapist/clients">Clients</a></div></section>
<section class="card"><h2>Your account</h2><p class="muted">Your details for forms, calendar link, relaxation link and handing over clients.</p>
<div class="links"><a href="/therapist/account">Account</a></div></section>
</div>`, 'wide', { who: d.who, home: '/therapist' });
}

// The practice manager sees counts and set-up only: never a client's name or details.
function practiceHome(d) {
  const t = d.stats.totals, a = d.stats.accounts, ch = d.stats.enquiries;
  const total = v => Object.values(v).reduce((x, y) => x + y, 0);
  return page('Practice', `<p style="margin:0 0 4px"><strong style="font-size:22px">Practice overview</strong></p><p class="muted" style="margin:0">Numbers only. Client records are not available in this account.</p>
${d.mailOk ? '' : '<p style="color:#8a4a00"><strong>Email is not set up yet.</strong> Nobody can sign in by email until it is. <a href="/practice/settings/email">Set up email</a></p>'}
${d.closeRequests ? `<p style="color:#8a4a00"><strong>${d.closeRequests} therapist${d.closeRequests === 1 ? ' has' : 's have'} asked to close their account.</strong> <a href="/practice/team">Open Team</a></p>` : ''}
<div class="grid">
<section class="card"><h2>Team</h2><span class="stat">${a.therapists}</span><p class="muted">active therapist${a.therapists === 1 ? '' : 's'}${a.suspended ? ` · ${a.suspended} suspended` : ''} · ${a.managers} manager${a.managers === 1 ? '' : 's'}</p>
<div class="links"><a href="/practice/team">Manage team</a></div></section>
<section class="card"><h2>Clients</h2><span class="stat">${t.active_clients}</span><p class="muted">active · ${t.upcoming} upcoming session${t.upcoming === 1 ? '' : 's'} · ${t.delivered_30} delivered in 30 days</p>
<div class="links"><a href="/practice/stats">Practice statistics</a></div></section>
<section class="card"><h2>Enquiries</h2><span class="stat">${total(ch.stage)}</span><p class="muted">in total · ${ch.stage.new || 0} new · ${ch.stage.converted || 0} became clients</p>
<div class="links"><a href="/practice/stats">By route and stage</a></div></section>
<section class="card"><h2>Programmes</h2><span class="stat">${d.programmes}</span><p class="muted">offered, with prices, including single fixed-price sessions</p>
<div class="links"><a href="/practice/programmes">Programmes and prices</a></div></section>
<section class="card"><h2>Forms</h2><span class="stat">${d.forms}</span><p class="muted">form templates offered (agreements and consent forms)</p>
<div class="links"><a href="/practice/forms">Forms</a></div></section>
<section class="card"><h2>Set-up</h2><p class="muted">Practice name and colour, and the mailbox that sends sign-in codes, appointments and forms.</p>
<div class="links"><a href="/practice/settings/practice">Practice details</a><a href="/practice/settings/email">Email settings</a></div></section>
</div>`, 'wide', { who: d.who, home: '/practice' });
}

// Client landing. The journal, history and the weekly score arrive in the next step; sessions and forms are here now.
function clientHome(d) {
  return page('Client', `<p style="margin:0 0 4px"><strong style="font-size:22px">Hello ${esc(String(d.who).split(/\s+/)[0])}</strong></p><p class="muted" style="margin:0">Your client area with ${esc(d.therapist)}.</p>
<div class="grid">
<section class="card"><h2>Your next session</h2>${d.next ? `<p><strong>${esc(d.next)}</strong></p>` : '<p class="muted">Nothing booked yet.</p>'}
<p class="muted">Session ${d.pos.on} of ${d.pos.of}</p></section>
<section class="card"><h2>Forms</h2>${d.forms.filter(f => f.status !== 'void').length ? formsBlock(d.forms, 'client') : '<p class="muted">You have no forms.</p>'}</section>
<section class="card"><h2>Your journal</h2><p class="muted">Coming soon: write a little each week and tell us how you are feeling, from 1 to 10.</p></section>
${d.relax ? `<section class="card"><h2>Relax</h2><p class="muted">A recording from ${esc(d.therapist)} to help you unwind.</p><div class="links"><a href="${esc(d.relax)}" target="_blank" rel="noopener">Open the recording</a></div></section>` : ''}
</div>`, 'wide', { who: d.who, home: '/journal' });
}
const whenFields = (id, at) => `<label for="d${id}">Date</label><input id="d${id}" name="date" type="date" required value="${at ? T.inputDate(at) : ''}">
<label for="t${id}">Time</label><input id="t${id}" name="time" type="time" required value="${at ? T.timeShort(at) : '14:00'}">`;
const sessionActions = (a, ret) => `<details><summary>Change</summary>
<form method="post" action="/therapist/session/${a.id}"><input type="hidden" name="action" value="reschedule"><input type="hidden" name="return" value="${ret}">
${whenFields(a.id, a.starts_at)}<button class="alt">Move to this date and time</button></form>
${a.status === 'booked' ? `<form method="post" action="/therapist/session/${a.id}"><input type="hidden" name="action" value="cancel"><input type="hidden" name="return" value="${ret}"><button class="alt">Cancel session (kept on record)</button></form>` : ''}
<form method="post" action="/therapist/session/${a.id}"><input type="hidden" name="action" value="remove"><input type="hidden" name="return" value="${ret}"><button style="background:#b00020">Remove (entered by mistake)</button></form>
<p style="margin:6px 0 0"><a href="/therapist/session/${a.id}/calendar.ics">Download for my calendar</a></p></details>`;
const changeAsk = a => (a.change_requested_at ? `<br><strong style="color:#8a4a00">Client asked to ${a.change_request_kind === 'cancel' ? 'cancel' : 'move'} this${a.change_request_reason ? `: ${esc(a.change_request_reason)}` : ''}</strong>` : '');

function clientSessions(c, appts, msg, ok) {
  const now = Date.now();
  const line = a => `<div style="border-top:1px solid #eee;padding:10px 0"><p style="margin:0">${esc(T.when(a.starts_at))}${a.status === 'cancelled' ? ' <span class="muted">(cancelled)</span>' : ''}${changeAsk(a)}</p>${sessionActions(a, 'client')}</div>`;
  const up = appts.filter(a => a.status === 'booked' && new Date(a.starts_at) > now), past = appts.filter(a => a.status === 'booked' && new Date(a.starts_at) <= now).reverse(), gone = appts.filter(a => a.status === 'cancelled').reverse();
  const block = (title, list, empty) => `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>${title}</strong></p>${list.length ? list.map(line).join('') : `<p class="muted" style="margin:0">${empty}</p>`}</section>`;
  return wide(`Sessions: ${c.name}`, `<p><strong>Sessions: ${esc(c.name)}</strong></p>${note(msg, ok)}
${block('Coming up', up, 'Nothing booked.')}
${c.status === 'active' ? `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>Book a session</strong></p>
<form method="post" action="/therapist/client/${c.id}/sessions">${whenFields('new')}<button>Book</button></form>
<p class="muted">A date in the past records a session that has already happened and sends no email.</p></section>` : '<p class="muted">This record is not active, so new sessions cannot be booked.</p>'}
${block('Past', past, 'None yet.')}${gone.length ? block('Cancelled', gone, '') : ''}
<p><a href="/therapist/client/${c.id}">Back to ${esc(c.name)}</a></p>`);
}

function book(active, msg, ok) {
  return read('Book a session', `<p><strong>Book a session</strong></p>${note(msg, ok)}
${active.length ? `<form method="post" action="/therapist/book"><label for="cl">Client</label><select id="cl" name="client_id" required ${sel}><option value="">Choose a client</option>${opts(active.map(c => [c.id, c.name]))}</select>
${whenFields('b')}<button>Book</button></form>` : '<p class="muted">You have no active clients yet.</p>'}
<p><a href="/therapist">Back</a></p>`);
}

function schedule(rows, feed, msg, ok) {
  let lastDay = '';
  const line = a => { const d = T.dateLong(a.starts_at); const head = d !== lastDay ? `<p style="margin:14px 0 4px"><strong>${esc(d)}</strong></p>` : ''; lastDay = d;
    return `${head}<div style="border-top:1px solid #eee;padding:8px 0"><p style="margin:0">${esc(T.timeShort(a.starts_at))} &nbsp; <a href="/therapist/client/${a.client_id}">${esc(a.client_name)}</a>${a.under16 ? ' <span class="muted">(under 16)</span>' : ''}${changeAsk(a)}</p>${sessionActions(a, 'schedule')}</div>`; };
  return wide('Schedule', `<p><strong>Schedule</strong> <span class="muted">next 60 days</span></p>${note(msg, ok)}
${rows.length ? rows.map(line).join('') : '<p class="muted">Nothing booked.</p>'}
<section style="border-top:1px solid #ddd;padding:12px 0;margin-top:14px"><p style="margin:0 0 6px"><strong>See this in your own calendar</strong></p>
<p class="muted" style="margin:0">A private link you add once to Outlook, Apple or Google Calendar as a subscribed calendar. It shows session times with the client's first name and initial only. Calendar apps refresh it every few hours.</p>
<form method="post" action="/therapist/schedule/feed"><button class="alt">${feed.hasFeed ? 'Replace my calendar link (the old one stops working)' : 'Create my calendar link'}</button></form>
${feed.hasFeed ? '<form method="post" action="/therapist/schedule/feed"><input type="hidden" name="action" value="off"><button class="alt">Turn the calendar link off</button></form>' : ''}</section>
<p><a href="/therapist/book">Book a session</a></p><p><a href="/therapist">Back</a></p>`);
}

const feedLink = url => read('Your calendar link', `<p><strong>Your calendar link</strong></p>
<p>Copy this now. It is shown only once; if you lose it, create a new one from the Schedule page.</p>
<label for="fl">Link</label><input id="fl" readonly value="${esc(url)}" onfocus="this.select()">
<p class="muted">In your calendar app choose "add calendar from the internet" or "subscribe", and paste it. Treat it like a password: anyone with the link can see your session times.</p>
<p><a href="/therapist/schedule">Back to schedule</a></p>`);

function therapistAccount(me, mine, colleagues, msg, ok) {
  const sec = (title, inner) => `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>${title}</strong></p>${inner}</section>`;
  const post = (action, inner) => `<form method="post" action="/therapist/account"><input type="hidden" name="action" value="${action}">${inner}</form>`;
  return wide('Account', `<p><strong>Your account</strong><br><span class="muted">${esc(me.name)} · ${esc(me.email)}</span></p>${note(msg, ok)}
${sec('My details (used on forms)', `<p class="muted" style="margin:0">Filled into the forms you send, such as the agreement. Leave blank anything you do not want shown.</p>
${post('details', `<label for="dq">Qualifications</label><input id="dq" name="qualifications" maxlength="200" value="${esc(me.qualifications)}">
<label for="da">Address</label><input id="da" name="address" maxlength="200" value="${esc(me.address)}">
<label for="dp">Postcode</label><input id="dp" name="postcode" maxlength="20" value="${esc(me.postcode)}">
<label for="dh">Phone</label><input id="dh" name="phone" maxlength="40" value="${esc(me.phone)}">
<label for="df">Usual fee per session in pounds</label><input id="df" name="default_fee" inputmode="decimal" value="${me.default_fee_pence == null ? '' : (me.default_fee_pence / 100).toFixed(2).replace(/\.00$/, '')}">
<button class="alt">Save my details</button>`)}`)}
${sec('Relaxation link', `<p class="muted" style="margin:0">A recording or page you want your clients to be able to open from their client area. Leave blank for none.</p>
${post('relax', `<label for="rx">Web address</label><input id="rx" name="relax_url" inputmode="url" placeholder="https://" value="${esc(me.relax_url)}"><button class="alt">Save link</button>`)}`)}
${sec('Hand clients over to a colleague', !mine.length ? '<p class="muted" style="margin:0">You have no clients to hand over.</p>'
    : !colleagues.length ? '<p class="muted" style="margin:0">There is no other therapist in this practice to hand over to.</p>'
    : `<p class="muted" style="margin:0">The clients you choose move to your colleague, with their sessions and records, and each is told by email. You will no longer see them.</p>
${post('handover', `<label for="to">Hand over to</label><select id="to" name="to" required ${sel}><option value="">Choose a colleague</option>${opts(colleagues.map(c => [c.id, c.name]))}</select>
<label class="check"><input type="radio" name="scope" value="some" checked> Only the clients ticked below</label>
<label class="check"><input type="radio" name="scope" value="all"> All my clients</label>
${mine.map(c => `<label class="check"><input type="checkbox" name="client_id" value="${c.id}"> ${esc(c.name)}</label>`).join('')}
<button class="alt">Hand over</button>`)}`)}
${sec('Close my account', me.close_requested_at
    ? `<p class="muted" style="margin:0">You asked for this account to be closed on ${day(me.close_requested_at)}. The practice manager has been told; nothing changes until they act.</p>${post('withdraw_close', '<button class="alt">Withdraw my request</button>')}`
    : `<p class="muted" style="margin:0">This asks the practice manager to close your account. It is not instant. Hand your clients over first if they are continuing with a colleague.</p>${post('request_close', '<button class="alt">Ask to close my account</button>')}`)}
<p><a href="/therapist">Back</a></p>`);
}

// s: settings to show (never a password). msg/ok: result of the last save or test.
function mailSettings(s, myEmail, msg, ok, typedPassword = '') {
  return read('Email settings', `<p><strong>Email settings</strong></p>
<p class="muted">Everything the app sends (sign-in codes and links, and later reminders and consent requests) goes out from this mailbox. Use the outgoing (SMTP) details from your email provider.</p>
${msg ? `<p role="status" style="color:${ok ? '#0a6b2d' : '#b00020'}">${esc(msg)}</p>` : ''}
${s.secrets_key_set ? '' : '<p style="color:#b00020">SECRETS_KEY is not set on the server, so a password cannot be saved yet.</p>'}
<form method="post" action="/practice/settings/email" autocomplete="off">
<label for="from_address">Send from (email address)</label><input id="from_address" name="from_address" type="email" required value="${esc(s.from_address)}">
<label for="from_name">Sender name shown to recipients</label><input id="from_name" name="from_name" value="${esc(s.from_name)}">
<label for="smtp_host">Outgoing (SMTP) server</label><input id="smtp_host" name="smtp_host" required placeholder="smtp.example.com" value="${esc(s.smtp_host)}">
<label for="smtp_port">Port</label><input id="smtp_port" name="smtp_port" inputmode="numeric" required value="${esc(s.smtp_port)}">
<label class="check"><input type="checkbox" name="smtp_secure" ${s.smtp_secure ? 'checked' : ''}> Use SSL/TLS from the start (usually port 465). Leave off for port 587.</label>
<label for="smtp_user">Username (leave blank to use the address above)</label><input id="smtp_user" name="smtp_user" value="${esc(s.smtp_user)}">
<label for="smtp_password">Password${s.password_set ? ' (one is saved; leave blank to keep it)' : ''}</label><input id="smtp_password" name="smtp_password" type="password" autocomplete="new-password" value="${esc(typedPassword)}" placeholder="${s.password_set ? 'Saved. Leave blank to keep it' : 'Not set'}">
<button name="action" value="test" class="alt">Send a test email to ${esc(myEmail)}</button>
<button name="action" value="save">Save</button></form>
<p><a href="/practice">Back</a></p>`);
}

function practiceSettings(s, msg, ok) {
  return read('Practice details', `<p><strong>Practice details</strong></p>
<p class="muted">The name and colour appear on every page and in every email the app sends.</p>
${msg ? `<p role="status" style="color:${ok ? '#0a6b2d' : '#b00020'}">${esc(msg)}</p>` : ''}
<form method="post" action="/practice/settings/practice">
<label for="practice_name">Practice name</label><input id="practice_name" name="practice_name" required maxlength="80" value="${esc(s.practice_name)}">
<label for="practice_short">Short name (optional, for small spaces)</label><input id="practice_short" name="practice_short" maxlength="30" value="${esc(s.practice_short)}">
<label for="color_primary">Colour</label><input id="color_primary" name="color_primary" type="color" style="height:48px;padding:4px" value="${esc(s.color_primary)}">
<button>Save</button></form><p><a href="/practice">Back</a></p>`);
}

// Practice statistics (practice manager). Numbers only.
function practiceStats(st) {
  const t = st.totals, a = st.accounts;
  const row = (n, r, b) => `<tr${b ? ' style="font-weight:600"' : ''}><td>${esc(n)}</td><td>${r.active_clients}</td><td>${r.upcoming}</td><td>${r.delivered_30}</td><td>${r.cancelled_30}</td><td>${r.change_requests}</td></tr>`;
  return wide('Practice statistics', `<p><strong>Practice statistics</strong></p>
<p class="muted">Numbers only. Client names and details are never shown in this account.</p>
<p>${a.therapists} active therapist${a.therapists === 1 ? '' : 's'}${a.suspended ? `, ${a.suspended} suspended` : ''} · ${t.active_clients} active client${t.active_clients === 1 ? '' : 's'} · ${t.readonly_clients} read-only · ${t.closed_clients} closed</p>
<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:14px;width:100%" aria-label="Counts by therapist">
<thead><tr style="text-align:left"><th>Therapist</th><th>Active clients</th><th>Upcoming sessions</th><th>Delivered (30 days)</th><th>Cancelled (30 days)</th><th>Change requests</th></tr></thead>
<tbody>${st.therapists.map(r => row(r.name + (r.status === 'suspended' ? ' (suspended)' : ''), r)).join('')}${row('Practice total', t, true)}</tbody></table></div>
<p style="margin-bottom:2px"><strong>Enquiries</strong></p>
<p class="muted" style="margin:2px 0">By route: ${Object.keys(CHANNEL).map(k => `${esc(CHANNEL[k])} ${(st.enquiries.channel[k] || 0)}`).join(' · ')}</p>
<p class="muted" style="margin:2px 0">By stage: ${Object.keys(STAGE).map(k => `${esc(STAGE[k])} ${(st.enquiries.stage[k] || 0)}`).join(' · ')}</p>
<p><a href="/practice">Back</a></p>`);
}

// ---------- enquiries ----------
const CHANNEL = { website: 'Website', therapist_page: "Therapist's own page", google: 'Google ad', facebook: 'Facebook', phone: 'Entered by therapist' };
const STAGE = { new: 'New', consultation: 'Consultation set', attended: 'Attended', proceeding: 'Proceeding', not_proceeding: 'Not proceeding', converted: 'Now a client' };

function enquireForm({ therapists, therapist, slug, src, pick, f = {}, error }) {
  const who = therapist
    ? `<p class="muted">Your enquiry will go to ${esc(therapist.name)}.</p><input type="hidden" name="slug" value="${esc(slug)}">`
    : (therapists && therapists.length
      ? `<label for="th">Who would you like to hear from?</label><select id="th" name="therapist" ${sel} required><option value="">Choose…</option>${therapists.map(t => `<option value="${t.id}"${String(pick) === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : '');
  if (!therapist && !(therapists && therapists.length)) return page('Enquiry', '<p>We are not taking enquiries online at the moment. Please get in touch another way.</p>');
  return page('Get in touch', `<p><strong>Get in touch</strong></p><p class="muted">Tell us how to reach you and we will be in touch. Please do not put any health details in this form.</p>${note(error, false)}
<form method="post" action="/enquire"><input type="hidden" name="src" value="${esc(src)}">${who}
<label for="n">Your name</label><input id="n" name="name" required maxlength="100" value="${esc(f.name)}">
<label for="e">Email</label><input id="e" name="email" type="email" value="${esc(f.email)}">
<label for="p">Phone</label><input id="p" name="phone" type="tel" value="${esc(f.phone)}">
<p class="muted" style="margin:2px 0">An email or a phone number is needed.</p>
<label class="check"><input type="checkbox" name="for_child" ${f.for_child ? 'checked' : ''}> This enquiry is for a child under 16</label>
<label for="c">Child's name (if applicable)</label><input id="c" name="child_name" maxlength="100" value="${esc(f.child_name)}">
<div style="position:absolute;left:-9999px" aria-hidden="true"><label for="co">Leave this empty</label><input id="co" name="company" tabindex="-1" autocomplete="off"></div>
<button>Send enquiry</button></form>`);
}
const enquireThanks = msg => page('Thank you', `<p>${esc(msg || 'Thank you. Your enquiry has been sent and you will hear back soon.')}</p>`);

function therapistEnquiries(rows, links, msg, ok) {
  const post = (id, action, inner) => `<form method="post" action="/therapist/enquiries/${id}"><input type="hidden" name="action" value="${action}">${inner}</form>`;
  const card = e => `<section style="border-top:1px solid #ddd;padding:12px 0" aria-label="${esc(e.name)}">
<p style="margin:0"><strong>${esc(e.name)}</strong>${e.for_child ? ' <span class="muted">(child, under 16)</span>' : ''}<br>
<span class="muted">${esc(STAGE[e.stage])} · ${esc(CHANNEL[e.channel])} · enquired ${day(e.enquiry_date)}${e.email ? `<br>${esc(e.email)}` : ''}${e.phone ? `<br>${esc(e.phone)}` : ''}${e.address ? `<br>${esc(e.address)}` : ''}${e.for_child ? `<br>Parent or guardian: ${esc(e.guardian_name)}${e.relationship ? ` (${esc(e.relationship)})` : ''}${e.guardian_email ? `<br>${esc(e.guardian_email)}` : ''}${e.guardian_phone ? `<br>${esc(e.guardian_phone)}` : ''}` : ''}${e.ic_text ? `<br>Consultation: ${esc(e.ic_text)}` : ''}${e.notes ? `<br>Notes: ${esc(e.notes)}` : ''}</span></p>
${e.stage === 'converted' ? (e.converted_client_id ? `<p style="margin:6px 0"><a href="/therapist/client/${e.converted_client_id}">Open their client record</a></p>` : '')
  : e.stage === 'not_proceeding' ? '' : `<form method="get" action="/therapist/clients/add"><input type="hidden" name="from" value="${e.id}"><button style="max-width:240px">Add as a client</button></form>`}
${e.stage === 'converted' ? '' : `<details><summary>Manage</summary>
${post(e.id, 'consult', `<label for="d${e.id}">Consultation date</label><input id="d${e.id}" name="date" type="date" required value="${e.ic_at ? T.inputDate(e.ic_at) : ''}"><label for="t${e.id}">Time</label><input id="t${e.id}" name="time" type="time" required value="${e.ic_at ? T.timeShort(e.ic_at) : '10:00'}"><button class="alt">${e.ic_at ? 'Move consultation' : 'Set consultation'}${e.email ? ' and email them' : ''}</button>`)}
${e.ic_at ? post(e.id, 'clear_consult', '<button class="alt">Remove consultation</button>') : ''}
${formsBlock(e.forms || [], 'therapist')}
${(e.templates || []).length ? `<details open><summary>${e.stage === 'attended' || (e.forms || []).length ? 'Send the form again' : 'Mark as attended and send forms'}</summary>${post(e.id, 'attended', `${templateSelect(e.id, e.templates)}${feeInput(e.id, e.fee_pence)}${formatSelect(e.id)}<button>${(e.forms || []).length ? 'Send again' : 'Attended: send for signing'}</button>`)}<p class="muted">${e.for_child ? 'It goes to the parent or guardian.' : 'It goes to the person who enquired.'} They read and sign it in the app, and the signed copy is kept with this enquiry and then their client record.</p></details>` : '<p class="muted">No forms are set up for this kind of enquiry yet.</p>'}
${post(e.id, 'notes', `<label for="nt${e.id}">Notes</label><input id="nt${e.id}" name="notes" maxlength="1000" value="${esc(e.notes)}"><button class="alt">Save notes</button>`)}
${e.stage !== 'not_proceeding' ? post(e.id, 'not_proceeding', '<button class="alt">Not proceeding</button>') : post(e.id, 'new', '<button class="alt">Reopen</button>')}
${post(e.id, 'delete', '<button style="background:#b00020">Delete enquiry</button>')}</details>`}</section>`;
  return wide('Enquiries', `<p><strong>Your enquiries</strong></p><p class="muted">Only you can see these.</p>${note(msg, ok)}
<div class="cols">${rows.length ? rows.map(card).join('') : '<p class="muted">No enquiries yet.</p>'}</div>
<form method="get" action="/therapist/enquiries/new" style="border-top:1px solid #ddd;padding-top:12px"><button>Add an enquiry (phone or in person)</button></form>
<details style="border-top:1px solid #ddd;padding-top:12px;margin-top:12px"><summary>Enquiry links</summary>
<p class="muted">Your own page (use this for your private page, Google ads and Facebook by adding the route shown):</p>
<p style="word-break:break-all"><a href="${esc(links.mine)}">${esc(links.mine)}</a></p>
<p class="muted" style="margin:2px 0">For a Google ad add <code>?src=google</code>; for Facebook add <code>?src=facebook</code>.</p>
<p class="muted">The practice's form (asks which therapist; for the website):</p>
<p style="word-break:break-all"><a href="${esc(links.practice)}">${esc(links.practice)}</a></p></details>
<p><a href="/therapist">Back</a></p>`);
}

function enquiryManual(f = {}, msg) {
  const child = f.type === 'child';
  return read('Add an enquiry', `<p><strong>Add an enquiry</strong></p><p class="muted">For an enquiry that came by phone or in person.</p>${note(msg, false)}
<form method="post" action="/therapist/enquiries/add">
<fieldset style="border:1px solid #ddd;border-radius:6px;padding:8px 12px"><legend style="font-size:14px;font-weight:600">Who is it for?</legend>
<label class="check"><input type="radio" name="type" value="adult" ${child ? '' : 'checked'}> Adult</label><label class="check"><input type="radio" name="type" value="child" ${child ? 'checked' : ''}> Child under 16</label>
<p class="muted" style="margin:6px 0 0">If it is for a child, the name below is the child's and the parent or guardian goes in the box further down.</p></fieldset>
<label for="fn">First name</label><input id="fn" name="first_name" required maxlength="100" value="${esc(f.first)}">
<label for="ln">Last name</label><input id="ln" name="last_name" required maxlength="100" value="${esc(f.last)}">
<label for="em">Email</label><input id="em" name="email" type="email" value="${esc(f.email)}">
<label for="ph">Telephone</label><input id="ph" name="phone" type="tel" value="${esc(f.phone)}">
<label for="ad">Address (optional)</label><input id="ad" name="address" maxlength="300" value="${esc(f.address)}">
<label for="ed">Enquiry date</label><input id="ed" name="enquiry_date" type="date" value="${esc(f.enquiry_date)}">
<label for="id">Initial consultation date (optional)</label><input id="id" name="ic_date" type="date" value="${esc(f.ic_date)}">
<label for="it">Consultation time</label><input id="it" name="ic_time" type="time" value="${esc(f.ic_time || '10:00')}">
<fieldset style="border:1px solid #ddd;border-radius:6px;margin:16px 0 8px;padding:8px 12px"><legend style="font-size:14px;font-weight:600">Parent or guardian (for a child)</legend>
<label for="gn">Parent or guardian's name</label><input id="gn" name="guardian_name" maxlength="100" value="${esc(f.guardian_name)}">
<label for="rl">Relationship to the child</label><input id="rl" name="relationship" maxlength="100" value="${esc(f.relationship)}">
<label for="ge">Their email</label><input id="ge" name="guardian_email" type="email" value="${esc(f.guardian_email)}">
<label for="gp">Their telephone</label><input id="gp" name="guardian_phone" type="tel" value="${esc(f.guardian_phone)}"></fieldset>
<label for="nt">Notes (optional)</label><input id="nt" name="notes" maxlength="1000" value="${esc(f.notes)}">
<p class="muted">An email or phone number is needed. If a consultation date is set and there is an email address, they are sent the date and a calendar file.</p>
<button>Save enquiry</button></form><p><a href="/therapist/enquiries">Back</a></p>`);
}

function programmes(rows, msg, ok) {
  const card = p => `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0"><strong>${esc(p.name)}</strong>${p.active ? '' : ' <span class="muted">(retired)</span>'}<br><span class="muted">${p.sessions} session${p.sessions === 1 ? '' : 's'}${p.price_pence != null ? ` · ${money(p.price_pence)}` : ' · no price set'}</span></p>
<details><summary>Change</summary><form method="post" action="/practice/programmes/${p.id}">
<label for="n${p.id}">Name</label><input id="n${p.id}" name="name" required maxlength="80" value="${esc(p.name)}">
<label for="s${p.id}">Sessions</label><input id="s${p.id}" name="sessions" inputmode="numeric" required value="${p.sessions}">
<label for="p${p.id}">Price in pounds (optional)</label><input id="p${p.id}" name="price" inputmode="decimal" value="${p.price_pence == null ? '' : esc((p.price_pence / 100).toFixed(2))}">
<button>Save</button></form>
<form method="post" action="/practice/programmes/${p.id}"><input type="hidden" name="action" value="${p.active ? 'retire' : 'restore'}"><button class="alt">${p.active ? 'Retire (stop offering it)' : 'Offer again'}</button></form></details></section>`;
  return wide('Programmes', `<p><strong>Programmes and prices</strong></p><p class="muted">What therapists choose from when they add a client. A single fixed-price session, such as smoking cessation, is a programme of 1 session. Prices are recorded for the therapist to see; no payments are taken here.</p>${note(msg, ok)}
${rows.map(card).join('')}
<form method="post" action="/practice/programmes" style="border-top:1px solid #ddd;padding-top:12px"><p style="margin:0"><strong>Add a programme</strong></p>
<label for="an">Name</label><input id="an" name="name" required maxlength="80" placeholder="Smoking cessation"><label for="as">Sessions</label><input id="as" name="sessions" inputmode="numeric" required value="1">
<label for="ap">Price in pounds (optional)</label><input id="ap" name="price" inputmode="decimal"><button>Add programme</button></form><p><a href="/practice">Back</a></p>`);
}

// ---------- forms ----------
const FORM_STATUS = { sent: 'Sent, not yet signed', signed: 'Signed', void: 'Replaced' };
function signPage(r, action, error, f = {}, back, preview) {
  const lab = { address: 'Address', phone: 'Contact number', relationship: 'Relationship to the child' };
  const choice = c => c.type === 'yesno'
    ? `<fieldset style="border:0;padding:0;margin:12px 0"><legend>${esc(c.label)}</legend><label class="check"><input type="radio" name="choice_${c.key}" value="yes" ${f['choice_' + c.key] === 'yes' ? 'checked' : ''}> Yes</label><label class="check"><input type="radio" name="choice_${c.key}" value="no" ${f['choice_' + c.key] === 'no' ? 'checked' : ''}> No</label></fieldset>`
    : `<label class="check"><input type="checkbox" name="choice_${c.key}" ${f['choice_' + c.key] ? 'checked' : ''}> ${esc(c.label)}</label>`;
  return read(r.title, `<p><strong style="font-size:20px">${esc(r.title)}</strong></p>${preview ? '<p class="muted">Preview only. Nothing can be signed here.</p>' : ''}
${r.intro.map((p, i) => i === 0 ? `<p><strong>${esc(p)}</strong></p>` : `<p>${esc(p)}</p>`).join('')}
${r.sections.map(x => `<h3 style="margin:18px 0 4px">${esc(x.heading)}</h3>${x.paragraphs.map(p => `<p style="margin:6px 0">${esc(p)}</p>`).join('')}`).join('')}
<section style="border-top:2px solid #ddd;margin-top:20px;padding-top:12px"><h3 style="margin:0 0 6px">Sign</h3>${r.signing_intro ? `<p>${esc(r.signing_intro)}</p>` : ''}${note(error, false)}
<form method="post" action="${esc(action)}">
<label for="sn">Your full name (this is your signature)</label><input id="sn" name="signer_name" required maxlength="100" autocomplete="name" value="${esc(f.signer_name)}">
${r.signer_fields.map(k => `<label for="s_${k}">${lab[k]}</label><input id="s_${k}" name="signer_${k}" required maxlength="${k === 'address' ? 300 : 100}" value="${esc(f['signer_' + k])}">`).join('')}
${r.choices.map(choice).join('')}
${r.closing.map(p => `<p class="muted">${esc(p)}</p>`).join('')}
<label class="check"><input type="checkbox" name="agree" ${f.agree ? 'checked' : ''}> I have read this and I agree. Typing my name above is my signature.</label>
<button ${preview ? 'disabled' : ''}>Sign</button></form></section>
${r.footer.length ? `<p class="muted" style="margin-top:20px">${r.footer.map(esc).join('<br>')}</p>` : ''}${back ? `<p><a href="${esc(back)}">Back</a></p>` : ''}`);
}
const signGone = msg => page('Form', `<p>${esc(msg || 'This link is no longer valid. It may have expired, been replaced by a newer one, or the form may already be signed. Please ask your therapist to send it again.')}</p>`);
const signDone = (title, publicLink) => page('Signed', `<p><strong>Thank you. ${esc(title)} is signed.</strong></p><p>A copy has been emailed to you${publicLink ? '' : ', and you can open it again from your client area'}.</p>${publicLink ? '' : '<p><a href="/journal">Back to your area</a></p>'}`);

// A client's forms, shown in the therapist's client record and enquiry card, and in the client area.
function formsBlock(forms, who) {
  if (!forms.length) return '';
  const row = f => `<li>${esc(f.template_name)}: <span class="muted">${esc(FORM_STATUS[f.status])}${f.signed_at ? ' ' + day(f.signed_at) : f.sent_at ? ', sent ' + day(f.sent_at) : ''}</span>${
    who === 'therapist' && f.status === 'signed' ? ` · <a href="/therapist/forms/${f.id}/pdf" target="_blank" rel="noopener">Open signed copy</a>` : ''}${
    who === 'client' && f.status === 'signed' && f.audience === 'adult' ? ` · <a href="/client/forms/${f.id}/pdf" target="_blank" rel="noopener">Open my copy</a>` : ''}${
    who === 'client' && f.status === 'sent' ? (f.audience === 'adult' ? ` · <a href="/client/forms/${f.id}">Read and sign</a>` : ' · waiting for a parent or guardian to sign') : ''}</li>`;
  return `<ul style="margin:6px 0;padding-left:18px">${forms.filter(f => f.status !== 'void').map(row).join('')}</ul>`;
}
const feeInput = (id, pence) => `<label for="fee${id}">Fee per session in pounds</label><input id="fee${id}" name="fee" inputmode="decimal" required value="${pence == null ? '' : (pence / 100).toFixed(2).replace(/\.00$/, '')}">`;
const formatSelect = id => `<label for="fmt${id}">Sessions will be</label><select id="fmt${id}" name="session_format" ${sel}><option value="inperson">In person</option><option value="online">Online via Zoom</option></select>`;
const templateSelect = (id, list) => `<label for="tp${id}">Form</label><select id="tp${id}" name="template" ${sel}>${list.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>`;

function formTemplates(rows, msg, ok) {
  return wide('Forms', `<p><strong>Forms</strong></p><p class="muted">The forms therapists can send for signing. The Inspired To Change forms are included; add your own for other practices or a standalone practitioner. Wording you change here applies to forms sent from then on; forms already sent keep their wording.</p>${note(msg, ok)}
${rows.map(t => `<section style="border-top:1px solid #ddd;padding:10px 0"><strong>${esc(t.name)}</strong>${t.active ? '' : ' <span class="muted">(retired)</span>'}<br><span class="muted">${t.audience === 'child' ? 'Signed by a parent or guardian' : 'Signed by the client'}</span><br>
<a href="/practice/forms/${t.id}">Edit</a> · <a href="/practice/forms/${t.id}/preview">Preview</a>
<form method="post" action="/practice/forms/${t.id}" style="display:inline"><input type="hidden" name="action" value="${t.active ? 'retire' : 'restore'}"><button class="alt">${t.active ? 'Retire' : 'Offer again'}</button></form></section>`).join('')}
<p><a href="/practice/forms/new"><strong>Add a form</strong></a></p><p><a href="/practice">Back</a></p>`);
}
function formTemplateEdit(t, F, error) {
  const f = t.form, sf = f.signer_fields || [];
  return read('Edit form', `<p><strong>${t.id ? 'Edit form' : 'Add a form'}</strong></p>${note(error, false)}
<form method="post" action="/practice/forms${t.id ? '/' + t.id : ''}">
<label for="fn">Name (what therapists see)</label><input id="fn" name="name" required maxlength="100" value="${esc(t.name)}">
<label for="fa">Who signs it</label><select id="fa" name="audience" ${sel}><option value="adult"${t.audience === 'adult' ? ' selected' : ''}>The client</option><option value="child"${t.audience === 'child' ? ' selected' : ''}>A parent or guardian, for a child</option></select>
<label for="ft">Title on the form</label><input id="ft" name="title" required maxlength="120" value="${esc(f.title)}">
<label for="fw">Wording</label><textarea id="fw" name="wording" rows="16" style="width:100%">${esc(f.wording)}</textarea>
<p class="muted" style="margin:2px 0">A line starting with <code>#</code> begins a section. Text before the first one is the introduction. Leave a blank line between paragraphs. These can be filled in for each client: ${Object.keys(F.MERGE_FIELDS).map(k => `<code>{{${k}}}</code>`).join(' ')}</p>
<p style="margin:10px 0 2px"><strong>What the signer is asked for</strong> (their name is always asked)</p>
${['address', 'phone', 'relationship'].map(k => `<label class="check"><input type="checkbox" name="signer_fields" value="${k}" ${sf.includes(k) ? 'checked' : ''}> ${{ address: 'Address', phone: 'Contact number', relationship: 'Relationship to the child' }[k]}</label>`).join('')}
<label for="fc">Choices (one per line: key | yesno or tick | required or optional | wording)</label><textarea id="fc" name="choices" rows="4" style="width:100%">${esc(f.choices)}</textarea>
<label for="fs">Line above the signing box (optional)</label><input id="fs" name="signing_intro" maxlength="300" value="${esc(f.signing_intro)}">
<label for="fl">Closing note (optional)</label><textarea id="fl" name="closing" rows="2" style="width:100%">${esc(f.closing)}</textarea>
<label for="ff">Details at the end, one per line (optional)</label><textarea id="ff" name="footer" rows="6" style="width:100%">${esc(f.footer)}</textarea>
<button>Save</button></form><p><a href="/practice/forms">Back</a></p>`);
}

module.exports = { practiceHome, clientHome, signPage, signGone, signDone, formsBlock, feeInput, formatSelect, templateSelect, formTemplates, formTemplateEdit, programmes, enquiryManual, enquireForm, enquireThanks, therapistEnquiries, CHANNEL, STAGE, practiceStats, practiceSettings, clientLogin, clientSent, clientConfirm, linkExpired, staffLogin, staffVerify, chooseAccount, forbidden, shell, team, clients, clientAdd, clientRecord, therapistHome, clientSessions, book, schedule, feedLink, therapistAccount, mailSettings };
