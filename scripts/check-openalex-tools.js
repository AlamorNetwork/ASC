/** Free contract check: no provider or model requests leave this process. */
import assert from 'node:assert/strict';
import { createOpenAlexTools, OPENALEX_TOOLS } from '../src/openalex-tools.js';

const calls = [];
const paper = { id: 'https://openalex.org/W1', title: 'Mithras at Dura', doi: 'https://doi.org/10.1234/abc',
  referenced_works: ['https://openalex.org/W2', 'https://openalex.org/W3'],
  related_works: ['https://openalex.org/W4'], cited_by_count: 9 };
const json = (data, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { 'content-type': 'application/json' } });
const fetcher = async (url, options) => {
  const u = new URL(url);
  calls.push({ url: u, options });
  assert.equal(u.origin, 'https://api.openalex.org');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  if (u.pathname === '/query') {
    const { oql } = JSON.parse(options.body);
    if (oql.includes('bad')) return json({ validation: { valid: false,
      errors: [{ message: 'bad field' }] } }, 400);
    return json({ validation: { valid: true, errors: [] }, oql_oneline: oql,
      check: { cost: oql.includes('expensive') ? 21 : 2 } });
  }
  if (u.pathname === '/') return json({ results: [paper], meta: { count: 1, cost: 2 } });
  if (u.pathname === '/works/W1' || decodeURIComponent(u.pathname) === '/works/doi:10.1234/abc') return json(paper);
  if (u.pathname === '/authors/A1') return json({ id: 'https://openalex.org/A1', display_name: 'Scholar' });
  if (u.pathname === '/authors') return json({ results: [{ id: 'https://openalex.org/A1', display_name: 'Scholar' }],
    meta: { count: 1 } });
  if (u.pathname === '/works') {
    if (u.searchParams.has('group_by')) return json({ group_by: [{ key: '2024', count: 3 }],
      meta: { count: 3, cost: 1 } });
    return json({ results: [paper], meta: { count: 1, cost: 1,
      x_query: { oql: 'works where title has mithras' } } });
  }
  throw new Error(`unexpected mock URL ${u}`);
};
const api = createOpenAlexTools({ fetcher, key: 'test-key', sleep: async () => {} });
assert.equal(OPENALEX_TOOLS.length, 10);

const search = await api.run('search_works', { query: 'mithras', mode: 'semantic', limit: 3 });
assert.equal(search.records[0].status, 'bibliographic_lead');
assert.equal(search.records[0].title, paper.title);
assert.equal(calls.at(-1).url.searchParams.get('search.semantic'), 'mithras');
assert.equal(search.costCredits, 1);

assert.equal((await api.run('get_work', { id: '10.1234/abc' })).record.id, paper.id);
assert.equal(calls.at(-1).url.pathname, '/works/doi%3A10.1234%2Fabc');
const resolved = await api.run('resolve_references', { references: ['10.1234/abc', 'unknown book title'] });
assert.equal(resolved.matches[0].match, 'doi');
assert.equal(resolved.matches[1].match, 'candidate_only');
assert.equal(calls.find((call) => call.url.searchParams.get('filter')?.startsWith('doi:'))
  .url.searchParams.get('filter'), 'doi:https://doi.org/10.1234/abc');

const cited = await api.run('list_citations', { id: 'W1', direction: 'citing', page: 2 });
assert.equal(cited.page, 2);
assert.equal(calls.at(-1).url.searchParams.get('page'), '2');
const refs = await api.run('list_citations', { id: 'W1', direction: 'references' });
assert.equal(refs.totalLinked, 2);
assert.equal(calls.at(-1).url.searchParams.get('filter'), 'openalex:W2|W3');

assert.equal((await api.run('search_entities', { entity: 'authors', query: 'Scholar' })).records[0].display_name,
  'Scholar');
assert.equal((await api.run('get_entity', { entity: 'authors', id: 'A1' })).record.display_name, 'Scholar');
await assert.rejects(api.run('get_entity', { entity: 'authors', id: 'W1' }), /سازگار نیست/);

const grouped = await api.run('group_works', { filter: 'publication_year:2024', group_by: 'type' });
assert.equal(grouped.groups[0].dimension, 'type');
assert.equal((await api.run('analyze_works', { filter: 'publication_year:2024' })).groups.length, 3);
assert.equal((await api.run('check_oql', { oql: 'works where year is (2024)' })).valid, true);
assert.equal((await api.run('check_oql', { oql: 'works where bad is (2024)' })).valid, false);
await assert.rejects(api.run('calculate_works', { oql: 'works calculate expensive' }), /هزینه/);
const calculated = await api.run('calculate_works', { oql: 'works calculate count' });
assert.equal(calculated.records[0].status, 'bibliographic_lead');
assert.equal(calculated.costCredits, 2);
await assert.rejects(api.run('search_works', { query: '' }), /لازم است/);
await assert.rejects(api.run('other', {}), /مجاز نیست/);

console.log('OpenAlex tools check passed — discovery, references, citations, entities, groups, OQL, cost guard; 0 model calls');
