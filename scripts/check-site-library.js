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
  console.log('site library check passed — cursor, resume, dedupe, isolation; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
