/**
 * Whether an embedding model understands Persian.
 *
 *   node scripts/probe-embed.js
 *   node scripts/probe-embed.js baai/bge-m3@openrouter nvidia/nemotron-3-embed-1b:free@openrouter
 *
 * This is the one component that fails silently. A reranker that is down announces
 * itself; a model that cannot embed Persian returns vectors quite happily, retrieval
 * just quietly finds worse passages, and nothing anywhere says so.
 *
 * So the test is the job: keyword search already handles the words that match. The only
 * reason to embed at all is to find the passage that says the same thing in different
 * words. Every pair below is a Persian paraphrase sharing almost no vocabulary with its
 * query, against a decoy that shares more words while meaning something else — which is
 * precisely the case keyword search gets wrong and an embedding is supposed to get right.
 */
import { config } from '../src/config.js';
import { endpointFor } from '../src/llm.js';

const CASES = [
  {
    query: 'آیین مهر چه بود؟',
    right: 'میترائیسم کیشی رازآمیز بود که سربازان رومی آن را می‌پرستیدند.',
    decoy: 'آیین نامه‌ی جدید شهرداری درباره‌ی مهر و موم اسناد اداری.',
  },
  {
    query: 'چطور می‌توانم هزینه‌ها را کم کنم؟',
    right: 'راه‌های صرفه‌جویی در مخارج ماهانه و کاهش مصرف.',
    decoy: 'هزینه‌ی بلیط هواپیما در نوروز افزایش چشمگیری داشت.',
  },
  {
    query: 'نویسنده درباره‌ی دیالوگ چه می‌گوید؟',
    right: 'در این فصل، شیوه‌ی نوشتن گفت‌وگوی شخصیت‌ها بررسی می‌شود.',
    decoy: 'دیالوگ میان دو کشور بر سر مرزهای آبی ادامه دارد.',
  },
  {
    query: 'خاستگاه ایرانی این کیش',
    right: 'ریشه‌های این باور به پیش از زرتشت در فلات ایران بازمی‌گردد.',
    decoy: 'خاستگاه رودخانه در کوه‌های شمالی کشور قرار دارد.',
  },
];

const specs = process.argv.slice(2).length ? process.argv.slice(2) : [
  'baai/bge-m3@openrouter',
  'nvidia/nemotron-3-embed-1b:free@openrouter',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free@openrouter',
  'liquid/lfm-2.5-embedding-350m:free@openrouter',
];

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

console.log(`\n${CASES.length} Persian paraphrase pairs, each against a decoy that shares more words\n`);

const results = [];
for (const spec of specs) {
  const { model, base, key } = endpointFor(spec);
  process.stdout.write(`── ${spec}\n`);
  const t0 = Date.now();
  try {
    const input = CASES.flatMap((c) => [c.query, c.right, c.decoy]);
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(60000),
    });
    const raw = await res.text();
    if (!res.ok) { console.log(`   ✖ ${res.status}  ${raw.replace(/\s+/g, ' ').slice(0, 110)}\n`); continue; }

    const json = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
    const vecs = (json.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vecs.length !== input.length) { console.log(`   ✖ asked for ${input.length} vectors, got ${vecs.length}\n`); continue; }

    let won = 0;
    let margin = 0;
    for (let i = 0; i < CASES.length; i++) {
      const [q, r, d] = [vecs[i * 3], vecs[i * 3 + 1], vecs[i * 3 + 2]];
      const sr = cosine(q, r), sd = cosine(q, d);
      if (sr > sd) won++;
      margin += sr - sd;
      console.log(`   ${sr > sd ? '✅' : '✖ '} «${CASES[i].query.slice(0, 32)}»  right ${sr.toFixed(3)}  decoy ${sd.toFixed(3)}`);
    }
    const cost = Math.round(json.usage?.total_cost_toman ?? 0);
    results.push({ spec, won, margin: margin / CASES.length, dims: vecs[0].length, ms: Date.now() - t0, cost });
    console.log(`   ${won}/${CASES.length} · ${vecs[0].length} dims · ${Date.now() - t0}ms${cost ? ` · ${cost} toman` : ' · free'}\n`);
  } catch (err) {
    console.log(`   ✖ ${String(err.cause?.code ?? err.message).slice(0, 90)}\n`);
  }
}

if (!results.length) { console.log('Nothing answered.\n'); process.exit(0); }

results.sort((a, b) => b.won - a.won || b.margin - a.margin);
console.log('─'.repeat(78));
console.log('model'.padEnd(48) + 'right'.padStart(7) + 'margin'.padStart(9) + 'dims'.padStart(7));
console.log('─'.repeat(78));
for (const r of results) {
  console.log(r.spec.slice(0, 47).padEnd(48) + `${r.won}/${CASES.length}`.padStart(7) +
    r.margin.toFixed(3).padStart(9) + String(r.dims).padStart(7));
}
console.log('─'.repeat(78));

const best = results[0];
console.log(`\nmargin is how far it puts the paraphrase ahead of the decoy. Above about 0.05`);
console.log('is a model that is actually reading Persian; near zero means it is guessing.');

if (best.won < CASES.length) {
  console.log(`\n⚠ Even the best got ${best.won} of ${CASES.length}. Semantic search will be weak in`);
  console.log('  Persian whichever of these you pick — worth paying for one that is not.');
} else {
  console.log(`\n  /model embed ${best.spec}`);
}
console.log('\nChanging this model invalidates every vector already stored — they only mean');
console.log('anything against others from the same model. After switching:  node scripts/reembed.js --run\n');
