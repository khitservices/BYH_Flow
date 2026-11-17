// lib/pdf.js — the signed copy of a form as a PDF: the exact text that was signed, then a signature record.
const PDFDocument = require('pdfkit');
const T = require('./time');

// rendered: lib/forms.js render() output. sig: { name, relationship, address, phone, choices:{key:'yes'|'no'|true|false}, at: Date, ip, sha }
function signedPdf(rendered, sig, practiceName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: rendered.title, Author: practiceName || '' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(20).text(rendered.title, { align: 'center' }).moveDown(0.8);
    doc.font('Helvetica').fontSize(10.5);
    rendered.intro.forEach((p, i) => doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').text(p).moveDown(0.5));
    for (const s of rendered.sections) {
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12).text(s.heading).moveDown(0.2).font('Helvetica').fontSize(10.5);
      s.paragraphs.forEach(p => doc.text(p).moveDown(0.4));
    }
    doc.addPage().font('Helvetica-Bold').fontSize(12).text('Signed').moveDown(0.3).font('Helvetica').fontSize(10.5);
    if (rendered.signing_intro) doc.text(rendered.signing_intro).moveDown(0.5);
    const line = (k, v) => doc.font('Helvetica-Bold').text(k + ' ', { continued: true }).font('Helvetica').text(String(v || '-'));
    line('Name:', sig.name);
    if (rendered.signer_fields.includes('relationship')) line('Relationship to child:', sig.relationship);
    if (rendered.signer_fields.includes('address')) line('Address:', sig.address);
    if (rendered.signer_fields.includes('phone')) line('Contact number:', sig.phone);
    doc.moveDown(0.4);
    for (const c of rendered.choices) {
      const v = sig.choices[c.key];
      doc.font('Helvetica').text(c.label).font('Helvetica-Bold').text(c.type === 'yesno' ? (v === 'yes' ? 'Yes' : 'No') : (v ? 'Ticked' : 'Not ticked')).moveDown(0.4);
    }
    rendered.closing.forEach(p => doc.font('Helvetica').text(p).moveDown(0.3));
    doc.moveDown(0.6).font('Helvetica-Bold').text('Electronic signature').font('Helvetica')
      .text(`Signed electronically by ${sig.name} on ${T.when(sig.at)} (UK time) by typing their name and agreeing to the above.`)
      .text(`Connection address: ${sig.ip || 'not recorded'}`).text(`Document fingerprint (SHA-256): ${sig.sha}`);
    if (rendered.footer.length) { doc.moveDown(0.8); rendered.footer.forEach((l, i) => doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').text(l)); }
    doc.end();
  });
}
module.exports = { signedPdf };
