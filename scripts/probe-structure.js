/**
 * Which model should do the thinking, measured on the thinking it actually does.
 *
 *   node scripts/probe-structure.js
 *   node scripts/probe-structure.js kirafree
 *   node scripts/probe-structure.js kirafree --free openrouter 5
 *
 * `--free <provider> [n]` asks that provider's catalogue which free models it serves and
 * probes the n roomiest, rather than trusting a list of names — two ids suggested from
 * memory came back 404 because they were names a setup script knows, not ids that
 * endpoint serves.
 *
 * `structure` is called dozens of times per investigation, so it is the role where
 * latency is not a comfort question — it is the whole cost of an investigation in time,
 * and it is what left a PDF sitting on «استخراج ادعاها…» for four minutes.
 *
 * But fast is not the requirement, it is the tiebreaker. Two things have to hold first:
 *
 *   The reply has to be JSON. Every caller of this role goes through chatJson, so a
 *   model that writes a thoughtful paragraph fails exactly as completely as one that
 *   times out, and more expensively, because it answered.
 *
 *   It has to notice when the corpus uses a different word than the question. That is
 *   the one judgement multi-hop search is built on — investigate.js calls it "the most
 *   important thing you do" — and a model can return perfect JSON while never once
 *   looking up from the words it was handed. So the fixture below hides the answer
 *   behind a synonym: the question says «آیین مهر», every passage says «میترائیسم», and
 *   a model earns the mark only by reporting that shift as the lead.
 */
import { config } from '../src/config.js';
import { chatJson, DEFAULT_BUDGET_MS } from '../src/llm.js';
import { planFor, clearCooling, keysAvailable } from '../src/providers.js';
import { modelFor } from '../src/settings.js';

const ASSESS_SYSTEM = `از پاساژهای زیر برای جواب دادن به پرسش استفاده کن. فقط JSON بده، بدون code fence:

{
  "enough": false,
  "lead": "مهم‌ترین سرنخی که از این پاساژها گرفتی — مثلاً اینکه سند به‌جای فلان واژه از بهمان واژه استفاده می‌کند. اگر سرنخی نبود null",
  "missing": "چه چیزی هنوز کم است",
  "next_queries": ["عبارت‌های بعدی بر پایه‌ی همین سرنخ"]
}

قواعد:
- enough را وقتی true کن که پاساژها برای جواب دادن کافی‌اند.
- اگر پاساژها نشان می‌دهند سند اصطلاح دیگری به کار می‌برد، آن را به‌عنوان lead بنویس و next_queries را از همان بساز. این مهم‌ترین کار توست.
- اگر هیچ ربطی پیدا نشد و سرنخی هم نیست، enough را true کن و next_queries را خالی بگذار.`;

// The claim pass, which is the call that actually stalled. Same role, same chatJson,
// but a different order of magnitude of input — and that turned out to be the variable
// that separates "answers in seven seconds" from "silent for two minutes".
const CLAIMS_SYSTEM = `از متن زیر ادعاهای مشخص استخراج کن. فقط JSON بده، بدون توضیح و بدون code fence:

{
  "summary": "دو تا سه جمله فارسی: این سند چیست و چه می‌گوید",
  "claims": [
    { "text": "یک ادعای مشخص، به فارسی",
      "quote": "عین همان جمله از متن، کلمه‌به‌کلمه، بدون ترجمه و بدون تغییر" }
  ]
}

قواعد:
- quote باید عیناً از متن کپی شود. خودکار تطبیق داده می‌شود و بازنویسی رد می‌شود.
- چیزی که در متن نیست ننویس.
- حداکثر ۱۰ ادعای مهم.`;

/**
 * A document of a realistic size, every sentence different.
 *
 * Padding with a repeated paragraph would make the quote test meaningless — any sentence
 * would appear many times and a model could "quote" without having read anything. Each
 * paragraph here carries its own number and its own facts, so a quote that matches was
 * copied from one specific place.
 */
function longDocument(targetChars) {
  const parts = [
    'پژوهش درباره‌ی آیین‌های رازآمیز در دوران باستان با دشواری منابع روبه‌روست.',
    'کتیبه‌ها اغلب ناقص‌اند و بخش بزرگی از آن‌ها در آتش‌سوزی‌های متأخر از میان رفته است.',
    'باستان‌شناسان بر سر تاریخ‌گذاری لایه‌های زیرین هم‌نظر نیستند.',
    'سفال‌های یافت‌شده در لایه‌ی چهارم با نمونه‌های شناخته‌شده‌ی منطقه تفاوت دارند.',
    'گزارش‌های سفرنامه‌نویسان سده‌ی نوزدهم را باید با احتیاط خواند.',
    'نقشه‌های آن دوره مقیاس ثابتی ندارند و فاصله‌ها را اغلب اغراق‌آمیز نشان می‌دهند.',
  ];
  const out = [];
  let n = 1;
  let size = 0;
  while (size < targetChars) {
    const p = `بند ${n}: ${parts[n % parts.length]} در بررسی شماره‌ی ${n} این نکته بار دیگر تأیید شد.`;
    out.push(p);
    size += p.length + 2;
    n++;
  }
  // Planted last so it cannot be reached by reading only the opening — the sample sent
  // to a model keeps the head and the tail, and this is how we learn the tail arrived.
  out.push('یافته‌ی کلیدی: مهرابه‌ی کشف‌شده در دهکده‌ی سرخ‌آباد دارای سه سکوی سنگی متمایز است.');
  return out.join('\n\n');
}

const DOC = longDocument(38000);

const CASES = [
  {
    name: 'lead',
    // The question asks about «آیین مهر»; nothing in the corpus uses that phrase. The
    // only way forward is to notice that the passages say «میترائیسم» instead.
    question: 'آیین مهر چه بود و چه کسانی آن را می‌پرستیدند؟',
    passages: [
      'در متون لاتین این کیش با نام میترائیسم شناخته می‌شود و معابد زیرزمینی آن میترائوم نام دارد.',
      'میترائیسم در سده‌ی دوم میلادی میان لژیون‌های رومی گسترش یافت.',
      'کتیبه‌های میترائوم‌ها بیشتر به لاتین و گاه به یونانی نوشته شده‌اند.',
    ],
    // Earned only by naming the word the corpus uses, not by producing a tidy shape.
    wants: (d) => /میترائیسم|میترا|mithra/i.test(
      `${d.lead ?? ''} ${(d.next_queries ?? []).join(' ')}`),
    why: 'باید بفهمد متن به‌جای «آیین مهر» می‌گوید «میترائیسم»',
  },
  {
    name: 'stop',
    // Nothing here is about the question, and there is no thread to pull. Saying so is
    // the right answer; inventing a lead spends another round on nothing.
    question: 'قیمت مسکن در تهران در سال ۱۴۰۲ چقدر بود؟',
    passages: [
      'بارش باران در استان گیلان طی هفته‌ی گذشته افزایش یافت.',
      'مسابقات شنای نوجوانان در اصفهان برگزار شد.',
    ],
    wants: (d) => d.enough === true && (d.next_queries ?? []).length === 0,
    why: 'باید بایستد، نه اینکه دور بعد را روی هیچ خرج کند',
  },
  {
    name: 'long',
    // The call that stalled. Everything above fits in a few hundred characters; the
    // claim pass sends up to forty thousand, and a model behind a gateway combo can
    // answer the first two in seconds and then go silent on this one — either because it
    // is genuinely slower on a long prompt, or because the gateway is walking past
    // members whose context window cannot hold it. Either way the role is unusable for
    // documents, and nothing measured that until now.
    system: CLAIMS_SYSTEM,
    content: `سند «گزارش کاوش»:\n\n${DOC}`,
    maxTokens: 3000,
    // The quote is the whole point: a claim whose quote is not verbatim in the document
    // is rejected by verify, so a model that paraphrases produces nothing usable no
    // matter how sensible it sounds.
    wants: (d) => Array.isArray(d.claims) && d.claims.length > 0
      && d.claims.some((c) => c.quote && DOC.includes(String(c.quote).trim())),
    shown: (d) => `${(d.claims ?? []).length} ادعا · ${(d.claims ?? []).filter((c) => c.quote && DOC.includes(String(c.quote).trim())).length} نقل‌قول دقیق`,
    why: 'باید دست‌کم یک نقل‌قول عیناً از متن کپی کند، وگرنه هیچ ادعایی تأیید نمی‌شود',
  },
];

/**
 * Every free model a provider serves that could plausibly do this job.
 *
 * Asked for rather than remembered: two model ids I suggested from memory came back 404
 * because they were names the setup script knows, not ids that endpoint serves. The
 * catalogue is the only thing that knows.
 *
 * The context filter is not tidiness. The claim pass sends a document — the fixture here
 * is 38,000 characters, which is somewhere north of 12,000 tokens of Persian before the
 * system prompt and the room to answer. A model whose window cannot hold that fails the
 * long case by construction, and finding that out costs a minute each. So they are
 * excluded up front and counted, because "there were none" and "there were nine that
 * cannot hold a document" are different answers.
 */
const NEEDED_CONTEXT = 32768;

async function freeModelsOn(name, limit) {
  const provider = config.providers.get(name);
  if (!provider) throw new Error(`ارائه‌دهنده‌ی «${name}» تعریف نشده — با /provider اضافه‌اش کن`);

  const res = await fetch(`${provider.base}/models`, {
    headers: { Authorization: `Bearer ${provider.keys[0]}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`کاتالوگ ${name}: HTTP ${res.status}`);
  const all = (await res.json()).data ?? [];

  const free = all.filter((m) => /(:free|-free)$/.test(m.id));
  const roomy = free.filter((m) =>
    Math.max(m.context_length ?? 0, m.top_provider?.context_length ?? 0) >= NEEDED_CONTEXT);

  console.log(`${name}: ${all.length} مدل، ${free.length} رایگان، ${roomy.length} با کانتکست ≥ ${(NEEDED_CONTEXT / 1024).toFixed(0)}k`);
  if (free.length && !roomy.length) {
    console.log(`  ⚠ هیچ مدل رایگانی پنجره‌ی کافی برای یک سند ندارد؛ برای برنامه‌ریزی بله، برای خواندن فایل نه.`);
  }

  // Widest window first: this role's hard case is the long one, and among free models
  // that is the axis they actually differ on.
  roomy.sort((a, b) =>
    Math.max(b.context_length ?? 0, b.top_provider?.context_length ?? 0)
    - Math.max(a.context_length ?? 0, a.top_provider?.context_length ?? 0));

  return roomy.slice(0, limit).map((m) => `${m.id}@${name}`);
}

// `kirafree --free openrouter 3` means: that model, plus the three roomiest free models
// openrouter serves. Everything that is not part of a --free clause is a spec.
const argv = process.argv.slice(2);
const specs = [];
const discover = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--free') { specs.push(argv[i]); continue; }
  const name = argv[++i];
  if (!name) {
    console.log('\n  node scripts/probe-structure.js --free openrouter [تعداد]\n');
    process.exit(1);
  }
  const limit = Number(argv[i + 1]);
  if (Number.isFinite(limit)) i++;
  discover.push({ name, limit: Number.isFinite(limit) ? limit : 5 });
}

if (discover.length) console.log('');
for (const { name, limit } of discover) {
  try {
    specs.push(...await freeModelsOn(name, limit));
  } catch (err) {
    console.log(`✖ ${err.message}`);
  }
}

// modelFor, not config: the setting in the database is what the bot actually uses, and
// probing the .env value would measure a model that nothing calls.
if (!specs.length) specs.push(...[modelFor('structure')].filter(Boolean));

if (!specs.length) {
  console.log('\nهیچ مدلی داده نشد و نقش structure هم خالی است.\n');
  console.log('  node scripts/probe-structure.js kirafree');
  console.log('  node scripts/probe-structure.js --free openrouter 5\n');
  process.exit(0);
}

console.log(`\n${CASES.length} judgement(s) per model — the ones this role is actually asked for,`);
console.log(`the last on a ${DOC.length.toLocaleString('en-US')}-character document, which is the call that stalled\n`);

const results = [];
for (const spec of specs) {
  // Free tiers are rate limited per key, and a 429 rests that key for a minute — which
  // is right for the bot and wrong here, because the next model measured would come back
  // "all keys are resting" and be recorded as broken when it was never asked. Each
  // candidate is measured on its own merits, so the cool-offs are cleared between them.
  clearCooling();

  const links = planFor(spec, config.providers);
  console.log(`── ${spec}${links.length > 1 ? `  (${links.length} links)` : ''}`);
  if (!links.length) { console.log('   ✖ به هیچ ارائه‌دهنده‌ای وصل نیست\n'); continue; }

  let won = 0;
  let json = 0;
  let cost = 0;
  const times = [];
  const per = new Map();
  let died = null;

  for (const c of CASES) {
    const t0 = Date.now();
    try {
      const { data, usage } = await chatJson({
        model: spec,
        system: c.system ?? ASSESS_SYSTEM,
        content: c.content
          ?? `پرسش: ${c.question}\n\nپاساژها:\n${c.passages.map((p, i) => `[${i + 1}] ${p}`).join('\n')}`,
        maxTokens: c.maxTokens ?? 700,
        noThinking: false,
        // A probe that can sit for four minutes per model is not a probe you run. The
        // long case gets the real ceiling, because being slower there is the finding.
        budgetMs: c.name === 'long' ? DEFAULT_BUDGET_MS : 60000,
      });
      const ms = Date.now() - t0;
      times.push(ms);
      per.set(c.name, { ms, ok: null });
      json++;
      cost += usage.costToman ?? 0;

      const right = Boolean(c.wants(data));
      if (right) won++;
      per.get(c.name).ok = right;
      const shown = c.shown ? c.shown(data)
        : c.name === 'lead' ? (data.lead ?? '—')
          : `enough=${data.enough} · ${(data.next_queries ?? []).length} query`;
      console.log(`   ${right ? '✅' : '✖ '} ${c.name.padEnd(5)} ${String(ms).padStart(6)}ms  ${String(shown).slice(0, 54)}`);
      if (!right) console.log(`      ↳ ${c.why}`);
    } catch (err) {
      const ms = Date.now() - t0;
      times.push(ms);
      per.set(c.name, { ms, ok: false, err: err.message });
      died = err.message;
      console.log(`   ✖  ${c.name.padEnd(5)} ${String(ms).padStart(6)}ms  ${err.message.replace(/\s+/g, ' ').slice(0, 90)}`);

      // Once the key itself is out of play, the remaining cases cannot be asked — they
      // would each fail in a millisecond with "all keys are resting" and be tallied as
      // separate failures. Reporting 0/3 for one refusal overstates what was measured.
      if (links.every(({ provider }) => !keysAvailable(provider).length)) {
        console.log(`   ↳ کلید از دسترس خارج شد؛ ${CASES.length - times.length} حالت باقی‌مانده پرسیده نشد.`);
        break;
      }
    }
  }

  const slowest = times.length ? Math.max(...times) : 0;
  results.push({
    spec, won, json, cost, links: links.length, long: per.get('long') ?? null, times,
    avg: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    slowest, died,
  });
  console.log(`   ${won}/${CASES.length} right · ${json}/${CASES.length} parsed as JSON` +
    `${cost ? ` · ${Math.round(cost).toLocaleString('fa-IR')} تومان` : ' · free'}\n`);
}

if (!results.length) { console.log('Nothing answered.\n'); process.exit(0); }

// JSON first, because a role reached only through chatJson cannot use anything else;
// then judgement; then speed, which is what breaks the bot when the first two are equal.
results.sort((a, b) => b.json - a.json || b.won - a.won || a.avg - b.avg);

console.log('─'.repeat(78));
console.log('model'.padEnd(34) + 'json'.padStart(7) + 'right'.padStart(7) + 'short'.padStart(10) + `${(DOC.length / 1000).toFixed(0)}k doc`.padStart(11));
console.log('─'.repeat(78));
for (const r of results) {
  // The short cases and the long one are reported apart rather than averaged together.
  // Averaging is what hid this in the first place: a model that answers a paragraph in
  // seven seconds and a document in a hundred and twenty has one number that describes
  // neither, and it is the second one that decides whether documents work at all.
  const shortMs = r.times.filter((_, i) => CASES[i]?.name !== 'long');
  const shortAvg = shortMs.length ? Math.round(shortMs.reduce((a, b) => a + b, 0) / shortMs.length) : 0;
  const long = r.long
    ? `${(r.long.ms / 1000).toFixed(1)}s${r.long.ok === false ? ' ✖' : ''}`
    : '—';
  console.log(r.spec.slice(0, 33).padEnd(34) +
    `${r.json}/${CASES.length}`.padStart(7) + `${r.won}/${CASES.length}`.padStart(7) +
    `${shortAvg}ms`.padStart(10) + long.padStart(11));
}
console.log('─'.repeat(78));

const usable = results.filter((r) => r.json === CASES.length);
if (!usable.length) {
  console.log(`\n⚠ هیچ‌کدام در هر ${CASES.length} حالت JSON برنگرداندند. این نقش فقط از راه chatJson`);
  console.log('  صدا زده می‌شود، پس مدلی که گاهی متن می‌دهد اینجا قابل استفاده نیست.');

  // A model that handles a paragraph and not a document is not simply worse — it is
  // usable for planning and unusable for reading a file, which are different settings.
  const shortOnly = results.filter((r) => r.long && r.long.ok !== true && r.json >= CASES.length - 1);
  if (shortOnly.length) {
    console.log('\n  اما این‌ها کوتاه‌ها را جواب دادند و فقط روی سند بلند افتادند:');
    for (const r of shortOnly) console.log(`    ${r.spec} — ${r.long.err ? r.long.err.slice(0, 60) : `${(r.long.ms / 1000).toFixed(0)}s`}`);
    console.log('  یعنی برای برنامه‌ریزی به درد می‌خورند و برای خواندن سند نه.');
  }
  console.log('');
  process.exit(0);
}

const best = usable[0];
console.log(`\n  /model structure ${best.spec}`);

// The chain is only worth having if its links fail separately. Two free models on one
// provider share a key, a rate limit and an outage — kiraai's availability changed
// completely between two probe runs minutes apart — so a chain of those is one link
// wearing a hat. And since the last link now gets whatever is left of the budget, it is
// the one that should be reliable rather than cheap.
const providersUsed = new Set(usable.map((r) => (r.spec.split('@')[1] ?? 'default')));
if (providersUsed.size < 2) {
  console.log('\n⚠ همه‌ی این‌ها روی یک ارائه‌دهنده‌اند. زنجیره وقتی ارزش دارد که حلقه‌هایش');
  console.log('  جدا از هم خراب شوند؛ دو مدل رایگان روی یک کلید با هم بالا و با هم پایین');
  console.log('  می‌روند. یک مدل از جای دیگر هم امتحان کن.');
}

const bestShort = best.times.filter((_, i) => CASES[i]?.name !== 'long');
const shortAvg = Math.round(bestShort.reduce((a, b) => a + b, 0) / (bestShort.length || 1));
console.log(`\nهر تحقیق ده‌ها بار این نقش را صدا می‌زند، پس ${shortAvg}ms یعنی حدود`);
console.log(`${(shortAvg * 30 / 1000).toFixed(0)} ثانیه فقط فکر کردن در یک تحقیق سی‌مرحله‌ای.`);

if (best.long) {
  console.log(`\nروی سند ${(DOC.length / 1000).toFixed(0)} هزار کاراکتری: ${(best.long.ms / 1000).toFixed(1)} ثانیه` +
    `${best.long.ok ? '' : ' — و نتیجه‌اش به درد نخورد'}.`);
  if (best.long.ms > 60000) {
    console.log('این همان فراخوانی است که سند را نگه می‌دارد. اگر خیلی از سقف فاصله ندارد،');
    console.log('برای نقش structure یک مدل با کانتکست بزرگ‌تر بگذار، یا سند را کوچک‌تر بفرست.');
  }
}
console.log(`\nسقف هر فراخوانی ${DEFAULT_BUDGET_MS / 1000} ثانیه است — هرچه بالاتر از آن، خطا می‌شود.\n`);
