/** Free check for text/image/blank pages and a durable resume cursor. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-mixed-pdf-'));
process.env.ASC_DB = path.join(temp, 'check.db');
process.env.Bot_Token ||= 'test-only';
process.env.ROUTER_KEY ||= 'test-only';
process.env.ROUTER_BASE_URL ||= 'http://127.0.0.1:1/v1';
const store = await import('../src/db.js');
const { pageNeedsVision } = await import('../src/pdf.js');
const { ingestScannedPages } = await import('../src/ingest.js');
try {
  if (pageNeedsVision('متن '.repeat(30)) || !pageNeedsVision('شماره صفحه ۴'))
    throw new Error('mixed PDF page classification failed');
  const principalId = 'reader';
  const dossierId = Number(store.insertDossier({ principalId, topic: 'کتاب ترکیبی' }));
  const buffer = Buffer.from('synthetic mixed PDF');
  const localPerPage = ['متن محلی '.repeat(20), '', '', '', 'پایان کتاب '.repeat(20)];
  const seen = [];
  const pagesIterator = async function* (_bytes, { from, to, skipPages }) {
    for (let page = from; page <= to; page++)
      yield { page, buffer: skipPages.has(page) ? null : Buffer.from('png') };
  };
  const readPage = async (page) => {
    seen.push(page);
    return { text: page === 2 ? 'متن تصویر '.repeat(20) : page === 4 ? '[خالی]' : '',
      usage: { costToman: 5 } };
  };
  const args = { principalId, dossierId, buffer, filename: 'mixed.pdf',
    mime: 'application/pdf', pages: 5, localPerPage, pagesIterator, readPage };
  const first = await ingestScannedPages({ ...args, pageLimit: 3 });
  if (first.readPages !== 3 || seen.join(',') !== '2,3')
    throw new Error('empty model output stopped the file or local page used vision');
  const second = await ingestScannedPages({ ...args, resumeDocumentId: first.documentId });
  if (second.readPages !== 5 || seen.join(',') !== '2,3,4')
    throw new Error('resume repeated pages or skipped the last page');
  const outcomes = store.documentPageReads(principalId, first.documentId);
  if (outcomes.map((r) => r.outcome).join(',') !==
      'local_text,vision_text,model_no_text,blank,local_text')
    throw new Error('blank, no-output and local pages were not distinguished');
  const source = store.sourceCatalogue(principalId, dossierId).find((s) => s.documentId === first.documentId);
  if (source?.noOutputPages.join(',') !== '3' || source?.blankPages.join(',') !== '4')
    throw new Error('mother cannot see pages that need a second look');
  if (store.dossierChunks(principalId, dossierId).some((c) => [3, 4].includes(c.page)) ||
      store.getDocument(principalId, first.documentId).cost_toman !== 15)
    throw new Error('empty pages made false evidence or lost model cost');
  console.log('mixed PDF check passed — text, scan and empty pages; resume through page 5; 0 paid calls');
} finally {
  store.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
