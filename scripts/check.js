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

  // Not due yet.
  if (store.dueIntentions(new Date().toISOString()).some((r) => r.id === id)) {
    throw new Error('a freshly scheduled intention was already due');
  }
  // Due once its time arrives.
  const later = new Date(Date.now() + 25 * 3600 * 1000).toISOString();
  if (!store.dueIntentions(later).some((r) => r.id === id)) throw new Error('never became due');

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
