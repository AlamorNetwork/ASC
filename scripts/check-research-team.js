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
      return { data: { summary: 'نتیجه مقدماتی', open_questions: ['چه منبع دیگری؟'], approved_leads: [] } };
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
  const leadDossier = Number(store.insertDossier({ principalId: pid, topic: 'زنجیرهٔ سرنخ' }));
  const leadRoot = store.createResearchNode({ principalId: pid, dossierId: leadDossier,
    title: 'پرسش اصلی', assignedRole: 'coordinator' });
  const questions = ['روایت نخست چه می‌گوید؟', 'منشأ روایت دوم چیست؟',
    'کدام منبع دیدگاه سوم را نقد می‌کند؟', 'آیا متن چهارم مستقل است؟'];
  const firstLeadWorker = store.createResearchNode({ principalId: pid, dossierId: leadDossier,
    parentId: leadRoot, title: questions[0], assignedRole: 'source-analyst' });
  let leadWorkerCalls = 0, leadMotherCalls = 0;
  const leadAsk = async ({ system, content }) => {
    if (system.includes('هماهنگ‌کننده')) {
      leadMotherCalls++;
      const packet = JSON.parse(content);
      const candidate = packet.leadCandidates?.[0];
      if (candidate && !packet.workerStates?.some((n) => n.id === candidate.fromNodeId))
        throw new Error('mother saw a lead without its source agent');
      return { data: { summary: 'گزارش زنجیره', approved_leads: candidate
        ? [{ lead_id: candidate.id, role: 'local', reason: 'پرسش بعدی قابل بررسی است' }] : [] } };
    }
    leadWorkerCalls++;
    const current = /زیرپرسش: ([^\n]+)/.exec(content)?.[1];
    const next = questions[questions.indexOf(current) + 1];
    return { data: { summary: `گام ${current} بررسی شد`,
      findings: [{ text: 'عبارت در سند است', passage_id: 1, quote: 'عبارت دقیق منبع' }],
      open_questions: next ? [next] : [] } };
  };
  const leadSearch = async () => [{ id: 10, document_id: 10, page: 4,
    text: 'این صفحه عبارت دقیق منبع را نشان می‌دهد و پرسش بعدی قابل بررسی است.' }];
  const queued = await runResearchTeam({ principalId: pid, dossierId: leadDossier,
    nodeId: leadRoot, ask: leadAsk, search: leadSearch, crawl: async () => ({ pagesSaved: 0 }) });
  const leadNodes = store.dossierResearchNodes(pid, leadDossier);
  const leads = store.researchLeads(pid, leadDossier, leadRoot);
  if (leadWorkerCalls !== 3 || leadMotherCalls !== 3 || leadNodes.length !== 5 ||
      leads.length !== 3 || leads.some((lead) => lead.status !== 'approved' || !lead.child_node_id) ||
      store.researchLeads('b', leadDossier).length ||
      !queued.incomplete.length || store.getResearchNode(pid, leadRoot).status !== 'paused' ||
      leadNodes.find((n) => n.title === questions[1])?.parent_id !== firstLeadWorker ||
      leadNodes.find((n) => n.title === questions[3])?.status !== 'pending')
    throw new Error('mother-approved leads did not form a bounded durable chain');
  await runResearchTeam({ principalId: pid, dossierId: leadDossier,
    nodeId: leadRoot, ask: leadAsk, search: leadSearch });
  if (leadWorkerCalls !== 4 || store.getResearchNode(pid, leadRoot).status !== 'done' ||
      store.researchLeads(pid, leadDossier, leadRoot).length !== 3)
    throw new Error('resuming a queued lead repeated finished work');
  const outageRoot = store.createResearchNode({ principalId: pid, dossierId: leadDossier,
    title: 'قطعی هنگام داوری' });
  store.createResearchNode({ principalId: pid, dossierId: leadDossier, parentId: outageRoot,
    title: 'شاهد اولیهٔ قطعی' });
  let outageWorkers = 0, outageMotherCalls = 0;
  const outageAsk = async ({ system, content }) => {
    if (system.includes('هماهنگ‌کننده')) {
      outageMotherCalls++;
      if (outageMotherCalls === 1) throw new Error('coordinator offline');
      const candidate = JSON.parse(content).leadCandidates?.[0];
      return { data: { summary: 'بررسی انجام شد', approved_leads: candidate
        ? [{ lead_id: candidate.id, role: 'local', reason: 'پیگیری شود' }] : [] } };
    }
    outageWorkers++;
    return { data: { summary: 'شاهد خوانده شد', findings: [],
      open_questions: outageWorkers === 1 ? ['منشأ این شاهد را چه کسی ثبت کرده است؟'] : [] } };
  };
  const waiting = await runResearchTeam({ principalId: pid, dossierId: leadDossier,
    nodeId: outageRoot, ask: outageAsk, search: leadSearch });
  if (waiting.pendingLeads !== 1 || store.getResearchNode(pid, outageRoot).status !== 'paused')
    throw new Error('coordinator outage discarded an unreviewed lead');
  await runResearchTeam({ principalId: pid, dossierId: leadDossier,
    nodeId: outageRoot, ask: outageAsk, search: leadSearch });
  if (outageWorkers !== 2 || store.getResearchNode(pid, outageRoot).status !== 'done' ||
      store.researchLeads(pid, leadDossier, outageRoot)[0]?.status !== 'approved')
    throw new Error('pending lead did not resume after coordinator recovery');
  const rejectedRoot = store.createResearchNode({ principalId: pid, dossierId: leadDossier,
    title: 'شناسهٔ ساختگی' });
  store.createResearchNode({ principalId: pid, dossierId: leadDossier, parentId: rejectedRoot,
    title: 'شاهد اولیهٔ دیگر' });
  await runResearchTeam({ principalId: pid, dossierId: leadDossier,
    nodeId: rejectedRoot, search: leadSearch,
    ask: async ({ system }) => system.includes('هماهنگ‌کننده')
      ? { data: { summary: 'داوری شد', approved_leads: [{ lead_id: 99999, role: 'web' }] } }
      : { data: { summary: 'سند خوانده شد', open_questions: ['منبع مستقل کجاست؟'] } } });
  if (store.researchLeads(pid, leadDossier, rejectedRoot)[0]?.status !== 'deferred' ||
      store.dossierResearchNodes(pid, leadDossier).filter((n) => n.parent_id === rejectedRoot).length !== 1)
    throw new Error('invented lead id became a new agent task');
  const formatRoot = store.createResearchNode({ principalId: pid, dossierId: leadDossier,
    title: 'بازبینی پاسخ ناقص مادر' });
  store.createResearchNode({ principalId: pid, dossierId: leadDossier, parentId: formatRoot,
    title: 'نقل اولیه' });
  let reviewCalls = 0, formatWorkers = 0;
  await runResearchTeam({ principalId: pid, dossierId: leadDossier,
    nodeId: formatRoot, search: leadSearch,
    ask: async ({ system, content }) => {
      if (system.includes('فقط دربارهٔ شناسه‌های')) {
        reviewCalls++;
        return { data: { approved_leads: [{
          lead_id: JSON.parse(content).leadCandidates[0].id, role: 'local', reason: 'مهم است' }] } };
      }
      if (system.includes('هماهنگ‌کننده')) return { data: { summary: 'جمع‌بندی',
        ...(formatWorkers > 1 ? { approved_leads: [] } : {}) } };
      formatWorkers++;
      return { data: { summary: 'خوانده شد', open_questions:
        formatWorkers === 1 ? ['آیا شاهد دوم مستقل است؟'] : [] } };
    } });
  if (reviewCalls !== 1 || formatWorkers !== 2 ||
      store.researchLeads(pid, leadDossier, formatRoot)[0]?.status !== 'approved')
    throw new Error('mother failed to recover from a missing lead-review field');
  const interrupted = store.createResearchNode({ principalId: pid, dossierId, title: 'کار قطع‌شده' });
  store.updateResearchNode(pid, interrupted, { status: 'running' });
  store.setResearchNodeStage(pid, interrupted, 'خواندن منبع');
  store.pauseInterruptedResearchNodes();
  if (store.getResearchNode(pid, interrupted).status !== 'paused' ||
      !store.getResearchNode(pid, interrupted).progress_stage.includes('آمادهٔ ادامه'))
    throw new Error('restart lost the agent checkpoint');
  console.log('research team check passed — parallel agents, mother-approved lead chain, bounded resume, isolation; 0 paid calls');
} finally {
  store.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
