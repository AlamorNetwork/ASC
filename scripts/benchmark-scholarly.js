/** Same queries, same top-K, same source fetcher; no model calls. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { CASES, benchmarkCase, renderBenchmark } from '../src/scholarly-benchmark.js';

const args = process.argv.slice(2);
const option = (prefix) => args.find((item) => item.startsWith(prefix))?.slice(prefix.length);
const limit = Number(option('--limit=') || 5);
const fetchCount = Number(option('--fetch=') || 2);
const selected = option('--case=')?.split(',') || CASES.map((item) => item.id);
if (!Number.isInteger(limit) || limit < 1 || limit > 10 ||
    !Number.isInteger(fetchCount) || fetchCount < 0 || fetchCount > limit ||
    selected.some((id) => !CASES.some((item) => item.id === id))) {
  console.error('Usage: node scripts/benchmark-scholarly.js [--run] [--case=dura,ostia,origins] [--limit=5] [--fetch=2]');
  process.exit(2);
}
const cases = CASES.filter((item) => selected.includes(item.id));
if (!args.includes('--run')) {
  console.log('Dry run; no requests sent. Cases:');
  for (const item of cases) console.log(`  ${item.id}: ${item.query}`);
  console.log(`Each provider: top ${limit}; attempt to read ${fetchCount} open copies. Add --run to start.`);
} else {
  const results = [];
  for (const testCase of cases) {
    console.log(`Checking ${testCase.id}: ${testCase.query}`);
    const result = await benchmarkCase(testCase, { limit, fetchCount });
    results.push(result);
    for (const [provider, data] of Object.entries(result.providers))
      console.log(`  ${provider}: ${data.error || `${data.leads.length} leads, ${data.leads.filter((x) => x.readable).length} readable`}`);
  }
  const dir = path.join(path.dirname(config.dbPath), 'benchmarks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const markdown = path.join(dir, `scholarly-${stamp}.md`);
  const json = path.join(dir, `scholarly-${stamp}.json`);
  fs.writeFileSync(markdown, renderBenchmark(results, { limit, fetchCount }), { mode: 0o600 });
  fs.writeFileSync(json, JSON.stringify({ ranAt: new Date().toISOString(), limit, fetchCount,
    cases: results }, null, 2), { mode: 0o600 });
  console.log(`Report: ${markdown}\nRaw results: ${json}\nNo model was called.`);
}
