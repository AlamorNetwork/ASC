/** Free check of full coverage, exact quotation, crash recovery and Markdown output. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-analysis-check-'));
process.env.ASC_DB = path.join(tmp, 'check.db');
process.env.Bot_Token ||= 'test-only';
process.env.ROUTER_KEY ||= 'test-only';
process.env.ROUTER_BASE_URL ||= 'http://127.0.0.1:1/v1';
const store = await import('../src/db.js');
const { analyzeDocument, documentAnalysisPath } = await import('../src/document-analysis.js');
const yes = (condition, note) => { if (!condition) throw new Error(note); };
try {
  const pid = 'analysis-test';
  const dossier = Number(store.insertDossier({ principalId: pid, topic: 'آزمایش سند' }));
  const id = Number(store.insertDocument({ principalId: pid, dossierId: dossier,
    filename: 'test-book.txt', kind: 'text', extraction: 'local', pages: 2, readPages: 2 }));
  const a = 'در سال یک، پژوهشگر نخست متن کهن را بررسی کرد. سپس نسخه دوم پیدا شد. ';
  const b = 'در سال دو، نویسنده دوم با تفسیر نخست مخالفت کرد. اختلاف درباره تاریخ نسخه بود. ';
  store.insertChunks(pid, dossier, id, [
    { seq: 0, page: 1, text: a.repeat(100) },
    { seq: 1, page: 2, text: b.repeat(100) },
  ]);
  let sectionCalls = 0, synthesisCalls = 0;
  const longFalseQuote = `${a.repeat(10)}این دنباله در سند نیست`;
  const ask = async ({ system }) => {
    if (system.includes('ساختار یک سند')) {
      synthesisCalls++;
      return { data: { overview: 'دو دیدگاه درباره نسخه کهن', structure: ['بخش ۱ زمینه بخش ۲ است'],
        timeline: ['بخش ۱ پیش از بخش ۲'], openQuestions: ['تاریخ نسخه چیست؟'] }, usage: {} };
    }
    sectionCalls++;
    if (sectionCalls === 2) throw new Error('قطع آزمایشی');
    return { data: { about: 'بررسی متن کهن', details: [
      { text: 'نسخه دوم پیدا شد', quote: 'سپس نسخه دوم پیدا شد' },
      { text: 'نقل ساختگی', quote: 'نقل قولی که در سند نیست و مدل ساخته است' },
      { text: 'پسوند ساختگی', quote: longFalseQuote } ],
      events: [], actors: [], concepts: [], links: ['رابطه احتمالی'], questions: [] }, usage: {} };
  };
  let interrupted = false;
  try { await analyzeDocument({ principalId: pid, documentId: id, model: 'fake', ask }); }
  catch (err) { interrupted = err.message === 'قطع آزمایشی'; }
  yes(interrupted, 'simulated interruption was not reached');
  yes(store.analysisSections(pid, id).length === 1, 'first paid section did not survive interruption');
  yes(fs.readFileSync(documentAnalysisPath(pid, id), 'utf8').includes('در حال تکمیل'), 'partial Markdown missing');
  const resumeAsk = async ({ system }) => {
    if (system.includes('ساختار یک سند')) { synthesisCalls++; return { data: { overview: 'دو روایت', structure: ['بخش ۱ به بخش ۲ وصل است'] }, usage: {} }; }
    sectionCalls++;
    return { data: { about: 'اختلاف درباره تاریخ', details: [{ text: 'مخالفت', quote: 'نویسنده دوم با تفسیر نخست مخالفت کرد' }], events: [] }, usage: {} };
  };
  const result = await analyzeDocument({ principalId: pid, documentId: id, model: 'fake', ask: resumeAsk });
  yes(result.sections === 2, 'not all sections analyzed');
  yes(sectionCalls === 3, 'saved section was bought again');
  yes(synthesisCalls === 1, 'synthesis did not run once');
  const markdown = fs.readFileSync(result.file, 'utf8');
  yes(markdown.includes('بخش ۱') && markdown.includes('بخش ۲'), 'missing section');
  yes(markdown.includes('سپس نسخه دوم پیدا شد') && !markdown.includes('نقل ساختگی') &&
    !markdown.includes('پسوند ساختگی'), 'quote gate failed');
  yes(markdown.includes('2 از 2 صفحه'), 'page coverage missing');
  await analyzeDocument({ principalId: pid, documentId: id, model: 'fake', ask: () => { throw new Error('bought again'); } });

  const largeId = Number(store.insertDocument({ principalId: pid, dossierId: dossier,
    filename: 'large.txt', kind: 'text', extraction: 'local', pages: 12, readPages: 12 }));
  store.insertChunks(pid, dossier, largeId, Array.from({ length: 12 }, (_, seq) =>
    ({ seq, page: seq + 1, text: `بخش ${seq + 1} ` + 'متن '.repeat(1998) })));
  let largeSections = 0, batches = 0;
  const largeAsk = async ({ system }) => {
    if (system.includes('ساختار یک سند')) {
      batches++;
      if (batches === 2) throw new Error('قطع گروهی');
      return { data: { overview: 'جمع‌بندی گروه‌ها' } };
    }
    largeSections++;
    return { data: { about: 'موضوع '.repeat(200),
      links: Array(6).fill('رابطه '.repeat(100)),
      questions: Array(6).fill('پرسش '.repeat(100)) } };
  };
  let batchInterrupted = false, batchError = '';
  try { await analyzeDocument({ principalId: pid, documentId: largeId, model: 'fake', ask: largeAsk }); }
  catch (err) { batchError = err.message; batchInterrupted = err.message === 'قطع گروهی'; }
  yes(batchInterrupted && batches === 2, `batch interruption was not reached (${batches} batches, ${largeSections} sections: ${batchError})`);
  yes(largeSections === 12, 'large document was not fully sectioned');
  const savedBatch = store.analysisBatch(pid, largeId, 0, 0);
  yes(savedBatch, 'first synthesis batch was not saved');
  store.saveAnalysisBatch(pid, largeId, 0, 0, savedBatch.source_hash,
    { overview: 'legacy sparse batch' });
  await analyzeDocument({ principalId: pid, documentId: largeId, model: 'fake', ask: largeAsk });
  yes(largeSections === 12 && batches === 4, 'resume repeated saved section or synthesis batch');
  await analyzeDocument({ principalId: pid, documentId: largeId, model: 'fake',
    ask: () => { throw new Error('large document bought again'); } });
  console.log('document analysis check passed — coverage, full quote gate, section and batch resume, cached synthesis; 0 model calls');
} finally {
  store.db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
