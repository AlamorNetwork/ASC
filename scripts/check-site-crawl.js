import assert from 'node:assert/strict';
import { crawlSite } from '../src/site-crawl.js';

const root = 'https://example.org/';
const html = (links, body = 'Body &amp; text') =>
  `<html><title>Test &amp; title</title><script>ignore me</script><body>${body}` +
  links.map((link) => `<a href="${link}">go</a>`).join('') + '</body></html>';

let calls = [];
const fetchPage = async (url) => {
  calls.push(url);
  return { html: url === root
    ? html(['/a#one', '/a#two', 'https://other.org/out', 'http://127.0.0.1/',
      'https://user:pass@example.org/private', 'javascript:alert(1)'])
    : html([], 'Second page') };
};
const seen = [];
const first = await crawlSite({ url: root, maxPages: 1, fetchPage,
  onPage: (page) => seen.push(page.url) });
assert.deepEqual(calls, [root]);
assert.deepEqual(seen, [root]);
assert.equal(first.origin, 'https://example.org');
assert.equal(first.pages[0].title, 'Test & title');
assert.match(first.pages[0].text, /Body & text/);
assert.doesNotMatch(first.pages[0].text, /ignore me/);
assert.deepEqual(first.pages[0].links, ['https://example.org/a']);
assert.deepEqual(first.nextUrls, ['https://example.org/a']);
assert.deepEqual(first.errors, []);
const failed = await crawlSite({ url: root, maxPages: 1,
  fetchPage: async () => { throw new Error('HTTP 503'); } });
assert.deepEqual(failed.nextUrls, [root]);
assert.deepEqual(failed.visited, []);
let fallbackCalls = 0;
const rendered = await crawlSite({ url: root, maxPages: 1,
  fetchPage: async () => { throw new Error('HTTP 503'); },
  fallbackPage: async (url) => { fallbackCalls++; return { url,
    html: html(['/next'], 'Rendered evidence from a JavaScript page') }; } });
assert.equal(rendered.pages[0].url, root);
assert.deepEqual(rendered.nextUrls, ['https://example.org/next']);
assert.equal(fallbackCalls, 1);
const badFallback = await crawlSite({ url: root, maxPages: 1,
  fetchPage: async () => { throw new Error('HTTP 503'); },
  fallbackPage: async () => ({ url: 'http://127.0.0.1/', html: '<h1>wrong host</h1>' }) });
assert.equal(badFallback.pages.length, 0);
assert.match(badFallback.errors[0].error, /private|off-origin/);
let unsafeFallback = 0;
const privateResolution = await crawlSite({ url: root, maxPages: 1,
  fetchPage: async () => { throw new Error('private or unresolved address'); },
  fallbackPage: async () => { unsafeFallback++; throw new Error('must not run'); } });
assert.equal(unsafeFallback, 0);
assert.match(privateResolution.errors[0].error, /private or unresolved/);

const resumed = await crawlSite({ url: root, checkpoint: {
  visited: first.pages.map((page) => page.url), nextUrls: first.nextUrls,
}, fetchPage });
assert.deepEqual(resumed.pages.map((page) => page.url), ['https://example.org/a']);
assert.deepEqual(calls, [root, 'https://example.org/a']);

for (const url of ['http://localhost/', 'http://127.0.0.1/',
  'http://10.1.2.3/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
  'https://user:pass@example.org/', 'file:///etc/passwd']) {
  await assert.rejects(crawlSite({ url, fetchPage }), /private|credentialed|unsupported/);
}
const escape = await crawlSite({ url: root,
  fetchPage: async () => ({ url: 'https://other.org/', html: '<h1>escape</h1>' }) });
assert.equal(escape.pages.length, 0);
assert.match(escape.errors[0].error, /off-origin/);

const many = await crawlSite({ url: root, maxPages: 100,
  fetchPage: async (url) => ({ html: url === root
    ? html(Array.from({ length: 30 }, (_, i) => `/p${i}`)) : html([]) }) });
assert.equal(many.pages.length, 20);
assert.equal(many.nextUrls.length, 11);

const oversize = await crawlSite({ url: root,
  fetchPage: async () => ({ html: 'a'.repeat(1024 * 1024 + 1) }) });
assert.equal(oversize.pages.length, 0);
assert.match(oversize.errors[0].error, /byte limit/);

const total = await crawlSite({ url: root,
  fetchPage: async (url) => ({ html: html(url === root
    ? Array.from({ length: 8 }, (_, i) => `/large${i}`) : [],
  'a'.repeat(900_000)) }) });
assert.equal(total.pages.length, 5);
assert.ok(total.nextUrls.length > 0);

console.log('site crawl checks passed');
