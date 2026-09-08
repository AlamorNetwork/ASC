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
