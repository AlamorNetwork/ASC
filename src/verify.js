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

async function fetchText(url, timeoutMs = 15000) {
  if (pageCache.has(url)) return pageCache.get(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ASC/0.1; +local)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = ct.includes('html') ? htmlToText(body) : body;
    const result = { ok: true, text };
    pageCache.set(url, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    pageCache.set(url, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Match a quote against text we already hold. Used both for a fetched page and for a
 * document the user supplied, so a claim drawn from either is checked the same way.
 * @returns {{status:'verified'|'found', method:string|null, note:string}}
 */
export function verifyAgainstText(text, quote, method = 'source_fetched_quote_matched') {
  if (!quote || normalise(quote).length < 12) {
    return { status: 'found', method: null, note: 'نقل‌قول دقیقی ارائه نشد' };
  }
  const haystack = normalise(text);
  const needle = normalise(quote);

  if (haystack.includes(needle)) {
    return { status: 'verified', method, note: 'نقل‌قول در منبع پیدا شد' };
  }

  // Report how close it was, so a near miss is visible rather than silent.
  const words = needle.split(' ').filter((w) => w.length > 2);
  const hits = words.filter((w) => haystack.includes(w)).length;
  const ratio = words.length ? hits / words.length : 0;
  return {
    status: 'found',
    method: null,
    note: `نقل‌قول عیناً در منبع نبود (${Math.round(ratio * 100)}٪ کلمات موجود بود)`,
  };
}

/**
 * @returns {{status:'verified'|'found', method:string|null, note:string}}
 */
export async function verifyClaim({ sourceUrl, quote }) {
  if (!sourceUrl) return { status: 'found', method: null, note: 'بدون منبع' };
  if (!quote || normalise(quote).length < 12) {
    return { status: 'found', method: null, note: 'نقل‌قول دقیقی ارائه نشد' };
  }

  const page = await fetchText(sourceUrl);
  if (!page.ok) {
    return { status: 'found', method: null, note: `منبع باز نشد (${page.error})` };
  }

  return verifyAgainstText(page.text, quote);
}
