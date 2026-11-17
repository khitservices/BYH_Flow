// lib/mail.js — the practice's outgoing mail, over plain SMTP, plus the sign-in email templates.
// The mailbox is configured in the app (Settings > Email) and stored in core.mail_settings; nothing about
// mail lives in .env. Settings are read fresh on every send, so a change applies at once with no restart.
// MAIL_TRANSPORT=memory is for tests only: messages are kept in `outbox` and nothing is sent.
require('dotenv').config();
const { BRAND } = require('./brand');
const { q, one } = require('./db');
const secretbox = require('./secretbox');

const outbox = [];
const testHooks = { failNext: false };

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const clean = (v, max = 255) => String(v ?? '').replace(/[\r\n]/g, '').trim().slice(0, max);

// What the Settings page may show. Never includes the password, only whether one is saved.
async function getSettings() {
  const r = (await one(`SELECT * FROM core.mail_settings WHERE id = 1`)) || {};
  return {
    smtp_host: r.smtp_host || '', smtp_port: r.smtp_port || 587, smtp_secure: !!r.smtp_secure,
    smtp_user: r.smtp_user || '', from_name: r.from_name || '', from_address: r.from_address || '',
    password_set: !!r.smtp_password_enc, configured: !!(r.smtp_host && r.from_address),
    secrets_key_set: secretbox.configured(), updated_at: r.updated_at || null,
  };
}

// Checks a submitted form. Returns { error } or { values }; `values.password` is '' when left blank.
function validate(form) {
  const v = {
    smtp_host: clean(form.smtp_host).toLowerCase(), smtp_port: Number(clean(form.smtp_port, 5)),
    smtp_secure: form.smtp_secure === 'on' || form.smtp_secure === true,
    smtp_user: clean(form.smtp_user), from_name: clean(form.from_name, 100),
    from_address: clean(form.from_address).toLowerCase(), password: String(form.smtp_password ?? '').slice(0, 500),
  };
  if (!HOST_RE.test(v.smtp_host)) return { error: 'Enter the outgoing (SMTP) server name, for example smtp.example.com.' };
  if (!Number.isInteger(v.smtp_port) || v.smtp_port < 1 || v.smtp_port > 65535) return { error: 'The port must be a number, usually 587 or 465.' };
  if (!EMAIL_RE.test(v.from_address)) return { error: 'Enter the email address messages are sent from.' };
  if (!v.smtp_user) v.smtp_user = v.from_address;
  return { values: v };
}

async function saveSettings(v, staffId) {
  if (v.password && !secretbox.configured()) return { error: 'SECRETS_KEY is not set on the server, so the password cannot be saved yet.' };
  await q(`UPDATE core.mail_settings SET smtp_host=$1, smtp_port=$2, smtp_secure=$3, smtp_user=$4, from_name=$5,
           from_address=$6, updated_at=now(), updated_by=$7 WHERE id = 1`,
    [v.smtp_host, v.smtp_port, v.smtp_secure, v.smtp_user, v.from_name || null, v.from_address, staffId]);
  if (v.password) await q(`UPDATE core.mail_settings SET smtp_password_enc=$1 WHERE id = 1`, [secretbox.seal(v.password)]);
  return {};
}

// Saved settings with the password opened. Used only here; never sent to a browser.
async function loadConfig() {
  const r = (await one(`SELECT * FROM core.mail_settings WHERE id = 1`)) || {};
  return {
    smtp_host: r.smtp_host, smtp_port: r.smtp_port || 587, smtp_secure: !!r.smtp_secure, smtp_user: r.smtp_user,
    from_name: r.from_name, from_address: r.from_address,
    password: r.smtp_password_enc ? secretbox.open(r.smtp_password_enc) : '',
  };
}

// Throws on failure; callers decide what a failure means. `override` lets the Settings page test values
// that have not been saved yet (a blank password in the override keeps the saved one).
// `extra.icalEvent` ({ method, content }) attaches a calendar file that mail apps show as an appointment.
async function sendMail(to, subject, html, override, extra = {}) {
  if (process.env.MAIL_TRANSPORT === 'memory') {
    if (testHooks.failNext) { testHooks.failNext = false; throw new Error('send failed (test)'); }
    outbox.push({ to, subject, html, from: extra.sender ? extra.sender.address : null, replyTo: extra.sender ? extra.sender.address : null, override: override || null, icalEvent: extra.icalEvent || null, attachments: extra.attachments || null });
    return;
  }
  const c = await loadConfig();
  if (override) { const pw = override.password || c.password; Object.assign(c, override, { password: pw }); }
  if (!c.smtp_host || !c.from_address) throw new Error('Email is not set up yet');
  // A therapist's own address: same server and port as the practice. With their own mailbox password they sign in as themselves;
  // without one, the practice login sends on their behalf (From is theirs, replies come to them).
  const sd = extra.sender || null;
  const auth = sd && sd.password ? { user: sd.address, pass: sd.password } : (c.smtp_user ? { user: c.smtp_user, pass: c.password } : undefined);
  const transport = require('nodemailer').createTransport({
    host: c.smtp_host, port: c.smtp_port, secure: c.smtp_secure,
    requireTLS: !c.smtp_secure, // never send the mailbox password or a message over an unencrypted connection
    auth,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  await transport.sendMail({
    from: sd ? { name: sd.name || c.from_name || '', address: sd.address } : (c.from_name ? { name: c.from_name, address: c.from_address } : c.from_address),
    ...(sd ? { replyTo: sd.address } : {}), to, subject, html,
    ...(extra.attachments ? { attachments: extra.attachments } : {}),
    ...(extra.icalEvent ? { icalEvent: { method: extra.icalEvent.method, content: extra.icalEvent.content, filename: 'appointment.ics' } } : {}),
  });
}

// The practice's domain: a therapist's own address must be on it (so nobody can send as an outside address).
const domainOf = a => String(a || '').toLowerCase().split('@')[1] || '';
async function practiceDomain() { const r = await one(`SELECT from_address FROM core.mail_settings WHERE id=1`); return domainOf(r && r.from_address); }
async function checkSender(name, address) {
  const a = clean(address).toLowerCase();
  if (!EMAIL_RE.test(a)) return { error: 'Enter your email address, such as you@yourpractice.co.uk.' };
  const dom = await practiceDomain();
  if (dom && domainOf(a) !== dom) return { error: `Your address must be at the practice's own domain (@${dom}), because it is sent through the practice's mail server.` };
  return { name: clean(name, 100), address: a };
}
// This therapist's own sender, or null to use the practice mailbox.
async function senderFor(staffId) {
  const r = await one(`SELECT sender_name, sender_address, sender_password_enc FROM core.staff WHERE id=$1`, [staffId]);
  if (!r || !r.sender_address) return null;
  let password = '';
  try { password = r.sender_password_enc ? secretbox.open(r.sender_password_enc) : ''; } catch { password = ''; }
  return { name: r.sender_name || '', address: r.sender_address, password };
}
// Client emails from a therapist: their own address if they have set one, otherwise the practice's.
async function sendFrom(staffId, to, subject, html, override, extra = {}) {
  const sender = staffId ? await senderFor(staffId) : null;
  return sendMail(to, subject, html, override || null, sender ? { ...extra, sender } : extra);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = n => esc(String(n || '').split(/\s+/)[0] || 'there');

function shell(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
${head()}${inner}
<p style="color:#777;font-size:12px;margin-top:28px">If you didn't ask for this, you can ignore this email.</p></div>`;
}

const staffCodeEmail = (name, code) => shell(
  `<p>Hi ${first(name)},</p><p>Your sign-in code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:bold">${esc(code)}</p><p>It expires in 10 minutes.</p>`);

const clientLinkEmail = (name, link) => shell(
  `<p>Hi ${first(name)},</p><p>Tap the button to sign in. The link works once and expires in 15 minutes.</p>
<p><a href="${esc(link)}" style="background:${BRAND.colorPrimary};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a></p>`);

const inviteEmail = (name, roleLabel, link) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
${head()}
<p>Hi ${first(name)},</p><p>You've been given a ${esc(roleLabel.toLowerCase())} account with ${esc(BRAND.practiceName)}.</p>
<p>There is no password. To sign in, open the page below and enter this email address; we'll email you a 6-digit code each time.</p>
<p><a href="${esc(link)}" style="background:${BRAND.colorPrimary};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Go to sign-in</a></p>
<p style="color:#777;font-size:12px;margin-top:28px">If you weren't expecting this, you can ignore this email.</p></div>`;

// No clinical detail: only that a private area exists and how to get in.
const clientInviteEmail = (name, therapistName, link) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
${head()}
<p>Hi ${first(name)},</p><p>${esc(therapistName)} has set up a private client area for you.</p>
<p>There is no password. Open the page below and enter this email address; we'll email you a sign-in link each time.</p>
<p><a href="${esc(link)}" style="background:${BRAND.colorPrimary};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Go to sign-in</a></p>
<p style="color:#777;font-size:12px;margin-top:28px">If you weren't expecting this, you can ignore this email.</p></div>`;

// Appointment emails: the date and time only, never anything about the therapy itself.
const head = () => `${BRAND.logoVersion && process.env.BASE_URL ? `<img src="${esc(process.env.BASE_URL)}/brand/logo?v=${BRAND.logoVersion}" alt="" style="max-height:56px;max-width:240px;display:block;margin:0 0 12px">` : ''}<h2 style="color:${BRAND.colorPrimary};margin:0 0 16px">${esc(BRAND.practiceName)}</h2>`;
const apptBox = (name, lines) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
${head()}<p>Hi ${first(name)},</p>${lines}
<p>If you need to change anything, please contact your therapist.</p></div>`;
const apptBookedEmail = (name, whenText, changed, where, note) => apptBox(name, `<p>${changed ? 'Your appointment has moved. It is now on' : 'Your appointment is booked for'}:</p>
<p style="font-size:18px;font-weight:bold">${esc(whenText)}</p>${where ? `<p><strong>Where:</strong> ${esc(where)}${note ? `<br>${esc(note)}` : ''}</p>` : ''}<p>The attached calendar file adds it to your calendar${changed ? ' and replaces the earlier one' : ''}.</p>`);
const apptCancelledEmail = (name, whenText) => apptBox(name, `<p>Your appointment on <strong>${esc(whenText)}</strong> has been cancelled.</p>`);

const plainBox = inner => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
${head()}${inner}</div>`;
const handoverEmail = (name, toName) => plainBox(`<p>Hi ${first(name)},</p><p>From now on you will be looked after by ${esc(toName)}. You can keep using your client area exactly as before.</p>
<p>If you have any questions, please get in touch with the practice.</p>`);
const closeRequestEmail = (therapistName, link) => plainBox(`<p>${esc(therapistName)} has asked for their therapist account to be closed.</p>
<p>Nothing has changed yet. Their clients keep their access until you act on this from the Team page.</p>
<p><a href="${esc(link)}">Sign in</a></p>`);

const newEnquiryEmail = (therapistName, link) => plainBox(`<p>Hi ${first(therapistName)},</p><p>You have a new enquiry. Sign in to see the details and reply.</p>
<p><a href="${esc(link)}">Sign in</a></p>`);
const changeRequestEmail = (therapistName, link) => plainBox(`<p>Hi ${first(therapistName)},</p><p>A client has asked to change an appointment. Sign in to see the request and reply. (Details are not sent by email.)</p>
<p><a href="${esc(link)}">Sign in</a></p>`);
const consultationEmail = (name, whenText, changed, therapistName) => plainBox(`<p>Hello ${first(name)},</p>
<p>${changed ? 'Your online free initial consultation has moved. It is now on' : 'Thank you for your enquiry regarding hypnotherapy. I am pleased to confirm the details of your online free initial consultation booking for'}:</p>
<p style="font-size:18px;font-weight:bold">${esc(whenText)}</p>
<p>The purpose of the initial consultation is for me to:</p>
<ul><li>Gain an understanding of what’s going on now and how you would like it to be different</li><li>Share how our brain works and why this is impacting on how you feel and what you are experiencing</li><li>Explain how we can use hypnotherapy to create positive change in your life</li></ul>
<p>Most importantly, the purpose is to make sure that you feel comfortable and happy working with me to achieve the results you want.</p>
<p>I look forward to seeing you at your initial consultation and if you have any questions in the meantime, I am very happy to answer them – simply respond to this email.</p>
<p>The attached calendar file adds it to your calendar${changed ? ' and replaces the earlier one' : ''}.</p>
<p>With warmest regards<br>${first(therapistName)}</p>`);
const consultationCancelledEmail = (name, whenText) => plainBox(`<p>Hi ${first(name)},</p><p>Your initial consultation on <strong>${esc(whenText)}</strong> has been cancelled.</p>`);

const formRequestEmail = (name, therapistName, link) => plainBox(`<p>Hi ${first(name)},</p><p>${esc(therapistName)} has sent you a form to read and sign. It takes a few minutes and you can do it on your phone.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:${BRAND.colorPrimary};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Read and sign</a></p>
<p style="color:#777;font-size:13px">The link works for 30 days. If it has expired, ask ${esc(therapistName)} to send a new one.</p>`);
const formSignedEmail = (name, title) => plainBox(`<p>Hi ${first(name)},</p><p>Thank you. Your signed copy of <strong>${esc(title)}</strong> is attached for your records.</p>`);
const formSignedNoticeEmail = (therapistName, title) => plainBox(`<p>Hi ${first(therapistName)},</p><p>A form has been signed: <strong>${esc(title)}</strong>. It is in the client folder, and you can open it from your Enquiries or the client's record.</p>`);

const testEmail = () => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
${head()}
<p>This is a test message to confirm the email settings work.</p><p>If you're reading this, they do.</p></div>`;

module.exports = {
  sendMail, sendFrom, senderFor, checkSender, getSettings, validate, saveSettings, staffCodeEmail, clientLinkEmail, inviteEmail, clientInviteEmail, apptBookedEmail, apptCancelledEmail, handoverEmail, closeRequestEmail, newEnquiryEmail, changeRequestEmail, formRequestEmail, formSignedEmail, formSignedNoticeEmail, consultationEmail, consultationCancelledEmail, testEmail, outbox, testHooks, esc,
};
