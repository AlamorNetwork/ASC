/** Read one search hit through the bounded crawler and its optional renderers. */
import { crawlSite } from './site-crawl.js';
import { config } from './config.js';
import { enhancedPage } from './page-fetchers.js';

export async function openResearchPage(url, {
  crawl = crawlSite, render = enhancedPage, extraction = config.webExtraction,
} = {}) {
  if (!extraction.fallback.length) return { ok: false, error: 'browser fallback is disabled' };
  const result = await crawl({ url, maxPages: 1,
    fallbackPage: (target) => render(target, extraction) });
  const page = result.pages[0];
  if (!page || page.text.length < 250)
    return { ok: false, error: result.errors[0]?.error || 'no readable page text' };
  return { ok: true, url: page.url, text: page.text, via: page.via };
}
