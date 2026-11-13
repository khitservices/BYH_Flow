const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.FILE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'byhflow-'));
const storage = require('../lib/storage');

test('round-trips and stores ciphertext, not plaintext', async () => {
  const plain = Buffer.from('signed agreement contents');
  const id = await storage.put(plain);
  const onDisk = fs.readFileSync(path.join(process.env.STORAGE_DIR, id.slice(0, 2), id));
  assert.ok(!onDisk.includes(plain), 'plaintext found on disk');
  assert.deepStrictEqual(await storage.get(id), plain);
});

test('detects tampering', async () => {
  const id = await storage.put(Buffer.from('x'.repeat(64)));
  const f = path.join(process.env.STORAGE_DIR, id.slice(0, 2), id);
  const blob = fs.readFileSync(f);
  blob[blob.length - 1] ^= 1;
  fs.writeFileSync(f, blob);
  await assert.rejects(() => storage.get(id));
});

test('rejects path-style ids', async () => {
  await assert.rejects(() => storage.get('../../etc/passwd'));
});
