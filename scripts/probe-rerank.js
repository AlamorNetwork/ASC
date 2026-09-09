/**
 * Finds the request shape this provider's reranker accepts.
 *
 *   node scripts/probe-rerank.js                    tries every model in .env order
 *   node scripts/probe-rerank.js cohere/rerank-4-fast
 *
 * Rerank APIs are not standardised the way chat completions are: the path, the field
 * names, and whether documents are strings or objects all vary. Rather than guessing,
 * this reports exactly which combination works so it can be pinned.
 */
import { config } from '../src/config.js';

const models = process.argv.slice(2).length ? process.argv.slice(2) : [
  config.models.rerank,
  'cohere/rerank-v3.5',
  'cohere/rerank-4-fast',
  'cohere/rerank-4-pro',
  'voyageai/rerank-2.5',
  'voyageai/rerank-2.5-lite',
  'qwen/qwen3-reranker-8b',
].filter(Boolean);

const query = 'میترائیسم چیست؟';
const docs = [
  'میترائیسم آیینی رازآمیز بود که در امپراتوری روم گسترش یافت.',
  'متنی کاملاً بی‌ربط درباره‌ی کشاورزی و آبیاری زمین.',
];

const base = config.router.base;
const root = base.replace(/\/v1$/, '');

const shapes = (model) => [
  ['POST /v1/rerank · strings', `${base}/rerank`, { model, query, documents: docs, top_n: 2 }],
  ['POST /v1/rerank · objects', `${base}/rerank`, { model, query, documents: docs.map((text) => ({ text })), top_n: 2 }],
  ['POST /rerank · strings   ', `${root}/rerank`, { model, query, documents: docs, top_n: 2 }],
  ['POST /v1/rerank · no top_n', `${base}/rerank`, { model, query, documents: docs }],
  ['POST /v1/reranking       ', `${base}/reranking`, { model, query, documents: docs, top_n: 2 }],
];

console.log(`\nbase: ${base}\n`);

let winner = null;
for (const model of models) {
  console.log(`── ${model}`);
  for (const [name, url, body] of shapes(model)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.router.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();
      const flat = text.replace(/\s+/g, ' ').slice(0, 150);

      if (res.ok && /"(results|data)"/.test(text)) {
        console.log(`   ✅ ${name}  ${res.status}`);
        console.log(`      ${flat}`);
        winner ??= { model, name, url, body };
      } else {
        console.log(`   ✖  ${name}  ${res.status}  ${flat.slice(0, 90)}`);
      }
    } catch (err) {
      console.log(`   ✖  ${name}  ${err.name === 'TimeoutError' ? 'timeout' : err.message.slice(0, 60)}`);
    }
  }
  if (winner) break; // the first model that works is enough
}

console.log(winner
  ? `\nworks: ${winner.model} via ${winner.name.trim()}\n` +
    `put this in .env:  MODEL_RERANK=${winner.model}\n`
  : '\nNothing accepted a rerank request. Reranking stays off and retrieval uses the\n' +
    'fused order, which still works — it just loses some precision.\n');
