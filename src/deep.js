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

/**
 * Spend is the only meaningful brake — it is what the user agreed to and what they
 * care about at the end. The two guards below are not policy; they exist solely to
 * catch the case where the brake itself is broken, and each says so plainly when it
 * fires rather than pretending a limit was reached.
 */
const BLIND_ROUNDS = 3;     // rounds with no usage reported at all — we are flying blind
const MAX_MINUTES = 45;     // a runaway with an unmeasurable cost is a bug, not a feature

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
  // The three collaborators that cost money are injectable, the same way investigate's
  // planner is. Without this the only way to test the guards is to let a run actually
  // spend — which it did, at sixty thousand toman a suite.
  search = investigate, web = runResearch, assess = chatJson,
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
  const startedAt = Date.now();
  const allLeads = [];
  const newClaims = [];

  const overCeiling = () => ceilingUsd !== null && costUsd >= ceilingUsd;
  const minutes = () => (Date.now() - startedAt) / 60000;

  for (;;) {
    // Checked before the round starts, so one that cannot be afforded is never begun.
    if (overCeiling()) { stopped = 'ceiling'; break; }
    if (round >= BLIND_ROUNDS && costUsd === 0 && costToman === 0) { stopped = 'unmeasured'; break; }
    if (minutes() > MAX_MINUTES) { stopped = 'time'; break; }

    round++;
    let freshThisRound = 0;

    // --- the user's own documents, which cost almost nothing to search -----------
    for (const lead of leads.slice(0, 3)) {
      const found = await search({
        principalId, dossierId, question: lead, maxHops: 3,
        onStep: (s) => onNote?.({ round, ...s }),
      });
      costToman += found.costToman ?? 0;
      costUsd += found.costUsd ?? 0;

      for (const p of found.passages) {
        if (!seenChunks.has(p.id)) { seenChunks.add(p.id); freshThisRound++; }
      }
      for (const t of found.trail) if (t.lead) allLeads.push(t.lead);
    }

    // --- the web, which does ---------------------------------------------------
    if (!overCeiling()) {
      await onNote?.({ round, kind: 'web', lead: leads[0] });
      try {
        const online = await web({
          principalId, dossierId, topic: dossier.topic,
          question: [
            leads[0],
            'روی چیزی تمرکز کن که هنوز روشن نشده. آنچه را قبلاً می‌دانیم تکرار نکن.',
          ].join('\n'),
        });
        costToman += online.costToman ?? 0;
        costUsd += online.costUsd ?? 0;

        for (const c of [...(online.output.verified ?? []), ...(online.output.found ?? [])]) {
          const k = claimKey(c);
          if (k && !seenClaims.has(k)) { seenClaims.add(k); newClaims.push(c); freshThisRound++; }
        }
      } catch (err) {
        await onNote?.({ round, kind: 'error', message: err.message });
      }
    }

    await onRound?.({ round, fresh: freshThisRound, costToman, costUsd, claims: newClaims.length });

    if (!freshThisRound) { stopped = 'exhausted'; break; }
    if (overCeiling()) { stopped = 'ceiling'; break; }

    // --- what is still open, and what would settle it ---------------------------
    // A run meant to go to exhaustion cannot afford to die on one malformed reply;
    // without an assessment there are simply no further leads.
    let gaps;
    try {
      gaps = await assess({
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
        maxTokens: 1600,
        noThinking: false,
      });
    } catch (err) {
      console.warn('[deep] gap assessment unusable, stopping with what we have:', err.message);
      return finish({}, 'exhausted');
    }
    costToman += gaps.usage?.costToman ?? 0;
    costUsd += gaps.usage?.costUsd ?? 0;

    const next = Array.isArray(gaps.data?.next_leads)
      ? gaps.data.next_leads.filter((l) => typeof l === 'string' && l.trim())
      : [];

    if (!next.length) {
      return finish(gaps.data ?? {}, 'exhausted');
    }
    leads = next;
    await onNote?.({ round, kind: 'nextleads', leads });
  }

  // One last pass to name what is open, even when we stopped for another reason —
  // but only if a round actually ran. A ceiling that forbids the work has to forbid
  // the summary of it too, or "nothing was spent" is a lie told at the caller's expense.
  if (round === 0 || overCeiling()) return finish({}, stopped);

  const final = await assess({
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
  costUsd += final.usage?.costUsd ?? 0;   // was dropped, so the ceiling never saw this call

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
