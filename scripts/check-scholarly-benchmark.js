/** Deterministic, model-free check of the provider comparison and reporting. */
import assert from 'node:assert/strict';
import { CASES, benchmarkCase, renderBenchmark, scholarlyQuota, retryAfterMs } from '../src/scholarly-benchmark.js';

const calls = [];
const fetcher = async (url, options) => {
  calls.push({ url: String(url), headers: options.headers });
  if (String(url).includes('openalex.org')) return Response.json({ results: [
    { id: 'https://openalex.org/W1', title: 'The Dura Europos Mithraeum',
      doi: 'https://doi.org/10.1234/test', best_oa_location: { pdf_url: 'https://example.org/paper.pdf' } },
    { id: 'https://openalex.org/W2', title: 'Unrelated catalogue', best_oa_location: null },
  ] });
  return Response.json({ data: [
    { paperId: 'abc', title: 'Dura Europos Mithraeum excavation',
      externalIds: { DOI: '10.1234/test' }, openAccessPdf: { url: 'https://example.org/paper.pdf' } },
    { paperId: 'def', title: 'Other paper', openAccessPdf: null },
  ] });
};
let opens = 0;
const result = await benchmarkCase(CASES[0], { limit: 2, fetchCount: 1, fetcher,
  open: async () => { opens++; return { ok: true, text: 'A full article text. '.repeat(30) }; },
  keys: { openalex: 'openalex-test', semanticScholar: 'semantic-test' } });
assert.equal(calls.length, 2);
assert.equal(new URL(calls[0].url).searchParams.get('search'), CASES[0].query);
assert.equal(new URL(calls[1].url).searchParams.get('query'), CASES[0].query);
assert.equal(calls[0].headers.Authorization, 'Bearer openalex-test');
assert.equal(calls[1].headers['x-api-key'], 'semantic-test');
assert.equal(opens, 2);
assert.equal(result.providers.openalex.leads[0].readable, true);
assert.equal(result.providers['semantic-scholar'].leads[0].doi, '10.1234/test');
const report = renderBenchmark([result], { limit: 2, fetchCount: 1 });
assert.match(report, /DOI مشترک/);
assert.match(report, /هیچ ادعایی.*تأیید نمی‌شود/);
assert.match(report, /\| dura \| OpenAlex \|.*\| 1 \|$/m);
assert.equal(retryAfterMs('2'), 2000);
assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);

let clock = 0;
const waits = [];
const quota = scholarlyQuota();
let semanticCalls = 0;
const limited = async (url) => {
  if (String(url).includes('openalex.org')) return Response.json({ results: [] });
  semanticCalls++;
  return Response.json({ message: 'Too many requests' }, { status: 429,
    headers: { 'Retry-After': '2' } });
};
const options = { fetcher: limited, fetchCount: 0, quota, now: () => clock,
  sleep: async (ms) => { waits.push(ms); clock += ms; } };
const first = await benchmarkCase(CASES[0], options);
const second = await benchmarkCase(CASES[1], options);
assert.equal(semanticCalls, 2);
assert.deepEqual(waits, [0, 2000]);
assert.match(first.providers['semantic-scholar'].error, /HTTP 429/);
assert.match(second.providers['semantic-scholar'].error, /^skipped: HTTP 429/);
assert.equal(second.providers.openalex.error, null);

let forbiddenCalls = 0;
const forbiddenQuota = scholarlyQuota();
const forbidden = { ...options, quota: forbiddenQuota, fetcher: async (url) => {
  if (String(url).includes('openalex.org')) return Response.json({ results: [] });
  forbiddenCalls++;
  return Response.json({ message: 'Forbidden' }, { status: 403 });
} };
await benchmarkCase(CASES[0], forbidden);
const afterForbidden = await benchmarkCase(CASES[1], forbidden);
assert.equal(forbiddenCalls, 1);
assert.match(afterForbidden.providers['semantic-scholar'].error, /^skipped: HTTP 403/);
console.log('scholarly benchmark check passed — comparable queries, rate pacing, quota stop, 403 distinction; 0 model calls');
