/**
 * Measures how reliable the route to the provider actually is.
 *
 *   node scripts/probe-network.js          20 embedding calls
 *   node scripts/probe-network.js 50
 *
 * UND_ERR_CONNECT_TIMEOUT means the socket never opened, which is a route problem
 * rather than a slow model. Knowing the failure rate decides whether it is worth
 * working around or just retrying through.
 */
import { config } from '../src/config.js';

const n = Number(process.argv[2]) || 20;
const model = config.models.embed;
const { key, base } = config.router;

console.log(`\n${n} calls to ${base}/embeddings  ·  ${model}\n`);

const times = [];
const errors = new Map();

for (let i = 1; i <= n; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: [`نمونه‌ی شماره ${i} برای سنجش اتصال`] }),
      signal: AbortSignal.timeout(30000),
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      times.push(ms);
      process.stdout.write(`  ${String(i).padStart(3)} ok    ${ms}ms\n`);
    } else {
      const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 80);
      errors.set(`HTTP ${res.status}`, (errors.get(`HTTP ${res.status}`) ?? 0) + 1);
      process.stdout.write(`  ${String(i).padStart(3)} FAIL  ${res.status}  ${body}\n`);
    }
  } catch (err) {
    const code = err.cause?.code ?? err.name;
    errors.set(code, (errors.get(code) ?? 0) + 1);
    process.stdout.write(`  ${String(i).padStart(3)} FAIL  ${code}  ${Date.now() - t0}ms\n`);
  }
}

const failed = n - times.length;
times.sort((a, b) => a - b);
const pct = (p) => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : 0;

console.log('');
console.log(`  succeeded  ${times.length}/${n}  (${Math.round(times.length / n * 100)}%)`);
if (times.length) {
  console.log(`  median     ${pct(0.5)}ms`);
  console.log(`  p90        ${pct(0.9)}ms`);
  console.log(`  slowest    ${times.at(-1)}ms`);
}
for (const [code, count] of errors) console.log(`  ${code.padEnd(24)} ${count}`);

console.log(failed === 0
  ? '\nThe route is fine. A timeout in normal use was a one-off.\n'
  : failed / n > 0.2
    ? '\nMore than one call in five is failing. Retries alone will not hide this —\n' +
      'the route to the provider is the problem, not the code.\n'
    : '\nOccasional failures. The built-in retries should cover these.\n');
