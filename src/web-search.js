/** Server-side discovery. Search results are leads, never evidence; research fetches
 * their pages before showing anything to a model. No extra API key is required.
 * Bing RSS is best-effort; MediaWiki's documented API is a fallback.
 */
import { config } from './config.js';
const HEADERS = { 'User-Agent': 'ASC-Research/1.0 (source discovery)',
  Accept: 'application/rss+xml,application/json;q=0.9,*/*;q=0.5' };

const STOP = new Set(['آیا', 'برای', 'درباره', 'همه', 'یک', 'نمونه', 'مستند', 'پیدا', 'کن', 'کدام',
  'چگونه', 'بودند', 'هستند', 'شوند', 'است', 'نیست', 'آنها', 'های', 'شود', 'دارد', 'the', 'and',
  'for', 'with', 'from', 'what', 'which', 'were', 'was', 'are', 'above', 'below', 'ground',
  'source', 'sources', 'evidence', 'archaeology']);
const canonical = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[\u200c\u200d]/g, ' ');

/** A search hit is only a lead if its own title/snippet mentions the topic. */
export function leadRelevance(query, lead) {
  const terms = [...new Set(canonical(query).match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
    .filter((word) => !STOP.has(word));
  if (!terms.length) return 1;
  const title = canonical(lead.title);
  const snippet = canonical(lead.snippet);
  return terms.reduce((score, word) => score + (title.includes(word) ? 3 : snippet.includes(word) ? 1 : 0), 0);
}

function decodeXml(s) {
  return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|#(\d+));/g, (m, n) => {
      if (n) return String.fromCodePoint(Number(n));
      return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[m];
    });
}

export function parseBingRss(xml, limit = 8) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, limit);
  const field = (item, tag) => decodeXml(item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]);
  return items.map(([, item]) => ({ title: field(item, 'title'), url: field(item, 'link'),
    snippet: field(item, 'description'), engine: 'bing-rss' }))
    .filter((r) => /^https?:\/\//i.test(r.url));
}

async function bing(query, limit, fetcher) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return parseBingRss(await res.text(), limit * 2).filter((r) =>
    !terms.length || terms.some((term) =>
      `${r.title} ${r.snippet}`.toLowerCase().includes(term))).slice(0, limit);
}

async function wikipedia(query, limit, fetcher) {
  const lang = /[\u0600-\u06ff]/.test(query) ? 'fa' : 'en';
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({ action: 'query', list: 'search', format: 'json',
    srsearch: query, srlimit: String(Math.min(limit, 10)) }).toString();
  const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  return (data.query?.search ?? []).map((item) => ({ title: item.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    snippet: String(item.snippet ?? '').replace(/<[^>]+>/g, ' '), engine: 'wikipedia' }));
}

async function crossref(query, limit, fetcher) {
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({ query, rows: String(Math.min(limit, 10)),
    select: 'DOI,title,URL,abstract,published' }).toString();
  const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`);
  const data = await res.json();
  return (data.message?.items ?? []).filter((r) => r.URL && r.title?.[0])
    .map((r) => ({ title: r.title[0], url: r.URL,
      snippet: String(r.abstract ?? '').replace(/<[^>]+>/g, ' ').slice(0, 350),
      engine: 'crossref', metadataOnly: true,
      provenance: { doi: r.DOI ?? null, kind: 'bibliographic_record' } }));
}

/** OpenAlex points us to the host's open copy; its catalogue is not article text. */
async function openalex(query, limit, fetcher) {
  const url = new URL('https://api.openalex.org/works');
  url.search = new URLSearchParams({ search: query, per_page: String(Math.min(limit, 10)),
    select: 'id,title,doi,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,type' }).toString();
  const key = config.openalexApiKey.trim();
  const headers = key ? { ...HEADERS, Authorization: `Bearer ${key}` } : HEADERS;
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).filter((r) => r.title && r.id).map((r) => {
    const copy = r.best_oa_location;
    const fullText = copy?.pdf_url || copy?.landing_page_url || null;
    const alternateUrl = copy?.pdf_url && copy?.landing_page_url &&
      copy.pdf_url !== copy.landing_page_url ? copy.landing_page_url : null;
    const record = r.doi || r.id;
    const catalogueLanding = !copy?.pdf_url && /^https?:\/\/(?:dx\.)?doi\.org\//i.test(fullText || '');
    return { title: r.title, url: fullText || record,
      alternateUrl,
      snippet: `${r.primary_location?.source?.display_name || ''} ${r.publication_year || ''}`.trim(),
      engine: 'openalex', metadataOnly: !fullText || catalogueLanding,
      provenance: { workId: r.id, doi: r.doi ?? null, year: r.publication_year ?? null,
        authors: (r.authorships ?? []).slice(0, 8).map((a) => a.author?.display_name).filter(Boolean),
        venue: r.primary_location?.source?.display_name ?? null,
        citations: r.cited_by_count ?? null, openAccess: !!r.open_access?.is_oa,
        recordUrl: record, kind: 'scholarly_record' } };
  }).filter((r) => /^https?:\/\//i.test(r.url));
}

export async function searchWeb(query, { limit = 8, fetcher = fetch } = {}) {
  const clean = String(query ?? '').trim().slice(0, 250);
  if (!clean) return { results: [], errors: ['empty query'] };
  const results = [], errors = [];
  // Crossref DOI landing pages are often paywalled or unreachable; keep a couple
  // of directly readable encyclopedia leads ahead of them.
  for (const [engine, quota] of [[bing, 3], [openalex, 3], [wikipedia, 2], [crossref, 2]]) {
    try {
      const found = await engine(clean, Math.min(quota, limit - results.length), fetcher);
      for (const r of found) if (!results.some((x) => x.url === r.url)) results.push(r);
    } catch (err) { errors.push(`${engine.name}: ${err.message}`); }
    if (results.length >= limit) break;
  }
  const ranked = results.map((lead) => ({ lead, score: leadRelevance(clean, lead) }))
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length && results.length) errors.push(`${results.length} search hits did not mention the question's subject`);
  return { results: ranked.slice(0, limit).map(({ lead }) => lead), errors };
}
