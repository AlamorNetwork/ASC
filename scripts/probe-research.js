/**
 * Runs the same research question through several models and scores them on what this
 * project actually cares about: how much of what they say survives verification.
 *
 *   node scripts/probe-research.js
 *   node scripts/probe-research.js "آیین میترائیسم چه بود؟"
 *   node scripts/probe-research.js "سؤال" qwen/qwen3.7-flash:online google/gemini-3.7-flash:online
 *
 * A cheap model that produces twelve claims of which two verify is worse than an
 * expensive one that produces six of which five do — and cost per claim tells you
 * nothing, while cost per *verified* claim tells you everything. That is the number
 * this reports.
 *
 * This spends real money: one research round per model. Three models on one question is
 * usually a few thousand toman. It is the only honest way to answer the question.
 */
import { config } from '../src/config.js';
import { runResearch } from '../src/research.js';
import * as store from '../src/db.js';

const args = process.argv.slice(2);
const question = args[0] && !args[0].includes('/')
  ? args[0]
  : 'آیین میترائیسم چه بود و پژوهشگران درباره‌ی خاستگاه ایرانی آن چه می‌گویند؟';
const given = args.filter((a) => a.includes('/'));

// A gateway namespaces model ids where a direct provider does not.
const parts = config.models.research.split('/');
const ns = parts.length > 2 ? parts.slice(0, -2).join('/') + '/' : '';

const candidates = given.length ? given : [
  config.models.research,                     // what runs today — the baseline
  `${ns}qwen/qwen3.7-flash:online`,
  `${ns}google/gemini-3.5-flash-lite:online`,
];

console.log(`\n«${question}»\n${config.router.base}\n`);
console.log('Each model researches this once and every quote it gives is fetched and');
console.log('string-matched against the live page. Costs real money.\n');

const results = [];

for (const model of candidates) {
  process.stdout.write(`── ${model}\n`);
  // A throwaway principal per model, so nothing lands in anyone's real dossiers.
  const p = `probe-${Date.now()}`;
  const dossierId = store.insertDossier({ principalId: p, topic: 'سنجش مدل تحقیق' });

  const t0 = Date.now();
  try {
    const out = await runResearch({ principalId: p, dossierId, question, topic: null, model });
    const ms = Date.now() - t0;
    const verified = out.output.verified.length;
    const found = out.output.found;
    const claims = verified + found.length;

    // A page we could not open says nothing about the model. Counting it against one
    // scored a model that cited Encyclopaedia Iranica the same as one that invented a
    // URL, which is the opposite of the truth.
    const unreachable = found.filter((c) => c.verifyReason === 'unreachable').length;
    // A URL that does not exist counts against the model, and hard. Inventing a citation
    // is worse than admitting there isn't one.
    const fake = found.filter((c) => c.verifyReason === 'fabricated_url').length;
    const wrong = found.filter((c) => c.verifyReason === 'quote_absent').length + fake;
    const checkable = claims - unreachable;

    results.push({
      model, ms, claims, verified, unreachable, wrong, fake,
      rate: checkable ? verified / checkable : 0,
      costToman: out.costToman,
      perVerified: verified ? out.costToman / verified : null,
      summary: out.output.summary,
      verifiedClaims: out.output.verified,
      unreachableClaims: found.filter((c) => c.verifyReason === 'unreachable'),
      fakeClaims: found.filter((c) => c.verifyReason === 'fabricated_url'),
      disputes: out.output.disputed.length,
      unresolved: out.output.unresolved.length,
      note: out.output.sourceQualityNote,
    });

    console.log(`   ✅ ${(ms / 1000).toFixed(0)}s · ${Math.round(out.costToman).toLocaleString('en-US')} toman` +
      ` · ${verified}/${claims} verified` +
      (fake ? ` · ⚠ ${fake} invented URL(s)` : '') +
      (unreachable ? ` · ${unreachable} unreachable` : ''));
  } catch (err) {
    console.log(`   ✖  ${String(err.message ?? err).slice(0, 160)}`);
    results.push({ model, failed: String(err.message ?? err) });
  }
}

const ok = results.filter((r) => !r.failed);
if (!ok.length) {
  console.log('\nNothing worked. The failures above are the endpoint\'s own words.\n');
} else {
  report();
}

function report() {
  console.log('\n' + '─'.repeat(92));
  console.log('model'.padEnd(36) + 'toman'.padStart(9) + 'claims'.padStart(8) +
    'verified'.padStart(10) + 'wrong'.padStart(7) + 'invented'.padStart(10) +
    'unreach'.padStart(9) + 'rate'.padStart(7));
  console.log('─'.repeat(92));
  for (const r of ok) {
    console.log(
      r.model.slice(0, 35).padEnd(36) +
      Math.round(r.costToman).toLocaleString('en-US').padStart(9) +
      String(r.claims).padStart(8) +
      String(r.verified).padStart(10) +
      String(r.wrong - r.fake).padStart(7) +
      (r.fake ? `⚠ ${r.fake}` : '0').padStart(10) +
      String(r.unreachable).padStart(9) +
      (Math.round(r.rate * 100) + '%').padStart(7));
  }
  console.log('─'.repeat(92));
  console.log('rate counts only claims we could actually check — unreachable pages are our failure');

  const usable = ok.filter((r) => r.perVerified !== null);
  if (usable.length > 1) {
    const best = usable.reduce((a, b) => (b.perVerified < a.perVerified ? b : a));
    const base = ok[0];
    console.log(`\nCheapest verified claim: ${best.model}` +
      ` at ${Math.round(best.perVerified).toLocaleString('en-US')} toman each.`);
    if (best !== base && base.perVerified) {
      console.log(`That is ${(base.perVerified / best.perVerified).toFixed(1)}× better than ${base.model}.`);
    }
  }

  const liars = ok.filter((r) => r.fake > 0);
  if (liars.length) {
    console.log('\n⚠ INVENTED SOURCES — the worst failure a research model has:');
    for (const r of liars) {
      for (const c of r.fakeClaims) {
        console.log(`   ${r.model.split('/').pop()} → ${c.sourceUrl}`);
      }
    }
    console.log('   These URLs do not exist. A model that fabricates a citation is not');
    console.log('   cheap research at any price — the whole point here is that a claim');
    console.log('   can be traced. Do not use one of these for research.');
  }

  const barren = ok.filter((r) => r.wrong > r.fake && r.verified === 0);
  if (barren.length) {
    console.log(`\n⚠ ${barren.map((r) => r.model).join(', ')} gave quotes that were not on the pages they cited.`);
    console.log('That is not cheap research — it is confident text with nothing behind it.');
  }

  const blocked = ok.filter((r) => r.unreachable > 0);
  if (blocked.length) {
    console.log(`\nⓘ Sources we could not open (not the model's fault):`);
    for (const r of blocked) {
      for (const c of r.unreachableClaims.slice(0, 3)) {
        console.log(`   ${r.model.split('/').pop()} → ${c.sourceUrl}`);
        console.log(`      ${c.verifyNote}`);
      }
    }
    console.log('   A model citing pages our fetcher is blocked from may be choosing');
    console.log('   better sources, not worse ones. Judge those by hand.');
  }

  const noClaims = ok.filter((r) => r.claims === 0);
  if (noClaims.length) {
    console.log(`\n⚠ ${noClaims.map((r) => r.model).join(', ')} returned no claims at all —`);
    console.log('probably not search-grounded on this endpoint. Check for an :online variant.');
  }

  console.log('\n' + '═'.repeat(84));
  console.log('what each one actually stood behind');
  console.log('═'.repeat(84));
  for (const r of ok) {
    console.log(`\n── ${r.model}  (${r.disputes} dispute(s), ${r.unresolved} open)`);
    console.log(r.summary || '(no summary)');
    for (const c of r.verifiedClaims.slice(0, 4)) {
      console.log(`   ✅ ${c.text}`);
      console.log(`      ${c.sourceUrl}`);
    }
    if (!r.verifiedClaims.length) console.log('   (nothing verified)');
  }
  console.log('');
}
