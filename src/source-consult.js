/** Optional, single-turn OpenRouter source scout. Suggestions never enter verified claims. */
import { endpointFor, recordSpend } from './llm.js';
import { modelFor } from './settings.js';
import net from 'node:net';

const MAX_CANDIDATES = 5;
const SYSTEM = `You are finding candidate primary and scholarly sources for a research question. Search the web. Return JSON only: {"sources":[{"url":"https://...","title":"...","why":"..."}],"search_gaps":["..."]}. No claims about truth. Search snippets and your response are leads, not evidence. Never invent a URL.`;

function safeUrl(value) {
  try {
    const u = new URL(String(value));
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ||
        u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

export async function consultSources(question, { request = fetch, modelSpec = modelFor('consult') } = {}) {
  if (!modelSpec || modelSpec === 'none') throw new Error('مدل مشاور تنظیم نشده است: /model consult MODEL@openrouter');
  const { model, base, key } = endpointFor(modelSpec);
  const host = new URL(base).hostname;
  if (!['openrouter.ai', 'api.openrouter.ai'].includes(host))
    throw new Error('مشاور منابع باید مستقیماً به OpenRouter وصل باشد.');
  const res = await request(`${base}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: String(question).slice(0, 1000) }],
      max_tokens: 650,
      tools: [{ type: 'openrouter:web_search', parameters: { engine: 'perplexity', max_results: 5 } }] }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${raw.slice(0, 180)}`);
  const json = JSON.parse(raw);
  recordSpend(json.usage ?? {}, { model, kind: 'source_consult' });
  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
  const wrapped = text.match(/\{[\s\S]*\}/)?.[0];
  let parsed;
  try { parsed = JSON.parse(wrapped ?? text); }
  catch { parsed = {}; }
  const seen = new Set();
  const sources = (Array.isArray(parsed.sources) ? parsed.sources : []).flatMap((s) => {
    const url = safeUrl(s?.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ url, title: String(s.title ?? '').slice(0, 200),
      why: String(s.why ?? '').slice(0, 400), status: 'candidate_unverified' }];
  }).slice(0, MAX_CANDIDATES);
  return { sources, searchGaps: (Array.isArray(parsed.search_gaps) ? parsed.search_gaps : [])
    .slice(0, 5).map((s) => String(s).slice(0, 300)),
    costUsd: json.usage?.cost ?? null, notice: 'این‌ها فقط نشانیِ پیشنهادی‌اند؛ هنوز منبع باز و نقل‌قول بررسی نشده است.' };
}
