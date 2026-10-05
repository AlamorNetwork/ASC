/** The mother can answer while research keeps its execution slot and stop state. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-concurrent-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
process.env.WEB_PASSWORD = 'test-password-for-concurrency';
process.env.WEB_ORIGIN = 'https://asc.alamornetwork.ir';
process.env.WEB_PRINCIPAL_ID = 'concurrent-owner';
const store = await import('../src/db.js');
const cancel = await import('../src/cancel.js');
const { createWebServer } = await import('../src/web.js');
let finishResearch, finishConversation;
const server = createWebServer({
  runChat: async () => new Promise((resolve) => { finishResearch = resolve; }),
  runSideChat: async ({ principalId, dossierId, userText, onDelta }) => {
    assert.equal(principalId, 'concurrent-owner');
    assert.ok(store.getDossier(principalId, dossierId));
    assert.equal(userText, 'الان چه می‌کنی؟');
    onDelta('در حال پاسخ');
    return new Promise((resolve) => { finishConversation = resolve; });
  },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (condition) => {
  for (let i = 0; i < 60; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('job did not reach expected state');
};
try {
  const dossierId = Number(store.insertDossier({ principalId: 'concurrent-owner', topic: 'ایدهٔ رزرو' }));
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: {
    Origin: process.env.WEB_ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: process.env.WEB_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const headers = { Cookie: cookie, Origin: process.env.WEB_ORIGIN, 'X-CSRF-Token': csrf,
    'Content-Type': 'application/json' };
  const send = (message) => fetch(`${base}/api/chat`, { method: 'POST', headers,
    body: JSON.stringify({ dossierId, message }) });
  const research = await send('این ایده را تحقیق کن');
  assert.equal(research.status, 202);
  const researchId = (await research.json()).id;
  await waitFor(() => !!finishResearch);
  cancel.request('concurrent-owner');
  const alongside = await send('الان چه می‌کنی؟');
  assert.equal(alongside.status, 202);
  const alongsideId = (await alongside.json()).id;
  await waitFor(() => !!finishConversation);
  assert.equal(cancel.isWanted('concurrent-owner'), true, 'conversation cleared the research stop flag');
  const second = await send('پیام سوم');
  assert.equal(second.status, 409, 'a second side reply should be bounded');
  const primary = await fetch(`${base}/api/active-job`, { headers: { Cookie: cookie } });
  assert.equal((await primary.json()).job.id, researchId, 'side reply replaced the background job');
  finishConversation({ text: 'دارم منبع‌ها را بررسی می‌کنم.', dossierId });
  let side;
  for (let i = 0; i < 60; i++) {
    side = await (await fetch(`${base}/api/jobs/${alongsideId}`, { headers: { Cookie: cookie } })).json();
    if (side.state === 'done') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(side.state, 'done');
  const still = await (await fetch(`${base}/api/jobs/${researchId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(still.state, 'running', 'side reply stopped the research');
  finishResearch({ text: 'گزارش تکمیل شد.', dossierId });
  for (let i = 0; i < 60; i++) {
    const job = await (await fetch(`${base}/api/jobs/${researchId}`, { headers: { Cookie: cookie } })).json();
    if (job.state === 'done') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await (await fetch(`${base}/api/jobs/${researchId}`, { headers: { Cookie: cookie } })).json()).state, 'done');
  console.log('concurrent chat check passed — side reply, stop state, main job, bounded calls; 0 model calls');
} finally { await new Promise((resolve) => server.close(resolve)); store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
