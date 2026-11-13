// lib/brand.js — per-practice identity, configured through environment variables, not code.
const colour = (v, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(v || '')) ? v : fallback);

const BRAND = {
  practiceName: process.env.PRACTICE_NAME || 'Your Practice',
  practiceShort: process.env.PRACTICE_SHORT || process.env.PRACTICE_NAME || 'Your Practice',
  colorPrimary: colour(process.env.BRAND_PRIMARY, '#01a6a8'),
};

module.exports = { BRAND };
