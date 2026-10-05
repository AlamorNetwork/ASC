/** Bounded, read-only OpenAlex research tools. Metadata is always a lead, never evidence. */
import { config } from './config.js';

const BASE = 'https://api.openalex.org';
const ENTITIES = new Set(['works', 'authors', 'sources', 'institutions', 'topics', 'publishers', 'funders']);
const GROUPS = new Set(['publication_year', 'type', 'is_oa', 'primary_location.source.id',
  'authorships.author.id', 'authorships.institutions.id', 'topics.id', 'language']);
const ID = /^[WASITPF]\d+$/i;
const ENTITY_PREFIX = { works: 'W', authors: 'A', sources: 'S', institutions: 'I',
  topics: 'T', publishers: 'P', funders: 'F' };
const limited = (value, max = 300) => String(value ?? '').trim().slice(0, max);
const count = (value, max = 10) => Math.max(1, Math.min(max, Number(value) || 5));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const OPENALEX_TOOLS = ['search_works', 'get_work', 'resolve_references', 'list_citations',
  'search_entities', 'get_entity', 'group_works', 'calculate_works', 'check_oql', 'analyze_works'];

function identifier(value) {
  const raw = limited(value, 240).replace(/^https:\/\/openalex\.org\//i, '');
  if (/^W\d+$/i.test(raw)) return raw.toUpperCase();
  const doi = raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  if (/^10\.\d{4,9}\/[\w.()/:;+-]+$/i.test(doi)) return `doi:${doi}`;
  throw new Error('OpenAlex: شناسهٔ اثر یا DOI معتبر نیست.');
}
function entityId(value) {
  const raw = limited(value, 80).replace(/^https:\/\/openalex\.org\//i, '');
  if (!ID.test(raw)) throw new Error('OpenAlex: شناسهٔ موجودیت معتبر نیست.');
  return raw.toUpperCase();
}
function filter(value) {
  const raw = limited(value, 350);
  if (raw && !/^[\w.:|,!<>+\-/]+$/.test(raw)) throw new Error('OpenAlex: فیلتر معتبر نیست.');
  return raw;
}
function work(row) {
  if (!row?.id) return null;
  const copy = row.best_oa_location ?? row.primary_location ?? {};
  return { id: row.id, title: row.title || row.display_name || '', doi: row.doi ?? null,
    year: row.publication_year ?? null, authors: (row.authorships || []).slice(0, 6)
      .map((a) => a.author?.display_name).filter(Boolean), venue: row.primary_location?.source?.display_name || null,
    citations: row.cited_by_count ?? null, pdfUrl: copy.pdf_url || null,
    landingUrl: copy.landing_page_url || null, isOpenAccess: !!row.open_access?.is_oa,
    referencedIds: row.referenced_works || [],
    relatedIds: row.related_works || [],
    recordUrl: row.id, status: 'bibliographic_lead' };
}

export function createOpenAlexTools({ fetcher = fetch, key = config.openalexApiKey, sleep = wait } = {}) {
  async function read(path, params = {}, { method = 'GET', body } = {}) {
    const url = new URL(path, BASE);
    if (url.origin !== BASE) throw new Error('OpenAlex: نشانی خارج از سرویس است.');
    for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '')
      url.searchParams.set(name, String(value));
    const headers = { Accept: 'application/json', 'User-Agent': 'ASC-Research/1.0',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetcher(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000) });
      if (res.ok || (path === '/query' && res.status === 400)) return await res.json();
      if (res.status === 429 && attempt === 0) {
        const seconds = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1500;
        if (delay <= 5000) { await sleep(delay); continue; }
      }
      let message = '';
      try { const data = await res.json(); message = limited(data.message || data.error, 160); }
      catch { /* status remains useful */ }
      throw new Error(`OpenAlex HTTP ${res.status}${message ? `: ${message}` : ''}`);
    }
  }
  async function works(params) {
    const data = await read('/works', params);
    return { records: (data.results || []).map(work).filter(Boolean),
      count: data.meta?.count ?? 0, costCredits: data.meta?.cost ?? null,
      nextCursor: data.meta?.next_cursor ?? null, query: data.meta?.x_query?.oql ?? null };
  }
  async function get(id) { return work(await read(`/works/${encodeURIComponent(identifier(id))}`)); }
  async function run(name, args = {}) {
    if (!OPENALEX_TOOLS.includes(name)) throw new Error('OpenAlex: ابزار مجاز نیست.');
    if (name === 'search_works') {
      const query = limited(args.query, args.mode === 'semantic' ? 2000 : 300);
      if (!query) throw new Error('OpenAlex: عبارت جست‌وجو لازم است.');
      const semantic = args.mode === 'semantic';
      return { tool: name, ...(await works({ [semantic ? 'search.semantic' : 'search']: query,
        filter: filter(args.filter), per_page: count(args.limit, semantic ? 20 : 25),
        ...(args.rerank === true && !semantic ? { rerank: true } : {}),
        select: 'id,title,doi,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count' })) };
    }
    if (name === 'get_work') return { tool: name, record: await get(args.id) };
    if (name === 'resolve_references') {
      const references = (Array.isArray(args.references) ? args.references : []).slice(0, 25);
      if (!references.length) throw new Error('OpenAlex: فهرست ارجاعات خالی است.');
      const exact = [], titles = [];
      for (const ref of references) {
        try { exact.push({ input: limited(ref, 240), id: identifier(ref) }); }
        catch { titles.push(limited(ref, 200)); }
      }
      const found = [];
      const dois = exact.filter((r) => r.id.startsWith('doi:'));
      if (dois.length) {
        const data = await works({ filter: `doi:${dois.map((r) => `https://doi.org/${r.id.slice(4)}`).join('|')}`,
          per_page: dois.length, select: 'id,title,doi,publication_year' });
        for (const ref of dois) found.push({ input: ref.input,
          record: data.records.find((r) => r.doi?.toLowerCase().endsWith(ref.id.slice(4).toLowerCase())) || null,
          match: 'doi' });
      }
      for (const ref of exact.filter((r) => !r.id.startsWith('doi:')))
        found.push({ input: ref.input, record: await get(ref.id), match: 'id' });
      for (const title of titles.slice(0, 5)) {
        const data = await works({ search: title, per_page: 3, select: 'id,title,doi,publication_year' });
        found.push({ input: title, candidates: data.records, match: 'candidate_only' });
      }
      return { tool: name, matches: found, omitted: Math.max(0, titles.length - 5),
        note: 'تطبیق عنوان نامطمئن است؛ DOI و خود منبع را جدا بررسی کنید.' };
    }
    if (name === 'list_citations') {
      const record = await get(args.id);
      if (!record) return { tool: name, records: [] };
      const direction = ['citing', 'references', 'related'].includes(args.direction) ? args.direction : 'citing';
      const page = Math.max(1, Math.min(20, Math.floor(Number(args.page) || 1)));
      if (direction === 'citing') return { tool: name, direction, source: record, page,
        ...(await works({ filter: `cites:${entityId(record.id)}`, per_page: count(args.limit, 25), page,
          sort: '-publication_date', select: 'id,title,doi,publication_year,cited_by_count,best_oa_location' })) };
      const allIds = direction === 'references' ? record.referencedIds : record.relatedIds;
      const limit = count(args.limit, 25);
      const ids = allIds.slice((page - 1) * limit, page * limit).map(entityId);
      return { tool: name, direction, source: record, page, totalLinked: allIds.length,
        ...(ids.length ? await works({ filter: `openalex:${ids.join('|')}`, per_page: ids.length,
          select: 'id,title,doi,publication_year,cited_by_count,best_oa_location' })
          : { records: [] }) };
    }
    if (name === 'search_entities') {
      const entity = limited(args.entity, 30);
      if (!ENTITIES.has(entity) || !limited(args.query, 120)) throw new Error('OpenAlex: نوع موجودیت یا نام جست‌وجو معتبر نیست.');
      const data = await read(`/${entity}`, { search: limited(args.query, 120), per_page: count(args.limit, 10) });
      return { tool: name, entity, records: data.results || [], count: data.meta?.count ?? 0 };
    }
    if (name === 'get_entity') {
      const entity = limited(args.entity, 30);
      if (!ENTITIES.has(entity)) throw new Error('OpenAlex: نوع موجودیت معتبر نیست.');
      const id = entityId(args.id);
      if (!id.startsWith(ENTITY_PREFIX[entity])) throw new Error('OpenAlex: شناسه با نوع موجودیت سازگار نیست.');
      if (entity === 'works') return { tool: name, entity, record: await get(id) };
      return { tool: name, entity, record: await read(`/${entity}/${id}`) };
    }
    if (name === 'group_works' || name === 'analyze_works') {
      const where = filter(args.filter);
      if (!where) throw new Error('OpenAlex: برای تحلیل، فیلتر دامنه لازم است.');
      const dimensions = name === 'analyze_works'
        ? ['publication_year', 'type', 'primary_location.source.id']
        : [limited(args.group_by, 80)];
      if (dimensions.some((group) => !GROUPS.has(group))) throw new Error('OpenAlex: ستون گروه‌بندی مجاز نیست.');
      const groups = [];
      let total = 0, query = null, costCredits = 0;
      for (const group of dimensions) {
        const data = await read('/works', { filter: where, group_by: group, per_page: count(args.limit, 10) });
        total = data.meta?.count ?? total;
        query ||= data.meta?.x_query?.oql ?? null;
        costCredits += data.meta?.cost ?? 0;
        groups.push(...(data.group_by || []).map((row) => ({ ...row, dimension: group })));
      }
      return { tool: name, count: total, groups, costCredits, query };
    }
    if (name === 'check_oql' || name === 'calculate_works') {
      const oql = limited(args.oql, 1000);
      if (!/^works\s+(?:where|group|calculate)/i.test(oql)) throw new Error('OpenAlex: فقط پرس‌وجوی آثار مجاز است.');
      const check = await read('/query', {}, { method: 'POST', body: { oql } });
      if (name === 'check_oql') return { tool: name, valid: check.validation?.valid === true,
        errors: check.validation?.errors || [], cost: check.check?.cost ?? null,
        canonical: check.oql_oneline || check.oql || null };
      if (check.validation?.valid !== true) throw new Error('OpenAlex: پرس‌وجوی OQL معتبر نیست.');
      const rawCost = check.check?.cost;
      const estimatedCost = rawCost == null ? NaN : Number(rawCost);
      if (/\bcalculate\b/i.test(oql) && (!Number.isFinite(estimatedCost) || estimatedCost > 20))
        throw new Error('OpenAlex: هزینهٔ محاسبه قابل اندازه‌گیری نیست یا از سقف ۲۰ اعتبار بیشتر است.');
      const data = await read('/', { per_page: count(args.limit, 10) }, { method: 'POST', body: { oql } });
      return { tool: name, count: data.meta?.count ?? 0, groups: data.group_by || [],
        records: (data.results || []).map(work).filter(Boolean), costCredits: data.meta?.cost ?? null,
        query: data.meta?.x_query?.oql ?? null };
    }
  }
  return { run };
}
