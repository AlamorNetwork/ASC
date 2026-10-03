/** Free check: the mother agent owns planning; ordinary chat creates no intent. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-mother-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const { motherTurn, motherSourceContext, normalizePlan } = await import('../src/mother.js');
try {
  const pid = 'owner';
  let teamCalls = 0;
  const team = async ({ dossierId, nodeId }) => {
    teamCalls++;
    const nodes = store.dossierResearchNodes(pid, dossierId);
    if (!nodes.some((n) => n.id === nodeId && !n.parent_id) ||
        nodes.filter((n) => n.parent_id === nodeId).length !== 2)
      throw new Error('mother did not create its own root and children');
    return { summary: 'نتیجهٔ مقدماتی', openQuestions: ['منبع دوم؟'], incomplete: [] };
  };
  const plain = await motherTurn({ principalId: pid, userText: 'سلام، چطوری؟', team,
    ask: async () => ({ data: { action: 'respond', reply: 'سلام! آماده‌ام.' }, usage: {} }) });
  if (plain.text !== 'سلام! آماده‌ام.' || teamCalls || store.listDossiers(pid, 5).length)
    throw new Error('ordinary chat created research');
  const longText = 'آ'.repeat(9000);
  let receivedLength = 0;
  await motherTurn({ principalId: pid, userText: longText, team,
    ask: async ({ content }) => {
      receivedLength = JSON.parse(content).userMessage.length;
      return { data: { action: 'respond', reply: 'خواندم.' }, usage: {} };
    } });
  if (receivedLength !== longText.length) throw new Error('mother silently truncated a valid long message');
  const planned = await motherTurn({ principalId: pid, userText: 'برو دربارهٔ میترا تحقیق کن', team,
    ask: async () => ({ data: { action: 'research_team', goal: 'خاستگاه میترا',
      subtasks: [{ title: 'شاهد مستقیم', role: 'web' },
        { title: 'دیدگاه مخالف', role: 'web' }] }, usage: {} }) });
  const root = store.dossierResearchNodes(pid, planned.dossierId).find((n) => !n.parent_id);
  if (!root || teamCalls !== 1 || planned.text !== 'نتیجهٔ مقدماتی\n\nپرسش باز: منبع دوم؟')
    throw new Error('explicit research was not delegated');
  const resumed = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'ادامه بده', team,
    ask: async () => ({ data: { action: 'research_team', target_root_id: root.id,
      goal: 'خاستگاه میترا', subtasks: [] }, usage: {} }) });
  if (teamCalls !== 2 || resumed.dossierId !== planned.dossierId ||
      store.dossierResearchNodes(pid, planned.dossierId).length !== 3)
    throw new Error('resume duplicated intentions');
  const docId = Number(store.insertDocument({ principalId: pid, dossierId: planned.dossierId,
    filename: 'متن میترائیسم.pdf', kind: 'pdf', extraction: 'model_vision_pages', pages: 480,
    readPages: 20, charCount: 120 }));
  store.insertChunks(pid, planned.dossierId, docId, [
    { seq: 0, page: 4, text: 'در این بخش، میترائیسم در روم باستان و نقش آیین‌های رازآمیز بررسی شده است.' },
  ]);
  store.saveAnalysisSynthesis(pid, docId, 'hash', 'test-model',
    { overview: 'خلاصهٔ تحلیلیِ بخش خوانده‌شده؛ هنوز شاهد مستقل نیست.' });
  let packet;
  await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'در سند میترائیسم چه آمده؟', team,
    ask: async ({ content }) => { packet = JSON.parse(content); return {
      data: { action: 'respond', reply: 'صفحهٔ ۴ دربارهٔ میترائیسم است.' }, usage: {} }; } });
  const evidence = packet?.dossier?.evidence;
  if (!evidence?.sources?.some((s) => s.documentId === docId && s.title === 'متن میترائیسم.pdf' &&
      s.readPages === 20 && s.pages === 480 && s.overview.includes('خلاصهٔ تحلیلی')) ||
      !evidence.excerpts?.some((p) => p.page === 4 && p.text.includes('میترائیسم')))
    throw new Error('mother cannot see scoped source catalogue and read passages');
  if (!packet.dossier.agents?.some((n) => n.id === root.id && n.role === 'coordinator'))
    throw new Error('mother cannot see the work it delegated');
  if (!motherSourceContext(pid, planned.dossierId, 'دفترچه MD')?.ledger?.includes('دفترچهٔ تحقیق'))
    throw new Error('mother cannot read its research ledger');
  if (motherSourceContext('other', planned.dossierId, 'میترائیسم') !== null)
    throw new Error('mother read another principal\'s sources');
  const rejected = normalizePlan({ action: 'crawl_site', url: 'https://other.org/' },
    'این لینک را بخوان: https://example.org/');
  if (rejected.action !== 'respond') throw new Error('model-invented URL was accepted');
  const nonInstruction = normalizePlan({ action: 'research_team', goal: 'سلام' }, 'سلام، نظرت چیه؟');
  if (nonInstruction.action !== 'respond') throw new Error('ordinary chat launched research');
  const settings = await import('../src/settings.js');
  settings.setBudget(0);
  const blocked = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'برو دربارهٔ میترا تحقیق کن', team,
    ask: async () => ({ data: { action: 'research_team', goal: 'میترا',
      subtasks: [{ title: 'پرسش تازه', role: 'web' }] }, usage: {} }) });
  if (blocked.action.type !== 'budget_blocked' || teamCalls !== 2 ||
      store.dossierResearchNodes(pid, planned.dossierId).length !== 3)
    throw new Error('zero budget still started agents');
  if (store.dossierResearchNodes('other', planned.dossierId).length)
    throw new Error('other principal sees intentions');
  settings.setBudget(null);
  const queuedDossier = Number(store.insertDossier({ principalId: pid, topic: 'صف پژوهش' }));
  const queuedRoot = store.createResearchNode({ principalId: pid, dossierId: queuedDossier,
    title: 'مسیر پژوهش', assignedRole: 'coordinator' });
  const sourceNode = store.createResearchNode({ principalId: pid, dossierId: queuedDossier,
    parentId: queuedRoot, title: 'شاهد نخست' });
  const lead = store.recordResearchLead(pid, queuedDossier, queuedRoot, sourceNode,
    'آیا شاهد دوم مستقل است؟');
  const queuedChild = store.promoteResearchLead(pid, queuedDossier, lead.id,
    'web-researcher', 'مادر تأیید کرد');
  let resumedQueue = 0;
  const queueTeam = async ({ nodeId }) => {
    if (nodeId !== queuedRoot) throw new Error('wrong queued root resumed');
    resumedQueue++;
    return { summary: 'صف بررسی شد', incomplete: [queuedChild], pauseReason: 'followup_limit' };
  };
  const status = await motherTurn({ principalId: pid, dossierId: queuedDossier,
    userText: 'دو عامل در صف بررسی‌اند و مادر تأیید کرده؛ باید دوباره تأیید کنم؟',
    team: queueTeam, ask: async () => { throw new Error('status must use stored state'); } });
  if (!status.text.includes('تأیید دوباره') || resumedQueue)
    throw new Error('approved queue was described as requiring user approval');
  const idleStatus = await motherTurn({ principalId: pid, dossierId: queuedDossier,
    userText: 'عامل‌های در صف واقعاً دارن کار می‌کنن؟', team: queueTeam,
    ask: async () => ({ data: { action: 'respond', reply: 'بله، عامل‌ها الان فعال‌اند.' }, usage: {} }) });
  if (!idleStatus.text.includes('اجرا نشده') || resumedQueue)
    throw new Error('mother claimed queued agents are working while no job exists');
  const agentStatus = await motherTurn({ principalId: pid, dossierId: queuedDossier,
    userText: 'عامل‌ها کجای کارند؟', team: queueTeam,
    ask: async () => ({ data: { action: 'respond', reply: 'الان مشغول تحقیق هستند.' }, usage: {} }) });
  if (!agentStatus.text.includes('اجرا نشده') || resumedQueue)
    throw new Error('mother relied on model fiction for a queued agent status question');
  const continueQueued = await motherTurn({ principalId: pid, dossierId: queuedDossier,
    userText: 'ادامه بده', team: queueTeam,
    ask: async () => { throw new Error('resume must not depend on planner'); } });
  if (resumedQueue !== 1 || continueQueued.action.nodeId !== queuedRoot ||
      !continueQueued.text.includes('سقف دورهای خودکار') ||
      store.dossierResearchNodes(pid, queuedDossier).length !== 3)
    throw new Error('mother did not resume approved queue from the original root');
  const reviewDossier = Number(store.insertDossier({ principalId: pid, topic: 'کتاب استرابو' }));
  const reviewRoot = store.createResearchNode({ principalId: pid, dossierId: reviewDossier,
    title: 'تحقیق کتاب یازدهم', assignedRole: 'coordinator' });
  const reviewedSource = store.createResearchNode({ principalId: pid, dossierId: reviewDossier,
    parentId: reviewRoot, title: 'شاهد نخست' });
  store.updateResearchNode(pid, reviewedSource, { status: 'done', result: { summary: 'گزارش ثبت شد' } });
  const pendingLead = store.recordResearchLead(pid, reviewDossier, reviewRoot, reviewedSource,
    'آیا گزارش استرابو با متن کتاب سازگار است؟');
  store.updateResearchNode(pid, reviewRoot, { status: 'paused', result: { pendingLeads: 1 } });
  let reviewCalls = 0;
  const reviewTeam = async ({ nodeId }) => {
    if (nodeId !== reviewRoot) throw new Error('wrong pending-lead root resumed');
    reviewCalls++;
    return { summary: 'بازبینی سرنخ انجام شد', pendingLeads: 0, incomplete: [] };
  };
  const reviewStatus = await motherTurn({ principalId: pid, dossierId: reviewDossier,
    userText: 'الان عامل‌ها شروع به کار کردن؟', team: reviewTeam,
    ask: async () => { throw new Error('status must use actual nodes and leads'); } });
  if (!reviewStatus.text.includes('هیچ عاملی') || !reviewStatus.text.includes('1 سرنخ') || reviewCalls)
    throw new Error('mother invented active agents while leads await review');
  const activated = await motherTurn({ principalId: pid, dossierId: reviewDossier,
    userText: 'بله لطفا فعالش کن', team: reviewTeam,
    ask: async () => { throw new Error('explicit activation must dispatch, not just say yes'); } });
  if (reviewCalls !== 1 || activated.action.nodeId !== reviewRoot ||
      store.researchLeads(pid, reviewDossier)[0].id !== pendingLead.id)
    throw new Error('activation failed to dispatch the paused root with pending leads');
  const resumedReview = await motherTurn({ principalId: pid, dossierId: reviewDossier,
    userText: 'الان شروع به کار کردن؟ اگر نکرده‌اید ادامه بده', team: reviewTeam,
    ask: async () => { throw new Error('conditional continuation must dispatch'); } });
  if (reviewCalls !== 2 || resumedReview.action.nodeId !== reviewRoot)
    throw new Error('conditional continuation did not resume pending-lead review');
  const inventedStart = await motherTurn({ principalId: pid, dossierId: reviewDossier,
    userText: 'خب چه خبر؟', team: reviewTeam,
    ask: async () => ({ data: { action: 'respond', reply: 'تحقیق شروع شد و عامل‌ها فعال شدند.' }, usage: {} }) });
  if (reviewCalls !== 2 || !inventedStart.text.includes('کاری شروع نشده'))
    throw new Error('a conversational reply falsely announced agent execution');
  console.log('mother check passed — conversation, autonomous plan, resume, URL gate, isolation; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
