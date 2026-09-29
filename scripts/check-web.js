/** Free web smoke test. Uses its own SQLite file and never calls a model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-web-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
process.env.WEB_PASSWORD = 'this-is-a-test-password-only';
process.env.WEB_ORIGIN = 'https://asc.alamornetwork.ir';
process.env.WEB_PRINCIPAL_ID = 'test-web-owner';
const { createWebServer } = await import('../src/web.js');
const store = await import('../src/db.js');
const { db } = store;
const server = createWebServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const origin = process.env.WEB_ORIGIN;
try {
  const page = await fetch(url);
  if (page.status !== 200 || !(await page.text()).includes('تالار پژوهش')) throw new Error('login page failed');
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
  console.log('web check passed — login, isolation, upload and recovery; 0 model calls');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
