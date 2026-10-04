/** Free regression check: an outage must not promote unrelated DOI hits as evidence. */
import assert from 'node:assert/strict';
import { searchWeb } from '../src/web-search.js';
import { discoverEvidence } from '../src/research.js';

const reply = (data) => new Response(JSON.stringify(data), { status: 200 });
const fetcher = async (url, options) => {
  const u = String(url);
  if (u.includes('api.openalex.org') && process.env.OPENALEX_API_KEY &&
      options.headers.Authorization !== `Bearer ${process.env.OPENALEX_API_KEY}`)
    throw new Error('OpenAlex key was not sent from configuration');
  if (u.includes('bing.com')) throw new Error('search blocked');
  if (u.includes('wikipedia.org')) return reply({ query: { search: u.includes('Mithraeum') ? [
    { title: 'Dura-Europos church', snippet: 'Church at Dura-Europos' },
    { title: 'Mithraeum of Dura-Europos', snippet: 'Roman Mithraic shrine' },
  ] : [] } });
  if (u.includes('crossref.org')) return reply({ message: { items: [
    { title: ['مدیریت تدارکات با الگوریتم ترکیبی'], URL: 'https://doi.org/10.1234/unrelated' },
  ] } });
  if (u.includes('gutendex.com/books')) return reply({ results: [
    { id: 713, title: 'The Cult of Mithras', authors: [{ name: 'Researcher, A.' }],
      languages: ['en'], copyright: false,
      formats: { 'text/html; charset=utf-8': 'https://www.gutenberg.org/cache/epub/713/pg713-images.html' } },
  ] });
  if (u.includes('openlibrary.org/search.json')) return reply({ docs: [
    { key: '/works/OL123W', title: 'The Cult of Mithras', author_name: ['Scholar B'],
      first_publish_year: 1900, has_fulltext: false },
  ] });
  if (u.includes('api.openalex.org')) return reply({ results: u.includes('Mithraeum') ? [
    { id: 'https://openalex.org/W123', title: 'Mithraeum of Dura-Europos',
      doi: 'https://doi.org/10.1234/mithraeum', publication_year: 2020,
      authorships: [{ author: { display_name: 'Scholar A' } }],
      primary_location: { source: { display_name: 'Archaeology Journal' } },
      best_oa_location: { pdf_url: 'https://example.org/mithraeum.pdf' },
      open_access: { is_oa: true }, cited_by_count: 4 },
    { id: 'https://openalex.org/W124', title: 'Mithraeum Dura-Europos catalogue only',
      doi: 'https://doi.org/10.1234/catalogue', best_oa_location: null },
    { id: 'https://openalex.org/W125', title: 'Mithraeum Dura-Europos DOI landing',
      doi: 'https://doi.org/10.1234/landing',
      best_oa_location: { landing_page_url: 'https://doi.org/10.1234/landing' } },
  ] : [] });
  throw new Error(`Unexpected URL: ${u}`);
};
const named = await searchWeb('Mithraeum Dura-Europos', { fetcher });
assert(named.results.some((r) => r.title.includes('Mithraeum of Dura-Europos')));
const openCopy = named.results.find((r) => r.engine === 'openalex' && !r.metadataOnly);
assert.equal(openCopy?.url, 'https://example.org/mithraeum.pdf');
assert.equal(openCopy?.provenance?.authors[0], 'Scholar A');
assert(named.results.some((r) => r.engine === 'openalex' && r.metadataOnly));
assert(named.results.some((r) => r.title.includes('DOI landing') && r.metadataOnly));
assert(!named.results.some((r) => r.engine === 'crossref'));
const books = await searchWeb('The Cult of Mithras book', { fetcher });
assert.equal(books.results.find((r) => r.engine === 'gutendex')?.metadataOnly, false);
assert.match(books.results.find((r) => r.engine === 'gutendex')?.url || '', /pg713-images\.html/);
assert.equal(books.results.find((r) => r.engine === 'openlibrary')?.metadataOnly, true);
assert.equal(books.results.find((r) => r.engine === 'openlibrary')?.provenance?.authors[0], 'Scholar B');
const persian = await searchWeb('آیا همهٔ مهرابه‌های رومی زیرزمینی بودند؟ یک نمونهٔ مستند خلاف آن پیدا کن', { fetcher });
assert.equal(persian.results.length, 0);
assert(persian.errors.some((e) => e.includes('did not mention')));
const rss = `<rss><channel>${Array.from({ length: 14 }, (_, i) =>
  `<item><title>Mithraeum finding ${i}</title><link>https://example.org/rss-${i}</link><description>Mithraeum excavation</description></item>`
).join('')}</channel></rss>`;
const broad = await searchWeb('Mithraeum', { fetcher: async (url) =>
  String(url).includes('bing.com') ? new Response(rss) : reply({ query: { search: [] },
    message: { items: [] }, results: [] }) });
assert.equal(broad.results.length, 14);
let chosenModel = '', firstQuery = '';
await discoverEvidence('پرسش بلند فارسی دربارهٔ مهرابه', {
  plannerModel: 'test-coordinator',
  ask: async ({ model }) => { chosenModel = model; return { data: { queries: ['Mithraeum Dura-Europos'] } }; },
  search: async (query) => { firstQuery ||= query; return { results: [] }; },
});
assert.equal(chosenModel, 'test-coordinator');
assert.equal(firstQuery, 'Mithraeum Dura-Europos');
let browserCalls = 0;
const rescued = await discoverEvidence('Mithraeum Dura-Europos', {
  ask: async () => ({ data: { queries: ['Mithraeum Dura-Europos'] } }),
  search: async () => ({ results: [
    { url: 'https://example.org/blocked', title: 'Mithraeum Dura-Europos', engine: 'test' },
    { url: 'https://example.org/second', title: 'Mithraeum Dura-Europos', engine: 'test' },
  ] }),
  open: async () => ({ ok: false, error: 'HTTP 403' }), enhancedLimit: 1,
  openEnhanced: async (url) => { browserCalls++; return { ok: true, url, via: 'scrapling',
    text: 'This Mithraeum was an above ground building at Dura Europos. '.repeat(8) }; },
});
assert.equal(browserCalls, 1);
assert.equal(rescued.evidence[0]?.via, 'scrapling');
assert.match(rescued.evidence[0]?.fullText || '', /above ground/);
let openedDoi = false;
const catalogueOnly = await discoverEvidence('Mithraeum Dura-Europos', {
  ask: async () => ({ data: { queries: ['Mithraeum Dura-Europos'] } }),
  search: async () => ({ results: [
    { url: 'https://doi.org/10.1234/record', title: 'Bibliographic record',
      engine: 'crossref', metadataOnly: true },
    { url: 'https://example.org/full-text', title: 'Readable article', engine: 'openalex' },
  ] }),
  open: async (url) => {
    if (url.includes('doi.org')) openedDoi = true;
    return { ok: true, url, text: 'Readable full article text. '.repeat(20) };
  }, enhancedLimit: 0,
});
assert.equal(openedDoi, false);
assert.equal(catalogueOnly.evidence.length, 1);
assert.equal(catalogueOnly.leads.length, 2);
const fallback = await discoverEvidence('Mithraeum', {
  ask: async () => ({ data: { queries: ['Mithraeum'] } }),
  search: async () => ({ results: [{ url: 'https://example.org/blocked.pdf',
    alternateUrl: 'https://example.org/article', title: 'Open study', engine: 'openalex',
    provenance: { workId: 'https://openalex.org/W123' } }] }),
  open: async (url) => url.endsWith('.pdf') ? { ok: false, error: 'HTTP 403' }
    : { ok: true, url, text: 'Readable text from the host landing page. '.repeat(12) },
  enhancedLimit: 0,
});
assert.equal(fallback.evidence[0]?.url, 'https://example.org/article');
assert.equal(fallback.evidence[0]?.provenance.workId, 'https://openalex.org/W123');
const manyLeads = Array.from({ length: 14 }, (_, i) => ({
  url: `https://example.org/source-${i}`, title: `Mithraeum source ${i}`, engine: 'test' }));
const opened = [], saved = [];
const many = await discoverEvidence('Mithraeum', {
  ask: async () => ({ data: { queries: ['Mithraeum'] } }),
  search: async () => ({ results: manyLeads }),
  open: async (url) => { opened.push(url); return { ok: true, url,
    text: `A distinct account at ${url}. `.repeat(15) }; },
  onEvidence: (source) => saved.push(source.url), enhancedLimit: 0,
});
assert.equal(opened.length, 14);
assert.equal(saved.length, 14);
assert.equal(many.evidence.length, 14);
assert.equal(many.leads.length, 14);
assert.equal(many.remaining.length, 0);
let allowMore = true;
let checkpointed = 0;
const stopped = await discoverEvidence('Mithraeum', {
  ask: async () => ({ data: { queries: ['Mithraeum'] } }),
  search: async () => ({ results: manyLeads }),
  open: async (url) => ({ ok: true, url, text: `A distinct account at ${url}. `.repeat(15) }),
  onEvidence: () => { checkpointed++; if (checkpointed === 4) allowMore = false; },
  shouldContinue: () => allowMore, enhancedLimit: 0,
});
assert.equal(stopped.evidence.length, 4);
assert.equal(stopped.remaining.length, 10);
const resumed = await discoverEvidence('Mithraeum', {
  ask: async () => ({ data: { queries: ['Mithraeum'] } }),
  search: async () => ({ results: manyLeads }),
  open: async (url) => ({ ok: true, url, text: `A distinct account at ${url}. `.repeat(15) }),
  skipUrls: stopped.evidence.map((e) => e.url), enhancedLimit: 0,
});
assert.equal(resumed.evidence.length, 10);
console.log('web search check passed — query planner used, relevant shrine ranked first, unrelated DOI rejected; 0 model calls');
