// lib/forms.js — digital forms as data. A template is {title, audience, intro[], sections[{heading, paragraphs[]}],
// choices[{key,type:'yesno'|'tick',required,label}], signer_fields[address|phone|relationship], signing_intro, closing[], footer[]}.
// "Rendering" fills the merge fields once, when the form is sent; the result is stored with the form, so the signer
// signs exactly that text and a later change to the template never alters it.
const crypto = require('node:crypto');

// Merge fields a template may use. Anything else in {{ }} is refused when a template is saved.
const MERGE_FIELDS = {
  therapist_name: 'Therapist name', therapist_qualifications: 'Therapist qualifications', therapist_address: 'Therapist address',
  therapist_postcode: 'Therapist postcode', therapist_phone: 'Therapist phone', therapist_email: 'Therapist email',
  client_name: 'Name of the person the therapy is for', fee: 'Fee per session', session_format: 'In person or online',
};
const SIGNER_FIELDS = ['address', 'phone', 'relationship'];
const FORMATS = { inperson: 'in person', online: 'online via Zoom' };
const money = p => (p == null ? '' : `£${(p / 100).toFixed(2).replace(/\.00$/, '')}`);

const usedFields = s => [...String(s).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(m => m[1]);
const strings = b => [b.title, ...(b.intro || []), ...(b.signing_intro ? [b.signing_intro] : []), ...(b.closing || []), ...(b.footer || []),
  ...(b.sections || []).flatMap(s => [s.heading, ...s.paragraphs]), ...(b.choices || []).map(c => c.label)];

// Check a template body. Returns an error message or null.
function validate(b, audience) {
  if (!b || typeof b !== 'object') return 'The form is empty.';
  if (!b.title || !String(b.title).trim()) return 'The form needs a title.';
  if (!Array.isArray(b.sections) || !b.sections.length || b.sections.some(s => !s.heading || !Array.isArray(s.paragraphs) || !s.paragraphs.length)) return 'Each section needs a heading and some text.';
  const bad = [...new Set(strings(b).flatMap(usedFields))].filter(k => !MERGE_FIELDS[k]);
  if (bad.length) return `Unknown merge field: {{${bad[0]}}}.`;
  if ((b.signer_fields || []).some(f => !SIGNER_FIELDS.includes(f))) return 'Unknown signer detail.';
  if ((b.signer_fields || []).includes('relationship') && audience !== 'child') return 'Relationship to the child only applies to a form signed by a parent or guardian.';
  const keys = (b.choices || []).map(c => c.key);
  if (new Set(keys).size !== keys.length || (b.choices || []).some(c => !/^[a-z_]{1,30}$/.test(c.key) || !['yesno', 'tick'].includes(c.type) || !c.label)) return 'A choice is not set up correctly.';
  return null;
}

// ctx: { therapist (staff row), client_name, fee_pence, session_format ('inperson'|'online') }
function render(body, ctx) {
  const t = ctx.therapist || {};
  const values = {
    therapist_name: t.name, therapist_qualifications: t.qualifications, therapist_address: t.address, therapist_postcode: t.postcode,
    therapist_phone: t.phone, therapist_email: t.email, client_name: ctx.client_name, fee: money(ctx.fee_pence), session_format: FORMATS[ctx.session_format] || FORMATS.inperson,
  };
  const fill = s => String(s).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k) => String(values[k] ?? ''));
  // Footer lines that merge to nothing (a therapist with no postcode, say) are dropped rather than left blank.
  const footer = (body.footer || []).map(fill).filter((l, i) => i === 0 && /^My details$/i.test(l) || l.trim());
  return {
    title: fill(body.title), intro: (body.intro || []).map(fill),
    sections: body.sections.map(s => ({ heading: fill(s.heading), paragraphs: s.paragraphs.map(fill) })),
    choices: (body.choices || []).map(c => ({ key: c.key, type: c.type, required: !!c.required, label: fill(c.label) })),
    signer_fields: body.signer_fields || [], signing_intro: body.signing_intro ? fill(body.signing_intro) : '', closing: (body.closing || []).map(fill), footer,
  };
}
const sha = rendered => crypto.createHash('sha256').update(JSON.stringify(rendered)).digest('hex');

// Plain-text editing format for the practice manager. Lines starting "# " begin a section; text before the first
// heading is the introduction; blank lines separate paragraphs. Choices: one per line as  key | yesno or tick | required or optional | wording
const paras = t => String(t || '').split(/\n\s*\n/).map(x => x.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
function fromText(f) {
  const lines = String(f.wording || '').replace(/\r/g, '').split('\n'), sections = []; let intro = [], cur = null, buf = [];
  const flush = () => { const ps = paras(buf.join('\n')); if (cur) cur.paragraphs = ps; else intro = ps; buf = []; };
  for (const l of lines) { const m = /^#\s+(.+)$/.exec(l); if (m) { flush(); cur = { heading: m[1].trim(), paragraphs: [] }; sections.push(cur); } else buf.push(l); }
  flush();
  const choices = String(f.choices || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [key, type, req, ...rest] = l.split('|').map(x => x.trim()); return { key, type, required: req === 'required', label: rest.join('|').trim() }; });
  const sf = [].concat(f.signer_fields || []).filter(x => SIGNER_FIELDS.includes(x));
  return { title: String(f.title || '').trim(), intro, sections, choices, signer_fields: sf, signing_intro: String(f.signing_intro || '').trim(), closing: paras(f.closing),
    footer: String(f.footer || '').split('\n').map(x => x.trim()).filter(Boolean) };
}
function toText(b) {
  return { title: b.title, wording: [...(b.intro || []), ...b.sections.flatMap(s => ['# ' + s.heading, ...s.paragraphs])].join('\n\n').replace(/\n\n(# )/g, '\n\n$1'),
    choices: (b.choices || []).map(c => [c.key, c.type, c.required ? 'required' : 'optional', c.label].join(' | ')).join('\n'),
    signing_intro: b.signing_intro || '', closing: (b.closing || []).join('\n\n'), footer: (b.footer || []).join('\n'), signer_fields: b.signer_fields || [] };
}

module.exports = { fromText, toText, MERGE_FIELDS, SIGNER_FIELDS, FORMATS, money, validate, render, sha };
