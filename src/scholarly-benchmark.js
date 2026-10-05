/** Fair, model-free comparison of scholarly discovery providers. Results are leads. */
import { config } from './config.js';
import { fetchSourceText } from './verify.js';

export const CASES = [
  { id: 'dura', question: 'آیا مهرابهٔ دورا-اروپوس روزمینی بود؟',
    query: 'Dura Europos Mithraeum', anchors: ['dura', 'mithra'] },
  { id: 'ostia', question: 'آیا مهرابه‌های اوستیا زیرزمینی بودند؟',
    query: 'Ostia mithraea House of Diana', anchors: ['ostia', 'mithra'] },
  { id: 'origins', question: 'رابطهٔ میترائیسم رومی و مهر ایرانی چه بود؟',
    query: 'Roman Mithraism Iranian origins', anchors: ['mithra', 'iran'] },
];

const safeUrl = (value) => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; }
  catch { return null; }
};
const anchorHits = (title, anchors) => anchors.filter((word) =>
  String(title ?? '').toLowerCase().includes(word)).length;

export function normaliseOpenAlex(rows) {
  return (rows || []).filter((row) => row.title && row.id).map((row) => {
    const copy = row.best_oa_location || {};
    const url = safeUrl(copy.pdf_url) || safeUrl(copy.landing_page_url);
    const doi = String(row.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase() || null;
    return { title: row.title, doi, year: row.publication_year || null,
      recordUrl: safeUrl(row.id), fullTextUrl: url,
      alternateUrl: safeUrl(copy.pdf_url) && safeUrl(copy.landing_page_url),
      citations: row.cited_by_count ?? null };
  });
}

export function normaliseSemanticScholar(rows) {
  return (rows || []).filter((row) => row.title && row.paperId).map((row) => ({
    title: row.title, doi: String(row.externalIds?.DOI || '').toLowerCase() || null,
    year: row.year || null, recordUrl: safeUrl(row.url) ||
      `https://www.semanticscholar.org/paper/${encodeURIComponent(row.paperId)}`,
    fullTextUrl: safeUrl(row.openAccessPdf?.url), alternateUrl: null,
    citations: row.citationCount ?? null,
  }));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function scholarlyQuota() { return { nextAt: 0, blocked: null }; }

async function search(provider, query, limit, fetcher, keys, quota, sleep, now) {
  const url = provider === 'openalex' ? new URL('https://api.openalex.org/works')
    : new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  if (provider === 'openalex') url.search = new URLSearchParams({ search: query,
    per_page: String(limit), select: 'id,title,doi,publication_year,best_oa_location,cited_by_count' });
  else url.search = new URLSearchParams({ query: query.replaceAll('-', ' '), limit: String(limit),
    fields: 'title,url,year,externalIds,openAccessPdf,citationCount' });
  const headers = { Accept: 'application/json', 'User-Agent': 'ASC-Scholarly-Benchmark/1.0' };
  if (provider === 'openalex' && keys.openalex) headers.Authorization = `Bearer ${keys.openalex}`;
  if (provider === 'semantic-scholar' && keys.semanticScholar) headers['x-api-key'] = keys.semanticScholar;
  const semantic = provider === 'semantic-scholar';
  if (semantic && quota.blocked) throw new Error(`skipped: ${quota.blocked}`);
  for (let attempt = 0; attempt < (semantic ? 2 : 1); attempt++) {
    if (semantic) {
      await sleep(Math.max(0, quota.nextAt - now()));
      quota.nextAt = now() + 1200;
    }
    const started = performance.now();
    const res = await fetcher(url, { headers, signal: AbortSignal.timeout(15000) });
    const latencyMs = Math.round(performance.now() - started);
    if (res.ok) {
      const data = await res.json();
      return { latencyMs, leads: provider === 'openalex' ? normaliseOpenAlex(data.results)
        : normaliseSemanticScholar(data.data) };
    }
    let detail = '';
    try { detail = String((await res.json()).message || '').replace(/[\r\n|]/g, ' ').slice(0, 100); }
    catch { /* status is enough when the provider returns HTML */ }
    const retry = retryAfterMs(res.headers.get('retry-after'), now());
    const reason = `HTTP ${res.status}${detail ? ` ${detail}` : ''}`;
    if (semantic && res.status === 429 && attempt === 0 && (retry === null || retry <= 15000)) {
      quota.nextAt = now() + Math.max(2000, retry ?? 3000);
      continue;
    }
    if (semantic && [401, 403, 429].includes(res.status))
      quota.blocked = `${reason}${res.status === 429 && retry !== null ? `; Retry-After ${Math.ceil(retry / 1000)}s` : ''}`;
    throw new Error(quota.blocked || reason);
  }
}

export async function benchmarkCase(testCase, { limit = 5, fetchCount = 2,
  fetcher = fetch, open = fetchSourceText,
  quota = scholarlyQuota(), sleep = pause, now = Date.now,
  keys = { openalex: config.openalexApiKey, semanticScholar: config.semanticScholarApiKey } } = {}) {
  const results = {};
  for (const provider of ['openalex', 'semantic-scholar']) {
    try {
      const { latencyMs, leads } = await search(provider, testCase.query, limit, fetcher, keys, quota, sleep, now);
      const checked = leads.map((lead, rank) => ({ ...lead, rank: rank + 1,
        titleAnchorHits: anchorHits(lead.title, testCase.anchors),
        readable: null, fetchError: null, characters: 0, textSample: '', fetchedUrl: null }));
      for (const lead of checked.filter((item) => item.fullTextUrl).slice(0, fetchCount)) {
        let page = await open(lead.fullTextUrl);
        if ((!page.ok || (page.text?.length || 0) < 250) && lead.alternateUrl)
          page = await open(lead.alternateUrl);
        lead.readable = !!page.ok && (page.text?.length || 0) >= 250;
        lead.fetchError = lead.readable ? null : page.error || 'text too short';
        lead.characters = lead.readable ? page.text.length : 0;
        lead.textSample = lead.readable ? page.text.replace(/\s+/g, ' ').slice(0, 220) : '';
        lead.fetchedUrl = lead.readable ? page.url || lead.fullTextUrl : null;
      }
      results[provider] = { latencyMs, leads: checked, error: null };
    } catch (err) { results[provider] = { latencyMs: null, leads: [], error: err.message }; }
  }
  return { ...testCase, providers: results };
}

export function renderBenchmark(cases, { limit, fetchCount } = {}) {
  const lines = ['# مقایسهٔ OpenAlex و Semantic Scholar', '',
    `زمان: ${new Date().toISOString()} · ${cases.length} پرسش · حداکثر ${limit ?? 5} نتیجه و ${fetchCount ?? 2} متن برای هر ارائه‌دهنده`,
    '', '«مرتبط» فقط یعنی عنوان هر دو نشانۀ از پیش تعیین‌شدهٔ پرسش را دارد؛ داوری معنایی نیست. «خواندنی» یعنی صفحه باز شد و دست‌کم ۲۵۰ نویسه داشت؛ ممکن است فقط صفحهٔ ناشر یا DOI باشد، نه متن مقاله. هیچ ادعایی با این آزمون تأیید نمی‌شود.',
    '', '| پرسش | سرویس | پاسخ API | نتیجه | عنوان مرتبط | پیوند متن باز | متن خوانده‌شده | DOI مشترک با رقیب |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const row of cases) {
    const a = row.providers.openalex, b = row.providers['semantic-scholar'];
    const aDois = new Set(a.leads.map((lead) => lead.doi).filter(Boolean));
    const bDois = new Set(b.leads.map((lead) => lead.doi).filter(Boolean));
    for (const [name, result, rival] of [['OpenAlex', a, bDois], ['Semantic Scholar', b, aDois]]) {
      const leads = result.leads;
      lines.push(`| ${row.id} | ${name} | ${result.error ? result.error.replaceAll('|', '/') : `${result.latencyMs} ms`} | ${leads.length} | ${leads.filter((x) => x.titleAnchorHits === row.anchors.length).length} | ${leads.filter((x) => x.fullTextUrl).length} | ${leads.filter((x) => x.readable).length} | ${leads.filter((x) => x.doi && rival.has(x.doi)).length} |`);
    }
  }
  for (const row of cases) {
    lines.push('', `## ${row.id}: ${row.question}`, `جست‌وجو: ${row.query}`, '');
    for (const [name, provider] of [['OpenAlex', row.providers.openalex],
      ['Semantic Scholar', row.providers['semantic-scholar']]]) {
      lines.push(`### ${name}`);
      if (provider.error) { lines.push(`- خطا: ${provider.error}`); continue; }
      for (const item of provider.leads) {
        lines.push(`- ${item.rank}. ${String(item.title).replaceAll('|', '/')} (${item.year || 'سال نامشخص'}) · عنوان ${item.titleAnchorHits}/${row.anchors.length} · ${item.readable === null ? 'صفحه آزموده نشد' : item.readable ? `${item.characters} نویسه دریافت شد` : `صفحه خوانده نشد: ${item.fetchError}`} · [رکورد](${item.recordUrl})${item.fullTextUrl ? ` · [پیوند متن احتمالی](${item.fullTextUrl})` : ''}`);
        if (item.textSample) lines.push(`  - نمونهٔ صفحه: ${item.textSample.replace(/[\r\n|`]/g, ' ')}`);
      }
    }
  }
  lines.push('', '## تصمیم', 'این جدول به‌تنهایی برنده تعیین نمی‌کند. عنوان‌های مرتبط و متن‌های خوانده‌شده را دستی بازبینی کنید؛ سپس ببینید کدام سرویس شاهد بیشتری برای همان پرسش فراهم می‌کند. DOI و چکیده فقط سرنخ‌اند.',
    'این مرحله API جست‌وجوی زیرین را می‌سنجد. اگر Semantic Scholar نتیجهٔ مفیدتری داد، قابلیت‌های افزودهٔ MCP مثل مسیر استناد و جست‌وجوی گذرگاه را در مرحلهٔ بعد جدا آزمایش کنید.');
  return lines.join('\n') + '\n';
}
