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
  let active = 0, peak = 0, calls = 0, observedLive = false, supervisorSawStates = false;
  let crawlOverlapped = false;
  const crawl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    crawlOverlapped = active > 0;
    store.saveCrawledPage({ principalId: pid, dossierId,
      url: 'https://example.org/page', title: 'Page',
      text: 'متن صفحه ' .repeat(50), chunks: ['متن صفحه '.repeat(50)] });
    return { pagesSaved: 1 };
  };
  const ask = async ({ system, content }) => {
    calls++;
    if (system.includes('زیرپرسش مستقل')) return { data: { subquestions: [
      { title: 'یک', question: 'یک' }, { title: 'دو', question: 'دو' }, { title: 'سه', question: 'سه' }] } };
    if (system.includes('هماهنگ‌کننده')) {
      const packet = JSON.parse(content);
      supervisorSawStates = packet.workerStates?.length > 0 &&
        packet.workerStates.every((w) => w.status === 'done' && w.stage);
      return { data: { summary: 'نتیجه مقدماتی', open_questions: ['چه منبع دیگری؟'] } };
    }
    active++; peak = Math.max(peak, active);
    observedLive ||= store.dossierResearchNodes(pid, dossierId)
      .some((n) => n.status === 'running' && n.progress_stage?.includes('تحلیل'));
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
  if (peak !== 3 || !crawlOverlapped || !observedLive || !supervisorSawStates ||
      result.crawledPages.length !== 1 || calls !== 5 || nodes.length !== 4 ||
      result.reports.some((r) => r.report.findings.length !== 1) ||
      nodes.some((n) => n.status !== 'done' || !n.progress_stage))
    throw new Error('parallel grounded plan or live checkpoints failed');
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
  const webRoot = store.createResearchNode({ principalId: pid, dossierId,
    title: 'وب چه می‌گوید؟' });
  store.createResearchNode({ principalId: pid, dossierId, parentId: webRoot,
    title: 'شاهد بیرونی', assignedRole: 'web-researcher' });
  let webQueries = 0, localQueries = 0;
  const webResult = await runResearchTeam({ principalId: pid, dossierId, nodeId: webRoot,
    ask, search: async () => { localQueries++; return []; }, crawl: async () => ({ pagesSaved: 0 }),
    discover: async (query, options) => {
      webQueries++;
      if (query !== 'شاهد بیرونی') throw new Error('wrong delegated question');
      const planned = await options.ask();
      if (planned.data.queries.length) throw new Error('web worker added extra planning calls');
      return { evidence: [{ id: 0, url: 'https://example.org/evidence', title: 'Evidence',
        text: 'متن صفحه عبارت دقیق منبع را دارد و عامل باید آن را عیناً نقل کند.' }] };
    } });
  const webFinding = webResult.reports[0]?.report.findings[0];
  if (webQueries !== 1 || localQueries || webFinding?.sourceUrl !== 'https://example.org/evidence' ||
      webFinding?.verification !== 'quote_present_in_fetched_excerpt_only' ||
      webResult.reports[0]?.report.findings.length !== 1)
    throw new Error('web worker did not preserve URL and exact-quote gate');
  const dryRoot = store.createResearchNode({ principalId: pid, dossierId, title: 'سرنخ گمشده' });
  const dryChild = store.createResearchNode({ principalId: pid, dossierId, parentId: dryRoot,
    title: 'متن گمشده', assignedRole: 'web-researcher' });
  const dry = await runResearchTeam({ principalId: pid, dossierId, nodeId: dryRoot,
    ask, crawl: async () => ({ pagesSaved: 0 }),
    discover: async () => ({ evidence: [] }) });
  if (!dry.incomplete.includes(dryChild) ||
      store.getResearchNode(pid, dryRoot).status !== 'paused' ||
      store.getResearchNode(pid, dryChild).status !== 'paused')
    throw new Error('a dry web search lost its resumable frontier');
  const interrupted = store.createResearchNode({ principalId: pid, dossierId, title: 'کار قطع‌شده' });
  store.updateResearchNode(pid, interrupted, { status: 'running' });
  store.setResearchNodeStage(pid, interrupted, 'خواندن منبع');
  store.pauseInterruptedResearchNodes();
  if (store.getResearchNode(pid, interrupted).status !== 'paused' ||
      !store.getResearchNode(pid, interrupted).progress_stage.includes('آمادهٔ ادامه'))
    throw new Error('restart lost the agent checkpoint');
  console.log('research team check passed — parallel agents, live checkpoints, supervisor review, resume, isolation; 0 paid calls');
} finally {
  store.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
