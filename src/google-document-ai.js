/** Google Document AI batch OCR. The operation name is persisted by the caller before polling. */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';

const ident = (value) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value || '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function googleOcrSettings() {
  const c = config.googleDocumentAi;
  if (!ident(c.project) || !ident(c.location) || !ident(c.processor) ||
      !ident(c.bucket) || !c.credentialsFile)
    throw new Error('Google Document AI تنظیم نشده است: PROJECT، LOCATION، PROCESSOR، BUCKET و مسیر فایل service account لازم است.');
  return c;
}

export async function serviceToken(file, request = fetch) {
  const key = JSON.parse(await readFile(file, 'utf8'));
  if (key.type !== 'service_account' || !key.client_email || !key.private_key)
    throw new Error('فایل اعتبارنامهٔ Google باید JSON مربوط به service account باشد.');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claim = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sign = createSign('RSA-SHA256'); sign.update(claim); sign.end();
  const assertion = `${claim}.${sign.sign(key.private_key).toString('base64url')}`;
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google OAuth: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

async function googleJson(url, token, { method = 'GET', body, type = 'application/json', request = fetch } = {}) {
  const res = await request(url, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': type } : {}) },
    body: body == null ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google API ${res.status}: ${String(data.error?.message || data.error || 'request failed').slice(0, 250)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function ocrObjectPaths(bucket, uploadId) {
  if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw new Error('شناسهٔ آپلود نامعتبر است.');
  const prefix = `asc-ocr/${uploadId}/`;
  return { input: `gs://${bucket}/${prefix}source.pdf`, output: `gs://${bucket}/${prefix}output/` };
}

export async function submitGoogleOcr({ pdf, uploadId, settings = googleOcrSettings(), request = fetch }) {
  const paths = ocrObjectPaths(settings.bucket, uploadId);
  const name = paths.input.slice(`gs://${settings.bucket}/`.length);
  let token;
  try {
    token = await serviceToken(settings.credentialsFile, request);
    await googleJson(`https://storage.googleapis.com/upload/storage/v1/b/${settings.bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`,
      token, { method: 'POST', body: pdf, type: 'application/pdf', request });
  } catch (err) {
    err.safeToRetry = true; // Batch OCR has not been requested.
    throw err;
  }
  const resource = `projects/${settings.project}/locations/${settings.location}/processors/${settings.processor}`;
  let operation;
  try {
    operation = await googleJson(`https://${settings.location}-documentai.googleapis.com/v1/${resource}:batchProcess`,
      token, { method: 'POST', body: {
        inputDocuments: { gcsDocuments: { documents: [{ gcsUri: paths.input, mimeType: 'application/pdf' }] } },
        documentOutputConfig: { gcsOutputConfig: { gcsUri: paths.output,
          fieldMask: 'text,pages.pageNumber,pages.layout,shardInfo' } },
      }, request });
  } catch (err) {
    // An explicit client rejection cannot have started a billable operation.
    if (err.status >= 400 && err.status < 500) err.safeToRetry = true;
    throw err;
  }
  if (!operation.name?.startsWith(`projects/${settings.project}/locations/${settings.location}/operations/`))
    throw new Error('Google شناسهٔ معتبر برای کار OCR برنگرداند.');
  return { operation: operation.name, input: paths.input, output: paths.output };
}

export async function waitForGoogleOcr(operationName, { settings = googleOcrSettings(), request = fetch,
  onProgress, wait = sleep, maxPolls = 360 } = {}) {
  const allowed = `projects/${settings.project}/locations/${settings.location}/operations/`;
  if (!operationName.startsWith(allowed) || !ident(operationName.slice(allowed.length)))
    throw new Error('شناسهٔ کار Google با پردازشگر تنظیم‌شده سازگار نیست.');
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const token = await serviceToken(settings.credentialsFile, request);
    const op = await googleJson(`https://${settings.location}-documentai.googleapis.com/v1/${operationName}`,
      token, { request });
    if (op.done) {
      if (op.error) throw new Error(`Google OCR: ${String(op.error.message || op.error.code).slice(0, 250)}`);
      const statuses = op.metadata?.individualProcessStatuses || [];
      const failed = statuses.find((item) => item.status?.code);
      if (failed) throw new Error(`Google OCR: ${String(failed.status.message || failed.status.code).slice(0, 250)}`);
      const output = statuses[0]?.outputGcsDestination;
      if (!output) throw new Error('Google نشانی خروجی OCR را برنگرداند.');
      return output;
    }
    onProgress?.(`Google OCR: ${op.metadata?.stateMessage || 'در حال پردازش'} · بررسی ${attempt + 1}`);
    await wait(15000);
  }
  throw new Error('پردازش Google هنوز تمام نشده است؛ شناسهٔ آن ذخیره شده و با «ادامهٔ OCR» دوباره بررسی می‌شود.');
}

export function pagesFromGoogleDocuments(documents, expectedPages) {
  const pages = new Map();
  for (const doc of documents) {
    const chars = Array.from(String(doc.text ?? ''));
    const offset = Number(doc.shardInfo?.textOffset || 0);
    for (const page of doc.pages || []) {
      const n = Number(page.pageNumber);
      if (!Number.isSafeInteger(n) || n < 1 || n > expectedPages || pages.has(n))
        throw new Error('شمارهٔ صفحات خروجی Google تکراری یا نامعتبر است؛ متن وارد پرونده نشد.');
      const anchor = page.layout?.textAnchor;
      let value = '';
      if (typeof anchor?.content === 'string') value = anchor.content;
      else for (const segment of anchor?.textSegments || []) {
        const start = Number(segment.startIndex || 0) - offset;
        const end = Number(segment.endIndex || 0) - offset;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > chars.length || end < start)
          throw new Error('بازهٔ متن OCR نامعتبر است؛ متن وارد پرونده نشد.');
        value += chars.slice(start, end).join('');
      }
      pages.set(n, value.trim());
    }
  }
  if (pages.size !== expectedPages) throw new Error(`Google فقط ${pages.size} از ${expectedPages} صفحه را برگرداند؛ متن وارد پرونده نشد.`);
  return Array.from({ length: expectedPages }, (_, i) => pages.get(i + 1));
}

export async function fetchGoogleOcrPages(outputUri, expectedPages, {
  settings = googleOcrSettings(), request = fetch,
} = {}) {
  const prefix = `gs://${settings.bucket}/asc-ocr/`;
  if (!outputUri.startsWith(prefix)) throw new Error('خروجی OCR خارج از bucket این کار است.');
  const objectPrefix = outputUri.slice(`gs://${settings.bucket}/`.length).replace(/\/?$/, '/');
  const token = await serviceToken(settings.credentialsFile, request);
  let cursor = '', names = [];
  do {
    const url = `https://storage.googleapis.com/storage/v1/b/${settings.bucket}/o?prefix=${encodeURIComponent(objectPrefix)}&pageToken=${encodeURIComponent(cursor)}`;
    const list = await googleJson(url, token, { request });
    names.push(...(list.items || []).map((item) => item.name).filter((name) => name.endsWith('.json')));
    cursor = list.nextPageToken || '';
    if (names.length > 100) throw new Error('خروجی OCR بیش از حد انتظار چندپاره شد.');
  } while (cursor);
  if (!names.length) throw new Error('خروجی JSON کار Google پیدا نشد؛ شناسهٔ کار ذخیره شده است.');
  const docs = [];
  for (const name of names.sort()) docs.push(await googleJson(
    `https://storage.googleapis.com/storage/v1/b/${settings.bucket}/o/${encodeURIComponent(name)}?alt=media`,
    token, { request }));
  return pagesFromGoogleDocuments(docs, expectedPages);
}
