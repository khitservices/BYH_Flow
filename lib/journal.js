// lib/journal.js — the client's private journal. Content is visible to the client only.
// The therapist side uses counts() and nothing else: how many entries, and when, never what was written.
const { q, one } = require('./db');
const storage = require('./storage');
const EDIT_MINUTES = 15;
const MAX_BODY = 20000;
const MAX_FILE = 15 * 1024 * 1024;

// What may be attached, decided by the file's own first bytes, never by the name or type the browser claims.
const starts = (b, ...bytes) => bytes.every((x, i) => b[i] === x);
function sniff(b) {
  if (!b || b.length < 12) return null;
  if (starts(b, 0xFF, 0xD8, 0xFF)) return { mime: 'image/jpeg', ext: 'jpg', inline: true };
  if (starts(b, 0x89, 0x50, 0x4E, 0x47)) return { mime: 'image/png', ext: 'png', inline: true };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', inline: true };
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)/.test(b.toString('latin1', 8, 12))) return { mime: 'image/heic', ext: 'heic', inline: false };
  if (b.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', inline: true };
  if (starts(b, 0x50, 0x4B, 0x03, 0x04)) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', inline: false };
  if (starts(b, 0xD0, 0xCF, 0x11, 0xE0)) return { mime: 'application/msword', ext: 'doc', inline: false };
  if (!b.subarray(0, 4096).includes(0)) return { mime: 'text/plain', ext: 'txt', inline: false };   // plain text: no NUL bytes
  return null;
}
const cleanName = (n, ext) => (String(n || '').replace(/[\\/\r\n"<>:*?|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'attachment') .replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.' + ext;

// Is this entry still open for editing? Judged by the database clock, in the current block only.
const editable = e => !!e && !e.locked && e.editable_now !== false;
const SELECT = `SELECT e.id, e.block_id, e.body, e.file_name, e.file_mime, e.file_bytes, e.created_at, e.edited_at, e.locked,
  (e.file_object_id IS NOT NULL) AS has_file,
  (NOT e.locked AND e.created_at > now() - interval '${EDIT_MINUTES} minutes' AND e.block_id IS NOT DISTINCT FROM c.current_block_id) AS editable_now
  FROM clinical.journal_entries e JOIN clinical.clients c ON c.id = e.client_id`;

async function add(client, body, file) {
  const text = String(body || '').replace(/\r/g, '').trim().slice(0, MAX_BODY);
  let f = null;
  if (file && file.buffer && file.buffer.length) {
    const kind = file.buffer.length <= MAX_FILE ? sniff(file.buffer) : null;
    if (!kind) return { error: 'file' };
    f = { kind, id: await storage.put(file.buffer), name: cleanName(file.originalname, kind.ext), bytes: file.buffer.length };
  }
  if (!text && !f) return { error: 'empty' };
  const r = await one(`INSERT INTO clinical.journal_entries (client_id, block_id, body, file_object_id, file_name, file_mime, file_bytes)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [client.id, client.current_block_id, text, f && f.id, f && f.name, f && f.kind.mime, f && f.bytes]);
  return { id: r.id };
}
const entries = (clientId, blockId, current) => q(`${SELECT} WHERE e.client_id=$1 AND ${current ? 'e.block_id IS NOT DISTINCT FROM c.current_block_id' : 'e.block_id IS DISTINCT FROM c.current_block_id'} ORDER BY e.created_at, e.id`, [clientId]);
const one_ = (clientId, id) => one(`${SELECT} WHERE e.client_id=$1 AND e.id=$2`, [clientId, id]);
async function edit(clientId, id, body) {
  const text = String(body || '').replace(/\r/g, '').trim().slice(0, MAX_BODY);
  const e = await one_(clientId, id);
  if (!editable(e)) return 'locked';
  if (!text && !e.has_file) return 'empty';
  await q(`UPDATE clinical.journal_entries SET body=$3, edited_at=now(), locked=true WHERE id=$1 AND client_id=$2 AND NOT locked`, [id, clientId, text]);
  return 'saved';
}
// The file belongs to the signed-in client only.
async function file(clientId, id) {
  const e = await one(`SELECT file_object_id, file_name, file_mime FROM clinical.journal_entries WHERE id=$1 AND client_id=$2 AND file_object_id IS NOT NULL`, [id, clientId]);
  if (!e) return null;
  return { buffer: await storage.get(e.file_object_id), name: e.file_name, mime: e.file_mime, inline: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(e.file_mime) };
}
// What a therapist may see: numbers and dates only. Never body, file names or files.
async function counts(clientId) {
  const r = await one(`SELECT count(*)::int AS total, max(created_at) AS last FROM clinical.journal_entries WHERE client_id=$1`, [clientId]);
  const rows = await q(`SELECT created_at FROM clinical.journal_entries WHERE client_id=$1 AND created_at > now() - interval '42 days'`, [clientId]);
  const weeks = [0, 0, 0, 0, 0, 0], now = Date.now();
  for (const x of rows) { const w = Math.floor((now - new Date(x.created_at).getTime()) / (7 * 86400000)); if (w >= 0 && w < 6) weeks[w]++; }
  return { total: r.total, last: r.last, thisWeek: weeks[0], weeks: weeks.slice().reverse() };   // oldest first, this week last
}
// The client's own journal removed completely (rows and encrypted files). Used when they ask for their information to be deleted.
async function wipe(clientId) {
  const rows = await q(`DELETE FROM clinical.journal_entries WHERE client_id=$1 RETURNING file_object_id`, [clientId]);
  for (const r of rows) if (r.file_object_id) await storage.remove(r.file_object_id).catch(e => console.error('[journal] file not removed', e.message));
  return rows.length;
}
module.exports = { wipe, add, entries, edit, file, counts, sniff, EDIT_MINUTES, MAX_BODY, MAX_FILE };
