/**
 * Deep investigation: keep going until the leads are genuinely exhausted.
 *
 * This is not a schedule. It alternates between the user's own documents and the web,
 * feeding what each round finds back in as the next round's leads, and stops only when
 * a full round produces nothing new — no passage, no claim, no lead.
 *
 * The end state that matters is the honest one: a list of what is still open, each with
 * the kind of source that would settle it. That is the point at which the user can hand
 * over a source instead of the system spinning.
 *
 * Running until exhaustion costs money, so a ceiling is agreed before it starts and it
 * stops and asks rather than quietly spending past it.
 */
import { chatJson } from './llm.js';
import { modelFor } from './settings.js';
import { investigate } from './investigate.js';
import { runResearch } from './research.js';
import { normalise } from './verify.js';
import * as store from './db.js';

const MAX_ROUNDS = 12;          // a hard stop even if the model keeps finding leads
const TOMAN_PER_USD = 310000;

const GAPS_SYSTEM = `تو در پایان یک تحقیق، تصمیم می‌گیری چه چیزی هنوز باز مانده و چه چیزی آن را حل می‌کند.
فقط JSON بده، بدون توضیح و بدون code fence:

{
  "answered": ["چیزهایی که حالا روشن شده‌اند"],
  "open": [
    { "question": "چه چیزی هنوز حل نشده",
      "needs": "دقیقاً چه منبعی آن را حل می‌کند — نام کتاب، نوع سند، آرشیو، یا مقاله‌ی مشخص",
      "why": "چرا با جست‌وجوی بیشتر حل نمی‌شود" }
  ],
  "next_leads": ["سرنخ‌هایی که هنوز ارزش دنبال کردن دارند"]
}

قواعد:
- open فقط چیزهایی که واقعاً با جست‌وجوی بیشتر حل نمی‌شوند — نه هر سؤال باقی‌مانده.
- needs باید مشخص باشد. «منابع بیشتر» جواب نیست؛ «متن اصلی کتاب فلان» جواب است.
- اگر هنوز سرنخ قابل دنبال کردن هست، در next_leads بیاور و open را کوچک نگه دار.
- چیزی از خودت نساز. فقط از آنچه در تحقیق دیده شد نتیجه بگیر.`;

const claimKey = (c) => normalise(c.text ?? '').split(' ').slice(0, 10).join(' ');

/**
 * @param onRound called with a progress object after every round
 * @param ceilingUsd stop and report when spend passes this; null means no ceiling
 */
export async function deepInvestigate({
  principalId, dossierId, question, ceilingUsd = 0.5, onRound, onNote,
}) {
  const dossier = store.getDossier(principalId, dossierId);
  if (!dossier) throw new Error('پرونده پیدا نشد');

  const seenChunks = new Set();
  const seenClaims = new Set(
    store.dossierClaims(principalId, dossierId).map(claimKey));

  let costUsd = 0;
  let costToman = 0;
  let leads = [question];
  let round = 0;
  let stopped = 'exhausted';
  const allLeads = [];
  const newClaims = [];

  const overCeiling = () => ceilingUsd !== null && costUsd >= ceilingUsd;

  while (round < MAX_ROUNDS) {
    round++;
    let freshThisRound = 0;

    // --- the user's own documents, which cost almost nothing to search -----------
    for (const lead of leads.slice(0, 3)) {
      const found = await investigate({
        principalId, dossierId, question: lead, maxHops: 3,
        onStep: (s) => onNote?.({ round, ...s }),
      });
      costToman += found.costToman ?? 0;
      costUsd += (found.costToman ?? 0) / TOMAN_PER_USD;

      for (const p of found.passages) {
        if (!seenChunks.has(p.id)) { seenChunks.add(p.id); freshThisRound++; }
      }
      for (const t of found.trail) if (t.lead) allLeads.push(t.lead);
    }

    // --- the web, which does ---------------------------------------------------
    if (!overCeiling()) {
      await onNote?.({ round, kind: 'web', lead: leads[0] });
      try {
        const web = await runResearch({
          principalId, dossierId, topic: dossier.topic,
          question: [
            leads[0],
            'روی چیزی تمرکز کن که هنوز روشن نشده. آنچه را قبلاً می‌دانیم تکرار نکن.',
          ].join('\n'),
        });
        costToman += web.costToman ?? 0;
        costUsd += web.costUsd ?? 0;

        for (const c of [...(web.output.verified ?? []), ...(web.output.found ?? [])]) {
          const k = claimKey(c);
          if (k && !seenClaims.has(k)) { seenClaims.add(k); newClaims.push(c); freshThisRound++; }
        }
      } catch (err) {
        await onNote?.({ round, kind: 'error', message: err.message });
      }
    }

    await onRound?.({ round, fresh: freshThisRound, costToman, claims: newClaims.length });

    if (!freshThisRound) { stopped = 'exhausted'; break; }
    if (overCeiling()) { stopped = 'ceiling'; break; }

    // --- what is still open, and what would settle it ---------------------------
    const gaps = await chatJson({
      model: modelFor('structure'),
      system: GAPS_SYSTEM,
      content: [
        `پرسش اصلی: ${question}`,
        `موضوع پرونده: ${dossier.topic}`,
        '',
        'سرنخ‌هایی که تا حالا دیده شد:',
        allLeads.slice(-10).map((l) => `- ${l}`).join('\n') || '(هیچ)',
        '',
        'یافته‌های تازه‌ی این دور:',
        newClaims.slice(-12).map((c) => `- ${c.text}`).join('\n') || '(هیچ)',
      ].join('\n'),
      maxTokens: 1200,
      noThinking: false,
    });
    costToman += gaps.usage.costToman ?? 0;
    costUsd += (gaps.usage.costToman ?? 0) / TOMAN_PER_USD;

    const next = Array.isArray(gaps.data.next_leads)
      ? gaps.data.next_leads.filter((l) => typeof l === 'string' && l.trim())
      : [];

    if (!next.length) {
      return finish(gaps.data, 'exhausted');
    }
    leads = next;
    await onNote?.({ round, kind: 'nextleads', leads });
  }

  if (round >= MAX_ROUNDS) stopped = 'rounds';

  // One last pass to name what is open, even when we stopped for another reason.
  const final = await chatJson({
    model: modelFor('structure'),
    system: GAPS_SYSTEM,
    content: [
      `پرسش اصلی: ${question}`,
      'یافته‌ها:',
      newClaims.slice(0, 20).map((c) => `- ${c.text}`).join('\n') || '(هیچ)',
    ].join('\n'),
    maxTokens: 1200,
    noThinking: false,
  }).catch(() => ({ data: {}, usage: {} }));
  costToman += final.usage?.costToman ?? 0;

  return finish(final.data, stopped);

  function finish(data, why) {
    return {
      rounds: round,
      stopped: why,
      newClaims,
      answered: Array.isArray(data.answered) ? data.answered : [],
      open: Array.isArray(data.open) ? data.open : [],
      leads: allLeads,
      costToman,
      costUsd,
    };
  }
}
