/**
 * Reranking.
 *
 * Everything else in the retrieval stack is about finding candidates at scale. This is
 * about which of them actually answer the question, and it is the one step whose value
 * does not depend on how much data there is — it helps as much at five hundred chunks
 * as at a million.
 *
 * A cross-encoder reads the question and each passage together, so it catches relevance
 * that an embedding blurs. That matters more in Persian, where the embedding half of the
 * search is the weaker one.
 *
 * If the endpoint has no reranker, retrieval carries on with the fused order — a missing
 * reranker should cost precision, not the answer.
 */
import { config } from './config.js';
import { routerFetch } from './llm.js';
import { getSetting } from './db.js';

const model = () => getSetting('model.rerank') ?? config.models.rerank;

// Discovered once. A provider without a rerank endpoint should be asked exactly once,
// not on every question.
let available = null;
let shape = null;   // the request form this provider accepted

export const rerankAvailable = () => available;
export const resetRerank = () => { available = null; shape = null; };

/**
 * @param {string} query
 * @param {string[]} documents
 * @returns {Promise<{order:number[], scores:number[], costToman:number}|null>}
 *   null when reranking is unavailable, so the caller keeps its existing order.
 */
export async function rerank(query, documents, { topN = documents.length } = {}) {
  if (available === false || !documents.length) return null;

  const name = model();
  if (!name) { available = false; return null; }

  // Rerank APIs are not standardised the way chat completions are — the path and
  // whether documents are strings or objects both vary by provider. The working
  // combination is found once and then reused.
  const shapes = [
    { path: '/rerank', docs: (d) => d },
    { path: '/rerank', docs: (d) => d.map((text) => ({ text })) },
    { path: '/reranking', docs: (d) => d },
  ];
  const candidates = shape ? [shape] : shapes;

  let raw = null;
  let used = null;

  for (const s of candidates) {
    let res;
    try {
      res = await routerFetch(s.path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.router.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, query, documents: s.docs(documents), top_n: topN }),
      }, { label: `rerank/${name}`, tries: 1, timeoutMs: 30000 });
    } catch (err) {
      console.warn('[rerank] unreachable, keeping fused order:', err.message);
      return null;
    }

    const body = await res.text();
    if (res.ok && /"(results|data)"/.test(body)) { raw = body; used = s; break; }

    // A shape this provider rejects is worth trying the next form of; a real outage
    // is not, and shows up as the same failure on every shape.
    if (res.status !== 404 && res.status !== 400 && res.status !== 422) {
      console.warn(`[rerank] ${res.status}: ${body.slice(0, 160)}`);
      return null;
    }
  }

  if (!raw) {
    available = false;
    console.warn(`[rerank] disabled — ${name} was not accepted in any known request shape`);
    return null;
  }
  shape = used;

  let json;
  try {
    json = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
  } catch {
    console.warn('[rerank] unparseable reply, keeping fused order');
    return null;
  }

  const results = json.results ?? json.data;
  if (!Array.isArray(results) || !results.length) {
    available = false;
    console.warn('[rerank] reply had no results, disabling');
    return null;
  }

  available = true;
  const sorted = [...results].sort(
    (a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0));

  return {
    order: sorted.map((r) => r.index).filter((i) => Number.isInteger(i) && i < documents.length),
    scores: sorted.map((r) => r.relevance_score ?? r.score ?? 0),
    costToman: json.usage?.total_cost_toman ?? 0,
  };
}
