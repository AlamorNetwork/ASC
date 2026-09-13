/**
 * Which model should do the thinking, measured on the thinking it actually does.
 *
 *   node scripts/probe-structure.js
 *   node scripts/probe-structure.js kirafree qwen3.8-flash-free@openrouter
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
import { planFor } from '../src/providers.js';
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
];

// modelFor, not config: the setting in the database is what the bot actually uses, and
// probing the .env value would measure a model that nothing calls.
const specs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [modelFor('structure')].filter(Boolean);

if (!specs.length) {
  console.log('\nهیچ مدلی داده نشد و نقش structure هم خالی است.\n');
  console.log('  node scripts/probe-structure.js kirafree qwen3.8-flash-free@openrouter\n');
  process.exit(0);
}

console.log(`\n${CASES.length} judgement(s) per model — the ones this role is actually asked for\n`);

const results = [];
for (const spec of specs) {
  const links = planFor(spec, config.providers);
  console.log(`── ${spec}${links.length > 1 ? `  (${links.length} links)` : ''}`);
  if (!links.length) { console.log('   ✖ به هیچ ارائه‌دهنده‌ای وصل نیست\n'); continue; }

  let won = 0;
  let json = 0;
  let cost = 0;
  const times = [];
  let died = null;

  for (const c of CASES) {
    const t0 = Date.now();
    try {
      const { data, usage } = await chatJson({
        model: spec,
        system: ASSESS_SYSTEM,
        content: `پرسش: ${c.question}\n\nپاساژها:\n${c.passages.map((p, i) => `[${i + 1}] ${p}`).join('\n')}`,
        maxTokens: 700,
        noThinking: false,
        // A probe that can sit for four minutes per model is not a probe you run.
        budgetMs: 60000,
      });
      const ms = Date.now() - t0;
      times.push(ms);
      json++;
      cost += usage.costToman ?? 0;

      const right = Boolean(c.wants(data));
      if (right) won++;
      const shown = c.name === 'lead'
        ? (data.lead ?? '—')
        : `enough=${data.enough} · ${(data.next_queries ?? []).length} query`;
      console.log(`   ${right ? '✅' : '✖ '} ${c.name.padEnd(5)} ${String(ms).padStart(6)}ms  ${String(shown).slice(0, 54)}`);
      if (!right) console.log(`      ↳ ${c.why}`);
    } catch (err) {
      const ms = Date.now() - t0;
      times.push(ms);
      died = err.message;
      console.log(`   ✖  ${c.name.padEnd(5)} ${String(ms).padStart(6)}ms  ${err.message.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }

  const slowest = times.length ? Math.max(...times) : 0;
  results.push({
    spec, won, json, cost, links: links.length,
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
console.log('model'.padEnd(40) + 'json'.padStart(7) + 'right'.padStart(7) + 'avg'.padStart(9) + 'worst'.padStart(9));
console.log('─'.repeat(78));
for (const r of results) {
  console.log(r.spec.slice(0, 39).padEnd(40) +
    `${r.json}/${CASES.length}`.padStart(7) + `${r.won}/${CASES.length}`.padStart(7) +
    `${r.avg}ms`.padStart(9) + `${r.slowest}ms`.padStart(9));
}
console.log('─'.repeat(78));

const usable = results.filter((r) => r.json === CASES.length);
if (!usable.length) {
  console.log('\n⚠ هیچ‌کدام در هر دو حالت JSON برنگرداندند. این نقش فقط از راه chatJson صدا');
  console.log('  زده می‌شود، پس مدلی که گاهی متن می‌دهد اینجا قابل استفاده نیست.\n');
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

console.log(`\nهر تحقیق ده‌ها بار این نقش را صدا می‌زند، پس ${best.avg}ms یعنی حدود`);
console.log(`${(best.avg * 30 / 1000).toFixed(0)} ثانیه فقط فکر کردن در یک تحقیق سی‌مرحله‌ای.`);
console.log(`\nسقف هر فراخوانی ${DEFAULT_BUDGET_MS / 1000} ثانیه است — هرچه بالاتر از آن، خطا می‌شود.\n`);
