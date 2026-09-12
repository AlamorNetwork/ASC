/**
 * Works out what to put in .env once ASC is pointed at a gateway.
 *
 *   node scripts/wire-router.js http://127.0.0.1:20128/v1 <api-key>
 *
 * Moving behind 9router renames every model. Talking to Liara directly, the id is
 * `google/gemini-3.6-flash`; through a gateway that added Liara under the prefix
 * `liara`, the same model is `liara/google/gemini-3.6-flash`. Point ROUTER_BASE_URL at
 * the gateway without changing the ids and every role breaks at once, each with a 404
 * that looks like the model was removed.
 *
 * So this asks the gateway what it actually serves, matches that against what each role
 * needs — and against what the probes in this repo measured — and prints the block to
 * paste. It reads only; it never writes .env.
 */
import { config } from '../src/config.js';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const key = process.argv[3] ?? '';

if (!base) {
  console.error('\nusage: node scripts/wire-router.js <base-url> [api-key]\n');
  console.error('  e.g. node scripts/wire-router.js http://127.0.0.1:20128/v1 9r-...\n');
  process.exit(1);
}

console.log(`\nasking ${base} what it serves\n`);

let models = [];
try {
  const res = await fetch(`${base}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.error(`  ${res.status} — ${(await res.text()).slice(0, 200)}\n`);
    process.exit(1);
  }
  models = ((await res.json()).data ?? []).map((m) => ({ id: m.id, owner: m.owned_by ?? '' }));
} catch (err) {
  console.error(`  could not reach it: ${String(err.cause?.code ?? err.message)}\n`);
  console.error('  If this is 9router, check it is running: systemctl status 9router\n');
  process.exit(1);
}

const ids = models.map((m) => m.id);
console.log(`  ${ids.length} models`);

const combos = models.filter((m) => m.owner === 'combo');
if (combos.length) console.log(`  ${combos.length} combo(s): ${combos.map((c) => c.id).join(', ')}`);

/**
 * Find an id however the gateway chose to prefix it. A model added under the prefix
 * `liara` answers to `liara/google/gemini-3.6-flash`, so the tail is what identifies it.
 */
const find = (want) => ids.find((id) => id === want || id.endsWith(`/${want}`)) ?? null;
const findAll = (wants) => wants.map(find).filter(Boolean);

// What the probes in this repo settled on, in the order they settled on. See .env.example.
const ROLES = [
  ['MODEL_CAPTURE', 'voice and scanned pages — must take audio and images',
    ['google/gemini-3.6-flash', 'google/gemini-3.5-flash-lite', 'xiaomi/mimo-v2.5']],
  ['MODEL_RESEARCH', 'web research — cheap models here invent citations',
    ['openai/gpt-5.4-mini:online', 'perplexity/sonar-pro', 'perplexity/sonar']],
  ['MODEL_STRUCTURE', 'planning and assessing — dozens of calls per investigation',
    ['qwen3.8-flash-free', 'glm-5.3-flash-free', 'qwen3.8-27b-free', 'kira-auto',
      'kira-mini-1.0', 'mimo-v2.5-free', 'hy3-free', 'glm-5.3-free',
      'ling-3.0-flash-sante-free', 'mercury-2.5-free', 'google/gemini-3.6-flash']],
  ['MODEL_ROUTER', 'one decision per message, with you waiting',
    ['qwen3.8-flash-free', 'google/gemini-3.6-flash']],
  ['MODEL_EMBED', 'retrieval — no equivalent on a chat-only provider',
    ['intfloat/multilingual-e5-large']],
  ['MODEL_RERANK', 'last precision step; empty disables it',
    ['cohere/rerank-v3.5']],
];

console.log('\n' + '─'.repeat(72));
const lines = [];
const missing = [];

for (const [name, why, wanted] of ROLES) {
  const found = findAll(wanted);
  const absent = wanted.filter((w) => !find(w));

  // A combo covering this role beats listing its members one by one: the gateway walks
  // the chain inside a single request, and ASC sees one id.
  const combo = name === 'MODEL_STRUCTURE' && combos.length
    ? combos.find((c) => /free|kira/i.test(c.id))?.id ?? null
    : null;

  const chain = combo ? [combo, ...found.filter((f) => !f.includes('free'))] : found;

  console.log(`\n${name}  ${combo ? '(using your combo)' : ''}`);
  console.log(`  ${why}`);
  if (!chain.length) {
    console.log('  ✖ none of the measured models are here');
    missing.push(name);
  } else {
    lines.push(`${name}=${chain.join(',')}`);
    for (const c of chain) console.log(`     ${c}`);
  }
  if (absent.length) console.log(`  not on this gateway: ${absent.join(', ')}`);
}

console.log('\n' + '─'.repeat(72));
console.log('\npaste into .env:\n');
console.log(`ROUTER_BASE_URL=${base}`);
if (key) console.log('ROUTER_KEY=<the key you passed to this script>');
console.log(lines.join('\n'));

if (missing.length) {
  console.log(`\n⚠ ${missing.join(', ')} found nothing. Add that provider to the gateway,`);
  console.log('  or leave those roles pointed at a direct provider with @name.');
}

// Routing every role through one local process turns several partial outages into one
// total one, and this project has already lost a server to exactly that shape of luck.
console.log('\nKeep a way out that does not go through the gateway. Declare the provider');
console.log('directly as well, and end each chain on it:\n');
console.log('  LIARA_BASE_URL=https://ai.liara.ir/api/<workspace>/v1');
console.log('  LIARA_KEYS=<key>');
console.log(`  MODEL_STRUCTURE=${lines.find((l) => l.startsWith('MODEL_STRUCTURE'))?.split('=')[1] ?? '…'},google/gemini-3.6-flash@liara`);
console.log('\nThen check nothing broke:  node scripts/check.js\n');

void config;
