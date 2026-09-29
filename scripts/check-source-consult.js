/** No-network check: one optional OpenRouter source consultation, candidate-only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-consult-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const { config } = await import('../src/config.js');
const store = await import('../src/db.js');
const { consultSources } = await import('../src/source-consult.js');
try {
  config.providers.set('openrouter', { name: 'openrouter', base: 'https://openrouter.ai/api/v1', keys: ['test'] });
  let count = 0;
  const request = async (_url, init) => {
    count++;
    const body = JSON.parse(init.body);
    if (body.tools?.[0]?.type !== 'openrouter:web_search' || body.tools[0].parameters.engine !== 'perplexity')
      throw new Error('Perplexity search tool not requested');
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      sources: [{ url: 'https://example.org/article', title: 'Paper', why: 'Primary' },
        { url: 'http://127.0.0.1/private', title: 'Unsafe' }] }) } }] }) };
  };
  const out = await consultSources('test', { modelSpec: 'test-model@openrouter', request });
  if (count !== 1 || out.sources.length !== 1 || out.sources.some((s) => s.status !== 'candidate_unverified'))
    throw new Error('unexpected source consultant output');
  let refused = false;
  try { await consultSources('test', { modelSpec: 'test-model@default', request }); }
  catch { refused = true; }
  if (!refused || count !== 1) throw new Error('non-OpenRouter endpoint was called');
  console.log('source consultant check passed — explicit provider, one call, candidate-only; 0 paid calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
