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
        nodes.filter((n) => n.parent_id === nodeId).length < 2)
      throw new Error('mother did not create its own root and children');
    return { summary: 'نتیجهٔ مقدماتی', openQuestions: ['منبع دوم؟'], incomplete: [] };
  };
  const plain = await motherTurn({ principalId: pid, userText: 'سلام، چطوری؟', team,
    ask: async () => ({ data: { action: 'respond', reply: 'سلام! آماده‌ام.' }, usage: {} }) });
  if (plain.text !== 'سلام! آماده‌ام.' || teamCalls || store.listDossiers(pid, 5).length)
    throw new Error('ordinary chat created research');
  const evidenceRequest = 'هرودوت در کتاب ۱ چه می‌گوید؟ منبع و عبارت شاهد را بیاور.';
  const evidencePlan = normalizePlan({ action: 'respond', reply: 'از حافظه پاسخ می‌دهم.' }, evidenceRequest);
  if (evidencePlan.action !== 'research_team' || evidencePlan.subtasks[0]?.role !== 'web-researcher')
    throw new Error('explicit source request was answered from model memory');
  const mixedPlan = normalizePlan({ action: 'respond' }, 'یک نمونهٔ مستند خلاف آن پیدا کن', { hasDocs: true });
  if (mixedPlan.subtasks.length !== 2 || mixedPlan.subtasks[0].title === mixedPlan.subtasks[1].title ||
      mixedPlan.subtasks[1].role !== 'web-researcher')
    throw new Error('source request with a dossier did not search local and web evidence');
  const disputePlan = normalizePlan({ action: 'respond' },
    'شواهد ارتباط و دلایل مخالفت با تداوم مستقیم را جدا کن و بگو پژوهشگران چه نتیجه‌ای گرفته‌اند.');
  if (disputePlan.action !== 'research_team')
    throw new Error('explicit comparison of evidence was treated as casual chat');
  const clarified = await motherTurn({ principalId: pid, userText: 'کدام نسخه را بخوانی؟', team,
    ask: async () => ({ data: { action: 'respond', reply: 'برای انتخاب متن، یک نکته لازم است.',
      clarification: { question: 'کدام نسخه را بررسی کنم؟', options: ['نسخهٔ فارسی', 'نسخهٔ اصلی'] } }, usage: {} }) });
  const savedPrompt = store.conversation(pid, null).at(-1);
  if (clarified.action.type !== 'clarification' || teamCalls ||
      JSON.parse(savedPrompt.prompt_json || 'null')?.options?.[0] !== 'نسخهٔ فارسی')
    throw new Error('mother clarification was not saved for the answer box');
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
  if (!root || teamCalls !== 1 || !planned.text.includes('نتیجهٔ مقدماتی\n\nپرسش باز: منبع دوم؟'))
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
  if (rejected.action !== 'crawl_site' || rejected.url !== 'https://example.org/')
    throw new Error('a user-supplied URL was replaced by a model-invented URL');
  const noCrawl = normalizePlan({ action: 'crawl_site', url: 'https://other.org/' },
    'این یک مثال است: https://example.org/');
  if (noCrawl.action !== 'respond') throw new Error('a bare example URL was crawled');
  let siteCalls = 0;
  const site = async ({ url, dossierId }) => {
    siteCalls++;
    if (url !== 'https://example.org/page' || !dossierId) throw new Error('wrong page or dossier');
    return { crawlId: 1, pagesSaved: 1, done: true, errors: [] };
  };
  const opened = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'این لینک رو ببین https://example.org/page', crawl: site,
    ask: async () => { throw new Error('explicit URL must not wait for the planner'); } });
  if (opened.action.type !== 'site_collected' || siteCalls !== 1)
    throw new Error('mother promised to open a page without doing it');
  const followup = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: 'بله، صفحه را بخوان', crawl: site,
    ask: async () => { throw new Error('page followup must reuse the user URL'); } });
  if (followup.action.type !== 'site_collected' || siteCalls !== 2)
    throw new Error('mother forgot the page in the previous user message');
  const groundedUrl = 'https://example.org/mithraeum';
  const groundedText = 'The Mithraeum was built entirely above ground, rather than underground. ' +
    'The preserved walls show a purpose-built meeting room.';
  const grounded = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: `این صفحه را بخوان و بگو زیرزمینی بود؟ عبارت شاهد و وضعیت ادعا را بیاور: ${groundedUrl}`,
    crawl: async ({ dossierId }) => {
      store.saveCrawledPage({ principalId: pid, dossierId, url: groundedUrl,
        title: 'Mithraeum', text: groundedText, chunks: [groundedText] });
      return { pagesSaved: 1, done: true, errors: [],
        firstPage: { url: groundedUrl, title: 'Mithraeum', characters: groundedText.length, via: 'direct' } };
    },
    ask: async () => ({ data: { answer: 'روی زمین ساخته شده بود.',
      claim: 'این مهرابه روی زمین ساخته شده بود.', verdict: 'supported',
      quote: 'The Mithraeum was built entirely above ground' }, usage: {} }),
  });
  if (!grounded.text.includes('The Mithraeum was built entirely above ground') ||
      !grounded.text.includes('روی زمین') ||
      !store.dossierClaims(pid, planned.dossierId).some((c) => c.source_url === groundedUrl && c.status === 'verified'))
    throw new Error('mother saved a page but did not answer the user from its checked text');
  const madeUp = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: `این صفحه را بررسی کن؛ آیا زیرزمینی بود؟ ${groundedUrl}`,
    crawl: async () => ({ pagesSaved: 1, done: true, errors: [] }),
    ask: async () => ({ data: { answer: 'زیرزمین بود.', claim: 'این مهرابه زیرزمینی بود.',
      verdict: 'supported', quote: 'This Mithraeum was entirely underground' }, usage: {} }),
  });
  if (!madeUp.text.includes('نامعلوم') ||
      store.dossierClaims(pid, planned.dossierId).at(-1).status === 'verified')
    throw new Error('an unsupported page quote was promoted to verified');
  const axesDossier = Number(store.insertDossier({ principalId: pid, topic: 'پژوهش تطبیقی عدد دوازده' }));
  const unrelatedRoot = store.createResearchNode({ principalId: pid, dossierId: axesDossier,
    title: 'پژوهش قدیمی دربارهٔ اسارت بابلی' });
  store.updateResearchNode(pid, unrelatedRoot, { status: 'paused', openQuestion: 'منبع بابلی؟' });
  store.addMessage({ principalId: pid, dossierId: axesDossier, role: 'assistant',
    text: 'سه محور را پیشنهاد می‌کنم: ۱. نمادهای زودیاک در مهرابه‌های رومی ۲. منشأ دوازده حواری و دوازده سبط ۳. منشأ دوازده امام در سنت امامیه. اگر موافق باشید، پژوهش را آغاز کنیم.' });
  let axesRoot = null;
  const axesTeam = async ({ nodeId }) => {
    axesRoot = nodeId;
    const children = store.dossierResearchNodes(pid, axesDossier).filter((n) => n.parent_id === nodeId);
    if (children.length !== 3 || !children[0].title.includes('زودیاک') ||
        !children[1].title.includes('حواری') || !children[2].title.includes('امام'))
      throw new Error('approved three axes were replaced with another research topic');
    store.updateResearchNode(pid, nodeId, { status: 'paused', openQuestion: 'سه محور ناتمام' });
    return { summary: 'سه محور ثبت شد', incomplete: children.map((n) => n.id) };
  };
  const approvedAxes = await motherTurn({ principalId: pid, dossierId: axesDossier,
    userText: 'بله لطفا هر 3 را موازی ببر جلو', team: axesTeam,
    ask: async () => ({ data: { action: 'respond', reply: 'پژوهش برای هر سه محور کلید خورد.' }, usage: {} }) });
  if (!axesRoot || axesRoot === unrelatedRoot || approvedAxes.action.nodeId !== axesRoot)
    throw new Error('clear approval produced only a false start message');
  const resumedAxes = await motherTurn({ principalId: pid, dossierId: axesDossier,
    userText: 'ادامه بده', team: axesTeam,
    ask: async () => { throw new Error('a recent explicit research root should resume without guessing'); } });
  if (resumedAxes.action.nodeId !== axesRoot)
    throw new Error('continue resumed the unrelated older research root');
  const falseStart = await motherTurn({ principalId: pid, dossierId: axesDossier,
    userText: 'از این محور چه می‌دانی؟', team: async () => {
      throw new Error('ordinary chat should not start a team');
    }, ask: async () => ({ data: { action: 'respond', reply: 'پژوهش برای این محور کلید خورد.' }, usage: {} }) });
  if (!falseStart.text.includes('کاری شروع نشده است'))
    throw new Error('a fake research-start claim reached the user');
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
  const documentReview = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: `نیت اصلی #${root.id} را با سند «The Cult of Mithras in Ostia»، به‌ویژه صفحات ۳۵۷ و ۳۵۸، دوباره بررسی کن. مهرابهٔ خانهٔ دیانا را با دورا-اروپوس مقایسه کن و برای هرکدام عبارت دقیق شاهد و صفحه بیاور.`,
    team, crawl: async () => { throw new Error('a document page number reopened the previous website'); },
    ask: async () => { throw new Error('a named existing intention needs no fresh routing call'); } });
  if (documentReview.action.type !== 'team_completed' || documentReview.action.nodeId !== root.id ||
      teamCalls !== 3)
    throw new Error('review of a named document did not resume its research intention');
  const shortReview = await motherTurn({ principalId: pid, dossierId: planned.dossierId,
    userText: `بررسی نیت #${root.id}`, team,
    ask: async () => ({ data: { action: 'respond', reply: 'نیت مکث کرده است؛ آیا ادامه دهم؟' }, usage: {} }) });
  if (shortReview.action.nodeId !== root.id || teamCalls !== 4)
    throw new Error('short review command only reported paused status');
  const freshDossier = Number(store.insertDossier({ principalId: pid, topic: 'مهرابه‌های روزمینی' }));
  const freshRoot = store.createResearchNode({ principalId: pid, dossierId: freshDossier,
    title: 'نمونهٔ دوم مهرابهٔ روزمینی', assignedRole: 'coordinator' });
  store.createResearchNode({ principalId: pid, dossierId: freshDossier, parentId: freshRoot,
    title: 'جست‌وجوی وب پیشین', assignedRole: 'web-researcher' });
  store.updateResearchNode(pid, freshRoot, { status: 'paused', result: { summary: 'فقط دورااروپوس' } });
  const newDoc = Number(store.insertDocument({ principalId: pid, dossierId: freshDossier,
    filename: 'The Cult of Mithras in Ostia.pdf', kind: 'pdf', extraction: 'local', pages: 11 }));
  store.insertChunks(pid, freshDossier, newDoc, [{ seq: 0, page: 7,
    text: 'Most Mithraea in Ostia were not underground sanctuaries.' }]);
  let freshRuns = 0;
  const freshTeam = async ({ nodeId }) => {
    if (nodeId !== freshRoot) throw new Error('fresh document was sent to another root');
    freshRuns++;
    const targets = store.dossierResearchNodes(pid, freshDossier)
      .filter((n) => n.target_document_id === newDoc);
    if (targets.length !== 1 || targets[0].status !== 'pending')
      throw new Error('newly imported document did not get one targeted research task');
    return { summary: 'سند تازه در صف تحلیل قرار گرفت', incomplete: [] };
  };
  for (let i = 0; i < 2; i++) await motherTurn({ principalId: pid, dossierId: freshDossier,
    userText: `بررسی نیت #${freshRoot}`, team: freshTeam,
    ask: async () => ({ data: { action: 'respond', reply: 'آیا ادامه بدهم؟' }, usage: {} }) });
  if (freshRuns !== 2) throw new Error('named research root did not run');
  const quoted = await motherTurn({ principalId: pid, dossierId: freshDossier,
    userText: `بررسی نیت #${freshRoot}`,
    team: async () => ({ summary: 'مهرابهٔ خانهٔ دیانا در طبقهٔ همکف بود.',
      rootAssessment: { status: 'supported_by_source',
        claim: 'بیشتر مهرابه‌های اوستیا زیرزمینی نبودند.',
        quote: 'Most Mithraea in Ostia were not underground sanctuaries.',
        documentId: newDoc, page: 7 },
      reports: [{ question: 'سند اوستیا', report: { findings: [{
        documentId: newDoc, page: 7,
        quote: 'Most Mithraea in Ostia were not underground sanctuaries.' }] } }],
      incomplete: [999], pauseReason: 'no_actionable_lead' }),
    ask: async () => ({ data: { action: 'respond', reply: 'آیا ادامه دهم؟' }, usage: {} }) });
  if (!quoted.text.includes('The Cult of Mithras in Ostia.pdf') ||
      !quoted.text.includes('صفحه 7') ||
      !quoted.text.includes('Most Mithraea in Ostia were not underground sanctuaries.') ||
      !quoted.text.includes('پرسش اصلی: پاسخ با نقل‌قول منطبق') ||
      quoted.text.includes('هنوز شاهد یا مسیر تازه') ||
      !quoted.text.includes('جمع‌بندی مقدماتی'))
    throw new Error('mother hid the checked quote behind an overconfident summary and stale pause message');
  console.log('mother check passed — conversation, autonomous plan, resume, URL gate, isolation; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
