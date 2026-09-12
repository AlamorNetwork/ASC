/**
 * Verifies every piece except Telegram, so failures are found before the bot runs.
 *
 *   node scripts/check.js            everything that costs nothing — run this on deploy
 *   node scripts/check.js --paid     also the checks that call a model for real
 *   node scripts/check.js --audio f  --paid, plus a real voice note through capture
 *
 * The split exists because a suite that spends money on every deploy is a suite people
 * stop running. The default run is bounded by FREE_CEILING_TOMAN and fails if it goes
 * over, so a model call cannot quietly move into it later.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The suite creates dossiers, documents, users and claims. Those belong nowhere near
// the file holding the user's real work — principal scoping kept them invisible, but a
// thousand rows had still accumulated in it. Set before anything opens a database, which
// is why the imports below are dynamic: a static import would have run first.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ASC_DB ??= path.join(ROOT, 'data', 'check.db');

const { config } = await import('../src/config.js');
const store = await import('../src/db.js');
const { captureFromText, captureFromAudio, transcriptionModel } = await import('../src/capture.js');
const { verifyClaim, normalise } = await import('../src/verify.js');
const { spendMark, spendSince } = await import('../src/llm.js');

const PAID = process.argv.includes('--paid') || process.argv.includes('--audio');

// Embedding a couple of short queries is the only spend the free run should ever see.
const FREE_CEILING_TOMAN = 50;

let failures = 0;
let skipped = 0;
const freeStart = spendMark();

/**
 * Services that answered, but with something wrong.
 *
 * The suite is built to degrade rather than fail — a dead reranker costs precision, not
 * the answer, and that is deliberate. The cost is that a run can print "all checks
 * passed" on a machine whose semantic search is entirely gone, because every one of
 * those checks correctly verified the fallback. The warnings scroll past above the
 * summary and nobody reads them.
 *
 * So they are collected and repeated at the end, where the verdict is.
 */
const degraded = new Map();

// Several checks break things on purpose — a reranker that does not exist, a model id
// that cannot resolve, a planner whose endpoint is down — and each one warns exactly as
// it should. Those are the suite talking to itself; reporting them as service trouble
// would bury the real thing under noise from tests that passed. Every fixture below is
// named in this file.
const DELIBERATE = /definitely|not-a-real|\btest\/|endpoint down|@nowhere/i;

const realWarn = console.warn;
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  const m = line.match(/^\[(chunks|rerank|llm|deep|router)\]\s*(.*)$/);
  if (m && !DELIBERATE.test(line)) {
    // Keyed on the shape of the problem, not its wording, so forty identical embedding
    // failures are one line rather than forty.
    const key = `${m[1]}:${m[2].replace(/\d+/g, 'N').slice(0, 60)}`;
    const seen = degraded.get(key) ?? { n: 0, line: line.slice(0, 220) };
    seen.n++;
    degraded.set(key, seen);
  }
  realWarn(...args);
};

const ok = (name, extra = '') => console.log(`  ok    ${name}${extra ? ' — ' + extra : ''}`);
const bad = (name, err) => { failures++; console.log(`  FAIL  ${name} — ${err}`); };

async function check(name, fn) {
  const mark = spendMark();
  try {
    const extra = await fn();
    // A free check that spent something is named on the spot, so the ceiling below
    // never has to be traced back by hand.
    const cost = Math.round(spendSince(mark).toman);
    ok(name, `${extra}${cost ? `  ⚠ spent ${cost} toman` : ''}`);
  } catch (err) { bad(name, err.message ?? String(err)); }
}

/**
 * A check that calls a model for real. Skipped unless asked for, and it says what it
 * spent, so the price of running the suite is never a surprise.
 */
async function paid(name, fn) {
  if (!PAID) { skipped++; return; }
  const mark = spendMark();
  try {
    const extra = await fn();
    const cost = spendSince(mark);
    ok(name, `${extra}${cost.toman ? ` · ${Math.round(cost.toman)} toman` : ''}`);
  } catch (err) { bad(name, err.message ?? String(err)); }
}

console.log(`\nASC self-check${PAID ? ' — including the checks that spend' : ''}\n`);

// Every module must at least parse and load. Without this, a syntax error in a file
// the other checks never import only shows up in production.
await check('every source file loads', async () => {
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) await import(new URL(f, dir).href);
  return files.join(' ');
});

await check('a model can name its provider, and a chain of them', async () => {
  const p = await import('../src/providers.js');
  const env = {
    KIRA_BASE_URL: 'https://kiraai.vn/api/v1',
    KIRA_KEYS: 'k1, k2 ,k3',
    NOKEY_BASE_URL: 'https://example.invalid/v1',   // declared but unusable
  };
  const providers = p.buildProviders(env, { base: 'https://main.test/v1', key: 'main-key' });

  if (!providers.has('kira')) throw new Error('KIRA_BASE_URL did not declare a provider');
  if (providers.get('kira').keys.length !== 3) throw new Error('the three keys were not split');
  if (providers.has('nokey')) throw new Error('a provider with no key was accepted');

  // A bare id goes to the default endpoint; `@name` goes where it says.
  const plan = p.planFor('qwen3.8-flash-free@kira,glm-5.3-free@kira,google/gemini-3.6-flash', providers);
  if (plan.length !== 3) throw new Error(`chain had ${plan.length} links`);
  if (plan[0].provider.name !== 'kira' || plan[0].model !== 'qwen3.8-flash-free') {
    throw new Error(`first link wrong: ${plan[0].model}@${plan[0].provider.name}`);
  }
  if (plan[2].provider.name !== 'default') throw new Error('a bare id left the default provider');

  // Model ids contain both / and :, which is why the separator is @ and why the LAST
  // one is the delimiter.
  const online = p.planFor('qwen/qwen3.7-flash:online@kira', providers);
  if (online[0].model !== 'qwen/qwen3.7-flash:online') throw new Error(`mangled: ${online[0].model}`);

  const junk = p.planFor('a@nowhere,google/gemini-3.6-flash', providers);
  if (junk.length !== 1) throw new Error('an unknown provider took the whole chain down');

  return '3 links, @ parsed from the right';
});

await check('an exhausted key is set aside and the next one is used', async () => {
  const p = await import('../src/providers.js');
  p.clearCooling();
  const providers = p.buildProviders(
    { KIRA_BASE_URL: 'https://kiraai.vn/api/v1', KIRA_KEYS: 'k1,k2' },
    { base: 'https://main.test/v1', key: 'main-key' });
  const kira = providers.get('kira');

  if (p.keysAvailable(kira).length !== 2) throw new Error('both keys should start ready');

  // 429 on a free tier is routine, not a broken credential — it comes back.
  p.setAside('kira', 0, p.kindOfFailure(429));
  const left = p.keysAvailable(kira);
  if (left.length !== 1 || left[0].index !== 1) throw new Error('the rate-limited key was still offered');

  p.setAside('kira', 1, p.kindOfFailure(401));
  if (p.keysAvailable(kira).length !== 0) throw new Error('a rejected key was still offered');

  if (p.kindOfFailure(402) !== 'credit') throw new Error('402 should mean out of balance');
  if (p.kindOfFailure(400) !== null) throw new Error('400 is a bad request, not a bad key');

  // kiraai answered 502 for three free models while the key was demonstrably valid.
  // Treating that as a spent key would have rested every key over their outage, and
  // treating it as a final answer stopped the chain before the paid fallback.
  for (const status of [500, 502, 503, 504]) {
    if (p.kindOfFailure(status) !== 'upstream') throw new Error(`${status} was not read as their problem`);
    if (!p.blamesTheModel(p.kindOfFailure(status))) throw new Error(`${status} should move to the next model`);
  }
  if (p.kindOfFailure(404) !== 'missing') throw new Error('404 should mean this provider lacks the model');
  if (!p.blamesTheModel('missing')) throw new Error('a missing model should move to the next one');
  for (const kind of ['rate', 'credit', 'auth']) {
    if (p.blamesTheModel(kind)) throw new Error(`${kind} is about the key, not the model`);
  }

  // Which free models are up changed completely between two probe runs minutes apart,
  // so the chain has to be long — and a long chain of down links must not cost a failed
  // round trip each, on every call.
  if (p.modelResting('kira', 'glm-5.3-free')) throw new Error('a model started out resting');
  p.restModel('kira', 'glm-5.3-free');
  if (!p.modelResting('kira', 'glm-5.3-free')) throw new Error('a failed model was not set aside');
  if (p.modelResting('kira', 'qwen3.8-flash-free')) throw new Error('resting one model rested another');
  // Resting a model must not touch the key it failed on — there is nothing wrong with it.
  if (p.keysAvailable(kira).length !== 0) throw new Error('unrelated: keys changed');


  const status = p.providerStatus(providers).find((s) => s.name === 'kira');
  if (status.ready !== 0 || status.keys !== 2) throw new Error('status does not reflect the cool-off');

  p.clearCooling();
  if (p.keysAvailable(kira).length !== 2) throw new Error('clearing did not restore the keys');

  // 402 is the ambiguous one: an empty account, or one model outside the plan. Liara
  // refused gemini-3.7-flash on a key whose embeddings were working that same minute,
  // so the first refusal must blame the model — resting the key would have taken
  // embeddings, reranking and research down with it.
  if (p.refusalCount('liara', 0) !== 0) throw new Error('refusals did not start empty');
  if (p.noteRefusal('liara', 0, 'google/gemini-3.7-flash') !== 1) throw new Error('first refusal not counted');
  if (p.noteRefusal('liara', 0, 'google/gemini-3.7-flash') !== 1) throw new Error('the same model counted twice');
  if (p.noteRefusal('liara', 0, 'openai/gpt-5.4-mini') !== 2) throw new Error('a second model was not distinct');
  if (p.refusalCount('liara', 1) !== 0) throw new Error('refusals leaked to another key');
  p.clearCooling();
  if (p.refusalCount('liara', 0) !== 0) throw new Error('clearing did not reset refusals');

  return '429 rests a minute, 401 a day, 400 blames neither, 402 blames the model first';
});

await check('the database can leave the machine by itself', async () => {
  // When sshd stopped on the server the bot kept answering while the database sat on a
  // disk nobody could reach. A snapshot has to be takeable from inside the process, and
  // has to be a real database rather than a torn copy of a file being written to.
  const { DatabaseSync } = await import('node:sqlite');
  const target = path.join(path.dirname(config.dbPath), 'snapshot-check.db');

  store.insertCapture({
    principalId: 'snapshot-src', source: 'text', transcript: 'باید در پشتیبان باشد',
    kind: 'note', raw: {}, costToman: 0,
  });
  const before = store.readOnlyQuery("SELECT count(*) c FROM captures WHERE principal_id = 'snapshot-src'")[0].c;

  const size = store.snapshotTo(target);
  if (!size) throw new Error('the snapshot was empty');

  const copy = new DatabaseSync(target);
  const after = copy.prepare("SELECT count(*) c FROM captures WHERE principal_id = 'snapshot-src'").get().c;
  const tables = copy.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
  copy.close();
  fs.rmSync(target, { force: true });

  if (after !== before) throw new Error(`snapshot has ${after} of ${before} rows`);
  if (tables < 10) throw new Error(`snapshot has only ${tables} tables`);

  // Taken twice in a row, since the second must not trip over the first one's file.
  store.snapshotTo(target);
  fs.rmSync(target, { force: true });
  return `${tables} tables, ${(size / 1024).toFixed(0)} KB, repeatable`;
});

await check('the suite never writes to the real database', () => {
  // The guard that makes the separation stick. Without it, one static import creeping
  // back to the top of this file would silently point the whole suite at real data.
  const real = path.join(config.root, 'data', 'asc.db');
  if (path.resolve(config.dbPath) === path.resolve(real)) {
    throw new Error('the checks are pointed at the production database');
  }
  return path.basename(config.dbPath);
});

await check('every role points at a model the endpoint actually has', async () => {
  // A role whose chain resolves to nothing does not announce itself. It falls back to a
  // built-in default, that default is not on this endpoint either, and the feature is
  // dead until someone sends a voice note and gets an error. Moving behind a gateway
  // renames every model, so this is exactly when it happens.
  const settings = await import('../src/settings.js');
  const { planFor } = await import('../src/providers.js');

  const catalogue = new Map();   // provider name -> Set of ids it serves
  const unreachable = [];

  async function idsFor(provider) {
    if (catalogue.has(provider.name)) return catalogue.get(provider.name);
    let set = null;
    try {
      const res = await fetch(`${provider.base}/models`, {
        headers: { Authorization: `Bearer ${provider.keys[0]}` },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) set = new Set(((await res.json()).data ?? []).map((m) => m.id));
    } catch { /* handled below */ }
    if (!set) unreachable.push(provider.name);
    catalogue.set(provider.name, set);
    return set;
  }

  const broken = [];
  const roles = settings.allModels();
  for (const [role, spec] of Object.entries(roles)) {
    if (!spec || spec === 'none') continue;
    const plan = planFor(spec, config.providers);
    if (!plan.length) { broken.push(`${role}: «${spec}» names no known provider`); continue; }

    let anyGood = false;
    let anyChecked = false;
    for (const { model, provider } of plan) {
      const ids = await idsFor(provider);
      if (!ids) continue;                       // could not ask; not evidence either way
      anyChecked = true;
      if (ids.has(model)) { anyGood = true; break; }
    }
    if (anyChecked && !anyGood) {
      broken.push(`${role}: none of ${plan.length} link(s) exist — ${plan.map((p) => p.model).join(', ')}`);
    }
  }

  if (broken.length) {
    // Loud, because silence here reads as working software.
    throw new Error(`\n        ${broken.join('\n        ')}`);
  }
  const checked = [...catalogue.entries()].filter(([, v]) => v).map(([k]) => k);
  if (!checked.length) return 'no endpoint could be asked — nothing verified';
  return `${Object.keys(roles).length} roles against ${checked.join(', ')}` +
    (unreachable.length ? ` (could not ask: ${unreachable.join(', ')})` : '');
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

await paid('deep investigation names the source it still needs', async () => {
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
    ceilingUsd: 0.002,           // enough to search the corpus, not enough for the web
    onRound: (r) => rounds.push(r),
  }).catch((e) => { throw new Error(`threw instead of stopping: ${e.message}`); });

  if (!rounds.length) throw new Error('no round was reported');
  if (!['exhausted', 'ceiling', 'unmeasured', 'time'].includes(out.stopped)) {
    throw new Error(`unexpected stop reason: ${out.stopped}`);
  }
  if (!Array.isArray(out.open)) throw new Error('no list of open questions');
  return `stopped after ${out.rounds} round(s): ${out.stopped}`;
});

// This one used to run unlimited real research to see whether the guard would stop it,
// at 58,000 toman a run. Stubs that report no usage test the same guard faithfully and
// deterministically — a provider that reports nothing is exactly what they simulate.
await check('deep investigation stops when cost cannot be measured', async () => {
  const { deepInvestigate } = await import('../src/deep.js');
  const p = `blind-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'هزینه‌ی نامعلوم' });

  let searches = 0;
  const out = await deepInvestigate({
    principalId: p, dossierId, question: 'بند', ceilingUsd: null,  // unlimited on purpose
    // Always something fresh, never a reported cost: the loop has no reason of its own
    // to stop, so only the blind guard can end it.
    search: async () => ({
      passages: [{ id: `chunk-${++searches}`, text: 'پاساژ تازه' }],
      trail: [{ lead: 'سرنخ تازه' }], hops: 1, exhausted: false, costToman: 0, costUsd: 0,
    }),
    web: async () => ({ output: { found: [{ text: `ادعای تازه ${searches}` }] }, costToman: 0, costUsd: 0 }),
    assess: async () => ({ data: { next_leads: ['سرنخ بعدی'] }, usage: {} }),
  });

  if (out.stopped !== 'unmeasured') throw new Error(`expected the blind guard, got ${out.stopped}`);
  if (out.rounds > 6) throw new Error(`ran ${out.rounds} rounds while flying blind`);
  if (out.costToman > 0) throw new Error('reported a cost it was never given');
  return `blind guard stopped it after ${out.rounds} round(s)`;
});

// A ceiling reached used to mean the next run began at the original question again and
// re-bought everything already searched.
await check('a resumed investigation carries on from its leads, not from the start', async () => {
  const { deepInvestigate } = await import('../src/deep.js');
  const p = `resume-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'ادامه' });

  const asked = [];
  const stubs = (leadName) => ({
    search: async ({ question: q }) => {
      asked.push(q);
      return {
        passages: [{ id: `c-${q}`, text: 'پاساژ' }], trail: [{ lead: q }],
        hops: 1, exhausted: false, costToman: 300, costUsd: 0.02,
      };
    },
    web: async () => ({ output: { found: [{ text: `یافته ${asked.length}` }] }, costToman: 0, costUsd: 0 }),
    assess: async () => ({ data: { next_leads: [leadName] }, usage: {} }),
  });

  // First leg: a tight ceiling, so it stops with a frontier still to follow.
  const first = await deepInvestigate({
    principalId: p, dossierId, question: 'سؤال اصلی', ceilingUsd: 0.03, ...stubs('سرنخ تازه'),
  });
  if (!first.runId) throw new Error('the run was not recorded');
  if (first.stopped !== 'ceiling') throw new Error(`stopped as ${first.stopped}`);
  if (!first.canResume) throw new Error('a run stopped by its ceiling should be resumable');
  if (!first.nextLeads.includes('سرنخ تازه')) throw new Error('the frontier was not kept');

  const beforeResume = asked.length;
  const second = await deepInvestigate({
    principalId: p, dossierId, question: 'سؤال اصلی', ceilingUsd: 0.03,
    runId: first.runId, ...stubs('سرنخ تازه'),
  });

  const askedOnResume = asked.slice(beforeResume);
  if (askedOnResume.includes('سؤال اصلی')) {
    throw new Error('the resume started from the original question again');
  }
  if (!askedOnResume.includes('سرنخ تازه')) throw new Error('the resume ignored the saved leads');
  if (second.rounds <= first.rounds) throw new Error('rounds did not accumulate across the resume');
  // The new ceiling is more allowance, not a new total — otherwise carried-over spend
  // would exhaust it before the first round.
  if (second.roundsThisTime < 1) throw new Error('the fresh ceiling bought no rounds at all');
  if (second.costUsd <= first.costUsd) throw new Error('cost did not carry over');

  return `${first.rounds} then +${second.roundsThisTime}, resumed at «${askedOnResume[0]}»`;
});

await check('a stop is honoured and leaves the run resumable', async () => {
  const { deepInvestigate } = await import('../src/deep.js');
  const p = `stop-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'توقف' });

  let runId = null;
  const out = await deepInvestigate({
    principalId: p, dossierId, question: 'برو تا ته', ceilingUsd: null,
    search: async ({ question: q }) => ({
      passages: [{ id: `s-${Math.random()}`, text: 'تازه' }], trail: [{ lead: q }],
      hops: 1, exhausted: false, costToman: 100, costUsd: 0.001,
    }),
    web: async () => ({ output: { found: [] }, costToman: 0, costUsd: 0 }),
    assess: async () => ({ data: { next_leads: ['هنوز جا دارد'] }, usage: {} }),
    // Pressing stop after the first round, the way the button does.
    onRound: async (r) => { runId = r.runId; store.requestStop(p, r.runId); },
  });

  if (out.stopped !== 'stopped') throw new Error(`stopped as ${out.stopped}, not by request`);
  if (out.rounds > 2) throw new Error(`ran ${out.rounds} rounds after being told to stop`);
  if (!out.canResume) throw new Error('a stopped run must be resumable');

  const saved = store.getInvestigation(p, runId);
  if (saved.state !== 'paused') throw new Error(`saved as ${saved.state}`);
  if (!JSON.parse(saved.leads).length) throw new Error('the frontier was not saved');
  return `stopped after ${out.rounds} round(s), frontier kept`;
});

await check('a restart does not strand a running investigation', async () => {
  const p = `orphan-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'ری‌استارت' });
  const id = store.startInvestigation({ principalId: p, dossierId, question: 'نصفه ماند' });
  store.saveInvestigation(id, {
    state: 'running', rounds: 2, leads: ['سرنخ باقی‌مانده'], seenChunks: [], allLeads: [],
    costToman: 500, costUsd: 0.02,
  });

  const reopened = store.reopenInterruptedInvestigations();
  if (!reopened.some((r) => r.id === id)) throw new Error('the interrupted run was not offered');
  const after = store.getInvestigation(p, id);
  if (after.state !== 'paused') throw new Error(`left as ${after.state}`);
  if (after.stopped !== 'interrupted') throw new Error('the reason was not recorded');
  if (!JSON.parse(after.leads).length) throw new Error('the frontier was lost');
  return 'reopened as paused, frontier intact';
});

await check('a zero ceiling starts nothing at all', async () => {
  const { deepInvestigate } = await import('../src/deep.js');
  const p = `deepcap-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'سقف صفر' });
  const before = store.recentEpisodes(p, 50).length;
  const mark = spendMark();

  const out = await deepInvestigate({
    principalId: p, dossierId, question: 'هرچیزی', ceilingUsd: 0,
  });
  // Allowing zero spend means no round is begun, not one begun and then abandoned.
  if (out.rounds !== 0) throw new Error(`ran ${out.rounds} round(s) on a zero ceiling`);
  if (out.stopped !== 'ceiling') throw new Error(`stop reason was ${out.stopped}`);
  if (store.recentEpisodes(p, 50).length !== before) throw new Error('a web round was started anyway');
  if (out.costUsd > 0) throw new Error(`spent $${out.costUsd} under a zero ceiling`);
  // The figure the caller sees is not enough — this once reported zero while the closing
  // summary call quietly spent a thousand toman.
  const actual = Math.round(spendSince(mark).toman);
  if (actual > 0) throw new Error(`reported nothing but really spent ${actual} toman`);
  return 'nothing begun, nothing spent — confirmed against the meter';
});

await check('a missing reranker costs precision, not the answer', async () => {
  const { rerank, resetRerank, rerankAvailable } = await import('../src/rerank.js');
  const store2 = await import('../src/db.js');

  // Point it at a model the endpoint will refuse, then confirm it disables itself
  // rather than throwing, and stays disabled instead of asking again every question.
  const before = store2.getSetting('model.rerank');
  const restore = () => {
    if (before === null) store2.clearSetting('model.rerank');
    else store2.setSetting('model.rerank', before);
    resetRerank();
  };
  store2.setSetting('model.rerank', 'definitely/not-a-real-reranker');
  resetRerank();

  try {
  const out = await rerank('سؤال', ['متن یک', 'متن دو']);
  if (out !== null) throw new Error('a refused reranker returned a result');
  if (rerankAvailable() === true) throw new Error('a refused reranker marked itself available');

  // And retrieval still returns passages with it switched off.
  const p = `rr-${Date.now()}`;
  const dossierId = store2.insertDossier({ principalId: p, topic: 'بدون ریرنکر' });
  const docId = store2.insertDocument({
    principalId: p, dossierId, filename: 'r.txt', kind: 'text', extraction: 'local',
  });
  store2.insertChunks(p, dossierId, docId, [
    { seq: 0, text: 'میترائیسم آیینی رازآمیز بود که در امپراتوری روم گسترش یافت.' },
    { seq: 1, text: 'متنی کاملاً بی‌ربط درباره‌ی کشاورزی و آبیاری.' },
  ]);
  const { retrieve } = await import('../src/chunks.js');
  const rows = await retrieve({ principalId: p, dossierId, query: 'میترائیسم', limit: 2 });
  if (!rows.length) throw new Error('retrieval returned nothing without a reranker');

  return 'disabled itself, retrieval unaffected';
  } finally {
    // Without this the fake id outlives the run: a later suite reads it out of the
    // database and reports the reranker as misconfigured, which it now does loudly.
    restore();
  }
});

await check('a repeated query is embedded once, not every time', async () => {
  const chunks = await import('../src/chunks.js');
  const p = `cache-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'کش' });
  const docId = store.insertDocument({
    principalId: p, dossierId, filename: 'c.txt', kind: 'text', extraction: 'local',
  });
  store.insertChunks(p, dossierId, docId, [
    { seq: 0, text: 'میترائیسم آیینی رازآمیز بود که در امپراتوری روم گسترش یافت.' },
  ]);

  const before = chunks.embedCacheStats().size;
  const q = `پرسش یکتا ${Date.now()}`;
  await chunks.retrieve({ principalId: p, dossierId, query: q, limit: 2 });
  const afterFirst = chunks.embedCacheStats().size;
  await chunks.retrieve({ principalId: p, dossierId, query: q, limit: 2 });
  const afterSecond = chunks.embedCacheStats().size;

  // The second call must not add another entry — it should have hit the cache. If the
  // embedding endpoint was unreachable nothing was cached either time, which is also
  // correct behaviour, so that case is not a failure.
  if (afterFirst > before && afterSecond !== afterFirst) {
    throw new Error('the same query was embedded twice');
  }
  return afterFirst > before ? 'cached and reused' : 'endpoint unreachable, degraded to keyword';
});

// «جمع‌بندی کن» once became a research episode on the topic "summarising", because a
// deep run left no dossier open and the message fell through to capture.
await check('the router answers the obvious cases without a model', async () => {
  const { route } = await import('../src/router.js');
  // A model call to classify what a regex already knows is exactly the sort of cost
  // that hides in plain sight, so the free paths are asserted to stay free.
  const boom = () => { throw new Error('the router paid for a decision it did not need'); };

  const meta = await route({ text: 'جمع‌بندی کن', hasDossier: true, ask: boom });
  if (meta.intent !== 'summarise') throw new Error(`meta went to ${meta.intent}`);
  if (meta.decidedBy !== 'rule') throw new Error('a meta request cost a model call');

  const word = await route({ text: 'میترائیسم', hasDossier: false, ask: boom });
  if (word.intent !== 'keep') throw new Error(`a lone word went to ${word.intent}`);

  const empty = await route({ text: '   ', hasDossier: true, ask: boom });
  if (empty.intent !== 'keep') throw new Error('empty text was routed somewhere');
  return 'meta, one word and empty are free';
});

await check('the router degrades to the old behaviour instead of failing', async () => {
  const { route } = await import('../src/router.js');
  const dead = () => { throw new Error('endpoint down'); };

  // With the router unavailable, a dossier open means chat and nothing open means keep —
  // which is what this program did before there was a router at all.
  const open = await route({ text: 'این نظریه از کجا آمد؟', hasDossier: true, ask: dead });
  if (open.intent !== 'chat') throw new Error(`fell back to ${open.intent}`);
  const shut = await route({ text: 'یک فکری به سرم زد درباره‌ی ساختار', hasDossier: false, ask: dead });
  if (shut.intent !== 'keep') throw new Error(`fell back to ${shut.intent}`);

  // A reply naming something that is not an intent must not be acted on.
  const nonsense = await route({
    text: 'برو تحقیق کن', hasDossier: true,
    ask: async () => ({ data: { intent: 'delete_everything', topic: 'x' }, usage: {} }),
  });
  if (nonsense.intent !== 'chat') throw new Error(`invented intent survived: ${nonsense.intent}`);

  // research without a subject cannot be carried out, so it must not be proposed.
  const vague = await route({
    text: 'یه چیزی پیدا کن', hasDossier: true,
    ask: async () => ({ data: { intent: 'research', topic: null }, usage: {} }),
  });
  if (vague.intent === 'research') throw new Error('research was proposed with no topic');
  return 'down, invented and topicless all land somewhere safe';
});

await check('spending is proposed, never started by the router alone', async () => {
  const { COSTS_MONEY, INTENTS } = await import('../src/router.js');
  for (const paid of ['research', 'deep']) {
    if (!COSTS_MONEY.has(paid)) throw new Error(`${paid} is not marked as costing money`);
  }

  // Every paid intent must reach a button in app.js rather than a call. Asserted on the
  // source because the alternative is driving Telegram, and this is the rule that keeps
  // a misread message from spending on its own.
  const src = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function handleTypedMessage'),
                         src.indexOf('async function offerADossier'));
  for (const forbidden of ['runDeep(', 'runResearch(', 'startResearch(']) {
    if (body.includes(forbidden)) {
      throw new Error(`handleTypedMessage calls ${forbidden} directly — spending without asking`);
    }
  }
  for (const needed of ['callback_data: `research:', 'deepgo:']) {
    if (!body.includes(needed)) throw new Error(`no confirmation button for ${needed}`);
  }
  const unknown = INTENTS.filter((i) => !['chat', 'summarise', 'search', 'research', 'deep', 'keep', 'open'].includes(i));
  if (unknown.length) throw new Error(`unhandled intents: ${unknown.join(', ')}`);
  return 'research and deep both go through a button';
});

await check('asking for a summary is about the conversation, not a topic', async () => {
  const { isAboutTheConversation } = await import('../src/chat.js');

  const meta = ['جمع بندی کن', 'جمع‌بندی کن', 'خلاصه‌اش کن', 'تا اینجا چی فهمیدی؟',
    'یه مرور کن', 'نتیجه گیری کن', 'summarise this', 'recap'];
  for (const t of meta) {
    if (!isAboutTheConversation(t)) throw new Error(`treated as a subject: «${t}»`);
  }

  // A real question that happens to contain one of those words still needs retrieval —
  // skipping it there would answer from the dossier summary alone.
  const subjects = [
    'جمع‌بندی پژوهش‌های کومون درباره‌ی خاستگاه ایرانی میترا در سده‌ی بیستم چه بود و چه کسانی نقدش کردند؟',
    'میترائیسم چه بود؟',
    'درباره‌ی آیین مهر تحقیق کن',
  ];
  for (const t of subjects) {
    if (isAboutTheConversation(t)) throw new Error(`retrieval would be skipped for: «${t}»`);
  }
  return `${meta.length} meta, ${subjects.length} subjects`;
});

await check('a deep investigation leaves its dossier open to talk to', async () => {
  // The bug was that only startResearch opened the dossier, so after a deep run the
  // next typed message had nowhere to go. Asserted on the source, since the alternative
  // is driving Telegram.
  const src = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function runDeep'), src.indexOf('async function runWebResearch'));
  if (!/setActiveDossier\(principalId, dossierId\)/.test(body)) {
    throw new Error('runDeep does not open its dossier — typed replies will fall through to capture');
  }
  return 'runDeep opens its dossier';
});

await check('an invented source never becomes evidence for the next answer', async () => {
  const chat = await import('../src/chat.js');
  const p = `fab-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'میترائیسم' });

  store.insertClaim({
    principalId: p, dossierId, text: 'ادعای درست', status: 'verified',
    sourceUrl: 'https://fa.wikipedia.org/x', verifyReason: 'matched',
  });
  store.insertClaim({
    principalId: p, dossierId, text: 'ادعای با منبع ساختگی', status: 'found',
    sourceUrl: 'https://www.encyclopedi iranica.com/x', verifyReason: 'fabricated_url',
  });
  store.insertClaim({
    principalId: p, dossierId, text: 'ادعای با نقل‌قول اشتباه', status: 'found',
    sourceUrl: 'https://real.example/x', verifyReason: 'quote_absent',
  });

  const ctx = chat.dossierContextFor(p, dossierId);
  if (ctx.includes('ادعای با منبع ساختگی')) {
    throw new Error('a fabricated citation was handed back to the model as evidence');
  }
  // The honest failure is dropping it while saying so — not hiding that it happened.
  if (!ctx.includes('ساختگی')) throw new Error('the model was not told anything was dropped');
  if (!ctx.includes('ادعای با نقل‌قول اشتباه')) {
    throw new Error('a real source with a bad quote is weak evidence, not nothing');
  }
  if (!ctx.includes('ادعای درست')) throw new Error('verified claims went missing');
  return 'fabricated dropped, weak kept, both accounted for';
});

await check('evidence is summarised without inventing a confidence number', async () => {
  const m = await import('../src/metacognition.js');
  const claim = (status, reason) => ({ status, verify_reason: reason });

  const mixed = m.assessEvidence([
    claim('verified', 'matched'), claim('verified', 'matched'),
    claim('found', 'quote_absent'),
    claim('found', 'unreachable'),      // ours, not the model's — out of the denominator
  ]);
  if (mixed.checkable !== 3) throw new Error(`unreachable counted against the model: ${mixed.checkable}`);
  if (Math.abs(mixed.supportRate - 2 / 3) > 1e-9) throw new Error(`support rate wrong: ${mixed.supportRate}`);

  // One invented source is disqualifying however good the rest looks.
  const fabricating = m.assessEvidence([
    claim('verified', 'matched'), claim('verified', 'matched'), claim('verified', 'matched'),
    claim('found', 'fabricated_url'),
  ]);
  if (fabricating.trustworthy) throw new Error('a fabricated source did not disqualify the run');

  const nothing = m.assessEvidence([]);
  if (nothing.supportRate !== null) throw new Error('a rate was invented from no claims');
  return `${mixed.verified}/${mixed.checkable} supported, fabrication disqualifies`;
});

await check('a forecast is made before the round and judged after', async () => {
  const m = await import('../src/metacognition.js');
  const p = `cal-${Date.now()}`;

  // With no history it must decline to guess rather than produce a number.
  const cold = m.predictYield([{ round: 1, fresh: 3 }]);
  if (cold.p !== 0.5) throw new Error('it guessed from one round');

  const productive = m.predictYield([{ fresh: 3 }, { fresh: 2 }, { fresh: 4 }, { fresh: 1 }]);
  const drying = m.predictYield([{ fresh: 3 }, { fresh: 1 }, { fresh: 0 }, { fresh: 0 }]);
  if (!(productive.p > drying.p)) throw new Error('a drying run was not predicted to yield less');

  // Recorded before, settled after, and settled only once.
  const id = m.predict(p, null, 'round_yields', 0.8, 'test');
  m.observe(id, true);
  if (store.settlePrediction(id, 0) !== 0) throw new Error('a settled prediction was rescored');

  for (let i = 0; i < 4; i++) m.observe(m.predict(p, null, 'round_yields', 0.8, 't'), true);
  for (let i = 0; i < 4; i++) m.observe(m.predict(p, null, 'round_yields', 0.2, 't'), false);

  const c = m.calibration(p);
  if (c.n !== 9) throw new Error(`expected 9 settled, got ${c.n}`);
  if (c.brier > 0.1) throw new Error(`well-calibrated predictions scored badly: ${c.brier}`);

  // And a liar must score badly, or the score means nothing.
  const liar = `liar-${Date.now()}`;
  for (let i = 0; i < 6; i++) m.observe(m.predict(liar, null, 'round_yields', 0.95, 't'), false);
  if (m.calibration(liar).brier < 0.25) throw new Error('confident and always wrong still scored well');
  return `brier ${c.brier.toFixed(3)} honest, ${m.calibration(liar).brier.toFixed(2)} for a liar`;
});

await check('spending stops on judgement, not only on the ceiling', async () => {
  const m = await import('../src/metacognition.js');
  const thin = m.assessEvidence([{ status: 'found', verify_reason: 'quote_absent' }]);
  const solid = m.assessEvidence(Array.from({ length: 6 }, () => ({ status: 'verified', verify_reason: 'matched' })));

  // Nothing supported yet and rounds still producing: worth carrying on.
  const early = m.worthSpending({ yieldP: 0.8, evidence: thin, spentUsd: 0.01, ceilingUsd: 0.5, roundCostUsd: 0.02 });
  if (!early.spend) throw new Error('it refused to spend while everything was still unsupported');

  // Leads drying up and the answer already well supported: stop before the ceiling.
  const late = m.worthSpending({ yieldP: 0.1, evidence: solid, spentUsd: 0.02, ceilingUsd: 0.5, roundCostUsd: 0.02 });
  if (late.spend) throw new Error('it kept paying for rounds unlikely to add anything');

  // The ceiling still wins outright — a judgement may not spend past what was agreed.
  const over = m.worthSpending({ yieldP: 0.99, evidence: thin, spentUsd: 0.5, ceilingUsd: 0.5, roundCostUsd: 0.01 });
  if (over.spend) throw new Error('a judgement overrode the agreed ceiling');

  // Higher stakes should make it readier to keep going on the same evidence.
  const low = m.worthSpending({ yieldP: 0.4, evidence: thin, spentUsd: 0, ceilingUsd: 0.5, roundCostUsd: 0.1, stakes: 0.1 });
  const high = m.worthSpending({ yieldP: 0.4, evidence: thin, spentUsd: 0, ceilingUsd: 0.5, roundCostUsd: 0.1, stakes: 0.9 });
  if (!(high.gain > low.gain)) throw new Error('stakes did not affect the decision');
  return 'continues while thin, stops when dry, never past the ceiling';
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
const server = http.createServer((req, res) => {
  // /blocked stands in for Britannica and Encyclopaedia Iranica, which refuse this
  // fetcher outright.
  if (req.url?.startsWith('/blocked')) { res.writeHead(403); res.end('no'); return; }
  // A page that is simply not there — what an invented citation looks like.
  if (req.url?.includes('404')) { res.writeHead(404); res.end('gone'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

// Scoring these two the same made a model that cited Encyclopaedia Iranica look
// identical to one that invented a URL.
await check('a source we cannot open is not the same as a claim that is wrong', async () => {
  const blocked = await verifyClaim({
    sourceUrl: `${fixtureUrl}blocked`,
    quote: 'هر نقل‌قولی، چون صفحه اصلاً باز نمی‌شود',
  });
  if (blocked.reason !== 'unreachable') throw new Error(`a 403 was scored as ${blocked.reason}`);
  if (blocked.status === 'verified') throw new Error('an unreadable page verified a claim');

  const wrong = await verifyClaim({
    sourceUrl: fixtureUrl,
    quote: 'این جمله قطعاً در این صفحه نیست و باید رد شود چون واقعاً نیست',
  });
  if (wrong.reason !== 'quote_absent') throw new Error(`a missing quote was scored as ${wrong.reason}`);

  // qwen cited "https://www.encyclopedi iranica.com/..." — a domain with a space in it.
  // Scoring that as "we could not open the page" flattered it enormously.
  const invented = await verifyClaim({
    sourceUrl: 'https://www.encyclopedi iranica.com/articles/mithraism-i',
    quote: 'هر نقل‌قولی، چون این آدرس اصلاً وجود ندارد',
  });
  if (invented.reason !== 'fabricated_url') {
    throw new Error(`a malformed URL was scored as ${invented.reason}`);
  }

  const gone = await verifyClaim({
    sourceUrl: `${fixtureUrl}nothing-here-404`,
    quote: 'هر نقل‌قولی، چون این صفحه وجود ندارد',
  });
  if (gone.reason !== 'fabricated_url') throw new Error(`a 404 was scored as ${gone.reason}`);

  return 'unreachable, quote_absent and fabricated_url are told apart';
});

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

await paid('capture from text', async () => {
  const { capture } = await captureFromText('برو در مورد آیین میترائیسم تحقیق کن و منبع معتبر بده');
  if (capture.kind !== 'research') throw new Error(`expected research, got ${capture.kind}`);
  if (!capture.transcript) throw new Error('empty transcript');
  return `kind=${capture.kind}`;   // paid() adds the cost
});

await paid('capture does not invent a request', async () => {
  const { capture } = await captureFromText('امروز هوا خیلی سرد بود و حوصله نداشتم');
  if (capture.request) throw new Error(`invented a request: "${capture.request}"`);
  return `kind=${capture.kind} · request=null`;
});

// capture once read config directly, so changing the model from inside the bot changed
// everything except the thing voice notes actually go through.
await check('capture uses the model the settings name', async () => {
  const s = await import('../src/settings.js');
  const before = store.getSetting('model.capture');
  s.setModel('capture', 'test/definitely-not-a-model');
  try {
    await captureFromText('سلام');
    throw new Error('a nonexistent model somehow succeeded — the setting was ignored');
  } catch (err) {
    if (!/definitely-not-a-model/.test(err.message)) {
      throw new Error(`the setting was ignored; error names a different model: ${err.message.slice(0, 120)}`);
    }
  } finally {
    store.setSetting('model.capture', before ?? '');
    if (!before) store.setSetting('model.capture', config.models.capture);
  }
  return 'the runtime setting reaches the voice path';
});

await check('spend is recorded per model, not just as a total', async () => {
  const { recordSpend, spend } = await import('../src/llm.js');
  const before = store.spendTotal(1).toman;
  try {
    recordSpend({ total_cost_toman: 120, prompt_tokens: 30 }, { model: 'check/embed-x', kind: 'embed' });
    recordSpend({ total_cost_toman: 880, prompt_tokens: 90 }, { model: 'check/chat-x', kind: 'chat' });

    const rows = store.spendByModel(1);
    const embed = rows.find((r) => r.model === 'check/embed-x');
    const chat = rows.find((r) => r.model === 'check/chat-x');
    if (!embed || !chat) throw new Error('a recorded call did not come back');
    if (embed.kind !== 'embed') throw new Error(`kind was ${embed.kind}`);
    if (Math.round(store.spendTotal(1).toman - before) !== 1000) throw new Error('the total does not add up');
    // Sorted by cost, so the biggest line is the one to act on first.
    if (rows[0].toman < rows.at(-1).toman) throw new Error('rows are not ordered by spend');
  } finally {
    // These are bookkeeping fixtures, not calls anyone paid for. They come back out of
    // both the meter and the table, so the free run's ceiling still measures real money
    // and /spend never shows a figure nobody was charged.
    store.forgetSpend('check/embed-x');
    store.forgetSpend('check/chat-x');
    spend.toman -= 1000;
    spend.calls -= 2;
  }
  return 'by model and kind, ordered by cost';
});

await check('transcription route can be switched off', async () => {
  const s = await import('../src/settings.js');
  const before = store.getSetting('model.transcribe');
  try {
    s.setModel('transcribe', 'openai/whisper-large-v3');
    if (transcriptionModel() !== 'openai/whisper-large-v3') throw new Error('setting did not stick');
    s.setModel('transcribe', 'none');
    if (transcriptionModel() !== null) throw new Error('"none" did not disable the route');
  } finally {
    store.setSetting('model.transcribe', before ?? config.models.transcribe);
  }
  return 'on, then off';
});

if (process.argv.includes('--audio')) {
  // node scripts/check.js --audio path/to/voice.ogg
  const sample = process.argv[process.argv.indexOf('--audio') + 1] ?? process.env.SAMPLE_AUDIO;
  await paid('capture from real voice note', async () => {
    if (!sample) throw new Error('pass a path: --audio path/to/voice.ogg');
    if (!fs.existsSync(sample)) throw new Error(`not found: ${sample}`);
    const { capture, route } = await captureFromAudio(fs.readFileSync(sample));
    if (!capture.transcript) throw new Error('empty transcript');
    console.log(`        «${capture.transcript.slice(0, 90)}…»`);
    return `${route} · kind=${capture.kind}`;
  });
}

const total = spendSince(freeStart);
const toman = Math.round(total.toman);

console.log('');
if (PAID) {
  console.log(`  spent ${toman.toLocaleString('en-US')} toman across ${total.calls} model call(s)`);
} else {
  console.log(`  ${skipped} check(s) that call a model were skipped — run with --paid before a release`);
  console.log(`  this run spent ${toman.toLocaleString('en-US')} toman` +
    (total.calls ? ` (${total.calls} call(s), embeddings only)` : ''));

  // Without this the split rots: someone adds a model call to a free check, deploys
  // start costing money again, and nothing says so.
  if (toman > FREE_CEILING_TOMAN) {
    failures++;
    console.log(`  FAIL  the free run spent ${toman} toman, over its ${FREE_CEILING_TOMAN} ceiling —`);
    console.log('        something that calls a model belongs in paid(), not check()');
  }
}

// Printed last, next to the verdict, because "all checks passed" on a machine whose
// semantic search is gone is a true sentence that misleads.
if (degraded.size) {
  console.log('\n  ⚠ working, but degraded — the code handled these, the service did not:');
  for (const { n, line } of degraded.values()) {
    console.log(`      ${line}${n > 1 ? `   (×${n})` : ''}`);
  }
  const svc = [...degraded.keys()];
  if (svc.some((k) => k.startsWith('chunks:'))) {
    console.log('\n      Semantic search is off. Retrieval is keyword-only, which finds exact');
    console.log('      terms and misses paraphrase — worst in Persian, where FTS5 stemming is weak.');
  }
  if (svc.some((k) => k.startsWith('rerank:'))) {
    console.log('      Reranking is off. Retrieval still works; the last precision step is missing.');
  }
}

console.log(failures ? `\n${failures} check(s) failed\n`
  : degraded.size ? '\nchecks passed — read the degraded list above\n'
    : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
