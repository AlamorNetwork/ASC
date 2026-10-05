/** Deterministic, model-free check of the provider comparison and reporting. */
import assert from 'node:assert/strict';
import { CASES, benchmarkCase, renderBenchmark } from '../src/scholarly-benchmark.js';

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
console.log('scholarly benchmark check passed — same query, open copies, DOI overlap, no model calls');
