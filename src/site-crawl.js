/** Bounded, same-origin HTML crawl. Page content and links are untrusted input. */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const PAGE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 5 * PAGE_BYTES;
const MAX_QUEUE = 200;
const TIMEOUT_MS = 10000;
const USER_AGENT = 'ASC-Site-Crawl/1.0';
const DOI_RESOLVERS = new Set(['doi.org', 'dx.doi.org']);

function publicIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 192 && b === 0 && c === 0 || a === 192 && b === 0 && c === 2 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const ip = address.toLowerCase();
    if (ip.includes('.')) return false; // Includes IPv4-mapped and compatible forms.
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return !(first === 0 || first === 0x64 || first === 0x2002 ||
      first >= 0xfc00 && first <= 0xfdff ||
      first >= 0xfe80 && first <= 0xfebf || first >= 0xff00 ||
      first === 0x2001 && /^2001:(?:0:|db8:)/i.test(ip));
  }
  return false;
}

function canonical(value, base, origin) {
  const u = new URL(value, base);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('unsupported or credentialed URL');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.test') ||
    net.isIP(host) && !publicIp(host)) throw new Error('private or reserved host');
  if (origin && u.origin !== origin) throw new Error('off-origin URL');
  u.hash = '';
  return u.href;
}

async function addressesFor(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] :
    await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIp(address)))
    throw new Error('private or unresolved address');
  return addresses;
}

function requestOnce(url, address, limit, plain = false, probe = false, method = 'GET') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(u, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      lookup: (_host, opts, cb) => opts?.all
        ? cb(null, [{ address: address.address, family: address.family }])
        : cb(null, address.address, address.family),
      timeout: TIMEOUT_MS,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.destroy();
        resolve({ redirect: location });
        return;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      if (probe) { res.destroy(); resolve({}); return; }
      const contentType = res.headers['content-type'] ?? '';
      if (!(plain ? /^text\/plain(?:\s*;|$)/i :
        /^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/i).test(contentType)) {
        res.destroy();
        reject(new Error('unsupported content type'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limit) { res.destroy(new Error('page exceeds byte limit')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), bytes }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function doiResolver(value) {
  return DOI_RESOLVERS.has(new URL(value).hostname.toLowerCase());
}

async function resolveDoiSeed(value) {
  let current = value;
  for (let hop = 0; hop < 6; hop++) {
    current = canonical(current);
    const addresses = await addressesFor(current);
    let result;
    try { result = await requestOnce(current, addresses[0], 0, false, true, 'HEAD'); }
    catch (error) {
      if (!/HTTP (?:403|405)/.test(error.message)) throw error;
      result = await requestOnce(current, addresses[0], 0, false, true, 'GET');
    }
    if (!('redirect' in result)) return current;
    if (!result.redirect) throw new Error('redirect without location');
    current = canonical(result.redirect, current);
  }
  throw new Error('too many DOI redirects');
}

async function defaultFetchPage(url, origin, limit, plain = false) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    current = canonical(current, undefined, origin);
    const addresses = await addressesFor(current);
    const result = await requestOnce(current, addresses[0], limit, plain);
    if (!('redirect' in result)) return { ...result, url: current };
    if (!result.redirect) throw new Error('redirect without location');
    current = canonical(result.redirect, current, origin);
  }
  throw new Error('too many redirects');
}

async function robotsRules(origin) {
  try {
    const { html } = await defaultFetchPage(`${origin}/robots.txt`, origin, 64 * 1024, true);
    const groups = [];
    let agents = [];
    let rules = [];
    for (const raw of html.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const match = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === 'user-agent') {
        if (rules.length) { groups.push({ agents, rules }); agents = []; rules = []; }
        agents.push(value.toLowerCase());
      } else if (agents.length && value) rules.push({ allow: key === 'allow', path: value });
    }
    groups.push({ agents, rules });
    const specific = groups.filter((group) => group.agents.includes('asc-site-crawl'));
    return (specific.length ? specific : groups.filter((group) => group.agents.includes('*')))
      .flatMap((group) => group.rules);
  } catch { return []; } // A missing or unavailable robots file does not make a site uncrawlable.
}

export function robotsAllow(url, rules) {
  const path = new URL(url).pathname + new URL(url).search;
  let winner;
  for (const rule of rules) {
    const exact = rule.path.endsWith('$');
    const value = exact ? rule.path.slice(0, -1) : rule.path;
    const pattern = `^${value.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*')}${exact ? '$' : ''}`;
    const specificity = value.replace(/\*/g, '').length;
    if (new RegExp(pattern).test(path) &&
      (!winner || specificity > winner.specificity ||
        specificity === winner.specificity && rule.allow)) winner = { ...rule, specificity };
  }
  return winner?.allow ?? true;
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(x[0-9a-f]+|\d+));/gi, (match, code) => {
    if (code) {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    }
    return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[match.toLowerCase()] ?? match;
  });
}

function parseHtml(html, url, origin) {
  const title = decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ').trim();
  const links = [];
  const seen = new Set();
  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const raw = tag[0].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!raw) continue;
    try {
      const link = canonical(decodeEntities(raw[1] ?? raw[2] ?? raw[3]), url, origin);
      if (!seen.has(link)) { seen.add(link); links.push(link); }
    } catch { /* Ignore unsafe or invalid links. */ }
  }
  const text = decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return { title, text, links };
}

/** Anti-bot/login interstitials are transport failures, never source content. */
export function blockedInterstitial({ title = '', text = '', html = '' } = {}) {
  const heading = String(title).toLowerCase();
  const body = `${text} ${html}`.replace(/[’‘]/g, "'").toLowerCase();
  return /\b(?:client challenge|just a moment|attention required|robot check|security check)\b/.test(heading) ||
    /a required part of this site (?:couldn't|could not) load|enable javascript and cookies to continue|verify (?:you are|you'?re) (?:human|not a robot)|checking (?:your )?browser|cf-chl-/.test(body);
}

/**
 * checkpoint may contain { nextUrls, visited }. Persist visited across calls to avoid
 * recrawling; returned nextUrls can be passed back as checkpoint.nextUrls.
 * fetchPage(url) is an optional test adapter returning { html, url? }.
 */
export async function crawlSite({ url, maxPages = 20, onPage, checkpoint, fetchPage, fallbackPage,
  seedResolver = resolveDoiSeed } = {}) {
  let seed = canonical(url);
  if (doiResolver(seed)) seed = canonical(await seedResolver(seed));
  const origin = new URL(seed).origin;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('maxPages must be a positive integer');
  if (checkpoint && (!Array.isArray(checkpoint.visited ?? []) ||
    !Array.isArray(checkpoint.nextUrls ?? []) || checkpoint.visited?.length > 10000 ||
    checkpoint.nextUrls?.length > MAX_QUEUE)) throw new Error('invalid checkpoint');
  const limit = Math.min(maxPages, 20);
  const visited = new Set();
  for (const value of checkpoint?.visited ?? []) {
    try { visited.add(canonical(value, undefined, origin)); } catch { /* Ignore invalid checkpoints. */ }
  }
  const queue = [];
  const queued = new Set();
  const discovered = [];
  function enqueue(value) {
    let target;
    try { target = canonical(value, undefined, origin); } catch { return; }
    if (visited.has(target) || queued.has(target) || queue.length >= MAX_QUEUE) return;
    queued.add(target);
    queue.push(target);
    discovered.push(target);
  }
  for (const value of checkpoint?.nextUrls ?? [seed]) enqueue(value);
  // A DOI resolver changes the crawl origin. A checkpoint written before resolution
  // may still contain doi.org and is intentionally rejected by enqueue; restart at
  // the resolved publisher page instead of falsely marking the crawl complete.
  if (!queue.length && !visited.has(seed)) enqueue(seed);
  const pages = [];
  const errors = [];
  const retryLater = [];
  let totalBytes = 0;
  let fallbackCalls = 0;
  const rules = fetchPage ? [] : await robotsRules(origin);
  while (queue.length && pages.length + errors.length < limit) {
    if (TOTAL_BYTES - totalBytes < PAGE_BYTES) break;
    const target = queue.shift();
    try {
      if (!robotsAllow(target, rules)) throw new Error('blocked by robots.txt');
      let result;
      let nativeError;
      try { result = await (fetchPage ? fetchPage(target) : defaultFetchPage(target, origin, PAGE_BYTES)); }
      catch (error) { nativeError = error; }
      if (nativeError && /private or unresolved|private or reserved|off-origin|credentialed URL/i.test(nativeError.message))
        throw nativeError;
      const nativeParsed = result && parseHtml(result.html, result.url ?? target, origin);
      const shortPage = nativeParsed && nativeParsed.text.length < 120;
      const challenged = nativeParsed && blockedInterstitial({ ...nativeParsed, html: result.html });
      if ((nativeError || shortPage || challenged) && fallbackPage && fallbackCalls < 2) {
        fallbackCalls++;
        try { result = await fallbackPage(target); }
        catch (error) {
          if (nativeError) throw new Error(`${nativeError.message}; enhanced fetch: ${error.message}`);
        }
      }
      if (!result) throw nativeError;
      const finalUrl = canonical(result?.url ?? target, undefined, origin);
      if (typeof result?.html !== 'string') throw new Error('HTML response required');
      const bytes = Buffer.byteLength(result.html, 'utf8');
      if (bytes > PAGE_BYTES) throw new Error('page exceeds byte limit');
      totalBytes += bytes;
      const parsed = parseHtml(result.html, finalUrl, origin);
      if (blockedInterstitial({ ...parsed, html: result.html }))
        throw new Error('bot challenge/interstitial page; source text unavailable');
      const page = { url: finalUrl, ...parsed, via: result.via || 'direct' };
      pages.push(page);
      visited.add(finalUrl);
      for (const link of parsed.links) enqueue(link);
      if (onPage) await onPage(page, { nextUrls: [...queue], visited: [...visited] });
    } catch (err) {
      if (err?.name === 'Stopped') throw err;
      errors.push({ url: target, error: String(err?.message ?? err) });
      if (/blocked by robots\.txt|unsupported content type|page exceeds byte limit/i.test(String(err?.message)))
        visited.add(target);
      else retryLater.push(target);
    }
  }
  return { pages, discovered, errors, nextUrls: [...queue, ...retryLater], visited: [...visited], origin };
}
