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
import { isWanted } from './cancel.js';
import { assessEvidence, predictYield, worthSpending, predict, observe } from './metacognition.js';
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
  // How much a thin or wrong answer costs the user. Raises the bar for stopping early.
  stakes = 0.5,
  // Resume an existing run instead of starting one. A ceiling reached is a pause, not
  // an ending: the leads it was about to follow are exactly where it should carry on.
  runId = null,
  // The three collaborators that cost money are injectable, the same way investigate's
  // planner is. Without this the only way to test the guards is to let a run actually
  // spend — which it did, at sixty thousand toman a suite.
  search = investigate, web = runResearch, assess = chatJson,
  persist = true,
}) {
  const dossier = store.getDossier(principalId, dossierId);
  if (!dossier) throw new Error('پرونده پیدا نشد');

  const prior = runId ? store.getInvestigation(principalId, runId) : null;
  if (runId && !prior) throw new Error('این کاوش پیدا نشد');

  const id = prior?.id
    ?? (persist ? store.startInvestigation({ principalId, dossierId, question }) : null);
  if (id) store.clearStop(id);

  const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

  // Passages already counted stay counted, so a resumed run does not report old material
  // as new. Claims need no such list — they are already in the database.
  const seenChunks = new Set(prior ? parse(prior.seen_chunks, []) : []);
  const seenClaims = new Set(
    store.dossierClaims(principalId, dossierId).map(claimKey));

  // Spend carried over, so a new ceiling means "this much more", counted from where the
  // last one stopped rather than starting the budget again.
  let costUsd = prior?.cost_usd ?? 0;
  let costToman = prior?.cost_toman ?? 0;
  let leads = prior ? parse(prior.leads, [question]) : [question];
  let round = prior?.rounds ?? 0;
  const roundsBefore = round;
  let stopped = 'exhausted';
  const startedAt = Date.now();
  const allLeads = prior ? parse(prior.all_leads, []) : [];
  const newClaims = [];
  const roundLog = [];          // what each round actually produced, for the forecast
  let lastVerdict = null;

  // On a resume the new ceiling is an additional allowance, not a new total. Spend is
  // carried over so the report shows what the whole investigation cost, and comparing a
  // fresh ceiling against a carried-over total would stop the run before it began.
  const ceiling = ceilingUsd === null ? null : ceilingUsd + (prior?.cost_usd ?? 0);
  const overCeiling = () => ceiling !== null && costUsd >= ceiling;
  const minutes = () => (Date.now() - startedAt) / 60000;
  const asked = () => (id !== null && store.stopRequested(id)) || isWanted(principalId);

  const save = (state, why) => {
    if (id === null) return;
    store.saveInvestigation(id, {
      state, stopped: why, rounds: round, leads, seenChunks: [...seenChunks],
      allLeads, costToman, costUsd,
    });
  };

  if (prior) await onNote?.({ round, kind: 'resumed', rounds: roundsBefore, leads });

  for (;;) {
    // Checked before the round starts, so one that cannot be afforded is never begun.
    if (overCeiling()) { stopped = 'ceiling'; break; }
    if (asked()) { stopped = 'stopped'; break; }
    if (round >= roundsBefore + BLIND_ROUNDS && costUsd === 0 && costToman === 0) {
      stopped = 'unmeasured'; break;
    }
    if (minutes() > MAX_MINUTES) { stopped = 'time'; break; }

    // Said before the round runs, so it is a real prediction and can be wrong. The
    // outcome is written next to it below, and /calibration reports whether these
    // estimates have been worth anything.
    const forecast = predictYield(roundLog);
    const verdict = worthSpending({
      yieldP: forecast.p,
      evidence: assessEvidence(store.dossierClaims(principalId, dossierId)),
      spentUsd: costUsd,
      ceilingUsd,
      roundCostUsd: roundLog.length ? costUsd / roundLog.length : 0,
      stakes,
    });
    const forecastId = predict(principalId, dossierId, 'round_yields', forecast.p, forecast.basis);

    if (!verdict.spend && roundLog.length >= 2) {
      // Not a safety net firing — a judgement that the next round is not worth its
      // price. It is reported as such, with the reasoning, so it can be argued with.
      await onNote?.({ round, kind: 'notworth', ...verdict, forecast });
      store.settlePrediction(forecastId, 0);
      stopped = 'notworth';
      lastVerdict = verdict;
      break;
    }

    round++;
    let freshThisRound = 0;

    // --- the user's own documents, which cost almost nothing to search -----------
    for (const lead of leads.slice(0, 3)) {
      // Between searches too, so stopping does not mean waiting out the whole round.
      if (asked()) break;
      const found = await search({
        principalId, dossierId, question: lead, maxHops: 3,
        onStep: (s) => onNote?.({ round, ...s }),
        // Not from inside: throwing out of a hop would unwind past the save below and
        // lose the frontier, which is the one thing a deep run must not lose.
        cancellable: false,
      });
      costToman += found.costToman ?? 0;
      costUsd += found.costUsd ?? 0;

      for (const p of found.passages) {
        if (!seenChunks.has(p.id)) { seenChunks.add(p.id); freshThisRound++; }
      }
      for (const t of found.trail) if (t.lead) allLeads.push(t.lead);
    }

    // --- the web, which does ---------------------------------------------------
    // The costly half of the round, so the stop is checked immediately before it.
    if (!overCeiling() && !asked()) {
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

    // Saved every round, so an interruption of any kind — a stop, a crash, a restart —
    // leaves the frontier on disk rather than only in this function's memory.
    // What the forecast said would happen, against what did. This is the only thing
    // that makes the number above worth printing.
    roundLog.push({ round, fresh: freshThisRound });
    observe(forecastId, freshThisRound > 0);

    save('running', null);
    await onRound?.({
      runId: id, round, fresh: freshThisRound, costToman, costUsd, claims: newClaims.length,
      forecast: forecast.p,
    });

    if (asked()) { stopped = 'stopped'; break; }
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
  // A stop is the same case: the user asked for the spending to end, now.
  if (round === roundsBefore || overCeiling() || stopped === 'stopped') return finish({}, stopped);

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
    // Only exhaustion is an ending. A ceiling, a stop, or a guard firing leaves a run
    // that still has somewhere to go, and it is kept so it can go there later.
    const canResume = why !== 'exhausted' && leads.length > 0;
    save(canResume ? 'paused' : 'done', why);

    return {
      runId: id,
      // What the evidence amounts to, and why it stopped if it judged rather than hit a limit.
      evidence: assessEvidence(store.dossierClaims(principalId, dossierId)),
      verdict: lastVerdict,
      rounds: round,
      roundsThisTime: round - roundsBefore,
      resumedFrom: prior ? roundsBefore : 0,
      stopped: why,
      canResume,
      nextLeads: canResume ? leads : [],
      newClaims,
      answered: Array.isArray(data.answered) ? data.answered : [],
      open: Array.isArray(data.open) ? data.open : [],
      leads: allLeads,
      costToman,
      costUsd,
    };
  }
}
