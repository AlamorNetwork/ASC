/** Free web smoke test. Uses its own SQLite file and never calls a model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-web-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
process.env.WEB_PASSWORD = 'this-is-a-test-password-only';
process.env.WEB_ORIGIN = 'https://asc.alamornetwork.ir';
process.env.WEB_PRINCIPAL_ID = 'test-web-owner';
const { createWebServer, visionPlan, deepCeiling } = await import('../src/web.js');
const { motherSourceContext, motherTurn } = await import('../src/mother.js');
const { ingestToDossier } = await import('../src/ingest.js');
const library = await import('../src/book-library.js');
const store = await import('../src/db.js');
const settings = await import('../src/settings.js');
const { db } = store;
let resumedTeam = null;
const server = createWebServer({ runTeam: async (input) => {
  resumedTeam = input;
  const child = store.dossierResearchNodes(input.principalId, input.dossierId)
    .find((node) => node.parent_id === input.nodeId && node.status === 'pending');
  if (!child) throw new Error('approved follow-up was not available to the worker');
  store.updateResearchNode(input.principalId, child.id, { status: 'done', result: { summary: 'بررسی شد' } });
  store.updateResearchNode(input.principalId, input.nodeId, { status: 'done', result: { summary: 'گزارش' } });
  input.onProgress('عامل تأییدشده اجرا شد');
  return { summary: 'گزارش', incomplete: [] };
} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const origin = process.env.WEB_ORIGIN;
try {
  if (visionPlan({ visionMode: 'all' }).pageLimit !== null || !visionPlan({ visionMode: 'all' }).allowVision)
    throw new Error('read to end still has a hidden page limit');
  if (visionPlan({ visionMode: 'batch' }).pageLimit !== 20)
    throw new Error('20-page cost-control mode changed');
  if (deepCeiling(0.16) !== 0.16 || ![0, -1, 21, null, '0.16'].every((x) => {
    try { deepCeiling(x); return false; } catch { return true; }
  })) throw new Error('deep research can start without an explicit bounded ceiling');
  const page = await fetch(url);
  const markup = await page.text();
  if (page.status !== 200 || !markup.includes('اطلس پژوهش') ||
      !markup.includes('id="tab-deep"') || !markup.includes('id="investigation-status"'))
    throw new Error('web research controls are missing');
  for (const [asset, contentType] of [['atlas.png', 'image/png'], ['vazirmatn.woff2', 'font/woff2']]) {
    const response = await fetch(`${url}/${asset}`);
    if (response.status !== 200 || !response.headers.get('content-type')?.includes(contentType) ||
        (await response.arrayBuffer()).byteLength < 1000)
      throw new Error(`web design asset ${asset} is unavailable`);
  }
  if (!markup.includes('id="tab-chat"') || markup.includes('id="tab-research"') ||
      markup.includes('id="research-node-form"'))
    throw new Error('web chat still requires manual research routing');
  for (const id of ['library-page', 'agents-page', 'evidence-page', 'library-search', 'storm-tree'])
    if (!markup.includes(`id="${id}"`)) throw new Error(`workspace page ${id} is missing`);
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  if (!script.includes('data-resume-root') || !script.includes('/api/research-nodes/run'))
    throw new Error('approved queued agents have no direct resume control');
  const htmlIds = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
  const dynamicIds = new Set([...script.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const absent = [...referencedIds].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
  if (absent.length) throw new Error(`web script refers to missing DOM ids: ${absent.join(', ')}`);
  const denied = await fetch(`${url}/api/state`);
  if (denied.status !== 401) throw new Error('unauthenticated state was exposed');
  const deniedProgress = await fetch(`${url}/api/research-progress?dossierId=1`);
  if (deniedProgress.status !== 401) throw new Error('unauthenticated agent progress was exposed');
  const privateReport = await fetch(`${url}/api/document-analysis?documentId=1`);
  if (privateReport.status !== 401) throw new Error('unauthenticated analysis was exposed');
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.WEB_PASSWORD }) });
  if (login.status !== 200) throw new Error(`login ${login.status}: ${await login.text()}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const chatHeaders = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const oversizedMessage = await fetch(`${url}/api/chat`, { method: 'POST',
    headers: chatHeaders, body: JSON.stringify({ message: 'آ'.repeat(40000) }) });
  const rejected = await oversizedMessage.json();
  if (oversizedMessage.status !== 413 || !rejected.error?.includes('بزرگ'))
    throw new Error(`oversized message did not receive a clear HTTP 413: ${oversizedMessage.status} ${rejected.error}`);
  const excessiveText = await fetch(`${url}/api/chat`, { method: 'POST',
    headers: chatHeaders, body: JSON.stringify({ message: 'آ'.repeat(20000) }) });
  const rejectedText = await excessiveText.json();
  if (excessiveText.status !== 413 || !rejectedText.error?.includes('نویسه'))
    throw new Error('message over the text limit was truncated or sent to a model');
  const longerMessage = await fetch(`${url}/api/chat`, { method: 'POST',
    headers: chatHeaders, body: JSON.stringify({ message: 'آ'.repeat(9000), dossierId: 999999 }) });
  if (longerMessage.status !== 400 || !(await longerMessage.json()).error?.includes('پرونده'))
    throw new Error('a valid long Persian message was stopped by the transport limit');
  store.addMessage({ principalId: 'test-web-owner', dossierId: null, role: 'user', text: 'سلام' });
  const state = await fetch(`${url}/api/state`, { headers: { Cookie: cookie } });
  if (state.status !== 200 || !(await state.json()).messages.some((m) => m.text === 'سلام'))
    throw new Error('ordinary chat history disappeared after refresh');
  const planCase = Number(store.insertDossier({ principalId: 'test-web-owner', topic: 'پرسش پژوهشی' }));
  const newNode = await fetch(`${url}/api/research-nodes`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dossierId: planCase, title: 'چه شواهدی داریم؟' }) });
  if (newNode.status !== 201) throw new Error(`research node ${newNode.status}`);
  const nodeId = (await newNode.json()).id;
  store.setResearchNodeStage('test-web-owner', nodeId, 'جست‌وجوی متن اسناد پرونده');
  const lead = store.recordResearchLead('test-web-owner', planCase, nodeId, nodeId,
    'منشأ این روایت در سند چیست؟');
  const followupId = store.promoteResearchLead('test-web-owner', planCase, lead.id,
    'source-analyst', 'پرسش از سند قابل پیگیری است');
  const live = await fetch(`${url}/api/research-progress?dossierId=${planCase}`, { headers: { Cookie: cookie } });
  const liveData = await live.json();
  const liveNodes = liveData.nodes;
  if (live.status !== 200 || !liveNodes.some((n) => n.id === nodeId &&
      n.progress_stage === 'جست‌وجوی متن اسناد پرونده') ||
      !liveNodes.some((n) => n.id === followupId && n.parent_id === nodeId) ||
      !liveData.leads.some((item) => item.id === lead.id && item.child_node_id === followupId) ||
      liveNodes.some((n) => 'result_json' in n))
    throw new Error('agent checkpoint is not live in the web API');
  settings.setBudget(0);
  const blockedResume = await fetch(`${url}/api/research-nodes/run`, { method: 'POST',
    headers: chatHeaders, body: JSON.stringify({ nodeId }) });
  if (blockedResume.status !== 400 || resumedTeam)
    throw new Error('zero budget still dispatched the queued research team');
  settings.setBudget(null);
  const resume = await fetch(`${url}/api/research-nodes/run`, { method: 'POST',
    headers: chatHeaders, body: JSON.stringify({ nodeId }) });
  if (resume.status !== 202) throw new Error(`approved queue could not start: ${resume.status}`);
  const resumeId = (await resume.json()).id;
  const resumedJob = await fetch(`${url}/api/jobs/${resumeId}`, { headers: { Cookie: cookie } });
  const resumedData = await resumedJob.json();
  if (resumedData.state !== 'done' || resumedData.stage !== 'عامل تأییدشده اجرا شد' ||
      resumedTeam?.nodeId !== nodeId || store.getResearchNode('test-web-owner', followupId).status !== 'done')
    throw new Error('resume control did not actually dispatch the approved agent');
  const otherDossier = Number(store.insertDossier({ principalId: 'another-owner', topic: 'private' }));
  const foreignProgress = await fetch(`${url}/api/research-progress?dossierId=${otherDossier}`, { headers: { Cookie: cookie } });
  if (foreignProgress.status === 200) throw new Error('other principal agent progress was exposed');
  const planState = await fetch(`${url}/api/state?dossierId=${planCase}`, { headers: { Cookie: cookie } });
  const planData = await planState.json();
  if (!planData.researchNodes?.some((n) => n.id === nodeId) || !Array.isArray(planData.sources))
    throw new Error('research tree or source catalogue not returned');
  const active = await fetch(`${url}/api/active-job`, { headers: { Cookie: cookie } });
  if (active.status !== 200 || (await active.json()).job !== null) throw new Error('idle status failed');
  const missingDocument = await fetch(`${url}/api/analyze-document`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId: 999 }) });
  if (missingDocument.status !== 400) throw new Error('unknown document was analyzed');
  const blocked = await fetch(`${url}/api/upload?name=book.pdf`, { method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://wrong.example', 'X-CSRF-Token': csrf }, body: 'pdf' });
  if (blocked.status !== 403) throw new Error('cross-origin upload was accepted');
  // These requests test upload visibility and dossier routing. A fake .pdf would
  // start real pdftotext work in the background and race the test database teardown.
  const upload = await fetch(`${url}/api/upload?name=book.txt`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'txt' });
  if (upload.status !== 201) throw new Error(`upload ${upload.status}: ${await upload.text()}`);
  const meta = await upload.json();
  if (meta.size !== 3) throw new Error('upload bytes were not saved');
  const uploadedState = await fetch(`${url}/api/state?dossierId=${meta.dossierId}`, { headers: { Cookie: cookie } });
  const pendingState = await uploadedState.json();
  const motherEvidence = motherSourceContext('test-web-owner', meta.dossierId, 'چه کتابی داری؟');
  if (!pendingState.pendingUploads?.some((file) => file.id === meta.id) ||
      !motherEvidence?.pendingUploads?.some((file) => file.id === meta.id) ||
      motherEvidence.sourceCount !== 0)
    throw new Error('raw upload was hidden from mother or mistaken for a readable source');
  const pendingAnswer = await motherTurn({ principalId: 'test-web-owner', dossierId: meta.dossierId,
    userText: 'به چه فایل‌هایی دسترسی داری؟', ask: async () => {
      throw new Error('inventory of unread uploads must not call a model');
    } });
  if (!pendingAnswer.text.includes('book.txt') || !pendingAnswer.text.includes('هنوز'))
    throw new Error('mother did not explain that uploaded book has not been read');
  const sampleDoc = Number(store.insertDocument({ principalId: 'test-web-owner',
    dossierId: meta.dossierId, filename: 'notes.txt', kind: 'text', extraction: 'local' }));
  store.insertChunks('test-web-owner', meta.dossierId, sampleDoc, [
    { seq: 0, page: 1, text: 'این گذرگاه واقعی دربارهٔ محتوای سند آزمایشی است.' },
  ]);
  if (!motherSourceContext('test-web-owner', meta.dossierId, 'چه فایل‌هایی داری؟')
    .excerpts.some((p) => p.documentId === sampleDoc && p.text.includes('گذرگاه واقعی')))
    throw new Error('mother did not receive stored content for an inventory question');
  const emptyCase = Number(store.insertDossier({ principalId: 'test-web-owner', topic: 'پروندهٔ دیگر' }));
  const otherState = await fetch(`${url}/api/state?dossierId=${emptyCase}`, { headers: { Cookie: cookie } });
  if (!(await otherState.json()).otherDossierDocuments.some((d) => d.id === sampleDoc &&
      d.dossierId === meta.dossierId))
    throw new Error('book stored in another dossier is invisible in the web state');
  const elsewhereAnswer = await motherTurn({ principalId: 'test-web-owner', dossierId: emptyCase,
    userText: 'چه سندهایی داری؟', ask: async () => {
      throw new Error('cross-dossier inventory must not call a model');
    } });
  if (!elsewhereAnswer.text.includes('notes.txt') || !elsewhereAnswer.text.includes('پرونده'))
    throw new Error('mother did not point to the dossier holding the document');
  const files = await fetch(`${url}/api/uploads`, { headers: { Cookie: cookie } });
  if (!(await files.json()).some((x) => x.id === meta.id)) throw new Error('upload not recoverable');
  const dossierId = Number(store.insertDossier({ principalId: 'test-web-owner', topic: 'یک پرونده برای چند کتاب', state: 'open' }));
  const select = await fetch(`${url}/api/select-dossier`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dossierId }) });
  if (select.status !== 200) throw new Error('dossier selection failed');
  const reopened = await fetch(`${url}/api/state`, { headers: { Cookie: cookie } });
  if ((await reopened.json()).selected?.id !== dossierId) throw new Error('selected dossier did not survive refresh');
  const runId = Number(store.startInvestigation({ principalId: 'test-web-owner', dossierId,
    question: 'پرسش ناتمام', leads: ['سرنخ ذخیره‌شده'] }));
  store.saveInvestigation(runId, { state: 'paused', stopped: 'ceiling', rounds: 2,
    leads: ['سرنخ ذخیره‌شده'], costUsd: 0.16, costToman: 2000 });
  const withRun = await fetch(`${url}/api/state?dossierId=${dossierId}`, { headers: { Cookie: cookie } });
  const savedRun = (await withRun.json()).investigation;
  if (savedRun?.id !== runId || savedRun.rounds !== 2 || savedRun.nextLeads[0] !== 'سرنخ ذخیره‌شده')
    throw new Error('resumable investigation is not visible in web state');
  const refusedDeep = await fetch(`${url}/api/deep/resume`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, ceilingUsd: 0 }) });
  if (refusedDeep.status !== 400) throw new Error('zero-ceiling deep run was accepted');
  const refusedStart = await fetch(`${url}/api/deep`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dossierId, question: 'کاوش آزمایشی', ceilingUsd: 0 }) });
  if (refusedStart.status !== 400) throw new Error('zero-ceiling new investigation was accepted');
  const interrupted = Number(store.startInvestigation({ principalId: 'test-web-owner', dossierId,
    question: 'کاوش وب', leads: ['سرنخ بعدی'] }));
  const otherDossierId = Number(store.insertDossier({ principalId: 'another-user', topic: 'پرونده جدا' }));
  const otherPrincipal = Number(store.startInvestigation({ principalId: 'another-user', dossierId: otherDossierId,
    question: 'کاربر دیگر', leads: ['جدا'] }));
  if (store.pauseInterruptedInvestigation('test-web-owner', interrupted) !== 1 ||
      store.getInvestigation('test-web-owner', interrupted).state !== 'paused' ||
      store.getInvestigation('another-user', otherPrincipal).state !== 'running')
    throw new Error('web recovery paused the wrong investigation');
  for (const filename of ['first.txt', 'second.txt']) {
    const saved = await fetch(`${url}/api/upload?name=${filename}&dossierId=${dossierId}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'txt' });
    if (saved.status !== 201 || (await saved.json()).dossierId !== dossierId)
      throw new Error(`${filename} was not bound to the selected dossier`);
  }
  const fresh = await fetch(`${url}/api/state?fresh=1`, { headers: { Cookie: cookie } });
  if ((await fresh.json()).selected !== null) throw new Error('explicit new dossier view was lost');
  const freshUpload = await fetch(`${url}/api/upload?name=unrelated.txt&newDossier=1`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'txt' });
  const freshMeta = await freshUpload.json();
  if (freshUpload.status !== 201 || !freshMeta.dossierId || freshMeta.dossierId === dossierId)
    throw new Error('new dossier upload inherited the old dossier');
  const afterFresh = await fetch(`${url}/api/state`, { headers: { Cookie: cookie } });
  if ((await afterFresh.json()).selected?.id !== freshMeta.dossierId)
    throw new Error('new dossier did not become the active dossier');
  const nextFile = await fetch(`${url}/api/upload?name=related.txt&dossierId=${freshMeta.dossierId}`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'txt' });
  if (nextFile.status !== 201 || (await nextFile.json()).dossierId !== freshMeta.dossierId)
    throw new Error('second file did not join the new dossier');
  const savedFetch = globalThis.fetch;
  let networkCalls = 0;
  let localResult;
  try {
    globalThis.fetch = async () => { networkCalls++; throw new Error('unexpected paid call'); };
    localResult = await ingestToDossier({ principalId: 'test-web-owner', dossierId,
      buffer: Buffer.from('این متن محلی به قدر کافی بلند است که در فهرست قابل جست‌وجو ذخیره شود. '.repeat(5)),
      filename: 'local.txt', mime: 'text/plain', localOnly: true });
  } finally { globalThis.fetch = savedFetch; }
  if (!localResult.documentId || !store.documentChunks('test-web-owner', localResult.documentId).length || networkCalls)
    throw new Error('local import did not create searchable text without a model call');
  const indexFile = path.join(temp, 'check-ledgers', 'test-web-owner', 'sources.md');
  if (!fs.readFileSync(indexFile, 'utf8').includes('local.txt'))
    throw new Error('new text import did not refresh the global source Markdown');
  for (let i = 0; i < 20; i++) {
    const doc = Number(store.insertDocument({ principalId: 'test-web-owner', dossierId: emptyCase,
      filename: `new-source-${i}.txt`, kind: 'text', extraction: 'local' }));
    store.insertChunks('test-web-owner', emptyCase, doc, [{ seq: 0, page: null,
      text: i === 19 ? 'نشانگرمنحصربهفرد سند آخر برای جست‌وجوی سراسری مادر' : `متن منبع شماره ${i}` }]);
  }
  library.refreshLibraryIndex('test-web-owner');
  const sourceMarkdown = fs.readFileSync(indexFile, 'utf8');
  if (!sourceMarkdown.includes('new-source-0.txt') || !sourceMarkdown.includes('new-source-19.txt'))
    throw new Error('global source Markdown omitted newly imported documents');
  const allInventory = await motherTurn({ principalId: 'test-web-owner', dossierId,
    userText: 'لیست همه فایل‌ها و منابعی که داریم را بده', ask: async () => {
      throw new Error('source inventory must not call a model');
    } });
  if (!allInventory.text.includes('new-source-0.txt') || !allInventory.text.includes('new-source-19.txt') ||
      !allInventory.text.includes(`پرونده #${emptyCase}`))
    throw new Error('mother cannot see 20 new documents across dossiers');
  const crossEvidence = motherSourceContext('test-web-owner', dossierId, 'نشانگرمنحصربهفرد');
  if (!crossEvidence.excerpts.some((item) => item.dossierId === emptyCase &&
      item.text.includes('نشانگرمنحصربهفرد')) ||
      motherSourceContext('another-owner', otherDossierId, 'نشانگرمنحصربهفرد')?.excerpts.some((item) =>
        item.text.includes('نشانگرمنحصربهفرد')))
    throw new Error('mother cross-dossier retrieval is missing or crossed owner boundary');
  const twinHash = 'f'.repeat(64);
  const targetPdf = Number(store.insertDocument({ principalId: 'test-web-owner', dossierId,
    filename: 'shared.pdf', kind: 'pdf', extraction: 'local', sha256: twinHash, pages: 1 }));
  const survivorPdf = Number(store.insertDocument({ principalId: 'test-web-owner', dossierId: emptyCase,
    filename: 'shared.pdf', kind: 'pdf', extraction: 'local', sha256: twinHash, pages: 1 }));
  store.insertChunks('test-web-owner', dossierId, targetPdf,
    [{ seq: 0, page: 1, text: 'ردپاک‌کردنویژه متن اختصاصی پرونده قابل حذف' }]);
  store.insertChunks('test-web-owner', emptyCase, survivorPdf,
    [{ seq: 0, page: 1, text: 'متن نسخه مشترک در پرونده دیگر' }]);
  const libraryResponse = await fetch(`${url}/api/library`, { headers: { Cookie: cookie } });
  const libraryData = await libraryResponse.json();
  if (libraryResponse.status !== 200 || !libraryData.documents.some((doc) =>
    doc.id === survivorPdf && doc.dossierId === emptyCase) ||
    libraryData.documents.some((doc) => doc.dossierTopic === 'private'))
    throw new Error('global library omitted owner documents or exposed another principal');
  const passagesResponse = await fetch(`${url}/api/source-passages?documentId=${survivorPdf}`, {
    headers: { Cookie: cookie } });
  if (passagesResponse.status !== 200 || !(await passagesResponse.json()).passages[0]?.text.includes('نسخه مشترک'))
    throw new Error('library cannot read the selected document');
  const privatePassages = await fetch(`${url}/api/source-passages?documentId=${otherDossierId + 100000}`, {
    headers: { Cookie: cookie } });
  if (privatePassages.status !== 404) throw new Error('unknown source passages were exposed');
  const originalId = '00000000-0000-4000-8000-000000000001';
  const originalsDir = path.join(temp, 'web-uploads');
  fs.writeFileSync(path.join(originalsDir, `${originalId}.json`), JSON.stringify({ id: originalId,
    principalId: 'test-web-owner', dossierId: emptyCase, documentId: survivorPdf }));
  fs.writeFileSync(path.join(originalsDir, `${originalId}.bin`), '%PDF-1.4 test original');
  const original = await fetch(`${url}/api/source-file?documentId=${survivorPdf}`, { headers: { Cookie: cookie } });
  if (original.status !== 200 || !original.headers.get('content-type')?.includes('application/pdf') ||
      !(await original.text()).startsWith('%PDF-1.4'))
    throw new Error('private PDF preview did not return the original bytes');
  const downloaded = await fetch(`${url}/api/source-file?documentId=${survivorPdf}&download=1`, {
    headers: { Cookie: cookie } });
  if (!downloaded.headers.get('content-disposition')?.startsWith('attachment'))
    throw new Error('PDF download was not marked as an attachment');
  await downloaded.arrayBuffer();
  const unauthedOriginal = await fetch(`${url}/api/source-file?documentId=${survivorPdf}`);
  if (unauthedOriginal.status !== 401) throw new Error('original PDF was public');
  const focus = motherSourceContext('test-web-owner', dossierId, 'متن', survivorPdf);
  if (focus.focusedDocument?.id !== survivorPdf ||
      focus.excerpts.some((item) => item.documentId !== survivorPdf))
    throw new Error('dedicated source chat mixed another document into its focus');
  const focusedAnswer = await motherTurn({ principalId: 'test-web-owner', dossierId: emptyCase,
    focusDocumentId: survivorPdf, userText: 'این سند چه می‌گوید؟', ask: async ({ content }) =>
      content.includes('passages')
        ? { data: { answer: 'دربارهٔ نسخهٔ مشترک است', passage_id: 1,
          quote: 'متن نسخه مشترک در پرونده دیگر' }, usage: {} }
        : { data: { action: 'search_library', reply: '' }, usage: {} } });
  if (!focusedAnswer.text.includes(`سند #${survivorPdf}`) ||
      !focusedAnswer.text.includes('شاهد منطبق'))
    throw new Error('focused chat ignored the selected copy of a book');
  store.linkDossiers('test-web-owner', dossierId, emptyCase);
  settings.setActiveDossier('test-web-owner', dossierId);
  const wrongTopic = await fetch(`${url}/api/delete-dossier`, { method: 'POST', headers: chatHeaders,
    body: JSON.stringify({ dossierId, expectedTopic: 'نام اشتباه' }) });
  const foreignDelete = await fetch(`${url}/api/delete-dossier`, { method: 'POST', headers: chatHeaders,
    body: JSON.stringify({ dossierId: otherDossierId, expectedTopic: 'پرونده جدا' }) });
  const unauthDelete = await fetch(`${url}/api/delete-dossier`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dossierId, expectedTopic: 'یک پرونده برای چند کتاب' }) });
  if (wrongTopic.status !== 409 || foreignDelete.status === 200 || unauthDelete.status !== 401)
    throw new Error('deletion accepted a stale name, another owner, or no session');
  const deleted = await fetch(`${url}/api/delete-dossier`, { method: 'POST', headers: chatHeaders,
    body: JSON.stringify({ dossierId, expectedTopic: 'یک پرونده برای چند کتاب' }) });
  if (deleted.status !== 200) throw new Error(`dossier deletion failed: ${deleted.status} ${await deleted.text()}`);
  if (store.getDossier('test-web-owner', dossierId) || store.getInvestigation('test-web-owner', runId) ||
      store.getDocument('test-web-owner', targetPdf) ||
      store.searchOwnerChunks('test-web-owner', 'ردپاک‌کردنویژه').length ||
      !store.getDocument('test-web-owner', survivorPdf) ||
      !library.searchBooks('test-web-owner', 'shared', 5).some((book) => book.copies.includes(survivorPdf)) ||
      settings.activeDossier('test-web-owner') === dossierId ||
      fs.readFileSync(indexFile, 'utf8').includes(`پرونده: #${dossierId} · یک پرونده برای چند کتاب`))
    throw new Error('dossier deletion left stale data or erased a shared source');
  const survivingOriginal = await fetch(`${url}/api/source-file?documentId=${survivorPdf}`, {
    headers: { Cookie: cookie } });
  if (survivingOriginal.status !== 200) throw new Error('deleting one dossier removed another dossier original');
  await survivingOriginal.arrayBuffer();
  const exportedIndex = await fetch(`${url}/api/library-index`, { headers: { Cookie: cookie } });
  const exportedText = await exportedIndex.text();
  if (exportedIndex.status !== 200 || !exportedText.includes('new-source-19.txt') ||
      exportedText.includes(`پرونده: #${dossierId} · یک پرونده برای چند کتاب`))
    throw new Error('downloadable source Markdown does not match the live database');
  const afterDelete = await fetch(`${url}/api/state`, { headers: { Cookie: cookie } });
  if ((await afterDelete.json()).dossiers.some((item) => item.id === dossierId))
    throw new Error('deleted dossier remains in web case list');
  console.log('web check passed — four pages, global sources, private PDF, focused reading, safe deletion; 0 model calls');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
