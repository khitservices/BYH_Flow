// lib/brand.js — the practice's name and colour. Set in the app (Settings > Practice details) and kept in
// core.practice_settings. BRAND is one shared object that pages and emails read each time they render;
// it is loaded from the database on the first request and updated in place when the settings are saved.
// PRACTICE_NAME / BRAND_PRIMARY in the environment are only a fallback for an instance set up before this.
const { q, one } = require('./db');

const HEX = /^#[0-9a-f]{6}$/;
const DEFAULTS = {
  practiceName: process.env.PRACTICE_NAME || 'Your Practice',
  practiceShort: process.env.PRACTICE_SHORT || process.env.PRACTICE_NAME || 'Your Practice',
  logoVersion: 0,
  colorPrimary: HEX.test(String(process.env.BRAND_PRIMARY || '').toLowerCase()) ? process.env.BRAND_PRIMARY.toLowerCase() : '#007c7e',
};
const BRAND = { ...DEFAULTS };

let loaded = null;
async function load() {
  const r = (await one(`SELECT practice_name, practice_short, color_primary, logo_type, logo_version FROM core.practice_settings WHERE id = 1`)) || {};
  BRAND.practiceName = r.practice_name || DEFAULTS.practiceName;
  BRAND.practiceShort = r.practice_short || r.practice_name || DEFAULTS.practiceShort;
  BRAND.colorPrimary = r.color_primary || DEFAULTS.colorPrimary;
  BRAND.logoVersion = r.logo_version && r.logo_type ? r.logo_version : 0;
}
// Express middleware: make sure the saved values are in BRAND before the first page is rendered.
function ensureLoaded(_req, _res, next) {
  if (!loaded) loaded = load().catch(e => { loaded = null; console.error('[brand] load failed:', e.message); });
  loaded.then(() => next());
}

// Buttons and links put white text on this colour, so a pale colour would make them unreadable.
function contrastWithWhite(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

// Accepts "007C7E", "#007c7e" or the short "#0a7" and gives back "#007c7e" (or what it was, so validation can reject it).
function normHex(v) {
  let h = String(v ?? '').trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split('').map(c => c + c).join('');
  return '#' + h;
}
const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
function validate(form) {
  const v = { practice_name: clean(form.practice_name, 80), practice_short: clean(form.practice_short, 30), color_primary: normHex(form.color_primary) };
  if (!v.practice_name) return { error: 'Enter the practice name.' };
  if (!HEX.test(v.color_primary)) return { error: 'Enter a colour as a six-digit hex code, such as #007c7e (or pick one with the colour box).' };
  if (contrastWithWhite(v.color_primary) < 3) return { error: 'That colour is too pale: white button text would be hard to read on it. Choose a darker one.' };
  return { values: v };
}

async function save(v, staffId) {
  await q(`UPDATE core.practice_settings SET practice_name=$1, practice_short=$2, color_primary=$3, updated_at=now(), updated_by=$4 WHERE id = 1`,
    [v.practice_name, v.practice_short || null, v.color_primary, staffId]);
  await load();
}

const LOGO_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': null };
const MAX_LOGO = 500 * 1024;
// The file's own bytes decide what it is (not the name or the type the browser claims). No SVG: it can carry script.
function sniff(buf) {
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  for (const t of ['image/png', 'image/jpeg']) if (LOGO_TYPES[t].every((b, i) => buf[i] === b)) return t;
  return null;
}
async function saveLogo(buf, staffId) {
  const type = sniff(buf);
  if (!type) return { error: 'The logo must be a PNG, JPEG or WebP picture.' };
  if (buf.length > MAX_LOGO) return { error: 'That picture is too large. Use one under 500 KB.' };
  await q(`UPDATE core.practice_settings SET logo=$1, logo_type=$2, logo_version=logo_version+1, updated_at=now(), updated_by=$3 WHERE id=1`, [buf, type, staffId]);
  await load();
  return {};
}
async function removeLogo(staffId) {
  await q(`UPDATE core.practice_settings SET logo=NULL, logo_type=NULL, logo_version=logo_version+1, updated_at=now(), updated_by=$1 WHERE id=1`, [staffId]);
  await load();
}
const getLogo = () => one(`SELECT logo, logo_type FROM core.practice_settings WHERE id=1 AND logo IS NOT NULL`);
const logoUrl = () => (BRAND.logoVersion ? `/brand/logo?v=${BRAND.logoVersion}` : null);

module.exports = { BRAND, ensureLoaded, load, validate, save, saveLogo, removeLogo, getLogo, logoUrl, MAX_LOGO };
