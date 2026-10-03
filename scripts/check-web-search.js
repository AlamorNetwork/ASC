/** Free regression check: an outage must not promote unrelated DOI hits as evidence. */
import assert from 'node:assert/strict';
import { searchWeb } from '../src/web-search.js';
import { discoverEvidence } from '../src/research.js';

const reply = (data) => new Response(JSON.stringify(data), { status: 200 });
const fetcher = async (url) => {
  const u = String(url);
  if (u.includes('bing.com')) throw new Error('search blocked');
  if (u.includes('wikipedia.org')) return reply({ query: { search: u.includes('Mithraeum') ? [
    { title: 'Dura-Europos church', snippet: 'Church at Dura-Europos' },
    { title: 'Mithraeum of Dura-Europos', snippet: 'Roman Mithraic shrine' },
  ] : [] } });
  if (u.includes('crossref.org')) return reply({ message: { items: [
    { title: ['مدیریت تدارکات با الگوریتم ترکیبی'], URL: 'https://doi.org/10.1234/unrelated' },
  ] } });
  throw new Error(`Unexpected URL: ${u}`);
};
const named = await searchWeb('Mithraeum Dura-Europos', { fetcher });
assert.match(named.results[0]?.title ?? '', /Mithraeum of Dura-Europos/);
assert(!named.results.some((r) => r.engine === 'crossref'));
const persian = await searchWeb('آیا همهٔ مهرابه‌های رومی زیرزمینی بودند؟ یک نمونهٔ مستند خلاف آن پیدا کن', { fetcher });
assert.equal(persian.results.length, 0);
assert(persian.errors.some((e) => e.includes('did not mention')));
let chosenModel = '', firstQuery = '';
await discoverEvidence('پرسش بلند فارسی دربارهٔ مهرابه', {
  plannerModel: 'test-coordinator',
  ask: async ({ model }) => { chosenModel = model; return { data: { queries: ['Mithraeum Dura-Europos'] } }; },
  search: async (query) => { firstQuery ||= query; return { results: [] }; },
});
assert.equal(chosenModel, 'test-coordinator');
assert.equal(firstQuery, 'Mithraeum Dura-Europos');
console.log('web search check passed — query planner used, relevant shrine ranked first, unrelated DOI rejected; 0 model calls');
