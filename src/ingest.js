/**
 * Reading a supplied document into a dossier.
 *
 * The document's text is never asked back from a model — output tokens cost several
 * times input, so re-emitting a book would mean paying for it twice. Text comes from
 * pdftotext or straight off the file, is chunked and embedded once, and after that a
 * question costs only the passages it needs.
 *
 * A scanned PDF has no text layer, so it can only be read page by page through vision.
 * That path is expensive, so it is quoted and confirmed rather than just run.
 */
import { chatJson } from './llm.js';
import { modelFor } from './settings.js';
import { verifyAgainstText } from './verify.js';
import { extractPdf, pdftotextAvailable, estimateVisionTokens } from './pdf.js';
import { chunkText, embedPending } from './chunks.js';
import * as store from './db.js';

export const MAX_BYTES = 18 * 1024 * 1024; // Telegram will not hand us more than ~20MB

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|html?|xml|srt|vtt)$/i;
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

/** @returns {'text'|'image'|'pdf'|'unsupported'} */
export function classify({ filename = '', mime = '' }) {
  if (IMAGE_MIME.test(mime) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(filename)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf';
  if (mime.startsWith('text/') || TEXT_EXT.test(filename)) return 'text';
  if (mime === 'application/json') return 'text';
  return 'unsupported';
}

const dataUrl = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`;

const CLAIMS_SYSTEM = `از متن زیر ادعاهای مشخص استخراج کن. فقط JSON بده، بدون توضیح و بدون code fence:

{
  "summary": "دو تا سه جمله فارسی: این سند چیست و چه می‌گوید",
  "claims": [
    { "text": "یک ادعای مشخص، به فارسی",
      "quote": "عین همان جمله از متن، کلمه‌به‌کلمه، بدون ترجمه و بدون تغییر" }
  ]
}

قواعد:
- quote باید عیناً از متن کپی شود. خودکار تطبیق داده می‌شود و بازنویسی رد می‌شود.
- چیزی که در متن نیست ننویس. اگر متن بی‌محتوا بود، claims را خالی بگذار.
- حداکثر ۱۰ ادعای مهم. متن کامل را برنگردان — فقط ادعاها.`;

const VISION_SYSTEM = `محتوای این تصویر را بخوان. فقط JSON بده، بدون code fence:

{
  "text": "هر متنی که در تصویر می‌بینی، به همان زبان. جدول را خطی بنویس (هر سطر: ستون: مقدار). اگر نمودار یا شکل است، آنچه نشان می‌دهد را توصیف کن.",
  "summary": "دو جمله فارسی درباره‌ی اینکه این تصویر چیست",
  "has_tables": false
}`;

/**
 * Refuses a file before anything is spent on it.
 * Separate from extraction so the guards can be exercised without a model.
 */
export function guard({ buffer, filename, mime }) {
  const kind = classify({ filename, mime });
  if (kind === 'unsupported') {
    throw new Error(`این نوع فایل پشتیبانی نمی‌شود: ${mime || filename}. متن، PDF یا تصویر بفرست.`);
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error(`فایل خیلی بزرگ است (${Math.round(buffer.length / 1024 / 1024)}MB، سقف ${MAX_BYTES / 1024 / 1024}MB).`);
  }
  return kind;
}

/** Pull text out of a file, as cheaply as the file allows. */
export async function extractText({ buffer, filename, mime, kind, allowVision, pageLimit }) {
  if (kind === 'text') {
    return { text: buffer.toString('utf8'), extraction: 'local', pages: null, costToman: 0 };
  }

  if (kind === 'pdf') {
    const pdf = await extractPdf(buffer);
    if (!pdf.scanned) {
      return { text: pdf.text, extraction: 'local', pages: pdf.pages, costToman: 0, perPage: pdf.perPage };
    }
    if (!allowVision) {
      const err = new Error('scanned');
      err.scanned = { pages: pdf.pages, estTokens: estimateVisionTokens(pdf.pages) };
      throw err;
    }
    // Scanned PDFs go to the model whole; page-by-page rasterising is a later step.
    const { data, usage } = await chatJson({
      model: modelFor('capture'),
      system: VISION_SYSTEM,
      content: [
        { type: 'file', file: { filename: filename || 'doc.pdf', file_data: dataUrl('application/pdf', buffer) } },
        { type: 'text', text: `این PDF اسکن‌شده را بخوان${pageLimit ? ` (فقط ${pageLimit} صفحه‌ی اول)` : ''}.` },
      ],
      maxTokens: 8000,
      noThinking: false,
    });
    return { text: String(data.text ?? ''), extraction: 'model_file', pages: pdf.pages, costToman: usage.costToman ?? 0 };
  }

  // image
  const { data, usage } = await chatJson({
    model: modelFor('capture'),
    system: VISION_SYSTEM,
    content: [
      { type: 'image_url', image_url: { url: dataUrl(mime || 'image/jpeg', buffer) } },
      { type: 'text', text: 'این تصویر را بخوان.' },
    ],
    maxTokens: 3000,
    noThinking: false,
  });
  return {
    text: String(data.text ?? ''), extraction: 'model_vision', pages: null,
    costToman: usage.costToman ?? 0, summary: data.summary ?? null, hasTables: Boolean(data.has_tables),
  };
}

/** Claims come from a bounded slice, not the whole book. */
async function claimsFrom(text, filename) {
  const sample = text.length > 40000
    ? `${text.slice(0, 24000)}\n\n[…]\n\n${text.slice(-12000)}`
    : text;
  const { data, usage } = await chatJson({
    model: modelFor('structure'),
    system: CLAIMS_SYSTEM,
    content: `سند «${filename}»:\n\n${sample}`,
    maxTokens: 3000,
    noThinking: false,
  });
  return {
    summary: data.summary ?? null,
    claims: Array.isArray(data.claims) ? data.claims.slice(0, 10) : [],
    costToman: usage.costToman ?? 0,
  };
}

/**
 * Read a file into a dossier: extract, chunk, embed, and record claims whose quotes
 * were matched against the document's own text.
 *
 * Throws an error carrying `.scanned` when a PDF needs the expensive path, so the
 * caller can quote a price and ask.
 */
export async function ingestToDossier({
  principalId, dossierId, buffer, filename, mime, onProgress,
  allowVision = false, pageLimit = null,
}) {
  const kind = guard({ buffer, filename, mime });
  if (kind === 'pdf' && !await pdftotextAvailable()) {
    throw new Error('pdftotext نصب نیست. روی سرور: apt install -y poppler-utils');
  }

  onProgress?.('استخراج متن…');
  const extracted = await extractText({ buffer, filename, mime, kind, allowVision, pageLimit });
  let costToman = extracted.costToman ?? 0;

  const documentId = store.insertDocument({
    principalId, dossierId, filename, mime, kind,
    pages: extracted.pages, charCount: extracted.text.length,
    extraction: extracted.extraction, costToman,
  });

  // Chunk with page numbers where pdftotext gave us page boundaries.
  const rows = [];
  if (extracted.perPage?.length) {
    let seq = 0;
    extracted.perPage.forEach((pageText, i) => {
      for (const c of chunkText(pageText)) rows.push({ seq: seq++, page: i + 1, text: c });
    });
  } else {
    chunkText(extracted.text).forEach((c, i) => rows.push({ seq: i, page: null, text: c }));
  }
  store.insertChunks(principalId, dossierId, documentId, rows);

  let embedded = 0;
  if (rows.length) {
    onProgress?.(`${rows.length} تکه ذخیره شد. در حال ساخت بردارها…`);
    try {
      const e = await embedPending(principalId, dossierId,
        (n) => onProgress?.(`بردار ${n} از ${rows.length}…`));
      embedded = e.embedded;
      costToman += e.costToman;
    } catch (err) {
      // Keyword search still works without vectors, so this is a degradation, not a failure.
      console.warn('[ingest] embedding failed:', err.message);
    }
  }

  onProgress?.('استخراج ادعاها…');
  let summary = extracted.summary ?? null;
  let claims = [];
  if (extracted.text.trim()) {
    const c = await claimsFrom(extracted.text, filename);
    summary = c.summary ?? summary;
    claims = c.claims;
    costToman += c.costToman;
  }

  const verified = [];
  const found = [];
  for (const c of claims) {
    const result = kind === 'image'
      ? { status: 'found', method: null, note: 'از روی تصویر خوانده شد — با نقل‌قول قابل تأیید نیست' }
      : verifyAgainstText(extracted.text, c.quote, 'document_quote_matched');

    const row = {
      text: c.text ?? '', sourceUrl: null, sourceTitle: filename || 'سند کاربر',
      quote: c.quote ?? null, status: result.status,
      verifyMethod: result.method, verifyNote: result.note,
    };
    store.insertClaim({ principalId, dossierId, ...row });
    (result.status === 'verified' ? verified : found).push(row);
  }

  return {
    documentId, kind, filename, summary, verified, found,
    pages: extracted.pages, chunks: rows.length, embedded,
    textLength: extracted.text.length, extraction: extracted.extraction,
    hasTables: extracted.hasTables ?? false,
    costToman,
  };
}
