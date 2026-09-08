/**
 * Multi-hop retrieval over a dossier.
 *
 * One search is not research. Asking about "ادیان ابراهیمی" in a book that calls them
 * "دین‌های سامی" returns nothing, and a single-shot system then says "not in the file"
 * when the material is right there under another name.
 *
 * So each hop reads what came back, names what is still missing, and proposes the terms
 * the corpus itself appears to use. The trail is reported as it happens, because a lead
 * is often more useful than the answer — it tells you what the source actually calls
 * the thing you asked about.
 */
import { chatJson } from './llm.js';
import { modelFor } from './settings.js';
import { retrieve } from './chunks.js';
import * as store from './db.js';

const PLAN_SYSTEM = `تو برای جست‌وجو در یک مجموعه سند، کلیدواژه می‌سازی.
فقط JSON بده، بدون توضیح و بدون code fence:

{ "queries": ["...", "...", "..."] }

قواعد:
- دو تا چهار عبارت جست‌وجو بساز.
- به زبان خود سند فکر کن، نه زبان سؤال. اگر سند فارسی قدیمی یا ترجمه است، از واژگان همان دوره استفاده کن.
- مترادف‌ها و نام‌های جایگزین را هم بیاور، چون سند ممکن است اصطلاح دیگری به کار برده باشد.
- عبارت‌ها کوتاه باشند: دو تا چهار کلمه.`;

const ASSESS_SYSTEM = `تو در حال تحقیق در یک مجموعه سند هستی و بعد از هر جست‌وجو تصمیم می‌گیری ادامه بدهی یا نه.
فقط JSON بده، بدون توضیح و بدون code fence:

{
  "enough": false,
  "lead": "مهم‌ترین سرنخی که از این پاساژها گرفتی — مثلاً اینکه سند به‌جای فلان واژه از بهمان واژه استفاده می‌کند. اگر سرنخی نبود null",
  "missing": "چه چیزی هنوز پیدا نشده",
  "next_queries": ["عبارت‌های بعدی بر پایه‌ی همین سرنخ"]
}

قواعد:
- enough را وقتی true کن که پاساژها برای جواب دادن کافی‌اند.
- اگر پاساژها نشان می‌دهند سند اصطلاح دیگری به کار می‌برد، آن را به‌عنوان lead بنویس و next_queries را از همان بساز. این مهم‌ترین کار توست.
- اگر هیچ ربطی پیدا نشد و سرنخی هم نیست، enough را true کن و next_queries را خالی بگذار — دنبال چیزی که نیست نگرد.
- چیزی از خودت اضافه نکن. فقط از همین پاساژها نتیجه بگیر.`;

const summarise = (rows, limit = 12) => rows.slice(0, limit)
  .map((r, i) => `[${i + 1}] ${r.page ? `ص ${r.page} · ` : ''}${r.text.slice(0, 400)}`)
  .join('\n\n');

/**
 * Follows leads through the corpus until it has enough, runs out of leads, or hits
 * the hop limit.
 *
 * @param onStep called with {kind, ...} as it happens: 'searching' | 'found' | 'lead'
 * @returns {{passages, trail, hops, exhausted, costToman}}
 */
export async function investigate({
  principalId, dossierId, question, maxHops = 4, perHop = 6, onStep, searchOtherDossiers = true,
  // The planner is injectable so the loop can be exercised without a model, and so a
  // different search strategy can be dropped in later.
  ask = chatJson,
}) {
  const seen = new Map();
  const trail = [];
  let costToman = 0;
  let exhausted = false;

  // A planner that fails to produce usable JSON must not end the search — the
  // question itself is always a serviceable first query.
  let queries = [question];
  try {
    const plan = await ask({
      model: modelFor('structure'),
      system: PLAN_SYSTEM,
      content: `سؤال: ${question}`,
      maxTokens: 700,
      noThinking: false,
    });
    costToman += plan.usage?.costToman ?? 0;
    if (Array.isArray(plan.data?.queries) && plan.data.queries.length) {
      queries = plan.data.queries.filter((q) => typeof q === 'string' && q.trim()).slice(0, 4);
    }
  } catch (err) {
    console.warn('[investigate] planner unusable, searching with the question itself:', err.message);
  }
  if (!queries.length) queries = [question];

  for (let hop = 1; hop <= maxHops; hop++) {
    await onStep?.({ kind: 'searching', hop, queries });

    const before = seen.size;
    for (const q of queries) {
      const rows = await retrieve({ principalId, dossierId, query: q, limit: perHop });
      for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
    }
    const fresh = seen.size - before;

    const pages = [...seen.values()].slice(before).map((r) => r.page).filter(Boolean);
    await onStep?.({ kind: 'found', hop, fresh, total: seen.size, pages });

    // Nothing new after the first hop means the leads have run dry.
    if (!fresh && hop > 1) { exhausted = true; break; }

    let assess;
    try {
      assess = await ask({
        model: modelFor('structure'),
        system: ASSESS_SYSTEM,
        content: [
          `سؤال: ${question}`,
          `عبارت‌هایی که تا حالا جست‌وجو شد: ${trail.flatMap((t) => t.queries).concat(queries).join(' · ')}`,
          '',
          'پاساژهای پیداشده:',
          summarise([...seen.values()]),
        ].join('\n'),
        maxTokens: 900,
        noThinking: false,
      });
    } catch (err) {
      // Without an assessment there are no further leads, so stop with what we have
      // rather than losing the passages already found.
      console.warn('[investigate] assessment unusable, stopping here:', err.message);
      exhausted = true;
      break;
    }
    costToman += assess.usage?.costToman ?? 0;

    const step = {
      hop,
      queries,
      fresh,
      lead: assess.data?.lead ?? null,
      missing: assess.data?.missing ?? null,
    };
    trail.push(step);
    if (step.lead || step.missing) await onStep?.({ kind: 'lead', ...step });

    const next = Array.isArray(assess.data?.next_queries)
      ? assess.data.next_queries.filter((q) => typeof q === 'string' && q.trim()).slice(0, 4)
      : [];

    if (assess.data?.enough === true || !next.length) break;
    if (hop === maxHops) { exhausted = true; break; }
    queries = next;
  }

  // The leads ran out here, but the answer may sit in another dossier of the user's
  // own — material they already paid to read. Searching their own sources is free
  // and is checked before offering to spend money on the web.
  let elsewhere = [];
  if ((exhausted || !seen.size) && searchOtherDossiers) {
    const scope = new Set(store.dossierScope(principalId, dossierId));
    const others = store.listDossiers(principalId, 50)
      .map((d) => d.id).filter((id) => !scope.has(id));

    if (others.length) {
      await onStep?.({ kind: 'widening', count: others.length });
      const terms = [question, ...trail.flatMap((t) => t.queries)].slice(0, 5);
      const hits = new Map();
      for (const t of terms) {
        for (const row of store.searchChunks(principalId, others, t, 8)) {
          if (!hits.has(row.id)) hits.set(row.id, row);
        }
      }
      const byDossier = new Map();
      for (const row of hits.values()) {
        const list = byDossier.get(row.dossier_id) ?? [];
        list.push(row);
        byDossier.set(row.dossier_id, list);
      }
      elsewhere = [...byDossier.entries()].map(([id, rows]) => ({
        dossier: store.getDossier(principalId, id), rows,
      })).filter((e) => e.dossier);

      if (elsewhere.length) await onStep?.({ kind: 'elsewhere', elsewhere });
    }
  }

  return {
    passages: [...seen.values()],
    trail,
    hops: trail.length,
    exhausted,
    costToman,
    elsewhere,
    // True when neither this dossier nor the user's other sources hold it, which is
    // when going to the web is worth offering — but never without being asked.
    notInCorpus: !elsewhere.length && (seen.size === 0 || (exhausted && trail.at(-1)?.missing)),
  };
}

/** Whether this dossier has anything to search at all. */
export const hasCorpus = (principalId, dossierId) =>
  store.dossierDocuments(principalId, dossierId).length > 0;
