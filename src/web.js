/** Private web surface for the same dossiers, documents and research engine as the bot. */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import * as settings from './settings.js';
import { motherTurn } from './mother.js';
import { runResearch } from './research.js';
import { deepInvestigate } from './deep.js';
import { ingestToDossier, extractClaimsFor, sha256 } from './ingest.js';
import { pdftotextAvailable } from './pdf.js';
import { MAX_DOCUMENT_BYTES } from './file-limits.js';
import { researchLedger } from './research-ledger.js';
import { analyzeDocument, documentAnalysisPath } from './document-analysis.js';
import { runResearchTeam } from './research-team.js';
import { collectSite } from './site-library.js';
import { consultSources } from './source-consult.js';
import { pendingUploadsFor } from './upload-state.js';
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
async function upload(req, res, name, pid, targetId, newDossier) {
  name = cleanName(name);
  const target = newDossier ? null : targetId
    ? requireDossier(pid, targetId)
    : store.getDossier(pid, settings.activeDossier(pid)) ?? store.listDossiers(pid, 1)[0] ?? null;
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
    const dossierId = newDossier
      ? Number(store.insertDossier({ principalId: pid, topic: name, state: 'open' }))
      : target?.id ?? null;
    if (newDossier) settings.setActiveDossier(pid, dossierId);
    const meta = { id, name, size, principalId: pid, createdAt: new Date().toISOString(),
      dossierId, newDossier: false,
      mime: /\.pdf$/i.test(name) ? 'application/pdf'
        : /\.png$/i.test(name) ? 'image/png'
          : /\.webp$/i.test(name) ? 'image/webp'
            : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'text/plain' };
    await fsp.writeFile(files.meta, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
    // Detect and index text-layer PDFs locally as soon as upload finishes. Image pages
    // still stop for explicit vision approval; this job makes no model calls.
    const job = /\.pdf$/i.test(name) && !running && await pdftotextAvailable()
      ? startJob('import', (progress) => importFile(pid, { uploadId: id, dossierId, localOnly: true }, progress))
      : null;
    response(res, 201, { ...meta, jobId: job?.id ?? null });
  } catch (err) {
    out.destroy();
    await fsp.rm(files.data, { force: true }).catch(() => {});
    await fsp.rm(files.meta, { force: true }).catch(() => {});
    if (!res.destroyed) error(res, /سقف/.test(err.message) ? 413 : 400, err.message);
  }
}
async function uploaded(id, pid) {
  const files = uploadPaths(id);
  const meta = JSON.parse(await fsp.readFile(files.meta, 'utf8'));
  if ((meta.principalId && String(meta.principalId) !== String(pid)) ||
      (meta.dossierId && !store.getDossier(pid, meta.dossierId)))
    throw new Error('فایل برای این کاربر پیدا نشد.');
  return { ...meta, file: files.data };
}
async function bindUpload(meta, dossierId, documentId = null) {
  const updated = { ...meta, dossierId, newDossier: false,
    documentId: documentId ?? meta.documentId ?? null };
  const files = uploadPaths(meta.id);
  const temp = `${files.meta}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(updated), { mode: 0o600 });
  await fsp.rename(temp, files.meta);
  return updated;
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
    try { job.result = await work((stage) => { job.stage = String(stage).slice(0, 300); }, job);
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
export function visionPlan(input) {
  const batch = input.visionMode === 'batch' || input.visionPages === 20;
  return { allowVision: input.visionMode === 'all' || batch,
    pageLimit: batch ? 20 : null };
}
export function deepCeiling(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 20)
    throw new Error('سقف دلاری نامعتبر است؛ عددی بیشتر از صفر و حداکثر ۲۰ دلار بده.');
  return value;
}
function investigationView(row) {
  if (!row) return null;
  let leads = [];
  try { leads = JSON.parse(row.leads ?? '[]'); } catch { /* old malformed row */ }
  return { id: row.id, question: row.question, state: row.state, stopped: row.stopped,
    rounds: row.rounds, costToman: row.cost_toman, costUsd: row.cost_usd,
    nextLeads: Array.isArray(leads) ? leads.slice(0, 4) : [] };
}
function deepProgress(note) {
  if (note.kind === 'web') return `دور ${note.round} · جست‌وجوی وب: ${String(note.lead ?? '').slice(0, 130)}`;
  if (note.kind === 'nextleads') return `دور ${note.round} · سرنخ‌های بعدی: ${(note.leads ?? []).join('؛ ').slice(0, 140)}`;
  if (note.kind === 'error') return `دور ${note.round} · یک جست‌وجو شکست خورد: ${String(note.message ?? '').slice(0, 130)}`;
  if (note.kind === 'resumed') return `ادامه از دور ${note.round}`;
  return `دور ${note.round ?? 1} · ${String(note.detail ?? note.kind ?? 'بررسی منابع').slice(0, 140)}`;
}
async function runDeepJob(pid, dossierId, question, ceilingUsd, runId, progress, job) {
  const activeKey = `web.deep.active_run.${pid}`;
  try {
    const out = await deepInvestigate({ principalId: pid, dossierId, question, ceilingUsd, runId,
      onStarted: (id) => { job.runId = id; store.setSetting(activeKey, String(id)); progress(`کاوش #${id} آغاز شد`); },
      onNote: (note) => progress(deepProgress(note)),
      onRound: (round) => progress(`دور ${round.round} ذخیره شد · ${round.fresh} یافتهٔ تازه`),
    });
    return { dossierId, runId: out.runId, rounds: out.rounds, stopped: out.stopped,
      canResume: out.canResume, costToman: out.costToman, costUsd: out.costUsd,
      nextLeads: out.nextLeads, answered: out.answered, open: out.open };
  } finally {
    if (job.runId) store.pauseInterruptedInvestigation(pid, job.runId);
    if (store.getSetting(activeKey) === String(job.runId)) store.setSetting(activeKey, '');
  }
}
async function importFile(pid, input, progress) {
  const meta = await uploaded(input.uploadId, pid);
  const buffer = await fsp.readFile(meta.file);
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error('سقف فایل ۱۰۰ مگابایت است.');
  const previousCopy = meta.newDossier ? null : store.findDocumentAnywhere(pid, sha256(buffer));
  const target = meta.newDossier ? null : meta.dossierId
    ? requireDossier(pid, meta.dossierId) : input.dossierId
      ? requireDossier(pid, input.dossierId)
      : previousCopy ? requireDossier(pid, previousCopy.dossier_id)
      : store.getDossier(pid, settings.activeDossier(pid)) ?? store.listDossiers(pid, 1)[0] ?? null;
  const dossierId = target?.id ?? Number(store.insertDossier({ principalId: pid, topic: meta.name, state: 'open' }));
  await bindUpload(meta, dossierId);
  if (!input.localOnly) settings.setActiveDossier(pid, dossierId);
  const prior = store.findDocumentByHash(pid, dossierId, sha256(buffer));
  if (prior && (prior.extraction === 'local' || !prior.pages || prior.read_pages >= prior.pages)) {
    await bindUpload(meta, dossierId, prior.id);
    return { dossierId, documentId: prior.id, alreadyRead: true };
  }
  const vision = visionPlan(input);
  try {
    const out = await ingestToDossier({ principalId: pid, dossierId, buffer,
      filename: meta.name, mime: meta.mime, ...vision,
      resumeDocumentId: prior?.id ?? null, onProgress: progress,
      localOnly: input.localOnly === true });
    await bindUpload(meta, dossierId, out.documentId);
    return { dossierId, ...out };
  } catch (err) {
    if (err.savedScan?.documentId) await bindUpload(meta, dossierId, err.savedScan.documentId);
    if (err.scanned) return { dossierId, needsVision: true, pages: err.scanned.pages,
      visionPages: err.scanned.visionPages,
      uploadId: meta.id, readPages: prior?.read_pages ?? 0 };
    throw err;
  }
}
function state(pid, dossierId, fresh = false) {
  const dossiers = store.listDossiers(pid, 50);
  const chosen = fresh ? null : dossierId ? requireDossier(pid, dossierId)
    : store.getDossier(pid, settings.activeDossier(pid)) ?? dossiers[0] ?? null;
  const latest = chosen && store.latestDossierInvestigation(pid, chosen.id);
  const investigation = latest?.state === 'running' ? latest : chosen
    ? store.resumableInvestigation(pid, chosen.id) ?? latest : null;
  return { dossiers, selected: chosen, investigation: investigationView(investigation),
    documents: chosen ? store.dossierDocuments(pid, chosen.id) : [],
    otherDossierDocuments: chosen ? store.documentsInOtherDossiers(pid, chosen.id) : [],
    pendingUploads: chosen ? pendingUploadsFor(pid, chosen.id) : [],
    researchNodes: chosen ? store.dossierResearchNodes(pid, chosen.id) : [],
    researchLeads: chosen ? store.researchLeads(pid, chosen.id) : [],
    sources: chosen ? store.sourceCatalogue(pid, chosen.id) : [],
    siteCrawls: chosen ? store.dossierSiteCrawls(pid, chosen.id) : [],
    claims: chosen ? store.dossierClaims(pid, chosen.id) : [],
    episodes: chosen ? store.dossierEpisodes(pid, chosen.id, 8) : [],
    messages: store.conversation(pid, chosen?.id ?? null, 30),
    stats: store.stats(pid) };
}
async function servePublic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.css', 'app.js', 'atlas.png', 'vazirmatn.woff2'].includes(name)) return error(res, 404, 'یافت نشد.');
  const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css'
    : name.endsWith('.png') ? 'image/png' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
  const body = await fsp.readFile(path.join(publicDir, name));
  res.writeHead(200, { 'Content-Type': ['image/png', 'font/woff2'].includes(type) ? type : `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
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
    return response(res, 200, state(pid, url.searchParams.get('dossierId'), url.searchParams.get('fresh') === '1'));
  if (url.pathname === '/api/research-progress' && req.method === 'GET') {
    const dossier = url.searchParams.get('dossierId')
      ? requireDossier(pid, url.searchParams.get('dossierId'))
      : store.getDossier(pid, settings.activeDossier(pid));
    return response(res, 200, { dossierId: dossier?.id ?? null,
      nodes: dossier ? store.dossierResearchProgress(pid, dossier.id) : [],
      leads: dossier ? store.researchLeads(pid, dossier.id) : [] });
  }
  if (url.pathname === '/api/research-nodes' && req.method === 'POST') {
    const input = await readJson(req);
    const dossier = requireDossier(pid, input.dossierId);
    const title = String(input.title ?? '').trim();
    if (!title || title.length > 500) throw new Error('عنوان نیت لازم یا بیش از حد بلند است.');
    const parentId = input.parentId ? Number(input.parentId) : null;
    if (parentId && (!Number.isSafeInteger(parentId) || parentId < 1)) throw new Error('نیت مادر نامعتبر است.');
    const id = store.createResearchNode({ principalId: pid, dossierId: dossier.id, parentId,
      title, openQuestion: String(input.openQuestion ?? title).slice(0, 1000) });
    return response(res, 201, { id });
  }
  if (url.pathname === '/api/research-nodes/run' && req.method === 'POST') {
    const input = await readJson(req);
    const node = store.getResearchNode(pid, Number(input.nodeId));
    if (!node || node.parent_id) throw new Error('نیت اصلی پیدا نشد.');
    if (!['pending','paused','failed'].includes(node.status)) throw new Error('این نیت آمادهٔ اجرا نیست.');
    return response(res, 202, startJob('team', (progress) =>
      runResearchTeam({ principalId: pid, dossierId: node.dossier_id, nodeId: node.id, onProgress: progress })));
  }
  if (url.pathname === '/api/site-crawl' && req.method === 'POST') {
    const input = await readJson(req);
    const dossier = requireDossier(pid, input.dossierId);
    let siteUrl;
    try { siteUrl = new URL(String(input.url ?? '')); }
    catch { throw new Error('نشانی سایت نامعتبر است.'); }
    if (!['http:', 'https:'].includes(siteUrl.protocol)) throw new Error('نشانی سایت نامعتبر است.');
    return response(res, 202, startJob('site', (progress) =>
      collectSite({ principalId: pid, dossierId: dossier.id, url: siteUrl.href,
        maxPages: 10, onProgress: progress })));
  }
  if (url.pathname === '/api/source-consult' && req.method === 'POST') {
    const input = await readJson(req);
    const dossier = requireDossier(pid, input.dossierId);
    const question = String(input.question ?? '').trim().slice(0, 1000);
    if (!question) throw new Error('پرسش مشاور منابع لازم است.');
    return response(res, 202, startJob('consult', async (progress) => {
      progress('مشاور منابع: یک درخواست OpenRouter');
      const found = await consultSources(question);
      for (const candidate of found.sources) store.addSourceCandidate({ principalId: pid,
        dossierId: dossier.id, url: candidate.url, title: candidate.title, why: candidate.why });
      progress(`${found.sources.length} نشانی پیشنهادی؛ هنوز بررسی نشده‌اند`);
      return found;
    }));
  }
  if (url.pathname === '/api/active-job' && req.method === 'GET')
    return response(res, 200, { job: [...jobs.values()].find((j) => j.state === 'running') ?? null });
  if (url.pathname === '/api/uploads' && req.method === 'GET') {
    const files = await fsp.readdir(uploadDir).catch(() => []);
    const list = await Promise.all(files.filter((x) => /^[a-f0-9-]{36}\.json$/.test(x)).map(async (x) => {
      try { return JSON.parse(await fsp.readFile(path.join(uploadDir, x), 'utf8')); }
      catch { return null; }
    }));
    return response(res, 200, list.filter((meta) => meta &&
      (!meta.principalId || String(meta.principalId) === String(pid)) &&
      (!meta.dossierId || store.getDossier(pid, meta.dossierId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
      .map((meta) => {
        const doc = meta.documentId && store.getDocument(pid, meta.documentId);
        return { ...meta, pages: doc?.pages ?? null, readPages: doc?.read_pages ?? null };
      }));
  }
  if (url.pathname === '/api/select-dossier' && req.method === 'POST') {
    const { dossierId } = await readJson(req);
    const dossier = requireDossier(pid, dossierId);
    settings.setActiveDossier(pid, dossier.id);
    return response(res, 200, { dossierId: dossier.id });
  }
  if (url.pathname === '/api/upload' && req.method === 'POST')
    return upload(req, res, url.searchParams.get('name'), pid,
      url.searchParams.get('dossierId'), url.searchParams.get('newDossier') === '1');
  if (url.pathname === '/api/import' && req.method === 'POST') {
    const input = await readJson(req);
    if (!input.uploadId) throw new Error('فایل انتخاب نشده است.');
    if (input.visionMode && !['all', 'batch'].includes(input.visionMode)) throw new Error('حالت خواندن نامعتبر است.');
    await uploaded(input.uploadId, pid);
    return response(res, 202, startJob('import', (progress) => importFile(pid, input, progress)));
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const input = await readJson(req);
    const message = String(input.message ?? '').trim().slice(0, 4000);
    if (!message) throw new Error('پیام خالی است.');
    const dossier = input.dossierId ? requireDossier(pid, input.dossierId) : null;
    return response(res, 202, startJob('chat', (progress) => motherTurn({
      principalId: pid, dossierId: dossier?.id ?? null, userText: message,
      onProgress: progress })));
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
  if (url.pathname === '/api/deep' && req.method === 'POST') {
    const input = await readJson(req);
    const question = String(input.question ?? '').trim().slice(0, 1000);
    if (!question) throw new Error('پرسش کاوش خالی است.');
    const ceilingUsd = deepCeiling(input.ceilingUsd);
    if (running) throw new Error('یک کار در حال اجراست؛ تا پایان آن صبر کن.');
    const dossier = input.dossierId ? requireDossier(pid, input.dossierId) : null;
    const dossierId = dossier?.id ?? Number(store.insertDossier({ principalId: pid,
      topic: question, question, state: 'open' }));
    settings.setActiveDossier(pid, dossierId);
    const started = startJob('deep', (progress, job) =>
      runDeepJob(pid, dossierId, question, ceilingUsd, null, progress, job));
    store.addMessage({ principalId: pid, dossierId, role: 'user', text: question });
    return response(res, 202, started);
  }
  if (url.pathname === '/api/deep/resume' && req.method === 'POST') {
    const input = await readJson(req);
    const ceilingUsd = deepCeiling(input.ceilingUsd);
    const run = store.getInvestigation(pid, input.runId);
    if (!run) throw new Error('این کاوش پیدا نشد.');
    if (run.state !== 'paused') throw new Error('این کاوش در حالت توقف نیست.');
    if (running) throw new Error('یک کار در حال اجراست؛ تا پایان آن صبر کن.');
    settings.setActiveDossier(pid, run.dossier_id);
    return response(res, 202, startJob('deep', (progress, job) =>
      runDeepJob(pid, run.dossier_id, run.question, ceilingUsd, run.id, progress, job)));
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    cancel.request(pid);
    const deepJob = [...jobs.values()].find((job) => job.state === 'running' && job.kind === 'deep');
    if (deepJob?.runId) store.requestStop(pid, deepJob.runId);
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
  const pid = principal();
  store.pauseInterruptedResearchNodes();
  store.pauseInterruptedSiteCrawls();
  const activeKey = `web.deep.active_run.${pid}`;
  const interrupted = store.getSetting(activeKey);
  if (interrupted) {
    if (store.pauseInterruptedInvestigation(pid, interrupted))
      console.warn(`[asc-web] investigation #${interrupted} interrupted; resume is available`);
    store.setSetting(activeKey, '');
  }
  const server = createWebServer();
  server.listen(config.web.port, '127.0.0.1', () => console.log(`[asc-web] http://127.0.0.1:${config.web.port}`));
  return server;
}
