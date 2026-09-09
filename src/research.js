import { chatJson } from './llm.js';
import { verifyClaim } from './verify.js';
import { modelFor, budget } from './settings.js';
import * as store from './db.js';

const GATHER_SYSTEM = `You research a topic and report claims with their sources.

Rules that matter more than completeness:
- Every claim must carry the URL it came from and an EXACT verbatim quote from that page
  supporting it. COPY the span character-for-character from the page — do not retype it from
  memory, do not translate it, do not tidy it. Each quote is fetched and string-matched against
  the live page; a paraphrase is automatically demoted and the claim loses its verification.
  A short exact quote beats a long approximate one.
- Search in whatever language has the best sources for this topic, not the language of the
  question. For scholarly and historical subjects that usually means English academic sources,
  even when the user asked in Persian. Write the claims in Persian regardless.
- Prefer peer-reviewed work, university presses, and specialist encyclopedias over general
  websites and collaborative wikis. Where a topic is known to attract pseudo-scholarship or
  nationalist myth-making, say so in source_quality_note and mark those sources.
- Where reputable sources genuinely disagree, record it as a dispute with the position and
  source on each side. Do not smooth a real scholarly disagreement into one answer.
- Never state a claim you have no source for. List it as an open question instead.

Reply with a JSON object only:
{
  "summary": "2-3 sentences in Persian, describing the state of knowledge, not asserting truth",
  "claims": [
    { "text": "the claim, in Persian",
      "source_url": "https://...",
      "source_title": "...",
      "quote": "exact verbatim span from that page, in its original language" }
  ],
  "disputes": [
    { "question": "what is disputed, in Persian",
      "sides": [ { "position": "...", "who": "...", "source_url": "https://..." } ] }
  ],
  "open_questions": ["...", "..."],
  "source_quality_note": "Persian warning about the source landscape for this topic, or null"
}`;

/**
 * Runs one research episode for a dossier and returns the four-column result.
 * VERIFIED is assigned here by verify.js, never by the model.
 */
export async function runResearch({
  principalId, dossierId, question, topic, onProgress, onSection,
  // Overridable so one question can be run through several models and compared on what
  // actually matters here — how much of what they claim survives verification.
  model = null,
}) {
  const started = Date.now();
  const episodeId = store.startEpisode({ principalId, dossierId, kind: 'research' });
  store.setDossierState(principalId, dossierId, 'running');

  let costUsd = 0;
  let costToman = 0;
  const spend = (usage) => { costUsd += usage.costUsd ?? 0; costToman += usage.costToman ?? 0; };

  try {
    onProgress?.('در حال جست‌وجو…');

    const ask = [
      question ? `سؤال: ${question}` : null,
      topic ? `موضوع: ${topic}` : null,
      'یک دور تحقیق مروری انجام بده و طبق قالب JSON پاسخ بده.',
    ].filter(Boolean).join('\n');

    const gathered = await chatJson({
      model: model ?? modelFor('research'),
      system: GATHER_SYSTEM,
      content: ask,
      maxTokens: 4000,
      noThinking: false, // the gathering pass is the one place thinking earns its cost
    });
    spend(gathered.usage);

    const data = gathered.data ?? {};
    const rawClaims = Array.isArray(data.claims) ? data.claims.slice(0, 12) : [];

    if (data.summary) await onSection?.('summary', { summary: data.summary, topic });
    onProgress?.(`بررسی ${rawClaims.length} ادعا در منابع…`);

    // Verification: fetch each source and check the quote really appears there.
    // Sections are handed out as they finish, so nothing waits for the whole run.
    const verified = [];
    const found = [];
    for (const c of rawClaims) {
      const result = await verifyClaim({ sourceUrl: c.source_url, quote: c.quote });
      const row = {
        text: c.text ?? '',
        sourceUrl: c.source_url ?? null,
        sourceTitle: c.source_title ?? null,
        quote: c.quote ?? null,
        status: result.status,
        verifyMethod: result.method,
        verifyNote: result.note,
        verifyReason: result.reason ?? null,
      };
      store.insertClaim({ principalId, dossierId, episodeId, ...row });
      (result.status === 'verified' ? verified : found).push(row);
      onProgress?.(`بررسی ${verified.length + found.length} از ${rawClaims.length} ادعا…`);
    }

    if (verified.length) await onSection?.('verified', { verified });

    const disputes = Array.isArray(data.disputes) ? data.disputes : [];
    if (disputes.length) await onSection?.('disputed', { disputed: disputes });
    if (found.length) await onSection?.('found', { found });
    if (data.open_questions?.length) await onSection?.('unresolved', { unresolved: data.open_questions });
    for (const d of disputes) {
      store.insertClaim({
        principalId, dossierId, episodeId,
        text: d.question ?? '', status: 'disputed',
        verifyNote: (d.sides ?? []).map((s) => `${s.who}: ${s.position}`).join(' | '),
      });
    }

    const output = {
      summary: data.summary ?? '',
      verified,
      disputed: disputes,
      found,
      unresolved: Array.isArray(data.open_questions) ? data.open_questions : [],
      sourceQualityNote: data.source_quality_note ?? null,
      budgetExceeded: budget() !== null && costUsd > budget(),
    };

    store.finishEpisode(principalId, episodeId, {
      state: output.budgetExceeded ? 'budget_exhausted' : 'succeeded',
      output, costToman, costUsd, durationMs: Date.now() - started,
    });
    store.setDossierState(principalId, dossierId, 'returned');

    return { episodeId, output, costToman, costUsd };
  } catch (err) {
    store.finishEpisode(principalId, episodeId, {
      state: 'failed', output: { error: String(err.message ?? err) },
      costToman, costUsd, durationMs: Date.now() - started,
    });
    store.setDossierState(principalId, dossierId, 'failed');
    throw err;
  }
}
