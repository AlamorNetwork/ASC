import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ocrObjectPaths, pagesFromGoogleDocuments, submitGoogleOcr,
  waitForGoogleOcr, fetchGoogleOcrPages } from '../src/google-document-ai.js';

const dir = await mkdtemp(path.join(tmpdir(), 'asc-google-ocr-'));
try {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialsFile = path.join(dir, 'key.json');
  await writeFile(credentialsFile, JSON.stringify({ type: 'service_account',
    client_email: 'ocr@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const settings = { project: 'test-project', location: 'us', processor: 'a1b2',
    bucket: 'test-bucket', credentialsFile };
  const uploadId = '11111111-2222-3333-4444-555555555555';
  const paths = ocrObjectPaths(settings.bucket, uploadId);
  assert.equal(paths.output, `gs://test-bucket/asc-ocr/${uploadId}/output/`);
  const operation = 'projects/test-project/locations/us/operations/123';
  const calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
    headers: { 'Content-Type': 'application/json' } });
  const request = async (url, options = {}) => {
    const u = String(url); calls.push({ url: u, options });
    if (u.endsWith('/token')) return json({ access_token: 'test-token' });
    if (u.includes('/upload/storage/')) return json({ name: 'source.pdf' });
    if (u.endsWith(':batchProcess')) return json({ name: operation });
    if (u.endsWith(`/v1/${operation}`)) return json({ done: true, metadata: {
      individualProcessStatuses: [{ outputGcsDestination: paths.output }] } });
    if (u.includes('/storage/v1/b/') && u.includes('/o?')) return json({ items: [
      { name: `asc-ocr/${uploadId}/output/a.json` },
      { name: `asc-ocr/${uploadId}/output/b.json` },
    ] });
    if (u.endsWith('a.json?alt=media')) return json({ text: 'صفحه اول', pages: [
      { pageNumber: 1, layout: { textAnchor: { textSegments: [{ startIndex: '0', endIndex: '8' }] } } },
    ] });
    if (u.endsWith('b.json?alt=media')) return json({ text: 'page two', pages: [
      { pageNumber: 2, layout: { textAnchor: { content: 'page two' } } },
    ] });
    throw new Error(`Unexpected URL: ${u}`);
  };
  const submitted = await submitGoogleOcr({ pdf: Buffer.from('%PDF test'), uploadId, settings, request });
  assert.equal(submitted.operation, operation);
  const output = await waitForGoogleOcr(submitted.operation, { settings, request, wait: async () => {} });
  const pages = await fetchGoogleOcrPages(output, 2, { settings, request });
  assert.deepEqual(pages, ['صفحه اول', 'page two']);
  assert.equal(calls.find((call) => call.url.endsWith(':batchProcess')).options.body.includes(paths.output), true);
  assert.throws(() => pagesFromGoogleDocuments([{ text: '', pages: [{ pageNumber: 1 }] }], 2), /فقط 1 از 2/);
  assert.throws(() => pagesFromGoogleDocuments([{ text: '', pages: [{ pageNumber: 1 }, { pageNumber: 1 }] }], 2), /تکراری/);
  const rejected = async (url, options) => String(url).endsWith(':batchProcess')
    ? json({ error: { message: 'billing disabled' } }, 403) : request(url, options);
  await assert.rejects(submitGoogleOcr({ pdf: Buffer.from('%PDF'), uploadId, settings, request: rejected }),
    (err) => err.safeToRetry === true && err.status === 403);
  console.log('Google Document AI check passed — batch, resume, page integrity, retryable rejection; 0 cloud calls');
} finally {
  await rm(dir, { recursive: true, force: true });
}
