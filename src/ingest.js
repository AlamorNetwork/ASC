/**
 * Reading a document the user supplied into a dossier.
 *
 * A user-supplied file is a better source than a random web page, but it gets the same
 * treatment: claims are extracted with exact quotes, and each quote is matched against
 * the document's own text. Anything that does not match stays 📄, not ✅.
 *
 * Images are the exception — there is no text to match a quote against, so claims read
 * out of a picture are always 📄 and say so.
 */
import { chatJson } from './llm.js';
import { modelFor } from './settings.js';
import { verifyAgainstText } from './verify.js';
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

const EXTRACT_SYSTEM = `تو محتوای یک سند را برای بایگانی پژوهشی استخراج می‌کنی.
فقط یک شیء JSON بده، بدون توضیح و بدون code fence:

{
  "text": "متن کامل سند، به همان زبان اصلی. جدول‌ها را به صورت خطی و خوانا بنویس (هر سطر: ستون: مقدار). اگر تصویر یا نمودار هست، آن را در همان جای متن با [تصویر: توضیح آنچه نشان می‌دهد] بنویس.",
  "summary": "دو تا سه جمله فارسی درباره‌ی اینکه این سند چیست و چه می‌گوید",
  "claims": [
    { "text": "یک ادعای مشخص از سند، به فارسی",
      "quote": "عین همان جمله از سند، کلمه‌به‌کلمه و بدون تغییر و بدون ترجمه" }
  ],
  "has_tables": false,
  "has_images": false
}

قواعد:
- quote باید عیناً از متن سند کپی شود. خودکار با متن سند تطبیق داده می‌شود و بازنویسی رد می‌شود.
- چیزی که در سند نیست ننویس. اگر سند کوتاه یا بی‌محتوا بود، claims را خالی بگذار.
- حداکثر ۱۰ ادعا، مهم‌ترین‌ها.`;

const dataUrl = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`;

/**
 * Pulls structured content out of one file. Text files are read directly — no model
 * call and no cost. Images and PDFs go to the model.
 */
export async function extract({ buffer, filename, mime }) {
  const kind = classify({ filename, mime });

  if (kind === 'unsupported') {
    throw new Error(`این نوع فایل پشتیبانی نمی‌شود: ${mime || filename}. متن، PDF یا تصویر بفرست.`);
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error(`فایل خیلی بزرگ است (${Math.round(buffer.length / 1024 / 1024)}MB، سقف ${MAX_BYTES / 1024 / 1024}MB).`);
  }

  if (kind === 'text') {
    const text = buffer.toString('utf8');
    return { kind, text, summary: null, claims: [], usage: { costToman: 0, costUsd: 0 }, needsClaims: true };
  }

  const part = kind === 'image'
    ? { type: 'image_url', image_url: { url: dataUrl(mime || 'image/jpeg', buffer) } }
    : { type: 'file', file: { filename: filename || 'document.pdf', file_data: dataUrl('application/pdf', buffer) } };

  const { data, usage } = await chatJson({
    model: modelFor('capture'), // the audio-capable model is the multimodal one
    system: EXTRACT_SYSTEM,
    content: [part, { type: 'text', text: `این سند را استخراج کن: ${filename || 'بدون نام'}` }],
    maxTokens: 6000,
    noThinking: false,
  });

  return {
    kind,
    text: String(data.text ?? ''),
    summary: data.summary ?? null,
    claims: Array.isArray(data.claims) ? data.claims.slice(0, 10) : [],
    hasTables: Boolean(data.has_tables),
    hasImages: Boolean(data.has_images),
    usage,
    needsClaims: false,
  };
}

/** For a plain text file, the claims still have to come from somewhere. */
async function claimsFromText(text, filename) {
  const { data, usage } = await chatJson({
    model: modelFor('structure'),
    system: EXTRACT_SYSTEM,
    content: `سند «${filename}»:\n\n${text.slice(0, 60000)}`,
    maxTokens: 4000,
    noThinking: false,
  });
  return {
    summary: data.summary ?? null,
    claims: Array.isArray(data.claims) ? data.claims.slice(0, 10) : [],
    hasTables: Boolean(data.has_tables),
    usage,
  };
}

/**
 * Read a file into a dossier: extract, verify each quote against the document's own
 * text, and store the claims.
 */
export async function ingestToDossier({ principalId, dossierId, buffer, filename, mime, onProgress }) {
  onProgress?.('در حال خواندن سند…');
  const extracted = await extract({ buffer, filename, mime });

  let { summary, claims, hasTables } = extracted;
  let costToman = extracted.usage.costToman ?? 0;

  if (extracted.needsClaims && extracted.text.trim()) {
    onProgress?.('استخراج ادعاها…');
    const second = await claimsFromText(extracted.text, filename);
    summary = second.summary;
    claims = second.claims;
    hasTables = second.hasTables;
    costToman += second.usage.costToman ?? 0;
  }

  onProgress?.(`بررسی ${claims.length} ادعا در برابر متن سند…`);

  const verified = [];
  const found = [];
  for (const c of claims) {
    // An image has no text to match against, so its claims can never be verified this way.
    const result = extracted.kind === 'image' && !extracted.text.trim()
      ? { status: 'found', method: null, note: 'از روی تصویر خوانده شد — با نقل‌قول قابل تأیید نیست' }
      : verifyAgainstText(extracted.text, c.quote, 'document_quote_matched');

    const row = {
      text: c.text ?? '',
      sourceUrl: null,
      sourceTitle: filename || 'سند کاربر',
      quote: c.quote ?? null,
      status: result.status,
      verifyMethod: result.method,
      verifyNote: result.note,
    };
    store.insertClaim({ principalId, dossierId, ...row });
    (result.status === 'verified' ? verified : found).push(row);
  }

  return {
    kind: extracted.kind,
    filename,
    summary,
    verified,
    found,
    hasTables,
    hasImages: extracted.hasImages,
    textLength: extracted.text.length,
    costToman,
  };
}
