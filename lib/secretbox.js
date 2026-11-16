// lib/secretbox.js — seals small secrets kept in the database (the mailbox password) with AES-256-GCM.
// Key: SECRETS_KEY, 32 bytes as base64 or 64 hex characters. Separate from FILE_ENCRYPTION_KEY on purpose.
const crypto = require('crypto');

function key() {
  const v = String(process.env.SECRETS_KEY || '').trim();
  if (!v) return null;
  const k = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  return k.length === 32 ? k : null;
}
const configured = () => !!key();

function seal(plain) {
  const k = key(); if (!k) throw new Error('SECRETS_KEY is not set (32 bytes, base64)');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + [iv, c.getAuthTag(), enc].map(b => b.toString('base64url')).join('.');
}

function open(sealed) {
  const k = key(); if (!k) throw new Error('SECRETS_KEY is not set (32 bytes, base64)');
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

module.exports = { seal, open, configured };
