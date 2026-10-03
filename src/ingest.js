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
import { createHash } from 'node:crypto';
import { chat, chatJson } from './llm.js';
import { modelFor } from './settings.js';
import { verifyAgainstText } from './verify.js';
import { gateClaims } from './support.js';
import { extractPdf, pdftotextAvailable, estimateVisionTokens, renderPages, scannedPages, pageNeedsVision } from './pdf.js';
import { chunkText, embedPending } from './chunks.js';
import * as store from './db.js';
import { MAX_DOCUMENT_BYTES } from './file-limits.js';
import { checkpoint } from './cancel.js';

// The hosted Telegram API has its own 20 MB download ceiling. A local Bot API
// server removes that limit; keep an application limit to bound memory use.
export const MAX_BYTES = MAX_DOCUMENT_BYTES;

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

/** A document is identified by its bytes, not its filename. */
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const CLAIMS_SYSTEM = `از متن زیر ادعاهای مشخص استخراج کن. فقط JSON بده، بدون توضیح و بدون code fence:

{
  "summary": "دو تا سه جمله فارسی: این سند چیست و چه می‌گوید",
  "claims": [
    { "text": "یک ادعای مشخص، به فارسی",
      "quote": "عین همان جمله از متن، کلمه‌به‌کلمه، بدون ترجمه و بدون تغییر" }
  ],
  "leads": [
    { "hypothesis": "یک فرضیهٔ قابل جست‌وجو که متن به آن اشارهٔ غیرمستقیم دارد",
      "cue_quote": "عبارت دقیق و پیوسته‌ای از سند که این فرضیه را مطرح می‌کند" }
  ]
}

قواعد:
- quote باید عیناً از متن کپی شود. خودکار تطبیق داده می‌شود و بازنویسی رد می‌شود.
- claims فقط ادعاهای صریح سند است. اگر نتیجه فقط از کنایه یا اشاره برمی‌آید، آن را در leads بگذار، نه claims.
- leads فرضیه‌اند، نه واقعیت؛ از دانش بیرونی چیزی به متن نسبت نده. cue_quote باید عیناً در سند باشد.
- اگر متن بی‌محتوا بود، هر دو فهرست را خالی بگذار.
- حداکثر ۱۰ ادعا و ۵ سرنخ. متن کامل را برنگردان.`;

// Plain text, deliberately not JSON: a page of a book is long enough that a JSON
// string can hit the token cap mid-value, and then there is nothing to parse.
const PAGE_SYSTEM = `متن این صفحه را دقیقاً همان‌طور که هست بنویس.
- فقط خود متن. بدون توضیح، بدون مقدمه، بدون JSON.
- جدول را خطی بنویس: هر سطر به شکل «ستون: مقدار».
- شکل و نمودار را در جای خودش به شکل [تصویر: توضیح کوتاه] بنویس.
- اگر صفحه خالی است یا متنی ندارد، فقط بنویس: [خالی]`;

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
export async function extractText({ buffer, filename, mime, kind, allowVision, pageLimit, fromPage = 1, onProgress }) {
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
      err.scanned = { pages: pdf.pages, visionPages: pdf.visionPages.length,
        estTokens: estimateVisionTokens(pdf.visionPages.length) };
      throw err;
    }

    // One page at a time. Each call returns a page's worth of text, which stays well
    // inside the token cap and lets progress be reported and a limit be honoured.
    // `fromPage` lets a half-read book carry on instead of paying for it twice.
    const start = Math.max(1, fromPage);
    const last = pageLimit ? Math.min(start + pageLimit - 1, pdf.pages) : pdf.pages;
    if (start > pdf.pages) {
      return { text: '', extraction: 'model_vision_pages', pages: pdf.pages, readPages: pdf.pages, costToman: 0, perPage: [] };
    }
    onProgress?.(`تبدیل صفحه ${start} تا ${last} به تصویر…`);
    const rendered = await renderPages(buffer, { from: start, to: last });

    const perPage = [];
    let costToman = 0;
    for (const { page, buffer: png } of rendered) {
      const { text, usage } = await chat({
        model: modelFor('capture'),
        system: PAGE_SYSTEM,
        content: [
          { type: 'image_url', image_url: { url: dataUrl('image/png', png) } },
          { type: 'text', text: `صفحه ${page}` },
        ],
        maxTokens: 2500,
        noThinking: false,
      });
      costToman += usage.costToman ?? 0;
      perPage.push(text.trim() === '[خالی]' ? '' : text);
      onProgress?.(`صفحه ${page} از ${last} · ${Math.round(costToman).toLocaleString('fa-IR')} تومان`);
    }

    return {
      text: perPage.join('\n\n'), extraction: 'model_vision_pages',
      pages: pdf.pages, readPages: last, costToman, perPage,
    };
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
async function claimsFrom(text, filename, onProgress) {
  const sample = text.length > 40000
    ? `${text.slice(0, 24000)}\n\n[…]\n\n${text.slice(-12000)}`
    : text;
  const { data, usage } = await chatJson({
    model: modelFor('structure'),
    system: CLAIMS_SYSTEM,
    content: `سند «${filename}»:\n\n${sample}`,
    maxTokens: 3000,
    noThinking: false,
    // The structure role is usually a chain of free models, and a chain that is quietly
    // working through its links looks exactly like one that has died. Saying which link
    // is being tried is the difference.
    onAttempt: ({ model, tried, of }) =>
      onProgress?.(of > 1 ? `استخراج ادعاها… (${tried} از ${of}: ${model})` : 'استخراج ادعاها…'),
  });
  return {
    summary: data.summary ?? null,
    claims: Array.isArray(data.claims) ? data.claims.slice(0, 10) : [],
    leads: Array.isArray(data.leads) ? data.leads.slice(0, 5) : [],
    costToman: usage.costToman ?? 0,
  };
}

/** A cue found in a document is a reason to investigate, never proof of the hypothesis. */
export function implicitLeadRows(leads, { text, kind, filename }) {
  const rows = [];
  for (const lead of leads ?? []) {
    const hypothesis = String(lead?.hypothesis ?? '').trim().slice(0, 500);
    const cue = String(lead?.cue_quote ?? '').trim().slice(0, 1000);
    if (!hypothesis || !cue) continue;
    if (verifyAgainstText(text, cue).status !== 'verified') continue;
    rows.push({ text: hypothesis, sourceUrl: null, sourceTitle: filename || 'سند کاربر',
      quote: cue, status: 'found',
      verifyMethod: kind === 'image' ? null : 'document_cue_matched',
      verifyReason: kind === 'image' ? 'vision_cue_unverified' : 'implicit_lead',
      verifyNote: kind === 'image'
        ? 'سرنخ ضمنی از متن خوانده‌شده با ویژن؛ تصویر مستقلاً بررسی نشده است'
        : 'سرنخ ضمنی؛ عبارت در سند هست اما فرضیه از آن ثابت نمی‌شود. برای وب جست‌وجو شود',
    });
  }
  return rows;
}

/**
 * Store each claim with the verdict of matching its quote against the document itself.
 *
 * A quote is checked against the text the claim came from, so a model that paraphrased
 * instead of copying is caught here rather than believed. An image has no text layer to
 * match against, so its claims are recorded as read-but-unverifiable — which is honest,
 * and different from verified.
 */
async function recordClaims({ principalId, dossierId, claims, leads = [], kind, text, filename }) {
  const candidates = [];
  for (const c of claims) {
    const result = kind === 'image'
      ? { status: 'found', method: null, reason: 'vision_unverified',
        note: 'از روی تصویر خوانده شد؛ تطبیق با متن OCR تأیید مستقلِ تصویر نیست' }
      : verifyAgainstText(text, c.quote, 'document_quote_matched');

    const row = {
      text: c.text ?? '', sourceUrl: null, sourceTitle: filename || 'سند کاربر',
      quote: c.quote ?? null, status: result.status,
      verifyMethod: result.method, verifyNote: result.note, verifyReason: result.reason ?? null,
    };
    candidates.push(row);
  }
  const gated = await gateClaims(candidates);
  const verified = [], found = [];
  for (const row of gated.rows) {
    store.insertClaim({ principalId, dossierId, ...row });
    (row.status === 'verified' ? verified : found).push(row);
  }
  for (const row of implicitLeadRows(leads, { text, kind, filename })) {
    store.insertClaim({ principalId, dossierId, ...row });
    found.push(row);
  }
  return { verified, found, costToman: gated.usage.costToman ?? 0 };
}

/**
 * Run the claim pass again over a document that is already stored.
 *
 * The text comes back from the chunks, not the file, so a scanned book that cost real
 * money to read through vision is never read a second time — this is the cheap half of
 * an ingest, and the half that fails when the structure chain is slow.
 */
export async function extractClaimsFor({ principalId, documentId, onProgress }) {
  const doc = store.getDocument(principalId, documentId);
  if (!doc) throw new Error(`سند #${documentId} پیدا نشد.`);

  const text = store.documentText(principalId, documentId);
  if (!text.trim()) throw new Error(`سند #${documentId} متن ذخیره‌شده‌ای ندارد.`);

  const already = store.dossierClaims(principalId, doc.dossier_id)
    .filter((c) => c.source_title === (doc.filename || 'سند کاربر')).length;
  if (already) {
    throw new Error(`این سند از قبل ${already} ادعا دارد — دوباره اجرا کردن فقط تکرارشان می‌کند.`);
  }

  const c = await claimsFrom(text, doc.filename, onProgress);
  const { verified, found, costToman: supportCost } = await recordClaims({
    principalId, dossierId: doc.dossier_id, claims: c.claims, leads: c.leads,
    // The saved text of a scan was itself generated by vision. Matching a quote to
    // that OCR text does not independently verify it against the image pixels.
    kind: doc.extraction === 'model_vision_pages' ? 'image' : doc.kind,
    text, filename: doc.filename,
  });
  return {
    dossierId: doc.dossier_id, filename: doc.filename,
    summary: c.summary, verified, found, costToman: c.costToman + supportCost,
  };
}

/** Persist each paid vision result before requesting the next page. */
export async function ingestScannedPages({
  principalId, dossierId, buffer, filename, mime, pages, fromPage = 1,
  pageLimit = null, resumeDocumentId = null, onProgress,
  pagesIterator = scannedPages, readPage = null, localPerPage = null,
}) {
  const hash = sha256(buffer);
  const prior = resumeDocumentId ? store.getDocument(principalId, resumeDocumentId)
    : store.findDocumentByHash(principalId, dossierId, hash);
  if (prior && (prior.dossier_id !== dossierId || prior.sha256 !== hash))
    throw new Error('فایل با سند ذخیره‌شده مطابقت ندارد.');
  const documentId = prior?.id ?? store.insertDocument({
    principalId, dossierId, filename, mime, kind: 'pdf', pages,
    charCount: 0, extraction: 'model_vision_pages', costToman: 0,
    sha256: hash, readPages: 0,
  });
  const start = Math.max(fromPage, (prior?.read_pages ?? 0) + 1);
  const last = Math.min(pages, pageLimit ? start + pageLimit - 1 : pages);
  const perPage = [];
  let costToman = 0;
  let costKnown = true;
  let chunks = 0;
  let seq = store.maxChunkSeq(documentId) + 1;
  const skipPages = new Set();
  for (let page = start; page <= last; page++)
    if (localPerPage && !pageNeedsVision(localPerPage[page - 1])) skipPages.add(page);
  try {
    for await (const { page, buffer: png } of pagesIterator(buffer, { from: start, to: last, skipPages })) {
      checkpoint(principalId, `پیش از صفحه ${page}`);
      const local = skipPages.has(page);
      const result = local ? { text: localPerPage[page - 1], usage: { costToman: 0 } }
        : readPage ? await readPage(page, png) : await chat({
        model: modelFor('capture'), system: PAGE_SYSTEM,
        content: [
          { type: 'image_url', image_url: { url: dataUrl('image/png', png) } },
          { type: 'text', text: `صفحه ${page}` },
        ],
        maxTokens: 2500, noThinking: false,
      });
      const raw = String(result.text ?? '').trim();
      const outcome = local ? 'local_text' : raw === '[خالی]' ? 'blank' : raw ? 'vision_text' : 'model_no_text';
      const text = outcome === 'blank' || outcome === 'model_no_text' ? '' : raw;
      const price = result.usage?.costToman ?? 0;
      if (!local && !price && !result.usage?.costUsd) costKnown = false;
      // A title page may contain fewer than chunkText's 40-character threshold.
      const parts = chunkText(text);
      if (text && !parts.length) parts.push(text);
      const rows = parts.map((part) => ({ seq: seq++, page, text: part }));
      store.saveScannedPage(principalId, dossierId, documentId, page, text, price, rows, outcome);
      perPage.push(text);
      chunks += rows.length;
      costToman += price;
      onProgress?.(`صفحه ${page} از ${last} ${outcome === 'model_no_text' ? 'بدون خروجی مدل ثبت شد؛ ادامه می‌دهم' : outcome === 'blank' ? 'خالی ثبت شد' : 'ذخیره شد'}` +
        (costKnown ? ` · ${Math.round(costToman).toLocaleString('fa-IR')} تومان` : ' · هزینه را از پنل ارائه‌دهنده ببین'));
    }
  } catch (err) {
    const saved = store.getDocument(principalId, documentId)?.read_pages ?? 0;
    err.savedScan = { documentId, readPages: saved, pages };
    throw err;
  }
  return {
    documentId, text: perPage.join('\n\n'), perPage, pages,
    readPages: store.getDocument(principalId, documentId).read_pages,
    chunks, costToman, costKnown, extraction: 'model_vision_pages',
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
  allowVision = false, pageLimit = null, fromPage = 1, resumeDocumentId = null,
}) {
  const kind = guard({ buffer, filename, mime });
  if (kind === 'pdf' && !await pdftotextAvailable()) {
    throw new Error('pdftotext نصب نیست. روی سرور: apt install -y poppler-utils');
  }

  onProgress?.('استخراج متن…');
  if (kind === 'pdf' && allowVision) {
    const pdf = await extractPdf(buffer);
    if (pdf.scanned) {
      const scan = await ingestScannedPages({
        principalId, dossierId, buffer, filename, mime, pages: pdf.pages,
        fromPage, pageLimit, resumeDocumentId, onProgress, localPerPage: pdf.perPage,
      });
      let costToman = scan.costToman;
      let embedded = 0;
      if (scan.chunks) {
        try {
          const e = await embedPending(principalId, dossierId,
            (n) => onProgress?.(`بردار ${n} از ${scan.chunks}…`));
          embedded = e.embedded;
          costToman += e.costToman;
        } catch (err) { console.warn('[ingest] embedding failed:', err.message); }
      }
      // The long structure call used to stall a successful scan at "extracting claims".
      // Reading the book and producing claims are separate paid jobs; /claims runs later
      // from the stored chunks without sending any page through vision again.
      return { documentId: scan.documentId, kind, filename, summary: null,
        verified: [], found: [], claimsDeferred: true, claimsFailed: null,
        pages: scan.pages, readPages: scan.readPages, chunks: scan.chunks,
        embedded, textLength: scan.text.length, extraction: scan.extraction,
        hasTables: false, costToman, costKnown: scan.costKnown };
    }
  }
  const extracted = await extractText({
    buffer, filename, mime, kind, allowVision, pageLimit, fromPage, onProgress,
  });
  let costToman = extracted.costToman ?? 0;

  // Resuming appends to the same document, so pages already paid for are not re-read
  // and the book stays one document rather than several partial copies.
  const resuming = Boolean(resumeDocumentId);
  const documentId = resuming ? resumeDocumentId : store.insertDocument({
    principalId, dossierId, filename, mime, kind,
    pages: extracted.pages, charCount: extracted.text.length,
    extraction: extracted.extraction, costToman,
    sha256: sha256(buffer), readPages: extracted.readPages ?? null,
  });
  if (resuming) {
    store.advanceDocument(documentId, {
      readPages: extracted.readPages ?? null,
      addedChars: extracted.text.length,
      addedCost: costToman,
    });
  }

  // Chunk with page numbers where the extractor gave us page boundaries.
  const rows = [];
  let seq = resuming ? store.maxChunkSeq(documentId) + 1 : 0;
  if (extracted.perPage?.length) {
    extracted.perPage.forEach((pageText, i) => {
      for (const c of chunkText(pageText)) rows.push({ seq: seq++, page: fromPage + i, text: c });
    });
  } else {
    for (const c of chunkText(extracted.text)) rows.push({ seq: seq++, page: null, text: c });
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
  let leads = [];
  let claimsFailed = null;
  if (extracted.text.trim()) {
    // By this point the document, its chunks and its vectors are all stored, and that is
    // the part that cost money and answers questions. Claims are a convenience on top.
    // Letting this throw discarded a whole scanned book because one model was slow — the
    // user saw a red error and reasonably concluded nothing had been read at all.
    try {
      const c = await claimsFrom(extracted.text, filename, onProgress);
      summary = c.summary ?? summary;
      claims = c.claims;
      leads = c.leads;
      costToman += c.costToman;
    } catch (err) {
      claimsFailed = err.message;
      console.warn('[ingest] claim extraction failed:', err.message);
    }
  }

  const { verified, found, costToman: supportCost } = await recordClaims({
    principalId, dossierId, claims, leads, kind, text: extracted.text, filename });
  costToman += supportCost;

  return {
    documentId, kind, filename, summary, verified, found, claimsFailed,
    pages: extracted.pages, readPages: extracted.readPages ?? null,
    chunks: rows.length, embedded,
    textLength: extracted.text.length, extraction: extracted.extraction,
    hasTables: extracted.hasTables ?? false,
    costToman,
  };
}
