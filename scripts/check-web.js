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
  if (page.status !== 200 || !markup.includes('تالار پژوهش') ||
      !markup.includes('id="tab-deep"') || !markup.includes('id="investigation-status"'))
    throw new Error('web research controls are missing');
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const htmlIds = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
  const absent = [...referencedIds].filter((id) => !htmlIds.has(id));
  if (absent.length) throw new Error(`web script refers to missing DOM ids: ${absent.join(', ')}`);
  const denied = await fetch(`${url}/api/state`);
  if (denied.status !== 401) throw new Error('unauthenticated state was exposed');
  const privateReport = await fetch(`${url}/api/document-analysis?documentId=1`);
  if (privateReport.status !== 401) throw new Error('unauthenticated analysis was exposed');
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.WEB_PASSWORD }) });
  if (login.status !== 200) throw new Error(`login ${login.status}: ${await login.text()}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
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
  const upload = await fetch(`${url}/api/upload?name=book.pdf`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'pdf' });
  if (upload.status !== 201) throw new Error(`upload ${upload.status}: ${await upload.text()}`);
  const meta = await upload.json();
  if (meta.size !== 3) throw new Error('upload bytes were not saved');
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
  for (const filename of ['first.pdf', 'second.pdf']) {
    const saved = await fetch(`${url}/api/upload?name=${filename}&dossierId=${dossierId}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'pdf' });
    if (saved.status !== 201 || (await saved.json()).dossierId !== dossierId)
      throw new Error(`${filename} was not bound to the selected dossier`);
  }
  const fresh = await fetch(`${url}/api/state?fresh=1`, { headers: { Cookie: cookie } });
  if ((await fresh.json()).selected !== null) throw new Error('explicit new dossier view was lost');
  const freshUpload = await fetch(`${url}/api/upload?name=unrelated.pdf&newDossier=1`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'pdf' });
  const freshMeta = await freshUpload.json();
  if (freshUpload.status !== 201 || !freshMeta.dossierId || freshMeta.dossierId === dossierId)
    throw new Error('new dossier upload inherited the old dossier');
  const afterFresh = await fetch(`${url}/api/state`, { headers: { Cookie: cookie } });
  if ((await afterFresh.json()).selected?.id !== freshMeta.dossierId)
    throw new Error('new dossier did not become the active dossier');
  const nextFile = await fetch(`${url}/api/upload?name=related.pdf&dossierId=${freshMeta.dossierId}`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf }, body: 'pdf' });
  if (nextFile.status !== 201 || (await nextFile.json()).dossierId !== freshMeta.dossierId)
    throw new Error('second file did not join the new dossier');
  console.log('web check passed — login, same dossier uploads, explicit new dossier and recovery; 0 model calls');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
