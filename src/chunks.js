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

export async function embed(texts) {
  const { key, base } = config.router;
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL(), input: texts }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
  const vectors = (json.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
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
export async function retrieve({ principalId, dossierId, query, limit = 6 }) {
  const keyword = store.searchChunks(principalId, dossierId, query, 20);

  let semantic = [];
  try {
    const { vectors } = await embed([query]);
    if (vectors[0]) semantic = vectorSearch(principalId, dossierId, vectors[0], 20);
  } catch (err) {
    console.warn('[chunks] semantic search unavailable:', err.message);
  }

  const merged = semantic.length ? fuse([keyword, semantic]) : keyword;
  return merged.slice(0, limit);
}

/** Renders retrieved passages for a prompt, with their source labelled. */
export function renderPassages(principalId, rows) {
  return rows.map((r, i) => {
    const doc = store.getDocument(principalId, r.document_id);
    const where = [doc?.filename ?? 'سند', r.page ? `ص ${r.page}` : null].filter(Boolean).join(' · ');
    return `[${i + 1}] ${where}\n${r.text}`;
  }).join('\n\n');
}
