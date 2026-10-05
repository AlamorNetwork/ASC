/** No-network durable crawl test. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-site-library-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const { collectSite } = await import('../src/site-library.js');
const { robotsAllow } = await import('../src/site-crawl.js');
try {
  const rules = [{ allow: false, path: '/admin/' }, { allow: false, path: '/*?page=' }];
  if (!robotsAllow('https://example.org/Mithraeum', rules) ||
      robotsAllow('https://example.org/admin/', rules) ||
      robotsAllow('https://example.org/Mithraeum?page=2', rules))
    throw new Error('robots wildcard blocked a permitted page or allowed a forbidden one');
  const principalId = 'owner';
  const dossierId = Number(store.insertDossier({ principalId, topic: 'پرونده' }));
  const root = 'https://example.org/';
  let calls = 0;
  const crawl = async ({ checkpoint, onPage }) => {
    calls++;
    const next = checkpoint?.nextUrls?.[0] ?? root;
    const remaining = calls === 1 ? ['https://example.org/two'] : [];
    await onPage({ url: next, title: `Page ${calls}`, text: 'متن آزمایش '.repeat(30) },
      { nextUrls: remaining, visited: [root, next] });
    return { nextUrls: remaining, visited: [root, next], errors: [] };
  };
  const first = await collectSite({ principalId, dossierId, url: root, crawl });
  if (first.done || first.pagesSaved !== 1) throw new Error('first batch cursor lost');
  const second = await collectSite({ principalId, dossierId, url: root, crawl });
  if (!second.done || second.pagesSaved !== 2) throw new Error('resume did not save second page');
  await collectSite({ principalId, dossierId, url: root, crawl });
  if (calls !== 2 || store.sourceCatalogue(principalId, dossierId).length !== 2 ||
      store.sourceCatalogue('other', dossierId).length) throw new Error('dedupe or isolation failed');
  const blockedDossier = Number(store.insertDossier({ principalId, topic: 'صفحهٔ چالش' }));
  const doiSeed = 'https://doi.org/10.1234/challenge';
  const challengeUrl = 'https://www.jstor.org/stable/123';
  const challengeText = 'Client Challenge. A required part of this site couldn’t load.';
  const badPage = store.saveCrawledPage({ principalId, dossierId: blockedDossier,
    url: challengeUrl, title: 'Client Challenge', text: challengeText, chunks: [challengeText] });
  const badCrawl = store.getOrCreateSiteCrawl(principalId, blockedDossier, doiSeed);
  store.saveSiteCrawl(principalId, badCrawl.id, { state: 'done', pagesSaved: 1,
    checkpoint: { visited: [challengeUrl], nextUrls: [] } });
  const badClaim = Number(store.insertClaim({ principalId, dossierId: blockedDossier,
    text: 'صفحه بارگذاری نشد.', sourceUrl: challengeUrl, quote: 'A required part of this site couldn’t load.',
    status: 'verified', verifyMethod: 'stored_page_quote_matched', verifyReason: 'matched' }));
  let recoveryCalls = 0;
  const recovered = await collectSite({ principalId, dossierId: blockedDossier, url: doiSeed,
    crawl: async ({ onPage }) => {
      recoveryCalls++;
      const goodUrl = 'https://publisher.example/article';
      const goodText = 'Actual scholarly article text '.repeat(20);
      await onPage({ url: goodUrl, title: 'Article', text: goodText, via: 'scrapling' },
        { visited: [goodUrl], nextUrls: [] });
      return { visited: [goodUrl], nextUrls: [], errors: [] };
    } });
  if (recoveryCalls !== 1 || !recovered.done ||
      store.sourceCatalogue(principalId, blockedDossier).some((source) => source.documentId === badPage.documentId) ||
      !store.sourceCatalogue(principalId, blockedDossier).some((source) => source.title === 'Article'))
    throw new Error('stored challenge page was not replaced by a real source');
  const invalidated = store.dossierClaims(principalId, blockedDossier).find((claim) => claim.id === badClaim);
  if (invalidated.status !== 'unresolved' || invalidated.verify_reason !== 'bot_challenge')
    throw new Error('claim verified from a challenge page survived cleanup');
  console.log('site library check passed — cursor, resume, dedupe, isolation; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
