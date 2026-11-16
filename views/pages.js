// views/pages.js — minimal server-rendered pages. Everything user-supplied goes through esc().
const { BRAND } = require('../lib/brand');
const { esc } = require('../lib/mail');
const T = require('../lib/time');

function page(title, body) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ${esc(BRAND.practiceName)}</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#f6f8f8;color:#222;margin:0}
main{max-width:440px;margin:8vh auto;padding:28px;background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
h1{font-size:20px;color:${BRAND.colorPrimary};margin:0 0 16px}
label{display:block;font-size:14px;font-weight:600;margin-top:12px}label.check{font-weight:400;display:flex;gap:8px;align-items:center}label.check input{width:auto;margin:0}
button.alt{background:#fff;color:${BRAND.colorPrimary};border:1px solid ${BRAND.colorPrimary}}
input,button{font-size:16px;padding:11px;width:100%;box-sizing:border-box;margin:6px 0;border-radius:6px}
input{border:1px solid #bbb} button{border:0;background:${BRAND.colorPrimary};color:#fff;cursor:pointer}
a{color:${BRAND.colorPrimary}} .muted{color:#666;font-size:14px} form.inline{display:inline}
</style></head><body><main><h1>${esc(BRAND.practiceName)}</h1>${body}</main></body></html>`;
}

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
  return page('Team', `<p><strong>Team</strong></p>
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
const lengthOpts = chosen => opts([6, 8, 10, 12].map(n => [n, `${n} sessions`]), chosen);
const dayOpts = chosen => opts(DAYS.map((d, i) => [i, d]), chosen);
const note = (msg, ok) => (msg ? `<p role="status" style="color:${ok === false ? '#b00020' : '#0a6b2d'}">${esc(msg)}</p>` : '');
const day = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function clients(rows) {
  const row = r => `<p style="border-top:1px solid #ddd;padding:12px 0;margin:0"><a href="/therapist/client/${r.id}"><strong>${esc(r.name)}</strong></a><br>
<span class="muted">${STATUS[r.status]}${r.status === 'closed' ? '' : ` · session ${r.pos.on} of ${r.pos.of}`}${r.under16 ? ' · under 16' : ''}${r.next ? `<br>Next: ${esc(r.next)}` : ''}${r.wants_change ? '<br><strong style="color:#8a4a00">Has asked to change a session</strong>' : ''}</span></p>`;
  return page('Clients', `<p><strong>Your clients</strong></p><p class="muted">Only you can see these.</p>
${rows.length ? rows.map(row).join('') : '<p class="muted">No clients yet.</p>'}
<form method="get" action="/therapist/clients/add" style="border-top:1px solid #ddd;padding-top:12px"><button>Add a client</button></form>
<p><a href="/therapist">Back</a></p>`);
}

function clientAdd(f, msg) {
  return page('Add a client', `<p><strong>Add a client</strong></p>
<p class="muted">They are emailed an invitation to their own client area.</p>${note(msg, false)}
<form method="post" action="/therapist/clients/add">
<label for="name">Name</label><input id="name" name="name" required value="${esc(f.name)}">
<label for="email">Email (they sign in with this)</label><input id="email" name="email" type="email" required value="${esc(f.email)}">
<label for="phone">Phone (optional)</label><input id="phone" name="phone" type="tel" value="${esc(f.phone)}">
<label for="sessions">Programme length</label><select id="sessions" name="sessions" ${sel}>${lengthOpts(f.sessions || 8)}</select>
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
  return page(c.name, `<p><strong>${esc(c.name)}</strong>${c.under16 ? ' <span class="muted">(under 16)</span>' : ''}<br>
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
${closed ? '' : sec('Programme', `<p class="muted" style="margin:0">${c.programme_sessions} sessions${c.sessions_before_app ? `, ${c.sessions_before_app} had before joining` : ''}. Started ${day(c.programme_started_at)}.</p>
${post('extend', `<label for="add">Extend by</label><select id="add" name="add_sessions" ${sel}>${lengthOpts(6)}</select><button class="alt">Extend programme</button>`)}`)}
${closed ? '' : sec('Weekly journal reminder', post('reminders', `<label class="check"><input type="checkbox" name="reminders_on" ${c.reminders_on ? 'checked' : ''}> Send a weekly reminder</label>
<label for="rd">Day</label><select id="rd" name="reminder_dow" ${sel}>${dayOpts(c.reminder_dow)}</select><button class="alt">Save reminder setting</button>`))}
${sec('Record', closed
    ? post('reopen', `${c.freshOnReopen ? `<p class="muted" style="margin:0">Closed more than four weeks ago, so reopening starts a new programme. The earlier one is kept separately.</p><label for="ns">New programme length</label><select id="ns" name="sessions" ${sel}>${lengthOpts(8)}</select>` : '<p class="muted" style="margin:0">Closed within the last four weeks, so reopening carries on the same programme.</p>'}<button>Reopen record</button>`)
    : (c.status === 'active' ? post('readonly', '<button class="alt">Make read-only (can sign in and read, not add)</button>') : post('reopen', '<button class="alt">Make active again</button>'))
      + post('close', '<button style="background:#b00020">Close record (stops sign-in)</button>'))}
<p><a href="/therapist/clients">Back to clients</a></p>`);
}

// ---- therapist account: home, booking and schedule ----
function therapistHome(who, clientCount, today) {
  return page('Therapist', `<p>Signed in as <strong>${esc(who)}</strong> (Therapist).</p>
<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>Today</strong></p>
${today.length ? today.map(a => `<p style="margin:4px 0">${esc(a.time)} &nbsp; ${esc(a.name)}</p>`).join('') : '<p class="muted" style="margin:0">No sessions today.</p>'}</section>
<p><a href="/therapist/clients">Clients (${clientCount})</a></p><p><a href="/therapist/book">Book a session</a></p><p><a href="/therapist/schedule">Schedule</a></p><p><a href="/therapist/account">Account</a></p>
<p><a href="/logout">Sign out</a></p>`);
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
  return page(`Sessions: ${c.name}`, `<p><strong>Sessions: ${esc(c.name)}</strong></p>${note(msg, ok)}
${block('Coming up', up, 'Nothing booked.')}
${c.status === 'active' ? `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>Book a session</strong></p>
<form method="post" action="/therapist/client/${c.id}/sessions">${whenFields('new')}<button>Book</button></form>
<p class="muted">A date in the past records a session that has already happened and sends no email.</p></section>` : '<p class="muted">This record is not active, so new sessions cannot be booked.</p>'}
${block('Past', past, 'None yet.')}${gone.length ? block('Cancelled', gone, '') : ''}
<p><a href="/therapist/client/${c.id}">Back to ${esc(c.name)}</a></p>`);
}

function book(active, msg, ok) {
  return page('Book a session', `<p><strong>Book a session</strong></p>${note(msg, ok)}
${active.length ? `<form method="post" action="/therapist/book"><label for="cl">Client</label><select id="cl" name="client_id" required ${sel}><option value="">Choose a client</option>${opts(active.map(c => [c.id, c.name]))}</select>
${whenFields('b')}<button>Book</button></form>` : '<p class="muted">You have no active clients yet.</p>'}
<p><a href="/therapist">Back</a></p>`);
}

function schedule(rows, feed, msg, ok) {
  let lastDay = '';
  const line = a => { const d = T.dateLong(a.starts_at); const head = d !== lastDay ? `<p style="margin:14px 0 4px"><strong>${esc(d)}</strong></p>` : ''; lastDay = d;
    return `${head}<div style="border-top:1px solid #eee;padding:8px 0"><p style="margin:0">${esc(T.timeShort(a.starts_at))} &nbsp; <a href="/therapist/client/${a.client_id}">${esc(a.client_name)}</a>${a.under16 ? ' <span class="muted">(under 16)</span>' : ''}${changeAsk(a)}</p>${sessionActions(a, 'schedule')}</div>`; };
  return page('Schedule', `<p><strong>Schedule</strong> <span class="muted">next 60 days</span></p>${note(msg, ok)}
${rows.length ? rows.map(line).join('') : '<p class="muted">Nothing booked.</p>'}
<section style="border-top:1px solid #ddd;padding:12px 0;margin-top:14px"><p style="margin:0 0 6px"><strong>See this in your own calendar</strong></p>
<p class="muted" style="margin:0">A private link you add once to Outlook, Apple or Google Calendar as a subscribed calendar. It shows session times with the client's first name and initial only. Calendar apps refresh it every few hours.</p>
<form method="post" action="/therapist/schedule/feed"><button class="alt">${feed.hasFeed ? 'Replace my calendar link (the old one stops working)' : 'Create my calendar link'}</button></form>
${feed.hasFeed ? '<form method="post" action="/therapist/schedule/feed"><input type="hidden" name="action" value="off"><button class="alt">Turn the calendar link off</button></form>' : ''}</section>
<p><a href="/therapist/book">Book a session</a></p><p><a href="/therapist">Back</a></p>`);
}

const feedLink = url => page('Your calendar link', `<p><strong>Your calendar link</strong></p>
<p>Copy this now. It is shown only once; if you lose it, create a new one from the Schedule page.</p>
<label for="fl">Link</label><input id="fl" readonly value="${esc(url)}" onfocus="this.select()">
<p class="muted">In your calendar app choose "add calendar from the internet" or "subscribe", and paste it. Treat it like a password: anyone with the link can see your session times.</p>
<p><a href="/therapist/schedule">Back to schedule</a></p>`);

function therapistAccount(me, mine, colleagues, msg, ok) {
  const sec = (title, inner) => `<section style="border-top:1px solid #ddd;padding:12px 0"><p style="margin:0 0 6px"><strong>${title}</strong></p>${inner}</section>`;
  const post = (action, inner) => `<form method="post" action="/therapist/account"><input type="hidden" name="action" value="${action}">${inner}</form>`;
  return page('Account', `<p><strong>Your account</strong><br><span class="muted">${esc(me.name)} · ${esc(me.email)}</span></p>${note(msg, ok)}
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
  return page('Email settings', `<p><strong>Email settings</strong></p>
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
  return page('Practice details', `<p><strong>Practice details</strong></p>
<p class="muted">The name and colour appear on every page and in every email the app sends.</p>
${msg ? `<p role="status" style="color:${ok ? '#0a6b2d' : '#b00020'}">${esc(msg)}</p>` : ''}
<form method="post" action="/practice/settings/practice">
<label for="practice_name">Practice name</label><input id="practice_name" name="practice_name" required maxlength="80" value="${esc(s.practice_name)}">
<label for="practice_short">Short name (optional, for small spaces)</label><input id="practice_short" name="practice_short" maxlength="30" value="${esc(s.practice_short)}">
<label for="color_primary">Colour</label><input id="color_primary" name="color_primary" type="color" style="height:48px;padding:4px" value="${esc(s.color_primary)}">
<button>Save</button></form><p><a href="/practice">Back</a></p>`);
}

module.exports = { practiceSettings, clientLogin, clientSent, clientConfirm, linkExpired, staffLogin, staffVerify, chooseAccount, forbidden, shell, team, clients, clientAdd, clientRecord, therapistHome, clientSessions, book, schedule, feedLink, therapistAccount, mailSettings };
