/** Free integration check for persisted parallel subintent work. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-team-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const { runResearchTeam } = await import('../src/research-team.js');
try {
  const pid = 'a';
  const dossierId = Number(store.insertDossier({ principalId: pid, topic: 'آزمون' }));
  const root = store.createResearchNode({ principalId: pid, dossierId, title: 'چه رخ داد؟' });
  store.addSourceCandidate({ principalId: pid, dossierId,
    url: 'https://example.org/page', title: 'Suggested', why: 'Possible source' });
  let active = 0, peak = 0, calls = 0;
  let crawlOverlapped = false;
  const crawl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    crawlOverlapped = active > 0;
    store.saveCrawledPage({ principalId: pid, dossierId,
      url: 'https://example.org/page', title: 'Page',
      text: 'متن صفحه ' .repeat(50), chunks: ['متن صفحه '.repeat(50)] });
    return { pagesSaved: 1 };
  };
  const ask = async ({ system }) => {
    calls++;
    if (system.includes('زیرپرسش مستقل')) return { data: { subquestions: [
      { title: 'یک', question: 'یک' }, { title: 'دو', question: 'دو' }, { title: 'سه', question: 'سه' }] } };
    if (system.includes('هماهنگ‌کننده')) return { data: { summary: 'نتیجه مقدماتی', open_questions: ['چه منبع دیگری؟'] } };
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { data: { summary: 'بررسی شد', findings: [
      { text: 'پشتیبانی دارد', passage_id: 1, quote: 'عبارت دقیق منبع' },
      { text: 'ساخته شده', passage_id: 1, quote: 'نقل قول ساختگی' }], open_questions: ['تاریخ؟'] } };
  };
  const search = async () => [{ id: 1, document_id: 1, page: 2,
    text: 'اینجا عبارت دقیق منبع وجود دارد و باید بررسی شود.' }];
  const result = await runResearchTeam({ principalId: pid, dossierId, nodeId: root, ask, search, crawl });
  const nodes = store.dossierResearchNodes(pid, dossierId);
  if (peak !== 3 || !crawlOverlapped || result.crawledPages.length !== 1 || calls !== 5 || nodes.length !== 4 ||
      result.reports.some((r) => r.report.findings.length !== 1) ||
      nodes.some((n) => n.status !== 'done')) throw new Error('parallel grounded plan failed');
  await runResearchTeam({ principalId: pid, dossierId, nodeId: root, ask, search });
  if (calls !== 5) throw new Error('completed work called a model again');
  store.createResearchNode({ principalId: pid, dossierId, parentId: root, title: 'پرسش تازه' });
  if (store.getResearchNode(pid, root).status !== 'paused')
    throw new Error('new subintent did not reopen completed root');
  await runResearchTeam({ principalId: pid, dossierId, nodeId: root, ask, search, crawl });
  if (calls !== 7 || store.getResearchNode(pid, root).status !== 'done')
    throw new Error('new child did not resume without repeating completed workers');
  const other = Number(store.insertDossier({ principalId: pid, topic: 'دیگر' }));
  try { store.createResearchNode({ principalId: pid, dossierId: other, parentId: root, title: 'نشت' });
    throw new Error('cross-dossier parent accepted');
  } catch (err) { if (err.message === 'cross-dossier parent accepted') throw err; }
  if (store.getResearchNode('b', root)) throw new Error('other principal can see node');
  console.log('research team check passed — bounded parallelism, quote gate, resume, isolation; 0 paid calls');
} finally {
  store.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
