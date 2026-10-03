import assert from 'node:assert/strict';
import { enhancedPage, firecrawlPage, scraplingPage } from '../src/page-fetchers.js';

let requests = 0;
const page = await firecrawlPage('https://example.org/page', 'test-key', async (url, options) => {
  requests++;
  assert.equal(url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(JSON.parse(options.body).url, 'https://example.org/page');
  return { ok: true, json: async () => ({ success: true, data: {
    html: '<h1>Evidence</h1>', metadata: { sourceURL: 'https://example.org/page' },
  } }) };
});
assert.equal(page.html, '<h1>Evidence</h1>');
assert.equal(page.via, 'firecrawl');
await assert.rejects(firecrawlPage('http://127.0.0.1/', 'test-key', async () => {
  throw new Error('unsafe request was sent');
}), /unsafe page URL/);
await assert.rejects(firecrawlPage('https://example.org/page', 'test-key', async () => ({
  ok: true, json: async () => ({ data: { html: 'secret', metadata: { sourceURL: 'http://127.0.0.1/' } } }),
})), /left the requested site/);
await assert.rejects(scraplingPage('https://example.org/page', '/python', ['other.org']), /not in/);
let tried = [];
const fallback = await enhancedPage('https://example.org/page', {
  fallback: ['scrapling', 'firecrawl'], scraplingPython: '/python',
  scraplingAllowedHosts: ['example.org'], firecrawlKey: 'test-key',
}, {
  scraplingPage: async () => { tried.push('scrapling'); throw new Error('browser unavailable'); },
  firecrawlPage: async () => { tried.push('firecrawl'); return page; },
});
assert.deepEqual(tried, ['scrapling', 'firecrawl']);
assert.equal(fallback.url, 'https://example.org/page');
assert.equal(requests, 1);
console.log('page fetcher checks passed — Firecrawl envelope, origin gate, Scrapling allowlist, fallback order; 0 paid calls');
