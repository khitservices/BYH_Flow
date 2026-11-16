// lib/brand.js — the practice's name and colour. Set in the app (Settings > Practice details) and kept in
// core.practice_settings. BRAND is one shared object that pages and emails read each time they render;
// it is loaded from the database on the first request and updated in place when the settings are saved.
// PRACTICE_NAME / BRAND_PRIMARY in the environment are only a fallback for an instance set up before this.
const { q, one } = require('./db');

const HEX = /^#[0-9a-f]{6}$/;
const DEFAULTS = {
  practiceName: process.env.PRACTICE_NAME || 'Your Practice',
  practiceShort: process.env.PRACTICE_SHORT || process.env.PRACTICE_NAME || 'Your Practice',
  colorPrimary: HEX.test(String(process.env.BRAND_PRIMARY || '').toLowerCase()) ? process.env.BRAND_PRIMARY.toLowerCase() : '#007c7e',
};
const BRAND = { ...DEFAULTS };

let loaded = null;
async function load() {
  const r = (await one(`SELECT * FROM core.practice_settings WHERE id = 1`)) || {};
  BRAND.practiceName = r.practice_name || DEFAULTS.practiceName;
  BRAND.practiceShort = r.practice_short || r.practice_name || DEFAULTS.practiceShort;
  BRAND.colorPrimary = r.color_primary || DEFAULTS.colorPrimary;
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

const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
function validate(form) {
  const v = { practice_name: clean(form.practice_name, 80), practice_short: clean(form.practice_short, 30), color_primary: clean(form.color_primary, 7).toLowerCase() };
  if (!v.practice_name) return { error: 'Enter the practice name.' };
  if (!HEX.test(v.color_primary)) return { error: 'Choose a colour (six-digit code such as #007c7e).' };
  if (contrastWithWhite(v.color_primary) < 3) return { error: 'That colour is too pale: white button text would be hard to read on it. Choose a darker one.' };
  return { values: v };
}

async function save(v, staffId) {
  await q(`UPDATE core.practice_settings SET practice_name=$1, practice_short=$2, color_primary=$3, updated_at=now(), updated_by=$4 WHERE id = 1`,
    [v.practice_name, v.practice_short || null, v.color_primary, staffId]);
  await load();
}

module.exports = { BRAND, ensureLoaded, load, validate, save };
