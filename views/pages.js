// views/pages.js — minimal server-rendered pages. Everything user-supplied goes through esc().
const { BRAND } = require('../lib/brand');
const { esc } = require('../lib/mail');

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

const clientLogin = () => page('Sign in', `<p>Enter your email and we'll send you a sign-in link.</p>
<form method="post" action="/request-link"><input name="email" type="email" autocomplete="email" required placeholder="Your email">
<button>Email me a link</button></form><p class="muted"><a href="/staff">Team sign-in</a></p>`);

const clientSent = () => page('Check your email', `<p>If that address is registered, we've emailed a sign-in link. It expires in 15 minutes.</p>
<p class="muted" id="s">Waiting for you to open it&hellip;</p>
<script>(function t(){fetch('/auth/poll',{credentials:'same-origin'}).then(r=>r.json()).then(j=>{if(j.ready)location=j.dest;else setTimeout(t,3000)}).catch(()=>setTimeout(t,6000))})()</script>`);

const clientConfirm = token => page('Sign in', `<p>Tap to finish signing in.</p>
<form method="post" action="/auth/${esc(token)}"><button>Continue</button></form>`);

const linkExpired = () => page('Link expired', `<p>That link has expired or has already been used.</p><p><a href="/">Request a new one</a></p>`);

const staffLogin = () => page('Team sign-in', `<p>Enter your work email and we'll send a 6-digit code.</p>
<form method="post" action="/staff/request-code"><input name="email" type="email" autocomplete="email" required placeholder="Your email">
<button>Email me a code</button></form>`);

const staffVerify = (email, error) => page('Enter code', `${error ? `<p style="color:#b00020">${esc(error)}</p>` : `<p>If that address belongs to the team, we've sent a code. It expires in 10 minutes.</p>`}
<form method="post" action="/staff/verify"><input type="hidden" name="email" value="${esc(email)}">
<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6-digit code">
<button>Sign in</button></form><p class="muted"><a href="/staff">Start again</a></p>`);

const chooseRole = roles => page('Choose role', `<p>You can act in more than one role. Which do you need now?</p>
${roles.map(r => `<form method="post" action="/choose-role"><input type="hidden" name="role" value="${esc(r)}">
<button>${r === 'therapist' ? 'Therapist (client records)' : 'Practice manager (enquiries, bookings)'}</button></form>`).join('')}`);

const forbidden = () => page('Not available', `<p>You don't have access to this area in your current role.</p><p><a href="/">Back</a></p>`);

function shell(who, roleLabel, note, canSwitch, links = []) {
  return page(roleLabel, `<p>Signed in as <strong>${esc(who)}</strong> (${esc(roleLabel)}).</p><p class="muted">${esc(note)}</p>
${links.map(l => `<p><a href="${esc(l.href)}">${esc(l.label)}</a></p>`).join('')}
${canSwitch ? '<p><a href="/choose-role">Switch role</a></p>' : ''}<p><a href="/logout">Sign out</a></p>`);
}

// s: settings to show (never a password). msg/ok: result of the last save or test.
function mailSettings(s, myEmail, msg, ok) {
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
<label for="smtp_password">Password</label><input id="smtp_password" name="smtp_password" type="password" autocomplete="new-password" placeholder="${s.password_set ? 'Saved. Leave blank to keep it' : 'Not set'}">
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

module.exports = { practiceSettings, clientLogin, clientSent, clientConfirm, linkExpired, staffLogin, staffVerify, chooseRole, forbidden, shell, mailSettings };
