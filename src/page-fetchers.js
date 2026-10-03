/** Optional, bounded browser/API fallback. The native crawler remains the default. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

const MAX_HTML = 1024 * 1024;
const SCRAPLING_SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'scrapling-page.py');
let browserQueue = Promise.resolve();

function publicTarget(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      net.isIP(host) || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('unsafe page URL');
  return url;
}

function checkedPage(value, requested) {
  const source = new URL(value?.url || requested);
  if (source.origin !== new URL(requested).origin || !['http:', 'https:'].includes(source.protocol))
    throw new Error('page left the requested site');
  if (typeof value?.html !== 'string' || !value.html.trim()) throw new Error('empty HTML');
  if (Buffer.byteLength(value.html, 'utf8') > MAX_HTML) throw new Error('page exceeds byte limit');
  return { url: source.href, html: value.html };
}

export async function firecrawlPage(url, key, request = fetch) {
  publicTarget(url);
  if (!key) throw new Error('FIRECRAWL_API_KEY is missing');
  const response = await request('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['html'], onlyMainContent: false }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  const body = await response.json();
  if (body.success === false) throw new Error('Firecrawl did not scrape this page');
  const data = body.data ?? body;
  return { ...checkedPage({ url: data.metadata?.sourceURL || data.metadata?.url || url,
    html: data.html }, url), via: 'firecrawl' };
}

export async function scraplingPage(url, python, allowedHosts, run = spawn) {
  publicTarget(url);
  if (!python) throw new Error('SCRAPLING_PYTHON is missing');
  const execute = () => new Promise((resolve, reject) => {
    const child = run(python, [SCRAPLING_SCRIPT, url, allowedHosts.join(',')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (part) => {
      stdout += part.toString();
      if (Buffer.byteLength(stdout) > MAX_HTML * 2) child.kill();
    });
    child.stderr.on('data', (part) => { stderr = (stderr + part.toString()).slice(-1000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Scrapling failed: ${stderr.slice(-250) || `exit ${code}`}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('Scrapling did not return JSON')); }
    });
  });
  const pending = browserQueue.then(execute, execute);
  browserQueue = pending.catch(() => {});
  const output = await pending;
  return { ...checkedPage(output, url), via: 'scrapling' };
}

export async function enhancedPage(url, config, adapters = { scraplingPage, firecrawlPage }) {
  const errors = [];
  for (const name of config.fallback) {
    try {
      if (name === 'scrapling')
        return await adapters.scraplingPage(url, config.scraplingPython, config.scraplingAllowedHosts);
      if (name === 'firecrawl') return await adapters.firecrawlPage(url, config.firecrawlKey);
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  throw new Error(errors.join('; ') || 'no enhanced fetcher configured');
}
