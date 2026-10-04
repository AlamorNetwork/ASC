/** A fetched scholarly PDF must yield actual text, never a DOI abstract. No model calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pdftotextAvailable, extractPdf } from '../src/pdf.js';
import { verifyClaim } from '../src/verify.js';

if (!await pdftotextAvailable()) {
  console.log('scholarly PDF check skipped — pdftotext is unavailable on this machine');
  process.exit(0);
}

function makePdf(lines) {
  const content = lines.map((line, i) =>
    `BT /F1 10 Tf 40 ${700 - i * 22} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const quote = 'The House of Diana occupied rooms on the ground floor.';
const body = makePdf([quote,
  ...Array.from({ length: 8 }, (_, i) =>
    `Line ${i + 1} gives a separate readable observation about the site.`)]);
const extracted = await extractPdf(body);
assert.ok(extracted.text.includes(quote), 'test PDF lost its quoted line during extraction');
assert.ok(extracted.text.length > 250, 'test PDF has too little readable text');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': body.length });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const result = await verifyClaim({ sourceUrl: `http://127.0.0.1:${server.address().port}/study.pdf`,
    quote, allowPrivate: true });
  assert.equal(result.status, 'verified', JSON.stringify(result));
  console.log('scholarly PDF check passed — downloaded text-layer PDF, exact quote matched; 0 model calls');
} finally { server.close(); }
