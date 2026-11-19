// lib/pwa.js — what a phone needs to install the enquiry form as an app: a manifest and plain brand-coloured icons.
// Icons are drawn here (no image library): the practice colour with a white "+", so they follow the colour the manager sets.
const zlib = require('zlib');
const BRAND = require('./brand').BRAND;
const hex = h => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); const n = parseInt(m ? m[1] : '2f6f5e', 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const crc = buf => zlib.crc32 ? zlib.crc32(buf) : (() => { let c, t = [], r = 0xffffffff; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } for (const b of buf) r = t[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; })();
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body) >>> 0); return Buffer.concat([len, body, c]); };
function icon(size) {
  const [r, g, b] = hex(BRAND.colorPrimary), raw = Buffer.alloc((size * 3 + 1) * size), arm = Math.round(size * 0.07), mid = size / 2, len = size * 0.24;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const plus = (Math.abs(x - mid) <= arm && Math.abs(y - mid) <= len) || (Math.abs(y - mid) <= arm && Math.abs(x - mid) <= len), o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = plus ? 255 : r; raw[o + 1] = plus ? 255 : g; raw[o + 2] = plus ? 255 : b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const manifest = () => ({
  name: `${BRAND.practiceName} enquiries`, short_name: 'Enquiries', description: 'Take an enquiry on a call and add it straight to the practice app.',
  start_url: '/app/enquiry', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: BRAND.colorPrimary,
  icons: [{ src: '/app/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
});
const clientManifest = () => ({
  name: BRAND.practiceName, short_name: String(BRAND.practiceName || 'My app').slice(0, 12), description: 'Your journal, sessions and forms.',
  start_url: '/journal', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: BRAND.colorPrimary,
  icons: [{ src: '/app/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
});
// Installable, but never serves old pages: it does nothing except exist (client data must never be cached on a phone).
const SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});";
module.exports = { icon, manifest, clientManifest, SW };
