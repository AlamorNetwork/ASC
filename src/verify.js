/**
 * Verification is done by this file, never by a model.
 * A claim is VERIFIED only when a declared procedure succeeds — here, when the
 * quoted span is actually present in the fetched source.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

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

/**
 * Whether a failure means the page is not there, or only that we were not let in.
 *
 * A model that gives a 404, a domain that does not resolve, or a URL with a space in
 * the middle of it did not cite a source — it made one up, and that is the single worst
 * thing a research model can do. A 403 from Britannica is our problem instead. Putting
 * both in one bucket is how qwen's invented Iranica link first passed for a blocked one.
 */
function fabricated(status, err) {
  if (status === 404 || status === 410) return true;
  const m = String(err ?? '');
  return /Failed to parse URL|Invalid URL|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL/i.test(m);
}

function publicAddress(address) {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(ip) === 6) return !(ip === '::1' || ip === '::' ||
    /^[fd]/.test(ip) || /^fc/.test(ip) || /^fe[89ab]/.test(ip) ||
    ip.startsWith('::ffff:'));
  return false;
}

async function checkUrl(url, allowPrivate) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported URL protocol');
  if (parsed.username || parsed.password) throw new Error('URL credentials are not allowed');
  if (allowPrivate) return;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('private host is not a web source');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error('private address is not a web source');
}

async function get(url, timeoutMs, allowPrivate = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      await checkUrl(current, allowPrivate);
      const res = await fetch(current, { signal: ctrl.signal, redirect: 'manual', headers: BROWSER_HEADERS });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) return { ok: false, error: 'redirect without location' };
        current = new URL(location, current).href;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}`, missing: fabricated(res.status) };
      }
      const ct = res.headers.get('content-type') ?? '';
      const pdf = /application\/pdf/i.test(ct) || /\.pdf(?:[?#]|$)/i.test(current);
      if (!pdf && !/(html|text|json|xml)/i.test(ct))
        return { ok: false, error: `unsupported content type: ${ct}` };
      const byteLimit = pdf ? 15 * 1024 * 1024 : 2 * 1024 * 1024;
      if (Number(res.headers.get('content-length')) > byteLimit)
        return { ok: false, error: `source exceeds ${Math.round(byteLimit / 1024 / 1024)} MB limit` };
      const reader = res.body?.getReader();
      if (!reader) return { ok: false, error: 'empty response' };
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > byteLimit) {
          await reader.cancel();
          return { ok: false, error: `source exceeds ${Math.round(byteLimit / 1024 / 1024)} MB limit` };
        }
        chunks.push(value);
      }
      if (pdf) {
        const buffer = Buffer.concat(chunks);
        if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-')))
          return { ok: false, error: 'response is not a PDF' };
        try {
          const { extractPdf } = await import('./pdf.js');
          const parsed = await extractPdf(buffer);
          const text = parsed.perPage.map((page, i) => `[PDF page ${i + 1}]\n${page}`).join('\n');
          return text.trim().length > 250
            ? { ok: true, text, url: current, via: 'pdf_text', pages: parsed.pages,
              unreadPages: parsed.visionPages }
            : { ok: false, error: 'PDF has no readable text layer' };
        } catch (err) { return { ok: false, error: `PDF extraction failed: ${err.message}` }; }
      }
      const body = Buffer.concat(chunks).toString('utf8');
      return { ok: true, text: ct.includes('html') ? htmlToText(body) : body,
        url: current };
    }
    return { ok: false, error: 'too many redirects' };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'timeout' : (err.cause?.code ?? err.message);
    return { ok: false, error, missing: fabricated(null, `${error} ${err.message}`) };
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

async function fetchText(url, timeoutMs = 15000, allowPrivate = false) {
  const cacheKey = `${allowPrivate ? 'test' : 'public'}:${url}`;
  if (pageCache.has(cacheKey)) return pageCache.get(cacheKey);

  let result = await get(url, timeoutMs, allowPrivate);
  if (!result.ok && !/private|unsupported URL|URL credentials/i.test(String(result.error))) {
    const { error: live, missing } = result;
    const archived = await fromArchive(url);
    // Named so a quote matched against a years-old snapshot is never passed off as a
    // match against the page as it stands today.
    result = archived.ok
      ? { ...archived, note: `از آرشیو اینترنت (${archived.archived?.slice(0, 8) ?? 'نسخه‌ی بایگانی'})` }
      // A URL the archive has never seen either is a URL that very likely never existed.
      : { ok: false, error: live, missing };
  }

  pageCache.set(cacheKey, result);
  if (result.ok && result.url && result.url !== url)
    pageCache.set(`${allowPrivate ? 'test' : 'public'}:${result.url}`, result);
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
export async function verifyClaim({ sourceUrl, quote, allowPrivate = false }) {
  if (!sourceUrl) return { status: 'found', method: null, note: 'بدون منبع', reason: 'no_source' };
  if (!quote || normalise(quote).length < 12) {
    return { status: 'found', method: null, note: 'نقل‌قول دقیقی ارائه نشد', reason: 'no_quote' };
  }

  const page = await fetchText(sourceUrl, 15000, allowPrivate);
  if (!page.ok) {
    // A page that does not exist is a fabricated citation, and worse than no citation:
    // it looks like evidence. A page that exists but will not let us in is our limit.
    return page.missing
      ? {
        status: 'found', method: null, reason: 'fabricated_url',
        note: `این آدرس وجود ندارد (${page.error}) — منبع ساختگی است`,
      }
      : {
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

/** Fetch an actual public page before asking any model to make claims about it. */
export async function fetchSourceText(url) {
  const page = await fetchText(url);
  return page.ok ? { ok: true, url: page.url ?? url, text: page.text,
    archived: page.archived ?? null, via: page.via ?? 'direct',
    pages: page.pages ?? null, unreadPages: page.unreadPages ?? [] }
    : { ok: false, error: page.error, missing: page.missing };
}
