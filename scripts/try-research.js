import * as store from '../src/db.js';
import { runResearch } from '../src/research.js';

const principalId = 'trial';
const topic = process.argv[2] || 'آیین میترائیسم';
const dossierId = store.insertDossier({ principalId, topic, question: `درباره ${topic} تحقیق کن و منابع معتبر بده` });

const { output, costToman, costUsd } = await runResearch({
  principalId, dossierId, topic,
  question: `درباره ${topic} تحقیق کن و منابع معتبر بده`,
  onProgress: (m) => console.log('   ·', m),
});

console.log('\n──────── SUMMARY ────────\n' + (output.summary || '(none)'));
console.log(`\n──────── VERIFIED (${output.verified.length}) ────────`);
for (const c of output.verified) console.log(`✅ ${c.text}\n   ${c.sourceUrl}`);
console.log(`\n──────── DISPUTED (${output.disputed.length}) ────────`);
for (const d of output.disputed) { console.log(`⚠️  ${d.question}`); for (const s of d.sides ?? []) console.log(`    – ${s.who}: ${s.position}`); }
console.log(`\n──────── FOUND (${output.found.length}) ────────`);
for (const c of output.found) console.log(`📄 ${c.text}\n   ${c.sourceUrl ?? '—'} · ${c.verifyNote}`);
console.log(`\n──────── UNRESOLVED (${output.unresolved.length}) ────────`);
for (const q of output.unresolved) console.log(`❓ ${q}`);
if (output.sourceQualityNote) console.log(`\n⚠️  ${output.sourceQualityNote}`);
console.log(`\n💰 ${Math.round(costToman)} تومان  ($${costUsd.toFixed(4)})`);
