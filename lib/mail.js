// lib/mail.js — Microsoft Graph sender plus the sign-in email templates.
// MAIL_TRANSPORT=graph (default) | memory (tests: messages kept in `outbox`, nothing is sent).
require('dotenv').config();
const { BRAND } = require('./brand');

const outbox = [];

let _token = null, _tokenExp = 0;
async function graphToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const { GRAPH_TENANT_ID: tenant, GRAPH_CLIENT_ID: id, GRAPH_CLIENT_SECRET: secret } = process.env;
  if (!tenant || !id || !secret) throw new Error('Graph is not configured (GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET)');
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Graph token request failed'); // never echo the response: it may name the tenant/app
  _token = j.access_token; _tokenExp = Date.now() + j.expires_in * 1000;
  return _token;
}

async function sendMail(to, subject, html) {
  if (process.env.MAIL_TRANSPORT === 'memory') { outbox.push({ to, subject, html }); return; }
  const sender = process.env.GRAPH_SENDER;
  if (!sender) throw new Error('GRAPH_SENDER is not set');
  const token = await graphToken();
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: false,
    }),
  });
  if (!r.ok) throw new Error(`Graph sendMail failed (${r.status})`);
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

module.exports = { sendMail, staffCodeEmail, clientLinkEmail, outbox, esc };
