/**
 * Verification is done by this file, never by a model.
 * A claim is VERIFIED only when a declared procedure succeeds — here, when the
 * quoted span is actually present in the fetched source.
 */

const ZWNJ = /‌/g;

export function normalise(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/ي/g, 'ی')   // Arabic yeh -> Persian yeh
    .replace(/ك/g, 'ک')   // Arabic kaf -> Persian kaf
    .replace(ZWNJ, ' ')
    .replace(/[ً-ْـ]/g, '') // harakat, tatweel
    .replace(/[«»"'`´“”‘’]/g, '')
    .replace(/[.,;:!?()[\]{}—–\-_/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ');
}

const pageCache = new Map();

// Scholarly sites are the ones this project most wants to read and the ones most likely
// to refuse a bare request: Encyclopaedia Iranica returned 403 to the old header, which
// silently scored an excellent citation the same as a fabricated one. These are ordinary
// browser headers for fetching a public page the user asked about.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fa,en-US;q=0.9,en;q=0.8',
};

async function get(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    return { ok: true, text: ct.includes('html') ? htmlToText(body) : body };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The public Internet Archive copy, when the live page will not serve us.
 *
 * Britannica and Encyclopaedia Iranica both refuse this fetcher. Without a fallback the
 * verifier can only confirm claims drawn from sites that let anyone in, which quietly
 * rewards a model for citing Wikipedia over a specialist encyclopedia — the opposite of
 * what this project wants. Failure here costs one short request and changes nothing.
 */
async function fromArchive(url, timeoutMs = 12000) {
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const lookup = await get(api, timeoutMs);
  if (!lookup.ok) return { ok: false, error: lookup.error };
  try {
    const snap = JSON.parse(lookup.text)?.archived_snapshots?.closest;
    if (!snap?.url) return { ok: false, error: 'no snapshot' };
    const page = await get(snap.url, timeoutMs + 8000);
    return page.ok ? { ...page, archived: snap.timestamp } : page;
  } catch {
    return { ok: false, error: 'archive reply unreadable' };
  }
}

async function fetchText(url, timeoutMs = 15000) {
  if (pageCache.has(url)) return pageCache.get(url);

  let result = await get(url, timeoutMs);
  if (!result.ok) {
    const live = result.error;
    const archived = await fromArchive(url);
    // Named so a quote matched against a years-old snapshot is never passed off as a
    // match against the page as it stands today.
    result = archived.ok
      ? { ...archived, note: `از آرشیو اینترنت (${archived.archived?.slice(0, 8) ?? 'نسخه‌ی بایگانی'})` }
      : { ok: false, error: live };
  }

  pageCache.set(url, result);
  return result;
}

/**
 * Match a quote against text we already hold. Used both for a fetched page and for a
 * document the user supplied, so a claim drawn from either is checked the same way.
 * @returns {{status:'verified'|'found', method:string|null, note:string, reason:string}}
 */
export function verifyAgainstText(text, quote, method = 'source_fetched_quote_matched') {
  if (!quote || normalise(quote).length < 12) {
    return { status: 'found', method: null, note: 'نقل‌قول دقیقی ارائه نشد', reason: 'no_quote' };
  }
  const haystack = normalise(text);
  const needle = normalise(quote);

  if (haystack.includes(needle)) {
    return { status: 'verified', method, note: 'نقل‌قول در منبع پیدا شد', reason: 'matched' };
  }

  // Report how close it was, so a near miss is visible rather than silent.
  const words = needle.split(' ').filter((w) => w.length > 2);
  const hits = words.filter((w) => haystack.includes(w)).length;
  const ratio = words.length ? hits / words.length : 0;
  return {
    status: 'found',
    method: null,
    note: `نقل‌قول عیناً در منبع نبود (${Math.round(ratio * 100)}٪ کلمات موجود بود)`,
    reason: 'quote_absent',
  };
}

/**
 * `reason` separates the model's failure from ours. A quote that is not on the page is
 * the model's problem; a page we could not open is not, and scoring them the same made
 * a model that cited Encyclopaedia Iranica look exactly like one that invented a URL.
 *
 * @returns {{status:'verified'|'found', method:string|null, note:string, reason:string}}
 *   reason: matched | quote_absent | unreachable | no_source | no_quote
 */
export async function verifyClaim({ sourceUrl, quote }) {
  if (!sourceUrl) return { status: 'found', method: null, note: 'بدون منبع', reason: 'no_source' };
  if (!quote || normalise(quote).length < 12) {
    return { status: 'found', method: null, note: 'نقل‌قول دقیقی ارائه نشد', reason: 'no_quote' };
  }

  const page = await fetchText(sourceUrl);
  if (!page.ok) {
    return {
      status: 'found', method: null, reason: 'unreachable',
      note: `منبع باز نشد (${page.error}) — نتوانستم بررسی کنم، نه اینکه غلط باشد`,
    };
  }

  const out = verifyAgainstText(
    page.text, quote,
    page.archived ? 'archived_copy_quote_matched' : 'source_fetched_quote_matched');
  // Where the text came from belongs in the record, not just in the score.
  return page.note ? { ...out, note: `${out.note} · ${page.note}` } : out;
}
