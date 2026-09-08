/**
 * Verifies every piece except Telegram, so failures are found before the bot runs.
 *   node scripts/check.js            fast checks only
 *   node scripts/check.js --audio    also runs a real voice note through capture
 */
import fs from 'node:fs';
import http from 'node:http';
import { config } from '../src/config.js';
import * as store from '../src/db.js';
import { captureFromText, captureFromAudio } from '../src/capture.js';
import { verifyClaim, normalise } from '../src/verify.js';

let failures = 0;
const ok = (name, extra = '') => console.log(`  ok    ${name}${extra ? ' — ' + extra : ''}`);
const bad = (name, err) => { failures++; console.log(`  FAIL  ${name} — ${err}`); };

async function check(name, fn) {
  try { const extra = await fn(); ok(name, extra); }
  catch (err) { bad(name, err.message ?? String(err)); }
}

console.log('\nASC self-check\n');

// Every module must at least parse and load. Without this, a syntax error in a file
// the other checks never import only shows up in production.
await check('every source file loads', async () => {
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) await import(new URL(f, dir).href);
  return files.join(' ');
});

await check('config loads', () => {
  if (!config.botToken) throw new Error('no bot token');
  if (!config.router.base) throw new Error('no router base');
  return `router ${config.router.base}`;
});

await check('sqlite opens and schema applies', () => {
  const id = store.insertCapture({
    principalId: 'selfcheck', source: 'text', transcript: 'تست',
    kind: 'note', raw: { t: 1 }, costToman: 0,
  });
  const row = store.getCapture('selfcheck', id);
  if (!row || row.transcript !== 'تست') throw new Error('round trip failed');
  return config.dbPath;
});

await check('principal isolation', () => {
  const id = store.insertCapture({
    principalId: 'principal-A', source: 'text', transcript: 'محرمانه',
    kind: 'note', raw: {}, costToman: 0,
  });
  if (store.getCapture('principal-B', id)) throw new Error('principal B could read principal A row');
  return 'B cannot read A';
});

await check('settings override the file config', async () => {
  const s = await import('../src/settings.js');
  const before = s.modelFor('research');
  s.setModel('research', 'test/model-x');
  if (s.modelFor('research') !== 'test/model-x') throw new Error('model override did not stick');
  store.setSetting('model.research', before);

  s.setBudget(null);
  if (s.budget() !== null) throw new Error('unlimited budget did not stick');
  s.setBudget(0.07);
  if (s.budget() !== 0.07) throw new Error('numeric budget did not stick');
  store.setSetting('budget.per_research', String(config.budget.perResearch));

  try { s.setModel('nonsense', 'x'); throw new Error('an invalid role was accepted'); }
  catch (e) { if (!/نقش نامعتبر/.test(e.message)) throw e; }
  return 'model + budget, with an invalid role rejected';
});

await check('file type classification', async () => {
  const { classify } = await import('../src/ingest.js');
  const cases = [
    [{ filename: 'a.pdf', mime: 'application/pdf' }, 'pdf'],
    [{ filename: 'a.PDF', mime: '' }, 'pdf'],
    [{ filename: 'photo.jpg', mime: 'image/jpeg' }, 'image'],
    [{ filename: 'x', mime: 'image/png' }, 'image'],
    [{ filename: 'notes.md', mime: '' }, 'text'],
    [{ filename: 'data.csv', mime: 'text/csv' }, 'text'],
    [{ filename: 'a.zip', mime: 'application/zip' }, 'unsupported'],
    [{ filename: 'a.exe', mime: '' }, 'unsupported'],
  ];
  for (const [input, want] of cases) {
    const got = classify(input);
    if (got !== want) throw new Error(`${input.filename}/${input.mime}: expected ${want}, got ${got}`);
  }
  return `${cases.length} cases`;
});

await check('oversized and unsupported files are refused', async () => {
  const { guard, MAX_BYTES } = await import('../src/ingest.js');
  try {
    guard({ buffer: Buffer.alloc(10), filename: 'a.zip', mime: 'application/zip' });
    throw new Error('an unsupported type was accepted');
  } catch (e) { if (!/پشتیبانی نمی‌شود/.test(e.message)) throw e; }

  try {
    guard({ buffer: Buffer.alloc(MAX_BYTES + 1), filename: 'big.txt', mime: 'text/plain' });
    throw new Error('an oversized file was accepted');
  } catch (e) { if (!/خیلی بزرگ/.test(e.message)) throw e; }
  return 'both refused before any model call';
});

await check('a text file is read without a model call', async () => {
  const { extractText } = await import('../src/ingest.js');
  const out = await extractText({
    buffer: Buffer.from('سطر یک\nسطر دو', 'utf8'), filename: 'n.txt', mime: 'text/plain', kind: 'text',
  });
  if (out.extraction !== 'local') throw new Error(`extraction=${out.extraction}`);
  if (!out.text.includes('سطر دو')) throw new Error('text not read back');
  if (out.costToman !== 0) throw new Error('a text file should cost nothing to read');
  return 'free, as it should be';
});

await check('a document quote is verified against the document itself', async () => {
  const { verifyAgainstText } = await import('../src/verify.js');
  const doc = 'در این گزارش آمده است که میزان فروش در سال گذشته ۳۲ درصد رشد داشته است.';
  const good = verifyAgainstText(doc, 'میزان فروش در سال گذشته ۳۲ درصد رشد', 'document_quote_matched');
  if (good.status !== 'verified' || good.method !== 'document_quote_matched') {
    throw new Error(`expected verified/document_quote_matched, got ${good.status}/${good.method}`);
  }
  const bad = verifyAgainstText(doc, 'فروش سال گذشته حدود یک سوم بیشتر شد', 'document_quote_matched');
  if (bad.status !== 'found') throw new Error('a paraphrase of the document was accepted');
  return 'exact matched, paraphrase demoted';
});

await check('chunking splits on paragraphs and keeps overlap', async () => {
  const { chunkText } = await import('../src/chunks.js');
  const doc = Array.from({ length: 30 }, (_, i) =>
    `بند شماره ${i} با محتوایی که به اندازه کافی طولانی است تا تکه‌ها واقعاً پر شوند و چند بند در هر تکه جا بگیرد.`
  ).join('\n\n');
  const chunks = chunkText(doc, { size: 400, overlap: 60 });
  if (chunks.length < 3) throw new Error(`expected several chunks, got ${chunks.length}`);
  if (chunks.some((c) => c.length > 700)) throw new Error('a chunk blew past the size limit');
  const oneLine = chunkText('یک جمله کوتاه که از حد چهل کاراکتر می‌گذرد و باید بماند.');
  if (oneLine.length !== 1) throw new Error('a short document should be one chunk');
  return `${chunks.length} chunks, max ${Math.max(...chunks.map((c) => c.length))} chars`;
});

await check('a huge paragraph is cut on sentence ends', async () => {
  const { chunkText } = await import('../src/chunks.js');
  const wall = Array.from({ length: 40 }, (_, i) => `این جمله شماره ${i} است.`).join(' ');
  const chunks = chunkText(wall, { size: 300, overlap: 0 });
  if (chunks.length < 2) throw new Error('a wall of text was not split');
  if (chunks.some((c) => c.length > 500)) throw new Error('sentence splitting did not bound the size');
  return `${chunks.length} chunks`;
});

await check('chunks are stored, indexed, and searchable by keyword', () => {
  const p = `fts-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'تست بازیابی' });
  const documentId = store.insertDocument({
    principalId: p, dossierId, filename: 'x.txt', kind: 'text', extraction: 'local', charCount: 100,
  });
  store.insertChunks(p, dossierId, documentId, [
    { seq: 0, page: 1, text: 'میترائیسم رومی پدیده‌ای عمدتاً رومی بود و ادامه‌ی مستقیم آیین ایرانی نیست.' },
    { seq: 1, page: 2, text: 'دیالوگ و زیرمتن دو ابزار اصلی فیلم‌نامه‌نویسی هستند.' },
  ]);
  const hits = store.searchChunks(p, dossierId, 'میترائیسم رومی');
  if (!hits.length) throw new Error('keyword search found nothing');
  if (!hits[0].text.includes('میترائیسم')) throw new Error('wrong chunk ranked first');
  if (store.searchChunks(`${p}-other`, dossierId, 'میترائیسم').length !== 0) {
    throw new Error('chunks leaked across principals');
  }
  if (store.documentText(p, documentId).length < 50) throw new Error('document text did not reassemble');
  return `${hits.length} hit(s), principal-scoped`;
});

await check('vector search ranks the closer passage first', async () => {
  const { vectorSearch } = await import('../src/chunks.js');
  const p = `vec-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'تست بردار' });
  const documentId = store.insertDocument({
    principalId: p, dossierId, filename: 'v.txt', kind: 'text', extraction: 'local',
  });
  const blob = (arr) => Buffer.from(new Float32Array(arr).buffer);
  store.insertChunks(p, dossierId, documentId, [
    { seq: 0, text: 'نزدیک', embedding: blob([1, 0, 0]) },
    { seq: 1, text: 'دور', embedding: blob([0, 1, 0]) },
  ]);
  const ranked = vectorSearch(p, dossierId, [0.9, 0.1, 0]);
  if (ranked[0]?.text !== 'نزدیک') throw new Error(`wrong order: ${ranked.map((r) => r.text).join(',')}`);
  if (!(ranked[0].score > ranked[1].score)) throw new Error('scores are not ordered');
  return `cosine ${ranked[0].score.toFixed(3)} vs ${ranked[1].score.toFixed(3)}`;
});

await check('pdftotext presence is reported, not assumed', async () => {
  const { pdftotextAvailable } = await import('../src/pdf.js');
  const ok = await pdftotextAvailable();
  return ok ? 'installed' : 'NOT installed — PDFs will report this clearly instead of crashing';
});

await check('a repeated finding is not reported as new', async () => {
  const { isNew } = await import('../src/intentions.js');
  const existing = [
    { text: 'میترائیسم رومی پدیده‌ای عمدتاً رومی بود و ادامه‌ی آیین ایرانی نیست', source_url: 'https://a.test/1' },
    { text: 'میتراییوم‌ها بیشتر در مرزهای نظامی روم پراکنده بودند', source_url: 'https://b.test/2' },
  ];
  // Same source, so not news whatever the wording.
  if (isNew({ text: 'یک چیز کاملاً متفاوت', sourceUrl: 'https://a.test/1' }, existing)) {
    throw new Error('a claim from an already-cited source was called new');
  }
  // Same claim reworded, so not news either.
  if (isNew({ text: 'میترائیسم رومی عمدتاً پدیده‌ای رومی بود و ادامه‌ی آیین ایرانی نیست', sourceUrl: 'https://c.test' }, existing)) {
    throw new Error('a reworded duplicate was called new');
  }
  // Genuinely different, from a new source.
  if (!isNew({ text: 'کتیبه‌ای تازه در سوریه کشف شد که تاریخ‌گذاری را جابه‌جا می‌کند', sourceUrl: 'https://d.test' }, existing)) {
    throw new Error('a genuinely new finding was suppressed');
  }
  return 'same-source and reworded suppressed, new finding kept';
});

await check('intentions are due, expire, and record runs', async () => {
  const { createWatch, nextRun, hasGoneQuiet, QUIET_RUNS_BEFORE_ASKING } = await import('../src/intentions.js');
  const p = `intent-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'موضوع پیگیری' });
  const id = createWatch({ principalId: p, dossierId, everyHours: 24, days: 60 });

  const it = store.getIntention(p, id);
  if (it.state !== 'armed') throw new Error(`state=${it.state}`);
  if (!it.until_at) throw new Error('an intention without an expiry was created');

  // Not due yet. A wide limit so leftovers from earlier runs cannot hide the answer.
  if (store.dueIntentions(new Date().toISOString(), 500).some((r) => r.id === id)) {
    throw new Error('a freshly scheduled intention was already due');
  }
  // Due once its time arrives.
  const later = new Date(Date.now() + 25 * 3600 * 1000).toISOString();
  if (!store.dueIntentions(later, 500).some((r) => r.id === id)) throw new Error('never became due');

  store.recordIntentionRun(p, id, {
    ranAt: new Date().toISOString(), nextRunAt: nextRun(24),
    state: 'nothing_new', nothingNew: true, costToman: 500,
  });
  const after = store.getIntention(p, id);
  if (after.runs !== 1 || after.silent_runs !== 1) throw new Error('run counters did not move');
  if (after.cost_toman !== 500) throw new Error('cost was not accumulated');

  for (let i = 1; i < QUIET_RUNS_BEFORE_ASKING; i++) {
    store.recordIntentionRun(p, id, {
      ranAt: new Date().toISOString(), nextRunAt: nextRun(24),
      state: 'nothing_new', nothingNew: true,
    });
  }
  if (!hasGoneQuiet(store.getIntention(p, id))) throw new Error('a quiet watch was not flagged');

  // A finding resets the silence counter.
  store.recordIntentionRun(p, id, {
    ranAt: new Date().toISOString(), nextRunAt: nextRun(24),
    state: 'succeeded', newClaims: 2, nothingNew: false,
  });
  if (store.getIntention(p, id).silent_runs !== 0) throw new Error('silence counter did not reset');

  // Leave nothing armed behind, or every later run drags this one along.
  store.setIntentionState(p, id, 'suspended');
  return 'due, counted, quiet-flagged, reset';
});

await check('dossier links are undirected and widen the search scope', () => {
  const p = `link-${Date.now()}`;
  const a = store.insertDossier({ principalId: p, topic: 'الف' });
  const b = store.insertDossier({ principalId: p, topic: 'ب' });
  const c = store.insertDossier({ principalId: p, topic: 'ج' });

  store.linkDossiers(p, b, a);            // deliberately out of order
  store.linkDossiers(p, a, b);            // and duplicated
  if (store.linkedDossiers(p, a).length !== 1) throw new Error('a duplicate link was stored twice');
  if (store.linkedDossiers(p, b)[0]?.id !== a) throw new Error('the link is not undirected');

  const scope = store.dossierScope(p, a);
  if (!scope.includes(a) || !scope.includes(b)) throw new Error(`scope wrong: ${scope}`);
  if (scope.includes(c)) throw new Error('an unlinked dossier leaked into scope');

  try { store.linkDossiers(p, a, a); throw new Error('a dossier was linked to itself'); }
  catch (e) { if (!/به خودش/.test(e.message)) throw e; }

  if (store.unlinkDossiers(p, b, a) !== 1) throw new Error('unlink did not remove the row');
  if (store.linkedDossiers(p, a).length !== 0) throw new Error('link survived unlink');
  return 'ordered, deduped, self-link refused';
});

await check('keyword search spans linked dossiers', () => {
  const p = `scope-${Date.now()}`;
  const a = store.insertDossier({ principalId: p, topic: 'الف' });
  const b = store.insertDossier({ principalId: p, topic: 'ب' });
  const docA = store.insertDocument({ principalId: p, dossierId: a, filename: 'a.txt', kind: 'text', extraction: 'local' });
  const docB = store.insertDocument({ principalId: p, dossierId: b, filename: 'b.txt', kind: 'text', extraction: 'local' });
  store.insertChunks(p, a, docA, [{ seq: 0, text: 'دیالوگ در فیلم‌نامه ابزار اصلی شخصیت‌پردازی است.' }]);
  store.insertChunks(p, b, docB, [{ seq: 0, text: 'زیرمتن همان چیزی است که شخصیت نمی‌گوید.' }]);

  if (store.searchChunks(p, a, 'زیرمتن').length !== 0) throw new Error('found a chunk outside scope');
  store.linkDossiers(p, a, b);
  const wide = store.searchChunks(p, store.dossierScope(p, a), 'زیرمتن');
  if (!wide.length) throw new Error('linked dossier was not searched');
  if (wide[0].dossier_id !== b) throw new Error('result is not tagged with its dossier');
  return 'linked material is reachable and labelled';
});

await check('a half-read document is recognised and resumed, not re-read', async () => {
  const { sha256 } = await import('../src/ingest.js');
  const p = `resume-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'کتاب اسکن‌شده' });
  const bytes = Buffer.from('pretend this is a pdf');
  const hash = sha256(bytes);

  const docId = store.insertDocument({
    principalId: p, dossierId, filename: 'book.pdf', kind: 'pdf', extraction: 'model_vision_pages',
    pages: 209, readPages: 20, charCount: 5000, costToman: 19200, sha256: hash,
  });
  store.insertChunks(p, dossierId, docId, [
    { seq: 0, page: 1, text: 'صفحه‌ی اول کتاب با متن کافی برای اینکه تکه به حساب بیاید.' },
    { seq: 1, page: 2, text: 'صفحه‌ی دوم کتاب با متن کافی برای اینکه تکه به حساب بیاید.' },
  ]);

  const found = store.findDocumentByHash(p, dossierId, hash);
  if (!found || found.id !== docId) throw new Error('the same bytes were not recognised');
  if (found.read_pages !== 20 || found.pages !== 209) throw new Error('progress was not stored');

  // Different bytes must not match.
  if (store.findDocumentByHash(p, dossierId, sha256(Buffer.from('other')))) {
    throw new Error('a different file matched');
  }

  // Resuming continues the sequence rather than restarting it.
  if (store.maxChunkSeq(docId) !== 1) throw new Error(`maxChunkSeq=${store.maxChunkSeq(docId)}`);

  store.advanceDocument(docId, { readPages: 40, addedChars: 4000, addedCost: 18000 });
  const after = store.getDocument(p, docId);
  if (after.read_pages !== 40) throw new Error('read_pages did not advance');
  if (after.char_count !== 9000) throw new Error(`char_count should accumulate, got ${after.char_count}`);
  if (after.cost_toman !== 37200) throw new Error(`cost should accumulate, got ${after.cost_toman}`);
  return 'recognised at 20/209, advanced to 40, counters accumulate';
});

await check('a fully read document is not offered again', () => {
  const p = `done-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'کتاب کامل' });
  store.insertDocument({
    principalId: p, dossierId, filename: 'done.pdf', kind: 'pdf', extraction: 'model_vision_pages',
    pages: 12, readPages: 12, sha256: 'abc', costToman: 1000,
  });
  const prior = store.findDocumentByHash(p, dossierId, 'abc');
  if (!(prior.read_pages >= prior.pages)) throw new Error('a finished document looks unfinished');
  return 'finished documents are detectable';
});

await check('multi-hop search follows a lead to different wording', async () => {
  const { investigate } = await import('../src/investigate.js');
  const p = `hop-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'کتاب دین' });
  const docId = store.insertDocument({
    principalId: p, dossierId, filename: 'book.pdf', kind: 'pdf', extraction: 'local',
  });
  // The book never says "ابراهیمی" — it says "سامی". A single search finds nothing.
  store.insertChunks(p, dossierId, docId, [
    { seq: 0, page: 12, text: 'دین‌های سامی سه شاخه دارند و ریشه‌ی مشترکی در خاور نزدیک دارند.' },
    { seq: 1, page: 40, text: 'واژه‌ی سامی در سده‌ی نوزدهم برای این خانواده از ادیان به کار رفت.' },
  ]);

  // Scripted planner: first hop uses the user's wording, then follows the lead.
  let call = 0;
  const ask = async () => {
    call++;
    if (call === 1) return { data: { queries: ['ادیان ابراهیمی'] }, usage: {} };
    if (call === 2) {
      return { data: { enough: false, lead: 'کتاب به‌جای «ابراهیمی» از «سامی» استفاده می‌کند',
                       missing: 'چیزی با واژه‌ی ابراهیمی نبود', next_queries: ['سامی'] }, usage: {} };
    }
    return { data: { enough: true, lead: null, missing: null, next_queries: [] }, usage: {} };
  };

  const steps = [];
  {
    const out = await investigate({
      principalId: p, dossierId, question: 'درباره‌ی ادیان ابراهیمی چه می‌گوید؟',
      ask, onStep: (s) => { steps.push(s); },
    });
    if (out.hops < 2) throw new Error(`expected to follow the lead, hops=${out.hops}`);
    if (!out.passages.length) throw new Error('the second wording found nothing');
    if (!steps.some((s) => s.kind === 'lead' && /سامی/.test(s.lead ?? ''))) {
      throw new Error('the lead was never reported');
    }
    if (!steps.some((s) => s.kind === 'searching' && s.queries.includes('سامی'))) {
      throw new Error('the follow-up search never ran');
    }
    return `${out.hops} hops, ${out.passages.length} passages, lead reported live`;
  }
});

await check('when leads run dry it searches the user other dossiers', async () => {
  const { investigate } = await import('../src/investigate.js');
  const p = `wide-${Date.now()}`;
  const here = store.insertDossier({ principalId: p, topic: 'پرونده‌ی اصلی' });
  const other = store.insertDossier({ principalId: p, topic: 'پرونده‌ی دیگر' });

  const dHere = store.insertDocument({ principalId: p, dossierId: here, filename: 'h.txt', kind: 'text', extraction: 'local' });
  const dOther = store.insertDocument({ principalId: p, dossierId: other, filename: 'o.txt', kind: 'text', extraction: 'local' });
  store.insertChunks(p, here, dHere, [{ seq: 0, text: 'مطلبی کاملاً بی‌ربط درباره‌ی هواشناسی و بارش باران.' }]);
  store.insertChunks(p, other, dOther, [{ seq: 0, text: 'زرتشت و آموزه‌های او در متون پهلوی بررسی شده است.' }]);

  const ask = async () => ({
    data: { queries: ['زرتشت'], enough: false, lead: null, missing: 'چیزی نبود', next_queries: [] },
    usage: {},
  });

  const steps = [];
  const out = await investigate({
    principalId: p, dossierId: here, question: 'درباره‌ی زرتشت چه می‌دانیم؟',
    maxHops: 2, ask, onStep: (s) => steps.push(s),
  });

  if (!out.elsewhere.length) throw new Error('the other dossier was never searched');
  if (out.elsewhere[0].dossier.id !== other) throw new Error('wrong dossier reported');
  if (out.notInCorpus) throw new Error('claimed nothing was found while material sat in another dossier');
  if (!steps.some((s) => s.kind === 'elsewhere')) throw new Error('the find was not reported live');

  // A principal with no other dossiers must not be told to look anywhere.
  const lone = `lone-${Date.now()}`;
  const only = store.insertDossier({ principalId: lone, topic: 'تنها' });
  const outLone = await investigate({
    principalId: lone, dossierId: only, question: 'هیچ', maxHops: 1, ask,
  });
  if (outLone.elsewhere.length) throw new Error('found material where there is none');
  return 'found it next door, and reported it live';
});

await check('multi-hop stops instead of looping forever', async () => {
  const { investigate } = await import('../src/investigate.js');
  const p = `hopstop-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'خالی' });
  const docId = store.insertDocument({
    principalId: p, dossierId, filename: 'e.txt', kind: 'text', extraction: 'local',
  });
  store.insertChunks(p, dossierId, docId, [
    { seq: 0, text: 'متنی کاملاً بی‌ربط درباره‌ی آشپزی و پخت نان محلی در روستا.' },
  ]);

  // A planner that never says "enough" — the loop must still terminate.
  const ask = async () => ({
    data: { queries: ['یک'], enough: false, lead: null, missing: 'هیچ', next_queries: ['دو'] },
    usage: {},
  });
  {
    const out = await investigate({
      principalId: p, dossierId, question: 'سؤال بی‌ربط', maxHops: 3, ask,
    });
    if (out.hops > 3) throw new Error(`ran ${out.hops} hops past the limit`);
    if (!out.exhausted) throw new Error('did not report itself exhausted');
    return `stopped after ${out.hops} hop(s), exhausted`;
  }
});

await check('two users see nothing of each other', async () => {
  const s = await import('../src/settings.js');
  const a = `userA-${Date.now()}`;
  const b = `userB-${Date.now()}`;

  const dA = store.insertDossier({ principalId: a, topic: 'پرونده‌ی خصوصی الف' });
  const docA = store.insertDocument({ principalId: a, dossierId: dA, filename: 'a.txt', kind: 'text', extraction: 'local' });
  store.insertChunks(a, dA, docA, [{ seq: 0, text: 'اطلاعات کاملاً خصوصی کاربر الف که نباید دیده شود.' }]);
  store.insertClaim({ principalId: a, dossierId: dA, text: 'ادعای الف', status: 'verified' });
  store.addMessage({ principalId: a, dossierId: dA, role: 'user', text: 'پیام خصوصی الف' });
  store.insertCapture({ principalId: a, source: 'text', transcript: 'ثبت الف', kind: 'note', raw: {} });

  if (store.listDossiers(b).length) throw new Error('B can list A dossiers');
  if (store.getDossier(b, dA)) throw new Error('B can open A dossier');
  if (store.dossierClaims(b, dA).length) throw new Error('B can read A claims');
  if (store.dossierChunks(b, dA).length) throw new Error('B can read A chunks');
  if (store.searchChunks(b, dA, 'خصوصی').length) throw new Error('B can search A chunks');
  if (store.conversation(b, dA).length) throw new Error('B can read A conversation');
  if (store.recentCaptures(b).length) throw new Error('B can read A captures');
  if (store.dossierDocuments(b, dA).length) throw new Error('B can list A documents');
  if (store.getDocument(b, docA)) throw new Error('B can open A document');
  if (store.stats(b).dossiers !== 0) throw new Error('B stats count A rows');

  // The open dossier is per person, not a shared pointer.
  s.setActiveDossier(a, dA);
  if (s.activeDossier(b) !== null) throw new Error('B inherited A active dossier');
  if (s.activeDossier(a) !== dA) throw new Error('A lost its own active dossier');

  return '10 read paths and the open dossier are all scoped';
});

await check('access control admits, blocks, and remembers', () => {
  const id = `9${Date.now()}`.slice(0, 12);
  store.upsertUser({ principalId: id, name: 'مهمان' });
  if (store.getUser(id).state !== 'pending') throw new Error('a newcomer is not pending');

  store.setUserState(id, 'active', 'member');
  const active = store.getUser(id);
  if (active.state !== 'active' || active.role !== 'member') throw new Error('approval did not stick');
  if (!active.decided_at) throw new Error('the decision was not timestamped');

  store.setUserState(id, 'blocked');
  if (store.getUser(id).state !== 'blocked') throw new Error('blocking did not stick');
  if (store.getUser(id).role !== 'member') throw new Error('blocking lost the role');

  // Re-registering must not silently reset a decision.
  store.upsertUser({ principalId: id, name: 'مهمان دوباره' });
  if (store.getUser(id).state !== 'blocked') throw new Error('a blocked user re-registered themselves');
  return 'pending → active → blocked, and blocking survives re-contact';
});

await check('every menu screen renders without throwing', async () => {
  const menu = await import('../src/menu.js');
  const p = `menu-${Date.now()}`;
  // A title with HTML in it must not be able to break the screen.
  const id = store.insertDossier({ principalId: p, topic: '<b>عنوان & خطرناک</b>' });
  store.upsertUser({ principalId: p, name: '<script>', role: 'owner', state: 'active' });

  for (const name of ['root', 'dossiers', 'watches', 'cost', 'data', 'settings', 'users', 'help']) {
    const view = menu.screen(name, p, undefined, { isOwner: true });
    if (!view?.text) throw new Error(`${name} produced no text`);
    if (/<b>عنوان & خطرناک<\/b>/.test(view.text)) throw new Error(`${name} did not escape a dossier title`);
    for (const row of view.buttons ?? []) {
      for (const b of row) {
        if (Buffer.byteLength(b.callback_data) > 64) {
          throw new Error(`${name}: callback_data over Telegram's 64-byte limit`);
        }
      }
    }
  }
  const one = menu.screen('d', p, id, { isOwner: true });
  if (!one.text.includes('&lt;b&gt;')) throw new Error('the dossier screen did not escape its title');
  const missing = menu.screen('d', p, 999999, { isOwner: true });
  if (!missing.text.includes('پیدا نشد')) throw new Error('a missing dossier was not handled');
  return '8 screens + detail, escaped, callback_data within limits';
});

await check('deep investigation names the source it still needs', async () => {
  const { deepInvestigate } = await import('../src/deep.js');
  const p = `deep-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'موضوع عمیق' });
  const docId = store.insertDocument({
    principalId: p, dossierId, filename: 'd.txt', kind: 'text', extraction: 'local',
  });
  store.insertChunks(p, dossierId, docId, [
    { seq: 0, text: 'اشاره‌ای کوتاه به موضوع هست ولی جزئیاتش در این متن نیامده است.' },
  ]);

  const rounds = [];
  const out = await deepInvestigate({
    principalId: p, dossierId, question: 'جزئیات چیست؟',
    ceilingUsd: 0,               // no web spend allowed, so it must stop at once
    onRound: (r) => rounds.push(r),
  }).catch((e) => { throw new Error(`threw instead of stopping: ${e.message}`); });

  if (!rounds.length) throw new Error('no round was reported');
  if (out.rounds > 12) throw new Error(`ran ${out.rounds} rounds past the hard stop`);
  if (!['exhausted', 'ceiling', 'rounds'].includes(out.stopped)) {
    throw new Error(`unexpected stop reason: ${out.stopped}`);
  }
  if (!Array.isArray(out.open)) throw new Error('no list of open questions');
  return `stopped after ${out.rounds} round(s): ${out.stopped}`;
});

await check('deep investigation respects a zero ceiling', async () => {
  const { deepInvestigate } = await import('../src/deep.js');
  const p = `deepcap-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'سقف صفر' });
  const before = store.recentEpisodes(p, 50).length;

  const out = await deepInvestigate({
    principalId: p, dossierId, question: 'هرچیزی', ceilingUsd: 0,
  });
  // A zero ceiling must mean no web research episode was ever started.
  const after = store.recentEpisodes(p, 50).length;
  if (after !== before) throw new Error(`spent on ${after - before} web round(s) despite a zero ceiling`);
  if (out.costUsd > 0.02) throw new Error(`spent $${out.costUsd} under a zero ceiling`);
  return 'no web round started';
});

await check('conversation history round trips', () => {
  // A fresh principal each run, so a previous run's rows cannot make this pass or fail.
  const p = `chat-test-${Date.now()}`;
  store.addMessage({ principalId: p, dossierId: 1, role: 'user', text: 'سلام' });
  store.addMessage({ principalId: p, dossierId: 1, role: 'assistant', text: 'بله' });
  const conv = store.conversation(p, 1);
  if (conv.length !== 2) throw new Error(`expected 2 turns, got ${conv.length}`);
  if (conv[0].role !== 'user') throw new Error('history is not oldest-first');
  if (store.conversation(`${p}-other`, 1).length !== 0) throw new Error('history leaked across principals');
  return 'oldest-first, principal-scoped';
});

await check('persian normalisation', () => {
  const a = normalise('كتاب مي‌خوانم.');
  const b = normalise('کتاب می خوانم');
  if (a !== b) throw new Error(`"${a}" !== "${b}"`);
  return a;
});

// Served locally, so the test cannot break because a third-party page was reworded.
const fixture = `<html><body><h1>نمونه</h1>
<p>میترائیسم رومی پدیده‌ای عمدتاً رومی بود و ادامه‌ی مستقیم آیین ایرانی نیست.</p>
<p>This domain is served by the ASC self-check.</p></body></html>`;
const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

await check('verify rejects an unsupported quote', async () => {
  const r = await verifyClaim({
    sourceUrl: fixtureUrl,
    quote: 'این جمله قطعاً در این صفحه وجود ندارد و باید رد شود',
  });
  if (r.status !== 'found') throw new Error('a missing quote was marked verified');
  return r.note;
});

await check('verify accepts a quote that is really there', async () => {
  const r = await verifyClaim({
    sourceUrl: fixtureUrl,
    quote: 'میترائیسم رومی پدیده‌ای عمدتاً رومی بود',
  });
  if (r.status !== 'verified') throw new Error(`expected verified, got ${r.status} (${r.note})`);
  return r.method;
});

await check('verify rejects a paraphrase', async () => {
  const r = await verifyClaim({
    sourceUrl: fixtureUrl,
    quote: 'میترائیسم رومی بیشتر یک پدیده رومی بوده است',  // same meaning, different words
  });
  if (r.status !== 'found') throw new Error('a paraphrase was accepted as verified');
  return r.note;
});

server.close();

await check('capture from text', async () => {
  const { capture, usage } = await captureFromText('برو در مورد آیین میترائیسم تحقیق کن و منبع معتبر بده');
  if (capture.kind !== 'research') throw new Error(`expected research, got ${capture.kind}`);
  if (!capture.transcript) throw new Error('empty transcript');
  return `kind=${capture.kind} · ${Math.round(usage.costToman)} toman`;
});

await check('capture does not invent a request', async () => {
  const { capture } = await captureFromText('امروز هوا خیلی سرد بود و حوصله نداشتم');
  if (capture.request) throw new Error(`invented a request: "${capture.request}"`);
  return `kind=${capture.kind} · request=null`;
});

if (process.argv.includes('--audio')) {
  // node scripts/check.js --audio path/to/voice.ogg
  const sample = process.argv[process.argv.indexOf('--audio') + 1] ?? process.env.SAMPLE_AUDIO;
  await check('capture from real voice note', async () => {
    if (!sample) throw new Error('pass a path: --audio path/to/voice.ogg');
    if (!fs.existsSync(sample)) throw new Error(`not found: ${sample}`);
    const { capture, usage } = await captureFromAudio(fs.readFileSync(sample));
    if (!capture.transcript) throw new Error('empty transcript');
    console.log(`        «${capture.transcript.slice(0, 90)}…»`);
    return `kind=${capture.kind} · ${Math.round(usage.costToman)} toman`;
  });
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
