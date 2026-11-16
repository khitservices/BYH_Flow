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
async function sendMail(to, subject, html, override) {
  if (process.env.MAIL_TRANSPORT === 'memory') {
    if (testHooks.failNext) { testHooks.failNext = false; throw new Error('send failed (test)'); }
    outbox.push({ to, subject, html, override: override || null });
    return;
  }
  const c = await loadConfig();
  if (override) { const pw = override.password || c.password; Object.assign(c, override, { password: pw }); }
  if (!c.smtp_host || !c.from_address) throw new Error('Email is not set up yet');
  const transport = require('nodemailer').createTransport({
    host: c.smtp_host, port: c.smtp_port, secure: c.smtp_secure,
    requireTLS: !c.smtp_secure, // never send the mailbox password or a message over an unencrypted connection
    auth: c.smtp_user ? { user: c.smtp_user, pass: c.password } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  await transport.sendMail({
    from: c.from_name ? { name: c.from_name, address: c.from_address } : c.from_address, to, subject, html,
  });
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = n => esc(String(n || '').split(/\s+/)[0] || 'there');

function shell(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
<h2 style="color:${BRAND.colorPrimary};margin:0 0 16px">${esc(BRAND.practiceName)}</h2>${inner}
<p style="color:#777;font-size:12px;margin-top:28px">If you didn't ask for this, you can ignore this email.</p></div>`;
}

const staffCodeEmail = (name, code) => shell(
  `<p>Hi ${first(name)},</p><p>Your sign-in code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:bold">${esc(code)}</p><p>It expires in 10 minutes.</p>`);

const clientLinkEmail = (name, link) => shell(
  `<p>Hi ${first(name)},</p><p>Tap the button to sign in. The link works once and expires in 15 minutes.</p>
<p><a href="${esc(link)}" style="background:${BRAND.colorPrimary};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a></p>`);

const inviteEmail = (name, roleLabel, link) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
<h2 style="color:${BRAND.colorPrimary};margin:0 0 16px">${esc(BRAND.practiceName)}</h2>
<p>Hi ${first(name)},</p><p>You've been given a ${esc(roleLabel.toLowerCase())} account with ${esc(BRAND.practiceName)}.</p>
<p>There is no password. To sign in, open the page below and enter this email address; we'll email you a 6-digit code each time.</p>
<p><a href="${esc(link)}" style="background:${BRAND.colorPrimary};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Go to sign-in</a></p>
<p style="color:#777;font-size:12px;margin-top:28px">If you weren't expecting this, you can ignore this email.</p></div>`;

const testEmail = () => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
<h2 style="color:${BRAND.colorPrimary};margin:0 0 16px">${esc(BRAND.practiceName)}</h2>
<p>This is a test message to confirm the email settings work.</p><p>If you're reading this, they do.</p></div>`;

module.exports = {
  sendMail, getSettings, validate, saveSettings, staffCodeEmail, clientLinkEmail, inviteEmail, testEmail, outbox, testHooks, esc,
};
