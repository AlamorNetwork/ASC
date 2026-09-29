/** Private web surface for the same dossiers, documents and research engine as the bot. */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import * as settings from './settings.js';
import * as chat from './chat.js';
import { runResearch } from './research.js';
import { ingestToDossier, extractClaimsFor, sha256 } from './ingest.js';
import { MAX_DOCUMENT_BYTES } from './file-limits.js';
import { researchLedger } from './research-ledger.js';
import { analyzeDocument, documentAnalysisPath } from './document-analysis.js';
import * as cancel from './cancel.js';

const publicDir = path.join(config.root, 'web', 'public');
const uploadDir = path.join(path.dirname(config.dbPath), 'web-uploads');
const sessions = new Map();
const attempts = new Map();
const jobs = new Map();
let running = false;
const secureCookie = config.web.origin.startsWith('https:') ? ' Secure;' : '';

function response(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? Number(value) : value));
}
function error(res, status, message) { response(res, status, { error: message }); }
function principal() {
  const id = config.web.principalId || store.getSetting('owner_chat_id') || config.ownerChatId;
  if (!id) throw new Error('WEB_PRINCIPAL_ID is not set and the Telegram owner is unknown. Add WEB_PRINCIPAL_ID to .env.');
  return String(id);
}
function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0, text = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('درخواست خیلی بزرگ است.')); req.destroy(); return; }
      text += chunk;
    });
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('JSON نامعتبر است.')); } });
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  return req.headers.origin === config.web.origin;
}
function session(req) {
  const token = /(?:^|;\s*)asc_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const item = token && sessions.get(token);
  if (!item) return null;
  if (item.expires < Date.now()) { sessions.delete(token); return null; }
  item.expires = Date.now() + 12 * 60 * 60 * 1000;
  return item;
}
function guardMutation(req, res, s) {
  if (!sameOrigin(req) || req.headers['x-csrf-token'] !== s.csrf) {
    error(res, 403, 'درخواست از این صفحه مجاز نیست.'); return false;
  }
  return true;
}
function cleanName(value) {
  const name = path.basename(String(value || '').replaceAll('\\', '/')).trim();
  if (!name || name === '.' || name === '..' || name.length > 180 || /[\x00-\x1f]/.test(name))
    throw new Error('نام فایل نامعتبر است.');
  if (!/\.(pdf|txt|md|markdown|png|jpe?g|webp)$/i.test(name))
    throw new Error('فقط PDF، متن و تصویر پذیرفته می‌شود.');
  return name;
}
function uploadPaths(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('شناسهٔ فایل نامعتبر است.');
  return { data: path.join(uploadDir, `${id}.bin`), meta: path.join(uploadDir, `${id}.json`) };
}
async function upload(req, res, name) {
  name = cleanName(name);
  if (Number(req.headers['content-length']) > MAX_DOCUMENT_BYTES) return error(res, 413, 'سقف فایل ۱۰۰ مگابایت است.');
  await fsp.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const files = uploadPaths(id);
  const out = fs.createWriteStream(files.data, { flags: 'wx', mode: 0o600 });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error('سقف فایل ۱۰۰ مگابایت است.');
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
    if (!size) throw new Error('فایل خالی است.');
    const meta = { id, name, size, createdAt: new Date().toISOString(),
      mime: /\.pdf$/i.test(name) ? 'application/pdf'
        : /\.png$/i.test(name) ? 'image/png'
          : /\.webp$/i.test(name) ? 'image/webp'
            : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'text/plain' };
    await fsp.writeFile(files.meta, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
    response(res, 201, meta);
  } catch (err) {
    out.destroy();
    await fsp.rm(files.data, { force: true }).catch(() => {});
    await fsp.rm(files.meta, { force: true }).catch(() => {});
    if (!res.destroyed) error(res, /سقف/.test(err.message) ? 413 : 400, err.message);
  }
}
async function uploaded(id) {
  const files = uploadPaths(id);
  const meta = JSON.parse(await fsp.readFile(files.meta, 'utf8'));
  return { ...meta, file: files.data };
}
function startJob(kind, work) {
  if (running) throw new Error('یک کار در حال اجراست؛ تا پایان آن صبر کن.');
  cancel.newInstruction(principal());
  running = true;
  const id = randomUUID();
  const job = { id, kind, state: 'running', stage: 'شروع', startedAt: Date.now(), result: null };
  jobs.set(id, job);
  if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
  void (async () => {
    try { job.result = await work((stage) => { job.stage = String(stage).slice(0, 300); });
      job.state = job.result?.needsVision ? 'needs_vision' : 'done'; }
    catch (err) { job.state = 'failed'; job.error = err.message;
      if (err.savedScan) job.savedScan = err.savedScan;
      console.error(`[web] ${kind}:`, err); }
    finally { job.finishedAt = Date.now(); running = false; }
  })();
  return { id };
}
function requireDossier(pid, id) {
  const d = store.getDossier(pid, Number(id));
  if (!d) throw new Error('پرونده پیدا نشد.');
  return d;
}
async function importFile(pid, input, progress) {
  const meta = await uploaded(input.uploadId);
  const buffer = await fsp.readFile(meta.file);
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error('سقف فایل ۱۰۰ مگابایت است.');
  const dossierId = input.dossierId ? Number(requireDossier(pid, input.dossierId).id)
    : Number(store.insertDossier({ principalId: pid, topic: meta.name, state: 'open' }));
  settings.setActiveDossier(pid, dossierId);
  const prior = store.findDocumentByHash(pid, dossierId, sha256(buffer));
  if (prior && (!prior.pages || prior.read_pages >= prior.pages))
    return { dossierId, documentId: prior.id, alreadyRead: true };
  try {
    const out = await ingestToDossier({ principalId: pid, dossierId, buffer,
      filename: meta.name, mime: meta.mime, allowVision: input.visionPages === 20,
      pageLimit: input.visionPages === 20 ? 20 : null,
      resumeDocumentId: prior?.id ?? null, onProgress: progress });
    return { dossierId, ...out };
  } catch (err) {
    if (err.scanned) return { dossierId, needsVision: true, pages: err.scanned.pages,
      uploadId: meta.id, readPages: prior?.read_pages ?? 0 };
    throw err;
  }
}
function state(pid, dossierId) {
  const dossiers = store.listDossiers(pid, 50);
  const chosen = dossierId ? requireDossier(pid, dossierId) : null;
  return { dossiers, selected: chosen, documents: chosen ? store.dossierDocuments(pid, chosen.id) : [],
    claims: chosen ? store.dossierClaims(pid, chosen.id) : [],
    episodes: chosen ? store.dossierEpisodes(pid, chosen.id, 8) : [],
    messages: store.conversation(pid, chosen?.id ?? null, 30),
    stats: store.stats(pid) };
}
async function servePublic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.css', 'app.js'].includes(name)) return error(res, 404, 'یافت نشد.');
  const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
  const body = await fsp.readFile(path.join(publicDir, name));
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  res.end(body);
}
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return servePublic(res, url.pathname);
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return error(res, 403, 'مبدأ درخواست مجاز نیست.');
    const ip = req.socket.remoteAddress;
    const old = attempts.get(ip) ?? { n: 0, until: 0 };
    if (old.until > Date.now()) return error(res, 429, 'چند دقیقه بعد دوباره تلاش کن.');
    const { password } = await readJson(req);
    const salt = Buffer.from('asc-web-password-v1');
    const expected = scryptSync(config.web.password, salt, 32);
    const actual = scryptSync(String(password ?? ''), salt, 32);
    if (!timingSafeEqual(expected, actual)) {
      const n = old.n + 1;
      attempts.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      return error(res, 401, 'رمز درست نیست.');
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString('hex');
    const item = { csrf: randomBytes(24).toString('hex'), expires: Date.now() + 12 * 60 * 60 * 1000 };
    sessions.set(token, item);
    return response(res, 200, { csrf: item.csrf }, { 'Set-Cookie': `asc_session=${token}; HttpOnly;${secureCookie} SameSite=Strict; Path=/; Max-Age=43200` });
  }
  const s = session(req);
  if (!s) return error(res, 401, 'وارد حساب شو.');
  if (url.pathname === '/api/session' && req.method === 'GET') return response(res, 200, { csrf: s.csrf });
  if (req.method !== 'GET' && !guardMutation(req, res, s)) return;
  const pid = principal();
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = /asc_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    sessions.delete(token);
    return response(res, 200, { ok: true }, { 'Set-Cookie': `asc_session=; HttpOnly;${secureCookie} SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (url.pathname === '/api/state' && req.method === 'GET')
    return response(res, 200, state(pid, url.searchParams.get('dossierId')));
  if (url.pathname === '/api/active-job' && req.method === 'GET')
    return response(res, 200, { job: [...jobs.values()].find((j) => j.state === 'running') ?? null });
  if (url.pathname === '/api/uploads' && req.method === 'GET') {
    const files = await fsp.readdir(uploadDir).catch(() => []);
    const list = await Promise.all(files.filter((x) => /^[a-f0-9-]{36}\.json$/.test(x)).map(async (x) => {
      try { return JSON.parse(await fsp.readFile(path.join(uploadDir, x), 'utf8')); }
      catch { return null; }
    }));
    return response(res, 200, list.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30));
  }
  if (url.pathname === '/api/upload' && req.method === 'POST')
    return upload(req, res, url.searchParams.get('name'));
  if (url.pathname === '/api/import' && req.method === 'POST') {
    const input = await readJson(req);
    if (!input.uploadId) throw new Error('فایل انتخاب نشده است.');
    await uploaded(input.uploadId);
    return response(res, 202, startJob('import', (progress) => importFile(pid, input, progress)));
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const input = await readJson(req);
    const message = String(input.message ?? '').trim().slice(0, 4000);
    if (!message) throw new Error('پیام خالی است.');
    const dossier = input.dossierId ? requireDossier(pid, input.dossierId) : null;
    return response(res, 202, startJob('chat', async (progress) => {
      progress('در حال بررسی پرونده…');
      let stream = '';
      const onDelta = (part) => { stream += part; progress(stream.slice(-280)); };
      return dossier ? chat.reply({ principalId: pid, dossierId: dossier.id, userText: message, onDelta,
        onStep: (step) => progress(typeof step === 'string' ? step : JSON.stringify(step)) })
        : chat.replyPlain({ principalId: pid, userText: message, onDelta,
          recent: store.listDossiers(pid, 5) });
    }));
  }
  if (url.pathname === '/api/research' && req.method === 'POST') {
    const input = await readJson(req);
    const question = String(input.question ?? '').trim().slice(0, 1000);
    if (!question) throw new Error('سؤال تحقیق خالی است.');
    const dossier = input.dossierId ? requireDossier(pid, input.dossierId) : null;
    const dossierId = dossier?.id ?? Number(store.insertDossier({ principalId: pid, topic: question, question }));
    return response(res, 202, startJob('research', (progress) => cancel.underway(pid, 'تحقیق وب', () => runResearch({
      principalId: pid, dossierId, topic: dossier?.topic ?? question, question,
      onProgress: (e) => progress(e.detail || e.stage || 'تحقیق…'),
    }))));
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    cancel.request(pid);
    return response(res, 200, { ok: true });
  }
  if (url.pathname === '/api/claims' && req.method === 'POST') {
    const { documentId } = await readJson(req);
    if (!documentId) throw new Error('شمارهٔ سند لازم است.');
    if (!store.getDocument(pid, Number(documentId))) throw new Error('سند پیدا نشد.');
    return response(res, 202, startJob('claims', (progress) => extractClaimsFor({
      principalId: pid, documentId: Number(documentId), onProgress: progress })));
  }
  if (url.pathname === '/api/analyze-document' && req.method === 'POST') {
    const { documentId } = await readJson(req);
    const doc = store.getDocument(pid, Number(documentId));
    if (!doc) throw new Error('سند پیدا نشد.');
    return response(res, 202, startJob('analysis', (progress) => cancel.underway(pid,
      'تحلیل عمیق سند', () => analyzeDocument({ principalId: pid, documentId: doc.id, onProgress: progress }))));
  }
  if (url.pathname.startsWith('/api/jobs/') && req.method === 'GET') {
    const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
    return job ? response(res, 200, job) : error(res, 404, 'کار پیدا نشد.');
  }
  if (url.pathname === '/api/ledger' && req.method === 'GET') {
    const d = requireDossier(pid, url.searchParams.get('dossierId'));
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="asc-ledger-${d.id}.md"`, 'Cache-Control': 'no-store' });
    return res.end(researchLedger(pid, d.id));
  }
  if (url.pathname === '/api/document-analysis' && req.method === 'GET') {
    const doc = store.getDocument(pid, Number(url.searchParams.get('documentId')));
    if (!doc) throw new Error('سند پیدا نشد.');
    const file = documentAnalysisPath(pid, doc.id);
    if (!fs.existsSync(file)) return error(res, 404, 'تحلیل این سند هنوز آغاز نشده است.');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="asc-document-${doc.id}-analysis.md"`, 'Cache-Control': 'no-store' });
    return res.end(await fsp.readFile(file));
  }
  return error(res, 404, 'یافت نشد.');
}

export function createWebServer() {
  if (!config.web.password || config.web.password.length < 16) throw new Error('WEB_PASSWORD must be at least 16 characters.');
  const secure = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(config.web.origin);
  const localPreview = process.env.NODE_ENV !== 'production' &&
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(config.web.origin);
  if (!secure && !localPreview) throw new Error('WEB_ORIGIN must be the exact HTTPS origin of the web app.');
  principal();
  return http.createServer((req, res) => {
    Promise.resolve(route(req, res)).catch((err) => {
      const badInput = /نامعتبر|نیست|خالی|لازم|سقف|پیدا نشد/.test(err.message);
      if (!badInput) console.error('[web]', err);
      if (!res.headersSent && !res.destroyed) {
        error(res, badInput ? 400 : 500, badInput ? err.message : 'خطای داخلی؛ گزارش سرور را بررسی کن.');
      }
    });
  });
}

export function runWeb() {
  const server = createWebServer();
  server.listen(config.web.port, '127.0.0.1', () => console.log(`[asc-web] http://127.0.0.1:${config.web.port}`));
  return server;
}
