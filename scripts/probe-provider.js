/**
 * What a provider actually gives you, per key.
 *
 *   node scripts/probe-provider.js kira
 *   node scripts/probe-provider.js kira qwen3.8-flash-free glm-5.3-free
 *
 * A model list says what exists; it does not say what your key is allowed to call, how
 * fast it is rate limited, or whether a "free" model answers at all. This asks each key
 * for a real completion and reports what came back, so a chain in .env is built from
 * what works rather than from a web page.
 */
import { config } from '../src/config.js';
import { keysAvailable, providerStatus } from '../src/providers.js';

const name = (process.argv[2] ?? 'kira').toLowerCase();
const provider = config.providers.get(name);

if (!provider) {
  console.error(`\nNo provider called "${name}".\n`);
  console.error('Declared providers: ' + [...config.providers.keys()].join(', '));
  console.error(`\nDeclare one in .env:\n  ${name.toUpperCase()}_BASE_URL=https://…/v1` +
    `\n  ${name.toUpperCase()}_KEYS=key-one,key-two\n`);
  process.exit(1);
}

console.log(`\n${provider.name} · ${provider.base} · ${provider.keys.length} key(s)\n`);

// The provider's own list, when it publishes one. Free models are the point here.
let listed = [];
try {
  const res = await fetch(`${provider.base}/models`, {
    headers: { Authorization: `Bearer ${provider.keys[0]}` },
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  listed = j.data ?? [];
  const free = listed.filter((m) => m.is_free);
  console.log(`${listed.length} models listed, ${free.length} marked free`);
  if (free.length) console.log('  ' + free.map((m) => m.id).join('\n  '));

  // What this project needs and a chat-only provider will not have.
  const kinds = new Set(listed.map((m) => m.type).filter(Boolean));
  const missing = ['embedding', 'rerank'].filter((k) => ![...kinds].some((t) => t.includes(k)));
  if (missing.length) {
    console.log(`\n⚠ no ${missing.join(' or ')} here — those roles must stay on another provider.`);
  }
} catch (err) {
  console.log(`could not list models: ${String(err.message).slice(0, 80)}`);
}

const models = process.argv.slice(3).length
  ? process.argv.slice(3)
  : listed.filter((m) => m.is_free).map((m) => m.id).slice(0, 6);

if (!models.length) {
  console.log('\nNothing to test. Name some models as arguments.\n');
  process.exit(0);
}

console.log(`\ntesting ${models.length} model(s) against ${provider.keys.length} key(s)\n`);

const rows = [];
for (const model of models) {
  for (const [i, key] of provider.keys.entries()) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'به فارسی در یک جمله بگو میترائیسم چه بود.' }],
          max_tokens: 400,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const raw = await res.text();
      const ms = Date.now() - t0;

      if (!res.ok) {
        const why = res.status === 429 ? 'rate limited'
          : res.status === 402 ? 'out of credit'
            : (res.status === 401 || res.status === 403) ? 'key rejected'
              : res.status >= 500 ? 'their gateway is down for this model'
                : res.status === 404 ? 'no such model here' : 'error';
        console.log(`  ✖ ${model.padEnd(28)} key ${i + 1}  ${res.status} ${why}`);
        rows.push({ model, key: i + 1, ok: false, status: res.status, why });
        continue;
      }

      const j = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
      const text = j.choices?.[0]?.message?.content ?? '';
      const think = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      // An empty reply is the failure mode that looks like success — a reasoning model
      // spending the whole budget thinking. Worth seeing before it is put in a chain.
      console.log(`  ${text.trim() ? '✅' : '⚠ '} ${model.padEnd(28)} key ${i + 1}  ${ms}ms` +
        `  ${j.usage?.completion_tokens ?? 0} out` + (think ? ` (${think} thinking)` : '') +
        (text.trim() ? '' : '  ← answered nothing'));
      if (text.trim() && i === 0) console.log(`      ${text.trim().slice(0, 110)}`);
      rows.push({ model, key: i + 1, ok: !!text.trim(), ms, think });
    } catch (err) {
      console.log(`  ✖ ${model.padEnd(28)} key ${i + 1}  ${err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code ?? err.message).slice(0, 40)}`);
      rows.push({ model, key: i + 1, ok: false, why: 'unreachable' });
    }
  }
}

const working = [...new Set(rows.filter((r) => r.ok).map((r) => r.model))];
console.log('');
if (working.length) {
  console.log('These answered. A chain, best first, falling back to what you already pay for:');
  console.log(`  MODEL_STRUCTURE=${working.map((m) => `${m}@${provider.name}`).join(',')},${config.models.structure}`);
  console.log('\nThe last link matters: a free tier will run out mid-investigation, and');
  console.log('without something behind it the run stops there.');
} else {
  console.log('Nothing answered. Check the keys, or the model ids.');
}

// Whose fault the failures are. Getting this wrong sends you to re-register accounts
// when the provider is simply having a bad afternoon.
const failed = rows.filter((r) => !r.ok && r.status);
const rejected = failed.filter((r) => r.status === 401 || r.status === 403);
const upstream = failed.filter((r) => r.status >= 500);

if (rejected.length && rejected.length === rows.length) {
  console.log('\n✖ Every model rejected this key, which is what an invalid key looks like.');
  console.log('  Check it is copied whole, and that the account is activated.');
} else if (rejected.length) {
  console.log(`\nⓘ ${rejected.length} model(s) returned 401 while others did not, so the key itself`);
  console.log('  is fine — those models are not open to this account. Leave them out of the chain.');
}

if (upstream.length) {
  console.log(`\nⓘ ${upstream.length} model(s) returned 5xx. That is their gateway, not your key —`);
  console.log('  the client moves to the next model in the chain and leaves the key alone.');
  console.log('  Worth re-running later; a free model can be down for hours.');
}

if (failed.some((r) => r.status === 429)) {
  console.log('\nSome keys were already rate limited — that is what more keys are for,');
  console.log('and the client rests a limited key for a minute before reusing it.');
}

console.log('\n' + JSON.stringify(providerStatus(config.providers)
  .find((s) => s.name === provider.name)) + '\n');
void keysAvailable;
