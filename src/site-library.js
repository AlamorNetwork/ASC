/** Persist each crawled page and cursor, so a failed fetch need not restart a site. */
import * as store from './db.js';
import { crawlSite } from './site-crawl.js';
import { chunkText } from './chunks.js';
import { checkpoint as stopPoint } from './cancel.js';

export async function collectSite({ principalId, dossierId, url, maxPages = 10,
  onProgress, crawl = crawlSite }) {
  const seed = new URL(url).href;
  const row = store.getOrCreateSiteCrawl(principalId, dossierId, seed);
  let old = {};
  try { old = JSON.parse(row.checkpoint_json); } catch { /* old bad cursor */ }
  let saved = row.pages_saved;
  const initial = Array.isArray(old.nextUrls) && old.nextUrls.length ? old : undefined;
  if (row.state === 'done') return { crawlId: row.id, pagesSaved: saved, done: true, errors: [] };
  store.saveSiteCrawl(principalId, row.id, { checkpoint: initial ?? {}, state: 'running', pagesSaved: saved });
  try {
    const result = await crawl({ url: seed, maxPages, checkpoint: initial,
      onPage: async (page, cursor) => {
        if (page.text.length > 100) {
          const savedPage = store.saveCrawledPage({ principalId, dossierId, url: page.url,
            title: page.title || page.url, text: page.text, chunks: chunkText(page.text) });
          if (savedPage.created) saved++;
        }
        store.saveSiteCrawl(principalId, row.id, { checkpoint: cursor,
          state: 'running', pagesSaved: saved });
        onProgress?.(`${saved} صفحه ذخیره شد · ${page.title || page.url}`);
        stopPoint(principalId, 'خزیدن سایت');
      } });
    const cursor = { nextUrls: result.nextUrls, visited: result.visited };
    store.saveSiteCrawl(principalId, row.id, { checkpoint: cursor,
      state: result.nextUrls.length ? 'paused' : 'done', pagesSaved: saved });
    return { crawlId: row.id, pagesSaved: saved, done: !result.nextUrls.length,
      nextUrls: result.nextUrls.length, errors: result.errors };
  } catch (err) {
    // The onPage hook committed the last successful cursor before the failure.
    const latest = store.getOrCreateSiteCrawl(principalId, dossierId, seed);
    store.saveSiteCrawl(principalId, row.id, { checkpoint: JSON.parse(latest.checkpoint_json),
      state: 'paused', pagesSaved: saved });
    throw err;
  }
}
