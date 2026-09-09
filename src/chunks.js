/**
 * Chunking, embedding, and retrieval.
 *
 * A document is stored once and read on demand. Answering a question retrieves the
 * few passages that bear on it instead of re-sending the whole document, which is
 * what keeps a 300-page book affordable after the first read.
 *
 * Retrieval is hybrid: FTS5 keyword search and vector similarity, merged by reciprocal
 * rank fusion. Keyword search catches exact terms and names that an embedding blurs;
 * vectors catch paraphrase. Persian needs both — its stemming in FTS5 is weak, and
 * embeddings alone miss literal quotes.
 */
import { config } from './config.js';
import { routerFetch, recordSpend } from './llm.js';
import { rerank } from './rerank.js';
import * as store from './db.js';
import { getSetting } from './db.js';

const EMBED_MODEL = () => getSetting('model.embed') ?? config.models.embed;
const BATCH = 32;

// ------------------------------------------------------------------ chunking

/**
 * Split on paragraph boundaries, packing up to `size` characters, with a little
 * overlap so a sentence spanning a boundary is not lost to both sides.
 */
export function chunkText(text, { size = 1200, overlap = 150 } = {}) {
  const paragraphs = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let current = '';

  const flush = () => {
    if (!current.trim()) return;
    out.push(current.trim());
    current = overlap > 0 ? current.slice(-overlap) : '';
  };

  for (const p of paragraphs) {
    if (p.length > size) {
      flush();
      // A single huge paragraph is cut on sentence ends where possible.
      const sentences = p.split(/(?<=[.!?؟।])\s+/);
      for (const s of sentences) {
        if ((current + ' ' + s).length > size) flush();
        current += (current ? ' ' : '') + s;
      }
      flush();
      continue;
    }
    if ((current + '\n\n' + p).length > size) flush();
    current += (current ? '\n\n' : '') + p;
  }
  flush();
  return out.filter((c) => c.length > 40);
}

// ----------------------------------------------------------------- embedding

const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);
const fromBlob = (buf) =>
  new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

/**
 * Query vectors are cached for the life of the process.
 *
 * A multi-hop investigation embeds the same handful of phrases over and over — the
 * planner reuses terms, and hops repeat queries across dossiers. Each call is another
 * chance to hit a dropped connection on a flaky route, so not making it at all is both
 * cheaper and more reliable than making it well.
 */
const queryCache = new Map();
const QUERY_CACHE_MAX = 500;

const cacheGet = (text) => queryCache.get(text);
function cacheSet(text, vec) {
  if (queryCache.size >= QUERY_CACHE_MAX) {
    queryCache.delete(queryCache.keys().next().value); // oldest out
  }
  queryCache.set(text, vec);
}

export const embedCacheStats = () => ({ size: queryCache.size });

export async function embed(texts) {
  const { key } = config.router;
  const model = EMBED_MODEL();
  const res = await routerFetch('/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  }, { label: `embeddings/${model}` });
  const raw = await res.text();
  if (!res.ok) throw new Error(`embeddings ${res.status} (${model}): ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
  const vectors = (json.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  recordSpend(json.usage);
  return { vectors, costToman: json.usage?.total_cost_toman ?? 0 };
}

/** Embeds whatever in this dossier still has no vector. Safe to call repeatedly. */
export async function embedPending(principalId, dossierId, onProgress) {
  let done = 0;
  let costToman = 0;
  for (;;) {
    const pending = store.chunksWithoutEmbedding(principalId, dossierId, BATCH);
    if (!pending.length) break;
    const { vectors, costToman: c } = await embed(pending.map((p) => p.text));
    costToman += c;
    for (let i = 0; i < pending.length; i++) {
      if (vectors[i]) store.setChunkEmbedding(pending[i].id, toBlob(vectors[i]));
    }
    done += pending.length;
    onProgress?.(done);
    if (pending.length < BATCH) break;
  }
  return { embedded: done, costToman };
}

// ----------------------------------------------------------------- retrieval

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Brute force over one dossier's vectors. At this scale an index would be ceremony. */
export function vectorSearch(principalId, dossierId, queryVec, limit = 20) {
  const q = Float32Array.from(queryVec);
  const scored = [];
  for (const row of store.dossierChunks(principalId, dossierId)) {
    if (!row.embedding) continue;
    scored.push({ ...row, score: cosine(q, fromBlob(row.embedding)) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

/** Reciprocal rank fusion: position in each list matters, raw scores do not. */
function fuse(lists, k = 60) {
  const acc = new Map();
  for (const list of lists) {
    list.forEach((row, i) => {
      const prev = acc.get(row.id) ?? { row, score: 0 };
      prev.score += 1 / (k + i + 1);
      acc.set(row.id, prev);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).map((e) => e.row);
}

/**
 * The passages worth showing a model for this question.
 * Falls back to keyword-only if embedding is unavailable, so retrieval degrades
 * rather than failing.
 */
export async function retrieve({ principalId, dossierId, query, limit = 6, includeLinked = true, rerankPool = 20 }) {
  // Two dossiers can be separate subjects that touch in places, so a linked dossier's
  // passages are searched too — and each result carries which dossier it came from.
  const scope = includeLinked
    ? store.dossierScope(principalId, Array.isArray(dossierId) ? dossierId[0] : dossierId)
    : (Array.isArray(dossierId) ? dossierId : [dossierId]);

  const keyword = store.searchChunks(principalId, scope, query, 20);

  let semantic = [];
  try {
    let vec = cacheGet(query);
    if (!vec) {
      const { vectors } = await embed([query]);
      vec = vectors[0];
      if (vec) cacheSet(query, vec);
    }
    if (vec) semantic = vectorSearch(principalId, scope, vec, 20);
  } catch (err) {
    // Keyword search alone is a worse answer, not a failed one.
    console.warn('[chunks] semantic search unavailable:', err.message);
  }

  const merged = semantic.length ? fuse([keyword, semantic]) : keyword;
  if (!merged.length) return [];

  // Fusion decides which passages are candidates; the reranker decides which of them
  // actually answer the question. Widening the candidate pool before it is what makes
  // the step worth taking — reranking the same six changes little.
  const pool = merged.slice(0, Math.max(limit, rerankPool));
  const ranked = await rerank(query, pool.map((r) => r.text), { topN: limit });
  if (!ranked?.order?.length) return pool.slice(0, limit);

  const picked = ranked.order.map((i) => pool[i]).filter(Boolean);
  // Anything the reranker dropped still beats nothing if it left us short.
  for (const row of pool) {
    if (picked.length >= limit) break;
    if (!picked.includes(row)) picked.push(row);
  }
  return picked.slice(0, limit);
}

/** Renders retrieved passages for a prompt, with their source labelled. */
export function renderPassages(principalId, rows, homeDossierId = null) {
  return rows.map((r, i) => {
    const doc = store.getDocument(principalId, r.document_id);
    const parts = [doc?.filename ?? 'سند'];
    if (r.page) parts.push(`ص ${r.page}`);
    // Mark anything that came from a linked dossier, so its origin is never implicit.
    if (homeDossierId && r.dossier_id && r.dossier_id !== homeDossierId) {
      const d = store.getDossier(principalId, r.dossier_id);
      parts.push(`از پرونده‌ی مرتبط #${r.dossier_id}${d ? ` «${d.topic}»` : ''}`);
    }
    return `[${i + 1}] ${parts.join(' · ')}\n${r.text}`;
  }).join('\n\n');
}

/**
 * Dossiers whose material is closest to this one, by comparing chunk vectors.
 * Used to suggest a link rather than to make one.
 */
export function relatedDossiers(principalId, dossierId, { limit = 5, sample = 40 } = {}) {
  const mine = store.dossierChunks(principalId, dossierId)
    .filter((c) => c.embedding).slice(0, sample);
  if (!mine.length) return [];

  const linked = new Set(store.dossierScope(principalId, dossierId));
  const scores = new Map();

  for (const other of store.listDossiers(principalId, 200)) {
    if (linked.has(other.id)) continue;
    const theirs = store.dossierChunks(principalId, other.id)
      .filter((c) => c.embedding).slice(0, sample);
    if (!theirs.length) continue;

    // Best-pair similarity: two dossiers are related if any part of them is.
    let best = 0;
    for (const a of mine) {
      const va = fromBlob(a.embedding);
      for (const b of theirs) {
        const s = cosine(va, fromBlob(b.embedding));
        if (s > best) best = s;
      }
    }
    if (best > 0.75) scores.set(other.id, { dossier: other, score: best });
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
