// lib/storage.js — encrypted document storage.
// Files are encrypted with AES-256-GCM before they touch disk. The key lives in the
// environment (FILE_ENCRYPTION_KEY), never in the database or the data volume, so a copy of
// either alone does not expose documents. The interface (put/get/remove) is deliberately
// small so an S3-compatible backend can replace the local volume later without callers changing.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

function key() {
  const k = Buffer.from(process.env.FILE_ENCRYPTION_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('FILE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return k;
}
const root = () => path.resolve(process.env.STORAGE_DIR || './data/files');

// Object ids are random hex only; callers never supply paths.
const ID_RE = /^[a-f0-9]{40}$/;
function fileFor(id) {
  if (!ID_RE.test(id)) throw new Error('invalid object id');
  return path.join(root(), id.slice(0, 2), id);
}

async function put(buffer) {
  const id = crypto.randomBytes(20).toString('hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(buffer), c.final()]);
  const blob = Buffer.concat([iv, c.getAuthTag(), enc]); // 12 iv | 16 tag | ciphertext
  const f = fileFor(id);
  await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
  await fs.writeFile(f, blob, { mode: 0o600 });
  return id;
}

async function get(id) {
  const blob = await fs.readFile(fileFor(id));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]); // throws if tampered
}

async function remove(id) {
  await fs.rm(fileFor(id), { force: true });
}

module.exports = { put, get, remove };
