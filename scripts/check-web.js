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
const store = await import('../src/db.js');
const { db } = store;
const server = createWebServer();
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
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const htmlIds = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
  const absent = [...referencedIds].filter((id) => !htmlIds.has(id));
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
  console.log('web check passed — pending uploads, mother inventory, local import, dossier recovery; 0 model calls');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
